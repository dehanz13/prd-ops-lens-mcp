#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './core/config.js';
import { createServer } from './server.js';
import { GrafanaProvider } from './providers/grafana.js';
import { UptimeProvider } from './providers/uptime.js';
import { CloudWatchProvider } from './providers/cloudwatch.js';

const path = process.env.OPS_LENS_CONFIG;
if (!path) {
  process.stderr.write('Set OPS_LENS_CONFIG to an absolute configuration file path.\n');
  process.exitCode = 1;
} else {
  try {
    const config = loadConfig(path);
    const grafana = new GrafanaProvider();
    const cloudwatch = new CloudWatchProvider();
    await grafana.preflight(config);
    await cloudwatch.preflight(config);
    serveStdio(() => createServer(config, [grafana, new UptimeProvider(), cloudwatch]));
  } catch {
    process.stderr.write('Configuration could not be loaded; check the file path and schema.\n');
    process.exitCode = 1;
  }
}
