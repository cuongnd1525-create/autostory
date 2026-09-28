const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { Agent } = require("undici");

const TOKEN_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const INLINE_FILE_LIMIT = 12 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function buildDispatcherOptions(timeoutMs = DEFAULT_TIMEOUT_MS) {
  const requestTimeoutMs = Math.max(30000, Number(timeoutMs || DEFAULT_TIMEOUT_MS));
  return {
    connectTimeout: Math.min(60000, requestTimeoutMs),
    headersTimeout: requestTimeoutMs + 30000,
    bodyTimeout: requestTimeoutMs + 30000,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 750
  };
}

function safeText(value = "") {
  return String(value || "").trim();
}

function normalizeBucketName(value = "") {
  return safeText(value)
    .replace(/^gs:\/\//i, "")
    .replace(/^https?:\/\/storage\.googleapis\.com\//i, "")
    .split("/")[0]
    .trim();
}

function buildMediaObjectName(filePath, stat = {}) {
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({
    path: path.resolve(filePath).toLowerCase(),
    size: Number(stat.size || 0),
    mtimeMs: Math.round(Number(stat.mtimeMs || 0))
  })).digest("hex").slice(0, 24);
  const fileName = path.basename(filePath).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `cineviral-cache/v2/${fingerprint}-${fileName}`;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function fetchFailureMessage(error, label, url) {
  const cause = error?.cause || error || {};
  const code = safeText(cause.code || cause.errno);
  const detail = safeText(cause.message || error?.message || "unknown network error");
  let host = "Google Cloud";
  try {
    host = new URL(url).host;
  } catch (_error) {
    // Keep the generic host label.
  }
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) {
    return `${label} không phân giải được DNS của ${host} (${code}). `
      + "Đây thường là lỗi mạng/DNS tạm thời; hãy kiểm tra Internet, VPN hoặc DNS của Windows rồi thử lại. "
      + `Chi tiết: ${detail}`;
  }
  return `${label} không kết nối được tới ${host}${code ? ` (${code})` : ""}: ${detail}`;
}

function fetchErrorCode(error) {
  return safeText(error?.cause?.code || error?.cause?.errno || error?.code || error?.errno);
}

function shouldRetryFetchError(error, retryCodes = null) {
  if (error?.name === "AbortError") return false;
  if (!Array.isArray(retryCodes)) return true;
  return retryCodes.includes(fetchErrorCode(error));
}

async function fetchWithRetry(url, optionsFactory, {
  label = "Vertex AI",
  attempts = 3,
  retryCodes = null,
  retryDelayMs = 500,
  onRetry = null
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const options = typeof optionsFactory === "function" ? optionsFactory(attempt) : optionsFactory;
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (!shouldRetryFetchError(error, retryCodes) || attempt >= attempts) break;
      const delayMs = retryDelayMs * (2 ** (attempt - 1));
      onRetry?.({ attempt, nextAttempt: attempt + 1, delayMs, code: fetchErrorCode(error) });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(fetchFailureMessage(lastError, label, url), { cause: lastError });
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function inferMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".webm": "video/webm",
    // Vertex Gemini accepts these package artifacts as plain text input.
    // application/json is valid for the HTTP request body, but not as a
    // Gemini fileData/inlineData media MIME type.
    ".json": "text/plain",
    ".txt": "text/plain",
    ".srt": "text/plain",
    ".vtt": "text/plain",
    ".csv": "text/plain",
    ".md": "text/plain",
    ".log": "text/plain",
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg"
  })[extension] || "application/octet-stream";
}

function parseFirstJsonValue(rawText) {
  const raw = String(rawText || "");
  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== "{" && raw[start] !== "[") continue;
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
      else if (char === "}" || char === "]") {
        if (stack.at(-1) !== char) break;
        stack.pop();
        if (!stack.length) {
          try {
            return JSON.parse(raw.slice(start, index + 1));
          } catch (_error) {
            break;
          }
        }
      }
    }
  }
  return null;
}

function extractResponseText(payload = {}) {
  return (payload.candidates || []).flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n")
    .trim();
}

