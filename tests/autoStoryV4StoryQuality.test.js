const assert = require('node:assert/strict');
const Critic = require('../electron/services/scopeMediaCriticService');
const Director = require('../electron/services/editorialDirectorService');

const timeline = [
  { beatId: 'hook', outputStartSec: 0, outputEndSec: 5 },
  { beatId: 'search', outputStartSec: 5, outputEndSec: 55 },
  { beatId: 'ending', outputStartSec: 55, outputEndSec: 70 }
];
const clean = {
  scopeSurvived: true, centralQuestionActiveThroughout: true,
  endingIsConsequenceOfCentralConflict: true, finalFootageUsable: true,
  hookPromiseSupported: true, observableEndingConsequence: true,
  repetitiveProcedureWithoutProgress: false,
  observedStory: 'Officer discovers evidence and confronts the driver.', summary: 'Concrete evidence found.',
  coldViewerCanFollow: true, coldViewerNotes: '',
  openingCuriosity: { firstSecondsDescription: 'Officer confronts the driver.', createsCuriosity: true },
  transitions: [], finalSeconds: { visualDescription: 'Officer displays the recovered item.', subjectClearlyVisible: true },
  issues: []
};
const check = data => Critic.normalizeCritique(data, { durationSec: 70, timeline, deliveryAware: true });
assert.equal(check(clean).isCompliant, true);
let failing = check({ ...clean, hookPromiseSupported: false, observedStory: 'Searching ends without a discovery' });
assert.equal(failing.isCompliant, false);
assert.ok(failing.weakRegions.some(x => x.type === 'hook_unfulfilled'));
failing = check({ ...clean, observableEndingConsequence: false, finalSeconds: {
  visualDescription: 'The officer is still searching the car seat', subjectClearlyVisible: true
} });
assert.equal(failing.isCompliant, false);
assert.ok(failing.weakRegions.some(x => x.type === 'ending_without_payoff'));
failing = check({ ...clean, repetitiveProcedureWithoutProgress: true });
assert.equal(failing.isCompliant, false);
assert.ok(failing.weakRegions.some(x => x.type === 'procedural_repetition'));
assert.equal(check({ ...clean, hookPromiseSupported: undefined }).status, 'MEDIA_CRITIC_INVALID',
  'V4 must not silently accept a media response missing the hook verification field');

const b = (id, start, end, state, info) => ({
  beatId: id, sourceStartSec: start, sourceEndSec: end,
  narrativeRole: id === 'opening' ? 'cold_open' : id === 'ending' ? 'cliffhanger' : 'escalation',
  scopeMembership: id === 'opening' ? 'hook' : id === 'ending' ? 'ending' : 'core',
  observedInFootage: 'Officer visibly checks an item', whyNecessaryNow: 'Advances the same search',
  newInformation: info, viewerStateAfter: state
});
const beats = [
  b('opening', 0, 5, 'Tension begins', 'Officer asks why the driver was stopped.'),
  b('a', 5, 20, 'Police are continuing the search', 'Officer is checking inside the car for items.'),
  b('b', 20, 35, 'Police are continuing the search', 'Officer is checking inside the car for items.'),
  b('ending', 45, 70, 'New consequence', 'Officer discovers a significant piece of evidence.')
];
const report = Director.validateDirectorEdl({ beats }, {
  candidateEndingEvents: [{ eventId: 'outcome', sourceStartSec: 45, sourceEndSec: 70 }],
  scopeWindows: [{ startSec: 0, endSec: 70, purpose: 'core' }]
}, { durationSec: 70, targetDurationMinSec: 65, targetDurationMaxSec: 90,
  reel: { ranges: [{ sourceStartSec: 0, sourceEndSec: 70, windowStartSec: 0, windowEndSec: 70 }] } });
assert.ok(report.violations.some(v => v.code === 'REPEATED_INFORMATION'),
  'Two repeated searches with no new viewer state must trigger EDL repair');
console.log('V4 story quality: payoff, repetition, and media release gates passed');
