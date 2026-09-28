// AutoStory v3 deterministic-core tests. Run: node tests/autoStoryV3.test.js
const assert = require('node:assert');
const path = require('path');
const S = p => require(path.join(__dirname, '..', 'electron', 'services', p));

const { decideAudioRole } = S('audioRoleStateMachine');
const gate = S('narrationGate');
const { castBeats } = S('beatCastingService');
const { resolveTtsIntent, applyToEngine } = S('ttsIntent');
const { resolveSegmentAudio } = S('highlightAudioPlan');
const model = S('sourceStoryModelService');
const { compileV3, highlightV3 } = S('autoStoryV3Compile');

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ok -', name); };

console.log('audioRoleStateMachine');
ok('Test C: high-impact -> original audio, narrator silent', () => {
  const r = decideAudioRole({ tension: 0.9, narrationEnabled: true, audioDisposition: 'CLEAN' });
  assert.equal(r.strategy, 'original'); assert.equal(r.speak, false);
});
ok('audio event forces original even at mid tension', () => {
  const r = decideAudioRole({ tension: 0.4, audioEvent: true, audioDisposition: 'CLEAN' });
  assert.equal(r.strategy, 'original');
});
ok('empty info gap -> original', () => {
  assert.equal(decideAudioRole({ tension: 0.3, infoGapEmpty: true, audioDisposition: 'CLEAN' }).strategy, 'original');
});
ok('Test B: needs setup before -> setup_then_original', () => {
  const r = decideAudioRole({ tension: 0.4, needsSetupBefore: true, audioDisposition: 'CLEAN' });
  assert.equal(r.strategy, 'setup_then_original'); assert.equal(r.speak, true);
});
ok('unclean source -> narrator_over', () => {
  assert.equal(decideAudioRole({ tension: 0.3, audioDisposition: 'REPLACE' }).strategy, 'narrator_over');
});
ok('narration disabled -> original', () => {
  assert.equal(decideAudioRole({ tension: 0.3, narrationEnabled: false }).strategy, 'original');
});
ok('default gap -> narrator_over ducked', () => {
  assert.equal(decideAudioRole({ tension: 0.3, audioDisposition: 'CLEAN' }).strategy, 'narrator_over');
});

console.log('narrationGate');
const gModel = {
  events: [{ id: 'e1', isReveal: false }, { id: 'e5', isReveal: true }],
  quotes: [
    { id: 'q9', text: "I'm not getting out of the car", epistemic: 'suspect_statement' },
    { id: 'q1', text: 'dispatch confirms the warrant', epistemic: 'known_fact' }
  ],
  facts: [{ id: 'f_warrant' }]
};
ok('Test A: reject narration that parrots the dialogue', () => {
  const r = gate.inspect([{ beatId: 'b1', order: 0, speaks: true, narratorFunction: 'CLARIFICATION',
    narratorText: 'The driver refuses to get out of the car', originalQuoteIds: ['q9'],
    newInformation: ['refusal'], newInformationRefs: ['q9'] }], gModel);
  assert.equal(r.passed, false);
  assert.ok(r.issues.some(i => i.code === 'dialogue_redundancy'));
  assert.deepEqual(r.repairBeatIds, ['b1']);
});
ok('Test D: non-fact stated as fact is rejected (epistemic)', () => {
  const r = gate.inspect([{ beatId: 'b2', order: 0, speaks: true, narratorFunction: 'CONTEXT',
    narratorText: 'He is guilty of armed robbery', newInformation: ['guilt'], newInformationRefs: ['q9'] }], gModel);
  assert.ok(r.issues.some(i => i.code === 'epistemic'));
});
ok('epistemic ok when hedged', () => {
  const r = gate.inspect([{ beatId: 'b2', order: 0, speaks: true, narratorFunction: 'CONTEXT',
    narratorText: 'Police say he refused to comply', newInformation: ['claim'], newInformationRefs: ['q9'] }], gModel);
  assert.ok(!r.issues.some(i => i.code === 'epistemic'));
});
ok('Test E: open loop (setup now, payoff later) is allowed', () => {
  const beats = [
    { beatId: 'b1', order: 0, speaks: true, narratorFunction: 'FORESHADOW',
      narratorText: 'What the officer does not know yet changes everything', opensLoopId: 'L1',
      informationClass: 'deferred', newInformation: ['warrant exists'], newInformationRefs: ['f_warrant'] },
    { beatId: 'b2', order: 1, sourceEventId: 'e5', speaks: false, closesLoopId: 'L1' }
  ];
  const r = gate.inspect(beats, gModel);
  assert.equal(r.passed, true, JSON.stringify(r.issues));
});
ok('spoiler: narrating a later reveal event early is blocked', () => {
  const beats = [
    { beatId: 'b1', order: 0, speaks: true, narratorFunction: 'CONTEXT',
      narratorText: 'The search turns up something serious', newInformation: ['reveal'], newInformationRefs: ['e5'] },
    { beatId: 'b2', order: 1, sourceEventId: 'e5', speaks: false }
  ];
  const r = gate.inspect(beats, gModel);
  assert.ok(r.issues.some(i => i.code === 'spoiler'));
});
ok('no narratorFunction is rejected', () => {
  const r = gate.inspect([{ beatId: 'b1', order: 0, speaks: true, narratorText: 'Something happens',
    newInformation: ['x'], newInformationRefs: ['q1'] }], gModel);
  assert.ok(r.issues.some(i => i.code === 'no_function'));
});
ok('ungrounded factual claim is rejected', () => {
  const r = gate.inspect([{ beatId: 'b1', order: 0, speaks: true, narratorFunction: 'CONTEXT',
    narratorText: 'He had three prior arrests', newInformation: ['priors'], newInformationRefs: [] }], gModel);
  assert.ok(r.issues.some(i => i.code === 'ungrounded'));
});

