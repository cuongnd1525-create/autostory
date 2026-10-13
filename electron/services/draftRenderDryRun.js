"use strict";

// Stage 1 render dry-run for the manual Gemini draft-review workflow.
//
// The editorial gate must not let through a script that the draft renderer
// will reject or visibly distort. This module replays, WITHOUT ffmpeg/TTS,
// the parts of the draft render that can fail on script content:
//   - normalization of the script (same normalizeHighlightCutScript as import)
//   - continuous narration blocks (same buildManualDraftContinuousNarration)
//   - voice length vs. visual length, estimated from the measured voice
//     profile (words per second) with the render's own tolerances:
//       * narrated block: hard limit +4% speed-up (BLOCK_VOICE_OVERFLOW above)
//       * single voiced segment: +4% speed-up + up to 10% visual slow-down
//   - source ranges inside the source video
//
// Real run 2026-10-09: at 2.209 words/s, 3/6, 3/5 and 6/6 voiceover lines of
// the repaired Parts 1/3/4 were longer than their segments; nothing in Stage 1
// checked this, so the failure would only have appeared during draft render.

const {
  normalizeHighlightCutScript,
  buildManualDraftContinuousNarration,
  narratedBlockRuns
} = require("./dubbingService");

const MANUAL_DRAFT_MAX_VOICE_STRETCH = 0.04;
// Word-count estimates have error; keep a margin below the render limits.
const SINGLE_SEGMENT_MAX_RATIO = 1.10;
const NARRATED_BLOCK_MAX_RATIO = 1.0;
const MAX_HOST_EXTENSION_SEC = 4;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function wordCount(value) {
  return String(value || "").trim().split(/\s+/).filter(Boolean).length;
}

function voiceTextOf(segment = {}) {
  return String(segment.voiceoverText || segment.voiceover_text || segment.dubbingLine || segment.narration || "").trim();
}

function blockTextOf(segments, run) {
  return String(segments[run.start]?.blockNarrationText || "").trim();
}

/**
 * Returns { ok, issues, checks, normalized }.
 * issue: { code, segmentIndexes, durationSec, estimatedVoiceSec, ratio, words, maxWords, message }
 */
