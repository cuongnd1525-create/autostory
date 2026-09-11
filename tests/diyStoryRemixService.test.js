const assert = require("assert");

const {
  buildDiyBlueprintPrompt,
  buildDiyProcessMapPrompt,
  buildDiyVoiceScriptPrompt,
  evaluateDiyNarrationQuality,
  evaluateDiyProcessMapQuality,
  validateDiyBlueprint,
  validateDiyFinalScript,
  validateDiyProcessMap
} = require("../electron/services/diyStoryRemixService");

const manifest = {
  sourceVideo: "diy.mp4",
  videoDurationSec: 40,
  scenes: [
    { sceneId: "scene_0001", startSec: 0, endSec: 10 },
    { sceneId: "scene_0002", startSec: 10, endSec: 20 },
    { sceneId: "scene_0003", startSec: 20, endSec: 30 },
    { sceneId: "scene_0004", startSec: 30, endSec: 40 }
  ]
};

const processMapCandidate = {
  artifactType: "diy_visual_process_map",
  schemaVersion: 2,
  sourceVideo: "diy.mp4",
  sourceStorySummary: "A damaged table is carefully restored instead of discarded.",
  sourceStoryTheme: "Patience can restore something that looked ruined.",
  sourceStoryArc: "Damage, careful work, setback, repair and reveal.",
  sourceStorySignals: [{ sourceStartSec: 0, sourceEndSec: 8, type: "visual_story", evidence: "The damaged starting condition is visible." }],
  visualBeats: [
    {
      visualBeatId: "beat_0001",
      sceneId: "scene_0001",
      sourceStartSec: 0,
      sourceEndSec: 8,
      phase: "before",
      stateBefore: "A scratched wooden table is visible.",
      visibleAction: "The creator cleans the table.",
      stateAfter: "The surface is free of dust.",
      visualFacts: ["Dust is wiped from the wooden surface."],
      artifactState: "rough",
      completionLevel: 0.15,
      visibleCompletionEvidence: ["Deep scratches remain visible across the dusty top."],
      humanStoryEvidence: [{
        sourceStartSec: 1,
        sourceEndSec: 3,
        evidenceType: "visible_behavior",
        observedSignal: "The creator pauses and inspects the deepest scratch.",
        supportedMeaning: "The damaged area requires special attention.",
        confidence: 0.9
      }],
      hookStrength: 5,
      payoffStrength: 2,
      curiosityStrength: 5,
      sourceSpeechPresent: false
    },
    {
      visualBeatId: "beat_0002",
      sceneId: "scene_0002",
      sourceStartSec: 10,
      sourceEndSec: 18,
      phase: "process",
      stateBefore: "The table is clean.",
      visibleAction: "Dark stain is brushed over the wood.",
      stateAfter: "The wood becomes darker.",
      visualFacts: ["A brush applies dark stain."],
      artifactState: "in_progress",
      completionLevel: 0.45,
      visibleCompletionEvidence: ["Only part of the bare surface has received stain."],
      requiredBefore: ["beat_0001"],
      hookStrength: 6,
      payoffStrength: 5,
      curiosityStrength: 7,
      sourceSpeechPresent: false
    },
    {
      visualBeatId: "beat_0003",
      sceneId: "scene_0003",
      sourceStartSec: 20,
      sourceEndSec: 28,
      phase: "failure",
      stateBefore: "The stain looks even.",
      visibleAction: "A pale patch appears after sanding.",
      stateAfter: "The finish is visibly uneven.",
      visualFacts: ["A pale patch is visible in the finish."],
      artifactState: "in_progress",
      completionLevel: 0.6,
      visibleCompletionEvidence: ["The finish still contains a pale uneven patch."],
      requiredBefore: ["beat_0002"],
      hookStrength: 9,
      payoffStrength: 6,
      curiosityStrength: 9,
      sourceSpeechPresent: false
    },
    {
      visualBeatId: "beat_0004",
      sceneId: "scene_0004",
      sourceStartSec: 30,
      sourceEndSec: 39,
      phase: "payoff",
      stateBefore: "The finish is uneven.",
      visibleAction: "The creator applies a final coat.",
      stateAfter: "The table has a smooth dark finish.",
      visualFacts: ["The completed table has an even dark finish."],
      artifactState: "human_payoff",
      completionLevel: 0.98,
      visibleCompletionEvidence: ["The table has a clean, smooth and even dark finish."],
      personalPayoffEvidence: [{
        sourceStartSec: 36,
        sourceEndSec: 38,
        evidenceType: "visible_behavior",
        payoffType: "personal_milestone",
        observedSignal: "The creator smiles while running a hand over the finished surface.",
        supportedMeaning: "The creator visibly reacts to the completed restoration.",
        confidence: 0.95
      }],
      requiredBefore: ["beat_0003"],
      hookStrength: 8,
      payoffStrength: 10,
      curiosityStrength: 8,
      sourceSpeechPresent: false
    }
  ]
};

