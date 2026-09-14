import { env, applyD1Migrations, SELF } from 'cloudflare:test';
import { beforeAll, expect, it, vi } from 'vitest';
import type { Bindings } from '../../src/worker/auth';
import {
  workoutResponseSchema,
  workoutListSchema,
  type WorkoutInput,
} from '../../src/shared/workouts';
import { saveWorkout } from '../../src/worker/workouts';
const bindings = env as unknown as Bindings & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
it('rechecks idempotency when another create commits then archives before this create prevalidation', async () => {
  const id = await exercise(),
    body = input(id),
    key = crypto.randomUUID();
  let first = true;
  let winner: Awaited<ReturnType<typeof saveWorkout>> | undefined;
  const options = {
    key,
    principal: 'synthetic-prevalidation-race',
    requestId: 'synthetic',
  };
  const proxy = new Proxy(bindings.DB, {
    get(target, prop) {
      if (prop === 'prepare')
        return (query: string) => {
          const prepared = target.prepare(query);
          if (!query.startsWith('SELECT request_hash,response_body'))
            return prepared;
          return new Proxy(prepared, {
            get(statement, method) {
              if (method === 'bind')
                return (...args: unknown[]) => {
                  const bound = statement.bind(...args);
                  return new Proxy(bound, {
                    get(value, operation) {
                      if (operation === 'first')
                        return async () => {
                          const row = await value.first();
                          if (first) {
                            first = false;
                            winner = await saveWorkout(target, body, options);
                            await target
                              .prepare(
                                'UPDATE exercises SET archived_at=?,version=version+1 WHERE id=?',
                              )
                              .bind(new Date().toISOString(), id)
                              .run();
                          }
                          return row;
                        };
                      const v = Reflect.get(value, operation);
                      return typeof v === 'function' ? v.bind(value) : v;
                    },
                  });
                };
              const v = Reflect.get(statement, method);
              return typeof v === 'function' ? v.bind(statement) : v;
            },
          });
        };
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const replayed = await saveWorkout(proxy, body, options);
  expect(replayed.meta.replayed).toBe(true);
  expect(replayed.data).toEqual(winner?.data);
});
it('rejects unsupported years with write 422/query 400 and preserves 1900 normal roundtrip', async () => {
  const body = input(await exercise());
  for (const year of ['0000', '0099', '1899']) {
    expect(
      (
        await request(
          '/api/v1/workouts',
          'POST',
          { ...body, startedAt: `${year}-06-01T12:00:00Z` },
          undefined,
          crypto.randomUUID(),
        )
      ).status,
    ).toBe(422);
    for (const path of ['/workouts', '/stats/summary', '/stats/cardio'])
      expect(
        (await request(`/api/v1${path}?from=${year}-06-01&to=${year}-06-02`))
          .status,
      ).toBe(400);
  }
  const saved = await create({
    ...body,
    startedAt: '1900-06-01T12:00:00Z',
    timezone: 'UTC',
  });
  expect(saved.data.localDate).toBe('1900-06-01');
  expect(
    workoutResponseSchema.parse(
      await (await request(`/api/v1/workouts/${saved.data.id}`)).json(),
    ).data.localDate,
  ).toBe('1900-06-01');
});
const request = (
  path: string,
  method = 'GET',
  body?: unknown,
  version?: number,
  key?: string,
) =>
  SELF.fetch(`http://127.0.0.1:5173${path}`, {
    method,
    headers: {
      Origin: 'http://127.0.0.1:5173',
      'Content-Type': 'application/json',
      ...(version === undefined ? {} : { 'If-Match': `"${version}"` }),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function exercise(cardio = false) {
  const r = await request('/api/v1/exercises', 'POST', {
    name: 'Synthetic workout exercise',
    aliases: [],
    kind: cardio ? 'cardio' : 'strength',
    equipment: null,
    muscleGroups: [],
    measurementMode: cardio ? 'cardio' : 'reps',
    resistanceMode: cardio ? null : 'external',
    loadConvention: cardio ? 'none' : 'total',
    repConvention: cardio ? 'not_applicable' : 'total',
    volumeMultiplier: cardio ? null : 1,
    cardioCategory: cardio ? 'run' : null,
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { data: { id: string } }).data.id;
}
function input(id: string, count = 1): WorkoutInput {
  return {
    startedAt: '2026-09-12T23:30:00Z',
    timezone: 'Asia/Shanghai',
    status: 'completed',
    durationSeconds: null,
    notes: 'Synthetic parent note',
    entries: Array.from({ length: Math.ceil(count / 50) }, (_, i) => ({
      id: crypto.randomUUID(),
      exerciseId: id,
      kind: 'strength',
      notes: 'Synthetic entry note',
      sets: Array.from({ length: Math.min(50, count - i * 50) }, () => ({
        id: crypto.randomUUID(),
        setType: 'working',
        completed: true,
        reps: 5,
        durationSeconds: null,
        loadKg: 100.001,
        assistanceKg: null,
        effortType: null,
        effortValue: null,
        notes: 'Synthetic set note',
      })),
    })),
  };
}
async function create(body: WorkoutInput, key = crypto.randomUUID()) {
  const r = await request('/api/v1/workouts', 'POST', body, undefined, key);
  expect(r.status, await r.clone().text()).toBe(201);
  return workoutResponseSchema.parse(await r.json());
}
it('atomically saves mixed aggregates, exact grams, timezone, ordered detail and private Agent notes', async () => {
  const body = input(await exercise());
  body.entries.push({
    id: crypto.randomUUID(),
    exerciseId: await exercise(true),
    kind: 'cardio',
    notes: 'Synthetic cardio note',
    cardio: {
      completed: true,
      durationSeconds: 1800,
      durationBasis: 'elapsed',
      distanceMeters: 5000,
      averageHeartRate: null,
      maxHeartRate: null,
      elevationGainMeters: null,
      inclinePercent: null,
      resistanceLevel: null,
      deviceCaloriesKcal: null,
    },
  });
  const saved = await create(body);
  const detail = await request(`/api/v1/workouts/${saved.data.id}`);
  expect(detail.headers.get('etag')).toBe('"1"');
  expect(workoutResponseSchema.parse(await detail.json()).data).toEqual(
    saved.data,
  );
  expect(saved.data.localDate).toBe('2026-09-13');
  expect(saved.data.kinds).toEqual(['strength', 'cardio']);
  const agent = workoutResponseSchema.parse(
    await (await request(`/api/agent/v1/workouts/${saved.data.id}`)).json(),
  );
  expect(JSON.stringify(agent)).not.toContain('Synthetic parent note');
  expect(JSON.stringify(agent)).not.toContain('Synthetic set note');
  expect(agent.data.notes).toBeNull();
  expect(
    workoutResponseSchema.parse(
      await (
        await request(
          `/api/agent/v1/workouts/${saved.data.id}?includeNotes=true`,
        )
      ).json(),
    ).data,
  ).toEqual(saved.data);
  for (const kind of ['strength', 'cardio']) {
    const page = workoutListSchema.parse(
      await (
        await request(
          `/api/v1/workouts?from=2026-09-13&to=2026-09-14&kind=${kind}&exerciseId=${body.entries[0]!.exerciseId}`,
        )
      ).json(),
    );
    expect(page.data.map((w) => w.id)).toContain(saved.data.id);
    expect(page.data[0]).not.toHaveProperty('entries');
  }
});
it('converges concurrent idempotent clients and replays original response after update/delete', async () => {
  const body = input(await exercise()),
    key = crypto.randomUUID();
  const responses = await Promise.all(
    Array.from({ length: 4 }, () =>
      request('/api/v1/workouts', 'POST', body, undefined, key),
    ),
  );
  expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201]);
  const values = await Promise.all(
    responses.map(async (r) => workoutResponseSchema.parse(await r.json())),
  );
  expect(new Set(values.map((v) => v.data.id)).size).toBe(1);
  expect(values.filter((v) => !v.meta.replayed)).toHaveLength(1);
  const saved = values[0]!;
  expect(
    (
      await request(
        '/api/v1/workouts',
        'POST',
        { ...body, notes: 'Synthetic other' },
        undefined,
        key,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await request(
        `/api/v1/workouts/${saved.data.id}`,
        'PUT',
        { ...body, notes: 'Synthetic updated' },
        1,
      )
    ).status,
  ).toBe(200);
  expect((await create(body, key)).data).toEqual(saved.data);
  expect(
    (await request(`/api/v1/workouts/${saved.data.id}`, 'DELETE', undefined, 2))
      .status,
  ).toBe(200);
  expect((await create(body, key)).data).toEqual(saved.data);
  expect((await request(`/api/v1/workouts/${saved.data.id}`)).status).toBe(404);
});
it('has one concurrent CAS winner without any loser child changes; delete checks versions', async () => {
  const body = input(await exercise()),
    saved = await create(body),
    path = `/api/v1/workouts/${saved.data.id}`;
  const a = input(body.entries[0]!.exerciseId, 2),
    b = input(body.entries[0]!.exerciseId, 3);
  const responses = await Promise.all([
    request(path, 'PUT', a, 1),
    request(path, 'PUT', b, 1),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 412]);
  const winner = workoutResponseSchema.parse(
    await responses.find((r) => r.status === 200)!.json(),
  );
  expect(
    workoutResponseSchema.parse(await (await request(path)).json()).data,
  ).toEqual(winner.data);
  expect((await request(path, 'DELETE', undefined, 1)).status).toBe(412);
  expect((await request(path, 'PUT', a)).status).toBe(428);
  expect((await request(path, 'DELETE')).status).toBe(428);
  const racing = await Promise.all([
    request(path, 'PUT', a, 2),
    request(path, 'DELETE', undefined, 2),
  ]);
  expect(racing.filter((r) => r.status === 200)).toHaveLength(1);
  expect([404, 412]).toContain(racing.find((r) => r.status !== 200)?.status);
});
it('preserves original snapshots and edits archived history but rejects new or changed archived references', async () => {
  const id = await exercise(),
    body = input(id),
    saved = await create(body),
    path = `/api/v1/workouts/${saved.data.id}`;
  expect(
    (
      await request(
        `/api/v1/exercises/${id}`,
        'PATCH',
        { name: 'Synthetic renamed', archived: true },
        1,
      )
    ).status,
  ).toBe(200);
  const response = await request(
    path,
    'PUT',
    { ...body, notes: 'Synthetic historical edit' },
    1,
  );
  expect(response.status).toBe(200);
  expect(
    workoutResponseSchema.parse(await response.json()).data.entries[0]
      ?.exerciseNameSnapshot,
  ).toBe('Synthetic workout exercise');
  expect(
    (
      await request(
        '/api/v1/workouts',
        'POST',
        input(id),
        undefined,
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(409);
  const added = structuredClone(body);
  added.entries[0]!.id = crypto.randomUUID();
  expect((await request(path, 'PUT', added, 2)).status).toBe(409);
  await expect(
    bindings.DB.prepare('UPDATE exercises SET volume_multiplier=2 WHERE id=?')
      .bind(id)
      .run(),
  ).rejects.toThrow('EXERCISE_REFERENCED');
});
it('saves, replaces, and deletes the full 300-set maximum within one D1 batch', async () => {
  const body = input(await exercise(), 300),
    saved = await create(body),
    path = `/api/v1/workouts/${saved.data.id}`;
  const update = input(body.entries[0]!.exerciseId, 300);
  const r = await request(path, 'PUT', update, 1);
  expect(r.status, await r.clone().text()).toBe(200);
  const data = workoutResponseSchema.parse(
    await (await request(path)).json(),
  ).data;
  expect(
    data.entries.reduce(
      (n, e) => n + (e.kind === 'strength' ? e.sets.length : 0),
      0,
    ),
  ).toBe(300);
  expect((await request(path, 'DELETE', undefined, 2)).status).toBe(200);
  expect(
    await bindings.DB.prepare(
      'SELECT count(*) AS n FROM strength_sets WHERE entry_id=?',
    )
      .bind(update.entries[0]!.id)
      .first('n'),
  ).toBe(0);
});
it('rolls back parent and all child statements when a late unique collision occurs', async () => {
  const id = await exercise(),
    occupied = await create(input(id)),
    body = input(id, 60);
  const source = occupied.data.entries[0]!;
  const target = body.entries[1]!;
  if (source.kind !== 'strength' || target.kind !== 'strength')
    throw new Error();
  target.sets[0]!.id = source.sets[0]!.id;
  const count = await bindings.DB.prepare(
    'SELECT count(*) AS n FROM workouts',
  ).first('n');
  expect(
    (
      await request(
        '/api/v1/workouts',
        'POST',
        body,
        undefined,
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(409);
  expect(
    await bindings.DB.prepare('SELECT count(*) AS n FROM workouts').first('n'),
  ).toBe(count);
  expect(
    await bindings.DB.prepare('SELECT id FROM workout_entries WHERE id=?')
      .bind(body.entries[0]!.id)
      .first(),
  ).toBeNull();
  const existing = await create(input(id));
  expect(
    (await request(`/api/v1/workouts/${existing.data.id}`, 'PUT', body, 1))
      .status,
  ).toBe(409);
  expect(
    workoutResponseSchema.parse(
      await (await request(`/api/v1/workouts/${existing.data.id}`)).json(),
    ).data,
  ).toEqual(existing.data);
});
it('paginates tied dates and timestamps without duplicates and binds filters', async () => {
  const id = await exercise();
  const saved = await Promise.all(
    Array.from({ length: 3 }, () => create(input(id))),
  );
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const r = await request(
      `/api/v1/workouts?from=2026-09-13&to=2026-09-14&exerciseId=${id}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    expect(r.status).toBe(200);
    const page = workoutListSchema.parse(await r.json());
    ids.push(...page.data.map((w) => w.id));
    cursor = page.meta.nextCursor;
    if (cursor)
      expect(
        (
          await request(
            `/api/v1/workouts?from=2026-09-13&to=2026-09-14&status=draft&cursor=${encodeURIComponent(cursor)}`,
          )
        ).status,
      ).toBe(400);
  } while (cursor);
  expect(ids).toEqual(
    saved
      .map((s) => s.data.id)
      .sort()
      .reverse(),
  );
  for (const query of [
    'from=2025-01-01&to=2026-09-14',
    'from=2026-09-14&to=2026-09-14',
    'from=not-date',
    'limit=101',
    'cursor=bad',
    'extra=true',
  ])
    expect((await request(`/api/v1/workouts?${query}`)).status).toBe(400);
});
it('rejects invalid measurements, missing idempotency, unknown snapshots and oversized groups', async () => {
  const id = await exercise(),
    body = input(id);
  expect((await request('/api/v1/workouts', 'POST', body)).status).toBe(400);
  const e = body.entries[0]!;
  if (e.kind !== 'strength') throw new Error();
  e.sets[0]!.loadKg = null;
  expect(
    (
      await request(
        '/api/v1/workouts',
        'POST',
        body,
        undefined,
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(422);
  expect(
    (
      await request(
        '/api/v1/workouts',
        'POST',
        input(id, 301),
        undefined,
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(422);
  expect(
    (
      await request(
        '/api/v1/workouts',
        'POST',
        { ...input(id), version: 1 },
        undefined,
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(422);
});
it('guards archive/version races inside actual D1 batches, including deterministic post-read interleavings', async () => {
  for (const change of ['archive', 'rename', 'semantics']) {
    const id = await exercise(),
      body = input(id),
      count = await bindings.DB.prepare(
        'SELECT count(*) n FROM workouts',
      ).first('n');
    // Intercept only the final write batch, leaving actual workerd D1 execution intact.
    const proxy = new Proxy(bindings.DB, {
      get(target, prop) {
        if (prop === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const sql =
              change === 'archive'
                ? 'archived_at=?'
                : change === 'rename'
                  ? 'name=?'
                  : 'volume_multiplier=?';
            await target
              .prepare(
                `UPDATE exercises SET ${sql},version=version+1 WHERE id=?`,
              )
              .bind(change === 'semantics' ? 2 : 'Synthetic changed', id)
              .run();
            return target.batch(statements);
          };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      saveWorkout(proxy, body, {
        principal: 'synthetic-race',
        key: crypto.randomUUID(),
        requestId: 'synthetic',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await bindings.DB.prepare('SELECT count(*) n FROM workouts').first('n'),
    ).toBe(count);
  }
  for (let i = 0; i < 5; i++) {
    const id = await exercise();
    const [save, archive] = await Promise.all([
      request(
        '/api/v1/workouts',
        'POST',
        input(id),
        undefined,
        crypto.randomUUID(),
      ),
      request(`/api/v1/exercises/${id}`, 'PATCH', { archived: true }, 1),
    ]);
    expect(archive.status).toBe(200);
    expect([201, 409]).toContain(save.status);
    if (save.status === 201)
      expect(
        workoutResponseSchema.parse(await save.json()).data.entries[0]
          ?.exerciseNameSnapshot,
      ).toBe('Synthetic workout exercise');
  }
});
it('forces stale CAS guard rollback after a pre-read, and leaves no guard rows', async () => {
  const body = input(await exercise()),
    saved = await create(body);
  let batches = 0;
  const proxy = new Proxy(bindings.DB, {
    get(target, prop) {
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          batches++;
          if (batches === 2)
            await target
              .prepare('UPDATE workouts SET version=version+1 WHERE id=?')
              .bind(saved.data.id)
              .run();
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(
    saveWorkout(proxy, input(body.entries[0]!.exerciseId, 60), {
      id: saved.data.id,
      version: 1,
      principal: 'synthetic',
      requestId: 'synthetic',
    }),
  ).rejects.toMatchObject({ status: 412 });
  const current = workoutResponseSchema.parse(
    await (await request(`/api/v1/workouts/${saved.data.id}`)).json(),
  );
  expect(current.data.entries).toEqual(saved.data.entries);
  expect(
    await bindings.DB.prepare(
      'SELECT count(*) n FROM workout_write_guards',
    ).first('n'),
  ).toBe(0);
});
it('supports 50 entries with 300 sets and rejects concurrent different-body key reuse', async () => {
  const id = await exercise();
  const body = input(id);
  body.entries = Array.from({ length: 50 }, () => input(id, 6).entries[0]!);
  const saved = await create(body);
  const updated = await request(
    `/api/v1/workouts/${saved.data.id}`,
    'PUT',
    body,
    1,
  );
  expect(updated.status, await updated.clone().text()).toBe(200);
  expect(
    workoutResponseSchema.parse(await updated.json()).data.entryCount,
  ).toBe(50);
  expect(
    (await request(`/api/v1/workouts/${saved.data.id}`, 'DELETE', undefined, 2))
      .status,
  ).toBe(200);
  const key = crypto.randomUUID();
  const pair = await Promise.all([
    request('/api/v1/workouts', 'POST', input(id), undefined, key),
    request('/api/v1/workouts', 'POST', input(id), undefined, key),
  ]);
  expect(pair.map((r) => r.status).sort()).toEqual([201, 409]);
});
it('accepts empty drafts, preserves null and zero, and validates malformed JSON/version headers', async () => {
  const body: WorkoutInput = {
    ...input(await exercise()),
    status: 'draft',
    entries: [],
  };
  const saved = await create(body);
  expect(saved.data.durationSeconds).toBeNull();
  const next = input(await exercise());
  const entry = next.entries[0]!;
  if (entry.kind !== 'strength') throw new Error();
  entry.sets[0]!.loadKg = 0;
  const zero = await create(next);
  expect(
    zero.data.entries[0]?.kind === 'strength' &&
      zero.data.entries[0].sets[0]?.loadKg,
  ).toBe(0);
  const malformed = await SELF.fetch('http://127.0.0.1:5173/api/v1/workouts', {
    method: 'POST',
    headers: {
      Origin: 'http://127.0.0.1:5173',
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: '{broken',
  });
  expect(malformed.status).toBe(400);
  for (const version of ['1', 'W/"1"', '"0"', '"9007199254740992"']) {
    const r = await SELF.fetch(
      `http://127.0.0.1:5173/api/v1/workouts/${saved.data.id}`,
      {
        method: 'DELETE',
        headers: {
          Origin: 'http://127.0.0.1:5173',
          'Content-Type': 'application/json',
          'If-Match': version,
        },
      },
    );
    expect(r.status).toBe(400);
  }
});
it('exposes only GET workout routes to Agent and documents both surfaces', async () => {
  for (const prefix of ['/api/v1', '/api/agent/v1']) {
    const doc = (await (await request(`${prefix}/openapi.json`)).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(doc.paths['/workouts']!)).toEqual(['get', 'post']);
    expect(Object.keys(doc.paths['/workouts/{id}']!)).toEqual(
      prefix.includes('agent') ? ['get'] : ['get', 'put', 'delete'],
    );
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])
    expect((await request('/api/agent/v1/workouts', method)).status).toBe(405);
});

it('session review uses actual client DELETE headers across workerd HTTP and current replay request IDs', async () => {
  const { api, versionHeaders } = await import('../../src/web/lib');
  const { workoutDeleteSchema } = await import('../../src/shared/workouts');
  const body = input(await exercise()),
    key = crypto.randomUUID();
  const first = await request('/api/v1/workouts', 'POST', body, undefined, key);
  const saved = workoutResponseSchema.parse(await first.json());
  const missingJson = await SELF.fetch(
    `http://127.0.0.1:5173/api/v1/workouts/${saved.data.id}`,
    {
      method: 'DELETE',
      headers: { Origin: 'http://127.0.0.1:5173', 'If-Match': '"1"' },
    },
  );
  expect(missingJson.status).toBe(400);
  const second = await request(
    '/api/v1/workouts',
    'POST',
    body,
    undefined,
    key,
  );
  const replayed = workoutResponseSchema.parse(await second.json());
  expect(replayed.data).toEqual(saved.data);
  expect(replayed.meta.requestId).toBe(second.headers.get('X-Request-Id'));
  expect(replayed.meta.requestId).not.toBe(saved.meta.requestId);
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.has('Origin')).toBe(false);
    // Only simulate the browser-managed Origin; never inject/fix client content type.
    headers.set('Origin', 'http://127.0.0.1:5173');
    // workerd lacks browser redirect:error; manual preserves rejection at this adapter boundary.
    const response = await SELF.fetch(`http://127.0.0.1:5173${url}`, {
      ...init,
      redirect: 'manual',
      headers,
    });
    if (response.status >= 300 && response.status < 400)
      throw new Error('redirect');
    return response;
  });
  try {
    expect(
      (
        await api(`/workouts/${saved.data.id}`, workoutDeleteSchema, {
          method: 'DELETE',
          headers: versionHeaders(1),
        })
      ).data.deleted,
    ).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});
it('session review cleanup preserves unrelated guard rows', async () => {
  const id = crypto.randomUUID();
  await bindings.DB.prepare(
    "INSERT INTO workout_write_guards VALUES (?, 'cas', 1)",
  )
    .bind(id)
    .run();
  try {
    await Promise.all([
      create(input(await exercise())),
      create(input(await exercise())),
    ]);
    expect(
      await bindings.DB.prepare(
        'SELECT id FROM workout_write_guards WHERE id=?',
      )
        .bind(id)
        .first('id'),
    ).toBe(id);
  } finally {
    await bindings.DB.prepare('DELETE FROM workout_write_guards WHERE id=?')
      .bind(id)
      .run();
  }
});

it('session review keeps backend UTF8 request limit for legal maximum Chinese notes', async () => {
  const body = input(await exercise(), 300);
  for (const entry of body.entries)
    if (entry.kind === 'strength')
      for (const set of entry.sets) set.notes = '中'.repeat(4000);
  const before = await bindings.DB.prepare(
    'SELECT count(*) n FROM workouts',
  ).first('n');
  expect(
    (
      await request(
        '/api/v1/workouts',
        'POST',
        body,
        undefined,
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(413);
  expect(
    await bindings.DB.prepare('SELECT count(*) n FROM workouts').first('n'),
  ).toBe(before);
});
