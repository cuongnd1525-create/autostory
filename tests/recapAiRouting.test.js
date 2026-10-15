const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const Ai = require("../electron/services/recap/recapAiService");
const Provider = require("../electron/services/recap/recapProviderService");
const tokens = require("../electron/services/cancelToken");
const Vertex = require("../electron/services/vertexAiService");
const Discovery = require("../electron/services/antigravityModelDiscovery");
const inventory = Discovery.parseModels(["gemini-3.8-flash-high\tGemini 3.8 Flash (High)", "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)", "gemini-3.7-flash-high\tGemini 3.7 Flash (High)", "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)",
  "gemini-3.1-pro-high\tGemini 3.1 Pro (High)", "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)"].join("\n"));
require("node:test").mock.method(Discovery, "list", async () => inventory);
const Stage1 = require("../electron/services/manualAntigravityStage1Service");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
test("provider validation rejects array overflow and fractional indexes before accepting compact repairs", () => {
  const bounded = { type: "array", minItems: 1, maxItems: 2, items: { type: "integer" } };
  assert.deepEqual(Provider.validateResponse([1, 2], bounded), [1, 2]);
  assert.throws(() => Provider.validateResponse([1, 2, 3], bounded), /array length/);
  assert.throws(() => Provider.validateResponse([], bounded), /array length/);
  assert.throws(() => Provider.validateResponse([1.5], bounded), /integer/);
});
const story = { title: "Story", logline: "Story", conflict: "Conflict", characters: [], major_events: [], climax: "Climax", ending: { description: "End" } };
const plan = { target_duration_sec: 5, selected_event_ids: ["event_1"], hook_event_ids: ["event_1"], beats: [] };

test("Vertex Pro capacity failure switches to the configured Flash with the same review media and budget errors never fall back", async () => {
  const calls = [], provider = new Provider({ aiProvider: "vertex_ai", vertexAnalysisModel: "gemini-2.5-flash", vertexQualityModel: "gemini-2.5-pro" }, {
    vertex: { generateJsonFromFiles: async options => {
      calls.push(options);
      if (options.modelOverride === "gemini-2.5-pro") throw new Error("Vertex AI request failed (429): Resource exhausted.");
      return { ok: true };
    } }
  });
  const ai = new Ai({}, { providerService: provider });
  assert.deepEqual(await ai.runVertexCall({ filePaths: ["review.mp4"], prompt: "Review", responseSchema: schema, modelOverride: "gemini-2.5-pro" }), { ok: true });
  assert.deepEqual(calls.map(call => call.modelOverride), ["gemini-2.5-pro", "gemini-2.5-flash"]);
  assert.deepEqual(calls[0].filePaths, calls[1].filePaths);
  provider.dependencies.vertex.generateJsonFromFiles = async () => { throw Object.assign(new Error("Spending limit"), { kind: "budget" }); };
  await assert.rejects(ai.runVertexCall({ prompt: "Review", modelOverride: "gemini-2.5-pro" }), { kind: "budget" });
});

test("operation tokens provide a valid signal and cancellation aborts it", () => {
  const token = tokens.createCancelToken("recap test");
  assert.doesNotThrow(() => new Request("https://storage.googleapis.com", { signal: token.signal }));
  tokens.cancelToken(token);
  assert.equal(token.signal.aborted, true);
  tokens.clearCancelToken(token);
});

test("Vertex omits an unspecified thinking budget and never disables thinking on Pro", async () => {
  const service = new Vertex({ vertexProjectId: "fixture-project" });
  service.assertBudgetAvailable = async () => {}; service.getAccessToken = async () => "fixture-token";
  service.validateSettings = () => {}; service.recordUsage = async () => {};
  const requests = [], previousFetch = global.fetch;
  global.fetch = async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"ok":true}' }] } }] }) }; };
  try {
    await service.generateJsonFromFiles({ prompt: "Test", modelOverride: "gemini-2.5-pro" });
    await service.generateJsonFromFiles({ prompt: "Test", modelOverride: "gemini-2.5-pro", thinkingBudget: 0 });
    await service.generateJsonFromFiles({ prompt: "Test", modelOverride: "gemini-2.5-flash", thinkingBudget: 0 });
    assert.equal(requests[0].generationConfig.thinkingConfig, undefined);
    assert.equal(requests[1].generationConfig.thinkingConfig.thinkingBudget, 128);
    assert.equal(requests[2].generationConfig.thinkingConfig.thinkingBudget, 0);
  } finally { global.fetch = previousFetch; await service.dispatcher.close(); }
});

