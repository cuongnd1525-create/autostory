const test = require("node:test"), assert = require("node:assert/strict");
const Preflight = require("../electron/services/recap/recapNarrativePreflightService");
const Ai = require("../electron/services/recap/recapAiService");
const events = [0, 12, 24].map((start, i) => ({ id: `e${i}`, source_start: start, source_end: start + 10,
  duration: 10, anchorMethod: "scene_frames", description: `Observed action ${i}` }));
const plan = { target_duration_sec: 30, selected_event_ids: ["e0", "e1"], beats: [
  { beat_id: "opening_hook", role: "hook", visual_event_ids: ["e0"] }, { beat_id: "body", role: "payoff", visual_event_ids: ["e1"] }
] };
const units = [{ id: "opening_hook", beat_id: "opening_hook", text: "Why does she freeze?", visual_event_ids: ["e0"] },
  { id: "body", beat_id: "body", text: "She faces the danger.", visual_event_ids: ["e1"] }];
const review = { overall_score: .85, summary: "Clear", issues: [], recommended_additions: [],
  duration_assessment: { verdict: "appropriate", reason: "Complete concise story", missing_event_ids: [] } };
const request = { speechUnits: units, events, recapPlan: plan, options: { targetDurationSec: 30, allowShotReuse: false }, voiceKey: "adam" };

test("preflight reuses the real sync solver to identify short scope and unavailable footage before creating audio", () => {
  const service = new Preflight();
  const result = service.estimate({ ...request, wordsPerSecond: 3 });
  assert.equal(result.estimated, true); assert.equal(result.wordCount, 8); assert.ok(result.duration.actual < 5);
  assert.equal(result.duration.largeDeviation, true);
  assert.equal(result.sourceCoverage.selectedSec, 14); assert.equal(result.sourceCoverage.availableSec, 30);
  const long = { ...units[1], text: Array(80).fill("word").join(" "), visual_event_ids: ["e1"] };
  assert.ok(service.estimate({ ...request, speechUnits: [long], wordsPerSecond: 3 }).clauseBudgets.length > 0);
  const measured = { ...long, text: Array(40).fill("word").join(" ") };
  const learned = service.estimate({ ...request, speechUnits: [measured], wordsPerSecond: 1,
    audioTracks: { body: { text: measured.text, durationSec: 10 } } });
  assert.equal(learned.wordsPerSecond, 4); assert.equal(learned.cadenceSource, "cached_tts");
});
test("script preflight repairs missing causal content once, caches the changed script and never approves a master", async () => {
  const service = new Preflight(); let reviews = 0, repairs = 0;
  const extra = { id: "explanation", beat_id: "body", text: "She sees a chance and chooses to protect him.", visual_event_ids: ["e2"] };
  const ai = { reviewNarration: async () => { reviews++; return { ...review, overall_score: .7,
    duration_assessment: { verdict: "too_short", reason: "The protective decision is missing", missing_event_ids: ["e2"] },
    recommended_additions: [{ after_id: "body", beat_id: "body", event_ids: ["e2"], purpose: "Explain the decision" }] }; },
    rewriteRecap: async input => { repairs++; assert.equal(input.feedback.preflight, true);
      assert.equal(input.feedback.patchOnly, false); assert.equal(input.feedback.forceScopeRepair, true);
      assert.equal(input.feedback.recommendedAdditions[0].event_ids[0], "e2");
      return { plan: { ...plan, selected_event_ids: ["e0", "e1", "e2"] }, speech_units: [...units, extra] }; } };
  const result = await service.run({ ...request, ai, wordsPerSecond: 3 });
  assert.equal(reviews, 1); assert.equal(repairs, 1); assert.equal(result.report.finalApproved, false);
  assert.equal(result.speechUnits.at(-1).id, "explanation");
  assert.equal(result.speechUnits[0].text, units[0].text);
  assert.ok(result.report.after.wordCount > result.report.before.wordCount);
  const resumed = { ...request, ...result, cached: result.report, ai, wordsPerSecond: 3 };
  assert.equal((await service.run(resumed)).reused, true); assert.equal(reviews, 1);
  await service.run({ ...resumed, events: events.map(event => ({ ...event, description: `${event.description} verified` })) });
  assert.equal(reviews, 2, "changed source evidence invalidates script inspection");
});

