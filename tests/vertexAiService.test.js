const assert = require("assert");
const os = require("os");
const path = require("path");
const fs = require("fs/promises");

const VertexAiService = require("../electron/services/vertexAiService");
const { createAiProvider, VertexTextProvider } = require("../electron/services/aiProviderRegistry");
const ConfiguredAiWorkflowService = require("../electron/services/configuredAiWorkflowService");

async function run() {
  assert.strictEqual(VertexAiService.inferMimeType("clip.mp4"), "video/mp4");
  assert.strictEqual(VertexAiService.inferMimeType("scene-manifest.json"), "text/plain");
  assert.strictEqual(VertexAiService.inferMimeType("source-transcript.srt"), "text/plain");
  assert.strictEqual(VertexAiService.inferMimeType("frame.jpg"), "image/jpeg");
  assert.deepStrictEqual(VertexAiService.buildDispatcherOptions(15 * 60 * 1000), {
    connectTimeout: 60000,
    headersTimeout: 15 * 60 * 1000 + 30000,
    bodyTimeout: 15 * 60 * 1000 + 30000,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 750
  });
  const dnsFailure = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND aiplatform.googleapis.com"), { code: "ENOTFOUND" })
  });
  assert.strictEqual(VertexAiService.fetchErrorCode(dnsFailure), "ENOTFOUND");
  assert.strictEqual(VertexAiService.shouldRetryFetchError(dnsFailure, ["ENOTFOUND"]), true);
  assert.strictEqual(VertexAiService.shouldRetryFetchError(dnsFailure, ["ECONNRESET"]), false);
  assert.strictEqual(VertexAiService.normalizeBucketName("gs://my-cineviral-temp/cache"), "my-cineviral-temp");
  assert.strictEqual(VertexAiService.normalizeBucketName("https://storage.googleapis.com/my-cineviral-temp/path"), "my-cineviral-temp");
  assert.strictEqual(
    VertexAiService.buildMediaObjectName("C:\\video\\clip.mp4", { size: 100, mtimeMs: 200 }),
    VertexAiService.buildMediaObjectName("C:\\video\\clip.mp4", { size: 100, mtimeMs: 200 })
  );
  assert.strictEqual(
    VertexAiService.fetchFailureMessage(
      Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error("socket disconnected"), { code: "ECONNRESET" }) }),
      "Upload media",
      "https://storage.googleapis.com/upload"
    ),
    "Upload media không kết nối được tới storage.googleapis.com (ECONNRESET): socket disconnected"
  );
  assert.deepStrictEqual(VertexAiService.parseFirstJsonValue("text ```json\n{\"ok\":true}\n```"), { ok: true });
  assert.strictEqual(
    VertexAiService.vertexEndpoint("demo-project", "global", "gemini-2.5-flash"),
    "https://aiplatform.googleapis.com/v1/projects/demo-project/locations/global/publishers/google/models/gemini-2.5-flash:generateContent"
  );
  assert(VertexAiService.vertexEndpoint("p", "us-central1", "m").startsWith("https://us-central1-aiplatform.googleapis.com/"));
  const permissionError = VertexAiService.formatVertexApiError(403, JSON.stringify({
    error: { message: "Permission 'aiplatform.endpoints.predict' denied" }
  }), "demo-project");
  assert(permissionError.message.includes("roles/aiplatform.user"));
  assert(permissionError.message.includes("demo-project"));

  const usage = VertexAiService.estimateUsageCost("gemini-2.5-flash", {
    promptTokenCount: 1_000_000,
    candidatesTokenCount: 1_000_000
  });
  assert.strictEqual(usage.estimatedCostUsd, 2.8);
  assert.equal(VertexAiService.estimateUsageCost("gemini-2.5-pro", { promptTokenCount: 200000, candidatesTokenCount: 1000 }).estimatedCostUsd, 0.26);
  assert.equal(VertexAiService.estimateUsageCost("gemini-2.5-pro", { promptTokenCount: 200001, candidatesTokenCount: 1000, thoughtsTokenCount: 1000 }).estimatedCostUsd, 0.530003);
  const cachedPro = VertexAiService.estimateUsageCost("gemini-2.5-pro", { promptTokenCount: 300000, cachedContentTokenCount: 200000 });
  assert.equal(cachedPro.estimatedCostUsd, 0.3);
  assert.equal(cachedPro.pricingTier, "long_context");

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cineviral-vertex-test-"));
  const packageRoot = path.join(tempRoot, "package");
  const pass1Dir = path.join(packageRoot, "01-GUI-GEMINI");
  const batchDir = path.join(pass1Dir, "UPLOAD-BATCH-01");
  await fs.mkdir(batchDir, { recursive: true });
  await fs.writeFile(path.join(pass1Dir, "proxy-chunks-manifest.json"), JSON.stringify({
    chunks: [
      { file: "analysis-proxy-chunk-001.mp4" },
      { file: "analysis-proxy-chunk-002.mp4" }
    ]
  }));
  await fs.writeFile(path.join(batchDir, "analysis-proxy-chunk-001.mp4"), "one");
  await fs.writeFile(path.join(batchDir, "analysis-proxy-chunk-002.mp4"), "two");
  const collected = await ConfiguredAiWorkflowService.collectStage1InputFiles(packageRoot, {
    pass1UploadDir: pass1Dir,
    proxyUploadBatchDirs: [batchDir]
  });
  assert.strictEqual(collected.files.filter((file) => file.endsWith(".mp4")).length, 2);
  const service = new VertexAiService({
    workspaceRoot: tempRoot,
    vertexProjectId: "test-project",
    vertexEconomyModel: "economy-model",
    vertexAnalysisModel: "analysis-model",
    vertexQualityModel: "quality-model",
    vertexBudgetUsd: 20,
    vertexDailyLimitUsd: 2
  });
  assert.strictEqual(service.getModel("text_utility"), "economy-model");
  assert.strictEqual(service.getModel("stage1"), "analysis-model");
  assert.strictEqual(service.getModel("draft_review"), "quality-model");
  assert.deepStrictEqual(await service.budgetStatus(), {
    totalSpentUsd: 0,
    dailySpentUsd: 0,
    budgetUsd: 20,
    dailyLimitUsd: 2,
    requestCount: 0
  });

  const provider = createAiProvider({
    aiProvider: "vertex_ai",
    workspaceRoot: tempRoot,
    vertexProjectId: "test-project",
    vertexGcloudCommand: "gcloud"
  });
  assert(provider instanceof VertexTextProvider);

  const descriptor = ConfiguredAiWorkflowService.providerDescriptor({
    aiProvider: "vertex_ai",
    vertexProjectId: "test-project",
    vertexGcloudCommand: "gcloud",
    vertexAnalysisModel: "analysis-model",
    vertexQualityModel: "quality-model"
  });
  assert.strictEqual(descriptor.model, "analysis-model");
  assert.strictEqual(descriptor.qualityModel, "quality-model");

  await fs.rm(tempRoot, { recursive: true, force: true });
  console.log("vertexAiService.test.js passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
