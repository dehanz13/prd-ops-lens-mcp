#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';

const owner = 'dehanz13';
const repo = `${owner}/prd-ops-lens-mcp`;
const plan = JSON.parse(readFileSync(new URL('../project/roadmap.json', import.meta.url), 'utf8'));
const labels = {
  epic: ['7057ff', 'Milestone outcome and linked stories'],
  story: ['0e8a16', 'Testable user outcome'],
  security: ['d73a4a', 'Credential or access safety'],
  guardrail: ['b60205', 'Enforced safety invariant'],
  docs: ['0075ca', 'Public documentation'],
  evals: ['5319e7', 'Evaluation evidence'],
  'tech-debt': ['cfd3d7', 'Maintenance or investigation'],
  'good-first-issue': ['a2eeef', 'Suitable entry point for a new contributor'],
};
const legacyTitles = new Map([
  ['Epic: Host health through Grafana and public Kuma', 'Epic: VPS status with optional SSH reads'],
  ['As a security reviewer, I can verify Hostinger tokens are refused so that no owner-scoped credential enters the server',
    'As an on-call engineer, I can inspect VPS state and resource use so that I can identify host pressure'],
  ['As an on-call engineer, I can read host metrics through Grafana so that I can identify resource pressure',
    'As an on-call engineer, I can inspect recent provider actions so that I can correlate maintenance with an incident'],
  ['As an on-call engineer, I can read public Kuma status JSON so that I can distinguish reachability from host pressure',
    'As a security reviewer, I can opt into fixed SSH diagnostics so that host reads never accept arbitrary shell input'],
]);
const provingTests = {
  A: [
    ['test/core.test.ts', 'test/guardrails-foundation.test.ts', 'test/stdio.test.ts'],
    ['test/core.test.ts', 'test/server.test.ts'],
    ['test/core.test.ts', 'test/guardrails-foundation.test.ts'],
    ['test/repository-guardrails.test.ts', 'test/private-denylist.test.ts'],
    ['scripts/seed-project.mjs --plan', 'test/repository-guardrails.test.ts'],
  ],
  B: [
    ['scripts/smoke-demo.mjs', 'test/grafana.test.ts'],
    ['test/grafana.test.ts'], ['test/grafana.test.ts'], ['test/grafana.test.ts'],
  ],
  C: [['test/uptime.test.ts'], ['test/uptime.test.ts'], ['test/uptime.test.ts']],
  D: [['test/cloudwatch.test.ts'], ['test/cloudwatch.test.ts'], ['test/cloudwatch.test.ts']],
  E: [['test/iam.test.ts'], ['test/iam.test.ts'], ['test/iam.test.ts']],
  F: [['test/posthog.test.ts'], ['test/posthog.test.ts'], ['test/posthog.test.ts']],
  G: [['test/host-health.test.ts'], ['test/host-health.test.ts'], ['test/uptime.test.ts']],
  H: [['test/timeline.test.ts'], ['test/resources.test.ts'], ['test/prompts.test.ts']],
  I: [['test/evals.test.ts'], ['test/evals.test.ts'], ['test/evals.test.ts']],
  J: [['test/restart.test.ts'], ['test/restart.test.ts'], ['test/repository-guardrails.test.ts'], ['test/repository-guardrails.test.ts']],
  K: [['test/agent-usage.test.ts'], ['test/agent-usage.test.ts'], ['test/agent-usage.test.ts']],
};

function gh(args, input) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    input,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function json(args, input) {
  return JSON.parse(gh(args, input));
}

function graphql(query) {
  const result = json(['api', 'graphql', '-f', `query=${query}`]);
  if (result.errors?.length) throw new Error(`GitHub GraphQL returned ${result.errors.length} error(s)`);
  return result.data;
}

function api(method, path, body) {
  const args = ['api', '-X', method, '-H', 'X-GitHub-Api-Version: 2026-03-10', path];
  if (body !== undefined) args.push('--input', '-');
  return json(args, body === undefined ? undefined : JSON.stringify(body));
}

export function apiAll(path, run = gh) {
  const pages = JSON.parse(run(['api', '--paginate', '--slurp', '-H',
    'X-GitHub-Api-Version: 2026-03-10', path]));
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error('Paginated GitHub lookup returned an invalid response');
  }
  return pages.flat();
}

