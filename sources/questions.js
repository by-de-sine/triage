import { parseQuestion, parseResponse } from '../lib/github-projects.js';
import { sameLogin } from '../lib/util.js';

function addressedTo(draft, recipient) {
  return draft.assignees.length === 1 && (draft.assigneeCount ?? 1) === 1 && sameLogin(draft.assignees[0], recipient);
}

export default {
  name: 'questions',
  every: 60_000,
  describe: 'team questions and answers in a private GitHub Project',
  project: (item) => item.repo,
  time: (item) => item.kind === 'question' ? 'waiting' : 'flat',

  async poll({ api, cursor, me, now }) {
    const project = await api.getProject();
    const drafts = await api.listDrafts(project);
    const scope = api.owner && api.number ? `${api.owner}/${api.number}` : project.id;
    const sameConnection = cursor?.project === project.id && sameLogin(cursor.login, me);
    const knownReplies = new Set(sameConnection ? cursor.replies : []);
    const questions = new Map();
    for (const draft of drafts) {
      const question = parseQuestion(draft);
      if (question && draft.creator) questions.set(draft.id, { draft, question });
    }
    const batches = [];
    const answered = new Set();
    const nowIso = now.toISOString();
    for (const draft of drafts) {
      const response = parseResponse(draft);
      const original = response && questions.get(response.questionId);
      if (!draft.url || !original || original.question.revision !== response.revision ||
          !sameLogin(draft.creator, original.question.recipient)) continue;
      answered.add(response.questionId);
      if (!sameLogin(original.draft.creator, me)) continue;
      const key = `questions:${project.id}:reply:${response.questionId}:${response.submissionId}`;
      if (knownReplies.has(key)) continue;
      knownReplies.add(key);
      if (!sameConnection) continue;
      const submittedAt = draft.createdAt || nowIso;
      batches.push({
        item: {
          key, kind: 'question_reply', title: `Answers: ${original.draft.title}`, url: draft.url,
          repo: scope, actors: [draft.creator], my_role: 'authored',
          last_activity: submittedAt, last_seen: nowIso,
          data: { project: project.id, questionId: response.questionId, submissionId: response.submissionId },
        },
        events: [{ key, kind: 'question_reply', ts: submittedAt, actor: draft.creator, url: draft.url,
          data: { submittedAt: draft.createdAt || null } }],
      });
    }
    const pending = {};
    for (const [questionId, { draft, question }] of questions) {
      if (draft.archived || !sameLogin(me, question.recipient) || !addressedTo(draft, question.recipient) || answered.has(questionId)) continue;
      const key = `questions:${project.id}:question:${questionId}`;
      const prior = sameConnection ? cursor.pending?.[key] : null;
      const since = prior?.revision === question.revision ? prior.since : draft.createdAt || nowIso;
      pending[key] = { revision: question.revision, since };
      batches.push({
        item: {
          key, kind: 'question', title: draft.title, url: draft.url, repo: scope,
          actors: [draft.creator], my_role: 'owner', last_activity: since, last_seen: nowIso,
          data: { project: project.id, questionId, form: question.form, revision: question.revision,
            creator: draft.creator, recipient: question.recipient },
        },
        events: [{ key: `${key}:${question.revision}`, kind: 'question', ts: since, actor: draft.creator, url: draft.url }],
      });
    }
    const count = Object.keys(pending).length;
    return {
      batches, cursor: { project: project.id, login: me, pending, replies: [...knownReplies], read_at: nowIso },
      status: `${count} unanswered, ${knownReplies.size} known replies`,
    };
  },

  reconcile({ cursor }) {
    if (!cursor?.project) return null;
    return {
      keys: Object.keys(cursor.pending),
      complete: true,
      governs: (item) => item.kind === 'question' && item.data?.project === cursor.project,
    };
  },

  describeCursor(cursor) {
    return { unanswered: Object.keys(cursor.pending).length, replies: cursor.replies.length, read_at: cursor.read_at };
  },
};
