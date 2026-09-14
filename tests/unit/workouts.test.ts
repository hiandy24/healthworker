import { describe, expect, it } from 'vitest';
import {
  cardioInputSchema,
  strengthSetInputSchema,
  validateStrengthMeasurement,
  workoutInputSchema,
  type StrengthSetInput,
  type WorkoutInput,
} from '../../src/shared/workouts';
import { exerciseInputSchema } from '../../src/shared/exercises';
import parity from '../skill/import-parity.json';

it('matches the importer shared UUID and JSON integer regression matrix', () => {
  for (const { value, valid } of parity.uuids) {
    for (const field of ['id', 'exerciseId']) {
      const body = workout();
      const parsed = workoutInputSchema.safeParse({
        ...body,
        entries: [{ ...body.entries[0], [field]: value }],
      });
      expect(
        parsed.success,
        JSON.stringify({ value, field, error: parsed.error }),
      ).toBe(valid);
    }
    expect(
      strengthSetInputSchema.safeParse({ ...set, id: value }).success,
    ).toBe(valid);
  }
  const cardio = {
    completed: false,
    durationSeconds: null,
    durationBasis: 'elapsed',
    distanceMeters: null,
    averageHeartRate: null,
    maxHeartRate: null,
    elevationGainMeters: null,
    inclinePercent: null,
    resistanceLevel: null,
    deviceCaloriesKcal: null,
  };
  for (const { value, valid } of parity.integers) {
    expect(
      workoutInputSchema.safeParse({ ...workout(), durationSeconds: value })
        .success,
    ).toBe(valid);
    for (const field of ['reps', 'durationSeconds'])
      expect(
        strengthSetInputSchema.safeParse({
          ...set,
          completed: false,
          reps: null,
          [field]: value,
        }).success,
      ).toBe(valid);
    for (const field of ['durationSeconds', 'averageHeartRate', 'maxHeartRate'])
      expect(
        cardioInputSchema.safeParse({ ...cardio, [field]: value }).success,
      ).toBe(valid);
  }
});

