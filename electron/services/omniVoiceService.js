const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { buildCliEnv } = require("./cliEnv");
const { getCancelToken, throwIfCancelled, trackChild } = require("./cancelToken");

const DEFAULT_MODEL = "k2-fsa/OmniVoice";
const VALID_ENGLISH_INSTRUCTS = new Set([
  "american accent",
  "australian accent",
  "british accent",
  "canadian accent",
  "child",
  "chinese accent",
  "elderly",
  "female",
  "high pitch",
  "indian accent",
  "japanese accent",
  "korean accent",
  "low pitch",
  "male",
  "middle-aged",
  "moderate pitch",
  "portuguese accent",
  "russian accent",
  "teenager",
  "very high pitch",
  "very low pitch",
  "whisper",
  "young adult"
]);
const VALID_CHINESE_INSTRUCTS = new Set([
  "东北话",
  "中年",
  "中音调",
  "云南话",
  "低音调",
  "儿童",
  "四川话",
  "女",
  "宁夏话",
  "少年",
  "极低音调",
  "极高音调",
  "桂林话",
  "河南话",
  "济南话",
  "甘肃话",
  "男",
  "石家庄话",
  "老年",
  "耳语",
  "贵州话",
  "陕西话",
  "青岛话",
  "青年",
  "高音调"
]);
const ENGLISH_INSTRUCT_ALIASES = new Map([
  ["adult", "middle-aged"],
  ["middle aged", "middle-aged"],
  ["medium pitch", "moderate pitch"],
  ["normal pitch", "moderate pitch"],
  ["medium-low pitch", "low pitch"],
  ["medium low pitch", "low pitch"],
  ["medium-high pitch", "high pitch"],
  ["medium high pitch", "high pitch"],
  ["young", "young adult"]
]);
const persistentWorkers = new Map();

function fileExists(filePath) {
  try {
    return Boolean(filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile());
  } catch (_error) {
    return false;
  }
}

function normalizeLanguage(language) {
  const value = String(language || "").trim().toLowerCase();
  if (!value || value === "auto") {
    return "";
  }
  if (value.startsWith("vi")) {
    return "vi";
  }
  if (value.startsWith("en")) {
    return "en";
  }
  return value;
}

function normalizeOmniVoiceInstruct(value) {
  const raw = String(value || "").trim();
  if (!raw || fileExists(raw)) {
    return { instruct: raw, removed: [], translated: [] };
  }

  const containsChinese = /[\u3400-\u9fff]/.test(raw);
  const parts = raw
    .split(containsChinese ? /[，,]/ : /,/)
    .map((item) => item.trim())
    .filter(Boolean);
  const validSet = containsChinese ? VALID_CHINESE_INSTRUCTS : VALID_ENGLISH_INSTRUCTS;
  const kept = [];
  const removed = [];
  const translated = [];

  parts.forEach((part) => {
    const normalized = containsChinese ? part : part.toLowerCase().replace(/\s+/g, " ");
    const mapped = containsChinese ? normalized : (ENGLISH_INSTRUCT_ALIASES.get(normalized) || normalized);
    if (validSet.has(mapped)) {
      if (!kept.includes(mapped)) kept.push(mapped);
      if (mapped !== normalized) translated.push(`${part} -> ${mapped}`);
    } else {
      removed.push(part);
    }
  });

  return {
    instruct: kept.join(containsChinese ? "，" : ", "),
    removed,
    translated
  };
}

function resolveExecutable(command, env) {
  const value = String(command || "").trim();
  if (!value) return "";
  if (path.isAbsolute(value) && fileExists(value)) return value;
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [value], {
    windowsHide: true,
    env,
    encoding: "utf8"
  });
  if (result.status !== 0) return value;
  return String(result.stdout || "").split(/\r?\n/).map((item) => item.trim()).find(Boolean) || value;
}

