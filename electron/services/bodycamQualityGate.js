"use strict";
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const runFile = promisify(execFile);
const PROFILE = "viral_tiktok_crime_part1";
const finite = value => Number.isFinite(Number(value)) ? Number(value) : NaN;
const str = value => typeof value === "string" ? value.trim() : "";

function checkReview(review, { durationSec = 0, scriptId = 1, audioQa = null } = {}) {
  const errors = [];
  const audit = review?.bodycamQualityAudit;
  const duration = finite(durationSec);
  if (!audit || typeof audit !== "object") {
    errors.push("Missing bodycamQualityAudit from full-MP4 review.");
    return { passed: false, errors, windowCount: 0 };
  }
  const windows = audit.observationWindows;
  if (!Array.isArray(windows) || !windows.length) {
    errors.push("No MP4 observation windows.");
  } else if (!(duration > 0)) {
    errors.push("MP4 duration unavailable for full-coverage validation.");
  } else {
    const sorted = [...windows].sort((a, b) => finite(a.startSec) - finite(b.startSec));
    let coveredUntil = 0;
    for (const [i, w] of sorted.entries()) {
      const start = finite(w.startSec), end = finite(w.endSec);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration + .5) {
        errors.push("Invalid observation window " + i); continue;
      }
      if (start > coveredUntil + .5) errors.push("Unreviewed MP4 range " + coveredUntil.toFixed(1) + "–" + start.toFixed(1) + "s.");
      if (end - start > 9) errors.push("Observation window longer than 9s at " + start.toFixed(1) + "s.");
      if (!str(w.visibleAction) || !str(w.audibleContent) || !str(w.storyProgress)) {
        errors.push("Missing audiovisual evidence or story progression at " + start.toFixed(1) + "s.");
      }
      const states = [
        ["narratorNaturalness", ["natural", "robotic", "not_applicable"]],
        ["captionReadability", ["readable", "unreadable", "not_applicable"]],
        ["framingUsability", ["usable", "blocked", "not_applicable"]]
      ];
      for (const [field, allowed] of states) {
        if (!allowed.includes(w[field])) errors.push("Missing or invalid " + field + " at " + start.toFixed(1) + "s.");
      }
      const qualityFlags = w.narratorNaturalness === "robotic"
        || w.captionReadability === "unreadable" || w.framingUsability === "blocked"
        || /^(?:no progress|nothing new|static|repetitive|dead air)$/i.test(str(w.storyProgress));
      if (qualityFlags && w.weak !== true) errors.push("Reviewer did not flag weak footage/audio at " + start.toFixed(1) + "s.");
      if (w.weak === true && !str(w.reason)) errors.push("Weak window lacks reason at " + start.toFixed(1) + "s.");
      if (w.weak === true) {
        const reviewIssues = Array.isArray(review?.review?.issues) ? review.review.issues : [];
        const fixed = reviewIssues.some(issue => {
          const issueStart = finite(issue.outputStartSec);
          const issueEnd = finite(issue.outputEndSec);
          const overlaps = Number.isFinite(issueStart) &&
            (Number.isFinite(issueEnd) ? issueStart < end + 1 && issueEnd > start - 1 : Math.abs(issueStart - start) < 8);
          return overlaps && !["keep", ""].includes(str(issue.action));
        });
        if (!fixed) errors.push("Weak MP4 range " + start.toFixed(1) + "–" + end.toFixed(1) + "s has no explicit V2 repair action.");
      }
      coveredUntil = Math.max(coveredUntil, end);
    }
    if (coveredUntil < duration - .5) errors.push("Unreviewed final MP4 " + coveredUntil.toFixed(1) + "–" + duration.toFixed(1) + "s.");
  }
  for (const span of audioQa?.intervals || []) {
    if (!(finite(span.durationSec) >= 3)) continue;
    const matched = Array.isArray(windows) && windows.some(w =>
      finite(w.startSec) < finite(span.endSec) && finite(w.endSec) > finite(span.startSec) &&
      (w.weak === true || /silence|quiet|inaudible|ambient|no speech|sound drop/i.test(str(w.audibleContent) + " " + str(w.reason)))
    );
    if (!matched) errors.push("Unreviewed machine-detected low-audio range " +
      Number(span.startSec).toFixed(1) + "–" + Number(span.endSec).toFixed(1) + "s.");
  }
  const hook = audit.hookPromise;
  if (!hook || !str(hook.promise) || !str(hook.payoffEvidence) ||
      !Number.isFinite(finite(hook.payoffSourceSec)) ||
      hook.resolvedWithinPart !== true && hook.verifiedNextPartOpenLoop !== true) {
    errors.push("Hook has no verified payoff or grounded next-Part open loop.");
  }
  const ending = audit.ending;
  if (!ending || ending.usableAudio !== true || ending.usablePicture !== true || ending.grounded === false || !str(ending.sourceEvidence)) {
    errors.push("Ending lacks grounded evidence or usable picture/audio.");
  }
  const revised = review?.revisedScript || review?.revised_script;
  if (!revised || !Array.isArray(revised.segments) || !revised.segments.length) {
    errors.push("No revised source segments available.");
  } else {
    if (str(revised.prompt_profile || revised.promptProfile) !== PROFILE) errors.push("V2 changed bodycam profile.");
    if (Number(revised.scriptId ?? revised.script_id) !== Number(scriptId)) errors.push("V2 changed scriptId.");
    const total = revised.segments.reduce((sum, seg) => {
      const a = finite(seg.sourceStartSec ?? seg.source_start_sec);
      const b = finite(seg.sourceEndSec ?? seg.source_end_sec);
      const speed = finite(seg.playbackSpeed ?? seg.playback_speed ?? 1);
      return sum + (b > a && speed > 0 ? (b - a) / speed : 0);
    }, 0);
    if (total < 109.95 || total > 125.05) errors.push("V2 output duration " + total.toFixed(1) + "s falls outside 110–125s.");
    const intervals = revised.segments.map(s => ({
      start: finite(s.sourceStartSec ?? s.source_start_sec),
      end: finite(s.sourceEndSec ?? s.source_end_sec)
    }));
    if (hook?.resolvedWithinPart === true && Number.isFinite(finite(hook.payoffSourceSec))) {
      const t = finite(hook.payoffSourceSec);
      if (!intervals.some(r => r.start <= t && t <= r.end)) {
        errors.push("Hook payoff source timestamp " + t.toFixed(1) + "s is absent from revised footage.");
      }
    }
    if (ending?.sourceSec !== undefined && ending?.sourceSec !== null) {
      const t = finite(ending.sourceSec);
      const last = intervals[intervals.length - 1];
      if (!Number.isFinite(t) || !last || !(last.start <= t && t <= last.end)) {
        errors.push("Ending evidence timestamp is absent from final revised source range.");
      }
    }
    const modes = revised.segments.map(s => str(s.audio_mode || s.audioMode));
    if (!modes.includes("original_audio") || !modes.includes("voiceover_only")) {
      errors.push("V2 lost raw/narration sandwich.");
    } else {
      const runs = modes.filter((mode, index) => index === 0 || mode !== modes[index - 1]);
      const expected = ["original_audio", "voiceover_only", "original_audio", "voiceover_only",
        "original_audio", "voiceover_only", "original_audio", "voiceover_only"];
      if (runs.length !== expected.length || runs.some((mode, index) => mode !== expected[index])) {
        errors.push("V2 must contain eight logical alternating raw/narrator beats; found "
          + runs.length + " mode runs: " + runs.join(" → "));
      }
    }
  }
  return { passed: errors.length === 0, errors, windowCount: Array.isArray(windows) ? windows.length : 0,
    durationSec: duration, profile: PROFILE };
}

