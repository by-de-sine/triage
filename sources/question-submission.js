import { appendPayload, parseQuestion, parseResponse } from '../lib/github-projects.js';
import { formatAnswers, normalizeAnswers } from '../lib/question-form.js';
import { sameLogin } from '../lib/util.js';

const failure = (status, message) => Object.assign(new Error(message), { status });
const unconfirmed = () => failure(502, 'Triage could not confirm the response on GitHub. Your draft is still here. Submit again to check for a receipt.');

function confirmedResponse(draft, questionId, revision, login) {
  if (!sameLogin(draft?.creator, login) || !draft.url) return null;
  const response = parseResponse(draft);
  if (!response || response.questionId !== questionId || response.revision !== revision) return null;
  return { url: draft.url, submissionId: response.submissionId };
}

export function createQuestionSubmitter({ api, login }) {
  return async ({ item, revision, submissionId, answers, beginWrite, clearWrite }) => {
    const { questionId, project, recipient, creator } = item.data;
    if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision) || revision !== item.data.revision) {
      throw failure(409, 'These questions changed. Reload the latest version before submitting.');
    }
    if (typeof submissionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(submissionId)) {
      throw failure(400, 'A submission ID is required.');
    }
    if (!sameLogin(recipient, login)) throw failure(403, 'These questions are assigned to another GitHub account.');

    const recover = async () => {
      for (const draft of await api.listDrafts()) {
        const receipt = confirmedResponse(draft, questionId, revision, login);
        if (receipt) return receipt;
      }
      return null;
    };

    let pending;
    try {
      const currentProject = await api.getProject();
      if (currentProject.id !== project) throw failure(409, 'These questions belong to another GitHub Project.');
      pending = await api.getDraft(questionId);
    } catch (error) {
      if (error.status === 409) throw error;
      throw failure(502, 'Triage could not read the questions on GitHub. Your draft is still here.');
    }
    const question = pending && parseQuestion(pending);
    if (!question || pending.archived || !sameLogin(pending.creator, creator) || !sameLogin(question.recipient, login)
        || pending.assignees.length !== 1 || (pending.assigneeCount ?? 1) !== 1 || !sameLogin(pending.assignees[0], login)) {
      throw failure(409, 'These questions are no longer assigned to you.');
    }
    if (question.revision !== revision) throw failure(409, 'These questions changed. Reload the latest version before submitting.');

    const normalized = normalizeAnswers(question.form, answers);
    const body = appendPayload(formatAnswers(question.form, normalized), { kind: 'response', questionId, revision, submissionId, answers: normalized });
    if (body.length > 65_536) throw failure(400, 'These answers are too long for GitHub. Shorten them before submitting.');

    let previous;
    try { previous = await recover(); } catch {
      throw failure(502, 'Triage could not check for an existing response on GitHub. Try submitting again.');
    }
    if (previous) return previous;
    if (!beginWrite()) throw unconfirmed();

    try {
      const draft = await api.createDraft({ title: `Answers: ${question.form.title}`, body });
      const receipt = confirmedResponse(draft, questionId, revision, login);
      if (receipt) return receipt;
    } catch (error) {
      if (error.definite) {
        clearWrite();
        throw failure(502, 'GitHub rejected the response. Check your Project write access and GitHub API limits before retrying.');
      }
    }

    try {
      const recovered = await recover();
      if (recovered) return recovered;
    } catch {}
    throw unconfirmed();
  };
}
