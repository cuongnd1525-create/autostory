"use strict";

/**
 * Gemini Web (consumer gemini.google.com via the local bridge) behind the same
 * four calls the Series chat session uses for Vertex:
 *   buildVideoPart / createCacheFromParts / generateContent / deleteCachedContent
 *
 * The session keeps sending the logical history (Vertex style). Here the history
 * lives in ONE real Gemini Web conversation instead:
 *  - first call: the upload batches (proxy chunks + manifests + transcript as
 *    attachments, max N files per message, like the manual chat) then the turn;
 *  - "linear" (default): every later call continues after the latest answer and
 *    sends only the newest user turn — exactly what a person does in the chat;
 *  - "branch": continue from the answer the logical history ends with
 *    (cid/rid/rcid), which allows parallel Parts IF Gemini Web accepts replies
 *    to an earlier answer (unverified; experimental).
 */

const fs = require("fs/promises");
const fsSync = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const http = require("http");

/**
 * Minimal fetch over node:http for the LOCAL bridge. Node's global fetch
 * (undici) aborts when response headers take > 300 s, but one Gemini Web turn
 * (upload + watching 16 min of video) legitimately takes longer: live run
 * 2026-10-21 finished after 5 min 7 s and the app saw "fetch failed".
 */
function localFetch(url, { method = "GET", headers = {}, body, signal, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body == null ? null : Buffer.from(String(body));
    const req = http.request({
      hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method,
      headers: { ...headers, ...(payload ? { "Content-Length": payload.length } : {}) }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => text, json: async () => JSON.parse(text) });
      });
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`Bridge không trả lời sau ${Math.round(timeoutMs / 60000)} phút.`), { code: "timeout" })));
    req.on("error", reject);
    if (signal) {
      if (signal.aborted) return req.destroy(Object.assign(new Error("aborted"), { name: "AbortError" }));
      signal.addEventListener("abort", () => req.destroy(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }
    if (payload) req.write(payload);
    req.end();
  });
}

