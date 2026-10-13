// Independent, source-grounded opening audition for V4 Editorial Director.
// The Director chooses the story; this guard checks the actual source frames.
const fs = require('fs/promises');
const path = require('path');
const { StoryError } = require('./autoStoryRepairRouter');
const schema = {
  type: 'object', additionalProperties: false,
  required: ['accessGranted', 'sourceVerified', 'firstSecondsObserved',
    'immediateCuriosity', 'misleadingOrSpoiled', 'reason'],
  properties: {
    accessGranted: { type: 'boolean' },
    sourceVerified: { type: 'boolean' },
    firstSecondsObserved: { type: 'string' },
    immediateCuriosity: { type: 'boolean' },
    misleadingOrSpoiled: { type: 'boolean' },
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
  const verdict = await engine.ask(`v4-hook-audition-${id}`, {
    storyScope: story.storyScope?.centralConflict || '',
    centralViewerQuestion: story.centralViewerQuestion || '',
    hookPromise: story.hookPromise || '',
    mustWithhold: story.storyScope?.mustWithhold || [],
    opening: { sourceStartSec: start, sourceEndSec: actualEnd, narrativeRole: first.narrativeRole, observedInFootage: first.observedInFootage }
  }, schema,
  'WATCH the complete attached opening clip, including its original audio. Verify ONLY what is actually audible/visible. Describe the FIRST 3 seconds, the observable tension or contradiction, and whether a cold viewer has a compelling question without being misled. A teaser may withhold context; do not demand that the case is fully explained. Set immediateCuriosity=false if the first seconds are silent procedural filler. Set misleadingOrSpoiled=true for an inaccurate quote, misleading action, or a revealed payoff that should be withheld. Do not invent scene evidence.',
  evidence, value => { const assessment = judge(value); if (!assessment.accepted) {
    throw new StoryError('DIRECTOR_REPAIR_REQUIRED', assessment.reasons.join(' '), {
      violations: assessment.reasons.map(reason => ({ code: 'HOOK_SOURCE_AUDITION', message: reason })),
      firstSecondsObserved: value.firstSecondsObserved
    });
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