const set: StrengthSetInput = {
  id: crypto.randomUUID(),
  setType: 'working',
  completed: true,
  reps: 5,
  durationSeconds: null,
  loadKg: 0,
  assistanceKg: null,
  effortType: null,
  effortValue: null,
  notes: null,
};
const measurement = {
  measurementMode: 'reps' as const,
  resistanceMode: 'external' as const,
  loadConvention: 'total' as const,
  repConvention: 'total' as const,
  volumeMultiplier: 1,
};
const workout = (): WorkoutInput => ({
  startedAt: '2026-01-01T00:00:00Z',
  timezone: 'UTC',
  status: 'completed',
  durationSeconds: null,
  notes: null,
  entries: [
    {
      id: crypto.randomUUID(),
      exerciseId: crypto.randomUUID(),
      kind: 'strength',
      notes: null,
      sets: [{ ...set, id: crypto.randomUUID() }],
    },
  ],
});
describe('M2 trusted measurement and strict write contracts', () => {
  it('rejects incomplete completed aggregates, empty/51-set entries and forged entry snapshots', () => {
    const value = workout();
    const entry = value.entries[0]!;
    if (entry.kind !== 'strength') throw new Error('fixture');
    for (const sets of [
      [],
      [{ ...set, completed: false }],
      Array.from({ length: 51 }, () => ({ ...set, id: crypto.randomUUID() })),
    ]) {
      expect(
        workoutInputSchema.safeParse({
          ...value,
          entries: [{ ...entry, sets }],
        }).success,
      ).toBe(false);
    }
    expect(
      workoutInputSchema.safeParse({
        ...value,
        status: 'draft',
        entries: [
          {
            ...entry,
            sets: [{ ...set, completed: false, reps: null, loadKg: null }],
          },
        ],
      }).success,
    ).toBe(true);
    for (const forged of [
      { exerciseNameSnapshot: 'Forged' },
      { measurementSnapshot: measurement },
    ])
      expect(
        workoutInputSchema.safeParse({
          ...value,
          entries: [{ ...entry, ...forged }],
        }).success,
      ).toBe(false);
    const cardio = {
      completed: false,
      durationSeconds: null,
      durationBasis: 'elapsed',
      distanceMeters: null,
      averageHeartRate: null,
      maxHeartRate: null,
      elevationGainMeters: null,
      inclinePercent: null,
      resistanceLevel: null,
      deviceCaloriesKcal: null,
    };
    const incomplete = {
      ...value,
      entries: [
        {
          id: crypto.randomUUID(),
          exerciseId: crypto.randomUUID(),
          kind: 'cardio',
          notes: null,
          cardio,
        },
      ],
    };
    expect(workoutInputSchema.safeParse(incomplete).success).toBe(false);
    expect(
      workoutInputSchema.safeParse({ ...incomplete, status: 'draft' }).success,
    ).toBe(true);
  });
  it('distinguishes missing weight from explicit zero and preserves bodyweight semantics', () => {
    expect(validateStrengthMeasurement(set, measurement)).toEqual([]);
    expect(
      validateStrengthMeasurement({ ...set, loadKg: null }, measurement),
    ).not.toEqual([]);
    expect(
      validateStrengthMeasurement(
        { ...set, loadKg: null },
        {
          ...measurement,
          resistanceMode: 'bodyweight',
          volumeMultiplier: null,
        },
      ),
    ).toEqual([]);
    expect(
      validateStrengthMeasurement(
        { ...set, loadKg: null, assistanceKg: 0 },
        { ...measurement, resistanceMode: 'assisted', volumeMultiplier: null },
      ),
    ).toEqual([]);
    expect(
      validateStrengthMeasurement(set, {
        ...measurement,
        resistanceMode: 'assisted',
        volumeMultiplier: null,
      }),
    ).not.toEqual([]);
  });
  it('requires timed measurement and rejects mutually exclusive fields even in drafts', () => {
    expect(
      validateStrengthMeasurement(set, {
        ...measurement,
        measurementMode: 'duration',
      }),
    ).not.toEqual([]);
    expect(
      strengthSetInputSchema.safeParse({
        ...set,
        completed: false,
        assistanceKg: 2,
      }).success,
    ).toBe(false);
    expect(
      strengthSetInputSchema.safeParse({
        ...set,
        completed: false,
        durationSeconds: 5,
      }).success,
    ).toBe(false);
    expect(
      strengthSetInputSchema.safeParse({ ...set, loadKg: -1 }).success,
    ).toBe(false);
    expect(
      strengthSetInputSchema.safeParse({ ...set, loadKg: 1.0001 }).success,
    ).toBe(false);
  });
  it('validates paired effort fields and exact increments', () => {
    for (const [effortType, effortValue, valid] of [
      ['rpe', 9.5, true],
      ['rpe', 9.2, false],
      ['rir', 0, true],
      ['rir', 0.5, false],
      [null, 2, false],
      ['rpe', null, false],
    ] as const)
      expect(
        strengthSetInputSchema.safeParse({ ...set, effortType, effortValue })
          .success,
      ).toBe(valid);
  });
  it('rejects forged snapshots, unknown fields, empty completed records and duplicate IDs', () => {
    expect(workoutInputSchema.safeParse(workout()).success).toBe(true);
    expect(
      workoutInputSchema.safeParse({ ...workout(), entries: [] }).success,
    ).toBe(false);
    expect(
      workoutInputSchema.safeParse({
        ...workout(),
        status: 'draft',
        entries: [],
      }).success,
    ).toBe(true);
    const value = workout();
    value.entries.push(value.entries[0]!);
    expect(workoutInputSchema.safeParse(value).success).toBe(false);
    expect(
      workoutInputSchema.safeParse({ ...workout(), version: 1 }).success,
    ).toBe(false);
    expect(
      exerciseInputSchema.safeParse({
        ...measurement,
        name: 'Synthetic',
        aliases: [],
        kind: 'strength',
        equipment: null,
        muscleGroups: [],
        cardioCategory: null,
        isBuiltin: true,
      }).success,
    ).toBe(false);
  });
  it('enforces 50 entries, 50 sets each and 300 sets in aggregate', () => {
    const value = workout();
    const entry = value.entries[0]!;
    if (entry.kind !== 'strength') throw new Error('fixture');
    value.entries = Array.from({ length: 6 }, () => ({
      ...entry,
      id: crypto.randomUUID(),
      sets: Array.from({ length: 50 }, () => ({
        ...set,
        id: crypto.randomUUID(),
      })),
    }));
    expect(workoutInputSchema.safeParse(value).success).toBe(true);
    value.entries.push({
      ...entry,
      id: crypto.randomUUID(),
      sets: [{ ...set, id: crypto.randomUUID() }],
    });
    expect(workoutInputSchema.safeParse(value).success).toBe(false);
    expect(
      workoutInputSchema.safeParse({
        ...workout(),
        entries: Array.from({ length: 51 }, () => ({
          ...entry,
          id: crypto.randomUUID(),
          sets: [],
        })),
        status: 'draft',
      }).success,
    ).toBe(false);
  });
  it('requires completed cardio duration and ordered heart rates without zero-filling missing distance', () => {
    const cardio = {
      completed: true,
      durationSeconds: 1800,
      durationBasis: 'elapsed',
      distanceMeters: null,
      averageHeartRate: null,
      maxHeartRate: null,
      elevationGainMeters: null,
      inclinePercent: null,
      resistanceLevel: null,
      deviceCaloriesKcal: null,
    };
    expect(cardioInputSchema.parse(cardio).distanceMeters).toBeNull();
    expect(
      cardioInputSchema.safeParse({ ...cardio, durationSeconds: null }).success,
    ).toBe(false);
    expect(
      cardioInputSchema.safeParse({
        ...cardio,
        averageHeartRate: 160,
        maxHeartRate: 150,
      }).success,
    ).toBe(false);
    expect(
      cardioInputSchema.safeParse({
        ...cardio,
        completed: false,
        durationSeconds: null,
      }).success,
    ).toBe(true);
  });
});

