#!/usr/bin/env python3
"""Restore a HealthWorker JSON backup into a NEW isolated local SQLite database.

Usage: python3 scripts/restore-local.py backup.json --new-local-db /tmp/restore.sqlite
No network, credentials, remote D1, existing database, or overwrite option is supported.
Apply the repository's append-only migrations before parameterized, atomic inserts.
"""
import argparse
import re
from datetime import datetime
from zoneinfo import ZoneInfo
import uuid
import json
import os
from pathlib import Path
import sqlite3
import sys

LIMIT = 20 * 1024 * 1024
TABLES = {
    'settings': ('settings', ['id', 'timezone', 'locale', 'unitSystem', 'theme', 'version', 'createdAt', 'updatedAt']),
    'exercises': ('exercises', ['id', 'name', 'aliases', 'kind', 'equipment', 'muscleGroups', 'measurementMode', 'resistanceMode', 'loadConvention', 'repConvention', 'volumeMultiplier', 'cardioCategory', 'isBuiltin', 'archivedAt', 'version', 'createdAt', 'updatedAt']),
    'workouts': ('workouts', ['id', 'startedAt', 'timezone', 'localDate', 'status', 'durationSeconds', 'notes', 'version', 'createdAt', 'updatedAt']),
    'entries': ('workout_entries', ['id', 'workoutId', 'exerciseId', 'position', 'kind', 'exerciseNameSnapshot', 'measurementSnapshot', 'notes']),
    'strengthSets': ('strength_sets', ['id', 'entryId', 'position', 'setType', 'completed', 'reps', 'durationSeconds', 'loadKg', 'assistanceKg', 'effortType', 'effortValue', 'notes']),
    'cardioRecords': ('cardio_records', ['id', 'entryId', 'completed', 'durationSeconds', 'durationBasis', 'distanceMeters', 'averageHeartRate', 'maxHeartRate', 'elevationGainMeters', 'inclinePercent', 'resistanceLevel', 'deviceCaloriesKcal']),
}

def snake(name):
    return ''.join('_' + c.lower() if c.isupper() else c for c in name)

def iso_instant(value, minimum_year=0):
    # Same UTC-only ISO shape as z.iso.datetime(): required seconds, optional fraction.
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z', value, re.ASCII):
        raise ValueError('Invalid ISO instant')
    # Python cannot represent ISO year 0000; use leap year 2000 to validate
    # its month/day for audit scalars (never used for workout arithmetic).
    parsed = datetime.fromisoformat(('2000' + value[4:] if value[:4] == '0000' else value).replace('Z', '+00:00'))
    if int(value[:4]) < minimum_year:
        raise ValueError('Unsupported instant year')
    return parsed

