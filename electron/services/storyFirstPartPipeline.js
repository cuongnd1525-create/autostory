"use strict";

/**
 * Story-First per-Part pipeline helpers (pure, no AGY process control).
 *
 * Real run 2026-10-13 (15.4 min source, 49 min until failure):
 *  - Phase B wrote all three Parts in ONE agent conversation: 38 turns, the
 *    95KB transcript paged through view_file 21 times, context grew to ~190K
 *    tokens and the last turn alone took 256s.
 *  - The writer then dropped a planned payoff event and ping-ponged between
 *    timelines; only the slow AI cold viewer noticed.
 *  - A repair was killed for opening a harmless read-only input file and its
 *    3-minute recovery timed out, which aborted the whole Stage 1.
 *
 * These helpers let the host hand each AI step ONE compact, Part-scoped text
 * packet, check story structure deterministically before any AI review, size
 * timeouts from the work actually requested, and content-address every
 * intermediate result so a rerun resumes instead of starting over.
 */
const crypto = require("crypto");
const path = require("path");

const compact = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const num = (value, fallback = NaN) => (value === "" || value === null || value === undefined
  ? fallback : (Number.isFinite(Number(value)) ? Number(value) : fallback));
const clip = (value, max) => {
  const text = compact(value);
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text;
};
const fmt = (value) => Number(num(value, 0).toFixed(2));
function toRange(item) {
  const start = num(item?.sourceStartSec ?? item?.startSec);
  const end = num(item?.sourceEndSec ?? item?.endSec);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}
function overlapSec(left, right) {
  if (!left || !right) return 0;
  return Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start));
}
function mergeRanges(ranges = [], toleranceSec = 1) {
  const sorted = ranges.filter(Boolean).map((r) => ({ start: r.start, end: r.end })).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (last && item.start <= last.end + toleranceSec) last.end = Math.max(last.end, item.end);
    else merged.push({ ...item });
  }
  return merged;
}
function stableHash(value, length = 24) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex").slice(0, length);
}
function segmentsOf(script = {}) {
  return Array.isArray(script?.segments) ? script.segments : Array.isArray(script?.narrativeBeats) ? script.narrativeBeats : [];
}
function voiceOf(segment = {}) {
  return compact(segment.voiceover_text ?? segment.voiceoverText ?? segment.narration ?? "");
}
function audioModeOf(segment = {}) {
  return compact(segment.audio_mode ?? segment.audioMode).toLowerCase() || (voiceOf(segment) ? "voiceover_only" : "original_audio");
}
function storyFunctionOf(segment = {}) {
  return compact(segment.storyFunction || segment.story_function || segment.sceneType || segment.scene_type).toLowerCase();
}

// ---------------------------------------------------------------------------
// JSON transport repair
// ---------------------------------------------------------------------------

/**
 * Repairs the bracket structure of an almost-valid JSON document WITHOUT
 * touching string content. Real series plan 2026-10-13 (23,291 chars) was
 * complete except for one missing "]" before ',"notes":""', and the whole
 * 5-minute plan was thrown away. Handles: a missing "]"/"}" before a closing
 * bracket of the other kind, a key/value pair that appears while an array is
 * still open (the array is closed before that key), and a truncated tail.
 */
