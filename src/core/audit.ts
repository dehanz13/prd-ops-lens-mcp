import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
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
    const fd = openSync(path, 'a', 0o600);
    closeSync(fd);
  }

  record(entry: AuditEntry): void {
    const fd = openSync(this.path, 'a', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(this.redactor.value(entry))}\n`);
    } finally {
      closeSync(fd);
    }
  }
}
