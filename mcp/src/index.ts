// HealthWorker MCP server: a stateless MCP Streamable HTTP subset, hand-rolled
// to keep the deployment free of Durable Objects and protocol-framework
// dependencies. The intentional surface is small: initialize / notifications /
// ping / tools/list / tools/call, JSON responses only, no sessions, no
// server-initiated streams. A real MCP SDK client runs against this endpoint in
// tests to pin ecosystem compatibility.
//
// Tool surface: 7 read-only tools plus 2 create-only tools (create_workout /
// create_exercise). There is no update/delete/archive/settings/export/admin
// tool. Security model: the connector URL path embeds an unguessable token
// compared in constant time (ChatGPT custom connectors cannot send custom auth
// headers); upstream calls carry Cloudflare Access service credentials stored
// as Worker secrets. Read tools issue GET only; create tools POST new workouts
// or exercises through the import-authorized service identity.

import {
  callUpstream,
  findTool,
  ToolArgumentError,
  TOOL_DEFINITIONS,
  validateArguments,
} from './tools';
import type { Env } from './env';

const LATEST_PROTOCOL_VERSION = '2025-06-18';
const MAX_REQUEST_BYTES = 262144;

const SERVER_INFO = {
  name: 'healthworker',
  title: 'HealthWorker 训练数据（只读 + 受控创建）',
  version: '1.0.0',
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const NOTIFICATION: unique symbol = Symbol('notification');

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function constantTimeEqual(a: string, b: string): boolean {
  const bytesA = new TextEncoder().encode(a);
  const bytesB = new TextEncoder().encode(b);
  let diff = bytesA.length ^ bytesB.length;
  const length = Math.max(bytesA.length, bytesB.length);
  for (let i = 0; i < length; i++) diff |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0);
  return diff === 0;
}

