"use strict";

// Regression (2026-10-08): the per-variant progress bar inside each Variant Hub
// card stayed at 0% while the log said "đang ghép nối video". The full-export
// batch never put a percent on its items, and single-variant renders sent no
// variantBatch at all, so the card (which reads queue item percent) never moved.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DubbingService = require("../electron/services/dubbingService");

(async () => {
  // --- Backend: full export of all variants carries per-variant percent/message.
  const variants = ["variant_01", "variant_02"].map((id, index) => ({ id, label: `Variant ${index + 1}`, segments: [], warnings: [] }));
  const project = { id: "p1", mode: "highlight_cut", analysis: { activeVariantId: "variant_01", highlightVariants: variants } };
  const store = {
    getProject: async () => project,
    updateProject: async (_root, _id, patch) => ({ ...project, ...patch })
  };
  const dubbing = new DubbingService(store);
  dubbing.renderHighlightCutProject = async ({ onProgress }) => {
    onProgress({ percent: 40, message: "Đang render cảnh 3/8" });
    onProgress({ percent: 92, message: "Đang ghép nối video" });
    return project;
  };
  const events = [];
  await dubbing.renderAllHighlightCutVariants({ workspaceRoot: "w", projectId: "p1", settings: {}, onProgress: (item) => events.push(item) });
  const concat = events.find((item) => item.variantBatch?.items?.[0]?.message === "Đang ghép nối video");
  assert(concat, "the running item carries the current step message");
  assert.strictEqual(concat.variantBatch.items[0].status, "processing");
  assert.strictEqual(concat.variantBatch.items[0].percent, 92, "the running item carries its own percent (was always missing -> 0%)");
  const secondRunning = events.find((item) => item.variantBatch?.items?.[1]?.status === "processing" && item.variantBatch.items[1].percent === 40);
  assert(secondRunning, "variant 2 has its own percent");
  assert.strictEqual(secondRunning.variantBatch.items[0].percent, 100, "a finished variant shows 100%");

  // --- Renderer: cards are updated by variant id for every running item.
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");
  const fnSource = source.slice(source.indexOf("function updateVariantHubProgress("), source.indexOf("function renderStudioVariantHub("));
  const makeCard = (id) => {
    const nodes = { ".variant-card-progress-bar": { style: {} }, ".progress-pct-text": { textContent: "" }, ".progress-step-text": { textContent: "", title: "" } };
    return { dataset: { highlightVariant: id }, nodes, querySelector: (selector) => nodes[selector] };
  };
  const cards = [makeCard("variant_01"), makeCard("variant_02"), makeCard("variant_03")];
  const context = { el: { variantHubCards: { children: cards } }, state: {} };
  vm.createContext(context);
  vm.runInContext(`${fnSource}; this.update = updateVariantHubProgress;`, context);

  // Single-variant draft of variant #2: one-item queue, no index.
  context.state.variantExportQueue = [{ id: "variant_02", status: "processing", percent: 90, message: "Đang ghép bản nháp Highlight" }];
  context.update({ message: "Đang ghép bản nháp Highlight" });
  assert.strictEqual(cards[1].nodes[".variant-card-progress-bar"].style.width, "90%", "variant #2 card moves (not card #1)");
  assert.strictEqual(cards[1].nodes[".progress-pct-text"].textContent, "90%");
  assert.strictEqual(cards[0].nodes[".variant-card-progress-bar"].style.width, undefined, "other cards untouched");

  // Batch: prefix stripped, percent from the item.
  context.state.variantExportQueue = [
    { id: "variant_01", status: "done", percent: 100 },
    { id: "variant_02", status: "done", percent: 100 },
    { id: "variant_03", status: "processing", percent: 37, message: "Nháp 3/3 · Đang render nháp Highlight 4/9" }
  ];
  context.update({});
  assert.strictEqual(cards[2].nodes[".progress-pct-text"].textContent, "37%");
  assert.strictEqual(cards[2].nodes[".progress-step-text"].textContent, "Đang render nháp Highlight 4/9");

  // The onProgress fallback for payloads without variantBatch exists.
  assert(/Single-variant renders[\s\S]{0,400}running\[0\]\.percent = Math\.max/.test(source), "plain progress updates the single running queue item");

  console.log("variantHubProgress tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
