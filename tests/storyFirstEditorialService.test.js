"use strict";

const assert = require("assert");
const {
  makeStoryIntelligence,
  makeNarrativeBlueprint,
  evaluateEditorialScript,
  buildPhaseBEditorialGuidance,
  buildEditorialRepairPrompt
} = require("../electron/services/storyFirstEditorialService");
const Stage1 = require("../electron/services/manualAntigravityStage1Service");

const series = Stage1.detectSeriesProfile("- prompt_profile: viral_tiktok_crime_part1");
const understanding = {
  caseSummary: "Officers investigate a traffic accident.",
  centralConflict: "The driver's account conflicts with evidence found in the car.",
  centralViewerQuestion: "Why did the driver's account change?",
  videoDurationSec: 90,
  characters: [{ id: "driver", nameOrRole: "Driver" }],
  hookCandidates: [{ eventId: "e1", sourceStartSec: 3, sourceEndSec: 7, why: "Audible confrontation" }],
  storyTimeline: [
    { eventId: "e1", eventType: "confrontation", sourceStartSec: 3, sourceEndSec: 7, summary: "Officer confronts the driver", visualFacts: ["Officer standing by car"] },
    { eventId: "e2", eventType: "evidence", sourceStartSec: 17, sourceEndSec: 22, summary: "Officer finds evidence", dialogueFacts: [{ sourceSec: 19, speaker: "Officer", quote: "What's this?" }] },
    { eventId: "e3", eventType: "interrogation", sourceStartSec: 37, sourceEndSec: 41, summary: "Driver contradicts earlier statement" },
    { eventId: "e4", eventType: "arrest", sourceStartSec: 80, sourceEndSec: 86, summary: "Driver taken into custody" }
  ]
};
const plan = {
  centralViewerQuestion: understanding.centralViewerQuestion,
  hookPromise: "The driver's story is not adding up.",
  parts: [
    { scriptId: 1, partNumber: 1, hookRange: { sourceStartSec: 3, sourceEndSec: 7 }, sceneAllocation: [{ sourceStartSec: 0, sourceEndSec: 30 }], cliffhanger: "Unidentified evidence is uncovered", cliffhangerRange: { sourceStartSec: 26, sourceEndSec: 29 } },
    { scriptId: 3, partNumber: 2, hookRange: { sourceStartSec: 32, sourceEndSec: 35 }, sceneAllocation: [{ sourceStartSec: 30, sourceEndSec: 60 }], cliffhanger: "Driver changes their explanation", cliffhangerRange: { sourceStartSec: 56, sourceEndSec: 59 } },
    { scriptId: 4, partNumber: 3, hookRange: { sourceStartSec: 62, sourceEndSec: 65 }, sceneAllocation: [{ sourceStartSec: 60, sourceEndSec: 90 }], payoff: "Driver taken into custody", payoffRanges: [{ sourceStartSec: 80, sourceEndSec: 86 }] }
  ]
};
const intel = makeStoryIntelligence(understanding, { sourceDurationSec: 90, hookContract: { anchorRange: { startSec: 3, endSec: 7 } } });
assert.strictEqual(intel.events.length, 4);
assert.strictEqual(intel.events[1].dialogueFacts[0].quote, "What's this?");
assert.strictEqual(intel.events[1].verifiedFrom, "source_understanding");
assert.deepStrictEqual(intel.selectedHookRange, { sourceStartSec: 3, sourceEndSec: 7 });
const blueprint = makeNarrativeBlueprint(intel, { series, seriesPlan: plan });
assert.strictEqual(blueprint.seriesParts.length, 3);
assert.strictEqual(blueprint.seriesParts[0].plannedEvents.length, 2);
assert.strictEqual(blueprint.seriesParts[2].endingType, "payoff");
assert(blueprint.seriesParts[0].narratorInstructions.handoff.includes("original dialogue"));