function repairJsonBrackets(text) {
  const source = String(text || "");
  const out = [];
  const stack = [];
  const commaPositions = [];
  let inString = false;
  let escaped = false;
  for (const ch of source) {
    if (inString) {
      out.push(ch);
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") { inString = true; out.push(ch); continue; }
    if (ch === "{" || ch === "[") { stack.push(ch); commaPositions.push(-1); out.push(ch); continue; }
    if (ch === "}" || ch === "]") {
      const opener = ch === "}" ? "{" : "[";
      while (stack.length && stack[stack.length - 1] !== opener) {
        out.push(stack.pop() === "{" ? "}" : "]");
        commaPositions.pop();
      }
      if (stack.length) { stack.pop(); commaPositions.pop(); out.push(ch); }
      continue;
    }
    if (ch === "," && stack.length) { commaPositions[commaPositions.length - 1] = out.length; out.push(ch); continue; }
    if (ch === ":" && stack[stack.length - 1] === "[") {
      // `[{...},"key":value` -> the array ended before this key.
      const position = commaPositions[commaPositions.length - 1];
      if (position >= 0) {
        out.splice(position, 0, "]");
        stack.pop();
        commaPositions.pop();
      }
      out.push(ch);
      continue;
    }
    out.push(ch);
  }
  if (inString) out.push("\"");
  while (stack.length) out.push(stack.pop() === "{" ? "}" : "]");
  return out.join("");
}

// ---------------------------------------------------------------------------
// Tool guard / timeouts
// ---------------------------------------------------------------------------

const VIDEO_EXTENSIONS = /\.(mp4|mov|mkv|webm|avi|m4v)$/i;
const normalizePath = (value) => String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * Read-only guard for text-only creative steps. Reading ANY non-video input
 * of this package is harmless; killing a 3-minute repair because it opened
 * action-candidates.json (real run 2026-10-13) is not. Everything else -
 * writes, commands, search, task managers, video files, paths outside the
 * package - still stops the process immediately.
 */
function buildPackageReadOnlyGuard({ roots = [], files = [], stepLabel = "text-only step" } = {}) {
  const rootList = roots.filter(Boolean).map(normalizePath);
  const fileSet = new Set(files.filter(Boolean).map(normalizePath));
  return ({ toolName, file }) => {
    if (toolName !== "view_file") return `${stepLabel} is read-only; ${toolName || "unknown tool"} is not allowed`;
    const target = normalizePath(file);
    if (!target) return `${stepLabel}: view_file without a path`;
    if (VIDEO_EXTENSIONS.test(target)) return `${stepLabel} is text-only; video file ${path.basename(String(file || ""))} is not allowed`;
    if (fileSet.has(target) || rootList.some((root) => target === root || target.startsWith(`${root}/`))) return null;
    return `not a package input file: ${path.basename(String(file || ""))}`;
  };
}

/**
 * Timeout from the work requested, not a fixed cap. A repair must read its
 * packet and stream back a complete ~11KB script; the fixed 180s recovery cap
 * expired mid-response (real run 2026-10-13).
 */
function estimateWriteTimeoutMs({ outputChars = 12000, inputChars = 0, minSec = 300, maxSec = 900, baseSec = 150, outputCharsPerSec = 45, inputCharsPerSec = 2500 } = {}) {
  const seconds = baseSec + Math.max(0, outputChars) / outputCharsPerSec + Math.max(0, inputChars) / inputCharsPerSec;
  return Math.round(Math.max(minSec, Math.min(maxSec, seconds)) * 1000);
}

// ---------------------------------------------------------------------------
// Editorial rules excerpt (from the GUI package prompt)
// ---------------------------------------------------------------------------

// Blocks of the GUI Gemini prompt that do not apply to a host-driven,
// text-only Part writer: transport (we use one envelope), video upload/coverage
// gates (Phase A already watched 100%), and the ~25KB raw action-candidate dump
// (Part-scoped candidates are in the packet instead).
const DROPPED_RULE_BLOCKS = [
  /^JSON CODE-BLOCK CONTRACT/i,
  /^CHUNKED VIDEO INPUT CONTRACT/i,
  /^VIDEO INPUT CONTRACT/i,
  /^LOCAL ACTION CANDIDATES/i,
  /^STEP 0 - VERIFIED INPUT ACCESS GATE/i,
  /^AUTHORITATIVE SOURCE SUMMARY/i
];
function isRuleHeading(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("\"") || trimmed.startsWith("-") || trimmed.startsWith("*")) return false;
  if (/^#{2,}\s/.test(trimmed)) return true;
  return /^[A-Z0-9][A-Z0-9 \-_/()&.,'+]{6,}(:|\))?$/.test(trimmed) && /[A-Z]{3}/.test(trimmed);
}
function extractEditorialRules(promptText = "", { maxChars = 14000 } = {}) {
  const lines = String(promptText || "").replace(/\r/g, "").split("\n");
  const kept = [];
  let dropping = false;
  for (const line of lines) {
    if (/^={10,}$/.test(line.trim())) { if (!dropping) kept.push(line); continue; }
    if (isRuleHeading(line)) dropping = DROPPED_RULE_BLOCKS.some((pattern) => pattern.test(line.trim()));
    if (dropping) continue;
    if (/watch the complete video input|watch EVERY analysis-proxy|Inspect every candidate with mustReview=true in the proxy|Analyze the uploaded source video/i.test(line)) continue;
    kept.push(line);
  }
  let text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 60).trimEnd()}\n[... remaining generic rules omitted by host ...]`;
  return text;
}

// ---------------------------------------------------------------------------
// Part-scoped context pack
// ---------------------------------------------------------------------------

function partRangesFor(seriesPlan = {}, scriptId) {
  const part = (seriesPlan?.parts || []).find((item) => Number(item.scriptId) === Number(scriptId)) || {};
  const partNumber = Number(part.partNumber || 0);
  const shared = (seriesPlan?.sharedRanges || [])
    .filter((item) => !Array.isArray(item.parts) || item.parts.map(Number).includes(partNumber))
    .map(toRange);
  return mergeRanges([
    toRange(part.hookRange), ...(part.sceneAllocation || []).map(toRange),
    ...(part.payoffRanges || []).map(toRange), toRange(part.cliffhangerRange), ...shared
  ], 1);
}
const inRanges = (range, ranges, handleSec = 1) => ranges.some((allowed) => range && range.end > allowed.start - handleSec && range.start < allowed.end + handleSec);

function mergedTranscriptLines(cues = [], ranges = [], { maxLineChars = 260, gapSec = 2.5 } = {}) {
  const lines = [];
  let current = null;
  const flush = () => { if (current) lines.push(current); current = null; };
  for (const cue of cues) {
    const cueRange = { start: num(cue.start), end: num(cue.end) };
    if (!Number.isFinite(cueRange.start) || !inRanges(cueRange, ranges, 1)) { flush(); continue; }
    if (current && current.text.length + cue.text.length + 1 <= maxLineChars && cueRange.start - current.end <= gapSec) {
      current.end = cueRange.end;
      current.text = `${current.text} ${cue.text}`;
    } else {
      flush();
      current = { start: cueRange.start, end: cueRange.end, text: compact(cue.text) };
    }
  }
  flush();
  return lines;
}

function renderEventLine(event, { maxFacts = 2, maxQuotes = 3, factChars = 130, quoteChars = 110 } = {}) {
  const facts = (event.visualFacts || []).slice(0, maxFacts).map((fact) => clip(fact, factChars));
  const quotes = (event.dialogueFacts || []).slice(0, maxQuotes)
    .map((item) => `${clip(item.speaker, 30) || "?"}: "${clip(item.quote, quoteChars)}"${Number.isFinite(num(item.sourceSec)) ? ` @${fmt(item.sourceSec)}` : ""}`);
  return `${event.eventId} [${fmt(event.sourceStartSec)}-${fmt(event.sourceEndSec)}s] ${event.storyRole || ""}: ${clip(event.summary, 220)}`
    + (facts.length ? ` | seen: ${facts.join("; ")}` : "")
    + (quotes.length ? ` | said: ${quotes.join("; ")}` : "");
}

/**
 * Everything a writer / critic / repairer needs for ONE Part, as plain text
 * with absolute source seconds. Replaces opening series-plan.json,
 * story-intelligence.json, narrative-blueprint.json, source-understanding.json,
 * scene-manifest.json, the full SRT and action-candidates.json.
 */
/**
 * SCENE CATALOG: the selectable footage of this Part. Each row = one scene of
 * the manifest with its exact duration and the frame-level ledger evidence
 * (who/what is seen, what happens, what is said). Beats reference these ids.
 */
function buildSceneCatalog({ scenes = [], ranges = [], ledgerById = null, cues = [] } = {}) {
  const lines = [];
  for (const scene of scenes) {
    const range = toRange(scene);
    if (!range || !inRanges(range, ranges, 0)) continue;
    const row = ledgerById?.get(scene.sceneId) || null;
    const said = row?.heard || clip(cues.filter((cue) => {
      const cueRange = { start: num(cue.start), end: num(cue.end) };
      return overlapSec(cueRange, range) > 0.2 && inRanges(cueRange, ranges, 0);
    }).map((cue) => cue.text).join(" "), 160);
    const parts = [`${scene.sceneId} [${fmt(range.start)}-${fmt(range.end)}] ${fmt(range.end - range.start)}s`];
    if (row?.people?.length) parts.push(`people: ${row.people.join(", ")}`);
    if (row?.seen) parts.push(`seen: ${row.seen}`);
    if (row?.action) parts.push(`action: ${row.action}`);
    if (said) parts.push(`${row?.heard ? "heard" : "transcript"}: ${said}`);
    if (row?.evidence?.length) parts.push(`evidence: ${row.evidence.join(", ")}`);
    lines.push(parts.join(" | "));
  }
  return lines;
}

function buildPartContextPack({ scriptId, seriesPlan = null, intelligence = null, cues = [], scenes = [], actionCandidates = [], transcriptBudgetChars = 7000, ledgerById = null, beatMode = false } = {}) {
  const parts = Array.isArray(seriesPlan?.parts) ? seriesPlan.parts : [];
  const index = parts.findIndex((item) => Number(item.scriptId) === Number(scriptId));
  const part = parts[index] || {};
  const previous = index > 0 ? parts[index - 1] : null;
  const next = index >= 0 && index < parts.length - 1 ? parts[index + 1] : null;
  const ranges = partRangesFor(seriesPlan, scriptId);
  const events = (intelligence?.events || []).filter((event) => inRanges(toRange(event), ranges, 0.5));
  const lines = [];
  lines.push(`=== CASE (verified; Part ${part.partNumber || "?"} = Script ${scriptId}) ===`);
  if (intelligence?.caseSummary) lines.push(`Case: ${clip(intelligence.caseSummary, 600)}`);
  lines.push(`Central viewer question: ${clip(seriesPlan?.centralViewerQuestion || intelligence?.centralViewerQuestion, 300)}`);
  if (intelligence?.centralConflict) lines.push(`Central conflict: ${clip(intelligence.centralConflict, 300)}`);
  if (seriesPlan?.hookPromise) lines.push(`Series hook promise: ${clip(seriesPlan.hookPromise, 300)}`);
  for (const character of (intelligence?.characters || []).slice(0, 8)) {
    lines.push(`Character: ${clip(character.nameOrRole || character.name || character.id, 60)} - ${clip(character.description, 160)}`);
  }
  lines.push("", "=== SERIES OUTLINE (continuity; only THIS Part is written now) ===");
  for (const item of parts) {
    const ending = item.payoff ? `payoff: ${clip(item.payoff, 180)}` : `cliffhanger: ${clip(item.cliffhanger, 180)}`;
    lines.push(`${item.partBadge || `Part ${item.partNumber}`} (Script ${item.scriptId})${Number(item.scriptId) === Number(scriptId) ? " <= THIS PART" : ""}: ${clip(item.scope, 220)} | ${ending}`);
  }
  if (previous) lines.push(`Previous Part ended on: ${clip(previous.cliffhanger || previous.payoff, 260)} [${fmt(previous.cliffhangerRange?.sourceStartSec)}-${fmt(previous.cliffhangerRange?.sourceEndSec)}s]`);
  if (next) lines.push(`Next Part opens with: ${clip(next.scope, 200)} (do NOT show or narrate it here)`);
  const contract = {
    scriptId: Number(scriptId), partNumber: part.partNumber, partBadge: part.partBadge, scope: part.scope,
    hookRange: part.hookRange, hookHandoff: part.hookHandoff,
    causalProgression: part.causalProgression, narratorArc: part.narratorArc, engagementIntent: part.engagementIntent,
    sceneAllocation: part.sceneAllocation, mustNotReveal: part.mustNotReveal,
    ...(part.payoffRanges ? { payoff: part.payoff, payoffRanges: part.payoffRanges } : { cliffhanger: part.cliffhanger, cliffhangerRange: part.cliffhangerRange }),
    sharedRanges: (seriesPlan?.sharedRanges || []).filter((item) => !Array.isArray(item.parts) || item.parts.map(Number).includes(Number(part.partNumber)))
  };
  lines.push("", "=== THIS PART'S LOCKED CONTRACT (binding JSON) ===", JSON.stringify(contract));
  lines.push("", `Allowed source ranges for this Part (s): ${ranges.map((r) => `${fmt(r.start)}-${fmt(r.end)}`).join(", ") || "none"}`);
  lines.push("", "=== VERIFIED EVENTS IN THIS PART (eventId [source range] role: summary | seen | said) ===");
  for (const event of events) lines.push(renderEventLine(event));
  if (!events.length) lines.push("(no verified event overlaps the allocation)");
  const partScenes = (scenes || []).filter((scene) => inRanges(toRange(scene), ranges, 0));
  if (beatMode) {
    const catalog = buildSceneCatalog({ scenes: partScenes, ranges, ledgerById, cues });
    lines.push("", `=== SCENE CATALOG (the footage you may use; beats reference these sceneIds; "seen/action/heard/evidence" are frame-level facts) - ${catalog.length} scenes ===`);
    lines.push(...catalog);
  } else {
    lines.push("", `=== SCENES (sceneId start-end; a segment must stay inside ONE scene) - ${partScenes.length} ===`);
    for (let offset = 0; offset < partScenes.length; offset += 8) {
      lines.push(partScenes.slice(offset, offset + 8).map((scene) => `${scene.sceneId} ${fmt(scene.startSec ?? scene.sourceStartSec)}-${fmt(scene.endSec ?? scene.sourceEndSec)}`).join(" | "));
    }
  }
  const partActions = (actionCandidates || []).filter((item) => inRanges(toRange(item), ranges, 0)).slice(0, 12);
  if (partActions.length) {
    lines.push("", "=== LOCAL MOTION/AUDIO ACTION CANDIDATES IN THIS PART (radar only, not semantic truth) ===");
    for (const item of partActions) {
      lines.push(`${item.actionCandidateId || item.id} [${fmt(item.sourceStartSec)}-${fmt(item.sourceEndSec)}s] priority ${fmt(item.actionPriorityScore ?? item.score)}${item.mustReview ? " mustReview" : ""}`);
    }
  }
  if (beatMode) transcriptBudgetChars = Math.min(transcriptBudgetChars, 5000);
  let transcript = mergedTranscriptLines(cues, ranges);
  let transcriptChars = transcript.reduce((sum, line) => sum + line.text.length + 18, 0);
  let lineLimit = 260;
  while (transcriptChars > transcriptBudgetChars && lineLimit > 90) {
    lineLimit -= 40;
    transcript = transcript.map((line) => ({ ...line, text: clip(line.text, lineLimit) }));
    transcriptChars = transcript.reduce((sum, line) => sum + line.text.length + 18, 0);
  }
  lines.push("", `=== TRANSCRIPT INSIDE THIS PART'S RANGES (absolute source seconds; rolling-caption repeats removed${lineLimit < 260 ? `; long lines clipped to ${lineLimit} chars` : ""}) ===`);
  for (const line of transcript) lines.push(`[${fmt(line.start)}-${fmt(line.end)}] ${line.text}`);
  if (!transcript.length) lines.push("(no transcript cues in these ranges)");
  const text = lines.join("\n");
  return { text, chars: text.length, ranges, eventIds: events.map((event) => event.eventId), part, transcriptLines: transcript.length };
}

