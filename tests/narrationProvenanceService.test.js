const assert = require("assert");

const NarrationProvenanceService = require("../electron/services/narrationProvenanceService");
const EvidenceQaService = require("../electron/services/evidenceQaService");

function makeEvidenceStore() {
  return {
    schemaVersion: "evidence-store.v1",
    scenes: [
      {
        sceneId: "scene_001",
        evidence: [
          {
            evidenceId: "ev_scene_001_visual_01",
            sceneId: "scene_001",
            type: "visual",
            text: "A masked creature watches the man in the forest.",
            confidence: 0.78,
            evidenceLevel: "strong",
            source: "local_visual_tags"
          }
        ]
      }
    ],
    evidence: [
      {
        evidenceId: "ev_scene_001_visual_01",
        sceneId: "scene_001",
        type: "visual",
        text: "A masked creature watches the man in the forest.",
        confidence: 0.78,
        evidenceLevel: "strong",
        source: "local_visual_tags"
      }
    ]
  };
}

function makeEvidenceGraph() {
  return {
    schemaVersion: "evidence-graph.v1",
    nodes: [
      {
        id: "plot_event:event_001",
        type: "plot_event",
        label: "The creature stalks the man.",
        confidence: 0.74,
        data: {
          eventId: "event_001",
          sceneIds: ["scene_001"],
          evidenceIds: ["ev_scene_001_visual_01"],
          evidenceLevel: "strong"
        }
      },
      {
        id: "evidence:ev_scene_001_visual_01",
        type: "visual",
        label: "A masked creature watches the man in the forest.",
        confidence: 0.78,
        data: {
          evidenceId: "ev_scene_001_visual_01",
          sceneId: "scene_001"
        }
      }
    ],
    edges: [
      {
        from: "plot_event:event_001",
        to: "evidence:ev_scene_001_visual_01",
        type: "supported_by",
        confidence: 0.74
      }
    ]
  };
}

function makeCharacterTracker() {
  return {
    schemaVersion: "character-tracker.v1",
    characters: [
      {
        characterId: "char_creature",
        stableLabel: "masked creature",
        role: "threat",
        status: "stable",
        confidence: 0.82
      }
    ]
  };
}

function testGroundedNarrationHasEvidenceAndCharacter() {
  const provenance = new NarrationProvenanceService().inspect({
    stage: "render",
    segments: [
      {
        sceneId: "scene_001",
        plotEventId: "event_001",
        characterIds: ["char_creature"],
        narrationLine: "The creature quietly stalks him from the trees."
      }
    ],
    evidenceStore: makeEvidenceStore(),
    evidenceGraph: makeEvidenceGraph(),
    characterTracker: makeCharacterTracker(),
    narrationGroundingReport: {
      segments: [{ segmentIndex: 0, evidenceMatchScore: 0.8, visualMatchScore: 0.75, plotMatchScore: 0.8 }]
    }
  });
  assert.strictEqual(provenance.report.groundedCount, 1);
  assert.strictEqual(provenance.records[0].status, "grounded");
  assert.deepStrictEqual(provenance.records[0].evidenceIds, ["ev_scene_001_visual_01"]);
  assert.strictEqual(provenance.records[0].characters[0].stableLabel, "masked creature");
}

function testMissingEvidenceBlocksNarration() {
  const provenance = new NarrationProvenanceService().inspect({
    segments: [
      {
        sceneId: "scene_404",
        narrationLine: "A secret father arrives with a revenge plan."
      }
    ],
    evidenceStore: makeEvidenceStore(),
    evidenceGraph: makeEvidenceGraph()
  });
  assert.strictEqual(provenance.report.blockedCount, 1);
  assert(provenance.records[0].warnings.includes("missing_supported_evidence"));
}

function testEvidenceQaBlocksOnProvenanceBlocked() {
  const provenance = new NarrationProvenanceService().inspect({
    segments: [{ sceneId: "scene_404", narrationLine: "Unsupported claim." }],
    evidenceStore: makeEvidenceStore(),
    evidenceGraph: makeEvidenceGraph()
  });
  const qa = new EvidenceQaService().inspect({
    segments: [{ sceneId: "scene_404" }],
    evidenceStore: makeEvidenceStore(),
    evidenceGraph: makeEvidenceGraph(),
    narrationProvenance: provenance
  });
  assert.strictEqual(qa.canRender, false);
  assert(qa.issues.some((issue) => issue.code === "narration_provenance_blocked"));
}

testGroundedNarrationHasEvidenceAndCharacter();
testMissingEvidenceBlocksNarration();
testEvidenceQaBlocksOnProvenanceBlocked();

console.log("narrationProvenanceService tests passed");
