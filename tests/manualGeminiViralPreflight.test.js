const assert = require("assert");
const {
  measureVoiceGrounding,
  rankManualGeminiVariants,
  scoreManualGeminiVariant
} = require("../electron/services/manualGeminiViralPreflightService");

const evidencePayload = {
  evidence: [
    { evidenceId: "e1", narrativePhase: "hook", viralScore: 9, hookScore: 9, completeBeat: true },
    { evidenceId: "e2", narrativePhase: "escalation", completeBeat: true },
    { evidenceId: "e3", narrativePhase: "consequence", completeBeat: true }
  ]
};
const normalizedScript = {
  totalDuration: 65,
  segments: [
    { evidenceId: "e1", duration: 8, sourceStartSec: 100, sourceEndSec: 108, audioMode: "original_audio" },
    { evidenceId: "e2", duration: 25, sourceStartSec: 108, sourceEndSec: 133, audioMode: "original_audio" },
    { evidenceId: "e3", duration: 32, sourceStartSec: 133, sourceEndSec: 165, audioMode: "original_audio" }
  ]
};
const script = {
  prompt_profile: "independent",
  audio_strategy: "source_audio_only",
  voiceover_enabled: false,
  source_narrator_policy: "forbidden",
  hook_cold_viewer_test: {
    passes: true,
    identifiedActor: "The suspect",
    identifiedConflict: "The suspect refuses the officer's command",
    identifiedStake: "An arrest is underway"
  },
  story_blueprint: {
    macroBlocks: [{ macroBlockId: "m1" }, { macroBlockId: "m2" }, { macroBlockId: "m3" }]
  },
  segments: [
    { storyFunction: "hook", macroBlockId: "m1", transitionReason: "The confrontation opens the case." },
    { storyFunction: "escalation", macroBlockId: "m2", transitionReason: "The refusal escalates directly." },
    { storyFunction: "consequence", macroBlockId: "m3", transitionReason: "The arrest resolves the refusal." }
  ]
};
const strong = scoreManualGeminiVariant({ script, normalizedScript, evidencePayload });
assert.ok(Number.isFinite(strong.scoreBreakdown.technicalReadiness.score));
assert.ok(Number.isFinite(strong.scoreBreakdown.editorialReadiness.score));
assert.ok(strong.scoreBreakdown.editorialReadiness.note.includes("not a guarantee"));
assert.ok(strong.score < 85);
assert.strictEqual(strong.metrics.storySpinePresent, false);
assert.ok(strong.issues.some((item) => item.includes("Thiếu story_blueprint.storySpine")));
assert.strictEqual(strong.metrics.sourceJumpCount, 0);
assert.strictEqual(strong.metrics.hookColdViewerPassed, true);
assert.strictEqual(strong.metrics.narratorOriginalAudioViolationCount, 0);

const storySpineEvidence = {
  evidence: [
    { evidenceId: "s1", narrativePhase: "hook", viralScore: 9, hookScore: 9, completeBeat: true },
    { evidenceId: "s2", narrativePhase: "context", completeBeat: true },
    { evidenceId: "s3", narrativePhase: "escalation", completeBeat: true },
    { evidenceId: "s4", narrativePhase: "climax", completeBeat: true },
    { evidenceId: "s5", narrativePhase: "consequence", completeBeat: true }
  ]
};
const storySpineQuestion = "Will officers reach the trapped victim in time?";
const storySpinePromise = "The Hook promises the forced entry and rescue.";
const storySpineResult = scoreManualGeminiVariant({
  expectedScriptId: 3,
  script: {
    prompt_profile: "independent",
    scriptId: 3,
    source_narrator_policy: "forbidden",
    hook_cold_viewer_test: {
      passes: true,
      identifiedActor: "The officers",
      identifiedConflict: "A victim is trapped behind a locked door",
      identifiedStake: "The victim may be injured"
    },
    story_blueprint: {
      storySpine: {
        centralViewerQuestion: storySpineQuestion,
        hookPromise: storySpinePromise,
        rewindContext: "Why officers were called to the locked home.",
        escalationPath: ["The screams intensify", "Officers force the door"],
        climax: "Officers break through and reach the victim.",
        climaxEvidenceIds: ["s4"],
        payoff: "The victim is visibly safe with responders.",
        payoffEvidenceIds: ["s5"]
      },
      macroBlocks: ["hook", "context", "escalation", "climax", "payoff"].map((role, index) => ({
        macroBlockId: `spine_${index + 1}`,
        storyFunction: role
      }))
    },
    narrative_contract: {
      hookPromise: storySpinePromise,
      primaryAudienceQuestion: storySpineQuestion,
      mandatoryResolution: { required: true, evidenceIds: ["s5"], visualFirstRequired: false }
    },
    segments: [
      { evidenceId: "s1", macroBlockId: "spine_1", storyFunction: "hook", narrativePurpose: "hook_teaser", transitionReason: "Opening teaser." },
      { evidenceId: "s2", macroBlockId: "spine_2", storyFunction: "context", narrativePurpose: "rewind_context", transitionReason: "Rewind explains the call." },
      { evidenceId: "s3", macroBlockId: "spine_3", storyFunction: "escalation", narrativePurpose: "escalation", transitionReason: "The danger grows." },
      { evidenceId: "s4", macroBlockId: "spine_4", storyFunction: "climax", narrativePurpose: "climax_return", transitionReason: "The forced entry fulfills the Hook." },
      { evidenceId: "s5", macroBlockId: "spine_5", storyFunction: "consequence", narrativePurpose: "aftermath_payoff", transitionReason: "The victim's safety resolves the question." }
    ]
  },
  normalizedScript: {
    totalDuration: 65,
    segments: [
      { evidenceId: "s1", duration: 8, sourceStartSec: 100, sourceEndSec: 108, audioMode: "original_audio" },
      { evidenceId: "s2", duration: 12, sourceStartSec: 0, sourceEndSec: 12, audioMode: "voiceover_only", voiceoverText: "Officers were called after neighbors heard screams behind the locked door." },
      { evidenceId: "s3", duration: 15, sourceStartSec: 12, sourceEndSec: 27, audioMode: "original_audio" },
      { evidenceId: "s4", duration: 20, sourceStartSec: 27, sourceEndSec: 47, audioMode: "original_audio" },
      { evidenceId: "s5", duration: 10, sourceStartSec: 47, sourceEndSec: 57, audioMode: "original_audio" }
    ]
  },
  evidencePayload: storySpineEvidence
});
assert.strictEqual(storySpineResult.metrics.storySpinePresent, true);
assert.strictEqual(storySpineResult.metrics.storySpinePassed, true);
assert.strictEqual(storySpineResult.diagnostics.storySpine.sequencePassed, true);
assert.ok(storySpineResult.strengths.some((item) => item.includes("Story Spine")));

