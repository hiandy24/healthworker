import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, gt, isNull, like, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { exercises } from './db/schema';
import type { Bindings } from './auth';
import { errorSchema } from '../shared/contracts';
import {
  exerciseInputSchema,
  exercisePatchSchema,
  exerciseQuerySchema,
  exerciseResponseSchema,
  exerciseListSchema,
} from '../shared/exercises';

type Env = {
  Bindings: Bindings;
  Variables: { requestId: string; authentication: 'access' | 'local_mock' };
};
const json = (
  schema:
    | typeof errorSchema
    | typeof exerciseResponseSchema
    | typeof exerciseListSchema,
  description: string,
) => ({ description, content: { 'application/json': { schema } } });
const errors = {
  400: json(errorSchema, 'Invalid request'),
  404: json(errorSchema, 'Not found'),
  412: json(errorSchema, 'Version conflict'),
  428: json(errorSchema, 'Version required'),
  422: json(errorSchema, 'Invalid fields'),
};
export function exerciseRoutes(agent: boolean) {
  const api = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success)
        return c.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: '动作字段或查询参数无效',
            },
            requestId: c.get('requestId'),
          },
          result.target === 'json' ? 422 : 400,
        );
    },
  });
  api.openapi(
    createRoute({
      method: 'get',
      path: '/exercises',
      request: { query: exerciseQuerySchema },
      responses: {
        200: json(exerciseListSchema, 'Stable BINARY name/id pagination'),
        400: errors[400],
      },
    }),
    async (c) => {
      const q = c.req.valid('query');
      const filter = JSON.stringify([
        q.query,
        q.kind ?? null,
        q.includeArchived,
      ]);
      let cursor: { name: string; id: string; filter: string } | undefined;
      if (q.cursor) {
        try {
          cursor = z
            .strictObject({
              name: z.string().max(200),
              id: z.string().uuid(),
              filter: z.string(),
            })
            .parse(JSON.parse(decodeURIComponent(q.cursor)));
          if (cursor.filter !== filter) throw new Error();
        } catch {
          return c.json(
            {
              error: {
                code: 'INVALID_CURSOR',
                message: '游标无效或筛选已改变',
              },
              requestId: c.get('requestId'),
            },
            400,
          );
        }
      }
      const rows = await drizzle(c.env.DB)
        .select()
        .from(exercises)
        .where(
          and(
            q.includeArchived === 'false'
              ? isNull(exercises.archivedAt)
              : undefined,
            q.kind ? eq(exercises.kind, q.kind) : undefined,
            q.query
              ? or(
                  like(exercises.name, `%${q.query}%`),
                  like(exercises.aliases, `%${q.query}%`),
                )
              : undefined,
            cursor
              ? or(
                  gt(exercises.name, cursor.name),
                  and(
                    eq(exercises.name, cursor.name),
                    gt(exercises.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(asc(exercises.name), asc(exercises.id))
        .limit(q.limit + 1);
      const data = rows.slice(0, q.limit);
      const last = data.at(-1);
      return c.json(
        {
          data,
          meta: {
            requestId: c.get('requestId'),
            nextCursor:
              rows.length > q.limit && last
                ? encodeURIComponent(
                    JSON.stringify({ name: last.name, id: last.id, filter }),
                  )
                : null,
          },
        },
        200,
      );
    },
  );
  if (agent) return api;
  api.openapi(
    createRoute({
      method: 'post',
      path: '/exercises',
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: exerciseInputSchema } },
        },
      },
      responses: { 201: json(exerciseResponseSchema, 'Created'), ...errors },
    }),
    async (c) => {
      const now = new Date().toISOString();
      const [data] = await drizzle(c.env.DB)
        .insert(exercises)
        .values({
          ...c.req.valid('json'),
          id: crypto.randomUUID(),
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return c.json(
        { data: data!, meta: { requestId: c.get('requestId') } },
        201,
      );
    },
  );
  api.openapi(
    createRoute({
      method: 'patch',
      path: '/exercises/{id}',
      request: {
        params: z.object({ id: z.string().uuid() }),
        headers: z.object({ 'if-match': z.string().optional() }),
        body: {
          required: true,
          content: { 'application/json': { schema: exercisePatchSchema } },
        },
      },
      responses: {
        200: json(
          exerciseResponseSchema,
          'Display fields and archive only; semantic changes require a new exercise',
        ),
        ...errors,
      },
    }),
    async (c) => {
      const match = c.req.header('If-Match');
      const fail = (
        status: 400 | 404 | 412 | 428,
        code: string,
        message: string,
      ) =>
        c.json(
          { error: { code, message }, requestId: c.get('requestId') },
          status,
        );
      if (!match) return fail(428, 'VERSION_REQUIRED', '请提供 If-Match 版本');
      if (
        !/^"[1-9]\d*"$/.test(match) ||
        !Number.isSafeInteger(Number(match.slice(1, -1)))
      )
        return fail(400, 'INVALID_VERSION', '版本格式无效');
      const version = Number(match.slice(1, -1));
      const id = c.req.valid('param').id;
      const { archived, ...patch } = c.req.valid('json');
      const now = new Date().toISOString();
      const db = drizzle(c.env.DB);
      const [data] = await db
        .update(exercises)
        .set({
          ...patch,
          ...(archived === undefined
            ? {}
            : { archivedAt: archived ? now : null }),
          updatedAt: now,
          version: version + 1,
        })
        .where(and(eq(exercises.id, id), eq(exercises.version, version)))
        .returning();
      if (!data) {
        const found = await db
          .select({ id: exercises.id })
          .from(exercises)
          .where(eq(exercises.id, id));
        return found.length
          ? fail(412, 'VERSION_CONFLICT', '动作已被修改，请刷新后重试')
          : fail(404, 'NOT_FOUND', '动作不存在');
      }
      return c.json({ data, meta: { requestId: c.get('requestId') } }, 200);
    },
  );
  return api;
}
