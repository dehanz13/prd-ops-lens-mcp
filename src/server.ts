import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AuditLog } from './core/audit.js';
import { auditedInput, runValidatedTool } from './core/audited-input.js';
import { SERVER_NAME, type Config } from './core/config.js';
import { Redactor } from './core/redaction.js';
import { examined, ToolResultSchema } from './core/result.js';
import { ProviderLimiter, UNTRUSTED_DATA_NOTICE } from './core/tool.js';
import type { ProviderModule } from './providers/provider.js';

export function createServer(config: Config, providers: ProviderModule[] = []): McpServer {
  const redactor = new Redactor(config.redaction);
  const audit = new AuditLog(config.audit.path, redactor);
  const limiter = new ProviderLimiter(config.limits.maxConcurrentProviderCalls);
  const runtime = { audit, redactor, limiter, maxOutputBytes: config.limits.maxOutputBytes,
    providerWarnings: new Map<string, string>() };
  const server = new McpServer({ name: SERVER_NAME, version: '0.1.0' });

  server.registerTool('server_status', {
    title: 'Server status',
    description: `Report locally configured providers and limits without contacting them or exposing credentials. ${UNTRUSTED_DATA_NOTICE}`,
    inputSchema: auditedInput(z.object({})),
    outputSchema: ToolResultSchema,
    annotations: { readOnlyHint: true },
  }, async (parameters) => runValidatedTool(
    runtime,
    'server_status',
    'local',
    parameters,
    z.object({}),
    async () => {
      const providers = Object.entries(config.providers)
        .filter(([, value]) => value?.enabled)
        .map(([name]) => name);
      return {
        data: { name: SERVER_NAME, providers, limits: config.limits, writesEnabled: config.writes.enabled },
        examined: examined('local', 'validated startup configuration', { rowCount: providers.length }),
      };
    },
  ));

  for (const provider of providers) {
    provider.register(server, { config, runtime });
  }

  return server;
}
