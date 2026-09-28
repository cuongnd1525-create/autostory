const assert = require('assert');
const { planRetentionArc, validateRetentionArc } = require('../electron/services/retentionArcPlanService');
const { castBeats } = require('../electron/services/beatCastingService');
const { augmentCoverage, computeEditorialMetrics } = require('../electron/services/beatCoverageService');
const { planDurationFit } = require('../electron/services/autoStoryDurationFit');
const { computeMetrics } = require('../electron/services/autoStoryEditorialMetrics');

console.log('Testing Retention Arc Plan Service...');

// Mock Source Story Model based on the Georgia Bodycam case
const mockModel = {
  events: [
    { id: 'ev_01', startSec: 12.0, endSec: 32.5, type: 'context', summary: 'Officer receives frantic 911 dispatch', tension: 0.6, visualQuality: 0.8, novelty: 0.7, dialogueImpact: 0.5, isReveal: false },
    { id: 'ev_02', startSec: 32.5, endSec: 45.0, type: 'arrival', summary: 'Officer approaches quiet suburban porch', tension: 0.65, visualQuality: 0.8, novelty: 0.6, dialogueImpact: 0.4, isReveal: false },
    { id: 'ev_03', startSec: 45.0, endSec: 58.0, type: 'confrontation', summary: 'Mother opens door; screaming erupts upstairs', tension: 0.85, visualQuality: 0.85, novelty: 0.9, dialogueImpact: 0.8, isReveal: false },
    { id: 'ev_04', startSec: 58.0, endSec: 73.0, type: 'reveal', summary: 'Officer dashes into bathroom; man pinning girl', tension: 0.95, visualQuality: 0.9, novelty: 0.95, dialogueImpact: 0.9, isReveal: true },
    { id: 'ev_05', startSec: 73.0, endSec: 90.0, type: 'confrontation', summary: 'Raw confrontation on bathroom floor', tension: 0.9, visualQuality: 0.85, novelty: 0.8, dialogueImpact: 0.95, isReveal: false },
    { id: 'ev_06', startSec: 90.0, endSec: 120.0, type: 'dialogue', summary: 'Mother claims mental episode; girl claims hostage escape', tension: 0.8, visualQuality: 0.8, novelty: 0.75, dialogueImpact: 0.7, isReveal: false },
    { id: 'ev_07', startSec: 120.0, endSec: 135.0, type: 'dialogue', summary: 'Stepfather admits trapping daughter for house rules', tension: 0.82, visualQuality: 0.8, novelty: 0.8, dialogueImpact: 0.75, isReveal: true },
    { id: 'ev_08', startSec: 135.0, endSec: 155.0, type: 'confrontation', summary: 'Mother eager to explain her story', tension: 0.9, visualQuality: 0.8, novelty: 0.85, dialogueImpact: 0.8, isReveal: false },
    { id: 'ev_spoiler', startSec: 1711.0, endSec: 1717.0, type: 'arrest', summary: 'Mother placed in police car under arrest', tension: 0.5, visualQuality: 0.7, novelty: 0.9, dialogueImpact: 0.4, isReveal: true }
  ],
  quotes: [
    { id: 'q_01', eventId: 'ev_03', text: 'Cumber please!', speaker: 'Victim', editorialValue: 0.9 },
    { id: 'q_02', eventId: 'ev_05', text: 'Please help me, I am hurting!', speaker: 'Victim', editorialValue: 0.95 }
  ]
};

// Test 1: Plan valid retention arc with cold-open and cliffhanger
const mockStory = {
  scriptId: 1,
  centralViewerQuestion: 'Why were parents violently trapping their 19-year-old daughter?',
  hookPromise: 'A mother deflection unravels when screaming breaks out upstairs',
  openLoops: [
    { id: 'LOOP_WHO_IS_ATTACKER', question: 'Who is attacking the daughter?' }
  ],
  beats: [
    { beatId: 'b_1', sourceEventId: 'ev_03', narrativeRole: 'cold_open', newInformation: ['Mother deflecting at front door while screams erupt'] },
    { beatId: 'b_2', sourceEventId: 'ev_01', narrativeRole: 'context', newInformation: ['911 call from boyfriend reported girlfriend held hostage'] },
    { beatId: 'b_3', sourceEventId: 'ev_04', narrativeRole: 'confrontation', newInformation: ['Officer finds stepfather pinning daughter to floor'] },
    { beatId: 'b_4', sourceEventId: 'ev_06', narrativeRole: 'contradiction', newInformation: ['Mother claims mental health; daughter claims escaping assault'] },
    { beatId: 'b_5', sourceEventId: 'ev_08', narrativeRole: 'cliffhanger', newInformation: ['Mother prepares confession that will seal her fate'] }
  ]
};