test("every AI stage passes AbortSignal instead of the token", async () => {
  const token = tokens.createScopedToken("test");
  const ai = new Ai();
  const responses = [
    { summary: "Scene", events: [{ id: "ev_1", source_start: 62, source_end: 64, description: "Visible action" }] },
    story, plan, { speech_units: [] }, { text: "Shorter line", clauses: [] }, { overall_score: 0.9, summary: "OK", issues: [] }
  ];
  const requests = [];
  ai.providerService.generateJsonFromFiles = async (options) => { requests.push(options); return responses.shift(); };
  const chunk = await ai.analyzeVideoChunk({ chunkPath: "unused.mp4", chunkInfo: { chunkIndex: 2, sourceStartSec: 60, sourceEndSec: 120 }, cancelToken: token });
  assert.equal(chunk.events[0].source_start, 62);
  await ai.buildStoryModel({ events: chunk.events, metadata: { duration: 120 }, cancelToken: token });
  await ai.planRecap({ storyModel: story, events: chunk.events, cancelToken: token });
  await ai.generateNarration({ recapPlan: plan, events: chunk.events, storyModel: story, cancelToken: token });
  await ai.reviseNarration({ speechUnit: { id: "speech_1", text: "A longer line", visual_event_ids: [chunk.events[0].id] }, targetDurationSec: 2, cancelToken: token });
  await ai.reviewDraft({ draftVideoPath: "unused.mp4", storyModel: story, decisions: [], cancelToken: token });
  assert.equal(requests.length, 6);
  requests.forEach((request) => assert.equal(request.signal, token.signal));
});

test("timestamp contract handles explicit relative offsets, absolute overlap and event IDs", async () => {
  const ai = new Ai();
  const chunkInfo = { chunkIndex: 2, sourceStartSec: 60, sourceEndSec: 180 };
  ai.runVertexCall = async () => ({ summary: "Scene", timestamp_basis: "relative", events: [{ id: "ev_1", source_start: 70, source_end: 74, description: "Action" }] });
  const relative = await ai.analyzeVideoChunk({ chunkInfo });
  assert.equal(relative.events[0].source_start, 130, "relative timestamps can exceed the source offset");
  ai.runVertexCall = async () => ({ summary: "Scene", timestamp_basis: "absolute", events: [{ id: "ev_1", source_start: 70, source_end: 74, description: "Action" }] });
  const absolute = await ai.analyzeVideoChunk({ chunkInfo });
  assert.equal(absolute.events[0].source_start, 70, "absolute timestamps must never receive another offset");
  const third = await ai.analyzeVideoChunk({ chunkInfo: { ...chunkInfo, chunkIndex: 3 } });
  assert.notEqual(third.events[0].id, absolute.events[0].id);
  ai.runVertexCall = async () => ({ summary: "Scene", events: [{ source_start: 185, source_end: 190 }] });
  await assert.rejects(ai.analyzeVideoChunk({ chunkInfo }), /invalid source range/);
});

test("Vertex and Gemini route only to the selected provider and model", async () => {
  let vertexCalls = 0, geminiCalls = 0;
  const dependencies = {
    vertex: { generateJsonFromFiles: async () => { vertexCalls++; return { ok: true }; } },
    gemini: { generateJsonFromFiles: async (options) => { geminiCalls++; assert.match(options.prompt, /schema/); return { ok: true }; } }
  };
  await new Provider({ aiProvider: "vertex_ai" }, dependencies).generateJsonFromFiles({ prompt: "test", responseSchema: schema });
  const gemini = new Provider({ aiProvider: "gemini", geminiModel: "selected-model" }, dependencies);
  assert.equal(gemini.getModel(true), "selected-model");
  await gemini.generateJsonFromFiles({ prompt: "test", responseSchema: schema });
  assert.equal(vertexCalls, 1);
  assert.equal(geminiCalls, 1);
  assert.throws(() => new Provider({ aiProvider: "ollama_local" }), /chưa hỗ trợ/);
});