const twoLayerPayoffEvidence = {
  evidence: [
    ...storySpineEvidence.evidence,
    {
      evidenceId: "s6",
      narrativePhase: "consequence",
      completeBeat: true,
      stakeRole: "legal_resolution",
      mustInclude: true,
      storyMeaning: "A verified court sentence closes the case."
    }
  ]
};
const twoLayerPayoffScript = {
  ...storySpineResult.diagnostics.profile,
  prompt_profile: "independent",
  scriptId: 3,
  source_narrator_policy: "forbidden",
  hook_cold_viewer_test: {
    passes: true,
    identifiedActor: "The officers",
    identifiedConflict: "A victim is trapped behind a locked door",
    identifiedStake: "The victim may be injured"
  },
  story_blueprint: {
    storySpine: {
      centralViewerQuestion: storySpineQuestion,
      hookPromise: storySpinePromise,
      rewindContext: "Why officers were called to the locked home.",
      escalationPath: ["The screams intensify", "Officers force the door"],
      climax: "Officers break through and reach the victim.",
      climaxEvidenceIds: ["s4"],
      payoff: "The victim is visibly safe with responders.",
      payoffEvidenceIds: ["s5"],
      finalOutcomeRequired: true,
      finalOutcome: "The verified court sentence closes the case.",
      finalOutcomeEvidenceIds: ["s6"]
    },
    macroBlocks: ["hook", "context", "escalation", "climax", "payoff", "final_outcome"].map((role, index) => ({
      macroBlockId: `two_layer_${index + 1}`,
      storyFunction: role
    }))
  },
  narrative_contract: {
    hookPromise: storySpinePromise,
    primaryAudienceQuestion: storySpineQuestion,
    mandatoryResolution: { required: true, evidenceIds: ["s5"], visualFirstRequired: false },
    secondaryPayoff: {
      required: true,
      mustBeFinal: true,
      evidenceIds: ["s6"],
      verifiedOutcome: "The verified court sentence closes the case."
    }
  },
  segments: [
    { evidenceId: "s1", macroBlockId: "two_layer_1", storyFunction: "hook", narrativePurpose: "hook_teaser" },
    { evidenceId: "s2", macroBlockId: "two_layer_2", storyFunction: "context", narrativePurpose: "rewind_context" },
    { evidenceId: "s3", macroBlockId: "two_layer_3", storyFunction: "escalation", narrativePurpose: "escalation" },
    { evidenceId: "s4", macroBlockId: "two_layer_4", storyFunction: "climax", narrativePurpose: "climax_return" },
    { evidenceId: "s5", macroBlockId: "two_layer_5", storyFunction: "consequence", narrativePurpose: "aftermath_payoff" },
    { evidenceId: "s6", macroBlockId: "two_layer_6", storyFunction: "final_outcome", narrativePurpose: "final_outcome" }
  ]
};
const twoLayerNormalizedSegments = [
  { evidenceId: "s1", duration: 8, sourceStartSec: 100, sourceEndSec: 108, audioMode: "original_audio" },
  { evidenceId: "s2", duration: 12, sourceStartSec: 0, sourceEndSec: 12, audioMode: "voiceover_only", voiceoverText: "Officers were called after neighbors heard screams behind the locked door." },
  { evidenceId: "s3", duration: 15, sourceStartSec: 12, sourceEndSec: 27, audioMode: "original_audio" },
  { evidenceId: "s4", duration: 20, sourceStartSec: 27, sourceEndSec: 47, audioMode: "original_audio" },
  { evidenceId: "s5", duration: 10, sourceStartSec: 47, sourceEndSec: 57, audioMode: "original_audio" },
  { evidenceId: "s6", duration: 5, sourceStartSec: 80, sourceEndSec: 85, audioMode: "voiceover_only", voiceoverText: "A judge later imposed the verified sentence." }
];
const twoLayerPayoffResult = scoreManualGeminiVariant({
  expectedScriptId: 3,
  script: twoLayerPayoffScript,
  normalizedScript: { totalDuration: 70, segments: twoLayerNormalizedSegments },
  evidencePayload: twoLayerPayoffEvidence
});
assert.strictEqual(twoLayerPayoffResult.metrics.finalOutcomeRequired, true);
assert.strictEqual(twoLayerPayoffResult.metrics.finalOutcomePassed, true);
assert.strictEqual(twoLayerPayoffResult.metrics.finalOutcomeDeclarationComplete, true);

const abruptEndingResult = scoreManualGeminiVariant({
  expectedScriptId: 3,
  script: { ...twoLayerPayoffScript, segments: twoLayerPayoffScript.segments.slice(0, -1) },
  normalizedScript: { totalDuration: 65, segments: twoLayerNormalizedSegments.slice(0, -1) },
  evidencePayload: twoLayerPayoffEvidence
});
assert.strictEqual(abruptEndingResult.metrics.finalOutcomePassed, false);
assert.ok(abruptEndingResult.issues.some((item) => item.includes("Final Outcome Gate")));

const narratedScriptOne = scoreManualGeminiVariant({
  expectedScriptId: 1,
  script: {
    ...script,
    scriptId: 1,
    audio_strategy: "clean_hybrid",
    voiceover_enabled: true,
    segments: [
      script.segments[0],
      { ...script.segments[1], storyFunction: "context" },
      script.segments[1],
      { ...script.segments[2], storyFunction: "consequence" },
      script.segments[2]
    ]
  },
  normalizedScript: {
    totalDuration: 65,
    segments: [
      { evidenceId: "e1", duration: 8, sourceStartSec: 100, sourceEndSec: 108, audioMode: "original_audio" },
      { evidenceId: "e1", duration: 6, sourceStartSec: 108, sourceEndSec: 114, audioMode: "voiceover_only", voiceoverText: "The confrontation began after officers challenged his story." },
      { evidenceId: "e2", duration: 25, sourceStartSec: 114, sourceEndSec: 139, audioMode: "original_audio" },
      { evidenceId: "e3", duration: 6, sourceStartSec: 139, sourceEndSec: 145, audioMode: "voiceover_only", voiceoverText: "The verified consequence followed immediately after the confrontation." },
      { evidenceId: "e3", duration: 20, sourceStartSec: 145, sourceEndSec: 165, audioMode: "original_audio" }
    ]
  },
  evidencePayload
});
assert.strictEqual(narratedScriptOne.metrics.voiceoverSegmentCount, 2);
assert.ok(narratedScriptOne.strengths.some((item) => item.includes("Narrated Raw Reality") || item.includes("narrator")));

