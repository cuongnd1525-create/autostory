// REAL-PATH Story Design tests: valid design, empty->repair recovery, both-empty ->
// STORY_DESIGN_INVALID, and the regression where valid-but-weak spines must NOT be
// lost. Drives buildStoryDesign -> engine.ask -> AutoStoryFastService.stage, mocking
// only vertex.generateJsonFromFiles. validateStoryDesign is NOT mocked.
// Run: node tests/autoStoryV3StoryDesign.test.js
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require(path.join(__dirname, '..', 'electron', 'services', 'autoStoryV3Pipeline.js'));
const { Engine } = require(path.join(__dirname, '..', 'electron', 'services', 'autoStorySourceEngine.js'));
const AutoStoryFastService = require(path.join(__dirname, '..', 'electron', 'services', 'autoStoryFastService.js'));

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log('  ok -', name); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-sd-'));

const model = { events: [{ id: 'e1', startSec: 0, endSec: 5 }, { id: 'e2', startSec: 10, endSec: 16 }, { id: 'e3', startSec: 40, endSec: 47 }], quotes: [] };
const beat = (id, role, evId) => ({ beatId: id, narrativeRole: role, viewerQuestion: 'q', sourceEventId: evId,
  requiredPeopleIds: [], tensionBefore: 0.2, tensionAfter: 0.6, wantsNarration: false, narratorFunction: 'NONE',
  informationClass: 'immediate', newInformation: [], newInformationRefs: [], opensLoopId: '', closesLoopId: '', durationTargetSec: 6 });
const spine = (strongEnough, beats) => ({ centralViewerQuestion: 'Why did she call?', hookPromise: 'A routine call turns',
  hookStrategy: 'curiosity_gap', strongEnough, reason: 'ok', informationBudget: { immediate: [], deferred: [], reveals: [], omit: [] },
  openLoops: [], beats });
const design = (spines) => ({ accessGranted: true, spines });
const goodDesign = () => design([spine(true, [beat('b1', 'hook', 'e1'), beat('b2', 'escalation', 'e2'), beat('b3', 'reveal', 'e3')])]);

function makeService(script) {
  const calls = [];
  const vertex = {
    getModel: () => 'gemini-2.5-flash', lastResponseText: '', lastUsage: null,
    lastResponseMetadata: {}, budgetStatus: async () => null,
    generateJsonFromFiles: async (args) => {
      calls.push({ prompt: args.prompt, thinkingBudget: args.thinkingBudget, maxOutputTokens: args.maxOutputTokens });
      vertex.lastResponseMetadata = { finishReason: 'STOP', requestedMaxOutputTokens: args.maxOutputTokens ?? null,
        requestedThinkingBudget: args.thinkingBudget ?? null,
        usage: { promptTokenCount: 4000, candidatesTokenCount: 900, thoughtsTokenCount: 320, totalTokenCount: 5220 } };
      const step = script(calls.length);
      if (step instanceof Error) throw step;
      return step;
    }
  };
  const svc = new AutoStoryFastService({ vertexAutoStoryMaxCalls: 50 }, {}, { vertex, ffmpeg: {}, dubbing: {}, callBudget: { calls: 0 } });
  return { svc, calls, vertex };
}
function makeEngine(svc, dir) {
  const logs = [];
  const engine = new Engine(svc, { cache: dir, duration: 1726, cues: [], sourceHash: 'HASH', project: {}, root: dir,
    config: { outputCount: 1 }, onProgress: p => logs.push(p?.message || ''), signal: undefined });
  engine.logs = logs; return engine;
}