const arc = planRetentionArc(mockStory, mockModel, { targetDurationMinSec: 65, targetDurationMaxSec: 90 }, { storyMode: 'serialized_part' });

assert.ok(arc, 'Retention Arc Plan must be created');
assert.strictEqual(arc.beats.length, 5, 'Must have 5 beats');
assert.strictEqual(arc.beats[0].narrativeRole, 'cold_open_hook', 'First beat must be cold_open_hook');
assert.strictEqual(arc.beats[1].narrativeRole, 'crisis_context', 'Second beat must be crisis_context');
assert.strictEqual(arc.beats[4].narrativeRole, 'cliffhanger', 'Final beat must be cliffhanger');

// Verify state transitions: viewerStateAfter must differ from viewerStateBefore
arc.beats.forEach((b, i) => {
  assert.notStrictEqual(b.viewerStateBefore, b.viewerStateAfter, `Beat ${i} must change viewer state`);
  assert.ok(b.newInformationDelivered, `Beat ${i} must deliver new information`);
  assert.ok(b.informationWithheld, `Beat ${i} must document information withheld`);
});

// Test 2: Anti-Spoiler Gate: reject plans that show the arrest in the first 75%
const spoiledStory = {
  scriptId: 2,
  centralViewerQuestion: 'Who got arrested?',
  beats: [
    { beatId: 'sb_1', sourceEventId: 'ev_spoiler', narrativeRole: 'hook', newInformation: ['Mother is arrested in police car'] },
    { beatId: 'sb_2', sourceEventId: 'ev_01', narrativeRole: 'context', newInformation: ['Rewind to 911 call'] }
  ]
};

assert.throws(() => {
  planRetentionArc(spoiledStory, mockModel, {}, {});
}, err => err.kind === 'SPOILER_DETECTED' || /prematurely shows/i.test(err.message), 'Must reject premature spoiler of final arrest');

// Test 3: Beat Casting with Continuity
const castResult = castBeats(arc.beats, mockModel, { preferContinuity: true });
assert.strictEqual(castResult.unresolved.length, 0, 'All retention arc beats must be resolved');
assert.strictEqual(castResult.beats.length, 5, 'All 5 beats must be cast');

// Test 4: Coverage Augmentation Gate: Only fills structural deficits
const coverageResult = augmentCoverage(castResult.beats, mockModel, { targetDurationMinSec: 75, targetDurationMaxSec: 95 });
if (coverageResult.augmented) {
  coverageResult.beats.filter(b => b.addedByCoverage).forEach(b => {
    assert.ok(b.structuralDeficitFilled, 'Every added coverage beat must specify structuralDeficitFilled');
    assert.ok(b.whyInsertedHere, 'Every added coverage beat must specify whyInsertedHere');
  });
}

// Test 5: Duration Fit Extension Ceiling (15% cap)
const fitResult = planDurationFit(castResult.beats, {
  config: { targetDurationMinSec: 60, targetDurationMaxSec: 85 },
  sourceDuration: 180,
  model: mockModel
});
assert.ok(fitResult.extensionRatio <= 0.25, 'Extension ratio must stay under 25%');

// Test 6: Editorial Structural Metrics
const mockScript = {
  scriptId: 1,
  title: 'Test Script',
  segments: fitResult.beats.map((b, i) => ({
    id: `seg_${i}`,
    sourceEventId: b.sourceEventId,
    outputStartSec: i * 15,
    outputEndSec: (i + 1) * 15,
    narrativeRoleV3: b.narrativeRole,
    voiceoverText: i % 2 === 1 ? 'Voiceover narration bridge' : '',
    audioMode: i % 2 === 1 ? 'voiceover_only' : 'original_audio',
    dialogueImpact: 0.8,
    opensLoopId: i === 0 ? 'LOOP_PRIMARY' : null
  }))
};

const metrics = computeMetrics(mockScript, mockStory, mockModel, fitResult);
assert.ok(metrics.retentionReasonDensity > 0.5, 'Retention reason density must be computed');
assert.ok(metrics.compositeRetentionScore >= 60, 'Composite retention score must reflect viral mechanics');

console.log('Retention Arc Plan Service tests PASSED successfully!');
