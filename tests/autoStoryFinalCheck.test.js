const assert = require("assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { scope, verify } = require("../electron/services/autoStoryFinalCheck");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "final-check-"));
  try {
    const draft = path.join(root, "draft.mp4"); await fs.writeFile(draft, "draft");
    const script = { segments: [{ id: "a", evidenceId: "clip", start: 0, end: 12, storyRole: "hook", audioMode: "original_audio" },
      { id: "b", evidenceId: "clip", start: 12, end: 20, storyRole: "context", audioMode: "voiceover_only", voiceoverText: "New words" }] };
    const before = structuredClone(script); before.segments[1].voiceoverText = "Old words";
    assert.deepEqual(scope(before, script), { full: false, ids: ["b"] });
    const changedHook = structuredClone(script); changedHook.segments[0].end = 8;
    assert.equal(scope(before, changedHook).full, true);
    assert.equal(scope(null, script).full, true);
    let calls = 0, decodes = 0;
    const service = { ffmpeg: { ffmpegPath: "mock", run: async () => { decodes++; },
      probeVideo: async f => { await fs.access(f); return { duration: f === draft ? 20 : 12, hasAudio: true }; },
      createAutoStoryEvidenceReel: async (_e, f) => fs.writeFile(f, "reel") },
      stage: async (_r, _k, _i, args, validate) => { calls++; assert(!args.prompt.includes("Return a script"));
        const result = { accessGranted: true, verdict: "PASS", issues: [], previewSubtitleIssues: [
          { segmentId: "b", outputSec: 12, reason: "Translation error", verifiedSpeech: "New words", correctedVi: "Lời mới" }
        ] }; validate(result); return result; } };
    const input = { record: { draft, applied: true, complete: true }, story: { scriptId: 1 }, script, beforeScript: before, evidence: [], config: {}, root };
    const result = await verify(service, input);
    assert.equal(result.finalCheck.verdict, "PASS", result.finalCheck.error); assert.equal(result.finalCheck.scope, "changed_regions");
    assert.equal(result.needsUserReview, false);
    assert.equal(result.finalCheck.previewSubtitleIssues.length, 1, "preview translation does not fail English export");
    await verify(service, { ...input, record: result }); assert.equal(calls, 1); assert.equal(decodes, 1);
    service.stage = async () => { throw new Error("budget limit"); };
    const failed = await verify(service, input);
    assert.equal(failed.draft, draft); assert.equal(failed.complete, true);
    assert.equal(failed.finalCheck.complete, false); assert.equal(failed.finalCheck.error, "budget limit");
    console.log("Auto Story final check tests passed");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
