const record = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = Infinity) => typeof value === 'string' && value.trim() && Array.from(value).length <= max;
const optionalText = (value, max) => value == null || text(value, max);
const id = (value) => typeof value === 'string' && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const only = (value, fields) => Object.keys(value).every((key) => fields.includes(key));
const commonFields = ['id', 'type', 'prompt', 'topic', 'context', 'snippet', 'recommended'];
const optionLabel = (option) => typeof option === 'string' ? option : option.label;

function validOption(option) {
  if (typeof option === 'string') return text(option, 120);
  return record(option) && only(option, ['label', 'detail', 'preview'])
    && text(option.label, 120) && optionalText(option.detail) && optionalText(option.preview);
}

function validQuestion(question) {
  if (!record(question) || !id(question.id) || !text(question.prompt, 300)
      || !optionalText(question.topic, 24) || !optionalText(question.context) || !optionalText(question.snippet)) return false;
  const { recommended } = question;
  switch (question.type) {
    case 'choice':
    case 'multi': {
      if (!only(question, [...commonFields, 'options', 'other']) || !Array.isArray(question.options)
          || question.options.length < 2 || question.options.length > 8
          || !question.options.every(validOption) || (question.other !== undefined && typeof question.other !== 'boolean')) return false;
      const labels = new Set(question.options.map(optionLabel));
      if (labels.size !== question.options.length) return false;
      if (recommended == null) return true;
      if (question.type === 'choice') return labels.has(recommended);
      return Array.isArray(recommended) && recommended.length > 0 && new Set(recommended).size === recommended.length
        && recommended.every((label) => labels.has(label));
    }
    case 'yesno':
      return only(question, commonFields) && (recommended == null || recommended === 'yes' || recommended === 'no');
    case 'text':
      return only(question, [...commonFields, 'long', 'placeholder'])
        && (question.long === undefined || typeof question.long === 'boolean')
        && optionalText(question.placeholder, 120) && optionalText(recommended);
    default:
      return false;
  }
}

export function validateQuestionForm(form) {
  return Boolean(record(form) && only(form, ['id', 'title', 'summary', 'from', 'closing', 'questions'])
    && id(form.id) && text(form.title, 80) && text(form.summary) && optionalText(form.from, 120)
    && optionalText(form.closing) && Array.isArray(form.questions)
    && form.questions.length > 0 && form.questions.length <= 20 && form.questions.every(validQuestion)
    && new Set(form.questions.map((question) => question.id)).size === form.questions.length);
}

const answerText = (value) => typeof value === 'string' && value.length <= 2000;
const badAnswer = (question) => Object.assign(new Error(`Check the answer for “${question.prompt}”.`), { status: 400 });

export function normalizeAnswers(form, answers) {
  if (!record(answers) || !only(answers, form.questions.map((question) => question.id))) {
    throw Object.assign(new Error('Answers must correspond to the questions in this form.'), { status: 400 });
  }
  return Object.fromEntries(form.questions.map((question) => {
    const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : {};
    if (!record(answer) || !only(answer, ['selected', 'other', 'text', 'note'])
        || ['other', 'text', 'note'].some((key) => Object.hasOwn(answer, key) && !answerText(answer[key]))) throw badAnswer(question);
    const { selected = [] } = answer;
    const other = answer.other?.trim() || '';
    const value = answer.text?.trim() || '';
    const note = answer.note?.trim() || '';
    const labels = question.type === 'yesno' ? ['yes', 'no'] : (question.options || []).map(optionLabel);
    if (!Array.isArray(selected) || new Set(selected).size !== selected.length || !selected.every((label) => labels.includes(label))
        || (other && (question.other === false || !question.options))
        || (question.type !== 'multi' && selected.length + Number(Boolean(other)) > 1)
        || (value && question.type !== 'text')) throw badAnswer(question);
    return [question.id, { selected: labels.filter((label) => selected.includes(label)), other, text: value, note }];
  }));
}

const readable = (value) => Array.isArray(value) ? value.join('; ') : ({ yes: 'Yes', no: 'No' })[value] || value;
const indent = (value) => value.replace(/\r?\n/g, '\n   ');
const defaultClosing = 'Continue the task with these answers. Where I skipped a question, use your recommendation and list it in your summary. Ask me again only about something that still blocks you.';

export function formatAnswers(form, answers) {
  const lines = form.questions.map((question, index) => {
    const { selected, other, text: value, note } = answers[question.id];
    const recommendation = question.recommended;
    let response = [value, ...selected.map((label) => question.type === 'yesno' ? readable(label) : label), other && `Other: ${other}`].filter(Boolean).join('; ');
    if (response) {
      const recommended = !other && recommendation != null && (Array.isArray(recommendation)
        ? recommendation.length === selected.length && recommendation.every((label) => selected.includes(label))
        : recommendation === (value || selected[0]));
      if (recommended) response += ' (your recommendation)';
    } else if (note) {
      response = 'none chosen; see note';
    } else {
      const fallback = question.type === 'yesno' ? readable(recommendation) : Array.isArray(recommendation) ? recommendation.join('; ') : recommendation;
      response = fallback ? `skipped, so use your recommendation: ${fallback}` : 'skipped, and you gave no recommendation';
    }
    return `${index + 1}. [${question.id}] ${indent(question.prompt)}\n   Answer: ${indent(response)}${note && `\n   Note: ${indent(note)}`}`;
  });
  return [`[answers: ${form.id}] ${form.title}`, 'My answers to the questions you asked. Each question’s ID is in brackets.', ...lines, form.closing ?? defaultClosing].join('\n\n');
}
