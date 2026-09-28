import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';

export const SERVER_NAME = 'prd-ops-lens-mcp';

const baseUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' ||
    (url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname));
}, 'Use HTTPS, or HTTP on loopback for the local demo');

const absolutePath = z.string().min(1).refine(isAbsolute, 'Use an absolute path');

export const ConfigSchema = z.strictObject({
  version: z.literal(1),
  audit: z.strictObject({ path: absolutePath }),
  redaction: z.strictObject({
    identityKeys: z.array(z.string().min(1)).default(['userId', 'playerId', 'sessionId', 'accountId']),
    identityLabels: z.array(z.string().min(1)).default(['user', 'player', 'session', 'room', 'account']),
  }).prefault({}),
  limits: z.strictObject({
    maxWindowMinutes: z.number().int().min(1).max(1440).default(60),
    maxRows: z.number().int().min(1).max(1000).default(1000),
    timeoutMs: z.number().int().min(1000).max(30000).default(10000),
  }).prefault({}),
  providers: z.strictObject({
    grafana: z.strictObject({
      enabled: z.boolean().default(false),
      baseUrl,
      tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    }).optional(),
    uptime: z.strictObject({
      enabled: z.boolean().default(false),
      baseUrl,
      slug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    }).optional(),
  }).prefault({}),
  writes: z.strictObject({
    enabled: z.boolean().default(false),
    demoOnly: z.literal(true).default(true),
    containers: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)).default([]),
  }).prefault({}),
});

export type Config = z.output<typeof ConfigSchema>;

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Config {
  const document = parseDocument(readFileSync(path, 'utf8'), { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error('Configuration YAML is invalid');
  }
  const config = ConfigSchema.parse(document.toJS({ maxAliasCount: 20 }));
  if (config.writes.enabled && env.OPS_LENS_ENABLE_WRITES !== '1') {
    throw new Error('Writes require OPS_LENS_ENABLE_WRITES=1 at startup');
  }
  return config;
}

export function providerToken(envName: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[envName];
  if (!value) {
    throw new Error(`Missing provider token in environment variable ${envName}`);
  }
  return value;
}
