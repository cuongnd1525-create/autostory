const DEFAULT_WORDS_PER_SECOND = 2.35;
const DEFAULT_SERIES_POWER_WORDS = "catastrophic, nightmare, absolute devastation, crushing reality check, racing against time, death trap, fatal mistake, chilling confession";
const DEFAULT_INDEPENDENT_POWER_WORDS = "caught on camera, the audacity, instant contradiction, chilling detail, split-second decision, impossible excuse, the evidence changed everything";
const DEFAULT_INDEPENDENT_HOOK_PRIORITY = [
  "high_action",
  "dialogue_conflict",
  "psychological_wtf",
  "rage_irony",
  "evidence_reveal"
];
const MODE_PRESENTATION = Object.freeze({
  highlight_cut: {
    category: "highlight",
    categoryLabel: "HIGHLIGHT & TRUE CRIME",
    title: "Cắt đoạn hay từ video dài",
    description: "Nhập JSON có timestamp nguồn để cắt Highlight nhanh trong một lượt.",
    badges: ["JSON", "1 lượt", "Audio theo cảnh"],
    nextHint: "Bước tiếp theo: chọn giọng cho các đoạn voiceover.",
    configurable: false
  },
  manual_gemini_pro: {
    category: "highlight",
    categoryLabel: "HIGHLIGHT & TRUE CRIME",
    title: "Viết kịch bản rồi review video thật",
    description: "Gemini tạo kịch bản V1, xem bản draft đã dựng và trả về revision V2.",
    badges: ["Gemini", "2 lượt", "True Crime"],
    nextHint: "Bước tiếp theo: đo voice budget cho kịch bản.",
    configurable: true
  },
  vertex_auto_story: {
    category: "highlight",
    categoryLabel: "HIGHLIGHT & TRUE CRIME",
    title: "True Crime Auto Story",
    description: "Vertex hiểu toàn bộ nguồn, khóa story spine, tạo timeline và render draft tự động.",
    badges: ["Vertex", "1-5 video", "65s+"],
    nextHint: "Bước tiếp theo: chọn giọng narrator cho các đoạn dẫn.",
    configurable: true
  },
  story_recut: {
    category: "story",
    categoryLabel: "STORY & DIY",
    title: "Dựng lại câu chuyện phi tuyến",
    description: "Sắp xếp lại các khối cảnh nhưng giữ nguyên voice, hội thoại và âm thanh nguồn.",
    badges: ["Phi tuyến", "100% âm gốc", "Không TTS"],
    nextHint: "Bước tiếp theo: xác nhận cấu hình âm thanh gốc.",
    configurable: false
  },
  satisfying_storytime: {
    category: "story",
    categoryLabel: "STORY & DIY",
    title: "Video thỏa mãn + kể chuyện",
    description: "Dùng kịch bản JSON để tạo voice khớp với từng nhịp hình ảnh.",
    badges: ["Storytime", "Voice khớp cảnh", "JSON"],
    nextHint: "Bước tiếp theo: chọn giọng kể chuyện.",
    configurable: false
  },
  diy_story_remix: {
    category: "story",
    categoryLabel: "STORY & DIY",
    title: "Tái dựng video DIY thành câu chuyện mới",
    description: "Khóa quá trình vật lý, chọn góc kể và viết voice mới khớp từng thao tác.",
    badges: ["Visual grounded", "Story mới", "Voice locked"],
    nextHint: "Bước tiếp theo: chọn giọng cho câu chuyện DIY.",
    configurable: true
  },
  podcast_viral_cut: {
    category: "podcast",
    categoryLabel: "PODCAST",
    title: "Cắt hội thoại Podcast viral",
    description: "Tìm câu thoại đắt giá, khóa timestamp và dựng 1-5 video chỉ bằng âm thanh gốc.",
    badges: ["1-5 video", "Original audio", "Không TTS"],
    nextHint: "Bước tiếp theo: xác nhận không dùng voice AI.",
    configurable: true
  },
  dubbing: {
    category: "dubbing",
    categoryLabel: "DỊCH VIDEO",
    title: "Thuyết minh & dịch phim",
    description: "Nhận diện lời thoại, dịch ngữ cảnh và tạo thuyết minh theo giọng đã chọn.",
    badges: ["Whisper", "Dịch ngữ cảnh", "Voice AI"],
    nextHint: "Bước tiếp theo: cấu hình giọng đọc.",
    configurable: false
  },
  recap: {
    category: "recap",
    categoryLabel: "AI VIDEO RECAP",
    title: "AI Video Recap (Đồng bộ thị giác cao cấp)",
    description: "Tự động hiểu cốt truyện, phân rã Visual Events và lồng tiếng Anh chuẩn khớp từng hành động thị giác.",
    badges: ["AI Recap", "Grounded Sync", "Editor-Grade", "Auto & Review"],
    nextHint: "Bước tiếp theo: chọn giọng thuyết minh và cấu hình thời lượng recap.",
    configurable: true
  }
});
const MODE_CATEGORY_DEFAULTS = Object.freeze({
  recap: "recap",
  highlight: "manual_gemini_pro",
  story: "diy_story_remix",
  podcast: "podcast_viral_cut",
  dubbing: "dubbing"
});

const state = {
  settings: null,
  projects: [],
  currentProject: null,
  currentStep: 1,
  selectedMode: "recap",
  selectedSegmentIndex: 0,
  expandedScenePickerIndex: -1,
  pendingSceneChoices: {},
  busy: false,
  logLines: [],
  activities: [],
  rawLogVisible: false,
  activeOperation: "",
  reviewingSegmentIndex: -1,
  presetVoices: [],
  draftPresetVoices: [],
  previewAudio: null,
  voiceCalibration: null,
  finalVoiceCalibration: null,
  draftVoiceCalibration: null,
  variantExportQueue: [],
  revisionPreviewPath: "",
  videoEditScope: "global",
  videoEditPreviewMode: false
};
const modeCategoryMemory = { ...MODE_CATEGORY_DEFAULTS };

const inspectorState = {
  segmentIndex: -1,
  text: "",
  speaker: ""
};

const TIMELINE_PX_PER_SEC = 42;
let isTimelineScrubbing = false;
let lastPreviewSyncIndex = -1;
let voiceSetupSaveTimer = null;
let suppressPreviewSyncUntil = 0;
let subtitleMaskEditorActive = false;
let subtitleMaskPointerState = null;
let subtitleMaskSaveTimer = null;
let videoEditSaveTimer = null;
let foregroundPointerState = null;
let titlePointerState = null;
let partLabelPointerState = null;
let confirmActionResolver = null;
let confirmActionPreviousFocus = null;

const stepLabels = [
  "D\u1ef1 \u00e1n",
  "Ch\u1ebf \u0111\u1ed9",
  "Gi\u1ecdng",
  "Ngu\u1ed3n",
  "K\u1ecbch b\u1ea3n",
  "Xem tr\u01b0\u1edbc"
];

const setupDraftKey = "cineviral.setupDraft.v2";

const el = {};

function isRecapMode(mode = state.selectedMode) {
  return mode === "recap";
}

function isScriptRewriteMode(mode = state.selectedMode) {
  return mode === "script_rewrite";
}

function isSatisfyingStorytimeMode(mode = state.selectedMode) {
  return mode === "satisfying_storytime";
}

function isHighlightCutMode(mode = state.selectedMode) {
  return mode === "highlight_cut";
}

function isManualGeminiProMode(mode = state.selectedMode) {
  return mode === "manual_gemini_pro";
}

function isAutoStoryMode(mode = state.selectedMode) {
  return mode === "vertex_auto_story";
}

function isStoryRecutMode(mode = state.selectedMode) {
  return mode === "story_recut";
}

function isDiyStoryRemixMode(mode = state.selectedMode) {
  return mode === "diy_story_remix";
}

function isPodcastViralMode(mode = state.selectedMode) {
  return mode === "podcast_viral_cut";
}

function isPodcastTwoPassMode() {
  return isPodcastViralMode() && (el.podcastWorkflowMode?.value || "quality_two_pass") === "quality_two_pass";
}

function isManualGeminiWorkflowMode(mode = state.selectedMode) {
  return isManualGeminiProMode(mode) || isStoryRecutMode(mode) || isDiyStoryRemixMode(mode) || isPodcastViralMode(mode);
}

function isHighlightCutProject(project = state.currentProject) {
  return project?.mode === "highlight_cut";
}

function isJsonPlanMode(mode = state.selectedMode) {
  return isSatisfyingStorytimeMode(mode) || isHighlightCutMode(mode) || isManualGeminiWorkflowMode(mode);
}

function getNarrationModeForVoice(mode = state.selectedMode) {
  if (isSatisfyingStorytimeMode(mode)) return "satisfying_storytime";
  if (isHighlightCutMode(mode) || isManualGeminiWorkflowMode(mode) || isAutoStoryMode(mode)) return "highlight_cut";
  return "dubbing";
}

function getNarrationLanguageForVoice(mode = state.selectedMode) {
  if (isDiyStoryRemixMode(mode)) return el.targetLanguage?.value || "en";
  return isJsonPlanMode(mode) ? "en" : (el.targetLanguage?.value || "en");
}

function getModePresentation(mode = state.selectedMode) {
  return MODE_PRESENTATION[mode] || MODE_PRESENTATION.dubbing;
}

function syncModeSelectionUi() {
  const presentation = getModePresentation();
  const activeCategory = presentation.category;
  modeCategoryMemory[activeCategory] = state.selectedMode;

  document.querySelectorAll("[data-mode-category-tab]").forEach((button) => {
    const active = button.dataset.modeCategoryTab === activeCategory;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });

  let visibleCount = 0;
  document.querySelectorAll("[data-mode][data-mode-group]").forEach((button) => {
    const visible = button.dataset.modeGroup === activeCategory && !button.classList.contains("hidden");
    button.classList.toggle("mode-category-hidden", !visible);
    button.classList.toggle("active", button.dataset.mode === state.selectedMode);
    button.setAttribute("aria-pressed", button.dataset.mode === state.selectedMode ? "true" : "false");
    if (visible) visibleCount += 1;
  });

  if (el.modeCategoryCount) el.modeCategoryCount.textContent = `${visibleCount} chế độ`;
  if (el.modeSelectionCategory) el.modeSelectionCategory.textContent = presentation.categoryLabel;
  if (el.modeSelectionTitle) el.modeSelectionTitle.textContent = presentation.title;
  if (el.modeSelectionDescription) el.modeSelectionDescription.textContent = presentation.description;
  if (el.modeSelectionBadges) {
    el.modeSelectionBadges.innerHTML = presentation.badges
      .map((badge) => `<span>${escapeHtml(badge)}</span>`)
      .join("");
  }
  if (el.modeConfigEmpty) el.modeConfigEmpty.classList.toggle("hidden", presentation.configurable);
  if (el.modeSelectionSummary) el.modeSelectionSummary.textContent = presentation.title;
  if (el.modeSelectionNextHint) el.modeSelectionNextHint.textContent = presentation.nextHint;
}

function selectSetupMode(mode, { persist = true, invalidate = true } = {}) {
  if (!MODE_PRESENTATION[mode]) return;
  const previousMode = state.selectedMode;
  state.selectedMode = mode;
  modeCategoryMemory[getModePresentation(mode).category] = mode;
  if (invalidate
    && previousMode !== state.selectedMode
    && (isManualGeminiWorkflowMode(previousMode) || isManualGeminiWorkflowMode(state.selectedMode))) {
    invalidateManualGeminiPack("Chế độ phân tích Gemini đã thay đổi.");
  }
  if (["recap", "satisfying_storytime", "manual_gemini_pro", "story_recut", "diy_story_remix", "podcast_viral_cut", "vertex_auto_story"].includes(state.selectedMode) && el.targetLanguage) {
    el.targetLanguage.value = "en";
  }
  if (isPodcastViralMode() && el.sourceLanguage) el.sourceLanguage.value = "en";
  syncModeUi();
  if (persist) writeSetupDraft();
  renderSteps();
}

function $(id) {
  return document.getElementById(id);
}

function queryElements() {
    Object.assign(el, {
    runAutoReviewCurrent: $("run-auto-review-current"),
    runAutoReviewAll: $("run-auto-review-all"),
    setupView: $("setup-view"),
    studioView: $("studio-view"),
    wizardSteps: $("wizard-steps"),
    setupSubtitle: $("setup-subtitle"),
    projectTitle: $("project-title"),
    confirmProject: $("confirm-project"),
    modeCategoryCount: $("mode-category-count"),
    modeSelectionCategory: $("mode-selection-category"),
    modeSelectionTitle: $("mode-selection-title"),
    modeSelectionDescription: $("mode-selection-description"),
    modeSelectionBadges: $("mode-selection-badges"),
    modeConfigEmpty: $("mode-config-empty"),
    modeSelectionSummary: $("mode-selection-summary"),
    modeSelectionNextHint: $("mode-selection-next-hint"),
    aiProvider: $("ai-provider"),
    ollamaVisionAssist: $("ollama-vision-assist"),
    ollamaVisionModel: $("ollama-vision-model"),
    refreshOllamaModels: $("refresh-ollama-models"),
    projectPicker: $("project-picker"),
    loadProject: $("load-project"),
    sourceVideoPath: $("source-video-path"),
    sourceDownloadUrl: $("source-download-url"),
    downloadSourceUrl: $("download-source-url"),
    sourceDownloadProgress: $("source-download-progress"),
    sourceDownloadStatus: $("source-download-status"),
    sourceDownloadPercent: $("source-download-percent"),
    sourceDownloadProgressBar: $("source-download-progress-bar"),
    sourceDownloadDetail: $("source-download-detail"),
    sourceActiveBadge: $("source-active-badge"),
    sourceSelectionSummary: $("source-selection-summary"),
    sourceSelectionLabel: $("source-selection-label"),
    sourceSelectionDetail: $("source-selection-detail"),
    mirrorPickVideo: $("mirror-pick-video"),
    mirrorVideoPath: $("mirror-video-path"),
    mirrorInterval: $("mirror-interval"),
    mirrorRun: $("mirror-run"),
    mirrorMeta: $("mirror-meta"),
    mirrorPreview: $("mirror-preview"),
    mirrorResult: $("mirror-result"),
    subtitlePath: $("subtitle-path"),
    storyScriptPath: $("story-script-path"),
    storyJsonLabel: $("story-json-label"),
    storyJsonHint: $("story-json-hint"),
    browseStoryScript: $("browse-story-script"),
    highlightPromptTemplate: $("highlight-prompt-template"),
    copyHighlightPromptTemplate: $("copy-highlight-prompt-template"),
    createManualGeminiPack: $("create-manual-gemini-pack"),
    createAndRunStage1Ai: $("create-and-run-stage1-ai"),
    configuredAiAutoLevel: $("configured-ai-auto-level"),
    configuredAiAutoStatus: $("configured-ai-auto-status"),
    vertexAutoPipeline: $("vertex-auto-pipeline"),
    manualWorkflowAdvanced: $("manual-workflow-advanced"),
    openManualGeminiPack: $("open-manual-gemini-pack"),
    manualGeminiPackStatus: $("manual-gemini-pack-status"),
    manualGeminiPackPath: $("manual-gemini-pack-path"),
    manualGeminiForceRebuild: $("manual-gemini-force-rebuild"),
    runManualAntigravityStage1: $("run-manual-antigravity-stage1"),
    cancelManualAntigravityStage1: $("cancel-manual-antigravity-stage1"),
    openManualAntigravityResult: $("open-manual-antigravity-result"),
    manualAntigravityStage1Status: $("manual-antigravity-stage1-status"),
    aiAnalysisTerminal: $("ai-analysis-terminal"),
    aiTerminalPercentage: $("ai-terminal-percentage"),
    aiTerminalProgressBar: $("ai-terminal-progress-bar"),
    aiTerminalLog: $("ai-terminal-log"),
    stage1AiProviderBadge: $("stage1-ai-provider-badge"),
    stage1AiActionTitle: $("stage1-ai-action-title"),
    stage1AiActionDescription: $("stage1-ai-action-description"),
    stage1AiModelBadge: $("stage1-ai-model-badge"),
    storyRecutRightsConfirmed: $("story-recut-rights-confirmed"),
    diyStoryAngle: $("diy-story-angle"),
    podcastYoutubeUrl: $("podcast-youtube-url"),
    podcastWorkflowMode: $("podcast-workflow-mode"),
    podcastOutputCount: $("podcast-output-count"),
    podcastCleanupMode: $("podcast-cleanup-mode"),
    podcastTargetMin: $("podcast-target-min"),
    podcastTargetMax: $("podcast-target-max"),
    manualEvidenceStageTitle: $("manual-evidence-stage-title"),
    manualEvidenceStageDescription: $("manual-evidence-stage-description"),
    manualGeminiEvidenceStage: $("manual-gemini-evidence-stage"),
    manualBlueprintStageTitle: $("manual-blueprint-stage-title"),
    manualBlueprintStageDescription: $("manual-blueprint-stage-description"),
    manualVariantStageTitle: $("manual-variant-stage-title"),
    manualVariantStageDescription: $("manual-variant-stage-description"),
    manualVariantStageBadge: $("manual-variant-stage-badge"),
    importManualGeminiEvidence: $("import-manual-gemini-evidence"),
    openManualGeminiEvidenceFolder: $("open-manual-gemini-evidence-folder"),
    manualGeminiEvidenceStatus: $("manual-gemini-evidence-status"),
    manualGeminiEvidencePath: $("manual-gemini-evidence-path"),
    importManualGeminiBlueprint: $("import-manual-gemini-blueprint"),
    openManualGeminiBlueprintFolder: $("open-manual-gemini-blueprint-folder"),
    manualGeminiBlueprintStatus: $("manual-gemini-blueprint-status"),
    manualGeminiBlueprintPath: $("manual-gemini-blueprint-path"),
    openManualGeminiVariants: $("open-manual-gemini-variants"),
    manualGeminiVariantStatus: $("manual-gemini-variant-status"),
    manualPackStageTitle: $("manual-pack-stage-title"),
    manualPackStageDescription: $("manual-pack-stage-description"),
    targetDuration: $("target-duration"),
    voiceSpeed: $("voice-speed"),
    viralOptimization: $("viral-optimization"),
    viralPlatform: $("viral-platform"),
    viralAngleSetting: $("viral-angle-setting"),
    retentionAggressiveness: $("retention-aggressiveness"),
    spoilerControl: $("spoiler-control"),
    loopEnding: $("loop-ending"),
    browseVideo: $("browse-video"),
    browseSubtitle: $("browse-subtitle"),
    clearSubtitle: $("clear-subtitle"),
    trimStart: $("trim-start"),
    trimEnd: $("trim-end"),
    visualRemix: $("visual-remix"),
    framePreset: $("frame-preset"),
    voiceGenderAge: $("voice-gender-age"),
    voicePitch: $("voice-pitch"),
    voiceAccent: $("voice-accent"),
    voiceTrait: $("voice-trait"),
    voicePrompt: $("voice-prompt"),
    voiceSamplePath: $("voice-sample-path"),
    browseVoiceSample: $("browse-voice-sample"),
    previewVoiceSample: $("preview-voice-sample"),
    useClonedVoice: $("use-cloned-voice"),
    cloneVoiceStatus: $("clone-voice-status"),
    presetVoiceProvider: $("preset-voice-provider"),
    presetVoiceList: $("preset-voice-list"),
    refreshPresetVoices: $("refresh-preset-voices"),
    previewPresetVoice: $("preview-preset-voice"),
    usePresetVoice: $("use-preset-voice"),
    presetVoiceInfo: $("preset-voice-info"),
    heroVoiceName: $("hero-voice-name"),
    heroVoiceProviderBadge: $("hero-voice-provider-badge"),
    heroVoiceDetail: $("hero-voice-detail"),
    heroPreviewVoiceBtn: $("hero-preview-voice-btn"),
    sourceDropzone: $("source-dropzone"),
    changeSourceVideoBtn: $("change-source-video-btn"),
    draftVoiceMode: $("draft-voice-mode"),
    draftVoiceProvider: $("draft-voice-provider"),
    draftVoiceList: $("draft-voice-list"),
    refreshDraftVoices: $("refresh-draft-voices"),
    previewDraftVoice: $("preview-draft-voice"),
    draftVoiceId: $("draft-voice-id"),
    draftVoiceInfo: $("draft-voice-info"),
    useCurrentVoiceForDraft: $("use-current-voice-for-draft"),
    calibrateVoiceSpeed: $("calibrate-voice-speed"),
    calibrateDraftVoiceSpeed: $("calibrate-draft-voice-speed"),
    copyVoiceBudgetPrompt: $("copy-voice-budget-prompt"),
    copyDraftVoiceBudgetPrompt: $("copy-draft-voice-budget-prompt"),
    voiceCalibrationStatus: $("voice-calibration-status"),
    draftVoiceCalibrationStatus: $("draft-voice-calibration-status"),
    autoWhisper: $("auto-whisper"),
    sourceLanguage: $("source-language"),
    targetLanguage: $("target-language"),
    reviewProject: $("review-project"),
    reviewVideo: $("review-video"),
    reviewSrt: $("review-srt"),
    reviewFrame: $("review-frame"),
    reviewMode: $("review-mode"),
    reviewWhisper: $("review-whisper"),
    reviewTarget: $("review-target"),
    reviewAiProvider: $("review-ai-provider"),
    reviewDuration: $("review-duration"),
    reviewVoiceSpeed: $("review-voice-speed"),
    recapTargetDuration: $("target-duration"),
    recapWorkflowMode: $("recap-workflow-mode"),
    recapVisualLead: $("recap-visual-lead"),
    recapAllowReuse: $("recap-allow-reuse"),
    manualPromptCustomization: $("manual-prompt-customization"),
    manualPromptProfile: $("manual-prompt-profile"),
    manualSeriesNarratorStyleLabel: $("manual-series-narrator-style-label"),
    manualIndependentOptions: $("manual-independent-options"),
    manualIndependentScriptCount: $("manual-independent-script-count"),
    manualIndependentHookPriority: $("manual-independent-hook-priority"),
    manualIndependentHookMax: $("manual-independent-hook-max"),
    manualIndependentNarratorTone: $("manual-independent-narrator-tone"),
    manualIndependentAudioBalance: $("manual-independent-audio-balance"),
    manualIndependentPacing: $("manual-independent-pacing"),
    manualIndependentEnding: $("manual-independent-ending"),
    manualIndependentScript1Min: $("manual-independent-script1-min"),
    manualIndependentScript1Max: $("manual-independent-script1-max"),
    manualIndependentScript2Min: $("manual-independent-script2-min"),
    manualIndependentScript2Max: $("manual-independent-script2-max"),
    manualIndependentScript3Min: $("manual-independent-script3-min"),
    manualIndependentScript3Max: $("manual-independent-script3-max"),
    manualIndependentScript4Min: $("manual-independent-script4-min"),
    manualIndependentScript4Max: $("manual-independent-script4-max"),
    manualIndependentScript5Min: $("manual-independent-script5-min"),
    manualIndependentScript5Max: $("manual-independent-script5-max"),
    manualIndependentOverlays: $("manual-independent-overlays"),
    manualIndependentPowerWords: $("manual-independent-power-words"),
    autoStoryTargetMin: $("auto-story-target-min"),
    autoStoryTargetMax: $("auto-story-target-max"),
    autoStoryOutputCount: $("auto-story-output-count"),
    autoStoryNarrationStyle: $("auto-story-narration-style"),
    autoStoryAudioBalance: $("auto-story-audio-balance"),
    autoStoryEngineVersion: $("auto-story-engine-version"),
    autoStoryEngineHint: $("auto-story-engine-hint"),
    manualSerializedOptions: $("manual-serialized-options"),
    manualSeriesSharedHook: $("manual-series-shared-hook"),
    manualSeriesInterleavedAudio: $("manual-series-interleaved-audio"),
    manualSeriesNarratorStyle: $("manual-series-narrator-style"),
    manualSeriesCliffhanger: $("manual-series-cliffhanger"),
    manualSeriesOverlays: $("manual-series-overlays"),
    manualSeriesDurationMin: $("manual-series-duration-min"),
    manualSeriesDurationMax: $("manual-series-duration-max"),
    manualSeriesPacing: $("manual-series-pacing"),
    manualSeriesPowerWords: $("manual-series-power-words"),
    manualPromptOptionSummary: $("manual-prompt-option-summary"),
    reviewPromptProfile: $("review-prompt-profile"),
    reviewAutoStory: $("review-auto-story"),
    prevStep: $("prev-step"),
    nextStep: $("next-step"),
    startIngest: $("start-ingest"),
    systemLog: $("system-log"),
    activityFeed: $("activity-feed"),
    toggleRawLog: $("toggle-raw-log"),
    copyLog: $("copy-log"),
    exportProgress: $("export-progress"),
    exportProgressLabel: $("export-progress-label"),
    exportProgressValue: $("export-progress-value"),
    exportProgressBar: $("export-progress-bar"),
    variantExportStatuses: $("variant-export-statuses"),
    confirmActionModal: $("confirm-action-modal"),
    confirmActionTitle: $("confirm-action-title"),
    confirmActionMessage: $("confirm-action-message"),
    cancelConfirmAction: $("cancel-confirm-action"),
    submitConfirmAction: $("submit-confirm-action"),
    backSetupModal: $("back-setup-modal"),
    cancelBackSetup: $("cancel-back-setup"),
    confirmBackSetup: $("confirm-back-setup"),
    selectAllSetupSteps: $("select-all-setup-steps"),
    clearAllSetupSteps: $("clear-all-setup-steps"),
    openSettings: $("open-settings"),
    closeSettings: $("close-settings"),
    saveSettings: $("save-settings"),
    checkSettings: $("check-settings"),
    settingsCheckResult: $("settings-check-result"),
    settingsModal: $("settings-modal"),
    workspaceRoot: $("workspace-root"),
    exportRoot: $("export-root"),
    geminiAnalysisRoot: $("gemini-analysis-root"),
    exportLayout: $("export-layout"),
    pickExportRoot: $("pick-export-root"),
    pickGeminiAnalysisRoot: $("pick-gemini-analysis-root"),
    geminiApiKey: $("gemini-api-key"),
    geminiModel: $("gemini-model"),
    vertexProjectId: $("vertex-project-id"),
    vertexLocation: $("vertex-location"),
    vertexCredentialPath: $("vertex-credential-path"),
    pickVertexCredential: $("pick-vertex-credential"),
    vertexGcloudCommand: $("vertex-gcloud-command"),
    vertexBucket: $("vertex-bucket"),
    vertexEconomyModel: $("vertex-economy-model"),
    vertexAnalysisModel: $("vertex-analysis-model"),
    vertexQualityModel: $("vertex-quality-model"),
    vertexBudgetUsd: $("vertex-budget-usd"),
    vertexDailyLimitUsd: $("vertex-daily-limit-usd"),
    vertexTimeoutMs: $("vertex-timeout-ms"),
    testVertex: $("test-vertex"),
    vertexStatus: $("vertex-status"),
    antigravityCommand: $("antigravity-command"),
    antigravityArgs: $("antigravity-args"),
    antigravityModel: $("antigravity-model"),
    antigravityTimeoutMs: $("antigravity-timeout-ms"),
    whisperEngine: $("whisper-engine"),
    whisperCommand: $("whisper-command"),
    whisperPythonCommand: $("whisper-python-command"),
    whisperModel: $("whisper-model"),
    whisperDevice: $("whisper-device"),
    whisperComputeType: $("whisper-compute-type"),
    whisperChunkSec: $("whisper-chunk-sec"),
    dubbingRenderMode: $("dubbing-render-mode"),
    dubbingMinClusterDuration: $("dubbing-min-cluster-duration"),
    dubbingMaxClusterDuration: $("dubbing-max-cluster-duration"),
    dubbingMaxSafeStretch: $("dubbing-max-safe-stretch"),
    dubbingAllowStrictTrim: $("dubbing-allow-strict-trim"),
    dubbingVoiceNormalize: $("dubbing-voice-normalize"),
    defaultVoiceProvider: $("default-voice-provider"),
    elevenLabsApiKey: $("elevenlabs-api-key"),
    elevenLabsModel: $("elevenlabs-model"),
    elevenLabsVoiceId: $("elevenlabs-voice-id"),
    elevenLabsSettingsMode: $("elevenlabs-settings-mode"),
    elevenLabsStability: $("elevenlabs-stability"),
    elevenLabsSimilarity: $("elevenlabs-similarity"),
    elevenLabsStyle: $("elevenlabs-style"),
    elevenLabsSpeakerBoost: $("elevenlabs-speaker-boost"),
    elevenLabsStabilityValue: $("elevenlabs-stability-value"),
    elevenLabsSimilarityValue: $("elevenlabs-similarity-value"),
    elevenLabsStyleValue: $("elevenlabs-style-value"),
    localVoiceTuningCard: $("local-voice-tuning-card"),
    localVoiceTuningTitle: $("local-voice-tuning-title"),
    edgeVoiceTuningControls: $("edge-voice-tuning-controls"),
    kokoroVoiceTuningControls: $("kokoro-voice-tuning-controls"),
    edgeVoicePreset: $("edge-voice-preset"),
    edgeVoiceRate: $("edge-voice-rate"),
    edgeVoicePitch: $("edge-voice-pitch"),
    edgeVoiceVolume: $("edge-voice-volume"),
    edgeVoiceRateValue: $("edge-voice-rate-value"),
    edgeVoicePitchValue: $("edge-voice-pitch-value"),
    edgeVoiceVolumeValue: $("edge-voice-volume-value"),
    kokoroPythonCommand: $("kokoro-python-command"),
    kokoroModel: $("kokoro-model"),
    kokoroDevice: $("kokoro-device"),
    kokoroVoicePreset: $("kokoro-voice-preset"),
    kokoroSpeed: $("kokoro-speed"),
    kokoroSpeedValue: $("kokoro-speed-value"),
    localPreviewTranslationEnabled: $("local-preview-translation-enabled"),
    localTranslationProvider: $("local-translation-provider"),
    localTranslationModel: $("local-translation-model"),
    localTranslationPythonCommand: $("local-translation-python-command"),
    localTranslationDevice: $("local-translation-device"),
    localTranslationModelRow: $("local-translation-model-row"),
    localTranslationPythonRow: $("local-translation-python-row"),
    localTranslationDeviceRow: $("local-translation-device-row"),
    hyMt2ModelRow: $("hy-mt2-model-row"),
    hyMt2Model: $("hy-mt2-model"),
    downloadHyMt2: $("download-hy-mt2"),
    ffmpegPath: $("ffmpeg-path"),
    ffprobePath: $("ffprobe-path"),
    backToSetup: $("back-to-setup"),
    renderVideo: $("render-video"),
    resumeRender: $("resume-render"),
    cancelRender: $("cancel-render"),
    renderHighlightVariants: $("render-highlight-variants"),
    openOutputFolder: $("open-output-folder"),
    segmentList: $("segment-list"),
    dialogueTab: $("dialogue-tab"),
    highlightVariantBar: $("highlight-variant-bar"),
    highlightRevisionBar: $("highlight-revision-bar"),
    segmentSummary: $("segment-summary"),
    translateButton: $("translate-button"),
    diarizeButton: $("diarize-button"),
    previewPlayer: $("preview-player"),
    previewBackgroundPlayer: $("preview-background-player"),
    videoTitleOverlay: $("video-title-overlay"),
    videoPartLabelOverlay: $("video-part-label-overlay"),
    foregroundLayoutEditor: $("foreground-layout-editor"),
    subtitleOverlay: document.querySelector(".subtitle-overlay"),
    sourceSubtitleMaskEditor: $("source-subtitle-mask-editor"),
    sourceSubtitleMaskSelection: $("source-subtitle-mask-selection"),
    previewControlPlay: $("preview-control-play"),
    previewTimecode: $("preview-timecode"),
    videoPlaceholder: $("video-placeholder"),
    tabBtnRightLog: $("tab-btn-right-log"),
    tabBtnRightInspector: $("tab-btn-right-inspector"),
    rightLogTab: $("right-log-tab"),
    rightInspectorTab: $("right-inspector-tab"),
    studioActivityFeed: $("studio-activity-feed"),
    studioSystemLog: $("studio-system-log"),
    tabStudioActivity: $("tab-studio-activity"),
    tabStudioRawLog: $("tab-studio-raw-log"),
    toggleStudioRawLog: $("toggle-studio-raw-log"),
    copyStudioLog: $("copy-studio-log"),
    studioVariantHub: $("studio-variant-hub"),
    variantHubSummary: $("variant-hub-summary"),
    variantHubCards: $("variant-hub-cards"),
    studioPipelineTracker: $("studio-pipeline-tracker"),
    trackerCurrentLabel: $("tracker-current-label"),
    trackerPercentLabel: $("tracker-percent-label"),
    inspectStart: $("inspect-start"),
    inspectEnd: $("inspect-end"),
    inspectDuration: $("inspect-duration"),
    inspectText: $("inspect-text"),
    inspectSpeaker: $("inspect-speaker"),
    inspectSpeed: $("inspect-speed"),
    inspectVolume: $("inspect-volume"),
    previewSegmentVoice: $("preview-segment-voice"),
    previewSegmentVideo: $("preview-segment-video"),
    audioPlan: $("audio-plan"),
    saveSegment: $("save-segment"),
    reviewSceneScript: $("review-scene-script"),
    reviewAllScenes: $("review-all-scenes"),
    reviewAllScenesLeft: $("review-all-scenes-left"),
    rewriteFailedScenes: $("rewrite-failed-scenes"),
    applyAllRewrites: $("apply-all-rewrites"),
    sceneReviewBox: $("scene-review-box"),
    applySceneRewrite: $("apply-scene-rewrite"),
    speakerList: $("speaker-list"),
    timelineCanvas: $("timeline-canvas"),
    timelineLabel: $("timeline-label"),
    kpiScenes: $("kpi-scenes"),
    kpiSegments: $("kpi-segments"),
    kpiDuration: $("kpi-duration"),
    warningBox: $("warning-box"),
    viralDiagnostics: $("viral-diagnostics"),
    viralDiagnosticsTitle: $("viral-diagnostics-title"),
    viralDiagnosticsGrade: $("viral-diagnostics-grade"),
    viralDiagnosticsMetrics: $("viral-diagnostics-metrics"),
    viralDiagnosticsIssues: $("viral-diagnostics-issues"),
    copyViralRepairPrompt: $("copy-viral-repair-prompt"),
    playPreview: $("play-preview"),
    previewDraft: $("preview-draft"),
    renderFastDraft: $("render-fast-draft"),
    renderAllFastDrafts: $("render-all-fast-drafts"),
    createGeminiDraftReview: $("create-gemini-draft-review"),
    openGeminiDraftReview: $("open-gemini-draft-review"),
    openDraftReviewPrompt: $("open-draft-review-prompt"),
    openDraftReviewReport: $("open-draft-review-report"),
    importReviewedScript: $("import-reviewed-script"),
    draftReviewActions: $("draft-review-actions"),
    draftReviewTitle: $("draft-review-title"),
    draftReviewStatus: $("draft-review-status"),
    draftReviewAiBadge: $("draft-review-ai-badge"),
    previewWorkflowStatus: $("preview-workflow-status"),
    runConfiguredDraftReview: $("run-configured-draft-review"),
    cancelConfiguredDraftReview: $("cancel-configured-draft-review"),
    openConfiguredDraftReviewResult: $("open-configured-draft-review-result"),
    importConfiguredDraftReview: $("import-configured-draft-review"),
    voiceVolume: $("voice-volume"),
    sourceVolume: $("source-volume"),
    bgmVolume: $("bgm-volume"),
    ducking: $("ducking"),
    voiceVolValue: $("voice-vol-value"),
    sourceVolValue: $("source-vol-value"),
    bgmVolValue: $("bgm-vol-value"),
    duckingValue: $("ducking-value"),
    mixerVisualRemix: $("mixer-visual-remix"),
    videoEditScope: $("video-edit-scope"),
    videoEditStaleWarning: $("video-edit-stale-warning"),
    videoCanvasEnabled: $("video-canvas-enabled"),
    videoCanvasAspect: $("video-canvas-aspect"),
    videoCanvasWidth: $("video-canvas-width"),
    videoCanvasHeight: $("video-canvas-height"),
    videoCanvasCustomSize: $("video-canvas-custom-size"),
    videoCanvasRatioLabel: $("video-canvas-ratio-label"),
    blurBackgroundEnabled: $("blur-background-enabled"),
    blurBackgroundStrength: $("blur-background-strength"),
    blurBackgroundStrengthValue: $("blur-background-strength-value"),
    topCaptionEnabled: $("top-caption-enabled"),
    topCaptionText: $("top-caption-text"),
    topCaptionStyle: $("top-caption-style"),
    topCaptionSource: $("top-caption-source"),
    topCaptionFontSize: $("top-caption-font-size"),
    topCaptionFontSizeValue: $("top-caption-font-size-value"),
    topCaptionY: $("top-caption-y"),
    topCaptionYValue: $("top-caption-y-value"),
    cameraLabelEnabled: $("camera-label-enabled"),
    cameraLabelText: $("camera-label-text"),
    partLabelEnabled: $("part-label-enabled"),
    partLabelAuto: $("part-label-auto"),
    partLabelText: $("part-label-text"),
    partLabelStyle: $("part-label-style"),
    partLabelAlignment: $("part-label-alignment"),
    partLabelUppercase: $("part-label-uppercase"),
    partLabelTextColor: $("part-label-text-color"),
    partLabelBackgroundColor: $("part-label-background-color"),
    partLabelFontSize: $("part-label-font-size"),
    partLabelFontSizeValue: $("part-label-font-size-value"),
    partLabelOpacity: $("part-label-opacity"),
    partLabelOpacityValue: $("part-label-opacity-value"),
    partLabelX: $("part-label-x"),
    partLabelXValue: $("part-label-x-value"),
    partLabelY: $("part-label-y"),
    partLabelYValue: $("part-label-y-value"),
    foregroundScale: $("foreground-scale"),
    foregroundScaleValue: $("foreground-scale-value"),
    foregroundX: $("foreground-x"),
    foregroundY: $("foreground-y"),
    resetForegroundLayout: $("reset-foreground-layout"),
    sourceSubtitleMaskEnabled: $("source-subtitle-mask-enabled"),
    sourceSubtitleMaskMode: $("source-subtitle-mask-mode"),
    sourceSubtitleMaskX: $("source-subtitle-mask-x"),
    sourceSubtitleMaskWidth: $("source-subtitle-mask-width"),
    sourceSubtitleMaskHeight: $("source-subtitle-mask-height"),
    sourceSubtitleMaskBottom: $("source-subtitle-mask-bottom"),
    sourceSubtitleMaskStrength: $("source-subtitle-mask-strength"),
    sourceSubtitleMaskHeightValue: $("source-subtitle-mask-height-value"),
    sourceSubtitleMaskBottomValue: $("source-subtitle-mask-bottom-value"),
    sourceSubtitleMaskStrengthValue: $("source-subtitle-mask-strength-value"),
    sourceSubtitleMaskGeometry: $("source-subtitle-mask-geometry"),
    editSourceSubtitleMask: $("edit-source-subtitle-mask"),
    resetSourceSubtitleMask: $("reset-source-subtitle-mask"),
    showSubtitles: $("show-subtitles"),
    omniVoiceRenderMode: $("omnivoice-render-mode"),
    storytimeContinuousVoice: $("storytime-continuous-voice"),
    autoFitVoice: $("auto-fit-voice"),
    draftReviewModal: $("draft-review-modal"),
    closeDraftReviewModal: $("close-draft-review-modal"),
    dismissDraftReviewModal: $("dismiss-draft-review-modal"),
    applyDraftReviewModalV2: $("apply-draft-review-modal-v2"),
    reviewModalVariantBadge: $("review-modal-variant-badge"),
    reviewModalScoreV1: $("review-modal-score-v1"),
    reviewModalScoreV2: $("review-modal-score-v2"),
    reviewModalScoreDelta: $("review-modal-score-delta"),
    reviewModalDecisionBadge: $("review-modal-decision-badge"),
    reviewModalIssuesBadge: $("review-modal-issues-badge"),
    reviewModalSummary: $("review-modal-summary"),
    reviewModalHookAnalysis: $("review-modal-hook-analysis"),
    reviewModalIdealAudit: $("review-modal-ideal-audit"),
    reviewModalIssuesStats: $("review-modal-issues-stats"),
    reviewModalIssuesList: $("review-modal-issues-list"),
    diffV1Duration: $("diff-v1-duration"),
    diffV2Duration: $("diff-v2-duration"),
    diffDurationDelta: $("diff-duration-delta"),
    diffSegmentCount: $("diff-segment-count"),
    reviewModalDiffList: $("review-modal-diff-list")
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fileName(filePath) {
  return String(filePath || "").split(/[/\\]/).pop() || "";
}

function hasVietnameseDiacritics(text = "") {
  return /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(String(text || ""));
}

function toFileUrl(filePath) {
  if (!filePath) {
    return "";
  }
  const normalized = String(filePath).replace(/\\/g, "/");
  const encoded = normalized
    .split("/")
    .map((part, index) => (index === 0 ? encodeURIComponent(part).replace(/%3A$/i, ":") : encodeURIComponent(part)))
    .join("/");
  return `file:///${encoded}`;
}

function toVideoFileUrl(filePath, cacheBust = "") {
  const url = toFileUrl(filePath);
  if (!url || !cacheBust) {
    return url;
  }
  return `${url}?v=${encodeURIComponent(cacheBust)}`;
}

function getPreviewCacheBust(project = state.currentProject) {
  const artifacts = project?.artifacts || {};
  const activeVariant = project?.mode === "highlight_cut" ? getActiveHighlightVariant(project) : null;
  const variantArtifacts = activeVariant?.artifacts || {};
  return variantArtifacts.fastDraftRenderedAt
    || artifacts.fastDraftRenderedAt
    || artifacts.previewRenderedAt
    || project?.updatedAt
    || "";
}

function getPreviewVideoPath(project = state.currentProject) {
  if (state.revisionPreviewPath) return state.revisionPreviewPath;
  const artifacts = project?.artifacts || {};
  const analysisArtifacts = project?.analysis?.artifacts || {};
  if (project?.mode === "highlight_cut" && getHighlightVariants(project).length) {
    const activeVariant = getActiveHighlightVariant(project);
    const variantArtifacts = activeVariant?.artifacts || {};
    if (state.videoEditPreviewMode) {
      const explicitBasePath = variantArtifacts.fastDraftBaseVideoPath;
      if (explicitBasePath) return explicitBasePath;
      const internalDraftPath = variantArtifacts.internalFastDraftVideoPath || "";
      if (internalDraftPath) {
        return String(internalDraftPath)
          .replace(/([\\/])output([\\/])([^\\/]+)\.mp4$/i, "$1temp$2$3-base.mp4");
      }
    }
    return variantArtifacts.fastDraftVideoPath
      || variantArtifacts.previewVideoPath
      || variantArtifacts.finalVideoPath
      || artifacts.proxyPath
      || artifacts.renderProxyPath
      || artifacts.sourceProxyPath
      || analysisArtifacts.proxyPath
      || analysisArtifacts.renderProxyPath
      || analysisArtifacts.sourceProxyPath
      || project?.proxyPath
      || project?.sourceVideoPath
      || "";
  }
  if (state.videoEditPreviewMode) {
    if (artifacts.fastDraftBaseVideoPath) return artifacts.fastDraftBaseVideoPath;
    if (artifacts.internalFastDraftVideoPath) {
      return String(artifacts.internalFastDraftVideoPath)
        .replace(/([\\/])output([\\/])([^\\/]+)\.mp4$/i, "$1temp$2$3-base.mp4");
    }
  }
  return artifacts.previewVideoPath
    || artifacts.finalVideoPath
    || artifacts.proxyPath
    || artifacts.renderProxyPath
    || artifacts.sourceProxyPath
    || analysisArtifacts.previewVideoPath
    || analysisArtifacts.finalVideoPath
    || analysisArtifacts.proxyPath
    || analysisArtifacts.renderProxyPath
    || analysisArtifacts.sourceProxyPath
    || project?.proxyPath
    || project?.sourceVideoPath
    || "";
}

function getPreviewSubtitleTextAtTime(project = state.currentProject, seconds = 0) {
  if (!project || !["satisfying_storytime", "highlight_cut"].includes(project.mode)) {
    return "";
  }
  const activeVariant = project.mode === "highlight_cut" ? getActiveHighlightVariant(project) : null;
  const hasHighlightDraft = Boolean(activeVariant?.artifacts?.fastDraftVideoPath || project.artifacts?.fastDraftVideoPath);
  const subtitlesEmbedded = Boolean(activeVariant?.artifacts?.fastDraftSubtitlesEmbedded ?? project.artifacts?.fastDraftSubtitlesEmbedded);
  if (state.revisionPreviewPath) return "";
  if (subtitlesEmbedded) return "";
  const hasFastDraft = project.mode === "highlight_cut"
    ? hasHighlightDraft
    : Boolean(project.artifacts?.fastDraftVideoPath || project.analysis?.artifacts?.fastDraftVideoPath);
  if (!hasFastDraft) {
    return "";
  }
  const hasResolvedDraft = Boolean(project.artifacts?.fastDraftResolvedTimelinePath || hasHighlightDraft);
  const sourceSegments = activeVariant?.segments?.length
    ? activeVariant.segments
    : Array.isArray(project.analysis?.segments) ? project.analysis.segments : [];
  const currentTime = Number(seconds || 0);
  let cursor = 0;
  const segments = sourceSegments.map((item) => {
    if (hasResolvedDraft && Number.isFinite(Number(item.resolvedPreviewStartSec)) && Number.isFinite(Number(item.resolvedPreviewEndSec))) {
      return {
        ...item,
        previewStartSec: Number(item.resolvedPreviewStartSec),
        previewEndSec: Number(item.resolvedPreviewEndSec)
      };
    }
    if (project.mode === "highlight_cut" && hasHighlightDraft) {
      const sourceStart = Number(item.sourceStartSec ?? item.startSec ?? 0);
      const sourceEnd = Number(item.sourceEndSec ?? sourceStart + Number(item.duration || item.durationSec || 1));
      const duration = Math.max(0.2, sourceEnd - sourceStart);
      const timelineItem = { ...item, previewStartSec: cursor, previewEndSec: cursor + duration };
      cursor += duration;
      return timelineItem;
    }
    const start = Number(item.startSec || 0);
    const end = Number(item.endSec || start + item.durationSec || item.duration || start + 1);
    return { ...item, previewStartSec: start, previewEndSec: end };
  });
  const segment = segments.find((item) => {
    const start = Number(item.previewStartSec || 0);
    const end = Number(item.previewEndSec || start + item.durationSec || item.duration || start + 1);
    return currentTime >= start && currentTime < end;
  });
  if (!segment) {
    return "";
  }
  const previewSubtitleCues = Array.isArray(segment.previewSubtitleCues)
    ? segment.previewSubtitleCues
    : [];
  const activeCue = previewSubtitleCues.length
    ? previewSubtitleCues.find((cue) => (
      currentTime >= Number(cue.startSec || 0) && currentTime < Number(cue.endSec || 0)
    ))
    : null;
  if (previewSubtitleCues.length) {
    return activeCue
      ? String(activeCue.previewSubtitleVi || activeCue.translatedText || "").trim()
      : "";
  }
  if (project.mode === "highlight_cut") {
    return "";
  }
  const candidates = [
    segment.previewSubtitleVi,
  ].map((value) => String(value || "").trim()).filter(Boolean);
  const fullText = candidates.find(hasVietnameseDiacritics) || "";
  return getVoiceSyncedPreviewSubtitleLine(segment, fullText, currentTime);
}

function isDecoratedPreviewVideo(project = state.currentProject, previewPath = getPreviewVideoPath(project)) {
  if (!project || !previewPath) return false;
  if (state.revisionPreviewPath) return true;
  const artifacts = project.artifacts || {};
  const activeVariant = project.mode === "highlight_cut" ? getActiveHighlightVariant(project) : null;
  const variantArtifacts = activeVariant?.artifacts || {};
  return [
    variantArtifacts.fastDraftVideoPath,
    variantArtifacts.previewVideoPath,
    variantArtifacts.internalFastDraftVideoPath,
    variantArtifacts.finalVideoPath,
    artifacts.fastDraftVideoPath,
    artifacts.previewVideoPath,
    artifacts.internalFastDraftVideoPath,
    artifacts.finalVideoPath
  ].filter(Boolean).some((candidate) => String(candidate) === String(previewPath));
}

function splitPreviewSubtitleChunks(text = "", maxWords = 7) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return [];
  const chunks = [];
  for (let index = 0; index < words.length; index += maxWords) {
    chunks.push(words.slice(index, index + maxWords).join(" "));
  }
  return chunks;
}

function getVoiceSyncedPreviewSubtitleLine(segment = {}, fullText = "", currentTime = 0) {
  const chunks = splitPreviewSubtitleChunks(fullText, 7);
  if (!chunks.length) return "";
  const startSec = Number(segment.previewStartSec ?? segment.startSec ?? 0);
  const endSec = Number(segment.previewEndSec ?? segment.endSec ?? startSec + Number(segment.duration || segment.durationSec || 1));
  const timelineSec = Math.max(0.2, endSec - startSec);
  const voiceSec = Math.max(0.2, Math.min(timelineSec, Number(segment.fastDraftVoiceSec || timelineSec)));
  const relativeSec = Math.max(0, Number(currentTime || 0) - startSec);
  if (relativeSec > voiceSec + 0.25) return "";
  const chunkIndex = Math.min(chunks.length - 1, Math.floor((relativeSec / voiceSec) * chunks.length));
  return chunks[Math.max(0, chunkIndex)];
}

function getPreviewTimelineSegments(project = state.currentProject) {
  if (!project || !["satisfying_storytime", "highlight_cut"].includes(project.mode)) return [];
  const activeVariant = project.mode === "highlight_cut" ? getActiveHighlightVariant(project) : null;
  const hasHighlightDraft = Boolean(activeVariant?.artifacts?.fastDraftVideoPath || project.artifacts?.fastDraftVideoPath);
  const sourceSegments = activeVariant?.segments?.length
    ? activeVariant.segments
    : Array.isArray(project.analysis?.segments) ? project.analysis.segments : [];
  let cursor = 0;
  return sourceSegments.map((segment, index) => {
    if (Number.isFinite(Number(segment.resolvedPreviewStartSec)) && Number.isFinite(Number(segment.resolvedPreviewEndSec))) {
      const startSec = Number(segment.resolvedPreviewStartSec);
      const endSec = Math.max(startSec + 0.2, Number(segment.resolvedPreviewEndSec));
      return { segment, index, startSec, endSec, durationSec: endSec - startSec };
    }
    if (project.mode === "highlight_cut" && hasHighlightDraft) {
      const sourceStart = Number(segment.sourceStartSec ?? segment.startSec ?? 0);
      const sourceEnd = Number(segment.sourceEndSec ?? sourceStart + Number(segment.sourceDuration || segment.duration || segment.durationSec || 1));
      const duration = Math.max(0.2, Number(segment.duration ?? (((segment.endSec || 0) - (segment.startSec || 0)) || (sourceEnd - sourceStart))));
      const item = { segment, index, startSec: cursor, endSec: cursor + duration, durationSec: duration };
      cursor += duration;
      return item;
    }
    const start = Number(segment.startSec || getSegmentTimelineStart(segment, index, sourceSegments));
    const end = Number(segment.endSec || start + getSegmentTimelineDuration(segment));
    return { segment, index, startSec: start, endSec: end, durationSec: Math.max(0.2, end - start) };
  });
}

function getPreviewTimelineEntry(index, project = state.currentProject) {
  return getPreviewTimelineSegments(project).find((item) => Number(item.index) === Number(index)) || null;
}

function updatePreviewSubtitleOverlay() {
  if (!el.subtitleOverlay || !el.previewPlayer) {
    return;
  }
  const text = getPreviewSubtitleTextAtTime(state.currentProject, el.previewPlayer.currentTime || 0);
  el.subtitleOverlay.textContent = text;
  el.subtitleOverlay.classList.toggle("hidden", !text);
  positionPreviewSubtitleOverlay();
}

function positionPreviewSubtitleOverlay() {
  if (!el.subtitleOverlay || !el.previewPlayer) return;
  const frame = el.previewPlayer.closest(".video-frame");
  const frameWidth = Number(frame?.clientWidth || 0);
  const frameHeight = Number(frame?.clientHeight || 0);
  const videoWidth = Number(el.previewPlayer.videoWidth || 0);
  const videoHeight = Number(el.previewPlayer.videoHeight || 0);
  if (!frameWidth || !frameHeight || !videoWidth || !videoHeight) return;
  const frameRatio = frameWidth / frameHeight;
  const videoRatio = videoWidth / videoHeight;
  const displayedHeight = videoRatio > frameRatio ? frameWidth / videoRatio : frameHeight;
  const bottomLetterbox = Math.max(0, (frameHeight - displayedHeight) / 2);
  const controlsReserve = 10;
  const hasBottomBand = bottomLetterbox >= 38;
  const bottom = hasBottomBand
    ? Math.max(controlsReserve + 4, Math.min(bottomLetterbox - 8, controlsReserve + (bottomLetterbox - controlsReserve) * 0.48))
    : controlsReserve + 8;
  el.subtitleOverlay.style.bottom = `${Math.round(bottom)}px`;
  el.subtitleOverlay.classList.toggle("in-letterbox", hasBottomBand);
}

function getFinalOutputPath(project = state.currentProject) {
  return project?.artifacts?.finalVideoPath
    || project?.analysis?.artifacts?.finalVideoPath
    || "";
}

function getDraftReviewArtifacts(project = state.currentProject) {
  const analysisArtifacts = project?.analysis?.artifacts || {};
  const projectArtifacts = project?.artifacts || {};
  const activeVariant = project?.mode === "highlight_cut" ? getActiveHighlightVariant(project) : null;
  const variantArtifacts = activeVariant?.artifacts || {};
  return {
    videoPath: variantArtifacts.fastDraftVideoPath || projectArtifacts.fastDraftVideoPath || analysisArtifacts.fastDraftVideoPath || "",
    reportPath: variantArtifacts.fastDraftVoiceWarningReportPath
      || projectArtifacts.fastDraftVoiceWarningReportPath
      || analysisArtifacts.fastDraftVoiceWarningReportPath
      || "",
    promptPath: variantArtifacts.fastDraftGeminiRewritePromptPath
      || projectArtifacts.fastDraftGeminiRewritePromptPath
      || analysisArtifacts.fastDraftGeminiRewritePromptPath
      || "",
    reviewPackagePath: variantArtifacts.draftReviewPackagePath
      || projectArtifacts.draftReviewPackagePath
      || analysisArtifacts.draftReviewPackagePath
      || "",
    aiResultPath: variantArtifacts.draftReviewAiResultPath || "",
    aiResultDir: variantArtifacts.draftReviewAiResultDir || "",
    aiProvider: variantArtifacts.draftReviewAiProvider || "",
    aiModel: variantArtifacts.draftReviewAiModel || "",
    aiCompletedAt: variantArtifacts.draftReviewAiCompletedAt || "",
    reviewRevision: Number(variantArtifacts.draftReviewRevision || 0),
    reviewBindingId: variantArtifacts.draftReviewBindingId || ""
  };
}

function renderPreviewWorkflowStatus(project = state.currentProject) {
  if (!el.previewWorkflowStatus) return;
  const isReviewWorkflow = project?.mode === "highlight_cut"
    && project?.analysisWorkflow === "manual_gemini_draft_review";
  el.previewWorkflowStatus.classList.toggle("hidden", !isReviewWorkflow);
  if (!isReviewWorkflow) return;
  const artifacts = getDraftReviewArtifacts(project);
  const variants = getHighlightVariants(project);
  const completedBatchIds = new Set(
    (Array.isArray(project?.analysis?.variantDraftBatch?.items) ? project.analysis.variantDraftBatch.items : [])
      .filter((item) => item?.status === "done" || item?.status === "completed" || item?.outputPath)
      .map((item) => String(item?.id || item?.variantId || ""))
      .filter(Boolean)
  );
  const completedDrafts = variants.filter((variant) => (
    Boolean(variant?.artifacts?.fastDraftVideoPath) || completedBatchIds.has(String(variant?.id || ""))
  )).length;
  const activeVariant = getActiveHighlightVariant(project) || {};
  const revision = Math.max(1, Number(activeVariant.revisionNumber || 1));
  const steps = [
    { label: "Draft hiện tại", done: Boolean(artifacts.videoPath) },
    { label: `Draft tất cả ${completedDrafts}/${variants.length}`, done: variants.length > 0 && completedDrafts === variants.length },
    { label: "Gói review", done: Boolean(artifacts.reviewPackagePath) },
    { label: "AI review", done: Boolean(artifacts.aiResultPath) },
    { label: `Revision V${revision}`, done: revision > 1 },
    { label: "Đã xuất video", done: Boolean(getFinalOutputPath(project)) }
  ];
  el.previewWorkflowStatus.innerHTML = steps.map((step) => (
    `<span class="workflow-status-chip ${step.done ? "done" : "pending"}">`
      + `<b>${step.done ? "✓" : "○"}</b>${escapeHtml(step.label)}</span>`
  )).join("");
  if (el.renderFastDraft) el.renderFastDraft.classList.toggle("action-complete", Boolean(artifacts.videoPath));
  if (el.renderAllFastDrafts) {
    el.renderAllFastDrafts.classList.toggle("action-complete", variants.length > 0 && completedDrafts === variants.length);
  }
  if (el.createGeminiDraftReview) el.createGeminiDraftReview.classList.toggle("action-complete", Boolean(artifacts.reviewPackagePath));
  if (el.runConfiguredDraftReview) el.runConfiguredDraftReview.classList.toggle("action-complete", Boolean(artifacts.aiResultPath));
}

function getCurrentSourceSubtitleMask() {
  return {
    enabled: Boolean(el.sourceSubtitleMaskEnabled?.checked),
    coordinateSpace: "source_v2",
    mode: el.sourceSubtitleMaskMode?.value || "blur",
    xPercent: Number(el.sourceSubtitleMaskX?.value || 0),
    widthPercent: Number(el.sourceSubtitleMaskWidth?.value || 100),
    heightPercent: Number(el.sourceSubtitleMaskHeight?.value || 16),
    bottomPercent: Number(el.sourceSubtitleMaskBottom?.value || 6),
    strength: Number(el.sourceSubtitleMaskStrength?.value || 18)
  };
}

function persistSubtitleMaskSettingsSoon(delay = 120) {
  clearTimeout(subtitleMaskSaveTimer);
  subtitleMaskSaveTimer = setTimeout(() => persistVideoEditSettingsSoon(0), Math.max(0, delay));
}

function getActiveVariantOverrides(project = state.currentProject) {
  if (!project || project.mode !== "highlight_cut") return {};
  return getActiveHighlightVariant(project)?.videoEditOverrides || {};
}

function getEffectiveVideoEditProject(project = state.currentProject, scope = state.videoEditScope) {
  if (!project || scope !== "variant" || project.mode !== "highlight_cut") return project;
  const overrides = getActiveVariantOverrides(project);
  const globalDecoration = project.videoDecoration || {};
  return {
    ...project,
    mixer: { ...(project.mixer || {}), ...(overrides.mixer || {}) },
    videoDecoration: {
      ...globalDecoration,
      ...(overrides.videoDecoration || {}),
      topCaptionEnabled: globalDecoration.topCaptionEnabled,
      topCaptionText: globalDecoration.topCaptionText,
      topCaptionAutoFromScript: globalDecoration.topCaptionAutoFromScript,
      topCaptionFontSize: globalDecoration.topCaptionFontSize,
      topCaptionYPercent: globalDecoration.topCaptionYPercent
    },
    sourceSubtitleMask: { ...(project.sourceSubtitleMask || {}), ...(overrides.sourceSubtitleMask || {}) },
    subtitleStyle: overrides.subtitleStyle ?? project.subtitleStyle,
    showSubtitles: overrides.showSubtitles ?? project.showSubtitles,
    transitionStyle: overrides.transitionStyle ?? project.transitionStyle,
    visualRemixEnabled: overrides.visualRemixEnabled ?? project.visualRemixEnabled,
    autoFitVoice: overrides.autoFitVoice ?? project.autoFitVoice
  };
}

function getVariantScopedVideoEditSettings(settings) {
  const decoration = settings.videoDecoration || {};
  return {
    mixer: settings.mixer,
    videoDecoration: {
      canvasEnabled: decoration.canvasEnabled,
      canvasAspect: decoration.canvasAspect,
      customWidth: decoration.customWidth,
      customHeight: decoration.customHeight,
      blurBackgroundEnabled: decoration.blurBackgroundEnabled,
      blurStrength: decoration.blurStrength,
      foregroundScalePercent: decoration.foregroundScalePercent,
      foregroundXPercent: decoration.foregroundXPercent,
      foregroundYPercent: decoration.foregroundYPercent,
      partLabelEnabled: decoration.partLabelEnabled,
      partLabelAutoFromPart: decoration.partLabelAutoFromPart,
      partLabelText: decoration.partLabelText,
      partLabelStyle: decoration.partLabelStyle,
      partLabelAlignment: decoration.partLabelAlignment,
      partLabelUppercase: decoration.partLabelUppercase,
      partLabelTextColor: decoration.partLabelTextColor,
      partLabelBackgroundColor: decoration.partLabelBackgroundColor,
      partLabelBackgroundOpacity: decoration.partLabelBackgroundOpacity,
      partLabelFontSize: decoration.partLabelFontSize,
      partLabelXPercent: decoration.partLabelXPercent,
      partLabelYPercent: decoration.partLabelYPercent
    },
    sourceSubtitleMask: settings.sourceSubtitleMask,
    subtitleStyle: settings.subtitleStyle,
    showSubtitles: settings.showSubtitles,
    transitionStyle: settings.transitionStyle,
    visualRemixEnabled: settings.visualRemixEnabled,
    autoFitVoice: settings.autoFitVoice
  };
}

function getGlobalVideoEditSettings(project = {}) {
  return {
    mixer: project.mixer || {},
    subtitleStyle: project.subtitleStyle,
    showSubtitles: project.showSubtitles,
    omniVoiceRenderMode: project.omniVoiceRenderMode,
    storytimeContinuousVoice: project.storytimeContinuousVoice,
    videoDecoration: project.videoDecoration || {},
    sourceSubtitleMask: project.sourceSubtitleMask || {},
    transitionStyle: project.transitionStyle,
    autoFitVoice: project.autoFitVoice,
    visualRemixEnabled: project.visualRemixEnabled,
    draftVoiceMode: project.draftVoiceMode,
    draftVoiceProvider: project.draftVoiceProvider,
    draftVoiceId: project.draftVoiceId
  };
}

function sameVideoEditSettings(left, right) {
  return JSON.stringify(left || {}) === JSON.stringify(right || {});
}

async function persistCurrentVideoEditSettings() {
  const project = state.currentProject;
  if (!project?.id) return;
  const settings = getCurrentProjectSettings();
  const changedAt = new Date().toISOString();
  let updated;
  if (state.videoEditScope === "variant" && project.mode === "highlight_cut") {
    const activeId = project.analysis?.activeVariantId;
    const scopedSettings = getVariantScopedVideoEditSettings(settings);
    const currentVariant = (project.analysis?.highlightVariants || []).find((variant) => variant.id === activeId);
    const variantChanged = !sameVideoEditSettings(currentVariant?.videoEditOverrides || {}, scopedSettings);
    const variants = (project.analysis?.highlightVariants || []).map((variant) => variant.id === activeId ? {
      ...variant,
      videoEditOverrides: scopedSettings,
      videoEditUpdatedAt: variantChanged ? changedAt : variant.videoEditUpdatedAt
    } : variant);
    const currentDecoration = project.videoDecoration || {};
    const nextDecoration = settings.videoDecoration || {};
    const globalTitlePatch = {
      topCaptionEnabled: nextDecoration.topCaptionEnabled,
      topCaptionText: nextDecoration.topCaptionText,
      topCaptionAutoFromScript: nextDecoration.topCaptionAutoFromScript,
      topCaptionFontSize: nextDecoration.topCaptionFontSize,
      topCaptionYPercent: nextDecoration.topCaptionYPercent
    };
    const globalTitleChanged = Object.entries(globalTitlePatch)
      .some(([key, value]) => currentDecoration[key] !== value);
    if (!variantChanged && !globalTitleChanged) return project;
    updated = await window.cineviral.updateProjectSettings(project.id, {
      analysis: { ...(project.analysis || {}), highlightVariants: variants },
      videoDecoration: { ...currentDecoration, ...globalTitlePatch },
      ...(globalTitleChanged ? { videoEditUpdatedAt: changedAt } : {})
    });
  } else {
    if (sameVideoEditSettings(getGlobalVideoEditSettings(project), settings)) return project;
    updated = await window.cineviral.updateProjectSettings(project.id, {
      ...settings,
      videoEditUpdatedAt: changedAt
    });
  }
  if (state.currentProject?.id === project.id) state.currentProject = updated;
  updateVideoEditStaleStatus(updated);
}

function persistVideoEditSettingsSoon(delay = 220) {
  clearTimeout(videoEditSaveTimer);
  if (!state.currentProject?.id) return;
  videoEditSaveTimer = setTimeout(() => {
    persistCurrentVideoEditSettings().catch((error) => {
      addLog(`Không lưu được chỉnh sửa video: ${error.message}`, "WARNING");
    });
  }, Math.max(0, delay));
}

function updateVideoEditStaleStatus(project = state.currentProject) {
  if (!el.videoEditStaleWarning || !project) return;
  const variant = project.mode === "highlight_cut" ? getActiveHighlightVariant(project) : null;
  const artifacts = variant?.artifacts || project.artifacts || {};
  const parseTimestamp = (value) => value ? (Date.parse(value) || 0) : 0;
  const changedAt = Math.max(parseTimestamp(project.videoEditUpdatedAt), parseTimestamp(variant?.videoEditUpdatedAt));
  const renderedAt = Math.max(parseTimestamp(artifacts.fastDraftRenderedAt), parseTimestamp(artifacts.finalRenderedAt));
  const hasOutput = Boolean(artifacts.fastDraftVideoPath || artifacts.finalVideoPath);
  const stale = hasOutput && changedAt > renderedAt;
  el.videoEditStaleWarning.classList.toggle("stale", stale);
  el.videoEditStaleWarning.classList.toggle("fresh", !stale);
  const strong = el.videoEditStaleWarning.querySelector("strong");
  const message = el.videoEditStaleWarning.querySelector("span");
  if (stale) {
    if (strong) strong.textContent = "Output cũ";
    if (message) message.textContent = "Cài đặt hình ảnh đã thay đổi. Hãy render nháp hoặc xuất lại video để áp dụng.";
  } else if (!hasOutput) {
    if (strong) strong.textContent = "Chưa render";
    if (message) message.textContent = "Preview đang mô phỏng cài đặt hiện tại; chưa có file output để đối chiếu.";
  } else {
    if (strong) strong.textContent = "Đã đồng bộ";
    if (message) message.textContent = "Preview và output đang dùng cùng cấu hình.";
  }
}

function getCurrentProjectSettings() {
  return {
    mixer: {
      voiceVolume: Number(el.voiceVolume?.value || 100),
      sourceVolume: Number(el.sourceVolume?.value || 0),
      narrationSourceAudioOverride: true,
      bgmVolume: Number(el.bgmVolume?.value || 40),
      ducking: Number(el.ducking?.value || 70),
      bgmPath: $("bgm-path")?.value || ""
    },
    subtitleStyle: $("subtitle-style")?.value || "white_black_outline",
    showSubtitles: el.showSubtitles?.checked === true,
    omniVoiceRenderMode: el.omniVoiceRenderMode?.value || "segment",
    storytimeContinuousVoice: el.storytimeContinuousVoice?.checked !== false,
    videoDecoration: {
      canvasEnabled: Boolean(el.videoCanvasEnabled?.checked),
      canvasAspect: el.videoCanvasAspect?.value || "9:16",
      customWidth: Number(el.videoCanvasWidth?.value || 1080),
      customHeight: Number(el.videoCanvasHeight?.value || 1920),
      blurBackgroundEnabled: Boolean(el.blurBackgroundEnabled?.checked),
      blurStrength: Number(el.blurBackgroundStrength?.value || 24),
      topCaptionEnabled: Boolean(el.topCaptionEnabled?.checked),
      topCaptionText: String(el.topCaptionText?.value || "").trim(),
      topCaptionStyle: el.topCaptionStyle?.value || "classic",
      topCaptionAutoFromScript: el.topCaptionText?.dataset.autoFromScript === "true",
      topCaptionFontSize: Number(el.topCaptionFontSize?.value || 52),
      topCaptionYPercent: Number(el.topCaptionY?.value || 8),
      cameraLabelEnabled: Boolean(el.cameraLabelEnabled?.checked),
      cameraLabelText: String(el.cameraLabelText?.value || "CAM 1").trim(),
      partLabelEnabled: Boolean(el.partLabelEnabled?.checked),
      partLabelAutoFromPart: el.partLabelAuto?.checked !== false,
      partLabelText: String(el.partLabelText?.value || "").trim(),
      partLabelStyle: el.partLabelStyle?.value || "compact",
      partLabelAlignment: el.partLabelAlignment?.value || "center",
      partLabelUppercase: el.partLabelUppercase?.checked !== false,
      partLabelTextColor: el.partLabelTextColor?.value || "#ffffff",
      partLabelBackgroundColor: el.partLabelBackgroundColor?.value || "#0b0d11",
      partLabelBackgroundOpacity: Number(el.partLabelOpacity?.value || 82) / 100,
      partLabelFontSize: Number(el.partLabelFontSize?.value || 38),
      partLabelXPercent: Number(el.partLabelX?.value || 12),
      partLabelYPercent: Number(el.partLabelY?.value || 8),
      foregroundScalePercent: Number(el.foregroundScale?.value || 100),
      foregroundXPercent: Number(el.foregroundX?.value || 50),
      foregroundYPercent: Number(el.foregroundY?.value || 50)
    },
    sourceSubtitleMask: getCurrentSourceSubtitleMask(),
    transitionStyle: $("transition-style")?.value || "hard_cut",
    autoFitVoice: el.autoFitVoice?.checked !== false,
    visualRemixEnabled: el.mixerVisualRemix?.checked || state.currentProject?.visualRemixEnabled || false,
    ...getDraftVoiceConfig()
  };
}

async function applyCurrentProjectSettings() {
  if (!state.currentProject) return;
  await persistCurrentVideoEditSettings();
}

function syncProjectSettingsControls(project = state.currentProject) {
  if (!project) return;
  if (project.mode !== "highlight_cut") state.videoEditScope = "global";
  el.videoEditScope?.querySelectorAll("[data-video-edit-scope]").forEach((button) => {
    const variantScope = button.dataset.videoEditScope === "variant";
    button.disabled = variantScope && project.mode !== "highlight_cut";
    button.classList.toggle("active", button.dataset.videoEditScope === state.videoEditScope);
  });
  project = getEffectiveVideoEditProject(project);
  const mixer = project.mixer || {};
  if (el.voiceVolume) el.voiceVolume.value = String(mixer.voiceVolume ?? 100);
  if (el.sourceVolume) {
    const defaultSourceVolume = project.mode === "highlight_cut" && mixer.narrationSourceAudioOverride !== true ? 0 : 20;
    el.sourceVolume.value = String(mixer.sourceVolume ?? defaultSourceVolume);
    if (project.mode === "highlight_cut" && mixer.narrationSourceAudioOverride !== true) el.sourceVolume.value = "0";
  }
  if (el.bgmVolume) el.bgmVolume.value = String(mixer.bgmVolume ?? 40);
  if (el.ducking) el.ducking.value = String(mixer.ducking ?? 70);
  if ($("bgm-path")) $("bgm-path").value = mixer.bgmPath || "";
  if (el.voiceVolValue && el.voiceVolume) el.voiceVolValue.textContent = `${el.voiceVolume.value}%`;
  if (el.sourceVolValue && el.sourceVolume) el.sourceVolValue.textContent = `${el.sourceVolume.value}%`;
  if (el.bgmVolValue && el.bgmVolume) el.bgmVolValue.textContent = `${el.bgmVolume.value}%`;
  if (el.duckingValue && el.ducking) el.duckingValue.textContent = `${el.ducking.value}%`;
  if ($("subtitle-style")) $("subtitle-style").value = project.subtitleStyle || "white_black_outline";
  if ($("transition-style")) $("transition-style").value = project.transitionStyle || "hard_cut";
  if (el.showSubtitles) el.showSubtitles.checked = project.showSubtitles === true;
  if (el.omniVoiceRenderMode) el.omniVoiceRenderMode.value = project.omniVoiceRenderMode || "segment";
  if (el.storytimeContinuousVoice) el.storytimeContinuousVoice.checked = project.storytimeContinuousVoice !== false;
  const videoDecoration = project.videoDecoration || {};
  if (el.videoCanvasEnabled) el.videoCanvasEnabled.checked = Boolean(videoDecoration.canvasEnabled);
  if (el.videoCanvasAspect) el.videoCanvasAspect.value = videoDecoration.canvasAspect || "9:16";
  if (el.videoCanvasWidth) el.videoCanvasWidth.value = String(videoDecoration.customWidth ?? 1080);
  if (el.videoCanvasHeight) el.videoCanvasHeight.value = String(videoDecoration.customHeight ?? 1920);
  if (el.blurBackgroundEnabled) el.blurBackgroundEnabled.checked = Boolean(videoDecoration.blurBackgroundEnabled);
  if (el.blurBackgroundStrength) el.blurBackgroundStrength.value = String(videoDecoration.blurStrength ?? 24);
  if (el.blurBackgroundStrengthValue) el.blurBackgroundStrengthValue.textContent = String(el.blurBackgroundStrength?.value || 24);
  if (el.topCaptionEnabled) el.topCaptionEnabled.checked = Boolean(videoDecoration.topCaptionEnabled);
  if (el.topCaptionText) el.topCaptionText.value = videoDecoration.topCaptionText || "";
  if (el.topCaptionStyle) el.topCaptionStyle.value = videoDecoration.topCaptionStyle || "classic";
  if (el.topCaptionText) {
    const autoFromScript = videoDecoration.topCaptionAutoFromScript === true
      || (videoDecoration.topCaptionEnabled === true && !String(videoDecoration.topCaptionText || "").trim());
    el.topCaptionText.dataset.autoFromScript = autoFromScript ? "true" : "false";
    if (autoFromScript && videoDecoration.topCaptionEnabled === true) {
      syncAutoTopCaptionFromScript(project, { force: true });
    }
  }
  if (el.topCaptionFontSize) el.topCaptionFontSize.value = String(videoDecoration.topCaptionFontSize ?? 52);
  if (el.topCaptionFontSizeValue) el.topCaptionFontSizeValue.textContent = String(el.topCaptionFontSize?.value || 52);
  if (el.topCaptionY) el.topCaptionY.value = String(videoDecoration.topCaptionYPercent ?? 8);
  if (el.topCaptionYValue) el.topCaptionYValue.textContent = `${el.topCaptionY?.value || 8}%`;
  if (el.cameraLabelEnabled) el.cameraLabelEnabled.checked = Boolean(videoDecoration.cameraLabelEnabled);
  if (el.cameraLabelText) el.cameraLabelText.value = videoDecoration.cameraLabelText || "CAM 1";
  if (el.partLabelEnabled) el.partLabelEnabled.checked = Boolean(videoDecoration.partLabelEnabled);
  if (el.partLabelAuto) el.partLabelAuto.checked = videoDecoration.partLabelAutoFromPart !== false;
  if (el.partLabelText) el.partLabelText.value = videoDecoration.partLabelText || "";
  if (el.partLabelStyle) el.partLabelStyle.value = videoDecoration.partLabelStyle || "compact";
  if (el.partLabelAlignment) el.partLabelAlignment.value = videoDecoration.partLabelAlignment || "center";
  if (el.partLabelUppercase) el.partLabelUppercase.checked = videoDecoration.partLabelUppercase !== false;
  if (el.partLabelTextColor) el.partLabelTextColor.value = videoDecoration.partLabelTextColor || "#ffffff";
  if (el.partLabelBackgroundColor) el.partLabelBackgroundColor.value = videoDecoration.partLabelBackgroundColor || "#0b0d11";
  if (el.partLabelFontSize) el.partLabelFontSize.value = String(videoDecoration.partLabelFontSize ?? 38);
  if (el.partLabelFontSizeValue) el.partLabelFontSizeValue.textContent = String(el.partLabelFontSize?.value || 38);
  if (el.partLabelOpacity) el.partLabelOpacity.value = String(Math.round(Number(videoDecoration.partLabelBackgroundOpacity ?? 0.82) * 100));
  if (el.partLabelOpacityValue) el.partLabelOpacityValue.textContent = `${el.partLabelOpacity?.value || 82}%`;
  if (el.partLabelX) el.partLabelX.value = String(videoDecoration.partLabelXPercent ?? 12);
  if (el.partLabelXValue) el.partLabelXValue.textContent = `${el.partLabelX?.value || 12}%`;
  if (el.partLabelY) el.partLabelY.value = String(videoDecoration.partLabelYPercent ?? 8);
  if (el.partLabelYValue) el.partLabelYValue.textContent = `${el.partLabelY?.value || 8}%`;
  if (el.partLabelText) el.partLabelText.disabled = el.partLabelAuto?.checked !== false;
  if (el.foregroundScale) el.foregroundScale.value = String(videoDecoration.foregroundScalePercent ?? 100);
  if (el.foregroundScaleValue) el.foregroundScaleValue.textContent = `${el.foregroundScale?.value || 100}%`;
  if (el.foregroundX) el.foregroundX.value = String(videoDecoration.foregroundXPercent ?? 50);
  if (el.foregroundY) el.foregroundY.value = String(videoDecoration.foregroundYPercent ?? 50);
  const sourceSubtitleMask = migrateLegacyCanvasMaskToSource(project, project.sourceSubtitleMask || {});
  if (el.sourceSubtitleMaskEnabled) el.sourceSubtitleMaskEnabled.checked = Boolean(sourceSubtitleMask.enabled);
  if (el.sourceSubtitleMaskMode) el.sourceSubtitleMaskMode.value = sourceSubtitleMask.mode || "blur";
  if (el.sourceSubtitleMaskX) el.sourceSubtitleMaskX.value = String(sourceSubtitleMask.xPercent ?? 0);
  if (el.sourceSubtitleMaskWidth) el.sourceSubtitleMaskWidth.value = String(sourceSubtitleMask.widthPercent ?? 100);
  if (el.sourceSubtitleMaskHeight) el.sourceSubtitleMaskHeight.value = String(sourceSubtitleMask.heightPercent ?? 16);
  if (el.sourceSubtitleMaskBottom) el.sourceSubtitleMaskBottom.value = String(sourceSubtitleMask.bottomPercent ?? 6);
  if (el.sourceSubtitleMaskStrength) el.sourceSubtitleMaskStrength.value = String(sourceSubtitleMask.strength ?? 18);
  if (el.sourceSubtitleMaskHeightValue) el.sourceSubtitleMaskHeightValue.textContent = `${el.sourceSubtitleMaskHeight?.value || 16}%`;
  if (el.sourceSubtitleMaskBottomValue) el.sourceSubtitleMaskBottomValue.textContent = `${el.sourceSubtitleMaskBottom?.value || 6}%`;
  if (el.sourceSubtitleMaskStrengthValue) el.sourceSubtitleMaskStrengthValue.textContent = `${el.sourceSubtitleMaskStrength?.value || 18}`;
  if (el.autoFitVoice) el.autoFitVoice.checked = project.autoFitVoice !== false;
  if (el.mixerVisualRemix) el.mixerVisualRemix.checked = Boolean(project.visualRemixEnabled);
  if (el.draftVoiceMode) el.draftVoiceMode.value = project.draftVoiceMode || "edge_neural";
  if (el.draftVoiceProvider) el.draftVoiceProvider.value = project.draftVoiceProvider || "edge_neural";
  if (el.draftVoiceId) el.draftVoiceId.value = project.draftVoiceId || "";
  if (el.draftVoiceList && project.draftVoiceId) {
    el.draftVoiceList.dataset.preferredVoiceId = project.draftVoiceId;
    if ([...el.draftVoiceList.options].some((option) => option.value === project.draftVoiceId)) {
      el.draftVoiceList.value = project.draftVoiceId;
    }
  }
  updateVideoDecorationPreview();
  updateVideoEditStaleStatus(state.currentProject);
}

function getSuggestedTopCaption(project = state.currentProject) {
  const analysis = project?.analysis || {};
  const firstVariant = Array.isArray(analysis.highlightVariants) ? analysis.highlightVariants[0] : null;
  return String(
    analysis.sharedTopBannerText
    || analysis.shared_top_banner_text
    || analysis.topHeader
    || analysis.top_banner_text
    || analysis.top_header
    || analysis.scriptTitle
    || analysis.title
    || firstVariant?.sharedTopBannerText
    || firstVariant?.topHeader
    || firstVariant?.top_banner_text
    || firstVariant?.top_header
    || firstVariant?.title
    || project?.title
    || ""
  ).replace(/\s+/g, " ").trim().slice(0, 180);
}

function syncAutoTopCaptionFromScript(project = state.currentProject, { force = false } = {}) {
  if (!el.topCaptionText || !el.topCaptionEnabled?.checked) return "";
  const isAuto = el.topCaptionText.dataset.autoFromScript === "true";
  if (!force && !isAuto) return String(el.topCaptionText.value || "").trim();
  const suggestion = getSuggestedTopCaption(project);
  if (suggestion) {
    el.topCaptionText.value = suggestion;
    el.topCaptionText.dataset.autoFromScript = "true";
    if (el.topCaptionSource) el.topCaptionSource.textContent = "Đang dùng tiêu đề chung tự động từ JSON Gemini. Sửa nội dung để chuyển sang thủ công.";
  }
  return suggestion;
}

function resolveCurrentPartLabelText(project = state.currentProject) {
  if (!el.partLabelEnabled?.checked) return "";
  let value = String(el.partLabelText?.value || "").trim();
  if (el.partLabelAuto?.checked !== false) {
    const variants = Array.isArray(project?.analysis?.highlightVariants)
      ? project.analysis.highlightVariants
      : [];
    const active = variants.find((variant) => variant.id === project?.analysis?.activeVariantId)
      || variants[0]
      || {};
    const index = variants.findIndex((variant) => variant.id === active.id);
    const partNumber = Number(active.partNumber || active.part_number) || (index >= 0 ? index + 1 : 0);
    value = partNumber > 0
      ? `PART ${partNumber}`
      : String(active.partBadge || active.part_badge || value).trim();
  }
  return el.partLabelUppercase?.checked === false ? value : value.toUpperCase();
}

function getVideoCanvasDimensions() {
  const aspect = el.videoCanvasAspect?.value || "9:16";
  if (aspect === "4:3") return { width: 1440, height: 1080, label: "4:3" };
  if (aspect === "3:4") return { width: 1080, height: 1440, label: "3:4" };
  if (aspect === "custom") {
    const width = Math.max(320, Math.min(3840, Number(el.videoCanvasWidth?.value || 1080)));
    const height = Math.max(320, Math.min(3840, Number(el.videoCanvasHeight?.value || 1920)));
    return { width, height, label: `${Math.round(width)}×${Math.round(height)}` };
  }
  return { width: 1080, height: 1920, label: "9:16" };
}

function migrateLegacyCanvasMaskToSource(project = {}, mask = {}) {
  if (mask.coordinateSpace === "source_v2") return mask;
  const decoration = project.videoDecoration || {};
  const canvas = getVideoCanvasDimensions();
  const media = project.analysis?.media || {};
  const sourceWidth = Math.max(1, Number(media.width || el.previewPlayer?.videoWidth || 1080));
  const sourceHeight = Math.max(1, Number(media.height || el.previewPlayer?.videoHeight || 1920));
  const sourceRatio = sourceWidth / sourceHeight;
  const canvasRatio = canvas.width / canvas.height;
  const baseWidth = sourceRatio > canvasRatio ? canvas.width : canvas.height * sourceRatio;
  const baseHeight = sourceRatio > canvasRatio ? canvas.width / sourceRatio : canvas.height;
  const scale = Math.max(0.5, Math.min(1.6, Number(decoration.foregroundScalePercent ?? 100) / 100));
  const foregroundWidth = baseWidth * scale;
  const foregroundHeight = baseHeight * scale;
  const foregroundLeft = (canvas.width * Math.max(0, Math.min(100, Number(decoration.foregroundXPercent ?? 50))) / 100) - foregroundWidth / 2;
  const foregroundTop = (canvas.height * Math.max(0, Math.min(100, Number(decoration.foregroundYPercent ?? 50))) / 100) - foregroundHeight / 2;
  const legacyHeight = Math.max(4, Math.min(45, Number(mask.heightPercent ?? 16)));
  const legacyTop = 100 - Math.max(0, Number(mask.bottomPercent ?? 6)) - legacyHeight;
  const sourceWidthPercent = Math.max(4, Math.min(100, Number(mask.widthPercent ?? 100) * canvas.width / foregroundWidth));
  const sourceHeightPercent = Math.max(4, Math.min(45, legacyHeight * canvas.height / foregroundHeight));
  const sourceX = Math.max(0, Math.min(100 - sourceWidthPercent, ((Number(mask.xPercent ?? 0) * canvas.width / 100) - foregroundLeft) / foregroundWidth * 100));
  const sourceTop = Math.max(0, Math.min(100 - sourceHeightPercent, ((legacyTop * canvas.height / 100) - foregroundTop) / foregroundHeight * 100));
  return {
    ...mask,
    coordinateSpace: "source_v2",
    xPercent: Number(sourceX.toFixed(3)),
    widthPercent: Number(sourceWidthPercent.toFixed(3)),
    heightPercent: Number(sourceHeightPercent.toFixed(3)),
    bottomPercent: Number((100 - sourceTop - sourceHeightPercent).toFixed(3))
  };
}

function calculatePreviewTitleWrapChars(width = 1080, referenceFontSize = 52) {
  const targetWidth = Math.max(320, Number(width) || 1080);
  const fontSize = Math.max(16, (Number(referenceFontSize) || 52) * (targetWidth / 1080));
  const boxWidth = targetWidth * 0.82;
  const horizontalPadding = fontSize * 0.65;
  const estimatedGlyphWidth = fontSize * 0.5;
  return Math.max(12, Math.min(42, Math.floor(
    (boxWidth - (horizontalPadding * 2)) / Math.max(1, estimatedGlyphWidth)
  )));
}

function wrapPreviewVideoTitle(value, maxChars = 36) {
  const words = String(value || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && candidate.length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3).join("\n");
}

function clampSubtitleMaskValue(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function hexToRgba(value, alpha = 1) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value || ""));
  if (!match) return `rgba(11, 13, 17, ${alpha})`;
  const numeric = Number.parseInt(match[1], 16);
  return `rgba(${(numeric >> 16) & 255}, ${(numeric >> 8) & 255}, ${numeric & 255}, ${alpha})`;
}

function getSubtitleMaskRect() {
  const height = clampSubtitleMaskValue(el.sourceSubtitleMaskHeight?.value || 16, 4, 45);
  const bottom = clampSubtitleMaskValue(el.sourceSubtitleMaskBottom?.value || 6, 0, 100 - height);
  const x = clampSubtitleMaskValue(el.sourceSubtitleMaskX?.value || 0, 0, 96);
  const width = clampSubtitleMaskValue(el.sourceSubtitleMaskWidth?.value || 100, 4, 100 - x);
  return { x, top: 100 - bottom - height, width, height, bottom };
}

function updateSubtitleMaskGeometryLabel(rect = getSubtitleMaskRect()) {
  if (!el.sourceSubtitleMaskGeometry) return;
  el.sourceSubtitleMaskGeometry.textContent = `X ${rect.x.toFixed(1)}% · Y ${rect.top.toFixed(1)}% · Rộng ${rect.width.toFixed(1)}% · Cao ${rect.height.toFixed(1)}%`;
}

function setSubtitleMaskRect(nextRect, { persist = false } = {}) {
  const width = clampSubtitleMaskValue(nextRect.width, 4, 100);
  const height = clampSubtitleMaskValue(nextRect.height, 4, 45);
  const x = clampSubtitleMaskValue(nextRect.x, 0, 100 - width);
  const top = clampSubtitleMaskValue(nextRect.top, 0, 100 - height);
  if (el.sourceSubtitleMaskX) el.sourceSubtitleMaskX.value = String(Number(x.toFixed(3)));
  if (el.sourceSubtitleMaskWidth) el.sourceSubtitleMaskWidth.value = String(Number(width.toFixed(3)));
  if (el.sourceSubtitleMaskHeight) el.sourceSubtitleMaskHeight.value = String(Number(height.toFixed(3)));
  if (el.sourceSubtitleMaskBottom) el.sourceSubtitleMaskBottom.value = String(Number((100 - top - height).toFixed(3)));
  if (el.sourceSubtitleMaskHeightValue) el.sourceSubtitleMaskHeightValue.textContent = `${Number(height.toFixed(1))}%`;
  if (el.sourceSubtitleMaskBottomValue) el.sourceSubtitleMaskBottomValue.textContent = `${Number((100 - top - height).toFixed(1))}%`;
  updateSubtitleMaskGeometryLabel({ x, top, width, height, bottom: 100 - top - height });
  updateSubtitleMaskPreview();
  if (persist) {
    writeSetupDraft();
    persistSubtitleMaskSettingsSoon(0);
  }
}

function getPreviewVideoContentRect(frame) {
  const frameBounds = frame?.getBoundingClientRect?.();
  const videoBounds = el.previewPlayer?.getBoundingClientRect?.();
  if (!frameBounds || !videoBounds || !videoBounds.width || !videoBounds.height) {
    return { left: 0, top: 0, width: Number(frame?.clientWidth || 0), height: Number(frame?.clientHeight || 0) };
  }
  return {
    left: videoBounds.left - frameBounds.left,
    top: videoBounds.top - frameBounds.top,
    width: videoBounds.width,
    height: videoBounds.height
  };
}

function syncPreviewNativeControls() {
  if (!el.previewPlayer) return;
  el.previewPlayer.controls = false;
  el.previewPlayer.removeAttribute("controls");
  positionPreviewSubtitleOverlay();
}

function setSubtitleMaskEditorActive(active) {
  subtitleMaskEditorActive = Boolean(active && el.sourceSubtitleMaskEnabled?.checked);
  el.sourceSubtitleMaskEditor?.classList.toggle("editing", subtitleMaskEditorActive);
  el.editSourceSubtitleMask?.classList.toggle("active", subtitleMaskEditorActive);
  el.foregroundLayoutEditor?.classList.toggle("interaction-suspended", subtitleMaskEditorActive);
  el.videoTitleOverlay?.classList.toggle("interaction-suspended", subtitleMaskEditorActive);
  el.videoPartLabelOverlay?.classList.toggle("interaction-suspended", subtitleMaskEditorActive);
  if (el.editSourceSubtitleMask) {
    el.editSourceSubtitleMask.textContent = subtitleMaskEditorActive ? "Xong" : "Chỉnh vùng trên preview";
  }
  if (el.previewPlayer) {
    if (subtitleMaskEditorActive) {
      el.previewPlayer.pause();
      el.previewPlayer.controls = false;
      el.previewPlayer.classList.add("mask-editing");
    } else {
      el.previewPlayer.classList.remove("mask-editing");
      syncPreviewNativeControls();
    }
  }
  if (subtitleMaskEditorActive) {
    el.subtitleOverlay?.classList.add("hidden");
  } else {
    updatePreviewSubtitleOverlay();
  }
}

function updateSubtitleMaskPreview() {
  const editor = el.sourceSubtitleMaskEditor;
  const selection = el.sourceSubtitleMaskSelection;
  const frame = el.previewPlayer?.closest(".video-frame");
  if (!editor || !selection || !frame) return;
  const enabled = Boolean(el.sourceSubtitleMaskEnabled?.checked);
  editor.classList.toggle("hidden", !enabled);
  if (el.editSourceSubtitleMask) el.editSourceSubtitleMask.disabled = !enabled;
  if (!enabled) setSubtitleMaskEditorActive(false);
  const content = getPreviewVideoContentRect(frame);
  editor.style.left = `${content.left}px`;
  editor.style.top = `${content.top}px`;
  editor.style.width = `${content.width}px`;
  editor.style.height = `${content.height}px`;
  const rect = getSubtitleMaskRect();
  selection.style.left = `${rect.x}%`;
  selection.style.top = `${rect.top}%`;
  selection.style.width = `${rect.width}%`;
  selection.style.height = `${rect.height}%`;
  const strength = Number(el.sourceSubtitleMaskStrength?.value || 18);
  const darkMode = el.sourceSubtitleMaskMode?.value === "dark";
  selection.classList.toggle("dark", darkMode);
  selection.style.setProperty("--mask-preview-blur", `${Math.max(2, strength * 0.35)}px`);
  selection.style.setProperty("--mask-preview-darkness", String(Math.min(0.9, 0.18 + strength / 55)));
  updateSubtitleMaskGeometryLabel(rect);
}

function getSubtitleMaskPointer(event) {
  const bounds = el.sourceSubtitleMaskEditor.getBoundingClientRect();
  return {
    x: clampSubtitleMaskValue(((event.clientX - bounds.left) / Math.max(1, bounds.width)) * 100, 0, 100),
    y: clampSubtitleMaskValue(((event.clientY - bounds.top) / Math.max(1, bounds.height)) * 100, 0, 100)
  };
}

function beginSubtitleMaskPointer(event) {
  if (!subtitleMaskEditorActive || event.button !== 0) return;
  event.preventDefault();
  const point = getSubtitleMaskPointer(event);
  const rect = getSubtitleMaskRect();
  const handle = event.target?.dataset?.handle || "";
  const inSelection = Boolean(event.target?.closest?.(".source-subtitle-mask-selection"));
  subtitleMaskPointerState = {
    pointerId: event.pointerId,
    mode: handle ? "resize" : inSelection ? "move" : "draw",
    handle,
    origin: point,
    rect
  };
  el.sourceSubtitleMaskEditor.setPointerCapture(event.pointerId);
  if (!handle && !inSelection) {
    setSubtitleMaskRect({ x: point.x, top: point.y, width: 4, height: 4 });
  }
}

function moveSubtitleMaskPointer(event) {
  const drag = subtitleMaskPointerState;
  if (!drag || drag.pointerId !== event.pointerId) return;
  event.preventDefault();
  const point = getSubtitleMaskPointer(event);
  if (drag.mode === "draw") {
    setSubtitleMaskRect({
      x: Math.min(drag.origin.x, point.x),
      top: Math.min(drag.origin.y, point.y),
      width: Math.max(4, Math.abs(point.x - drag.origin.x)),
      height: Math.max(4, Math.abs(point.y - drag.origin.y))
    });
    return;
  }
  if (drag.mode === "move") {
    setSubtitleMaskRect({
      ...drag.rect,
      x: drag.rect.x + point.x - drag.origin.x,
      top: drag.rect.top + point.y - drag.origin.y
    });
    return;
  }
  let left = drag.rect.x;
  let right = drag.rect.x + drag.rect.width;
  let top = drag.rect.top;
  let bottom = drag.rect.top + drag.rect.height;
  if (drag.handle.includes("w")) left = Math.min(point.x, right - 4);
  if (drag.handle.includes("e")) right = Math.max(point.x, left + 4);
  if (drag.handle.includes("n")) top = Math.min(point.y, bottom - 4);
  if (drag.handle.includes("s")) bottom = Math.max(point.y, top + 4);
  setSubtitleMaskRect({ x: left, top, width: right - left, height: bottom - top });
}

function endSubtitleMaskPointer(event) {
  if (!subtitleMaskPointerState || subtitleMaskPointerState.pointerId !== event.pointerId) return;
  subtitleMaskPointerState = null;
  writeSetupDraft();
  persistSubtitleMaskSettingsSoon(0);
}

function getPreviewFrameSpace(frame) {
  const stage = frame.closest(".video-stage");
  const controlsHeight = stage?.querySelector(".preview-control-bar")?.getBoundingClientRect().height || 0;
  const gap = stage ? parseFloat(getComputedStyle(stage).rowGap) || 0 : 0;
  return {
    availableWidth: Math.max(1, Math.min(420, Number(frame.parentElement?.clientWidth || 420))),
    availableHeight: Math.max(1, Math.min(660, stage?.clientHeight
      ? stage.clientHeight - controlsHeight - gap - 8 : window.innerHeight - 390))
  };
}

function updateVideoDecorationPreview() {
  const frame = el.previewPlayer?.closest(".video-frame");
  if (!frame) return;
  const previewPath = getPreviewVideoPath(state.currentProject);
  const decoratedPreview = isDecoratedPreviewVideo(state.currentProject, previewPath);
  frame.classList.toggle("rendered-preview", decoratedPreview);
  if (decoratedPreview) {
    const renderedWidth = Math.max(1, Number(el.previewPlayer?.videoWidth || 1080));
    const renderedHeight = Math.max(1, Number(el.previewPlayer?.videoHeight || 1920));
    const ratio = renderedWidth / renderedHeight;
    const { availableWidth, availableHeight } = getPreviewFrameSpace(frame);
    const previewWidth = availableWidth / availableHeight > ratio ? availableHeight * ratio : availableWidth;
    const previewHeight = previewWidth / ratio;
    frame.classList.remove("blur-canvas-enabled");
    frame.style.width = `${Math.round(previewWidth)}px`;
    frame.style.height = `${Math.round(previewHeight)}px`;
    frame.style.aspectRatio = `${renderedWidth} / ${renderedHeight}`;
    el.videoTitleOverlay?.classList.add("hidden");
    el.videoPartLabelOverlay?.classList.add("hidden");
    el.foregroundLayoutEditor?.classList.add("hidden");
    el.previewBackgroundPlayer?.classList.add("hidden");
    Object.assign(el.previewPlayer.style, {
      position: "absolute",
      left: "0px",
      top: "0px",
      width: "100%",
      height: "100%"
    });
    updateSubtitleMaskPreview();
    positionPreviewSubtitleOverlay();
    return;
  }
  const configuredCanvas = getVideoCanvasDimensions();
  el.previewBackgroundPlayer?.classList.remove("hidden");
  const decorationCanvasActive = Boolean(
    el.videoCanvasEnabled?.checked
    || el.blurBackgroundEnabled?.checked
    || el.topCaptionEnabled?.checked
    || el.partLabelEnabled?.checked
    || Number(el.foregroundScale?.value || 100) !== 100
    || Math.abs(Number(el.foregroundX?.value || 50) - 50) > 0.01
    || Math.abs(Number(el.foregroundY?.value || 50) - 50) > 0.01
  );
  const sourceMedia = state.currentProject?.analysis?.media || {};
  const sourceWidth = Number(sourceMedia.width || el.previewPlayer?.videoWidth || 1080);
  const sourceHeight = Number(sourceMedia.height || el.previewPlayer?.videoHeight || 1920);
  const canvas = decorationCanvasActive
    ? configuredCanvas
    : { width: sourceWidth, height: sourceHeight, label: "Giữ tỷ lệ gốc" };
  const ratio = canvas.width / canvas.height;
  const { availableWidth, availableHeight } = getPreviewFrameSpace(frame);
  const previewWidth = availableWidth / availableHeight > ratio
    ? availableHeight * ratio
    : availableWidth;
  const previewHeight = previewWidth / ratio;
  const blurEnabled = Boolean(el.blurBackgroundEnabled?.checked);
  const captionEnabled = Boolean(el.topCaptionEnabled?.checked);
  const captionText = String(el.topCaptionText?.value || state.currentProject?.title || "").trim();
  const foregroundScale = Math.max(0.5, Math.min(1.6, Number(el.foregroundScale?.value || 100) / 100));
  const foregroundX = Math.max(0, Math.min(100, Number(el.foregroundX?.value || 50)));
  const foregroundY = Math.max(0, Math.min(100, Number(el.foregroundY?.value || 50)));
  frame.classList.toggle("blur-canvas-enabled", blurEnabled);
  frame.style.width = `${Math.round(previewWidth)}px`;
  frame.style.height = `${Math.round(previewHeight)}px`;
  frame.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
  frame.style.setProperty("--preview-blur", `${Number(el.blurBackgroundStrength?.value || 24)}px`);
  el.videoCanvasCustomSize?.classList.toggle("hidden", el.videoCanvasAspect?.value !== "custom");
  if (el.videoCanvasRatioLabel) el.videoCanvasRatioLabel.textContent = canvas.label;
  if (el.videoTitleOverlay) {
    const wrappedCaption = wrapPreviewVideoTitle(
      captionText,
      calculatePreviewTitleWrapChars(canvas.width, el.topCaptionFontSize?.value || 52)
    );
    el.videoTitleOverlay.textContent = wrappedCaption;
    el.videoTitleOverlay.classList.toggle("hidden", !(captionEnabled && captionText));
    const isViralGreenTitle = (el.topCaptionStyle?.value || state.currentProject?.videoDecoration?.topCaptionStyle) === "viral_green";
    el.videoTitleOverlay.classList.toggle("viral-green", isViralGreenTitle);
    el.videoTitleOverlay.style.fontSize = `${Math.max(11, Number(el.topCaptionFontSize?.value || 52) * (previewWidth / canvas.width))}px`;
    el.videoTitleOverlay.style.top = `${Number(el.topCaptionY?.value || 8)}%`;
  }
  if (el.videoPartLabelOverlay) {
    const partText = resolveCurrentPartLabelText(state.currentProject);
    const style = el.partLabelStyle?.value || "compact";
    const canvasFontSize = Math.max(12, Math.round(Number(el.partLabelFontSize?.value || 38) * (canvas.width / 1080)));
    const canvasPaddingX = Math.max(8, Math.round(canvasFontSize * 0.62));
    const canvasPaddingY = Math.max(5, Math.round(canvasFontSize * 0.35));
    const canvasBoxWidth = Math.max(
      canvasFontSize * 3,
      Math.min(canvas.width * 0.82, Math.round(partText.length * canvasFontSize * 0.62) + canvasPaddingX * 2)
    );
    const canvasBoxHeight = canvasFontSize + canvasPaddingY * 2;
    const centerX = canvas.width * Number(el.partLabelX?.value || 12) / 100;
    const centerY = canvas.height * Number(el.partLabelY?.value || 8) / 100;
    const canvasLeft = Math.max(0, Math.min(canvas.width - canvasBoxWidth, centerX - canvasBoxWidth / 2));
    const canvasTop = Math.max(0, Math.min(canvas.height - canvasBoxHeight, centerY - canvasBoxHeight / 2));
    const scale = previewWidth / canvas.width;
    el.videoPartLabelOverlay.textContent = partText;
    el.videoPartLabelOverlay.classList.toggle("hidden", !partText);
    el.videoPartLabelOverlay.classList.toggle("bold", style === "bold");
    el.videoPartLabelOverlay.classList.toggle("viral-green", style === "viral_green");
    el.videoPartLabelOverlay.classList.toggle("no-background", style === "no_background");
    el.videoPartLabelOverlay.style.left = `${canvasLeft * scale}px`;
    el.videoPartLabelOverlay.style.top = `${canvasTop * scale}px`;
    el.videoPartLabelOverlay.style.width = `${canvasBoxWidth * scale}px`;
    el.videoPartLabelOverlay.style.height = `${canvasBoxHeight * scale}px`;
    el.videoPartLabelOverlay.style.padding = "0";
    el.videoPartLabelOverlay.style.transform = "none";
    el.videoPartLabelOverlay.style.fontSize = `${Math.max(9, canvasFontSize * scale)}px`;
    el.videoPartLabelOverlay.style.color = el.partLabelTextColor?.value || "#ffffff";
    el.videoPartLabelOverlay.style.background = style === "no_background"
      ? "transparent"
      : hexToRgba(el.partLabelBackgroundColor?.value, Number(el.partLabelOpacity?.value || 82) / 100);
    el.videoPartLabelOverlay.style.textAlign = el.partLabelAlignment?.value || "center";
    el.videoPartLabelOverlay.style.justifyContent = el.partLabelAlignment?.value === "left"
      ? "flex-start"
      : el.partLabelAlignment?.value === "right"
        ? "flex-end"
        : "center";
    el.videoPartLabelOverlay.style.paddingLeft = `${canvasPaddingX * scale}px`;
    el.videoPartLabelOverlay.style.paddingRight = `${canvasPaddingX * scale}px`;
  }
  if (el.previewPlayer) {
    const sourceRatio = sourceWidth / Math.max(1, sourceHeight);
    const frameRatio = previewWidth / Math.max(1, previewHeight);
    const baseWidth = sourceRatio > frameRatio ? previewWidth : previewHeight * sourceRatio;
    const baseHeight = sourceRatio > frameRatio ? previewWidth / sourceRatio : previewHeight;
    const foregroundWidth = baseWidth * foregroundScale;
    const foregroundHeight = baseHeight * foregroundScale;
    const left = (previewWidth * foregroundX / 100) - (foregroundWidth / 2);
    const top = (previewHeight * foregroundY / 100) - (foregroundHeight / 2);
    Object.assign(el.previewPlayer.style, {
      position: "absolute",
      left: `${left}px`,
      top: `${top}px`,
      width: `${foregroundWidth}px`,
      height: `${foregroundHeight}px`
    });
    if (el.foregroundLayoutEditor) {
      Object.assign(el.foregroundLayoutEditor.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${foregroundWidth}px`,
        height: `${foregroundHeight}px`
      });
      el.foregroundLayoutEditor.classList.toggle("hidden", !frame.classList.contains("video-editing"));
    }
  }
  updateSubtitleMaskPreview();
}

function setVideoWysiwygEditing(active) {
  const frame = el.previewPlayer?.closest(".video-frame");
  frame?.classList.toggle("video-editing", Boolean(active));
  el.foregroundLayoutEditor?.classList.toggle("hidden", !active);
  if (active) updateVideoDecorationPreview();
}

function handleForegroundPointerDown(event) {
  const frame = el.previewPlayer?.closest(".video-frame");
  if (!frame || !el.foregroundLayoutEditor || !frame.classList.contains("video-editing")) return;
  event.preventDefault();
  const resize = Boolean(event.target?.closest?.("[data-handle='se']"));
  foregroundPointerState = {
    pointerId: event.pointerId,
    mode: resize ? "resize" : "move",
    startX: event.clientX,
    startY: event.clientY,
    x: Number(el.foregroundX?.value || 50),
    y: Number(el.foregroundY?.value || 50),
    scale: Number(el.foregroundScale?.value || 100),
    frameWidth: Math.max(1, frame.clientWidth),
    frameHeight: Math.max(1, frame.clientHeight)
  };
  el.foregroundLayoutEditor.setPointerCapture?.(event.pointerId);
}

function handleForegroundPointerMove(event) {
  const drag = foregroundPointerState;
  if (!drag || drag.pointerId !== event.pointerId) return;
  event.preventDefault();
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  if (drag.mode === "resize") {
    const nextScale = Math.max(50, Math.min(160, drag.scale + ((dx + dy) / Math.max(1, drag.frameWidth + drag.frameHeight)) * 260));
    if (el.foregroundScale) el.foregroundScale.value = String(Math.round(nextScale));
    if (el.foregroundScaleValue) el.foregroundScaleValue.textContent = `${Math.round(nextScale)}%`;
  } else {
    if (el.foregroundX) el.foregroundX.value = String(Math.max(0, Math.min(100, drag.x + (dx / drag.frameWidth) * 100)).toFixed(2));
    if (el.foregroundY) el.foregroundY.value = String(Math.max(0, Math.min(100, drag.y + (dy / drag.frameHeight) * 100)).toFixed(2));
  }
  updateVideoDecorationPreview();
}

function handleForegroundPointerUp(event) {
  if (!foregroundPointerState || foregroundPointerState.pointerId !== event.pointerId) return;
  foregroundPointerState = null;
  persistVideoEditSettingsSoon(0);
}

function handleTitlePointerDown(event) {
  const frame = el.previewPlayer?.closest(".video-frame");
  if (!frame?.classList.contains("video-editing") || !el.topCaptionEnabled?.checked) return;
  event.preventDefault();
  titlePointerState = {
    pointerId: event.pointerId,
    startY: event.clientY,
    y: Number(el.topCaptionY?.value || 8),
    frameHeight: Math.max(1, frame.clientHeight)
  };
  el.videoTitleOverlay?.setPointerCapture?.(event.pointerId);
}

function handleTitlePointerMove(event) {
  const drag = titlePointerState;
  if (!drag || drag.pointerId !== event.pointerId) return;
  event.preventDefault();
  const y = Math.max(3, Math.min(75, drag.y + ((event.clientY - drag.startY) / drag.frameHeight) * 100));
  if (el.topCaptionY) el.topCaptionY.value = String(Math.round(y));
  if (el.topCaptionYValue) el.topCaptionYValue.textContent = `${Math.round(y)}%`;
  updateVideoDecorationPreview();
}

function handleTitlePointerUp(event) {
  if (!titlePointerState || titlePointerState.pointerId !== event.pointerId) return;
  titlePointerState = null;
  persistVideoEditSettingsSoon(0);
}

function handlePartLabelPointerDown(event) {
  const frame = el.previewPlayer?.closest(".video-frame");
  if (!frame?.classList.contains("video-editing") || !el.partLabelEnabled?.checked) return;
  event.preventDefault();
  partLabelPointerState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    x: Number(el.partLabelX?.value || 12),
    y: Number(el.partLabelY?.value || 8),
    frameWidth: Math.max(1, frame.clientWidth),
    frameHeight: Math.max(1, frame.clientHeight)
  };
  el.videoPartLabelOverlay?.setPointerCapture?.(event.pointerId);
}

function handlePartLabelPointerMove(event) {
  const drag = partLabelPointerState;
  if (!drag || drag.pointerId !== event.pointerId) return;
  event.preventDefault();
  const x = Math.max(5, Math.min(95, drag.x + ((event.clientX - drag.startX) / drag.frameWidth) * 100));
  const y = Math.max(3, Math.min(97, drag.y + ((event.clientY - drag.startY) / drag.frameHeight) * 100));
  if (el.partLabelX) el.partLabelX.value = String(Number(x.toFixed(2)));
  if (el.partLabelY) el.partLabelY.value = String(Number(y.toFixed(2)));
  if (el.partLabelXValue) el.partLabelXValue.textContent = `${Math.round(x)}%`;
  if (el.partLabelYValue) el.partLabelYValue.textContent = `${Math.round(y)}%`;
  updateVideoDecorationPreview();
}

function handlePartLabelPointerUp(event) {
  if (!partLabelPointerState || partLabelPointerState.pointerId !== event.pointerId) return;
  partLabelPointerState = null;
  persistVideoEditSettingsSoon(0);
}

function syncPreviewBackgroundSource() {
  if (!el.previewBackgroundPlayer || !el.previewPlayer) return;
  const source = el.previewPlayer.currentSrc || el.previewPlayer.src || "";
  if (!source) {
    el.previewBackgroundPlayer.removeAttribute("src");
    return;
  }
  if (el.previewBackgroundPlayer.src !== source) {
    el.previewBackgroundPlayer.src = source;
    el.previewBackgroundPlayer.load();
  }
}

function syncPreviewBackgroundPlayback(forceSeek = false) {
  if (!el.previewBackgroundPlayer || !el.previewPlayer) return;
  syncPreviewBackgroundSource();
  const difference = Math.abs((el.previewBackgroundPlayer.currentTime || 0) - (el.previewPlayer.currentTime || 0));
  if (forceSeek || difference > 0.18) {
    try {
      el.previewBackgroundPlayer.currentTime = el.previewPlayer.currentTime || 0;
    } catch (_error) {}
  }
  el.previewBackgroundPlayer.playbackRate = el.previewPlayer.playbackRate || 1;
}

function renderScenePreviewMedia({ videoUrl, startSec = 0, thumbnailPath = "", className = "", placeholder = "Chưa có video" }) {
  const thumbUrl = toFileUrl(thumbnailPath);
  if (thumbUrl) {
    return `<img class="${escapeHtml(className)}" src="${escapeHtml(thumbUrl)}" alt="Ảnh cảnh" loading="lazy" />`;
  }
  if (videoUrl) {
    return `<video class="${escapeHtml(className)}" muted playsinline preload="metadata" data-scene-preview data-start-sec="${Number(startSec || 0)}" src="${escapeHtml(videoUrl)}"></video>`;
  }
  return `<div class="scene-thumb-placeholder">${escapeHtml(placeholder)}</div>`;
}

function fmt(seconds, digits = 3) {
  return Number(seconds || 0).toFixed(digits);
}

function getAiProviderLabel(value = el.aiProvider?.value) {
  if (value === "vertex_ai") {
    return "Vertex AI";
  }
  if (value === "antigravity_cli") {
    return "Antigravity CLI";
  }
  if (value === "ollama_local") {
    return "Ollama Local";
  }
  if (value === "local") {
    return "Dự phòng cục bộ";
  }
  return "Gemini";
}

function getConfiguredAiUiInfo(settings = null) {
  const effectiveSettings = settings || (el.aiProvider ? readSettings() : state.settings) || {};
  const provider = effectiveSettings.aiProvider || "gemini";
  if (provider === "antigravity_cli") {
    return {
      provider,
      label: "Antigravity",
      model: effectiveSettings.antigravityModel || "model mặc định CLI",
      supported: true
    };
  }
  if (provider === "gemini") {
    return {
      provider,
      label: "Gemini",
      model: effectiveSettings.geminiModel || "gemini-2.5-pro",
      supported: Boolean(effectiveSettings.geminiApiKey),
      reason: effectiveSettings.geminiApiKey ? "" : "Chưa có Gemini API key trong Cài đặt."
    };
  }
  if (provider === "vertex_ai") {
    const authReady = Boolean(effectiveSettings.vertexCredentialPath || effectiveSettings.vertexGcloudCommand);
    const projectReady = Boolean(effectiveSettings.vertexProjectId || effectiveSettings.vertexCredentialPath);
    return {
      provider,
      label: "Vertex AI",
      model: effectiveSettings.vertexAnalysisModel || "gemini-2.5-flash",
      supported: authReady && projectReady,
      reason: projectReady
        ? "Chưa cấu hình file service account hoặc Application Default Credentials."
        : "Chưa nhập Google Cloud Project ID hoặc chọn service account JSON trong Cài đặt."
    };
  }
  return {
    provider,
    label: getAiProviderLabel(provider),
    model: effectiveSettings.ollamaVisionModel || "",
    supported: false,
    reason: "Luồng review video đa phương thức chỉ hỗ trợ Gemini, Vertex AI hoặc Antigravity."
  };
}

function syncConfiguredAiWorkflowUi() {
  const info = getConfiguredAiUiInfo();
  const badge = `${info.label} · ${info.model}`;
  if (el.stage1AiProviderBadge) el.stage1AiProviderBadge.textContent = badge;
  if (el.stage1AiModelBadge) el.stage1AiModelBadge.textContent = badge;
  if (el.draftReviewAiBadge) el.draftReviewAiBadge.textContent = badge;
  if (el.stage1AiActionTitle) el.stage1AiActionTitle.textContent = `Phân tích bằng ${info.label}`;
  if (el.stage1AiActionDescription) {
    el.stage1AiActionDescription.textContent = info.supported
      ? `Dùng ${info.model} đã lưu trong Cài đặt. Kết quả được kiểm tra trước khi đưa vào bộ chọn.`
      : info.reason;
  }
  if (el.runManualAntigravityStage1) {
    el.runManualAntigravityStage1.textContent = `Phân tích GĐ1 bằng ${info.label}`;
    el.runManualAntigravityStage1.disabled = state.busy || !info.supported || !el.manualGeminiPackPath?.value || !isManualGeminiProMode();
  }
  if (el.createAndRunStage1Ai) {
    const autoLevel = info.provider === "vertex_ai" ? (el.configuredAiAutoLevel?.value || "review") : "scripts";
    const actionLabel = autoLevel === "review"
      ? "Tạo draft và review V2"
      : autoLevel === "draft"
      ? "Tạo project và render draft"
      : "Tạo và kiểm tra kịch bản";
    el.createAndRunStage1Ai.textContent = `${actionLabel} bằng ${info.label}`;
    el.createAndRunStage1Ai.disabled = state.busy || !info.supported;
    el.createAndRunStage1Ai.title = info.supported ? "" : info.reason;
  }
  el.vertexAutoPipeline?.classList.toggle(
    "hidden",
    info.provider !== "vertex_ai" || !isManualGeminiProMode()
  );
  if (el.manualWorkflowAdvanced) {
    el.manualWorkflowAdvanced.open = info.provider !== "vertex_ai" || !isManualGeminiProMode();
  }
  if (el.runConfiguredDraftReview) {
    const draftArtifacts = getDraftReviewArtifacts();
    const activeVariant = state.currentProject?.mode === "highlight_cut" ? getActiveHighlightVariant(state.currentProject) : null;
    const packageIsCurrent = Boolean(draftArtifacts.reviewPackagePath)
      && draftArtifacts.reviewRevision === Math.max(1, Number(activeVariant?.revisionNumber || 1));
    el.runConfiguredDraftReview.textContent = packageIsCurrent
      ? `Review bằng ${info.label}`
      : `Tạo gói và review bằng ${info.label}`;
    el.runConfiguredDraftReview.disabled = state.busy || !info.supported;
    el.runConfiguredDraftReview.title = info.supported ? "" : info.reason;
  }
}

function addLog(message, level = "INFO") {
  window.previewLog?.append(message, level);
  const line = `[${level}] ${message}`;
  const lastLine = state.logLines[state.logLines.length - 1];
  if (lastLine === line) {
    return;
  }
  state.logLines.push(line);
  state.logLines = state.logLines.slice(-260);
  const logContent = state.logLines.join("\n");
  if (el.systemLog) {
    el.systemLog.textContent = logContent;
    el.systemLog.scrollTop = el.systemLog.scrollHeight;
  }
  if (el.studioSystemLog) {
    el.studioSystemLog.textContent = logContent;
    el.studioSystemLog.scrollTop = el.studioSystemLog.scrollHeight;
  }
  addActivity(message, level);
}

function activityIcon(level) {
  if (level === "ERROR") return "red";
  if (level === "WARNING" || /running|rendering|building|exporting|analyzing|transcribing|sync|qa/i.test(level)) return "yellow";
  return "green";
}

function addActivity(message, level = "INFO") {
  const normalized = String(message || "").replace(/^\w+:\s*/, "");
  const lastItem = state.activities[state.activities.length - 1];
  if (lastItem && lastItem.message === normalized && lastItem.level === level) {
    return;
  }
  const item = {
    id: Date.now() + Math.random(),
    level,
    status: level === "ERROR" ? "error" : /ing|running|render|export|analyz|transcrib|sync/i.test(normalized) ? "processing" : "success",
    message: normalized
  };
  state.activities.push(item);
  state.activities = state.activities.slice(-80);
  renderActivity();
}

function renderActivity() {
  const html = !state.activities.length
    ? `<div class="activity-empty">Hoạt động sẽ hiển thị ở đây khi bộ xử lý bắt đầu chạy.</div>`
    : state.activities.slice(-40).reverse().map((item) => `
    <div class="activity-item ${item.status}">
      <span class="activity-dot"></span>
      <p>${escapeHtml(item.message)}</p>
    </div>
  `).join("");

  if (el.activityFeed) el.activityFeed.innerHTML = html;
  if (el.studioActivityFeed) el.studioActivityFeed.innerHTML = html;
}

let exportProgressFadeTimer = null;

function setExportProgress(percent = 0, label = "Đang xuất") {
  const value = Math.max(0, Math.min(100, Number(percent || 0)));

  if (exportProgressFadeTimer) {
    clearTimeout(exportProgressFadeTimer);
    exportProgressFadeTimer = null;
  }

  if (value <= 0 && !state.busy) {
    el.exportProgress?.classList.add("hidden");
    el.exportProgress?.classList.remove("fade-out");
    return;
  }

  el.exportProgress?.classList.remove("hidden", "fade-out");
  if (el.exportProgressLabel) el.exportProgressLabel.textContent = label;
  if (el.exportProgressValue) el.exportProgressValue.textContent = `${Math.round(value)}%`;
  if (el.exportProgressBar) el.exportProgressBar.style.width = `${value}%`;

  if (value >= 100) {
    exportProgressFadeTimer = setTimeout(() => {
      el.exportProgress?.classList.add("fade-out");
      setTimeout(() => {
        el.exportProgress?.classList.add("hidden");
        el.exportProgress?.classList.remove("fade-out");
      }, 400);
    }, 2500);
  }
}

function readSetupDraft() {
  try {
    return JSON.parse(localStorage.getItem(setupDraftKey) || "{}");
  } catch (_error) {
    return {};
  }
}

function writeSetupDraft() {
  const persistedMode = state.selectedMode === "script_rewrite" ? "dubbing" : state.selectedMode;
  const draft = {
    projectTitle: el.projectTitle?.value || "",
    selectedMode: persistedMode,
    targetDuration: el.targetDuration?.value || "60",
    voiceSpeed: el.voiceSpeed?.value || "1.00",
    viralOptimization: el.viralOptimization?.checked ?? true,
    viralPlatform: el.viralPlatform?.value || "tiktok",
    viralAngleSetting: el.viralAngleSetting?.value || "auto",
    retentionAggressiveness: el.retentionAggressiveness?.value || "balanced",
    spoilerControl: el.spoilerControl?.value || "balanced",
    loopEnding: el.loopEnding?.checked ?? true,
    autoStoryTargetMin: el.autoStoryTargetMin?.value || "65",
    autoStoryTargetMax: el.autoStoryTargetMax?.value || "90",
    autoStoryOutputCount: el.autoStoryOutputCount?.value || "2",
    autoStoryNarrationStyle: el.autoStoryNarrationStyle?.value || "investigative",
    autoStoryAudioBalance: el.autoStoryAudioBalance?.value || "balanced",
    autoStoryEngineVersion: el.autoStoryEngineVersion?.value || "2",
    sourceVideoPath: el.sourceVideoPath?.value || "",
    sourceDownloadUrl: el.sourceDownloadUrl?.value || "",
    sourceKind: el.sourceVideoPath?.dataset.sourceKind || "",
    sourceOriginUrl: el.sourceVideoPath?.dataset.sourceOriginUrl || "",
    sourceMethod: document.querySelector("[data-source-method].active")?.dataset.sourceMethod || "local",
    subtitlePath: el.subtitlePath?.value || "",
    storyScriptPath: el.storyScriptPath?.value || "",
    storyScriptPaths: JSON.parse(el.storyScriptPath?.dataset.paths || "[]"),
    manualGeminiPackPath: el.manualGeminiPackPath?.value || "",
    manualGeminiStage1Root: el.openManualGeminiPack?.dataset.openPath || "",
    manualAntigravityStage1Root: el.openManualAntigravityResult?.dataset.openPath || "",
    manualGeminiEvidencePath: el.manualGeminiEvidencePath?.value || "",
    manualGeminiEvidenceStageRoot: el.openManualGeminiEvidenceFolder?.dataset.openPath || "",
    manualGeminiBlueprintPath: el.manualGeminiBlueprintPath?.value || "",
    manualGeminiBlueprintStageRoot: el.openManualGeminiBlueprintFolder?.dataset.openPath || "",
    manualGeminiVariantRoot: el.openManualGeminiVariants?.dataset.openPath || "",
    configuredAiAutoLevel: el.configuredAiAutoLevel?.value || "review",
    manualPromptProfile: el.manualPromptProfile?.value || "independent",
    manualIndependentHookPriority: readIndependentHookPriority(),
    manualIndependentScriptCount: el.manualIndependentScriptCount?.value || "2",
    manualIndependentHookMax: el.manualIndependentHookMax?.value || "30",
    manualIndependentNarratorTone: el.manualIndependentNarratorTone?.value || "profile_default",
    manualIndependentAudioBalance: el.manualIndependentAudioBalance?.value || "original_first",
    manualIndependentPacing: el.manualIndependentPacing?.value || "balanced",
    manualIndependentEnding: el.manualIndependentEnding?.value || "verified_payoff",
    manualIndependentScript1Min: el.manualIndependentScript1Min?.value || "60.5",
    manualIndependentScript1Max: el.manualIndependentScript1Max?.value || "120",
    manualIndependentScript2Min: el.manualIndependentScript2Min?.value || "60.5",
    manualIndependentScript2Max: el.manualIndependentScript2Max?.value || "150",
    manualIndependentScript3Min: el.manualIndependentScript3Min?.value || "90",
    manualIndependentScript3Max: el.manualIndependentScript3Max?.value || "240",
    manualIndependentScript4Min: el.manualIndependentScript4Min?.value || "60.5",
    manualIndependentScript4Max: el.manualIndependentScript4Max?.value || "120",
    manualIndependentScript5Min: el.manualIndependentScript5Min?.value || "60.5",
    manualIndependentScript5Max: el.manualIndependentScript5Max?.value || "150",
    manualIndependentOverlays: el.manualIndependentOverlays?.checked ?? true,
    manualIndependentPowerWords: el.manualIndependentPowerWords?.value || DEFAULT_INDEPENDENT_POWER_WORDS,
    manualSeriesSharedHook: el.manualSeriesSharedHook?.checked ?? true,
    manualSeriesInterleavedAudio: el.manualSeriesInterleavedAudio?.checked ?? true,
    manualSeriesNarratorStyle: el.manualSeriesNarratorStyle?.checked ?? true,
    manualSeriesCliffhanger: el.manualSeriesCliffhanger?.checked ?? true,
    manualSeriesOverlays: el.manualSeriesOverlays?.checked ?? true,
    manualSeriesDurationMin: el.manualSeriesDurationMin?.value || "75",
    manualSeriesDurationMax: el.manualSeriesDurationMax?.value || "110",
    manualSeriesPacing: el.manualSeriesPacing?.value || "strict_10",
    manualSeriesPowerWords: el.manualSeriesPowerWords?.value || DEFAULT_SERIES_POWER_WORDS,
    storyRecutRightsConfirmed: Boolean(el.storyRecutRightsConfirmed?.checked),
    diyStoryAngle: el.diyStoryAngle?.value || "gemini_auto_story",
    podcastYoutubeUrl: el.podcastYoutubeUrl?.value || "",
    podcastWorkflowMode: el.podcastWorkflowMode?.value || "quality_two_pass",
    podcastOutputCount: el.podcastOutputCount?.value || "3",
    podcastCleanupMode: el.podcastCleanupMode?.value || "balanced",
    podcastTargetMin: el.podcastTargetMin?.value || "45",
    podcastTargetMax: el.podcastTargetMax?.value || "60",
    trimStart: el.trimStart?.value || "",
    trimEnd: el.trimEnd?.value || "",
    visualRemix: Boolean(el.visualRemix?.checked),
    framePreset: "original",
    voiceGenderAge: el.voiceGenderAge?.value || "female",
    voicePitch: el.voicePitch?.value || "moderate",
    voiceAccent: el.voiceAccent?.value || "none",
    voiceTrait: el.voiceTrait?.value || "normal",
    voicePrompt: el.voicePrompt?.value || "",
    voiceTab: document.querySelector(".voice-tab.active")?.dataset.voiceTab || "designed",
    voiceSamplePath: el.voiceSamplePath?.value || "",
    presetVoiceProvider: el.presetVoiceProvider?.value || "edge_neural",
    presetVoiceId: el.presetVoiceList?.value || "",
    draftVoiceMode: el.draftVoiceMode?.value || "edge_neural",
    draftVoiceProvider: el.draftVoiceProvider?.value || "edge_neural",
    draftVoiceId: el.draftVoiceList?.value || el.draftVoiceId?.value || "",
    lastVoiceSetup: getVoiceSetupState(),
    autoWhisper: Boolean(el.autoWhisper?.checked),
    sourceLanguage: el.sourceLanguage?.value || "auto",
    targetLanguage: el.targetLanguage?.value || "vi",
    recapWorkflowMode: el.recapWorkflowMode?.value || "full_auto",
    recapVisualLead: el.recapVisualLead?.value || "0.25",
    recapAllowReuse: Boolean(el.recapAllowReuse?.checked)
  };
  localStorage.setItem(setupDraftKey, JSON.stringify(draft));
}

function applySetupDraft(draft = readSetupDraft()) {
  if (!draft || !Object.keys(draft).length) return;
  if (draft.projectTitle && el.projectTitle) el.projectTitle.value = draft.projectTitle;
  if (draft.selectedMode) {
    state.selectedMode = draft.selectedMode === "script_rewrite" ? "dubbing" : draft.selectedMode;
  }
  if (draft.recapWorkflowMode && el.recapWorkflowMode) el.recapWorkflowMode.value = draft.recapWorkflowMode;
  if (draft.recapVisualLead && el.recapVisualLead) el.recapVisualLead.value = draft.recapVisualLead;
  if (typeof draft.recapAllowReuse === "boolean" && el.recapAllowReuse) el.recapAllowReuse.checked = draft.recapAllowReuse;
  selectSetupMode(state.selectedMode, { persist: false, invalidate: false });
  if (draft.targetDuration && el.targetDuration) el.targetDuration.value = draft.targetDuration;
  if (draft.voiceSpeed && el.voiceSpeed) el.voiceSpeed.value = draft.voiceSpeed;
  if (typeof draft.viralOptimization === "boolean" && el.viralOptimization) el.viralOptimization.checked = draft.viralOptimization;
  if (draft.viralPlatform && el.viralPlatform) el.viralPlatform.value = draft.viralPlatform;
  if (draft.viralAngleSetting && el.viralAngleSetting) el.viralAngleSetting.value = draft.viralAngleSetting;
  if (draft.retentionAggressiveness && el.retentionAggressiveness) el.retentionAggressiveness.value = draft.retentionAggressiveness;
  if (draft.spoilerControl && el.spoilerControl) el.spoilerControl.value = draft.spoilerControl;
  if (typeof draft.loopEnding === "boolean" && el.loopEnding) el.loopEnding.checked = draft.loopEnding;
  if (el.autoStoryTargetMin) el.autoStoryTargetMin.value = String(Math.max(65, Number(draft.autoStoryTargetMin || 65)));
  if (el.autoStoryTargetMax) el.autoStoryTargetMax.value = String(Math.max(Number(el.autoStoryTargetMin?.value || 65), Number(draft.autoStoryTargetMax || 90)));
  if (el.autoStoryOutputCount) el.autoStoryOutputCount.value = draft.autoStoryOutputCount || "2";
  if (el.autoStoryNarrationStyle) el.autoStoryNarrationStyle.value = draft.autoStoryNarrationStyle || "investigative";
  if (el.autoStoryAudioBalance) el.autoStoryAudioBalance.value = draft.autoStoryAudioBalance || "balanced";
  if (el.autoStoryEngineVersion) { el.autoStoryEngineVersion.value = draft.autoStoryEngineVersion || "2"; updateAutoStoryEngineHint(); }
  if (draft.sourceVideoPath && el.sourceVideoPath) el.sourceVideoPath.value = draft.sourceVideoPath;
  if (draft.sourceDownloadUrl && el.sourceDownloadUrl) el.sourceDownloadUrl.value = draft.sourceDownloadUrl;
  if (el.sourceVideoPath) {
    const restoredSourceKind = draft.sourceKind
      || (draft.sourceVideoPath && draft.sourceDownloadUrl ? "url" : draft.sourceVideoPath ? "local" : "");
    el.sourceVideoPath.dataset.sourceKind = restoredSourceKind;
    el.sourceVideoPath.dataset.sourceOriginUrl = draft.sourceOriginUrl
      || (restoredSourceKind === "url" ? draft.sourceDownloadUrl || "" : "");
  }
  setSourceMethod(draft.sourceMethod || draft.sourceKind || "local", { persist: false });
  if (Object.prototype.hasOwnProperty.call(draft, "subtitlePath") && el.subtitlePath) el.subtitlePath.value = draft.subtitlePath || "";
  updateSourceSelectionUi();
  if (draft.storyScriptPath && el.storyScriptPath) el.storyScriptPath.value = draft.storyScriptPath;
  if (Array.isArray(draft.storyScriptPaths) && draft.storyScriptPaths.length && el.storyScriptPath) {
    el.storyScriptPath.dataset.paths = JSON.stringify(draft.storyScriptPaths);
    el.storyScriptPath.value = draft.storyScriptPaths.length > 1
      ? `Đã chọn ${draft.storyScriptPaths.length} file JSON`
      : draft.storyScriptPaths[0];
  }
  if (draft.manualGeminiPackPath && el.manualGeminiPackPath) {
    el.manualGeminiPackPath.value = draft.manualGeminiPackPath;
    if (el.manualGeminiPackStatus) {
      el.manualGeminiPackStatus.textContent = `Gói gần nhất: ${draft.manualGeminiPackPath}`;
    }
    if (el.openManualGeminiPack) el.openManualGeminiPack.disabled = false;
    if (el.importManualGeminiEvidence) el.importManualGeminiEvidence.disabled = false;
  }
  if (el.openManualGeminiPack && (draft.manualGeminiStage1Root || draft.manualGeminiPackPath)) {
    el.openManualGeminiPack.dataset.openPath = draft.manualGeminiStage1Root || draft.manualGeminiPackPath;
    el.openManualGeminiPack.disabled = false;
  }
  if (draft.manualGeminiPackPath && el.runManualAntigravityStage1) {
    el.runManualAntigravityStage1.disabled = !isManualGeminiProMode();
  }
  if (draft.manualAntigravityStage1Root && el.openManualAntigravityResult) {
    setManualStageFolder(el.openManualAntigravityResult, draft.manualAntigravityStage1Root, "Mở kết quả Antigravity");
    el.openManualAntigravityResult.classList.remove("hidden");
    if (el.manualAntigravityStage1Status) {
      el.manualAntigravityStage1Status.textContent = `Kết quả gần nhất: ${draft.manualAntigravityStage1Root}`;
    }
  }
  if (draft.manualGeminiEvidencePath && el.manualGeminiEvidencePath) {
    el.manualGeminiEvidencePath.value = draft.manualGeminiEvidencePath;
    if (el.manualGeminiEvidenceStatus) {
      el.manualGeminiEvidenceStatus.textContent = `Evidence đã kiểm tra: ${draft.manualGeminiEvidencePath}`;
    }
  }
  if (el.openManualGeminiEvidenceFolder && draft.manualGeminiEvidenceStageRoot) {
    el.openManualGeminiEvidenceFolder.dataset.openPath = draft.manualGeminiEvidenceStageRoot;
    el.openManualGeminiEvidenceFolder.disabled = false;
  }
  if (draft.manualGeminiBlueprintPath && el.manualGeminiBlueprintPath) {
    el.manualGeminiBlueprintPath.value = draft.manualGeminiBlueprintPath;
    if (el.manualGeminiBlueprintStatus) {
      el.manualGeminiBlueprintStatus.textContent = `Blueprint đã khóa: ${draft.manualGeminiBlueprintPath}`;
    }
    if (el.importManualGeminiBlueprint) el.importManualGeminiBlueprint.disabled = false;
  }
  if (el.openManualGeminiBlueprintFolder && draft.manualGeminiBlueprintStageRoot) {
    el.openManualGeminiBlueprintFolder.dataset.openPath = draft.manualGeminiBlueprintStageRoot;
    el.openManualGeminiBlueprintFolder.disabled = false;
  }
  if (draft.manualGeminiVariantRoot && el.openManualGeminiVariants) {
    el.openManualGeminiVariants.dataset.openPath = draft.manualGeminiVariantRoot;
    el.openManualGeminiVariants.disabled = false;
    if (el.manualGeminiVariantStatus) {
      el.manualGeminiVariantStatus.textContent = `Prompt variant đã sẵn sàng: ${draft.manualGeminiVariantRoot}`;
    }
  }
  if (el.configuredAiAutoLevel) el.configuredAiAutoLevel.value = draft.configuredAiAutoLevel || "review";
  if (draft.diyStoryAngle && el.diyStoryAngle) el.diyStoryAngle.value = draft.diyStoryAngle;
  if (el.manualPromptProfile) el.manualPromptProfile.value = draft.manualPromptProfile || "independent";
  setIndependentHookPriority(draft.manualIndependentHookPriority || DEFAULT_INDEPENDENT_HOOK_PRIORITY);
  if (el.manualIndependentScriptCount) el.manualIndependentScriptCount.value = draft.manualIndependentScriptCount || "2";
  if (el.manualIndependentHookMax) el.manualIndependentHookMax.value = draft.manualIndependentHookMax || "30";
  if (el.manualIndependentNarratorTone) el.manualIndependentNarratorTone.value = draft.manualIndependentNarratorTone || "profile_default";
  if (el.manualIndependentAudioBalance) el.manualIndependentAudioBalance.value = draft.manualIndependentAudioBalance || "original_first";
  if (el.manualIndependentPacing) el.manualIndependentPacing.value = draft.manualIndependentPacing || "balanced";
  if (el.manualIndependentEnding) el.manualIndependentEnding.value = draft.manualIndependentEnding || "verified_payoff";
  if (el.manualIndependentScript1Min) el.manualIndependentScript1Min.value = draft.manualIndependentScript1Min || "60.5";
  if (el.manualIndependentScript1Max) el.manualIndependentScript1Max.value = draft.manualIndependentScript1Max || "120";
  if (el.manualIndependentScript2Min) el.manualIndependentScript2Min.value = draft.manualIndependentScript2Min || "60.5";
  if (el.manualIndependentScript2Max) el.manualIndependentScript2Max.value = draft.manualIndependentScript2Max || "150";
  if (el.manualIndependentScript3Min) el.manualIndependentScript3Min.value = draft.manualIndependentScript3Min || "90";
  if (el.manualIndependentScript3Max) el.manualIndependentScript3Max.value = draft.manualIndependentScript3Max || "240";
  if (el.manualIndependentScript4Min) el.manualIndependentScript4Min.value = draft.manualIndependentScript4Min || "60.5";
  if (el.manualIndependentScript4Max) el.manualIndependentScript4Max.value = draft.manualIndependentScript4Max || "120";
  if (el.manualIndependentScript5Min) el.manualIndependentScript5Min.value = draft.manualIndependentScript5Min || "60.5";
  if (el.manualIndependentScript5Max) el.manualIndependentScript5Max.value = draft.manualIndependentScript5Max || "150";
  if (el.manualIndependentOverlays) el.manualIndependentOverlays.checked = draft.manualIndependentOverlays !== false;
  if (el.manualIndependentPowerWords) el.manualIndependentPowerWords.value = draft.manualIndependentPowerWords || DEFAULT_INDEPENDENT_POWER_WORDS;
  if (el.manualSeriesSharedHook) el.manualSeriesSharedHook.checked = draft.manualSeriesSharedHook !== false;
  if (el.manualSeriesInterleavedAudio) el.manualSeriesInterleavedAudio.checked = draft.manualSeriesInterleavedAudio !== false;
  if (el.manualSeriesNarratorStyle) el.manualSeriesNarratorStyle.checked = draft.manualSeriesNarratorStyle !== false;
  if (el.manualSeriesCliffhanger) el.manualSeriesCliffhanger.checked = draft.manualSeriesCliffhanger !== false;
  if (el.manualSeriesOverlays) el.manualSeriesOverlays.checked = draft.manualSeriesOverlays !== false;
  if (el.manualSeriesDurationMin) el.manualSeriesDurationMin.value = draft.manualSeriesDurationMin || "75";
  if (el.manualSeriesDurationMax) el.manualSeriesDurationMax.value = draft.manualSeriesDurationMax || "110";
  if (el.manualSeriesPacing) el.manualSeriesPacing.value = draft.manualSeriesPacing || "strict_10";
  if (el.manualSeriesPowerWords) el.manualSeriesPowerWords.value = draft.manualSeriesPowerWords || DEFAULT_SERIES_POWER_WORDS;
  if (el.storyRecutRightsConfirmed) {
    el.storyRecutRightsConfirmed.checked = Boolean(draft.storyRecutRightsConfirmed);
  }
  if (el.podcastYoutubeUrl) el.podcastYoutubeUrl.value = draft.podcastYoutubeUrl || "";
  if (el.podcastWorkflowMode) el.podcastWorkflowMode.value = draft.podcastWorkflowMode || "quality_two_pass";
  if (el.podcastOutputCount) el.podcastOutputCount.value = draft.podcastOutputCount || "3";
  if (el.podcastCleanupMode) el.podcastCleanupMode.value = draft.podcastCleanupMode || "balanced";
  if (el.podcastTargetMin) el.podcastTargetMin.value = draft.podcastTargetMin || "45";
  if (el.podcastTargetMax) el.podcastTargetMax.value = draft.podcastTargetMax || "60";
  el.trimStart.value = draft.trimStart || "";
  el.trimEnd.value = draft.trimEnd || "";
  el.visualRemix.checked = Boolean(draft.visualRemix);
  if (el.framePreset) el.framePreset.value = "original";
  applyVoiceSetupState(draft.lastVoiceSetup || {
    tab: draft.voiceTab,
    genderAge: draft.voiceGenderAge,
    pitch: draft.voicePitch,
    accent: draft.voiceAccent,
    trait: draft.voiceTrait,
    prompt: draft.voicePrompt,
    samplePath: draft.voiceSamplePath,
    presetProvider: draft.presetVoiceProvider,
    presetVoiceId: draft.presetVoiceId
  });
  if (el.draftVoiceMode) el.draftVoiceMode.value = draft.draftVoiceMode || "edge_neural";
  if (el.draftVoiceProvider) el.draftVoiceProvider.value = draft.draftVoiceProvider || "edge_neural";
  if (el.draftVoiceId) el.draftVoiceId.value = draft.draftVoiceId || "";
  if (el.draftVoiceList && draft.draftVoiceId) el.draftVoiceList.dataset.preferredVoiceId = draft.draftVoiceId;
  el.autoWhisper.checked = draft.autoWhisper !== false;
  if (draft.sourceLanguage) el.sourceLanguage.value = draft.sourceLanguage;
  if (draft.targetLanguage) el.targetLanguage.value = draft.targetLanguage;
  syncManualGeminiPromptOptionsUi({ rerenderPrompt: false });
  renderSteps();
}

function resetSetupStep(step) {
  if (step === 1) {
    el.projectTitle.value = "project_default";
  } else if (step === 2) {
    state.selectedMode = "recap";
    el.targetDuration.value = "60";
    el.voiceSpeed.value = "1.00";
    el.viralOptimization.checked = true;
    el.viralPlatform.value = "tiktok";
    el.viralAngleSetting.value = "auto";
    el.retentionAggressiveness.value = "balanced";
    el.spoilerControl.value = "balanced";
    el.loopEnding.checked = true;
    if (el.manualPromptProfile) el.manualPromptProfile.value = "independent";
    setIndependentHookPriority(DEFAULT_INDEPENDENT_HOOK_PRIORITY);
    if (el.manualIndependentScriptCount) el.manualIndependentScriptCount.value = "2";
      if (el.manualIndependentHookMax) el.manualIndependentHookMax.value = "10";
      if (el.manualIndependentNarratorTone) el.manualIndependentNarratorTone.value = "profile_default";
      if (el.manualIndependentAudioBalance) el.manualIndependentAudioBalance.value = "narrator_led";
      if (el.manualIndependentPacing) el.manualIndependentPacing.value = "fast";
    if (el.manualIndependentEnding) el.manualIndependentEnding.value = "verified_payoff";
    if (el.manualIndependentScript1Min) el.manualIndependentScript1Min.value = "60.5";
    if (el.manualIndependentScript1Max) el.manualIndependentScript1Max.value = "120";
    if (el.manualIndependentScript2Min) el.manualIndependentScript2Min.value = "60.5";
    if (el.manualIndependentScript2Max) el.manualIndependentScript2Max.value = "150";
    if (el.manualIndependentScript3Min) el.manualIndependentScript3Min.value = "90";
    if (el.manualIndependentScript3Max) el.manualIndependentScript3Max.value = "240";
    if (el.manualIndependentScript4Min) el.manualIndependentScript4Min.value = "60.5";
    if (el.manualIndependentScript4Max) el.manualIndependentScript4Max.value = "120";
    if (el.manualIndependentScript5Min) el.manualIndependentScript5Min.value = "60.5";
    if (el.manualIndependentScript5Max) el.manualIndependentScript5Max.value = "150";
    if (el.manualIndependentOverlays) el.manualIndependentOverlays.checked = true;
    if (el.manualIndependentPowerWords) el.manualIndependentPowerWords.value = DEFAULT_INDEPENDENT_POWER_WORDS;
    if (el.manualSeriesSharedHook) el.manualSeriesSharedHook.checked = true;
    if (el.manualSeriesInterleavedAudio) el.manualSeriesInterleavedAudio.checked = true;
    if (el.manualSeriesNarratorStyle) el.manualSeriesNarratorStyle.checked = true;
    if (el.manualSeriesCliffhanger) el.manualSeriesCliffhanger.checked = true;
    if (el.manualSeriesOverlays) el.manualSeriesOverlays.checked = true;
    if (el.manualSeriesDurationMin) el.manualSeriesDurationMin.value = "75";
    if (el.manualSeriesDurationMax) el.manualSeriesDurationMax.value = "110";
    if (el.manualSeriesPacing) el.manualSeriesPacing.value = "strict_10";
    if (el.manualSeriesPowerWords) el.manualSeriesPowerWords.value = DEFAULT_SERIES_POWER_WORDS;
    syncManualGeminiPromptOptionsUi({ rerenderPrompt: false });
    document.querySelectorAll("[data-mode]").forEach((node) => node.classList.toggle("active", node.dataset.mode === "dubbing"));
  } else if (step === 3) {
    el.voiceGenderAge.value = "female";
    el.voicePitch.value = "moderate";
    el.voiceAccent.value = "none";
    el.voiceTrait.value = "normal";
    el.voicePrompt.value = "female, moderate pitch";
    el.voiceSamplePath.value = "";
    el.presetVoiceProvider.value = "edge_neural";
    el.presetVoiceList.innerHTML = "";
  } else if (step === 4) {
    el.sourceVideoPath.value = "";
    delete el.sourceVideoPath.dataset.sourceKind;
    delete el.sourceVideoPath.dataset.sourceOriginUrl;
    if (el.sourceDownloadUrl) el.sourceDownloadUrl.value = "";
    setSourceMethod("local", { persist: false });
    updateSourceSelectionUi();
    el.subtitlePath.value = "";
    if (el.storyScriptPath) el.storyScriptPath.value = "";
    if (el.storyScriptPath) el.storyScriptPath.dataset.paths = "[]";
    if (el.manualGeminiPackPath) el.manualGeminiPackPath.value = "";
    if (el.manualGeminiPackStatus) {
      const analysisRoot = state.settings?.geminiAnalysisRoot || "thư mục đã cấu hình";
      el.manualGeminiPackStatus.textContent = `Chưa tạo gói. Tool sẽ tự lưu tại: ${analysisRoot}`;
    }
    if (el.openManualGeminiPack) el.openManualGeminiPack.disabled = true;
    if (el.runManualAntigravityStage1) el.runManualAntigravityStage1.disabled = true;
    if (el.cancelManualAntigravityStage1) el.cancelManualAntigravityStage1.classList.add("hidden");
    if (el.openManualAntigravityResult) {
      setManualStageFolder(el.openManualAntigravityResult, "", "Mở kết quả AI");
      el.openManualAntigravityResult.classList.add("hidden");
    }
    if (el.manualAntigravityStage1Status) {
      el.manualAntigravityStage1Status.textContent = "Hãy tạo gói GĐ1 trước. Kết quả AI được lưu riêng và không sửa thư mục gửi Gemini.";
    }
    [el.openManualGeminiPack, el.openManualGeminiEvidenceFolder, el.openManualGeminiBlueprintFolder].forEach((button) => {
      if (!button) return;
      button.disabled = true;
      delete button.dataset.openPath;
    });
    if (el.importManualGeminiEvidence) el.importManualGeminiEvidence.disabled = true;
    if (el.manualGeminiEvidencePath) el.manualGeminiEvidencePath.value = "";
    if (el.manualGeminiEvidenceStatus) el.manualGeminiEvidenceStatus.textContent = "Chưa có scene evidence đã được kiểm tra.";
    if (el.importManualGeminiBlueprint) el.importManualGeminiBlueprint.disabled = true;
    if (el.manualGeminiBlueprintPath) el.manualGeminiBlueprintPath.value = "";
    if (el.manualGeminiBlueprintStatus) el.manualGeminiBlueprintStatus.textContent = "Chưa có story blueprint đã được kiểm tra.";
    if (el.openManualGeminiVariants) {
      el.openManualGeminiVariants.disabled = true;
      delete el.openManualGeminiVariants.dataset.openPath;
    }
    if (el.manualGeminiVariantStatus) el.manualGeminiVariantStatus.textContent = "Chưa tạo prompt variant.";
    if (el.storyRecutRightsConfirmed) el.storyRecutRightsConfirmed.checked = false;
    if (el.podcastYoutubeUrl) el.podcastYoutubeUrl.value = "";
    el.trimStart.value = "";
    el.trimEnd.value = "";
    el.visualRemix.checked = false;
    el.framePreset.value = "original";
  } else if (step === 5) {
    el.autoWhisper.checked = true;
    el.sourceLanguage.value = "auto";
    el.targetLanguage.value = "vi";
  }
}

function setBusy(isBusy) {
  state.busy = isBusy;
  renderAutoStoryStatus();
  document.body.classList.toggle("busy", isBusy);
  if (!isBusy) {
    setExportProgress(0, state.activeOperation || "Sẵn sàng");
    el.exportProgress?.classList.add("hidden");
    state.activeOperation = "";
  }
  [
    el.prevStep,
    el.nextStep,
    el.startIngest,
    el.openOutputFolder,
    el.translateButton,
    el.diarizeButton,
    el.renderVideo,
    el.renderHighlightVariants,
    el.previewDraft,
    el.renderFastDraft,
    el.runAutoReviewCurrent,
    el.runAutoReviewAll,
    $("resume-auto-story"),
    el.renderAllFastDrafts,
    el.createGeminiDraftReview,
    el.openGeminiDraftReview,
    el.openDraftReviewPrompt,
    el.openDraftReviewReport,
    el.importReviewedScript,
    el.saveSegment,
    el.previewSegmentVoice,
    el.previewSegmentVideo,
    el.reviewSceneScript,
    el.reviewAllScenes,
    el.reviewAllScenesLeft,
    el.rewriteFailedScenes,
    el.applyAllRewrites,
    el.applySceneRewrite,
    el.mirrorPickVideo,
    el.mirrorRun,
    el.calibrateVoiceSpeed,
    el.calibrateDraftVoiceSpeed,
    el.previewDraftVoice,
    el.refreshDraftVoices,
    el.copyVoiceBudgetPrompt,
    el.copyDraftVoiceBudgetPrompt,
    el.createManualGeminiPack,
    el.createAndRunStage1Ai,
    el.runManualAntigravityStage1,
    el.openManualAntigravityResult,
    el.importManualGeminiEvidence,
    el.importManualGeminiBlueprint,
    el.openManualGeminiPack,
    el.openManualGeminiEvidenceFolder,
    el.openManualGeminiBlueprintFolder,
    el.openManualGeminiVariants,
    el.runConfiguredDraftReview,
    el.openConfiguredDraftReviewResult,
    el.importConfiguredDraftReview
  ].forEach((button) => {
    if (button) button.disabled = isBusy;
  });
  if (!isBusy && el.copyVoiceBudgetPrompt && !state.voiceCalibration?.promptSnippet) {
    el.copyVoiceBudgetPrompt.disabled = true;
  }
  syncConfiguredAiWorkflowUi();
  if (!isBusy && el.importManualGeminiEvidence) {
    el.importManualGeminiEvidence.disabled = !el.manualGeminiPackPath?.value
      || isManualGeminiProMode()
      || (isPodcastViralMode() && !isPodcastTwoPassMode());
  }
  if (!isBusy && el.importManualGeminiBlueprint) {
    el.importManualGeminiBlueprint.disabled = !el.manualGeminiEvidencePath?.value || isStoryRecutMode();
  }
  if (!isBusy && el.openManualGeminiVariants) {
    el.openManualGeminiVariants.disabled = !el.openManualGeminiVariants.dataset.openPath;
  }
  if (!isBusy && el.runManualAntigravityStage1) {
    el.runManualAntigravityStage1.disabled = !isManualGeminiProMode() || !el.manualGeminiPackPath?.value;
  }
  if (!isBusy && el.openManualAntigravityResult) {
    el.openManualAntigravityResult.disabled = !el.openManualAntigravityResult.dataset.openPath;
  }
  if (!isBusy) {
    [el.openManualGeminiPack, el.openManualGeminiEvidenceFolder, el.openManualGeminiBlueprintFolder].forEach((button) => {
      if (button) button.disabled = !button.dataset.openPath;
    });
  }
  if (!isBusy && el.cancelRender) {
    el.cancelRender.classList.add("hidden");
    el.cancelRender.disabled = false;
  }
}

function getVariantExportStatusLabel(status = "waiting") {
  return {
    waiting: "Waiting",
    processing: "Processing",
    done: "Done",
    failed: "Failed"
  }[status] || "Waiting";
}

function renderVariantExportQueue() {
  if (!el.variantExportStatuses) return;
  // Hàng danh sách variant ở header phía trên là thừa;
  // Trạng thái processing được hiển thị trực tiếp và sống động bên trong từng card của DANH SÁCH VARIANTS.
  el.variantExportStatuses.classList.add("hidden");
  el.variantExportStatuses.innerHTML = "";
}

function setVariantExportQueue(items = []) {
  state.variantExportQueue = Array.isArray(items) ? items.map((item) => ({ ...item })) : [];
  renderVariantExportQueue();
  renderHighlightVariantBar();
  if (state.currentProject && !el.studioView?.classList.contains("hidden")) {
    renderStudioVariantHub(state.currentProject);
  }
}

function setRenderCancellable(isCancellable) {
  if (!el.cancelRender) return;
  el.cancelRender.classList.toggle("hidden", !isCancellable);
  el.cancelRender.disabled = !isCancellable;
}

function showToast(message) {
  const container = $("toast-container");
  if (!container) {
    window.alert(message);
    return;
  }
  const item = document.createElement("div");
  item.className = "toast-item";
  item.textContent = message;
  container.append(item);
  window.setTimeout(() => {
    item.style.opacity = "0";
    item.style.transform = "translateY(-10px)";
    window.setTimeout(() => item.remove(), 300);
  }, 3200);
}

function normalizeProjectFolderName(value) {
  return String(value || "project_default")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    || "project_default";
}

function confirmProjectFolder() {
  const folderName = normalizeProjectFolderName(el.projectTitle.value);
  el.projectTitle.value = folderName;
  writeSetupDraft();
  updateReview();
  addLog(`Đã chuyển dự án sang folder "${folderName}"`);
  showToast(`Đã chuyển dự án sang folder "${folderName}"`);
}

function setVoiceTab(tabName = "designed") {
  document.querySelectorAll(".voice-tab").forEach((node) => node.classList.toggle("active", node.dataset.voiceTab === tabName));
  document.querySelectorAll("[data-voice-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.voicePanel !== tabName);
  });
  syncSelectedVoiceTuningVisibility();
  renderHighlightPromptTemplate();
  syncHeroVoiceCard();
}

function closeConfirmAction(result = false) {
  if (!confirmActionResolver) return;
  const resolve = confirmActionResolver;
  confirmActionResolver = null;
  el.confirmActionModal?.classList.add("hidden");
  const previousFocus = confirmActionPreviousFocus;
  confirmActionPreviousFocus = null;
  previousFocus?.focus?.();
  resolve(Boolean(result));
}

function showConfirmAction({
  title = "Xác nhận thao tác",
  message = "Bạn có chắc muốn tiếp tục?",
  confirmLabel = "Xác nhận",
  cancelLabel = "Hủy"
} = {}) {
  if (!el.confirmActionModal) {
    return Promise.resolve(false);
  }
  if (confirmActionResolver) {
    closeConfirmAction(false);
  }
  el.confirmActionTitle.textContent = title;
  el.confirmActionMessage.textContent = message;
  el.submitConfirmAction.textContent = confirmLabel;
  el.cancelConfirmAction.textContent = cancelLabel;
  confirmActionPreviousFocus = document.activeElement;
  el.confirmActionModal.classList.remove("hidden");
  requestAnimationFrame(() => el.submitConfirmAction?.focus());
  return new Promise((resolve) => {
    confirmActionResolver = resolve;
  });
}

function getVoiceSetupState() {
  return {
    tab: document.querySelector(".voice-tab.active")?.dataset.voiceTab || "designed",
    genderAge: el.voiceGenderAge?.value || "female",
    pitch: el.voicePitch?.value || "moderate",
    accent: el.voiceAccent?.value || "none",
    trait: el.voiceTrait?.value || "normal",
    prompt: el.voicePrompt?.value || "",
    samplePath: el.voiceSamplePath?.value || "",
    presetProvider: el.presetVoiceProvider?.value || "edge_neural",
    presetVoiceId: el.presetVoiceList?.value
      || el.presetVoiceList?.dataset.preferredVoiceId
      || state.settings?.lastVoiceSetup?.presetVoiceId
      || ""
  };
}

function applyVoiceSetupState(voiceSetup = {}) {
  if (!voiceSetup || !Object.keys(voiceSetup).length) return;
  if (voiceSetup.tab) setVoiceTab(voiceSetup.tab);
  if (voiceSetup.genderAge) el.voiceGenderAge.value = voiceSetup.genderAge;
  if (voiceSetup.pitch) el.voicePitch.value = voiceSetup.pitch;
  if (voiceSetup.accent) el.voiceAccent.value = voiceSetup.accent;
  if (voiceSetup.trait) el.voiceTrait.value = voiceSetup.trait;
  if (voiceSetup.prompt) el.voicePrompt.value = voiceSetup.prompt;
  if (Object.prototype.hasOwnProperty.call(voiceSetup, "samplePath")) el.voiceSamplePath.value = voiceSetup.samplePath || "";
  if (voiceSetup.presetProvider) el.presetVoiceProvider.value = voiceSetup.presetProvider;
  if (voiceSetup.presetVoiceId) {
    el.presetVoiceList.dataset.preferredVoiceId = voiceSetup.presetVoiceId;
    if ([...el.presetVoiceList.options].some((option) => option.value === voiceSetup.presetVoiceId)) {
      el.presetVoiceList.value = voiceSetup.presetVoiceId;
    }
  }
  syncSelectedVoiceTuningVisibility();
}

function rememberVoiceSetupSoon() {
  writeSetupDraft();
  clearTimeout(voiceSetupSaveTimer);
  voiceSetupSaveTimer = setTimeout(async () => {
    if (!state.settings) return;
    try {
      const saved = await window.cineviral.saveSettings({
        ...readSettings(),
        lastVoiceSetup: getVoiceSetupState()
      });
      state.settings = saved.settings;
    } catch (error) {
      addLog(`Không lưu được cấu hình giọng gần nhất: ${error.message}`, "WARNING");
    }
  }, 500);
}

function getSelectedVoiceConfig() {
  const tab = document.querySelector(".voice-tab.active")?.dataset.voiceTab || "designed";
  if (tab === "clone" && el.voiceSamplePath.value.trim()) {
    return {
      voiceProvider: "omnivoice",
      voiceId: el.voiceSamplePath.value.trim(),
      cloneSourceVoice: true
    };
  }
  if (tab === "preset" && el.presetVoiceList.value) {
    return {
      voiceProvider: el.presetVoiceProvider.value || "edge_neural",
      voiceId: el.presetVoiceList.value,
      cloneSourceVoice: false
    };
  }
  return {
    voiceProvider: "omnivoice",
    voiceId: el.voicePrompt.value.trim(),
    cloneSourceVoice: false
  };
}

function getDraftVoiceConfig() {
  const mode = el.draftVoiceMode?.value || "edge_neural";
  if (mode === "final") {
    const selected = getSelectedVoiceConfig();
    return {
      draftVoiceMode: "final",
      draftVoiceProvider: selected.voiceProvider,
      draftVoiceId: selected.voiceId,
      draftCloneSourceVoice: selected.cloneSourceVoice
    };
  }
  const provider = el.draftVoiceProvider?.value || "edge_neural";
  let selectedDraftVoiceId = el.draftVoiceList?.value || el.draftVoiceId?.value.trim() || "";
  if (provider === "kokoro" && selectedDraftVoiceId && !/^[ab][fm]_[a-z0-9_]+$/i.test(selectedDraftVoiceId)) {
    selectedDraftVoiceId = "";
  }
  if (provider === "edge_neural" && selectedDraftVoiceId && !/Neural$/i.test(selectedDraftVoiceId)) {
    selectedDraftVoiceId = "";
  }
  if (mode === "custom" || selectedDraftVoiceId || provider !== "edge_neural") {
    return {
      draftVoiceMode: "custom",
      draftVoiceProvider: provider,
      draftVoiceId: selectedDraftVoiceId,
      draftCloneSourceVoice: false
    };
  }
  return {
    draftVoiceMode: "edge_neural",
    draftVoiceProvider: "edge_neural",
    draftVoiceId: "",
    draftCloneSourceVoice: false
  };
}

function getVoiceCalibrationPayload() {
  const selectedVoice = getSelectedVoiceConfig();
  const prompt = [
    el.voiceGenderAge.value,
    `${el.voicePitch.value} pitch`,
    el.voiceTrait.value
  ].filter(Boolean).join(", ");
  const mode = getNarrationModeForVoice();
  const requestedLanguage = getNarrationLanguageForVoice();
  const language = selectedVoice.voiceProvider === "kokoro" && /^vi\b/i.test(requestedLanguage)
    ? "en"
    : requestedLanguage;
  const isHighlightNarration = mode === "highlight_cut";
  const renderStyle = state.currentProject?.genreMode || "thriller";
  return {
    mode,
    voiceProvider: selectedVoice.voiceProvider,
    voiceId: selectedVoice.voiceId,
    cloneSourceVoice: selectedVoice.cloneSourceVoice,
    language,
    targetLanguage: language,
    narrationLanguage: language,
    style: renderStyle,
    genreMode: renderStyle,
    voiceDesign: {
      tab: document.querySelector(".voice-tab.active")?.dataset.voiceTab || "designed",
      genderAge: el.voiceGenderAge.value,
      pitch: el.voicePitch.value,
      accent: el.voiceAccent.value,
      trait: el.voiceTrait.value,
      prompt: el.voicePrompt.value.trim() || prompt,
      samplePath: el.voiceSamplePath.value.trim(),
      presetProvider: el.presetVoiceProvider.value,
      presetVoiceId: el.presetVoiceList.value
    }
  };
}

function getDraftVoiceCalibrationPayload() {
  const selectedVoice = getDraftVoiceConfig();
  const mode = getNarrationModeForVoice();
  const requestedLanguage = getNarrationLanguageForVoice();
  const language = selectedVoice.draftVoiceProvider === "kokoro" && /^vi\b/i.test(requestedLanguage)
    ? "en"
    : requestedLanguage;
  const isHighlightNarration = mode === "highlight_cut";
  const renderStyle = state.currentProject?.genreMode || "thriller";
  return {
    mode,
    voiceProvider: selectedVoice.draftVoiceProvider,
    voiceId: selectedVoice.draftVoiceId,
    cloneSourceVoice: selectedVoice.draftCloneSourceVoice,
    language,
    targetLanguage: language,
    narrationLanguage: language,
    style: renderStyle,
    genreMode: renderStyle,
    voiceDesign: {
      tab: selectedVoice.draftCloneSourceVoice ? "clone" : "preset",
      prompt: selectedVoice.draftVoiceId || "",
      samplePath: selectedVoice.draftCloneSourceVoice ? selectedVoice.draftVoiceId : "",
      presetProvider: selectedVoice.draftVoiceProvider,
      presetVoiceId: selectedVoice.draftVoiceId
    }
  };
}

function renderVoiceCalibrationResult(result, kind = "final") {
  state.voiceCalibration = result || null;
  if (kind === "draft") {
    state.draftVoiceCalibration = result || null;
  } else {
    state.finalVoiceCalibration = result || null;
  }
  const statusEl = kind === "draft" ? el.draftVoiceCalibrationStatus : el.voiceCalibrationStatus;
  const copyButton = kind === "draft" ? el.copyDraftVoiceBudgetPrompt : el.copyVoiceBudgetPrompt;
  if (!statusEl) return;
  if (!result?.profile) {
    statusEl.textContent = kind === "draft" ? "Chưa đo tốc độ voice nháp." : "Chưa đo tốc độ voice xuất thật.";
    if (copyButton) copyButton.disabled = true;
    return;
  }
  const profile = result.profile;
  const budgets = (result.wordBudgets || [])
    .map((item) => `${item.durationSec}s: ${item.minWords}-${item.maxWords} từ`)
    .join(" · ");
  const samples = (result.samples || [])
    .map((sample) => `Câu ${sample.index + 1}: ${sample.wordsPerSecond} w/s`)
    .join(" · ");
  statusEl.innerHTML = `
    <strong>${escapeHtml(profile.identity?.provider || "voice")} · ${escapeHtml(profile.identity?.language || "en")} · ${escapeHtml(profile.wordsPerSecond)} từ/giây</strong><br>
    <span>${escapeHtml(samples)}</span><br>
    <span>${escapeHtml(budgets)}</span>
  `;
  if (copyButton) copyButton.disabled = !result.promptSnippet;
  renderHighlightPromptTemplate();
}

async function calibrateSelectedVoiceSpeed() {
  const payload = getVoiceCalibrationPayload();
  await calibrateVoiceSpeedWithPayload(payload, "final");
}

async function calibrateDraftVoiceSpeed() {
  const payload = getDraftVoiceCalibrationPayload();
  await calibrateVoiceSpeedWithPayload(payload, "draft");
}

async function calibrateVoiceSpeedWithPayload(payload, kind = "final") {
  if (payload.voiceProvider === "omnivoice" && payload.cloneSourceVoice && !payload.voiceId && !payload.voiceDesign?.samplePath) {
    showToast("Hãy chọn file giọng mẫu trước khi đo tốc độ OmniVoice clone.");
    return;
  }
  const statusEl = kind === "draft" ? el.draftVoiceCalibrationStatus : el.voiceCalibrationStatus;
  setBusy(true);
  try {
    if (payload.voiceProvider === "edge_neural" || payload.voiceProvider === "kokoro") {
      const saved = await window.cineviral.saveSettings(readSettings());
      state.settings = saved.settings;
    }
    if (statusEl) {
      statusEl.innerHTML = `<strong>Đang đo tốc độ ${kind === "draft" ? "voice nháp" : "voice xuất thật"}...</strong><br>Provider có thể mất vài phút nếu là OmniVoice.`;
    }
    addLog(`Đang đo tốc độ giọng bằng ${payload.voiceProvider} (${payload.language || "en"})...`);
    const result = await window.cineviral.calibrateVoice(payload);
    renderVoiceCalibrationResult(result, kind);
    addLog(`Đã đo tốc độ giọng: ${result.profile?.wordsPerSecond || "?"} từ/giây.`);
    showToast("Đã đo tốc độ giọng và lưu voice profile.");
  } catch (error) {
    addLog(error.message, "ERROR");
    showToast(error.message);
    if (statusEl) {
      statusEl.textContent = `Không đo được tốc độ giọng: ${error.message}`;
    }
  } finally {
    setBusy(false);
  }
}

async function copyVoiceBudgetPrompt(kind = "final") {
  const source = kind === "draft" ? state.draftVoiceCalibration : state.finalVoiceCalibration;
  const snippet = source?.promptSnippet || "";
  if (!snippet) {
    showToast("Chưa có prompt budget. Hãy đo tốc độ giọng trước.");
    return;
  }
  await navigator.clipboard.writeText(snippet);
  showToast("Đã copy prompt budget cho Gemini.");
}

function getCurrentVoiceCalibrationPromptBlock({
  coverageMin = 0.9,
  coverageMax = 0.98,
  coveragePolicy = "",
  maxOnly = false
} = {}) {
  const selected = getSelectedVoiceConfig();
  const profile = state.finalVoiceCalibration?.profile || {};
  const budgets = state.finalVoiceCalibration?.wordBudgets || [];
  const measuredWordsPerSecond = Number(profile.conservativeWordsPerSecond || profile.wordsPerSecond || 0);
  const budgetLines = budgets.length
    ? budgets.map((item) => {
      if (!coveragePolicy || !measuredWordsPerSecond) {
        return `- ${item.durationSec}s segment: minWords=${item.minWords}, maxWords=${item.maxWords}`;
      }
      const durationSec = Number(item.durationSec || 0);
      const minWords = Math.floor(durationSec * measuredWordsPerSecond * coverageMin);
      const maxWords = Math.ceil(durationSec * measuredWordsPerSecond * coverageMax);
      return maxOnly
        ? `- ${durationSec}s voiceover window: maxWords=${maxWords}; shorter is preferred when the idea is complete.`
        : `- ${durationSec}s segment: minWords=${minWords}, maxWords=${maxWords}`;
    }).join("\n")
    : "- No measured profile yet. Ask the user to run voice speed calibration first, or use a conservative temporary estimate of 3.0 words/sec.";
  return [
    "VOICE CALIBRATION PARAMETERS PROVIDED BY USER:",
    `- voiceProvider: ${selected.voiceProvider || "edge_neural"}`,
    `- voiceId: ${selected.voiceId || "(selected provider default voice)"}`,
    `- cloneSourceVoice: ${selected.cloneSourceVoice ? "true" : "false"}`,
    `- measuredWordsPerSecond: ${measuredWordsPerSecond || "NOT_MEASURED"}`,
    measuredWordsPerSecond ? `- medianMeasuredWordsPerSecond: ${Number(profile.wordsPerSecond || measuredWordsPerSecond)}` : "",
    measuredWordsPerSecond ? `- measuredSampleCount: ${Number(profile.sampleCount || 0)}` : "",
    maxOnly ? "- targetNarrationCoverageMin: NONE (never fill a quota)" : `- targetNarrationCoverageMin: ${coverageMin}`,
    `- targetNarrationCoverageMax: ${coverageMax}`,
    "- Formula for each voiceover_only segment:",
    maxOnly
      ? "  maxWords = ceil(sourceWindowDurationSec * measuredWordsPerSecond * targetNarrationCoverageMax)"
      : "  minWords = floor((endSec - startSec) * measuredWordsPerSecond * targetNarrationCoverageMin)",
    maxOnly ? "  There is deliberately no minWords requirement." : "  maxWords = ceil((endSec - startSec) * measuredWordsPerSecond * targetNarrationCoverageMax)",
    coveragePolicy ? `- coveragePolicy: ${coveragePolicy}` : "",
    "- Example measured word budgets:",
    budgetLines
  ].filter(Boolean).join("\n");
}

function getCompactVoiceCalibrationPromptBlock() {
  const selected = getSelectedVoiceConfig();
  const profile = state.finalVoiceCalibration?.profile || {};
  const measuredWordsPerSecond = Number(profile.conservativeWordsPerSecond || profile.wordsPerSecond || 0);
  return [
    "VOICE CALIBRATION - TECHNICAL GUARDRAIL ONLY:",
    `- voiceProvider: ${selected.voiceProvider || "edge_neural"}`,
    `- voiceId: ${selected.voiceId || "(selected provider default voice)"}`,
    `- measuredWordsPerSecond: ${measuredWordsPerSecond || "NOT_MEASURED"}`,
    "- Write the shortest complete narration that performs its story job. Do not fill a minimum word quota.",
    "- The local tool measures the generated voice and resolves final timing. Gemini must not pad prose, calculate output timestamps, or slow visuals to fit text."
  ].join("\n");
}

async function hydrateFinalVoiceCalibrationFromStoredProfile() {
  const result = await window.cineviral.getVoiceProfile(getVoiceCalibrationPayload());
  if (result?.profile?.sampleCount) {
    renderVoiceCalibrationResult(result, "final");
    return result;
  }
  state.finalVoiceCalibration = null;
  return null;
}

function buildDiyStoryRemixPromptContext() {
  const angle = el.diyStoryAngle?.value || "gemini_auto_story";
  const angleDescriptions = {
    gemini_auto_story: "Analyze the original video's spoken/on-screen story and visual arc first. Create a new, coherent story with a similar core theme and emotional trajectory, without copying the original wording. Creative narration may add a parallel human story, but it must never contradict the visible process or present unsupported concrete details as facts about the creator, materials, cost, timing or result.",
    failure_to_success: "Open with a verified failure or near-failure, return to the initial state, then show the concrete fix and visible success.",
    transformation_journey: "Emphasize the truthful visual progression from the initial condition to the finished result.",
    impossible_challenge: "Frame the visible difficulty as a challenge, without inventing deadlines, cost, skill level or personal stakes.",
    emotional_story: "Use a warm human-centered arc, but include emotion or motivation only when the source visibly or audibly supports it."
  };
  return [
    "DIY STORY REMIX USER OPTIONS:",
    `- storyAngle: ${angle}`,
    `- storyAngleInstruction: ${angleDescriptions[angle] || angleDescriptions.gemini_auto_story}`,
    `- narrationLanguage: ${el.targetLanguage?.value || "en"}`,
    "- preferredAudioStrategy: voiceover_only narration with optional short original_audio satisfying sounds only when no source speech is present.",
    "- factualPolicy: preserve the visible DIY process and result; never invent facts.",
    "",
    getCurrentVoiceCalibrationPromptBlock()
  ].join("\n");
}

const GEMINI_JSON_CODE_FENCE = "```";

function normalizeIndependentHookPriority(value) {
  const requested = Array.isArray(value)
    ? value
    : String(value || "").split(",");
  const unique = requested
    .map((item) => String(item || "").trim())
    .filter((item, index, list) => DEFAULT_INDEPENDENT_HOOK_PRIORITY.includes(item) && list.indexOf(item) === index);
  DEFAULT_INDEPENDENT_HOOK_PRIORITY.forEach((item) => {
    if (!unique.includes(item)) unique.push(item);
  });
  return unique;
}

function readIndependentHookPriority() {
  if (!el.manualIndependentHookPriority) return [...DEFAULT_INDEPENDENT_HOOK_PRIORITY];
  const rows = Array.from(el.manualIndependentHookPriority.querySelectorAll(".hook-priority-row"));
  return normalizeIndependentHookPriority(rows.map((row) => row.dataset.hookType));
}

function setIndependentHookPriority(value) {
  const order = normalizeIndependentHookPriority(value);
  const list = el.manualIndependentHookPriority;
  if (!list) return;
  const rows = new Map(Array.from(list.querySelectorAll(".hook-priority-row")).map((row) => [row.dataset.hookType, row]));
  order.forEach((hookType, index) => {
    const row = rows.get(hookType);
    if (!row) return;
    const rank = row.querySelector(".hook-priority-rank");
    if (rank) rank.textContent = String(index + 1);
    list.appendChild(row);
  });
  list.dataset.order = order.join(",");
}

function moveIndependentHookPriority(hookType, direction) {
  const order = readIndependentHookPriority();
  const currentIndex = order.indexOf(hookType);
  const nextIndex = currentIndex + direction;
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= order.length) return;
  [order[currentIndex], order[nextIndex]] = [order[nextIndex], order[currentIndex]];
  setIndependentHookPriority(order);
}

function readDurationRange(minElement, maxElement, defaults) {
  const min = Math.max(60.5, Math.min(300, Number(minElement?.value || defaults.min)));
  const max = Math.max(min, Math.min(600, Number(maxElement?.value || defaults.max)));
  return { min: Number(min.toFixed(1)), max: Number(max.toFixed(1)) };
}

function readIndependentPromptOptions() {
  const script1 = readDurationRange(el.manualIndependentScript1Min, el.manualIndependentScript1Max, { min: 60.5, max: 120 });
  const script2 = readDurationRange(el.manualIndependentScript2Min, el.manualIndependentScript2Max, { min: 60.5, max: 150 });
  const script3 = readDurationRange(el.manualIndependentScript3Min, el.manualIndependentScript3Max, { min: 90, max: 240 });
  const script4 = readDurationRange(el.manualIndependentScript4Min, el.manualIndependentScript4Max, { min: 60.5, max: 120 });
  const script5 = readDurationRange(el.manualIndependentScript5Min, el.manualIndependentScript5Max, { min: 60.5, max: 150 });
  return {
    scriptCount: Math.max(1, Math.min(5, Number(el.manualIndependentScriptCount?.value || 2))),
    hookPriority: readIndependentHookPriority(),
    hookMaxSec: Math.max(4, Math.min(30, Number(el.manualIndependentHookMax?.value || 30))),
    narratorTone: ["profile_default", "cinematic", "genz", "factual"].includes(el.manualIndependentNarratorTone?.value)
      ? el.manualIndependentNarratorTone.value
      : "profile_default",
    audioBalance: ["original_first", "balanced", "narrator_led"].includes(el.manualIndependentAudioBalance?.value)
      ? el.manualIndependentAudioBalance.value
      : "original_first",
    pacing: ["fast", "balanced", "story_first"].includes(el.manualIndependentPacing?.value)
      ? el.manualIndependentPacing.value
      : "balanced",
    ending: ["verified_payoff", "payoff_comment", "grounded_open_loop"].includes(el.manualIndependentEnding?.value)
      ? el.manualIndependentEnding.value
      : "verified_payoff",
    overlays: el.manualIndependentOverlays?.checked !== false,
    powerWords: String(el.manualIndependentPowerWords?.value || DEFAULT_INDEPENDENT_POWER_WORDS).trim(),
    durations: { script1, script2, script3, script4, script5 }
  };
}

function readManualGeminiPromptOptions() {
  const requestedProfile = String(el.manualPromptProfile?.value || "independent");
  const profile = state.selectedMode === "manual_gemini_pro"
    && ["independent", "serialized_interleaved", "serialized_genz", "viral_police_blotter", "viral_tiktok_crime_part1"].includes(requestedProfile)
    ? requestedProfile
    : "independent";
  const minDuration = Math.max(60.5, Math.min(300, Number(el.manualSeriesDurationMin?.value || 75)));
  const maxDuration = Math.max(minDuration, Math.min(600, Number(el.manualSeriesDurationMax?.value || 110)));
  const pacing = ["strict_10", "balanced", "story_first"].includes(el.manualSeriesPacing?.value)
    ? el.manualSeriesPacing.value
    : "strict_10";
  return {
    profile,
    independent: readIndependentPromptOptions(),
    sharedHook: ["serialized_interleaved", "serialized_genz"].includes(profile) ? true : el.manualSeriesSharedHook?.checked !== false,
    interleavedAudio: el.manualSeriesInterleavedAudio?.checked !== false,
    cinematicNarrator: el.manualSeriesNarratorStyle?.checked !== false,
    cliffhanger: el.manualSeriesCliffhanger?.checked !== false,
    overlays: el.manualSeriesOverlays?.checked !== false,
    minDuration: Number(minDuration.toFixed(1)),
    maxDuration: Number(maxDuration.toFixed(1)),
    pacing,
    powerWords: String(el.manualSeriesPowerWords?.value || DEFAULT_SERIES_POWER_WORDS).trim()
  };
}

function getManualPromptProfileLabel(options = readManualGeminiPromptOptions()) {
  if (options.profile === "viral_tiktok_crime_part1") {
    return "TikTok Viral Bodycam (Part 1 - 8 nhịp xen kẽ · 110-125s)";
  }
  if (options.profile === "serialized_interleaved") {
    return `Series Part 1-3 · ${options.minDuration}-${options.maxDuration}s`;
  }
  if (options.profile === "serialized_genz") {
    return `Series Gen Z · ${options.minDuration}-${options.maxDuration}s`;
  }
  if (options.profile === "viral_police_blotter") {
    return "Viral Police Blotter · 3 variant";
  }
  const hookLabel = {
    high_action: "Hành động",
    dialogue_conflict: "Mâu thuẫn",
    psychological_wtf: "WTF",
    rage_irony: "Mỉa mai",
    evidence_reveal: "Bằng chứng"
  }[options.independent?.hookPriority?.[0]] || "Tự động";
  return `${options.independent?.scriptCount || 2} kịch bản độc lập · Hook ${hookLabel}`;
}

function syncManualGeminiPromptOptionsUi({ rerenderPrompt = true } = {}) {
  const options = readManualGeminiPromptOptions();
  const isSerialized = ["serialized_interleaved", "serialized_genz"].includes(options.profile);
  const isIndependent = options.profile === "independent";
  const isGenZ = options.profile === "serialized_genz";
  el.manualIndependentOptions?.classList.toggle("hidden", !isIndependent);
  el.manualSerializedOptions?.classList.toggle("hidden", !isSerialized);
  setIndependentHookPriority(options.independent?.hookPriority || DEFAULT_INDEPENDENT_HOOK_PRIORITY);
  if (el.manualSeriesSharedHook) {
    el.manualSeriesSharedHook.checked = true;
    el.manualSeriesSharedHook.disabled = isSerialized;
  }
  if (el.manualSeriesNarratorStyle) {
    if (isGenZ) el.manualSeriesNarratorStyle.checked = true;
    el.manualSeriesNarratorStyle.disabled = isGenZ;
  }
  if (el.manualSeriesNarratorStyleLabel) {
    el.manualSeriesNarratorStyleLabel.textContent = isGenZ
      ? "Văn phong Gen Z đời thường (bắt buộc)"
      : "Văn phong narrator true-crime điện ảnh";
  }
  if (el.manualPromptOptionSummary) el.manualPromptOptionSummary.textContent = getManualPromptProfileLabel(options);
  if (el.reviewPromptProfile) el.reviewPromptProfile.textContent = getManualPromptProfileLabel(options);
  if (rerenderPrompt) renderHighlightPromptTemplate();
}

function buildSerializedHighlightGeminiPromptTemplate(options = readManualGeminiPromptOptions()) {
  const isGenZ = options.profile === "serialized_genz";
  const voiceBlock = getCurrentVoiceCalibrationPromptBlock();
  const pacingRule = options.pacing === "story_first"
    ? "Voiceover blocks should be 6-12s and original-audio blocks may run 8-30s. Preserve a complete causal exchange even when strict alternation must yield to story comprehension."
    : options.pacing === "balanced"
    ? "Voiceover blocks should be 6-12s and original-audio blocks 8-18s. Avoid two same-mode blocks in a row unless splitting would cut a complete quote or reaction."
    : "Strictly alternate voiceover_only blocks of 8-12s with original_audio blocks of 8-12s. No uninterrupted run of one audio mode may exceed 15s, except a verified actionOverride sequence.";
  const hookRule = `COLD OPEN HOOK RULE (Flexible 5-30s for ALL Parts):
- ACTION-FIRST PRIORITY: Scan the entire source and prioritize the strongest clear high-adrenaline visual/audio sequence, including an intense argument, forced entry, physical struggle, pursuit, weapon draw, gunshot, panic, or immediate reaction. Strong action with a clear climax and payoff outranks a bizarre confession, extreme entitlement, absurd excuse, or psychological contradiction.
- A semantic or psychological quote may become the Hook only when no verified action sequence provides stronger visual impact, understandable conflict, and a more powerful payoff.
- COMPLETE ACTION HOOK: Preserve the useful progression from setup or warning -> confrontation or action -> climax -> immediate reaction. The Hook may last up to 30 seconds when needed to keep that continuous action understandable and complete. Do not cut a strong action Hook merely to satisfy a shorter duration target.
- MULTI-SEGMENT HOOK REQUIRED WHEN NEEDED: If the selected action crosses scene-manifest boundaries, return consecutive scene-bounded JSON segments. Assign storyFunction="hook", audio_mode="original_audio", empty voiceover_text, and the same macroBlockId, sourceRunId, actionSequenceId, sustainedBeatId, completeNarrativeBeat=true, sustainedBeatOverride=true, and actionOverride=true to every Hook slice. Preserve source order without gaps and place no voiceover or unrelated footage between slices.
- HOOK PAYOFF COMPLETENESS: Ending an action Hook before its verified climax or immediate reaction is invalid. Loudness alone is insufficient; the action must remain understandable to a cold viewer and deliver a concrete visual or audible payoff.
- EVERY Part MUST start with the EXACT SAME complete signature cold open Hook sequence. The Hook MUST use pure original_audio and may last from 5 to 30 seconds. Cut immediately before an external source narrator begins; never retain that narrator merely to complete a duration target.`;
  const audioRule = options.interleavedAudio
    ? pacingRule
    : "Choose audio_mode according to story needs. Preserve important source dialogue as original_audio and use voiceover_only only where source dialogue can be safely muted.";
  const narratorRule = isGenZ
    ? `The voiceover must sound like conversational internet slang, NOT a formal news report or documentary. Use high-emotion, modern hooks.
Suggested phrases: "This Karen literally lost her mind", "Instant karma", "Main character syndrome", "Her excuse makes zero sense", "Wait until you see what she does next", "The audacity", "Unhinged behavior".
Forbidden words: "erratic", "inexplicably", "ironclad", "unprovoked assault", "devastating charges", "altercation". Replace them with casual equivalents such as "wild", "for no reason", "everyone saw it", "random attack", or "going to jail".
The first voiceover sentence of EVERY Part must contain a curiosity gap. Do not merely state what is visible; ask a question or point out the verified absurdity that forces the viewer to engage.`
    : options.cinematicNarrator
    ? `Write active, present-tense cinematic true-crime narration grounded in exact visible action and verified dialogue. Suggested power words: ${options.powerWords}. These words are optional and MUST NOT be used when evidence does not support them.`
    : "Write concise, objective documentary narration. Prefer verified facts and exact visible action over dramatic wording.";
  const cliffhangerRule = options.cliffhanger
    ? "Part 1 and Part 2 must end on the strongest VERIFIED unresolved beat available in the evidence. Part 3 must deliver the verified resolution or, when the source has no final resolution, the last verified consequence. Never invent hospital outcomes, charges, motives, deaths, convictions, or forensic reveals."
    : "Each Part may end with its own verified payoff and does not need a cliffhanger.";
  const overlayRule = options.overlays
    ? "Populate shared_top_banner_text once for the complete story, plus part_badge and on_screen_elements with source-grounded editor cues. Every Part must use the exact same shared title. Keep metadata practical, timestamped, and evidence-linked; do not assume the renderer can invent tracking data."
    : "Set shared_top_banner_text, top_banner_text, and part_badge to empty strings and on_screen_elements to an empty array.";

  const persona = isGenZ
    ? "You are a viral Gen-Z/Millennial TikTok true-crime and bodycam storyteller. Analyze the complete uploaded source, scene-manifest.json, locked evidence, transcript, and proxy before selecting footage. Build one coherent case narrative split into Part 1, Part 2, and Part 3. Your ultimate goal is to maximize audience outrage, curiosity, and watch time for 9:16 short-form platforms. You speak in fast-paced, conversational internet English. You are gossiping with the viewer about a wild situation, but strictly using verified facts."
    : "You are a senior TikTok true-crime editor. Analyze the complete uploaded source, scene-manifest.json, locked evidence, transcript, and proxy before selecting footage. Build one coherent case narrative split into Part 1, Part 2, and Part 3. The Parts must advance the same story rather than retell three unrelated angles.";
  const antiHallucinationRule = isGenZ
    ? `- ANTI-HALLUCINATION VISUAL RULE: Do not write aggressive physical-action claims such as "fighting officers" unless the frames visibly show a physical fight. Verbal arguing must be described precisely.
- TONE DECOUPLING RULE (CRITICAL): Be 100% factually accurate, but describe verified facts using dramatic, casual internet language rather than police-report prose. For example, verified "disorderly intoxication" may be phrased as "she was completely wasted"; verified "resisting without violence" may be phrased as "she threw a massive tantrum and refused to get in the car". Factuality governs the underlying truth, not vocabulary formality.`
    : `- ANTI-HALLUCINATION VISUAL RULE: Do not write aggressive physical-action claims such as "fighting officers", "resisting arrest" or "violent struggle" unless the selected frames visibly show a fight, wrestling, physical restraint or handcuffs being applied. Verbal arguing, crying or emotional behavior must be described precisely as arguing, blaming others, playing the victim or throwing a tantrum when verified. Never upgrade verbal conflict into physical violence.`;
  const nonRedundantRule = isGenZ
    ? `4. NON-REDUNDANT NARRATION (REACTION-DRIVEN COPYWRITING)
- FORBIDDEN: Using voiceover merely to describe an action already obvious on screen, such as saying "The officer reads her charges" while the officer is reading charges.
- Voiceover must act as the audience's inner voice: react to verified absurdity, add verified context, highlight stakes, or call out evidence-supported contradictions. Example: "She literally just attacked a kid and now she's playing the victim" is allowed only when every underlying fact is supported by locked evidence.
- Every added fact must remain 100% supported by evidence.`
    : `4. NON-REDUNDANT NARRATION (VALUE-ADD COPYWRITING)
- FORBIDDEN: Using voiceover merely to describe an action that is already completely obvious on screen.
- Voiceover must add verified context, causal connection, timeline orientation, stakes, background, or consequence that the visual and authentic dialogue cannot communicate alone.
- Every added fact must be supported by visualFacts, dialogueEvidence, sourceNarratorText, storyMeaning, keywords, or payoff in the same locked evidence. Never invent internal thoughts, motives, criminal history, charges, or outcomes.`;

  return `USER TASK INSTRUCTION - BUILD A 3-PART SERIALIZED TRUE-CRIME SERIES

${persona}

### USER-SELECTED PROMPT PROFILE
- prompt_profile: ${options.profile}
- series_mode: interleaved_multipart
- target duration for EACH Part: ${options.minDuration}-${options.maxDuration} seconds after playbackSpeed
- shared cold open: ${options.sharedHook}
- interleaved audio sandwich: ${options.interleavedAudio}
- cinematic narrator: ${options.cinematicNarrator}
- cliffhanger endings: ${options.cliffhanger}
- visual overlay metadata: ${options.overlays}
- pacing profile: ${options.pacing}

### NON-NEGOTIABLE SCRIPT-ID TO PART MAPPING
- scriptId=1 is part_number=1 and part_badge="PART 1".
- scriptId=3 is part_number=2 and part_badge="PART 2".
- scriptId=4 is part_number=3 and part_badge="PART 3".
- Never output Script 2. The unusual IDs preserve compatibility with the editing tool.

### EDITORIAL RULES
1. STORY FIRST: Write one factual series blueprint before choosing clips. Define the central person, conflict, verified causal chain, escalation, climax, resolution, and the unique audience question carried into each Part.
2. ${hookRule}
3. AUDIO SANDWICH: ${audioRule}
4. VISUAL ACTION OVERRIDE: Do not over-rely on transcript density. Major physical events such as escape, vehicle theft, pursuit, struggle, crash, weapon draw, forced entry, takedown, panic, or immediate physical reaction outrank ordinary dialogue. Every narrativeEssential/mustInclude action must appear.
5. ACTION SEQUENCE EXCEPTION: Keep an unbroken high-adrenaline action and its immediate reaction as sustained original_audio. Do not interrupt it to satisfy audio alternation. There is no fixed maximum; cut only at a natural lull, repetition, or loss of story value. Mark linked segments actionOverride=true and keep one actionSequenceId.
6. SUSTAINED BEAT OVERRIDE (CRITICAL EXCEPTION):
   - The default interleaved audio pacing (e.g., Strict 10) MUST BE IGNORED when encountering a "Complete Narrative Beat".
   - A Complete Narrative Beat is defined as: (1) high-adrenaline physical action such as a car chase, suspect escaping, or physical struggle; or (2) high-stakes emotional or verbal conflict such as a critical lie, breakdown, chilling confession, or direct confrontation.
   - If a source run contains a Complete Narrative Beat, preserve it as one unbroken original_audio segment lasting up to 30 seconds, or longer when continuous tension justifies it. Do NOT artificially chop this beat into 8-12s fragments. Do NOT interrupt a critical dialogue exchange with voiceover.
   - Set completeNarrativeBeat=true, sustainedBeatOverride=true, and one stable sustainedBeatId. If scene-manifest boundaries force multiple scene-bounded segments, keep them consecutive with the same sustainedBeatId and original_audio; they form one uninterrupted sustained beat and no voiceover may appear between them.
7. NARRATOR: ${narratorRule}
8. SERIAL ENDINGS: ${cliffhangerRule}
9. VISUAL METADATA: ${overlayRule}
10. COMPLETE BEATS: Never cut a spoken sentence, decisive action, command-response pair, or immediate reaction in half. Do not assemble a montage of isolated high-score moments.
11. SOURCE GROUNDING: Every claim must be supported by the selected evidenceId, visual frames, source audio, or transcript. If a detail is not verified, omit it.
12. TIMELINES: sourceStartSec/sourceEndSec refer only to the original video. startSec/endSec refer only to the output Part and must be continuous from zero.
    ONE-SCENE-PER-SEGMENT: Every source range must remain inside exactly one selected sceneId. If a logical beat crosses a scene boundary, split it into scene-bounded segments, preserve macroBlockId/sourceRunId/actionSequenceId, divide voiceover without duplication, and recalculate the output Part timeline.
13. DURATION FORMULA: endSec - startSec = (sourceEndSec - sourceStartSec) / playbackSpeed.
    OUTPUT TIMELINE IS DERIVED, NOT EDITORIAL: sourceStartSec/sourceEndSec and playbackSpeed are authoritative. Finalize every source trim and speed first, then recalculate every startSec/endSec continuously from zero using at least 3 decimal places. Never preserve old output timestamps after changing a source range or speed. The local tool will reflow the output timeline and its calculation is authoritative.
14. AUDIO MODES: original_audio requires voiceover_text="". voiceover_only requires English voiceover_text and means source audio will be ducked to 20% volume.
15. DURATION GATE: Every Part must be within ${options.minDuration}-${options.maxDuration}s and never below 60.5s. Add relevant complete evidence, never silence, freeze frames, credits, or filler.

================================================================================
### CRITICAL EDITORIAL RULES & NEGATIVE CONSTRAINTS (PROMPT PATCH V3.0)
================================================================================

0. SERIALIZATION & MYSTERY PRESERVATION RULES (CRITICAL)
- SPOILER BAN FOR PART 1 AND PART 2: Script 1 / Part 1 and Script 3 / Part 2 must not reveal the final plot twist, decisive hidden evidence, test result, formal arrest, court sentence, or ultimate legal consequence.
- Part 1 establishes only the verified premise, bizarre behavior and immediate stakes, then ends on an unresolved confrontation such as a request to search, a suspicious lie, or another evidence-grounded open question.
- Part 2 advances only the verified middle escalation such as blame, contradiction, argument or refusal, then ends at the boiling-point pre-climax turn before the decisive reveal.
- RESOLUTION LOCK FOR PART 3: Only Script 4 / Part 3 may reveal the ultimate verified truth, decisive hidden evidence, formal arrest and final court consequence. Do not repeat the same arrest, sentence or Karma payoff across multiple Parts.
${antiHallucinationRule}

1. ANTI-CLONE VOICEOVER RULE (SERIALIZATION INTEGRITY)
- Even when shared_hook_enabled=true uses the exact same 5-30s pure original_audio Hook sequence across Part 1, Part 2, and Part 3, the first voiceover_only segment after the complete Hook MUST be unique in wording and narrative purpose for each Part.
- FORBIDDEN: Copying, lightly paraphrasing, or reusing the same opening narration across multiple Parts.
- Part 1 opening voiceover establishes the verified premise and immediate stakes.
- Part 2 opening voiceover is a rapid evidence-grounded recap/bridge from Part 1 into the new conflict covered by Part 2.
- Part 3 opening voiceover orients the verified final chapter, consequence, or unresolved question covered by Part 3.
- The role descriptions above are structural examples only. Never mention an abduction, escape, interrogation, charge, motive, or outcome unless LOCKED_SCENE_EVIDENCE supports it.

2. ZERO-TOLERANCE SOURCE NARRATOR FILTER (SUPREME OVERRIDE)
- original_audio is permitted only when sourceNarratorPresent=false, source_narrator_detected=false, and every audible speaker is a directly involved officer, suspect, victim, witness, interview subject, 911/radio dispatcher, or authentic ambient/action sound.
- Completely cut or mute every third-party YouTube host, news anchor or documentary narrator. The source narrator must never be audible in the final output.
- This rule overrides Sustained Beat Override, Complete Narrative Beat, Action Sequence Exception, actionOverride and every pacing rule. Those rules never authorize keeping an external narrator.
- If an external narrator begins during an otherwise valuable beat, split at the most precise supported timestamp: preserve original_audio only while direct characters or clean action sound are audible, then switch immediately to voiceover_only or another verified source range when the external narrator begins.
- If the external narrator overlaps direct character speech and clean separation is impossible, set audio_mode="voiceover_only" for the complete overlapping range and sacrifice raw audio. Recreate only verified factual meaning with the user's selected tool voice. Never hard-code a voice provider.
- The renderer mutes the entire source soundtrack for voiceover_only. Never claim that muted dialogue, commands, reactions or impacts remain audible.
- SOURCE NARRATOR TIMELINE: Before selecting segments, scan the complete source and transcript and populate root source_narrator_ranges with every verified interval containing an external YouTube host, news anchor, or documentary narrator. Each range requires startSec, endSec, replacementText, and confidence. The same complete range list must appear in all three JSON files.
- SEGMENT SPLIT GATE: If any selected segment intersects source_narrator_ranges, split it at the exact narrator boundaries. Narrator slices must use voiceover_only, source_narrator_detected=true, and verified replacementText. Clean direct-dialogue/action slices may use original_audio. Never allow overlapping source ranges between consecutive output segments.

3. ACTION PAYOFF & VISUAL MATCHING (ANTI-CLICKBAIT)
- High-adrenaline narration must be paid off immediately by the matching verified visual action. Do not promise a chase, escape, weapon, crash, struggle, arrest, or confrontation and then cut directly to static aftermath or an unrelated location.
- Select the corresponding evidenceId/actionSequenceId immediately after the setup voiceover. Use actionOverride=true and sustainedBeatOverride=true where supported to preserve the complete action and immediate reaction before moving to the resolution.
- actionOverride and sustainedBeatOverride do not invent or locate footage. The selected evidence and source timestamps themselves must visibly contain the promised action.

${nonRedundantRule}

5. SCENE BRIDGING & CONTEXT TRANSITIONS
- FORBIDDEN: Hard-jumping between substantially different locations, times, or story phases when a cold viewer cannot understand the connection.
- Every major jump must have a concrete transitionReason. When source dialogue or the visual transition cannot explain the jump, place a concise evidence-grounded voiceover_only bridge immediately before it.
- Do not manufacture a bridge inside an actionOverride or sustainedBeatOverride sequence. Finish the complete action/dialogue beat first, then bridge at its natural boundary.

${voiceBlock}

### REQUIRED ROOT SCHEMA FOR EACH FILE
{
  "artifactType": "highlight_cut_script",
  "schemaVersion": 1,
  "scriptId": 1,
  "prompt_profile": "${options.profile}",
  "series_mode": "interleaved_multipart",
  "series_id": "stable-case-series-id",
  "part_number": 1,
  "part_badge": "PART 1",
  "shared_top_banner_text": "One truthful curiosity title shared by every Part and variant",
  "title": "Part title",
  "language": "en",
  "sourceLanguage": "en",
  "total_target_sec": ${options.minDuration},
  "target_duration_min_sec": ${options.minDuration},
  "target_duration_max_sec": ${options.maxDuration},
  "series_pacing": "${options.pacing}",
  "shared_hook_enabled": ${options.sharedHook},
  "interleaved_audio_enabled": ${options.interleavedAudio},
  "cinematic_narrator_enabled": ${options.cinematicNarrator},
  "cliffhanger_enabled": ${options.cliffhanger},
  "source_narrator_ranges": [
    {
      "startSec": 0.56,
      "endSec": 28.12,
      "replacementText": "Exact verified factual meaning spoken by the external narrator in this interval",
      "confidence": "high"
    }
  ],
  "top_banner_text": "Optional variant metadata; rendered banner uses shared_top_banner_text",
  "on_screen_elements": [
    {
      "outputStartSec": 0,
      "outputEndSec": 3,
      "type": "text|arrow|countdown",
      "text": "",
      "target": "",
      "position": "top|center|bottom",
      "evidenceId": "evidence_0001"
    }
  ],
  "story_blueprint": {
    "seriesPremise": "",
    "centralCharacter": "",
    "primaryConflict": "",
    "verifiedCausalChain": [""],
    "partQuestion": "",
    "partPayoffOrCliffhanger": "",
    "macroBlocks": [
      {
        "macroBlockId": "macro_01",
        "storyFunction": "hook|context|escalation|climax|consequence",
        "sourceRunIds": ["source_run_0001"],
        "summary": ""
      }
    ]
  },
  "segments": [
    {
      "id": "highlight_0001",
      "segmentId": "highlight_0001",
      "evidenceId": "evidence_0001",
      "sceneId": "scene_0001",
      "sourceRunId": "source_run_hook_001",
      "macroBlockId": "macro_hook_01",
      "sourceStartSec": 0,
      "sourceEndSec": 12,
      "startSec": 0,
      "endSec": 12,
      "playbackSpeed": 1,
      "scene_type": "Hook_Original_Audio",
      "storyFunction": "hook",
      "transitionReason": "",
      "completeNarrativeBeat": true,
      "completeNarrativeBeatType": "physical_action",
      "sustainedBeatId": "sustained_hook_001",
      "sustainedBeatOverride": true,
      "actionSequenceId": "action_sequence_hook_001",
      "actionOverride": true,
      "source_narrator_detected": false,
      "audio_mode": "original_audio",
      "voiceover_text": "",
      "caption": "",
      "preview_vi": "Tóm tắt tiếng Việt để preview",
      "action_notes": "Hook slice 1/2; continue immediately into the next scene-bounded Hook slice."
    },
    {
      "id": "highlight_0002",
      "segmentId": "highlight_0002",
      "evidenceId": "evidence_0002",
      "sceneId": "scene_0002",
      "sourceRunId": "source_run_hook_001",
      "macroBlockId": "macro_hook_01",
      "sourceStartSec": 12,
      "sourceEndSec": 20,
      "startSec": 12,
      "endSec": 20,
      "playbackSpeed": 1,
      "scene_type": "Hook_Original_Audio_Continued",
      "storyFunction": "hook",
      "transitionReason": "Continuous climax of the same Hook across a scene boundary.",
      "completeNarrativeBeat": true,
      "completeNarrativeBeatType": "physical_action",
      "sustainedBeatId": "sustained_hook_001",
      "sustainedBeatOverride": true,
      "actionSequenceId": "action_sequence_hook_001",
      "actionOverride": true,
      "source_narrator_detected": false,
      "audio_mode": "original_audio",
      "voiceover_text": "",
      "caption": "",
      "preview_vi": "Cao trào và phản ứng ngay sau đó",
      "action_notes": "Hook slice 2/2; no voiceover or unrelated footage between Hook slices."
    }
  ]
}

### FINAL VALIDATION
- Validate all three roots with JSON.parse.
- Validate scriptId/part_number mapping 1→1, 3→2, 4→3.
- Validate each Part duration, timeline continuity, source boundaries, complete spoken beats, and voice word budgets.
- When shared_hook_enabled=true, validate the complete consecutive leading Hook sequence in all three files, not only segments[0]. Every Hook slice must have identical sceneId, sourceStartSec, sourceEndSec, macroBlockId, sourceRunId, actionSequenceId, and order.
- Validate that source_narrator_ranges is identical in all three files and no original_audio segment overlaps any declared narrator range.
- When interleaved_audio_enabled=true, validate the selected pacing profile without cutting meaningful dialogue.

${buildGeminiThreeJsonCodeBlockContract()}`;
}

function buildGeminiSingleJsonCodeBlockContract(fileName, rootRule = "") {
  return `JSON CODE-BLOCK CONTRACT - HIGHEST PRIORITY
- Return exactly one complete valid JSON object inside exactly one Markdown code block beginning with ${GEMINI_JSON_CODE_FENCE}json and ending with ${GEMINI_JSON_CODE_FENCE}.
- Do not output conversational prose, headings, labels, tables, Canvas, or text before or after the code block.
- Validate the object with JSON.parse before responding.
- The code block is the complete content to download and save as "${fileName}".
${rootRule ? `- ${rootRule}` : ""}`.trim();
}

function getRequestedIndependentScriptIds(options = readIndependentPromptOptions()) {
  const profile = readManualGeminiPromptOptions().profile;
  if (["serialized_interleaved", "serialized_genz", "viral_police_blotter", "viral_tiktok_crime_part1"].includes(profile)) {
    return [1, 3, 4];
  }
  return [1, 3, 4, 2, 5].slice(0, Math.max(1, Math.min(5, Number(options.scriptCount || 2))));
}

function buildGeminiThreeJsonCodeBlockContract(scriptIds = [1, 3, 4]) {
  const ids = Array.isArray(scriptIds) && scriptIds.length ? scriptIds : [1, 3, 4];
  return `JSON CODE-BLOCK CONTRACT - HIGHEST PRIORITY
- Return exactly ${ids.length} independent Markdown JSON code block${ids.length === 1 ? "" : "s"} and nothing else.
- Required order: ${ids.map((id) => `Script ${id}`).join(", then ")}.
${ids.map((id, index) => `- Block ${index + 1} is one complete root object with scriptId=${id} and is saved as "script-${id}.json".`).join("\n")}
- Treat each code block as one separate downloadable file. Never put multiple scripts in one code block.
- Every block must begin with ${GEMINI_JSON_CODE_FENCE}json, end with ${GEMINI_JSON_CODE_FENCE}, and parse independently with JSON.parse.
- Never combine the scripts into an array or wrap them in data, result, output, scripts, review, or a shared outer object.
- Do not output prose, headings, filename labels, explanations, tables, or text before, between, or after the JSON blocks.`;
}

function buildViralTikTokCrimePart1PromptTemplate(options = readManualGeminiPromptOptions()) {
  const voiceBlock = getCurrentVoiceCalibrationPromptBlock();
  return `USER TASK INSTRUCTION - BUILD TIKTOK VIRAL BODYCAM (PART 1 - 8-BEAT ALTERNATING SANDWICH)

You are an elite short-form true-crime video editor specializing in viral TikTok/Reels/Shorts bodycam recap videos that consistently hit 5M+ views. You master the "Alternating Sandwich" rhythm: alternating raw, high-adrenaline on-scene video with punchy, suspenseful narration.

Analyze the uploaded source video, scene-manifest.json, source-transcript.srt, and action-candidates.json thoroughly before selecting footage.

### SELECTED PROMPT PROFILE
- prompt_profile: viral_tiktok_crime_part1
- Target total duration: 110 to 125 seconds (average 117 seconds; must NOT be under 110.0s or over 125.0s).
- Return exactly 3 scripts: Script 1 (Part 1 - The Confrontation), Script 3 (Part 2 - The Interrogation), Script 4 (Part 3 - The Verdict & Arrest). Never return Script 2.
- Every script must follow the exact 8-beat formula and use 9:16 vertical framing with viral green badges.

### THE 8-BEAT VIRAL TIMELINE FORMULA (MANDATORY FOR SCRIPT 1)
Script 1 must strictly follow this exact 8-beat sandwich structure (4 Raw Audio beats + 4 Narration beats):

1. BEAT 1 (00:00 - ~00:15, ~12-15s) - COLD OPEN HOOK
   - audio_mode: "original_audio", voiceover_text: ""
   - Content: The single most shocking, loud, or chaotic raw moment from the entire source footage (e.g. screaming at the door, physical struggle, forced breach, frantic yelling).
   - Rule: Grips the viewer in the first 0-3 seconds with zero narration. Pure authentic raw audio.

2. BEAT 2 (~00:15 - ~00:34, ~16-20s) - INCIDENT SETUP & DISPATCH
   - audio_mode: "voiceover_only", English voiceover_text
   - Content: Grounding narration over footage of police arrival / driving. State the date, location, the 911 dispatch premise, what officers were responding to, and the high stakes.
   - Pacing: Active, present-tense, documentary tension.

3. BEAT 3 (~00:34 - ~00:46, ~10-14s) - SCENE ENTRY & RAW REALITY
   - audio_mode: "original_audio", voiceover_text: ""
   - Content: Officer steps inside the house/scene, encounters the first suspect or family member at the door/stairs, capturing natural ambient dialogue and escalating tension.

4. BEAT 4 (~00:46 - ~01:03, ~15-18s) - ESCALATION & DISCOVERY
   - audio_mode: "voiceover_only", English voiceover_text
   - Content: Narration builds intense suspense as officer rushes upstairs/inward and discovers the core crisis (e.g. suspect physically pinning the victim).
   - Visual matching: Narration directs viewer attention directly to what is about to be seen.

5. BEAT 5 (~01:03 - ~01:16, ~12-15s) - CLIMACTIC TAKEDOWN / CONFRONTATION
   - audio_mode: "original_audio", voiceover_text: ""
   - Content: Peak physical and vocal confrontation! Commands shouted by police ("Get off her! Let go of her! Stand up!"), restraint applied, separating suspect from victim. 100% authentic raw audio.

6. BEAT 6 (~01:16 - ~01:35, ~17-20s) - CONFLICT BREAKDOWN & MORAL CONTRAST
   - audio_mode: "voiceover_only", English voiceover_text
   - Content: Identifies key suspects and victims by name. Contrasts the suspect's absurd excuse or fake medical claim ("she was having a mental episode") against the victim's clear explanation ("I just wanted to leave").

7. BEAT 7 (~01:35 - ~01:44, ~7-10s) - RAW DIALOGUE EVIDENCE
   - audio_mode: "original_audio", voiceover_text: ""
   - Content: Suspect stammers an incriminating excuse or victim gives emotional response to the officer.

8. BEAT 8 (~01:44 - ~01:58, ~14-17s) - CLIFFHANGER & PART 2 OPEN LOOP
   - audio_mode: "voiceover_only", English voiceover_text
   - Content: Questioning begins; suspect eagerly starts trying to justify their actions, unaware they are digging their own grave. Narration delivers a compelling hook urging the audience to watch Part 2 for the full interrogation and arrest.

### REQUIRED ROOT METADATA
Every generated JSON script must include:
\`\`\`json
{
  "artifactType": "highlight_cut_script",
  "workflow": "manual_gemini_pro",
  "scriptId": 1,
  "suggestedTitle": "ABUSIVE MOM'S WORST NIGHTMARE CAME TRUE",
  "title": "ABUSIVE MOM'S WORST NIGHTMARE CAME TRUE",
  "partBadge": "PART 1",
  "cameraLabel": "CAM 1",
  "titleStyle": "viral_green",
  "subtitleStyle": "tiktok_karaoke",
  "targetDurationSec": 117.5,
  "segments": [ ...8 segments... ]
}
\`\`\`
For Script 3, set partBadge to "PART 2". For Script 4, set partBadge to "PART 3".

### NON-NEGOTIABLE EDITORIAL RULES
1. ZERO THIRD-PARTY SOURCE NARRATORS: Completely mute or eliminate any YouTube host, television reporter, or narrator from original_audio. Only involved officers, suspects, victims, 911 dispatchers, or raw ambient sounds may be heard.
2. STRICT EVIDENCE GROUNDING: Every claim in narration must be strictly supported by what is visible in the video frames or audible in the source transcript. Do not hallucinate charges, deaths, convictions, or motives.
3. MATHEMATICAL TIMELINE: Output timestamps startSec and endSec must begin at 0.000, be contiguous without gaps, and satisfy: (sourceEndSec - sourceStartSec) / playbackSpeed = endSec - startSec.
4. Total duration of the 8 segments must sum to between 110.0 and 125.0 seconds.

${voiceBlock}

${buildGeminiThreeJsonCodeBlockContract([1, 3, 4])}`;
}

function buildPoliceBlotterHighlightGeminiPromptTemplate() {
  const voiceBlock = getCurrentVoiceCalibrationPromptBlock();
  return `USER TASK INSTRUCTION - BUILD THREE VIRAL POLICE BLOTTER HIGHLIGHT SCRIPTS

You are a senior TikTok true-crime editor. Watch the complete uploaded source video and cross-check scene-manifest.json, source-transcript.srt when available, and action-candidates.json before selecting footage.

### SELECTED PROMPT PROFILE
- prompt_profile: viral_police_blotter
- Keep the existing three-variant workflow and JSON schema.
- Return Script 1, Script 3, and Script 4. Never return Script 2.
- Every script must be a distinct edit of the same verified source story.
- Each script must be at least 60.5 seconds after playbackSpeed.

### FIXED EDITORIAL STRUCTURE FOR EVERY SCRIPT

Each script contains exactly ONE raw-audio Hook and exactly FOUR voiceover_only narrator blocks. Original-audio story/action segments must separate the narrator blocks where specified.

Required order:
1. Raw Hook
2. Police Report Intro
3. Original Audio Context/Exchange
4. Shocking Reveal
5. Visual Discovery and Original Audio
6. Climax / Original Audio
7. Moral Contrast
8. Original Audio Consequence/Reaction
9. Specific Cliffhanger

### 1. RAW HOOK
- Start with 5-10 seconds of the strongest verified original_audio moment from anywhere in the source.
- The first 0-3 seconds must contain an absurd quote, direct accusation, profanity, panic, confrontation, visible danger, or explosive physical action.
- CRITICAL HOOK OVERRIDE: Do not default to the loudest generic argument or arrest struggle merely because it has high audio/motion scores. Prioritize a verified bizarre confession, extreme entitlement, an absurd excuse, or a direct spoken statement of the core shocking crime. Narrative shock value and bizarre human behavior always outrank pure audio decibels for Hook selection.
- Scan the raw transcript directly. Motion/audio-energy scores are discovery hints, not semantic truth. A quiet but unbelievable quote can outrank a loud generic scene.
- The Hook may begin mid-exchange when the selected words remain intelligible. Do not pad backward to create a full setup.
- audio_mode must be original_audio and voiceover_text must be empty.
- Never start with context, a title card, a static interview, a warning screen, a 911 waveform, credits, or silence.

### 2. NARRATOR BLOCK 1 - POLICE REPORT INTRO
- This must be the first voiceover_only segment immediately after the Hook.
- Formula: [Verified date/time if available] + [verified police unit/location if available] + [reason officers responded] + [initial visible scene state].
- Tone: cold, objective, concise police-report/documentary narration.
- Example style only: "On June 14, Palm Beach County deputies responded to a welfare check. As an officer approached the vehicle, he found the driver unresponsive."
- Never invent a date, department, location, person's name, charge, or initial condition. Omit any unavailable variable instead of filling it.

### 3. NARRATOR BLOCK 2 - SHOCKING REVEAL
- Place it after a meaningful original-audio context/exchange and immediately before the verified visual discovery.
- Formula: [verified suspect identity or neutral label] + [visible state] + "But as..." + [visible action] + [specific verified discovery].
- Use forceful but grounded wording such as shocking, terrifying, bizarre, or helpless only when the selected evidence visibly supports it.
- The next segment must show the exact object, person, injury, weapon, crash, child, document, or other discovery promised by this narration. Never promise a visual payoff and cut to unrelated footage.

### 4. NARRATOR BLOCK 3 - MORAL CONTRAST
- Place it after the decisive raw-audio confrontation or climax.
- Formula: "Instead of [reasonable reaction supported by context], [the suspect/person] [verified contrasting behavior]. This [causes/leads officers to] [immediate verified consequence]."
- Base the contrast on visible behavior, audible words, or locked evidence. Strong editorial framing is allowed, but never invent thoughts, diagnoses, motives, legal outcomes, or remorse that cannot be supported.
- The consequence must be visible or explicitly stated in the supplied source.

### 5. NARRATOR BLOCK 4 - SPECIFIC CLIFFHANGER
- This is the final voiceover_only segment and the final segment of the output.
- Formula: [specific verified lie/excuse] + "However..." + [specific witness, object, dispatch call, document, location, or next verified action] + [concrete unresolved promise].
- End immediately before that later evidence or confrontation is revealed.
- The promised event must exist later in the source video. Do not invent Part 2 material.
- Never use generic AI phrases such as "everything was about to change", "the ultimate consequence was about to drop", or "what happened next shocked everyone".

### THREE DISTINCT VARIANTS
- Script 1: prioritize the strongest absurd, brazen, vulgar, or contradictory quote Hook.
- Script 3: prioritize the strongest visual-danger or shocking-discovery Hook.
- Script 4: prioritize the strongest moral contradiction, refusal, or consequence Hook.
- Do not clone the same Hook, narrator wording, source order, or cliffhanger across all variants unless the source genuinely contains only one viable verified option. Explain unavoidable reuse inside action_notes, never outside the JSON.

### AUDIO AND SOURCE-NARRATOR RULES
- Every script must set audio_strategy="hybrid" and voiceover_enabled=true.
- Exactly four segments must use voiceover_only. All other segments use original_audio.
- original_audio requires voiceover_text="".
- voiceover_only means the renderer ducks source audio to 20% for that segment.
- Never allow source narrator and tool narrator to overlap. When source_narrator_detected=true, use voiceover_only only if muting does not destroy indispensable scene dialogue or action sound.
- Never place narrator voice over an important command, confession, reaction, radio call, or unique quote.

### STORY, PACING, AND VISUAL GROUNDING
- Build one coherent causal story, not a montage of viral moments.
- Immediately after the Hook, establish concrete visual stakes as soon as the Police Report Intro permits.
- Preserve complete original-audio exchanges and action sequences. Do not split them merely to manufacture rhythm.
- Every narration claim and every transitionReason must be supported by the selected source frames, transcript, or source audio.
- End with the Specific Cliffhanger. Do not append credits, blank footage, silence, or another segment after it.

${voiceBlock}

### TIMELINE AND DURATION RULES
1. sourceStartSec/sourceEndSec refer only to the original source timeline.
2. startSec/endSec refer only to the output timeline and must be continuous from zero.
3. endSec-startSec=(sourceEndSec-sourceStartSec)/playbackSpeed.
4. Finalize source ranges and playbackSpeed first, then recalculate the complete output timeline using at least three decimal places.
5. Keep every source range inside its selected sceneId. Split at scene boundaries when necessary.
6. Every script must be at least 60.5 seconds. Add only relevant verified footage; never use filler, freezes, repetition, or dead air.
7. Obey the measured voice word budget for each of the four voiceover_only segments.

### REQUIRED ROOT AND SEGMENT CONTRACT
- Use the existing Highlight Cut schema without wrappers or arrays around the root.
- Every root must include artifactType="highlight_cut_script", prompt_profile="viral_police_blotter", its required scriptId, story_blueprint, and a non-empty segments array.
- Use existing scene_type/storyFunction values to identify the structure:
  * Hook_Original_Audio / hook
  * Police_Report_Intro / context
  * Shocking_Reveal / reveal
  * Moral_Contrast / consequence
  * Specific_Cliffhanger / outro
- Keep all existing fields required by the tool: id, evidenceId when available, sceneId, sourceStartSec, sourceEndSec, startSec, endSec, playbackSpeed, scene_type, storyFunction, transitionReason, source_narrator_detected, audio_mode, voiceover_text, caption, preview_vi, and action_notes.

### FINAL SELF-CHECK
- Exactly three independent JSON roots: Script 1, Script 3, Script 4.
- Every root has prompt_profile="viral_police_blotter".
- Every script has one original_audio Hook and exactly four voiceover_only narrator blocks in the required order.
- The Hook works in the first 0-3 seconds.
- Shocking Reveal is immediately paid off by matching visual evidence.
- Moral Contrast is evidence-grounded.
- Cliffhanger names a specific verified next element and ends before its reveal.
- Every script is at least 60.5 seconds and every timestamp satisfies the duration formula.

${buildGeminiThreeJsonCodeBlockContract()}`;
}

function buildIndependentPromptOptionsBlock(options = readIndependentPromptOptions()) {
  const hookLabels = {
    high_action: "high-adrenaline physical action or loud confrontation with a clear payoff",
    dialogue_conflict: "intelligible direct dialogue, accusation, denial, argument, or contradiction",
    psychological_wtf: "psychologically absurd, manipulative, entitled, bizarre, or self-incriminating statement",
    evidence_reveal: "verified discovery, evidence reveal, consequence, or visual twist"
  };
  const toneRules = {
    profile_default: "Preserve each Script's distinct narrator voice defined below.",
    cinematic: "Use concise cinematic true-crime American English, without bureaucratic police-report phrasing or unsupported hype.",
    genz: "Use fast conversational Gen-Z/Millennial internet English as the audience's inner voice, while keeping every underlying fact verified.",
    factual: "Use restrained, plain, objective American English. Prefer precise facts over dramatic adjectives."
  };
  const audioRules = {
    original_first: "Use the lowest useful amount of tool narration inside each Script's mandatory bridge limits. Preserve clean, high-value direct dialogue and action sound whenever it can carry the story.",
    balanced: "Balance concise tool narration with sustained clean source dialogue. Never replace protected original audio merely to increase narration coverage.",
    narrator_led: "Use the upper useful end of each Script's existing narration limits for verified context and causal bridges. Do not exceed mandatory bridge-count limits and never cover protected original audio."
  };
  const pacingRules = {
    fast: "Compress pauses and repetitive procedure aggressively, but preserve complete decisive lines, actions, and immediate reactions.",
    balanced: "Use varied pacing: concise transitions plus sustained complete exchanges when they carry tension or causality.",
    story_first: "Narrative comprehension outranks cut frequency. Preserve long complete exchanges or action runs whenever splitting them would weaken the story."
  };
  const endingRules = {
    verified_payoff: "End immediately after the strongest verified resolution, consequence, or current status.",
    payoff_comment: "Deliver the verified payoff first, then end with one concise evidence-grounded question that invites discussion.",
    grounded_open_loop: "Deliver every verified result promised by this standalone script, then open one unresolved evidence-grounded question. Never hide a known outcome."
  };
  const priority = normalizeIndependentHookPriority(options.hookPriority);
  const serializedOptions = {
    scriptCount: Math.max(1, Math.min(5, Number(options.scriptCount || 2))),
    hookPriority: priority,
    hookMaxSec: options.hookMaxSec,
    narratorTone: options.narratorTone,
    audioBalance: options.audioBalance,
    pacing: options.pacing,
    ending: options.ending,
    overlays: options.overlays,
    powerWords: options.powerWords,
    durations: options.durations
  };
  return `INDEPENDENT USER OPTIONS - APPLY TO EVERY REQUESTED INDEPENDENT SCRIPT:
INDEPENDENT_USER_OPTIONS_JSON_BEGIN
${JSON.stringify(serializedOptions, null, 2)}
INDEPENDENT_USER_OPTIONS_JSON_END

HOOK PRIORITY FALLBACK - MANDATORY:
1. Evaluate Hook categories in this exact order: ${priority.map((item, index) => `${index + 1}) ${item}: ${hookLabels[item]}`).join("; ")}.
2. A higher-priority category wins only when at least one candidate passes all qualification gates: cold-viewer comprehension in the first 3 seconds, verified timestamp/evidence, intelligible core action or words, no audible external source narrator, and a complete high-value beat within ${options.hookMaxSec} seconds.
3. If no candidate in one category passes every gate, fall through to the next category. Never force a weak action Hook merely because action ranks first, and never choose a quiet WTF quote when a higher-ranked complete action candidate passes.
4. A Hook may span consecutive scene boundaries and multiple JSON segments. Preserve one actionSequenceId and storyFunction="hook" until its decisive payoff and immediate reaction are complete.
5. Populate hook_selection_audit in every JSON root with requestedPriority, selectedType, fallbackLevel, selectedEvidenceIds, reason, and rejectedHigherPriorityCandidates. Every rejected higher category needs a concrete evidence-grounded reason.

NARRATOR TONE: ${toneRules[options.narratorTone] || toneRules.profile_default}
AUDIO BALANCE: ${audioRules[options.audioBalance] || audioRules.original_first}
PACING: ${pacingRules[options.pacing] || pacingRules.balanced}
ENDING: ${endingRules[options.ending] || endingRules.verified_payoff}
OVERLAYS: ${options.overlays ? "Populate top_header, caption emphasis, and concrete visual cues when supported." : "Keep optional overlay metadata empty; the story must work without title or visual-cue overlays."}
POWER WORDS: ${options.powerWords || "None supplied."} These are optional and may be used only when evidence and the selected tone support them.

These user options override soft editorial defaults below, but never override factuality, source-narrator muting, protected original audio, Actor Identity, Hook Transition, schema, timestamp, monetization minimum, or the requested file count.`;
}

function buildDirectHighlightGeminiPromptTemplate() {
  const voiceBlock = getCurrentVoiceCalibrationPromptBlock({
    coverageMax: 0.78,
    maxOnly: true,
    coveragePolicy: "Maximum-only guardrail for independent scripts. Write one or two concise spoken sentences only when narration adds verified context. Silence or clean source ambience is valid after the sentence ends; never add filler to occupy the window."
  });
  const sourceInput = el.sourceDownloadUrl?.value.trim() || "VIDEO_URL_OR_UPLOADED_VIDEO";
  const directOptions = {
    hookPriority: ["high_action", "dialogue_conflict", "psychological_wtf", "rage_irony", "evidence_reveal"],
    hookMaxSec: 30,
    narratorTone: "true_crime_documentary",
    audioBalance: "original_first",
    pacing: "story_first",
    ending: "payoff_comment",
    overlays: true,
    powerWords: "haunting, split-second decision, irreversible consequence, impossible excuse, the evidence changed everything, a routine stop, the ultimate tragedy",
    durations: {
      script1: { min: 60.5, max: 240 },
      script3: { min: 60.5, max: 240 },
      script4: { min: 60.5, max: 240 }
    }
  };
  return `You are an expert video analyst, true-crime storyteller, and viral TikTok short-form editor specializing in True-Crime Bodycam, dramatic recap content, and Mini-Documentary storytelling. You are a master of viewer psychology, retention hooks, "Curiosity Gap" framing, and the "Timeline Reset" narrative structure.

Goal: Build exactly 3 story-first viral JSON editing scripts: Script 1, Script 3, and Script 4. First create a coherent story blueprint, then select sustained source runs and evidence inside those runs. Never build a script by collecting or sorting isolated high-viralScore moments. Do not generate Script 2.

---

### INPUTS FROM USER
Paste the video URL or describe the uploaded video here:
[${sourceInput}]

${voiceBlock}

INDEPENDENT USER OPTIONS - APPLY TO SCRIPT 1, SCRIPT 3, AND SCRIPT 4:
INDEPENDENT_USER_OPTIONS_JSON_BEGIN
${JSON.stringify(directOptions, null, 2)}
INDEPENDENT_USER_OPTIONS_JSON_END

HOOK PRIORITY FALLBACK - MANDATORY:
1. Evaluate Hook categories in this exact order: 1) high_action; 2) dialogue_conflict; 3) psychological_wtf; 4) evidence_reveal.
2. A higher-priority category wins only when at least one candidate passes all qualification gates: cold-viewer comprehension in the first 3 seconds, verified timestamp/evidence, intelligible core action or words, no audible external source narrator, and a complete high-value beat within 30 seconds.
3. A Hook may span consecutive scene boundaries and multiple JSON segments.
4. Populate hook_selection_audit in every JSON root with requestedPriority, selectedType, fallbackLevel, selectedEvidenceIds, reason, and rejectedHigherPriorityCandidates.

---

### I. UNIVERSAL VIRAL FRAMEWORK FOR SHORT-FORM TRUE CRIME (60S+ OPTIMIZED)

CORE GOAL: Build a high-retention, psychology-driven video that ALWAYS exceeds 60.0 seconds.

1. THE CURIOSITY GAP HOOK (Flexible Duration: 4s - 30s):
   - IN MEDIA RES: Start exactly at the most explosive, confusing, or dramatic moment. No slow fade-ins.
   - CURIOSITY GAP TOP HEADER: The \`top_header\` MUST be a compelling, curiosity-inducing premise sentence that hints at the payoff without spoiling it (e.g., "This 911 Call Would Forever Haunt Officers", "16 Years Innocent, Then This Happened", or "How A Routine Ticket Ended In Tragedy"). NEVER use generic 2-word exclamations like "THE AUDACITY" or "CAUGHT ON CAMERA".
   - audio_mode: "original_audio" with 100% real scene sound and an empty voiceover_text.

2. THE "TIMELINE RESET" DOCUMENTARY SETUP (15s - 25s):
   - Immediately after the Hook, the video MUST execute a "Timeline Reset". Transition smoothly from the chaos of the Hook into a calm, authoritative True-Crime Documentary tone.
   - ABSOLUTE BAN ON CLICHÉS: NEVER begin the context with cheap recap phrases such as "Caught on camera", "Let's rewind", "Here's what happened", or "Watch this".
   - FORCED SENTENCE STARTER: The very first sentence of this Voiceover MUST begin with a factual setting. You must start by stating the date/time, the geographical location/department, OR a broad objective premise (e.g., "On [Date], officers in [Location]...", "A routine traffic stop for [Reason]...", or "The [Department] received a desperate call...").
   - VOICEOVER DURATION EXCEPTION: This specific setup Context VO may run continuously for 15 to 25 seconds. Use this time to establish the stakes, the identities of the people involved, and the mundane origin of the incident.
   - AUDIO DUCKING AWARENESS: Assume the renderer will duck the source audio to 20% volume during \`voiceover_only\`. Write a strong, continuous narrative that carries the quietened visual.
   - EMOTIONAL CALIBRATION: Adapt the narrator's tone to the specific reality of the video. If the video is tragic, use a haunting/somber tone. If it is enraging, frame the arrogance objectively. Never force a "villain" narrative if the suspect is a victim or wrongly accused.

3. PSYCHOLOGICAL & PHYSICAL ESCALATION (20s - 35s):
   - PRESERVE UNTOUCHED DIRECT DIALOGUE: Keep original_audio and leave voiceover_text empty for decisive quotes, arguments, commands, or bizarre excuses.
   - VOICEOVER BRIDGES: Outside the main Timeline Reset block, keep narrative bridges concise (under 12 seconds) to reconnect the viewer to the next original audio beat or explain a necessary time jump.
   - CHRONOLOGICAL VISUAL ANCHOR: The visual evidence selected for this Context VO MUST come from the calm, chronological beginning of the incident (e.g., the initial pull-over, the first knock on the door, or the mundane opening conversation). NEVER use post-climax or aftermath footage (like suspects already in handcuffs or walking away) to cover this historical setup.

4. UNEDITED CLIMAX & VERIFIED PAYOFF (15s - 25s):
   - All three independent scripts must ultimately deliver a verified resolution that directly answers the primary concrete stake introduced by their own Hook.
   - TWO-LAYER PAYOFF: First close the immediate victim/hazard/evidence question. Then, end with the verified later outcome (arrest, sentence, or legal consequence).
   - NO STATIC DEAD-AIR ENDINGS: Never end the video on static paperwork, text-only charge sheets, or blank screens. The visual evidence for the final payoff MUST be dynamic, moving bodycam or CCTV footage (e.g., the suspect in handcuffs, an officer debriefing, or the visual crime scene aftermath). If the tool narrator reads the final felony charges, it must be overlaid on active visual footage.

### STRICT DURATION & PACING RULES
- Minimum final output duration after playbackSpeed: ALWAYS >= 60.5 seconds.
- CONTEXT VOICEOVER ALLOWANCE: The primary setup voiceover_only segment may be up to 25.0 seconds to build the documentary world. All subsequent bridge voiceovers must remain under 12.0 seconds.
- ACTION SEQUENCE EXCEPTION: Keep an unbroken important action and immediate reaction as sustained original_audio.

### DURABLE EDITORIAL QUALITY CORE - INDEPENDENT SCRIPTS ONLY
- STORY SPINE: Build the entire video around answering ONE central viewer question created by the Hook. Preferred retention structure: CLIMAX TEASER (Hook) -> TIMELINE RESET (Context) -> ESCALATING CAUSAL EVENTS -> CLIMAX -> AFTERMATH/PAYOFF.
- NARRATION ARC: Write the continuous narration arc first. Consecutive narration beats must sound like one authoritative documentary storyteller continuing the same thought, not isolated scene descriptions.
- SHOW, DON'T TELL (VERBS OVER ADJECTIVES): Absolute ban on generic emotional summary phrases like "chaotic chain of events", "unimaginable tragedy", "escalated quickly", or "irreversible consequences". Write using strong active verbs and concrete nouns to describe the exact physical reality of this specific case (e.g., instead of "the situation became dangerous," write "he pulled a knife on the responding officer" or "she slammed the gas with three kids in the back").
- CLEAN NARRATOR POLICY: Set source_narrator_policy="forbidden". External YouTube/news narrators must never be audible.

### II. 3 DISTINCT SCRIPT ANGLES (THEMATIC FOCUS)
- Script 1: "Narrated Raw Reality" (scriptId=1)
  * NARRATED CLEAN-HYBRID: Fast, coherent narrator spine interrupted by the strongest clean quotes, impacts, and confrontations. Use multiple non-adjacent narrator beats to create a 60/40 Audio Sandwich pacing. Do not limit to 2-4 VOs; narrate to maintain pace and ensure Dead Air does not exceed 15s.
- Script 3: "The Viral Mini-Doc / Deep Dive" (scriptId=3)
  * Focus: Build a suspenseful investigative mini-documentary. Let important interrogation or confrontation runs breathe. Setup VO may be up to 25s.
- Script 4: "The 80/20 High-Retention Reality" (scriptId=4)
  * STORY-FIRST PRIORITY: Maximize original audio (target 50-65% clean original audio).
  * Structure: High-impact in-media-res hook -> Timeline Reset (Documentary Setup) -> Sustained original-audio escalation -> Specific Verified Payoff.
  * Tone: Objective, cinematic, and suspenseful. Let the verified factual contrast provoke the emotion.

### III. JSON TECHNICAL RULES
1. audio_mode: "voiceover_only" OR "original_audio". The renderer intentionally mutes the complete source soundtrack during voiceover_only.
2. sourceStartSec/sourceEndSec are timestamps from the ORIGINAL source video.
3. FINAL DURATION VALIDATION: every script must be at least 60.5 seconds.
4. Return exactly three independent Markdown JSON code blocks and nothing else (Script 1, Script 3, Script 4). Do not return Script 2.`;
}

function buildStorySpineHighlightPromptTemplate(promptOptions = {}) {
  const independentOptions = promptOptions.independent || readIndependentPromptOptions();
  const scriptIds = getRequestedIndependentScriptIds(independentOptions);
  const voiceBlock = getCompactVoiceCalibrationPromptBlock();
  return `You are a senior American true-crime/bodycam short-form editor. Your job is editorial reasoning, not renderer math.

================================================================================
DURABLE EDITORIAL QUALITY CORE - INDEPENDENT SCRIPTS ONLY
STORY SPINE COMPILER CONTRACT - HIGHEST PRIORITY
================================================================================

Create exactly ${scriptIds.length} standalone scripts with these IDs in this order: ${scriptIds.join(", ")}. Each script must tell a different complete, coherent story from the same verified source. Return exactly ${scriptIds.length} Markdown JSON code block${scriptIds.length === 1 ? "" : "s"} and no prose. Each block must contain one JSON object.

QUALITY HIERARCHY:
1. Central Viewer Question
2. Hook Promise
3. One causal story
4. Escalation
5. Return to the promised Climax
6. Immediate Payoff/Aftermath
7. Narration continuity
8. Pacing
9. Technical metadata

Do not trade levels 1-6 for scene count, jump count, audio ratio, word quota, motion score, or convenient timestamps.

EDITORIAL METHOD:
1. Watch the complete supplied proxy/video and inspect transcript plus locked evidence. Do not rely on action-candidates ranking as semantic truth.
2. Before choosing footage, define ONE centralViewerQuestion, ONE hookPromise, ONE primaryStoryline, the exact source Climax that fulfills the promise, the Payoff that answers the question, and a causalChain.
3. Select complete Narrative Beats, not scene fragments. A beat is a continuous source range that delivers one understandable action, exchange, discovery, reaction, or consequence. It may cross any number of consecutive scene-manifest boundaries.
4. Preferred shape: CLIMAX TEASER / HIGH-STAKES HOOK -> minimum rewind context -> cause -> escalation -> FULL promised climax -> immediate aftermath/payoff.
5. Every beat must state how it advances the same viewer question and why it follows the previous beat. Delete interesting footage that does not advance this story.
6. Write the complete narrationArc only after the beat order is locked. Narration must sound like one continuous storyteller who remembers what the viewer already knows. Never write isolated clip descriptions.
7. The local tool calculates output timestamps, scene spans, macro-block IDs, duration math, and renderer fields. Do not output startSec, endSec, outputStartSec, or outputEndSec.
8. HARD DURATION AUDIT: before returning each file, calculate sum((sourceEndSec-sourceStartSec)/playbackSpeed) across its final narrativeBeats. The sum must be inside that script's configured min/max range in INDEPENDENT_USER_OPTIONS_JSON. If it exceeds max, remove dead air, repeated proof, and secondary beats, then recalculate. Never return an over-limit script and never claim total_target_sec instead of auditing the actual ranges.

SEMANTIC HOOK TOURNAMENT - MUST RUN BEFORE STORY SELECTION:
- Build at least five verified Hook candidates spanning these semantic types when the source supports them: high_action, dialogue_conflict, psychological_wtf, rage_irony, and evidence_reveal.
- Score every candidate from 0-10 for immediateShock, coldViewerClarity, rageOrIrony, payoffPromise, and sourceAudioValue. Explain the exact quote/action in the first 3 seconds and provide verified sourceStartSec/sourceEndSec plus evidenceIds.
- A high_action candidate automatically FAILS when its first 3 seconds contain only driving, a moving patrol car, camera shake, sirens without a visible event, walking, or an establishing shot. Motion and decibels alone are never a Hook.
- action-candidates.json is discovery radar only. Its rank, motionScore, and audioEnergyScore must never determine the winner.
- Apply the user-selected priority order only after qualification. Within the first qualifying category, select the highest tournament score. Preserve a lower-priority candidate only when every higher-priority candidate fails a named gate.
- The winning Hook must create the centralViewerQuestion and promise a specific later Climax/Payoff. If it does not, reject it and choose another candidate.
- For the winner, identify triggerSourceSec at the exact first frame/word containing the command, impact, accusation, bizarre quote, reveal, or peak action. Set hookInPointSec no more than 0.5 seconds before that trigger. Never use a technical scene start when it contains driving, unbuckling, opening a door, walking, generic sirens, or approach footage before the real event.

VIRAL MOMENT INVENTORY - MUST PRECEDE THE TIMELINE:
- hookCandidates: the full tournament above.
- interactionGold: verified rage-bait, irony, bizarre excuses, sharp officer lines, contradictions, confessions, or emotionally revealing exchanges worth preserving as original_audio.
- payoffCandidates: verified physical, emotional, evidentiary, arrest, bond, charge, sentence, or current-status outcomes that can close the Hook promise.
- Each independent script must use at least one interactionGold moment when a clean verified one exists and must use the payoff candidate that directly answers its own centralViewerQuestion.

HOOK:
- Follow the user-selected Hook priority fallback below. A category may fall through only when no candidate passes intelligibility, source-narrator, and payoff gates.
- Preserve the shortest complete high-value beat. A strong action Hook may last up to ${independentOptions.hookMaxSec || 30}s and may span multiple technical scenes.
- The first second must contain the core action, accusation, quote, contradiction, evidence reveal, or consequence.
- original_audio only. Cut immediately before an external source narrator begins.
- The body must later return to the full event promised by the Hook. A teaser without its full climax is invalid.
- The later Climax must continue from the first meaningful frame not already revealed by the Hook. Direct source overlap and semantic repetition are different failures; use reprisePolicy="continue_after_teaser" and replay at most 0.5 seconds for handoff.

TRANSITION COVERAGE:
- Audit every boundary between Narrative Beats. A non-contiguous source jump must be resolved by a concise voiceover bridge, exact self-orienting direct dialogue, or a concrete visual anchor visible on both sides.
- Never label a transition visual_match merely because both beats use original audio. visualMatchAnchor is mandatory for visual_match; directDialogueAnchor is mandatory for direct_dialogue.
- Narration quantity is adaptive. Use exactly the bridges required for comprehension, not a fixed count or audio percentage.

SOURCE AUDIO AND NARRATION:
- original_audio is allowed only for direct officers, suspects, victims, witnesses, dispatchers, interviews, or clean action/ambient sound.
- External YouTube hosts/news/documentary narrators must never be audible. Use voiceover_only and verified replacement narration when their visuals are essential.
- voiceoverText must be empty for original_audio. voiceover_only requires concise English voiceoverText and fully mutes the source soundtrack.
- Every narrator beat MUST use voiceover_only. The renderer mutes the complete source soundtrack by default whenever tool narration plays. Do not request voiceover_with_ambient; only the user may opt back into source sound later in the Video Editing tab.
- Write narration for story continuity: context, cause, stakes, chronology, contradiction, or verified outcome. Do not describe an obvious on-screen action.
- Never invent names, motives, charges, diagnoses, outcomes, thoughts, remorse, or violence.

COHERENCE REJECTION GATE:
Reject and rebuild internally when any answer is NO:
- Does narrativeBeats contain at least one DISTINCT beat for each required role: hook, context, escalation, climax, and payoff?
- Is context represented by a real source range rather than silently replaced by a second payoff or aftermath beat?
- Does every beat advance the same centralViewerQuestion?
- Does each transition have a clear causal or explanatory link?
- Does the timeline return to the exact Climax promised by the Hook?
- Does Payoff directly answer the centralViewerQuestion?
- Does narrationArc read as one connected story rather than captions for separate clips?

SCRIPT ROLES:
- Script 1: Narrated Raw Reality. Use concise narration where context is required; do not create a source-audio-only montage.
- Script 3: Investigative causality. Reveal verified information in the order that most strongly changes viewer understanding.
- Script 4: Authenticity-led version. Preserve original audio when it carries emotional proof and keeps the story understandable. Every unresolved chronology, location, actor, or causal jump requires a concise bridge; raw audio is not a quota.
- Script 2: Dialogue-first confrontation. Build around the strongest complete verified exchange and use narration only for orientation or payoff.
- Script 5: Evidence and consequence. Build around the strongest verified discovery, contradiction, reaction, and consequence.

${buildIndependentPromptOptionsBlock(independentOptions)}

${voiceBlock}

REQUIRED ROOT SCHEMA FOR EACH REQUESTED FILE:
{
  "artifactType": "story_spine_edit_script",
  "schemaVersion": 2,
  "workflow": "manual_gemini_draft_review",
  "scriptId": 1,
  "prompt_profile": "independent",
  "title": "",
  "language": "en",
  "sourceLanguage": "en",
  "style": "True Crime Bodycam Highlight",
  "source_narrator_policy": "forbidden",
  "viralMomentInventory": {
    "hookCandidates": [{
      "candidateId": "hook_candidate_01",
      "hookType": "high_action|dialogue_conflict|psychological_wtf|rage_irony|evidence_reveal",
      "sourceStartSec": 0,
      "sourceEndSec": 8,
      "evidenceIds": ["evidence_0001"],
      "exactQuoteOrAction": "Exact verified words or visible action",
      "first3SecEvent": "What a cold viewer actually hears or sees immediately",
      "sourceNarratorPresent": false,
      "scores": { "immediateShock": 0, "coldViewerClarity": 0, "rageOrIrony": 0, "payoffPromise": 0, "sourceAudioValue": 0, "total": 0 },
      "qualification": "pass|fail",
      "rejectionReason": ""
    }],
    "interactionGold": [{ "momentId": "interaction_01", "evidenceIds": ["evidence_0002"], "sourceStartSec": 0, "sourceEndSec": 0, "exactQuoteOrAction": "", "whyItMatters": "" }],
    "payoffCandidates": [{ "momentId": "payoff_01", "evidenceIds": ["evidence_0010"], "sourceStartSec": 0, "sourceEndSec": 0, "verifiedOutcome": "", "answersViewerQuestion": "" }]
  },
  "hookTournamentAudit": {
    "candidateCount": 5,
    "winnerCandidateId": "hook_candidate_01",
    "winnerScore": 0,
    "runnerUpCandidateId": "hook_candidate_02",
    "runnerUpScore": 0,
    "selectionReason": "Why the winner is stronger in the actual first 3 seconds"
  },
  "hookTriggerAudit": {
    "verifiedAgainstHookAuditClip": false,
    "hookAuditFile": "",
    "triggerSourceSec": 0,
    "hookInPointSec": 0,
    "setupBeforeTriggerSec": 0,
    "triggerType": "command|impact|quote|accusation|reveal|peak_action",
    "exactTrigger": "",
    "autoTrimApproved": false
  },
  "teaserClimaxAudit": {
    "teaserEventId": "event_001",
    "climaxEventId": "event_001",
    "reprisePolicy": "continue_after_teaser",
    "climaxResumeSourceSec": 0,
    "allowedReplaySec": 0.5
  },
  "storyContract": {
    "centralViewerQuestion": "One concrete question created by the Hook",
    "hookPromise": "The exact event or truth the opening promises",
    "primaryStoryline": "The one causal story this edit follows",
    "climax": {
      "summary": "Exact source event that fulfills the Hook promise",
      "evidenceIds": ["evidence_0008"],
      "sourceStartSec": 0,
      "sourceEndSec": 0
    },
    "payoff": {
      "summary": "Immediate verified answer or aftermath",
      "evidenceIds": ["evidence_0010"],
      "sourceStartSec": 0,
      "sourceEndSec": 0
    },
    "causalChain": ["cause", "escalation", "climax", "payoff"]
  },
  "narrationArc": {
    "openingFrame": "How the narrator opens the same central question without spoiling it",
    "bridges": [{
      "bridgeId": "bridge_001",
      "previousBeatId": "beat_001",
      "nextBeatId": "beat_002",
      "transitionPurpose": "What the viewer must understand before the next beat",
      "voiceoverText": "Exact connected English narration, or empty when no bridge is needed"
    }],
    "closingAnswer": "How the ending resolves the opening question"
  },
  "beatCoverageAudit": {
    "hookBeatIds": ["beat_001"],
    "contextBeatIds": ["beat_002"],
    "escalationBeatIds": ["beat_003"],
    "climaxBeatIds": ["beat_004"],
    "payoffBeatIds": ["beat_005"],
    "allRequiredRolesPresent": true
  },
  "source_narrator_ranges": [],
  "narrativeBeats": [{
    "beatId": "beat_001",
    "sourceStartSec": 0,
    "sourceEndSec": 10,
    "playbackSpeed": 1,
    "storyFunction": "hook|context|escalation|climax|payoff",
    "narrativePurpose": "hook_teaser|rewind_context|cause|escalation|climax_return|aftermath_payoff|indispensable_bridge",
    "summary": "What this complete beat contributes",
    "advancesViewerQuestion": "How this beat moves closer to the answer",
    "causalLinkFromPrevious": "Why this beat follows the previous beat; opening promise for beat_001",
    "transitionExplainedBy": "none|voiceover|direct_dialogue|visual_match",
    "bridgePurpose": "none|context|causal|time_jump|payoff",
    "visualMatchAnchor": "Concrete shared visual anchor, required for visual_match",
    "directDialogueAnchor": "Exact self-orienting source words, required for direct_dialogue",
    "actionSequenceId": "",
    "teaserEventId": "",
    "climaxEventId": "",
    "reprisePolicy": "continue_after_teaser|no_reprise",
    "climaxResumeSourceSec": null,
    "relevanceToPrimaryStory": "strong",
    "evidenceIds": ["evidence_0001"],
    "audioMode": "original_audio|voiceover_only|voiceover_with_ambient",
    "voiceoverText": "",
    "sourceAmbientVolume": 0.15,
    "sourceNarratorDetected": false,
    "previewVi": "Vietnamese preview summary",
    "actionNotes": "Verified editor note"
  }]
}

FILE RULES:
- Return only these requested script IDs, in this order: ${scriptIds.join(", ")}.
- Every file needs at least one DISTINCT hook, context, escalation, climax, and payoff beat. A second payoff/aftermath beat never substitutes for context.
- Before returning each JSON block, populate beatCoverageAudit from the FINAL narrativeBeats array and verify allRequiredRolesPresent=true. If any role array is empty, rebuild that script before responding.
- Context must give a cold viewer the minimum verified who/where/why needed to understand escalation. Even when the Hook begins at source time zero, include a separate non-overlapping context beat unless the source truly contains no additional context; never silently omit the role.
- sourceStartSec/sourceEndSec must be verified against the original source timeline and stay inside the source duration.
- evidenceIds must exist in locked evidence when that file is supplied.
- viralMomentInventory.hookCandidates must contain at least five audited candidates, hookTournamentAudit must name the winner, and the first hook beat must use that winner's verified source range.
- Validate each JSON object with JSON.parse before responding.

${buildGeminiThreeJsonCodeBlockContract(scriptIds)}`;
}

function buildUiGeminiInputAccessGate() {
  return `STEP 0 - VERIFIED INPUT ACCESS GATE (SUPREME; RUN FIRST)
- Inventory and actually open every uploaded video, proxy chunk, scene-manifest.json, transcript, action-candidates.json, evidence, blueprint, or review-context file required by this prompt.
- A visible filename, thumbnail, citation, truncated preview, prior chat, URL title, or action score is not proof that the content was read.
- Verify that source identity, duration, timestamps, IDs, transcript coverage, and proxy coverage match. Proxy chunks are valid only when their combined source ranges cover the claimed timeline.
- Never infer missing dialogue, visuals, actions, people, chronology, evidence, or outcomes.
- If anything required is missing, unreadable, truncated, mismatched, or has an unexplained coverage gap, STOP and return one JSON code block only:
{"artifactType":"gemini_input_access_failure","schemaVersion":1,"stage":"highlight_prompt","accessGranted":false,"missingInputs":[],"unreadableInputs":[],"coverageGaps":[],"mismatchDetails":"","recommendedAction":""}
- On success, every root output JSON must include inputAccessAudit with accessGranted=true, truthful accessMode, inspectedInputs, sourceIdentityMatched=true, timelineCoverageVerified=true, and noGuessingConfirmed=true.`;
}

function withUiGeminiInputAccessGate(prompt = "") {
  const value = String(prompt || "").trim();
  return value.includes("STEP 0 - VERIFIED INPUT ACCESS GATE")
    ? value
    : `${buildUiGeminiInputAccessGate()}\n\n${value}`;
}

function buildHighlightGeminiPromptTemplate() {
  let prompt;
  if (isHighlightCutMode()) {
    prompt = buildDirectHighlightGeminiPromptTemplate();
    return withUiGeminiInputAccessGate(prompt);
  }
  const promptOptions = readManualGeminiPromptOptions();
  if (promptOptions.profile === "viral_tiktok_crime_part1") {
    prompt = buildViralTikTokCrimePart1PromptTemplate(promptOptions);
    return withUiGeminiInputAccessGate(prompt);
  }
  if (["serialized_interleaved", "serialized_genz"].includes(promptOptions.profile)) {
    prompt = buildSerializedHighlightGeminiPromptTemplate(promptOptions);
    return withUiGeminiInputAccessGate(prompt);
  }
  if (promptOptions.profile === "viral_police_blotter") {
    prompt = buildPoliceBlotterHighlightGeminiPromptTemplate();
    return withUiGeminiInputAccessGate(prompt);
  }
  if (promptOptions.profile === "independent") {
    prompt = buildStorySpineHighlightPromptTemplate(promptOptions);
    return withUiGeminiInputAccessGate(prompt);
  }
  const voiceBlock = getCurrentVoiceCalibrationPromptBlock({
    coverageMax: 0.78,
    maxOnly: true,
    coveragePolicy: "Maximum-only guardrail for independent scripts. Write one or two concise spoken sentences only when narration adds verified context. Silence or clean source ambience is valid after the sentence ends; never add filler to occupy the window."
  });
  const independentOptions = promptOptions.independent || readIndependentPromptOptions();
  const independentOptionsBlock = buildIndependentPromptOptionsBlock(independentOptions);
  prompt = `You are an expert video analyst, true-crime storyteller, and viral TikTok short-form editor specializing in Bodycam Cops and dramatic recap content. You are a master of viewer psychology, retention hooks, rage-bait narrative framing, moral contrast, and cinematic "Villain Edit" storytelling.

Goal: Build exactly 3 story-first viral JSON editing scripts: Script 1, Script 3, and Script 4. First create a coherent story blueprint, then select sustained source runs and evidence inside those runs. Never build a script by collecting or sorting isolated high-viralScore moments. Do not generate Script 2.

---

### INPUTS FROM USER
Paste the video URL or describe the uploaded video here:
[VIDEO_URL_OR_UPLOADED_VIDEO]

${voiceBlock}

${independentOptionsBlock}

---

### I. UNIVERSAL VIRAL FRAMEWORK FOR SHORT-FORM TRUE CRIME (60S+ OPTIMIZED)

CORE GOAL:
Build a high-retention, psychology-driven video that ALWAYS exceeds 60.0 seconds for monetization. Use outrage, suspense, disbelief, moral contrast, and contradiction to maximize watch time and discussion. You may make strong editorial inferences about arrogance, defiance, lack of empathy, panic, or refusal when visible behavior and dialogue create that clear impression. Do not invent external events, charges, outcomes, diagnoses, or source facts. Every final output must be at least 60.5 seconds after playbackSpeed is applied.

1. THE COLD-VIEWER HOOK (Flexible Duration: 4s - ${independentOptions.hookMaxSec}s):
   - MANDATORY: Scan the ENTIRE source for qualified candidates in every user-ranked Hook category. Apply HOOK PRIORITY FALLBACK exactly; select the first category containing a candidate that passes every qualification gate, then choose the strongest candidate inside that category. Do not replace the requested ordering with motion/audio scores or personal preference.
   - SEMANTIC + ACTION PRIORITY: Read and listen to the raw transcript/SRT first, then inspect every supplied candidate timestamp visually. Local candidate ordering is not an editorial ranking. Never discard the decisive climax of a strong action Hook merely because it crosses a scene boundary.
   - COLD-VIEWER COMPREHENSION GATE: A viewer with no prior knowledge must understand at least two of these within the first 3 seconds: who is involved, what accusation/action/conflict is occurring, and what object/person/stake matters. The top_header may supply only concise verified orientation; it may not repair a fundamentally unintelligible audio cut.
   - IN MEDIA RES WITHOUT ORPHANED CONTEXT: Starting mid-exchange is allowed, but never start mid-clause when the result is an orphaned pronoun, object, or reference such as "he", "she", "it", "that", "the keys", or "the crime" with no immediately visible or audible referent. Preserve the shortest intelligible phrase containing the core shock.
   - CONTINUOUS HOOK MACRO-BLOCK: If one complete Hook crosses consecutive scene boundaries, keep it as one editorial segment with one continuous sourceStartSec/sourceEndSec range and list every crossed scene in sceneIds. Preserve the decisive action and immediate reaction. Scene boundaries are technical metadata; the local tool compiles and validates the render timeline.
   - audio_mode: "original_audio" with 100% real scene sound and an empty voiceover_text.
   - The very first second MUST contain the core selected action, quote, accusation, denial, manipulation, confrontation, evidence reveal, or consequence. Do not pad the Hook backward with polite, procedural, or generic lead-in sentences.
   - NEVER begin with context, static warning screens, title cards, Patreon/credit screens, long 911 waveform visuals, or silence.
   - SOURCE NARRATOR BOUNDARY: If the chosen Hook immediately precedes an external source narrator, cut the Hook exactly before that narrator begins. Do not abandon a powerful Hook merely because a narrator speaks afterwards; end the original_audio range and transition to the next block.

2. THE "VILLAIN EDIT" CONTEXT DROP-IN (10s - 18s):
   - Immediately after the Hook, the context block MUST show the visual evidence of the crime, danger, injury, weapon, crash, trapped person, or other concrete stakes that the Hook implies, when that evidence exists in the locked source. Do not spend the first 30 seconds on talking heads while the consequence remains unseen.
   - Transition smoothly from the Hook into verified backstory using useful CCTV/surveillance footage, a brief 911 excerpt, bodycam setup, or another concrete source-grounded context block. Visual stakes outrank a second generic argument clip.
   - Actively infer and frame the suspect's apparent psychological state: arrogance, lack of empathy, defiance, panic, or refusal, based on visible resistance, words, choices, and reactions. Use moral contrast to maximize emotional investment, for example: "Instead of showing remorse, she chose to fight."
   - Treat this as forceful editorial framing, not a clinical diagnosis or a claim about hidden facts. Do not dilute a clear behavioral contrast into neutral police-report wording.
   - Use high-impact language such as "chilling excuse", "chaotic assault", "absolute disbelief", "bizarre logic", "terrifying footage", "reckless decision", or "catastrophic breaking point" to build tension before the matching scene.
   - Keep narration fast, specific, psychologically engaging, and visually grounded. Enter the main bodycam action as quickly as comprehension permits.
   - NEVER use vlogger phrases such as "Let's rewind", "Let's rewatch", or break the fourth wall.
   - Preserve unique authentic dialogue as original_audio; use voiceover_only only when the selected evidence can safely have its source audio muted.

3. PSYCHOLOGICAL & PHYSICAL ESCALATION (20s - 35s):
   - PRESERVE UNTOUCHED DIRECT DIALOGUE: When a suspect, officer, dispatcher, victim, or witness delivers a bizarre, funny, shocking, or decisive quote, keep original_audio and leave voiceover_text empty. An external host/news/documentary narrator is never direct scene dialogue and must not be preserved.
   - PSYCHOLOGICAL OVERRIDE: A verified blatant lie, arrogant smirk, defiant refusal, emotional breakdown, chilling confession, or immediate visual contradiction can be as retention-worthy as physical action. Preserve the strongest intelligible quote/action and its useful reaction; a full setup is optional when the Hook already enters mid-exchange.
   - SLOW-MOTION EFFECT: For a genuinely split-second physical action such as drawing a weapon, a sudden reach, impact, takedown, or physical confrontation, playbackSpeed MAY be set between 0.5 and 0.75.
   - Use slow motion only when frame-by-frame inspection adds real understanding. Do not slow ordinary walking, static footage, dialogue, warning screens, or weak B-roll merely to reach 60.5 seconds.
   - A slow-motion analysis segment may use voiceover_only only when muting the source does not remove essential dialogue or sound. action_notes must name the exact physical action being analyzed and why slow motion is justified.
   - Declare playbackSpeed only when slow motion is editorially justified. The local tool calculates the resulting output duration and timeline.

4. UNEDITED CLIMAX & VERIFIED PAYOFF (15s - 25s):
   - All three independent scripts must ultimately deliver a verified resolution that directly answers the primary concrete stake introduced by their own Hook. These are standalone variants, not Part 1/2/3 chapters.
   - VICTIM-FIRST OUTCOME: If the Hook puts a victim, child, hostage, missing person, injury, crash, weapon, or other immediate hazard at stake, show or explicitly state that verified immediate outcome before shifting to the suspect's later arrest, surrender, court result, or legal status. A suspect payoff never substitutes for a victim-safety payoff.
   - Script 1 delivers the raw verified resolution with 100% original_audio.
   - Scripts 3 and 4 may use a specific open loop immediately before the final payoff, but they must answer that loop before the video ends. Do not withhold the central outcome merely to tease a continuation.
   - The final payoff must be supported by later source/evidence. Never fabricate a twist, charge, death, confession, sentence, or legal result.
   - A final discussion question is allowed only after the verified payoff and must not imply that a known outcome is still unresolved.
   - TWO-LAYER PAYOFF: First close the immediate victim/hazard/evidence question with the strongest visual proof. Then, when the source explicitly verifies a later arrest, sentence, legal result, or current status, end with that verified final outcome. Never treat the primary rescue/safety payoff as permission to omit a known legal consequence.
   - PAYOFF COMPLETION GATE: When story_blueprint.storySpine.finalOutcomeRequired=true or narrative_contract.secondaryPayoff.required=true, the final meaningful segment MUST deliver the verified sentence, legal result, arrest status, or current status. Never end abruptly on a suspect's excuse, interview answer, or cliffhanger. Macro-block, jump, narrator, and audio-ratio references cannot remove this final outcome.
   - If no later outcome is explicitly verified in the supplied source, set finalOutcomeRequired=false and do not invent one.
   - Cut immediately when the verified payoff or concise discussion question lands. NEVER retain blank screens, Patreon/credits, unrelated outros, empty audio padding, or dead-air at the end.

### STRICT DURATION & PACING RULES
- Minimum final output duration after playbackSpeed: ALWAYS >= 60.5 seconds.
- If a plan is under 60.5 seconds, DO NOT stretch silence, freeze frames, warning screens, credits, or empty source audio.
- Reach the minimum only by adding relevant bodycam/CCTV/source angles that strengthen context or causality, preserving a longer complete exchange, or applying justified 0.5-0.75 slow motion to a key split-second action.
- Script 3 voiceover_only segments may not exceed 12.0 seconds. Script 4 voiceover_only segments may not exceed 8.0 seconds.
- Outside the in-media-res Hook, preserve complete setup -> decisive action/dialogue -> immediate reaction beats. Do not scatter shallow 2-3 second interruptions merely to manufacture pace.
- For voiceover_only, prefer evidence whose sourceAudioType is ambient_sfx/music or whose sceneDialoguePresent=false. The renderer mutes source audio completely for these segments.
- VISUAL ACTION VALUE: Major physical events such as escape, vehicle theft, pursuit, struggle, crash, weapon draw, forced entry, takedown, panic, or an immediate physical reaction are high-value candidates. They outrank transcript density and ordinary dialogue only when the user-ranked Hook order reaches high_action and the candidate passes every qualification gate.
- ACTION SEQUENCE EXCEPTION: Keep an unbroken important action and immediate reaction as sustained original_audio. Do not interrupt it with tool narration or split it merely to satisfy an 8-12 second pacing target. There is no fixed maximum while the action continues to escalate; cut only at a natural lull, repetition, or loss of story value.

### VISUAL GROUNDING & SRT EVIDENCE (MANDATORY)
- Inspect the visual action throughout every selected source range frame by frame, not only the first frame or thumbnail.
- Cross-check the overlapping SRT/dialogue and original audio before writing voiceover_text, preview_vi, caption, or action_notes.
- Every action_notes value MUST identify the exact visible subject, specific action, relevant object/location, meaningful visual change, and the exact dialogue or sound cue when available.
- Voiceover may use concise emotional build-up without explaining every physical movement. If the overall scene clearly supports the emotional weight, phrases such as "the situation spirals out of control", "chaotic assault", or "absolute disbelief" may bridge directly into the matching action.
- action_notes must remain technically specific for the editor, but voiceover_text should sound cinematic rather than like an evidence report.
- Write concrete observations such as who reaches for which object, who changes position, what appears on screen, what an officer physically does, and which exact spoken line causes the reaction.
- Avoid empty filler, but allow concise emotional bridges such as "the situation escalates beyond control" when the following scene immediately pays off that promise.
- If a claimed detail cannot be verified in the proxy frames, SRT, or source audio, do not include it and do not select that range as evidence for the claim.
- The narration must explain the story using verified details without merely describing isolated scenes one by one.

### DURABLE EDITORIAL QUALITY CORE - INDEPENDENT SCRIPTS ONLY

These rules are stable quality gates for the three independent variants. Apply them before applying a variant's thematic angle. Do not trade factual continuity for clip density.

STORY SPINE - HIGHEST EDITORIAL PRIORITY:
- Before selecting any footage, identify ONE central viewer question created by the Hook.
- Build the entire video around answering that question. Every selected segment must increase the stakes, reveal new information, escalate the conflict, move closer to answering the question, deliver the promised climax, or provide the immediate aftermath/payoff.
- Preferred retention structure: CLIMAX TEASER / HIGH-STAKES HOOK -> brief rewind/context -> escalating causal events -> return to the promised climax -> immediate aftermath/payoff.
- Remove footage that is interesting but does not advance this story. Do not abandon the primary question opened by the Hook in order to show a secondary twist, arrest, or legal outcome.
- Before segments, populate story_blueprint.storySpine with centralViewerQuestion, hookPromise, rewindContext, escalationPath, climax, climaxEvidenceIds, payoff, and payoffEvidenceIds.
- centralViewerQuestion and hookPromise must match narrative_contract.primaryAudienceQuestion and narrative_contract.hookPromise. climaxEvidenceIds must identify the event that fulfills the opening promise; payoffEvidenceIds must identify the verified answer or emotional aftermath.
- Every segment must contain narrativePurpose: hook_teaser, rewind_context, context, escalation, climax_return, aftermath_payoff, or indispensable_bridge.
- If the final timeline does not fulfill hookPromise and answer centralViewerQuestion, reject it internally and rebuild it before returning JSON.
- STORY HIERARCHY: story question -> Hook/promise -> causal story -> escalation -> climax/payoff -> original audio vs narrator -> pacing -> technical constraints. Resolve conflicts in that order, except factuality and renderer-valid timestamps always remain mandatory.

NARRATION ARC - STORY CONTINUITY ENGINE:
- After locking storySpine but before selecting the final source ranges, write one continuous narration_arc for the whole script. It must define the narrator's opening frame, the new fact or tension added by each narration beat, the question handed to the next source-audio beat, and the final answer/payoff.
- Narration is not restricted to emergency transition glue. It may lead the story, compress routine procedure, frame a verified contradiction, raise stakes, and set up the next authentic quote or action. It must never repeat an obvious visual, invent motive, or replace indispensable direct source audio.
- Every voiceover_only segment must reference exactly one narrationBeatId from narration_arc. Consecutive narration beats must sound like one storyteller continuing the same thought, not unrelated descriptions of individual clips.
- Write the narration arc first, then place protected original-audio proof moments inside it. The final alternation should feel intentional: narrator creates a question or expectation -> authentic footage proves, contradicts, or escalates it -> narrator advances the same central question.
- Narration-density percentages are soft editorial profiles, never word-filling quotas. Use fewer words when a concise line is stronger. Do not generate filler merely to occupy a source window.

0. THREE INDEPENDENT SCRIPT INVARIANTS - APPLY TO SCRIPT 1, SCRIPT 3, AND SCRIPT 4:
   - ACTOR IDENTITY FIRST: Before choosing any Hook or segment, build a stable actor_identity_map from the complete proxy and transcript. Reuse the same actorId for the same person across all three scripts. Every segment must declare actor_ids, primary_actor_id, and speaker_actor_id. Never let narration grammatically attach one person's action or consequence to another person.
   - COLD VIEWER: Every Hook must pass the COLD-VIEWER COMPREHENSION GATE above. Populate hook_cold_viewer_test before creating the rest of each script.
   - HOOK TRANSITION GATE: Judge the Hook together with the first 15 output seconds after it. Populate hook_transition_test. A consequence/aftermath Hook may reset to Context only when the next block explicitly identifies the people, their verified relationship, and why the timeline reset answers the Hook. Reject any transition that introduces a different actor with a generic bridge such as "Police arrived" or "things escalated". When the reset cost is high, prefer a slightly weaker linear-action Hook that preserves comprehension.
   - CLEAN NARRATOR POLICY: Set source_narrator_policy="forbidden" for all three scripts. External YouTube hosts, news anchors, documentary narrators, and recap narrators must never be audible in original_audio.
   - STORY-DRIVEN NONLINEAR ORDER: The Hook may come from anywhere. After the Hook, use the minimum Context needed, then order source beats by the causal and emotional logic of storySpine. Chronological order is preferred when equally strong, but backward or forward thematic jumps are allowed when they reveal new information, escalate the same conflict, return to the promised climax, or deliver payoff.
   - EXPLICIT JUMP CONTRACT: Every non-contiguous or backward source jump must declare a concrete transitionReason. When the pictures or direct dialogue cannot explain the jump immediately, place a voiceover_only narration beat before or on the new visual. Random peak montages, repeated facts, unresolved identity changes, and jumps to a secondary story remain forbidden.
   - SELECTED SOURCE ONLY: Every rendered picture must come from the segment's declared sourceStartSec/sourceEndSec. Never request invented B-roll, stock footage, reconstructed CCTV, or an unrelated visual substitute.
   - STANDALONE PAYOFF: Each script is a complete independent video and must deliver its verified consequence/payoff before ending.
   - NARRATIVE CONTRACT: Before selecting segments, populate narrative_contract with hookPromise, primaryAudienceQuestion, primaryStakeType, stakeActorIds, mandatoryResolution, and optional secondaryPayoff. Every mandatoryResolution.evidenceId must appear in the timeline before any later-time payoff.
   - NO OPEN STAKE BEFORE TIME JUMP: Do not use a "later", "months later", surrender, court, sentence, or final legal block while mandatoryResolution remains open. Close the immediate physical/victim stake first, then bridge the time jump.

1. SEMANTIC PAYOFF SCAN:
   - Before selecting any timeline, scan the complete transcript, source audio, proxy, and locked evidence for direct confessions, bizarre excuses, explicit contradictions, evidence reveals, authority/status irony, decisive accusations, and verified consequences.
   - Choose by semantic meaning and causal importance, not by any local candidate order. A quiet verified confession or contradiction may outrank a loud generic struggle.
   - Build root semantic_must_include_candidates before building segments. Each candidate must contain evidenceId, sceneId, sourceStartSec, sourceEndSec, speakerRole, semanticType, exactQuoteOrFact, semanticImpactScore from 0-10, and mustInclude.
   - Each script must include its strongest relevant semantic candidate unless its own editorial profile forbids that payoff or including it would break factual continuity. Record a concrete omissionReason for every omitted mustInclude candidate; "pacing" alone is not sufficient.

2. SPEAKER AND SOURCE-NARRATOR CLASSIFICATION:
   - Do not assume every SRT line is direct scene dialogue. Verify picture and sound, then classify each selected spoken interval as officer, suspect, victim, witness, dispatcher, source_narrator, or unknown.
   - Populate speaker_role and speech_type for every segment containing speech. speech_type must be direct_scene_dialogue, source_narration, mixed_speech, ambient_action, or unknown.
   - For voiceover-enabled Script 3 and Script 4, original_audio is allowed only when the speech belongs to direct participants or the range contains clean authentic action/ambient sound. If classification remains unknown, do not claim a quote or speaker identity that the evidence cannot prove.
   - For all three independent variants, original_audio is permitted only for direct_scene_dialogue or ambient_action with source_narrator_detected=false and no overlap with source_narrator_ranges.
   - If a valuable visual contains external source narration, prefer a clean neighboring range. When the visual is essential, set audio_mode="voiceover_only", mute the complete source soundtrack, and recreate only verified information using the selected tool voice.
   - Never trust an SRT line alone to prove speaker identity. If speaker_role or speech_type remains unknown, do not use that spoken interval as original_audio.

2A. ORIGINAL AUDIO VALUE GATE:
   - Populate original_audio_value_score, original_audio_value_reason, and original_audio_protected for every segment after listening to its complete source range.
   - Set original_audio_protected=true for an indispensable direct quote, bizarre denial, accusation, confession, command, emotional reaction, impact, radio call, or uninterrupted confrontation. If protected and free of external source narration, audio_mode MUST be original_audio and voiceover_text MUST be empty.
   - A narration bridge may explain identity, relationship, chronology, hidden context, or consequence, but it may not replace the authentic line that proves the claim. Place the bridge before or after the protected range.
   - External source narration is never protected. Essential visuals covered by an external narrator remain voiceover_only with the source soundtrack muted.

3. NATURAL AMERICAN ENGLISH QA:
   - Write spoken American English, not police-report prose, an evidence memo, or generic AI narration.
   - Every voiceover sentence must be grammatically complete, immediately understandable when heard once, and preferably express one main idea using a clear subject-verb-object structure.
   - Prefer short sentences. Avoid sentences over 28 words unless splitting them would damage a necessary quotation or causal statement.
   - ABSOLUTE POLICE-REPORT LANGUAGE BAN: Never use "officially charged with multiple serious felonies", "officially slapped with", "law enforcement personnel", "the individual", "the incident", "subsequently", "upon arrival", "according to authorities", "an official investigation quickly linked", "now faces losing her badge forever", or similarly bureaucratic phrasing.
   - Replace bureaucratic prose with concise conversational facts. Example: use "Prosecutors charged her with three felonies" only when the evidence verifies that exact count; otherwise state only the verified consequence without embellishment.
   - Remove redundant intensifiers, stacked legal phrases, vague hype, and generic endings such as "everything was about to change", "the ultimate consequence was about to drop", or "absolute instant karma".
   - Legal outcomes must be concise, accurately attributed, and supported by evidence. Internally read every voiceover_text aloud once and repair awkward grammar before returning JSON.

4. COGNITIVE PACING AND PAYOFF SPACE:
   - Do not introduce more than two new locations, timelines, or major facts inside any 10-second output window.
   - After a major confession, contradiction, evidence reveal, or accusation, preserve enough of the immediate reaction for a cold viewer to understand why it matters.
   - Compress repetitive procedural dialogue and silence, but never cut the decisive line, answer, or immediate reaction merely to maintain audio alternation.
   - TIKTOK PACING FILTER: Strictly exclude routine police procedure that lacks intense emotion, direct conflict, contradiction, or unique evidence, including requests for written statements, paperwork, phone numbers, spelling names, forms, report details, and routine station instructions. These are retention dead zones, not context or payoff.
   - VISUAL PROOF SEARCH PASS: Independently scrub the complete source/proxy for quiet or dialogue-light visual proof of rescue, victim safety, recovered evidence, crash aftermath, removed hazard, or physical consequence. Transcript density, loudness, and motion ranking must not decide this search. A quiet visual of the victim safe outranks a loud verbal confirmation.
   - CONTROLLED MICRO-CUTS: Source ranges of 1.5-4 seconds are allowed as separate segments for a verified impact, reaction, evidence insert, visual proof, contradiction, or Hook montage beat. Populate microCutPurpose for each one. Do not use micro-cuts for routine movement, incomplete dialogue, filler, or more than three consecutive beats outside the Hook.

5. RENDERER CAPABILITY GATE:
   - Build the core story only from verified source footage, source audio, tool voiceover, playbackSpeed, captions, the shared top banner, and metadata fields supported by the supplied schema/capability file.
   - Never depend on generated evidence images, fake product layouts, reconstructed CCTV, invented tracking, or an unsupported visual composite to make the story understandable.
   - When an effect is unsupported, select a truthful source visual that communicates the same verified fact. action_notes may recommend an optional enhancement, but the script must remain coherent if that enhancement is ignored.

6. FINAL EDITORIAL SELF-CHECK:
   - Reject any draft that lacks a clear Hook -> Context -> Escalation -> Payoff causal chain.
   - Reject any draft whose Hook fails hook_cold_viewer_test, whose nonlinear jump lacks a concrete story purpose/transition, or whose original_audio overlaps source narration.
   - Reject any draft whose narration_arc is a list of disconnected scene descriptions instead of one continuous setup -> escalation -> climax -> payoff story.
   - Reject Script 1 when it has fewer than two non-adjacent voiceover_only beats, when it lacks a narrator-led rewind/context or causal bridge before the promised Climax, or when its only tool narration is a final charge/sentence line.
   - Reject any draft whose strongest verified semantic payoff was accidentally trimmed, paraphrased away, or replaced by weaker generic narration.
   - Reject any voiceover that merely repeats an obvious visual without adding verified context, stakes, contradiction, causality, or consequence.
   - Reject any script whose finalPayoff answers a different question from narrative_contract.primaryAudienceQuestion, or whose mandatory resolution evidence is absent or placed after a later-time suspect/legal payoff.
   - Reject any script that uses verbal-only resolution while narrative_contract.mandatoryResolution.visualFirstRequired=true and preferredVisualEvidenceIds are available. Show the strongest verified physical rescue/safety/aftermath proof before using dialogue as reinforcement.
   - Reject any script that omits story_blueprint.storySpine.finalOutcomeEvidenceIds or narrative_contract.secondaryPayoff.evidenceIds when the corresponding required flag is true. The final meaningful segment must deliver that verified outcome.
   - Reject evidence marked proceduralBloat=true unless it contains indispensable conflict or proof unavailable in a stronger source range.
   - Reject unexplained police codes, radio shorthand, street callouts, or procedural jargon that a cold viewer cannot decode. Omit the weak range or add one concise bridgePurpose="jargon_clarity" explanation.
   - Revise internally until the script passes these checks; do not explain the revision outside the required JSON files.

---

### II. REQUESTED INDEPENDENT SCRIPT ANGLES (THEMATIC FOCUS)
Create only the requested script IDs listed at the top of this prompt. Keep every requested output distinct and do not renumber script IDs.
- Script 1: "Caught in 4K / Narrated Raw Reality"
  * PROFILE: Set scriptId=1. HARD RANGE ${independentOptions.durations.script1.min}-${independentOptions.durations.script1.max} seconds. Approximately 4-6 macro-blocks and 4 or fewer major source jumps are useful references, not quotas. Use the shortest complete causal story that fulfills storySpine.
  * NARRATED CLEAN-HYBRID: Always set top-level audio_strategy="clean_hybrid", voiceover_enabled=true, and source_narrator_policy="forbidden". Script 1 must never be source-audio-only.
  * NARRATOR-LED PROFILE: Build a fast, coherent narrator spine, then interrupt it with the strongest clean quotes, commands, reactions, radio calls, impacts, and confrontations as proof. Narration may handle Context, contradiction, chronology, stakes, escalation, jargon clarity, and Payoff.
  * NARRATOR PRESENCE GATE: Use multiple non-adjacent voiceover_only beats to build a 60/40 Audio Sandwich. You must narrate frequently to prevent Dead Air (original audio without VO) from exceeding 15 continuous seconds. At least one must provide rewind/context or an indispensable causal bridge after the Hook and before the promised Climax; at least one later beat must advance escalation, resolve a stake/transition, or deliver verified Payoff.
  * Clean audio includes direct participant dialogue, dispatch/radio, reactions, breathing, sirens, and ambient action; it excludes every external host or documentary narrator.
  * Every voiceover_only beat must add verified context, expose a contradiction, explain a necessary source jump, raise stakes, or deliver Payoff. Never narrate an action that is already obvious and never replace an indispensable quote, command, confession, reaction, radio call, or impact.
  * If an essential visual contains source narrator, keep the visual, mute the complete source soundtrack, and faithfully recreate only verified narrator facts with the selected tool voice.
  * The Hook may be selected from anywhere. After minimum Context, thematic jumps are allowed only when they advance the same central question and satisfy the explicit jump contract. Do not build a shuffled montage.
  * Select scenes whose original direct dialogue, bodycam sound, radio calls, reactions, breathing, sirens, or ambient sound can carry the story without added explanation.
  * Use the strongest authentic lines and reactions as natural transitions. Avoid random montages, repeated information, unexplained jumps, or scenes that require new narration to make sense.
  * Focus: The ridiculousness of the suspect's lie and the immediate visual contradiction.
  * Tone: Fast, conversational, immediate, and retention-driven. The narrator leads comprehension while authentic footage delivers proof and emotional impact.
  * Add a concise top_header to establish the premise when necessary, but never use an unsupported clickbait claim.
- Script 2: "Dialogue-First Confrontation"
  * PROFILE: Set scriptId=2. HARD RANGE ${independentOptions.durations.script2.min}-${independentOptions.durations.script2.max} seconds.
  * Build the story around one complete, high-value confrontation or contradiction. Preserve decisive clean participant dialogue and use short voiceover_only bridges only for context, chronology, or verified stakes the exchange cannot explain itself.
  * Do not turn the script into a quote montage. The exchange must progress through setup, pressure, a decisive line/action, and an immediate reaction or consequence.
  * External source narration remains forbidden. Use conversational, precise American English for every tool narration beat.
- Script 3: "The Viral Mini-Doc / Deep Dive"
  * PROFILE: Set scriptId=3. HARD RANGE ${independentOptions.durations.script3.min}-${independentOptions.durations.script3.max} seconds. Approximately 5-8 macro-blocks and 5 or fewer major source jumps are references, not rejection gates. Story completeness outranks these counts.
  * Focus: Build a suspenseful investigative mini-documentary that exposes the suspect's evolving verified lies, contradictions, or decisions against the police's unfolding discovery. Let important interrogation, confrontation, grief, confession, or consequence source runs breathe for 20-60 seconds when they contain a complete exchange.
   * Structure: WTF in-media-res hook → villain-framed setup/lie → psychological and physical escalation → investigation and verified twist → confrontation → verified final consequence/payoff.
  * Voiceover leads the investigation and may connect context, chronology, verified contradictions, stakes, discoveries, and consequences. Each voiceover_only block must be 12 seconds or less and use visually grounded evidence.
  * EDITORIAL NARRATION DENSITY: Target approximately 45-60% voiceover. Prefer complete connected narration beats over scene-sized phrases; retain original audio for decisive proof and emotional exchanges.
  * Use story-driven nonlinear order. Every thematic source jump must advance the central question and be immediately understandable from narration, direct dialogue, or visual proof.
  * External source narration is forbidden. Essential narrator-covered visuals must be muted and recreated with verified tool voiceover.
  * Tone: Investigative, suspenseful, cinematic, and willing to call out verified absurdity. Never convert accusation or speculation into fact. Do not turn a complex case into a montage of peak reactions.
- Script 4: "The 80/20 Rage-Bait Reality / Strategic Bridges"
  * PROFILE: Set scriptId=4. HARD RANGE ${independentOptions.durations.script4.min}-${independentOptions.durations.script4.max} seconds.
  * STORY-FIRST PRIORITY: Narrative continuity and audience comprehension outrank clip density and the exact 80/20 ratio. Build one causal story, not a montage of individually dramatic fragments.
  * DYNAMIC DURATION RANGE: ${independentOptions.durations.script4.min}-${independentOptions.durations.script4.max} seconds. The final output may never be shorter than 60.5 seconds after playbackSpeed. Prefer the shortest eligible duration that preserves a high-impact in-media-res hook, comprehensible context, escalation, climax, and the selected ending policy.
  * AUDIO COVERAGE: Preserve strong authentic original audio whenever it proves the causal story, but let a connected narrator arc control comprehension and momentum. A typical result uses approximately 35-50% voiceover and 50-65% clean original audio. These are soft profile targets, never quotas.
  * NEVER place voiceover over active or important source dialogue. Voiceover may only use visually relevant evidence whose important dialogue can be safely muted, ideally ambient_sfx/music evidence or evidence with sceneDialoguePresent=false.
  * Use story-driven nonlinear order. Thematic reordering is permitted only when each jump raises the same stake, reveals a contradiction, returns to the promised climax, or delivers payoff; use an Audio Sandwich bridge whenever the transition is not self-explanatory.
  * External source narration is forbidden and never counts toward the original-audio target. Mute and replace essential narrator-covered visuals with verified tool voiceover.
  * Narration tone: suspenseful, cinematic, and pointed. Use verified factual contrast to provoke disbelief or outrage, strong active verbs, and precise high-impact language. Never use unsupported insults, diagnoses, motives, "Welcome back", "Let's rewind", "Let's rewatch", or other fourth-wall/vlogger phrases.
  * Step 1 - Cold-Viewer Hook (4-${independentOptions.hookMaxSec}s): Apply the user-ranked Hook fallback order. Preserve a qualifying multi-scene action Hook through its decisive payoff and immediate reaction when high_action is selected. audio_mode="original_audio"; voiceover_text="".
  * Step 2 - Villain Setup (10-18s): Identify the severe stakes and the suspect's verified contradiction, shocking failure, bizarre logic, or reckless choice. Use concrete visual/dialogue evidence rather than generic condemnation.
  * Step 3 - Narration Arc: Use connected voiceover_only beats to compress routine material, frame verified contradictions, raise stakes, and set up the next raw proof moment. Do not add or remove narration merely to reach a percentage.
  * Step 4 - Escalation & Plot Twist (20-35s macro-block): Return to one sustained original-audio run so the audience directly witnesses a complete contradiction, discovery, argument, command sequence, or consequence, including the reaction whenever available.
   * Step 5 - Specific Verified Payoff / Comment Trigger (3-6s): Use exactly one final "voiceover_only" segment. State the concise verified consequence or current status, then optionally ask one evidence-grounded discussion question. NEVER use generic phrases such as "the ultimate consequence is about to drop" and never hide a known outcome merely to manufacture a sequel.
  * MACRO-BLOCK REFERENCE: 5-7 narrative macro-blocks often works, but use as many as the shortest complete causal story needs. Never delete climax/payoff evidence or add filler to satisfy a count.
  * SOURCE-ADJACENCY RULE: Prefer consecutive or near-consecutive evidence from the same source sequence. At least 70% of original-audio duration should come from no more than two continuous source runs whenever the evidence permits.
  * SOURCE-JUMP REFERENCE: Prefer fewer major non-contiguous jumps, but no fixed count decides quality. Every jump must advance the same story and remain understandable; unresolved-stake jumps remain forbidden.
  * MINIMUM BEAT RULE: Do not create isolated original-audio fragments shorter than 5 seconds unless the fragment contains an indispensable complete quote, impact, reveal, or reaction. Never cut a spoken sentence or immediate reaction in half.
  * TRANSITION RULE: Every macro-block must answer or advance something established by the preceding block. Use narration only for an unavoidable causal or temporal explanation, not to introduce unrelated dramatic clips.
  * INTERNAL STORY CHECK: Before writing JSON, summarize the planned sequence internally in one sentence per macro-block. Remove any block that cannot be connected with "because", "therefore", "but", or "as a result".
   * VOICEOVER PLACEMENT REFERENCE: Keep narration concise and purposeful. A typical result may contain several short bridges plus a payoff, but there is no fixed block count. Every voiceover block must declare its narrativePurpose and add information the visual/authentic audio cannot provide.
  * ORIGINAL-AUDIO PRESERVATION: Keep bodycam speech, breathing, shouting, arguments, radio calls, sirens, and meaningful reactions intact wherever they carry the scene.
  * TOP HEADER: Add a concise top-level "top_header" that reverses or challenges the apparent situation without making an unsupported claim.
  * VISUAL GROUNDING: Every voiceover claim must name concrete people, actions, objects, documents, weapons, vehicles, K-9 units, locations, or visible reactions supported by its evidenceId.
  * CONTINUITY METADATA: Include top-level "macro_block_count" and "source_jump_count" after validating the final sequence.
  * FINAL VALIDATION ORDER: First validate storySpine, Hook promise, causal continuity, climax return, payoff, and complete spoken lines/reactions. Treat macro-block count, source-jump count, and audio ratio as diagnostics only. Add top-level "audio_ratio_warning" when a target would fragment an otherwise coherent story.
- Script 5: "Evidence and Consequence"
  * PROFILE: Set scriptId=5. HARD RANGE ${independentOptions.durations.script5.min}-${independentOptions.durations.script5.max} seconds.
  * Organize the edit around one verified discovery, contradiction, or piece of evidence and the consequence it causes. Tease the proof in the Hook, rewind for minimum context, then return to the full discovery and immediate aftermath.
  * Narration must connect cause and effect; authentic audio must carry the decisive proof, reaction, command, or admission whenever it is clean of external source narration.
  * Do not substitute a generic legal summary for the promised visual or spoken payoff.

---

### III. DYNAMIC VOICE NARRATION CALIBRATION
CRITICAL RULE: Always read the specific "calibrated voice speed" configuration provided by the user in the prompt.
- Calculate only maxWords for every voiceover_only source window using measuredWordsPerSecond and targetNarrationCoverageMax.
- There is no minWords requirement. Never add filler, redundant legal phrasing, or generic suspense language to occupy a time window.
- One or two concise complete sentences are preferred. A shorter line is valid when it is clearer; the tool measures the real TTS after rendering and reports timing separately.
- Leave voiceover_text completely empty ("") for any segment where audio_mode is "original_audio".
- If measuredWordsPerSecond is NOT_MEASURED, add a root field "voice_calibration_warning" to each affected script. Never place that warning outside the JSON code block.

---

### IV. JSON TECHNICAL RULES
1. EDITORIAL SOURCE ONLY: Choose sourceStartSec/sourceEndSec and playbackSpeed. Do not calculate output startSec/endSec; omit those derived fields. The local tool computes the complete contiguous output timeline authoritatively.
2. MACRO-BLOCK RANGE: One segment represents one continuous editorial source range and may cross consecutive scene-manifest boundaries. Set sceneId to the scene containing sourceStartSec and provide sceneIds containing every crossed scene in source order. Never join non-contiguous source ranges inside one segment.
2A. JUMP-CUT REPRESENTATION: Non-contiguous source ranges are represented as separate consecutive JSON segments, each with its own valid sourceStartSec/sourceEndSec. This is how the renderer expresses micro-clips, thematic edits, and Hook montages; never merge those ranges into one segment.
2B. HOOK MONTAGE: A Hook may contain 1-4 consecutive output segments from different source ranges when the combination forms one understandable mini-arc: shock/threat -> decisive action or line -> reaction/payoff tease. Assign storyFunction="hook", narrativePurpose="hook_teaser", the same macroBlockId, and the same actionSequenceId to every Hook segment. Total Hook duration must remain inside the configured Hook range. Never create a random montage of unrelated peaks.
3. Field Types:
   - audio_mode: "voiceover_only" OR "original_audio"
   - AUDIO ENGINE CONTRACT: Do not output mixed_ducking or voiceover_with_ducked_audio for this profile. The renderer intentionally mutes the complete source soundtrack during voiceover_only to prevent external source narration or a second voice from leaking under the tool narrator. Create smooth audio handoffs through edit timing and adjacent authentic-audio beats, not unsupported layering.
   - language: "en", sourceLanguage: "en"
   - voiceover_text: English narrative text (strict adherence to dynamically calculated word budget)
   - preview_vi: Vietnamese summary of the segment for preview
4. sourceStartSec/sourceEndSec are timestamps from the ORIGINAL source video.
5. startSec/endSec are tool-derived OUTPUT timestamps and must not be authored by Gemini for this independent profile.
6. Do not invent facts. Use only events visible/audible in the source video.
6A. CONTINUOUS MULTI-SCENE GATE: sourceStartSec/sourceEndSec may cross consecutive scene boundaries when they preserve one complete dialogue, action, or narration beat. List all crossed IDs in sceneIds. Do not split a natural voiceover sentence merely because scene detection created a boundary.
7. FINAL DURATION VALIDATION: HARD MONETIZATION MINIMUM: every requested script must be at least 60.5 seconds after playbackSpeed and must stay inside its user-configured HARD RANGE. Before returning, calculate actual duration as SUM((sourceEndSec-sourceStartSec)/playbackSpeed) for every Narrative Beat. If a plan exceeds its maximum, remove dead air, repeated proof, or low-value context and audit again. Never return an over-limit script. If below minimum, add only story-relevant evidence or justified 0.5-0.75 slow motion on a key split-second action. Never use silence, freeze frames, warning screens, credits, filler, repetition, or unsupported claims.
8. PACING VALIDATION: Preserve complete decisive quotes/actions/reactions, but trim dead air and routine lead-in. Controlled micro-cuts are valid when microCutPurpose is explicit; do not turn the body into a rapid montage that breaks the narration arc.
9. VISUAL GROUNDING VALIDATION: For every segment, verify that action_notes and narration claims are supported by specific frames plus overlapping SRT/original audio. Rewrite or remove any generic, vague, or unverified statement before returning the JSON.
10. SCRIPT 1 NARRATED CLEAN-HYBRID OVERRIDE: Set audio_strategy="clean_hybrid", voiceover_enabled=true, and source_narrator_policy="forbidden". Use multiple narrator beats forming one connected story arc (aim for ~40% voiceover duration). Prevent Dead Air from exceeding 15 seconds by frequently injecting narrator voice. Require a narrator-led rewind/context or causal bridge before the promised Climax and one later escalation/stake-resolution/Payoff beat. Every voiceover_only segment must map one-to-one to narration_arc through narrationBeatId. Every original_audio segment must contain only direct scene dialogue or ambient action. Mute and recreate every essential source-narrator interval with the selected tool voice. Thematic source jumps are valid only under the explicit jump contract.
11. SCRIPT 4 OVERRIDE: Script 4 follows its dedicated story-first ${independentOptions.durations.script4.min}-${independentOptions.durations.script4.max} second framework, uses a 4-${independentOptions.hookMaxSec} second cold-viewer Hook selected by the ranked fallback policy, and shows visual stakes immediately after the Hook. Macro-block, source-jump, narration-count, and 80/20 audio figures are reference diagnostics only. The Hook may enter mid-exchange only when the first 3 seconds remain understandable; all later blocks preserve causal continuity, return to the promised climax, and deliver the selected ending policy without hiding a known result.

---

### V. OUTPUT FORMAT SCHEMA
Return exactly ${scriptIds.length} distinct JSON script${scriptIds.length === 1 ? "" : "s"}, specifically these IDs in this order: ${scriptIds.join(", ")}. Return no unrequested script.

${buildGeminiThreeJsonCodeBlockContract()}

{
  "prompt_profile": "independent",
  "scriptId": 4,
  "title": "Script Title",
  "language": "en",
  "sourceLanguage": "en",
  "total_target_sec": 75,
  "monetization_target_sec_min": 60.5,
  "style": "True Crime Bodycam Highlight",
  "top_header": "",
  "source_narrator_policy": "forbidden",
  "timeline_policy": "story_driven_non_linear_with_explicit_bridges",
  "independent_prompt_options": ${JSON.stringify(independentOptions, null, 2)},
  "hook_selection_audit": {
    "requestedPriority": ${JSON.stringify(independentOptions.hookPriority)},
    "selectedType": "high_action|dialogue_conflict|psychological_wtf|evidence_reveal",
    "fallbackLevel": 1,
    "selectedEvidenceIds": ["evidence_0001"],
    "reason": "Why this is the strongest qualified candidate in the first category that passed every gate",
    "rejectedHigherPriorityCandidates": [{
      "type": "higher-ranked category",
      "evidenceIds": ["evidence_0002"],
      "reason": "Concrete gate failure; use an empty array when fallbackLevel is 1"
    }]
  },
  "hook_cold_viewer_test": {
    "passes": true,
    "first3SecQuoteOrAction": "Exact verified words or visible action in the first 3 seconds",
    "identifiedActor": "Who is involved",
    "identifiedConflict": "What accusation, action, or conflict is clear",
    "identifiedStake": "What person, object, danger, or consequence matters",
    "contextSource": "audio|visual|top_header",
    "reason": "Why a viewer with no prior context can understand the Hook"
  },
  "hook_transition_test": {
    "passes": true,
    "hookActorIds": ["actor_001"],
    "postHookActorIds": ["actor_001", "actor_002"],
    "timelineResetUsed": true,
    "relationshipExplained": true,
    "bridgeText": "Exact concise line that identifies the people and explains the reset",
    "first15SecCausalLink": "Why the post-Hook block directly answers or advances the Hook",
    "reason": "Why a cold viewer will not confuse the actors or chronology"
  },
  "actor_identity_map": [{
    "actorId": "actor_001",
    "displayLabel": "Verified name or stable descriptive label",
    "visualIdentity": "Visible clothing, position, or stable source-grounded cues",
    "role": "officer | suspect | victim | witness | dispatcher | parent | relative | unknown",
    "aliases": [],
    "relationshipFacts": ["Verified relationship to another actorId"],
    "firstSeenSec": 0.0,
    "confidence": 0.95
  }],
  "source_narrator_ranges": [],
  "audio_strategy": "standard",
  "voiceover_enabled": true,
  "target_original_audio_ratio": 0.60,
  "target_voiceover_ratio": 0.40,
  "narration_arc": {
    "openingFrame": "How the narrator frames the central question without spoiling the payoff",
    "beats": [{
      "narrationBeatId": "narration_001",
      "priorKnowledge": "What the viewer already knows",
      "newInformation": "The one verified fact or stake this beat adds",
      "setupForNext": "The question or expectation handed to the next source beat",
      "handoffToOriginalAudio": "Exact quote/action/evidence expected next",
      "spoilerGuard": "What must remain unrevealed until the promised climax"
    }],
    "closingAnswer": "How the final narration or authentic footage answers the central question"
  },
  "narrative_contract": {
    "hookPromise": "Concrete verified promise opened by this script's Hook",
    "primaryAudienceQuestion": "Exact primary question the viewer must have answered",
    "primaryStakeType": "victim_safety|hostage|missing_person|injury|weapon|crash|evidence|suspect_outcome|other",
    "stakeActorIds": ["actor_001"],
    "mandatoryResolution": {
      "required": true,
      "resolutionType": "rescue|safety_confirmation|medical_outcome|hazard_removed|evidence_reveal|suspect_outcome|unknown",
      "evidenceIds": ["evidence_0009"],
      "preferredVisualEvidenceIds": ["evidence_0010"],
      "fallbackVerbalEvidenceIds": ["evidence_0009"],
      "visualFirstRequired": true,
      "mustAppearBeforeLaterTimeJump": true,
      "verifiedOutcome": "Exact source-grounded immediate outcome"
    },
    "secondaryPayoff": {
      "required": true,
      "mustBeFinal": true,
      "question": "Later suspect/legal question when explicitly verified by the source",
      "evidenceIds": ["evidence_0012"],
      "verifiedOutcome": "Optional later verified payoff"
    }
  },
  "viral_plan": {
    "primaryAudienceQuestion": "The concrete question opened by the hook.",
    "hookEvidenceId": "evidence_0001",
    "causalChain": ["setup", "escalation", "reveal", "consequence"],
    "finalPayoff": "Verified resolution, consequence, or current status delivered before this standalone variant ends."
  },
  "semantic_must_include_candidates": [
    {
      "evidenceId": "evidence_0001",
      "sceneId": "scene_0001",
      "sourceStartSec": 0,
      "sourceEndSec": 4,
      "speakerRole": "suspect",
      "semanticType": "confession|contradiction|evidence_reveal|accusation|authority_irony|consequence",
      "exactQuoteOrFact": "Exact verified quote or fact",
      "semanticImpactScore": 9,
      "mustInclude": true,
      "omissionReason": ""
    }
  ],
  "story_blueprint": {
    "centralCharacter": "Verified central person or group",
    "primaryConflict": "Evidence-supported conflict",
    "audienceQuestion": "Question opened by the hook",
    "storySpine": {
      "centralViewerQuestion": "What the viewer desperately wants to know after seeing the Hook",
      "hookPromise": "What the opening implicitly promises the viewer will eventually see or learn",
      "rewindContext": "The minimum verified context needed after the teaser",
      "escalationPath": ["Verified beat that raises stakes", "Verified beat that moves closer to the promised climax"],
      "climax": "The source event that fulfills the Hook promise",
      "climaxEvidenceIds": ["evidence_0008"],
      "payoff": "The immediate emotional or factual answer",
      "payoffEvidenceIds": ["evidence_0010"],
      "finalOutcomeRequired": true,
      "finalOutcome": "The later verified sentence, legal result, arrest status, or current status",
      "finalOutcomeEvidenceIds": ["evidence_0012"]
    },
    "setup": "What starts the event",
    "escalation": "How and why it becomes worse",
    "climax": "The decisive confrontation or reveal",
    "consequence": "Verified legal or emotional result",
    "finalPayoff": "Verified payoff delivered before the standalone variant ends",
    "macroBlocks": [
      {
        "macroBlockId": "macro_01",
        "storyFunction": "hook",
        "sourceRunIds": ["source_run_0001"],
        "summary": "One complete causal story beat"
      }
    ]
  },
  "segments": [
    {
      "id": "highlight_0001",
      "evidenceId": "evidence_0001",
      "sceneId": "scene_0001",
      "sceneIds": ["scene_0001", "scene_0002"],
      "sourceRunId": "source_run_0001",
      "macroBlockId": "macro_01",
      "sourceStartSec": 0,
      "sourceEndSec": 10,
      "playbackSpeed": 1,
      "scene_type": "Hook_Original_Audio",
      "storyFunction": "hook",
      "narrativePurpose": "hook_teaser|rewind_context|context|escalation|climax_return|aftermath_payoff|indispensable_bridge",
      "narrationBeatId": "narration_001 or empty for original_audio",
      "microCutPurpose": "none|hook_montage|impact|reaction|evidence_insert|visual_proof|contradiction|climax_punctuation",
      "transitionReason": "Opening segment; no previous transition.",
      "transitionExplainedBy": "none|voiceover|direct_dialogue|visual_match",
      "bridgePurpose": "none|context|causal|stake_resolution|time_jump|jargon_clarity|payoff",
      "timelinePhase": "hook|immediate_event|immediate_resolution|later_outcome",
      "jargonExplanation": "Required only when selected source audio contains unexplained jargon",
      "source_narrator_detected": false,
      "speaker_role": "officer|suspect|victim|witness|dispatcher|source_narrator|unknown",
      "speech_type": "direct_scene_dialogue|source_narration|mixed_speech|ambient_action|unknown",
      "actor_ids": ["actor_001"],
      "primary_actor_id": "actor_001",
      "speaker_actor_id": "actor_001",
      "original_audio_value_score": 9.0,
      "original_audio_value_reason": "Exact quote, reaction, command, or sound worth preserving",
      "original_audio_protected": true,
      "audio_mode": "original_audio",
      "voiceover_text": "",
      "caption": "",
      "preview_vi": "Tóm tắt tiếng Việt",
      "action_notes": "Detailed frame-grounded description naming the visible subject, exact action, object/location, visual change, and matching SRT/audio evidence"
    }
  ]
}

When receiving the input containing the URL and Voice parameters, immediately analyze the complete source, apply the 3 required thematic angles, and output exactly 3 editorial JSON scripts in this order: Script 1, Script 3, Script 4. Select source ranges and write concise narration; leave output timeline arithmetic to the local tool. Never output Script 2.`;
  return withUiGeminiInputAccessGate(prompt);
}

function buildStoryRecutGeminiPromptTemplate() {
  return `USER TASK INSTRUCTION - BUILD ONE STORY RECUT JSON

You are a senior documentary editor and viral short-form story producer. Build exactly ONE coherent Story Recut from the LOCKED_SCENE_EVIDENCE appended below.

PASS 2 ROOT-SCHEMA CONTRACT - NON-NEGOTIABLE:
- Return one JSON object whose root contains artifactType="story_recut_script", mode="story_recut", schemaVersion=1, story_blueprint, and a non-empty segments array.
- The root MUST NOT contain an "evidence" array. Evidence belongs to Pass 1 and cannot be submitted as the final script.
- Do not wrap the object inside "data", "result", "output", "script", or any array.
- Before delivery, parse the saved file and assert:
  1. parsed.artifactType === "story_recut_script"
  2. parsed.mode === "story_recut"
  3. Array.isArray(parsed.segments) && parsed.segments.length > 0
  4. !Array.isArray(parsed.evidence)
- If any assertion fails, repair the file before returning it.

This is not a random shuffle, a compilation of isolated shocking moments, or a copyright-evasion edit. Preserve the verified facts, identities, causal order, and outcome of the source. Reorder only complete macro-blocks when the new order remains truthful and understandable.

PRIMARY GOAL:
- Create one complete vertical short-form story of at least 60 seconds. There is NO maximum duration when additional source material is necessary to preserve a compelling causal story.
- Open with the strongest complete dramatic beat from anywhere in the source.
- After the Hook, provide enough context for a new viewer to understand the central character, conflict, escalation, climax, and consequence.
- The result must feel like one continuous story, not several unrelated highlights.
- CONTENT OVERRIDES DURATION: A complete, compelling source passage may remain 2-3 minutes or longer. Never shorten, split, or discard it merely to satisfy a duration target.

STORY-FIRST PROCEDURE:
1. Analyze all locked evidence before selecting any segment.
2. Write story_blueprint first: centralCharacter, primaryConflict, audienceQuestion, factualCausalChain, hook, context, escalation, climax, consequence, and finalPayoff.
3. Build at least 3 macroBlocks. Let the story determine the final count; do not create extra blocks merely to reach a numerical target.
4. Use sustained source runs. A macroBlock has no maximum duration. Keep a 2-3 minute continuous passage when its complete setup, development, and payoff are all necessary and engaging.
5. Use transitionReason to explain the factual connection from every segment to the previous segment.
6. Treat sceneId/evidenceId as technical verification slices, not independent story beats. If one spoken thought or action crosses scene boundaries, include every consecutive evidence slice, keep the same sourceRunId and macroBlockId, and let the local tool consolidate them into one visible/rendered block.

STRICT CONTINUITY RULES:
- Maximum 4 major jumps on the original source timeline.
- Do not cut spoken sentences, physical actions, radio exchanges, reveals, or reactions before their payoff.
- Do not introduce a character after showing their consequence without a clear Context Reset.
- Do not present a later event as the cause of an earlier event.
- Do not reuse evidence unless replayPurpose explicitly explains a necessary callback.
- Every sourceStartSec/sourceEndSec must remain inside its locked evidence item.
- sourceRunId must match the locked evidence.
- startSec/endSec must be contiguous from 0 with no gaps or overlaps.
- endSec - startSec = (sourceEndSec - sourceStartSec) / playbackSpeed.

AUDIO RULES:
- This is a SOURCE-AUDIO-ONLY edit. Set top-level audio_strategy="source_audio_only" and voiceover_enabled=false.
- EVERY segment must use audio_mode="original_audio" and voiceover_text="".
- Preserve all audio already present in every selected source range: source narrator, character dialogue, interviews, radio calls, breathing, ambience, sound effects, and music.
- NEVER create, synthesize, rewrite, replace, duck, or mute the source narrator.
- NEVER use voiceover_only or mixed_ducking. The local tool will not generate TTS for this mode.
- Set playbackSpeed=1 for every segment. Preserve the original narrator cadence and let output duration equal source duration.
- Select and arrange only source ranges whose original audio can carry the complete story without added explanation.

QUALITY GATE BEFORE OUTPUT:
- Total duration is at least 60 seconds. There is no hard maximum; every retained second must serve context, escalation, suspense, clarity, or payoff.
- Hook is a complete beat of at least 5 seconds and uses one of the strongest verified hook candidates. Do not cut an excellent Hook mid-thought merely to keep it under a fixed maximum.
- The narrative includes Hook, Context, Escalation, Climax, and Consequence/Payoff.
- There are at least 3 meaningful macroBlocks; use more only when the story genuinely requires them.
- No more than 4 source timeline jumps.
- No isolated micro-clip under 5 seconds, except one indispensable complete Hook or reaction. A technical slice under 5 seconds is valid only when it is immediately adjacent to slices with the same macroBlockId and sourceRunId and their combined source span is at least 8 seconds.
- A new sceneId never starts a new macroBlock by itself. One complete narrator thought, exchange, action, and immediate reaction must remain in the same macroBlock even when it crosses many scene boundaries.
- 100% of output duration uses original_audio.
- There are zero tool voiceover/TTS segments and every voiceover_text is empty.
- Every evidenceId, sceneId, sourceRunId, and timestamp matches LOCKED_SCENE_EVIDENCE.

OUTPUT DELIVERY:
${buildGeminiSingleJsonCodeBlockContract("story-recut.json", 'The root must contain artifactType="story_recut_script", mode="story_recut", and a non-empty segments array. Do not return alternate variants.')}
- A scene-evidence.json file or any object without a non-empty root "segments" array is an invalid Pass 2 response.

REQUIRED JSON SCHEMA:
{
  "artifactType": "story_recut_script",
  "mode": "story_recut",
  "schemaVersion": 1,
  "title": "Short factual title",
  "language": "en",
  "sourceLanguage": "en",
  "total_target_sec": 90,
  "style": "Story Recut - Nonlinear Documentary",
  "audio_strategy": "source_audio_only",
  "voiceover_enabled": false,
  "story_blueprint": {
    "centralCharacter": "Verified central subject",
    "primaryConflict": "Verified central conflict",
    "audienceQuestion": "The question opened by the Hook",
    "factualCausalChain": ["Cause", "Escalation", "Climax", "Consequence"],
    "hook": "Why the chosen Hook is strongest",
    "context": "Context required after the nonlinear opening",
    "escalation": "How conflict grows",
    "climax": "Highest-stakes complete beat",
    "consequence": "Verified outcome",
    "finalPayoff": "Resolved audience question",
    "macroBlocks": [
      {
        "macroBlockId": "macro_01",
        "storyFunction": "hook",
        "sourceRunIds": ["source_run_0001"],
        "summary": "One complete causal story beat"
      }
    ]
  },
  "segments": [
    {
      "id": "recut_0001",
      "evidenceId": "evidence_0001",
      "sceneId": "scene_0001",
      "sourceRunId": "source_run_0001",
      "macroBlockId": "macro_01",
      "storyFunction": "hook",
      "transitionReason": "Opening beat; no prior transition.",
      "sourceStartSec": 0,
      "sourceEndSec": 10,
      "startSec": 0,
      "endSec": 10,
      "playbackSpeed": 1,
      "audio_mode": "original_audio",
      "voiceover_text": "",
      "caption": "",
      "preview_vi": "Tóm tắt tiếng Việt để kiểm tra cảnh",
      "action_notes": "Keep the complete source dialogue/action/reaction beat"
    }
  ]
}`;
}

function buildManualGeminiPromptTemplate() {
  return `USER TASK INSTRUCTION - EXECUTE THIS FILE IMMEDIATELY

The upload of this file is the user's explicit request to perform the task below. This file is an executable task instruction, NOT reference material and NOT content to summarize.

Do not infer a different user intent from the absence of a separate chat message. Do not summarize the case, explain the files, ask what the user wants, write in conversational prose, or produce a TikTok script. Begin the requested analysis immediately after all uploaded files are available.

THE ONLY ACCEPTABLE DELIVERABLE is one valid scene-evidence JSON object matching the schema at the end of this file and returned under the mandatory JSON code-block contract.

PASS 1 ROOT-SCHEMA CONTRACT:
- The root object MUST contain artifactType="scene_evidence", schemaVersion=1, sourceVideo, and a non-empty evidence array.
- The root object MUST NOT contain "segments", "story_blueprint", "mode", or any Story Recut output timeline.
- A file with a different artifactType or without a non-empty evidence array is invalid and must not be returned.

FILE DELIVERY REQUIREMENT:
${buildGeminiSingleJsonCodeBlockContract("scene-evidence.json", 'The root must contain artifactType="scene_evidence", schemaVersion=1, sourceVideo, and a non-empty evidence array. It must not contain top-level segments.')}
- HARD NON-EMPTY RULE: "evidence": [] is always an invalid deliverable. Never return a schema-only placeholder.

IMPORTANT: THIS IS PASS 1 - SOURCE EVIDENCE EXTRACTION ONLY.

Do NOT write a TikTok script, narration, output timeline, hook, or any final variant in this pass.

UPLOADED FILES:
- The supplied analysis proxy video or ordered proxy chunks: source footage with sceneId and ORIGINAL SOURCE timestamps overlaid. When proxy-chunks-manifest.json exists, watch every listed chunk in order and use the burned absolute SOURCE timestamps, never the chunk player's local time.
- scene-manifest.json: the authoritative sceneId and source boundary table.
- action-candidates.json: local motion/audio radar. It identifies ranges Gemini must visually inspect; scores are not semantic truth.
- source-transcript.srt: optional timestamped source dialogue. Use it whenever available.

GOAL:
Watch the complete proxy and create a precise scene-evidence.json containing enough verified candidate moments to build exactly three independent True Crime/Bodycam highlight scripts later, each at least 60.5 seconds: one 60.5-120 second Narrated Raw Reality clean-hybrid highlight, one 90-240 second Mini-Doc, and one 60.5-120 second 80/20 Raw Reality variant. Cover the beginning, middle, and end of the source. Include multiple complete Hook candidates, context, escalation, sustained raw exchanges, source-narrator passages explicitly classified for muting/replacement, safe narration-bridge visuals, climax, consequence, and aftermath that actually exist. For Script 1, collect enough clean direct-scene dialogue plus visually grounded Context, causal-transition, and Consequence/Payoff evidence so narration can be used only where the Story Spine cannot be understood from authentic audio. Do not add weak evidence merely to fill a duration or narrator-count target.

GROUNDING RULES:
1. Every evidence item must describe a concrete visible or audible event, not a proposed edit and not generic storytelling.
2. Name the exact visible person, action, object, location change, reaction, on-screen text, spoken line, or sound cue.
3. Cross-check frames with overlapping SRT/original audio. Never invent identity, motive, crime, relationship, outcome, dialogue, or causality.
4. Every evidence item must reference one existing sceneId from scene-manifest.json.
5. sourceStartSec/sourceEndSec are ORIGINAL SOURCE timestamps and must remain completely inside that scene.
6. A timestamp equal to scene.endSec belongs to the next scene, not the scene that just ended.
7. Never let one evidence item cross a scene boundary. Split the event into separate evidence items when necessary.
8. Look up the manifest object first, then choose the narrowest source subrange that fully preserves the action and immediate reaction.
9. Prefer precise evidence items of 2-30 seconds. Do not combine unrelated events into one broad range.
10. Analyze the entire source before ranking viralScore. Do not overfocus on the opening minutes.
11. Aim for 20-60 high-value evidence items when the source contains enough material. Do not add filler merely to reach a number.
11A. COVERAGE FLOOR: For a source longer than 5 minutes, return at least 20 verified evidence items. For a source of 5 minutes or less, return at least 12 verified items or one item for every usable scene when fewer than 12 usable scenes exist.
11B. If the proxy is still loading, temporarily unavailable, or has not been watched completely, wait for it, reopen it, and continue the analysis. Never replace analysis with an empty evidence array.
12. visualFacts must contain frame-grounded facts. Phrases such as "tension rises", "things escalate", "a shocking event occurs", or "police respond" are invalid unless followed by the exact action and evidence.
13. dialogueEvidence must quote the relevant spoken words and include timestamps when they can be verified. Use an empty array only when the moment is genuinely visual or sound-only.
14. storyMeaning must explain why the verified moment matters to the factual event, without writing finished narration.
15. confidence measures confidence in factual grounding, not how entertaining the scene is.
16. Detect whether the source video's editorial narrator is audible. Do not confuse that narrator with officers, suspects, witnesses, dispatchers, interviewers, or raw scene dialogue.
16A. NARRATOR CLASSIFICATION MUST COME FROM BOTH PICTURE AND SOUND. Watch and listen to the proxy range itself; use source-transcript.srt only as supporting evidence because it may not contain speaker labels.
16B. Descriptive third-person storytelling, retrospective case summaries, channel-host commentary, news-anchor delivery, and off-screen explanation of actions or legal outcomes are strong narrator signals. Direct commands, pleas, arguments, interviews, dispatch calls, and words visibly spoken by people in the recorded event are scene dialogue. Resolve ambiguous cases by checking lip movement, camera context, voice continuity across cuts, and whether the speaker exists inside the recorded scene.
17. Set sourceNarratorPresent=true whenever an off-screen documentary/news/YouTube narrator is audible anywhere in the evidence range.
17A. If narrator audio overlaps authentic scene dialogue or action sound anywhere in the range, sourceNarratorPresent must still be true and sourceAudioType must be "mixed_narration_dialogue". Never hide mixed narration by labeling the range scene_dialogue.
18. sourceAudioType must be exactly one of: "scene_dialogue", "source_narration", "mixed_narration_dialogue", "ambient_sfx", or "music".
19. sceneDialoguePresent=true only when authentic dialogue from people in the recorded event is audible.
20. When sourceNarratorPresent=true, copy only the source narrator's spoken words into sourceNarratorText. Exclude officer, suspect, witness, dispatcher, interviewer, and quoted scene dialogue. Preserve the narrator's factual meaning and order.
21. Inspect the start and end of every candidate closely. Set completeBeat=true only when the range preserves the complete spoken line or action plus its immediate reaction.
22. Set cutSafety="safe" only when the clip can be cut at both boundaries without truncating speech, movement, radio audio, or the payoff. Otherwise use "unsafe".
23. continuityBefore and continuityAfter must state the concrete event immediately before and after this evidence, so Pass 2 can build causal transitions instead of a montage of unrelated dramatic clips.
24. Score hookScore, retentionScore, clarityScore, and viralScore independently from 0-10. A loud moment is not automatically a good hook if the viewer cannot understand it.
25. uniqueMoment, emotionalTrigger, and payoff must name the exact source-grounded reason this evidence is distinctive. Generic phrases such as "creates suspense" are invalid.
26. recommendedUse must be exactly "original_audio", "voiceover_only", or "avoid". Prefer original_audio for complete authentic dialogue/reaction and voiceover_only for visually strong ranges without essential source speech.
27. Detect text already burned into the source image. Set burnedTextPresent=true, copy the visible wording into burnedTextContent, and set safeForVoiceover=false whenever replacement narration would contradict or compete with that text.
28. CONTINUITY COVERAGE: Do not extract only isolated peak moments. Around every major hook, confrontation, reveal, and consequence, also extract the source-adjacent setup and immediate reaction needed to form a continuous 12-45 second source run.
29. STORY COMPLETENESS: The evidence set must contain at least one viable causal path from setup through escalation to climax/consequence. A list of unrelated high-viralScore moments is incomplete evidence.
30. Evidence items remain scene-bounded, but consecutive items should use touching or near-touching source ranges whenever they describe one continuous exchange. The local tool will derive sourceRunId and adjacency after validation.
31. VISUAL ACTION INVENTORY: Review every mustReview item in action-candidates.json. Return one root actionCandidateDecisions entry per mustReview item with verdict essential, supporting, or not_relevant and a concrete visual reason.
32. VISUAL ACTION OVERRIDE: Do not lower an event because dialogueEvidence is empty. Meaningful escape, vehicle theft, pursuit, struggle, crash, weapon draw, forced entry, takedown, panic, or immediate physical reaction may outrank spoken dialogue.
33. ESSENTIAL ACTION COVERAGE: For every essential action, extract consecutive scene-bounded evidence slices covering the complete action and immediate reaction. Give them one actionSequenceId, set narrativeEssential=true, mustInclude=true, and actionOverride=true.
34. ACTION SEQUENCE EXCEPTION: Do not split an action sequence merely to manufacture short audio blocks. Preserve original_audio until a natural lull, repetition, or loss of story value.
35. CRITICAL ANTI-TALKING-HEAD COVERAGE: Never return an evidence set made primarily of people describing a major physical event when the event itself appears in the proxy. If the source title, proxy, on-screen text, or action candidates promises an event such as caught in 4K, vehicle impact, run-over, crash, escape, pursuit, abduction attempt, struggle, weapon draw, or takedown, locate the actual visible event even when dialogueEvidence is empty and no SRT text overlaps it. Mark the complete event and immediate reaction mustInclude=true and actionOverride=true.
36. TITLE-PROMISE AUDIT: Before finishing, list every concrete physical event promised by the source title or repeatedly described by witnesses. For each event visible in the proxy, ensure at least one evidence/actionSequence covers the actual event. Talking-head testimony is supporting context and never substitutes for the available physical payoff.
37. CROSS-CASE CONTAMINATION BAN: Evidence may contain only names, charges, sentences, outcomes, and facts audible or visible in this source package. Never use memory from another video, prior prompt, chat, case, or model response. If a legal outcome is absent, do not infer it and do not manufacture evidence for it.
38. ACTOR IDENTITY MAP - REQUIRED: Before extracting evidence, build one root actorIdentityMap for every recurring visible or speaking person. Use stable actorId values across the complete source. Record only visually or audibly verified displayLabel, visualIdentity, role, aliases, relationshipFacts, firstSeenSec, evidenceIds, and confidence. Never merge two people because they appear in adjacent scenes, and never invent a family or social relationship.
39. ACTOR TAGGING - REQUIRED: Every evidence item must include actorIds, primaryActorId, speakerActorId, and relationshipFacts. Use an empty speakerActorId only when no visible/direct participant speaks. The same person must retain the same actorId across clothing, camera, and timeline changes.
40. ORIGINAL AUDIO VALUE: Score originalAudioValueScore from 0-10 after listening to the complete range. Set originalAudioProtected=true when the range contains an indispensable authentic quote, accusation, denial, confession, command, emotional reaction, impact, radio call, or uninterrupted confrontation that would lose value if replaced by tool narration. Explain the exact reason in originalAudioValueReason. External source narration can never be protected original audio.
41. STAKE INVENTORY: For every Hook/threat candidate, record the concrete question it opens in opensQuestion and identify the endangered victim/person/object/hazard with stakeActorIds. Do not confuse the suspect's eventual arrest with the immediate fate of a victim.
42. RESOLUTION EVIDENCE: Search the complete source for the exact footage or dialogue that resolves each primary stake. Set stakeRole="victim_resolution" or "hazard_resolution", populate resolvesQuestion and resolutionType, and set mustAppearBeforeLaterTimeJump=true when that outcome must be shown before a later arrest, surrender, court result, or time jump.
43. NO ORPHANED STAKES: Before returning evidence, verify that every important threat_open question has at least one source-grounded resolution candidate when the source contains one. If the source never resolves it, preserve that fact explicitly instead of inventing an outcome.
44. JARGON CLARITY: Mark containsUnexplainedJargon=true and list jargonTerms when authentic audio depends on police codes, radio shorthand, street callouts, or procedural terms a cold viewer cannot understand without explanation. Do not inflate viralScore merely because radio audio is loud.
45. VISUAL VS VERBAL RESOLUTION: For every victim_resolution or hazard_resolution candidate, set resolutionModality="visual", "verbal", or "mixed" and visualProofScore from 0-10. A visible rescued victim, safe child, removed weapon/hazard, recovered object, crash aftermath, or physical evidence normally outranks a casual spoken confirmation.
46. PROCEDURAL-BLOAT DETECTION: Mark proceduralBloat=true and proceduralBloatType when footage is dominated by routine administration without intense emotion, contradiction, direct conflict, or unique evidence. Types include written_statement, paperwork, phone_number, name_spelling, forms, routine_report, and station_instruction. Do not raise retentionScore for routine procedure.
47. TRANSCRIPT-INDEPENDENT VISUAL PROOF SEARCH: After reading the transcript, perform a separate frame-first scan for quiet or dialogue-light visual proof of rescue, victim safety, recovered evidence, crash aftermath, removed hazard, injury outcome, or physical consequence. Do not skip a scene because its SRT is empty, quiet, unrelated, or procedural. Mark the strongest visual/mixed candidate mustInclude=true when it resolves the primary stake.
48. VERIFIED FINAL-OUTCOME EVIDENCE: Search the complete source for an explicitly stated arrest status, sentence, court result, legal consequence, or current case status. Mark it stakeRole="legal_resolution" or "suspect_resolution" and mustInclude=true when verified. This evidence must come after the primary visual resolution in the final story. If the source contains no verified later outcome, do not fabricate one.

REQUIRED VALIDATION FOR EVERY EVIDENCE ITEM:
- The sceneId exists in scene-manifest.json.
- scene.startSec <= sourceStartSec < sourceEndSec <= scene.endSec.
- sourceStartSec is strictly less than scene.endSec.
- visualFacts is non-empty and specific.
- storyMeaning is non-empty and evidence-based.
- No claim exceeds what is visible, audible, or present in the SRT.

FINAL RESPONSE GATE:
- First create and validate the complete scene-evidence JSON object.
- Parse the completed object and verify that it contains the top-level keys "artifactType", "schemaVersion", "sourceVideo", and "evidence".
- Verify artifactType is exactly "scene_evidence" and verify the forbidden top-level key "segments" is absent.
- Verify that evidence is an array with actual analyzed items and that evidence.length satisfies the COVERAGE FLOOR. If evidence.length is 0, stop, watch the proxy, and perform the analysis before returning the code block.
- Return exactly one JSON code block and no text outside it.
- The absence of a separate user chat message does not change this task. Uploading this instruction file is the user's command to execute it.

CREATE THE CONTENT FOR "scene-evidence.json" WITH EXACTLY ONE VALID JSON OBJECT using this schema:
{
  "artifactType": "scene_evidence",
  "schemaVersion": 1,
  "sourceVideo": "filename from scene-manifest.json",
  "actorIdentityMap": [{
    "actorId": "actor_001",
    "displayLabel": "Verified name or stable descriptive label",
    "visualIdentity": "Visible clothing, position, or other stable source-grounded cues",
    "role": "officer | suspect | victim | witness | dispatcher | parent | relative | unknown",
    "aliases": ["Verified alias only"],
    "relationshipFacts": ["Verified relationship to another actorId"],
    "firstSeenSec": 0.0,
    "evidenceIds": ["evidence_0001"],
    "confidence": 0.95
  }],
  "actionCandidateDecisions": [{
    "actionCandidateId": "action_0001",
    "verdict": "essential | supporting | not_relevant",
    "reason": "Concrete visual reason after watching this range",
    "actionType": "vehicle_theft | pursuit | struggle | crash | other",
    "actionSequenceId": "action_sequence_01",
    "evidenceIds": ["evidence_0001"]
  }],
  "evidence": [
    {
      "evidenceId": "evidence_0001",
      "sceneId": "scene_0001",
      "sourceStartSec": 0.0,
      "sourceEndSec": 5.0,
      "visualFacts": [
        "Exact subject performs an exact visible action involving a named object."
      ],
      "dialogueEvidence": [
        {
          "startSec": 0.5,
          "endSec": 2.8,
          "text": "Exact verified spoken words"
        }
      ],
      "sourceAudioType": "scene_dialogue",
      "sourceNarratorPresent": false,
      "sourceNarratorText": "",
      "sceneDialoguePresent": true,
      "soundCues": ["Specific verified sound"],
      "storyMeaning": "Evidence-based importance of this moment.",
      "narrativePhase": "hook | context | escalation | climax | consequence | aftermath",
      "completeBeat": true,
      "cutSafety": "safe | unsafe",
      "continuityBefore": "Concrete event immediately before this evidence.",
      "continuityAfter": "Concrete event immediately after this evidence.",
      "uniqueMoment": "Exact detail that makes this moment non-generic.",
      "emotionalTrigger": "Specific viewer emotion caused by verified action/dialogue.",
      "payoff": "The question, reveal, reaction, or consequence completed here.",
      "recommendedUse": "original_audio | voiceover_only | avoid",
      "burnedTextPresent": false,
      "burnedTextContent": "",
      "safeForVoiceover": true,
      "actionCandidateId": "action_0001",
      "actionSequenceId": "action_sequence_01",
      "actionType": "vehicle_theft",
      "actionIntensity": 9.5,
      "visualRetentionScore": 9.5,
      "dialogueDependency": "none | low | high",
      "actorIds": ["actor_001"],
      "primaryActorId": "actor_001",
      "speakerActorId": "actor_001",
      "relationshipFacts": ["Verified relationship relevant to this exact range"],
      "originalAudioValueScore": 9.0,
      "originalAudioValueReason": "Exact authentic quote, reaction, command, or sound that should remain audible",
      "originalAudioProtected": true,
      "narrativeEssential": true,
      "mustInclude": true,
      "stakeRole": "none | threat_open | stake_context | escalation | victim_resolution | hazard_resolution | suspect_resolution | legal_resolution",
      "stakeActorIds": ["actor_001"],
      "opensQuestion": "Exact concrete question opened by this threat/Hook",
      "resolvesQuestion": "Exact earlier question answered by this evidence",
      "resolutionType": "rescue | safety_confirmation | medical_outcome | hazard_removed | evidence_reveal | suspect_outcome | unknown",
      "resolutionModality": "none | visual | verbal | mixed",
      "visualProofScore": 0,
      "proceduralBloat": false,
      "proceduralBloatType": "none | written_statement | paperwork | phone_number | name_spelling | forms | routine_report | station_instruction | other",
      "mustAppearBeforeLaterTimeJump": true,
      "containsUnexplainedJargon": false,
      "jargonTerms": ["10-5"],
      "actionOverride": true,
      "hookScore": 9.0,
      "retentionScore": 8.5,
      "clarityScore": 9.0,
      "viralScore": 8.5,
      "confidence": 0.95,
      "keywords": ["specific", "searchable", "facts"]
    }
  ]
}`;
}

function buildStoryRecutEvidencePromptTemplate() {
  return `${buildManualGeminiPromptTemplate().replace(
    "Watch the complete proxy and create a precise scene-evidence.json containing enough verified candidate moments to build exactly three independent True Crime/Bodycam highlight scripts later, each at least 60.5 seconds: one 60.5-120 second Narrated Raw Reality clean-hybrid highlight with 2-3 short narrator bridges, one 90-240 second Mini-Doc, and one 60.5-120 second 80/20 Raw Reality variant.",
    "Watch the complete proxy and create a precise scene-evidence.json containing enough verified candidate moments to build one coherent Story Recut of at least 60 seconds. There is no maximum output duration. Extract complete Hook candidates, context, causal setup, sustained escalation exchanges, climax, consequence, aftermath, and all adjacent source material required to connect them truthfully. Preserve compelling continuous passages even when one passage lasts 2-3 minutes or longer. The later edit may open nonlinearly, but it must preserve the verified causal chain and must never become a montage of isolated shocking moments."
  )}

STORY RECUT SOURCE-AUDIO-ONLY OVERRIDE:
- The final Story Recut uses zero tool narration and zero synthesized voice.
- Prioritize complete ranges whose existing narrator, dialogue, radio, reactions, ambience, music, and sound effects can tell the story by themselves.
- Preserve source narrator as original audio; never classify it for replacement.
- recommendedUse must be "original_audio" or "avoid" for this workflow. Do not recommend voiceover_only.
- Include enough source-adjacent context and complete spoken beats to connect Hook, Context, Escalation, Climax, and Consequence without any added explanation.`;
}

function clearManualGeminiScriptSelection() {
  if (!el.storyScriptPath) return;
  el.storyScriptPath.value = "";
  el.storyScriptPath.dataset.paths = "[]";
}

const MANUAL_GEMINI_V1_ARTIFACT_TYPES = new Set([
  "story_recut_script",
  "story_spine_edit_script"
]);

function isManualGeminiV1Artifact(inspection) {
  return Boolean(
    inspection?.validJson
    && MANUAL_GEMINI_V1_ARTIFACT_TYPES.has(inspection.type)
    && Number(inspection.segmentCount || 0) > 0
  );
}

function setManualStageFolder(button, folderPath = "", label = "") {
  if (!button) return;
  const normalizedPath = String(folderPath || "").trim();
  if (normalizedPath) button.dataset.openPath = normalizedPath;
  else delete button.dataset.openPath;
  button.disabled = !normalizedPath;
  if (label) button.textContent = label;
}

async function openManualStageFolder(button, emptyMessage) {
  const folderPath = button?.dataset.openPath;
  if (!folderPath) {
    showToast(emptyMessage);
    return;
  }
  await window.cineviral.openFile(folderPath);
}

async function applyAntigravityVariantSelection(filePaths = []) {
  const requestedIds = getRequestedIndependentScriptIds();
  const inspectedFiles = await window.cineviral.inspectGeminiJsonFiles(filePaths);
  const invalid = inspectedFiles.find((item) => (
    !isManualGeminiV1Artifact(item)
    || !requestedIds.includes(Number(item.scriptId))
  ));
  if (invalid) {
    throw new Error(`Kết quả ${invalid.filePath || "JSON"} không phải variant V1 hợp lệ: ${invalid.error || invalid.type}.`);
  }
  const scriptIds = inspectedFiles.map((item) => Number(item.scriptId));
  if (new Set(scriptIds).size !== scriptIds.length) {
    throw new Error("Antigravity trả nhiều JSON trùng scriptId.");
  }
  const sortedPaths = inspectedFiles
    .sort((left, right) => requestedIds.indexOf(Number(left.scriptId)) - requestedIds.indexOf(Number(right.scriptId)))
    .map((item) => item.filePath);
  el.storyScriptPath.dataset.paths = JSON.stringify(sortedPaths);
  el.storyScriptPath.value = sortedPaths.length > 1
    ? `Đã chọn ${sortedPaths.length} file JSON`
    : sortedPaths[0];
  addLog(`AI đã tạo và chọn ${sortedPaths.length} JSON variant hợp lệ.`);
  const firstScript = inspectedFiles[0];
  if (firstScript) {
    const isViralMode = readManualGeminiPromptOptions().profile === "viral_tiktok_crime_part1"
      || firstScript.titleStyle === "viral_green";
    if (isViralMode) {
      if (el.videoCanvasAspect) el.videoCanvasAspect.value = "9:16";
      if (el.blurBackgroundEnabled) el.blurBackgroundEnabled.checked = true;
      if (el.topCaptionEnabled) el.topCaptionEnabled.checked = true;
      if (el.topCaptionStyle) el.topCaptionStyle.value = "viral_green";
      if (firstScript.suggestedTitle && el.topCaptionText) {
        el.topCaptionText.value = firstScript.suggestedTitle;
      }
      if (el.partLabelEnabled) el.partLabelEnabled.checked = true;
      if (el.partLabelStyle) el.partLabelStyle.value = "viral_green";
      if (firstScript.partBadge && el.partLabelText) {
        el.partLabelText.value = firstScript.partBadge;
      }
      if (el.cameraLabelEnabled) el.cameraLabelEnabled.checked = true;
      if (el.cameraLabelText) el.cameraLabelText.value = firstScript.cameraLabel || "CAM 1";
      if (el.showSubtitles) el.showSubtitles.checked = true;
      const subtitleSelect = $("subtitle-style");
      if (subtitleSelect) subtitleSelect.value = "tiktok_karaoke";
      activateVideoEditLivePreview();
      updateVideoDecorationPreview();
      persistVideoEditSettingsSoon();
    } else if (firstScript.suggestedTitle && el.topCaptionText && !el.topCaptionText.value.trim()) {
      el.topCaptionText.value = firstScript.suggestedTitle;
      if (el.topCaptionEnabled) el.topCaptionEnabled.checked = true;
    }
  }
  updateReview();
  writeSetupDraft();
  return sortedPaths;
}

async function runManualAntigravityStage1() {
  if (!isManualGeminiProMode()) {
    showToast("Tính năng này chỉ dùng trong chế độ Viết kịch bản rồi review video thật.");
    return;
  }
  const packageDir = el.manualGeminiPackPath?.value;
  if (!packageDir) {
    showToast("Hãy tạo gói phân tích GĐ1 trước.");
    return;
  }
  setBusy(true);
  const aiInfo = getConfiguredAiUiInfo();
  if (!aiInfo.supported) {
    showToast(aiInfo.reason);
    setBusy(false);
    return;
  }
  state.activeOperation = `${aiInfo.label} đang phân tích GĐ1`;
  setExportProgress(4, state.activeOperation);
  el.cancelManualAntigravityStage1?.classList.remove("hidden");
  if (el.cancelManualAntigravityStage1) el.cancelManualAntigravityStage1.disabled = false;
  if (el.aiAnalysisTerminal) {
    el.aiAnalysisTerminal.classList.remove("hidden");
    el.aiAnalysisTerminal.classList.remove("is-thinking");
    if (el.aiTerminalPercentage) el.aiTerminalPercentage.textContent = "0%";
    if (el.aiTerminalProgressBar) el.aiTerminalProgressBar.style.width = "0%";
    if (el.aiTerminalLog) el.aiTerminalLog.textContent = `Đang khởi động ${aiInfo.label}...`;
  }
  if (el.manualAntigravityStage1Status) {
    el.manualAntigravityStage1Status.classList.add("hidden");
    el.manualAntigravityStage1Status.textContent = `Đang đọc nguyên gói GĐ1 bằng ${aiInfo.label} - ${aiInfo.model}...`;
  }
  try {
    const saved = await window.cineviral.saveSettings(readSettings());
    state.settings = saved.settings;
    const result = await window.cineviral.runConfiguredAiStage1({ packageDir });
    const selectedPaths = await applyAntigravityVariantSelection(result.validFiles || []);
    setManualStageFolder(el.openManualAntigravityResult, result.resultDir, "Mở kết quả AI");
    el.openManualAntigravityResult?.classList.remove("hidden");
    if (el.manualAntigravityStage1Status) {
      el.manualAntigravityStage1Status.innerHTML = `
        <strong>${escapeHtml(result.providerLabel || aiInfo.label)} đã tạo ${selectedPaths.length} JSON variant hợp lệ và đưa vào bộ chọn.</strong>
        <span>${escapeHtml(result.resultDir)}</span>
        ${result.warnings?.length ? `<small>${escapeHtml(result.warnings.join(" | "))}</small>` : ""}
      `;
    }
    (result.warnings || []).forEach((warning) => addLog(warning, "WARNING"));
    if (result.usage) {
      addLog(`Vertex AI GĐ1: ${result.usage.model} · ${result.usage.inputTokens || 0} input + ${result.usage.outputTokens || 0} output token · ước tính $${Number(result.usage.estimatedCostUsd || 0).toFixed(4)}.`);
    }
    if (result.timings) {
      addLog(
        `Thời gian Vertex GĐ1: chuẩn bị/upload ${(Number(result.timings.prepareMs || 0) / 1000).toFixed(1)}s · `
        + `model ${(Number(result.timings.modelMs || 0) / 1000).toFixed(1)}s · tổng ${(Number(result.timings.totalMs || 0) / 1000).toFixed(1)}s.`
      );
    }
    showToast(`${result.providerLabel || aiInfo.label} đã hoàn tất ${selectedPaths.length} variant. Hãy kiểm tra rồi bấm Tiếp tục.`);
    return selectedPaths;
  } catch (error) {
    const cancelled = /Đã dừng|aborted/i.test(error.message || "");
    addLog(error.message, cancelled ? "WARNING" : "ERROR");
    if (el.manualAntigravityStage1Status) el.manualAntigravityStage1Status.textContent = error.message;
    showToast(error.message);
  } finally {
    if (el.aiAnalysisTerminal) el.aiAnalysisTerminal.classList.add("hidden");
    if (el.manualAntigravityStage1Status) el.manualAntigravityStage1Status.classList.remove("hidden");
    el.cancelManualAntigravityStage1?.classList.add("hidden");
    setBusy(false);
    if (el.runManualAntigravityStage1) {
      el.runManualAntigravityStage1.disabled = !el.manualGeminiPackPath?.value || !isManualGeminiProMode();
    }
    if (el.openManualAntigravityResult) {
      el.openManualAntigravityResult.disabled = !el.openManualAntigravityResult.dataset.openPath;
    }
    writeSetupDraft();
  }
}

async function cancelManualAntigravityStage1() {
  if (el.cancelManualAntigravityStage1) el.cancelManualAntigravityStage1.disabled = true;
  const result = await window.cineviral.cancelConfiguredAi();
  if (el.manualAntigravityStage1Status) {
    el.manualAntigravityStage1Status.textContent = result.cancelled
      ? "Đang dừng tác vụ AI..."
      : "Không có tác vụ AI nào đang chạy.";
  }
}

async function createManualGeminiAnalysisPack() {
  if (!isManualGeminiWorkflowMode()) return;
  if (isStoryRecutMode() && !el.storyRecutRightsConfirmed?.checked) {
    showToast("Hãy xác nhận quyền sử dụng video nguồn trước khi tạo gói Story Recut.");
    return;
  }
  const sourceVideoPath = el.sourceVideoPath?.value.trim();
  if (!sourceVideoPath) {
    showToast("Hãy chọn video nguồn trước.");
    return;
  }
  if (isPodcastViralMode() && !/^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(el.podcastYoutubeUrl?.value.trim() || "")) {
    showToast("Hãy nhập URL YouTube công khai của đúng video Podcast.");
    return;
  }
  let createdResult = null;
  setBusy(true);
  state.activeOperation = "Đang tạo gói Gemini Pro";
  setExportProgress(3, state.activeOperation);
  if (el.manualGeminiPackStatus) {
    el.manualGeminiPackStatus.textContent = "Đang phát hiện cảnh và tạo proxy tham chiếu...";
  }
  try {
    const saved = await window.cineviral.saveSettings(readSettings());
    state.settings = saved.settings;
    if (!isPodcastViralMode()) {
      try {
        const storedProfile = await hydrateFinalVoiceCalibrationFromStoredProfile();
        if (storedProfile?.profile) {
          addLog(
            `Đã dùng voice profile đã học: ${storedProfile.profile.conservativeWordsPerSecond || storedProfile.profile.wordsPerSecond} từ/giây (${storedProfile.profile.sampleCount} mẫu).`
          );
        }
      } catch (error) {
        addLog(`Không nạp được voice profile đã lưu: ${error.message}`, "WARNING");
      }
    }
    const result = await window.cineviral.createManualGeminiPack({
      sourceVideoPath,
      subtitleSourcePath: el.subtitlePath?.value.trim() || "",
      prompt: isDiyStoryRemixMode()
        ? buildDiyStoryRemixPromptContext()
        : isStoryRecutMode()
        ? buildStoryRecutEvidencePromptTemplate()
        : buildHighlightGeminiPromptTemplate(),
      workflow: isDiyStoryRemixMode()
        ? "manual_gemini_diy_story_remix"
        : isStoryRecutMode()
        ? "manual_gemini_story_recut"
        : isPodcastViralMode()
        ? "manual_gemini_podcast_cut"
        : "manual_gemini_draft_review",
      youtubeUrl: el.podcastYoutubeUrl?.value.trim() || "",
      workflowMode: el.podcastWorkflowMode?.value || "quality_two_pass",
      outputCount: Number(el.podcastOutputCount?.value || 3),
      targetMinSec: Number(el.podcastTargetMin?.value || 45),
      targetMaxSec: Number(el.podcastTargetMax?.value || 60),
      cleanupMode: el.podcastCleanupMode?.value || "balanced",
      sourceLanguage: el.sourceLanguage?.value || "auto",
      autoWhisper: Boolean(el.autoWhisper?.checked),
      forceRebuild: Boolean(el.manualGeminiForceRebuild?.checked)
    });
    createdResult = result;
    const cacheHits = result.cache?.hits || [];
    const cacheMisses = result.cache?.misses || [];
    const cacheCreated = result.cache?.created || [];
    el.manualGeminiPackPath.value = result.packageDir;
    setManualStageFolder(el.openManualGeminiPack, result.pass1UploadDir || result.packageDir, "Mở thư mục GĐ1");
    if (el.runManualAntigravityStage1) {
      el.runManualAntigravityStage1.disabled = !isManualGeminiProMode();
    }
    if (el.openManualAntigravityResult) {
      setManualStageFolder(el.openManualAntigravityResult, "", "Mở kết quả AI");
      el.openManualAntigravityResult.classList.add("hidden");
    }
    if (el.manualAntigravityStage1Status) {
      el.manualAntigravityStage1Status.textContent = isManualGeminiProMode()
        ? "Gói đã sẵn sàng. Có thể gửi Gemini thủ công hoặc phân tích ngay bằng AI trong Cài đặt."
        : "Phân tích AI GĐ1 chỉ áp dụng cho chế độ Viết kịch bản rồi review video thật.";
    }
    setManualStageFolder(el.openManualGeminiEvidenceFolder, "", "Mở thư mục GĐ2");
    setManualStageFolder(el.openManualGeminiBlueprintFolder, "", "Mở thư mục GĐ3");
    el.manualGeminiPackStatus.innerHTML = `
      <strong>${isPodcastViralMode()
        ? `Gói Podcast đã khóa ${Number(result.dialogueUnitCount || 0)} đơn vị hội thoại, chia ${Number(result.dialogueUnitPartCount || 0)} phần rút gọn (${Number(result.uploadFileCount || 0)}/10 file gửi Gemini).`
        : `Giai đoạn 1 đã sẵn sàng với ${Number(result.sceneCount || 0)} cảnh.`}</strong>
      <span>Thư mục gửi Gemini: ${escapeHtml(result.pass1UploadDir || result.packageDir)}</span>
      <small>Cache: dùng lại ${cacheHits.length} mục · tạo mới thành công ${cacheCreated.length}/${cacheMisses.length} mục.</small>
      ${result.warnings?.length ? `<small>${escapeHtml(result.warnings.join(" | "))}</small>` : ""}
    `;
    if (el.manualGeminiEvidencePath) el.manualGeminiEvidencePath.value = "";
    if (el.manualGeminiEvidenceStatus) {
      el.manualGeminiEvidenceStatus.textContent = isDiyStoryRemixMode()
        ? "Chưa có Visual Process Map đã được kiểm tra."
        : "Chưa có scene evidence đã được kiểm tra.";
    }
    if (el.manualGeminiBlueprintPath) el.manualGeminiBlueprintPath.value = "";
    if (el.importManualGeminiBlueprint) el.importManualGeminiBlueprint.disabled = true;
    if (el.manualGeminiBlueprintStatus) {
      el.manualGeminiBlueprintStatus.textContent = "Chưa có story blueprint đã được kiểm tra.";
    }
    if (el.openManualGeminiVariants) {
      el.openManualGeminiVariants.disabled = true;
      delete el.openManualGeminiVariants.dataset.openPath;
    }
    if (el.manualGeminiVariantStatus) el.manualGeminiVariantStatus.textContent = "Chưa tạo prompt variant.";
    clearManualGeminiScriptSelection();
    el.importManualGeminiEvidence.disabled = isManualGeminiProMode()
      || (isPodcastViralMode() && result.workflowMode !== "quality_two_pass");
    writeSetupDraft();
    addLog(`Gói phân tích Gemini Pro đã sẵn sàng: ${result.packageDir}`);
    if (Array.isArray(result.proxyUploadBatchDirs) && result.proxyUploadBatchDirs.length > 1) {
      addLog(`Video dài đã được chia thành ${result.proxyChunkCount} proxy ngắn. Gửi các batch theo thứ tự vào cùng một chat Gemini.`);
      result.proxyUploadBatchDirs.forEach((batchDir, index) => {
        addLog(`Giai đoạn 1 - batch ${index + 1}/${result.proxyUploadBatchDirs.length}: ${batchDir}`);
      });
    } else {
      addLog(`Giai đoạn 1 - gửi toàn bộ file trong: ${result.pass1UploadDir || result.packageDir}`);
    }
    cacheHits.forEach((item) => addLog(`[CACHE] Dùng lại ${item}.`));
    cacheCreated.forEach((item) => addLog(`[CACHE] Đã tạo mới ${item}.`));
    if (result.warnings?.length) {
      result.warnings.forEach((warning) => addLog(warning, "WARNING"));
    }
    showToast(isPodcastViralMode()
      ? result.workflowMode === "quality_two_pass"
        ? "Đã tạo gói Scene Scout. Hãy gửi GĐ1 cho Gemini rồi nhập Candidate Map."
        : `Đã tạo gói một lượt. Gemini cần trả đúng ${result.outputCount} JSON Podcast.`
      : isDiyStoryRemixMode()
      ? "Đã tạo gói Visual Process Map. Hãy gửi thư mục cho Gemini."
      : isStoryRecutMode()
      ? "Đã tạo gói evidence Story Recut."
      : "Đã tạo gói Lượt 1. Hãy gửi toàn bộ thư mục cho Gemini và tải ba JSON Highlight.");
  } catch (error) {
    addLog(error.message, "ERROR");
    if (el.manualGeminiPackStatus) el.manualGeminiPackStatus.textContent = error.message;
    showToast(error.message);
  } finally {
    setBusy(false);
    el.openManualGeminiPack.disabled = !el.openManualGeminiPack.dataset.openPath;
    if (el.runManualAntigravityStage1) {
      el.runManualAntigravityStage1.disabled = !isManualGeminiProMode() || !el.manualGeminiPackPath?.value;
    }
    el.importManualGeminiEvidence.disabled = !el.manualGeminiPackPath?.value
      || isManualGeminiProMode()
      || (isPodcastViralMode() && !isPodcastTwoPassMode());
  }
  syncConfiguredAiWorkflowUi();
  return createdResult;
}

async function createAndRunConfiguredStage1() {
  const aiInfo = getConfiguredAiUiInfo();
  const autoLevel = aiInfo.provider === "vertex_ai" ? (el.configuredAiAutoLevel?.value || "review") : "scripts";
  const setAutoStatus = (message) => {
    if (el.configuredAiAutoStatus) el.configuredAiAutoStatus.textContent = message;
    addLog(message);
  };
  setAutoStatus("1/5 · Đang tạo và kiểm tra gói phân tích...");
  const result = await createManualGeminiAnalysisPack();
  if (!result || !isManualGeminiProMode()) return;
  setAutoStatus("2/5 · AI đang xem nguồn và tạo kịch bản...");
  const selectedPaths = await runManualAntigravityStage1();
  if (!selectedPaths?.length || autoLevel === "scripts") {
    if (selectedPaths?.length) setAutoStatus(`Hoàn tất · Đã tạo ${selectedPaths.length} kịch bản hợp lệ.`);
    return;
  }
  setAutoStatus("3/5 · Đang tạo project và nhập các variant...");
  const project = await createAndIngestProject();
  if (!project) return;
  // Bug-2 fix: do not render when no variants/scripts exist.
  if (!getHighlightVariants(project).length) {
    setAutoStatus("Dừng · Không có kịch bản hợp lệ để render draft.");
    addLog("AutoStory: 0 kịch bản hợp lệ — bỏ qua render draft.", "ERROR");
    return;
  }
  setAutoStatus("4/5 · Đang render draft tất cả variant...");
  const rendered = getHighlightVariants(project).length > 1
    ? await renderAllFastDraftVariants({ skipConfirm: true })
    : await renderFastDraftVideo();
  if (!rendered || autoLevel === "draft") {
    if (rendered) addLog("Pipeline Vertex đã dừng tại bản draft theo cấu hình.");
    return;
  }
  setAutoStatus("5/5 · Vertex đang review từng draft và tạo đề xuất V2...");
  await reviewAllDraftVariantsWithConfiguredAi();
}

async function importManualGeminiEvidence() {
  const packageDir = el.manualGeminiPackPath?.value;
  if (!packageDir) {
    showToast("Hãy tạo gói phân tích lượt 1 trước.");
    return;
  }
  const evidencePath = await window.cineviral.pickJson();
  if (!evidencePath) return;
  if (isPodcastViralMode()) {
    const [inspection] = await window.cineviral.inspectGeminiJsonFiles([evidencePath]);
    if (!inspection?.validJson || inspection.type !== "podcast_candidate_map") {
      const detail = inspection?.validJson
        ? `File đang là ${inspection.type || "JSON khác"}, không phải podcast_candidate_map.`
        : (inspection?.error || "JSON không hợp lệ.");
      showToast(`${detail} Hãy chọn Candidate Map từ Gemini lượt 1.`);
      addLog(`Đã từ chối Candidate Map sai định dạng: ${evidencePath}. ${detail}`, "WARNING");
      return;
    }
    setBusy(true);
    state.activeOperation = "Đang tạo Candidate Reel và gói Assembly";
    setExportProgress(20, state.activeOperation);
    if (el.manualGeminiEvidenceStatus) {
      el.manualGeminiEvidenceStatus.textContent = "Đang cắt các ứng viên, đo lại lời thoại và tạo prompt lượt 2...";
    }
    try {
      const result = await window.cineviral.importPodcastCandidates({ packageDir, candidatePath: evidencePath });
      el.manualGeminiEvidencePath.value = result.candidateMapPath || evidencePath;
      setManualStageFolder(el.openManualGeminiEvidenceFolder, result.stage2UploadDir, "Mở thư mục Assembly");
      el.manualGeminiEvidenceStatus.innerHTML = `
        <strong>Đã khóa ${Number(result.candidateCount || 0)} ứng viên và tạo ${Number(result.reelCount || 0)} Candidate Reel.</strong>
        <span>Gửi toàn bộ ${Number(result.uploadFileCount || 0)}/10 file trong: ${escapeHtml(result.stage2UploadDir || "")}</span>
        <small>Gemini lượt 2 sẽ dựng ${Number(result.outputCount || 0)} EDL từ các cảnh đã được tool đo lại timestamp.</small>
      `;
      clearManualGeminiScriptSelection();
      writeSetupDraft();
      addLog(`Đã tạo gói Assembly Podcast: ${result.stage2UploadDir}`);
      showToast("Candidate Reel đã sẵn sàng. Hãy gửi thư mục Assembly cho Gemini lượt 2.");
    } catch (error) {
      addLog(error.message, "ERROR");
      if (el.manualGeminiEvidenceStatus) el.manualGeminiEvidenceStatus.textContent = error.message;
      showToast(error.message);
    } finally {
      setBusy(false);
    }
    return;
  }
  if (isDiyStoryRemixMode()) {
    const [inspection] = await window.cineviral.inspectGeminiJsonFiles([evidencePath]);
    if (!inspection?.validJson || inspection.type !== "diy_visual_process_map") {
      const stageHint = inspection?.type === "diy_story_blueprint"
        ? "Đây là Blueprint Giai đoạn 3."
        : inspection?.type === "story_recut_script"
        ? "Đây là Voice-Locked Script Giai đoạn 4."
        : "File không có artifactType=diy_visual_process_map và mảng visualBeats.";
      showToast(`${stageHint} Hãy chọn JSON Visual Process Map của Giai đoạn 1/2.`);
      addLog(`Đã từ chối file sai giai đoạn: ${evidencePath}. ${stageHint}`, "WARNING");
      return;
    }
  }

  setBusy(true);
  state.activeOperation = isDiyStoryRemixMode() ? "Đang kiểm tra Visual Process Map" : "Đang kiểm tra scene evidence";
  setExportProgress(20, state.activeOperation);
  if (el.manualGeminiEvidenceStatus) {
    el.manualGeminiEvidenceStatus.textContent = isDiyStoryRemixMode()
      ? "Đang đối chiếu trạng thái trước/sau, thao tác, sceneId và dependency vật lý..."
      : "Đang đối chiếu sceneId, timestamp và bằng chứng...";
  }
  try {
    const result = await window.cineviral.importManualGeminiEvidence({
      packageDir,
      evidencePath,
      scriptPrompt: isDiyStoryRemixMode()
        ? buildDiyStoryRemixPromptContext()
        : isStoryRecutMode()
        ? buildStoryRecutGeminiPromptTemplate()
        : buildHighlightGeminiPromptTemplate(),
      workflow: isDiyStoryRemixMode()
        ? "manual_gemini_diy_story_remix"
        : isStoryRecutMode()
        ? "manual_gemini_story_recut"
        : "manual_gemini_pro_two_pass"
    });
    el.manualGeminiEvidencePath.value = result.evidencePath || "";
    clearManualGeminiScriptSelection();
    if (el.manualGeminiBlueprintPath) el.manualGeminiBlueprintPath.value = "";
    if (el.manualGeminiBlueprintStatus) el.manualGeminiBlueprintStatus.textContent = "Chưa có story blueprint đã được kiểm tra.";
    if (el.openManualGeminiVariants) {
      el.openManualGeminiVariants.disabled = true;
      delete el.openManualGeminiVariants.dataset.openPath;
    }
    if (el.manualGeminiVariantStatus) el.manualGeminiVariantStatus.textContent = "Chưa tạo prompt variant.";
    const qualityGate = result.qualityGate || { passed: true, score: 100, failures: [] };
    if (["evidence_repair", "diy_process_repair"].includes(result.nextStage)) {
      setManualStageFolder(
        el.openManualGeminiEvidenceFolder,
        result.nextStageDir || result.pass2UploadDir || "",
        isDiyStoryRemixMode() ? "Mở thư mục sửa Process Map" : "Mở thư mục sửa Evidence"
      );
      setManualStageFolder(el.openManualGeminiBlueprintFolder, "", "Mở thư mục GĐ3");
      el.manualGeminiEvidenceStatus.innerHTML = `
        <strong>Evidence chưa đạt Quality Gate: ${Number(qualityGate.score || 0)}/100.</strong>
        <span>Mở thư mục sửa: ${escapeHtml(result.nextStageDir || result.scriptPromptPath)}</span>
        <small>${escapeHtml((qualityGate.failures || []).join(" | "))}</small>
      `;
      if (el.importManualGeminiBlueprint) el.importManualGeminiBlueprint.disabled = true;
    } else {
      setManualStageFolder(el.openManualGeminiEvidenceFolder, "", "Mở thư mục GĐ2");
      if (isStoryRecutMode()) {
        setManualStageFolder(el.openManualGeminiEvidenceFolder, result.nextStageDir || result.pass2UploadDir || "", "Mở thư mục script GĐ2");
      } else {
        setManualStageFolder(el.openManualGeminiBlueprintFolder, result.nextStageDir || result.pass2UploadDir || "", "Mở thư mục GĐ3");
      }
      el.manualGeminiEvidenceStatus.innerHTML = `
        <strong>Đã khóa ${Number(result.evidenceCount || 0)} bằng chứng · Quality Gate ${Number(qualityGate.score || 100)}/100.</strong>
        <span>Bước tiếp theo: ${escapeHtml(result.pass2UploadDir || result.scriptPromptPath)}</span>
        ${result.warnings?.length ? `<small>${escapeHtml(result.warnings.join(" | "))}</small>` : ""}
      `;
      if (el.importManualGeminiBlueprint) {
        el.importManualGeminiBlueprint.disabled = isStoryRecutMode();
      }
    }
    writeSetupDraft();
    const needsEvidenceRepair = ["evidence_repair", "diy_process_repair"].includes(result.nextStage);
    addLog(needsEvidenceRepair
      ? isDiyStoryRemixMode()
        ? `Visual Process Map chưa đạt (${qualityGate.score}/100). Cần bổ sung dữ liệu quá trình trước khi tạo Blueprint.`
        : `Evidence Quality Gate chưa đạt (${qualityGate.score}/100). Cần bổ sung evidence trước khi tạo blueprint.`
      : isDiyStoryRemixMode()
      ? `Đã kiểm tra và khóa ${result.evidenceCount} visual beat.`
      : `Đã kiểm tra và khóa ${result.evidenceCount} scene evidence.`, needsEvidenceRepair ? "WARNING" : "INFO");
    addLog(`Prompt bước tiếp theo: ${result.scriptPromptPath}`);
    addLog(`Thư mục bước tiếp theo: ${result.pass2UploadDir || result.scriptPromptPath}`);
    (result.warnings || []).forEach((warning) => addLog(warning, "WARNING"));
    showToast(["evidence_repair", "diy_process_repair"].includes(result.nextStage)
      ? isDiyStoryRemixMode()
        ? "Process Map chưa đạt. Hãy gửi prompt sửa cho Gemini rồi nhập lại JSON."
        : "Evidence chưa đạt. Hãy gửi prompt bổ sung cho Gemini rồi nhập lại scene-evidence.json."
      : isDiyStoryRemixMode()
      ? "Process Map hợp lệ. Hãy gửi prompt để Gemini tạo DIY Story Blueprint."
      : isStoryRecutMode()
      ? "Scene evidence hợp lệ. Hãy gửi prompt lượt 2 để Gemini tạo story-recut.json."
      : "Evidence đã đạt. Hãy gửi prompt để Gemini tạo story-blueprint.json.");
  } catch (error) {
    addLog(error.message, "ERROR");
    if (el.manualGeminiEvidenceStatus) el.manualGeminiEvidenceStatus.textContent = error.message;
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

async function importManualGeminiBlueprint() {
  const packageDir = el.manualGeminiPackPath?.value;
  if (!packageDir || !el.manualGeminiEvidencePath?.value) {
    showToast("Hãy hoàn tất Evidence Quality Gate trước.");
    return;
  }
  const blueprintPath = await window.cineviral.pickJson();
  if (!blueprintPath) return;
  if (isDiyStoryRemixMode()) {
    const [inspection] = await window.cineviral.inspectGeminiJsonFiles([blueprintPath]);
    if (!inspection?.validJson || inspection.type !== "diy_story_blueprint") {
      const stageHint = inspection?.type === "diy_visual_process_map"
        ? "Đây là Visual Process Map Giai đoạn 1/2."
        : inspection?.type === "story_recut_script"
        ? "Đây là Voice-Locked Script Giai đoạn 4."
        : "File không có artifactType=diy_story_blueprint và mảng blocks.";
      showToast(`${stageHint} Hãy chọn JSON Blueprint của Giai đoạn 3.`);
      addLog(`Đã từ chối file Blueprint sai giai đoạn: ${blueprintPath}. ${stageHint}`, "WARNING");
      return;
    }
  }
  setBusy(true);
  state.activeOperation = isDiyStoryRemixMode() ? "Đang kiểm tra DIY Story Blueprint" : "Đang kiểm tra story blueprint";
  setExportProgress(30, state.activeOperation);
  if (el.manualGeminiBlueprintStatus) {
    el.manualGeminiBlueprintStatus.textContent = isDiyStoryRemixMode()
      ? "Đang kiểm tra Story Profile, macro-block và dependency của quá trình DIY..."
      : "Đang kiểm tra causal chain, macro-block và evidenceId...";
  }
  try {
    const result = await window.cineviral.importManualGeminiBlueprint({
      packageDir,
      blueprintPath,
      scriptPrompt: isDiyStoryRemixMode()
        ? buildDiyStoryRemixPromptContext()
        : buildHighlightGeminiPromptTemplate()
    });
    el.manualGeminiBlueprintPath.value = result.blueprintPath;
    el.manualGeminiBlueprintStatus.innerHTML = `
      <strong>Đã khóa blueprint gồm ${Number(result.macroBlockCount || 0)} macro-block.</strong>
      <span>${isDiyStoryRemixMode() ? "Prompt Voice-Locked Script" : `${Number(result.variantDirs?.length || 0)} prompt variant`}: ${escapeHtml(result.variantRootDir)}</span>
    `;
    el.openManualGeminiVariants.dataset.openPath = result.variantRootDir;
    el.openManualGeminiVariants.disabled = false;
    el.openManualGeminiVariants.textContent = isDiyStoryRemixMode() ? "Mở thư mục Voice Script GĐ4" : "Mở thư mục variant GĐ4";
    el.manualGeminiVariantStatus.innerHTML = isDiyStoryRemixMode()
      ? `<strong>Prompt DIY Voice-Locked Script đã sẵn sàng.</strong><span>Gửi prompt cho Gemini rồi chọn một file diy-story-remix.json ở khung bên dưới.</span>`
      : `<strong>${Number(result.variantDirs?.length || 0)} prompt kịch bản đã sẵn sàng.</strong><span>Gửi prompt cần dùng rồi chọn từ 1 đến ${Number(result.variantDirs?.length || 1)} JSON ở khung bên dưới.</span>`;
    writeSetupDraft();
    addLog(`Đã khóa story blueprint: ${result.blueprintPath}`);
    (result.variantDirs || []).forEach((item) => addLog(isDiyStoryRemixMode()
      ? `Prompt DIY Voice-Locked Script: ${item.promptPath}`
      : `Prompt Script ${item.scriptId}: ${item.promptPath}`));
    showToast(isDiyStoryRemixMode()
      ? "Blueprint hợp lệ. Prompt Voice-Locked Script đã sẵn sàng."
      : `Blueprint hợp lệ. ${Number(result.variantDirs?.length || 0)} prompt variant độc lập đã sẵn sàng.`);
  } catch (error) {
    addLog(error.message, "ERROR");
    if (el.manualGeminiBlueprintStatus) el.manualGeminiBlueprintStatus.textContent = error.message;
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

function invalidateManualGeminiPack(reason = "") {
  if (!el.manualGeminiPackPath?.value && !el.manualGeminiEvidencePath?.value) return;
  el.manualGeminiPackPath.value = "";
  if (el.runManualAntigravityStage1) el.runManualAntigravityStage1.disabled = true;
  if (el.openManualAntigravityResult) {
    setManualStageFolder(el.openManualAntigravityResult, "", "Mở kết quả Antigravity");
    el.openManualAntigravityResult.classList.add("hidden");
  }
  if (el.manualAntigravityStage1Status) {
    el.manualAntigravityStage1Status.textContent = "Kết quả Antigravity đã bị vô hiệu hóa vì dữ liệu nguồn thay đổi.";
  }
  [el.openManualGeminiPack, el.openManualGeminiEvidenceFolder, el.openManualGeminiBlueprintFolder].forEach((button, index) => {
    setManualStageFolder(button, "", `Mở thư mục GĐ${index + 1}`);
  });
  if (el.importManualGeminiEvidence) el.importManualGeminiEvidence.disabled = true;
  if (el.manualGeminiEvidencePath) el.manualGeminiEvidencePath.value = "";
  if (el.manualGeminiBlueprintPath) el.manualGeminiBlueprintPath.value = "";
  if (el.importManualGeminiBlueprint) el.importManualGeminiBlueprint.disabled = true;
  if (el.manualGeminiBlueprintStatus) el.manualGeminiBlueprintStatus.textContent = "Story blueprint đã bị vô hiệu hóa vì dữ liệu nguồn thay đổi.";
  if (el.openManualGeminiVariants) {
    el.openManualGeminiVariants.disabled = true;
    delete el.openManualGeminiVariants.dataset.openPath;
  }
  if (el.manualGeminiVariantStatus) el.manualGeminiVariantStatus.textContent = "Prompt variant đã bị vô hiệu hóa.";
  clearManualGeminiScriptSelection();
  if (el.manualGeminiEvidenceStatus) {
    el.manualGeminiEvidenceStatus.textContent = "Scene evidence đã bị vô hiệu hóa vì dữ liệu nguồn thay đổi.";
  }
  if (el.manualGeminiPackStatus) {
    el.manualGeminiPackStatus.textContent = reason
      ? `${reason} Hãy tạo lại gói phân tích.`
      : "Dữ liệu nguồn đã thay đổi. Hãy tạo lại gói phân tích.";
  }
}

function renderHighlightPromptTemplate() {
  if (!el.highlightPromptTemplate) return;
  el.highlightPromptTemplate.value = buildHighlightGeminiPromptTemplate();
}

async function copyHighlightPromptTemplate() {
  const prompt = buildHighlightGeminiPromptTemplate();
  await navigator.clipboard.writeText(prompt);
  showToast("Đã copy prompt mẫu cho Gemini.");
}

async function loadOllamaModels({ silent = false } = {}) {
  try {
    el.refreshOllamaModels.disabled = true;
    const result = await window.cineviral.listOllamaModels();
    const models = result.models || [];
    if (!models.length) {
      showToast("Chưa tìm thấy model Ollama nào.");
      return;
    }
    const current = el.ollamaVisionModel.value;
    el.ollamaVisionModel.innerHTML = models
      .map((model) => `<option value="${escapeHtml(model.name)}">${escapeHtml(model.name)}</option>`)
      .join("");
    el.ollamaVisionModel.value = models.some((model) => model.name === current) ? current : models[0].name;
    writeSetupDraft();
    if (!silent) showToast(`Đã tải ${models.length} model Ollama từ máy.`);
  } catch (error) {
    showToast(error.message);
  } finally {
    el.refreshOllamaModels.disabled = false;
  }
}

function playLocalAudio(filePath) {
  if (!filePath) {
    showToast("Chưa chọn file audio.");
    return Promise.resolve(false);
  }
  if (state.previewAudio) {
    state.previewAudio.pause();
    state.previewAudio = null;
  }
  const audio = new Audio(toFileUrl(filePath));
  state.previewAudio = audio;
  audio.onended = () => {
    if (state.previewAudio === audio) {
      state.previewAudio = null;
    }
  };
  return audio.play()
    .then(() => true)
    .catch((error) => {
      showToast(`Không phát được file audio: ${error.message}`);
      addLog(`Không phát được file audio: ${error.message}`, "ERROR");
      return false;
    });
}

async function previewVoiceFromControls({
  providerEl,
  listEl,
  fallbackVoiceIdEl = null,
  buttonEl,
  language = "en",
  text = "This is a quick voice preview.",
  onSuccess = null
}) {
  const provider = providerEl?.value || "edge_neural";
  const voiceId = listEl?.value || fallbackVoiceIdEl?.value?.trim() || "";
  if (!voiceId && provider !== "edge_neural") {
    showToast("Hãy chọn một giọng hoặc nhập Voice ID để nghe thử.");
    return;
  }
  const originalText = buttonEl?.textContent || "";
  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.textContent = "Đang tạo...";
  }
  try {
    if (provider === "elevenlabs") {
      if (!el.elevenLabsApiKey.value.trim()) {
        showToast("Hãy nhập ElevenLabs API key trong Settings trước.");
        return;
      }
    }
    if (provider === "elevenlabs" || provider === "edge_neural" || provider === "kokoro") {
      const saved = await window.cineviral.saveSettings(readSettings());
      state.settings = saved.settings;
    }
    addLog(`Đang tạo audio nghe thử bằng ${provider}...`);
    const resolvedLanguage = provider === "kokoro" ? "en" : language;
    const resolvedText = provider === "kokoro"
      ? "Hello, this is a short Kokoro voice preview for your video."
      : text;
    const result = await window.cineviral.testVoice({
      provider,
      voiceId,
      language: resolvedLanguage,
      text: resolvedText
    });
    if (result?.outputPath) {
      addLog(`Đã tạo audio nghe thử: ${result.outputPath}`);
      await playLocalAudio(result.outputPath);
      onSuccess?.();
    } else {
      showToast("Đã tạo giọng thử nhưng không nhận được đường dẫn audio.");
    }
  } catch (error) {
    addLog(error.message, "ERROR");
    showToast(error.message);
  } finally {
    if (buttonEl) {
      buttonEl.disabled = false;
      buttonEl.textContent = originalText;
    }
  }
}

async function loadPresetVoices() {
  await loadVoiceList({
    providerEl: el.presetVoiceProvider,
    listEl: el.presetVoiceList,
    infoEl: el.presetVoiceInfo,
    refreshButton: el.refreshPresetVoices,
    stateKey: "presetVoices",
    preferredVoiceId: el.presetVoiceList.dataset.preferredVoiceId
      || readSetupDraft().lastVoiceSetup?.presetVoiceId
      || readSetupDraft().presetVoiceId
      || state.settings?.lastVoiceSetup?.presetVoiceId
      || state.settings?.defaultVoiceId
      || "",
    onLoaded: updatePresetVoiceInfoFromSelection
  });
}

async function loadDraftVoices() {
  await loadVoiceList({
    providerEl: el.draftVoiceProvider,
    listEl: el.draftVoiceList,
    infoEl: el.draftVoiceInfo,
    refreshButton: el.refreshDraftVoices,
    stateKey: "draftPresetVoices",
    preferredVoiceId: el.draftVoiceList?.dataset.preferredVoiceId
      || el.draftVoiceId?.value
      || readSetupDraft().draftVoiceId
      || "",
    onLoaded: updateDraftVoiceInfoFromSelection
  });
}

function isEdgeNeuralUsEnglishVoice(voice = {}) {
  const id = String(voice.voice_id || voice.id || "");
  const name = String(voice.name || "");
  const labels = voice.labels || {};
  const locale = String(labels.locale || labels.language || "");
  return locale.toLowerCase() === "en-us"
    || /^en-US-/i.test(id)
    || /\ben-US\b/i.test(name);
}

async function loadVoiceList({ providerEl, listEl, infoEl, refreshButton, stateKey, preferredVoiceId = "", onLoaded }) {
  if (!providerEl || !listEl || !infoEl) return;
  const provider = providerEl.value || "edge_neural";
  infoEl.textContent = "Đang tải danh sách giọng...";
  if (refreshButton) refreshButton.disabled = true;
  try {
    if (provider === "elevenlabs") {
      const saved = await window.cineviral.saveSettings(readSettings());
      state.settings = saved.settings;
    }
    const voices = await window.cineviral.listVoices(provider);
    const visibleVoices = provider === "edge_neural"
      ? (voices || []).filter(isEdgeNeuralUsEnglishVoice)
      : (voices || []);
    state[stateKey] = visibleVoices;
    listEl.innerHTML = visibleVoices.map((voice) => {
      const id = voice.voice_id || voice.id || "";
      const name = voice.name || id;
      return `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`;
    }).join("");
    if (preferredVoiceId && [...listEl.options].some((option) => option.value === preferredVoiceId)) {
      listEl.value = preferredVoiceId;
    }
    if (state[stateKey].length) {
      onLoaded?.();
    } else {
      infoEl.textContent = "Provider chưa trả về giọng nào.";
    }
    writeSetupDraft();
  } catch (error) {
    state[stateKey] = [];
    infoEl.innerHTML = `<strong>Không tải được danh sách giọng.</strong><br>${escapeHtml(error.message)}`;
  } finally {
    if (refreshButton) refreshButton.disabled = false;
  }
}

function updatePresetVoiceInfoFromSelection() {
  updateVoiceInfoFromSelection({
    listEl: el.presetVoiceList,
    providerEl: el.presetVoiceProvider,
    infoEl: el.presetVoiceInfo,
    voices: state.presetVoices
  });
  syncHeroVoiceCard();
}

function updateDraftVoiceInfoFromSelection() {
  updateVoiceInfoFromSelection({
    listEl: el.draftVoiceList,
    providerEl: el.draftVoiceProvider,
    infoEl: el.draftVoiceInfo,
    voices: state.draftPresetVoices
  });
  if (el.draftVoiceList?.value) {
    el.draftVoiceMode.value = "custom";
    el.draftVoiceId.value = el.draftVoiceList.value;
  }
}

function updateVoiceInfoFromSelection({ listEl, providerEl, infoEl, voices = [] }) {
  const selected = listEl?.options[listEl.selectedIndex];
  if (!selected) return;
  const voice = voices.find((item) => String(item.voice_id || item.id || "") === selected.value) || {};
  const labels = voice.labels || {};
  infoEl.innerHTML = `
    <strong>${escapeHtml(voice.name || selected.textContent)}</strong>
    <dl>
      <dt>ID</dt><dd>${escapeHtml(selected.value || "Không rõ")}</dd>
      <dt>Provider</dt><dd>${escapeHtml(voice.provider || providerEl?.value || "Không rõ")}</dd>
      <dt>Locale</dt><dd>${escapeHtml(labels.locale || labels.language || "Không rõ")}</dd>
      <dt>Gender</dt><dd>${escapeHtml(labels.gender || "Không rõ")}</dd>
      <dt>Category</dt><dd>${escapeHtml(labels.category || labels.mode || "Không rõ")}</dd>
    </dl>
  `;
}

function syncHeroVoiceCard() {
  if (!el.heroVoiceName) return;
  const activeTab = document.querySelector(".voice-tab.active")?.dataset.voiceTab || "preset";
  const providerLabels = {
    edge_neural: "Edge Neural",
    kokoro: "Kokoro Local",
    elevenlabs: "ElevenLabs",
    omnivoice: "OmniVoice",
    windows_local: "Windows Local"
  };

  if (activeTab === "preset") {
    const providerVal = el.presetVoiceProvider?.value || "edge_neural";
    if (el.heroVoiceProviderBadge) {
      el.heroVoiceProviderBadge.textContent = providerLabels[providerVal] || providerVal;
    }
    const selectedOption = el.presetVoiceList?.options[el.presetVoiceList.selectedIndex];
    const voiceVal = el.presetVoiceList?.value || "";
    const voiceName = selectedOption?.textContent?.trim() || voiceVal || "Guy Neural (en-US-GuyNeural)";
    el.heroVoiceName.textContent = voiceName;

    const activeChip = Array.from(document.querySelectorAll(".btn-voice-chip")).find((chip) => chip.dataset.quickVoice === voiceVal);
    if (activeChip && activeChip.dataset.quickDetail) {
      if (el.heroVoiceDetail) el.heroVoiceDetail.textContent = activeChip.dataset.quickDetail;
      document.querySelectorAll(".btn-voice-chip").forEach((c) => c.classList.toggle("active", c === activeChip));
    } else {
      const speed = el.voiceSpeed?.value ? `${Number(el.voiceSpeed.value).toFixed(2)}x` : "1.0x";
      if (el.heroVoiceDetail) el.heroVoiceDetail.textContent = `${providerLabels[providerVal] || providerVal} · Tốc độ: ${speed}`;
      document.querySelectorAll(".btn-voice-chip").forEach((c) => c.classList.remove("active"));
    }
  } else if (activeTab === "designed") {
    if (el.heroVoiceProviderBadge) el.heroVoiceProviderBadge.textContent = "Thiết kế AI";
    const gender = el.voiceGenderAge?.value || "Nam trung niên";
    const trait = el.voiceTrait?.value || "Trầm ấm, uy quyền";
    el.heroVoiceName.textContent = `${gender} · ${trait}`;
    if (el.heroVoiceDetail) {
      el.heroVoiceDetail.textContent = el.voicePrompt?.value || "Giọng đọc được sinh tự động bằng mô tả ngữ cảnh OmniVoice.";
    }
    document.querySelectorAll(".btn-voice-chip").forEach((c) => c.classList.remove("active"));
  } else if (activeTab === "clone") {
    if (el.heroVoiceProviderBadge) el.heroVoiceProviderBadge.textContent = "Clone giọng";
    const sample = el.voiceSamplePath?.value ? fileName(el.voiceSamplePath.value) : "Chưa chọn file mẫu";
    el.heroVoiceName.textContent = sample;
    if (el.heroVoiceDetail) {
      el.heroVoiceDetail.textContent = "Sao chép âm sắc và ngữ điệu từ file audio mẫu đã chọn.";
    }
    document.querySelectorAll(".btn-voice-chip").forEach((c) => c.classList.remove("active"));
  }
}

function syncElevenLabsSliderLabels() {
  const isCustom = el.elevenLabsSettingsMode?.value === "custom";
  [
    [el.elevenLabsStability, el.elevenLabsStabilityValue],
    [el.elevenLabsSimilarity, el.elevenLabsSimilarityValue],
    [el.elevenLabsStyle, el.elevenLabsStyleValue]
  ].forEach(([input, label]) => {
    if (input) input.disabled = !isCustom;
    if (label) label.textContent = Number(input?.value || 0).toFixed(2);
  });
  if (el.elevenLabsSpeakerBoost) {
    el.elevenLabsSpeakerBoost.disabled = !isCustom;
  }
}

function syncKokoroSpeedLabel() {
  if (el.kokoroSpeedValue) {
    el.kokoroSpeedValue.textContent = `${Number(el.kokoroSpeed?.value || 1).toFixed(2)}x`;
  }
}

function syncSelectedVoiceTuningVisibility() {
  if (!el.localVoiceTuningCard) return;
  const tab = document.querySelector(".voice-tab.active")?.dataset.voiceTab || "designed";
  const provider = tab === "preset" ? (el.presetVoiceProvider?.value || "edge_neural") : "omnivoice";
  const isEdge = provider === "edge_neural";
  const isKokoro = provider === "kokoro";
  el.localVoiceTuningCard.classList.toggle("hidden", !isEdge && !isKokoro);
  el.edgeVoiceTuningControls?.classList.toggle("hidden", !isEdge);
  el.kokoroVoiceTuningControls?.classList.toggle("hidden", !isKokoro);
  if (el.localVoiceTuningTitle) {
    el.localVoiceTuningTitle.textContent = isKokoro
      ? "Tinh chỉnh Kokoro Local"
      : "Tinh chỉnh Edge Neural";
  }
}

const VOICE_TUNING_PRESETS = {
  edge_neural: {
    natural: { rate: 0, pitch: 0, volume: 100 },
    energetic: { rate: 14, pitch: 8, volume: 105 },
    urgent: { rate: 22, pitch: 12, volume: 108 },
    documentary: { rate: 7, pitch: -3, volume: 104 }
  },
  kokoro: {
    natural: { speed: 1 },
    energetic: { speed: 1.12 },
    urgent: { speed: 1.2 },
    documentary: { speed: 1.06 }
  }
};

function signedNumber(value, suffix) {
  const number = Number(value || 0);
  return `${number >= 0 ? "+" : ""}${number}${suffix}`;
}

function syncLocalVoiceTuningLabels() {
  if (el.edgeVoiceRateValue) el.edgeVoiceRateValue.textContent = signedNumber(el.edgeVoiceRate?.value, "%");
  if (el.edgeVoicePitchValue) el.edgeVoicePitchValue.textContent = signedNumber(el.edgeVoicePitch?.value, "Hz");
  if (el.edgeVoiceVolumeValue) el.edgeVoiceVolumeValue.textContent = `${Number(el.edgeVoiceVolume?.value || 100)}%`;
  syncKokoroSpeedLabel();
}

function applyLocalVoicePreset(provider) {
  if (provider === "edge_neural") {
    const preset = VOICE_TUNING_PRESETS.edge_neural[el.edgeVoicePreset?.value];
    if (!preset) return;
    el.edgeVoiceRate.value = String(preset.rate);
    el.edgeVoicePitch.value = String(preset.pitch);
    el.edgeVoiceVolume.value = String(preset.volume);
  } else if (provider === "kokoro") {
    const preset = VOICE_TUNING_PRESETS.kokoro[el.kokoroVoicePreset?.value];
    if (!preset) return;
    el.kokoroSpeed.value = String(preset.speed);
  }
  syncLocalVoiceTuningLabels();
}

function renderSteps() {
  const labels = isRecapMode()
    ? stepLabels
    : [
      "D\u1ef1 \u00e1n",
      "Ch\u1ebf \u0111\u1ed9",
      isPodcastViralMode() ? "\u00c2m thanh g\u1ed1c" : "Gi\u1ecdng",
      "Ngu\u1ed3n",
      isAutoStoryMode() ? "T\u1ef1 \u0111\u1ed9ng" : isScriptRewriteMode() ? "Vi\u1ebft l\u1ea1i" : isSatisfyingStorytimeMode() ? "Storytime" : isHighlightCutMode() ? "Highlight Cut" : "Ng\u00f4n ng\u1eef",
      "Xem tr\u01b0\u1edbc"
    ];
  el.wizardSteps.innerHTML = labels.map((label, index) => {
    const step = index + 1;
    const className = step === state.currentStep ? "active" : step < state.currentStep ? "done" : "";
    return `
      <div class="wizard-step ${className}">
        <span class="step-number">${step < state.currentStep ? "✓" : step}</span>
        <span>${escapeHtml(label)}</span>
      </div>
    `;
  }).join("");

  document.querySelectorAll("[data-step-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", Number(panel.dataset.stepPanel) !== state.currentStep);
  });

  el.prevStep.disabled = state.currentStep === 1 || state.busy;
  el.nextStep.classList.toggle("hidden", state.currentStep === 6);
  el.startIngest.classList.toggle("hidden", state.currentStep !== 6);
  const subtitles = isRecapMode()
    ? [
      "Tạo mới hoặc mở dự án cũ",
      "Recap hoặc Dubbing",
      "Video, phụ đề, đầu ra",
      "Thiết kế / Clone / Mẫu",
      "Nhịp truyện / Dịch thuật",
      "Kiểm tra & bắt đầu"
    ]
    : isScriptRewriteMode()
    ? [
      "Tạo mới hoặc mở dự án cũ",
      "Chọn chế độ viết lại kịch bản",
      "Video, phụ đề, đầu ra",
      "Giọng đọc cho bản kịch bản mới",
      "AI viết lại dựa trên lời thoại gốc, không bịa thêm tình tiết",
      "Kiểm tra & bắt đầu"
    ]
    : isSatisfyingStorytimeMode()
    ? [
      "Tạo mới hoặc mở dự án cũ",
      "Chọn chế độ Oddly Satisfying Storytime",
      "Video và kịch bản JSON từ Gemini",
      "Giọng đọc cho storytime",
      "Kiểm tra timeline và tạo voice khớp từng mốc",
      "Kiểm tra & bắt đầu"
    ]
    : isHighlightCutMode()
    ? [
      "Tạo mới hoặc mở dự án cũ",
      "Chọn chế độ Highlight Cut",
      "Video dài và JSON các đoạn hay nhất",
      "Giọng đọc cho đoạn voiceover",
      "Cắt clip, xử lý audio_mode và caption",
      "Kiểm tra & bắt đầu"
    ]
    : isAutoStoryMode()
    ? [
      "T\u1ea1o m\u1edbi ho\u1eb7c m\u1edf d\u1ef1 \u00e1n c\u0169",
      "C\u1ea5u h\u00ecnh True Crime Auto Story",
      "Ch\u1ecdn gi\u1ecdng narrator",
      "Video ngu\u1ed3n v\u00e0 transcript t\u00f9y ch\u1ecdn",
      "Vertex t\u1ef1 hi\u1ec3u video, kh\u00f3a story v\u00e0 d\u1ef1ng draft",
      "Ki\u1ec3m tra & b\u1eaft \u0111\u1ea7u"
    ]
    : isManualGeminiProMode()
    ? [
      "Tạo mới hoặc mở dự án cũ",
      "Chọn luồng Gemini Pro thủ công",
      "Cấu hình giọng để tạo voice budget",
      "Video nguồn → ba kịch bản Highlight trực tiếp",
      "Render draft → Gemini review → Revision V2",
      "Kiểm tra & bắt đầu"
    ]
    : isStoryRecutMode()
    ? [
      "Tạo mới hoặc mở dự án cũ",
      "Chọn chế độ Story Recut",
      "Giữ nguyên toàn bộ âm thanh nguồn",
      "Khóa scene evidence rồi nhập story-recut.json",
      "Kiểm tra continuity và mạch truyện",
      "Kiểm tra & bắt đầu"
    ]
    : isPodcastViralMode()
    ? [
      "Tạo mới hoặc mở dự án cũ",
      "Chọn Podcast Viral Cut và số video",
      "Không dùng voice AI",
      "Video local, URL YouTube, transcript và EDL JSON",
      "Gemini chọn ID, tool khóa timeline thật",
      "Kiểm tra & bắt đầu"
    ]
    : [
      "Tạo mới hoặc mở dự án cũ",
      "Recap hoặc Dubbing",
      "Video, phụ đề, đầu ra",
      "Thiết kế / Clone / Giọng mẫu",
      "Nhận diện lời thoại và dịch ngữ cảnh",
      "Kiểm tra & bắt đầu"
    ];
  el.setupSubtitle.textContent = subtitles[state.currentStep - 1];
  updateReview();
}

function syncModeUi() {
  const isRecap = isRecapMode();
  const isScriptRewrite = isScriptRewriteMode();
  const isSatisfyingStorytime = isSatisfyingStorytimeMode();
  const isHighlightCut = isHighlightCutMode();
  const isManualGeminiPro = isManualGeminiProMode();
  const isStoryRecut = isStoryRecutMode();
  const isDiyStoryRemix = isDiyStoryRemixMode();
  const isPodcastViral = isPodcastViralMode();
  const isAutoStory = isAutoStoryMode();
  const isPodcastTwoPass = isPodcastViral && isPodcastTwoPassMode();
  if (isPodcastViral) {
    if (el.sourceLanguage) el.sourceLanguage.value = "en";
    if (el.targetLanguage) el.targetLanguage.value = "en";
  }
  const isManualWorkflow = isManualGeminiWorkflowMode();
  const isJsonPlan = isJsonPlanMode();
  document.querySelectorAll(".recap-only").forEach((node) => {
    node.classList.toggle("hidden", !isRecap);
  });
  document.querySelectorAll(".dubbing-only").forEach((node) => {
    node.classList.toggle("hidden", isRecap);
  });
  document.querySelectorAll(".satisfying-only").forEach((node) => {
    node.classList.toggle("hidden", !isJsonPlan);
  });
  if (isAutoStory) {
    if (el.sourceLanguage) el.sourceLanguage.value = "en";
    if (el.targetLanguage) el.targetLanguage.value = "en";
  }
  document.querySelectorAll(".language-step-card").forEach((node) => {
    node.classList.toggle("hidden", isAutoStory || isHighlightCut || (isManualWorkflow && !isDiyStoryRemix && !isPodcastViral));
  });
  el.sourceLanguage?.closest(".source-language-card")?.classList.toggle("hidden", isPodcastViral);
  el.targetLanguage?.closest(".target-language-card")?.classList.toggle("hidden", isPodcastViral);
  document.querySelectorAll(".highlight-only").forEach((node) => {
    node.classList.toggle("hidden", !isHighlightCut);
  });
  document.querySelectorAll(".manual-gemini-only").forEach((node) => {
    node.classList.toggle("hidden", !isManualWorkflow);
  });
  document.querySelectorAll(".manual-draft-review-only").forEach((node) => {
    node.classList.toggle("hidden", !isManualGeminiPro);
  });
  if (el.runManualAntigravityStage1) {
    el.runManualAntigravityStage1.disabled = !isManualGeminiPro || !el.manualGeminiPackPath?.value || state.busy;
  }
  syncConfiguredAiWorkflowUi();
  document.querySelectorAll(".story-recut-only").forEach((node) => {
    node.classList.toggle("hidden", !isStoryRecut);
  });
  document.querySelectorAll(".diy-remix-only").forEach((node) => {
    node.classList.toggle("hidden", !isDiyStoryRemix);
  });
  document.querySelectorAll(".podcast-only").forEach((node) => {
    node.classList.toggle("hidden", !isPodcastViral);
  });
  document.querySelectorAll(".auto-story-only").forEach((node) => {
    node.classList.toggle("hidden", !isAutoStory);
  });
  if (el.startIngest) {
    el.startIngest.textContent = isAutoStory
      ? "Phân tích, tạo timeline và render draft"
      : "Tiếp tục chỉnh sửa (phân tích cục bộ)";
  }
  document.querySelectorAll(".story-recut-hide").forEach((node) => {
    node.classList.toggle("hidden", isStoryRecut || isPodcastViral);
  });
  document.querySelectorAll(".legacy-manual-gemini-stage").forEach((node) => {
    if (isManualGeminiPro || isPodcastViral) node.classList.add("hidden");
    else if (!node.classList.contains("story-recut-hide")) node.classList.remove("hidden");
  });
  if (el.manualGeminiEvidenceStage) {
    el.manualGeminiEvidenceStage.classList.toggle("hidden", !isPodcastTwoPass && (isManualGeminiPro || isPodcastViral));
  }
  if (el.manualPackStageTitle) {
    el.manualPackStageTitle.textContent = isDiyStoryRemix
      ? "Tạo Visual Process Map"
      : isStoryRecut
      ? "Tạo gói khóa bằng chứng Story Recut"
      : isPodcastViral
      ? isPodcastTwoPass
        ? "Lượt 1 - Tìm cảnh Podcast viral"
        : "Tạo gói Podcast Viral Cut một lượt"
      : "Tạo gói viết Highlight trực tiếp";
  }
  if (el.manualPackStageDescription) {
    el.manualPackStageDescription.textContent = isDiyStoryRemix
      ? "Gemini xem toàn bộ proxy, khóa trạng thái trước/sau, thao tác và dependency vật lý trước khi được viết story."
      : isPodcastViral
      ? isPodcastTwoPass
        ? "Gemini chỉ tìm các khoảnh khắc mạnh. Tool sẽ kiểm tra timestamp, cắt Candidate Reel và đo lại lời thoại trước khi Gemini dựng EDL ở lượt 2."
        : "Tool khóa transcript thành dialogueUnitId/cutOptionId; Gemini xem URL YouTube đầy đủ và chỉ chọn ID, không được tự viết timestamp."
      : "Proxy chỉ phục vụ phân tích, có nhãn sceneId và timestamp nguồn. Video xuất cuối không có các nhãn này.";
  }
  if (el.manualEvidenceStageTitle) {
    el.manualEvidenceStageTitle.textContent = isDiyStoryRemix
      ? "Visual Process Map Quality Gate"
      : isPodcastTwoPass
      ? "Lượt 2 - Candidate Reel & Viral Assembly"
      : "Evidence Quality Gate";
  }
  if (el.manualEvidenceStageDescription) {
    el.manualEvidenceStageDescription.textContent = isDiyStoryRemix
      ? "Tool kiểm tra đủ trạng thái trước/sau, thao tác nhìn thấy, Hook, payoff và dependency vật lý. Process Map yếu sẽ được trả về Gemini để bổ sung."
      : isPodcastTwoPass
      ? "Nhập Candidate Map từ lượt 1. Tool tự cắt reel, chạy faster-whisper và tạo gói tối đa 10 file để Gemini chỉ tập trung dựng nhịp viral."
      : "Tool kiểm tra timestamp, hook, complete beat, source run và đủ mạch truyện. Nếu fail, tool tạo prompt bổ sung evidence riêng.";
  }
  if (el.importManualGeminiEvidence) {
    el.importManualGeminiEvidence.textContent = isPodcastTwoPass ? "Nhập Candidate Map" : "Nhập scene evidence";
  }
  if (el.manualBlueprintStageTitle) el.manualBlueprintStageTitle.textContent = isDiyStoryRemix ? "Khóa DIY Story Blueprint" : "Khóa Story Blueprint chung";
  if (el.importManualGeminiBlueprint) el.importManualGeminiBlueprint.textContent = isDiyStoryRemix ? "Nhập DIY Story Blueprint" : "Nhập story blueprint";
  if (el.manualBlueprintStageDescription) {
    el.manualBlueprintStageDescription.textContent = isDiyStoryRemix
      ? "Gemini chọn Hook flash-forward và gom thao tác thành macro-block, nhưng phần thân vẫn phải giữ đúng thứ tự vật lý."
      : "Gemini chỉ lập xương sống câu chuyện từ evidence đã khóa, chưa dựng timeline variant.";
  }
  if (el.manualVariantStageTitle) el.manualVariantStageTitle.textContent = isDiyStoryRemix ? "Tạo Voice-Locked Script" : "Tạo từng variant độc lập";
  const requestedIndependentCount = getRequestedIndependentScriptIds().length;
  if (el.manualVariantStageDescription) {
    el.manualVariantStageDescription.textContent = isDiyStoryRemix
      ? "Gemini viết một kịch bản liền mạch theo voice budget đã đo; tool dùng chính audio TTS thật để fit từng thao tác khi render nháp."
      : `Tool tạo đúng ${requestedIndependentCount} prompt độc lập. User có thể nhập một phần hoặc toàn bộ JSON ở khung bên dưới.`;
  }
  if (el.manualVariantStageBadge) el.manualVariantStageBadge.textContent = isDiyStoryRemix ? "1 script khóa voice" : `${requestedIndependentCount} prompt riêng`;
  if (el.storyJsonLabel) {
    el.storyJsonLabel.textContent = isDiyStoryRemix
      ? "GIAI ĐOẠN 4 - DIY Story Remix JSON từ Gemini"
      : isStoryRecut
      ? "GIAI ĐOẠN 3 - Story Recut JSON từ Gemini"
      : isManualGeminiPro
      ? `LƯỢT 1 - JSON Highlight Gemini trả về (đã yêu cầu ${requestedIndependentCount})`
      : isPodcastViral
      ? "Podcast EDL JSON từ Gemini (1-5 file)"
      : isHighlightCut
      ? "Highlight Cut JSON từ Gemini"
      : "Kịch bản Storytime JSON từ Gemini";
  }
  if (el.storyJsonHint) {
    el.storyJsonHint.textContent = isDiyStoryRemix
      ? "Chọn đúng một file diy-story-remix.json. Tool kiểm tra visualBeatId, sceneId, timestamp nguồn rồi mới cho dựng voice và video."
      : isStoryRecut
      ? "Chọn file story-recut.json từ prompt lượt 2. Tool sẽ khóa lại evidenceId, sceneId, sourceRunId và kiểm tra mạch kể trước khi dựng."
      : isManualGeminiPro
      ? `Chọn từ 1 đến ${requestedIndependentCount} JSON trong số các kịch bản đã yêu cầu. Sau khi render draft, tool sẽ tạo gói Lượt 2 để AI review video thật.`
      : isPodcastViral
      ? "Chọn từ 1 đến 5 file podcast-cut-XX.json. Tool kiểm tra accessAudit rồi resolve dialogueUnitId/cutOptionId thành timestamp local."
      : isHighlightCut
      ? "JSON gồm title, total_target_sec và segments có sourceStartSec/sourceEndSec, startSec/endSec, playbackSpeed, audio_mode, voiceover_text, preview_vi."
      : "Gemini cần xuất JSON gồm title, language, style và segments có startSec, endSec, text. Ngôn ngữ thuyết minh lấy theo lựa chọn bên dưới.";
  }
  if (el.targetLanguage) {
    el.targetLanguage.disabled = isScriptRewrite || isHighlightCut || (isManualWorkflow && !isDiyStoryRemix);
    el.targetLanguage.title = isScriptRewrite
      ? "Chế độ viết lại giữ nguyên ngôn ngữ gốc của video."
      : isHighlightCut
      ? "Chế độ Highlight Cut lấy voice và preview_vi từ file JSON Gemini."
      : isManualGeminiPro
      ? "Gemini Draft Review lấy ngôn ngữ trực tiếp từ JSON Highlight."
      : isDiyStoryRemix
      ? "DIY Story Remix dùng ngôn ngữ này cho voiceover_text; mặc định là tiếng Anh."
      : isStoryRecut
      ? "Story Recut lấy ngôn ngữ trực tiếp từ JSON."
      : "";
  }
  syncManualGeminiPromptOptionsUi({ rerenderPrompt: false });
  syncModeSelectionUi();
}

function updateReview() {
  if (!el.reviewProject) {
    return;
  }
  const isRecap = isRecapMode();
  syncModeUi();
  el.reviewProject.textContent = el.projectTitle.value.trim() || "project_default";
  el.reviewMode.textContent = isRecap ? "Tóm tắt phim (AI)" : isAutoStoryMode() ? "True Crime Auto Story" : isScriptRewriteMode() ? "Viết lại kịch bản" : isSatisfyingStorytimeMode() ? "Oddly Satisfying Storytime" : isHighlightCutMode() ? "Highlight Cut JSON" : isManualGeminiProMode() ? "Gemini Draft Review - 2 lượt" : isStoryRecutMode() ? "Story Recut" : isDiyStoryRemixMode() ? "DIY Story Remix" : isPodcastViralMode() ? "Podcast Viral Cut" : "Thuyết minh & dịch";
  el.reviewVideo.textContent = fileName(el.sourceVideoPath.value) || "(chưa chọn)";
  el.reviewSrt.textContent = isJsonPlanMode()
    ? (fileName(el.storyScriptPath?.value) || "(chưa chọn JSON)")
    : (fileName(el.subtitlePath.value) || "(không có)");
  el.reviewFrame.textContent = "Giữ tỷ lệ gốc";
  el.reviewWhisper.textContent = el.subtitlePath.value ? "Dùng file SRT" : (el.autoWhisper.checked ? "Tự động nhận diện" : "Dự phòng theo cảnh");
  el.reviewTarget.textContent = isScriptRewriteMode()
    ? "Giữ nguyên ngôn ngữ gốc"
    : (isHighlightCutMode() || isManualGeminiWorkflowMode()) && !isDiyStoryRemixMode()
    ? "Theo JSON Gemini"
    : (el.targetLanguage.options[el.targetLanguage.selectedIndex]?.textContent || el.targetLanguage.value);
  el.reviewAiProvider.textContent = isAutoStoryMode() ? "Vertex AI" : getAiProviderLabel();
  if (el.reviewPromptProfile) el.reviewPromptProfile.textContent = getManualPromptProfileLabel();
  if (el.reviewAutoStory) {
    const min = Math.max(65, Number(el.autoStoryTargetMin?.value || 65));
    const max = Math.max(min, Number(el.autoStoryTargetMax?.value || 90));
    const engineLabel = Number(el.autoStoryEngineVersion?.value) === 3 ? "V3 Story Model" : "V2 Legacy";
    el.reviewAutoStory.textContent = `${engineLabel} · ${Number(el.autoStoryOutputCount?.value || 2)} video · ${min}-${max}s · ${el.autoStoryNarrationStyle?.options[el.autoStoryNarrationStyle.selectedIndex]?.textContent || "Điều tra"}`;
  }
  if (isRecap) {
    el.reviewDuration.textContent = `${Number(el.recapTargetDuration?.value || el.targetDuration?.value || 60)}s (${el.recapWorkflowMode?.value === "review" ? "Review Before Final" : "Full Auto"})`;
    el.reviewVoiceSpeed.textContent = `Lead: ${el.recapVisualLead?.value || "0.25"}s · ${el.recapAllowReuse?.checked ? "Cho phép lặp" : "Không lặp cảnh"}`;
  }
  el.translateButton.textContent = `Dịch ngữ cảnh với ${getAiProviderLabel()}`;
  renderHighlightPromptTemplate();
  syncHeroVoiceCard();
}

function syncLocalTranslationSettings() {
  const useHyMt2 = el.localTranslationProvider?.value === "hy_mt2_ollama";
  [el.localTranslationModelRow, el.localTranslationPythonRow, el.localTranslationDeviceRow]
    .forEach((node) => node?.classList.toggle("hidden", useHyMt2));
  el.hyMt2ModelRow?.classList.toggle("hidden", !useHyMt2);
  el.downloadHyMt2?.classList.toggle("hidden", !useHyMt2);
}

function setSettingsTab(tabName = "ai") {
  document.querySelectorAll("[data-settings-tab]").forEach((button) => {
    const isActive = button.dataset.settingsTab === tabName;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.settingsPanel !== tabName);
  });
}

function syncAiProviderSettingsUi() {
  const provider = el.aiProvider?.value || "gemini";
  document.querySelectorAll("[data-ai-provider-settings]").forEach((section) => {
    section.classList.toggle("hidden", section.dataset.aiProviderSettings !== provider);
  });
  const hint = $("ai-provider-settings-hint");
  if (hint) {
    const descriptions = {
      gemini: "Gemini API được dùng cho review, viết lại và các tác vụ AI tự động.",
      vertex_ai: "Vertex AI dùng credit Google Cloud, tự chọn model theo tác vụ và áp hard limit chi phí.",
      antigravity_cli: "Antigravity CLI trên máy được dùng cho review, viết lại và phân tích cảnh.",
      ollama_local: "Ollama chạy hoàn toàn cục bộ; model Vision Assist được chọn bên dưới.",
      local: "Chế độ dự phòng chỉ dùng các phép kiểm tra cục bộ, không gọi model bên ngoài."
    };
    hint.textContent = descriptions[provider] || descriptions.gemini;
  }
  syncConfiguredAiWorkflowUi();
}

function closeSettingsModal({ restore = true } = {}) {
  if (restore && state.settings) {
    fillSettings(state.settings);
  }
  el.settingsModal.classList.add("hidden");
}

function fillSettings(settings) {
  el.workspaceRoot.value = settings.workspaceRoot || "";
  if (el.exportRoot) el.exportRoot.value = settings.exportRoot || "";
  if (el.geminiAnalysisRoot) el.geminiAnalysisRoot.value = settings.geminiAnalysisRoot || "";
  if (!el.manualGeminiPackPath?.value && el.manualGeminiPackStatus && settings.geminiAnalysisRoot) {
    el.manualGeminiPackStatus.textContent = `Chưa tạo gói. Tool sẽ tự lưu tại: ${settings.geminiAnalysisRoot}`;
  }
  if (el.exportLayout) el.exportLayout.value = settings.exportLayout || "flat";
  el.geminiApiKey.value = settings.geminiApiKey || "";
  el.geminiModel.value = settings.geminiModel || "gemini-2.5-pro";
  el.vertexProjectId.value = settings.vertexProjectId || "";
  el.vertexLocation.value = settings.vertexLocation || "global";
  el.vertexCredentialPath.value = settings.vertexCredentialPath || "";
  el.vertexGcloudCommand.value = settings.vertexGcloudCommand || "gcloud";
  el.vertexBucket.value = settings.vertexBucket || "";
  el.vertexEconomyModel.value = settings.vertexEconomyModel || "gemini-2.5-flash-lite";
  el.vertexAnalysisModel.value = settings.vertexAnalysisModel || "gemini-2.5-flash";
  el.vertexQualityModel.value = settings.vertexQualityModel || "gemini-2.5-pro";
  for (const name of ["Plan", "Edit", "Review", "Repair", "Final"]) {
    const node = $("vertex-auto-story-" + name.toLowerCase() + "-model");
    if (node) node.value = settings["vertexAutoStory" + name + "Model"] || "";
  }
  const maxCallsNode = $("vertex-auto-story-max-calls");
  if (maxCallsNode) maxCallsNode.value = settings.vertexAutoStoryMaxCalls || 16;
  el.vertexBudgetUsd.value = settings.vertexBudgetUsd ?? 240;
  el.vertexDailyLimitUsd.value = settings.vertexDailyLimitUsd ?? 5;
  el.vertexTimeoutMs.value = settings.vertexTimeoutMs || 900000;
  el.antigravityCommand.value = settings.antigravityCommand || "agy";
  el.antigravityArgs.value = settings.antigravityArgs || "";
  el.antigravityModel.value = settings.antigravityModel || "";
  el.antigravityTimeoutMs.value = settings.antigravityTimeoutMs || 300000;
  el.whisperEngine.value = settings.whisperEngine || "auto";
  el.whisperCommand.value = settings.whisperCommand || "whisper";
  el.whisperPythonCommand.value = settings.whisperPythonCommand || "py";
  el.whisperModel.value = settings.whisperModel || "auto";
  el.whisperDevice.value = settings.whisperDevice || "auto";
  el.whisperComputeType.value = settings.whisperComputeType || "auto";
  el.whisperChunkSec.value = settings.whisperChunkSec || 240;
  el.dubbingRenderMode.value = settings.dubbingRenderMode || "speech_first_clustered";
  el.dubbingMinClusterDuration.value = settings.dubbingMinClusterDuration || 5;
  el.dubbingMaxClusterDuration.value = settings.dubbingMaxClusterDuration || 12;
  el.dubbingMaxSafeStretch.value = settings.dubbingMaxSafeStretch || 0.08;
  el.dubbingAllowStrictTrim.checked = Boolean(settings.dubbingAllowStrictTrim);
  el.dubbingVoiceNormalize.checked = settings.dubbingVoiceNormalize !== false;
  el.defaultVoiceProvider.value = settings.defaultVoiceProvider || "edge_neural";
  el.elevenLabsApiKey.value = settings.elevenLabsApiKey || "";
  el.elevenLabsModel.value = settings.elevenLabsModel || "eleven_multilingual_v2";
  el.elevenLabsVoiceId.value = settings.defaultVoiceId || "";
  el.elevenLabsSettingsMode.value = settings.elevenLabsVoiceSettingsMode || "auto";
  el.elevenLabsStability.value = String(settings.elevenLabsStability ?? 0.32);
  el.elevenLabsSimilarity.value = String(settings.elevenLabsSimilarityBoost ?? 0.78);
  el.elevenLabsStyle.value = String(settings.elevenLabsStyle ?? 0.58);
  el.elevenLabsSpeakerBoost.checked = settings.elevenLabsSpeakerBoost !== false;
  syncElevenLabsSliderLabels();
  el.edgeVoicePreset.value = settings.edgeVoicePreset || "natural";
  el.edgeVoiceRate.value = String(settings.edgeVoiceRate ?? 0);
  el.edgeVoicePitch.value = String(settings.edgeVoicePitchHz ?? 0);
  el.edgeVoiceVolume.value = String(settings.edgeVoiceVolume ?? 100);
  el.kokoroPythonCommand.value = settings.kokoroPythonCommand || "python";
  el.kokoroModel.value = settings.kokoroModel || "hexgrad/Kokoro-82M";
  el.kokoroDevice.value = settings.kokoroDevice || "";
  el.kokoroVoicePreset.value = settings.kokoroVoicePreset || "natural";
  el.kokoroSpeed.value = String(settings.kokoroSpeed || 1);
  el.localPreviewTranslationEnabled.checked = settings.localPreviewTranslationEnabled !== false;
  el.localTranslationProvider.value = settings.localTranslationProvider || "opus_mt";
  el.localTranslationModel.value = settings.localTranslationModel || "Helsinki-NLP/opus-mt-en-vi";
  el.localTranslationPythonCommand.value = settings.localTranslationPythonCommand || "python";
  el.localTranslationDevice.value = settings.localTranslationDevice || "";
  el.hyMt2Model.value = settings.hyMt2Model || "hf.co/unsloth/Hy-MT2-7B-GGUF:UD-Q4_K_XL";
  syncLocalTranslationSettings();
  syncLocalVoiceTuningLabels();
  el.ffmpegPath.value = settings.ffmpegPath || "ffmpeg";
  el.ffprobePath.value = settings.ffprobePath || "ffprobe";
  el.aiProvider.value = settings.aiProvider || "gemini";
  el.ollamaVisionAssist.checked = Boolean(settings.ollamaVisionAssist);
  el.ollamaVisionModel.value = settings.ollamaVisionModel || "gemma4";
  syncAiProviderSettingsUi();
  applyVoiceSetupState(settings.lastVoiceSetup || {});
}

function readSettings() {
  return {
    ...state.settings,
    workspaceRoot: el.workspaceRoot.value.trim() || state.settings?.workspaceRoot,
    exportRoot: el.exportRoot?.value.trim() || state.settings?.exportRoot,
    geminiAnalysisRoot: el.geminiAnalysisRoot?.value.trim() || state.settings?.geminiAnalysisRoot,
    exportLayout: el.exportLayout?.value || "flat",
    geminiApiKey: el.geminiApiKey.value.trim(),
    geminiModel: el.geminiModel.value.trim() || "gemini-2.5-pro",
    vertexProjectId: el.vertexProjectId.value.trim(),
    vertexLocation: el.vertexLocation.value.trim() || "global",
    vertexCredentialPath: el.vertexCredentialPath.value.trim(),
    vertexGcloudCommand: el.vertexGcloudCommand.value.trim() || "gcloud",
    vertexBucket: el.vertexBucket.value.trim(),
    vertexEconomyModel: el.vertexEconomyModel.value.trim() || "gemini-2.5-flash-lite",
    vertexAnalysisModel: el.vertexAnalysisModel.value.trim() || "gemini-2.5-flash",
    vertexQualityModel: el.vertexQualityModel.value.trim() || "gemini-2.5-pro",
    ...Object.fromEntries(["Plan", "Edit", "Review", "Repair", "Final"].map(name => ["vertexAutoStory" + name + "Model", $("vertex-auto-story-" + name.toLowerCase() + "-model").value.trim()])),
    vertexAutoStoryMaxCalls: Math.max(1, Math.min(100, Number($("vertex-auto-story-max-calls").value) || 16)),
    vertexBudgetUsd: Number(el.vertexBudgetUsd.value || 0),
    vertexDailyLimitUsd: Number(el.vertexDailyLimitUsd.value || 0),
    vertexTimeoutMs: Number(el.vertexTimeoutMs.value || 900000),
    aiProvider: el.aiProvider.value || "gemini",
    ollamaVisionAssist: Boolean(el.ollamaVisionAssist.checked),
    ollamaVisionModel: el.ollamaVisionModel.value || "gemma4",
    antigravityCommand: el.antigravityCommand.value.trim() || "agy",
    antigravityArgs: el.antigravityArgs.value.trim(),
    antigravityModel: el.antigravityModel.value.trim(),
    antigravityTimeoutMs: Number(el.antigravityTimeoutMs.value || 300000),
    whisperEngine: el.whisperEngine.value || "auto",
    whisperCommand: el.whisperCommand.value.trim() || "whisper",
    whisperPythonCommand: el.whisperPythonCommand.value.trim() || "py",
    whisperModel: el.whisperModel.value || "auto",
    whisperDevice: el.whisperDevice.value || "auto",
    whisperComputeType: el.whisperComputeType.value || "auto",
    whisperChunkSec: Number(el.whisperChunkSec.value || 240),
    dubbingRenderMode: el.dubbingRenderMode.value || "speech_first_clustered",
    dubbingMinClusterDuration: Number(el.dubbingMinClusterDuration.value || 5),
    dubbingMaxClusterDuration: Number(el.dubbingMaxClusterDuration.value || 12),
    dubbingMaxSafeStretch: Number(el.dubbingMaxSafeStretch.value || 0.08),
    dubbingAllowStrictTrim: Boolean(el.dubbingAllowStrictTrim.checked),
    dubbingVoiceNormalize: Boolean(el.dubbingVoiceNormalize.checked),
    defaultVoiceProvider: el.defaultVoiceProvider.value || "edge_neural",
    elevenLabsApiKey: el.elevenLabsApiKey.value.trim(),
    elevenLabsModel: el.elevenLabsModel.value.trim() || "eleven_multilingual_v2",
    elevenLabsVoiceSettingsMode: el.elevenLabsSettingsMode.value || "auto",
    elevenLabsStability: Number(el.elevenLabsStability.value || 0.32),
    elevenLabsSimilarityBoost: Number(el.elevenLabsSimilarity.value || 0.78),
    elevenLabsStyle: Number(el.elevenLabsStyle.value || 0.58),
    elevenLabsSpeakerBoost: Boolean(el.elevenLabsSpeakerBoost.checked),
    edgeVoicePreset: el.edgeVoicePreset.value || "custom",
    edgeVoiceRate: Number(el.edgeVoiceRate.value || 0),
    edgeVoicePitchHz: Number(el.edgeVoicePitch.value || 0),
    edgeVoiceVolume: Number(el.edgeVoiceVolume.value || 100),
    kokoroPythonCommand: el.kokoroPythonCommand.value.trim() || "python",
    kokoroModel: el.kokoroModel.value.trim() || "hexgrad/Kokoro-82M",
    kokoroDevice: el.kokoroDevice.value || "",
    kokoroVoicePreset: el.kokoroVoicePreset.value || "custom",
    kokoroSpeed: Number(el.kokoroSpeed.value || 1),
    localPreviewTranslationEnabled: Boolean(el.localPreviewTranslationEnabled.checked),
    localTranslationProvider: el.localTranslationProvider.value || "opus_mt",
    localTranslationModel: el.localTranslationModel.value.trim() || "Helsinki-NLP/opus-mt-en-vi",
    localTranslationPythonCommand: el.localTranslationPythonCommand.value.trim() || "python",
    localTranslationDevice: el.localTranslationDevice.value || "",
    hyMt2Model: el.hyMt2Model.value.trim() || "hf.co/unsloth/Hy-MT2-7B-GGUF:UD-Q4_K_XL",
    defaultVoiceId: el.elevenLabsVoiceId.value.trim(),
    lastVoiceSetup: getVoiceSetupState(),
    ffmpegPath: el.ffmpegPath.value.trim() || "ffmpeg",
    ffprobePath: el.ffprobePath.value.trim() || "ffprobe"
  };
}

function renderProjectPicker() {
  el.projectPicker.innerHTML = state.projects.length
    ? state.projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.title || project.id)}</option>`).join("")
    : `<option value="">-- Chưa có dự án --</option>`;
}

function updateAutoStoryEngineHint() {
  if (!el.autoStoryEngineHint) return;
  const v3 = Number(el.autoStoryEngineVersion?.value) === 3;
  el.autoStoryEngineHint.textContent = v3
    ? "V3: hiểu toàn bộ nguồn một lần (Source Story Model), thiết kế story beats, kiểm tra narrator (grounding/spoiler) và duck âm gốc thay vì tắt. Nên đặt số kịch bản = 1 khi test lần đầu."
    : "V2: pipeline production hiện tại (ổn định). Chọn V3 để dùng story-model mới.";
}

function readProjectPayload() {
  const setupMode = state.selectedMode;
  const selectedMode = setupMode === "script_rewrite"
    ? "dubbing"
    : isAutoStoryMode(setupMode)
    ? "highlight_cut"
    : isManualGeminiWorkflowMode(setupMode)
    ? "highlight_cut"
    : setupMode;
  const isRecap = isRecapMode(selectedMode);
  const isScriptRewrite = isScriptRewriteMode(selectedMode);
  const isSatisfyingStorytime = isSatisfyingStorytimeMode(selectedMode);
  const isHighlightCut = isHighlightCutMode(selectedMode);
  const sourceLanguage = el.sourceLanguage.value || "auto";
  const targetLanguage = isScriptRewrite || (isHighlightCut && !isDiyStoryRemixMode(setupMode))
    ? sourceLanguage
    : el.targetLanguage.value;
  const selectedVoice = getSelectedVoiceConfig();
  const storyScriptPaths = JSON.parse(el.storyScriptPath?.dataset.paths || "[]");
  const prompt = [
    el.voiceGenderAge.value,
    `${el.voicePitch.value} pitch`,
    el.voiceTrait.value
  ].filter(Boolean).join(", ");

  return {
    title: el.projectTitle.value.trim() || "project_default",
    sourceVideoPath: el.sourceVideoPath.value.trim(),
    mode: selectedMode,
    analysisWorkflow: isDiyStoryRemixMode(setupMode)
      ? "manual_gemini_diy_story_remix"
      : isStoryRecutMode(setupMode)
      ? "manual_gemini_story_recut"
      : isPodcastViralMode(setupMode)
      ? "manual_gemini_podcast_cut"
      : isManualGeminiProMode(setupMode)
      ? "manual_gemini_draft_review"
      : isAutoStoryMode(setupMode)
      ? "vertex_auto_story"
      : "",
    autoStoryConfig: isAutoStoryMode(setupMode)
      ? {
        targetDurationMinSec: Math.max(65, Number(el.autoStoryTargetMin?.value || 65)),
        targetDurationMaxSec: Math.max(
          Math.max(65, Number(el.autoStoryTargetMin?.value || 65)),
          Number(el.autoStoryTargetMax?.value || 90)
        ),
        outputCount: Math.max(1, Math.min(5, Number(el.autoStoryOutputCount?.value || 2))),
        narrationStyle: el.autoStoryNarrationStyle?.value || "investigative",
        audioBalance: el.autoStoryAudioBalance?.value || "balanced",
        voiceProvider: selectedVoice.voiceProvider,
        voiceId: selectedVoice.voiceId,
        measuredWordsPerSecond: Number(
          state.draftVoiceCalibration?.profile?.conservativeWordsPerSecond
          || state.draftVoiceCalibration?.profile?.wordsPerSecond
          || state.finalVoiceCalibration?.profile?.conservativeWordsPerSecond
          || state.finalVoiceCalibration?.profile?.wordsPerSecond
          || 0
        )
      }
      : null,
    // AutoStory engine version at PROJECT ROOT (the live service checks project.autoStoryContractVersion).
    // Only set for an explicit V3 selection; V2/legacy leaves it undefined → existing behavior preserved.
    autoStoryContractVersion: isAutoStoryMode(setupMode) && Number(el.autoStoryEngineVersion?.value) === 3 ? 3 : undefined,
    manualGeminiPackPath: isManualGeminiWorkflowMode(setupMode) ? (el.manualGeminiPackPath?.value || "") : "",
    manualGeminiPromptOptions: isManualGeminiProMode(setupMode)
      ? readManualGeminiPromptOptions()
      : isDiyStoryRemixMode(setupMode)
      ? { profile: "diy_story_remix", storyAngle: el.diyStoryAngle?.value || "gemini_auto_story" }
      : isPodcastViralMode(setupMode)
      ? {
        profile: "podcast_viral_cut",
        workflowMode: el.podcastWorkflowMode?.value || "quality_two_pass",
        outputCount: Number(el.podcastOutputCount?.value || 3),
        cleanupMode: el.podcastCleanupMode?.value || "balanced",
        targetMinSec: Number(el.podcastTargetMin?.value || 45),
        targetMaxSec: Number(el.podcastTargetMax?.value || 60),
        youtubeUrl: el.podcastYoutubeUrl?.value.trim() || ""
      }
      : null,
    subtitleSourcePath: el.subtitlePath.value.trim(),
    storyScriptPath: storyScriptPaths[0] || el.storyScriptPath?.value.trim() || "",
    storyScriptPaths,
    autoWhisper: el.autoWhisper.checked,
    sourceLanguage,
    targetLanguage,
    narrationLanguage: targetLanguage,
    framePreset: "original",
    visualRemixEnabled: el.visualRemix.checked,
    ollamaVisionAssist: Boolean(el.ollamaVisionAssist.checked),
    ollamaVisionModel: el.ollamaVisionModel?.value || "gemma4",
    targetDuration: isRecap ? Number(el.recapTargetDuration?.value || el.targetDuration?.value || 60) : null,
    targetDurationSec: isRecap ? Number(el.recapTargetDuration?.value || el.targetDuration?.value || 60) : 60,
    recapWorkflow: el.recapWorkflowMode?.value || "full_auto",
    allowShotReuse: Boolean(el.recapAllowReuse?.checked),
    visualLeadSec: Number(el.recapVisualLead?.value || 0.25),
    voiceSpeed: isRecap ? Number(el.voiceSpeed?.value || 1) : 1,
    viralOptimization: isRecap ? Boolean(el.viralOptimization?.checked) : false,
    viralPlatform: isRecap ? el.viralPlatform?.value : "tiktok",
    viralAngleSetting: isRecap ? el.viralAngleSetting?.value : "auto",
    retentionAggressiveness: isRecap ? el.retentionAggressiveness?.value : "balanced",
    spoilerControl: isRecap ? el.spoilerControl?.value : "balanced",
    loopEnding: isRecap ? Boolean(el.loopEnding?.checked) : false,
    narrationEnabled: !(isStoryRecutMode(setupMode) || isPodcastViralMode(setupMode))
      && (!isAutoStoryMode(setupMode) || el.autoStoryAudioBalance?.value !== "original_only"),
    voiceProvider: selectedVoice.voiceProvider,
    voiceId: selectedVoice.voiceId,
    cloneSourceVoice: selectedVoice.cloneSourceVoice,
    voiceDesign: {
      tab: document.querySelector(".voice-tab.active")?.dataset.voiceTab || "designed",
      genderAge: el.voiceGenderAge.value,
      pitch: el.voicePitch.value,
      accent: el.voiceAccent.value,
      trait: el.voiceTrait.value,
      prompt: el.voicePrompt.value.trim() || prompt,
      samplePath: el.voiceSamplePath.value.trim(),
      presetProvider: el.presetVoiceProvider.value,
      presetVoiceId: el.presetVoiceList.value
    },
    ...getCurrentProjectSettings(),
    dubbingRenderMode: state.settings?.dubbingRenderMode || "speech_first_clustered",
    dubbingMinClusterDuration: Number(state.settings?.dubbingMinClusterDuration || 5),
    dubbingMaxClusterDuration: Number(state.settings?.dubbingMaxClusterDuration || 12),
    dubbingMaxSafeStretch: Number(state.settings?.dubbingMaxSafeStretch || 0.08),
    dubbingAllowStrictTrim: Boolean(state.settings?.dubbingAllowStrictTrim),
    dubbingVoiceNormalize: state.settings?.dubbingVoiceNormalize !== false
  };
}

function validateCurrentStep() {
  if (state.currentStep === 2 && isAutoStoryMode()) {
    const min = Number(el.autoStoryTargetMin?.value || 0);
    const max = Number(el.autoStoryTargetMax?.value || 0);
    if (!Number.isFinite(min) || min < 65) {
      showToast("True Crime Auto Story yêu cầu thời lượng tối thiểu từ 65 giây.");
      return false;
    }
    if (!Number.isFinite(max) || max < min) {
      showToast("Thời lượng tối đa phải lớn hơn hoặc bằng thời lượng tối thiểu.");
      return false;
    }
  }
  if (state.currentStep === 4 && !el.sourceVideoPath.value.trim()) {
    showToast("Hãy chọn video nguồn trước.");
    return false;
  }
  if (state.currentStep === 4 && isJsonPlanMode() && !el.storyScriptPath?.value.trim()) {
    showToast(isStoryRecutMode()
      ? "Hãy tạo gói phân tích, gửi Gemini và chọn story-recut.json trước."
      : isManualGeminiProMode()
      ? "Hãy tạo gói phân tích, gửi Gemini và chọn các JSON trả về trước."
      : isPodcastViralMode()
      ? "Hãy tạo gói Podcast, gửi URL + input cho Gemini và chọn các EDL JSON trả về."
      : isHighlightCutMode()
      ? "Hãy chọn Highlight Cut JSON từ Gemini trước."
      : "Hãy chọn kịch bản Storytime JSON từ Gemini trước.");
    return false;
  }
  if (state.currentStep === 4 && isManualGeminiProMode()) {
    if (!el.manualGeminiPackPath?.value.trim()) {
      showToast("Hãy tạo gói Lượt 1 từ đúng video nguồn trước.");
      return false;
    }
    const selectedScripts = JSON.parse(el.storyScriptPath?.dataset.paths || "[]");
    const maximumFiles = getRequestedIndependentScriptIds().length;
    if (selectedScripts.length < 1 || selectedScripts.length > maximumFiles) {
      showToast(`Hãy chọn từ 1 đến ${maximumFiles} file JSON kịch bản.`);
      return false;
    }
  }
  if (state.currentStep === 4 && isPodcastViralMode()) {
    if (!el.manualGeminiPackPath?.value.trim()) {
      showToast("Hãy tạo gói Podcast từ đúng video local và URL YouTube trước.");
      return false;
    }
    if (isPodcastTwoPassMode() && !el.manualGeminiEvidencePath?.value.trim()) {
      showToast("Hãy nhập Candidate Map và tạo gói Assembly trước khi chọn EDL cuối.");
      return false;
    }
    const selectedScripts = JSON.parse(el.storyScriptPath?.dataset.paths || "[]");
    const expectedCount = Number(el.podcastOutputCount?.value || 1);
    if (selectedScripts.length !== expectedCount) {
      showToast(`Bạn đã chọn ${expectedCount} output; hãy nhập đúng ${expectedCount} file Podcast JSON.`);
      return false;
    }
  }
  if (state.currentStep === 4 && isDiyStoryRemixMode()) {
    if (!el.manualGeminiPackPath?.value.trim() || !el.manualGeminiBlueprintPath?.value.trim()) {
      showToast("Hãy hoàn tất Visual Process Map và DIY Story Blueprint trước.");
      return false;
    }
    const selectedScripts = JSON.parse(el.storyScriptPath?.dataset.paths || "[]");
    if (selectedScripts.length !== 1) {
      showToast("DIY Story Remix chỉ nhận đúng một file diy-story-remix.json.");
      return false;
    }
  }
  return true;
}

function initStudioSplitters() {
  const studio = $("studio-view");
  if (!studio) return;

  const leftSplitter = studio.querySelector('.splitter-v[data-target="left"]');
  const rightSplitter = studio.querySelector('.splitter-v[data-target="inspector"]');
  const horizontalSplitter = studio.querySelector('.splitter-h[data-target="timeline"]');

  try {
    const savedLeft = localStorage.getItem("cineviral_col_left");
    const savedRight = localStorage.getItem("cineviral_col_inspector");
    const savedTimeline = localStorage.getItem("cineviral_row_timeline");

    if (savedLeft) studio.style.setProperty("--col-left", savedLeft);
    if (savedRight) studio.style.setProperty("--col-inspector", savedRight);
    if (savedTimeline) studio.style.setProperty("--row-timeline", savedTimeline);
  } catch (_e) {}

  function startDrag(e, type, splitterEl) {
    e.preventDefault();
    document.body.classList.add("is-dragging-splitter");
    splitterEl?.classList.add("active");
    const startX = e.clientX;
    const startY = e.clientY;
    const rect = studio.getBoundingClientRect();

    const computed = getComputedStyle(studio);
    const initialLeftWidth = parseFloat(computed.getPropertyValue("--col-left")) || 380;
    const initialRightWidth = parseFloat(computed.getPropertyValue("--col-inspector")) || 320;
    const initialTimelineHeight = parseFloat(computed.getPropertyValue("--row-timeline")) || 360;

    let resizeThrottle = null;

    function onMouseMove(moveEvent) {
      if (type === "left") {
        const deltaX = moveEvent.clientX - startX;
        const newWidth = Math.max(260, Math.min(rect.width * 0.48, initialLeftWidth + deltaX));
        studio.style.setProperty("--col-left", `${Math.round(newWidth)}px`);
      } else if (type === "inspector") {
        const deltaX = startX - moveEvent.clientX;
        const newWidth = Math.max(220, Math.min(rect.width * 0.48, initialRightWidth + deltaX));
        studio.style.setProperty("--col-inspector", `${Math.round(newWidth)}px`);
      } else if (type === "timeline") {
        const deltaY = startY - moveEvent.clientY;
        const newHeight = Math.max(160, Math.min(rect.height * 0.70, initialTimelineHeight + deltaY));
        studio.style.setProperty("--row-timeline", `${Math.round(newHeight)}px`);
      }

      if (!resizeThrottle) {
        resizeThrottle = requestAnimationFrame(() => {
          window.dispatchEvent(new Event("resize"));
          resizeThrottle = null;
        });
      }
    }

    function onMouseUp() {
      document.body.classList.remove("is-dragging-splitter");
      splitterEl?.classList.remove("active");
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);

      try {
        localStorage.setItem("cineviral_col_left", studio.style.getPropertyValue("--col-left"));
        localStorage.setItem("cineviral_col_inspector", studio.style.getPropertyValue("--col-inspector"));
        localStorage.setItem("cineviral_row_timeline", studio.style.getPropertyValue("--row-timeline"));
      } catch (_e) {}

      window.dispatchEvent(new Event("resize"));
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  if (leftSplitter && !leftSplitter.dataset.bound) {
    leftSplitter.dataset.bound = "true";
    leftSplitter.addEventListener("mousedown", (e) => startDrag(e, "left", leftSplitter));
  }
  if (rightSplitter && !rightSplitter.dataset.bound) {
    rightSplitter.dataset.bound = "true";
    rightSplitter.addEventListener("mousedown", (e) => startDrag(e, "inspector", rightSplitter));
  }
  if (horizontalSplitter && !horizontalSplitter.dataset.bound) {
    horizontalSplitter.dataset.bound = "true";
    horizontalSplitter.addEventListener("mousedown", (e) => startDrag(e, "timeline", horizontalSplitter));
  }
}

function showStudio(project) {
  state.currentProject = project;
  syncProjectSettingsControls(project);
  el.setupView.classList.add("hidden");
  el.studioView.classList.remove("hidden");
  el.backToSetup.classList.remove("hidden");
  el.renderVideo.classList.remove("hidden");
  initStudioSplitters();
  renderStudio();
  setTimeout(() => window.dispatchEvent(new Event("resize")), 60);
}

function showSetup() {
  el.setupView.classList.remove("hidden");
  el.studioView.classList.add("hidden");
  el.backToSetup.classList.add("hidden");
  el.renderVideo.classList.add("hidden");
  el.resumeRender?.classList.add("hidden");
  el.openOutputFolder?.classList.add("hidden");
  state.currentStep = Math.min(state.currentStep || 1, 6);
  renderSteps();
}

function openBackSetupModal() {
  document.querySelectorAll("[data-preserve-step]").forEach((checkbox) => {
    checkbox.checked = true;
  });
  el.backSetupModal.classList.remove("hidden");
}

function confirmBackToSetup() {
  const preserved = new Set(
    Array.from(document.querySelectorAll("[data-preserve-step]"))
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => Number(checkbox.dataset.preserveStep))
  );
  const resetSteps = Array.from({ length: 6 }, (_item, index) => index + 1)
    .filter((step) => !preserved.has(step));
  const shouldReturnToFirstStep = resetSteps.length === 6;
  const targetStep = resetSteps[0] || Math.min(6, Math.max(1, Number(state.currentStep || 6)));
  resetSteps.forEach(resetSetupStep);
  writeSetupDraft();
  el.backSetupModal.classList.add("hidden");
  state.currentStep = targetStep;
  showSetup();
  addLog(
    shouldReturnToFirstStep
      ? "Đã quay lại bước đầu tiên và làm mới toàn bộ thiết lập."
      : resetSteps.length
        ? `Đã quay lại bước ${targetStep}. Các bước không chọn đã được đặt lại.`
        : `Đã quay lại bước ${targetStep}. Toàn bộ thiết lập hiện tại được giữ nguyên.`
  );
}

function getSegments() {
  return state.currentProject?.analysis?.segments || [];
}

function getHighlightVariants(project = state.currentProject) {
  return Array.isArray(project?.analysis?.highlightVariants) ? project.analysis.highlightVariants : [];
}

function getActiveHighlightVariant(project = state.currentProject) {
  const variants = getHighlightVariants(project);
  const activeId = project?.analysis?.activeVariantId || variants[0]?.id || "";
  return variants.find((variant) => variant.id === activeId) || variants[0] || null;
}

function buildAnalysisWithActiveHighlightSegments(analysis = state.currentProject?.analysis || {}, segments = getSegments()) {
  if (state.currentProject?.mode !== "highlight_cut") {
    return { ...analysis, segments };
  }
  const activeVariantId = analysis.activeVariantId || analysis.highlightVariants?.[0]?.id || "";
  const highlightVariants = Array.isArray(analysis.highlightVariants)
    ? analysis.highlightVariants.map((variant) => variant.id === activeVariantId ? { ...variant, segments } : variant)
    : [];
  return {
    ...analysis,
    activeVariantId,
    highlightVariants,
    segments,
    scenes: segments.map((segment) => ({
      sceneId: segment.id,
      startSec: segment.startSec,
      endSec: segment.endSec,
      duration: segment.duration,
      sourceStartSec: segment.sourceStartSec,
      sourceEndSec: segment.sourceEndSec,
      transcript: segment.caption || segment.voiceoverText || segment.sceneType
    }))
  };
}

function getSegmentTimelineDuration(segment = {}) {
  const explicit = Number(segment.renderDuration || segment.duration || 0);
  if (explicit > 0) return explicit;
  return Math.max(0, Number(segment.endSec || 0) - Number(segment.startSec || 0));
}

function getSegmentTimelineStart(segment = {}, index = 0, segments = getSegments()) {
  const explicit = Number(segment.timelineStart);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  return segments.slice(0, index).reduce((sum, item) => sum + getSegmentTimelineDuration(item), 0);
}

function getSegmentTimelineEnd(segment = {}, index = 0, segments = getSegments()) {
  const explicit = Number(segment.timelineEnd);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return getSegmentTimelineStart(segment, index, segments) + getSegmentTimelineDuration(segment);
}

function normalizeReviewText(value = "") {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function safeCompareText(left = "", right = "") {
  return normalizeReviewText(left) === normalizeReviewText(right);
}

function markReviewRewriteApplied(review = {}, narrationLine = "") {
  return {
    ...review,
    previousVerdict: review.verdict || review.previousVerdict || "",
    verdict: "pass",
    summary: "Đã áp dụng câu viết lại được AI đề xuất. Hãy render nháp nhanh lại để đo voice thật cho text mới.",
    rewriteAppliedAt: new Date().toISOString(),
    rewriteAppliedText: narrationLine,
    voiceTiming: {
      ...(review.voiceTiming || {}),
      status: "stale_after_rewrite",
      warning: "Text đã thay đổi sau lần đo voice gần nhất."
    }
  };
}

function clearVoicePreflightForTextChange(segment = {}) {
  return {
    ...segment,
    fastDraftVoiceSec: 0,
    fastDraftTimelineSec: 0,
    fastDraftFitRatio: 0,
    fastDraftTextHash: "",
    fastDraftMeasuredAt: "",
    fastDraftVoiceStatus: "stale",
    fastDraftVoiceWarning: "Text đã thay đổi. Hãy render nháp nhanh lại để đo voice thật.",
    aiSceneReview: segment.aiSceneReview ? {
      ...segment.aiSceneReview,
      voiceTiming: {
        ...(segment.aiSceneReview.voiceTiming || {}),
        status: "stale_after_text_change",
        warning: "Text đã thay đổi sau lần đo voice gần nhất."
      }
    } : segment.aiSceneReview
  };
}

function getSegmentReviewStatus({ review, text, isReviewing }) {
  if (isReviewing) {
    return { className: "processing", label: "Đang đánh giá", detail: "AI đang kiểm tra cảnh này..." };
  }
  if (!review) {
    return { className: "pending", label: "Chưa đánh giá", detail: "Bấm AI đánh giá toàn bộ cảnh để kiểm tra." };
  }
  const rewriteApplied = Boolean(review.rewriteAppliedAt)
    || Boolean(review.rewriteSuggestion?.narrationLine && safeCompareText(text, review.rewriteSuggestion.narrationLine));
  if (rewriteApplied) {
    return { className: "applied", label: "Đã áp dụng", detail: "Câu viết lại đề xuất đã được lưu vào kịch bản." };
  }
  return {
    className: review.verdict || "warning",
    label: review.verdict === "pass" ? "Đạt" : review.verdict === "needs_rewrite" ? "Cần viết lại" : "Cảnh báo",
    detail: review.summary || "Đã có đánh giá AI."
  };
}

function switchRightTab(_tabName = "log") {
  // Panel bên phải giờ là Nhật ký xử lý cố định
}

function updateVariantHubProgress(payload = {}) {
  if (!el.variantHubCards) return;
  const queue = state.variantExportQueue || [];
  const processingIdx = queue.findIndex((item) => item.status === "processing" || item.status === "rendering");
  const activeIdx = typeof payload.variantBatch?.activeIndex === "number"
    ? payload.variantBatch.activeIndex
    : (processingIdx >= 0 ? processingIdx : (state.variantProgress?.activeIndex ?? 0));

  const card = el.variantHubCards.children[activeIdx];
  if (!card) return;

  const variants = getHighlightVariants();
  const total = variants.length || 1;
  const pct = Number(payload.percent || 0);
  const computed = Math.round((pct * total) - (activeIdx * 100));
  const variantPct = Math.max(0, Math.min(100, computed));

  const bar = card.querySelector(".variant-card-progress-bar");
  const pctText = card.querySelector(".progress-pct-text");
  const stepText = card.querySelector(".progress-step-text");

  if (bar) bar.style.width = `${variantPct > 0 ? variantPct : 100}%`;
  if (pctText && variantPct > 0) pctText.textContent = `${variantPct}%`;
  if (stepText && payload.message) {
    const cleanMsg = payload.message
      .replace(/^Nháp\s+\d+\/\d+\s*·\s*/i, "")
      .replace(/^Variant\s+\d+\/\d+\s*·\s*/i, "")
      .trim();
    stepText.textContent = cleanMsg;
    stepText.title = cleanMsg;
  }
}

function renderStudioVariantHub(project = state.currentProject) {
  if (!el.studioVariantHub || !el.variantHubCards) return;
  const variants = getHighlightVariants(project);
  const shouldShow = project?.mode === "highlight_cut" && variants.length > 0;
  el.studioVariantHub.classList.toggle("hidden", !shouldShow);
  if (!shouldShow) return;

  if (el.variantHubSummary) {
    el.variantHubSummary.textContent = `${variants.length} variant${variants.length > 1 ? "s" : ""}`;
  }

  const activeId = project.analysis?.activeVariantId || variants[0]?.id || "";
  const queue = state.variantExportQueue || [];
  const queueById = new Map(queue.map((item) => [item.id, item]));

  el.variantHubCards.innerHTML = variants.map((variant, index) => {
    const isActive = variant.id === activeId;
    const duration = (variant.segments || []).reduce((sum, s) => sum + getSegmentTimelineDuration(s), 0);
    const title = variant.label || variant.title || `Variant ${index + 1}`;
    const queueItem = queueById.get(variant.id) || (queue[index] && queue[index].id === variant.id ? queue[index] : null);

    const isProcessing = queueItem?.status === "processing" || queueItem?.status === "rendering";
    const isReviewing = queueItem?.status === "reviewing";
    const isWaiting = queueItem?.status === "waiting";
    const isFailed = queueItem?.status === "failed";
    const isDone = queueItem?.status === "done";

    let badgeText = "Chờ xử lý";
    let badgeClass = "badge-pending";

    if (isProcessing) {
      badgeText = "Processing";
      badgeClass = "badge-processing";
    } else if (isReviewing) {
      badgeText = "Review AI...";
      badgeClass = "badge-reviewing";
    } else if (isWaiting) {
      badgeText = "Waiting";
      badgeClass = "badge-waiting";
    } else if (isFailed) {
      badgeText = "Lỗi";
      badgeClass = "badge-failed";
    } else if (isDone || variant.artifacts?.finalVideoPath) {
      badgeText = variant.artifacts?.finalVideoPath ? "Đã xuất" : "Hoàn tất";
      badgeClass = "badge-pass";
    } else if (variant.draftReview?.verdict === "PASS" || variant.draftReviewReadiness?.grade === "A") {
      badgeText = "V2 PASS";
      badgeClass = "badge-pass";
    } else if (variant.draftReview?.verdict === "NEEDS_ATTENTION") {
      badgeText = "Cần chú ý";
      badgeClass = "badge-warning";
    } else if (variant.artifacts?.fastDraftVideoPath) {
      badgeText = "Draft sẵn sàng";
      badgeClass = "badge-pending";
    }

    let variantPct = 0;
    let progressMsg = "";
    if (isProcessing || isReviewing) {
      if (state.variantProgress) {
        const total = variants.length || 1;
        const computed = Math.round((Number(state.variantProgress.percent || 0) * total) - (index * 100));
        variantPct = Math.max(0, Math.min(100, computed));
        if (state.variantProgress.message) {
          progressMsg = state.variantProgress.message
            .replace(/^Nháp\s+\d+\/\d+\s*·\s*/i, "")
            .replace(/^Variant\s+\d+\/\d+\s*·\s*/i, "")
            .trim();
        }
      }
      if (!progressMsg) {
        progressMsg = isReviewing ? "Đang chạy Gemini Review..." : "Đang kết xuất video nháp...";
      }
    }

    const viralScore = Number(variant.viralPreflight?.score || variant.draftReviewReadiness?.score || 0);
    const scoreClass = viralScore >= 80 ? "score-high" : viralScore >= 60 ? "score-med" : "score-low";
    const scoreDisplay = viralScore > 0 ? `${viralScore}/100` : "--";
    const hasReview = Boolean(
      variant.artifacts?.draftReviewAiResultPath ||
      variant.draftReview?.sourcePath ||
      variant.draftReviewAiResultPath ||
      variant.draftReview
    );

    return `
      <div class="variant-hub-card ${isActive ? "active" : ""} ${isProcessing || isReviewing ? "is-processing" : ""}" data-highlight-variant="${escapeHtml(variant.id)}" title="${escapeHtml(title)}">
        <div class="variant-hub-card-top">
          <span class="variant-hub-card-title">#${index + 1} ${escapeHtml(title)}</span>
          <span class="variant-hub-card-badge ${badgeClass}">
            ${isProcessing || isReviewing ? '<span class="badge-spinner"></span>' : ""}
            ${escapeHtml(badgeText)}
          </span>
        </div>
        ${(isProcessing || isReviewing) ? `
          <div class="variant-hub-card-progress">
            <div class="variant-card-progress-track">
              <div class="variant-card-progress-bar" style="width: ${variantPct > 0 ? variantPct : 100}%;"></div>
            </div>
            <div class="variant-card-progress-detail">
              <span class="progress-step-text" title="${escapeHtml(progressMsg)}">${escapeHtml(progressMsg)}</span>
              ${variantPct > 0 ? `<span class="progress-pct-text">${variantPct}%</span>` : ""}
            </div>
          </div>
        ` : ""}
        <div class="variant-hub-card-bottom">
          <span>${fmt(duration, 1)}s · ${(variant.segments || []).length} cảnh</span>
          <div style="display:inline-flex;align-items:center;gap:6px;">
            ${hasReview ? `<button type="button" class="btn-review-report-pill" data-open-review-report="${escapeHtml(variant.id)}" title="Xem báo cáo AI Review và so sánh V1/V2">📊 Xem AI review</button>` : ""}
            <span class="variant-hub-card-score ${scoreClass}">Điểm: ${scoreDisplay}</span>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

function updateStudioPipelineTracker(options = {}) {
  if (!el.studioPipelineTracker) return;
  const { visible = false, label = "", percent = 0, activeStep = "" } = options;
  el.studioPipelineTracker.classList.toggle("hidden", !visible);
  if (!visible) return;

  if (el.trackerCurrentLabel) el.trackerCurrentLabel.textContent = label;
  if (el.trackerPercentLabel) el.trackerPercentLabel.textContent = `${Math.round(percent)}%`;

  const steps = ["draft", "package", "review", "v2"];
  const activeIdx = steps.indexOf(activeStep);

  steps.forEach((step, idx) => {
    const node = el.studioPipelineTracker.querySelector(`[data-pipe-step="${step}"]`);
    if (node) {
      node.classList.remove("active", "completed");
      if (idx < activeIdx) node.classList.add("completed");
      else if (idx === activeIdx) node.classList.add("active");
    }
  });

  const lines = el.studioPipelineTracker.querySelectorAll(".stepper-line");
  lines.forEach((line, idx) => {
    line.classList.toggle("completed", idx < activeIdx);
  });
}

function renderHighlightVariantBar(project = state.currentProject) {
  if (!el.highlightVariantBar) return;
  el.highlightVariantBar.classList.add("hidden");
  el.highlightVariantBar.innerHTML = "";
}

function renderHighlightRevisionBar(project = state.currentProject) {
  if (!el.highlightRevisionBar) return;
  const variant = getActiveHighlightVariant(project);
  const history = Array.isArray(variant?.revisionHistory) ? variant.revisionHistory : [];
  const currentRevision = variant ? {
    revisionNumber: Number(variant.revisionNumber || 1),
    label: variant.revisionLabel || `V${Number(variant.revisionNumber || 1)}`,
    artifacts: variant.artifacts || {},
    current: true
  } : null;
  const revisions = [...history, currentRevision]
    .filter(Boolean)
    .filter((item, index, items) => items.findIndex((candidate) => Number(candidate.revisionNumber) === Number(item.revisionNumber)) === index)
    .sort((left, right) => Number(left.revisionNumber) - Number(right.revisionNumber));
  const playable = revisions.filter((item) => item.artifacts?.fastDraftVideoPath);
  const shouldShow = project?.mode === "highlight_cut" && revisions.length > 1 && playable.length > 0;
  el.highlightRevisionBar.classList.toggle("hidden", !shouldShow);
  if (!shouldShow) {
    el.highlightRevisionBar.innerHTML = "";
    return;
  }
  el.highlightRevisionBar.innerHTML = `
    <span class="revision-label">So sánh draft</span>
    ${playable.map((item) => {
      const draftPath = item.artifacts.fastDraftVideoPath;
      const active = state.revisionPreviewPath
        ? state.revisionPreviewPath === draftPath
        : item.current;
      return `<button type="button" class="revision-button ${active ? "active" : ""}" data-revision-preview="${escapeHtml(draftPath)}">${escapeHtml(item.label || `V${item.revisionNumber}`)}</button>`;
    }).join("")}
  `;
}

function getActiveHighlightVariantForUi(project = state.currentProject) {
  const variants = getHighlightVariants(project);
  const activeId = project?.analysis?.activeVariantId || variants[0]?.id || "";
  return variants.find((variant) => variant.id === activeId) || variants[0] || null;
}

function getIndependentOptionsForVariant(variant = {}) {
  const stored = variant.independentPromptOptions || variant.independent_prompt_options || {};
  const defaults = readIndependentPromptOptions();
  return {
    ...defaults,
    ...stored,
    hookPriority: normalizeIndependentHookPriority(stored.hookPriority || defaults.hookPriority),
    hookMaxSec: Math.min(30, Math.max(4, Number(stored.hookMaxSec || defaults.hookMaxSec || 30))),
    durations: {
      ...defaults.durations,
      ...(stored.durations || {})
    }
  };
}

function getViralProfileForUi(scriptId = 4, workflow = "", independentOptions = null) {
  if (workflow === "story_recut") {
    return {
      duration: "tối thiểu 60s, không giới hạn tối đa",
      minDuration: 60,
      maxDuration: null,
      maxSourceJumps: 4,
      minMacroBlocks: 3,
      maxMacroBlocks: null,
      maxVoiceoverSec: 0,
      maxVoiceovers: 0,
      minOriginalAudioRatio: 1
    };
  }
  const normalizedScriptId = Math.max(1, Math.min(5, Number(scriptId) || 1));
  const optionKey = `script${normalizedScriptId}`;
  const fallback = normalizedScriptId === 3 ? { min: 90, max: 240 } : { min: 60.5, max: 120 };
  const configured = independentOptions?.durations?.[optionKey] || fallback;
  const minDuration = Math.max(60.5, Number(configured.min || fallback.min));
  const maxDuration = Math.max(minDuration, Number(configured.max || fallback.max));
  const common = {
    duration: `${minDuration}-${maxDuration}s`,
    minDuration,
    maxDuration,
    hookMaxSec: Math.min(30, Math.max(4, Number(independentOptions?.hookMaxSec || 30)))
  };
  if (normalizedScriptId === 1) {
    return { ...common, maxSourceJumps: 4, maxMacroBlocks: 6, maxVoiceoverSec: 8 };
  }
  if (normalizedScriptId === 3) {
    return { ...common, maxSourceJumps: 5, maxMacroBlocks: 8, maxVoiceoverSec: 12 };
  }
  if (normalizedScriptId === 2) {
    return { ...common, maxSourceJumps: 4, maxMacroBlocks: 7, maxVoiceoverSec: 8 };
  }
  if (normalizedScriptId === 5) {
    return { ...common, maxSourceJumps: 4, maxMacroBlocks: 7, maxVoiceoverSec: 8 };
  }
  return { ...common, maxSourceJumps: 3, maxMacroBlocks: 7, maxVoiceoverSec: 8 };
}

function buildVariantRepairJson(variant = {}) {
  const segments = variant.segments || [];
  const macroBlocks = [];
  segments.forEach((segment, index) => {
    const macroBlockId = segment.macroBlockId || `macro_${String(index + 1).padStart(2, "0")}`;
    let block = macroBlocks.find((item) => item.macroBlockId === macroBlockId);
    if (!block) {
      block = {
        macroBlockId,
        storyFunction: segment.storyFunction || segment.sceneType || "story_beat",
        sourceRunIds: [],
        summary: segment.actionNotes || segment.previewVi || segment.sceneType || "Rebuild this story beat from locked evidence."
      };
      macroBlocks.push(block);
    }
    if (segment.sourceRunId && !block.sourceRunIds.includes(segment.sourceRunId)) {
      block.sourceRunIds.push(segment.sourceRunId);
    }
  });
  const totalDuration = segments.reduce((sum, segment) => sum + getSegmentTimelineDuration(segment), 0);
  const storedBlueprint = variant.storyBlueprint && typeof variant.storyBlueprint === "object"
    ? variant.storyBlueprint
    : null;
  return {
    mode: variant.workflow === "story_recut" ? "story_recut" : undefined,
    scriptId: variant.workflow === "story_recut"
      ? undefined
      : variant.scriptId || variant.viralPreflight?.metrics?.scriptId || 4,
    title: variant.title || variant.label || "Highlight Repair",
    language: variant.language || "en",
    sourceLanguage: "en",
    total_target_sec: Number(totalDuration.toFixed(3)),
    style: variant.style || "True Crime Bodycam Highlight",
    monetization_target_sec_min: 60,
    audio_strategy: variant.audioStrategy || undefined,
    voiceover_enabled: variant.voiceoverEnabled,
    prompt_profile: variant.promptProfile || "independent_variants",
    timeline_policy: variant.timelinePolicy || "story_driven_non_linear_with_explicit_bridges",
    independent_prompt_options: variant.independentPromptOptions || undefined,
    hook_selection_audit: variant.hookSelectionAudit || undefined,
    narrative_contract: variant.narrativeContract || undefined,
    actor_identity_map: Array.isArray(variant.actorIdentityMap) ? variant.actorIdentityMap : [],
    hook_transition_test: variant.hookTransitionTest || null,
    narration_arc: variant.narrationArc || undefined,
    story_blueprint: storedBlueprint || {
      centralCharacter: "",
      primaryConflict: "",
      audienceQuestion: "",
      setup: "",
      escalation: "",
      climax: "",
      consequence: "",
      finalPayoff: "",
      macroBlocks
    },
    segments: segments.map((segment, index) => ({
      id: segment.id || `highlight_${String(index + 1).padStart(4, "0")}`,
      evidenceId: segment.evidenceId || "",
      sceneId: segment.sceneId || "",
      sourceRunId: segment.sourceRunId || "",
      macroBlockId: segment.macroBlockId || "",
      sourceStartSec: Number(segment.sourceStartSec || 0),
      sourceEndSec: Number(segment.sourceEndSec || 0),
      startSec: Number(segment.startSec || 0),
      endSec: Number(segment.endSec || 0),
      playbackSpeed: Number(segment.playbackSpeed || 1),
      scene_type: segment.sceneType || "",
      storyFunction: segment.storyFunction || "",
      narrativePurpose: segment.narrativePurpose || "",
      narrationBeatId: segment.narrationBeatId || "",
      microCutPurpose: segment.microCutPurpose || "none",
      transitionReason: segment.transitionReason || "",
      transitionExplainedBy: segment.transitionExplainedBy || "none",
      bridgePurpose: segment.bridgePurpose || "",
      timelinePhase: segment.timelinePhase || "",
      jargonExplanation: segment.jargonExplanation || "",
      actor_ids: Array.isArray(segment.actorIds) ? segment.actorIds : [],
      primary_actor_id: segment.primaryActorId || "",
      speaker_actor_id: segment.speakerActorId || "",
      original_audio_value_score: Number(segment.originalAudioValueScore || 0),
      original_audio_value_reason: segment.originalAudioValueReason || "",
      original_audio_protected: segment.originalAudioProtected === true,
      audio_mode: segment.audioMode || "original_audio",
      voiceover_text: segment.voiceoverText || "",
      caption: segment.caption || "",
      preview_vi: segment.previewVi || segment.previewSubtitleVi || "",
      action_notes: segment.actionNotes || ""
    }))
  };
}

function buildViralRepairTargets(preflight = {}, profile = getViralProfileForUi(preflight.metrics?.scriptId)) {
  const diagnostics = preflight.diagnostics || {};
  const issueText = (preflight.issues || []).join("\n");
  const failedCausalJumps = [
    ...(diagnostics.postHookUnjustifiedBackwardJumps || diagnostics.postHookBackwardJumps || []),
    ...(diagnostics.postHookUnbridgedJumps || [])
  ];
  const shortFragmentsFailed = /băm vụn/i.test(issueText);
  const hookDurationSec = Number(preflight.metrics?.hookDurationSec || 0);
  return {
    hook: hookDurationSec > 0 && (hookDurationSec < 3 || hookDurationSec > Number(profile.hookMaxSec || 30)) ? {
      segment: 1,
      durationSec: hookDurationSec,
      requiredFix: `Select or extend one qualified Hook within 3-${Number(profile.hookMaxSec || 30)} seconds. It may use a controlled 1-4 segment montage with the same actionSequenceId when separate verified beats form one understandable mini-arc.`
    } : null,
    narrativeRoles: /Hook.*Escalation.*Climax|Nhãn mạch truyện/i.test(issueText) ? {
      requiredFix: "Rebuild storyFunction and story_blueprint so the selected sequence contains Hook, Context, Escalation, Climax, and Consequence/Payoff."
    } : null,
    sourceTimelineJumps: failedCausalJumps.map((item) => ({
      betweenSegments: `${item.fromSegment}-${item.toSegment}`,
      sourceGapSec: item.gapSec,
      requiredFix: "Repair this backward or unexplained jump because it breaks the Story Spine. The total number of source jumps is not itself an error."
    })),
    shortFragments: (shortFragmentsFailed ? diagnostics.riskyShortFragments || diagnostics.shortFragments || [] : []).map((item) => ({
      segment: item.segment,
      evidenceId: item.evidenceId,
      durationSec: item.durationSec,
      requiredFix: "Merge into its causal macro-block or extend only within the same locked evidence/sourceRun to preserve a complete beat."
    })),
    longVoiceovers: (diagnostics.longVoiceovers || []).map((item) => ({
      segment: item.segment,
      evidenceId: item.evidenceId,
      durationSec: item.durationSec,
      requiredFix: "Shorten the narration within the calibrated word budget or split it using a meaningful original-audio beat."
    })),
    unsupportedClaims: (diagnostics.groundingFailures || []).map((item) => ({
      segment: item.segment,
      evidenceId: item.evidenceId,
      unsupportedClaims: item.unsupportedClaims,
      requiredFix: "Rewrite using only facts explicitly supported by this evidence, or replace the segment with another locked evidence item."
    })),
    burnedTextConflicts: (diagnostics.burnedTextConflicts || []).map((item) => ({
      segment: item.segment,
      evidenceId: item.evidenceId,
      requiredFix: "Use original_audio, choose compatible evidence, or make the narration match the visible burned text."
    })),
    actorIdentity: {
      missingSegments: diagnostics.actorMetadataMissingSegments || [],
      referenceViolations: diagnostics.actorReferenceViolations || [],
      requiredFix: "Build one stable actor_identity_map, tag every segment, and never attach one person's action or consequence to another person."
    },
    hookTransition: diagnostics.hookTransition || null,
    protectedOriginalAudio: (diagnostics.protectedOriginalAudioViolations || []).map((item) => ({
      segment: item.index + 1,
      evidenceId: item.evidenceId,
      score: item.score,
      reason: item.reason,
      requiredFix: "Restore clean original_audio for this authentic quote/reaction, or move tool narration to a separate bridge visual."
    })),
    narrativeContract: {
      contract: diagnostics.narrativeContract || null,
      missingResolutionEvidenceIds: diagnostics.missingResolutionEvidenceIds || [],
      resolutionSegmentIndexes: diagnostics.resolutionSegmentIndexes || [],
      firstLaterOutcomeSegment: diagnostics.firstLaterOutcomeSegment || null,
      requiredFix: "Keep the Hook promise and primary audience question explicit. Insert every mandatory resolution evidence before any later_outcome segment; suspect/legal outcome cannot replace victim or hazard resolution. When verified legal/current-status evidence exists, declare secondaryPayoff.required=true, mustBeFinal=true, and end on it."
    },
    storySpine: diagnostics.storySpine ? {
      ...diagnostics.storySpine,
      requiredFix: "Rebuild one central viewer question and the full Climax teaser -> Rewind/Context -> Escalation -> Climax return -> primary visual Payoff -> required verified Final Outcome chain. Every selected segment must advance that question; remove technically valid footage that does not."
    } : null,
    jargonClarity: (diagnostics.jargonIssues || []).map((item) => ({
      segment: item.index,
      evidenceId: item.evidenceId,
      terms: item.terms || [],
      requiredFix: "Remove the weak jargon range or add one concise voiceover bridge with bridgePurpose=jargon_clarity and jargonExplanation."
    })),
    visualPayoff: diagnostics.visualPayoff ? {
      ...diagnostics.visualPayoff,
      requiredFix: "Use at least one preferred visual resolution evidence item before later_outcome. Verbal confirmation may reinforce the payoff but cannot replace visible rescue, safety, aftermath, or physical proof."
    } : null,
    proceduralBloat: (diagnostics.proceduralBloatSegments || []).map((item) => ({
      segment: item.index,
      evidenceId: item.evidenceId,
      durationSec: item.durationSec,
      type: item.type,
      requiredFix: "Remove this routine administrative block and replace it with locked action, conflict, visual stakes, or visual payoff evidence."
    })),
    structuralReview: diagnostics.structuralComparison || null
  };
}

function buildGeminiJsonCodeBlockContract(fileName, rootDescription) {
  return buildGeminiSingleJsonCodeBlockContract(fileName, rootDescription);
}

function buildViralRepairPrompt(project = state.currentProject, repairEvidence = {}) {
  const variant = getActiveHighlightVariantForUi(project);
  const preflight = variant?.viralPreflight;
  if (!variant || !preflight) return "";
  const lockedEvidenceJson = JSON.stringify(repairEvidence || {}, null, 2);
  if (preflight.metrics?.workflow === "story_recut") {
    const currentJson = JSON.stringify(buildVariantRepairJson(variant), null, 2);
    const issueLines = (preflight.issues || []).map((issue, index) => `${index + 1}. ${issue}`).join("\n");
    const outputName = "story-recut-repaired.json";
    const deliveryContract = buildGeminiJsonCodeBlockContract(
      outputName,
      "The root must be exactly one Story Recut script object with artifactType=\"story_recut_script\" and a non-empty segments array; do not wrap it in data, result, output, or an array."
    );
    return `${deliveryContract}

USER TASK INSTRUCTION - REPAIR THE STORY RECUT

Repair exactly this one Story Recut using the AUTHORITATIVE LOCKED EVIDENCE embedded in this prompt. Do not rely on earlier conversation context.

CURRENT SCORE:
- Viral/continuity readiness: ${preflight.score}/100 (${preflight.grade})
- Required duration: at least 60 seconds; no maximum when a longer passage is necessary for the story
- Required original_audio: 100%
- Maximum source timeline jumps: 4
- Required macro-blocks: at least 3; no fixed maximum
- Tool voiceover/TTS segments: 0

FAILED CHECKS:
${issueLines || "No textual issue recorded."}

EXACT DIAGNOSTICS (segment numbers are 1-based):
${JSON.stringify(preflight.diagnostics || {}, null, 2)}

AUTHORITATIVE LOCKED EVIDENCE FOR THIS REPAIR:
${lockedEvidenceJson}

REPAIR RULES:
1. Rebuild story_blueprint before changing segments.
2. Preserve verified facts and causal order. Reorder complete macro-blocks, never isolated shock clips.
3. Keep evidence inside each macro-block source-adjacent and internally chronological.
4. Preserve complete dialogue/action/reaction beats.
5. Reduce source jumps to 4 or fewer and explain every transitionReason.
6. Keep at least 3 meaningful macro-blocks with Hook, Context, Escalation, Climax, and Consequence/Payoff. Do not split one complete source passage merely to increase the count.
7. Set audio_strategy="source_audio_only" and voiceover_enabled=false. Every segment must use audio_mode="original_audio" and voiceover_text="".
8. Keep total duration at least 60 seconds. There is no maximum duration; retain a continuous 2-3 minute passage when shortening it would damage context, causality, suspense, or payoff.
9. Preserve locked evidenceId, sceneId, sourceRunId, and source timestamp corridors.
10. Recalculate startSec/endSec contiguously from 0.
11. Preserve the complete source soundtrack in every selected range, including source narrator. Never create TTS or replace, mute, or duck the source narrator.

CURRENT JSON TO REBUILD:
${currentJson}

${deliveryContract}`;
  }
  const scriptId = Number(variant.scriptId || preflight.metrics?.scriptId || 4);
  const independentOptions = getIndependentOptionsForVariant(variant);
  const profile = getViralProfileForUi(scriptId, preflight.metrics?.workflow, independentOptions);
  const outputName = `script-${scriptId}-repaired.json`;
  const issueLines = (preflight.issues || []).map((issue, index) => `${index + 1}. ${issue}`).join("\n");
  const diagnostics = JSON.stringify(buildViralRepairTargets(preflight, profile), null, 2);
  const currentJson = JSON.stringify(buildVariantRepairJson(variant), null, 2);
  const deliveryContract = buildGeminiJsonCodeBlockContract(
    outputName,
    `The root must be exactly one repaired Script ${scriptId} object with scriptId=${scriptId} and a non-empty segments array; do not return other variants or use an outer wrapper.`
  );
  return `${deliveryContract}

USER TASK INSTRUCTION - REPAIR ONE FAILED HIGHLIGHT SCRIPT

This is a repair pass for Script ${scriptId}: "${variant.label || variant.title || `Variant ${scriptId}`}".
Use only the AUTHORITATIVE LOCKED EVIDENCE embedded below. Do not rely on earlier conversation context. Do not generate Scripts 1, 3, and 4 again. Return only the repaired Script ${scriptId}.

CURRENT VIRAL READINESS:
- Score: ${preflight.score}/100
- Grade: ${preflight.grade}
- Required profile duration: ${profile.duration}
- Monetization minimum: 60.5 seconds
- Reference major source jumps: approximately ${profile.maxSourceJumps} or fewer when the story permits; not a rejection gate
- Reference macro-blocks: approximately ${profile.maxMacroBlocks} or fewer when the story permits; not a rejection gate
- Maximum voiceover block: ${profile.maxVoiceoverSec ? `${profile.maxVoiceoverSec}s` : "No tool voiceover"}

LOCKED USER OPTIONS FOR THIS INDEPENDENT SCRIPT:
${buildIndependentPromptOptionsBlock(independentOptions)}

FAILED CHECKS:
${issueLines || "No textual issue was recorded; rebuild any metric that is outside the profile."}

EXACT REPAIR MAP (segment numbers are 1-based):
${diagnostics}

AUTHORITATIVE LOCKED EVIDENCE FOR THIS REPAIR:
${lockedEvidenceJson}

MANDATORY REPAIR PROCEDURE:
0. Preserve independent_prompt_options exactly. Re-evaluate Hook candidates in the configured priority order and regenerate hook_selection_audit. Keep the current Hook only if it still wins the qualification and fallback procedure.
1. Rebuild story_blueprint.storySpine first: centralViewerQuestion, hookPromise, rewindContext, escalationPath, climax, climaxEvidenceIds, payoff, payoffEvidenceIds, finalOutcomeRequired, finalOutcome, and finalOutcomeEvidenceIds. Reject the repair internally if it does not return to the promised climax, answer the central question, and end on every required verified final outcome.
2. Build the shortest complete causal sequence from continuous source ranges. Macro-block counts are reference diagnostics, not quotas. Do not sort or select scenes by viralScore alone.
3. Use only source jumps that advance the same Story Spine. Jump count is not a rejection gate, but every jump must connect through because, therefore, but, or as a result.
4. Keep complete dialogue/action/reaction beats. Remove isolated micro-clips and do not cut spoken sentences.
5. Every concrete claim in voiceover_text must be supported by the same evidenceId. Replace any unsupported claim or choose another locked evidence item.
6. Do not put unrelated narration over evidence with burnedTextPresent=true or safeForVoiceover=false.
7. Keep every sourceStartSec/sourceEndSec completely inside its evidence item. Preserve evidenceId, sceneId, and the tool-derived sourceRunId.
8. Recalculate startSec/endSec contiguously from 0 and satisfy the duration formula.
9. The final duration must be within ${profile.duration} and must never be below 60.5 seconds after playbackSpeed.
10. ${scriptId === 1 ? 'Set audio_strategy="clean_hybrid" and voiceover_enabled=true. Prefer mostly clean original_audio, but use as many concise voiceover bridges as Story Spine comprehension requires; there is no fixed bridge quota.' : profile.maxVoiceoverSec ? `Keep every voiceover_only block at or below ${profile.maxVoiceoverSec} seconds and within the calibrated word budget.` : "Set audio_strategy=\"source_audio_only\", voiceover_enabled=false, audio_mode=\"original_audio\", and voiceover_text=\"\" for every segment."}
11. Include scriptId=${scriptId}, story_blueprint.storySpine, macroBlockId, storyFunction, narrativePurpose, transitionReason, evidenceId, sceneId, and sourceRunId in the repaired JSON.
12. For Scripts 1, 3, and 4, evidence with sourceNarratorPresent=true is automatically muted and recreated by the tool as TTS. Its full segment duration counts as voiceover duration even if audio_mode is written as "original_audio". Do not use that field to evade the voiceover limit.
13. If burnedTextPresent=true or safeForVoiceover=false, use narration only when it agrees exactly with burnedTextContent; otherwise select compatible evidence.
14. Validate every failed metric again before returning. The repaired script must remove the listed failures and must not introduce a new failure.
15. Rebuild actor_identity_map and tag every segment with actor_ids, primary_actor_id, and speaker_actor_id. The Hook plus the next 15 seconds must pass hook_transition_test without confusing one person for another.
16. When the Hook resets to Context or introduces new actors, hook_transition_test.bridgeText must explicitly identify the verified people, relationship, and chronology. Generic bridge narration is invalid.
17. Preserve every clean originalAudioProtected range as original_audio. Move tool narration to a separate bridge visual instead of muting an indispensable quote, reaction, command, impact, radio call, or confrontation.
18. If locked evidence contains mustInclude=true with stakeRole legal_resolution or suspect_resolution, set story_blueprint.storySpine.finalOutcomeRequired=true and narrative_contract.secondaryPayoff.required=true/mustBeFinal=true. Place that evidence after the primary visual payoff and make it the last meaningful segment. Never end on a suspect excuse when a verified later outcome exists.

CURRENT FAILED JSON TO REBUILD:
${currentJson}

OUTPUT DELIVERY:
- Return the repaired script using the JSON code-block contract below. Do not return another script.

${deliveryContract}`;
}

function renderViralDiagnostics(project = state.currentProject) {
  if (!el.viralDiagnostics) return;
  const variant = getActiveHighlightVariantForUi(project);
  const preflight = variant?.viralPreflight;
  const visible = project?.mode === "highlight_cut" && Boolean(preflight);
  el.viralDiagnostics.classList.toggle("hidden", !visible);
  if (!visible) return;

  const metrics = preflight.metrics || {};
  const profile = getViralProfileForUi(
    metrics.scriptId || variant.scriptId,
    metrics.workflow,
    getIndependentOptionsForVariant(variant)
  );
  const passed = Boolean(preflight.passed);
  const technicalReadiness = preflight.scoreBreakdown?.technicalReadiness;
  const editorialReadiness = preflight.scoreBreakdown?.editorialReadiness;
  if (el.viralDiagnosticsTitle) {
    el.viralDiagnosticsTitle.textContent = `${variant.label || variant.title || "Variant"} · ${passed ? "Đạt" : "Cần sửa"}`;
  }
  if (el.viralDiagnosticsGrade) {
    el.viralDiagnosticsGrade.textContent = technicalReadiness && editorialReadiness
      ? `Tổng ${preflight.score}/100 · Kỹ thuật ${technicalReadiness.score}/100 · Biên tập ${editorialReadiness.score}/100`
      : `${preflight.score}/100 · ${preflight.grade}`;
    el.viralDiagnosticsGrade.className = `viral-grade grade-${String(preflight.grade || "d").toLowerCase()}`;
  }
  const readinessItems = technicalReadiness && editorialReadiness ? [
    ["Kỹ thuật", `${technicalReadiness.score}/100`, technicalReadiness.passed ? "pass" : "fail"],
    ["Biên tập", `${editorialReadiness.score}/100`, editorialReadiness.passed ? "pass" : "fail"]
  ] : [];
  const metricItems = [...readinessItems, ...(metrics.workflow === "story_recut" ? [
    ["Thời lượng", `${fmt(metrics.durationSec, 1)}s`, metrics.durationWithinProfile ? "pass" : "fail"],
    ["Source jump", `${metrics.sourceJumpCount || 0}/${profile.maxSourceJumps}`, (metrics.sourceJumpCount || 0) <= profile.maxSourceJumps ? "pass" : "fail"],
    ["Macro-block", `${metrics.macroBlockCount || 0} khối`, (metrics.macroBlockCount || 0) >= profile.minMacroBlocks ? "pass" : "fail"],
    ["Âm gốc", `${Math.round(Number(metrics.originalAudioRatio || 0) * 100)}%`, Number(metrics.originalAudioRatio || 0) >= profile.minOriginalAudioRatio ? "pass" : "fail"],
    ["Voice của tool", `${metrics.voiceoverCount || 0} đoạn`, (metrics.voiceoverCount || 0) === 0 ? "pass" : "fail"],
    ["Blueprint", metrics.hasStoryBlueprint ? "Có" : "Thiếu", metrics.hasStoryBlueprint ? "pass" : "fail"]
  ] : [
    [
      "Thời lượng",
      `${fmt(metrics.durationSec, 1)}s`,
      (metrics.durationWithinProfile ?? (
        Number(metrics.durationSec) >= profile.minDuration
        && Number(metrics.durationSec) <= profile.maxDuration
      )) ? "pass" : "fail"
    ],
    ["Source jump", `${metrics.sourceJumpCount || 0}/${profile.maxSourceJumps}`, (metrics.sourceJumpCount || 0) <= profile.maxSourceJumps ? "pass" : "fail"],
    ["Macro-block", `${metrics.macroBlockCount || 0}/${profile.maxMacroBlocks}`, (metrics.macroBlockCount || 0) <= profile.maxMacroBlocks ? "pass" : "fail"],
    ["Grounding", `${metrics.groundingFailureCount || 0} lỗi`, metrics.groundingFailureCount ? "fail" : "pass"],
    ["Chữ burn", `${metrics.burnedTextConflictCount || 0} xung đột`, metrics.burnedTextConflictCount ? "fail" : "pass"],
    ["Blueprint", metrics.hasStoryBlueprint ? "Có" : "Thiếu", metrics.hasStoryBlueprint ? "pass" : "fail"]
  ])];
  if (el.viralDiagnosticsMetrics) {
    el.viralDiagnosticsMetrics.innerHTML = metricItems.map(([label, value, status]) => `
      <div class="viral-metric ${status}">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `).join("");
  }
  const issues = preflight.issues || [];
  const repairTargets = buildViralRepairTargets(preflight, profile);
  const details = [
    ...repairTargets.sourceTimelineJumps.map((item) => (
      `Cảnh ${item.betweenSegments}: nhảy ${fmt(item.sourceGapSec, 1)}s trên nguồn. ${item.requiredFix}`
    )),
    ...repairTargets.shortFragments.map((item) => (
      `Cảnh ${item.segment} (${item.evidenceId || "chưa có evidence"}): chỉ ${fmt(item.durationSec, 1)}s. ${item.requiredFix}`
    )),
    ...repairTargets.longVoiceovers.map((item) => (
      `Cảnh ${item.segment} (${item.evidenceId || "chưa có evidence"}): voiceover ${fmt(item.durationSec, 1)}s. ${item.requiredFix}`
    )),
    ...repairTargets.unsupportedClaims.map((item) => (
      `Cảnh ${item.segment} (${item.evidenceId || "chưa có evidence"}): claim chưa được hỗ trợ [${(item.unsupportedClaims || []).join(", ")}]. ${item.requiredFix}`
    )),
    ...repairTargets.burnedTextConflicts.map((item) => (
      `Cảnh ${item.segment} (${item.evidenceId || "chưa có evidence"}): chữ burn xung đột với voice mới. ${item.requiredFix}`
    ))
  ];
  const displayedIssues = [...issues, ...details.filter((detail) => !issues.includes(detail))];
  if (el.viralDiagnosticsIssues) {
    el.viralDiagnosticsIssues.innerHTML = displayedIssues.length
      ? displayedIssues.map((issue, index) => `
        <article class="viral-issue">
          <span>${index + 1}</span>
          <p>${escapeHtml(issue)}</p>
        </article>
      `).join("")
      : `<div class="viral-pass-message">Không còn lỗi Viral Preflight.</div>`;
  }
  if (el.copyViralRepairPrompt) {
    el.copyViralRepairPrompt.disabled = !displayedIssues.length;
  }
}

async function copyViralRepairPrompt() {
  try {
    const repairEvidence = state.currentProject?.id
      ? await window.cineviral.getViralRepairContext(state.currentProject.id)
      : {};
    const prompt = buildViralRepairPrompt(state.currentProject, repairEvidence);
    if (!prompt) {
      showToast("Variant này chưa có dữ liệu Viral Preflight.");
      return;
    }
    const copied = await copyTextToClipboard(prompt);
    if (copied) showToast(`Đã copy prompt cùng ${repairEvidence?.evidence?.length || 0} evidence đã khóa.`);
  } catch (error) {
    addLog(error.message, "ERROR");
    showToast(error.message);
  }
}

async function switchHighlightVariant(variantId) {
  if (!state.currentProject || state.currentProject.mode !== "highlight_cut") return;
  const variants = getHighlightVariants();
  const target = variants.find((variant) => variant.id === variantId);
  if (!target) return;
  state.revisionPreviewPath = "";
  await saveCurrentSegments();
  const latest = state.currentProject;
  const latestVariants = getHighlightVariants(latest);
  const activeTarget = latestVariants.find((variant) => variant.id === variantId) || target;
  const segments = activeTarget.segments || [];
  state.currentProject = await window.cineviral.updateProjectPlan(
    latest.id,
    {
      ...(latest.analysis || {}),
      activeVariantId: variantId,
      segments,
      warnings: activeTarget.warnings || [],
      highlightVariants: latestVariants
    }
  );
  state.selectedSegmentIndex = 0;
  state.expandedScenePickerIndex = -1;
  renderStudio();
}

function renderAutoStoryStatus() {
  const project = state.currentProject;
  const visible = project?.analysisWorkflow === "vertex_auto_story";
  const panel = $("auto-story-status");
  const button = $("resume-auto-story");
  panel?.classList.toggle("hidden", !visible);
  if (!visible) { button?.classList.add("hidden"); $("pipeline-stepper")?.classList.add("hidden"); return; }
  const job = project.autoStoryState || {};
  const errorsForStepper = (job.audits || project.analysis?.autoStoryAudits || []).some(a => a.error || a.finalCheck?.error) || project.analysis?.variantDraftBatch?.failures?.length || job.failures?.length;
  const stepper = $("pipeline-stepper");
  if (stepper) {
    stepper.classList.remove("hidden");
    const p = job.phase || "planning";
    const phases = ["planning", "editing", "rendering", "reviewing"];
    let currentIdx = phases.indexOf(p);
    if (currentIdx === -1) currentIdx = p === "complete" ? 4 : 0;
    phases.forEach((stepName, idx) => {
      const el = stepper.querySelector(`[data-step="${stepName}"]`);
      if (el) {
        el.className = "step";
        if (idx < currentIdx || p === "complete") el.classList.add("completed");
        else if (idx === currentIdx) el.classList.add(errorsForStepper ? "error" : "active");
      }
    });
  }
  const variants = project.analysis?.highlightVariants || [];
  const audits = job.audits || project.analysis?.autoStoryAudits || [];
  const requested = project.autoStoryConfig?.outputCount || 2;
  const scripts = project.storyScriptPaths?.length || variants.length;
  const drafts = variants.filter(v => v.artifacts?.fastDraftVideoPath).length;
  const reviewed = audits.filter(a => a.complete).length;
  const errors = audits.some(a => a.error || a.finalCheck?.error) || project.analysis?.variantDraftBatch?.failures?.length || job.failures?.length;
  const pendingFinal = audits.some(a => a.applied && !a.finalCheck?.complete);
  const missingScripts = scripts < requested;
  const pendingSubtitles = audits.some(a => a.previewSubtitleRepair?.error);
  const pendingRhythm = audits.some(a => a.complete && a.rhythmPolicyVersion !== 1);
  const unfinished = job.phase !== "complete" || errors || pendingFinal || missingScripts || pendingSubtitles || pendingRhythm;
  const labels = { planning: "Đang chọn câu chuyện", editing: "Đang tạo kịch bản và đo voice", ready_to_render: "Kịch bản đã sẵn sàng",
    rendering: "Đang dựng draft", reviewing: "Đang review video thật", review_failed: "Review bị lỗi, draft được giữ lại", render_failed: "Dựng bị gián đoạn", failed: "Xử lý bị lỗi", cancelled: "Đã dừng", complete: errors ? "Có bước cần thử lại" : "Đã hoàn tất" };
  labels.verifying = "Đang kiểm tra bản cuối";
  if (job.phase === "review_failed" && !drafts) labels.review_failed = "Xử lý bị lỗi trước khi có draft hoàn chỉnh";
  const label = state.busy && project.autoStoryProduction && !project.autoStoryProduction.finished ? "Đang sản xuất video · Kết quả sẵn sàng theo từng script" : job.phase === "complete" ? (state.busy ? "Đang kết thúc tác vụ" : missingScripts ? `Đã xử lý ${scripts}/${requested} · Còn thiếu ${requested - scripts} kịch bản` : errors ? "Có bước cần thử lại" : pendingFinal ? "Còn bản cuối cần kiểm tra" : "Đã hoàn tất xử lý · Xem kết quả từng script") : labels[job.phase] || "Chưa chạy Auto Story";
  const paused = unfinished && !state.busy && ["planning", "editing", "rendering", "reviewing"].includes(job.phase);
  const lines = [`${paused ? "Đã gián đoạn: " : ""}${label}`, `Yêu cầu ${requested} video · Kịch bản ${scripts}/${requested} · Draft ${drafts}/${scripts} · Review ${reviewed}/${scripts}`];
  lines.push(`Bản cuối đạt kiểm tra: ${audits.filter(a => a.finalCheck?.verdict === "PASS" || (!a.applied && a.complete && a.verdict === "PASS")).length}/${drafts}`);
  const costs = project.autoStoryCosts;
  const production = project.autoStoryProduction;
  if (production) {
    lines.push(`Thời gian lượt chạy: ${fmt((production.elapsedMs || 0) / 60000, 1)} phút${production.finished ? " · đã kết thúc" : " · đang xử lý"}`);
    for (const [id, item] of Object.entries(production.jobs || {})) {
      if (item.draftReadyMs != null) lines.push(`Script ${id}: draft sẵn sàng sau ${fmt(item.draftReadyMs / 60000, 1)} phút`);
    }
  }
  if (costs) {
    lines.push(`Chi phí API ghi nhận từ bản cập nhật này: ~$${costs.totalUsd.toFixed(3)}${costs.unknownCalls ? ` · ${costs.unknownCalls} lượt chưa có số liệu chi phí` : ""}`);
    const names = { planning: "Lập kế hoạch", editing: "Kịch bản", voiceRepair: "Sửa voice", review: "Review", verification: "Kiểm tra cuối" };
    for (const [id, group] of Object.entries(costs.groups || {})) {
      lines.push(`${id === "shared" ? "Chi phí chung" : `Script ${id}`}: ~$${group.totalUsd.toFixed(3)} · ${Object.entries(group.stages).map(([stage, usd]) => `${names[stage] || stage} $${usd.toFixed(3)}`).join(" · ")} · ${group.cacheHits} lần dùng cache`);
    }
  }
  if (job.error) lines.push(job.error);
  if (project.autoStoryCapacityWarning && !/^(null|undefined)$/i.test(String(project.autoStoryCapacityWarning).trim())) lines.push(project.autoStoryCapacityWarning);
  if (scripts && missingScripts) lines.push(job.boundedRun
    ? "Lượt xử lý đã giữ các bản tạo được. Xem lỗi từng script trước khi chủ động thử lại; tool không tự gọi AI vô hạn."
    : "Bấm Tiếp tục để bổ sung kịch bản còn thiếu hoặc thử lại script lỗi; giữ nguyên draft đã có.");
  for (const failure of job.failures || []) lines.push(`Script ${failure.scriptId}: ${failure.error}`);
  for (const variant of variants) {
    const audit = audits.find(a => a.scriptId === Number(variant.scriptId));
    const check = audit?.finalCheck;
    const rhythm = audit?.rhythmReport;
    if (rhythm?.totalSec > 0) lines.push(`Script ${variant.scriptId} · Âm gốc ${(rhythm.originalRatio * 100).toFixed(1)}% · Narrator ${(rhythm.narrationRatio * 100).toFixed(1)}% · Khối narrator dài nhất ${Math.max(0, ...rhythm.runs.map(r => r.duration)).toFixed(1)}s${audit.rhythmException ? ` · Ngoại lệ: ${audit.rhythmException}` : ""}`);
    const subtitleIssues = check?.previewSubtitleIssues || audit?.previewSubtitleIssues || [];
    if (subtitleIssues.length) lines.push(`Script ${variant.scriptId} · Phụ đề preview: ${audit.previewSubtitleRepair?.applied
      ? `đã sửa ${audit.previewSubtitleRepair.correctedSegments} đoạn; chưa AI kiểm tra lại${audit.previewSubtitleRepair.unresolved ? `, còn ${audit.previewSubtitleRepair.unresolved} lỗi cần xem` : ""}`
      : audit.previewSubtitleRepair?.error || `${subtitleIssues.length} lỗi cần sửa`}. Không ảnh hưởng phụ đề video xuất.`);
    lines.push(`Script ${variant.scriptId}: ${check?.error ? "Kiểm tra bản cuối lỗi: " + check.error : check?.verdict === "PASS" ? "Bản cuối đạt kiểm tra " + (check.scope === "full" ? "toàn video" : "vùng sửa; phần còn lại giữ review trước") : check?.verdict === "NEEDS_ATTENTION" ? "Cần bạn xem: " + check.issues.map(i => `${fmt(i.outputSec, 1)}s: ${i.reason}`).join("; ") : audit?.error ? "Review lỗi: " + audit.error : audit?.applied ? "Đã sửa · Chờ kiểm tra bản cuối" : audit?.complete ? (audit.verdict === "PASS" ? "Bản hiện tại đạt review" : "Review xong · Cần bạn xem") : variant.artifacts?.fastDraftVideoPath ? "Có draft, chưa review xong" : "Chưa có draft"}`);
  }
  let scriptList;
  if (panel) {
    const open = panel.dataset.projectId !== project.id || !panel.querySelector(".auto-story-script-list") || panel.querySelector(".auto-story-script-list").open;
    const diagnosticsOpen = panel.dataset.projectId === project.id && panel.querySelector(".auto-story-diagnostics")?.open;
    panel.dataset.projectId = project.id;
    const isV3 = project.autoStoryContractVersion === 3 || project.autoStoryPipelineVersion === "source-story-v3";
    const engineBadge = { label: isV3 ? "AutoStory V3" : "AutoStory V2", cls: isV3 ? "" : "v2" };
    panel.innerHTML = `<div class="auto-story-heading"><strong>${escapeHtml(lines[0])}</strong><span class="auto-story-engine-badge ${engineBadge.cls}">${escapeHtml(engineBadge.label)}</span><span>${escapeHtml(lines[2])}</span></div>
      <details class="auto-story-script-list" ${open ? "open" : ""}><summary>${escapeHtml(lines[1])}</summary><div class="auto-story-rows"></div></details>
      <details class="auto-story-diagnostics" ${diagnosticsOpen ? "open" : ""}><summary>Chi phí và chi tiết</summary><div>${lines.slice(3).map(line => `<p>${escapeHtml(line)}</p>`).join("") || "Chưa có thông tin bổ sung."}</div></details>
      <button type="button" class="auto-story-icon auto-story-open-folder" title="Mở thư mục phân tích của dự án">Mở thư mục phân tích</button>`;
    panel.querySelector(".auto-story-open-folder")?.addEventListener("click", async () => {
      try { await window.cineviral.openProjectFolder(project.id); }
      catch (e) { addLog(e.message, "ERROR"); }
    });
    scriptList = panel.querySelector(".auto-story-rows");
  }
  if (panel) for (const id of new Set([...variants.map(v => Number(v.scriptId)), ...(job.failures || []).map(f => Number(f.scriptId))])) {
    if (!Number.isInteger(id) || id < 1) continue;
    const v = variants.find(v => Number(v.scriptId) === id), a = audits.find(a => Number(a.scriptId) === id);
    const row = document.createElement("div"); row.className = "auto-story-row";
    const passed = a?.finalCheck?.verdict === "PASS" || (!a?.applied && a?.complete && a?.verdict === "PASS");
    const failed = a?.error || a?.finalCheck?.error || (job.failures || []).some(f => Number(f.scriptId) === id);
    const running = state.busy && (project.autoStoryProduction && !project.autoStoryProduction.finished
      ? ["rendering", "reviewing"].includes(project.autoStoryProduction.jobs?.[id]?.phase) : Number(job.scriptId) === id);
    const status = running ? "Đang xử lý" : failed ? "Cần thử lại" : passed ? "Đạt kiểm tra" : a?.finalCheck?.verdict === "NEEDS_ATTENTION" ? "Cần bạn xem" : a?.applied ? "Chờ kiểm tra cuối" : a?.complete ? "Đã review" : v?.artifacts?.fastDraftVideoPath ? "Chờ review" : "Chờ dựng";
    const duration = (v?.segments || []).reduce((n, s) => n + getSegmentTimelineDuration(s), 0);
    const title = v?.title || v?.label || `Script ${id}`;
    row.innerHTML = `<div class="auto-story-name"><strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong><small>Script ${id}${duration ? ` · ${fmt(duration, 1)}s` : ""}</small></div><span class="auto-story-state ${passed ? "passed" : failed ? "failed" : "pending"}" role="status">${escapeHtml(status)}</span><div class="auto-story-actions"></div>`;
    const actions = row.querySelector(".auto-story-actions");
    const action = (label, symbol, run, primary = false) => {
      const b = document.createElement("button"); b.type = "button"; b.className = primary ? "auto-story-command" : "auto-story-icon";
      b.textContent = symbol; b.title = label; b.setAttribute("aria-label", label); b.disabled = state.busy;
      b.addEventListener("click", async () => { try { await run(); } catch (e) { addLog(e.message, "ERROR"); } }); actions.append(b);
    };
    if (v?.artifacts?.fastDraftVideoPath) action("Xem bản hiện tại", "\u25b6", async () => {
      state.revisionPreviewPath = ""; state.videoEditPreviewMode = false;
      await switchHighlightVariant(v.id);
    });
    if (a?.applied && a.originalDraft) action("Xem bản trước", "\u21b6", async () => {
      state.videoEditPreviewMode = false;
      await switchHighlightVariant(v.id);
      state.revisionPreviewPath = a.originalDraft; renderPreviewSource(state.currentProject);
    });
    if (!a?.complete || a.error || (a.applied && !a.finalCheck?.complete)) action("Sửa bước lỗi, giữ draft đã có", running ? "Đang xử lý…" : "Sửa lỗi tự động", () => resumeAutoStoryProject(id), true);
    else if (a?.previewSubtitleRepair?.error) action("Thử lại sửa phụ đề preview", "Sửa phụ đề", () => resumeAutoStoryProject(id), true);
    else if (a?.complete && a.rhythmPolicyVersion !== 1) action("Kiểm tra nhịp kể theo tiêu chí âm gốc mới", "Kiểm tra nhịp", () => resumeAutoStoryProject(id), true);
    scriptList.append(row);
  }
  if (button) { button.classList.toggle("hidden", !unfinished); button.disabled = state.busy; button.textContent = state.busy ? "Đang xử lý Auto Story…" : job.boundedRun ? "Thử lại bước chưa hoàn tất" : "Tiếp tục / Sửa lỗi tự động"; }
}

function renderStudio() {
  renderAutoStoryStatus();
  const resumeAutoStory = $("resume-auto-story");
  if (resumeAutoStory) {
    resumeAutoStory.disabled = state.busy;
  }
  const project = state.currentProject;
  if (!project) {
    return;
  }
  syncAutoTopCaptionFromScript(project);
  const analysis = project.analysis || {};
  const segments = analysis.segments || [];
  const scenes = analysis.scenes || [];
  const totalDuration = segments.reduce((sum, segment) => sum + getSegmentTimelineDuration(segment), 0);

  const workflowLabel = project.analysisWorkflow === "manual_gemini_story_recut"
    ? "Story Recut · "
    : project.analysisWorkflow === "manual_gemini_diy_story_remix"
    ? "DIY Story Remix · "
    : project.analysisWorkflow === "manual_gemini_podcast_cut"
    ? "Podcast Viral Cut · "
    : ["manual_gemini_pro", "manual_gemini_pro_two_pass", "manual_gemini_draft_review"].includes(project.analysisWorkflow)
    ? "Gemini Draft Review · "
    : "";
  if (el.kpiScenes) el.kpiScenes.textContent = scenes.length || analysis.kpi?.sceneCount || 0;
  if (el.kpiSegments) el.kpiSegments.textContent = segments.length || analysis.kpi?.segmentCount || 0;
  if (el.kpiDuration) el.kpiDuration.textContent = `${fmt(totalDuration, 1)}s`;
  renderViralDiagnostics(project);

  const warnings = analysis.warnings || [];
  if (el.warningBox) {
    el.warningBox.innerHTML = warnings.length
      ? `<ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`
      : "Không phát hiện bất thường. Sẵn sàng xuất video.";
    el.warningBox.style.color = warnings.length ? "#ffb020" : "#35f0a4";
  }
  const isRecap = project.mode === "recap";
  const isScriptRewrite = project.mode === "script_rewrite";
  const isSatisfyingStorytime = project.mode === "satisfying_storytime";
  const isHighlightCut = project.mode === "highlight_cut";
  el.translateButton?.classList.toggle("hidden", isRecap || isScriptRewrite || isSatisfyingStorytime || isHighlightCut);
  el.diarizeButton?.classList.toggle("hidden", isRecap || isScriptRewrite || isSatisfyingStorytime || isHighlightCut);
  el.previewDraft?.classList.toggle("hidden", !isRecap);
  el.renderFastDraft?.classList.toggle("hidden", !(isSatisfyingStorytime || isHighlightCut));
  el.renderAllFastDrafts?.classList.toggle("hidden", !(isHighlightCut && getHighlightVariants(project).length > 1));
  const draftReviewArtifacts = getDraftReviewArtifacts(project);
  const supportsDraftReview = isSatisfyingStorytime || isHighlightCut;
  const isDraftReviewWorkflow = supportsDraftReview
    && (
      isHighlightCut
      || ["manual_gemini_draft_review", "manual_gemini_diy_story_remix", "vertex_auto_story", "manual_antigravity_stage1", "manual_gemini_pro", "manual_gemini_pro_two_pass"].includes(project.analysisWorkflow)
    );
  const variants = getHighlightVariants(project);
  const hasRenderedDraft = Boolean(draftReviewArtifacts.videoPath);
  el.draftReviewActions?.classList.toggle("hidden", !isDraftReviewWorkflow);
  if (el.runAutoReviewCurrent) {
    el.runAutoReviewCurrent.classList.toggle("hidden", !isDraftReviewWorkflow || variants.length === 0);
  }
  if (el.runAutoReviewAll) {
    el.runAutoReviewAll.classList.toggle("hidden", !isDraftReviewWorkflow || variants.length <= 1);
  }
  el.createGeminiDraftReview?.classList.toggle("hidden", !(isDraftReviewWorkflow && hasRenderedDraft));
  el.openGeminiDraftReview?.classList.toggle("hidden", !(isDraftReviewWorkflow && draftReviewArtifacts.reviewPackagePath));
  el.openDraftReviewPrompt?.classList.toggle("hidden", isDraftReviewWorkflow || !(supportsDraftReview && draftReviewArtifacts.promptPath));
  el.openDraftReviewReport?.classList.toggle("hidden", isDraftReviewWorkflow || !(supportsDraftReview && draftReviewArtifacts.reportPath));
  el.importReviewedScript?.classList.toggle(
    "hidden",
    !supportsDraftReview || project.analysisWorkflow === "manual_gemini_podcast_cut"
  );
  el.runConfiguredDraftReview?.classList.toggle("hidden", !(isDraftReviewWorkflow && hasRenderedDraft));
  el.openConfiguredDraftReviewResult?.classList.toggle("hidden", !draftReviewArtifacts.aiResultDir);
  el.importConfiguredDraftReview?.classList.toggle("hidden", !draftReviewArtifacts.aiResultPath);
  if (el.draftReviewStatus && isDraftReviewWorkflow) {
    el.draftReviewStatus.textContent = draftReviewArtifacts.aiResultPath
      ? `Đã review bằng ${getAiProviderLabel(draftReviewArtifacts.aiProvider)} · ${draftReviewArtifacts.aiModel || "model mặc định"}. Có thể kiểm tra và import V2.`
      : draftReviewArtifacts.reviewPackagePath
      ? "Gói review đã sẵn sàng. Có thể review ngay bằng AI hoặc mở gói để gửi thủ công."
      : hasRenderedDraft
      ? "Draft đã sẵn sàng. Bấm 'Auto Review & Render' để AI xem và tự động sửa V2."
      : "Sẵn sàng review. Bạn có thể bấm 'Auto Review & Render' (sẽ tự render draft trước nếu chưa có).";
  }
  renderPreviewWorkflowStatus(project);
  el.renderHighlightVariants?.classList.toggle("hidden", !(isHighlightCut && getHighlightVariants(project).length > 1));
  el.resumeRender?.classList.toggle("hidden", !project.artifacts?.recoverableRenderJobId);
  el.openOutputFolder?.classList.toggle("hidden", !getFinalOutputPath(project));

  renderHighlightVariantBar(project);
  renderStudioVariantHub(project);
  renderHighlightRevisionBar(project);
  renderSegments(segments);
  renderInspector();
  renderSpeakers();
  renderTimeline(segments, scenes);
  renderPreviewSource(project);
  if (el.studioSystemLog) {
    el.studioSystemLog.textContent = state.logLines.join("\n");
    el.studioSystemLog.scrollTop = el.studioSystemLog.scrollHeight;
  }
  renderActivity();
  syncConfiguredAiWorkflowUi();
}

function renderPreviewSource(project) {
  const path = getPreviewVideoPath(project);
  if (!path) {
    el.previewPlayer.removeAttribute("src");
    el.previewBackgroundPlayer?.removeAttribute("src");
    delete el.previewPlayer.dataset.previewUrl;
    el.videoPlaceholder.classList.remove("hidden");
    updatePreviewSubtitleOverlay();
    return;
  }
  const url = toVideoFileUrl(path, getPreviewCacheBust(project));
  if (el.previewPlayer.dataset.previewUrl !== url) {
    syncPreviewNativeControls();
    el.previewPlayer.src = url;
    el.previewPlayer.dataset.previewUrl = url;
    el.previewPlayer.load();
    syncPreviewBackgroundSource();
  }
  el.videoPlaceholder.classList.add("hidden");
  updatePreviewSubtitleOverlay();
  updateVideoDecorationPreview();
}

function switchVideoEditPreviewMode(active) {
  const next = Boolean(active);
  if (next) state.revisionPreviewPath = "";
  if (state.videoEditPreviewMode === next) return;
  state.videoEditPreviewMode = next;
  const currentTime = Number(el.previewPlayer?.currentTime || 0);
  const wasPlaying = Boolean(el.previewPlayer && !el.previewPlayer.paused);
  renderPreviewSource(state.currentProject);
  el.previewPlayer?.addEventListener("loadedmetadata", () => {
    syncPreviewNativeControls();
    if (Number.isFinite(el.previewPlayer.duration) && el.previewPlayer.duration > 0) {
      el.previewPlayer.currentTime = Math.min(currentTime, Math.max(0, el.previewPlayer.duration - 0.05));
    }
    if (wasPlaying) el.previewPlayer.play().catch(() => {});
  }, { once: true });
}

function activateVideoEditLivePreview() {
  if (!state.currentProject || state.videoEditPreviewMode) return;
  switchVideoEditPreviewMode(true);
  setVideoWysiwygEditing(true);
}

function getSegmentSceneMeta(segment, index) {
  const start = Number(segment.startSec || 0);
  const end = Number(segment.endSec || start + segment.clipDuration || start);
  const duration = Math.max(0, end - start);
  return {
    sceneId: segment.sceneId || segment.metadataSummary?.sceneId || `scene_${String(index + 1).padStart(2, "0")}`,
    start,
    end,
    duration,
    beat: segment.narrativeBeat || segment.storyBeatRole || segment.role || "",
    event: segment.plotEventId || segment.beatId || "",
    evidence: segment.visualEvidence || segment.transcriptEvidence || segment.reason || segment.description || "",
    thumbnailPath: segment.thumbnailPath || segment.metadataSummary?.thumbnailPath || ""
  };
}

function getScenePools() {
  const analysis = state.currentProject?.analysis || {};
  const source = [
    ...(Array.isArray(analysis.scenes) ? analysis.scenes : []),
    ...(Array.isArray(analysis.candidates) ? analysis.candidates : []),
    ...getSegments()
  ];
  const seen = new Set();
  return source.map((item, index) => {
    const start = Number(item.startSec ?? item.start ?? item.timestampStart ?? 0);
    const end = Number(item.endSec ?? item.end ?? item.timestampEnd ?? (start + Number(item.duration || item.clipDuration || item.renderDuration || 3)));
    const sceneId = item.sceneId || item.id || item.metadataSummary?.sceneId || `scene_${String(index + 1).padStart(3, "0")}`;
    const key = `${sceneId}:${start.toFixed(2)}:${end.toFixed(2)}`;
    if (seen.has(key)) {
      return null;
    }
    seen.add(key);
    return {
      ...item,
      sceneId,
      startSec: Math.max(0, start),
      endSec: Math.max(start + 0.4, end),
      duration: Math.max(0.4, end - start),
      label: item.label || item.title || item.role || item.narrativeBeat || item.storyBeatRole || `Cảnh ${index + 1}`,
      evidence: item.visualEvidence || item.transcriptEvidence || item.reason || item.description || item.audioTranscript || item.metadataSummary?.audioTranscript || "",
      thumbnailPath: item.thumbnailPath || item.metadataSummary?.thumbnailPath || ""
    };
  }).filter(Boolean).sort((a, b) => Number(a.startSec || 0) - Number(b.startSec || 0));
}

function getRelatedScenes(segment, index) {
  const current = getSegmentSceneMeta(segment, index);
  const currentStart = Number(current.start || 0);
  const pool = getScenePools();
  const related = pool
    .map((scene) => ({
      ...scene,
      distance: Math.abs(Number(scene.startSec || 0) - currentStart)
    }))
    .sort((a, b) => {
      const currentMatchA = a.sceneId === current.sceneId ? -1 : 0;
      const currentMatchB = b.sceneId === current.sceneId ? -1 : 0;
      return currentMatchA - currentMatchB || a.distance - b.distance;
    })
    .slice(0, 6);
  if (!related.some((scene) => scene.sceneId === current.sceneId)) {
    related.unshift({
      sceneId: current.sceneId,
      startSec: current.start,
      endSec: current.end,
      duration: current.duration,
      label: current.beat || "Cảnh hiện tại",
      evidence: current.evidence,
      distance: 0
    });
  }
  return related.slice(0, 6);
}

function previewScene(startSec, autoplay = false, { suppressSync = false } = {}) {
  if (!el.previewPlayer.src) {
    return;
  }
  seekTimeline(startSec, autoplay, { suppressSync });
}

function getTimelineSecondFromPointer(event) {
  if (!el.timelineCanvas) return 0;
  const rect = el.timelineCanvas.getBoundingClientRect();
  const x = Math.max(0, event.clientX - rect.left + el.timelineCanvas.scrollLeft);
  return x / TIMELINE_PX_PER_SEC;
}

function updateTimelinePlayhead(seconds = el.previewPlayer?.currentTime || 0) {
  const time = Math.max(0, Number(seconds || 0));
  if (el.timelineLabel) {
    el.timelineLabel.textContent = `Timeline: ${fmt(time)}s`;
  }
  if (el.previewTimecode) {
    el.previewTimecode.textContent = fmtTimecode(time);
  }
  const playhead = document.querySelector(".timeline-playhead");
  if (playhead) {
    playhead.style.left = `${time * TIMELINE_PX_PER_SEC}px`;
  }
}

function getPreviewSegmentIndexAtTime(seconds = 0) {
  const time = Math.max(0, Number(seconds || 0));
  const previewTimeline = getPreviewTimelineSegments();
  const timeline = previewTimeline.length
    ? previewTimeline
    : getSegments().map((segment, index, segments) => ({
      index,
      startSec: getSegmentTimelineStart(segment, index, segments),
      endSec: getSegmentTimelineEnd(segment, index, segments)
    }));
  const current = timeline.find((item, itemIndex) => {
    const startSec = Math.max(0, Number(item.startSec || 0));
    const fallbackEnd = startSec + Math.max(0.2, Number(item.durationSec || item.duration || 1));
    const endSec = Math.max(startSec + 0.2, Number(item.endSec || fallbackEnd));
    const isLast = itemIndex === timeline.length - 1;
    return time >= startSec && (time < endSec || (isLast && time <= endSec + 0.25));
  });
  return current ? Number(current.index) : -1;
}

function updateActiveSegmentDom(index) {
  document.querySelectorAll("[data-segment-index]").forEach((card) => {
    card.classList.toggle("active", Number(card.dataset.segmentIndex) === index);
  });
  document.querySelectorAll("[data-timeline-segment-index]").forEach((clip) => {
    clip.classList.toggle("active", Number(clip.dataset.timelineSegmentIndex) === index);
  });
}

function scrollSegmentListToIndex(index) {
  const list = el.segmentList;
  const card = list?.querySelector(`[data-segment-index="${index}"]`);
  if (!list || !card) return;
  let container = list.parentElement;
  while (container && container !== document.body) {
    const style = window.getComputedStyle(container);
    const canScroll = /(auto|scroll)/.test(style.overflowY)
      && container.scrollHeight > container.clientHeight + 2;
    if (canScroll) break;
    container = container.parentElement;
  }
  if (!container || container === document.body) return;
  const containerRect = container.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const margin = 12;
  if (cardRect.top < containerRect.top + margin) {
    container.scrollTo({ top: Math.max(0, container.scrollTop + cardRect.top - containerRect.top - margin), behavior: "auto" });
  } else if (cardRect.bottom > containerRect.bottom - margin) {
    container.scrollTo({ top: Math.max(0, container.scrollTop + cardRect.bottom - containerRect.bottom + margin), behavior: "auto" });
  }
}

function scrollTimelineToIndex(index) {
  if (!el.timelineCanvas || isTimelineScrubbing) return;
  const clip = el.timelineCanvas.querySelector(`[data-timeline-segment-index="${index}"]`);
  if (!clip) return;
  const clipLeft = clip.offsetLeft;
  const clipCenter = clipLeft + clip.offsetWidth / 2;
  const targetLeft = Math.max(0, clipCenter - el.timelineCanvas.clientWidth / 2);
  el.timelineCanvas.scrollTo({ left: targetLeft, behavior: "smooth" });
}

function focusFirstSegmentAfterDraftRender() {
  state.selectedSegmentIndex = 0;
  state.expandedScenePickerIndex = -1;
  lastPreviewSyncIndex = -1;
  suppressPreviewSyncUntil = Date.now() + 1200;
  if (el.previewPlayer) {
    el.previewPlayer.pause();
    try {
      el.previewPlayer.currentTime = 0;
    } catch (_error) {
      // Browser can reject seeking before metadata is ready; the UI focus still resets below.
    }
  }
  updateActiveSegmentDom(0);
  updateTimelinePlayhead(0);
  updatePreviewSubtitleOverlay();
  if (el.dialogueTab) {
    el.dialogueTab.scrollTo({ top: 0, behavior: "auto" });
  }
  if (el.timelineCanvas) {
    el.timelineCanvas.scrollTo({ left: 0, behavior: "auto" });
  }
  renderInspector();
}

function syncPreviewToCurrentSegment(seconds = el.previewPlayer?.currentTime || 0, { force = false } = {}) {
  if (Date.now() < suppressPreviewSyncUntil) return;
  if (!state.currentProject || isTimelineScrubbing) return;
  const index = getPreviewSegmentIndexAtTime(seconds);
  if (index < 0 || (index === lastPreviewSyncIndex && !force)) return;
  lastPreviewSyncIndex = index;
  state.selectedSegmentIndex = index;
  updateActiveSegmentDom(index);
  scrollSegmentListToIndex(index);
  scrollTimelineToIndex(index);
}

function pinPreviewSegmentSelection(index, durationMs = 1200) {
  state.selectedSegmentIndex = index;
  lastPreviewSyncIndex = index;
  suppressPreviewSyncUntil = Date.now() + durationMs;
  updateActiveSegmentDom(index);
}

function selectPreviewSegment(index, { autoplay = false } = {}) {
  const segment = getSegments()[index];
  if (!segment) return;
  const previewEntry = getPreviewTimelineEntry(index);
  const target = Number(previewEntry?.startSec ?? getSegmentTimelineStart(segment, index, getSegments()));
  pinPreviewSegmentSelection(index);
  previewScene(target, autoplay, { suppressSync: true });
  renderStudio();
}

function seekTimeline(seconds, autoplay = false, { suppressSync = false } = {}) {
  if (!el.previewPlayer?.src) {
    return;
  }
  if (suppressSync) {
    suppressPreviewSyncUntil = Date.now() + 1200;
  }
  const duration = Number(el.previewPlayer.duration || 0);
  const target = Math.max(0, duration ? Math.min(duration, Number(seconds || 0)) : Number(seconds || 0));
  el.previewPlayer.currentTime = target;
  updateTimelinePlayhead(target);
  updatePreviewSubtitleOverlay();
  if (!suppressSync) {
    syncPreviewToCurrentSegment(target, { force: true });
  }
  if (autoplay) {
    el.previewPlayer.play().catch(() => {});
  }
}

async function applySceneChoice(index) {
  const key = state.pendingSceneChoices[index];
  if (!key || !state.currentProject) {
    showToast("Chưa chọn cảnh thay thế.");
    return;
  }
  const scenes = getRelatedScenes(getSegments()[index] || {}, index);
  const selected = scenes.find((scene) => `${scene.sceneId}:${Number(scene.startSec || 0).toFixed(2)}` === key);
  if (!selected) {
    showToast("Không tìm thấy cảnh đã chọn.");
    return;
  }
  const segments = getSegments().map((segment, segmentIndex) => {
    if (segmentIndex !== index) return segment;
    const duration = Math.max(0.4, Number(selected.endSec || 0) - Number(selected.startSec || 0));
    return {
      ...segment,
      sceneId: selected.sceneId,
      startSec: Number(selected.startSec || 0),
      endSec: Number(selected.endSec || selected.startSec + duration),
      clipDuration: duration,
      renderDuration: Number(segment.renderDuration || duration),
      metadataSummary: {
        ...(segment.metadataSummary || {}),
        sceneId: selected.sceneId,
        audioTranscript: selected.audioTranscript || selected.evidence || segment.metadataSummary?.audioTranscript || "",
        localVisualTags: selected.localVisualTags || segment.metadataSummary?.localVisualTags || [],
        motionIntensity: selected.motionIntensity || segment.metadataSummary?.motionIntensity || "",
        audioEnergy: selected.audioEnergy || segment.metadataSummary?.audioEnergy || "",
        lightChange: selected.lightChange || segment.metadataSummary?.lightChange || ""
      },
      visualEvidence: selected.visualEvidence || selected.evidence || segment.visualEvidence || "",
      reason: selected.reason || selected.evidence || segment.reason || ""
    };
  });
  state.currentProject = await window.cineviral.updateProjectPlan(
    state.currentProject.id,
    buildAnalysisWithActiveHighlightSegments(state.currentProject.analysis || {}, segments)
  );
  delete state.pendingSceneChoices[index];
  state.expandedScenePickerIndex = -1;
  previewScene(selected.startSec, false);
  showToast(`Đã đổi sang ${selected.sceneId}.`);
  renderStudio();
}

async function removeSegment(index) {
  if (!state.currentProject) return;
  const segments = getSegments();
  if (segments.length <= 1) {
    showToast("Không thể xóa đoạn cuối cùng.");
    return;
  }
  const confirmed = await showConfirmAction({
    title: "Xóa đoạn khỏi timeline?",
    message: `Đoạn #${index + 1} sẽ bị xóa khỏi kịch bản hiện tại.`,
    confirmLabel: "Xóa đoạn"
  });
  if (!confirmed) return;
  const nextSegments = segments.filter((_segment, segmentIndex) => segmentIndex !== index);
  state.currentProject = await window.cineviral.updateProjectPlan(
    state.currentProject.id,
    buildAnalysisWithActiveHighlightSegments(state.currentProject.analysis || {}, nextSegments)
  );
  state.selectedSegmentIndex = Math.max(0, Math.min(index, nextSegments.length - 1));
  state.expandedScenePickerIndex = -1;
  showToast("Đã xóa đoạn.");
  renderStudio();
}

function hydrateSegmentScenePreviews() {
  document.querySelectorAll("video[data-scene-preview]").forEach((video) => {
    const start = Number(video.dataset.startSec || 0);
    const seek = () => {
      try {
        if (Number.isFinite(start) && Math.abs((video.currentTime || 0) - start) > 0.25) {
          video.currentTime = Math.max(0, start);
        }
      } catch (_error) {
        // Some codecs delay seekability until more metadata is available.
      }
    };
    video.addEventListener("loadedmetadata", seek, { once: true });
    video.addEventListener("seeked", () => video.pause(), { once: true });
    if (video.readyState >= 1) seek();
  });
}

function getHighlightSegmentText(segment) {
  const voiceText = getHighlightVoiceText(segment);
  if (!voiceText) {
    return segment.caption || segment.translatedText || segment.text || "";
  }
  return voiceText;
}

function getSegmentScriptText(segment) {
  if (isHighlightCutProject()) {
    return getHighlightSegmentText(segment);
  }
  if (state.currentProject?.mode === "recap") {
    return segment.narrationLine || segment.subtitleText || segment.reason || "";
  }
  return segment.dubbingLine || segment.translatedText || segment.text || "";
}

async function copyTextToClipboard(text) {
  const value = String(text || "").trim();
  if (!value) {
    showToast("Cảnh này chưa có kịch bản để copy.");
    return false;
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return true;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
  return true;
}

function estimateSpeechSeconds(text) {
  return String(text || "").split(/\s+/).filter(Boolean).length / DEFAULT_WORDS_PER_SECOND;
}

function getHighlightVoiceText(segment) {
  const requestedAudioMode = segment.requestedAudioMode || segment.audio_mode || segment.audioMode || "";
  return segment.voiceoverText || segment.dubbingLine || (requestedAudioMode && requestedAudioMode !== "original_audio" ? segment.text : "") || "";
}

function getSegmentVoiceLabel(segment, isHighlight = false) {
  if (isHighlight && !getHighlightVoiceText(segment)) {
    return "Âm gốc";
  }
  const provider = state.currentProject?.voiceProvider || state.settings?.defaultVoiceProvider || "";
  const voiceId = state.currentProject?.voiceId || state.settings?.defaultVoiceId || "";
  const labels = {
    elevenlabs: voiceId ? `ElevenLabs · ${voiceId}` : "ElevenLabs",
    edge_neural: segment.voiceName || segment.voice || "Edge Neural",
    windows_local: segment.voiceName || segment.voice || "Windows Voice",
    omnivoice: segment.voiceName || segment.voice || "OmniVoice",
    kokoro: segment.voiceName || segment.voice || (voiceId ? `Kokoro · ${voiceId}` : "Kokoro")
  };
  return labels[provider] || segment.voiceName || segment.voice || provider || "Voice";
}

function getSegmentVoiceTimingLabel(segment, text, timelineDuration, isHighlight = false) {
  if (isHighlight && !getHighlightVoiceText(segment)) {
    return `âm gốc 100% / timeline ${fmt(timelineDuration, 1)}s`;
  }
  if (segment.fastDraftVoiceStatus === "stale") {
    return "voice cần đo lại / render nháp";
  }
  if (Number(segment.fastDraftVoiceSec) > 0 && Number(segment.fastDraftTimelineSec) > 0) {
    const ratio = Number(segment.fastDraftFitRatio || 0);
    const status = segment.fastDraftVoiceStatus && segment.fastDraftVoiceStatus !== "ok"
      ? ` · ${segment.fastDraftVoiceStatus}`
      : "";
    return `voice ${fmt(segment.fastDraftVoiceSec, 1)}s / timeline ${fmt(segment.fastDraftTimelineSec, 1)}s / ${fmt(ratio, 2)}${status}`;
  }
  const estimatedSpeech = estimateSpeechSeconds(text);
  return `voice ~${fmt(estimatedSpeech, 1)}s / timeline ${fmt(timelineDuration, 1)}s`;
}

function getHighlightPlanSummary(segment) {
  const sourceStart = Number(segment.sourceStartSec ?? segment.sourceStart ?? segment.inputStartSec);
  const sourceEnd = Number(segment.sourceEndSec ?? segment.sourceEnd ?? segment.inputEndSec);
  const hasVoice = Boolean(getHighlightVoiceText(segment));
  const parts = [];
  if (Number.isFinite(sourceStart) && Number.isFinite(sourceEnd) && sourceEnd > sourceStart) {
    const sourceDuration = sourceEnd - sourceStart;
    const outputDuration = Number(segment.duration ?? (((segment.endSec || 0) - (segment.startSec || 0)) || sourceDuration));
    const playbackSpeed = Number(segment.playbackSpeed || (sourceDuration / Math.max(0.2, outputDuration)));
    parts.push(`Nguồn ${fmt(sourceStart, 1)}s-${fmt(sourceEnd, 1)}s`);
    parts.push(`output ${fmt(outputDuration, 1)}s`);
    if (Number.isFinite(playbackSpeed) && Math.abs(playbackSpeed - 1) > 0.02) {
      parts.push(`speed ${fmt(playbackSpeed, 2)}x`);
    }
  }
  parts.push(hasVoice ? "có voice: âm gốc 0%" : "không voice: âm gốc 100%");
  const previewVi = segment.preview_vi || segment.previewVi || segment.previewSubtitleVi || "";
  if (previewVi) {
    parts.push(`preview_vi: ${previewVi}`);
  }
  const caption = segment.caption || segment.translatedText || "";
  const displayText = getHighlightSegmentText(segment);
  if (caption && caption !== displayText) {
    parts.push(`caption: ${caption}`);
  }
  if (segment.actionNotes || segment.originalText) {
    parts.push(segment.actionNotes || segment.originalText);
  }
  return parts.filter(Boolean).join(" · ");
}

function renderSegments(segments) {
  if (!segments.length) {
    el.segmentList.innerHTML = `<div class="field-card">Chưa có phân đoạn. Hãy nạp video trước.</div>`;
    return;
  }

  const scenePreviewUrl = toFileUrl(getPreviewVideoPath());
  el.segmentList.innerHTML = segments.map((segment, index) => {
    const isHighlight = isHighlightCutProject();
    const active = index === state.selectedSegmentIndex ? "active" : "";
    const expanded = state.expandedScenePickerIndex === index;
    const text = getSegmentScriptText(segment);
    const originalText = isHighlight
      ? getHighlightPlanSummary(segment)
      : state.currentProject?.mode === "recap"
        ? ""
        : state.currentProject?.mode === "satisfying_storytime"
          ? (segment.originalText || segment.text || "")
          : (segment.text || segment.originalText || "");
    const sourceLabel = isHighlight ? "Plan" : "Gốc";
    const scene = getSegmentSceneMeta(segment, index);
    const evidence = scene.evidence ? scene.evidence.slice(0, 170) : "Chưa có bằng chứng hình ảnh cho cảnh này.";
    const relatedScenes = getRelatedScenes(segment, index);
    const chosenSceneKey = state.pendingSceneChoices[index] || `${scene.sceneId}:${Number(scene.start || 0).toFixed(2)}`;
    const timelineDuration = getSegmentTimelineDuration(segment);
    const voiceLabel = getSegmentVoiceLabel(segment, isHighlight);
    const voiceTimingLabel = getSegmentVoiceTimingLabel(segment, text, timelineDuration, isHighlight);
    const review = segment.aiSceneReview || null;
    const isReviewing = state.reviewingSegmentIndex === index;
    const reviewStatus = getSegmentReviewStatus({ review, text, isReviewing });
    const technicalSceneCount = Array.isArray(segment.technicalSegments)
      ? segment.technicalSegments.length
      : Array.isArray(segment.sceneIds)
        ? segment.sceneIds.length
        : 1;
    const storyBlockTag = state.currentProject?.analysisWorkflow === "manual_gemini_story_recut"
      ? `<span class="story-block-tag">Khối truyện · ${technicalSceneCount} scene</span>`
      : "";
    return `
      <article class="segment-card ${active}" data-segment-index="${index}">
        <div class="segment-head">
          <div class="segment-head-main">
            <strong>#${index + 1}</strong>
            <span class="speaker-tag">${escapeHtml(segment.speaker || "SPEAKER_00")}</span>
            <span class="voice-tag">${escapeHtml(voiceLabel)}</span>
            ${storyBlockTag}
            <span class="time-tag">${fmt(segment.startSec, 1)}s (${fmt((segment.endSec || 0) - (segment.startSec || 0), 1)}s)</span>
          </div>
          <div class="segment-actions">
            <button type="button" class="icon-mini" title="Xem đoạn" data-jump-segment="${index}">▶</button>
            <button type="button" class="icon-mini" title="Đổi cảnh" data-toggle-scenes="${index}">↻</button>
            <button type="button" class="icon-mini" title="Copy kịch bản" data-copy-segment="${index}">⧉</button>
            <button type="button" class="icon-mini" title="Sửa lời thoại" data-edit-segment="${index}">✎</button>
            <button type="button" class="icon-mini danger" title="Xóa đoạn" data-remove-segment="${index}">⌫</button>
          </div>
        </div>
        <div class="segment-review-status review-${escapeHtml(reviewStatus.className)}">
          <span>${escapeHtml(reviewStatus.label)}</span>
          <small>${escapeHtml(reviewStatus.detail)}</small>
        </div>
        <p class="segment-text">${escapeHtml(text)}</p>
        ${originalText ? `<p class="segment-source-text"><span>${sourceLabel}</span>${escapeHtml(originalText)}</p>` : state.currentProject?.mode === "satisfying_storytime" ? `<p class="segment-source-text"><span>Gốc</span>Chưa có transcript gốc. Hãy chọn SRT hoặc bật Whisper trong cài đặt.</p>` : ""}
        <div class="segment-flags">
          <span class="flag">${escapeHtml(voiceTimingLabel)}</span>
          ${isHighlight ? `<span class="flag">${getHighlightVoiceText(segment) ? "âm gốc tắt" : "giữ âm gốc"}</span>` : `<span class="flag">Auto-fit 0.75x</span>`}
        </div>
        <div class="segment-scene-strip">
          <span>${state.currentProject?.analysisWorkflow === "manual_gemini_story_recut" ? `Khối truyện ${index + 1} · ${technicalSceneCount} scene nguồn` : `Cảnh ${index}`}</span>
          <button type="button" class="mini-button" data-toggle-scenes="${index}">${expanded ? "Đóng" : "Đổi cảnh"}</button>
        </div>
        <div class="segment-scene-preview ${expanded ? "" : "collapsed"}">
          <div class="scene-main-preview" data-scene-preview-click="${index}" data-start-sec="${scene.start}">
            ${scenePreviewUrl ? `<video muted playsinline preload="metadata" data-scene-preview data-start-sec="${scene.start}" src="${escapeHtml(scenePreviewUrl)}"></video>` : `<div class="scene-thumb-placeholder">Chưa có video</div>`}
            <span>${escapeHtml(scene.sceneId)} - di chuột lên thumbnail để xem</span>
          </div>
          <div class="scene-meta">
            <div class="scene-meta-top">
              <span>${escapeHtml(scene.sceneId)}</span>
              <span>${fmt(scene.start, 2)}s - ${fmt(scene.end, 2)}s</span>
            </div>
            <strong>${escapeHtml(scene.beat || "nhịp hình ảnh")}${scene.event ? ` · ${escapeHtml(scene.event)}` : ""}</strong>
            <p>${escapeHtml(evidence)}</p>
            <button type="button" class="mini-button" data-jump-segment="${index}">Xem cảnh</button>
          </div>
          <div class="scene-choice-grid">
            ${relatedScenes.map((candidate, candidateIndex) => {
              const key = `${candidate.sceneId}:${Number(candidate.startSec || 0).toFixed(2)}`;
              const selected = key === chosenSceneKey || (!state.pendingSceneChoices[index] && candidateIndex === 0);
              return `
                <button type="button" class="scene-choice ${selected ? "selected" : ""}" data-select-scene="${index}" data-scene-key="${escapeHtml(key)}" data-start-sec="${candidate.startSec}" data-end-sec="${candidate.endSec}">
                  <span class="scene-choice-thumb">
                    ${scenePreviewUrl ? `<video muted playsinline preload="metadata" data-scene-preview data-start-sec="${candidate.startSec}" src="${escapeHtml(scenePreviewUrl)}"></video>` : `<i>no video</i>`}
                  </span>
                  <small>#${candidateIndex + 1} · ${fmt(candidate.duration, 0)}s</small>
                </button>
              `;
            }).join("")}
          </div>
          <div class="scene-picker-footer">
            <span>Cảnh liên quan tới lời thoại - ấn thumbnail để xem, rồi áp dụng nếu đúng.</span>
            <div class="button-row">
              <button type="button" class="secondary-button compact" data-clear-scene-choice="${index}">Bỏ hết</button>
              <button type="button" class="primary-button compact" data-apply-scene-choice="${index}">Áp dụng</button>
            </div>
          </div>
        </div>
      </article>
    `;
  }).join("");

  document.querySelectorAll("[data-segment-index]").forEach((card) => {
    card.addEventListener("click", (event) => {
      const selection = window.getSelection?.();
      if (String(selection || "").trim()) return;
      selectPreviewSegment(Number(card.dataset.segmentIndex));
    });
  });
  document.querySelectorAll("[data-jump-segment]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const index = Number(button.dataset.jumpSegment);
      selectPreviewSegment(index, { autoplay: true });
    });
  });
  document.querySelectorAll("[data-toggle-scenes]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const index = Number(button.dataset.toggleScenes);
      pinPreviewSegmentSelection(index);
      state.expandedScenePickerIndex = state.expandedScenePickerIndex === index ? -1 : index;
      renderStudio();
    });
  });
  document.querySelectorAll("[data-select-scene]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const index = Number(button.dataset.selectScene);
      state.pendingSceneChoices[index] = button.dataset.sceneKey;
      previewScene(button.dataset.startSec, false, { suppressSync: true });
      renderStudio();
    });
    button.addEventListener("mouseenter", () => previewScene(button.dataset.startSec, false, { suppressSync: true }));
  });
  document.querySelectorAll("[data-scene-preview-click]").forEach((node) => {
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      previewScene(node.dataset.startSec, true, { suppressSync: true });
    });
  });
  document.querySelectorAll("[data-clear-scene-choice]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      delete state.pendingSceneChoices[Number(button.dataset.clearSceneChoice)];
      renderStudio();
    });
  });
  document.querySelectorAll("[data-apply-scene-choice]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const index = Number(button.dataset.applySceneChoice);
      await applySceneChoice(index);
    });
  });
  document.querySelectorAll("[data-edit-segment]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      state.selectedSegmentIndex = Number(button.dataset.editSegment);
      renderStudio();
      el.inspectText?.focus();
      el.inspectText?.select();
    });
  });
  document.querySelectorAll("[data-copy-segment]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const segment = getSegments()[Number(button.dataset.copySegment)];
      try {
        const copied = await copyTextToClipboard(segment ? getSegmentScriptText(segment) : "");
        if (copied) showToast("Đã copy kịch bản cảnh.");
      } catch (error) {
        showToast(`Không copy được kịch bản: ${error.message}`);
      }
    });
  });
  document.querySelectorAll("[data-remove-segment]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      await removeSegment(Number(button.dataset.removeSegment));
    });
  });
  hydrateSegmentScenePreviews();
}

async function reviewAllScenesFromSegmentList() {
  if (!state.currentProject) return;
  if (!["recap", "satisfying_storytime", "highlight_cut"].includes(state.currentProject.mode)) {
    showToast("AI đánh giá toàn bộ cảnh hiện hỗ trợ Tóm tắt phim, Storytime và Highlight Cut.");
    return;
  }
  const totalSegments = getSegments().length;
  if (!totalSegments) {
    showToast("Chưa có đoạn kịch bản nào để đánh giá.");
    return;
  }
  setBusy(true);
  const buttons = [el.reviewAllScenesLeft, el.reviewAllScenes].filter(Boolean);
  const originalTexts = new Map(buttons.map((button) => [button, button.textContent]));
  try {
    await saveCurrentSegments();
    addLog(`AI bắt đầu đánh giá toàn bộ ${totalSegments} cảnh trong kịch bản...`);
    for (let index = 0; index < totalSegments; index += 1) {
      state.selectedSegmentIndex = index;
      state.reviewingSegmentIndex = index;
      buttons.forEach((button) => {
        button.textContent = `Đang đánh giá ${index + 1}/${totalSegments}`;
      });
      renderStudio();
      addLog(`AI đang đánh giá cảnh ${index + 1}/${totalSegments}...`);
      state.currentProject = await window.cineviral.reviewSceneScript(state.currentProject.id, index);
    }
    state.reviewingSegmentIndex = -1;
    renderStudio();
    addLog("Đã hoàn tất đánh giá toàn bộ cảnh bằng AI.");
    showToast("Đã đánh giá toàn bộ cảnh trong kịch bản.");
  } catch (error) {
    addLog(error.message, "ERROR");
    showToast(error.message);
  } finally {
    state.reviewingSegmentIndex = -1;
    buttons.forEach((button) => {
      button.textContent = originalTexts.get(button) || "AI đánh giá toàn bộ cảnh";
    });
    setBusy(false);
    renderStudio();
  }
}

async function applyAllRewriteSuggestions() {
  if (!state.currentProject || !["recap", "satisfying_storytime", "highlight_cut"].includes(state.currentProject.mode)) {
    showToast("Chỉ áp dụng viết lại hàng loạt trong chế độ Tóm tắt phim, Storytime và Highlight Cut.");
    return;
  }
  const isHighlight = state.currentProject.mode === "highlight_cut";
  const isStorytime = state.currentProject.mode === "satisfying_storytime";
  const segments = getSegments();
  let appliedCount = 0;
  const nextSegments = segments.map((segment) => {
    const review = segment.aiSceneReview || null;
    const rewrite = review?.rewriteSuggestion || null;
    const shouldApply = Boolean(rewrite?.narrationLine)
      && (review?.verdict === "needs_rewrite" || rewrite.shouldApply);
    if (!shouldApply) {
      return segment;
    }
    appliedCount += 1;
    const narrationLine = rewrite.narrationLine.trim();
    if (isHighlight) {
      const currentAudioMode = segment.audioMode || segment.audio_mode || "";
      const requestedAudioMode = segment.requestedAudioMode || segment.audio_mode || segment.audioMode || "";
      const hasVoice = Boolean(getHighlightVoiceText(segment));
      if (currentAudioMode === "original_audio" && !hasVoice && (!requestedAudioMode || requestedAudioMode === "original_audio")) {
        return {
          ...segment,
          caption: rewrite.subtitleText || narrationLine,
          translatedText: rewrite.subtitleText || narrationLine,
          text: rewrite.subtitleText || narrationLine,
          aiSceneReview: markReviewRewriteApplied(review, narrationLine)
        };
      }
      return clearVoicePreflightForTextChange({
        ...segment,
        audioMode: "voiceover_only",
        sourceVolume: 0,
        voiceoverText: narrationLine,
        dubbingLine: narrationLine,
        text: narrationLine,
        subtitleText: rewrite.subtitleText || segment.subtitleText || segment.caption || "",
        aiSceneReview: markReviewRewriteApplied(review, narrationLine)
      });
    }
    if (isStorytime) {
      return clearVoicePreflightForTextChange({
        ...segment,
        dubbingLine: narrationLine,
        storyText: narrationLine,
        text: narrationLine,
        translatedText: rewrite.subtitleText || segment.translatedText || segment.caption || narrationLine,
        aiSceneReview: markReviewRewriteApplied(review, narrationLine)
      });
    }
    return {
      ...segment,
      narrationLine,
      subtitleText: rewrite.subtitleText || narrationLine,
      aiSceneReview: markReviewRewriteApplied(review, narrationLine)
    };
  });

  if (!appliedCount) {
    showToast("Không có cảnh nào cần áp dụng câu viết lại.");
    return;
  }

  setBusy(true);
  try {
    if (isStorytime) {
      state.currentProject = await window.cineviral.updateDubbingSegments(state.currentProject.id, nextSegments);
    } else {
      state.currentProject = await window.cineviral.updateProjectPlan(
        state.currentProject.id,
        buildAnalysisWithActiveHighlightSegments(state.currentProject.analysis || {}, nextSegments)
      );
    }
    addLog(`Đã áp dụng câu viết lại cho ${appliedCount} cảnh cần chỉnh.`);
    showToast(`Đã áp dụng viết lại cho ${appliedCount} cảnh.`);
    renderStudio();
  } catch (error) {
    addLog(error.message, "ERROR");
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

function renderSceneReview(segment) {
  if (!el.sceneReviewBox || !el.applySceneRewrite) {
    return;
  }
  const review = segment?.aiSceneReview;
  if (!review) {
    el.sceneReviewBox.className = "scene-review-box muted";
    el.sceneReviewBox.innerHTML = "Chưa có đánh giá cho cảnh này.";
    el.applySceneRewrite.classList.add("hidden");
    return;
  }

  const verdict = review.verdict || "warning";
  const scores = review.scores || {};
  const timing = review.voiceTiming || {};
  const issues = Array.isArray(review.issues) ? review.issues : [];
  const rewrite = review.rewriteSuggestion || {};
  const hasRewrite = Boolean(rewrite.narrationLine);
  el.sceneReviewBox.className = `scene-review-box verdict-${escapeHtml(verdict)}`;
  el.sceneReviewBox.innerHTML = `
    <div class="review-verdict">
      <span>${escapeHtml(verdict.replace("_", " "))}</span>
      <small>${escapeHtml(review.sceneId || "")}</small>
    </div>
    <p>${escapeHtml(review.summary || "")}</p>
    <div class="review-score-grid">
      <span>Scene <strong>${fmt(scores.sceneMatch || 0, 1)}</strong></span>
      <span>Cốt truyện <strong>${fmt(scores.storyCoherence || 0, 1)}</strong></span>
      <span>Giọng <strong>${fmt(scores.voiceFit || 0, 1)}</strong></span>
      <span>Bằng chứng <strong>${fmt(scores.evidenceSupport || 0, 1)}</strong></span>
    </div>
    <div class="review-timing">Giọng ~${fmt(timing.estimatedSpeechSec || 0, 2)}s / Cảnh ${fmt(timing.sceneDurationSec || 0, 2)}s / Tỷ lệ ${fmt(timing.fitRatio || 0, 2)}</div>
    ${issues.length ? `<div class="review-issues">${issues.map((issue) => `
      <div class="review-issue ${escapeHtml(issue.severity || "warning")}">
        <strong>${escapeHtml(issue.code || "ghi chú")}</strong>
        <span>${escapeHtml(issue.message || "")}</span>
      </div>
    `).join("")}</div>` : `<div class="review-issue pass"><strong>Ổn</strong><span>Không có lỗi lớn.</span></div>`}
    ${hasRewrite ? `
      <div class="rewrite-suggestion">
        <strong>Câu viết lại đề xuất</strong>
        <p>${escapeHtml(rewrite.narrationLine)}</p>
        ${rewrite.reason ? `<small>${escapeHtml(rewrite.reason)}</small>` : ""}
      </div>
    ` : ""}
  `;
  el.applySceneRewrite.classList.toggle("hidden", !hasRewrite);
}

function renderInspector() {
  const segment = getSegments()[state.selectedSegmentIndex] || null;
  if (!segment) {
    if (el.inspectStart) el.inspectStart.textContent = "0.000";
    if (el.inspectEnd) el.inspectEnd.textContent = "0.000";
    if (el.inspectDuration) el.inspectDuration.textContent = "0.000s";
    if (el.inspectText) el.inspectText.value = "";
    if (el.inspectSpeaker) el.inspectSpeaker.value = "SPEAKER_00";
    if (el.inspectSpeed) el.inspectSpeed.value = "1";
    if (el.inspectVolume) el.inspectVolume.value = "100";
    inspectorState.segmentIndex = -1;
    inspectorState.text = "";
    inspectorState.speaker = "";
    renderSceneReview(null);
    return;
  }
  if (el.inspectStart) el.inspectStart.textContent = fmt(segment.startSec);
  if (el.inspectEnd) el.inspectEnd.textContent = fmt(segment.endSec);
  if (el.inspectDuration) el.inspectDuration.textContent = `${fmt((segment.endSec || 0) - (segment.startSec || 0))}s`;
  const inspectorText = isHighlightCutProject()
    ? getHighlightSegmentText(segment)
    : state.currentProject?.mode === "recap"
      ? (segment.narrationLine || segment.subtitleText || "")
      : (segment.dubbingLine || segment.translatedText || segment.text || "");
  if (el.inspectText) el.inspectText.value = inspectorText;
  if (el.inspectSpeaker) {
    const speaker = segment.speaker || "SPEAKER_00";
    if (![...el.inspectSpeaker.options].some((option) => option.value === speaker)) {
      const option = document.createElement("option");
      option.value = speaker;
      option.textContent = speaker;
      el.inspectSpeaker.appendChild(option);
    }
    el.inspectSpeaker.value = speaker;
    inspectorState.speaker = speaker;
  }
  if (el.inspectSpeed) el.inspectSpeed.value = String(segment.voiceSpeed || state.currentProject?.voiceSpeed || 1);
  if (el.inspectVolume) el.inspectVolume.value = String(segment.voiceVolume || 100);
  inspectorState.segmentIndex = state.selectedSegmentIndex;
  inspectorState.text = inspectorText;
  if (!inspectorState.speaker) inspectorState.speaker = segment.speaker || "SPEAKER_00";
  renderSceneReview(segment);
}

function renderSpeakers() {
  if (!el.speakerList) return;
  const analysis = state.currentProject?.analysis || {};
  const speakers = analysis.speakers?.length
    ? analysis.speakers
    : Array.from(new Set(getSegments().map((segment) => segment.speaker).filter(Boolean))).map((id) => ({ id, voice: "giọng được tạo" }));
  el.speakerList.innerHTML = speakers.length
    ? speakers.map((speaker) => `
      <div class="speaker-item">
        <strong>${escapeHtml(speaker.id)}</strong>
        <div>${escapeHtml(speaker.voice || speaker.gender || "giọng được tạo")}</div>
      </div>
    `).join("")
    : `<div class="speaker-item">Chưa có hồ sơ giọng.</div>`;
}

function renderTimeline(segments, scenes) {
  const duration = Math.max(20, ...segments.map((segment, index) => getSegmentTimelineEnd(segment, index, segments)));
  const pxPerSec = TIMELINE_PX_PER_SEC;
  const width = Math.max(900, duration * pxPerSec);
  const scenePreviewUrl = toFileUrl(getPreviewVideoPath());
  const rulerStep = 10;
  const rulerMarks = Array.from({ length: Math.floor(duration / rulerStep) + 1 }, (_item, index) => ({
    left: index * rulerStep * pxPerSec,
    label: `00:${String(index * rulerStep).padStart(2, "0")}`
  }));
  const playheadLeft = Math.max(0, Number(el.previewPlayer.currentTime || 0) * pxPerSec);
  const useSegmentTimeline = state.currentProject?.mode === "recap" || !scenes.length;
  const sceneClips = (useSegmentTimeline ? segments : scenes).map((item, index) => ({
    left: (useSegmentTimeline ? getSegmentTimelineStart(item, index, segments) : Number(item.startSec || 0)) * pxPerSec,
    width: Math.max(46, (useSegmentTimeline ? getSegmentTimelineDuration(item) : Number(item.duration || item.endSec - item.startSec || 1)) * pxPerSec),
    label: item.sceneId || `Scene ${index + 1}`,
    startSec: Number(item.startSec || 0),
    segmentIndex: useSegmentTimeline ? index : -1
  }));
  const voiceClips = segments.map((segment, index) => ({
    index,
    left: getSegmentTimelineStart(segment, index, segments) * pxPerSec,
    width: Math.max(46, getSegmentTimelineDuration(segment) * pxPerSec),
    label: state.currentProject?.mode === "recap"
      ? (segment.narrationLine || segment.subtitleText || `Nhịp ${index + 1}`)
      : (segment.dubbingLine || segment.translatedText || segment.text || `Đoạn ${index + 1}`)
  }));

  el.timelineCanvas.innerHTML = `
    <div class="timeline-ruler" style="width:${width}px">
      ${rulerMarks.map((mark) => `<span style="left:${mark.left}px">${escapeHtml(mark.label)}</span>`).join("")}
    </div>
    <div class="timeline-playhead" style="left:${playheadLeft}px"></div>
    <div class="timeline-track" style="width:${width}px">
      ${sceneClips.map((clip) => `
        <div class="clip video timeline-video-clip" ${clip.segmentIndex >= 0 ? `data-timeline-segment-index="${clip.segmentIndex}"` : ""} style="left:${clip.left}px;width:${clip.width}px">
          ${scenePreviewUrl ? `<video muted playsinline preload="metadata" data-scene-preview data-start-sec="${clip.startSec}" src="${escapeHtml(scenePreviewUrl)}"></video>` : ""}
          <span>${escapeHtml(clip.label)}</span>
        </div>
      `).join("")}
    </div>
    <div class="timeline-track" style="width:${width}px">
      ${voiceClips.map((clip) => `<div class="clip voice" data-timeline-segment-index="${clip.index}" style="left:${clip.left}px;width:${clip.width}px">${escapeHtml(clip.label)}</div>`).join("")}
    </div>
    <div class="timeline-track" style="width:${width}px"></div>
    <div class="timeline-track" style="width:${width}px">
      ${voiceClips.map((clip) => `<div class="clip subtitle" data-timeline-segment-index="${clip.index}" style="left:${clip.left}px;width:${clip.width}px">${escapeHtml(clip.label)}</div>`).join("")}
    </div>
  `;
  updateTimelinePlayhead(el.previewPlayer.currentTime || 0);
  syncPreviewToCurrentSegment(el.previewPlayer.currentTime || 0, { force: true });
  hydrateSegmentScenePreviews();
}

function getFailedSceneRewriteCount(project = state.currentProject) {
  return getSegments(project).filter((segment) => {
    const review = segment.aiSceneReview || null;
    if (!review) return false;
    if (review.verdict === "needs_rewrite") return true;
    const issues = Array.isArray(review.issues) ? review.issues : [];
    return issues.some((issue) => /voice|timing|silent|sparse|too_short|too_long|mismatch/i.test(`${issue.code || ""} ${issue.message || ""}`));
  }).length;
}

async function rewriteFailedScenesWithAi() {
  if (!state.currentProject || !["recap", "satisfying_storytime", "highlight_cut"].includes(state.currentProject.mode)) {
    showToast("AI viết lại cảnh lỗi hiện hỗ trợ Tóm tắt phim, Storytime và Highlight Cut.");
    return;
  }
  const failedCount = getFailedSceneRewriteCount();
  if (!failedCount) {
    showToast("Chưa có cảnh lỗi để viết lại. Hãy bấm AI đánh giá toàn bộ cảnh trước.");
    return;
  }
  setBusy(true);
  const originalText = el.rewriteFailedScenes?.textContent || "AI viết lại cảnh lỗi";
  try {
    await saveCurrentSegments();
    if (el.rewriteFailedScenes) el.rewriteFailedScenes.textContent = `Đang viết lại ${failedCount} cảnh...`;
    addLog(`AI đang tổng hợp ${failedCount} cảnh lỗi để viết lại đồng bộ...`);
    state.currentProject = await window.cineviral.rewriteFailedScenes(state.currentProject.id);
    renderStudio();
    addLog("AI đã tạo đề xuất viết lại cho các cảnh lỗi. Hãy kiểm tra rồi bấm áp dụng nếu ổn.");
    showToast("Đã tạo đề xuất viết lại cho các cảnh lỗi.");
  } catch (error) {
    addLog(error.message, "ERROR");
    showToast(error.message);
  } finally {
    if (el.rewriteFailedScenes) el.rewriteFailedScenes.textContent = originalText;
    setBusy(false);
  }
}


function fmtTimecode(value) {
  const total = Math.max(0, Number(value || 0));
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  const millis = Math.floor((total - Math.floor(total)) * 1000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

async function refreshProjects() {
  state.projects = await window.cineviral.listProjects();
  renderProjectPicker();
}

function renderMirrorMeta(meta = null) {
  if (!el.mirrorMeta) return;
  if (!meta) {
    el.mirrorMeta.textContent = "Sẵn sàng xử lý MP4, MOV, MKV, AVI hoặc WEBM.";
    return;
  }
  const size = meta.width && meta.height ? `${meta.width} x ${meta.height}` : "Không rõ kích thước";
  const audio = meta.hasAudio ? "có âm thanh" : "không có âm thanh";
  el.mirrorMeta.textContent = `${size} · ${fmt(meta.duration || 0, 1)}s · ${audio}`;
}

async function selectMirrorVideo() {
  const selected = await window.cineviral.pickVideo();
  if (!selected || !el.mirrorVideoPath) return;
  el.mirrorVideoPath.value = selected;
  el.mirrorResult?.classList.add("hidden");
  el.mirrorPreview?.classList.add("hidden");
  el.mirrorPreview?.removeAttribute("src");
  addLog(`Đã chọn video cho tool lật gương: ${selected}`);
  try {
    const meta = await window.cineviral.probeVideo(selected);
    renderMirrorMeta(meta);
  } catch (error) {
    renderMirrorMeta(null);
    addLog(`Không thể đọc thông tin video: ${error.message}`, "WARNING");
  }
}

async function runMirrorTool() {
  if (!el.mirrorVideoPath) return;
  const inputPath = el.mirrorVideoPath.value.trim();
  const intervalSec = Number(el.mirrorInterval?.value || 3);
  if (!inputPath) {
    showToast("Hãy chọn video trước.");
    return;
  }
  if (!Number.isFinite(intervalSec) || intervalSec < 0.5) {
    showToast("Số giây mỗi lần lật cần từ 0.5 trở lên.");
    return;
  }

  setBusy(true);
  state.activeOperation = "Đang lật gương";
  setExportProgress(8, "Đang chuẩn bị video");
  el.mirrorResult.classList.add("hidden");
  try {
    const saved = await window.cineviral.saveSettings(readSettings());
    state.settings = saved.settings;
    setExportProgress(35, "FFmpeg đang xử lý");
    addLog(`Đang tạo video lật gương mỗi ${intervalSec}s...`);
    const result = await window.cineviral.createMirrorFlipVideo({ inputPath, intervalSec });
    setExportProgress(100, "Đã tạo video");
    el.mirrorPreview.src = toFileUrl(result.outputPath);
    el.mirrorPreview.classList.remove("hidden");
    el.mirrorResult.innerHTML = `
      <strong>Đã tạo xong:</strong>
      <span>${escapeHtml(fileName(result.outputPath))}</span>
      <button id="mirror-open-output" class="ghost-button" type="button">Mở file</button>
    `;
    el.mirrorResult.classList.remove("hidden");
    $("mirror-open-output")?.addEventListener("click", () => window.cineviral.openMirrorOutput(result.outputPath));
    addLog(`Video lật gương đã sẵn sàng: ${result.outputPath}`);
    showToast("Đã tạo xong video lật gương.");
  } catch (error) {
    addLog(error.message, "ERROR");
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

async function saveCurrentSegments() {
  if (!state.currentProject) {
    return;
  }
  const selectedIndex = state.selectedSegmentIndex;
  const inspectorText = el.inspectText?.value?.trim() || "";
  const inspectorSpeaker = el.inspectSpeaker?.value || "";
  const inspectorIsCurrent = inspectorState.segmentIndex === selectedIndex;
  const inspectorTextChanged = inspectorIsCurrent && !safeCompareText(inspectorText, inspectorState.text);
  const inspectorSpeakerChanged = inspectorIsCurrent && inspectorSpeaker && inspectorSpeaker !== inspectorState.speaker;
  if (!inspectorTextChanged && !inspectorSpeakerChanged) {
    return;
  }
  const segments = getSegments().map((segment, index) => {
    if (index !== selectedIndex) {
      return segment;
    }
    if (state.currentProject.mode === "recap") {
      const text = inspectorText;
      const review = segment.aiSceneReview;
      const rewriteApplied = Boolean(review?.rewriteSuggestion?.narrationLine && safeCompareText(text, review.rewriteSuggestion.narrationLine));
      return {
        ...segment,
        speaker: el.inspectSpeaker?.value || segment.speaker,
        narrationLine: text,
        subtitleText: text,
        aiSceneReview: rewriteApplied ? markReviewRewriteApplied(review, text) : review
      };
    }
    if (state.currentProject.mode === "highlight_cut") {
      const text = inspectorText;
      const audioMode = segment.audioMode || segment.audio_mode || "mixed_ducking";
      if (audioMode === "original_audio") {
        return {
          ...segment,
          speaker: el.inspectSpeaker?.value || segment.speaker,
          caption: text,
          translatedText: text,
          text
        };
      }
      const updated = {
        ...segment,
        speaker: el.inspectSpeaker?.value || segment.speaker,
        voiceoverText: text,
        dubbingLine: text,
        text
      };
      return safeCompareText(text, getHighlightVoiceText(segment)) ? updated : clearVoicePreflightForTextChange(updated);
    }
    const nextText = inspectorText;
    const updated = {
      ...segment,
      speaker: el.inspectSpeaker?.value || segment.speaker,
      translatedText: nextText,
      dubbingLine: nextText,
      text: segment.text || nextText
    };
    const previousVoiceText = state.currentProject.mode === "satisfying_storytime"
      ? (segment.dubbingLine || segment.storyText || segment.text || segment.translatedText || "")
      : (segment.dubbingLine || segment.translatedText || segment.text || "");
    return safeCompareText(nextText, previousVoiceText) ? updated : clearVoicePreflightForTextChange(updated);
  });
  if (state.currentProject.mode === "recap" || state.currentProject.mode === "highlight_cut") {
    state.currentProject = await window.cineviral.updateProjectPlan(
      state.currentProject.id,
      buildAnalysisWithActiveHighlightSegments(state.currentProject.analysis || {}, segments)
    );
  } else {
    state.currentProject = await window.cineviral.updateDubbingSegments(state.currentProject.id, segments);
  }
  renderStudio();
}

async function previewCurrentSegmentVoice() {
  if (!state.currentProject) return;
  const segment = getSegments()[state.selectedSegmentIndex];
  if (!segment) {
    showToast("Chưa chọn đoạn để tạo voice.");
    return;
  }
  setBusy(true);
  state.activeOperation = "Tạo voice đoạn";
  setExportProgress(8, "Đang tạo voice cho đoạn đang chọn");
  try {
    await saveCurrentSegments();
    const result = await window.cineviral.renderSegmentVoice(state.currentProject.id, state.selectedSegmentIndex);
    addLog(`Đã tạo voice test cho đoạn ${state.selectedSegmentIndex + 1}: ${result.outputPath}`);
    showToast("Đã tạo voice đoạn này.");
  } catch (error) {
    addLog(error.message, "ERROR");
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

async function previewCurrentSegmentVideo() {
  if (!state.currentProject) return;
  if (!["satisfying_storytime", "highlight_cut"].includes(state.currentProject.mode)) {
    showToast("Render thử đoạn hiện hỗ trợ Storytime và Highlight Cut.");
    return;
  }
  const segment = getSegments()[state.selectedSegmentIndex];
  if (!segment) {
    showToast("Chưa chọn đoạn để render thử.");
    return;
  }
  setBusy(true);
  state.activeOperation = "Render thử đoạn";
  setExportProgress(8, "Đang render thử đoạn đang chọn");
  try {
    await saveCurrentSegments();
    await applyCurrentProjectSettings();
    const result = await window.cineviral.renderSegmentPreview(state.currentProject.id, state.selectedSegmentIndex);
    addLog(`Đã render thử đoạn ${state.selectedSegmentIndex + 1}${result.audioMode ? ` (${result.audioMode})` : ""}: ${result.outputPath}`);
    showToast("Đã render thử đoạn này.");
  } catch (error) {
    addLog(error.message, "ERROR");
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

async function buildCurrentAudioPlan() {
  if (!state.currentProject) return;
  setBusy(true);
  state.activeOperation = "Kiểm tra audio plan";
  setExportProgress(10, "Đang kiểm tra cache voice");
  try {
    await saveCurrentSegments();
    await applyCurrentProjectSettings();
    const plan = await window.cineviral.buildAudioPlan(state.currentProject.id);
    setExportProgress(100, "Audio plan đã sẵn sàng");
    addLog(`Audio plan: ${plan.voiceSegments}/${plan.totalSegments} đoạn có voice, ${plan.cachedVoiceSegments} đoạn dùng cache, ${plan.newVoiceSegments} đoạn cần tạo mới, ${plan.newVoiceCharacters} ký tự mới.`);
    addLog(`Audio plan đã lưu: ${plan.outputPath}`);
    showToast(`Audio plan: ${plan.cachedVoiceSegments} cache, ${plan.newVoiceSegments} cần tạo mới.`);
  } catch (error) {
    addLog(error.message, "ERROR");
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

async function renderFastDraftVideo() {
  if (!state.currentProject) return;
  if (!["satisfying_storytime", "highlight_cut"].includes(state.currentProject.mode)) {
    showToast("Render nháp nhanh hiện hỗ trợ Storytime và Highlight Cut.");
    return;
  }
  // Bug-2 fix: never render when AutoStory produced no scripts / ended failed —
  // preserve and show the original generation error instead of a generic one.
  if (state.currentProject.analysisWorkflow === "vertex_auto_story"
    && !(state.currentProject.analysis?.highlightVariants?.length)
    && ["failed", "review_failed", "render_failed", "cancelled"].includes(state.currentProject.autoStoryState?.phase)) {
    const err = state.currentProject.autoStoryState?.error
      || state.currentProject.autoStoryState?.failures?.[0]?.error
      || "AutoStory chưa tạo được kịch bản để render.";
    addLog(`Không thể render draft: ${err}`, "ERROR");
    showToast(err);
    return;
  }
  setBusy(true);
  state.activeOperation = "Render nháp nhanh";
  setExportProgress(5, "Đang chuẩn bị render nháp nhanh");
  const activeVarId = state.currentProject?.analysis?.activeVariantId || getHighlightVariants()[0]?.id;
  if (activeVarId && state.currentProject?.mode === "highlight_cut") {
    setVariantExportQueue([{
      id: activeVarId,
      status: "processing"
    }]);
  }
  try {
    await saveCurrentSegments();
    await applyCurrentProjectSettings();
    const result = await window.cineviral.renderFastDraft(state.currentProject.id);
    state.currentProject = await window.cineviral.getProject(state.currentProject.id);
    state.revisionPreviewPath = "";
    state.selectedSegmentIndex = 0;
    state.expandedScenePickerIndex = -1;
    lastPreviewSyncIndex = -1;
    if (el.previewPlayer) {
      try {
        el.previewPlayer.currentTime = 0;
      } catch (_error) {}
    }
    renderStudio();
    focusFirstSegmentAfterDraftRender();
    requestAnimationFrame(() => focusFirstSegmentAfterDraftRender());
    addLog(`Bản nháp nhanh đã sẵn sàng: ${result.outputPath}`);
    if (result.voiceWarningCount > 0) {
      addLog(`Cảnh báo voice draft: ${result.voiceWarningCount} cảnh lệch voice. Report: ${result.voiceWarningReportPath}`, "WARNING");
      addLog(`Prompt gửi Gemini để viết lại: ${result.geminiRewritePromptPath}`, "WARNING");
      showToast(`Draft có ${result.voiceWarningCount} cảnh lệch voice.`);
    } else {
      showToast("Đã render nháp nhanh.");
    }
    return result;
  } catch (error) {
    addLog(error.message, "ERROR");
    showToast(error.message);
  } finally {
    setBusy(false);
    setTimeout(() => {
      state.variantExportQueue = [];
      state.variantProgress = null;
      renderStudioVariantHub();
    }, 4000);
  }
}

async function renderAllFastDraftVariants({ skipConfirm = false } = {}) {
  if (!state.currentProject || state.currentProject.mode !== "highlight_cut") return;
  const variants = getHighlightVariants();
  if (variants.length <= 1) return;
  const confirmed = skipConfirm || await showConfirmAction({
      title: "Render nháp tất cả variant?",
      message: `Tool sẽ lần lượt render ${variants.length} variant và hiển thị trạng thái của từng variant.`,
      confirmLabel: "Render tất cả"
    });
  if (!confirmed) return;
  el.previewPlayer?.pause();
  setBusy(true);
  setRenderCancellable(true);
  state.activeOperation = "Render nháp tất cả variant";
  setExportProgress(1, "Đang render nháp tất cả Highlight variant");
  setVariantExportQueue(variants.map((variant, index) => ({
    id: variant.id,
    label: variant.label || `Variant ${index + 1}`,
    status: index === 0 ? "processing" : "waiting"
  })));
  try {
    await saveCurrentSegments();
    await applyCurrentProjectSettings();
    state.currentProject = await window.cineviral.renderHighlightDraftVariants(state.currentProject.id);
    state.revisionPreviewPath = "";
    state.selectedSegmentIndex = 0;
    state.expandedScenePickerIndex = -1;
    lastPreviewSyncIndex = -1;
    renderStudio();
    focusFirstSegmentAfterDraftRender();
    const failedCount = state.variantExportQueue.filter((item) => item.status === "failed").length;
    addLog(
      `Đã render nháp ${variants.length} Highlight variant${failedCount ? `, ${failedCount} variant lỗi` : ""}.`,
      failedCount ? "WARNING" : "INFO"
    );
    showToast(failedCount ? `Hoàn tất với ${failedCount} bản nháp lỗi.` : "Đã render nháp tất cả Highlight variant.");
    return failedCount < variants.length;
  } catch (error) {
    setVariantExportQueue(state.variantExportQueue.map((item) => (
      item.status === "processing" ? { ...item, status: "failed", error: error.message } : item
    )));
    addLog(error.message, "ERROR");
    showToast(error.message);
  } finally {
    setBusy(false);
    setTimeout(() => {
      state.variantExportQueue = [];
      state.variantProgress = null;
      renderStudioVariantHub();
    }, 4500);
  }
}

async function openDraftReviewArtifact(kind) {
  const artifacts = getDraftReviewArtifacts();
  const targetPath = kind === "report" ? artifacts.reportPath : artifacts.promptPath;
  if (!targetPath) {
    showToast("Chưa có file review. Hãy render nháp nhanh trước.");
    return;
  }
  try {
    await window.cineviral.openFile(targetPath);
    addLog(`${kind === "report" ? "Report timing" : "Prompt Gemini"}: ${targetPath}`);
  } catch (error) {
    addLog(error.message, "ERROR");
    showToast(error.message);
  }
}

async function createGeminiDraftReviewPackage() {
  if (!state.currentProject || state.currentProject.mode !== "highlight_cut") return null;
  let createdResult = null;
  setBusy(true);
  state.activeOperation = "Đang tạo gói Gemini Draft Review";
  setExportProgress(10, "Đang đóng gói video draft và timeline thật");
  try {
    await saveCurrentSegments();
    await applyCurrentProjectSettings();
    const result = await window.cineviral.createGeminiDraftReviewPackage(state.currentProject.id);
    createdResult = result;
    state.currentProject = await window.cineviral.getProject(state.currentProject.id);
    renderStudio();
    setExportProgress(100, "Gói Gemini Draft Review đã sẵn sàng");
    addLog(`Gói Lượt 2 đã sẵn sàng: ${result.reviewDir}`);
    addLog(`Gửi ${result.uploadFileCount || "tất cả"} file trong thư mục này cho một chat Gemini Pro mới (tối đa 10 file): ${result.reviewDir}`);
    addLog(`Prompt review: ${result.promptPath}`);
    showToast(`Đã tạo gói review V${result.revision}: ${result.uploadFileCount || 0}/10 file.`);
  } catch (error) {
    addLog(error.message, "ERROR");
    showToast(error.message);
  } finally {
    setBusy(false);
  }
  return createdResult;
}

async function runConfiguredDraftReview() {
  if (!state.currentProject || state.currentProject.mode !== "highlight_cut") return;
  const aiInfo = getConfiguredAiUiInfo();
  if (!aiInfo.supported) {
    showToast(aiInfo.reason);
    return;
  }
  let packagePath = getDraftReviewArtifacts().reviewPackagePath;
  const activeVariant = getActiveHighlightVariant(state.currentProject);
  const currentRevision = Math.max(1, Number(activeVariant?.revisionNumber || 1));
  const packageRevision = getDraftReviewArtifacts().reviewRevision;
  if (!packagePath || packageRevision !== currentRevision) {
    const created = await createGeminiDraftReviewPackage();
    packagePath = created?.reviewDir || "";
  }
  if (!packagePath) return;
  setBusy(true);
  const reviewModel = aiInfo.provider === "vertex_ai"
    ? (state.settings?.vertexQualityModel || "gemini-2.5-pro")
    : aiInfo.model;
  state.activeOperation = `${aiInfo.label} đang review Draft V1`;
  setExportProgress(5, state.activeOperation);
  el.cancelConfiguredDraftReview?.classList.remove("hidden");
  if (el.draftReviewStatus) el.draftReviewStatus.textContent = `Đang xem toàn bộ draft bằng ${aiInfo.label} · ${reviewModel}...`;
  try {
    const saved = await window.cineviral.saveSettings(readSettings());
    state.settings = saved.settings;
    const result = await window.cineviral.runConfiguredAiDraftReview(state.currentProject.id, packagePath);
    state.currentProject = await window.cineviral.getProject(state.currentProject.id);
    renderStudio();
    setExportProgress(100, `${result.providerLabel || aiInfo.label} đã hoàn tất review`);
    addLog(`Review Draft V${result.revision} bằng ${result.providerLabel || aiInfo.label}: ${result.resultPath}`);
    if (result.usage) {
      addLog(`Vertex AI review: ${result.usage.model} · ${result.usage.inputTokens || 0} input + ${result.usage.outputTokens || 0} output token · ước tính $${Number(result.usage.estimatedCostUsd || 0).toFixed(4)}.`);
    }
    if (result.timings) {
      addLog(
        `Thời gian Vertex review: chuẩn bị/upload ${(Number(result.timings.prepareMs || 0) / 1000).toFixed(1)}s · `
        + `model ${(Number(result.timings.modelMs || 0) / 1000).toFixed(1)}s.`
      );
    }
    showToast(`Đã tạo bản review V2 bằng ${result.providerLabel || aiInfo.label}. Hãy kiểm tra trước khi import.`);
    try {
      await openDraftReviewReportModal(state.currentProject?.id, result.variantId || activeVariant?.id);
    } catch (modalErr) {
      console.warn("Could not open draft review modal automatically:", modalErr);
    }
    return result;
  } catch (error) {
    addLog(error.message, "ERROR");
    if (el.draftReviewStatus) el.draftReviewStatus.textContent = error.message;
    showToast(error.message);
  } finally {
    el.cancelConfiguredDraftReview?.classList.add("hidden");
    setBusy(false);
    syncConfiguredAiWorkflowUi();
  }
}

async function reviewAllDraftVariantsWithConfiguredAi() {
  if (!state.currentProject || state.currentProject.mode !== "highlight_cut") return [];
  const variantIds = getHighlightVariants().map((variant) => variant.id);
  const results = [];
  for (const [index, variantId] of variantIds.entries()) {
    await switchHighlightVariant(variantId);
    addLog(`Vertex review variant ${index + 1}/${variantIds.length}...`);
    const result = await runConfiguredDraftReview();
    results.push({ variantId, result, ok: Boolean(result?.resultPath) });
  }
  if (variantIds[0]) await switchHighlightVariant(variantIds[0]);
  const completed = results.filter((item) => item.ok).length;
  addLog(`Pipeline Vertex hoàn tất review ${completed}/${variantIds.length} variant. V1 vẫn được giữ nguyên để bạn so sánh.`);
  showToast(`Đã tạo đề xuất V2 cho ${completed}/${variantIds.length} variant.`);
  return results;
}

async function cancelConfiguredDraftReview() {
  if (el.cancelConfiguredDraftReview) el.cancelConfiguredDraftReview.disabled = true;
  const result = await window.cineviral.cancelConfiguredAi();
  if (el.draftReviewStatus) {
    el.draftReviewStatus.textContent = result.cancelled ? "Đang dừng review AI..." : "Không có review AI nào đang chạy.";
  }
}

async function openConfiguredDraftReviewResult() {
  const resultDir = getDraftReviewArtifacts().aiResultDir;
  if (!resultDir) {
    showToast("Chưa có kết quả review AI cho variant hiện tại.");
    return;
  }
  await window.cineviral.openFile(resultDir);
}

async function runAutoReviewAndRenderCurrent() {
  if (!state.currentProject || state.currentProject.mode !== "highlight_cut") return;
  const activeVariant = getActiveHighlightVariant(state.currentProject);
  if (!activeVariant) {
    showToast("Chưa chọn variant để review.");
    return;
  }
  const aiInfo = getConfiguredAiUiInfo();
  if (!aiInfo.supported) {
    showToast(aiInfo.reason);
    return;
  }
  const variantTitle = activeVariant.title || activeVariant.label || activeVariant.id;
  const confirmed = await showConfirmAction({
    title: `Auto Review & Render: ${variantTitle}`,
    message: `Hệ thống sẽ tự động thực hiện: AI Review (${aiInfo.label}) ➔ Tự import kịch bản V2 ➔ Tự render lại bản nháp V2. Bạn có muốn tiếp tục?`,
    confirmText: "Bắt đầu"
  });
  if (!confirmed) return;

  switchRightTab("log");
  updateStudioPipelineTracker({
    visible: true,
    label: `Bắt đầu Auto Review cho ${variantTitle}...`,
    percent: 10,
    activeStep: "draft"
  });

  try {
    const draftArtifacts = getDraftReviewArtifacts(state.currentProject);
    if (!draftArtifacts.videoPath) {
      addLog(`[Auto Review] Chưa có video nháp V1 cho ${variantTitle}. Đang tự động render nháp trước...`);
      updateStudioPipelineTracker({
        visible: true,
        label: `Đang render nháp V1 cho ${variantTitle}...`,
        percent: 25,
        activeStep: "draft"
      });
      await renderFastDraftVideo();
    }

    updateStudioPipelineTracker({
      visible: true,
      label: `AI (${aiInfo.label}) đang phân tích video thật & đánh giá kịch bản...`,
      percent: 50,
      activeStep: "review"
    });
    addLog(`[Auto Review] Đang khởi chạy AI Review với ${aiInfo.label} (${aiInfo.model})...`);
    const reviewResult = await runConfiguredDraftReview();
    if (!reviewResult || !reviewResult.resultPath) {
      throw new Error("Không nhận được kết quả review hợp lệ từ AI.");
    }

    updateStudioPipelineTracker({
      visible: true,
      label: `Đang áp dụng kịch bản sửa V2...`,
      percent: 75,
      activeStep: "package"
    });
    addLog(`[Auto Review] Đang import kết quả review V2: ${reviewResult.resultPath}...`);
    await importReviewedScriptPath(reviewResult.resultPath, { autoRouted: true });

    updateStudioPipelineTracker({
      visible: true,
      label: `Đang kết xuất video nháp V2...`,
      percent: 90,
      activeStep: "v2"
    });
    addLog(`[Auto Review] Đang render lại bản nháp V2 cho ${variantTitle}...`);
    await renderFastDraftVideo();

    updateStudioPipelineTracker({
      visible: true,
      label: `Hoàn tất Review & Render V2 cho ${variantTitle}!`,
      percent: 100,
      activeStep: "v2"
    });
    showToast(`Đã hoàn tất Review & Render V2 cho ${variantTitle}!`);
    addLog(`[Auto Review] THÀNH CÔNG: Đã tạo và render bản nháp V2 cho ${variantTitle}.`, "SUCCESS");
    renderStudioVariantHub();
  } catch (error) {
    addLog(`[Auto Review] Lỗi khi xử lý ${variantTitle}: ${error.message}`, "ERROR");
    showToast(error.message);
  } finally {
    setTimeout(() => updateStudioPipelineTracker({ visible: false }), 8000);
  }
}

async function runAutoReviewAndRenderAll() {
  if (!state.currentProject || state.currentProject.mode !== "highlight_cut") return;
  const variants = getHighlightVariants();
  if (!variants.length) return;
  
  const confirmed = await showConfirmAction({
    title: "Auto Review & Render Toàn bộ",
    message: `Hệ thống sẽ tự động chạy: AI Review ➔ Import V2 ➔ Render Nháp Nhanh V2 cho ${variants.length} variant. Sẽ tốn nhiều thời gian và credit (nếu dùng Vertex). Bạn có muốn tiếp tục?`,
    confirmText: "Bắt đầu"
  });
  if (!confirmed) return;

  switchRightTab("log");
  updateStudioPipelineTracker({
    visible: true,
    label: `Bắt đầu Auto Pipeline cho ${variants.length} variant...`,
    percent: 5,
    activeStep: "draft"
  });

  let successCount = 0;
  for (const [index, variant] of variants.entries()) {
    try {
      await switchHighlightVariant(variant.id);
      renderStudioVariantHub();
      addLog(`[Auto Pipeline] Bắt đầu xử lý Variant ${index + 1}/${variants.length}...`);
      
      const vProgressBase = (index / variants.length) * 100;
      const vProgressSpan = 100 / variants.length;

      const currentDraftVideo = variant.artifacts?.fastDraftVideoPath
        || (state.currentProject.analysis?.activeVariantId === variant.id && state.currentProject.artifacts?.fastDraftVideoPath);
      if (!currentDraftVideo) {
        addLog(`[Auto Pipeline] Variant ${index + 1} chưa có video nháp V1. Đang render nháp trước khi review...`);
        updateStudioPipelineTracker({
          visible: true,
          label: `Variant ${index + 1}/${variants.length}: Render nháp V1 trước...`,
          percent: vProgressBase + vProgressSpan * 0.15,
          activeStep: "draft"
        });
        await renderFastDraftVideo();
      }

      updateStudioPipelineTracker({
        visible: true,
        label: `Variant ${index + 1}/${variants.length}: Chuẩn bị gói review...`,
        percent: vProgressBase + vProgressSpan * 0.35,
        activeStep: "package"
      });

      addLog(`[Auto Pipeline] ${index + 1}/${variants.length}: Đang chạy AI Review...`);
      updateStudioPipelineTracker({
        visible: true,
        label: `Variant ${index + 1}/${variants.length}: AI đang xem video và đánh giá...`,
        percent: vProgressBase + vProgressSpan * 0.55,
        activeStep: "review"
      });

      const reviewResult = await runConfiguredDraftReview();
      if (!reviewResult || !reviewResult.resultPath) {
        addLog(`[Auto Pipeline] Variant ${index + 1} thất bại ở bước AI Review. Bỏ qua.`, "WARNING");
        continue;
      }

      addLog(`[Auto Pipeline] ${index + 1}/${variants.length}: Đang import bản Review V2...`);
      await importReviewedScriptPath(reviewResult.resultPath, { autoRouted: true });

      addLog(`[Auto Pipeline] ${index + 1}/${variants.length}: Đang render bản nháp V2...`);
      updateStudioPipelineTracker({
        visible: true,
        label: `Variant ${index + 1}/${variants.length}: Đang render video V2...`,
        percent: vProgressBase + vProgressSpan * 0.85,
        activeStep: "v2"
      });

      await renderFastDraftVideo();
      
      successCount++;
      addLog(`[Auto Pipeline] Variant ${index + 1} hoàn tất V2 thành công!`, "SUCCESS");
      renderStudioVariantHub();
    } catch (err) {
      addLog(`[Auto Pipeline] Lỗi ở Variant ${index + 1}: ${err.message}`, "ERROR");
    }
  }
  
  updateStudioPipelineTracker({
    visible: true,
    label: `Hoàn tất toàn bộ ${successCount}/${variants.length} variant!`,
    percent: 100,
    activeStep: "v2"
  });
  renderStudioVariantHub();
  setTimeout(() => updateStudioPipelineTracker({ visible: false }), 10000);

  showToast(`Auto Review hoàn tất ${successCount}/${variants.length} variant.`);
  addLog(`[Auto Pipeline] HOÀN TẤT. ${successCount}/${variants.length} variant đã sinh V2 và render xong.`, "INFO");
}

async function importConfiguredDraftReview() {
  const resultPath = getDraftReviewArtifacts().aiResultPath;
  if (!resultPath) {
    showToast("Chưa có JSON review AI để import.");
    return;
  }
  await importReviewedScriptPath(resultPath, { autoRouted: true });
}

let currentReviewReportData = null;

function setReviewModalTab(tabName) {
  document.querySelectorAll(".draft-review-tabs .review-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.reviewTab === tabName);
  });
  document.querySelectorAll(".draft-review-content .review-tab-pane").forEach((pane) => {
    pane.classList.toggle("hidden", pane.id !== `review-tab-${tabName}`);
  });
}

function closeDraftReviewReportModal() {
  if (el.draftReviewModal) {
    el.draftReviewModal.classList.add("hidden");
  }
  currentReviewReportData = null;
}

async function openDraftReviewReportModal(projectId, variantId) {
  const pId = projectId || state.currentProject?.id;
  if (!pId) {
    showToast("Chưa có dự án nào được mở.");
    return;
  }
  setBusy(true);
  try {
    const report = await window.cineviral.getDraftReviewReport(pId, variantId);
    if (!report || !report.ready) {
      showToast(report?.message || report?.error || "Không tìm thấy kết quả review AI.");
      return;
    }

    currentReviewReportData = report;

    // Header info
    if (el.reviewModalVariantBadge) {
      el.reviewModalVariantBadge.textContent = `#${report.variantLabel || "Variant"}`;
    }
    if (el.reviewModalScoreV1) {
      el.reviewModalScoreV1.textContent = report.scores?.before || "--";
    }
    if (el.reviewModalScoreV2) {
      el.reviewModalScoreV2.textContent = report.scores?.afterEstimated || "--";
    }
    if (el.reviewModalScoreDelta) {
      const delta = report.scores?.delta || 0;
      el.reviewModalScoreDelta.textContent = delta > 0 ? `+${delta}` : `${delta}`;
      el.reviewModalScoreDelta.style.color = delta >= 0 ? "#10b981" : "#ef4444";
    }
    if (el.reviewModalDecisionBadge) {
      const dec = (report.decision || "patch").toLowerCase();
      el.reviewModalDecisionBadge.textContent = dec.toUpperCase();
      el.reviewModalDecisionBadge.className = `review-decision-badge ${dec}`;
    }

    // Tab 1: Overview
    if (el.reviewModalSummary) {
      el.reviewModalSummary.textContent = report.summary || "AI đã review và tạo bản kịch bản V2.";
    }

    // Hook analysis
    if (el.reviewModalHookAnalysis) {
      const hook = report.hookAudit || {};
      el.reviewModalHookAnalysis.innerHTML = `
        <div class="audit-metric-row">
          <span class="audit-metric-label">Điểm Hook V1 ➔ V2:</span>
          <span class="audit-metric-value" style="color: ${Number(hook.v2Score) >= Number(hook.v1Score) ? '#34d399' : '#f87171'}">${hook.v1Score || 0} ➔ ${hook.v2Score || 0} (${hook.scoreDelta > 0 ? '+' : ''}${hook.scoreDelta || 0})</span>
        </div>
        <div class="audit-metric-row">
          <span class="audit-metric-label">Cần đổi hook (3s đầu):</span>
          <span class="audit-metric-value">${hook.replacementRequired ? '<span style="color:#f59e0b">⚠️ Có (Thay bằng cảnh đắt giá hơn)</span>' : '<span style="color:#10b981">✓ Giữ nguyên cảnh mở đầu</span>'}</span>
        </div>
        ${hook.triggerType ? `
          <div class="audit-metric-row">
            <span class="audit-metric-label">Trigger kích thích tò mò:</span>
            <span class="audit-metric-value" style="color: #38bdf8">${escapeHtml(hook.triggerType)}</span>
          </div>
        ` : ''}
        ${hook.comparison ? `
          <p style="margin: 6px 0 0; font-size: 12px; line-height: 1.5; color: #94a3b8;">
            <b style="color: #e2e8f0;">So sánh 3s đầu:</b> ${escapeHtml(hook.comparison)}
          </p>
        ` : ''}
      `;
    }

    // Ideal audit & payoff
    if (el.reviewModalIdealAudit) {
      const ideal = report.idealEdit || {};
      el.reviewModalIdealAudit.innerHTML = `
        <div class="audit-metric-row">
          <span class="audit-metric-label">Câu hỏi giữ chân người xem:</span>
          <span class="audit-metric-value" style="color: #fbbf24">${escapeHtml(ideal.question || "N/A")}</span>
        </div>
        <div class="audit-metric-row">
          <span class="audit-metric-label">Lời hứa đầu video (Hook Promise):</span>
          <span class="audit-metric-value">${escapeHtml(ideal.hookPromise || "N/A")}</span>
        </div>
        <div class="audit-metric-row">
          <span class="audit-metric-label">Cao trào & Trả lời (Payoff):</span>
          <span class="audit-metric-value" style="color: #38bdf8">${escapeHtml(ideal.payoff || ideal.climax || "N/A")}</span>
        </div>
        ${ideal.whyV1Differs ? `
          <p style="margin: 6px 0 0; font-size: 12px; line-height: 1.5; color: #94a3b8;">
            <b style="color: #e2e8f0;">Lý do cần chỉnh:</b> ${escapeHtml(ideal.whyV1Differs)}
          </p>
        ` : ''}
      `;
    }

    // Tab 2: Issues
    const issues = report.issues || [];
    if (el.reviewModalIssuesBadge) {
      el.reviewModalIssuesBadge.textContent = issues.length;
    }
    if (el.reviewModalIssuesStats) {
      el.reviewModalIssuesStats.textContent = issues.length > 0
        ? `Phát hiện ${issues.length} vấn đề cần xử lý trong bản draft:`
        : `Tuyệt vời! Không phát hiện lỗi nghiêm trọng nào trong bản draft.`;
    }
    if (el.reviewModalIssuesList) {
      if (issues.length === 0) {
        el.reviewModalIssuesList.innerHTML = `<div class="empty-state-card" style="padding: 24px; text-align: center; color: #94a3b8;">Bản nháp đã đạt tiêu chuẩn chất lượng cao.</div>`;
      } else {
        el.reviewModalIssuesList.innerHTML = issues.map((issue) => {
          const sev = (issue.severity || "warning").toLowerCase();
          return `
            <div class="issue-item-card ${sev}">
              <div class="issue-header">
                <span class="issue-severity-pill ${sev}">${escapeHtml(issue.severity || "Warning")}</span>
                ${issue.category ? `<span class="issue-category-pill">${escapeHtml(issue.category)}</span>` : ""}
                ${issue.segmentIndex ? `<span class="issue-category-pill">Cảnh #${issue.segmentIndex}</span>` : ""}
              </div>
              <div class="issue-problem">⚠️ ${escapeHtml(issue.problem || issue.issue || "")}</div>
              ${issue.action ? `<div class="issue-action"><b>➔ Khắc phục:</b> ${escapeHtml(issue.action)}</div>` : ""}
              ${issue.reason ? `<div class="issue-reason">Lý do: ${escapeHtml(issue.reason)}</div>` : ""}
            </div>
          `;
        }).join("");
      }
    }

    // Tab 3: Diff V1 vs V2
    const timelines = report.timelines || {};
    if (el.diffV1Duration) el.diffV1Duration.textContent = `${timelines.v1Duration || 0}s`;
    if (el.diffV2Duration) el.diffV2Duration.textContent = `${timelines.v2Duration || 0}s`;
    if (el.diffDurationDelta) {
      const delta = timelines.durationDelta || 0;
      el.diffDurationDelta.textContent = delta > 0 ? `+${delta}s` : `${delta}s`;
      el.diffDurationDelta.className = `diff-delta-badge ${delta > 0 ? "pos" : delta < 0 ? "neg" : ""}`;
    }
    if (el.diffSegmentCount) {
      el.diffSegmentCount.textContent = `${timelines.v1Count || 0} cảnh ➔ ${timelines.v2Count || 0} cảnh`;
    }

    if (el.reviewModalDiffList) {
      const diffList = report.diffList || [];
      if (diffList.length === 0) {
        el.reviewModalDiffList.innerHTML = `<div class="empty-state-card" style="padding: 24px; text-align: center; color: #94a3b8;">Không có danh sách so sánh.</div>`;
      } else {
        el.reviewModalDiffList.innerHTML = diffList.map((diff) => {
          let statusLabel = "Giữ nguyên";
          if (diff.type === "trimmed") statusLabel = "Cắt gọt";
          else if (diff.type === "voice_rewritten") statusLabel = "Viết lại thoại";
          else if (diff.type === "modified_all") statusLabel = "Sửa thoại & Cắt";
          else if (diff.type === "added") statusLabel = "Bổ sung";
          else if (diff.type === "removed") statusLabel = "Đã bỏ";

          return `
            <div class="diff-row-card">
              <div class="diff-row-header">
                <div class="diff-row-left">
                  <span class="diff-index-badge">Cảnh #${diff.index}</span>
                  <span class="diff-status-pill ${diff.type}">${statusLabel}</span>
                </div>
                <div class="diff-row-note">${escapeHtml(diff.note || "")}</div>
              </div>
              <div class="diff-comparison-grid">
                <div class="diff-pane v1">
                  <div class="diff-pane-title">
                    <span>Bản Draft V1</span>
                    <span>${diff.v1 ? `${diff.v1.duration}s` : "--"}</span>
                  </div>
                  <div class="diff-pane-text">${diff.v1?.text ? escapeHtml(diff.v1.text) : '<em style="color:#64748b;">(Không có lời thoại)</em>'}</div>
                </div>
                <div class="diff-pane v2">
                  <div class="diff-pane-title">
                    <span>Bản Review V2</span>
                    <span>${diff.v2 ? `${diff.v2.duration}s` : "--"}</span>
                  </div>
                  <div class="diff-pane-text">${diff.v2?.text ? escapeHtml(diff.v2.text) : '<em style="color:#64748b;">(Không có lời thoại)</em>'}</div>
                </div>
              </div>
            </div>
          `;
        }).join("");
      }
    }

    // Update apply button text
    if (el.applyDraftReviewModalV2) {
      if (report.isImported) {
        el.applyDraftReviewModalV2.innerHTML = "✅ Đã áp dụng V2 (Bấm để áp dụng lại)";
      } else {
        el.applyDraftReviewModalV2.innerHTML = "🚀 Áp dụng bản sửa V2 (Import kịch bản mới)";
      }
    }

    // Default to Overview tab
    setReviewModalTab("overview");

    // Show modal
    el.draftReviewModal.classList.remove("hidden");
  } catch (error) {
    addLog(`Lỗi hiển thị báo cáo AI review: ${error.message}`, "ERROR");
    showToast(`Không thể mở báo cáo review: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function openGeminiDraftReviewPackage() {
  const reviewPath = getDraftReviewArtifacts().reviewPackagePath;
  if (!reviewPath) {
    showToast("Chưa có gói review. Hãy render draft rồi tạo gói trước.");
    return;
  }
  await window.cineviral.openFile(reviewPath);
}

async function importReviewedScriptPath(jsonPath, { autoRouted = false } = {}) {
  if (!state.currentProject) return;
  if (!["satisfying_storytime", "highlight_cut"].includes(state.currentProject.mode)) {
    showToast("Import JSON đã sửa chỉ hỗ trợ Storytime và Highlight Cut.");
    return;
  }
  if (!jsonPath) return;
  setBusy(true);
  try {
    if (!el.studioView.classList.contains("hidden")) {
      await saveCurrentSegments();
    }
    addLog(`${autoRouted ? "Đã nhận diện file review V2. Đang tự chuyển luồng import" : "Đang import JSON Gemini đã sửa"}: ${jsonPath}`);
    state.currentProject = await window.cineviral.importReviewedScriptProject(state.currentProject.id, jsonPath);
    state.revisionPreviewPath = "";
    state.selectedSegmentIndex = 0;
    state.expandedScenePickerIndex = -1;
    if (autoRouted) {
      showStudio(state.currentProject);
    } else {
      renderStudio();
    }
    const revision = getActiveHighlightVariant(state.currentProject)?.revisionNumber;
    addLog(`Đã import ${revision ? `Revision V${revision}` : "JSON đã sửa"}. Hãy render nháp nhanh lại để đo voice thật trước khi export.`);
    showToast(revision
      ? `Đã tự nhận diện và tạo V${revision}. Render draft lại để so sánh.`
      : "Đã tự nhận diện và import JSON đã sửa.");
  } catch (error) {
    addLog(error.message, "ERROR");
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

async function importReviewedScriptFromGemini() {
  const jsonPath = await window.cineviral.pickJson();
  if (!jsonPath) return;
  await importReviewedScriptPath(jsonPath);
}

async function createAndIngestProject() {
  const payload = readProjectPayload();
  if (!payload.sourceVideoPath) {
    showToast("Hãy chọn video nguồn trước.");
    return;
  }

  setBusy(true);
  state.activeOperation = payload.mode === "recap" ? "Dang lap ke hoach" : payload.mode === "script_rewrite" ? "Dang viet lai kich ban" : "Dang nap du lieu";
  setExportProgress(3, state.activeOperation);
  try {
    const saved = await window.cineviral.saveSettings(readSettings());
    state.settings = saved.settings;
    addLog(`Đang tạo dự án: ${payload.title}`);
    const retryProject = payload.analysisWorkflow === "vertex_auto_story"
      && state.currentProject?.analysisWorkflow === "vertex_auto_story"
      && ["failed", "cancelled"].includes(state.currentProject?.autoStoryState?.phase)
      && state.currentProject.sourceVideoPath === payload.sourceVideoPath
      && JSON.stringify(state.currentProject.autoStoryConfig) === JSON.stringify(payload.autoStoryConfig)
      && state.currentProject.voiceProvider === payload.voiceProvider
      && state.currentProject.voiceId === payload.voiceId
      ? state.currentProject : null;
    const created = retryProject
      ? { project: await window.cineviral.getProject(retryProject.id), projects: state.projects }
      : await window.cineviral.createProject(payload);
    state.projects = created.projects;
    state.currentProject = created.project;
    renderProjectPicker();
    addLog(`Đã tạo dự án: ${created.project.id}`);

    if (payload.analysisWorkflow === "vertex_auto_story") {
      addLog("Vertex đang xem nguồn, chọn câu chuyện và dựng theo bằng chứng...");
      const result = await window.cineviral.runAutoStoryPipeline(created.project.id);
      if (result.project) state.currentProject = result.project;
      // Bug-2 fix: a failed/zero-script V3 run STOPS here — surface the real error,
      // do not claim a draft was rendered, do not proceed to any render step.
      if (result.generationFailed || !(result.analysis?.scriptPaths?.length)) {
        const err = result.error || result.project?.autoStoryState?.error
          || result.project?.autoStoryState?.failures?.[0]?.error || "AutoStory V3 không tạo được kịch bản nào.";
        addLog(`AutoStory V3 thất bại: ${err}`, "ERROR");
        showToast(`AutoStory V3 thất bại: ${err}`);
        await refreshProjects();
        showStudio(state.currentProject);
        return state.currentProject;
      }
      addLog(`Đã tạo và render draft ${result.analysis.scriptPaths.length} Auto Story.`);
    } else if (payload.mode === "dubbing") {
      addLog("Đang nạp media cho chế độ thuyết minh & dịch...");
      state.currentProject = await window.cineviral.ingestDubbingProject(created.project.id);
    } else if (payload.mode === "satisfying_storytime") {
      addLog("Đang nhập kịch bản Oddly Satisfying Storytime...");
      state.currentProject = await window.cineviral.importStorytimeProject(created.project.id);
    } else if (payload.mode === "highlight_cut") {
      addLog(payload.analysisWorkflow === "manual_gemini_diy_story_remix"
        ? "Đang nhập DIY Story Remix và kiểm tra Visual Process Map..."
        : payload.analysisWorkflow === "manual_gemini_story_recut"
        ? "Đang nhập Story Recut JSON và kiểm tra continuity..."
        : payload.analysisWorkflow === "manual_gemini_podcast_cut"
        ? "Đang biên dịch Podcast EDL từ ID sang timestamp local..."
        : ["manual_gemini_pro", "manual_gemini_pro_two_pass", "manual_gemini_draft_review"].includes(payload.analysisWorkflow)
        ? "Đang nhập ba variant Highlight từ Lượt 1 Gemini Draft Review..."
        : "Đang nhập Highlight Cut JSON từ Gemini...");
      state.currentProject = await window.cineviral.importHighlightCutProject(created.project.id);
    } else if (payload.mode === "script_rewrite") {
      addLog("Dang doc loi thoai va phan canh de viet lai kich ban...");
      state.currentProject = await window.cineviral.ingestDubbingProject(created.project.id);
      addLog("AI dang viet lai kich ban, giu nguyen cot truyen goc...");
      state.currentProject = await window.cineviral.rewriteScriptProject(created.project.id);
    } else if (payload.mode === "recap") {
      addLog("Đang khởi chạy luồng AI Video Recap (Story -> Scene -> Shot -> Visual Event -> Narration)...");
      const result = await window.cineviral.runRecap(created.project.id, {
        targetDurationSec: payload.targetDurationSec,
        allowShotReuse: payload.allowShotReuse,
        recapWorkflow: payload.recapWorkflow,
        visualLeadSec: payload.visualLeadSec
      });
      state.currentProject = await window.cineviral.getProject(created.project.id);
      if (result && result.status === "review_ready") {
        addLog("Bản Draft đã sẵn sàng để Review trước khi xuất Master!", "SUCCESS");
        showToast("Bản Draft đã sẵn sàng. Hãy kiểm tra các đoạn khớp hình trước khi xuất.");
      } else {
        addLog(`Đã hoàn tất Video Recap Master: ${result?.finalVideoPath || ""}`, "SUCCESS");
      }
    } else {
      addLog(`Đang lập kế hoạch tóm tắt phim bằng Gemini: ${payload.targetDuration}s, giọng ${payload.voiceSpeed}x...`);
      state.currentProject = await window.cineviral.planProject(created.project.id);
    }

    await refreshProjects();
    showStudio(state.currentProject);
    return state.currentProject;
  } catch (error) {
    addLog(error.message, "ERROR");
    showToast(error.message);
    if (state.currentProject?.analysisWorkflow === "vertex_auto_story") {
      state.currentProject = await window.cineviral.getProject(state.currentProject.id);
      showStudio(state.currentProject);
    }
  } finally {
    setBusy(false);
  }
}

async function loadSelectedProject() {
  const projectId = el.projectPicker.value;
  if (!projectId) {
    return;
  }
  const project = await window.cineviral.getProject(projectId);
  showStudio(project);
  addLog(`Đã tải dự án: ${project.title || project.id}`);
}

function renderSettingsCheckResult(result) {
  if (!el.settingsCheckResult) return;
  const checks = Array.isArray(result?.checks) ? result.checks : [];
  const summary = result?.ok
    ? `Đủ cấu hình chính${result.warningCount ? `, còn ${result.warningCount} cảnh báo` : ""}.`
    : `Có ${result.errorCount || 0} lỗi và ${result.warningCount || 0} cảnh báo.`;
  el.settingsCheckResult.innerHTML = `
    <div class="settings-check-title">
      <strong>${escapeHtml(result?.ok ? "Cấu hình có thể chạy" : "Cần kiểm tra lại cấu hình")}</strong>
      <span>${escapeHtml(summary)}</span>
    </div>
    <div class="settings-check-list">
      ${checks.map((item) => `
        <div class="settings-check-item ${escapeHtml(item.status || "warning")}">
          <strong>${escapeHtml(item.status || "warning")}</strong>
          <p>
            ${escapeHtml(item.label || item.key || "Mục cấu hình")}: ${escapeHtml(item.message || "")}
            ${item.hint ? `<small>${escapeHtml(item.hint)}</small>` : ""}
          </p>
        </div>
      `).join("")}
    </div>
  `;
  el.settingsCheckResult.classList.remove("hidden");
}

async function checkCurrentSettings() {
  if (!el.checkSettings) return;
  el.checkSettings.disabled = true;
  el.checkSettings.textContent = "Đang kiểm tra...";
  if (el.settingsCheckResult) {
    el.settingsCheckResult.classList.remove("hidden");
    el.settingsCheckResult.innerHTML = `<div class="settings-check-title"><strong>Đang kiểm tra cấu hình</strong><span>Vui lòng chờ...</span></div>`;
  }
  try {
    const result = await window.cineviral.checkSettings(readSettings());
    renderSettingsCheckResult(result);
  } catch (error) {
    renderSettingsCheckResult({
      ok: false,
      errorCount: 1,
      warningCount: 0,
      checks: [{ status: "error", label: "Kiểm tra cấu hình", message: error.message }]
    });
  } finally {
    el.checkSettings.disabled = false;
    el.checkSettings.textContent = "Kiểm tra cấu hình";
  }
}

async function autoCheckConfiguration() {
  try {
    const result = await window.cineviral.checkSettings(readSettings());
    const problemItems = (result.checks || []).filter((item) => item.status === "error" || item.status === "warning");
    if (!problemItems.length) {
      addLog("Kiểm tra cấu hình tự động: đủ thư viện chính.");
      return;
    }
    problemItems.forEach((item) => {
      addLog(`${item.label}: ${item.message}${item.hint ? ` (${item.hint})` : ""}`, item.status === "error" ? "ERROR" : "WARNING");
    });
    showToast(`Cấu hình còn ${result.errorCount || 0} lỗi, ${result.warningCount || 0} cảnh báo. Mở Cài đặt > Kiểm tra cấu hình để xem chi tiết.`);
  } catch (error) {
    addLog(`Không thể kiểm tra cấu hình tự động: ${error.message}`, "WARNING");
  }
}

window.initProductionQueue?.(project => {
  showStudio(project);
  addLog(`Đã mở kết quả hàng đợi: ${project.title || project.id}`);
});

async function resumeAutoStoryProject(scriptId = null) {
  if (typeof scriptId !== "number") scriptId = null;
  if (state.busy || state.currentProject?.analysisWorkflow !== "vertex_auto_story") return;
  setBusy(true);
  try {
    const result = await window.cineviral.runAutoStoryPipeline(state.currentProject.id, { scriptId });
    state.currentProject = result.project;
    showStudio(result.project);
  } catch (error) {
    addLog(error.message, "ERROR");
    state.currentProject = await window.cineviral.getProject(state.currentProject.id);
    showStudio(state.currentProject);
  } finally { setBusy(false); }
}

function updateSourceDownloadProgress(payload = {}) {
  if (!el.sourceDownloadProgress) return;
  const percent = Math.max(0, Math.min(100, Number(payload.percent || 0)));
  el.sourceDownloadProgress.classList.remove("hidden");
  if (el.sourceDownloadStatus) el.sourceDownloadStatus.textContent = payload.message || "Đang tải nguồn...";
  if (el.sourceDownloadPercent) el.sourceDownloadPercent.textContent = `${Math.round(percent)}%`;
  if (el.sourceDownloadProgressBar) el.sourceDownloadProgressBar.style.width = `${percent}%`;
  if (el.sourceDownloadDetail) {
    el.sourceDownloadDetail.textContent = payload.detail
      || (payload.stage === "complete"
        ? "Video nguồn đã sẵn sàng để sử dụng."
        : "Nếu có transcript tiếng Anh, tool sẽ tải và chọn tự động.");
  }
}

function setSourceMethod(method = "local", { persist = true } = {}) {
  const normalized = method === "url" ? "url" : "local";
  document.querySelectorAll("[data-source-method]").forEach((button) => {
    const isActive = button.dataset.sourceMethod === normalized;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });
  document.querySelectorAll("[data-source-method-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.sourceMethodPanel !== normalized);
  });
  if (persist) writeSetupDraft();
}

function updateSourceSelectionUi() {
  if (!el.sourceSelectionSummary) return;
  const videoPath = el.sourceVideoPath?.value.trim() || "";
  const enteredUrl = el.sourceDownloadUrl?.value.trim() || "";
  const sourceKind = el.sourceVideoPath?.dataset.sourceKind || (videoPath ? "local" : "");
  const sourceOriginUrl = el.sourceVideoPath?.dataset.sourceOriginUrl || "";
  const isUrlSource = sourceKind === "url";
  const hasPendingUrl = Boolean(enteredUrl && (!isUrlSource || (sourceOriginUrl && enteredUrl !== sourceOriginUrl)));

  el.sourceSelectionSummary.classList.remove("empty", "local", "url", "warning");
  el.sourceActiveBadge?.classList.remove("empty", "local", "url", "warning");

  if (!videoPath) {
    const pending = Boolean(enteredUrl);
    el.sourceSelectionSummary.classList.add(pending ? "warning" : "empty");
    el.sourceActiveBadge?.classList.add(pending ? "warning" : "empty");
    if (el.sourceActiveBadge) el.sourceActiveBadge.textContent = pending ? "Chưa tải liên kết" : "Chưa có nguồn";
    el.sourceSelectionLabel.textContent = pending ? "Liên kết chưa được tải" : "Chưa chọn video nguồn";
    el.sourceSelectionDetail.textContent = pending
      ? "Bấm “Tải & dùng” để biến liên kết này thành file nguồn của dự án."
      : "Chọn file trên máy hoặc tải video từ một liên kết.";
    return;
  }

  const kindClass = isUrlSource ? "url" : "local";
  el.sourceSelectionSummary.classList.add(hasPendingUrl ? "warning" : kindClass);
  el.sourceActiveBadge?.classList.add(hasPendingUrl ? "warning" : kindClass);
  if (el.sourceActiveBadge) {
    el.sourceActiveBadge.textContent = hasPendingUrl
      ? "Vẫn dùng nguồn cũ"
      : isUrlSource ? "YouTube / TikTok" : "File trên máy";
  }
  el.sourceSelectionLabel.textContent = `Đang dùng: ${fileName(videoPath)}`;
  const transcriptNote = el.subtitlePath?.value
    ? ` Transcript: ${fileName(el.subtitlePath.value)}.`
    : " Chưa có transcript được chọn.";
  el.sourceSelectionDetail.textContent = hasPendingUrl
    ? `URL mới chưa được tải; pipeline vẫn dùng file trên.${transcriptNote}`
    : isUrlSource
      ? `Video đã tải từ ${sourceOriginUrl || enteredUrl || "liên kết trực tuyến"}.${transcriptNote}`
      : `Video được chọn trực tiếp từ thư mục trên máy.${transcriptNote}`;
}

async function applySourceSelection({ videoPath, subtitlePath, sourceUrl = "", title = "", replaceSubtitle = false, clearSourceUrl = false } = {}) {
  if (!videoPath) return;
  const previousVideo = el.sourceVideoPath.value;
  const previousSubtitle = el.subtitlePath.value;
  const sourceChanged = Boolean(previousVideo && previousVideo !== videoPath);
  el.sourceVideoPath.value = videoPath;
  if (sourceUrl) {
    el.sourceVideoPath.dataset.sourceKind = "url";
    el.sourceVideoPath.dataset.sourceOriginUrl = sourceUrl;
    setSourceMethod("url", { persist: false });
  } else if (clearSourceUrl) {
    el.sourceVideoPath.dataset.sourceKind = "local";
    delete el.sourceVideoPath.dataset.sourceOriginUrl;
    setSourceMethod("local", { persist: false });
  }
  if (replaceSubtitle) el.subtitlePath.value = subtitlePath || "";
  const transcriptChanged = replaceSubtitle && previousSubtitle !== el.subtitlePath.value;
  if (sourceChanged || transcriptChanged) {
    invalidateManualGeminiPack(sourceChanged ? "Video nguồn đã thay đổi." : "Nguồn transcript đã thay đổi.");
  }
  if (clearSourceUrl && el.sourceDownloadUrl) el.sourceDownloadUrl.value = "";
  else if (sourceUrl && el.sourceDownloadUrl) el.sourceDownloadUrl.value = sourceUrl;
  if (sourceUrl && /(?:youtube\.com|youtu\.be)/i.test(sourceUrl) && el.podcastYoutubeUrl) {
    el.podcastYoutubeUrl.value = sourceUrl;
  }
  if (!el.projectTitle.value.trim() || el.projectTitle.value === "project_default") {
    el.projectTitle.value = title || fileName(videoPath).replace(/\.[^.]+$/, "");
  }
  try {
    const meta = await window.cineviral.probeVideo(videoPath);
    if (meta?.duration) {
      el.targetDuration.max = String(Math.max(8, Math.floor(meta.duration)));
      if (Number(el.targetDuration.value || 0) > meta.duration) {
        el.targetDuration.value = String(Math.max(8, Math.floor(meta.duration)));
      }
    }
  } catch (error) {
    addLog(`Không thể kiểm tra thời lượng nguồn: ${error.message}`, "WARNING");
  }
  updateSourceSelectionUi();
  updateReview();
  writeSetupDraft();
}

async function downloadSourceFromUrl() {
  const url = el.sourceDownloadUrl?.value.trim() || "";
  if (!url) {
    showToast("Hãy nhập liên kết YouTube hoặc TikTok.");
    el.sourceDownloadUrl?.focus();
    return;
  }
  el.downloadSourceUrl.disabled = true;
  el.sourceDownloadUrl.disabled = true;
  updateSourceDownloadProgress({ stage: "metadata", percent: 1, message: "Đang chuẩn bị tải video" });
  addLog(`Đang tải video nguồn từ ${url}`);
  try {
    const result = await window.cineviral.downloadSourceFromUrl({ url });
    await applySourceSelection({
      videoPath: result.videoPath,
      subtitlePath: result.subtitlePath,
      sourceUrl: result.sourceUrl || url,
      title: result.title,
      replaceSubtitle: true
    });
    addLog(`Đã tải video nguồn: ${result.videoPath}`);
    if (result.subtitlePath) {
      addLog(`Đã tải transcript tiếng Anh: ${result.subtitlePath}`);
    } else {
      addLog("Video không có transcript tiếng Anh tải được. Tool vẫn có thể dùng Whisper khi cần.", "WARNING");
    }
    (result.warnings || []).forEach((warning) => addLog(warning, "WARNING"));
    updateSourceDownloadProgress({
      stage: "complete",
      percent: 100,
      message: result.subtitlePath ? "Đã tải video và transcript tiếng Anh" : "Đã tải video",
      detail: result.subtitlePath ? "Video và SRT đã được chọn tự động." : "Không có transcript tiếng Anh; video đã được chọn tự động."
    });
    showToast(result.subtitlePath ? "Đã tải video 1080p và transcript tiếng Anh." : "Đã tải video. Không tìm thấy transcript tiếng Anh.");
  } catch (error) {
    updateSourceDownloadProgress({
      stage: "error",
      percent: 0,
      message: "Không tải được video",
      detail: error.message
    });
    addLog(error.message, "ERROR");
    showToast(error.message);
  } finally {
    el.downloadSourceUrl.disabled = false;
    el.sourceDownloadUrl.disabled = false;
    writeSetupDraft();
  }
}

function bindEvents() {
  if (el.runAutoReviewCurrent) el.runAutoReviewCurrent.addEventListener("click", runAutoReviewAndRenderCurrent);
  if (el.runAutoReviewAll) el.runAutoReviewAll.addEventListener("click", runAutoReviewAndRenderAll);
  window.cineviral.onSourceDownloadProgress?.(updateSourceDownloadProgress);
  el.cancelConfirmAction?.addEventListener("click", () => closeConfirmAction(false));
  el.submitConfirmAction?.addEventListener("click", () => closeConfirmAction(true));
  el.confirmActionModal?.addEventListener("click", (event) => {
    if (event.target === el.confirmActionModal) closeConfirmAction(false);
  });
  document.addEventListener("keydown", (event) => {
    if (!confirmActionResolver || el.confirmActionModal?.classList.contains("hidden")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeConfirmAction(false);
    } else if (event.key === "Enter") {
      event.preventDefault();
      closeConfirmAction(true);
    }
  });
  el.prevStep.addEventListener("click", () => {
    state.currentStep = Math.max(1, state.currentStep - 1);
    renderSteps();
  });
  el.nextStep.addEventListener("click", () => {
    if (!validateCurrentStep()) {
      return;
    }
    state.currentStep = Math.min(6, state.currentStep + 1);
    renderSteps();
  });
  el.startIngest.addEventListener("click", createAndIngestProject);
  el.mirrorPickVideo?.addEventListener("click", selectMirrorVideo);
  el.mirrorRun?.addEventListener("click", runMirrorTool);
  el.confirmProject.addEventListener("click", confirmProjectFolder);
  el.refreshOllamaModels.addEventListener("click", () => loadOllamaModels());
  el.ollamaVisionAssist.addEventListener("change", () => {
    if (el.ollamaVisionAssist.checked) {
      loadOllamaModels();
    }
  });
  el.aiProvider.addEventListener("change", syncAiProviderSettingsUi);
  el.loadProject.addEventListener("click", loadSelectedProject);
  el.backToSetup.addEventListener("click", openBackSetupModal);
  el.cancelBackSetup.addEventListener("click", () => el.backSetupModal.classList.add("hidden"));
  el.selectAllSetupSteps?.addEventListener("click", () => {
    document.querySelectorAll("[data-preserve-step]").forEach((checkbox) => {
      checkbox.checked = true;
    });
  });
  el.clearAllSetupSteps?.addEventListener("click", () => {
    document.querySelectorAll("[data-preserve-step]").forEach((checkbox) => {
      checkbox.checked = false;
    });
  });
  el.confirmBackSetup.addEventListener("click", confirmBackToSetup);

  document.querySelectorAll("[data-source-method]").forEach((button) => {
    button.addEventListener("click", () => setSourceMethod(button.dataset.sourceMethod));
  });

  el.browseVideo.addEventListener("click", async () => {
    const selected = await window.cineviral.pickVideo();
    if (!selected) return;
    await applySourceSelection({ videoPath: selected, clearSourceUrl: true });
    addLog(`Đã chọn nguồn: ${selected}`);
  });

  if (el.sourceDropzone) {
    el.sourceDropzone.addEventListener("click", () => {
      el.browseVideo?.click();
    });
    el.sourceDropzone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        el.browseVideo?.click();
      }
    });
    el.sourceDropzone.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.stopPropagation();
      el.sourceDropzone.classList.add("dragover");
    });
    el.sourceDropzone.addEventListener("dragleave", (event) => {
      event.preventDefault();
      event.stopPropagation();
      el.sourceDropzone.classList.remove("dragover");
    });
    el.sourceDropzone.addEventListener("drop", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      el.sourceDropzone.classList.remove("dragover");
      const files = event.dataTransfer?.files;
      if (!files || !files.length) return;
      const file = files[0];
      const filePath = file.path;
      if (!filePath) {
        showToast("Không thể đọc đường dẫn file trực tiếp.");
        return;
      }
      const ext = filePath.toLowerCase().split(".").pop();
      const validExts = ["mp4", "mov", "mkv", "avi", "webm", "m4v"];
      if (!validExts.includes(ext)) {
        showToast("File không thuộc định dạng video hỗ trợ (.mp4, .mov, .mkv, .avi, .webm).");
        return;
      }
      await applySourceSelection({ videoPath: filePath, clearSourceUrl: true });
      addLog(`Đã chọn video nguồn qua kéo thả: ${filePath}`);
    });
  }

  el.changeSourceVideoBtn?.addEventListener("click", () => {
    el.browseVideo?.click();
  });
  el.downloadSourceUrl?.addEventListener("click", downloadSourceFromUrl);
  el.sourceDownloadUrl?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    downloadSourceFromUrl();
  });
  el.sourceDownloadUrl?.addEventListener("input", () => {
    updateSourceSelectionUi();
    renderHighlightPromptTemplate();
  });
  el.sourceDownloadUrl?.addEventListener("change", () => {
    writeSetupDraft();
    renderHighlightPromptTemplate();
  });

  el.browseSubtitle.addEventListener("click", async () => {
    const selected = await window.cineviral.pickSubtitle();
    if (selected) {
      el.subtitlePath.value = selected;
      invalidateManualGeminiPack("Nguồn transcript đã thay đổi.");
      addLog(`Đã chọn SRT: ${selected}`);
      updateReview();
      updateSourceSelectionUi();
      writeSetupDraft();
    }
  });
  el.clearSubtitle?.addEventListener("click", () => {
    if (!el.subtitlePath.value) {
      showToast("Chưa chọn file SRT.");
      return;
    }
    el.subtitlePath.value = "";
    invalidateManualGeminiPack("Nguồn transcript đã thay đổi.");
    addLog("Đã bỏ chọn SRT. Tool sẽ dùng Whisper nếu bật tự động nhận diện.");
    showToast("Đã xóa lựa chọn SRT.");
    updateReview();
    updateSourceSelectionUi();
    writeSetupDraft();
  });

  el.browseStoryScript?.addEventListener("click", async () => {
    let selectedPaths = isHighlightCutMode() || isManualGeminiProMode() || isPodcastViralMode()
      ? await window.cineviral.pickJsonFiles()
      : [await window.cineviral.pickJson()].filter(Boolean);
    if (!selectedPaths.length) return;
    const inspectedFiles = await window.cineviral.inspectGeminiJsonFiles(selectedPaths);
    const unreadable = inspectedFiles.find((item) => !item.validJson);
    if (unreadable) {
      showToast(`Không đọc được JSON: ${unreadable.error || unreadable.filePath || "file không hợp lệ"}`);
      addLog(`JSON không hợp lệ: ${unreadable.error || unreadable.filePath}`, "ERROR");
      return;
    }
    const accessFailure = inspectedFiles.find((item) => item.type === "gemini_input_access_failure");
    if (accessFailure) {
      const missing = [...(accessFailure.missingInputs || []), ...(accessFailure.unreadableInputs || [])]
        .filter(Boolean)
        .join(", ");
      const reason = accessFailure.mismatchDetails || (missing ? `Thiếu/không đọc được: ${missing}` : "Gemini không truy cập đủ input.");
      showToast(`Gemini đã dừng để tránh suy đoán: ${reason}`);
      addLog(
        `Gemini Input Access Gate không đạt (${accessFailure.stage || "không rõ bước"}): ${reason}`
        + (accessFailure.recommendedAction ? ` Cách xử lý: ${accessFailure.recommendedAction}` : ""),
        "WARNING"
      );
      return;
    }
    const reviewFiles = inspectedFiles.filter((item) => item.importRoute === "review_revision" || item.type === "gemini_draft_review");
    if (reviewFiles.length) {
      if (selectedPaths.length !== 1 || reviewFiles.length !== 1) {
        showToast("Không thể trộn file review V2 với các variant V1. Hãy chọn riêng một file gemini-draft-review.json.");
        return;
      }
      if (!state.currentProject || !["highlight_cut", "satisfying_storytime"].includes(state.currentProject.mode)) {
        showToast("Đây là file review V2. Hãy tải project đã dùng để render V1 rồi chọn lại; V2 cần project gốc để kiểm tra revision.");
        addLog(`Đã nhận diện ${reviewFiles[0].filePath} là review V2 nhưng chưa có project gốc phù hợp.`, "WARNING");
        return;
      }
      const setupSourcePath = String(el.sourceVideoPath?.value || "").trim().toLowerCase();
      const projectSourcePath = String(state.currentProject.sourceVideoPath || "").trim().toLowerCase();
      if (setupSourcePath && projectSourcePath && setupSourcePath !== projectSourcePath) {
        showToast("File V2 thuộc project đang mở, nhưng video nguồn trong phần thiết lập đã thay đổi. Hãy tải đúng project gốc trước khi import.");
        addLog("Đã chặn tự import V2 vì video nguồn trong thiết lập không khớp project đang mở.", "WARNING");
        return;
      }
      await importReviewedScriptPath(reviewFiles[0].filePath, { autoRouted: true });
      return;
    }
    if (isStoryRecutMode()) {
      const selected = inspectedFiles[0];
      if (!selected?.validJson) {
        showToast(`Không đọc được JSON: ${selected?.error || "file không hợp lệ"}`);
        addLog(`Story Recut JSON không hợp lệ: ${selected?.error || selectedPaths[0]}`, "error");
        return;
      }
      if (selected.type === "scene_evidence") {
        showToast("Bạn đang chọn scene evidence của Giai đoạn 1. Hãy chọn story-recut.json do Gemini tạo ở Giai đoạn 2.");
        addLog(`Đã từ chối ${selectedPaths[0]}: đây là scene evidence (${selected.evidenceCount} mục), không phải Story Recut script.`, "warning");
        return;
      }
      if (selected.type !== "story_recut_script" || selected.segmentCount < 1) {
        showToast('File không đúng schema Story Recut: cần mảng "segments" có dữ liệu.');
        addLog(`Đã từ chối ${selectedPaths[0]}: thiếu mảng segments hợp lệ.`, "warning");
        return;
      }
    }
    if (isDiyStoryRemixMode()) {
      const selected = inspectedFiles[0];
      if (selectedPaths.length !== 1 || selected?.type !== "story_recut_script" || selected?.segmentCount < 1
        || selected?.workflow !== "diy_story_remix") {
        showToast('DIY Story Remix cần đúng một JSON có workflow="diy_story_remix" và segments có dữ liệu.');
        return;
      }
    }
    if (isPodcastViralMode()) {
      const expectedCount = Number(el.podcastOutputCount?.value || 1);
      if (selectedPaths.length !== expectedCount) {
        showToast(`Bạn đã yêu cầu ${expectedCount} output; hãy chọn cùng lúc đúng ${expectedCount} file JSON.`);
        return;
      }
      const failure = inspectedFiles.find((item) => item.type === "podcast_input_access_failure");
      if (failure) {
        showToast("Gemini báo không truy cập đủ input. Hãy sửa URL/file theo recommendedAction rồi tạo lại EDL.");
        return;
      }
      const invalid = inspectedFiles.find((item) => item.type !== "podcast_edit_decision_list" || item.segmentCount < 1 || item.accessGranted !== true);
      if (invalid) {
        showToast("Podcast JSON không hợp lệ hoặc chưa vượt qua accessAudit.");
        return;
      }
      const indices = inspectedFiles.map((item) => Number(item.scriptId || 0));
      if (indices.some((value) => value < 1 || value > expectedCount) || new Set(indices).size !== indices.length) {
        showToast(`outputIndex phải duy nhất trong khoảng 1-${expectedCount}.`);
        return;
      }
      const countMismatch = inspectedFiles.find((item) => Number(item.outputCount || 0) !== expectedCount);
      if (countMismatch) {
        showToast(`JSON output ${countMismatch.scriptId || "?"} khai báo outputCount không khớp ${expectedCount}.`);
        return;
      }
      const sourceIds = new Set(inspectedFiles.map((item) => item.sourceMatchId).filter(Boolean));
      if (sourceIds.size !== 1) {
        showToast("Các Podcast JSON không cùng sourceMatchId.");
        return;
      }
      selectedPaths = inspectedFiles.sort((left, right) => Number(left.scriptId) - Number(right.scriptId)).map((item) => item.filePath);
    }
    if (isManualGeminiProMode() && selectedPaths.length > 5) {
      showToast("Chế độ kịch bản độc lập nhận tối đa 5 JSON variant.");
      return;
    }
    if (isManualGeminiProMode()) {
      const requestedIds = getRequestedIndependentScriptIds();
      const invalid = inspectedFiles.find((item) => !isManualGeminiV1Artifact(item));
      if (invalid) {
        showToast(
          `File ${invalid.filePath || "JSON"} không phải variant V1 hợp lệ. `
          + `Tool nhận dạng: ${invalid.type || "không xác định"}; cần segments hoặc narrativeBeats có dữ liệu.`
        );
        return;
      }
      const scriptIds = inspectedFiles.map((item) => Number(item.scriptId || 0));
      const invalidScriptId = scriptIds.find((scriptId) => !requestedIds.includes(scriptId));
      if (invalidScriptId !== undefined) {
        showToast(`JSON phải thuộc các script đã yêu cầu: ${requestedIds.join(", ")}.`);
        return;
      }
      if (new Set(scriptIds).size !== scriptIds.length) {
        showToast("Các JSON đã chọn đang trùng scriptId. Mỗi variant chỉ được chọn một lần.");
        return;
      }
      selectedPaths = inspectedFiles
        .sort((left, right) => requestedIds.indexOf(Number(left.scriptId)) - requestedIds.indexOf(Number(right.scriptId)))
        .map((item) => item.filePath);
    }
    el.storyScriptPath.dataset.paths = JSON.stringify(selectedPaths);
    el.storyScriptPath.value = selectedPaths.length > 1
      ? `Đã chọn ${selectedPaths.length} file JSON`
      : selectedPaths[0];
    addLog(isPodcastViralMode()
      ? `Đã chọn ${selectedPaths.length} Podcast EDL JSON.`
      : isDiyStoryRemixMode()
      ? `Đã chọn DIY Story Remix JSON: ${selectedPaths[0]}`
      : isStoryRecutMode()
      ? `Đã chọn Story Recut JSON: ${selectedPaths[0]}`
      : isHighlightCutMode() || isManualGeminiProMode()
      ? `Đã chọn ${selectedPaths.length} JSON variant.`
      : `Đã chọn Storytime JSON: ${selectedPaths[0]}`);
    updateReview();
    writeSetupDraft();
  });

  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.classList.contains("hidden") || button.classList.contains("mode-category-hidden")) return;
      selectSetupMode(button.dataset.mode);
    });
  });

  document.querySelectorAll("[data-mode-category-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const category = button.dataset.modeCategoryTab;
      selectSetupMode(modeCategoryMemory[category] || MODE_CATEGORY_DEFAULTS[category]);
    });
  });

  const handlePromptOptionChange = () => {
    syncManualGeminiPromptOptionsUi();
    if (isManualGeminiProMode()) {
      invalidateManualGeminiPack("Cấu hình prompt Gemini đã thay đổi.");
    }
    updateReview();
    writeSetupDraft();
  };
  [
    el.autoStoryTargetMin,
    el.autoStoryTargetMax,
    el.autoStoryOutputCount,
    el.autoStoryNarrationStyle,
    el.autoStoryAudioBalance
  ].forEach((node) => {
    node?.addEventListener("change", () => {
      const min = Math.max(65, Number(el.autoStoryTargetMin?.value || 65));
      if (el.autoStoryTargetMin) el.autoStoryTargetMin.value = String(min);
      if (el.autoStoryTargetMax && Number(el.autoStoryTargetMax.value || 0) < min) el.autoStoryTargetMax.value = String(min);
      updateReview();
      writeSetupDraft();
    });
  });
  el.autoStoryEngineVersion?.addEventListener("change", () => {
    // Convenience for the first V3 test: prefer a single output unless the user changed it.
    if (Number(el.autoStoryEngineVersion.value) === 3 && el.autoStoryOutputCount && el.autoStoryOutputCount.value === "2") {
      el.autoStoryOutputCount.value = "1";
    }
    updateAutoStoryEngineHint();
    updateReview();
    writeSetupDraft();
  });
  [
    el.manualPromptProfile,
    el.manualIndependentScriptCount,
    el.manualIndependentHookMax,
    el.manualIndependentNarratorTone,
    el.manualIndependentAudioBalance,
    el.manualIndependentPacing,
    el.manualIndependentEnding,
    el.manualIndependentScript1Min,
    el.manualIndependentScript1Max,
    el.manualIndependentScript2Min,
    el.manualIndependentScript2Max,
    el.manualIndependentScript3Min,
    el.manualIndependentScript3Max,
    el.manualIndependentScript4Min,
    el.manualIndependentScript4Max,
    el.manualIndependentScript5Min,
    el.manualIndependentScript5Max,
    el.manualIndependentOverlays,
    el.manualIndependentPowerWords,
    el.manualSeriesSharedHook,
    el.manualSeriesInterleavedAudio,
    el.manualSeriesNarratorStyle,
    el.manualSeriesCliffhanger,
    el.manualSeriesOverlays,
    el.manualSeriesDurationMin,
    el.manualSeriesDurationMax,
    el.manualSeriesPacing,
    el.manualSeriesPowerWords
  ].forEach((node) => {
    node?.addEventListener("change", handlePromptOptionChange);
    if ([el.manualSeriesPowerWords, el.manualIndependentPowerWords].includes(node)) {
      node?.addEventListener("input", handlePromptOptionChange);
    }
  });
  el.manualIndependentHookPriority?.addEventListener("click", (event) => {
    const button = event.target.closest(".hook-priority-up, .hook-priority-down");
    const row = button?.closest(".hook-priority-row");
    if (!button || !row) return;
    moveIndependentHookPriority(row.dataset.hookType, button.classList.contains("hook-priority-up") ? -1 : 1);
    handlePromptOptionChange();
  });
  el.diyStoryAngle?.addEventListener("change", () => {
    if (isDiyStoryRemixMode()) invalidateManualGeminiPack("Góc kể DIY đã thay đổi.");
    updateReview();
    writeSetupDraft();
  });

  document.querySelectorAll(".voice-tab").forEach((button) => {
    button.addEventListener("click", () => {
      setVoiceTab(button.dataset.voiceTab);
      rememberVoiceSetupSoon();
    });
  });

  el.browseVoiceSample.addEventListener("click", async () => {
    const selected = await window.cineviral.pickAudio();
    if (!selected) return;
    el.voiceSamplePath.value = selected;
    el.cloneVoiceStatus.innerHTML = `<strong>Đã chọn file mẫu.</strong><br>${escapeHtml(selected)}`;
    setVoiceTab("clone");
    rememberVoiceSetupSoon();
  });

  el.previewVoiceSample.addEventListener("click", () => playLocalAudio(el.voiceSamplePath.value));

  el.useClonedVoice.addEventListener("click", () => {
    if (!el.voiceSamplePath.value.trim()) {
      showToast("Hãy chọn file giọng mẫu trước.");
      return;
    }
    setVoiceTab("clone");
    el.cloneVoiceStatus.innerHTML = `<strong>Đã chọn giọng clone để render.</strong><br>${escapeHtml(el.voiceSamplePath.value)}`;
    rememberVoiceSetupSoon();
  });

  el.refreshPresetVoices.addEventListener("click", loadPresetVoices);
  el.presetVoiceProvider.addEventListener("change", () => {
    syncSelectedVoiceTuningVisibility();
    rememberVoiceSetupSoon();
    loadPresetVoices();
  });
  el.presetVoiceList.addEventListener("change", () => {
    updatePresetVoiceInfoFromSelection();
    rememberVoiceSetupSoon();
  });
  el.usePresetVoice.addEventListener("click", () => {
    if (!el.presetVoiceList.value) {
      showToast("Hãy tải và chọn một giọng mẫu trước.");
      return;
    }
    el.defaultVoiceProvider.value = el.presetVoiceProvider.value || "edge_neural";
    if (el.presetVoiceProvider.value === "elevenlabs") {
      el.elevenLabsVoiceId.value = el.presetVoiceList.value;
    }
    setVoiceTab("preset");
    updatePresetVoiceInfoFromSelection();
    rememberVoiceSetupSoon();
  });
  el.previewPresetVoice.addEventListener("click", async () => {
    const previewLanguage = el.targetLanguage.value || "vi";
    await previewVoiceFromControls({
      providerEl: el.presetVoiceProvider,
      listEl: el.presetVoiceList,
      buttonEl: el.previewPresetVoice,
      language: previewLanguage,
      text: String(previewLanguage).toLowerCase().startsWith("en")
        ? "Hello, this is a short voice preview for your video."
        : "Xin chào, đây là đoạn nghe thử giọng đọc cho video của bạn.",
      onSuccess: rememberVoiceSetupSoon
    });
  });

  el.heroPreviewVoiceBtn?.addEventListener("click", () => {
    const tab = document.querySelector(".voice-tab.active")?.dataset.voiceTab || "preset";
    if (tab === "preset") {
      el.previewPresetVoice?.click();
    } else if (tab === "clone") {
      el.previewVoiceSample?.click();
    } else {
      showToast("Đang ở chế độ thiết kế giọng AI.");
    }
  });

  document.querySelectorAll(".btn-voice-chip").forEach((chip) => {
    chip.addEventListener("click", async () => {
      document.querySelectorAll(".btn-voice-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      const provider = chip.dataset.quickProvider;
      const voiceId = chip.dataset.quickVoice;
      if (el.presetVoiceProvider && provider) {
        el.presetVoiceProvider.value = provider;
      }
      setVoiceTab("preset");
      if (el.presetVoiceList) {
        el.presetVoiceList.dataset.preferredVoiceId = voiceId;
      }
      syncSelectedVoiceTuningVisibility();
      await loadPresetVoices();
      if (el.presetVoiceList && voiceId) {
        el.presetVoiceList.value = voiceId;
      }
      updatePresetVoiceInfoFromSelection();
      syncHeroVoiceCard();
      rememberVoiceSetupSoon();
    });
  });
  el.refreshDraftVoices?.addEventListener("click", loadDraftVoices);
  el.draftVoiceProvider?.addEventListener("change", () => {
    el.draftVoiceMode.value = "custom";
    el.draftVoiceList.innerHTML = "";
    el.draftVoiceId.value = "";
    writeSetupDraft();
    loadDraftVoices();
  });
  el.draftVoiceList?.addEventListener("change", () => {
    el.draftVoiceMode.value = "custom";
    updateDraftVoiceInfoFromSelection();
    writeSetupDraft();
  });
  el.draftVoiceId?.addEventListener("input", () => {
    if (el.draftVoiceId.value.trim()) {
      el.draftVoiceMode.value = "custom";
    }
  });
  el.previewDraftVoice?.addEventListener("click", async () => {
    const payload = getDraftVoiceCalibrationPayload();
    await previewVoiceFromControls({
      providerEl: el.draftVoiceProvider,
      listEl: el.draftVoiceList,
      fallbackVoiceIdEl: el.draftVoiceId,
      buttonEl: el.previewDraftVoice,
      language: payload.language || "en",
      text: "This is a quick draft voice preview for checking pacing and timing.",
      onSuccess: () => {
        el.draftVoiceMode.value = "custom";
        writeSetupDraft();
      }
    });
  });
  el.useCurrentVoiceForDraft?.addEventListener("click", () => {
    const selected = getSelectedVoiceConfig();
    el.draftVoiceMode.value = "custom";
    el.draftVoiceProvider.value = selected.voiceProvider || "edge_neural";
    el.draftVoiceId.value = selected.voiceId || "";
    el.draftVoiceList.dataset.preferredVoiceId = selected.voiceId || "";
    if ([...el.draftVoiceList.options].some((option) => option.value === selected.voiceId)) {
      el.draftVoiceList.value = selected.voiceId;
      updateDraftVoiceInfoFromSelection();
    }
    writeSetupDraft();
    showToast("Đã dùng giọng đang chọn cho bản nháp.");
  });
  el.calibrateVoiceSpeed?.addEventListener("click", calibrateSelectedVoiceSpeed);
  el.calibrateDraftVoiceSpeed?.addEventListener("click", calibrateDraftVoiceSpeed);
  el.copyVoiceBudgetPrompt?.addEventListener("click", () => copyVoiceBudgetPrompt("final"));
  el.copyDraftVoiceBudgetPrompt?.addEventListener("click", () => copyVoiceBudgetPrompt("draft"));
  el.copyViralRepairPrompt?.addEventListener("click", copyViralRepairPrompt);
  el.copyHighlightPromptTemplate?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    copyHighlightPromptTemplate();
  });
  el.createManualGeminiPack?.addEventListener("click", createManualGeminiAnalysisPack);
  el.createAndRunStage1Ai?.addEventListener("click", createAndRunConfiguredStage1);
  el.configuredAiAutoLevel?.addEventListener("change", () => {
    writeSetupDraft();
    syncConfiguredAiWorkflowUi();
  });
  el.runManualAntigravityStage1?.addEventListener("click", runManualAntigravityStage1);
  el.cancelManualAntigravityStage1?.addEventListener("click", cancelManualAntigravityStage1);
  el.openManualAntigravityResult?.addEventListener("click", () => openManualStageFolder(
    el.openManualAntigravityResult,
    "Chưa có kết quả AI."
  ));
  el.storyRecutRightsConfirmed?.addEventListener("change", writeSetupDraft);
  [el.podcastYoutubeUrl, el.podcastWorkflowMode, el.podcastOutputCount, el.podcastCleanupMode, el.podcastTargetMin, el.podcastTargetMax].forEach((node) => {
    node?.addEventListener("change", () => {
      if (isPodcastViralMode()) invalidateManualGeminiPack("Cấu hình Podcast hoặc URL YouTube đã thay đổi.");
      updateReview();
      writeSetupDraft();
    });
  });
  el.podcastYoutubeUrl?.addEventListener("input", writeSetupDraft);
  el.importManualGeminiEvidence?.addEventListener("click", importManualGeminiEvidence);
  el.importManualGeminiBlueprint?.addEventListener("click", importManualGeminiBlueprint);
  el.openManualGeminiVariants?.addEventListener("click", async () => {
    const variantPath = el.openManualGeminiVariants?.dataset.openPath;
    if (!variantPath) {
      showToast("Chưa có prompt variant. Hãy nhập story blueprint trước.");
      return;
    }
    await window.cineviral.openFile(variantPath);
  });
  el.openManualGeminiPack?.addEventListener("click", () => (
    openManualStageFolder(el.openManualGeminiPack, "Chưa có thư mục Giai đoạn 1.")
  ));
  el.openManualGeminiEvidenceFolder?.addEventListener("click", () => (
    openManualStageFolder(el.openManualGeminiEvidenceFolder, "Chưa có thư mục đầu ra Giai đoạn 2.")
  ));
  el.openManualGeminiBlueprintFolder?.addEventListener("click", () => (
    openManualStageFolder(el.openManualGeminiBlueprintFolder, "Chưa có thư mục Blueprint Giai đoạn 3.")
  ));

  document.querySelectorAll(".left-panel .tab").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".left-panel .tab").forEach((node) => node.classList.remove("active"));
      button.classList.add("active");
      ["dialogue", "mixer"].forEach((name) => {
        $(`${name}-tab`)?.classList.toggle("hidden", button.dataset.tab !== name);
      });
      const editing = button.dataset.tab === "mixer";
      if (editing) {
        activateVideoEditLivePreview();
        setVideoWysiwygEditing(true);
      } else {
        switchVideoEditPreviewMode(false);
        setVideoWysiwygEditing(false);
        setSubtitleMaskEditorActive(false);
      }
      syncPreviewNativeControls();
    });
  });

  document.querySelectorAll(".right-panel-tabs .tab").forEach((button) => {
    button.addEventListener("click", () => {
      switchRightTab(button.dataset.rightTab || "log");
    });
  });

  [el.projectTitle, el.subtitlePath, el.framePreset, el.autoWhisper, el.targetLanguage, el.targetDuration, el.voiceSpeed, el.viralOptimization, el.viralPlatform, el.viralAngleSetting, el.retentionAggressiveness, el.spoilerControl, el.loopEnding, el.draftVoiceMode, el.draftVoiceProvider, el.draftVoiceList, el.draftVoiceId].filter(Boolean).forEach((node) => {
    node.addEventListener("input", () => {
      updateReview();
      writeSetupDraft();
    });
    node.addEventListener("change", () => {
      updateReview();
      writeSetupDraft();
    });
  });
  [
    el.sourceVideoPath, el.storyScriptPath, el.trimStart, el.trimEnd, el.visualRemix, el.framePreset,
    el.autoWhisper, el.sourceLanguage, el.targetLanguage,
    el.storytimeContinuousVoice,
    el.sourceSubtitleMaskEnabled, el.sourceSubtitleMaskMode, el.sourceSubtitleMaskHeight,
    el.sourceSubtitleMaskBottom, el.sourceSubtitleMaskStrength, el.sourceSubtitleMaskX,
    el.sourceSubtitleMaskWidth
    , el.videoCanvasEnabled, el.videoCanvasAspect, el.videoCanvasWidth, el.videoCanvasHeight,
    el.blurBackgroundEnabled, el.blurBackgroundStrength, el.topCaptionEnabled,
    el.topCaptionText, el.topCaptionStyle, el.topCaptionFontSize, el.topCaptionY,
    el.cameraLabelEnabled, el.cameraLabelText,
    el.partLabelEnabled, el.partLabelAuto, el.partLabelText, el.partLabelStyle,
    el.partLabelAlignment, el.partLabelUppercase, el.partLabelTextColor,
    el.partLabelBackgroundColor, el.partLabelFontSize, el.partLabelOpacity,
    el.partLabelX, el.partLabelY
  ].filter(Boolean).forEach((node) => {
    node.addEventListener("input", writeSetupDraft);
    node.addEventListener("change", writeSetupDraft);
  });

  [
    el.voiceGenderAge, el.voicePitch, el.voiceAccent, el.voiceTrait, el.voicePrompt,
    el.voiceSamplePath, el.presetVoiceProvider, el.presetVoiceList
  ].filter(Boolean).forEach((node) => {
    node.addEventListener("input", rememberVoiceSetupSoon);
    node.addEventListener("change", rememberVoiceSetupSoon);
  });

  [el.voiceGenderAge, el.voicePitch, el.voiceTrait].filter(Boolean).forEach((node) => {
    node.addEventListener("change", () => {
      if (el.voicePrompt && el.voiceGenderAge && el.voicePitch && el.voiceTrait) {
        el.voicePrompt.value = `${el.voiceGenderAge.value}, ${el.voicePitch.value} pitch, ${el.voiceTrait.value}`;
        rememberVoiceSetupSoon();
      }
    });
  });

  [
    [el.voiceVolume, el.voiceVolValue],
    [el.sourceVolume, el.sourceVolValue],
    [el.bgmVolume, el.bgmVolValue],
    [el.ducking, el.duckingValue],
    [el.sourceSubtitleMaskHeight, el.sourceSubtitleMaskHeightValue],
    [el.sourceSubtitleMaskBottom, el.sourceSubtitleMaskBottomValue],
    [el.sourceSubtitleMaskStrength, el.sourceSubtitleMaskStrengthValue]
    , [el.blurBackgroundStrength, el.blurBackgroundStrengthValue]
    , [el.topCaptionFontSize, el.topCaptionFontSizeValue]
    , [el.topCaptionY, el.topCaptionYValue]
    , [el.partLabelFontSize, el.partLabelFontSizeValue]
    , [el.partLabelOpacity, el.partLabelOpacityValue]
    , [el.partLabelX, el.partLabelXValue]
    , [el.partLabelY, el.partLabelYValue]
    , [el.foregroundScale, el.foregroundScaleValue]
  ].filter(([input, label]) => Boolean(input && label)).forEach(([input, label]) => {
    input.addEventListener("input", () => {
      activateVideoEditLivePreview();
      const plainValue = input === el.sourceSubtitleMaskStrength
        || input === el.blurBackgroundStrength
        || input === el.topCaptionFontSize
        || input === el.partLabelFontSize;
      label.textContent = plainValue ? `${input.value}` : `${input.value}%`;
      updateVideoDecorationPreview();
      persistVideoEditSettingsSoon();
    });
  });

  [
    el.videoCanvasEnabled, el.videoCanvasAspect, el.videoCanvasWidth, el.videoCanvasHeight,
    el.blurBackgroundEnabled, el.topCaptionEnabled, el.topCaptionText, el.topCaptionStyle,
    el.cameraLabelEnabled, el.cameraLabelText
    , el.foregroundScale, el.partLabelEnabled, el.partLabelAuto, el.partLabelText,
    el.partLabelStyle, el.partLabelAlignment, el.partLabelUppercase,
    el.partLabelTextColor, el.partLabelBackgroundColor
  ].filter(Boolean).forEach((input) => {
    input.addEventListener("input", () => {
      activateVideoEditLivePreview();
      updateVideoDecorationPreview();
      persistVideoEditSettingsSoon();
    });
    input.addEventListener("change", () => {
      activateVideoEditLivePreview();
      updateVideoDecorationPreview();
      persistVideoEditSettingsSoon(0);
    });
  });

  [
    el.voiceVolume, el.sourceVolume, el.bgmVolume, el.ducking, el.showSubtitles,
    el.storytimeContinuousVoice, el.omniVoiceRenderMode, el.mixerVisualRemix,
    el.autoFitVoice, $("subtitle-style"), $("transition-style"), $("bgm-path")
  ].forEach((input) => {
    input?.addEventListener("input", () => persistVideoEditSettingsSoon());
    input?.addEventListener("change", () => persistVideoEditSettingsSoon(0));
  });

  el.videoEditScope?.querySelectorAll("[data-video-edit-scope]").forEach((button) => {
    button.addEventListener("click", async () => {
      const nextScope = button.dataset.videoEditScope;
      if (nextScope === "variant" && state.currentProject?.mode !== "highlight_cut") return;
      if (nextScope === state.videoEditScope) return;
      clearTimeout(videoEditSaveTimer);
      await persistCurrentVideoEditSettings().catch(() => {});
      state.videoEditScope = nextScope;
      el.videoEditScope.querySelectorAll("[data-video-edit-scope]").forEach((item) => {
        item.classList.toggle("active", item.dataset.videoEditScope === nextScope);
      });
      syncProjectSettingsControls(state.currentProject);
    });
  });

  el.topCaptionEnabled?.addEventListener("change", () => {
    if (el.topCaptionEnabled.checked) {
      el.topCaptionText.dataset.autoFromScript = "true";
      syncAutoTopCaptionFromScript(state.currentProject, { force: true });
    }
    updateVideoDecorationPreview();
  });
  el.topCaptionText?.addEventListener("input", () => {
    el.topCaptionText.dataset.autoFromScript = "false";
    if (el.topCaptionSource) el.topCaptionSource.textContent = "Đang dùng tiêu đề do bạn chỉnh sửa.";
  });
  el.partLabelAuto?.addEventListener("change", () => {
    if (el.partLabelText) el.partLabelText.disabled = el.partLabelAuto.checked;
    updateVideoDecorationPreview();
    persistVideoEditSettingsSoon(0);
  });

  el.sourceSubtitleMaskEnabled?.addEventListener("change", () => {
    activateVideoEditLivePreview();
    updateSubtitleMaskPreview();
    if (el.sourceSubtitleMaskEnabled.checked) setSubtitleMaskEditorActive(true);
    persistSubtitleMaskSettingsSoon(0);
  });
  el.sourceSubtitleMaskMode?.addEventListener("change", () => {
    activateVideoEditLivePreview();
    updateSubtitleMaskPreview();
    persistSubtitleMaskSettingsSoon(0);
  });
  [el.sourceSubtitleMaskHeight, el.sourceSubtitleMaskBottom, el.sourceSubtitleMaskStrength].forEach((input) => {
    input?.addEventListener("input", () => persistSubtitleMaskSettingsSoon());
  });
  el.editSourceSubtitleMask?.addEventListener("click", () => {
    activateVideoEditLivePreview();
    setSubtitleMaskEditorActive(!subtitleMaskEditorActive);
    updateSubtitleMaskPreview();
  });
  el.resetSourceSubtitleMask?.addEventListener("click", () => {
    activateVideoEditLivePreview();
    setSubtitleMaskRect({ x: 0, top: 78, width: 100, height: 16 }, { persist: true });
    if (el.sourceSubtitleMaskEnabled?.checked) setSubtitleMaskEditorActive(true);
  });
  el.sourceSubtitleMaskEditor?.addEventListener("pointerdown", beginSubtitleMaskPointer);
  el.sourceSubtitleMaskEditor?.addEventListener("pointermove", moveSubtitleMaskPointer);
  el.sourceSubtitleMaskEditor?.addEventListener("pointerup", endSubtitleMaskPointer);
  el.sourceSubtitleMaskEditor?.addEventListener("pointercancel", endSubtitleMaskPointer);
  el.foregroundLayoutEditor?.addEventListener("pointerdown", handleForegroundPointerDown);
  el.foregroundLayoutEditor?.addEventListener("pointermove", handleForegroundPointerMove);
  el.foregroundLayoutEditor?.addEventListener("pointerup", handleForegroundPointerUp);
  el.foregroundLayoutEditor?.addEventListener("pointercancel", handleForegroundPointerUp);
  el.videoTitleOverlay?.addEventListener("pointerdown", handleTitlePointerDown);
  el.videoTitleOverlay?.addEventListener("pointermove", handleTitlePointerMove);
  el.videoTitleOverlay?.addEventListener("pointerup", handleTitlePointerUp);
  el.videoTitleOverlay?.addEventListener("pointercancel", handleTitlePointerUp);
  el.videoPartLabelOverlay?.addEventListener("pointerdown", handlePartLabelPointerDown);
  el.videoPartLabelOverlay?.addEventListener("pointermove", handlePartLabelPointerMove);
  el.videoPartLabelOverlay?.addEventListener("pointerup", handlePartLabelPointerUp);
  el.videoPartLabelOverlay?.addEventListener("pointercancel", handlePartLabelPointerUp);
  el.resetForegroundLayout?.addEventListener("click", () => {
    activateVideoEditLivePreview();
    if (el.foregroundScale) el.foregroundScale.value = "100";
    if (el.foregroundScaleValue) el.foregroundScaleValue.textContent = "100%";
    if (el.foregroundX) el.foregroundX.value = "50";
    if (el.foregroundY) el.foregroundY.value = "50";
    updateVideoDecorationPreview();
    persistVideoEditSettingsSoon(0);
  });

  el.previewPlayer?.addEventListener("loadedmetadata", () => {
    syncPreviewBackgroundPlayback(true);
    updateVideoDecorationPreview();
    updateSubtitleMaskPreview();
  });
  el.previewPlayer?.addEventListener("seeking", () => syncPreviewBackgroundPlayback(true));
  el.previewPlayer?.addEventListener("timeupdate", () => syncPreviewBackgroundPlayback(false));
  el.previewPlayer?.addEventListener("ratechange", () => syncPreviewBackgroundPlayback(false));
  el.previewPlayer?.addEventListener("play", () => {
    syncPreviewBackgroundPlayback(true);
    el.previewBackgroundPlayer?.play().catch(() => {});
  });
  el.previewPlayer?.addEventListener("pause", () => el.previewBackgroundPlayer?.pause());
  window.addEventListener("resize", updateVideoDecorationPreview);
  // Progress/status panels can resize the stage without resizing the window.
  const previewStage = el.previewPlayer?.closest(".video-stage");
  if (previewStage) new ResizeObserver(updateVideoDecorationPreview).observe(previewStage);

  el.translateButton.addEventListener("click", async () => {
    if (!state.currentProject) return;
    setBusy(true);
    try {
      await saveCurrentSegments();
      addLog(`Đang dịch phụ đề bằng ${getAiProviderLabel(state.settings?.aiProvider || el.aiProvider.value)}...`);
      state.currentProject = await window.cineviral.translateDubbingProject(state.currentProject.id);
      renderStudio();
    } catch (error) {
      addLog(error.message, "ERROR");
      showToast(error.message);
    } finally {
      setBusy(false);
    }
  });

  el.diarizeButton.addEventListener("click", async () => {
    if (!state.currentProject) return;
    setBusy(true);
    try {
      await saveCurrentSegments();
      addLog("Đang phân vai giọng...");
      state.currentProject = await window.cineviral.diarizeDubbingProject(state.currentProject.id);
      renderStudio();
    } catch (error) {
      addLog(error.message, "ERROR");
      showToast(error.message);
    } finally {
      setBusy(false);
    }
  });

  el.saveSegment?.addEventListener("click", async () => {
    setBusy(true);
    try {
      await saveCurrentSegments();
      addLog("Segment saved.");
    } catch (error) {
      addLog(error.message, "ERROR");
      showToast(error.message);
    } finally {
      setBusy(false);
    }
  });
  el.previewSegmentVoice?.addEventListener("click", previewCurrentSegmentVoice);
  el.previewSegmentVideo?.addEventListener("click", previewCurrentSegmentVideo);
  el.audioPlan?.addEventListener("click", buildCurrentAudioPlan);

  el.reviewSceneScript?.addEventListener("click", async () => {
    if (!state.currentProject) return;
    if (!["recap", "satisfying_storytime", "highlight_cut"].includes(state.currentProject.mode)) {
      showToast("AI đánh giá cảnh/kịch bản hiện hỗ trợ Tóm tắt phim, Storytime và Highlight Cut.");
      return;
    }
    setBusy(true);
    try {
      await saveCurrentSegments();
      addLog(`AI đang đánh giá cảnh ${state.selectedSegmentIndex + 1} để kiểm tra độ khớp kịch bản/giọng...`);
      state.currentProject = await window.cineviral.reviewSceneScript(state.currentProject.id, state.selectedSegmentIndex);
      renderStudio();
      addLog("Đã hoàn tất đánh giá cảnh bằng AI.");
    } catch (error) {
      addLog(error.message, "ERROR");
      showToast(error.message);
    } finally {
      setBusy(false);
    }
  });

  el.reviewAllScenesLeft?.addEventListener("click", reviewAllScenesFromSegmentList);
  el.rewriteFailedScenes?.addEventListener("click", rewriteFailedScenesWithAi);
  el.applyAllRewrites?.addEventListener("click", applyAllRewriteSuggestions);

  el.reviewAllScenes?.addEventListener("click", async () => {
    if (!state.currentProject) return;
    if (!["recap", "satisfying_storytime", "highlight_cut"].includes(state.currentProject.mode)) {
      showToast("AI đánh giá toàn bộ cảnh hiện hỗ trợ Tóm tắt phim, Storytime và Highlight Cut.");
      return;
    }
    const totalSegments = getSegments().length;
    if (!totalSegments) {
      showToast("Chưa có đoạn kịch bản nào để đánh giá.");
      return;
    }
    setBusy(true);
    const originalText = el.reviewAllScenes?.textContent || "";
    try {
      await saveCurrentSegments();
      addLog(`AI bắt đầu đánh giá toàn bộ ${totalSegments} cảnh trong kịch bản...`);
      for (let index = 0; index < totalSegments; index += 1) {
        state.selectedSegmentIndex = index;
        if (el.reviewAllScenes) el.reviewAllScenes.textContent = `Đang đánh giá ${index + 1}/${totalSegments}`;
        addLog(`AI đang đánh giá cảnh ${index + 1}/${totalSegments}...`);
        state.currentProject = await window.cineviral.reviewSceneScript(state.currentProject.id, index);
        renderStudio();
      }
      addLog("Đã hoàn tất đánh giá toàn bộ cảnh bằng AI.");
      showToast("Đã đánh giá toàn bộ cảnh trong kịch bản.");
    } catch (error) {
      addLog(error.message, "ERROR");
      showToast(error.message);
    } finally {
      if (el.reviewAllScenes) el.reviewAllScenes.textContent = originalText || "Đánh giá toàn bộ";
      setBusy(false);
      renderStudio();
    }
  });

  el.applySceneRewrite?.addEventListener("click", () => {
    const segment = getSegments()[state.selectedSegmentIndex];
    const rewrite = segment?.aiSceneReview?.rewriteSuggestion;
    if (!rewrite?.narrationLine) {
      return;
    }
    if (el.inspectText) el.inspectText.value = rewrite.narrationLine;
    showToast("Câu viết lại đã được đưa vào ô kịch bản. Bấm Lưu đoạn để giữ thay đổi.");
  });

  el.renderVideo.addEventListener("click", async () => {
    if (!state.currentProject) return;
    el.previewPlayer?.pause();
    setBusy(true);
    setRenderCancellable(true);
    state.activeOperation = "Đang xuất";
    setExportProgress(1, "Đang xuất video");
    try {
      await saveCurrentSegments();
      await applyCurrentProjectSettings();
      addLog("Đang render video cuối...");
      state.currentProject = await window.cineviral.renderProject(state.currentProject.id);
      renderStudio();
      addLog(`Render đã sẵn sàng: ${state.currentProject.artifacts?.finalVideoPath || ""}`);
    } catch (error) {
      addLog(error.message, "ERROR");
      showToast(error.message);
    } finally {
      setBusy(false);
    }
  });

  el.resumeRender?.addEventListener("click", async () => {
    if (!state.currentProject?.artifacts?.recoverableRenderJobId) return;
    el.previewPlayer?.pause();
    setBusy(true);
    setRenderCancellable(true);
    state.activeOperation = "Tiếp tục xuất";
    setExportProgress(1, "Đang tiếp tục lần xuất bị gián đoạn");
    try {
      addLog("Đang tiếp tục render job bị gián đoạn...", "WARNING");
      state.currentProject = await window.cineviral.resumeRender(state.currentProject.id);
      renderStudio();
      addLog(`Render đã sẵn sàng: ${state.currentProject.artifacts?.finalVideoPath || ""}`);
    } catch (error) {
      addLog(error.message, "ERROR");
      showToast(error.message);
    } finally {
      setBusy(false);
    }
  });

  el.cancelRender?.addEventListener("click", async () => {
    el.cancelRender.disabled = true;
    try {
      const cancelled = await window.cineviral.cancelRender();
      addLog(cancelled ? "Đã gửi yêu cầu dừng xuất video." : "Không có tiến trình xuất nào đang chạy.", cancelled ? "WARNING" : "INFO");
      showToast(cancelled ? "Đang dừng xuất video..." : "Không có tiến trình xuất đang chạy.");
    } catch (error) {
      addLog(error.message, "ERROR");
      showToast(error.message);
      el.cancelRender.disabled = false;
    }
  });

  el.renderHighlightVariants?.addEventListener("click", async () => {
    if (!state.currentProject || state.currentProject.mode !== "highlight_cut") return;
    const variants = getHighlightVariants();
    if (variants.length <= 1) return;
    const confirmed = await showConfirmAction({
      title: "Xuất tất cả variant?",
      message: `Tool sẽ lần lượt xuất ${variants.length} variant. Quá trình có thể mất nhiều thời gian.`,
      confirmLabel: "Xuất tất cả"
    });
    if (!confirmed) return;
    el.previewPlayer?.pause();
    setBusy(true);
    setRenderCancellable(true);
    state.activeOperation = "Xuất Highlight variants";
    setExportProgress(1, "Đang xuất tất cả Highlight variant");
    setVariantExportQueue(variants.map((variant, index) => ({
      id: variant.id,
      label: variant.label || `Variant ${index + 1}`,
      status: index === 0 ? "processing" : "waiting"
    })));
    try {
      await saveCurrentSegments();
      await applyCurrentProjectSettings();
      state.currentProject = await window.cineviral.renderHighlightVariants(state.currentProject.id);
      renderStudio();
      const failedCount = state.variantExportQueue.filter((item) => item.status === "failed").length;
      addLog(`Đã xử lý ${variants.length} Highlight variant${failedCount ? `, ${failedCount} variant lỗi` : ""}.`, failedCount ? "WARNING" : "INFO");
      showToast(failedCount ? `Hoàn tất với ${failedCount} variant lỗi.` : "Đã xuất tất cả Highlight variant.");
    } catch (error) {
      setVariantExportQueue(state.variantExportQueue.map((item) => (
        item.status === "processing" ? { ...item, status: "failed", error: error.message } : item
      )));
      addLog(error.message, "ERROR");
      showToast(error.message);
    } finally {
      setBusy(false);
      setTimeout(() => {
        state.variantExportQueue = [];
        state.variantProgress = null;
        renderStudioVariantHub();
      }, 4500);
    }
  });
  el.renderAllFastDrafts?.addEventListener("click", renderAllFastDraftVariants);

  el.openOutputFolder?.addEventListener("click", async () => {
    if (!state.currentProject || !getFinalOutputPath(state.currentProject)) {
      showToast("Chưa có video output để mở.");
      return;
    }
    try {
      const opened = await window.cineviral.openOutput(state.currentProject.id);
      if (!opened) {
        showToast("Không tìm thấy file output của dự án này.");
      }
    } catch (error) {
      addLog(error.message, "ERROR");
      showToast(error.message);
    }
  });

  el.highlightVariantBar?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-highlight-variant]");
    if (!button) return;
    try {
      await switchHighlightVariant(button.dataset.highlightVariant);
    } catch (error) {
      addLog(error.message, "ERROR");
      showToast(error.message);
    }
  });
  el.variantHubCards?.addEventListener("click", async (event) => {
    const reportBtn = event.target.closest("[data-open-review-report]");
    if (reportBtn) {
      event.stopPropagation();
      const variantId = reportBtn.dataset.openReviewReport;
      await openDraftReviewReportModal(state.currentProject?.id, variantId);
      return;
    }
    const card = event.target.closest("[data-highlight-variant]");
    if (!card) return;
    try {
      await switchHighlightVariant(card.dataset.highlightVariant);
    } catch (error) {
      addLog(error.message, "ERROR");
      showToast(error.message);
    }
  });
  el.highlightRevisionBar?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-revision-preview]");
    if (!button) return;
    state.revisionPreviewPath = button.dataset.revisionPreview || "";
    renderHighlightRevisionBar(state.currentProject);
    renderPreviewSource(state.currentProject);
    if (el.previewPlayer) el.previewPlayer.currentTime = 0;
  });

  el.playPreview.addEventListener("click", () => {
    if (!el.previewPlayer.src) return;
    if (el.previewPlayer.paused) {
      el.previewPlayer.play().catch(() => {});
    } else {
      el.previewPlayer.pause();
    }
  });
  el.previewControlPlay?.addEventListener("click", () => {
    if (!el.previewPlayer.src) return;
    if (el.previewPlayer.paused) {
      el.previewPlayer.play().catch(() => {});
    } else {
      el.previewPlayer.pause();
    }
  });

  el.previewDraft.addEventListener("click", async () => {
    if (!state.currentProject) return;
    setBusy(true);
    state.activeOperation = "Xem trước";
    setExportProgress(1, "Đang xuất bản xem trước");
    try {
      await saveCurrentSegments();
      await applyCurrentProjectSettings();
      addLog("Đang xuất bản nháp để kiểm tra...");
      if (state.currentProject.mode === "recap") {
        state.currentProject = await window.cineviral.previewProject(state.currentProject.id);
      } else {
        showToast("Bản nháp xem trước hiện mới hỗ trợ đầy đủ cho chế độ tóm tắt phim. Dubbing có thể dùng video proxy/nguồn để xem trước.");
      }
      renderStudio();
    } catch (error) {
      addLog(error.message, "ERROR");
      showToast(error.message);
    } finally {
      setBusy(false);
    }
  });
  el.renderFastDraft?.addEventListener("click", renderFastDraftVideo);
  $("resume-auto-story")?.addEventListener("click", resumeAutoStoryProject);
  el.createGeminiDraftReview?.addEventListener("click", createGeminiDraftReviewPackage);
  el.runConfiguredDraftReview?.addEventListener("click", runConfiguredDraftReview);
  el.cancelConfiguredDraftReview?.addEventListener("click", cancelConfiguredDraftReview);
  el.openConfiguredDraftReviewResult?.addEventListener("click", openConfiguredDraftReviewResult);
  el.importConfiguredDraftReview?.addEventListener("click", importConfiguredDraftReview);
  el.openGeminiDraftReview?.addEventListener("click", openGeminiDraftReviewPackage);
  el.openDraftReviewPrompt?.addEventListener("click", () => openDraftReviewArtifact("prompt"));
  el.openDraftReviewReport?.addEventListener("click", async () => {
    const artifacts = getDraftReviewArtifacts();
    if (artifacts.aiResultPath) {
      await openDraftReviewReportModal();
    } else {
      openDraftReviewArtifact("report");
    }
  });
  el.closeDraftReviewModal?.addEventListener("click", closeDraftReviewReportModal);
  el.dismissDraftReviewModal?.addEventListener("click", closeDraftReviewReportModal);
  el.draftReviewModal?.addEventListener("click", (event) => {
    if (event.target === el.draftReviewModal) closeDraftReviewReportModal();
  });
  document.querySelectorAll(".draft-review-tabs .review-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      setReviewModalTab(tab.dataset.reviewTab);
    });
  });
  el.applyDraftReviewModalV2?.addEventListener("click", async () => {
    if (!currentReviewReportData?.jsonPath) {
      await importConfiguredDraftReview();
      closeDraftReviewReportModal();
      return;
    }
    await importReviewedScriptPath(currentReviewReportData.jsonPath, { autoRouted: true });
    closeDraftReviewReportModal();
  });
  el.importReviewedScript?.addEventListener("click", importReviewedScriptFromGemini);

  el.previewPlayer.addEventListener("timeupdate", () => {
    updateTimelinePlayhead(el.previewPlayer.currentTime || 0);
    updatePreviewSubtitleOverlay();
    syncPreviewToCurrentSegment(el.previewPlayer.currentTime || 0);
  });
  el.previewPlayer.addEventListener("play", () => {
    if (el.previewControlPlay) el.previewControlPlay.textContent = "Ⅱ";
  });
  el.previewPlayer.addEventListener("seeked", updatePreviewSubtitleOverlay);
  el.previewPlayer.addEventListener("loadedmetadata", updatePreviewSubtitleOverlay);
  window.addEventListener("resize", positionPreviewSubtitleOverlay);
  el.previewPlayer.addEventListener("pause", () => {
    if (el.previewControlPlay) el.previewControlPlay.textContent = "▶";
  });
  el.timelineCanvas?.addEventListener("wheel", (event) => {
    if (!el.timelineCanvas) return;
    const canScrollHorizontally = el.timelineCanvas.scrollWidth > el.timelineCanvas.clientWidth;
    if (!canScrollHorizontally) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    el.timelineCanvas.scrollLeft += delta;
    event.preventDefault();
  }, { passive: false });
  el.timelineCanvas?.addEventListener("pointerdown", (event) => {
    if (!el.previewPlayer.src || event.button !== 0) return;
    if (event.target.closest("button")) return;
    isTimelineScrubbing = true;
    el.timelineCanvas.setPointerCapture?.(event.pointerId);
    seekTimeline(getTimelineSecondFromPointer(event), false);
    event.preventDefault();
  });
  el.timelineCanvas?.addEventListener("pointermove", (event) => {
    if (!isTimelineScrubbing) return;
    seekTimeline(getTimelineSecondFromPointer(event), false);
    event.preventDefault();
  });
  const stopTimelineScrub = (event) => {
    if (!isTimelineScrubbing) return;
    isTimelineScrubbing = false;
    el.timelineCanvas?.releasePointerCapture?.(event.pointerId);
  };
  el.timelineCanvas?.addEventListener("pointerup", stopTimelineScrub);
  el.timelineCanvas?.addEventListener("pointercancel", stopTimelineScrub);
  el.timelineCanvas?.addEventListener("lostpointercapture", () => {
    isTimelineScrubbing = false;
  });

  document.querySelectorAll("[data-settings-tab]").forEach((button) => {
    button.addEventListener("click", () => setSettingsTab(button.dataset.settingsTab));
  });
  el.openSettings.addEventListener("click", () => {
    setSettingsTab("ai");
    syncAiProviderSettingsUi();
    el.settingsModal.classList.remove("hidden");
  });
  el.closeSettings.addEventListener("click", () => closeSettingsModal());
  el.settingsModal.addEventListener("click", (event) => {
    if (event.target === el.settingsModal) closeSettingsModal();
  });
  el.checkSettings?.addEventListener("click", checkCurrentSettings);
  el.localTranslationProvider?.addEventListener("change", syncLocalTranslationSettings);
  el.downloadHyMt2?.addEventListener("click", async () => {
    const model = el.hyMt2Model.value.trim() || "hf.co/unsloth/Hy-MT2-7B-GGUF:UD-Q4_K_XL";
    el.downloadHyMt2.disabled = true;
    el.downloadHyMt2.textContent = "Đang tải Hy-MT2...";
    addLog(`Đang tải model Hy-MT2 bằng Ollama: ${model}. Lần đầu có thể mất khá lâu.`);
    try {
      await window.cineviral.prepareHyMt2(model);
      addLog(`Đã tải xong Hy-MT2: ${model}.`);
      showToast("Hy-MT2 đã sẵn sàng.");
      await checkCurrentSettings();
    } catch (error) {
      addLog(`Không tải được Hy-MT2: ${error.message}`, "ERROR");
      showToast(error.message);
    } finally {
      el.downloadHyMt2.disabled = false;
      el.downloadHyMt2.textContent = "Tải Hy-MT2";
    }
  });
  el.pickExportRoot?.addEventListener("click", async () => {
    const folder = await window.cineviral.pickFolder();
    if (folder) {
      el.exportRoot.value = folder;
    }
  });
  el.pickGeminiAnalysisRoot?.addEventListener("click", async () => {
    const folder = await window.cineviral.pickFolder();
    if (folder) {
      el.geminiAnalysisRoot.value = folder;
    }
  });
  el.pickVertexCredential?.addEventListener("click", async () => {
    const filePath = await window.cineviral.pickJson();
    if (filePath) el.vertexCredentialPath.value = filePath;
  });
  el.testVertex?.addEventListener("click", async () => {
    el.testVertex.disabled = true;
    el.testVertex.textContent = "Đang kiểm tra...";
    if (el.vertexStatus) el.vertexStatus.textContent = "Đang xác thực và gọi model tiết kiệm...";
    try {
      const result = await window.cineviral.testVertex(readSettings());
      const cost = Number(result.usage?.estimatedCostUsd || 0).toFixed(4);
      const spent = Number(result.budget?.totalSpentUsd || 0).toFixed(4);
      if (el.vertexStatus) el.vertexStatus.textContent = `Kết nối tốt · ${result.model} · lần kiểm tra $${cost} · đã dùng $${spent}.`;
      showToast("Vertex AI đã sẵn sàng.");
    } catch (error) {
      if (el.vertexStatus) el.vertexStatus.textContent = `Lỗi: ${error.message}`;
      showToast(error.message);
    } finally {
      el.testVertex.disabled = false;
      el.testVertex.textContent = "Kiểm tra Vertex AI";
    }
  });
  [
    el.elevenLabsSettingsMode,
    el.elevenLabsStability,
    el.elevenLabsSimilarity,
    el.elevenLabsStyle
  ].forEach((input) => input?.addEventListener("input", syncElevenLabsSliderLabels));
  el.edgeVoicePreset?.addEventListener("change", () => {
    applyLocalVoicePreset("edge_neural");
    rememberVoiceSetupSoon();
  });
  el.kokoroVoicePreset?.addEventListener("change", () => {
    applyLocalVoicePreset("kokoro");
    rememberVoiceSetupSoon();
  });
  [el.edgeVoiceRate, el.edgeVoicePitch, el.edgeVoiceVolume].forEach((input) => {
    input?.addEventListener("input", () => {
      el.edgeVoicePreset.value = "custom";
      syncLocalVoiceTuningLabels();
      rememberVoiceSetupSoon();
    });
  });
  el.kokoroSpeed?.addEventListener("input", () => {
    el.kokoroVoicePreset.value = "custom";
    syncLocalVoiceTuningLabels();
    rememberVoiceSetupSoon();
  });
  el.saveSettings.addEventListener("click", async () => {
    try {
      const saved = await window.cineviral.saveSettings(readSettings());
      state.settings = saved.settings;
      state.projects = saved.projects;
      fillSettings(state.settings);
      renderProjectPicker();
      updateReview();
      closeSettingsModal({ restore: false });
      addLog(`Đã lưu cài đặt. AI provider: ${getAiProviderLabel(state.settings.aiProvider)}.`);
    } catch (error) {
      addLog(error.message, "ERROR");
      showToast(error.message);
    }
  });

  el.copyLog?.addEventListener("click", () => {
    navigator.clipboard.writeText(state.logLines.join("\n"));
  });
  el.toggleRawLog?.addEventListener("click", () => {
    state.rawLogVisible = !state.rawLogVisible;
    el.systemLog?.classList.toggle("hidden", !state.rawLogVisible);
    el.activityFeed?.classList.toggle("hidden", state.rawLogVisible);
    if (el.toggleRawLog) {
      el.toggleRawLog.textContent = state.rawLogVisible ? "Hiện hoạt động" : "Hiện log thô";
    }
  });

  el.copyStudioLog?.addEventListener("click", () => {
    navigator.clipboard.writeText(state.logLines.join("\n"));
    showToast("Đã sao chép toàn bộ nhật ký.");
  });
  function switchStudioLogTab(isRaw) {
    state.studioRawLogVisible = isRaw;
    el.tabStudioActivity?.classList.toggle("active", !isRaw);
    el.tabStudioRawLog?.classList.toggle("active", isRaw);
    el.studioActivityFeed?.classList.toggle("hidden", isRaw);
    el.studioSystemLog?.classList.toggle("hidden", !isRaw);
    if (el.toggleStudioRawLog) {
      el.toggleStudioRawLog.textContent = isRaw ? "Hiện hoạt động" : "Hiện log thô";
    }
    if (isRaw && el.studioSystemLog) {
      el.studioSystemLog.scrollTop = el.studioSystemLog.scrollHeight;
    }
  }
  el.tabStudioActivity?.addEventListener("click", () => switchStudioLogTab(false));
  el.tabStudioRawLog?.addEventListener("click", () => switchStudioLogTab(true));
  el.toggleStudioRawLog?.addEventListener("click", () => switchStudioLogTab(!state.studioRawLogVisible));
}

async function bootstrap() {
  queryElements();
  renderSteps();
  const payload = await window.cineviral.bootstrap();
  state.settings = payload.settings;
  state.projects = payload.projects;
  fillSettings(state.settings);
  applySetupDraft();
  renderProjectPicker();
  bindEvents();
  initStudioSplitters();
  renderActivity();
  if (el.ollamaVisionAssist?.checked) {
    loadOllamaModels({ silent: true });
  }
  if (document.querySelector(".voice-tab.active")?.dataset.voiceTab === "preset") {
    loadPresetVoices();
  }
  if (el.draftVoiceMode?.value === "custom") {
    loadDraftVoices();
  }
  syncHeroVoiceCard();
  addLog("Đã khởi tạo RecapTool Studio.");
  addLog(`AI provider mặc định: ${getAiProviderLabel(state.settings.aiProvider)}.`);
  if (payload.recoverableRenderJobs?.length) {
    addLog(`Phát hiện ${payload.recoverableRenderJobs.length} lần xuất bị gián đoạn. Mở dự án tương ứng và bấm Tiếp tục xuất.`, "WARNING");
  }
  autoCheckConfiguration();

  window.cineviral.onProgress((payload) => {
    window.previewLog?.progress(payload);
    if (payload.autoStoryDraftReady && payload.project) {
      state.currentProject = payload.project;
      showStudio(payload.project);
    }
    if (Array.isArray(payload.variantBatch?.items)) {
      setVariantExportQueue(payload.variantBatch.items);
    }
    if (payload.variantBatch || state.variantExportQueue?.length) {
      state.variantProgress = {
        activeIndex: typeof payload.variantBatch?.activeIndex === "number"
          ? payload.variantBatch.activeIndex
          : (state.variantProgress?.activeIndex ?? 0),
        percent: Number(payload.percent || 0),
        message: payload.message || ""
      };
      updateVariantHubProgress(payload);
    }
    if (payload.message) {
      const formattedLog = [payload.stage || payload.step, payload.message].filter(Boolean).join(': ');
      if (formattedLog !== state.lastLoggedProgressMessage) {
        state.lastLoggedProgressMessage = formattedLog;
        addLog(formattedLog, payload.level || 'INFO');
      }
    }
    if (["antigravity_stage1", "configured_ai_stage1"].includes(payload.step)) {
      if (el.aiAnalysisTerminal) {
        el.aiAnalysisTerminal.classList.remove("hidden");
        if (el.manualAntigravityStage1Status) el.manualAntigravityStage1Status.classList.add("hidden");
        
        if (payload.message && (payload.message.includes("viết kịch bản") || payload.message.includes("phân tích prompt"))) {
           el.aiAnalysisTerminal.classList.add("is-thinking");
        } else {
           el.aiAnalysisTerminal.classList.remove("is-thinking");
        }
        
        const pct = Math.round(Number(payload.percent || 0));
        if (el.aiTerminalPercentage) el.aiTerminalPercentage.textContent = `${pct}%`;
        if (el.aiTerminalProgressBar) el.aiTerminalProgressBar.style.width = `${pct}%`;
        if (el.aiTerminalLog && payload.message) el.aiTerminalLog.textContent = payload.message;
      }
      if (typeof payload.percent === "number") {
        setExportProgress(payload.percent, (payload.message || "Antigravity đang phân tích...").trim());
      }
    } else if (payload.step === "configured_ai_draft_review" && el.draftReviewStatus) {
      const pct = Math.round(Number(payload.percent || 0));
      el.draftReviewStatus.textContent = `${pct}% - ${payload.message || "AI đang review draft..."}`;
      if (typeof payload.percent === "number") {
        setExportProgress(payload.percent, `Review AI: ${pct}%`);
      }
    } else {
      if (typeof payload.percent === "number") {
        const step = payload.stage || payload.step;
        const label = payload.message || step || state.activeOperation || "Đang xử lý";
        setExportProgress(payload.percent, label.trim());
      }
    }
    if (payload.project) {
      state.currentProject = payload.project;
      if (!el.studioView.classList.contains("hidden")) {
        renderStudio();
      }
    }
  });
}

bootstrap().catch((error) => {
  console.error(error);
  showToast(error.message);
});
