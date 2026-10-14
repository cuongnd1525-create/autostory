// REAL-PATH tests: long-source CHUNK-FIRST strategy + phase request budget.
// Recursion is an emergency fallback (split only the failed window), NOT gated on a
// full-binary-tree worst case. The source model gets a phase budget carved from the
// run cap; if even small initial windows can't fit, it FAILS EARLY with
// SOURCE_MODEL_RECOVERY_BUDGET and persists nothing. Drives build -> Engine.ask ->
// AutoStoryFastService.stage, mocking only vertex.generateJsonFromFiles.
// Run: node tests/autoStoryV3ChunkBudget.test.js
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
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-bud-'));
const MAX_TOKENS_RAW = () => new Error('Gemini generation stopped: finishReason MAX_TOKENS.');
const validEvent = (id, s) => ({ id, startSec: s, endSec: s + 3, type: 'confrontation', summary: `evt ${id}`, location: 'x',
  peopleIds: [], tension: 0.6, visualQuality: 0.7, novelty: 0.5, dialogueImpact: 0.3, isReveal: false, audioType: 'participant_speech', audioConfidence: 0.6 });
const windowModel = (start) => ({ accessGranted: true, people: [], events: [validEvent(`e_${Math.round(start)}`, start)], quotes: [] });
function windowOf(args) {
  const p = String(args.prompt || '');
  const s = /"windowStartSec":\s*([0-9.]+)/.exec(p), e = /"windowEndSec":\s*([0-9.]+)/.exec(p);
  return s && e ? { start: Number(s[1]), end: Number(e[1]) } : null;
}
function makeService(maxCalls, decide) {
  const calls = [];
  const vertex = {
    getModel: () => 'gemini-2.5-flash', lastResponseMetadata: {}, lastResponseText: '', lastUsage: null,
    budgetStatus: async () => null,
    generateJsonFromFiles: async (args) => { const w = windowOf(args); calls.push({ maxOutputTokens: args.maxOutputTokens, win: w }); const step = decide(args, w, calls.length); if (step instanceof Error) throw step; return step; }
  };
  const callBudget = { calls: 0, runId: 'R' };
  const svc = new AutoStoryFastService({ vertexAutoStoryMaxCalls: maxCalls }, {}, { vertex, ffmpeg: {}, dubbing: {}, callBudget });
  return { svc, callBudget, calls };
}
function makeEngine(svc, dir, duration, outputCount = 1) {
  const logs = [];
  const engine = new Engine(svc, { cache: dir, duration, cues: [], sourceHash: 'HASH', project: {}, root: dir,
    config: { outputCount }, onProgress: p => logs.push(p?.message || ''), signal: undefined });
  engine.prepare = async () => [{ id: 'w', file: path.join(os.tmpdir(), 'w.mp4'), sourceStart: 0, duration: 10 }];
  engine.logs = logs; return engine;
}
const overview = () => [{ id: 'ov', file: path.join(os.tmpdir(), 'ov.mp4'), sourceStart: 0, duration: 10 }];
const buildOpts = {
  schema: V3.schemas.sourceModel, instruction: V3.instructions.sourceModel,
  compactSchema: V3.schemas.compactSourceModel, compactInstruction: V3.instructions.sourceModelCompact,
  chunkSchema: V3.schemas.chunkSourceModel, chunkInstruction: V3.instructions.sourceModelChunk
};

