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
const good = { overall_score: .85, summary: "Grounded and coherent", issues: [],
  duration_assessment: { verdict: "appropriate", reason: "The causal story is complete and the pacing has no padding." } };
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
  await assert.rejects(ai.rewriteRecap({ ...request, feedback: { ...request.feedback, duration: { passed: false } } }), /đúng ngân sách/);
  ai.runVertexCall = async ({ responseSchema }) => {
    assert.equal(responseSchema.properties.repairs.properties.group_0.maxItems, undefined,
      "semantic word-count feedback must run before retrying a rejected array length");
    return { repairs: { group_0: ["Response", "reveals", "cause."] } };
  };
  assert.equal((await ai.rewriteRecap(request)).speech_units[0].clauses[0].text, "Response reveals cause.");
  ai.runVertexCall = async () => ({ repairs: { group_0: ["Several hidden words", "cause."] } });
  await assert.rejects(ai.rewriteRecap(request), /đúng ngân sách/);
});
test("all overflowing groups are repaired in batches without silently adding unrelated nearby events", async () => {
  const Ai = require("../electron/services/recap/recapAiService"), ai = new Ai(); let calls = 0;
  const speechUnits = Array.from({ length: 13 }, (_, index) => ({ id: `unit_${index}`, beat_id: "body", text: "An unnecessarily long original action sentence.",
    visual_event_ids: ["e1"], clauses: [{ clause_id: `c_${index}`, text: "An unnecessarily long original action sentence.", visual_event_ids: ["e1"] }] }));
  const budgets = speechUnits.map(unit => ({ speechUnitId: unit.id, clauseIds: [unit.clauses[0].clause_id],
    text: unit.text, visual_event_ids: ["e1"], targetWordCount: 3, holdSec: 8 }));
  ai.runVertexCall = async request => { calls++; return { repairs: Object.fromEntries(
    Object.keys(request.responseSchema.properties.repairs.properties).map(key => [key, ["They", "respond."]])) }; };
  const result = await ai.repairMeasuredClauses({ events, recapPlan: plan, speechUnits, options: {}, feedback: { clauseBudgets: budgets } });
  assert.equal(calls, 2);
  assert.ok(result.speech_units.every(unit => unit.text === "They respond."));
  assert.ok(result.speech_units.every(unit => unit.clauses[0].visual_event_ids.join() === "e1"));
});

test("a real provider accepts an over-budget repair for targeted feedback, retains good groups and enforces the final word limit", async () => {
  const Ai = require("../electron/services/recap/recapAiService"), calls = [];
  const ai = new Ai({ aiProvider: "vertex_ai" }, { vertex: { generateJsonFromFiles: async input => {
    calls.push(input);
    if (calls.length === 1) return { repairs: { group_0: ["This", "sentence", "is", "too", "long."],
      group_1: ["She", "saves", "him."] } };
    assert.deepEqual(input.responseSchema.properties.repairs.required, ["group_0"]);
    assert.match(input.prompt, /5 words; limit 3/);
    return { repairs: { group_0: ["He", "turns", "back."] } };
  } } });
  const speechUnits = [0, 1].map(i => ({ id: `u${i}`, beat_id: "body", text: "Original narration.",
    visual_event_ids: [`e${i}`], clauses: [{ clause_id: `c${i}`, text: "Original narration.", visual_event_ids: [`e${i}`] }] }));
  const result = await ai.repairMeasuredClauses({ events, recapPlan: plan, speechUnits, options: { language: "en" },
    feedback: { clauseBudgets: speechUnits.map((unit, i) => ({ speechUnitId: unit.id, clauseIds: [`c${i}`],
      text: unit.text, visual_event_ids: unit.visual_event_ids, targetWordCount: 3 })) } });
  assert.equal(calls.length, 2); assert.equal(calls[0].modelOverride, calls[1].modelOverride,
    "a word-count correction does not waste fallback calls with the same rejected prompt");
  assert.equal(result.speech_units[0].text, "He turns back."); assert.equal(result.speech_units[1].text, "She saves him.");
  ai.providerService.dependencies.vertex.generateJsonFromFiles = async () => ({ repairs: {
    group_0: ["He", ",", "turns", "back", "."], group_1: ["She saves", "him", "."]
  } });
  const punctuated = await ai.repairMeasuredClauses({ events, recapPlan: plan, speechUnits, options: {},
    feedback: { clauseBudgets: speechUnits.map((unit, i) => ({ speechUnitId: unit.id, clauseIds: [`c${i}`],
      text: unit.text, visual_event_ids: unit.visual_event_ids, targetWordCount: 3 })) } });
  assert.equal(punctuated.speech_units[0].text, "He, turns back.");
  assert.equal(punctuated.speech_units[1].text, "She saves him.", "count spoken words rather than array slots or punctuation tokens");
});
test("an exhausted visual reference triggers structural repair instead of repeatedly truncating a sentence", async () => {
  const Ai = require("../electron/services/recap/recapAiService"), ai = new Ai();
  ai.runVertexCall = async request => { assert.match(request.prompt, /STRUCTURAL GROUNDING REPAIR/); return { plan, speech_units: units }; };
  const result = await ai.rewriteRecap({ events, recapPlan: plan, speechUnits: units, options: {}, feedback: { qualityFirst: true,
    forceStructuralRepair: true, clauseBudgets: [{ targetWordCount: 3, missingEventIds: ["e1"] }] } });
  assert.deepEqual(result.speech_units, units);
});
test("timing repair restructures exhausted references and substantial story loss on the first attempt", () => {
  const needsRepair = Pipeline.prototype.needsStructuralRepair;
  assert.equal(needsRepair([{ text: "The toad attacks the giant snake.", targetWordCount: 2 }], units), true);
  assert.equal(needsRepair([{ text: units[1].text, targetWordCount: 5 }], units), true);
  assert.equal(needsRepair([{ text: units[1].text, targetWordCount: 8 }], units), false);
  assert.equal(needsRepair([{ text: units[1].text, targetWordCount: 8, missingEventIds: ["e1"] }], units), true);
});
test("one final timing settlement is limited to small measured TTS drift without missing evidence", () => {
  const canSettle = Pipeline.prototype.canSettleTiming;
  const budgets = [ { currentDuration: 2.92, targetDuration: 2.913, missingEventIds: [] },
    { currentDuration: 2.517, targetDuration: 2.273, missingEventIds: [] }, { currentDuration: 3.2, targetDuration: 3.13, missingEventIds: [] } ];
  assert.equal(canSettle(budgets), true);
  assert.equal(canSettle([{ ...budgets[0], missingEventIds: ["e1"] }]), false);
  assert.equal(canSettle([{ ...budgets[0], currentDuration: 4 }]), false);
  assert.equal(canSettle(Array.from({ length: 4 }, () => ({ currentDuration: 2.4, targetDuration: 2 }))), false);
  assert.equal(canSettle([]), false);
});
test("quality repair patches affected units without repeating the full plan or changing the approved hook", async () => {
  const Ai = require("../electron/services/recap/recapAiService"), ai = new Ai();
  ai.runVertexCall = async request => {
    assert.match(request.prompt, /NOT a complete plan/);
    assert.equal(request.responseSchema.properties.plan, undefined);
    return { edits: [{ id: "body", clauses: [{ text: "Their response explains the cause.", visual_event_ids: ["e1"] }] }], additions: [] };
  };
  const result = await ai.rewriteRecap({ events, recapPlan: plan, speechUnits: units, options: {}, feedback: { patchOnly: true } });
  assert.deepEqual(result.speech_units[0], units[0]);
  assert.equal(result.speech_units[1].text, "Their response explains the cause.");
  assert.equal(units[1].text, "Their response reveals the cause and solves the problem.");
  ai.runVertexCall = async () => ({ edits: [{ id: "opening_hook", clauses: [] }], additions: [] });
  await assert.rejects(ai.rewriteRecap({ events, recapPlan: plan, speechUnits: units, options: {}, feedback: { patchOnly: true } }), /hook/);
});
test("multiple supported additions preserve the returned causal order after the same original unit", async () => {
  const Ai = require("../electron/services/recap/recapAiService"), ai = new Ai();
  ai.runVertexCall = async () => ({ edits: [], additions: [
    { id: "cause", after_id: "body", beat_id: "body", clauses: [{ text: "They discover the cause.", visual_event_ids: ["e1"] }] },
    { id: "consequence", after_id: "body", beat_id: "body", clauses: [{ text: "That discovery changes their response.", visual_event_ids: ["e2"] }] }
  ] });
  const result = await ai.repairQualityUnits({ events, recapPlan: plan, speechUnits: units, options: {}, feedback: {} });
  assert.deepEqual(result.speech_units.map(unit => unit.id), ["opening_hook", "body", "cause", "consequence"]);
  assert.deepEqual(result.speech_units.slice(0, 2), units);
});

