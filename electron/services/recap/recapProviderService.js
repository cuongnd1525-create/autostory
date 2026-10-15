const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const VertexAiService = require("../vertexAiService");
const GeminiService = require("../geminiService");
const AntigravityService = require("../manualAntigravityStage1Service");
const ModelCatalog = require("../../../src/antigravityModelCatalog");
const ModelDiscovery = require("../antigravityModelDiscovery");

function validateResponse(value, schema, location = "response") {
  if (!schema) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AI response must be a JSON object.");
    return value;
  }
  const type = schema.type;
  if ((type === "object" && (!value || typeof value !== "object" || Array.isArray(value)))
    || (type === "array" && !Array.isArray(value))
    || (["string", "boolean", "number"].includes(type) && typeof value !== type)
    || (type === "number" && !Number.isFinite(value))
    || (type === "integer" && !Number.isInteger(value))) throw new Error(`AI JSON: invalid ${location} (${type}).`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`AI JSON: invalid ${location}.`);
  if (type === "object") {
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) throw new Error(`AI JSON: missing ${location}.${key}.`);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) validateResponse(value[key], child, `${location}.${key}`);
    }
  } else if (type === "array" && schema.items) {
    if ((schema.minItems !== undefined && value.length < schema.minItems)
      || (schema.maxItems !== undefined && value.length > schema.maxItems)) throw new Error(`AI JSON: invalid ${location} array length.`);
    value.forEach((item, index) => validateResponse(item, schema.items, `${location}[${index}]`));
  }
  return value;
}

function parseCliJson(stdout, schema) {
  const candidates = [stdout];
  const deltas = new Map();
  for (const line of String(stdout || "").split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      for (const text of [event.result?.response, event.result?.text, event.response, event.content, event.step_update?.content]) {
        if (typeof text === "string") candidates.push(text);
      }
      const step = event.step_update;
      if (typeof step?.text_delta === "string") {
        const key = `${step.conversation_id || ""}:${step.step_index ?? ""}`;
        deltas.set(key, (deltas.get(key) || "") + step.text_delta);
      }
    } catch (_) { /* stream lines need not be complete JSON */ }
  }
  candidates.push(...deltas.values());
  for (const text of candidates.reverse()) {
    try {
      const cleaned = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      const value = JSON.parse(cleaned);
      if (value.event || value.step_update) continue;
      return validateResponse(value, schema);
    } catch (_) { /* only accept a complete response matching the requested schema */ }
  }
  throw new Error("Antigravity không trả JSON recap đầy đủ theo schema; không sử dụng object con hoặc response bị cắt.");
}

class RecapProviderService {
  constructor(settings = {}, dependencies = {}) {
    this.settings = settings;
    this.provider = settings.aiProvider || settings.defaultAiProvider || "vertex_ai";
    this.dependencies = dependencies;
    this.removeTempDirectory = dependencies.removeTempDirectory || ((folder, options) => fs.rm(folder, options));
    this.scheduleCleanup = dependencies.scheduleCleanup || ((callback, delay) => setTimeout(callback, delay));
    this.logger = dependencies.logger || console;
    this.label = { vertex_ai: "Vertex AI", gemini: "Gemini", antigravity_cli: "Antigravity CLI" }[this.provider];
    if (!this.label) throw new Error(`Tóm tắt phim (AI) chưa hỗ trợ provider "${this.provider}". Hãy chọn Vertex AI, Gemini hoặc Antigravity CLI.`);
  }

  getModel(quality = false) {
    if (this.provider === "vertex_ai") return quality
      ? this.settings.vertexQualityModel || "gemini-2.5-pro"
      : this.settings.vertexAnalysisModel || "gemini-2.5-flash";
    if (this.provider === "gemini") return this.settings.geminiModel || "gemini-2.5-pro";
    const configured = this.settings.antigravityModel || "";
    const parsed = ModelCatalog.parseModel(configured, this.settings.antigravityReasoning || "high");
    // Visual indexing needs grounded observation, not prolonged editorial reasoning.
    // Keep the selected family, and keep its configured level for writing/review.
    if (!quality && parsed.known && /-flash$/.test(parsed.familyId)) {
      return ModelCatalog.resolveModel(parsed.familyId, this.settings.recapAnalysisReasoning || "low");
    }
    return configured;
  }

