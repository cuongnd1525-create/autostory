"use strict";

// manual_gemini_draft_review: Gemini returns only sceneId/source range/audio;
// the local code derives duration, output timeline, playbackSpeed and totals.

const assert = require("assert");
const DubbingService = require("../electron/services/dubbingService");
const { validateManualGeminiScript, normalizeHighlightCutScript } = DubbingService;
const ManualGeminiPackService = require("../electron/services/manualGeminiPackService");

const manifest = {
  videoDurationSec: 120,
  scenes: [
    { sceneId: "scene_0001", startSec: 0, endSec: 40 },
    { sceneId: "scene_0002", startSec: 40, endSec: 120 }
  ]
};

function script(segments) {
  return { artifactType: "highlight_cut_script", scriptId: 1, prompt_profile: "viral_tiktok_crime_part1", segments };
}

// Gemini returned stale/wrong output math: 10s of source squeezed into 5s.
const stale = script([
  { sceneId: "scene_0001", sourceStartSec: 10, sourceEndSec: 20, startSec: 0, endSec: 5, audio_mode: "original_audio", voiceover_text: "" },
  { sceneId: "scene_0002", sourceStartSec: 50, sourceEndSec: 62, startSec: 5, endSec: 9, outputStartSec: 5, outputEndSec: 9, audio_mode: "voiceover_only", voiceover_text: "Officers arrive." }
]);
const legacy = normalizeHighlightCutScript(validateManualGeminiScript(JSON.parse(JSON.stringify(stale)), manifest, "script-1.json", null, {}), 120);
assert.strictEqual(legacy.segments[0].playbackSpeed, 2, "documents the legacy behaviour: Gemini output math changes speed");

const derived = normalizeHighlightCutScript(
  validateManualGeminiScript(JSON.parse(JSON.stringify(stale)), manifest, "script-1.json", null, { deriveOutputTimeline: true }),
  120
);
assert.deepStrictEqual(derived.segments.map((segment) => [segment.startSec, segment.endSec, segment.playbackSpeed]), [
  [0, 10, 1],
  [10, 22, 1]
], "draft-review import derives the timeline locally from source ranges only");

// Minimal Gemini contract: sceneId + source range + audio fields only.
const minimal = normalizeHighlightCutScript(validateManualGeminiScript(script([
  { sceneId: "scene_0001", sourceStartSec: 123 - 120, sourceEndSec: 16.7, audio_mode: "original_audio", voiceover_text: "" },
  { sceneId: "scene_0002", sourceStartSec: 41, sourceEndSec: 45, audio_mode: "voiceover_only", voiceover_text: "Then it escalates." }
]), manifest, "script-1.json", null, { deriveOutputTimeline: true }), 120);
assert.strictEqual(minimal.segments[0].startSec, 0);
assert.strictEqual(Number(minimal.segments[0].endSec.toFixed(3)), 13.7);
assert.strictEqual(Number(minimal.segments[1].startSec.toFixed(3)), 13.7, "output timeline is continuous");
assert.strictEqual(Number(minimal.segments[1].endSec.toFixed(3)), 17.7);

// An explicit, justified playbackSpeed is still honoured.
const sped = normalizeHighlightCutScript(validateManualGeminiScript(script([
  { sceneId: "scene_0001", sourceStartSec: 0, sourceEndSec: 6, playbackSpeed: 1.5, startSec: 0, endSec: 99, audio_mode: "original_audio", voiceover_text: "" }
]), manifest, "script-1.json", null, { deriveOutputTimeline: true }), 120);
assert.strictEqual(sped.segments[0].endSec, 4);

// Prompts no longer ask Gemini for output math.
const direct = ManualGeminiPackService.buildDirectHighlightScriptsPrompt("- prompt_profile: viral_tiktok_crime_part1\nTest", manifest, { candidates: [] }, null);
assert(!direct.includes("startSec/endSec are the separate contiguous output timeline"), "direct prompt must not request an output timeline");
const normalizedManifest = ManualGeminiPackService.normalizeManifest({ media: { duration: 120 }, sourceVideoPath: "x.mp4", scenes: manifest.scenes, detector: "test" });
assert(!/must separately provide contiguous output/.test(normalizedManifest.instructions.outputTimeline));

console.log("manualTimelineDerivation tests passed");
