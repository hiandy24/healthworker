import { env, applyD1Migrations, SELF } from 'cloudflare:test';
import { beforeAll, expect, it, vi } from 'vitest';
import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { workoutHistoryQuery } from '../../src/web/workoutHistoryQuery';
import type { Bindings } from '../../src/worker/auth';
const b = env as unknown as Bindings & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
beforeAll(async () => {
  await applyD1Migrations(b.DB, b.TEST_MIGRATIONS);
});
it('real client pins first range over UTC midnight, refetch starts fresh and changed filters reject old cursor', async () => {
  const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
  for (const id of ids)
    await b.DB.prepare(
      "INSERT INTO workouts(id,started_at,timezone,local_date,status,created_at,updated_at) VALUES(?,'2032-01-01T12:00:00Z','UTC','2032-01-01','draft','2032-01-01T12:00:00Z','2032-01-01T12:00:00Z')",
    )
      .bind(id)
      .run();
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    urls.push(input);
    return SELF.fetch('http://127.0.0.1:5173' + input, {
      ...init,
      redirect: 'manual',
    });
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  try {
    vi.setSystemTime(new Date('2032-01-01T23:59:59Z'));
    const observer = new InfiniteQueryObserver(
      client,
      workoutHistoryQuery({ limit: '1' }),
    );
    const first = await observer.refetch();
    expect(first.error).toBeNull();
    const meta = first.data!.pages[0]!.meta;
    vi.setSystemTime(new Date('2032-01-02T00:00:01Z'));
    await observer.fetchNextPage();
    const last = await observer.fetchNextPage();
    expect(last.error).toBeNull();
    expect(
      last.data!.pages.flatMap((page) => page.data.map((row) => row.id)),
    ).toEqual([...ids].sort().reverse());
    for (const url of urls.slice(1)) {
      const params = new URL(url, 'http://localhost').searchParams;
      expect(params.get('from')).toBe(meta.from);
      expect(params.get('to')).toBe(meta.to);
    }
    const changed = await SELF.fetch(
      'http://127.0.0.1:5173/api/v1/workouts?' +
        new URLSearchParams({
          from: meta.from,
          to: meta.to,
          status: 'completed',
          cursor: meta.nextCursor!,
        }),
    );
    expect(changed.status).toBe(400);
    const fresh = await observer.refetch();
    expect(fresh.error).toBeNull();
    expect(fresh.data!.pages[0]!.meta.to).toBe('2032-01-03');
    observer.setOptions(workoutHistoryQuery({ status: 'completed' }));
    const filtered = await observer.refetch();
    expect(filtered.data!.pages[0]!.data).toEqual([]);
    expect(
      new URL(urls.at(-1)!, 'http://localhost').searchParams.has('cursor'),
    ).toBe(false);
  } finally {
    client.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const id of ids)
      await b.DB.prepare('DELETE FROM workouts WHERE id=?').bind(id).run();
  }
});
