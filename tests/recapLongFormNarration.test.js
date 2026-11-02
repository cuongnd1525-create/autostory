const test = require("node:test"), assert = require("node:assert/strict");
const Writer = require("../electron/services/recap/recapLongFormNarrationService");
const events = Array.from({ length: 24 }, (_, i) => ({ id: `e${i}`, source_start: i * (320 / 24), source_end: (i + 1) * (320 / 24),
  duration: 320 / 24, description: `Supported development ${i}` }));
const chunks = [{ chunkIndex: 1, sourceStartSec: 0, sourceEndSec: 162, durationSec: 162 },
  { chunkIndex: 2, sourceStartSec: 160, sourceEndSec: 320, durationSec: 160 }];
const options = { targetDurationSec: 300, language: "en", style: "natural", preset: "recap" };
const request = { chunks, events, options, wordsPerSecond: 3.5, proxyPath: "proxy.mp4", directory: "chunks" };
function fixture(answer) {
  const calls = [], mediaCalls = [], cache = {};
  const media = { extractProxyChunk: async ({ chunk }) => { mediaCalls.push(chunk.chunkIndex); return `chunk-${chunk.chunkIndex}.mp4`; } };
  const ai = { getQualityModel: () => "configured-quality-model", getAnalysisModel: () => "configured-analysis-model", runVertexCall: async input => {
    calls.push(input);
    if (input.responseSchema.properties.placements) {
      const names = [...input.prompt.matchAll(/"id":"(passage_\d+)"/g)].map(m => m[1]);
      return { placements: input.responseSchema.properties.placements.items.properties.event_id.enum.map((event_id, i) => ({ event_id, passage_id: names[i % names.length] })) };
    }
    if (answer) return answer(input, calls.length);
    const i = input.filePaths[0] === "chunk-1.mp4" ? 0 : 12;
    return Object.fromEntries(input.responseSchema.required.map((key, index) => [key, {
      text: Array.from({ length: 45 }, (_, n) => `detail${index}_${n}`).join(" "),
      event_ids: [`e${i + index % 12}`], source_note: "The supplied source dialogue supports this development."
    }]));
  } };
  return { ai, media, calls, mediaCalls, cache, onSection: async (key, raw) => { cache[key] = raw; } };
}

test("long-form allocation uses measured cadence and unique intervals, not a short synopsis or duplicate chapter overlap", () => {
  const writer = new Writer(), sections = writer.sections({ ...request, targetDurationSec: options.targetDurationSec });
  assert.equal(sections.flatMap(s => s.events).length, events.length);
  assert.equal(new Set(sections.flatMap(s => s.events.map(e => e.id))).size, events.length);
  assert.ok(Math.abs(sections.reduce((n, s) => n + s.targetWordCount, 0) - 300 * 3.5 * .94) <= 1);
  assert.ok(sections.every(s => s.passageCount > 8));
  const hook = writer.sections({ ...request, targetDurationSec: options.targetDurationSec, hook: { durationSec: 5 } });
  assert.ok(hook[0].targetWordCount < sections[0].targetWordCount);
});

test("source-backed chapters require each named passage and preserve chronological output order and evidence provenance", async () => {
  const writer = new Writer(), f = fixture(), result = await writer.generate({ ...request, ...f });
  assert.equal(f.calls.length, 4); assert.deepEqual(f.calls.map(c => c.filePaths), [["chunk-1.mp4"], ["chunk-1.mp4"], ["chunk-2.mp4"], ["chunk-2.mp4"]]);
  assert.ok(f.calls.filter(c => !c.responseSchema.properties.placements).every(c => c.modelOverride === "configured-quality-model"));
  assert.equal(result.plan.beats.length, 2); assert.ok(result.speechUnits.length >= 20);
  assert.equal(result.speechUnits[0].id, "chapter_1_passage_1");
  assert.equal(result.speechUnits[0].text, result.speechUnits[0].clauses[0].text);
  assert.ok(result.events[0].narrativeContext[0].sourcePath.endsWith("1.mp4"));
  assert.equal(events[0].narrativeContext, undefined, "do not mutate the original source captions");
  assert.equal(result.events[0].description, events[0].description);
  assert.deepEqual(result.filePaths, ["chunk-1.mp4", "chunk-2.mp4"]);
  assert.equal(result.metrics.length, 2);
});

