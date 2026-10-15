"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {validateManualGeminiEditorialContract, auditSerializedVariants} = require("../electron/services/manualGeminiEditorialGateService");
function sample(overrides = {}, options = {}) {
  return {
    script: {scriptId: 1, prompt_profile: "serialized_genz", series_mode: "interleaved_multipart",
      part_number: 1, shared_hook_enabled: false, story_blueprint: {macroBlocks: []}, ...overrides},
    normalizedScript: {totalDuration: 90, segments: [
      {storyFunction: "hook", audioMode: "original_audio", sourceStartSec: 120, sourceEndSec: 126},
      {storyFunction: "context", audioMode: "voiceover_only", sourceStartSec: 0, sourceEndSec: 84}
    ]},
    promptOptions: {profile: "serialized_genz", sharedHook: false, minDuration: 75, maxDuration: 110, ...options}
  };
}
test("Series Gen Z accepts an in-range Part 1", () => {
  assert.equal(validateManualGeminiEditorialContract(sample()).passed, true);
});
test("Part mismatch, UI Hook mismatch and bad duration are rejected", () => {
  assert.equal(validateManualGeminiEditorialContract(sample({part_number: 2})).passed, false);
  assert.equal(validateManualGeminiEditorialContract(sample({}, {sharedHook: true})).passed, false);
  const invalid = sample(); invalid.normalizedScript.totalDuration = 68;
  assert.match(validateManualGeminiEditorialContract(invalid).errors.join(" "), /outside/);
});
test("user-locked hook anchors are enforced", () => {
  const data = sample();
  data.hookContract = {isUserLocked: true,isMultiVariant: true,variants: {
    variant_01: {anchorRange: {startSec: 350, endSec: 360}, trimmingTolerance: {startOffsetMaxSec: 2,endOffsetMaxSec: 3}}
  }};
  assert.match(validateManualGeminiEditorialContract(data).errors.join(" "), /user-locked Hook/);
  data.hookContract.variants.variant_01.anchorRange = {startSec: 120, endSec: 130};
  assert.equal(validateManualGeminiEditorialContract(data).passed, true);
});
test("part-specific repeated source footage emits a warning", () => {
  const variants = [{scriptId: 1, seriesId: "case1",segments:[{sourceStartSec: 0,sourceEndSec: 20}]},
    {scriptId: 3, seriesId: "case1",segments:[{sourceStartSec: 10,sourceEndSec: 20}]}];
  assert.match(auditSerializedVariants(variants,{profile:"serialized_genz",sharedHook:false}).join(" "),/reuse 10.0s/);
  assert.equal(auditSerializedVariants(variants,{profile:"serialized_genz",sharedHook:true}).length,0);
});
