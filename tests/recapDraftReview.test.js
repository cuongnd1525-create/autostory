const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const Reviewer = require("../electron/services/recap/recapDraftReviewService");
const Ai = require("../electron/services/recap/recapAiService");
test("long draft review covers all media and resumes completed parts after a provider failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-review-parts-"));
  try {
    const file = path.join(root, "draft.mp4"); await fs.writeFile(file, "fixture");
    const reviewer = new Reviewer({}, { media: { probeVideo: async () => ({ duration: 204 }),
      extractProxyChunk: async ({ chunk }) => `part-${chunk.sourceStartSec}.mp4` } });
    const seen = []; let unavailable = true;
    const request = { draftVideoPath: file, decisions: [], storyModel: {} };
    const single = async args => { seen.push(args.reviewWindow.start);
      if (args.reviewWindow.start === 70 && unavailable) throw new Error("Provider unavailable");
      return { overall_score: args.reviewWindow.start === 140 ? .8 : .9, summary: "Observed", issues: [] };
    };
    await assert.rejects(reviewer.review(request, single)); unavailable = false;
    const result = await reviewer.review(request, single);
    assert.deepEqual(seen, [0, 70, 70, 140]); assert.equal(result.overall_score, .8);
    assert.deepEqual(result.coverage, [{ start: 0, end: 72 }, { start: 70, end: 142 }, { start: 140, end: 204 }]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("excerpt issue clocks become absolute and out-of-excerpt defects cannot be accepted", async () => {
  const ai = new Ai(); let outputEnd = 5;
  ai.runVertexCall = async () => ({ overall_score: .8, summary: "Observed", timestamp_mode: "relative", issues: [{ severity: "high",
    type: "semantic_alignment", output_start: 3, output_end: outputEnd, description: "Observed mismatch", recommended_action: "Fix" }] });
  const request = { draftVideoPath: "fixture.mp4", decisions: [], reviewWindow: { start: 70, end: 142, duration: 204, index: 1, count: 3 } };
  const result = await ai.reviewDraftSingle(request);
  assert.equal(result.issues[0].output_start, 73); assert.equal(result.issues[0].output_end, 75);
  outputEnd = 90; await assert.rejects(ai.reviewDraftSingle(request), /ngoài đoạn/);
});
