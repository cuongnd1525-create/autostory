const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const MAX_WHISPER_TIMEOUT_MS = 5 * 60 * 1000;

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function runCommand(command, args, timeoutMs = MAX_WHISPER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const child = spawn(command, args, { windowsHide: true });
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(
        `${command} timed out after ${Math.round(timeoutMs / 60000)} minutes while transcribing subtitles.`
      )));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => {
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}: ${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    }));
  });
}

function pythonArgs(command, args) {
  return String(command || "").toLowerCase() === "py" ? ["-3", ...args] : args;
}

function normalizeEngine(value) {
  const engine = String(value || "").trim().toLowerCase();
  if (["faster-whisper", "openai-whisper", "nvidia-parakeet"].includes(engine)) return engine;
  return "auto";
}

function normalizeLanguage(value) {
  const language = String(value || "auto").trim().toLowerCase();
  return language || "auto";
}

async function buildAudioCacheKey(audioPath = "") {
  const resolvedPath = path.resolve(String(audioPath || ""));
  let identity = resolvedPath;
  try {
    const stat = await fs.stat(resolvedPath);
    identity = `${resolvedPath}|${stat.size}|${Math.round(stat.mtimeMs)}`;
  } catch (_error) {
    // The transcriber will surface a useful file error later.
  }
  return crypto.createHash("sha256").update(identity).digest("hex").slice(0, 20);
}

function chooseAutoAsrProfile({
  language = "auto",
  totalMemoryGb = 0,
  cpuThreads = 1,
  nvidiaVramMb = 0
} = {}) {
  const isEnglish = ["en", "eng", "english"].includes(normalizeLanguage(language));
  const hasCuda = nvidiaVramMb >= 3072;
  if (hasCuda) {
    if (isEnglish && nvidiaVramMb >= 4096) {
      return {
        engine: "faster-whisper",
        model: "distil-large-v3",
        device: "cuda",
        computeType: "float16",
        reason: `GPU NVIDIA ${Math.round(nvidiaVramMb / 1024)} GB, nguồn tiếng Anh`
      };
    }
    if (!isEnglish && nvidiaVramMb >= 6144) {
      return {
        engine: "faster-whisper",
        model: "large-v3-turbo",
        device: "cuda",
        computeType: "float16",
        reason: `GPU NVIDIA ${Math.round(nvidiaVramMb / 1024)} GB, nguồn đa ngôn ngữ`
      };
    }
    return {
      engine: "faster-whisper",
      model: isEnglish ? "small.en" : "small",
      device: "cuda",
      computeType: "float16",
      reason: `GPU NVIDIA ${Math.round(nvidiaVramMb / 1024)} GB`
    };
  }
  const useSmall = totalMemoryGb >= 7 && cpuThreads >= 4;
  return {
    engine: "faster-whisper",
    model: isEnglish ? (useSmall ? "small.en" : "base.en") : (useSmall ? "small" : "base"),
    device: "cpu",
    computeType: "int8",
    reason: `CPU ${cpuThreads} luồng, RAM ${totalMemoryGb.toFixed(1)} GB`
  };
}

class SubtitleService {
  constructor(settings = {}) {
    this.settings = settings;
    this.whisperEngine = normalizeEngine(settings.whisperEngine || process.env.WHISPER_ENGINE || "auto");
    this.whisperCommand = settings.whisperCommand || process.env.WHISPER_COMMAND || "whisper";
    this.whisperPythonCommand = settings.whisperPythonCommand || process.env.WHISPER_PYTHON_COMMAND || "py";
    this.whisperModel = settings.whisperModel || process.env.WHISPER_MODEL || "auto";
    this.whisperDevice = settings.whisperDevice || process.env.WHISPER_DEVICE || "auto";
    this.whisperComputeType = settings.whisperComputeType || process.env.WHISPER_COMPUTE_TYPE || "auto";
    this.whisperChunkSec = Math.max(60, Math.min(300, safeNumber(settings.whisperChunkSec, 240)));
    this.whisperTimeoutMs = Math.min(
      MAX_WHISPER_TIMEOUT_MS,
      Math.max(
        30000,
        safeNumber(settings.whisperTimeoutMs || process.env.WHISPER_TIMEOUT_MS, MAX_WHISPER_TIMEOUT_MS)
      )
    );
  }

