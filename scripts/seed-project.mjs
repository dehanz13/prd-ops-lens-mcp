#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

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
const provingTests = {
  A: [
    ['test/core.test.ts', 'test/guardrails-foundation.test.ts', 'test/stdio.test.ts'],
    ['test/core.test.ts', 'test/server.test.ts'],
    ['test/core.test.ts', 'test/guardrails-foundation.test.ts'],
    ['test/repository-guardrails.test.ts', 'test/private-denylist.test.ts'],
  ],
  B: [
    ['scripts/smoke-demo.mjs', 'test/grafana.test.ts'],
    ['test/grafana.test.ts'], ['test/grafana.test.ts'], ['test/grafana.test.ts'],
  ],
  C: [['test/uptime.test.ts'], ['test/uptime.test.ts'], ['test/uptime.test.ts']],
  D: [['test/cloudwatch.test.ts'], ['test/cloudwatch.test.ts'], ['test/cloudwatch.test.ts']],
  E: [['test/iam.test.ts'], ['test/iam.test.ts'], ['test/iam.test.ts']],
  F: [['test/posthog.test.ts'], ['test/posthog.test.ts'], ['test/posthog.test.ts']],
  G: [['test/hostinger.test.ts'], ['test/hostinger.test.ts'], ['test/ssh.test.ts']],
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

function projectState(number) {
  const data = graphql(`query { user(login:${JSON.stringify(owner)}) { projectV2(number:${number}) {
    id number title fields(first:100) { nodes {
      ... on ProjectV2Field { id name databaseId }
      ... on ProjectV2SingleSelectField { id name databaseId options { id name } }
      ... on ProjectV2IterationField { id name databaseId configuration { iterations { id title startDate duration } } }
    } } views(first:30) { nodes { id name layout } }
  } } }`);
  if (!data.user?.projectV2) throw new Error('Project lookup failed');
  return data.user.projectV2;
}

function ensureProject() {
  const projects = json(['project', 'list', '--owner', owner, '--limit', '100', '--format', 'json']);
  const found = projects.projects?.find((item) => item.title === plan.title);
  const project = found ?? json(['project', 'create', '--owner', owner, '--title', plan.title, '--format', 'json']);
  const number = project.number;
  if (!Number.isInteger(number)) throw new Error('GitHub did not return a project number');
  gh(['project', 'link', String(number), '--owner', owner, '--repo', repo]);
  const readme = `# Sprint goals\n\nSprint 1: ${plan.sprintGoals['1']}\n\nSprint 2: ${plan.sprintGoals['2']}\n\nOne-week iterations. A story is Done only after its checklist, tests, review, and merge into develop. See docs/process.md and the pinned Definition of Done issue. Planned points are not completed velocity.`;
  gh(['project', 'edit', String(number), '--owner', owner, '--visibility', 'PUBLIC', '--description', 'A public, evidence-based delivery board for the MCP server.', '--readme', readme]);
  return number;
}

function ensureFields(number) {
  let project = projectState(number);
  const get = (name) => project.fields.nodes.find((field) => field.name === name);
  if (!get('Status')) throw new Error('GitHub did not create its standard Status field');
  for (const [name, options] of [
    ['Status', ['Backlog', 'Ready', 'In progress', 'In review', 'Done']],
    ['Priority', ['P0', 'P1', 'P2']],
    ['Size', ['1', '2', '3', '5', '8']],
    ['Milestone', 'ABCDEFGHIJK'.split('')],
  ]) {
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
      graphql(`mutation { updateProjectV2Field(input:{fieldId:${JSON.stringify(field.id)},singleSelectOptions:[${optionInputs}]}) { projectV2Field { id } } }`);
    }
  }
  if (!get('Sprint')) {
    const [first, second] = sprintStartDates();
    graphql(`mutation { createProjectV2Field(input:{projectId:${JSON.stringify(project.id)},name:"Sprint",dataType:ITERATION,iterationConfiguration:{duration:7,startDate:${JSON.stringify(first)},iterations:[{title:"Sprint 1",startDate:${JSON.stringify(first)},duration:7},{title:"Sprint 2",startDate:${JSON.stringify(second)},duration:7}]}}) { projectV2Field { id } } }`);
  }
  project = projectState(number);
  const fieldNames = ['Status', 'Priority', 'Size', 'Sprint', 'Milestone'];
  for (const name of fieldNames) if (!project.fields.nodes.some((field) => field.name === name)) throw new Error(`Missing ${name} field`);
  return project;
}