(async () => {
  console.log('V3 Story Design — real ask/stage path');

  // A: valid design accepted, artifacts + telemetry persisted, no repair.
  await ok('A: valid Story Design with spines -> accepted, raw+metadata persisted', async () => {
    const dir = tmp();
    const { svc, calls } = makeService(() => goodDesign());
    const engine = makeEngine(svc, dir);
    const out = await P.buildStoryDesign(engine, model, dir, () => {});
    assert.equal(out.length, 1, 'one usable spine');
    assert.equal(calls.length, 1, 'exactly one design call (no repair)');
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'v3-story-design-raw.json'), 'utf8'));
    assert.ok(Array.isArray(raw.spines) && raw.spines.length === 1, 'raw persisted with spines');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'v3-story-design-request-metadata.json'), 'utf8'));
    assert.equal(meta.finishReason, 'STOP');
    assert.equal(meta.totalTokenCount, 5220, 'token telemetry captured');
    const norm = JSON.parse(fs.readFileSync(path.join(dir, 'v3-story-design-normalized.json'), 'utf8'));
    assert.equal(norm.usableSpineCount, 1);
  });

  // B: first response empty -> ONE text-only repair -> valid -> proceeds.
  await ok('B: empty spines -> text-only repair -> recovered', async () => {
    const dir = tmp();
    const { svc, calls } = makeService(n => n === 1 ? design([]) : goodDesign());
    const engine = makeEngine(svc, dir);
    const out = await P.buildStoryDesign(engine, model, dir, () => {});
    assert.equal(out.length, 1, 'recovered one spine');
    assert.equal(calls.length, 2, 'first + one repair call');
    // repair was text-only (no maxOutputTokens/video), same as first — and NOT thinkingBudget=0
    assert.ok(calls[1].thinkingBudget === undefined || calls[1].thinkingBudget === null, 'Story Design repair did not force thinkingBudget=0');
    assert.ok(fs.existsSync(path.join(dir, 'v3-story-design-repair-raw.json')), 'repair raw persisted');
    const norm = JSON.parse(fs.readFileSync(path.join(dir, 'v3-story-design-repair-normalized.json'), 'utf8'));
    assert.equal(norm.repaired, true);
  });

  // C: both empty -> STORY_DESIGN_INVALID, diagnostics persisted, no fabrication.
  await ok('C: empty twice -> STORY_DESIGN_INVALID with diagnostics', async () => {
    const dir = tmp();
    const { svc, calls } = makeService(() => design([]));
    const engine = makeEngine(svc, dir);
    await assert.rejects(() => P.buildStoryDesign(engine, model, dir, () => {}),
      e => e.kind === 'STORY_DESIGN_INVALID' && /no usable spine after one repair/.test(e.message));
    assert.equal(calls.length, 2, 'first + one repair, then give up');
    assert.ok(fs.existsSync(path.join(dir, 'v3-story-design-raw.json')) && fs.existsSync(path.join(dir, 'v3-story-design-repair-raw.json')), 'both raw responses persisted');
  });

  // D: valid spines that are all strongEnough:false but HAVE beats must NOT be lost.
  await ok('D: valid-but-weak spines are used (not silently dropped)', async () => {
    const dir = tmp();
    const { svc, calls } = makeService(() => design([spine(false, [beat('b1', 'hook', 'e1'), beat('b2', 'reveal', 'e3')])]));
    const engine = makeEngine(svc, dir);
    const out = await P.buildStoryDesign(engine, model, dir, () => {});
    assert.equal(out.length, 1, 'weak-but-complete spine kept as best effort');
    assert.equal(calls.length, 1, 'no repair needed — a complete spine existed');
  });

  // Guard: chooseSpines prefers strong, falls back to complete, ignores beat-less.
  await ok('chooseSpines: prefers strong, falls back to complete, drops beat-less', () => {
    assert.equal(P.chooseSpines(design([spine(true, [beat('b', 'hook', 'e1')]), spine(false, [beat('b', 'hook', 'e1')])])).length, 1, 'only the strong one when a strong exists');
    assert.equal(P.chooseSpines(design([spine(false, [beat('b', 'hook', 'e1')])])).length, 1, 'weak-but-complete kept');
    assert.equal(P.chooseSpines(design([spine(true, [])])).length, 0, 'beat-less dropped');
  });

  console.log(`\nAll ${passed} story-design assertions passed.`);
})().catch(e => { console.error(e); process.exit(1); });
