import { env, applyD1Migrations, SELF } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import type { Bindings } from '../../src/worker/auth';
import type { Exercise } from '../../src/shared/exercises';
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
      ...(version === undefined ? {} : { 'If-Match': `"${version}"` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const input = {
  name: 'Synthetic same name',
  aliases: ['Synthetic alias'],
  kind: 'strength',
  equipment: null,
  muscleGroups: [],
  measurementMode: 'reps',
  resistanceMode: 'external',
  loadConvention: 'total',
  repConvention: 'total',
  volumeMultiplier: 1,
  cardioCategory: null,
};
async function create() {
  const response = await request('/api/v1/exercises', 'POST', input);
  expect(response.status).toBe(201);
  return ((await response.json()) as { data: Exercise }).data;
}
it('uses atomic exercise CAS under real simultaneous clients and protects semantic fields', async () => {
  const exercise = await create();
  const path = `/api/v1/exercises/${exercise.id}`;
  expect(
    (await request(path, 'PATCH', { name: 'Synthetic edited' })).status,
  ).toBe(428);
  const results = await Promise.all([
    request(path, 'PATCH', { name: 'Synthetic A' }, 1),
    request(path, 'PATCH', { name: 'Synthetic B' }, 1),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
  const row = await bindings.DB.prepare(
    'SELECT version,name FROM exercises WHERE id=?',
  )
    .bind(exercise.id)
    .first<{ version: number; name: string }>();
  expect(row?.version).toBe(2);
  expect(['Synthetic A', 'Synthetic B']).toContain(row?.name);
  expect(
    (await request(path, 'PATCH', { measurementMode: 'duration' }, 2)).status,
  ).toBe(422);
});
it('supports stable tied-name cursor pages, filter binding, archive and shared agent reads', async () => {
  const created = await Promise.all([create(), create(), create()]);
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const response = await request(
      `/api/agent/v1/exercises?query=Synthetic%20same%20name&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      data: Exercise[];
      meta: { nextCursor: string | null };
    };
    ids.push(...page.data.map((e) => e.id));
    cursor = page.meta.nextCursor;
    if (cursor)
      expect(
        (
          await request(
            `/api/v1/exercises?query=different&cursor=${encodeURIComponent(cursor)}`,
          )
        ).status,
      ).toBe(400);
  } while (cursor);
  expect(ids).toEqual(created.map((e) => e.id).sort());
  const exercise = created[0]!;
  expect(
    (
      await request(
        `/api/v1/exercises/${exercise.id}`,
        'PATCH',
        { archived: true },
        1,
      )
    ).status,
  ).toBe(200);
  const list = (await (
    await request('/api/v1/exercises?query=Synthetic%20same%20name')
  ).json()) as { data: Exercise[] };
  expect(list.data.some((e) => e.id === exercise.id)).toBe(false);
  const all = (await (
    await request('/api/agent/v1/exercises?includeArchived=true')
  ).json()) as { data: Exercise[] };
  const archived = all.data.find((e) => e.id === exercise.id);
  expect(archived).toBeDefined();
  expect(archived!.archivedAt).toEqual(expect.any(String));
  expect((await request('/api/agent/v1/exercises', 'POST', input)).status).toBe(
    405,
  );
});
it('rejects unknown creation fields and inconsistent measurement modes', async () => {
  for (const patch of [
    { isBuiltin: true },
    { volumeMultiplier: -1 },
    { kind: 'cardio' },
    { measurementMode: 'duration' },
  ])
    expect(
      (await request('/api/v1/exercises', 'POST', { ...input, ...patch }))
        .status,
    ).toBe(422);
});

it('returns query/param 400, business JSON 422 and matching OpenAPI statuses', async () => {
  for (const prefix of ['/api/v1', '/api/agent/v1']) {
    for (const query of [
      'limit=101',
      'kind=no',
      'unknown=1',
      'includeArchived=maybe',
    ]) {
      const r = await request(`${prefix}/exercises?${query}`);
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({
        error: { code: 'VALIDATION_ERROR' },
      });
    }
    const doc = (await (await request(`${prefix}/openapi.json`)).json()) as {
      paths: Record<string, { get?: { responses: Record<string, unknown> } }>;
    };
    expect(doc.paths['/exercises']?.get?.responses).toHaveProperty('400');
    expect(doc.paths['/exercises']?.get?.responses).not.toHaveProperty('422');
  }
  expect(
    (await request('/api/v1/exercises/no', 'PATCH', { archived: true }, 1))
      .status,
  ).toBe(400);
  expect(
    (
      await request('/api/v1/exercises', 'POST', {
        ...input,
        volumeMultiplier: 1e308,
      })
    ).status,
  ).toBe(422);
});