const silentScriptOne = scoreManualGeminiVariant({
  expectedScriptId: 1,
  script: { ...script, scriptId: 1, audio_strategy: "clean_hybrid", voiceover_enabled: true },
  normalizedScript,
  evidencePayload
});
assert.ok(silentScriptOne.issues.some((item) => item.includes("Narrator Presence Gate")));
assert.ok(silentScriptOne.scoreBreakdown.editorialReadiness.issues.some((item) => item.includes("collapses the narrator-led profile")));

const narratorContaminatedIndependent = scoreManualGeminiVariant({
  expectedScriptId: 3,
  script: {
    ...script,
    scriptId: 3,
    audio_strategy: "standard",
    voiceover_enabled: true,
    segments: script.segments.map((item, index) => ({
      ...item,
      source_narrator_detected: index === 1,
      speech_type: index === 1 ? "source_narration" : "direct_scene_dialogue"
    }))
  },
  normalizedScript,
  evidencePayload: {
    evidence: evidencePayload.evidence.map((item, index) => ({
      ...item,
      sourceNarratorPresent: index === 1,
      sourceAudioType: index === 1 ? "source_narration" : "scene_dialogue"
    }))
  }
});
assert.strictEqual(narratorContaminatedIndependent.metrics.narratorOriginalAudioViolationCount, 1);
assert.ok(narratorContaminatedIndependent.issues.some((issue) => issue.includes("narrator nguồn")));

const backwardBodyIndependent = scoreManualGeminiVariant({
  expectedScriptId: 4,
  script: { ...script, scriptId: 4, audio_strategy: "standard", voiceover_enabled: true },
  normalizedScript: {
    totalDuration: 65,
    segments: [
      { evidenceId: "e1", duration: 8, sourceStartSec: 100, sourceEndSec: 108, audioMode: "original_audio" },
      { evidenceId: "e2", duration: 25, sourceStartSec: 40, sourceEndSec: 65, audioMode: "voiceover_only" },
      { evidenceId: "e3", duration: 32, sourceStartSec: 20, sourceEndSec: 52, audioMode: "original_audio" }
    ]
  },
  evidencePayload
});
assert.strictEqual(backwardBodyIndependent.metrics.postHookBackwardJumpCount, 1);
assert.ok(backwardBodyIndependent.issues.some((issue) => issue.includes("nhảy ngược timeline")));

const justifiedNonlinearIndependent = scoreManualGeminiVariant({
  expectedScriptId: 4,
  script: {
    ...script,
    scriptId: 4,
    timeline_policy: "story_driven_non_linear_with_explicit_bridges",
    narration_arc: {
      beats: [{ narrationBeatId: "n1" }]
    },
    segments: [
      { storyFunction: "hook", transitionReason: "Opening." },
      { storyFunction: "context", narrationBeatId: "n1", transitionReason: "Rewind to the cause.", transitionExplainedBy: "voiceover" },
      { storyFunction: "escalation", transitionReason: "Visual proof returns to the conflict.", transitionExplainedBy: "visual_match" }
    ]
  },
  normalizedScript: {
    totalDuration: 65,
    segments: [
      { evidenceId: "e1", duration: 8, sourceStartSec: 100, sourceEndSec: 108, audioMode: "original_audio" },
      { evidenceId: "e2", duration: 25, sourceStartSec: 40, sourceEndSec: 65, audioMode: "voiceover_only" },
      { evidenceId: "e3", duration: 32, sourceStartSec: 20, sourceEndSec: 52, audioMode: "original_audio" }
    ]
  },
  evidencePayload
});
assert.strictEqual(justifiedNonlinearIndependent.metrics.postHookBackwardJumpCount, 1);
assert.strictEqual(justifiedNonlinearIndependent.metrics.postHookUnjustifiedBackwardJumpCount, 0);
assert.ok(!justifiedNonlinearIndependent.issues.some((issue) => issue.includes("nhảy ngược timeline chưa")));

const flexibleSeriesHook = scoreManualGeminiVariant({
  expectedScriptId: 1,
  script: {
    scriptId: 1,
    prompt_profile: "serialized_interleaved",
    series_mode: "interleaved_multipart",
    part_number: 1,
    shared_hook_enabled: true,
    story_blueprint: {
      macroBlocks: [{ macroBlockId: "m1" }, { macroBlockId: "m2" }, { macroBlockId: "m3" }]
    },
    segments: [
      { storyFunction: "hook", macroBlockId: "m1", transitionReason: "The complete confrontation opens the case." },
      { storyFunction: "escalation", macroBlockId: "m2", transitionReason: "The response follows the confrontation." },
      { storyFunction: "consequence", macroBlockId: "m3", transitionReason: "The consequence resolves the response." }
    ]
  },
  normalizedScript: {
    totalDuration: 65,
    segments: [
      { evidenceId: "e1", duration: 5.5, sourceStartSec: 100, sourceEndSec: 105.5, audioMode: "original_audio" },
      { evidenceId: "e2", duration: 29.5, sourceStartSec: 105.5, sourceEndSec: 135, audioMode: "original_audio", sustainedBeatOverride: true },
      { evidenceId: "e3", duration: 30, sourceStartSec: 135, sourceEndSec: 165, audioMode: "original_audio", sustainedBeatOverride: true }
    ]
  },
  evidencePayload
});
assert.ok(!flexibleSeriesHook.issues.some((issue) => issue.includes("Cold Open")));
assert.strictEqual(flexibleSeriesHook.metrics.hookDurationSec, 5.5);

