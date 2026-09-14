import { infiniteQueryOptions } from '@tanstack/react-query';
import { workoutListSchema } from '../shared/workouts';
import { api } from './lib';
export function workoutHistoryQuery(
  filters: Record<string, string | null | undefined>,
) {
  return infiniteQueryOptions({
    queryKey: ['workouts', filters],
    initialPageParam: {} as { cursor?: string; from?: string; to?: string },
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams();
      for (const [key, value] of Object.entries({ ...filters, ...pageParam }))
        if (value) p.set(key, value);
      return api(`/workouts?${p}`, workoutListSchema);
    },
    getNextPageParam: (page) =>
      page.meta.nextCursor
        ? {
            cursor: page.meta.nextCursor,
            from: page.meta.from,
            to: page.meta.to,
          }
        : undefined,
  });
}
