"use strict";
const SERIES_PROFILES = new Set(["serialized_interleaved", "serialized_genz"]);
const PART_BY_SCRIPT = new Map([[1, 1], [3, 2], [4, 3]]);
const {parseSrtCues} = require("./hookMiningService");
const txt = v => String(v == null ? "" : v).trim();
const num = (v, fallback = NaN) => v == null || v === "" || !Number.isFinite(Number(v)) ? fallback : Number(v);

function isSeries(script = {}, promptOptions = {}) {
  return SERIES_PROFILES.has(txt(promptOptions.profile || script.prompt_profile || script.promptProfile))
    || txt(script.series_mode || script.seriesMode) === "interleaved_multipart";
}
function getOpeningHook(segments = []) {
  const result = [];
  for (const segment of segments) {
    const phase = txt(segment.storyFunction || segment.story_function || segment.sceneType || segment.scene_type).toLowerCase();
    if (result.length && !phase.includes("hook")) break;
    result.push(segment);
  }
  return result;
}

/**
 * Deterministic editorial checks. SRT text is an approximate cue, not a
 * sample-accurate source of speaker identity or visual/audio proof.
 * Unverifiable semantic claims remain review warnings rather than fabricated passes.
 */
function auditSerializedBeatBoundaries({script = {}, normalizedScript = {}, transcriptSrt = "", sourceEvidence = null} = {}) {
  const errors = [], warnings = [];
  const segments = Array.isArray(normalizedScript.segments) ? normalizedScript.segments : [];
  const raw = Array.isArray(script.segments) ? script.segments : [];
  const cues = transcriptSrt ? parseSrtCues(transcriptSrt) : [];
  const part = num(script.part_number ?? script.partNumber, 0);
  const evidenceList = Array.isArray(sourceEvidence?.evidence) ? sourceEvidence.evidence : [];
  const evidenceById = new Map(evidenceList.map(e => [txt(e.evidenceId || e.id), e]));
  const beats = new Map();
  const duration = s => Math.max(0, num(s?.sourceEndSec, 0) - num(s?.sourceStartSec, 0));
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i], r = raw[i] || {};
    const mode = txt(s.audioMode || s.audio_mode);
    const id = txt(s.sustainedBeatId || s.sustained_beat_id || r.sustainedBeatId);
    const evidence = evidenceById.get(txt(r.evidenceId || r.evidence_id || s.evidenceId));
    if (mode === "voiceover_only" && s.sourceNarratorDetected !== true && r.source_narrator_detected !== true
      && (r.safeForVoiceover === false || (evidence?.safeForVoiceover === false && evidence?.burnedTextPresent === true))) {
      errors.push("Segment " + (i + 1) + " selects unsafe voiceover B-roll containing conflicting burned-in source captions. Choose a clean evidence shot.");
    }
    if (txt(r.cutSafety).toLowerCase() === "unsafe") {
      errors.push("Segment " + (i + 1) + " explicitly declares cutSafety=unsafe.");
    }
    if (id) {
      if (mode !== "original_audio") errors.push("Sustained beat " + id + " must use original_audio.");
      const previous = beats.get(id);
      if (previous !== undefined && i !== previous + 1) errors.push("Sustained beat " + id + " is interrupted by another segment.");
      if (previous !== undefined) {
        const a = segments[previous];
        if (Math.abs(num(a.sourceEndSec) - num(s.sourceStartSec)) > 0.15) {
          errors.push("Sustained beat " + id + " has a source gap/cut between scene slices.");
        }
      }
      beats.set(id, i);
    }
    if (mode !== "original_audio" && duration(s) > 10.5) {
      warnings.push("VO segment " + (i + 1) + " exceeds the 10s adaptive bridge target; measure actual TTS before trimming.");
    }
    if (mode === "original_audio" && txt(r.caption || s.caption)) {
      warnings.push("Segment " + (i + 1) + ": original_audio caption metadata ignored by narrator-only overlay; move visual edit notes to action_notes.");
    }
    // Only an explicitly declared source quote can be range-validated.
    const proof = r.payoffProof || r.payoff_proof;
    if (proof) {
      const ps = num(proof.sourceStartSec), pe = num(proof.sourceEndSec);
      const quote = txt(proof.quote);
      const run = [];
      for (let k = i + 1; k < segments.length; k++) {
        if (txt(segments[k].audioMode) !== "original_audio") break;
        run.push(segments[k]);
      }
      if (mode === "original_audio" || !quote || !Number.isFinite(ps) || !Number.isFinite(pe) || pe <= ps
          || !run.length || ps < num(run[0].sourceStartSec) - 0.1 || pe > num(run.at(-1).sourceEndSec) + 0.1
          || !run.some(x => num(x.sourceStartSec) <= ps + 0.1 && num(x.sourceEndSec) >= Math.min(pe, num(x.sourceEndSec)) - 0.1)) {
        errors.push("Segment " + (i + 1) + " payoffProof is missing or lies outside immediately following original_audio.");
      } else if (cues.length) {
        const spoken = cues.filter(c => c.startSec < pe && c.endSec > ps).map(c => c.text).join(" ").toLowerCase();
        const words = [...new Set(quote.toLowerCase().replace(/[^a-z0-9'\s]/g," ").split(/\s+/).filter(w=>w.length>2))];
        const overlap = words.filter(w=>spoken.includes(w)).length;
        if (words.length && overlap / words.length < 0.6) {
          warnings.push("Segment " + (i + 1) + " payoffProof quote not strongly supported by SRT: listen to source before render.");
        }
      } else {
        warnings.push("Segment " + (i + 1) + " payoffProof has source-range support only; no SRT available to verify quoted words.");
      }
    } else if (mode !== "original_audio" && /\b(?:confess(?:ed|es)?|admit(?:ted|s)?|accus(?:es?|ed)|snitch(?:es|ed)?|told (?:the )?(?:cop|police|officer)s?\s+(?:that|who)|reveals? (?:that|who))\b/i.test(txt(s.voiceoverText || r.voiceover_text))) {
      warnings.push("Segment " + (i + 1) + " narrates a specific verbal reveal without payoffProof; verify the following source dialogue.");
    }
  }
  const last = segments.at(-1);
  if ((part === 1 || part === 2) && last && txt(last.audioMode) === "original_audio" && cues.length) {
    const end = num(last.sourceEndSec), start = num(last.sourceStartSec);
    const crossing = cues.find(c => c.startSec + 0.15 < end && end + 0.45 < c.endSec && c.endSec > start);
    if (crossing) errors.push("Part " + part + " final original_audio ends inside an SRT cue (" + crossing.startSec + "-" + crossing.endSec + "s). Complete the spoken line or end on a verified VO cliffhanger.");
  }
  return {errors, warnings};
}

function validateManualGeminiEditorialContract({script = {}, normalizedScript = {}, promptOptions = {}, hookContract = null, transcriptSrt = "", sourceEvidence = null} = {}) {
  const errors = [], warnings = [];
  const segments = Array.isArray(normalizedScript.segments) ? normalizedScript.segments : [];
  const scriptId = num(script.scriptId ?? script.script_id);
  const serialized = isSeries(script, promptOptions);
  const sharedHook = promptOptions.sharedHook === true;
  if (serialized) {
    const expectedPart = PART_BY_SCRIPT.get(scriptId);
    const declaredPart = num(script.part_number ?? script.partNumber);
    if (!expectedPart) errors.push("Series requires scriptId 1, 3 or 4.");
    else if (declaredPart !== expectedPart) errors.push("Script " + scriptId + " must be Part " + expectedPart + ", JSON says Part " + declaredPart + ".");
    if (txt(script.series_mode || script.seriesMode) !== "interleaved_multipart") {
      errors.push("Series JSON must declare series_mode=interleaved_multipart.");
    }
    if (script.shared_hook_enabled !== sharedHook && script.sharedHookEnabled !== sharedHook) {
      errors.push("JSON shared_hook_enabled conflicts with the UI Hook Policy.");
    }
    const min = num(promptOptions.minDuration, 75), max = num(promptOptions.maxDuration, 110);
    const duration = num(normalizedScript.totalDuration, 0);
    if (duration < min - 0.05 || duration > max + 0.05) {
      errors.push("Part duration " + duration.toFixed(2) + "s is outside " + min + "-" + max + "s.");
    }
    if (!(script.story_blueprint || script.storyBlueprint)) warnings.push("Story blueprint missing; review causal continuity.");
  }
  if (!segments.length) errors.push("No timeline segments.");
  else if (serialized && txt(segments[0].audioMode) !== "original_audio") {
    errors.push("Series Hook must begin with original_audio.");
  }
  if (hookContract?.isUserLocked) {
    const anchorPart = serialized && sharedHook ? 1 : PART_BY_SCRIPT.get(scriptId);
    const anchor = hookContract.isMultiVariant
      ? hookContract.variants?.["variant_0" + anchorPart]
      : scriptId === 1 ? hookContract : null;
    if (anchor) {
      const start = num(anchor.anchorRange?.startSec), end = num(anchor.anchorRange?.endSec);
      const early = num(anchor.trimmingTolerance?.startOffsetMaxSec, 2);
      const late = num(anchor.trimmingTolerance?.endOffsetMaxSec, 3);
      const hook = getOpeningHook(segments);
      const first = num(hook[0]?.sourceStartSec);
      const overlaps = hook.some(s => num(s.sourceStartSec) < end + late && num(s.sourceEndSec) > start - early);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) errors.push("Invalid locked Hook anchor.");
      else if (!Number.isFinite(first) || first < start - early - 0.15 || first >= end + late || !overlaps) {
        errors.push("Script " + scriptId + " opens outside user-locked Hook " + start + "-" + end + "s.");
      }
    }
  }
  if (serialized) {
    const integrity = auditSerializedBeatBoundaries({script, normalizedScript, transcriptSrt, sourceEvidence});
    errors.push(...integrity.errors);
    warnings.push(...integrity.warnings);
  }
  if (serialized && !sharedHook && hookContract?.isUserLocked && hookContract?.hasDuplicates) {
    warnings.push("Part-specific Hook contract repeats a candidate; check chapter replay.");
  }
  return {passed: errors.length === 0, errors, warnings, scriptId, serialized, sharedHook};
}
function auditSerializedVariants(variants = [], options = {}) {
  const warnings = [];
  if (!SERIES_PROFILES.has(txt(options.profile)) || variants.length < 2) return warnings;
  const ids = [...new Set(variants.map(v => txt(v.seriesId)).filter(Boolean))];
  if (ids.length > 1) warnings.push("Series uses multiple series_id values: " + ids.join(", "));
  if (options.sharedHook === true) return warnings;
  for (let i = 0; i < variants.length; i++) for (let j = i + 1; j < variants.length; j++) {
    const overlap = [];
    for (const a of variants[i].segments || []) for (const b of variants[j].segments || []) {
      const start = Math.max(num(a.sourceStartSec, 0), num(b.sourceStartSec, 0));
      const end = Math.min(num(a.sourceEndSec, 0), num(b.sourceEndSec, 0));
      if (end > start) overlap.push([start, end]);
    }
    overlap.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, e] of overlap) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    const seconds = merged.reduce((total, [s, e]) => total + e - s, 0);
    if (seconds > 3.05) warnings.push("Parts " + PART_BY_SCRIPT.get(num(variants[i].scriptId)) + "/"
      + PART_BY_SCRIPT.get(num(variants[j].scriptId)) + " reuse " + seconds.toFixed(1) + "s source footage.");
  }
  return warnings;
}
module.exports = {validateManualGeminiEditorialContract, auditSerializedVariants, auditSerializedBeatBoundaries, getOpeningHook};
