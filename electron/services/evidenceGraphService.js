const fs = require("fs/promises");
const path = require("path");

function safeText(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function normalizeId(value) {
  return safeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function unique(values) {
  return Array.from(new Set((values || []).map((value) => safeText(value)).filter(Boolean)));
}

function makeNode(id, type, label, data = {}) {
  return {
    id: normalizeId(id),
    type,
    label: safeText(label, id),
    confidence: Number.isFinite(Number(data.confidence)) ? Number(data.confidence) : 0,
    evidenceLevel: safeText(data.evidenceLevel, ""),
    sceneId: safeText(data.sceneId, ""),
    data
  };
}

function makeEdge(from, to, type, data = {}) {
  return {
    from: normalizeId(from),
    to: normalizeId(to),
    type,
    confidence: Number.isFinite(Number(data.confidence)) ? Number(data.confidence) : 0,
    data
  };
}

function addNode(nodes, node) {
  if (!node.id) return;
  const existing = nodes.get(node.id);
  if (!existing || Number(node.confidence || 0) > Number(existing.confidence || 0)) {
    nodes.set(node.id, node);
  }
}

function addEdge(edges, edge) {
  if (!edge.from || !edge.to) return;
  const key = `${edge.from}->${edge.type}->${edge.to}`;
  if (!edges.has(key)) edges.set(key, edge);
}

function sceneNodeId(sceneId) {
  return `scene:${sceneId}`;
}

function evidenceNodeId(evidenceId) {
  return `evidence:${evidenceId}`;
}

function objectNodeId(sceneId, label) {
  return `object:${sceneId}:${label}`;
}

function actionNodeId(sceneId, actionId, fallback) {
  return `action:${sceneId}:${actionId || fallback}`;
}

function characterCandidateNodeId(candidateId) {
  return `character_candidate:${candidateId}`;
}

function plotEventNodeId(eventId) {
  return `plot_event:${eventId}`;
}

function collectEvidenceIdsForScene(scene) {
  return unique([
    ...(Array.isArray(scene.evidence) ? scene.evidence.map((entry) => entry.evidenceId) : []),
    ...(Array.isArray(scene.visualCaptions) ? scene.visualCaptions.map((entry) => entry.evidenceId) : []),
    ...(Array.isArray(scene.characterCandidates) ? scene.characterCandidates.flatMap((entry) => entry.evidenceIds || []) : [])
  ]);
}

class EvidenceGraphService {
  build({ evidenceStore = {}, filmUnderstanding = {}, narrativeIntelligence = null } = {}) {
    const nodes = new Map();
    const edges = new Map();
    const facts = [];
    const hypotheses = [];
    const scenes = Array.isArray(evidenceStore.scenes) ? evidenceStore.scenes : [];

    for (const scene of scenes) {
      const sceneId = safeText(scene.sceneId || scene.scene_id);
      if (!sceneId) continue;
      addNode(nodes, makeNode(sceneNodeId(sceneId), "scene", sceneId, {
        sceneId,
        timestamp: scene.timestamp,
        startSec: scene.startSec,
        endSec: scene.endSec,
        confidence: scene.confidence,
        evidenceLevel: Number(scene.confidence || 0) >= 0.72 ? "strong" : Number(scene.confidence || 0) >= 0.45 ? "medium" : "weak"
      }));

      for (const evidence of Array.isArray(scene.evidence) ? scene.evidence : []) {
        const evidenceId = safeText(evidence.evidenceId);
        if (!evidenceId) continue;
        addNode(nodes, makeNode(evidenceNodeId(evidenceId), evidence.type || "evidence", evidence.text || evidenceId, {
          ...evidence,
          sceneId,
          confidence: evidence.confidence,
          evidenceLevel: evidence.evidenceLevel
        }));
        addEdge(edges, makeEdge(evidenceNodeId(evidenceId), sceneNodeId(sceneId), "appears_in", {
          sceneId,
          confidence: evidence.confidence
        }));
        for (const fact of Array.isArray(evidence.facts) ? evidence.facts : []) {
          facts.push({
            factId: `fact_${normalizeId(evidenceId)}_${normalizeId(fact).slice(0, 24)}`,
            sceneId,
            evidenceId,
            text: fact,
            confidence: evidence.confidence
          });
        }
        for (const hypothesis of Array.isArray(evidence.hypotheses) ? evidence.hypotheses : []) {
          hypotheses.push({
            hypothesisId: `hyp_${normalizeId(evidenceId)}_${normalizeId(hypothesis).slice(0, 24)}`,
            sceneId,
            evidenceId,
            text: hypothesis,
            confidence: Math.min(Number(evidence.confidence || 0), 0.62)
          });
        }
      }

      for (const object of Array.isArray(scene.objects) ? scene.objects : []) {
        const objectId = objectNodeId(sceneId, object.label);
        addNode(nodes, makeNode(objectId, "object", object.label, {
          ...object,
          sceneId,
          confidence: object.confidence,
          evidenceLevel: Number(object.confidence || 0) >= 0.72 ? "strong" : Number(object.confidence || 0) >= 0.45 ? "medium" : "weak"
        }));
        addEdge(edges, makeEdge(objectId, sceneNodeId(sceneId), "appears_in", {
          sceneId,
          confidence: object.confidence
        }));
      }

      for (const action of Array.isArray(scene.actions) ? scene.actions : []) {
        const actionId = actionNodeId(sceneId, action.actionId, action.description);
        addNode(nodes, makeNode(actionId, "action", action.description, {
          ...action,
          sceneId,
          confidence: action.confidence,
          evidenceLevel: Number(action.confidence || 0) >= 0.72 ? "strong" : Number(action.confidence || 0) >= 0.45 ? "medium" : "weak"
        }));
        addEdge(edges, makeEdge(actionId, sceneNodeId(sceneId), "appears_in", {
          sceneId,
          confidence: action.confidence
        }));
        if (action.evidenceId) {
          addEdge(edges, makeEdge(actionId, evidenceNodeId(action.evidenceId), "supported_by", {
            sceneId,
            confidence: action.confidence
          }));
        }
      }

      for (const candidate of Array.isArray(scene.characterCandidates) ? scene.characterCandidates : []) {
        const candidateId = safeText(candidate.candidateId);
        if (!candidateId) continue;
        addNode(nodes, makeNode(characterCandidateNodeId(candidateId), "character_candidate", candidate.label, {
          ...candidate,
          sceneId,
          confidence: candidate.confidence,
          evidenceLevel: Number(candidate.confidence || 0) >= 0.72 ? "strong" : Number(candidate.confidence || 0) >= 0.45 ? "medium" : "weak"
        }));
        addEdge(edges, makeEdge(characterCandidateNodeId(candidateId), sceneNodeId(sceneId), "appears_in", {
          sceneId,
          confidence: candidate.confidence
        }));
        for (const evidenceId of candidate.evidenceIds || []) {
          addEdge(edges, makeEdge(characterCandidateNodeId(candidateId), evidenceNodeId(evidenceId), "supported_by", {
            sceneId,
            confidence: candidate.confidence
          }));
        }
      }
    }

    const events = Array.isArray(filmUnderstanding?.plotTimeline?.events) ? filmUnderstanding.plotTimeline.events : [];
    const sceneMap = new Map(scenes.map((scene) => [safeText(scene.sceneId || scene.scene_id), scene]));
    for (const event of events) {
      const eventId = safeText(event.eventId || event.event_id || event.id);
      if (!eventId) continue;
      const sceneIds = Array.isArray(event.sceneIds || event.scene_ids) ? (event.sceneIds || event.scene_ids).map((sceneId) => safeText(sceneId)).filter(Boolean) : [];
      const eventEvidenceIds = unique(sceneIds.flatMap((sceneId) => collectEvidenceIdsForScene(sceneMap.get(sceneId) || {})));
      const confidence = Math.min(Number(event.confidence || 0.5), eventEvidenceIds.length ? 0.82 : 0.42);
      addNode(nodes, makeNode(plotEventNodeId(eventId), "plot_event", event.summary || event.event || eventId, {
        ...event,
        sceneIds,
        evidenceIds: eventEvidenceIds,
        confidence,
        evidenceLevel: confidence >= 0.72 ? "strong" : confidence >= 0.45 ? "medium" : "weak",
        hypothesis: true
      }));
      for (const sceneId of sceneIds) {
        addEdge(edges, makeEdge(plotEventNodeId(eventId), sceneNodeId(sceneId), "appears_in", {
          sceneId,
          confidence
        }));
      }
      for (const evidenceId of eventEvidenceIds) {
        addEdge(edges, makeEdge(plotEventNodeId(eventId), evidenceNodeId(evidenceId), "supported_by", {
          sceneIds,
          confidence
        }));
      }
      hypotheses.push({
        hypothesisId: `hyp_${normalizeId(eventId)}`,
        eventId,
        sceneIds,
        evidenceIds: eventEvidenceIds,
        text: event.summary || event.event || eventId,
        confidence
      });
    }

    const graph = {
      schemaVersion: "evidence-graph.v1",
      generatedAt: new Date().toISOString(),
      policy: {
        priority: ["Accuracy", "Grounding", "Story Coherence", "Retention", "Virality"],
        factRule: "Facts must trace to evidence nodes. Plot events and narrative intelligence remain hypotheses unless directly supported_by evidence."
      },
      nodes: Array.from(nodes.values()),
      edges: Array.from(edges.values()),
      facts,
      hypotheses,
      narrativeIntelligenceRefs: narrativeIntelligence ? {
        hasCharacterMentalModel: Boolean(narrativeIntelligence.characterMentalModel),
        hasStoryBeatGraph: Boolean(narrativeIntelligence.storyBeatGraph)
      } : null
    };

    graph.report = {
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      factCount: facts.length,
      hypothesisCount: hypotheses.length,
      weakNodeCount: graph.nodes.filter((node) => node.evidenceLevel === "weak").length,
      unsupportedPlotEventCount: graph.nodes.filter((node) => node.type === "plot_event" && !(node.data.evidenceIds || []).length).length,
      warnings: [
        graph.nodes.length ? "" : "Evidence Graph has no nodes.",
        graph.nodes.filter((node) => node.type === "plot_event" && !(node.data.evidenceIds || []).length).length
          ? "Some plot events have no direct evidenceIds and must stay hypothetical."
          : ""
      ].filter(Boolean)
    };
    return graph;
  }

  async buildAndWrite({ evidenceStore, filmUnderstanding, narrativeIntelligence, outputPath }) {
    const graph = this.build({ evidenceStore, filmUnderstanding, narrativeIntelligence });
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(graph, null, 2), "utf8");
    return {
      evidenceGraphPath: outputPath,
      evidenceGraph: graph
    };
  }
}

module.exports = {
  EvidenceGraphService
};
