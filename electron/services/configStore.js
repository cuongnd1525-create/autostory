const fs = require("fs/promises");
const path = require("path");

async function atomicWrite(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, contents, "utf8");
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error.code)) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
    await fs.rm(filePath, { force: true });
    await fs.rename(tempPath, filePath);
  }
}

class ConfigStore {
  constructor(configPath, defaultWorkspaceRoot) {
    this.configPath = configPath;
    this.defaultWorkspaceRoot = defaultWorkspaceRoot;
    this.cache = null;
  }

  getDefaultSettings() {
    return {
      workspaceRoot: process.env.CINEVIRAL_WORKSPACE || this.defaultWorkspaceRoot,
      exportRoot: process.env.CINEVIRAL_EXPORT_ROOT || path.join(path.dirname(this.defaultWorkspaceRoot), "exports"),
      geminiAnalysisRoot: process.env.CINEVIRAL_GEMINI_ANALYSIS_ROOT || path.join(path.dirname(this.defaultWorkspaceRoot), "GeminiData"),
      sourceDownloadRoot: process.env.CINEVIRAL_SOURCE_DOWNLOAD_ROOT || path.join(path.dirname(this.defaultWorkspaceRoot), "sources"),
      exportLayout: process.env.CINEVIRAL_EXPORT_LAYOUT || "flat",
      ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
      ffprobePath: process.env.FFPROBE_PATH || "ffprobe",
      geminiApiKey: process.env.GEMINI_API_KEY || "",
      geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-pro",
      vertexProjectId: process.env.GOOGLE_CLOUD_PROJECT || "",
      vertexLocation: process.env.GOOGLE_CLOUD_LOCATION || "global",
      vertexCredentialPath: process.env.GOOGLE_APPLICATION_CREDENTIALS || "",
      vertexGcloudCommand: process.env.GCLOUD_COMMAND || "gcloud",
      vertexBucket: process.env.CINEVIRAL_VERTEX_BUCKET || "",
      vertexEconomyModel: process.env.CINEVIRAL_VERTEX_ECONOMY_MODEL || "gemini-2.5-flash-lite",
      vertexAnalysisModel: process.env.CINEVIRAL_VERTEX_ANALYSIS_MODEL || "gemini-2.5-flash",
      vertexQualityModel: process.env.CINEVIRAL_VERTEX_QUALITY_MODEL || "gemini-2.5-pro",
      vertexAutoStoryPlanModel: "",
      vertexAutoStoryEditModel: "",
      vertexAutoStoryReviewModel: "",
      vertexAutoStoryRepairModel: "",
      vertexAutoStoryFinalModel: "",
      vertexAutoStoryMaxCalls: 16,
      vertexBudgetUsd: Number(process.env.CINEVIRAL_VERTEX_BUDGET_USD || 240),
      vertexDailyLimitUsd: Number(process.env.CINEVIRAL_VERTEX_DAILY_LIMIT_USD || 5),
      vertexTimeoutMs: Number(process.env.CINEVIRAL_VERTEX_TIMEOUT_MS || 900000),
      aiProvider: process.env.CINEVIRAL_AI_PROVIDER || "gemini",
      ollamaVisionAssist: process.env.CINEVIRAL_OLLAMA_VISION_ASSIST === "1",
      ollamaVisionModel: process.env.CINEVIRAL_OLLAMA_VISION_MODEL || "gemma4",
      antigravityCommand: process.env.ANTIGRAVITY_COMMAND || "agy",
      antigravityArgs: process.env.ANTIGRAVITY_ARGS || "",
      antigravityModel: process.env.ANTIGRAVITY_MODEL || "",
      antigravityTimeoutMs: Number(process.env.ANTIGRAVITY_TIMEOUT_MS || 900000),
      draftRenderConcurrency: Number(process.env.DRAFT_RENDER_CONCURRENCY || 2),
      ytDlpCommand: process.env.YT_DLP_COMMAND || "yt-dlp",
      whisperEngine: process.env.WHISPER_ENGINE || "auto",
      whisperCommand: process.env.WHISPER_COMMAND || "whisper",
      whisperPythonCommand: process.env.WHISPER_PYTHON_COMMAND || "py",
      whisperModel: process.env.WHISPER_MODEL || "auto",
      whisperDevice: process.env.WHISPER_DEVICE || "auto",
      whisperComputeType: process.env.WHISPER_COMPUTE_TYPE || "auto",
      whisperChunkSec: Number(process.env.WHISPER_CHUNK_SEC || 240),
      asrConfigVersion: 2,
      dubbingRenderMode: process.env.CINEVIRAL_DUBBING_RENDER_MODE || "speech_first_clustered",
      dubbingMinClusterDuration: Number(process.env.CINEVIRAL_DUBBING_MIN_CLUSTER_DURATION || 5),
      dubbingMaxClusterDuration: Number(process.env.CINEVIRAL_DUBBING_MAX_CLUSTER_DURATION || 12),
      dubbingMaxSafeStretch: Number(process.env.CINEVIRAL_DUBBING_MAX_SAFE_STRETCH || 0.08),
      dubbingAllowStrictTrim: process.env.CINEVIRAL_DUBBING_ALLOW_STRICT_TRIM === "1",
      dubbingVoiceNormalize: process.env.CINEVIRAL_DUBBING_VOICE_NORMALIZE !== "0",
      elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || "",
      elevenLabsModel: process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2",
      elevenLabsVoiceSettingsMode: process.env.ELEVENLABS_VOICE_SETTINGS_MODE || "auto",
      elevenLabsStability: Number(process.env.ELEVENLABS_STABILITY || 0.32),
      elevenLabsSimilarityBoost: Number(process.env.ELEVENLABS_SIMILARITY_BOOST || 0.78),
      elevenLabsStyle: Number(process.env.ELEVENLABS_STYLE || 0.58),
      elevenLabsSpeakerBoost: process.env.ELEVENLABS_SPEAKER_BOOST !== "0",
      defaultVoiceId: process.env.ELEVENLABS_VOICE_ID || "",
      defaultVoiceProvider: process.env.CINEVIRAL_VOICE_PROVIDER || "edge_neural",
      lastVoiceSetup: {
        tab: "designed",
        genderAge: "female",
        pitch: "moderate",
        accent: "none",
        trait: "normal",
        prompt: "female, moderate pitch",
        samplePath: "",
        presetProvider: process.env.CINEVIRAL_VOICE_PROVIDER || "edge_neural",
        presetVoiceId: process.env.ELEVENLABS_VOICE_ID || ""
      },
      defaultWindowsVoice: process.env.CINEVIRAL_WINDOWS_VOICE || "",
      edgeVoicePreset: process.env.EDGE_VOICE_PRESET || "natural",
      edgeVoiceRate: Number(process.env.EDGE_VOICE_RATE || 0),
      edgeVoicePitchHz: Number(process.env.EDGE_VOICE_PITCH_HZ || 0),
      edgeVoiceVolume: Number(process.env.EDGE_VOICE_VOLUME || 100),
      omniVoiceCommand: process.env.OMNIVOICE_COMMAND || "omnivoice-infer",
      omniVoiceModel: process.env.OMNIVOICE_MODEL || "k2-fsa/OmniVoice",
      omniVoiceDevice: process.env.OMNIVOICE_DEVICE || "",
      omniVoicePythonCommand: process.env.OMNIVOICE_PYTHON_COMMAND || "",
      omniVoicePersistentWorker: process.env.OMNIVOICE_PERSISTENT_WORKER !== "0",
      omniVoiceWorkerIdleTimeoutMs: Number(process.env.OMNIVOICE_WORKER_IDLE_TIMEOUT_MS || 15 * 60 * 1000),
      omniVoiceInstruct: process.env.OMNIVOICE_INSTRUCT || "",
      omniVoiceRefText: process.env.OMNIVOICE_REF_TEXT || "",
      kokoroPythonCommand: process.env.KOKORO_PYTHON_COMMAND || "python",
      kokoroModel: process.env.KOKORO_MODEL || "hexgrad/Kokoro-82M",
      kokoroDevice: process.env.KOKORO_DEVICE || "",
      kokoroVoicePreset: process.env.KOKORO_VOICE_PRESET || "natural",
      kokoroSpeed: Number(process.env.KOKORO_SPEED || 1),
      kokoroWorkerIdleTimeoutMs: Number(process.env.KOKORO_WORKER_IDLE_TIMEOUT_MS || 15 * 60 * 1000),
      localPreviewTranslationEnabled: process.env.LOCAL_PREVIEW_TRANSLATION !== "0",
      localTranslationProvider: process.env.LOCAL_TRANSLATION_PROVIDER || "opus_mt",
      localTranslationPythonCommand: process.env.LOCAL_TRANSLATION_PYTHON || "python",
      localTranslationModel: process.env.LOCAL_TRANSLATION_MODEL || "Helsinki-NLP/opus-mt-en-vi",
      localTranslationDevice: process.env.LOCAL_TRANSLATION_DEVICE || "",
      localTranslationBatchSize: Number(process.env.LOCAL_TRANSLATION_BATCH_SIZE || 8),
      localTranslationWorkerIdleTimeoutMs: Number(process.env.LOCAL_TRANSLATION_WORKER_IDLE_TIMEOUT_MS || 15 * 60 * 1000),
      hyMt2Model: process.env.HY_MT2_MODEL || "hf.co/unsloth/Hy-MT2-7B-GGUF:UD-Q4_K_XL",
      hyMt2OllamaBaseUrl: process.env.HY_MT2_OLLAMA_BASE_URL || "http://127.0.0.1:11434",
      hyMt2BatchSize: Number(process.env.HY_MT2_BATCH_SIZE || 6),
      hyMt2FallbackToOpus: process.env.HY_MT2_FALLBACK_TO_OPUS !== "0",
      localVisionTaggerCommand: process.env.CINEVIRAL_VISION_TAGGER_COMMAND || "",
      sceneDetectionTimeoutMs: Number(process.env.CINEVIRAL_SCENE_DETECTION_TIMEOUT_MS || 0),
      sceneDetectionProxyWidth: Number(process.env.CINEVIRAL_SCENE_PROXY_WIDTH || 480),
      sceneDetectionProxyFps: Number(process.env.CINEVIRAL_SCENE_PROXY_FPS || 8),
      sceneDetectionThreshold: Number(process.env.CINEVIRAL_SCENE_THRESHOLD || 0.32),
      sceneDetectionMaxSceneDurationSec: Number(process.env.CINEVIRAL_SCENE_MAX_DURATION_SEC || 45),
      actionAnalysisWindowSec: Number(process.env.CINEVIRAL_ACTION_WINDOW_SEC || 4),
      actionCandidateMaxDurationSec: Number(process.env.CINEVIRAL_ACTION_MAX_DURATION_SEC || 60),
      actionCandidateMaxCount: Number(process.env.CINEVIRAL_ACTION_MAX_COUNT || 20),
      metadataWhisperTimeoutMs: Number(process.env.CINEVIRAL_METADATA_WHISPER_TIMEOUT_MS || 180000),
      metadataVisionTimeoutMs: Number(process.env.CINEVIRAL_METADATA_VISION_TIMEOUT_MS || 90000),
      metadataMaxScenes: Number(process.env.CINEVIRAL_METADATA_MAX_SCENES || 120),
      metadataSamplesPerScene: Number(process.env.CINEVIRAL_METADATA_SAMPLES_PER_SCENE || 2),
      metadataAutoWhisper: process.env.CINEVIRAL_METADATA_AUTO_WHISPER === "1",
      verticalWidth: 1080,
      verticalHeight: 1920,
      subtitleFontSize: 17
    };
  }

