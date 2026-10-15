const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const Discovery = require("../electron/services/antigravityModelDiscovery");
const Provider = require("../electron/services/recap/recapProviderService");
const Ai = require("../electron/services/recap/recapAiService");
const Catalog = require("../src/antigravityModelCatalog");
const current = `Fetching available models...
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)`;
const models = Discovery.parseModels(current);

test("live CLI inventory excludes retired Flash/Pro and distinguishes legacy aliases from available choices", () => {
  assert.equal(models.length, 6);
  Catalog.setAvailableModels(models);
  try {
    assert.deepEqual(Catalog.getAvailableFamilies().map((family) => family.id), ["gemini-3.8-flash", "claude-sonnet-4.6", "claude-opus-4.6", "gpt-oss-120b"]);
    assert.equal(Catalog.parseModel("gemini-3.7-flash-low").familyId, "gemini-3.7-flash");
    assert.equal(Catalog.resolveModel("gemini-3.7-flash", "low"), "");
    assert.equal(Catalog.resolveModel("claude-sonnet-4.6", "thinking"), "claude-sonnet-4-6");
  } finally { Catalog.setAvailableModels(null); }
});

test("CLI discovery preserves the configured executable, rejects empty responses and cancels its own process", async () => {
  const controller = new AbortController(); let spawned, child;
  const promise = Discovery.query({ antigravityCommand: '"C:\\custom path\\agy.exe"' }, { signal: controller.signal, spawnImpl: (command, args, options) => {
    spawned = { command, args, options }; child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; }; return child;
  } });
  controller.abort(); await assert.rejects(promise, (error) => error.name === "AbortError");
  assert.equal(child.killed, true); assert.equal(spawned.command, 'C:\\custom path\\agy.exe'); assert.deepEqual(spawned.args, ["models"]); assert.equal(spawned.options.windowsHide, true);
  const empty = Discovery.query({}, { spawnImpl: () => { const process = new EventEmitter(); process.stdout = new PassThrough(); process.stderr = new PassThrough(); process.kill = () => {};
    setImmediate(() => process.emit("close", 0)); return process; } });
  await assert.rejects(empty, (error) => error.kind === "model_discovery_failed");
});

test("retired primary and fallback models are replaced before any analysis call; GPT-OSS is not a video fallback", async () => {
  const ai = new Ai({ aiProvider: "antigravity_cli", antigravityModel: "gemini-3.7-flash-high" }, { modelDiscovery: { list: async () => models } });
  const calls = [];
  ai.providerService.generateJsonFromFiles = async ({ modelOverride }) => { calls.push(modelOverride); if (calls.length < 3) throw Object.assign(new Error("output token limit"), { kind: "output_limit" });
    return { summary: "Fixture", events: [{ source_start: 2, source_end: 5, description: "Action" }] }; };
  const result = await ai.analyzeVideoChunk({ chunkPath: "fixture.mp4", chunkInfo: { sourceStartSec: 0, sourceEndSec: 120 } });
  assert.equal(result.events.length, 1); assert.deepEqual(calls, ["gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high"]);
});

test("a model removed between discovery and execution is excluded after one forced refresh", async () => {
  let discoveries = 0; const calls = [];
  const removed = Discovery.parseModels('gemini-3.7-flash-low\tGemini 3.7 Flash (Low)');
  const ai = new Ai({ aiProvider: "antigravity_cli", antigravityModel: "gemini-3.7-flash-high" }, { modelDiscovery: { list: async (_settings, options) => {
    discoveries++; if (discoveries > 1) assert.equal(options.force, true); return discoveries === 1 ? removed : models;
  } } });
  ai.providerService.generateJsonFromFiles = async ({ modelOverride }) => { calls.push(modelOverride); if (calls.length === 1) throw Object.assign(new Error("invalid model selection"), { kind: "invalid_model" }); return { ok: true }; };
  assert.deepEqual(await ai.runVertexCall({ filePaths: ["fixture.mp4"], modelOverride: ai.getAnalysisModel(), prompt: "fixture" }), { ok: true });
  assert.deepEqual(calls, ["gemini-3.7-flash-low", "gemini-3.8-flash-low"]); assert.equal(discoveries, 2);
});

test("failed discovery and a text-only inventory cannot invoke an unverified video model", async () => {
  for (const list of [async () => { throw Object.assign(new Error("Discovery offline"), { kind: "model_discovery_failed" }); }, async () => models.filter((entry) => !/^gemini-/.test(entry.familyId))]) {
    const ai = new Ai({ aiProvider: "antigravity_cli" }, { modelDiscovery: { list } }); let calls = 0;
    ai.providerService.generateJsonFromFiles = async () => { calls++; return { ok: true }; };
    await assert.rejects(ai.runVertexCall({ filePaths: ["fixture.mp4"], prompt: "fixture" }), (error) => ["model_discovery_failed", "no_available_model"].includes(error.kind)); assert.equal(calls, 0);
  }
});

test("all supported models exhausted produces a capacity error instead of cycling to removed IDs", async () => {
  const ai = new Ai({ aiProvider: "antigravity_cli", antigravityModel: "gemini-3.8-flash-high" }, { modelDiscovery: { list: async () => models } }); let calls = 0;
  ai.providerService.generateJsonFromFiles = async () => { calls++; throw Object.assign(new Error("UNAVAILABLE 503 No capacity available"), { kind: "capacity" }); };
  await assert.rejects(ai.runVertexCall({ filePaths: ["fixture.mp4"], modelOverride: ai.getAnalysisModel(), prompt: "fixture" }), (error) => error.kind === "provider_unavailable"); assert.equal(calls, 1);
});
