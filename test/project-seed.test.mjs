import assert from 'node:assert/strict';
import test from 'node:test';
import { assertOwnedIssue } from '../scripts/seed-project.mjs';

test('roadmap seeding refuses a lookalike issue from another account', () => {
  const title = 'Epic: synthetic milestone';
  const legitimate = { title, user: { login: 'dehanz13' } };
  assert.equal(assertOwnedIssue(legitimate, title), legitimate);
  assert.throws(() => assertOwnedIssue({ ...legitimate, user: { login: 'other-account' } }, title),
    /unverified existing issue/);
  assert.throws(() => assertOwnedIssue({ ...legitimate, pull_request: {} }, title),
    /unverified existing issue/);
});
