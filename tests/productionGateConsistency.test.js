"use strict";

// Regression for the real run of 2026-10-09 (source-frw3ogqg7-8, 3 Parts):
// [EDITORIAL_GATE] blocked Part 1/4 with production_preflight_failed.
// Root causes fixed here:
//  1. story_blueprint written by Story-First (primaryQuestion/plannedEvents)
//     was not recognised by the preflight (only macroBlocks): -10/-15 points
//     on EVERY Part, which alone failed V1.
//  2. "far source jump" counted any gap > 0.35s (1s micro-cuts included).
//  3. Writer/repair prompts used soft or different numbers than the gate.
//  4. Nothing checked voiceover length vs footage before render.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const Preflight = require("../electron/services/manualGeminiViralPreflightService");
const DryRun = require("../electron/services/draftRenderDryRun");
const StoryFirst = require("../electron/services/storyFirstEditorialService");
const { normalizeHighlightCutScript } = require("../electron/services/dubbingService");

const FIXTURES = path.join(__dirname, "fixtures", "story-first-gate-2026-10-09");
const VIDEO_SEC = 1148.141;
const WPS = 2.209;
const load = (name, part) => ({
  ...JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")),
  prompt_profile: "viral_tiktok_crime_part1",
  series_mode: "interleaved_multipart",
  part_number: part
});
const score = (script, scriptId, voiceProfile = null) => Preflight.scoreManualGeminiVariant({
  script, normalizedScript: normalizeHighlightCutScript(script, VIDEO_SEC), expectedScriptId: scriptId, voiceProfile
});

// 1. Story-First blueprint is a real blueprint.
for (const [name, id, part] of [["script-1-before-editorial-repair", 1, 1], ["script-4-before-editorial-repair", 4, 3], ["script-1-audience-repaired", 1, 1], ["script-4-audience-repaired", 4, 3], ["script-3-audience-repaired", 3, 2]]) {
  const script = load(name, part);
  assert(Preflight.storyBlueprintPresent(script), `${name}: Story-First story_blueprint is recognised`);
  const result = score(script, id);
  assert(!result.issues.some((issue) => /Thiếu story_blueprint/.test(issue)), `${name}: no false 'missing story_blueprint'`);
  assert(result.passed, `${name}: passes production preflight (score ${result.score}, editorial ${result.scoreBreakdown.editorialReadiness.score})`);
}
assert.strictEqual(Preflight.storyBlueprintPresent({ story_blueprint: {} }), false, "an empty blueprint is still missing");
assert.strictEqual(Preflight.storyBlueprintPresent({ story_blueprint: { macroBlocks: [{ id: "b1" }] } }), true, "legacy macroBlocks still accepted");

// 2. A ~1s skip inside one moment is not a "far jump"; a 30s hop is.
const jumpScript = (gap) => ({
  scriptId: 1, prompt_profile: "viral_tiktok_crime_part1", part_number: 1, story_blueprint: { plannedEvents: [{ id: "e1" }] },
  segments: [
    { sceneId: "scene_0001", sourceStartSec: 100, sourceEndSec: 110, audio_mode: "original_audio" },
    { sceneId: "scene_0002", sourceStartSec: 110 + gap, sourceEndSec: 120 + gap, audio_mode: "original_audio" }
  ]
});
assert.strictEqual(score(jumpScript(1), 1).metrics?.sourceJumpCount ?? score(jumpScript(1), 1).diagnostics?.sourceJumps?.length, 0, "1s gap is contiguous");
assert.strictEqual(score(jumpScript(30), 1).diagnostics.sourceJumps.length, 1, "30s gap is a jump");
assert.strictEqual(Preflight.SOURCE_JUMP_GAP_TOLERANCE_SEC, 2);

