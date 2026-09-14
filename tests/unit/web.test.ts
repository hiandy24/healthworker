import { ownedDraftKey } from '../../src/web/lib';
// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { z } from 'zod';
import { WorkoutEditorPage } from '../../src/web/Workouts';
import {
  api,
  ApiError,
  clearDrafts,
  copySet,
  copyWorkout,
  draftExpired,
  emptySet,
  newWorkout,
  readDraft,
  toInput,
  versionHeaders,
  writeDraft,
} from '../../src/web/lib';
import type { Workout } from '../../src/shared/workouts';
const id = '11111111-1111-4111-8111-111111111111';
const measurement = {
  measurementMode: 'reps' as const,
  resistanceMode: 'external' as const,
  loadConvention: 'total' as const,
  repConvention: 'total' as const,
  volumeMultiplier: 1,
};
const workout: Workout = {
  ...newWorkout(),
  id,
  localDate: '2026-09-13',
  status: 'completed',
  version: 3,
  createdAt: '2026-09-13T00:00:00.000Z',
  updatedAt: '2026-09-13T00:00:00.000Z',
  entryCount: 2,
  kinds: ['strength', 'cardio'],
  entries: [
    {
      id: crypto.randomUUID(),
      exerciseId: id,
      position: 0,
      notes: null,
      kind: 'strength',
      exerciseNameSnapshot: '合成深蹲',
      measurementSnapshot: measurement,
      sets: [
        { ...emptySet(), completed: true, reps: 5, loadKg: 0, position: 0 },
      ],
    },
    {
      id: crypto.randomUUID(),
      exerciseId: id,
      position: 1,
      notes: null,
      kind: 'cardio',
      exerciseNameSnapshot: '合成跑步',
      measurementSnapshot: {
        ...measurement,
        measurementMode: 'cardio',
        resistanceMode: null,
        loadConvention: 'none',
        repConvention: 'not_applicable',
        volumeMultiplier: null,
      },
      cardio: {
        completed: true,
        durationSeconds: 60,
        durationBasis: 'elapsed',
        distanceMeters: null,
        averageHeartRate: null,
        maxHeartRate: null,
        elevationGainMeters: null,
        inclinePercent: null,
        resistanceLevel: null,
        deviceCaloriesKcal: null,
      },
    },
  ],
};
function editor() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(['settings'], {
    data: { timezone: 'UTC', createdAt: '2026-01-01T00:00:00Z' },
  });
  return render(
    createElement(
      MantineProvider,
      {},
      createElement(
        QueryClientProvider,
        { client },
        createElement(MemoryRouter, {}, createElement(WorkoutEditorPage)),
      ),
    ),
  );
}
beforeEach(() => {
  clearDrafts();
  localStorage.clear();
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('frontend safety helpers', () => {
  it('copies sets and history without inheriting completion or ids', () => {
    const set = workout.entries[0];
    if (set?.kind !== 'strength') throw new Error();
    const copied = copySet(set.sets[0]!);
    expect(copied.completed).toBe(false);
    expect(copied.id).not.toBe(set.sets[0]!.id);
    expect(copied.loadKg).toBe(0);
    const copy = copyWorkout(workout);
    expect(copy.status).toBe('draft');
    expect(copy.entries[0]!.id).not.toBe(set.id);
    for (const e of copy.entries)
      expect(
        e.kind === 'strength'
          ? e.sets.every((s) => !s.completed)
          : !e.cardio.completed,
      ).toBe(true);
    expect(JSON.stringify(toInput(workout))).not.toContain('Snapshot');
    expect(JSON.stringify(toInput(workout))).not.toContain('position');
  });
  it('persists a stable pending request and cleans only application drafts', () => {
    const input = newWorkout();
    const key = crypto.randomUUID();
    writeDraft('new', {
      input,
      key,
      pending: { input, key },
      info: {},
      baseVersion: null,
      savedAt: Date.now(),
    });
    expect(readDraft('new')?.pending?.key).toBe(key);
    localStorage.setItem('unrelated', 'keep');
    clearDrafts();
    expect(readDraft('new')).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('keep');
    expect(versionHeaders(3)).toEqual({ 'If-Match': '"3"' });
  });
  it('detects damaged and expired drafts without deleting them silently', () => {
    localStorage.setItem(
      `healthworker.draft.${ownedDraftKey('new')}`,
      '{broken',
    );
    expect(() => readDraft('new')).toThrow();
    expect(
      localStorage.getItem(`healthworker.draft.${ownedDraftKey('new')}`),
    ).toBe('{broken');
    const d = {
      input: newWorkout(),
      key: crypto.randomUUID(),
      pending: null,
      info: {},
      baseVersion: null,
      savedAt: Date.now() - 31 * 86400000,
    };
    expect(draftExpired(d)).toBe(true);
    expect(draftExpired({ ...d, baseVersion: 2 })).toBe(false);
  });
  it('rejects Access HTML, version conflict and incompatible success contracts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<html>login</html>', {
          headers: { 'Content-Type': 'text/html' },
        }),
      ),
    );
    await expect(
      api('/workouts', z.object({ data: z.string() })),
    ).rejects.toMatchObject({ status: 401 });
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'conflict' } }), {
        status: 412,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(api('/workouts', z.unknown())).rejects.toBeInstanceOf(
      ApiError,
    );
    vi.mocked(fetch).mockResolvedValue(
      new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
    );
    await expect(
      api('/workouts', z.object({ data: z.string() })),
    ).rejects.toThrow('共享契约');
  });
});
describe('Mantine workout editor', () => {
  it('validates completion, keeps input and never posts an empty completed workout', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    editor();
    fireEvent.change(screen.getByLabelText('训练备注'), {
      target: { value: '合成备注' },
    });
    fireEvent.click(screen.getByRole('button', { name: '完成并保存训练' }));
    expect(await screen.findByText(/完成训练至少包含一个动作/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    await waitFor(() => expect(readDraft('new')?.input.notes).toBe('合成备注'));
  });
  it('freezes uncertain submission and replays identical body and key after network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', fetchMock);
    editor();
    fireEvent.click(screen.getByRole('button', { name: '保存云端草稿' }));
    await screen.findByText(/网络中断或登录跳转/);
    const first = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(
      screen.getByLabelText('训练备注').closest('fieldset')?.disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '重试原提交' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const second = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(second.body).toBe(first.body);
    expect(second.headers).toEqual(first.headers);
    expect(readDraft('new')?.pending).not.toBeNull();
  });
  it('offers explicit recovery instead of overwriting a local draft', async () => {
    const input = { ...newWorkout(), notes: '待恢复合成输入' };
    writeDraft('new', {
      input,
      key: crypto.randomUUID(),
      pending: null,
      info: {},
      baseVersion: null,
      savedAt: Date.now(),
    });
    editor();
    expect(screen.getByText('发现本地未同步草稿')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '恢复本地草稿' }));
    await waitFor(() =>
      expect(
        (screen.getByLabelText('训练备注') as HTMLTextAreaElement).value,
      ).toBe('待恢复合成输入'),
    );
  });
});
