const assert = require('node:assert/strict');
const Gate = require('../electron/services/autoStoryV4PayoffGate');
const scope = { scopeEndTarget: 'payoff', storyScopeId: 'scope_a' };
const confirmed = { accessGranted: true, observedEnding: 'Officer finds the item under the seat.',
  concreteOutcomeVisibleOrAudible: true, endingSupportsCentralConflict: true,
  promiseSupportedByEnding: true, unsupportedPromise: '', outcomeType: 'confirmed_payoff',
  reason: 'Directly visible physical discovery.' };
assert.equal(Gate.judge(confirmed, scope).accepted, true);
assert.equal(Gate.judge({ ...confirmed, outcomeType: 'honest_unresolved',
  observedEnding: 'Officer keeps searching', concreteOutcomeVisibleOrAudible: false },
scope).accepted, false, 'ongoing search cannot satisfy claimed discovery');
assert.equal(Gate.judge({ ...confirmed, unsupportedPromise: 'Serious hidden contraband not discovered',
  promiseSupportedByEnding: false }, scope).accepted, false);
assert.equal(Gate.judge({ ...confirmed, endingSupportsCentralConflict: false }, scope).accepted, false);
assert.equal(Gate.judge({ ...confirmed, outcomeType: 'honest_unresolved',
  observedEnding: 'Officer says the search will continue', concreteOutcomeVisibleOrAudible: false
}, { scopeEndTarget: 'forward_cliffhanger' }).accepted, true, 'an honest open end may pass');
assert.throws(() => Gate.judge({ ...confirmed, observedEnding: '' }, scope), /observable footage/);
(async () => {
  const evidence = [];
  const engine = { duration: 400, config: { forcePayoffVerification: true },
    prepare: async (ranges, pad, fps) => { evidence.push({ ranges, fps }); return [{ file: 'ending.mp4' }]; },
    ask: async (_key, _input, _schema, _prompt, files) => {
      assert.equal(files.length, 1);
      return { ...confirmed, promiseSupportedByEnding: false,
        unsupportedPromise: 'The scope promises drugs but nothing was found' };
    }
  };
  await assert.rejects(() => Gate.verify(engine, {
    ...scope, candidateEndingEvents: [{ eventId: 'e4', sourceStartSec: 180, sourceEndSec: 190 }]
  }), e => e.kind === 'STORY_SCOPE_PAYOFF_REJECTED');
  assert.equal(evidence[0].fps, 10);
  console.log('V4 payoff gate tests passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
