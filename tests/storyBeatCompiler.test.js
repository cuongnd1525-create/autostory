"use strict";

// "AI chooses, host computes": beat plans and edit operations compiled on the
// REAL scene manifest + transcript of the 2026-10-13 source.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Beats = require("../electron/services/storyBeatCompiler");
const Stage1 = require("../electron/services/manualAntigravityStage1Service");
const MapReduce = require("../electron/services/sourceUnderstandingMapReduce");

const FIX = path.join(__dirname, "fixtures", "story-first-structure-2026-10-13");
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8"));
const scenes = load("bwq-scene-manifest.json").scenes;
const cues = Stage1.parseSrtForContext(fs.readFileSync(path.join(FIX, "bwq-source-transcript.srt"), "utf8"));
const plan = load("bwq-series-plan.json");
const part1 = plan.parts.find((part) => part.scriptId === 1);
const byId = new Map(scenes.map((scene) => [scene.sceneId, scene]));
const sceneAt = (sec) => scenes.find((scene) => scene.startSec <= sec && scene.endSec > sec);

// 1. A real V1 script lifts into a beat plan and compiles back 1:1.
{
  const v1 = load("bwq-script-1-v1.json");
  const lifted = Beats.segmentsToBeatPlan(v1, scenes);
  assert.strictEqual(lifted.beats.length, v1.segments.length);
  const compiled = Beats.compileBeatPlan(lifted, { scriptId: 1, scenes, cues, wordsPerSecond: 2.209, part: part1, seriesPlan: plan });
  assert.strictEqual(compiled.script.segments.length, v1.segments.length, "one segment per beat");
  compiled.script.segments.forEach((segment, index) => {
    assert.strictEqual(segment.beatId, lifted.beats[index].beatId);
    assert(Math.abs(segment.sourceStartSec - v1.segments[index].sourceStartSec) <= 2.01, `start ${index}`);
    assert(Math.abs(segment.sourceEndSec - v1.segments[index].sourceEndSec) <= 2.01, `end ${index}`);
  });
  assert.deepStrictEqual(compiled.errors.filter((e) => e.code !== "beat_duplicate_footage"), []);
  assert(compiled.script.story_blueprint.primaryQuestion && Array.isArray(compiled.script.story_blueprint.plannedEvents));
  assert.strictEqual(compiled.script.hostCompile.compiler, "host_beat_compiler_v1");
}

// 2. Host computes ranges from scene ids; consecutive scenes = one beat.
{
  const hook = [sceneAt(355).sceneId, sceneAt(360).sceneId];
  const compiled = Beats.compileBeatPlan({ beats: [
    { beatId: "b1", sceneIds: hook, audio: "original", role: "hook", eventId: "e09" },
    { beatId: "b2", sceneIds: [sceneAt(20).sceneId], audio: "narration", narration: "Fifteen minutes earlier, an orange SUV pulls onto the shoulder.", role: "context" }
  ] }, { scriptId: 1, scenes, cues, wordsPerSecond: 2.209 });
  const [first, second] = compiled.script.segments;
  assert(first.sourceStartSec <= byId.get(hook[0]).startSec + 0.01 && first.sourceEndSec >= byId.get(hook[hook.length - 1]).endSec - 2.01);
  assert.strictEqual(first.audio_mode, "original_audio");
  assert.strictEqual(second.audio_mode, "voiceover_only");
  assert(second.hostWordBudget.maxWords > 0);
  assert.deepStrictEqual(compiled.errors, []);
}

// 3. Speech snapping: an original-audio end inside a spoken cue moves to the cue end.
{
  const cue = cues.find((item) => item.end - item.start > 1.5 && item.start > 100);
  const mid = (cue.start + cue.end) / 2;
  const scene = sceneAt(mid);
  const compiled = Beats.compileBeatPlan({ beats: [{ beatId: "b1", sceneIds: [scene.sceneId], startSec: scene.startSec, endSec: mid, audio: "original" }] }, { scriptId: 1, scenes, cues });
  const segment = compiled.script.segments[0];
  if (cue.end - mid <= 2) assert(Math.abs(segment.sourceEndSec - cue.end) < 0.01 || segment.hostSpeechSnap, "cut moved off the sentence");
  assert(segment.hostSpeechSnap || cue.end - mid > 2);
}

