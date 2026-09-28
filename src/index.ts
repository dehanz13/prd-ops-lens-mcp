#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './core/config.js';
import { createServer } from './server.js';
import { GrafanaProvider } from './providers/grafana.js';
import { UptimeProvider } from './providers/uptime.js';
import { CloudWatchProvider } from './providers/cloudwatch.js';
import { IamProvider } from './providers/iam.js';
import { PostHogProvider } from './providers/posthog.js';
import { AgentUsageProvider } from './providers/agent-usage.js';
import { DemoRestartProvider } from './restart/gated-restart.js';

const path = process.env.OPS_LENS_CONFIG;
if (!path) {
  process.stderr.write('Set OPS_LENS_CONFIG to an absolute configuration file path.\n');
  process.exitCode = 1;
} else {
  try {
    const config = loadConfig(path);
    const grafana = new GrafanaProvider();
    const cloudwatch = new CloudWatchProvider();
    const iam = new IamProvider();
    const posthog = new PostHogProvider();
    const agentUsage = new AgentUsageProvider();
    const restart = new DemoRestartProvider();
    await grafana.preflight(config);
    await cloudwatch.preflight(config);
    await iam.preflight(config);
    await posthog.preflight(config);
    agentUsage.preflight(config);
    await restart.preflight(config);
    serveStdio(() => createServer(config, [grafana, new UptimeProvider(), cloudwatch, iam, posthog, agentUsage, restart]));
  } catch {
    process.stderr.write('Configuration could not be loaded; check the file path and schema.\n');
    process.exitCode = 1;
  }
}