const seriesHookUpToThirtySeconds = scoreManualGeminiVariant({
  expectedScriptId: 1,
  script: {
    scriptId: 1,
    series_mode: "interleaved_multipart",
    part_number: 1,
    shared_hook_enabled: true,
    story_blueprint: { macroBlocks: [{ macroBlockId: "m1" }, { macroBlockId: "m2" }, { macroBlockId: "m3" }] },
    segments: script.segments
  },
  normalizedScript: {
    totalDuration: 75,
    segments: [
      { evidenceId: "", duration: 24, sourceStartSec: 100, sourceEndSec: 124, audioMode: "original_audio" },
      { evidenceId: "", duration: 25, sourceStartSec: 124, sourceEndSec: 149, audioMode: "original_audio" },
      { evidenceId: "", duration: 26, sourceStartSec: 149, sourceEndSec: 175, audioMode: "original_audio" }
    ]
  },
  evidencePayload: null
});
assert.ok(!seriesHookUpToThirtySeconds.issues.some((issue) => issue.includes("Cold Open")));
assert.ok(!seriesHookUpToThirtySeconds.issues.some((issue) => issue.includes("Hook chỉ đạt")));
assert.strictEqual(seriesHookUpToThirtySeconds.metrics.hookScore, null);
assert.strictEqual(seriesHookUpToThirtySeconds.metrics.hookScoreMeasured, false);
assert.ok(!seriesHookUpToThirtySeconds.issues.some((issue) => issue.includes("Climax/Consequence")));

const sameRunBoundaries = scoreManualGeminiVariant({
  script: {
    ...script,
    segments: script.segments.map((item) => ({ ...item, sourceRunId: "shared_run" }))
  },
  normalizedScript: {
    totalDuration: 65,
    segments: normalizedScript.segments.map((item, index) => ({
      ...item,
      sourceStartSec: index * 100,
      sourceEndSec: index * 100 + item.duration
    }))
  },
  evidencePayload
});
assert.strictEqual(sameRunBoundaries.metrics.sourceJumpCount, 0);

const longMiniDoc = scoreManualGeminiVariant({
  expectedScriptId: 3,
  script: {
    scriptId: 3,
    story_blueprint: { macroBlocks: [{ macroBlockId: "m1" }, { macroBlockId: "m2" }, { macroBlockId: "m3" }] },
    segments: [
      { storyFunction: "hook", macroBlockId: "m1", transitionReason: "Opening." },
      { storyFunction: "escalation", macroBlockId: "m2", transitionReason: "The evidence escalates the case." },
      { storyFunction: "consequence", macroBlockId: "m3", transitionReason: "The arrest resolves it." }
    ]
  },
  normalizedScript: {
    totalDuration: 180,
    segments: [
      { evidenceId: "e1", duration: 20, sourceStartSec: 0, sourceEndSec: 20, audioMode: "original_audio" },
      { evidenceId: "e2", duration: 80, sourceStartSec: 20, sourceEndSec: 100, audioMode: "original_audio" },
      { evidenceId: "e3", duration: 80, sourceStartSec: 100, sourceEndSec: 180, audioMode: "original_audio" }
    ]
  },
  evidencePayload
});
assert.strictEqual(longMiniDoc.metrics.scriptId, 3);
assert.ok(!longMiniDoc.issues.some((issue) => issue.includes("Tổng thời lượng")));

const overlongShortProfile = scoreManualGeminiVariant({
  expectedScriptId: 4,
  script: { scriptId: 4, story_blueprint: { macroBlocks: [{ macroBlockId: "m1" }] }, segments: script.segments },
  normalizedScript: { ...normalizedScript, totalDuration: 180 },
  evidencePayload
});
assert.ok(overlongShortProfile.issues.some((issue) => issue.includes("vượt vùng ưu tiên")));

const fragmented = scoreManualGeminiVariant({
  script: { segments: [{}, {}, {}, {}, {}, {}] },
  normalizedScript: {
    totalDuration: 18,
    segments: Array.from({ length: 6 }, (_, index) => ({
      evidenceId: index === 0 ? "e1" : "",
      duration: 3,
      sourceStartSec: index * 100,
      sourceEndSec: index * 100 + 3,
      audioMode: index === 0 ? "voiceover_only" : "original_audio"
    }))
  },
  evidencePayload
});
assert.ok(fragmented.score < strong.score);
assert.strictEqual(fragmented.metrics.monetizationEligible, false);
assert.strictEqual(fragmented.metrics.durationWithinProfile, false);
assert.strictEqual(fragmented.passed, false);
assert.ok(fragmented.issues.some((issue) => issue.includes("băm vụn")));
assert.strictEqual(fragmented.diagnostics.sourceJumps.length, 5);
assert.deepStrictEqual(
  fragmented.diagnostics.shortFragments.map((item) => item.segment),
  [1, 2, 3, 4, 5, 6]
);
assert.strictEqual(rankManualGeminiVariants([
  { id: "weak", viralPreflight: fragmented },
  { id: "strong", viralPreflight: strong }
])[0].id, "strong");

const mismatchedGrounding = measureVoiceGrounding(
  "The suspect emerged again armed with a machete and ready to fight.",
  {
    visualFacts: ["On-screen text displays the suspect's mugshot and a list of legal charges."],
    storyMeaning: "Provides the legal resolution and formal charges.",
    keywords: ["charges", "mugshot", "sentencing"]
  }
);
assert.ok(mismatchedGrounding.ratio < 0.42);
assert.ok(mismatchedGrounding.unsupported.includes("machete"));

const mismatchedVoice = scoreManualGeminiVariant({
  script: {
    segments: [
      { storyFunction: "hook", transitionReason: "Opening." },
      { storyFunction: "consequence", transitionReason: "The charges resolve the case." }
    ]
  },
  normalizedScript: {
    totalDuration: 17,
    segments: [
      { evidenceId: "e1", duration: 9, sourceStartSec: 53, sourceEndSec: 62, audioMode: "original_audio" },
      {
        evidenceId: "charges",
        duration: 8,
        sourceStartSec: 480,
        sourceEndSec: 488,
        audioMode: "voiceover_only",
        voiceoverText: "The suspect emerged again armed with a machete and ready to fight."
      }
    ]
  },
  evidencePayload: {
    evidence: [
      evidencePayload.evidence[0],
      {
        evidenceId: "charges",
        narrativePhase: "consequence",
        burnedTextPresent: true,
        visualFacts: ["On-screen text displays the suspect's mugshot and a list of legal charges."],
        storyMeaning: "Provides the legal resolution and formal charges.",
        keywords: ["charges", "mugshot", "sentencing"]
      }
    ]
  }
});
assert.strictEqual(mismatchedVoice.metrics.groundingFailureCount, 1);
assert.strictEqual(mismatchedVoice.metrics.burnedTextConflictCount, 1);
assert.strictEqual(mismatchedVoice.diagnostics.groundingFailures[0].segment, 2);
assert.ok(mismatchedVoice.diagnostics.groundingFailures[0].unsupportedClaims.includes("machete"));
assert.strictEqual(mismatchedVoice.diagnostics.burnedTextConflicts[0].segment, 2);