async function detectSilence(ffmpegPath, mp4Path) {
  if (!mp4Path) return { intervals: [], warning: "Missing MP4" };
  try {
    const { stderr } = await runFile(ffmpegPath || "ffmpeg",
      ["-hide_banner", "-nostdin", "-i", mp4Path, "-af", "silencedetect=noise=-38dB:d=1.3", "-f", "null", "-"],
      { timeout: 150000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return { intervals: parseSilence(stderr), thresholdDb: -38, minDurationSec: 1.3 };
  } catch (error) {
    // FFmpeg emits stderr even on success and may exit with a non-zero status
    // for non-audio streams. Parse stderr, but do not confuse tool failure with silence.
    const log = String(error.stderr || "");
    if (!log.includes("silence_")) return { intervals: [], warning: String(error.message || "Audio QA unavailable") };
    return { intervals: parseSilence(log), thresholdDb: -38, minDurationSec: 1.3 };
  }
}
function parseSilence(log) {
  const intervals = [];
  let start = null;
  for (const line of String(log).split(/\r?\n/)) {
    const a = line.match(/silence_start:\s*([\d.]+)/);
    if (a) start = Number(a[1]);
    const b = line.match(/silence_end:\s*([\d.]+).*silence_duration:\s*([\d.]+)/);
    if (b) {
      if (start !== null) intervals.push({ startSec: start, endSec: Number(b[1]), durationSec: Number(b[2]) });
      start = null;
    }
  }
  return intervals;
}
module.exports = { PROFILE, checkReview, detectSilence, parseSilence };
