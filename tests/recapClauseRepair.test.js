const test = require("node:test"), assert = require("node:assert/strict");
const Ai = require("../electron/services/recap/recapAiService");
const limits = [33, 33, 29, 19, 40, 28, 40, 20, 33, 34, 24, 41];
const failed = new Map([[0, 35], [9, 35], [11, 45]]); // The pasted failure's exact counts/limits.
const text = (n, label = "He") => [label, ...Array(n - 2).fill("keeps"), "moving."].join(" ");
const words = value => value.trim().split(/\s+/).length;
const events = limits.map((_, i) => ({ id: `e${i}`, source_start: i * 20, source_end: i * 20 + 20, description: `Observed action ${i}` }));
const speechUnits = limits.map((_, i) => ({ id: `unit_${i}`, beat_id: "body", text: text(50), visual_event_ids: [`e${i}`],
  clauses: [{ clause_id: `c${i}`, text: text(50), visual_event_ids: [`e${i}`] }] }));
const plan = { target_duration_sec: 1000, beats: [{ beat_id: "body", role: "body", visual_event_ids: events.map(e => e.id) }], selected_event_ids: events.map(e => e.id) };
const request = { events, recapPlan: plan, speechUnits, options: { language: "en" }, feedback: { clauseBudgets: limits.map((limit, i) => ({
  speechUnitId: `unit_${i}`, clauseIds: [`c${i}`], text: text(50), visual_event_ids: [`e${i}`], targetWordCount: limit
})) } };
function fixture(respond) {
  const calls = [], ai = new Ai({ aiProvider: "vertex_ai", vertexAnalysisModel: "gemini-2.5-flash", vertexQualityModel: "gemini-2.5-pro" }, {
    vertex: { generateJsonFromFiles: async input => { calls.push(input); return respond(input, calls.length); } }
  });
  return { ai, calls };
}
const requested = input => input.responseSchema.properties.repairs.required;
const rawRepairs = (input, counts = failed) => ({ repairs: Object.fromEntries(requested(input).map(key => {
  const i = Number(key.slice(6)); return [key, text(counts.get(i) || limits[i], `Subject${i}`).split(" ")];
})) });

test("the exact 35/33, 35/34 and 45/41 failure escalates only those groups to quality-model alternatives", async () => {
  const { ai, calls } = fixture((input, call) => {
    if (call <= 2) return rawRepairs(input);
    assert.equal(input.modelOverride, "gemini-2.5-pro");
    assert.deepEqual(requested(input), ["group_0", "group_9", "group_11"]);
    assert.equal(input.responseSchema.properties.repairs.properties.group_0.properties.full.type, "string",
      "each alternative is one sentence; nested word arrays were interpreted as several sentence alternatives");
    return { repairs: Object.fromEntries(requested(input).map(key => {
      const i = Number(key.slice(6)); return [key, { full: text(failed.get(i)),
        short: text(limits[i], `Subject${i}`), brief: text(limits[i] - 5) }];
    })) };
  });
  const repairCache = {}, saved = [];
  const result = await ai.repairMeasuredClauses({ ...request, repairCache, onRepair: async key => saved.push(key) });
  assert.deepEqual(calls.map(c => c.modelOverride), ["gemini-2.5-flash", "gemini-2.5-flash", "gemini-2.5-pro"]);
  assert.equal(saved.length, 12); assert.equal(Object.keys(repairCache).length, 12);
  assert.deepEqual(result.speech_units.map(u => words(u.text)), limits, "the hard budgets are not relaxed");
  assert.equal(result.speech_units[1].text, text(limits[1], "Subject1"), "a successful first response remains unchanged");
  assert.equal(speechUnits[1].text, text(50), "the input checkpoint is untouched until all groups validate");
});

test("an interrupted repair keeps accepted sentences on disk and a new process requests only the unfinished groups", async () => {
  const budget = Object.assign(new Error("Spending limit reached"), { kind: "budget" });
  const first = fixture((input, call) => { if (call === 1) return rawRepairs(input); throw budget; });
  const repairCache = {}; let persisted;
  await assert.rejects(first.ai.repairMeasuredClauses({ ...request, repairCache,
    onRepair: async () => { persisted = JSON.stringify(repairCache); } }), { kind: "budget" });
  assert.equal(Object.keys(JSON.parse(persisted)).length, 9);
  const resumed = fixture(input => {
    assert.deepEqual(requested(input), ["group_0", "group_9", "group_11"]); return rawRepairs(input, new Map());
  });
  const result = await resumed.ai.repairMeasuredClauses({ ...request, repairCache: JSON.parse(persisted) });
  assert.equal(resumed.calls.length, 1); assert.equal(result.speech_units.length, 12);
});

