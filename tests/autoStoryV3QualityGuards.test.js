// AutoStory V3 — Quality Guards Test Suite (Phase 12)
// Tests: node tests/autoStoryV3QualityGuards.test.js

const assert = require('node:assert');
const path = require('path');
const S = p => require(path.join(__dirname, '..', 'electron', 'services', p));

const { planDurationFit, timelineSeconds, STRUCTURAL_DEFICIT_RATIO } = S('autoStoryDurationFit.js');
const { castBeats } = S('beatCastingService.js');
const { computeMetrics } = S('autoStoryEditorialMetrics.js');
const V3 = S('autoStoryV3Contracts.js');

const config = { targetDurationMinSec: 65, targetDurationMaxSec: 90, narration: { enabled: true, measuredWordsPerSecond: 2.6 } };
const origBeat = (id, role, s, e, extra = {}) => ({
  beatId: id, narrativeRole: role, sourceStartSec: s, sourceEndSec: e,
  audioStrategy: 'original', speaks: false, narratorText: '', previewVi: '',
  audioType: 'participant_speech', audioConfidence: 0.95, tension: 0.6, ...extra
});

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ok -', name); };

console.log('Running AutoStory V3 Quality Guards Test Suite...\n');

// 1. Structural Deficit Detection (17s requested 65s triggers addEvents, NOT pure extension)
ok('17s selected material with 65s target triggers structural deficit and adds unused events', () => {
  const beats = [
    origBeat('b1', 'hook', 10, 16),
    origBeat('b2', 'setup', 20, 24),
    origBeat('b3', 'escalation', 30, 36)
  ]; // Total = 6 + 4 + 6 = 16s (< 70% of 65s = 45.5s)
  assert.ok(timelineSeconds(beats) < config.targetDurationMinSec * STRUCTURAL_DEFICIT_RATIO);

  const model = {
    events: [
      { id: 'ev_call', startSec: 100, endSec: 115, type: 'arrival', tension: 0.8, visualQuality: 0.8, dialogueImpact: 0.7 },
      { id: 'ev_arrest', startSec: 200, endSec: 220, type: 'arrest', tension: 0.9, visualQuality: 0.9, dialogueImpact: 0.8 },
      { id: 'ev_reveal', startSec: 300, endSec: 318, type: 'reveal', tension: 0.85, isReveal: true, visualQuality: 0.7 }
    ]
  };

  const fit = planDurationFit(beats, { config, sourceDuration: 500, model });
  assert.equal(fit.structuralDeficit, true, 'structural deficit detected');
  assert.ok(fit.operations.some(o => o.op === 'addEvents'), 'must add unused events');
  assert.ok(fit.beats.length > 3, 'timeline expanded with new events, not just stretched existing clips');
  assert.ok(fit.actualAfter >= config.targetDurationMinSec - 0.25, 'timeline reaches requested minimum duration');
});

// 2. Small deficit (e.g. 58s -> 65s) is handled cleanly by local extension
ok('small deficit (58s -> 65s) uses local extension without structural deficit flag', () => {
  const beats = [
    origBeat('b1', 'hook', 10, 35),
    origBeat('b2', 'escalation', 100, 133)
  ]; // Total = 25 + 33 = 58s (58/65 = 89% > 70%)
  assert.ok(timelineSeconds(beats) >= config.targetDurationMinSec * STRUCTURAL_DEFICIT_RATIO);

  const fit = planDurationFit(beats, { config, sourceDuration: 500, model: { events: [] } });
  assert.equal(fit.structuralDeficit, false, 'not a structural deficit');
  assert.ok(fit.operations.some(o => o.op === 'extend'), 'uses extend operation');
  assert.ok(fit.actualAfter >= config.targetDurationMinSec - 0.25, 'reaches target duration');
});

// 3. Repeated same-event beats receive repetition penalty in Beat Casting
ok('beat casting applies repetition penalty to consecutive beats in the same cluster', () => {
  const model = {
    events: [
      { id: 'doorway_1', startSec: 10, endSec: 18, type: 'confrontation', tension: 0.7, visualQuality: 0.7 },
      { id: 'doorway_2', startSec: 20, endSec: 28, type: 'confrontation', tension: 0.7, visualQuality: 0.7 },
      { id: 'doorway_3', startSec: 22, endSec: 30, type: 'confrontation', tension: 0.7, visualQuality: 0.7 },
      { id: 'street_arrival', startSec: 200, endSec: 215, type: 'arrival', tension: 0.6, visualQuality: 0.8 }
    ]
  };

  const storyBeats = [
    { beatId: 'beat_1', narrativeRole: 'hook' },
    { beatId: 'beat_2', narrativeRole: 'confrontation' },
    { beatId: 'beat_3', narrativeRole: 'setup' } // Should avoid 3rd doorway beat and pick distinct region
  ];

  const cast = castBeats(storyBeats, model, {});
  assert.equal(cast.unresolved.length, 0);
  const chosenIds = cast.beats.map(b => b.sourceEventId);
  // Must not have all 3 beats from doorway
  const doorwayCount = chosenIds.filter(id => id.startsWith('doorway')).length;
  assert.ok(doorwayCount <= 2, 'no more than 2 consecutive beats from the same scene cluster');
});