function formatVertexApiError(status, rawBody, projectId) {
  let payload = null;
  try {
    payload = JSON.parse(String(rawBody || ""));
  } catch (_error) {
    // Preserve non-JSON provider errors below.
  }
  const detailStr = payload?.error?.details ? ` - ${JSON.stringify(payload.error.details)}` : '';
  const message = safeText(payload?.error?.message || rawBody || `HTTP ${status}`) + detailStr;
  if (status === 403 && message.includes("aiplatform.endpoints.predict")) {
    return new Error(
      `Vertex AI đã xác thực nhưng service account chưa có quyền chạy model trong project "${projectId}". `
      + "Hãy vào Google Cloud Console > IAM, cấp role Vertex AI User (roles/aiplatform.user) cho client_email trong file service account JSON, đợi 1-2 phút rồi kiểm tra lại."
    );
  }
  if (status === 403 && /SERVICE_DISABLED|has not been used|API.*disabled/i.test(message)) {
    return new Error(`Vertex AI API chưa được bật trong project "${projectId}". Hãy bật aiplatform.googleapis.com rồi thử lại.`);
  }
  return Object.assign(new Error(`Vertex AI request failed (${status}): ${message}`), { httpStatus: status });
}

function vertexEndpoint(projectId, location, model) {
  const region = safeText(location || "global");
  const host = region === "global" ? "aiplatform.googleapis.com" : `${region}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
}

function pricingForModel(model = "", inputTokens = 0) {
  const value = safeText(model).toLowerCase();
  if (value.includes("3.1-pro")) return { input: 2, output: 12 };
  if (value.includes("2.5-pro")) return inputTokens > 200000 ? { input: 2.5, output: 15 } : { input: 1.25, output: 10 };
  if (value.includes("3.6-flash") || value.includes("3.7-flash")) return { input: 0.75, output: 3.75 };
  if (value.includes("3.5-flash-lite")) return { input: 0.3, output: 2.5 };
  if (value.includes("3.1-flash-lite")) return { input: 0.25, output: 1.5 };
  if (value.includes("2.5-flash-lite")) return { input: 0.1, output: 0.4 };
  if (value.includes("2.5-flash")) return { input: 0.3, output: 2.5 };
  return { input: 0.75, output: 3.75 };
}

function estimateUsageCost(model, usageMetadata = {}) {
  const inputTokens = Number(usageMetadata.promptTokenCount || usageMetadata.prompt_token_count || 0);
  const price = pricingForModel(model, inputTokens);
  const outputTokens = Number(usageMetadata.candidatesTokenCount || usageMetadata.candidates_token_count || 0)
    + Number(usageMetadata.thoughtsTokenCount || usageMetadata.thoughts_token_count || 0);
  const isPro25 = safeText(model).toLowerCase().includes("2.5-pro");
  const cachedInputTokens = Math.min(inputTokens, Math.max(0, Number(usageMetadata.cachedContentTokenCount || 0)));
  const inputCost = isPro25
    ? ((inputTokens - cachedInputTokens) * price.input + cachedInputTokens * price.input * 0.1) / 1_000_000
    : inputTokens * price.input / 1_000_000;
  const outputCost = outputTokens * price.output / 1_000_000;
  return {
    model,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    pricingVersion: "2026-09-pro-long-context-v2",
    pricingTier: isPro25 && inputTokens > 200000 ? "long_context" : "standard",
    inputCostUsd: Number(inputCost.toFixed(6)),
    outputCostUsd: Number(outputCost.toFixed(6)),
    estimatedCostUsd: Number((inputCost + outputCost).toFixed(6)),
    pricePerMillionTokens: price
  };
}

function runCommand(command, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out while obtaining Vertex credentials.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
      else resolve(stdout.trim());
    });
  });
}

class VertexAiService {
  constructor(settings = {}) {
    this.settings = settings;
    this.projectId = safeText(settings.vertexProjectId || process.env.GOOGLE_CLOUD_PROJECT);
    this.location = safeText(settings.vertexLocation || process.env.GOOGLE_CLOUD_LOCATION || "global");
    this.credentialPath = safeText(settings.vertexCredentialPath || process.env.GOOGLE_APPLICATION_CREDENTIALS);
    this.bucket = normalizeBucketName(settings.vertexBucket);
    this.timeoutMs = Math.max(30000, Number(settings.vertexTimeoutMs || DEFAULT_TIMEOUT_MS));
    this.dispatcher = new Agent(buildDispatcherOptions(this.timeoutMs));
    this.accessToken = "";
    this.accessTokenExpiresAt = 0;
    this.lastUsage = null;
    this.lastTimings = null;
  }

  getModel(taskType = "quality") {
    const fields = require("./autoStoryCostPolicy").modelFields[taskType];
    if (fields) return safeText(this.settings[fields[0]]) || safeText(this.settings[fields[1]]) || fields[2];
    if (taskType === "economy" || taskType === "text_utility") {
      return safeText(this.settings.vertexEconomyModel || "gemini-2.5-flash-lite");
    }
    if (taskType === "stage1" || taskType === "video_analysis") {
      return safeText(this.settings.vertexAnalysisModel || "gemini-2.5-flash");
    }
    return safeText(this.settings.vertexQualityModel || "gemini-2.5-pro");
  }

  validateSettings() {
    if (!this.projectId) throw new Error("Vertex AI chưa có Google Cloud Project ID.");
    if (!this.credentialPath && !safeText(this.settings.vertexGcloudCommand || "gcloud")) {
      throw new Error("Vertex AI chưa có ADC hoặc file JSON service account.");
    }
  }

  async serviceAccountToken() {
    const credential = JSON.parse(await fs.readFile(this.credentialPath, "utf8"));
    if (credential.type !== "service_account" || !credential.client_email || !credential.private_key) {
      throw new Error("File Vertex credential không phải service-account JSON hợp lệ.");
    }
    if (!this.projectId) this.projectId = safeText(credential.project_id);
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = base64Url(JSON.stringify({
      iss: credential.client_email,
      scope: TOKEN_SCOPE,
      aud: credential.token_uri || "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600
    }));
    const unsigned = `${header}.${claim}`;
    const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), credential.private_key).toString("base64url");
    const tokenUrl = credential.token_uri || "https://oauth2.googleapis.com/token";
    const response = await fetchWithRetry(tokenUrl, () => ({
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`
      })
    }), { label: "Vertex authentication" });
    if (!response.ok) throw new Error(`Không lấy được Vertex access token: ${await response.text()}`);
    return response.json();
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60000) return this.accessToken;
    let tokenPayload;
    if (this.credentialPath) {
      tokenPayload = await this.serviceAccountToken();
    } else {
      const token = await runCommand(safeText(this.settings.vertexGcloudCommand || "gcloud"), ["auth", "application-default", "print-access-token"]);
      tokenPayload = { access_token: token, expires_in: 3000 };
    }
    this.accessToken = safeText(tokenPayload.access_token);
    this.accessTokenExpiresAt = Date.now() + (Number(tokenPayload.expires_in || 3000) * 1000);
    if (!this.accessToken) throw new Error("Vertex authentication không trả về access token.");
    return this.accessToken;
  }

  ledgerPath() {
    const configured = safeText(this.settings.vertexUsageLedgerPath);
    if (configured) return configured;
    const root = safeText(this.settings.workspaceRoot || process.cwd());
    return path.join(root, ".usage", "vertex-ai-usage.json");
  }

  async readLedger() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.ledgerPath(), "utf8"));
      return { schemaVersion: 1, entries: [], ...parsed };
    } catch (_error) {
      return { schemaVersion: 1, entries: [] };
    }
  }

  async budgetStatus() {
    const ledger = await this.readLedger();
    const today = new Date().toISOString().slice(0, 10);
    const totalSpentUsd = ledger.entries.reduce((sum, entry) => sum + Number(entry.estimatedCostUsd || 0), 0);
    const dailySpentUsd = ledger.entries.filter((entry) => safeText(entry.createdAt).startsWith(today))
      .reduce((sum, entry) => sum + Number(entry.estimatedCostUsd || 0), 0);
    return {
      totalSpentUsd: Number(totalSpentUsd.toFixed(6)),
      dailySpentUsd: Number(dailySpentUsd.toFixed(6)),
      budgetUsd: Math.max(0, Number(this.settings.vertexBudgetUsd || 240)),
      dailyLimitUsd: Math.max(0, Number(this.settings.vertexDailyLimitUsd || 5)),
      requestCount: ledger.entries.length
    };
  }

  async assertBudgetAvailable() {
    const status = await this.budgetStatus();
    if (status.budgetUsd && status.totalSpentUsd >= status.budgetUsd) {
      throw new Error(`Vertex AI đã đạt hard limit $${status.budgetUsd.toFixed(2)}. Hãy tăng hạn mức hoặc đổi provider.`);
    }
    if (status.dailyLimitUsd && status.dailySpentUsd >= status.dailyLimitUsd) {
      throw new Error(`Vertex AI đã đạt giới hạn hôm nay $${status.dailyLimitUsd.toFixed(2)}.`);
    }
    return status;
  }

  async recordUsage(usage, taskType) {
    return require("./autoStoryWorkQueue").serial(`usage:${path.resolve(this.ledgerPath())}`, () => this.recordUsageUnlocked(usage, taskType));
  }
  async recordUsageUnlocked(usage, taskType) {
    const ledgerPath = this.ledgerPath();
    const ledger = await this.readLedger();
    ledger.entries.push({ createdAt: new Date().toISOString(), taskType, projectId: this.projectId, ...usage });
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
    const tempPath = `${ledgerPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(ledger, null, 2), "utf8");
    await fs.rename(tempPath, ledgerPath).catch(async () => {
      await fs.rm(ledgerPath, { force: true });
      await fs.rename(tempPath, ledgerPath);
    });
  }

  async uploadToGcs(filePath, token, signal) {
    if (!this.bucket) {
      throw new Error(
        "Vertex AI cần Cloud Storage để đọc video/proxy. Vào Cài đặt > Model AI > Vertex AI, "
        + "nhập Cloud Storage bucket rồi chạy lại. Có thể nhập tên bucket hoặc gs://ten-bucket."
      );
    }
    const stat = await fs.stat(filePath);
    const objectName = buildMediaObjectName(filePath, stat);
    const metadataUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(objectName)}`;
    const exists = await fetchWithRetry(
      metadataUrl,
      { headers: { Authorization: `Bearer ${token}` }, signal },
      { label: "Kiểm tra Vertex media cache" }
    );
    if (exists.status !== 200) {
      const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
      const response = await fetchWithRetry(uploadUrl, () => ({
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": inferMimeType(filePath),
          "Content-Length": String(stat.size)
        },
        body: fsSync.createReadStream(filePath),
        duplex: "half",
        signal
      }), { label: `Upload ${path.basename(filePath)} lên Cloud Storage` });
      if (!response.ok) {
        const responseBody = await response.text();
        if (response.status === 403) {
          throw new Error(
            `Service account không có quyền ghi vào gs://${this.bucket}. `
            + "Hãy cấp role Storage Object User (roles/storage.objectUser) cho client_email trong file JSON tại bucket này."
          );
        }
        if (response.status === 404) {
          throw new Error(`Không tìm thấy bucket gs://${this.bucket}. Hãy kiểm tra tên bucket trong Cài đặt Vertex AI.`);
        }
        throw new Error(`Không upload được ${path.basename(filePath)} lên GCS (${response.status}): ${responseBody}`);
      }
    }
    return { fileData: { mimeType: inferMimeType(filePath), fileUri: `gs://${this.bucket}/${objectName}` } };
  }

  async buildFilePart(filePath, token, signal) {
    const stat = await fs.stat(filePath);
    if (stat.size <= INLINE_FILE_LIMIT && !inferMimeType(filePath).startsWith("video/")) {
      const buffer = await fs.readFile(filePath);
      return { inlineData: { mimeType: inferMimeType(filePath), data: buffer.toString("base64") } };
    }
    return this.uploadToGcs(filePath, token, signal);
  }

  async generateJsonFromFiles({
    filePaths = [],
    prompt,
    temperature = 0.2,
    onProgress,
    signal,
    taskType = "quality",
    responseSchema = null,
    maxOutputTokens = null,
    thinkingBudget = null,
    strictRootJson = false,
    videoFps = null,
    videoFpsByPath = {},
    mediaResolution = null,
    modelOverride = "",
    sourceContract = false,
    hookSchema = false,
    relaxedSchema = false,
    cachedContent = null
  } = {}) {
    this.lastResponseMetadata = null;
    this.lastResponseText = "";
    await this.assertBudgetAvailable();
    const token = await this.getAccessToken();
    this.validateSettings();
    const model = safeText(modelOverride) || this.getModel(taskType);
    const startedAt = Date.now();
    let preparedCount = 0;
    // Phase 16: when a Vertex context cache holds the media, don't re-attach
    // (and re-bill) the files — reuse the primed cache instead.
    const parts = await mapWithConcurrency(cachedContent ? [] : filePaths, 2, async (filePath) => {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const part = await this.buildFilePart(filePath, token, signal);
      const fileFps = videoFpsByPath[filePath] ?? videoFps;
      if (Number(fileFps) > 0 && inferMimeType(filePath).startsWith("video/")) {
        part.videoMetadata = { fps: Number(fileFps) };
      }
      preparedCount += 1;
      onProgress?.({
        percent: 8 + Math.round((preparedCount / Math.max(1, filePaths.length)) * 32),
        message: `Vertex đã chuẩn bị ${preparedCount}/${filePaths.length} file`
      });
      return part;
    });
    const preparedAt = Date.now();
    parts.push({ text: sourceContract && hookSchema && responseSchema
      ? require('./autoStorySchemaBoundary').hookPrompt(prompt, responseSchema)
      : sourceContract && relaxedSchema && responseSchema
        ? require('./autoStorySchemaBoundary').schemaPrompt(prompt, responseSchema) : prompt });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let heartbeat = null;
    if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
    onProgress?.({ percent: 45, message: `Vertex AI đang chạy ${model}` });
    if (typeof onProgress === "function") {
      heartbeat = setInterval(() => {
        const elapsedSec = Math.max(1, Math.round((Date.now() - preparedAt) / 1000));
        const softPercent = Math.min(92, 45 + (Math.floor(elapsedSec / 12) * 2));
        const elapsedLabel = elapsedSec >= 60
          ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
          : `${elapsedSec}s`;
        onProgress({
          percent: softPercent,
          heartbeat: true,
          elapsedSec,
          message: `Vertex AI đang phân tích bằng ${model} · đã chạy ${elapsedLabel}`
        });
      }, 12000);
      heartbeat.unref?.();
    }
    try {
      const endpoint = vertexEndpoint(this.projectId, this.location, model);
      const response = await fetchWithRetry(endpoint, () => ({
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(cachedContent ? { cachedContent } : {}),
          contents: [{ role: "user", parts }],
          generationConfig: {
            temperature,
            responseMimeType: "application/json",
            ...(["MEDIA_RESOLUTION_LOW", "MEDIA_RESOLUTION_MEDIUM", "MEDIA_RESOLUTION_HIGH"].includes(mediaResolution) ? { mediaResolution } : {}),
            ...(Number(maxOutputTokens) > 0 ? { maxOutputTokens: Math.round(Number(maxOutputTokens)) } : {}),
            // Gemini 2.5 "thinking" tokens are drawn from maxOutputTokens; for bounded
            // JSON extraction (Source Story Model) we cap/disable them so reasoning can't
            // starve the JSON output and cause a false MAX_TOKENS truncation. Only sent
            // when the caller opts in (thinkingBudget >= 0), so other tasks are unchanged.
            ...(Number.isFinite(Number(thinkingBudget)) && Number(thinkingBudget) >= 0
              ? { thinkingConfig: { thinkingBudget: Math.round(Number(thinkingBudget)) } } : {}),
            ...(responseSchema ? { responseSchema: sourceContract
              ? (hookSchema || relaxedSchema ? require('./autoStorySchemaBoundary').hookTransport(responseSchema)
                : require('./autoStorySchemaBoundary').transport(responseSchema)) : responseSchema } : {})
          }
        }),
        signal: controller.signal,
        dispatcher: this.dispatcher
      }), {
        label: `Vertex AI model ${model}`,
        attempts: 3,
        retryCodes: ["ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ECONNRESET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"],
        retryDelayMs: 1500,
        onRetry: ({ nextAttempt, code }) => onProgress?.({
          percent: 45,
          message: `Kết nối Vertex tạm gián đoạn (${code}); đang thử lại ${nextAttempt}/3`
        })
      });
      if (!response.ok) {
        const body = await response.text();
        this.lastResponseMetadata = { model, httpStatus: response.status,
          prepareMs: preparedAt - startedAt, modelMs: Date.now() - preparedAt,
          providerError: body.slice(0, 20000) };
        const error = formatVertexApiError(response.status, body, this.projectId);
        const retryAfter = response.headers?.get?.('retry-after');
        if (retryAfter) error.retryAfterMs = /^\d+(\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
        throw error;
      }
      const payload = await response.json();
      const completedAt = Date.now();
      const usage = estimateUsageCost(model, payload.usageMetadata || {});
      this.lastUsage = usage;
      await this.recordUsage(usage, taskType);
      this.lastResponseMetadata = {
        finishReason: payload.candidates?.[0]?.finishReason || "",
        usage: payload.usageMetadata || {}, model,
        requestedMaxOutputTokens: Number(maxOutputTokens) > 0 ? Math.round(Number(maxOutputTokens)) : null,
        requestedThinkingBudget: Number.isFinite(Number(thinkingBudget)) && Number(thinkingBudget) >= 0 ? Math.round(Number(thinkingBudget)) : null,
        prepareMs: preparedAt - startedAt, modelMs: completedAt - preparedAt
      };
      const responseText = extractResponseText(payload);
      this.lastResponseText = responseText;
      if (strictRootJson && this.lastResponseMetadata.finishReason && this.lastResponseMetadata.finishReason !== "STOP") {
        throw new Error(`Vertex AI không hoàn tất response: ${this.lastResponseMetadata.finishReason}`);
      }
      let parsed;
      if (strictRootJson) {
        const cleaned = String(responseText || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
        try {
          parsed = JSON.parse(cleaned);
        } catch (error) {
          throw new Error(`Vertex AI trả JSON root bị cắt hoặc không hợp lệ; không sử dụng object con: ${error.message}`);
        }
      } else {
        parsed = parseFirstJsonValue(responseText);
      }
      if (parsed === null) throw new Error("Vertex AI response không chứa JSON hợp lệ.");
      this.lastTimings = {
        fileCount: filePaths.length,
        prepareMs: preparedAt - startedAt,
        modelMs: completedAt - preparedAt,
        totalMs: completedAt - startedAt
      };
      onProgress?.({ percent: 100, message: `Vertex AI hoàn tất · ước tính $${usage.estimatedCostUsd.toFixed(4)}` });
      return parsed;
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) {
        throw new Error(
          `Vertex AI model ${model} vượt quá thời gian chờ ${Math.round(this.timeoutMs / 60000)} phút. ` +
          "Hãy tăng Vertex timeout trong Cài đặt hoặc giảm số lượng/độ dài media của một lượt phân tích.",
          { cause: error }
        );
      }
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      clearTimeout(timeout);
    }
  }

  // Phase 16: create a Vertex context cache over source media so downstream
  // stages reuse one primed context instead of re-uploading/re-billing clips.
  // Returns the cachedContents resource name, or null on any failure (caller
  // then falls back to attaching files normally). Additive + defensive.
  async createCachedContent({ filePaths = [], systemText = "", taskType = "quality", modelOverride = "", ttlSeconds = 3600, signal } = {}) {
    try {
      if (!this.bucket || !filePaths.length) return null;
      const token = await this.getAccessToken();
      this.validateSettings();
      const model = safeText(modelOverride) || this.getModel(taskType);
      const parts = await mapWithConcurrency(filePaths, 2, async (filePath) => this.buildFilePart(filePath, token, signal));
      const region = this.location;
      const host = region === "global" ? "aiplatform.googleapis.com" : `${region}-aiplatform.googleapis.com`;
      const url = `https://${host}/v1/projects/${encodeURIComponent(this.projectId)}/locations/${encodeURIComponent(region)}/cachedContents`;
      const body = {
        model: `projects/${this.projectId}/locations/${region}/publishers/google/models/${model}`,
        contents: [{ role: "user", parts }],
        ttl: `${Math.max(60, Math.round(ttlSeconds))}s`
      };
      if (systemText) body.systemInstruction = { role: "system", parts: [{ text: systemText }] };
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        dispatcher: this.dispatcher
      });
      if (!response.ok) return null;
      const payload = await response.json();
      return payload?.name || null;
    } catch (_error) {
      return null;
    }
  }

  async generateJson(prompt, temperature = 0.2, taskType = "text_utility") {
    return this.generateJsonFromFiles({ filePaths: [], prompt, temperature, taskType });
  }

  async testConnection() {
    const result = await this.generateJson("Return exactly this JSON object: {\"ok\":true}", 0, "economy");
    return { ok: result?.ok === true, projectId: this.projectId, location: this.location, model: this.getModel("economy"), usage: this.lastUsage, budget: await this.budgetStatus() };
  }
}

VertexAiService.inferMimeType = inferMimeType;
VertexAiService.parseFirstJsonValue = parseFirstJsonValue;
VertexAiService.estimateUsageCost = estimateUsageCost;
VertexAiService.vertexEndpoint = vertexEndpoint;
VertexAiService.formatVertexApiError = formatVertexApiError;
VertexAiService.normalizeBucketName = normalizeBucketName;
VertexAiService.fetchFailureMessage = fetchFailureMessage;
VertexAiService.buildMediaObjectName = buildMediaObjectName;
VertexAiService.mapWithConcurrency = mapWithConcurrency;
VertexAiService.buildDispatcherOptions = buildDispatcherOptions;
VertexAiService.fetchErrorCode = fetchErrorCode;
VertexAiService.shouldRetryFetchError = shouldRetryFetchError;

module.exports = VertexAiService;