function parseStructured(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

interface RpcReply {
  status: number;
  body: Record<string, unknown>;
}

function jsonRpcResult(id: unknown, result: Record<string, unknown>): RpcReply {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function jsonRpcError(
  id: unknown,
  code: number,
  message: string,
  status = 200,
): RpcReply {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function negotiateProtocol(params: unknown): string {
  const requested =
    typeof params === 'object' && params !== null
      ? (params as { protocolVersion?: unknown }).protocolVersion
      : undefined;
  // Echo any date-shaped version: the tools-only surface is stable across
  // revisions, and replying with our older version makes strict newer clients
  // abort the handshake.
  return typeof requested === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

async function handleRpc(
  request: JsonRpcRequest,
  env: Env,
): Promise<RpcReply | typeof NOTIFICATION> {
  const { id, method } = request;
  if (typeof method !== 'string')
    return jsonRpcError(
      id ?? null,
      -32600,
      'Invalid Request: 缺少 method',
      400,
    );
  // Notifications (no id) never produce responses; the transport answers 202.
  if (id === undefined) return NOTIFICATION;
  if (method === 'initialize')
    return jsonRpcResult(id, {
      protocolVersion: negotiateProtocol(request.params),
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        'HealthWorker 个人训练数据入口：读取（get_metadata/search_exercises/list_workouts/get_workout/三类统计）' +
        '与受控新增（create_workout/create_exercise，仅新增，绝不修改或删除）。' +
        '查阅分析：先 get_metadata 确认范围与单位，统计前先 search_exercises 解析动作 UUID，日期范围写明 [from, to)。' +
        '写入：仅当用户明确要求记录数据时调用；调用前必须把将写入的完整内容逐项展示给用户并取得确认；' +
        '动作必须先用 search_exercises 解析，确实不存在且用户同意其计量口径后才 create_exercise；' +
        '绝不虚构用户未提供的重量、次数或日期。只做客观统计与描述，不做医疗判断。',
    });
  if (method === 'ping') return jsonRpcResult(id, {});
  if (method === 'tools/list')
    return jsonRpcResult(id, {
      tools: TOOL_DEFINITIONS.map(
        ({
          name,
          title,
          description,
          inputSchema,
          outputSchema,
          annotations,
        }) => ({
          name,
          title,
          description,
          inputSchema,
          outputSchema,
          annotations,
        }),
      ),
    });
  if (method === 'tools/call') return callTool(request.params, id, env);
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

async function callTool(
  params: unknown,
  id: unknown,
  env: Env,
): Promise<RpcReply> {
  if (typeof params !== 'object' || params === null)
    return jsonRpcError(id, -32602, 'Invalid params: 缺少工具调用参数');
  const { name, arguments: args } = params as {
    name?: unknown;
    arguments?: unknown;
  };
  if (typeof name !== 'string')
    return jsonRpcError(id, -32602, 'Invalid params: 缺少工具名称');
  const tool = findTool(name);
  if (!tool) return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
  if (
    args !== undefined &&
    (typeof args !== 'object' || args === null || Array.isArray(args))
  )
    return jsonRpcError(id, -32602, 'Invalid params: arguments 必须是对象');
  const rawArgs = (args ?? {}) as Record<string, unknown>;
  try {
    const validated = validateArguments(tool, rawArgs);
    const { text, isError } = await callUpstream(tool, validated, env);
    const structured = isError ? undefined : parseStructured(text);
    return jsonRpcResult(id, {
      content: [{ type: 'text', text }],
      ...(structured === undefined ? {} : { structuredContent: structured }),
      ...(isError ? { isError: true } : {}),
    });
  } catch (error) {
    if (error instanceof ToolArgumentError)
      return jsonRpcError(id, -32602, `Invalid params: ${error.message}`);
    return jsonRpcError(id, -32603, 'Internal error');
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const token = env.MCP_PATH_TOKEN;
    const received = url.pathname.startsWith('/mcp/')
      ? url.pathname.slice('/mcp/'.length)
      : '';
    const exact = !!token && constantTimeEqual(received, token);
    // Some connector clients normalize the whole URL to lowercase; the token
    // stays ~168-bit strong under case folding, so accept that form too.
    const caseOnly =
      !exact &&
      !!token &&
      received.length === token.length &&
      constantTimeEqual(received.toLowerCase(), token.toLowerCase());
    const matched = exact || caseOnly;
    // Minimal transport diagnostic: method/user-agent/Accept and the path
    // SHAPE only (segment lengths, never the token itself), so a mismatched
    // connector URL can be diagnosed without logging credentials.
    const segments = url.pathname.split('/').filter((part) => part.length > 0);
    const shape =
      '/' +
      segments
        .map((part, index) => (index === 0 ? part : `<${part.length}>`))
        .join('/');
    console.log(
      `mcp request method=${request.method} pathShape=${shape} matched=${matched} exact=${exact} caseOnly=${caseOnly} ua=${request.headers.get('User-Agent') ?? '-'} accept=${request.headers.get('Accept') ?? '-'}`,
    );
    if (!matched) return new Response(null, { status: 404 });
    if (request.method !== 'POST')
      return new Response(null, { status: 405, headers: { Allow: 'POST' } });

    // MCP-Protocol-Version is accepted but not enforced: rejecting newer
    // revisions here would strand forward-compatible clients at the door.

    const raw = await request.text();
    if (raw.length > MAX_REQUEST_BYTES)
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Request too large' },
        }),
        { status: 413, headers: JSON_HEADERS },
      );
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }),
        { status: 400, headers: JSON_HEADERS },
      );
    }
    if (
      typeof message !== 'object' ||
      message === null ||
      Array.isArray(message) ||
      message.jsonrpc !== '2.0'
    )
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32600,
            message: 'Invalid Request: 必须是单一 JSON-RPC 2.0 消息',
          },
        }),
        { status: 400, headers: JSON_HEADERS },
      );

    const outcome = await handleRpc(message, env);
    if (outcome === NOTIFICATION) return new Response(null, { status: 202 });
    // Spec-compliant clients list both content types; ChatGPT's connector
    // client only parses SSE, so stream whenever the client accepts it.
    if ((request.headers.get('Accept') ?? '').includes('text/event-stream'))
      return new Response(
        `event: message\ndata: ${JSON.stringify(outcome.body)}\n\n`,
        {
          status: outcome.status,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
        },
      );
    return new Response(JSON.stringify(outcome.body), {
      status: outcome.status,
      headers: JSON_HEADERS,
    });
  },
};
