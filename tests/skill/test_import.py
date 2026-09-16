"""Synthetic batch transport and real loopback tests."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from test_healthworker import hw, metadata, response, workout, ENV


class ImportTests(unittest.TestCase):
    def test_shared_zod_matrix_through_plan_never_posts_invalid_input(self):
        import copy
        import urllib.parse
        from test_healthworker import exercise
        matrix = json.loads(Path(__file__).with_name('import-parity.json').read_text())
        strength = {'id': '22222222-2222-4222-8222-222222222222', 'exerciseId': exercise()['id'], 'kind': 'strength', 'notes': None, 'sets': [{'id': '33333333-3333-4333-8333-333333333333', 'setType': 'working', 'completed': False, 'reps': None, 'durationSeconds': None, 'loadKg': None, 'assistanceKg': None, 'effortType': None, 'effortValue': None, 'notes': None}]}
        cardio = {'id': strength['id'], 'exerciseId': strength['exerciseId'], 'kind': 'cardio', 'notes': None, 'cardio': {'completed': False, 'durationSeconds': None, 'durationBasis': 'elapsed', 'distanceMeters': None, 'averageHeartRate': None, 'maxHeartRate': None, 'elevationGainMeters': None, 'inclinePercent': None, 'resistanceLevel': None, 'deviceCaloriesKcal': None}}
        cases = []
        for item in matrix['uuids']:
            for field in ('id', 'exerciseId', 'setId'):
                entry = copy.deepcopy(strength)
                if field == 'setId': entry['sets'][0]['id'] = item['value']
                else: entry[field] = item['value']
                cases.append((entry, None, item['valid']))
        # JSON formatters may serialize 1.0 as 1; explicitly retain float-form coverage.
        for item in matrix['integers'] + [{'value': 1.0, 'valid': True}, {'value': 1000.0, 'valid': True}]:
            cases.append((copy.deepcopy(strength), item['value'], item['valid']))
            for field in ('reps', 'durationSeconds', 'cardioDuration', 'averageHeartRate', 'maxHeartRate'):
                entry = copy.deepcopy(strength if field in ('reps', 'durationSeconds') else cardio)
                target = entry['sets'][0] if entry['kind'] == 'strength' else entry['cardio']
                target['durationSeconds' if field == 'cardioDuration' else field] = item['value']
                cases.append((entry, None, item['valid']))
        with tempfile.TemporaryDirectory() as directory:
            for index, (entry, duration, valid) in enumerate(cases):
                with self.subTest(index=index):
                    source = Path(directory) / 'batch.json'; plan = Path(directory) / f'plan-{index}.json'
                    batch = {'version': 1, 'batchId': '11111111-1111-4111-8111-111111111111', 'workouts': [{'sourceId': 'row', 'body': {'startedAt': '2026-08-01T00:00:00Z', 'timezone': 'UTC', 'status': 'draft', 'durationSeconds': duration, 'notes': None, 'entries': [entry]}}]}
                    source.write_text(json.dumps(batch))
                    def transport(url, headers, timeout, body=None):
                        self.assertIsNone(body)
                        if url.endswith('/metadata'):
                            meta = metadata(); meta['data']['capabilities'].append('workouts:create'); return response(meta)
                        if '/exercises?' in url:
                            definition = exercise(); definition.update(id=entry['exerciseId'], kind=entry['kind'])
                            if entry['kind'] == 'strength' and entry['sets'][0]['durationSeconds'] is not None: definition['measurementMode'] = 'duration'
                            return response({'data': [definition], 'meta': {'requestId': 'x', 'nextCursor': None}})
                        query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
                        return response({'data': [], 'meta': {'requestId': 'x', 'nextCursor': None, 'from': query['from'][0], 'to': query['to'][0], 'dateBasis': 'workout_local_date'}})
                    out, err = io.StringIO(), io.StringIO()
                    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                        code = hw.main(['plan', '--input', str(source), '--plan', str(plan)], ENV, transport)
                    self.assertEqual(code == 0, valid, err.getvalue())
                    self.assertEqual(plan.exists(), valid)
                    if valid: self.assertIn('confirmation', json.loads(out.getvalue()))


    def test_confirm_resume_changed_input_and_failed_exit(self):
        calls = []
        fail = [True]
        meta = metadata(); meta['data']['capabilities'].append('workouts:create')
        def transport(url, headers, timeout, body=None):
            calls.append((url, headers, body))
            if url.endswith('/metadata'): return response(meta)
            if '/exercises?' in url: return response({'data': [], 'meta': {'requestId': 'x', 'nextCursor': None}})
            if body is None:
                import urllib.parse
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
                return response({'data': [], 'meta': {'requestId': 'x', 'nextCursor': None, 'from': query['from'][0], 'to': query['to'][0], 'dateBasis': 'workout_local_date'}})
            if fail[0]: return response({}, 500)
            data = workout(detail=True); data['status'] = 'draft'
            return response({'data': data, 'meta': {'requestId': 'x', 'replayed': True}}, 201)
        with tempfile.TemporaryDirectory() as directory:
            source, plan = Path(directory)/'batch.json', str(Path(directory)/'plan.json')
            batch = {'version': 1, 'batchId': '11111111-1111-4111-8111-111111111111', 'workouts': [{'sourceId': 'row1', 'body': {'startedAt': '2026-08-01T00:00:00Z', 'timezone': 'UTC', 'status': 'draft', 'durationSeconds': None, 'notes': None, 'entries': []}}]}
            source.write_text(json.dumps(batch))
            config = Path(directory) / 'client.json'
            config.write_text(json.dumps({'baseUrl': ENV['HEALTHWORKER_BASE_URL'], 'clientId': ENV['HEALTHWORKER_ACCESS_CLIENT_ID'], 'clientSecret': ENV['HEALTHWORKER_ACCESS_CLIENT_SECRET']}))
            config.chmod(0o600)
            env = {'HEALTHWORKER_CONFIG': str(config)}
            def run(args):
                out, err = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    code = hw.main(args, env, transport, lambda _: None)
                return code, out.getvalue(), err.getvalue()
            args = ['--input', str(source), '--plan', plan]
            code, out, _ = run(['plan', *args]); self.assertEqual(code, 0)
            confirmation = json.loads(out)['confirmation']
            self.assertEqual(Path(plan).stat().st_mode & 0o777, 0o600)
            self.assertEqual(run(['import', *args, '--confirm', 'wrong'])[0], 2)
            self.assertFalse(any(body for _, _, body in calls))
            self.assertEqual(run(['import', *args, '--confirm', confirmation])[0], 4)
            posts = [(headers['Idempotency-Key'], body) for _, headers, body in calls if body]
            self.assertEqual(len(posts), 4); self.assertEqual(len(set(posts)), 1)
            journal_path = Path(plan + '.journal.json')
            journal = json.loads(journal_path.read_text())
            original_journal = json.loads(journal_path.read_text())
            # A JSON-sourced credential must never be read back from a poisoned journal.
            journal['credentialEcho'] = ENV['HEALTHWORKER_ACCESS_CLIENT_SECRET']
            journal_path.write_text(json.dumps(journal))
            before_poisoned = len([b for _, _, b in calls if b])
            code, poisoned_out, poisoned_err = run(['import', *args, '--confirm', confirmation])
            self.assertEqual((code, poisoned_out), (2, ''))
            self.assertNotIn(ENV['HEALTHWORKER_ACCESS_CLIENT_SECRET'], poisoned_err)
            self.assertEqual(len([b for _, _, b in calls if b]), before_poisoned)
            journal = json.loads(json.dumps(original_journal))
            for result in journal['results'].values(): result['firstAttempt'] = 0
            journal_path.write_text(json.dumps(journal))
            before_expired = len([b for _, _, b in calls if b])
            code, expired_out, _ = run(['import', *args, '--confirm', confirmation])
            self.assertEqual(code, 4)
            self.assertEqual(json.loads(expired_out)['data']['workouts'][0]['status'], 'needs_reconciliation')
            self.assertEqual(json.loads(expired_out)['data']['exercises'], [])
            self.assertEqual(len([b for _, _, b in calls if b]), before_expired)
            journal_path.write_text(json.dumps(original_journal))
            fail[0] = False
            self.assertEqual(run(['import', *args, '--confirm', confirmation])[0], 0)
            before = len([b for _, _, b in calls if b])
            self.assertEqual(run(['import', *args, '--confirm', confirmation])[0], 0)
            self.assertEqual(len([b for _, _, b in calls if b]), before)
            batch['workouts'][0]['body']['notes'] = 'changed'
            source.write_text(json.dumps(batch))
            self.assertEqual(run(['import', *args, '--confirm', confirmation])[0], 2)
            self.assertEqual(len([b for _, _, b in calls if b]), before)
            for path in Path(directory).iterdir():
                if path != config: self.assertNotIn(ENV['HEALTHWORKER_ACCESS_CLIENT_SECRET'], path.read_text())
            for _, headers, _ in calls:
                self.assertEqual(headers['CF-Access-Client-Secret'], ENV['HEALTHWORKER_ACCESS_CLIENT_SECRET'])

    def test_declared_exercise_create_flow(self):
        import urllib.parse
        from test_healthworker import exercise
        existing = exercise()
        new_id = '44444444-4444-4444-8444-444444444444'
        declared_body = {'name': '合成宽距高位下拉', 'aliases': [], 'kind': 'strength', 'equipment': None,
                         'muscleGroups': [], 'cardioCategory': None, 'measurementMode': 'reps',
                         'resistanceMode': 'external', 'loadConvention': 'total', 'repConvention': 'total',
                         'volumeMultiplier': None}
        entry = {'id': '33333333-3333-4333-8333-333333333333', 'exerciseId': new_id, 'kind': 'strength', 'notes': None,
                 'sets': [{'id': '55555555-5555-4555-8555-555555555555', 'setType': 'working', 'completed': True,
                           'reps': 8, 'durationSeconds': None, 'loadKg': 50, 'assistanceKg': None,
                           'effortType': None, 'effortValue': None, 'notes': None}]}

        def body_with(entry_exercise_id):
            return {'startedAt': '2026-08-01T00:00:00Z', 'timezone': 'UTC', 'status': 'completed',
                    'durationSeconds': None, 'notes': None,
                    'entries': [{**entry, 'exerciseId': entry_exercise_id}]}

        def run(args, transport):
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = hw.main(args, ENV, transport)
            return code, out.getvalue(), err.getvalue()

        def batch_file(directory, workouts_entries='declared', declared_list='declared', name='合成宽距高位下拉'):
            body = body_with(new_id if workouts_entries == 'declared' else '99999999-9999-4999-8999-999999999999')
            batch = {'version': 1, 'batchId': '11111111-1111-4111-8111-111111111111',
                     'workouts': [{'sourceId': 'row1', 'body': body}]}
            if declared_list == 'declared':
                batch['exercises'] = [{'id': new_id, 'body': {**declared_body, 'name': name}}]
            source = Path(directory) / 'batch.json'
            source.write_text(json.dumps(batch))
            return source, batch

        fail_exercise = [False]
        meta = metadata(); meta['data']['capabilities'] += ['exercises:create', 'workouts:create']

        def transport(url, headers, timeout, body=None):
            if url.endswith('/metadata'): return response(meta)
            if '/exercises' in url and body is None:
                return response({'data': [existing], 'meta': {'requestId': 'x', 'nextCursor': None}})
            if body is None:
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
                return response({'data': [], 'meta': {'requestId': 'x', 'nextCursor': None,
                                                      'from': query['from'][0], 'to': query['to'][0],
                                                      'dateBasis': 'workout_local_date'}})
            if url.endswith('/exercises'):
                if fail_exercise[0]: return response({'error': {'code': 'EXERCISE_EXISTS', 'message': 'exists'}}, 409)
                created = dict(existing)
                created.update(id=new_id, name=declared_body['name'], volumeMultiplier=None)
                return response({'data': created, 'meta': {'requestId': 'x', 'replayed': False}}, 201)
            data = workout(detail=True); data['status'] = 'completed'
            return response({'data': data, 'meta': {'requestId': 'x', 'replayed': False}}, 201)

        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            source, _ = batch_file(directory)
            plan = str(directory / 'plan.json')
            calls = []

            def recording(url, headers, timeout, body=None):
                calls.append((url, headers, body))
                return transport(url, headers, timeout, body)

            code, out, err = run(['plan', '--input', str(source), '--plan', plan], recording)
            self.assertEqual((code, err), (0, ''))
            document = json.loads(out)
            self.assertEqual(document['unmatchedExerciseIds'], [])
            self.assertEqual(len(document['createExercises']), 1)
            self.assertEqual(document['createExercises'][0]['id'], new_id)
            self.assertEqual(document['createExercises'][0]['name'], '合成宽距高位下拉')
            self.assertTrue(document['createExercises'][0]['key'].startswith('hw-'))
            confirmation = document['confirmation']
            # Exercise POST fails: workouts must never be attempted.
            fail_exercise[0] = True
            calls.clear()
            code, out, _ = run(['import', '--input', str(source), '--plan', plan, '--confirm', confirmation], recording)
            self.assertEqual(code, 4)
            result = json.loads(out)['data']
            self.assertEqual(result['exercises'][0]['status'], 'failed')
            self.assertEqual(result['exercises'][0]['errorCode'], 'HTTP_ERROR')
            self.assertEqual(result['workouts'][0]['status'], 'not_attempted')
            posts = [(url, body) for url, _, body in calls if body is not None]
            self.assertEqual(len(posts), 1)
            self.assertTrue(posts[0][0].endswith(hw.PREFIX + '/exercises'))
            # Resume with the same input/plan/key: exercise then workouts, in order.
            fail_exercise[0] = False
            calls.clear()
            code, out, _ = run(['import', '--input', str(source), '--plan', plan, '--confirm', confirmation], recording)
            self.assertEqual(code, 0)
            result = json.loads(out)['data']
            self.assertEqual(result['exercises'][0]['status'], 'success')
            self.assertEqual(result['exercises'][0]['exerciseId'], new_id)
            self.assertEqual(result['workouts'][0]['status'], 'success')
            posts = [(url, headers, body) for url, headers, body in calls if body is not None]
            paths = [urllib.parse.urlsplit(url).path for url, _, _ in posts]
            self.assertEqual(paths, [hw.PREFIX + '/exercises', hw.PREFIX + '/workouts'])
            exercise_post = json.loads(posts[0][2])
            self.assertEqual(exercise_post['id'], new_id)
            self.assertTrue(posts[0][1]['Idempotency-Key'].startswith('hw-'))
            journal = json.loads(Path(plan + '.journal.json').read_text())
            self.assertEqual(sorted(journal), ['confirmation', 'exerciseResults', 'principalHash', 'results'])
        with tempfile.TemporaryDirectory() as directory:
            # A declared name that already exists on the server must fail the plan.
            source, _ = batch_file(Path(directory), name='合成深蹲')
            code, _, err = run(['plan', '--input', str(source), '--plan', str(Path(directory) / 'p.json')], transport)
            self.assertEqual(code, 2)
            self.assertIn('already exists', err)
        with tempfile.TemporaryDirectory() as directory:
            # A declared exercise no workout references must fail validation.
            body = body_with(existing['id'])
            batch = {'version': 1, 'batchId': '11111111-1111-4111-8111-111111111111',
                     'exercises': [{'id': new_id, 'body': declared_body}],
                     'workouts': [{'sourceId': 'row1', 'body': body}]}
            source = Path(directory) / 'batch.json'; source.write_text(json.dumps(batch))
            code, _, err = run(['plan', '--input', str(source), '--plan', str(Path(directory) / 'p.json')], transport)
            self.assertEqual(code, 2)
            self.assertIn('not referenced', err)
        with tempfile.TemporaryDirectory() as directory:
            # An unknown exercise without a declaration stays blocked at import.
            source, _ = batch_file(Path(directory), workouts_entries='unknown', declared_list='none')
            plan = str(Path(directory) / 'plan.json')
            code, out, _ = run(['plan', '--input', str(source), '--plan', plan], transport)
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(out)['unmatchedExerciseIds'], ['99999999-9999-4999-8999-999999999999'])
            code, _, err = run(['import', '--input', str(source), '--plan', plan, '--confirm', json.loads(out)['confirmation']], transport)
            self.assertEqual(code, 2)
        with tempfile.TemporaryDirectory() as directory:
            # Declaring exercises without the token capability must fail closed.
            limited = metadata(); limited['data']['capabilities'].append('workouts:create')

            def limited_transport(url, headers, timeout, body=None):
                if url.endswith('/metadata'): return response(limited)
                return transport(url, headers, timeout, body)

            source, _ = batch_file(Path(directory))
            code, _, err = run(['plan', '--input', str(source), '--plan', str(Path(directory) / 'p.json')], limited_transport)
            self.assertEqual(code, 2)
            self.assertIn('exercises:create', err)

    def test_real_loopback_post_same_body_key_and_redirect(self):
        calls = []
        redirect = [False]
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers['Content-Length']))
                calls.append((self.path, dict(self.headers), body))
                if redirect[0]:
                    self.send_response(307); self.send_header('Location', 'https://synthetic.invalid/steal'); self.end_headers(); return
                data = workout(detail=True)
                payload = json.dumps({'data': data, 'meta': {'requestId': 'x', 'replayed': True}}).encode()
                self.send_response(201); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(payload)
            def log_message(self, *_): pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            client = hw.Client({**ENV, 'HEALTHWORKER_BASE_URL': f'http://127.0.0.1:{server.server_port}'}, development=True)
            client.create_workout({'synthetic': True}, 'same-key')
            client.create_workout({'synthetic': True}, 'same-key')
            self.assertEqual(calls[0][2], calls[1][2])
            self.assertEqual(calls[0][0], hw.PREFIX + '/workouts')
            self.assertFalse(any('access' in k.lower() for k in calls[0][1]))
            redirect[0] = True
            with self.assertRaises(hw.ClientError): client.create_workout({}, 'same-key')
            self.assertEqual(len(calls), 3)
        finally:
            server.shutdown(); server.server_close(); thread.join()
