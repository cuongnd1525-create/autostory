"use strict";
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const runFile = promisify(execFile);
const PROFILE = "viral_tiktok_crime_part1";
const finite = value => Number.isFinite(Number(value)) ? Number(value) : NaN;
const str = value => typeof value === "string" ? value.trim() : "";

function checkReview(review, { durationSec = 0, scriptId = 1 } = {}) {
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
      if (w.weak === true && !str(w.reason)) errors.push("Weak window lacks reason at " + start.toFixed(1) + "s.");
      coveredUntil = Math.max(coveredUntil, end);
    }
    if (coveredUntil < duration - .5) errors.push("Unreviewed final MP4 " + coveredUntil.toFixed(1) + "–" + duration.toFixed(1) + "s.");
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
    const modes = revised.segments.map(s => str(s.audio_mode || s.audioMode));
    if (!modes.includes("original_audio") || !modes.includes("voiceover_only")) errors.push("V2 lost raw/narration sandwich.");
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
