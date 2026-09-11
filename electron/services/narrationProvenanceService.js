const fs = require("fs/promises");
const path = require("path");

function safeText(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function unique(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((value) => safeText(value)).filter(Boolean)));
}

function normalizeNodeId(value) {
  return safeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function collectEvidenceMap(evidenceStore = {}, evidenceGraph = {}) {
  const evidence = new Map();
  for (const entry of Array.isArray(evidenceStore.evidence) ? evidenceStore.evidence : []) {
    const evidenceId = safeText(entry.evidenceId);
    if (!evidenceId) continue;
    evidence.set(evidenceId, {
      evidenceId,
      sceneId: safeText(entry.sceneId),
      type: safeText(entry.type, "evidence"),
      text: safeText(entry.text),
      confidence: clamp(entry.confidence),
      evidenceLevel: safeText(entry.evidenceLevel),
      source: safeText(entry.source)
    });
  }
  for (const scene of Array.isArray(evidenceStore.scenes) ? evidenceStore.scenes : []) {
    for (const entry of Array.isArray(scene.evidence) ? scene.evidence : []) {
      const evidenceId = safeText(entry.evidenceId);
      if (!evidenceId || evidence.has(evidenceId)) continue;
      evidence.set(evidenceId, {
        evidenceId,
        sceneId: safeText(entry.sceneId || scene.sceneId),
        type: safeText(entry.type, "evidence"),
        text: safeText(entry.text),
        confidence: clamp(entry.confidence),
        evidenceLevel: safeText(entry.evidenceLevel),
        source: safeText(entry.source)
      });
    }
  }
  for (const node of Array.isArray(evidenceGraph.nodes) ? evidenceGraph.nodes : []) {
    if (node.type === "scene") continue;
    const evidenceId = node.id?.startsWith("evidence:") ? node.id.replace(/^evidence:/, "") : safeText(node.data?.evidenceId);
    if (!evidenceId || evidence.has(evidenceId)) continue;
    evidence.set(evidenceId, {
      evidenceId,
      sceneId: safeText(node.sceneId || node.data?.sceneId),
      type: safeText(node.type, "evidence"),
      text: safeText(node.label || node.data?.text),
      confidence: clamp(node.confidence || node.data?.confidence),
      evidenceLevel: safeText(node.evidenceLevel || node.data?.evidenceLevel),
      source: safeText(node.data?.source, "evidence_graph")
    });
  }
  return evidence;
}

function collectSceneEvidenceIds(evidenceStore = {}) {
  const sceneEvidence = new Map();
  for (const scene of Array.isArray(evidenceStore.scenes) ? evidenceStore.scenes : []) {
    const sceneId = safeText(scene.sceneId || scene.scene_id);
    if (!sceneId) continue;
    const ids = unique([
      ...(Array.isArray(scene.evidence) ? scene.evidence.map((entry) => entry.evidenceId) : []),
      ...(Array.isArray(scene.visualCaptions) ? scene.visualCaptions.map((entry) => entry.evidenceId) : []),
      ...(Array.isArray(scene.characterCandidates) ? scene.characterCandidates.flatMap((entry) => entry.evidenceIds || []) : [])
    ]);
    sceneEvidence.set(sceneId, ids);
  }
  return sceneEvidence;
}

function collectPlotEvents(evidenceGraph = {}) {
  const events = new Map();
  for (const node of Array.isArray(evidenceGraph.nodes) ? evidenceGraph.nodes : []) {
    if (node.type !== "plot_event") continue;
    const eventId = safeText(node.data?.eventId || node.data?.event_id || node.data?.id || node.id.replace(/^plot_event:/, ""));
    const normalizedId = normalizeNodeId(node.id || `plot_event:${eventId}`);
    const evidenceIds = unique(node.data?.evidenceIds || []);
    const entry = {
      plotEventId: eventId || normalizedId.replace(/^plot_event:/, ""),
      nodeId: normalizedId,
      summary: safeText(node.label || node.data?.summary || node.data?.event),
      sceneIds: unique(node.data?.sceneIds || node.data?.scene_ids || []),
      evidenceIds,
      supportLevel: evidenceIds.length ? safeText(node.data?.evidenceLevel, "supported") : "unsupported",
      confidence: clamp(node.confidence || node.data?.confidence)
    };
    events.set(entry.plotEventId, entry);
    events.set(entry.nodeId, entry);
    events.set(entry.nodeId.replace(/^plot_event:/, ""), entry);
  }
  for (const edge of Array.isArray(evidenceGraph.edges) ? evidenceGraph.edges : []) {
    if (edge.type !== "supported_by" || !safeText(edge.from).startsWith("plot_event:")) continue;
    const event = events.get(edge.from) || events.get(edge.from.replace(/^plot_event:/, ""));
    if (!event || !safeText(edge.to).startsWith("evidence:")) continue;
    event.evidenceIds = unique([...event.evidenceIds, edge.to.replace(/^evidence:/, "")]);
    event.supportLevel = "supported";
  }
  return events;
}

function collectCharacterMap(characterTracker = {}) {
  return new Map((Array.isArray(characterTracker.characters) ? characterTracker.characters : [])
    .map((character) => [safeText(character.characterId), character])
    .filter(([id]) => Boolean(id)));
}

function collectGroundingMap(narrationGroundingReport = {}) {
  const bySegment = new Map();
  for (const segment of Array.isArray(narrationGroundingReport.segments) ? narrationGroundingReport.segments : []) {
    const index = Number(segment.segmentIndex ?? segment.index);
    if (Number.isFinite(index)) bySegment.set(index, { ...segment, issues: [] });
  }
  for (const issue of Array.isArray(narrationGroundingReport.issues) ? narrationGroundingReport.issues : []) {
    const index = Number(issue.segmentIndex);
    if (!Number.isFinite(index)) continue;
    const current = bySegment.get(index) || { segmentIndex: index, issues: [] };
    current.issues = [...(current.issues || []), issue];
    bySegment.set(index, current);
  }
  return bySegment;
}

function collectViralIssues(viralFactGuard = {}) {
  const byScene = new Map();
  for (const issue of Array.isArray(viralFactGuard.issues) ? viralFactGuard.issues : []) {
    const sceneId = safeText(issue.sceneId);
    if (!sceneId) continue;
    byScene.set(sceneId, [...(byScene.get(sceneId) || []), issue]);
  }
  return byScene;
}

function chooseEvidenceIds(segment, sceneEvidenceMap, plotEvent) {
  return unique([
    ...(Array.isArray(segment.evidenceIds) ? segment.evidenceIds : []),
    ...(Array.isArray(plotEvent?.evidenceIds) ? plotEvent.evidenceIds : []),
    ...((sceneEvidenceMap.get(safeText(segment.sceneId)) || []).slice(0, 4))
  ]);
}

function summarizeEvidence(entries) {
  return entries.map((entry) => ({
    evidenceId: entry.evidenceId,
    sceneId: entry.sceneId,
    type: entry.type,
    text: entry.text,
    confidence: entry.confidence,
    evidenceLevel: entry.evidenceLevel,
    source: entry.source
  }));
}

function average(values, fallback = 0) {
  const list = values.map(Number).filter((value) => Number.isFinite(value));
  if (!list.length) return fallback;
  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

class NarrationProvenanceService {
  inspect({
    stage = "preview",
    segments = [],
    evidenceStore = {},
    evidenceGraph = {},
    characterTracker = {},
    narrationGroundingReport = {},
    viralFactGuard = null
  } = {}) {
    const segmentList = Array.isArray(segments) ? segments : [];
    const evidenceMap = collectEvidenceMap(evidenceStore, evidenceGraph);
    const sceneEvidenceMap = collectSceneEvidenceIds(evidenceStore);
    const plotEvents = collectPlotEvents(evidenceGraph);
    const characters = collectCharacterMap(characterTracker);
    const groundingBySegment = collectGroundingMap(narrationGroundingReport);
    const viralIssuesByScene = collectViralIssues(viralFactGuard || {});

    const records = segmentList.map((segment, index) => {
      const sceneId = safeText(segment.sceneId || segment.scene_id);
      const plotEventId = safeText(segment.plotEventId || segment.plot_event_id || segment.eventId);
      const plotEvent = plotEventId ? plotEvents.get(plotEventId) || plotEvents.get(normalizeNodeId(`plot_event:${plotEventId}`)) : null;
      const evidenceIds = chooseEvidenceIds(segment, sceneEvidenceMap, plotEvent);
      const supportedEvidence = summarizeEvidence(evidenceIds.map((id) => evidenceMap.get(id)).filter(Boolean));
      const missingEvidenceIds = evidenceIds.filter((id) => evidenceMap.size && !evidenceMap.has(id));
      const characterRefs = unique(Array.isArray(segment.characterIds) ? segment.characterIds : []);
      const characterRecords = characterRefs.map((characterId) => {
        const character = characters.get(characterId);
        return {
          characterId,
          found: Boolean(character),
          stableLabel: safeText(character?.stableLabel || character?.label || characterId),
          role: safeText(character?.role),
          status: safeText(character?.status, character ? "tracked" : "missing"),
          confidence: clamp(character?.confidence)
        };
      });
      const missingCharacterIds = characterRecords.filter((entry) => !entry.found).map((entry) => entry.characterId);
      const weakCharacterIds = characterRecords.filter((entry) => entry.found && entry.confidence < 0.45).map((entry) => entry.characterId);
      const grounding = groundingBySegment.get(index) || {};
      const groundingIssues = Array.isArray(grounding.issues) ? grounding.issues : [];
      const viralIssues = viralIssuesByScene.get(sceneId) || [];
      const hardViralIssueCount = viralIssues.filter((issue) =>
        issue.severity === "high" && ["relationship", "relationship_twist", "identity"].includes(issue.category)
      ).length;
      const warnings = [
        !supportedEvidence.length ? "missing_supported_evidence" : "",
        missingEvidenceIds.length ? "unknown_evidence_id" : "",
        plotEventId && !plotEvent ? "unknown_plot_event" : "",
        plotEvent && !plotEvent.evidenceIds.length ? "unsupported_plot_event" : "",
        missingCharacterIds.length ? "unknown_character" : "",
        weakCharacterIds.length ? "weak_character_identity" : "",
        ...groundingIssues.map((issue) => issue.code || "grounding_issue"),
        ...viralIssues.filter((issue) => issue.severity === "high").map(() => "viral_fact_without_evidence")
      ].filter(Boolean);
      const hasBlockingWarning = warnings.some((warning) => [
        "missing_supported_evidence",
        "unknown_evidence_id",
        "unknown_plot_event",
        "unsupported_plot_event",
        "unknown_character"
      ].includes(warning)) || hardViralIssueCount > 0;
      const confidence = clamp(average([
        average(supportedEvidence.map((entry) => entry.confidence), supportedEvidence.length ? 0.5 : 0.1),
        average(characterRecords.filter((entry) => entry.found).map((entry) => entry.confidence), characterRecords.length ? 0.45 : 0.65),
        Number(grounding.evidenceMatchScore ?? grounding.averageEvidenceScore ?? grounding.visualMatchScore ?? 0.6)
      ], 0.35) - (warnings.length * 0.035));

      return {
        segmentIndex: index,
        stage,
        sceneId,
        startSec: Number(segment.startSec ?? segment.start ?? 0),
        endSec: Number(segment.endSec ?? segment.end ?? 0),
        role: safeText(segment.role),
        narrationLine: safeText(segment.narrationLine || segment.text),
        subtitleText: safeText(segment.subtitleText || segment.narrationLine || segment.text),
        evidenceIds,
        supportedEvidence,
        missingEvidenceIds,
        plotEvent: plotEventId ? {
          plotEventId,
          found: Boolean(plotEvent),
          summary: safeText(plotEvent?.summary),
          evidenceIds: unique(plotEvent?.evidenceIds || []),
          supportLevel: safeText(plotEvent?.supportLevel, plotEvent ? "unknown" : "missing"),
          confidence: clamp(plotEvent?.confidence)
        } : null,
        characters: characterRecords,
        grounding: {
          visualMatchScore: Number(grounding.visualMatchScore ?? 0),
          evidenceMatchScore: Number(grounding.evidenceMatchScore ?? grounding.averageEvidenceScore ?? 0),
          plotMatchScore: Number(grounding.plotMatchScore ?? 0),
          issues: groundingIssues
        },
        viralGuardIssues: viralIssues,
        warnings,
        confidence: Number(confidence.toFixed(3)),
        status: hasBlockingWarning ? "blocked" : warnings.length ? "review" : "grounded"
      };
    });

    const blockedCount = records.filter((record) => record.status === "blocked").length;
    const reviewCount = records.filter((record) => record.status === "review").length;
    const groundedCount = records.filter((record) => record.status === "grounded").length;
    const missingEvidenceCount = records.filter((record) => record.warnings.includes("missing_supported_evidence")).length;
    const warningCount = records.reduce((sum, record) => sum + record.warnings.length, 0);

    return {
      schemaVersion: "narration-provenance.v1",
      generatedAt: new Date().toISOString(),
      stage,
      policy: {
        priority: ["Accuracy", "Grounding", "Story Coherence", "Retention", "Virality"],
        rule: "Every narration line should trace to evidence, plot support, and stable character references before render."
      },
      records,
      report: {
        segmentCount: records.length,
        groundedCount,
        reviewCount,
        blockedCount,
        missingEvidenceCount,
        warningCount,
        averageConfidence: Number(average(records.map((record) => record.confidence), 0).toFixed(3))
      }
    };
  }

  async inspectAndWrite({ outputPath, ...input }) {
    const result = this.inspect(input);
    if (outputPath) {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
    }
    return result;
  }
}

module.exports = NarrationProvenanceService;
