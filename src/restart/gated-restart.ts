import { createHmac, randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { auditedInput } from '../core/audited-input.js';
import type { Config } from '../core/config.js';
import { examined, OpsError, ToolResultSchema, type ToolResult } from '../core/result.js';
import { runTool, UNTRUSTED_DATA_NOTICE, type ToolRuntime } from '../core/tool.js';
import type { ProviderModule } from '../providers/provider.js';
import { DockerDesktopDemoApi, type DemoRestartApi, type DemoTarget } from './demo-docker.js';

type WriteConfig = Config['writes'];
const planInput = z.strictObject({ container: z.literal('demo-api') });
const confirmInput = z.strictObject({ container: z.literal('demo-api'),
  token: z.string().min(12).max(32), reason: z.string().trim().min(10).max(500) });
type Pending = { container: 'demo-api'; hostId: string; targetId: string; nonce: string; expiresAt: number };

function present(path: string): boolean {
  try { statSync(path); return true; }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw new OpsError('REFUSED', 'Demo lock state could not be verified');
  }
}

export class RestartGate {
  private readonly signingKey = randomBytes(32);
  private readonly pending = new Map<string, Pending>();
  private readonly recent = new Map<string, number>();
  private readonly active = new Set<string>();

  constructor(private readonly config: WriteConfig, private readonly api: DemoRestartApi,
    private readonly clock: () => number = Date.now,
    private readonly selfId: string | undefined = process.env.HOSTNAME) {}

  private guard(container: string): void {
    if (!this.config.enabled || !this.config.containers.includes('demo-api') ||
      container !== 'demo-api') throw new OpsError('REFUSED', 'Demo restart target is not allowlisted');
    if (!this.config.killSwitchFile || !this.config.deployLockFile ||
      present(this.config.killSwitchFile) || present(this.config.deployLockFile)) {
      throw new OpsError('REFUSED', 'Demo restart is disabled by a kill switch or deploy lock');
    }
  }

  private async target(container: string): Promise<{ hostId: string; target: DemoTarget }> {
    this.guard(container);
    const hostId = await this.api.identity();
    if (hostId !== this.config.expectedDaemonId) throw new OpsError('REFUSED', 'Local demo host changed');
    const target = await this.api.inspect();
    if (this.selfId && (target.id === this.selfId || target.id.startsWith(this.selfId) ||
      this.selfId === 'ops-lens-demo-demo-api-1')) {
      throw new OpsError('REFUSED', 'The MCP host process cannot be restarted');
    }
    const remembered = this.recent.get(target.id);
    const started = target.lastStartedAt ? Date.parse(target.lastStartedAt) : NaN;
    if (!Number.isFinite(started)) {
      throw new OpsError('REFUSED', 'Demo container start time could not be verified');
    }
    if (Math.max(remembered ?? 0, started) > this.clock() - 600_000) {
      throw new OpsError('REFUSED', 'Demo container restart cooldown is active');
    }
    return { hostId, target };
  }

  async plan(container: 'demo-api'): Promise<ToolResult> {
    const { hostId, target } = await this.target(container);
    const currentHealth = await this.api.health();
    for (const [key, value] of this.pending) {
      if (value.expiresAt <= this.clock()) this.pending.delete(key);
    }
    if (this.pending.size >= 32) throw new OpsError('QUERY_LIMIT', 'Too many pending demo restart plans');
    const nonce = randomBytes(12).toString('base64url');
    const expiresAt = this.clock() + 120_000;
    const token = this.token(hostId, target.id, nonce, expiresAt);
    this.pending.set(token, { container, hostId, targetId: target.id,
      nonce, expiresAt });
    return { data: { container, host: 'local-demo', currentHealth,
      lastStartedAt: target.lastStartedAt, lastRestartAt: target.restartCount > 0
        ? target.lastStartedAt : null,
      confirmation: token, expiresAt: new Date(expiresAt).toISOString() },
    examined: examined('demo-restart', 'Plan one allowlisted local demo restart', { rowCount: 1,
      scannedCount: 1 }) };
  }

