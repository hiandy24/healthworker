import { env, applyD1Migrations, SELF } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import type { Bindings } from '../../src/worker/auth';
import { saveWorkout } from '../../src/worker/workouts';
import type { WorkoutInput } from '../../src/shared/workouts';
import {
  summaryResponseSchema,
  strengthResponseSchema,
  cardioResponseSchema,
} from '../../src/shared/stats';
import { metadataSchema } from '../../src/shared/contracts';
const bindings = env as unknown as Bindings & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
it('returns 200 with zero eligible pace samples for an all-null-distance group alone or alongside another category', async () => {
  const make = (category: string) =>
    exercise({
      kind: 'cardio',
      measurementMode: 'cardio',
      resistanceMode: null,
      loadConvention: 'none',
      repConvention: 'not_applicable',
      volumeMultiplier: null,
      cardioCategory: category,
    });
  const row = await make('row');
  const walk = await make('walk');
  const saved = await save([cardio(row, 600, null), cardio(walk, 600, 1000)], {
    startedAt: '2029-01-01T12:00:00Z',
  });
  for (const filter of ['', '&category=row']) {
    const response = await get(
      `/stats/cardio?from=2029-01-01&to=2029-01-02${filter}`,
    );
    expect(response.status).toBe(200);
    const data = cardioResponseSchema.parse(await response.json()).data;
    expect(data.groups.find((g) => g.category === 'row')).toMatchObject({
      paceSampleCount: 0,
      paceDurationSeconds: 0,
      paceDistanceMeters: 0,
      speedKmh: null,
      paceSecondsPerKm: null,
      paceSecondsPer100m: null,
    });
    expect(data.quality.missing.distance).toBe(1);
  }
  await bindings.DB.prepare('DELETE FROM workouts WHERE id=?')
    .bind(saved.data.id)
    .run();
});
it('never returns truncated dense cardio statistics and explicitly rejects over 10000 records', async () => {
  const id = await exercise({
    kind: 'cardio',
    measurementMode: 'cardio',
    resistanceMode: null,
    loadConvention: 'none',
    repConvention: 'not_applicable',
    volumeMultiplier: null,
    cardioCategory: 'row',
  });
  const saved = await save([cardio(id)], { startedAt: '2027-01-01T12:00:00Z' });
  await bindings.DB.batch([
    bindings.DB.prepare(
      `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<10000) INSERT INTO workout_entries(id,workout_id,exercise_id,position,kind,exercise_name_snapshot,measurement_snapshot) SELECT printf('00000000-0000-4000-8000-%012d',i),?,?,i,'cardio','Synthetic dense','{}' FROM n`,
    ).bind(saved.data.id, id),
    bindings.DB.prepare(
      `INSERT INTO cardio_records(id,entry_id,duration_seconds,completed) SELECT id,id,60,1 FROM workout_entries WHERE workout_id=? AND position>0`,
    ).bind(saved.data.id),
  ]);
  const r = await get(
    '/stats/cardio?from=2027-01-01&to=2027-01-02&category=row',
  );
  expect(r.status).toBe(422);
  expect(await r.json()).toMatchObject({
    error: { code: 'STATS_RANGE_TOO_DENSE' },
  });
  await bindings.DB.prepare('DELETE FROM workouts WHERE id=?')
    .bind(saved.data.id)
    .run();
});
it('excludes legacy incomplete child records even under completed parents', async () => {
  const id = await exercise();
  const run = await exercise({
    kind: 'cardio',
    measurementMode: 'cardio',
    resistanceMode: null,
    loadConvention: 'none',
    repConvention: 'not_applicable',
    volumeMultiplier: null,
    cardioCategory: 'walk',
  });
  const s = strength(id, 1),
    c = cardio(run);
  const saved = await save([s, c], { startedAt: '2028-01-01T12:00:00Z' });
  await bindings.DB.batch([
    bindings.DB.prepare(
      'UPDATE strength_sets SET completed=0 WHERE entry_id=?',
    ).bind(s.id),
    bindings.DB.prepare(
      'UPDATE cardio_records SET completed=0 WHERE entry_id=?',
    ).bind(c.id),
  ]);
  const a = strengthResponseSchema.parse(
    await (
      await get(
        `/stats/strength?from=2028-01-01&to=2028-01-02&exerciseId=${id}`,
      )
    ).json(),
  ).data;
  expect(a.totals.setCount).toBe(0);
  expect(a.quality.excluded.incompleteSets).toBe(1);
  const b = cardioResponseSchema.parse(
    await (await get('/stats/cardio?from=2028-01-01&to=2028-01-02')).json(),
  ).data;
  expect(b.groups).toEqual([]);
  expect(b.quality.excluded.incompleteRecords).toBe(1);
  await bindings.DB.prepare('DELETE FROM workouts WHERE id=?')
    .bind(saved.data.id)
    .run();
});
const get = (path: string, agent = false) =>
  SELF.fetch(`http://127.0.0.1:5173/api/${agent ? 'agent/' : ''}v1${path}`);
