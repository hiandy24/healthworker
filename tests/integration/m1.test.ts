import { env, applyD1Migrations, SELF } from 'cloudflare:test';
import { beforeAll, describe, it, expect, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { drizzle } from 'drizzle-orm/d1';
import { exercises } from '../../src/worker/db/schema';
import app from '../../src/worker/index';
import type { Bindings } from '../../src/worker/auth';
import seed from '../../seeds/local.sql?raw';
import { metadataSchema } from '../../src/shared/contracts';
const bindings = env as unknown as Bindings & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
describe('D1 actual migrations and constraints', () => {
  it('enforces foreign keys', async () => {
    const row = await bindings.DB.prepare('PRAGMA foreign_keys').first<{
      foreign_keys: number;
    }>();
    expect(row?.foreign_keys).toBe(1);
    await expect(
      bindings.DB.prepare(
        "INSERT INTO cardio_records(id,entry_id) VALUES ('orphan','missing')",
      ).run(),
    ).rejects.toThrow();
  });
  it('seeds stable synthetic IDs without replacing edited display fields', async () => {
    for (const statement of seed.split(';').filter((s) => s.trim()))
      await bindings.DB.prepare(statement).run();
    await bindings.DB.prepare(
      "UPDATE exercises SET name='Synthetic edited name' WHERE id=?",
    )
      .bind('00000000-0000-4000-8000-000000000001')
      .run();
    for (const statement of seed.split(';').filter((s) => s.trim()))
      await bindings.DB.prepare(statement).run();
    const rows = await drizzle(bindings.DB).select().from(exercises);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.id.endsWith('1'))?.name).toBe(
      'Synthetic edited name',
    );
  });
  it('rolls back the entire D1 batch on a failed statement', async () => {
    await expect(
      bindings.DB.batch([
        bindings.DB.prepare(
          "INSERT INTO workouts(id,started_at,timezone,local_date,created_at,updated_at) VALUES ('rollback','2026-01-01T00:00:00Z','UTC','2026-01-01','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
        ),
        bindings.DB.prepare(
          "INSERT INTO cardio_records(id,entry_id) VALUES ('invalid','missing')",
        ),
      ]),
    ).rejects.toThrow();
    expect(
      await bindings.DB.prepare(
        "SELECT id FROM workouts WHERE id='rollback'",
      ).first(),
    ).toBeNull();
  });
  it('enforces ordering, checks, restricts exercise deletion and cascades children', async () => {
    await bindings.DB.prepare(
      "INSERT INTO workouts(id,started_at,timezone,local_date,created_at,updated_at) VALUES ('cascade','2026-01-01T00:00:00Z','UTC','2026-01-01','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
    ).run();
    const insert = (id: string) =>
      bindings.DB.prepare(
        "INSERT INTO workout_entries(id,workout_id,exercise_id,position,kind,exercise_name_snapshot,measurement_snapshot) VALUES (?,'cascade','00000000-0000-4000-8000-000000000001',0,'strength','Synthetic','{}')",
      ).bind(id);
    await insert('entry').run();
    await expect(insert('duplicate').run()).rejects.toThrow();
    await expect(
      bindings.DB.prepare(
        "DELETE FROM exercises WHERE id='00000000-0000-4000-8000-000000000001'",
      ).run(),
    ).rejects.toThrow();
    await expect(
      bindings.DB.prepare(
        "INSERT INTO strength_sets(id,entry_id,position,set_type,load_grams) VALUES ('bad','entry',0,'working',-1)",
      ).run(),
    ).rejects.toThrow();
    await bindings.DB.prepare(
      "INSERT INTO strength_sets(id,entry_id,position,set_type,reps,load_grams,completed) VALUES ('set','entry',0,'working',5,100000,1)",
    ).run();
    await bindings.DB.prepare("DELETE FROM workouts WHERE id='cascade'").run();
    expect(
      await bindings.DB.prepare(
        "SELECT id FROM strength_sets WHERE id='set'",
      ).first(),
    ).toBeNull();
    expect(
      await bindings.DB.prepare(
        "SELECT id FROM workout_entries WHERE id='entry'",
      ).first(),
    ).toBeNull();
  });
});
describe('protected API routing (A12/A13)', () => {
  it('wires signed single-AUD identities through workerd HTTP and remote JWKS verification', async () => {
    const production = {
      ...bindings,
      APP_ENV: 'production',
      LOCAL_AUTH_MOCK: 'false',
      APP_ORIGIN: 'https://health.example.test',
      ACCESS_ISSUER: 'https://http-synthetic.cloudflareaccess.com',
      ACCESS_AUD: 'single-app',
      OWNER_EMAILS: 'owner@example.test',
    };
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = {
      ...(await exportJWK(publicKey)),
      kid: 'http-synthetic',
      alg: 'RS256',
    };
    // Mock only outbound JWKS transport; authenticate/jwtVerify/routes are real.
    const transport = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        expect(String(input)).toBe(
          `${production.ACCESS_ISSUER}/cdn-cgi/access/certs`,
        );
        return Response.json({ keys: [jwk] });
      });
    const sign = (claims: Record<string, unknown>, overrides = {}) =>
      new SignJWT({
        type: 'app',
        iss: production.ACCESS_ISSUER,
        aud: [production.ACCESS_AUD],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        ...claims,
        ...overrides,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'http-synthetic' })
        .sign(privateKey);
    const human = await sign({ sub: 'owner-id', email: 'owner@example.test' });
    const service = await sign({
      sub: '',
      common_name: 'synthetic-client.access',
    });
    const request = (
      path: string,
      token: string,
      method = 'GET',
      body?: string,
    ) =>
      app.request(
        `${production.APP_ORIGIN}${path}`,
        {
          method,
          headers: {
            'Cf-Access-Jwt-Assertion': token,
            Origin: production.APP_ORIGIN,
            'Content-Type': 'application/json',
            'If-Match': '"1"',
            'Cf-Access-Authenticated-User-Email': 'owner@example.test',
          },
          ...(body === undefined ? {} : { body }),
        },
        production,
      );
    try {
      expect((await request('/api/v1/metadata', human)).status).toBe(200);
      expect(
        (
          await request(
            '/api/v1/settings',
            human,
            'PATCH',
            JSON.stringify({ timezone: 'UTC', theme: 'auto' }),
          )
        ).status,
      ).toBe(200);
      expect((await request('/api/agent/v1/metadata', service)).status).toBe(
        200,
      );
      expect(transport).toHaveBeenCalledTimes(1);
      const importing = {
        ...production,
        ACCESS_IMPORT_TOKEN_IDS: 'synthetic-client.access',
      };
      const create = (
        token: string,
        settings = importing,
        method = 'POST',
        path = '/workouts',
        body = JSON.stringify({
          startedAt: '2026-08-01T00:00:00Z',
          timezone: 'UTC',
          status: 'draft',
          durationSeconds: null,
          notes: null,
          entries: [],
        }),
      ) =>
        app.request(
          `${production.APP_ORIGIN}/api/agent/v1${path}`,
          {
            method,
            headers: {
              'Cf-Access-Jwt-Assertion': token,
              'Content-Type': 'application/json',
              'Idempotency-Key': 'synthetic-import-key',
              'Cf-Access-Authenticated-User-Email': 'owner@example.test',
              'CF-Access-Client-Id': 'synthetic-client.access',
            },
            ...(method === 'GET' ? {} : { body }),
          },
          settings,
        );
      expect(
        (
          await create(service, {
            ...importing,
            ACCESS_IMPORT_TOKEN_IDS: 'other-client',
          })
        ).status,
      ).toBe(405);
      expect((await create(human)).status).toBe(403);
      expect((await create('forged')).status).toBe(401);
      for (const bad of ['', ',', '*', 'bad id'])
        expect(
          (
            await create(service, {
              ...importing,
              ACCESS_IMPORT_TOKEN_IDS: bad,
            })
          ).status,
        ).toBe(503);
      expect(
        (
          await create(service, {
            ...importing,
            ACCESS_SERVICE_TOKEN_IDS: 'other',
          })
        ).status,
      ).toBe(403);
      const created = await create(service);
      expect(created.status).toBe(201);
      const original = (await created.json()) as { data: { id: string } };
      const replayed = await create(service);
      expect(replayed.status).toBe(201);
      expect(await replayed.json()).toMatchObject({
        data: { id: original.data.id },
        meta: { replayed: true },
      });
      const other = await sign({ sub: '', common_name: 'other-client' });
      const separate = await create(other, {
        ...importing,
        ACCESS_IMPORT_TOKEN_IDS: 'other-client',
      });
      expect(separate.status).toBe(201);
      expect(
        ((await separate.json()) as { data: { id: string } }).data.id,
      ).not.toBe(original.data.id);
      const meta = await create(service, importing, 'GET', '/metadata');
      expect(await meta.json()).toMatchObject({
        data: {
          capabilities: expect.arrayContaining([
            'exercises:create',
            'workouts:create',
          ]),
        },
      });
      // Import-authorized service identities may create exercises and
      // workouts only; every other write stays blocked.
      for (const path of [
        '/settings',
        '/export',
        '/unknown',
        '/workouts/' + original.data.id,
      ])
        expect((await create(service, importing, 'POST', path)).status).toBe(
          405,
        );
      for (const method of ['PUT', 'PATCH', 'DELETE'])
        for (const path of [
          '/workouts',
          '/exercises',
          '/workouts/' + original.data.id,
        ])
          expect((await create(service, importing, method, path)).status).toBe(
            405,
          );
      const exercise = {
        id: '00000000-0000-4000-8000-0000000000e1',
        name: 'Synthetic agent lat pulldown',
        aliases: [] as string[],
        kind: 'strength',
        equipment: null,
        muscleGroups: [] as string[],
        measurementMode: 'reps',
        resistanceMode: 'external',
        loadConvention: 'total',
        repConvention: 'total',
        volumeMultiplier: null,
        cardioCategory: null,
      };
      const createExercise = (
        key: string,
        body: Record<string, unknown> = exercise,
        settings: typeof importing | typeof production = importing,
        token: string = service,
      ) =>
        app.request(
          `${production.APP_ORIGIN}/api/agent/v1/exercises`,
          {
            method: 'POST',
            headers: {
              'Cf-Access-Jwt-Assertion': token,
              'Content-Type': 'application/json',
              'Idempotency-Key': key,
            },
            body: JSON.stringify(body),
          },
          settings,
        );
      expect(
        (
          await createExercise('synthetic-exercise-key', exercise, {
            ...importing,
            ACCESS_IMPORT_TOKEN_IDS: 'other-client',
          })
        ).status,
      ).toBe(405);
      expect(
        (
          await createExercise(
            'synthetic-exercise-key',
            exercise,
            production,
            human,
          )
        ).status,
      ).toBe(403);
      const exerciseCreated = await createExercise('synthetic-exercise-key');
      expect(exerciseCreated.status).toBe(201);
      const exerciseOriginal = (await exerciseCreated.json()) as {
        data: { id: string; name: string; isBuiltin: boolean };
        meta: { replayed: boolean };
      };
      expect(exerciseOriginal.data.id).toBe(
        '00000000-0000-4000-8000-0000000000e1',
      );
      expect(exerciseOriginal.data.isBuiltin).toBe(false);
      expect(exerciseOriginal.meta.replayed).toBe(false);
      const exerciseReplay = await createExercise('synthetic-exercise-key');
      expect(exerciseReplay.status).toBe(201);
      expect(await exerciseReplay.json()).toMatchObject({
        data: { id: exerciseOriginal.data.id },
        meta: { replayed: true },
      });
      const keyConflict = await createExercise('synthetic-exercise-key', {
        ...exercise,
        name: 'Different synthetic name',
      });
      expect(keyConflict.status).toBe(409);
      expect(await keyConflict.json()).toMatchObject({
        error: { code: 'IDEMPOTENCY_CONFLICT' },
      });
      const nameConflict = await createExercise('another-exercise-key', {
        ...exercise,
        id: crypto.randomUUID(),
      });
      expect(nameConflict.status).toBe(409);
      expect(await nameConflict.json()).toMatchObject({
        error: { code: 'EXERCISE_EXISTS' },
      });
      const idConflict = await createExercise('third-exercise-key', {
        ...exercise,
        name: 'Synthetic agent row',
        id: '00000000-0000-4000-8000-0000000000e1',
      });
      expect(idConflict.status).toBe(409);
      expect(await idConflict.json()).toMatchObject({
        error: { code: 'EXERCISE_ID_EXISTS' },
      });
      for (const [method, path] of [
        ['GET', '/metadata'],
        ['GET', '/settings'],
        ['GET', '/export'],
        ['POST', '/workouts'],
        ['PATCH', '/settings'],
        ['PUT', '/workouts/00000000-0000-4000-8000-000000000001'],
        ['DELETE', '/workouts/00000000-0000-4000-8000-000000000001'],
      ])
        expect((await request(`/api/v1${path}`, service, method)).status).toBe(
          403,
        );
      expect((await request('/api/agent/v1/metadata', human)).status).toBe(403);
      for (const method of [
        'POST',
        'PATCH',
        'PUT',
        'DELETE',
        'HEAD',
        'OPTIONS',
      ])
        expect(
          (await request('/api/agent/v1/metadata', service, method)).status,
        ).toBe(405);
      for (const claims of [
        { sub: '' },
        { sub: '', email: 'owner@example.test' },
        {
          sub: '',
          common_name: 'synthetic-client.access',
          email: 'owner@example.test',
        },
        {
          sub: 'owner-id',
          common_name: 'synthetic-client.access',
          email: 'owner@example.test',
        },
      ])
        for (const prefix of ['/api/v1', '/api/agent/v1'])
          expect(
            (await request(`${prefix}/metadata`, await sign(claims))).status,
          ).toBe(403);
      expect(
        (
          await request(
            '/api/v1/metadata',
            await sign(
              { sub: 'owner-id', email: 'owner@example.test' },
              { aud: 'wrong' },
            ),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await request(
            '/api/v1/metadata',
            await sign(
              { sub: 'owner-id', email: 'owner@example.test' },
              { exp: 1 },
            ),
          )
        ).status,
      ).toBe(401);
      expect((await request('/api/v1/metadata', 'forged')).status).toBe(401);
      expect((await request('/api/v1/metadata', '')).status).toBe(401);
      const doc = (await (
        await request('/api/agent/v1/openapi.json', service)
      ).json()) as {
        components: { securitySchemes: Record<string, { name: string }> };
      };
      expect(doc.components.securitySchemes.AccessJWT?.name).toBe(
        'Cf-Access-Jwt-Assertion',
      );
    } finally {
      transport.mockRestore();
    }
  });
  it('returns safe 400 envelopes for malformed JSON on every implemented write body route', async () => {
    for (const [path, method] of [
      ['/exercises', 'POST'],
      [`/exercises/${crypto.randomUUID()}`, 'PATCH'],
      ['/workouts', 'POST'],
      [`/workouts/${crypto.randomUUID()}`, 'PUT'],
    ] as const) {
      const r = await SELF.fetch(`http://127.0.0.1:5173/api/v1${path}`, {
        method,
        headers: {
          Origin: 'http://127.0.0.1:5173',
          'Content-Type': 'application/json',
          'If-Match': '"1"',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: '{"truncated":',
      });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({
        error: { code: 'INVALID_JSON', message: 'JSON 格式无效' },
        requestId: expect.any(String),
      });
    }
  });
  it('serves only honest M1 capabilities with no-store', async () => {
    const response = await SELF.fetch('https://example.test/api/v1/metadata');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(
      metadataSchema.parse(await response.json()).data.capabilities,
    ).toEqual([
      'metadata',
      'openapi',
      'exercises',
      'workouts',
      'stats',
      'settings',
      'export',
    ]);
  });
  it('uses independent OpenAPI surfaces', async () => {
    for (const prefix of ['/api/v1', '/api/agent/v1']) {
      const response = await SELF.fetch(
        `https://example.test${prefix}/openapi.json`,
      );
      expect(response.status).toBe(200);
      const document = (await response.json()) as {
        paths: Record<
          string,
          Record<string, { security?: { AccessJWT: string[] }[] }>
        >;
        security: { AccessJWT: string[] }[];
        servers: { url: string }[];
      };
      expect(Object.keys(document.paths)).toEqual(
        prefix.includes('agent')
          ? [
              '/metadata',
              '/exercises',
              '/workouts',
              '/workouts/{id}',
              '/stats/summary',
              '/stats/strength',
              '/stats/cardio',
            ]
          : [
              '/metadata',
              '/exercises',
              '/exercises/{id}',
              '/workouts',
              '/workouts/{id}',
              '/stats/summary',
              '/stats/strength',
              '/stats/cardio',
              '/settings',
              '/export',
            ],
      );
      const exerciseMethods = document.paths['/exercises'] as Record<
        string,
        unknown
      >;
      // Both surfaces advertise create; only the agent route requires an
      // Idempotency-Key header and is runtime-gated to import-allowlisted
      // service identities.
      expect(Object.keys(exerciseMethods)).toEqual(['get', 'post']);
      expect(document.servers[0]?.url).toBe(prefix);
      for (const methods of Object.values(document.paths))
        for (const operation of Object.values(methods))
          expect(operation.security ?? document.security).toEqual([
            { AccessJWT: [] },
          ]);
    }
  });
  it('rejects every non-GET Agent method including HEAD and OPTIONS', async () => {
    for (const method of [
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'HEAD',
      'OPTIONS',
    ]) {
      const response = await SELF.fetch(
        'https://example.test/api/agent/v1/metadata',
        { method },
      );
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET');
    }
  });
  it('never falls back to HTML or fake CRUD success', async () => {
    for (const path of [
      '/api',
      '/api/unknown',
      '/api/v1/not-implemented',
      '/api//v1/metadata',
      '/api/agent/v1/settings',
      '/api/v1%2fmetadata',
    ]) {
      const response = await SELF.fetch(`https://example.test${path}`);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers.get('content-type')).toContain(
        'application/json',
      );
    }
  });
  it('requires trusted same-origin and JSON for human writes', async () => {
    for (const origin of ['', 'https://evil.example']) {
      const response = await SELF.fetch(
        'http://127.0.0.1:5173/api/v1/workouts',
        {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: '{}',
        },
      );
      expect(response.status).toBe(403);
    }
    expect(
      (
        await SELF.fetch('http://127.0.0.1:5173/api/v1/workouts', {
          method: 'POST',
          headers: {
            Origin: 'http://127.0.0.1:5173',
            'Content-Type': 'text/plain',
          },
          body: '{}',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await SELF.fetch('http://127.0.0.1:5173/api/v1/workouts', {
          method: 'POST',
          headers: {
            Origin: 'http://127.0.0.1:5173',
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
      ).status,
    ).toBe(400);
  });
  it('limits bodies', async () => {
    expect(
      (
        await SELF.fetch('http://127.0.0.1:5173/api/v1/workouts', {
          method: 'POST',
          headers: {
            Origin: 'http://127.0.0.1:5173',
            'Content-Type': 'application/json',
          },
          body: 'x'.repeat(512 * 1024 + 1),
        })
      ).status,
    ).toBe(413);
  });
  it('fails closed in production including unknown paths and forged identity headers', async () => {
    for (const path of [
      '/api/v1/metadata',
      '/api/agent/v1/metadata',
      '/api/unknown',
    ]) {
      const response = await app.request(
        `http://localhost${path}`,
        {
          headers: {
            'Cf-Access-Authenticated-User-Email': 'owner@example.test',
          },
        },
        { ...bindings, APP_ENV: 'production', LOCAL_AUTH_MOCK: 'true' },
      );
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('stack');
    }
  });
});
