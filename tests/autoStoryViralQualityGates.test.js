// Regression tests for the V4 viral-quality gates (no video/API required).
// Run: node tests/autoStoryViralQualityGates.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Critic = require('../electron/services/scopeMediaCriticService');
const Director = require('../electron/services/editorialDirectorService');
const RepairPolicy = require('../electron/services/autoStoryRepairPolicy');
const AudioQa = require('../electron/services/autoStoryAudioQa');

function observedWindows() {
  return [
    { windowStartSec: 0, windowEndSec: 6, observedAction: 'Driver speaks',
      observedNewInformation: 'Driver contradicts officer', meaningfulProgress: true,
      causalConnectionClear: true, unexplainedAudioGap: false },
    { windowStartSec: 6, windowEndSec: 12, observedAction: 'Officer shows proof',
      observedNewInformation: 'Evidence resolves claim', meaningfulProgress: true,
      causalConnectionClear: true, unexplainedAudioGap: false }
  ];
}
function validCritique() {
  return {
    scopeSurvived: true, centralQuestionActiveThroughout: true,
    endingIsConsequenceOfCentralConflict: true, finalFootageUsable: true,
    coldViewerCanFollow: true, coldViewerNotes: '',
    openingCuriosity: { firstSecondsDescription: 'Confrontation', createsCuriosity: true },
    transitions: [], finalSeconds: { visualDescription: 'Clearly visible driver', subjectClearlyVisible: true },
    presentationQuality: { primaryActionVisibleAtPhoneSize: true, captionsReadable: true,
      dialogueIntelligible: true, narratorPresent: true, narratorSoundsNatural: true, notes: 'Clear.' },
    hookPromiseResolved: true,
    hookPromiseEvidence: { payoffOutputSec: 11, observedPayoff: 'The officer reveals the result.' },
    observationWindows: observedWindows(), issues: [], observedStory: 'A dispute is resolved.',
    summary: 'Complete scoped story.'
  };
}
const timeline = [
  { beatId: 'a', outputStartSec: 0, outputEndSec: 6 },
  { beatId: 'b', outputStartSec: 6, outputEndSec: 12 }
];
const normalize = raw => Critic.normalizeCritique(raw, { durationSec: 12, timeline, deliveryAware: true });