test("Antigravity reads media locally, parses stream JSON, and cleans its request folder", async () => {
  let cwd;
  const service = new Provider({ aiProvider: "antigravity_cli", vertexAnalysisModel: "wrong-vertex-model" }, {
    antigravityFactory: () => ({
      buildCommand: () => ({ command: "agy", args: [], timeoutMs: 1000 }),
      runCli: async (options) => {
        cwd = options.cwd;
        assert.match(fs.readFileSync(`${cwd}/request.txt`, "utf8"), /unused\.mp4/);
        assert.ok(options.args.includes("--add-dir"));
        return { stdout: JSON.stringify({ event: "result", result: { response: '{"ok":true}' } }), viewedProxySet: new Set(["unused.mp4"]) };
      }, cancel() {}
    })
  });
  assert.equal(service.getModel(), "");
  assert.deepEqual(await service.generateJsonFromFiles({ filePaths: ["unused.mp4"], prompt: "test", responseSchema: schema }), { ok: true });
  assert.equal(fs.existsSync(cwd), false);
});

test("locked cleanup preserves successful JSON and does not rerun the AI request", async () => {
  let folder, cliCalls = 0, removals = 0;
  const queued = [], warnings = [];
  const service = new Provider({ aiProvider: "antigravity_cli" }, {
    logger: { warn() {} },
    antigravityFactory: () => ({ buildCommand: () => ({ args: [] }), cancel() {},
      runCli: async ({ cwd }) => { folder = cwd; cliCalls++; return { stdout: '{"ok":true}', viewedProxySet: new Set() }; } }),
    removeTempDirectory: async (_folder, options) => { assert.ok(options.maxRetries > 0); removals++; throw Object.assign(new Error("locked"), { code: "EBUSY" }); },
    scheduleCleanup: (callback) => { queued.push(callback); return { unref() {} }; }
  });
  try {
    const ai = new Ai(); ai.providerService = service;
    assert.deepEqual(await ai.runVertexCall({ prompt: "test", responseSchema: schema, onProgress: (p) => warnings.push(p) }), { ok: true });
    assert.equal(cliCalls, 1); assert.equal(removals, 1);
    assert.equal(warnings.filter((p) => p.level === "WARNING").length, 1);
    assert.ok(!warnings.some((p) => /Lỗi AI tạm thời/.test(p.message)));
    await queued.shift()(); await queued.shift()();
    assert.equal(removals, 3); assert.equal(queued.length, 0, "background cleanup is bounded");
  } finally { if (folder) await fs.promises.rm(folder, { recursive: true, force: true }); }
});

test("locked cleanup cannot replace the original CLI, JSON or cancellation error", async () => {
  for (const failure of [new Error("Original provider failure"), new DOMException("Original cancellation", "AbortError"), null]) {
    let folder;
    const service = new Provider({ aiProvider: "antigravity_cli" }, {
      logger: { warn() {} }, scheduleCleanup: () => ({ unref() {} }),
      removeTempDirectory: async () => { throw Object.assign(new Error("locked"), { code: "EBUSY" }); },
      antigravityFactory: () => ({ buildCommand: () => ({ args: [] }), cancel() {}, runCli: async ({ cwd }) => {
        folder = cwd; if (failure) throw failure; return { stdout: '{"ok":', viewedProxySet: new Set() };
      } })
    });
    try {
      await assert.rejects(service.generateJsonFromFiles({ prompt: "test", responseSchema: schema }),
        (error) => failure ? error === failure : /JSON recap/.test(error.message));
    } finally { if (folder) await fs.promises.rm(folder, { recursive: true, force: true }); }
  }
});

test("cleanup warnings and scheduling failures cannot discard a valid result", async () => {
  let folder;
  const service = new Provider({ aiProvider: "antigravity_cli" }, {
    logger: { warn() { throw new Error("Logger disconnected"); } },
    scheduleCleanup: () => { throw new Error("Schedule failed"); },
    removeTempDirectory: async () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); },
    antigravityFactory: () => ({ buildCommand: () => ({ args: [] }), cancel() {}, runCli: async ({ cwd }) => {
      folder = cwd; return { stdout: '{"ok":true}', viewedProxySet: new Set() };
    } })
  });
  try {
    assert.deepEqual(await service.generateJsonFromFiles({ prompt: "test", responseSchema: schema, onProgress() { throw new Error("UI disconnected"); } }), { ok: true });
  } finally { if (folder) await fs.promises.rm(folder, { recursive: true, force: true }); }
});