const processMap = validateDiyProcessMap(processMapCandidate, manifest, "process-map.json");
const quality = evaluateDiyProcessMapQuality(processMap, manifest);
assert.strictEqual(quality.passed, true, quality.failures.join(" | "));
assert.strictEqual(processMap.evidence.length, 4, "Process Map phải tương thích evidence locking hiện có.");
assert.strictEqual(processMap.sourceStoryTheme, "Patience can restore something that looked ruined.");
assert.strictEqual(processMap.visualBeats[0].humanStoryEvidence[0].sourceStartSec, 1);
assert.strictEqual(processMap.visualBeats[3].personalPayoffEvidence[0].payoffType, "personal_milestone");

const hallucinatedEmotion = JSON.parse(JSON.stringify(processMapCandidate));
hallucinatedEmotion.visualBeats[0].humanStoryEvidence = [{
  evidenceType: "visible_behavior",
  observedSignal: "The creator appears sad.",
  supportedMeaning: "The table belonged to a lost family member."
}];
assert.throws(
  () => validateDiyProcessMap(hallucinatedEmotion, manifest, "hallucinated-emotion.json"),
  /thiếu timestamp nguồn hợp lệ/i,
  "Human-story evidence không có timestamp phải bị chặn."
);

const cyclic = JSON.parse(JSON.stringify(processMapCandidate));
cyclic.visualBeats[0].requiredBefore = ["beat_0004"];
assert.throws(
  () => validateDiyProcessMap(cyclic, manifest, "cyclic.json"),
  /vòng lặp dependency/i,
  "Process Map có dependency cycle phải bị chặn."
);
assert.throws(
  () => validateDiyBlueprint({ workflow: "diy_story_remix", segments: [{}] }, processMap, "wrong-stage.json"),
  /Voice-Locked Script của Giai đoạn 4/i
);

const blueprint = validateDiyBlueprint({
  artifactType: "diy_story_blueprint",
  schemaVersion: 2,
  storyAngle: "failure_to_success",
  titleDirection: "The finish nearly ruined the entire table",
  narrativePromise: "Show the failure, then prove how the creator repaired it.",
  storySpine: {
    premise: { text: "A damaged table may still deserve another chance.", evidenceBeatIds: ["beat_0001"], grounding: "source_evidence" },
    humanWant: { text: "The creator wants to restore the damaged surface.", evidenceBeatIds: ["beat_0001"], grounding: "source_evidence" },
    stakes: { text: "An uneven patch threatens the finish.", evidenceBeatIds: ["beat_0003"], grounding: "source_evidence" },
    centralStruggle: { text: "The finish has to be corrected without losing the progress.", evidenceBeatIds: ["beat_0003"], grounding: "source_evidence" },
    turningPoint: { text: "A final corrective coat changes the result.", evidenceBeatIds: ["beat_0004"], grounding: "source_evidence" },
    emotionalPayoff: { text: "The creator visibly enjoys the restored finish.", evidenceBeatIds: ["beat_0004"], grounding: "source_evidence" },
    endingMeaning: { text: "Careful correction gives the damaged table a second life.", evidenceBeatIds: ["beat_0004"], grounding: "source_evidence" }
  },
  informationGap: {
    hookStatement: "This finish almost ruined everything.",
    withheldCause: "An uneven sanding patch",
    revealAtBlockId: "block_04",
    forbiddenTermsBeforeReveal: ["uneven patch"],
    payoffVisualBeatIds: ["beat_0004"]
  },
  hookVisualBeatIds: ["beat_0003"],
  blocks: [
    { blockId: "block_01", storyFunction: "hook", visualBeatIds: ["beat_0003"], transitionType: "flash_forward" },
    { blockId: "block_02", storyFunction: "setup", visualBeatIds: ["beat_0001"] },
    { blockId: "block_03", storyFunction: "process", visualBeatIds: ["beat_0002"] },
    { blockId: "block_04", storyFunction: "obstacle", visualBeatIds: ["beat_0003"] },
    { blockId: "block_05", storyFunction: "payoff", visualBeatIds: ["beat_0004"] }
  ]
}, processMap, "blueprint.json");

