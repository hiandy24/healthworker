import { z } from '@hono/zod-openapi';
import {
  kgSchema,
  NUMERIC_LIMITS,
  LIMITS,
  measurementSchema,
  timezoneSchema,
  localDateSchema,
  startedAtSchema,
} from './contracts';

import { workoutLocalDate } from './dates';

const notes = z.string().max(LIMITS.notes).nullable();
const positiveInteger = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const strengthSetReadSchema = z
  .strictObject({
    id: z.string().uuid(),
    setType: z.enum(['warmup', 'working']),
    completed: z.boolean(),
    reps: positiveInteger.nullable(),
    durationSeconds: positiveInteger.nullable(),
    loadKg: kgSchema.nullable(),
    assistanceKg: kgSchema.nullable(),
    effortType: z.enum(['rpe', 'rir']).nullable(),
    effortValue: z.number().nullable(),
    notes,
  })
  .superRefine((value, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (value.reps !== null && value.durationSeconds !== null)
      issue('durationSeconds', '次数和计时不能同时填写');
    if (value.loadKg !== null && value.assistanceKg !== null)
      issue('assistanceKg', '外加负重和辅助重量不能同时填写');
    if (
      value.completed &&
      value.reps === null &&
      value.durationSeconds === null
    )
      issue('completed', '完成组须填写次数或时长');
    const effort = value.effortValue;
    if (
      value.effortType === null
        ? effort !== null
        : effort === null ||
          (value.effortType === 'rpe'
            ? effort < 1 || effort > 10 || !Number.isInteger(effort * 2)
            : effort < 0 || effort > 10 || !Number.isInteger(effort))
    )
      issue(
        'effortValue',
        'RPE 为 1–10 半级值，RIR 为 0–10 整数，类型和值须同时提供',
      );
  });
export const cardioReadSchema = z
  .strictObject({
    completed: z.boolean(),
    durationSeconds: positiveInteger.nullable(),
    durationBasis: z.enum(['elapsed', 'moving']),
    distanceMeters: z.number().nonnegative().nullable(),
    averageHeartRate: positiveInteger.nullable(),
    maxHeartRate: positiveInteger.nullable(),
    elevationGainMeters: z.number().nonnegative().nullable(),
    inclinePercent: z.number().min(-100).max(100).nullable(),
    resistanceLevel: z.number().nonnegative().nullable(),
    deviceCaloriesKcal: z.number().nonnegative().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.completed && value.durationSeconds === null)
      ctx.addIssue({
        code: 'custom',
        path: ['durationSeconds'],
        message: '完成有氧须填写时长',
      });
    if (
      value.averageHeartRate !== null &&
      value.maxHeartRate !== null &&
      value.averageHeartRate > value.maxHeartRate
    )
      ctx.addIssue({
        code: 'custom',
        path: ['averageHeartRate'],
        message: '平均心率不得大于最大心率',
      });
  });
export const strengthSetInputSchema = strengthSetReadSchema.safeExtend({
  reps: positiveInteger.max(NUMERIC_LIMITS.reps).nullable(),
  durationSeconds: positiveInteger
    .max(NUMERIC_LIMITS.durationSeconds)
    .nullable(),
});
export const cardioInputSchema = cardioReadSchema.safeExtend({
  durationSeconds: positiveInteger
    .max(NUMERIC_LIMITS.durationSeconds)
    .nullable(),
  distanceMeters: z
    .union([
      z.literal(0),
      z
        .number()
        .min(NUMERIC_LIMITS.minPositiveDistanceMeters)
        .max(NUMERIC_LIMITS.distanceMeters),
    ])
    .nullable(),
  averageHeartRate: positiveInteger.max(NUMERIC_LIMITS.heartRate).nullable(),
  maxHeartRate: positiveInteger.max(NUMERIC_LIMITS.heartRate).nullable(),
  elevationGainMeters: z
    .number()
    .nonnegative()
    .max(NUMERIC_LIMITS.elevationGainMeters)
    .nullable(),
  resistanceLevel: z
    .number()
    .nonnegative()
    .max(NUMERIC_LIMITS.resistanceLevel)
    .nullable(),
  deviceCaloriesKcal: z
    .number()
    .nonnegative()
    .max(NUMERIC_LIMITS.deviceCaloriesKcal)
    .nullable(),
});
const entryBase = {
  id: z.string().uuid(),
  exerciseId: z.string().uuid(),
  notes,
};
export const entryInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...entryBase,
    kind: z.literal('strength'),
    sets: z.array(strengthSetInputSchema).max(LIMITS.setsPerEntry),
  }),
  z.strictObject({
    ...entryBase,
    kind: z.literal('cardio'),
    cardio: cardioInputSchema,
  }),
]);
export const workoutInputSchema = z
  .strictObject({
    startedAt: startedAtSchema,
    timezone: timezoneSchema,
    status: z.enum(['draft', 'completed']),
    durationSeconds: positiveInteger
      .max(NUMERIC_LIMITS.durationSeconds)
      .nullable(),
    notes,
    entries: z.array(entryInputSchema).max(LIMITS.entries),
  })
  .superRefine((value, ctx) => {
    try {
      workoutLocalDate(value.startedAt, value.timezone);
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['startedAt'],
        message: '开始时间及派生本地日期须在1900–9999年范围内',
      });
    }
    const ids = new Set<string>();
    let count = 0;
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (value.status === 'completed' && value.entries.length === 0)
      issue(['entries'], '完成训练至少包含一个动作');
    value.entries.forEach((entry, i) => {
      if (ids.has(entry.id)) issue(['entries', i, 'id'], 'ID 不得重复');
      ids.add(entry.id);
      if (entry.kind === 'strength') {
        count += entry.sets.length;
        if (
          value.status === 'completed' &&
          (!entry.sets.length || entry.sets.some((set) => !set.completed))
        )
          issue(['entries', i, 'sets'], '请完成或移除未完成组');
        entry.sets.forEach((set, j) => {
          if (ids.has(set.id))
            issue(['entries', i, 'sets', j, 'id'], 'ID 不得重复');
          ids.add(set.id);
        });
      } else if (value.status === 'completed' && !entry.cardio.completed)
        issue(['entries', i, 'cardio', 'completed'], '请完成或移除有氧条目');
    });
    if (count > LIMITS.totalSets) issue(['entries'], '单训练最多 300 组');
  });
