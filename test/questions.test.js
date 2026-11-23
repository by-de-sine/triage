import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webhookClient } from '../deliver/notify.js';
import { SlackDelivery } from '../deliver/slack.js';
import { createActor } from '../lib/actions.js';
import { appendPayload, GitHubProjectsApi, parseResponse } from '../lib/github-projects.js';
import { Runner } from '../lib/runner.js';
import { Store } from '../lib/store.js';
import rules from '../rules/questions.js';
import { createQuestionSubmitter } from '../sources/question-submission.js';
import questions from '../sources/questions.js';
import { demoQuestions, form } from './fake-questions.js';

const runner = (store, user, api, deliver) => new Runner(store, [questions], {
  user, rules: { questions: rules }, extras: { questions: { api } }, deliver,
});

test('a response survives delayed GitHub visibility and alerts the offline sender once after restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-questions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'sender.db');
  const api = demoQuestions();
  const recipientDb = join(dir, 'recipient.db');
  let recipientStore = new Store(recipientDb);
  t.after(() => recipientStore.close());
  const delivered = [];
  const webhook = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    delivered.push(JSON.parse(body));
    res.end('ok');
  });
  await new Promise((resolve, reject) => webhook.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => webhook.close());
  const webhookUrl = `http://127.0.0.1:${webhook.address().port}/`;
  const delivery = (store) => new SlackDelivery(store, {
    mode: 'webhook', notify: 'generic', quiet: '', webhookUrl, client: webhookClient(webhookUrl),
  });

  const initialSender = new Store(db);
  assert.equal((await runner(initialSender, 'ann', api, delivery(initialSender)).run('questions')).ok, true);
  initialSender.close();
  await runner(recipientStore, 'alice', api).run('questions');
  const [item] = recipientStore.items();
  assert.equal(item.kind, 'question');

  let visible = false;
  let writes = 0;
  const submit = createQuestionSubmitter({
    login: 'alice',
    api: {
      ...api,
      async listDrafts() {
        const drafts = await api.listDrafts();
        return visible ? drafts : drafts.slice(0, 1);
      },
      async createDraft(input) {
        writes++;
        await api.createDraft(input);
        throw new Error('connection closed after accepting the draft');
      },
    },
  });
  const actor = () => createActor({ store: recipientStore, submissions: { questions: submit } });
  const request = {
    id: item.id, action: 'submit', revision: item.data.revision, submissionId: randomUUID(),
    answers: { format: { selected: ['CSV'], note: 'Use the export preset.' }, filename: { text: 'team.csv' } },
  };
  await assert.rejects(actor()(request), { status: 502, message: /could not confirm/ });
  assert.equal(recipientStore.item(item.id).state, 'open');
  recipientStore.close();
  recipientStore = new Store(recipientDb);
  const act = actor();
  await assert.rejects(act({ ...request, submissionId: randomUUID() }), { status: 502, message: /could not confirm/ });
  assert.equal(writes, 1);
  visible = true;
  const first = await act(request);
  assert.equal(first.item.state, 'done');
  assert.deepEqual((await act({ ...request, submissionId: randomUUID() })).receipt, first.receipt);
  assert.equal(recipientStore.actionsFor(item.id).filter(({ action }) => action === 'submit').length, 1);
  const drafts = await api.listDrafts();
  assert.equal(drafts.length, 2);
  assert.equal(drafts[1].creator, 'alice');
  assert.match(drafts[1].body, /Note: Use the export preset\./);
  const response = parseResponse(drafts[1]);
  assert.equal(response.answers.filename.text, 'team.csv');
  const unrelated = await api.createDraft({ title: 'Another member’s response', body: appendPayload('', {
    ...response, submissionId: randomUUID(),
  }) });
  unrelated.creator = 'other-member';

  const restartedSender = new Store(db);
  t.after(() => restartedSender.close());
  const sender = runner(restartedSender, 'ann', api, delivery(restartedSender));
  const result = await sender.run('questions');
  assert.equal(result.delivered, 1, result.decisions[0]?.note);
  assert.equal(result.decisions[0].rule, 'question_reply');
  assert.equal(delivered[0].item.url, first.receipt.url);
  assert.equal((await sender.run('questions')).delivered, 0);
  const newSender = new Store();
  t.after(() => newSender.close());
  assert.equal((await runner(newSender, 'ann', api, delivery(newSender)).run('questions')).delivered, 0);
  assert.equal(delivered.length, 1);
});

