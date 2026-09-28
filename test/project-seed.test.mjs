import assert from 'node:assert/strict';
import test from 'node:test';
import { apiAll, assertOwnedIssue, assertSafeSelectFieldUpdates, ensureDefinitionOfDone,
  ensureIssue, ensureProject, ensureProjectItem, ensureViews, indexManagedIssues,
  initializeCard, selectLinkedProject,
  validateSprintField, validateViews } from '../scripts/seed-project.mjs';

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

test('project selection requires a unique repository link before any write', () => {
  const title = 'prd-ops-lens-mcp roadmap';
  const projects = [{ number: 3, title }, { number: 4, title }];
  const inspect = (number) => ({ repositories: { nodes: [
    { nameWithOwner: number === 3 ? 'dehanz13/prd-ops-lens-mcp' : 'dehanz13/other' },
  ], pageInfo: { hasNextPage: false } } });
  assert.equal(selectLinkedProject(projects, inspect)?.number, 3);
  let writes = 0;
  assert.throws(() => ensureProject(() => ({ projects }), () => { writes += 1; },
    () => ({ repositories: { nodes: [{ nameWithOwner: 'dehanz13/prd-ops-lens-mcp' }],
      pageInfo: { hasNextPage: false } } })), /ambiguous/);
  assert.equal(writes, 0);
  assert.throws(() => selectLinkedProject([projects[0]], () => ({ repositories: {
    nodes: [], pageInfo: { hasNextPage: false },
  } })), /not linked/);
  assert.throws(() => ensureProject(() => ({ projects: Array(1000).fill({ title: 'other' }) }),
    () => { writes += 1; }, inspect), /may be incomplete/);
  assert.equal(writes, 0);
});

test('managed issue lookup rejects duplicate titles instead of keeping the last one', () => {
  const title = 'Definition of Done';
  const first = { number: 1, title, state: 'open', user: { login: 'dehanz13' } };
  const second = { number: 2, title, user: { login: 'other-account' } };
  assert.throws(() => indexManagedIssues([first, second]), /Duplicate managed issue title/);
  assert.equal(indexManagedIssues([first]).get(title), first);
  assert.throws(() => indexManagedIssues([second]), /unverified existing issue/);
  assert.throws(() => indexManagedIssues([{ ...first, state: 'closed' }]), /reopen it before seeding/);
});

test('closed Definition of Done is rejected before pinning or card creation', () => {
  const title = 'Definition of Done';
  const closed = { number: 1, title, state: 'closed', user: { login: 'dehanz13' } };
  assert.throws(() => ensureDefinitionOfDone(new Map([[title, closed]]), 'body'), /closed or its state is unknown/);
  const open = { ...closed, state: 'open' };
  assert.equal(ensureDefinitionOfDone(new Map([[title, open]]), 'body'), open);
});

test('reruns leave every field on an existing project card untouched', () => {
  const writes = [];
  const project = { id: 'project' };
  const issue = { url: 'https://example.test/issues/1' };
  const fields = [['Priority', 'P0'], ['Size', 3], ['Status', 'Ready'], ['Sprint', 1]];
  initializeCard(project, new Map(), issue, fields,
    () => ({ id: 'existing', isNew: false }), (...args) => writes.push(args));
  assert.equal(writes.length, 0);
  initializeCard(project, new Map(), issue, fields,
    () => ({ id: 'new', isNew: true }), (...args) => writes.push(args));
  assert.deepEqual(writes[0], [project, 'new', fields]);
});

test('project item lookup distinguishes an existing card from a new one', () => {
  const issue = { number: 1, url: 'https://example.test/issues/1' };
  const project = { id: 'project' };
  const existing = new Map([[issue.url, 'existing']]);
  assert.deepEqual(ensureProjectItem(project, existing, issue,
    () => { throw Error('existing card fetched again'); }), { id: 'existing', isNew: false });
  const added = new Map();
  assert.deepEqual(ensureProjectItem(project, added, issue,
    () => ({ node_id: 'content' }), () => ({ addProjectV2ItemById: { item: { id: 'new' } } })),
  { id: 'new', isNew: true });
  assert.equal(added.get(issue.url), 'new');
});

test('existing card assignments block option replacement', () => {
  const fields = [['Status', ['Backlog', 'Ready']]];
  const project = { fields: { nodes: [{ name: 'Status', options: [{ name: 'Todo' }] }] },
    items: { totalCount: 1 } };
  assert.throws(() => assertSafeSelectFieldUpdates(project, fields), /existing cards/);
  assert.doesNotThrow(() => assertSafeSelectFieldUpdates({ ...project, items: { totalCount: 0 } }, fields));
});

test('Sprint and views must be configured before issue seeding', () => {
  assert.throws(() => validateSprintField({ configuration: { iterations: [
    { id: 'one', title: 'Sprint 1', duration: 7 },
  ] } }), /Sprint 1 and Sprint 2/);
  assert.doesNotThrow(() => validateSprintField({ configuration: { iterations: [
    { id: 'one', title: 'Sprint 1', duration: 7 },
    { id: 'two', title: 'Sprint 2', duration: 7 },
  ] } }));
  const views = [
    { name: 'Board', layout: 'BOARD_LAYOUT', verticalGroupByFields: { nodes: [{ name: 'Status' }] } },
    { name: 'Sprint', layout: 'TABLE_LAYOUT', groupByFields: { nodes: [{ name: 'Sprint' }] } },
    { name: 'Roadmap', layout: 'ROADMAP_LAYOUT', groupByFields: { nodes: [{ name: 'Milestone' }] } },
  ];
  assert.doesNotThrow(() => validateViews(views));
  assert.throws(() => validateViews([{ ...views[0], verticalGroupByFields: { nodes: [] } },
    ...views.slice(1)]), /Board view by Status/);
  assert.throws(() => validateViews([...views, views[0]]), /Board view by Status/);
  const project = { id: 'project', number: 3, fields: { nodes: [
    { name: 'Status', id: 'status' }, { name: 'Priority', id: 'priority' },
    { name: 'Size', id: 'size' }, { name: 'Sprint', id: 'sprint' },
    { name: 'Milestone', id: 'milestone' },
  ] }, views: { nodes: views } };
  assert.throws(() => ensureViews(project, () => ({ views: { nodes: [
    { ...views[0], verticalGroupByFields: { nodes: [] } }, ...views.slice(1),
  ] } }), () => { throw Error('existing views should not be created'); }), /Board view by Status/);
});