def validate_document(data):
    if not isinstance(data, dict) or set(data) != {'schemaVersion', 'definitionsVersion', 'exportedAt', *TABLES}:
        raise ValueError('Unknown backup shape')
    if data['schemaVersion'] != '1' or data['definitionsVersion'] != '1':
        raise ValueError('Unsupported backup version')
    iso_instant(data['exportedAt'])
    total = 0
    for key, (_, fields) in TABLES.items():
        rows = ([] if data[key] is None else [data[key]]) if key == 'settings' else data[key]
        if not isinstance(rows, list):
            raise ValueError('Invalid table array')
        total += len(rows)
        for row in rows:
            if not isinstance(row, dict) or set(row) != set(fields):
                raise ValueError('Unknown or missing row fields')
            for field, value in row.items():
                if field in ('startedAt', 'createdAt', 'updatedAt', 'archivedAt'):
                    if field != 'archivedAt' or value is not None:
                        iso_instant(value, 1900 if key == 'workouts' else 0)
                if field == 'localDate':
                    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value, re.ASCII):
                        raise ValueError('Invalid local date')
                    iso_instant(value + 'T00:00:00Z', 1900)
                if field == 'timezone':
                    if not isinstance(value, str) or len(value) > 100:
                        raise ValueError('Invalid timezone')
                    ZoneInfo(value)
                if isinstance(value, (dict, list)) and field not in ('aliases', 'muscleGroups', 'measurementSnapshot'):
                    raise ValueError('Unexpected nested field')
    if total > 150000:
        raise ValueError('Too many rows')
    for key in ('exercises', 'workouts', 'entries', 'strengthSets', 'cardioRecords'):
        for row in data[key]:
            if not isinstance(row['id'], str):
                raise ValueError('Invalid UUID type')
            uuid.UUID(row['id'])
            for field in ('workoutId', 'exerciseId', 'entryId'):
                if field in row:
                    if not isinstance(row[field], str):
                        raise ValueError('Invalid UUID type')
                    uuid.UUID(row[field])
    for workout in data['workouts']:
        instant = iso_instant(workout['startedAt'], 1900)
        local = instant.astimezone(ZoneInfo(workout['timezone'])).date()
        if local.year < 1900 or local.isoformat() != workout['localDate']:
            raise ValueError('Invalid workout time/local date')
    if data['settings'] is not None:
        ZoneInfo(data['settings']['timezone'])
    modes = {'measurementMode', 'resistanceMode', 'loadConvention', 'repConvention', 'volumeMultiplier'}
    for entry in data['entries']:
        snapshot = entry['measurementSnapshot']
        if not isinstance(snapshot, dict) or set(snapshot) != modes:
            raise ValueError('Invalid measurement snapshot')
        if snapshot['measurementMode'] not in ('reps', 'duration', 'cardio') or snapshot['resistanceMode'] not in ('external', 'bodyweight', 'assisted', None):
            raise ValueError('Invalid measurement mode')
        if snapshot['loadConvention'] not in ('total', 'per_implement', 'none') or snapshot['repConvention'] not in ('total', 'per_side', 'not_applicable'):
            raise ValueError('Invalid measurement convention')
        multiplier = snapshot['volumeMultiplier']
        if multiplier is not None and (isinstance(multiplier, bool) or not isinstance(multiplier, (int, float)) or multiplier <= 0):
            raise ValueError('Invalid multiplier')
        if (entry['kind'] == 'cardio') != (snapshot['measurementMode'] == 'cardio'):
            raise ValueError('Invalid snapshot kind')
    entries = {e['id']: e for e in data['entries']}
    by_workout, sets_by_entry, cardio_by_entry = {}, {}, {}
    for entry in data['entries']:
        by_workout.setdefault(entry['workoutId'], []).append(entry)
    for sample in data['strengthSets']:
        entry = entries.get(sample['entryId'])
        if entry is None or entry['kind'] != 'strength':
            raise ValueError('Invalid set reference')
        snapshot = entry['measurementSnapshot']
        reps, duration = sample['reps'], sample['durationSeconds']
        load, assistance, completed = sample['loadKg'], sample['assistanceKg'], sample['completed']
        if not isinstance(completed, bool):
            raise ValueError('Invalid completion flag')
        if (reps is not None and duration is not None) or (load is not None and assistance is not None):
            raise ValueError('Mutually exclusive measurements')
        if snapshot['measurementMode'] == 'reps' and (duration is not None or (completed and reps is None)):
            raise ValueError('Repetition measurement required')
        if snapshot['measurementMode'] == 'duration' and (reps is not None or (completed and duration is None)):
            raise ValueError('Duration measurement required')
        if snapshot['resistanceMode'] == 'assisted':
            if load is not None or (completed and assistance is None):
                raise ValueError('Assistance measurement required')
        elif assistance is not None or (snapshot['resistanceMode'] == 'external' and completed and load is None):
            raise ValueError('External load measurement required')
        sets_by_entry.setdefault(sample['entryId'], []).append(sample)
    for sample in data['cardioRecords']:
        if entries.get(sample['entryId'], {}).get('kind') != 'cardio':
            raise ValueError('Invalid cardio reference')
        if not isinstance(sample['completed'], bool) or (sample['completed'] and sample['durationSeconds'] is None):
            raise ValueError('Invalid cardio completion')
        cardio_by_entry.setdefault(sample['entryId'], []).append(sample)
    for workout in data['workouts']:
        group = by_workout.get(workout['id'], [])
        if workout['status'] == 'completed' and not group:
            raise ValueError('Completed workout cannot be empty')
        for entry in group:
            sets = sets_by_entry.get(entry['id'], [])
            cardio = cardio_by_entry.get(entry['id'], [])
            if entry['kind'] == 'cardio' and len(cardio) != 1:
                raise ValueError('Cardio requires one detail')
            if workout['status'] == 'completed':
                samples = sets if entry['kind'] == 'strength' else cardio
                if not samples or any(not sample['completed'] for sample in samples):
                    raise ValueError('Completed workout has incomplete children')