test("successful chapter checkpoints avoid all AI calls on resume, including when earlier writing added context notes", async () => {
  const writer = new Writer(), f = fixture(), result = await writer.generate({ ...request, ...f });
  await writer.generate({ ...request, ...f, events: result.events });
  assert.equal(f.calls.length, 4);
  const changed = events.map(e => ({ ...e, description: `${e.description} corrected` }));
  await writer.generate({ ...request, ...f, events: changed });
  assert.equal(f.calls.length, 8, "source corrections invalidate derived writing");
});

test("an undersized chapter gets at most one targeted retry and honest omissions never create filler or fake duration", async () => {
  const f = fixture(input => Object.fromEntries(input.responseSchema.required.map(key => [key, {
    text: "Only one supported fact.", event_ids: [input.filePaths[0].includes("1") ? "e0" : "e12"], source_note: "Source evidence."
  }])));
  const result = await new Writer().generate({ ...request, ...f });
  assert.equal(f.calls.length, 6);
  assert.ok(result.metrics.every(m => m.wordCount < m.targetWordCount * .75));
  assert.match(f.calls[1].prompt, /actual words versus/);
  const omitted = fixture(input => Object.fromEntries(input.responseSchema.required.map(key => [key, {
    text: "", event_ids: [], source_note: "", omission_reason: "This interval repeats the same reaction."
  }])));
  await assert.rejects(new Writer().generate({ ...request, ...omitted }), /nhịp kể|lời kể/i);
  assert.equal(omitted.calls.length, 2, "do not retry reasoned omissions to force padding");
});

test("unknown event IDs, missing passages and ungrounded text fail before audio; cancellation keeps completed sections reusable", async () => {
  const writer = new Writer(), section = writer.sections({ ...request, targetDurationSec: options.targetDurationSec })[0];
  assert.throws(() => writer.compile({}, section), /tham chiếu nguồn/);
  const bad = Object.fromEntries(Object.keys(writer.schema(section).properties).map(key => [key, {
    text: "An unsupported action.", event_ids: ["invented"], source_note: "Alleged evidence."
  }]));
  assert.throws(() => writer.compile(bad, section), /tham chiếu nguồn/);
  const controller = new AbortController(), f = fixture();
  await assert.rejects(writer.generate({ ...request, ...f, signal: controller.signal,
    onSection: async (key, raw) => { f.cache[key] = raw; controller.abort(); } }), { name: "AbortError" });
  assert.equal(f.calls.length, 1); assert.equal(Object.keys(f.cache).length, 1);
  await writer.generate({ ...request, ...f });
  assert.equal(f.calls.length, 4, "reuse written chapter one, then align it and write/align chapter two");
});

test("source allocation uses explicit event and passage IDs and rejects ambiguous numeric or missing placements", async () => {
  const writer = new Writer(), section = writer.sections({ ...request, targetDurationSec: 300 })[0];
  const result = { passages: [{ key: "passage_1", text: "She makes a supported choice.", source_note: "Visible choice." }] };
  for (const placement of [1, "invented", undefined]) {
    const ai = { getAnalysisModel: () => "analysis", runVertexCall: async input => {
      assert.ok(input.responseSchema.properties.placements.items.properties.event_id.enum.includes("e0"));
      assert.match(input.prompt, /passage_1/);
      return { placements: section.events.map(e => ({ event_id: e.id, passage_id: placement })) };
    } };
    await assert.rejects(writer.alignSource({ ai, section, result, filePath: "source.mp4", wordsPerSecond: 3 }), /phân bổ/);
  }
  const ai = { getAnalysisModel: () => "analysis", runVertexCall: async () => ({ placements:
    section.events.map(e => ({ event_id: e.id, passage_id: "omit" })) }) };
  const omitted = await writer.alignSource({ ai, section, result, filePath: "source.mp4", wordsPerSecond: 3 });
  assert.equal(omitted.passage_1.text, ""); assert.equal(omitted.passage_1.rejected_text, result.passages[0].text);
  assert.deepEqual(omitted.passage_1.event_ids, [], "never substitute nearby unrelated footage for unsupported narration");
});

