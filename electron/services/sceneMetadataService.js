const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const FfmpegService = require("./ffmpegService");
const SubtitleService = require("./subtitleService");

function runCommand(command, args, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const child = spawn(command, args, { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out while building scene metadata.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}: ${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function quoteCommandArg(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function buildOllamaVisionCommand(project = {}) {
  if (!project.ollamaVisionAssist) {
    return "";
  }
  const model = project.ollamaVisionModel || process.env.CINEVIRAL_OLLAMA_VISION_MODEL || "llava";
  const prompt = [
    "Look at this movie frame and return compact JSON only.",
    "Schema: {\"caption\":\"one concrete sentence about visible characters/actions/place\",\"tags\":[\"3-8 concrete visual tags\"]}.",
    "Do not invent plot, names, relationships, or offscreen events."
  ].join(" ");
  const command = process.env.OLLAMA_COMMAND || process.env.CINEVIRAL_OLLAMA_COMMAND || "ollama";
  return `${quoteCommandArg(command)} run ${quoteCommandArg(model)} ${quoteCommandArg(prompt)} {image}`;
}

function isWeakFallbackMetadata(metadata) {
  return !metadata
    || metadata.provider === "local_scene_metadata_fallback"
    || !Array.isArray(metadata.scenes)
    || metadata.scenes.every((scene) =>
      !(scene.local_visual_tags || []).length
      && Number(scene.motion_score || 0) === 0
      && (scene.motion_intensity || "UNKNOWN") === "UNKNOWN"
    );
}

function buildFallbackMetadata({ detected, transcript, videoPath }) {
  const scenes = Array.isArray(detected?.scenes) ? detected.scenes : [];
  return {
    provider: "metadata_fast_fallback",
    video: path.basename(videoPath),
    transcriptProvider: transcript?.provider || "none",
    sceneCount: scenes.length,
    scenes: scenes.map((scene) => ({
      scene_id: scene.sceneId,
      sceneId: scene.sceneId,
      timestamp: `${Number(scene.startSec || 0).toFixed(3)} -> ${Number(scene.endSec || 0).toFixed(3)}`,
      startSec: Number(scene.startSec || 0),
      endSec: Number(scene.endSec || 0),
      duration_seconds: Number(scene.duration || Math.max(0, Number(scene.endSec || 0) - Number(scene.startSec || 0))),
      audio_transcript: "",
      motion_intensity: "UNKNOWN",
      motion_score: 0,
      audio_energy: "LOW",
      light_change: "UNKNOWN",
      light_change_score: 0,
      local_visual_tags: [],
      reframe: { mode: "center_fallback", subject_x: 0.5, subject_y: 0.5, confidence: 0 }
    }))
  };
}

class SceneMetadataService {
  constructor(settings = {}) {
    this.settings = settings;
    this.pythonPath = settings.pythonPath || process.env.PYTHON || "python";
    this.subtitleService = new SubtitleService({
      ...settings,
      whisperTimeoutMs: Number(settings.metadataWhisperTimeoutMs || settings.whisperTimeoutMs || 300000)
    });
  }

  async extractAudio(videoPath, audioPath) {
    const ffmpeg = new FfmpegService(this.settings);
    await ffmpeg.run(ffmpeg.ffmpegPath, [
      "-y",
      "-i",
      videoPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      audioPath
    ], { captureStdout: false });
  }

  async transcribeToSrt({ videoPath, paths, project }) {
    if (project.subtitleSourcePath) {
      return {
        provider: "srt_file",
        subtitlePath: project.subtitleSourcePath
      };
    }
    if (project.autoWhisper === false) {
      return {
        provider: "disabled",
        subtitlePath: "",
        error: "Whisper disabled"
      };
    }
    const shouldRunMetadataWhisper = Boolean(this.settings.metadataAutoWhisper)
      || (project.mode === "recap" && project.autoWhisper !== false);
    if (!shouldRunMetadataWhisper) {
      return {
        provider: "skipped_fast_metadata",
        subtitlePath: "",
        error: "Metadata Whisper skipped for fast analysis. Provide an SRT or set CINEVIRAL_METADATA_AUTO_WHISPER=1 to enable it."
      };
    }

    const audioPath = path.join(paths.tempDir, "metadata-source-audio.wav");
    const outputDir = paths.analysisDir;
    await fs.mkdir(outputDir, { recursive: true });
    await this.extractAudio(videoPath, audioPath);

    const result = await this.subtitleService.transcribeToSrt({
      audioPath,
      outputDir,
      narrationLanguage: project.sourceLanguage || "auto",
      cacheDir: path.join(paths.tempDir, "metadata-asr-cache")
    });
    return {
      provider: result.provider,
      subtitlePath: result.subtitlePath,
      profile: result.profile
    };
  }

  async runMetadataScript({ videoPath, detectedScenePath, subtitlePath, outputPath, project }) {
    const scriptPath = path.join(__dirname, "..", "..", "tools", "scene_metadata.py");
    const args = [
      scriptPath,
      "--video",
      videoPath,
      "--scenes",
      detectedScenePath,
      "--output",
      outputPath
    ];
    if (subtitlePath) {
      args.push("--srt", subtitlePath);
    }
    const visionTaggerCommand = this.settings.localVisionTaggerCommand || process.env.CINEVIRAL_VISION_TAGGER_COMMAND || buildOllamaVisionCommand(project);
    if (visionTaggerCommand) {
      args.push("--vision-tagger-command", visionTaggerCommand);
    }
    args.push("--max-scenes", String(this.settings.metadataMaxScenes || 120));
    args.push("--samples-per-scene", String(this.settings.metadataSamplesPerScene || 2));

    const timeoutMs = Number(this.settings.metadataVisionTimeoutMs || (visionTaggerCommand ? 20 * 60 * 1000 : 90000));
    const parseOutput = (output) => JSON.parse(output.trim() || "{}");
    let output;
    try {
      output = await runCommand(this.pythonPath, args, timeoutMs);
      const parsed = parseOutput(output);
      if (!isWeakFallbackMetadata(parsed) || this.pythonPath !== "python") {
        return parsed;
      }
    } catch (_error) {
      output = "";
    }
    output = await runCommand("py", ["-3", ...args], timeoutMs);
    return parseOutput(output);
  }

  async build({ videoPath, detectedScenePath, paths, project, onProgress }) {
    await fs.mkdir(paths.analysisDir, { recursive: true });
    await fs.mkdir(paths.tempDir, { recursive: true });
    const outputPath = path.join(paths.analysisDir, "scene-metadata-chain.json");
    let transcript = null;
    const detected = JSON.parse(await fs.readFile(detectedScenePath, "utf8").catch(() => "{\"scenes\":[]}"));
    try {
      onProgress?.("Checking transcript source");
      transcript = await this.transcribeToSrt({ videoPath, paths, project });
    } catch (error) {
      transcript = {
        provider: "failed",
        subtitlePath: "",
        error: error.message
      };
    }

    onProgress?.("Scanning visual metadata locally");
    let metadata;
    try {
      metadata = await this.runMetadataScript({
        videoPath,
        detectedScenePath,
        subtitlePath: transcript?.subtitlePath || "",
        outputPath,
        project
      });
    } catch (error) {
      metadata = buildFallbackMetadata({ detected, transcript, videoPath });
      metadata.error = error.message;
    }
    metadata.transcript = transcript;
    metadata.generatedAt = new Date().toISOString();
    await fs.writeFile(outputPath, JSON.stringify(metadata, null, 2), "utf8");
    return {
      metadataPath: outputPath,
      transcriptPath: transcript?.subtitlePath || "",
      transcriptProvider: transcript?.provider || "none",
      transcriptError: transcript?.error || "",
      scenes: Array.isArray(metadata.scenes) ? metadata.scenes : [],
      provider: metadata.provider || "unknown"
    };
  }
}

module.exports = SceneMetadataService;
