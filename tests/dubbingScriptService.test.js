const assert = require("assert");
const { normalizeStorytimeScript } = require("../electron/services/dubbingScriptService");

const normalized = normalizeStorytimeScript({
  title: "Story",
  top_banner_text: "A Gemini story banner",
  language: "en",
  segments: [
    {
      sourceStartSec: 0,
      sourceEndSec: 5,
      voiceover_text: "A short narration line."
    },
    {
      startSec: 5,
      endSec: 10.4,
      audio_mode: "original_audio",
      text: ""
    }
  ]
}, 10);

assert.strictEqual(normalized.segments.length, 2);
assert.strictEqual(normalized.topHeader, "A Gemini story banner");
assert.strictEqual(normalized.segments[0].dubbingLine, "A short narration line.");
assert.strictEqual(normalized.segments[1].audioMode, "original_audio");
assert.strictEqual(normalized.segments[1].endSec, 10);
assert.ok(normalized.warnings.some((warning) => warning.includes("đã tự co endSec")));

assert.throws(() => normalizeStorytimeScript({
  segments: [
    { startSec: 0, endSec: 5, text: "First" },
    { startSec: 4, endSec: 6, text: "Overlap" }
  ]
}, 10), /chồng timeline/);

assert.throws(() => normalizeStorytimeScript({
  segments: [{ startSec: 0, endSec: 5, audio_mode: "voiceover_only", text: "" }]
}, 10), /thiếu text/);

console.log("dubbing script service tests passed");
