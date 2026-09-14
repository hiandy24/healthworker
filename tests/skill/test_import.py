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
            config.write_text(json.dumps({'baseUrl': ENV['HEALTHWORKER_BASE_URL'], 'clientId': ENV['HEALTHWORKER_ACCESS_CLIENT_ID']}))
            config.chmod(0o600)
            env = {'HEALTHWORKER_CONFIG': str(config), 'HEALTHWORKER_ACCESS_CLIENT_SECRET': ENV['HEALTHWORKER_ACCESS_CLIENT_SECRET']}
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
            for result in journal['results'].values(): result['firstAttempt'] = 0
            journal_path.write_text(json.dumps(journal))
            before_expired = len([b for _, _, b in calls if b])
            code, expired_out, _ = run(['import', *args, '--confirm', confirmation])
            self.assertEqual(code, 4)
            self.assertEqual(json.loads(expired_out)['data'][0]['status'], 'needs_reconciliation')
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
            for path in Path(directory).iterdir(): self.assertNotIn(ENV['HEALTHWORKER_ACCESS_CLIENT_SECRET'], path.read_text())

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
