const form = document.querySelector('#answers');
const status = document.querySelector('#status');
const button = form.querySelector('button');
const itemId = new URLSearchParams(location.search).get('id');

function newSubmissionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function showText(id, text) {
  const node = document.getElementById(id);
  node.textContent = text || '';
  node.hidden = !text;
}

function field(parent, label, value, { multiline = false, placeholder = '' } = {}) {
  const wrapper = element('label', label, 'question-field');
  const control = element(multiline ? 'textarea' : 'input');
  control.maxLength = 2000;
  control.placeholder = placeholder;
  control.value = value || '';
  wrapper.append(control);
  parent.append(wrapper);
  return control;
}

function pick(parent, question, option, checked) {
  const label = element('label', '', 'question-choice');
  const control = element('input');
  control.type = question.type === 'multi' ? 'checkbox' : 'radio';
  control.name = `choice-${question.id}`;
  control.checked = checked;
  const content = element('span', option.label);
  if (option.detail) content.append(element('small', option.detail));
  if (option.preview) content.append(element('pre', option.preview));
  label.append(control, content);
  parent.append(label);
  return control;
}

function renderQuestion(question, saved = {}) {
  const group = element('fieldset');
  group.append(element('legend', question.prompt));
  for (const text of [question.topic, question.context]) {
    if (text) group.append(element('p', text, 'muted'));
  }
  if (question.snippet) group.append(element('pre', question.snippet));
  const options = question.type === 'yesno'
    ? [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }]
    : (question.options || []).map((option) => typeof option === 'string'
      ? { label: option, value: option } : { ...option, value: option.label });
  const picks = options.map((option) => [pick(group, question, option, saved.selected?.includes(option.value)), option.value]);
  const otherPick = question.options && question.other !== false
    ? pick(group, question, { label: 'Other' }, Boolean(saved.other)) : null;
  const other = otherPick ? field(group, 'Other answer', saved.other) : null;
  if (other) {
    const syncOther = () => { other.closest('label').hidden = !otherPick.checked; };
    group.addEventListener('change', syncOther);
    syncOther();
  }
  if (picks.length && question.type !== 'multi') {
    const skip = element('button', 'Clear selection');
    skip.type = 'button';
    skip.onclick = () => {
      for (const control of group.querySelectorAll('input[type="radio"]')) control.checked = false;
      group.dispatchEvent(new Event('change'));
      form.dispatchEvent(new Event('input'));
    };
    group.append(skip);
  }
  const answer = question.type === 'text'
    ? field(group, 'Answer', saved.text, { multiline: question.long, placeholder: question.placeholder }) : null;
  if (question.recommended != null) {
    const value = question.type === 'yesno' ? options.find((option) => option.value === question.recommended).label : question.recommended;
    group.append(element('p', `Recommended: ${[].concat(value).join(', ')}`, 'muted'));
  }
  const note = field(group, 'Note (optional)', saved.note, { multiline: true });
  document.querySelector('#questions').append(group);
  return () => ({
    selected: picks.filter(([control]) => control.checked).map(([, value]) => value),
    other: otherPick?.checked ? other.value : '',
    text: answer?.value || '',
    note: note.value,
  });
}

async function json(path, options) {
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Triage could not complete the request.');
  return result;
}

function showReceipt(receipt) {
  form.hidden = true;
  status.textContent = 'Answers submitted.';
  const link = document.querySelector('#receipt');
  link.href = receipt.url;
  link.hidden = false;
  link.focus();
}

async function load() {
  if (!/^[1-9]\d*$/.test(itemId || '')) throw new Error('Open a question from the Triage queue.');
  const path = `/api/items/${itemId}`;
  const { item, actions } = await json(path);
  if (item.kind !== 'question') throw new Error('This item is not a questionnaire.');
  const { form: quiz, revision, creator, questionId, project, recipient } = item.data;
  showText('title', quiz.title);
  showText('sender', quiz.from || `From @${creator}`);
  showText('summary', quiz.summary);
  showText('closing', quiz.closing);
  document.title = `${quiz.title} · triage`;
  const submitted = actions.find(({ action, data }) => action === 'submit' && data.revision === revision);
  if (submitted) return showReceipt(submitted.data.receipt);

  const draftKey = JSON.stringify(['triage.questions', project, questionId, recipient, revision]);
  let draft = {};
  try { draft = JSON.parse(sessionStorage.getItem(draftKey)) || {}; } catch {}
  const controls = quiz.questions.map((question) => [question.id, renderQuestion(question, draft.answers?.[question.id])]);
  const answers = () => Object.fromEntries(controls.map(([id, read]) => [id, read()]));
  const save = () => {
    draft.answers = answers();
    try { sessionStorage.setItem(draftKey, JSON.stringify(draft)); } catch {}
  };
  form.oninput = save;
  form.onchange = save;
  form.hidden = false;
  status.textContent = '';
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    status.textContent = 'Submitting answers…';
    try {
      draft.submissionId ||= newSubmissionId();
      save();
      const { receipt } = await json(`${path}/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'submit', by: 'web', revision, ...draft }),
      });
      try { sessionStorage.removeItem(draftKey); } catch {}
      showReceipt(receipt);
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
}

load().catch((error) => { status.textContent = error.message; });
