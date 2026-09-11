const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src", "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
const renderer = fs.readFileSync(path.join(root, "src", "renderer.js"), "utf8");

for (const category of ["highlight", "story", "podcast", "dubbing"]) {
  assert.ok(html.includes(`data-mode-category-tab="${category}"`), `missing ${category} category tab`);
}

const expectedModeGroups = {
  highlight_cut: "highlight",
  manual_gemini_pro: "highlight",
  story_recut: "story",
  satisfying_storytime: "story",
  diy_story_remix: "story",
  podcast_viral_cut: "podcast",
  dubbing: "dubbing"
};

for (const [mode, group] of Object.entries(expectedModeGroups)) {
  const pattern = new RegExp(`data-mode="${mode}"[^>]*data-mode-group="${group}"`);
  assert.ok(pattern.test(html), `${mode} must stay in ${group}`);
  assert.ok(renderer.includes(`${mode}: {`), `${mode} presentation metadata is missing`);
}

for (const id of [
  "manual-prompt-profile",
  "manual-independent-hook-max",
  "diy-story-angle",
  "podcast-workflow-mode",
  "podcast-output-count"
]) {
  assert.ok(html.includes(`id="${id}"`), `existing control ${id} must be preserved`);
}

assert.ok(html.includes('id="mode-config-empty"'), "mode configuration empty state is missing");
assert.ok(html.includes('class="mode-advanced-options"'), "advanced prompt options disclosure is missing");
assert.ok(css.includes(".mode-workspace"), "mode workspace styles are missing");
assert.ok(css.includes(".mode-card.mode-category-hidden"), "mode category filter styles are missing");
assert.ok(renderer.includes("function syncModeSelectionUi()"), "mode selection sync is missing");
assert.ok(renderer.includes("function selectSetupMode("), "central mode selection handler is missing");

console.log("modeSelectionLayout.test.js: all assertions passed");
