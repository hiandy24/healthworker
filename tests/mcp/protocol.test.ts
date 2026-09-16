import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const bindings = env as Record<string, string>;
const URL_PATH = `/mcp/${bindings.MCP_PATH_TOKEN}`;

interface Envelope {
  jsonrpc?: string;
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message?: string };
}
const json = (response: Response) => response.json() as Promise<Envelope>;

const post = (
  body: string,
  path: string = URL_PATH,
  version?: string,
  accept = 'application/json',
) =>
  SELF.fetch(`https://example.test${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: accept,
      ...(version ? { 'MCP-Protocol-Version': version } : {}),
    },
    body,
  });

describe('transport and auth', () => {
  it('accepts case-normalized path tokens from URL-normalizing clients', async () => {
    // The /mcp prefix stays lowercase; only the token segment is case-folded.
    const caseFolded = `/mcp/${(bindings.MCP_PATH_TOKEN as string).toUpperCase()}`;
    const response = await post(
      '{"jsonrpc":"2.0","id":8,"method":"ping"}',
      caseFolded,
    );
    expect(response.status).toBe(200);
  });
  it('hides the endpoint behind the path token', async () => {
    for (const path of [
      '/mcp',
      `/mcp/${bindings.MCP_PATH_TOKEN}x`,
      '/mcp/wrong-token',
    ])
      expect(
        (
          await SELF.fetch(`https://example.test${path}`, {
            method: 'POST',
            body: '{}',
          })
        ).status,
      ).toBe(404);
  });
  it('rejects non-POST methods with 405 and Allow', async () => {
    for (const method of ['GET', 'DELETE', 'OPTIONS']) {
      const response = await SELF.fetch(`https://example.test${URL_PATH}`, {
        method,
      });
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('POST');
    }
  });
  it('answers parse and structure errors before any handler', async () => {
    const parse = await post('{broken');
    expect(parse.status).toBe(400);
    expect(await parse.json()).toMatchObject({ error: { code: -32700 } });
    for (const body of [
      '[1,2]',
      '{"jsonrpc":"1.0","id":1,"method":"ping"}',
      '{"id":1,"method":"ping"}',
    ]) {
      const invalid = await post(body);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: -32600 } });
    }
  });
  it('rejects oversized request bodies with 413', async () => {
    const response = await post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'ping',
        pad: 'x'.repeat(262145),
      }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: -32600 } });
  });
});

describe('protocol surface', () => {
  it('negotiates initialize and echoes known versions', async () => {
    const negotiated = await json(
      await post(
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","clientInfo":{"name":"t","version":"1"}}}',
      ),
    );
    expect(negotiated).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'healthworker' },
      },
    });
    const echoed = await json(
      await post(
        '{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2026-03-01"}}',
      ),
    );
    // Date-shaped versions are echoed back: the tools-only surface is stable
    // across revisions and a downgrade reply makes strict newer clients abort.
    expect(echoed.result?.protocolVersion).toBe('2026-03-01');
  });
  it('returns 202 for notifications without echoing state', async () => {
    const response = await post(
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });
  it('answers ping and unknown methods', async () => {
    const ping = await json(
      await post('{"jsonrpc":"2.0","id":3,"method":"ping"}'),
    );
    expect(ping.result).toEqual({});
    const unknown = await json(
      await post('{"jsonrpc":"2.0","id":4,"method":"resources/list"}'),
    );
    expect(unknown.error).toMatchObject({ code: -32601 });
  });
  it('streams SSE-wrapped responses when the client accepts event-stream', async () => {
    const response = await post(
      '{"jsonrpc":"2.0","id":7,"method":"tools/list"}',
      URL_PATH,
      undefined,
      'application/json, text/event-stream',
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    const body = await response.text();
    expect(body.startsWith('event: message\ndata: ')).toBe(true);
    const payload = JSON.parse(
      body.slice('event: message\ndata: '.length, body.indexOf('\n\n')),
    );
    expect(payload.result.tools).toHaveLength(9);
  });
  it('lists the seven read tools plus two create-only tools', async () => {
    const { result } = await json(
      await post('{"jsonrpc":"2.0","id":5,"method":"tools/list"}'),
    );
    const names = (result?.tools as { name: string }[]).map(
      (tool) => tool.name,
    );
    expect(names).toEqual([
      'get_metadata',
      'search_exercises',
      'list_workouts',
      'get_workout',
      'get_summary_stats',
      'get_strength_stats',
      'get_cardio_stats',
      'create_workout',
      'create_exercise',
    ]);
    for (const tool of result?.tools as {
      name: string;
      title: string;
      inputSchema: Record<string, unknown>;
      outputSchema: Record<string, unknown>;
      annotations: Record<string, unknown>;
    }[]) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.outputSchema).toMatchObject({ type: 'object' });
      const createOnly =
        tool.name === 'create_workout' || tool.name === 'create_exercise';
      expect(tool.annotations).toMatchObject({
        readOnlyHint: !createOnly,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(tool.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
    }
  });
});