// ---------------------------------------------------------------------------
// Deterministic story-structure gate (instant, before any AI review)
// ---------------------------------------------------------------------------

/**
 * Catches the story failures of the real 2026-10-13 run without an AI turn:
 *  - a planned causal event or payoff range that the Part never shows,
 *  - a flash-forward cold open whose moment the chronological story skips,
 *  - repeated back-and-forth time jumps (timeline ping-pong).
 */
function evaluateStoryStructure(script = {}, { seriesPlan = null, scriptId = null } = {}) {
  const errors = [];
  // A plan may list more causal events than fit in ~2 minutes (real accepted
  // 2026-10-09 Part 3 listed 10 events over 388s of source). A skipped event is
  // therefore advisory; payoff ranges, the hook moment and chronology block.
  const warnings = [];
  const id = Number(scriptId ?? script.scriptId);
  const part = (seriesPlan?.parts || []).find((item) => Number(item.scriptId) === id);
  const segments = segmentsOf(script);
  if (!part || !segments.length) return { errors, warnings, metrics: {} };
  const segmentRanges = segments.map(toRange);
  const covered = (range) => segmentRanges.reduce((sum, item) => sum + overlapSec(item, range), 0);
  const requiredCoverage = (range) => Math.min(3, Math.max(1, 0.3 * (range.end - range.start)));
  for (const step of part.causalProgression || []) {
    const range = toRange(step);
    if (!range) continue;
    if (covered(range) + 1e-6 < requiredCoverage(range)) {
      warnings.push({ code: "missing_planned_event", index: -1,
        message: `Locked causal event ${compact(step.eventId) || "?"} [${fmt(range.start)}-${fmt(range.end)}s] ("${clip(step.informationGain, 120)}") is not shown; include at least ${fmt(requiredCoverage(range))}s of it.` });
    }
  }
  for (const payoff of part.payoffRanges || []) {
    const range = toRange(payoff);
    if (!range) continue;
    if (covered(range) + 1e-6 < requiredCoverage(range)) {
      errors.push({ code: "missing_payoff_range", segmentIndex: segments.length - 1,
        message: `Locked payoff range ${fmt(range.start)}-${fmt(range.end)}s is missing; the Part must deliver it.` });
    }
  }
  const hook = toRange(part.hookRange);
  let leading = 0;
  while (leading < segments.length && /hook/.test(storyFunctionOf(segments[leading]))) leading += 1;
  if (!leading && hook && overlapSec(segmentRanges[0], hook) > 0) leading = 1;
  const body = segmentRanges.slice(leading).filter(Boolean);
  // Only a flash-forward INSIDE this Part's own chronology must be reached
  // later; a teaser from a later Part (paid off there) is legitimate.
  const chronology = (part.sceneAllocation || []).map(toRange).filter((range) => range && hook
    && overlapSec(range, hook) < 0.5 * (range.end - range.start));
  const hookInsideOwnChronology = Boolean(hook && chronology.some((range) => overlapSec(range, { start: hook.start - 15, end: hook.end }) > 0));
  if (hook && hookInsideOwnChronology && body.length && hook.start > Math.min(...body.map((r) => r.start)) + 30) {
    const window = { start: hook.start - 15, end: hook.end + 10 };
    if (!body.some((r) => overlapSec(r, window) > 0)) {
      errors.push({ code: "hook_moment_skipped", segmentIndex: leading,
        message: `The cold open is a flash-forward to ${fmt(hook.start)}-${fmt(hook.end)}s, but the chronological story never reaches that moment (nothing from ${fmt(window.start)}-${fmt(window.end)}s). Show the lead-up into the hook moment (a recap of at most 3s of the hook itself is allowed).` });
    }
  }
  let backwardJumps = 0;
  const jumpIndexes = [];
  for (let i = 1; i < segmentRanges.length; i += 1) {
    if (!segmentRanges[i] || !segmentRanges[i - 1]) continue;
    if (segmentRanges[i].start < segmentRanges[i - 1].start - 15) {
      if (i === leading) continue; // the one rewind right after the cold open
      backwardJumps += 1;
      jumpIndexes.push(i);
    }
  }
  if (backwardJumps > 0) {
    errors.push({ code: "temporal_ping_pong", segmentIndex: jumpIndexes[0],
      message: `${backwardJumps} backward time jump(s) after the opening (segments ${jumpIndexes.map((i) => i + 1).join(", ")}). After the cold open, tell the story in source order; place court/aftermath material once, after the scene it follows.` });
  }
  return { errors, warnings, metrics: { backwardJumps, leadingHookSegments: leading, missingPlannedEvents: warnings.length } };
}

