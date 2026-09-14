import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { drizzle } from 'drizzle-orm/d1';
import { eq, sql } from 'drizzle-orm';
import dayjs from 'dayjs';
import type { Bindings } from './auth';
import {
  workouts,
  workoutEntries,
  strengthSets,
  cardioRecords,
  exercises,
} from './db/schema';
import {
  errorSchema,
  measurementSchema,
  localDateSchema,
} from '../shared/contracts';
import { workoutLocalDate } from '../shared/dates';
import { gramsToKg, kgToGrams } from '../shared/units';
import {
  workoutInputSchema,
  workoutSummarySchema,
  workoutSchema,
  workoutResponseSchema,
  workoutListSchema,
  workoutQuerySchema,
  workoutDeleteSchema,
  validateStrengthMeasurement,
  type Workout,
  type WorkoutInput,
  type WorkoutResponse,
} from '../shared/workouts';

type Env = {
  Bindings: Bindings;
  Variables: {
    requestId: string;
    authentication: 'access' | 'local_mock';
    principal: string;
  };
};
export class WorkoutError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 412 | 422 | 428,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const fail = (
  status: WorkoutError['status'],
  code: string,
  message: string,
): never => {
  throw new WorkoutError(status, code, message);
};
export async function getWorkout(
  binding: D1Database,
  id: string,
): Promise<Workout | null> {
  const db = drizzle(binding);
  const [parents, entries, sets, cardio] = await db.batch([
    db.select().from(workouts).where(eq(workouts.id, id)),
    db
      .select()
      .from(workoutEntries)
      .where(eq(workoutEntries.workoutId, id))
      .orderBy(workoutEntries.position),
    db
      .select({ set: strengthSets })
      .from(strengthSets)
      .innerJoin(workoutEntries, eq(strengthSets.entryId, workoutEntries.id))
      .where(eq(workoutEntries.workoutId, id))
      .orderBy(strengthSets.position),
    db
      .select({ cardio: cardioRecords })
      .from(cardioRecords)
      .innerJoin(workoutEntries, eq(cardioRecords.entryId, workoutEntries.id))
      .where(eq(workoutEntries.workoutId, id)),
  ]);
  const parent = parents[0];
  if (!parent) return null;
  return workoutSchema.parse({
    ...parent,
    entryCount: entries.length,
    kinds: [...new Set(entries.map((e) => e.kind))],
    entries: entries.map((entry) => ({
      ...entry,
      ...(entry.kind === 'strength'
        ? {
            sets: sets
              .filter((s) => s.set.entryId === entry.id)
              .map(({ set }) => {
                const {
                  entryId: _entry,
                  loadGrams,
                  assistanceGrams,
                  ...rest
                } = set;
                void _entry;
                return {
                  ...rest,
                  loadKg: gramsToKg(loadGrams),
                  assistanceKg: gramsToKg(assistanceGrams),
                };
              }),
          }
        : {
            cardio: (() => {
              const row = cardio.find(
                (r) => r.cardio.entryId === entry.id,
              )?.cardio;
              if (!row) return undefined;
              const { id: _id, entryId: _entry, ...rest } = row;
              void _id;
              void _entry;
              return rest;
            })(),
          }),
    })),
  });
}
function redact(data: Workout): Workout {
  return {
    ...data,
    notes: null,
    entries: data.entries.map((e) => ({
      ...e,
      notes: null,
      ...(e.kind === 'strength'
        ? { sets: e.sets.map((s) => ({ ...s, notes: null })) }
        : {}),
    })),
  };
}
// Only internal, fixed table/column identifiers are passed here. Values are bound.
export function inserts(
  db: D1Database,
  table: string,
  rows: Record<string, unknown>[],
): D1PreparedStatement[] {
  if (!rows.length) return [];
  const keys = Object.keys(rows[0]!);
  if (keys.length === 0 || keys.length > 100)
    throw new Error('Unsupported D1 insert column count');
  const size = Math.floor(100 / keys.length);
  const result: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    result.push(
      db
        .prepare(
          `INSERT INTO ${table} (${keys.join(',')}) VALUES ${chunk.map(() => `(${keys.map(() => '?').join(',')})`).join(',')}`,
        )
        .bind(...chunk.flatMap((row) => keys.map((k) => row[k]))),
    );
  }
  return result;
}
const snake = (value: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
      typeof v === 'boolean' ? Number(v) : v,
    ]),
  );