// 4. Compile errors are reported, never guessed.
{
  const compiled = Beats.compileBeatPlan({ beats: [
    { beatId: "b1", sceneIds: ["scene_9999"], audio: "original" },
    { beatId: "b2", sceneIds: [scenes[2].sceneId, scenes[9].sceneId], audio: "original" },
    { beatId: "b3", sceneIds: [scenes[20].sceneId], audio: "narration", narration: "" },
    { beatId: "b4", sceneIds: [scenes[2].sceneId, scenes[3].sceneId, scenes[4].sceneId], audio: "original" }
  ] }, { scriptId: 1, scenes, cues });
  const codes = compiled.errors.map((error) => error.code);
  for (const code of ["beat_unknown_scene", "beat_without_footage", "beat_scenes_not_contiguous", "beat_narration_missing"]) assert(codes.includes(code), code);
}

// 5. Edit operations by beatId.
{
  const base = Beats.normalizeBeatPlan({ scriptId: 3, beats: [
    { beatId: "b1", sceneIds: ["scene_0001"], audio: "original" },
    { beatId: "b2", sceneIds: ["scene_0002"], audio: "narration", narration: "Old line." },
    { beatId: "b3", sceneIds: ["scene_0003"], audio: "original" }
  ] }, 3);
  const edited = Beats.applyBeatEdits(base, { title: "NEW TITLE", edits: [
    { op: "update", beatId: "b2", set: { narration: "New verified line." } },
    { op: "insert_after", beatId: "b1", beat: { sceneIds: ["scene_0004"], audio: "original", role: "bridge" } },
    { op: "insert_after", beatId: "START", beat: { beatId: "b1", sceneIds: ["scene_0005"], audio: "original" } },
    { op: "delete", beatId: "b3" },
    { op: "replace", beatId: "nope", beat: { sceneIds: ["scene_0006"] } },
    { op: "explode", beatId: "b1" }
  ] });
  assert.strictEqual(edited.applied.length, 4);
  assert.strictEqual(edited.rejected.length, 2);
  assert.strictEqual(edited.plan.title, "NEW TITLE");
  assert.deepStrictEqual(edited.plan.beats.map((beat) => beat.sceneIds[0]), ["scene_0005", "scene_0001", "scene_0004", "scene_0002"]);
  assert.strictEqual(new Set(edited.plan.beats.map((beat) => beat.beatId)).size, 4, "inserted beats get unique ids");
  assert.strictEqual(edited.plan.beats[3].narration, "New verified line.");
}

// 6. Scene evidence ledger (map output -> per-scene table).
{
  const task = { chunkId: "chunk-001", sourceStartSec: 0, sourceEndSec: 30, handleSec: 4 };
  const prompt = MapReduce.buildMapPrompt({ task: { ...task, proxy: { absolutePath: "D:\\p.mp4", filename: "p.mp4" }, scenes: [], actions: [], transcript: [] }, contextText: "ctx", sceneLedger: true });
  assert(prompt.includes("sceneEvidence") && prompt.includes("SCENE EVIDENCE LEDGER"));
  const off = MapReduce.buildMapPrompt({ task: { ...task, proxy: { absolutePath: "D:\\p.mp4", filename: "p.mp4" }, scenes: [], actions: [], transcript: [] }, contextText: "ctx" });
  assert(!off.includes("sceneEvidence"));
  const keyTask = { ...task, proxy: { filename: "p.mp4", sizeBytes: 1 }, transcript: [], scenes: [], actions: [] };
  assert.notStrictEqual(MapReduce.computeChunkKey({ task: keyTask, sourceFingerprint: "x", sceneLedger: true }).key,
    MapReduce.computeChunkKey({ task: keyTask, sourceFingerprint: "x" }).key, "ledger maps never reuse old chunk caches");
  const ledger = MapReduce.buildSceneEvidenceLedger([{ task, data: { sceneEvidence: [
    { sceneIds: ["scene_0001", "scene_0002"], sourceStartSec: 0, sourceEndSec: 10, people: ["Officer"], seen: "Officer at the SUV window", action: "asks for license", heard: "Officer: \"License please.\"", evidence: ["license"] },
    { sceneIds: ["scene_0003"], sourceStartSec: 999, sourceEndSec: 1000, seen: "out of range" }
  ] } }], [{ sceneId: "scene_0001", startSec: 0, endSec: 5 }, { sceneId: "scene_0002", startSec: 5, endSec: 10 }, { sceneId: "scene_0003", startSec: 10, endSec: 20 }]);
  assert.strictEqual(ledger.sceneCount, 3);
  assert.strictEqual(ledger.describedSceneCount, 2, "out-of-range rows are dropped");
  assert.strictEqual(ledger.scenes[1].seen, "Officer at the SUV window");
}