test("a dense 132-event chapter uses a constant-shape schema and requires every ID exactly once", async () => {
  const writer = new Writer(), dense = Array.from({ length: 132 }, (_, i) => ({ id: `chunk_6_scene_event_${i + 1}`,
    source_start: 1188.5 + i, source_end: 1189.5 + i, description: `Source action ${i}` }));
  const section = { index: 5, sourceStartSec: 1188.5, sourceEndSec: 1428.375, events: dense };
  const result = { passages: [{ key: "passage_1", text: "She decides to protect him.", source_note: "Observed decision." },
    { key: "passage_2", text: "They leave together.", source_note: "Observed departure." }] };
  const complete = dense.map((e, i) => ({ event_id: e.id, passage_id: i % 3 ? "passage_1" : "omit" }));
  let records = [...complete].reverse(), calls = 0;
  const ai = { getAnalysisModel: () => "analysis", runVertexCall: async input => {
    calls++;
    assert.equal(input.responseSchema.properties.placements.type, "array");
    assert.deepEqual(input.responseSchema.properties.placements.items.required, ["event_id", "passage_id"]);
    assert.equal(Object.keys(input.responseSchema.properties.placements.items.properties).length, 2);
    assert.equal(input.responseSchema.properties.placements.items.properties.event_id.enum.length, 132);
    const raw = { placements: records }; input.validateResult(raw); return raw;
  } };
  const run = () => writer.alignSource({ ai, section, result, filePath: "chapter-6.mp4", wordsPerSecond: 3.4 });
  const aligned = await run(); assert.equal(calls, 1);
  assert.deepEqual(aligned.passage_1.event_ids, complete.filter(item => item.passage_id === "passage_1").map(item => item.event_id));
  assert.equal(aligned.passage_2.text, "");
  for (const malformed of [complete.slice(1), [...complete, complete[0]],
    complete.map((item, i) => i === 1 ? complete[0] : item),
    complete.map((item, i) => i === 1 ? { ...item, event_id: "unknown" } : item),
    complete.map((item, i) => i === 1 ? { ...item, passage_id: "invented" } : item)]) {
    records = malformed; await assert.rejects(run(), { kind: "invalid_json" });
  }
});

test("failure aligning chapter six resumes its saved narration and never rewrites the first five chapters", async () => {
  const writer = new Writer(), cache = {}, calls = [], sections = Array.from({ length: 7 }, (_, i) => ({
    chunkIndex: i + 1, sourceStartSec: i * 40, sourceEndSec: (i + 1) * 40, durationSec: 40
  }));
  const evidence = Array.from({ length: 28 }, (_, i) => ({ id: `e${i}`, source_start: i * 10, source_end: (i + 1) * 10, description: "Observed action." }));
  let failing = true;
  const ai = { getAnalysisModel: () => "analysis", getQualityModel: () => "quality", runVertexCall: async input => {
    const chapter = Number(input.filePaths[0].match(/chunk-(\d+)/)[1]), alignment = Boolean(input.responseSchema.properties.placements);
    calls.push([chapter, alignment ? "align" : "write"]);
    if (alignment) {
      if (chapter === 6 && failing) throw Object.assign(new Error("Vertex 400 invalid argument"), { httpStatus: 400 });
      return { placements: input.responseSchema.properties.placements.items.properties.event_id.enum.map(event_id => ({ event_id, passage_id: "passage_1" })) };
    }
    return Object.fromEntries(input.responseSchema.required.map(key => [key, { text: Array(45).fill("supported").join(" "),
      source_note: "Observed dialogue.", event_ids: [`e${(chapter - 1) * 4}`] }]));
  } };
  const input = { ...request, chunks: sections, events: evidence, wordsPerSecond: 1.5, cache, ai,
    media: { extractProxyChunk: async ({ chunk }) => `chunk-${chunk.chunkIndex}.mp4` }, onSection: async (key, raw) => { cache[key] = structuredClone(raw); } };
  await assert.rejects(writer.generate(input), { httpStatus: 400 });
  assert.equal(Object.values(cache).filter(raw => raw.__aligned === 2).length, 5);
  assert.equal(Object.keys(cache).length, 6);
  const completed = JSON.stringify(Object.fromEntries(Object.entries(cache).filter(([, raw]) => raw.__aligned === 2)));
  calls.length = 0; failing = false;
  await new Writer().generate(input);
  assert.deepEqual(calls, [[6, "align"], [7, "write"], [7, "align"]]);
  assert.ok(Object.values(cache).every(raw => raw.__aligned === 2));
  for (const [key, raw] of Object.entries(JSON.parse(completed))) assert.deepEqual(cache[key], raw);
});
