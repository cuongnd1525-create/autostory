const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const ProjectStore = require("../electron/services/projectStore");
const GeminiDraftReviewService = require("../electron/services/geminiDraftReviewService");
const {
  appendHighlightRevisionHistory,
  buildDraftVoiceAlignmentReport,
  buildDraftReviewReadiness,
  getInspectedDraftRevision,
  hydrateDraftReviewStructure,
  normalizeHighlightCutScript,
  resolveDraftReviewBinding,
  resolveReviewedHighlightVariant
} = require("../electron/services/dubbingService");
const {
  parseGeminiJsonObject,
  unwrapStoryScript,
  detectGeminiArtifact
} = require("../electron/services/geminiJsonArtifactService");

const narrationReport = buildDraftVoiceAlignmentReport({
  project: {
    title: "Independent narration audit",
    analysisWorkflow: "manual_gemini_draft_review",
    analysis: {
      activeVariantId: "variant_01",
      highlightVariants: [{ id: "variant_01", promptProfile: "independent" }]
    }
  },
  segments: [
    { id: "beat_001", audioMode: "original_audio", sourceStartSec: 0, sourceEndSec: 5 },
    { id: "beat_002", audioMode: "voiceover_only", voiceoverText: "A deliberately long narration block.", sourceStartSec: 5, sourceEndSec: 17 },
    { id: "beat_003", audioMode: "voiceover_only", voiceoverText: "Another bridge.", sourceStartSec: 17, sourceEndSec: 22 }
  ],
  draftVoiceReports: [
    null,
    { rawVoiceSec: 12, plannedTimelineSec: 12, resolvedTimelineSec: 12, renderedText: "A deliberately long narration block." },
    { rawVoiceSec: 4, plannedTimelineSec: 5, resolvedTimelineSec: 4, renderedText: "Another bridge." }
  ]
});
assert.strictEqual(narrationReport.thresholds.maxContinuousNarrationSec, 8);
assert.strictEqual(narrationReport.thresholds.adjacentNarrationAllowed, false);
assert.ok(narrationReport.warnings.some((item) => item.status === "narration_block_too_long"));
assert.ok(narrationReport.warnings.some((item) => item.editorialWarnings.some((warning) => warning.includes("liền nhau"))));
assert.ok(narrationReport.geminiPrompt.includes("VO bridge 3-8s -> original_audio evidence"));
assert.ok(narrationReport.geminiPrompt.includes("voiceover_only"));
assert.ok(narrationReport.geminiPrompt.includes("tắt hoàn toàn soundtrack nguồn"));
assert.ok(!narrationReport.geminiPrompt.includes("phủ khoảng 85%-100%"));

const reviewChunks = GeminiDraftReviewService.selectReviewProxyChunks({
  chunks: Array.from({ length: 8 }, (_, index) => ({
    file: `proxy-${index + 1}.mp4`,
    sourceStartSec: index * 100,
    sourceEndSec: (index + 1) * 100
  }))
}, [{ sourceStartSec: 310, sourceEndSec: 350 }], 6);
assert.strictEqual(reviewChunks.length, 6);
assert.strictEqual(reviewChunks[0].sourceStartSec, 0);
assert.strictEqual(reviewChunks.at(-1).sourceEndSec, 800);
assert.ok(reviewChunks.some((chunk) => chunk.sourceStartSec === 300));

const semanticCues = GeminiDraftReviewService.parseSrtCues([
  "1",
  "00:00:00,000 --> 00:00:02,000",
  "[Officer] I'm not even going to tell you how stupid that was.",
  "",
  "2",
  "00:00:02,000 --> 00:00:04,000",
  "You just stacked on five more felony charges."
].join("\n"));
const semanticCandidates = GeminiDraftReviewService.buildSemanticDialogueCandidates(semanticCues);
assert.strictEqual(semanticCues.length, 2);
assert.strictEqual(semanticCandidates.candidates[0].speakerRole, "officer");
assert.strictEqual(semanticCandidates.candidates[0].speakerEvidence, "explicit_transcript_label");
assert.strictEqual(semanticCandidates.candidates.find((item) => item.cueId === "source_cue_00002").speakerRole, "unknown");
assert.ok(semanticCandidates.candidates.some((item) => item.semanticSignals.includes("sarcasm_or_irony")));