// ---------------------------------------------------------------------------
// Packets + prompts
// ---------------------------------------------------------------------------

const SCRIPT_SCHEMA_RULES = [
  "OUTPUT SCRIPT REQUIREMENTS (the host validates every field):",
  "- Root: artifactType \"highlight_cut_script\", scriptId, title/suggestedTitle (4-8 word cold-viewer hook grounded in this Part), partBadge, titleStyle \"tiktok_hook\", subtitleStyle \"tiktok_karaoke\", story_blueprint (primaryQuestion, plannedEvents with eventIds, causalProgression) and narration_arc that agree with the segments, segments[].",
  "- Each segment: id, sceneId, sourceStartSec, sourceEndSec, audio_mode (\"original_audio\" | \"voiceover_only\" | \"voiceover_with_ambient\"), voiceover_text (\"\" for original_audio), storyFunction (hook, context, bridge, escalation, reveal, evidence, confrontation, climax, consequence, cliffhanger, payoff), transitionReason, macroBlockId, sourceRunId; actionCandidateId/actionSequenceId when a segment shows a listed action.",
  "- Every segment stays inside ONE scene (scene.startSec <= sourceStartSec < sourceEndSec <= scene.endSec). Split a beat at scene boundaries; never copy one voiceover line into several segments.",
  "- Do NOT return startSec/endSec/outputStartSec/outputEndSec/duration/playbackSpeed: the host derives the output timeline.",
  "- Narration is natural, conversational US English; each line ADDS verified context, causality or reinterpretation and hands off to authentic audio. Never describe what is already visible, never invent charges, motives, names or outcomes."
].join("\n");

