import { useState } from 'react';
import {
  Alert,
  Button,
  Group,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
  useMantineColorScheme,
} from '@mantine/core';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  settingsResponseSchema,
  settingsPatchSchema,
  type Settings as SettingsData,
} from '../shared/settings';
import { exportQuerySchema } from '../shared/backup';
import { api, versionHeaders, clearDrafts, settingsQuery } from './lib';
import { ErrorNotice } from './ErrorNotice';
import { confirmAction } from './confirm';
export async function exportAttachment(
  format: 'json' | 'csv',
  dataset: string,
) {
  const p = exportQuerySchema.parse(
    format === 'csv' ? { format, dataset } : { format },
  );
  const response = await fetch(
    `/api/v1/export?${new URLSearchParams(p.dataset ? { format: p.format, dataset: p.dataset } : { format: p.format })}`,
    {
      credentials: 'same-origin',
      redirect: 'error',
      headers: { Accept: format === 'csv' ? 'text/csv' : 'application/json' },
    },
  );
  if (!response.ok)
    throw new Error(
      `导出失败（HTTP ${response.status}），请检查身份或稍后重试。`,
    );
  if (
    !response.headers
      .get('content-type')
      ?.includes(format === 'csv' ? 'text/csv' : 'application/json') ||
    !response.headers.get('content-disposition')?.includes('attachment')
  )
    throw new Error('导出不是预期附件，可能登录失效。未保存响应。');
  return response.blob();
}
function Form({ data }: { data: SettingsData }) {
  const [timezone, setTimezone] = useState(
      data.createdAt === '1970-01-01T00:00:00.000Z'
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : data.timezone,
    ),
    [theme, setTheme] = useState(data.theme),
    [confirmed, setConfirmed] = useState(false);
  const client = useQueryClient();
  const scheme = useMantineColorScheme();
  const mutation = useMutation({
    mutationFn: () =>
      api('/settings', settingsResponseSchema, {
        method: 'PATCH',
        headers: versionHeaders(data.version),
        body: JSON.stringify(
          settingsPatchSchema.parse({
            timezone,
            theme,
            locale: 'zh-CN',
            unitSystem: 'metric',
          }),
        ),
      }),
    onSuccess: async () => {
      scheme.setColorScheme(theme);
      setConfirmed(true);
      await client.invalidateQueries({ queryKey: ['settings'] });
    },
  });
  return (
    <Paper withBorder p="lg">
      <Stack>
        <Text>
          请确认默认 IANA 时区。修改只影响新训练，不改变历史训练日期。当前版本{' '}
          {data.version}。
        </Text>
        <TextInput
          label="默认 IANA 时区"
          value={timezone}
          onChange={(e) => setTimezone(e.currentTarget.value)}
        />
        <Button
          variant="subtle"
          onClick={() =>
            setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone)
          }
        >
          使用浏览器时区（仍需保存确认）
        </Button>
        <Select
          label="云端主题"
          value={theme}
          allowDeselect={false}
          data={[
            { value: 'light', label: '浅色' },
            { value: 'dark', label: '深色' },
            { value: 'auto', label: '跟随系统' },
          ]}
          onChange={(v) => {
            if (v === 'light' || v === 'dark' || v === 'auto') setTheme(v);
          }}
        />
        <Text>语言：简体中文 · 公制：kg / m / s</Text>
        <ErrorNotice error={mutation.error} />
        <Button loading={mutation.isPending} onClick={() => mutation.mutate()}>
          确认并保存默认设置
        </Button>
        {confirmed && <Text role="status">设置已保存到云端</Text>}
      </Stack>
    </Paper>
  );
}
export function Settings() {
  const query = useQuery(settingsQuery);
  const [dataset, setDataset] = useState('workouts'),
    [error, setError] = useState<Error | null>(null),
    [busy, setBusy] = useState(false);
  const client = useQueryClient();
  const download = async (format: 'json' | 'csv') => {
    setBusy(true);
    setError(null);
    try {
      const blob = await exportAttachment(format, dataset);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `healthworker-${format === 'csv' ? dataset : 'backup'}.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e : new Error('导出失败'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack>
      <Title order={1}>设置与数据</Title>
      {query.isPending && <Text role="status">正在加载设置…</Text>}
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      {query.data && (
        <Form key={query.data.data.version} data={query.data.data} />
      )}
      <Alert title="仅人类管理入口">
        完整 JSON
        包含训练备注和归档动作，属于敏感个人数据。下载保存在你的设备，不上传外部服务。Agent
        无设置或导出权限。
      </Alert>
      <Select
        label="CSV 数据集"
        allowDeselect={false}
        value={dataset}
        onChange={(v) => v && setDataset(v)}
        data={[
          { value: 'workouts', label: '训练' },
          { value: 'strengthSets', label: '力量组' },
          { value: 'cardioRecords', label: '有氧记录' },
        ]}
      />
      <Group>
        <Button loading={busy} onClick={() => void download('json')}>
          下载完整 JSON 备份
        </Button>
        <Button
          loading={busy}
          variant="light"
          onClick={() => void download('csv')}
        >
          下载所选 CSV
        </Button>
      </Group>
      <ErrorNotice error={error} />
      <Button
        color="red"
        variant="light"
        onClick={async () => {
          if (
            await confirmAction(
              '清除所有本地编辑实例的草稿？云端数据不受影响。',
            )
          ) {
            try {
              clearDrafts();
            } catch {
              setError(new Error('清理失败'));
            }
          }
        }}
      >
        清除全部本地草稿
      </Button>
      <Button
        variant="light"
        onClick={async () => {
          if (await confirmAction('清理所有本地草稿并退出 Access？')) {
            try {
              clearDrafts();
              client.clear();
              window.location.assign('/cdn-cgi/access/logout');
            } catch {
              setError(new Error('本地清理失败，尚未退出。'));
            }
          }
        }}
      >
        清理并退出 Access
      </Button>
    </Stack>
  );
}
