"use strict";

const assert = require("assert");
const Stage1 = require("../electron/services/manualAntigravityStage1Service");
const { injectHookContractToPrompt, buildHookContract } = require("../electron/services/hookContractService");
const { buildSeriesPlan } = require("./helpers/fakeAntigravity");

const series = Stage1.detectSeriesProfile("### SELECTED PROMPT PROFILE\n- prompt_profile: viral_tiktok_crime_part1\n");
assert(series, "crime_part1 is a series profile");
assert.deepStrictEqual(series.parts.map((part) => [part.scriptId, part.partNumber, part.partBadge]), [[1, 1, "PART 1"], [3, 2, "PART 2"], [4, 3, "PART 3"]]);
assert.strictEqual(Stage1.detectSeriesProfile("- prompt_profile: independent"), null);

const valid = buildSeriesPlan(90);
assert.deepStrictEqual(Stage1.validateSeriesPlan(valid, { series, videoDurationSec: 90 }).errors, []);

// A provisional auto hook may be improved after AI understands the full story;
// a genuinely user-locked hook may not be silently swapped by Series Planner.
const lockedHook = { isUserLocked: true, anchorRange: { startSec: 15, endSec: 22 }, trimmingTolerance: { startOffsetMaxSec: 2, endOffsetMaxSec: 3 } };
assert(Stage1.validateSeriesPlan(valid, { series, videoDurationSec: 90, hookContract: lockedHook }).errors.some((x) => x.includes("user khóa")));
assert.deepStrictEqual(Stage1.validateSeriesPlan(valid, { series, videoDurationSec: 90, hookContract: { ...lockedHook, isUserLocked: false } }).errors, []);

// Duplicate footage between Parts (not declared as shared) is rejected.
const duplicate = JSON.parse(JSON.stringify(valid));
duplicate.parts[1].sceneAllocation.push({ sourceStartSec: 5, sourceEndSec: 25, purpose: "reuse" });
assert(Stage1.validateSeriesPlan(duplicate, { series, videoDurationSec: 90 }).errors.some((error) => error.includes("trùng")));
// ...unless declared as a shared recap range.
duplicate.sharedRanges = [{ sourceStartSec: 5, sourceEndSec: 25, reason: "previously on" }];
assert.deepStrictEqual(Stage1.validateSeriesPlan(duplicate, { series, videoDurationSec: 90 }).errors, []);

// Spoiler: Part 1 may not contain Part 3's payoff.
const spoiler = JSON.parse(JSON.stringify(valid));
spoiler.parts[0].sceneAllocation.push({ sourceStartSec: 87, sourceEndSec: 90, purpose: "arrest teaser" });
spoiler.sharedRanges = [{ sourceStartSec: 87, sourceEndSec: 90 }];
assert(Stage1.validateSeriesPlan(spoiler, { series, videoDurationSec: 90 }).errors.some((error) => error.includes("spoiler")));

// Missing cliffhanger / payoff / question are rejected.
const incomplete = JSON.parse(JSON.stringify(valid));
delete incomplete.parts[0].cliffhanger;
delete incomplete.parts[2].payoffRanges;
incomplete.centralViewerQuestion = "";
const incompleteErrors = Stage1.validateSeriesPlan(incomplete, { series, videoDurationSec: 90 }).errors;
assert(incompleteErrors.some((error) => error.includes("cliffhanger")));
assert(incompleteErrors.some((error) => error.includes("payoffRanges")));
assert(incompleteErrors.some((error) => error.includes("centralViewerQuestion")));

// Post-generation adherence: a Part 2 script built from Part 1 footage is flagged.
const adherence = Stage1.evaluateScriptsAgainstSeriesPlan([
  { scriptId: 1, segments: [{ sourceStartSec: 2, sourceEndSec: 20 }] },
  { scriptId: 3, segments: [{ sourceStartSec: 2, sourceEndSec: 20 }] }
], valid);
assert.strictEqual(adherence.report.find((item) => item.scriptId === 1).adherence, 1);
assert(adherence.warnings.some((warning) => warning.includes("Script 3")));

// Hook contract: series profiles never get the "3 different stories" matrix.
const candidate = { hookId: "h1", title: "Door standoff", sourceStartSec: 3, sourceEndSec: 12 };
const contract = buildHookContract({
  variants: {
    variant_01: { scriptId: 1, candidate, storyAngle: "part_1_confrontation" },
    variant_02: { scriptId: 3, candidate, storyAngle: "part_2_interrogation" },
    variant_03: { scriptId: 4, candidate, storyAngle: "part_3_verdict_arrest" }
  }
});
const seriesPrompt = injectHookContractToPrompt("- prompt_profile: viral_tiktok_crime_part1\nDIRECT HIGHLIGHT CONTENT RULES:\n- Watch the complete video input", contract);
assert(seriesPrompt.includes("SERIES HOOK CONTRACT"));
assert(!seriesPrompt.includes("3-VARIANT NARRATIVE DIFFERENTIATION MATRIX"));
assert(!seriesPrompt.includes("DUPLICATE HOOK DIVERGENCE"));
assert(!/96 mph|rim grinding/.test(seriesPrompt), "no story-specific car-chase directives");
assert.strictEqual((seriesPrompt.match(/opener anchor/g) || []).length, 0, "identical hooks are not reused as Part 2/3 openers");
// Independent (non-series) prompts keep the legacy behaviour.
const independentPrompt = injectHookContractToPrompt("- prompt_profile: independent\nDIRECT HIGHLIGHT CONTENT RULES:\n", buildHookContract({ candidate }));
assert(independentPrompt.includes("3-VARIANT NARRATIVE DIFFERENTIATION MATRIX"));

console.log("seriesPlan tests passed");
