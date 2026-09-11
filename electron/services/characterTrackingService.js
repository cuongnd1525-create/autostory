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

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function unique(values) {
  return Array.from(new Set((values || []).map((value) => safeText(value)).filter(Boolean)));
}

function collectEvidenceCandidates(evidenceStore) {
  return (Array.isArray(evidenceStore?.scenes) ? evidenceStore.scenes : []).flatMap((scene) =>
    (Array.isArray(scene.characterCandidates) ? scene.characterCandidates : []).map((candidate) => ({
      ...candidate,
      sceneId: scene.sceneId,
      timestamp: scene.timestamp,
      startSec: scene.startSec,
      endSec: scene.endSec,
      sceneConfidence: scene.confidence
    }))
  );
}

function candidateKey(candidate) {
  const profile = Array.isArray(candidate.visualProfile) ? candidate.visualProfile.join(" ") : "";
  const label = safeText(candidate.label, "unknown_person");
  if (label && label !== "unknown_person") return normalizeId(label);
  const profileKey = normalizeId(profile).slice(0, 32);
  return profileKey || normalizeId(label || candidate.candidateId || "unknown_person");
}

function makeTrackerCharacter(base, appearances, index) {
  const appearanceEvidenceIds = unique(appearances.flatMap((entry) => entry.evidenceIds || []));
  const visualProfile = unique([
    ...(Array.isArray(base.visualCues) ? base.visualCues : []),
    ...(Array.isArray(base.visualProfile) ? base.visualProfile : []),
    ...appearances.flatMap((entry) => Array.isArray(entry.visualProfile) ? entry.visualProfile : [])
  ]).slice(0, 16);
  const confidenceValues = [
    Number(base.confidence || base.confidenceScore || 0),
    ...appearances.map((entry) => Number(entry.confidence || 0))
  ].filter((value) => Number.isFinite(value) && value > 0);
  const confidence = confidenceValues.length
    ? clamp(confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length, 0, 1)
    : 0.25;
  const firstAppearance = appearances[0] || {};
  const characterId = safeText(base.characterId || base.character_id, `char_tracked_${String(index + 1).padStart(2, "0")}`);
  return {
    characterId,
    stableLabel: safeText(base.stableLabel || base.stable_label || base.label || firstAppearance.label, index === 0 ? "the protagonist" : `character ${index + 1}`),
    role: safeText(base.role || base.roleInStory || base.role_in_story, index === 0 ? "unknown" : "supporting"),
    visualProfile,
    firstAppearanceSceneId: safeText(base.firstSeenSceneId || base.firstAppearanceSceneId || firstAppearance.sceneId, ""),
    appearanceHistory: appearances.map((entry) => ({
      sceneId: safeText(entry.sceneId),
      timestamp: safeText(entry.timestamp),
      confidence: clamp(Number(entry.confidence || entry.sceneConfidence || 0), 0, 1),
      evidenceIds: unique(entry.evidenceIds || [])
    })),
    relationship: safeText(base.relationship, ""),
    goal: safeText(base.goal, ""),
    motivation: safeText(base.motivation, ""),
    knowledgeState: [],
    emotionState: [],
    confidence: Number(confidence.toFixed(3)),
    evidenceIds: appearanceEvidenceIds,
    status: confidence >= 0.72 ? "stable" : confidence >= 0.45 ? "candidate" : "weak_candidate"
  };
}

