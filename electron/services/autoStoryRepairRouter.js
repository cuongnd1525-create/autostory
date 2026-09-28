class StoryError extends Error {
  constructor(kind, message, details = {}) { super(message); this.name = 'StoryError'; this.kind = kind; this.details = details; }
}
function route(issues, total = 1) {
  if (issues instanceof StoryError) return issues.kind;
  const list = Array.isArray(issues) ? issues : [];
  if (list.some(i => i.type === 'candidate')) return 'BAD_CANDIDATE';
  if (list.some(i => ['structure', 'promise', 'factual'].includes(i.type)) || list.length > 4 || list.length > Math.max(2, total * .35)) return 'STRUCTURAL_STORY';
  return list.length <= 1 ? 'LOCAL_EDITORIAL' : 'REGIONAL_EDITORIAL';
}
function assertPatchSize(changes, total) {
  if (changes > 4 || changes > Math.max(2, total * .35)) throw new StoryError('STRUCTURAL_STORY', 'Repair changes too much of the story; rebuild from the blueprint.', { changes, total });
}
module.exports = { StoryError, route, assertPatchSize };
