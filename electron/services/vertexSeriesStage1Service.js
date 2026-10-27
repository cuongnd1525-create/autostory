"use strict";

/**
 * Vertex Series Stage 1 = the Gemini chat workflow, automated.
 *
 * Why: the old Vertex path sent ONE request (all files + the whole prompt) and
 * asked for all 3 scripts at once with gemini-2.5-flash, unlabeled files and
 * no Series stages, so it was slow, weaker than the chat, and its output could
 * not even be imported for sequential Series packages (no series-blueprint.json).
 *
 * This service replays exactly what the user does in the Gemini chat:
 *   1. the same upload batches (proxy chunks + manifests + transcript), labeled
 *      by file name, uploaded once to GCS and held in a Vertex context cache;
 *   2. turn 0 = the package's own Stage 0 prompt -> series-blueprint.json,
 *      checked with the import's validateBlueprint, repaired in-session, then
 *      locked with serializedGeminiWorkflowService.importBlueprint (identical
 *      to the "Nhập Series Blueprint" button);
 *   3. turns 1-3 = the package's own script-1/3/4 NEXT prompts in the same
 *      conversation; each Script is checked with validateScriptAgainstBlueprint
 *      and repaired in-session. Parts run in parallel from the locked Blueprint
 *      by default (fast); "sequential" replays the chat order exactly.
 */

const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");

const VertexAiService = require("./vertexAiService");
const Serial = require("./serializedGeminiWorkflowService");
const Bridge = require("./seriesBlueprintBridge");
const { parseGeminiJsonObject, inspectGeminiJsonFiles } = require("./geminiJsonArtifactService");
const ImportPreflight = require("./manualGeminiImportPreflight");
const Quality = require("./draftEditorialQualityRules");
const EditorialRules = require("./seriesEditorialRules");

const RESULT_DIR = "01-CONFIGURED-AI-RESULT";
const PART_IDS = [1, 3, 4];
/** Tried (countTokens) when no explicit/current model is configured. */
const MODEL_CANDIDATES = ["gemini-3.1-pro", "gemini-3.1-pro-preview"];
const LEGACY_DEFAULT_MODEL = "gemini-2.5-pro";
const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);
const ACCEPTED_TYPES = new Set(["story_recut_script", "story_spine_edit_script"]);
// Bodycam / true-crime evidence trips the default thresholds; block only high-severity output.
const DEFAULT_SAFETY = ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"]
  .map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" }));
const TEXT_ORDER = ["scene-manifest.json", "proxy-chunks-manifest.json", "source-transcript.srt", "action-candidates.json", "hook-contract.json"];

const resolvedModels = new Map();

const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const userTurn = (text) => ({ role: "user", parts: [{ text }] });
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const txtOf = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();

function existingPath(...candidates) {
  return candidates.find((candidate) => candidate && fsSync.existsSync(candidate)) || "";
}

async function writeJson(filePath, payload) {
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(temp, filePath);
}

/** The same files the user uploads to the chat (batch folders), deduplicated by name. */
async function collectChatInputs(root, info = {}) {
  const pass1Dir = existingPath(info.pass1UploadDir, path.join(root, "01-GUI-GEMINI"));
  let dirs = (Array.isArray(info.proxyUploadBatchDirs) ? info.proxyUploadBatchDirs : []).filter((dir) => dir && fsSync.existsSync(dir));
  if (!dirs.length && pass1Dir) {
    const entries = await fs.readdir(pass1Dir, { withFileTypes: true }).catch(() => []);
    dirs = entries.filter((entry) => entry.isDirectory() && /^UPLOAD-BATCH-/i.test(entry.name)).map((entry) => path.join(pass1Dir, entry.name)).sort();
  }
  if (!dirs.length && pass1Dir) dirs = [pass1Dir];
  const byName = new Map();
  for (const dir of dirs) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (/\.txt$/i.test(name) || /^00-/.test(name)) continue; // prompts / upload notes are sent as turns, not files
      if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), path.join(dir, name));
    }
  }
  const contract = existingPath(info.hookContractPath, pass1Dir && path.join(pass1Dir, "hook-contract.json"));
  if (contract && !byName.has("hook-contract.json")) byName.set("hook-contract.json", contract);
  const files = [...byName.values()];
  const videos = files.filter((file) => VertexAiService.inferMimeType(file).startsWith("video/")).sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  const rank = (file) => { const index = TEXT_ORDER.indexOf(path.basename(file).toLowerCase()); return index < 0 ? TEXT_ORDER.length : index; };
  const texts = files.filter((file) => !videos.includes(file)).sort((a, b) => rank(a) - rank(b) || path.basename(a).localeCompare(path.basename(b)));
  if (!videos.length) throw new Error("Gói GĐ1 không có proxy video trong các thư mục UPLOAD-BATCH. Hãy tạo lại gói.");
  return { pass1Dir, videos, texts };
}

