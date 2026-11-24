import { appendPayload } from '../lib/github-projects.js';

export const form = {
  id: 'export-settings',
  title: 'Report export settings (fake)',
  summary: 'The report is ready for export. Choose the export settings.',
  questions: [
    { id: 'format', type: 'choice', prompt: 'Which format should we use?', options: ['CSV', 'JSON'], recommended: 'CSV' },
    { id: 'columns', type: 'multi', prompt: 'Which columns should we include?', options: ['Date', 'Owner', 'Status'], recommended: ['Date'] },
    { id: 'archive', type: 'yesno', prompt: 'Should the export include archived records?', recommended: 'no' },
    { id: 'filename', type: 'text', prompt: 'What filename should the export use?', placeholder: 'reports.csv' },
  ],
};

export function demoQuestions() {
  const project = { id: 'PROJECT_demo', url: 'https://github.com/orgs/example/projects/1' };
  const makeDraft = ({ id, title, body, creator, assignees = [] }) => ({
    id: `ITEM_${id}`, project: project.id, title, body, creator, assignees,
    url: `${project.url}?pane=issue&itemId=${id}`,
    createdAt: new Date().toISOString(), archived: false,
  });
  const drafts = [makeDraft({
    id: 1, title: form.title, body: appendPayload('Please choose the export settings.', { kind: 'question', sendId: 'demo-1', recipient: 'alice', form }),
    creator: 'ann', assignees: ['alice'],
  })];
  return {
    owner: 'example', number: 1,
    whoami: async () => 'alice',
    getProject: async () => project,
    listDrafts: async () => [...drafts],
    getDraft: async (id) => drafts.find((draft) => draft.id === id) || null,
    createDraft: async ({ title, body }) => {
      const draft = makeDraft({ id: drafts.length + 1, title, body, creator: 'alice' });
      drafts.push(draft);
      return draft;
    },
  };
}
