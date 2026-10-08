"use strict";

// Settings: agy model + reasoning are chosen from agy's own list instead of
// free text. Regression for the real run 2026-10-08 09:20: the field held
// "Gemini 3.7 Flash", the host added --effort high and agy rejected all 9 map
// processes ("--effort is not supported for model ...").

const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const vm = require("vm");

const Catalog = require("../src/antigravityModelCatalog");
const ConfigStore = require("../electron/services/configStore");
const Stage1 = require("../electron/services/manualAntigravityStage1Service");

// The exact "Available models" list printed by agy (CLI log 2026-10-07 14:51:25).
const AGY_AVAILABLE = [
  "Gemini 3.8 Flash (High)", "Gemini 3.8 Flash (Medium)", "Gemini 3.8 Flash (Low)",
  "Gemini 3.7 Flash (High)", "Gemini 3.7 Flash (Medium)", "Gemini 3.7 Flash (Low)",
  "Gemini 3.6 Flash (High)", "Gemini 3.6 Flash (Medium)", "Gemini 3.6 Flash (Low)",
  "Gemini 3.1 Pro (High)", "Gemini 3.1 Pro (Low)",
  "Claude Sonnet 4.6 (Thinking)", "Claude Opus 4.6 (Thinking)", "GPT-OSS 120B (Medium)"
];

(async () => {
  const offered = Catalog.FAMILIES.flatMap((family) => family.reasoning.map((level) => Catalog.agyLabel(family, level)));
  assert.deepStrictEqual(offered, AGY_AVAILABLE, "the selects offer exactly agy's model list");

  for (const label of AGY_AVAILABLE) {
    const value = Catalog.normalizeModel(label);
    assert.strictEqual(Catalog.displayName(value), label, `${label} round-trips`);
    const cmd = new Stage1({ antigravityCommand: "agy", antigravityModel: value }).buildCommand("p", "s.json", os.tmpdir());
    assert(cmd.args.includes(value), `${label}: --model ${value}`);
    assert(!cmd.args.includes("--effort"), `${label}: never --effort`);
  }
  assert.strictEqual(Catalog.resolveModel("gemini-3.7-flash", "medium"), "gemini-3.7-flash-medium");
  assert.strictEqual(Catalog.resolveModel("gemini-3.1-pro", "medium"), "gemini-3.1-pro-high", "unsupported level falls back to a level the model has");
  assert.strictEqual(Catalog.resolveModel("", "high"), "", "empty = agy default model");
  assert.deepStrictEqual(Catalog.parseModel("Gemini 3.7 Flash", "low"), { familyId: "gemini-3.7-flash", reasoning: "low", known: true });
  assert.strictEqual(Catalog.parseModel("Gemini 2.5 Pro (High)").known, false, "values agy does not list stay visible as legacy");
  assert.strictEqual(Catalog.normalizeModel("Gemini 2.5 Pro (High)"), "Gemini 2.5 Pro (High)", "unknown values pass through unchanged");

  // Map / reduce stage models follow the selection + reasoning too.
  const stage = new Stage1({ antigravityCommand: "agy", antigravityModel: "gemini-3.8-flash-high", antigravityReasoning: "low" });
  const mapCmd = stage.buildCommand("p", "s.json", os.tmpdir(), { modelOverride: "Gemini 3.7 Flash" });
  assert(mapCmd.args.includes("gemini-3.7-flash-low") && !mapCmd.args.includes("--effort"));

  // Saved free-text values are migrated on load.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-config-"));
  const configPath = path.join(dir, "config.json");
  await fs.writeFile(configPath, JSON.stringify({ antigravityModel: "Gemini 3.7 Flash", antigravityMapModel: "Gemini 3.1 Pro (Low)", antigravityTimeoutMs: 900000 }), "utf8");
  const store = new ConfigStore(configPath, path.join(dir, "workspace"));
  const loaded = await store.ensureLoaded();
  assert.strictEqual(loaded.antigravityModel, "gemini-3.7-flash-high");
  assert.strictEqual(loaded.antigravityReasoning, "high");
  assert.strictEqual(loaded.antigravityMapModel, "gemini-3.1-pro-low");
  assert.strictEqual(JSON.parse(await fs.readFile(configPath, "utf8")).antigravityModel, "gemini-3.7-flash-high", "migration persisted");
  await fs.rm(dir, { recursive: true, force: true });

  // Renderer helpers: model + reasoning selects (minimal DOM stub, real renderer code).
  const html = await fs.readFile(path.join(__dirname, "..", "src", "index.html"), "utf8");
  assert(/<select id="antigravity-model"><\/select>/.test(html), "model is a select");
  assert(/<select id="antigravity-reasoning"><\/select>/.test(html), "reasoning is a select");
  assert(!/id="antigravity-model" type="text"/.test(html), "no free-text model field");
  assert(html.indexOf("antigravityModelCatalog.js") < html.indexOf("renderer.js"), "catalog script loads before renderer.js");
  const rendererSource = await fs.readFile(path.join(__dirname, "..", "src", "renderer.js"), "utf8");
  const helpers = rendererSource.slice(rendererSource.indexOf("const LEGACY_AGY_MODEL_PREFIX"), rendererSource.indexOf("function readSettings() {"));
  const makeSelect = () => ({
    options: [], value: "", disabled: false,
    set innerHTML(_v) { this.options = []; },
    appendChild(option) { this.options.push(option); if (this.options.length === 1) this.value = option.value; }
  });
  const context = {
    window: { AntigravityModelCatalog: Catalog },
    document: { createElement: () => ({ value: "", textContent: "" }) },
    el: { antigravityModel: makeSelect(), antigravityReasoning: makeSelect() },
    state: { settings: { antigravityReasoning: "high" } }
  };
  vm.createContext(context);
  vm.runInContext(`${helpers}; this.fill = fillAntigravityModelSelects; this.read = readAntigravityModelSelects; this.fillReasoning = fillAntigravityReasoningSelect;`, context);
  context.fill("Gemini 3.7 Flash", "high");
  assert.strictEqual(context.el.antigravityModel.value, "gemini-3.7-flash");
  assert.deepStrictEqual(context.el.antigravityReasoning.options.map((option) => option.value), ["high", "medium", "low"]);
  context.el.antigravityReasoning.value = "medium";
  assert.deepStrictEqual(JSON.parse(JSON.stringify(context.read())), { antigravityModel: "gemini-3.7-flash-medium", antigravityReasoning: "medium" });
  context.el.antigravityModel.value = "claude-opus-4.6";
  context.fillReasoning("claude-opus-4.6", "medium");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(context.read())), { antigravityModel: "Claude Opus 4.6 (Thinking)", antigravityReasoning: "thinking" });
  assert.strictEqual(context.el.antigravityReasoning.disabled, true, "single-level models lock the reasoning select");
  context.fill("", "high");
  assert.strictEqual(context.read().antigravityModel, "", "agy default model");
  context.fill("Gemini 2.5 Pro (High)", "high");
  assert.strictEqual(context.read().antigravityModel, "Gemini 2.5 Pro (High)", "unlisted saved value is kept, not silently dropped");
  assert(context.el.antigravityModel.options.some((option) => /không có trong danh sách agy/.test(option.textContent)));

  console.log("antigravityModelCatalog tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
