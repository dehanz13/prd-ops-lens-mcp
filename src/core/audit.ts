import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, writeSync, constants } from 'node:fs';
import { dirname } from 'node:path';
import type { Examined } from './result.js';
import { Redactor } from './redaction.js';

export type AuditEntry = {
  at: string;
  tool: string;
  parameters: unknown;
  durationMs: number;
  examined: Examined | null;
  outcome: 'ok' | 'refused' | 'error';
};

export class AuditLog {
  private identity: { dev: number; ino: number } | undefined;
  private readonly directoryIdentity: { dev: number; ino: number };

  constructor(private readonly path: string, private readonly redactor: Redactor) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.directoryIdentity = this.verifyDirectory();
    this.assertReady();
  }

  private verifyDirectory(): { dev: number; ino: number } {
    let status;
    try { status = lstatSync(dirname(this.path)); }
    catch { throw new Error('Audit directory changed after initialization'); }
    if (!status.isDirectory() || status.isSymbolicLink() ||
      status.uid !== process.getuid?.() || (status.mode & 0o077) !== 0) {
      throw new Error('Audit directory must be an owner-only non-symlink directory');
    }
    if (this.directoryIdentity && (status.dev !== this.directoryIdentity.dev ||
      status.ino !== this.directoryIdentity.ino)) {
      throw new Error('Audit directory changed after initialization');
    }
    return { dev: status.dev, ino: status.ino };
  }

  private openVerified(): number {
    this.verifyDirectory();
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK |
      (this.identity ? 0 : constants.O_CREAT);
    const fd = openSync(this.path, flags, 0o600);
    try {
      const status = fstatSync(fd);
      if (!status.isFile() || status.uid !== process.getuid?.() ||
        (status.mode & 0o077) !== 0 || status.nlink !== 1 ||
        (this.identity && (status.dev !== this.identity.dev || status.ino !== this.identity.ino))) {
        throw new Error('Audit file must be the original owner-only regular file');
      }
      this.identity ??= { dev: status.dev, ino: status.ino };
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  assertReady(): void {
    closeSync(this.openVerified());
  }

  record(entry: AuditEntry): void {
    const fd = this.openVerified();
    try {
      const line = Buffer.from(`${JSON.stringify(this.redactor.value(entry))}\n`);
      let offset = 0;
      while (offset < line.length) offset += writeSync(fd, line, offset);
    } finally {
      closeSync(fd);
    }
  }
}
