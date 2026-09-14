const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src", "index.html"), "utf8");
const renderer = fs.readFileSync(path.join(root, "src", "renderer.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "electron", "preload.js"), "utf8");
const main = fs.readFileSync(path.join(root, "electron", "main.js"), "utf8");

for (const id of [
  "run-manual-antigravity-stage1",
  "cancel-manual-antigravity-stage1",
  "open-manual-antigravity-result",
  "manual-antigravity-stage1-status"
]) {
  assert(html.includes(`id="${id}"`), `missing UI control ${id}`);
}
assert(html.includes("manual-draft-review-only"), "Antigravity controls must be scoped to the draft-review mode");
assert(renderer.includes("applyAntigravityVariantSelection"), "valid outputs must be routed into the existing JSON selection");
assert(renderer.includes('"story_spine_edit_script"'), "Story Spine V1 output must be accepted by the JSON selector");
assert(renderer.includes("isManualGeminiV1Artifact(item)"), "manual and Antigravity selectors must share V1 validation");
assert(renderer.includes("runManualAntigravityStage1"));
assert(renderer.includes("cancelManualAntigravityStage1"));
assert(preload.includes('analysis:runManualAntigravityStage1'));
assert(preload.includes('analysis:cancelManualAntigravityStage1'));
assert(main.includes('handleIpc("analysis:runManualAntigravityStage1"'));
assert(main.includes('handleIpc("analysis:cancelManualAntigravityStage1"'));

console.log("manualAntigravityStage1Ui tests passed");
