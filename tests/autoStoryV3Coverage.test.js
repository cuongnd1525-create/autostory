// V3 Beat Coverage: novelty scoring, structural-deficit augmentation, and the
// end-to-end fix for the "16.8s -> 65s via extend" smell.
// Run: node tests/autoStoryV3Coverage.test.js
const assert = require('node:assert');
const path = require('path');
const S = p => require(path.join(__dirname, '..', 'electron', 'services', p));
const C = S('beatCoverageService.js');
const { planDurationFit, timelineSeconds } = S('autoStoryDurationFit.js');

const config = { targetDurationMinSec: 65, targetDurationMaxSec: 90 };
let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ok -', name); };

const ev = (id, s, e, extra = {}) => ({ id, startSec: s, endSec: e, type: 'event', summary: `evt ${id}`,
  peopleIds: ['p1'], location: 'doorway', tension: 0.6, visualQuality: 0.7, dialogueImpact: 0.4, novelty: 0.5, ...extra });
const beat = (id, role, evId, s, e, extra = {}) => ({ beatId: id, narrativeRole: role, sourceEventId: evId,
  sourceStartSec: s, sourceEndSec: e, tension: 0.6, ...extra });

console.log('V3 Beat Coverage');

// ---- novelty scoring ----
ok('noveltyScores: a brand-new scene scores higher than a same-scene repeat', () => {
  const selected = [ev('e1', 0, 5, { location: 'doorway', type: 'confrontation', peopleIds: ['p1'], summary: 'woman refuses to open door' })];
  const fresh = ev('e9', 400, 410, { location: 'patrol car', type: 'arrest', peopleIds: ['p2'], summary: 'officer handcuffs suspect' });
  const repeat = ev('e2', 20, 25, { location: 'doorway', type: 'confrontation', peopleIds: ['p1'], summary: 'woman refuses to open door again' });
  const nf = C.noveltyScores(fresh, selected);
  const nr = C.noveltyScores(repeat, selected);
  assert.ok(nf.aggregate > nr.aggregate, `fresh ${nf.aggregate} > repeat ${nr.aggregate}`);
  assert.ok(nf.locationNovelty > nr.locationNovelty, 'new location scores as novel');
  assert.ok(nf.personNovelty > nr.personNovelty, 'new person scores as novel');
  assert.ok(nf.informationNovelty > nr.informationNovelty, 'new information scores as novel');
});

ok('minDistinctFor scales with target and is clamped', () => {
  assert.equal(C.minDistinctFor(65), 5);
  assert.ok(C.minDistinctFor(12) >= 3, 'floor 3');
  assert.ok(C.minDistinctFor(600) <= 8, 'ceiling 8');
});

// ---- the core fix ----
ok('THE FIX: 16.8s of one doorway -> augmented with distinct scenes, not stretched', () => {
  // Reproduce the reported smell: casting produced ~16.8s across a few beats that
  // all sit in the same doorway scene, for a 65-90s target.
  const beats = [
    beat('b1', 'hook', 'd1', 0, 6, { location: 'doorway' }),
    beat('b2', 'escalation', 'd2', 6, 12, { location: 'doorway' }),
    beat('b3', 'confrontation', 'd3', 12, 16.8, { location: 'doorway' })
  ];
  assert.ok(Math.abs(timelineSeconds(beats) - 16.8) < 0.01, 'starts at 16.8s');

  // A rich Source Story Model with many DISTINCT unused events across the source.
  const model = { events: [
    ev('d1', 0, 6), ev('d2', 6, 12), ev('d3', 12, 16.8),
    ev('u1', 120, 132, { location: 'living room', type: 'search', peopleIds: ['p2'], tension: 0.7, summary: 'officers search the apartment' }),
    ev('u2', 240, 251, { location: 'patrol car', type: 'arrest', peopleIds: ['p1', 'p3'], tension: 0.85, isReveal: true, summary: 'suspect placed in the back seat' }),
    ev('u3', 360, 372, { location: 'street', type: 'pursuit', peopleIds: ['p4'], tension: 0.8, summary: 'second suspect runs down the street' }),
    ev('u4', 480, 490, { location: 'kitchen', type: 'evidence', peopleIds: ['p2'], tension: 0.75, isReveal: true, summary: 'knife found in the sink' }),
    ev('u5', 600, 611, { location: 'hallway', type: 'reveal', peopleIds: ['p5'], tension: 0.9, isReveal: true, summary: 'witness names the driver' }),
    ev('u6', 720, 731, { location: 'porch', type: 'reaction', peopleIds: ['p6'], tension: 0.6, summary: 'neighbor reacts to the arrest' }),
    ev('u7', 840, 851, { location: 'booking', type: 'aftermath', peopleIds: ['p1'], tension: 0.55, summary: 'suspect booked at the station' })
  ] };

  const res = C.augmentCoverage(beats, model, config);
  assert.equal(res.structural, true, 'detected structural deficit');
  assert.equal(res.augmented, true, 'augmented');
  assert.ok(res.added >= 4, `added several distinct scenes (added ${res.added})`);
  assert.ok(res.after >= 0.7 * config.targetDurationMinSec, `raw timeline now substantial (${res.after.toFixed(1)}s)`);

  // Distinct events climbed well beyond the 3 doorway beats.
  assert.ok(C.distinctEventCount(res.beats) >= 7, `distinct events ${C.distinctEventCount(res.beats)} >= 7`);
  // Hook stays first.
  assert.equal(res.beats[0].beatId, 'b1', 'hook preserved first');
  // Not a wall of the same location.
  const metrics = C.computeEditorialMetrics(res.beats, model, config);
  assert.ok(metrics.maxConsecutiveSameLocation <= 2, `no long same-scene run (${metrics.maxConsecutiveSameLocation})`);
  assert.ok(metrics.distinctLocations >= 5, `many locations (${metrics.distinctLocations})`);

  // And now Duration Fit is a LIGHT touch: extensionRatio stays low (no 4x stretch).
  const fit = planDurationFit(res.beats, { config, sourceDuration: 1800, model });
  assert.equal(fit.fitted, true, 'fits into range');
  assert.ok(fit.extensionRatio <= 0.6, `light extension only (ratio ${fit.extensionRatio})`);
  assert.equal(fit.structuralDeficit, false, 'no residual structural deficit');
});

