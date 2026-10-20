"use strict";

/**
 * Bridge between the automatic Antigravity Series flow and the Series import.
 *
 * The import (dubbingService.importHighlightCut) requires a locked
 * `<package>/series-blueprint.json` (artifactType serialized_story_blueprint,
 * schemaVersion 2) and checks every Script with validateScriptAgainstBlueprint.
 * The manual Gemini GUI flow produces it via "Nhập Series Blueprint"; the
 * Antigravity flow produced only 01-ANTIGRAVITY-RESULT/series-plan.json, so the
 * import always stopped with "Chưa có Blueprint đã khóa".
 *
 * Here the locked series plan is converted to that SAME Blueprint v2 contract,
 * checked with the SAME validators the import uses, written where the import
 * reads it, and the deterministic series fields are copied into each Script by
 * the host (never trusted to the model).
 */

const fs = require("fs/promises");
const path = require("path");
const Serial = require("./serializedGeminiWorkflowService");

const HOOK_KINDS = ["dialogue_conflict", "physical_action", "mixed", "visual_reveal"];
const BEAT_KINDS = ["dialogue", "action", "visual", "context"];
const OPEN_ENDING_ROLES = ["cliffhanger", "escalation", "contradiction", "reveal"];
const FINAL_ENDING_ROLES = ["resolution", "consequence", "payoff"];
const DEFAULT_PART_ROLES = { 1: "setup_and_escalation", 3: "escalation_and_revelation", 4: "verified_climax_and_outcome" };

const str = (value) => String(value == null ? "" : value).trim();
const num = (value) => (value == null || value === "" || !Number.isFinite(Number(value)) ? NaN : Number(value));
const clone = (value) => JSON.parse(JSON.stringify(value));

function slug(value) {
  return str(value).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/** Stable id: same source + fingerprint -> same seriesId across reruns. */
function deriveSeriesId({ plan = {}, manifest = {}, packageInfo = {} } = {}) {
  if (str(plan.seriesId)) return str(plan.seriesId);
  const source = str(manifest.sourceVideo || path.basename(str(packageInfo.sourceVideoPath).replace(/\\/g, "/")));
  const base = slug(source.replace(/\.[a-z0-9]+$/i, "")) || "series";
  const fingerprint = str(packageInfo.cache?.sourceFingerprint || packageInfo.sourceFingerprint).replace(/[^a-z0-9]/gi, "").slice(0, 8);
  return fingerprint ? `${base}-${fingerprint}` : base;
}

function rangeOf(item = {}) {
  return {
    start: num(item.sourceStartSec ?? item.startSec ?? item.start),
    end: num(item.sourceEndSec ?? item.endSec ?? item.end)
  };
}

function isBlueprintMode({ series, packageInfo } = {}) {
  return Boolean(series && packageInfo?.sequentialSeriesEnabled === true);
}

/** series_plan (AGY) -> serialized_story_blueprint v2 (import contract). Pure. */
function buildBlueprintFromSeriesPlan(plan, { manifest = {}, packageInfo = {} } = {}) {
  const parts = Array.isArray(plan?.parts) ? plan.parts : [];
  return {
    artifactType: "serialized_story_blueprint",
    schemaVersion: 2,
    seriesId: deriveSeriesId({ plan, manifest, packageInfo }),
    prompt_profile: str(packageInfo.sequentialSeriesProfile || plan?.profile || plan?.prompt_profile),
    series_mode: "interleaved_multipart",
    shared_hook_enabled: packageInfo.sequentialSeriesSharedHook === true,
    shared_top_banner_text: str(plan?.shared_top_banner_text || plan?.sharedTopBannerText),
    sourceVideo: str(manifest.sourceVideo || plan?.sourceVideo),
    sourceDurationSec: Number.isFinite(num(manifest.videoDurationSec)) ? num(manifest.videoDurationSec) : (num(plan?.sourceDurationSec) || 0),
    centralViewerQuestion: str(plan?.centralViewerQuestion),
    verifiedCausalChain: (Array.isArray(plan?.verifiedCausalChain) ? plan.verifiedCausalChain : []).map(str).filter(Boolean),
    source_narrator_ranges: (Array.isArray(plan?.source_narrator_ranges) ? plan.source_narrator_ranges : []).map((range) => {
      const { start, end } = rangeOf(range);
      return {
        startSec: start,
        endSec: end,
        replacementText: str(range.replacementText),
        confidence: str(range.confidence) || "medium",
        ...(str(range.summary) ? { summary: str(range.summary) } : {})
      };
    }),
    parts: parts.map((part) => {
      const scriptId = num(part.scriptId);
      const hook = part.hook && typeof part.hook === "object" ? part.hook : {};
      const hookRange = rangeOf(Number.isFinite(rangeOf(hook).start) ? hook : (part.hookRange || {}));
      return {
        scriptId,
        part_number: num(part.partNumber ?? part.part_number),
        role: str(part.role) || DEFAULT_PART_ROLES[scriptId] || "",
        hook: {
          kind: str(hook.kind).toLowerCase(),
          sourceStartSec: hookRange.start,
          sourceEndSec: hookRange.end,
          hookProof: str(hook.hookProof || hook.proof)
        },
        storyScope: str(part.scope || part.storyScope),
        outroPromise: str(part.cliffhanger || part.payoff || part.outroPromise),
        chapterBeats: (Array.isArray(part.chapterBeats) ? part.chapterBeats : []).map((beat) => {
          const { start, end } = rangeOf(beat);
          return {
            beatId: str(beat.beatId),
            kind: str(beat.kind).toLowerCase(),
            role: str(beat.role).toLowerCase(),
            sourceStartSec: start,
            sourceEndSec: end,
            sceneIds: (Array.isArray(beat.sceneIds) ? beat.sceneIds : []).map(str).filter(Boolean),
            sourceProof: str(beat.sourceProof),
            mustInclude: beat.mustInclude !== false
          };
        })
      };
    }),
    derivedFrom: { artifactType: "series_plan", producer: "antigravity_cli", lockedAt: plan?.lockedAt || null }
  };
}

/** Same check the import runs (plus the user-locked hook contract, like importBlueprint). */
function validateBlueprintForPackage(blueprint, { manifest = {}, packageInfo = {}, hookContract = null } = {}) {
  return Serial.validateBlueprint(blueprint, {
    manifest,
    profile: str(packageInfo.sequentialSeriesProfile) || undefined,
    sharedHook: typeof packageInfo.sequentialSeriesSharedHook === "boolean" ? packageInfo.sequentialSeriesSharedHook : undefined,
    hookContract
  });
}

/**
 * Copies the deterministic series fields from the Blueprint into a Script and
 * normalises beat references. Returns a NEW object; never touches timing.
 */
function applyBlueprintToScript(script, blueprint) {
  const notes = [];
  const out = clone(script || {});
  const scriptId = num(out.scriptId ?? out.script_id);
  const plan = (blueprint?.parts || []).find((part) => num(part.scriptId) === scriptId) || null;
  out.series_id = blueprint.seriesId;
  out.shared_top_banner_text = blueprint.shared_top_banner_text;
  out.shared_hook_enabled = blueprint.shared_hook_enabled;
  out.prompt_profile = blueprint.prompt_profile;
  out.series_mode = blueprint.series_mode;
  out.source_narrator_ranges = clone(blueprint.source_narrator_ranges || []);
  if (plan) out.part_number = plan.part_number;
  const allowed = new Set((plan?.chapterBeats || []).map((beat) => str(beat.beatId)));
  for (const segment of Array.isArray(out.segments) ? out.segments : []) {
    if (!segment || typeof segment !== "object") continue;
    const alias = str(segment.chapterBeatId || segment.chapter_beat_id);
    if (!str(segment.beatId || segment.beat_id) && alias) {
      segment.beatId = alias;
      delete segment.chapterBeatId;
      delete segment.chapter_beat_id;
    }
    const beatId = str(segment.beatId || segment.beat_id);
    // "hook" style labels are not chapterBeat references (the Hook is not a beat).
    if (beatId && !allowed.has(beatId) && /(^|_)hook(_|$)/i.test(beatId)) {
      delete segment.beatId;
      delete segment.beat_id;
      notes.push(`segment ${str(segment.segmentId) || "?"}: bỏ beatId "${beatId}" (Hook không phải chapterBeat).`);
    }
    for (const element of Array.isArray(segment.on_screen_elements) ? segment.on_screen_elements : []) {
      if (element && element.type === "top_banner" && blueprint.shared_top_banner_text) element.text = blueprint.shared_top_banner_text;
    }
  }
  return { script: out, notes };
}

function validateScriptForBlueprint(script, blueprint) {
  return Serial.validateScriptAgainstBlueprint(script, blueprint);
}

async function writeJsonAtomicLocal(target, value) {
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2), "utf8");
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

