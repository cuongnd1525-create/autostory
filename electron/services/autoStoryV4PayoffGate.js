// Evidence-grounded Story Scope payoff verification. This is a content gate,
// not an AI score: a story that promises a discovery must SHOW/HEAR its outcome.
const fs = require('fs/promises');
const path = require('path');
const { StoryError } = require('./autoStoryRepairRouter');

const schema = {
  type: 'object', properties: {
    accessGranted: { type: 'boolean' },
    observedEnding: { type: 'string' },
    concreteOutcomeVisibleOrAudible: { type: 'boolean' },
    endingSupportsCentralConflict: { type: 'boolean' },
    promiseSupportedByEnding: { type: 'boolean' },
    unsupportedPromise: { type: 'string' },
    outcomeType: { type: 'string', enum: ['confirmed_payoff', 'partial_resolution', 'honest_unresolved'] },
    reason: { type: 'string' }
  },
  required: ['accessGranted', 'observedEnding', 'concreteOutcomeVisibleOrAudible',
    'endingSupportsCentralConflict', 'promiseSupportedByEnding', 'unsupportedPromise',
    'outcomeType', 'reason']
};

function judge(value, scope) {
  if (!value?.accessGranted || !String(value.observedEnding || '').trim()
      || !String(value.reason || '').trim()) {
    throw new StoryError('STORY_SCOPE_PAYOFF_REJECTED', 'Payoff verification did not describe observable footage.');
  }
  const reasons = [];
  if (!value.endingSupportsCentralConflict) reasons.push('Ending belongs to another story or has no observed consequence for the central conflict.');
  if (!value.promiseSupportedByEnding || String(value.unsupportedPromise || '').trim()) {
    reasons.push('The story promise is not supported by the observed ending: ' + String(value.unsupportedPromise || value.reason));
  }
  if (scope?.scopeEndTarget === 'payoff' &&
      (value.outcomeType !== 'confirmed_payoff' || !value.concreteOutcomeVisibleOrAudible)) {
    reasons.push('A promised payoff must be visibly/audibly established, not merely anticipated.');
  }
  if (scope?.scopeEndTarget === 'partial_payoff' && value.outcomeType === 'honest_unresolved'
      && !value.concreteOutcomeVisibleOrAudible) {
    reasons.push('A partial payoff must deliver at least one observed consequence.');
  }
  if (scope?.scopeEndTarget === 'forward_cliffhanger' && value.outcomeType !== 'honest_unresolved'
      && !value.concreteOutcomeVisibleOrAudible) {
    reasons.push('Cliffhanger claims a consequence not supported by the source.');
  }
  return { accepted: reasons.length === 0, reasons, observedEnding: value.observedEnding };
}
function shouldVerify(engine) {
  // Scripted unit-test providers can opt in; real Vertex always verifies.
  return engine?.config?.forcePayoffVerification === true ||
    engine?.service?.vertex?.constructor?.name === 'VertexAiService';
}
async function verify(engine, scope, { root = null, scriptId = 1, emit = () => {} } = {}) {
  if (!shouldVerify(engine)) return { skipped: true };
  const endings = (scope?.candidateEndingEvents || []).filter(e =>
    Number.isFinite(Number(e.sourceStartSec)) && Number(e.sourceEndSec) > Number(e.sourceStartSec));
  if (!endings.length) throw new StoryError('STORY_SCOPE_PAYOFF_REJECTED', 'Scope has no sourced ending to watch.');
  const chosen = endings[0];
  const start = Math.max(0, Number(chosen.sourceStartSec) - 2);
  const end = Math.min(engine.duration, Math.max(start + 1, Number(chosen.sourceEndSec) + 2));
  const evidence = await engine.prepare([{ sourceStartSec: start, sourceEndSec: end }], 0, 10);
  const input = {
    scopeEndTarget: scope.scopeEndTarget, centralConflict: scope.centralConflict,
    centralViewerQuestion: scope.centralViewerQuestion,
    candidateEnding: chosen, allCandidateEndings: endings,
    mustResolve: scope.mustResolve || [], scopeStartState: scope.scopeStartState,
    scopeEndState: scope.scopeEndState || '',
    expectedAudiencePromise: scope.centralViewerQuestion
  };
  const response = await engine.ask(`v4-payoff-verify-${scriptId}-${scope.storyScopeId}`,
    input, schema,
    'WATCH the ATTACHED SOURCE ENDING with audio, not just the model summary. Judge whether THIS ending proves what the scope promises. A search in progress is NOT discovery of contraband; suspicion, an officer speculation, or a future possibility is NOT an observed confirmed find. Distinguish confirmed payoff, partial resolution, and honest unresolved cliffhanger. An unresolved ending can pass ONLY when the scope makes an honest open-ended promise, not when it guarantees a finding, arrest or revelation. Describe the literal visual/audio evidence. Mark promiseSupportedByEnding=false and name unsupportedPromise if the story oversells what is shown. Never invent an outcome.',
    evidence, () => {}, 'auto_story_edit',
    { videoFps: 8, mediaResolution: 'MEDIA_RESOLUTION_MEDIUM', maxOutputTokens: 1800, thinkingLevel: 'high' });
  const verdict = judge(response, scope);
  if (root) {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, `payoff-verification-${scriptId}.json`),
      JSON.stringify({ scopeId: scope.storyScopeId, response, verdict }, null, 2));
  }
  if (!verdict.accepted) {
    throw new StoryError('STORY_SCOPE_PAYOFF_REJECTED', verdict.reasons.join(' '),
      { violations: verdict.reasons.map(message => ({ code: 'UNSUPPORTED_STORY_PAYOFF', message })) });
  }
  emit('design', `[V4] Source payoff verified for story ${scriptId}: ${verdict.observedEnding}`);
  return verdict;
}
module.exports = { schema, judge, shouldVerify, verify };
