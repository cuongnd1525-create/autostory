const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const Reviewer = require("../electron/services/recap/recapDraftReviewService");
const Ai = require("../electron/services/recap/recapAiService");
test("long review preserves the weakest score and critical defects, and duration preferences invalidate review cache", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-quality-first-"));
  try {
    const file = path.join(root, "draft.mp4"); await fs.writeFile(file, "fixture");
    const reviewer = new Reviewer({}, { media: { probeVideo: async () => ({ duration: 650 }), extractProxyChunk: async () => "excerpt.mp4" } });
    let calls = 0;
    const single = async request => { calls++; return { overall_score: request.reviewWindow.index === 2 ? .76 : .95,
      summary: "Observed", issues: request.reviewWindow.index === 2 ? [{ severity: "critical", description: "Unsupported payoff" }] : [],
      duration_assessment: { verdict: "appropriate", reason: "A complete focused story." } }; };
    const request = { draftVideoPath: file, decisions: [], storyModel: {}, editorialContext: { qualityFirst: true, duration: { target: 900 } } };
    const editorial = async () => ({ overall_score: .9, summary: "Complete story", issues: [],
      duration_assessment: { verdict: "appropriate", reason: "A complete focused story." } });
    const result = await reviewer.review(request, single, editorial);
    assert.equal(result.overall_score, .76); assert.equal(result.issues[0].severity, "critical");
    assert.equal(result.issues[0].downgradedFrom, undefined);
    assert.equal(result.duration_assessment.reason, "A complete focused story.");
    const originalCalls = calls;
    await reviewer.review(request, single, editorial); assert.equal(calls, originalCalls);
    await reviewer.review({ ...request, editorialContext: { ...request.editorialContext, duration: { target: 1000 } } }, single, editorial);
    assert.equal(calls, originalCalls * 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("quality-first review evaluates the real draft and requires a duration rationale", async () => {
  const ai = new Ai(); let includeAssessment = true;
  ai.runVertexCall = async request => {
    assert.deepEqual(request.filePaths, ["real-draft.mp4"]);
    assert.match(request.prompt, /Duration is a soft preference/);
    assert.match(request.prompt, /do not.*inflate scores/i);
    assert.ok(request.responseSchema.required.includes("duration_assessment"));
    return { overall_score: .86, summary: "Engaging", issues: [], ...(includeAssessment
      ? { duration_assessment: { verdict: "appropriate", reason: "Complete without redundant exposition." } } : {}) };
  };
  const request = { draftVideoPath: "real-draft.mp4", decisions: [], editorialContext: { qualityFirst: true, duration: { target: 900, actual: 750 } } };
  assert.equal((await ai.reviewDraftSingle(request)).duration_assessment.verdict, "appropriate");
  includeAssessment = false; await assert.rejects(ai.reviewDraftSingle(request), /thiếu nhận xét/);
});
test("excerpt reviews cannot claim the whole story omitted a payoff shown in another excerpt", async () => {
  const ai = new Ai();
  ai.runVertexCall = async request => {
    assert.match(request.prompt, /EXCERPT-ONLY REVIEW/);
    assert.doesNotMatch(request.prompt, /Complete spoken outline/);
    assert.equal(request.responseSchema.required.includes("duration_assessment"), false);
    return { overall_score: .85, summary: "This excerpt is clear", issues: [], timestamp_mode: "relative",
      duration_assessment: { verdict: "too_short", reason: "The final summoning battle is not in this excerpt." } };
  };
  const review = await ai.reviewDraftSingle({ draftVideoPath: "excerpt.mp4", decisions: [],
    reviewWindow: { start: 70, end: 142, duration: 222, index: 1, count: 3 }, editorialContext: { qualityFirst: true } });
  assert.equal(review.duration_assessment, undefined);
});
test("draft review receives only exact-range source observations relevant to its visible clips", async () => {
  const ai = new Ai();
  ai.runVertexCall = async request => {
    assert.match(request.prompt, /VERIFIED_RED_GLASSES/);
    assert.match(request.prompt, /do not inflate the score/);
    assert.doesNotMatch(request.prompt, /UNCHECKED_LABEL|RANGE_CHANGED|OUTSIDE_EXCERPT/);
    return { overall_score: .85, summary: "Reviewed independently", issues: [] };
  };
  const audit = { version: 7, method: "fixed_source_range", sourceStart: 10, sourceEnd: 14, confidence: .95 };
  const clip = { event_id: "verified", source_start: 10, source_end: 14, output_start: 1, output_end: 5 };
  const result = await ai.reviewDraftSingle({ draftVideoPath: "draft.mp4", editorialContext: { qualityFirst: true },
    reviewWindow: { start: 0, end: 8, duration: 20, index: 0, count: 3 },
    decisions: [{ speech_unit_id: "u", text: "Source-backed action", clips: [clip, { ...clip, event_id: "unverified" },
      { ...clip, event_id: "changed", source_end: 15 }, { ...clip, event_id: "outside", output_start: 12, output_end: 15 }] }],
    sourceEvents: [{ id: "verified", description: "VERIFIED_RED_GLASSES", anchorAudit: audit },
      { id: "unverified", description: "UNCHECKED_LABEL" }, { id: "changed", description: "RANGE_CHANGED", anchorAudit: audit },
      { id: "outside", description: "OUTSIDE_EXCERPT", anchorAudit: audit }] });
  assert.equal(result.overall_score, .85);
});

test("whole-story scope review sees the complete script and source evidence instead of one excerpt", async () => {
  const ai = new Ai();
  ai.getQualityModel = () => "quality-review-model";
  ai.runVertexCall = async request => {
    assert.equal(request.modelOverride, "quality-review-model");
    assert.match(request.prompt, /COMPLETE recap narrative/);
    assert.match(request.prompt, /The toad and snake battle/);
    assert.match(request.prompt, /Tsunade begins healing Naruto/);
    assert.match(request.prompt, /Do not require franchise canon/);
    assert.match(request.prompt, /natural paraphrase/);
    assert.match(request.prompt, /including source-video dialogue\/context notes/);
    assert.match(request.prompt, /search every supplied speech unit/);
    assert.deepEqual(request.responseSchema.properties.issues.items.properties.speech_unit_ids.items.enum, ["body"]);
    assert.doesNotMatch(request.prompt, /Unverified story outline|invented retreat/);
    return { overall_score: .85, summary: "Complete story", issues: [],
      duration_assessment: { verdict: "appropriate", reason: "The summoning battle is present in the final part." } };
  };
  const result = await ai.reviewEditorial({ decisions: [{ speech_unit_id: "body", text: "The toad and snake battle." }],
    sourceEvents: [{ id: "heal", description: "Tsunade begins healing Naruto" }],
    storyModel: { ending: "invented retreat" }, editorialContext: { qualityFirst: true } });
  assert.equal(result.duration_assessment.verdict, "appropriate");
});
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
test("timeline-grounded excerpt review normalizes copied absolute clocks and clamps boundary issues without failing", async () => {
  const ai = new Ai();
  ai.runVertexCall = async () => ({
    overall_score: 0.85,
    summary: "Observed",
    timestamp_mode: "relative",
    issues: [
      { severity: "medium", type: "event_timing", output_start: 165.125, output_end: 170.5, description: "Copied out_range from timeline", recommended_action: "Fix" },
      { severity: "medium", type: "pacing", output_start: 138.5, output_end: 145.2, description: "Straddles boundary", recommended_action: "Fix" },
      { severity: "low", type: "pacing", output_start: 420, output_end: 430, description: "Far outside chunk", recommended_action: "Ignore" }
    ]
  });
  const decisions = [
    { speech_unit_id: "su_1", text: "In window", audio_duration: 5, clips: [{ output_start: 165.125, output_end: 170.5, video_speed: 1, event_id: "e1" }] }
  ];
  const result = await ai.reviewDraftSingle({
    draftVideoPath: "fixture.mp4",
    decisions,
    reviewWindow: { start: 140, end: 282, duration: 613, index: 1, count: 5 }
  });
  assert.equal(result.issues.length, 2);
  assert.equal(result.issues[0].output_start, 165.125);
  assert.equal(result.issues[0].output_end, 170.5);
  assert.equal(result.issues[1].output_start, 278.5);
  assert.equal(result.issues[1].output_end, 282);
});
