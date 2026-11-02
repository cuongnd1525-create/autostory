const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const Scope = require("../electron/services/recap/recapScopeRecoveryService");
const Index = require("../electron/services/recap/recapSceneIndexService");
const makeWords = n => Array(n).fill("word").join(" ");
const chunks = [{ chunkIndex: 1, sourceStartSec: 0, sourceEndSec: 10 }, { chunkIndex: 2, sourceStartSec: 10, sourceEndSec: 20 }];
const scenes = [{ sceneId: "a", startSec: 0, endSec: 10 }, { sceneId: "b", startSec: 10, endSec: 20 }];
function stateFixture(two = false) {
  const events = [{ id: "chunk_1_scene_event_1", source_start: 3, source_end: 5, anchorMethod: "scene_frames", anchorSceneIds: ["a_p1"], description: "She opens the door." },
    { id: "chunk_1_scene_event_2", source_start: 8, source_end: 10, anchorMethod: "scene_frames", anchorSceneIds: ["a_p2"], description: "He greets her." },
    ...(two ? [{ id: "chunk_2_scene_event_1", source_start: 13, source_end: 15, anchorMethod: "scene_frames", anchorSceneIds: ["b_p1"], description: "They leave." }] : [])];
  const plan = { target_duration_sec: 1000, selected_event_ids: events.map(event => event.id), beats: [{ beat_id: "body", role: "payoff", visual_event_ids: events.map(event => event.id) }] };
  return { scenes, chunkAnalysisKey: JSON.stringify({ chunks: two ? chunks : [chunks[0]] }), visualEvents: events,
    chunkAnalyses: { "0": { events: structuredClone(events) } }, longFormNarration: {}, speechUnits: [{ id: "body", beat_id: "body", text: "She enters.", visual_event_ids: [events[0].id] }],
    recapPlan: plan, audioTracks: { body: { text: "She enters.", audioPath: "old.wav", durationSec: 1 } } };
}
const response = (input, approve = id => id.endsWith("_1")) => ({ observations: input.responseSchema.properties.observations.items.properties.event_id.enum.map(id => ({
  event_id: id, claim_supported: true, context_supported: approve(id), reason: "Observed the same action and its setup."
})) });
async function fixture(two = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-scope-"));
  const source = path.join(root, "source.mp4"); await fs.writeFile(source, "source fixture");
  const state = stateFixture(two); let calls = 0;
  const request = { state, options: { targetDurationSec: 1000 }, prefsKey: "prefs", sourceVideoPath: source,
    directory: root, persist: async () => {}, media: { extractProxyChunk: async () => source },
    ai: { getAnalysisModel: () => "analysis", runVertexCall: async input => { calls++; return response(input); } } };
  return { root, source, state, request, calls: () => calls, clean: () => fs.rm(root, { recursive: true, force: true }) };
}

test("scope planning predicts the collapse from clause shortening before spending time on TTS", () => {
  const request = { speechUnits: [{ id: "body", text: makeWords(900), visual_event_ids: ["e"], clauses: [{ clause_id: "c", text: makeWords(900), visual_event_ids: ["e"] }] }],
    events: [{ id: "e", source_start: 0, source_end: 30, anchorMethod: "scene_frames" }], options: { targetDurationSec: 1000, allowShotReuse: false }, wordsPerSecond: 1 };
  const estimate = new Scope().assess(request);
  assert.equal(estimate.duration.largeDeviation, false); assert.equal(estimate.atRisk, true);
  assert.ok(estimate.fittedDurationSec < 650); assert.ok(estimate.estimatedFittingLossSec > 500);
  const safe = new Scope().assess({ ...request, events: [{ ...request.events[0], source_end: 1200 }] });
  assert.equal(safe.atRisk, false);
});

