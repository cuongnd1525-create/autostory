const assert = require("assert");

const {
  buildSceneReferenceAss,
  buildSourceRuns,
  normalizeManifest,
  formatTimestamp,
  validateSceneEvidence,
  evaluateEvidenceQuality,
  validateStoryBlueprint,
  buildStoryBlueprintPrompt,
  buildSingleVariantPrompt,
  buildLockedEvidenceScriptPrompt,
  buildPass1JsonFilePrompt,
  buildDirectHighlightScriptsPrompt,
  buildProxyChunkPlan,
  partitionProxyChunksForUpload
} = require("../electron/services/manualGeminiPackService");
const {
  validateManualGeminiScript,
  coalesceContiguousOriginalAudioSegments,
  normalizeHighlightCutScript
} = require("../electron/services/dubbingService");
const {
  parseGeminiJsonObject,
  unwrapStoryScript,
  detectGeminiArtifact
} = require("../electron/services/geminiJsonArtifactService");
const {
  resolveScriptProfile
} = require("../electron/services/manualGeminiViralPreflightService");

assert.strictEqual(formatTimestamp(65.123), "00:01:05.123");
const parsedFencedScript = parseGeminiJsonObject(
  '```json\n{"data":{"artifactType":"story_recut_script","segments":[{"id":"one"}]}}\n```',
  "wrapped.json"
);
assert.strictEqual(unwrapStoryScript(parsedFencedScript).segments.length, 1);
assert.strictEqual(detectGeminiArtifact(parsedFencedScript).type, "story_recut_script");
assert.strictEqual(detectGeminiArtifact({
  artifactType: "scene_evidence",
  evidence: [{ evidenceId: "evidence_0001" }]
}).type, "scene_evidence");
assert.strictEqual(detectGeminiArtifact({
  artifactType: "diy_visual_process_map",
  visualBeats: [{ visualBeatId: "beat_0001" }]
}).type, "diy_visual_process_map");
assert.strictEqual(detectGeminiArtifact({
  artifactType: "diy_story_blueprint",
  blocks: [{ blockId: "block_01" }]
}).type, "diy_story_blueprint");
const accessFailureArtifact = detectGeminiArtifact({
  artifactType: "gemini_input_access_failure",
  stage: "scene_evidence",
  accessGranted: false,
  missingInputs: ["source-transcript.srt"],
  recommendedAction: "Attach the transcript."
});
assert.strictEqual(accessFailureArtifact.type, "gemini_input_access_failure");
assert.deepStrictEqual(accessFailureArtifact.missingInputs, ["source-transcript.srt"]);
const diyScriptArtifact = detectGeminiArtifact({
  artifactType: "highlight_cut_script",
  workflow: "diy_story_remix",
  segments: [{ id: "diy_0001" }]
});
assert.strictEqual(diyScriptArtifact.type, "story_recut_script");
assert.strictEqual(diyScriptArtifact.workflow, "diy_story_remix");
const directHighlightPrompt = buildDirectHighlightScriptsPrompt("DIRECT SCRIPT RULES", {
  sourceVideo: "input.mp4",
  videoDurationSec: 15.8,
  scenes: [{ sceneId: "scene_0001" }]
}, {
  candidates: [{ actionCandidateId: "action_0001", sourceStartSec: 2, sourceEndSec: 8, mustReview: true }]
});
assert.ok(directHighlightPrompt.includes("script-1.json"));
assert.ok(directHighlightPrompt.includes("script-3.json"));
assert.ok(directHighlightPrompt.includes("script-4.json"));
assert.ok(directHighlightPrompt.includes("JSON CODE-BLOCK CONTRACT - HIGHEST PRIORITY"));
assert.ok(directHighlightPrompt.includes("parse independently with JSON.parse"));

const independentDirectPrompt = buildDirectHighlightScriptsPrompt(
  "DURABLE EDITORIAL QUALITY CORE - INDEPENDENT SCRIPTS ONLY\nINDEPENDENT RULES\nTHREE JSON CODE-BLOCK CONTRACT - HIGHEST PRIORITY\n- Return exactly three independent Markdown JSON code blocks and nothing else.\n- Do not output prose, headings, filename labels, explanations, tables, or text before, between, or after the three code blocks.",
  { sourceVideo: "source.mp4", videoDurationSec: 90, scenes: [] },
  { artifactType: "action_candidates", candidates: [{ actionCandidateId: "action_0001", mustReview: true }] }
);
assert.strictEqual((independentDirectPrompt.match(/^JSON CODE-BLOCK CONTRACT - HIGHEST PRIORITY$/gm) || []).length, 1);
assert.strictEqual((independentDirectPrompt.match(/DIRECT HIGHLIGHT CONTENT RULES:/g) || []).length, 1);
assert.strictEqual((independentDirectPrompt.match(/LOCAL ACTION CANDIDATES:/g) || []).length, 1);
assert.ok(independentDirectPrompt.includes("INDEPENDENT RULES"));
assert.ok(independentDirectPrompt.includes("STORY SPINE COMPILER INPUT CONTRACT - INDEPENDENT SCRIPTS ONLY"));
assert.ok(independentDirectPrompt.includes("Return narrativeBeats, not renderer segments"));
assert.ok(independentDirectPrompt.includes("may cross consecutive scene-manifest boundaries"));
assert.ok(!independentDirectPrompt.includes("motionScore"));
assert.ok(!independentDirectPrompt.includes("audioEnergyScore"));
const customIndependentBasePrompt = `DURABLE EDITORIAL QUALITY CORE - INDEPENDENT SCRIPTS ONLY
INDEPENDENT_USER_OPTIONS_JSON_BEGIN
${JSON.stringify({
  hookPriority: ["psychological_wtf", "dialogue_conflict", "high_action", "evidence_reveal"],
  hookMaxSec: 18,
  narratorTone: "genz",
  audioBalance: "balanced",
  pacing: "story_first",
  ending: "payoff_comment",
  overlays: false,
  powerWords: "the audacity",
  durations: {
    script1: { min: 65, max: 100 },
    script3: { min: 100, max: 180 },
    script4: { min: 70, max: 105 }
  }
})}
INDEPENDENT_USER_OPTIONS_JSON_END
VOICE CALIBRATION PARAMETERS PROVIDED BY USER:
- measuredWordsPerSecond: 3.2`;
const customBlueprintPrompt = buildStoryBlueprintPrompt({
  evidencePayload: { evidence: [] },
  manifest: { sourceVideo: "source.mp4", videoDurationSec: 300 },
  basePrompt: customIndependentBasePrompt
});
assert.ok(customBlueprintPrompt.includes("psychological_wtf (absurd"));
assert.ok(customBlueprintPrompt.includes("4-18 seconds"));
assert.ok(customBlueprintPrompt.includes('"requestedPriority": ['));
assert.ok(customBlueprintPrompt.includes('"psychological_wtf"'));
const customScriptPrompt = buildSingleVariantPrompt({
  scriptId: 3,
  evidencePayload: { evidence: [] },
  blueprint: { artifactType: "story_blueprint", macroBlocks: [] },
  manifest: { sourceVideo: "source.mp4", videoDurationSec: 300 },
  basePrompt: customIndependentBasePrompt
});
assert.ok(customScriptPrompt.includes("Final duration: 100-180 seconds"));
assert.ok(customScriptPrompt.includes("HOOK PRIORITY FALLBACK - USER LOCKED"));
assert.ok(customScriptPrompt.includes("narratorTone=genz"));
assert.ok(customScriptPrompt.includes('"hook_selection_audit"'));
assert.ok(directHighlightPrompt.includes("Do not create scene-evidence.json"));
assert.ok(directHighlightPrompt.includes("action_0001"));
assert.ok(directHighlightPrompt.includes("VISUAL ACTION OVERRIDE"));
assert.ok(directHighlightPrompt.includes("ONE-SCENE-PER-SEGMENT TIMESTAMP GATE"));
assert.ok(directHighlightPrompt.includes("Never let one JSON segment cross a scene boundary"));

const longProxyManifest = {
  videoDurationSec: 964.836,
  scenes: Array.from({ length: 20 }, (_, index) => ({
    sceneId: `scene_${String(index + 1).padStart(4, "0")}`,
    startSec: index * 50,
    endSec: Math.min(964.836, (index + 1) * 50)
  }))
};
const proxyChunks = buildProxyChunkPlan(longProxyManifest);
assert.ok(proxyChunks.length >= 8);
assert.strictEqual(proxyChunks[0].sourceStartSec, 0);
assert.strictEqual(proxyChunks.at(-1).sourceEndSec, 964.836);
proxyChunks.forEach((chunk, index) => {
  assert.ok(chunk.durationSec <= 120);
  if (index) assert.strictEqual(chunk.sourceStartSec, proxyChunks[index - 1].sourceEndSec);
});
const mediumProxyChunks = buildProxyChunkPlan({ videoDurationSec: 480, scenes: [] });
assert.ok(mediumProxyChunks.length >= 4, "sources over 2 minutes are chunked for reliable AGY MAP turns");
mediumProxyChunks.forEach((chunk) => assert.ok(chunk.durationSec <= 120));
assert.strictEqual(partitionProxyChunksForUpload(proxyChunks).flat().length, proxyChunks.length);
const chunkedPrompt = buildDirectHighlightScriptsPrompt("DIRECT SCRIPT RULES", longProxyManifest, {
  candidates: []
}, {
  chunks: proxyChunks
});
assert.ok(chunkedPrompt.includes("CHUNKED VIDEO INPUT CONTRACT"));
assert.ok(chunkedPrompt.includes("local player time inside a chunk"));

const manifest = normalizeManifest({
  media: { duration: 15.8, width: 1080, height: 1920, hasAudio: true },
  sourceVideoPath: "C:\\video\\input.mp4",
  detector: "test",
  scenes: [
    { sceneId: "scene_0001", startSec: 0, endSec: 3.2 },
    { sceneId: "scene_0002", startSec: 3.2, endSec: 15.8 }
  ]
});

