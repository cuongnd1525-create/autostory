const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ConfiguredAiWorkflowService = require("../electron/services/configuredAiWorkflowService");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src", "index.html"), "utf8");
const renderer = fs.readFileSync(path.join(root, "src", "renderer.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "electron", "preload.js"), "utf8");
const main = fs.readFileSync(path.join(root, "electron", "main.js"), "utf8");

const gemini = ConfiguredAiWorkflowService.providerDescriptor({
  aiProvider: "gemini",
  geminiApiKey: "test-key",
  geminiModel: "gemini-test"
});
assert.deepStrictEqual(gemini, { provider: "gemini", label: "Gemini", model: "gemini-test" });

const antigravity = ConfiguredAiWorkflowService.providerDescriptor({
  aiProvider: "antigravity_cli",
  antigravityModel: "agy-test"
});
assert.deepStrictEqual(antigravity, { provider: "antigravity_cli", label: "Antigravity", model: "agy-test" });

assert.throws(
  () => ConfiguredAiWorkflowService.providerDescriptor({ aiProvider: "ollama_local" }),
  /chưa được dùng cho phân tích package video đa phương thức/
);
assert.throws(
  () => ConfiguredAiWorkflowService.providerDescriptor({ aiProvider: "gemini" }),
  /chưa có API key/
);

[
  "create-and-run-stage1-ai",
  "configured-ai-auto-level",
  "configured-ai-auto-status",
  "vertex-auto-pipeline",
  "stage1-ai-provider-badge",
  "draft-review-actions",
  "run-configured-draft-review",
  "cancel-configured-draft-review",
  "open-configured-draft-review-result",
  "import-configured-draft-review"
].forEach((id) => {
  assert(html.includes(`id="${id}"`), `Missing configured AI UI id: ${id}`);
  assert.strictEqual((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `Duplicate UI id: ${id}`);
});

assert(renderer.includes("createAndRunConfiguredStage1"));
assert(renderer.includes("runConfiguredDraftReview"));
assert(renderer.includes("reviewAllDraftVariantsWithConfiguredAi"));
assert(renderer.includes("skipConfirm: true"));
assert(preload.includes('analysis:runConfiguredAiStage1'));
assert(preload.includes('project:runConfiguredAiDraftReview'));
assert(main.includes('handleIpc("analysis:runConfiguredAiStage1"'));
assert(main.includes('handleIpc("project:runConfiguredAiDraftReview"'));

console.log("configuredAiWorkflow tests passed");
