"use strict";

// TikTok-ready concise English narrator captions with deterministic timing.
// The ranges are estimates based on the REAL measured voice duration; an ASR
// aligned transcript can replace these cues when one is available.
function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function sanitize(value) {
  return String(value || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}
function captionPhrases(text, {maxWords = 5} = {}) {
  const words = sanitize(text).split(/\s+/).filter(Boolean);
  const phrases = [];
  for (let at = 0; at < words.length;) {
    let end = Math.min(words.length, at + Math.max(3, maxWords));
    if (end < words.length && end - at > 3 && /[,.;:!?]$/.test(words[end - 2] || "")) end -= 1;
    phrases.push(words.slice(at, end).join(" "));
    at = end;
  }
  return phrases;
}
function splitTimedCaption({text, startSec, durationSec, maxWords = 5}) {
  const phrases = captionPhrases(text, {maxWords});
  const total = phrases.reduce((n, value) => n + value.split(/\s+/).length, 0);
  if (!total || durationSec <= 0.1) return [];
  let cursor = number(startSec);
  const end = cursor + durationSec;
  return phrases.map((value, index) => {
    const words = value.split(/\s+/).length;
    const proportion = index === phrases.length - 1 ? end - cursor : durationSec * (words / total);
    const cue = {startSec: Number(cursor.toFixed(3)), endSec: Number(Math.min(end, cursor + proportion).toFixed(3)), text: value};
    cursor = cue.endSec;
    return cue;
  }).filter(cue => cue.endSec > cue.startSec + 0.04);
}
function buildManualNarratorEnglishCues({segments = [], timeline = null, voiceReports = []} = {}) {
  const entries = [];
  let cursor = 0;
  const list = Array.isArray(segments) ? segments : [];
  for (let i = 0; i < list.length; i++) {
    const segment = list[i] || {};
    const range = timeline?.segments?.[i]?.resolved || {};
    const startSec = Number.isFinite(range.startSec) ? range.startSec : cursor;
    const endSec = Number.isFinite(range.endSec) ? range.endSec : startSec + number(voiceReports[i]?.timelineSec, number(segment.duration, 0));
    cursor = endSec;
    const audioMode = String(segment.audioMode || segment.audio_mode || "");
    const narration = sanitize(segment.voiceoverText || segment.voiceover_text || segment.dubbingLine
      || segment.blockNarrationText || segment.block_narration_text || "");
    if (!narration || audioMode === "original_audio") continue;
    const voiceDuration = number(voiceReports[i]?.rawVoiceSec, endSec - startSec);
    const visibleDuration = Math.max(0, Math.min(endSec - startSec, voiceDuration > 0 ? voiceDuration : endSec - startSec));
    entries.push(...splitTimedCaption({text: narration, startSec, durationSec: visibleDuration}));
  }
  return entries;
}
function toSrtTime(t) {
  const millis = Math.max(0, Math.round(t * 1000));
  const ms = millis % 1000, seconds = Math.floor(millis / 1000);
  return [
    String(Math.floor(seconds / 3600)).padStart(2, "0"),
    String(Math.floor(seconds / 60) % 60).padStart(2, "0"),
    String(seconds % 60).padStart(2, "0")
  ].join(":") + "," + String(ms).padStart(3, "0");
}
function toSrt(cues = []) {
  return cues.filter(cue => sanitize(cue.text) && number(cue.endSec) > number(cue.startSec))
    .map((cue, index) => [index + 1, toSrtTime(cue.startSec) + " --> " + toSrtTime(cue.endSec), sanitize(cue.text)].join("\n"))
    .join("\n\n");
}
function toAssTime(t) {
  const cs = Math.max(0, Math.round(number(t) * 100));
  return Math.floor(cs / 360000) + ":" + String(Math.floor(cs / 6000) % 60).padStart(2, "0")
    + ":" + String(Math.floor(cs / 100) % 60).padStart(2, "0")
    + "." + String(cs % 100).padStart(2, "0");
}
function toTikTokAss(cues = []) {
  // Native 1080x1920 coordinate system, scaled by libass for 540px drafts too.
  const header = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920",
    "ScaledBorderAndShadow: yes", "WrapStyle: 2",
    "", "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: TikTok,Arial,57,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,4,1,2,100,100,255,1",
    "", "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
  ];
  const events = cues.filter(c => sanitize(c.text) && number(c.endSec) > number(c.startSec))
    .map(c => {
      const text = sanitize(c.text).replace(/[{}]/g, "").replace(/\\/g, "").replace(/,/g, ",");
      return ["Dialogue: 0",toAssTime(c.startSec),toAssTime(c.endSec),"TikTok","",0,0,0,"",text].join(",");
    });
  return [...header,...events].join("\n") + "\n";
}
module.exports = {captionPhrases,splitTimedCaption,buildManualNarratorEnglishCues,toSrt,toTikTokAss};