const STRUCTURE_RULES = [
  "HOST STORY-STRUCTURE GATE (checked instantly by the host; a Part that breaks one is sent back):",
  "- Show the causalProgression events of the locked contract in order; drop a minor one only when the duration target forces it, never one the hook promises or the ending needs.",
  "- A payoff Part shows EVERY payoffRange. A cliffhanger Part ends on its cliffhangerRange.",
  "- If the cold open is a flash-forward, the chronological story must later arrive at that moment (show the lead-up into it; at most a 3s recap of the hook footage).",
  "- After the cold open: at most ONE rewind, spoken aloud by the narrator (\"Earlier that night...\"). No back-and-forth between timelines; aftermath/court material comes once, after the scene it follows.",
  "- Every segment must lie inside the allowed source ranges listed in the context."
].join("\n");

const BEAT_PLAN_RULES = [
  "OUTPUT = A BEAT PLAN. The HOST computes every timestamp, scene split, duration and the output timeline from it.",
  "- A beat is ONE continuous piece of footage: one or more CONSECUTIVE scenes from the SCENE CATALOG (sceneIds). Optional startSec/endSec (absolute source seconds) only trim inside those scenes.",
  "- audio: \"original\" (authentic source audio, no narration) | \"narration\" (narrator over muted footage) | \"narration_ambient\" (narrator over lowered source sound).",
  "- narration: the spoken English line for narration beats only. Its words must fit the beat: words <= floor(beat seconds x narrator words/s). Pick footage long enough for the line.",
  "- Original-audio beats: the host moves cuts off the middle of a spoken sentence; still choose scenes where the exchange is complete.",
  "- role: hook | context | bridge | escalation | reveal | evidence | confrontation | climax | consequence | cliffhanger | payoff. eventId: the verified event the beat shows. why: one short reason for this beat/transition.",
  "- Narration may only state what the catalog/events/transcript support (seen/heard/evidence). Never name a person before the footage or narration introduces them.",
  "- Total of all beats: inside the production target. Use the scene durations in the catalog to add it up."
].join("\n");

