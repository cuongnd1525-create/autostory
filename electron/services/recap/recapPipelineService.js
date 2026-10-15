// Shared source preparation and persistence for the editorial recap pipeline.

const fs = require("fs/promises");
const path = require("path");
const RecapMediaService = require("./recapMediaService");
const RecapAiService = require("./recapAiService");
const RecapTtsService = require("./recapTtsService");
const RecapRenderer = require("./recapRenderer");
const RecapHardwareService = require("./recapHardwareService");
const VoiceProfileService = require("../voiceProfileService");
const { throwIfCancelled } = require("../cancelToken");
const { validateChunkTimeline } = require("./recapTypes");
const AUDIO_RENDER_VERSION = 2;
const SceneIndex = require("./recapSceneIndexService");

class RecapPipelineService {
  constructor(options = {}) {
    this.projectStore = options.projectStore;
    this.voiceProfileService = options.voiceProfileService || new VoiceProfileService();
    this.hardwareService = options.hardwareService || new RecapHardwareService(options.settings || {});
    this.logger = options.logger || console;
    this.serviceFactories = options.serviceFactories || {};
  }

  _log(stage, message, data = null) {
    const prefix = `[Recap][${stage || "Pipeline"}]`;
    if (data) {
      this.logger.log(prefix, message, JSON.stringify(data));
    } else {
      this.logger.log(prefix, message);
    }
  }

  async _loadState(statePath) {
    try {
      const raw = await fs.readFile(statePath, "utf8");
      return JSON.parse(raw);
    } catch (_err) {
      return {
        stage: "init",
        completedStages: [],
        reviewIteration: 0
      };
    }
  }

  async _saveState(statePath, state) {
    const updated = {
      ...state,
      updatedAt: new Date().toISOString()
    };
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const tempPath = `${statePath}.tmp.${Date.now()}`;
    await fs.writeFile(tempPath, JSON.stringify(updated, null, 2), "utf8");
    await fs.rename(tempPath, statePath);
  }

