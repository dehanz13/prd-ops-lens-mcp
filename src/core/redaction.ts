import type { Config } from './config.js';

const fixedSensitiveKeys = /^(?:authorization|cookie|password|secret|token|api[_-]?key|access[_-]?key|email|ip|url)$/i;
const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const ipv6 = /\b(?:[a-f\d]{1,4}:){2,}(?:[a-f\d]{1,4})?\b/gi;
const bearer = /\bBearer\s+[^\s,;]+/gi;
const tokenAssignment = /\b((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)[^\s,;]+/gi;

export class Redactor {
  private readonly identityKeys: Set<string>;
  private readonly identityPattern: RegExp | null;

  constructor(config: Config['redaction']) {
    this.identityKeys = new Set(config.identityKeys.map((key) => key.toLowerCase()));
    const labels = config.identityLabels.filter(Boolean).map(escapeRegExp);
    this.identityPattern = labels.length
      ? new RegExp(`\\b((?:${labels.join('|')})[:=/])[^\\s:,;/]+`, 'gi')
      : null;
  }

  text(value: string): string {
    let result = value
      .replace(bearer, 'Bearer [REDACTED]')
      .replace(tokenAssignment, '$1[REDACTED]')
      .replace(email, '[REDACTED]')
      .replace(ipv4, '[REDACTED]')
      .replace(ipv6, '[REDACTED]');
    if (this.identityPattern) {
      result = result.replace(this.identityPattern, '$1[REDACTED]');
    }
    return result;
  }

  value<T>(input: T): T {
    return this.walk(input) as T;
  }

  private walk(input: unknown): unknown {
    if (typeof input === 'string') return this.text(input);
    if (Array.isArray(input)) return input.map((item) => this.walk(item));
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).map(([key, value]) => [
        key,
        fixedSensitiveKeys.test(key) || this.identityKeys.has(key.toLowerCase())
          ? '[REDACTED]'
          : this.walk(value),
      ]));
    }
    return input;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
