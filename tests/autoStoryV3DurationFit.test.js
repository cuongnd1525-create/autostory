// V3 Duration Fit tests. Run: node tests/autoStoryV3DurationFit.test.js
const assert = require('node:assert');
const path = require('path');
const S = p => require(path.join(__dirname, '..', 'electron', 'services', p));
const { planDurationFit, timelineSeconds } = S('autoStoryDurationFit.js');
const { compileV3 } = S('autoStoryV3Compile.js');

const config = { targetDurationMinSec: 65, targetDurationMaxSec: 90, narration: { enabled: true, measuredWordsPerSecond: 2.6 } };
const inRange = d => d >= config.targetDurationMinSec - 0.25 && d <= config.targetDurationMaxSec + 0.25;
const evidenceFor = beats => beats.map((b, i) => ({ id: 'c' + i, sourceStart: b.sourceStartSec, duration: b.sourceEndSec - b.sourceStartSec, file: 'c' + i + '.mp4' }));
const story = { scriptId: 1, title: 'T', centralViewerQuestion: 'Q', spine: {}, openLoops: [] };
const origBeat = (id, role, s, e, extra = {}) => ({ beatId: id, narrativeRole: role, sourceStartSec: s, sourceEndSec: e,
  audioStrategy: 'original', speaks: false, narratorText: '', previewVi: '', audioType: 'participant_speech', audioConfidence: 0.95, tension: 0.6, ...extra });

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ok -', name); };

console.log('V3 Duration Fit');

ok('too short -> extend selected beat(s) -> enters range -> compiles', () => {
  const beats = [ origBeat('h', 'hook', 0, 8), origBeat('e', 'escalation', 100, 120, { tension: 0.9 }), origBeat('p', 'reveal', 600, 624, { tension: 0.8 }) ];
  assert.ok(timelineSeconds(beats) < 65, 'starts too short (52s)');
  const fit = planDurationFit(beats, { config, sourceDuration: 1800, model: { events: [] } });
  assert.equal(fit.fitted, true);
  assert.ok(inRange(fit.actualAfter), `actual ${fit.actualAfter} in range`);
  assert.ok(fit.operations.some(o => o.op === 'extend'));
  const script = compileV3(fit.beats, { story, evidence: evidenceFor(fit.beats), config, sourceDuration: 1800 });
  assert.equal(script.segments[0].storyRole, 'hook');
  assert.ok(inRange(script.segments.reduce((n, s) => n + (s.end - s.start), 0)), 'compiled timeline in range');
});

ok('too short -> add one compatible unused event -> enters range', () => {
  // Contiguous beats leave no adjacent room; extension caps out, so an unused event is added.
  const beats = [ origBeat('h', 'hook', 0, 8), origBeat('e', 'escalation', 8, 38, { tension: 0.9 }) ]; // 38s, deficit 27
  const model = { events: [ { id: 'ev9', startSec: 60, endSec: 80, type: 'confrontation', tension: 0.85, visualQuality: 0.8, dialogueImpact: 0.6, audioType: 'participant_speech', audioConfidence: 0.9 } ] };
  const fit = planDurationFit(beats, { config, sourceDuration: 200, model });
  assert.equal(fit.fitted, true, `fitted (actual ${fit.actualAfter})`);
  assert.ok(inRange(fit.actualAfter));
  assert.ok(fit.operations.some(o => o.op === 'addEvents'), 'added an unused event');
  assert.ok(fit.beats.some(b => b.addedByDurationFit), 'a fit-added beat exists');
  // hook stays first, added event is not last (payoff/last preserved)
  assert.equal(fit.beats[0].beatId, 'h');
});

ok('too long -> trim low-value (removable) tails, protected roles preserved -> compiles', () => {
  const beats = [ origBeat('h', 'hook', 0, 10), origBeat('c', 'context', 100, 170, { tension: 0.3 }), origBeat('p', 'payoff', 600, 640, { tension: 0.95 }) ]; // 120s
  assert.ok(timelineSeconds(beats) > 90);
  const fit = planDurationFit(beats, { config, sourceDuration: 1800, model: { events: [] } });
  assert.equal(fit.fitted, true);
  assert.ok(inRange(fit.actualAfter), `actual ${fit.actualAfter}`);
  assert.ok(fit.operations.some(o => o.op === 'trim'));
  assert.equal(fit.beats[0].sourceEndSec - fit.beats[0].sourceStartSec, 10, 'hook not trimmed');
  assert.equal(fit.beats[2].sourceEndSec - fit.beats[2].sourceStartSec, 40, 'payoff not trimmed');
  const script = compileV3(fit.beats, { story, evidence: evidenceFor(fit.beats), config, sourceDuration: 1800 });
  assert.ok(inRange(script.segments.reduce((n, s) => n + (s.end - s.start), 0)));
});

