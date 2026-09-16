import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { exerciseRoutes } from './exercises';
import { workoutRoutes } from './workouts';
import { statsRoutes } from './stats';
import { settingsRoutes, readSettings } from './settings';
import { exportRoutes } from './export';
import {
  errorSchema,
  metadataSchema,
  LIMITS,
  units,
} from '../shared/contracts';
import { authenticate, AuthError, type Bindings } from './auth';
type Env = {
  Bindings: Bindings;
  Variables: {
    requestId: string;
    authentication: 'access' | 'local_mock';
    principal: string;
    canImport: boolean;
  };
};
const app = new OpenAPIHono<Env>();
app.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  c.header('X-Request-Id', c.get('requestId'));
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  await next();
});
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path.includes('//') || /%2f|%5c|%00/i.test(path))
    return c.json(
      {
        error: { code: 'INVALID_PATH', message: '请求路径无效' },
        requestId: c.get('requestId'),
      },
      400,
    );
  const agent = path === '/api/agent' || path.startsWith('/api/agent/');
  try {
    c.set(
      'authentication',
      await authenticate(
        c.req.raw,
        c.env,
        agent,
        undefined,
        (principal) => c.set('principal', principal),
        (allowed) => c.set('canImport', allowed),
      ),
    );
  } catch (error) {
    if (error instanceof AuthError)
      return c.json(
        {
          error: {
            code: error.code,
            message:
              error.status === 503
                ? '认证尚未配置'
                : '认证失败或无权访问此入口',
          },
          requestId: c.get('requestId'),
        },
        error.status,
      );
    throw error;
  }
  const importCreate =
    agent &&
    c.get('canImport') === true &&
    c.req.method === 'POST' &&
    (path === '/api/agent/v1/workouts' || path === '/api/agent/v1/exercises');
  if (agent && c.req.method !== 'GET' && !importCreate) {
    c.header('Allow', 'GET');
    return c.json(
      {
        error: { code: 'METHOD_NOT_ALLOWED', message: 'Agent 仅允许 GET' },
        requestId: c.get('requestId'),
      },
      405,
    );
  }
  if (!agent && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    if (!c.env.APP_ORIGIN || c.req.header('Origin') !== c.env.APP_ORIGIN)
      return c.json(
        {
          error: {
            code: 'ORIGIN_FORBIDDEN',
            message: '写请求必须来自应用同源页面',
          },
          requestId: c.get('requestId'),
        },
        403,
      );
  }
  if (
    importCreate ||
    (!agent && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method))
  ) {
    if (
      c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json'
    )
      return c.json(
        {
          error: {
            code: 'INVALID_CONTENT_TYPE',
            message: '只接受 application/json',
          },
          requestId: c.get('requestId'),
        },
        400,
      );
  }
  await next();
});
app.use(
  '*',
  bodyLimit({
    maxSize: LIMITS.bodyBytes,
    onError: (c) =>
      c.json(
        {
          error: { code: 'BODY_TOO_LARGE', message: '请求体超过限制' },
          requestId: c.get('requestId'),
        },
        413,
      ),
  }),
);
for (const prefix of ['/api/v1', '/api/agent/v1']) {
  const api = new OpenAPIHono<Env>();
  api.openapi(
    createRoute({
      method: 'get',
      path: '/metadata',
      security: [{ AccessJWT: [] }],
      responses: {
        200: {
          description:
            'Implemented capabilities and live all/completed workout coverage; settings timezone or virtual UTC fallback (not proof of user confirmation). Legacy milestone is not acceptance status.',
          content: { 'application/json': { schema: metadataSchema } },
        },
        401: {
          description: 'Authentication required',
          content: { 'application/json': { schema: errorSchema } },
        },
        403: {
          description: 'Wrong audience, identity class or owner',
          content: { 'application/json': { schema: errorSchema } },
        },
        503: {
          description: 'Authentication unconfigured',
          content: { 'application/json': { schema: errorSchema } },
        },
      },
    }),
    async (c) => {
      const coverage = await c.env.DB.prepare(
        "SELECT count(*) AS workoutCount,coalesce(sum(status='completed'),0) AS completedWorkoutCount,coalesce(sum(status='draft'),0) AS draftWorkoutCount,min(local_date) AS firstLocalDate,max(local_date) AS lastLocalDate,min(CASE WHEN status='completed' THEN local_date END) AS firstCompletedLocalDate,max(CASE WHEN status='completed' THEN local_date END) AS lastCompletedLocalDate FROM workouts",
      ).first();
      return c.json(
        {
          data: {
            apiVersion: '1' as const,
            schemaVersion: '1' as const,
            definitionsVersion: '1' as const,
            milestone: 'M1' as const,
            units,
            dateBasis: 'workout_local_date' as const,
            rangeSemantics: '[from,to)' as const,
            weekStartsOn: 'monday' as const,
            warmupDefault: 'exclude' as const,
            timezone: (await readSettings(c.env.DB)).timezone,
            capabilities: [
              'metadata',
              'openapi',
              'exercises',
              'workouts',
              'stats',
              ...(prefix.includes('agent')
                ? c.get('canImport') === true
                  ? ['exercises:create', 'workouts:create']
                  : []
                : ['settings', 'export']),
            ] as (
              | 'metadata'
              | 'openapi'
              | 'exercises'
              | 'workouts'
              | 'stats'
              | 'settings'
              | 'export'
              | 'exercises:create'
              | 'workouts:create'
            )[],
            coverage: {
              ...coverage,
              dateBasis: 'workout_local_date' as const,
            } as import('../shared/contracts').Metadata['data']['coverage'],
            authentication: c.get('authentication'),
          },
          meta: { requestId: c.get('requestId') },
        },
        200,
      );
    },
  );
  api.openAPIRegistry.registerComponent('securitySchemes', 'AccessJWT', {
    type: 'apiKey',
    in: 'header',
    name: 'Cf-Access-Jwt-Assertion',
    description:
      'Validated Cloudflare Access application JWT (single AUD). Human routes require owner email, nonempty sub and no common_name; Agent routes require service common_name, empty sub and no email. Agent clients send Service Token headers to the Access edge, not this assertion directly.',
  });
  api.route('/', exerciseRoutes(prefix.includes('agent')));
  api.route('/', workoutRoutes(prefix.includes('agent')));
  api.route('/', statsRoutes());
  if (!prefix.includes('agent')) {
    api.route('/', settingsRoutes());
    api.route('/', exportRoutes());
  }
  api.doc('/openapi.json', {
    openapi: '3.0.0',
    security: [{ AccessJWT: [] }],
    info: {
      title: prefix.includes('agent')
        ? 'HealthWorker Agent API'
        : 'HealthWorker Human API',
      version: '1.0.0',
    },
    servers: [{ url: prefix }],
  });
  app.route(prefix, api);
}
app.notFound((c) =>
  c.json(
    {
      error: { code: 'NOT_FOUND', message: '接口不存在或尚未实现' },
      requestId: c.get('requestId'),
    },
    404,
  ),
);
app.onError((error, c) => {
  if ('status' in error && error.status === 400)
    return c.json(
      {
        error: { code: 'INVALID_JSON', message: 'JSON 格式无效' },
        requestId: c.get('requestId'),
      },
      400,
    );
  return c.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: '服务暂时不可用，请提供请求编号',
      },
      requestId: c.get('requestId'),
    },
    500,
  );
});
export default app;