const finalScript = {
  artifactType: "highlight_cut_script",
  schemaVersion: 2,
  workflow: "diy_story_remix",
  toneProfile: "authentic_warm_diy",
  toneIntensity: 0.4,
  title: "This Finish Almost Ruined Everything",
  language: "en",
  sourceLanguage: "auto",
  total_target_sec: 39,
  segments: [
    { visualBeatId: "beat_0003", evidenceId: "beat_0003", macroBlockId: "block_01", storyFunction: "hook", narrativePurpose: "anticipation", visualClaimType: "process", deliveryProfile: "mystery_hook", speechRateMultiplier: 0.9, pauseAfterPhrase: "patch", pauseDurationMs: 350, audio_mode: "voiceover_only", voiceover_text: "This pale patch nearly ruined the entire finish.", caption: "" },
    { visualBeatId: "beat_0001", evidenceId: "beat_0001", macroBlockId: "block_02", storyFunction: "setup", narrativePurpose: "hidden_context", visualClaimType: "process", deliveryProfile: "warm_story", speechRateMultiplier: 0.98, audio_mode: "voiceover_only", voiceover_text: "It started with a scratched table and a careful clean.", caption: "" },
    { visualBeatId: "beat_0002", evidenceId: "beat_0002", macroBlockId: "block_03", storyFunction: "process", narrativePurpose: "technical_clarity", visualClaimType: "process", deliveryProfile: "process_energy", speechRateMultiplier: 1.04, audio_mode: "voiceover_only", voiceover_text: "Then the first dark coat went across the bare wood.", caption: "" },
    { visualBeatId: "beat_0003", evidenceId: "beat_0003", macroBlockId: "block_04", storyFunction: "obstacle", narrativePurpose: "stakes", visualClaimType: "process", deliveryProfile: "warm_story", speechRateMultiplier: 0.98, audio_mode: "voiceover_only", voiceover_text: "Sanding exposed the one uneven area that had to be fixed.", caption: "" },
    { visualBeatId: "beat_0004", evidenceId: "beat_0004", macroBlockId: "block_05", storyFunction: "payoff", narrativePurpose: "payoff_meaning", visualClaimType: "human_payoff", deliveryProfile: "intimate_payoff", speechRateMultiplier: 0.9, audio_mode: "voiceover_only", voiceover_text: "A final coat turned it into a smooth, even table.", caption: "" }
  ]
};

assert.strictEqual(validateDiyFinalScript(finalScript, processMap, blueprint), finalScript);
assert.ok(finalScript._diyNarrationQuality.score >= 75);
const leakedHookScript = JSON.parse(JSON.stringify(finalScript));
leakedHookScript.segments[0].voiceover_text = "This uneven patch nearly ruined the entire finish.";
assert.throws(() => validateDiyFinalScript(leakedHookScript, processMap, blueprint), /làm lộ Information Gap/i);
const captionedScript = JSON.parse(JSON.stringify(finalScript));
captionedScript.segments[0].caption = "Do not burn this";
assert.throws(() => validateDiyFinalScript(captionedScript, processMap, blueprint), /caption phải để trống/i);
const wrongBlockScript = JSON.parse(JSON.stringify(finalScript));
wrongBlockScript.segments[2].macroBlockId = "block_02";
assert.throws(() => validateDiyFinalScript(wrongBlockScript, processMap, blueprint), /không thuộc block_02/i);
const optionalBeatBlueprint = JSON.parse(JSON.stringify(blueprint));
optionalBeatBlueprint.blocks[2].visualBeatIds.push("beat_0003");
const optionalBeatScript = JSON.parse(JSON.stringify(finalScript));
optionalBeatScript.segments = optionalBeatScript.segments.filter((segment) => segment.macroBlockId !== "block_04");
assert.doesNotThrow(() => validateDiyFinalScript(optionalBeatScript, processMap, optionalBeatBlueprint));
assert.ok(optionalBeatScript._toolValidationWarnings.some((warning) => warning.includes("đã lược bỏ visual beat")));