const protectedActionSequence = scoreManualGeminiVariant({
  expectedScriptId: 1,
  script: {
    scriptId: 1,
    series_mode: "interleaved_multipart",
    part_number: 1,
    series_pacing: "strict_10",
    segments: [
      { storyFunction: "hook", actionOverride: true, transitionReason: "The escape starts the story." },
      { storyFunction: "escalation", transitionReason: "The pursuit continues." },
      { storyFunction: "consequence", transitionReason: "The arrest resolves the pursuit." }
    ]
  },
  normalizedScript: {
    totalDuration: 65,
    segments: [
      { evidenceId: "action", duration: 24, sourceStartSec: 100, sourceEndSec: 124, audioMode: "original_audio", actionOverride: true },
      { evidenceId: "bridge", duration: 10, sourceStartSec: 124, sourceEndSec: 134, audioMode: "original_audio" },
      { evidenceId: "end", duration: 31, sourceStartSec: 134, sourceEndSec: 165, audioMode: "original_audio" }
    ]
  },
  evidencePayload: {
    evidence: [
      { evidenceId: "action", narrativePhase: "hook", mustInclude: true, actionOverride: true, completeBeat: true },
      { evidenceId: "bridge", narrativePhase: "escalation", completeBeat: true },
      { evidenceId: "end", narrativePhase: "consequence", completeBeat: true }
    ]
  }
});
assert.strictEqual(protectedActionSequence.metrics.protectedActionRunCount, 1);
assert.strictEqual(protectedActionSequence.metrics.oversizedSeriesAudioRunCount, 0);

const omittedEssentialAction = scoreManualGeminiVariant({
  script,
  normalizedScript,
  evidencePayload: {
    evidence: [
      ...evidencePayload.evidence,
      { evidenceId: "missing_action", mustInclude: true, actionOverride: true, narrativePhase: "escalation" }
    ]
  }
});
assert.strictEqual(omittedEssentialAction.metrics.missingEssentialActionEvidenceCount, 1);
assert.ok(omittedEssentialAction.issues.some((issue) => issue.includes("missing_action")));

const protectedEmotionalBeat = scoreManualGeminiVariant({
  expectedScriptId: 3,
  script: {
    scriptId: 3,
    series_mode: "interleaved_multipart",
    part_number: 2,
    series_pacing: "strict_10",
    segments: [
      { storyFunction: "hook", transitionReason: "The confrontation opens the Part." },
      { storyFunction: "context", transitionReason: "The bridge establishes the dispute." },
      {
        storyFunction: "escalation",
        transitionReason: "The complete confession reveals the turning point.",
        completeNarrativeBeat: true,
        sustainedBeatId: "confession_01",
        sustainedBeatOverride: true
      },
      { storyFunction: "consequence", transitionReason: "The consequence follows the confession." }
    ]
  },
  normalizedScript: {
    totalDuration: 65,
    segments: [
      { evidenceId: "hook", duration: 10, sourceStartSec: 0, sourceEndSec: 10, audioMode: "original_audio" },
      { evidenceId: "context", duration: 10, sourceStartSec: 10, sourceEndSec: 20, audioMode: "voiceover_only" },
      { evidenceId: "confession", duration: 35, sourceStartSec: 20, sourceEndSec: 55, audioMode: "original_audio", sustainedBeatOverride: true },
      { evidenceId: "ending", duration: 10, sourceStartSec: 55, sourceEndSec: 65, audioMode: "voiceover_only" }
    ]
  },
  evidencePayload: {
    evidence: [
      { evidenceId: "hook", narrativePhase: "hook", completeBeat: true },
      { evidenceId: "context", narrativePhase: "context", completeBeat: true },
      { evidenceId: "confession", narrativePhase: "escalation", completeBeat: true },
      { evidenceId: "ending", narrativePhase: "consequence", completeBeat: true }
    ]
  }
});
assert.strictEqual(protectedEmotionalBeat.metrics.oversizedSeriesAudioRunCount, 0);
assert.strictEqual(protectedEmotionalBeat.metrics.protectedSustainedBeatRunCount, 1);
assert.ok(protectedEmotionalBeat.strengths.some((item) => item.includes("complete narrative beat")));