class VertexSeriesStage1Service {
  constructor(settings = {}, dependencies = {}) {
    this.settings = settings;
    this.vertex = dependencies.vertex || new VertexAiService(settings);
    // Same session over another transport (e.g. Gemini Web): its own log tag and provider label.
    this.tag = dependencies.tag || "VERTEX_SERIES";
    this.providerId = this.vertex.providerId || "vertex_ai";
    this.providerLabel = this.vertex.label || "Vertex AI";
    this.sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.controller = new AbortController();
    this.cancelled = false;
    this.calls = [];
    this.cacheName = null;
    this.sourceParts = [];
  }

  cancel() {
    this.cancelled = true;
    this.controller.abort();
    return true;
  }

  /**
   * Sequential Series packages, and also serialized packages that were built in
   * one-request mode (Auto Mode used sequentialManual:false): those are upgraded
   * in place before the session (see upgradePackageToSeries).
   */
  static isApplicable(info = {}, settings = {}, promptText = "") {
    if (info?.workflow !== "manual_gemini_draft_review" || settings.vertexSeriesSession === false) return false;
    return info?.sequentialSeriesEnabled === true || Serial.isSerialized(promptText);
  }

  /** Same files/fields manualGeminiPackService writes with sequentialManual=true. */
  async upgradePackageToSeries({ root, info, promptText, onProgress }) {
    const profile = (String(promptText).match(/prompt_profile:\s*(serialized_genz|serialized_interleaved)/) || [])[1] || "";
    const sharedHook = /- shared cold open:\s*true/i.test(String(promptText));
    const bounds = String(promptText).match(/target duration for EACH Part:\s*([\d.]+)\s*-\s*([\d.]+)/i);
    const minDuration = bounds ? Number(bounds[1]) : 75;
    const maxDuration = bounds ? Number(bounds[2]) : 110;
    const nextDir = path.join(root, "02-SERIES-SEQUENTIAL");
    await fs.mkdir(nextDir, { recursive: true });
    for (const id of PART_IDS) {
      await fs.writeFile(path.join(nextDir, `script-${id}-NEXT-PROMPT.txt`), Serial.partPrompt(id, profile, sharedHook, minDuration, maxDuration), "utf8");
    }
    const infoPath = path.join(root, "package-info.json");
    const current = JSON.parse(await fs.readFile(infoPath, "utf8"));
    const upgraded = {
      ...current,
      sequentialSeriesEnabled: true,
      sequentialSeriesProfile: profile,
      sequentialSeriesSharedHook: sharedHook,
      sequentialSeriesNextStepsDir: nextDir,
      seriesBlueprintPath: "",
      sequentialSeriesUpgradedBy: "vertex_series_session"
    };
    await writeJson(infoPath, upgraded);
    this.emit(onProgress, 2, `[${this.tag}] Gói đang ở chế độ 1 lượt; đã chuyển sang Series tuần tự (${profile}, mỗi Part ${minDuration}-${maxDuration}s) để chạy phiên Blueprint -> Script 1, 3, 4.`);
    return upgraded;
  }

  emit(onProgress, percent, message) {
    onProgress?.({ step: "configured_ai_stage1", percent: Math.round(percent), message });
  }

  async resolveModel(onProgress) {
    if (typeof this.vertex.resolveSeriesModel === "function") return this.vertex.resolveSeriesModel(onProgress);
    const explicit = String(this.settings.vertexSeriesModel || "").trim();
    if (explicit) return { model: explicit, source: "vertexSeriesModel" };
    const quality = String(this.settings.vertexQualityModel || "").trim();
    if (quality && quality !== LEGACY_DEFAULT_MODEL) return { model: quality, source: "vertexQualityModel" };
    const key = `${this.vertex.projectId}|${this.vertex.location}`;
    if (resolvedModels.has(key)) return resolvedModels.get(key);
    for (const candidate of MODEL_CANDIDATES) {
      const probe = await this.vertex.probeModel(candidate, this.controller.signal);
      if (probe.ok) {
        const resolved = { model: candidate, source: "auto" };
        resolvedModels.set(key, resolved);
        return resolved;
      }
    }
    this.emit(onProgress, 4, `[${this.tag}] Không tìm thấy ${MODEL_CANDIDATES.join(" / ")} trong project; dùng ${quality || LEGACY_DEFAULT_MODEL}. Có thể đặt model trong Cài đặt > Vertex > Model chất lượng.`);
    return { model: quality || LEGACY_DEFAULT_MODEL, source: "fallback" };
  }