function ensureViews(number, project) {
  const byName = Object.fromEntries(project.fields.nodes.map((field) => [field.name, Number(field.databaseId)]));
  for (const name of ['Status', 'Priority', 'Size', 'Sprint', 'Milestone']) {
    if (!Number.isInteger(byName[name])) throw new Error(`Missing numeric ID for ${name} field`);
  }
  const userId = json(['api', `users/${owner}`]).id;
  const path = `users/${userId}/projectsV2/${number}/views`;
  const visible = ['Status', 'Priority', 'Size', 'Sprint', 'Milestone'].map((name) => byName[name]);
  for (const view of [
    { name: 'Board', layout: 'board', filter: 'label:story', visible_fields: visible, vertical_group_by: [byName.Status] },
    { name: 'Sprint', layout: 'table', filter: 'label:story', visible_fields: visible, group_by: [byName.Sprint] },
    { name: 'Roadmap', layout: 'roadmap', filter: 'label:epic', group_by: [byName.Milestone] },
  ]) {
    if (!project.views.nodes.some((existing) => existing.name === view.name)) api('POST', path, view);
  }
}

function ensureLabels() {
  for (const [name, [color, description]] of Object.entries(labels)) {
    gh(['label', 'create', name, '--repo', repo, '--color', color, '--description', description, '--force']);
  }
}

function issueBody(milestone, story, epicNumber, storyIndex) {
  const sprint = story.sprint ? `Sprint ${story.sprint}` : 'Backlog';
  const tests = provingTests[milestone.id][storyIndex].map((path) => `\`${path}\``).join(', ');
  return `## User outcome\n\n${story.title}.\n\n## Acceptance criteria\n\n${story.criteria.map((item) => `- [ ] ${item}`).join('\n')}\n- [ ] Guardrail IDs ${story.guardrails.join(', ')} have tagged, passing tests.\n- [ ] Proving test targets: ${tests}. Create missing tests before completing this story.\n- [ ] Lint, typecheck, relevant tests, evals, secret scan, documentation, and reviewed PR meet the Definition of Done.\n\n## Planning\n\n- Epic: #${epicNumber} (Milestone ${milestone.id})\n- Guardrails: ${story.guardrails.join(', ')}\n- Priority: ${story.priority}\n- Size: ${story.size} points\n- Sprint: ${sprint}\n\n## Evidence\n\nRecord exact test results in the PR. Link it with \`Closes #issue-number\` and move this card to In review when the PR opens.\n`;
}

function epicBody(milestone, stories = []) {
  return `## Goal\n\n${milestone.goal}\n\n## Guardrails\n\n${milestone.guardrails.join(', ')}. Each story lists its exact IDs and proving tests.\n\n## Stories\n\n${stories.map((issue) => `- [ ] #${issue.number} — ${issue.title}`).join('\n') || 'Stories will be linked as they are created.'}\n\nSee the pinned Definition of Done issue before closing this epic.\n`;
}

function ensureIssue(issues, title, body, issueLabels, parent) {
  if (issues.has(title)) return issues.get(title);
  const args = ['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-',
    '--label', issueLabels.join(',')];
  if (parent) args.push('--parent', String(parent));
  const url = gh(args, body).split('\n').at(-1);
  const number = Number(url.match(/\/issues\/(\d+)$/)?.[1]);
  if (!number) throw new Error(`Issue creation returned no issue URL for ${title}`);
  const issue = { number, title, url, body };
  issues.set(title, issue);
  return issue;
}

