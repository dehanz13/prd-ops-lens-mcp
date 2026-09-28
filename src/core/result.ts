import { z } from 'zod';

export const ExaminedSchema = z.strictObject({
  provider: z.string().min(1),
  query: z.string().min(1),
  window: z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime() }).nullable(),
  rowCount: z.number().int().nonnegative(),
  byteCount: z.number().int().nonnegative().nullable(),
  lineCount: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
  warnings: z.array(z.string()),
});

export const ToolResultSchema = z.strictObject({
  data: z.unknown(),
  examined: ExaminedSchema,
});

export type Examined = z.output<typeof ExaminedSchema>;
export type ToolResult<T = unknown> = { data: T; examined: Examined };

export function examined(provider: string, query: string, overrides: Partial<Examined> = {}): Examined {
  return ExaminedSchema.parse({
    provider,
    query,
    window: null,
    rowCount: 0,
    byteCount: null,
    lineCount: null,
    truncated: false,
    warnings: [],
    ...overrides,
  });
}

export class OpsError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'OpsError';
  }
}
