"use strict";

/**
 * Division of labour (user rule, Ticket 112): the TOOL only checks what it can
 * compute with certainty; every editorial judgement (is this hook strong, is
 * there dialogue under this VO bed, is this dead air, is this cliffhanger
 * generic, who does this line refer to) belongs to Gemini, which watches the
 * video.
 *
 *  checkScript()       -> FACTS only (arithmetic on the script, the scene
 *                         manifest, the measured TTS speed, the model's own
 *                         declarations, word-level ASR when it exists)
 *  scriptEvidence()    -> raw source auto-caption excerpts for the windows the
 *                         review found problematic (VO beds, Hook start, ending),
 *                         handed to Gemini's editor turn as POINTERS, never verdicts
 *  checkBlueprintStructure() / blueprintEvidence() -> same split for the Blueprint
 *
 * Pure functions; no I/O.
 */

const num = (v, fallback = NaN) => (v == null || v === "" || !Number.isFinite(Number(v)) ? fallback : Number(v));
const txt = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();

const DEFAULTS = {
  voWordsPerSec: 2.35,      // fallback; callers pass the measured (conservative) TTS speed
  voMaxStretch: 1.04,       // renderer's manual-draft speed-up cap (BLOCK_VOICE_OVERFLOW beyond it)
  orphanSec: 1.0,
  sceneSpillSec: 0.8,
  speechRateWps: 2.8        // only to spread caption-line words in time for excerpts
};

function clock(sec) {
  const s = Math.max(0, num(sec, 0));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}
const A = (sec) => `A ${clock(sec)}`;

function words(text) {
  return txt(text).split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w));
}

/* ------------------------------------------------------------------ */
/* Transcript -> approximate word timeline                             */
/* ------------------------------------------------------------------ */

