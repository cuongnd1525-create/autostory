// Unit tests for the automated V3 acceptance assertions. Run: node tests/v3AcceptanceAssertions.test.js
const assert = require('node:assert');
const path = require('path');
const A = require(path.join(__dirname, '..', 'tools', 'v3AcceptanceAssertions.js'));

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ok -', name); };
const fails = (checks, group, frag) => checks.some(c => c.group === group && !c.pass && (!frag || c.name.includes(frag)));
const groupPass = (checks, group) => checks.filter(c => c.group === group).every(c => c.pass);

console.log('V3 acceptance assertions');

// A fully-good synthetic run.
const goodModel = { modelVersion: 5, events: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }], quotes: [{ id: 'q1', eventId: 'e1' }] };
const goodCoverage = { coverageRatio: 1, failedLeafWindows: [], feasible: true };
const goodMetas = [{ key: 'chunk_0', finishReason: 'STOP', usage: { totalTokenCount: 1200, candidatesTokenCount: 800, thoughtsTokenCount: 0 } }];
const goodDesign = {
  spines: [
    {
      centralViewerQuestion: 'Why were the parents holding the daughter down?',
      beats: [
        { beatId: 'b0', sourceStartSec: 32.5, sourceEndSec: 35.5, chronologyMode: 'teaser', retentionReason: 'escalation', newInformation: 'door confrontation' },
        { beatId: 'b1', sourceStartSec: 44.0, sourceEndSec: 47.0, chronologyMode: 'teaser', retentionReason: 'escalation', newInformation: 'screams upstairs' },
        { beatId: 'b2', sourceStartSec: 54.0, sourceEndSec: 57.0, chronologyMode: 'teaser', retentionReason: 'visual_reveal', newInformation: 'bathroom restraint' },
        { beatId: 'b3', sourceStartSec: 0.0, sourceEndSec: 5.0, chronologyMode: 'rewind', retentionReason: 'new_fact', newInformation: 'cruiser arrives' },
        { beatId: 'b4', sourceStartSec: 12.0, sourceEndSec: 17.0, chronologyMode: 'chronological', retentionReason: 'new_fact', newInformation: 'nathan outside' },
        { beatId: 'b5', sourceStartSec: 17.0, sourceEndSec: 22.0, chronologyMode: 'chronological', retentionReason: 'strong_quote', newInformation: 'nathan plea' },
        { beatId: 'b6', sourceStartSec: 58.0, sourceEndSec: 64.0, chronologyMode: 'chronological', retentionReason: 'reaction', newInformation: 'officer enters' },
        { beatId: 'b7', sourceStartSec: 64.0, sourceEndSec: 70.0, chronologyMode: 'chronological', retentionReason: 'reaction', newInformation: 'stepdad releases' },
        { beatId: 'b8', sourceStartSec: 102.0, sourceEndSec: 107.0, chronologyMode: 'chronological', retentionReason: 'contradiction', newInformation: 'mother claims no abuse' },
        { beatId: 'b9', sourceStartSec: 247.8, sourceEndSec: 253.0, chronologyMode: 'chronological', retentionReason: 'escalation', newInformation: 'officer with handcuffs' },
        { beatId: 'b10', sourceStartSec: 254.0, sourceEndSec: 258.0, chronologyMode: 'chronological', retentionReason: 'reaction', newInformation: 'suspect stood up' },
        { beatId: 'b11', sourceStartSec: 309.0, sourceEndSec: 314.5, chronologyMode: 'chronological', retentionReason: 'escalation', newInformation: 'officer double locks' },
        { beatId: 'b12', sourceStartSec: 863.0, sourceEndSec: 867.5, chronologyMode: 'chronological', retentionReason: 'visual_reveal', newInformation: 'daughter wrist grabs' },
        { beatId: 'b13', sourceStartSec: 867.5, sourceEndSec: 871.5, chronologyMode: 'chronological', retentionReason: 'visual_reveal', newInformation: 'daughter asks not to touch' },
        {
          beatId: 'b14', sourceStartSec: 1100.0, sourceEndSec: 1105.5, chronologyMode: 'chronological', narrativeRole: 'cliffhanger',
          retentionReason: 'strong_quote', newInformation: 'daughter reveals punch battery',
          cliffhangerQuestion: 'Will Georgia police arrest and charge the stepfather with battery?',
          cliffhangerNewInformation: 'Daughter explicitly claims stepfather punched both of them.',
          cliffhangerExpectedNextPayoff: 'Part 2 reveals whether felony battery charges are filed.',
          payoffTiming: 'part_2'
        }
      ]
    }
  ]
};
const goodBeats = [{ beatId: 'b1', sourceEventId: 'e1' }, { beatId: 'cov_e2', sourceEventId: 'e2', addedByCoverage: true }];
const goodSegments = [
  { id: 's1', audioMode: 'original_audio', sourceStartSec: 0, sourceEndSec: 30 },
  { id: 's2', audioMode: 'voiceover_only', voiceoverText: 'three short words here', sourceStartSec: 30, sourceEndSec: 75 }
];
const goodEditorial = { durationFit: { extensionRatio: 0.2, structuralDeficit: false } };
const goodProbe = { ok: true, bytes: 5_000_000, durationSec: 75, streams: [{ type: 'video', width: 1080, height: 1920, codec: 'h264' }, { type: 'audio', codec: 'aac' }] };

