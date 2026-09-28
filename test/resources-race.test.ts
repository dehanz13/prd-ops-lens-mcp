import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/core/config.js';
import { createServer } from '../src/server.js';

const swap = vi.hoisted(() => ({ path: '', replacement: '', happened: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, openSync: (...args: Parameters<typeof actual.openSync>) => {
    if (String(args[0]) === swap.path && !swap.happened) {
      swap.happened = true;
      actual.renameSync(swap.path, `${swap.path}.checked`);
      actual.renameSync(swap.replacement, swap.path);
    }
    return actual.openSync(...args);
  } };
});

// @guardrail G8.2: the descriptor must be the file that passed the private-resource checks.
it('refuses a regular resource file swapped between validation and open', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ops-lens-resource-race-'));
  chmodSync(directory, 0o700);
  swap.path = join(directory, 'map.md');
  swap.replacement = join(directory, 'replacement.md');
  swap.happened = false;
  writeFileSync(swap.path, 'checked file', { mode: 0o600 });
  writeFileSync(swap.replacement, 'replacement file', { mode: 0o600 });
  swap.path = realpathSync(swap.path);
  swap.replacement = realpathSync(swap.replacement);
  const config = ConfigSchema.parse({ version: 1, audit: { path: join(directory, 'audit.jsonl') },
    resources: { directory, systemMap: 'map.md' } });
  const server = createServer(config);
  const client = new Client({ name: 'resource-race-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try {
    await expect(client.readResource({ uri: 'ops-lens://system-map' }))
      .rejects.toThrow('Configured resource could not be read');
    expect(swap.happened).toBe(true);
    expect(readFileSync(swap.path, 'utf8')).toBe('replacement file');
  } finally {
    await client.close();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
