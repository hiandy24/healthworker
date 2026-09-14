import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { timezoneSchema, startedAtSchema, localDateSchema } from './contracts';
dayjs.extend(utc);
dayjs.extend(timezone);
export function workoutLocalDate(startedAt: string, zone: string): string {
  startedAtSchema.parse(startedAt);
  timezoneSchema.parse(zone);
  return localDateSchema.parse(
    dayjs.utc(startedAt).tz(zone).format('YYYY-MM-DD'),
  );
}
