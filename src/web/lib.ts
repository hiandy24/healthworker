import { z } from 'zod';
import type { QueryClient } from '@tanstack/react-query';
import {
  workoutInputSchema,
  type Workout,
  type WorkoutInput,
  type StrengthSetInput,
} from '../shared/workouts';
import { exerciseSchema } from '../shared/exercises';
import { measurementSchema, LIMITS } from '../shared/contracts';
import { settingsResponseSchema } from '../shared/settings';

export const settingsQuery = {
  queryKey: ['settings'],
  queryFn: () => api('/settings', settingsResponseSchema),
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function assertBodySize(body: string) {
  if (new TextEncoder().encode(body).byteLength > LIMITS.bodyBytes)
    throw new ApiError(
      413,
      '提交内容超过 512 KiB，输入已保留。请减少备注或拆分训练后重试。',
    );
}
export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes((init?.method ?? 'GET').toUpperCase())
  )
    headers.set('Content-Type', 'application/json');
  if (typeof init?.body === 'string') assertBodySize(init.body);
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...init,
      credentials: 'same-origin',
      redirect: 'error',
      headers,
    });
  } catch {
    throw new ApiError(
      0,
      '网络中断或登录跳转，输入已保留。请检查网络或重新登录后重试。',
    );
  }
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new ApiError(
      401,
      '登录已失效或 Access 返回非 JSON 响应，请重新登录。',
    );
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = z
      .object({
        error: z.object({ message: z.string() }),
        requestId: z.string().optional(),
      })
      .safeParse(body);
    const message =
      response.status === 412
        ? '云端版本已变化。请保留本地输入并查看最新版本，不能直接覆盖。'
        : response.status === 401 || response.status === 403
          ? '身份验证失败，请重新登录或检查访问权限。'
          : response.status === 429
            ? '请求过于频繁，请稍后手动重试。'
            : error.success
              ? error.data.error.message
              : '服务暂时不可用，请重试。';
    throw new ApiError(response.status, message);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new ApiError(0, 'API 响应与共享契约不一致；请保留输入并联系维护者。');
  return parsed.data;
}
export const versionHeaders = (version: number) => ({
  'If-Match': `"${version}"`,
});
export async function invalidateWorkouts(client: QueryClient) {
  await Promise.all(
    ['workouts', 'workout', 'stats', 'summary', 'trends', 'metadata'].map(
      (key) => client.invalidateQueries({ queryKey: [key] }),
    ),
  );
}
export const emptySet = (): StrengthSetInput => ({
  id: crypto.randomUUID(),
  setType: 'working',
  completed: false,
  reps: null,
  durationSeconds: null,
  loadKg: null,
  assistanceKg: null,
  effortType: null,
  effortValue: null,
  notes: null,
});
export const copySet = (set: StrengthSetInput): StrengthSetInput => ({
  ...set,
  id: crypto.randomUUID(),
  completed: false,
});
export function newWorkout(): WorkoutInput {
  return {
    startedAt: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    status: 'draft',
    durationSeconds: null,
    notes: null,
    entries: [],
  };
}
export function toInput(workout: Workout): WorkoutInput {
  return {
    startedAt: workout.startedAt,
    timezone: workout.timezone,
    status: workout.status,
    durationSeconds: workout.durationSeconds,
    notes: workout.notes,
    entries: workout.entries.map((entry) => ({
      id: entry.id,
      exerciseId: entry.exerciseId,
      notes: entry.notes,
      ...(entry.kind === 'strength'
        ? {
            kind: 'strength' as const,
            sets: entry.sets.map((set) => ({
              id: set.id,
              setType: set.setType,
              completed: set.completed,
              reps: set.reps,
              durationSeconds: set.durationSeconds,
              loadKg: set.loadKg,
              assistanceKg: set.assistanceKg,
              effortType: set.effortType,
              effortValue: set.effortValue,
              notes: set.notes,
            })),
          }
        : { kind: 'cardio' as const, cardio: { ...entry.cardio } }),
    })),
  };
}
export function copyWorkout(workout: Workout): WorkoutInput {
  const input = toInput(workout);
  return {
    ...input,
    startedAt: new Date().toISOString(),
    status: 'draft',
    entries: input.entries.map((entry) => ({
      ...entry,
      id: crypto.randomUUID(),
      ...(entry.kind === 'strength'
        ? { sets: entry.sets.map(copySet) }
        : { cardio: { ...entry.cardio, completed: false } }),
    })),
  };
}
export function projectMeasurement(value: z.infer<typeof measurementSchema>) {
  return {
    measurementMode: value.measurementMode,
    resistanceMode: value.resistanceMode,
    loadConvention: value.loadConvention,
    repConvention: value.repConvention,
    volumeMultiplier: value.volumeMultiplier,
  };
}
export const entryInfoSchema = z.object({
  name: z.string(),
  measurement: z.union([
    measurementSchema,
    exerciseSchema.transform(projectMeasurement),
  ]),
});
export type EntryInfo = z.infer<typeof entryInfoSchema>;
// Recovery accepts incomplete/invalid scalar input so a failed validation never destroys editing work.
const draftSchema = z.object({
  savedAt: z.number(),
  baseVersion: z.number().nullable(),
  key: z.string().uuid(),
  input: z.unknown(),
  info: z.record(z.string(), entryInfoSchema),
  pending: z
    .object({ key: z.string().uuid(), input: workoutInputSchema })
    .nullable(),
});
export type Draft = Omit<z.infer<typeof draftSchema>, 'input'> & {
  input: WorkoutInput;
};
const prefix = 'healthworker.draft.';
// Each browser document owns independent keys. Reload recovery is explicit via list;
// no sessionStorage ID is cloned by a duplicated tab and no cross-tab lock is needed.
const instance = crypto.randomUUID();
export const ownedDraftKey = (resource: string, owner = instance) =>
  `${resource}.${owner}`;
