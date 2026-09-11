const assert = require("assert");
const { compileStorySpineScript, isStorySpineScript } = require("../electron/services/storySpineCompilerService");
const { detectGeminiArtifact, unwrapStoryScript } = require("../electron/services/geminiJsonArtifactService");
const { normalizeHighlightCutScript, validateManualGeminiScript } = require("../electron/services/dubbingService");

const manifest = {
  videoDurationSec: 50,
  scenes: [
    { sceneId: "scene_0001", startSec: 0, endSec: 5 },
    { sceneId: "scene_0002", startSec: 5, endSec: 10 },
    { sceneId: "scene_0003", startSec: 10, endSec: 20 },
    { sceneId: "scene_0004", startSec: 20, endSec: 30 },
    { sceneId: "scene_0005", startSec: 30, endSec: 40 },
    { sceneId: "scene_0006", startSec: 40, endSec: 50 }
  ]
};

const storyScript = {
  artifactType: "story_spine_edit_script",
  schemaVersion: 2,
  scriptId: 1,
  prompt_profile: "independent",
  title: "A coherent test",
  storyContract: {
    centralViewerQuestion: "Will officers reach the person behind the door?",
    hookPromise: "The opening promises the forced entry and its consequence.",
    primaryStoryline: "Officers hear danger, establish why entry is necessary, and force the door.",
    climax: { summary: "Officers force the door.", evidenceIds: ["e4"], sourceStartSec: 30, sourceEndSec: 40 },
    payoff: { summary: "The person is reached.", evidenceIds: ["e5"], sourceStartSec: 40, sourceEndSec: 48 },
    causalChain: ["danger is heard", "entry becomes necessary", "the door is forced", "the person is reached"]
  },
  narrationArc: { openingFrame: "A locked door hides the answer.", bridges: [], closingAnswer: "The person is reached." },
  narrativeBeats: [
    ["beat_hook", 3, 8, "hook", "The door starts to give way.", "Shows the promised forced entry.", "Opening promise.", ["e1", "e2"], "original_audio", ""],
    ["beat_context", 10, 16, "context", "The call explains the danger.", "Explains why officers are there.", "Rewinds to the cause.", ["e3"], "voiceover_only", "The call gave officers one reason to believe somebody inside needed help."],
    ["beat_escalation", 20, 29, "escalation", "The warnings receive no answer.", "Makes forced entry necessary.", "No response raises the danger.", ["e3"], "original_audio", ""],
    ["beat_climax", 30, 40, "climax", "The complete forced-entry exchange.", "Fulfills the Hook promise.", "Officers act after warnings fail.", ["e4"], "original_audio", ""],
    ["beat_payoff", 40, 48, "payoff", "The immediate aftermath answers the question.", "Confirms the person was reached.", "Shows the direct consequence of entry.", ["e5"], "original_audio", ""]
  ].map(([beatId, sourceStartSec, sourceEndSec, storyFunction, summary, advancesViewerQuestion, causalLinkFromPrevious, evidenceIds, audioMode, voiceoverText]) => ({
    beatId, sourceStartSec, sourceEndSec, storyFunction, summary, advancesViewerQuestion,
    causalLinkFromPrevious, evidenceIds, audioMode, voiceoverText
  }))
};

assert.strictEqual(isStorySpineScript(storyScript), true);
assert.strictEqual(unwrapStoryScript({ revisedScript: storyScript }), storyScript);
assert.strictEqual(detectGeminiArtifact(storyScript).type, "story_spine_edit_script");

const compiled = compileStorySpineScript(storyScript, { manifest, videoDuration: 50 });
assert.strictEqual(compiled.segments.length, 5);
assert.deepStrictEqual(compiled.segments[0].sceneIds, ["scene_0001", "scene_0002"]);
assert.strictEqual(compiled.segments[0].sourceStartSec, 3);
assert.strictEqual(compiled.segments[0].sourceEndSec, 8);
assert.strictEqual(compiled.storyCompiler.coherencePassed, true);
assert.strictEqual(compiled.segments[2].transitionExplainedBy, "none");
assert.ok(compiled.transitionCoveragePlan.unresolvedBoundaryCount > 0);
assert.ok(compiled._toolValidationWarnings.some((warning) => warning.includes("Transition Coverage Gate")));

