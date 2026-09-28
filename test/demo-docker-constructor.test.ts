import { lstatSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { DockerDesktopDemoApi } from '../src/restart/demo-docker.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, lstatSync: vi.fn() };
});

const socket = join(homedir(), '.docker/run/docker.sock');
const mockedStat = vi.mocked(lstatSync);
beforeEach(() => mockedStat.mockReset());

// @guardrail G9.3: constructor must verify the real socket before any Docker call.
it('checks the configured socket with lstat and refuses non-sockets or symlinks', () => {
  const valid = { uid: process.getuid?.(), isSocket: () => true,
    isSymbolicLink: () => false } as Stats;
  mockedStat.mockReturnValue(valid);
  expect(() => new DockerDesktopDemoApi(socket)).not.toThrow();
  expect(mockedStat).toHaveBeenCalledExactlyOnceWith(socket);
  mockedStat.mockReturnValue({ ...valid, isSocket: () => false } as Stats);
  expect(() => new DockerDesktopDemoApi(socket)).toThrow('could not be verified');
  mockedStat.mockReturnValue({ ...valid, isSymbolicLink: () => true } as Stats);
  expect(() => new DockerDesktopDemoApi(socket)).toThrow('could not be verified');
});
