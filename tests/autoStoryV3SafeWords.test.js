// Bug-1 integration tests: overlong narration is repaired per-beat then demoted,
// and never aborts the whole script. Run: node tests/autoStoryV3SafeWords.test.js
const assert = require('node:assert');
const path = require('path');
const P = require(path.join(__dirname, '..', 'electron', 'services', 'autoStoryV3Pipeline.js'));
const { compileV3 } = require(path.join(__dirname, '..', 'electron', 'services', 'autoStoryV3Compile.js'));
const { enforceSafeWords, demoteOverflow, isOverflow } = P;

const config = { targetDurationMinSec: 10, targetDurationMaxSec: 120, narration: { enabled: true, measuredWordsPerSecond: 2.6 } };
const LONG = Array(30).fill('word').join(' ');   // 30 words — over budget for a ~6s clip
const SHORT = 'A warrant already came back.'; // 5 words — fits

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log('  ok -', name); };

(async () => {
  console.log('AutoStory v3 safeWords repair/demote');

  await ok('overflow > safeWords: repair only the failing beat, pipeline continues', async () => {
    const beats = [
      { beatId: 'b1', speaks: true, sourceStartSec: 0, sourceEndSec: 6, audioStrategy: 'narrator_over', narratorText: LONG, narratorFunction: 'CONTEXT' },
      { beatId: 'b2', speaks: true, sourceStartSec: 10, sourceEndSec: 16, audioStrategy: 'narrator_over', narratorText: SHORT, narratorFunction: 'CONTEXT' }
    ];
    let repairedBeatIds = null;
    const result = await enforceSafeWords(beats, config, async (over) => {
      repairedBeatIds = over.map(b => b.beatId);
      return over.map(b => ({ beatId: b.beatId, voiceoverText: SHORT, previewVi: 'vi' })); // AI shortens successfully
    });
    assert.deepEqual(repairedBeatIds, ['b1'], 'only the overflowing beat was repaired');
    assert.equal(result[0].speaks, true, 'b1 keeps narration after successful repair');
    assert.equal(result[0].narratorText, SHORT);
    assert.equal(result[1].narratorText, SHORT, 'b2 untouched');
    assert.ok(!result.some(b => isOverflow(b, config)), 'no beat overflows after repair');
  });

  await ok('repair still > safeWords after 2 tries: demote to original, others intact', async () => {
    let attempts = 0;
    const beats = [
      { beatId: 'b1', speaks: true, sourceStartSec: 0, sourceEndSec: 6, audioStrategy: 'narrator_over', narratorText: LONG, narratorFunction: 'CONTEXT' },
      { beatId: 'b2', speaks: true, sourceStartSec: 10, sourceEndSec: 16, audioStrategy: 'narrator_over', narratorText: SHORT, narratorFunction: 'CONTEXT' }
    ];
    const result = await enforceSafeWords(beats, config, async (over) => {
      attempts++;
      return over.map(b => ({ beatId: b.beatId, voiceoverText: LONG, previewVi: 'vi' })); // AI keeps returning too-long
    });
    assert.equal(attempts, 2, 'exactly 2 targeted retries');
    assert.equal(result[0].speaks, false, 'b1 demoted');
    assert.equal(result[0].audioStrategy, 'original');
    assert.equal(result[0].narratorText, '');
    assert.equal(result[1].speaks, true, 'b2 still speaks');
  });

  await ok('after demote, the script still compiles (renderer contract)', async () => {
    const evidence = [
      { id: 'c1', sourceStart: 0, duration: 20, file: 'c1.mp4' },
      { id: 'c2', sourceStart: 100, duration: 20, file: 'c2.mp4' },
      { id: 'c3', sourceStart: 600, duration: 20, file: 'c3.mp4' }
    ];
    let beats = [
      { beatId: 'h', narrativeRole: 'hook', speaks: false, sourceStartSec: 2, sourceEndSec: 8, audioStrategy: 'original', audioType: 'participant_speech', audioConfidence: 0.95 },
      { beatId: 'x', narrativeRole: 'escalation', speaks: true, sourceStartSec: 104, sourceEndSec: 110, audioStrategy: 'narrator_over', audioType: 'participant_speech', audioConfidence: 0.9, narratorText: LONG, narratorFunction: 'CONTEXT', previewVi: 'vi' },
      { beatId: 'p', narrativeRole: 'reveal', speaks: true, sourceStartSec: 604, sourceEndSec: 612, audioStrategy: 'narrator_over', audioType: 'participant_speech', audioConfidence: 0.9, narratorText: SHORT, narratorFunction: 'PAYOFF_SETUP', previewVi: 'vi' }
    ];
    beats = await enforceSafeWords(beats, config, async (over) => over.map(b => ({ beatId: b.beatId, voiceoverText: LONG, previewVi: 'vi' })));
    assert.equal(beats[1].speaks, false, 'overlong beat demoted');
    const story = { scriptId: 1, title: 'T', centralViewerQuestion: 'Q', spine: {}, openLoops: [] };
    const script = compileV3(beats, { story, evidence, config, sourceDuration: 1800 });
    assert.equal(script.segments.length, 3, 'all beats compiled');
    assert.equal(script.segments[0].storyRole, 'hook');
    assert.equal(script.segments[1].audioMode, 'original_audio', 'demoted beat is original audio');
    assert.equal(script.segments[2].audioMode, 'voiceover_with_ambient', 'short narration retained + ducked');
  });

  await ok('demoteOverflow alone is a pure safety net', () => {
    const out = demoteOverflow([{ beatId: 'b', speaks: true, sourceStartSec: 0, sourceEndSec: 6, narratorText: LONG }], config);
    assert.equal(out[0].speaks, false);
    assert.equal(out[0].narratorText, '');
  });

  console.log(`\nAll ${passed} safeWords assertions passed.`);
})().catch(e => { console.error(e); process.exit(1); });
