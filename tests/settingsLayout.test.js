const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src", "index.html"), "utf8");
const renderer = fs.readFileSync(path.join(root, "src", "renderer.js"), "utf8");

const requiredUniqueIds = [
  "ai-provider",
  "ollama-vision-assist",
  "ollama-vision-model",
  "gemini-api-key",
  "gemini-model",
  "vertex-project-id",
  "vertex-credential-path",
  "vertex-bucket",
  "vertex-analysis-model",
  "vertex-quality-model",
  "vertex-budget-usd",
  "test-vertex",
  "antigravity-command",
  "antigravity-model",
  "workspace-root",
  "export-root",
  "gemini-analysis-root",
  "whisper-engine",
  "default-voice-provider",
  "dubbing-render-mode"
];

for (const id of requiredUniqueIds) {
  const matches = html.match(new RegExp(`id=["']${id}["']`, "g")) || [];
  assert.strictEqual(matches.length, 1, `${id} must exist exactly once`);
}

for (const tab of ["ai", "storage", "speech", "voice", "render"]) {
  assert(html.includes(`data-settings-tab="${tab}"`), `missing settings tab ${tab}`);
  assert(html.includes(`data-settings-panel="${tab}"`), `missing settings panel ${tab}`);
}

const firstStepStart = html.indexOf('data-step-panel="1"');
const secondStepStart = html.indexOf('data-step-panel="2"');
const firstStepHtml = html.slice(firstStepStart, secondStepStart);
assert(!firstStepHtml.includes('id="ai-provider"'), "AI provider must not remain in setup step 1");
assert(!firstStepHtml.includes('id="ollama-vision-assist"'), "Ollama settings must not remain in setup step 1");

assert(renderer.includes("function setSettingsTab("), "settings tabs need an explicit controller");
assert(renderer.includes("function syncAiProviderSettingsUi("), "provider-specific settings need an explicit controller");

const writeDraftBlock = renderer.slice(
  renderer.indexOf("function writeSetupDraft()"),
  renderer.indexOf("function applySetupDraft(")
);
assert(!writeDraftBlock.includes("aiProvider:"), "setup draft must not persist the global AI provider");
assert(!writeDraftBlock.includes("ollamaVisionAssist:"), "setup draft must not persist global Ollama settings");

const applyDraftBlock = renderer.slice(
  renderer.indexOf("function applySetupDraft("),
  renderer.indexOf("function resetSetupStep(")
);
assert(!applyDraftBlock.includes("draft.aiProvider"), "setup draft must not overwrite the saved AI provider");
assert(!applyDraftBlock.includes("draft.ollamaVision"), "setup draft must not overwrite saved Ollama settings");

console.log("settingsLayout.test.js passed");