function resolveOmniVoicePython(settings, env) {
  const explicit = settings.omniVoicePythonCommand || process.env.OMNIVOICE_PYTHON_COMMAND || "";
  if (explicit) return explicit;
  const resolvedCli = resolveExecutable(
    settings.omniVoiceCommand || process.env.OMNIVOICE_COMMAND || "omnivoice-infer",
    env
  );
  if (process.platform === "win32" && /[\\/]Scripts[\\/][^\\/]+\.exe$/i.test(resolvedCli)) {
    const siblingPython = path.resolve(path.dirname(resolvedCli), "..", "python.exe");
    if (fileExists(siblingPython)) return siblingPython;
  }
  return "python";
}

class OmniVoiceWorkerClient {
  constructor({ pythonCommand, scriptPath, model, device, env, idleTimeoutMs }) {
    this.pythonCommand = pythonCommand;
    this.scriptPath = scriptPath;
    this.model = model;
    this.device = device;
    this.env = env;
    this.idleTimeoutMs = Math.max(60000, Number(idleTimeoutMs || 15 * 60 * 1000));
    this.child = null;
    this.startPromise = null;
    this.readyInfo = null;
    this.readyWaiter = null;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.queue = [];
    this.current = null;
    this.idleTimer = null;
    this.lastProgressAt = 0;
  }

  async ensureStarted(onProgress, timeoutMs) {
    if (this.child && this.readyInfo) return this.readyInfo;
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise((resolve, reject) => {
      const args = [this.scriptPath, "--model", this.model];
      if (this.device) args.push("--device", this.device);
      const child = spawn(this.pythonCommand, args, {
        windowsHide: true,
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.child = child;
      this.readyWaiter = { resolve, reject };
      const token = getCancelToken();
      const untrackStartup = trackChild(child, token);
      const startupTimer = setTimeout(() => {
        untrackStartup();
        this.stop("OmniVoice worker timed out while loading the model.");
      }, Math.max(60000, Number(timeoutMs || 10 * 60 * 1000)));

      const finishStartup = () => {
        clearTimeout(startupTimer);
        untrackStartup();
      };
      this.readyWaiter.finish = finishStartup;
      onProgress?.("OmniVoice worker đang nạp model một lần để dùng cho toàn bộ phiên làm việc.");

      child.stdout.on("data", (chunk) => this.handleStdout(chunk));
      child.stderr.on("data", (chunk) => this.handleStderr(chunk, onProgress));
      child.on("error", (error) => this.handleExit(error));
      child.on("close", (code) => {
        this.handleExit(new Error(`OmniVoice worker exited with code ${code}. ${this.stderrBuffer.slice(-1500)}`));
      });
    }).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk.toString("utf8");
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || "";
    lines.filter(Boolean).forEach((line) => {
      let payload;
      try {
        payload = JSON.parse(line);
      } catch (_error) {
        return;
      }
      if (payload.type === "ready" && this.readyWaiter) {
        this.readyInfo = payload;
        this.readyWaiter.finish?.();
        this.readyWaiter.resolve(payload);
        this.readyWaiter = null;
        return;
      }
      if (!this.current || payload.id !== this.current.id) return;
      const current = this.current;
      this.current = null;
      clearTimeout(current.timer);
      current.untrack?.();
      if (payload.ok) {
        current.resolve(payload);
      } else {
        const error = new Error(payload.error || "OmniVoice worker request failed.");
        error.code = "OMNIVOICE_REQUEST_FAILED";
        current.reject(error);
      }
      this.pump();
    });
  }

  handleStderr(chunk, startupProgress) {
    const text = chunk.toString("utf8");
    this.stderrBuffer = `${this.stderrBuffer}${text}`.slice(-12000);
    const now = Date.now();
    if (now - this.lastProgressAt < 3000) return;
    const message = text.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || "";
    if (!message) return;
    this.lastProgressAt = now;
    (this.current?.onProgress || startupProgress)?.(message);
  }

  handleExit(error) {
    const child = this.child;
    this.child = null;
    this.readyInfo = null;
    if (this.readyWaiter) {
      this.readyWaiter.finish?.();
      this.readyWaiter.reject(error);
      this.readyWaiter = null;
    }
    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.untrack?.();
      this.current.reject(error);
      this.current = null;
    }
    const queued = this.queue.splice(0);
    queued.forEach((item) => item.reject(error));
    if (child) {
      child.removeAllListeners();
    }
  }

  enqueue(payload, { onProgress, timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        id: payload.id || crypto.randomUUID(),
        payload,
        onProgress,
        timeoutMs: Math.max(60000, Number(timeoutMs || 10 * 60 * 1000)),
        resolve,
        reject
      });
      this.pump();
    });
  }

  async pump() {
    if (this.current || !this.queue.length) {
      if (!this.current && !this.queue.length) this.scheduleIdleStop();
      return;
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const next = this.queue.shift();
    try {
      const ready = await this.ensureStarted(next.onProgress, next.timeoutMs);
      throwIfCancelled();
      next.onProgress?.(`OmniVoice worker sẵn sàng trên ${ready.device}; model sẽ được tái sử dụng cho các đoạn tiếp theo.`);
      const token = getCancelToken();
      const untrack = trackChild(this.child, token);
      const timer = setTimeout(() => {
        this.stop(`OmniVoice worker request ${next.id} timed out.`);
      }, next.timeoutMs);
      this.current = { ...next, timer, untrack };
      this.child.stdin.write(`${JSON.stringify({ ...next.payload, id: next.id })}\n`, "utf8");
    } catch (error) {
      next.reject(error);
      this.pump();
    }
  }

  scheduleIdleStop() {
    if (!this.child || this.idleTimer) return;
    this.idleTimer = setTimeout(() => this.stop("idle"), this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  stop(reason = "shutdown") {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.write(`${JSON.stringify({ type: "shutdown", reason })}\n`, "utf8");
    } catch (_error) {}
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (_error) {
        child.kill();
      }
    }, 1500);
    killTimer.unref?.();
  }
}