function ensureProjectItem(number, itemUrls, issue) {
  if (!itemUrls.has(issue.url)) {
    gh(['project', 'item-add', String(number), '--owner', owner, '--url', issue.url]);
    itemUrls.add(issue.url);
  }
}

function setField(number, issue, name, value) {
  gh(['project', 'item-edit', String(number), '--owner', owner, '--url', issue.url,
    '--field', name, '--value', String(value)]);
}

function setIteration(number, issue, sprint, project) {
  const field = project.fields.nodes.find((candidate) => candidate.name === 'Sprint');
  const iteration = field.configuration.iterations.find((candidate) => candidate.title === `Sprint ${sprint}`);
  if (!iteration) throw new Error(`Missing Sprint ${sprint} iteration`);
  gh(['project', 'item-edit', String(number), '--owner', owner, '--url', issue.url,
    '--field', 'Sprint', '--iteration-id', iteration.id]);
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
  const number = ensureProject();
  const project = ensureFields(number);
  ensureViews(number, project);
  ensureLabels();
  const existing = json(['issue', 'list', '--repo', repo, '--state', 'all', '--limit', '200', '--json', 'number,title,url,body']);
  const issues = new Map(existing.map((issue) => [issue.title, issue]));
  const listed = json(['project', 'item-list', String(number), '--owner', owner, '--limit', '200', '--format', 'json']);
  const itemUrls = new Set((listed.items ?? []).map((item) => item.content?.url).filter(Boolean));
  const dod = ensureIssue(issues, 'Definition of Done', 'A story is Done only when:\n\n- [ ] Lint and typecheck pass.\n- [ ] Unit, replay, and relevant demo tests pass.\n- [ ] Evals and guardrail traceability pass.\n- [ ] Secret scan passes with no private data in the diff.\n- [ ] Public documentation and permission guidance are current.\n- [ ] A reviewed PR links the story and merges into develop.\n\nLive checks are reported separately from local and CI evidence. Completed velocity counts merged stories only.\n', ['docs', 'guardrail']);
  gh(['issue', 'pin', String(dod.number), '--repo', repo]);
  ensureProjectItem(number, itemUrls, dod);
  setField(number, dod, 'Status', 'Ready');
  for (const milestone of plan.milestones) {
    const epic = ensureIssue(issues, `Epic: ${milestone.name}`, epicBody(milestone), ['epic', 'guardrail']);
    ensureProjectItem(number, itemUrls, epic);
    setField(number, epic, 'Milestone', milestone.id);
    setField(number, epic, 'Status', 'Backlog');
    const children = [];
    for (const [storyIndex, story] of milestone.stories.entries()) {
      const storyLabels = ['story'];
      if (story.guardrails.some((id) => ['G0', 'G1', 'G9', 'G11', 'G12'].some((prefix) => id.startsWith(prefix)))) storyLabels.push('guardrail');
      if (story.title.includes('security reviewer')) storyLabels.push('security');
      if (milestone.id === 'I') storyLabels.push('evals');
      const issue = ensureIssue(issues, story.title, issueBody(milestone, story, epic.number, storyIndex), storyLabels, epic.number);
      ensureProjectItem(number, itemUrls, issue);
      setField(number, issue, 'Priority', story.priority);
      setField(number, issue, 'Size', story.size);
      setField(number, issue, 'Milestone', milestone.id);
      setField(number, issue, 'Status', story.sprint === 1 ? 'Ready' : 'Backlog');
      if (story.sprint) setIteration(number, issue, story.sprint, project);
      children.push(issue);
    }
    if (!epic.body?.includes(`- [ ] #${children[0].number}`)) {
      gh(['issue', 'edit', String(epic.number), '--repo', repo, '--body-file', '-'], epicBody(milestone, children));
    }
    process.stdout.write(`Milestone ${milestone.id}: ${children.length} linked stories\n`);
  }
  process.stdout.write(`Project seeded: https://github.com/users/${owner}/projects/${number}\n`);
}

main();