// The server must call this with its trusted exercise or historical snapshot.
// Client-supplied snapshots are deliberately absent from write contracts.
export function validateStrengthMeasurement(
  set: z.infer<typeof strengthSetInputSchema>,
  measurement: z.infer<typeof measurementSchema>,
): string[] {
  const errors: string[] = [];
  if (measurement.measurementMode === 'cardio')
    errors.push('有氧动作不接受力量组');
  if (
    measurement.measurementMode === 'reps' &&
    (set.durationSeconds !== null || (set.completed && set.reps === null))
  )
    errors.push('次数动作须使用次数');
  if (
    measurement.measurementMode === 'duration' &&
    (set.reps !== null || (set.completed && set.durationSeconds === null))
  )
    errors.push('计时动作须使用时长');
  if (measurement.resistanceMode === 'assisted') {
    if (set.loadKg !== null || (set.completed && set.assistanceKg === null))
      errors.push('辅助动作须记录辅助重量且不能记录外加负重');
  } else {
    if (set.assistanceKg !== null) errors.push('非辅助动作不能记录辅助重量');
    if (
      measurement.resistanceMode === 'external' &&
      set.completed &&
      set.loadKg === null
    )
      errors.push('外加负重须明确填写，零重量不等于缺失');
  }
  return errors;
}
export type WorkoutInput = z.infer<typeof workoutInputSchema>;
export type StrengthSetInput = z.infer<typeof strengthSetInputSchema>;

const entryOutputBase = {
  ...entryBase,
  position: z.number().int().nonnegative(),
  exerciseNameSnapshot: z.string(),
  measurementSnapshot: measurementSchema,
};
export const entrySchema = z.discriminatedUnion('kind', [
  z.object({
    ...entryOutputBase,
    kind: z.literal('strength'),
    sets: z.array(
      strengthSetReadSchema.safeExtend({
        position: z.number().int().nonnegative(),
      }),
    ),
  }),
  z.object({
    ...entryOutputBase,
    kind: z.literal('cardio'),
    cardio: cardioReadSchema,
  }),
]);
export const workoutSummarySchema = z.object({
  id: z.string().uuid(),
  startedAt: startedAtSchema,
  timezone: timezoneSchema,
  localDate: localDateSchema,
  status: z.enum(['draft', 'completed']),
  durationSeconds: positiveInteger.nullable(),
  notes,
  version: positiveInteger,
  createdAt: startedAtSchema,
  updatedAt: startedAtSchema,
  entryCount: z.number().int().nonnegative(),
  kinds: z.array(z.enum(['strength', 'cardio'])),
});
export const workoutSchema = workoutSummarySchema.extend({
  entries: z.array(entrySchema),
});
export const workoutResponseSchema = z.object({
  data: workoutSchema,
  meta: z.object({ requestId: z.string(), replayed: z.boolean().optional() }),
});
export const workoutQuerySchema = z.strictObject({
  from: localDateSchema.optional(),
  to: localDateSchema.optional(),
  status: z.enum(['draft', 'completed']).optional(),
  kind: z.enum(['strength', 'cardio']).optional(),
  exerciseId: z.string().uuid().optional(),
  includeNotes: z.enum(['true', 'false']).default('false'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LIMITS.maxPageSize)
    .default(LIMITS.pageSize),
  cursor: z.string().max(4000).optional(),
});
export const workoutListSchema = z.object({
  data: z.array(workoutSummarySchema),
  meta: z.object({
    requestId: z.string(),
    nextCursor: z.string().nullable(),
    from: localDateSchema,
    to: localDateSchema,
    dateBasis: z.literal('workout_local_date'),
  }),
});
export const workoutDeleteSchema = z.object({
  data: z.object({ id: z.string().uuid(), deleted: z.literal(true) }),
  meta: z.object({ requestId: z.string() }),
});
export type Workout = z.infer<typeof workoutSchema>;
export type WorkoutResponse = z.infer<typeof workoutResponseSchema>;