// 7. Snapping never fights the import gates (real V1 compile + import 2026-10-13):
//    scene-boundary edges and edges shared by two beats stay put, no >=4s
//    beat drops under 4s, and the Part stays within maxDurationSec.
{
  for (const id of [1, 3, 4]) {
    const v1 = load(`bwq-script-${id}-v1.json`);
    const part = plan.parts.find((item) => item.scriptId === id);
    const compiled = Beats.compileBeatPlan(Beats.segmentsToBeatPlan(v1, scenes), { scriptId: id, scenes, cues, wordsPerSecond: 2.209, part, seriesPlan: plan, maxDurationSec: 125 });
    const segments = compiled.script.segments;
    const edges = new Set(scenes.flatMap((scene) => [scene.startSec, scene.endSec]));
    const nearEdge = (time) => [...edges].some((edge) => Math.abs(edge - time) <= 0.12);
    const total = segments.reduce((sum, segment) => sum + segment.sourceEndSec - segment.sourceStartSec, 0);
    assert(total <= 125 + 1e-6, `script ${id} total ${total}`);
    segments.forEach((segment, index) => {
      const before = v1.segments[index];
      const shared = (time) => v1.segments.some((other, j) => j !== index && (Math.abs(other.sourceEndSec - time) <= 0.05 || Math.abs(other.sourceStartSec - time) <= 0.05));
      if (nearEdge(before.sourceStartSec) || shared(before.sourceStartSec)) assert.strictEqual(segment.sourceStartSec, before.sourceStartSec, `script ${id} seg ${index + 1} start moved`);
      if (nearEdge(before.sourceEndSec) || shared(before.sourceEndSec)) assert.strictEqual(segment.sourceEndSec, before.sourceEndSec, `script ${id} seg ${index + 1} end moved`);
      if (before.sourceEndSec - before.sourceStartSec >= 4) assert(segment.sourceEndSec - segment.sourceStartSec >= 4 - 1e-6, `script ${id} seg ${index + 1} became a micro-cut`);
      // No 0.12-0.5s overrun past a scene edge (the importer would clamp it).
      for (const edge of edges) {
        const over = segment.sourceEndSec - edge;
        const under = edge - segment.sourceStartSec;
        assert(!(segment.sourceStartSec < edge - 0.12 && over > 0.12 && over <= 0.5), `script ${id} seg ${index + 1} end overruns ${edge}`);
        assert(!(segment.sourceEndSec > edge + 0.12 && under > 0.12 && under <= 0.5), `script ${id} seg ${index + 1} start overruns ${edge}`);
      }
    });
    assert(new Set(segments.map((segment) => segment.macroBlockId)).size <= 12, `script ${id} macro-blocks`);
  }
}

console.log("storyBeatCompiler tests passed (lift/compile, scene ranges, speech snap, compile errors, edit ops, scene ledger, import-safe snapping)");
