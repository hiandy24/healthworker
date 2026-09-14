import { env, applyD1Migrations, SELF } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import type { Bindings } from '../../src/worker/auth';
import { settingsResponseSchema } from '../../src/shared/settings';
import { backupSchema } from '../../src/shared/backup';
import { saveWorkout } from '../../src/worker/workouts';
import { exportBackup, backupCsv } from '../../src/worker/export';
const bindings = env as unknown as Bindings & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
const request = (
  path: string,
  method = 'GET',
  body?: unknown,
  version?: number,
) =>
  SELF.fetch(`http://127.0.0.1:5173${path}`, {
    method,
    headers: {
      Origin: 'http://127.0.0.1:5173',
      'Content-Type': 'application/json',
      ...(version ? { 'If-Match': `"${version}"` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
it('settings initializes once, validates fixed locale/metric and has one concurrent CAS winner', async () => {
  const initial = settingsResponseSchema.parse(
    await (await request('/api/v1/settings')).json(),
  ).data;
  expect(
    await bindings.DB.prepare('SELECT count(*) n FROM settings').first('n'),
  ).toBe(0);
  expect(
    (await request('/api/v1/settings', 'PATCH', { theme: 'dark' }, 9)).status,
  ).toBe(412);
  expect(
    await bindings.DB.prepare('SELECT count(*) n FROM settings').first('n'),
  ).toBe(0);
  expect(initial).toMatchObject({
    version: 1,
    timezone: 'UTC',
    theme: 'auto',
    locale: 'zh-CN',
    unitSystem: 'metric',
  });
  expect(
    settingsResponseSchema.parse(
      await (await request('/api/v1/settings')).json(),
    ).data,
  ).toEqual(initial);
  expect(
    (await request('/api/v1/settings', 'PATCH', { theme: 'dark' })).status,
  ).toBe(428);
  const pair = await Promise.all([
    request(
      '/api/v1/settings',
      'PATCH',
      { timezone: 'Asia/Shanghai', theme: 'dark' },
      1,
    ),
    request(
      '/api/v1/settings',
      'PATCH',
      { timezone: 'America/New_York', theme: 'light' },
      1,
    ),
  ]);
  expect(pair.map((r) => r.status).sort()).toEqual([200, 412]);
  for (const body of [
    { locale: 'en-US' },
    { unitSystem: 'imperial' },
    { timezone: 'invalid' },
    { version: 7 },
    {},
  ])
    expect((await request('/api/v1/settings', 'PATCH', body, 2)).status).toBe(
      422,
    );
});
it('exports full JSON including drafts/archive/notes/IDs and omits technical credentials, and CSV escapes formulas', async () => {
  const r = await request('/api/v1/exercises', 'POST', {
    name: '=Synthetic,"quoted"\nexercise',
    aliases: [],
    kind: 'strength',
    equipment: null,
    muscleGroups: [],
    measurementMode: 'reps',
    resistanceMode: 'external',
    loadConvention: 'total',
    repConvention: 'total',
    volumeMultiplier: 1,
    cardioCategory: null,
  });
  expect(r.status).toBe(201);
  const id = ((await r.json()) as { data: { id: string } }).data.id;
  const saved = await saveWorkout(
    bindings.DB,
    {
      startedAt: '2026-05-01T12:00:00Z',
      timezone: 'UTC',
      status: 'draft',
      durationSeconds: null,
      notes: '=SUM(1,2)\nSynthetic',
      entries: [
        {
          id: crypto.randomUUID(),
          exerciseId: id,
          kind: 'strength',
          notes: 'Synthetic entry',
          sets: [
            {
              id: crypto.randomUUID(),
              setType: 'working',
              completed: false,
              reps: null,
              durationSeconds: null,
              loadKg: null,
              assistanceKg: null,
              effortType: null,
              effortValue: null,
              notes: '@Synthetic',
            },
          ],
        },
      ],
    },
    {
      key: crypto.randomUUID(),
      principal: 'synthetic',
      requestId: 'synthetic',
    },
  );
  await request(`/api/v1/exercises/${id}`, 'PATCH', { archived: true }, 1);
  const response = await request('/api/v1/export?format=json');
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get('content-disposition')).toContain('attachment');
  const backup = backupSchema.parse(await response.json());
  expect(backup.workouts.find((w) => w.id === saved.data.id)?.notes).toBe(
    '=SUM(1,2)\nSynthetic',
  );
  expect(backup.exercises.find((e) => e.id === id)?.archivedAt).toEqual(
    expect.any(String),
  );
  expect(backup.strengthSets[0]?.loadKg).toBeNull();
  expect(backup.settings?.version).toBe(2);
  expect(backup).not.toHaveProperty('idempotencyKeys');
  expect(JSON.stringify(backup)).not.toContain('principal');
  const csv = backupCsv(backup, 'workouts');
  expect(csv).toContain('"\'=SUM(1,2)\nSynthetic"');
  const sets = await request('/api/v1/export?format=csv&dataset=strengthSets');
  expect(sets.status).toBe(200);
  expect(sets.headers.get('content-type')).toContain('text/csv');
  expect(await sets.text()).toContain("'@Synthetic");
  await request(
    '/api/v1/settings',
    'PATCH',
    { timezone: 'Pacific/Auckland' },
    2,
  );
  expect(
    (await exportBackup(bindings.DB)).workouts.find(
      (w) => w.id === saved.data.id,
    )?.localDate,
  ).toBe('2026-05-01');
});
it('human-only management is absent on Agent and OpenAPI, with safe invalid requests', async () => {
  for (const path of ['/settings', '/export'])
    expect((await request(`/api/agent/v1${path}`)).status).toBe(404);
  const doc = (await (await request('/api/agent/v1/openapi.json')).json()) as {
    paths: Record<string, unknown>;
  };
  expect(doc.paths).not.toHaveProperty('/export');
  expect(doc.paths).not.toHaveProperty('/settings');
  for (const query of [
    'format=xml',
    'format=json&dataset=workouts',
    'format=csv&dataset=bad',
    'includeNotes=true',
  ])
    expect((await request(`/api/v1/export?${query}`)).status).toBe(400);
  const malformed = await SELF.fetch('http://127.0.0.1:5173/api/v1/settings', {
    method: 'PATCH',
    headers: {
      Origin: 'http://127.0.0.1:5173',
      'Content-Type': 'application/json',
      'If-Match': '"3"',
    },
    body: '{bad',
  });
  expect(malformed.status).toBe(400);
});
it('rejects full export over the conservative byte budget rather than returning partial data', async () => {
  const now = '2026-01-01T00:00:00Z';
  await bindings.DB.prepare(
    `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<11000) INSERT INTO workouts(id,started_at,timezone,local_date,created_at,updated_at) SELECT 'synthetic-size-'||i,?,'UTC','2026-01-01',?,? FROM n`,
  )
    .bind(now, now, now)
    .run();
  const response = await request('/api/v1/export');
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({
    error: { code: 'EXPORT_TOO_LARGE' },
  });
  await bindings.DB.prepare(
    "DELETE FROM workouts WHERE id LIKE 'synthetic-size-%'",
  ).run();
});
