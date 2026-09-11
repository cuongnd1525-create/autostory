const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_TIMEOUT_MS = 180000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_SCENE_DURATION_SEC = 45;

function runCommand(command, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    const child = spawn(command, args, { windowsHide: true });
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      const error = new Error(`${command} timed out while detecting scenes.`);
      error.code = "SCENE_DETECTION_TIMEOUT";
      error.timedOut = true;
      finish(() => reject(error));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => {
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();
      if (code !== 0) {
        const error = new Error(`${command} exited with code ${code}: ${stderr}`);
        error.code = code;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    }));
  });
}

function normalizeScenes(scenes, sourceDuration) {
  const duration = Math.max(0.35, Number(sourceDuration) || 0.35);
  const rawScenes = (Array.isArray(scenes) ? scenes : [])
    .map((scene) => {
      const startSec = Math.max(0, Math.min(duration, Number(scene.startSec || 0)));
      const rawEndSec = Number(scene.endSec);
      const endSec = Math.min(
        duration,
        Math.max(startSec, Number.isFinite(rawEndSec) ? rawEndSec : startSec + 1)
      );
      return { startSec, endSec, duration: Math.max(0.35, endSec - startSec) };
    })
    .filter((scene) => scene.endSec - scene.startSec > 0.001)
    .sort((left, right) => left.startSec - right.startSec);

  const merged = [];
  rawScenes.forEach((scene) => {
    const previous = merged[merged.length - 1];
    const actualDuration = scene.endSec - scene.startSec;
    const isContiguous = previous && scene.startSec <= previous.endSec + 0.01;
    const previousDuration = previous ? previous.endSec - previous.startSec : 0;
    if (isContiguous && (actualDuration < 0.35 || previousDuration < 0.35)) {
      previous.endSec = Math.max(previous.endSec, scene.endSec);
      return;
    }
    merged.push({ startSec: scene.startSec, endSec: scene.endSec });
  });

  return merged
    .filter((scene) => scene.endSec - scene.startSec >= 0.35)
    .map((scene, index) => ({
      sceneId: `scene_${String(index + 1).padStart(4, "0")}`,
      startSec: Number(scene.startSec.toFixed(3)),
      endSec: Number(scene.endSec.toFixed(3)),
      duration: Number((scene.endSec - scene.startSec).toFixed(3))
    }));
}

function buildFixedWindowScenes(sourceDuration, maxSceneDurationSec = DEFAULT_MAX_SCENE_DURATION_SEC) {
  const duration = Math.max(0.35, Number(sourceDuration) || 0.35);
  const windowSec = Math.max(10, Number(maxSceneDurationSec) || DEFAULT_MAX_SCENE_DURATION_SEC);
  const scenes = [];
  let cursor = 0;
  while (cursor < duration - 0.001) {
    const endSec = Math.min(duration, cursor + windowSec);
    scenes.push({ startSec: cursor, endSec });
    cursor = endSec;
  }
  return normalizeScenes(scenes, duration);
}

function splitLongScenes(scenes, sourceDuration, maxSceneDurationSec = DEFAULT_MAX_SCENE_DURATION_SEC) {
  const duration = Math.max(0.35, Number(sourceDuration) || 0.35);
  const maxSec = Math.max(10, Number(maxSceneDurationSec) || DEFAULT_MAX_SCENE_DURATION_SEC);
  const normalized = normalizeScenes(scenes, duration);
  const split = [];
  let changed = false;

  normalized.forEach((scene) => {
    if (scene.duration <= maxSec + 0.001) {
      split.push(scene);
      return;
    }
    changed = true;
    let cursor = scene.startSec;
    while (cursor < scene.endSec - 0.001) {
      const endSec = Math.min(scene.endSec, cursor + maxSec);
      split.push({ startSec: cursor, endSec });
      cursor = endSec;
    }
  });

  return {
    changed,
    scenes: normalizeScenes(split, duration)
  };
}

function resolveTimeoutMs(sourceDuration, configuredTimeoutMs) {
  const configured = Number(configuredTimeoutMs);
  if (Number.isFinite(configured) && configured >= 30000) {
    return Math.min(MAX_TIMEOUT_MS, configured);
  }
  const durationScaled = Math.round(Math.max(0, Number(sourceDuration) || 0) * 500);
  return Math.min(MAX_TIMEOUT_MS, Math.max(DEFAULT_TIMEOUT_MS, durationScaled));
}

function parseFfmpegSceneBoundaries(output, sourceDuration) {
  const boundaries = [];
  const pattern = /pts_time:([-0-9.]+)/g;
  let match;
  while ((match = pattern.exec(String(output || "")))) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0 && value < sourceDuration) {
      boundaries.push(value);
    }
  }
  const points = [0, ...new Set(boundaries.map((value) => Number(value.toFixed(3))))].sort((a, b) => a - b);
  if (points[points.length - 1] < sourceDuration) points.push(sourceDuration);
  return normalizeScenes(points.slice(0, -1).map((startSec, index) => ({
    startSec,
    endSec: points[index + 1]
  })), sourceDuration);
}