  async confirm(input: z.output<typeof confirmInput>): Promise<ToolResult> {
    const pending = this.pending.get(input.token);
    this.pending.delete(input.token);
    if (!pending || pending.expiresAt <= this.clock() || pending.container !== input.container ||
      this.token(pending.hostId, pending.targetId, pending.nonce, pending.expiresAt) !== input.token) {
      throw new OpsError('REFUSED', 'Confirmation token is invalid or expired');
    }
    if (this.active.has(input.container)) throw new OpsError('REFUSED', 'Demo restart is already in progress');
    this.active.add(input.container);
    try {
      const { hostId, target } = await this.target(input.container);
      if (hostId !== pending.hostId || target.id !== pending.targetId) {
        throw new OpsError('REFUSED', 'Confirmation target or host changed');
      }
      const before = await this.api.health();
      this.guard(input.container);
      try {
        await this.api.restart(target.id);
        this.recent.set(target.id, this.clock());
        if (await this.api.identity() !== hostId) {
          throw new OpsError('REFUSED', 'Local demo host changed after restart');
        }
        const afterTarget = await this.api.inspect();
        if (afterTarget.id !== target.id || afterTarget.lastStartedAt === target.lastStartedAt) {
          throw new OpsError('REFUSED', 'Demo restart completion could not be verified');
        }
        let after = await this.api.health();
        for (let attempt = 0; after !== 'healthy' && attempt < 30; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          after = await this.api.health();
        }
        return { data: { container: input.container, host: 'local-demo',
          beforeHealth: before, afterHealth: after,
          reasonLength: input.reason.length, restartedAt: afterTarget.lastStartedAt },
        examined: examined('demo-restart', 'Restart one allowlisted local demo container', {
          rowCount: 1, scannedCount: 1, warnings: after === 'healthy' ? [] :
            ['Demo health did not recover within the post-restart check window'],
        }) };
      } catch {
        throw new OpsError('UPSTREAM', 'Demo restart outcome could not be verified', {
          warnings: [`Before health: ${before}; after health: unknown`],
        });
      }
    } finally { this.active.delete(input.container); }
  }

  private token(hostId: string, targetId: string, nonce: string, expiresAt: number): string {
    return createHmac('sha256', this.signingKey)
      .update(JSON.stringify([hostId, targetId, nonce, expiresAt]))
      .digest('base64url').slice(0, 24);
  }
}

export class DemoRestartProvider implements ProviderModule {
  readonly id = 'demo-restart';
  private gate: RestartGate | undefined;
  private preflightCompleted = false;
  constructor(private readonly api?: DemoRestartApi, private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly clock: () => number = Date.now, private readonly selfId?: string) {}

  async preflight(config: Config): Promise<void> {
    this.gate = undefined;
    this.preflightCompleted = false;
    const writes = config.writes;
    if (!writes.enabled) { this.preflightCompleted = true; return; }
    if (this.env.OPS_LENS_ENABLE_WRITES !== '1' || writes.containers.length !== 1 ||
      writes.containers[0] !== 'demo-api' || !writes.dockerSocket ||
      !writes.expectedDaemonId || !writes.killSwitchFile || !writes.deployLockFile) {
      throw new OpsError('REFUSED', 'Demo write prerequisites are incomplete');
    }
    if (present(writes.killSwitchFile) || present(writes.deployLockFile)) {
      this.preflightCompleted = true;
      return;
    }
    const api = this.api ?? new DockerDesktopDemoApi(writes.dockerSocket);
    if (await api.identity() !== writes.expectedDaemonId) {
      throw new OpsError('REFUSED', 'Local demo host could not be verified');
    }
    this.gate = new RestartGate(writes, api, this.clock, this.selfId);
    this.preflightCompleted = true;
  }

  register(server: McpServer, context: { config: Config; runtime: ToolRuntime }): void {
    if (!context.config.writes.enabled) return;
    if (!this.preflightCompleted) throw new OpsError('REFUSED', 'Demo restart preflight was not completed');
    if (!this.gate) return;
    const gate = this.gate;
    server.registerTool('plan_restart', { description: `Plan one local demo API restart and return a two-minute confirmation. ${UNTRUSTED_DATA_NOTICE}`,
      inputSchema: auditedInput(planInput), outputSchema: ToolResultSchema,
      annotations: { readOnlyHint: true },
    }, async (raw) => runTool(context.runtime, 'plan_restart', this.id,
      { container: raw && typeof raw === 'object' && 'container' in raw && raw.container === 'demo-api'
        ? 'demo-api' : '[UNVALIDATED]' },
      async () => { const parsed = planInput.safeParse(raw);
        if (!parsed.success) throw new OpsError('REFUSED', 'Invalid demo plan arguments');
        return gate.plan(parsed.data.container); }));
    server.registerTool('restart_container', { description: `Confirm one allowlisted local demo API restart. ${UNTRUSTED_DATA_NOTICE}`,
      inputSchema: auditedInput(confirmInput), outputSchema: ToolResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true },
    }, async (raw) => runTool(context.runtime, 'restart_container', this.id,
      { container: raw && typeof raw === 'object' && 'container' in raw && raw.container === 'demo-api'
        ? 'demo-api' : '[UNVALIDATED]', token: '[REDACTED]',
      reasonLength: raw && typeof raw === 'object' && 'reason' in raw &&
        typeof raw.reason === 'string' ? raw.reason.length : 0 },
      async () => { const parsed = confirmInput.safeParse(raw);
        if (!parsed.success) throw new OpsError('REFUSED', 'Invalid demo confirmation arguments');
        return gate.confirm(parsed.data); }));
  }
}
