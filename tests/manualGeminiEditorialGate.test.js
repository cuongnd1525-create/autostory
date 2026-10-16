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

test("final serialized original_audio cannot end inside a continuing SRT cue", () => {
  const data = sample();
  data.normalizedScript.segments[1] = {storyFunction:"cliffhanger",audioMode:"original_audio",sourceStartSec:80,sourceEndSec:90};
  data.transcriptSrt = ["1","00:01:28,000 --> 00:01:32,000","And the person that did it was...",""].join(String.fromCharCode(10));
  assert.match(validateManualGeminiEditorialContract(data).errors.join(" "), /ends inside an SRT cue/);
  data.normalizedScript.segments[1].sourceEndSec = 92;
  assert.equal(validateManualGeminiEditorialContract(data).passed, true);
});
test("payoffProof must land inside the immediately following authentic footage", () => {
  const data = sample();
  data.script.segments = [{payoffProof:{quote:"She confessed",sourceStartSec:35,sourceEndSec:38}},{}];
  assert.match(validateManualGeminiEditorialContract(data).errors.join(" "), /payoffProof/);
  data.script.segments[0].payoffProof = {quote:"The truth",sourceStartSec:121,sourceEndSec:124};
  // A proof on original_audio itself cannot stand in for a narrated setup.
  assert.match(validateManualGeminiEditorialContract(data).errors.join(" "), /payoffProof/);
  data.normalizedScript.segments = [
    {storyFunction:"hook",audioMode:"original_audio",sourceStartSec:10,sourceEndSec:18},
    {storyFunction:"context",audioMode:"voiceover_only",sourceStartSec:20,sourceEndSec:26},
    {storyFunction:"escalation",audioMode:"original_audio",sourceStartSec:30,sourceEndSec:40}
  ];
  data.script.segments = [{},{payoffProof:{quote:"I took it",sourceStartSec:33,sourceEndSec:36}},{}];
  assert.equal(validateManualGeminiEditorialContract(data).passed, true);
});
test("sustained source beats cannot be interrupted or span a missing scene", () => {
  const data = sample();
  data.normalizedScript.segments = [
    {storyFunction:"hook",audioMode:"original_audio",sourceStartSec:1,sourceEndSec:5,sustainedBeatId:"b"},
    {storyFunction:"hook",audioMode:"original_audio",sourceStartSec:6,sourceEndSec:10,sustainedBeatId:"b"}
  ];
  assert.match(validateManualGeminiEditorialContract(data).errors.join(" "), /source gap/);
  data.normalizedScript.segments[1].sourceStartSec=5;
  assert.equal(validateManualGeminiEditorialContract(data).passed,true);
  data.script.segments=[{cutSafety:"unsafe"},{}];
  assert.match(validateManualGeminiEditorialContract(data).errors.join(" "), /cutSafety=unsafe/);
});

test("verified burned-in dialogue rejects unsafe narrator B-roll", () => {
  const data=sample();
  data.script.segments=[{}, {evidenceId:"e2"}];
  data.sourceEvidence={evidence:[{evidenceId:"e2",burnedTextPresent:true,safeForVoiceover:false}]};
  assert.match(validateManualGeminiEditorialContract(data).errors.join(" "),/unsafe voiceover B-roll/);
  data.sourceEvidence.evidence[0].safeForVoiceover=true;
  assert.equal(validateManualGeminiEditorialContract(data).passed,true);
});