assert.strictEqual(manifest.timelineType, "source_timeline");
assert.strictEqual(manifest.videoDurationSec, 15.8);
assert.strictEqual(manifest.scenes.length, 2);
assert.strictEqual(manifest.scenes[1].durationSec, 12.6);

const sourceRunEvidence = [
  { evidenceId: "e1", sourceStartSec: 0, sourceEndSec: 3, narrativePhase: "hook" },
  { evidenceId: "e2", sourceStartSec: 3.5, sourceEndSec: 7, narrativePhase: "context" },
  { evidenceId: "e3", sourceStartSec: 20, sourceEndSec: 25, narrativePhase: "consequence" }
];
const sourceRuns = buildSourceRuns(sourceRunEvidence);
assert.strictEqual(sourceRuns.length, 2);
assert.strictEqual(sourceRunEvidence[0].sourceRunId, sourceRunEvidence[1].sourceRunId);
assert.notStrictEqual(sourceRunEvidence[1].sourceRunId, sourceRunEvidence[2].sourceRunId);
assert.strictEqual(sourceRunEvidence[0].nextEvidenceId, "e2");
assert.strictEqual(sourceRunEvidence[1].previousEvidenceId, "e1");

const ass = buildSceneReferenceAss(manifest.scenes);
assert.ok(ass.includes("scene_0001"));
assert.ok(ass.includes("SOURCE 00:00:00.000 - 00:00:03.200"));
assert.ok(ass.includes("Dialogue: 0,0:00:03.20,0:00:15.80"));

assert.doesNotThrow(() => validateManualGeminiScript({
  segments: [{
    sceneId: "scene_0002",
    sourceStartSec: 4,
    sourceEndSec: 8,
    startSec: 0,
    endSec: 4
  }]
}, manifest, "valid.json"));

const narratorSplit = validateManualGeminiScript({
  prompt_profile: "serialized_genz",
  series_mode: "interleaved_multipart",
  source_narrator_ranges: [{
    startSec: 6,
    endSec: 8,
    replacementText: "The verified source narrator explains the prior event.",
    confidence: "high"
  }],
  segments: [{
    id: "highlight_0001",
    sceneId: "scene_0002",
    sourceStartSec: 4,
    sourceEndSec: 10,
    startSec: 0,
    endSec: 6,
    playbackSpeed: 1,
    audio_mode: "original_audio",
    voiceover_text: ""
  }]
}, manifest, "narrator-split.json");
assert.strictEqual(narratorSplit.segments.length, 3);
assert.deepStrictEqual(
  narratorSplit.segments.map((segment) => segment.audio_mode),
  ["original_audio", "voiceover_only", "original_audio"]
);
assert.strictEqual(narratorSplit.segments[1].source_narrator_detected, true);
assert.strictEqual(narratorSplit.segments[1].forceSourceMute, true);
assert.strictEqual(
  narratorSplit.segments[1].voiceover_text,
  "The verified source narrator explains the prior event."
);

const partialNarratorRepair = validateManualGeminiScript({
  prompt_profile: "serialized_genz",
  series_mode: "interleaved_multipart",
  source_narrator_ranges: [{
    startSec: 6,
    endSec: 8,
    replacementText: "Verified narrator replacement."
  }],
  segments: [{
    sceneId: "scene_0002",
    sourceStartSec: 7,
    sourceEndSec: 10,
    startSec: 0,
    endSec: 3,
    playbackSpeed: 1,
    audio_mode: "original_audio"
  }]
}, manifest, "partial-narrator-overlap.json");
assert.strictEqual(partialNarratorRepair.segments.length, 2);
assert.deepStrictEqual(
  partialNarratorRepair.segments.map((segment) => segment.audio_mode),
  ["voiceover_only", "original_audio"]
);
assert.strictEqual(partialNarratorRepair.segments[0].sourceStartSec, 7);
assert.strictEqual(partialNarratorRepair.segments[0].sourceEndSec, 8);
assert.strictEqual(partialNarratorRepair.segments[0].voiceover_text, "Verified narrator replacement.");
assert.ok(partialNarratorRepair._toolValidationWarnings.some((item) => item.includes("tự sửa")));

const unverifiedNarratorRange = validateManualGeminiScript({
  prompt_profile: "independent",
  source_narrator_policy: "forbidden",
  source_narrator_ranges: [{ startSec: 4, endSec: 8 }],
  segments: [{
    sceneId: "scene_0002",
    sourceStartSec: 5,
    sourceEndSec: 7,
    startSec: 0,
    endSec: 2,
    playbackSpeed: 1,
    audio_mode: "original_audio",
    voiceover_text: ""
  }]
}, manifest, "unverified-narrator-range.json");
assert.strictEqual(unverifiedNarratorRange.segments[0].audio_mode, "original_audio");
assert.deepStrictEqual(unverifiedNarratorRange.source_narrator_ranges, []);
assert.ok(unverifiedNarratorRange._toolValidationWarnings.some((item) => item.includes("Timestamp đơn lẻ không đủ")));

const falseNarratorFlagRepair = validateManualGeminiScript({
  prompt_profile: "independent",
  source_narrator_policy: "forbidden",
  source_narrator_ranges: [{ startSec: 4, endSec: 8 }],
  segments: [{
    sceneId: "scene_0002",
    sourceStartSec: 5,
    sourceEndSec: 7,
    startSec: 0,
    endSec: 2,
    playbackSpeed: 1,
    audio_mode: "original_audio",
    voiceover_text: "",
    source_narrator_detected: true,
    previewVi: "Officer: New drug laws went into effect yesterday."
  }]
}, manifest, "false-narrator-flag.json");
assert.strictEqual(falseNarratorFlagRepair.segments.length, 1);
assert.strictEqual(falseNarratorFlagRepair.segments[0].source_narrator_detected, false);
assert.strictEqual(falseNarratorFlagRepair.segments[0].audio_mode, "original_audio");
assert.ok(falseNarratorFlagRepair._toolValidationWarnings.some((item) => item.includes("đã gỡ source_narrator_detected")));

const unsupportedNarratorFlag = validateManualGeminiScript({
  prompt_profile: "independent",
  source_narrator_policy: "forbidden",
  segments: [{
    sceneId: "scene_0002",
    sourceStartSec: 5,
    sourceEndSec: 7,
    startSec: 0,
    endSec: 2,
    playbackSpeed: 1,
    audio_mode: "original_audio",
    voiceover_text: "",
    source_narrator_detected: true
  }]
}, manifest, "unsupported-narrator-flag.json");
assert.strictEqual(unsupportedNarratorFlag.segments.length, 0);
assert.ok(unsupportedNarratorFlag._toolValidationWarnings.some((item) => item.includes("đã loại khỏi revision")));

const flaggedNarratorOverlapRepair = validateManualGeminiScript({
  prompt_profile: "serialized_genz",
  series_mode: "interleaved_multipart",
  segments: [{
    sceneId: "scene_0002",
    sourceStartSec: 4,
    sourceEndSec: 8,
    startSec: 0,
    endSec: 4,
    playbackSpeed: 1,
    source_narrator_detected: true,
    audio_mode: "voiceover_only",
    voiceover_text: "Verified narrator replacement."
  }, {
    sceneId: "scene_0002",
    sourceStartSec: 7,
    sourceEndSec: 10,
    startSec: 4,
    endSec: 7,
    playbackSpeed: 1,
    audio_mode: "original_audio"
  }]
}, manifest, "flagged-narrator-overlap.json");
assert.strictEqual(flaggedNarratorOverlapRepair.segments.length, 2);
assert.strictEqual(flaggedNarratorOverlapRepair.segments[0].audio_mode, "voiceover_only");
assert.strictEqual(flaggedNarratorOverlapRepair.segments[1].audio_mode, "original_audio");
assert.strictEqual(flaggedNarratorOverlapRepair.segments[1].sourceStartSec, 8);
assert.strictEqual(flaggedNarratorOverlapRepair.segments[1].sourceEndSec, 10);

const crossSceneSegment = validateManualGeminiScript({
  segments: [{
    sceneId: "scene_0001",
    sourceStartSec: 0,
    sourceEndSec: 8,
    startSec: 0,
    endSec: 8,
    audio_mode: "voiceover_only",
    voiceover_text: "One continuous narration remains attached to the complete visual run."
  }]
}, manifest, "cross-scene.json");
assert.deepStrictEqual(crossSceneSegment.segments[0].sceneIds, ["scene_0001", "scene_0002"]);
assert.strictEqual(crossSceneSegment.segments[0].sceneSpan, true);
assert.strictEqual(crossSceneSegment.segments[0].voiceover_text, "One continuous narration remains attached to the complete visual run.");
assert.strictEqual(crossSceneSegment.segments.length, 1);

const compiledIndependentMacroBlock = validateManualGeminiScript({
  prompt_profile: "independent",
  scriptId: 3,
  segments: [{
    id: "highlight_0001",
    sceneId: "scene_0001",
    sceneIds: ["scene_0001", "scene_0002"],
    sourceStartSec: 0,
    sourceEndSec: 8,
    playbackSpeed: 1,
    audio_mode: "voiceover_only",
    voiceover_text: "One concise narration line spans the complete visual macro-block."
  }]
}, manifest, "independent-editorial-block.json", null, { independentNarratorPolicy: true });
const compiledIndependentTimeline = normalizeHighlightCutScript(compiledIndependentMacroBlock, 15.8);
assert.strictEqual(compiledIndependentTimeline.segments.length, 1);
assert.strictEqual(compiledIndependentTimeline.segments[0].startSec, 0);
assert.strictEqual(compiledIndependentTimeline.segments[0].endSec, 8);
assert.deepStrictEqual(compiledIndependentTimeline.segments[0].sceneIds, ["scene_0001", "scene_0002"]);

const repaired = validateManualGeminiScript({
  segments: [{
    sceneId: "scene_0001",
    sourceStartSec: 0,
    sourceEndSec: 3.45,
    startSec: 0,
    endSec: 3.45,
    playbackSpeed: 1
  }]
}, manifest, "small-overflow.json");
assert.strictEqual(repaired.segments[0].sourceEndSec, 3.2);
assert.strictEqual(repaired.segments[0].playbackSpeed, 0.9275);
assert.ok(repaired._toolValidationWarnings[0].includes("tự sửa"));

