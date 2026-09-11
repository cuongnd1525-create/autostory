const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { buildCliEnv } = require("./cliEnv");
const { getCancelToken, throwIfCancelled, trackChild } = require("./cancelToken");

const DEFAULT_MODEL = "hexgrad/Kokoro-82M";
const DEFAULT_VOICE = "af_heart";
const persistentWorkers = new Map();

const US_ENGLISH_VOICES = [
  ["af_heart", "Heart - nữ, tự nhiên"],
  ["af_bella", "Bella - nữ, ấm"],
  ["af_nicole", "Nicole - nữ, kể chuyện"],
  ["af_sarah", "Sarah - nữ, rõ ràng"],
  ["af_sky", "Sky - nữ, trẻ"],
  ["af_alloy", "Alloy - nữ, cân bằng"],
  ["af_aoede", "Aoede - nữ, biểu cảm"],
  ["af_jessica", "Jessica - nữ, hiện đại"],
  ["af_kore", "Kore - nữ, chắc"],
  ["af_nova", "Nova - nữ, sáng"],
  ["af_river", "River - nữ, trầm"],
  ["am_adam", "Adam - nam, trầm"],
  ["am_michael", "Michael - nam, tự nhiên"],
  ["am_liam", "Liam - nam, trẻ"],
  ["am_onyx", "Onyx - nam, chắc"],
  ["am_echo", "Echo - nam, rõ"],
  ["am_eric", "Eric - nam, cân bằng"],
  ["am_fenrir", "Fenrir - nam, mạnh"],
  ["am_puck", "Puck - nam, năng lượng"]
];

function fileExists(filePath) {
  try {
    return Boolean(filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile());
  } catch (_error) {
    return false;
  }
}

function normalizeLanguage(language) {
  const value = String(language || "").trim().toLowerCase();
  if (!value || value === "auto" || value === "en" || value.startsWith("en-us")) return "a";
  if (value.startsWith("en-gb")) return "b";
  const map = { es: "e", fr: "f", hi: "h", it: "i", ja: "j", pt: "p", zh: "z" };
  const code = Object.keys(map).find((key) => value === key || value.startsWith(`${key}-`));
  if (code) return map[code];
  throw new Error(`Kokoro chưa hỗ trợ ngôn ngữ "${language}" trong tool. Hãy dùng tiếng Anh hoặc chọn provider khác.`);
}

class KokoroWorkerClient {
  constructor({ pythonCommand, scriptPath, model, device, env, idleTimeoutMs }) {
    Object.assign(this, { pythonCommand, scriptPath, model, device, env });
    this.idleTimeoutMs = Math.max(60000, Number(idleTimeoutMs || 15 * 60 * 1000));
    this.child = null;
    this.startPromise = null;
    this.readyWaiter = null;
    this.readyInfo = null;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.queue = [];
    this.current = null;
    this.idleTimer = null;
  }