const hydratedReview = hydrateDraftReviewStructure({
  segments: [{ id: "highlight_0001", storyFunction: "hook" }]
}, {
  storyBlueprint: { macroBlocks: [{ macroBlockId: "macro_hook_01" }] },
  segments: [{
    id: "highlight_0001",
    evidenceId: "evidence_0001",
    sourceRunId: "source_run_hook_001",
    macroBlockId: "macro_hook_01",
    storyFunction: "hook",
    transitionReason: "Open on the confrontation."
  }]
});
assert.strictEqual(hydratedReview.story_blueprint.macroBlocks[0].macroBlockId, "macro_hook_01");
assert.strictEqual(hydratedReview.segments[0].macroBlockId, "macro_hook_01");
assert.strictEqual(hydratedReview.segments[0].sourceRunId, "source_run_hook_001");
assert.strictEqual(hydratedReview.segments[0].evidenceId, "evidence_0001");

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-draft-review-"));
  const workspaceRoot = path.join(root, "projects");
  const packRoot = path.join(root, "gemini-pack");
  const pass1Dir = path.join(packRoot, "01-GUI-GEMINI");
  await fs.mkdir(pass1Dir, { recursive: true });
  const sourceVideoPath = path.join(root, "source.mp4");
  await fs.writeFile(sourceVideoPath, "source-video");
  await fs.writeFile(path.join(pass1Dir, "analysis-proxy.mp4"), "proxy-video");
  await fs.writeFile(path.join(pass1Dir, "source-transcript.srt"), [
    "1",
    "00:00:00,000 --> 00:00:01,000",
    "[Officer] Stop now!",
    "",
    "2",
    "00:00:01,000 --> 00:00:03,000",
    "That is the dumbest thing you could have done."
  ].join("\n"));
  await fs.writeFile(path.join(pass1Dir, "scene-manifest.json"), JSON.stringify({
    sourceVideo: "source.mp4",
    videoDurationSec: 30,
    scenes: [{ sceneId: "scene_0001", startSec: 0, endSec: 30 }]
  }));

  const projectStore = new ProjectStore();
  const project = await projectStore.createProject(workspaceRoot, {
    title: "Draft Review",
    sourceVideoPath,
    mode: "highlight_cut",
    analysisWorkflow: "manual_gemini_draft_review",
    manualGeminiPackPath: packRoot
  });
  const paths = projectStore.getProjectPaths(workspaceRoot, project.id);
  const draftPath = path.join(paths.outputDir, "draft.mp4");
  const voiceReportPath = path.join(paths.outputDir, "voice.json");
  await fs.writeFile(draftPath, "draft-video");
  await fs.writeFile(voiceReportPath, JSON.stringify({ warningCount: 1 }));
  await projectStore.updateProject(workspaceRoot, project.id, {
    analysis: {
      mode: "highlight_cut",
      activeVariantId: "variant_01",
      segments: [],
      highlightVariants: [{
        id: "variant_01",
        label: "Test Variant",
        title: "Test Variant",
        scriptId: 4,
        promptProfile: "serialized_interleaved",
        seriesMode: "interleaved_multipart",
        seriesId: "case-series",
        partNumber: 3,
        partBadge: "PART 3",
        topHeader: "A verified case reaches its final turn",
        onScreenElements: [{ outputStartSec: 0, outputEndSec: 2, type: "text", text: "PART 3" }],
        sharedHookEnabled: true,
        interleavedAudioEnabled: true,
        cinematicNarratorEnabled: true,
        cliffhangerEnabled: true,
        targetDurationMinSec: 75,
        targetDurationMaxSec: 110,
        seriesPacing: "strict_10",
        language: "en",
        revisionNumber: 1,
        storyBlueprint: {
          macroBlocks: [{ macroBlockId: "macro_hook_01", storyFunction: "hook" }]
        },
        segments: [{
          id: "highlight_0001",
          sceneId: "scene_0001",
          sourceStartSec: 4,
          sourceEndSec: 12,
          startSec: 0,
          endSec: 8,
          duration: 8,
          playbackSpeed: 1,
          completeNarrativeBeat: true,
          completeNarrativeBeatType: "verbal_conflict",
          sustainedBeatId: "sustained_beat_001",
          sustainedBeatOverride: true,
          sourceNarratorDetected: true,
          audioMode: "voiceover_only",
          voiceoverText: "The deputy sees the suspect step into the open parking lot.",
          fastDraftVoiceSec: 4,
          fastDraftFitRatio: 0.5,
          fastDraftVoiceStatus: "too_short",
          fastDraftVoiceProfileWordsPerSecond: 2.7
        }],
        artifacts: {
          fastDraftVideoPath: draftPath,
          fastDraftVoiceWarningReportPath: voiceReportPath
        }
      }],
      artifacts: {}
    },
    artifacts: {}
  });

  const service = new GeminiDraftReviewService(projectStore);
  const result = await service.createPackage({ workspaceRoot, projectId: project.id });
  assert.strictEqual(result.revision, 1);
  assert.strictEqual(result.segmentCount, 1);
  assert.ok(result.uploadFileCount <= 10);
  assert.ok(result.reviewDir.endsWith("01-UPLOAD-TO-GEMINI"));
  assert.deepStrictEqual(result.uploadFiles, [
    "analysis-proxy.mp4",
    "draft-v1.mp4",
    "gemini-draft-review-prompt.txt",
    "review-context.json",
    "source-transcript.srt"
  ]);
  assert.ok((await fs.stat(result.draftPath)).size > 0);
  const reviewContext = JSON.parse(await fs.readFile(result.contextPath, "utf8"));
  assert.strictEqual(reviewContext.artifactType, "gemini_draft_review_context");
  assert.strictEqual(reviewContext.schemaVersion, 2);
  assert.strictEqual(reviewContext.reviewTarget.projectId, project.id);
  assert.strictEqual(reviewContext.reviewTarget.variantId, "variant_01");
  assert.strictEqual(reviewContext.reviewTarget.reviewedRevision, 1);
  assert.strictEqual(reviewContext.reviewTarget.reviewBindingId.length, 24);
  assert.strictEqual(reviewContext.script.artifactType, "highlight_cut_script");
  assert.strictEqual(reviewContext.script.story_blueprint.macroBlocks[0].macroBlockId, "macro_hook_01");
  assert.strictEqual(reviewContext.draftTimeline.artifactType, "draft_timeline");
  assert.strictEqual(reviewContext.sceneManifest.scenes[0].sceneId, "scene_0001");
  assert.strictEqual(reviewContext.voiceTimingReport.warningCount, 1);
  assert.strictEqual(reviewContext.transcriptInput.available, true);
  assert.strictEqual(reviewContext.transcriptInput.embedded, false);
  assert.strictEqual(reviewContext.transcriptInput.location, "source-transcript.srt");
  assert.strictEqual(reviewContext.transcriptInput.cueCount, 2);
  assert.strictEqual(reviewContext.transcriptInput.sha256.length, 64);
  assert.strictEqual(Object.hasOwn(reviewContext, "sourceTranscriptSrt"), false);
  assert.strictEqual(reviewContext.semanticDialogueCandidates.cueCount, 2);
  assert.ok(reviewContext.semanticDialogueCandidates.candidates.length > 0);
  assert.ok(reviewContext.semanticDialogueCandidates.candidates.some((item) => item.text.includes("dumbest")));
  const packageInfo = JSON.parse(await fs.readFile(path.join(result.packageRoot, "review-package-info.json"), "utf8"));
  assert.strictEqual(packageInfo.dialogueCandidatesEmbeddedInContext, true);
  assert.strictEqual(packageInfo.transcriptInput.cueCount, 2);
  assert.ok((await fs.stat(packageInfo.dialogueCandidatesPath)).size > 0);
  const prompt = await fs.readFile(result.promptPath, "utf8");
  assert.ok(prompt.includes("Watch draft-v1.mp4 from beginning to end"));
  assert.ok(prompt.includes("gemini-draft-review.json"));
  assert.ok(prompt.includes("wrapped tightly inside a Markdown code block"));
  assert.ok(prompt.includes("Do not generate any conversational prose before or after the code block"));
  assert.ok(!prompt.includes("Do not return prose, Markdown, a code fence"));
  assert.ok(!prompt.includes("Attach that file so the Gemini UI shows a Download button"));
  assert.ok(prompt.includes("targetWordBudget"));
  assert.ok(prompt.includes("review-context.json"));
  assert.ok(prompt.includes("SEMANTIC DIALOGUE AUDIT - BEFORE ACTION RADAR"));
  assert.ok(prompt.includes("semanticQuoteAudit"));
  assert.ok(prompt.includes("Only after this semantic audit may action-candidates"));
  assert.ok(prompt.includes("speakerRole MUST be \"unknown\""));
  assert.ok(prompt.includes("Copy reviewTarget EXACTLY"));
  assert.ok(prompt.includes(reviewContext.reviewTarget.reviewBindingId));
  assert.ok(prompt.includes("MANDATORY REVIEW METHOD - TIKTOK VIRAL EDITING"));
  assert.ok(prompt.includes("OUTPUT TIMELINE IS DERIVED, NOT EDITORIAL"));
  assert.ok(prompt.includes("The local tool will reflow them and its calculation is authoritative"));
  assert.ok(prompt.includes("ONE-SCENE-PER-SEGMENT TIMESTAMP GATE"));
  assert.ok(prompt.includes("Never cross a scene-manifest boundary"));
  assert.ok(prompt.includes("AGGRESSIVE RESTRUCTURING"));
  assert.ok(prompt.includes("PSYCHOLOGICAL WTF HOOK OVERRIDE"));
  assert.ok(prompt.includes("seemingly calm but deeply disturbing denial"));
  assert.ok(prompt.includes("cut exactly before the narrator begins"));
  assert.ok(prompt.includes("calm but deeply disturbing denial"));
  assert.ok(prompt.includes("remove pauses, silences, or non-essential dialogue longer than 0.5 seconds"));
  assert.ok(prompt.includes("caption_emphasis_words"));
  assert.ok(prompt.includes("SERIALIZED PART REVIEW OVERRIDE"));
  assert.ok(prompt.includes("Preserve every sustainedBeatOverride=true Complete Narrative Beat"));
  assert.ok(prompt.includes("It may last 5-30 seconds"));
  assert.ok(prompt.includes("Trim it immediately before any source narrator begins"));
  assert.ok(prompt.includes('"source_narrator_detected": false'));
  assert.ok(prompt.includes("CRITICAL EDITORIAL REVIEW RULES - PROMPT PATCH V3.0"));
  assert.ok(prompt.includes("ANTI-CLONE VOICEOVER RULE"));
  assert.ok(prompt.includes("SOURCE NARRATOR FILTER"));
  assert.ok(prompt.includes("ACTION PAYOFF & VISUAL MATCHING"));
  assert.ok(prompt.includes("NON-REDUNDANT NARRATION"));
  assert.ok(prompt.includes("SCENE BRIDGING & CONTEXT TRANSITIONS"));
  assert.ok(prompt.includes("CRITICAL ANTI-TALKING-HEAD REVIEW"));
  assert.ok(prompt.includes("ANTI-HALLUCINATION AND CROSS-CASE CONTAMINATION"));
  assert.ok(prompt.includes("SPOILER BAN"));
  assert.ok(prompt.includes("Only Part 3 may deliver those verified reveals"));
  assert.ok(prompt.includes("ANTI-HALLUCINATION VISUAL RULE"));
  assert.ok(prompt.includes("ZERO-TOLERANCE SOURCE NARRATOR FILTER"));
  assert.ok(prompt.includes("overrides sustainedBeatOverride"));
  assert.ok(prompt.includes("Do not count testimony about an event as visual payoff"));
  assert.ok(prompt.includes("user's selected tool voice"));
  assert.ok(prompt.includes('"sustainedBeatOverride": true'));
  assert.ok(prompt.includes("Part 3 of a three-Part serialized case"));
  assert.ok(prompt.includes('"part_number": 3'));
  assert.ok(prompt.includes('"series_mode": "interleaved_multipart"'));
  assert.ok(prompt.includes("split_screen_911"));
  assert.ok(prompt.includes('"segmentId": "highlight_0001"'));
  assert.ok(prompt.includes('"story_blueprint"'));
  assert.ok(prompt.includes('"macroBlockId": "macro_hook_01"'));
  assert.ok(prompt.includes('"sourceRunId": "source_run_hook_001"'));
  const genZPrompt = GeminiDraftReviewService.buildReviewPrompt({
    variant: {
      scriptId: 1,
      promptProfile: "serialized_genz",
      seriesMode: "interleaved_multipart",
      seriesId: "genz-series",
      partNumber: 1,
      revisionNumber: 1,
      segments: []
    },
    draftTimeline: { segments: [] },
    sourceProxyFiles: ["analysis-proxy.mp4"],
    hasTranscript: true
  });
  assert.ok(genZPrompt.includes("SERIALIZED GEN-Z TONE REVIEW OVERRIDE"));
  assert.ok(genZPrompt.includes('Preserve prompt_profile="serialized_genz"'));
  assert.ok(genZPrompt.includes('"prompt_profile": "serialized_genz"'));
  assert.ok(genZPrompt.includes("audience's inner voice"));
  assert.ok(genZPrompt.includes("first voiceover sentence in this Part must contain a curiosity gap"));
  const independentPrompt = GeminiDraftReviewService.buildReviewPrompt({
    variant: {
      scriptId: 4,
      promptProfile: "independent",
      revisionNumber: 1,
      sourceNarratorPolicy: "forbidden",
      timelinePolicy: "hook_anywhere_then_one_context_reset_then_chronological",
      independentPromptOptions: {
        hookPriority: ["dialogue_conflict", "psychological_wtf", "high_action", "evidence_reveal"],
        hookMaxSec: 20,
        narratorTone: "genz",
        audioBalance: "balanced",
        pacing: "story_first",
        ending: "payoff_comment",
        overlays: true
      },
      segments: []
    },
    draftTimeline: { segments: [] },
    sourceProxyFiles: ["analysis-proxy.mp4"],
    hasTranscript: true,
    sourceCoverageComplete: true
  });
  assert.ok(independentPrompt.startsWith("STEP 0 - VERIFIED INPUT ACCESS GATE"));
  assert.ok(independentPrompt.includes('"artifactType": "gemini_input_access_failure"'));
  assert.ok(independentPrompt.includes('"inputAccessAudit"'));
  assert.ok(independentPrompt.includes("Before judging V1, independently define the strongest edit"));
  assert.ok(independentPrompt.includes('reviewDecision="patch"'));
  assert.ok(independentPrompt.includes('reviewDecision="rebuild"'));
  assert.ok(independentPrompt.includes("STORY COHERENCE GATE"));
  assert.ok(independentPrompt.includes("Central Viewer Question"));
  assert.ok(independentPrompt.includes("returns to the exact Climax promised by the Hook"));
  assert.ok(independentPrompt.includes("Narration is written as one global arc"));
  assert.ok(independentPrompt.includes("fresh Semantic Hook Tournament"));
  assert.ok(independentPrompt.includes("HOOK REPLACEMENT GATE"));
  assert.ok(independentPrompt.includes("HOOK TRIGGER GATE"));
  assert.ok(independentPrompt.includes("TRANSITION COVERAGE - TOOL-VERIFIABLE"));
  assert.ok(independentPrompt.includes("TEASER-CLIMAX HANDOFF"));
  assert.ok(independentPrompt.includes('"hookTriggerAudit"'));
  assert.ok(independentPrompt.includes('"teaserClimaxAudit"'));
  assert.ok(independentPrompt.includes('"visualMatchAnchor"'));
  assert.ok(independentPrompt.includes("Every unresolved chronology, location, actor, or causal jump requires a concise bridge"));
  assert.ok(independentPrompt.includes("exceeds V1 by 1.0 point or more"));
  assert.ok(independentPrompt.includes("VIRAL MOMENT INVENTORY"));
  assert.ok(independentPrompt.includes("voiceover_with_ambient"));
  assert.ok(independentPrompt.includes("action-candidates rank, motionScore, and audioEnergyScore are discovery hints only"));
  assert.ok(independentPrompt.includes('"hookReplacementAudit"'));
  assert.ok(independentPrompt.includes("Narrative Beats may cross consecutive scene boundaries"));
  assert.ok(independentPrompt.includes("Do not return startSec/endSec/outputStartSec/outputEndSec"));
  assert.ok(independentPrompt.includes('"artifactType": "story_spine_edit_script"'));
  assert.ok(independentPrompt.includes('"storyContract"'));
  assert.ok(independentPrompt.includes('"narrativeBeats"'));
  assert.ok(independentPrompt.includes('"narrationArc"'));
  assert.ok(independentPrompt.includes('"causalLinkFromPrevious"'));
  assert.ok(independentPrompt.includes('"advancesViewerQuestion"'));
  assert.ok(independentPrompt.includes("Source coverage is complete"));
  assert.ok(!independentPrompt.includes("ONE-SCENE-PER-SEGMENT TIMESTAMP GATE"));
  const independentScriptOnePrompt = GeminiDraftReviewService.buildReviewPrompt({
    variant: {
      scriptId: 1,
      promptProfile: "independent",
      revisionNumber: 1,
      sourceNarratorPolicy: "forbidden",
      segments: []
    },
    draftTimeline: { segments: [] },
    sourceProxyFiles: ["analysis-proxy.mp4"],
    hasTranscript: true,
    sourceCoverageComplete: true
  });
  assert.ok(independentScriptOnePrompt.includes("SCRIPT 1 NARRATOR PRESENCE GATE"));
  assert.ok(independentScriptOnePrompt.includes("at least two concise, non-adjacent voiceover_only Narrative Beats"));
  assert.ok(independentScriptOnePrompt.includes("A single legal-outcome voiceover at the end is invalid"));
  assert.ok(!independentScriptOnePrompt.includes("Use roughly 50-65% tool narration"));
  const independentTimeline = GeminiDraftReviewService.buildDraftTimeline({
    promptProfile: "independent",
    segments: [{
      id: "highlight_0001",
      startSec: 0,
      endSec: 10,
      sourceStartSec: 20,
      sourceEndSec: 30,
      audioMode: "voiceover_only",
      voiceoverText: "A concise verified bridge.",
      fastDraftVoiceProfileWordsPerSecond: 3
    }]
  });
  assert.strictEqual(independentTimeline.segments[0].targetWordBudget.minWords, undefined);
  assert.strictEqual(independentTimeline.segments[0].targetWordBudget.maxWords, 24);
  assert.strictEqual(independentTimeline.segments[0].targetWordBudget.policy, "maximum_only_no_filler");
  const policeBlotterPrompt = GeminiDraftReviewService.buildReviewPrompt({
    variant: {
      scriptId: 3,
      promptProfile: "viral_police_blotter",
      revisionNumber: 1,
      segments: []
    },
    draftTimeline: { segments: [] },
    sourceProxyFiles: ["analysis-proxy.mp4"],
    hasTranscript: true
  });
  assert.ok(policeBlotterPrompt.includes("VIRAL POLICE BLOTTER REVIEW OVERRIDE"));
  assert.ok(policeBlotterPrompt.includes('Preserve prompt_profile="viral_police_blotter"'));
  assert.ok(policeBlotterPrompt.includes("exactly four voiceover_only narrator blocks"));
  assert.ok(policeBlotterPrompt.includes("Police_Report_Intro, Shocking_Reveal, Moral_Contrast, Specific_Cliffhanger"));
  assert.ok(policeBlotterPrompt.includes('"prompt_profile": "viral_police_blotter"'));
  const diyReviewPrompt = GeminiDraftReviewService.buildReviewPrompt({
    variant: {
      workflow: "diy_story_remix",
      revisionNumber: 1,
      segments: []
    },
    draftTimeline: { segments: [] },
    sourceProxyFiles: ["analysis-proxy.mp4"],
    hasTranscript: false
  });
  assert.ok(diyReviewPrompt.includes("DIY STORY REMIX REVIEW OVERRIDE"));
  assert.ok(diyReviewPrompt.includes("CRITICAL DIY EDITORIAL REVIEW RULES"));
  assert.ok(diyReviewPrompt.includes("object-state continuity"));
  assert.ok(diyReviewPrompt.includes('"style": "DIY Story Remix"'));
  assert.ok(!diyReviewPrompt.includes("CRITICAL ANTI-TALKING-HEAD REVIEW"));
  assert.ok(!diyReviewPrompt.includes("PLATFORM SAFETY: Do not show a gunshot"));
  const scriptV1 = JSON.parse(await fs.readFile(result.scriptPath, "utf8"));
  assert.strictEqual(scriptV1.segments[0].sustainedBeatOverride, true);
  assert.strictEqual(scriptV1.segments[0].source_narrator_detected, true);
  assert.strictEqual(scriptV1.segments[0].sustainedBeatId, "sustained_beat_001");
  const timeline = JSON.parse(await fs.readFile(result.timelinePath, "utf8"));
  assert.strictEqual(timeline.segments[0].measuredCoverageRatio, 0.5);
  assert.deepStrictEqual(timeline.segments[0].targetWordBudget, {
    minWords: 19,
    maxWords: 22,
    policy: "fit_window"
  });

  const wrapper = parseGeminiJsonObject(JSON.stringify({
    artifactType: "gemini_draft_review",
    reviewedRevision: 1,
    review: { scoreBefore: 50, scoreAfterEstimated: 80, issues: [] },
    revisedScript: { scriptId: 4, segments: [{ id: "highlight_0001" }] }
  }));
  assert.strictEqual(unwrapStoryScript(wrapper).segments.length, 1);
  const detectedReview = detectGeminiArtifact(wrapper);
  assert.strictEqual(detectedReview.type, "gemini_draft_review");
  assert.strictEqual(detectedReview.importRoute, "review_revision");

  const normalized = normalizeHighlightCutScript({
    title: "Reviewed",
    prompt_profile: "serialized_interleaved",
    series_mode: "interleaved_multipart",
    series_id: "case-series",
    part_number: 3,
    part_badge: "PART 3",
    top_banner_text: "Verified banner",
    target_duration_min_sec: 75,
    target_duration_max_sec: 110,
    total_target_sec: 5,
    segments: [{
      segmentId: "highlight_0001",
      sceneId: "scene_0001",
      sourceStartSec: 4,
      sourceEndSec: 9,
      outputStartSec: 0,
      outputEndSec: 5,
      playbackSpeed: 1,
      audio_mode: "original_audio",
      visual_layout: "split_screen_911",
      caption_emphasis_words: ["911 CALL", "SHOTS FIRED"],
      action_notes: "Highlight 911 CALL and SHOTS FIRED."
    }]
  }, 30);
  assert.strictEqual(normalized.segments[0].id, "highlight_0001");
  assert.strictEqual(normalized.segments[0].outputEndSec, 5);
  assert.strictEqual(normalized.segments[0].visualLayout, "split_screen_911");
  assert.deepStrictEqual(normalized.segments[0].captionEmphasisWords, ["911 CALL", "SHOTS FIRED"]);
  assert.strictEqual(normalized.seriesMode, "interleaved_multipart");
  assert.strictEqual(normalized.partNumber, 3);
  assert.strictEqual(normalized.topHeader, "Verified banner");

  const routedVariant = resolveReviewedHighlightVariant({
    analysis: {
      activeVariantId: "variant_03",
      highlightVariants: [
        { id: "variant_01", scriptId: 1 },
        { id: "variant_03", scriptId: 3 }
      ]
    }
  }, { scriptId: 1 }, true);
  assert.strictEqual(routedVariant.id, "variant_01");

  const directlyReplacedVariant = resolveReviewedHighlightVariant({
    analysis: {
      activeVariantId: "variant_03",
      highlightVariants: [
        { id: "variant_01", scriptId: 1 },
        { id: "variant_03", scriptId: 3 }
      ]
    }
  }, { scriptId: 1 }, false);
  assert.strictEqual(directlyReplacedVariant.id, "variant_01");

  const activeReplacementFallback = resolveReviewedHighlightVariant({
    analysis: {
      activeVariantId: "variant_03",
      highlightVariants: [
        { id: "variant_01", scriptId: 1 },
        { id: "variant_03", scriptId: 3 }
      ]
    }
  }, {}, false);
  assert.strictEqual(activeReplacementFallback.id, "variant_03");

  const history = appendHighlightRevisionHistory({
    revisionNumber: 1,
    revisionLabel: "V1",
    segments: [{ id: "highlight_0001", voiceoverText: "Original V1" }],
    artifacts: { fastDraftVideoPath: draftPath }
  });
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].segments[0].voiceoverText, "Original V1");
  assert.strictEqual(history[0].artifacts.fastDraftVideoPath, draftPath);
  const readiness = buildDraftReviewReadiness({
    draftReview: {
      scoreAfterEstimated: 90,
      issues: [{ category: "continuity" }, { category: "voice_visual_match" }]
    }
  }, {
    generatedAt: new Date().toISOString(),
    segments: [{ status: "ok", severity: "ok", coverageRatio: 0.95 }]
  });
  assert.ok(readiness.score >= 70 && readiness.score <= 90);
  assert.strictEqual(readiness.components.measuredVoiceCoverage, 100);

  const updated = await projectStore.getProject(workspaceRoot, project.id);
  assert.strictEqual(updated.analysis.highlightVariants[0].artifacts.draftReviewPackagePath, result.reviewDir);
  assert.strictEqual(updated.analysis.highlightVariants[0].artifacts.draftReviewBindingId, reviewContext.reviewTarget.reviewBindingId);
  assert.strictEqual(updated.analysis.highlightVariants[0].artifacts.draftReviewRevision, 1);

  assert.strictEqual(getInspectedDraftRevision({
    inspectedInputs: [{ name: "draft-v2.mp4", opened: true, parsed: true }]
  }), 2);
  const legacyRevisionRepair = resolveDraftReviewBinding({
    projectId: "project-1",
    variant: {
      id: "variant_03",
      scriptId: 4,
      revisionNumber: 2,
      artifacts: { draftReviewPackagePath: "C:\\pack\\variant-03-v2-20260827034135\\01-UPLOAD-TO-GEMINI" }
    },
    artifact: {
      reviewedRevision: 1,
      inputAccessAudit: {
        inspectedInputs: [{ name: "draft-v2.mp4", opened: true, parsed: true }]
      }
    },
    jsonPath: "C:\\downloads\\review.json",
    artifactHash: "new-hash"
  });
  assert.strictEqual(legacyRevisionRepair.reviewedRevision, 2);
  assert.ok(legacyRevisionRepair.warning.includes("tự sửa thành V2"));

  const boundRevisionRepair = resolveDraftReviewBinding({
    projectId: "project-1",
    variant: {
      id: "variant_03",
      scriptId: 4,
      revisionNumber: 2,
      artifacts: {
        draftReviewBindingId: "binding-123",
        draftReviewRevision: 2
      }
    },
    artifact: {
      reviewedRevision: 1,
      reviewTarget: {
        projectId: "project-1",
        variantId: "variant_03",
        scriptId: 4,
        reviewedRevision: 2,
        reviewBindingId: "binding-123"
      }
    },
    jsonPath: "C:\\downloads\\review.json",
    artifactHash: "new-hash"
  });
  assert.strictEqual(boundRevisionRepair.reviewedRevision, 2);
  assert.ok(boundRevisionRepair.warning.includes("reviewTarget"));

  const renamedReapply = resolveDraftReviewBinding({
    projectId: "project-1",
    variant: {
      id: "variant_03",
      scriptId: 4,
      revisionNumber: 3,
      artifacts: {
        draftReviewBindingId: "binding-123",
        draftReviewRevision: 2,
        draftReviewImportHash: "same-content"
      }
    },
    artifact: {
      reviewedRevision: 2,
      reviewTarget: {
        projectId: "project-1",
        variantId: "variant_03",
        scriptId: 4,
        reviewedRevision: 2,
        reviewBindingId: "binding-123"
      }
    },
    jsonPath: "C:\\downloads\\renamed-review.json",
    artifactHash: "same-content"
  });
  assert.strictEqual(renamedReapply.reapplyCurrentReviewFile, true);
  await fs.rm(root, { recursive: true, force: true });
  console.log("Gemini Draft Review service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