async function exercise(overrides: Record<string, unknown> = {}) {
  const r = await SELF.fetch('http://127.0.0.1:5173/api/v1/exercises', {
    method: 'POST',
    headers: {
      Origin: 'http://127.0.0.1:5173',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Synthetic statistics exercise',
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
      ...overrides,
    }),
  });
  expect(r.status, await r.clone().text()).toBe(201);
  return ((await r.json()) as { data: { id: string } }).data.id;
}
function strength(id: string, count = 3): WorkoutInput['entries'][number] {
  return {
    id: crypto.randomUUID(),
    exerciseId: id,
    kind: 'strength',
    notes: 'Synthetic private entry',
    sets: Array.from({ length: count }, () => ({
      id: crypto.randomUUID(),
      setType: 'working',
      completed: true,
      reps: 5,
      durationSeconds: null,
      loadKg: 100,
      assistanceKg: null,
      effortType: null,
      effortValue: null,
      notes: 'Synthetic private set',
    })),
  };
}
function cardio(
  id: string,
  durationSeconds = 1800,
  distanceMeters: number | null = 5000,
  extras: Record<string, unknown> = {},
): WorkoutInput['entries'][number] {
  return {
    id: crypto.randomUUID(),
    exerciseId: id,
    kind: 'cardio',
    notes: 'Synthetic private cardio',
    cardio: {
      completed: true,
      durationSeconds,
      durationBasis: 'elapsed',
      distanceMeters,
      averageHeartRate: null,
      maxHeartRate: null,
      elevationGainMeters: null,
      inclinePercent: null,
      resistanceLevel: null,
      deviceCaloriesKcal: null,
      ...extras,
    },
  };
}
async function save(
  entries: WorkoutInput['entries'],
  overrides: Partial<WorkoutInput> = {},
) {
  return saveWorkout(
    bindings.DB,
    {
      startedAt: '2026-08-03T12:00:00Z',
      timezone: 'UTC',
      status: 'completed',
      durationSeconds: null,
      notes: 'Synthetic private workout',
      entries,
      ...overrides,
    },
    {
      key: crypto.randomUUID(),
      principal: 'synthetic-stats',
      requestId: 'synthetic',
    },
  );
}
const range = 'from=2026-08-01&to=2026-09-01';
async function strengthResult(id: string, extra = '') {
  const r = await get(`/stats/strength?${range}&exerciseId=${id}${extra}`);
  expect(r.status, await r.clone().text()).toBe(200);
  return strengthResponseSchema.parse(await r.json()).data;
}
async function cardioResult(extra = '') {
  const r = await get(`/stats/cardio?${range}${extra}`);
  expect(r.status, await r.clone().text()).toBe(200);
  return cardioResponseSchema.parse(await r.json()).data;
}
it('A05 uses exact single-exercise snapshot volume and excludes warmup and draft samples by default', async () => {
  const id = await exercise();
  const entry = strength(id);
  if (entry.kind !== 'strength') throw new Error();
  entry.sets.push({
    ...entry.sets[0]!,
    id: crypto.randomUUID(),
    loadKg: 200,
    setType: 'warmup',
  });
  const saved = await save([entry]);
  await save([strength(id)], { status: 'draft' });
  const normal = await strengthResult(id);
  expect(normal.totals).toMatchObject({
    setCount: 3,
    workingSetCount: 3,
    reps: 15,
    volumeKgReps: 1500,
    maxLoadKg: 100,
    volumeSampleCount: 3,
  });
  expect(normal.quality.excluded).toMatchObject({
    warmupSets: 1,
    draftSets: 3,
  });
  expect(normal.records.maxLoad).toMatchObject({
    workoutId: saved.data.id,
    loadKg: 100,
    reps: 5,
  });
  expect(normal.records.mostRepsByResistance).toHaveLength(1);
  const withWarmup = await strengthResult(id, '&includeWarmup=true');
  expect(withWarmup.totals.volumeKgReps).toBe(2500);
  expect(withWarmup.totals.maxLoadKg).toBe(200);
  await bindings.DB.prepare('UPDATE exercises SET name=? WHERE id=?')
    .bind('Synthetic renamed', id)
    .run();
  expect((await strengthResult(id)).totals.volumeKgReps).toBe(1500);
  const dumbbell = await exercise({
    loadConvention: 'per_implement',
    repConvention: 'per_side',
    volumeMultiplier: 2,
  });
  await save([strength(dumbbell)]);
  expect((await strengthResult(dumbbell)).totals.volumeKgReps).toBe(3000);
});
it('A06 reports explicit excluded reasons and null volume for bodyweight, assisted, duration and unknown multiplier', async () => {
  for (const mode of [
    'bodyweight',
    'assisted',
    'duration',
    'unknownMultiplier',
  ] as const) {
    const id = await exercise({
      volumeMultiplier: null,
      ...(mode === 'bodyweight' || mode === 'assisted'
        ? { resistanceMode: mode }
        : {}),
      ...(mode === 'duration'
        ? { measurementMode: 'duration', repConvention: 'not_applicable' }
        : {}),
    });
    const entry = strength(id, 1);
    if (entry.kind !== 'strength') throw new Error();
    if (mode === 'bodyweight') entry.sets[0]!.loadKg = null;
    if (mode === 'assisted') {
      entry.sets[0]!.loadKg = null;
      entry.sets[0]!.assistanceKg = 20;
    }
    if (mode === 'duration') {
      entry.sets[0]!.reps = null;
      entry.sets[0]!.durationSeconds = 60;
    }
    await save([entry]);
    const data = await strengthResult(id);
    expect(data.totals.volumeKgReps).toBeNull();
    expect(data.totals.volumeSampleCount).toBe(0);
    expect(data.quality.excluded[mode]).toBe(1);
    if (mode === 'duration')
      expect(data.records.longestDuration?.durationSeconds).toBe(60);
    if (mode === 'assisted')
      expect(data.records.mostRepsByResistance[0]?.assistanceKg).toBe(20);
  }
});
it('handles legacy missing weights without zero-filling and compares assistance only at the same level', async () => {
  const id = await exercise();
  const entry = strength(id, 1);
  const saved = await save([entry]);
  if (entry.kind !== 'strength') throw new Error();
  await bindings.DB.prepare(
    'UPDATE strength_sets SET load_grams=NULL WHERE id=?',
  )
    .bind(entry.sets[0]!.id)
    .run();
  const missing = await strengthResult(id);
  expect(missing.totals.volumeKgReps).toBeNull();
  expect(missing.quality.excluded.missingLoad).toBe(1);
  expect(missing.records.maxLoad).toBeNull();
  expect(missing.workouts[0]?.workoutId).toBe(saved.data.id);
  const assisted = await exercise({
    resistanceMode: 'assisted',
    volumeMultiplier: null,
  });
  const a = strength(assisted, 3);
  if (a.kind !== 'strength') throw new Error();
  a.sets.forEach((s, i) => {
    s.loadKg = null;
    s.assistanceKg = i === 2 ? 30 : 20;
    s.reps = i + 5;
  });
  await save([a]);
  const records = (await strengthResult(assisted)).records.mostRepsByResistance;
  expect(records.map((r) => [r.assistanceKg, r.reps])).toEqual([
    [20, 6],
    [30, 7],
  ]);
});
it('A07 computes ratio-of-sums pace 320s/km, segregates basis/category and weights heart rate by recorded duration', async () => {
  const run = await exercise({
    kind: 'cardio',
    measurementMode: 'cardio',
    resistanceMode: null,
    loadConvention: 'none',
    repConvention: 'not_applicable',
    volumeMultiplier: null,
    cardioCategory: 'run',
  });
  await save([
    cardio(run, 1800, 5000, { averageHeartRate: 120 }),
    cardio(run, 3000, 10000, { averageHeartRate: 160 }),
    cardio(run, 600, 2000, { durationBasis: 'moving' }),
  ]);
  const data = await cardioResult('&category=run');
  const elapsed = data.groups.find((g) => g.durationBasis === 'elapsed')!;
  expect(elapsed.paceSecondsPerKm).toBe(320);
  expect(elapsed.speedKmh).toBe(11.25);
  expect(elapsed.averageHeartRate).toBe(145);
  expect(elapsed.heartRateSampleCount).toBe(2);
  expect(
    data.groups.find((g) => g.durationBasis === 'moving')?.paceSecondsPerKm,
  ).toBe(300);
  expect(
    (await cardioResult('&category=run&durationBasis=moving')).groups,
  ).toHaveLength(1);
  expect(
    data.records
      .filter((r) => r.durationBasis === 'elapsed')
      .map((r) => r.paceSecondsPerKm),
  ).toEqual([360, 300]);
});
it('missing and zero cardio distance do not enter pace denominator; swim has s/100m and bike no pace', async () => {
  const make = (category: string) =>
    exercise({
      kind: 'cardio',
      measurementMode: 'cardio',
      resistanceMode: null,
      loadConvention: 'none',
      repConvention: 'not_applicable',
      volumeMultiplier: null,
      cardioCategory: category,
    });
  const swim = await make('swim');
  await save([
    cardio(swim, 600, 500),
    cardio(swim, 100, null),
    cardio(swim, 200, 0),
  ]);
  const data = await cardioResult('&category=swim');
  const group = data.groups[0]!;
  expect(group.paceSecondsPer100m).toBe(120);
  expect(group.paceSecondsPerKm).toBeNull();
  expect(group.durationSeconds).toBe(900);
  expect(group.paceDurationSeconds).toBe(600);
  expect(group.distanceSampleCount).toBe(2);
  expect(group.paceSampleCount).toBe(1);
  expect(group.averageHeartRate).toBeNull();
  expect(data.quality.excluded).toMatchObject({
    paceMissingDistance: 1,
    paceZeroDistance: 1,
  });
  expect(
    data.records
      .filter((r) => r.distanceMeters === null || r.distanceMeters === 0)
      .every((r) => r.speedKmh === null),
  ).toBe(true);
  const cycle = await make('cycle');
  await save([cardio(cycle, 3600, 20000)]);
  const bike = (await cardioResult('&category=cycle')).groups[0]!;
  expect(bike.speedKmh).toBe(20);
  expect(bike.paceSecondsPerKm).toBeNull();
  expect(bike.paceSecondsPer100m).toBeNull();
});
it('summary counts mixed workouts once, tracks missing duration and fills clipped Monday and month buckets', async () => {
  const id = await exercise();
  const run = await exercise({
    kind: 'cardio',
    measurementMode: 'cardio',
    resistanceMode: null,
    loadConvention: 'none',
    repConvention: 'not_applicable',
    volumeMultiplier: null,
    cardioCategory: 'run',
  });
  // Dedicated dates isolate this test from other synthetic fixtures.
  await save([strength(id), cardio(run)], {
    startedAt: '2026-02-01T12:00:00Z',
    durationSeconds: 3600,
  });
  await save([strength(id)], { startedAt: '2026-02-02T12:00:00Z' });
  await save([], { startedAt: '2026-02-03T12:00:00Z', status: 'draft' });
  const r = await get(
    '/stats/summary?from=2026-02-01&to=2026-02-10&granularity=week',
  );
  expect(r.status, await r.clone().text()).toBe(200);
  const data = summaryResponseSchema.parse(await r.json()).data;
  expect(data.totals).toEqual({
    workoutCount: 2,
    recordedDurationWorkoutCount: 1,
    durationSeconds: 3600,
    durationCoverage: 0.5,
    strengthWorkoutCount: 2,
    cardioWorkoutCount: 1,
    cardioDurationSeconds: 1800,
  });
  expect(
    data.buckets.map((b) => [b.bucketStart, b.from, b.to, b.workoutCount]),
  ).toEqual([
    ['2026-01-26', '2026-02-01', '2026-02-02', 1],
    ['2026-02-02', '2026-02-02', '2026-02-09', 1],
    ['2026-02-09', '2026-02-09', '2026-02-10', 0],
  ]);
  expect(data.quality).toMatchObject({
    validSamples: 2,
    missing: { workoutDuration: 1 },
    excluded: { draftWorkouts: 1 },
  });
  const month = summaryResponseSchema.parse(
    await (
      await get(
        '/stats/summary?from=2026-01-31&to=2026-03-02&granularity=month',
      )
    ).json(),
  ).data;
  expect(month.buckets.map((b) => b.bucketStart)).toEqual([
    '2026-01-01',
    '2026-02-01',
    '2026-03-01',
  ]);
});
it('A08 respects stored local dates at midnight/DST boundaries and half-open query ends', async () => {
  const id = await exercise();
  await save([strength(id, 1)], {
    startedAt: '2026-03-08T07:30:00Z',
    timezone: 'America/New_York',
  });
  await save([strength(id, 1)], {
    startedAt: '2026-03-09T00:30:00Z',
    timezone: 'America/New_York',
  });
  await save([strength(id, 1)], {
    startedAt: '2026-03-09T04:30:00Z',
    timezone: 'America/New_York',
  });
  const response = await get(
    `/stats/strength?exerciseId=${id}&from=2026-03-08&to=2026-03-09`,
  );
  const data = strengthResponseSchema.parse(await response.json()).data;
  expect(data.workouts).toHaveLength(2);
  expect(data.workouts.every((w) => w.localDate === '2026-03-08')).toBe(true);
  const autumn = await save([strength(id, 1)], {
    startedAt: '2026-11-01T06:30:00Z',
    timezone: 'America/New_York',
  });
  expect(autumn.data.localDate).toBe('2026-11-01');
  expect(
    strengthResponseSchema.parse(
      await (
        await get(
          `/stats/strength?exerciseId=${id}&from=2026-11-01&to=2026-11-02`,
        )
      ).json(),
    ).data.totals.setCount,
  ).toBe(1);
});
it('empty statistics remain honest, unknown queries fail, and Agent returns identical note-free data', async () => {
  const id = await exercise();
  const empty = await strengthResult(id);
  expect(empty.totals.volumeKgReps).toBeNull();
  expect(empty.records.maxLoad).toBeNull();
  expect(empty.quality.validSamples).toBe(0);
  const summary = summaryResponseSchema.parse(
    await (
      await get('/stats/summary?from=2020-01-01&to=2020-01-03&granularity=day')
    ).json(),
  ).data;
  expect(summary.totals.durationCoverage).toBeNull();
  expect(summary.buckets).toHaveLength(2);
  for (const path of [
    '/stats/summary?from=2020-01-01&to=2026-01-01',
    '/stats/summary?includeWarmup=true',
    '/stats/strength',
    '/stats/cardio?category=invalid',
    '/stats/cardio?durationBasis=both',
    '/stats/summary?from=2026-01-01&to=2026-01-01',
  ])
    expect((await get(path)).status).toBe(400);
  for (const path of [
    `/stats/strength?${range}&exerciseId=${id}`,
    `/stats/summary?${range}`,
    `/stats/cardio?${range}`,
  ]) {
    const human = (await (await get(path)).json()) as { data: unknown };
    const agent = (await (await get(path, true)).json()) as { data: unknown };
    expect(agent.data).toEqual(human.data);
    expect(JSON.stringify(agent)).not.toContain('Synthetic private');
  }
  expect(
    (await get(`/stats/strength?${range}&exerciseId=${crypto.randomUUID()}`))
      .status,
  ).toBe(404);
});
it('metadata reports live coverage including draft/completed dates, and OpenAPI documents protected stats', async () => {
  const response = await get('/metadata');
  const metadata = metadataSchema.parse(await response.json());
  expect(metadata.data.capabilities).toContain('stats');
  const counts = await bindings.DB.prepare(
    "SELECT count(*) AS n,sum(status='completed') AS completed FROM workouts",
  ).first<{ n: number; completed: number }>();
  expect(metadata.data.coverage.workoutCount).toBe(counts?.n);
  expect(metadata.data.coverage.completedWorkoutCount).toBe(counts?.completed);
  expect(metadata.data.coverage.firstLocalDate).toBe('2026-02-01');
  for (const agent of [false, true]) {
    const doc = (await (await get('/openapi.json', agent)).json()) as {
      paths: Record<string, { get: { security: unknown } }>;
    };
    for (const path of ['/stats/summary', '/stats/strength', '/stats/cardio'])
      expect(doc.paths[path]?.get.security).toEqual([{ AccessJWT: [] }]);
  }
});

