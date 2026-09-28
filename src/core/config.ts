import { lstatSync, readFileSync } from 'node:fs';
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
    identityValues: z.array(z.string().min(1)).default([]),
    awsIdentifiers: z.boolean().default(true),
  }).prefault({}),
  limits: z.strictObject({
    maxWindowMinutes: z.number().int().min(1).max(1440).default(60),
    maxRows: z.number().int().min(1).max(1000).default(1000),
    maxOutputBytes: z.number().int().min(1024).max(1_048_576).default(65_536),
    maxConcurrentProviderCalls: z.number().int().min(1).max(8).default(2),
    maxResponseBytes: z.number().int().min(1024).max(10_000_000).default(2_000_000),
    maxLokiScanBytes: z.number().int().min(1024).max(100_000_000).default(5_000_000),
    timeoutMs: z.number().int().min(1000).max(30000).default(20000),
  }).prefault({}),
  providers: z.strictObject({
    grafana: z.strictObject({
      enabled: z.boolean().default(false),
      baseUrl,
      tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
      tokenFile: absolutePath.optional(),
      prometheusUid: z.string().regex(/^[a-zA-Z0-9_-]+$/),
      lokiUid: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    }).refine((value) => !(value.tokenEnv && value.tokenFile), 'Choose tokenEnv or tokenFile').optional(),
    uptime: z.strictObject({
      enabled: z.boolean().default(false),
      baseUrl,
      slug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    }).optional(),
    cloudwatch: z.strictObject({
      enabled: z.boolean().default(false),
      region: z.string().regex(/^[a-z]{2}-[a-z]+-\d+$/),
      profile: z.string().regex(/^[a-zA-Z0-9_-]+$/),
      credentialsFile: absolutePath,
      logGroups: z.array(z.string().min(1).max(512)).min(1).max(10)
        .refine((groups) => new Set(groups).size === groups.length, 'Log groups must be unique'),
      maxLogWindowMinutes: z.number().int().min(1).max(1440).default(60),
      maxScanBytes: z.number().int().min(1024).max(100_000_000).default(5_000_000),
    }).optional(),
    iam: z.strictObject({
      enabled: z.boolean().default(false),
      region: z.string().regex(/^[a-z]{2}-[a-z]+-\d+$/),
      profile: z.string().regex(/^[a-zA-Z0-9_-]+$/),
      credentialsFile: absolutePath,
      roleNames: z.array(z.string().regex(/^[a-zA-Z0-9_+=,.@-]{1,64}$/)).min(1).max(20)
        .refine((roles) => new Set(roles).size === roles.length, 'Role names must be unique'),
      analyzerArn: z.string().regex(/^arn:aws:access-analyzer:[a-z0-9-]+:\d{12}:analyzer\/[a-zA-Z0-9_.-]+$/).optional(),
    }).optional(),
    posthog: z.strictObject({
      enabled: z.boolean().default(false),
      baseUrl,
      tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
      tokenFile: absolutePath.optional(),
      projectIds: z.array(z.number().int().positive()).min(1).max(5)
        .refine((ids) => new Set(ids).size === ids.length, 'Project ids must be unique'),
    }).refine((value) => Number(Boolean(value.tokenEnv)) + Number(Boolean(value.tokenFile)) === 1,
      'Choose exactly one tokenEnv or tokenFile').optional(),
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

/** Read an owner-only credential file without including its value in errors. */
export function readPrivateCredentialFile(path: string): string {
  assertPrivateCredentialFile(path);
  const value = readFileSync(path, 'utf8').trim();
  if (!value) throw new Error('Credential file is empty');
  return value;
}

export function assertPrivateCredentialFile(path: string): void {
  const status = lstatSync(path);
  if (!status.isFile() || status.uid !== process.getuid?.() || (status.mode & 0o077) !== 0) {
    throw new Error('Credential file must be an owner-only regular file');
  }
}

export function providerTokenFile(path: string): string {
  return readPrivateCredentialFile(path);
}
