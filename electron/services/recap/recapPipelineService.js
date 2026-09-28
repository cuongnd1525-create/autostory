// 13-Stage Master Pipeline Orchestrator for AI Video Recap Mode.
// Coordinates media prep, hierarchical chunking, Gemini story modeling,
// TTS synthesis with silence trimming, semantic sync solving,
// draft proxy rendering, Gemini multimodal review, human review gate,
// and hardware-accelerated pristine final master rendering.

const fs = require("fs/promises");
const path = require("path");
const RecapMediaService = require("./recapMediaService");
const RecapAiService = require("./recapAiService");
const RecapTtsService = require("./recapTtsService");
const { RecapSyncSolver } = require("./recapSyncSolver");
const RecapRenderer = require("./recapRenderer");
const RecapHardwareService = require("./recapHardwareService");
const VoiceProfileService = require("../voiceProfileService");
const { throwIfCancelled } = require("../cancelToken");

class RecapPipelineService {
  constructor(options = {}) {
    this.projectStore = options.projectStore;
    this.voiceProfileService = options.voiceProfileService || new VoiceProfileService();
    this.hardwareService = options.hardwareService || new RecapHardwareService(options.settings || {});
    this.logger = options.logger || console;
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

    const mediaService = new RecapMediaService(settings);
    const aiService = new RecapAiService(settings);
    const ttsService = new RecapTtsService(settings);
    const renderer = new RecapRenderer({
      ffmpegPath: settings.ffmpegPath,
      ffprobePath: settings.ffprobePath,
      hardwareService: this.hardwareService,
      logger: this.logger
    });

    const workflowMode = settings.recapWorkflow || project.recapWorkflow || "full_auto";
    const allowShotReuse = Boolean(settings.allowShotReuse ?? project.allowShotReuse ?? false);
    const targetDurationSec = Number(settings.targetDurationSec || project.targetDurationSec || 60);

    this._log("Init", `Starting recap for project: ${project.title || projectId}`, {
      workflowMode,
      allowShotReuse,
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
        onProgress: (p) => onProgress({ stage: "proxy_generation", ...p })
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
        onProgress: (p) => onProgress({ stage: "scene_detection", ...p })
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
    let visualEvents = state.visualEvents;
    if (!visualEvents || !visualEvents.length) {
      onProgress({ stage: "hierarchical_analysis", percent: 25, message: "Analyzing visual events with Gemini..." });
      this._log("Stage 4", "Planning chunk intervals and analyzing with Gemini...");

      const chunks = mediaService.planChunks({
        scenes,
        sourceDuration: sourceMeta.duration,
        targetChunkSec: 240,
        overlapSec: 2
      });

      this._log("Stage 4", `Created ${chunks.length} analysis chunks.`);
      const collectedEvents = [];

      for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
        throwIfCancelled(cancelToken);
        const chunk = chunks[cIdx];
        onProgress({
          stage: "hierarchical_analysis",
          percent: 25 + Math.round(((cIdx + 1) / chunks.length) * 15),
          message: `Analyzing video chunk ${cIdx + 1} of ${chunks.length}...`
        });

        const chunkPath = chunk.isSingleChunk
          ? proxyPath
          : await mediaService.extractProxyChunk({
              proxyPath,
              chunk,
              outputDir: path.join(projectPaths.analysisDir, "chunks")
            });

        const chunkAnalysis = await aiService.analyzeVideoChunk({
          chunkVideoPath: chunkPath,
          chunkMetadata: chunk,
          cancelToken
        });

        for (const ev of chunkAnalysis.events || []) {
          // Adjust event source timecode if chunk was offset
          const adjustedStart = Number((chunk.sourceStartSec + ev.source_start).toFixed(3));
          const adjustedEnd = Number((chunk.sourceStartSec + ev.source_end).toFixed(3));
          collectedEvents.push({
            ...ev,
            source_start: adjustedStart,
            source_end: adjustedEnd,
            duration: Number((adjustedEnd - adjustedStart).toFixed(3))
          });
        }
      }

      visualEvents = collectedEvents;
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
        cancelToken
      });
      state.storyModel = storyModel;
      state.completedStages.push("story_synthesis");
      await this._saveState(statePath, state);
    }
    this._log("Stage 5", `Story synthesized: "${storyModel.title}" - ${storyModel.story_arcs?.length || 0} arcs.`);

