const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const Alignment = require("../electron/services/recap/recapClauseAlignmentService");
test("Kabuto checkpoint regression: verified Jiraiya action cannot borrow the preceding Orochimaru shot", () => {
  const event = { id: "hair_attack", anchorMethod: "scene_frames", source_start: 243.512, source_end: 245.625 };
  const solution = new RecapSyncSolver().solve({ speechUnits: [{ id: "speech_0009", text: "Jiraiya attacks Kabuto.",
    visual_event_ids: [event.id] }], visualEvents: [event], scenes: [{ startSec: 241.5, endSec: 245.625 }],
    audioTracks: { speech_0009: { durationSec: 2.88 } }, sourceDurationSec: 829.408 });
  assert.equal(solution.decisions[0].clips[0].source_start, 243.512);
  assert.ok(solution.decisions[0].clips[0].source_end <= 245.625);
});
test("an exhausted grounded event requests repair instead of borrowing another clause's footage", () => {
  const events = [{ id: "used", anchorMethod: "scene_frames", source_start: 10, source_end: 12 },
    { id: "other", anchorMethod: "scene_frames", source_start: 20, source_end: 30 }];
  const solution = new RecapSyncSolver({ allowShotReuse: false }).solve({
    speechUnits: [{ id: "one", text: "First action.", visual_event_ids: ["used"] },
      { id: "two", text: "Repeated action. Another action.", visual_event_ids: ["used", "other"] }], visualEvents: events,
    scenes: [{ startSec: 0, endSec: 40 }], sourceDurationSec: 40,
    audioTracks: { one: { durationSec: 3 }, two: { durationSec: 4, clauseSpans: [
      { startSec: 0, endSec: 2, text: "Repeated action.", visual_event_ids: ["used"], clauseIds: ["a"] },
      { startSec: 2, endSec: 4, text: "Another action.", visual_event_ids: ["other"], clauseIds: ["b"] }] } } });
  for (const clip of solution.decisions.flatMap(decision => decision.clips)) {
    const event = events.find(item => item.id === clip.event_id);
    assert.ok(clip.source_start >= event.source_start && clip.source_end <= event.source_end);
  }
});
const { RecapSyncSolver } = require("../electron/services/recap/recapSyncSolver");

test("overlapping chapter IDs already shown in the same clause do not create a false missing shot or a blank slot", () => {
  const events = [{ id: "parent", source_start: 10, source_end: 12, anchorMethod: "scene_frames" },
    { id: "nested", source_start: 10.5, source_end: 12, anchorMethod: "scene_frames" },
    { id: "next", source_start: 20, source_end: 22, anchorMethod: "scene_frames" }];
  const unit = { id: "body", text: "She decides to leave and then walks out.", visual_event_ids: events.map(e => e.id) };
  const solve = seconds => new RecapSyncSolver({ allowShotReuse: false }).solve({ speechUnits: [unit], visualEvents: events,
    audioTracks: { body: { durationSec: seconds } }, sourceDurationSec: 30 });
  const result = solve(5.1), budget = result.clauseBudgets[0], clips = result.decisions[0].clips;
  assert.deepEqual(budget.missingEventIds, []);
  assert.deepEqual(budget.coveredReferences, [{ eventId: "nested", coveredByEventId: "parent" }]);
  assert.equal(clips.length, 2, "the same source pixels are rendered once");
  assert.equal(clips[0].output_end, clips[1].output_start, "an alias must not reserve a blank output slot");
  assert.ok(Math.abs(clips.reduce((n, clip) => n + clip.output_end - clip.output_start, 0) - result.metrics.totalTimelineDurationSec) < .001);
  assert.ok(budget.holdSec >= 1.49, "coverage aliases add no footage or hold allowance");
  assert.equal(solve(8).clauseBudgets[0].passed, false, "a genuinely long clause still needs repair");
  const acrossUnits = new RecapSyncSolver({ allowShotReuse: false }).solve({ visualEvents: events, sourceDurationSec: 30,
    speechUnits: [{ id: "first", text: "She decides.", visual_event_ids: ["parent"] },
      { id: "later", text: "She repeats it.", visual_event_ids: ["nested"] }],
    audioTracks: { first: { durationSec: 3 }, later: { durationSec: 1 } } });
  assert.ok(acrossUnits.clauseBudgets.find(group => group.speechUnitId === "later").missingEventIds.includes("nested"),
    "a reference seen under earlier speech cannot support a later clause");
});
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
