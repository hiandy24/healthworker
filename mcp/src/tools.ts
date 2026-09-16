// Tool definitions for the HealthWorker MCP server: a facade over the existing
// Agent API. Reads map to GET; create tools map to the create-only POST
// endpoints the import-allowlisted service identity already authorizes. No
// update/delete/archive/admin surface exists here by construction, and the
// upstream API remains the authoritative validator (Zod rechecks everything).

import type { Env } from './env';

export interface UpstreamRequest {
  path: string;
  method: 'GET' | 'POST';
  /** POST bodies are forwarded verbatim; the upstream Zod schema is authoritative. */
  body?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  /** Human-readable title required by the ChatGPT plugin tool checklist. */
  title: string;
  description: string;
  /** Safety annotations are part of the documented connector contract. */
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
  /** Upstream responses are objects; declared loosely so the contract is explicit. */
  outputSchema: { type: 'object'; additionalProperties: true };
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
    additionalProperties: false;
  };
  /** Builds the upstream request from validated tool arguments. */
  build: (args: Record<string, unknown>, env: Env) => UpstreamRequest;
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

// Creates are additive and reversible by the owner in the human UI, so
// destructiveHint stays false while readOnlyHint turns off: ChatGPT then
// treats these as write tools that require user confirmation.
const CREATE_ONLY = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const OBJECT_OUTPUT = { type: 'object', additionalProperties: true } as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ToolArgumentError extends Error {}

function requireString(
  args: Record<string, unknown>,
  key: string,
  pattern: RegExp,
  description: string,
): string {
  const value = args[key];
  if (typeof value !== 'string' || !pattern.test(value))
    throw new ToolArgumentError(`参数 ${key} 必须是${description}`);
  return value;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
  pattern: RegExp,
  description: string,
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  return requireString(args, key, pattern, description);
}

function optionalEnum<V extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly V[],
): V | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as V))
    throw new ToolArgumentError(`参数 ${key} 必须是 ${allowed.join('|')}`);
  return value as V;
}

function optionalInt(
  args: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new ToolArgumentError(
      `参数 ${key} 必须是 ${minimum}-${maximum} 的整数`,
    );
  return value;
}

const RANGE_SCHEMA = {
  from: { type: 'string', description: '开始日期（含），YYYY-MM-DD' },
  to: {
    type: 'string',
    description: '结束日期（不含），YYYY-MM-DD；范围 1-366 天',
  },
} as const;

const KIND_SCHEMA = {
  kind: {
    type: 'string',
    enum: ['strength', 'cardio'],
    description: '按训练类型筛选',
  },
} as const;