  async ensureLoaded() {
    if (this.cache) {
      return this.cache;
    }
    try {
      const raw = await fs.readFile(this.configPath, "utf8");
      const parsed = JSON.parse(raw);
      this.cache = {
        ...this.getDefaultSettings(),
        ...parsed
      };
      if (!Object.prototype.hasOwnProperty.call(parsed, "whisperEngine")) {
        this.cache.whisperEngine = "auto";
        if (!parsed.whisperModel || parsed.whisperModel === "medium") {
          this.cache.whisperModel = "auto";
        }
        this.cache.whisperDevice = parsed.whisperDevice || "auto";
        this.cache.whisperComputeType = parsed.whisperComputeType || "auto";
        await this.persist(this.cache);
      }
      if (!Number(parsed.asrConfigVersion || 0)) {
        const usesLegacyDefaults = parsed.whisperEngine === "faster-whisper"
          && (!parsed.whisperModel || parsed.whisperModel === "small")
          && (!parsed.whisperDevice || parsed.whisperDevice === "auto")
          && (!parsed.whisperComputeType || parsed.whisperComputeType === "int8");
        if (usesLegacyDefaults) {
          this.cache.whisperEngine = "auto";
          this.cache.whisperModel = "auto";
          this.cache.whisperDevice = "auto";
          this.cache.whisperComputeType = "auto";
        }
        this.cache.asrConfigVersion = 2;
        await this.persist(this.cache);
      }
      if (!parsed.antigravityTimeoutMs || Number(parsed.antigravityTimeoutMs) <= 300000) {
        this.cache.antigravityTimeoutMs = 900000;
        await this.persist(this.cache);
      }
    } catch (_error) {
      this.cache = this.getDefaultSettings();
      await this.persist(this.cache);
    }
    return this.cache;
  }

  getSettings() {
    if (!this.cache) {
      throw new Error("Cài đặt được truy cập trước khi khởi tạo.");
    }
    return this.cache;
  }

  async saveSettings(partialSettings) {
    const current = await this.ensureLoaded();
    this.cache = {
      ...current,
      ...partialSettings
    };
    await this.persist(this.cache);
    return this.cache;
  }

  async persist(settings) {
    await atomicWrite(this.configPath, JSON.stringify(settings, null, 2));
  }
}

module.exports = ConfigStore;
