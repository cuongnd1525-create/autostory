// 429 regression: a cached, evidence-grounded V4 narration text stage should
// fail over to a GA model once, validate, persist and reuse it on resume.
// Hook/Director/source multimedia stages must NEVER silently switch models.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const AutoStoryFastService = require('../electron/services/autoStoryFastService');
const BlockNarration = require('../electron/services/blockNarrationService');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'v4-vertex-429-'));
  try {
    const requests = [], logs = [];
    const primary = 'gemini-3.1-pro-preview';
    const vertex = {
      getModel: () => primary,
      budgetStatus: async () => null,
      lastUsage: null, lastResponseText: '', lastResponseMetadata: null,
      generateJsonFromFiles: async args => {
        requests.push({ model: args.modelOverride || primary, files: args.filePaths || [], prompt: args.prompt });
        if (!args.modelOverride) {
          const err = new Error('Vertex AI request failed (429): RESOURCE_EXHAUSTED');
          err.httpStatus = 429;
          throw err;
        }
        return { accessGranted: true, narrations: [{ blockId: 'setup', narrationText: 'Earlier, the officer stopped him.',
          previewVi: 'Trước đó, cảnh sát dừng anh ta.', narratorFunction: 'BRIDGE',
          newInformation: [], newInformationRefs: [], emotionTag: 'NEUTRAL' }] };
      }
    };
    const svc = new AutoStoryFastService({ vertexAutoStoryMaxCalls: 28 }, {}, {
      vertex, ffmpeg: {}, dubbing: {}, callBudget: { calls: 0, runId: '429-regression' },
      retryWait: async () => {}
    });
    const input = { blocks: [{ blockId: 'setup' }], sourceHash: 'same-source' };
    const args = { taskType: 'auto_story_edit', sourceContract: true, localRepair: true,
      filePaths: [], prompt: 'Write a grounded short bridge.', responseSchema: null };
    const validate = async v => assert.equal(v.narrations?.[0]?.blockId, 'setup');
    const first = await svc.stage(root, 'v5-block-narration-1', input, args, validate,
      x => logs.push(x.message || ''));
    assert.equal(first.narrations[0].blockId, 'setup');
    assert.deepEqual(requests.map(x => x.model), [primary, 'gemini-3.5-flash']);
    assert.ok(logs.some(x => /429/.test(x) && /gemini-3.5-flash/.test(x)), 'visible provider failover');
    assert.equal(svc.callBudget.calls, 2, 'one rejected preview call and one accepted GA call');
    await svc.stage(root, 'v5-block-narration-1', input, args, validate,
      x => logs.push(x.message || ''));
    assert.equal(requests.length, 2, 'resume should reuse validated fallback without another 429');

    // Rewrites use the same failover policy, but never send new source video.
    await svc.stage(root, 'v5-block-narration_rewrite1-1', input, args, validate);
    assert.deepEqual(requests.slice(-2).map(x => x.model), [primary, 'gemini-3.5-flash']);

    const beforeHook = requests.length;
    await assert.rejects(() => svc.stage(root, 'v4-hook-audition-1', input,
      { ...args, filePaths: ['real-hook.mp4'] }, validate), e => e.httpStatus === 429);
    assert.ok(requests.slice(beforeHook).every(x => x.model === primary),
      'hook audition remains on the multimodal verification model');
    assert.ok(requests.slice(beforeHook).every(x => x.files.includes('real-hook.mp4')));

    const passages = [];
    const evidence = [{ id: 'video', file: '/not-required.mp4' }];
    const writerEngine = {
      config: { narration: { enabled: true, measuredWordsPerSecond: 3 } },
      project: {}, cache: root,
      ask: async (_key, _input, _schema, _instruction, attached) => {
        passages.push(attached);
        return { narrations: [{ blockId: 'setup', narrationText: 'Earlier, officers found the vehicle.',
          previewVi: 'Trước đó, cảnh sát tìm thấy chiếc xe.', narratorFunction: 'BRIDGE',
          newInformation: [], newInformationRefs: [], emotionTag: 'NEUTRAL' }] };
      }
    };
    const beats = [{ beatId: 'b1', sourceStartSec: 10, sourceEndSec: 18,
      narrativeRole: 'context', observedInFootage: 'traffic stop',
      viewerStateBefore: 'unknown', viewerStateAfter: 'aware' }];
    const blocks = [{ blockId: 'setup', mode: 'narrated_story', beatIds: ['b1'],
      storyFunction: 'rewind', narratorFunction: 'BRIDGE', narrationIntent: 'orient rewind',
      sourceAudioTreatment: 'voiceover_with_ambient' }];
    const narrated = await BlockNarration.narrateBlocks({ engine: writerEngine,
      service: { measuredVoice: async () => ({ meta: { duration: 3 } }) },
      story: { scriptId: 1, centralViewerQuestion: 'Why was he stopped?', storyScope: {} },
      model: { events: [], quotes: [], facts: [] }, beats, blocks, evidence });
    assert.equal(narrated.blocks[0].narrationText, 'Earlier, officers found the vehicle.');
    assert.deepEqual(passages, [[]], 'narration must use verified text context, never reattach video');

    console.log('V4 Vertex 429 failover, schema validation, cache reuse and text-only narration passed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
