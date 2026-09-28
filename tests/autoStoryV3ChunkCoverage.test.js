// REAL-PATH tests for Source Story Model chunk RECURSIVE SUBDIVISION + strict
// coverage + the multimodal chunk access gate. Drives:
//   build -> Engine.ask -> AutoStoryFastService.stage -> vertex.generateJsonFromFiles (MOCK)
// so the exact real chunk schema (compactSourceModel) and validator (validateChunk)
// are exercised. Run: node tests/autoStoryV3ChunkCoverage.test.js
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
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-cov-'));

const MAX_TOKENS_RAW = () => new Error('Gemini generation stopped: finishReason MAX_TOKENS (output truncated).');
const validEvent = (id, s, e) => ({ id, startSec: s, endSec: e, type: 'confrontation', summary: `evt ${id}`, location: 'doorway',
  peopleIds: [], tension: 0.6, visualQuality: 0.7, novelty: 0.5, dialogueImpact: 0.3, isReveal: false, audioType: 'participant_speech', audioConfidence: 0.6 });
// A schema-valid compact model for a given window (distinct event times so merge
// does not dedup them away).
const windowModel = (start, accessGranted = true) => ({ accessGranted, people: [],
  events: [validEvent(`e_${Math.round(start)}`, start, start + 3)], quotes: [] });

// Parse the window a chunk request is for out of the prompt (engine.ask embeds
// INPUT json, which for a chunk holds windowStartSec/windowEndSec).
function windowOf(args) {
  const p = String(args.prompt || '');
  const s = /"windowStartSec":\s*([0-9.]+)/.exec(p), e = /"windowEndSec":\s*([0-9.]+)/.exec(p);
  return s && e ? { start: Number(s[1]), end: Number(e[1]) } : null;
}

function makeService(decide) {
  const calls = [];
  const vertex = {
    getModel: () => 'gemini-2.5-flash', lastResponseMetadata: {}, lastResponseText: '', lastUsage: null,
    budgetStatus: async () => null,
    generateJsonFromFiles: async (args) => {
      const win = windowOf(args);
      calls.push({ maxOutputTokens: args.maxOutputTokens, win });
      const step = decide(args, win, calls.length);
      if (step instanceof Error) throw step;
      return step;
    }
  };
  const svc = new AutoStoryFastService({ vertexAutoStoryMaxCalls: 200 }, {}, { vertex, ffmpeg: {}, dubbing: {}, callBudget: { calls: 0 } });
  return { svc, calls };
}
function makeEngine(svc, cacheDir, duration) {
  const logs = [];
  const engine = new Engine(svc, { cache: cacheDir, duration, cues: [], sourceHash: 'HASH', project: {}, root: cacheDir,
    onProgress: p => logs.push(p?.message || ''), signal: undefined });
  engine.prepare = async () => [{ id: 'ev', file: path.join(os.tmpdir(), 'w.mp4'), sourceStart: 0, duration: 10 }];
  engine.logs = logs;
  return engine;
}
const overview = [{ id: 'ov', file: path.join(os.tmpdir(), 'ov.mp4'), sourceStart: 0, duration: 10 }];
const buildOpts = {
  schema: V3.schemas.sourceModel, instruction: V3.instructions.sourceModel,
  compactSchema: V3.schemas.compactSourceModel, compactInstruction: V3.instructions.sourceModelCompact,
  chunkInstruction: V3.instructions.sourceModelChunk
};
// whole+compact always MAX_TOKENS so every test reaches the chunk stage.
const forceChunk = (args) => (args.maxOutputTokens === S.WHOLE_MAX_OUTPUT_TOKENS || args.maxOutputTokens === S.COMPACT_MAX_OUTPUT_TOKENS);

