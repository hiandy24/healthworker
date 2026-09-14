import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and, sql } from 'drizzle-orm';
import type { Bindings } from './auth';
import { settings } from './db/schema';
import { errorSchema } from '../shared/contracts';
import {
  settingsSchema,
  settingsPatchSchema,
  settingsResponseSchema,
} from '../shared/settings';
export async function readSettings(binding: D1Database) {
  const rows = await drizzle(binding)
    .select()
    .from(settings)
    .where(eq(settings.id, 'singleton'));
  return settingsSchema.parse(
    rows[0] ?? {
      id: 'singleton',
      timezone: 'UTC',
      theme: 'auto',
      locale: 'zh-CN',
      unitSystem: 'metric',
      version: 1,
      createdAt: '1970-01-01T00:00:00.000Z',
      updatedAt: '1970-01-01T00:00:00.000Z',
    },
  );
}
export function settingsRoutes() {
  const api = new OpenAPIHono<{
    Bindings: Bindings;
    Variables: { requestId: string };
  }>({
    defaultHook: (r, c) => {
      if (!r.success)
        return c.json(
          {
            error: { code: 'VALIDATION_ERROR', message: '设置字段无效' },
            requestId: c.get('requestId'),
          },
          422,
        );
    },
  });
  const json = (schema: z.ZodType, description: string) => ({
    description,
    content: { 'application/json': { schema } },
  });
  api.openapi(
    createRoute({
      method: 'get',
      path: '/settings',
      security: [{ AccessJWT: [] }],
      responses: {
        200: json(
          settingsResponseSchema,
          'Read-only singleton preferences; absent row returns virtual UTC/auto/zh-CN/metric version 1 with epoch audit times; confirm browser timezone on first use',
        ),
      },
    }),
    async (c) => {
      const data = await readSettings(c.env.DB);
      c.header('ETag', `"${data.version}"`);
      return c.json({ data, meta: { requestId: c.get('requestId') } }, 200);
    },
  );
  api.openapi(
    createRoute({
      method: 'patch',
      path: '/settings',
      security: [{ AccessJWT: [] }],
      request: {
        headers: z.object({ 'if-match': z.string().optional() }),
        body: {
          required: true,
          content: { 'application/json': { schema: settingsPatchSchema } },
        },
      },
      responses: {
        200: json(
          settingsResponseSchema,
          'CAS preference update; never rewrites historical workout timezone/localDate',
        ),
        400: json(errorSchema, 'Invalid version/JSON'),
        412: json(errorSchema, 'Version conflict'),
        422: json(errorSchema, 'Invalid settings'),
        428: json(errorSchema, 'Version required'),
      },
    }),
    async (c) => {
      const match = c.req.header('If-Match');
      const fail = (status: 400 | 412 | 428, code: string, message: string) =>
        c.json(
          { error: { code, message }, requestId: c.get('requestId') },
          status,
        );
      if (!match) return fail(428, 'VERSION_REQUIRED', '请提供 If-Match 版本');
      const version = Number(match.slice(1, -1));
      if (
        !/^"[1-9]\d*"$/.test(match) ||
        !Number.isSafeInteger(version) ||
        version >= Number.MAX_SAFE_INTEGER
      )
        return fail(400, 'INVALID_VERSION', '版本格式无效');
      const db = drizzle(c.env.DB);
      const now = new Date().toISOString();
      const [, changed] = await db.batch([
        db
          .insert(settings)
          .select(
            db
              .select({
                id: sql`'singleton'`.as('id'),
                timezone: sql`'UTC'`.as('timezone'),
                locale: sql`'zh-CN'`.as('locale'),
                unitSystem: sql`'metric'`.as('unit_system'),
                theme: sql`'auto'`.as('theme'),
                createdAt: sql`${now}`.as('created_at'),
                updatedAt: sql`${now}`.as('updated_at'),
                version: sql`1`.as('version'),
              })
              .from(sql`(SELECT 1)`)
              .where(sql`${version}=1`),
          )
          .onConflictDoNothing(),
        db
          .update(settings)
          .set({ ...c.req.valid('json'), version: version + 1, updatedAt: now })
          .where(
            and(eq(settings.id, 'singleton'), eq(settings.version, version)),
          )
          .returning(),
      ]);
      const row = changed[0];
      if (!row) return fail(412, 'VERSION_CONFLICT', '设置已修改，请刷新');
      const data = settingsSchema.parse(row);
      c.header('ETag', `"${data.version}"`);
      return c.json({ data, meta: { requestId: c.get('requestId') } }, 200);
    },
  );
  return api;
}
