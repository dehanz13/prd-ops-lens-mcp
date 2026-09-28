import assert from 'node:assert/strict';
import test from 'node:test';
import { apiAll, assertOwnedIssue, ensureIssue } from '../scripts/seed-project.mjs';

test('roadmap seeding refuses a lookalike issue from another account', () => {
  const title = 'Epic: synthetic milestone';
  const legitimate = { title, user: { login: 'dehanz13' } };
  assert.equal(assertOwnedIssue(legitimate, title), legitimate);
  assert.throws(() => assertOwnedIssue({ ...legitimate, user: { login: 'other-account' } }, title),
    /unverified existing issue/);
  assert.throws(() => assertOwnedIssue({ ...legitimate, pull_request: {} }, title),
    /unverified existing issue/);
});

test('ensureIssue invokes the owner check before adopting an existing title', () => {
  const title = 'Epic: synthetic milestone';
  const untrusted = { number: 42, title, user: { login: 'other-account' } };
  let created = false;
  assert.throws(() => ensureIssue(new Map([[title, untrusted]]), title, 'body', ['epic'],
    () => { created = true; return {}; }), /unverified existing issue/);
  assert.equal(created, false);
});

test('Milestone G renames only owner-created legacy issues and updates their plan', () => {
  const oldTitle = 'Epic: VPS status with optional SSH reads';
  const newTitle = 'Epic: Host health through Grafana and public Kuma';
  const issue = { number: 77, title: oldTitle, user: { login: 'dehanz13' } };
  const issues = new Map([[oldTitle, issue]]);
  const writes = [];
  assert.equal(ensureIssue(issues, newTitle, 'new goal', ['epic'],
    () => { throw Error('duplicate issue created'); }, (...args) => { writes.push(args); }), issue);
  assert.equal(issues.has(oldTitle), false);
  assert.equal(issues.get(newTitle)?.body, 'new goal');
  assert.deepEqual(writes[0], ['PATCH', 'repos/dehanz13/prd-ops-lens-mcp/issues/77',
    { title: newTitle, body: 'new goal' }]);
  const stranger = new Map([[oldTitle, { ...issue, title: oldTitle, user: { login: 'stranger' } }]]);
  assert.throws(() => ensureIssue(stranger, newTitle, 'new goal', ['epic'], () => {}, () => {}),
    /unverified existing issue/);
});

test('GitHub lookups flatten every page and reject malformed pagination', () => {
  let args;
  const found = apiAll('repos/dehanz13/prd-ops-lens-mcp/issues?state=all&per_page=100', (value) => {
    args = value;
    return JSON.stringify([[{ number: 1 }], [{ number: 101 }]]);
  });
  assert.deepEqual(found.map((issue) => issue.number), [1, 101]);
  assert.deepEqual(args.slice(0, 3), ['api', '--paginate', '--slurp']);
  assert.throws(() => apiAll('synthetic', () => JSON.stringify({ number: 1 })), /invalid response/);
});
