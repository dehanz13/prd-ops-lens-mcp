import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const fakeHome = vi.hoisted(() => ({ path: '' }));
const fakeFs = vi.hoisted(() => ({ hook: undefined as undefined | (() => void) }));
vi.mock('node:os', async (load) => {
  const actual = await load<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHome.path || actual.homedir() };
});
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return { ...actual, lstatSync: (path: string) => {
    const status = actual.lstatSync(path);
    fakeFs.hook?.();
    return status;
  } };
});

import { DockerDesktopDemoApi } from '../src/restart/demo-docker.js';

const servers: Server[] = [];
const dirs: string[] = [];
const id = 'a'.repeat(64);
const target = { Id: id, Name: '/ops-lens-demo-demo-api-1', RestartCount: 0,
  Config: { Labels: { 'com.docker.compose.project': 'ops-lens-demo',
    'com.docker.compose.service': 'demo-api' } },
  State: { Running: true, StartedAt: '2026-01-01T00:00:00.000Z' } };

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  fakeHome.path = mkdtempSync(join(tmpdir(), 'ops-docker-home-'));
  dirs.push(fakeHome.path);
  const directory = join(fakeHome.path, '.docker/run');
  mkdirSync(directory, { recursive: true });
  const socket = join(directory, 'docker.sock');
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return { socket, api: new DockerDesktopDemoApi(socket) };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  fakeHome.path = '';
  fakeFs.hook = undefined;
});

// @guardrail G9.3: all Docker checks and the write share a verified local socket.
it('uses one verified connection for identity, target and restart', async () => {
  const paths: string[] = [];
  const { api } = await fixture((request, response) => {
    paths.push(`${request.method} ${request.url}`);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/info') response.end(JSON.stringify({ Name: 'docker-desktop',
      OperatingSystem: 'Docker Desktop', ID: 'synthetic-daemon-id' }));
    else if (request.url?.endsWith('/json')) response.end(JSON.stringify(target));
    else { response.statusCode = 204; response.end(); }
  });
  expect(await api.identity()).toBe('synthetic-daemon-id');
  expect((await api.inspect()).id).toBe(id);
  await api.restart(id);
  expect(paths).toEqual(['/info', '/containers/ops-lens-demo-demo-api-1/json',
    `/containers/${id}/restart?t=3`].map((path, index) => `${index === 2 ? 'POST' : 'GET'} ${path}`));
});

it('refuses a replaced socket before a restart reaches the replacement daemon', async () => {
  const { socket, api } = await fixture((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url === '/info' ? { Name: 'docker-desktop',
      OperatingSystem: 'Docker Desktop', ID: 'synthetic-daemon-id' } : target));
  });
  await api.identity();
  await api.inspect();
  unlinkSync(socket);
  const replacementPaths: string[] = [];
  const replacement = createServer((request, response) => {
    replacementPaths.push(request.url ?? '');
    response.end('{}');
  });
  servers.push(replacement);
  await new Promise<void>((resolve) => replacement.listen(socket, resolve));
  await expect(api.restart(id)).rejects.toThrow('socket changed');
  expect(replacementPaths).toEqual([]);
});

it('refuses a socket exchanged between the pre-connect check and connect event', async () => {
  const paths: string[] = [];
  const { socket, api } = await fixture((_request, response) => response.end('{}'));
  const replacement = createServer((request, response) => {
    paths.push(request.url ?? '');
    response.end(JSON.stringify({ Name: 'docker-desktop', OperatingSystem: 'Docker Desktop',
      ID: 'synthetic-daemon-id' }));
  });
  servers.push(replacement);
  let checks = 0;
  fakeFs.hook = () => {
    checks += 1;
    if (checks === 2) {
      unlinkSync(socket);
      replacement.listen(socket);
    }
  };
  await expect(api.identity()).rejects.toThrow('socket changed');
  expect(paths).toEqual([]);
});

it('refuses a restart if the verified connection closed after inspection', async () => {
  const paths: string[] = [];
  const { api } = await fixture((request, response) => {
    paths.push(request.url ?? '');
    response.setHeader('connection', 'close');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url === '/info' ? { Name: 'docker-desktop',
      OperatingSystem: 'Docker Desktop', ID: 'synthetic-daemon-id' } : target));
  });
  await api.identity();
  await expect(api.inspect()).rejects.toThrow('connection is unavailable');
  await expect(api.restart(id)).rejects.toThrow('connection is unavailable');
  expect(paths).toEqual(['/info']);
});

it('caps response bytes and refuses a non-Desktop daemon over the real transport', async () => {
  const oversized = await fixture((_request, response) => response.end('x'.repeat(1_000_001)));
  await expect(oversized.api.identity()).rejects.toMatchObject({ code: 'RESPONSE_LIMIT' });
  const wrong = await fixture((_request, response) => response.end(JSON.stringify({
    Name: 'remote-daemon', OperatingSystem: 'Docker Desktop', ID: 'synthetic-daemon-id',
  })));
  await expect(wrong.api.identity()).rejects.toMatchObject({ code: 'REFUSED' });
});

it('does not follow redirects from the demo health endpoint', async () => {
  const { api } = await fixture((_request, response) => response.end('{}'));
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
    status: 302, headers: { location: 'https://example.invalid/health' },
  }));
  try {
    expect(await api.health()).toBe('unknown');
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:8088/health',
      expect.objectContaining({ redirect: 'manual' }));
  } finally { fetch.mockRestore(); }
});
