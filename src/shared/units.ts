import { kgSchema } from './contracts';
export function kgToGrams(value: number | null): number | null {
  return value === null ? null : Math.round(kgSchema.parse(value) * 1000);
}
export function gramsToKg(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError('Invalid grams');
  return value / 1000;
}