  async detectNvidiaVramMb() {
    try {
      const result = await runCommand(
        "nvidia-smi",
        ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
        5000
      );
      return Math.max(
        0,
        ...String(result.stdout || "").split(/\r?\n/).map((line) => safeNumber(line.trim(), 0))
      );
    } catch (_error) {
      return 0;
    }
  }

  async detectRuntime({ language = "auto", checkDependency = true } = {}) {
    const totalMemoryGb = os.totalmem() / (1024 ** 3);
    const cpuThreads = os.cpus()?.length || 1;
    const nvidiaVramMb = await this.detectNvidiaVramMb();
    const automatic = chooseAutoAsrProfile({ language, totalMemoryGb, cpuThreads, nvidiaVramMb });
    const engine = this.whisperEngine === "auto" ? automatic.engine : this.whisperEngine;
    const configuredModel = String(this.whisperModel || "auto");
    const fasterWhisperModel = configuredModel === "auto" || configuredModel.startsWith("nvidia/")
      ? automatic.model
      : configuredModel;
    const profile = {
      ...automatic,
      engine,
      model: fasterWhisperModel,
      device: this.whisperDevice === "auto" ? automatic.device : this.whisperDevice,
      computeType: this.whisperComputeType === "auto" ? automatic.computeType : this.whisperComputeType,
      totalMemoryGb: Number(totalMemoryGb.toFixed(1)),
      cpuThreads,
      nvidiaVramMb,
      fasterWhisperAvailable: null
    };
    if (engine === "faster-whisper" && checkDependency) {
      try {
        await runCommand(
          this.whisperPythonCommand,
          pythonArgs(this.whisperPythonCommand, ["-c", "import faster_whisper; print('ok')"]),
          12000
        );
        profile.fasterWhisperAvailable = true;
      } catch (_error) {
        profile.fasterWhisperAvailable = false;
      }
    }
    if (engine === "nvidia-parakeet" && checkDependency) {
      try {
        await runCommand(
          this.whisperPythonCommand,
          pythonArgs(this.whisperPythonCommand, ["-c", "import torch, soundfile, nemo.collections.asr; print('ok')"]),
          20000
        );
        profile.parakeetAvailable = true;
      } catch (_error) {
        profile.parakeetAvailable = false;
      }
      profile.model = configuredModel.startsWith("nvidia/")
        ? configuredModel
        : "nvidia/parakeet-tdt-0.6b-v3";
      profile.device = this.whisperDevice === "auto" ? (nvidiaVramMb ? "cuda" : "cpu") : this.whisperDevice;
      profile.computeType = "default";
      profile.reason = nvidiaVramMb
        ? `NVIDIA Parakeet thử nghiệm trên GPU ${Math.round(nvidiaVramMb / 1024)} GB`
        : "NVIDIA Parakeet đang chạy CPU; tốc độ có thể chậm";
    }
    return profile;
  }

  async transcribeWithParakeet({ audioPath, outputDir, cacheDir, profile }) {
    if (profile.parakeetAvailable === false) {
      throw new Error("Chưa cài NVIDIA NeMo ASR. Cài PyTorch phù hợp CUDA, sau đó chạy: py -3 -m pip install \"nemo_toolkit[asr]\" soundfile");
    }
    const outputPath = path.join(outputDir, `${path.parse(audioPath).name}.srt`);
    const scriptPath = this.settings.parakeetScript
      || path.join(__dirname, "..", "..", "tools", "parakeet_transcribe.py");
    const profileCacheName = `${profile.model}-${profile.device}`.replace(/[^a-z0-9._-]+/gi, "-");
    const chunkCacheDir = cacheDir
      ? path.join(cacheDir, profileCacheName)
      : path.join(outputDir, `.parakeet-${profileCacheName}`);
    await runCommand(
      this.whisperPythonCommand,
      pythonArgs(this.whisperPythonCommand, [
        scriptPath,
        "--audio", audioPath,
        "--output", outputPath,
        "--model", profile.model,
        "--device", profile.device,
        "--chunk-sec", String(this.whisperChunkSec),
        "--cache-dir", chunkCacheDir
      ]),
      this.whisperTimeoutMs
    );
    await fs.access(outputPath);
    return {
      provider: "nvidia_parakeet",
      subtitlePath: outputPath,
      profile,
      cacheDir: chunkCacheDir
    };
  }

