import { z } from 'zod';

export const ExaminedSchema = z.strictObject({
  provider: z.string().min(1),
  query: z.string().min(1),
  window: z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime() }),
  rowCount: z.number().int().nonnegative(),
  scannedCount: z.number().int().nonnegative(),
  byteCount: z.number().int().nonnegative().nullable(),
  lineCount: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
  warnings: z.array(z.string()),
});

export const ToolResultSchema = z.strictObject({
  data: z.unknown(),
  examined: ExaminedSchema,
  evidenceId: z.uuid().optional(),
});

export type Examined = z.output<typeof ExaminedSchema>;
export type ToolResult<T = unknown> = { data: T; examined: Examined; evidenceId?: string | undefined };

export function examined(provider: string, query: string, overrides: Partial<Examined> = {}): Examined {
  const now = new Date().toISOString();
  return ExaminedSchema.parse({
    provider,
    query,
    window: { from: now, to: now },
    rowCount: 0,
    scannedCount: overrides.rowCount ?? 0,
    byteCount: null,
    lineCount: null,
    truncated: false,
    warnings: [],
    ...overrides,
  });
}

export class OpsError extends Error {
  constructor(public readonly code: string, message: string,
    public readonly details: Partial<Examined> = {}) {
    super(message);
    this.name = 'OpsError';
  }
}
