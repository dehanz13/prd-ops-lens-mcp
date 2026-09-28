import { Agent, request } from 'node:http';
import { lstatSync, type Stats } from 'node:fs';
import { Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OpsError } from '../core/result.js';

export type DemoTarget = { id: string; lastStartedAt: string | null; restartCount: number };
export interface DemoRestartApi {
  identity(): Promise<string>;
  inspect(): Promise<DemoTarget>;
  health(): Promise<'healthy' | 'unhealthy' | 'unknown'>;
  restart(id: string): Promise<void>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OpsError('REFUSED', 'Local Docker response was malformed');
  }
  return value as Record<string, unknown>;
}

/** Validate the daemon payload before a restart ID can reach the POST route. */
export function parseDemoTarget(value: unknown): DemoTarget {
  const result = object(value);
  const config = object(result.Config);
  const labels = object(config.Labels);
  const state = object(result.State);
  if (result.Name !== '/ops-lens-demo-demo-api-1' ||
    labels['com.docker.compose.project'] !== 'ops-lens-demo' ||
    labels['com.docker.compose.service'] !== 'demo-api' ||
    state.Running !== true || typeof result.Id !== 'string' ||
    !/^[a-f0-9]{64}$/.test(result.Id)) {
    throw new OpsError('REFUSED', 'Target is not the running local demo API container');
  }
  return { id: result.Id,
    lastStartedAt: typeof state.StartedAt === 'string' && Number.isFinite(Date.parse(state.StartedAt))
      ? new Date(state.StartedAt).toISOString() : null,
    restartCount: typeof result.RestartCount === 'number' && Number.isSafeInteger(result.RestartCount)
      ? result.RestartCount : 0 };
}

export function verifyDemoDockerSocket(socket: string, stat: Stats): void {
  if (socket !== join(homedir(), '.docker/run/docker.sock') || !stat.isSocket() ||
    stat.isSymbolicLink() || stat.uid !== process.getuid?.()) {
    throw new OpsError('REFUSED', 'Local Docker Desktop socket could not be verified');
  }
}

export function parseDemoDockerIdentity(value: unknown): string {
  const info = object(value);
  if (info.Name !== 'docker-desktop' || info.OperatingSystem !== 'Docker Desktop' ||
    typeof info.ID !== 'string' || info.ID.length < 8) {
    throw new OpsError('REFUSED', 'Docker daemon is not the verified local demo host');
  }
  return info.ID;
}

/** A fixed Docker Desktop socket and fixed demo API paths; no CLI or remote host. */
export class DockerDesktopDemoApi implements DemoRestartApi {
  private readonly socketIdentity: { dev: number; ino: number };
  private readonly agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  private pendingCall: Promise<void> = Promise.resolve();
  private allowNewConnection = false;

  constructor(private readonly socket: string) {
    if (socket !== join(homedir(), '.docker/run/docker.sock')) {
      throw new OpsError('REFUSED', 'Demo writes require the local Docker Desktop socket');
    }
    const status = lstatSync(socket);
    verifyDemoDockerSocket(socket, status);
    this.socketIdentity = { dev: status.dev, ino: status.ino };
    const createConnection = this.agent.createConnection.bind(this.agent);
    this.agent.createConnection = (options, callback) => {
      try {
        if (!this.allowNewConnection) {
          throw new OpsError('REFUSED', 'Verified local Docker connection is unavailable');
        }
        this.verifySocketIdentity();
        const connected = createConnection(options, callback);
        if (!connected) throw new OpsError('REFUSED', 'Verified local Docker connection is unavailable');
        connected.once('connect', () => {
          try { this.verifySocketIdentity(); }
          catch (error) { connected.destroy(error as Error); }
        });
        return connected;
      } catch (error) {
        const blocked = new Socket();
        process.nextTick(() => blocked.destroy(error as Error));
        return blocked;
      }
    };
  }

  private verifySocketIdentity(): void {
    let status: Stats;
    try { status = lstatSync(this.socket); }
    catch { throw new OpsError('REFUSED', 'Local Docker Desktop socket changed'); }
    verifyDemoDockerSocket(this.socket, status);
    if (status.dev !== this.socketIdentity.dev || status.ino !== this.socketIdentity.ino) {
      throw new OpsError('REFUSED', 'Local Docker Desktop socket changed');
    }
  }

  private async call(method: 'GET' | 'POST', path: string): Promise<unknown> {
    const previous = this.pendingCall;
    let release!: () => void;
    this.pendingCall = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    this.allowNewConnection = method === 'GET' && path === '/info';
    try {
      this.verifySocketIdentity();
      return await new Promise((resolve, reject) => {
        const connection = request({ socketPath: this.socket, agent: this.agent, method, path,
          headers: { Accept: 'application/json' }, timeout: 5000 }, (response) => {
          let bytes = 0;
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 1_000_000) {
              reject(new OpsError('RESPONSE_LIMIT', 'Local Docker response exceeded byte cap'));
              connection.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            if (response.statusCode !== 200 && response.statusCode !== 204) {
              reject(new OpsError('REFUSED', 'Local demo Docker operation failed')); return;
            }
            try {
              resolve(response.statusCode === 204 ? null : JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch { reject(new OpsError('REFUSED', 'Local Docker response was malformed')); }
          });
        });
        connection.on('timeout', () => connection.destroy(new OpsError('QUERY_LIMIT', 'Local Docker request timed out')));
        connection.on('error', (error) => reject(error instanceof OpsError ? error :
          new OpsError('REFUSED', 'Local Docker socket request failed')));
        connection.end();
      });
    } finally {
      this.allowNewConnection = false;
      release();
    }
  }

  async identity(): Promise<string> {
    return parseDemoDockerIdentity(await this.call('GET', '/info'));
  }

  async inspect(): Promise<DemoTarget> {
    return parseDemoTarget(await this.call('GET', '/containers/ops-lens-demo-demo-api-1/json'));
  }

  async health(): Promise<'healthy' | 'unhealthy' | 'unknown'> {
    try {
      const response = await fetch('http://127.0.0.1:8088/health', {
        redirect: 'manual', signal: AbortSignal.timeout(3000),
      });
      return response.status >= 300 && response.status < 400 ? 'unknown' :
        response.ok ? 'healthy' : 'unhealthy';
    } catch { return 'unknown'; }
  }

  async restart(id: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new OpsError('REFUSED', 'Invalid demo container ID');
    await this.call('POST', `/containers/${id}/restart?t=3`);
  }
}
