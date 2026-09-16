// Ecosystem compatibility proof: the official MCP TypeScript SDK's client (same
// lineage as the clients ChatGPT/Claude use) drives the worker over real TCP
// through initialize -> notifications -> tools/list -> tools/call. Runs in the
// plain Node environment: a tiny http server adapts Node req/res to the
// worker's fetch handler, so no workerd pool is involved on the client side.

// @vitest-environment node
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  afterEach,
  beforeAll,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import worker from '../../mcp/src/index';
import type { Env } from '../../mcp/src/env';

const ENV: Env = {
  AGENT_BASE_URL: 'https://health.tokenflare.top',
  AGENT_CLIENT_ID: 'test-client-id',
  AGENT_CLIENT_SECRET: 'test-client-secret',
  MCP_PATH_TOKEN: 'sdk-path-token',
};
const metadata = {
  data: {
    apiVersion: '1',
    timezone: 'Asia/Shanghai',
    coverage: { workoutCount: 3, firstLocalDate: '2026-09-09' },
    authentication: 'access',
  },
  meta: { requestId: 'r' },
};

let server: ReturnType<typeof createServer>;
let port: number;
let client: Client;
let realFetch: typeof globalThis.fetch;
let upstream: ReturnType<typeof vi.spyOn>;

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

beforeAll(async () => {
  realFetch = globalThis.fetch.bind(globalThis);
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    const init: RequestInit = {
      method: req.method ?? 'GET',
      headers: req.headers as Record<string, string>,
    };
    if (req.method !== 'GET' && req.method !== 'HEAD')
      init.body = new Uint8Array(body);
    const request = new Request(`https://example.test${req.url}`, init);
    const response = await worker.fetch(request, ENV);
    res.writeHead(
      response.status,
      Object.fromEntries(response.headers.entries()),
    );
    res.end(response.body ? Buffer.from(await response.arrayBuffer()) : null);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  client = new Client({ name: 'sdk-compat-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp/sdk-path-token`),
  );
  // exactOptionalPropertyTypes makes the SDK's own Transport interface reject
  // its concrete implementation; the runtime contract is what we are testing.
  await client.connect(transport as Parameters<typeof client.connect>[0]);
});
afterEach(() => {
  upstream?.mockRestore();
});
afterAll(async () => {
  await client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('official SDK client compatibility over real TCP', () => {
  it('completes the initialize handshake and reports server identity', () => {
    expect(client.getServerVersion()).toMatchObject({ name: 'healthworker' });
  });
  it('lists the seven read tools plus two create-only tools through the SDK', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
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
  });
  it('calls tools end to end and surfaces upstream failures as isError', async () => {
    upstream = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: unknown, init?: unknown) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof Request
              ? input.url
              : String(input);
        if (!url.startsWith(`${ENV.AGENT_BASE_URL}/api/agent/v1`))
          // workers-types and DOM RequestInit unions conflict; the runtime
          // fetch accepts both, so bypass overload resolution here.
          return (
            realFetch as (input: unknown, init?: unknown) => Promise<Response>
          )(input, init);
        return new Response(JSON.stringify(metadata), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
    const result = await client.callTool({
      name: 'get_metadata',
      arguments: {},
    });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(
      (result.content as [{ type: string; text: string }])[0].text,
    );
    expect(payload).toMatchObject({ data: { authentication: 'access' } });
    upstream.mockImplementation(async (input: unknown, init?: unknown) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
      if (!url.startsWith(`${ENV.AGENT_BASE_URL}/api/agent/v1`))
        return (
          realFetch as (input: unknown, init?: unknown) => Promise<Response>
        )(input, init);
      return new Response(
        JSON.stringify({ error: { code: 'NOT_FOUND', message: '不存在' } }),
        { status: 404 },
      );
    });
    const missing = await client.callTool({
      name: 'get_workout',
      arguments: { id: '00000000-0000-4000-8000-000000000099' },
    });
    expect(missing.isError).toBe(true);
    expect((missing.content as [{ type: string; text: string }])[0].text).toBe(
      'UPSTREAM_REJECTED NOT_FOUND: 不存在',
    );
  });
});