class SceneDetectionService {
  constructor(settings = {}) {
    this.pythonPath = settings.pythonPath || process.env.PYTHON || "python";
    this.ffmpegPath = settings.ffmpegPath || "ffmpeg";
    this.timeoutMs = settings.sceneDetectionTimeoutMs;
    this.ffmpegThreshold = Math.max(0.05, Math.min(0.95, Number(settings.sceneDetectionThreshold || 0.32)));
    this.maxSceneDurationSec = Math.max(10, Number(settings.sceneDetectionMaxSceneDurationSec || DEFAULT_MAX_SCENE_DURATION_SEC));
  }

  async detectWithPython({ videoPath, sourceDuration, timeoutMs }) {
    const scriptPath = path.join(__dirname, "..", "..", "tools", "scene_detect.py");
    const args = [
      scriptPath,
      "--video",
      videoPath,
      "--duration",
      String(sourceDuration),
      "--ffmpeg",
      this.ffmpegPath
    ];
    const commands = [{ command: this.pythonPath, args }];
    if (String(this.pythonPath).toLowerCase() !== "py") {
      commands.push({ command: "py", args: ["-3", ...args] });
    }

    let lastError;
    for (const candidate of commands) {
      try {
        const { stdout } = await runCommand(candidate.command, candidate.args, timeoutMs);
        const parsed = JSON.parse(stdout.trim() || "{}");
        if (Array.isArray(parsed.scenes) && parsed.scenes.length) {
          return {
            provider: parsed.provider || "pyscenedetect",
            error: parsed.error || "",
            scenes: normalizeScenes(parsed.scenes, sourceDuration)
          };
        }
        lastError = new Error(parsed.error || `${candidate.command} did not return scene boundaries.`);
      } catch (error) {
        lastError = error;
        // A timeout means the detector is too expensive. Repeating it through another
        // Python launcher only doubles the wait, so move directly to FFmpeg.
        if (error?.timedOut) break;
      }
    }
    throw lastError || new Error("Python scene detection failed.");
  }

  async detectWithFfmpeg({ videoPath, sourceDuration, timeoutMs }) {
    const { stderr } = await runCommand(this.ffmpegPath, [
      "-hide_banner",
      "-i",
      videoPath,
      "-vf",
      `select=gt(scene\\,${this.ffmpegThreshold}),showinfo`,
      "-an",
      "-f",
      "null",
      "-"
    ], timeoutMs);
    const scenes = parseFfmpegSceneBoundaries(stderr, sourceDuration);
    if (!scenes.length) throw new Error("FFmpeg did not return scene boundaries.");
    return { provider: "ffmpeg_scene_fallback", scenes };
  }

  async detectScenes({ videoPath, sourceDuration }) {
    const timeoutMs = resolveTimeoutMs(sourceDuration, this.timeoutMs);
    const warnings = [];
    let result;

    try {
      // FFmpeg's native scene score is dramatically faster on the lightweight
      // proxy and avoids loading every frame through Python on low-end machines.
      result = await this.detectWithFfmpeg({ videoPath, sourceDuration, timeoutMs });
    } catch (error) {
      warnings.push(`FFmpeg scene detector không hoàn tất: ${error.message}`);
      try {
        result = await this.detectWithPython({ videoPath, sourceDuration, timeoutMs });
      } catch (fallbackError) {
        warnings.push(`PySceneDetect không hoàn tất: ${fallbackError.message}`);
        result = {
          provider: "fixed_window_fallback",
          scenes: buildFixedWindowScenes(sourceDuration, this.maxSceneDurationSec)
        };
      }
    }

    const bounded = splitLongScenes(result.scenes, sourceDuration, this.maxSceneDurationSec);
    if (bounded.changed) {
      warnings.push(`Đã chia các cảnh liên tục dài hơn ${this.maxSceneDurationSec}s để Gemini có mốc nguồn chính xác.`);
    }
    return {
      provider: bounded.changed ? `${result.provider}+max_window` : result.provider,
      error: warnings.join(" | "),
      warnings,
      timeoutMs,
      scenes: bounded.scenes.length
        ? bounded.scenes
        : buildFixedWindowScenes(sourceDuration, this.maxSceneDurationSec)
    };
  }
}

module.exports = SceneDetectionService;
module.exports.buildFixedWindowScenes = buildFixedWindowScenes;
module.exports.splitLongScenes = splitLongScenes;
module.exports.resolveTimeoutMs = resolveTimeoutMs;
module.exports.parseFfmpegSceneBoundaries = parseFfmpegSceneBoundaries;
