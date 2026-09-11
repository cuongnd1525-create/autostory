const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src", "index.html"), "utf8");
const renderer = fs.readFileSync(path.join(root, "src", "renderer.js"), "utf8");

const promptIndex = html.indexOf("prompt-template-card");
const jsonPickerIndex = html.indexOf('id="story-script-path"');
assert(promptIndex >= 0, "Gemini prompt card must exist");
assert(jsonPickerIndex >= 0, "Gemini JSON picker must exist");
assert(promptIndex < jsonPickerIndex, "Gemini prompt must be shown before the JSON picker");

for (const method of ["local", "url"]) {
  assert(html.includes(`data-source-method="${method}"`), `missing source method ${method}`);
  assert(html.includes(`data-source-method-panel="${method}"`), `missing source panel ${method}`);
}

for (const id of [
  "source-video-path",
  "source-download-url",
  "source-active-badge",
  "source-selection-summary",
  "source-selection-label",
  "source-selection-detail"
]) {
  const matches = html.match(new RegExp(`id=["']${id}["']`, "g")) || [];
  assert.strictEqual(matches.length, 1, `${id} must exist exactly once`);
}

assert(renderer.includes("function setSourceMethod("), "source method tabs need a controller");
assert(renderer.includes("function updateSourceSelectionUi("), "active source needs a status controller");
assert(renderer.includes('dataset.sourceKind = "url"'), "downloaded sources must be marked as URL sources");
assert(renderer.includes('dataset.sourceKind = "local"'), "folder sources must be marked as local sources");
assert(renderer.includes("URL mới chưa được tải; pipeline vẫn dùng file trên"), "pending URLs must not silently replace the active source");

console.log("sourceInputUx.test.js passed");