test("a timed blocking quality defect limits the patch to affected units and their causal neighbors", () => {
  const pipeline = new Pipeline({}), body = Array.from({ length: 6 }, (_, i) => ({ id: `u${i}` }));
  const decisions = body.map((unit, i) => ({ speech_unit_id: unit.id, clips: [{ output_start: i * 10, output_end: (i + 1) * 10 }] }));
  const issue = { severity: "high", type: "semantic_alignment", output_start: 22, output_end: 28 };
  assert.deepEqual(pipeline.qualityRepairFocus({ issues: [issue, { severity: "low", type: "pacing" }] }, decisions, body),
    { issues: [issue], focusUnitIds: ["u1", "u2", "u3"] });
  const global = { severity: "high", type: "missing_payoff" };
  assert.equal(pipeline.qualityRepairFocus({ issues: [issue, global] }, decisions, body).focusUnitIds, undefined);
  const localText = { severity: "medium", type: "narration_facts", speech_unit_ids: ["u2"] };
  assert.deepEqual(pipeline.qualityRepairFocus({ issues: [localText] }, decisions, body).focusUnitIds, ["u1", "u2", "u3"],
    "text-only review can identify a local repair without inventing audiovisual timestamps");
});

test("an editorial-only blocker repairs narrative scope without sweeping nonblocking visual observations", () => {
  const pipeline = new Pipeline({});
  const visual = { severity: "medium", type: "semantic_alignment", output_start: 1, output_end: 2 };
  const fact = { severity: "low", type: "narration_facts", speech_unit_ids: ["u1"] };
  const missing = { severity: "high", type: "editorial_duration", description: "The discovery explaining the decision is missing." };
  const focus = pipeline.qualityRepairFocus({ issues: [visual, fact] }, [], [{ id: "u1" }], { blockers: [missing] });
  assert.deepEqual(focus.issues, [fact, missing]);
  assert.equal(focus.focusUnitIds, undefined, "a genuinely missing passage can be inserted wherever its causal position belongs");
  const critical = { ...visual, severity: "critical" };
  assert.deepEqual(pipeline.qualityRepairFocus({ issues: [critical, fact] }, [], [], { blockers: [critical, missing] }).issues, [critical],
    "blocking visual defects still require source verification");
});

test("scoped quality patches preserve unrelated narration and reject edits, removals or additions outside the scope", async () => {
  const Ai = require("../electron/services/recap/recapAiService"), ai = new Ai();
  const other = { ...units[1], id: "unaffected", text: "This passage has already passed." };
  const request = { events, recapPlan: plan, speechUnits: [...units, other], options: {}, feedback: { focusUnitIds: ["body"] } };
  let response = { edits: [{ id: "body", clauses: [{ text: "She reveals the cause.", visual_event_ids: ["e1"] }] }], additions: [] };
  ai.runVertexCall = async input => {
    assert.deepEqual(input.responseSchema.properties.edits.items.properties.id.enum, ["body"]);
    assert.match(input.prompt, /read-only context/); return response;
  };
  const result = await ai.repairQualityUnits(request);
  assert.deepEqual(result.speech_units.at(-1), other); assert.deepEqual(result.speech_units[0], units[0]);
  response = { edits: [{ ...response.edits[0], id: "unaffected" }], additions: [] };
  await assert.rejects(ai.repairQualityUnits(request));
  response = { edits: [], additions: [], removals: ["unaffected"] };
  await assert.rejects(ai.repairQualityUnits(request));
  response = { edits: [], additions: [{ id: "new", after_id: "unaffected", beat_id: "body", clauses: [] }] };
  await assert.rejects(ai.repairQualityUnits(request), /ngoài phạm vi/);
});

