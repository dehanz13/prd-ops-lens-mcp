import type { Config } from './config.js';

const sensitiveKeyNames = 'authorization|cookie|password|secret|token|api[_-]?key|access[_-]?key|aws_secret_access_key|aws_access_key_id|user[_-]?id|player[_-]?id|session[_-]?id|account[_-]?id|email|ip|url';
const fixedSensitiveKeys = new RegExp(`^(?:${sensitiveKeyNames})$`, 'i');
const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const ipv6 = /(?<![\w:])(?!(?:\d{2}:){2}\d{2}(?:[.\s]|$))(?:[a-f\d]{0,4}:){2,7}[a-f\d]{0,4}(?![\w:])/gi;
const bearer = /\bBearer\s+[^\s,;]+/gi;
const tokenAssignment = /\b((?:api[_-]?key|token|secret|password|authorization|aws_secret_access_key|aws_access_key_id)\s*[:=]\s*)[^\s,;]+/gi;
const jwt = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const cloudKey = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gi;
const hexSecret = /\b[A-F0-9]{32,}\b/gi;
const awsArn = /\barn:[a-z0-9-]+:[a-z0-9-]*:[a-z0-9-]*:\d{12}:[^\s,;"']+/gi;
const awsAccountId = /\b\d{12}\b/g;
const prefixedToken = /\b(?:sk-|phx_|glsa_|ghp_|gho_|github_pat_|xoxb-)[A-Za-z0-9_-]{8,}\b/gi;
const base64Secret = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40,}(?![A-Za-z0-9/+=])/g;
const longToken = /\b[A-Za-z0-9_-]{32,}\b/g;
// Deliberate control-character matching protects the MCP transport from terminal escapes.
// eslint-disable-next-line no-control-regex
const ansi = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const control = /[\u0000-\u001f\u007f]/g;

export class Redactor {
  private readonly awsIdentifiers: boolean;
  private readonly identityKeys: Set<string>;
  private readonly identityParents: Set<string>;
  private readonly identityPattern: RegExp | null;
  private readonly identityAssignmentPattern: RegExp;
  private readonly jsonSensitivePattern: RegExp;
  private readonly identityValues: string[];

  constructor(config: Config['redaction']) {
    this.awsIdentifiers = config.awsIdentifiers;
    this.identityKeys = new Set(config.identityKeys.map((key) => key.toLowerCase()));
    this.identityParents = new Set(config.identityLabels.map((label) => label.toLowerCase()));
    this.identityValues = config.identityValues.filter(Boolean);
    const labels = config.identityLabels.filter(Boolean).map(escapeRegExp);
    this.identityPattern = labels.length
      ? new RegExp(`\\b((?:${labels.join('|')})[:=/])[^\\s:,;/]+`, 'gi')
      : null;
    const jsonKeys = [...this.identityKeys].map(escapeRegExp);
    const assignmentKeys = ['user[_-]?id', 'player[_-]?id', 'session[_-]?id', 'account[_-]?id',
      ...config.identityKeys.map(escapeRegExp)];
    this.identityAssignmentPattern = new RegExp(
      `\\b((?:${assignmentKeys.join('|')})(?:\\\\?")?\\s*[:=]\\s*(?:\\\\?")?)[^\\s,;\\]}"]+`, 'gi');
    this.jsonSensitivePattern = new RegExp(
      `"(?:${[sensitiveKeyNames, ...jsonKeys].join('|')})"\\s*:\\s*(?:"(?:\\\\.|[^"\\\\])*"|-?\\d+(?:\\.\\d+)?|true|false|null)`, 'gi');
  }

  text(value: string): string {
    let result = value
      .replace(ansi, '')
      .replace(control, '');
    if (/^\s*(?:\[|\{|")/.test(result)) {
      try { return JSON.stringify(this.walk(JSON.parse(result))); } catch { /* Continue with text patterns. */ }
    }
    result = result
      .replace(this.jsonSensitivePattern, (field) => `${field.slice(0, field.indexOf(':') + 1)}"[REDACTED]"`)
      .replace(this.identityAssignmentPattern, '$1[REDACTED]')
      .replace(bearer, 'Bearer [REDACTED]')
      .replace(tokenAssignment, '$1[REDACTED]')
      .replace(jwt, '[REDACTED]')
      .replace(cloudKey, '[REDACTED]')
      .replace(hexSecret, '[REDACTED]')
      .replace(base64Secret, (candidate) => /[/+=]/.test(candidate) && entropy(candidate) >= 3.5
        ? '[REDACTED]' : candidate)
      .replace(prefixedToken, '[REDACTED]')
      .replace(email, '[REDACTED]')
      .replace(ipv4, '[REDACTED]')
      .replace(ipv6, '[REDACTED]');
    if (this.awsIdentifiers) {
      result = result.replace(awsArn, '[REDACTED]').replace(awsAccountId, '[REDACTED]');
    }
    result = result.replace(longToken, (candidate) => entropy(candidate) >= 4 ? '[REDACTED]' : candidate);
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

  private walk(input: unknown, parentKey = ''): unknown {
    if (typeof input === 'string') return this.text(input);
    if (Array.isArray(input)) return input.map((item) => this.walk(item, parentKey));
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).map(([key, value]) => [
        key,
        fixedSensitiveKeys.test(key) || this.identityKeys.has(key.toLowerCase()) ||
          (key.toLowerCase() === 'id' && this.identityParents.has(parentKey.toLowerCase()))
          ? '[REDACTED]'
          : this.walk(value, key),
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