const triggerTrimmed = compileStorySpineScript({
  ...storyScript,
  inputAccessAudit: {
    accessGranted: true,
    stage: "draft_review_story_spine",
    expectedDraftDurationSec: 45,
    inspectedInputs: [{
      name: "draft-v1.mp4",
      role: "draft",
      opened: true,
      parsed: true,
      coverageStartSec: 0,
      coverageEndSec: 45
    }]
  },
  hookTriggerAudit: {
    hookAuditFile: "hook-audition-source-3.000.mp4",
    verifiedAgainstHookAuditClip: true,
    triggerSourceSec: 6,
    hookInPointSec: 5.65,
    setupBeforeTriggerSec: 3,
    autoTrimApproved: true
  },
  teaserClimaxAudit: {
    teaserEventId: "entry_01",
    climaxEventId: "entry_01",
    reprisePolicy: "continue_after_teaser",
    allowedReplaySec: 0.5
  }
}, { manifest, videoDuration: 50 });
assert.strictEqual(triggerTrimmed.segments[0].sourceStartSec, 5.65);
assert.strictEqual(triggerTrimmed.hookTriggerAudit.setupBeforeTriggerSec, 0.35);
assert.strictEqual(triggerTrimmed.inputAccessAudit.expectedDraftDurationSec, 45);

const multiBeatClimax = {
  ...storyScript,
  narrativeBeats: storyScript.narrativeBeats.flatMap((beat) => beat.storyFunction === "climax"
    ? [{
      ...beat,
      beatId: "beat_climax_setup",
      sourceStartSec: 29,
      sourceEndSec: 30,
      evidenceIds: ["e3"],
      summary: "The final warning creates the climax setup.",
      advancesViewerQuestion: "Moves officers to the decisive action.",
      causalLinkFromPrevious: "The unanswered warning forces a decision."
    }, beat]
    : [beat])
};
const compiledMultiBeatClimax = compileStorySpineScript(multiBeatClimax, { manifest, videoDuration: 50 });
assert.strictEqual(compiledMultiBeatClimax.storyCompiler.coherencePassed, true);
assert.strictEqual(compiledMultiBeatClimax.segments.filter((segment) => segment.storyFunction === "climax").length, 2);

assert.throws(() => compileStorySpineScript({
  ...storyScript,
  narrativeBeats: storyScript.narrativeBeats.map((beat) => beat.storyFunction === "climax"
    ? { ...beat, sourceStartSec: 20, sourceEndSec: 25, evidenceIds: ["e3"] }
    : beat)
}, { manifest, videoDuration: 50 }), /coherence gate.*Climax beat không khớp/i);

const conflictingAudioScript = {
  ...storyScript,
  narrativeBeats: storyScript.narrativeBeats.map((beat, index) => index === 0
    ? { ...beat, audioMode: "original_audio", voiceoverText: "This narration must replace the source soundtrack." }
    : beat)
};
const normalizedAudio = compileStorySpineScript(conflictingAudioScript, { manifest, videoDuration: 50 });
assert.strictEqual(normalizedAudio.segments[0].audio_mode, "original_audio");
assert.strictEqual(normalizedAudio.segments[0].voiceover_text, "");
assert.ok(normalizedAudio._toolValidationWarnings.some((warning) => warning.includes("đã bỏ phần narrator")));

const sourceNarratorConflict = {
  ...storyScript,
  narrativeBeats: storyScript.narrativeBeats.map((beat, index) => index === 0
    ? {
      ...beat,
      audioMode: "original_audio",
      voiceoverText: "The tool voice replaces the external host here.",
      sourceNarratorDetected: true
    }
    : beat)
};
const normalizedSourceNarrator = compileStorySpineScript(sourceNarratorConflict, { manifest, videoDuration: 50 });
assert.strictEqual(normalizedSourceNarrator.segments[0].audio_mode, "voiceover_only");
assert.strictEqual(normalizedSourceNarrator.segments[0].voiceover_text, "The tool voice replaces the external host here.");

