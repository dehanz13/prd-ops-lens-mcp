import type { Config } from './config.js';

const fixedSensitiveKeys = /^(?:authorization|cookie|password|secret|token|api[_-]?key|access[_-]?key|email|ip|url)$/i;
const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const ipv6 = /(?<![\w:])(?:[a-f\d]{0,4}:){2,7}[a-f\d]{0,4}(?![\w:])/gi;
const bearer = /\bBearer\s+[^\s,;]+/gi;
const tokenAssignment = /\b((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)[^\s,;]+/gi;
const jwt = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const cloudKey = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const prefixedToken = /\b(?:sk-|phx_|glsa_)[A-Za-z0-9_-]{8,}\b/gi;
const longToken = /\b[A-Za-z0-9_-]{32,}\b/g;
// Deliberate control-character matching protects the MCP transport from terminal escapes.
// eslint-disable-next-line no-control-regex
const ansi = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const control = /[\u0000-\u001f\u007f]/g;

export class Redactor {
  private readonly identityKeys: Set<string>;
  private readonly identityPattern: RegExp | null;
  private readonly identityValues: string[];

  constructor(config: Config['redaction']) {
    this.identityKeys = new Set(config.identityKeys.map((key) => key.toLowerCase()));
    this.identityValues = config.identityValues.filter(Boolean);
    const labels = config.identityLabels.filter(Boolean).map(escapeRegExp);
    this.identityPattern = labels.length
      ? new RegExp(`\\b((?:${labels.join('|')})[:=/])[^\\s:,;/]+`, 'gi')
      : null;
  }

  text(value: string): string {
    let result = value
      .replace(ansi, '')
      .replace(control, '')
      .replace(bearer, 'Bearer [REDACTED]')
      .replace(tokenAssignment, '$1[REDACTED]')
      .replace(jwt, '[REDACTED]')
      .replace(cloudKey, '[REDACTED]')
      .replace(prefixedToken, '[REDACTED]')
      .replace(email, '[REDACTED]')
      .replace(ipv4, '[REDACTED]')
      .replace(ipv6, '[REDACTED]')
      .replace(longToken, (candidate) => entropy(candidate) >= 4 ? '[REDACTED]' : candidate);
    if (this.identityPattern) {
      result = result.replace(this.identityPattern, '$1[REDACTED]');
    }
    for (const identity of this.identityValues) {
      result = result.replace(new RegExp(escapeRegExp(identity), 'gi'), '[REDACTED]');
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

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  return [...counts.values()].reduce((sum, count) => {
    const probability = count / value.length;
    return sum - probability * Math.log2(probability);
  }, 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
