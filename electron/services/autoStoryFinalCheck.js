const path = require("path");
const fs = require("fs/promises");
const mediaPack = require("./autoStoryMediaPack");
const rhythm = require("./autoStoryRhythm");
const schema = { type: "object", required: ["accessGranted", "verdict", "issues"], properties: {
  accessGranted: { type: "boolean" }, verdict: { type: "string", enum: ["PASS", "NEEDS_ATTENTION"] },
  issues: { type: "array", items: { type: "object", required: ["outputSec", "reason"], properties: {
    outputSec: { type: "number" }, reason: { type: "string" } } } }
} };
schema.required.push("previewSubtitleIssues");
schema.properties.previewSubtitleIssues = { type: "array", items: { type: "object",
  required: ["segmentId", "outputSec", "reason", "verifiedSpeech", "correctedVi"], properties: {
    segmentId: { type: "string" }, outputSec: { type: "number" }, reason: { type: "string" },
    verifiedSpeech: { type: "string" }, correctedVi: { type: "string" }
  } } };
function scope(before, after) {
  if (!before || before.segments.length !== after.segments.length) return { full: true, ids: [] };
  const ids = [];
  for (let i = 0; i < after.segments.length; i++) {
    const a = before.segments[i], b = after.segments[i];
    if (["id", "evidenceId", "storyRole", "audioMode", "start"].some(k => a[k] !== b[k])) return { full: true, ids: [] };
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      if (/^(hook|climax|payoff)$/i.test(b.storyRole)) return { full: true, ids: [] };
      ids.push(b.id);
    }
  }
  return { full: !ids.length, ids };
}
async function verify(service, { record, story, script, beforeScript, evidence, config, root, signal, onProgress }) {
  const stat = await fs.stat(record.draft);
  const identity = `${stat.size}:${stat.mtimeMs}`;
  if (record.finalCheck?.identity === identity && record.finalCheck.complete && record.finalCheck.reviewPolicyVersion === 3) return record;
  try {
    const meta = await service.ffmpeg.probeVideo(record.draft);
    const expected = script.segments.reduce((n, s) => n + s.end - s.start, 0);
    if (!meta.duration || Math.abs(meta.duration - expected) > 0.75) throw new Error("Thời lượng bản cuối không khớp timeline.");
    if ((Number.isFinite(config.targetDurationMinSec) && meta.duration < config.targetDurationMinSec - 0.25)
      || (Number.isFinite(config.targetDurationMaxSec) && meta.duration > config.targetDurationMaxSec + 0.25)) {
      throw new Error("Thời lượng bản cuối nằm ngoài khoảng user yêu cầu.");
    }
    if (meta.hasAudio === false) throw new Error("Bản cuối không có track âm thanh.");
    if (script.segments.some(s => s.measuredVoiceSec > s.end - s.start + 0.1)) throw new Error("Voice vượt thời lượng hình trong bản cuối.");
    await service.ffmpeg.run(service.ffmpeg.ffmpegPath, ["-v", "error", "-xerror", "-i", record.draft, "-f", "null", "-"], { captureStdout: false });
    const rhythmReport = rhythm.analyze(script);
    const selected = record.verdict === "MAJOR_REVISE" || rhythmReport.needsReview ? { full: true, ids: [] } : scope(beforeScript, script);
    let time = 0;
    const units = script.segments.map(s => {
      const start = time; time += s.end - s.start;
      return { id: s.id, start: Math.max(0, start - 3), end: Math.min(meta.duration, time + 3) };
    });
    const focused = await mediaPack.pack(service.ffmpeg, [{ id: "final-draft", file: record.draft, duration: meta.duration,
      sourceStart: 0, sourceUnits: units }], { detailUnitIds: selected.full ? [] : selected.ids }, root, signal, true);
    const sources = selected.full ? await mediaPack.packSelected(service.ffmpeg, evidence, script, story, root, signal, { padding: 3, candidates: false }) : null;
    const files = selected.full ? [record.draft, ...sources.filePaths] : focused.filePaths;
    const mapping = selected.full ? sources.evidence : focused.evidence[0].mediaLocations;
    const result = await service.stage(root, `final-check-${story.scriptId}`, { identity, script, beforeScript, mapping }, {
      filePaths: files, videoFps: 1, videoFpsByPath: sources?.videoFpsByPath || focused.videoFpsByPath,
      taskType: "quality", temperature: 0.1, responseSchema: schema,
      prompt: `Verify the ACTUAL final rendered video after revision. This is a verification only: do not rewrite a script or start another repair loop.
${rhythm.policy}
ACTUAL AUDIO RHYTHM: ${JSON.stringify(rhythmReport)}. Explicitly inspect long continuous narrator blocks and whether the original-audio exchanges do the storytelling. NEEDS_ATTENTION if excessive summary or a long procedural ending persists, even if the overall audio ratio meets the target. Evaluate any rhythmException against the evidence, not as permission to rubber-stamp PASS.
For any opening in the supplied scope, evaluate hook + first context + the following participant line as ONE opening sequence. Compare openingAudit claims to the actual cut. A strong sound alone cannot pass if the necessary reaction is cut off or the handoff leaves people/chronology unclear. Do not demand a fixed hook length or linear chronology. Flag context compressed into just a date/incident label when essential meaning is lost, and unexplained dependent dialogue fragments. If the opening is outside a partial scope, do not claim to have inspected it.
Report accessGranted=false if you cannot inspect the attached media. ${selected.full ? "Inspect the full final draft and compare its source evidence. Check hook, causal story, climax and payoff." : "Inspect only the changed regions and surrounding context in the final-draft reel. Do not claim to have re-reviewed the entire film. The unchanged body was reviewed previously."}
Check audible clipped words, narrator/source voice overlap, subtitle translation of the actual speech, subtitle timing/readability, abrupt cuts and resolved original review issues. Use NEEDS_ATTENTION for remaining defects, with OUTPUT draft timestamps. PASS only when no unresolved defect is observed in scope. Do not invent source facts. Mapping uses reelStart + (clipLocalTime - clipStart); for final-draft views clipLocalTime means OUTPUT seconds.
SEPARATE REVIEW AIDS FROM EXPORT: Vietnamese subtitles are preview-only, never included in the final English export. Report their defects ONLY in previewSubtitleIssues, not issues or the export verdict. For each affected segment provide its stable segmentId, outputSec, reason, verifiedSpeech and correctedVi translating the COMPLETE audible speech in that segment, not just the erroneous word. If speech cannot be verified, leave verifiedSpeech/correctedVi empty and explain the uncertainty; never guess. Export verdict covers the actual English audio, footage, title, story and pacing. Export may PASS with previewSubtitleIssues. Never rewrite narration or footage to fix a preview translation.
STORY: ${JSON.stringify(story)}\nPREVIOUS ISSUES: ${JSON.stringify(record.issues || [])}\nCURRENT SCRIPT: ${JSON.stringify(script)}\nMEDIA MAP: ${JSON.stringify(mapping)}`
    }, v => {
      for (const i of [...(Array.isArray(v.issues) ? v.issues : []), ...(Array.isArray(v.previewSubtitleIssues) ? v.previewSubtitleIssues : [])]) {
        if (!Number.isFinite(i.outputSec) || i.outputSec < 0 || i.outputSec > meta.duration) {
          throw new Error(`Review ${i.segmentId || "issue"}: outputSec=${i.outputSec} ngoai video 0-${meta.duration}s. Use current OUTPUT timeline, not source or previous draft timestamps.`);
        }
      }
      if (v.verdict === "NEEDS_ATTENTION" && Array.isArray(v.issues) && !v.issues.length) {
        throw new Error("NEEDS_ATTENTION requires an actual export defect in issues. Preview-only subtitles must not change the export verdict; verify the draft and return a consistent verdict, do not invent a defect.");
      }
      if (v.accessGranted !== true || !["PASS", "NEEDS_ATTENTION"].includes(v.verdict) || !Array.isArray(v.issues)
        || v.issues.some(i => !Number.isFinite(i.outputSec) || i.outputSec < 0 || i.outputSec > meta.duration || !i.reason?.trim())
        || (v.verdict === "PASS" && v.issues.length)
        || (v.previewSubtitleIssues || []).some(i => !script.segments.some(s => s.id === i.segmentId)
          || !Number.isFinite(i.outputSec) || i.outputSec < 0 || i.outputSec > meta.duration || !i.reason?.trim())) throw new Error("AI chưa xác minh được bản cuối.");
    }, onProgress, signal);
    return { ...record, finalCheck: { ...result, identity, reviewPolicyVersion: 3, complete: true, scope: selected.full ? "full" : "changed_regions", technicalPassed: true },
      revisedDraftAiVerified: true, needsUserReview: result.verdict !== "PASS" };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ...record, finalCheck: { identity, complete: false, error: error.message }, needsUserReview: true };
  }
}
module.exports = { verify, scope, schema };