it('rejects extreme operands before persistence and reports legacy corruption explicitly', async () => {
  const id = await exercise({
    kind: 'cardio',
    measurementMode: 'cardio',
    resistanceMode: null,
    loadConvention: 'none',
    repConvention: 'not_applicable',
    volumeMultiplier: null,
    cardioCategory: 'run',
  });
  for (const distance of [1e308, 1e-308]) {
    const r = await SELF.fetch('http://127.0.0.1:5173/api/v1/workouts', {
      method: 'POST',
      headers: {
        Origin: 'http://127.0.0.1:5173',
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        startedAt: '2031-01-01T00:00:00Z',
        timezone: 'UTC',
        status: 'completed',
        durationSeconds: null,
        notes: null,
        entries: [cardio(id, 1, distance)],
      }),
    });
    expect(r.status).toBe(422);
  }
  const entry = cardio(id, 31536000, 0.001);
  const saved = await save([entry, cardio(id, 31536000, 100000000)], {
    startedAt: '2031-01-01T00:00:00Z',
  });
  const path = '/stats/cardio?from=2031-01-01&to=2031-01-02';
  expect((await get(path)).status).toBe(200);
  for (const distance of [1e308, 1e-308]) {
    await bindings.DB.prepare(
      'UPDATE cardio_records SET distance_meters=? WHERE entry_id=?',
    )
      .bind(distance, entry.id)
      .run();
    for (const agent of [false, true]) {
      const response = await get(path, agent);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: { code: 'STATS_NUMERIC_OUT_OF_RANGE' },
      });
    }
    expect(
      (await get('/stats/summary?from=2031-01-01&to=2031-01-02')).status,
    ).toBe(distance === 1e308 ? 422 : 200);
  }
  await bindings.DB.prepare('DELETE FROM workouts WHERE id=?')
    .bind(saved.data.id)
    .run();
});