it('checks every numeric operand limit including nullable and inclusive boundaries', () => {
  const cardio = {
    completed: false,
    durationSeconds: null,
    durationBasis: 'elapsed',
    distanceMeters: null,
    averageHeartRate: null,
    maxHeartRate: null,
    elevationGainMeters: null,
    inclinePercent: null,
    resistanceLevel: null,
    deviceCaloriesKcal: null,
  };
  for (const [field, max] of Object.entries({
    durationSeconds: 31536000,
    distanceMeters: 100000000,
    averageHeartRate: 1000,
    maxHeartRate: 1000,
    elevationGainMeters: 10000000,
    inclinePercent: 100,
    resistanceLevel: 1000000,
    deviceCaloriesKcal: 100000000,
  })) {
    expect(
      cardioInputSchema.safeParse({ ...cardio, [field]: max }).success,
    ).toBe(true);
    expect(
      cardioInputSchema.safeParse({ ...cardio, [field]: max + 1 }).success,
    ).toBe(false);
    expect(
      cardioInputSchema.safeParse({ ...cardio, [field]: 1e308 }).success,
    ).toBe(false);
  }
  for (const distance of [0, 0.001, 100000000, null])
    expect(
      cardioInputSchema.safeParse({ ...cardio, distanceMeters: distance })
        .success,
    ).toBe(true);
  expect(
    cardioInputSchema.safeParse({ ...cardio, distanceMeters: 1e-308 }).success,
  ).toBe(false);
  for (const [field, max] of Object.entries({
    reps: 1000000,
    durationSeconds: 31536000,
    loadKg: 10000,
    assistanceKg: 10000,
  })) {
    const base = { ...set, completed: false, reps: null, loadKg: null };
    expect(
      strengthSetInputSchema.safeParse({ ...base, [field]: max }).success,
    ).toBe(true);
    expect(
      strengthSetInputSchema.safeParse({ ...base, [field]: max + 1 }).success,
    ).toBe(false);
  }
  expect(
    workoutInputSchema.safeParse({ ...workout(), durationSeconds: 31536001 })
      .success,
  ).toBe(false);
});