function validate() {
  const expected = 'ABCDEFGHIJK'.split('');
  if (plan.title !== 'prd-ops-lens-mcp roadmap' || plan.sprintLengthDays !== 7) {
    throw new Error('Unexpected project name or sprint length');
  }
  if (plan.milestones.map((milestone) => milestone.id).join('') !== expected.join('')) {
    throw new Error('Expected ordered milestones A through K');
  }
  const titles = new Set();
  for (const milestone of plan.milestones) {
    if (milestone.stories.length < 3 || milestone.stories.length > 6) {
      throw new Error(`Milestone ${milestone.id} needs 3–6 stories`);
    }
    if (provingTests[milestone.id]?.length !== milestone.stories.length) {
      throw new Error(`Milestone ${milestone.id} needs a test plan for each story`);
    }
    for (const story of milestone.stories) {
      if (!/^As an? .+, I can .+ so that .+/.test(story.title) || titles.has(story.title)) {
        throw new Error(`Invalid or duplicate story title in ${milestone.id}`);
      }
      titles.add(story.title);
      if (!['P0', 'P1', 'P2'].includes(story.priority) || ![1, 2, 3, 5, 8].includes(story.size)) {
        throw new Error(`Invalid priority or size in ${milestone.id}`);
      }
      if (!story.guardrails.length || !story.criteria.length ||
        story.guardrails.some((id) => !/^G\d+(?:\.\d+)?$/.test(id))) {
        throw new Error(`Missing acceptance evidence in ${milestone.id}`);
      }
    }
  }
}