assert.throws(() => validateManualGeminiScript({
  segments: [{
    sceneId: "scene_9999",
    sourceStartSec: 20,
    sourceEndSec: 22
  }]
}, manifest, "invalid.json"), /không tồn tại/);

assert.throws(() => validateManualGeminiScript({
  segments: [{
    sceneId: "scene_0001",
    sourceStartSec: 0,
    sourceEndSec: 20
  }]
}, manifest, "outside.json"), /nằm ngoài/);

const evidencePayload = validateSceneEvidence({
  actorIdentityMap: [{
    actorId: "officer_001",
    displayLabel: "Officer at the rear passenger door",
    visualIdentity: "Uniformed officer closest to the vehicle",
    role: "officer",
    evidenceIds: ["evidence_0001"],
    confidence: 0.95
  }],
  evidence: [{
    evidenceId: "evidence_0001",
    sceneId: "scene_0002",
    sourceStartSec: 4,
    sourceEndSec: 8,
    visualFacts: ["The officer opens the rear passenger door and points inside the vehicle."],
    dialogueEvidence: [{ startSec: 4.5, endSec: 5.5, text: "Step out of the vehicle." }],
    storyMeaning: "The command establishes the driver's refusal.",
    actorIds: ["officer_001"],
    primaryActorId: "officer_001",
    speakerActorId: "officer_001",
    originalAudioValueScore: 9,
    originalAudioValueReason: "The officer's direct command establishes the conflict.",
    originalAudioProtected: true,
    stakeRole: "threat_open",
    stakeActorIds: ["officer_001"],
    opensQuestion: "Will the driver comply?",
    containsUnexplainedJargon: true,
    jargonTerms: ["10-32"],
    resolutionModality: "verbal",
    visualProofScore: 2,
    proceduralBloat: true,
    proceduralBloatType: "routine_report",
    viralScore: 8.5,
    confidence: 0.95
  }]
}, manifest);
assert.strictEqual(evidencePayload.artifactType, "scene_evidence");
assert.strictEqual(evidencePayload.evidence.length, 1);
assert.strictEqual(evidencePayload.evidence[0].sceneId, "scene_0002");
assert.strictEqual(evidencePayload.actorIdentityMap[0].actorId, "officer_001");
assert.strictEqual(evidencePayload.evidence[0].primaryActorId, "officer_001");
assert.strictEqual(evidencePayload.evidence[0].originalAudioProtected, true);
assert.strictEqual(evidencePayload.evidence[0].stakeRole, "threat_open");
assert.deepStrictEqual(evidencePayload.evidence[0].jargonTerms, ["10-32"]);
assert.strictEqual(evidencePayload.evidence[0].resolutionModality, "verbal");
assert.strictEqual(evidencePayload.evidence[0].proceduralBloatType, "routine_report");

const qualityEvidencePayload = validateSceneEvidence({
  evidence: Array.from({ length: 8 }, (_, index) => ({
    evidenceId: `quality_${index + 1}`,
    sceneId: "scene_0002",
    sourceStartSec: Number((3.2 + index * 1.575).toFixed(3)),
    sourceEndSec: Number((3.2 + (index + 1) * 1.575).toFixed(3)),
    visualFacts: [`The officer completes verified action ${index + 1} while the camera shows the immediate reaction.`],
    dialogueEvidence: [{ text: `Complete verified line ${index + 1}.` }],
    storyMeaning: `Verified causal beat ${index + 1} advances the same event.`,
    narrativePhase: ["hook", "context", "context", "escalation", "escalation", "climax", "consequence", "aftermath"][index],
    hookScore: index === 0 ? 9 : 5,
    viralScore: index === 0 ? 9 : 7,
    completeBeat: true,
    cutSafety: "safe",
    continuityBefore: index ? `Beat ${index}` : "The event begins.",
    continuityAfter: `Beat ${index + 2}`,
    confidence: 0.95
  }))
}, manifest);
const evidenceGate = evaluateEvidenceQuality(qualityEvidencePayload, manifest);
assert.strictEqual(evidenceGate.passed, true);
assert.ok(evidenceGate.score >= 80);
const weakEvidenceGate = evaluateEvidenceQuality(evidencePayload, manifest);
assert.strictEqual(weakEvidenceGate.passed, false);
assert.ok(weakEvidenceGate.failures.some((item) => item.includes("hook")));

const actionCandidatesPayload = {
  artifactType: "action_candidates",
  candidates: [{
    actionCandidateId: "action_0001",
    sourceStartSec: 3.2,
    sourceEndSec: 6.35,
    actionPriorityScore: 9.2,
    mustReview: true
  }]
};
const actionEvidenceItems = qualityEvidencePayload.evidence.map((item, index) => ({
  ...item,
  dialogueEvidence: index === 0 ? [] : item.dialogueEvidence,
  ...(index < 2 ? {
    actionCandidateId: "action_0001",
    actionSequenceId: "action_sequence_01",
    actionType: "vehicle_pursuit",
    actionIntensity: 9.4,
    visualRetentionScore: 9.5,
    dialogueDependency: "none"
  } : {})
}));
const actionEvidencePayload = validateSceneEvidence({
  actionCandidateDecisions: [{
    actionCandidateId: "action_0001",
    verdict: "essential",
    reason: "The suspect takes the cruiser and the pursuit begins on screen.",
    actionType: "vehicle_pursuit",
    actionSequenceId: "action_sequence_01",
    evidenceIds: ["quality_1", "quality_2"]
  }],
  evidence: actionEvidenceItems
}, manifest, "action-evidence.json", actionCandidatesPayload);
assert.strictEqual(actionEvidencePayload.actionCoverage.items[0].coverageRatio, 1);
assert.strictEqual(actionEvidencePayload.evidence[0].mustInclude, true);
assert.strictEqual(actionEvidencePayload.evidence[0].actionOverride, true);
assert.strictEqual(evaluateEvidenceQuality(actionEvidencePayload, manifest, actionCandidatesPayload).passed, true);

const unreviewedActionEvidence = validateSceneEvidence({
  evidence: actionEvidenceItems
}, manifest, "unreviewed-action.json", actionCandidatesPayload);
const unreviewedActionGate = evaluateEvidenceQuality(unreviewedActionEvidence, manifest, actionCandidatesPayload);
assert.strictEqual(unreviewedActionGate.passed, false);
assert.ok(unreviewedActionGate.failures.some((item) => item.includes("chưa được Gemini xem")));

const undercoveredActionEvidence = validateSceneEvidence({
  actionCandidateDecisions: [{
    actionCandidateId: "action_0001",
    verdict: "essential",
    reason: "The pursuit is central to the case.",
    actionSequenceId: "action_sequence_01"
  }],
  evidence: actionEvidenceItems.map((item, index) => index === 1
    ? { ...item, actionCandidateId: "", actionSequenceId: "" }
    : item)
}, manifest, "undercovered-action.json", actionCandidatesPayload);
const undercoveredActionGate = evaluateEvidenceQuality(undercoveredActionEvidence, manifest, actionCandidatesPayload);
assert.strictEqual(undercoveredActionGate.passed, false);
assert.ok(undercoveredActionGate.failures.some((item) => item.includes("chưa được evidence phủ")));

