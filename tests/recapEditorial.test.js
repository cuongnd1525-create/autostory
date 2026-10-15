const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Editorial = require("../electron/services/recap/recapEditorialService");
const Caption = require("../electron/services/recap/recapCaptionService");
const Pipeline = require("../electron/services/recap/recapPipelineService");
const Store = require("../electron/services/projectStore");
const Tts = require("../electron/services/recap/recapTtsService");
const events = [0, 8, 16].map((start, i) => ({ id: `e${i}`, source_start: start, source_end: start + 8, duration: 8, description: `Visible event ${i}` }));
const plan = { target_duration_sec: 15, selected_event_ids: ["e0", "e1", "e2"], beats: [
  { beat_id: "opening_hook", role: "hook", visual_event_ids: ["e0"] }, { beat_id: "body", role: "payoff", visual_event_ids: ["e1", "e2"] }
] };
const units = [ { id: "opening_hook", beat_id: "opening_hook", text: "Something happened here. Watch how they respond.", visual_event_ids: ["e0"] },
  { id: "body", beat_id: "body", text: "Their response reveals the cause and solves the problem.", visual_event_ids: ["e1", "e2"] } ];
const angles = [0, 1, 2].map((i) => ({ id: `a${i}`, title: `Angle ${i}`, central_question: "What happened?", payoff: "The response", event_ids: ["e0", "e2"], score: 9 - i }));
const hooks = [0, 1, 2, 3, 4].map((i) => ({ id: `h${i}`, text: `Something happened here. Watch how they respond, version ${i}.`, event_ids: ["e0"], payoff_event_id: "e2", score: 9 - i }));
const good = { overall_score: .85, summary: "Grounded and coherent", issues: [] };
test("long recap narration limits follow output duration and repair uses measured word cadence", async () => {
  const Ai = require("../electron/services/recap/recapAiService");
  const ai = new Ai(), prompts = [];
  ai.runVertexCall = async ({ prompt }) => { prompts.push(prompt); return { speech_units: units }; };
  const longPlan = { ...plan, target_duration_sec: 360 };
  await ai.generateNarration({ recapPlan: longPlan, events, wordsPerSecond: 2.6, editorialOptions: { language: "en" } });
  const budgets = JSON.parse(prompts[0].split("Beats and Grounded Visual Events:\n")[1].split("\nReturn JSON conforming")[0]);
  assert.ok(budgets[1].maxChars >= budgets[1].maxWordCount * 8);
  assert.ok(budgets[1].maxChars > 5000, "short source anchors cannot cap a 360s spoken budget");
  assert.match(prompts[0], /Output target: 360s/);
  await ai.generateNarration({ recapPlan: longPlan, events, wordsPerSecond: 3.8, editorialOptions: { language: "en" } });
  assert.match(prompts[1], /Speaking Rate: ~3.80 words per second/);
  await ai.rewriteRecap({ events, recapPlan: longPlan, speechUnits: units, options: { targetDurationSec: 360 }, feedback: { duration: { actual: 175 } } });
  assert.match(prompts[2], /Measured current script: 16 words produced 175.0 seconds/);
  assert.match(prompts[2], /approximately 32 spoken words TOTAL/);
  await ai.rewriteRecap({ events, recapPlan: longPlan, speechUnits: units, options: { targetDurationSec: 360 }, feedback: { issues: [{ type: "semantic_alignment", description: "Switch at the spoken boundary" }] } });
  assert.doesNotMatch(prompts[3], /NaN|Infinity/);
  assert.match(prompts[3], /Current script: 16 spoken words/);
  assert.match(prompts[3], /within 90–105%/);
});
test("changing narration language chooses an appropriate Edge voice", () => {
  const tts = new Tts({ defaultVoiceGender: "male", defaultVoiceId: "vi-VN-NamMinhNeural" });
  assert.equal(tts.resolveVoiceId("edge_neural", { recapNarrationLanguage: "en" }), "en-US-ChristopherNeural");
  assert.equal(tts.resolveVoiceId("edge_neural", { recapNarrationLanguage: "vi", voiceId: "en-US-JennyNeural" }), "vi-VN-NamMinhNeural");
  assert.equal(tts.resolveVoiceId("edge_neural", { recapNarrationLanguage: "en", voiceId: "en-US-GuyNeural" }), "en-US-GuyNeural");
});
test("small duration deficit expands only a uniquely referenced group with verified unused footage", () => {
  const method = Pipeline.prototype.expansionBudget;
  const candidate = { passed: true, speechUnitId: "body", clauseIds: ["c1"], text: "Only these supported words need expansion.",
    visual_event_ids: ["e1"], currentDuration: 3, maxGroundedDuration: 10 };
  const state = { durationGate: { actual: 200, min: 204 } };
  const result = method.call({}, { clauseBudgets: [candidate] }, state);
  assert.equal(result.targetDuration, 8); assert.ok(result.minimumWordCount > 6);
  assert.equal(method.call({}, { clauseBudgets: [candidate, { ...candidate, clauseIds: ["c2"] }] }, state), null);
  assert.equal(method.call({}, { clauseBudgets: [{ ...candidate, maxGroundedDuration: 4 }] }, state), null);
});
test("a configured Vertex spending limit stops immediately instead of retrying a non-transient budget block", async () => {
  const Ai = require("../electron/services/recap/recapAiService"); let calls = 0;
  const ai = new Ai({}, { providerService: { provider: "vertex_ai", generateJsonFromFiles: async () => {
    calls++; throw Object.assign(new Error("Vertex AI đã đạt giới hạn hôm nay $5.00."), { kind: "budget" });
  } } });
  await assert.rejects(ai.runVertexCall({ prompt: "fixture", modelOverride: "fixture" }), { kind: "budget" });
  assert.equal(calls, 1);
});
test("measured clause repair changes only affected groups and enforces word limits before TTS", async () => {
  const Ai = require("../electron/services/recap/recapAiService"), ai = new Ai(), prompts = [];
  const narration = [{ ...units[1], clauses: [
    { clause_id: "c1", text: "Their response reveals the cause", visual_event_ids: ["e1"] },
    { clause_id: "c2", text: "and solves the problem.", visual_event_ids: ["e2"] }
  ] }];
  ai.runVertexCall = async ({ prompt }) => { prompts.push(prompt); return { repairs: [{ index: 0,
    text: prompts.length === 1 ? "This revised response is still too long." : "Response reveals cause." }] }; };
  const request = { events, recapPlan: plan, speechUnits: narration, options: { language: "en" }, feedback: {
    duration: { passed: true }, clauseBudgets: [{ text: narration[0].clauses[0].text, clauseIds: ["c1"],
      visual_event_ids: ["e1"], targetWordCount: 3 }] } };
  const revised = await ai.rewriteRecap(request);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /previous response exceeded/);
  assert.equal(revised.speech_units[0].text, "Response reveals cause. and solves the problem.");
  assert.deepEqual(revised.speech_units[0].clauses[1], narration[0].clauses[1]);
  assert.deepEqual(revised.speech_units[0].clauses[0].visual_event_ids, ["e1"]);
  assert.equal(narration[0].text, units[1].text, "original checkpoint is untouched until validated repair returns");
  ai.runVertexCall = async () => ({ repairs: [{ index: 0, text: "This always exceeds three words." }] });
  await assert.rejects(ai.rewriteRecap(request), /đúng ngân sách/);
  ai.runVertexCall = async () => ({ repairs: [{ index: 0, text: "Response reveals the cause." }] });
  assert.equal((await ai.rewriteRecap({ ...request, feedback: { ...request.feedback, duration: { passed: false } } })).speech_units[0].clauses[0].text,
    "Response reveals the cause.", "one-token variance is checked against actual TTS timing instead of rejecting a complete repair");
  ai.runVertexCall = async ({ responseSchema }) => {
    assert.equal(responseSchema.properties.repairs.properties.group_0.maxItems, 3);
    return { repairs: { group_0: ["Response", "reveals", "cause."] } };
  };
  assert.equal((await ai.rewriteRecap(request)).speech_units[0].clauses[0].text, "Response reveals cause.");
  ai.runVertexCall = async () => ({ repairs: { group_0: ["Several hidden words", "cause."] } });
  await assert.rejects(ai.rewriteRecap(request), /đúng ngân sách/);
});
const bad = { overall_score: .9, summary: "Needs correction", issues: [{ severity: "high", type: "visual_mismatch", description: "Payoff is missing" }] };
async function fixture(prefs = {}, reviews = [good], durations = [4, 10], extraFactories = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-editorial-"));
  const source = path.join(root, "source.mp4"); await fs.writeFile(source, "fixture");
  const store = new Store(); const project = await store.createProject(root, { sourceVideoPath: source, title: "Editorial test", mode: "recap", targetDurationSec: 15, allowShotReuse: true, ...prefs });
  const calls = { draft: 0, final: 0, review: 0, rewrite: 0, angles: 0, hooks: 0, tts: 0 };
  const service = new Pipeline({ projectStore: store, logger: { log() {} }, serviceFactories: {
    media: () => ({ probeVideo: async () => ({ duration: 24, width: 640, height: 360 }), ensureAnalysisProxy: async () => source,
      detectScenes: async () => [{ startSec: 0, endSec: 24 }], planChunks: () => [{ isSingleChunk: true }] }),
    ai: () => ({ providerService: { label: "Fixture" }, analyzeVideoChunk: async () => ({ events }), buildStoryModel: async () => ({ title: "Test" }),
      proposeAngles: async () => { calls.angles++; return angles; }, proposeHooks: async () => { calls.hooks++; return hooks; },
      planRecap: async () => plan, generateNarration: async () => units,
      rewriteRecap: async () => { calls.rewrite++; return { plan, speech_units: units }; },
      reviewDraft: async () => { const index = calls.review++; const review = reviews[Math.min(index, reviews.length - 1)]; if (review instanceof Error) throw review; return review; } }),
    tts: () => ({ getVoiceProfile: async () => ({ wordsPerSecond: 2.5 }),
      processSpeechUnit: async () => ({ audio_path: source, duration: 4 }),
      synthesizeAll: async ({ speechUnits }) => { calls.tts++; return Object.fromEntries(speechUnits.map((unit, i) => [unit.id, { text: unit.text, audioPath: source, durationSec: durations[i] }])); } }),
    renderer: () => ({ renderDraft: async ({ outputPath }) => { calls.draft++; await fs.mkdir(path.dirname(outputPath), { recursive: true }); await fs.writeFile(outputPath, "draft"); return outputPath; },
      renderFinal: async ({ outputPath }) => { calls.final++; await fs.writeFile(outputPath, "final"); return outputPath; } }),
    ...extraFactories
  } });
  return { root, project, service, calls, store, run: (settings = {}) => service.runRecapProject({ workspaceRoot: root, projectId: project.id, settings }), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
test("hooks and plans reject invented source references and unresolved promises", () => {
  assert.throws(() => Editorial.validateHooks({ hooks: hooks.map((hook) => ({ ...hook, payoff_event_id: "invented" })) }, events));
  assert.throws(() => Editorial.groundPlan({ ...plan, beats: [plan.beats[0]] }, events, hooks[0]), /giải đáp/);
  assert.equal(Editorial.groundPlan(plan, events, hooks[0]).beats.length, 2);
});
test("target budgets are based on output duration instead of all source footage", () => {
  const budgets = Editorial.beatBudgets({ ...plan, target_duration_sec: 75 }, events, 2.5);
  assert.ok(Math.abs(budgets.reduce((sum, beat) => sum + beat.target_duration_budget, 0) - 73.8) < .01);
  assert.equal(budgets[0].target_duration_budget, 4);
  assert.equal(Editorial.durationGate(203.975, 240).passed, true, "one-frame encoding quantization is not a duration failure");
  assert.equal(Editorial.durationGate(203.93, 240).passed, false, "material duration deficits remain blocked");
});
test("missing, malformed and high-severity reviews cannot pass the quality gate", () => {
  for (const review of [null, {}, { ...good, overall_score: null }, { ...good, overall_score: 9 }, { ...good, issues: undefined }, bad, { ...good, overall_score: .69 }]) assert.equal(Editorial.qualityGate(review).passed, false);
  assert.equal(Editorial.qualityGate(good).passed, true);
});
test("captions keep original narration and interpolate only missing word timing", () => {
  const result = Caption.alignWords("Hello, brave world!", [{ word: "hello", start: .5, end: .9 }, { word: "world", start: 1.5, end: 2 }], .25, 2.2);
  assert.deepEqual(result.words.map((w) => w.word), ["Hello,", "brave", "world!"]);
  assert.equal(result.matchedRatio, 2 / 3);
  assert.ok(result.words.every((w) => w.start >= .25 && w.end <= 2.2 && w.end > w.start));
  assert.equal(Caption.phraseEvents(result.words)[0].text, "Hello, brave world!");
});
test("manual selection pauses with three playable auditions then resumes the chosen hook", async () => {
  const f = await fixture({ recapEditorialSelection: "manual" });
  try {
    const result = await f.run(); assert.equal(result.status, "editorial_ready"); assert.equal(result.editorial.hooks.length, 3);
    assert.equal(f.calls.final, 0); assert.equal(f.calls.tts, 0);
    await f.service.chooseEditorial(f.root, f.project.id, { angleId: "a0", hookId: "h1", approve: true });
    const final = await f.run(); assert.equal(final.status, "completed");
    assert.equal(final.decisions[0].text, hooks[1].text); assert.equal(f.calls.angles, 1); assert.equal(f.calls.hooks, 1);
    assert.equal(f.calls.final, 1);
  } finally { await f.cleanup(); }
});
test("a failed review gets one repair and blocks even after final approval", async () => {
  const f = await fixture({}, [bad]);
  try {
    await f.service.updateReviewDecisions(f.root, f.project.id, { userApprovedFinal: true });
    const result = await f.run(); assert.equal(result.status, "quality_blocked");
    assert.equal(f.calls.review, 2); assert.equal(f.calls.rewrite, 1); assert.equal(f.calls.final, 0);
    assert.equal((await f.store.getProject(f.root, f.project.id)).status, "quality_blocked");
  } finally { await f.cleanup(); }
});
test("successful quality repair rerenders and reviews the changed draft before final", async () => {
  const f = await fixture({ viralOptimization: false }, [bad, good]);
  try { assert.equal((await f.run()).status, "completed"); assert.equal(f.calls.review, 2); assert.equal(f.calls.draft, 2); assert.equal(f.calls.final, 1); }
  finally { await f.cleanup(); }
});
test("guided draft requests pause even when a previous final approval is saved", async () => {
  const f = await fixture({ viralOptimization: false, recapWorkflow: "review" });
  try {
    assert.equal((await f.run()).status, "review_ready");
    await f.service.updateReviewDecisions(f.root, f.project.id, { userApprovedFinal: true });
    assert.equal((await f.run({ recapDraftOnly: true })).status, "review_ready");
    assert.equal(f.calls.final, 0);
    assert.equal((await f.run()).status, "completed");
    assert.equal(f.calls.final, 1);
  } finally { await f.cleanup(); }
});
test("unavailable review blocks final and duration repairs stop after two attempts", async () => {
  const f = await fixture({ viralOptimization: false }, [new Error("Provider offline")]);
  const short = await fixture({ viralOptimization: false }, [good], [1, 1]);
  try {
    assert.equal((await f.run()).status, "quality_blocked"); assert.equal(f.calls.final, 0);
    assert.equal((await short.run()).status, "quality_blocked"); assert.equal(short.calls.rewrite, 2);
    assert.equal(short.calls.review, 0); assert.equal(short.calls.final, 0);
  } finally { await f.cleanup(); await short.cleanup(); }
});
test("high semantic review audits the implicated source anchors before a fresh render and review", async () => {
  let audits = 0;
  const mismatch = { ...bad, issues: [{ severity: "high", type: "semantic_alignment", output_start: 1, output_end: 3, description: "Wrong source action" }] };
  const f = await fixture({ viralOptimization: false }, [mismatch, good], [4, 10], { anchorAudit: () => ({ repair: async request => {
    audits++; assert.deepEqual(request.eventIds, ["e0"]);
    return request.events.map(event => event.id === "e0" ? { ...event, source_start: .25, anchorAudit: { confidence: .95 } } : event);
  } }) });
  try {
    const result = await f.run(); assert.equal(result.status, "completed");
    assert.equal(audits, 1); assert.equal(f.calls.draft, 2); assert.equal(f.calls.review, 2);
    const state = JSON.parse(await fs.readFile(path.join(f.root, f.project.id, "analysis", "recap_state.json"), "utf8"));
    assert.equal(state.visualEvents[0].source_start, .25);
    assert.equal(state.chunkAnalyses["0"].events[0].source_start, .25);
  } finally { await f.cleanup(); }
});
