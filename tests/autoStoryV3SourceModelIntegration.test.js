// REAL-PATH integration test for Source Story Model MAX_TOKENS recovery.
//
// The prior fake-engine unit test passed while the LIVE Electron run still aborted,
// because it bypassed engine.ask + service.stage — the exact layers that mint the
// localized MAX_TOKENS message and forward maxOutputTokens. This test drives the
// REAL chain:
//   sourceStoryModelService.build
//     -> autoStorySourceEngine.Engine.ask
//       -> AutoStoryFastService.stage           (real: mints the localized MAX_TOKENS error)
//         -> vertex.generateJsonFromFiles       (MOCKED — the only network boundary)
//
// Run: node tests/autoStoryV3SourceModelIntegration.test.js
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const S = require(path.join(__dirname, '..', 'electron', 'services', 'sourceStoryModelService.js'));
const { Engine } = require(path.join(__dirname, '..', 'electron', 'services', 'autoStorySourceEngine.js'));
const AutoStoryFastService = require(path.join(__dirname, '..', 'electron', 'services', 'autoStoryFastService.js'));
const V3 = require(path.join(__dirname, '..', 'electron', 'services', 'autoStoryV3Contracts.js'));

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log('  ok -', name); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-smi-'));

// A fully schema-valid compact/whole source model (passes autoStorySchemaBoundary + gates.access).
const validEvent = (id, s, e) => ({ id, startSec: s, endSec: e, type: 'confrontation', summary: `evt ${id}`, location: 'doorway',
  peopleIds: [], tension: 0.6, visualQuality: 0.7, novelty: 0.5, dialogueImpact: 0.3, isReveal: false, audioType: 'participant_speech', audioConfidence: 0.6 });
const validModel = (events = [validEvent('e1', 0, 5)]) => ({ accessGranted: true, people: [], events, quotes: [] });

const MAX_TOKENS_RAW = () => new Error('Gemini generation stopped: finishReason MAX_TOKENS (output truncated before valid JSON).');

// Build a service whose ONLY mocked surface is vertex.generateJsonFromFiles.
// metricsRoot is intentionally left unset so cost/estimate side-paths are skipped.
function makeService(script) {
  const calls = [];
  const vertex = {
    getModel: () => 'gemini-2.5-flash',
    lastResponseMetadata: {}, lastResponseText: '', lastUsage: null,
    budgetStatus: async () => null,
    generateJsonFromFiles: async (args) => {
      calls.push({ maxOutputTokens: args.maxOutputTokens, thinkingBudget: args.thinkingBudget, responseSchema: args.responseSchema, prompt: args.prompt });
      const step = script(calls.length);
      if (step instanceof Error) throw step;
      return step;
    }
  };
  const svc = new AutoStoryFastService({ vertexAutoStoryMaxCalls: 50 }, {}, { vertex, ffmpeg: {}, dubbing: {}, callBudget: { calls: 0 } });
  return { svc, calls };
}

function makeEngine(svc, cacheDir, duration = 1200) {
  const logs = [];
  const engine = new Engine(svc, { cache: cacheDir, duration, cues: [], sourceHash: 'HASH', project: {}, root: cacheDir,
    onProgress: p => logs.push(p?.message || ''), signal: undefined });
  engine.logs = logs;
  return engine;
}

const overview = [{ id: 'ov', file: path.join(os.tmpdir(), 'ov.mp4'), sourceStart: 0, duration: 10 }];
const buildOpts = {
  schema: V3.schemas.sourceModel, instruction: V3.instructions.sourceModel,
  compactSchema: V3.schemas.compactSourceModel, compactInstruction: V3.instructions.sourceModelCompact,
  chunkInstruction: V3.instructions.sourceModelChunk
};