ok('a fully healthy run passes every group', () => {
  const r = A.evaluate({
    sourceModel: { model: goodModel, coverage: goodCoverage },
    aiRuntime: { requestMetadatas: goodMetas, errors: [], callBudget: 9, requestLimit: 16 },
    story: { design: goodDesign, beats: goodBeats, model: goodModel },
    narration: { segments: goodSegments, wordsPerSecond: 2.6 },
    duration: { segments: goodSegments, editorial: goodEditorial, minSec: 65, maxSec: 90 },
    render: { mp4Path: '/x/out.mp4', probe: goodProbe, expectedDurationSec: 75 }
  });
  assert.equal(r.passed, true, JSON.stringify(r.failed));
  assert.ok(r.total >= 18, `ran a real number of checks (${r.total})`);
});

ok('coverageRatio < 1 fails the source-model group', () => {
  const c = A.checkSourceModel({ model: goodModel, coverage: { coverageRatio: 0.66, failedLeafWindows: [{ start: 0, end: 575 }], feasible: true } });
  assert.ok(fails(c, 'source-model', 'coverageRatio'));
  assert.ok(fails(c, 'source-model', 'no failed source windows'));
});

ok('uncaught MAX_TOKENS / INPUT_ACCESS fail the ai-runtime group', () => {
  const c = A.checkAiRuntime({ requestMetadatas: [{ key: 'whole', finishReason: 'MAX_TOKENS', usage: { totalTokenCount: 5 } }],
    errors: [{ key: 'v3-story-design', message: 'AI chưa xác minh truy cập input của bước này.' }], callBudget: 20, requestLimit: 16 });
  assert.ok(fails(c, 'ai-runtime', 'MAX_TOKENS'));
  assert.ok(fails(c, 'ai-runtime', 'INPUT_ACCESS'));
  assert.ok(fails(c, 'ai-runtime', 'request budget'));
});

ok('invalid beat event id fails story structure', () => {
  const c = A.checkStoryStructure({ design: goodDesign, beats: [{ beatId: 'b1', sourceEventId: 'ZZZ' }], model: goodModel });
  assert.ok(fails(c, 'story', 'valid source events'));
});

ok('over-budget narration fails VOICE_BUDGET', () => {
  const seg = [{ id: 's2', audioMode: 'voiceover_only', voiceoverText: 'w '.repeat(80), sourceStartSec: 0, sourceEndSec: 5 }];
  const c = A.checkNarration({ segments: seg, wordsPerSecond: 2.6 });
  assert.ok(fails(c, 'narration', 'VOICE_BUDGET'));
});

ok('out-of-range duration + over-extension fail the duration group', () => {
  const seg = [{ id: 's1', sourceStartSec: 0, sourceEndSec: 40 }];
  const c = A.checkDuration({ segments: seg, editorial: { durationFit: { extensionRatio: 2.4, structuralDeficit: true } }, minSec: 65, maxSec: 90 });
  assert.ok(fails(c, 'duration', 'in ['));
  assert.ok(fails(c, 'duration', 'extensionRatio'));
  assert.ok(fails(c, 'duration', 'undercast'));
});

ok('missing streams / zero-byte / wrong duration fail rendering', () => {
  const c1 = A.checkRendering({ mp4Path: '/x/o.mp4', probe: { ok: true, bytes: 0, durationSec: 0, streams: [] }, expectedDurationSec: 75 });
  assert.ok(fails(c1, 'render', 'non-empty'));
  assert.ok(fails(c1, 'render', 'video stream'));
  assert.ok(fails(c1, 'render', 'audio stream'));
  const c2 = A.checkRendering({ mp4Path: '/x/o.mp4', probe: { ok: true, bytes: 5e6, durationSec: 30, streams: [{ type: 'video', width: 1080, height: 1920 }, { type: 'audio' }] }, expectedDurationSec: 75 });
  assert.ok(fails(c2, 'render', 'matches compiled timeline'));
});

ok('staged whole/compact success (no chunk-coverage) still passes source-model coverage', () => {
  const c = A.checkSourceModel({ model: goodModel, coverage: null });
  assert.ok(groupPass(c, 'source-model'));
});

console.log(`\nAll ${passed} acceptance-assertion tests passed.`);