const missingOptionalVoiceover = {
  ...storyScript,
  narrativeBeats: storyScript.narrativeBeats.map((beat, index) => index === 0
    ? { ...beat, audioMode: "voiceover_only", voiceoverText: "" }
    : beat)
};
const repairedMissingOptionalVoiceover = compileStorySpineScript(missingOptionalVoiceover, { manifest, videoDuration: 50 });
assert.strictEqual(repairedMissingOptionalVoiceover.segments[0].audio_mode, "original_audio");
assert.ok(repairedMissingOptionalVoiceover._toolValidationWarnings.some((warning) => warning.includes("giữ âm thanh gốc")));

assert.throws(() => compileStorySpineScript({
  ...missingOptionalVoiceover,
  narrativeBeats: missingOptionalVoiceover.narrativeBeats.map((beat, index) => index === 0
    ? { ...beat, sourceNarratorDetected: true }
    : beat)
}, { manifest, videoDuration: 50 }), /narrator nguồn.*thiếu voiceoverText\/replacementText/i);

const verifiedNarratorReplacement = compileStorySpineScript({
  ...missingOptionalVoiceover,
  narrativeBeats: missingOptionalVoiceover.narrativeBeats.map((beat, index) => index === 0
    ? { ...beat, sourceNarratorDetected: true, replacementText: "Verified replacement narration." }
    : beat)
}, { manifest, videoDuration: 50 });
assert.strictEqual(verifiedNarratorReplacement.segments[0].audio_mode, "voiceover_only");
assert.strictEqual(verifiedNarratorReplacement.segments[0].voiceover_text, "Verified replacement narration.");

assert.throws(
  () => compileStorySpineScript(storyScript, { manifest, videoDuration: 50, maxDurationSec: 37 }),
  /dài 38\.0s, vượt giới hạn user đã đặt 37\.0s/i
);
assert.doesNotThrow(() => compileStorySpineScript(storyScript, { manifest, videoDuration: 50, maxDurationSec: 38 }));

const allNarratorReview = {
  ...storyScript,
  workflow: "manual_gemini_draft_review",
  prompt_profile: "independent",
  scriptId: 1,
  narrativeBeats: storyScript.narrativeBeats.map((beat) => ({
    ...beat,
    audioMode: "voiceover_only",
    voiceoverText: `Narration for ${beat.beatId}`
  }))
};
const balancedReview = compileStorySpineScript(allNarratorReview, { manifest, videoDuration: 50 });
const balancedVoiceSec = balancedReview.segments
  .filter((segment) => segment.audio_mode === "voiceover_only")
  .reduce((sum, segment) => sum + (segment.sourceEndSec - segment.sourceStartSec) / segment.playbackSpeed, 0);
const balancedTotalSec = balancedReview.segments
  .reduce((sum, segment) => sum + (segment.sourceEndSec - segment.sourceStartSec) / segment.playbackSpeed, 0);
assert.strictEqual(balancedVoiceSec, balancedTotalSec);
assert.ok(balancedReview.segments.every((segment) => segment.audio_mode === "voiceover_only"));
assert.ok(balancedReview._toolValidationWarnings.some((warning) => warning.includes("Narration balance warning")));

const ambientReview = {
  ...storyScript,
  workflow: "manual_gemini_draft_review",
  prompt_profile: "independent",
  narrativeBeats: storyScript.narrativeBeats.map((beat) => beat.beatId === "beat_context"
    ? { ...beat, audioMode: "voiceover_with_ambient", sourceAmbientVolume: 0.17 }
    : beat)
};
const compiledAmbient = compileStorySpineScript(ambientReview, { manifest, videoDuration: 50 });
const ambientSegment = compiledAmbient.segments.find((segment) => segment.storyFunction === "context");
assert.strictEqual(ambientSegment.audio_mode, "voiceover_with_ambient");
assert.strictEqual(ambientSegment.source_ambient_volume, 0.17);

const ambientNarratorConflict = {
  ...ambientReview,
  narrativeBeats: ambientReview.narrativeBeats.map((beat) => beat.beatId === "beat_context"
    ? { ...beat, sourceNarratorDetected: true }
    : beat)
};
const compiledAmbientNarrator = compileStorySpineScript(ambientNarratorConflict, { manifest, videoDuration: 50 });
assert.strictEqual(
  compiledAmbientNarrator.segments.find((segment) => segment.storyFunction === "context").audio_mode,
  "voiceover_only"
);