test("CLI responses cannot substitute an unrelated nested object or claim unseen video", async () => {
  assert.throws(() => Provider.parseCliJson('{"wrapper":{"ok":true}}', schema), /JSON recap/);
  assert.throws(() => Provider.parseCliJson('{"ok":', schema), /JSON recap/);
  const deltas = ['{"ok":', 'true}'].map((text_delta) => JSON.stringify({ event: "step", step_update: { step_index: 1, text_delta } })).join("\n");
  assert.deepEqual(Provider.parseCliJson(deltas, schema), { ok: true });
  const service = new Provider({ aiProvider: "antigravity_cli" }, { antigravityFactory: () => ({
    buildCommand: () => ({ args: [] }),
    runCli: async () => ({ stdout: '{"ok":true}', viewedProxySet: new Set() }), cancel() {}
  }) });
  await assert.rejects(service.generateJsonFromFiles({ filePaths: ["unused.mp4"], prompt: "test", responseSchema: schema }), /chưa xem đủ/);
});

test("canceling Antigravity stops its running delegate", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const service = new Provider({ aiProvider: "antigravity_cli" }, { antigravityFactory: () => {
    let reject;
    return { buildCommand: () => ({ args: [] }),
      runCli: () => new Promise((_resolve, fail) => { reject = fail; controller.abort(); }),
      cancel: () => { cancelled = true; reject(new DOMException("Aborted", "AbortError")); } };
  } });
  await assert.rejects(service.generateJsonFromFiles({ prompt: "test", responseSchema: schema, signal: controller.signal }), /Aborted/);
  assert.equal(cancelled, true);
});

test("invalid request parameters are neither retried nor reported as network failures", () => {
  const error = new TypeError("Failed to construct 'Request': member signal is not of type AbortSignal.");
  assert.equal(Vertex.shouldRetryFetchError(error), false);
  assert.match(Vertex.fetchFailureMessage(error, "Cache", "https://storage.googleapis.com"), /lỗi tham số/);
  assert.doesNotMatch(Vertex.fetchFailureMessage(error, "Cache", "https://storage.googleapis.com"), /không kết nối/);
});

test("recap heartbeat preserves real activity time and cannot prevent an inactivity timeout", async () => {
  const child = new EventEmitter(); child.pid = 12345;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => { child.killed = true; setImmediate(() => child.emit("close", 1)); };
  const progress = [];
  const service = new Stage1({}, { spawn: () => child, timers: { heartbeatMs: 10, hardTimeoutGraceMs: 100 } });
  service.killChild = (ownedChild) => ownedChild.kill();
  const run = service.runCli({ command: "fixture", args: [], cwd: process.cwd(), timeoutMs: 100,
    reportHeartbeat: true, progressStep: "recap_ai", onProgress: (value) => progress.push(value) });
  child.stderr.write("Inspecting video\n");
  await assert.rejects(run, (error) => error.kind === "inactivity_timeout");
  const beats = progress.filter((item) => item.heartbeat);
  assert.ok(beats.length >= 2);
  assert.equal(new Set(beats.map((item) => item.lastActivityAt)).size, 1, "heartbeat is not a model response");
  assert.ok(beats.every((item) => item.pid === 12345 && item.percent === undefined && item.message === undefined));
  assert.equal(child.killed, true);
  const endedCount = progress.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(progress.length, endedCount, "heartbeat stops when the request fails");
});

test("typed inactivity timeout is reported immediately instead of repeating a ten minute request", async () => {
  let calls = 0;
  const service = new Ai();
  service.providerService = { generateJsonFromFiles: async () => { calls++; throw Object.assign(new Error("Antigravity không có phản hồi trong 600s"), { kind: "inactivity_timeout" }); } };
  await assert.rejects(service.runVertexCall({ prompt: "fixture" }), (error) => error.kind === "inactivity_timeout");
  assert.equal(calls, 1);
});

