import { workoutHistoryQuery } from './workoutHistoryQuery';
import { settingsQuery, assertBodySize } from './lib';
import { listDrafts, readRecoveryDraft, ownedDraftKey } from './lib';
import { NavigationGuard } from './NavigationGuard';
import { localTimeCandidates } from './localTime';
import { projectMeasurement } from './lib';
import { confirmAction } from './confirm';
import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { DateTimePicker, DateInput } from '@mantine/dates';
import { useForm } from '@mantine/form';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { Link, useNavigate, useParams } from 'react-router-dom';
import dayjs from 'dayjs';
import '../shared/dates';
import { LIMITS } from '../shared/contracts';
import {
  workoutResponseSchema,
  workoutListSchema,
  workoutDeleteSchema,
  workoutInputSchema,
  validateStrengthMeasurement,
  type Workout,
  type WorkoutInput,
} from '../shared/workouts';
import type { Exercise } from '../shared/exercises';
import {
  api,
  ApiError,
  copySet,
  copyWorkout,
  draftExpired,
  emptySet,
  infoFromWorkout,
  invalidateWorkouts,
  newWorkout,
  readDraft,
  removeDraft,
  toInput,
  versionHeaders,
  writeDraft,
  type Draft,
  type EntryInfo,
} from './lib';
import { ErrorNotice, ExerciseLibrary } from './Exercises';

