#!/usr/bin/env python3
"""Bounded HealthWorker reads and confirmed create-only workout imports for authorized tokens. Python 3.11+, standard library only."""
import argparse
import datetime as dt
import email.utils
import http.client
import json
import math
import os
import re
import ssl
import stat
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

PREFIX = '/api/agent/v1'
TIMEOUT = 20
MAX_RETRIES = 3  # initial attempt plus at most three retries
MAX_RETRY_AFTER = 30
MAX_BYTES = 16 * 1024 * 1024
PATHS = {'metadata', 'exercises', 'workouts', 'stats/summary', 'stats/strength', 'stats/cardio', 'openapi.json'}
PARAMS = {
    'metadata': set(), 'openapi.json': set(),
    'exercises': {'query', 'kind', 'includeArchived', 'limit', 'cursor'},
    'workouts': {'from', 'to', 'status', 'kind', 'exerciseId', 'includeNotes', 'limit', 'cursor'},
    'workout': {'includeNotes'},
    'stats/summary': {'from', 'to', 'granularity'},
    'stats/strength': {'from', 'to', 'exerciseId', 'includeWarmup'},
    'stats/cardio': {'from', 'to', 'category', 'durationBasis'},
}


class ClientError(Exception):
    def __init__(self, code, message, exit_code=5):
        super().__init__(message)
        self.code, self.exit_code = code, exit_code


def require(condition):
    if not condition:
        raise ClientError('INVALID_RESPONSE', 'Response does not match the supported API contract.')