test("AI request lifecycle identifies waiting and finishes even when the provider fails", async () => {
  const progress = [], failure = new Error("Provider failed");
  const service = new Provider({ aiProvider: "vertex_ai" }, { vertex: { generateJsonFromFiles: async () => { throw failure; } } });
  await assert.rejects(service.generateJsonFromFiles({ prompt: "fixture", onProgress: (value) => progress.push(value) }), (error) => error === failure);
  assert.equal(progress[0].aiRequestStarted, true);
  assert.equal(progress.at(-1).aiRequestFinished, true);
  assert.ok(progress.every((item) => item.providerLabel === "Vertex AI" && item.lastActivityAt === undefined));
});

test("recap observes with Flash Low and preserves the selected model for editorial decisions", async () => {
  const provider = new Provider({ aiProvider: "antigravity_cli", antigravityModel: "gemini-3.7-flash-high" });
  assert.equal(provider.getModel(false), "gemini-3.7-flash-low");
  assert.equal(provider.getModel(true), "gemini-3.7-flash-high");
  assert.equal(new Provider({ aiProvider: "antigravity_cli", antigravityModel: "gemini-3.1-pro-high" }).getModel(false), "gemini-3.1-pro-high");
  assert.equal(new Provider({ aiProvider: "antigravity_cli", antigravityModel: "gemini-3.7-flash-high", recapAnalysisReasoning: "high" }).getModel(false), "gemini-3.7-flash-high");
  let requestedModel;
  provider.dependencies.antigravityFactory = () => ({ buildCommand: (_prompt, _schema, _cwd, options) => { requestedModel = options.modelOverride; return { args: [] }; },
    runCli: async () => ({ stdout: '{"ok":true}', viewedProxySet: new Set() }), cancel() {} });
  await provider.generateJsonFromFiles({ prompt: "fixture", responseSchema: schema, modelOverride: provider.getModel(false) });
  assert.equal(requestedModel, "gemini-3.7-flash-low", "stage override must reach the actual CLI command");
});

test("output token exhaustion never repeats the same unbounded AI request", async () => {
  let calls = 0;
  const ai = new Ai();
  ai.providerService = { generateJsonFromFiles: async () => { calls++; throw new Error("Your previous response was cut off because it exceeded the output token limit"); } };
  await assert.rejects(ai.runVertexCall({ prompt: "fixture" }), /output token limit/);
  assert.equal(calls, 1);
});

test("chunk analysis retains all valid events above the suggested size target", async () => {
  const ai = new Ai();
  let calls = 0;
  ai.runVertexCall = async () => { calls++; return { summary: "Fixture", events: Array.from({ length: 31 }, (_, i) => ({ source_start: i, source_end: i + 1, description: "A".repeat(350) })) }; };
  const result = await ai.analyzeVideoChunk({ chunkInfo: { sourceStartSec: 0, sourceEndSec: 240 } });
  assert.equal(result.events.length, 31); assert.equal(calls, 1);
  assert.ok(JSON.stringify(result).length > 9000);
});

test("Antigravity fallback skips duplicate models and keeps editorial reasoning", () => {
  const provider = new Provider({ aiProvider: "antigravity_cli" });
  provider.availableModels = inventory;
  assert.deepEqual(provider.getFallbackModels("gemini-3.7-flash-low"), ["gemini-3.7-flash-low", "gemini-3.8-flash-low", "gemini-3.1-pro-low"]);
  assert.deepEqual(provider.getFallbackModels("Gemini 3.8 Flash (High)"), ["gemini-3.8-flash-high", "gemini-3.7-flash-high", "gemini-3.1-pro-high"]);
  assert.deepEqual(provider.getFallbackModels("gemini-3.1-pro-high"), ["gemini-3.1-pro-high", "gemini-3.8-flash-high", "gemini-3.7-flash-high"]);
  assert.deepEqual(new Provider({ aiProvider: "vertex_ai" }).getFallbackModels("chosen-model"), ["chosen-model"]);
});