test("quality repair ignores disproved writing notes from older audited checkpoints", async () => {
  const Ai = require("../electron/services/recap/recapAiService"), ai = new Ai();
  ai.runVertexCall = async request => {
    assert.doesNotMatch(request.prompt, /STALE_UNSUPPORTED_CLAIM/);
    assert.match(request.prompt, /A shield blocks the attack/);
    return { edits: [], additions: [] };
  };
  await ai.repairQualityUnits({ events: events.map(event => ({ ...event, description: "A shield blocks the attack.",
    anchorAudit: { claimSupported: false }, narrativeContext: [{ note: "STALE_UNSUPPORTED_CLAIM" }] })),
    recapPlan: plan, speechUnits: units, options: {}, feedback: {} });
});
test("structural repair can remove an exhausted duplicate reaction while retaining hook and payoff", async () => {
  const Ai = require("../electron/services/recap/recapAiService"), ai = new Ai();
  const duplicate = { id: "reaction", beat_id: "body", text: "He watches again.", visual_event_ids: ["e1"] };
  const request = { events, recapPlan: plan, speechUnits: [...units, duplicate], options: { hook: { payoff_event_id: "e2" } }, feedback: {} };
  ai.runVertexCall = async () => ({ edits: [], additions: [], removals: ["reaction"] });
  const result = await ai.repairQualityUnits(request);
  assert.deepEqual(result.speech_units, units);
  ai.runVertexCall = async () => ({ edits: [], additions: [], removals: ["opening_hook"] });
  await assert.rejects(ai.repairQualityUnits(request), /hook/);
  ai.runVertexCall = async () => ({ edits: [], additions: [], removals: ["body", "reaction"] });
  await assert.rejects(ai.repairQualityUnits(request), /nội dung chính/);
});

test("a removal supersedes an edit of the same redundant unit and duplicate removals are idempotent", async () => {
  const Ai = require("../electron/services/recap/recapAiService"), ai = new Ai();
  const original = [...units, { ...units[1], id: "redundant", text: "They win again." }];
  const request = { events, recapPlan: plan, speechUnits: original, options: { hook: { payoff_event_id: "e2" } }, feedback: {} };
  ai.runVertexCall = async () => ({ edits: [{ id: "redundant", clauses: [{ text: "They win.", visual_event_ids: ["e2"] }] }],
    removals: ["redundant", "redundant"], additions: [] });
  const result = await ai.repairQualityUnits(request);
  assert.deepEqual(result.speech_units, units); assert.equal(original.length, 3);
  ai.runVertexCall = async () => ({ edits: [], removals: ["unknown"], additions: [] });
  await assert.rejects(ai.repairQualityUnits(request), /không tồn tại: unknown/);
});

test("replacing a removed unit with its old model ID allocates a unique ID and identical additions are merged", async () => {
  const Ai = require("../electron/services/recap/recapAiService"), ai = new Ai();
  const old = { ...units[1], id: "new_unit_1", text: "Old inaccurate claim." };
  const addition = { id: "new_unit_1", after_id: "body", beat_id: "body",
    clauses: [{ text: "Their decision changes the outcome.", visual_event_ids: ["e2"] }] };
  ai.runVertexCall = async () => ({ edits: [], removals: [old.id], additions: [addition, structuredClone(addition)] });
  const result = await ai.repairQualityUnits({ events, recapPlan: plan, speechUnits: [...units, old], options: { hook: { payoff_event_id: "e2" } }, feedback: {} });
  assert.equal(result.speech_units.length, 3); assert.equal(result.speech_units.at(-1).id, "quality_addition_1");
  assert.equal(result.speech_units.at(-1).clauses[0].clause_id, "quality_addition_1_repair_1");
  assert.equal(result.speech_units.at(-1).text, addition.clauses[0].text);
  assert.deepEqual(result.speech_units.slice(0, 2), units);
});

test("plan scope counts unique supporting intervals and never treats teaser references as long narration", () => {
  const footage = [{ id: "a", source_start: 0, source_end: 200 }, { id: "b", source_start: 100, source_end: 300 },
    { id: "c", source_start: 400, source_end: 1000 }];
  const scopedPlan = { target_duration_sec: 1000, beats: [{ beat_id: "opening_hook", role: "hook", visual_event_ids: ["c"] },
    { beat_id: "body", role: "setup", visual_event_ids: ["a", "b", "a"] }] };
  const scope = Editorial.planScope(scopedPlan, footage);
  assert.equal(scope.availableSec, 900); assert.equal(scope.selectedSec, 304); assert.equal(scope.needsExpansion, true);
  assert.equal(scope.selectedEventCount, 2);
  scopedPlan.beats[1].visual_event_ids.push("c");
  assert.equal(Editorial.planScope(scopedPlan, footage).selectedSec, 900);
  assert.equal(Editorial.planScope(scopedPlan, footage).needsExpansion, false);
});


