const fs = require("fs/promises");
const path = require("path");

function safeText(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function collectEvidenceIdsFromSegments(segments = []) {
  return new Set((Array.isArray(segments) ? segments : [])
    .flatMap((segment) => Array.isArray(segment.evidenceIds) ? segment.evidenceIds : [])
    .map((id) => safeText(id))
    .filter(Boolean));
}

function collectEvidenceIdsFromGraph(evidenceGraph = {}) {
  const fromNodes = Array.isArray(evidenceGraph.nodes)
    ? evidenceGraph.nodes.flatMap((node) => [
        node.id?.startsWith("evidence:") ? node.id.replace(/^evidence:/, "") : "",
        ...(Array.isArray(node.data?.evidenceIds) ? node.data.evidenceIds : [])
      ])
    : [];
  const fromFacts = Array.isArray(evidenceGraph.facts) ? evidenceGraph.facts.map((fact) => fact.evidenceId) : [];
  return new Set([...fromNodes, ...fromFacts].map((id) => safeText(id)).filter(Boolean));
}

function collectCharacterMap(characterTracker = {}) {
  return new Map((Array.isArray(characterTracker.characters) ? characterTracker.characters : [])
    .map((character) => [safeText(character.characterId), character])
    .filter(([id]) => Boolean(id)));
}

function issue(severity, code, message, extra = {}) {
  return {
    severity,
    code,
    message,
    ...extra
  };
}

class EvidenceQaService {
  inspect({
    stage = "pre_render",
    segments = [],
    evidenceStore = null,
    evidenceGraph = null,
    characterTracker = null,
    narrationGroundingReport = null,
    narrationProvenance = null,
    viralFactGuard = null,
    attentionQa = null,
    voiceVisualReport = null,
    syncReport = null,
    renderQa = null
  } = {}) {
    const issues = [];
    const segmentList = Array.isArray(segments) ? segments : [];

    if (!evidenceStore?.schemaVersion) {
      issues.push(issue("warning", "missing_evidence_store", "Evidence Store is unavailable; QA cannot fully verify factual grounding."));
    }
    if (!evidenceGraph?.schemaVersion) {
      issues.push(issue("warning", "missing_evidence_graph", "Evidence Graph is unavailable; QA cannot verify graph support for plot events."));
    }
    if (!characterTracker?.schemaVersion) {
      issues.push(issue("warning", "missing_character_tracker", "Character Tracker is unavailable; QA cannot fully verify identity stability."));
    }

    const graphEvidenceIds = collectEvidenceIdsFromGraph(evidenceGraph || {});
    const characterMap = collectCharacterMap(characterTracker || {});
    const segmentEvidenceIds = collectEvidenceIdsFromSegments(segmentList);
    const unknownEvidenceIds = [...segmentEvidenceIds].filter((id) => graphEvidenceIds.size && !graphEvidenceIds.has(id));
    if (unknownEvidenceIds.length) {
      issues.push(issue(
        "critical",
        "unknown_segment_evidence_id",
        `Narration references ${unknownEvidenceIds.length} evidenceId(s) that are not present in the Evidence Graph.`,
        { evidenceIds: unknownEvidenceIds.slice(0, 20) }
      ));
    }

    const referencedCharacterIds = new Set(segmentList.flatMap((segment) => Array.isArray(segment.characterIds) ? segment.characterIds : []).map((id) => safeText(id)).filter(Boolean));
    const unknownCharacterIds = [...referencedCharacterIds].filter((id) => characterMap.size && !characterMap.has(id));
    if (unknownCharacterIds.length) {
      issues.push(issue(
        "error",
        "unknown_segment_character_id",
        `Narration references ${unknownCharacterIds.length} characterId(s) that are not present in Character Tracker.`,
        { characterIds: unknownCharacterIds.slice(0, 20) }
      ));
    }
    const weakReferencedCharacters = [...referencedCharacterIds]
      .map((id) => characterMap.get(id))
      .filter((character) => character && Number(character.confidence || 0) < 0.45);
    if (weakReferencedCharacters.length) {
      issues.push(issue(
        "warning",
        "weak_character_identity",
        `Narration references ${weakReferencedCharacters.length} weak character candidate(s); avoid certain identity/relationship claims.`,
        { characterIds: weakReferencedCharacters.map((character) => character.characterId).slice(0, 20) }
      ));
    }

    const groundingIssues = Array.isArray(narrationGroundingReport?.issues) ? narrationGroundingReport.issues : [];
    const criticalGroundingCodes = new Set([
      "narration_grounding_failed"
    ]);
    const warningGroundingCodes = new Set([
      "low_evidence_grounding",
      "weak_evidence_overstated",
      "low_event_grounding",
      "missing_plot_event",
      "character_identity_mismatch",
      "relationship_mismatch",
      "event_order_violation",
      "reveal_before_setup"
    ]);
    for (const groundingIssue of groundingIssues) {
      if (criticalGroundingCodes.has(groundingIssue.code)) {
        issues.push(issue(
          "critical",
          groundingIssue.code,
          groundingIssue.message || "Narration cannot be mapped to supported evidence.",
          {
            segmentIndex: groundingIssue.segmentIndex,
            sceneId: groundingIssue.sceneId,
            plotEventId: groundingIssue.plotEventId
          }
        ));
      } else if (warningGroundingCodes.has(groundingIssue.code)) {
        issues.push(issue(
          "warning",
          groundingIssue.code,
          groundingIssue.message || "Narration has weak story/character grounding.",
          {
            segmentIndex: groundingIssue.segmentIndex,
            sceneId: groundingIssue.sceneId,
            plotEventId: groundingIssue.plotEventId
          }
        ));
      }
    }

    const provenanceRecords = Array.isArray(narrationProvenance?.records) ? narrationProvenance.records : [];
    for (const record of provenanceRecords.filter((entry) => entry.status === "blocked")) {
      issues.push(issue(
        "critical",
        "narration_provenance_blocked",
        "Narration line cannot be safely traced to supporting evidence, plot event, or character identity.",
        {
          segmentIndex: record.segmentIndex,
          sceneId: record.sceneId,
          warnings: record.warnings,
          evidenceIds: record.evidenceIds,
          narrationLine: record.narrationLine
        }
      ));
    }
    const reviewRecords = provenanceRecords.filter((entry) => entry.status === "review");
    if (reviewRecords.length) {
      issues.push(issue(
        "warning",
        "narration_provenance_review",
        `${reviewRecords.length} narration line(s) need human review even though they are not hard-blocked.`,
        {
          segmentIndexes: reviewRecords.map((entry) => entry.segmentIndex).slice(0, 20)
        }
      ));
    }

    const viralIssues = Array.isArray(viralFactGuard?.issues) ? viralFactGuard.issues : [];
    for (const viralIssue of viralIssues.filter((entry) => entry.severity === "high")) {
      const hardFactCategories = new Set(["relationship", "relationship_twist", "identity"]);
      issues.push(issue(
        hardFactCategories.has(viralIssue.category) ? "critical" : "warning",
        "viral_fact_without_evidence",
        viralIssue.message || "Viral layer introduced a factual claim without evidence.",
        {
          entryId: viralIssue.entryId,
          sceneId: viralIssue.sceneId,
          term: viralIssue.term,
          text: viralIssue.text
        }
      ));
    }

    const attentionIssues = Array.isArray(attentionQa?.issues) ? attentionQa.issues : [];
    for (const attentionIssue of attentionIssues.filter((entry) => entry.severity === "high")) {
      const severity = "warning";
      issues.push(issue(
        severity,
        attentionIssue.issue,
        attentionIssue.reason || "Attention QA found a high-risk issue.",
        {
          segmentId: attentionIssue.segmentId,
          suggestedRewrite: attentionIssue.suggestedRewrite
        }
      ));
    }

    const voiceVisualIssues = Array.isArray(voiceVisualReport?.issues) ? voiceVisualReport.issues : [];
    for (const voiceIssue of voiceVisualIssues.filter((entry) => entry.severity === "error")) {
      issues.push(issue(
        "error",
        voiceIssue.code || "voice_visual_alignment_failed",
        voiceIssue.message || "Voice/visual timing or semantic alignment failed.",
        { segmentIndex: voiceIssue.segmentIndex }
      ));
    }

    if (syncReport && syncReport.passed === false) {
      issues.push(issue("error", "strict_sync_failed", "Strict sync report failed."));
    }

    if (renderQa) {
      const renderIssues = Array.isArray(renderQa.issues) ? renderQa.issues : [];
      for (const renderIssue of renderIssues.filter((entry) => entry.severity === "error")) {
        issues.push(issue("error", renderIssue.code || "render_qa_error", renderIssue.message || "Render QA failed."));
      }
    }

    const criticalCount = issues.filter((entry) => entry.severity === "critical").length;
    const errorCount = issues.filter((entry) => entry.severity === "error").length;
    const warningCount = issues.filter((entry) => entry.severity === "warning").length;

    return {
      schemaVersion: "evidence-qa.v1",
      inspectedAt: new Date().toISOString(),
      stage,
      passed: criticalCount === 0 && errorCount === 0,
      canRender: criticalCount === 0 && errorCount === 0,
      summary: {
        criticalCount,
        errorCount,
        warningCount,
        issueCount: issues.length,
        segmentCount: segmentList.length,
        referencedEvidenceCount: segmentEvidenceIds.size,
        graphEvidenceCount: graphEvidenceIds.size,
        trackedCharacterCount: characterMap.size,
        provenanceBlockedCount: provenanceRecords.filter((entry) => entry.status === "blocked").length,
        provenanceReviewCount: reviewRecords.length
      },
      policy: {
        hardGate: ["critical", "error"],
        priority: ["Accuracy", "Grounding", "Story Coherence", "Retention", "Virality"],
        rule: "No render when narration or viral layer introduces facts that cannot trace to Evidence Graph."
      },
      issues
    };
  }

  async inspectAndWrite({ outputPath, ...input }) {
    const report = this.inspect(input);
    if (outputPath) {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
    }
    return report;
  }
}

module.exports = EvidenceQaService;