function dryRunManualDraftRender({ script, videoDurationSec = 0, wordsPerSecond = 0, settings = {}, normalizedScript = null } = {}) {
  const issues = [];
  let normalized = normalizedScript;
  try {
    normalized = normalized || normalizeHighlightCutScript(script, videoDurationSec);
  } catch (error) {
    return {
      ok: false,
      normalized: null,
      checks: { normalized: false },
      issues: [{ code: "normalize_failed", segmentIndexes: [], message: `Script cannot be normalized for render: ${error.message}` }]
    };
  }
  const segments = Array.isArray(normalized?.segments) ? normalized.segments : [];
  if (!segments.length) {
    issues.push({ code: "no_segments", segmentIndexes: [], message: "Script has no renderable segments." });
  }
  const duration = number(videoDurationSec, 0);
  segments.forEach((segment, index) => {
    const start = number(segment.sourceStartSec, NaN);
    const end = number(segment.sourceEndSec, NaN);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.3 || start < 0 || (duration > 0 && end > duration + 0.05)) {
      issues.push({
        code: "invalid_source_range",
        segmentIndexes: [index],
        message: `Segment ${index + 1}: source range ${start}-${end}s is not renderable (min 0.3s, inside 0-${duration || "?"}s).`
      });
    }
    if (segment.audioMode && segment.audioMode !== "original_audio" && !voiceTextOf(segment)) {
      issues.push({ code: "missing_voice_text", segmentIndexes: [index], message: `Segment ${index + 1} is ${segment.audioMode} but has no voiceover_text.` });
    }
  });

  const wps = number(wordsPerSecond, 0);
  const voiceChecks = [];
  if (wps > 0 && segments.length) {
    const planned = buildManualDraftContinuousNarration(segments, { analysisWorkflow: "manual_gemini_draft_review" }, settings);
    const runs = narratedBlockRuns(planned);
    const inBlock = new Set();
    for (const run of runs) {
      const indexes = [];
      for (let index = run.start; index <= run.end; index += 1) { indexes.push(index); inBlock.add(index); }
      const durationSec = indexes.reduce((sum, index) => sum + Math.max(0.3, number(planned[index].duration, 0.3)), 0);
      const words = wordCount(blockTextOf(planned, run));
      const estimatedVoiceSec = words / wps;
      const ratio = estimatedVoiceSec / Math.max(0.3, durationSec);
      const check = { kind: "narrated_block", blockId: run.blockId, segmentIndexes: indexes, durationSec: Number(durationSec.toFixed(3)), words, estimatedVoiceSec: Number(estimatedVoiceSec.toFixed(3)), ratio: Number(ratio.toFixed(3)), maxRatio: NARRATED_BLOCK_MAX_RATIO, maxWords: Math.max(1, Math.floor(durationSec * wps * NARRATED_BLOCK_MAX_RATIO)) };
      voiceChecks.push(check);
      if (ratio > NARRATED_BLOCK_MAX_RATIO + 1e-6) {
        issues.push({
          code: "narrated_block_voice_overflow",
          ...check,
          message: `Segments ${indexes.map((i) => i + 1).join("+")} are rendered as ONE continuous narration block of ${durationSec.toFixed(1)}s, but its ${words} words need ~${estimatedVoiceSec.toFixed(1)}s at ${wps} words/s (render limit +${Math.round(MANUAL_DRAFT_MAX_VOICE_STRETCH * 100)}%). Max ${check.maxWords} words in total.`
        });
      }
    }
    segments.forEach((segment, index) => {
      if (inBlock.has(index) || segment.audioMode === "original_audio") return;
      const words = wordCount(voiceTextOf(segment));
      if (!words) return;
      const durationSec = Math.max(0.3, number(segment.duration, 0.3));
      const estimatedVoiceSec = words / wps;
      const ratio = estimatedVoiceSec / durationSec;
      const check = { kind: "segment", segmentIndexes: [index], durationSec: Number(durationSec.toFixed(3)), words, estimatedVoiceSec: Number(estimatedVoiceSec.toFixed(3)), ratio: Number(ratio.toFixed(3)), maxRatio: SINGLE_SEGMENT_MAX_RATIO, maxWords: Math.max(1, Math.floor(durationSec * wps)) };
      voiceChecks.push(check);
      if (ratio > SINGLE_SEGMENT_MAX_RATIO + 1e-6) {
        issues.push({
          code: "voice_overflow",
          ...check,
          message: `Segment ${index + 1}: voiceover has ${words} words (~${estimatedVoiceSec.toFixed(1)}s at ${wps} words/s) for ${durationSec.toFixed(1)}s of footage. Max ${check.maxWords} words, or lengthen the footage.`
        });
      }
    });
  }
  return {
    ok: issues.length === 0,
    normalized,
    issues,
    checks: { normalized: true, wordsPerSecond: wps || null, voiceChecks }
  };
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aEnd > bStart + 1e-6 && aStart < bEnd - 1e-6;
}

/**
 * Deterministic host fix for voice overflow: lengthen the footage of the
 * overflowing segment (forward, then backward) using adjacent source time
 * that no other segment of the script uses, within the source video and the
 * profile's max duration and, for a Series Part, inside its locked allocation
 * (allowedRanges). Never trims or rewrites narration.
 * Returns { script, adjustments }.
 */
