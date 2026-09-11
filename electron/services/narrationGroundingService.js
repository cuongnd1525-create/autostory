const fs = require("fs/promises");

function safeText(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function normalizeId(value) {
  return safeText(value).toLowerCase();
}

function tokenize(text) {
  const stopwords = new Set([
    "the", "and", "that", "this", "with", "from", "into", "then", "when", "while", "but", "because",
    "mot", "cua", "va", "la", "khi", "nhung", "roi", "nay", "do", "cho", "voi", "trong", "dang",
    "anh", "co", "nguoi", "nay", "kia", "nen", "sau", "truoc"
  ]);
  return safeText(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !stopwords.has(word));
}

function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  return intersection / Math.max(1, a.size + b.size - intersection);
}

function splitNarrationEvents(text) {
  return safeText(text)
    .split(/(?<=[.!?])\s+|[;]\s+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getSceneText(segment, sceneMetadata) {
  const metadata = segment.metadataSummary || {};
  const sceneId = normalizeId(segment.sceneId || metadata.sceneId || metadata.scene_id);
  const sourceScenes = Array.isArray(sceneMetadata?.scenes) ? sceneMetadata.scenes : [];
  const scene = sourceScenes.find((entry) => normalizeId(entry.sceneId || entry.scene_id) === sceneId) || {};
  return [
    segment.description,
    segment.reason,
    segment.screenText,
    segment.beatPurpose,
    segment.continuityNote,
    metadata.audioTranscript,
    metadata.motionIntensity,
    metadata.audioEnergy,
    metadata.lightChange,
    ...(Array.isArray(metadata.localVisualTags) ? metadata.localVisualTags : []),
    scene.audio_transcript,
    scene.audioTranscript,
    scene.motion_intensity,
    scene.motionIntensity,
    scene.audio_energy,
    scene.audioEnergy,
    scene.light_change,
    scene.lightChange,
    ...(Array.isArray(scene.local_visual_tags) ? scene.local_visual_tags : []),
    ...(Array.isArray(scene.localVisualTags) ? scene.localVisualTags : []),
    ...(Array.isArray(segment.keywords) ? segment.keywords : [])
  ].filter(Boolean).join(" ");
}

function getEvidenceScene(segment, evidenceStore) {
  const sceneId = normalizeId(segment.sceneId || segment.metadataSummary?.sceneId || segment.metadataSummary?.scene_id);
  const sourceScenes = Array.isArray(evidenceStore?.scenes) ? evidenceStore.scenes : [];
  return sourceScenes.find((entry) => normalizeId(entry.sceneId || entry.scene_id) === sceneId) || null;
}

function getEvidenceText(evidenceScene) {
  if (!evidenceScene) return "";
  return [
    evidenceScene.transcript?.text,
    ...(Array.isArray(evidenceScene.visualCaptions) ? evidenceScene.visualCaptions.map((entry) => entry.text) : []),
    ...(Array.isArray(evidenceScene.objects) ? evidenceScene.objects.map((entry) => entry.label) : []),
    ...(Array.isArray(evidenceScene.actions) ? evidenceScene.actions.map((entry) => entry.description) : []),
    ...(Array.isArray(evidenceScene.characterCandidates) ? evidenceScene.characterCandidates.map((entry) => entry.label) : []),
    ...(Array.isArray(evidenceScene.evidence) ? evidenceScene.evidence.map((entry) => [
      entry.text,
      ...(Array.isArray(entry.facts) ? entry.facts : []),
      ...(Array.isArray(entry.hypotheses) ? entry.hypotheses : [])
    ].filter(Boolean).join(" ")) : [])
  ].filter(Boolean).join(" ");
}

function getEvidenceIds(evidenceScene) {
  if (!evidenceScene) return [];
  return Array.from(new Set([
    ...(Array.isArray(evidenceScene.evidence) ? evidenceScene.evidence.map((entry) => entry.evidenceId) : []),
    ...(Array.isArray(evidenceScene.visualCaptions) ? evidenceScene.visualCaptions.map((entry) => entry.evidenceId) : []),
    ...(Array.isArray(evidenceScene.characterCandidates) ? evidenceScene.characterCandidates.flatMap((entry) => entry.evidenceIds || []) : [])
  ].filter(Boolean)));
}

function getSceneEvidenceLevel(evidenceScene) {
  const confidence = Number(evidenceScene?.confidence || 0);
  if (confidence >= 0.72) return "strong";
  if (confidence >= 0.45) return "medium";
  return "weak";
}

function findRoleMap(segment, filmUnderstanding) {
  const sceneId = normalizeId(segment.sceneId || segment.metadataSummary?.sceneId || segment.metadataSummary?.scene_id);
  const roleMap = Array.isArray(filmUnderstanding?.sceneRoleMap) ? filmUnderstanding.sceneRoleMap : [];
  return roleMap.find((entry) => normalizeId(entry.sceneId || entry.scene_id) === sceneId) || null;
}

function findPlotEvent(segment, roleEntry, filmUnderstanding) {
  const directId = normalizeId(segment.plotEventId || roleEntry?.plotEventId || roleEntry?.plot_event_id);
  const events = Array.isArray(filmUnderstanding?.plotTimeline?.events) ? filmUnderstanding.plotTimeline.events : [];
  if (directId) {
    const found = events.find((entry) => normalizeId(entry.eventId || entry.event_id || entry.id) === directId);
    if (found) return found;
  }
  const eventIds = Array.isArray(roleEntry?.plotEventIds) ? roleEntry.plotEventIds : [];
  for (const eventId of eventIds) {
    const found = events.find((entry) => normalizeId(entry.eventId || entry.event_id || entry.id) === normalizeId(eventId));
    if (found) return found;
  }
  return null;
}

function getEventText(event, roleEntry) {
  return [
    event?.event,
    event?.summary,
    event?.cause,
    event?.effect,
    event?.stakes,
    event?.turningPoint,
    roleEntry?.role,
    roleEntry?.visualEvidence,
    roleEntry?.dialogueEvidence
  ].filter(Boolean).join(" ");
}

function getCharacters(narrativeIntelligence) {
  return Array.isArray(narrativeIntelligence?.characterMentalModel?.characters)
    ? narrativeIntelligence.characterMentalModel.characters
    : [];
}

function getRelationships(narrativeIntelligence) {
  return Array.isArray(narrativeIntelligence?.relationshipGraph?.relationships)
    ? narrativeIntelligence.relationshipGraph.relationships
    : [];
}

function getWorldState(plotEventId, narrativeIntelligence) {
  const timeline = Array.isArray(narrativeIntelligence?.worldStateTimeline) ? narrativeIntelligence.worldStateTimeline : [];
  return timeline.find((entry) => normalizeId(entry.plotEventId || entry.plot_event_id) === normalizeId(plotEventId)) || null;
}

function getEmotionalState(characterId, plotEventId, narrativeIntelligence) {
  const timeline = Array.isArray(narrativeIntelligence?.emotionalTimeline) ? narrativeIntelligence.emotionalTimeline : [];
  return timeline.find((entry) =>
    normalizeId(entry.characterId || entry.character_id) === normalizeId(characterId)
    && normalizeId(entry.plotEventId || entry.plot_event_id) === normalizeId(plotEventId)
  ) || null;
}

function getStoryBeat(segment, narrativeIntelligence) {
  const beats = Array.isArray(narrativeIntelligence?.storyBeatGraph?.beats) ? narrativeIntelligence.storyBeatGraph.beats : [];
  const beatId = normalizeId(segment.beatId || segment.beat_id);
  const sceneId = normalizeId(segment.sceneId || segment.metadataSummary?.sceneId || segment.metadataSummary?.scene_id);
  return beats.find((entry) => normalizeId(entry.beatId || entry.beat_id) === beatId)
    || beats.find((entry) => Array.isArray(entry.sceneIds || entry.scene_ids) && (entry.sceneIds || entry.scene_ids).some((id) => normalizeId(id) === sceneId))
    || null;
}

function eventOrderMap(filmUnderstanding) {
  const events = Array.isArray(filmUnderstanding?.plotTimeline?.events) ? filmUnderstanding.plotTimeline.events : [];
  return new Map(events.map((entry, index) => [normalizeId(entry.eventId || entry.event_id || entry.id), index]));
}

function hasSoftInferenceLanguage(text) {
  return /\b(seems|appears|might|may|looks like|starts to|begins to|dường như|co ve|có vẻ|hinh nhu|hình như|bat dau|bắt đầu)\b/i.test(safeText(text));
}

function hasRelationshipSupport(characterIds, narrativeIntelligence) {
  if (!Array.isArray(characterIds) || characterIds.length < 2) return true;
  const relationships = getRelationships(narrativeIntelligence);
  return relationships.some((entry) => {
    const source = normalizeId(entry.sourceCharacterId || entry.source_character_id);
    const target = normalizeId(entry.targetCharacterId || entry.target_character_id);
    return characterIds.some((left) => characterIds.some((right) =>
      normalizeId(left) !== normalizeId(right)
      && ((normalizeId(left) === source && normalizeId(right) === target) || (normalizeId(left) === target && normalizeId(right) === source))
    ));
  });
}

class NarrationGroundingService {
  inspect({ segments, sceneMetadata, evidenceStore, filmUnderstanding, narrativeIntelligence }) {
    const entries = [];
    const characterIds = new Set(getCharacters(narrativeIntelligence).map((character) => normalizeId(character.characterId || character.character_id)));
    const orderMap = eventOrderMap(filmUnderstanding);
    let lastEventOrder = -1;
    let setupSeen = false;
    let conflictSeen = false;
    for (const [index, segment] of (Array.isArray(segments) ? segments : []).entries()) {
      const narrationLine = safeText(segment.narrationLine || segment.subtitleText);
      const sceneText = getSceneText(segment, sceneMetadata);
      const evidenceScene = getEvidenceScene(segment, evidenceStore);
      const evidenceText = getEvidenceText(evidenceScene);
      const evidenceIds = getEvidenceIds(evidenceScene);
      const roleEntry = findRoleMap(segment, filmUnderstanding);
      const plotEvent = findPlotEvent(segment, roleEntry, filmUnderstanding);
      const storyBeat = getStoryBeat(segment, narrativeIntelligence);
      const eventText = getEventText(plotEvent, roleEntry);
      const sceneTokens = tokenize(sceneText);
      const evidenceTokens = tokenize(evidenceText);
      const eventTokens = tokenize(eventText);
      const sentenceEvents = splitNarrationEvents(narrationLine);
      const inspectedEvents = sentenceEvents.length ? sentenceEvents : [narrationLine].filter(Boolean);
      const eventScores = inspectedEvents.map((eventLine) => {
        const eventLineTokens = tokenize(eventLine);
        const visualMatchScore = jaccard(eventLineTokens, sceneTokens);
        const evidenceMatchScore = jaccard(eventLineTokens, evidenceTokens);
        const plotMatchScore = jaccard(eventLineTokens, eventTokens);
        const matchScore = Math.max(visualMatchScore, evidenceMatchScore, plotMatchScore);
        return {
          text: eventLine,
          visualMatchScore: Number(visualMatchScore.toFixed(3)),
          evidenceMatchScore: Number(evidenceMatchScore.toFixed(3)),
          plotMatchScore: Number(plotMatchScore.toFixed(3)),
          matchScore: Number(matchScore.toFixed(3))
        };
      });
      const averageMatchScore = eventScores.reduce((sum, item) => sum + item.matchScore, 0) / Math.max(1, eventScores.length);
      const averageEvidenceScore = eventScores.reduce((sum, item) => sum + item.evidenceMatchScore, 0) / Math.max(1, eventScores.length);
      const issues = [];
      if (narrationLine && evidenceTokens.length >= 3 && averageEvidenceScore < 0.025) {
        issues.push({
          severity: "warning",
          code: "low_evidence_grounding",
          message: "Narration line does not clearly map to Evidence Store entries for the selected scene."
        });
      }
      if (narrationLine && evidenceScene && getSceneEvidenceLevel(evidenceScene) === "weak" && !hasSoftInferenceLanguage(narrationLine)) {
        issues.push({
          severity: "warning",
          code: "weak_evidence_overstated",
          message: "Narration makes a weak Evidence Store scene sound certain."
        });
      }
      if (narrationLine && averageMatchScore < 0.035 && (sceneTokens.length >= 4 || eventTokens.length >= 4)) {
        issues.push({
          severity: "warning",
          code: "low_event_grounding",
          message: "Narration line does not clearly map to the selected scene or plot event."
        });
      }
      if (narrationLine && !plotEvent && Array.isArray(filmUnderstanding?.plotTimeline?.events) && filmUnderstanding.plotTimeline.events.length) {
        issues.push({
          severity: "warning",
          code: "missing_plot_event",
          message: "Narration line is not attached to a known plot event."
        });
      }
      const segmentCharacterIds = Array.isArray(segment.characterIds) ? segment.characterIds : roleEntry?.characterIds || storyBeat?.mainCharacters || [];
      for (const characterId of segmentCharacterIds) {
        if (characterIds.size && !characterIds.has(normalizeId(characterId))) {
          issues.push({
            severity: "warning",
            code: "character_identity_mismatch",
            message: `Character ${characterId} is not present in the character mental model.`
          });
        }
      }
      if (segment.currentCharacterGoal) {
        const modelText = getCharacters(narrativeIntelligence)
          .filter((character) => !segmentCharacterIds.length || segmentCharacterIds.some((id) => normalizeId(id) === normalizeId(character.characterId || character.character_id)))
          .map((character) => [character.goal, character.motivation, character.externalConflict, character.internalConflict].filter(Boolean).join(" "))
          .join(" ");
        const goalMatch = jaccard(tokenize(segment.currentCharacterGoal), tokenize(`${modelText} ${storyBeat?.mainGoal || ""}`));
        if (modelText && goalMatch < 0.025) {
          issues.push({
            severity: "warning",
            code: "character_goal_mismatch",
            message: "The segment goal is not supported by the character mental model."
          });
        }
      }
      if (!hasRelationshipSupport(segmentCharacterIds, narrativeIntelligence)) {
        issues.push({
          severity: "warning",
          code: "relationship_mismatch",
          message: "The segment uses multiple characters but the relationship graph does not support their relationship."
        });
      }
      const plotEventId = segment.plotEventId || roleEntry?.plotEventId || roleEntry?.plot_event_id || plotEvent?.eventId || plotEvent?.event_id || "";
      const worldState = getWorldState(plotEventId, narrativeIntelligence);
      if (segment.currentCharacterKnowledge && worldState) {
        const knowledgeSupport = [
          ...(Array.isArray(worldState.knownFacts || worldState.known_facts) ? (worldState.knownFacts || worldState.known_facts) : []),
          ...(Array.isArray(worldState.changedFacts || worldState.changed_facts) ? (worldState.changedFacts || worldState.changed_facts) : []),
          worldState.protagonistState,
          worldState.stakes
        ].filter(Boolean).join(" ");
        if (knowledgeSupport && jaccard(tokenize(segment.currentCharacterKnowledge), tokenize(knowledgeSupport)) < 0.02) {
          issues.push({
            severity: "warning",
            code: "knowledge_state_mismatch",
            message: "The segment says a character knows something not supported by the world-state timeline."
          });
        }
      }
      const firstCharacterId = segmentCharacterIds[0] || "";
      const emotionalState = firstCharacterId ? getEmotionalState(firstCharacterId, plotEventId, narrativeIntelligence) : null;
      if ((segment.emotionBefore || segment.emotionAfter) && !segment.visualEvidence && !segment.transcriptEvidence && !emotionalState) {
        issues.push({
          severity: "warning",
          code: "emotion_not_supported",
          message: "The segment states emotion without visible, transcript, or emotional-timeline evidence."
        });
      }
      const eventOrder = orderMap.get(normalizeId(plotEventId));
      if (Number.isFinite(eventOrder)) {
        if (eventOrder < lastEventOrder) {
          issues.push({
            severity: "warning",
            code: "event_order_violation",
            message: "The segment references a plot event earlier than the previous segment."
          });
        }
        lastEventOrder = Math.max(lastEventOrder, eventOrder);
      }
      const beatRole = safeText(storyBeat?.beatRole || segment.storyBeatRole || segment.narrativeBeat || segment.role).toLowerCase();
      if (beatRole === "setup" || beatRole === "context" || beatRole === "incident") setupSeen = true;
      if (beatRole === "conflict") conflictSeen = true;
      if ((beatRole === "reveal" || beatRole === "payoff" || /reveal|twist|betray|truth|secret/i.test(narrationLine)) && !setupSeen) {
        issues.push({
          severity: "warning",
          code: "reveal_before_setup",
          message: "The segment appears to reveal/pay off information before a setup beat exists."
        });
      }
      if ((beatRole === "payoff" || beatRole === "escalation") && !conflictSeen && index > 1) {
        issues.push({
          severity: "warning",
          code: "event_order_violation",
          message: "The segment escalates or pays off before a clear conflict beat."
        });
      }
      if (safeText(segment.evidenceLevel).toLowerCase() === "weak" && !hasSoftInferenceLanguage(narrationLine)) {
        issues.push({
          severity: "warning",
          code: "weak_inference_overstated",
          message: "The segment makes a weakly evidenced inference sound too certain."
        });
      }
      if (!segment.currentCharacterGoal && !segment.whatChanged && averageMatchScore >= 0.04 && eventScores.every((item) => item.plotMatchScore < 0.025)) {
        issues.push({
          severity: "warning",
          code: "scene_only_captioning",
          message: "The segment reads like a scene caption without character goal, change, or plot consequence."
        });
      }
      entries.push({
        index,
        sceneId: segment.sceneId || segment.metadataSummary?.sceneId || segment.metadataSummary?.scene_id || "",
        role: segment.role,
        beatId: segment.beatId || storyBeat?.beatId || storyBeat?.beat_id || "",
        plotEventId,
        characterIds: segmentCharacterIds,
        currentCharacterGoal: segment.currentCharacterGoal || "",
        currentCharacterKnowledge: segment.currentCharacterKnowledge || "",
        emotionBefore: segment.emotionBefore || "",
        emotionAfter: segment.emotionAfter || "",
        whatChanged: segment.whatChanged || storyBeat?.whatChanged || "",
        evidenceLevel: segment.evidenceLevel || storyBeat?.evidenceLevel || getSceneEvidenceLevel(evidenceScene),
        evidenceIds,
        narrationLine,
        eventText: eventText.slice(0, 360),
        evidenceSummary: evidenceText.slice(0, 560),
        visualSummary: sceneText.slice(0, 360),
        averageMatchScore: Number(averageMatchScore.toFixed(3)),
        averageEvidenceScore: Number(averageEvidenceScore.toFixed(3)),
        events: eventScores,
        issues
      });
    }

    const issues = entries.flatMap((entry) => entry.issues.map((issue) => ({
      ...issue,
      segmentIndex: entry.index,
      sceneId: entry.sceneId,
      plotEventId: entry.plotEventId
    })));
    return {
      inspectedAt: new Date().toISOString(),
      passed: !issues.some((issue) => issue.severity === "error"),
      weakSegmentCount: issues.filter((issue) => issue.code === "low_event_grounding" || issue.code === "low_evidence_grounding").length,
      evidenceWeakSegmentCount: issues.filter((issue) => issue.code === "low_evidence_grounding" || issue.code === "weak_evidence_overstated").length,
      issues,
      segments: entries
    };
  }

  async inspectAndWrite({ segments, sceneMetadata, evidenceStore, filmUnderstanding, narrativeIntelligence, outputPath }) {
    const report = this.inspect({ segments, sceneMetadata, evidenceStore, filmUnderstanding, narrativeIntelligence });
    if (outputPath) {
      await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
    }
    return report;
  }
}

module.exports = NarrationGroundingService;