const confusedPostHookActors = scoreManualGeminiVariant({
  expectedScriptId: 1,
  script: {
    prompt_profile: "independent",
    scriptId: 1,
    audio_strategy: "clean_hybrid",
    voiceover_enabled: true,
    source_narrator_policy: "forbidden",
    hook_cold_viewer_test: {
      passes: true,
      identifiedActor: "The mother",
      identifiedConflict: "She challenges the officer",
      identifiedStake: "Her daughter is handcuffed"
    },
    hook_transition_test: {
      passes: true,
      hookActorIds: ["mother"],
      postHookActorIds: ["rashad"],
      timelineResetUsed: true,
      relationshipExplained: false,
      bridgeText: "Police arrived to break up a fight.",
      first15SecCausalLink: "The video resets to earlier events."
    },
    actor_identity_map: [
      { actorId: "mother", displayLabel: "Kimora's mother", role: "parent", relationshipFacts: ["mother of Kimora"] },
      { actorId: "rashad", displayLabel: "Rashad", role: "suspect", relationshipFacts: ["brother of Kimora"] }
    ],
    story_blueprint: { macroBlocks: [{ macroBlockId: "m1" }, { macroBlockId: "m2" }, { macroBlockId: "m3" }] },
    segments: [
      { storyFunction: "hook", macroBlockId: "m1", actor_ids: ["mother"], primary_actor_id: "mother", speaker_actor_id: "mother", transitionReason: "Opening." },
      { storyFunction: "context", macroBlockId: "m2", actor_ids: ["rashad"], primary_actor_id: "rashad", speaker_actor_id: "", transitionReason: "Police arrived to break up a fight." },
      { storyFunction: "escalation", macroBlockId: "m2", actor_ids: ["rashad"], primary_actor_id: "rashad", speaker_actor_id: "rashad", transitionReason: "The argument continues." },
      { storyFunction: "consequence", macroBlockId: "m3", actor_ids: ["mother"], primary_actor_id: "mother", speaker_actor_id: "mother", transitionReason: "The mother returns." }
    ]
  },
  normalizedScript: {
    totalDuration: 65,
    segments: [
      { evidenceId: "e1", duration: 6, sourceStartSec: 356, sourceEndSec: 362, audioMode: "original_audio", actorIds: ["mother"], primaryActorId: "mother", speakerActorId: "mother" },
      { evidenceId: "e2", duration: 6, sourceStartSec: 0, sourceEndSec: 6, audioMode: "voiceover_only", voiceoverText: "Police arrived to break up a fight.", actorIds: ["rashad"], primaryActorId: "rashad" },
      { evidenceId: "e2", duration: 23, sourceStartSec: 6, sourceEndSec: 29, audioMode: "original_audio", actorIds: ["rashad"], primaryActorId: "rashad", speakerActorId: "rashad" },
      { evidenceId: "e3", duration: 30, sourceStartSec: 440, sourceEndSec: 470, audioMode: "voiceover_only", voiceoverText: "Her mother finally learns what happened.", actorIds: ["mother"], primaryActorId: "mother", speakerActorId: "mother" }
    ]
  },
  evidencePayload
});
assert.strictEqual(confusedPostHookActors.metrics.hookTransitionPassed, false);
assert.strictEqual(confusedPostHookActors.metrics.hookTransitionIntroducedActorCount, 1);
assert.ok(confusedPostHookActors.issues.some((issue) => issue.includes("Hook Transition Gate")));

const protectedDialogueMutedByVoiceover = scoreManualGeminiVariant({
  expectedScriptId: 3,
  script: {
    prompt_profile: "independent",
    scriptId: 3,
    source_narrator_policy: "forbidden",
    actor_identity_map: [{ actorId: "suspect", displayLabel: "The suspect", role: "suspect" }],
    hook_transition_test: {
      passes: true,
      hookActorIds: ["suspect"],
      postHookActorIds: ["suspect"],
      timelineResetUsed: false,
      relationshipExplained: true,
      bridgeText: "The same suspect continues arguing.",
      first15SecCausalLink: "The confrontation continues without a timeline jump."
    },
    story_blueprint: { macroBlocks: [{ macroBlockId: "m1" }, { macroBlockId: "m2" }, { macroBlockId: "m3" }] },
    segments: [
      { storyFunction: "hook", macroBlockId: "m1", actor_ids: ["suspect"], primary_actor_id: "suspect", speaker_actor_id: "suspect", transitionReason: "Opening." },
      { storyFunction: "escalation", macroBlockId: "m2", actor_ids: ["suspect"], primary_actor_id: "suspect", speaker_actor_id: "suspect", speech_type: "direct_scene_dialogue", original_audio_protected: true, original_audio_value_score: 9, original_audio_value_reason: "The suspect's decisive denial", transitionReason: "The denial escalates the stop." },
      { storyFunction: "consequence", macroBlockId: "m3", actor_ids: ["suspect"], primary_actor_id: "suspect", transitionReason: "The consequence follows." }
    ]
  },
  normalizedScript: {
    totalDuration: 90,
    segments: [
      { evidenceId: "e1", duration: 10, sourceStartSec: 0, sourceEndSec: 10, audioMode: "original_audio", actorIds: ["suspect"] },
      { evidenceId: "e2", duration: 10, sourceStartSec: 10, sourceEndSec: 20, audioMode: "voiceover_only", voiceoverText: "The suspect denies everything.", actorIds: ["suspect"], originalAudioProtected: true, originalAudioValueScore: 9, originalAudioValueReason: "The suspect's decisive denial" },
      { evidenceId: "e3", duration: 70, sourceStartSec: 20, sourceEndSec: 90, audioMode: "original_audio", actorIds: ["suspect"] }
    ]
  },
  evidencePayload
});
assert.strictEqual(protectedDialogueMutedByVoiceover.metrics.protectedOriginalAudioViolationCount, 1);
assert.ok(protectedDialogueMutedByVoiceover.issues.some((issue) => issue.includes("giá trị cao")));

const hookPriorityAudit = scoreManualGeminiVariant({
  expectedScriptId: 1,
  script: {
    prompt_profile: "independent",
    scriptId: 1,
    source_narrator_policy: "forbidden",
    independent_prompt_options: {
      hookPriority: ["psychological_wtf", "dialogue_conflict", "high_action", "evidence_reveal"],
      hookMaxSec: 18,
      durations: {
        script1: { min: 60.5, max: 120 },
        script3: { min: 90, max: 240 },
        script4: { min: 60.5, max: 120 }
      }
    },
    hook_selection_audit: {
      requestedPriority: ["psychological_wtf", "dialogue_conflict", "high_action", "evidence_reveal"],
      selectedType: "dialogue_conflict",
      fallbackLevel: 2,
      selectedEvidenceIds: ["e2"],
      reason: "No psychologically absurd quote was intelligible without source narration.",
      rejectedHigherPriorityCandidates: [{
        type: "psychological_wtf",
        evidenceIds: ["e1"],
        reason: "The source narrator overlaps the only candidate."
      }]
    },
    hook_cold_viewer_test: {
      passes: true,
      identifiedActor: "The suspect",
      identifiedConflict: "He argues with the officer",
      identifiedStake: "The search"
    },
    hook_transition_test: {
      passes: true,
      hookActorIds: [],
      postHookActorIds: [],
      timelineResetUsed: false,
      relationshipExplained: true,
      bridgeText: "The same stop continues.",
      first15SecCausalLink: "The officer answers the suspect's claim."
    },
    story_blueprint: { macroBlocks: [{ macroBlockId: "m1" }, { macroBlockId: "m2" }, { macroBlockId: "m3" }] },
    segments: [
      { storyFunction: "hook", macroBlockId: "m1", transitionReason: "Opening." },
      { storyFunction: "hook", macroBlockId: "m1", transitionReason: "The same Hook continues." },
      { storyFunction: "context", macroBlockId: "m2", transitionReason: "The stop continues." },
      { storyFunction: "consequence", macroBlockId: "m3", transitionReason: "The verified result follows." }
    ]
  },
  normalizedScript: {
    totalDuration: 65,
    segments: [
      { evidenceId: "e1", duration: 8, sourceStartSec: 20, sourceEndSec: 28, audioMode: "original_audio" },
      { evidenceId: "e2", duration: 8, sourceStartSec: 28, sourceEndSec: 36, audioMode: "original_audio" },
      { evidenceId: "e3", duration: 20, sourceStartSec: 0, sourceEndSec: 20, audioMode: "voiceover_only", voiceoverText: "The officer stopped him moments earlier." },
      { evidenceId: "e4", duration: 29, sourceStartSec: 36, sourceEndSec: 65, audioMode: "original_audio" }
    ]
  },
  evidencePayload: { evidence: [] }
});
assert.strictEqual(hookPriorityAudit.metrics.hookDurationSec, 16);
assert.strictEqual(hookPriorityAudit.metrics.hookSelectedType, "dialogue_conflict");
assert.strictEqual(hookPriorityAudit.metrics.hookFallbackLevel, 2);
assert.strictEqual(hookPriorityAudit.metrics.hookSelectionAuditPassed, true);
assert.ok(hookPriorityAudit.strengths.some((item) => item.includes("priority fallback")));