(async () => {
  console.log('Source Story Model — chunk recursion + coverage');

  // TEST A: parent chunk MAX_TOKENS -> recursive split -> children succeed -> ratio 1.0
  await ok('A: recursive subdivision closes coverage to 1.0 and merges a model', async () => {
    const dir = tmp();
    const { svc, calls } = makeService((args, win) => {
      if (forceChunk(args)) return MAX_TOKENS_RAW();
      // chunk-first plans ~200s windows for 1200s; a window wider than 150s overflows,
      // so each initial window splits once into two ~100s leaves that succeed.
      if (win && (win.end - win.start) > 150) return MAX_TOKENS_RAW();
      return windowModel(win ? win.start : 0);
    });
    const engine = makeEngine(svc, dir, 1200); // ~6 initial windows of 200s -> each splits into 100+100
    const model = await S.build(engine, overview, buildOpts);

    assert.ok(model && model.events.length >= 1, 'merged model returned with events');
    const diag = JSON.parse(fs.readFileSync(path.join(dir, 'chunk-coverage.json'), 'utf8'));
    assert.equal(diag.coverageRatio, 1, `coverageRatio == 1.0 (got ${diag.coverageRatio})`);
    assert.equal(diag.failedLeafWindows.length, 0, 'no failed leaves');
    assert.ok(diag.successfulLeafWindows.length >= 4, `subdivided into leaves (${diag.successfulLeafWindows.length})`);
    assert.ok(diag.maxSplitDepth >= 1, 'recorded a split depth');
    assert.equal(Math.round(diag.coverageSeconds), 1200, 'every second covered');
    assert.ok(fs.existsSync(path.join(dir, 'story-model.json')), 'story-model persisted on full coverage');
    assert.ok(engine.logs.some(m => /subdividing into/.test(m)), 'logged a subdivision');
  });

  // TEST B: a minimum-size leaf STILL MAX_TOKENS -> whole build FAILS, no partial persist
  await ok('B: min-size leaf still MAX_TOKENS -> build FAILS, no story-model persisted', async () => {
    const dir = tmp();
    const { svc } = makeService((args) => MAX_TOKENS_RAW()); // everything overflows, forever
    const engine = makeEngine(svc, dir, 1200);
    await assert.rejects(() => S.build(engine, overview, buildOpts),
      e => /MAX_TOKENS at the minimum leaf|Incomplete source coverage/.test(e.message));
    assert.ok(!fs.existsSync(path.join(dir, 'story-model.json')), 'NO partial story-model persisted');
    const diag = JSON.parse(fs.readFileSync(path.join(dir, 'chunk-coverage.json'), 'utf8'));
    assert.ok(diag.failedLeafWindows.length >= 1, 'diagnostics recorded a failed leaf');
    assert.ok(diag.coverageRatio < 1, `coverageRatio < 1 (got ${diag.coverageRatio})`);
    assert.ok(diag.maxSplitDepth >= 1, 'attempted subdivision before giving up');
  });

  // TEST C: successful chunk response WITHOUT accessGranted -> INPUT_ACCESS (gate stays)
  await ok('C: chunk returns accessGranted:false -> INPUT_ACCESS, build fails, no persist', async () => {
    const dir = tmp();
    const { svc } = makeService((args, win) => forceChunk(args) ? MAX_TOKENS_RAW() : windowModel(win ? win.start : 0, false));
    const engine = makeEngine(svc, dir, 300); // single 300s chunk
    await assert.rejects(() => S.build(engine, overview, buildOpts), /truy cập input|INPUT_ACCESS/);
    assert.ok(!fs.existsSync(path.join(dir, 'story-model.json')), 'no partial persist on access failure');
  });

  // TEST D: successful chunk response WITH accessGranted:true -> accepted
  await ok('D: chunk returns accessGranted:true -> accepted, coverage 1.0, persisted', async () => {
    const dir = tmp();
    const { svc } = makeService((args, win) => forceChunk(args) ? MAX_TOKENS_RAW() : windowModel(win ? win.start : 0, true));
    const engine = makeEngine(svc, dir, 300);
    const model = await S.build(engine, overview, buildOpts);
    assert.ok(model && model.events.length >= 1, 'accepted, model returned');
    const diag = JSON.parse(fs.readFileSync(path.join(dir, 'chunk-coverage.json'), 'utf8'));
    assert.equal(diag.coverageRatio, 1, 'full coverage');
    assert.ok(fs.existsSync(path.join(dir, 'story-model.json')), 'persisted');
  });

  // Guard: the real chunk validator keeps the access gate but allows empty events.
  await ok('validateChunk: access gate stays, empty events allowed', () => {
    assert.throws(() => S.validateChunk({ accessGranted: false, events: [] }), /truy cập input/);
    assert.throws(() => S.validateChunk({ accessGranted: true, events: 'x' }), /events array/);
    S.validateChunk({ accessGranted: true, events: [] }); // no throw — empty window is valid
  });

  console.log(`\nAll ${passed} chunk-coverage assertions passed.`);
})().catch(e => { console.error(e); process.exit(1); });