// 4. Chronological insertion of added unused events (no backwards jumps)
ok('added unused events maintain chronological order between hook and payoff', () => {
  const beats = [
    origBeat('h', 'hook', 10, 18),
    origBeat('p', 'payoff', 400, 410)
  ];
  const model = {
    events: [
      { id: 'mid_event', startSec: 150, endSec: 170, type: 'action', tension: 0.8, visualQuality: 0.8 }
    ]
  };

  const fit = planDurationFit(beats, { config, sourceDuration: 500, model });
  const starts = fit.beats.map(b => b.sourceStartSec);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] >= starts[i - 1], `chronological ordering preserved: ${starts[i - 1]} <= ${starts[i]}`);
  }
});

// 5. People fallback matching prevents dropping beats as unresolved
ok('beat casting falls back gracefully when required people are loosely matched', () => {
  const model = {
    events: [
      { id: 'caller_report', startSec: 8, endSec: 18, type: 'interaction', peopleIds: ['caller'], visualQuality: 0.25 }
    ]
  };

  const storyBeats = [
    { beatId: 'b_caller', narrativeRole: 'cold_open', requiredPeopleIds: ['officer_1', 'caller_man'] }
  ];

  const cast = castBeats(storyBeats, model, { minVisualQuality: 0.20 });
  assert.equal(cast.unresolved.length, 0, 'beat was resolved despite non-exact people ID match');
  assert.equal(cast.beats[0].sourceEventId, 'caller_report');
});

// 6. Editorial metrics computation & observability
ok('editorial metrics correctly computes extensionRatio, uniqueEventCount, and undercast flag', () => {
  const script = {
    scriptId: 1,
    title: 'Test Story',
    segments: [
      { id: 's1', outputStartSec: 0, outputEndSec: 15, sourceStartSec: 10, sourceEndSec: 25, sourceEventId: 'ev1', audioMode: 'original_audio' },
      { id: 's2', outputStartSec: 15, outputEndSec: 35, sourceStartSec: 100, sourceEndSec: 120, sourceEventId: 'ev2', audioMode: 'voiceover_only' },
      { id: 's3', outputStartSec: 35, outputEndSec: 65, sourceStartSec: 250, sourceEndSec: 280, sourceEventId: 'ev3', audioMode: 'voiceover_with_ambient' }
    ]
  };

  const model = {
    events: [
      { id: 'ev1', novelty: 0.8, tension: 0.9, peopleIds: ['officer', 'suspect'] },
      { id: 'ev2', novelty: 0.7, tension: 0.6, peopleIds: ['witness'] },
      { id: 'ev3', novelty: 0.6, tension: 0.8, peopleIds: ['officer'] }
    ]
  };

  const fitReport = {
    actualBefore: 16.8,
    actualAfter: 65.0,
    min: 65,
    max: 90,
    structuralDeficit: true,
    undercast: true,
    extensionRatio: 2.87,
    operations: [{ op: 'extend' }]
  };

  const metrics = computeMetrics(script, {}, model, fitReport);
  assert.equal(metrics.uniqueEventCount, 3);
  assert.equal(metrics.uniquePersonCount, 3);
  assert.equal(metrics.undercast, true);
  assert.equal(metrics.structuralDeficit, true);
  assert.equal(metrics.baseSelectedDuration, 16.8);
  assert.equal(metrics.finalDuration, 65.0);
  assert.ok(metrics.extensionRatio > 2.0);
});

// 7. V3 prompt contract enforces multi-event diversity and duration targets
ok('V3 storyDesign prompt contains multi-event breadth and retention constraints', () => {
  const prompt = V3.instructions.storyDesign;
  assert.ok(prompt.includes('MULTI-EVENT BREADTH'), 'prompt requires multi-event breadth');
  assert.ok(prompt.includes('NOVELTY MANDATE'), 'prompt requires novelty mandate');
  assert.ok(prompt.includes('DURATION TARGET'), 'prompt specifies duration target');
});

console.log(`\nAll ${passed} quality guard tests passed successfully!`);