  async buildSourceParts({ videos, texts, chunkManifest, onProgress }) {
    const chunks = Array.isArray(chunkManifest?.chunks) ? chunkManifest.chunks : [];
    const rangeOf = (name) => chunks.find((chunk) => path.basename(String(chunk.file || "")).toLowerCase() === name.toLowerCase());
    const parts = [{ text: "UPLOADED FILES OF THIS CHAT (the same upload batches as the Gemini chat). Each file is preceded by its exact file name. Inspect them; they are the source of truth for every following turn." }];
    let done = 0;
    for (const video of videos) {
      if (this.cancelled) throw Object.assign(new Error("Đã dừng."), { kind: "cancelled" });
      const name = path.basename(video);
      const chunk = rangeOf(name);
      parts.push({ text: `FILE ${name}${chunk ? ` — proxy chunk of the source video, absolute SOURCE ${Number(chunk.sourceStartSec).toFixed(3)}-${Number(chunk.sourceEndSec).toFixed(3)}s` : ""}:` });
      parts.push(await this.vertex.buildVideoPart(video, this.controller.signal));
      done += 1;
      this.emit(onProgress, 6 + (done / videos.length) * 12, `[${this.tag}] Đã chuẩn bị video ${done}/${videos.length} (${name}${this.providerId === "vertex_ai" ? "; file đã có trên bucket thì không upload lại" : ""}).`);
    }
    for (const file of texts) {
      if (typeof this.vertex.buildTextPart === "function") {
        // Chat-style transports take the manifests/transcript as attachments.
        parts.push({ text: `FILE ${path.basename(file)}:` });
        parts.push(await this.vertex.buildTextPart(file, this.controller.signal));
      } else {
        parts.push({ text: `FILE ${path.basename(file)}:\n${await fs.readFile(file, "utf8")}` });
      }
    }
    return parts;
  }

  /** Logical turns -> request contents (sources inline only when no cache). */
  materialize(turns) {
    if (this.cacheName || !turns.length) return turns;
    const [first, ...rest] = turns;
    return [{ role: "user", parts: [...this.sourceParts, ...first.parts] }, ...rest];
  }