def date_value(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', value):
        raise ValueError('date')
    parsed = dt.date.fromisoformat(value)
    if parsed.year < 1900:
        raise ValueError('date')
    return parsed


def uuid_value(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value.lower():
        raise ValueError('uuid')
    return value


def bounded_text(value, limit):
    return isinstance(value, str) and len(value) <= limit and not any(ord(c) < 32 or ord(c) == 127 for c in value)


def route_key(path):
    if path in PATHS:
        return path
    if path.startswith('workouts/'):
        try:
            uuid_value(path.removeprefix('workouts/'))
            return 'workout'
        except ValueError:
            pass
    raise ClientError('INVALID_ARGUMENT', 'Only allowlisted Agent GET paths are supported.', 2)


def validate_query(path, query):
    key = route_key(path)
    if not set(query) <= PARAMS[key]:
        raise ClientError('INVALID_ARGUMENT', 'Unsupported query parameter.', 2)
    try:
        for name, value in query.items():
            if name in ('from', 'to'):
                date_value(value)
            elif name == 'exerciseId':
                uuid_value(value)
            elif name in ('includeNotes', 'includeArchived', 'includeWarmup'):
                if value not in ('true', 'false'): raise ValueError()
            elif name == 'limit':
                if type(value) is not int or not 1 <= value <= 100: raise ValueError()
            elif name in ('query', 'cursor'):
                if not bounded_text(value, 200 if name == 'query' else 4000): raise ValueError()
            else:
                choices = {'status': ('draft', 'completed'), 'kind': ('strength', 'cardio'),
                           'granularity': ('day', 'week', 'month'), 'durationBasis': ('elapsed', 'moving'),
                           'category': ('run', 'walk', 'cycle', 'swim', 'row', 'elliptical', 'other')}
                if value not in choices[name]: raise ValueError()
        if key == 'stats/strength' and 'exerciseId' not in query: raise ValueError()
        if 'from' in query and 'to' in query:
            if not 1 <= (date_value(query['to']) - date_value(query['from'])).days <= 366: raise ValueError()
    except (ValueError, TypeError, KeyError):
        raise ClientError('INVALID_ARGUMENT', 'Invalid query value, UUID, or date range (1–366 days; years 1900–9999).', 2) from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Transport:
    def __init__(self):
        # No ambient proxy, cookie jar, netrc, or redirect credential forwarding.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def __call__(self, url, headers, timeout, body=None):
        request = urllib.request.Request(url, headers=headers, method='GET' if body is None else 'POST', data=body)
        try:
            response = self.opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise ClientError('RESPONSE_TOO_LARGE', 'Response exceeds 16 MiB; narrow the query.')
            return response.status, dict(response.headers.items()), body


def retry_delay(value, attempt):
    fallback = min(2 ** attempt, MAX_RETRY_AFTER)
    if value is None:
        return fallback
    try:
        if re.fullmatch(r'[0-9]+', value.strip()):
            seconds = int(value)
        else:
            when = email.utils.parsedate_to_datetime(value)
            seconds = (when - dt.datetime.now(dt.timezone.utc)).total_seconds()
        return min(MAX_RETRY_AFTER, max(0, seconds))
    except (ValueError, TypeError, OverflowError):
        return fallback


def reject_constant(value):
    raise ValueError('non-finite JSON')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError('duplicate key')
        result[key] = value
    return result


def json_tree(value):
    if isinstance(value, float): require(math.isfinite(value))
    elif isinstance(value, list):
        for item in value: json_tree(item)
    elif isinstance(value, dict):
        for item in value.values(): json_tree(item)


def fields(value, specification):
    require(isinstance(value, dict))
    for key, expected in specification.items():
        require(key in value and type(value[key]) in expected)


def validate_exercise(row):
    fields(row, {'id': (str,), 'name': (str,), 'kind': (str,), 'measurementMode': (str,),
                 'resistanceMode': (str, type(None)), 'loadConvention': (str,), 'repConvention': (str,),
                 'volumeMultiplier': (int, float, type(None)), 'aliases': (list,), 'muscleGroups': (list,),
                 'equipment': (str, type(None)), 'cardioCategory': (str, type(None)),
                 'isBuiltin': (bool,), 'archivedAt': (str, type(None)), 'createdAt': (str,), 'updatedAt': (str,), 'version': (int,)})
    uuid_value(row['id'])
    require(row['kind'] in ('strength', 'cardio'))


def validate_response(path, value):
    """Validate envelopes and endpoint structures; server Zod owns business validation."""
    key = route_key(path)
    if key == 'openapi.json':
        fields(value, {'openapi': (str,), 'info': (dict,), 'paths': (dict,), 'servers': (list,)})
        require(value['openapi'].startswith('3.') and value['info'].get('version', '').startswith('1.'))
        require(value['servers'] == [{'url': PREFIX}])
        for route, operations in value['paths'].items():
            require(route in {'/' + p for p in PATHS - {'openapi.json'}} | {'/workouts/{id}'})
            require(isinstance(operations, dict) and set(operations) <= ({'get', 'parameters', 'summary', 'description'} | ({'post'} if route in ('/workouts', '/exercises') else set())))
        return
    fields(value, {'data': (list,) if key in ('exercises', 'workouts') else (dict,), 'meta': (dict,)})
    fields(value['meta'], {'requestId': (str,)})
    data, meta = value['data'], value['meta']
    if key == 'metadata':
        for name in ('apiVersion', 'schemaVersion', 'definitionsVersion'):
            if data.get(name) != '1':
                raise ClientError('INCOMPATIBLE_VERSION', 'Supported API/schema/definitions versions are 1; update the Skill before querying.')
        require(data.get('units') == {'load': 'kg', 'storageLoad': 'g', 'distance': 'm', 'duration': 's', 'heartRate': 'bpm'})
        require(data.get('dateBasis') == 'workout_local_date' and data.get('rangeSemantics') == '[from,to)')
        require(data.get('weekStartsOn') == 'monday' and data.get('warmupDefault') == 'exclude')
        fields(data, {'capabilities': (list,), 'coverage': (dict,), 'milestone': (str,), 'timezone': (str, type(None))})
        require(all(isinstance(c, str) for c in data['capabilities']))
        require(data.get('authentication') in ('access', 'local_mock'))
        coverage = data['coverage']
        require(coverage.get('dateBasis') == 'workout_local_date')
        for name in ('workoutCount', 'completedWorkoutCount', 'draftWorkoutCount'):
            require(type(coverage.get(name)) is int and coverage[name] >= 0)
        for name in ('firstLocalDate', 'lastLocalDate', 'firstCompletedLocalDate', 'lastCompletedLocalDate'):
            require(name in coverage)
            if coverage[name] is not None: date_value(coverage[name])
    elif key in ('exercises', 'workouts'):
        fields(meta, {'nextCursor': (str, type(None))})
        require(meta['nextCursor'] is None or (bounded_text(meta['nextCursor'], 4000) and bool(meta['nextCursor'])))
        require(len(data) <= 100)
        for row in data:
            if key == 'exercises': validate_exercise(row)
            else: validate_workout(row, False)
        if key == 'workouts':
            require(meta.get('dateBasis') == 'workout_local_date')
            date_value(meta.get('from')); date_value(meta.get('to'))
    elif key == 'workout':
        validate_workout(data, True)
    else:
        require(data.get('definitionsVersion') == '1' and data.get('dateBasis') == 'workout_local_date')
        require(data.get('status') == 'completed')
        date_value(data.get('from')); date_value(data.get('to'))
        fields(data, {'quality': (dict,)})
        fields(data['quality'], {'validSamples': (int,), 'missing': (dict,), 'excluded': (dict,)})
        require(data['quality']['validSamples'] >= 0)
        for counts in (data['quality']['missing'], data['quality']['excluded']):
            require(all(type(n) is int and n >= 0 for n in counts.values()))
        if key == 'stats/summary':
            require(data.get('granularity') in ('day', 'week', 'month') and data.get('warmup') == 'not_applicable')
            fields(data, {'totals': (dict,), 'buckets': (list,), 'cardioByCategory': (list,)})
            fields(data['totals'], {n: (int, float) for n in ('workoutCount', 'recordedDurationWorkoutCount', 'durationSeconds', 'strengthWorkoutCount', 'cardioWorkoutCount', 'cardioDurationSeconds')})
            fields(data['totals'], {'durationCoverage': (int, float, type(None))})
        elif key == 'stats/strength':
            require(data.get('granularity') == 'workout' and data.get('warmup') in ('include', 'exclude'))
            uuid_value(data.get('exerciseId'))
            fields(data, {'totals': (dict,), 'workouts': (list,), 'records': (dict,)})
            fields(data['totals'], {n: (int, float) for n in ('setCount', 'workingSetCount', 'warmupSetCount', 'reps', 'durationSeconds', 'volumeSampleCount')})
            fields(data['totals'], {'maxLoadKg': (int, float, type(None)), 'volumeKgReps': (int, float, type(None))})
            fields(data['records'], {'maxLoad': (dict, type(None)), 'longestDuration': (dict, type(None)), 'mostRepsByResistance': (list,)})
        else:
            require(data.get('granularity') == 'record' and data.get('warmup') == 'not_applicable')
            require(data.get('heartRateDefinition') == 'record_mean_duration_weighted_estimate')
            fields(data, {'groups': (list,), 'records': (list,), 'category': (str, type(None)), 'durationBasis': (str, type(None))})


def validate_stat_rows(key, data):
    """Check nested statistical rows without calculating statistics."""
    def numbers(row, required, nullable=()):
        fields(row, {n: (int, float) for n in required})
        fields(row, {n: (int, float, type(None)) for n in nullable})
        require(all(row[n] is None or row[n] >= 0 for n in (*required, *nullable)))

    def identity(row, entry=False, set_id=False):
        fields(row, {'workoutId': (str,), 'localDate': (str,), 'startedAt': (str,)})
        uuid_value(row['workoutId']); date_value(row['localDate'])
        if entry: uuid_value(row.get('entryId'))
        if set_id: uuid_value(row.get('setId'))

    if key == 'stats/summary':
        metrics = ('workoutCount', 'recordedDurationWorkoutCount', 'durationSeconds', 'strengthWorkoutCount', 'cardioWorkoutCount', 'cardioDurationSeconds')
        for row in [data['totals'], *data['buckets']]:
            numbers(row, metrics, ('durationCoverage',))
            require(row['durationCoverage'] is None or row['durationCoverage'] <= 1)
        for row in data['buckets']:
            for name in ('bucketStart', 'from', 'to'): date_value(row.get(name))
        for row in data['cardioByCategory']:
            fields(row, {'category': (str,), 'durationBasis': (str,)})
            numbers(row, ('recordCount', 'durationSeconds', 'distanceMeters', 'distanceSampleCount'))
    elif key == 'stats/strength':
        metrics = ('setCount', 'workingSetCount', 'warmupSetCount', 'reps', 'durationSeconds', 'volumeSampleCount')
        for row in [data['totals'], *data['workouts']]:
            numbers(row, metrics, ('maxLoadKg', 'volumeKgReps'))
        for row in data['workouts']: identity(row)
        for row in [data['records']['maxLoad'], data['records']['longestDuration'], *data['records']['mostRepsByResistance']]:
            if row is not None:
                identity(row, True, True)
                numbers(row, (), ('loadKg', 'assistanceKg', 'reps', 'durationSeconds'))
        for row in data['records']['mostRepsByResistance']:
            require(isinstance(row, dict) and row.get('resistanceMode') in ('external', 'bodyweight', 'assisted'))
    else:
        metrics = ('recordCount', 'durationSeconds', 'distanceMeters', 'distanceSampleCount', 'elevationGainMeters', 'elevationSampleCount', 'paceSampleCount', 'paceDurationSeconds', 'paceDistanceMeters', 'heartRateSampleCount', 'heartRateDurationSeconds')
        rates = ('speedKmh', 'paceSecondsPerKm', 'paceSecondsPer100m')
        for row in data['groups']:
            numbers(row, metrics, (*rates, 'averageHeartRate'))
        for row in data['records']:
            identity(row, True)
            uuid_value(row.get('exerciseId'))
            numbers(row, ('durationSeconds',), (*rates, 'distanceMeters', 'averageHeartRate', 'maxHeartRate', 'elevationGainMeters'))
        categories = ('run', 'walk', 'cycle', 'swim', 'row', 'elliptical', 'other')
        bases = ('elapsed', 'moving')
        # Only top-level filters are nullable; actual sample dimensions are required.
        fields(data, {'category': (str, type(None)), 'durationBasis': (str, type(None))})
        require(data['category'] is None or data['category'] in categories)
        require(data['durationBasis'] is None or data['durationBasis'] in bases)
        for row in [*data['groups'], *data['records']]:
            fields(row, {'category': (str,), 'durationBasis': (str,)})
            require(row['category'] in categories)
            require(row['durationBasis'] in bases)


def validate_workout(row, detail):
    fields(row, {'id': (str,), 'localDate': (str,), 'startedAt': (str,), 'timezone': (str,),
                 'status': (str,), 'durationSeconds': (int, type(None)), 'notes': (str, type(None)),
                 'version': (int,), 'entryCount': (int,), 'kinds': (list,), 'createdAt': (str,), 'updatedAt': (str,)})
    uuid_value(row['id']); date_value(row['localDate'])
    require(row['status'] in ('draft', 'completed'))
    if detail:
        fields(row, {'entries': (list,)})
        for entry in row['entries']:
            fields(entry, {'id': (str,), 'exerciseId': (str,), 'position': (int,), 'kind': (str,),
                           'exerciseNameSnapshot': (str,), 'measurementSnapshot': (dict,), 'notes': (str, type(None))})
            require(entry['kind'] in ('strength', 'cardio'))
            if entry['kind'] == 'strength':
                fields(entry, {'sets': (list,)})
                for item in entry['sets']:
                    fields(item, {'id': (str,), 'position': (int,), 'completed': (bool,), 'setType': (str,),
                                  'reps': (int, type(None)), 'durationSeconds': (int, type(None)),
                                  'loadKg': (int, float, type(None)), 'assistanceKg': (int, float, type(None)),
                                  'effortType': (str, type(None)), 'effortValue': (int, float, type(None)), 'notes': (str, type(None))})
            else:
                fields(entry, {'cardio': (dict,)})
                fields(entry['cardio'], {'completed': (bool,), 'durationSeconds': (int, type(None)), 'durationBasis': (str,)})


def strip_notes(value):
    if isinstance(value, dict):
        return {k: None if k == 'notes' else strip_notes(v) for k, v in value.items()}
    if isinstance(value, list): return [strip_notes(v) for v in value]
    return value


def validate_origin(base, development=False):
    try:
        if not isinstance(base, str) or not base or not bounded_text(base, 2048) or any(c.isspace() for c in base) or '\\' in base or '%' in base: raise ValueError()
        parsed = urllib.parse.urlsplit(base)
        if not parsed.hostname or parsed.username is not None or parsed.password is not None or parsed.path not in ('', '/') or '?' in base or '#' in base: raise ValueError()
        if parsed.port is not None and not 1 <= parsed.port <= 65535: raise ValueError()
        local = parsed.hostname in ('localhost', '127.0.0.1', '::1')
        if development:
            if parsed.scheme != 'http' or not local: raise ValueError()
        elif parsed.scheme != 'https': raise ValueError()
    except ValueError:
        raise ClientError('CONFIGURATION', 'Set a bare HTTPS application origin; --development permits HTTP loopback only.', 2) from None
    return parsed.scheme, parsed.hostname, parsed.port or (80 if development else 443)


DEFAULT_CONFIG = Path(__file__).resolve().parents[1] / 'client.local.json'


class ResolvedConfig(dict):
    """Internal snapshot: resolve once per command, including output protection."""


def load_config(env=None, development=False):
    """Load the Skill-local private file or explicit replacement, never dotenv."""
    if isinstance(env, ResolvedConfig):
        return env
    resolved = ResolvedConfig(os.environ if env is None else env)
    explicit = 'HEALTHWORKER_CONFIG' in resolved
    try:
        path = Path(resolved['HEALTHWORKER_CONFIG']) if explicit else DEFAULT_CONFIG
        if not explicit:
            try:
                path.lstat()
            except FileNotFoundError:
                return resolved
        if not path.is_absolute() or path.is_symlink(): raise ValueError()
        parent = path.parent.stat()
        # The shared Skill directory may be readable/traversable, never writable by others.
        if os.name == 'posix' and (stat.S_IMODE(parent.st_mode) & 0o022 or parent.st_uid != os.getuid()): raise ValueError()
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(fd, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode): raise ValueError()
            if os.name == 'posix' and (stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid()): raise ValueError()
            raw = source.read(16385)
        if len(raw) > 16384: raise ValueError()
        config = json.loads(raw, parse_constant=reject_constant, object_pairs_hook=unique_object)
        if type(config) is not dict or not {'baseUrl', 'clientId'} <= set(config) <= {'baseUrl', 'clientId', 'clientSecret'}: raise ValueError()
        for name in ('clientId', 'clientSecret'):
            if name in config:
                value = config[name]
                if not isinstance(value, str) or not value or not bounded_text(value, 8192) or not value.isascii() or any(c.isspace() for c in value): raise ValueError()
    except (OSError, ValueError, TypeError, RecursionError):
        raise ClientError('CONFIGURATION', 'Config must be an absolute private JSON file (0600, current owner; parent current-owned and not group/world writable), with baseUrl/clientId and optional clientSecret only.', 2) from None
    configured_origin = validate_origin(config['baseUrl'])
    base = resolved.get('HEALTHWORKER_BASE_URL', config['baseUrl'])
    if validate_origin(base, development) != configured_origin:
        raise ClientError('CONFIGURATION', 'Environment origin differs from the private config binding. Stop and verify the destination; explicitly select a matching private config for the verified destination.', 2)
    resolved.setdefault('HEALTHWORKER_BASE_URL', config['baseUrl'])
    resolved.setdefault('HEALTHWORKER_ACCESS_CLIENT_ID', config['clientId'])
    if 'clientSecret' in config:
        resolved.setdefault('HEALTHWORKER_ACCESS_CLIENT_SECRET', config['clientSecret'])
    return resolved


class Client:
    def __init__(self, env=None, development=False, transport=None, sleep=time.sleep):
        env = load_config(env, development)
        base = env.get('HEALTHWORKER_BASE_URL', '')
        validate_origin(base, development)
        self.env = env
        self.base, self.development = base.rstrip('/'), development
        self.headers = {'Accept': 'application/json', 'User-Agent': 'HealthWorker-Skill/1', 'Cache-Control': 'no-store'}
        if not development:
            for variable, header in [('HEALTHWORKER_ACCESS_CLIENT_ID', 'CF-Access-Client-Id'), ('HEALTHWORKER_ACCESS_CLIENT_SECRET', 'CF-Access-Client-Secret')]:
                credential = env.get(variable, '')
                if not credential or not bounded_text(credential, 8192) or not credential.isascii() or any(c.isspace() for c in credential):
                    raise ClientError('CONFIGURATION', 'Missing or invalid ' + variable + '. Supply it privately through the private JSON, process environment or secret manager, never in chat.', 2)
                self.headers[header] = credential
        # Development deliberately never sends credentials, even if inherited.
        self.transport, self.sleep = transport or Transport(), sleep

    def create_workout(self, body, key):
        if not isinstance(key, str) or not re.fullmatch(r'[!-~]{1,200}', key):
            raise ClientError('INVALID_ARGUMENT', 'Invalid idempotency key.', 2)
        encoded = json.dumps(body, ensure_ascii=True, allow_nan=False, separators=(',', ':')).encode()
        if len(encoded) > 512 * 1024:
            raise ClientError('INVALID_ARGUMENT', 'Workout exceeds 512 KiB.', 2)
        return self._request('workouts', {}, encoded, key)

    def create_exercise(self, body, key):
        if not isinstance(key, str) or not re.fullmatch(r'[!-~]{1,200}', key):
            raise ClientError('INVALID_ARGUMENT', 'Invalid idempotency key.', 2)
        encoded = json.dumps(body, ensure_ascii=True, allow_nan=False, separators=(',', ':')).encode()
        if len(encoded) > 512 * 1024:
            raise ClientError('INVALID_ARGUMENT', 'Exercise exceeds 512 KiB.', 2)
        return self._request('exercises', {}, encoded, key)

    def get(self, path, query=None):
        return self._request(path, query)

    def _request(self, path, query=None, body_bytes=None, key=None):
        query = dict(query or {})
        validate_query(path, query)
        if body_bytes is None and route_key(path) in ('workout', 'workouts'):
            query.setdefault('includeNotes', 'false')
        url = self.base + PREFIX + '/' + path
        if query: url += '?' + urllib.parse.urlencode(query)
        for attempt in range(MAX_RETRIES + 1):
            try:
                request_headers = self.headers.copy()
                if body_bytes is not None:
                    request_headers.update({'Content-Type': 'application/json', 'Idempotency-Key': key})
                    status, headers, body = self.transport(url, request_headers, TIMEOUT, body_bytes)
                else:
                    status, headers, body = self.transport(url, request_headers, TIMEOUT)
            except (ssl.SSLError, urllib.error.URLError) as error:
                reason = getattr(error, 'reason', error)
                if isinstance(reason, ssl.SSLError):
                    raise ClientError('TLS_ERROR', 'TLS verification failed; check the configured origin and trust store.', 4) from None
                if attempt == MAX_RETRIES: raise ClientError('NETWORK_ERROR', 'Network request failed after bounded retries.', 4) from None
                self.sleep(retry_delay(None, attempt)); continue
            except (TimeoutError, ConnectionError, http.client.HTTPException, OSError):
                if attempt == MAX_RETRIES: raise ClientError('NETWORK_ERROR', 'Network request failed after bounded retries.', 4) from None
                self.sleep(retry_delay(None, attempt)); continue
            headers = {k.lower(): v for k, v in headers.items()}
            if status in (401, 403) or 300 <= status < 400:
                raise ClientError('AUTHENTICATION', 'Access rejected the request or returned a redirect. Check the Agent Service Auth policy; redirects are never followed.', 3)
            content_type = headers.get('content-type', '').split(';')[0].strip().lower()
            if 'html' in content_type or body.lstrip().startswith(b'<'):
                raise ClientError('AUTHENTICATION', 'Received HTML/login content instead of API JSON. Check Access configuration.', 3)
            if status == 429 or 500 <= status <= 599:
                if attempt < MAX_RETRIES:
                    self.sleep(retry_delay(headers.get('retry-after'), attempt)); continue
            if status != (201 if body_bytes is not None else 200):
                # Do not echo server messages, request IDs, headers, URLs or response bodies.
                raise ClientError('HTTP_ERROR', f'API returned HTTP {status}; check filters, range and configuration.', 4)
            if content_type != 'application/json':
                raise ClientError('INVALID_CONTENT_TYPE', 'Expected application/json from the Agent API.')
            try:
                value = json.loads(body.decode('utf-8'), parse_constant=reject_constant, object_pairs_hook=unique_object)
                json_tree(value)
                if body_bytes is not None:
                    fields(value, {'data': (dict,), 'meta': (dict,)})
                    fields(value['meta'], {'requestId': (str,), 'replayed': (bool,)})
                    if path == 'exercises': validate_exercise(value['data'])
                    else: validate_workout(value['data'], True)
                else:
                    validate_response(path, value)
                if path.startswith('stats/'):
                    validate_stat_rows(path, value['data'])
                    for name in ('from', 'to', 'exerciseId', 'category', 'durationBasis', 'granularity'):
                        require(name not in query or query[name] == value['data'].get(name))
                    if path == 'stats/strength':
                        require(value['data']['warmup'] == ('include' if query.get('includeWarmup') == 'true' else 'exclude'))
                if route_key(path) == 'workout':
                    require(value['data']['id'].lower() == path.removeprefix('workouts/').lower())
            except (ValueError, TypeError, KeyError, AttributeError, RecursionError):
                raise ClientError('INVALID_RESPONSE', 'Malformed JSON or unsupported API response structure.') from None
            return value if query.get('includeNotes') == 'true' else strip_notes(value)

    def metadata(self):
        value = self.get('metadata')
        if value['data']['authentication'] != ('local_mock' if self.development else 'access'):
            raise ClientError('AUTHENTICATION', 'Authentication mode does not match the selected client mode.', 3)
        return value

    def pages(self, path, query, max_pages=4, max_records=100):
        if path not in ('exercises', 'workouts') or type(max_pages) is not int or type(max_records) is not int or not 1 <= max_pages <= 100 or not 1 <= max_records <= 10000:
            raise ClientError('INVALID_ARGUMENT', 'Pagination bounds: 1–100 pages, 1–10000 records.', 2)
        query = dict(query)
        validate_query(path, query)
        seen = {query['cursor']} if query.get('cursor') else set()
        rows, ids = [], set()
        for page_number in range(1, max_pages + 1):
            query['limit'] = min(query.get('limit', 25), max_records - len(rows))
            page = self.get(path, query)
            require(len(page['data']) <= query['limit'])
            if path == 'workouts':
                for name in ('from', 'to'):
                    require(name not in query or query[name] == page['meta'][name])
                    query[name] = page['meta'][name]  # pin server defaults across midnight
            cursor = page['meta']['nextCursor']
            require(cursor is None or (bool(page['data']) and cursor not in seen))
            for row in page['data']:
                require(row['id'] not in ids)
                ids.add(row['id'])
            rows.extend(page['data'])
            if cursor is None or page_number == max_pages or len(rows) == max_records:
                return {'data': rows, 'meta': {**page['meta'], 'truncated': cursor is not None,
                        'nextCursor': cursor, 'pagesFetched': page_number, 'recordsFetched': len(rows),
                        'maxPages': max_pages, 'maxRecords': max_records}}
            seen.add(cursor)
            query['cursor'] = cursor


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise ClientError('INVALID_ARGUMENT', 'Invalid command or arguments; use --help. Values are omitted for privacy.', 2)


def parser():
    root = SafeParser(description=__doc__, allow_abbrev=False)
    root.add_argument('--development', action='store_true', help='HTTP loopback local_mock only; never sends Service Token headers')
    commands = root.add_subparsers(dest='command', required=True, parser_class=SafeParser)
    for name in ('validate', 'plan', 'import'):
        sub = commands.add_parser(name, allow_abbrev=False)
        sub.add_argument('--input', required=True)
        if name != 'validate': sub.add_argument('--plan', required=True)
        if name == 'import': sub.add_argument('--confirm', required=True)
    commands.add_parser('metadata', allow_abbrev=False)
    commands.add_parser('openapi', allow_abbrev=False)
    exercises = commands.add_parser('exercises', allow_abbrev=False)
    exercises.add_argument('--query', default='')
    exercises.add_argument('--include-archived', action='store_true')
    workouts = commands.add_parser('workouts', allow_abbrev=False)
    workouts.add_argument('--status', choices=('draft', 'completed'))
    workouts.add_argument('--exercise-id')
    detail = commands.add_parser('workout', allow_abbrev=False)
    detail.add_argument('id')
    for sub in (workouts, detail): sub.add_argument('--include-notes', action='store_true')
    for sub in (exercises, workouts):
        sub.add_argument('--kind', choices=('strength', 'cardio'))
        sub.add_argument('--limit', type=int, default=25)
        sub.add_argument('--cursor')
        sub.add_argument('--max-pages', type=int, default=4)
        sub.add_argument('--max-records', type=int, default=100)
    stats = commands.add_parser('stats', allow_abbrev=False)
    stat_commands = stats.add_subparsers(dest='stat', required=True, parser_class=SafeParser)
    summary = stat_commands.add_parser('summary', allow_abbrev=False)
    summary.add_argument('--granularity', choices=('day', 'week', 'month'), default='week')
    strength = stat_commands.add_parser('strength', allow_abbrev=False)
    strength.add_argument('--exercise-id', required=True)
    strength.add_argument('--include-warmup', action='store_true')
    cardio = stat_commands.add_parser('cardio', allow_abbrev=False)
    cardio.add_argument('--category', choices=('run', 'walk', 'cycle', 'swim', 'row', 'elliptical', 'other'))
    cardio.add_argument('--duration-basis', choices=('elapsed', 'moving'))
    for sub in (workouts, summary, strength, cardio):
        sub.add_argument('--from', dest='from_date')
        sub.add_argument('--to', dest='to_date')
    return root


def execute(args, env=None, transport=None, sleep=time.sleep):
    if args.command in ('validate', 'plan', 'import'):
        import importlib.util
        from pathlib import Path
        spec = importlib.util.spec_from_file_location('import_workouts', Path(__file__).with_name('import_workouts.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        # Pass this module's contract helpers also when loaded via importlib in tests.
        import types
        client = Client(env, args.development, transport, sleep)
        return module.execute(types.SimpleNamespace(**globals()), args, client, client.env)
    path = {'openapi': 'openapi.json', 'workout': 'workouts/' + getattr(args, 'id', '')}.get(args.command, args.command)
    if args.command == 'stats': path = 'stats/' + args.stat
    names = {'from_date': 'from', 'to_date': 'to', 'exercise_id': 'exerciseId', 'duration_basis': 'durationBasis',
             'include_notes': 'includeNotes', 'include_archived': 'includeArchived', 'include_warmup': 'includeWarmup'}
    query = {}
    for key, value in vars(args).items():
        if key in ('command', 'stat', 'id', 'development', 'max_pages', 'max_records') or value is None: continue
        query[names.get(key, key)] = str(value).lower() if isinstance(value, bool) else value
    # Resolve exactly the server's UTC-date defaults, not the user's local today.
    # Explicit dates retain their workout-local-date meaning; no timezone conversion.
    if args.command in ('workouts', 'stats'):
        try:
            to = date_value(query['to']) if 'to' in query else dt.datetime.now(dt.timezone.utc).date() + dt.timedelta(days=1)
            start = date_value(query['from']) if 'from' in query else to - dt.timedelta(days=28)
            query.update({'from': start.isoformat(), 'to': to.isoformat()})
        except (ValueError, OverflowError):
            raise ClientError('INVALID_ARGUMENT', 'Invalid date; supported years are 1900–9999.', 2) from None
    validate_query(path, query)
    if args.command in ('workouts', 'exercises') and not (1 <= args.max_pages <= 100 and 1 <= args.max_records <= 10000):
        raise ClientError('INVALID_ARGUMENT', 'Pagination bounds: 1–100 pages, 1–10000 records.', 2)
    client = Client(env, args.development, transport, sleep)
    metadata = client.metadata()
    if path == 'metadata': return metadata
    capability = 'openapi' if path == 'openapi.json' else path.split('/')[0]
    if capability not in metadata['data']['capabilities']:
        raise ClientError('UNSUPPORTED_CAPABILITY', 'The server does not advertise the requested capability.')
    if args.command in ('workouts', 'exercises'):
        return client.pages(path, query, args.max_pages, args.max_records)
    return client.get(path, query)


def main(argv=None, env=None, transport=None, sleep=time.sleep):
    try:
        if sys.version_info < (3, 11):
            raise ClientError('CONFIGURATION', 'Python 3.11 or newer is required.', 2)
        args = parser().parse_args(argv)
        env = load_config(env, args.development)
        result = execute(args, env, transport, sleep)
        # Final defense if a misconfigured server echoes Service Token values in JSON.
        rendered = json.dumps(result, ensure_ascii=True, allow_nan=False, indent=2)
        environment = os.environ if env is None else env
        for name in ('HEALTHWORKER_ACCESS_CLIENT_ID', 'HEALTHWORKER_ACCESS_CLIENT_SECRET'):
            secret = environment.get(name)
            if secret:
                rendered = rendered.replace(json.dumps(secret, ensure_ascii=True)[1:-1], '[REDACTED]')
        print(rendered)
        return 4 if result.get('meta', {}).get('allSucceeded') is False else 0
    except ClientError as error:
        print(json.dumps({'error': {'code': error.code, 'message': str(error)}}), file=sys.stderr)
        return error.exit_code
    except (Exception, KeyboardInterrupt):
        print('{"error":{"code":"CLIENT_ERROR","message":"Client failed; sensitive details omitted."}}', file=sys.stderr)
        return 5


if __name__ == '__main__':
    sys.exit(main())
