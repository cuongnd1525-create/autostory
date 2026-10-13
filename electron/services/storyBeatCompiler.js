"use strict";

/**
 * "AI chooses, host computes" for Story-First Parts.
 *
 * The writer returns a BEAT PLAN: an ordered list of beats, each pointing at
 * one or more consecutive scenes of the scene manifest, with the audio
 * treatment, the narration text and its story role. The host compiles it into
 * the importer's segment schema (exact source ranges from the manifest,
 * speech-boundary snapping, source runs, blueprint metadata).
 *
 * Repairs are EDIT OPERATIONS on that plan (update / replace / insert_after /
 * delete by beatId) instead of a complete rewritten script. Real run
 * 2026-10-13: complete-script repairs burned ~63K thinking tokens each and
 * never finished; an edit list is a small, local task.
 *
 * Invariant: one compiled segment per kept beat, in beat order, so a
 * cold-viewer "beat index" is also the segment index and the beat index.
 */

const compact = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const num = (value, fallback = NaN) => (value === "" || value === null || value === undefined
  ? fallback : (Number.isFinite(Number(value)) ? Number(value) : fallback));
const round3 = (value) => Number(Number(value).toFixed(3));
const wordsOf = (text) => compact(text).split(/\s+/).filter(Boolean).length;

const AUDIO_ALIASES = new Map([
  ["original", "original"], ["original_audio", "original"], ["source", "original"], ["raw", "original"],
  ["narration", "narration"], ["voiceover", "narration"], ["voiceover_only", "narration"], ["voice", "narration"],
  ["narration_ambient", "narration_ambient"], ["voiceover_with_ambient", "narration_ambient"], ["narration_over_ambient", "narration_ambient"]
]);
const AUDIO_MODE = { original: "original_audio", narration: "voiceover_only", narration_ambient: "voiceover_with_ambient" };

function isBeatPlan(value) {
  return Boolean(value && typeof value === "object" && Array.isArray(value.beats) && value.beats.length);
}
function isBeatEdits(value) {
  return Boolean(value && typeof value === "object" && Array.isArray(value.edits));
}

function normalizeBeat(raw = {}, fallbackId) {
  const sceneIds = (Array.isArray(raw.sceneIds) ? raw.sceneIds : raw.sceneId ? [raw.sceneId] : [])
    .map((id) => compact(id)).filter(Boolean);
  const narration = compact(raw.narration ?? raw.voiceover_text ?? raw.voiceoverText ?? "");
  let audio = AUDIO_ALIASES.get(compact(raw.audio ?? raw.audio_mode ?? raw.audioMode).toLowerCase()) || "";
  if (!audio) audio = narration ? "narration" : "original";
  return {
    beatId: compact(raw.beatId || raw.id) || fallbackId,
    sceneIds,
    startSec: Number.isFinite(num(raw.startSec ?? raw.sourceStartSec)) ? num(raw.startSec ?? raw.sourceStartSec) : null,
    endSec: Number.isFinite(num(raw.endSec ?? raw.sourceEndSec)) ? num(raw.endSec ?? raw.sourceEndSec) : null,
    audio,
    narration: audio === "original" ? "" : narration,
    role: compact(raw.role || raw.storyFunction || raw.story_function).toLowerCase() || "context",
    eventId: compact(raw.eventId),
    why: compact(raw.why || raw.transitionReason || raw.purpose),
    actionCandidateId: compact(raw.actionCandidateId),
    ...(compact(raw.macroBlockId) ? { macroBlockId: compact(raw.macroBlockId) } : {}),
    ...(audio === "original" && narration ? { droppedNarration: narration } : {})
  };
}