// 3. Prompts carry exactly the gate's numbers.
const constraints = Preflight.resolveProductionConstraints(load("script-1-audience-repaired", 1), 1, { wordsPerSecond: WPS });
assert.deepStrictEqual(
  [constraints.minDurationSec, constraints.maxDurationSec, constraints.maxVoiceoverSegmentSec, constraints.maxContinuousAudioRunSec, constraints.maxSourceJumps, constraints.sourceJumpGapToleranceSec, constraints.wordsPerSecond],
  [110, 125, 12, 15, 7, 2, WPS]
);
const lines = Preflight.describeProductionConstraints(constraints).join("\n");
for (const fragment of ["110-125s", "<= 12s", "more than 15s", "at most 7 source jumps", "more than 2s away", `${WPS} words/s`, "10s -> 22 words"]) {
  assert(lines.includes(fragment), `constraint prompt contains '${fragment}'`);
}
const repairPrompt = StoryFirst.buildEditorialRepairPrompt({
  scriptIds: [1], previousFiles: ["a.json"], constraintLines: Preflight.describeProductionConstraints(constraints),
  wordBudgetLines: ["- Segment 17 (7.4s footage): 24 words now, max 16; shorten the line or give it more contiguous footage."]
});
assert(repairPrompt.includes("HOST PRODUCTION GATE") && repairPrompt.includes("at most 7 source jumps") && repairPrompt.includes("Segment 17"));
assert(!repairPrompt.includes("Avoid >7 distant source jumps"), "soft wording replaced by the gate's numbers");
assert(repairPrompt.length < 24000);

// 4. Render dry-run: catches narration longer than its footage, host fix lengthens footage.
const repaired1 = load("script-1-audience-repaired", 1);
const dry = DryRun.dryRunManualDraftRender({ script: repaired1, videoDurationSec: VIDEO_SEC, wordsPerSecond: WPS });
assert(!dry.ok);
assert.deepStrictEqual(dry.issues.filter((item) => item.code === "voice_overflow").map((item) => item.segmentIndexes[0] + 1), [6, 12, 17]);
const fit = DryRun.autoFitVoiceFootage({ script: repaired1, videoDurationSec: VIDEO_SEC, wordsPerSecond: WPS, maxDurationSec: 125 });
assert.strictEqual(fit.adjustments.length, 2, "two overflows are fixed by lengthening unused adjacent footage");
assert(fit.adjustments.every((item) => item.addedSec > 0 && item.addedSec <= 4));
const afterFit = DryRun.dryRunManualDraftRender({ script: fit.script, videoDurationSec: VIDEO_SEC, wordsPerSecond: WPS });
assert.deepStrictEqual(afterFit.issues.map((item) => item.segmentIndexes[0] + 1), [17], "the last line still needs a shorter narration (no free footage within 125s)");
assert(afterFit.normalized.totalDuration <= 125, "host fit never exceeds the Part's max duration");
assert.strictEqual(DryRun.voiceWordBudgets(afterFit).find((item) => item.overBudget).maxWords, 16);
// Words are never changed by the host fix.
fit.script.segments.forEach((segment, index) => assert.strictEqual(segment.voiceover_text, repaired1.segments[index].voiceover_text));
// Allocation guard: footage may not leave the Part's locked ranges.
const locked = DryRun.autoFitVoiceFootage({ script: repaired1, videoDurationSec: VIDEO_SEC, wordsPerSecond: WPS, maxDurationSec: 125, allowedRanges: [[0, 1]] });
assert.strictEqual(locked.adjustments.length, 0);
// Narrated blocks (consecutive voiceovers) use the hard block limit.
const blockScript = {
  scriptId: 1, prompt_profile: "viral_tiktok_crime_part1", part_number: 1,
  segments: [
    { sceneId: "s1", sourceStartSec: 10, sourceEndSec: 15, audio_mode: "voiceover_only", voiceover_text: "one two three four five six seven eight nine ten eleven twelve" },
    { sceneId: "s2", sourceStartSec: 15, sourceEndSec: 20, audio_mode: "voiceover_only", voiceover_text: "one two three four five six seven eight nine ten eleven twelve" }
  ]
};
const blockDry = DryRun.dryRunManualDraftRender({ script: blockScript, videoDurationSec: 100, wordsPerSecond: WPS });
assert.strictEqual(blockDry.issues[0].code, "narrated_block_voice_overflow", "24 words in a 10s narration block overflow");
assert.strictEqual(DryRun.parseMeasuredWordsPerSecond("- measuredWordsPerSecond: 2.209\n"), 2.209);
assert.strictEqual(DryRun.parseMeasuredWordsPerSecond("- measuredWordsPerSecond: NOT_MEASURED"), 0);

console.log("productionGateConsistency tests passed");
