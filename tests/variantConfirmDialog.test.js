const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const renderer = fs.readFileSync(path.join(root, "src", "renderer.js"), "utf8");
const html = fs.readFileSync(path.join(root, "src", "index.html"), "utf8");

assert.ok(html.includes('id="confirm-action-modal"'));
assert.ok(html.includes('id="confirm-action-message"'));
assert.ok(html.includes('id="submit-confirm-action"'));
assert.ok(renderer.includes("function showConfirmAction("));
assert.ok(renderer.includes('title: "Xuất tất cả variant?"'));
assert.ok(renderer.includes('title: "Render nháp tất cả variant?"'));
assert.ok(!renderer.includes("window.confirm("));

console.log("variant confirm dialog tests passed");