function buildPartWriterPacket({ scriptId, contextText, rulesText = "", constraintLines = [], measuredWordsPerSecond = 0, durationMinSec = 110, durationMaxSec = 125, outputMode = "segments" } = {}) {
  return [
    `HOST PART-WRITER PACKET - Script ${scriptId}`,
    "This packet is COMPLETE. The source video was already watched 100% and verified in Phase A; everything you may use is below.",
    "",
    contextText,
    "",
    `=== PRODUCTION TARGET: ${durationMinSec}-${durationMaxSec}s of source footage for this Part (never under 60.5s) ===`,
    ...(constraintLines.length ? ["HOST PRODUCTION GATE (exact numbers the host measures):", ...constraintLines] : []),
    ...(measuredWordsPerSecond ? [`Narrator speed: ${measuredWordsPerSecond} words/s. A voiceover segment of N seconds holds at most floor(N x ${measuredWordsPerSecond}) words.`] : []),
    "",
    STRUCTURE_RULES,
    "",
    outputMode === "beats" ? BEAT_PLAN_RULES : SCRIPT_SCHEMA_RULES,
    "",
    "=== EDITORIAL PROFILE RULES (from the user's package prompt) ===",
    "PRECEDENCE: the LOCKED CONTRACT, HOST gates and OUTPUT requirements above override these profile rules. Where they mention returning three scripts, Markdown code blocks, a provisional hook anchor, segment/timestamp fields, or watching/uploading video, write ONLY this Part, in the requested JSON envelope, from the packet context.",
    rulesText
  ].join("\n");
}

function beatPlanExample(scriptId) {
  return JSON.stringify({ artifacts: [{ filename: `beats-${scriptId}.json`, script: {
    artifactType: "story_beat_plan", scriptId, title: "4-8 WORD HOOK TITLE", primaryQuestion: "",
    beats: [{ beatId: "b1", sceneIds: ["scene_0001"], startSec: null, endSec: null, audio: "original", narration: "", role: "hook", eventId: "", why: "" }]
  } }] });
}

function buildPartWriterPrompt({ scriptId, partBadge = "", packetPath, outputMode = "segments" }) {
  return [
    `You are executing Phase B (Script Generation) for ONE Part only: Script ${scriptId}${partBadge ? ` (${partBadge})` : ""} of a True Crime series.`,
    "You are a script writer, not a developer. Text-only: never open video files, never run commands, never write files, never search.",
    `Read the host packet with view_file (it may take 2-3 calls for the whole file), then write the script: ${packetPath}`,
    "The packet is complete and authoritative: do NOT open any other file (no transcript, manifest, plan, blueprint or prompt files).",
    "Before answering, check your segment list against the HOST STORY-STRUCTURE GATE and HOST PRODUCTION GATE in the packet.",
    "Keep your reasoning SHORT: plan the beat list once, do not draft or re-draft the full script in your thinking, then write the JSON directly. Your total output budget is limited.",
    "This is a one-turn headless execution: no plan, no questions, no partial output.",
    outputMode === "beats"
      ? `Return exactly ONE JSON object, no prose, no Markdown, shaped like: ${beatPlanExample(scriptId)}`
      : `Return exactly ONE JSON object, no prose, no Markdown: {"artifacts":[{"filename":"script-${scriptId}.json","script":{...COMPLETE SCRIPT...}}],"notes":""}`
  ].join("\n");
}

function renderScriptForReview(script = {}, cues = [], { maxHeardChars = 240, ledgerById = null } = {}) {
  const lines = [];
  let outputCursor = 0;
  segmentsOf(script).forEach((segment, index) => {
    const range = toRange(segment);
    const duration = range ? range.end - range.start : 0;
    const voice = voiceOf(segment);
    const mode = audioModeOf(segment);
    const heard = range && mode !== "voiceover_only"
      ? clip(cues.filter((cue) => overlapSec({ start: num(cue.start), end: num(cue.end) }, range) > 0.2).map((cue) => cue.text).join(" "), maxHeardChars)
      : "";
    const sceneIds = Array.isArray(segment.sceneIds) && segment.sceneIds.length ? segment.sceneIds : [segment.sceneId].filter(Boolean);
    const seen = ledgerById ? sceneIds.map((id) => ledgerById.get(id)).filter((row) => row && (row.seen || row.action))
      .map((row) => clip([row.seen, row.action].filter(Boolean).join("; "), 160)) : [];
    const words = voice ? voice.split(/\s+/).filter(Boolean).length : 0;
    const budget = segment.hostWordBudget?.maxWords;
    lines.push(`#${index}${segment.beatId ? ` ${segment.beatId}` : ""} t=${fmt(outputCursor)}s src ${range ? `${fmt(range.start)}-${fmt(range.end)}` : "?"} (${fmt(duration)}s)${sceneIds.length ? ` [${sceneIds.join(",")}]` : ""} ${storyFunctionOf(segment) || "-"} ${mode}`
      + (voice ? ` NARRATOR (${words}${Number.isFinite(budget) ? `/${budget} max` : ""} words): "${voice}"` : "")
      + (heard ? ` | ORIGINAL AUDIO: "${heard}"` : "")
      + (seen.length ? ` | SEEN: ${seen.join(" / ")}` : ""));
    outputCursor += duration;
  });
  return { text: lines.join("\n"), totalSec: outputCursor };
}

function buildColdViewerPartPacket({ scriptId, script, contextText, cues = [], ledgerById = null } = {}) {
  const rendered = renderScriptForReview(script, cues, { ledgerById });
  return [
    `COLD-VIEWER PACKET - Script ${scriptId} (${fmt(rendered.totalSec)}s)`,
    "",
    "=== THE EDIT EXACTLY AS THE VIEWER EXPERIENCES IT (zero-based beat index; NARRATOR = spoken voiceover; ORIGINAL AUDIO = what is heard from the source; SEEN = frame-level facts of the footage) ===",
    rendered.text,
    "",
    "=== SOURCE EVIDENCE AND LOCKED PART CONTRACT (for grounding your judgement) ===",
    contextText
  ].join("\n");
}

