import { z } from '@hono/zod-openapi';
import { localDateSchema } from './contracts';

export const categorySchema = z.enum([
  'run',
  'walk',
  'cycle',
  'swim',
  'row',
  'elliptical',
  'other',
]);
const count = z.number().int().nonnegative();
const amount = z.number().nonnegative();
const nullableAmount = amount.nullable();
const rangeQuery = {
  from: localDateSchema.optional(),
  to: localDateSchema.optional(),
};
export const summaryQuerySchema = z.strictObject({
  ...rangeQuery,
  granularity: z.enum(['day', 'week', 'month']).default('week'),
});
export const strengthQuerySchema = z.strictObject({
  ...rangeQuery,
  exerciseId: z.string().uuid(),
  includeWarmup: z.enum(['true', 'false']).default('false'),
});
export const cardioQuerySchema = z.strictObject({
  ...rangeQuery,
  category: categorySchema.optional(),
  durationBasis: z.enum(['elapsed', 'moving']).optional(),
});
export const statsContextSchema = z.object({
  definitionsVersion: z.literal('1'),
  dateBasis: z.literal('workout_local_date'),
  from: z.iso.date(),
  to: z.iso.date(),
  status: z.literal('completed'),
  warmup: z.enum(['include', 'exclude', 'not_applicable']),
});
export const qualityLabels = {
  workoutDuration: '整次训练时长缺失',
  cardioDistance: '有氧距离缺失',
  draftWorkouts: '草稿训练',
  load: '外加重量缺失',
  assistance: '辅助重量缺失',
  reps: '次数缺失',
  duration: '时长缺失或计时模式不参与容量',
  bodyweight: '自重组',
  assisted: '辅助组',
  unknownMultiplier: '倍率未知',
  missingLoad: '容量重量缺失',
  missingReps: '容量次数缺失',
  draftSets: '草稿组',
  incompleteSets: '未完成组',
  warmupSets: '热身组',
  distance: '距离缺失',
  heartRate: '心率缺失',
  elevation: '爬升缺失',
  draftRecords: '草稿条目',
  incompleteRecords: '未完成条目',
  paceMissingDistance: '配速排除：距离缺失',
  paceZeroDistance: '配速排除：零距离',
} as const;
export type QualityKey = keyof typeof qualityLabels;
const qualityCounts = z.partialRecord(
  z.enum(Object.keys(qualityLabels) as [QualityKey, ...QualityKey[]]),
  count,
);
export const qualitySchema = z.object({
  validSamples: count,
  missing: qualityCounts,
  excluded: qualityCounts,
});
export const summaryMetricsSchema = z.object({
  workoutCount: count,
  recordedDurationWorkoutCount: count,
  durationSeconds: amount,
  durationCoverage: z.number().min(0).max(1).nullable(),
  strengthWorkoutCount: count,
  cardioWorkoutCount: count,
  cardioDurationSeconds: amount,
});
export const summaryResponseSchema = z.object({
  data: z.object({
    ...statsContextSchema.shape,
    granularity: z.enum(['day', 'week', 'month']),
    totals: summaryMetricsSchema,
    buckets: z.array(
      summaryMetricsSchema.extend({
        bucketStart: z.iso.date(),
        from: z.iso.date(),
        to: z.iso.date(),
      }),
    ),
    cardioByCategory: z.array(
      z.object({
        category: categorySchema,
        durationBasis: z.enum(['elapsed', 'moving']),
        recordCount: count,
        durationSeconds: amount,
        distanceMeters: amount,
        distanceSampleCount: count,
      }),
    ),
    quality: qualitySchema,
  }),
  meta: z.object({ requestId: z.string() }),
});
export const strengthMetricsSchema = z.object({
  setCount: count,
  workingSetCount: count,
  warmupSetCount: count,
  reps: amount,
  durationSeconds: amount,
  maxLoadKg: nullableAmount,
  volumeKgReps: nullableAmount,
  volumeSampleCount: count,
});
const strengthRecord = z.object({
  workoutId: z.string().uuid(),
  localDate: z.iso.date(),
  startedAt: z.iso.datetime(),
  entryId: z.string().uuid(),
  setId: z.string().uuid(),
  loadKg: nullableAmount,
  assistanceKg: nullableAmount,
  reps: nullableAmount,
  durationSeconds: nullableAmount,
});
export const strengthResponseSchema = z.object({
  data: z.object({
    ...statsContextSchema.shape,
    exerciseId: z.string().uuid(),
    granularity: z.literal('workout'),
    totals: strengthMetricsSchema,
    workouts: z.array(
      strengthMetricsSchema.extend({
        workoutId: z.string().uuid(),
        localDate: z.iso.date(),
        startedAt: z.iso.datetime(),
      }),
    ),
    records: z.object({
      maxLoad: strengthRecord.nullable(),
      longestDuration: strengthRecord.nullable(),
      mostRepsByResistance: z.array(
        strengthRecord.extend({
          resistanceMode: z.enum(['external', 'bodyweight', 'assisted']),
        }),
      ),
    }),
    quality: qualitySchema,
  }),
  meta: z.object({ requestId: z.string() }),
});
export const cardioMetricsSchema = z.object({
  recordCount: count,
  durationSeconds: amount,
  distanceMeters: amount,
  distanceSampleCount: count,
  elevationGainMeters: amount,
  elevationSampleCount: count,
  paceSampleCount: count,
  paceDurationSeconds: amount,
  paceDistanceMeters: amount,
  speedKmh: nullableAmount,
  paceSecondsPerKm: nullableAmount,
  paceSecondsPer100m: nullableAmount,
  heartRateSampleCount: count,
  heartRateDurationSeconds: amount,
  averageHeartRate: nullableAmount,
});
export const cardioResponseSchema = z.object({
  data: z.object({
    ...statsContextSchema.shape,
    granularity: z.literal('record'),
    category: categorySchema.nullable(),
    durationBasis: z.enum(['elapsed', 'moving']).nullable(),
    heartRateDefinition: z.literal('record_mean_duration_weighted_estimate'),
    groups: z.array(
      cardioMetricsSchema.extend({
        category: categorySchema,
        durationBasis: z.enum(['elapsed', 'moving']),
      }),
    ),
    records: z.array(
      z.object({
        workoutId: z.string().uuid(),
        entryId: z.string().uuid(),
        exerciseId: z.string().uuid(),
        localDate: z.iso.date(),
        startedAt: z.iso.datetime(),
        category: categorySchema,
        durationBasis: z.enum(['elapsed', 'moving']),
        durationSeconds: amount,
        distanceMeters: nullableAmount,
        averageHeartRate: nullableAmount,
        maxHeartRate: nullableAmount,
        elevationGainMeters: nullableAmount,
        speedKmh: nullableAmount,
        paceSecondsPerKm: nullableAmount,
        paceSecondsPer100m: nullableAmount,
      }),
    ),
    quality: qualitySchema,
  }),
  meta: z.object({ requestId: z.string() }),
});
export type SummaryResponse = z.infer<typeof summaryResponseSchema>;
export type StrengthResponse = z.infer<typeof strengthResponseSchema>;
export type CardioResponse = z.infer<typeof cardioResponseSchema>;
