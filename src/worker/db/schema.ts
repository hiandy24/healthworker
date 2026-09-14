import { sql, desc } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/sqlite-core';
import type { z } from 'zod';
import type { measurementSchema } from '../../shared/contracts';
const audit = () => ({
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  version: integer('version').notNull().default(1),
});
export const exercises = sqliteTable(
  'exercises',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    aliases: text('aliases', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    kind: text('kind', { enum: ['strength', 'cardio'] }).notNull(),
    equipment: text('equipment'),
    muscleGroups: text('muscle_groups', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    measurementMode: text('measurement_mode', {
      enum: ['reps', 'duration', 'cardio'],
    }).notNull(),
    resistanceMode: text('resistance_mode', {
      enum: ['external', 'bodyweight', 'assisted'],
    }),
    loadConvention: text('load_convention', {
      enum: ['total', 'per_implement', 'none'],
    }).notNull(),
    repConvention: text('rep_convention', {
      enum: ['total', 'per_side', 'not_applicable'],
    }).notNull(),
    volumeMultiplier: real('volume_multiplier'),
    cardioCategory: text('cardio_category', {
      enum: ['run', 'walk', 'cycle', 'swim', 'row', 'elliptical', 'other'],
    }),
    isBuiltin: integer('is_builtin', { mode: 'boolean' })
      .notNull()
      .default(false),
    archivedAt: text('archived_at'),
    ...audit(),
  },
  (t) => [
    check('exercise_version', sql`${t.version} > 0`),
    check(
      'exercise_semantics',
      sql`(${t.kind} = 'strength' AND ${t.measurementMode} IN ('reps','duration') AND ${t.resistanceMode} IN ('external','bodyweight','assisted') AND ${t.resistanceMode} IS NOT NULL AND ${t.cardioCategory} IS NULL) OR (${t.kind} = 'cardio' AND ${t.measurementMode} = 'cardio' AND ${t.resistanceMode} IS NULL AND ${t.cardioCategory} IN ('run','walk','cycle','swim','row','elliptical','other') AND ${t.cardioCategory} IS NOT NULL)`,
    ),
    check(
      'exercise_conventions',
      sql`${t.loadConvention} IN ('total','per_implement','none') AND ${t.repConvention} IN ('total','per_side','not_applicable') AND (${t.volumeMultiplier} IS NULL OR (${t.volumeMultiplier}>0 AND ${t.resistanceMode}='external' AND ${t.measurementMode}='reps'))`,
    ),
    check(
      'exercise_json',
      sql`json_valid(${t.aliases}) AND json_type(${t.aliases})='array' AND json_valid(${t.muscleGroups}) AND json_type(${t.muscleGroups})='array'`,
    ),
    check('exercise_builtin', sql`${t.isBuiltin} IN (0,1)`),
  ],
);
export const workouts = sqliteTable(
  'workouts',
  {
    id: text('id').primaryKey(),
    startedAt: text('started_at').notNull(),
    timezone: text('timezone').notNull(),
    localDate: text('local_date').notNull(),
    status: text('status', { enum: ['draft', 'completed'] })
      .notNull()
      .default('draft'),
    durationSeconds: integer('duration_seconds'),
    notes: text('notes'),
    ...audit(),
  },
  (t) => [
    index('workouts_status_date_id').on(t.status, t.localDate, t.id),
    index('workouts_history_order').on(
      desc(t.localDate),
      desc(t.startedAt),
      desc(t.id),
    ),
    check('workout_status', sql`${t.status} IN ('draft','completed')`),
    check(
      'workout_duration',
      sql`${t.durationSeconds} IS NULL OR (${t.durationSeconds}>0 AND typeof(${t.durationSeconds})='integer')`,
    ),
    check('workout_version', sql`${t.version}>0`),
    check('workout_notes', sql`${t.notes} IS NULL OR length(${t.notes})<=4000`),
  ],
);
export const workoutEntries = sqliteTable(
  'workout_entries',
  {
    id: text('id').primaryKey(),
    workoutId: text('workout_id')
      .notNull()
      .references(() => workouts.id, { onDelete: 'cascade' }),
    exerciseId: text('exercise_id')
      .notNull()
      .references(() => exercises.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    kind: text('kind', { enum: ['strength', 'cardio'] }).notNull(),
    exerciseNameSnapshot: text('exercise_name_snapshot').notNull(),
    measurementSnapshot: text('measurement_snapshot', { mode: 'json' })
      .$type<z.infer<typeof measurementSchema>>()
      .notNull(),
    notes: text('notes'),
  },
  (t) => [
    uniqueIndex('entry_position').on(t.workoutId, t.position),
    index('entries_exercise_workout').on(t.exerciseId, t.workoutId),
    check('entry_position_positive', sql`${t.position}>=0`),
    check('entry_kind', sql`${t.kind} IN ('strength','cardio')`),
    check(
      'entry_snapshot',
      sql`json_valid(${t.measurementSnapshot}) AND json_type(${t.measurementSnapshot})='object'`,
    ),
    check('entry_notes', sql`${t.notes} IS NULL OR length(${t.notes})<=4000`),
  ],
);
export const strengthSets = sqliteTable(
  'strength_sets',
  {
    id: text('id').primaryKey(),
    entryId: text('entry_id')
      .notNull()
      .references(() => workoutEntries.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    setType: text('set_type', { enum: ['warmup', 'working'] }).notNull(),
    completed: integer('completed', { mode: 'boolean' })
      .notNull()
      .default(false),
    reps: integer('reps'),
    durationSeconds: integer('duration_seconds'),
    loadGrams: integer('load_grams'),
    assistanceGrams: integer('assistance_grams'),
    effortType: text('effort_type', { enum: ['rpe', 'rir'] }),
    effortValue: real('effort_value'),
    notes: text('notes'),
  },
  (t) => [
    uniqueIndex('set_position').on(t.entryId, t.position),
    check(
      'set_scalars',
      sql`${t.position}>=0 AND ${t.setType} IN ('warmup','working') AND ${t.completed} IN (0,1) AND (${t.reps} IS NULL OR (${t.reps}>0 AND typeof(${t.reps})='integer')) AND (${t.durationSeconds} IS NULL OR (${t.durationSeconds}>0 AND typeof(${t.durationSeconds})='integer')) AND (${t.reps} IS NULL OR ${t.durationSeconds} IS NULL) AND (${t.completed}=0 OR ${t.reps} IS NOT NULL OR ${t.durationSeconds} IS NOT NULL)`,
    ),
    check(
      'set_load',
      sql`(${t.loadGrams} IS NULL OR (${t.loadGrams}>=0 AND typeof(${t.loadGrams})='integer')) AND (${t.assistanceGrams} IS NULL OR (${t.assistanceGrams}>=0 AND typeof(${t.assistanceGrams})='integer')) AND (${t.loadGrams} IS NULL OR ${t.assistanceGrams} IS NULL)`,
    ),
    check(
      'set_effort',
      sql`(${t.effortType} IS NULL AND ${t.effortValue} IS NULL) OR (${t.effortType} IS NOT NULL AND ${t.effortValue} IS NOT NULL AND ((${t.effortType}='rpe' AND ${t.effortValue} BETWEEN 1 AND 10 AND ${t.effortValue}*2=CAST(${t.effortValue}*2 AS INTEGER)) OR (${t.effortType}='rir' AND ${t.effortValue} BETWEEN 0 AND 10 AND ${t.effortValue}=CAST(${t.effortValue} AS INTEGER))))`,
    ),
    check('set_notes', sql`${t.notes} IS NULL OR length(${t.notes})<=4000`),
  ],
);
export const cardioRecords = sqliteTable(
  'cardio_records',
  {
    id: text('id').primaryKey(),
    entryId: text('entry_id')
      .notNull()
      .references(() => workoutEntries.id, { onDelete: 'cascade' }),
    durationSeconds: integer('duration_seconds'),
    durationBasis: text('duration_basis', { enum: ['elapsed', 'moving'] })
      .notNull()
      .default('elapsed'),
    distanceMeters: real('distance_meters'),
    averageHeartRate: integer('average_heart_rate'),
    maxHeartRate: integer('max_heart_rate'),
    elevationGainMeters: real('elevation_gain_meters'),
    inclinePercent: real('incline_percent'),
    resistanceLevel: real('resistance_level'),
    deviceCaloriesKcal: real('device_calories_kcal'),
    completed: integer('completed', { mode: 'boolean' })
      .notNull()
      .default(false),
  },
  (t) => [
    uniqueIndex('cardio_entry').on(t.entryId),
    check(
      'cardio_duration',
      sql`${t.completed} IN (0,1) AND ${t.durationBasis} IN ('elapsed','moving') AND (${t.durationSeconds} IS NULL OR (${t.durationSeconds}>0 AND typeof(${t.durationSeconds})='integer')) AND (${t.completed}=0 OR ${t.durationSeconds} IS NOT NULL)`,
    ),
    check(
      'cardio_measurements',
      sql`(${t.distanceMeters} IS NULL OR ${t.distanceMeters}>=0) AND (${t.elevationGainMeters} IS NULL OR ${t.elevationGainMeters}>=0) AND (${t.inclinePercent} IS NULL OR ${t.inclinePercent} BETWEEN -100 AND 100) AND (${t.resistanceLevel} IS NULL OR ${t.resistanceLevel}>=0) AND (${t.deviceCaloriesKcal} IS NULL OR ${t.deviceCaloriesKcal}>=0)`,
    ),
    check(
      'cardio_heart_rate',
      sql`(${t.averageHeartRate} IS NULL OR (${t.averageHeartRate}>0 AND typeof(${t.averageHeartRate})='integer')) AND (${t.maxHeartRate} IS NULL OR (${t.maxHeartRate}>0 AND typeof(${t.maxHeartRate})='integer')) AND (${t.averageHeartRate} IS NULL OR ${t.maxHeartRate} IS NULL OR ${t.averageHeartRate}<=${t.maxHeartRate})`,
    ),
  ],
);
export const settings = sqliteTable(
  'settings',
  {
    id: text('id').primaryKey().default('singleton'),
    timezone: text('timezone').notNull(),
    locale: text('locale').notNull().default('zh-CN'),
    unitSystem: text('unit_system').notNull().default('metric'),
    theme: text('theme', { enum: ['light', 'dark', 'auto'] })
      .notNull()
      .default('auto'),
    ...audit(),
  },
  (t) => [
    check(
      'settings_singleton',
      sql`${t.id}='singleton' AND ${t.locale}='zh-CN' AND ${t.unitSystem}='metric' AND ${t.theme} IN ('light','dark','auto') AND ${t.version}>0`,
    ),
  ],
);
// Transient assertions, inserted and removed in one atomic batch.
// RAISE triggers are maintained in the appended SQL migration.
export const workoutWriteGuards = sqliteTable(
  'workout_write_guards',
  {
    id: text('id').primaryKey().notNull(),
    checkType: text('check_type', { enum: ['cas', 'exercise'] }).notNull(),
    valid: integer('valid').notNull(),
  },
  (t) => [check('guard_check_type', sql`${t.checkType} IN ('cas','exercise')`)],
);

export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    id: text('id').primaryKey(),
    principal: text('principal').notNull(),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    resourceId: text('resource_id').notNull(),
    responseBody: text('response_body').notNull(),
    responseStatus: integer('response_status').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [
    uniqueIndex('idempotency_principal_scope_key').on(
      t.principal,
      t.scope,
      t.key,
    ),
    index('idempotency_expiry').on(t.expiresAt),
    check(
      'idempotency_response',
      sql`json_valid(${t.responseBody}) AND ${t.responseStatus} BETWEEN 200 AND 299 AND ${t.expiresAt}>${t.createdAt}`,
    ),
  ],
);
