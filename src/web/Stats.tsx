import { workoutListSchema } from '../shared/workouts';
import { useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Modal,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  Title,
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  qualityLabels,
  type QualityKey,
  summaryResponseSchema,
  strengthResponseSchema,
  cardioResponseSchema,
  type SummaryResponse,
} from '../shared/stats';
import type { Exercise } from '../shared/exercises';
import { api } from './lib';
import { ErrorNotice, ExerciseLibrary } from './Exercises';
const categories = [
  'run',
  'walk',
  'cycle',
  'swim',
  'row',
  'elliptical',
  'other',
];
const categoryNames = [
  '跑步',
  '步行',
  '骑行',
  '游泳',
  '划船',
  '椭圆机',
  '其他',
];
const categoryLabel = (v: string) => categoryNames[categories.indexOf(v)] ?? v;
export const statValue = (v: number | null) =>
  v === null
    ? '未记录 / 无有效样本'
    : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 }).format(v);
type Range = { from: string | null; to: string | null };
function params(range: Range, extra: Record<string, string> = {}) {
  const p = new URLSearchParams(extra);
  if (range.from) p.set('from', range.from);
  if (range.to) p.set('to', range.to);
  return p;
}
function RangeFields({
  range,
  setRange,
}: {
  range: Range;
  setRange: (v: Range) => void;
}) {
  return (
    <>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <DateInput
          label="统计开始日期（包含）"
          clearable
          valueFormat="YYYY-MM-DD"
          value={range.from}
          onChange={(from) => setRange({ ...range, from })}
        />
        <DateInput
          label="统计结束日期（不包含）"
          clearable
          valueFormat="YYYY-MM-DD"
          value={range.to}
          onChange={(to) => setRange({ ...range, to })}
        />
      </SimpleGrid>
      <Text size="sm" c="dimmed">
        留空由服务端选择近 28 天；单次最多 366
        天。按训练本地日期归属，不按当前浏览器时区重算。
      </Text>
    </>
  );
}
export function Context({
  data,
}: {
  data:
    | SummaryResponse['data']
    | {
        from: string;
        to: string;
        warmup: string;
        definitionsVersion: string;
        quality: SummaryResponse['data']['quality'];
      };
}) {
  return (
    <Paper withBorder p="md">
      <Stack gap="xs">
        <Text fw={600}>
          范围 {data.from} ≤ 训练本地日期 &lt; {data.to}
        </Text>
        <Text size="sm">
          仅已完成训练与明细 · 热身
          {data.warmup === 'exclude'
            ? '排除'
            : data.warmup === 'include'
              ? '包含'
              : '不适用'}{' '}
          · 定义版本 {data.definitionsVersion} · 有效样本{' '}
          {data.quality.validSamples}
        </Text>
        <Text size="sm">
          缺失计数：
          {Object.entries(data.quality.missing)
            .map(([k, v]) => `${qualityLabels[k as QualityKey]}: ${v}`)
            .join('；') || '无'}
        </Text>
        <Text size="sm">
          排除计数：
          {Object.entries(data.quality.excluded)
            .map(([k, v]) => `${qualityLabels[k as QualityKey]}: ${v}`)
            .join('；') || '无'}
        </Text>
      </Stack>
    </Paper>
  );
}
function DetailTable({
  title,
  headers,
  rows,
}: {
  title: string;
  headers: string[];
  rows: React.ReactNode[][];
}) {
  return (
    <Table.ScrollContainer minWidth={640}>
      <Table striped withTableBorder captionSide="top">
        <Table.Caption>{title}（与图表同源；可横向滚动）</Table.Caption>
        <Table.Thead>
          <Table.Tr>
            {headers.map((h) => (
              <Table.Th key={h} scope="col">
                {h}
              </Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row, i) => (
            <Table.Tr key={i}>
              {row.map((cell, j) => (
                <Table.Td key={j}>{cell}</Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
function Chart({
  data,
  field,
  label,
  dateKey = 'localDate',
  bar = false,
}: {
  data: Record<string, unknown>[];
  field: string;
  label: string;
  dateKey?: string;
  bar?: boolean;
}) {
  if (!data.length)
    return (
      <Alert title="没有有效记录">调整日期或筛选条件，不生成示例趋势。</Alert>
    );
  return (
    <Paper withBorder p="md">
      <Text fw={600} mb="sm">
        {label}
      </Text>
      <div
        role="img"
        aria-label={`${label}，${data.length} 个数据点，精确值见下方明细表。`}
        style={{ width: '100%', height: 260, minWidth: 0 }}
      >
        <ResponsiveContainer width="100%" height="100%">
          {bar ? (
            <BarChart data={data} accessibilityLayer>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey={dateKey} stroke="var(--mantine-color-dimmed)" />
              <YAxis stroke="var(--mantine-color-dimmed)" />
              <Tooltip
                contentStyle={{
                  background: 'var(--mantine-color-body)',
                  color: 'var(--mantine-color-text)',
                }}
              />
              <Bar
                dataKey={field}
                name={label}
                fill="var(--mantine-color-teal-7)"
                isAnimationActive={false}
              />
            </BarChart>
          ) : (
            <LineChart data={data} accessibilityLayer>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey={dateKey} stroke="var(--mantine-color-dimmed)" />
              <YAxis stroke="var(--mantine-color-dimmed)" />
              <Tooltip
                contentStyle={{
                  background: 'var(--mantine-color-body)',
                  color: 'var(--mantine-color-text)',
                }}
              />
              <Line
                dataKey={field}
                name={label}
                stroke="var(--mantine-color-teal-7)"
                strokeWidth={2}
                dot={{ r: 4 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
      <Text size="xs" c="dimmed">
        缺失值不连线，不视为零；单点仅表示该次记录，不代表变化趋势。
      </Text>
    </Paper>
  );
}
function Summary({ range }: { range: Range }) {
  const [granularity, setGranularity] = useState('week');
  const query = useQuery({
    queryKey: ['stats', 'summary', range, granularity],
    queryFn: () =>
      api(
        `/stats/summary?${params(range, { granularity })}`,
        summaryResponseSchema,
      ),
  });
  const d = query.data?.data;
  return (
    <Stack>
      <Select
        label="频次分桶"
        data={[
          { value: 'day', label: '每日' },
          { value: 'week', label: '每周（周一起）' },
          { value: 'month', label: '每月' },
        ]}
        value={granularity}
        onChange={(v) => v && setGranularity(v)}
        allowDeselect={false}
      />
      {query.isPending && <Text role="status">正在加载总览统计…</Text>}
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      {d && (
        <>
          <Context data={d} />
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            {[
              ['已完成训练', `${d.totals.workoutCount} 次`],
              [
                '整次训练已记录时长',
                `${statValue(d.totals.durationSeconds)} 秒`,
              ],
              [
                '时长覆盖率',
                d.totals.durationCoverage === null
                  ? '无训练样本'
                  : `${statValue(d.totals.durationCoverage * 100)}%（${d.totals.recordedDurationWorkoutCount}/${d.totals.workoutCount}）`,
              ],
              ['含力量训练', `${d.totals.strengthWorkoutCount} 次`],
              ['含有氧训练', `${d.totals.cardioWorkoutCount} 次`],
              [
                '有氧明细时长',
                `${statValue(d.totals.cardioDurationSeconds)} 秒`,
              ],
            ].map(([label, value]) => (
              <Paper withBorder p="lg" key={label}>
                <Text c="dimmed" size="sm">
                  {label}
                </Text>
                <Text fw={700} size="xl">
                  {value}
                </Text>
              </Paper>
            ))}
          </SimpleGrid>
          <Text size="sm">
            整次时长只累计已填写值，不与有氧时长相加。混合训练可同时命中力量和有氧，两类次数不能相加当作总次数。
          </Text>
          <Chart
            data={d.buckets}
            field="workoutCount"
            dateKey="bucketStart"
            label="已完成训练频次（次）"
            bar
          />
          <DetailTable
            title="训练频次明细"
            headers={[
              '桶起点',
              '实际范围（结束不含）',
              '训练次数',
              '已记录时长（秒）',
              '时长样本 / 训练数',
            ]}
            rows={d.buckets.map((b) => [
              b.bucketStart,
              `${b.from} — ${b.to}`,
              b.workoutCount,
              statValue(b.durationSeconds),
              `${b.recordedDurationWorkoutCount}/${b.workoutCount}`,
            ])}
          />
          <DetailTable
            title="有氧项目累计（按时长口径分开）"
            headers={[
              '项目',
              '口径',
              '条目数',
              '时长（秒）',
              '有效距离（米）',
              '距离样本数',
            ]}
            rows={d.cardioByCategory.map((c) => [
              categoryLabel(c.category),
              c.durationBasis === 'elapsed' ? '总经过时间' : '移动时间',
              c.recordCount,
              statValue(c.durationSeconds),
              statValue(c.distanceMeters),
              c.distanceSampleCount,
            ])}
          />
        </>
      )}
    </Stack>
  );
}
function Strength({ range }: { range: Range }) {
  const [exercise, setExercise] = useState<Exercise | null>(null),
    [picker, setPicker] = useState(false),
    [warmup, setWarmup] = useState(false),
    [metric, setMetric] = useState('maxLoadKg');
  const query = useQuery({
    queryKey: ['stats', 'strength', range, exercise?.id, warmup],
    enabled: !!exercise,
    queryFn: () =>
      api(
        `/stats/strength?${params(range, { exerciseId: exercise!.id, includeWarmup: String(warmup) })}`,
        strengthResponseSchema,
      ),
  });
  const d = query.data?.data;
  const label =
    metric === 'maxLoadKg'
      ? '每次最高外加重量（kg）'
      : metric === 'volumeKgReps'
        ? '有效容量（kg·次）'
        : '计时累计（秒）';
  return (
    <Stack>
      <Button variant="light" onClick={() => setPicker(true)}>
        {exercise ? `动作：${exercise.name}` : '选择一个力量动作'}
      </Button>
      <Checkbox
        label="包含热身组（默认排除）"
        checked={warmup}
        onChange={(e) => setWarmup(e.currentTarget.checked)}
      />
      <Select
        label="图表指标"
        allowDeselect={false}
        data={[
          { value: 'maxLoadKg', label: '最高外加重量' },
          { value: 'volumeKgReps', label: '容量' },
          { value: 'durationSeconds', label: '计时累计' },
        ]}
        value={metric}
        onChange={(v) => v && setMetric(v)}
      />
      {!exercise && <Text>先选择动作，不跨动作比较或累计容量。</Text>}
      {query.isFetching && <Text role="status">正在加载力量统计…</Text>}
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      {d && (
        <>
          <Context data={d} />
          <Text>
            完成组 {d.totals.setCount} · 正式组 {d.totals.workingSetCount} ·
            热身组 {d.totals.warmupSetCount} · 次数 {statValue(d.totals.reps)} ·
            有效容量 {statValue(d.totals.volumeKgReps)} kg·次（
            {d.totals.volumeSampleCount} 组）
          </Text>
          <Text size="sm" c="dimmed">
            容量由服务端按历史倍率计算。自重、辅助、计时或倍率未知的组不参与容量；辅助重量不是外加负重。次数按动作原口径展示。
          </Text>
          <Chart data={d.workouts} field={metric} label={label} />
          <DetailTable
            title="每次训练力量明细"
            headers={[
              '日期 / 原记录',
              '完成组',
              '次数',
              '时长（秒）',
              '最高外加（kg）',
              '容量（kg·次）',
              '容量样本组',
            ]}
            rows={d.workouts.map((w) => [
              <Link to={`/workouts/${w.workoutId}`}>{w.localDate}</Link>,
              w.setCount,
              w.reps,
              w.durationSeconds,
              statValue(w.maxLoadKg),
              statValue(w.volumeKgReps),
              w.volumeSampleCount,
            ])}
          />
          <Title order={3}>实际纪录（不是估算 1RM）</Title>
          <Text>
            最高外加重量：
            {d.records.maxLoad
              ? `${statValue(d.records.maxLoad.loadKg)} kg · ${statValue(d.records.maxLoad.reps)} 次 · ${d.records.maxLoad.localDate}`
              : '无有效样本'}
          </Text>
          <Text>
            最长计时：
            {d.records.longestDuration
              ? `${statValue(d.records.longestDuration.durationSeconds)} 秒 · ${d.records.longestDuration.localDate}`
              : '无有效样本'}
          </Text>
          <DetailTable
            title="相同阻力口径下最多次数"
            headers={[
              '日期',
              '阻力模式',
              '外加（kg）',
              '辅助（kg）',
              '次数',
              '原记录',
            ]}
            rows={d.records.mostRepsByResistance.map((r) => [
              r.localDate,
              r.resistanceMode,
              statValue(r.loadKg),
              statValue(r.assistanceKg),
              statValue(r.reps),
              <Link to={`/workouts/${r.workoutId}`}>查看训练</Link>,
            ])}
          />
        </>
      )}
      <Modal
        opened={picker}
        onClose={() => setPicker(false)}
        title="选择力量动作"
        size="lg"
      >
        <ExerciseLibrary
          onlyKind="strength"
          onPick={(e) => {
            if (e.kind === 'strength') {
              setExercise(e);
              setPicker(false);
            }
          }}
        />
        <Text size="sm">仅力量动作可用于本页；有氧动作请到有氧趋势。</Text>
      </Modal>
    </Stack>
  );
}
function Cardio({ range }: { range: Range }) {
  const [category, setCategory] = useState('run'),
    [basis, setBasis] = useState('elapsed'),
    [metric, setMetric] = useState('paceSecondsPerKm');
  const query = useQuery({
    queryKey: ['stats', 'cardio', range, category, basis],
    queryFn: () =>
      api(
        `/stats/cardio?${params(range, { category, durationBasis: basis })}`,
        cardioResponseSchema,
      ),
  });
  const d = query.data?.data;
  const label =
    metric === 'speedKmh'
      ? '速度（km/h）'
      : metric === 'averageHeartRate'
        ? '原记录平均心率（bpm）'
        : metric === 'paceSecondsPer100m'
          ? '配速（秒/100m）'
          : '配速（秒/km）';
  return (
    <Stack>
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <Select
          label="有氧项目"
          allowDeselect={false}
          data={categories.map((value) => ({
            value,
            label: categoryLabel(value),
          }))}
          value={category}
          onChange={(v) => {
            if (v) {
              setCategory(v);
              setMetric(
                v === 'cycle'
                  ? 'speedKmh'
                  : v === 'swim'
                    ? 'paceSecondsPer100m'
                    : 'paceSecondsPerKm',
              );
            }
          }}
        />
        <Select
          label="时长口径（分别统计）"
          allowDeselect={false}
          data={[
            { value: 'elapsed', label: '总经过时间（含停顿）' },
            { value: 'moving', label: '移动时间' },
          ]}
          value={basis}
          onChange={(v) => v && setBasis(v)}
        />
        <Select
          label="有氧图表指标"
          allowDeselect={false}
          value={metric}
          onChange={(v) => v && setMetric(v)}
          data={[
            { value: 'paceSecondsPerKm', label: '配速 秒/km' },
            { value: 'paceSecondsPer100m', label: '配速 秒/100m' },
            { value: 'speedKmh', label: '速度 km/h' },
            { value: 'averageHeartRate', label: '平均心率 bpm' },
          ]}
        />
      </SimpleGrid>
      {query.isPending && <Text role="status">正在加载有氧统计…</Text>}
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      {d && (
        <>
          <Context data={d} />
          <Text size="sm">
            配速 /
            速度按相同项目和时长口径的有效距离、时长总和计算，不平均每条配速。心率汇总是记录均值的时长加权估计，不等于连续心率采样。
          </Text>
          <DetailTable
            title="有氧聚合与有效样本"
            headers={[
              '项目 / 口径',
              '条目数',
              '时长（秒）',
              '距离（米）/ 样本',
              '爬升（米）/ 样本',
              '速度（km/h）',
              '配速（秒/km）',
              '配速（秒/100m）',
              '配速样本',
              '加权心率（bpm）/ 样本',
            ]}
            rows={d.groups.map((g) => [
              `${categoryLabel(g.category)} / ${g.durationBasis}`,
              g.recordCount,
              g.durationSeconds,
              `${statValue(g.distanceMeters)} / ${g.distanceSampleCount}`,
              `${statValue(g.elevationGainMeters)} / ${g.elevationSampleCount}`,
              statValue(g.speedKmh),
              statValue(g.paceSecondsPerKm),
              statValue(g.paceSecondsPer100m),
              g.paceSampleCount,
              `${statValue(g.averageHeartRate)} / ${g.heartRateSampleCount}`,
            ])}
          />
          <Chart data={d.records} field={metric} label={label} />
          <DetailTable
            title="有氧原记录与派生明细"
            headers={[
              '日期 / 原记录',
              '时长（秒）',
              '距离（米）',
              '速度（km/h）',
              '配速（秒/km）',
              '配速（秒/100m）',
              '平均 / 最大心率（bpm）',
              '爬升（米）',
            ]}
            rows={d.records.map((r) => [
              <Link to={`/workouts/${r.workoutId}`}>{r.localDate}</Link>,
              r.durationSeconds,
              statValue(r.distanceMeters),
              statValue(r.speedKmh),
              statValue(r.paceSecondsPerKm),
              statValue(r.paceSecondsPer100m),
              `${statValue(r.averageHeartRate)} / ${statValue(r.maxHeartRate)}`,
              statValue(r.elevationGainMeters),
            ])}
          />
        </>
      )}
    </Stack>
  );
}
function RecentWorkouts({ range }: { range: Range }) {
  const query = useQuery({
    queryKey: ['workouts', 'overview', range],
    queryFn: () =>
      api(`/workouts?${params(range, { limit: '5' })}`, workoutListSchema),
  });
  return (
    <Paper withBorder p="lg">
      <Stack>
        <Title order={2} size="h3">
          当前范围最近训练
        </Title>
        {query.isPending && <Text role="status">正在读取最近训练…</Text>}
        <ErrorNotice error={query.error} retry={() => void query.refetch()} />
        {query.data && (
          <>
            <Text size="sm">
              {query.data.meta.from} 至 {query.data.meta.to}（不含），最多 5 次
            </Text>
            {query.data.data.length === 0 && <Text>当前范围无训练。</Text>}
            {query.data.data.map((w) => (
              <Group key={w.id} justify="space-between">
                <Text>
                  {w.localDate} · {w.status === 'completed' ? '已完成' : '草稿'}{' '}
                  · {w.entryCount} 个动作
                </Text>
                <Button
                  component={Link}
                  to={`/workouts/${w.id}`}
                  variant="light"
                >
                  查看详情
                </Button>
              </Group>
            ))}
          </>
        )}
      </Stack>
    </Paper>
  );
}
export function Overview() {
  const [range, setRange] = useState<Range>({ from: null, to: null });
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={1}>训练总览</Title>
        <Button component={Link} to="/workouts/new">
          记录新训练
        </Button>
      </Group>
      <Text c="dimmed">客观记录与统计，不提供医疗判断或自动训练建议。</Text>
      <RangeFields range={range} setRange={setRange} />
      <Summary range={range} />
      <RecentWorkouts range={range} />
      <Button component={Link} to="/workouts" variant="light">
        查看最近训练与历史
      </Button>
    </Stack>
  );
}
export function Trends() {
  const [range, setRange] = useState<Range>({ from: null, to: null });
  return (
    <Stack>
      <Title order={1}>训练趋势</Title>
      <RangeFields range={range} setRange={setRange} />
      <Tabs defaultValue="strength" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="strength">力量</Tabs.Tab>
          <Tabs.Tab value="cardio">有氧</Tabs.Tab>
          <Tabs.Tab value="frequency">频次</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="strength" pt="lg">
          <Strength range={range} />
        </Tabs.Panel>
        <Tabs.Panel value="cardio" pt="lg">
          <Cardio range={range} />
        </Tabs.Panel>
        <Tabs.Panel value="frequency" pt="lg">
          <Summary range={range} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