test("structural additions retain their original positions when adjacent anchors are removed", async () => {
  const Ai = require("../electron/services/recap/recapAiService"), ai = new Ai();
  const original = [units[0], { ...units[1], id: "redundant_a" }, { ...units[1], id: "redundant_b" }, units[1]];
  const addition = (id, after_id) => ({ id, after_id, beat_id: "body",
    clauses: [{ text: `They discover the ${id} cause.`, visual_event_ids: ["e1"] }] });
  const request = { events, recapPlan: plan, speechUnits: original, options: { hook: { payoff_event_id: "e2" } }, feedback: {} };
  // Out-of-order patches must still follow the original timeline, including deleted anchors.
  ai.runVertexCall = async () => ({ edits: [], removals: ["redundant_a", "redundant_b"], additions: [
    addition("b_first", "redundant_b"), addition("a_first", "redundant_a"), addition("a_second", "redundant_a")
  ] });
  const result = await ai.repairQualityUnits(request);
  assert.deepEqual(result.speech_units.map(unit => unit.id), ["opening_hook", "a_first", "a_second", "b_first", "body"]);
  assert.deepEqual(result.speech_units[0], original[0]); assert.deepEqual(result.speech_units.at(-1), original.at(-1));
  assert.equal(original.length, 4, "patches must not mutate the saved input");
  ai.runVertexCall = async () => ({ edits: [], removals: ["redundant_a"], additions: [addition("body", "redundant_a")] });
  const renamed = await ai.repairQualityUnits(request);
  assert.equal(new Set(renamed.speech_units.map(unit => unit.id)).size, renamed.speech_units.length);
  assert.equal(renamed.speech_units.filter(unit => unit.id === "body").length, 1);
  for (const [patch, message] of [[addition("new", "unknown_anchor"), /vị trí không tồn tại/],
    [{ ...addition("new", "body"), beat_id: "invented" }, /nhịp kể không hợp lệ/]]) {
    ai.runVertexCall = async () => ({ edits: [], removals: ["redundant_a"], additions: [patch] });
    await assert.rejects(ai.repairQualityUnits(request), message);
  }
});
const bad = { ...good, overall_score: .9, summary: "Needs correction", issues: [{ severity: "high", type: "visual_mismatch", description: "Payoff is missing" }] };
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
      reviewDraft: async request => { calls.lastReviewContext = request.editorialContext; const index = calls.review++; const review = reviews[Math.min(index, reviews.length - 1)]; if (review instanceof Error) throw review; return review; },
      ...(extraFactories.narrativeAi || {}) }),
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
  assert.equal(Editorial.optionsFor({ targetDurationSec: 900 }).targetDurationSec, 900, "no fixed 600s cap when source length is unknown");
  assert.equal(Editorial.optionsFor({ targetDurationSec: 900, sourceDurationSec: 1119.008 }).targetDurationSec, 900);
  assert.equal(Editorial.optionsFor({ targetDurationSec: 1500, sourceDurationSec: 1119.008 }).targetDurationSec, 1119, "capped at the source length");
  assert.equal(Editorial.optionsFor({ targetDurationSec: 5 }).targetDurationSec, 15);
});
test("missing, malformed and high-severity reviews cannot pass the quality gate", () => {
  for (const review of [null, {}, { ...good, overall_score: null }, { ...good, overall_score: 9 }, { ...good, issues: undefined }, bad, { ...good, overall_score: .69 }]) assert.equal(Editorial.qualityGate(review).passed, false);
  assert.equal(Editorial.qualityGate(good).passed, true);
});
test("soft duration accepts a complete shorter story but rejects major deviation and reviews below 8/10", () => {
  const context = { qualityFirst: true, duration: Editorial.durationGate(750, 900, { soft: true }) };
  assert.equal(context.duration.min, 720); assert.equal(context.duration.max, 1080);
  assert.equal(Editorial.qualityGate(good, [], context).passed, true);
  assert.equal(Editorial.qualityGate({ ...good, overall_score: .79 }, [], context).passed, false);
  assert.equal(Editorial.qualityGate({ ...good, duration_assessment: undefined }, [], context).passed, false);
  assert.equal(Editorial.qualityGate({ ...good, duration_assessment: { verdict: "too_short", reason: "The causal resolution is missing." } }, [], context).passed, false);
  const far = { ...context, duration: Editorial.durationGate(404, 900, { soft: true }) };
  assert.ok(Editorial.qualityGate(good, [], far).blockers.some(issue => issue.type === "duration_deviation"));
  assert.equal(Editorial.qualityGate({ ...good, issues: {} }).passed, false);
});
test("a shorter complete draft uses quality review instead of duration-only expansion", async () => {
  const f = await fixture({ viralOptimization: false, targetDurationSec: 20 }, [good]);
  try {
    const result = await f.run();
    assert.equal(result.status, "completed");
    assert.equal(f.calls.rewrite, 0);
    assert.equal(f.calls.review, 1); assert.equal(f.calls.final, 1);
    assert.equal(f.calls.lastReviewContext.qualityFirst, true);
    assert.equal(f.calls.lastReviewContext.duration.target, 20);
    const saved = await f.store.getProject(f.root, f.project.id);
    assert.equal(saved.recap.durationAssessment.reason, good.duration_assessment.reason);
  } finally { await f.cleanup(); }
});

test("a materially undersized long recap stops before TTS even when editorial repair claims success", async () => {
  let f;
  f = await fixture({ viralOptimization: false, targetDurationSec: 1000 }, [good], [4, 10], {
    media: () => ({ probeVideo: async () => ({ duration: 1625, width: 640, height: 360 }),
      ensureAnalysisProxy: async () => path.join(f.root, "source.mp4"),
      detectScenes: async () => [{ startSec: 0, endSec: 1625 }], planChunks: () => [{ isSingleChunk: true }] })
  });
  try {
    const result = await f.run();
    assert.equal(result.status, "quality_blocked"); assert.equal(result.blockers[0].type, "narrative_scope");
    assert.match(result.blockers[0].description, /Chưa tạo TTS/);
    assert.equal(f.calls.tts, 0); assert.equal(f.calls.draft, 0); assert.equal(f.calls.final, 0);
  } finally { await f.cleanup(); }
});

test("unresolved AI word budgets keep their repair checkpoint and block quality instead of crashing recap:run", async () => {
  const f = await fixture({ viralOptimization: false, allowShotReuse: false }, [good], [4, 80], { narrativeAi: {
    analyzeVideoChunk: async () => ({ events: events.map(event => ({ ...event, anchorMethod: "scene_frames" })) }),
    rewriteRecap: async input => {
      assert.ok(input.repairCache);
      await input.onRepair("accepted-sentence", { text: "She saves him." });
      throw Object.assign(new Error("Chưa có câu đúng ngân sách; các câu đã đạt được giữ lại để chạy tiếp."), { kind: "timing_repair_failed" });
    }
  } });
  try {
    const result = await f.run();
    assert.equal(result.status, "quality_blocked");
    assert.ok(result.blockers.some(issue => /các câu đã đạt/.test(issue.description)), JSON.stringify(result));
    assert.equal(f.calls.draft, 0); assert.equal(f.calls.final, 0);
    const state = JSON.parse(await fs.readFile(path.join(f.root, f.project.id, "analysis", "recap_state.json")));
    assert.equal(state.clauseRepairCache["accepted-sentence"].text, "She saves him.");
    assert.ok(state.audioTracks); assert.equal(state.reviewReady, false);
  } finally { await f.cleanup(); }
  const budget = await fixture({ viralOptimization: false, allowShotReuse: false }, [good], [4, 80], { narrativeAi: {
    analyzeVideoChunk: async () => ({ events: events.map(event => ({ ...event, anchorMethod: "scene_frames" })) }),
    rewriteRecap: async () => { throw Object.assign(new Error("Spending limit"), { kind: "budget" }); }
  } });
  try { await assert.rejects(budget.run(), { kind: "budget" }); }
  finally { await budget.cleanup(); }
});

