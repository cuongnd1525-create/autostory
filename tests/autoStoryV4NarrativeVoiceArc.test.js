// Regression for the exact 1013_01 failure: block_8 had 1.7s of picture,
// the writer was told to reduce the spoken narrative to about FOUR WORDS.
// This is a director/EDL problem, not a TTS speed or rewrite problem.
const assert = require('node:assert/strict');
const Delivery = require('../electron/services/deliveryBlockService');
const Writer = require('../electron/services/blockNarrationService');
const Director = require('../electron/services/editorialDirectorService');

const beat = (id, start, end) => ({
  beatId: id, sourceStartSec: start, sourceEndSec: end, narrativeRole: 'context'
});
const shortBeats = [beat('hook', 0, 4), beat('context', 10, 11.7), beat('payoff', 20, 27)];
const delivery = (beats = shortBeats) => [
  { blockId: 'hook', mode: 'raw_evidence', beatIds: ['hook'], storyFunction: 'hook', evidenceFunction: 'real confrontation' },
  { blockId: 'block_8', mode: 'narrated_story', beatIds: ['context'], storyFunction: 'explain consequence',
    narratorFunction: 'BRIDGE', narrationIntent: 'explain why the officer became suspicious',
    sourceAudioTreatment: 'voiceover_with_ambient' },
  { blockId: 'payoff', mode: 'raw_evidence', beatIds: ['payoff'], storyFunction: 'ending', evidenceFunction: 'real confession' }
];

(async () => {
  const tooShort = Delivery.validateDeliveryBlocks(shortBeats, delivery(), {
    minNarrationSec: 5
  });
  assert.ok(tooShort.some(v => v.code === 'NARRATED_STORY_WINDOW_TOO_SHORT'
    && v.blockId === 'block_8' && v.availableSec < 1.8));
  assert.equal(Delivery.validateDeliveryBlocks(shortBeats, delivery(), { minNarrationSec: 0 }).length, 0,
    'legacy/manual editors do not inherit a V4-only voice-runway rule');

  const noNarrator = delivery().map(b => b.blockId === 'block_8'
    ? { ...b, mode: 'raw_evidence', evidenceFunction: 'meaningful original exchange' } : b);
  assert.equal(Delivery.validateDeliveryBlocks(shortBeats, noNarrator, { minNarrationSec: 5 }).length, 0,
    'the policy does NOT demand a narrator where the source audio is sufficient');

  const grouped = [beat('hook', 0, 4), beat('context', 10, 12), beat('context2', 12, 16), beat('payoff', 20, 27)];
  const groupBlocks = delivery().map(b => b.blockId === 'block_8'
    ? { ...b, beatIds: ['context', 'context2'] } : b);
  assert.equal(Delivery.validateDeliveryBlocks(grouped, groupBlocks, { minNarrationSec: 5 }).length, 0,
    'one 6s continuous narrator passage over TWO cuts is valid');

  // The Director must reject the source EDL before TTS. Proof that the
  // producer's REAL validation path consults natural-voice runway.
  const scope = { storyScopeId: 'case', scopeWindows: [{ startSec: 0, endSec: 30 }] };
  const report = Director.validateDirectorEdl({ beats: shortBeats, deliveryBlocks: delivery() }, scope,
    { durationSec: 40, targetDurationMinSec: 1, targetDurationMaxSec: 100,
      reel: { ranges: [] }, narrationEnabled: true,
      requireDeliveryBlocks: true, minNarrationSec: 5 });
  assert.ok(report.violations.some(v => v.code === 'NARRATED_STORY_WINDOW_TOO_SHORT'),
    'Director must recut/regroup the EDL rather than accept micro-narration');

  let requests = 0, tts = 0;
  const engine = {
    config: { narration: { enabled: true, measuredWordsPerSecond: 2.2 }, narrationMinBlockSec: 5 },
    project: {}, sourceHash: 'case', cache: 'ignored',
    ask: async () => { requests++; throw Error('should not request fragmented narration'); }
  };
  const service = { measuredVoice: async () => { tts++; throw Error('should not synthesize'); } };
  await assert.rejects(() => Writer.narrateBlocks({
    engine, service, story: { scriptId: 1 }, model: { events: [], quotes: [] },
    beats: shortBeats, blocks: delivery(), evidence: []
  }), e => e.kind === 'DIRECTOR_REPAIR_REQUIRED' &&
    e.details.violations[0].code === 'NARRATED_BLOCK_FRAGMENTED');
  assert.equal(requests, 0, 'no Vertex calls are wasted rewriting into four words');
  assert.equal(tts, 0, 'no TTS synthesis on a fragment that needs an EDL recut');

  assert.match(Director.instruction, /ONE narrator is telling ONE story/);
  assert.match(Writer.INSTRUCTION, /entire narrator voice arc/);
  console.log('V4 narrator arc: 1.7s fragments rejected early; multi-beat continuous passages allowed');
})().catch(e => { console.error(e); process.exitCode = 1; });