test("output overflow switches the actual CLI to Flash 3.8 then Pro without changing the input", async () => {
  const calls = [], progress = [];
  const ai = new Ai({ aiProvider: "antigravity_cli", antigravityModel: "gemini-3.7-flash-high" }, {
    antigravityFactory: () => {
      let model, timeout;
      return { buildCommand: (_prompt, _schema, _cwd, options) => { model = options.modelOverride; timeout = options.timeoutMs; return { args: ["--model", model], timeoutMs: timeout }; }, cancel() {},
        runCli: async ({ cwd, expectedProxyList }) => {
          calls.push({ model, timeout, input: expectedProxyList.map((file) => file.absolutePath), request: fs.readFileSync(`${cwd}/request.txt`, "utf8") });
          if (calls.length === 1) throw Object.assign(new Error("output token limit"), { kind: "output_limit" });
          if (calls.length === 2) throw Object.assign(new Error("No capacity available"), { kind: "capacity" });
          return { stdout: JSON.stringify({ summary: "Action", events: [{ source_start: 2, source_end: 5, description: "A visible action" }] }), viewedProxySet: new Set(["fixture.mp4"]) };
        } };
    }
  });
  const result = await ai.analyzeVideoChunk({ chunkPath: "fixture.mp4", chunkInfo: { sourceStartSec: 0, sourceEndSec: 120 }, onProgress: (value) => progress.push(value) });
  assert.equal(result.events.length, 1);
  assert.deepEqual(calls.map((call) => call.model), ["gemini-3.7-flash-low", "gemini-3.8-flash-low", "gemini-3.1-pro-low"]);
  assert.deepEqual(calls.map((call) => call.timeout), [180000, 180000, 360000]);
  assert.ok(calls.every((call) => JSON.stringify(call.input) === JSON.stringify(calls[0].input) && call.request === calls[0].request));
  assert.deepEqual(progress.filter((item) => item.fallbackTo).map((item) => item.fallbackTo), ["gemini-3.8-flash-low", "gemini-3.1-pro-low"]);
});

test("a valid large Flash 3.8 result is kept rather than discarded for an unnecessary Pro call", async () => {
  const ai = new Ai({ aiProvider: "antigravity_cli", antigravityModel: "gemini-3.7-flash-high" });
  const calls = [];
  ai.providerService.generateJsonFromFiles = async ({ modelOverride }) => {
    calls.push(modelOverride);
    if (calls.length === 1) throw Object.assign(new Error("No capacity available"), { kind: "capacity" });
    return { summary: "Fixture", events: Array.from({ length: 31 }, (_, i) => ({ source_start: i, source_end: i + 1, description: "A".repeat(350) })) };
  };
  assert.equal((await ai.analyzeVideoChunk({ chunkInfo: { sourceStartSec: 0, sourceEndSec: 240 } })).events.length, 31);
  assert.deepEqual(calls, ["gemini-3.7-flash-low", "gemini-3.8-flash-low"]);
});

test("all fallback models failing stops after three calls and preserves the final output limit error", async () => {
  const ai = new Ai({ aiProvider: "antigravity_cli", antigravityModel: "gemini-3.7-flash-high" });
  let calls = 0; const finalError = Object.assign(new Error("output token limit"), { kind: "output_limit" });
  ai.providerService.generateJsonFromFiles = async () => { calls++; throw finalError; };
  await assert.rejects(ai.runVertexCall({ modelOverride: ai.getAnalysisModel(), prompt: "fixture" }), (error) => error === finalError);
  assert.equal(calls, 3);
});

test("model fallback never retries cancellation, credentials, forbidden tools or bad request parameters", async () => {
  for (const failure of [new DOMException("Aborted", "AbortError"), new TypeError("Bad signal"),
    Object.assign(new Error("Credential expired"), { kind: "auth" }), Object.assign(new Error("Forbidden"), { kind: "forbidden_tool" }),
    Object.assign(new Error("No executable"), { kind: "spawn_error" }), new Error("Antigravity chưa xem đủ video đầu vào recap")]) {
    const ai = new Ai({ aiProvider: "antigravity_cli", antigravityModel: "gemini-3.7-flash-high" }); let calls = 0;
    ai.providerService.generateJsonFromFiles = async () => { calls++; throw failure; };
    await assert.rejects(ai.runVertexCall({ modelOverride: ai.getAnalysisModel(), prompt: "fixture" }), (error) => error === failure);
    assert.equal(calls, 1);
  }
});