test("measured timing repairs cannot shrink a long story below scope and regenerate TTS before rejecting it", async () => {
  const wide = Array.from({ length: 60 }, (_, i) => ({ id: `e${i}`, source_start: i * 16, source_end: i * 16 + 15,
    duration: 15, anchorMethod: "scene_frames", description: `Observed action ${i}` }));
  const longPlan = { ...plan, target_duration_sec: 1000, selected_event_ids: wide.map(event => event.id), beats: [plan.beats[0],
    { beat_id: "body", role: "payoff", visual_event_ids: wide.slice(1).map(event => event.id) }] };
  const body = { ...units[1], text: Array(2100).fill("word").join(" "), visual_event_ids: wide.slice(1).map(event => event.id),
    clauses: [{ clause_id: "body_c1", text: Array(2100).fill("word").join(" "), visual_event_ids: wide.slice(1).map(event => event.id) }] };
  let f, rewrites = 0;
  f = await fixture({ viralOptimization: false, targetDurationSec: 1000, allowShotReuse: false }, [good], [4, 1200], {
    media: () => ({ probeVideo: async () => ({ duration: 1625, width: 640, height: 360 }), ensureAnalysisProxy: async () => path.join(f.root, "source.mp4"),
      detectScenes: async () => [{ startSec: 0, endSec: 1625 }], planChunks: () => [{ sourceStartSec: 0, sourceEndSec: 1625, isSingleChunk: true }] }),
    narrativeAi: { analyzeVideoChunk: async () => ({ events: wide }), planRecap: async () => longPlan,
      generateNarration: async () => [units[0], body], rewriteRecap: async request => {
        rewrites++; assert.ok(request.feedback.scopeGuard);
        return { plan: longPlan, speech_units: [units[0], { ...body, text: "Only a synopsis remains.", clauses: [{ ...body.clauses[0], text: "Only a synopsis remains." }] }] };
      } }
  });
  try {
    const result = await f.run(); assert.equal(result.status, "quality_blocked");
    assert.equal(result.blockers[0].type, "source_capacity"); assert.equal(rewrites, 2);
    assert.equal(f.calls.tts, 1, "the rejected rewrite must never regenerate speech");
    assert.equal(f.calls.draft, 0); assert.equal(f.calls.final, 0);
    const saved = JSON.parse(await fs.readFile(path.join(f.root, f.project.id, "analysis", "recap_state.json")));
    assert.equal(saved.speechUnits[1].text, body.text); assert.ok(saved.audioTracks);
    await f.run(); assert.equal(rewrites, 2, "unchanged rejected scope must not repeat either AI repair");
    assert.equal(f.calls.tts, 1);
  } finally { await f.cleanup(); }
});

test("a faster real voice triggers bounded scope replanning even when every clause already fits footage", async () => {
  const wide = Array.from({ length: 60 }, (_, i) => ({ id: `e${i}`, source_start: i * 16, source_end: i * 16 + 15,
    duration: 15, anchorMethod: "scene_frames", description: `Observed action ${i}` }));
  const longPlan = { ...plan, target_duration_sec: 1000, selected_event_ids: wide.map(event => event.id), beats: [plan.beats[0],
    { beat_id: "body", role: "payoff", visual_event_ids: wide.slice(1).map(event => event.id) }] };
  const unit = n => ({ ...units[1], text: Array(n).fill("word").join(" "), visual_event_ids: wide.slice(1).map(event => event.id) });
  let f, rewrites = 0, ttsCalls = 0;
  f = await fixture({ viralOptimization: false, targetDurationSec: 1000, allowShotReuse: false }, [good], [4, 10], {
    media: () => ({ probeVideo: async () => ({ duration: 1625, width: 640, height: 360 }), ensureAnalysisProxy: async () => path.join(f.root, "source.mp4"),
      detectScenes: async () => [{ startSec: 0, endSec: 1625 }], planChunks: () => [{ sourceStartSec: 0, sourceEndSec: 1625, isSingleChunk: true }] }),
    tts: () => ({ getVoiceProfile: async () => ({ wordsPerSecond: 2.5 }), synthesizeAll: async ({ speechUnits }) => {
      ttsCalls++; return Object.fromEntries(speechUnits.map((u, i) => [u.id, { text: u.text, audioPath: path.join(f.root, "source.mp4"), durationSec: i ? u.text.split(" ").length / 3.6 : 4 }]));
    } }),
    narrativeAi: { analyzeVideoChunk: async () => ({ events: wide }), planRecap: async () => longPlan, generateNarration: async () => [units[0], unit(2100)],
      rewriteRecap: async request => { rewrites++; assert.equal(request.feedback.measuredScopeMismatch, true);
        return { plan: longPlan, speech_units: [units[0], unit(3000)] }; } }
  });
  try {
    assert.equal((await f.run()).status, "completed"); assert.equal(rewrites, 1); assert.equal(ttsCalls, 2);
    assert.equal(f.calls.review, 1); assert.equal(f.calls.final, 1);
  } finally { await f.cleanup(); }
});

test("long recap production writes against source chapters instead of the legacy short-form plan and resumes its saved chapters", async () => {
  let f, written = 0;
  f = await fixture({ viralOptimization: false, targetDurationSec: 1000 }, [good], [4, 10], {
    media: () => ({ probeVideo: async () => ({ duration: 1625, width: 640, height: 360 }),
      ensureAnalysisProxy: async () => path.join(f.root, "source.mp4"),
      detectScenes: async () => [{ startSec: 0, endSec: 1625 }],
      planChunks: () => [{ sourceStartSec: 0, sourceEndSec: 1625, durationSec: 1625, isSingleChunk: true }] }),
    narrativeAi: {
      planRecap: async () => { throw new Error("Legacy short-form planner must not run"); },
      generateNarration: async () => { throw new Error("Legacy short-form writer must not run"); },
      generateLongFormNarration: async input => {
        written++; assert.equal(input.wordsPerSecond, 2.5); assert.equal(input.chunks[0].sourceEndSec, 1625);
        assert.ok(input.media); assert.equal(input.options.targetDurationSec, 1000);
        await input.onSection("completed-chapter", { passage_1: { text: "Source-backed paragraph." } });
        return { plan, speechUnits: units, events, metrics: [], filePaths: ["source.mp4"] };
      }
    }
  });
  try {
    assert.equal((await f.run()).status, "quality_blocked", "the fixture is deliberately short; length guards still apply");
    const state = JSON.parse(await fs.readFile(path.join(f.root, f.project.id, "analysis", "recap_state.json")));
    assert.ok(state.longFormSections["completed-chapter"]); assert.deepEqual(state.longFormNarration.sourceFiles, ["source.mp4"]);
    await f.run(); assert.equal(written, 1); assert.equal(f.calls.tts, 0);
  } finally { await f.cleanup(); }
});

