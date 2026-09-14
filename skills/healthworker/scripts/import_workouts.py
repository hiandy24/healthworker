"""Deterministic create-only batch workflow; no arbitrary-file inference."""
import datetime as dt
import hashlib
import json
import os
import math
import re
from pathlib import Path
import time
import uuid
from zoneinfo import ZoneInfo


def input_uuid(value):
    """Zod 4 .uuid() write domain; do not narrow historical read helpers."""
    if not isinstance(value, str) or not re.fullmatch(
        r'(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)',
        value,
    ):
        raise ValueError('Invalid input UUID')
    return value


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, allow_nan=False, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def execute(hw, args, client, env):
    def check(ok, message='Invalid deterministic batch or plan.'):
        if not ok:
            raise hw.ClientError('IMPORT_BLOCKED', message, 2)

    def load(path):
        raw = Path(path).read_bytes()
        check(len(raw) <= hw.MAX_BYTES)
        value = json.loads(raw, parse_constant=hw.reject_constant, object_pairs_hook=hw.unique_object)
        # Never persist or submit environment credentials accidentally embedded in input/API data.
        rendered = canonical(value)
        check(not any(secret and json.dumps(secret)[1:-1] in rendered for secret in
                      (env.get('HEALTHWORKER_ACCESS_CLIENT_ID'), env.get('HEALTHWORKER_ACCESS_CLIENT_SECRET'))),
              'Input contains credential material; remove it privately.')
        return value

    def save(path, value, exclusive=False):
        rendered = canonical(value)
        check(not any(secret and json.dumps(secret)[1:-1] in rendered for secret in
                      (env.get('HEALTHWORKER_ACCESS_CLIENT_ID'), env.get('HEALTHWORKER_ACCESS_CLIENT_SECRET'))))
        if exclusive:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as output:
                output.write(rendered); output.flush(); os.fsync(output.fileno())
        else:
            temporary = str(path) + '.' + str(uuid.uuid4()) + '.tmp'
            save(temporary, value, True)
            os.replace(temporary, path)

    metadata = client.metadata()
    check('workouts:create' in metadata['data']['capabilities'], 'Token lacks workouts:create; ask the owner, never bypass authentication.')
    batch = load(args.input)
    check(type(batch) is dict and set(batch) == {'version', 'batchId', 'workouts'})
    check(batch['version'] == 1)
    input_uuid(batch['batchId'])
    check(type(batch['workouts']) is list and 1 <= len(batch['workouts']) <= 1000)
    source_hash = digest(batch)
    identities = set()
    dates = []
    for row in batch['workouts']:
        check(type(row) is dict and set(row) == {'sourceId', 'body'})
        check(hw.bounded_text(row['sourceId'], 200) and row['sourceId'] and row['sourceId'] not in identities)
        identities.add(row['sourceId'])
        body = row['body']
        check(type(body) is dict and set(body) == {'startedAt', 'timezone', 'status', 'durationSeconds', 'notes', 'entries'})
        check(body['status'] in ('draft', 'completed'))
        check(type(body['startedAt']) is str and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z', body['startedAt']))
        check(int(body['startedAt'][:4]) >= 1900)
        check(type(body['timezone']) is str and len(body['timezone']) <= 100)
        date = dt.datetime.fromisoformat(body['startedAt']).astimezone(ZoneInfo(body['timezone'])).date()
        hw.date_value(date.isoformat()); dates.append(date)
        check(date < dt.date(9999, 12, 31), 'Last supported date cannot be duplicate-checked; use human review.')
        check(type(body['entries']) is list and len(body['entries']) <= 50)
        check(body['status'] != 'completed' or bool(body['entries']))
        check(len(canonical(body).encode()) <= 512 * 1024)
        def notes(value):
            check(value is None or (type(value) is str and len(value) <= 4000))
        def number(value, maximum, integer=False, minimum=0):
            check(value is None or (type(value) in (int, float) and math.isfinite(value) and (not integer or value == math.trunc(value)) and minimum <= value <= maximum))
        notes(body['notes']); number(body['durationSeconds'], 31536000, True, 1)
        ids = set()
        set_count = 0
        for entry in body['entries']:
            check(type(entry) is dict and entry.get('kind') in ('strength', 'cardio'))
            check(set(entry) == {'id', 'exerciseId', 'kind', 'notes', 'sets' if entry['kind'] == 'strength' else 'cardio'})
            input_uuid(entry['id']); input_uuid(entry['exerciseId'])
            check(entry['id'] not in ids); ids.add(entry['id'])
            if entry['kind'] == 'strength':
                check(type(entry['sets']) is list and len(entry['sets']) <= 50)
                set_count += len(entry['sets'])
                check(body['status'] != 'completed' or bool(entry['sets']))
                for item in entry['sets']:
                    check(set(item) == {'id', 'setType', 'completed', 'reps', 'durationSeconds', 'loadKg', 'assistanceKg', 'effortType', 'effortValue', 'notes'})
                    input_uuid(item['id']); check(item['id'] not in ids); ids.add(item['id'])
                    check(type(item['completed']) is bool and item['setType'] in ('working', 'warmup'))
                    check(body['status'] != 'completed' or item['completed'])
                    number(item['reps'], 1000000, True, 1); number(item['durationSeconds'], 31536000, True, 1)
                    check(item['reps'] is None or item['durationSeconds'] is None)
                    check(not item['completed'] or item['reps'] is not None or item['durationSeconds'] is not None)
                    for field in ('loadKg', 'assistanceKg'):
                        number(item[field], 10000)
                        check(item[field] is None or abs(item[field] * 1000 - round(item[field] * 1000)) < 1e-7)
                    check(item['loadKg'] is None or item['assistanceKg'] is None)
                    effort = item['effortValue']
                    check((item['effortType'] is None and effort is None) or
                          (item['effortType'] in ('rpe', 'rir') and type(effort) in (int, float) and
                           (1 <= effort <= 10 and effort * 2 == int(effort * 2) if item['effortType'] == 'rpe' else 0 <= effort <= 10 and effort == int(effort))))
                    notes(item['notes'])
            else:
                cardio = entry['cardio']
                check(type(cardio) is dict and set(cardio) == {'completed', 'durationSeconds', 'durationBasis', 'distanceMeters', 'averageHeartRate', 'maxHeartRate', 'elevationGainMeters', 'inclinePercent', 'resistanceLevel', 'deviceCaloriesKcal'})
                check(type(cardio['completed']) is bool and cardio['durationBasis'] in ('elapsed', 'moving'))
                check(body['status'] != 'completed' or cardio['completed'])
                check(not cardio['completed'] or cardio['durationSeconds'] is not None)
                number(cardio['durationSeconds'], 31536000, True, 1)
                for field in ('averageHeartRate', 'maxHeartRate'): number(cardio[field], 1000, True, 1)
                check(cardio['averageHeartRate'] is None or cardio['maxHeartRate'] is None or cardio['averageHeartRate'] <= cardio['maxHeartRate'])
                for field, maximum in [('distanceMeters', 100000000), ('elevationGainMeters', 10000000), ('resistanceLevel', 1000000), ('deviceCaloriesKcal', 100000000)]: number(cardio[field], maximum)
                check(cardio['distanceMeters'] is None or cardio['distanceMeters'] == 0 or cardio['distanceMeters'] >= .001)
                number(cardio['inclinePercent'], 100, minimum=-100)
            notes(entry['notes'])
        check(set_count <= 300)
        # Server Zod remains authoritative and rechecks concurrent exercise state.

    if args.command in ('validate', 'plan'):
        exercises = client.pages('exercises', {'includeArchived': 'false'}, 100, 10000)
        check(not exercises['meta']['truncated'], 'Exercise lookup truncated; resolve manually.')
        definitions = {e['id']: e for e in exercises['data']}
        unmatched = sorted({e['exerciseId'] for r in batch['workouts'] for e in r['body']['entries'] if e['exerciseId'] not in definitions})
        for row in batch['workouts']:
            for entry in row['body']['entries']:
                definition = definitions.get(entry['exerciseId'])
                if definition is None: continue
                check(entry['kind'] == definition['kind'], 'Exercise kind mismatch.')
                if entry['kind'] == 'strength':
                    for item in entry['sets']:
                        mode = definition['measurementMode']
                        check(item['durationSeconds' if mode == 'reps' else 'reps'] is None)
                        check(not item['completed'] or item['reps' if mode == 'reps' else 'durationSeconds'] is not None)
                        assisted = definition['resistanceMode'] == 'assisted'
                        check(item['loadKg' if assisted else 'assistanceKg'] is None)
                        if item['completed'] and definition['resistanceMode'] in ('assisted', 'external'):
                            check(item['assistanceKg' if assisted else 'loadKg'] is not None)
        suspected = []
        for date in sorted(set(dates)):
            history = client.pages('workouts', {'from': date.isoformat(), 'to': (date + dt.timedelta(days=1)).isoformat()}, 100, 10000)
            check(not history['meta']['truncated'], 'Duplicate lookup truncated; narrow or review manually.')
            if history['data']:
                suspected.append({'localDate': date.isoformat(), 'workoutIds': [r['id'] for r in history['data']]})
        plan = {'version': 1, 'batchId': batch['batchId'], 'sourceHash': source_hash,
                'origin': client.base, 'unmatchedExerciseIds': unmatched,
                'suspectedDuplicates': suspected, 'validation': 'structural only; server validates full measurement constraints',
                'items': [{'sourceId': r['sourceId'], 'bodyHash': digest(r['body']),
                           'key': 'hw-' + digest([batch['batchId'], r['sourceId'], digest(r['body'])])} for r in batch['workouts']]}
        plan['confirmation'] = digest(plan)
        if args.command == 'plan': save(args.plan, plan, True)
        return plan

    plan = load(args.plan)
    confirmation = plan.pop('confirmation', None)
    check(confirmation == digest(plan) and args.confirm == confirmation, 'Explicit confirmation must equal the reviewed plan hash.')
    check(plan['sourceHash'] == source_hash and plan['batchId'] == batch['batchId'] and plan['origin'] == client.base,
          'Input/origin changed. Do not reuse this plan; review a new batch without overwriting history.')
    check(not plan['unmatchedExerciseIds'], 'Missing exercises require user confirmation and human creation, then a new plan.')
    expected = [{'sourceId': r['sourceId'], 'bodyHash': digest(r['body']),
                 'key': 'hw-' + digest([batch['batchId'], r['sourceId'], digest(r['body'])])} for r in batch['workouts']]
    check(plan['items'] == expected)
    # Bind private journal to origin and credential identity without storing Client ID/secret.
    principal_hash = digest(client.headers.get('CF-Access-Client-Id', 'local_mock'))
    journal_path = args.plan + '.journal.json'
    lock_path = journal_path + '.lock'
    try:
        lock = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise hw.ClientError('IMPORT_LOCKED', 'Another import may be running. After a crash, inspect the journal before manually removing its lock.', 2) from None
    os.close(lock)
    try:
        if Path(journal_path).exists():
            journal = load(journal_path)
            check(journal['confirmation'] == confirmation and journal['principalHash'] == principal_hash)
        else:
            journal = {'confirmation': confirmation, 'principalHash': principal_hash, 'results': {}}
            save(journal_path, journal, True)
        for row, item in zip(batch['workouts'], expected):
            key = item['key']
            previous = journal['results'].get(key)
            if previous and previous['status'] == 'success': continue
            now = time.time()
            first = previous['firstAttempt'] if previous else now
            # Never replay an uncertain create beyond the backend's 24h retention window.
            if now - first >= 23 * 3600:
                journal['results'][key] = {'status': 'needs_reconciliation', 'firstAttempt': first}
                save(journal_path, journal); continue
            journal['results'][key] = {'status': 'pending', 'firstAttempt': first}
            save(journal_path, journal)
            try:
                response = client.create_workout(row['body'], key)
                result = {'status': 'success', 'firstAttempt': first, 'workoutId': response['data']['id'], 'replayed': response['meta']['replayed']}
            except hw.ClientError as error:
                result = {'status': 'failed', 'firstAttempt': first, 'errorCode': error.code}
            journal['results'][key] = result
            save(journal_path, journal)
        results = [{'sourceId': item['sourceId'], **journal['results'][item['key']]} for item in expected]
        return {'data': results, 'meta': {'allSucceeded': all(r['status'] == 'success' for r in results), 'atomicBatch': False}}
    finally:
        os.unlink(lock_path)
