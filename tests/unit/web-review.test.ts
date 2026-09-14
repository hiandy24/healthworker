import { ownedDraftKey } from '../../src/web/lib';
// @vitest-environment jsdom
import { createElement } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider, Link } from 'react-router-dom';
import { NavigationGuard } from '../../src/web/NavigationGuard';
import { ExerciseLibrary } from '../../src/web/Exercises';
import { WorkoutEditorPage } from '../../src/web/Workouts';
import { localTimeCandidates } from '../../src/web/localTime';
import {
  clearDrafts,
  readDraft,
  writeDraft,
  projectMeasurement,
  newWorkout,
  emptySet,
  type Draft,
} from '../../src/web/lib';
import type { Exercise } from '../../src/shared/exercises';
const exercise: Exercise = {
  id: crypto.randomUUID(),
  name: '合成深蹲',
  aliases: [],
  equipment: null,
  muscleGroups: [],
  kind: 'strength',
  measurementMode: 'reps',
  resistanceMode: 'external',
  loadConvention: 'total',
  repConvention: 'total',
  volumeMultiplier: 1,
  isBuiltin: false,
  archivedAt: null,
  version: 1,
  createdAt: '2026-09-13T00:00:00Z',
  updatedAt: '2026-09-13T00:00:00Z',
  cardioCategory: null,
};
function draft(): Draft {
  const entry = {
    id: crypto.randomUUID(),
    exerciseId: exercise.id,
    notes: null,
    kind: 'strength' as const,
    sets: [emptySet()],
  };
  return {
    input: { ...newWorkout(), entries: [entry] },
    info: {
      [entry.id]: {
        name: exercise.name,
        measurement: projectMeasurement(exercise),
      },
    },
    key: crypto.randomUUID(),
    baseVersion: null,
    pending: null,
    savedAt: Date.now(),
  };
}
function mount(element: React.ReactNode, other?: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(['settings'], {
    data: { timezone: 'UTC', createdAt: '2026-01-01T00:00:00Z' },
  });
  const router = createMemoryRouter([
    { path: '/', element },
    { path: '/other', element: other ?? createElement('p', {}, '目的页面') },
  ]);
  render(
    createElement(
      MantineProvider,
      {},
      createElement(
        ModalsProvider,
        {},
        createElement(
          QueryClientProvider,
          {
            client,
          },
          createElement(RouterProvider, { router }),
        ),
      ),
    ),
  );
  return router;
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
it('P1 projects five measurement fields and migrates only known legacy Exercise snapshots', () => {
  const d = draft();
  expect(Object.keys(projectMeasurement(exercise))).toHaveLength(5);
  writeDraft('new', d);
  expect(readDraft('new')?.info).toEqual(d.info);
  const entryId = d.input.entries[0]!.id;
  localStorage.setItem(
    `healthworker.draft.${ownedDraftKey('new')}`,
    JSON.stringify({
      ...d,
      info: { [entryId]: { name: exercise.name, measurement: exercise } },
    }),
  );
  expect(
    Object.keys(readDraft('new')!.info[entryId]!.measurement),
  ).toHaveLength(5);
  localStorage.setItem(
    `healthworker.draft.${ownedDraftKey('new')}`,
    JSON.stringify({
      ...d,
      info: {
        [entryId]: { name: 'bad', measurement: { ...exercise, rogue: true } },
      },
    }),
  );
  expect(() => readDraft('new')).toThrow();
});
it('P1 interleaved independent instances cannot overwrite or delete each other', async () => {
  const a = await import('../../src/web/lib');
  vi.resetModules();
  const b = await import('../../src/web/lib');
  expect(a.ownedDraftKey('new')).not.toBe(b.ownedDraftKey('new'));
  const da = draft(),
    db = draft();
  await Promise.all([
    Promise.resolve().then(() => a.writeDraft('new', da)),
    Promise.resolve().then(() => b.writeDraft('new', db)),
  ]);
  expect(a.readDraft('new')?.key).toBe(da.key);
  expect(b.readDraft('new')?.key).toBe(db.key);
  a.removeDraft('new');
  expect(b.readDraft('new')?.key).toBe(db.key);
  expect(b.listDrafts('new')).toHaveLength(1);
});
it('P2 restores finite intermediate values beyond business limits', () => {
  const d = draft();
  const entry = d.input.entries[0]!;
  if (entry.kind !== 'strength') throw new Error();
  entry.sets[0]!.loadKg = 10001;
  entry.sets[0]!.effortValue = 100;
  entry.sets[0]!.notes = 'x'.repeat(4001);
  writeDraft('new', d);
  const restored = readDraft('new')!.input.entries[0]!;
  expect(restored.kind === 'strength' && restored.sets[0]!.loadKg).toBe(10001);
});
it('P2 editing output Exercise submits only permitted PATCH fields and If-Match', async () => {
  const mock = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
    Promise.resolve(
      new Response(
        JSON.stringify(
          init?.method === 'PATCH'
            ? { data: exercise, meta: { requestId: 'test' } }
            : {
                data: [exercise],
                meta: { requestId: 'test', nextCursor: null },
              },
        ),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    ),
  );
  vi.stubGlobal('fetch', mock);
  mount(createElement(ExerciseLibrary));
  fireEvent.click(await screen.findByRole('button', { name: '编辑展示信息' }));
  fireEvent.change(await screen.findByLabelText(/动作名称/), {
    target: { value: '更新名称' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存动作' }));
  await waitFor(() =>
    expect(
      mock.mock.calls.some((c) => (c[1] as RequestInit).method === 'PATCH'),
    ).toBe(true),
  );
  const request = mock.mock.calls.find(
    (c) => (c[1] as RequestInit).method === 'PATCH',
  )![1] as RequestInit;
  expect(JSON.parse(request.body as string)).toEqual({
    name: '更新名称',
    aliases: [],
    equipment: null,
    muscleGroups: [],
  });
  expect(new Headers(request.headers).get('If-Match')).toBe('"1"');
});
it('P2 SPA navigation is blocked with Mantine cancel and explicit proceed', async () => {
  const component = createElement(
    'div',
    {},
    createElement(NavigationGuard, { enabled: true }),
    createElement(Link, { to: '/other' }, '离开编辑'),
  );
  const router = mount(component);
  fireEvent.click(screen.getByText('离开编辑'));
  await screen.findByRole('button', { name: '取消' });
  expect(router.state.location.pathname).toBe('/');
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull(),
  );
  fireEvent.click(screen.getByText('离开编辑'));
  fireEvent.click(await screen.findByRole('button', { name: '确认继续' }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/other'));
});
it('P2 comma aliases errors are visible and focusable rather than silent submit failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [],
          meta: { requestId: 'test', nextCursor: null },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    ),
  );
  mount(createElement(ExerciseLibrary));
  fireEvent.click(screen.getByRole('button', { name: '创建动作' }));
  fireEvent.change(await screen.findByLabelText(/动作名称/), {
    target: { value: '合成动作' },
  });
  fireEvent.change(screen.getByLabelText('别名（逗号分隔）'), {
    target: { value: 'a,' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存动作' }));
  await waitFor(() =>
    expect(
      screen.getByLabelText('别名（逗号分隔）').getAttribute('aria-invalid'),
    ).toBe('true'),
  );
  expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
});
it('P2 DST spring gap rejected and autumn repeat exposes both explicit offsets', () => {
  expect(() =>
    localTimeCandidates('2026-03-08 02:30:00', 'America/New_York'),
  ).toThrow(/不存在/);
  expect(
    localTimeCandidates('2026-11-01 01:30:00', 'America/New_York'),
  ).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
});
it('P1 submission writes only the current instance and preserves other drafts', async () => {
  const mock = vi.fn().mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', mock);
  const other = 'healthworker.draft.new.other-document';
  const raw = JSON.stringify(draft());
  localStorage.setItem(other, raw);
  mount(createElement(WorkoutEditorPage));
  fireEvent.click(screen.getByRole('button', { name: '保存云端草稿' }));
  await waitFor(() => expect(mock).toHaveBeenCalled());
  expect(localStorage.getItem(other)).toBe(raw);
});

it('session review oversized Chinese draft stays editable with input preserved before pending state', async () => {
  const d = draft();
  const entry = d.input.entries[0]!;
  if (entry.kind !== 'strength') throw new Error();
  // One entry with 50 legal Chinese notes exceeds UTF8 limit.
  d.input.entries = Array.from({ length: 1 }, () => ({
    ...entry,
    id: crypto.randomUUID(),
    sets: Array.from({ length: 50 }, () => ({
      ...emptySet(),
      notes: '中'.repeat(4000),
    })),
  }));
  d.info = Object.fromEntries(
    d.input.entries.map((e) => [
      e.id,
      { name: exercise.name, measurement: projectMeasurement(exercise) },
    ]),
  );
  writeDraft('new', d);
  const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetcher);
  mount(createElement(WorkoutEditorPage));
  fireEvent.click(await screen.findByRole('button', { name: '恢复本地草稿' }));
  fireEvent.click(screen.getByRole('button', { name: '保存云端草稿' }));
  await screen.findByText(/提交内容超过 512 KiB/);
  expect(screen.queryByRole('button', { name: '重试原提交' })).toBeNull();
  expect(
    fetcher.mock.calls.some(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
    ),
  ).toBe(false);
  expect(readDraft('new')?.input.entries).toEqual(d.input.entries);
  expect(readDraft('new')?.pending).toBeNull();
}, 30000);
