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
assert.ok(source.includes("first 3 seconds contain only driving"));

console.log("highlight prompt template tests passed");
