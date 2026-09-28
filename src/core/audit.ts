import { closeSync, existsSync, lstatSync, mkdirSync, openSync, writeSync, constants } from 'node:fs';
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
  constructor(private readonly path: string, private readonly redactor: Redactor) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.assertReady();
  }

  assertReady(): void {
    if (existsSync(this.path)) {
      const status = lstatSync(this.path);
      if (!status.isFile() || (status.mode & 0o077) !== 0 || status.uid !== process.getuid?.()) {
        throw new Error('Audit file must be an owner-only regular file');
      }
    }
    const fd = openSync(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
  }

  record(entry: AuditEntry): void {
    this.assertReady();
    const fd = openSync(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      const line = Buffer.from(`${JSON.stringify(this.redactor.value(entry))}\n`);
      let offset = 0;
      while (offset < line.length) offset += writeSync(fd, line, offset);
    } finally {
      closeSync(fd);
    }
  }
}