test("cancelling when fallback is announced prevents the next model from starting", async () => {
  const controller = new AbortController(), ai = new Ai({ aiProvider: "antigravity_cli", antigravityModel: "gemini-3.7-flash-high" }); let calls = 0;
  ai.providerService.generateJsonFromFiles = async () => { calls++; throw Object.assign(new Error("timeout"), { kind: "hard_timeout" }); };
  await assert.rejects(ai.runVertexCall({ modelOverride: ai.getAnalysisModel(), prompt: "fixture", signal: controller.signal,
    onProgress: (value) => { if (value.fallbackTo) controller.abort(); } }), (error) => error.name === "AbortError");
  assert.equal(calls, 1);
});

test("subsequent chunks prefer the successful fallback instead of the previously overloaded model", async () => {
  const ai = new Ai({ aiProvider: "antigravity_cli", antigravityModel: "gemini-3.7-flash-high" }), calls = [];
  ai.providerService.generateJsonFromFiles = async ({ modelOverride }) => {
    calls.push(modelOverride); if (calls.length === 1) throw Object.assign(new Error("No capacity available"), { kind: "capacity" }); return { ok: true };
  };
  const request = { prompt: "fixture", modelOverride: ai.getAnalysisModel() };
  await ai.runVertexCall(request); await ai.runVertexCall(request);
  await ai.runVertexCall({ ...request, modelOverride: ai.getQualityModel() });
  assert.deepEqual(calls, ["gemini-3.7-flash-low", "gemini-3.8-flash-low", "gemini-3.8-flash-low", "gemini-3.7-flash-high"]);
});

test("print timeout can preserve a complete schema-valid result only after verified media coverage", async () => {
  let calls = 0; const messages = [];
  const provider = new Provider({ aiProvider: "antigravity_cli" }, { antigravityFactory: () => ({ buildCommand: () => ({ args: [] }), cancel() {},
    runCli: async () => { calls++; throw Object.assign(new Error("print timeout"), { kind: "print_timeout", stdout: '{"ok":true}', viewedProxySet: new Set(["fixture.mp4"]) }); } }) });
  assert.deepEqual(await provider.generateJsonFromFiles({ filePaths: ["fixture.mp4"], prompt: "fixture", responseSchema: schema, onProgress: (value) => messages.push(value.message) }), { ok: true });
  assert.equal(calls, 1); assert.ok(messages.some((value) => /giữ kết quả hợp lệ/.test(value)));
});

test("print timeout never recovers truncated JSON, unseen media, or an explicit failed result", async () => {
  for (const fixture of [ { stdout: '{"ok":', viewedProxySet: new Set(["fixture.mp4"]) },
    { stdout: '{"ok":true}', viewedProxySet: new Set() },
    { stdout: '{"ok":true}', viewedProxySet: new Set(["fixture.mp4"]), stats: { resultStatus: "ERROR" } } ]) {
    const failure = Object.assign(new Error("Original print timeout"), { kind: "print_timeout", ...fixture });
    const provider = new Provider({ aiProvider: "antigravity_cli" }, { antigravityFactory: () => ({ buildCommand: () => ({ args: [] }), cancel() {}, runCli: async () => { throw failure; } }) });
    await assert.rejects(provider.generateJsonFromFiles({ filePaths: ["fixture.mp4"], prompt: "fixture", responseSchema: schema }), (error) => error === failure || (error.kind === "provider_unavailable" && error.cause === failure));
  }
});

test("structured capacity errors stop the recap child immediately instead of waiting for print timeout", async () => {
  const child = new EventEmitter(); child.pid = 12345;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => { child.killed = true; setImmediate(() => child.emit("close", 1)); };
  const service = new Stage1({}, { spawn: () => child }); service.killChild = (owned) => owned.kill();
  const run = service.runCli({ command: "fixture", args: [], cwd: process.cwd(), timeoutMs: 60000, reportHeartbeat: true });
  child.stdout.write(JSON.stringify({ event: "step_update", step_update: { step_type: "error_message", state: "DONE", content: "API error: UNAVAILABLE (code 503): No capacity available for model" } }) + '\n');
  await assert.rejects(run, (error) => error.kind === "capacity"); assert.equal(child.killed, true);
});