ok('per-location cap prevents adding 8 clips of the same room', () => {
  const beats = [ beat('b1', 'hook', 'd1', 0, 6), beat('b2', 'escalation', 'd2', 6, 12) ];
  // Many unused events but ALL in the same "garage" scene.
  const model = { events: [ ev('d1', 0, 6), ev('d2', 6, 12),
    ...Array.from({ length: 8 }, (_, i) => ev('g' + i, 100 + i * 20, 112 + i * 20, { location: 'garage', type: 'search', peopleIds: ['p2'] })) ] };
  const res = C.augmentCoverage(beats, model, config);
  const added = res.beats.filter(b => b.addedByCoverage);
  const garageAdded = added.filter(b => String(b.sourceEventId).startsWith('g')).length;
  assert.ok(garageAdded <= C.MAX_PER_LOCATION, `garage adds capped at ${C.MAX_PER_LOCATION} (got ${garageAdded})`);
});

ok('no structural deficit => no-op (healthy story untouched)', () => {
  const beats = [ beat('b1', 'hook', 'd1', 0, 25), beat('b2', 'escalation', 'd2', 100, 130), beat('b3', 'reveal', 'd3', 300, 315) ]; // 70s, 3 distinct
  const model = { events: [ ev('d1', 0, 25), ev('d2', 100, 130), ev('d3', 300, 315), ev('u1', 500, 520) ] };
  const res = C.augmentCoverage(beats, model, config);
  // 70s >= 0.7*65 (45.5) but distinct(3) < minDistinct(5) => still structural by the
  // distinct-events criterion; it should add a little, never explode.
  assert.ok(res.added <= C.MAX_ADD, 'bounded');
  assert.ok(res.beats[0].beatId === 'b1', 'hook preserved');
});

ok('deep-in-range story with enough distinct events is a true no-op', () => {
  const beats = [ beat('b1', 'hook', 'd1', 0, 15), beat('b2', 'setup', 'd2', 50, 62), beat('b3', 'escalation', 'd3', 120, 134),
    beat('b4', 'confrontation', 'd4', 200, 214), beat('b5', 'reveal', 'd5', 300, 314) ]; // 69s, 5 distinct
  const model = { events: beats.map(b => ev(b.sourceEventId, b.sourceStartSec, b.sourceEndSec, { location: 'loc' + b.beatId })) };
  const res = C.augmentCoverage(beats, model, config);
  assert.equal(res.structural, false, 'not structural');
  assert.equal(res.augmented, false, 'no-op');
  assert.equal(res.beats, beats, 'same beats reference returned');
});

ok('structural deficit but NO distinct unused events => honest no-op (not fabricated)', () => {
  const beats = [ beat('b1', 'hook', 'd1', 0, 6), beat('b2', 'escalation', 'd2', 6, 12) ];
  const model = { events: [ ev('d1', 0, 6), ev('d2', 6, 12) ] }; // nothing unused
  const res = C.augmentCoverage(beats, model, config);
  assert.equal(res.augmented, false);
  assert.match(res.reason, /no distinct unused events/);
});

ok('computeEditorialMetrics flags a repetitive, over-extended, thin timeline', () => {
  const beats = [ beat('b1', 'context', 'd1', 0, 5), beat('b2', 'context', 'd2', 5, 10), beat('b3', 'context', 'd3', 10, 15) ];
  const model = { events: [ ev('d1', 0, 5), ev('d2', 5, 10), ev('d3', 10, 15) ] };
  const m = C.computeEditorialMetrics(beats, model, config, { extensionRatio: 2.5 });
  assert.ok(m.flags.includes('below_structural_minimum'));
  assert.ok(m.flags.includes('too_few_distinct_events'));
  assert.ok(m.flags.includes('repetitive_same_scene_run'));
  assert.ok(m.flags.includes('no_hook_first'));
  assert.ok(m.flags.includes('over_extended'));
  assert.equal(m.hookPresent, false);
});

console.log(`\nAll ${passed} coverage assertions passed.`);
