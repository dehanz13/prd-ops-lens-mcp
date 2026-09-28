import { z } from 'zod';
import type { ToolResult } from './result.js';
import { OpsError } from './result.js';
import { runTool, type ToolRuntime } from './tool.js';

/** Advertise the strict schema while deferring parsing until inside the audited handler. */
export function auditedInput<T extends z.ZodType>(schema: T) {
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'prd-ops-lens-mcp',
      validate: (value: unknown) => ({ value: value as z.output<T> }),
      jsonSchema: {
        input: () => z.toJSONSchema(schema),
        output: () => z.toJSONSchema(schema),
      },
    },
  };
}

export function runValidatedTool<T extends z.ZodType>(
  runtime: ToolRuntime,
  tool: string,
  provider: string,
  raw: unknown,
  schema: T,
  handler: (input: z.output<T>) => Promise<ToolResult>,
) {
  return runTool(runtime, tool, provider, raw, async () => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new OpsError('REFUSED', `${tool}: invalid arguments`);
    return handler(parsed.data);
  });
}