const tutorialScript = JSON.parse(JSON.stringify(finalScript));
tutorialScript.segments.forEach((segment, index) => {
  segment.narrativePurpose = "technical_clarity";
  segment.voiceover_text = `${["First", "Then", "Next", "After that", "Finally"][index]} I worked on the visible table surface.`;
});
const tutorialQuality = evaluateDiyNarrationQuality(tutorialScript, processMap);
assert.strictEqual(tutorialQuality.passed, false);
assert.ok(tutorialQuality.warnings.some((warning) => warning.includes("tutorial")));

const mismatchedCompletionScript = JSON.parse(JSON.stringify(finalScript));
mismatchedCompletionScript.segments[2].visualClaimType = "completed_result";
assert.throws(
  () => validateDiyFinalScript(mismatchedCompletionScript, processMap, blueprint),
  /completed_result/i,
  "A completed-result claim must not use an in-progress visual beat."
);

const overDramaticScript = JSON.parse(JSON.stringify(finalScript));
overDramaticScript.segments[1].voiceover_text = "This brutal industrial fortress demanded warfare against the wood.";
const overDramaticQuality = evaluateDiyNarrationQuality(overDramaticScript, processMap);
assert.ok(overDramaticQuality.metrics.overDramaticSegmentCount > 0);
assert.ok(overDramaticQuality.warnings.some((warning) => warning.includes("Tone DIY")));

const autoBlueprint = validateDiyBlueprint({
  artifactType: "diy_story_blueprint",
  schemaVersion: 1,
  storyAngle: "gemini_auto_story",
  sourceStoryTheme: "Restoring something damaged through patience",
  adaptedStoryConcept: "A parallel story about rebuilding confidence one careful decision at a time.",
  adaptedStoryArc: ["A visible setback", "A careful restart", "A satisfying recovery"],
  hookVisualBeatIds: ["beat_0003"],
  blocks: blueprint.blocks
}, { ...processMap, sourceStoryTheme: "Restoring something damaged through patience" }, "auto-blueprint.json");
assert.strictEqual(autoBlueprint.storyAngle, "gemini_auto_story");
assert.ok(autoBlueprint.adaptedStoryConcept.includes("rebuilding confidence"));

assert.match(buildDiyProcessMapPrompt({ manifest }), /diy_visual_process_map/);
assert.match(buildDiyProcessMapPrompt({ manifest }), /VERIFIED INPUT ACCESS GATE/);
assert.match(buildDiyProcessMapPrompt({ manifest }), /ANTI-EMOTIONAL-HALLUCINATION/);
assert.match(buildDiyProcessMapPrompt({ manifest }), /PERSONAL PAYOFF SCAN/);
assert.match(buildDiyBlueprintPrompt({ processMap, basePrompt: "failure_to_success" }), /diy_story_blueprint/);
assert.match(buildDiyBlueprintPrompt({ processMap, basePrompt: "failure_to_success" }), /noGuessingConfirmed/);
assert.match(buildDiyBlueprintPrompt({ processMap, basePrompt: "failure_to_success" }), /INFORMATION GAP HOOK/);
assert.match(buildDiyBlueprintPrompt({ processMap, basePrompt: "storyAngle: emotional_story" }), /PROFILE FEW-SHOT - EMOTIONAL STORY/);
assert.match(buildDiyBlueprintPrompt({ processMap, basePrompt: "storyAngle: gemini_auto_story" }), /NEW parallel story concept/);
assert.match(buildDiyVoiceScriptPrompt({ blueprint, processMap, manifest, basePrompt: "Measured voice: 3.1 words\/second" }), /diy-story-remix\.json/);
assert.match(buildDiyVoiceScriptPrompt({ blueprint, processMap, manifest }), /gemini_input_access_failure/);
assert.match(buildDiyVoiceScriptPrompt({ blueprint, processMap, manifest }), /INFORMATION GAP LOCK/);
assert.match(buildDiyVoiceScriptPrompt({ blueprint, processMap, manifest }), /SHOW, DON'T TELL/);
assert.match(buildDiyVoiceScriptPrompt({ blueprint, processMap, manifest }), /VISUAL HARMONY/);
assert.match(buildDiyVoiceScriptPrompt({ blueprint, processMap, manifest }), /DELIVERY PLAN/);

console.log("diyStoryRemixService tests passed");