test("an occasional event wholly outside a chunk cannot invalidate its valid anchors or leak into narration references", async () => {
  const ai = new Ai(), progress = []; let calls = 0;
  ai.runVertexCall = async () => { calls++; return { summary: "Fixture", timestamp_basis: "absolute", events: [
    ...Array.from({ length: 18 }, (_, i) => ({ id: `ev${i}`, source_start: i * 10, source_end: i * 10 + 5, description: "Action" })),
    { id: "boundary", source_start: 238, source_end: 243, description: "Crossing the boundary" },
    { id: "outside", source_start: 250, source_end: 260, description: "Outside the chunk" }
  ] }; };
  const result = await ai.analyzeVideoChunk({ chunkInfo: { sourceStartSec: 0, sourceEndSec: 240.25 }, onProgress: (value) => progress.push(value) });
  assert.equal(calls, 1); assert.equal(result.events.length, 19); assert.equal(result.excludedEvents[0].id, "outside");
  assert.ok(result.events.every((event) => event.source_start >= 0 && event.source_end <= 240.25));
  assert.equal(result.events.at(-1).source_end, 240.25);
  assert.ok(!result.events.some((event) => /outside/.test(event.id))); assert.ok(progress.some((value) => /ngoài chunk/.test(value.message)));
});

test("a mostly invalid source timeline triggers recovery instead of silently accepting unrelated events", async () => {
  const ai = new Ai();
  ai.runVertexCall = async () => ({ summary: "Fixture", events: [{ source_start: 2, source_end: 5, description: "Inside" },
    { source_start: 250, source_end: 260, description: "Outside" }, { source_start: 280, source_end: 290, description: "Outside" }] });
  await assert.rejects(ai.analyzeVideoChunk({ chunkInfo: { sourceStartSec: 0, sourceEndSec: 240 } }), (error) => error.kind === "invalid_json");
});

test("one malformed interval from the pasted failure cannot discard an otherwise valid chunk", async () => {
  const ai = new Ai(); let calls = 0;
  ai.runVertexCall = async () => { calls++; return { summary: "Fixture", events: [
    ...Array.from({length: 10}, (_, i) => ({id: `ev${i}`, source_start: i * 10, source_end: i * 10 + 5, description: "Valid action"})),
    {id: "ev11", source_start: 152, source_end: 120.125, description: "Malformed boundary event"}
  ] }; };
  const result = await ai.analyzeVideoChunk({chunkInfo: {sourceStartSec: 0, sourceEndSec: 120.125}});
  assert.equal(calls, 1); assert.equal(result.events.length, 10); assert.equal(result.excludedEvents[0].exclusionReason, "invalid_interval");
});

test("a timeout before any video inspection is a provider outage, not a reason to retry levels or split media", async () => {
  const ai = new Ai({aiProvider: "antigravity_cli", antigravityModel: "gemini-3.8-flash-high"}, {
    antigravityFactory: () => ({buildCommand: () => ({args: []}), cancel() {}, runCli: async () => {
      throw Object.assign(new Error("print timeout"), {kind: "print_timeout", stdout: "", viewedProxySet: new Set()});
    }})
  });
  await assert.rejects(ai.analyzeVideoChunk({chunkPath: "fixture.mp4", chunkInfo: {sourceStartSec: 0, sourceEndSec: 120}}), error => error.kind === "provider_unavailable");
});

test("minute.second values compressed into the first seconds cannot become accepted source anchors", async () => {
  const ai = new Ai();
  ai.runVertexCall = async () => ({ summary: "Whole four-minute story", timestamp_basis: "absolute", events:
    Array.from({ length: 20 }, (_, i) => ({ id: `ev${i}`, source_start: i * .15, source_end: i * .15 + .04, description: "Different story event" })) });
  await assert.rejects(ai.analyzeVideoChunk({ chunkInfo: { sourceStartSec: 0, sourceEndSec: 240, durationSec: 240 } }), error => error.kind === "invalid_json" && /phút.giây/.test(error.message));
  const { validateChunkTimeline } = require("../electron/services/recap/recapTypes");
  assert.doesNotThrow(() => validateChunkTimeline(Array.from({ length: 20 }, (_, i) => ({ source_start: i * 10, source_end: i * 10 + .04 })), { durationSec: 240 }));
});
