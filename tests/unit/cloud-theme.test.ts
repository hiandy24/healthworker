// @vitest-environment jsdom
import { createElement } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
  act,
} from '@testing-library/react';
import { MantineProvider, useMantineColorScheme } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CloudTheme } from '../../src/web/CloudTheme';
import { Settings } from '../../src/web/Settings';
import { Context } from '../../src/web/Stats';
import { qualityLabels } from '../../src/shared/stats';
function Probe() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  return createElement(
    'button',
    { onClick: () => setColorScheme('light'), 'data-testid': 'scheme' },
    colorScheme,
  );
}
function mount(settings = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  render(
    createElement(
      MantineProvider,
      { defaultColorScheme: 'light', env: 'test' },
      createElement(
        QueryClientProvider,
        { client },
        createElement(CloudTheme),
        createElement(Probe),
        settings && createElement(Settings),
      ),
    ),
  );
  return client;
}
const response = (theme: string, version = 1) => ({
  data: {
    id: 'singleton',
    timezone: 'UTC',
    locale: 'zh-CN',
    unitSystem: 'metric',
    theme,
    version,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  meta: { requestId: 'synthetic' },
});
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: true,
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
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it.each(['dark', 'auto', 'light'])(
  'hydrates new client from cloud %s and does not override local choice on refetch',
  async (theme) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(response(theme))),
    );
    const client = mount();
    await waitFor(() =>
      expect(screen.getByTestId('scheme').textContent).toBe(theme),
    );
    if (theme === 'auto')
      expect(
        document.documentElement.getAttribute('data-mantine-color-scheme'),
      ).toBe('dark');
    fireEvent.click(screen.getByTestId('scheme'));
    await act(async () => {
      await client.refetchQueries({ queryKey: ['settings'] });
    });
    expect(screen.getByTestId('scheme').textContent).toBe('light');
  },
);
it('does not reset a selected theme on loading/error and can hydrate after successful retry', async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetcher);
  const client = mount();
  await waitFor(() =>
    expect(client.getQueryState(['settings'])?.status).toBe('error'),
  );
  expect(screen.getByTestId('scheme').textContent).toBe('light');
  fetcher.mockImplementation(async () => Response.json(response('dark')));
  await act(async () => {
    await client.refetchQueries({ queryKey: ['settings'] });
  });
  await waitFor(() =>
    expect(screen.getByTestId('scheme').textContent).toBe('dark'),
  );
  fetcher.mockRejectedValue(new Error('offline'));
  await act(async () => {
    await client.refetchQueries({ queryKey: ['settings'] });
  });
  expect(screen.getByTestId('scheme').textContent).toBe('dark');
});
it('settings edits apply only after successful save and use shared query', async () => {
  let cloud = response('dark');
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH')
      cloud = response(JSON.parse(init.body as string).theme, 2);
    return Response.json(cloud);
  });
  vi.stubGlobal('fetch', fetcher);
  mount(true);
  await waitFor(() =>
    expect(screen.getByTestId('scheme').textContent).toBe('dark'),
  );
  fireEvent.click(screen.getByRole('textbox', { name: '云端主题' }));
  fireEvent.click(await screen.findByRole('option', { name: '跟随系统' }));
  expect(screen.getByTestId('scheme').textContent).toBe('dark');
  fireEvent.click(screen.getByRole('button', { name: '确认并保存默认设置' }));
  await waitFor(() =>
    expect(screen.getByTestId('scheme').textContent).toBe('auto'),
  );
  expect(cloud.data.theme).toBe('auto');
});
it('renders every actual quality key in Chinese rather than raw API identifiers', () => {
  const counts = Object.fromEntries(
    Object.keys(qualityLabels).map((k) => [k, 1]),
  );
  render(
    createElement(
      MantineProvider,
      {},
      createElement(Context, {
        data: {
          from: '2026-01-01',
          to: '2026-01-02',
          warmup: 'exclude',
          definitionsVersion: '1',
          quality: { validSamples: 1, missing: counts, excluded: counts },
        },
      }),
    ),
  );
  for (const [key, label] of Object.entries(qualityLabels)) {
    expect(document.body.textContent).toContain(`${label}: 1`);
    expect(document.body.textContent).not.toContain(`${key}: 1`);
  }
});
