const assert = require("assert");

const EvidenceQaService = require("../electron/services/evidenceQaService");

function makeGraph() {
  return {
    schemaVersion: "evidence-graph.v1",
    nodes: [
      {
        id: "evidence:ev_scene_001_visual_01",
        type: "visual",
        label: "monster in forest",
        data: { text: "monster in forest" }
      }
    ],
    facts: [
      {
        evidenceId: "ev_scene_001_visual_01",
        sceneId: "scene_001",
        text: "monster in forest"
      }
    ],
    edges: []
  };
}

function testCriticalViralFactBlocksRender() {
  const report = new EvidenceQaService().inspect({
    stage: "pre_render",
    segments: [{ sceneId: "scene_001", evidenceIds: ["ev_scene_001_visual_01"] }],
    evidenceStore: { schemaVersion: "evidence-store.v1" },
    evidenceGraph: makeGraph(),
    viralFactGuard: {
      issues: [
        {
          severity: "high",
          entryId: "hook_01",
          sceneId: "scene_001",
          category: "relationship",
          term: "father",
          message: "Viral layer introduced father without evidence."
        }
      ]
    }
  });
  assert.strictEqual(report.canRender, false);
  assert(report.issues.some((issue) => issue.severity === "critical" && issue.code === "viral_fact_without_evidence"));
}

function testLowEvidenceGroundingWarnsOnly() {
  const report = new EvidenceQaService().inspect({
    stage: "pre_render",
    segments: [{ sceneId: "scene_001", evidenceIds: ["ev_scene_001_visual_01"] }],
    evidenceStore: { schemaVersion: "evidence-store.v1" },
    evidenceGraph: makeGraph(),
    narrationGroundingReport: {
      issues: [
        {
          code: "low_evidence_grounding",
          message: "Line does not map to evidence.",
          segmentIndex: 0,
          sceneId: "scene_001"
        }
      ]
    }
  });
  assert.strictEqual(report.canRender, true);
  assert(report.issues.some((issue) => issue.code === "low_evidence_grounding" && issue.severity === "warning"));
}

function testUnknownEvidenceIdBlocksRender() {
  const report = new EvidenceQaService().inspect({
    stage: "pre_render",
    segments: [{ sceneId: "scene_001", evidenceIds: ["ev_missing"] }],
    evidenceStore: { schemaVersion: "evidence-store.v1" },
    evidenceGraph: makeGraph()
  });
  assert.strictEqual(report.canRender, false);
  assert(report.issues.some((issue) => issue.code === "unknown_segment_evidence_id"));
}

function testUnknownCharacterIdBlocksRender() {
  const report = new EvidenceQaService().inspect({
    stage: "pre_render",
    segments: [{ sceneId: "scene_001", characterIds: ["char_missing"] }],
    evidenceStore: { schemaVersion: "evidence-store.v1" },
    evidenceGraph: makeGraph(),
    characterTracker: {
      schemaVersion: "character-tracker.v1",
      characters: [{ characterId: "char_hero", confidence: 0.8 }]
    }
  });
  assert.strictEqual(report.canRender, false);
  assert(report.issues.some((issue) => issue.code === "unknown_segment_character_id"));
}

function testWeakCharacterIdentityWarnsOnly() {
  const report = new EvidenceQaService().inspect({
    stage: "pre_render",
    segments: [{ sceneId: "scene_001", characterIds: ["char_weak"] }],
    evidenceStore: { schemaVersion: "evidence-store.v1" },
    evidenceGraph: makeGraph(),
    characterTracker: {
      schemaVersion: "character-tracker.v1",
      characters: [{ characterId: "char_weak", confidence: 0.3 }]
    }
  });
  assert.strictEqual(report.canRender, true);
  assert(report.issues.some((issue) => issue.code === "weak_character_identity"));
}

function testMissingGraphIsWarningOnlyForFallbackCompatibility() {
  const report = new EvidenceQaService().inspect({
    stage: "pre_render",
    segments: [{ sceneId: "scene_001" }],
    evidenceStore: null,
    evidenceGraph: null
  });
  assert.strictEqual(report.canRender, true);
  assert(report.issues.some((issue) => issue.code === "missing_evidence_store"));
  assert(report.issues.some((issue) => issue.code === "missing_evidence_graph"));
}

testCriticalViralFactBlocksRender();
testLowEvidenceGroundingWarnsOnly();
testUnknownEvidenceIdBlocksRender();
testUnknownCharacterIdBlocksRender();
testWeakCharacterIdentityWarnsOnly();
testMissingGraphIsWarningOnlyForFallbackCompatibility();

console.log("evidenceQaService tests passed");
