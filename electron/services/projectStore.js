const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

function slugify(input) {
  return String(input || "project")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function atomicWrite(filePath, contents) {
  await ensureDir(path.dirname(filePath));
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

class ProjectStore {
  constructor() {
    this.updateQueues = new Map();
  }

  async ensureWorkspaceRoot(workspaceRoot) {
    await ensureDir(workspaceRoot);
  }

  getProjectPaths(workspaceRoot, projectId) {
    const rootDir = path.join(workspaceRoot, projectId);
    return {
      rootDir,
      metaPath: path.join(rootDir, "project.json"),
      analysisDir: path.join(rootDir, "analysis"),
      assetsDir: path.join(rootDir, "assets"),
      audioDir: path.join(rootDir, "audio"),
      clipsDir: path.join(rootDir, "clips"),
      outputDir: path.join(rootDir, "output"),
      tempDir: path.join(rootDir, "temp")
    };
  }

  async createProject(workspaceRoot, payload) {
    await this.ensureWorkspaceRoot(workspaceRoot);

    const timestamp = new Date().toISOString();
    const projectId = `${slugify(payload.title || path.parse(payload.sourceVideoPath).name)}-${crypto.randomUUID().slice(0, 8)}`;
    const projectPaths = this.getProjectPaths(workspaceRoot, projectId);

    await Promise.all([
      ensureDir(projectPaths.rootDir),
      ensureDir(projectPaths.analysisDir),
      ensureDir(projectPaths.assetsDir),
      ensureDir(projectPaths.audioDir),
      ensureDir(projectPaths.clipsDir),
      ensureDir(projectPaths.outputDir),
      ensureDir(projectPaths.tempDir)
    ]);

    const project = {
      id: projectId,
      title: payload.title || path.parse(payload.sourceVideoPath).name,
      sourceVideoPath: payload.sourceVideoPath,
      exportRoot: payload.exportRoot || "",
      exportLayout: payload.exportLayout || "flat",
      mode: payload.mode || "dubbing",
      analysisWorkflow: payload.analysisWorkflow || "",
      manualGeminiPackPath: payload.manualGeminiPackPath || "",
      manualGeminiPromptOptions: payload.manualGeminiPromptOptions || null,
      subtitleSourcePath: payload.subtitleSourcePath || "",
      storyScriptPath: payload.storyScriptPath || "",
      storyScriptPaths: Array.isArray(payload.storyScriptPaths) ? payload.storyScriptPaths : (payload.storyScriptPath ? [payload.storyScriptPath] : []),
      autoStoryConfig: payload.autoStoryConfig || null,
      // AutoStory engine version at project ROOT (the live service checks project.autoStoryContractVersion).
      // Only persist for an explicit V3/V4 selection; V2/legacy stays undefined so existing behavior is unchanged.
      autoStoryContractVersion: [3, 4].includes(Number(payload.autoStoryContractVersion)) ? Number(payload.autoStoryContractVersion) : undefined,
      autoStoryJobPath: payload.autoStoryJobPath || "",
      autoWhisper: payload.autoWhisper !== false,
      sourceLanguage: payload.sourceLanguage || "auto",
      targetLanguage: payload.targetLanguage || payload.narrationLanguage || "vi",
      framePreset: payload.framePreset || "original",
      visualRemixEnabled: Boolean(payload.visualRemixEnabled),
      ollamaVisionAssist: Boolean(payload.ollamaVisionAssist),
      ollamaVisionModel: payload.ollamaVisionModel || "gemma4",
      autoFitVoice: payload.autoFitVoice !== false,
      dubbingRenderMode: payload.dubbingRenderMode || "speech_first_clustered",
      dubbingMinClusterDuration: Number(payload.dubbingMinClusterDuration || 5),
      dubbingMaxClusterDuration: Number(payload.dubbingMaxClusterDuration || 12),
      dubbingMaxSafeStretch: Number(payload.dubbingMaxSafeStretch || 0.08),
      dubbingAllowStrictTrim: Boolean(payload.dubbingAllowStrictTrim),
      dubbingVoiceNormalize: payload.dubbingVoiceNormalize !== false,
      subtitleStyle: payload.subtitleStyle || "white_black_outline",
      showSubtitles: payload.showSubtitles !== false,
      omniVoiceRenderMode: payload.omniVoiceRenderMode || "segment",
      storytimeContinuousVoice: payload.storytimeContinuousVoice !== false,
      storytimeVoiceRenderMode: payload.storytimeVoiceRenderMode || "clustered",
      storytimeVoiceDrivenVisuals: payload.storytimeVoiceDrivenVisuals !== false,
      videoDecoration: payload.videoDecoration || {
        canvasEnabled: false,
        canvasAspect: "9:16",
        customWidth: 1080,
        customHeight: 1920,
        blurBackgroundEnabled: false,
        blurStrength: 24,
        topCaptionEnabled: false,
        topCaptionText: "",
        topCaptionFontSize: 52,
        topCaptionYPercent: 8,
        partLabelEnabled: false,
        partLabelAutoFromPart: true,
        partLabelText: "",
        partLabelXPercent: 12,
        partLabelYPercent: 8,
        partLabelFontSize: 38,
        partLabelTextColor: "#ffffff",
        partLabelBackgroundColor: "#0b0d11",
        partLabelBackgroundOpacity: 0.82,
        partLabelUppercase: true,
        partLabelAlignment: "center",
        partLabelStyle: "compact",
        foregroundScalePercent: 100,
        foregroundXPercent: 50,
        foregroundYPercent: 50
      },
      videoEditUpdatedAt: "",
      draftVoiceMode: payload.draftVoiceMode || "edge_neural",
      draftVoiceProvider: payload.draftVoiceProvider || "edge_neural",
      draftVoiceId: payload.draftVoiceId || "",
      sourceSubtitleMask: payload.sourceSubtitleMask || {
        enabled: false,
        mode: "blur",
        xPercent: 0,
        widthPercent: 100,
        heightPercent: 16,
        bottomPercent: 6,
        strength: 18
      },
      transitionStyle: payload.transitionStyle || "hard_cut",
      mixer: payload.mixer || {
        voiceVolume: 100,
        sourceVolume: payload.mode === "highlight_cut" ? 20 : 20,
        narrationSourceAudioOverride: false,
        bgmVolume: 40,
        ducking: 70,
        bgmPath: ""
      },
      voiceDesign: payload.voiceDesign || {
        tab: "designed",
        genderAge: "female",
        pitch: "moderate",
        accent: "none",
        trait: "normal",
        prompt: "female, moderate pitch"
      },
      reviewStyle: payload.reviewStyle,
      genreMode: payload.genreMode || "thriller",
      perspective: payload.perspective || "third_person",
      spoilerMode: payload.spoilerMode,
      narrationLanguage: payload.narrationLanguage || "vi",
      rewriteVoiceover: payload.rewriteVoiceover || false,
      viralOptimization: payload.viralOptimization !== false,
      viralPlatform: payload.viralPlatform || "tiktok",
      viralAngleSetting: payload.viralAngleSetting || "auto",
      retentionAggressiveness: payload.retentionAggressiveness || "balanced",
      spoilerControl: payload.spoilerControl || "balanced",
      loopEnding: payload.loopEnding !== false,
      sourceAudioVolumePercentage: typeof payload.sourceAudioVolumePercentage === "number" ? payload.sourceAudioVolumePercentage : 0,
      muteSourceAudio: payload.muteSourceAudio !== false,
      targetDuration: Number(payload.targetDuration),
      voiceSpeed: Number(payload.voiceSpeed || 1),
      narrationEnabled: Boolean(payload.narrationEnabled),
      voiceProvider: payload.voiceProvider || "edge_neural",
      voiceId: payload.voiceId || "",
      cloneSourceVoice: Boolean(payload.cloneSourceVoice),
      status: "draft",
      progressPercent: 0,
      statusMessage: "Sẵn sàng render",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      analysis: null,
      artifacts: {},
      runHistory: []
    };

    await this.saveProject(workspaceRoot, project);
    return project;
  }

  async listProjects(workspaceRoot) {
    await this.ensureWorkspaceRoot(workspaceRoot);
    const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
    const projects = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const metaPath = path.join(workspaceRoot, entry.name, "project.json");
      try {
        const raw = await fs.readFile(metaPath, "utf8");
        projects.push(JSON.parse(raw));
      } catch (_error) {
        // Ignore malformed or incomplete folders.
      }
    }

    return projects.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  async getProject(workspaceRoot, projectId) {
    const projectPaths = this.getProjectPaths(workspaceRoot, projectId);
    const raw = await fs.readFile(projectPaths.metaPath, "utf8");
    return JSON.parse(raw);
  }

  async saveProject(workspaceRoot, project) {
    const projectPaths = this.getProjectPaths(workspaceRoot, project.id);
    project.updatedAt = new Date().toISOString();
    project.revision = Math.max(1, Number(project.revision || 0));
    await ensureDir(projectPaths.rootDir);
    await atomicWrite(projectPaths.metaPath, JSON.stringify(project, null, 2));
    return project;
  }

  async updateProject(workspaceRoot, projectId, partial) {
    const queueKey = `${path.resolve(workspaceRoot)}::${projectId}`;
    const previous = this.updateQueues.get(queueKey) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const project = await this.getProject(workspaceRoot, projectId);
      const updated = {
        ...project,
        ...partial,
        revision: Number(project.revision || 0) + 1
      };
      if (partial.analysis) {
        updated.analysis = partial.analysis;
      }
      if (partial.artifacts) {
        updated.artifacts = {
          ...project.artifacts,
          ...partial.artifacts
        };
      }
      if (partial.runHistory) {
        updated.runHistory = partial.runHistory;
      }
      await this.saveProject(workspaceRoot, updated);
      return updated;
    });
    this.updateQueues.set(queueKey, operation);
    try {
      return await operation;
    } finally {
      if (this.updateQueues.get(queueKey) === operation) {
        this.updateQueues.delete(queueKey);
      }
    }
  }

  async writeJson(filePath, payload) {
    await atomicWrite(filePath, JSON.stringify(payload, null, 2));
  }

  async writeText(filePath, text) {
    await atomicWrite(filePath, text);
  }
}

module.exports = ProjectStore;