/** Normalizes any writer output into { scriptId, title, beats[] } with unique beatIds. */
function normalizeBeatPlan(raw = {}, scriptId) {
  const seen = new Set();
  let counter = 0;
  const beats = (Array.isArray(raw.beats) ? raw.beats : []).map((beat) => {
    counter += 1;
    const normalized = normalizeBeat(beat, `b${counter}`);
    let id = normalized.beatId;
    while (seen.has(id)) id = `${normalized.beatId}_${(counter += 1)}`;
    seen.add(id);
    return { ...normalized, beatId: id };
  });
  return {
    artifactType: "story_beat_plan",
    scriptId: Number(scriptId ?? raw.scriptId),
    title: compact(raw.title || raw.suggestedTitle),
    suggestedTitle: compact(raw.suggestedTitle || raw.title),
    primaryQuestion: compact(raw.primaryQuestion),
    beats
  };
}

function sceneIndex(scenes = []) {
  const ordered = [...scenes]
    .map((scene) => ({ sceneId: compact(scene.sceneId), start: num(scene.startSec ?? scene.sourceStartSec), end: num(scene.endSec ?? scene.sourceEndSec) }))
    .filter((scene) => scene.sceneId && Number.isFinite(scene.start) && Number.isFinite(scene.end) && scene.end > scene.start)
    .sort((a, b) => a.start - b.start);
  const byId = new Map(ordered.map((scene, index) => [scene.sceneId, { ...scene, index }]));
  return { ordered, byId };
}

/**
 * Moves an ORIGINAL-AUDIO cut off the middle of a spoken cue: the start goes
 * back to the cue start, the end forward to the cue end (<= maxExtendSec) or
 * back to the cue start. Bounds keep the beat out of other beats' footage.
 * (Cold viewer 2026-10-13: "audio abruptly cuts off mid-sentence".)
 */
function snapToSpeech(range, cues = [], { lowerBound = -Infinity, upperBound = Infinity, maxExtendSec = 2, minLenSec = 1.5 } = {}) {
  let { start, end } = range;
  const startCue = cues.find((cue) => cue.start < start - 0.05 && cue.end > start + 0.2);
  if (startCue && startCue.start >= lowerBound - 1e-6 && start - startCue.start <= maxExtendSec) start = startCue.start;
  const endCue = cues.find((cue) => cue.start < end - 0.2 && cue.end > end + 0.05);
  if (endCue) {
    if (endCue.end - end <= maxExtendSec && endCue.end <= upperBound + 1e-6) end = endCue.end;
    else if (endCue.start - start >= minLenSec) end = endCue.start;
  }
  return { start, end, snapped: start !== range.start || end !== range.end };
}

