import { z } from '@hono/zod-openapi';
import { exerciseSchema } from './exercises';
import { settingsSchema } from './settings';
import {
  workoutSummarySchema,
  strengthSetReadSchema,
  cardioReadSchema,
  validateStrengthMeasurement,
} from './workouts';
import { measurementSchema } from './contracts';
export const EXPORT_LIMITS = { rows: 150000, bytes: 20 * 1024 * 1024 } as const;
export const backupWorkoutSchema = workoutSummarySchema
  .omit({ entryCount: true, kinds: true })
  .strict();
export const backupEntrySchema = z.strictObject({
  id: z.string().uuid(),
  workoutId: z.string().uuid(),
  exerciseId: z.string().uuid(),
  position: z.number().int().nonnegative(),
  kind: z.enum(['strength', 'cardio']),
  exerciseNameSnapshot: z.string().max(200),
  measurementSnapshot: measurementSchema,
  notes: z.string().max(4000).nullable(),
});
export const backupSetSchema = strengthSetReadSchema.safeExtend({
  entryId: z.string().uuid(),
  position: z.number().int().nonnegative(),
});
export const backupCardioSchema = cardioReadSchema.safeExtend({
  id: z.string().uuid(),
  entryId: z.string().uuid(),
});
export const backupSchema = z
  .strictObject({
    schemaVersion: z.literal('1'),
    definitionsVersion: z.literal('1'),
    exportedAt: z.iso.datetime(),
    settings: settingsSchema.nullable(),
    exercises: z.array(exerciseSchema).max(EXPORT_LIMITS.rows),
    workouts: z.array(backupWorkoutSchema).max(EXPORT_LIMITS.rows),
    entries: z.array(backupEntrySchema).max(EXPORT_LIMITS.rows),
    strengthSets: z.array(backupSetSchema).max(EXPORT_LIMITS.rows),
    cardioRecords: z.array(backupCardioSchema).max(EXPORT_LIMITS.rows),
  })
  .superRefine((value, ctx) => {
    const total =
      value.exercises.length +
      value.workouts.length +
      value.entries.length +
      value.strengthSets.length +
      value.cardioRecords.length +
      (value.settings ? 1 : 0);
    if (total > EXPORT_LIMITS.rows)
      ctx.addIssue({ code: 'custom', message: '备份超过总行数上限' });
    const unique = (rows: { id: string }[]) =>
      new Set(rows.map((r) => r.id)).size === rows.length;
    for (const rows of [
      value.exercises,
      value.workouts,
      value.entries,
      value.strengthSets,
      value.cardioRecords,
    ])
      if (!unique(rows))
        ctx.addIssue({ code: 'custom', message: '备份包含重复ID' });
    const exercises = new Map(value.exercises.map((r) => [r.id, r]));
    const workouts = new Set(value.workouts.map((r) => r.id));
    const entries = new Map(value.entries.map((r) => [r.id, r]));
    for (const e of value.entries)
      if (
        !workouts.has(e.workoutId) ||
        exercises.get(e.exerciseId)?.kind !== e.kind
      )
        ctx.addIssue({ code: 'custom', message: '备份动作/训练引用无效' });
    const setsByEntry = new Map<string, typeof value.strengthSets>();
    const cardioByEntry = new Map<string, typeof value.cardioRecords>();
    const entriesByWorkout = new Map<string, typeof value.entries>();
    const issue = (message: string) =>
      ctx.addIssue({ code: 'custom', message });
    for (const e of value.entries) {
      const group = entriesByWorkout.get(e.workoutId) ?? [];
      group.push(e);
      entriesByWorkout.set(e.workoutId, group);
      if (
        (e.kind === 'cardio') !==
        (e.measurementSnapshot.measurementMode === 'cardio')
      )
        issue('历史快照类型无效');
    }
    for (const s of value.strengthSets) {
      const entry = entries.get(s.entryId);
      if (entry?.kind !== 'strength') issue('力量组引用无效');
      else
        for (const message of validateStrengthMeasurement(
          s,
          entry.measurementSnapshot,
        ))
          issue(message);
      const group = setsByEntry.get(s.entryId) ?? [];
      group.push(s);
      setsByEntry.set(s.entryId, group);
    }
    for (const c of value.cardioRecords) {
      const group = cardioByEntry.get(c.entryId) ?? [];
      group.push(c);
      cardioByEntry.set(c.entryId, group);
    }
    const positionsUnique = (rows: { position: number }[]) =>
      new Set(rows.map((r) => r.position)).size === rows.length;
    for (const w of value.workouts) {
      const group = entriesByWorkout.get(w.id) ?? [];
      if (!positionsUnique(group)) issue('条目顺序重复');
      if (w.status === 'completed' && !group.length) issue('完成训练不能为空');
      for (const entry of group) {
        const sets = setsByEntry.get(entry.id) ?? [];
        const cardio = cardioByEntry.get(entry.id) ?? [];
        if (!positionsUnique(sets)) issue('组顺序重复');
        if (entry.kind === 'cardio' && cardio.length !== 1)
          issue('有氧须有一条明细');
        if (
          w.status === 'completed' &&
          (entry.kind === 'strength'
            ? !sets.length || sets.some((s) => !s.completed)
            : !cardio[0]?.completed)
        )
          issue('完成训练包含未完成明细');
      }
    }
    for (const c of value.cardioRecords)
      if (entries.get(c.entryId)?.kind !== 'cardio')
        ctx.addIssue({ code: 'custom', message: '有氧引用无效' });
  });
export const exportQuerySchema = z
  .strictObject({
    format: z.enum(['json', 'csv']).default('json'),
    dataset: z.enum(['workouts', 'strengthSets', 'cardioRecords']).optional(),
  })
  .refine(
    (v) => v.format === 'csv' || v.dataset === undefined,
    'dataset仅适用于CSV',
  );
export type Backup = z.infer<typeof backupSchema>;
