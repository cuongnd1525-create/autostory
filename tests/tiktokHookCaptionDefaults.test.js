"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const renderer = fs.readFileSync(path.join(root, "src", "renderer.js"), "utf8");
const html = fs.readFileSync(path.join(root, "src", "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");

// Viral/manual Gemini import must no longer auto-burn PART 1/2/3 into the video.
assert(renderer.includes('if (el.partLabelEnabled) el.partLabelEnabled.checked = false;'));
assert(renderer.includes('if (el.partLabelText) el.partLabelText.value = "";'));
assert(!renderer.includes('if (el.partLabelEnabled) el.partLabelEnabled.checked = true;\n      if (el.partLabelStyle) el.partLabelStyle.value = "viral_green";'));

// The default viral caption is the new TikTok hook style with safer sizing/placement.
assert(renderer.includes('if (el.topCaptionStyle) el.topCaptionStyle.value = "tiktok_hook";'));
assert(renderer.includes('if (el.topCaptionFontSize) el.topCaptionFontSize.value = "64";'));
assert(renderer.includes('if (el.topCaptionY) el.topCaptionY.value = "11";'));
assert(renderer.includes('"titleStyle": "tiktok_hook"'));
assert(renderer.includes('suggestedTitle/title must be a concise 4-8 word cold-viewer hook'));

// UI and preview styling exist and do not reuse the old solid green box.
assert(html.includes('<option value="tiktok_hook">TikTok Hook (2 dòng, trắng/vàng, viền đen)</option>'));
assert(css.includes('.video-title-overlay.tiktok-hook'));
assert(css.includes('.video-title-overlay.tiktok-hook .hook-caption-line.accent'));
assert(css.includes('color: #ffe600;'));

console.log("tiktokHookCaptionDefaults tests passed");
