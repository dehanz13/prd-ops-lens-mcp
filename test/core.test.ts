import { chmodSync, linkSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/core/audit.js';
import { ConfigSchema, loadConfig, providerToken, providerTokenFile } from '../src/core/config.js';
import { Redactor } from '../src/core/redaction.js';
import { examined, OpsError } from '../src/core/result.js';
import { runTool } from '../src/core/tool.js';

const dirs: string[] = [];
function temporaryFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ops-lens-test-'));
  dirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const redactionConfig = {
  identityKeys: ['playerId'],
  identityLabels: ['room', 'player'],
  identityValues: [],
  awsIdentifiers: true,
};

describe('configuration', () => {
  it('loads a minimal config and applies conservative defaults', () => {
    const file = temporaryFile('config.yaml');
    writeFileSync(file, `version: 1\naudit:\n  path: ${temporaryFile('audit.jsonl')}\n`);
    const config = loadConfig(file);
    expect(config.limits).toEqual({ maxWindowMinutes: 60, maxRows: 1000, maxOutputBytes: 65_536,
      maxConcurrentProviderCalls: 2, maxResponseBytes: 2_000_000,
      maxLokiScanBytes: 5_000_000, timeoutMs: 20000 });
    expect(config.writes).toEqual({ enabled: false, demoOnly: true, containers: [] });
  });

  it('rejects an unknown key and non-loopback HTTP provider', () => {
    const base = { version: 1, audit: { path: temporaryFile('audit.jsonl') } };
    expect(() => ConfigSchema.parse({ ...base, typo: true })).toThrow();
    expect(() => ConfigSchema.parse({ ...base, providers: {
      grafana: { enabled: true, baseUrl: 'http://example.invalid', tokenEnv: 'TOKEN' },
    } })).toThrow();
  });

  it('rejects duplicate YAML keys and write enablement without the startup flag', () => {
    const file = temporaryFile('config.yaml');
    writeFileSync(file, `version: 1\nversion: 1\naudit: {path: /tmp/audit.jsonl}\n`);
    expect(() => loadConfig(file)).toThrow('Configuration YAML is invalid');
    writeFileSync(file, `version: 1\naudit: {path: /tmp/audit.jsonl}\nwrites: {enabled: true}\n`);
    expect(() => loadConfig(file, {})).toThrow('OPS_LENS_ENABLE_WRITES');
    expect(loadConfig(file, { OPS_LENS_ENABLE_WRITES: '1' }).writes.enabled).toBe(true);
  });

  it('reads a token only from its named environment variable', () => {
    expect(providerToken('TOKEN', { TOKEN: 'private' })).toBe('private');
    expect(() => providerToken('TOKEN', {})).toThrow('Missing provider token');
  });

  it('accepts a private token file and rejects a world-readable one', () => {
    const path = temporaryFile('viewer.token');
    writeFileSync(path, 'synthetic-token\n', { mode: 0o600 });
    expect(providerTokenFile(path)).toBe('synthetic-token');
    expect(() => ConfigSchema.parse({ version: 1, audit: { path: temporaryFile('audit') },
      providers: { grafana: { enabled: true, baseUrl: 'https://example.invalid',
        tokenFile: path, tokenEnv: 'TOKEN', prometheusUid: 'prom', lokiUid: 'loki' } },
    })).toThrow();
    chmodSync(path, 0o644);
    expect(() => providerTokenFile(path)).toThrow('owner-only');
  });

  it('refuses a credential symlink even when its target is owner-only', () => {
    const target = temporaryFile('target.token');
    const link = temporaryFile('link.token');
    writeFileSync(target, 'synthetic-token', { mode: 0o600 });
    symlinkSync(target, link);
    expect(() => providerTokenFile(link)).toThrow('owner-only');
  });
});

describe('redaction and audit', () => {
  it('masks identities inside composite strings and nested fields', () => {
    const redactor = new Redactor(redactionConfig);
    const result = redactor.value({
      playerId: 'a-private-id',
      nested: { value: 'room:1234:player:abcd hello@invalid.test 192.0.2.10 Bearer a-secret' },
      token: 'another-secret',
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('1234');
    expect(serialized).not.toContain('abcd');
    expect(serialized).not.toContain('hello@invalid.test');
    expect(serialized).not.toContain('192.0.2.10');
    expect(serialized).not.toContain('a-secret');
    expect(serialized).not.toContain('another-secret');
    expect(serialized).toContain('room:[REDACTED]:player:[REDACTED]');
  });

  it('preserves a clock value while masking real IPv6 addresses', () => {
    const redactor = new Redactor(redactionConfig);
    expect(redactor.text('12:30:45,123')).toBe('12:30:45,123');
    expect(redactor.text('address 2001:db8::1')).not.toContain('2001:db8::1');
  });

  it('writes one private JSON line with redacted parameters', () => {
    const path = temporaryFile('audit.jsonl');
    const log = new AuditLog(path, new Redactor(redactionConfig));
    log.record({
      at: '2026-01-01T00:00:00.000Z', tool: 'test',
      parameters: { q: 'player:abc' }, durationMs: 1,
      examined: examined('local', 'one row', { rowCount: 1 }), outcome: 'ok',
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const line = readFileSync(path, 'utf8').trim();
    expect(line).not.toContain('player:abc');
    expect(JSON.parse(line).examined.rowCount).toBe(1);
  });

  // @guardrail G0.11: the audit file cannot be protected inside a shared directory.
  it('refuses a shared or symlinked audit directory and directory replacement', () => {
    const path = temporaryFile('audit.jsonl');
    const directory = join(path, '..');
    chmodSync(directory, 0o777);
    expect(() => new AuditLog(path, new Redactor(redactionConfig)))
      .toThrow('Audit directory must be an owner-only');
    chmodSync(directory, 0o700);
    const symlink = temporaryFile('audit-link');
    symlinkSync(directory, symlink);
    expect(() => new AuditLog(join(symlink, 'audit.jsonl'), new Redactor(redactionConfig)))
      .toThrow('Audit directory must be an owner-only');
    const log = new AuditLog(path, new Redactor(redactionConfig));
    const moved = `${directory}-moved`;
    renameSync(directory, moved);
    dirs.push(moved);
    expect(() => log.assertReady()).toThrow('Audit directory');
  });

  // @guardrail G0.11: a later audit append stays bound to its verified inode.
  it('refuses an audit file replacement or hard link before appending', () => {
    const path = temporaryFile('audit.jsonl');
    const log = new AuditLog(path, new Redactor(redactionConfig));
    renameSync(path, `${path}.original`);
    writeFileSync(path, 'replacement\n', { mode: 0o600 });
    const entry = { at: '2026-01-01T00:00:00.000Z', tool: 'test', parameters: {},
      durationMs: 1, examined: null, outcome: 'ok' as const };
    expect(() => log.record(entry)).toThrow('original owner-only');
    expect(readFileSync(path, 'utf8')).toBe('replacement\n');
    const linked = temporaryFile('linked-audit.jsonl');
    linkSync(path, linked);
    expect(() => new AuditLog(linked, new Redactor(redactionConfig))).toThrow('owner-only');
  });
});

describe('tool envelope', () => {
  it('refuses oversized input and omits large parameters from the audit', async () => {
    const path = temporaryFile('audit.jsonl');
    const redactor = new Redactor(redactionConfig);
    let called = false;
    const result = await runTool({ audit: new AuditLog(path, redactor), redactor },
      'query', 'fake', { query: 'x'.repeat(270_000) }, async () => {
        called = true;
        return { data: [], examined: examined('fake', 'should not run') };
      });
    expect(called).toBe(false);
    expect(result.structuredContent).toMatchObject({ data: { code: 'QUERY_LIMIT' } });
    const audit = readFileSync(path, 'utf8');
    expect(audit.length).toBeLessThan(1500);
    expect(audit).toContain('Input exceeded the audit parameter cap');
  });
  it('returns examined context even for zero results', async () => {
    const path = temporaryFile('audit.jsonl');
    const redactor = new Redactor(redactionConfig);
    const result = await runTool({ audit: new AuditLog(path, redactor), redactor },
      'count', 'fake', {}, async () => ({ data: { count: 0 }, examined: examined('fake', 'errors in 1h') }));
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ data: { count: 0 }, examined: { rowCount: 0, query: 'errors in 1h' } });
  });

  it('records refusals without exposing a stack trace', async () => {
    const path = temporaryFile('audit.jsonl');
    const redactor = new Redactor(redactionConfig);
    const result = await runTool({ audit: new AuditLog(path, redactor), redactor },
      'restart_container', 'demo', { reason: 'room:1234' }, async () => {
        throw new OpsError('REFUSED', 'Container is not allowlisted');
      });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ data: { code: 'REFUSED' }, examined: { provider: 'demo' } });
    expect(readFileSync(path, 'utf8')).toContain('"outcome":"refused"');
    expect(readFileSync(path, 'utf8')).not.toContain('1234');
  });

  it('does not reveal unexpected provider errors', async () => {
    const path = temporaryFile('audit.jsonl');
    const redactor = new Redactor(redactionConfig);
    const result = await runTool({ audit: new AuditLog(path, redactor), redactor },
      'query', 'fake', {}, async () => { throw new Error('secret diagnostic'); });
    expect(JSON.stringify(result)).not.toContain('secret diagnostic');
    expect(result.structuredContent).toMatchObject({ data: { code: 'PROVIDER_ERROR' } });
  });
});