ok('too long but removable beats already minimal -> removes weakest optional beat', () => {
  // Protected hook+payoff = 80s; six 2s context beats (untrimmable) push to 92s.
  const beats = [ origBeat('h', 'hook', 0, 50), origBeat('p', 'payoff', 600, 630, { tension: 0.9 }) ];
  for (let i = 0; i < 6; i++) beats.splice(1 + i, 0, origBeat('c' + i, 'context', 100 + i * 10, 102 + i * 10, { tension: 0.2 }));
  assert.ok(Math.abs(timelineSeconds(beats) - 92) < 0.001, 'starts at 92s');
  const fit = planDurationFit(beats, { config, sourceDuration: 1800, model: { events: [] } });
  assert.equal(fit.fitted, true, `fitted (actual ${fit.actualAfter})`);
  assert.ok(fit.operations.some(o => o.op === 'removeBeat'), 'removed a beat');
  assert.equal(fit.beats[0].narrativeRole, 'hook', 'hook preserved');
  assert.ok(fit.beats.some(b => b.narrativeRole === 'payoff'), 'payoff preserved');
});

ok('impossible fit -> structured failure with actual/min/max (no generic error)', () => {
  const beats = [ origBeat('h', 'hook', 0, 5), origBeat('e', 'escalation', 5, 10) ]; // 10s, tiny source, no events
  const fit = planDurationFit(beats, { config, sourceDuration: 12, model: { events: [] } });
  assert.equal(fit.fitted, false);
  assert.equal(fit.impossible, true);
  assert.ok(fit.actualAfter < 65);
  assert.equal(fit.min, 65); assert.equal(fit.max, 90);
});

ok('safeWords demotion does not change duration; Duration Fit still triggers', () => {
  // Base 48s (> 0.7*min): a modest, in-policy extension reaches range.
  const speaking = [ origBeat('h', 'hook', 0, 8), { ...origBeat('e', 'escalation', 100, 140), audioStrategy: 'narrator_over', speaks: true, narratorText: 'x' } ];
  const before = timelineSeconds(speaking);
  const demoted = speaking.map(b => b.beatId === 'e' ? { ...b, speaks: false, audioStrategy: 'original', narratorText: '' } : b);
  assert.equal(timelineSeconds(demoted), before, 'demotion left duration unchanged');
  const fit = planDurationFit(demoted, { config, sourceDuration: 1800, model: { events: [] } });
  assert.equal(fit.fitted, true, 'fit still runs after demotion and reaches range');
  assert.ok(fit.extensionRatio <= 1.0 + 1e-9, 'extension stayed within the extensionRatio guard');
});

ok('structural deficit with no unused events => still fits but is FLAGGED undercast', () => {
  // 28s of two beats for a 65s target is a STRUCTURAL deficit (< 0.7*min). With no
  // unused events available, Duration Fit will not fail the render, but it MUST
  // surface the problem (structuralDeficit + undercast + a high extensionRatio)
  // so the run is not silently reported as clean.
  const beats = [ origBeat('h', 'hook', 0, 8), origBeat('e', 'escalation', 100, 120) ]; // 28s
  const fit = planDurationFit(beats, { config, sourceDuration: 1800, model: { events: [] } });
  assert.equal(fit.structuralDeficit, true, 'flagged as a structural deficit');
  assert.equal(fit.undercast, true, 'flagged undercast');
  assert.ok(fit.extensionRatio > 0.5, `records how far it had to stretch (ratio ${fit.extensionRatio})`);
});

ok('structural deficit prefers ADDING distinct unused events over stretching', () => {
  // Same thin base, but now the model has distinct unused events to draw on:
  // the structural branch adds real events FIRST instead of holding one clip.
  const beats = [ origBeat('h', 'hook', 0, 8), origBeat('e', 'escalation', 100, 120) ]; // 28s
  const model = { events: [
    { id: 'u1', startSec: 300, endSec: 315, type: 'confrontation', tension: 0.8, visualQuality: 0.8, dialogueImpact: 0.6, novelty: 0.7, audioType: 'participant_speech', audioConfidence: 0.9 },
    { id: 'u2', startSec: 500, endSec: 520, type: 'reveal', tension: 0.85, visualQuality: 0.8, dialogueImpact: 0.5, novelty: 0.8, isReveal: true, audioType: 'officer_speech', audioConfidence: 0.9 }
  ] };
  const fit = planDurationFit(beats, { config, sourceDuration: 1800, model });
  assert.equal(fit.structuralDeficit, true, 'still a structural deficit');
  const ops = fit.operations.map(o => o.op);
  assert.ok(ops.indexOf('addEvents') === 0, 'addEvents ran FIRST (before any extend)');
  assert.ok(fit.beats.filter(b => b.addedByDurationFit).length >= 1, 'fit-added beat(s) exist');
  assert.equal(fit.fitted, true, 'reaches range via distinct events');
});

ok('already-in-range timeline is unchanged (no-op)', () => {
  const beats = [ origBeat('h', 'hook', 0, 30), origBeat('p', 'payoff', 100, 145) ]; // 75s
  const fit = planDurationFit(beats, { config, sourceDuration: 1800, model: { events: [] } });
  assert.equal(fit.changed, false);
  assert.equal(fit.fitted, true);
});

console.log(`\nAll ${passed} duration-fit assertions passed.`);
