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
  productionQuality: {
    narratorSoundsNatural: true, narratorAddsNecessaryContext: true,
    narratorHandoffsClean: true, essentialDialogueClear: true,
    activeFootageReadable: true, importantVisualTextReadable: true,
    pacingMaintainsProgress: true,
    audibleObservation: 'Narrator sounds conversational and stops before the original admission.',
    visualObservation: 'Driver and hands are readable on a portrait phone.',
    pacingObservation: 'Each interval leads toward the observed revelation.'
  },
  issues: []
};
const auditableCuts = [
  { outputSec: 5, change: 'scene', whatViewerSeesAndHears: 'Officer asks the driver why the search began.', coldViewerUnderstandsWhy: true },
  { outputSec: 55, change: 'scene', whatViewerSeesAndHears: 'The prior confrontation leads to the visible discovery.', coldViewerUnderstandsWhy: true }
];
const check = data => Critic.normalizeCritique({ ...data,
  transitions: data.transitions?.length ? data.transitions : auditableCuts
}, { durationSec: 70, timeline, deliveryAware: true });
assert.equal(Critic.normalizeCritique(clean, { durationSec: 70, timeline, deliveryAware: true }).status,
  'MEDIA_CRITIC_INVALID', 'a missing ordinary cut cannot pass a full media review');
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
assert.equal(check({ ...clean, productionQuality: undefined }).status, 'MEDIA_CRITIC_INVALID',
  'the actual MP4 must receive a production-quality review before V1 can PASS');

const blockedQuality = (flag, type, evidence = 'Actual MP4 has a locally observable problem') => {
  const result = check({ ...clean, productionQuality: {
    ...clean.productionQuality, [flag]: false
  }, issues: [{ type, severity: 'blocking', outputStartSec: 8, outputEndSec: 17,
    evidence, whyItFails: 'Bad on a mobile viewing session.' }] });
  assert.equal(result.status, 'SCOPED_MEDIA_CRITIC_OK');
  assert.equal(result.isCompliant, false, flag);
  assert.ok(result.weakRegions.some(r => r.type === type && r.beatIds.includes('search')), flag);
  return result;
};
blockedQuality('narratorSoundsNatural', 'narration_robotic', 'TTS sounds flat and clipped at 8-17s');
blockedQuality('narratorAddsNecessaryContext', 'narration_unnecessary');
blockedQuality('narratorHandoffsClean', 'narration_handoff_confusing');
blockedQuality('essentialDialogueClear', 'raw_dialogue_unintelligible');
const narrow = blockedQuality('activeFootageReadable', 'small_active_footage',
  'Only a small horizontal strip of the bodycam is readable within blurred portrait canvas');
assert.ok(narrow.weakRegions.some(r => r.visualLayoutIssue), 'visual layout problems cannot be fixed by story-only EDL changes');
blockedQuality('importantVisualTextReadable', 'unreadable_on_screen_text');
blockedQuality('pacingMaintainsProgress', 'pacing_without_progress');
const missingTimedProof = check({ ...clean,
  productionQuality: { ...clean.productionQuality, narratorSoundsNatural: false } });
assert.equal(missingTimedProof.status, 'MEDIA_CRITIC_INVALID',
  'a quality failure must identify actual output seconds and observed evidence');


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
// The new render replayed its 0-5s police/drug hook again around 50s.
const hookReplay = [
  b('opening', 422.4, 426.8, 'Officer suspects narcotics.', 'The officer feels a suspicious object.'),
  b('rewind', 334.6, 340.8, 'Earlier stop', 'Officer starts the vehicle stop.'),
  b('search', 360, 378, 'Officer checks the driver.', 'Officer asks about an object in his clothes.'),
  b('return', 420, 426.8, 'Officer suspects narcotics.', 'The officer feels a suspicious object.'),
  b('ending', 470, 506, 'New detail', 'Officer confronts the driver with a new consequential question.')
];
const checkedReplay = Director.validateDirectorEdl({ beats: hookReplay }, {},
  { durationSec: 600, targetDurationMinSec: 65, targetDurationMaxSec: 150, reel: { ranges: [] } });
assert.ok(checkedReplay.violations.some(v => v.code === 'HOOK_FOOTAGE_REPLAY'),
  'source overlap should stop identical teaser footage from playing again in the body');

const nonAdjacentRepeat = [
  b('opening', 1, 8, 'Hook', 'A new confrontation begins.'),
  b('a', 8, 24, 'Police keep repeating a procedural search step', 'The officer keeps checking the same area for the same item.'),
  b('b', 25, 36, 'The officer asks the driver to stay inside', 'The suspect still awaits the result of the search.'),
  b('c', 36, 49, 'Police keep repeating a procedural search step', 'The officer keeps checking the same area for the same item.'),
  b('ending', 49, 77, 'Resolution', 'Officer reveals a confirmed discovery.')
];
const infoResult = Director.validateDirectorEdl({ beats: nonAdjacentRepeat }, {},
  { durationSec: 120, targetDurationMinSec: 65, targetDurationMaxSec: 100, reel: { ranges: [] } });
assert.ok(infoResult.violations.some(v => v.code === 'REPEATED_INFORMATION' && v.secondBeatId === 'c'),
  'same search repeated after an intervening question must not count as story progress');
console.log('V4 story quality: payoff, repetition, and media release gates passed');