function autoFitVoiceFootage({ script, videoDurationSec = 0, wordsPerSecond = 0, maxDurationSec = Infinity, settings = {}, allowedRanges = null } = {}) {
  const wps = number(wordsPerSecond, 0);
  if (!wps || !Array.isArray(script?.segments)) return { script, adjustments: [] };
  const working = { ...script, segments: script.segments.map((segment) => ({ ...segment })) };
  const adjustments = [];
  const sourceEnd = number(videoDurationSec, 0) || Infinity;
  for (let pass = 0; pass < 3; pass += 1) {
    const dry = dryRunManualDraftRender({ script: working, videoDurationSec, wordsPerSecond: wps, settings });
    if (!dry.normalized || dry.normalized.segments.length !== working.segments.length) break;
    const overflow = dry.issues.filter((issue) => issue.code === "voice_overflow" || issue.code === "narrated_block_voice_overflow");
    if (!overflow.length) break;
    let changed = false;
    let totalSec = number(dry.normalized.totalDuration, 0);
    for (const issue of overflow) {
      const targetIndex = issue.segmentIndexes[issue.segmentIndexes.length - 1];
      const raw = working.segments[targetIndex];
      if (!raw) continue;
      const needSec = Math.min(MAX_HOST_EXTENSION_SEC, issue.estimatedVoiceSec / (issue.kind === "narrated_block" ? NARRATED_BLOCK_MAX_RATIO : 1) - issue.durationSec + 0.25);
      if (!(needSec > 0) || totalSec + needSec > maxDurationSec + 1e-6) continue;
      const start = number(raw.sourceStartSec, NaN);
      const end = number(raw.sourceEndSec, NaN);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const others = working.segments
        .filter((_, index) => index !== targetIndex)
        .map((segment) => [number(segment.sourceStartSec, NaN), number(segment.sourceEndSec, NaN)])
        .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
      const insideAllocation = (a, b) => !Array.isArray(allowedRanges) || !allowedRanges.length
        || allowedRanges.some(([x, y]) => a >= x - 1e-6 && b <= y + 1e-6);
      const free = (a, b) => a >= 0 && b <= sourceEnd + 1e-6 && insideAllocation(a, b) && !others.some(([x, y]) => rangesOverlap(a, b, x, y));
      let applied = null;
      if (free(end, end + needSec)) applied = { sourceStartSec: start, sourceEndSec: Number((end + needSec).toFixed(3)), direction: "forward" };
      else if (free(start - needSec, start)) applied = { sourceStartSec: Number((start - needSec).toFixed(3)), sourceEndSec: end, direction: "backward" };
      if (!applied) continue;
      working.segments[targetIndex] = { ...raw, sourceStartSec: applied.sourceStartSec, sourceEndSec: applied.sourceEndSec };
      totalSec += needSec;
      changed = true;
      adjustments.push({
        segmentIndex: targetIndex,
        segmentId: raw.segmentId || raw.id || "",
        from: [start, end],
        to: [applied.sourceStartSec, applied.sourceEndSec],
        direction: applied.direction,
        addedSec: Number(needSec.toFixed(3)),
        reason: issue.code
      });
    }
    if (!changed) break;
  }
  if (adjustments.length) {
    working.hostVoiceFitAdjustments = [...(Array.isArray(script.hostVoiceFitAdjustments) ? script.hostVoiceFitAdjustments : []), ...adjustments];
  }
  return { script: adjustments.length ? working : script, adjustments };
}

/** Voice word budget per voiced segment, for repair packets. */
function voiceWordBudgets(dry) {
  return (dry?.checks?.voiceChecks || []).map((check) => ({
    kind: check.kind,
    segments: check.segmentIndexes.map((index) => index + 1),
    footageSec: check.durationSec,
    currentWords: check.words,
    maxWords: check.maxWords,
    overBudget: check.ratio > check.maxRatio + 1e-6
  }));
}

function parseMeasuredWordsPerSecond(promptText = "") {
  const match = String(promptText).match(/measuredWordsPerSecond:\s*([0-9]+(?:\.[0-9]+)?)/i);
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) && value > 0.8 && value < 6 ? value : 0;
}

module.exports = {
  MANUAL_DRAFT_MAX_VOICE_STRETCH,
  SINGLE_SEGMENT_MAX_RATIO,
  NARRATED_BLOCK_MAX_RATIO,
  dryRunManualDraftRender,
  autoFitVoiceFootage,
  voiceWordBudgets,
  parseMeasuredWordsPerSecond
};
