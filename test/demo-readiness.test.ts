import { expect, it, vi } from 'vitest';
import { waitForReady } from '../scripts/demo-readiness.mjs';

it('retries a transient readiness response and then succeeds', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 })
    .mockResolvedValueOnce({ ok: true, status: 200 });
  await waitForReady('demo-api', 'http://127.0.0.1:8088/health', Date.now() + 500, 1, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:8088/health',
    expect.objectContaining({ redirect: 'manual' }));
});

it('accepts a same-origin dashboard redirect without fetching its destination', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 302,
    headers: { get: () => '/dashboard' } });
  await waitForReady('uptime-kuma', 'http://127.0.0.1:3001/', Date.now() + 100, 1, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('never treats a cross-origin redirect as ready', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 302,
    headers: { get: () => 'https://example.invalid/' } });
  await expect(waitForReady('uptime-kuma', 'http://127.0.0.1:3001/',
    Date.now() + 20, 1, fetcher)).rejects.toThrow('HTTP 302');
});

it('stops retrying at the shared startup deadline', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 503 });
  await expect(waitForReady('demo-api', 'http://127.0.0.1:8088/health',
    Date.now() + 20, 1, fetcher)).rejects.toThrow('HTTP 503');
  expect(fetcher.mock.calls.length).toBeGreaterThan(1);
});