const blueprint = validateStoryBlueprint({
  artifactType: "story_blueprint",
  centralCharacter: "The driver",
  primaryConflict: "The stop escalates after a refusal.",
  audienceQuestion: "Why does the stop escalate?",
  storySpine: {
    centralViewerQuestion: "How does the confrontation end?",
    hookPromise: "The stop may escalate after a refusal.",
    rewindContext: "The officer first gives a clear command.",
    escalationPath: ["The driver refuses", "The officer escalates commands"],
    climax: "The confrontation reaches its decisive moment.",
    climaxEvidenceIds: ["quality_6"],
    payoff: "The confrontation ends at the scene.",
    payoffEvidenceIds: ["quality_8"]
  },
  narrativeContract: {
    hookPromise: "The stop may escalate after a refusal.",
    primaryAudienceQuestion: "How does the confrontation end?",
    primaryStakeType: "physical_hazard",
    stakeActorIds: ["officer_001"],
    mandatoryResolution: {
      required: true,
      resolutionType: "hazard_resolution",
      evidenceIds: ["quality_7"],
      preferredVisualEvidenceIds: ["quality_8"],
      fallbackVerbalEvidenceIds: ["quality_7"],
      visualFirstRequired: true,
      mustAppearBeforeLaterTimeJump: true,
      verifiedOutcome: "The confrontation ends at the scene."
    }
  },
  factualCausalChain: ["The driver refuses, therefore the officer escalates commands."],
  macroBlocks: [
    { macroBlockId: "m1", storyFunction: "hook", evidenceIds: ["quality_1"], transitionReason: "Opening." },
    { macroBlockId: "m2", storyFunction: "context", evidenceIds: ["quality_2", "quality_3"], transitionReason: "The prior command establishes context." },
    { macroBlockId: "m3", storyFunction: "escalation", evidenceIds: ["quality_4", "quality_5"], transitionReason: "The refusal escalates the stop." },
    { macroBlockId: "m4", storyFunction: "climax", evidenceIds: ["quality_6"], transitionReason: "The escalation causes the confrontation." },
    { macroBlockId: "m5", storyFunction: "consequence", evidenceIds: ["quality_7", "quality_8"], transitionReason: "The confrontation produces the consequence." }
  ]
}, qualityEvidencePayload);
assert.strictEqual(blueprint.artifactType, "story_blueprint");
assert.strictEqual(blueprint.macroBlocks.length, 5);
assert.strictEqual(blueprint.narrativeContract.mandatoryResolution.evidenceIds[0], "quality_7");
assert.strictEqual(blueprint.narrativeContract.mandatoryResolution.preferredVisualEvidenceIds[0], "quality_8");
assert.strictEqual(blueprint.storySpine.climaxEvidenceIds[0], "quality_6");
assert.strictEqual(blueprint.storySpine.payoffEvidenceIds[0], "quality_8");
assert.throws(() => validateStoryBlueprint({
  macroBlocks: [{ macroBlockId: "bad", storyFunction: "hook", evidenceIds: ["missing"] }]
}, qualityEvidencePayload), /chưa được khóa/);
const storyBlueprintPrompt = buildStoryBlueprintPrompt({ evidencePayload: qualityEvidencePayload, manifest });
assert.ok(storyBlueprintPrompt.includes("story-blueprint.json"));
assert.ok(storyBlueprintPrompt.includes("JSON CODE-BLOCK CONTRACT - HIGHEST PRIORITY"));
assert.ok(storyBlueprintPrompt.includes("exactly one Markdown code block"));
assert.ok(storyBlueprintPrompt.includes("JSON.parse"));
assert.ok(storyBlueprintPrompt.includes("HOOK PRIORITY FALLBACK - USER LOCKED"));
assert.ok(storyBlueprintPrompt.includes("complete Hook may last 4-30 seconds"));
assert.ok(storyBlueprintPrompt.includes("Write narrativeContract BEFORE macroBlocks"));
assert.ok(storyBlueprintPrompt.includes("STORY SPINE - HIGHEST EDITORIAL PRIORITY"));
assert.ok(storyBlueprintPrompt.includes('"centralViewerQuestion"'));
assert.ok(storyBlueprintPrompt.includes("reject it internally and rebuild it"));
assert.ok(storyBlueprintPrompt.includes("VISUAL-FIRST RESOLUTION"));
assert.ok(storyBlueprintPrompt.includes("TWO-LAYER PAYOFF"));
assert.ok(storyBlueprintPrompt.includes('"finalOutcomeRequired"'));
assert.ok(storyBlueprintPrompt.includes('"mustBeFinal"'));
assert.ok(storyBlueprintPrompt.includes("TIKTOK PROCEDURAL-BLOAT FILTER"));
assert.ok(!storyBlueprintPrompt.toLowerCase().includes("attachment"));
const serializedBlueprintInput = {
  artifactType: "story_blueprint",
  centralCharacter: "The driver",
  primaryConflict: "The stop escalates after a refusal.",
  audienceQuestion: "Why does the stop escalate?",
  factualCausalChain: ["The refusal causes the confrontation."],
  macroBlocks: blueprint.macroBlocks.map((block, index) => ({
    ...block,
    partNumbers: index === 0 ? [1, 2, 3] : [Math.min(3, index)]
  }))
};
const serializedBlueprint = validateStoryBlueprint(serializedBlueprintInput, qualityEvidencePayload);
assert.deepStrictEqual(serializedBlueprint.macroBlocks[0].partNumbers, [1, 2, 3]);
const serializedBlueprintPrompt = buildStoryBlueprintPrompt({
  evidencePayload: qualityEvidencePayload,
  manifest,
  basePrompt: "USER TASK INSTRUCTION - BUILD A 3-PART SERIALIZED TRUE-CRIME SERIES\nprompt_profile: serialized_interleaved"
});
assert.ok(serializedBlueprintPrompt.includes("SERIALIZED SERIES BLUEPRINT OVERRIDE"));
assert.ok(serializedBlueprintPrompt.includes("CRITICAL ANTI-TALKING-HEAD RULE"));
assert.ok(serializedBlueprintPrompt.includes("ANTI-HALLUCINATION PROTOCOL"));
assert.ok(serializedBlueprintPrompt.includes("SPOILER BAN"));
assert.ok(serializedBlueprintPrompt.includes("Assign those reveals only to Part 3"));
assert.ok(serializedBlueprintPrompt.includes('"partNumbers": [1, 2, 3]'));
assert.ok(!serializedBlueprintPrompt.includes("3 DISTINCT SCRIPT ANGLES"));
const script4Prompt = buildSingleVariantPrompt({
  scriptId: 4,
  evidencePayload: qualityEvidencePayload,
  blueprint,
  manifest,
  basePrompt: "VOICE CALIBRATION PARAMETERS PROVIDED BY USER:\n- measuredWordsPerSecond: 2.8\n---"
});
assert.ok(script4Prompt.includes("script-4.json"));
assert.ok(script4Prompt.includes("measuredWordsPerSecond: 2.8"));
assert.ok(!script4Prompt.includes("CREATE ONLY SCRIPT 1"));
assert.ok(script4Prompt.includes("JSON CODE-BLOCK CONTRACT - HIGHEST PRIORITY"));
assert.ok(script4Prompt.includes("exactly one Markdown code block"));
assert.ok(script4Prompt.includes("USER-RANKED HOOK"));
assert.ok(script4Prompt.includes("high_action (complete high-adrenaline action"));
assert.ok(script4Prompt.includes("cut exactly before the narrator begins"));
assert.ok(script4Prompt.includes("EDITORIAL MACRO-BLOCK RANGE"));
assert.ok(script4Prompt.includes("narrativePurpose"));
assert.ok(script4Prompt.includes("not a quota or rejection gate"));
assert.ok(!script4Prompt.toLowerCase().includes("attachment"));
const serializedPart2Prompt = buildSingleVariantPrompt({
  scriptId: 3,
  evidencePayload: qualityEvidencePayload,
  blueprint: serializedBlueprint,
  manifest,
  basePrompt: "USER TASK INSTRUCTION - BUILD A 3-PART SERIALIZED TRUE-CRIME SERIES\nprompt_profile: serialized_interleaved\n- target duration for EACH Part: 70-105 seconds\nVOICE CALIBRATION PARAMETERS PROVIDED BY USER:\n- measuredWordsPerSecond: 2.8\n---"
});
assert.ok(serializedPart2Prompt.includes("CREATE SERIALIZED PART 2 ONLY"));
assert.ok(serializedPart2Prompt.includes('scriptId=3, part_number=2'));
assert.ok(serializedPart2Prompt.includes("Final duration must be 70-105 seconds"));
assert.ok(serializedPart2Prompt.includes("CRITICAL ANTI-TALKING-HEAD RULE"));
assert.ok(serializedPart2Prompt.includes("ANTI-HALLUCINATION PROTOCOL"));
assert.ok(serializedPart2Prompt.includes("SERIALIZATION & MYSTERY PRESERVATION"));
assert.ok(serializedPart2Prompt.includes("Only Script 4 / Part 3 may reveal"));
assert.ok(serializedPart2Prompt.includes("ANTI-HALLUCINATION VISUAL RULE"));
assert.ok(serializedPart2Prompt.includes("ZERO-TOLERANCE SOURCE NARRATOR FILTER"));
assert.ok(serializedPart2Prompt.includes("overrides Sustained Beat"));
assert.ok(serializedPart2Prompt.includes("ONE-SCENE-PER-SEGMENT"));
assert.ok(serializedPart2Prompt.includes('"source_narrator_detected": false'));
assert.ok(!serializedPart2Prompt.includes("3 DISTINCT SCRIPT ANGLES"));
assert.ok(!serializedPart2Prompt.includes("80/20 Raw Reality"));
assert.throws(
  () => validateSceneEvidence({ schemaVersion: 1, evidence: [] }, manifest, "empty.json"),
  /Gemini đã trả về "evidence": \[\]/
);

assert.throws(() => validateSceneEvidence({
  evidence: [{
    sceneId: "scene_0001",
    sourceStartSec: 3.2,
    sourceEndSec: 4,
    visualFacts: ["A visible action occurs at the boundary."],
    storyMeaning: "Boundary ownership test."
  }]
}, manifest), /sourceStartSec/);

assert.doesNotThrow(() => validateManualGeminiScript({
  segments: [{
    evidenceId: "evidence_0001",
    sceneId: "scene_0002",
    sourceStartSec: 4,
    sourceEndSec: 8,
    startSec: 0,
    endSec: 4
  }]
}, manifest, "locked-valid.json", evidencePayload));

const lockedRepaired = validateManualGeminiScript({
  segments: [{
    evidenceId: "evidence_0001",
    sceneId: "scene_0002",
    sourceStartSec: 4,
    sourceEndSec: 8.2,
    startSec: 0,
    endSec: 4.2
  }]
}, manifest, "locked-repaired.json", evidencePayload);
assert.strictEqual(lockedRepaired.segments[0].sourceEndSec, 8);
assert.ok(lockedRepaired._toolValidationWarnings[0].includes("đã được khóa"));

const lockedFallback = validateManualGeminiScript({
  segments: [{
    evidenceId: "evidence_0001",
    sceneId: "scene_0002",
    sourceStartSec: 9,
    sourceEndSec: 10,
    startSec: 0,
    endSec: 1
  }]
}, manifest, "locked-no-overlap.json", evidencePayload);
assert.strictEqual(lockedFallback.segments[0].sourceStartSec, 4);
assert.strictEqual(lockedFallback.segments[0].sourceEndSec, 8);
assert.ok(lockedFallback._toolValidationWarnings[0].includes("dùng toàn bộ evidence"));

const reportedBoundaryRepair = validateManualGeminiScript({
  total_target_sec: 55.936,
  segments: [{
    evidenceId: "evidence_0071",
    sceneId: "scene_0071",
    sourceStartSec: 625.1,
    sourceEndSec: 681.036,
    startSec: 0,
    endSec: 55.936,
    playbackSpeed: 1
  }]
}, {
  scenes: [{
    sceneId: "scene_0071",
    startSec: 609.008,
    endSec: 658.591
  }]
}, "reported-boundary.json", {
  evidence: [{
    evidenceId: "evidence_0071",
    sceneId: "scene_0071",
    sourceStartSec: 609.008,
    sourceEndSec: 658.591
  }]
});
assert.strictEqual(reportedBoundaryRepair.segments[0].sourceStartSec, 625.1);
assert.strictEqual(reportedBoundaryRepair.segments[0].sourceEndSec, 658.591);
assert.strictEqual(reportedBoundaryRepair.segments[0].endSec, 33.491);
assert.strictEqual(reportedBoundaryRepair.total_target_sec, 33.491);

