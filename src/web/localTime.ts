import dayjs from 'dayjs';
import '../shared/dates';
// Day.js performs timezone conversion; round-trip verifies nonexistent civil times.
// Candidate offsets on either side of transition expose repeated civil times.
export function localTimeCandidates(local: string, zone: string): string[] {
  const format = 'YYYY-MM-DD HH:mm:ss';
  const normalized = dayjs(local).format(format);
  const guess = dayjs.tz(local, zone);
  if (guess.tz(zone).format(format) !== normalized)
    throw new Error('该本地时间不存在（夏令时跳时），请选择有效时间。');
  const offsets = new Set(
    [-2, -1, 0, 1, 2].map((days) =>
      guess.add(days, 'day').tz(zone).utcOffset(),
    ),
  );
  const candidates = [...offsets]
    .map((offset) => dayjs.utc(normalized).subtract(offset, 'minute'))
    .filter((value) => value.tz(zone).format(format) === normalized)
    .map((value) => value.toISOString());
  return [...new Set(candidates)].sort();
}
