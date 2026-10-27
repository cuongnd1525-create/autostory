"use strict";

/**
 * Runs, at Stage 1 time, the same per-Script checks that
 * dubbingService.importHighlightCut runs for a sequential Series package
 * (story-spine compile -> validateManualGeminiScript -> Series shaping ->
 * normalizeHighlightCutScript -> validateManualGeminiEditorialContract), so a
 * Script that the import would reject ("Sustained beat ... has a source
 * gap/cut", "final original_audio ends inside an SRT cue", duration window...)
 * is repaired in the AI session instead of failing after the project is made.
 *
 * Prompt options come from the package (profile, Hook policy) and the Part
 * prompt's duration window; the import uses the project's UI options, which
 * are created from the same choices.
 */

const SERIES_PROFILES = new Set(["serialized_interleaved", "serialized_genz"]);
const PART_BY_SCRIPT = new Map([[1, 1], [3, 2], [4, 3]]);

function parseDurationWindow(...texts) {
  for (const text of texts) {
    const value = String(text || "");
    const match = value.match(/duration between (\d+(?:\.\d+)?)s and (\d+(?:\.\d+)?)s/i)
      || value.match(/duration for EACH Part:\s*(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*seconds/i)
      || value.match(/within (\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)s/i);
    if (match) return { minDuration: Number(match[1]), maxDuration: Number(match[2]) };
  }
  return { minDuration: 75, maxDuration: 110 };
}

function buildPromptOptions({ packageInfo = {}, partPromptText = "", mainPromptText = "" } = {}) {
  return {
    profile: String(packageInfo.sequentialSeriesProfile || ""),
    sharedHook: packageInfo.sequentialSeriesSharedHook === true,
    ...parseDurationWindow(partPromptText, mainPromptText)
  };
}

/** Returns { errors, warnings }; never throws (a thrown import error becomes an error line). */
function preflightSeriesScript({ script, manifest, promptOptions = {}, hookContract = null, transcriptSrt = "", sourceEvidence = null, jsonPath = "script.json" } = {}) {
  const Dub = require("./dubbingService");
  const { compileStorySpineScript, isStorySpineScript } = require("./storySpineCompilerService");
  const { validateManualGeminiEditorialContract } = require("./manualGeminiEditorialGateService");
  const videoDuration = Number(manifest?.videoDurationSec) || 0;
  try {
    let scriptInput = isStorySpineScript(script)
      ? compileStorySpineScript(script, { manifest, videoDuration, maxDurationSec: 0 })
      : script;
    scriptInput = Dub.validateManualGeminiScript(scriptInput, manifest, jsonPath, null, {
      preserveSourceNarrator: false,
      forceSourceAudioOnly: false,
      independentNarratorPolicy: false,
      deriveOutputTimeline: true
    });
    if (SERIES_PROFILES.has(promptOptions.profile)) {
      const scriptId = Number(scriptInput.scriptId ?? scriptInput.script_id);
      const partNumber = PART_BY_SCRIPT.get(scriptId) || 0;
      scriptInput = {
        ...scriptInput,
        prompt_profile: promptOptions.profile,
        series_mode: "interleaved_multipart",
        part_number: Number(scriptInput.part_number ?? scriptInput.partNumber) || partNumber,
        part_badge: String(scriptInput.part_badge || scriptInput.partBadge || `PART ${partNumber}`),
        target_duration_min_sec: Number(scriptInput.target_duration_min_sec ?? scriptInput.targetDurationMinSec) || promptOptions.minDuration || 75,
        target_duration_max_sec: Number(scriptInput.target_duration_max_sec ?? scriptInput.targetDurationMaxSec) || promptOptions.maxDuration || 110,
        shared_hook_enabled: scriptInput.shared_hook_enabled ?? promptOptions.sharedHook === true
      };
    }
    const normalized = Dub.normalizeHighlightCutScript(scriptInput, videoDuration);
    const editorial = validateManualGeminiEditorialContract({
      script: scriptInput, normalizedScript: normalized, promptOptions, hookContract, transcriptSrt, sourceEvidence
    });
    return { errors: editorial.errors, warnings: [...(normalized.warnings || []), ...editorial.warnings] };
  } catch (error) {
    return { errors: [String(error?.message || error)], warnings: [] };
  }
}

module.exports = { preflightSeriesScript, buildPromptOptions, parseDurationWindow };
