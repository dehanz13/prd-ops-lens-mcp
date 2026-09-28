#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './core/config.js';
import { createServer } from './server.js';

const path = process.env.OPS_LENS_CONFIG;
if (!path) {
  process.stderr.write('Set OPS_LENS_CONFIG to an absolute configuration file path.\n');
  process.exitCode = 1;
} else {
  try {
    const config = loadConfig(path);
    serveStdio(() => createServer(config));
  } catch {
    process.stderr.write('Configuration could not be loaded; check the file path and schema.\n');
    process.exitCode = 1;
  }
}