console.log('beatCastingService');
ok('Test H: recast a weak beat to the stronger unused event of the same role', () => {
  const m = { events: [
    { id: 'weak', type: 'confrontation', startSec: 100, endSec: 106, tension: 0.4, visualQuality: 0.8, peopleIds: ['p1'] },
    { id: 'strong', type: 'confrontation', startSec: 600, endSec: 612, tension: 0.9, visualQuality: 0.8, peopleIds: ['p1'] }
  ] };
  const beats = [{ beatId: 'b1', narrativeRole: 'escalation', sourceEventId: 'weak', tensionBefore: 0.5, tensionAfter: 0.95 }];
  const { beats: cast } = castBeats(beats, m);
  assert.equal(cast[0].sourceEventId, 'strong');
});
ok('purpose-level dedup: two same-role beats do not reuse the same moment', () => {
  const m = { events: [
    { id: 'a', type: 'confrontation', startSec: 10, endSec: 16, tension: 0.9, visualQuality: 0.8 },
    { id: 'b', type: 'confrontation', startSec: 400, endSec: 406, tension: 0.7, visualQuality: 0.8 }
  ] };
  const beats = [
    { beatId: 'b1', narrativeRole: 'escalation' },
    { beatId: 'b2', narrativeRole: 'escalation' }
  ];
  const { beats: cast } = castBeats(beats, m);
  assert.notEqual(cast[0].sourceEventId, cast[1].sourceEventId);
});

console.log('ttsIntent');
ok('Test F: emotion + prosody reach Edge and ElevenLabs', () => {
  const intent = resolveTtsIntent({ emotionTag: 'tense', prosody: { pauseBeforeSec: 0.3 } });
  assert.equal(intent.emotionTag, 'TENSE');
  const edge = applyToEngine('edge_neural', intent, { ratePct: 0 });
  assert.ok(/%$/.test(edge.rate)); assert.equal(edge.pauseBeforeSec, 0.3);
  const el = applyToEngine('elevenlabs', intent);
  assert.equal(el.performanceMode, 'cliffhanger');
  const urgent = applyToEngine('elevenlabs', resolveTtsIntent({ emotionTag: 'URGENT' }));
  assert.equal(urgent.performanceMode, 'panic');
});

console.log('highlightAudioPlan');
ok('Test G: v3 narrator-over clean source DUCKS, does not mute', () => {
  const r = resolveSegmentAudio({ audio_mode: 'voiceover_with_ambient' }, { narrationDuckDefault: true, mixer: { sourceVolume: 25 } });
  assert.equal(r.duck, true); assert.equal(r.mute, false); assert.ok(r.sourceVolume > 0);
});
ok('unclean source still mutes even in v3', () => {
  const r = resolveSegmentAudio({ audio_mode: 'voiceover_only', sourceNarratorDetected: true }, { narrationDuckDefault: true });
  assert.equal(r.mute, true); assert.equal(r.sourceVolume, 0);
});
ok('original beat keeps full source', () => {
  const r = resolveSegmentAudio({ audio_mode: 'original_audio' }, { narrationDuckDefault: true });
  assert.equal(r.audioMode, 'original_audio'); assert.equal(r.sourceVolume, 1);
});