(async () => {
  console.log('Source Story Model — long-source strategy + phase budget');

  // Deterministic planning for the REAL 1726.3s source at the real 16-call cap.
  await ok('plan for the real 1726.3s source: chunk-first, 7-9 windows, bounded', () => {
    const dur = 1726.3;
    const eng = { duration: dur, config: { outputCount: 1 }, service: { settings: { vertexAutoStoryMaxCalls: 16 }, callBudget: { calls: 0 } } };
    assert.deepEqual(S.selectStrategy(dur, null), { mode: 'chunk-first', reason: 'long-source' });
    const budget = S.requestBudgetPlan(eng);
    assert.equal(budget.global, 16); assert.equal(budget.downstreamReserved, 6); assert.equal(budget.sourceModelLimit, 10);
    const wp = S.planChunkWindows(dur, budget.sourceModelLimit);
    assert.equal(wp.feasible, true);
    assert.ok(wp.initialWindows >= 7 && wp.initialWindows <= 9, `7-9 initial windows (got ${wp.initialWindows})`);
    assert.ok(wp.windowSec >= 190 && wp.windowSec <= 250, `~190-250s windows (got ${wp.windowSec})`);
    assert.ok(wp.splitReserve >= 1, 'reserve left for emergency splits');
    // short source stays staged; a prior whole+compact overflow forces chunk-first.
    assert.equal(S.selectStrategy(600, null).mode, 'staged');
    assert.equal(S.selectStrategy(600, { modelVersion: S.MODEL_VERSION, whole: 'MAX_TOKENS', compact: 'MAX_TOKENS' }).reason, 'prior-max-tokens');
  });

  await ok('existing user setting 16 auto-scales a V4 job with 3 outputs and 924.9s source', () => {
    const svc = { settings: { vertexAutoStoryMaxCalls: 16 }, callBudget: { calls: 0 } };
    const eng = { duration: 924.9, config: { outputCount: 3, editorialArchitecture: 'scope_media_director' }, service: svc };
    const budget = S.requestBudgetPlan(eng);
    const plan = S.planChunkWindows(eng.duration, budget.sourceModelLimit);
    assert.equal(budget.downstreamReserved, 82); // V4: 3 narration passes + bounded Director / continuity / retry headroom
    assert.ok(budget.global >= 30, 'source + recovery + downstream all fit');
    assert.equal(budget.global, S.callLimit(svc));
    assert.equal(svc.callBudget.adaptiveLimit, true);
    assert.ok(plan.feasible && plan.splitReserve >= 4, 'the chunk stage can recover oversized outputs');
  });

  await ok('a strict user-requested 16-call cap fails before consuming Vertex credits', async () => {
    const dir = tmp();
    const { svc, callBudget } = makeService(16, () => windowModel(0));
    svc.settings.vertexAutoStoryStrictCallCap = true;
    const engine = makeEngine(svc, dir, 924.9, 3);
    engine.config.editorialArchitecture = 'scope_media_director';
    await assert.rejects(() => S.build(engine, overview, buildOpts), /Cannot cover|SOURCE_MODEL_RECOVERY_BUDGET/);
    assert.equal(callBudget.calls, 0, 'no futile Vertex calls');
  });

  await ok('cached V4 source reserves only downstream AI calls and adapts old 16-call setting', () => {
    const svc = { settings: { vertexAutoStoryMaxCalls: 16 }, callBudget: { calls: 0 } };
    const eng = { duration: 924.9, config: { outputCount: 3, editorialArchitecture: 'scope_media_director' }, service: svc };
    const budget = S.requestBudgetPlan(eng, { sourceCached: true });
    assert.equal(budget.downstreamReserved, 82);
    assert.equal(budget.global, 82);
    assert.equal(budget.sourceModelLimit, 0);
    assert.equal(svc.callBudget.adaptiveLimit, true);
  });

  await ok('cached single-story V4 run reserves repeated block narration and 429 retry attempts', () => {
    const svc = { settings: { vertexAutoStoryMaxCalls: 16 }, callBudget: { calls: 0 } };
    const eng = { duration: 924.9, config: { outputCount: 1, editorialArchitecture: 'scope_media_director' }, service: svc };
    const budget = S.requestBudgetPlan(eng, { sourceCached: true });
    assert.equal(budget.downstreamReserved, 28);
    assert.equal(budget.global, 28, 'legacy 16 is adaptive, not a strict abort after one repair cycle');
    assert.equal(budget.sourceModelLimit, 0);
    assert.equal(svc.callBudget.adaptiveLimit, true);
    assert.equal(S.callLimit(svc), 28);
  });

  await ok('dynamic budget covers a 30-minute V4 source with 2 outputs', () => {
    const svc = { settings: {}, callBudget: { calls: 0 } };
    const eng = { duration: 1800, config: { outputCount: 2, editorialArchitecture: 'scope_media_director' }, service: svc };
    const budget = S.requestBudgetPlan(eng);
    const plan = S.planChunkWindows(eng.duration, budget.sourceModelLimit);
    assert.ok(budget.global > 16);
    assert.ok(plan.feasible, 'source windows must fit before writing');
    assert.ok(budget.sourceModelLimit >= plan.initialWindows);
  });

  // ONE window overflows -> split ONLY that window -> children succeed -> ratio 1.0.
  await ok('one window MAX_TOKENS -> split only that window -> full coverage within phase budget', async () => {
    const dir = tmp();
    // chunk-first (>1500s); only the first window (start 0) overflows at full size.
    const { svc, callBudget } = makeService(16, (args, win) => {
      if (win && win.start < 1 && (win.end - win.start) > 150) return MAX_TOKENS_RAW();
      return windowModel(win ? win.start : 0);
    });
    const engine = makeEngine(svc, dir, 1600);
    const model = await S.build(engine, overview, buildOpts);
    const diag = JSON.parse(fs.readFileSync(path.join(dir, 'chunk-coverage.json'), 'utf8'));
    assert.equal(diag.mode, 'chunk-first');
    assert.equal(diag.coverageRatio, 1, 'full coverage');
    assert.equal(diag.maxSplitDepth, 1, 'exactly one window subdivided, once');
    assert.equal(diag.failedLeafWindows.length, 0, 'no failed leaves');
    assert.ok(callBudget.calls <= diag.sourceModelLimit, `within phase budget (${callBudget.calls} <= ${diag.sourceModelLimit})`);
    assert.ok(model.events.length >= 1 && fs.existsSync(path.join(dir, 'story-model.json')), 'built + persisted');
    // chunk-first SKIPS whole+compact entirely.
    assert.ok(!engine.logs.some(m => /strategy=whole|strategy=compact/.test(m)), 'no whole/compact calls in chunk-first');
  });

  // Too many windows overflow -> phase budget exhausted -> fail loudly, no partial model.
  await ok('too many overflows -> SOURCE_MODEL_RECOVERY_BUDGET, nothing persisted', async () => {
    const dir = tmp();
    const { svc } = makeService(16, () => MAX_TOKENS_RAW()); // every window overflows forever
    const engine = makeEngine(svc, dir, 1726.3);
    await assert.rejects(() => S.build(engine, overview, buildOpts),
      e => e.kind === 'SOURCE_MODEL_RECOVERY_BUDGET' || /phase budget|minimum leaf/.test(e.message));
    assert.ok(!fs.existsSync(path.join(dir, 'story-model.json')), 'no partial story-model persisted');
    const diag = JSON.parse(fs.readFileSync(path.join(dir, 'chunk-coverage.json'), 'utf8'));
    assert.ok(diag.coverageRatio < 1, 'coverage never reached 1.0');
  });

  // Infeasible upfront (initial windows > phase budget) -> fail BEFORE any call.
  await ok('initial windows exceed phase budget -> fail early, zero source-model calls', async () => {
    const dir = tmp();
    // outputCount 3 reserves payoff validation + Director + hook + review; 1726s needs 8 windows.
    const { svc, callBudget } = makeService(16, () => windowModel(0));
    const engine = makeEngine(svc, dir, 1726.3, 3);
    await assert.rejects(() => S.build(engine, overview, buildOpts),
      e => e.kind === 'SOURCE_MODEL_RECOVERY_BUDGET' || /initial windows/.test(e.message));
    assert.equal(callBudget.calls, 0, 'no Vertex calls were made (failed before extracting)');
    assert.ok(!fs.existsSync(path.join(dir, 'story-model.json')), 'nothing persisted');
    const diag = JSON.parse(fs.readFileSync(path.join(dir, 'chunk-coverage.json'), 'utf8'));
    assert.equal(diag.feasible, false);
  });

  // Extraction-strategy diagnostic: a source that proved whole+compact overflow resumes
  // chunk-first on retry (no wasted whole/compact calls).
  await ok('prior whole+compact MAX_TOKENS is remembered -> retry goes chunk-first', async () => {
    const dir = tmp();
    await S.recordStrategyDiag(dir, { whole: 'MAX_TOKENS', compact: 'MAX_TOKENS' });
    const { svc, calls } = makeService(16, (args, win) => windowModel(win ? win.start : 0)); // chunks succeed
    const engine = makeEngine(svc, dir, 800); // < 1500s: would be STAGED, but history forces chunk-first
    const model = await S.build(engine, overview, buildOpts);
    assert.ok(engine.logs.some(m => /strategy selected: mode=chunk-first .* reason=prior-max-tokens/.test(m)), 'resumed chunk-first from history');
    assert.ok(!calls.some(c => c.maxOutputTokens === S.WHOLE_MAX_OUTPUT_TOKENS || c.maxOutputTokens === S.COMPACT_MAX_OUTPUT_TOKENS), 'no whole/compact calls repeated');
    assert.ok(model.events.length >= 1, 'built via chunk-first');
  });

  console.log(`\nAll ${passed} chunk-budget assertions passed.`);
})().catch(e => { console.error(e); process.exit(1); });