function getPersistentWorker(settings, model, device) {
  const env = {
    ...buildCliEnv(),
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONLEGACYWINDOWSSTDIO: "0"
  };
  const pythonCommand = resolveOmniVoicePython(settings, env);
  const scriptPath = settings.omniVoiceWorkerScript
    || path.join(__dirname, "..", "..", "tools", "omnivoice_worker.py");
  const key = [path.resolve(String(pythonCommand)), path.resolve(scriptPath), model, device || "auto"].join("|");
  if (!persistentWorkers.has(key)) {
    persistentWorkers.forEach((worker, existingKey) => {
      if (existingKey === key) return;
      worker.stop("worker_configuration_changed");
      persistentWorkers.delete(existingKey);
    });
    persistentWorkers.set(key, new OmniVoiceWorkerClient({
      pythonCommand,
      scriptPath,
      model,
      device,
      env,
      idleTimeoutMs: settings.omniVoiceWorkerIdleTimeoutMs
    }));
  }
  return persistentWorkers.get(key);
}

class OmniVoiceService {
  constructor(settings = {}) {
    this.settings = settings;
    this.command = settings.omniVoiceCommand || process.env.OMNIVOICE_COMMAND || "omnivoice-infer";
    this.model = settings.omniVoiceModel || process.env.OMNIVOICE_MODEL || DEFAULT_MODEL;
    this.device = settings.omniVoiceDevice || process.env.OMNIVOICE_DEVICE || "";
    this.defaultInstruct = settings.omniVoiceInstruct || process.env.OMNIVOICE_INSTRUCT || "";
    this.defaultRefText = settings.omniVoiceRefText || process.env.OMNIVOICE_REF_TEXT || "";
  }

