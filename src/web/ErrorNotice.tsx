import { Alert, Button, Text } from '@mantine/core';
export function ErrorNotice({
  error,
  retry,
}: {
  error: Error | null;
  retry?: () => void;
}) {
  return error ? (
    <Alert color="red" title="操作未完成" role="alert">
      <Text style={{ overflowWrap: 'anywhere' }}>{error.message}</Text>
      {retry && (
        <Button mt="sm" variant="light" color="red" onClick={retry}>
          重试
        </Button>
      )}
    </Alert>
  ) : null;
}
