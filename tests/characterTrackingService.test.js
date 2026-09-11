const assert = require("assert");

const { CharacterTrackingService } = require("../electron/services/characterTrackingService");

function makeEvidenceStore() {
  return {
    schemaVersion: "evidence-store.v1",
    scenes: [
      {
        sceneId: "scene_0001",
        timestamp: "0.000 -> 5.000",
        confidence: 0.72,
        characterCandidates: [
          {
            candidateId: "char_candidate_scene_0001_person",
            label: "unknown_person",
            visualProfile: ["person", "face", "jacket"],
            confidence: 0.62,
            evidenceIds: ["ev_scene_0001_visual_01"]
          }
        ]
      },
      {
        sceneId: "scene_0002",
        timestamp: "5.000 -> 9.000",
        confidence: 0.70,
        characterCandidates: [
          {
            candidateId: "char_candidate_scene_0002_person",
            label: "unknown_person",
            visualProfile: ["person", "jacket"],
            confidence: 0.58,
            evidenceIds: ["ev_scene_0002_visual_01"]
          }
        ]
      }
    ]
  };
}

function testBuildsAppearanceHistory() {
  const tracker = new CharacterTrackingService().build({
    evidenceStore: makeEvidenceStore(),
    filmUnderstanding: {
      characterBible: {
        characters: [
          {
            characterId: "char_hero",
            stableLabel: "unknown_person",
            role: "protagonist",
            confidence: 0.65
          }
        ]
      }
    }
  });
  const hero = tracker.characters.find((character) => character.characterId === "char_hero");
  assert(hero);
  assert(hero.appearanceHistory.length >= 2);
  assert(hero.evidenceIds.includes("ev_scene_0001_visual_01"));
  assert.strictEqual(tracker.report.characterCount, tracker.characters.length);
}

function testUnsupportedRelationshipIsReported() {
  const tracker = new CharacterTrackingService().build({
    evidenceStore: makeEvidenceStore(),
    filmUnderstanding: {
      characterBible: {
        characters: [{ characterId: "char_hero", stableLabel: "unknown_person", confidence: 0.6 }]
      }
    },
    narrativeIntelligence: {
      relationshipGraph: {
        relationships: [
          {
            sourceCharacterId: "char_hero",
            targetCharacterId: "char_missing",
            relationshipType: "family"
          }
        ]
      }
    }
  });
  assert.strictEqual(tracker.report.unsupportedRelationshipCount, 1);
  assert(tracker.report.warnings.some((warning) => warning.includes("relationship")));
}

testBuildsAppearanceHistory();
testUnsupportedRelationshipIsReported();

console.log("characterTrackingService tests passed");