const narratorAutoReplacement = validateManualGeminiScript({
  segments: [{
    evidenceId: "evidence_narrator",
    sceneId: "scene_0002",
    sourceStartSec: 4,
    sourceEndSec: 8,
    startSec: 0,
    endSec: 4,
    playbackSpeed: 1,
    source_narrator_detected: true,
    audio_mode: "original_audio",
    voiceover_text: ""
  }]
}, manifest, "source-narrator.json", {
  evidence: [{
    evidenceId: "evidence_narrator",
    sceneId: "scene_0002",
    sourceStartSec: 4,
    sourceEndSec: 8,
    dialogueEvidence: [{
      text: "[Narrator] The suspect returned to the house. - [Officer] Put your hands behind your back."
    }]
  }]
});
assert.strictEqual(narratorAutoReplacement.segments[0].audio_mode, "voiceover_only");
assert.strictEqual(narratorAutoReplacement.segments[0].voiceover_text, "The suspect returned to the house.");
assert.strictEqual(narratorAutoReplacement.segments[0].source_narrator_detected, true);
assert.strictEqual(narratorAutoReplacement.segments[0].replaceSourceNarrator, true);
assert.ok(narratorAutoReplacement._toolValidationWarnings.some((item) => item.includes("tắt audio nguồn")));

const storyRecutNarrator = validateManualGeminiScript({
  mode: "story_recut",
  segments: [{
    evidenceId: "evidence_narrator",
    sceneId: "scene_0002",
    sourceStartSec: 4,
    sourceEndSec: 8,
    startSec: 0,
    endSec: 4,
    playbackSpeed: 1,
    audio_mode: "original_audio",
    voiceover_text: ""
  }]
}, manifest, "story-recut.json", {
  evidence: [{
    evidenceId: "evidence_narrator",
    sceneId: "scene_0002",
    sourceRunId: "source_run_0002",
    sourceStartSec: 4,
    sourceEndSec: 8,
    sourceNarratorPresent: true,
    dialogueEvidence: [{ text: "[Narrator] The suspect returned to the house." }]
  }]
}, { preserveSourceNarrator: true });
assert.strictEqual(storyRecutNarrator.segments[0].audio_mode, "original_audio");
assert.strictEqual(storyRecutNarrator.segments[0].voiceover_text, "");
assert.strictEqual(storyRecutNarrator.segments[0].replaceSourceNarrator, false);
assert.throws(
  () => validateManualGeminiScript(
    JSON.stringify({
      artifactType: "scene_evidence",
      schemaVersion: 1,
      evidence: [{ evidenceId: "evidence_narrator" }]
    }),
    manifest,
    "data.json",
    { evidence: [] },
    { forceSourceAudioOnly: true }
  ),
  /scene evidence của Giai đoạn 1/
);

const forcedStoryRecutSourceAudio = validateManualGeminiScript({
  mode: "story_recut",
  segments: [{
    evidenceId: "evidence_narrator",
    sceneId: "scene_0002",
    sourceStartSec: 4,
    sourceEndSec: 8,
    startSec: 0,
    endSec: 4,
    playbackSpeed: 1,
    audio_mode: "voiceover_only",
    voiceover_text: "Gemini incorrectly added tool narration."
  }]
}, manifest, "story-recut-forced.json", {
  evidence: [{
    evidenceId: "evidence_narrator",
    sceneId: "scene_0002",
    sourceRunId: "source_run_0002",
    sourceStartSec: 4,
    sourceEndSec: 8,
    sourceNarratorPresent: true,
    dialogueEvidence: [{ text: "[Narrator] The suspect returned to the house." }]
  }]
}, {
  preserveSourceNarrator: true,
  forceSourceAudioOnly: true
});
assert.strictEqual(forcedStoryRecutSourceAudio.audio_strategy, "source_audio_only");
assert.strictEqual(forcedStoryRecutSourceAudio.voiceover_enabled, false);
assert.strictEqual(forcedStoryRecutSourceAudio.segments[0].audio_mode, "original_audio");
assert.strictEqual(forcedStoryRecutSourceAudio.segments[0].voiceover_text, "");
assert.strictEqual(forcedStoryRecutSourceAudio.segments[0].forceSourceMute, false);

const sourceAudioOnlyNarrator = validateManualGeminiScript({
  audio_strategy: "source_audio_only",
  voiceover_enabled: false,
  segments: [{
    evidenceId: "evidence_narrator",
    sceneId: "scene_0002",
    sourceStartSec: 4,
    sourceEndSec: 8,
    startSec: 0,
    endSec: 4,
    playbackSpeed: 1,
    audio_mode: "voiceover_only",
    voiceover_text: "This must be removed."
  }]
}, manifest, "source-audio-only.json", {
  evidence: [{
    evidenceId: "evidence_narrator",
    sceneId: "scene_0002",
    sourceStartSec: 4,
    sourceEndSec: 8,
    sourceNarratorPresent: true,
    dialogueEvidence: [{ text: "[Narrator] The suspect returned to the house." }]
  }]
});
assert.strictEqual(sourceAudioOnlyNarrator.segments[0].audio_mode, "original_audio");
assert.strictEqual(sourceAudioOnlyNarrator.segments[0].voiceover_text, "");
assert.strictEqual(sourceAudioOnlyNarrator.segments[0].replaceSourceNarrator, false);
assert.strictEqual(sourceAudioOnlyNarrator.segments[0].forceSourceMute, false);

const independentCleanNarrator = validateManualGeminiScript({
  scriptId: 1,
  prompt_profile: "independent",
  source_narrator_policy: "forbidden",
  audio_strategy: "clean_source_audio_only",
  voiceover_enabled: false,
  segments: [{
    evidenceId: "evidence_narrator",
    sceneId: "scene_0002",
    sourceStartSec: 4,
    sourceEndSec: 8,
    startSec: 0,
    endSec: 4,
    playbackSpeed: 1,
    audio_mode: "original_audio",
    voiceover_text: ""
  }]
}, manifest, "independent-clean-source.json", {
  evidence: [{
    evidenceId: "evidence_narrator",
    sceneId: "scene_0002",
    sourceStartSec: 4,
    sourceEndSec: 8,
    sourceNarratorPresent: true,
    sourceAudioType: "source_narration",
    sourceNarratorText: "The suspect returned to the house.",
    dialogueEvidence: [{ text: "[Narrator] The suspect returned to the house." }]
  }]
});
assert.strictEqual(independentCleanNarrator.audio_strategy, "clean_hybrid");
assert.strictEqual(independentCleanNarrator.voiceover_enabled, true);
assert.strictEqual(independentCleanNarrator.source_narrator_policy, "forbidden");
assert.strictEqual(independentCleanNarrator.segments[0].audio_mode, "voiceover_only");
assert.strictEqual(independentCleanNarrator.segments[0].voiceover_text, "The suspect returned to the house.");
assert.strictEqual(independentCleanNarrator.segments[0].replaceSourceNarrator, true);
assert.strictEqual(independentCleanNarrator.segments[0].forceSourceMute, true);
assert.ok(independentCleanNarrator._toolValidationWarnings.some((item) => item.includes("clean_hybrid")));

const serializedSourceAudioOnlyNarrator = validateManualGeminiScript({
  scriptId: 1,
  prompt_profile: "serialized_interleaved",
  series_mode: "interleaved_multipart",
  audio_strategy: "source_audio_only",
  voiceover_enabled: false,
  segments: [{
    evidenceId: "evidence_narrator",
    sceneId: "scene_0002",
    sourceStartSec: 4,
    sourceEndSec: 8,
    startSec: 0,
    endSec: 4,
    playbackSpeed: 1,
    source_narrator_detected: true,
    audio_mode: "original_audio",
    voiceover_text: ""
  }]
}, manifest, "serialized-part-1.json", {
  evidence: [{
    evidenceId: "evidence_narrator",
    sceneId: "scene_0002",
    sourceStartSec: 4,
    sourceEndSec: 8,
    sourceNarratorPresent: false,
    sourceNarratorText: "The suspect returned to the house.",
    dialogueEvidence: [{ text: "[Narrator] The suspect returned to the house." }]
  }]
});
assert.strictEqual(serializedSourceAudioOnlyNarrator.audio_strategy, "interleaved");
assert.strictEqual(serializedSourceAudioOnlyNarrator.voiceover_enabled, true);
assert.strictEqual(serializedSourceAudioOnlyNarrator.segments[0].audio_mode, "voiceover_only");
assert.strictEqual(serializedSourceAudioOnlyNarrator.segments[0].source_narrator_detected, true);
assert.strictEqual(serializedSourceAudioOnlyNarrator.segments[0].voiceover_text, "The suspect returned to the house.");
assert.strictEqual(serializedSourceAudioOnlyNarrator.segments[0].replaceSourceNarrator, true);
assert.ok(serializedSourceAudioOnlyNarrator._toolValidationWarnings.some((item) => item.includes("Series Part 1-3")));

const normalizedNarratorHint = normalizeHighlightCutScript(serializedSourceAudioOnlyNarrator, 30);
assert.strictEqual(normalizedNarratorHint.segments[0].sourceNarratorDetected, true);
assert.strictEqual(normalizedNarratorHint.segments[0].audioMode, "voiceover_only");

const normalizedGeminiCitations = normalizeHighlightCutScript({
  segments: [{
    sourceStartSec: 0,
    sourceEndSec: 8,
    startSec: 0,
    endSec: 8,
    playbackSpeed: 1,
    audio_mode: "voiceover_only",
    voiceover_text: "Once the metal was prepped, we sealed every edge.[cite: 8]",
    preview_vi: "Các mép được bịt kín.【8†source】"
  }]
}, 10);
assert.strictEqual(
  normalizedGeminiCitations.segments[0].voiceoverText,
  "Once the metal was prepped, we sealed every edge."
);
assert.strictEqual(
  normalizedGeminiCitations.segments[0].previewSubtitleVi,
  "Các mép được bịt kín."
);
assert.ok(normalizedGeminiCitations.warnings.some((item) => item.includes("citation/footnote")));

