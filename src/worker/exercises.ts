import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, gt, isNull, like, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { exercises } from './db/schema';
import type { Bindings } from './auth';
import { errorSchema } from '../shared/contracts';
import {
  agentExerciseCreateSchema,
  exerciseInputSchema,
  exercisePatchSchema,
  exerciseQuerySchema,
  exerciseResponseSchema,
  exerciseListSchema,
} from '../shared/exercises';

type Env = {
  Bindings: Bindings;
  Variables: {
    requestId: string;
    authentication: 'access' | 'local_mock';
    principal: string;
    canImport: boolean;
  };
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
  if (agent) {
    api.openapi(
      createRoute({
        method: 'post',
        path: '/exercises',
        description:
          'Agent: only verified services explicitly granted exercises:create; all other services are read-only (405). Creates only (non-builtin, unarchived), never updates/archives/deletes. Optional client-chosen stable id supports batch forward references. Requires application/json and Idempotency-Key, scoped to authenticated principal; replay retained for 24 hours.',
        security: [{ AccessJWT: [] }],
        request: {
          headers: z.object({
            'idempotency-key': z
              .string()
              .min(1)
              .max(200)
              .regex(/^[\x21-\x7e]+$/),
          }),
          body: {
            required: true,
            content: {
              'application/json': { schema: agentExerciseCreateSchema },
            },
          },
        },
        responses: {
          201: json(
            exerciseResponseSchema,
            'Atomic creation or original data within 24h replay; meta.replayed marks replay and meta.requestId matches the current X-Request-Id',
          ),
          409: json(
            errorSchema,
            'Idempotency key reused with a different body, duplicate exercise name, or occupied client-chosen id',
          ),
          ...errors,
        },
      }),
      async (c) => {
        const parsed = c.req.valid('json');
        const { id: requestedId, ...input } = parsed;
        const key = c.req.header('Idempotency-Key');
        const principal = c.get('principal');
        const canonical = JSON.stringify(parsed, Object.keys(parsed).sort());
        const hashBytes = new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(canonical),
          ),
        );
        const hash = Array.from(hashBytes, (v) =>
          v.toString(16).padStart(2, '0'),
        ).join('');
        const conflict = (code: string, message: string) =>
          c.json(
            { error: { code, message }, requestId: c.get('requestId') },
            409,
          );
        const lookup = () =>
          c.env.DB.prepare(
            "SELECT request_hash,response_body FROM idempotency_keys WHERE principal=? AND scope='exercises:create' AND key=? AND expires_at>?",
          )
            .bind(principal, key, new Date().toISOString())
            .first<{ request_hash: string; response_body: string }>();
        const replayed = (row: {
          request_hash: string;
          response_body: string;
        }) => {
          if (row.request_hash !== hash)
            return conflict('IDEMPOTENCY_CONFLICT', '幂等 key 已用于不同请求');
          const saved = JSON.parse(row.response_body);
          return c.json(
            {
              ...saved,
              meta: {
                ...saved.meta,
                requestId: c.get('requestId'),
                replayed: true,
              },
            },
            201,
          );
        };
        const existing = await lookup();
        if (existing) return replayed(existing);
        const id = requestedId ?? crypto.randomUUID();
        const now = new Date().toISOString();
        const data = {
          ...input,
          id,
          isBuiltin: false,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
          version: 1,
        };
        const response = {
          data,
          meta: { requestId: c.get('requestId'), replayed: false },
        };
        let inserted: boolean;
        try {
          // Both inserts are conditional inside one atomic batch: a duplicate
          // name skips the first statement (changes()=0 blocks the replay row)
          // and a duplicate id aborts on the primary key, rolling back the
          // whole batch — a lost race can neither duplicate a name/id nor
          // leave a replay record for a resource it did not create.
          const results = await c.env.DB.batch([
            c.env.DB.prepare(
              'INSERT INTO exercises (id,name,aliases,kind,equipment,muscle_groups,measurement_mode,resistance_mode,load_convention,rep_convention,volume_multiplier,cardio_category,is_builtin,archived_at,created_at,updated_at,version) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM exercises WHERE name=?)',
            ).bind(
              id,
              data.name,
              JSON.stringify(data.aliases),
              data.kind,
              data.equipment,
              JSON.stringify(data.muscleGroups),
              data.measurementMode,
              data.resistanceMode,
              data.loadConvention,
              data.repConvention,
              data.volumeMultiplier,
              data.cardioCategory,
              0,
              null,
              now,
              now,
              1,
              data.name,
            ),
            c.env.DB.prepare(
              'INSERT INTO idempotency_keys (id,principal,scope,key,request_hash,resource_id,response_body,response_status,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE changes()=1',
            ).bind(
              crypto.randomUUID(),
              principal,
              'exercises:create',
              key,
              hash,
              id,
              JSON.stringify(response),
              201,
              now,
              new Date(Date.parse(now) + 86400000).toISOString(),
            ),
          ]);
          inserted = (results[0]?.meta.changes ?? 0) > 0;
        } catch {
          inserted = false;
        }
        if (inserted) return c.json(response, 201);
        const saved = await lookup();
        if (saved) return replayed(saved);
        const nameTaken = await c.env.DB.prepare(
          'SELECT id FROM exercises WHERE name=? LIMIT 1',
        )
          .bind(input.name)
          .first();
        if (nameTaken)
          return conflict(
            'EXERCISE_EXISTS',
            '同名动作已存在，请先匹配现有动作',
          );
        if (
          requestedId &&
          (await c.env.DB.prepare('SELECT id FROM exercises WHERE id=?')
            .bind(requestedId)
            .first())
        )
          return conflict('EXERCISE_ID_EXISTS', '指定动作 ID 已被占用');
        throw new Error('exercise create failed');
      },
    );
    return api;
  }
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