test("source recovery starts before ideal word ceilings hide a likely scope collapse", () => {
  const estimate = new Scope().assess({ speechUnits: [{ id: "body", text: makeWords(900), visual_event_ids: ["e"] }],
    events: [{ id: "e", source_start: 0, source_end: 650, anchorMethod: "scene_frames" }],
    options: { targetDurationSec: 1000, allowShotReuse: false }, wordsPerSecond: 1 });
  assert.equal(estimate.duration.largeDeviation, false);
  assert.equal(estimate.fittingGate.largeDeviation, false, "the ideal duration is just inside the major deviation bound");
  assert.ok(estimate.projectedRepairDurationSec < 650, "normal complete repairs below the word ceiling would lose too much scope");
  assert.equal(estimate.shortfallRisk, true, "verify omitted supporting context before global compression or TTS");
});

test("a risky local shortening is balanced only against unique supported moving footage, never the hook or shared shots", () => {
  const scope = new Scope(), group = { speechUnitId: "shorten", clauseIds: ["c1"], text: makeWords(150), visual_event_ids: ["a"],
    currentDuration: 50, targetDuration: 5, maxGroundedDuration: 5, targetWordCount: 15, passed: false };
  const spare = Array.from({ length: 10 }, (_, i) => ({ ...group, speechUnitId: `spare_${i}`, clauseIds: [`c${i + 2}`],
    visual_event_ids: [`spare_${i}`], currentDuration: 10, maxGroundedDuration: 30, text: makeWords(30), passed: true }));
  const solution = { clauseBudgets: [group, ...spare, { ...spare[0], speechUnitId: "opening_hook", visual_event_ids: ["hook"] },
    { ...spare[0], speechUnitId: "shared", visual_event_ids: spare[0].visual_event_ids }] };
  const plan = scope.balance(solution, { actual: 690, target: 1000 });
  assert.ok(plan); assert.ok(plan.includes(group));
  assert.ok(plan.filter(g => g.softMinimum).every(g => g.speechUnitId !== "opening_hook" && !["shared", "spare_0"].includes(g.speechUnitId)));
  assert.ok(plan.filter(g => g.softMinimum).every(g => g.targetDuration <= g.currentDuration + 6 && g.targetDuration < g.maxGroundedDuration - 1.5));
  assert.equal(scope.balance({ clauseBudgets: [group] }, { actual: 690, target: 1000 }), null, "insufficient evidence is never made available just to meet the target");
  assert.equal(scope.balance(solution, { actual: 900, target: 1000 }), null, "safe scopes do not acquire extra narration merely to fill time");
});

test("a cached baseline cannot restore claims after the source evidence changes", async () => {
  const f = await fixture();
  try {
    const scope = new Scope();
    f.state.scopeBaseline = { prefsKey: "prefs", evidenceKey: scope.evidenceKey(f.state.visualEvents), plan: f.state.recapPlan,
      speechUnits: [{ ...f.state.speechUnits[0], text: "An earlier claim should not be restored after correction." }] };
    f.state.visualEvents[0].description = "Corrected source observation.";
    await scope.recover(f.request);
    assert.equal(f.state.speechUnits[0].text, "She enters.");
  } finally { await f.clean(); }
});

test("support candidates use only the exact selected contiguous scenes, never unselected adjacent footage or audited ranges", () => {
  const scope = new Scope(), state = stateFixture();
  assert.deepEqual(Index.entriesFor(chunks[0], scenes).map(entry => entry.scene_id), ["a_p1", "a_p2"]);
  const candidate = scope.candidates(state)[0].candidates[0];
  assert.equal(candidate.start, 0); assert.equal(candidate.end, 5);
  assert.deepEqual(candidate.scene_ids, ["a_p1"]); assert.equal(candidate.original.start, 3);
  state.visualEvents[0].anchorAudit = { claimSupported: false };
  assert.ok(scope.candidates(state)[0].candidates.every(candidate => candidate.id !== state.visualEvents[0].id));
  state.visualEvents[1].anchorSceneIds = ["unknown"];
  assert.deepEqual(scope.candidates(state), []);
});