const contractEvidencePayload = {
  evidence: [
    { evidenceId: "hook", narrativePhase: "hook", hookScore: 9, completeBeat: true, stakeRole: "threat_open", opensQuestion: "Is the child safe?" },
    { evidenceId: "context", narrativePhase: "escalation", completeBeat: true },
    { evidenceId: "victim_safe", narrativePhase: "resolution", completeBeat: true, stakeRole: "victim_resolution", resolvesQuestion: "Is the child safe?", resolutionModality: "visual", visualProofScore: 9 },
    { evidenceId: "victim_verbal", narrativePhase: "resolution", completeBeat: true, stakeRole: "victim_resolution", resolvesQuestion: "Is the child safe?", resolutionModality: "verbal", visualProofScore: 2 },
    { evidenceId: "arrest", narrativePhase: "consequence", completeBeat: true, stakeRole: "legal_resolution" }
  ]
};
const contractScript = {
  ...script,
  scriptId: 3,
  audio_strategy: "standard",
  voiceover_enabled: true,
  narrative_contract: {
    hookPromise: "A child appears to be in immediate danger.",
    primaryAudienceQuestion: "Is the child safe?",
    primaryStakeType: "victim_safety",
    stakeActorIds: ["child"],
    mandatoryResolution: {
      required: true,
      resolutionType: "victim_resolution",
      evidenceIds: ["victim_safe"],
      preferredVisualEvidenceIds: ["victim_safe"],
      fallbackVerbalEvidenceIds: ["victim_verbal"],
      visualFirstRequired: true,
      mustAppearBeforeLaterTimeJump: true,
      verifiedOutcome: "The child is safely removed."
    }
  },
  story_blueprint: { macroBlocks: [{ macroBlockId: "mh" }, { macroBlockId: "mc" }, { macroBlockId: "mr" }, { macroBlockId: "ml" }] },
  segments: [
    { storyFunction: "hook", timelinePhase: "hook", macroBlockId: "mh", transitionReason: "Open the threat." },
    { storyFunction: "escalation", timelinePhase: "immediate_event", macroBlockId: "mc", transitionReason: "Explain the danger." },
    { storyFunction: "resolution", timelinePhase: "immediate_resolution", bridgePurpose: "stake_resolution", macroBlockId: "mr", transitionReason: "Resolve the child's safety." },
    { storyFunction: "consequence", timelinePhase: "later_outcome", macroBlockId: "ml", transitionReason: "Then show the arrest." }
  ]
};
const contractNormalized = {
  totalDuration: 65,
  segments: [
    { evidenceId: "hook", duration: 8, sourceStartSec: 100, sourceEndSec: 108, audioMode: "original_audio" },
    { evidenceId: "context", duration: 20, sourceStartSec: 0, sourceEndSec: 20, audioMode: "voiceover_only", voiceoverText: "Officers discover why the child may be in danger." },
    { evidenceId: "victim_safe", duration: 12, sourceStartSec: 50, sourceEndSec: 62, audioMode: "voiceover_only", voiceoverText: "The child is safely removed from the immediate danger." },
    { evidenceId: "arrest", duration: 25, sourceStartSec: 200, sourceEndSec: 225, audioMode: "original_audio" }
  ]
};
const closedContract = scoreManualGeminiVariant({
  script: contractScript,
  normalizedScript: contractNormalized,
  evidencePayload: contractEvidencePayload,
  expectedScriptId: 3
});
assert.strictEqual(closedContract.metrics.stakeResolutionPassed, true);
assert.strictEqual(closedContract.metrics.resolutionBeforeLaterTimeJump, true);
assert.strictEqual(closedContract.metrics.justifiedSourceJumpCount >= 1, true);
assert.strictEqual(closedContract.metrics.visualPayoffPassed, true);

const verbalOnlyContract = scoreManualGeminiVariant({
  script: {
    ...contractScript,
    narrative_contract: {
      ...contractScript.narrative_contract,
      mandatoryResolution: {
        ...contractScript.narrative_contract.mandatoryResolution,
        evidenceIds: ["victim_verbal"]
      }
    }
  },
  normalizedScript: {
    ...contractNormalized,
    segments: contractNormalized.segments.map((segment, index) => index === 2
      ? { ...segment, evidenceId: "victim_verbal" }
      : segment)
  },
  evidencePayload: contractEvidencePayload,
  expectedScriptId: 3
});
assert.strictEqual(verbalOnlyContract.metrics.stakeResolutionPassed, true);
assert.strictEqual(verbalOnlyContract.metrics.visualPayoffPassed, false);
assert.ok(verbalOnlyContract.issues.some((issue) => issue.includes("Visual Payoff Gate")));

