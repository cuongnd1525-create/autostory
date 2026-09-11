const assert = require("assert");

const NarrationGroundingService = require("../electron/services/narrationGroundingService");

function makeEvidenceStore() {
  return {
    schemaVersion: "evidence-store.v1",
    scenes: [
      {
        sceneId: "scene_0001",
        confidence: 0.81,
        transcript: { text: "Run, it is coming through the trees." },
        visualCaptions: [
          {
            evidenceId: "ev_scene_0001_visual_01",
            text: "Visible evidence suggests: forest, running person, predator creature.",
            confidence: 0.62,
            evidenceLevel: "medium"
          }
        ],
        objects: [
          { label: "forest", confidence: 0.7 },
          { label: "running person", confidence: 0.7 },
          { label: "predator creature", confidence: 0.7 }
        ],
        evidence: [
          {
            evidenceId: "ev_scene_0001_dialogue_02",
            text: "Run, it is coming through the trees.",
            facts: ["Run, it is coming through the trees."],
            hypotheses: []
          }
        ]
      },
      {
        sceneId: "scene_0002",
        confidence: 0.22,
        transcript: { text: "" },
        visualCaptions: [
          {
            evidenceId: "ev_scene_0002_visual_01",
            text: "No reliable visual action caption is available for this scene.",
            confidence: 0.18,
            evidenceLevel: "weak"
          }
        ],
        objects: [],
        evidence: []
      }
    ]
  };
}

function makeSceneMetadata() {
  return {
    scenes: [
      {
        sceneId: "scene_0001",
        audioTranscript: "Run, it is coming through the trees.",
        localVisualTags: ["forest", "running person", "predator creature"],
        motionIntensity: "HIGH"
      },
      {
        sceneId: "scene_0002"
      }
    ]
  };
}

function testEvidenceMatchedLinePasses() {
  const report = new NarrationGroundingService().inspect({
    segments: [
      {
        sceneId: "scene_0001",
        role: "hook",
        narrationLine: "A running person escapes through the forest as something comes through the trees.",
        evidenceIds: ["ev_scene_0001_visual_01"]
      }
    ],
    sceneMetadata: makeSceneMetadata(),
    evidenceStore: makeEvidenceStore()
  });
  assert.strictEqual(report.weakSegmentCount, 0);
  assert(report.segments[0].averageEvidenceScore > 0);
  assert(report.segments[0].evidenceIds.includes("ev_scene_0001_visual_01"));
}

function testUnrelatedLineIsFlaggedAgainstEvidence() {
  const report = new NarrationGroundingService().inspect({
    segments: [
      {
        sceneId: "scene_0001",
        role: "hook",
        narrationLine: "The android reveals a damaged mechanical face in a laboratory."
      }
    ],
    sceneMetadata: makeSceneMetadata(),
    evidenceStore: makeEvidenceStore()
  });
  assert(report.issues.some((issue) => issue.code === "low_evidence_grounding"));
  assert(report.weakSegmentCount >= 1);
}

function testWeakEvidenceRequiresSoftLanguage() {
  const report = new NarrationGroundingService().inspect({
    segments: [
      {
        sceneId: "scene_0002",
        role: "setup",
        narrationLine: "The killer definitely betrays the team here."
      }
    ],
    sceneMetadata: makeSceneMetadata(),
    evidenceStore: makeEvidenceStore()
  });
  assert(report.issues.some((issue) => issue.code === "weak_evidence_overstated"));
  assert(report.evidenceWeakSegmentCount >= 1);
}

testEvidenceMatchedLinePasses();
testUnrelatedLineIsFlaggedAgainstEvidence();
testWeakEvidenceRequiresSoftLanguage();

console.log("narrationGroundingService tests passed");