/** Writes <package>/series-blueprint.json and records it in package-info.json (same as importBlueprint). */
async function writeLockedBlueprint({ packageDir, blueprint }) {
  const target = path.join(packageDir, "series-blueprint.json");
  await writeJsonAtomicLocal(target, blueprint);
  const infoPath = path.join(packageDir, "package-info.json");
  const info = JSON.parse(await fs.readFile(infoPath, "utf8"));
  info.seriesBlueprintPath = target;
  await writeJsonAtomicLocal(infoPath, info);
  return target;
}

/** Vocabulary reminder appended to repair prompts. */
const BLUEPRINT_VOCABULARY = [
  `hook.kind ∈ {${HOOK_KINDS.join(", ")}}; a verbal confrontation is dialogue_conflict, not physical_action.`,
  `chapterBeats[].kind ∈ {${BEAT_KINDS.join(", ")}}; chapterBeats[].role is ONE lowercase word.`,
  `Last beat role of Part 1 and Part 2 ∈ {${OPEN_ENDING_ROLES.join(", ")}}; last beat role of Part 3 ∈ {${FINAL_ENDING_ROLES.join(", ")}}.`,
  "2-6 short beats per Part (evidence anchors, typically 3-25s), not a partition; no beat overlaps its own Part's hook; no core beat overlaps another Part.",
  "Every source_narrator_ranges item has startSec, endSec, summary, replacementText (one short factual voice-over line that can replace the narrator audio) and confidence.",
  "shared_top_banner_text: one short factual title shared by all Parts."
];

module.exports = {
  HOOK_KINDS,
  BEAT_KINDS,
  OPEN_ENDING_ROLES,
  FINAL_ENDING_ROLES,
  BLUEPRINT_VOCABULARY,
  isBlueprintMode,
  deriveSeriesId,
  buildBlueprintFromSeriesPlan,
  validateBlueprintForPackage,
  applyBlueprintToScript,
  validateScriptForBlueprint,
  writeLockedBlueprint
};
