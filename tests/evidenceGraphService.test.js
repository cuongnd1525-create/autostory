const assert = require("assert");

const { EvidenceGraphService } = require("../electron/services/evidenceGraphService");

function makeEvidenceStore() {
  return {
    schemaVersion: "evidence-store.v1",
    scenes: [
      {
        sceneId: "scene_0001",
        timestamp: "0.000 -> 5.000",
        confidence: 0.82,
        transcript: { text: "Run, it is coming through the trees." },
        objects: [
          { label: "forest", confidence: 0.71 },
          { label: "running person", confidence: 0.69 }
        ],
        actions: [
          {
            actionId: "act_scene_0001_run",
            description: "A person runs through the forest.",
            evidenceId: "ev_scene_0001_visual_01",
            confidence: 0.66
          }
        ],
        characterCandidates: [
          {
            candidateId: "char_candidate_scene_0001_person",
            label: "unknown_person",
            confidence: 0.58,
            evidenceIds: ["ev_scene_0001_visual_01"]
          }
        ],
        evidence: [
          {
            evidenceId: "ev_scene_0001_visual_01",
            type: "visual",
            text: "Visible evidence suggests: forest, running person.",
            facts: [],
            hypotheses: ["Visible evidence suggests: forest, running person."],
            confidence: 0.66,
            evidenceLevel: "medium"
          },
          {
            evidenceId: "ev_scene_0001_dialogue_02",
            type: "dialogue",
            text: "Run, it is coming through the trees.",
            facts: ["Run, it is coming through the trees."],
            hypotheses: [],
            confidence: 0.83,
            evidenceLevel: "strong"
          }
        ]
      }
    ]
  };
}

function testGraphBuildsEvidenceNodesAndEdges() {
  const graph = new EvidenceGraphService().build({
    evidenceStore: makeEvidenceStore(),
    filmUnderstanding: {
      plotTimeline: {
        events: [
          {
            eventId: "event_001",
            sceneIds: ["scene_0001"],
            summary: "A person runs because something is coming through the trees.",
            confidence: 0.74
          }
        ]
      }
    }
  });
  assert.strictEqual(graph.schemaVersion, "evidence-graph.v1");
  assert(graph.nodes.some((node) => node.type === "scene" && node.label === "scene_0001"));
  assert(graph.nodes.some((node) => node.type === "plot_event" && node.id === "plot_event:event_001"));
  assert(graph.edges.some((edge) => edge.type === "supported_by" && edge.from === "plot_event:event_001"));
  assert(graph.facts.some((fact) => fact.text === "Run, it is coming through the trees."));
}

function testUnsupportedPlotEventsStayHypotheses() {
  const graph = new EvidenceGraphService().build({
    evidenceStore: makeEvidenceStore(),
    filmUnderstanding: {
      plotTimeline: {
        events: [
          {
            eventId: "event_unsupported",
            sceneIds: ["scene_9999"],
            summary: "A secret betrayal is revealed.",
            confidence: 0.9
          }
        ]
      }
    }
  });
  const eventNode = graph.nodes.find((node) => node.id === "plot_event:event_unsupported");
  assert(eventNode);
  assert.strictEqual(eventNode.data.evidenceIds.length, 0);
  assert(eventNode.confidence <= 0.42);
  assert.strictEqual(graph.report.unsupportedPlotEventCount, 1);
  assert(graph.hypotheses.some((entry) => entry.eventId === "event_unsupported"));
}

testGraphBuildsEvidenceNodesAndEdges();
testUnsupportedPlotEventsStayHypotheses();

console.log("evidenceGraphService tests passed");