const INLINE_TEXT_EXT = new Set([".txt", ".json", ".csv", ".md"]);
// Canned Gemini app answers (error / guardrail fallbacks), seen live 2026-10-21:
// "I'm having a hard time fulfilling your request. Can I help you with something else instead?"
// "I encountered an error doing what you asked. Could you try again?"
// "Tôi không thể giúp bạn việc đó, vì tôi chỉ là một mô hình ngôn ngữ ..."
const APP_FAILURE = /^(I encountered an error|Something went wrong|I'm having a hard time fulfilling|Sorry, something went wrong|I'm (just )?a language model|I can't help with that|Đã xảy ra lỗi|Tôi đã gặp lỗi|Có lỗi xảy ra|Tôi không thể giúp bạn việc đó|Tôi chỉ là một mô hình ngôn ngữ)/i;
const isAppFailure = (text) => { const t = String(text || "").trim(); return t.length < 400 && APP_FAILURE.test(t); };

const sha = (text) => crypto.createHash("sha256").update(String(text)).digest("hex");
const textOf = (turn) => (turn?.parts || []).map((part) => part.text || "").filter(Boolean).join("\n\n");
const fileUriToPath = (uri) => {
  const value = String(uri || "");
  if (!value.startsWith("file://")) return value;
  const decoded = decodeURIComponent(value.replace(/^file:\/\//, ""));
  return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
};
const toFileUri = (filePath) => `file://${path.resolve(filePath).startsWith("/") ? "" : "/"}${encodeURI(path.resolve(filePath).replace(/\\/g, "/"))}`;

class GeminiWebTransport {
  constructor(settings = {}, { bridge, fetchImpl = localFetch, tempDir } = {}) {
    if (!bridge) throw new Error("GeminiWebTransport needs the bridge process.");
    this.settings = settings;
    this.bridge = bridge;
    this.fetchImpl = fetchImpl;
    this.providerId = "gemini_web";
    this.label = "Gemini Web";
    this.projectId = "gemini-web";
    this.location = "local";
    this.mode = settings.geminiWebBranching === "branch" ? "branch" : "linear";
    this.maxFiles = Math.max(1, Math.min(10, Number(settings.geminiWebMaxFilesPerMessage) || 10));
    // Same cap as the manual pack (manualGeminiPackService MAX_ROOT_PROXY_CHUNKS = 5):
    // the Gemini app answers "I'm having a hard time fulfilling your request" when
    // one message carries 6 proxy chunks (live 2026-10-21), while the manual
    // UPLOAD-BATCH split (1 chunk, then 5 chunks + texts + prompt) works.
    this.maxVideos = Math.max(1, Math.min(this.maxFiles, Number(settings.geminiWebMaxVideosPerMessage) || 5));
    this.maxPromptChars = Math.max(4000, Number(settings.geminiWebMaxPromptChars) || 24000);
    this.tempDir = tempDir || path.join(os.tmpdir(), "cineviral-gemini-web");
    this.sourceParts = null;
    this.latest = null;           // linear: conversation ids after the newest answer
    this.byAnswer = new Map();    // branch: sha(answer text) -> conversation ids
    this.queue = Promise.resolve();
    this.calls = [];
  }

  /** Model: explicit setting, else the best Pro the account lists. */
  async resolveSeriesModel() {
    const { status } = await this.bridge.ensureStarted();
    const models = Array.isArray(status?.models) ? status.models : [];
    const explicit = String(this.settings.geminiWebModel || "").trim();
    if (explicit) {
      if (models.length && !models.includes(explicit)) throw Object.assign(new Error(`Tài khoản Gemini Web không có model "${explicit}". Có: ${models.join(", ")}.`), { kind: "unknown_model" });
      return { model: explicit, source: "geminiWebModel" };
    }
    const pro = models.filter((id) => /pro/i.test(id) && !/canvas|music|video|flash/i.test(id)).sort().reverse()[0];
    if (!pro) throw Object.assign(new Error(`Tài khoản Gemini Web không có model Pro (có: ${models.join(", ") || "không có"}). Gói Gemini miễn phí không đủ cho phân tích video dài.`), { kind: "unknown_model" });
    return { model: pro, source: "auto" };
  }

  async probeModel(model) {
    const { status } = await this.bridge.ensureStarted();
    return { ok: (status?.models || []).includes(model), status: 200 };
  }

  async buildVideoPart(filePath) {
    return { fileData: { fileUri: toFileUri(filePath), mimeType: "video/mp4" } };
  }

  /** Text attachments (manifests, transcript) go as files, like the chat upload. */
  async buildTextPart(filePath) {
    return { fileData: { fileUri: toFileUri(filePath), mimeType: "text/plain" } };
  }

  async createCacheFromParts({ parts }) {
    this.sourceParts = parts;
    this.latest = null;
    this.byAnswer.clear();
    return { name: `gemini-web-conversation-${Date.now()}` };
  }

  async deleteCachedContent() { return true; }
  async budgetStatus() { return { provider: "gemini_web", totalSpentUsd: 0, note: "Tính vào quota của gói Gemini, không trả phí theo token." }; }

  async attachable(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".mp4" || INLINE_TEXT_EXT.has(ext)) return filePath;
    // .srt and other text types: re-expose as .txt so Gemini Web accepts them.
    await fs.mkdir(this.tempDir, { recursive: true });
    const copy = path.join(this.tempDir, `${path.basename(filePath)}.txt`);
    await fs.copyFile(filePath, copy);
    return copy;
  }

  async promptFile(text) {
    await fs.mkdir(this.tempDir, { recursive: true });
    const file = path.join(this.tempDir, `turn-instructions-${sha(text).slice(0, 10)}.txt`);
    if (!fsSync.existsSync(file)) await fs.writeFile(file, text, "utf8");
    return file;
  }

  /** Long turns travel as an attached .txt (the chat would turn them into a file too). */
  async shapeTurn(text, files) {
    if (text.length <= this.maxPromptChars) return { prompt: text, files };
    const file = await this.promptFile(text);
    return {
      prompt: `The complete instructions for this turn are in the attached file ${path.basename(file)}. Read ALL of it and follow it exactly; answer only as it requires.`,
      files: [...files, file]
    };
  }

  async post(body, signal) {
    const { endpoint, token } = await this.bridge.ensureStarted();
    const response = await this.fetchImpl(`${endpoint}/bridge/v1/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      // The bridge takes [{path}]; accept plain path strings from every call site.
      body: JSON.stringify({ thinking: this.settings.geminiWebThinking || "", ...body, files: (body.files || []).map((file) => (typeof file === "string" ? { path: file } : file)) }),
      signal,
      // A bit longer than the bridge's own generate timeout so the bridge reports it.
      timeoutMs: (Math.max(120, Number(this.settings.geminiWebGenerateTimeoutSec) || 900) + 120) * 1000
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = data?.error?.code || "generate_failed";
      const error = new Error(`[GEMINI_WEB] ${code}: ${data?.error?.message || `HTTP ${response.status}`}`);
      error.kind = code;
      // Only transient bridge/Google failures are retried by the session; never
      // hammer a rate limit or an expired login (that is what gets accounts flagged).
      if (code === "generate_failed" || code === "upload_failed" || code === "timeout") error.httpStatus = 503;
      if (code === "auth_expired") error.message += " — lấy lại cookie Gemini Web trong Cài đặt.";
      if (code === "rate_limited") error.message += " — Google đang giới hạn tài khoản; dừng lại, thử lại sau vài giờ.";
      throw error;
    }
    if (data.downgraded && this.settings.geminiWebAllowDowngrade !== true) {
      throw Object.assign(new Error(`[GEMINI_WEB] Gemini Web trả lời bằng ${data.model} thay vì ${data.requestedModel} (hết quota model Pro). Dừng để không so sánh nhầm chất lượng.`), { kind: "model_downgraded" });
    }
    return data;
  }

  /** First message(s) of a conversation: upload batches, then the turn. */
  async open({ model, turnText, signal }) {
    const entries = [];
    let header = "";
    let pendingLabel = "";
    for (const part of this.sourceParts || []) {
      if (part.fileData) {
        entries.push({ label: pendingLabel, file: await this.attachable(fileUriToPath(part.fileData.fileUri)) });
        pendingLabel = "";
      } else if (part.text) {
        if (!header && !entries.length && !pendingLabel) header = part.text;
        else pendingLabel = part.text;
      }
    }
    const listing = (group) => group.map((entry) => `- ${path.basename(entry.file)}${entry.label ? `: ${entry.label.replace(/^FILE\s+\S+\s*(—\s*)?/, "").replace(/:$/, "")}` : ""}`).join("\n");
    const batches = GeminiWebTransport.planBatches(entries, { maxFiles: this.maxFiles, maxVideos: this.maxVideos, reserveForPrompt: turnText.length > this.maxPromptChars ? 1 : 0 });
    let conversation = null;
    let data = null;
    for (const [index, group] of batches.entries()) {
      const last = index === batches.length - 1;
      const intro = `${header}\n\nUPLOAD BATCH ${index + 1}/${batches.length} - files attached to this message:\n${listing(group)}`;
      let prompt = intro;
      let files = group.map((entry) => entry.file);
      if (last) {
        const shaped = await this.shapeTurn(turnText, files);
        if (shaped.files.length > files.length && files.length >= this.maxFiles) {
          // No room for the instructions file in a full batch: send it alone next.
          data = await this.post({ model, prompt: `${intro}\n\nOnly confirm receipt in one line; the task follows in the next message.`, files, conversation }, signal);
          conversation = data.conversation;
          if (isAppFailure(data.text)) {
            this.latest = conversation;
            throw Object.assign(new Error(`[GEMINI_WEB] Gemini app từ chối ngay lượt upload (${files.length} file): «${String(data.text).trim()}». Video đã gắn vào chat nhưng app không chịu xử lý; thử cùng thao tác bằng tay trên tài khoản này để biết là giới hạn của app/tài khoản hay của bridge.`), { kind: "gemini_app_refused_upload" });
          }
          data = await this.post({ model, prompt: shaped.prompt, files: shaped.files.slice(files.length), conversation }, signal);
          return data;
        }
        prompt = `${intro}\n\n${shaped.prompt}`;
        files = shaped.files;
      } else {
        prompt += "\n\nOnly confirm receipt in one line; more files and the task follow in the next message.";
      }
      data = await this.post({ model, prompt, files: files.map((file) => ({ path: file })), conversation }, signal);
      conversation = data.conversation;
      if (!last && isAppFailure(data.text)) {
        this.latest = conversation;
        throw Object.assign(new Error(`[GEMINI_WEB] Gemini app từ chối ngay lượt upload ${index + 1}/${batches.length} (${group.length} file): «${String(data.text).trim()}». Video đã gắn vào chat nhưng app không chịu xử lý; thử cùng thao tác bằng tay trên tài khoản này để biết là giới hạn của app/tài khoản hay của bridge.`), { kind: "gemini_app_refused_upload" });
      }
    }
    return data;
  }

  async generateContent({ contents = [], model, signal } = {}) {
    const run = async () => {
      const started = Date.now();
      const lastUser = contents.at(-1);
      let data;
      if (this.mode === "branch") {
        let from = null;
        let index = contents.length - 1;
        for (; index >= 0; index -= 1) {
          if (contents[index].role === "model") { from = this.byAnswer.get(sha(textOf(contents[index]))) || null; break; }
        }
        const pending = contents.slice(index + 1).filter((turn) => turn.role === "user").map(textOf).join("\n\n");
        if (!from) data = await this.open({ model, turnText: pending, signal });
        else {
          const shaped = await this.shapeTurn(pending, []);
          data = await this.post({ model, prompt: shaped.prompt, files: shaped.files.map((file) => ({ path: file })), conversation: from }, signal);
        }
      } else if (!this.latest) {
        data = await this.open({ model, turnText: contents.filter((turn) => turn.role === "user").map(textOf).join("\n\n"), signal });
      } else {
        const shaped = await this.shapeTurn(textOf(lastUser), []);
        data = await this.post({ model, prompt: shaped.prompt, files: shaped.files.map((file) => ({ path: file })), conversation: this.latest }, signal);
      }
      this.latest = data.conversation;
      this.byAnswer.set(sha(data.text || ""), data.conversation);
      this.calls.push({ ms: Date.now() - started, model: data.model });
      const text = String(data.text || "");
      // The Gemini app's own "something failed, try again" answers are not model
      // output: report them as a transient error so the session re-sends the turn
      // (continuing the same chat, without re-uploading the videos).
      if (isAppFailure(text)) {
        throw Object.assign(new Error(`[GEMINI_WEB] Gemini app báo lỗi thay vì trả lời: «${text.trim()}»`), { kind: "gemini_app_error", httpStatus: 503 });
      }
      return {
        text,
        content: { role: "model", parts: [{ text }] },
        finishReason: text ? "STOP" : "EMPTY",
        blockReason: null,
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, estimatedCostUsd: 0 },
        usageMetadata: null,
        modelMs: data.elapsedMs || Date.now() - started,
        servedModel: data.model
      };
    };
    // Linear mode = one conversation path: strictly one message at a time.
    if (this.mode === "branch") return run();
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }
}

/**
 * Upload plan mirroring the manual UPLOAD-BATCH folders: the LAST message holds
 * the last <= maxVideos chunks + every text file (+ room for the instructions
 * file); earlier chunks go first in acknowledge-only messages of <= maxVideos.
 */
GeminiWebTransport.planBatches = (entries = [], { maxFiles = 10, maxVideos = 5, reserveForPrompt = 0 } = {}) => {
  const isVideo = (entry) => /\.(mp4|mov|webm|mkv)$/i.test(entry.file);
  const videos = entries.filter(isVideo);
  const others = entries.filter((entry) => !isVideo(entry));
  const room = Math.max(1, maxFiles - reserveForPrompt);
  const finalVideoCount = Math.max(0, Math.min(maxVideos, videos.length, room - Math.min(others.length, room)));
  const finalBatch = [...videos.slice(videos.length - finalVideoCount), ...others.slice(0, room)];
  const early = videos.slice(0, videos.length - finalVideoCount);
  const batches = [];
  for (let i = 0; i < early.length; i += maxVideos) batches.push(early.slice(i, i + maxVideos));
  const extraOthers = others.slice(room);
  for (let i = 0; i < extraOthers.length; i += maxFiles) batches.push(extraOthers.slice(i, i + maxFiles));
  batches.push(finalBatch);
  return batches.filter((batch, index) => batch.length || index === batches.length - 1);
};
GeminiWebTransport.toFileUri = toFileUri;
GeminiWebTransport.localFetch = localFetch;
GeminiWebTransport.fileUriToPath = fileUriToPath;
module.exports = GeminiWebTransport;