def restore(source, target):
    source = Path(source).resolve()
    target = Path(target).absolute()
    if source.stat().st_size > LIMIT:
        raise ValueError('Backup exceeds 20MiB')
    data = json.loads(source.read_text(encoding='utf-8'), parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Non-finite JSON number')))
    validate_document(data)
    # O_EXCL also rejects symlink targets; never open or overwrite an existing DB.
    fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    connection = None
    try:
        connection = sqlite3.connect(target)
        connection.execute('PRAGMA foreign_keys=ON')
        migrations = Path(__file__).resolve().parents[1] / 'migrations'
        for migration in sorted(migrations.glob('*.sql')):
            connection.executescript(migration.read_text(encoding='utf-8'))
        with connection:
            for key, (table, fields) in TABLES.items():
                rows = ([] if data[key] is None else [data[key]]) if key == 'settings' else data[key]
                columns = [snake(f) if f not in ('loadKg', 'assistanceKg') else ('load_grams' if f == 'loadKg' else 'assistance_grams') for f in fields]
                query = f"INSERT INTO {table} ({','.join(columns)}) VALUES ({','.join('?' for _ in fields)})"
                values = []
                for row in rows:
                    converted = []
                    for field in fields:
                        value = row[field]
                        if field in ('loadKg', 'assistanceKg') and value is not None:
                            if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0 or value > 10000 or abs(value * 1000 - round(value * 1000)) > 1e-7:
                                raise ValueError('Invalid kg value')
                            value = round(value * 1000)
                        if field in ('aliases', 'muscleGroups', 'measurementSnapshot'):
                            value = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
                        converted.append(value)
                    values.append(converted)
                connection.executemany(query, values)
                if connection.execute(f'SELECT count(*) FROM {table}').fetchone()[0] != len(rows):
                    raise ValueError('Row count mismatch')
            if connection.execute('PRAGMA foreign_key_check').fetchall():
                raise ValueError('Foreign key check failed')
            if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('Integrity check failed')
            if connection.execute("SELECT 1 FROM strength_sets s JOIN workout_entries e ON e.id=s.entry_id WHERE e.kind<>'strength' UNION ALL SELECT 1 FROM cardio_records c JOIN workout_entries e ON e.id=c.entry_id WHERE e.kind<>'cardio' LIMIT 1").fetchone():
                raise ValueError('Child kind mismatch')
            if connection.execute('SELECT 1 FROM workout_entries e JOIN exercises x ON x.id=e.exercise_id WHERE e.kind<>x.kind LIMIT 1').fetchone():
                raise ValueError('Exercise kind mismatch')
        connection.close()
        connection = None
    except Exception:
        if connection is not None:
            connection.close()
        target.unlink(missing_ok=True)
        raise

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('backup')
    parser.add_argument('--new-local-db', required=True, help='New isolated local SQLite file; existing paths are refused')
    args = parser.parse_args()
    try:
        restore(args.backup, args.new_local_db)
    except (ValueError, OSError, sqlite3.Error, KeyError, TypeError, OverflowError) as error:
        print('Restore refused or failed (' + type(error).__name__ + '); no existing database was changed.', file=sys.stderr)
        return 1
    print('Restored into a new isolated local SQLite database; not uploaded to D1.')
    return 0

if __name__ == '__main__':
    sys.exit(main())
