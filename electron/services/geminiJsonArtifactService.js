const fs = require("fs/promises");
const path = require("path");

function parseGeminiJsonObject(raw, sourceName = "JSON") {
  const source = String(raw ?? "").replace(/^\uFEFF/, "").trim();
  if (!source) {
    throw new Error(`${sourceName} trống.`);
  }

  const candidates = [source];
  const fenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const firstBrace = source.indexOf("{");
  const lastBrace = source.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(source.slice(firstBrace, lastBrace + 1));
  }

  let lastError = null;
  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.length === 1 && parsed[0] && typeof parsed[0] === "object") {
        return parsed[0];
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${sourceName} không chứa một JSON object hợp lệ${lastError ? `: ${lastError.message}` : "."}`);
}

function unwrapStoryScript(payload) {
  if (Array.isArray(payload?.segments) || Array.isArray(payload?.narrativeBeats) || Array.isArray(payload?.narrative_beats)) return payload;
  for (const key of ["revisedScript", "revised_script", "story_recut", "storyRecut", "script", "data", "result", "output"]) {
    const nested = payload?.[key];
    if (nested && typeof nested === "object" && (
      Array.isArray(nested.segments)
      || Array.isArray(nested.narrativeBeats)
      || Array.isArray(nested.narrative_beats)
    )) {
      return nested;
    }
  }
  return payload;
}

function detectGeminiArtifact(payload) {
  if (String(payload?.artifactType || "") === "gemini_input_access_failure") {
    return {
      type: "gemini_input_access_failure",
      importRoute: "access_failure",
      artifactType: "gemini_input_access_failure",
      scriptId: 0,
      segmentCount: 0,
      evidenceCount: 0,
      accessGranted: false,
      stage: String(payload.stage || ""),
      missingInputs: Array.isArray(payload.missingInputs) ? payload.missingInputs : [],
      unreadableInputs: Array.isArray(payload.unreadableInputs) ? payload.unreadableInputs : [],
      coverageGaps: Array.isArray(payload.coverageGaps) ? payload.coverageGaps : [],
      mismatchDetails: String(payload.mismatchDetails || ""),
      recommendedAction: String(payload.recommendedAction || ""),
      topLevelKeys: Object.keys(payload)
    };
  }
  if (String(payload?.artifactType || "") === "podcast_candidate_map" && Array.isArray(payload?.candidates)) {
    return {
      type: "podcast_candidate_map",
      importRoute: "podcast_candidates",
      artifactType: "podcast_candidate_map",
      workflow: String(payload.workflow || "podcast_viral_cut"),
      scriptId: 0,
      segmentCount: payload.candidates.length,
      evidenceCount: 0,
      accessGranted: payload.accessAudit?.accessGranted === true,
      outputCount: Number(payload.requestedOutputCount || payload.outputCount || 0),
      sourceMatchId: String(payload.sourceMatchId || ""),
      topLevelKeys: Object.keys(payload)
    };
  }
  if (String(payload?.artifactType || "") === "podcast_input_access_failure") {
    return {
      type: "podcast_input_access_failure",
      importRoute: "unsupported",
      artifactType: "podcast_input_access_failure",
      scriptId: 0,
      segmentCount: 0,
      evidenceCount: 0,
      topLevelKeys: Object.keys(payload)
    };
  }
  if (String(payload?.artifactType || "") === "podcast_edit_decision_list" && Array.isArray(payload?.selections)) {
    return {
      type: "podcast_edit_decision_list",
      importRoute: "initial_variant",
      artifactType: "podcast_edit_decision_list",
      workflow: String(payload.workflow || "podcast_viral_cut"),
      scriptId: Number(payload.outputIndex || 0),
      segmentCount: payload.selections.length,
      evidenceCount: 0,
      accessGranted: payload.accessAudit?.accessGranted === true,
      outputCount: Number(payload.outputCount || 0),
      sourceMatchId: String(payload.sourceMatchId || ""),
      topLevelKeys: Object.keys(payload)
    };
  }
  if (
    String(payload?.artifactType || "") === "gemini_draft_review"
    && (
      Array.isArray((payload?.revisedScript || payload?.revised_script)?.segments)
      || Array.isArray((payload?.revisedScript || payload?.revised_script)?.narrativeBeats)
      || Array.isArray((payload?.revisedScript || payload?.revised_script)?.narrative_beats)
    )
  ) {
    const revisedScript = payload.revisedScript || payload.revised_script;
    const reviewItems = revisedScript.segments || revisedScript.narrativeBeats || revisedScript.narrative_beats || [];
    return {
      type: "gemini_draft_review",
      importRoute: "review_revision",
      artifactType: "gemini_draft_review",
      scriptId: Number(revisedScript.scriptId || revisedScript.script_id || 0),
      segmentCount: reviewItems.length,
      evidenceCount: 0,
      topLevelKeys: Object.keys(payload)
    };
  }
  const script = unwrapStoryScript(payload);
  if (Array.isArray(script?.segments) && script.segments.length > 0) {
    return {
      type: "story_recut_script",
      importRoute: "initial_variant",
      artifactType: String(script.artifactType || "highlight_cut_script"),
      workflow: String(script.workflow || ""),
      scriptId: Number(script.scriptId || script.script_id || 0),
      segmentCount: script.segments.length,
      evidenceCount: 0,
      suggestedTitle: script.suggestedTitle || script.title || script.shared_top_banner_text || "",
      partBadge: script.partBadge || script.part_badge || "",
      cameraLabel: script.cameraLabel || script.camera_label || "",
      titleStyle: script.titleStyle || script.title_style || "",
      subtitleStyle: script.subtitleStyle || script.subtitle_style || "",
      topLevelKeys: Object.keys(script)
    };
  }
  const narrativeBeats = script?.narrativeBeats || script?.narrative_beats;
  if (Array.isArray(narrativeBeats)) {
    return {
      type: "story_spine_edit_script",
      importRoute: "initial_variant",
      artifactType: String(script.artifactType || "story_spine_edit_script"),
      workflow: String(script.workflow || ""),
      scriptId: Number(script.scriptId || script.script_id || 0),
      segmentCount: narrativeBeats.length,
      evidenceCount: 0,
      suggestedTitle: script.suggestedTitle || script.title || script.shared_top_banner_text || "",
      partBadge: script.partBadge || script.part_badge || "",
      cameraLabel: script.cameraLabel || script.camera_label || "",
      titleStyle: script.titleStyle || script.title_style || "",
      subtitleStyle: script.subtitleStyle || script.subtitle_style || "",
      topLevelKeys: Object.keys(script)
    };
  }
  const blueprint = payload?.story_blueprint || payload?.storyBlueprint || payload;
  if (String(payload?.artifactType || "") === "diy_story_blueprint" && Array.isArray(payload?.blocks)) {
    return {
      type: "diy_story_blueprint",
      importRoute: "manual_blueprint",
      artifactType: "diy_story_blueprint",
      scriptId: 0,
      segmentCount: 0,
      evidenceCount: 0,
      macroBlockCount: payload.blocks.length,
      topLevelKeys: Object.keys(payload)
    };
  }
  if (String(payload?.artifactType || "") === "story_blueprint" || Array.isArray(blueprint?.macroBlocks)) {
    return {
      type: "story_blueprint",
      importRoute: "manual_blueprint",
      artifactType: String(payload?.artifactType || "story_blueprint"),
      scriptId: 0,
      segmentCount: 0,
      evidenceCount: 0,
      macroBlockCount: Array.isArray(blueprint?.macroBlocks) ? blueprint.macroBlocks.length : 0,
      topLevelKeys: Object.keys(payload)
    };
  }
  const evidence = payload?.evidence || payload?.sceneEvidence;
  if (Array.isArray(evidence)) {
    return {
      type: "scene_evidence",
      importRoute: "manual_evidence",
      artifactType: String(payload.artifactType || ""),
      segmentCount: 0,
      evidenceCount: evidence.length,
      topLevelKeys: Object.keys(payload)
    };
  }
  if (String(payload?.artifactType || "") === "diy_visual_process_map" && Array.isArray(payload?.visualBeats)) {
    return {
      type: "diy_visual_process_map",
      importRoute: "manual_evidence",
      artifactType: "diy_visual_process_map",
      segmentCount: 0,
      evidenceCount: payload.visualBeats.length,
      topLevelKeys: Object.keys(payload)
    };
  }
  return {
    type: "unknown",
    importRoute: "unsupported",
    artifactType: String(payload?.artifactType || ""),
    scriptId: 0,
    segmentCount: 0,
    evidenceCount: 0,
    topLevelKeys: payload && typeof payload === "object" ? Object.keys(payload) : []
  };
}

async function inspectGeminiJsonFiles(filePaths = []) {
  const results = [];
  for (const filePath of filePaths) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const payload = parseGeminiJsonObject(raw, path.basename(filePath));
      results.push({ filePath, validJson: true, ...detectGeminiArtifact(payload) });
    } catch (error) {
      results.push({
        filePath,
        validJson: false,
        type: "invalid",
        error: error.message,
        segmentCount: 0,
        evidenceCount: 0,
        topLevelKeys: []
      });
    }
  }
  return results;
}

module.exports = {
  parseGeminiJsonObject,
  unwrapStoryScript,
  detectGeminiArtifact,
  inspectGeminiJsonFiles
};