  getFallbackModels(initialModel = "") {
    if (this.provider === "vertex_ai") {
      const configured = [this.getModel(false), this.getModel(true)];
      return configured.includes(initialModel) ? [...new Set([initialModel, ...configured])].filter(Boolean) : [initialModel];
    }
    if (this.provider !== "antigravity_cli") return [initialModel];
    return this.availableModels ? this.availablePlan(initialModel) : [initialModel];
  }
  getModelFamily(model) { return this.availableModels?.find((entry) => entry.value === model)?.familyId || ModelCatalog.parseModel(model).familyId || model; }

  availablePlan(initialModel, { video = false, excluded = [] } = {}) {
    const parsed = ModelCatalog.parseModel(initialModel, this.settings.antigravityReasoning || "high");
    const level = ["low", "medium", "high"].includes(parsed.reasoning) ? parsed.reasoning : video ? "low" : "high";
    const available = this.availableModels.filter((entry) => !excluded.includes(entry.value) && (!video || /^gemini-/.test(entry.familyId)));
    const preferred = available.find((entry) => entry.value === initialModel || (entry.familyId === parsed.familyId && entry.reasoning === level));
    const families = [...new Set(available.map((entry) => entry.familyId))];
    const others = families.filter((family) => family !== preferred?.familyId).map((family) => {
      const entries = available.filter((entry) => entry.familyId === family);
      return entries.find((entry) => entry.reasoning === level) || entries.find((entry) => entry.reasoning === "high") || entries[0];
    });
    const levelOrder = level === "low" ? ["low", "medium", "high"] : level === "medium" ? ["medium", "low", "high"] : ["high", "medium", "low"];
    const sameFamily = available.filter((entry) => entry.familyId === (preferred?.familyId || others[0]?.familyId))
      .sort((a, b) => levelOrder.indexOf(a.reasoning) - levelOrder.indexOf(b.reasoning));
    const order = preferred ? [preferred, ...others, ...sameFamily] : [...others, ...sameFamily];
    if (!order.length) throw Object.assign(new Error(video ? "Antigravity không có model Gemini khả dụng cho phân tích video. Hãy chọn Vertex AI/Gemini API hoặc thử lại khi CLI có model video." : "Antigravity không còn model khả dụng. Tải lại danh sách model."), { kind: "no_available_model" });
    return [...new Set(order.map((entry) => entry.value))].slice(0, 3);
  }

  async prepareModels(initialModel, { filePaths = [], signal, onProgress, force = false, excluded = [] } = {}) {
    if (this.provider !== "antigravity_cli") return this.getFallbackModels(initialModel);
    if (!this.availableModels || force) this.availableModels = await (this.dependencies.modelDiscovery || ModelDiscovery).list(this.settings, { signal, force });
    const models = this.availablePlan(initialModel, { video: filePaths.some((file) => /\.(mp4|mov|webm|mkv|avi|m4v|png|jpe?g|webp)$/i.test(file)), excluded });
    if (models[0] !== initialModel) onProgress?.({ level: initialModel ? "WARNING" : "INFO", message: `Chọn ${models[0]} từ danh sách CLI hiện tại${initialModel ? `; model đã lưu ${initialModel} không khả dụng cho bước này` : ""}.` });
    return models;
  }