function segment(start, end, mode, voice = "", extra = {}) {
  return { sceneId: "scene_0001", sourceStartSec: start, sourceEndSec: end, audio_mode: mode, voiceover_text: voice, ...extra };
}
const validScript = {
  scriptId: 1,
  segments: [
    segment(3, 7, "original_audio"),
    segment(10, 13, "voiceover_only", "But officers had received a report about this driver earlier."),
    segment(17, 22, "original_audio"),
    segment(23, 26, "voiceover_only", "Before calling for backup, the officer questioned that explanation."),
    segment(26, 29, "original_audio")
  ]
};
let report = evaluateEditorialScript(validScript, blueprint);
assert.strictEqual(report.passed, true, JSON.stringify(report));
assert.strictEqual(report.metrics.narrationBeats, 2);
assert.strictEqual(report.metrics.originalAudioBeats, 3);
assert(report.score >= 80);

const wrongHook = JSON.parse(JSON.stringify(validScript));
wrongHook.segments[0].sourceStartSec = 15;
wrongHook.segments[0].sourceEndSec = 16;
report = evaluateEditorialScript(wrongHook, blueprint);
assert(report.errors.some((x) => x.code === "hook_misaligned"), JSON.stringify(report));

// Weak synthetic narration that only describes obvious visible action must
// never be promoted to a "narrator-directed" V1 merely because text exists.
const descriptive = JSON.parse(JSON.stringify(validScript));
descriptive.segments[1].voiceover_text = "The officer walks up to the car.";
descriptive.segments[3].voiceover_text = "The officer looks at the driver.";
report = evaluateEditorialScript(descriptive, blueprint);
assert(report.errors.filter((x) => x.code === "descriptive_voice").length === 2);

const repeated = JSON.parse(JSON.stringify(validScript));
repeated.segments[3].voiceover_text = repeated.segments[1].voiceover_text;
report = evaluateEditorialScript(repeated, blueprint);
assert(report.errors.some((x) => x.code === "repeated_narration"));

const noNarrator = { scriptId: 1, segments: [segment(3, 7, "original_audio"), segment(18, 22, "original_audio")] };
report = evaluateEditorialScript(noNarrator, blueprint);
assert(report.errors.some((x) => x.code === "narrator_not_directing"));

const genericCta = JSON.parse(JSON.stringify(validScript));
genericCta.segments[3].voiceover_text = "What happens next? Follow for Part 2!";
report = evaluateEditorialScript(genericCta, blueprint);
assert(report.errors.some((x) => x.code === "generic_clickbait"));

const flashback = JSON.parse(JSON.stringify(validScript));
flashback.segments = [
  segment(23, 26, "original_audio"),
  segment(3, 7, "voiceover_only", "The officer approaches the car."),
  segment(8, 12, "original_audio"),
  segment(15, 19, "voiceover_only", "But officers found a new detail."),
  segment(25, 27, "original_audio")
];
report = evaluateEditorialScript(flashback, blueprint);
assert(report.errors.some((x) => x.code === "unbridged_flashback"), JSON.stringify(report));
flashback.segments[1].voiceover_text = "Twenty minutes earlier, officers had arrived at the crash scene.";
report = evaluateEditorialScript(flashback, blueprint);
assert(!report.errors.some((x) => x.code === "unbridged_flashback"), JSON.stringify(report));

const ungroundedRange = JSON.parse(JSON.stringify(validScript));
ungroundedRange.segments[2].sourceStartSec = 70;
ungroundedRange.segments[2].sourceEndSec = 73;
report = evaluateEditorialScript(ungroundedRange, blueprint);
assert(report.errors.some((x) => x.code === "outside_series_plan"));

const briefing = buildPhaseBEditorialGuidance({ intelligencePath: "C:/temp/story-intelligence.json", blueprintPath: "C:/temp/narrative-blueprint.json" });
assert(briefing.includes("STORY-FIRST EDITORIAL DIRECTIVE"));
assert(briefing.includes("At least two purposeful narrator beats"));
const repair = buildEditorialRepairPrompt({
  previousFiles: ["C:/tmp/script-1-before-editorial-repair.json"],
  reportPath: "C:/tmp/editorial-quality-report.json",
  blueprintPath: "C:/tmp/narrative-blueprint.json", intelligencePath: "C:/tmp/story-intelligence.json",
  scriptIds: [1, 3, 4]
});
assert(repair.includes("Phase B (Script Generation)"));
assert(repair.includes("Fix EVERY hard error"));
console.log("story-first editorial engine unit tests passed");
