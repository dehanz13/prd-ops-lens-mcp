import type { McpServer } from '@modelcontextprotocol/server';
import type { Config } from '../core/config.js';
import type { ToolRuntime } from '../core/tool.js';

/** A provider owns its tools; the server supplies shared validation, redaction, and audit services. */
export interface ProviderModule {
  readonly id: string;
  register(server: McpServer, context: { config: Config; runtime: ToolRuntime }): void;
}