function buildColdViewerPartPrompt({ scriptId, packetPath, criticalCodes = [] }) {
  return [
    "You are an INDEPENDENT COLD VIEWER / TRUE-CRIME EDITOR, not the script writer.",
    `Judge ONE proposed edit (Script ${scriptId}) as if you have NEVER seen the case. TEXT ONLY: never open video files, never run commands.`,
    `Read ONLY this host packet with view_file (2-3 calls may be needed): ${packetPath}`,
    "Identify the curiosity question the opening creates and whether the NEXT 15 seconds orient viewers to characters, place, cause and any time jump.",
    "Audit each bridge using the exact SPOKEN narrator text. Hidden metadata does not orient a viewer.",
    "Audit the middle for stretches without narrative progress (a meaningful quiet reaction is NOT dead air) and for back-and-forth time jumps.",
    "Audit whether the ending VISIBLY/AUDIBLY delivers the locked cliffhanger/payoff and every planned payoff event.",
    "Do not invent charges, motives, timecodes, dialogue or people; a character's statement is a claim, not proven truth.",
    "Check every NARRATOR line against SEEN, ORIGINAL AUDIO and the verified events: a line that contradicts them is false_claim; naming someone the viewer has not been introduced to is wrong_actor.",
    "For EACH substantial problem give the zero-based beat index, a verified eventId/time window, the viewer-level consequence and a concrete required change.",
    "Set accepted=false if any hook-to-context, causal/temporal continuity, narrator grounding or ending problem remains. 80/100 is the minimum recommendation, never pass on score alone.",
    `Allowed issue codes: ${criticalCodes.join(", ")}.`,
    `Return EXACTLY ONE JSON object, no Markdown: {"artifacts":[{"filename":"audience-review.json","script":{"artifactType":"audience_review","schemaVersion":1,"parts":[{"scriptId":${scriptId},"score":0,"accepted":false,"hookQuestion":"","hookHandoffAssessment":"","narratorContribution":"","weakestMoment":"","endingPayoffAssessment":"","issues":[{"code":"","segmentIndex":0,"sourceEventId":"","whyViewerLeaves":"","requiredChange":""}]}]}}]}`,
    "Use issues=[] only when the Part is genuinely compelling, unambiguous and evidence-grounded."
  ].join("\n");
}

function describeFailuresForRepair(result = {}) {
  const lines = [];
  for (const error of result.errors || []) {
    lines.push(`- [${error.code}]${Number.isInteger(error.segmentIndex) && error.segmentIndex >= 0 ? ` beat ${error.segmentIndex}` : ""}: ${clip(error.message, 600)}`);
  }
  for (const issue of result.productionPreflight?.issues || []) lines.push(`- [production_preflight] ${clip(issue, 300)}`);
  for (const issue of result.renderDryRun?.issues || []) lines.push(`- [render_dry_run] ${clip(issue.message, 300)}`);
  return [...new Set(lines)];
}

const BEAT_EDIT_RULES = [
  "OUTPUT = EDIT OPERATIONS on the current beats (by beatId). The host applies them and recompiles every timestamp. Change only what the problems require.",
  "- {\"op\":\"update\",\"beatId\":\"b6\",\"set\":{\"narration\":\"...\"}}  (set any of: narration, audio, sceneIds, startSec, endSec, role, eventId, why)",
  "- {\"op\":\"replace\",\"beatId\":\"b6\",\"beat\":{...complete beat...}}",
  "- {\"op\":\"insert_after\",\"beatId\":\"b3\",\"beat\":{...}}  (beatId \"START\" inserts at the beginning)",
  "- {\"op\":\"delete\",\"beatId\":\"b12\"}",
  "- A beat = consecutive scenes from the SCENE CATALOG; audio original|narration|narration_ambient; narration words <= floor(seconds x words/s)."
].join("\n");

function buildPartRepairPacket({ scriptId, script, result = {}, contextText, cues = [], constraintLines = [], wordBudgetLines = [], measuredWordsPerSecond = 0, durationMinSec = 110, durationMaxSec = 125, repairRound = 1, outputMode = "segments", ledgerById = null, beatPlan = null } = {}) {
  const rendered = renderScriptForReview(script, cues, { ledgerById });
  const beatMode = outputMode === "beats" && beatPlan;
  return [
    `HOST REPAIR PACKET - Script ${scriptId}, repair round ${repairRound}. This packet is COMPLETE; open nothing else.`,
    "",
    "=== PROBLEMS YOU MUST FIX (host gates + independent cold viewer) ===",
    ...describeFailuresForRepair(result),
    ...(wordBudgetLines.length ? ["", "VOICEOVER LINES TOO LONG FOR THEIR FOOTAGE:", ...wordBudgetLines] : []),
    "",
    `=== HOW THE CURRENT EDIT PLAYS (zero-based beats${beatMode ? "; the word after the index is the beatId to edit" : ""}) ===`,
    rendered.text,
    "",
    `=== PRODUCTION TARGET: ${durationMinSec}-${durationMaxSec}s, never under 60.5s ===`,
    ...(constraintLines.length ? ["HOST PRODUCTION GATE (ALL must hold at the same time):", ...constraintLines] : []),
    ...(measuredWordsPerSecond ? [`Narrator speed: ${measuredWordsPerSecond} words/s; voiceover words <= floor(segment seconds x ${measuredWordsPerSecond}).`] : []),
    "Do not regress: every gate the current script already satisfies must still hold after your repair.",
    "",
    STRUCTURE_RULES,
    "",
    beatMode ? BEAT_EDIT_RULES : SCRIPT_SCHEMA_RULES,
    "",
    "=== SOURCE CONTEXT FOR THIS PART ===",
    contextText,
    "",
    ...(beatMode
      ? ["=== CURRENT BEAT PLAN (edit by beatId) ===", JSON.stringify({ title: beatPlan.title, beats: beatPlan.beats })]
      : ["=== CURRENT SCRIPT JSON (edit this; keep every field the importer needs) ===", JSON.stringify(script)])
  ].join("\n");
}

