"use strict";

// Series-level contract shared by Stage 1 (before handing scripts off) and
// the Highlight Cut import. Keeping one implementation guarantees Stage 1
// never approves a set of Parts that the import would later reject.

const text = (value) => (value === undefined || value === null ? "" : String(value).trim());
const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const SHARED_HOOK_MISMATCH_MESSAGE =
  "Series bật Cold Open dùng chung nhưng toàn bộ chuỗi Hook đầu của ba Part không trùng sceneId, timestamp nguồn và action sequence. Hãy yêu cầu Gemini dùng cùng một Hook hành động hoàn chỉnh 5-30s, chia theo scene khi cần và cắt trước narrator nguồn.";
const NARRATOR_RANGE_MISMATCH_MESSAGE =
  "Ba Part dùng source_narrator_ranges khác nhau. Hãy yêu cầu Gemini quét narrator nguồn một lần và chép cùng bản đồ timestamp narrator vào cả ba JSON.";

function segmentStoryFunction(segment = {}) {
  return text(segment.storyFunction || segment.story_function || segment.sceneType || segment.scene_type);
}

function leadingHookSegments(segments = []) {
  const result = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (!/hook/i.test(segmentStoryFunction(segment))) break;
    result.push(segment);
  }
  return result;
}

function hookSignature(segments = []) {
  return leadingHookSegments(segments).map((segment) => ({
    sceneId: text(segment.sceneId || segment.scene_id || segment.id),
    sourceStartSec: Number(num(segment.sourceStartSec ?? segment.source_start_sec).toFixed(3)),
    sourceEndSec: Number(num(segment.sourceEndSec ?? segment.source_end_sec).toFixed(3)),
    macroBlockId: text(segment.macroBlockId || segment.macro_block_id),
    sourceRunId: text(segment.sourceRunId || segment.source_run_id),
    actionSequenceId: text(segment.actionSequenceId || segment.action_sequence_id)
  }));
}

function leadingHooksIdentical(segmentLists = []) {
  const signatures = segmentLists.map((segments) => JSON.stringify(hookSignature(segments)));
  if (!signatures.length || signatures[0] === "[]") return false;
  return signatures.every((signature) => signature === signatures[0]);
}

function narratorRangeSignature(ranges = []) {
  return JSON.stringify((Array.isArray(ranges) ? ranges : []).map((range) => ({
    startSec: Number(num(range.startSec ?? range.sourceStartSec).toFixed(3)),
    endSec: Number(num(range.endSec ?? range.sourceEndSec).toFixed(3)),
    replacementText: text(range.replacementText || range.text),
    confidence: text(range.confidence)
  })));
}

/**
 * Validate the cross-Part contract of an interleaved series.
 *
 * variants: [{ seriesMode, sharedHookEnabled, sharedHookDeclared, segments, sourceNarratorRanges }]
 *   sharedHookDeclared=false means the script never set shared_hook_enabled, so
 *   a shared cold open was not requested (Story-First series plans give each
 *   Part its own hookRange). Undeclared + different hooks => per-Part hooks.
 *
 * Returns { errors: [{code, message}], sharedHookEnabled, inferredPerPartHook }.
 */
function checkSeriesImportContract(variants = []) {
  const serialized = (Array.isArray(variants) ? variants : [])
    .filter((variant) => text(variant?.seriesMode) === "interleaved_multipart");
  const errors = [];
  let sharedHookEnabled = null;
  let inferredPerPartHook = false;
  if (serialized.length > 1) {
    const claimingShared = serialized.filter((variant) => variant.sharedHookEnabled !== false);
    if (claimingShared.length > 1) {
      const identical = leadingHooksIdentical(claimingShared.map((variant) => variant.segments));
      const explicitlyShared = claimingShared.some((variant) => variant.sharedHookDeclared !== false);
      if (identical) {
        sharedHookEnabled = true;
      } else if (!explicitlyShared) {
        sharedHookEnabled = false;
        inferredPerPartHook = true;
      } else {
        errors.push({ code: "shared_hook_mismatch", message: SHARED_HOOK_MISMATCH_MESSAGE });
      }
    } else {
      sharedHookEnabled = false;
    }
    const reference = narratorRangeSignature(serialized[0].sourceNarratorRanges);
    if (serialized.some((variant) => narratorRangeSignature(variant.sourceNarratorRanges) !== reference)) {
      errors.push({ code: "narrator_ranges_mismatch", message: NARRATOR_RANGE_MISMATCH_MESSAGE });
    }
  }
  return { errors, sharedHookEnabled, inferredPerPartHook };
}