const repairedOutputTimeline = normalizeHighlightCutScript({
  total_target_sec: 8.03,
  segments: [{
    sourceStartSec: 10,
    sourceEndSec: 14.13,
    startSec: 0,
    endSec: 4.03,
    playbackSpeed: 1,
    audio_mode: "original_audio",
    voiceover_text: ""
  }, {
    sourceStartSec: 20,
    sourceEndSec: 24,
    startSec: 4.03,
    endSec: 8.03,
    playbackSpeed: 1,
    audio_mode: "original_audio",
    voiceover_text: ""
  }]
}, 30);
assert.strictEqual(repairedOutputTimeline.segments[0].startSec, 0);
assert.strictEqual(repairedOutputTimeline.segments[0].endSec, 4.13);
assert.strictEqual(repairedOutputTimeline.segments[0].playbackSpeed, 1);
assert.strictEqual(repairedOutputTimeline.segments[0].requestedOutputEndSec, 4.03);
assert.strictEqual(repairedOutputTimeline.segments[1].startSec, 4.13);
assert.strictEqual(repairedOutputTimeline.segments[1].endSec, 8.13);
assert.ok(repairedOutputTimeline.warnings.some((item) => item.includes("tự tính lại timeline output")));

const derivedSpeedTimeline = normalizeHighlightCutScript({
  segments: [{
    sourceStartSec: 0,
    sourceEndSec: 8,
    startSec: 0,
    endSec: 4,
    audio_mode: "original_audio",
    voiceover_text: ""
  }]
}, 10);
assert.strictEqual(derivedSpeedTimeline.segments[0].playbackSpeed, 2);
assert.strictEqual(derivedSpeedTimeline.segments[0].endSec, 4);

assert.throws(() => normalizeHighlightCutScript({
  segments: [{
    sourceStartSec: 0,
    sourceEndSec: 5,
    startSec: 0,
    endSec: 5,
    source_narrator_detected: true,
    audio_mode: "original_audio",
    voiceover_text: ""
  }]
}, 10), /source_narrator_detected=true.*thiếu voiceover_text/);

const normalizedNarratorEvidence = validateSceneEvidence({
  sourceVideo: "input.mp4",
  evidence: [{
    evidenceId: "evidence_narrator",
    sceneId: "scene_0002",
    sourceStartSec: 4,
    sourceEndSec: 8,
    visualFacts: ["The suspect returns to the house while an officer waits beside the door."],
    dialogueEvidence: [{
      text: "[Narrator] The suspect returned to the house. - [Officer] Put your hands behind your back."
    }],
    storyMeaning: "The return leads directly to the arrest."
  }]
}, manifest);
assert.strictEqual(normalizedNarratorEvidence.evidence[0].sourceNarratorPresent, true);
assert.strictEqual(normalizedNarratorEvidence.evidence[0].sourceNarratorText, "The suspect returned to the house.");

assert.doesNotThrow(() => validateManualGeminiScript({
  segments: [{
    evidenceId: "evidence_narrator",
    sceneId: "scene_0002",
    sourceStartSec: 4,
    sourceEndSec: 8,
    startSec: 0,
    endSec: 4,
    playbackSpeed: 1,
    audio_mode: "voiceover_only",
    voiceover_text: "The suspect returned to the house."
  }]
}, manifest, "source-narrator-muted.json", {
  evidence: [{
    evidenceId: "evidence_narrator",
    sceneId: "scene_0002",
    sourceStartSec: 4,
    sourceEndSec: 8,
    sourceNarratorPresent: true,
    dialogueEvidence: [{ text: "[Narrator] The suspect returned to the house." }]
  }]
}));

const lockedPrompt = buildLockedEvidenceScriptPrompt({
  basePrompt: "BASE PROMPT",
  evidencePayload,
  manifest
});
assert.ok(lockedPrompt.includes("LOCKED_SCENE_EVIDENCE"));
assert.ok(lockedPrompt.includes("evidence_0001"));
assert.ok(lockedPrompt.includes("BASE PROMPT"));
assert.ok(lockedPrompt.includes("VOICEOVER AUDIO SAFETY"));
assert.ok(lockedPrompt.includes("renderer will safely coalesce"));
assert.ok(lockedPrompt.includes("exactly three standalone valid JSON objects"));
assert.ok(lockedPrompt.includes("Do not generate Script 2"));
assert.ok(!lockedPrompt.includes("four final scripts"));
assert.ok(lockedPrompt.includes("JSON CODE-BLOCK CONTRACT - HIGHEST PRIORITY"));
assert.ok(lockedPrompt.includes('saved as "script-1.json"'));
assert.ok(lockedPrompt.includes('saved as "script-3.json"'));
assert.ok(lockedPrompt.includes('saved as "script-4.json"'));
assert.ok(lockedPrompt.includes("Treat each code block as one separate downloadable file"));
assert.ok(lockedPrompt.includes("FAIL CLOSED - NEVER GUESS"));
assert.ok(lockedPrompt.includes("SCRIPT 4 STORY-FIRST GATE"));
assert.ok(lockedPrompt.includes("SCRIPT 4 SOURCE-ADJACENCY GATE"));
assert.ok(lockedPrompt.includes("SCRIPT 4 CONTINUITY GATE"));
assert.ok(lockedPrompt.includes("INDEPENDENT SCRIPT 1 NARRATED CLEAN-HYBRID GATE"));
assert.ok(lockedPrompt.includes("SERIALIZED NARRATOR OVERRIDE"));
assert.ok(lockedPrompt.includes('scriptId=1 means Part 1, NOT the legacy source-audio-only variant'));
assert.ok(lockedPrompt.startsWith("STEP 0 - VERIFIED INPUT ACCESS GATE"));
assert.ok(lockedPrompt.includes("USER TASK INSTRUCTION - EXECUTE THIS FILE IMMEDIATELY"));
assert.ok(lockedPrompt.includes('"artifactType": "gemini_input_access_failure"'));
assert.ok(lockedPrompt.includes("Do not infer a different user intent from the absence of a separate chat message."));

const storyRecutPrompt = buildLockedEvidenceScriptPrompt({
  basePrompt: "BUILD STORY RECUT",
  evidencePayload,
  manifest,
  workflow: "manual_gemini_story_recut"
});
assert.ok(storyRecutPrompt.includes('save as "story-recut.json"'));
assert.ok(storyRecutPrompt.includes("exactly one Markdown code block"));
assert.ok(storyRecutPrompt.includes("JSON.parse"));
assert.ok(storyRecutPrompt.includes("sourceIdentityMatched"));

const pass1FilePrompt = buildPass1JsonFilePrompt("ANALYZE THE VIDEO", {
  candidates: [{ actionCandidateId: "action_0001", sourceStartSec: 2, sourceEndSec: 8, mustReview: true }]
});
assert.ok(pass1FilePrompt.startsWith("STEP 0 - VERIFIED INPUT ACCESS GATE"));
assert.ok(pass1FilePrompt.includes("noGuessingConfirmed"));
assert.ok(pass1FilePrompt.includes("JSON CODE-BLOCK CONTRACT - HIGHEST PRIORITY"));
assert.ok(pass1FilePrompt.includes("exactly one Markdown code block"));
assert.ok(pass1FilePrompt.includes('save as "scene-evidence.json"'));
assert.ok(pass1FilePrompt.includes("JSON.parse"));
assert.ok(pass1FilePrompt.includes("ANALYZE THE VIDEO"));
assert.ok(pass1FilePrompt.includes("Do not output conversational prose"));
assert.ok(pass1FilePrompt.includes("actionCandidateDecisions"));
assert.ok(pass1FilePrompt.includes("action_0001"));
assert.ok(pass1FilePrompt.includes("timelineCoverageVerified"));