function compileBeatPlan(rawPlan, {
  scriptId, scenes = [], cues = [], wordsPerSecond = 0, part = null, seriesPlan = null, partBadge = "", maxDurationSec = Infinity
} = {}) {
  const plan = normalizeBeatPlan(rawPlan, scriptId);
  const { ordered, byId } = sceneIndex(scenes);
  const errors = [];
  const warnings = [];
  const issue = (list, code, beat, message) => list.push({ code, beatId: beat?.beatId || null, message });
  const resolved = [];
  for (const beat of plan.beats) {
    const known = beat.sceneIds.filter((id) => byId.has(id));
    const unknown = beat.sceneIds.filter((id) => !byId.has(id));
    if (unknown.length) issue(errors, "beat_unknown_scene", beat, `Beat ${beat.beatId}: unknown sceneId ${unknown.slice(0, 3).join(", ")}; use only scenes from the SCENE CATALOG.`);
    let chosen = known.map((id) => byId.get(id)).sort((a, b) => a.index - b.index);
    if (!chosen.length && Number.isFinite(beat.startSec) && Number.isFinite(beat.endSec) && beat.endSec > beat.startSec) {
      chosen = ordered.filter((scene) => scene.end > beat.startSec + 0.05 && scene.start < beat.endSec - 0.05).map((scene) => byId.get(scene.sceneId));
    }
    if (!chosen.length) {
      issue(errors, "beat_without_footage", beat, `Beat ${beat.beatId} has no valid scene; it was not compiled.`);
      continue;
    }
    // One beat = one continuous piece of footage (consecutive scenes).
    const run = [chosen[0]];
    for (let index = 1; index < chosen.length; index += 1) {
      const previous = run[run.length - 1];
      if (chosen[index].index === previous.index + 1 || chosen[index].start - previous.end <= 0.6) run.push(chosen[index]);
      else {
        issue(errors, "beat_scenes_not_contiguous", beat, `Beat ${beat.beatId}: scenes ${chosen.map((scene) => scene.sceneId).join(", ")} are not consecutive; a beat is one continuous shot sequence. Split it into separate beats.`);
        break;
      }
    }
    const sceneStart = run[0].start;
    const sceneEnd = run[run.length - 1].end;
    let start = sceneStart;
    let end = sceneEnd;
    if (Number.isFinite(beat.startSec)) {
      if (beat.startSec >= sceneStart - 0.05 && beat.startSec < sceneEnd) start = Math.max(sceneStart, beat.startSec);
      else issue(warnings, "beat_trim_outside_scenes", beat, `Beat ${beat.beatId}: startSec ${beat.startSec} is outside its scenes; ignored.`);
    }
    if (Number.isFinite(beat.endSec)) {
      if (beat.endSec > start && beat.endSec <= sceneEnd + 0.05) end = Math.min(sceneEnd, beat.endSec);
      else issue(warnings, "beat_trim_outside_scenes", beat, `Beat ${beat.beatId}: endSec ${beat.endSec} is outside its scenes; ignored.`);
    }
    if (beat.audio !== "original" && !beat.narration) {
      issue(errors, "beat_narration_missing", beat, `Beat ${beat.beatId} is a narration beat without narration text.`);
    }
    if (beat.droppedNarration) {
      issue(warnings, "beat_narration_on_original_audio", beat, `Beat ${beat.beatId}: audio "original" cannot carry narration; the narration was ignored.`);
    }
    resolved.push({ beat, run, start, end });
  }
  // Snap original-audio cuts to speech, never into another beat's footage.
  // An edge is left alone when it is already a natural cut or when moving it
  // would trip an import gate (real bwq import 2026-10-13):
  //  - it sits on a scene boundary (shot change); the importer also clamps
  //    any 0.12-0.5s overrun past a scene edge, undoing the snap;
  //  - it is shared with another beat (source-contiguous sequence chosen by
  //    the writer): moving it only shifts footage between the two beats and
  //    lengthened one continuous original-audio run past 15s;
  //  - it would shrink a >=4s beat under the 4s micro-cut threshold.
  const SCENE_EDGE_TOL = 0.12;
  const IMPORT_CLAMP_SEC = 0.5;
  const MICRO_CUT_SEC = 4;
  const sceneEdges = [...new Set(ordered.flatMap((scene) => [scene.start, scene.end]))];
  const onSceneEdge = (time) => sceneEdges.some((edge) => Math.abs(edge - time) <= SCENE_EDGE_TOL);
  const clampedByImport = (from, to) => sceneEdges.some((edge) => {
    const overrun = to > from ? to - edge : edge - to;
    const crossed = to > from ? from < edge - SCENE_EDGE_TOL && to > edge + SCENE_EDGE_TOL : from > edge + SCENE_EDGE_TOL && to < edge - SCENE_EDGE_TOL;
    return crossed && overrun <= IMPORT_CLAMP_SEC;
  });
  const original = resolved.map((item) => ({ start: item.start, end: item.end }));
  const sharedEdge = (index, time) => original.some((range, other) => other !== index
    && (Math.abs(range.end - time) <= 0.05 || Math.abs(range.start - time) <= 0.05));
  resolved.forEach((item, index) => {
    if (item.beat.audio !== "original") return;
    const others = resolved.filter((_, other) => other !== index);
    const lowerBound = Math.max(-Infinity, ...others.filter((o) => o.end <= item.start + 0.05).map((o) => o.end));
    const upperBound = Math.min(Infinity, ...others.filter((o) => o.start >= item.end - 0.05).map((o) => o.start));
    const snapped = snapToSpeech({ start: item.start, end: item.end }, cues, { lowerBound, upperBound });
    if (!snapped.snapped) return;
    const length = item.end - item.start;
    const keep = (from, to) => from === to || onSceneEdge(from) || sharedEdge(index, from) || clampedByImport(from, to);
    let start = keep(item.start, snapped.start) ? item.start : snapped.start;
    let end = keep(item.end, snapped.end) ? item.end : snapped.end;
    if (length >= MICRO_CUT_SEC && end - start < MICRO_CUT_SEC) {
      // Prefer the edge that does not shorten the beat.
      if (end < item.end) end = item.end;
      if (end - start < MICRO_CUT_SEC && start > item.start) start = item.start;
    }
    if (start === item.start && end === item.end) return;
    item.snappedFrom = { start: item.start, end: item.end };
    item.start = start;
    item.end = end;
  });
  // Snapping may only lengthen the Part while it stays inside the target:
  // undo the largest extensions first if the total went over the maximum.
  const total = () => resolved.reduce((sum, item) => sum + (item.end - item.start), 0);
  if (Number.isFinite(maxDurationSec) && total() > maxDurationSec) {
    const extended = resolved.filter((item) => item.snappedFrom)
      .map((item) => ({ item, gain: (item.end - item.start) - (item.snappedFrom.end - item.snappedFrom.start) }))
      .filter((entry) => entry.gain > 0).sort((a, b) => b.gain - a.gain);
    for (const { item } of extended) {
      if (total() <= maxDurationSec) break;
      item.start = item.snappedFrom.start;
      item.end = item.snappedFrom.end;
      delete item.snappedFrom;
    }
  }
  // After snapping a range may reach into a neighbouring scene: list every
  // scene it covers so the importer keeps the range instead of clamping it.
  for (const item of resolved) {
    const covering = ordered.filter((scene) => scene.end > item.start + 0.05 && scene.start < item.end - 0.05);
    if (covering.length) item.run = covering.map((scene) => byId.get(scene.sceneId));
  }
  for (let index = 0; index < resolved.length; index += 1) {
    const item = resolved[index];
    if (item.end - item.start < 0.8) issue(errors, "beat_too_short", item.beat, `Beat ${item.beat.beatId} is ${(item.end - item.start).toFixed(2)}s; a beat needs at least 0.8s.`);
    for (let other = 0; other < index; other += 1) {
      const overlap = Math.min(item.end, resolved[other].end) - Math.max(item.start, resolved[other].start);
      if (overlap > 3) issue(errors, "beat_duplicate_footage", item.beat, `Beat ${item.beat.beatId} repeats ${overlap.toFixed(1)}s of beat ${resolved[other].beat.beatId}'s footage (only a recap of at most 3s is allowed).`);
      else if (overlap > 0.3) issue(warnings, "beat_short_recap", item.beat, `Beat ${item.beat.beatId} re-uses ${overlap.toFixed(1)}s of beat ${resolved[other].beat.beatId}.`);
    }
  }
  let runCounter = 0;
  let previousEnd = null;
  const segments = resolved.map((item, index) => {
    if (previousEnd === null || Math.abs(item.start - previousEnd) > 2) runCounter += 1;
    previousEnd = item.end;
    const duration = item.end - item.start;
    const maxWords = wordsPerSecond > 0 ? Math.floor(duration * wordsPerSecond) : null;
    return {
      id: `highlight_${String(index + 1).padStart(4, "0")}`,
      segmentId: `highlight_${String(index + 1).padStart(4, "0")}`,
      beatId: item.beat.beatId,
      sceneId: item.run[0].sceneId,
      sceneIds: item.run.map((scene) => scene.sceneId),
      sourceStartSec: round3(item.start),
      sourceEndSec: round3(item.end),
      audio_mode: AUDIO_MODE[item.beat.audio],
      voiceover_text: item.beat.audio === "original" ? "" : item.beat.narration,
      storyFunction: item.beat.role,
      transitionReason: item.beat.why,
      ...(item.beat.eventId ? { eventId: item.beat.eventId } : {}),
      ...(item.beat.actionCandidateId ? { actionCandidateId: item.beat.actionCandidateId } : {}),
      // Macro blocks group beats of the same story event (or the same
      // continuous source run); one block per beat looks like a montage to
      // the production preflight ("16 macro-block > 12").
      macroBlockId: item.beat.macroBlockId || (item.beat.eventId ? `event_${item.beat.eventId}` : `run_${String(runCounter).padStart(2, "0")}`),
      sourceRunId: `run_${String(runCounter).padStart(2, "0")}`,
      ...(item.snappedFrom ? { hostSpeechSnap: { from: [round3(item.snappedFrom.start), round3(item.snappedFrom.end)] } } : {}),
      ...(maxWords !== null && item.beat.audio !== "original" ? { hostWordBudget: { words: wordsOf(item.beat.narration), maxWords } } : {})
    };
  });
  const eventBeats = new Map();
  for (const segment of segments) {
    if (!segment.eventId) continue;
    if (!eventBeats.has(segment.eventId)) eventBeats.set(segment.eventId, []);
    eventBeats.get(segment.eventId).push(segment.beatId);
  }
  const script = {
    artifactType: "highlight_cut_script",
    schemaVersion: 1,
    scriptId: Number(scriptId ?? plan.scriptId),
    title: plan.title || plan.suggestedTitle || "",
    suggestedTitle: plan.suggestedTitle || plan.title || "",
    partBadge: partBadge || part?.partBadge || "",
    titleStyle: "tiktok_hook",
    subtitleStyle: "tiktok_karaoke",
    story_blueprint: {
      primaryQuestion: plan.primaryQuestion || compact(seriesPlan?.centralViewerQuestion),
      hookPromise: compact(seriesPlan?.hookPromise),
      plannedEvents: [...eventBeats.entries()].map(([eventId, beatIds]) => ({ eventId, beatIds })),
      causalProgression: Array.isArray(part?.causalProgression) ? part.causalProgression : []
    },
    narration_arc: segments.filter((segment) => segment.voiceover_text)
      .map((segment) => ({ beatId: segment.beatId, narratorFunction: segment.storyFunction, text: segment.voiceover_text })),
    segments,
    beatPlan: plan,
    hostCompile: { compiler: "host_beat_compiler_v1", errors, warnings, beatCount: plan.beats.length, segmentCount: segments.length }
  };
  return { script, plan, errors, warnings };
}