test('changed assignments and denied writes keep the question open', async (t) => {
  const api = demoQuestions();
  const store = new Store();
  t.after(() => store.close());
  await runner(store, 'alice', api).run('questions');
  const [item] = store.items();
  let writable = false;
  const submit = createQuestionSubmitter({
    login: 'alice',
    api: {
      ...api,
      async createDraft(input) {
        if (!writable) throw Object.assign(new Error('write denied'), { definite: true });
        return api.createDraft(input);
      },
    },
  });
  const act = createActor({ store, submissions: { questions: submit } });
  const request = { id: item.id, action: 'submit', revision: item.data.revision, submissionId: randomUUID(), answers: {} };
  await assert.rejects(act(request), { status: 502, message: /write access/ });
  const [draft] = await api.listDrafts();
  const original = draft.body;
  draft.body = `Edited question\n${original}`;
  await assert.rejects(act(request), { status: 409, message: /questions changed/ });
  draft.body = original;
  draft.assigneeCount = 2;
  await assert.rejects(act(request), { status: 409, message: /no longer assigned/ });
  assert.equal((await api.listDrafts()).length, 1);
  assert.equal(store.item(item.id).state, 'open');
  assert.deepEqual(store.actionsFor(item.id), []);
  draft.assigneeCount = 1;
  writable = true;
  assert.equal((await act(request)).item.state, 'done');
  assert.equal((await api.listDrafts()).length, 2);
});

test('GitHub request rejections are retryable and execution errors remain ambiguous', async () => {
  const cases = [
    [{ data: null, errors: [{ type: 'RATE_LIMITED', message: 'Rate limit exceeded' }] }, true],
    [{ errors: [{ message: 'Invalid input' }] }, true],
    [{ data: null, errors: [{ path: ['addProjectV2DraftIssue'], message: 'Execution failed' }] }, false],
    [{ data: { addProjectV2DraftIssue: { projectItem: null } }, errors: [{ message: 'Partial error' }] }, false],
  ];
  for (const [result, definite] of cases) {
    const api = new GitHubProjectsApi({ fetch: async () => Response.json(result) });
    await assert.rejects(api.graphql('mutation QuestionsCreateDraft'), { definite });
  }
});

test('the Projects reader ignores unrelated and unsupported drafts, including across pages', async () => {
  const payload = { kind: 'question', sendId: 'send-1', recipient: 'alice', form };
  const body = appendPayload(form.summary, payload);
  const draft = (id, text) => ({
    id: `ITEM_${id}`, fullDatabaseId: id, isArchived: false,
    content: {
      __typename: 'DraftIssue', title: form.title, body: text, creator: { login: 'ann' },
      assignees: { nodes: [{ login: 'alice' }], totalCount: 1 },
    },
  });
  const cursors = [];
  const api = new GitHubProjectsApi({
    owner: 'example', number: 1,
    async fetch(_url, { body: request }) {
      const { query, variables } = JSON.parse(request);
      if (query.includes('QuestionsProject')) {
        return Response.json({ data: { organization: { projectV2: {
          id: 'PROJECT_demo', public: false, url: 'https://github.com/orgs/example/projects/1',
        } } } });
      }
      cursors.push(variables.after);
      const second = variables.after === 'next';
      return Response.json({ data: { node: { items: {
        nodes: second ? [draft(3, body)] : [draft(1, 'Ordinary project draft'), draft(2, body.replace(':v1 ', ':v2 '))],
        pageInfo: { hasNextPage: !second, endCursor: second ? null : 'next' },
      } } } });
    },
  });
  const result = await questions.poll({ api, me: 'alice', now: new Date() });
  assert.deepEqual(cursors, [null, 'next']);
  assert.equal(result.batches.length, 1);
  assert.equal(result.batches[0].item.data.questionId, 'ITEM_3');
});