test("only source-approved context expands ranges; good audio stays intact and a completed resume makes no AI call", async () => {
  const f = await fixture();
  try {
    const scope = new Scope(), audio = structuredClone(f.state.audioTracks);
    const result = await scope.recover(f.request);
    assert.equal(result.changed, true); assert.equal(f.calls(), 1);
    assert.equal(f.state.visualEvents[0].source_start, 0);
    assert.equal(f.state.visualEvents[1].source_start, 8, "a rejected prefix is never used to reach a duration quota");
    assert.equal(f.state.visualEvents[0].supportAudit.originalRange.start, 3);
    assert.deepEqual(f.state.audioTracks, audio);
    assert.equal((await scope.recover(f.request)).reused, true); assert.equal(f.calls(), 1);
    assert.equal(f.state.sourceCoverageRecovery.status, "completed");
    await fs.writeFile(f.source, "different source data invalidates observations");
    await scope.recover(f.request); assert.equal(f.calls(), 2, "source identity changes must require fresh source observations");
  } finally { await f.clean(); }
});

test("budget interruption checkpoints completed source chapters and a fresh process requests only unfinished chapters", async () => {
  const f = await fixture(true);
  try {
    let count = 0, persisted;
    f.request.persist = async () => { persisted = JSON.stringify(f.state); };
    f.request.ai.runVertexCall = async input => { if (++count === 2) throw Object.assign(new Error("Budget"), { kind: "budget" }); return response(input); };
    await assert.rejects(new Scope().recover(f.request), { kind: "budget" });
    const resumed = JSON.parse(persisted); assert.ok(resumed.sourceCoverageRecovery.parts[0]);
    assert.equal(resumed.visualEvents[0].source_start, 3, "partial observations are not applied as a complete recovery");
    f.request.state = resumed; let remaining = 0;
    f.request.ai.runVertexCall = async input => { remaining++; assert.match(input.prompt, /chunk_2_scene_event_1/); return response(input); };
    await new Scope().recover(f.request); assert.equal(remaining, 1);
    assert.equal(resumed.sourceCoverageRecovery.status, "completed");
  } finally { await f.clean(); }
});

test("unknown, duplicate, missing or unapproved source observations cannot manufacture usable footage", async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.state.visualEvents);
    f.request.ai.runVertexCall = async input => { const raw = response(input); raw.observations[1].event_id = raw.observations[0].event_id; return raw; };
    await assert.rejects(new Scope().recover(f.request), { kind: "invalid_json" });
    assert.deepEqual(f.state.visualEvents, before);
    f.request.ai.runVertexCall = async input => ({ observations: response(input).observations.slice(0, 1) });
    await assert.rejects(new Scope().recover(f.request), { kind: "invalid_json" });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(new Scope().recover({ ...f.request, signal: controller.signal }), { name: "AbortError" });
    assert.deepEqual(f.state.visualEvents, before);
  } finally { await f.clean(); }
});

test("legacy recovery restores only an unambiguous source-backed chapter cache and never resurrects audited false claims", () => {
  const state = stateFixture();
  const raw = { __aligned: 2, passage_1: { text: "She opens the door and walks inside.", event_ids: [state.visualEvents[0].id], source_note: "The same source action." } };
  state.longFormSections = { first: raw };
  const scope = new Scope(), restored = scope.restoreCachedNarration(state, { targetDurationSec: 1000 });
  assert.ok(restored); assert.equal(restored.speechUnits[0].text, raw.passage_1.text);
  state.longFormSections.second = structuredClone(raw);
  assert.equal(scope.restoreCachedNarration(state, { targetDurationSec: 1000 }), null, "ambiguous old versions must not be guessed");
  delete state.longFormSections.second; state.visualEvents[0].anchorAudit = { claimSupported: false };
  assert.equal(scope.restoreCachedNarration(state, { targetDurationSec: 1000 }), null);
});
