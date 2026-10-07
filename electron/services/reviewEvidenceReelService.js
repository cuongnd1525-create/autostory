"use strict";

// Builds review-evidence-reel.mp4 for the AI draft review: instead of sending
// whole 4-minute proxy chunks (up to ~24 minutes of source for a 2-minute
// draft), the reviewer gets one short reel that contains exactly
//   - the source footage used by the draft (+ handles before/after),
//   - the strongest hook candidates,
//   - the strongest unused replacement candidates,
// plus a manifest mapping every reel range back to absolute SOURCE time.

const fs = require("fs/promises");
const path = require("path");

const FfmpegService = require("./ffmpegService");

const DEFAULT_REEL_OPTIONS = {
  handleSec: 4,
  maxReelSec: 360,
  hookCandidateCount: 3,
  replacementCandidateCount: 4,
  maxCandidateSec: 20,
  mergeGapSec: 2,
  minRangeSec: 0.5
};

function num(value, fallback = NaN) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampRange(start, end, durationSec) {
  const maxEnd = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Infinity;
  const s = Math.max(0, start);
  const e = Math.min(maxEnd, end);
  return e > s ? { start: s, end: e } : null;
}

function overlapSec(a, b) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function mergeRanges(ranges = [], gapSec = 2) {
  const sorted = ranges
    .filter(Boolean)
    .map((range) => ({ ...range, reasons: [...new Set(range.reasons || [range.reason])] }))
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + gapSec) {
      last.end = Math.max(last.end, range.end);
      last.reasons = [...new Set([...last.reasons, ...range.reasons])];
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function totalSec(ranges = []) {
  return ranges.reduce((sum, range) => sum + (range.end - range.start), 0);
}

const REASON_PRIORITY = ["used_in_draft", "hook_candidate", "replacement_candidate"];

/**
 * Pure planner. Returns { ranges: [{start,end,reasons,reason}], usedSec, totalSec, dropped }.
 * Used footage is never dropped (handles shrink first); candidates are added
 * in priority order until the reel budget is reached.
 */
function planReviewEvidenceReel({
  segments = [],
  hookCandidates = [],
  actionCandidates = [],
  sourceDurationSec = 0,
  options = {}
} = {}) {
  const opts = { ...DEFAULT_REEL_OPTIONS, ...options };
  const usedCore = segments
    .map((segment) => clampRange(num(segment.sourceStartSec), num(segment.sourceEndSec), sourceDurationSec))
    .filter((range) => range && range.end - range.start >= 0.05);
  const withHandles = (handleSec) => mergeRanges(usedCore.map((range) => ({
    ...clampRange(range.start - handleSec, range.end + handleSec, sourceDurationSec),
    reason: "used_in_draft"
  })), opts.mergeGapSec);
  let handleSec = opts.handleSec;
  let used = withHandles(handleSec);
  while (handleSec > 0 && totalSec(used) > opts.maxReelSec) {
    handleSec = Math.max(0, handleSec - 1);
    used = withHandles(handleSec);
  }
  const dropped = [];
  let ranges = used;
  const tryAdd = (candidateRange, reason) => {
    if (!candidateRange) return;
    const alreadyCovered = ranges.reduce((sum, range) => sum + overlapSec(range, candidateRange), 0);
    if (alreadyCovered >= (candidateRange.end - candidateRange.start) * 0.8) {
      // Already visible in the reel; just tag it.
      ranges = ranges.map((range) => (overlapSec(range, candidateRange) > 0
        ? { ...range, reasons: [...new Set([...range.reasons, reason])] }
        : range));
      return;
    }
    const next = mergeRanges([...ranges, { ...candidateRange, reason }], opts.mergeGapSec);
    if (totalSec(next) > opts.maxReelSec) {
      dropped.push({ sourceStartSec: candidateRange.start, sourceEndSec: candidateRange.end, reason });
      return;
    }
    ranges = next;
  };
  const candidateRange = (item) => {
    const start = num(item?.sourceStartSec);
    const end = num(item?.sourceEndSec);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    return clampRange(start, Math.min(end, start + opts.maxCandidateSec), sourceDurationSec);
  };
  hookCandidates.slice(0, opts.hookCandidateCount).forEach((item) => tryAdd(candidateRange(item), "hook_candidate"));
  const usedRanges = usedCore;
  const replacements = [...actionCandidates]
    .filter((item) => candidateRange(item))
    .filter((item) => {
      const range = candidateRange(item);
      const covered = usedRanges.reduce((sum, used) => sum + overlapSec(used, range), 0);
      return covered < (range.end - range.start) * 0.5;
    })
    .sort((a, b) => num(b.actionPriorityScore, 0) - num(a.actionPriorityScore, 0) || num(a.rank, 99) - num(b.rank, 99))
    .slice(0, opts.replacementCandidateCount);
  replacements.forEach((item) => tryAdd(candidateRange(item), "replacement_candidate"));
  ranges = ranges
    .filter((range) => range.end - range.start >= opts.minRangeSec)
    .map((range) => ({
      ...range,
      reason: REASON_PRIORITY.find((reason) => range.reasons.includes(reason)) || range.reasons[0]
    }));
  return {
    ranges,
    handleSec,
    usedSec: Number(totalSec(used).toFixed(3)),
    totalSec: Number(totalSec(ranges).toFixed(3)),
    dropped
  };
}

/**
 * Encodes the planned ranges from `sourcePath` (preferably the analysis proxy,
 * which carries burned-in sceneId + absolute SOURCE timestamps) into one reel.
 * Returns { reelPath, manifestPath, manifest }.
 */
async function buildReviewEvidenceReel({
  sourcePath,
  outputDir,
  plan,
  settings = {},
  sourceVideo = "",
  sourceDurationSec = 0,
  sourceHasBurnedTimestamps = false,
  fileName = "review-evidence-reel.mp4"
}) {
  if (!sourcePath) throw new Error("Không có video nguồn/proxy để tạo evidence reel.");
  if (!plan?.ranges?.length) throw new Error("Evidence reel không có đoạn nào.");
  const ffmpeg = new FfmpegService(settings);
  const workDir = path.join(outputDir, `.evidence-reel-parts-${Date.now()}`);
  await fs.mkdir(workDir, { recursive: true });
  const reelPath = path.join(outputDir, fileName);
  const manifestPath = path.join(outputDir, fileName.replace(/\.mp4$/i, "-manifest.json"));
  try {
    const parts = [];
    for (const [index, range] of plan.ranges.entries()) {
      const partPath = path.join(workDir, `part-${String(index + 1).padStart(3, "0")}.mp4`);
      await ffmpeg.run(ffmpeg.ffmpegPath, [
        "-y", "-hide_banner", "-loglevel", "error",
        "-ss", range.start.toFixed(3), "-i", sourcePath, "-t", (range.end - range.start).toFixed(3),
        "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", "scale='min(720,iw)':-2,fps=12",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "64k", "-ar", "44100", "-ac", "1",
        "-movflags", "+faststart", partPath
      ], { captureStdout: false });
      const meta = await ffmpeg.probeVideo(partPath).catch(() => null);
      parts.push({ path: partPath, durationSec: num(meta?.duration, range.end - range.start), range });
    }
    const listPath = path.join(workDir, "concat.txt");
    await fs.writeFile(listPath, parts.map((part) => `file '${part.path.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
    await ffmpeg.run(ffmpeg.ffmpegPath, [
      "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", reelPath
    ], { captureStdout: false });
    let cursor = 0;
    const segments = parts.map((part) => {
      const entry = {
        reelStartSec: Number(cursor.toFixed(3)),
        reelEndSec: Number((cursor + part.durationSec).toFixed(3)),
        sourceStartSec: Number(part.range.start.toFixed(3)),
        sourceEndSec: Number(part.range.end.toFixed(3)),
        reason: part.range.reason,
        reasons: part.range.reasons
      };
      cursor += part.durationSec;
      return entry;
    });
    const reelMeta = await ffmpeg.probeVideo(reelPath).catch(() => null);
    const manifest = {
      artifactType: "review_evidence_reel",
      schemaVersion: 1,
      file: fileName,
      sourceVideo,
      sourceDurationSec: Number(num(sourceDurationSec, 0).toFixed(3)),
      reelDurationSec: Number(num(reelMeta?.duration, cursor).toFixed(3)),
      sourceHasBurnedTimestamps,
      handleSec: plan.handleSec,
      timestampRule: "Reel player time is NOT source time. sourceSec = segment.sourceStartSec + (reelSec - segment.reelStartSec)."
        + (sourceHasBurnedTimestamps ? " The SOURCE timestamp burned into every frame is authoritative." : ""),
      coverage: "partial_evidence_reel",
      droppedCandidates: plan.dropped || [],
      segments
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    return { reelPath, manifestPath, manifest };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function buildEvidenceReelPromptBlock(manifest = {}) {
  const rows = (manifest.segments || []).map((segment) => (
    `- reel ${segment.reelStartSec.toFixed(1)}-${segment.reelEndSec.toFixed(1)}s = SOURCE ${segment.sourceStartSec.toFixed(1)}-${segment.sourceEndSec.toFixed(1)}s (${segment.reasons.join("+")})`
  ));
  return [
    "REVIEW EVIDENCE REEL CONTRACT (SOURCE FOOTAGE INPUT FOR THIS REVIEW):",
    `- ${manifest.file || "review-evidence-reel.mp4"} (${Number(manifest.reelDurationSec || 0).toFixed(1)}s) is the ONLY source footage supplied. It concatenates: footage used in the draft with ${manifest.handleSec ?? 4}s handles, the strongest hook candidates, and the strongest unused replacement candidates.`,
    "- Reel player time is NOT source time. Convert with sourceSec = sourceStartSec + (reelSec - reelStartSec) using review-evidence-reel-manifest.json (also in review-context.json.sourceProxyManifest)."
      + (manifest.sourceHasBurnedTimestamps ? " The SOURCE timestamp burned into each frame is authoritative." : ""),
    "- Every sourceStartSec/sourceEndSec you return must lie inside one of the ranges below. Do not invent footage outside them; report missing coverage instead.",
    "- Source coverage is PARTIAL (evidence reel), not the complete source.",
    ...rows
  ].join("\n");
}

module.exports = {
  DEFAULT_REEL_OPTIONS,
  planReviewEvidenceReel,
  buildReviewEvidenceReel,
  buildEvidenceReelPromptBlock,
  mergeRanges
};