class CharacterTrackingService {
  build({ evidenceStore = {}, filmUnderstanding = {}, narrativeIntelligence = null } = {}) {
    const evidenceCandidates = collectEvidenceCandidates(evidenceStore);
    const groupedCandidates = new Map();
    for (const candidate of evidenceCandidates) {
      const key = candidateKey(candidate);
      if (!groupedCandidates.has(key)) groupedCandidates.set(key, []);
      groupedCandidates.get(key).push(candidate);
    }

    const bibleCharacters = Array.isArray(filmUnderstanding?.characterBible?.characters)
      ? filmUnderstanding.characterBible.characters
      : [];
    const mentalCharacters = Array.isArray(narrativeIntelligence?.characterMentalModel?.characters)
      ? narrativeIntelligence.characterMentalModel.characters
      : [];
    const mentalById = new Map(mentalCharacters.map((character) => [safeText(character.characterId || character.character_id), character]));
    const usedGroups = new Set();

    const characters = bibleCharacters.map((character, index) => {
      const labelKey = normalizeId(character.stableLabel || character.stable_label || character.label || character.characterId);
      const availableKeys = Array.from(groupedCandidates.keys()).filter((key) => !usedGroups.has(key));
      const isGenericPerson = /unknown|person|protagonist|hero/.test(labelKey);
      const matchingKey = availableKeys.find((key) => key && (key === labelKey || labelKey.includes(key) || key.includes(labelKey)))
        || (isGenericPerson ? availableKeys[0] : "");
      const appearances = isGenericPerson
        ? availableKeys.flatMap((key) => groupedCandidates.get(key) || [])
        : matchingKey ? groupedCandidates.get(matchingKey) : [];
      if (isGenericPerson) {
        availableKeys.forEach((key) => usedGroups.add(key));
      } else if (matchingKey) {
        usedGroups.add(matchingKey);
      }
      const mental = mentalById.get(safeText(character.characterId || character.character_id)) || {};
      return makeTrackerCharacter({
        ...character,
        ...mental,
        role: character.role || mental.roleInStory,
        visualCues: character.visualCues || character.visual_cues || [],
        confidence: Math.max(Number(character.confidence || 0), Number(mental.confidenceScore || mental.confidence_score || 0))
      }, appearances, index);
    });

    for (const [key, appearances] of groupedCandidates.entries()) {
      if (usedGroups.has(key)) continue;
      characters.push(makeTrackerCharacter({
        characterId: `char_candidate_${String(characters.length + 1).padStart(2, "0")}`,
        stableLabel: safeText(appearances[0]?.label, key || `character ${characters.length + 1}`),
        visualProfile: appearances[0]?.visualProfile || [],
        confidence: Math.max(...appearances.map((entry) => Number(entry.confidence || 0)), 0.25)
      }, appearances, characters.length));
    }

    const relationshipGraph = narrativeIntelligence?.relationshipGraph || { relationships: [] };
    const knownIds = new Set(characters.map((character) => character.characterId));
    const unsupportedRelationships = (Array.isArray(relationshipGraph.relationships) ? relationshipGraph.relationships : []).filter((relationship) =>
      !knownIds.has(safeText(relationship.sourceCharacterId || relationship.source_character_id))
      || !knownIds.has(safeText(relationship.targetCharacterId || relationship.target_character_id))
    );
    const weakCharacters = characters.filter((character) => character.confidence < 0.45);
    const unsupportedBibleCharacters = characters.filter((character) => !character.appearanceHistory.length && character.confidence < 0.65);

    return {
      schemaVersion: "character-tracker.v1",
      generatedAt: new Date().toISOString(),
      policy: {
        factRule: "A character is stable only when it has appearance evidence or high-confidence supported model evidence.",
        weakCharacterRule: "Weak candidates must not be narrated as confirmed identities or relationships."
      },
      characters,
      relationships: relationshipGraph.relationships || [],
      report: {
        characterCount: characters.length,
        stableCharacterCount: characters.filter((character) => character.status === "stable").length,
        weakCharacterCount: weakCharacters.length,
        unsupportedRelationshipCount: unsupportedRelationships.length,
        unsupportedBibleCharacterCount: unsupportedBibleCharacters.length,
        warnings: [
          weakCharacters.length ? `${weakCharacters.length} weak character candidate(s) should not be narrated as confirmed identity.` : "",
          unsupportedRelationships.length ? `${unsupportedRelationships.length} relationship(s) reference unknown tracked characters.` : "",
          unsupportedBibleCharacters.length ? `${unsupportedBibleCharacters.length} character bible entry/entries lack appearance evidence.` : ""
        ].filter(Boolean)
      }
    };
  }

  async buildAndWrite({ evidenceStore, filmUnderstanding, narrativeIntelligence, outputPath }) {
    const tracker = this.build({ evidenceStore, filmUnderstanding, narrativeIntelligence });
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(tracker, null, 2), "utf8");
    return {
      characterTrackerPath: outputPath,
      characterTracker: tracker
    };
  }
}

module.exports = {
  CharacterTrackingService
};
