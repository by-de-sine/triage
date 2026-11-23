export default [
  {
    name: 'question_reply', tier: 'P1', claim: 0.7,
    match(item, fresh) {
      const reply = fresh.find((event) => event.kind === 'question_reply');
      return reply ? `${reply.actor} answered your questions` : null;
    },
  },
  {
    name: 'question_assigned', tier: 'P1', claim: 0.65,
    match(item) {
      return item.kind === 'question' ? `${item.data.creator} sent you questions` : null;
    },
  },
  {
    name: 'ambient', tier: 'P3', claim: 0.1, fallback: true,
    match: () => 'activity on the team questions project',
  },
];
