import { createHash } from 'node:crypto';
import { validateQuestionForm } from './question-form.js';

const envelope = /\n<!-- triage-team-questions:v1 ([A-Za-z0-9+/]+={0,2}) -->\n?$/;

function parsePayload(body) {
  const encoded = typeof body === 'string' && envelope.exec(body)?.[1];
  if (!encoded) return null;
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.toString('base64') !== encoded) return null;
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
  catch { return null; }
}

export function appendPayload(body, payload) {
  return `${body.trimEnd()}\n<!-- triage-team-questions:v1 ${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')} -->`;
}

const identifier = (v) => typeof v === 'string' && /^[\w=+/-]{1,200}$/.test(v);

export function parseQuestion(draft) {
  const payload = parsePayload(draft?.body);
  if (payload?.kind !== 'question' || !identifier(payload.sendId) ||
      typeof payload.recipient !== 'string' || !/^[a-z\d][a-z\d-]{0,38}$/i.test(payload.recipient) ||
      !validateQuestionForm(payload.form)) return null;
  return { ...payload, revision: createHash('sha256').update(draft.body).digest('hex') };
}

export function parseResponse(draft) {
  const payload = parsePayload(draft?.body);
  if (payload?.kind !== 'response' || !identifier(payload.questionId) ||
      !identifier(payload.submissionId) || typeof payload.revision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(payload.revision) || !payload.answers ||
      typeof payload.answers !== 'object' || Array.isArray(payload.answers)) return null;
  return payload;
}

const draftFields = `
  id fullDatabaseId createdAt updatedAt isArchived
  content {
    __typename
    ... on DraftIssue {
      title body creator { login }
      assignees(first: 2) { nodes { login } totalCount }
    }
  }
`;

function draftItem(item, project) {
  const draft = item?.content;
  if (draft?.__typename !== 'DraftIssue') return null;
  const url = new URL(project.url);
  url.searchParams.set('pane', 'issue');
  if (item.fullDatabaseId) url.searchParams.set('itemId', item.fullDatabaseId);
  return {
    id: item.id, project: project.id, title: draft.title, body: draft.body, creator: draft.creator?.login ?? null,
    assignees: (draft.assignees?.nodes ?? []).map((a) => a?.login).filter(Boolean),
    assigneeCount: draft.assignees?.totalCount,
    createdAt: item.createdAt, updatedAt: item.updatedAt, archived: item.isArchived,
    url: item.fullDatabaseId ? url.toString() : null,
  };
}

export class GitHubProjectsApi {
  constructor({ base = 'https://api.github.com', token, owner, number, fetch = globalThis.fetch } = {}) {
    this.endpoint = `${base.replace(/\/+$/, '').replace(/\/api\/v3$/, '/api')}/graphql`;
    this.token = token;
    this.owner = owner;
    this.number = number;
    this.fetch = fetch;
  }

  async graphql(query, variables = {}) {
    const response = await this.fetch(this.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const error = new Error(`GitHub Projects request returned HTTP ${response.status}`);
      error.definite = [400, 401, 403, 404, 422, 429].includes(response.status);
      throw error;
    }
    const result = await response.json();
    const { data, errors } = result;
    if (errors?.length || !data) {
      const error = new Error(errors?.[0]?.message || 'GitHub Projects returned no data');
      error.definite = Boolean(errors?.length && errors.every(({ path, type }) =>
        !path && (!Object.hasOwn(result, 'data') || (data === null && type === 'RATE_LIMITED'))));
      throw error;
    }
    return data;
  }

  async whoami() {
    const { viewer } = await this.graphql('query QuestionsViewer { viewer { login } }');
    if (!viewer?.login) throw new Error('GitHub Projects could not resolve the authenticated login');
    return viewer.login;
  }

  async getProject() {
    const { organization } = await this.graphql(`
      query QuestionsProject($owner: String!, $number: Int!) {
        organization(login: $owner) { projectV2(number: $number) { id url public } }
      }
    `, { owner: this.owner, number: this.number });
    const project = organization?.projectV2;
    if (!project?.id || !project.url) throw new Error(`Cannot read GitHub Project ${this.owner}/${this.number}`);
    if (project.public !== false) throw new Error(`GitHub Project ${this.owner}/${this.number} must be private`);
    return project;
  }

  async listDrafts(project) {
    project ??= await this.getProject();
    const drafts = new Map();
    const cursors = new Set();
    let after = null;
    do {
      const { node } = await this.graphql(`
        query QuestionsDrafts($id: ID!, $after: String) {
          node(id: $id) {
            ... on ProjectV2 {
              items(first: 50, after: $after) {
                nodes { ${draftFields} }
                pageInfo { endCursor hasNextPage }
              }
            }
          }
        }
      `, { id: project.id, after });
      const { nodes, pageInfo } = node?.items ?? {};
      if (!Array.isArray(nodes) || typeof pageInfo?.hasNextPage !== 'boolean') throw new Error('GitHub Projects returned an incomplete item page');
      for (const item of nodes) {
        const draft = draftItem(item, project);
        if (draft) drafts.set(draft.id, draft);
      }
      after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
      if (pageInfo.hasNextPage && (!after || cursors.has(after))) throw new Error('GitHub Projects pagination did not advance');
      cursors.add(after);
    } while (after);
    return [...drafts.values()];
  }

  async getDraft(id) {
    const project = await this.getProject();
    const { node } = await this.graphql(`
      query QuestionsDraft($id: ID!) {
        node(id: $id) { ... on ProjectV2Item { project { id } ${draftFields} } }
      }
    `, { id });
    return node?.project?.id === project.id ? draftItem(node, project) : null;
  }

  async createDraft({ title, body }) {
    let project;
    try { project = await this.getProject(); }
    catch (error) { error.definite = true; throw error; }
    const { addProjectV2DraftIssue } = await this.graphql(`
      mutation QuestionsCreateDraft($input: AddProjectV2DraftIssueInput!) {
        addProjectV2DraftIssue(input: $input) { projectItem { ${draftFields} } }
      }
    `, { input: { projectId: project.id, title, body } });
    const draft = draftItem(addProjectV2DraftIssue?.projectItem, project);
    if (!draft?.id || !draft.url) throw new Error('GitHub Projects did not return a draft receipt');
    return draft;
  }
}
