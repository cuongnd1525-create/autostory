// Regression: delivery-only repairs must reuse approved, unchanged narrated blocks.
// This file intentionally avoids the older, unrelated Media Critic fixture suite.
const assert = require('node:assert/strict');
const Delivery = require('../electron/services/deliveryBlockService');
const Writer = require('../electron/services/blockNarrationService');

const beats = [
  { beatId: 'h', sourceStartSec: 60, sourceEndSec: 66, narrativeRole: 'hook', chronologyMode: 'teaser',
    observedInFootage: 'confrontation', viewerStateBefore: 'unknown', viewerStateAfter: 'curious' },
  { beatId: 'a', sourceStartSec: 10, sourceEndSec: 18, narrativeRole: 'context',
    observedInFootage: 'the approach', viewerStateBefore: 'curious', viewerStateAfter: 'context' },
  { beatId: 'b', sourceStartSec: 20, sourceEndSec: 28, narrativeRole: 'escalation',
    observedInFootage: 'officer speaks', viewerStateBefore: 'context', viewerStateAfter: 'uncertain' },
  { beatId: 'c', sourceStartSec: 30, sourceEndSec: 42, narrativeRole: 'consequence',
    observedInFootage: 'suspect responds', viewerStateBefore: 'uncertain', viewerStateAfter: 'informed' },
  { beatId: 'e', sourceStartSec: 70, sourceEndSec: 82, narrativeRole: 'ending',
    observedInFootage: 'the result', viewerStateBefore: 'informed', viewerStateAfter: 'resolved' }
];
const blocks = () => [
  { blockId: 'raw_hook', mode: 'raw_evidence', beatIds: ['h'], storyFunction: 'hook' },
  { blockId: 'setup', mode: 'narrated_story', beatIds: ['a'], storyFunction: 'explain context',
    narratorFunction: 'BRIDGE', narrationIntent: 'explain rewind', sourceAudioTreatment: 'voiceover_with_ambient' },
  { blockId: 'middle', mode: 'narrated_story', beatIds: ['b'], storyFunction: 'explain decision',
    narratorFunction: 'BRIDGE', narrationIntent: 'explain officer decision', sourceAudioTreatment: 'voiceover_with_ambient' },
  { blockId: 'raw_consequence', mode: 'raw_evidence', beatIds: ['c'], storyFunction: 'evidence' },
  { blockId: 'raw_end', mode: 'raw_evidence', beatIds: ['e'], storyFunction: 'ending' }
];
const story = { scriptId: 1, centralViewerQuestion: 'What changed?',
  hookPromise: 'The encounter changes', storyScope: { mustWithhold: [] } };
(async () => {
  const requests = [], voiceCalls = [];
  const engine = {
    config: { narration: { enabled: true, measuredWordsPerSecond: 3 } },
    project: {}, sourceHash: 'source-A', cache: '/tmp',
    ask: async (_key, input) => {
      requests.push(input.blocks.map(b => b.blockId));
      engine.seenPayloads ||= input.blocks;
      return { accessGranted: true, narrations: input.blocks.map(b => ({
        blockId: b.blockId, narrationText: 'The situation changed.',
        previewVi: 'Tình hình thay đổi.', narratorFunction: 'BRIDGE',
        newInformation: [], newInformationRefs: [], emotionTag: 'NEUTRAL'
      })) };
    }
  };
  const service = { measuredVoice: async (_project, words) => {
    voiceCalls.push(words); return { meta: { duration: 1 } };
  } };
  const run = (b, s = story) => Writer.narrateBlocks({ engine, service, story: s,
    model: { events: [], quotes: [], facts: [] },
    beats: Delivery.applyDeliveryBlocks(beats, b), blocks: b, evidence: [] });
  const original = blocks();
  const first = await run(original);
  assert.deepEqual(first.audit.generatedBlockIds, ['setup', 'middle']);
  assert.deepEqual(requests, [['setup', 'middle']]);
  // Every locally written passage receives the same whole-story arc, including
  // untouched raw evidence that must not be narrated over.
  const firstPayloads = engine.seenPayloads;
  assert.ok(firstPayloads?.[0]?.narrationArc?.some(b => b.blockId === 'raw_end' && b.mode === 'raw_evidence'));
  assert.ok(firstPayloads[0].narrationArc.some(b => b.blockId === 'middle'));
  const repaired = blocks();
  repaired.find(b => b.blockId === 'middle').narrationIntent = 'clarify the revised reason';
  const second = await run(repaired);
  assert.deepEqual(second.audit.reusedBlockIds, ['setup']);
  assert.deepEqual(second.audit.generatedBlockIds, ['middle']);
  assert.deepEqual(requests, [['setup', 'middle'], ['middle']],
    'only the changed block gets a new Vertex request');
  assert.equal(second.blocks.find(b => b.blockId === 'setup').narrationText,
    first.blocks.find(b => b.blockId === 'setup').narrationText);
  await run(repaired);
  assert.equal(requests.length, 2, 'unchanged repair must issue no API requests');
  assert.equal(voiceCalls.length, 1, 'same passage measures TTS once within the run');
  await run(repaired, { ...story, hookPromise: 'Entirely different story promise' });
  assert.deepEqual(requests[2], ['setup', 'middle'], 'promise change invalidates caches');
  // Block emotion must win over a visual beat's emotion when picking the
  // narrator TTS voice settings. It is easy to regress by passing lead raw.
  const rendererSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'electron', 'services', 'dubbingService.js'), 'utf8');
  assert.match(rendererSource,
    /getSegmentVoiceRenderOptions\\(\\{\\s*\\.\\.\\.lead, emotionTag: lead\\.blockEmotionTag \\|\\| lead\\.emotionTag/,
    'narrated-block emotion must reach voice render options');
  console.log('V4 Block Narration incremental regeneration passed');
})().catch(e => { console.error(e); process.exit(1); });