  async transcribeWithFasterWhisper({
    audioPath,
    outputDir,
    narrationLanguage,
    cacheDir,
    profile
  }) {
    const outputPath = path.join(outputDir, `${path.parse(audioPath).name}.srt`);
    const scriptPath = this.settings.fasterWhisperScript
      || path.join(__dirname, "..", "..", "tools", "faster_whisper_transcribe.py");
    const profileCacheName = `${profile.model}-${profile.device}-${profile.computeType}`.replace(/[^a-z0-9._-]+/gi, "-");
    const audioCacheKey = await buildAudioCacheKey(audioPath);
    const chunkCacheDir = cacheDir
      ? path.join(cacheDir, profileCacheName, audioCacheKey)
      : path.join(outputDir, `.faster-whisper-${profileCacheName}`);
    const args = [
      scriptPath,
      "--audio", audioPath,
      "--output", outputPath,
      "--model", profile.model,
      "--language", normalizeLanguage(narrationLanguage),
      "--device", profile.device,
      "--compute-type", profile.computeType,
      "--batch-size", String(profile.device === "cuda"
        ? (Number(profile.nvidiaVramMb || 0) >= 6144 ? 16 : 8)
        : (Number(profile.totalMemoryGb || 0) >= 16 ? 4 : 2)),
      "--chunk-sec", String(this.whisperChunkSec),
      "--cache-dir", chunkCacheDir
    ];
    const result = await runCommand(
      this.whisperPythonCommand,
      pythonArgs(this.whisperPythonCommand, args),
      this.whisperTimeoutMs
    );
    await fs.access(outputPath);
    const lines = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
    let details = {};
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.event === "done") details = parsed;
      } catch (_error) {
        // Keep transcription output usable even when a dependency writes extra logs.
      }
    }
    return {
      provider: "faster_whisper",
      subtitlePath: outputPath,
      wordTimestampsPath: details.wordTimestampsPath || outputPath.replace(/\.srt$/i, ".words.json"),
      profile,
      details,
      cacheDir: chunkCacheDir
    };
  }

  async transcribeWithOpenAiWhisper({ audioPath, outputDir, narrationLanguage, model }) {
    const args = [
      audioPath,
      "--model",
      model === "auto" ? "small" : model,
      "--output_format",
      "srt",
      "--output_dir",
      outputDir
    ];
    if (narrationLanguage && narrationLanguage !== "auto") {
      args.push("--language", narrationLanguage);
    }
    await runCommand(this.whisperCommand, args, this.whisperTimeoutMs);
    const expectedPath = path.join(outputDir, `${path.parse(audioPath).name}.srt`);
    await fs.access(expectedPath);
    return {
      provider: "whisper_cli",
      subtitlePath: expectedPath,
      profile: {
        engine: "openai-whisper",
        model: model === "auto" ? "small" : model,
        device: "auto",
        computeType: "default"
      }
    };
  }

  async transcribeToSrt({ audioPath, outputDir, narrationLanguage = "auto", cacheDir = "" }) {
    await fs.mkdir(outputDir, { recursive: true });
    const profile = await this.detectRuntime({ language: narrationLanguage });
    if (profile.engine === "nvidia-parakeet") {
      return await this.transcribeWithParakeet({
        audioPath,
        outputDir,
        cacheDir,
        profile
      });
    }
    if (profile.engine !== "openai-whisper" && profile.fasterWhisperAvailable !== false) {
      try {
        return await this.transcribeWithFasterWhisper({
          audioPath,
          outputDir,
          narrationLanguage,
          cacheDir,
          profile
        });
      } catch (error) {
        if (/timed out/i.test(String(error?.message || ""))) throw error;
        if (this.whisperEngine !== "auto") throw error;
      }
    }
    const fallbackModel = ["tiny", "base", "small", "medium", "large", "turbo"].some(
      (name) => String(profile.model).startsWith(name)
    ) ? profile.model.replace(/\.en$/, "") : "small";
    const result = await this.transcribeWithOpenAiWhisper({
      audioPath,
      outputDir,
      narrationLanguage,
      model: fallbackModel
    });
    return {
      ...result,
      fallbackFrom: profile
    };
  }
}

module.exports = SubtitleService;
module.exports.MAX_WHISPER_TIMEOUT_MS = MAX_WHISPER_TIMEOUT_MS;
module.exports.chooseAutoAsrProfile = chooseAutoAsrProfile;
module.exports.normalizeEngine = normalizeEngine;
module.exports.buildAudioCacheKey = buildAudioCacheKey;