const LIMIT_SCHEMA = {
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: 100,
    description: '每页数量，默认 25',
  },
} as const;

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'get_metadata',
    title: '服务元数据',
    annotations: READ_ONLY,
    outputSchema: OBJECT_OUTPUT,
    description:
      '获取服务元数据：版本、单位、时区、capabilities、训练覆盖范围（数量与首末日期）。分析前先调用以确认数据范围。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    build: () => ({ path: '/metadata', method: 'GET' }),
  },
  {
    name: 'search_exercises',
    title: '搜索动作',
    annotations: READ_ONLY,
    outputSchema: OBJECT_OUTPUT,
    description:
      '按名称或别名搜索动作，返回稳定 UUID 与计量口径。统计前必须先解析动作 UUID。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '名称或别名的子串，默认空为全部',
        },
        ...KIND_SCHEMA,
        includeArchived: {
          type: 'boolean',
          description: '是否包含已归档动作，默认 false',
        },
        ...LIMIT_SCHEMA,
        cursor: {
          type: 'string',
          description: '上一页返回的 nextCursor，原样传入',
        },
      },
      additionalProperties: false,
    },
    build: (args) => {
      const query = new URLSearchParams();
      if (args['query'] !== undefined) {
        if (typeof args['query'] !== 'string' || args['query'].length > 200)
          throw new ToolArgumentError(
            '参数 query 必须是不超过 200 字符的字符串',
          );
        query.set('query', args['query']);
      }
      const kind = optionalEnum(args, 'kind', ['strength', 'cardio'] as const);
      if (kind) query.set('kind', kind);
      if (args['includeArchived'] !== undefined) {
        if (typeof args['includeArchived'] !== 'boolean')
          throw new ToolArgumentError('参数 includeArchived 必须是布尔值');
        query.set(
          'includeArchived',
          args['includeArchived'] ? 'true' : 'false',
        );
      }
      const limit = optionalInt(args, 'limit', 1, 100);
      if (limit !== undefined) query.set('limit', String(limit));
      const cursor = optionalString(
        args,
        'cursor',
        /^.{1,4000}$/,
        '不超过 4000 字符的游标',
      );
      if (cursor) query.set('cursor', cursor);
      return { path: `/exercises?${query.toString()}`, method: 'GET' };
    },
  },
  {
    name: 'list_workouts',
    title: '训练列表',
    annotations: READ_ONLY,
    outputSchema: OBJECT_OUTPUT,
    description:
      '按训练本地日期范围列出训练（含动作数量与类型摘要）。只提供已完成与草稿状态筛选，训练备注永远不返回。',
    inputSchema: {
      type: 'object',
      properties: {
        ...RANGE_SCHEMA,
        status: {
          type: 'string',
          enum: ['completed', 'draft'],
          description: '默认返回两者',
        },
        ...KIND_SCHEMA,
        exerciseId: {
          type: 'string',
          description: '只列出包含该动作（UUID）的训练',
        },
        ...LIMIT_SCHEMA,
        cursor: {
          type: 'string',
          description: '上一页返回的 nextCursor，原样传入',
        },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    build: (args) => {
      const from = requireString(args, 'from', ISO_DATE, 'YYYY-MM-DD 日期');
      const to = requireString(args, 'to', ISO_DATE, 'YYYY-MM-DD 日期');
      const query = new URLSearchParams({ from, to });
      const status = optionalEnum(args, 'status', [
        'completed',
        'draft',
      ] as const);
      if (status) query.set('status', status);
      const kind = optionalEnum(args, 'kind', ['strength', 'cardio'] as const);
      if (kind) query.set('kind', kind);
      const exerciseId = optionalString(args, 'exerciseId', UUID, '动作 UUID');
      if (exerciseId) query.set('exerciseId', exerciseId);
      const limit = optionalInt(args, 'limit', 1, 100);
      if (limit !== undefined) query.set('limit', String(limit));
      const cursor = optionalString(
        args,
        'cursor',
        /^.{1,4000}$/,
        '不超过 4000 字符的游标',
      );
      if (cursor) query.set('cursor', cursor);
      return { path: `/workouts?${query.toString()}`, method: 'GET' };
    },
  },
  {
    name: 'get_workout',
    title: '训练详情',
    annotations: READ_ONLY,
    outputSchema: OBJECT_OUTPUT,
    description: '获取单次训练的完整明细（条目与组数据）。训练备注永远不返回。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '训练 UUID' } },
      required: ['id'],
      additionalProperties: false,
    },
    build: (args) => {
      const id = requireString(args, 'id', UUID, '训练 UUID');
      return { path: `/workouts/${id}`, method: 'GET' };
    },
  },
  {
    name: 'get_summary_stats',
    title: '总览统计',
    annotations: READ_ONLY,
    outputSchema: OBJECT_OUTPUT,
    description:
      '总览统计：训练频次、时长覆盖、力量/有氧次数与分桶（频次趋势用）。',
    inputSchema: {
      type: 'object',
      properties: {
        ...RANGE_SCHEMA,
        granularity: {
          type: 'string',
          enum: ['day', 'week', 'month'],
          description: '分桶粒度，默认 week',
        },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    build: (args) => {
      const query = new URLSearchParams({
        from: requireString(args, 'from', ISO_DATE, 'YYYY-MM-DD 日期'),
        to: requireString(args, 'to', ISO_DATE, 'YYYY-MM-DD 日期'),
      });
      const granularity = optionalEnum(args, 'granularity', [
        'day',
        'week',
        'month',
      ] as const);
      if (granularity) query.set('granularity', granularity);
      return { path: `/stats/summary?${query.toString()}`, method: 'GET' };
    },
  },
  {
    name: 'get_strength_stats',
    title: '力量统计',
    annotations: READ_ONLY,
    outputSchema: OBJECT_OUTPUT,
    description:
      '单动作力量统计：组数、次数、最大重量、容量（kg·reps）等，按训练分列（进步趋势用）。先 search_exercises 解析 UUID。',
    inputSchema: {
      type: 'object',
      properties: {
        exerciseId: { type: 'string', description: '动作 UUID' },
        ...RANGE_SCHEMA,
        includeWarmup: {
          type: 'boolean',
          description: '是否包含热身组，默认排除',
        },
      },
      required: ['exerciseId', 'from', 'to'],
      additionalProperties: false,
    },
    build: (args) => {
      const query = new URLSearchParams({
        exerciseId: requireString(args, 'exerciseId', UUID, '动作 UUID'),
        from: requireString(args, 'from', ISO_DATE, 'YYYY-MM-DD 日期'),
        to: requireString(args, 'to', ISO_DATE, 'YYYY-MM-DD 日期'),
      });
      if (args['includeWarmup'] !== undefined) {
        if (typeof args['includeWarmup'] !== 'boolean')
          throw new ToolArgumentError('参数 includeWarmup 必须是布尔值');
        query.set('includeWarmup', args['includeWarmup'] ? 'true' : 'false');
      }
      return { path: `/stats/strength?${query.toString()}`, method: 'GET' };
    },
  },
  {
    name: 'get_cardio_stats',
    title: '有氧统计',
    annotations: READ_ONLY,
    outputSchema: OBJECT_OUTPUT,
    description: '有氧统计：按时长口径分开的配速、距离、心率（耐力趋势用）。',
    inputSchema: {
      type: 'object',
      properties: {
        ...RANGE_SCHEMA,
        category: {
          type: 'string',
          enum: ['run', 'walk', 'cycle', 'swim', 'row', 'elliptical', 'other'],
          description: '按项目筛选',
        },
        durationBasis: {
          type: 'string',
          enum: ['elapsed', 'moving'],
          description: '时长口径，默认 elapsed',
        },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    build: (args) => {
      const query = new URLSearchParams({
        from: requireString(args, 'from', ISO_DATE, 'YYYY-MM-DD 日期'),
        to: requireString(args, 'to', ISO_DATE, 'YYYY-MM-DD 日期'),
      });
      const category = optionalEnum(args, 'category', [
        'run',
        'walk',
        'cycle',
        'swim',
        'row',
        'elliptical',
        'other',
      ] as const);
      if (category) query.set('category', category);
      const durationBasis = optionalEnum(args, 'durationBasis', [
        'elapsed',
        'moving',
      ] as const);
      if (durationBasis) query.set('durationBasis', durationBasis);
      return { path: `/stats/cardio?${query.toString()}`, method: 'GET' };
    },
  },
  {
    name: 'create_workout',
    title: '创建训练记录',
    description:
      '创建一条新的训练记录（仅新增，绝不修改或删除任何已有记录）。调用前必须把完整内容（日期、动作、每组数据）逐项展示给用户并取得明确确认；时间与时区按用户要求填写。条目与组的 id 可省略（服务端生成）。相同内容在 24 小时内重复调用返回同一条记录（幂等），不会重复创建。',
    annotations: CREATE_ONLY,
    outputSchema: OBJECT_OUTPUT,
    inputSchema: {
      type: 'object',
      properties: {
        startedAt: {
          type: 'string',
          description:
            'UTC RFC3339 开始时间，如 2026-09-13T04:00:00Z（= Asia/Shanghai 12:00）',
        },
        timezone: {
          type: 'string',
          description: 'IANA 时区，如 Asia/Shanghai',
        },
        status: {
          type: 'string',
          enum: ['completed', 'draft'],
          description: '手记补录通常为 completed；draft 不计入统计',
        },
        durationSeconds: {
          type: ['integer', 'null'],
          description: '整次训练时长（秒）；未记录为 null，不要填 0',
        },
        notes: { type: ['string', 'null'], description: '训练备注；可空' },
        entries: {
          type: 'array',
          description:
            '动作条目，按训练顺序；力量条目用 sets，有氧条目用 cardio',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: '可省略；省略时自动生成 UUID',
              },
              exerciseId: {
                type: 'string',
                description:
                  '动作 UUID；必须先 search_exercises 解析，不存在则先 create_exercise',
              },
              kind: { type: 'string', enum: ['strength', 'cardio'] },
              notes: { type: ['string', 'null'] },
              sets: {
                type: 'array',
                description: '力量条目的组列表',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: '可省略' },
                    setType: {
                      type: 'string',
                      enum: ['working', 'warmup'],
                      description: '默认 working；手记一般不区分热身',
                    },
                    completed: { type: 'boolean', description: '默认 true' },
                    reps: {
                      type: ['integer', 'null'],
                      description: '次数（与 durationSeconds 互斥）',
                    },
                    durationSeconds: {
                      type: ['integer', 'null'],
                      description: '计时组时长（秒）',
                    },
                    loadKg: {
                      type: ['number', 'null'],
                      description:
                        '重量 kg；口径按动作定义（总重量或单只重量）',
                    },
                    assistanceKg: {
                      type: ['number', 'null'],
                      description: '辅助重量 kg（辅助动作）',
                    },
                    effortType: {
                      type: ['string', 'null'],
                      description: '可选 rpe 或 rir',
                    },
                    effortValue: { type: ['number', 'null'] },
                    notes: { type: ['string', 'null'] },
                  },
                  additionalProperties: false,
                },
              },
              cardio: {
                type: 'object',
                description: '有氧条目的数据',
                properties: {
                  completed: { type: 'boolean', description: '默认 true' },
                  durationSeconds: { type: ['integer', 'null'] },
                  durationBasis: {
                    type: 'string',
                    enum: ['elapsed', 'moving'],
                    description: '时长口径，默认 elapsed',
                  },
                  distanceMeters: { type: ['number', 'null'] },
                  averageHeartRate: { type: ['integer', 'null'] },
                  maxHeartRate: { type: ['integer', 'null'] },
                  elevationGainMeters: { type: ['number', 'null'] },
                  inclinePercent: { type: ['number', 'null'] },
                  resistanceLevel: { type: ['number', 'null'] },
                  deviceCaloriesKcal: { type: ['number', 'null'] },
                },
                additionalProperties: false,
              },
            },
            required: ['exerciseId', 'kind'],
            additionalProperties: false,
          },
        },
        idempotencyKey: {
          type: 'string',
          description:
            '通常省略。仅当用户明确要求刻意创建两条内容完全相同的记录时才传入不同值。',
        },
      },
      required: ['startedAt', 'timezone', 'status', 'entries'],
      additionalProperties: false,
    },
    build: (args) => {
      const startedAt = requireString(
        args,
        'startedAt',
        /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/,
        'UTC RFC3339 时间（以 Z 结尾）',
      );
      const timezone = requireString(
        args,
        'timezone',
        /^.{1,100}$/,
        'IANA 时区名',
      );
      const status =
        optionalEnum(args, 'status', ['completed', 'draft'] as const) ??
        'completed';
      if (!Array.isArray(args['entries']))
        throw new ToolArgumentError('参数 entries 必须是数组');
      const entries = (args['entries'] as unknown[]).map((raw, index) => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
          throw new ToolArgumentError(`entries[${index}] 必须是对象`);
        const entry = raw as Record<string, unknown>;
        const exerciseId = requireString(
          entry,
          'exerciseId',
          UUID,
          '动作 UUID',
        );
        const kind = optionalEnum(entry, 'kind', [
          'strength',
          'cardio',
        ] as const);
        if (!kind)
          throw new ToolArgumentError(
            `entries[${index}].kind 必须是 strength 或 cardio`,
          );
        const notes =
          typeof entry['notes'] === 'string' ? entry['notes'] : null;
        if (kind === 'cardio')
          return {
            id:
              entry['id'] === undefined
                ? crypto.randomUUID()
                : requireString(entry, 'id', UUID, 'UUID'),
            exerciseId,
            kind,
            notes,
            cardio: buildCardio(entry['cardio'], index),
          };
        if (entry['sets'] !== undefined && !Array.isArray(entry['sets']))
          throw new ToolArgumentError(`entries[${index}].sets 必须是数组`);
        return {
          id:
            entry['id'] === undefined
              ? crypto.randomUUID()
              : requireString(entry, 'id', UUID, 'UUID'),
          exerciseId,
          kind,
          notes,
          sets: ((entry['sets'] ?? []) as unknown[]).map((set, setIndex) =>
            buildSet(set, index, setIndex),
          ),
        };
      });
      return {
        path: '/workouts',
        method: 'POST',
        body: {
          startedAt,
          timezone,
          status,
          durationSeconds: nullableNumber(
            args['durationSeconds'],
            'durationSeconds',
          ),
          notes: typeof args['notes'] === 'string' ? args['notes'] : null,
          entries,
        },
      };
    },
  },
  {
    name: 'create_exercise',
    title: '创建缺失动作',
    description:
      '创建一个新的动作定义（仅新增；不修改、不归档、不删除任何动作）。仅当 search_exercises 确认动作不存在、且用户明确同意其计量口径后调用；同名动作会被 409 拒绝。',
    annotations: CREATE_ONLY,
    outputSchema: OBJECT_OUTPUT,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '动作名称（不与现有动作重复）' },
        aliases: {
          type: 'array',
          items: { type: 'string' },
          description: '别名，默认空数组',
        },
        kind: { type: 'string', enum: ['strength', 'cardio'] },
        equipment: { type: ['string', 'null'], description: '器械，可空' },
        muscleGroups: {
          type: 'array',
          items: { type: 'string' },
          description: '目标肌群，默认空数组',
        },
        cardioCategory: {
          type: ['string', 'null'],
          description:
            '有氧项目 run/walk/cycle/swim/row/elliptical/other；力量动作为 null',
        },
        measurementMode: {
          type: 'string',
          enum: ['reps', 'duration', 'cardio'],
        },
        resistanceMode: {
          type: ['string', 'null'],
          description: 'external / bodyweight / assisted；有氧动作为 null',
        },
        loadConvention: {
          type: 'string',
          enum: ['total', 'per_implement', 'none'],
        },
        repConvention: {
          type: 'string',
          enum: ['total', 'per_side', 'not_applicable'],
        },
        volumeMultiplier: {
          type: ['number', 'null'],
          description:
            '容量倍率：单只哑铃双侧完成为 2，总重量口径为 1；有氧为 null',
        },
        id: {
          type: 'string',
          description: '可省略；导入前向引用时才指定 UUID',
        },
        idempotencyKey: {
          type: 'string',
          description: '通常省略（内容哈希自动幂等）',
        },
      },
      required: [
        'name',
        'kind',
        'measurementMode',
        'resistanceMode',
        'loadConvention',
        'repConvention',
      ],
      additionalProperties: false,
    },
    build: (args) => {
      const body: Record<string, unknown> = {
        name: requireString(
          args,
          'name',
          /^.{1,200}$/,
          '不超过 200 字符的名称',
        ),
        aliases: Array.isArray(args['aliases']) ? args['aliases'] : [],
        kind: optionalEnum(args, 'kind', ['strength', 'cardio'] as const),
        equipment: args['equipment'] === undefined ? null : args['equipment'],
        muscleGroups: Array.isArray(args['muscleGroups'])
          ? args['muscleGroups']
          : [],
        cardioCategory:
          args['cardioCategory'] === undefined ? null : args['cardioCategory'],
        measurementMode: optionalEnum(args, 'measurementMode', [
          'reps',
          'duration',
          'cardio',
        ] as const),
        resistanceMode:
          args['resistanceMode'] === undefined
            ? null
            : optionalEnum(args, 'resistanceMode', [
                'external',
                'bodyweight',
                'assisted',
              ] as const),
        loadConvention: optionalEnum(args, 'loadConvention', [
          'total',
          'per_implement',
          'none',
        ] as const),
        repConvention: optionalEnum(args, 'repConvention', [
          'total',
          'per_side',
          'not_applicable',
        ] as const),
        volumeMultiplier:
          args['volumeMultiplier'] === undefined
            ? null
            : args['volumeMultiplier'],
      };
      if (body['kind'] === undefined)
        throw new ToolArgumentError('参数 kind 必须是 strength 或 cardio');
      if (body['measurementMode'] === undefined)
        throw new ToolArgumentError(
          '参数 measurementMode 必须是 reps/duration/cardio',
        );
      if (body['loadConvention'] === undefined)
        throw new ToolArgumentError(
          '参数 loadConvention 必须是 total/per_implement/none',
        );
      if (body['repConvention'] === undefined)
        throw new ToolArgumentError(
          '参数 repConvention 必须是 total/per_side/not_applicable',
        );
      if (args['id'] !== undefined)
        body['id'] = requireString(args, 'id', UUID, 'UUID');
      return { path: '/exercises', method: 'POST', body };
    },
  },
];

function nullableNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new ToolArgumentError(`参数 ${label} 必须是数字或 null`);
  return value;
}

function nullableInteger(value: unknown, label: string): number | null {
  const number = nullableNumber(value, label);
  if (number !== null && !Number.isInteger(number))
    throw new ToolArgumentError(`参数 ${label} 必须是整数或 null`);
  return number;
}

function buildSet(
  raw: unknown,
  entryIndex: number,
  setIndex: number,
): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new ToolArgumentError(
      `entries[${entryIndex}].sets[${setIndex}] 必须是对象`,
    );
  const set = raw as Record<string, unknown>;
  const label = `entries[${entryIndex}].sets[${setIndex}]`;
  return {
    id:
      set['id'] === undefined
        ? crypto.randomUUID()
        : requireString(set, 'id', UUID, 'UUID'),
    setType:
      optionalEnum(set, 'setType', ['working', 'warmup'] as const) ?? 'working',
    completed: typeof set['completed'] === 'boolean' ? set['completed'] : true,
    reps: nullableInteger(set['reps'], `${label}.reps`),
    durationSeconds: nullableInteger(
      set['durationSeconds'],
      `${label}.durationSeconds`,
    ),
    loadKg: nullableNumber(set['loadKg'], `${label}.loadKg`),
    assistanceKg: nullableNumber(set['assistanceKg'], `${label}.assistanceKg`),
    effortType:
      set['effortType'] === undefined || set['effortType'] === null
        ? null
        : optionalEnum(set, 'effortType', ['rpe', 'rir'] as const),
    effortValue: nullableNumber(set['effortValue'], `${label}.effortValue`),
    notes: typeof set['notes'] === 'string' ? set['notes'] : null,
  };
}

