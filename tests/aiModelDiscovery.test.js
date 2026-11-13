const assert = require("node:assert/strict");
const test = require("node:test");

const VertexAiService = require("../electron/services/vertexAiService");
const GeminiService = require("../electron/services/geminiService");

test("VertexAiService.listAvailableModels filters non-generative models and probes :countTokens per account/location", async () => {
  VertexAiService.clearModelDiscoveryCache();
  const service = new VertexAiService({ vertexLocation: "global" });
  service.getAccessToken = async () => {
    service.projectId = "resolved-project-123";
    return "test-token";
  };

  const previousFetch = global.fetch;
  const probedModels = [];
  global.fetch = async (url) => {
    if (String(url).includes("/v1beta1/publishers/google/models")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          publisherModels: [
            { name: "publishers/google/models/gemini-2.5-flash-lite", launchStage: "GA" },
            { name: "publishers/google/models/gemini-embedding-2", launchStage: "GA" },
            { name: "publishers/google/models/gemini-3.8-flash-tts", launchStage: "GA" },
            { name: "publishers/google/models/gemini-3.1-flash-image", launchStage: "GA" },
            { name: "publishers/google/models/gemini-3.5-transcribe", launchStage: "GA" },
            { name: "publishers/google/models/gemini-live-2.5-flash-native-audio", launchStage: "GA" },
            { name: "publishers/google/models/gemini-nano-banana-2.1", launchStage: "GA" },
            { name: "publishers/google/models/gemini-3.5-flash-lite", launchStage: "GA" },
            { name: "publishers/google/models/gemini-3.8-flash", launchStage: "GA" },
            { name: "publishers/google/models/gemini-3.1-pro-preview", launchStage: "PUBLIC_PREVIEW" }
          ]
        })
      };
    }
    if (String(url).includes(":countTokens")) {
      const match = String(url).match(/\/models\/([^:]+):countTokens/);
      const modelId = decodeURIComponent(match[1]);
      probedModels.push(modelId);
      if (modelId === "gemini-2.5-flash-lite") {
        return { ok: false, status: 404, text: async () => JSON.stringify({ error: { message: "Not found" } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ totalTokens: 2 }) };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const result = await service.listAvailableModels({ force: true });
    assert.equal(result.projectId, "resolved-project-123");
    assert.equal(result.location, "global");
    assert.deepEqual(
      probedModels.sort(),
      ["gemini-2.5-flash-lite", "gemini-3.1-pro-preview", "gemini-3.5-flash-lite", "gemini-3.8-flash"]
    );
    assert.deepEqual(
      result.models.map((item) => item.value),
      ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"]
    );

    const beforeCached = probedModels.length;
    const cached = await service.listAvailableModels({ force: false });
    assert.equal(probedModels.length, beforeCached, "expected cache hit when force=false");
    assert.deepEqual(cached, result);
  } finally {
    global.fetch = previousFetch;
    await service.dispatcher.close();
    VertexAiService.clearModelDiscoveryCache();
  }
});

test("VertexAiService.listAvailableModels surfaces 403 permission error when all probes are forbidden", async () => {
  VertexAiService.clearModelDiscoveryCache();
  const service = new VertexAiService({ vertexProjectId: "fixture-proj", vertexLocation: "global" });
  service.getAccessToken = async () => "test-token";

  const previousFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes("/v1beta1/publishers/google/models")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          publisherModels: [{ name: "publishers/google/models/gemini-3.8-flash", launchStage: "GA" }]
        })
      };
    }
    return {
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: { message: "Permission aiplatform.endpoints.predict denied" } })
    };
  };

  try {
    await assert.rejects(() => service.listAvailableModels({ force: true }), /403|quyền/i);
  } finally {
    global.fetch = previousFetch;
    await service.dispatcher.close();
    VertexAiService.clearModelDiscoveryCache();
  }
});

test("GeminiService.listAvailableModels filters generateContent Gemini models and handles pagination", async () => {
  GeminiService.clearModelDiscoveryCache();
  const previousFetch = global.fetch;
  const urls = [];
  global.fetch = async (url) => {
    urls.push(String(url));
    if (!String(url).includes("pageToken=")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          models: [
            { name: "models/gemini-2.5-flash-preview-tts", supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-omni-1.2-flash", supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
            { name: "models/gemma-4-31b-it", supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", supportedGenerationMethods: ["generateContent"] }
          ],
          nextPageToken: "page-2"
        })
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        models: [
          { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-3.1-flash-image-preview", supportedGenerationMethods: ["generateContent"] }
        ]
      })
    };
  };

  try {
    const result = await GeminiService.listAvailableModels("secret-test-key-xyz", { force: true });
    assert.equal(urls.length, 2);
    assert.deepEqual(
      result.models.map((item) => item.value),
      ["gemini-3.8-flash", "gemini-2.5-pro"]
    );
  } finally {
    global.fetch = previousFetch;
    GeminiService.clearModelDiscoveryCache();
  }
});