console.log('sourceStoryModel.normalize');
ok('audio event raises event tension; word window + epistemic default attached', () => {
  const raw = {
    people: [{ label: 'Driver', role: 'suspect', firstSeenSec: 5 }],
    events: [{ startSec: 10, endSec: 20, type: 'confrontation', tension: 0.3, visualQuality: 0.8 }],
    quotes: [{ eventId: 'e1', text: 'no', startSec: 12, endSec: 13 }]
  };
  const m = model.normalize(raw, { duration: 100, audioEvents: [{ type: 'raised_voice', startSec: 11, endSec: 14, peak: 0.95 }],
    words: [{ word: 'no', start: 12.1, end: 12.6, probability: 0.9 }] });
  assert.ok(m.events[0].tension > 0.3, 'tension raised by audio event');
  assert.equal(m.quotes[0].epistemic, 'unknown');
  assert.ok(Number.isFinite(m.quotes[0].wordStartSec));
});

console.log('autoStoryV3Compile (integration with real compiler primitives)');
ok('cast beats -> renderer segments: hook first, duck for narrator, mute for unclean, emotion carried', () => {
  // Evidence clips covering the source ranges (mirrors media.prepare output shape).
  const evidence = [
    { id: 'c1', sourceStart: 0, duration: 30, file: 'c1.mp4' },
    { id: 'c2', sourceStart: 100, duration: 30, file: 'c2.mp4' },
    { id: 'c3', sourceStart: 600, duration: 30, file: 'c3.mp4' }
  ];
  const beats = [
    { beatId: 'b1', narrativeRole: 'hook', sourceStartSec: 2, sourceEndSec: 8, audioStrategy: 'original',
      audioType: 'participant_speech', audioConfidence: 0.95 },
    { beatId: 'b2', narrativeRole: 'setup', sourceStartSec: 100, sourceEndSec: 112, audioStrategy: 'narrator_over',
      audioType: 'participant_speech', audioConfidence: 0.9, narratorText: 'A routine plate check comes back with a warrant.',
      previewVi: 'Kiem tra bien so tra ve mot lenh bat.', narratorFunction: 'FORESHADOW', emotionTag: 'tense',
      prosody: { pauseBeforeSec: 0.2 }, opensLoopId: 'L1', informationClass: 'deferred' },
    { beatId: 'b3', narrativeRole: 'reveal', sourceStartSec: 604, sourceEndSec: 612, audioStrategy: 'narrator_over',
      audioType: 'external_narrator', audioConfidence: 0.9, narratorText: 'What they find changes the whole stop.',
      previewVi: 'Nhung gi ho tim thay thay doi tat ca.', narratorFunction: 'PAYOFF_SETUP', emotionTag: 'grave' }
  ];
  const story = { scriptId: 1, title: 'Standoff', centralViewerQuestion: 'Why wont he get out?',
    spine: { centralViewerQuestion: 'Why wont he get out?' }, openLoops: [{ id: 'L1' }] };
  const config = { targetDurationMinSec: 20, targetDurationMaxSec: 120, narration: { enabled: true, measuredWordsPerSecond: 2.6 } };

  const script = compileV3(beats, { story, evidence, config, sourceDuration: 1800 });
  assert.equal(script.segments.length, 3);
  assert.equal(script.segments[0].storyRole, 'hook');           // first maps to hook
  assert.equal(script.segments[0].audioMode, 'original_audio');
  assert.equal(script.segments[1].audioMode, 'voiceover_with_ambient'); // clean -> DUCK
  assert.equal(script.segments[1].duck, true);
  assert.equal(script.segments[1].emotionTag, 'tense');
  assert.equal(script.segments[1].narratorFunction, 'FORESHADOW');
  assert.equal(script.segments[2].audioMode, 'voiceover_only');  // unclean -> MUTE
  assert.equal(script.segments[2].mute, true);

  const art = highlightV3(script, story, evidence);
  assert.equal(art.contractVersion, 3);
  assert.equal(art.segments[1].audio_mode, 'voiceover_with_ambient');
  assert.equal(art.segments[1].duck, true);
  assert.equal(art.segments[1].narrator_function, 'FORESHADOW');
  assert.equal(art.segments[2].mute, true);
});

console.log(`\nAll ${passed} v3 assertions passed.`);