function parseSrtRaw(srt = "") {
  // Line-based: some exported SRTs (YouTube) put a lone "\r" line between the
  // timing line and the text, so blank-line block splitting loses the text.
  const lines = String(srt || "").split(/\r?\n|\r/).map((l) => l.replace(/<[^>]+>/g, "").trim());
  const toSec = (raw) => {
    const m = String(raw || "").trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`) : NaN;
  };
  const cues = [];
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.includes("-->")) {
      const [a, b] = line.split("-->");
      const startSec = toSec(a), endSec = toSec(b);
      current = Number.isFinite(startSec) && Number.isFinite(endSec) && endSec >= startSec ? { startSec, endSec, lines: [] } : null;
      if (current) cues.push(current);
      continue;
    }
    if (!line || !current) continue;
    if (/^\d+$/.test(line) && (lines[i + 1] || "").includes("-->")) continue; // next cue index
    current.lines.push(line);
  }
  return cues;
}

/**
 * Builds [{word, start, end, lineId, lineEnd}] from SRT. YouTube rolling
 * captions repeat the previous line on top; only the newest line of each cue
 * is new speech. A line's words are spread from the cue start at a normal
 * speaking rate (the cue may stay on screen long after speech stops).
 * Accepts faster-whisper word lists ({word,start,end}) directly.
 */
function buildWordTimeline({ transcriptSrt = "", words: precise = null, speechRateWps = DEFAULTS.speechRateWps } = {}) {
  if (Array.isArray(precise) && precise.length) {
    let lineId = 0;
    return precise.filter((w) => Number.isFinite(num(w.start)) && Number.isFinite(num(w.end))).map((w, i, list) => {
      const out = { word: txt(w.word), start: num(w.start), end: num(w.end), lineId, precise: true };
      if (/[.!?]["')\]]?$/.test(out.word) || (list[i + 1] && num(list[i + 1].start) - out.end > 0.7)) lineId += 1;
      return out;
    });
  }
  const cues = parseSrtRaw(transcriptSrt);
  const events = [];
  let previousLines = [];
  for (const cue of cues) {
    if (!cue.lines.length) { previousLines = []; continue; }
    let fresh = cue.lines;
    if (previousLines.length) {
      const lastPrev = previousLines.at(-1);
      const idx = cue.lines.lastIndexOf(lastPrev);
      if (idx >= 0) fresh = cue.lines.slice(idx + 1);
      else if (cue.lines.length === 1 && previousLines.includes(cue.lines[0])) fresh = [];
    }
    previousLines = cue.lines;
    const text = txt(fresh.join(" ").replace(/>>/g, " "));
    if (!words(text).length) continue;
    events.push({ startSec: cue.startSec, endSec: cue.endSec, text });
  }
  const out = [];
  events.forEach((event, index) => {
    const list = words(event.text);
    const next = events[index + 1];
    const natural = list.length / Math.max(1, speechRateWps) + 0.25;
    let end = Math.min(Math.max(event.endSec, event.startSec + 0.3), event.startSec + natural);
    if (next) end = Math.min(end, Math.max(event.startSec + 0.2, next.startSec));
    const step = (end - event.startSec) / list.length;
    list.forEach((word, k) => out.push({
      word,
      start: event.startSec + k * step,
      end: event.startSec + (k + 1) * step,
      lineId: index,
      lineEnd: k === list.length - 1,
      precise: false
    }));
  });
  return out;
}

function wordsIn(timeline, a, b) {
  return timeline.filter((w) => w.end > a && w.start < b);
}

/* ------------------------------------------------------------------ */
/* Script helpers                                                      */
/* ------------------------------------------------------------------ */

function normSegments(script = {}) {
  const raw = Array.isArray(script.segments) ? script.segments : [];
  let out = 0;
  return raw.map((s, index) => {
    const start = num(s.sourceStartSec ?? s.source_start_sec ?? s.startSec);
    const end = num(s.sourceEndSec ?? s.source_end_sec ?? s.endSec);
    const speed = Math.max(0.25, num(s.playbackSpeed ?? s.playback_speed, 1));
    const mode = txt(s.audio_mode || s.audioMode || "original_audio").toLowerCase();
    const vo = txt(s.voiceover_text || s.voiceoverText);
    const outDur = Number.isFinite(start) && Number.isFinite(end) && end > start ? (end - start) / speed : 0;
    const item = {
      index, n: index + 1, raw: s, start, end, speed, outDur, outStart: out,
      mode, isVO: mode !== "original_audio" && Boolean(vo), vo,
      fn: txt(s.storyFunction || s.story_function).toLowerCase(),
      narrator: s.source_narrator_detected === true || s.sourceNarratorDetected === true
    };
    out += outDur;
    return item;
  });
}

const contiguous = (a, b) => a && b && Math.abs(a.end - b.start) <= 0.15;

function hookLength(segs) {
  if (!segs.length) return 0;
  if (!segs[0].fn.includes("hook")) return 1;
  let n = 1;
  while (n < segs.length && segs[n].fn.includes("hook")) n += 1;
  return n;
}

/* ------------------------------------------------------------------ */
/* FACTS: computed with certainty                                      */
/* ------------------------------------------------------------------ */

function checkScript({ script = {}, manifest = null, words: precise = null, options = {} } = {}) {
  const o = { ...DEFAULTS, ...options };
  const findings = [];
  const add = (rule, segment, message) => findings.push({ rule, severity: "fact", segment: segment ? segment.n : null, message });
  const segs = normSegments(script);
  if (!segs.length) return { findings };
  const hookCount = hookLength(segs);

  // Source order after the Hook (pure timestamp comparison).
  for (let i = hookCount + 1; i < segs.length; i += 1) {
    const prev = segs[i - 1], cur = segs[i];
    if (cur.start < prev.start - 0.05) {
      add("SOURCE_ORDER", cur, `Segment ${cur.n} (${A(cur.start)}) starts EARLIER in the source than segment ${prev.n} (${A(prev.start)}). Only the opening Hook may be a flash-forward; keep later segments in increasing sourceStartSec.`);
    }
  }

  // VO must physically fit its bed at the measured TTS speed (+ the renderer's 4% speed-up cap).
  for (let i = 0; i < segs.length; i += 1) {
    if (!segs[i].isVO || (i > 0 && segs[i - 1].isVO)) continue;
    const run = [segs[i]];
    while (i + run.length < segs.length && segs[i + run.length].isVO) run.push(segs[i + run.length]);
    const count = run.reduce((sum, s) => sum + words(s.vo).length, 0);
    const dur = run.reduce((sum, s) => sum + s.outDur, 0);
    const fit = Math.max(2, Math.floor(dur * o.voWordsPerSec * o.voMaxStretch));
    if (count > fit) {
      const label = run.length > 1 ? `VO segments ${run[0].n}-${run.at(-1).n} (voiced as ONE block)` : `VO segment ${run[0].n}`;
      add("VO_DOES_NOT_FIT", run[0], `${label}: ${count} words need ~${(count / o.voWordsPerSec).toFixed(1)}s of TTS but the bed is ${dur.toFixed(1)}s (max ${fit} words at the measured ${o.voWordsPerSec.toFixed(2)} words/s). The render would fail with BLOCK_VOICE_OVERFLOW; shorten the text or lengthen the bed.`);
    }
  }

  // Sub-second isolated fragments, and scene-manifest boundaries crossed by < 0.8s at a hard cut.
  const scenes = Array.isArray(manifest?.scenes) ? manifest.scenes
    .map((s) => ({ id: txt(s.sceneId || s.id), start: num(s.startSec), end: num(s.endSec) }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end)) : [];
  for (let i = 0; i < segs.length; i += 1) {
    const s = segs[i], prev = segs[i - 1], next = segs[i + 1];
    if (s.outDur > 0 && s.outDur < o.orphanSec && !contiguous(prev, s) && !contiguous(s, next)) {
      add("ISOLATED_FRAGMENT", s, `Segment ${s.n} is an isolated ${s.outDur.toFixed(2)}s clip (${A(s.start)}).`);
      continue;
    }
    if (!scenes.length || s.outDur < 2) continue;
    for (const sc of scenes) {
      if (!contiguous(s, next) && sc.start > s.start + 1 && sc.start < s.end && s.end - sc.start < o.sceneSpillSec) {
        add("SHOT_SPILL", s, `Segment ${s.n} runs ${(s.end - sc.start).toFixed(2)}s past a detected shot change (${sc.id} starts ${A(sc.start)} = ${sc.start.toFixed(2)}s) before a hard cut, so that shot flashes on screen.`);
      }
      if (!contiguous(prev, s) && sc.end > s.start && sc.end < s.end - 1 && sc.end - s.start < o.sceneSpillSec) {
        add("SHOT_SPILL", s, `Segment ${s.n} starts ${(sc.end - s.start).toFixed(2)}s before a detected shot change (${sc.id} ends ${A(sc.end)} = ${sc.end.toFixed(2)}s), so the previous shot flashes on screen.`);
      }
    }
  }

  // The model's own frame check contradicts its audio choice.
  for (const s of segs.filter((x) => x.isVO && !x.narrator)) {
    const bed = s.raw.bed_check || s.raw.bedCheck || {};
    if (bed.has_dialogue === true || bed.hasDialogue === true || bed.has_burned_in_dialogue_captions === true || bed.hasBurnedInDialogueCaptions === true) {
      add("BED_CHECK_CONTRADICTION", s, `VO segment ${s.n} (${A(s.start)}-${A(s.end)}): your own bed_check says this bed has dialogue or burned-in dialogue captions, which contradicts placing a VO on it.`);
    }
  }

  // Cut inside a spoken word: only with real word-level timestamps (not caption estimates).
  if (Array.isArray(precise) && precise.length) {
    const list = precise.filter((w) => Number.isFinite(num(w.start)) && Number.isFinite(num(w.end)));
    for (let i = 0; i < segs.length; i += 1) {
      const s = segs[i];
      if (s.mode !== "original_audio") continue;
      if (!contiguous(s, segs[i + 1])) {
        const w = list.find((x) => num(x.start) < s.end - 0.04 && num(x.end) > s.end + 0.04);
        if (w) add("CUT_INSIDE_WORD", s, `Segment ${s.n} ends at ${s.end.toFixed(2)}s inside the word "${txt(w.word)}" (${num(w.start).toFixed(2)}-${num(w.end).toFixed(2)}s).`);
      }
      if (!contiguous(segs[i - 1], s)) {
        const w = list.find((x) => num(x.start) < s.start - 0.04 && num(x.end) > s.start + 0.04);
        if (w) add("CUT_INSIDE_WORD", s, `Segment ${s.n} starts at ${s.start.toFixed(2)}s inside the word "${txt(w.word)}" (${num(w.start).toFixed(2)}-${num(w.end).toFixed(2)}s).`);
      }
    }
  }
  return { findings };
}

/* ------------------------------------------------------------------ */
/* EVIDENCE for Gemini (pointers, never verdicts)                      */
/* ------------------------------------------------------------------ */

const EVIDENCE_HEADER = "SOURCE AUTO-CAPTION EXCERPTS (machine data from the uploaded transcript: timing is approximate and shouted or overlapping speech is often missing; they are pointers only — decide by watching and listening to the source):";

function captionLines({ transcriptSrt = "", words: precise = null } = {}) {
  const timeline = buildWordTimeline({ transcriptSrt, words: precise });
  const lines = new Map();
  for (const w of timeline) {
    const line = lines.get(w.lineId) || { start: w.start, end: w.end, words: [] };
    line.end = w.end;
    line.words.push(w.word);
    lines.set(w.lineId, line);
  }
  return [...lines.values()].map((l) => ({ start: l.start, end: l.end, text: l.words.join(" ") }));
}

function excerpt(lines, a, b, limit = 4) {
  const hit = lines.filter((l) => l.end > a && l.start < b);
  if (!hit.length) return "(no caption line)";
  const shown = hit.slice(0, limit).map((l) => `${A(l.start)} "${l.text.slice(0, 90)}"`);
  return shown.join(" · ") + (hit.length > limit ? ` · (+${hit.length - limit} more)` : "");
}

function scriptEvidence({ script = {}, transcriptSrt = "", words: precise = null } = {}) {
  const lines = captionLines({ transcriptSrt, words: precise });
  if (!lines.length) return "";
  const segs = normSegments(script);
  if (!segs.length) return "";
  const out = [EVIDENCE_HEADER];
  const hook = segs.slice(0, hookLength(segs));
  out.push(`- Hook opening, first 3s of output (${A(hook[0].start)}-${A(hook[0].start + 3 * hook[0].speed)}): ${excerpt(lines, hook[0].start, hook[0].start + 3 * hook[0].speed)}`);
  for (const s of segs.filter((x) => x.isVO && !x.narrator)) {
    out.push(`- VO bed of segment ${s.n} (${A(s.start)}-${A(s.end)}, audio_mode ${s.mode}): ${excerpt(lines, s.start, s.end)}`);
  }
  const last = segs.at(-1);
  out.push(`- Part ending, last segment ${last.n} (${A(last.start)}-${A(last.end)}): ${excerpt(lines, Math.max(last.start, last.end - 4), last.end + 1.5)}`);
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* Blueprint                                                           */
/* ------------------------------------------------------------------ */

/** Structure of Gemini's own hook audition; the choice itself is never second-guessed. */
function checkBlueprintStructure({ blueprint = {}, manifest = null } = {}) {
  const findings = [];
  const duration = num(manifest?.videoDurationSec, num(blueprint.sourceDurationSec, Infinity));
  for (const part of blueprint.parts || []) {
    const n = num(part.part_number, 0);
    const audition = part.hookAudition || part.hook_audition;
    const candidates = Array.isArray(audition?.candidates) ? audition.candidates : [];
    const add = (message) => findings.push({ rule: "HOOK_AUDITION", severity: "fact", segment: null, message: `Part ${n}: ${message}` });
    if (candidates.length < 3) { add(`hookAudition must list at least 3 opening moments you watched (has ${candidates.length}).`); continue; }
    candidates.forEach((c, i) => {
      const a = num(c.sourceStartSec), b = num(c.sourceEndSec);
      if (!(a >= 0 && b > a && b <= duration + 0.3)) add(`hookAudition candidate ${i + 1} has an invalid source range.`);
      for (const field of ["first3sSeen", "first3sHeard", "viewerQuestion"]) if (!txt(c[field])) add(`hookAudition candidate ${i + 1} is missing ${field}.`);
    });
    const chosen = candidates[num(audition.chosenIndex, -1)];
    const ha = num(part.hook?.sourceStartSec), hb = num(part.hook?.sourceEndSec);
    if (!chosen) add("hookAudition.chosenIndex does not point to a listed candidate.");
    else if (!(Math.min(hb, num(chosen.sourceEndSec)) - Math.max(ha, num(chosen.sourceStartSec)) > 0.5)) add("the chosen hookAudition candidate does not overlap parts[].hook.");
  }
  return { findings };
}

function blueprintEvidence({ blueprint = {}, transcriptSrt = "", words: precise = null } = {}) {
  const lines = captionLines({ transcriptSrt, words: precise });
  if (!lines.length) return "";
  const out = [EVIDENCE_HEADER];
  for (const part of blueprint.parts || []) {
    const n = num(part.part_number, 0);
    const a = num(part.hook?.sourceStartSec), b = num(part.hook?.sourceEndSec);
    if (Number.isFinite(a)) out.push(`- Part ${n} Hook ${A(a)}-${A(b)} (hookProof: ${txt(part.hook?.hookProof).slice(0, 80)}): ${excerpt(lines, a - 1, b + 1)}`);
    for (const beat of part.chapterBeats || []) {
      const x = num(beat.sourceStartSec), y = num(beat.sourceEndSec);
      if (Number.isFinite(x)) out.push(`- Part ${n} ${txt(beat.beatId)} ${A(x)}-${A(y)} (sourceProof: ${txt(beat.sourceProof).slice(0, 80)}): ${excerpt(lines, x - 1, y + 1, 3)}`);
    }
  }
  return out.join("\n");
}

function formatFindings(findings = [], limit = 12) {
  return findings.slice(0, limit).map((f) => `[${f.rule}] ${f.message}`);
}

module.exports = { checkScript, scriptEvidence, checkBlueprintStructure, blueprintEvidence, buildWordTimeline, captionLines, formatFindings, DEFAULTS, clock };