/**
 * Stage 1 helper: build contract variants from raw script JSON objects.
 */
function contractVariantFromScript(script = {}) {
  const declared = typeof script.shared_hook_enabled === "boolean"
    || typeof script.sharedHookEnabled === "boolean";
  const value = typeof script.shared_hook_enabled === "boolean"
    ? script.shared_hook_enabled
    : typeof script.sharedHookEnabled === "boolean" ? script.sharedHookEnabled : true;
  return {
    seriesMode: text(script.series_mode || script.seriesMode),
    sharedHookEnabled: value,
    sharedHookDeclared: declared,
    segments: Array.isArray(script.segments) ? script.segments : [],
    sourceNarratorRanges: script.source_narrator_ranges || script.sourceNarratorRanges || []
  };
}

/**
 * Stage 1: make the series hook mode explicit and deterministic.
 * The Locked Series Plan is authoritative: a shared cold open is declared only
 * when every Part really opens with the identical hook chain; otherwise each
 * Part keeps its own planned hook (shared_hook_enabled=false).
 * Returns { scripts, sharedHookEnabled, changed, contract }.
 */
function finalizeSeriesHookMode(scripts = []) {
  const list = Array.isArray(scripts) ? scripts : [];
  const serialized = list.filter((script) => text(script?.series_mode || script?.seriesMode) === "interleaved_multipart");
  if (serialized.length < 2) {
    return { scripts: list, sharedHookEnabled: null, changed: false, narratorRangesMerged: false, contract: checkSeriesImportContract([]) };
  }
  const sharedHookEnabled = leadingHooksIdentical(serialized.map((script) => script.segments));
  let changed = false;
  const next = list.map((script) => {
    if (text(script?.series_mode || script?.seriesMode) !== "interleaved_multipart") return script;
    if (script.shared_hook_enabled === sharedHookEnabled && script.sharedHookEnabled === undefined) return script;
    changed = true;
    const { sharedHookEnabled: _camel, ...rest } = script;
    return { ...rest, shared_hook_enabled: sharedHookEnabled };
  });
  // source_narrator_ranges are facts about the SOURCE video, not about a Part,
  // so every Part must carry the same map. Merge them when Parts disagree.
  const serializedNext = next.filter((script) => text(script?.series_mode || script?.seriesMode) === "interleaved_multipart");
  const rangeLists = serializedNext.map((script) => script.source_narrator_ranges || script.sourceNarratorRanges || []);
  const signatures = rangeLists.map((ranges) => narratorRangeSignature(ranges));
  let narratorRangesMerged = false;
  let output = next;
  if (signatures.some((signature) => signature !== signatures[0])) {
    const seen = new Map();
    rangeLists.flat().filter((range) => range && typeof range === "object").forEach((range) => {
      const key = narratorRangeSignature([range]);
      if (!seen.has(key)) seen.set(key, { ...range });
    });
    const merged = [...seen.values()].sort((left, right) =>
      num(left.startSec ?? left.sourceStartSec) - num(right.startSec ?? right.sourceStartSec));
    output = next.map((script) => {
      if (text(script?.series_mode || script?.seriesMode) !== "interleaved_multipart") return script;
      const { sourceNarratorRanges: _camelRanges, ...rest } = script;
      return { ...rest, source_narrator_ranges: merged.map((range) => ({ ...range })) };
    });
    narratorRangesMerged = true;
    changed = true;
  }
  const contract = checkSeriesImportContract(output.map(contractVariantFromScript));
  return { scripts: output, sharedHookEnabled, changed, narratorRangesMerged, contract };
}

module.exports = {
  SHARED_HOOK_MISMATCH_MESSAGE,
  NARRATOR_RANGE_MISMATCH_MESSAGE,
  leadingHookSegments,
  hookSignature,
  leadingHooksIdentical,
  narratorRangeSignature,
  checkSeriesImportContract,
  contractVariantFromScript,
  finalizeSeriesHookMode
};