  async generateJsonFromFiles(options) {
    options.signal?.throwIfAborted();
    const aiStartedAt = Date.now();
    const originalProgress = options.onProgress;
    const onProgress = (value) => {
      try { originalProgress?.({ providerLabel: this.label, model: options.modelOverride || this.getModel(), aiStartedAt, ...value }); }
      catch (_) { /* A closed renderer must not discard a successful AI result. */ }
    };
    onProgress({ aiRequestStarted: true, heartbeat: true, step: "recap_ai" });
    // HTTP providers may return no intermediate data. A heartbeat says only that
    // the request is pending; it must never imply a new response from the model.
    const timer = this.provider === "antigravity_cli" ? null : setInterval(() =>
      onProgress({ heartbeat: true, step: "recap_ai" }), 5000);
    options = { ...options, onProgress };
    let succeeded = false;
    try {
      const response = await this.generateJsonResponse(options); succeeded = true; return response;
    } finally {
      clearInterval(timer);
      const elapsedMs = Date.now() - aiStartedAt;
      onProgress({ aiRequestFinished: true, heartbeat: !succeeded, step: "recap_ai", elapsedMs,
        ...(succeeded ? { message: `${this.label} hoàn tất lượt AI trong ${(elapsedMs / 1000).toFixed(1)} giây.` } : {}) });
    }
  }

  async generateJsonResponse(options) {
    if (this.provider === "vertex_ai") {
      this.vertex ||= this.dependencies.vertex || new VertexAiService(this.settings);
      const bounded = Number(this.settings.recapVertexMaxOutputTokens) > 0
        ? { maxOutputTokens: Math.round(Number(this.settings.recapVertexMaxOutputTokens)),
          ...(/gemini-2\.5-flash/.test(options.modelOverride || this.getModel()) ? { thinkingBudget: 0 } : {}) } : {};
      return validateResponse(await this.vertex.generateJsonFromFiles({ ...bounded, ...options }), options.responseSchema);
    }
    if (this.provider === "gemini") {
      const gemini = this.dependencies.gemini || new GeminiService(this.settings.geminiApiKey, options.modelOverride || this.getModel());
      const prompt = `${options.prompt}\nReturn one complete JSON object matching this schema:\n${JSON.stringify(options.responseSchema)}`;
      return validateResponse(await gemini.generateJsonFromFiles({ ...options, prompt }), options.responseSchema);
    }
    return this.runAntigravity(options);
  }

