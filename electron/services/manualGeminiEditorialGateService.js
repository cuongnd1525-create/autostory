"use strict";
const SERIES_PROFILES = new Set(["serialized_interleaved", "serialized_genz"]);
const PART_BY_SCRIPT = new Map([[1, 1], [3, 2], [4, 3]]);
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
function validateManualGeminiEditorialContract({script = {}, normalizedScript = {}, promptOptions = {}, hookContract = null} = {}) {
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
module.exports = {validateManualGeminiEditorialContract, auditSerializedVariants, getOpeningHook};