  buildWorkerPayload({ text, voiceName, outputPath, language, durationSec, numStep }) {
    const selectedVoice = String(voiceName || "").trim();
    const payload = {
      text: String(text || ""),
      outputPath,
      language: normalizeLanguage(language) || null,
      durationSec: Number.isFinite(Number(durationSec)) && Number(durationSec) > 0 ? Number(durationSec) : null,
      numStep: Number.isInteger(Number(numStep)) && Number(numStep) > 0 ? Number(numStep) : 8
    };
    if (fileExists(selectedVoice)) {
      payload.refAudio = path.resolve(selectedVoice);
      payload.refText = this.defaultRefText || null;
    } else {
      payload.instruct = normalizeOmniVoiceInstruct(selectedVoice || this.defaultInstruct).instruct || null;
    }
    return payload;
  }

  listVoices() {
    const voices = [
      {
        voice_id: "",
        name: "OmniVoice Auto Voice",
        provider: "omnivoice",
        labels: { mode: "auto" }
      },
      {
        voice_id: "male, young adult, low pitch, american accent",
        name: "Cinematic Male TikTok",
        provider: "omnivoice",
        labels: { mode: "voice design" }
      },
      {
        voice_id: "female, young adult, high pitch, american accent",
        name: "Urgent Female Storyteller",
        provider: "omnivoice",
        labels: { mode: "voice design" }
      },
      {
        voice_id: "male, middle-aged, low pitch",
        name: "Vietnamese Recap Narrator",
        provider: "omnivoice",
        labels: { mode: "voice design" }
      }
    ];

    if (this.defaultInstruct) {
      const configured = normalizeOmniVoiceInstruct(this.defaultInstruct);
      if (configured.instruct) {
        voices.splice(1, 0, {
          voice_id: configured.instruct,
          name: "Configured OmniVoice Design",
          provider: "omnivoice",
          labels: {
            mode: "voice design",
            warning: configured.removed.length ? `Đã bỏ thuộc tính không hỗ trợ: ${configured.removed.join(", ")}` : ""
          }
        });
      }
    }

    return voices;
  }

  buildArgs({ text, voiceName, outputPath, language, durationSec, numStep }) {
    const args = [
      "--model", this.model,
      "--text", String(text || ""),
      "--output", outputPath
    ];

    const languageId = normalizeLanguage(language);
    if (languageId) {
      args.push("--language", languageId);
    }

    const targetDuration = Number(durationSec);
    if (Number.isFinite(targetDuration) && targetDuration > 0) {
      args.push("--duration", targetDuration.toFixed(2));
    }

    const steps = Number(numStep);
    if (Number.isInteger(steps) && steps > 0) {
      args.push("--num_step", String(steps));
    }

    if (this.device) {
      args.push("--device", this.device);
    }

    const selectedVoice = String(voiceName || "").trim();
    if (fileExists(selectedVoice)) {
      args.push("--ref_audio", path.resolve(selectedVoice));
      if (this.defaultRefText) {
        args.push("--ref_text", this.defaultRefText);
      }
    } else {
      const normalized = normalizeOmniVoiceInstruct(selectedVoice || this.defaultInstruct);
      if (normalized.instruct) {
        args.push("--instruct", normalized.instruct);
      }
    }

    return args;
  }