  async runAntigravity({ filePaths = [], prompt, responseSchema, signal, onProgress, modelOverride, requestTimeoutMs }) {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "recap-ai-"));
    const delegate = this.dependencies.antigravityFactory?.() || new AntigravityService(this.settings);
    const abort = () => delegate.cancel();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      const files = filePaths.map((file) => path.resolve(file));
      const requestPath = path.join(folder, "request.txt");
      await fs.writeFile(requestPath, [
        prompt,
        "INPUT FILES (inspect the actual content of every supplied video with view_file):",
        JSON.stringify(files),
        "Use read-only inspection. Do not create scripts, modify files, or run shell commands.",
        "Return the complete JSON object as your final response, with no prose or plan. Do not write the result to disk.",
        "Use compact JSON without indentation. Keep descriptions concise and omit unused optional fields. Do not repeat the schema in the response.",
        "JSON SCHEMA:", JSON.stringify(responseSchema)
      ].join("\n"), "utf8");
      const cliPrompt = `Read ${JSON.stringify(requestPath)} with view_file, inspect every listed input, then complete that recap task. Return only its requested JSON object.`;
      const config = delegate.buildCommand(cliPrompt, "", folder, { modelOverride,
        ...(requestTimeoutMs ? { timeoutMs: requestTimeoutMs } : {}) });
      onProgress?.({ message: `Model cho lượt này: ${modelOverride || this.settings.antigravityModel || "mặc định CLI"}.` });
      for (const directory of new Set(files.map((file) => path.dirname(file)))) config.args.push("--add-dir", directory);
      const expectedProxyList = files.filter((file) => /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(file))
        .map((file) => ({ filename: path.basename(file), absolutePath: file }));
      let result;
      try {
        result = await delegate.runCli({ ...config, prompt: cliPrompt, cwd: folder, onProgress,
          progressStep: "recap_ai", reportHeartbeat: true, expectedProxyList, forbiddenTools: ["run_command", "write_to_file", "replace_file_content", "multi_replace_file_content"] });
      } catch (error) {
        // A CLI print timeout can accompany a complete final object. Recover
        // only a full schema-valid JSON after verified video coverage.
        if (signal?.aborted) throw error;
        if (/timeout/.test(error.kind || "") && expectedProxyList.length && error.viewedProxySet &&
          !AntigravityService.validateVideoCoverage(expectedProxyList, error.viewedProxySet).totalViewed) {
          throw Object.assign(new Error("Antigravity hết thời gian chờ trước khi bắt đầu xem video. Dừng thử các mức suy luận cùng dòng model; checkpoint được giữ để tiếp tục khi dịch vụ hoạt động."), { kind: "provider_unavailable", cause: error });
        }
        if (error.kind !== "print_timeout" || error.stats?.promptBlocked || error.stats?.resultStatus === "ERROR") throw error;
        const coverage = AntigravityService.validateVideoCoverage(expectedProxyList, error.viewedProxySet || new Set());
        let recovered;
        try { if (coverage.isComplete) recovered = parseCliJson(error.stdout, responseSchema); } catch (_) { /* never accept truncated JSON */ }
        if (!recovered) throw error;
        onProgress?.({ message: "CLI hết thời gian chờ nhưng đã trả JSON đầy đủ và xem đủ video; giữ kết quả hợp lệ." });
        return recovered;
      }
      signal?.throwIfAborted();
      const coverage = AntigravityService.validateVideoCoverage(expectedProxyList, result.viewedProxySet);
      if (!coverage.isComplete) throw new Error("Antigravity chưa xem đủ video đầu vào recap; không sử dụng kết quả suy đoán từ tên file.");
      return parseCliJson(result.stdout, responseSchema);
    } finally {
      signal?.removeEventListener("abort", abort);
      await this.cleanupRequestFolder(folder, onProgress);
    }
  }

  async cleanupRequestFolder(folder, onProgress) {
    // Only remove the exact request directory created by this provider. In
    // particular, never sweep the user's temp directory or another AI run.
    const target = path.resolve(folder);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !/^recap-ai-[A-Za-z0-9]+$/.test(path.basename(target))) {
      this.reportCleanupWarning("Bỏ qua đường dẫn dọn thư mục recap không hợp lệ.", onProgress);
      return;
    }
    try {
      await this.removeTempDirectory(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch (error) {
      // Windows can retain a directory handle after the CLI parent closes.
      // Cleanup must preserve both a successful JSON result and the original
      // CLI/schema/cancellation error; it must never trigger another paid call.
      this.reportCleanupWarning(`Chưa dọn được thư mục tạm recap (${error.code || "cleanup_failed"}); sẽ thử dọn nền. Kết quả/lỗi AI được giữ nguyên.`, onProgress);
      this.deferRequestCleanup(target, 0);
    }
  }

  reportCleanupWarning(message, onProgress) {
    // A closed renderer or logging callback must not mask the AI result either.
    try { onProgress?.({ level: "WARNING", message }); } catch (_) {}
    try { this.logger.warn?.(`[Recap][Cleanup] ${message}`); } catch (_) {}
  }

  deferRequestCleanup(folder, attempt) {
    try {
      const timer = this.scheduleCleanup(async () => {
        try {
          await this.removeTempDirectory(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
        } catch (error) {
          if (attempt < 1) this.deferRequestCleanup(folder, attempt + 1);
          else this.reportCleanupWarning(`Thư mục tạm recap vẫn bị khóa (${error.code || "cleanup_failed"}); kết thúc lượt dọn nền.`);
        }
      }, attempt === 0 ? 5000 : 30000);
      timer?.unref?.();
    } catch (error) {
      this.reportCleanupWarning(`Không lên lịch được lượt dọn thư mục recap (${error.code || "cleanup_failed"}).`);
    }
  }
}

module.exports = RecapProviderService;
module.exports.parseCliJson = parseCliJson;
module.exports.validateResponse = validateResponse;
