const { StoryError } = require('./autoStoryRepairRouter');
const compiler = require('./autoStoryTimelineCompiler');
const { dimensions } = require('./autoStorySourceContracts');
const { requireOriginal } = require('./autoStoryAudioClassifier');
function access(v) { if (v?.accessGranted !== true) throw new StoryError('INPUT_ACCESS', 'AI chưa xác minh truy cập input của bước này.'); }
function score(value, max = 10) { if (!Number.isFinite(value) || value < 0 || value > max) throw new StoryError('INVALID_RESPONSE', 'Invalid assessment score.'); }
function rank(candidates, evidence, duration) {
  if (typeof evidence === 'number' && duration === undefined) {
    duration = evidence;
    evidence = [];
  }
  const seen = new Set();
  return candidates.map(c => {
    const { start, end } = compiler.range(c, evidence, duration);
    for (const k of dimensions) score(c.scores?.[k]);
    if (!c.title?.trim() || !c.reason?.trim() || !Array.isArray(c.strengths) || !Array.isArray(c.weaknesses)) throw new StoryError('INVALID_RESPONSE', 'Candidate assessment is incomplete.');
    const id = compiler.hash([start, end, c.title.toLowerCase()]);
    if (seen.has(id)) throw new StoryError('INVALID_RESPONSE', 'Duplicate candidate.');
    seen.add(id);
    const s = c.scores;
    const weighted = s.hookPower * 2 + s.comprehension * 1.5 + s.conflict + s.curiosity + s.escalation + s.emotion + s.payoff * 1.5 + s.visualClarity;
    const viralScore = Math.round(Math.max(0, Math.min(100, weighted - .5 * s.contextDependency - .5 * s.narrationDependency)));
    return { ...c, candidateId: id, viralScore, scoreProvenance: 'AI dimensions; locally weighted, not a view-count prediction',
      eligible: viralScore >= 60 && s.hookPower >= 6 && s.payoff >= 5 && s.comprehension >= 5 };
  }).sort((a, b) => b.viralScore - a.viralScore);
}
function audition(h, evidence, duration) {
  const hr = compiler.range(h, evidence, duration); score(h.score);
  const dur = hr.end - hr.start;
  if (dur < 2.0 || dur > 35.0) throw new StoryError('BAD_CANDIDATE', `Hook beat duration (${dur.toFixed(1)}s) outside valid range (2-35s).`);
  if (!h.completeBeat || !h.firstMoment?.trim() || !h.coldViewerTension?.trim() || !h.continuingCuriosity?.trim() || !h.completenessReason?.trim() || h.score < 6) throw new StoryError('BAD_CANDIDATE', 'Hook audition: incomplete or weak beat.');
  if (h.audioIntent !== 'narration') requireOriginal(h.audio);
}
function blueprint(b, evidence, duration) {
  for (const k of ['centralViewerQuestion', 'hookPromise', 'minimumContext', 'turningPoint', 'ending', 'reason']) {
    if (!b?.[k]?.trim()) throw new StoryError('BAD_CANDIDATE', `Blueprint missing ${k}.`);
  }
  if (!b.strongEnough || !b.sufficientAuthenticFootage) throw new StoryError('BAD_CANDIDATE', `Blueprint rejected by source inspector: ${b.reason}`);
  try {
    compiler.range(b.climax, evidence, duration);
    compiler.range(b.payoff, evidence, duration);
    if (!Array.isArray(b.footage) || !b.footage.length) throw new StoryError('BAD_CANDIDATE', 'Blueprint contains no source footage.');
    b.footage.forEach(f => compiler.range(f, evidence, duration));
  } catch (err) {
    throw new StoryError('BAD_CANDIDATE', `Blueprint range error: ${err.message}`);
  }
}
function semantic(a) {
  for (const k of ['hookQuality', 'storyClarity', 'informationGain', 'storyProgression', 'escalation', 'payoff', 'narrationDependency', 'procedureDensity', 'reactionDensity']) score(a?.[k]);
  if (!Array.isArray(a.deadStorySpans) || !Array.isArray(a.duplicateMeaning) || !a.reason?.trim()) throw new StoryError('INVALID_RESPONSE', 'Missing semantic assessment.');
  if (!a.grounded || !a.fulfillsPromise || !a.coherentOpening || a.hookQuality < 6 || a.storyClarity < 6 || a.payoff < 6
    || a.deadStorySpans.length || a.duplicateMeaning.length) throw new StoryError('STRUCTURAL_STORY', `Pre-render story gate: ${a.reason}`, { assessment: a });
  return a;
}
function coverage(range, decisions, evidence, duration, role) {
  const rangeBounds = compiler.range(range, evidence, duration);
  const targetDuration = rangeBounds.end - rangeBounds.start;
  const spans = decisions.filter(d => !role || d.storyRole === role)
    .map(d => compiler.range(d, evidence, duration))
    .sort((a, b) => a.start - b.start);
  if (!spans.length) return false;
  let totalOverlap = 0;
  for (const s of spans) {
    const oStart = Math.max(s.start, rangeBounds.start);
    const oEnd = Math.min(s.end, rangeBounds.end);
    if (oEnd > oStart) totalOverlap += (oEnd - oStart);
  }
  const required = targetDuration <= 8 ? Math.max(1.5, targetDuration - 2.5) : Math.min(targetDuration * 0.4, 10);
  return totalOverlap >= required;
}
function layout(value, story, evidence, config, duration) {
  access(value);
  if (!Array.isArray(value.decisions) || !value.decisions.length || value.decisions.length > 50) throw new StoryError('STRUCTURAL_STORY', 'Missing or excessive editorial decisions.');
  for (const d of value.decisions) {
    const { start, end } = compiler.range(d, evidence, duration);
    if (!['original', 'narration'].includes(d.audioIntent) || !d.reason?.trim() || !['hook','context','escalation','turning_point','climax','payoff'].includes(d.storyRole)) throw new StoryError('LOCAL_EDITORIAL', 'Invalid editorial decision.');
    if (d.audioIntent === 'narration' && !config.narration.enabled) throw new StoryError('LOCAL_EDITORIAL', 'Narration disabled by user.');
    if (!evidence.some(e => start >= e.sourceStart - .001 && end <= e.sourceStart + e.duration + .001)) throw new StoryError('EVIDENCE_REQUIRED', 'Selection outside viewed source evidence.', { range: d });
  }
  const firstBody = value.decisions.findIndex(d => d.storyRole !== 'hook');
  const hooks = value.decisions.slice(0, firstBody < 0 ? value.decisions.length : firstBody);
  if (!hooks.length || !coverage(story.hook, hooks, evidence, duration)) throw new StoryError('STRUCTURAL_STORY', 'Hook does not preserve the complete auditioned source beat. Ensure your decisions with storyRole="hook" cover the entire source time range of the auditioned hook.');
  if (!coverage(story.climax, value.decisions, evidence, duration, 'climax')) throw new StoryError('STRUCTURAL_STORY', `Timeline does not deliver the source-locked climax.`);
  if (!coverage(story.payoff, value.decisions, evidence, duration, 'payoff')) throw new StoryError('STRUCTURAL_STORY', `Timeline does not deliver the source-locked payoff.`);
  compiler.validateDuration({ segments: value.decisions.map(d => {
    const bounds = compiler.range(d, evidence, duration);
    return { start: bounds.start, end: bounds.end };
  }) }, config);
  semantic(value.assessment);
}
function review(v, duration) {
  access(v); score(v.viralScore, 100); score(v.confidence, 1);
  if (!['PASS','REVISE'].includes(v.verdict) || !Array.isArray(v.issues) || !Array.isArray(v.previewSubtitleIssues)
    || v.issues.length > 12 || (v.verdict === 'PASS' && v.issues.length) || (v.verdict === 'REVISE' && !v.issues.length)) throw new StoryError('INVALID_RESPONSE', 'Inconsistent compact review.');
  for (const i of [...v.issues, ...v.previewSubtitleIssues]) if (!Number.isFinite(i.outputSec) || i.outputSec < 0 || i.outputSec > duration || !i.reason?.trim()) throw new StoryError('INVALID_RESPONSE', 'Review issue outside output video.');
}
module.exports = { access, score, rank, audition, blueprint, semantic, layout, coverage, review };
