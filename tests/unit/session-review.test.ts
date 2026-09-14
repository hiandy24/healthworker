import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { api, emptySet, newWorkout } from '../../src/web/lib';
import { LIMITS } from '../../src/shared/contracts';
import { workoutInputSchema } from '../../src/shared/workouts';
import { inserts } from '../../src/worker/workouts';
import { qualitySchema, qualityLabels } from '../../src/shared/stats';
afterEach(() => vi.unstubAllGlobals());
it.each(['DELETE', 'POST', 'PUT', 'PATCH'])(
  'sends JSON headers for bodyless %s without synthesizing Origin',
  async (method) => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(headers.get('If-Match')).toBe('"3"');
      expect(headers.has('Origin')).toBe(false);
      expect(init?.body).toBeUndefined();
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetcher);
    await api('/workouts/synthetic', z.object({ ok: z.boolean() }), {
      method,
      headers: new Headers({ 'If-Match': '"3"' }),
    });
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
it('rejects UTF8 oversized valid maximum workout before fetch without mutating input; exact byte limit passes', async () => {
  const fetcher = vi.fn(async () => Response.json({}));
  vi.stubGlobal('fetch', fetcher);
  const input = workoutInputSchema.parse({
    ...newWorkout(),
    entries: Array.from({ length: 50 }, () => ({
      id: crypto.randomUUID(),
      exerciseId: crypto.randomUUID(),
      kind: 'strength',
      notes: null,
      sets: Array.from({ length: 6 }, () => ({
        ...emptySet(),
        notes: '中'.repeat(4000),
      })),
    })),
  });
  const body = JSON.stringify(input);
  await expect(
    api('/workouts', z.object({}), { method: 'POST', body }),
  ).rejects.toMatchObject({
    status: 413,
    message: expect.stringContaining('输入已保留'),
  });
  expect(JSON.stringify(input)).toBe(body);
  expect(fetcher).not.toHaveBeenCalled();
  await api('/workouts', z.object({}), {
    method: 'POST',
    body: ' '.repeat(LIMITS.bodyBytes),
  });
  expect(fetcher).toHaveBeenCalledOnce();
});
it.each([0, 101])(
  'rejects unsupported insert width %i before preparing SQL',
  (width) => {
    const prepare = vi.fn();
    expect(() =>
      inserts({ prepare } as unknown as D1Database, 'internal_table', [
        Object.fromEntries(
          Array.from({ length: width }, (_, i) => [`c${i}`, i]),
        ),
      ]),
    ).toThrow('Unsupported D1 insert column count');
    expect(prepare).not.toHaveBeenCalled();
  },
);
it('quality schema accepts every documented Chinese key and refuses drift', () => {
  for (const [key, label] of Object.entries(qualityLabels)) {
    expect(label).toMatch(/[\u4e00-\u9fff]/);
    expect(
      qualitySchema.safeParse({
        validSamples: 0,
        missing: { [key]: 1 },
        excluded: {},
      }).success,
    ).toBe(true);
  }
  expect(
    qualitySchema.safeParse({
      validSamples: 0,
      missing: { typo: 1 },
      excluded: {},
    }).success,
  ).toBe(false);
});