function buildPartRepairPrompt({ scriptId, packetPath, outputMode = "segments" }) {
  return [
    "You are executing Phase B (Script Generation) EDITORIAL REPAIR of ONE True Crime Part. You are a script writer, not a developer.",
    "Text-only: never open video files, never run commands, never write files, never search.",
    `Read ONLY this host packet with view_file (2-4 calls may be needed for the whole file): ${packetPath}`,
    `Repair EXACTLY Part Script ${scriptId}: fix every listed problem that the evidence supports, without inventing facts or passing by metadata alone.`,
    "Priority: (1) factual problems (false_claim, wrong_actor, missing_evidence): correct or delete any narration the packet does not support; (2) host gate problems; (3) story/hook/bridge problems.",
    "Change only what the problems require and keep every other segment as it is. Keep your reasoning SHORT and write the JSON directly; your total output budget is limited.",
    ...(outputMode === "beats"
      ? [
        "Return EDIT OPERATIONS on the current beat plan (see the packet), not a complete script.",
        `Return exactly ONE JSON object, no prose, no Markdown: {"artifacts":[{"filename":"beat-edits-${scriptId}.json","script":{"artifactType":"story_beat_edits","scriptId":${scriptId},"title":"","edits":[{"op":"update","beatId":"b1","set":{"narration":"..."}}]}}]}`
      ]
      : [
        "Return a COMPLETE replacement script, not a patch or plan.",
        `Return exactly ONE JSON object, no prose, no Markdown: {"artifacts":[{"filename":"script-${scriptId}.json","script":{...COMPLETE SCRIPT...}}]}`
      ])
  ].join("\n");
}

/** Compact Series Plan evidence: one file instead of six (incl. the 95KB SRT paged 10x). */
function buildSeriesPlanPacket({ intelligence = null, hookContract = null, hookTournament = null, scenes = [], videoDurationSec = 0 } = {}) {
  const lines = [`SERIES PLAN EVIDENCE PACKET - source ${fmt(videoDurationSec)}s. COMPLETE and verified; open nothing else.`, ""];
  lines.push("=== CASE ===");
  if (intelligence?.caseSummary) lines.push(`Case: ${clip(intelligence.caseSummary, 700)}`);
  if (intelligence?.centralConflict) lines.push(`Central conflict: ${clip(intelligence.centralConflict, 300)}`);
  if (intelligence?.centralViewerQuestion) lines.push(`Central viewer question (draft): ${clip(intelligence.centralViewerQuestion, 300)}`);
  for (const character of (intelligence?.characters || []).slice(0, 10)) {
    lines.push(`Character: ${clip(character.nameOrRole || character.id, 60)} - ${clip(character.description, 160)}`);
  }
  lines.push("", "=== VERIFIED STORY TIMELINE (eventId [source range] role: summary | seen | said) ===");
  for (const event of intelligence?.events || []) lines.push(renderEventLine(event, { maxFacts: 2, maxQuotes: 4 }));
  if (hookContract) {
    const anchor = hookContract?.variants?.variant_01?.anchorRange || hookContract?.anchorRange || {};
    lines.push("", "=== HOOK CONTRACT ===",
      `isUserLocked=${hookContract.isUserLocked === true}; hook "${clip(hookContract.title, 120)}" anchor ${fmt(anchor.startSec ?? anchor.sourceStartSec)}-${fmt(anchor.endSec ?? anchor.sourceEndSec)}s; tolerance ${JSON.stringify(hookContract.trimmingTolerance || {})}`);
  }
  if (hookTournament?.candidates?.length) {
    lines.push("", `=== STORY-AWARE HOOK TOURNAMENT (editorial heuristic, not audience data; ${hookTournament.selectionRule ? clip(hookTournament.selectionRule, 200) : ""}) ===`);
    for (const candidate of hookTournament.candidates.slice(0, 8)) {
      lines.push(`${candidate.candidateId} [${fmt(candidate.sourceStartSec)}-${fmt(candidate.sourceEndSec)}s] event ${candidate.sourceEventId || "-"} overall ${candidate.scores?.overall} (curiosity ${candidate.scores?.curiosity}, story ${candidate.scores?.storyRelevance}, payoff ${candidate.scores?.payoff}, spoiler ${candidate.scores?.spoiler}) "${clip(candidate.candidateTitle, 80)}" payoffs: ${(candidate.payoffEventIds || []).join(",")}`);
    }
  }
  lines.push("", `=== SCENE INDEX (sceneId start-end; ${scenes.length} scenes) ===`);
  for (let offset = 0; offset < scenes.length; offset += 10) {
    lines.push(scenes.slice(offset, offset + 10).map((scene) => `${scene.sceneId} ${fmt(scene.startSec)}-${fmt(scene.endSec)}`).join(" | "));
  }
  return lines.join("\n");
}

module.exports = {
  compact, num, clip, toRange, overlapSec, mergeRanges, stableHash, segmentsOf, voiceOf, audioModeOf, storyFunctionOf, fmt,
  repairJsonBrackets, buildPackageReadOnlyGuard, estimateWriteTimeoutMs,
  extractEditorialRules, partRangesFor, mergedTranscriptLines, buildPartContextPack, evaluateStoryStructure,
  buildPartWriterPacket, buildPartWriterPrompt, renderScriptForReview, buildColdViewerPartPacket, buildColdViewerPartPrompt,
  describeFailuresForRepair, buildPartRepairPacket, buildPartRepairPrompt, buildSeriesPlanPacket,
  STRUCTURE_RULES, SCRIPT_SCHEMA_RULES, BEAT_PLAN_RULES, BEAT_EDIT_RULES, buildSceneCatalog
};