const missingContractPayoff = scoreManualGeminiVariant({
  script: { ...contractScript, segments: contractScript.segments.filter((_item, index) => index !== 2) },
  normalizedScript: { ...contractNormalized, segments: contractNormalized.segments.filter((_item, index) => index !== 2) },
  evidencePayload: contractEvidencePayload,
  expectedScriptId: 3
});
assert.strictEqual(missingContractPayoff.metrics.stakeResolutionPassed, false);
assert.ok(missingContractPayoff.issues.some((issue) => issue.includes("thiếu payoff evidence")));

const lateContractPayoff = scoreManualGeminiVariant({
  script: { ...contractScript, segments: [contractScript.segments[0], contractScript.segments[1], contractScript.segments[3], contractScript.segments[2]] },
  normalizedScript: { ...contractNormalized, segments: [contractNormalized.segments[0], contractNormalized.segments[1], contractNormalized.segments[3], contractNormalized.segments[2]] },
  evidencePayload: contractEvidencePayload,
  expectedScriptId: 3
});
assert.strictEqual(lateContractPayoff.metrics.resolutionBeforeLaterTimeJump, false);
assert.ok(lateContractPayoff.issues.some((issue) => issue.includes("sai thứ tự")));

const jargonDeadZone = scoreManualGeminiVariant({
  script: contractScript,
  normalizedScript: contractNormalized,
  evidencePayload: {
    evidence: contractEvidencePayload.evidence.map((item) => item.evidenceId === "context"
      ? { ...item, containsUnexplainedJargon: true, jargonTerms: ["10-32"], visualRetentionScore: 3 }
      : item)
  },
  expectedScriptId: 3
});
assert.strictEqual(jargonDeadZone.metrics.jargonIssueCount, 1);
assert.strictEqual(jargonDeadZone.metrics.jargonDeadZoneCount, 1);

const proceduralDeadZone = scoreManualGeminiVariant({
  script: contractScript,
  normalizedScript: contractNormalized,
  evidencePayload: {
    evidence: contractEvidencePayload.evidence.map((item) => item.evidenceId === "context"
      ? {
        ...item,
        proceduralBloat: true,
        proceduralBloatType: "written_statement",
        retentionScore: 2,
        dialogueEvidence: [{ text: "Come into the police department and fill out a written statement." }]
      }
      : item)
  },
  expectedScriptId: 3
});
assert.strictEqual(proceduralDeadZone.metrics.proceduralBloatSegmentCount, 1);
assert.ok(proceduralDeadZone.issues.some((issue) => issue.includes("retention dead zone")));

const unchangedFailedV2 = scoreManualGeminiVariant({
  script: contractScript,
  normalizedScript: contractNormalized,
  evidencePayload: contractEvidencePayload,
  expectedScriptId: 3,
  previousNormalizedScript: contractNormalized,
  previousPreflight: {
    metrics: { stakeResolutionPassed: false },
    scoreBreakdown: { editorialReadiness: { score: 45 } },
    issues: ["Narrative Contract chưa đóng."]
  }
});
assert.strictEqual(unchangedFailedV2.metrics.structuralRebuildRequired, true);
assert.strictEqual(unchangedFailedV2.metrics.structuralRebuildPassed, false);
assert.ok(unchangedFailedV2.issues.some((issue) => issue.includes("không chỉ sửa câu chữ")));

const excessiveVoiceSlowdown = scoreManualGeminiVariant({
  script: {
    ...contractScript,
    segments: contractScript.segments.map((segment, index) => index === 1
      ? {
        ...segment,
        id: "voice_too_long",
        voiceover_text: "This sentence contains far too many spoken words for such a tiny visual source window."
      }
      : segment)
  },
  normalizedScript: {
    ...contractNormalized,
    segments: contractNormalized.segments.map((segment, index) => index === 1
      ? {
        ...segment,
        id: "voice_too_long",
        duration: 1.5,
        audioMode: "voiceover_only",
        voiceoverText: "This sentence contains far too many spoken words for such a tiny visual source window."
      }
      : segment)
  },
  evidencePayload: contractEvidencePayload,
  expectedScriptId: 3,
  voiceProfile: { wordsPerSecond: 2.7, conservativeWordsPerSecond: 2.5, sampleCount: 20 }
});
assert.strictEqual(excessiveVoiceSlowdown.metrics.estimatedVoiceTimingRiskCount, 1);
assert.strictEqual(excessiveVoiceSlowdown.metrics.voiceProfileWordsPerSecond, 2.5);
assert.ok(excessiveVoiceSlowdown.issues.some((issue) => issue.includes("Voice budget cảnh báo")));

const failedDraftCoverageAndDelayedHook = scoreManualGeminiVariant({
  script: {
    ...contractScript,
    inputAccessAudit: {
      accessGranted: true,
      stage: "draft_review_story_spine",
      expectedDraftDurationSec: 65,
      inspectedInputs: [{
        name: "draft-v1.mp4",
        role: "draft",
        opened: true,
        parsed: true,
        coverageStartSec: 0,
        coverageEndSec: 0
      }]
    },
    hookTriggerAudit: {
      verifiedAgainstHookAuditClip: false,
      triggerSourceSec: 107,
      hookInPointSec: 100,
      setupBeforeTriggerSec: 7
    },
    teaserClimaxAudit: {
      teaserEventId: "arrest_01",
      climaxEventId: "arrest_01",
      reprisePolicy: "repeat_setup",
      allowedReplaySec: 0.5
    }
  },
  normalizedScript: contractNormalized,
  evidencePayload: contractEvidencePayload,
  expectedScriptId: 3
});
assert.strictEqual(failedDraftCoverageAndDelayedHook.metrics.draftAccessCoveragePassed, false);
assert.strictEqual(failedDraftCoverageAndDelayedHook.metrics.hookTriggerLatencySec, 7);
assert.strictEqual(failedDraftCoverageAndDelayedHook.metrics.teaserClimaxHandoffPassed, false);
assert.ok(failedDraftCoverageAndDelayedHook.issues.some((issue) => issue.includes("Draft Access Gate")));
assert.ok(failedDraftCoverageAndDelayedHook.issues.some((issue) => issue.includes("Hook Trigger Gate lỗi nặng")));
assert.ok(failedDraftCoverageAndDelayedHook.issues.some((issue) => issue.includes("Teaser-Climax Handoff")));

console.log("manualGeminiViralPreflight tests passed");