test("a global scope deficit cannot be routed into clause-only shortening", async () => {
  const ai = new Ai();
  ai.repairMeasuredClauses = async () => { throw new Error("Unexpected clause-only repair"); };
  ai.runVertexCall = async request => {
    assert.match(request.prompt, /GLOBAL SCOPE REPAIR/); assert.match(request.prompt, /estimate before TTS/);
    assert.ok(request.responseSchema.properties.plan); return { plan, speech_units: units };
  };
  const result = await ai.rewriteRecap({ events, recapPlan: plan, speechUnits: units, options: { targetDurationSec: 1000 },
    feedback: { qualityFirst: true, preflight: true, forceScopeRepair: true,
      durationPreference: { actual: 320, largeDeviation: true }, durationAssessment: { verdict: "too_short" },
      clauseBudgets: [{ text: "Long clause", targetWordCount: 2 }] } });
  assert.equal(result.speech_units.length, units.length);
});

test("a preflight rewrite cannot collapse a valid long script; retry is bounded and a rejected resume makes no AI call", async () => {
  const service = new Preflight(), event = { ...events[0], source_end: 1500, duration: 1500 };
  const long = { id: "body", beat_id: "body", text: Array(2400).fill("word").join(" "), visual_event_ids: [event.id] };
  const longPlan = { ...plan, target_duration_sec: 1000, selected_event_ids: [event.id], beats: [{ beat_id: "body", role: "payoff", visual_event_ids: [event.id] }] };
  let reviews = 0, repairs = 0, rejected;
  const input = { speechUnits: [long], events: [event], recapPlan: longPlan, options: { targetDurationSec: 1000 }, wordsPerSecond: 2.6,
    ai: { reviewNarration: async () => { reviews++; return { ...review, overall_score: .7 }; },
      rewriteRecap: async request => { repairs++; assert.ok(request.feedback.scopeGuard);
        return { plan: longPlan, speech_units: [{ ...long, text: "Only a short synopsis remains." }] }; } } };
  await assert.rejects(service.run(input), error => { rejected = error; return error.kind === "scope_repair_rejected"; });
  assert.equal(reviews, 1); assert.equal(repairs, 2); assert.equal(long.text.split(" ").length, 2400);
  await assert.rejects(service.run({ ...input, cached: JSON.parse(JSON.stringify(rejected.preflightReport)) }), { kind: "scope_repair_rejected" });
  assert.equal(reviews, 1); assert.equal(repairs, 2, "unchanged rejected input cannot repeat paid preflight repair on resume");
});

test("independently verified coverage extensions retain exact script review, never changed claims or unapproved ranges", async () => {
  const service = new Preflight(), inspected = await service.run({ ...request, ai: { reviewNarration: async () => review } });
  const extended = events.map(event => event.id !== "e1" ? event : { ...event, source_start: 10, source_end: 21.9995,
    duration: 11.9995, supportAudit: { version: 1, originalRange: { start: 12, end: 22 }, checkedRange: { start: 10, end: 21.9995 } } });
  const coverage = { key: "actual-source-observations", status: "completed", parts: { 0: { e1: { claim_supported: true, context_supported: true } } } };
  const input = { ...request, cached: inspected.report, beforeEvents: events, events: extended, coverage };
  const cached = service.reuseVerifiedCoverage(input);
  assert.ok(cached); assert.equal(cached.finalApproved, false); assert.equal(cached.coverageRecoveryKey, coverage.key);
  const result = await service.run({ ...request, events: extended, cached, ai: { reviewNarration: async () => { throw Error("Do not upload the same source chapters again"); } } });
  assert.equal(result.reused, true);
  assert.equal(service.reuseVerifiedCoverage({ ...input, speechUnits: [units[0], { ...units[1], text: "A different story." }] }), null);
  assert.equal(service.reuseVerifiedCoverage({ ...input, events: extended.map(e => ({ ...e, description: "A corrected actor." })) }), null);
  assert.equal(service.reuseVerifiedCoverage({ ...input, coverage: { ...coverage, parts: {} } }), null);
  assert.equal(service.reuseVerifiedCoverage({ ...input, coverage: { ...coverage, status: "pending" } }), null);
  assert.equal(service.reuseVerifiedCoverage({ ...input, events: extended.map(e => e.id === "e1" ? { ...e, source_start: 9 } : e) }), null,
    "an unapproved extra second cannot inherit the review");
  assert.equal(service.reuseVerifiedCoverage({ ...input, events: extended.map(e => e.id === "e1" ? { ...e, narrativeContext: [{ note: "A new unreviewed claim" }] } : e) }), null);
});

