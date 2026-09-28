import { OpsError } from './result.js';

export type AllowedRoute = { method: 'GET' | 'POST'; path: string | RegExp };

/** Check the exact request shape before fetch or an SDK call is allowed. */
export function assertAllowedRequest(
  provider: string,
  method: string,
  path: string,
  routes: readonly AllowedRoute[],
): void {
  const normalizedMethod = method.toUpperCase();
  const pathname = new URL(path, 'https://local.invalid').pathname;
  const match = routes.some((route) => route.method === normalizedMethod &&
    (typeof route.path === 'string' ? route.path === pathname : route.path.test(pathname)));
  if (!match) throw new OpsError('REFUSED', `${provider}: endpoint is not allowlisted`);
}
