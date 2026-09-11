const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src", "index.html"), "utf8");
const renderer = fs.readFileSync(path.join(root, "src", "renderer.js"), "utf8");
const main = fs.readFileSync(path.join(root, "electron", "main.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "electron", "preload.js"), "utf8");

assert.match(html, /data-mode="vertex_auto_story"/);
assert.match(html, /id="auto-story-target-min"[^>]*min="65"[^>]*value="65"/);
assert.match(html, /id="auto-story-output-count"/);
assert.match(renderer, /isAutoStoryMode\(setupMode\)[\s\S]{0,120}\? "vertex_auto_story"/);
assert.match(renderer, /runAutoStoryPipeline\(created\.project\.id\)/);
assert.match(main, /ipcMain\.handle\("autoStory:run"/);
assert.match(preload, /runAutoStoryPipeline/);
assert.match(html, /id="auto-story-status"/);
assert.match(renderer, /function renderAutoStoryStatus\(/);
assert.match(renderer, /button\.classList\.toggle\("hidden", !unfinished\)/);
assert.match(main, /project: reviewingProject/);
assert.match(renderer, /Bản cuối đạt kiểm tra/);
assert.match(renderer, /resumeAutoStoryProject\(id\)/);
assert.match(renderer, /Đang kết thúc tác vụ/);
assert.match(preload, /projectId, options/);
console.log("autoStoryUi tests passed");