test("all invalid alternatives remain blocked, retain good sentences, and never truncate or accept excess words", async () => {
  const f = fixture((input, call) => call < 3 ? rawRepairs(input) : { repairs: Object.fromEntries(requested(input).map(key => {
    const i = Number(key.slice(6)), value = text(limits[i] + 1);
    return [key, { full: value, short: value, brief: value }];
  })) });
  const repairCache = {};
  await assert.rejects(f.ai.repairMeasuredClauses({ ...request, repairCache }), { kind: "timing_repair_failed" });
  assert.equal(f.calls.length, 3); assert.equal(Object.keys(repairCache).length, 9);
  assert.ok(speechUnits.every(u => u.text === text(50)));
});

test("cache hits avoid AI and changes to source evidence, bounds or input text invalidate only affected sentences", async () => {
  const f = fixture(input => rawRepairs(input, new Map())), repairCache = {};
  await f.ai.repairMeasuredClauses({ ...request, repairCache });
  await f.ai.repairMeasuredClauses({ ...request, repairCache });
  assert.equal(f.calls.length, 1);
  await f.ai.repairMeasuredClauses({ ...request, repairCache,
    events: events.map((e, i) => i === 0 ? { ...e, description: "Corrected actor/action" } : e) });
  assert.deepEqual(requested(f.calls[1]), ["group_0"]);
  await f.ai.repairMeasuredClauses({ ...request, repairCache,
    feedback: { clauseBudgets: request.feedback.clauseBudgets.map((g, i) => i === 9 ? { ...g, text: "Different original claim." } : g) } });
  assert.deepEqual(requested(f.calls[2]), ["group_9"]);
  const cancelled = new AbortController(); cancelled.abort();
  const fresh = fixture(() => { throw new Error("AI must not run after cancellation"); });
  await assert.rejects(fresh.ai.repairMeasuredClauses({ ...request, cancelToken: { signal: cancelled.signal } }), { name: "AbortError" });
  assert.equal(fresh.calls.length, 0);
  await assert.rejects(fresh.ai.repairMeasuredClauses({ ...request, repairCache,
    cancelToken: { signal: cancelled.signal } }), { name: "AbortError" });
});

test("source-backed redistribution uses an approximate detail target, preserves the hard maximum and caches complete sentences", async () => {
  const f = fixture(input => rawRepairs(input, new Map([[0, 31]]))), repairCache = {};
  const balanced = { ...request, repairCache, feedback: { clauseBudgets: [{ ...request.feedback.clauseBudgets[0], minimumWordCount: 32, softMinimum: true }] } };
  const result = await f.ai.repairMeasuredClauses(balanced);
  assert.equal(words(result.speech_units[0].text), 31, "a natural sentence need not be padded by one word");
  assert.equal(f.calls.length, 1);
  await f.ai.repairMeasuredClauses(balanced); assert.equal(f.calls.length, 1);
  const strict = fixture((input, call) => call < 3 ? rawRepairs(input, new Map([[0, 31]])) : { repairs: { group_0: {
    full: text(31), short: text(30), brief: text(29)
  } } });
  await assert.rejects(strict.ai.repairMeasuredClauses({ ...balanced, repairCache: {}, feedback: {
    clauseBudgets: [{ ...balanced.feedback.clauseBudgets[0], softMinimum: false }]
  } }), { kind: "timing_repair_failed" });
  await assert.rejects(f.ai.repairMeasuredClauses({ ...balanced, feedback: {
    clauseBudgets: [{ ...balanced.feedback.clauseBudgets[0], minimumWordCount: 34 }]
  } }), /không hợp lệ/);
  const natural = fixture(input => rawRepairs(input, new Map([[0, 27]])));
  const naturalResult = await natural.ai.repairMeasuredClauses({ ...balanced, repairCache: {} });
  assert.equal(words(naturalResult.speech_units[0].text), 27, "a useful complete sentence is admitted to the aggregate scope check without a lower word quota");
  assert.equal(natural.calls.length, 1);
});

test("missing AI JSON fields use bounded model fallback and exhausted contracts return a resumable timing block", async () => {
  const only = { ...request, feedback: { clauseBudgets: request.feedback.clauseBudgets.slice(0, 1) } };
  const recovered = fixture((input, call) => call === 1 ? { repairs: {} } : rawRepairs(input, new Map()));
  const result = await recovered.ai.repairMeasuredClauses(only);
  assert.equal(words(result.speech_units[0].text), limits[0]);
  assert.deepEqual(recovered.calls.map(c => c.modelOverride), ["gemini-2.5-flash", "gemini-2.5-pro"],
    "a missing JSON field is not a missing credential or runtime");
  const exhausted = fixture(() => ({ repairs: {} }));
  await assert.rejects(exhausted.ai.repairMeasuredClauses(only), { kind: "timing_repair_failed" });
  assert.equal(exhausted.calls.length, 3);
  assert.equal(speechUnits[0].text, text(50));
});

