import { z } from '@hono/zod-openapi';
import { measurementSchema, LIMITS, NUMERIC_LIMITS } from './contracts';

const exerciseReadSchema = measurementSchema
  .extend({
    name: z.string().trim().min(1).max(200),
    aliases: z.array(z.string().trim().min(1).max(200)).max(20),
    kind: z.enum(['strength', 'cardio']),
    equipment: z.string().max(100).nullable(),
    muscleGroups: z.array(z.string().min(1).max(100)).max(20),
    cardioCategory: z
      .enum(['run', 'walk', 'cycle', 'swim', 'row', 'elliptical', 'other'])
      .nullable(),
  })
  .superRefine((v, ctx) => {
    const invalid =
      v.kind === 'cardio'
        ? v.measurementMode !== 'cardio' ||
          v.resistanceMode !== null ||
          v.cardioCategory === null ||
          v.loadConvention !== 'none' ||
          v.repConvention !== 'not_applicable'
        : v.measurementMode === 'cardio' ||
          v.resistanceMode === null ||
          v.cardioCategory !== null ||
          (v.measurementMode === 'duration'
            ? v.repConvention !== 'not_applicable'
            : v.repConvention === 'not_applicable');
    if (invalid)
      ctx.addIssue({
        code: 'custom',
        message: '动作类型与计量口径不一致',
        path: ['measurementMode'],
      });
    if (
      v.volumeMultiplier !== null &&
      (v.resistanceMode !== 'external' ||
        v.measurementMode !== 'reps' ||
        v.loadConvention === 'none')
    )
      ctx.addIssue({
        code: 'custom',
        message: '容量倍率仅适用于明确外加负重次数动作',
        path: ['volumeMultiplier'],
      });
  });
export const exerciseInputSchema = exerciseReadSchema.safeExtend({
  volumeMultiplier: z
    .number()
    .min(NUMERIC_LIMITS.minMultiplier)
    .max(NUMERIC_LIMITS.volumeMultiplier)
    .nullable(),
});
export const agentExerciseCreateSchema = exerciseInputSchema.extend({
  id: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Optional client-chosen stable id so batch imports can reference the exercise before it exists',
    ),
});
export const exerciseSchema = exerciseReadSchema.safeExtend({
  id: z.string().uuid(),
  isBuiltin: z.boolean(),
  archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  version: z.number().int().positive(),
});
export const exercisePatchSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200).optional(),
    aliases: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    equipment: z.string().max(100).nullable().optional(),
    muscleGroups: z.array(z.string().min(1).max(100)).max(20).optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, '至少提供一个更新字段');
export const exerciseQuerySchema = z.strictObject({
  query: z.string().max(200).default(''),
  kind: z.enum(['strength', 'cardio']).optional(),
  includeArchived: z.enum(['true', 'false']).default('false'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LIMITS.maxPageSize)
    .default(LIMITS.pageSize),
  cursor: z.string().max(4000).optional(),
});
export const exerciseResponseSchema = z.object({
  data: exerciseSchema,
  meta: z.object({ requestId: z.string() }),
});
export const exerciseListSchema = z.object({
  data: z.array(exerciseSchema),
  meta: z.object({ requestId: z.string(), nextCursor: z.string().nullable() }),
});
export type Exercise = z.infer<typeof exerciseSchema>;
export type ExerciseInput = z.infer<typeof exerciseInputSchema>;
export type AgentExerciseCreate = z.infer<typeof agentExerciseCreateSchema>;
export type ExercisePatch = z.infer<typeof exercisePatchSchema>;
export type ExerciseQuery = z.infer<typeof exerciseQuerySchema>;
