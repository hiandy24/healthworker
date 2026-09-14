import { z } from '@hono/zod-openapi';
import { timezoneSchema } from './contracts';
export const settingsPatchSchema = z
  .strictObject({
    timezone: timezoneSchema.optional(),
    theme: z.enum(['light', 'dark', 'auto']).optional(),
    locale: z.literal('zh-CN').optional(),
    unitSystem: z.literal('metric').optional(),
  })
  .refine((v) => Object.keys(v).length > 0, '至少提供一个设置字段');
export const settingsSchema = z.strictObject({
  id: z.literal('singleton'),
  timezone: timezoneSchema,
  locale: z.literal('zh-CN'),
  unitSystem: z.literal('metric'),
  theme: z.enum(['light', 'dark', 'auto']),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const settingsResponseSchema = z.object({
  data: settingsSchema,
  meta: z.object({ requestId: z.string() }),
});
export type Settings = z.infer<typeof settingsSchema>;
