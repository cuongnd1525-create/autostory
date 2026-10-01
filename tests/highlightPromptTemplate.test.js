const assert = require("assert");
const fs = require("fs");
const path = require("path");

const rendererPath = path.join(__dirname, "..", "src", "renderer.js");
const source = fs.readFileSync(rendererPath, "utf8");
const start = source.indexOf("function buildDirectHighlightGeminiPromptTemplate()");
const end = source.indexOf("function buildHighlightGeminiPromptTemplate()", start);

assert.ok(start >= 0 && end > start, "Missing direct Highlight prompt builder");
const directPromptSource = source.slice(start, end);
assert.ok(directPromptSource.includes("true-crime storyteller, and viral TikTok short-form editor"));
assert.ok(directPromptSource.includes("THE CURIOSITY GAP HOOK"));
assert.ok(directPromptSource.includes("THE \"TIMELINE RESET\" DOCUMENTARY SETUP"));
assert.ok(directPromptSource.includes("Narrated Raw Reality"));
assert.ok(directPromptSource.includes("The Viral Mini-Doc / Deep Dive"));
assert.ok(directPromptSource.includes("The 80/20 High-Retention Reality"));
assert.ok(directPromptSource.includes("Return exactly three independent Markdown JSON code blocks"));
assert.ok(directPromptSource.includes("el.sourceDownloadUrl?.value.trim()"));
assert.ok(/if\s*\(isHighlightCutMode\(\)\)\s*{\s*prompt\s*=\s*buildDirectHighlightGeminiPromptTemplate\(\);/.test(source));
assert.ok(source.includes("return withUiGeminiInputAccessGate(prompt);"));
assert.ok(source.includes("STEP 0 - VERIFIED INPUT ACCESS GATE"));
assert.ok(source.includes("SEMANTIC HOOK TOURNAMENT - MUST RUN BEFORE STORY SELECTION"));
assert.ok(source.includes("VIRAL MOMENT INVENTORY - MUST PRECEDE THE TIMELINE"));
assert.ok(source.includes("rage_irony"));
assert.ok(source.includes("voiceover_with_ambient"));
assert.ok(source.includes("function buildViralTikTokCrimePart1PromptTemplate"));
assert.ok(source.includes("viral_tiktok_crime_part1"));
assert.ok(source.includes("8-BEAT ALTERNATING SANDWICH"));
assert.ok(source.includes("suggestedTitle"));
assert.ok(source.includes("viral_green"));
assert.ok(source.includes("tiktok_karaoke"));
assert.ok(source.includes("CAM 1"));
assert.ok(source.includes("TikTok Viral Bodycam (Part 1 - 8 nhịp xen kẽ · 110-125s)"));

assert.ok(source.includes("const maximumFiles = getRequestedIndependentScriptIds().length;"));
assert.ok(source.includes("const requestedIndependentCount = getRequestedIndependentScriptIds().length;"));

const { isStorySpineScript } = require("../electron/services/storySpineCompilerService");
const { detectGeminiArtifact } = require("../electron/services/geminiJsonArtifactService");

const hybridScript = {
  artifactType: "highlight_cut_script",
  narrativeBeats: [
    { beatId: 1, role: "hook", durationSec: 13.5 }
  ],
  segments: [
    { segmentId: 1, sourceStartSec: 10, sourceEndSec: 20, startSec: 0, endSec: 10 }
  ]
};

assert.strictEqual(isStorySpineScript(hybridScript), false, "Script with segments must not be treated as Story Spine script");
const detected = detectGeminiArtifact(hybridScript);
assert.strictEqual(detected.type, "story_recut_script");
assert.strictEqual(detected.segmentCount, 1);

console.log("highlight prompt template tests passed");