function buildCardio(
  raw: unknown,
  entryIndex: number,
): Record<string, unknown> {
  if (raw === undefined || raw === null)
    throw new ToolArgumentError(`entries[${entryIndex}].cardio 必须有值`);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new ToolArgumentError(`entries[${entryIndex}].cardio 必须是对象`);
  const cardio = raw as Record<string, unknown>;
  const label = `entries[${entryIndex}].cardio`;
  return {
    completed:
      typeof cardio['completed'] === 'boolean' ? cardio['completed'] : true,
    durationSeconds: nullableInteger(
      cardio['durationSeconds'],
      `${label}.durationSeconds`,
    ),
    durationBasis:
      optionalEnum(cardio, 'durationBasis', ['elapsed', 'moving'] as const) ??
      'elapsed',
    distanceMeters: nullableNumber(
      cardio['distanceMeters'],
      `${label}.distanceMeters`,
    ),
    averageHeartRate: nullableInteger(
      cardio['averageHeartRate'],
      `${label}.averageHeartRate`,
    ),
    maxHeartRate: nullableInteger(
      cardio['maxHeartRate'],
      `${label}.maxHeartRate`,
    ),
    elevationGainMeters: nullableNumber(
      cardio['elevationGainMeters'],
      `${label}.elevationGainMeters`,
    ),
    inclinePercent: nullableNumber(
      cardio['inclinePercent'],
      `${label}.inclinePercent`,
    ),
    resistanceLevel: nullableNumber(
      cardio['resistanceLevel'],
      `${label}.resistanceLevel`,
    ),
    deviceCaloriesKcal: nullableNumber(
      cardio['deviceCaloriesKcal'],
      `${label}.deviceCaloriesKcal`,
    ),
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/**
 * Idempotency for stateless MCP calls: identical arguments derive the same key,
 * so retries replay the original creation instead of writing duplicates. The
 * explicit idempotencyKey argument wins when the caller deliberately wants a
 * distinct record with identical content.
 */
async function idempotencyKeyFor(
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const explicit = args['idempotencyKey'];
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !/^[!-~]{1,200}$/.test(explicit))
      throw new ToolArgumentError(
        '参数 idempotencyKey 必须是 1-200 位可打印 ASCII',
      );
    return explicit;
  }
  const content = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== 'idempotencyKey'),
  );
  const canonical = stableStringify({ tool: toolName, args: content });
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `hw-mcp-${hex}`;
}