function guard(
  db: D1Database,
  type: 'cas' | 'exercise',
  condition: string,
  args: unknown[],
  guardIds: string[],
) {
  const id = crypto.randomUUID();
  guardIds.push(id);
  return db
    .prepare(
      `INSERT INTO workout_write_guards(id,check_type,valid) SELECT ?,?,(${condition})`,
    )
    .bind(id, type, ...args);
}
function versionHeader(match: string | undefined): number {
  if (!match) return fail(428, 'VERSION_REQUIRED', '请提供 If-Match 版本');
  const value = Number(match.slice(1, -1));
  if (
    !/^"[1-9]\d*"$/.test(match) ||
    !Number.isSafeInteger(value) ||
    value >= Number.MAX_SAFE_INTEGER
  )
    return fail(400, 'INVALID_VERSION', '版本格式无效');
  return value;
}
async function replay(
  db: D1Database,
  principal: string,
  key: string,
  hash: string,
  now: string,
  requestId: string,
): Promise<WorkoutResponse | null> {
  const row = await db
    .prepare(
      "SELECT request_hash,response_body FROM idempotency_keys WHERE principal=? AND scope='workouts:create' AND key=? AND expires_at>?",
    )
    .bind(principal, key, now)
    .first<{ request_hash: string; response_body: string }>();
  if (!row) return null;
  if (row.request_hash !== hash)
    return fail(409, 'IDEMPOTENCY_CONFLICT', '幂等 key 已用于不同请求');
  const response = workoutResponseSchema.parse(JSON.parse(row.response_body));
  return { ...response, meta: { ...response.meta, requestId, replayed: true } };
}
export async function saveWorkout(
  binding: D1Database,
  input: WorkoutInput,
  options: {
    id?: string;
    version?: number;
    key?: string;
    principal: string;
    requestId: string;
  },
): Promise<WorkoutResponse> {
  // Parsing also canonicalizes object property order and rejects untrusted snapshots.
  input = workoutInputSchema.parse(input);
  const now = new Date().toISOString();
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(input)),
      ),
    ),
  )
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
  if (options.key) {
    const previous = await replay(
      binding,
      options.principal,
      options.key,
      hash,
      now,
      options.requestId,
    );
    if (previous) return previous;
  }
  try {
    const old = options.id ? await getWorkout(binding, options.id) : null;
    if (options.id && !old) return fail(404, 'NOT_FOUND', '训练不存在');
    if (old && old.version !== options.version)
      return fail(412, 'VERSION_CONFLICT', '训练已被修改');
    const id = options.id ?? crypto.randomUUID();
    const db = drizzle(binding);
    const exerciseIds = [...new Set(input.entries.map((e) => e.exerciseId))];
    const definitions = exerciseIds.length
      ? await db
          .select()
          .from(exercises)
          .where(
            sql`${exercises.id} in (${sql.join(
              exerciseIds.map((id) => sql`${id}`),
              sql`,`,
            )})`,
          )
      : [];
    const statements: D1PreparedStatement[] = [];
    const guardIds: string[] = [];
    if (old)
      statements.push(
        guard(
          binding,
          'cas',
          'EXISTS(SELECT 1 FROM workouts WHERE id=? AND version=?)',
          [id, options.version],
          guardIds,
        ),
      );
    const entries = input.entries.map((entry, position) => {
      const historical = old?.entries.find(
        (e) => e.id === entry.id && e.exerciseId === entry.exerciseId,
      );
      const exercise = definitions.find((e) => e.id === entry.exerciseId);
      if (!exercise) return fail(422, 'INVALID_EXERCISE', '动作不存在');
      if (!historical) {
        if (exercise.archivedAt)
          return fail(
            409,
            'EXERCISE_REFERENCE_CONFLICT',
            '归档动作不能新增引用',
          );
        statements.push(
          guard(
            binding,
            'exercise',
            'EXISTS(SELECT 1 FROM exercises WHERE id=? AND version=? AND archived_at IS NULL)',
            [exercise.id, exercise.version],
            guardIds,
          ),
        );
      }
      if (entry.kind !== (historical?.kind ?? exercise.kind))
        return fail(422, 'MEASUREMENT_ERROR', '动作类型不匹配');
      const measurementSnapshot =
        historical?.measurementSnapshot ??
        measurementSchema.parse({
          measurementMode: exercise.measurementMode,
          resistanceMode: exercise.resistanceMode,
          loadConvention: exercise.loadConvention,
          repConvention: exercise.repConvention,
          volumeMultiplier: exercise.volumeMultiplier,
        });
      if (entry.kind === 'strength')
        for (const set of entry.sets) {
          const errors = validateStrengthMeasurement(set, measurementSnapshot);
          if (errors.length)
            return fail(422, 'MEASUREMENT_ERROR', errors.join('；'));
        }
      return {
        ...entry,
        position,
        exerciseNameSnapshot: historical?.exerciseNameSnapshot ?? exercise.name,
        measurementSnapshot,
        ...(entry.kind === 'strength'
          ? { sets: entry.sets.map((s, position) => ({ ...s, position })) }
          : {}),
      };
    });
    const data = workoutSchema.parse({
      ...input,
      id,
      startedAt: new Date(input.startedAt).toISOString(),
      localDate: workoutLocalDate(input.startedAt, input.timezone),
      version: old ? old.version + 1 : 1,
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
      entries,
      entryCount: entries.length,
      kinds: [...new Set(entries.map((e) => e.kind))],
    });
    const {
      entries: outputEntries,
      entryCount: _count,
      kinds: _kinds,
      ...parent
    } = data;
    void _count;
    void _kinds;
    if (old) {
      statements.push(
        binding
          .prepare(
            'UPDATE workouts SET started_at=?,timezone=?,local_date=?,status=?,duration_seconds=?,notes=?,version=version+1,updated_at=? WHERE id=? AND version=?',
          )
          .bind(
            data.startedAt,
            data.timezone,
            data.localDate,
            data.status,
            data.durationSeconds,
            data.notes,
            now,
            id,
            options.version,
          ),
      );
      statements.push(
        binding
          .prepare('DELETE FROM workout_entries WHERE workout_id=?')
          .bind(id),
      );
    } else statements.push(...inserts(binding, 'workouts', [snake(parent)]));
    const entryRows: Record<string, unknown>[] = [],
      setRows: Record<string, unknown>[] = [],
      cardioRows: Record<string, unknown>[] = [];
    for (const entry of outputEntries) {
      entryRows.push({
        id: entry.id,
        workout_id: id,
        exercise_id: entry.exerciseId,
        position: entry.position,
        kind: entry.kind,
        exercise_name_snapshot: entry.exerciseNameSnapshot,
        measurement_snapshot: JSON.stringify(entry.measurementSnapshot),
        notes: entry.notes,
      });
      if (entry.kind === 'strength')
        for (const set of entry.sets) {
          const { loadKg, assistanceKg, ...rest } = set;
          setRows.push({
            ...snake(rest),
            entry_id: entry.id,
            load_grams: kgToGrams(loadKg),
            assistance_grams: kgToGrams(assistanceKg),
          });
        }
      else
        cardioRows.push({
          id: crypto.randomUUID(),
          entry_id: entry.id,
          ...snake(entry.cardio),
        });
    }
    statements.push(
      ...inserts(binding, 'workout_entries', entryRows),
      ...inserts(binding, 'strength_sets', setRows),
      ...inserts(binding, 'cardio_records', cardioRows),
    );
    const response: WorkoutResponse = {
      data,
      meta: { requestId: options.requestId, replayed: false },
    };
    if (options.key) {
      statements.push(
        binding
          .prepare(
            "DELETE FROM idempotency_keys WHERE principal=? AND scope='workouts:create' AND key=? AND expires_at<=?",
          )
          .bind(options.principal, options.key, now),
      );
      statements.push(
        ...inserts(binding, 'idempotency_keys', [
          {
            id: crypto.randomUUID(),
            principal: options.principal,
            scope: 'workouts:create',
            key: options.key,
            request_hash: hash,
            resource_id: id,
            response_body: JSON.stringify(response),
            response_status: 201,
            created_at: now,
            expires_at: new Date(Date.parse(now) + 86400000).toISOString(),
          },
        ]),
      );
    }
    for (const guardId of guardIds)
      statements.push(
        binding
          .prepare('DELETE FROM workout_write_guards WHERE id=?')
          .bind(guardId),
      );
    await binding.batch(statements);
    return response;
  } catch (error) {
    if (options.key) {
      const previous = await replay(
        binding,
        options.principal,
        options.key,
        hash,
        now,
        options.requestId,
      );
      if (previous) return previous;
    }
    const message = String(error);
    if (message.includes('WORKOUT_VERSION_CONFLICT'))
      return fail(412, 'VERSION_CONFLICT', '训练已被修改或删除');
    if (message.includes('EXERCISE_REFERENCE_CONFLICT'))
      return fail(
        409,
        'EXERCISE_REFERENCE_CONFLICT',
        '动作版本或归档状态已改变',
      );
    if (message.includes('UNIQUE constraint failed'))
      return fail(409, 'ID_CONFLICT', '条目或组 ID 已被使用');
    throw error;
  }
}
const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const errors = {
  400: json(errorSchema, 'Invalid syntax/query'),
  404: json(errorSchema, 'Not found'),
  409: json(errorSchema, 'Idempotency, ID or exercise reference conflict'),
  412: json(errorSchema, 'Version conflict'),
  422: json(errorSchema, 'Invalid fields'),
  428: json(errorSchema, 'If-Match required'),
};
export function workoutRoutes(agent: boolean) {
  const api = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success)
        return c.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: '训练字段或查询参数无效',
            },
            requestId: c.get('requestId'),
          },
          result.target === 'json' ? 422 : 400,
        );
    },
  });
  api.onError((error, c) => {
    if (error instanceof WorkoutError)
      return c.json(
        {
          error: { code: error.code, message: error.message },
          requestId: c.get('requestId'),
        },
        error.status,
      );
    if ('status' in error && error.status === 400)
      return c.json(
        {
          error: { code: 'INVALID_JSON', message: 'JSON 格式无效' },
          requestId: c.get('requestId'),
        },
        400,
      );
    return c.json(
      {
        error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用' },
        requestId: c.get('requestId'),
      },
      500,
    );
  });
  api.openapi(
    createRoute({
      method: 'get',
      path: '/workouts',
      security: [{ AccessJWT: [] }],
      request: { query: workoutQuerySchema },
      responses: {
        200: json(
          workoutListSchema,
          'Stable localDate/startedAt/id descending summary page; [from,to), default last 28 UTC dates, max 366 days',
        ),
        ...errors,
      },
    }),
    async (c) => {
      const q = c.req.valid('query');
      const to = q.to ?? dayjs().utc().add(1, 'day').format('YYYY-MM-DD');
      const from =
        q.from ?? dayjs.utc(to).subtract(28, 'day').format('YYYY-MM-DD');
      const days = dayjs.utc(to).diff(dayjs.utc(from), 'day');
      if (
        !localDateSchema.safeParse(from).success ||
        !localDateSchema.safeParse(to).success ||
        days <= 0 ||
        days > 366
      )
        return fail(400, 'INVALID_RANGE', '日期范围须为 1–366 天');
      const filter = JSON.stringify([
        from,
        to,
        q.status ?? null,
        q.kind ?? null,
        q.exerciseId ?? null,
        q.includeNotes,
      ]);
      const args: unknown[] = [from, to];
      const conditions = ['w.local_date>=?', 'w.local_date<?'];
      if (q.status) {
        conditions.push('w.status=?');
        args.push(q.status);
      }
      if (q.kind) {
        conditions.push(
          'EXISTS(SELECT 1 FROM workout_entries e WHERE e.workout_id=w.id AND e.kind=?)',
        );
        args.push(q.kind);
      }
      if (q.exerciseId) {
        conditions.push(
          'EXISTS(SELECT 1 FROM workout_entries e WHERE e.workout_id=w.id AND e.exercise_id=?)',
        );
        args.push(q.exerciseId);
      }
      if (q.cursor) {
        try {
          const cursor = z
            .strictObject({
              localDate: z.iso.date(),
              startedAt: z.iso.datetime(),
              id: z.string().uuid(),
              filter: z.string(),
            })
            .parse(JSON.parse(decodeURIComponent(q.cursor)));
          if (cursor.filter !== filter) throw new Error();
          conditions.push('(w.local_date,w.started_at,w.id)<(?,?,?)');
          args.push(cursor.localDate, cursor.startedAt, cursor.id);
        } catch {
          return fail(400, 'INVALID_CURSOR', '游标无效或筛选已改变');
        }
      }
      const rows = await c.env.DB.prepare(
        `SELECT w.id,w.started_at AS startedAt,w.timezone,w.local_date AS localDate,w.status,w.duration_seconds AS durationSeconds,w.notes,w.version,w.created_at AS createdAt,w.updated_at AS updatedAt,(SELECT count(*) FROM workout_entries e WHERE e.workout_id=w.id) AS entryCount,(SELECT json_group_array(DISTINCT kind) FROM workout_entries e WHERE e.workout_id=w.id) AS kinds FROM workouts w WHERE ${conditions.join(' AND ')} ORDER BY w.local_date DESC,w.started_at DESC,w.id DESC LIMIT ?`,
      )
        .bind(...args, q.limit + 1)
        .all();
      const data = rows.results.slice(0, q.limit).map((row) =>
        workoutSummarySchema.parse({
          ...row,
          kinds: JSON.parse(String(row.kinds)),
          notes: agent && q.includeNotes !== 'true' ? null : row.notes,
        }),
      );
      const last = data.at(-1);
      return c.json(
        workoutListSchema.parse({
          data,
          meta: {
            requestId: c.get('requestId'),
            from,
            to,
            dateBasis: 'workout_local_date',
            nextCursor:
              rows.results.length > q.limit && last
                ? encodeURIComponent(
                    JSON.stringify({
                      localDate: last.localDate,
                      startedAt: last.startedAt,
                      id: last.id,
                      filter,
                    }),
                  )
                : null,
          },
        }),
        200,
      );
    },
  );
  const params = z.object({ id: z.string().uuid() });
  api.openapi(
    createRoute({
      method: 'get',
      path: '/workouts/{id}',
      security: [{ AccessJWT: [] }],
      request: {
        params,
        query: z.strictObject({
          includeNotes: z.enum(['true', 'false']).default('false'),
        }),
      },
      responses: {
        200: json(
          workoutResponseSchema,
          'Complete aggregate; ETag is quoted version; Agent notes null unless includeNotes=true',
        ),
        ...errors,
      },
    }),
    async (c) => {
      const data = await getWorkout(c.env.DB, c.req.valid('param').id);
      if (!data) return fail(404, 'NOT_FOUND', '训练不存在');
      c.header('ETag', `"${data.version}"`);
      return c.json(
        {
          data:
            agent && c.req.valid('query').includeNotes !== 'true'
              ? redact(data)
              : data,
          meta: { requestId: c.get('requestId') },
        },
        200,
      );
    },
  );
  const body = {
    required: true,
    content: { 'application/json': { schema: workoutInputSchema } },
  };
  api.openapi(
    createRoute({
      method: 'post',
      path: '/workouts',
      description:
        'Agent: only verified services explicitly granted workouts:create; all other services are read-only (405). Creates only, never updates history. Requires application/json and Idempotency-Key, scoped to authenticated principal; replay retained for 24 hours.',
      security: [{ AccessJWT: [] }],
      request: {
        headers: z.object({
          'idempotency-key': z
            .string()
            .min(1)
            .max(200)
            .regex(/^[\x21-\x7e]+$/),
        }),
        body,
      },
      responses: {
        201: json(
          workoutResponseSchema,
          'Atomic creation or original data within 24h replay; meta.replayed marks replay and meta.requestId matches the current X-Request-Id',
        ),
        ...errors,
      },
    }),
    async (c) => {
      const response = await saveWorkout(c.env.DB, c.req.valid('json'), {
        key: c.req.valid('header')['idempotency-key'],
        principal: c.get('principal'),
        requestId: c.get('requestId'),
      });
      c.header('ETag', `"${response.data.version}"`);
      return c.json(response, 201);
    },
  );
  if (agent) return api;
  api.openapi(
    createRoute({
      method: 'put',
      path: '/workouts/{id}',
      security: [{ AccessJWT: [] }],
      request: {
        params,
        headers: z.object({
          'if-match': z.string().optional().openapi({
            description:
              'Required quoted positive version, e.g. "1"; missing returns 428',
          }),
        }),
        body,
      },
      responses: {
        200: json(
          workoutResponseSchema,
          'Atomic full aggregate replacement; retain entry IDs to preserve historical snapshots',
        ),
        ...errors,
      },
    }),
    async (c) => {
      const version = versionHeader(c.req.header('If-Match'));
      const response = await saveWorkout(c.env.DB, c.req.valid('json'), {
        id: c.req.valid('param').id,
        version,
        principal: c.get('principal'),
        requestId: c.get('requestId'),
      });
      c.header('ETag', `"${response.data.version}"`);
      return c.json(response, 200);
    },
  );
  api.openapi(
    createRoute({
      method: 'delete',
      path: '/workouts/{id}',
      security: [{ AccessJWT: [] }],
      request: {
        params,
        headers: z.object({ 'if-match': z.string().optional() }),
      },
      responses: {
        200: json(
          workoutDeleteSchema,
          'CAS physical deletion with cascading children',
        ),
        ...errors,
      },
    }),
    async (c) => {
      const version = versionHeader(c.req.header('If-Match'));
      const id = c.req.valid('param').id;
      const deleted = await c.env.DB.prepare(
        'DELETE FROM workouts WHERE id=? AND version=? RETURNING id',
      )
        .bind(id, version)
        .first();
      if (!deleted) {
        const found = await c.env.DB.prepare(
          'SELECT id FROM workouts WHERE id=?',
        )
          .bind(id)
          .first();
        return fail(
          found ? 412 : 404,
          found ? 'VERSION_CONFLICT' : 'NOT_FOUND',
          '训练已修改或不存在',
        );
      }
      return c.json(
        {
          data: { id, deleted: true as const },
          meta: { requestId: c.get('requestId') },
        },
        200,
      );
    },
  );
  return api;
}
