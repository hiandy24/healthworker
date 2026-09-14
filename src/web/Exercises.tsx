import { useState } from 'react';
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
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import {
  exerciseInputSchema,
  exerciseListSchema,
  exerciseResponseSchema,
  type Exercise,
  type ExerciseInput,
} from '../shared/exercises';
import { api, versionHeaders } from './lib';

export { ErrorNotice } from './ErrorNotice';
import { ErrorNotice } from './ErrorNotice';
const initialExercise: ExerciseInput = {
  name: '',
  aliases: [],
  equipment: null,
  muscleGroups: [],
  kind: 'strength',
  measurementMode: 'reps',
  resistanceMode: 'external',
  loadConvention: 'total',
  repConvention: 'total',
  volumeMultiplier: null,
  cardioCategory: null,
};
function ExerciseForm({
  existing,
  onDone,
}: {
  existing?: Exercise | undefined;
  onDone: () => void;
}) {
  const client = useQueryClient();
  const form = useForm<ExerciseInput>({
    initialValues: existing
      ? (Object.fromEntries(
          Object.keys(initialExercise).map((key) => [
            key,
            existing[key as keyof ExerciseInput],
          ]),
        ) as ExerciseInput)
      : initialExercise,
    validate: (values) => {
      const parsed = exerciseInputSchema.safeParse(values);
      return parsed.success
        ? {}
        : Object.fromEntries(
            parsed.error.issues.map((i) => [
              String(i.path[0] ?? '_form'),
              i.message,
            ]),
          );
    },
  });
  const mutation = useMutation({
    mutationFn: async (values: ExerciseInput) =>
      api(
        existing ? `/exercises/${existing.id}` : '/exercises',
        exerciseResponseSchema,
        {
          method: existing ? 'PATCH' : 'POST',
          headers: existing ? versionHeaders(existing.version) : {},
          body: JSON.stringify(
            existing
              ? {
                  name: values.name,
                  aliases: values.aliases,
                  equipment: values.equipment,
                  muscleGroups: values.muscleGroups,
                }
              : exerciseInputSchema.parse(values),
          ),
        },
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['exercises'] });
      notifications.show({
        title: '动作已保存到云端',
        message: '动作库已刷新。',
      });
      onDone();
    },
  });
  return (
    <form
      onSubmit={form.onSubmit(
        (v) => mutation.mutate(v),
        () => {
          setTimeout(
            () =>
              document
                .querySelector<HTMLElement>('[data-form-errors]')
                ?.focus(),
            0,
          );
        },
      )}
    >
      <Stack>
        {Object.keys(form.errors).length > 0 && (
          <Alert color="red" role="alert" tabIndex={-1} data-form-errors>
            {Object.entries(form.errors).map(([key, error]) => (
              <Text key={key}>
                {key}: {error}
              </Text>
            ))}
          </Alert>
        )}
        <TextInput label="动作名称" required {...form.getInputProps('name')} />
        <TextInput
          label="别名（逗号分隔）"
          error={form.errors.aliases}
          value={form.values.aliases.join(',')}
          onChange={(e) =>
            form.setFieldValue(
              'aliases',
              e.currentTarget.value ? e.currentTarget.value.split(',') : [],
            )
          }
        />
        <TextInput
          label="器械"
          {...form.getInputProps('equipment')}
          value={form.values.equipment ?? ''}
        />
        <TextInput
          label="肌群（逗号分隔）"
          error={form.errors.muscleGroups}
          value={form.values.muscleGroups.join(',')}
          onChange={(e) =>
            form.setFieldValue(
              'muscleGroups',
              e.currentTarget.value ? e.currentTarget.value.split(',') : [],
            )
          }
        />
        {existing ? (
          <Text size="sm" c="dimmed">
            计量语义不可修改；需要不同口径请创建新动作。历史快照不受名称修改影响。
          </Text>
        ) : (
          <>
            <Select
              label="动作类型"
              allowDeselect={false}
              data={[
                { value: 'strength', label: '力量' },
                { value: 'cardio', label: '有氧' },
              ]}
              value={form.values.kind}
              onChange={(v) =>
                form.setValues(
                  v === 'cardio'
                    ? {
                        kind: 'cardio',
                        measurementMode: 'cardio',
                        resistanceMode: null,
                        loadConvention: 'none',
                        repConvention: 'not_applicable',
                        volumeMultiplier: null,
                        cardioCategory: 'run',
                      }
                    : {
                        ...initialExercise,
                        name: form.values.name,
                        aliases: form.values.aliases,
                        equipment: form.values.equipment,
                        muscleGroups: form.values.muscleGroups,
                      },
                )
              }
            />
            {form.values.kind === 'strength' ? (
              <>
                <Select
                  label="计量模式"
                  allowDeselect={false}
                  data={[
                    { value: 'reps', label: '次数' },
                    { value: 'duration', label: '计时' },
                  ]}
                  value={form.values.measurementMode}
                  onChange={(v) =>
                    form.setValues({
                      measurementMode: v === 'duration' ? 'duration' : 'reps',
                      repConvention:
                        v === 'duration' ? 'not_applicable' : 'total',
                      volumeMultiplier: null,
                    })
                  }
                />
                <Select
                  label="阻力模式"
                  allowDeselect={false}
                  data={[
                    { value: 'external', label: '外加负重' },
                    { value: 'bodyweight', label: '自重（可加负重）' },
                    { value: 'assisted', label: '辅助重量' },
                  ]}
                  {...form.getInputProps('resistanceMode')}
                  onChange={(v) => {
                    if (
                      v === 'external' ||
                      v === 'bodyweight' ||
                      v === 'assisted'
                    )
                      form.setValues({
                        resistanceMode: v,
                        volumeMultiplier: null,
                      });
                  }}
                />
                <Select
                  label="重量口径"
                  allowDeselect={false}
                  data={[
                    { value: 'total', label: '总重量' },
                    { value: 'per_implement', label: '单只器械重量' },
                    { value: 'none', label: '不适用' },
                  ]}
                  {...form.getInputProps('loadConvention')}
                />
                {form.values.measurementMode === 'reps' && (
                  <Select
                    label="次数口径"
                    allowDeselect={false}
                    data={[
                      { value: 'total', label: '总次数' },
                      { value: 'per_side', label: '每侧次数' },
                    ]}
                    {...form.getInputProps('repConvention')}
                  />
                )}
                {form.values.resistanceMode === 'external' &&
                  form.values.measurementMode === 'reps' &&
                  form.values.loadConvention !== 'none' && (
                    <NumberInput
                      label="容量倍率（仅口径明确时填写）"
                      description="留空表示不计算容量，前端不猜测倍率。"
                      min={0.001}
                      value={form.values.volumeMultiplier ?? ''}
                      onChange={(v) =>
                        form.setFieldValue(
                          'volumeMultiplier',
                          typeof v === 'number' ? v : null,
                        )
                      }
                      error={form.errors.volumeMultiplier}
                    />
                  )}
              </>
            ) : (
              <Select
                label="有氧项目"
                allowDeselect={false}
                data={[
                  'run',
                  'walk',
                  'cycle',
                  'swim',
                  'row',
                  'elliptical',
                  'other',
                ].map((value, i) => ({
                  value,
                  label: [
                    '跑步',
                    '步行',
                    '骑行',
                    '游泳',
                    '划船',
                    '椭圆机',
                    '其他',
                  ][i]!,
                }))}
                {...form.getInputProps('cardioCategory')}
              />
            )}
          </>
        )}
        {form.errors.measurementMode && (
          <Alert color="red">{form.errors.measurementMode}</Alert>
        )}
        <ErrorNotice error={mutation.error} />
        <Button type="submit" loading={mutation.isPending}>
          保存动作
        </Button>
      </Stack>
    </form>
  );
}
export function ExerciseLibrary({
  onPick,
  onlyKind,
}: {
  onPick?: (exercise: Exercise) => void;
  onlyKind?: 'strength' | 'cardio';
}) {
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<string | null>(onlyKind ?? null);
  const [archived, setArchived] = useState(false);
  const [edit, setEdit] = useState<Exercise | 'new' | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Exercise | null>(null);
  const client = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: ['exercises', search, kind, archived && !onPick],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        query: search,
        includeArchived: String(archived && !onPick),
        limit: '25',
      });
      if (kind) params.set('kind', kind);
      if (pageParam) params.set('cursor', pageParam);
      return api(`/exercises?${params}`, exerciseListSchema);
    },
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
  });
  const archive = useMutation({
    mutationFn: (exercise: Exercise) =>
      api(`/exercises/${exercise.id}`, exerciseResponseSchema, {
        method: 'PATCH',
        headers: versionHeaders(exercise.version),
        body: JSON.stringify({ archived: !exercise.archivedAt }),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['exercises'] });
      setArchiveTarget(null);
    },
  });
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={onPick ? 2 : 1}>{onPick ? '选择动作' : '动作库'}</Title>
        <Button onClick={() => setEdit('new')}>创建动作</Button>
      </Group>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput
          label="搜索动作或别名"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
        <Select
          label="类型"
          disabled={!!onlyKind}
          clearable
          placeholder="全部类型"
          data={[
            { value: 'strength', label: '力量' },
            { value: 'cardio', label: '有氧' },
          ]}
          value={kind}
          onChange={setKind}
        />
      </SimpleGrid>
      {!onPick && (
        <Checkbox
          label="包含已归档动作"
          checked={archived}
          onChange={(e) => setArchived(e.currentTarget.checked)}
        />
      )}
      {query.isPending && <Text role="status">正在加载动作…</Text>}
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      {query.data?.pages[0]!.data.length === 0 && (
        <Text>没有匹配动作，可以创建自定义动作。</Text>
      )}
      {query.data?.pages
        .flatMap((page) => page.data)
        .map((exercise) => (
          <Paper key={exercise.id} withBorder p="md">
            <Stack gap="xs">
              <Group justify="space-between">
                <Text fw={600}>{exercise.name}</Text>
                <Badge>
                  {exercise.archivedAt
                    ? '已归档'
                    : exercise.kind === 'strength'
                      ? '力量'
                      : '有氧'}
                </Badge>
              </Group>
              <Text size="sm" c="dimmed">
                {exercise.equipment ?? '未记录器械'} ·{' '}
                {exercise.kind === 'cardio'
                  ? exercise.cardioCategory
                  : `${exercise.measurementMode === 'reps' ? '次数' : '计时'} / ${exercise.resistanceMode === 'assisted' ? '辅助' : exercise.resistanceMode === 'bodyweight' ? '自重' : '外加负重'}`}
              </Text>
              <Group>
                {onPick ? (
                  <Button
                    onClick={() => onPick(exercise)}
                    disabled={!!exercise.archivedAt}
                  >
                    添加 {exercise.name}
                  </Button>
                ) : (
                  <>
                    <Button variant="light" onClick={() => setEdit(exercise)}>
                      编辑展示信息
                    </Button>
                    <Button
                      variant="subtle"
                      color={exercise.archivedAt ? 'teal' : 'red'}
                      onClick={() => {
                        archive.reset();
                        setArchiveTarget(exercise);
                      }}
                    >
                      {exercise.archivedAt ? '恢复动作' : '归档动作'}
                    </Button>
                  </>
                )}
              </Group>
            </Stack>
          </Paper>
        ))}
      {query.hasNextPage && (
        <Button
          variant="light"
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          加载更多动作
        </Button>
      )}
      <Modal
        opened={edit !== null}
        onClose={() => setEdit(null)}
        title={edit === 'new' ? '创建动作' : '编辑动作'}
        size="lg"
      >
        {edit && (
          <ExerciseForm
            existing={edit === 'new' ? undefined : edit}
            onDone={() => setEdit(null)}
          />
        )}
      </Modal>
      <Modal
        opened={!!archiveTarget}
        onClose={() => setArchiveTarget(null)}
        title="确认动作状态变更"
      >
        {archiveTarget && (
          <Stack>
            <Text>
              {archiveTarget.archivedAt
                ? '恢复后可再次用于新训练。'
                : '归档后不能新增引用；已有历史记录仍保留。'}{' '}
              {archiveTarget.name}
            </Text>
            <ErrorNotice error={archive.error} />
            <Button
              color="red"
              loading={archive.isPending}
              onClick={() => archive.mutate(archiveTarget)}
            >
              确认{archiveTarget.archivedAt ? '恢复' : '归档'}
            </Button>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
