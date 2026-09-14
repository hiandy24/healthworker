import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
it('all append-only migrations initialize a fresh SQLite with working guards; isolated Drizzle generation is clean', () => {
  const root = mkdtempSync(join(tmpdir(), 'healthworker-migrations-'));
  try {
    const out = join(root, 'migrations');
    cpSync(resolve('migrations'), out, { recursive: true });
    const before = readdirSync(out).sort();
    const journal = JSON.parse(
      readFileSync(join(out, 'meta/_journal.json'), 'utf8'),
    );
    expect(journal.entries.map((e: { tag: string }) => `${e.tag}.sql`)).toEqual(
      before.filter((n) => n.endsWith('.sql')),
    );
    const output = execFileSync(
      'npx',
      [
        'pnpm@10.34.5',
        'exec',
        'drizzle-kit',
        'generate',
        '--dialect',
        'sqlite',
        '--schema',
        './src/worker/db/schema.ts',
        '--out',
        relative(process.cwd(), out),
      ],
      { encoding: 'utf8' },
    );
    expect(output).toContain('No schema changes');
    expect(readdirSync(out).sort()).toEqual(before);
    const result = execFileSync(
      'python3',
      [
        '-c',
        `import sqlite3,sys,pathlib
c=sqlite3.connect(sys.argv[2])
c.execute('PRAGMA foreign_keys=ON')
for p in sorted(pathlib.Path(sys.argv[1]).glob('*.sql')): c.executescript(p.read_text())
for kind, message in [('cas','WORKOUT_VERSION_CONFLICT'),('exercise','EXERCISE_REFERENCE_CONFLICT')]:
 try: c.execute('INSERT INTO workout_write_guards VALUES (?,?,0)', (kind,kind))
 except sqlite3.IntegrityError as e: assert message in str(e)
 else: raise AssertionError('guard did not reject')
assert c.execute('SELECT count(*) FROM workout_write_guards').fetchone()[0]==0
assert len(c.execute("SELECT name FROM sqlite_master WHERE type='trigger'").fetchall())==3
assert c.execute("SELECT name FROM sqlite_master WHERE name='workouts_history_order'").fetchone()
assert not c.execute('PRAGMA foreign_key_check').fetchall()
print('fresh migration and guards passed')`,
        out,
        join(root, 'new.sqlite'),
      ],
      { encoding: 'utf8' },
    );
    expect(result).toContain('fresh migration and guards passed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
