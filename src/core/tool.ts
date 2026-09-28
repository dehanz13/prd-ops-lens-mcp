import type { CallToolResult } from '@modelcontextprotocol/server';
import type { AuditLog } from './audit.js';
import { Redactor } from './redaction.js';
import { examined, OpsError, ToolResultSchema, type ToolResult } from './result.js';

export type ToolRuntime = { audit: AuditLog; redactor: Redactor };

export async function runTool<T>(
  runtime: ToolRuntime,
  tool: string,
  provider: string,
  parameters: unknown,
  handler: () => Promise<ToolResult<T>>,
): Promise<CallToolResult> {
  const started = performance.now();
  let result: ToolResult<unknown>;
  let outcome: 'ok' | 'refused' | 'error' = 'ok';
  try {
    result = ToolResultSchema.parse(await handler());
  } catch (error) {
    outcome = error instanceof OpsError && error.code === 'REFUSED' ? 'refused' : 'error';
    result = {
      data: error instanceof OpsError
        ? { error: error.message, code: error.code }
        : { error: `${provider}: request failed; check configuration and permissions`, code: 'PROVIDER_ERROR' },
      examined: examined(provider, `${tool} failed`, { warnings: ['No complete result was returned'] }),
    };
  }

  const safe = runtime.redactor.value(result);
  runtime.audit.record({
    at: new Date().toISOString(),
    tool,
    parameters,
    durationMs: Math.round(performance.now() - started),
    examined: safe.examined,
    outcome,
  });
  return {
    isError: outcome !== 'ok',
    content: [{ type: 'text', text: JSON.stringify(safe) }],
    structuredContent: safe,
  };
}
