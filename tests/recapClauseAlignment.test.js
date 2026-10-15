const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const Alignment = require("../electron/services/recap/recapClauseAlignmentService");
const { RecapSyncSolver } = require("../electron/services/recap/recapSyncSolver");
const unit = { id: "walkway", text: "Marge is trapped. A coworker explains the NDA.", visual_event_ids: ["trap", "nda"], clauses: [
  { clause_id: "trap_words", text: "Marge is trapped.", visual_event_ids: ["trap"] },
  { clause_id: "nda_words", text: "A coworker explains the NDA.", visual_event_ids: ["nda"] }
] };
const groups = [ { startSec: 0, endSec: 9, text: "Marge is trapped.", visual_event_ids: ["trap"], clauseIds: ["trap_words"] },
  { startSec: 10, endSec: 14, text: "A coworker explains the NDA.", visual_event_ids: ["nda"], clauseIds: ["nda_words"] } ];
test("unreliable batched ASR retries independent beam decoding without accepting an estimated clock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-clauses-retry-"));
  try {
    const audioPath = path.join(root, "audio.wav"), wordPath = path.join(root, "words.json");
    await fs.writeFile(audioPath, "fixture audio");
    const configurations = [];
    const service = new Alignment({}, { subtitleFactory: settings => ({ transcribeToSrt: async () => {
      configurations.push(settings);
      const words = configurations.length === 1 ? [{ word: "hallucination", start: 0, end: 1 }]
        : unit.text.split(/\s+/).map((word, i) => ({ word, start: i, end: i + .8 }));
      await fs.writeFile(wordPath, JSON.stringify({ segments: [{ words }] }));
      return { wordTimestampsPath: wordPath };
    } }) });
    const audioTracks = { walkway: { audioPath, durationSec: 14 } };
    await service.prepare({ speechUnits: [unit], audioTracks, directory: root });
    assert.equal(configurations.length, 2);
    assert.equal(configurations[1].whisperBatchSize, 1);
    assert.equal(configurations[1].whisperBeamSize, 5);
    assert.equal(audioTracks.walkway.clauseSpans[1].startSec, 3);
    assert.equal(await fs.readFile(audioPath, "utf8"), "fixture audio");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("visual switch follows the spoken NDA boundary rather than source clip duration", () => {
  const result = new RecapSyncSolver({ allowShotReuse: false }).solve({ speechUnits: [unit], visualEvents: [
    { id: "trap", source_start: 400, source_end: 460 }, { id: "nda", source_start: 470, source_end: 480 }
  ], audioTracks: { walkway: { audioPath: "fixture.wav", durationSec: 14, clauseSpans: groups } } });
  const decision = result.decisions[0];
  assert.equal(decision.clips[0].output_end, 10); assert.equal(decision.clips[1].output_start, 10);
  assert.equal(decision.clips[1].event_id, "nda"); assert.equal(decision.voice_tempo, 1);
  assert.equal(result.metrics.semanticTimingMismatchCount, 0);
});
test("too little grounded footage requests clause repair instead of rendering a long frozen shot", () => {
  const result = new RecapSyncSolver().solve({ speechUnits: [unit], visualEvents: [
    { id: "trap", source_start: 400, source_end: 406 }, { id: "nda", source_start: 470, source_end: 477 }
  ], audioTracks: { walkway: { durationSec: 14, clauseSpans: groups } } });
  assert.equal(result.metrics.semanticTimingMismatchCount, 1);
  const budget = result.rewriteRecommendations[0].clauseBudgets[0];
  assert.equal(budget.passed, false); assert.deepEqual(budget.clauseIds, ["trap_words"]); assert.ok(budget.targetDuration < 10);
});
test("later clauses sharing an event retain unused source footage instead of a false missing-event blocker", () => {
  const spans = [...groups, { startSec: 11, endSec: 12, text: "Still trapped.", visual_event_ids: ["trap"], clauseIds: ["ending"] }];
  spans[1] = { ...spans[1], startSec: 9, endSec: 10 };
  const result = new RecapSyncSolver().solve({ speechUnits: [unit], visualEvents: [
    { id: "trap", source_start: 400, source_end: 407.1 }, { id: "nda", source_start: 470, source_end: 477 }
  ], audioTracks: { walkway: { durationSec: 12, clauseSpans: spans } } });
  assert.equal(result.metrics.semanticTimingMismatchCount, 0);
  const trap = result.decisions[0].clips.filter(clip => clip.event_id === "trap");
  assert.equal(trap.length, 2); assert.ok(trap[0].source_end <= trap[1].source_start);
});
test("clause alignment preserves spoken audio, uses recognized words and caches unchanged results", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-clauses-"));
  try {
    const audioPath = path.join(root, "audio.wav"), wordPath = path.join(root, "words.json");
    await fs.writeFile(audioPath, "fixture audio");
    await fs.writeFile(wordPath, JSON.stringify({ segments: [{ words: unit.text.split(/\s+/).map((word, i) => ({ word,
      start: i < 3 ? i * 3 : 10 + (i - 3) * .8, end: i < 3 ? i * 3 + 1 : 10.5 + (i - 3) * .8 })) }] }));
    let calls = 0;
    const service = new Alignment({}, { subtitleFactory: () => ({ transcribeToSrt: async () => { calls++; return { wordTimestampsPath: wordPath }; } }) });
    const audioTracks = { walkway: { audioPath, durationSec: 14 } };
    const request = { speechUnits: [unit], audioTracks, directory: root };
    await service.prepare(request); await service.prepare(request);
    assert.equal(calls, 1); assert.equal(audioTracks.walkway.clauseSpans[1].startSec, 10);
    assert.equal(await fs.readFile(audioPath, "utf8"), "fixture audio");
    const cache = (await fs.readdir(root)).find(name => /^[a-f0-9]+\.json$/.test(name));
    await fs.writeFile(path.join(root, cache), "{}");
    await service.prepare(request);
    assert.equal(calls, 2, "malformed alignment cache must be rebuilt before solving");
    await assert.rejects(service.prepare({ ...request, speechUnits: [{ ...unit, text: "Different actual speech." }] }), /không khớp lời đọc/);
    await assert.rejects(service.prepare({ ...request, audioTracks: {} }), /Thiếu audio TTS/);
    await service.prepare({ ...request, speechUnits: [{ ...unit, clauses: [{ text: unit.text, visual_event_ids: ["trap"] }] }] });
    assert.equal(audioTracks.walkway.clauseSpans, undefined, "single-group narration cannot retain obsolete visual boundaries");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