  ensureStarted(onProgress, timeoutMs) {
    if (this.child && this.readyInfo) return Promise.resolve(this.readyInfo);
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
      const untrack = trackChild(child, getCancelToken());
      const timer = setTimeout(() => this.stop("Kokoro worker timed out while starting."), Math.max(60000, Number(timeoutMs || 10 * 60 * 1000)));
      this.readyWaiter = {
        resolve: (value) => {
          clearTimeout(timer);
          untrack();
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          untrack();
          reject(error);
        }
      };
      onProgress?.("Kokoro đang nạp model lần đầu; các cảnh tiếp theo sẽ dùng lại model này.");
      child.stdout.on("data", (chunk) => this.handleStdout(chunk));
      child.stderr.on("data", (chunk) => {
        this.stderrBuffer = `${this.stderrBuffer}${chunk.toString("utf8")}`.slice(-12000);
      });
      child.on("error", (error) => this.handleExit(error));
      child.on("close", (code) => this.handleExit(new Error(`Kokoro worker exited with code ${code}. ${this.stderrBuffer.slice(-1800)}`)));
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
        const error = new Error(payload.error || "Kokoro worker request failed.");
        error.code = "KOKORO_REQUEST_FAILED";
        current.reject(error);
      }
      this.pump();
    });
  }

  handleExit(error) {
    const child = this.child;
    this.child = null;
    this.readyInfo = null;
    if (this.readyWaiter) {
      this.readyWaiter.reject(error);
      this.readyWaiter = null;
    }
    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.untrack?.();
      this.current.reject(error);
      this.current = null;
    }
    this.queue.splice(0).forEach((item) => item.reject(error));
    child?.removeAllListeners();
  }

  enqueue(payload, { onProgress, timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        id: crypto.randomUUID(),
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
      next.onProgress?.(`Kokoro sẵn sàng trên ${ready.device}; đang tạo voice.`);
      const untrack = trackChild(this.child, getCancelToken());
      const timer = setTimeout(() => this.stop(`Kokoro request ${next.id} timed out.`), next.timeoutMs);
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
    if (!this.child) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ type: "shutdown", reason })}\n`, "utf8");
    } catch (_error) {}
    const child = this.child;
    const timer = setTimeout(() => child.kill(), 1500);
    timer.unref?.();
  }
}

function getPersistentWorker(settings, model, device) {
  const pythonCommand = settings.kokoroPythonCommand || process.env.KOKORO_PYTHON_COMMAND || "python";
  const scriptPath = settings.kokoroWorkerScript || path.join(__dirname, "..", "..", "tools", "kokoro_worker.py");
  const key = [pythonCommand, path.resolve(scriptPath), model, device || "auto"].join("|");
  if (!persistentWorkers.has(key)) {
    persistentWorkers.forEach((worker, existingKey) => {
      if (existingKey !== key) worker.stop("worker_configuration_changed");
    });
    persistentWorkers.clear();
    persistentWorkers.set(key, new KokoroWorkerClient({
      pythonCommand,
      scriptPath,
      model,
      device,
      env: {
        ...buildCliEnv(),
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONLEGACYWINDOWSSTDIO: "0"
      },
      idleTimeoutMs: settings.kokoroWorkerIdleTimeoutMs
    }));
  }
  return persistentWorkers.get(key);
}

class KokoroVoiceService {
  constructor(settings = {}) {
    this.settings = settings;
    this.model = settings.kokoroModel || process.env.KOKORO_MODEL || DEFAULT_MODEL;
    this.device = settings.kokoroDevice || process.env.KOKORO_DEVICE || "";
    this.speed = Math.max(0.5, Math.min(2, Number(settings.kokoroSpeed || 1)));
  }

  listVoices() {
    return US_ENGLISH_VOICES.map(([voice_id, name]) => ({
      voice_id,
      name,
      provider: "kokoro",
      labels: { locale: "en-US", model: this.model }
    }));
  }

  async synthesizeSpeech({ text, voiceName, outputPath, language = "en", speed, timeoutMs, onProgress }) {
    if (!String(text || "").trim()) throw new Error("Kokoro text is empty.");
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.rm(outputPath, { force: true }).catch(() => {});
    const worker = getPersistentWorker(this.settings, this.model, this.device);
    try {
      await worker.enqueue({
        text: String(text),
        voice: String(voiceName || DEFAULT_VOICE),
        outputPath,
        langCode: normalizeLanguage(language),
        speed: Math.max(0.5, Math.min(2, Number(speed || this.speed)))
      }, { onProgress, timeoutMs });
    } catch (error) {
      throwIfCancelled();
      if (/No module named ['"]?kokoro|cannot find module 'kokoro'/i.test(error.message)) {
        throw new Error("Chưa cài Kokoro. Chạy `python -m pip install kokoro>=0.9.4 soundfile`, sau đó thử lại.");
      }
      throw error;
    }
    if (!fileExists(outputPath) || fs.statSync(outputPath).size < 512) {
      throw new Error("Kokoro returned an empty audio file.");
    }
    return outputPath;
  }
}

module.exports = KokoroVoiceService;
module.exports.normalizeLanguage = normalizeLanguage;
module.exports.shutdownPersistentWorkers = () => {
  persistentWorkers.forEach((worker) => worker.stop("app_shutdown"));
  persistentWorkers.clear();
};