  async call({ label, turns, model, onProgress, percent, temperature = null }) {
    const maxAttempts = 1 + Math.max(0, num(this.settings.vertexSeriesHttpRetries, 2));
    for (let attempt = 1; ; attempt += 1) {
      if (this.cancelled) throw Object.assign(new Error("Đã dừng phân tích GĐ1 Vertex."), { kind: "cancelled" });
      const startedAt = Date.now();
      try {
        const result = await this.vertex.generateContent({
          contents: this.materialize(turns),
          model,
          cachedContent: this.cacheName,
          temperature: temperature ?? num(this.settings.vertexSeriesTemperature, 0.2),
          safetySettings: this.settings.vertexSeriesSafety === "default" ? null : DEFAULT_SAFETY,
          taskType: "stage1",
          signal: this.controller.signal
        });
        this.calls.push({ label, attempt, ms: Date.now() - startedAt, cached: Boolean(this.cacheName), usage: result.usage, finishReason: result.finishReason });
        await this.saveRaw(label, result.text);
        if (result.blockReason) {
          throw Object.assign(new Error(`[${label}] Vertex chặn prompt (${result.blockReason}).`), { kind: "safety_block" });
        }
        if (!String(result.text || "").trim()) {
          throw Object.assign(new Error(`[${label}] Vertex không trả nội dung (finishReason ${result.finishReason || "?"}).`), { kind: result.finishReason === "SAFETY" ? "safety_block" : "empty_response" });
        }
        return result;
      } catch (error) {
        if (this.cancelled || error?.name === "AbortError") throw Object.assign(new Error("Đã dừng phân tích GĐ1 Vertex."), { kind: "cancelled" });
        if (this.cacheName && [400, 404].includes(error.httpStatus) && /cached ?content/i.test(String(error.message))) {
          this.emit(onProgress, percent, `[${this.tag}] ${label}: context cache không còn hợp lệ; gửi kèm nguồn trực tiếp.`);
          this.cacheName = null;
          continue;
        }
        if (RETRYABLE_HTTP.has(error.httpStatus) && attempt < maxAttempts) {
          const delayMs = error.retryAfterMs || num(this.settings.vertexSeriesRetryBaseMs, 5000) * attempt;
          this.emit(onProgress, percent, `[${this.tag}] ${label}: ${this.providerLabel} trả ${error.httpStatus}; thử lại sau ${seconds(delayMs)} (${attempt}/${maxAttempts - 1}).`);
          await this.sleep(delayMs);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Measured TTS speed for the VO-fits-bed fact: explicit setting, else the most
   * recently measured voice profile (conservative = slower percentile, the
   * case that overflows), else the tool's default.
   */
  async resolveVoWordsPerSec() {
    const explicit = Number(this.settings.vertexSeriesVoWordsPerSec);
    if (Number.isFinite(explicit) && explicit > 0.8) return explicit;
    try {
      const store = JSON.parse(await fs.readFile(path.join(String(this.settings.workspaceRoot || ""), ".cineviral", "voice-profiles.json"), "utf8"));
      const latest = Object.values(store?.profiles || {})
        .filter((p) => Number(p?.sampleCount) >= 3)
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0];
      const wps = Number(latest?.conservativeWordsPerSecond || latest?.wordsPerSecond);
      if (Number.isFinite(wps) && wps > 0.8) return Math.min(4.2, wps);
    } catch (_) { /* no measured profile yet */ }
    return Quality.DEFAULTS.voWordsPerSec;
  }

  async saveRaw(label, text) {
    if (!this.rawDir) return;
    try {
      await fs.mkdir(this.rawDir, { recursive: true });
      await fs.writeFile(path.join(this.rawDir, `${String(this.calls.length).padStart(2, "0")}-${label}.txt`), String(text || ""), "utf8");
    } catch (_) { /* diagnostics only */ }
  }

  async runBlueprint({ prompt, model, ctx, onProgress, maxRepairs, quality = null }) {
    const turns = [userTurn(prompt)];
    let lastErrors = [];
    let accepted = null;
    let qualityRounds = 0;
    const qualityLimit = quality ? Math.max(0, num(this.settings.vertexSeriesQualityRepairs, 1)) : 0;
    for (let round = 0; round <= maxRepairs + qualityLimit; round += 1) {
      const result = await this.call({ label: round ? `BLUEPRINT_REPAIR_${round}` : "BLUEPRINT", turns, model, onProgress, percent: 30 + Math.min(round, 3) * 5 });
      let blueprint = null;
      try { blueprint = parseGeminiJsonObject(result.text, "series-blueprint.json"); } catch (error) {
        const said = String(result.text || "").replace(/\s+/g, " ").trim();
        lastErrors = [said.length < 600 ? `Model không trả JSON mà trả lời: «${said}»` : `Không phải JSON hợp lệ: ${error.message}`];
      }
      if (blueprint) lastErrors = Serial.validateBlueprint(blueprint, ctx).errors;
      if (blueprint && !lastErrors.length) {
        const modelTurn = result.content || { role: "model", parts: [{ text: result.text }] };
        accepted = { blueprint, accepted: modelTurn, rounds: round + 1, warnings: [] };
        if (!quality || qualityRounds >= qualityLimit) {
          accepted.warnings = quality ? Quality.formatFindings(Quality.checkBlueprintStructure({ blueprint, manifest: quality.manifest }).findings, 20) : [];
          return accepted;
        }
        // Tool: structure of Gemini's own hook audition. Gemini: the editorial judgement.
        const facts = Quality.checkBlueprintStructure({ blueprint, manifest: quality.manifest }).findings;
        const critic = this.settings.vertexSeriesEditorialCritic === false ? [] : await this.runCritic({
          label: "BLUEPRINT_CRITIC", turns: [...turns, modelTurn], model, onProgress, percent: 40,
          prompt: [EditorialRules.blueprintCriticPrompt(), Quality.blueprintEvidence({ blueprint, ...quality })].filter(Boolean).join("\n\n")
        });
        const qa = [...facts, ...critic];
        if (!qa.length) return accepted;
        qualityRounds += 1;
        this.emit(onProgress, 40, `[${this.tag}] Blueprint: Gemini biên tập chỉ ra ${critic.length} vấn đề, tool thấy ${facts.length} lỗi cấu trúc. Yêu cầu sửa trong cùng phiên...`);
        turns.push(modelTurn);
        turns.push(userTurn([
          "Review of this series-blueprint.json (tool facts + your own editor review):",
          ...Quality.formatFindings(qa, 15).map((line) => `- ${line}`),
          "Re-watch the cited ranges and fix them; keep hookAudition consistent with parts[].hook.",
          "Return the complete corrected series-blueprint.json as exactly ONE JSON object, nothing else. Do not write any Script yet."
        ].join("\n")));
        continue;
      }
      if (accepted && round >= maxRepairs) return accepted; // a QA repair broke the format: keep the valid one
      this.emit(onProgress, 32 + round * 5, `[${this.tag}] Blueprint chưa đạt (${lastErrors.length} lỗi: ${lastErrors.slice(0, 2).join(" | ")}). Yêu cầu sửa trong cùng phiên...`);
      turns.push(result.content || { role: "model", parts: [{ text: result.text }] });
      turns.push(userTurn([
        "RecapTool Studio's import validator rejected this series-blueprint.json:",
        ...lastErrors.slice(0, 25).map((error) => `- ${error}`),
        "Fix every error using only the uploaded source. Return the complete corrected series-blueprint.json as exactly ONE JSON object, nothing else. Do not write any Script yet."
      ].join("\n")));
    }
    if (accepted) return accepted;
    throw Object.assign(new Error(`[${this.tag}] Blueprint không đạt sau ${maxRepairs} lượt sửa: ${lastErrors.slice(0, 6).join(" | ")}`), { kind: "blueprint_invalid" });
  }

  /**
   * One Part = one chat turn, then two kinds of repair in the same session:
   *  - HARD (import validator / Blueprint lock): repeated up to maxRepairs;
   *    the Part fails only if these never pass.
   *  - SOFT editorial QA (draftEditorialQualityRules + a video-grounded critic
   *    turn): up to vertexSeriesQualityRepairs rounds; whatever remains is
   *    reported as warnings and the last import-valid script is kept.
   */
  async runPart({ scriptId, prompt, baseTurns, blueprint, model, resultDir, onProgress, maxRepairs, percent, importContext = null, quality = null }) {
    const filename = `script-${scriptId}.json`;
    const outputPath = path.join(resultDir, filename);
    const turns = [...baseTurns, userTurn(prompt)];
    let lastErrors = [];
    let accepted = null;
    let hardRounds = 0;
    let qualityRounds = 0;
    let criticRuns = 0;
    const qualityLimit = quality ? Math.max(0, num(this.settings.vertexSeriesQualityRepairs, 1)) : 0;
    const criticEnabled = Boolean(quality) && this.settings.vertexSeriesEditorialCritic !== false;
    const finish = async (candidate, warnings) => {
      await writeJson(outputPath, candidate.script); // a failed later repair must not leave its file behind
      return { ...candidate, warnings };
    };
    for (let round = 0; ; round += 1) {
      const startedAt = Date.now();
      const result = await this.call({ label: round ? `SCRIPT_${scriptId}_REPAIR_${round}` : `SCRIPT_${scriptId}`, turns, model, onProgress, percent });
      const modelTurn = result.content || { role: "model", parts: [{ text: result.text }] };
      let script = null;
      try {
        const raw = parseGeminiJsonObject(result.text, filename);
        const candidate = raw?.artifacts?.[0]?.script || raw;
        const normalized = require("./manualAntigravityStage1Service").normalizeArtifact({ filename, script: { ...candidate, scriptId: Number(candidate?.scriptId ?? candidate?.script_id) || scriptId } });
        script = Bridge.applyBlueprintToScript(normalized.script, blueprint).script;
      } catch (error) {
        const said = String(result.text || "").replace(/\s+/g, " ").trim();
        lastErrors = [said.length < 600 ? `${filename}: model không trả JSON mà trả lời: «${said}»` : `${filename}: ${error.message}`];
      }
      let inspection = null;
      if (script) {
        await writeJson(outputPath, script);
        [inspection] = await inspectGeminiJsonFiles([outputPath]);
        lastErrors = [];
        if (!inspection?.validJson || !ACCEPTED_TYPES.has(inspection.type) || !(inspection.segmentCount > 0)) {
          lastErrors.push(`${filename} không đạt schema variant: ${inspection?.error || inspection?.type || "segments trống"}.`);
        }
        lastErrors.push(...Serial.validateScriptAgainstBlueprint(script, blueprint).errors);
        if (!lastErrors.length && importContext) {
          // The import's editorial contract (sustained beats, SRT-complete endings, duration window...).
          lastErrors.push(...ImportPreflight.preflightSeriesScript({ ...importContext, script, jsonPath: outputPath }).errors.map((error) => `Import: ${error}`));
        }
      }

      if (!script || lastErrors.length) {
        if (hardRounds >= maxRepairs) {
          if (accepted) {
            this.emit(onProgress, percent, `[${this.tag}] ${filename}: bản sửa QA không qua kiểm tra nhập; giữ bản hợp lệ trước đó.`);
            return finish(accepted, accepted.qualityWarnings);
          }
          return { scriptId, outputPath, failed: true, errors: lastErrors };
        }
        hardRounds += 1;
        this.emit(onProgress, percent, `[${this.tag}] ${filename} chưa khớp Blueprint (${lastErrors.slice(0, 2).join(" | ")}). Yêu cầu sửa trong cùng phiên...`);
        turns.push(modelTurn);
        turns.push(userTurn([
          `RecapTool Studio's import validator rejected ${filename}:`,
          ...lastErrors.slice(0, 15).map((error) => `- ${error}`),
          `Keep the locked series-blueprint.json. Return the complete corrected ${filename} as exactly ONE JSON object. Do not output other Parts.`
        ].join("\n")));
        continue;
      }

      // Import-valid. Editorial QA.
      // Tool: facts it can compute. Gemini (editor turn, watching the video): every judgement.
      const findings = quality ? Quality.checkScript({ script, manifest: quality.manifest, words: quality.words, options: quality.options }).findings : [];
      let critic = [];
      if (criticEnabled && qualityRounds < qualityLimit && criticRuns < 1 + qualityLimit) {
        criticRuns += 1;
        critic = await this.runCritic({
          label: `SCRIPT_${scriptId}_CRITIC`, turns: [...turns, modelTurn], model, onProgress, percent,
          prompt: [EditorialRules.criticPrompt(filename), Quality.scriptEvidence({ script, transcriptSrt: quality.transcriptSrt, words: quality.words })].filter(Boolean).join("\n\n")
        });
      }
      const qa = [...findings, ...critic];
      accepted = { scriptId, outputPath, script, inspection, rounds: round + 1, turnPair: [userTurn(prompt), modelTurn], qualityWarnings: Quality.formatFindings(qa, 20) };
      if (!qa.length || qualityRounds >= qualityLimit) {
        this.emit(onProgress, percent, `[${this.tag}] ${filename} OK (${script.segments?.length || 0} segment, ${seconds(Date.now() - startedAt)}${round ? `, sau ${round} lượt sửa` : ""}${qa.length ? `; còn ${qa.length} cảnh báo biên tập` : ""}).`);
        return finish(accepted, accepted.qualityWarnings);
      }
      qualityRounds += 1;
      this.emit(onProgress, percent, `[${this.tag}] ${filename} QA biên tập: ${qa.length} lỗi (${qa.slice(0, 2).map((f) => f.rule).join(", ")}). Yêu cầu sửa trong cùng phiên...`);
      turns.push(modelTurn);
      turns.push(userTurn([
        `Review of ${filename} (tool facts + your own editor review):`,
        ...Quality.formatFindings(qa, 16).map((line) => `- ${line}`),
        "Re-watch the cited source ranges and fix them. Keep the locked series-blueprint.json, every mustInclude chapterBeat, sustained beats intact, and the Part duration window.",
        `Return the complete corrected ${filename} as exactly ONE JSON object. Do not output other Parts.`
      ].join("\n")));
    }
  }

  /**
   * Video-grounded editor pass in the SAME cached session: catches what text
   * rules cannot (dialogue/captions under VO that the SRT missed, VO naming an
   * event the bed does not show, who a line refers to, hook energy).
   * Returns findings; never throws (QA must not fail a valid Part).
   */
  async runCritic({ label, turns, model, onProgress, percent, prompt }) {
    try {
      const result = await this.call({
        label, model, onProgress, percent, temperature: 0.1,
        turns: [...turns, userTurn(prompt)]
      });
      const parsed = parseGeminiJsonObject(result.text, `${label.toLowerCase()}.json`);
      const list = Array.isArray(parsed?.violations) ? parsed.violations : [];
      return list.filter((v) => v && txtOf(v.fix || v.evidence)).slice(0, 10).map((v) => ({
        rule: `CRITIC_${String(v.rule || "EDIT").toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 40)}`,
        severity: "major",
        segment: Number(v.segment) || null,
        message: `${v.part ? `Part ${v.part}: ` : ""}${v.segment ? `Segment ${v.segment}: ` : ""}${txtOf(v.evidence)}${v.fix ? ` FIX: ${txtOf(v.fix)}` : ""}`.slice(0, 600)
      }));
    } catch (error) {
      this.emit(onProgress, percent, `[${this.tag}] ${label} bỏ qua (${String(error.message || error).slice(0, 120)}).`);
      return [];
    }
  }

  async run({ packageDir, onProgress } = {}) {
    const startedAt = Date.now();
    const root = path.resolve(String(packageDir || ""));
    let info = JSON.parse(await fs.readFile(path.join(root, "package-info.json"), "utf8"));
    const originalPromptPath = existingPath(info.promptPath, path.join(root, "01-GUI-GEMINI", "01-gemini-highlight-scripts-prompt.txt"));
    const originalPrompt = originalPromptPath ? await fs.readFile(originalPromptPath, "utf8").catch(() => "") : "";
    if (!VertexSeriesStage1Service.isApplicable(info, this.settings, originalPrompt)) throw new Error("Gói này không dùng Series tuần tự.");
    if (info.sequentialSeriesEnabled !== true) info = await this.upgradePackageToSeries({ root, info, promptText: originalPrompt, onProgress });
    const resultDir = path.join(root, RESULT_DIR);
    // Every model answer of this run, verbatim, for diagnosis and provider comparison.
    this.rawDir = path.join(resultDir, "raw-turns");
    await fs.rm(this.rawDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(resultDir, { recursive: true });
    for (const name of ["series-blueprint.json", ...PART_IDS.map((id) => `script-${id}.json`)]) await fs.rm(path.join(resultDir, name), { force: true });

    const { pass1Dir, videos, texts } = await collectChatInputs(root, info);
    const manifestPath = existingPath(info.manifestPath, path.join(pass1Dir, "scene-manifest.json"));
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const chunkManifest = await fs.readFile(existingPath(info.proxyChunksManifestPath, path.join(pass1Dir, "proxy-chunks-manifest.json")), "utf8").then(JSON.parse).catch(() => null);
    const hookContract = await fs.readFile(path.join(root, "01-GUI-GEMINI", "hook-contract.json"), "utf8").then(JSON.parse).catch(() => null);
    const ctx = { manifest, profile: info.sequentialSeriesProfile, sharedHook: info.sequentialSeriesSharedHook === true, hookContract };
    const transcriptSrt = await fs.readFile(existingPath(info.transcriptPath, path.join(pass1Dir, "source-transcript.srt")), "utf8").catch(() => "");
    const sourceEvidence = await fs.readFile(path.join(root, "scene-evidence.json"), "utf8").then(JSON.parse).catch(() => null);
    const transcriptPath = existingPath(info.transcriptPath, path.join(pass1Dir, "source-transcript.srt"));
    const wordsJson = transcriptPath ? await fs.readFile(transcriptPath.replace(/\.[^.\\/]+$/, ".words.json"), "utf8").then(JSON.parse).catch(() => null) : null;
    const preciseWords = Array.isArray(wordsJson?.segments) ? wordsJson.segments.flatMap((segment) => segment.words || []) : null;
    const qualityEnabled = this.settings.vertexSeriesQualityRules !== false;
    const voWordsPerSec = await this.resolveVoWordsPerSec();
    const quality = qualityEnabled ? { manifest, transcriptSrt, words: preciseWords, options: { voWordsPerSec } } : null;

    const promptPath = existingPath(info.promptPath, path.join(pass1Dir, "01-gemini-highlight-scripts-prompt.txt"));
    let blueprintPrompt = await fs.readFile(promptPath, "utf8");
    if (!/SERIES BLUEPRINT ONLY/.test(blueprintPrompt)) blueprintPrompt = Serial.blueprintPrompt(blueprintPrompt);
    if (qualityEnabled) blueprintPrompt = EditorialRules.appendIfMissing(blueprintPrompt, EditorialRules.blueprintRules(), EditorialRules.BLUEPRINT_MARKER);
    const nextDir = existingPath(info.sequentialSeriesNextStepsDir, path.join(root, "02-SERIES-SEQUENTIAL"));
    // A transport that holds ONE linear conversation (Gemini Web) cannot run Parts in parallel.
    const partMode = this.settings.vertexSeriesPartMode === "sequential" || this.vertex.mode === "linear" ? "sequential" : "parallel";
    const partPrompts = {};
    for (const id of PART_IDS) {
      const file = nextDir ? path.join(nextDir, `script-${id}-NEXT-PROMPT.txt`) : "";
      let text = file && fsSync.existsSync(file) ? await fs.readFile(file, "utf8") : Serial.partPrompt(id, info.sequentialSeriesProfile, info.sequentialSeriesSharedHook === true);
      // Packages written before the review-driven rules get them appended here.
      if (qualityEnabled) text = EditorialRules.appendIfMissing(EditorialRules.upgradeLegacyPartPrompt(text), EditorialRules.partRules(), EditorialRules.PART_MARKER);
      if (partMode === "parallel") {
        text += "\n\nPARALLEL GENERATION NOTE: the other Parts are being written at the same time from the SAME locked series-blueprint.json. Use only THIS Part's hook, chapterBeats and storyScope; never narrate or reuse footage assigned to another Part.";
      }
      partPrompts[id] = text;
    }
    const importContexts = {};
    for (const id of PART_IDS) {
      importContexts[id] = this.settings.vertexSeriesImportPreflight === false ? null : {
        manifest, hookContract, transcriptSrt, sourceEvidence,
        promptOptions: ImportPreflight.buildPromptOptions({ packageInfo: info, partPromptText: partPrompts[id], mainPromptText: blueprintPrompt })
      };
    }

    this.emit(onProgress, 3, `[${this.tag}] START: phiên nhiều lượt giống Gemini chat (Blueprint -> Script 1, 3, 4 ${partMode === "parallel" ? "song song" : "tuần tự"}); ${videos.length} video + ${texts.length} file văn bản.`);
    const { model, source: modelSource } = await this.resolveModel(onProgress);
    this.emit(onProgress, 5, `[${this.tag}] Model: ${model}${modelSource === "auto" ? " (tự chọn bản Pro mới nhất có trong project)" : ""}.`);

    const timings = {};
    let mark = Date.now();
    this.sourceParts = await this.buildSourceParts({ videos, texts, chunkManifest, onProgress });
    timings.prepareMs = Date.now() - mark;

    mark = Date.now();
    if (this.settings.vertexSeriesContextCache !== false) {
      const cache = await this.vertex.createCacheFromParts({ parts: this.sourceParts, model, ttlSeconds: num(this.settings.vertexSeriesCacheTtlSec, 3600), signal: this.controller.signal });
      this.cacheName = cache.name || null;
      this.emit(onProgress, 22, this.cacheName
        ? `[${this.tag}] ${this.providerId === "vertex_ai" ? `Context cache sẵn sàng (${seconds(Date.now() - mark)}): video chỉ xử lý 1 lần cho mọi lượt.` : "Video sẽ được upload 1 lần ở tin nhắn đầu của cuộc chat."}`
        : `[${this.tag}] Không tạo được context cache (${String(cache.error || "?").slice(0, 160)}); gửi kèm nguồn ở mỗi lượt.`);
    }
    timings.cacheMs = Date.now() - mark;

    const maxRepairs = Math.max(0, num(this.settings.vertexSeriesMaxRepairs, 2));
    try {
      mark = Date.now();
      this.emit(onProgress, 25, `[${this.tag}] Lượt 0: series-blueprint.json (Stage 0)...`);
      const bp = await this.runBlueprint({ prompt: blueprintPrompt, model, ctx, onProgress, maxRepairs, quality });
      const draftPath = path.join(resultDir, "series-blueprint.json");
      await writeJson(draftPath, bp.blueprint);
      const locked = await Serial.importBlueprint({ packageDir: root, blueprintPath: draftPath });
      timings.blueprintMs = Date.now() - mark;
      this.emit(onProgress, 48, `[SERIES_BLUEPRINT] LOCKED: ${locked.seriesBlueprintPath} (seriesId ${locked.seriesId}; ${bp.rounds} lượt, ${seconds(timings.blueprintMs)}).`);

      mark = Date.now();
      const baseTurns = [userTurn(blueprintPrompt), bp.accepted];
      let results;
      if (partMode === "parallel") {
        results = await Promise.all(PART_IDS.map((scriptId, index) => this.runPart({
          scriptId, prompt: partPrompts[scriptId], baseTurns, blueprint: bp.blueprint, model, resultDir, onProgress, maxRepairs, percent: 55 + index * 12, importContext: importContexts[scriptId], quality
        })));
      } else {
        results = [];
        let history = baseTurns;
        for (const [index, scriptId] of PART_IDS.entries()) {
          const result = await this.runPart({ scriptId, prompt: partPrompts[scriptId], baseTurns: history, blueprint: bp.blueprint, model, resultDir, onProgress, maxRepairs, percent: 55 + index * 12, importContext: importContexts[scriptId], quality });
          results.push(result);
          if (result.failed) break;
          history = [...history, ...result.turnPair];
        }
      }
      timings.partsMs = Date.now() - mark;
      timings.totalMs = Date.now() - startedAt;

      const failures = results.filter((result) => result.failed);
      const usage = this.calls.reduce((sum, call) => ({
        inputTokens: sum.inputTokens + (call.usage?.inputTokens || 0),
        outputTokens: sum.outputTokens + (call.usage?.outputTokens || 0),
        cachedInputTokens: sum.cachedInputTokens + (call.usage?.cachedInputTokens || 0),
        estimatedCostUsd: Number((sum.estimatedCostUsd + (call.usage?.estimatedCostUsd || 0)).toFixed(6))
      }), { model, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, estimatedCostUsd: 0 });
      const files = results.filter((result) => !result.failed).map((result) => result.outputPath);
      const runInfo = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        provider: this.providerId,
        label: this.providerLabel,
        architecture: this.providerId === "vertex_ai" ? "vertex_series_session" : `${this.providerId}_series_session`,
        model,
        modelSource,
        partMode,
        contextCache: Boolean(this.cacheName),
        packageDir: root,
        seriesBlueprintPath: locked.seriesBlueprintPath,
        inputFiles: [...videos, ...texts],
        validFiles: failures.length ? [] : files,
        failures: failures.map((result) => ({ scriptId: result.scriptId, errors: result.errors })),
        editorialQa: {
          enabled: qualityEnabled,
          critic: qualityEnabled && this.settings.vertexSeriesEditorialCritic !== false,
          blueprintWarnings: bp.warnings || [],
          partWarnings: Object.fromEntries(results.filter((result) => !result.failed).map((result) => [`script-${result.scriptId}`, result.warnings || []]))
        },
        timings,
        calls: this.calls.map(({ label, attempt, ms, cached, finishReason, usage: callUsage }) => ({ label, attempt, ms, cached, finishReason, inputTokens: callUsage?.inputTokens, outputTokens: callUsage?.outputTokens })),
        usage
      };
      await writeJson(path.join(resultDir, "configured-ai-run-info.json"), runInfo);
      if (failures.length) {
        throw Object.assign(new Error(
          `[${this.tag}] ${failures.map((result) => `script-${result.scriptId}.json: ${result.errors.slice(0, 3).join(" | ")}`).join(" || ")}. `
          + `Bước Nhập Series sẽ từ chối bộ này nên GĐ1 dừng ở đây (đã tự sửa ${maxRepairs} lượt). Xem ${resultDir}.`
        ), { kind: "series_blueprint_mismatch" });
      }
      const inspections = results.map((result) => result.inspection);
      const qaLines = results.flatMap((result) => (result.warnings || []).map((line) => `script-${result.scriptId}: ${line}`));
      if (qaLines.length) this.emit(onProgress, 99, `[${this.tag}] QA biên tập còn ${qaLines.length} cảnh báo (đã tự sửa tối đa ${num(this.settings.vertexSeriesQualityRepairs, 1)} lượt): ${qaLines.slice(0, 3).join(" | ").slice(0, 600)}`);
      this.emit(onProgress, 100, `[${this.tag}] DONE ${seconds(timings.totalMs)} (chuẩn bị ${seconds(timings.prepareMs)}, cache ${seconds(timings.cacheMs)}, Blueprint ${seconds(timings.blueprintMs)}, 3 Part ${seconds(timings.partsMs)}) · ước tính $${usage.estimatedCostUsd.toFixed(4)}`);
      return {
        resultDir,
        files,
        validFiles: files,
        inspections,
        warnings: [
          ...(bp.warnings || []).map((line) => `Blueprint: ${line}`),
          ...results.flatMap((result) => (result.warnings || []).map((line) => `script-${result.scriptId}: ${line}`))
        ],
        usage,
        timings,
        budget: await this.vertex.budgetStatus(),
        seriesBlueprintPath: locked.seriesBlueprintPath,
        provider: this.providerId,
        label: this.providerLabel,
        model,
        partMode
      };
    } finally {
      if (this.cacheName && this.settings.vertexSeriesKeepCache !== true) await this.vertex.deleteCachedContent(this.cacheName);
    }
  }
}

VertexSeriesStage1Service.collectChatInputs = collectChatInputs;
VertexSeriesStage1Service.MODEL_CANDIDATES = MODEL_CANDIDATES;
VertexSeriesStage1Service.RESULT_DIR = RESULT_DIR;
VertexSeriesStage1Service.resetModelCache = () => resolvedModels.clear();

module.exports = VertexSeriesStage1Service;
