const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { buildCliEnv } = require("./cliEnv");
const { getCancelToken, throwIfCancelled, trackChild } = require("./cancelToken");
const HyMtTranslationService = require("./hyMtTranslationService");

const DEFAULT_MODEL = "Helsinki-NLP/opus-mt-en-vi";
const workers = new Map();

class TranslationWorker {
  constructor({ pythonCommand, scriptPath, model, device, idleTimeoutMs }) {
    Object.assign(this, { pythonCommand, scriptPath, model, device });
    this.idleTimeoutMs = Math.max(60000, Number(idleTimeoutMs || 15 * 60 * 1000));
    this.child = null;
    this.ready = null;
    this.startPromise = null;
    this.readyWaiter = null;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.current = null;
    this.queue = [];
    this.idleTimer = null;
  }

  ensureStarted(onProgress, timeoutMs) {
    if (this.child && this.ready) return Promise.resolve(this.ready);
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      const args = [this.scriptPath, "--model", this.model];
      if (this.device) args.push("--device", this.device);
      const child = spawn(this.pythonCommand, args, {
        windowsHide: true,
        env: {
          ...buildCliEnv(),
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
          PYTHONLEGACYWINDOWSSTDIO: "0"
        },
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.child = child;
      const untrack = trackChild(child, getCancelToken());
      const timer = setTimeout(() => this.stop("Local translation worker startup timed out."), Math.max(60000, Number(timeoutMs || 10 * 60 * 1000)));
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
      onProgress?.("Đang nạp model dịch local Anh-Vi lần đầu.");
      child.stdout.on("data", (chunk) => this.handleStdout(chunk));
      child.stderr.on("data", (chunk) => {
        this.stderrBuffer = `${this.stderrBuffer}${chunk.toString("utf8")}`.slice(-16000);
      });
      child.on("error", (error) => this.handleExit(error));
      child.on("close", (code) => this.handleExit(new Error(`Local translation worker exited with code ${code}. ${this.stderrBuffer.slice(-2400)}`)));
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
        this.ready = payload;
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
        current.reject(new Error(payload.error || "Local translation failed."));
      }
      this.pump();
    });
  }

  handleExit(error) {
    const child = this.child;
    this.child = null;
    this.ready = null;
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
      if (!this.current && !this.queue.length) this.scheduleStop();
      return;
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const next = this.queue.shift();
    try {
      const ready = await this.ensureStarted(next.onProgress, next.timeoutMs);
      throwIfCancelled();
      next.onProgress?.(`Model dịch local sẵn sàng trên ${ready.device}.`);
      const untrack = trackChild(this.child, getCancelToken());
      const timer = setTimeout(() => this.stop("Local translation request timed out."), next.timeoutMs);
      this.current = { ...next, timer, untrack };
      this.child.stdin.write(`${JSON.stringify({ ...next.payload, id: next.id })}\n`, "utf8");
    } catch (error) {
      next.reject(error);
      this.pump();
    }
  }

  scheduleStop() {
    if (!this.child || this.idleTimer) return;
    this.idleTimer = setTimeout(() => this.stop("idle"), this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  stop(reason = "shutdown") {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.child) return;
    const child = this.child;
    try {
      child.stdin.write(`${JSON.stringify({ type: "shutdown", reason })}\n`, "utf8");
    } catch (_error) {}
    const timer = setTimeout(() => child.kill(), 1500);
    timer.unref?.();
  }
}

function getWorker(settings, model, device) {
  const pythonCommand = settings.localTranslationPythonCommand || "python";
  const scriptPath = settings.localTranslationWorkerScript || path.join(__dirname, "..", "..", "tools", "opus_translate_worker.py");
  const key = [pythonCommand, path.resolve(scriptPath), model, device || "auto"].join("|");
  if (!workers.has(key)) {
    workers.forEach((worker) => worker.stop("configuration_changed"));
    workers.clear();
    workers.set(key, new TranslationWorker({
      pythonCommand,
      scriptPath,
      model,
      device,
      idleTimeoutMs: settings.localTranslationWorkerIdleTimeoutMs
    }));
  }
  return workers.get(key);
}

class LocalTranslationService {
  constructor(settings = {}) {
    this.settings = settings;
    this.provider = settings.localTranslationProvider || "opus_mt";
    this.model = settings.localTranslationModel || DEFAULT_MODEL;
    this.device = settings.localTranslationDevice || "";
  }

  async translateToVietnamese({ segments = [], sourceLanguage = "en", onProgress }) {
    if (this.provider === "hy_mt2_ollama") {
      try {
        return await new HyMtTranslationService(this.settings).translateToVietnamese({
          segments,
          sourceLanguage,
          onProgress
        });
      } catch (hyMtError) {
        if (this.settings.hyMt2FallbackToOpus === false) throw hyMtError;
        onProgress?.(`Hy-MT2 không khả dụng; đang chuyển sang OPUS-MT. ${hyMtError.message}`);
        try {
          return await new LocalTranslationService({
            ...this.settings,
            localTranslationProvider: "opus_mt"
          }).translateToVietnamese({ segments, sourceLanguage, onProgress });
        } catch (opusError) {
          throw new Error(`Hy-MT2: ${hyMtError.message} | OPUS-MT fallback: ${opusError.message}`);
        }
      }
    }
    const language = String(sourceLanguage || "en").toLowerCase();
    if (language !== "auto" && !language.startsWith("en")) {
      throw new Error(`Model OPUS-MT local chỉ hỗ trợ nguồn tiếng Anh, không hỗ trợ "${sourceLanguage}".`);
    }
    const cleanSegments = segments
      .map((segment, index) => ({
        id: segment.id || `preview_${index + 1}`,
        text: String(segment.text || "").replace(/\s+/g, " ").trim()
      }))
      .filter((segment) => segment.text);
    if (!cleanSegments.length) return [];
    const result = await require('./productionResourcePool').withSlot('local-translation', 1, getCancelToken()?.abortController?.signal, async () => {
      throwIfCancelled();
      const worker = getWorker(this.settings, this.model, this.device);
      return worker.enqueue({
      segments: cleanSegments,
      batchSize: Number(this.settings.localTranslationBatchSize || 8)
    }, {
      onProgress,
      timeoutMs: Number(this.settings.localTranslationTimeoutMs || 10 * 60 * 1000)
      });
    });
    const translated = new Map((result.segments || []).map((segment) => [segment.id, segment.text]));
    return segments.map((segment, index) => {
      const id = segment.id || `preview_${index + 1}`;
      const text = translated.get(id) || "";
      return {
        ...segment,
        id,
        translatedText: text,
        previewSubtitleVi: text
      };
    });
  }
}

module.exports = LocalTranslationService;
module.exports.shutdownPersistentWorkers = () => {
  workers.forEach((worker) => worker.stop("app_shutdown"));
  workers.clear();
};
