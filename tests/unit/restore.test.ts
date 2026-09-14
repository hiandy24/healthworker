import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';
import { backupSchema } from '../../src/shared/backup';
it('restores a synthetic versioned backup to new local SQLite preserving IDs references notes snapshots and statistics, refuses overwrite', () => {
  const root = mkdtempSync(join(tmpdir(), 'healthworker-restore-'));
  const id = crypto.randomUUID(),
    workoutId = crypto.randomUUID(),
    entryId = crypto.randomUUID();
  const now = '2026-01-01T12:00:00.000Z';
  const measurement = {
    measurementMode: 'reps',
    resistanceMode: 'external',
    loadConvention: 'total',
    repConvention: 'total',
    volumeMultiplier: 1,
  };
  const backup = backupSchema.parse({
    schemaVersion: '1',
    definitionsVersion: '1',
    exportedAt: now,
    settings: null,
    exercises: [
      {
        ...measurement,
        id,
        name: 'Synthetic',
        aliases: [],
        kind: 'strength',
        equipment: null,
        muscleGroups: [],
        cardioCategory: null,
        isBuiltin: false,
        archivedAt: now,
        createdAt: now,
        updatedAt: now,
        version: 2,
      },
    ],
    workouts: [
      {
        id: workoutId,
        startedAt: now,
        timezone: 'UTC',
        localDate: '2026-01-01',
        status: 'completed',
        durationSeconds: null,
        notes: "Synthetic quoted ' note\nline",
        version: 4,
        createdAt: now,
        updatedAt: now,
      },
    ],
    entries: [
      {
        id: entryId,
        workoutId,
        exerciseId: id,
        position: 0,
        kind: 'strength',
        exerciseNameSnapshot: 'Synthetic old',
        measurementSnapshot: measurement,
        notes: 'Synthetic entry',
      },
    ],
    strengthSets: Array.from({ length: 3 }, (_, position) => ({
      id: crypto.randomUUID(),
      entryId,
      position,
      setType: 'working',
      completed: true,
      reps: 5,
      durationSeconds: null,
      loadKg: 100,
      assistanceKg: null,
      effortType: null,
      effortValue: null,
      notes: 'Synthetic set',
    })),
    cardioRecords: [],
  });
  const input = join(root, 'backup.json'),
    target = join(root, 'new.sqlite'),
    script = resolve('scripts/restore-local.py');
  writeFileSync(input, JSON.stringify(backup));
  try {
    execFileSync('python3', [script, input, '--new-local-db', target]);
    const inspected = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          `import sqlite3,json,sys\nc=sqlite3.connect(sys.argv[1])\nprint(json.dumps({'workout':c.execute('select id,version,notes from workouts').fetchone(),'entry':c.execute('select id,exercise_id,exercise_name_snapshot from workout_entries').fetchone(),'volume':c.execute("select sum(s.load_grams/1000.0*s.reps*json_extract(e.measurement_snapshot,'$.volumeMultiplier')) from strength_sets s join workout_entries e on e.id=s.entry_id").fetchone()[0],'foreignKeys':c.execute('pragma foreign_key_check').fetchall()}))`,
          target,
        ],
        { encoding: 'utf8' },
      ),
    );
    expect(inspected).toEqual({
      workout: [workoutId, 4, backup.workouts[0]!.notes],
      entry: [entryId, id, 'Synthetic old'],
      volume: 1500,
      foreignKeys: [],
    });
    expect(
      spawnSync('python3', [script, input, '--new-local-db', target]).status,
    ).toBe(1);
    expect(existsSync(target)).toBe(true);
    const bad = join(root, 'bad.sqlite');
    // Historical values outside new-write limits remain TS/Python backup-compatible.
    const historical = {
      ...backup,
      workouts: backup.workouts.map((w) => ({
        ...w,
        durationSeconds: 31536001,
      })),
      strengthSets: backup.strengthSets.map((s) => ({ ...s, reps: 1000001 })),
      entries: backup.entries.map((e) => ({
        ...e,
        measurementSnapshot: {
          ...e.measurementSnapshot,
          volumeMultiplier: 1001,
        },
      })),
    };
    expect(backupSchema.safeParse(historical).success).toBe(true);
    writeFileSync(input, JSON.stringify(historical));
    const legacyTarget = join(root, 'historical.sqlite');
    expect(
      spawnSync('python3', [script, input, '--new-local-db', legacyTarget], {
        encoding: 'utf8',
      }).status,
    ).toBe(0);
    const duration = execFileSync(
      'python3',
      [
        '-c',
        "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('select duration_seconds from workouts').fetchone()[0])",
        legacyTarget,
      ],
      { encoding: 'utf8' },
    );
    expect(duration.trim()).toBe('31536001');
    const dateInvalid = [
      5,
      true,
      null,
      {},
      [],
      '',
      '2026-02-30T00:00:00Z',
      '2026-01-01T00:00:00+00:00',
      '2026-01-01 00:00:00Z',
    ];
    const settings = {
      id: 'singleton',
      timezone: 'UTC',
      locale: 'zh-CN',
      unitSystem: 'metric',
      theme: 'auto',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const dateCases = dateInvalid.flatMap((value) => [
      ...['createdAt', 'updatedAt'].map((field) => ({
        ...backup,
        settings: { ...settings, [field]: value },
      })),
      { ...backup, exportedAt: value },
      ...['startedAt', 'createdAt', 'updatedAt', 'localDate'].map((field) => ({
        ...backup,
        workouts: [{ ...backup.workouts[0], [field]: value }],
      })),
      ...['createdAt', 'updatedAt', 'archivedAt']
        .filter((field) => field !== 'archivedAt' || value !== null)
        .map((field) => ({
          ...backup,
          exercises: [{ ...backup.exercises[0], [field]: value }],
        })),
    ]);
    for (const invalid of [
      ...dateCases,
      { ...backup, exercises: [{ ...backup.exercises[0], id: 5 }] },
      {
        ...backup,
        strengthSets: [
          {
            ...backup.strengthSets[0],
            reps: null,
            durationSeconds: 60,
            loadKg: null,
            assistanceKg: 20,
          },
        ],
      },
      {
        ...backup,
        strengthSets: [{ ...backup.strengthSets[0], completed: false }],
      },
      { ...backup, strengthSets: [] },
      { ...backup, entries: [], strengthSets: [] },
    ]) {
      expect(backupSchema.safeParse(invalid).success).toBe(false);
      writeFileSync(input, JSON.stringify(invalid));
      const refused = spawnSync(
        'python3',
        [script, input, '--new-local-db', bad],
        { encoding: 'utf8' },
      );
      expect(refused.status).toBe(1);
      expect(refused.stderr).not.toContain('Traceback');
      expect(existsSync(bad)).toBe(false);
    }
    for (const [instant, zone, localDate] of [
      ['1900-01-01T00:00:00Z', 'UTC', '1900-01-01'],
      ['9999-12-31T23:59:59.999Z', 'UTC', '9999-12-31'],
      ['2024-03-10T07:00:00Z', 'America/New_York', '2024-03-10'],
      ['2024-01-01T00:30:00Z', 'America/Los_Angeles', '2023-12-31'],
    ]) {
      const valid = {
        ...backup,
        exportedAt: '0000-02-29T00:00:00Z',
        settings,
        workouts: [
          {
            ...backup.workouts[0],
            startedAt: instant,
            timezone: zone,
            localDate,
          },
        ],
      };
      expect(backupSchema.safeParse(valid).success).toBe(true);
      writeFileSync(input, JSON.stringify(valid));
      const restored = spawnSync(
        'python3',
        [script, input, '--new-local-db', bad],
        { encoding: 'utf8' },
      );
      expect(restored.status, restored.stderr).toBe(0);
      rmSync(bad);
    }
    writeFileSync(
      input,
      JSON.stringify({
        ...backup,
        entries: [{ ...backup.entries[0], exerciseId: crypto.randomUUID() }],
      }),
    );
    expect(
      spawnSync('python3', [script, input, '--new-local-db', bad]).status,
    ).toBe(1);
    expect(existsSync(bad)).toBe(false);
    expect(
      spawnSync('python3', [script, input, '--new-local-db', bad, '--remote'])
        .status,
    ).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