test("GeminiService.listAvailableModels omits API key from error messages", async () => {
  GeminiService.clearModelDiscoveryCache();
  const previousFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ error: { message: "API key not valid." } })
  });

  try {
    await assert.rejects(
      () => GeminiService.listAvailableModels("AIza-super-secret-value", { force: true }),
      (err) => !String(err.message).includes("AIza-super-secret-value") && /API key not valid/i.test(err.message)
    );
  } finally {
    global.fetch = previousFetch;
    GeminiService.clearModelDiscoveryCache();
  }
});

test("buildThinkingConfig maps thinkingLevel for Gemini 3+/4+ and thinkingBudget for Gemini 2.5", () => {
  assert.deepEqual(
    VertexAiService.buildThinkingConfig({ model: "gemini-3.8-flash", thinkingLevel: "high" }),
    { thinkingLevel: "HIGH" }
  );
  assert.deepEqual(
    VertexAiService.buildThinkingConfig({ model: "gemini-4-argon", thinkingLevel: "low" }),
    { thinkingLevel: "LOW" }
  );
  // Caller thinkingBudget: 0/1024 converts cleanly to thinkingLevel on Gemini 4+ to prevent HTTP 400
  assert.deepEqual(
    VertexAiService.buildThinkingConfig({ model: "gemini-4-argon", thinkingLevel: "", thinkingBudget: 0 }),
    { thinkingLevel: "LOW" }
  );
  assert.deepEqual(
    VertexAiService.buildThinkingConfig({ model: "gemini-4-argon", thinkingLevel: "", thinkingBudget: 8192 }),
    { thinkingLevel: "MEDIUM" }
  );
  // Gemini 2.5 keeps integer thinkingBudget and enforces 128 floor on 2.5-pro
  assert.deepEqual(
    VertexAiService.buildThinkingConfig({ model: "gemini-2.5-flash", thinkingLevel: "medium" }),
    { thinkingBudget: 8192 }
  );
  assert.deepEqual(
    VertexAiService.buildThinkingConfig({ model: "gemini-2.5-pro", thinkingLevel: "", thinkingBudget: 0 }),
    { thinkingBudget: 128 }
  );
  assert.equal(
    VertexAiService.buildThinkingConfig({ model: "gemini-3.8-flash", thinkingLevel: "" }),
    null
  );
});

test("VertexAiService resolves per-tier thinkingLevel and sends thinkingConfig in requests", async () => {
  const service = new VertexAiService({
    vertexProjectId: "fixture-proj",
    vertexLocation: "global",
    vertexEconomyModel: "gemini-3.5-flash-lite",
    vertexEconomyThinkingLevel: "low",
    vertexAnalysisModel: "gemini-3.8-flash",
    vertexAnalysisThinkingLevel: "medium",
    vertexQualityModel: "gemini-4-argon",
    vertexQualityThinkingLevel: "high"
  });
  service.assertBudgetAvailable = async () => {};
  service.getAccessToken = async () => "test-token";
  service.validateSettings = () => {};
  service.recordUsage = async () => {};

  assert.equal(service.getThinkingLevel("economy"), "low");
  assert.equal(service.getThinkingLevel("video_analysis"), "medium");
  assert.equal(service.getThinkingLevel("auto_story_plan"), "medium");
  assert.equal(service.getThinkingLevel("auto_story_review"), "high");

  const sentBodies = [];
  const previousFetch = global.fetch;
  global.fetch = async (_url, options) => {
    sentBodies.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"ok":true}' }] } }]
      })
    };
  };

  try {
    await service.generateJsonFromFiles({ prompt: "Check", taskType: "economy" });
    await service.generateJsonFromFiles({ prompt: "Review", taskType: "auto_story_review" });
    assert.deepEqual(sentBodies[0].generationConfig.thinkingConfig, { thinkingLevel: "LOW" });
    assert.deepEqual(sentBodies[1].generationConfig.thinkingConfig, { thinkingLevel: "HIGH" });
  } finally {
    global.fetch = previousFetch;
    await service.dispatcher.close();
  }
});

test("GeminiService sends configured thinkingLevel in generationConfig", async () => {
  const gemini = new GeminiService("test-key", "gemini-3.8-flash", { thinkingLevel: "high" });
  const sentBodies = [];
  const previousFetch = global.fetch;
  global.fetch = async (_url, options) => {
    sentBodies.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"ok":true}' }] } }]
      })
    };
  };

  try {
    const out = await gemini.generateTextJson({ prompt: "Hi" });
    assert.equal(out.ok, true);
    assert.deepEqual(sentBodies[0].generationConfig.thinkingConfig, { thinkingLevel: "HIGH" });
  } finally {
    global.fetch = previousFetch;
  }
});
