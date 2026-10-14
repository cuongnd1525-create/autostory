// Independent, source-grounded opening audition for V4 Editorial Director.
// The Director chooses the story; this guard checks the actual source frames.
const fs = require('fs/promises');
const path = require('path');
const { StoryError } = require('./autoStoryRepairRouter');
const schema = {
  type: 'object', additionalProperties: false,
  required: ['accessGranted', 'sourceVerified', 'firstSecondsObserved',
    'immediateCuriosity', 'misleadingOrSpoiled', 'startsMidSentenceWithoutContext',
    'specificUnansweredQuestion', 'promiseSupportedBySource', 'reason'],
  properties: {
    accessGranted: { type: 'boolean' },
    sourceVerified: { type: 'boolean' },
    firstSecondsObserved: { type: 'string' },
    immediateCuriosity: { type: 'boolean' },
    misleadingOrSpoiled: { type: 'boolean' },
    startsMidSentenceWithoutContext: { type: 'boolean' },
    specificUnansweredQuestion: { type: 'string' },
    promiseSupportedBySource: { type: 'boolean' },
    reason: { type: 'string' }
  }
};
function judge(result) {
  if (!result?.accessGranted || !result?.firstSecondsObserved?.trim() || !result?.reason?.trim()) {
    throw new StoryError('INVALID_RESPONSE', 'V4 hook audition must describe the actual watched source footage.');
  }
  const reasons = [];
  if (!result.sourceVerified) reasons.push('Source image/audio does not substantiate the opening claim.');
  if (!result.immediateCuriosity) reasons.push('The first source seconds do not immediately establish curiosity or visible stakes.');
  if (result.misleadingOrSpoiled) reasons.push('Opening distorts the source or spends the protected payoff.');
  if (result.startsMidSentenceWithoutContext) reasons.push('Opening begins mid-sentence without enough context for a cold viewer.');
  if (!result.promiseSupportedBySource) reasons.push('Hook promise is not substantiated by the source footage.');
  if (!String(result.specificUnansweredQuestion || '').trim()) reasons.push('Opening does not establish any specific question or stakes.');
  return { accepted: reasons.length === 0, reasons };
}
async function verify(engine, story, { emit = () => {} } = {}) {
  if (!Array.isArray(story?.beats) || !story.beats.length) {
    throw new StoryError('DIRECTOR_REPAIR_REQUIRED', 'Cannot audition an empty Director hook.');
  }
  if (!engine?.service?.vertex) return { skipped: true, reason: 'No configured Vertex provider (unit-test engine).' };
  const first = story.beats[0];
  const start = Number(first.sourceStartSec), end = Number(first.sourceEndSec);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new StoryError('DIRECTOR_REPAIR_REQUIRED', 'Director opening has an invalid source range.');
  }
  const actualEnd = Math.min(engine.duration, end, start + 6);
  const evidence = await engine.prepare([{ sourceStartSec: start, sourceEndSec: actualEnd }], 0, 12);
  const id = Number(story.scriptId) || 1;
  // Payoff was independently verified against the REAL ending before the EDL.
  // The first six seconds are a teaser, not a self-contained proof of the
  // eventual outcome. Only trust a verdict with the matching scope ID.
  let verifiedPayoff = null;
  if (engine.root && story.storyScope?.storyScopeId) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(engine.root, `payoff-verification-${id}.json`), 'utf8'));
      if (data.scopeId === story.storyScope.storyScopeId && data.verdict?.accepted === true) {
        verifiedPayoff = { observedEnding: data.verdict.observedEnding,
          outcomeType: data.response?.outcomeType || null,
          promiseSupportedByEnding: data.response?.promiseSupportedByEnding === true };
      }
    } catch (_) { /* No independent payoff artifact; the audit must not assume it. */ }
  }
  const verdict = await engine.ask(`v4-hook-audition-${id}`, {
    storyScope: story.storyScope?.centralConflict || '',
    centralViewerQuestion: story.centralViewerQuestion || '',
    hookPromise: story.hookPromise || '',
    mustWithhold: story.storyScope?.mustWithhold || [],
    verifiedPayoff,
    // Candidate starts are editorial hints, NOT guaranteed high-quality footage.
    otherHookCandidates: (story.storyScope?.hookCandidates || []).slice(0, 4),
    opening: { sourceStartSec: start, sourceEndSec: actualEnd, narrativeRole: first.narrativeRole, observedInFootage: first.observedInFootage }
  }, schema,
  'WATCH the attached 6s opening clip WITH audio. Report literally what the viewer sees/hears in the FIRST 3 seconds. This is a TEASER, NOT the ending: a factual question may remain unresolved; do NOT require the first clip to show or confirm the eventual outcome. INPUT.verifiedPayoff, if provided, comes from an INDEPENDENT source-ending verification; use it ONLY to assess whether hookPromise is honest about what the complete scoped story can deliver, NEVER as proof of an opening action not present in the clip. For sourceVerified, check the literal opening shot/words against opening.observedInFootage. For promiseSupportedBySource, check the actual hook wording against BOTH what the opening establishes and the independently verified payoff; an honest unresolved question can be supported even though the answer comes later. Without verifiedPayoff, do not assume future discoveries just from hook text. immediateCuriosity must be true only if conflict, contradiction or concrete stakes are perceptible to a cold viewer in the opening audio/visual. A weak routine search, silent filler, incoherent mid-sentence dialogue, invented claim or early spoiler fails. State a SPECIFIC unanswered viewer question. A narrator that has not yet been synthesized cannot rescue dead opening footage; judge the ORIGINAL audio/video shown. Do not invent evidence.',
  evidence, async value => { const assessment = judge(value); if (!assessment.accepted) {
    const details = {
      violations: assessment.reasons.map(reason => ({ code: 'HOOK_SOURCE_AUDITION', message: reason })),
      firstSecondsObserved: value.firstSecondsObserved,
      specificUnansweredQuestion: value.specificUnansweredQuestion || '',
      rejectedHookRange: { sourceStartSec: start, sourceEndSec: actualEnd },
      hookPromise: story.hookPromise || '',
      verifiedPayoff: verifiedPayoff || null
    };
    if (engine.root) {
      await fs.mkdir(engine.root, { recursive: true });
      await fs.writeFile(path.join(engine.root, `hook-audition-${id}-rejected.json`),
        JSON.stringify({ storyId: id, verdict: value, assessment, details }, null, 2));
    }
    throw new StoryError('DIRECTOR_REPAIR_REQUIRED', assessment.reasons.join(' '), details);
  } }, 'auto_story_edit',
  { videoFps: 8, mediaResolution: 'MEDIA_RESOLUTION_MEDIUM', maxOutputTokens: 1600, thinkingLevel: 'high' });
  if (engine.root) {
    await fs.mkdir(engine.root, { recursive: true });
    await fs.writeFile(path.join(engine.root, `hook-audition-${id}.json`), JSON.stringify({ storyId: id, verdict }, null, 2));
  }
  emit('editing', `[V4] Hook audition PASS: source ${start.toFixed(1)}-${actualEnd.toFixed(1)}s inspected at 8fps.`);
  return { accepted: true, verdict };
}
module.exports = { schema, judge, verify };