it('bounds strength multiplier and cumulative volume without replacing bad samples with zero', async () => {
  const id = await exercise({ volumeMultiplier: 1000 });
  const entry = strength(id, 2);
  if (entry.kind !== 'strength') throw new Error('fixture');
  entry.sets.forEach((s) => {
    s.loadKg = 10000;
    s.reps = 1000000;
  });
  const saved = await save([entry], { startedAt: '2033-01-01T00:00:00Z' });
  const path = `/stats/strength?from=2033-01-01&to=2033-01-02&exerciseId=${id}`;
  const valid = strengthResponseSchema.parse(await (await get(path)).json());
  expect(valid.data.totals.volumeKgReps).toBe(2e13);
  await bindings.DB.prepare(
    "UPDATE workout_entries SET measurement_snapshot=json_set(measurement_snapshot,'$.volumeMultiplier',1e308) WHERE id=?",
  )
    .bind(entry.id)
    .run();
  const bad = await get(path);
  expect(bad.status).toBe(422);
  expect(await bad.json()).toMatchObject({
    error: { code: 'STATS_NUMERIC_OUT_OF_RANGE' },
  });
  await bindings.DB.prepare(
    "UPDATE workout_entries SET measurement_snapshot=json_set(measurement_snapshot,'$.volumeMultiplier',1000) WHERE id=?",
  )
    .bind(entry.id)
    .run();
  await bindings.DB.prepare(
    `WITH RECURSIVE n(i) AS (VALUES(2) UNION ALL SELECT i+1 FROM n WHERE i<1000) INSERT INTO strength_sets(id,entry_id,position,set_type,completed,reps,load_grams) SELECT printf('10000000-0000-4000-8000-%012d',i),?,i,'working',1,1000000,10000000 FROM n`,
  )
    .bind(entry.id)
    .run();
  const cumulative = await get(path);
  expect(cumulative.status).toBe(422);
  expect(await cumulative.json()).toMatchObject({
    error: { code: 'STATS_NUMERIC_OUT_OF_RANGE' },
  });
  await bindings.DB.prepare('DELETE FROM workouts WHERE id=?')
    .bind(saved.data.id)
    .run();
});