export function WorkoutHistory() {
  const [from, setFrom] = useState<string | null>(null),
    [to, setTo] = useState<string | null>(null),
    [kind, setKind] = useState<string | null>(null),
    [status, setStatus] = useState<string | null>(null),
    [exercise, setExercise] = useState<Exercise | null>(null),
    [picker, setPicker] = useState(false);
  const query = useInfiniteQuery(
    workoutHistoryQuery({ from, to, kind, status, exerciseId: exercise?.id }),
  );
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={1}>训练历史</Title>
        <Button component={Link} to="/workouts/new">
          新建训练
        </Button>
      </Group>
      <Text c="dimmed">
        默认近 28 天；日期按每次训练本地日期筛选，结束日期不包含当天，单次最多
        366 天。
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <DateInput
          label="开始日期（包含）"
          clearable
          value={from}
          onChange={setFrom}
          valueFormat="YYYY-MM-DD"
        />
        <DateInput
          label="结束日期（不包含）"
          clearable
          value={to}
          onChange={setTo}
          valueFormat="YYYY-MM-DD"
        />
        <Select
          label="训练类型"
          clearable
          data={[
            { value: 'strength', label: '含力量' },
            { value: 'cardio', label: '含有氧' },
          ]}
          value={kind}
          onChange={setKind}
        />
        <Select
          label="训练状态"
          clearable
          data={[
            { value: 'draft', label: '草稿' },
            { value: 'completed', label: '已完成' },
          ]}
          value={status}
          onChange={setStatus}
        />
      </SimpleGrid>
      <Group>
        <Button variant="light" onClick={() => setPicker(true)}>
          {exercise ? `动作：${exercise.name}` : '按动作筛选'}
        </Button>
        {exercise && (
          <Button variant="subtle" onClick={() => setExercise(null)}>
            清除动作筛选
          </Button>
        )}
        <Button variant="subtle" onClick={() => void query.refetch()}>
          刷新训练
        </Button>
        <Button component={Link} to="/exercises" variant="subtle">
          管理动作库
        </Button>
      </Group>
      {query.isPending && <Text role="status">正在加载训练…</Text>}
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      {query.data && (
        <Text size="sm" c="dimmed">
          当前范围 {query.data.pages[0]!.meta.from} 至{' '}
          {query.data.pages[0]!.meta.to}（不含）
        </Text>
      )}
      {query.data?.pages[0]!.data.length === 0 && (
        <Paper withBorder p="xl">
          <Text>此范围没有训练记录。调整筛选，或开始记录一次训练。</Text>
        </Paper>
      )}
      {query.data?.pages
        .flatMap((p) => p.data)
        .map((w) => (
          <Paper key={w.id} withBorder p="lg">
            <Group justify="space-between">
              <Stack gap="xs">
                <Text fw={700}>
                  {w.localDate} ·{' '}
                  {dayjs(w.startedAt).tz(w.timezone).format('HH:mm')}
                </Text>
                <Text size="sm">
                  {w.entryCount} 个动作 ·{' '}
                  {w.durationSeconds === null
                    ? '总时长未记录'
                    : `${w.durationSeconds} 秒`}{' '}
                  ·{' '}
                  {w.kinds
                    .map((k) => (k === 'strength' ? '力量' : '有氧'))
                    .join(' + ')}
                </Text>
                <Badge w="fit-content">
                  {w.status === 'draft' ? '云端草稿' : '已完成'}
                </Badge>
              </Stack>
              <Button component={Link} to={`/workouts/${w.id}`} variant="light">
                查看详情
              </Button>
            </Group>
          </Paper>
        ))}
      {query.hasNextPage && (
        <Button
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          加载更多训练
        </Button>
      )}
      <Modal
        opened={picker}
        onClose={() => setPicker(false)}
        title="按动作筛选"
        size="lg"
      >
        <ExerciseLibrary
          onPick={(e) => {
            setExercise(e);
            setPicker(false);
          }}
        />
      </Modal>
    </Stack>
  );
}
export function WorkoutDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [localError, setLocalError] = useState<Error | null>(null);
  const query = useQuery({
    queryKey: ['workout', id],
    queryFn: () => api(`/workouts/${id}`, workoutResponseSchema),
  });
  const deletion = useMutation({
    mutationFn: (workout: Workout) =>
      api(`/workouts/${workout.id}`, workoutDeleteSchema, {
        method: 'DELETE',
        headers: versionHeaders(workout.version),
      }),
    onSuccess: async () => {
      try {
        removeDraft(id!);
      } catch {
        notifications.show({
          color: 'orange',
          message: '云端已删除，但本地草稿清理失败，请在设置清理。',
        });
      }
      await invalidateWorkouts(client);
      void navigate('/workouts');
    },
  });
  if (!query.data)
    return (
      <Stack>
        {query.isPending && <Text role="status">正在加载训练详情…</Text>}
        <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      </Stack>
    );
  const w = query.data.data;
  return (
    <Stack>
      <Title order={1}>{w.localDate} 训练详情</Title>
      <Group>
        <Badge>{w.status === 'completed' ? '已完成' : '云端草稿'}</Badge>
        <Text>
          版本 {w.version} · {w.timezone}
        </Text>
      </Group>
      <Text>
        开始：{dayjs(w.startedAt).tz(w.timezone).format('YYYY-MM-DD HH:mm:ss')}{' '}
        · 总时长：
        {w.durationSeconds === null ? '未记录' : `${w.durationSeconds} 秒`}
      </Text>
      <Text style={{ whiteSpace: 'pre-wrap' }}>{w.notes ?? '无训练备注'}</Text>
      <Group>
        <Button component={Link} to={`/workouts/${id}/edit`}>
          编辑训练
        </Button>
        <Button
          variant="light"
          onClick={async () => {
            try {
              if (
                readDraft('new') &&
                !(await confirmAction(
                  '已有新建草稿。复制历史会替换它，是否继续？',
                ))
              )
                return;
              writeDraft('new', {
                input: copyWorkout(w),
                info: Object.fromEntries([]),
                savedAt: Date.now(),
                key: crypto.randomUUID(),
                baseVersion: null,
                pending: null,
              });
              const draft = readDraft('new')!;
              draft.info = Object.fromEntries(
                draft.input.entries.map((entry, i) => [
                  entry.id,
                  {
                    name: w.entries[i]!.exerciseNameSnapshot,
                    measurement: w.entries[i]!.measurementSnapshot,
                  },
                ]),
              );
              writeDraft('new', draft);
              void navigate('/workouts/new');
            } catch {
              setLocalError(
                new Error('本地存储不可用，无法安全创建历史副本。'),
              );
            }
          }}
        >
          复制为新草稿
        </Button>
        <Button color="red" variant="light" onClick={() => setConfirm(true)}>
          删除训练
        </Button>
      </Group>
      <ErrorNotice error={localError} />
      {w.entries.map((e) => (
        <Paper key={e.id} withBorder p="lg">
          <Stack gap="xs">
            <Title order={2} size="h3">
              {e.position + 1}. {e.exerciseNameSnapshot}
            </Title>
            <Text size="sm" c="dimmed">
              历史计量快照：{e.measurementSnapshot.measurementMode} /{' '}
              {e.measurementSnapshot.resistanceMode ?? '有氧'} / 重量{' '}
              {e.measurementSnapshot.loadConvention} / 次数{' '}
              {e.measurementSnapshot.repConvention}
            </Text>
            {e.kind === 'strength' ? (
              e.sets.map((s, i) => (
                <Paper withBorder p="sm" key={s.id}>
                  <Text>
                    第 {i + 1} 组 · {s.setType === 'warmup' ? '热身' : '正式'} ·{' '}
                    {s.completed ? '已完成' : '未完成'}
                  </Text>
                  <Text>
                    {s.reps === null ? '' : `${s.reps} 次 `}
                    {s.durationSeconds === null
                      ? ''
                      : `${s.durationSeconds} 秒 `}
                    · 外加 {s.loadKg ?? '未记录'} kg · 辅助{' '}
                    {s.assistanceKg ?? '未记录'} kg
                  </Text>
                  <Text size="sm">
                    {s.effortType
                      ? `${s.effortType.toUpperCase()} ${s.effortValue}`
                      : '强度未记录'}{' '}
                    · {s.notes ?? '无组备注'}
                  </Text>
                </Paper>
              ))
            ) : (
              <>
                <Text>
                  {e.cardio.completed ? '已完成' : '未完成'} · 时长{' '}
                  {e.cardio.durationSeconds ?? '未记录'} 秒（
                  {e.cardio.durationBasis === 'elapsed'
                    ? '总经过时间'
                    : '移动时间'}
                  ）· 距离 {e.cardio.distanceMeters ?? '未记录'} 米
                </Text>
                <Text>
                  平均 / 最大心率 {e.cardio.averageHeartRate ?? '未记录'} /{' '}
                  {e.cardio.maxHeartRate ?? '未记录'} bpm
                </Text>
                <Text>
                  爬升 {e.cardio.elevationGainMeters ?? '未记录'} m · 坡度{' '}
                  {e.cardio.inclinePercent ?? '未记录'}% · 阻力{' '}
                  {e.cardio.resistanceLevel ?? '未记录'} · 设备热量估计{' '}
                  {e.cardio.deviceCaloriesKcal ?? '未记录'} kcal
                </Text>
              </>
            )}
            <Text style={{ whiteSpace: 'pre-wrap' }}>
              {e.notes ?? '无动作备注'}
            </Text>
          </Stack>
        </Paper>
      ))}
      <Modal
        opened={confirm}
        onClose={() => !deletion.isPending && setConfirm(false)}
        title="永久删除这次训练？"
      >
        <Stack>
          <Text>
            {w.localDate} · {w.entryCount}{' '}
            个动作。删除不可撤销；平台备份可能在保留期内存在。
          </Text>
          <ErrorNotice error={deletion.error} />
          {deletion.error instanceof ApiError &&
            deletion.error.status === 412 && (
              <Button
                onClick={() => {
                  setConfirm(false);
                  deletion.reset();
                  void query.refetch();
                }}
              >
                查看最新版本后重新确认
              </Button>
            )}
          <Button
            color="red"
            loading={deletion.isPending}
            disabled={
              deletion.error instanceof ApiError &&
              deletion.error.status === 412
            }
            onClick={() => deletion.mutate(w)}
          >
            确认删除
          </Button>
        </Stack>
      </Modal>
    </Stack>
  );
}
export function WorkoutEditorPage() {
  const settings = useQuery({
    ...settingsQuery,
    staleTime: Infinity,
  });
  const { id } = useParams();
  const query = useQuery({
    queryKey: ['workout', id],
    queryFn: () => api(`/workouts/${id}`, workoutResponseSchema),
    enabled: !!id,
  });
  if (!id && !settings.data)
    return (
      <Stack>
        {settings.isPending && <Text role="status">正在读取默认训练时区…</Text>}
        <ErrorNotice
          error={settings.error}
          retry={() => void settings.refetch()}
        />
      </Stack>
    );
  if (!id && settings.data?.data.createdAt === '1970-01-01T00:00:00.000Z')
    return (
      <Alert title="首次使用请确认默认时区">
        <Text>云端尚无已确认设置，请先确认浏览器时区、公制和主题。</Text>
        <Button component={Link} to="/settings">
          前往设置确认
        </Button>
      </Alert>
    );
  if (id && !query.data)
    return (
      <Stack>
        {query.isPending && <Text role="status">正在加载编辑内容…</Text>}
        <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      </Stack>
    );
  return (
    <WorkoutEditor
      key={id ?? 'new'}
      workout={query.data?.data}
      defaultTimezone={settings.data?.data.timezone}
    />
  );
}
function Numeric({
  label,
  value,
  onChange,
  error,
  min = 0,
  integer = false,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  error?: React.ReactNode;
  min?: number;
  integer?: boolean;
}) {
  return (
    <NumberInput
      label={label}
      value={value ?? ''}
      onChange={(v) => onChange(typeof v === 'number' ? v : null)}
      min={min}
      allowDecimal={!integer}
      decimalScale={integer ? 0 : 3}
      hideControls
      inputMode={integer ? 'numeric' : 'decimal'}
      error={error}
    />
  );
}
function RecentReference({ exerciseId }: { exerciseId: string }) {
  const [opened, setOpened] = useState(false);
  const query = useQuery({
    queryKey: ['workouts', 'reference', exerciseId],
    enabled: opened,
    queryFn: () =>
      api(
        `/workouts?exerciseId=${exerciseId}&status=completed&limit=1`,
        workoutListSchema,
      ),
  });
  const previous = query.data?.data[0];
  return (
    <Stack gap="xs">
      <Button variant="subtle" onClick={() => setOpened((v) => !v)}>
        {opened ? '收起参考' : '查看近 28 天完成训练参考'}
      </Button>
      {opened && (
        <>
          <Text size="sm" c="dimmed">
            查询默认近 28
            天；参考不会自动填入或标记完成。更早记录可在历史按日期查询。
          </Text>
          {query.isPending && <Text role="status">正在查询参考…</Text>}
          <ErrorNotice error={query.error} retry={() => void query.refetch()} />
          {previous ? (
            <Button
              component={Link}
              target="_blank"
              to={`/workouts/${previous.id}`}
              variant="light"
            >
              在新页面查看 {previous.localDate} 完整参考
            </Button>
          ) : (
            query.isSuccess && (
              <Text size="sm">近 28 天没有此动作的已完成记录。</Text>
            )
          )}
        </>
      )}
    </Stack>
  );
}
function WorkoutEditor({
  workout,
  defaultTimezone,
}: {
  workout?: Workout | undefined;
  defaultTimezone?: string | undefined;
}) {
  const id = workout?.id ?? 'new';
  const navigate = useNavigate();
  const client = useQueryClient();
  const form = useForm<WorkoutInput>({
    initialValues: workout
      ? toInput(workout)
      : {
          ...newWorkout(),
          ...(defaultTimezone ? { timezone: defaultTimezone } : {}),
        },
  });
  const [recovery] = useState(() => {
    try {
      return { draft: readDraft(id), error: null };
    } catch {
      return {
        draft: null,
        error: new Error(
          '本地草稿损坏或存储被禁用。现有内容未被覆盖，请显式清理后继续。',
        ),
      };
    }
  });
  const [info, setInfo] = useState<Record<string, EntryInfo>>(
      workout ? infoFromWorkout(workout) : {},
    ),
    [key, setKey] = useState<string>(() => crypto.randomUUID()),
    [pending, setPending] = useState<Draft['pending']>(null),
    [baseVersion, setBaseVersion] = useState(workout?.version ?? null),
    [candidate, setCandidate] = useState<Draft | null>(recovery.draft),
    [storageError, setStorageError] = useState<Error | null>(recovery.error),
    [picker, setPicker] = useState(false),
    [validation, setValidation] = useState<string[]>([]),
    [cloudSaved, setCloudSaved] = useState(false),
    [timeChoices, setTimeChoices] = useState<string[]>([]),
    [timeError, setTimeError] = useState<string | null>(null);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (
        event.key === `healthworker.draft.${ownedDraftKey(id)}` ||
        event.key === null
      )
        setStorageError(
          new Error(
            '其他页面修改或清理了本地草稿。当前输入仍保留，但自动保存已暂停；请核对其他页面后再继续，避免互相覆盖。',
          ),
        );
    };
    window.addEventListener('storage', changed);
    const leaving = (event: BeforeUnloadEvent) => {
      if (storageError || pending) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', leaving);
    return () => {
      window.removeEventListener('storage', changed);
      window.removeEventListener('beforeunload', leaving);
    };
  }, [id, storageError, pending]);
  useEffect(() => {
    if (candidate || cloudSaved || storageError) return;
    try {
      writeDraft(id, {
        input: form.values,
        info,
        key,
        pending,
        baseVersion,
        savedAt: Date.now(),
      });
    } catch {
      queueMicrotask(() =>
        setStorageError(
          new Error(
            '本地草稿保存失败（存储禁用或配额不足）。请勿关闭页面，可尝试云端保存。',
          ),
        ),
      );
    }
  }, [
    form.values,
    info,
    key,
    pending,
    baseVersion,
    candidate,
    cloudSaved,
    storageError,
    id,
  ]);
  const save = useMutation({
    mutationFn: (request: { input: WorkoutInput; key: string }) =>
      api(workout ? `/workouts/${id}` : '/workouts', workoutResponseSchema, {
        method: workout ? 'PUT' : 'POST',
        headers: workout
          ? versionHeaders(baseVersion!)
          : { 'Idempotency-Key': request.key },
        body: JSON.stringify(request.input),
      }),
    onSuccess: async (result) => {
      setCloudSaved(true);
      try {
        removeDraft(id);
      } catch {
        notifications.show({
          color: 'orange',
          message: '云端已保存，本地副本清理失败，请到设置清理。',
        });
      }
      await invalidateWorkouts(client);
      notifications.show({
        title: '已保存到云端',
        message: result.meta.replayed
          ? '幂等重试成功，正在读取当前记录。'
          : '训练记录保存成功。',
      });
      void navigate(`/workouts/${result.data.id}`);
    },
  });
  const submit = (status: WorkoutInput['status']) => {
    if (timeError || timeChoices.length) {
      setValidation([timeError ?? '请确认重复本地时间的 UTC 偏移']);
      return;
    }
    if (pending) {
      save.mutate(pending);
      return;
    }
    const input = { ...form.values, status };
    const parsed = workoutInputSchema.safeParse(input);
    const errors: string[] = [];
    form.clearErrors();
    if (!parsed.success) {
      parsed.error.issues.forEach((issue) => {
        form.setFieldError(issue.path.join('.'), issue.message);
        errors.push(`${issue.path.join('.')}：${issue.message}`);
      });
    }
    input.entries.forEach((e, i) => {
      const measurement = info[e.id]?.measurement;
      if (!measurement)
        errors.push(`动作 ${i + 1} 缺少计量口径，请重新选择动作。`);
      else if (e.kind === 'strength')
        e.sets.forEach((s, j) =>
          validateStrengthMeasurement(s, measurement).forEach((message) => {
            const field =
              message.includes('重量') || message.includes('负重')
                ? measurement.resistanceMode === 'assisted'
                  ? 'assistanceKg'
                  : 'loadKg'
                : measurement.measurementMode === 'duration'
                  ? 'durationSeconds'
                  : 'reps';
            form.setFieldError(`entries.${i}.sets.${j}.${field}`, message);
            errors.push(`动作 ${i + 1} 第 ${j + 1} 组：${message}`);
          }),
        );
    });
    setValidation(errors);
    if (errors.length)
      setTimeout(
        () =>
          document
            .querySelector<HTMLElement>('[data-validation-summary]')
            ?.focus(),
        0,
      );
    if (errors.length || !parsed.success) return;
    try {
      assertBodySize(JSON.stringify(parsed.data));
    } catch (error) {
      setValidation([
        error instanceof Error ? error.message : '提交内容过大，输入已保留',
      ]);
      return;
    }
    const request = { input: parsed.data, key };
    setPending(request);
    try {
      writeDraft(id, {
        input: form.values,
        info,
        key,
        pending: request,
        baseVersion,
        savedAt: Date.now(),
      });
    } catch {
      setStorageError(
        new Error('请求仅保存在当前页面；关闭页面将失去幂等重试信息。'),
      );
    }
    save.mutate(request);
  };
  const add = (exercise: Exercise) => {
    const entryId = crypto.randomUUID();
    setInfo((old) => ({
      ...old,
      [entryId]: {
        name: exercise.name,
        measurement: projectMeasurement(exercise),
      },
    }));
    form.insertListItem('entries', {
      id: entryId,
      exerciseId: exercise.id,
      notes: null,
      ...(exercise.kind === 'strength'
        ? { kind: 'strength', sets: [emptySet()] }
        : {
            kind: 'cardio',
            cardio: {
              completed: false,
              durationSeconds: null,
              durationBasis: 'elapsed',
              distanceMeters: null,
              averageHeartRate: null,
              maxHeartRate: null,
              elevationGainMeters: null,
              inclinePercent: null,
              resistanceLevel: null,
              deviceCaloriesKcal: null,
            },
          }),
    });
    setPicker(false);
  };
  const conflict =
    (candidate && candidate.baseVersion !== (workout?.version ?? null)) ||
    (workout && baseVersion !== workout.version) ||
    (save.error instanceof ApiError && save.error.status === 412);
  const frozen = !!pending || !!candidate || !!conflict;
  return (
    <Stack>
      <NavigationGuard enabled={!cloudSaved && !!(storageError || pending)} />
      <Modal
        opened={timeChoices.length > 1}
        onClose={() => {
          setTimeChoices([]);
          setTimeError('重复时间尚未确认偏移');
        }}
        title="本地时间重复，请确认 UTC 偏移"
      >
        <Stack>
          {timeChoices.map((instant) => (
            <Button
              key={instant}
              onClick={() => {
                form.setFieldValue('startedAt', instant);
                setTimeChoices([]);
                setTimeError(null);
              }}
            >
              {dayjs(instant)
                .tz(form.values.timezone)
                .format('YYYY-MM-DD HH:mm:ss Z')}{' '}
              · {instant}
            </Button>
          ))}
        </Stack>
      </Modal>
      <Group justify="space-between">
        <Title order={1}>{workout ? '编辑训练' : '新建训练'}</Title>
        <Button component={Link} to="/workouts" variant="subtle">
          返回历史
        </Button>
      </Group>
      <Text c="dimmed">
        力量与有氧按添加顺序记录。空白代表未记录，0
        仅表示明确的零值。新训练请确认开始时间与 IANA 时区。
      </Text>
      {candidate && (
        <Alert
          title={
            draftExpired(candidate)
              ? '发现超过 30 天的新建草稿'
              : '发现本地未同步草稿'
          }
          color="orange"
        >
          <Stack>
            <Text>
              保存于 {new Date(candidate.savedAt).toLocaleString()}。
              {conflict
                ? '云端版本已变化，禁止直接恢复覆盖；可查看本地内容后放弃或另建训练。'
                : '选择恢复，或明确丢弃本地副本。'}
              过期草稿不会自动恢复，将在丢弃后清理。
            </Text>
            <Group>
              <Button
                disabled={!!conflict || draftExpired(candidate)}
                onClick={() => {
                  form.setValues(candidate.input);
                  setInfo(candidate.info);
                  setKey(candidate.key);
                  setPending(candidate.pending);
                  setBaseVersion(candidate.baseVersion);
                  setCandidate(null);
                }}
              >
                恢复本地草稿
              </Button>
              <Button
                variant="light"
                onClick={async () => {
                  if (!(await confirmAction('确定丢弃本地未同步输入？')))
                    return;
                  try {
                    removeDraft(id);
                    setCandidate(null);
                    setStorageError(null);
                  } catch {
                    setStorageError(
                      new Error('清理失败，请检查浏览器存储权限。'),
                    );
                  }
                }}
              >
                丢弃本地副本
              </Button>
            </Group>
            {conflict && (
              <Text
                style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
              >
                本地内容（供核对）：{JSON.stringify(candidate.input, null, 2)}
              </Text>
            )}
          </Stack>
        </Alert>
      )}
      {!candidate && (
        <Paper withBorder p="md">
          <Text size="sm">
            其他编辑实例 / 刷新前草稿（恢复为当前实例副本，不删除原副本）
          </Text>
          {listDrafts(id)
            .filter((item) => item.key !== ownedDraftKey(id))
            .map((item) => (
              <Button
                key={item.key}
                variant="subtle"
                onClick={() => {
                  try {
                    setCandidate(readRecoveryDraft(item.key));
                  } catch {
                    setStorageError(
                      new Error('该恢复副本结构损坏；未删除原副本。'),
                    );
                  }
                }}
              >
                {item.savedAt
                  ? new Date(item.savedAt).toLocaleString()
                  : '异常草稿'}{' '}
                · 恢复副本
              </Button>
            ))}
        </Paper>
      )}
      <ErrorNotice error={storageError} />
      {storageError && (
        <Button
          variant="light"
          onClick={() => {
            try {
              removeDraft(id);
              setStorageError(null);
            } catch {
              /* Persistent alert remains. */
            }
          }}
        >
          清理异常草稿并重试本地保存
        </Button>
      )}
      {conflict && !candidate && (
        <Alert color="orange" title="版本冲突">
          <Text>
            本地输入已保留，不能覆盖最新记录。先在新页面核对云端；放弃修改并重新载入后才可编辑。
          </Text>
          <Group mt="sm">
            <Button component={Link} target="_blank" to={`/workouts/${id}`}>
              查看云端详情
            </Button>
            <Button
              variant="light"
              onClick={async () => {
                if (await confirmAction('丢弃本地修改并加载最新版本？')) {
                  try {
                    removeDraft(id);
                  } catch {
                    return;
                  }
                  window.location.reload();
                }
              }}
            >
              放弃本地修改并重新加载
            </Button>
          </Group>
        </Alert>
      )}
      <Paper withBorder p="md">
        <Text size="sm" role="status">
          {save.isPending
            ? '正在保存到云端…请勿关闭页面'
            : pending
              ? '请求结果待确认：已锁定提交内容，重试沿用相同幂等 key / 版本。'
              : storageError
                ? '未保障本地恢复；尚未保存到云端'
                : candidate
                  ? '等待选择草稿恢复策略'
                  : '本地自动保存 · 尚未保存到云端'}
        </Text>
      </Paper>
      <fieldset disabled={frozen} className="editor-fieldset">
        <Stack>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <DateTimePicker
              label="开始时间（所选时区）"
              withSeconds
              value={dayjs(form.values.startedAt)
                .tz(
                  form.values.timezone &&
                    (() => {
                      try {
                        new Intl.DateTimeFormat('en', {
                          timeZone: form.values.timezone,
                        });
                        return true;
                      } catch {
                        return false;
                      }
                    })()
                    ? form.values.timezone
                    : 'UTC',
                )
                .format('YYYY-MM-DD HH:mm:ss')}
              onChange={(v) => {
                if (v) {
                  try {
                    const choices = localTimeCandidates(
                      v,
                      form.values.timezone,
                    );
                    setTimeError(null);
                    setTimeChoices(choices.length > 1 ? choices : []);
                    if (choices.length === 1)
                      form.setFieldValue('startedAt', choices[0]!);
                  } catch (error) {
                    const message =
                      error instanceof Error
                        ? error.message
                        : '时间或 IANA 时区无效';
                    setTimeError(message);
                    form.setFieldError('startedAt', message);
                  }
                }
              }}
              error={timeError ?? form.errors.startedAt}
            />
            <TextInput
              label="训练 IANA 时区"
              description="修改时区保留同一瞬间，显示时间与训练本地日期随之变化。"
              {...form.getInputProps('timezone')}
            />
            <Numeric
              label="整次训练总时长（秒，可空）"
              value={form.values.durationSeconds}
              onChange={(v) => form.setFieldValue('durationSeconds', v)}
              min={1}
              integer
              error={form.errors.durationSeconds}
            />
          </SimpleGrid>
          <Textarea
            label="训练备注"
            autosize
            maxLength={LIMITS.notes}
            value={form.values.notes ?? ''}
            onChange={(e) =>
              form.setFieldValue('notes', e.currentTarget.value || null)
            }
          />
          {form.values.entries.map((entry, i) => {
            const m = info[entry.id]?.measurement;
            const path = `entries.${i}`;
            return (
              <Paper key={entry.id} withBorder p={{ base: 'sm', sm: 'lg' }}>
                <Stack>
                  <Group justify="space-between">
                    <Title order={2} size="h3">
                      {i + 1}. {info[entry.id]?.name ?? '未知动作'}
                    </Title>
                    <Group gap="xs">
                      <Button
                        variant="subtle"
                        disabled={i === 0}
                        onClick={() =>
                          form.reorderListItem('entries', {
                            from: i,
                            to: i - 1,
                          })
                        }
                      >
                        上移
                      </Button>
                      <Button
                        color="red"
                        variant="subtle"
                        onClick={async () => {
                          if (await confirmAction('移除此动作及其录入明细？'))
                            form.removeListItem('entries', i);
                        }}
                      >
                        移除动作
                      </Button>
                    </Group>
                  </Group>
                  <Text size="sm" c="dimmed">
                    {m?.loadConvention === 'per_implement'
                      ? '重量填单只器械'
                      : '重量按动作总重量口径'}{' '}
                    ·{' '}
                    {m?.repConvention === 'per_side'
                      ? '次数填每侧次数'
                      : m?.measurementMode === 'duration'
                        ? '计时模式，单位秒'
                        : '次数填总次数'}{' '}
                    ·{' '}
                    {m?.resistanceMode === 'assisted'
                      ? '记录辅助重量，不是外加重量'
                      : m?.resistanceMode === 'bodyweight'
                        ? '自重可记录额外负重，不计算总负荷容量'
                        : '外加重量须明确填写，零不等于缺失'}
                  </Text>
                  <RecentReference exerciseId={entry.exerciseId} />
                  {entry.kind === 'strength' ? (
                    <>
                      {entry.sets.map((set, j) => {
                        const sp = `${path}.sets.${j}`;
                        return (
                          <Paper withBorder p="sm" key={set.id}>
                            <Stack gap="sm">
                              <Group justify="space-between">
                                <Text fw={600}>第 {j + 1} 组</Text>
                                <Button
                                  color="red"
                                  variant="subtle"
                                  onClick={() =>
                                    form.removeListItem(`${path}.sets`, j)
                                  }
                                >
                                  移除此组
                                </Button>
                              </Group>
                              <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }}>
                                <Select
                                  label="组类型"
                                  allowDeselect={false}
                                  data={[
                                    { value: 'working', label: '正式组' },
                                    { value: 'warmup', label: '热身组' },
                                  ]}
                                  {...form.getInputProps(`${sp}.setType`)}
                                />
                                {m?.measurementMode === 'duration' ? (
                                  <Numeric
                                    label="持续时间（秒）"
                                    value={set.durationSeconds}
                                    onChange={(v) =>
                                      form.setFieldValue(
                                        `${sp}.durationSeconds`,
                                        v,
                                      )
                                    }
                                    min={1}
                                    integer
                                    error={form.errors[`${sp}.durationSeconds`]}
                                  />
                                ) : (
                                  <Numeric
                                    label={
                                      m?.repConvention === 'per_side'
                                        ? '每侧次数'
                                        : '次数'
                                    }
                                    value={set.reps}
                                    onChange={(v) =>
                                      form.setFieldValue(`${sp}.reps`, v)
                                    }
                                    min={1}
                                    integer
                                    error={form.errors[`${sp}.reps`]}
                                  />
                                )}
                                <Numeric
                                  label={
                                    m?.resistanceMode === 'assisted'
                                      ? '辅助重量（kg）'
                                      : m?.loadConvention === 'per_implement'
                                        ? '单只外加重量（kg）'
                                        : '外加重量（kg）'
                                  }
                                  error={
                                    form.errors[
                                      `${sp}.${m?.resistanceMode === 'assisted' ? 'assistanceKg' : 'loadKg'}`
                                    ]
                                  }
                                  value={
                                    m?.resistanceMode === 'assisted'
                                      ? set.assistanceKg
                                      : set.loadKg
                                  }
                                  onChange={(v) =>
                                    form.setFieldValue(
                                      `${sp}.${m?.resistanceMode === 'assisted' ? 'assistanceKg' : 'loadKg'}`,
                                      v,
                                    )
                                  }
                                />
                                <Select
                                  label="主观强度类型（可空）"
                                  clearable
                                  data={['rpe', 'rir']}
                                  value={set.effortType}
                                  onChange={(v) => {
                                    form.setFieldValue(`${sp}.effortType`, v);
                                    form.setFieldValue(
                                      `${sp}.effortValue`,
                                      null,
                                    );
                                  }}
                                />
                                {set.effortType && (
                                  <Numeric
                                    label={
                                      set.effortType === 'rpe'
                                        ? 'RPE（1–10，半级）'
                                        : 'RIR（0–10，整数）'
                                    }
                                    value={set.effortValue}
                                    onChange={(v) =>
                                      form.setFieldValue(`${sp}.effortValue`, v)
                                    }
                                    error={form.errors[`${sp}.effortValue`]}
                                  />
                                )}
                              </SimpleGrid>
                              <Textarea
                                label="组备注"
                                value={set.notes ?? ''}
                                onChange={(e) =>
                                  form.setFieldValue(
                                    `${sp}.notes`,
                                    e.currentTarget.value || null,
                                  )
                                }
                                maxLength={LIMITS.notes}
                              />
                              <Checkbox
                                label={`第 ${j + 1} 组已完成`}
                                checked={set.completed}
                                onChange={(e) =>
                                  form.setFieldValue(
                                    `${sp}.completed`,
                                    e.currentTarget.checked,
                                  )
                                }
                                error={form.errors[`${sp}.completed`]}
                              />
                            </Stack>
                          </Paper>
                        );
                      })}
                      <Group>
                        <Button
                          variant="light"
                          disabled={entry.sets.length >= LIMITS.setsPerEntry}
                          onClick={() =>
                            form.insertListItem(`${path}.sets`, emptySet())
                          }
                        >
                          添加空白组
                        </Button>
                        <Button
                          variant="light"
                          disabled={
                            !entry.sets.length ||
                            entry.sets.length >= LIMITS.setsPerEntry
                          }
                          onClick={() =>
                            form.insertListItem(
                              `${path}.sets`,
                              copySet(entry.sets.at(-1)!),
                            )
                          }
                        >
                          复制上一组（未完成）
                        </Button>
                      </Group>
                    </>
                  ) : (
                    <>
                      <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }}>
                        <Numeric
                          label="有氧时长（秒）"
                          value={entry.cardio.durationSeconds}
                          onChange={(v) =>
                            form.setFieldValue(
                              `${path}.cardio.durationSeconds`,
                              v,
                            )
                          }
                          min={1}
                          integer
                          error={form.errors[`${path}.cardio.durationSeconds`]}
                        />
                        <Select
                          label="时长口径"
                          allowDeselect={false}
                          data={[
                            { value: 'elapsed', label: '总经过时间（含停顿）' },
                            { value: 'moving', label: '移动时间（不含停顿）' },
                          ]}
                          {...form.getInputProps(
                            `${path}.cardio.durationBasis`,
                          )}
                        />
                        {(
                          [
                            'distanceMeters',
                            'averageHeartRate',
                            'maxHeartRate',
                            'elevationGainMeters',
                            'inclinePercent',
                            'resistanceLevel',
                            'deviceCaloriesKcal',
                          ] as const
                        ).map((field, n) => (
                          <Numeric
                            key={field}
                            label={
                              [
                                '距离（米，可空）',
                                '平均心率（bpm）',
                                '最大心率（bpm）',
                                '爬升（米）',
                                '坡度（%）',
                                '器械阻力级别',
                                '设备热量估计（kcal）',
                              ][n]!
                            }
                            value={entry.cardio[field]}
                            onChange={(v) =>
                              form.setFieldValue(`${path}.cardio.${field}`, v)
                            }
                            min={
                              field === 'inclinePercent'
                                ? -100
                                : field.includes('HeartRate')
                                  ? 1
                                  : 0
                            }
                            integer={field.includes('HeartRate')}
                            error={form.errors[`${path}.cardio.${field}`]}
                          />
                        ))}
                      </SimpleGrid>
                      <Checkbox
                        label="有氧条目已完成"
                        error={form.errors[`${path}.cardio.completed`]}
                        checked={entry.cardio.completed}
                        onChange={(e) =>
                          form.setFieldValue(
                            `${path}.cardio.completed`,
                            e.currentTarget.checked,
                          )
                        }
                      />
                    </>
                  )}
                  <Textarea
                    label="动作备注"
                    value={entry.notes ?? ''}
                    onChange={(e) =>
                      form.setFieldValue(
                        `${path}.notes`,
                        e.currentTarget.value || null,
                      )
                    }
                    maxLength={LIMITS.notes}
                  />
                </Stack>
              </Paper>
            );
          })}
          <Button
            variant="light"
            disabled={form.values.entries.length >= LIMITS.entries}
            onClick={() => setPicker(true)}
          >
            添加力量 / 有氧动作
          </Button>
        </Stack>
      </fieldset>
      {validation.length > 0 && (
        <Alert
          color="red"
          title="请修正后再保存"
          tabIndex={-1}
          data-validation-summary
          role="alert"
        >
          {validation.map((message, i) => (
            <Text size="sm" key={i}>
              {message}
            </Text>
          ))}
        </Alert>
      )}
      <ErrorNotice error={save.error} />
      {pending && !save.isPending && !conflict && (
        <Alert color="orange" title="提交结果待确认">
          <Text>
            优先重试原请求。网络结果不明时不要改正文或生成新
            key，以免重复训练。若服务明确拒绝（422/409/404），可解除锁定修改；已成功保存但响应丢失时应先重试或查询历史。
          </Text>
          {save.error instanceof ApiError &&
            [422, 400, 409, 404, 413].includes(save.error.status) && (
              <Button
                mt="sm"
                variant="light"
                onClick={() => {
                  setPending(null);
                  save.reset();
                }}
              >
                服务已拒绝，继续修改（保留创建 key）
              </Button>
            )}
        </Alert>
      )}
      <Paper withBorder p="md" className="save-bar">
        <Group>
          <Button
            variant="light"
            loading={save.isPending}
            disabled={!!candidate || !!conflict}
            onClick={() => submit('draft')}
          >
            {pending ? '重试原提交' : '保存云端草稿'}
          </Button>
          {!pending && (
            <Button
              loading={save.isPending}
              disabled={!!candidate || !!conflict}
              onClick={() => submit('completed')}
            >
              完成并保存训练
            </Button>
          )}
        </Group>
        <Text size="xs" c="dimmed" mt="xs">
          完成前需逐组、逐条确认，未完成条目不会自动记为成绩。
        </Text>
      </Paper>
      <Modal
        opened={picker}
        onClose={() => setPicker(false)}
        title="添加动作"
        size="lg"
      >
        <ExerciseLibrary onPick={add} />
      </Modal>
    </Stack>
  );
}