function sprintStartDates() {
  // Use the first Monday on or after local project setup. Planned dates are
  // never treated as completed velocity.
  const today = new Date();
  const chicago = new Date(today.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const days = (8 - chicago.getDay()) % 7;
  chicago.setDate(chicago.getDate() + days);
  const date = (offset) => {
    const value = new Date(chicago);
    value.setDate(value.getDate() + offset);
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  };
  return [date(0), date(7)];
}

export function projectState(number) {
  const data = graphql(`query { user(login:${JSON.stringify(owner)}) { projectV2(number:${number}) {
    id number title repositories(first:100) { nodes { nameWithOwner } pageInfo { hasNextPage } }
    items { totalCount } fields(first:100) { pageInfo { hasNextPage } nodes {
      ... on ProjectV2Field { id name databaseId }
      ... on ProjectV2SingleSelectField { id name databaseId options { id name } }
      ... on ProjectV2IterationField { id name databaseId configuration { iterations { id title startDate duration } } }
    } } views(first:100) { pageInfo { hasNextPage } nodes { id name layout
      groupByFields(first:10) { nodes {
        ... on ProjectV2Field { name }
        ... on ProjectV2SingleSelectField { name }
        ... on ProjectV2IterationField { name }
      } }
      verticalGroupByFields(first:10) { nodes {
        ... on ProjectV2Field { name }
        ... on ProjectV2SingleSelectField { name }
        ... on ProjectV2IterationField { name }
      } }
    } }
  } } }`);
  if (!data.user?.projectV2) throw new Error('Project lookup failed');
  return data.user.projectV2;
}

export function selectLinkedProject(projects, inspect = projectState) {
  if (!Array.isArray(projects)) throw new Error('Project list was invalid');
  const matches = projects.filter((item) => item.title === plan.title);
  if (matches.length === 0) return null;
  const linked = matches.filter((item) => {
    if (!Number.isInteger(item.number)) throw new Error('Project number was invalid');
    const state = inspect(item.number);
    if (state.repositories?.pageInfo?.hasNextPage !== false ||
      !Array.isArray(state.repositories?.nodes)) {
      throw new Error('Project repository links could not be verified');
    }
    return state.repositories.nodes.some((linkedRepo) => linkedRepo.nameWithOwner === repo);
  });
  if (linked.length !== 1) throw new Error('Roadmap project title is ambiguous or not linked to this repository');
  return linked[0];
}

export function ensureProject(runJson = json, runGh = gh, inspect = projectState) {
  const projects = runJson(['project', 'list', '--owner', owner, '--limit', '1000', '--format', 'json']);
  if (projects.projects?.length === 1000) throw new Error('Project list may be incomplete; refusing title lookup');
  const found = selectLinkedProject(projects.projects, inspect);
  const project = found ?? runJson(['project', 'create', '--owner', owner, '--title', plan.title, '--format', 'json']);
  const number = project.number;
  if (!Number.isInteger(number)) throw new Error('GitHub did not return a project number');
  runGh(['project', 'link', String(number), '--owner', owner, '--repo', repo]);
  const readme = `# Sprint goals\n\nSprint 1: ${plan.sprintGoals['1']}\n\nSprint 2: ${plan.sprintGoals['2']}\n\nOne-week iterations. A story is Done only after its checklist, tests, review, and merge into develop. See docs/process.md and the pinned Definition of Done issue. Planned points are not completed velocity.`;
  runGh(['project', 'edit', String(number), '--owner', owner, '--visibility', 'PUBLIC', '--description', 'A public, evidence-based delivery board for the MCP server.', '--readme', readme]);
  return number;
}

function ensureFields(number) {
  let project = projectState(number);
  if (project.fields.pageInfo?.hasNextPage) throw new Error('Project field lookup was incomplete');
  if (!Number.isInteger(project.items?.totalCount)) throw new Error('Project card count was unavailable');
  const get = (name) => project.fields.nodes.find((field) => field.name === name);
  if (!get('Status')) throw new Error('GitHub did not create its standard Status field');
  const selectFields = [
    ['Status', ['Backlog', 'Ready', 'In progress', 'In review', 'Done']],
    ['Priority', ['P0', 'P1', 'P2']],
    ['Size', ['1', '2', '3', '5', '8']],
  ];
  assertSafeSelectFieldUpdates(project, selectFields);
  for (const [name, options] of selectFields) {
    if (!get(name)) {
      gh(['project', 'field-create', String(number), '--owner', owner, '--name', name,
        '--data-type', 'SINGLE_SELECT', '--single-select-options', options.join(',')]);
      project = projectState(number);
    }
    const field = get(name);
    if (field.options?.map((option) => option.name).join('|') !== options.join('|')) {
      const colors = name === 'Status' ? ['GRAY', 'BLUE', 'YELLOW', 'PURPLE', 'GREEN'] : options.map(() => 'GRAY');
      const optionInputs = options.map((option, index) =>
        `{name:${JSON.stringify(option)},color:${colors[index]},description:${JSON.stringify(option)}}`).join(',');
      graphql(`mutation { updateProjectV2Field(input:{fieldId:${JSON.stringify(field.id)},singleSelectOptions:[${optionInputs}]}) { projectV2Field { __typename } } }`);
    }
  }
  if (!get('Milestone')) throw new Error('GitHub did not provide its issue-derived Milestone field');
  if (!get('Sprint')) {
    const [first, second] = sprintStartDates();
    graphql(`mutation { createProjectV2Field(input:{projectId:${JSON.stringify(project.id)},name:"Sprint",dataType:ITERATION,iterationConfiguration:{duration:7,startDate:${JSON.stringify(first)},iterations:[{title:"Sprint 1",startDate:${JSON.stringify(first)},duration:7},{title:"Sprint 2",startDate:${JSON.stringify(second)},duration:7}]}}) { projectV2Field { __typename } } }`);
  }
  project = projectState(number);
  const fieldNames = ['Status', 'Priority', 'Size', 'Sprint', 'Milestone'];
  for (const name of fieldNames) if (!project.fields.nodes.some((field) => field.name === name)) throw new Error(`Missing ${name} field`);
  validateSprintField(project.fields.nodes.find((field) => field.name === 'Sprint'));
  return project;
}

export function assertSafeSelectFieldUpdates(project, selectFields) {
  for (const [name, options] of selectFields) {
    const field = project.fields.nodes.find((candidate) => candidate.name === name);
    if (field?.options && field.options.map((option) => option.name).join('|') !== options.join('|') &&
      project.items?.totalCount > 0) {
      throw new Error(`Refusing to replace ${name} options on a project with existing cards`);
    }
  }
}

export function validateSprintField(field) {
  const iterations = field?.configuration?.iterations;
  if (!Array.isArray(iterations) || ![1, 2].every((number) =>
    iterations.some((iteration) => iteration.title === `Sprint ${number}` &&
      iteration.duration === 7 && iteration.id))) {
    throw new Error('Sprint field needs one-week Sprint 1 and Sprint 2 iterations before issue seeding');
  }
}

export function validateViews(views) {
  for (const [name, layout, grouping, field] of [
    ['Board', 'BOARD_LAYOUT', 'verticalGroupByFields', 'Status'],
    ['Sprint', 'TABLE_LAYOUT', 'groupByFields', 'Sprint'],
    ['Roadmap', 'ROADMAP_LAYOUT', 'groupByFields', 'Milestone'],
  ]) {
    const matches = views.filter((candidate) => candidate.name === name);
    const view = matches[0];
    if (matches.length !== 1 || view.layout !== layout ||
      !view[grouping]?.nodes?.some((candidate) => candidate.name === field)) {
      throw new Error(`Configure the ${name} view by ${field} in the GitHub Project UI before issue seeding`);
    }
  }
}

export function ensureViews(project, refresh = projectState, create = graphql) {
  if (project.views.pageInfo?.hasNextPage) throw new Error('Project view lookup was incomplete');
  const byName = Object.fromEntries(project.fields.nodes.map((field) => [field.name, field.id]));
  const visible = ['Status', 'Priority', 'Size', 'Sprint', 'Milestone'].map((name) => {
    if (!byName[name]) throw new Error(`Missing ${name} field for project view`);
    return byName[name];
  });
  for (const view of [
    { name: 'Board', layout: 'BOARD_LAYOUT' },
    { name: 'Sprint', layout: 'TABLE_LAYOUT' },
    { name: 'Roadmap', layout: 'ROADMAP_LAYOUT' },
  ]) {
    if (!project.views.nodes.some((existing) => existing.name === view.name)) {
      const configuration = view.layout === 'ROADMAP_LAYOUT' ? '' : `,configuration:{visibleFieldIds:${JSON.stringify(visible)}}`;
      create(`mutation { createProjectV2View(input:{projectId:${JSON.stringify(project.id)},name:${JSON.stringify(view.name)},layout:${view.layout}${configuration}}) { projectV2View { id name layout } } }`);
    }
  }
  const current = refresh(project.number);
  if (current.views.pageInfo?.hasNextPage) throw new Error('Project view lookup was incomplete');
  validateViews(current.views.nodes);
}

function ensureLabels() {
  for (const [name, [color, description]] of Object.entries(labels)) {
    gh(['label', 'create', name, '--repo', repo, '--color', color, '--description', description, '--force']);
  }
}

function ensureMilestones() {
  const existing = apiAll(`repos/${repo}/milestones?state=all&per_page=100`);
  const byTitle = new Map(existing.map((milestone) => [milestone.title, milestone]));
  for (const milestone of plan.milestones) {
    if (!byTitle.has(milestone.id)) {
      const created = api('POST', `repos/${repo}/milestones`, {
        title: milestone.id,
        description: `${milestone.name}: ${milestone.goal}`,
      });
      byTitle.set(milestone.id, created);
    }
  }
  return byTitle;
}

function setIssueMilestone(issue, milestone, milestones) {
  if (issue.milestone?.title === milestone) return;
  api('PATCH', `repos/${repo}/issues/${issue.number}`, { milestone: milestones.get(milestone).number });
  issue.milestone = { title: milestone };
}

function issueBody(milestone, story, epicNumber, storyIndex) {
  const sprint = story.sprint ? `Sprint ${story.sprint}` : 'Backlog';
  const tests = provingTests[milestone.id][storyIndex].map((path) => `\`${path}\``).join(', ');
  return `## User outcome\n\n${story.title}.\n\n## Acceptance criteria\n\n${story.criteria.map((item) => `- [ ] ${item}`).join('\n')}\n- [ ] Guardrail IDs ${story.guardrails.join(', ')} have tagged, passing tests.\n- [ ] Proving test targets: ${tests}. Create missing tests before completing this story.\n- [ ] Lint, typecheck, relevant tests, evals, secret scan, documentation, and reviewed PR meet the Definition of Done.\n\n## Planning\n\n- Epic: #${epicNumber} (Milestone ${milestone.id})\n- Guardrails: ${story.guardrails.join(', ')}\n- Priority: ${story.priority}\n- Size: ${story.size} points\n- Sprint: ${sprint}\n\n## Evidence\n\nRecord exact test results in the PR. Link it with \`Closes #issue-number\` and move this card to In review when the PR opens.\n`;
}

function epicBody(milestone, stories = []) {
  return `## Goal\n\n${milestone.goal}\n\n## Guardrails\n\n${milestone.guardrails.join(', ')}. Each story lists its exact IDs and proving tests.\n\n## Stories\n\n${stories.map((issue) => `- [ ] #${issue.number} — ${issue.title}`).join('\n') || 'Stories will be linked as they are created.'}\n\nSee the pinned Definition of Done issue before closing this epic.\n`;
}

export function ensureIssue(issues, title, body, issueLabels, create = api, update = api) {
  if (issues.has(title)) return assertOwnedIssue(issues.get(title), title);
  const previousTitle = legacyTitles.get(title);
  if (previousTitle && issues.has(previousTitle)) {
    const issue = assertOwnedIssue(issues.get(previousTitle), previousTitle);
    update('PATCH', `repos/${repo}/issues/${issue.number}`, { title, body });
    issues.delete(previousTitle);
    Object.assign(issue, { title, body });
    issues.set(title, issue);
    return issue;
  }
  const created = create('POST', `repos/${repo}/issues`, { title, body, labels: issueLabels });
  const issue = { ...created, number: created.number, title, url: created.html_url, body, milestone: null };
  if (!issue.number || !issue.url) throw new Error(`Issue creation returned no issue URL for ${title}`);
  issues.set(title, issue);
  return issue;
}

export function indexManagedIssues(existing) {
  const managedTitles = new Set(['Definition of Done', ...legacyTitles.values()]);
  for (const milestone of plan.milestones) {
    managedTitles.add(`Epic: ${milestone.name}`);
    for (const story of milestone.stories) managedTitles.add(story.title);
  }
  const issues = new Map();
  for (const issue of existing) {
    if (!managedTitles.has(issue.title)) continue;
    if (issues.has(issue.title)) throw new Error(`Duplicate managed issue title: ${issue.title}`);
    issues.set(issue.title, issue);
  }
  for (const [title, issue] of issues) assertOwnedIssue(issue, title);
  const dod = issues.get('Definition of Done');
  if (dod && dod.state !== 'open') {
    throw new Error('Definition of Done is closed or its state is unknown; reopen it before seeding');
  }
  return issues;
}

export function ensureDefinitionOfDone(issues, body, create = api) {
  const issue = ensureIssue(issues, 'Definition of Done', body, ['docs', 'guardrail'], create);
  if (issue.state !== 'open') throw new Error('Definition of Done is closed or its state is unknown; reopen it before seeding');
  return issue;
}

export function assertOwnedIssue(issue, title) {
  if (!issue || issue.title !== title || issue.user?.login !== owner || issue.pull_request) {
    throw new Error(`Refusing to adopt an unverified existing issue: ${title}`);
  }
  return issue;
}

function projectItems(number) {
  const items = new Map();
  let cursor = null;
  do {
    const after = cursor ? `,after:${JSON.stringify(cursor)}` : '';
    const data = graphql(`query { user(login:${JSON.stringify(owner)}) { projectV2(number:${number}) {
      items(first:100${after}) { nodes { id content { ... on Issue { url } } }
        pageInfo { hasNextPage endCursor } }
    } } }`);
    const page = data.user?.projectV2?.items;
    if (!page || !Array.isArray(page.nodes)) throw new Error('Project item lookup failed');
    for (const item of page.nodes) if (item.content?.url) items.set(item.content.url, item.id);
    cursor = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
    if (page.pageInfo?.hasNextPage && !cursor) throw new Error('Project item cursor was missing');
  } while (cursor);
  return items;
}

export function ensureProjectItem(project, itemIds, issue, get = api, mutate = graphql) {
  if (itemIds.has(issue.url)) return { id: itemIds.get(issue.url), isNew: false };
  const contentId = get('GET', `repos/${repo}/issues/${issue.number}`).node_id;
  const data = mutate(`mutation { addProjectV2ItemById(input:{projectId:${JSON.stringify(project.id)},contentId:${JSON.stringify(contentId)}}) { item { id } } }`);
  const itemId = data.addProjectV2ItemById.item.id;
  itemIds.set(issue.url, itemId);
  return { id: itemId, isNew: true };
}

export function initializeCard(project, itemIds, issue, fields, add = ensureProjectItem, write = setFields) {
  const item = add(project, itemIds, issue);
  if (item.isNew) write(project, item.id, fields);
  return item.id;
}

function setFields(project, itemId, entries) {
  const mutations = entries.map(([name, value], index) => {
    const field = project.fields.nodes.find((candidate) => candidate.name === name);
    if (!field) throw new Error(`Missing ${name} field`);
    const optionId = name === 'Sprint'
      ? field.configuration.iterations.find((iteration) => iteration.title === `Sprint ${value}`)?.id
      : field.options.find((option) => option.name === String(value))?.id;
    if (!optionId) throw new Error(`Missing ${name} option ${value}`);
    const valueInput = name === 'Sprint'
      ? `{iterationId:${JSON.stringify(optionId)}}`
      : `{singleSelectOptionId:${JSON.stringify(optionId)}}`;
    return `field${index}: updateProjectV2ItemFieldValue(input:{projectId:${JSON.stringify(project.id)},itemId:${JSON.stringify(itemId)},fieldId:${JSON.stringify(field.id)},value:${valueInput}}) { projectV2Item { id } }`;
  });
  if (mutations.length) graphql(`mutation { ${mutations.join(' ')} }`);
}

function main() {
  validate();
  const stories = plan.milestones.flatMap((milestone) => milestone.stories);
  if (process.argv.includes('--plan')) {
    const points = (sprint) => stories.filter((story) => story.sprint === sprint).reduce((sum, story) => sum + story.size, 0);
    process.stdout.write(`Roadmap valid: ${plan.milestones.length} epics, ${stories.length} stories; Sprint 1 planned ${points(1)} points; Sprint 2 planned ${points(2)} points. Completed velocity is not yet known.\n`);
    return;
  }
  if (!process.argv.includes('--apply')) throw new Error('Use --plan to inspect or --apply to create public GitHub resources');
  gh(['auth', 'status']);
  const existing = apiAll(`repos/${repo}/issues?state=all&per_page=100`)
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({ ...issue, url: issue.html_url }));
  const issues = indexManagedIssues(existing);
  const issuesOnly = process.argv.includes('--issues-only');
  const number = issuesOnly ? undefined : ensureProject();
  const project = issuesOnly ? undefined : ensureFields(number);
  if (project) ensureViews(project);
  ensureLabels();
  const milestones = ensureMilestones();
  const itemIds = project ? projectItems(number) : new Map();
  const dod = ensureDefinitionOfDone(issues, 'A story is Done only when:\n\n- [ ] Lint and typecheck pass.\n- [ ] Unit, replay, and relevant demo tests pass.\n- [ ] Evals and guardrail traceability pass.\n- [ ] Secret scan passes with no private data in the diff.\n- [ ] Public documentation and permission guidance are current.\n- [ ] A reviewed PR links the story and merges into develop.\n\nLive checks are reported separately from local and CI evidence. Completed velocity counts merged stories only.\n');
  if (project) {
    gh(['issue', 'pin', String(dod.number), '--repo', repo]);
    initializeCard(project, itemIds, dod, [['Status', 'Ready']]);
  }
  const resumeAt = process.argv.find((argument) => argument.startsWith('--resume-at='))?.split('=')[1];
  const onlyMilestone = process.argv.find((argument) => argument.startsWith('--only-milestone='))?.split('=')[1];
  if ([resumeAt, onlyMilestone].some((id) => id && !/^[A-K]$/.test(id))) throw new Error('Invalid milestone filter');
  for (const milestone of plan.milestones) {
    if (resumeAt && milestone.id < resumeAt) continue;
    if (onlyMilestone && milestone.id !== onlyMilestone) continue;
    const epic = ensureIssue(issues, `Epic: ${milestone.name}`, epicBody(milestone), ['epic', 'guardrail']);
    if (project) {
      initializeCard(project, itemIds, epic, [['Status', 'Backlog']]);
    }
    setIssueMilestone(epic, milestone.id, milestones);
    const children = [];
    for (const [storyIndex, story] of milestone.stories.entries()) {
      const storyLabels = ['story'];
      if (story.guardrails.some((id) => ['G0', 'G1', 'G9', 'G11', 'G12'].some((prefix) => id.startsWith(prefix)))) storyLabels.push('guardrail');
      if (story.title.includes('security reviewer')) storyLabels.push('security');
      if (milestone.id === 'I') storyLabels.push('evals');
      const issue = ensureIssue(issues, story.title, issueBody(milestone, story, epic.number, storyIndex), storyLabels);
      if (project) {
        initializeCard(project, itemIds, issue, [
          ['Priority', story.priority],
          ['Size', story.size],
          ['Status', story.sprint === 1 ? 'Ready' : 'Backlog'],
          ...(story.sprint ? [['Sprint', story.sprint]] : []),
        ]);
      }
      setIssueMilestone(issue, milestone.id, milestones);
      children.push(issue);
    }
    if (children.some((issue) => !epic.body?.includes(`- [ ] #${issue.number}`))) {
      epic.body = epicBody(milestone, children);
      api('PATCH', `repos/${repo}/issues/${epic.number}`, { body: epic.body });
    }
    process.stdout.write(`Milestone ${milestone.id}: ${children.length} linked stories\n`);
  }
  process.stdout.write(issuesOnly ? 'Issue plan seeded; Project cards remain to reconcile.\n'
    : `Project seeded: https://github.com/users/${owner}/projects/${number}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