export function listDrafts(
  resource: string,
): { key: string; savedAt: number }[] {
  try {
    return Object.keys(localStorage)
      .filter(
        (key) =>
          key === prefix + resource || key.startsWith(prefix + resource + '.'),
      )
      .map((key) => {
        try {
          const value: unknown = JSON.parse(localStorage.getItem(key)!);
          const parsed = z.object({ savedAt: z.number() }).parse(value);
          return { key: key.slice(prefix.length), savedAt: parsed.savedAt };
        } catch {
          return { key: key.slice(prefix.length), savedAt: 0 };
        }
      })
      .sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}
export function writeDraft(id: string, draft: Draft) {
  localStorage.setItem(prefix + ownedDraftKey(id), JSON.stringify(draft));
}
export function readRecoveryDraft(key: string): Draft | null {
  return decodeDraft(localStorage.getItem(prefix + key));
}
export function readDraft(id: string): Draft | null {
  return decodeDraft(localStorage.getItem(prefix + ownedDraftKey(id)));
}
function decodeDraft(raw: string | null): Draft | null {
  if (!raw) return null;
  const parsed = draftSchema.parse(JSON.parse(raw));
  // Recovery checks safe types only; submission owns business bounds and refinements.
  const number = z.number().finite().nullable();
  const notes = z.string().nullable();
  const base = { id: z.string().uuid(), exerciseId: z.string().uuid(), notes };
  const recoveryInput = z.object({
    startedAt: z.string(),
    timezone: z.string(),
    status: z.enum(['draft', 'completed']),
    durationSeconds: number,
    notes,
    entries: z.array(
      z.discriminatedUnion('kind', [
        z.object({
          ...base,
          kind: z.literal('strength'),
          sets: z.array(
            z.object({
              id: z.string().uuid(),
              setType: z.enum(['warmup', 'working']),
              completed: z.boolean(),
              reps: number,
              durationSeconds: number,
              loadKg: number,
              assistanceKg: number,
              effortType: z.enum(['rpe', 'rir']).nullable(),
              effortValue: number,
              notes,
            }),
          ),
        }),
        z.object({
          ...base,
          kind: z.literal('cardio'),
          cardio: z.object({
            completed: z.boolean(),
            durationBasis: z.enum(['elapsed', 'moving']),
            durationSeconds: number,
            distanceMeters: number,
            averageHeartRate: number,
            maxHeartRate: number,
            elevationGainMeters: number,
            inclinePercent: number,
            resistanceLevel: number,
            deviceCaloriesKcal: number,
          }),
        }),
      ]),
    ),
  });
  const shape = recoveryInput.safeParse(parsed.input);
  if (!shape.success)
    throw new Error('草稿格式损坏或包含未通过校验的数据，请清理后重新录入。');
  return { ...parsed, input: shape.data };
}
export function removeDraft(id: string) {
  localStorage.removeItem(prefix + ownedDraftKey(id));
}
export function clearDrafts() {
  Object.keys(localStorage)
    .filter((key) => key.startsWith(prefix))
    .forEach((key) => localStorage.removeItem(key));
}
export const draftExpired = (draft: Draft) =>
  draft.baseVersion === null && Date.now() - draft.savedAt > 30 * 86400000;
export function infoFromWorkout(workout: Workout): Record<string, EntryInfo> {
  return Object.fromEntries(
    workout.entries.map((e) => [
      e.id,
      { name: e.exerciseNameSnapshot, measurement: e.measurementSnapshot },
    ]),
  );
}
