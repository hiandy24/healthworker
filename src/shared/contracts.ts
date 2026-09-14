import { z } from '@hono/zod-openapi';
export const LIMITS = {
  bodyBytes: 512 * 1024,
  entries: 50,
  setsPerEntry: 50,
  totalSets: 300,
  notes: 4000,
  pageSize: 25,
  maxPageSize: 100,
  maxRangeDays: 366,
} as const;
// Generous resource-safety bounds, not physiological thresholds.
export const NUMERIC_LIMITS = {
  durationSeconds: 31_536_000,
  reps: 1_000_000,
  heartRate: 1000,
  distanceMeters: 100_000_000,
  minPositiveDistanceMeters: 0.001,
  elevationGainMeters: 10_000_000,
  resistanceLevel: 1_000_000,
  deviceCaloriesKcal: 100_000_000,
  minMultiplier: 0.001,
  volumeMultiplier: 1000,
} as const;
export const units = {
  load: 'kg',
  storageLoad: 'g',
  distance: 'm',
  duration: 's',
  heartRate: 'bpm',
} as const;
// Day.js/Intl supported application range; reject JS's special 0–99 year mapping.
export const localDateSchema = z.iso
  .date()
  .refine((v) => Number(v.slice(0, 4)) >= 1900, 'Supported years: 1900–9999');
export const startedAtSchema = z.iso
  .datetime()
  .refine((v) => Number(v.slice(0, 4)) >= 1900, 'Supported years: 1900–9999');
export const timezoneSchema = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Invalid IANA timezone');
export const kgSchema = z
  .number()
  .finite()
  .nonnegative()
  .max(10000)
  .refine(
    (n) => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-7,
    'At most three decimal places',
  );
export const measurementSchema = z.strictObject({
  measurementMode: z.enum(['reps', 'duration', 'cardio']),
  resistanceMode: z.enum(['external', 'bodyweight', 'assisted']).nullable(),
  loadConvention: z.enum(['total', 'per_implement', 'none']),
  repConvention: z.enum(['total', 'per_side', 'not_applicable']),
  volumeMultiplier: z.number().positive().nullable(),
});
export const errorSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string() }),
    requestId: z.string(),
  })
  .openapi('Error');
export const metadataSchema = z
  .object({
    data: z.object({
      apiVersion: z.literal('1'),
      schemaVersion: z.literal('1'),
      definitionsVersion: z.literal('1'),
      milestone: z
        .literal('M1')
        .describe(
          'Legacy compatibility marker, not implementation or acceptance status; inspect capabilities and review records',
        ),
      units: z.object({
        load: z.literal('kg'),
        storageLoad: z.literal('g'),
        distance: z.literal('m'),
        duration: z.literal('s'),
        heartRate: z.literal('bpm'),
      }),
      dateBasis: z.literal('workout_local_date'),
      rangeSemantics: z.literal('[from,to)'),
      weekStartsOn: z.literal('monday'),
      warmupDefault: z.literal('exclude'),
      timezone: timezoneSchema.nullable(),
      capabilities: z.array(
        z.enum([
          'metadata',
          'openapi',
          'exercises',
          'workouts',
          'stats',
          'settings',
          'export',
          'workouts:create',
        ]),
      ),
      coverage: z.object({
        dateBasis: z.literal('workout_local_date'),
        workoutCount: z.number().int().nonnegative(),
        completedWorkoutCount: z.number().int().nonnegative(),
        draftWorkoutCount: z.number().int().nonnegative(),
        firstLocalDate: z.iso.date().nullable(),
        lastLocalDate: z.iso.date().nullable(),
        firstCompletedLocalDate: z.iso.date().nullable(),
        lastCompletedLocalDate: z.iso.date().nullable(),
      }),
      authentication: z.enum(['access', 'local_mock']),
    }),
    meta: z.object({ requestId: z.string() }),
  })
  .openapi('Metadata');
export type Metadata = z.infer<typeof metadataSchema>;