(async () => {
  console.log('Source Story Model — REAL ask/stage integration');

  await ok('whole MAX_TOKENS -> compact valid: forwards maxOutputTokens, recovers, nothing escapes', async () => {
    // call 1 (whole) => MAX_TOKENS ; call 2 (compact) => valid
    const { svc, calls } = makeService(n => n === 1 ? MAX_TOKENS_RAW() : validModel());
    const engine = makeEngine(svc, tmp());

    const model = await S.build(engine, overview, buildOpts);

    assert.equal(calls.length, 2, 'exactly whole then compact');
    // A) maxOutputTokens actually reached the network boundary on the whole request
    assert.equal(calls[0].maxOutputTokens, S.WHOLE_MAX_OUTPUT_TOKENS, 'whole request carried maxOutputTokens=32768');
    // A2) thinking budget disabled so reasoning tokens can't truncate the JSON
    assert.equal(calls[0].thinkingBudget, S.SOURCE_MODEL_THINKING_BUDGET, 'whole request disabled thinking (thinkingBudget=0)');
    assert.equal(calls[1].thinkingBudget, S.SOURCE_MODEL_THINKING_BUDGET, 'compact request disabled thinking');
    // compact request was made, is different, and smaller
    assert.equal(calls[1].maxOutputTokens, S.COMPACT_MAX_OUTPUT_TOKENS, 'compact request carried maxOutputTokens=16384');
    assert.notStrictEqual(calls[1].responseSchema, calls[0].responseSchema, 'compact used a different (tighter) schema');
    assert.notEqual(calls[1].prompt, calls[0].prompt, 'compact used a different instruction/prompt');
    // service returned a valid story-model; no MAX_TOKENS escaped upward
    assert.ok(model && Array.isArray(model.events) && model.events.length >= 1, 'valid model returned');
    assert.equal(model.modelVersion, S.MODEL_VERSION);
    // recovery log used the real wording
    assert.ok(engine.logs.some(m => /whole extraction hit MAX_TOKENS; switching to compact/.test(m)), 'logged whole->compact switch');
    assert.ok(engine.logs.some(m => /maxOutputTokens=32768 thinkingBudget=0 strategy=whole/.test(m)), 'logged whole vertex options');
  });

  await ok('whole MAX_TOKENS -> compact MAX_TOKENS -> chunks valid -> merged model', async () => {
    // calls: 1 whole(MAX), 2 compact(MAX), 3+ chunks(valid)
    const { svc, calls } = makeService(n => n <= 2 ? MAX_TOKENS_RAW() : validModel([validEvent(`c${n}`, (n - 3) * 100, (n - 3) * 100 + 8)]));
    const engine = makeEngine(svc, tmp(), 1200); // 1200s => 2 chunks
    engine.prepare = async () => [{ id: 'ck', file: path.join(os.tmpdir(), 'ck.mp4'), sourceStart: 0, duration: 10 }];

    const model = await S.build(engine, overview, buildOpts);

    assert.ok(calls.length >= 4, `whole + compact + chunks (got ${calls.length})`);
    assert.equal(calls[0].maxOutputTokens, S.WHOLE_MAX_OUTPUT_TOKENS);
    assert.equal(calls[1].maxOutputTokens, S.COMPACT_MAX_OUTPUT_TOKENS);
    assert.equal(calls[2].maxOutputTokens, S.CHUNK_MAX_OUTPUT_TOKENS, 'chunk request carried maxOutputTokens=8192');
    assert.ok(model && model.events.length >= 1, 'merged chunk model has events');
    assert.ok(engine.logs.some(m => /Compact extraction hit MAX_TOKENS; switching to chunk-first extraction/.test(m)), 'logged compact->chunk switch');
    assert.ok(engine.logs.some(m => new RegExp(`maxOutputTokens=${S.CHUNK_MAX_OUTPUT_TOKENS} thinkingBudget=${S.SOURCE_MODEL_THINKING_BUDGET} strategy=chunk`).test(m)), 'logged chunk vertex options');
  });

  await ok('runtime fingerprint is logged (proves which build executed)', async () => {
    const { svc } = makeService(() => validModel());
    const engine = makeEngine(svc, tmp());
    await S.build(engine, overview, buildOpts);
    assert.ok(engine.logs.some(m => new RegExp(`Runtime build: sourceModelVersion=${S.MODEL_VERSION} recoveryVersion=${S.RECOVERY_VERSION}`).test(m)), 'fingerprint logged');
  });

  await ok('cache-first: loadCached returns a persisted model with ZERO Vertex calls', async () => {
    const dir = tmp();
    await S.persist(dir, S.normalize(validModel(), { duration: 1200, sourceId: 'HASH' }));
    const { svc, calls } = makeService(() => { throw new Error('vertex must NOT be called on a cache hit'); });
    const engine = makeEngine(svc, dir);
    const cached = await S.loadCached(engine);
    assert.ok(cached && cached.events.length >= 1, 'loadCached returned the model');
    assert.equal(calls.length, 0, 'no Vertex call for a cache hit');
  });

  console.log(`\nAll ${passed} source-model integration assertions passed.`);
})().catch(e => { console.error(e); process.exit(1); });
