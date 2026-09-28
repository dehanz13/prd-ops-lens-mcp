import { setTimeout as pause } from 'node:timers/promises';
import { URL } from 'node:url';

export async function waitForReady(name, url, deadline, retryMs = 1000, fetcher = fetch) {
  let last = 'unreachable';
  while (Date.now() < deadline) {
    try {
      const response = await fetcher(url, {
        redirect: 'manual', signal: AbortSignal.timeout(Math.min(3000, Math.max(1, deadline - Date.now()))),
      });
      if (response.ok) return;
      const location = response.headers?.get('location');
      if (response.status >= 300 && response.status < 400 && location &&
        new URL(location, url).origin === new URL(url).origin) return;
      last = `HTTP ${response.status}`;
    } catch { last = 'unreachable'; }
    if (Date.now() < deadline) await pause(Math.min(retryMs, deadline - Date.now()));
  }
  throw new Error(`${name} readiness did not succeed within the demo startup window (${last})`);
}