/**
 * Applies repair edits by beatId. Unknown targets and malformed ops are
 * rejected individually (reported back), never guessed.
 */
function applyBeatEdits(rawPlan, editsDoc = {}) {
  const plan = normalizeBeatPlan(rawPlan, rawPlan?.scriptId);
  const beats = plan.beats.map((beat) => ({ ...beat }));
  const applied = [];
  const rejected = [];
  const indexOf = (beatId) => beats.findIndex((beat) => beat.beatId === compact(beatId));
  const freshId = (wanted) => {
    let id = compact(wanted) || `b${beats.length + 1}`;
    let n = 1;
    while (beats.some((beat) => beat.beatId === id)) id = `${compact(wanted) || "b"}_n${(n += 1)}`;
    return id;
  };
  for (const edit of Array.isArray(editsDoc.edits) ? editsDoc.edits : []) {
    const op = compact(edit?.op).toLowerCase();
    const target = compact(edit?.beatId);
    const position = indexOf(target);
    if (op === "delete") {
      if (position < 0) { rejected.push({ edit, reason: `unknown beatId ${target}` }); continue; }
      beats.splice(position, 1);
      applied.push({ op, beatId: target });
    } else if (op === "update") {
      if (position < 0 || !edit.set || typeof edit.set !== "object") { rejected.push({ edit, reason: position < 0 ? `unknown beatId ${target}` : "update needs set{}" }); continue; }
      beats[position] = { ...normalizeBeat({ ...beats[position], ...edit.set }, target), beatId: target };
      applied.push({ op, beatId: target });
    } else if (op === "replace") {
      if (position < 0 || !edit.beat) { rejected.push({ edit, reason: position < 0 ? `unknown beatId ${target}` : "replace needs beat{}" }); continue; }
      beats[position] = { ...normalizeBeat(edit.beat, target), beatId: target };
      applied.push({ op, beatId: target });
    } else if (op === "insert_after" || op === "insert_before") {
      if (!edit.beat || (target !== "START" && target !== "END" && position < 0)) { rejected.push({ edit, reason: !edit.beat ? `${op} needs beat{}` : `unknown beatId ${target}` }); continue; }
      const beat = normalizeBeat(edit.beat, "");
      beat.beatId = freshId(beat.beatId);
      const at = target === "START" ? 0 : target === "END" ? beats.length : (op === "insert_after" ? position + 1 : position);
      beats.splice(at, 0, beat);
      applied.push({ op, beatId: beat.beatId, anchor: target });
    } else {
      rejected.push({ edit, reason: `unknown op ${op || "(empty)"}` });
    }
  }
  return {
    plan: { ...plan, beats, ...(compact(editsDoc.title) ? { title: compact(editsDoc.title), suggestedTitle: compact(editsDoc.title) } : {}) },
    applied,
    rejected
  };
}

