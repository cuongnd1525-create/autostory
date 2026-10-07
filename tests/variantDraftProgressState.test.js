"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const renderer = fs.readFileSync(path.join(root, "src", "renderer.js"), "utf8");
const dubbing = fs.readFileSync(path.join(root, "electron", "services", "dubbingService.js"), "utf8");

// Backend contract: every queue item owns its own progress state.
assert(dubbing.includes('status: "waiting",\n      percent: 0,\n      message: "Đang chờ"'));
assert(dubbing.includes("variantBatch[variantIndex].percent = Math.round(localPercent)"));
assert(dubbing.includes("variantBatch[variantIndex].message = localMessage"));
assert(dubbing.includes("variantBatch[variantIndex].percent = 100"));

// Regression: concurrent cards must never derive local progress from global average.
// The old formula turned overall=71 for 3 variants into 113=>100 for index 1.
assert(!renderer.includes("const computed = Math.round((Number(state.variantProgress.percent || 0) * total) - (index * 100))"));
assert(!renderer.includes("const computed = Math.round((pct * total) - (activeIdx * 100))"));
assert(renderer.includes("Number(queueItem?.percent ?? 0)"));
assert(renderer.includes("String(queueItem?.message || payload.message ||"));
assert(renderer.includes("Đã hoàn tất ${completed}/${items.length} · Đang render"));

// Sanity demonstration of the screenshot state:
// variants #1/#3 done and #2=13% => overall rounds to 71%, but #2 must remain 13%.
const local = [100, 13, 100];
const overall = Math.round(local.reduce((a, b) => a + b, 0) / local.length);
assert.strictEqual(overall, 71);
assert.strictEqual(local[1], 13);

console.log("variantDraftProgressState tests passed");