const TOOL_MAP = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

export function findTool(name: string): ToolDefinition | undefined {
  return TOOL_MAP.get(name);
}

/** Enforces the declared additionalProperties:false contract before upstream calls. */
export function validateArguments(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const validated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    // hasOwn, not `in`: prototype-chain keys like toString/constructor must be
    // rejected, and JSON.parse can produce an own "__proto__" property.
    if (!Object.hasOwn(tool.inputSchema.properties, key))
      throw new ToolArgumentError(`未知参数 ${key}`);
    validated[key] = value;
  }
  return validated;
}

/** Calls the upstream Agent API and returns tool result text (JSON or safe error). */
export async function callUpstream(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  env: Env,
): Promise<{ text: string; isError: boolean }> {
  if (!env.AGENT_CLIENT_ID || !env.AGENT_CLIENT_SECRET)
    return {
      text: 'CONFIGURATION: 服务端缺少上游凭据，请联系所有者配置 Worker Secret。',
      isError: true,
    };
  // Built outside the try block: argument errors must propagate to the caller
  // as -32602, never be swallowed into a network classification.
  const request = tool.build(args, env);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'CF-Access-Client-Id': env.AGENT_CLIENT_ID,
    'CF-Access-Client-Secret': env.AGENT_CLIENT_SECRET,
  };
  if (request.method === 'POST') {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = await idempotencyKeyFor(tool.name, args);
  }
  let upstream: Response;
  try {
    upstream = await fetch(
      `${env.AGENT_BASE_URL}/api/agent/v1${request.path}`,
      {
        method: request.method,
        // workerd only supports follow/manual; manual + explicit 3xx rejection
        // keeps the Access service credentials from ever following a redirect.
        redirect: 'manual',
        headers,
        ...(request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
      },
    );
  } catch (error) {
    // Error-path diagnostic only (message, never credentials or full request).
    console.log(
      'upstream fetch failed:',
      error instanceof Error ? error.message : String(error),
    );
    return {
      text: 'UPSTREAM_UNREACHABLE: 无法连接训练数据服务，请稍后重试。',
      isError: true,
    };
  }
  if (upstream.status >= 300 && upstream.status < 400)
    return {
      text: 'REDIRECT_REJECTED: 上游返回重定向，已拒绝以保护凭据。',
      isError: true,
    };
  if (upstream.status === 401 || upstream.status === 403)
    return {
      text: `AUTHENTICATION: 上游拒绝访问（HTTP ${upstream.status}）。`,
      isError: true,
    };
  if (upstream.status === 429 || upstream.status >= 500)
    return {
      text: `UPSTREAM_ERROR: 训练数据服务暂时不可用（HTTP ${upstream.status}）。`,
      isError: true,
    };
  const body = await upstream.text();
  if (body.length > 4 * 1024 * 1024)
    return {
      text: 'RESPONSE_TOO_LARGE: 结果超过 4 MiB，请缩小日期范围或分页查询。',
      isError: true,
    };
  if (upstream.status !== (request.method === 'POST' ? 201 : 200)) {
    let code = `HTTP_${upstream.status}`;
    let message = '';
    try {
      const parsed = JSON.parse(body) as {
        error?: { code?: string; message?: string };
      };
      if (typeof parsed.error?.code === 'string') code = parsed.error.code;
      if (typeof parsed.error?.message === 'string')
        message = parsed.error.message;
    } catch {
      // Keep generic code; upstream error bodies are safe strings but may be HTML from the edge.
    }
    return {
      text: `UPSTREAM_REJECTED ${code}${message ? `: ${message}` : ''}`,
      isError: true,
    };
  }
  return { text: body, isError: false };
}
