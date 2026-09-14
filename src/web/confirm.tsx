import { Text } from '@mantine/core';
import { modals } from '@mantine/modals';
// Mantine provides focus trapping, Escape handling and focus restoration.
export function confirmAction(message: string): Promise<boolean> {
  return new Promise((resolve) =>
    modals.openConfirmModal({
      title: '请确认操作',
      children: <Text>{message}</Text>,
      labels: { confirm: '确认继续', cancel: '取消' },
      confirmProps: { color: 'red' },
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
      onClose: () => resolve(false),
    }),
  );
}