/**
 * Lifts an existing segment script (legacy writer output or an older cache)
 * into a beat plan: one beat per segment, keeping its exact source range,
 * audio, narration and role, so later repairs can use edit operations.
 */
function segmentsToBeatPlan(script = {}, scenes = []) {
  const { ordered } = sceneIndex(scenes);
  const segments = Array.isArray(script.segments) ? script.segments : [];
  return normalizeBeatPlan({
    scriptId: script.scriptId,
    title: script.title || script.suggestedTitle,
    suggestedTitle: script.suggestedTitle || script.title,
    primaryQuestion: script.story_blueprint?.primaryQuestion || "",
    beats: segments.map((segment, index) => {
      const start = num(segment.sourceStartSec);
      const end = num(segment.sourceEndSec);
      const covering = ordered.filter((scene) => scene.end > start + 0.05 && scene.start < end - 0.05).map((scene) => scene.sceneId);
      const voice = compact(segment.voiceover_text ?? segment.voiceoverText);
      const mode = compact(segment.audio_mode ?? segment.audioMode).toLowerCase();
      return {
        beatId: compact(segment.beatId) || `b${index + 1}`,
        sceneIds: covering.length ? covering : [compact(segment.sceneId)].filter(Boolean),
        startSec: start,
        endSec: end,
        audio: mode === "original_audio" ? "original" : mode === "voiceover_with_ambient" ? "narration_ambient" : (voice ? "narration" : "original"),
        narration: voice,
        role: segment.storyFunction || segment.story_function,
        eventId: segment.eventId,
        why: segment.transitionReason || segment.transition_reason,
        actionCandidateId: segment.actionCandidateId,
        macroBlockId: segment.macroBlockId || segment.macro_block_id
      };
    })
  }, script.scriptId);
}

module.exports = {
  isBeatPlan, isBeatEdits, normalizeBeat, normalizeBeatPlan, compileBeatPlan, applyBeatEdits, snapToSpeech, sceneIndex, segmentsToBeatPlan, AUDIO_MODE
};
