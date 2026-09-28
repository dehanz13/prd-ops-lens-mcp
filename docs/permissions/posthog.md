# PostHog read access

Milestone F uses a personal API key bound to the exact numeric project IDs in private configuration. Give the key **only** `query:read`, `insight:read`, `error_tracking:read`, and `feature_flag:read`. Select only those projects; leave organization access empty. Keep the token in an owner-only file outside the repository.

At startup, the provider calls `GET /api/personal_api_keys/@current/` with that key and checks the returned scopes, `scoped_teams`, and `scoped_organizations`. It refuses wildcard, write, extra read, unscoped, organization-wide, or mismatched access. The MCP server never exposes the response or token. If your PostHog deployment does not offer this self-inspection route, the provider stays disabled and reports a configuration error.

## Request contract

| MCP tool | PostHog request | Scope | Result |
| --- | --- | --- | --- |
| `posthog_hogql` | `POST /api/projects/{project_id}/query/` with `HogQLQuery` | `query:read` | bounded event query rows |
| `posthog_insight` | `GET /api/projects/{project_id}/insights/{id}/` | `insight:read` | id, short id, name, type, refresh time |
| `posthog_error_issues` | `GET /api/projects/{project_id}/error_tracking/issues/` | `error_tracking:read` | issue state and counts |
| `posthog_flag` | `GET /api/projects/{project_id}/feature_flags/{id}/` | `feature_flag:read` | flag key and active state |

All paths and projects are allowlisted. The HogQL tool accepts a single SELECT from `events` with only `event`, `timestamp`, and `count(*)` projections and no aliases. It requires balanced parentheses and a UTC window; it rejects comments, subqueries, joins, unions, raw property/payload columns, mutation keywords, and unsafe grouping or ordering. It enforces a terminal LIMIT of at most 1,000. The provider inserts the window predicate and applies a request timeout and response byte cap. Returned cells are classified by the validated projection, never by upstream column labels. Recording and console endpoints are absent.

Contract references: [query](https://posthog.com/docs/api/query), [insights](https://posthog.com/docs/api/insights), [error tracking issues](https://posthog.com/docs/api/error-tracking-2), [feature flags](https://posthog.com/docs/api/feature-flags), and [active key implementation](https://github.com/PostHog/posthog/blob/master/posthog/api/personal_api_key.py).

Live PostHog verification requires an owner-created, project-scoped read-only key. Replay tests use synthetic data and never require a cloud key.