async function main() {
  assert.equal(normalize(validCritique()).isCompliant, true, 'Complete, observed story should PASS');
  const silenceLog = 'silence_start: 88.90\nsilence_end: 94.95 | silence_duration: 6.05';
  assert.deepEqual(AudioQa.parseSilences(silenceLog, 103.7), [
    { startSec: 88.9, endSec: 94.95, durationSec: 6.05 }
  ]);
  const missingTail = validCritique(); missingTail.observationWindows.pop();
  assert.equal(normalize(missingTail).status, 'MEDIA_CRITIC_INVALID', 'Missing last video window must not PASS');
  const gap = validCritique(); gap.observationWindows[1].windowStartSec = 7;
  assert.equal(normalize(gap).status, 'MEDIA_CRITIC_INVALID', 'Unobserved gap must not PASS');
  const paidOff = validCritique(); paidOff.hookPromiseResolved = false;
  const unpaid = normalize(paidOff);
  assert.equal(unpaid.isCompliant, false);
  assert.ok(unpaid.issues.some(i => i.type === 'hook_promise_unresolved' && i.severity === 'blocking'));
  const stalled = validCritique();
  stalled.observationWindows.forEach(w => { w.meaningfulProgress = false; });
  assert.ok(normalize(stalled).issues.some(i => i.type === 'low_value_stretch'));
  const silent = validCritique(); silent.observationWindows[1].unexplainedAudioGap = true;
  assert.ok(normalize(silent).issues.some(i => i.type === 'audio_gap_unexplained'));
  const phone = validCritique(); phone.presentationQuality.primaryActionVisibleAtPhoneSize = false;
  assert.equal(normalize(phone).isCompliant, true, 'Small framing does not change editorial story verdict');
  assert.equal(normalize(phone).publishReady, false, 'Small framing blocks publish-ready');
  const robotic = validCritique(); robotic.presentationQuality.narratorSoundsNatural = false;
  assert.equal(normalize(robotic).publishReady, false, 'Robotic narration needs attention');
  const masked = validCritique(); masked.finalSeconds.subjectClearlyVisible = false;
  assert.equal(normalize(masked).isCompliant, false);

  const src = { beats: [
    { beatId: 'a', sourceStartSec: 1, sourceEndSec: 4, observedInFootage: 'Driver in room' },
    { beatId: 'b', sourceStartSec: 4, sourceEndSec: 7, observedInFootage: 'Question' },
    { beatId: 'c', sourceStartSec: 7, sourceEndSec: 11, observedInFootage: 'Consequence' }
  ] };
  const outside = structuredClone(src); outside.beats[2].sourceEndSec = 12;
  assert.ok(Director.targetedRepairViolations(src, outside, [{ beatIds: ['b'], type: 'low_value_stretch' }])
    .some(i => i.code === 'TARGETED_REPAIR_MODIFIED_LOCKED_BEAT'));
  const inside = structuredClone(src); inside.beats[1].sourceEndSec = 6;
  assert.deepEqual(Director.targetedRepairViolations(src, inside, [{ beatIds: ['b'], type: 'low_value_stretch' }]), []);
  const reorder = structuredClone(src); reorder.beats = [src.beats[2], src.beats[1], src.beats[0]];
  assert.ok(Director.targetedRepairViolations(src, reorder, [{ beatIds: ['b'], type: 'low_value_stretch' }]).length);

  const ending = Director.validateDirectorEdl({
    beats: [{ beatId: 'end', sourceStartSec: 5, sourceEndSec: 8, narrativeRole: 'hook',
      scopeMembership: 'ending', observedInFootage: 'A visible result', whyNecessaryNow: 'Result' }]
  }, { scopeWindows: [{ startSec: 4, endSec: 10, purposes: ['core', 'ending_material'] }] },
  { durationSec: 15, targetDurationMinSec: 1, targetDurationMaxSec: 12,
    reel: { ranges: [{ sourceStartSec: 4, sourceEndSec: 10 }] } });
  assert.ok(!ending.violations.some(v => v.code === 'ENDING_NOT_IN_SCOPE'), 'purposes[] must be recognized');
  const futureTeaser = Director.validateDirectorEdl({
    openingStrategy: { chronologicalOption: 'Routine encounter', conflictTeaserOption: 'Later arrest', chosen: 'conflict_teaser_rewind', why: 'Drama' },
    deliveryBlocks: [], transitionChecks: [], beats: [
      { beatId: 'hook', sourceStartSec: 500, sourceEndSec: 505, narrativeRole: 'hook',
        chronologyMode: 'teaser', scopeMembership: 'hook', observedInFootage: 'Arrest', whyNecessaryNow: 'Hook' },
      { beatId: 'body', sourceStartSec: 100, sourceEndSec: 120, narrativeRole: 'context',
        chronologyMode: 'rewind', scopeMembership: 'core', observedInFootage: 'Call', whyNecessaryNow: 'Context' },
      { beatId: 'end', sourceStartSec: 150, sourceEndSec: 160, narrativeRole: 'payoff',
        chronologyMode: 'chronological', scopeMembership: 'ending', observedInFootage: 'Hospital',
        whyNecessaryNow: 'Ending' }
    ]
  }, { candidateEndingEvents: [{ sourceStartSec: 150, sourceEndSec: 160 }] },
  { durationSec: 550, targetDurationMinSec: 1, targetDurationMaxSec: 90,
    requireDeliveryBlocks: true, reel: { ranges: [{ sourceStartSec: 100, sourceEndSec: 170 }, { sourceStartSec: 495, sourceEndSec: 510 }] } });
  assert.ok(futureTeaser.violations.some(v => v.code === 'TEASER_PROMISE_OUTSIDE_STORY'),
    'Opening at 08:16 cannot PASS when the entire body ends around 05:41');

  assert.equal(RepairPolicy.chooseRepairStrategy({ scopeSurvived: false }).mode, 'scope_rebuild');
  assert.equal(RepairPolicy.chooseRepairStrategy({ scopeSurvived: true, hookPromiseResolved: false }).mode, 'edl_rebuild');
  assert.equal(RepairPolicy.chooseRepairStrategy({ scopeSurvived: true, hookPromiseResolved: true,
    endingIsConsequence: true, centralQuestionActiveThroughout: true, issues: [] }).mode, 'targeted');

  let calledTask;
  const spine = { beats: [{ beatId: 'a', sourceStartSec: 0, sourceEndSec: 6 },
    { beatId: 'b', sourceStartSec: 6, sourceEndSec: 12 }], deliveryBlocks: [] };
  await Critic.critiqueScopedRender(spine, {
    aiService: { generateJsonFromFiles: async args => { calledTask = args.taskType; return validCritique(); } },
    mp4Path: 'not-needed-in-mock.mp4', actualMp4DurationSec: 12
  });
  assert.equal(calledTask, 'auto_story_review', 'Dedicated review model must be used');

  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  assert.match(html, /<option value="4" selected>/, 'New AutoStory setup must expose V4');
  console.log('AutoStory V4 viral-quality regression assertions passed.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
