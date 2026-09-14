import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import isoWeek from 'dayjs/plugin/isoWeek';
import type { Bindings } from './auth';
import {
  errorSchema,
  localDateSchema,
  NUMERIC_LIMITS as N,
} from '../shared/contracts';
import {
  summaryQuerySchema,
  strengthQuerySchema,
  cardioQuerySchema,
  summaryResponseSchema,
  strengthResponseSchema,
  cardioResponseSchema,
  type SummaryResponse,
  type StrengthResponse,
  type CardioResponse,
} from '../shared/stats';
dayjs.extend(utc);
dayjs.extend(isoWeek);
type Env = { Bindings: Bindings; Variables: { requestId: string } };
type Range = { from: string; to: string };
// D1 batch preserves statement/result order. Parse final DTOs with shared Zod.
async function batch<const T extends readonly D1PreparedStatement[]>(
  db: D1Database,
  statements: T,
): Promise<{ [K in keyof T]: D1Result<Record<string, unknown>> }> {
  const results = await db.batch<Record<string, unknown>>([...statements]);
  assertFinite(results);
  return results as {
    [K in keyof T]: D1Result<Record<string, unknown>>;
  };
}
export function statsRange(query: {
  from?: string | undefined;
  to?: string | undefined;
}): Range {
  const to = query.to ?? dayjs.utc().add(1, 'day').format('YYYY-MM-DD');
  const from =
    query.from ?? dayjs.utc(to).subtract(28, 'day').format('YYYY-MM-DD');
  const days = dayjs.utc(to).diff(dayjs.utc(from), 'day');
  if (
    !localDateSchema.safeParse(from).success ||
    !localDateSchema.safeParse(to).success ||
    days <= 0 ||
    days > 366
  )
    throw new StatsError(400, 'INVALID_RANGE', '日期范围须为 1–366 天');
  return { from, to };
}
class StatsError extends Error {
  constructor(
    public status: 400 | 404 | 422,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
function numericError(): never {
  throw new StatsError(
    422,
    'STATS_NUMERIC_OUT_OF_RANGE',
    '范围内存在超出数值安全范围的数据或累计结果；请检查并修正原记录，未丢弃样本',
  );
}
function assertFinite(value: unknown): void {
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
  )
    numericError();
  if (value && typeof value === 'object')
    Object.values(value).forEach(assertFinite);
}
function numericResult<T>(schema: z.ZodType<T>, value: unknown): T {
  assertFinite(value);
  return schema.parse(value);
}
// Validate only operands selected by the same SQL predicates as the statistic.
const outside = (field: string, max: number, min = 0) =>
  `(${field} IS NOT NULL AND (${field}<${min} OR ${field}>${max}))`;
async function checkOperands(
  db: D1Database,
  sql: string,
  args: unknown[],
): Promise<void> {
  const row = await db
    .prepare(sql)
    .bind(...args)
    .first();
  if (row) numericError();
}
const context = (range: Range) => ({
  ...range,
  definitionsVersion: '1' as const,
  dateBasis: 'workout_local_date' as const,
  status: 'completed' as const,
});
const bounded = (rows: unknown[]) => {
  if (rows.length > 10000)
    throw new StatsError(
      422,
      'STATS_RANGE_TOO_DENSE',
      '该范围超过 10000 条趋势明细，请缩小日期范围；未返回截断统计',
    );
};
const scope = "w.status='completed' AND w.local_date>=? AND w.local_date<?";
const cardioFrom =
  'FROM cardio_records c JOIN workout_entries e ON e.id=c.entry_id JOIN workouts w ON w.id=e.workout_id JOIN exercises x ON x.id=e.exercise_id';
const strengthFrom =
  'FROM strength_sets s JOIN workout_entries e ON e.id=s.entry_id JOIN workouts w ON w.id=e.workout_id';
const summaryMetrics = (
  rows: {
    workoutCount: number;
    recordedDurationWorkoutCount: number;
    durationSeconds: number;
    strengthWorkoutCount: number;
    cardioWorkoutCount: number;
    cardioDurationSeconds: number;
  }[],
) => {
  const totals = rows.reduce(
    (a, r) => ({
      workoutCount: a.workoutCount + r.workoutCount,
      recordedDurationWorkoutCount:
        a.recordedDurationWorkoutCount + r.recordedDurationWorkoutCount,
      durationSeconds: a.durationSeconds + r.durationSeconds,
      strengthWorkoutCount: a.strengthWorkoutCount + r.strengthWorkoutCount,
      cardioWorkoutCount: a.cardioWorkoutCount + r.cardioWorkoutCount,
      cardioDurationSeconds: a.cardioDurationSeconds + r.cardioDurationSeconds,
    }),
    {
      workoutCount: 0,
      recordedDurationWorkoutCount: 0,
      durationSeconds: 0,
      strengthWorkoutCount: 0,
      cardioWorkoutCount: 0,
      cardioDurationSeconds: 0,
    },
  );
  return {
    ...totals,
    durationCoverage: totals.workoutCount
      ? totals.recordedDurationWorkoutCount / totals.workoutCount
      : null,
  };
};
export async function summaryStats(
  db: D1Database,
  q: z.infer<typeof summaryQuerySchema>,
): Promise<SummaryResponse['data']> {
  const range = statsRange(q);
  await checkOperands(
    db,
    `SELECT 1 FROM workouts w WHERE ${scope} AND ${outside('w.duration_seconds', N.durationSeconds)} UNION ALL SELECT 1 ${cardioFrom} WHERE ${scope} AND c.completed=1 AND (${outside('c.duration_seconds', N.durationSeconds)} OR ${outside('c.distance_meters', N.distanceMeters)}) LIMIT 1`,
    [range.from, range.to, range.from, range.to],
  );
  const [daily, categories, excluded] = await batch(db, [
    db
      .prepare(
        `SELECT w.local_date AS localDate,count(*) AS workoutCount,count(w.duration_seconds) AS recordedDurationWorkoutCount,coalesce(sum(1.0*w.duration_seconds),0) AS durationSeconds,sum(EXISTS(SELECT 1 FROM workout_entries e WHERE e.workout_id=w.id AND e.kind='strength')) AS strengthWorkoutCount,sum(EXISTS(SELECT 1 FROM workout_entries e WHERE e.workout_id=w.id AND e.kind='cardio')) AS cardioWorkoutCount,coalesce(sum((SELECT sum(1.0*c.duration_seconds) FROM cardio_records c JOIN workout_entries e ON e.id=c.entry_id WHERE e.workout_id=w.id AND c.completed=1)),0) AS cardioDurationSeconds FROM workouts w WHERE ${scope} GROUP BY w.local_date ORDER BY w.local_date`,
      )
      .bind(range.from, range.to),
    db
      .prepare(
        `SELECT x.cardio_category AS category,c.duration_basis AS durationBasis,count(*) AS recordCount,sum(1.0*c.duration_seconds) AS durationSeconds,coalesce(sum(c.distance_meters),0) AS distanceMeters,count(c.distance_meters) AS distanceSampleCount ${cardioFrom} WHERE ${scope} AND c.completed=1 GROUP BY x.cardio_category,c.duration_basis ORDER BY x.cardio_category,c.duration_basis`,
      )
      .bind(range.from, range.to),
    db
      .prepare(
        "SELECT count(*) AS n FROM workouts WHERE status='draft' AND local_date>=? AND local_date<?",
      )
      .bind(range.from, range.to),
  ]);
  type Daily = Parameters<typeof summaryMetrics>[0][number] & {
    localDate: string;
  };
  const rows = daily.results as Daily[];
  const totals = summaryMetrics(rows);
  const buckets: SummaryResponse['data']['buckets'] = [];
  let start = dayjs
    .utc(range.from)
    .startOf(q.granularity === 'week' ? 'isoWeek' : q.granularity);
  while (start.format('YYYY-MM-DD') < range.to) {
    const end = start.add(1, q.granularity);
    const bucketStart = start.format('YYYY-MM-DD');
    const from = bucketStart < range.from ? range.from : bucketStart;
    const to =
      end.format('YYYY-MM-DD') > range.to ? range.to : end.format('YYYY-MM-DD');
    buckets.push({
      ...summaryMetrics(
        rows.filter((r) => r.localDate >= from && r.localDate < to),
      ),
      bucketStart,
      from,
      to,
    });
    start = end;
  }
  return numericResult(summaryResponseSchema.shape.data, {
    ...context(range),
    granularity: q.granularity,
    warmup: 'not_applicable',
    totals,
    buckets,
    cardioByCategory: categories.results,
    quality: {
      validSamples: totals.workoutCount,
      missing: {
        workoutDuration:
          totals.workoutCount - totals.recordedDurationWorkoutCount,
        cardioDistance: categories.results.reduce(
          (n, r) => n + Number(r.recordCount) - Number(r.distanceSampleCount),
          0,
        ),
      },
      excluded: { draftWorkouts: excluded.results[0]?.n ?? 0 },
    },
  });
}
// All measurement decisions use immutable entry snapshots, never current exercise labels.
const strengthCTE = `WITH samples AS (SELECT w.id AS workoutId,w.local_date AS localDate,w.started_at AS startedAt,e.id AS entryId,s.id AS setId,s.set_type AS setType,s.reps,s.duration_seconds AS durationSeconds,s.load_grams/1000.0 AS loadKg,s.assistance_grams/1000.0 AS assistanceKg,json_extract(e.measurement_snapshot,'$.resistanceMode') AS resistanceMode,json_extract(e.measurement_snapshot,'$.measurementMode') AS measurementMode,json_extract(e.measurement_snapshot,'$.volumeMultiplier') AS multiplier ${strengthFrom} WHERE ${scope} AND e.exercise_id=? AND s.completed=1 AND (?=1 OR s.set_type='working')), classified AS (SELECT *,CASE WHEN resistanceMode='bodyweight' THEN 'bodyweight' WHEN resistanceMode='assisted' THEN 'assisted' WHEN measurementMode<>'reps' THEN 'duration' WHEN multiplier IS NULL THEN 'unknownMultiplier' WHEN loadKg IS NULL THEN 'missingLoad' WHEN reps IS NULL THEN 'missingReps' ELSE NULL END AS exclusion FROM samples)`;
const strengthAggregate = `count(*) AS setCount,coalesce(sum(setType='working'),0) AS workingSetCount,coalesce(sum(setType='warmup'),0) AS warmupSetCount,coalesce(sum(1.0*reps),0) AS reps,coalesce(sum(1.0*durationSeconds),0) AS durationSeconds,max(loadKg) AS maxLoadKg,sum(CASE WHEN exclusion IS NULL THEN loadKg*reps*multiplier END) AS volumeKgReps,coalesce(sum(exclusion IS NULL),0) AS volumeSampleCount`;
export async function strengthStats(
  db: D1Database,
  q: z.infer<typeof strengthQuerySchema>,
): Promise<StrengthResponse['data']> {
  const range = statsRange(q),
    args = [
      range.from,
      range.to,
      q.exerciseId,
      q.includeWarmup === 'true' ? 1 : 0,
    ];
  await checkOperands(
    db,
    `${strengthCTE} SELECT 1 FROM classified WHERE ${outside('reps', N.reps)} OR ${outside('durationSeconds', N.durationSeconds)} OR (exclusion IS NULL AND ${outside('multiplier', N.volumeMultiplier, N.minMultiplier)}) LIMIT 1`,
    args,
  );
  const [exercise, totals, trend, exclusions, missing, skipped, records] =
    await batch(db, [
      db.prepare('SELECT kind FROM exercises WHERE id=?').bind(q.exerciseId),
      db
        .prepare(`${strengthCTE} SELECT ${strengthAggregate} FROM classified`)
        .bind(...args),
      db
        .prepare(
          `${strengthCTE} SELECT workoutId,localDate,startedAt,${strengthAggregate} FROM classified GROUP BY workoutId,localDate,startedAt ORDER BY localDate,startedAt,workoutId LIMIT 10001`,
        )
        .bind(...args),
      db
        .prepare(
          `${strengthCTE} SELECT exclusion,count(*) AS n FROM classified WHERE exclusion IS NOT NULL GROUP BY exclusion`,
        )
        .bind(...args),
      db
        .prepare(
          `${strengthCTE} SELECT coalesce(sum(loadKg IS NULL),0) AS load,coalesce(sum(assistanceKg IS NULL AND resistanceMode='assisted'),0) AS assistance,coalesce(sum(reps IS NULL AND measurementMode='reps'),0) AS reps,coalesce(sum(durationSeconds IS NULL AND measurementMode='duration'),0) AS duration FROM classified`,
        )
        .bind(...args),
      db
        .prepare(
          `SELECT coalesce(sum(w.status='draft'),0) AS draftSets,coalesce(sum(w.status='completed' AND s.completed=0),0) AS incompleteSets,coalesce(sum(w.status='completed' AND s.completed=1 AND s.set_type='warmup' AND ?=0),0) AS warmupSets ${strengthFrom} WHERE w.local_date>=? AND w.local_date<? AND e.exercise_id=?`,
        )
        .bind(
          q.includeWarmup === 'true' ? 1 : 0,
          range.from,
          range.to,
          q.exerciseId,
        ),
      db
        .prepare(
          `${strengthCTE}, ranked AS (SELECT *,row_number() OVER (ORDER BY loadKg DESC,reps DESC,localDate,startedAt,setId) AS loadRank,row_number() OVER (ORDER BY durationSeconds DESC,localDate,startedAt,setId) AS durationRank,row_number() OVER (PARTITION BY resistanceMode,loadKg,assistanceKg ORDER BY reps DESC,localDate,startedAt,setId) AS repsRank FROM classified) SELECT workoutId,localDate,startedAt,entryId,setId,loadKg,assistanceKg,reps,durationSeconds,resistanceMode,loadRank,durationRank,repsRank FROM ranked WHERE (loadRank=1 AND loadKg IS NOT NULL) OR (durationRank=1 AND durationSeconds IS NOT NULL) OR (repsRank=1 AND reps IS NOT NULL AND ((resistanceMode='assisted' AND assistanceKg IS NOT NULL) OR (resistanceMode='external' AND loadKg IS NOT NULL) OR resistanceMode='bodyweight')) ORDER BY resistanceMode,loadKg,assistanceKg,setId LIMIT 10001`,
        )
        .bind(...args),
    ]);
  if (!exercise.results.length)
    throw new StatsError(404, 'NOT_FOUND', '动作不存在');
  if (exercise.results[0]?.kind !== 'strength')
    throw new StatsError(422, 'INVALID_EXERCISE_KIND', '请选择力量动作');
  bounded(trend.results);
  bounded(records.results);
  return numericResult(strengthResponseSchema.shape.data, {
    ...context(range),
    exerciseId: q.exerciseId,
    granularity: 'workout',
    warmup: q.includeWarmup === 'true' ? 'include' : 'exclude',
    totals: totals.results[0],
    workouts: trend.results,
    records: {
      maxLoad:
        records.results.find((r) => r.loadRank === 1 && r.loadKg !== null) ??
        null,
      longestDuration:
        records.results.find(
          (r) => r.durationRank === 1 && r.durationSeconds !== null,
        ) ?? null,
      mostRepsByResistance: records.results.filter(
        (r) =>
          r.repsRank === 1 &&
          r.reps !== null &&
          (r.resistanceMode === 'bodyweight' ||
            (r.resistanceMode === 'assisted'
              ? r.assistanceKg !== null
              : r.loadKg !== null)),
      ),
    },
    quality: {
      validSamples: totals.results[0]?.setCount ?? 0,
      missing: missing.results[0],
      excluded: {
        ...skipped.results[0],
        ...Object.fromEntries(
          exclusions.results.map((r) => [String(r.exclusion), r.n]),
        ),
      },
    },
  });
}
const paceEligible = '(c.duration_seconds>0 AND c.distance_meters>0)';
export async function cardioStats(
  db: D1Database,
  q: z.infer<typeof cardioQuerySchema>,
): Promise<CardioResponse['data']> {
  const range = statsRange(q);

  const args: unknown[] = [range.from, range.to];
  let filters = 'w.local_date>=? AND w.local_date<?';
  if (q.category) {
    filters += ' AND x.cardio_category=?';
    args.push(q.category);
  }
  if (q.durationBasis) {
    filters += ' AND c.duration_basis=?';
    args.push(q.durationBasis);
  }
  const where = `${filters} AND w.status='completed' AND c.completed=1`;
  await checkOperands(
    db,
    `SELECT 1 ${cardioFrom} WHERE ${where} AND (${outside('c.duration_seconds', N.durationSeconds)} OR ${outside('c.distance_meters', N.distanceMeters)} OR (c.duration_seconds>0 AND c.distance_meters>0 AND c.distance_meters<${N.minPositiveDistanceMeters}) OR ${outside('c.elevation_gain_meters', N.elevationGainMeters)} OR ${outside('c.average_heart_rate', N.heartRate)}) LIMIT 1`,
    args,
  );

  const [groups, records, quality] = await batch(db, [
    db
      .prepare(
        `SELECT x.cardio_category AS category,c.duration_basis AS durationBasis,count(*) AS recordCount,sum(1.0*c.duration_seconds) AS durationSeconds,coalesce(sum(c.distance_meters),0) AS distanceMeters,count(c.distance_meters) AS distanceSampleCount,coalesce(sum(c.elevation_gain_meters),0) AS elevationGainMeters,count(c.elevation_gain_meters) AS elevationSampleCount,sum(CASE WHEN ${paceEligible} THEN 1 ELSE 0 END) AS paceSampleCount,coalesce(sum(CASE WHEN ${paceEligible} THEN 1.0*c.duration_seconds END),0) AS paceDurationSeconds,coalesce(sum(CASE WHEN ${paceEligible} THEN c.distance_meters END),0) AS paceDistanceMeters,count(c.average_heart_rate) AS heartRateSampleCount,coalesce(sum(CASE WHEN c.average_heart_rate IS NOT NULL THEN 1.0*c.duration_seconds END),0) AS heartRateDurationSeconds,sum(1.0*c.average_heart_rate*c.duration_seconds)*1.0/sum(CASE WHEN c.average_heart_rate IS NOT NULL THEN 1.0*c.duration_seconds END) AS averageHeartRate ${cardioFrom} WHERE ${where} GROUP BY x.cardio_category,c.duration_basis ORDER BY x.cardio_category,c.duration_basis`,
      )
      .bind(...args),
    db
      .prepare(
        `SELECT w.id AS workoutId,e.id AS entryId,e.exercise_id AS exerciseId,w.local_date AS localDate,w.started_at AS startedAt,x.cardio_category AS category,c.duration_basis AS durationBasis,c.duration_seconds AS durationSeconds,c.distance_meters AS distanceMeters,c.average_heart_rate AS averageHeartRate,c.max_heart_rate AS maxHeartRate,c.elevation_gain_meters AS elevationGainMeters ${cardioFrom} WHERE ${where} ORDER BY w.local_date,w.started_at,w.id,e.position LIMIT 10001`,
      )
      .bind(...args),
    db
      .prepare(
        `SELECT coalesce(sum(w.status='draft'),0) AS draftRecords,coalesce(sum(w.status='completed' AND c.completed=0),0) AS incompleteRecords,coalesce(sum(w.status='completed' AND c.completed=1 AND c.distance_meters IS NULL),0) AS missingDistance,coalesce(sum(w.status='completed' AND c.completed=1 AND c.distance_meters=0),0) AS zeroDistance,coalesce(sum(w.status='completed' AND c.completed=1 AND c.average_heart_rate IS NULL),0) AS missingHeartRate,coalesce(sum(w.status='completed' AND c.completed=1 AND c.elevation_gain_meters IS NULL),0) AS missingElevation ${cardioFrom} WHERE ${filters}`,
      )
      .bind(...args),
  ]);
  bounded(records.results);
  const rates = (
    category: unknown,
    distance: number | null,
    duration: number,
  ) => {
    const valid = distance !== null && distance > 0 && duration > 0;
    return {
      speedKmh: valid ? (distance / duration) * 3.6 : null,
      paceSecondsPerKm:
        valid && (category === 'run' || category === 'walk')
          ? (duration / distance) * 1000
          : null,
      paceSecondsPer100m:
        valid && category === 'swim' ? (duration / distance) * 100 : null,
    };
  };
  const report = quality.results[0]!;
  return numericResult(cardioResponseSchema.shape.data, {
    ...context(range),
    category: q.category ?? null,
    durationBasis: q.durationBasis ?? null,
    granularity: 'record',
    warmup: 'not_applicable',
    heartRateDefinition: 'record_mean_duration_weighted_estimate',
    groups: groups.results.map((g) => ({
      ...g,
      ...rates(
        g.category,
        Number(g.paceDistanceMeters),
        Number(g.paceDurationSeconds),
      ),
    })),
    records: records.results.map((r) => ({
      ...r,
      ...rates(
        r.category,
        r.distanceMeters === null ? null : Number(r.distanceMeters),
        Number(r.durationSeconds),
      ),
    })),
    quality: {
      validSamples: records.results.length,
      missing: {
        distance: report.missingDistance,
        heartRate: report.missingHeartRate,
        elevation: report.missingElevation,
      },
      excluded: {
        draftRecords: report.draftRecords,
        incompleteRecords: report.incompleteRecords,
        paceMissingDistance: report.missingDistance,
        paceZeroDistance: report.zeroDistance,
      },
    },
  });
}
const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const errors = {
  400: json(errorSchema, 'Invalid query/range'),
  404: json(errorSchema, 'Exercise not found'),
  422: json(
    errorSchema,
    'Wrong kind, >10000 trend rows, or STATS_NUMERIC_OUT_OF_RANGE; no samples silently dropped',
  ),
};
export function statsRoutes() {
  const api = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success)
        return c.json(
          {
            error: { code: 'INVALID_QUERY', message: '统计查询参数无效' },
            requestId: c.get('requestId'),
          },
          400,
        );
    },
  });
  api.onError((error, c) =>
    c.json(
      {
        error: {
          code: error instanceof StatsError ? error.code : 'INTERNAL_ERROR',
          message:
            error instanceof StatsError ? error.message : '统计服务暂时不可用',
        },
        requestId: c.get('requestId'),
      },
      error instanceof StatsError ? error.status : 500,
    ),
  );
  api.openapi(
    createRoute({
      method: 'get',
      path: '/stats/summary',
      security: [{ AccessJWT: [] }],
      request: { query: summaryQuerySchema },
      responses: {
        200: json(
          summaryResponseSchema,
          'Completed workout frequency; Monday weeks, natural months; partial edge buckets are clipped; duration and cardio are independent',
        ),
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        {
          data: await summaryStats(c.env.DB, c.req.valid('query')),
          meta: { requestId: c.get('requestId') },
        },
        200,
      ),
  );
  api.openapi(
    createRoute({
      method: 'get',
      path: '/stats/strength',
      security: [{ AccessJWT: [] }],
      request: { query: strengthQuerySchema },
      responses: {
        200: json(
          strengthResponseSchema,
          'Single-exercise snapshot-based volume, per-workout trend and actual records; working sets by default; volume null without eligible samples; raw sets via workout detail',
        ),
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        {
          data: await strengthStats(c.env.DB, c.req.valid('query')),
          meta: { requestId: c.get('requestId') },
        },
        200,
      ),
  );
  api.openapi(
    createRoute({
      method: 'get',
      path: '/stats/cardio',
      security: [{ AccessJWT: [] }],
      request: { query: cardioQuerySchema },
      responses: {
        200: json(
          cardioResponseSchema,
          'Separate category/durationBasis aggregates and records; pace from eligible total duration/distance; duration-weighted recorded mean heart rate',
        ),
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        {
          data: await cardioStats(c.env.DB, c.req.valid('query')),
          meta: { requestId: c.get('requestId') },
        },
        200,
      ),
  );
  return api;
}
