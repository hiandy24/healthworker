import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { drizzle } from 'drizzle-orm/d1';
import { sql } from 'drizzle-orm';
import { stringify } from 'csv-stringify/sync';
import type { Bindings } from './auth';
import {
  settings,
  exercises,
  workouts,
  workoutEntries,
  strengthSets,
  cardioRecords,
} from './db/schema';
import {
  backupSchema,
  exportQuerySchema,
  EXPORT_LIMITS,
  type Backup,
} from '../shared/backup';
import { gramsToKg } from '../shared/units';
import { errorSchema } from '../shared/contracts';
export class ExportLimitError extends Error {}
export async function exportBackup(binding: D1Database): Promise<Backup> {
  const db = drizzle(binding);
  // Size and count gates are repeated within the same read transaction. Each select
  // returns zero rows when the complete snapshot exceeds the production bound.
  const rowCount = `(SELECT count(*) FROM settings)+(SELECT count(*) FROM exercises)+(SELECT count(*) FROM workouts)+(SELECT count(*) FROM workout_entries)+(SELECT count(*) FROM strength_sets)+(SELECT count(*) FROM cardio_records)`;
  // Text is the dominant variable-width payload. Include all JSON/notes and a
  // conservative 2KiB per row structural allowance before materializing it.
  const textBytes = `(SELECT coalesce(sum(length(CAST(coalesce(notes,'') AS BLOB))),0) FROM workouts)+(SELECT coalesce(sum(length(CAST(coalesce(notes,'')||exercise_name_snapshot||measurement_snapshot AS BLOB))),0) FROM workout_entries)+(SELECT coalesce(sum(length(CAST(coalesce(notes,'') AS BLOB))),0) FROM strength_sets)+(SELECT coalesce(sum(length(CAST(name||aliases||muscle_groups||coalesce(equipment,'') AS BLOB))),0) FROM exercises)`;
  const permitted = sql.raw(
    `(${rowCount})<=${EXPORT_LIMITS.rows} AND (${textBytes})+(${rowCount})*2048<=${EXPORT_LIMITS.bytes}`,
  );
  const [gate, preferences, actions, sessions, entries, sets, cardio] =
    await db.batch([
      db.select({ allowed: permitted }).from(sql`(SELECT 1)`),
      db.select().from(settings).where(permitted),
      db.select().from(exercises).where(permitted).orderBy(exercises.id),
      db.select().from(workouts).where(permitted).orderBy(workouts.id),
      db
        .select()
        .from(workoutEntries)
        .where(permitted)
        .orderBy(workoutEntries.workoutId, workoutEntries.position),
      db
        .select()
        .from(strengthSets)
        .where(permitted)
        .orderBy(strengthSets.entryId, strengthSets.position),
      db
        .select()
        .from(cardioRecords)
        .where(permitted)
        .orderBy(cardioRecords.entryId),
    ]);
  if (!gate[0]?.allowed)
    throw new ExportLimitError(
      '完整备份超过150000行或20MiB保守大小预算，请使用受控数据库备份；未截断',
    );
  const result = backupSchema.parse({
    schemaVersion: '1',
    definitionsVersion: '1',
    exportedAt: new Date().toISOString(),
    settings: preferences[0] ?? null,
    exercises: actions,
    workouts: sessions,
    entries,
    strengthSets: sets.map((s) => {
      const { loadGrams, assistanceGrams, ...rest } = s;
      return {
        ...rest,
        loadKg: gramsToKg(loadGrams),
        assistanceKg: gramsToKg(assistanceGrams),
      };
    }),
    cardioRecords: cardio,
  });
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength >
    EXPORT_LIMITS.bytes
  )
    throw new ExportLimitError('完整备份超过20MiB，未截断');
  return result;
}
export function backupCsv(
  backup: Backup,
  dataset: 'workouts' | 'strengthSets' | 'cardioRecords',
): string {
  const entryMap = new Map(backup.entries.map((e) => [e.id, e]));
  const rows =
    dataset === 'workouts'
      ? backup.workouts
      : backup[dataset].map((row) => ({
          ...row,
          workoutId: entryMap.get(row.entryId)!.workoutId,
          exerciseId: entryMap.get(row.entryId)!.exerciseId,
          exerciseNameSnapshot: entryMap.get(row.entryId)!.exerciseNameSnapshot,
          entryNotes: entryMap.get(row.entryId)!.notes,
          measurementSnapshot: JSON.stringify(
            entryMap.get(row.entryId)!.measurementSnapshot,
          ),
        }));
  const columns =
    dataset === 'workouts'
      ? [
          'id',
          'startedAt',
          'timezone',
          'localDate',
          'status',
          'durationSeconds',
          'notes',
          'version',
          'createdAt',
          'updatedAt',
        ]
      : dataset === 'strengthSets'
        ? [
            'id',
            'entryId',
            'workoutId',
            'exerciseId',
            'exerciseNameSnapshot',
            'measurementSnapshot',
            'position',
            'setType',
            'completed',
            'reps',
            'durationSeconds',
            'loadKg',
            'assistanceKg',
            'effortType',
            'effortValue',
            'notes',
            'entryNotes',
          ]
        : [
            'id',
            'entryId',
            'workoutId',
            'exerciseId',
            'exerciseNameSnapshot',
            'measurementSnapshot',
            'completed',
            'durationSeconds',
            'durationBasis',
            'distanceMeters',
            'averageHeartRate',
            'maxHeartRate',
            'elevationGainMeters',
            'inclinePercent',
            'resistanceLevel',
            'deviceCaloriesKcal',
            'entryNotes',
          ];
  // Library handles RFC CSV quoting and spreadsheet formula escaping, including
  // tab/CR and full-width operators. A leading apostrophe is display-only export.
  const output = stringify(rows, {
    header: true,
    columns,
    escape_formulas: true,
    cast: { boolean: (value) => (value ? 'true' : 'false') },
  });
  if (new TextEncoder().encode(output).byteLength > EXPORT_LIMITS.bytes)
    throw new ExportLimitError('CSV超过20MiB，未截断');
  return output;
}
export function exportRoutes() {
  const api = new OpenAPIHono<{
    Bindings: Bindings;
    Variables: { requestId: string };
  }>({
    defaultHook: (r, c) => {
      if (!r.success)
        return c.json(
          {
            error: { code: 'INVALID_QUERY', message: '导出参数无效' },
            requestId: c.get('requestId'),
          },
          400,
        );
    },
  });
  api.openapi(
    createRoute({
      method: 'get',
      path: '/export',
      security: [{ AccessJWT: [] }],
      request: { query: exportQuerySchema },
      responses: {
        200: {
          description:
            'Attachment: full versioned JSON or CSV dataset (default workouts). All rows including drafts, archives and notes. 150000 row/20MiB conservative budget; no truncation. No credentials/idempotency records.',
          content: {
            'application/json': { schema: backupSchema },
            'text/csv': { schema: z.string() },
          },
        },
        400: {
          description: 'Invalid query',
          content: { 'application/json': { schema: errorSchema } },
        },
        413: {
          description: 'Full export exceeds safe bound; use controlled backup',
          content: { 'application/json': { schema: errorSchema } },
        },
      },
    }),
    async (c) => {
      try {
        const backup = await exportBackup(c.env.DB);
        const q = c.req.valid('query');
        c.header(
          'Content-Disposition',
          `attachment; filename="healthworker-${q.dataset ?? 'backup'}.${q.format}"`,
        );
        if (q.format === 'json') return c.json(backup, 200);
        c.header('Content-Type', 'text/csv; charset=utf-8');
        return c.body(backupCsv(backup, q.dataset ?? 'workouts'), 200);
      } catch (error) {
        if (error instanceof ExportLimitError)
          return c.json(
            {
              error: { code: 'EXPORT_TOO_LARGE', message: error.message },
              requestId: c.get('requestId'),
            },
            413,
          );
        throw error;
      }
    },
  );
  return api;
}
