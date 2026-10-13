const assert = require('node:assert/strict');
const Scope = require('../electron/services/storyScopeService');
const model = { events: [
  { id: 'e1', startSec: 0, endSec: 12, summary: 'Routine stop' },
  { id: 'e2', startSec: 20, endSec: 40, summary: 'Suspect denies having any items' },
  { id: 'e3', startSec: 80, endSec: 105, summary: 'Officer actually discovers an item' }
], quotes: [] };
const scope = {
  storyScopeId: 'search', centralConflict: 'The driver denies the evidence.',
  centralViewerQuestion: 'What does the officer find?',
  whyThisIsOneStory: 'One escalating search.', scopeEndTarget: 'payoff',
  explicitScopeBoundary: { startSec: 0, endSec: 105 },
  scopeWindows: [{ windowId: 'full', startSec: 0, endSec: 105, purpose: 'core' }],
  causalSpine: [{ eventId: 'e1', sourceStartSec: 0, sourceEndSec: 12 },
    { eventId: 'e3', sourceStartSec: 80, sourceEndSec: 105 }],
  candidateEndingEvents: [{ eventId: 'e3', sourceStartSec: 85, sourceEndSec: 102,
    endingType: 'payoff', whyItIsAConsequence: 'Confirms the suspected object' }]
};
const opts = { durationSec: 120, targetDurationMinSec: 65, model };
const good = Scope.validateStoryScope(scope, opts);
assert.equal(good.valid, true, JSON.stringify(good.violations));
const fake = Scope.validateStoryScope({
  ...scope, candidateEndingEvents: [{ ...scope.candidateEndingEvents[0], eventId: 'invented' }]
}, opts);
assert.ok(fake.violations.some(v => v.code === 'SCOPE_ENDING_EVENT_UNVERIFIED'));
const wrongTime = Scope.validateStoryScope({
  ...scope, candidateEndingEvents: [{ ...scope.candidateEndingEvents[0], sourceStartSec: 52, sourceEndSec: 62 }]
}, opts);
assert.ok(wrongTime.violations.some(v => v.code === 'SCOPE_ENDING_EVENT_MISMATCH'));
console.log('V4 scope ending evidence IDs and timestamps passed');