test("editorial preflight runs before TTS and presentation-only changes reuse the inspected script", async () => {
  let f, inspected = 0;
  f = await fixture({ viralOptimization: false }, [good], [4, 10], { narrativeAi: {
    reviewNarration: async () => { inspected++; assert.equal(f.calls.tts, 0, "inspect script before spending on audio");
      return { ...good, recommended_additions: [], duration_assessment: { ...good.duration_assessment, missing_event_ids: [] } }; }
  } });
  try {
    assert.equal((await f.run()).status, "completed"); assert.equal(inspected, 1);
    const state = JSON.parse(await fs.readFile(path.join(f.root, f.project.id, "analysis", "recap_state.json"), "utf8"));
    assert.equal(state.narrativePreflight.finalApproved, false);
    assert.equal((await f.run({ recapCaptionStyle: "phrase" })).status, "completed"); assert.equal(inspected, 1);
    assert.equal(f.calls.review, 2, "changed presentation still requires real draft review");
  } finally { await f.cleanup(); }
});
test("an unavailable early script check cannot replace or bypass the actual failed draft review", async () => {
  const f = await fixture({ viralOptimization: false }, [bad], [4, 10], { narrativeAi: {
    reviewNarration: async () => { throw new Error("Preflight provider unavailable"); }
  } });
  try {
    assert.equal((await f.run()).status, "quality_blocked"); assert.equal(f.calls.review, 2); assert.equal(f.calls.final, 0);
  } finally { await f.cleanup(); }
});
test("malformed and unavailable reviews never manufacture a passing score", async () => {
  for (const error of [new Error("Review không hợp lệ: thiếu chế độ thời gian"), new Error("Review chưa bao phủ đủ toàn bộ draft.")]) {
    const f = await fixture({ viralOptimization: false, strictQualityGate: false }, [error]);
    try {
      assert.equal((await f.run()).status, "quality_blocked");
      assert.equal(f.calls.final, 0);
      const saved = await f.store.getProject(f.root, f.project.id);
      assert.equal(saved.recap.qualityScore, null);
    } finally { await f.cleanup(); }
  }
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
test("a failed review blocks export after repair, including manual approval and legacy non-strict settings", async () => {
  const f = await fixture({}, [bad]);
  const fStrict = await fixture({}, [bad]);
  try {
    await f.service.updateReviewDecisions(f.root, f.project.id, { userApprovedFinal: true });
    const result = await f.run(); assert.equal(result.status, "quality_blocked");
    assert.equal(f.calls.review, 2); assert.equal(f.calls.rewrite, 1); assert.equal(f.calls.final, 0);
    assert.ok(result.blockers.some(issue => issue.severity === "high"));
    await fStrict.service.updateReviewDecisions(fStrict.root, fStrict.project.id, { userApprovedFinal: true });
    const strictResult = await fStrict.run({ strictQualityGate: true }); assert.equal(strictResult.status, "quality_blocked");
    assert.equal(fStrict.calls.review, 2); assert.equal(fStrict.calls.rewrite, 1); assert.equal(fStrict.calls.final, 0);
    assert.equal((await fStrict.store.getProject(fStrict.root, fStrict.project.id)).status, "quality_blocked");
  } finally { await f.cleanup(); await fStrict.cleanup(); }
});
test("successful quality repair rerenders and reviews the changed draft before final", async () => {
  const f = await fixture({ viralOptimization: false }, [bad, good]);
  try { assert.equal((await f.run()).status, "completed"); assert.equal(f.calls.review, 2); assert.equal(f.calls.draft, 2); assert.equal(f.calls.final, 1); }
  finally { await f.cleanup(); }
});

test("a distinct remaining blocker gets one bounded additional patch and the resulting draft is reviewed again", async () => {
  const voice = { ...bad, issues: [{ severity: "high", type: "voice_quality", description: "One sentence is unclear." }] };
  const caption = { ...bad, issues: [{ severity: "high", type: "caption_error", description: "A different caption needs correction." }] };
  const f = await fixture({ viralOptimization: false }, [voice, caption, good]);
  try {
    assert.equal((await f.run()).status, "completed");
    assert.equal(f.calls.rewrite, 2); assert.equal(f.calls.review, 3);
    assert.equal(f.calls.draft, 3); assert.equal(f.calls.final, 1);
  } finally { await f.cleanup(); }
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
test("unavailable review and excessive duration deviation block final, without mechanical duration expansion", async () => {
  const f = await fixture({ viralOptimization: false }, [new Error("Provider offline")]);
  const short = await fixture({ viralOptimization: false }, [good], [1, 1]);
  const shortStrict = await fixture({ viralOptimization: false }, [good], [1, 1]);
  try {
    assert.equal((await f.run()).status, "quality_blocked"); assert.equal(f.calls.final, 0);
    const shortRes = await short.run();
    assert.equal(shortRes.status, "quality_blocked");
    assert.equal(short.calls.rewrite, 1, "only one editorial improvement, no duration-only rewrite loop");
    assert.equal(short.calls.review, 2);
    assert.equal(short.calls.final, 0);
    assert.ok(shortRes.blockers.some(issue => issue.type === "duration_deviation"));
    const strictRes = await shortStrict.run({ strictDurationGate: true });
    assert.equal(strictRes.status, "quality_blocked"); assert.equal(shortStrict.calls.rewrite, 2);
    assert.equal(shortStrict.calls.review, 0); assert.equal(shortStrict.calls.final, 0);
    assert.equal(strictRes.blockers.length, 1);
  } finally { await f.cleanup(); await short.cleanup(); await shortStrict.cleanup(); }
});
test("missing narrative context is patched and freshly reviewed without auditing unrelated medium visual warnings", async () => {
  let audits = 0, patches = 0;
  const missing = { ...good, duration_assessment: { verdict: "too_short", reason: "A source-backed causal discovery is missing." },
    issues: [{ severity: "medium", type: "semantic_alignment", output_start: 1, output_end: 3, description: "A minor cutaway" },
      { severity: "low", type: "narration_facts", speech_unit_ids: ["body"], description: "Fix the order of the discovery" }] };
  const f = await fixture({ viralOptimization: false }, [missing, good], [4, 10], {
    anchorAudit: () => ({ repair: async () => { audits++; throw Error("Unrelated audit"); } }),
    narrativeAi: { rewriteRecap: async ({ feedback }) => {
      patches++; assert.ok(feedback.issues.some(issue => issue.type === "editorial_duration"));
      assert.ok(feedback.issues.some(issue => issue.type === "narration_facts"));
      assert.ok(!feedback.issues.some(issue => issue.type === "semantic_alignment"));
      return { plan, speech_units: units };
    } }
  });
  try {
    assert.equal((await f.run()).status, "completed");
    assert.equal(audits, 0); assert.equal(patches, 1); assert.equal(f.calls.review, 2);
  } finally { await f.cleanup(); }
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
test("a paid-request interruption after source audit resumes quality repair without repeating completed preflight", async () => {
  let preflights = 0, patches = 0;
  const mismatch = { ...bad, issues: [{ severity: "high", type: "semantic_alignment", output_start: 1, output_end: 3, description: "Wrong actor" }] };
  const f = await fixture({ viralOptimization: false }, [mismatch, good], [4, 10], {
    anchorAudit: () => ({ repair: async request => request.events.map(event => event.id === "e0"
      ? { ...event, description: "Source-verified actor", anchorAudit: { confidence: .95 } } : event) }),
    narrativeAi: {
      reviewNarration: async () => { preflights++; return { ...good, recommended_additions: [],
        duration_assessment: { ...good.duration_assessment, missing_event_ids: [] } }; },
      rewriteRecap: async () => { if (!patches++) throw Error("Paid request interrupted"); return { plan, speech_units: units }; }
    }
  });
  try {
    assert.equal((await f.run()).status, "quality_blocked");
    assert.equal(preflights, 1); assert.equal(f.calls.final, 0);
    const restarted = new Pipeline({ projectStore: f.store, serviceFactories: f.service.serviceFactories, logger: { log() {} } });
    assert.equal((await restarted.runRecapProject({ workspaceRoot: f.root, projectId: f.project.id })).status, "completed");
    assert.equal(preflights, 1); assert.equal(patches, 2); assert.equal(f.calls.review, 2);
  } finally { await f.cleanup(); }
});

test("critical story-continuity mismatches reach the source audit with the actual narration", async () => {
  let audited = 0;
  const mismatch = { ...bad, issues: [{ severity: "critical", type: "story_continuity", output_start: 1, output_end: 3,
    description: "Kabuto is next to the wrong character", recommended_action: "Verify the source action" }] };
  const f = await fixture({ viralOptimization: false }, [mismatch, good], [4, 10], { anchorAudit: () => ({ repair: async request => {
    audited++; assert.deepEqual(request.eventIds, ["e0"]); assert.ok(request.narration.some(unit => unit.text)); return request.events;
  } }) });
  try { assert.equal((await f.run()).status, "completed"); assert.equal(audited, 1); }
  finally { await f.cleanup(); }
});
test("a critical mismatch audits the other references in that sentence before rewriting to a nearby wrong label", async () => {
  const mismatch = { ...bad, issues: [{ severity: "critical", type: "factual_error", output_start: 5, output_end: 6,
    description: "Wrong target in a multi-event narration unit" }] };
  let audited = 0;
  const f = await fixture({ viralOptimization: false }, [mismatch, good], [4, 10], { anchorAudit: () => ({ repair: async request => {
    audited++; assert.deepEqual(new Set(request.eventIds), new Set(["e1", "e2"])); return request.events;
  } }) });
  try { assert.equal((await f.run()).status, "completed"); assert.equal(audited, 1); }
  finally { await f.cleanup(); }
});
test("free-form review labels cannot bypass source verification for blocking character and factual issues", () => {
  const needsSource = Pipeline.prototype.isSourceIssue;
  for (const type of ["character_mismatch", "factual_error", "story_continuity", "new_grounding_error", "unexpected_blocking_label"])
    assert.equal(needsSource({ type, severity: "critical" }), true, type);
  for (const type of ["voice_quality", "audio_clipping", "caption_error", "pacing", "duration"])
    assert.equal(needsSource({ type, severity: "high" }), false, type);
});
test("a failed critical source audit cannot be bypassed with a cosmetic narration rewrite", async () => {
  const mismatch = { ...bad, issues: [{ severity: "critical", type: "story_continuity", output_start: 1, output_end: 3, description: "Wrong victim" }] };
  const f = await fixture({ viralOptimization: false }, [mismatch], [4, 10], { anchorAudit: () => ({ repair: async () => { throw new Error("Unverified victim"); } }) });
  try { const result = await f.run(); assert.equal(result.status, "quality_blocked"); assert.equal(f.calls.rewrite, 0);
    assert.ok(result.blockers.some(issue => issue.type === "source_audit_failed")); assert.equal(f.calls.final, 0); }
  finally { await f.cleanup(); }
});
test("material duration deficit with overflowing clauses runs full duration+clause rewrite instead of clause-only shortening", async () => {
  const Ai = require("../electron/services/recap/recapAiService");
  const ai = new Ai(), prompts = [];
  ai.runVertexCall = async ({ prompt }) => { prompts.push(prompt); return { plan, speech_units: units }; };
  await ai.rewriteRecap({
    events,
    recapPlan: { ...plan, target_duration_sec: 600 },
    speechUnits: units,
    options: { targetDurationSec: 600, language: "en" },
    feedback: {
      duration: { passed: false, actual: 408.6, min: 510, max: 630 },
      clauseBudgets: [{ speechUnitId: "body", clauseIds: ["c1"], text: "Their response reveals the cause", visual_event_ids: ["e1"], targetWordCount: 4 }]
    }
  });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Measured current script: 16 words produced 408.6 seconds/);
  assert.match(prompts[0], /reach 600 seconds/);
});
test("shared visual events across speech units reserve footage so later aligned units do not starve", () => {
  const { RecapSyncSolver } = require("../electron/services/recap/recapSyncSolver");
  const solver = new RecapSyncSolver({ allowShotReuse: false });
  const sharedEvents = [
    { id: "shared_ev", source_start: 10, source_end: 18, duration: 8 },
    { id: "second_ev", source_start: 30, source_end: 38, duration: 8 }
  ];
  const sharedUnits = [
    { id: "su_early", text: "Early unit uses shared event.", visual_event_ids: ["shared_ev"] },
    {
      id: "su_later",
      text: "First clause uses shared event. Second clause switches.",
      visual_event_ids: ["shared_ev", "second_ev"],
      clauses: [
        { clause_id: "c1", text: "First clause uses shared event.", visual_event_ids: ["shared_ev"] },
        { clause_id: "c2", text: "Second clause switches.", visual_event_ids: ["second_ev"] }
      ]
    }
  ];
  const solution = solver.solve({
    speechUnits: sharedUnits,
    visualEvents: sharedEvents,
    audioTracks: {
      su_early: { durationSec: 3.5 },
      su_later: {
        durationSec: 4.0,
        clauseSpans: [
          { startSec: 0, endSec: 2, text: "First clause uses shared event.", visual_event_ids: ["shared_ev"], clauseIds: ["c1"] },
          { startSec: 2, endSec: 4, text: "Second clause switches.", visual_event_ids: ["second_ev"], clauseIds: ["c2"] }
        ]
      }
    },
    scenes: [{ startSec: 10, endSec: 18 }, { startSec: 30, endSec: 38 }],
    sourceDurationSec: 50
  });
  assert.equal(solution.metrics.semanticTimingMismatchCount, 0);
  assert.ok(solution.clauseBudgets.every(b => b.passed && b.missingEventIds.length === 0));
});
test("generateNarration enforces beat_id enum and groundNarration resolves missing or role-based beat_id", async () => {
  const Ai = require("../electron/services/recap/recapAiService");
  const ai = new Ai();
  let capturedSchema = null;
  ai.runVertexCall = async ({ responseSchema }) => {
    capturedSchema = responseSchema;
    return { speech_units: units };
  };
  await ai.generateNarration({ recapPlan: plan, events, wordsPerSecond: 2.6, editorialOptions: { language: "en" } });
  const itemSchema = capturedSchema.properties.speech_units.items;
  assert.ok(itemSchema.required.includes("beat_id"));
  assert.deepEqual(itemSchema.properties.beat_id.enum, ["opening_hook", "body"]);

  const grounded = Editorial.groundNarration([
    { id: "su_1", beat_id: "hook", text: hooks[0].text, visual_event_ids: ["e0"] },
    { id: "su_2", beat_id: "beat_99", text: "Body unit with invented beat_id but valid event.", visual_event_ids: ["e1"] },
    { id: "su_3", beat_id: "", text: "Body unit with empty beat_id.", visual_event_ids: ["e2"] }
  ], events, plan, hooks[0]);
  assert.equal(grounded.length, 3);
  assert.equal(grounded[0].beat_id, "opening_hook");
  assert.equal(grounded[1].beat_id, "body");
  assert.equal(grounded[2].beat_id, "body");
});

test("groundNarration safely recovers clauses with empty or hallucinated event IDs", () => {
  const unitsWithEmptyOrInvalidClauses = [
    {
      id: "su_1",
      beat_id: "body",
      text: "First body unit text with multiple clauses.",
      visual_event_ids: ["e0", "non_existent_event_99"],
      clauses: [
        { clause_id: "su_1_c1", text: "First clause with empty events.", visual_event_ids: [] },
        { clause_id: "su_1_c2", text: "Second clause with hallucinated event.", visual_event_ids: ["hallucinated_event"] }
      ]
    },
    {
      id: "su_2",
      beat_id: "body",
      text: "Second body unit text.",
      visual_event_ids: [],
      clauses: [
        { clause_id: "su_2_c1", text: "Clause has no events either.", visual_event_ids: [] }
      ]
    }
  ];
  const grounded = Editorial.groundNarration(unitsWithEmptyOrInvalidClauses, events, plan, hooks[0]);
  assert.equal(grounded.length, 3); // opening_hook + 2 body units
  // Body unit 1 (index 1): empty and invalid clauses fell back to valid unit event ["e0"]
  assert.deepEqual(grounded[1].visual_event_ids, ["e0"]);
  assert.deepEqual(grounded[1].clauses[0].visual_event_ids, ["e0"]);
  assert.deepEqual(grounded[1].clauses[1].visual_event_ids, ["e0"]);
  // Body unit 2 (index 2): unit and clause recovered from plan beat
  assert.ok(grounded[2].visual_event_ids.length > 0);
  assert.ok(grounded[2].visual_event_ids.every(id => events.some(e => e.id === id)));
  assert.deepEqual(grounded[2].clauses[0].visual_event_ids, grounded[2].visual_event_ids);
});

test("long-form planRecap and generateNarration enforce expanded beats and character grounding", async () => {
  const Ai = require("../electron/services/recap/recapAiService");
  const ai = new Ai();
  let capturedPlanPrompt = "", capturedPlanSchema = null;
  ai.runVertexCall = async ({ prompt, responseSchema }) => {
    capturedPlanPrompt = prompt;
    capturedPlanSchema = responseSchema;
    return {
      target_duration_sec: 600,
      hook_event_ids: ["ev_0"],
      selected_event_ids: ["ev_0", "ev_1"],
      beats: [
        { beat_id: "opening_hook", role: "hook", visual_event_ids: ["ev_0"] },
        { beat_id: "beat_2", role: "setup", visual_event_ids: ["ev_1"] }
      ]
    };
  };
  const dummyEvents = Array.from({ length: 30 }, (_, i) => ({
    id: `ev_${i}`, source_start: i * 20, source_end: (i + 1) * 20, description: `Event ${i}`, subjects: ["Ninja"], actions: ["Run"]
  }));
  await ai.planRecap({ visualEvents: dummyEvents, targetDurationSec: 600, angle: { id: "a1" }, hook: { id: "h1", text: "Hook" } });
  assert.ok(capturedPlanPrompt.includes("LONG-FORM RECAP PLANNING (600s)"));
  assert.ok(capturedPlanPrompt.includes("Sum the actual supplied interval durations"));
  assert.ok(!capturedPlanPrompt.includes("giant summonings"), "generic film planning must not impose the diagnostic anime's plot");
  assert.ok(capturedPlanSchema.properties.beats.minItems >= 12);
  let capturedNarrationPrompt = "";
  ai.runVertexCall = async ({ prompt }) => {
    capturedNarrationPrompt = prompt;
    return { speech_units: [] };
  };
  await ai.generateNarration({
    recapPlan: { target_duration_sec: 600, beats: [{ beat_id: "b1", visual_event_ids: ["ev_0"] }] },
    events: dummyEvents,
    wordsPerSecond: 2.6
  });
  assert.ok(capturedNarrationPrompt.includes("MULTI-UNIT BEAT STRUCTURING"));
  assert.ok(capturedNarrationPrompt.includes("CRITICAL CHARACTER & ACTION GROUNDING"));
});