it('historical distance remains readable/exportable/correctable and numeric checks follow selected samples', async () => {
  await bindings.DB.prepare('DELETE FROM workouts').run();
  const run = await exercise({
    kind: 'cardio',
    measurementMode: 'cardio',
    resistanceMode: null,
    loadConvention: 'none',
    repConvention: 'not_applicable',
    volumeMultiplier: null,
    cardioCategory: 'run',
  });
  const lifting = await exercise();
  const c = cardio(run);
  const st = strength(lifting, 1);
  const saved = await save([c, st], { startedAt: '2034-01-01T00:00:00Z' });
  const range = 'from=2034-01-01&to=2034-01-02';
  await bindings.DB.prepare(
    'UPDATE cardio_records SET distance_meters=100000001,resistance_level=1e308 WHERE entry_id=?',
  )
    .bind(c.id)
    .run();
  const detail = await get(`/workouts/${saved.data.id}`);
  expect(detail.status).toBe(200);
  const { workoutResponseSchema } = await import('../../src/shared/workouts');
  const { backupSchema } = await import('../../src/shared/backup');
  const { toInput } = await import('../../src/web/lib');
  const data = workoutResponseSchema.parse(await detail.json()).data;
  const exported = await get('/export?format=json');
  expect(exported.status).toBe(200);
  const backup = backupSchema.parse(await exported.json());
  expect(
    backup.cardioRecords.find((row) => row.entryId === c.id)?.distanceMeters,
  ).toBe(100000001);
  expect((await get(`/stats/cardio?${range}&category=run`)).status).toBe(422);
  expect((await get(`/stats/cardio?${range}&category=cycle`)).status).toBe(200);
  expect(
    (await get(`/stats/strength?${range}&exerciseId=${lifting}`)).status,
  ).toBe(200);
  await bindings.DB.prepare(
    'UPDATE cardio_records SET completed=0 WHERE entry_id=?',
  )
    .bind(c.id)
    .run();
  expect((await get(`/stats/cardio?${range}&category=run`)).status).toBe(200);
  await bindings.DB.prepare(
    'UPDATE cardio_records SET completed=1 WHERE entry_id=?',
  )
    .bind(c.id)
    .run();
  const input = toInput(data);
  const corrected = input.entries.find((e) => e.id === c.id)!;
  if (corrected.kind !== 'cardio') throw new Error('fixture');
  corrected.cardio.distanceMeters = 5000;
  corrected.cardio.resistanceLevel = 1;
  const put = await SELF.fetch(
    `http://127.0.0.1:5173/api/v1/workouts/${data.id}`,
    {
      method: 'PUT',
      headers: {
        Origin: 'http://127.0.0.1:5173',
        'Content-Type': 'application/json',
        'If-Match': `"${data.version}"`,
      },
      body: JSON.stringify(input),
    },
  );
  expect(put.status, await put.clone().text()).toBe(200);
  expect((await get(`/stats/cardio?${range}&category=run`)).status).toBe(200);
  await bindings.DB.prepare(
    "UPDATE strength_sets SET set_type='warmup',reps=1000001 WHERE entry_id=?",
  )
    .bind(st.id)
    .run();
  expect(
    (await get(`/stats/strength?${range}&exerciseId=${lifting}`)).status,
  ).toBe(200);
  expect(
    (
      await get(
        `/stats/strength?${range}&exerciseId=${lifting}&includeWarmup=true`,
      )
    ).status,
  ).toBe(422);
  await bindings.DB.prepare(
    'UPDATE strength_sets SET completed=0 WHERE entry_id=?',
  )
    .bind(st.id)
    .run();
  expect(
    (
      await get(
        `/stats/strength?${range}&exerciseId=${lifting}&includeWarmup=true`,
      )
    ).status,
  ).toBe(200);
  await bindings.DB.prepare('DELETE FROM workouts WHERE id=?')
    .bind(saved.data.id)
    .run();
});
