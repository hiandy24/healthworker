// @vitest-environment jsdom
import { createElement } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Overview, statValue } from '../../src/web/Stats';
const totals = {
  workoutCount: 0,
  recordedDurationWorkoutCount: 0,
  durationSeconds: 0,
  durationCoverage: null,
  strengthWorkoutCount: 0,
  cardioWorkoutCount: 0,
  cardioDurationSeconds: 0,
};
beforeEach(() => {
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
it('distinguishes actual zero from missing statistical measurements', () => {
  expect(statValue(0)).toBe('0');
  expect(statValue(null)).toContain('无有效样本');
});
it('renders server range, samples, exclusions, and accessible empty summary without fake charts', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            definitionsVersion: '1',
            dateBasis: 'workout_local_date',
            from: '2026-08-17',
            to: '2026-09-14',
            status: 'completed',
            warmup: 'not_applicable',
            granularity: 'week',
            totals,
            buckets: [],
            cardioByCategory: [],
            quality: {
              validSamples: 0,
              missing: { workoutDuration: 0, cardioDistance: 0 },
              excluded: { draftWorkouts: 2 },
            },
          },
          meta: { requestId: 'synthetic-test' },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    ),
  );
  render(
    createElement(
      MantineProvider,
      {},
      createElement(
        QueryClientProvider,
        {
          client: new QueryClient({
            defaultOptions: { queries: { retry: false } },
          }),
        },
        createElement(MemoryRouter, {}, createElement(Overview)),
      ),
    ),
  );
  expect(await screen.findByText(/2026-08-17 ≤ 训练本地日期/)).toBeTruthy();
  expect(screen.getByText(/草稿训练: 2/)).toBeTruthy();
  expect(screen.getByText('无训练样本')).toBeTruthy();
  expect(screen.getByText('没有有效记录')).toBeTruthy();
  expect(screen.getAllByRole('table').length).toBe(2);
  expect(screen.queryByRole('img')).toBeNull();
});
