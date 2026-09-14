// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { exportAttachment } from '../../src/web/Settings';
afterEach(() => vi.unstubAllGlobals());
it('downloads raw JSON attachment as Blob rather than parsing a data envelope', async () => {
  const body = '{"schemaVersion":"1","workouts":[]}';
  const response = new Response(body, {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="backup.json"',
    },
  });
  const json = vi.spyOn(response, 'json');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  const blob = await exportAttachment('json', 'workouts');
  expect(blob.size).toBe(body.length);
  expect(json).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledWith(
    '/api/v1/export?format=json',
    expect.objectContaining({ credentials: 'same-origin', redirect: 'error' }),
  );
});
it('requests explicit CSV dataset and rejects login HTML attachment mismatches', async () => {
  const mock = vi.fn().mockResolvedValue(
    new Response('a,b\n1,2', {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment',
      },
    }),
  );
  vi.stubGlobal('fetch', mock);
  await exportAttachment('csv', 'strengthSets');
  expect(mock.mock.calls[0]![0]).toBe(
    '/api/v1/export?format=csv&dataset=strengthSets',
  );
  mock.mockResolvedValue(
    new Response('<html>login</html>', {
      headers: { 'Content-Type': 'text/html' },
    }),
  );
  await expect(exportAttachment('json', 'workouts')).rejects.toThrow(
    '不是预期附件',
  );
});