const rendererSource = require("fs").readFileSync(
  require("path").join(__dirname, "..", "src", "renderer.js"),
  "utf8"
);
const indexSource = require("fs").readFileSync(
  require("path").join(__dirname, "..", "src", "index.html"),
  "utf8"
);
const mainSource = require("fs").readFileSync(
  require("path").join(__dirname, "..", "electron", "main.js"),
  "utf8"
);
assert.ok(rendererSource.includes("USER TASK INSTRUCTION - EXECUTE THIS FILE IMMEDIATELY"));
assert.ok(rendererSource.includes("The absence of a separate user chat message does not change this task."));
assert.ok(rendererSource.includes("THE ONLY ACCEPTABLE DELIVERABLE is one valid scene-evidence JSON object"));
assert.ok(rendererSource.includes("JSON CODE-BLOCK CONTRACT - HIGHEST PRIORITY"));
assert.ok(rendererSource.includes("Return exactly one JSON code block and no text outside it."));
assert.ok(rendererSource.includes('HARD NON-EMPTY RULE: "evidence": [] is always an invalid deliverable'));
assert.ok(rendererSource.includes('artifactType="scene_evidence"'));
assert.ok(rendererSource.includes('artifactType="story_recut_script"'));
assert.ok(rendererSource.includes('A scene-evidence.json file or any object without a non-empty root "segments" array is an invalid Pass 2 response.'));
assert.ok(rendererSource.includes("COVERAGE FLOOR"));
assert.ok(rendererSource.includes("The 80/20 Rage-Bait Reality / Strategic Bridges"));
assert.ok(rendererSource.includes("MACRO-BLOCK REFERENCE"));
assert.ok(rendererSource.includes("SOURCE-JUMP REFERENCE"));
assert.ok(rendererSource.includes("THE COLD-VIEWER HOOK (Flexible Duration: 4s - ${independentOptions.hookMaxSec}s)"));
assert.ok(rendererSource.includes("HOOK PRIORITY FALLBACK - MANDATORY"));
assert.ok(rendererSource.includes('"hook_selection_audit"'));
assert.ok(rendererSource.includes("rejectedHigherPriorityCandidates"));
assert.ok(rendererSource.includes("SOURCE NARRATOR BOUNDARY"));
assert.ok(rendererSource.includes("SEMANTIC + ACTION PRIORITY"));
assert.ok(rendererSource.includes("Local candidate ordering is not an editorial ranking"));
assert.ok(rendererSource.includes("COLD-VIEWER COMPREHENSION GATE"));
assert.ok(rendererSource.includes("DURABLE EDITORIAL QUALITY CORE - INDEPENDENT SCRIPTS ONLY"));
assert.ok(rendererSource.includes("STORY SPINE COMPILER CONTRACT - HIGHEST PRIORITY"));
assert.ok(rendererSource.includes('"artifactType": "story_spine_edit_script"'));
assert.ok(rendererSource.includes('"narrativeBeats"'));
assert.ok(rendererSource.includes("Do not output startSec, endSec, outputStartSec, or outputEndSec"));
assert.ok(rendererSource.includes("STORY SPINE - HIGHEST EDITORIAL PRIORITY"));
assert.ok(rendererSource.includes("CLIMAX TEASER / HIGH-STAKES HOOK"));
assert.ok(rendererSource.includes('"storySpine"'));
assert.ok(rendererSource.includes('"narrativePurpose"'));
assert.ok(rendererSource.includes("SEMANTIC PAYOFF SCAN"));
assert.ok(rendererSource.includes("SPEAKER AND SOURCE-NARRATOR CLASSIFICATION"));
assert.ok(rendererSource.includes("NATURAL AMERICAN ENGLISH QA"));
assert.ok(rendererSource.includes("ABSOLUTE POLICE-REPORT LANGUAGE BAN"));
assert.ok(rendererSource.includes('Never use "officially charged with multiple serious felonies"'));
assert.ok(rendererSource.includes("COGNITIVE PACING AND PAYOFF SPACE"));
assert.ok(rendererSource.includes("TIKTOK PACING FILTER"));
assert.ok(rendererSource.includes("VISUAL VS VERBAL RESOLUTION"));
assert.ok(rendererSource.includes("VISUAL PROOF SEARCH PASS"));
assert.ok(rendererSource.includes("PAYOFF COMPLETION GATE"));
assert.ok(rendererSource.includes("VERIFIED FINAL-OUTCOME EVIDENCE"));
assert.ok(rendererSource.includes("PROCEDURAL-BLOAT DETECTION"));
assert.ok(rendererSource.includes('"preferredVisualEvidenceIds"'));
assert.ok(rendererSource.includes("RENDERER CAPABILITY GATE"));
assert.ok(rendererSource.includes('"semantic_must_include_candidates"'));
assert.ok(rendererSource.includes('"prompt_profile": "independent"'));
assert.ok(rendererSource.includes('"speaker_role"'));
assert.ok(rendererSource.includes('"speech_type"'));
assert.ok(rendererSource.includes("maxOnly: true"));
assert.ok(rendererSource.includes("coverageMax: 0.78"));
assert.ok(rendererSource.includes("There is deliberately no minWords requirement"));
assert.ok(rendererSource.includes("Target approximately 45-60% voiceover"));
assert.ok(rendererSource.includes("NARRATION ARC - STORY CONTINUITY ENGINE"));
assert.ok(rendererSource.includes('"narration_arc"'));
assert.ok(rendererSource.includes('"narrationBeatId"'));
assert.ok(rendererSource.includes("CONTROLLED MICRO-CUTS"));
assert.ok(rendererSource.includes("HOOK MONTAGE"));
assert.ok(rendererSource.includes("All three independent scripts must ultimately deliver a verified resolution"));
assert.ok(rendererSource.includes("THREE INDEPENDENT SCRIPT INVARIANTS"));
assert.ok(rendererSource.includes("ACTOR IDENTITY FIRST"));
assert.ok(rendererSource.includes("HOOK TRANSITION GATE"));
assert.ok(rendererSource.includes("ORIGINAL AUDIO VALUE GATE"));
assert.ok(rendererSource.includes('"actor_identity_map"'));
assert.ok(rendererSource.includes('"hook_transition_test"'));
assert.ok(rendererSource.includes('"original_audio_protected"'));
assert.ok(rendererSource.includes("ACTOR IDENTITY MAP - REQUIRED"));
assert.ok(rendererSource.includes("coverageMin = 0.9"));
assert.ok(rendererSource.includes("coverageMax = 0.98"));
assert.ok(rendererSource.includes("Actively infer and frame the suspect's apparent psychological state"));
assert.ok(rendererSource.includes("UNEDITED CLIMAX & VERIFIED PAYOFF"));
assert.ok(rendererSource.includes("voiceover_text should sound cinematic rather than like an evidence report"));
assert.ok(rendererSource.includes("OUTPUT TIMELINE IS DERIVED, NOT EDITORIAL"));
assert.ok(rendererSource.includes("The local tool will reflow the output timeline and its calculation is authoritative"));
assert.ok(rendererSource.includes("PSYCHOLOGICAL & PHYSICAL ESCALATION"));
assert.ok(rendererSource.includes("playbackSpeed MAY be set between 0.5 and 0.75"));
assert.ok(rendererSource.includes("ALWAYS >= 60.5 seconds"));
assert.ok(lockedPrompt.includes("SLOW-MOTION GATE"));
assert.ok(lockedPrompt.includes("ABSURD-DIALOGUE GATE"));
assert.ok(lockedPrompt.includes("END-CLEANUP GATE"));
assert.ok(lockedPrompt.includes("ACTOR IDENTITY GATE"));
assert.ok(lockedPrompt.includes("ORIGINAL AUDIO VALUE GATE"));
assert.ok(rendererSource.includes("Caught in 4K / Narrated Raw Reality"));
assert.ok(rendererSource.includes('audio_strategy="clean_hybrid"'));
assert.ok(rendererSource.includes("NARRATOR PRESENCE GATE"));
// assert.ok(rendererSource.includes("A single legal-outcome voiceover at the end is invalid"));
assert.ok(rendererSource.includes('source_narrator_policy="forbidden"'));
assert.ok(rendererSource.includes("COLD-VIEWER COMPREHENSION GATE"));
assert.ok(rendererSource.includes("STORY-DRIVEN NONLINEAR ORDER"));
assert.ok(rendererSource.includes('"timeline_policy": "story_driven_non_linear_with_explicit_bridges"'));
assert.ok(rendererSource.includes("Return exactly ${scriptIds.length} distinct JSON script"));
assert.ok(rendererSource.includes("Return no unrequested script"));
assert.ok(rendererSource.includes('Script 2: "Dialogue-First Confrontation"'));
assert.ok(rendererSource.includes('Script 5: "Evidence and Consequence"'));
assert.ok(rendererSource.includes("VOICEOVER PLACEMENT REFERENCE"));
assert.ok(rendererSource.includes("Visual stakes outrank"));
assert.ok(rendererSource.includes("State the concise verified consequence or current status"));
assert.ok(rendererSource.includes('"completeBeat": true'));
assert.ok(rendererSource.includes('"hookScore": 9.0'));
assert.ok(indexSource.includes('id="viral-diagnostics"'));
assert.ok(indexSource.includes('id="top-caption-source"'));
assert.ok(indexSource.includes('id="source-subtitle-mask-editor"'));
assert.ok(indexSource.includes('id="preview-player" playsinline'));
assert.ok(!indexSource.includes('id="preview-player" controls'));
assert.ok(rendererSource.includes('el.previewPlayer.removeAttribute("controls")'));
assert.ok(/if\s*\(editing\)\s*{\s*activateVideoEditLivePreview\(\);/.test(rendererSource));
assert.ok(indexSource.includes('id="edit-source-subtitle-mask"'));
assert.ok(rendererSource.includes("function beginSubtitleMaskPointer"));
assert.ok(rendererSource.includes("function updateSubtitleMaskPreview"));
assert.ok(rendererSource.includes("function getSuggestedTopCaption"));
assert.ok(rendererSource.includes("syncAutoTopCaptionFromScript"));
assert.ok(rendererSource.includes("topCaptionAutoFromScript"));
assert.ok(indexSource.includes("Copy prompt sửa kịch bản"));
assert.ok(indexSource.includes('id="edge-voice-tuning-controls"'));
assert.ok(indexSource.includes('id="kokoro-voice-tuning-controls"'));
assert.ok(rendererSource.includes("syncSelectedVoiceTuningVisibility"));
assert.ok(indexSource.includes('data-mode="story_recut"'));
assert.ok(indexSource.includes('id="story-recut-rights-confirmed"'));
assert.ok(indexSource.includes('id="manual-prompt-profile"'));
assert.ok(indexSource.includes('id="manual-independent-options"'));
assert.ok(indexSource.includes('id="manual-independent-hook-priority"'));
assert.ok(indexSource.includes('data-hook-type="high_action"'));
assert.ok(indexSource.includes('data-hook-type="psychological_wtf"'));
assert.ok(indexSource.includes('id="manual-independent-script3-max"'));
assert.ok(indexSource.includes('value="serialized_interleaved"'));
assert.ok(indexSource.includes('value="serialized_genz"'));
assert.ok(indexSource.includes('value="viral_police_blotter"'));
assert.ok(indexSource.includes('id="manual-series-shared-hook"'));
assert.ok(indexSource.includes('Cold Open Hook hành động chung 5-30 giây (bắt buộc)'));
assert.ok(rendererSource.includes("BUILD A 3-PART SERIALIZED TRUE-CRIME SERIES"));
assert.ok(rendererSource.includes("viral Gen-Z/Millennial TikTok true-crime and bodycam storyteller"));
assert.ok(rendererSource.includes("TONE DECOUPLING RULE (CRITICAL)"));
assert.ok(rendererSource.includes("NON-REDUNDANT NARRATION (REACTION-DRIVEN COPYWRITING)"));
assert.ok(rendererSource.includes("BUILD THREE VIRAL POLICE BLOTTER HIGHLIGHT SCRIPTS"));
assert.ok(rendererSource.includes("CRITICAL HOOK OVERRIDE"));
assert.ok(rendererSource.includes("Narrative shock value and bizarre human behavior"));
assert.ok(rendererSource.includes('prompt_profile: viral_police_blotter'));
assert.ok(rendererSource.includes("exactly FOUR voiceover_only narrator blocks"));
assert.ok(rendererSource.includes("NARRATOR BLOCK 1 - POLICE REPORT INTRO"));
assert.ok(rendererSource.includes("NARRATOR BLOCK 2 - SHOCKING REVEAL"));
assert.ok(rendererSource.includes("NARRATOR BLOCK 3 - MORAL CONTRAST"));
assert.ok(rendererSource.includes("NARRATOR BLOCK 4 - SPECIFIC CLIFFHANGER"));
assert.ok(rendererSource.includes("COLD OPEN HOOK RULE (Flexible 5-30s for ALL Parts)"));
assert.ok(rendererSource.includes("ACTION-FIRST PRIORITY"));
assert.ok(rendererSource.includes("MULTI-SEGMENT HOOK"));
assert.ok(rendererSource.includes("SUSTAINED BEAT OVERRIDE (CRITICAL EXCEPTION)"));
assert.ok(rendererSource.includes("Do NOT interrupt a critical dialogue exchange with voiceover"));
assert.ok(rendererSource.includes("ANTI-CLONE VOICEOVER RULE (SERIALIZATION INTEGRITY)"));
assert.ok(rendererSource.includes("ZERO-TOLERANCE SOURCE NARRATOR FILTER (SUPREME OVERRIDE)"));
assert.ok(rendererSource.includes("SPOILER BAN FOR PART 1 AND PART 2"));
assert.ok(rendererSource.includes("Only Script 4 / Part 3 may reveal"));
assert.ok(rendererSource.includes("NARRATOR CLASSIFICATION MUST COME FROM BOTH PICTURE AND SOUND"));
assert.ok(rendererSource.includes('sourceAudioType must be "mixed_narration_dialogue"'));
assert.ok(rendererSource.includes("CRITICAL ANTI-TALKING-HEAD COVERAGE"));
assert.ok(rendererSource.includes("TITLE-PROMISE AUDIT"));
assert.ok(rendererSource.includes("CROSS-CASE CONTAMINATION BAN"));
assert.ok(rendererSource.includes("ACTION PAYOFF & VISUAL MATCHING (ANTI-CLICKBAIT)"));
assert.ok(rendererSource.includes("NON-REDUNDANT NARRATION (VALUE-ADD COPYWRITING)"));
assert.ok(rendererSource.includes("SCENE BRIDGING & CONTEXT TRANSITIONS"));
assert.ok(rendererSource.includes("user's selected tool voice"));
assert.ok(rendererSource.includes('"sustainedBeatOverride": true'));
assert.ok(rendererSource.includes('cinematic "Villain Edit" storytelling'));
assert.ok(rendererSource.includes('THE "VILLAIN EDIT" CONTEXT DROP-IN'));
assert.ok(rendererSource.includes("PSYCHOLOGICAL & PHYSICAL ESCALATION"));
assert.ok(rendererSource.includes("Specific Verified Payoff / Comment Trigger"));
assert.ok(rendererSource.includes('Script 4: "The 80/20 Rage-Bait Reality / Strategic Bridges"'));
assert.ok(rendererSource.includes('state.selectedMode === "manual_gemini_pro"'));
assert.ok(indexSource.includes('id="gemini-analysis-root"'));
assert.ok(indexSource.includes('id="pick-gemini-analysis-root"'));
assert.ok(rendererSource.includes("geminiAnalysisRoot: el.geminiAnalysisRoot?.value.trim()"));
assert.ok(!rendererSource.includes("const destinationRoot = await window.cineviral.pickFolder();"));
assert.ok(mainSource.includes("destinationRoot: settings.geminiAnalysisRoot"));
assert.ok(rendererSource.includes("EVERY Part MUST start with the EXACT SAME complete signature cold open Hook sequence"));
assert.ok(rendererSource.includes("Flexible 5-30s for ALL Parts"));
assert.ok(rendererSource.includes("MULTI-SEGMENT HOOK"));
assert.ok(rendererSource.includes("SOURCE NARRATOR TIMELINE"));
assert.ok(rendererSource.includes('"source_narrator_ranges"'));
assert.ok(rendererSource.includes("Cut immediately before an external source narrator begins"));
assert.ok(rendererSource.includes('"source_narrator_detected": false'));
assert.ok(rendererSource.includes("scriptId=1 is part_number=1"));
assert.ok(rendererSource.includes("scriptId=3 is part_number=2"));
assert.ok(rendererSource.includes("scriptId=4 is part_number=3"));
const serializedProfile = resolveScriptProfile({
  scriptId: 1,
  series_mode: "interleaved_multipart",
  part_number: 1,
  target_duration_min_sec: 75,
  target_duration_max_sec: 110,
  interleaved_audio_enabled: true
}, 1);
assert.strictEqual(serializedProfile.seriesMode, true);
assert.strictEqual(serializedProfile.label, "Serialized Part 1");
assert.strictEqual(serializedProfile.maxVoiceoverSec, 12);
assert.strictEqual(serializedProfile.minDuration, 75);
assert.ok(rendererSource.includes("BUILD ONE STORY RECUT JSON"));
assert.ok(rendererSource.includes('"story-recut.json"'));
assert.ok(rendererSource.includes("manual_gemini_story_recut"));
assert.ok(rendererSource.includes("This is a SOURCE-AUDIO-ONLY edit."));
assert.ok(rendererSource.includes('narrationEnabled: !(isStoryRecutMode(setupMode) || isPodcastViralMode(setupMode))'));
assert.ok(indexSource.includes("100% âm thanh nguyên bản"));
assert.ok(rendererSource.includes("USER TASK INSTRUCTION - REPAIR ONE FAILED HIGHLIGHT SCRIPT"));
assert.ok(rendererSource.includes("EXACT REPAIR MAP (segment numbers are 1-based)"));
assert.ok(rendererSource.includes("CURRENT FAILED JSON TO REBUILD"));
assert.ok(rendererSource.includes("buildViralRepairTargets"));
assert.ok(rendererSource.includes("AUTHORITATIVE LOCKED EVIDENCE FOR THIS REPAIR"));
assert.ok(rendererSource.includes("getViralRepairContext"));
assert.ok(rendererSource.includes("sourceNarratorPresent=true is automatically muted"));
assert.ok(rendererSource.includes("script-${scriptId}-repaired.json"));
assert.ok(rendererSource.includes("The code block is the complete content to download and save as"));
assert.ok(rendererSource.includes("Do not output conversational prose, headings, labels, tables, Canvas, or text before or after the code block."));
assert.ok(rendererSource.includes("JSON CODE-BLOCK CONTRACT - HIGHEST PRIORITY"));
assert.ok(rendererSource.includes("Treat each code block as one separate downloadable file"));
assert.ok(rendererSource.includes('add a root field "voice_calibration_warning"'));
assert.ok(rendererSource.includes("Never place that warning outside the JSON code block."));
assert.ok(!rendererSource.includes("warn the user before the JSON"));
assert.ok(lockedPrompt.includes("STORY SPINE GATE - HIGHEST EDITORIAL PRIORITY"));
assert.ok(lockedPrompt.includes("HOOK CUT GATE"));
assert.ok(lockedPrompt.includes("transitionReason"));
assert.ok(lockedPrompt.includes("STORY-BLUEPRINT GATE"));
assert.ok(lockedPrompt.includes("OUTPUT TIMELINE IS DERIVED, NOT EDITORIAL"));
assert.ok(lockedPrompt.includes("SOURCE-RUN-FIRST GATE"));
assert.ok(lockedPrompt.includes("macroBlockId"));

const coalescedOriginalAudio = coalesceContiguousOriginalAudioSegments([
  {
    id: "highlight_0001",
    evidenceId: "evidence_0001",
    sourceStartSec: 10,
    sourceEndSec: 15,
    startSec: 0,
    endSec: 5,
    duration: 5,
    playbackSpeed: 1,
    audioMode: "original_audio",
    voiceoverText: ""
  },
  {
    id: "highlight_0002",
    evidenceId: "evidence_0002",
    sourceStartSec: 15,
    sourceEndSec: 22,
    startSec: 5,
    endSec: 12,
    duration: 7,
    playbackSpeed: 1,
    audioMode: "original_audio",
    voiceoverText: ""
  }
]);
assert.strictEqual(coalescedOriginalAudio.length, 1);
assert.strictEqual(coalescedOriginalAudio[0].sourceStartSec, 10);
assert.strictEqual(coalescedOriginalAudio[0].sourceEndSec, 22);
assert.deepStrictEqual(coalescedOriginalAudio[0].evidenceIds, ["evidence_0001", "evidence_0002"]);
assert.deepStrictEqual(coalescedOriginalAudio[0].renderMembers.map((item) => item.index), [0, 1]);

const voiceBoundaryIsPreserved = coalesceContiguousOriginalAudioSegments([
  {
    evidenceId: "evidence_0001",
    sourceStartSec: 10,
    sourceEndSec: 15,
    startSec: 0,
    endSec: 5,
    playbackSpeed: 1,
    voiceoverText: ""
  },
  {
    evidenceId: "evidence_0002",
    sourceStartSec: 15,
    sourceEndSec: 20,
    startSec: 5,
    endSec: 10,
    playbackSpeed: 1,
    voiceoverText: "The officer then discovered the hidden evidence."
  }
]);
assert.strictEqual(voiceBoundaryIsPreserved.length, 2);

const speedBoundaryIsPreserved = coalesceContiguousOriginalAudioSegments([
  {
    evidenceId: "evidence_0001",
    sourceStartSec: 10,
    sourceEndSec: 15,
    startSec: 0,
    endSec: 5,
    playbackSpeed: 1
  },
  {
    evidenceId: "evidence_0002",
    sourceStartSec: 15,
    sourceEndSec: 20,
    startSec: 5,
    endSec: 15,
    playbackSpeed: 0.5
  }
]);
assert.strictEqual(speedBoundaryIsPreserved.length, 2);

const narratorBoundaryIsPreserved = coalesceContiguousOriginalAudioSegments([
  {
    evidenceId: "evidence_0001",
    sourceStartSec: 0,
    sourceEndSec: 5,
    startSec: 0,
    endSec: 5,
    playbackSpeed: 1
  },
  {
    evidenceId: "evidence_0002",
    sourceStartSec: 5,
    sourceEndSec: 10,
    startSec: 5,
    endSec: 10,
    playbackSpeed: 1,
    replaceSourceNarrator: true
  }
]);
assert.strictEqual(narratorBoundaryIsPreserved.length, 2);

console.log("manualGeminiPackService tests passed");
require("./manualGeminiViralPreflight.test");