    // ----------------------------------------------------
    // STAGE 6: Recap Edit Planning
    // ----------------------------------------------------
    throwIfCancelled(cancelToken);
    let recapPlan = state.recapPlan;
    if (!recapPlan) {
      onProgress({ stage: "edit_planning", percent: 48, message: "Planning recap narrative structure..." });
      this._log("Stage 6", `Planning recap beats for target duration ${targetDurationSec}s...`);
      recapPlan = await aiService.planRecap({
        storyModel,
        events: visualEvents,
        targetDurationSec,
        cancelToken
      });
      state.recapPlan = recapPlan;
      state.completedStages.push("edit_planning");
      await this._saveState(statePath, state);
    }
    this._log("Stage 6", `Recap plan ready: ${recapPlan.beats?.length || 0} narrative beats.`);

    // ----------------------------------------------------
    // STAGE 7: Grounded Narration Script Generation
    // ----------------------------------------------------
    throwIfCancelled(cancelToken);
    let speechUnits = state.speechUnits;
    if (!speechUnits || !speechUnits.length) {
      onProgress({ stage: "narration_generation", percent: 54, message: "Writing synchronized narration script..." });
      this._log("Stage 7", "Generating clause-level narration grounded in visual anchors...");

      // Get voice profile for words-per-second calibration
      const defaultVoice = settings.voice || "en-US-AndrewMultilingualNeural";
      const profile = await this.voiceProfileService.getProfile(defaultVoice, "edge");
      const wps = profile.wordsPerSecond || 2.7;

      speechUnits = await aiService.generateNarration({
        recapPlan,
        storyModel,
        events: visualEvents,
        wordsPerSecond: wps,
        cancelToken
      });
      state.speechUnits = speechUnits;
      state.completedStages.push("narration_generation");
      await this._saveState(statePath, state);
    }
    this._log("Stage 7", `Generated ${speechUnits.length} narration speech units.`);

    // ----------------------------------------------------
    // STAGE 8: TTS Synthesis & Leading/Trailing Silence Trimming
    // ----------------------------------------------------
    throwIfCancelled(cancelToken);
    let audioTracks = state.audioTracks;
    if (!audioTracks || Object.keys(audioTracks).length < speechUnits.length) {
      onProgress({ stage: "tts_synthesis", percent: 62, message: "Synthesizing and trimming voice narration..." });
      this._log("Stage 8", "Synthesizing voice narration and trimming edge silence...");

      audioTracks = await ttsService.synthesizeAll({
        speechUnits,
        outputDir: projectPaths.audioDir,
        voiceProfileService: this.voiceProfileService,
        onProgress: (p) => onProgress({ stage: "tts_synthesis", ...p })
      });
      state.audioTracks = audioTracks;
      state.completedStages.push("tts_synthesis");
      await this._saveState(statePath, state);
    }
    this._log("Stage 8", `TTS synthesized for ${Object.keys(audioTracks).length} units.`);

    // ----------------------------------------------------
    // STAGE 9: Semantic Synchronization & Edit Decision Solving
    // ----------------------------------------------------
    throwIfCancelled(cancelToken);
    let decisions = state.decisions;
    let traceability = state.traceability;
    if (!decisions || !decisions.length) {
      onProgress({ stage: "sync_solving", percent: 72, message: "Solving visual-audio synchronization..." });
      this._log("Stage 9", "Solving edit decisions using 5-tier mismatch resolution ladder...");

      const solver = new RecapSyncSolver({
        allowShotReuse,
        targetVisualLeadSec: Number(settings.visualLeadSec || 0.25),
        logger: this.logger
      });

      const solution = solver.solve({
        speechUnits,
        visualEvents,
        audioTracks,
        scenes,
        sourceDurationSec: sourceMeta.duration
      });

      decisions = solution.decisions;
      traceability = solution.traceability;
      state.decisions = decisions;
      state.traceability = traceability;
      state.syncMetrics = solution.metrics;
      state.completedStages.push("sync_solving");
      await this._saveState(statePath, state);
    }
    this._log("Stage 9", `Sync solved: ${decisions.length} decisions, ${traceability.length} clips.`);

    // ----------------------------------------------------
    // STAGE 10: Draft Video Rendering (Proxy Reel)
    // ----------------------------------------------------
    throwIfCancelled(cancelToken);
    let draftVideoPath = state.draftVideoPath;
    if (!draftVideoPath || !(await this._fileExists(draftVideoPath))) {
      onProgress({ stage: "draft_rendering", percent: 78, message: "Rendering draft proxy video..." });
      this._log("Stage 10", "Rendering fast draft proxy video...");

      const draftOutput = path.join(projectPaths.outputDir, `${project.id}-draft-reel.mp4`);
      draftVideoPath = await renderer.renderDraft({
        sourceVideoPath: project.sourceVideoPath,
        proxyVideoPath,
        decisions,
        outputPath: draftOutput,
        onProgress: (p) => onProgress({ stage: "draft_rendering", ...p }),
        cancelToken
      });

      state.draftVideoPath = draftVideoPath;
      state.completedStages.push("draft_rendering");
      await this._saveState(statePath, state);
    }
    this._log("Stage 10", `Draft video ready at: ${draftVideoPath}`);

