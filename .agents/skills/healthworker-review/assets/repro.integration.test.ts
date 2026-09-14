// 临时复现模板 —— 用真实 workerd/D1 路由按“浏览器真实语义”取证。
//
// 用法:
//   1. 复制到 tests/integration/zz-<名字>.test.ts
//   2. 把下面的 PROBE_CONFIRMED 改成 true，运行:
//        npx pnpm@10.34.5 test:integration -- tests/integration/zz-<名字>.test.ts
//   3. 读 stdout 的 PROBE 行与断言输出，把观察写进报告（文件名、断言、命令、输出）
//   4. 删除该文件，并校验 git status 回到基线
//
// 设计约束（很重要）:
// - 本文件只是探针，默认不做业务断言；忘记删除时，套件会因下面的守卫而失败，不会静默污染。
// - 请求一律按浏览器语义构造: 只有带 body 时才发 Content-Type，Origin 由浏览器自动添加，
//   不使用项目里会“补齐请求头”的测试辅助函数。
// - 不用环境变量做开关: workerd 测试运行时不会传递 process.env，开关必须是文件内常量。
// - 不触碰远端资源、生产库、--remote 命令。
import { env, applyD1Migrations, SELF } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import type { Bindings } from '../../src/worker/auth';

const bindings = env as unknown as Bindings & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const BASE = 'http://127.0.0.1:5173';
const observed: string[] = [];

// 探针开关：改成 true 只做观察；保持 false 时套件会失败（防止探针被当成通过的测试留在仓库里）。
const PROBE_CONFIRMED = false;

beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});

/** 按浏览器语义发请求：不带 body 就不带 Content-Type；Origin/If-Match 由调用方显式给出。 */
function browserFetch(
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: unknown },
) {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Origin: BASE,
    ...init.headers,
    // 与 src/web/lib.ts 的 api() 一致：仅在有 body 时声明 Content-Type。
    ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
  };
  return SELF.fetch(`${BASE}${path}`, {
    method: init.method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function probe(
  label: string,
  path: string,
  init: Parameters<typeof browserFetch>[1],
) {
  const response = await browserFetch(path, init);
  const text = await response.clone().text();
  const line = `PROBE ${label}: ${response.status} ${text.slice(0, 160).replace(/\s+/g, ' ')}`;
  observed.push(line);
  console.info(line);
  return response;
}

async function draft(): Promise<string> {
  const response = await browserFetch('/api/v1/workouts', {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: {
      startedAt: '2026-09-12T23:30:00Z',
      timezone: 'Asia/Shanghai',
      status: 'draft',
      durationSeconds: null,
      notes: null,
      entries: [],
    },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { data: { id: string } }).data.id;
}

it('PROBE: 无 body 写请求的客户端/服务端契约', async () => {
  const first = await draft();
  await probe(
    'DELETE 无 Content-Type（浏览器语义）',
    `/api/v1/workouts/${first}`,
    {
      method: 'DELETE',
      headers: { 'If-Match': '"1"' },
    },
  );

  const second = await draft();
  await probe(
    'DELETE 带 Content-Type（测试辅助函数常见写法）',
    `/api/v1/workouts/${second}`,
    {
      method: 'DELETE',
      headers: { 'If-Match': '"1"', 'Content-Type': 'application/json' },
    },
  );

  await probe(
    'GET 未知 API 路径（应为 JSON 404，不是 SPA HTML）',
    '/api/v1/zz-unknown',
    {
      method: 'GET',
    },
  );

  // 探针守卫：PROBE_CONFIRMED 为 true 时只输出观察；否则失败，避免探针被当成通过的测试留在套件里。
  if (!PROBE_CONFIRMED)
    expect.fail(
      '探针模板未被改写：请把上面的观察写成真实断言保留为回归测试，或删除 tests/integration/zz-*.test.ts',
    );
});