  run(args, onProgress, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      const token = getCancelToken();
      try {
        throwIfCancelled(token);
      } catch (error) {
        reject(error);
        return;
      }
      const child = spawn(this.command, args, {
        windowsHide: true,
        env: {
          ...buildCliEnv(),
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
          PYTHONLEGACYWINDOWSSTDIO: "0"
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      const untrackChild = trackChild(child, token);

      let stdout = "";
      let stderr = "";
      let lastProgressAt = 0;
      let timedOut = false;
      let timeout = null;
      const notifyProgress = (chunk) => {
        if (typeof onProgress !== "function") {
          return;
        }
        const now = Date.now();
        const message = String(chunk || "").trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || "";
        if (!message || now - lastProgressAt < 3000) {
          return;
        }
        lastProgressAt = now;
        Promise.resolve(onProgress(message)).catch(() => {});
      };

      if (Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0) {
        timeout = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, Number(timeoutMs));
      }

      const clearRunTimeout = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
      };

      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        stdout += text;
        notifyProgress(text);
      });

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderr += text;
        notifyProgress(text);
      });

      child.on("error", (error) => {
        untrackChild();
        clearRunTimeout();
        if (error.code === "ENOENT") {
          reject(new Error(
            "OmniVoice command was not found. Install it with `pip install omnivoice`, then set OmniVoice command in Settings if it is not on PATH."
          ));
          return;
        }
        reject(error);
      });

      child.on("close", (code) => {
        untrackChild();
        clearRunTimeout();
        if (token?.cancelled) {
          reject(new Error(token.reason || "Đã dừng xuất video."));
          return;
        }
        if (timedOut) {
          reject(new Error(
            "OmniVoice Test Voice timed out. First run may need to download/load the model; if this keeps happening, set OmniVoice device to cuda/cuda:0 or test `omnivoice-infer` in PowerShell first."
          ));
          return;
        }
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new Error(stderr.trim() || stdout.trim() || `OmniVoice failed with code ${code}`));
      });
    });
  }

  async synthesizeSpeech({ text, voiceName, outputPath, language = "auto", durationSec, numStep, timeoutMs, onProgress }) {
    if (!String(text || "").trim()) {
      throw new Error("OmniVoice text is empty.");
    }

    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    if (!fileExists(String(voiceName || "").trim())) {
      const normalized = normalizeOmniVoiceInstruct(voiceName || this.defaultInstruct);
      if (normalized.translated.length && typeof onProgress === "function") {
        onProgress(`OmniVoice đã chuẩn hóa thuộc tính: ${normalized.translated.join(", ")}.`);
      }
      if (normalized.removed.length && typeof onProgress === "function") {
        onProgress(`OmniVoice đã bỏ thuộc tính không hỗ trợ: ${normalized.removed.join(", ")}.`);
      }
    }
    await fs.promises.rm(outputPath, { force: true }).catch(() => {});
    const usePersistentWorker = this.settings.omniVoicePersistentWorker !== false;
    if (usePersistentWorker) {
      try {
        const worker = getPersistentWorker(this.settings, this.model, this.device);
        await worker.enqueue(
          this.buildWorkerPayload({ text, voiceName, outputPath, language, durationSec, numStep }),
          { onProgress, timeoutMs }
        );
      } catch (error) {
        throwIfCancelled();
        if (error.code === "OMNIVOICE_REQUEST_FAILED") {
          throw error;
        }
        if (!fileExists(outputPath) || fs.statSync(outputPath).size === 0) {
          onProgress?.(`OmniVoice worker lỗi (${error.message}). Đang fallback sang CLI một lần.`);
          const args = this.buildArgs({ text, voiceName, outputPath, language, durationSec, numStep });
          await this.run(args, onProgress, timeoutMs);
        }
      }
    } else {
      const args = this.buildArgs({ text, voiceName, outputPath, language, durationSec, numStep });
      onProgress?.("OmniVoice local inference is starting.");
      await this.run(args, onProgress, timeoutMs);
    }

    if (!fileExists(outputPath) || fs.statSync(outputPath).size === 0) {
      throw new Error("OmniVoice returned an empty audio file.");
    }

    return outputPath;
  }
}

module.exports = OmniVoiceService;
module.exports.normalizeOmniVoiceInstruct = normalizeOmniVoiceInstruct;
module.exports.shutdownPersistentWorkers = () => {
  persistentWorkers.forEach((worker) => worker.stop("app_shutdown"));
  persistentWorkers.clear();
};