    // ----------------------------------------------------
    // STAGE 11: AI Multimodal Draft Review & Self-Correction
    // ----------------------------------------------------
    throwIfCancelled(cancelToken);
    let reviewIteration = state.reviewIteration || 0;
    if (reviewIteration < 1) {
      onProgress({ stage: "quality_review", percent: 86, message: "Performing AI multimodal quality review..." });
      this._log("Stage 11", "Critiquing draft video using Gemini multimodal review...");

      try {
        const reviewResult = await aiService.reviewDraft({
          draftVideoPath,
          decisions,
          storyModel,
          cancelToken
        });

        state.qualityScore = reviewResult.overall_score;
        state.qualitySummary = reviewResult.summary;
        state.qualityIssues = reviewResult.issues || [];
        state.reviewIteration = reviewIteration + 1;
        state.completedStages.push("quality_review");
        await this._saveState(statePath, state);
        this._log("Stage 11", `Quality score: ${reviewResult.overall_score}/10, issues: ${state.qualityIssues.length}`);
      } catch (revErr) {
        this._log("Stage 11", `AI draft review skipped or non-fatal error: ${revErr.message}`);
        state.reviewIteration = 1;
        await this._saveState(statePath, state);
      }
    }

    // ----------------------------------------------------
    // STAGE 12: Human Review Gate (Review Before Final Render)
    // ----------------------------------------------------
    if (workflowMode === "review" && !state.userApprovedFinal) {
      this._log("Stage 12", "Entering Human Review Gate. Pausing for user approval.");
      state.reviewReady = true;
      await this._saveState(statePath, state);

      onProgress({
        stage: "human_review_gate",
        percent: 90,
        message: "Draft is ready for your review. Inspect narrative and timing before final render.",
        reviewReady: true,
        draftVideoPath
      });

      return {
        status: "review_ready",
        projectId,
        draftVideoPath,
        decisions,
        speechUnits,
        storyModel,
        qualityScore: state.qualityScore,
        qualityIssues: state.qualityIssues || []
      };
    }

    // ----------------------------------------------------
    // STAGE 13: Final Master Rendering
    // ----------------------------------------------------
    throwIfCancelled(cancelToken);
    onProgress({ stage: "final_render", percent: 92, message: "Rendering pristine final master from original source..." });
    this._log("Stage 13", "Rendering final master from pristine source with hardware acceleration...");

    const finalOutputName = `${project.title ? project.title.replace(/[^a-zA-Z0-9_-]/g, "_") : project.id}-recap-final.mp4`;
    const finalOutputPath = project.exportRoot
      ? path.join(project.exportRoot, finalOutputName)
      : path.join(projectPaths.outputDir, finalOutputName);

    const renderedFinalPath = await renderer.renderFinal({
      sourceVideoPath: project.sourceVideoPath,
      decisions,
      outputPath: finalOutputPath,
      onProgress: (p) => onProgress({ stage: "final_render", ...p }),
      cancelToken
    });

    state.finalVideoPath = renderedFinalPath;
    state.completedStages.push("final_render");
    state.completed = true;
    await this._saveState(statePath, state);

    // Update projectStore metadata
    await this.projectStore.updateProject(workspaceRoot, projectId, (prev) => ({
      ...prev,
      status: "completed",
      finalVideoPath: renderedFinalPath,
      recap: {
        completed: true,
        draftVideoPath,
        finalVideoPath: renderedFinalPath,
        decisionsCount: decisions.length,
        qualityScore: state.qualityScore || 9
      }
    }));

    onProgress({
      stage: "completed",
      percent: 100,
      message: "Recap video generated successfully!",
      finalVideoPath: renderedFinalPath
    });

    this._log("Done", `Recap pipeline completed successfully: ${renderedFinalPath}`);

    return {
      status: "completed",
      projectId,
      finalVideoPath: renderedFinalPath,
      draftVideoPath,
      decisions,
      metrics: state.syncMetrics
    };
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

module.exports = RecapPipelineService;
