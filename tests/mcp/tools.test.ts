import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../mcp/src/index';

const bindings = env as Record<string, string>;
const URL_PATH = `/mcp/${bindings.MCP_PATH_TOKEN}`;
const metadata = {
  data: {
    apiVersion: '1',
    timezone: 'Asia/Shanghai',
    capabilities: ['metadata', 'openapi', 'exercises', 'workouts', 'stats'],
    coverage: {
      workoutCount: 3,
      firstLocalDate: '2026-09-09',
      lastLocalDate: '2026-09-13',
    },
    authentication: 'access',
  },
  meta: { requestId: 'r' },
};

interface Envelope {
  result?: {
    isError?: boolean;
    content: [{ type: string; text: string }];
    structuredContent?: Record<string, unknown>;
  };
  error?: { code: number; message?: string };
}

const call = async (
  id: number,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Envelope> => {
  const response = await SELF.fetch(`https://example.test${URL_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  return (await response.json()) as Envelope;
};

let upstream: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  upstream = vi.spyOn(globalThis, 'fetch');
  upstream.mockReset();
  // A fresh Response per call: response bodies are single-use.
  upstream.mockImplementation(
    async () =>
      new Response(JSON.stringify(metadata), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
});

describe('tools/call upstream integration', () => {
  it('calls get_metadata with service credentials and returns JSON text', async () => {
    const { result } = await call(1, 'get_metadata');
    expect(result?.isError).toBeUndefined();
    expect(result?.content).toEqual([
      { type: 'text', text: JSON.stringify(metadata) },
    ]);
    expect(result?.structuredContent).toEqual(metadata);
    const [url, init] = upstream.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://health.tokenflare.top/api/agent/v1/metadata');
    const headers = new Headers(init.headers);
    expect(headers.get('CF-Access-Client-Id')).toBe('test-client-id');
    expect(headers.get('CF-Access-Client-Secret')).toBe('test-client-secret');
    expect(headers.get('Accept')).toBe('application/json');
  });
  it('builds encoded queries for searches and date ranges', async () => {
    await call(2, 'search_exercises', {
      query: '宽距 高位下拉',
      kind: 'strength',
      limit: 5,
    });
    const [searchUrl] = upstream.mock.calls[0] as unknown as [string];
    expect(searchUrl).toBe(
      `https://health.tokenflare.top/api/agent/v1/exercises?${new URLSearchParams({ query: '宽距 高位下拉', kind: 'strength', limit: '5' })}`,
    );
    await call(3, 'list_workouts', {
      from: '2026-09-01',
      to: '2026-10-01',
      status: 'completed',
    });
    const [listUrl] = upstream.mock.calls[1] as unknown as [string];
    expect(listUrl).toContain('from=2026-09-01');
    expect(listUrl).toContain('to=2026-10-01');
    expect(listUrl).toContain('status=completed');
    expect(listUrl).not.toContain('includeNotes');
  });
  it('embeds path and rejects invalid arguments without calling upstream', async () => {
    await call(4, 'get_workout', {
      id: '61CE5F44-6ED6-4DF9-BCB8-542EDBA8FBA0',
    });
    const [url] = upstream.mock.calls[0] as unknown as [string];
    expect(url).toBe(
      'https://health.tokenflare.top/api/agent/v1/workouts/61CE5F44-6ED6-4DF9-BCB8-542EDBA8FBA0',
    );
    upstream.mockClear();
    for (const [name, args] of [
      ['get_workout', { id: 'not-a-uuid' }],
      ['list_workouts', {}],
      [
        'get_strength_stats',
        {
          exerciseId: '00000000-0000-4000-8000-000000000001',
          from: '2026-9-1',
          to: '2026-10-01',
        },
      ],
      ['list_workouts', { from: '2026-09-01', to: '2026-10-01', limit: 1000 }],
      ['search_exercises', { unknown: true }],
    ] as const) {
      const { error } = await call(5, name, { ...args });
      expect(error).toMatchObject({ code: -32602 });
    }
    expect(upstream).not.toHaveBeenCalled();
  });
  it('maps upstream failures to safe isError tool results', async () => {
    upstream.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'STATS_RANGE_TOO_DENSE', message: '缩小范围' },
          }),
          { status: 422 },
        ),
    );
    const rejected = (
      await call(6, 'get_summary_stats', {
        from: '2026-01-01',
        to: '2026-12-31',
        granularity: 'day',
      })
    ).result;
    expect(rejected?.isError).toBe(true);
    expect(rejected?.content[0].text).toBe(
      'UPSTREAM_REJECTED STATS_RANGE_TOO_DENSE: 缩小范围',
    );
    upstream.mockImplementation(
      async () => new Response('denied', { status: 403 }),
    );
    const denied = (await call(7, 'get_metadata')).result;
    expect(denied?.content[0].text).toBe(
      'AUTHENTICATION: 上游拒绝访问（HTTP 403）。',
    );
    upstream.mockImplementation(
      async () => new Response('boom', { status: 503 }),
    );
    const unavailable = (await call(8, 'get_metadata')).result;
    expect(unavailable?.content[0].text).toBe(
      'UPSTREAM_ERROR: 训练数据服务暂时不可用（HTTP 503）。',
    );
    upstream.mockImplementation(async () => {
      throw new TypeError('network unreachable');
    });
    const unreachable = (await call(9, 'get_metadata')).result;
    expect(unreachable?.content[0].text).toBe(
      'UPSTREAM_UNREACHABLE: 无法连接训练数据服务，请稍后重试。',
    );
  });
  it('rejects prototype-chain and own __proto__ argument keys', async () => {
    for (const args of [
      { toString: 'x' },
      { constructor: 'x' },
      JSON.parse('{"__proto__": {"x": 1}}'),
    ]) {
      const { error } = await call(11, 'get_metadata', args);
      expect(error).toMatchObject({ code: -32602 });
    }
    expect(upstream).not.toHaveBeenCalled();
  });
  it('returns -32603 when the upstream body cannot be read', async () => {
    upstream.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('stream broken'));
            },
          }),
          { status: 200 },
        ),
    );
    const { error } = await call(12, 'get_metadata');
    expect(error).toMatchObject({ code: -32603 });
  });
  it('returns RESPONSE_TOO_LARGE over 4 MiB upstream bodies', async () => {
    upstream.mockImplementation(
      async () =>
        new Response('x'.repeat(4 * 1024 * 1024 + 1), { status: 200 }),
    );
    const { result } = await call(13, 'get_metadata');
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain('RESPONSE_TOO_LARGE');
  });
  it('rejects upstream redirects instead of following them', async () => {
    upstream.mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'https://attacker.example/' },
        }),
    );
    const { result } = await call(14, 'get_metadata');
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toBe(
      'REDIRECT_REJECTED: 上游返回重定向，已拒绝以保护凭据。',
    );
  });
  it('derives a stable idempotency key and injects ids for create_workout', async () => {
    upstream.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            data: { id: '00000000-0000-4000-8000-00000000aaaa' },
            meta: { requestId: 'r', replayed: false },
          }),
          {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    );
    const workout = {
      startedAt: '2026-09-20T04:00:00Z',
      timezone: 'Asia/Shanghai',
      status: 'completed',
      entries: [
        {
          exerciseId: '00000000-0000-4000-8000-000000000001',
          kind: 'strength',
          sets: [{ reps: 8, loadKg: 49 }],
        },
      ],
    };
    const first = await call(20, 'create_workout', workout);
    await call(21, 'create_workout', structuredClone(workout));
    expect(first.result?.isError).toBeUndefined();
    const [url, init] = upstream.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const [url2, init2] = upstream.mock.calls[1] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://health.tokenflare.top/api/agent/v1/workouts');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('Idempotency-Key')).toMatch(/^hw-mcp-[0-9a-f]{64}$/);
    expect(new Headers(init2.headers).get('Idempotency-Key')).toBe(
      headers.get('Idempotency-Key'),
    );
    expect(headers.get('Content-Type')).toBe('application/json');
    const body = JSON.parse(init.body as string) as {
      entries: {
        id: string;
        notes: null;
        sets: {
          id: string;
          setType: string;
          completed: boolean;
          durationSeconds: null;
        }[];
      }[];
      durationSeconds: null;
      notes: null;
    };
    expect(body.durationSeconds).toBeNull();
    expect(body.notes).toBeNull();
    expect(body.entries[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.entries[0]?.notes).toBeNull();
    expect(body.entries[0]?.sets[0]).toMatchObject({
      setType: 'working',
      completed: true,
      durationSeconds: null,
    });
    expect(body.entries[0]?.sets[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(url2).toBe(url);
  });
  it('honours an explicit idempotencyKey and surfaces upstream rejection for creates', async () => {
    upstream.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'EXERCISE_EXISTS', message: '同名动作已存在' },
          }),
          {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    );
    const { result } = await call(22, 'create_exercise', {
      name: '合成新动作',
      kind: 'strength',
      measurementMode: 'reps',
      resistanceMode: 'external',
      loadConvention: 'total',
      repConvention: 'total',
      idempotencyKey: 'hw-explicit-key-1',
    });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toBe(
      'UPSTREAM_REJECTED EXERCISE_EXISTS: 同名动作已存在',
    );
    const [url, init] = upstream.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://health.tokenflare.top/api/agent/v1/exercises');
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe(
      'hw-explicit-key-1',
    );
    const body = JSON.parse(init.body as string) as {
      aliases: string[];
      muscleGroups: string[];
      volumeMultiplier: null;
      equipment: null;
      cardioCategory: null;
    };
    expect(body).toMatchObject({
      aliases: [],
      muscleGroups: [],
      volumeMultiplier: null,
      equipment: null,
      cardioCategory: null,
    });
    // The MCP-level switch must never leak into the exercise body.
    expect(JSON.stringify(body)).not.toContain('idempotencyKey');
  });
  it('marks create tools as write tools in tools/list', async () => {
    const envelope = (await SELF.fetch(`https://example.test${URL_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 23, method: 'tools/list' }),
    }).then((r) => r.json())) as {
      result: {
        tools: { name: string; annotations: { readOnlyHint: boolean } }[];
      };
    };
    const byName = new Map(
      envelope.result.tools.map((tool) => [tool.name, tool]),
    );
    expect(byName.get('create_workout')?.annotations.readOnlyHint).toBe(false);
    expect(byName.get('create_exercise')?.annotations.readOnlyHint).toBe(false);
    expect(byName.get('get_metadata')?.annotations.readOnlyHint).toBe(true);
  });
  it('fails closed when service credentials are not configured', async () => {
    const request = new Request(`https://example.test${URL_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'get_metadata', arguments: {} },
      }),
    });
    const pathToken: string = bindings.MCP_PATH_TOKEN as string;
    const response = await worker.fetch(request, {
      AGENT_BASE_URL: 'https://health.tokenflare.top',
      AGENT_CLIENT_ID: '',
      AGENT_CLIENT_SECRET: '',
      MCP_PATH_TOKEN: pathToken,
    });
    const resultJson = (await response.json()) as Envelope;
    expect(resultJson.result?.isError).toBe(true);
    expect(resultJson.result?.content[0].text).toContain('CONFIGURATION');
  });
});
