import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const started = performance.now();
const child = spawn(process.execPath, ['scripts/smoke-demo.mjs'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, OPS_LENS_CONFIG: '' },
});
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 8192) child.kill(); });
child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 8192) child.kill(); });
const exitCode = await new Promise((resolve) => child.on('close', resolve));
if (exitCode !== 0) {
  process.stderr.write('Synthetic demo smoke failed; no recording was written.\n');
  process.exit(1);
}
let result;
try {
  result = JSON.parse(stdout.trim());
} catch {
  process.stderr.write('Synthetic demo returned an invalid summary.\n');
  process.exit(1);
}
const fields = ['dashboards', 'metricRows', 'hostMetricRows', 'logRows', 'lokiScannedBytes'];
if (result.result !== 'pass' || fields.some((field) =>
  !Number.isInteger(result[field]) || result[field] < 0)) {
  process.stderr.write('Synthetic demo summary failed validation.\n');
  process.exit(1);
}
const summary = Object.fromEntries([['result', 'pass'], ...fields.map((field) => [field, result[field]])]);
const elapsedSeconds = Math.max(0.01, (performance.now() - started) / 1000);
const header = { version: 2, width: 100, height: 24,
  timestamp: Math.floor(Date.now() / 1000), title: 'Synthetic MCP demo', env: { TERM: 'xterm-256color' } };
const cast = [header, [0, 'o', '$ node scripts/smoke-demo.mjs\r\n'],
  [elapsedSeconds, 'o', `${JSON.stringify(summary)}\r\n`]];
writeFileSync('docs/demo.cast', `${cast.map((event) => JSON.stringify(event)).join('\n')}\n`, { mode: 0o644 });
process.stdout.write(`Recorded a synthetic demo pass with ${summary.hostMetricRows} host metric row(s).\n`);