  /**
   * Main entry point to run or resume a Recap project.
   */
  async runRecapProject({
    workspaceRoot,
    projectId,
    settings = {},
    onProgress = () => {},
    cancelToken = null
  }) {
    throwIfCancelled(cancelToken);

    if (!this.projectStore) {
      throw new Error("RecapPipelineService requires projectStore instance.");
    }

    const projectPaths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const project = await this.projectStore.getProject(workspaceRoot, projectId);

    if (!project) {
      throw new Error(`Project ${projectId} not found.`);
    }

    const statePath = path.join(projectPaths.analysisDir, "recap_state.json");
    let state = await this._loadState(statePath);
    const mediaService = this.serviceFactories.media?.(settings) || new RecapMediaService(settings);
    const analysisVersion = typeof mediaService.runCommand === "function" ? 4 : 2;
    // Older analysis applied chunk offsets twice. Preserve media preparation,
    // but regenerate all derived AI/audio/edit artifacts under the new contract.
    if (state.analysisVersion !== analysisVersion) {
      state = { sourceMeta: state.sourceMeta, proxyPath: state.proxyPath, scenes: state.scenes,
        completedStages: (state.completedStages || []).filter((stage) => ["validate_inputs", "proxy_generation", "scene_detection"].includes(stage)),
        stage: "init", reviewIteration: 0, analysisVersion };
      await this._saveState(statePath, state);
    }

    const aiService = this.serviceFactories.ai?.(settings) || new RecapAiService(settings);
    const ttsService = this.serviceFactories.tts?.(settings) || new RecapTtsService(settings);
    ttsService.voiceProfileService = this.voiceProfileService;
    const renderer = this.serviceFactories.renderer?.(settings) || new RecapRenderer({
      settings,
      ffmpegPath: settings.ffmpegPath,
      ffprobePath: settings.ffprobePath,
      hardwareService: this.hardwareService,
      logger: this.logger
    });

    const workflowMode = settings.recapWorkflow || project.recapWorkflow || "full_auto";
    const allowShotReuse = Boolean(settings.allowShotReuse ?? project.allowShotReuse ?? false);
    const muteSourceAudio = Boolean(settings.recapMuteSourceAudio ?? project.recapMuteSourceAudio ?? false);
    if (project.recapMuteSourceAudio !== muteSourceAudio) {
      await this.projectStore.updateProject(workspaceRoot, projectId, { recapMuteSourceAudio: muteSourceAudio });
      project.recapMuteSourceAudio = muteSourceAudio;
    }
    if (state.audioRenderVersion !== AUDIO_RENDER_VERSION || Boolean(state.renderMuteSourceAudio) !== muteSourceAudio) {
      for (const key of ["draftVideoPath", "finalVideoPath", "qualityScore", "qualitySummary", "qualityIssues", "qualityGate", "reviewError", "completed", "reviewReady"]) delete state[key];
      state.reviewIteration = 0;
      state.userApprovedFinal = false;
      state.completedStages = state.completedStages.filter((stage) => !["draft_rendering", "quality_review", "final_render"].includes(stage));
    }
    state.renderMuteSourceAudio = muteSourceAudio;
    state.audioRenderVersion = AUDIO_RENDER_VERSION;
    await this._saveState(statePath, state);
    const targetDurationSec = Number(settings.targetDurationSec || project.targetDurationSec || 60);

    this._log("Init", `Starting recap for project: ${project.title || projectId}`, {
      workflowMode,
      allowShotReuse,
      muteSourceAudio,
      targetDurationSec
    });

    // ----------------------------------------------------
    // STAGE 1: Validate Inputs
    // ----------------------------------------------------
    throwIfCancelled(cancelToken);
    onProgress({ stage: "validate_inputs", percent: 2, message: "Validating input video..." });
    this._log("Stage 1", "Validating input video and source paths...");

    if (!project.sourceVideoPath) {
      throw new Error("No source video path specified for project.");
    }
    await fs.access(project.sourceVideoPath);

    let sourceMeta = state.sourceMeta;
    if (!sourceMeta) {
      sourceMeta = await mediaService.probeVideo(project.sourceVideoPath);
      if (!sourceMeta.duration || sourceMeta.duration < 2) {
        throw new Error(`Source video duration is too short (${sourceMeta.duration}s).`);
      }
      state.sourceMeta = sourceMeta;
      state.completedStages.push("validate_inputs");
      await this._saveState(statePath, state);
    }
    this._log("Stage 1", `Source video validated: ${sourceMeta.duration}s, ${sourceMeta.width}x${sourceMeta.height}`);

    // ----------------------------------------------------
    // STAGE 2: Proxy Generation
    // ----------------------------------------------------
    throwIfCancelled(cancelToken);
    let proxyPath = state.proxyPath;
    if (!proxyPath || !(await this._fileExists(proxyPath))) {
      onProgress({ stage: "proxy_generation", percent: 8, message: "Creating 480p/8fps analysis proxy..." });
      this._log("Stage 2", "Generating lightweight analysis proxy with burned timecode...");
      proxyPath = await mediaService.ensureAnalysisProxy({
        sourceVideoPath: project.sourceVideoPath,
        outputDir: projectPaths.analysisDir,
        onProgress: (p) => onProgress({ ...p, stage: "proxy_generation", percent: 8 + Math.min(100, Math.max(0, Number(p.percent) || 0)) * 0.09 })
      });
      state.proxyPath = proxyPath;
      state.completedStages.push("proxy_generation");
      await this._saveState(statePath, state);
    }
    this._log("Stage 2", `Proxy ready at: ${proxyPath}`);

    // ----------------------------------------------------
    // STAGE 3: Scene Detection
    // ----------------------------------------------------
    throwIfCancelled(cancelToken);
    let scenes = state.scenes;
    if (!scenes || !scenes.length) {
      onProgress({ stage: "scene_detection", percent: 18, message: "Detecting scene boundaries..." });
      this._log("Stage 3", "Running scene detection on analysis proxy...");
      scenes = await mediaService.detectScenes({
        proxyPath,
        sourceDuration: sourceMeta.duration,
        onProgress: (p) => onProgress({ ...p, stage: "scene_detection", percent: 18 + Math.min(100, Math.max(0, Number(p.percent) || 0)) * 0.06 })
      });
      state.scenes = scenes;
      state.completedStages.push("scene_detection");
      await this._saveState(statePath, state);
    }
    this._log("Stage 3", `Detected ${scenes.length} scene boundaries.`);

    // ----------------------------------------------------
    // STAGE 4: Hierarchical Video Analysis (Chunking + Gemini)
    // ----------------------------------------------------
    throwIfCancelled(cancelToken);
    // Revalidate saved anchors under the corrected seconds contract. Preserve
    // good chunks; downstream editorial artifacts cannot reference rejected IDs.
    let cachedChunks = [];
    try { cachedChunks = JSON.parse(state.chunkAnalysisKey).chunks || []; } catch (_) {}
    let invalidatedAnchors = false;
    for (const [key, analysis] of Object.entries(state.chunkAnalyses || {})) {
      const match = /^(\d+)(?::part([12]))?$/.exec(key), original = match && cachedChunks[Number(match[1])];
      if (!original) continue;
      const metadata = { ...original };
      if (match[2]) {
        const midpoint = (original.sourceStartSec + original.sourceEndSec) / 2;
        metadata.sourceStartSec = match[2] === "1" ? original.sourceStartSec : midpoint;
        metadata.sourceEndSec = match[2] === "1" ? midpoint : original.sourceEndSec;
        metadata.durationSec = metadata.sourceEndSec - metadata.sourceStartSec;
      }
      try {
        validateChunkTimeline(analysis.events, metadata);
        if (analysis.events.some(event => event.anchorMethod === "scene_frames" && event.duration > 24))
          throw new Error("Sự kiện ghép quá 24 giây; cần tách hành động và kiểm tra outro.");
      }
      catch (error) {
        delete state.chunkAnalyses[key]; delete state.chunkAnalyses[match[1]];
        invalidatedAnchors = true;
        onProgress({ stage: "hierarchical_analysis", level: "WARNING", message: `Bỏ checkpoint chunk ${Number(match[1]) + 1} sai đơn vị thời gian. ${error.message}` });
      }
    }
    if (invalidatedAnchors) {
      for (const key of ["visualEvents", "storyModel", "angles", "hooks", "hooksKey", "auditions", "editorialKey", "scriptKey", "recapPlan", "speechUnits", "audioTracks", "decisions", "traceability", "syncMetrics", "durationGate", "draftVideoPath", "finalVideoPath", "qualityScore", "qualitySummary", "qualityIssues", "qualityGate", "completed", "reviewReady", "reviewError", "manualDecisions"]) delete state[key];
      state.reviewIteration = 0; state.userApprovedFinal = false;
      state.completedStages = state.completedStages.filter(stage => ["validate_inputs", "proxy_generation", "scene_detection"].includes(stage));
      await this._saveState(statePath, state);
    }
    let visualEvents = state.visualEvents;
    if (!visualEvents || !visualEvents.length) {
      onProgress({ stage: "hierarchical_analysis", percent: 25, message: `Analyzing visual events with ${aiService.providerService.label}...` });
      this._log("Stage 4", "Planning chunk intervals and analyzing with Gemini...");

      const chunks = mediaService.planChunks({
        scenes,
        sourceDuration: sourceMeta.duration,
        targetChunkSec: 240,
        overlapSec: 2
      });

      this._log("Stage 4", `Created ${chunks.length} analysis chunks.`);
      const collectedEvents = [];
      const analysisKey = JSON.stringify({ version: state.analysisVersion, proxyPath, chunks,
        provider: aiService.providerService.provider });
      // A faster model/prompt does not invalidate already validated source events.
      // Migrate old checkpoints without replaying successful expensive calls.
      let savedKey = state.chunkAnalysisKey;
      const comparableSourceKey = (key) => { const { model, provider, ...sourceKey } = JSON.parse(key); return JSON.stringify(sourceKey); };
      try { savedKey = comparableSourceKey(savedKey); } catch (_) { /* no compatible checkpoint */ }
      // Provider changes do not invalidate source anchors under the same
      // timestamp contract. This also preserves completed split parts.
      if (savedKey !== comparableSourceKey(analysisKey)) { state.chunkAnalyses = {}; state.chunkSplits = {}; }
      state.chunkAnalysisKey = analysisKey;
      state.chunkAnalyses ||= {};
      state.chunkSplits ||= {};

      for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
        throwIfCancelled(cancelToken);
        const chunk = chunks[cIdx];
        const chunkProgress = { stage: "hierarchical_analysis", chunkIndex: cIdx + 1, chunkCount: chunks.length,
          percent: 25 + Math.round((cIdx / chunks.length) * 15) };
        const cached = state.chunkAnalyses[String(cIdx)];
        if (Array.isArray(cached?.events)) {
          collectedEvents.push(...cached.events);
          onProgress({ ...chunkProgress, message: `Đã khôi phục phân tích chunk ${cIdx + 1}/${chunks.length} từ lần trước.` });
          continue;
        }
        state.stage = "hierarchical_analysis";
        state.analysisChunk = { index: cIdx + 1, count: chunks.length };
        await this._saveState(statePath, state);
        onProgress({
          ...chunkProgress,
          message: `Analyzing video chunk ${cIdx + 1} of ${chunks.length}...`
        });

        const analyze = async (metadata, key, part = null) => {
          throwIfCancelled(cancelToken);
          if (Array.isArray(state.chunkAnalyses[key]?.events)) return state.chunkAnalyses[key];
          const chunkPath = metadata.isSingleChunk ? proxyPath : await mediaService.extractProxyChunk({
            proxyPath, chunk: metadata, outputDir: path.join(projectPaths.analysisDir, "chunks") });
          onProgress({ ...chunkProgress, ...(part ? { chunkPart: part, chunkPartCount: 2 } : {}),
            message: `Đang phân tích chunk ${cIdx + 1}/${chunks.length}${part ? ` · phần ${part}/2` : ""} (${metadata.durationSec || metadata.sourceEndSec - metadata.sourceStartSec}s)...` });
          const startedAt = Date.now();
          let sceneIndex;
          if (analysisVersion >= 3) {
            onProgress({ ...chunkProgress, message: `Đang lập chỉ mục khung hình có ID cảnh chính xác cho chunk ${cIdx + 1}/${chunks.length}...` });
            sceneIndex = await new SceneIndex(mediaService).prepare({ proxyPath, chunkPath, chunk: metadata, scenes,
              directory: path.join(projectPaths.analysisDir, "scene-index"), signal: cancelToken?.signal });
          }
          const result = await aiService.analyzeVideoChunk({ chunkVideoPath: chunkPath, chunkMetadata: metadata, sceneIndex, cancelToken,
            onProgress: (p) => onProgress({ ...p, ...chunkProgress, ...(part ? { chunkPart: part, chunkPartCount: 2 } : {}) }) });
          throwIfCancelled(cancelToken);
          if (!Array.isArray(result.events)) throw new Error(`AI không trả danh sách sự kiện hình ảnh cho chunk ${cIdx + 1}/${chunks.length}.`);
          result.elapsedMs = Date.now() - startedAt; state.chunkAnalyses[key] = result;
          await this._saveState(statePath, state); return result;
        };
        let chunkAnalysis;
        if (!state.chunkSplits[String(cIdx)]) {
          try { chunkAnalysis = await analyze(chunk, String(cIdx)); }
          catch (error) {
            const recoverable = ["output_limit", "invalid_json"].includes(error.kind) || /timeout/.test(error.kind || "") || /output token limit|MAX_TOKENS|response was cut off|timed? out/i.test(error.message);
            if (!recoverable || cancelToken?.signal?.aborted || chunk.sourceEndSec - chunk.sourceStartSec <= 60) throw error;
            state.chunkSplits[String(cIdx)] = true;
            await this._saveState(statePath, state);
            onProgress({ ...chunkProgress, level: "WARNING", message: `Chunk ${cIdx + 1}/${chunks.length} chưa hoàn tất (${error.kind || "giới hạn đầu ra"}). Chia thành 2 phần nhỏ và giữ checkpoint từng phần.` });
          }
        }
        if (!chunkAnalysis) {
          const midpoint = (chunk.sourceStartSec + chunk.sourceEndSec) / 2, results = [];
          for (let part = 1; part <= 2; part++) {
            const start = part === 1 ? chunk.sourceStartSec : midpoint;
            const end = part === 1 ? midpoint : chunk.sourceEndSec;
            results.push(await analyze({ ...chunk, chunkIndex: `${chunk.chunkIndex}-part-${part}`,
              sourceStartSec: start, sourceEndSec: end, durationSec: end - start, isSingleChunk: false }, `${cIdx}:part${part}`, part));
          }
          chunkAnalysis = { chunkIndex: chunk.chunkIndex, summary: results.map((r) => r.summary).join(" "),
            characters: results.flatMap((r) => r.characters || []), events: results.flatMap((r) => r.events), elapsedMs: results.reduce((sum, r) => sum + r.elapsedMs, 0) };
        }

        throwIfCancelled(cancelToken);
        if (!Array.isArray(chunkAnalysis.events)) throw new Error(`AI không trả danh sách sự kiện hình ảnh cho chunk ${cIdx + 1}/${chunks.length}. Các chunk đã hoàn tất được giữ lại để tiếp tục.`);
        state.chunkAnalyses[String(cIdx)] = chunkAnalysis;
        await this._saveState(statePath, state);

        for (const ev of chunkAnalysis.events || []) {
          collectedEvents.push(ev);
        }
      }

      visualEvents = collectedEvents;
      if (!visualEvents.length) throw new Error("AI không nhận diện được sự kiện hình ảnh nào trong video. Hãy kiểm tra đầu vào hoặc model đã chọn.");
      state.visualEvents = visualEvents;
      state.completedStages.push("hierarchical_analysis");
      await this._saveState(statePath, state);
    }
    this._log("Stage 4", `Total visual events indexed: ${visualEvents.length}`);