test("resume preserves a fingerprinted downstream timing repair without repeating preflight, but rejects unrelated changes", async () => {
  const service = new Preflight(); let reviews = 0;
  const ai = { reviewNarration: async () => { reviews++; return review; } };
  const original = await service.run({ ...request, ai });
  const revised = { ...request, speechUnits: [units[0], { ...units[1], text: "She protects him." }] };
  const Pipeline = require("../electron/services/recap/recapPipelineService"), pipeline = new Pipeline({});
  const state = { speechUnits: revised.speechUnits, recapPlan: plan, narrativePreflight: original.report };
  pipeline.checkpointNarrativeRevision(state, events, revised.options, revised.voiceKey);
  const resumed = await service.run({ ...revised, cached: state.narrativePreflight, ai });
  assert.equal(resumed.reused, true); assert.equal(reviews, 1);
  assert.equal(resumed.report.finalApproved, false);
  assert.notEqual(resumed.report.key, resumed.report.downstreamKey, "retain the original inspection provenance");
  await service.run({ ...revised, voiceKey: "different-voice", cached: state.narrativePreflight, ai });
  assert.equal(reviews, 2, "a voice or source/script change outside the downstream checkpoint invalidates it");
});

test("an already short legacy script cannot be shortened further by preflight, while a meaningful improvement is retained", async () => {
  const event = { ...events[0], source_end: 1500, duration: 1500 };
  const unit = { id: "body", beat_id: "body", text: Array(1200).fill("word").join(" "), visual_event_ids: [event.id] };
  const longPlan = { target_duration_sec: 1000, selected_event_ids: [event.id], beats: [{ beat_id: "body", role: "payoff", visual_event_ids: [event.id] }] };
  let repairs = 0;
  const input = { speechUnits: [unit], events: [event], recapPlan: longPlan, options: { targetDurationSec: 1000 }, wordsPerSecond: 2.6,
    ai: { reviewNarration: async () => ({ ...review, overall_score: .7 }), rewriteRecap: async () => {
      repairs++; return { plan: longPlan, speech_units: [{ ...unit, text: "Another empty synopsis." }] };
    } } };
  await assert.rejects(new Preflight().run(input), { kind: "scope_repair_rejected" });
  assert.equal(repairs, 2); assert.equal(unit.text.split(" ").length, 1200);
  input.ai.rewriteRecap = async () => ({ plan: longPlan, speech_units: [{ ...unit, text: Array(1400).fill("word").join(" ") }] });
  const improved = await new Preflight().run(input);
  assert.equal(improved.report.after.wordCount, 1400);
  assert.equal(improved.report.finalApproved, false, "improving an estimate does not approve an export");
});
test("an appropriate concise script is not padded to meet a word quota and malformed references cannot trigger a repair", async () => {
  const service = new Preflight(); let repairs = 0;
  const ai = { reviewNarration: async () => review, rewriteRecap: async () => { repairs++; } };
  assert.equal((await service.run({ ...request, ai })).report.repaired, false); assert.equal(repairs, 0);
  ai.reviewNarration = async () => ({ ...review, recommended_additions: [{ after_id: "body", beat_id: "body", event_ids: ["invented"], purpose: "Bad" }] });
  await assert.rejects(service.run({ ...request, ai }), /tham chiếu nguồn/); assert.equal(repairs, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.run({ ...request, ai, cancelToken: { signal: controller.signal } }), { name: "AbortError" });
});
test("early editorial review checks actor/target, causal bridges and real event budgets without claiming to watch video", async () => {
  const ai = new Ai();
  ai.runVertexCall = async input => {
    assert.equal(input.filePaths, undefined); assert.match(input.prompt, /PRE-TTS EDITORIAL CHECK/);
    assert.match(input.prompt, /finger from a fist/); assert.match(input.prompt, /Parallel battles/);
    assert.deepEqual(input.responseSchema.properties.duration_assessment.properties.missing_event_ids.items.enum, ["e0", "e1", "e2"]);
    return review;
  };
  await ai.reviewNarration({ ...request, estimates: {} });
});

test("a long script review receives the actual source chapters and dialogue notes, without treating writing notes as verified truth", async () => {
  const ai = new Ai(), sourceFiles = ["chapter-1.mp4", "chapter-2.mp4"];
  ai.runVertexCall = async input => {
    assert.deepEqual(input.filePaths, sourceFiles);
    assert.match(input.prompt, /attached SOURCE chapters/);
    assert.match(input.prompt, /not unquestionable truth/);
    assert.match(input.prompt, /The source dialogue reveals the decision/);
    return review;
  };
  await new Preflight().run({ ...request, ai, sourceFiles,
    events: events.map(e => ({ ...e, narrativeContext: [{ note: "The source dialogue reveals the decision" }] })) });
});