const longAdjacentNarrationReview = {
  ...storyScript,
  workflow: "manual_gemini_draft_review",
  prompt_profile: "independent",
  scriptId: 1,
  narrativeBeats: storyScript.narrativeBeats.map((beat) => {
    if (beat.beatId === "beat_context") {
      return {
        ...beat,
        audioMode: "voiceover_only",
        voiceoverText: "The deputy first needs to explain why the dangerous stop matters, what the driver claimed, and why those excuses immediately created a much bigger question for everyone watching the encounter unfold."
      };
    }
    if (beat.beatId === "beat_escalation") {
      return {
        ...beat,
        audioMode: "voiceover_only",
        voiceoverText: "The computer check then changes the stakes."
      };
    }
    return beat;
  })
};
const auditedNarration = compileStorySpineScript(longAdjacentNarrationReview, { manifest, videoDuration: 50 });
assert.ok(auditedNarration._toolValidationWarnings.some((warning) => warning.includes("Narration block gate: beat_context")));
assert.ok(auditedNarration._toolValidationWarnings.some((warning) => warning.includes("Narration adjacency gate")));

const integratedContextReview = {
  ...storyScript,
  workflow: "manual_gemini_draft_review",
  prompt_profile: "independent",
  narrativeBeats: storyScript.narrativeBeats.filter((beat) => beat.storyFunction !== "context")
};
const compiledIntegratedContext = compileStorySpineScript(integratedContextReview, { manifest, videoDuration: 50 });
assert.strictEqual(compiledIntegratedContext.storyCompiler.coherencePassed, true);
assert.strictEqual(compiledIntegratedContext.story_blueprint.storySpine.rewindContext, storyScript.storyContract.primaryStoryline);
assert.ok(compiledIntegratedContext._toolValidationWarnings.some((warning) => warning.includes("thiếu beat context riêng")));

assert.throws(() => compileStorySpineScript({
  ...storyScript,
  narrativeBeats: storyScript.narrativeBeats.filter((beat) => beat.storyFunction !== "context")
}, { manifest, videoDuration: 50 }), /coherence gate.*beat context/i);

const evidencePayload = {
  evidence: ["e1", "e2", "e3", "e4", "e5"].map((evidenceId, index) => ({
    evidenceId,
    sceneId: `scene_${String(Math.min(index + 1, 6)).padStart(4, "0")}`,
    sourceStartSec: index * 5,
    sourceEndSec: index * 5 + 5
  }))
};
const validated = validateManualGeminiScript(compiled, manifest, "story-spine.json", evidencePayload, {
  independentNarratorPolicy: true
});
assert.strictEqual(validated.segments[0].sourceStartSec, 3);
assert.strictEqual(validated.segments[0].sourceEndSec, 8);
assert.deepStrictEqual(validated.segments[0].sceneIds, ["scene_0001", "scene_0002"]);

const normalized = normalizeHighlightCutScript(validated, 50);
assert.strictEqual(normalized.segments.length, 5);
assert.strictEqual(normalized.segments[0].duration, 5);
assert.strictEqual(normalized.segments[1].startSec, 5);
assert.strictEqual(normalized.storyCompiler.coherencePassed, true);

const normalizedAmbient = normalizeHighlightCutScript({
  title: "Ambient voice test",
  segments: [{
    id: "ambient_001",
    sceneId: "scene_0001",
    sourceStartSec: 0,
    sourceEndSec: 5,
    playbackSpeed: 1,
    audio_mode: "voiceover_with_ambient",
    source_ambient_volume: 0.18,
    voiceover_text: "A short verified context bridge."
  }]
}, 50);
assert.strictEqual(normalizedAmbient.segments[0].audioMode, "voiceover_with_ambient");
assert.strictEqual(normalizedAmbient.segments[0].sourceAmbientVolume, 0.18);
assert.strictEqual(normalizedAmbient.segments[0].sourceVolume, 0.18);

assert.throws(() => compileStorySpineScript({
  ...storyScript,
  storyContract: { ...storyScript.storyContract, hookPromise: "" }
}, { manifest, videoDuration: 50 }), /coherence gate.*hookPromise/i);

console.log("story spine compiler tests passed");