    // ----------------------------------------------------
    // STAGE 5: Global Story Synthesis
    // ----------------------------------------------------
    throwIfCancelled(cancelToken);
    let storyModel = state.storyModel;
    if (!storyModel) {
      onProgress({ stage: "story_synthesis", percent: 42, message: "Synthesizing global Story Bible..." });
      this._log("Stage 5", "Synthesizing Story Bible (characters, arcs, turning points, climax)...");
      storyModel = await aiService.buildStoryModel({
        events: visualEvents,
        videoMetadata: sourceMeta,
        cancelToken,
        onProgress: (p) => onProgress({ ...p, stage: "story_synthesis", percent: 42 })
      });
      state.storyModel = storyModel;
      state.completedStages.push("story_synthesis");
      await this._saveState(statePath, state);
    }
    this._log("Stage 5", `Story synthesized: "${storyModel.title}" - ${storyModel.story_arcs?.length || 0} arcs.`);
    return { project, paths: projectPaths, state, statePath, ai: aiService, tts: ttsService, renderer };

  }

  /**
   * Retrieves review state for a project in Review Before Final Render mode.
   */
  async getReviewState(workspaceRoot, projectId) {
    const projectPaths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const statePath = path.join(projectPaths.analysisDir, "recap_state.json");
    const state = await this._loadState(statePath);
    return state;
  }

  /**
   * Updates review decisions or speech units from user feedback and re-solves.
   */
  async updateReviewDecisions(workspaceRoot, projectId, { speechUnits, decisions, userApprovedFinal = false }) {
    const projectPaths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const statePath = path.join(projectPaths.analysisDir, "recap_state.json");
    const state = await this._loadState(statePath);

    if (speechUnits) state.speechUnits = speechUnits;
    if (decisions) state.decisions = decisions;
    if (userApprovedFinal !== undefined) state.userApprovedFinal = Boolean(userApprovedFinal);

    await this._saveState(statePath, state);
    return state;
  }

  async _fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch (_err) {
      return false;
    }
  }
}

module.exports = require("./recapEditorialPipeline")(RecapPipelineService);
