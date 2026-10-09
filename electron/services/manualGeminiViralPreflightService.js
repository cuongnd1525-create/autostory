function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(value) {
  return String(value || "").trim();
}

function wordCount(value) {
  return text(value).split(/\s+/).filter(Boolean).length;
}

function idList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => text(item)).filter(Boolean))];
}

const INDEPENDENT_HOOK_TYPES = [
  "high_action",
  "dialogue_conflict",
  "psychological_wtf",
  "rage_irony",
  "evidence_reveal"
];

function normalizedHookPriority(value) {
  const requested = Array.isArray(value) ? value.map((item) => text(item)) : [];
  const result = requested.filter((item, index) => INDEPENDENT_HOOK_TYPES.includes(item) && requested.indexOf(item) === index);
  INDEPENDENT_HOOK_TYPES.forEach((item) => {
    if (!result.includes(item)) result.push(item);
  });
  return result;
}

function independentOptionsForScript(script = {}) {
  const value = script.independent_prompt_options || script.independentPromptOptions || {};
  const ranges = value.durations || {};
  const range = (item, fallbackMin, fallbackMax) => {
    const min = Math.max(60.5, number(item?.min, fallbackMin));
    return { min, max: Math.max(min, number(item?.max, fallbackMax)) };
  };
  return {
    hookPriority: normalizedHookPriority(value.hookPriority),
    hookMaxSec: clamp(number(value.hookMaxSec, 30), 4, 30),
    durations: {
      script1: range(ranges.script1, 60.5, 120),
      script3: range(ranges.script3, 90, 240),
      script4: range(ranges.script4, 60.5, 120)
    }
  };
}

function actorTerms(actor = {}) {
  return [
    actor.displayLabel,
    actor.display_label,
    actor.role,
    ...(Array.isArray(actor.aliases) ? actor.aliases : []),
    ...(Array.isArray(actor.relationshipFacts || actor.relationship_facts)
      ? (actor.relationshipFacts || actor.relationship_facts)
      : [])
  ]
    .flatMap((value) => text(value).toLowerCase().split(/[^a-z0-9']+/))
    .filter((value) => value.length >= 3 && !CONTENT_STOP_WORDS.has(value));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function phaseOf(segment = {}, evidence = {}) {
  return text(
    segment.storyFunction
    || segment.story_function
    || segment.sceneType
    || segment.scene_type
    || evidence.narrativePhase
  ).toLowerCase();
}

const CONTENT_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "before", "but", "by", "for",
  "from", "had", "has", "have", "he", "her", "his", "in", "into", "is", "it", "its",
  "of", "on", "or", "she", "that", "the", "their", "them", "they", "this", "to", "was",
  "were", "while", "with", "would"
]);
const CRITICAL_CLAIM_TERMS = new Set([
  "arrest", "arrested", "blood", "body", "bullet", "charges", "charged", "confess",
  "confessed", "dead", "died", "firearm", "fired", "gun", "handcuff", "handcuffed",
  "knife", "killed", "machete", "murder", "prison", "rifle", "sentence", "sentenced",
  "shot", "shooting", "stabbed", "sword", "taser", "warrant", "weapon"
]);
const CLAIM_ALIASES = {
  shooting: ["shoot", "shot", "deadly force", "firearm", "gun"],
  shot: ["shooting", "fired", "bullet", "gun"],
  firearm: ["gun", "weapon"],
  gun: ["firearm", "weapon"],
  arrested: ["arrest", "custody", "handcuffed"],
  handcuffed: ["handcuff", "arrest", "custody"],
  prison: ["sentence", "sentenced", "custody"],
  recognized: ["familiar", "familiarity", "knows"],
  familiarity: ["familiar", "recognized", "knows"]
};

function contentTokens(value) {
  return new Set(
    text(value)
      .toLowerCase()
      .replace(/[^a-z0-9' -]+/g, " ")
      .split(/\s+/)
      .map((token) => token.replace(/^'+|'+$/g, ""))
      .filter((token) => token.length >= 4 && !CONTENT_STOP_WORDS.has(token))
  );
}

function evidenceGroundingText(evidence = {}) {
  return [
    ...(evidence.visualFacts || []),
    ...(evidence.dialogueEvidence || []).map((item) => text(item?.text || item)),
    evidence.sourceNarratorText,
    evidence.storyMeaning,
    ...(evidence.soundCues || []),
    ...(evidence.keywords || []),
    evidence.uniqueMoment,
    evidence.payoff
  ].filter(Boolean).join(" ");
}

function measureVoiceGrounding(voiceText, evidence = {}) {
  const claims = contentTokens(voiceText);
  const groundingText = evidenceGroundingText(evidence).toLowerCase();
  const grounding = contentTokens(groundingText);
  if (!claims.size) return { ratio: 1, unsupported: [] };
  const unsupported = [...claims].filter((token) => {
    if (grounding.has(token)) return false;
    return !(CLAIM_ALIASES[token] || []).some((alias) => groundingText.includes(alias));
  });
  const criticalUnsupported = unsupported.filter((token) => CRITICAL_CLAIM_TERMS.has(token));
  return {
    ratio: Number(((claims.size - unsupported.length) / claims.size).toFixed(3)),
    unsupported,
    criticalUnsupported
  };
}

function evidenceHasBurnedText(evidence = {}) {
  if (typeof evidence.burnedTextPresent === "boolean") return evidence.burnedTextPresent;
  return (evidence.visualFacts || []).some((fact) => (
    /\b(on-screen text|subtitle|caption|text (?:reads|displays|states|shows))\b/i.test(text(fact))
  ));
}

function evidenceHasSourceNarrator(evidence = {}) {
  if (evidence.sourceNarratorPresent === true) return true;
  if (["source_narration", "mixed_narration_dialogue"].includes(
    text(evidence.sourceAudioType).toLowerCase()
  )) return true;
  if (text(evidence.sourceNarratorText)) return true;
  return (evidence.dialogueEvidence || []).some((item) => (
    /\[(?:source\s+)?narrator\]|\bnarrator\s*:/i.test(text(item?.text || item))
  ));
}

function resolveScriptProfile(script = {}, expectedScriptId = 0) {
  const parsedId = number(script.scriptId ?? script.script_id, expectedScriptId);
  const scriptId = [1, 3, 4].includes(parsedId) ? parsedId : 4;
  const seriesMode = text(script.series_mode || script.seriesMode).toLowerCase();
  const promptProfile = text(script.prompt_profile || script.promptProfile).toLowerCase();
  const partNumber = number(script.part_number ?? script.partNumber, 0);
  const independentOptions = independentOptionsForScript(script);
  if (promptProfile === "viral_police_blotter") {
    return {
      scriptId,
      label: `Viral Police Blotter ${scriptId}`,
      minDuration: 60.5,
      maxDuration: 240,
      maxSourceJumps: 6,
      maxMacroBlocks: 10,
      maxVoiceoverSec: 15,
      seriesMode: false,
      policeBlotter: true
    };
  }
  // The viral_tiktok_crime_part1 Series Planner locks 110-125s per Part.
  // Real 2026-10-09 output (115-116s) was wrongly penalized by the generic
  // 75-110s serialized fallback. This profile must be a single source of
  // truth, even if a generated script omits/overrides target_duration_*.
  const crimeSeriesProfile = promptProfile === "viral_tiktok_crime_part1";
  if (crimeSeriesProfile || seriesMode === "interleaved_multipart" || partNumber > 0) {
    const minDuration = crimeSeriesProfile ? 110
      : Math.max(60.5, number(script.target_duration_min_sec ?? script.targetDurationMinSec, 75));
    const maxDuration = crimeSeriesProfile ? 125
      : Math.max(minDuration, number(script.target_duration_max_sec ?? script.targetDurationMaxSec, 110));
    return {
      scriptId,
      label: `Serialized Part ${partNumber || [1, 3, 4].indexOf(scriptId) + 1}`,
      minDuration,
      maxDuration,
      maxSourceJumps: 7,
      maxMacroBlocks: 12,
      maxVoiceoverSec: 12,
      seriesMode: true,
      promptProfile,
      partNumber: partNumber || [1, 3, 4].indexOf(scriptId) + 1,
      interleavedAudioEnabled: script.interleaved_audio_enabled !== false,
      sharedHookEnabled: script.shared_hook_enabled !== false,
      pacing: text(script.series_pacing || script.seriesPacing || "strict_10")
    };
  }
  return {
    scriptId,
    seriesMode: false,
    independent: true,
    independentOptions,
    hookMaxSec: independentOptions.hookMaxSec,
    ...(scriptId === 1
      ? { label: "Caught in 4K / Narrated Raw Reality", minDuration: independentOptions.durations.script1.min, maxDuration: independentOptions.durations.script1.max, maxSourceJumps: 4, maxMacroBlocks: 6, maxVoiceoverSec: 8 }
      : scriptId === 3
      ? { label: "Viral Mini-Doc", minDuration: independentOptions.durations.script3.min, maxDuration: independentOptions.durations.script3.max, maxSourceJumps: 5, maxMacroBlocks: 8, maxVoiceoverSec: 12 }
      : { label: "80/20 Rage-Bait Reality", minDuration: independentOptions.durations.script4.min, maxDuration: independentOptions.durations.script4.max, maxSourceJumps: 3, maxMacroBlocks: 7, maxVoiceoverSec: 6 })
  };
}

function narrativeContractForScript(script = {}) {
  const value = script.narrative_contract
    || script.narrativeContract
    || script.story_blueprint?.narrativeContract
    || script.storyBlueprint?.narrativeContract
    || {};
  const resolution = value.mandatoryResolution || value.mandatory_resolution || {};
  const secondary = value.secondaryPayoff || value.secondary_payoff || {};
  const resolutionEvidenceIds = idList(resolution.evidenceIds || resolution.evidence_ids);
  return {
    present: Boolean(Object.keys(value).length),
    hookPromise: text(value.hookPromise || value.hook_promise),
    primaryAudienceQuestion: text(value.primaryAudienceQuestion || value.primary_audience_question),
    primaryStakeType: text(value.primaryStakeType || value.primary_stake_type).toLowerCase(),
    stakeActorIds: idList(value.stakeActorIds || value.stake_actor_ids),
    mandatoryResolution: {
      required: resolution.required === true || resolutionEvidenceIds.length > 0,
      resolutionType: text(resolution.resolutionType || resolution.resolution_type).toLowerCase(),
      evidenceIds: resolutionEvidenceIds,
      preferredVisualEvidenceIds: idList(
        resolution.preferredVisualEvidenceIds || resolution.preferred_visual_evidence_ids
      ),
      fallbackVerbalEvidenceIds: idList(
        resolution.fallbackVerbalEvidenceIds || resolution.fallback_verbal_evidence_ids
      ),
      visualFirstRequired: resolution.visualFirstRequired !== false
        && resolution.visual_first_required !== false,
      mustAppearBeforeLaterTimeJump: resolution.mustAppearBeforeLaterTimeJump !== false
        && resolution.must_appear_before_later_time_jump !== false,
      verifiedOutcome: text(resolution.verifiedOutcome || resolution.verified_outcome)
    },
    secondaryPayoff: {
      required: secondary.required === true,
      mustBeFinal: secondary.mustBeFinal === true || secondary.must_be_final === true,
      question: text(secondary.question),
      evidenceIds: idList(secondary.evidenceIds || secondary.evidence_ids),
      verifiedOutcome: text(secondary.verifiedOutcome || secondary.verified_outcome)
    }
  };
}

function storySpineForScript(script = {}) {
  const blueprint = script.story_blueprint || script.storyBlueprint || {};
  const value = blueprint.storySpine || blueprint.story_spine || script.storySpine || script.story_spine || {};
  return {
    present: Boolean(value && typeof value === "object" && Object.keys(value).length),
    centralViewerQuestion: text(value.centralViewerQuestion || value.central_viewer_question),
    hookPromise: text(value.hookPromise || value.hook_promise),
    rewindContext: text(value.rewindContext || value.rewind_context),
    escalationPath: Array.isArray(value.escalationPath || value.escalation_path)
      ? (value.escalationPath || value.escalation_path).map(text).filter(Boolean)
      : [],
    climax: text(value.climax),
    climaxEvidenceIds: idList(value.climaxEvidenceIds || value.climax_evidence_ids),
    payoff: text(value.payoff),
    payoffEvidenceIds: idList(value.payoffEvidenceIds || value.payoff_evidence_ids),
    finalOutcomeRequired: value.finalOutcomeRequired === true || value.final_outcome_required === true,
    finalOutcome: text(value.finalOutcome || value.final_outcome),
    finalOutcomeEvidenceIds: idList(value.finalOutcomeEvidenceIds || value.final_outcome_evidence_ids)
  };
}

function comparableStoryText(value = "") {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function segmentBridgePurpose(segment = {}) {
  return text(segment.bridgePurpose || segment.bridge_purpose).toLowerCase();
}

function segmentTimelinePhase(segment = {}, evidence = {}) {
  const explicit = text(segment.timelinePhase || segment.timeline_phase).toLowerCase();
  if (explicit) return explicit;
  const stakeRole = text(evidence.stakeRole || evidence.stake_role).toLowerCase();
  if (["victim_resolution", "hazard_resolution"].includes(stakeRole)) return "immediate_resolution";
  if (["suspect_resolution", "legal_resolution"].includes(stakeRole)) return "later_outcome";
  return "";
}

function segmentSignature(segment = {}) {
  return [
    text(segment.evidenceId),
    number(segment.sourceStartSec).toFixed(2),
    number(segment.sourceEndSec).toFixed(2),
    text(segment.audioMode)
  ].join("|");
}

const PROCEDURAL_BLOAT_PATTERN = /\b(?:written statement|fill(?:ing)? out (?:a |the )?(?:written )?statement|come (?:in|into|down to) (?:the )?(?:police )?(?:department|station)|paperwork|phone number|contact information|spell(?:ing)? (?:your |the )?(?:name|last name)|fill(?:ing)? (?:out )?(?:a |the )?forms?|report details?|date of birth|address for the report)\b/i;

function evidenceIsProceduralBloat(evidence = {}) {
  if (evidence.proceduralBloat === true || evidence.procedural_bloat === true) return true;
  const searchable = [
    ...(evidence.dialogueEvidence || []).map((item) => text(item?.text || item)),
    ...(evidence.visualFacts || []),
    evidence.storyMeaning,
    evidence.uniqueMoment
  ].join(" ");
  return PROCEDURAL_BLOAT_PATTERN.test(searchable);
}

function scoreManualGeminiVariant({
  script = {},
  normalizedScript = {},
  evidencePayload = null,
  expectedScriptId = 0,
  previousNormalizedScript = null,
  previousPreflight = null,
  voiceProfile = null
} = {}) {
  const segments = Array.isArray(normalizedScript.segments) ? normalizedScript.segments : [];
  const rawSegments = Array.isArray(script.segments) ? script.segments : [];
  const profile = resolveScriptProfile(script, expectedScriptId);
  const evidenceById = new Map(
    (evidencePayload?.evidence || []).map((item) => [text(item.evidenceId), item])
  );
  const narrativeContract = narrativeContractForScript(script);
  const storySpine = storySpineForScript(script);
  const duration = number(normalizedScript.totalDuration);
  const monetizationEligible = duration >= 60.5;
  const durationWithinProfile = duration >= profile.minDuration && duration <= profile.maxDuration;
  const audioStrategy = text(script.audio_strategy || script.audioStrategy).toLowerCase();
  const timelinePolicy = text(script.timeline_policy || script.timelinePolicy).toLowerCase();
  const storyDrivenNonlinear = profile.independent
    && /story_driven_non_linear|thematic/.test(timelinePolicy);
  const sourceAudioOnly = ["source_audio_only", "clean_source_audio_only"].includes(audioStrategy)
    || script.voiceover_enabled === false;
  const issues = [];
  const strengths = [];
  let score = 100;

  if (!segments.length) {
    return {
      score: 0,
      grade: "D",
      passed: false,
      issues: ["Variant không có segment."],
      strengths: [],
      metrics: {}
    };
  }

  const first = segments[0];
  const hookSegmentIndexes = [];
  for (let index = 0; index < segments.length; index += 1) {
    const raw = rawSegments[index] || {};
    const phase = phaseOf(raw, evidenceById.get(text(segments[index]?.evidenceId)) || {});
    if (index > 0 && !phase.includes("hook")) break;
    hookSegmentIndexes.push(index);
  }
  if (!hookSegmentIndexes.length) hookSegmentIndexes.push(0);
  const hookDuration = hookSegmentIndexes.reduce((sum, index) => (
    sum + number(segments[index]?.duration, number(segments[index]?.endSec) - number(segments[index]?.startSec))
  ), 0);
  const hookEvidence = hookSegmentIndexes.map((index) => evidenceById.get(text(segments[index]?.evidenceId)) || {});
  const explicitHookScore = Math.max(0, ...hookEvidence.map((item) => number(item.hookScore, 0)));
  const fallbackHookScore = Math.max(0, ...hookEvidence.map((item) => number(item.viralScore, 0)));
  const hasMeasuredHookScore = explicitHookScore > 0 || fallbackHookScore > 0;
  const hookScore = explicitHookScore > 0 ? explicitHookScore : fallbackHookScore;
  const inputAccessAudit = script.inputAccessAudit || script.input_access_audit || {};
  const inspectedInputs = Array.isArray(inputAccessAudit.inspectedInputs)
    ? inputAccessAudit.inspectedInputs
    : Array.isArray(inputAccessAudit.inspected_inputs) ? inputAccessAudit.inspected_inputs : [];
  const accessStage = text(inputAccessAudit.stage).toLowerCase();
  const draftAccessEntry = inspectedInputs.find((item) => text(item?.role).toLowerCase() === "draft") || null;
  const expectedDraftDurationSec = number(
    inputAccessAudit.expectedDraftDurationSec ?? inputAccessAudit.expected_draft_duration_sec,
    0
  );
  const draftCoverageEndSec = number(draftAccessEntry?.coverageEndSec ?? draftAccessEntry?.coverage_end_sec, 0);
  const draftCoveragePassed = !accessStage.includes("draft_review") || Boolean(
    draftAccessEntry
    && draftAccessEntry.opened === true
    && draftAccessEntry.parsed === true
    && draftCoverageEndSec > 0
    && (!expectedDraftDurationSec || draftCoverageEndSec >= expectedDraftDurationSec - 1)
  );
  const hookTriggerAudit = script.hookTriggerAudit || script.hook_trigger_audit || {};
  const hookTriggerSourceSec = number(hookTriggerAudit.triggerSourceSec ?? hookTriggerAudit.trigger_source_sec, NaN);
  const hookStartSourceSec = number(first?.sourceStartSec, NaN);
  const hookTriggerLatencySec = Number.isFinite(hookTriggerSourceSec) && Number.isFinite(hookStartSourceSec)
    ? Math.max(0, hookTriggerSourceSec - hookStartSourceSec)
    : null;
  const hookTriggerVerified = hookTriggerAudit.verifiedAgainstHookAuditClip === true
    || hookTriggerAudit.verified_against_hook_audit_clip === true;
  const teaserClimaxAudit = script.teaserClimaxAudit || script.teaser_climax_audit || {};
  const allowedHookReplaySec = Math.max(0, number(
    teaserClimaxAudit.allowedReplaySec ?? teaserClimaxAudit.allowed_replay_sec,
    0.5
  ));
  const hookRanges = hookSegmentIndexes.map((index) => segments[index]);
  const climaxRanges = segments.filter((segment, index) => (
    phaseOf(rawSegments[index] || {}, evidenceById.get(text(segment.evidenceId)) || {}).includes("climax")
  ));
  const hookClimaxOverlapSec = hookRanges.reduce((sum, hookRange) => sum + climaxRanges.reduce((inner, climaxRange) => (
    inner + Math.max(0, Math.min(number(hookRange.sourceEndSec), number(climaxRange.sourceEndSec))
      - Math.max(number(hookRange.sourceStartSec), number(climaxRange.sourceStartSec)))
  ), 0), 0);
  const teaserEventId = text(teaserClimaxAudit.teaserEventId || teaserClimaxAudit.teaser_event_id);
  const climaxEventId = text(teaserClimaxAudit.climaxEventId || teaserClimaxAudit.climax_event_id);
  const reprisePolicy = text(teaserClimaxAudit.reprisePolicy || teaserClimaxAudit.reprise_policy).toLowerCase();
  const semanticRepriseDeclared = Boolean(teaserEventId && climaxEventId && teaserEventId === climaxEventId);
  const teaserClimaxHandoffPassed = hookClimaxOverlapSec <= allowedHookReplaySec + 0.001
    && (!semanticRepriseDeclared || reprisePolicy === "continue_after_teaser");
  const transitionCoveragePlan = script.transitionCoveragePlan || script.transition_coverage_plan || {};
  const requiredTransitionCount = Math.max(0, number(
    transitionCoveragePlan.requiredBoundaryCount ?? transitionCoveragePlan.required_boundary_count,
    0
  ));
  const unresolvedTransitionCount = Math.max(0, number(
    transitionCoveragePlan.unresolvedBoundaryCount ?? transitionCoveragePlan.unresolved_boundary_count,
    0
  ));
  const transitionCoverageRatio = requiredTransitionCount
    ? Math.max(0, Math.min(1, number(transitionCoveragePlan.coverageRatio ?? transitionCoveragePlan.coverage_ratio, 0)))
    : 1;
  const originalAudioDuration = segments
    .filter((segment) => segment.audioMode === "original_audio")
    .reduce((sum, segment) => sum + number(segment.duration), 0);
  const voiceoverDuration = Math.max(0, duration - originalAudioDuration);
  const voiceoverSegments = segments.filter((segment) => segment.audioMode !== "original_audio");
  const voiceProfileWordsPerSecond = number(
    voiceProfile?.conservativeWordsPerSecond || voiceProfile?.wordsPerSecond,
    0
  );
  const estimatedVoiceTimingRisks = voiceProfileWordsPerSecond > 0
    ? segments.map((segment, index) => {
      if (segment.audioMode === "original_audio") return null;
      const voiceoverText = text(segment.voiceoverText);
      if (!voiceoverText) return null;
      const plannedDurationSec = Math.max(0.2, number(segment.duration));
      const estimatedVoiceSec = wordCount(voiceoverText) / voiceProfileWordsPerSecond;
      const estimatedFitRatio = estimatedVoiceSec / plannedDurationSec;
      return estimatedFitRatio > 1.35
        ? {
          index,
          segmentId: text(rawSegments[index]?.id || rawSegments[index]?.segmentId || segment.id || segment.sceneId),
          plannedDurationSec: Number(plannedDurationSec.toFixed(3)),
          estimatedVoiceSec: Number(estimatedVoiceSec.toFixed(3)),
          estimatedFitRatio: Number(estimatedFitRatio.toFixed(3)),
          wordCount: wordCount(voiceoverText)
        }
        : null;
    }).filter(Boolean)
    : [];
  const genZVoiceTexts = profile.promptProfile === "serialized_genz"
    ? voiceoverSegments.map((segment) => text(segment.voiceoverText)).filter(Boolean)
    : [];
  const originalAudioRatio = duration > 0 ? originalAudioDuration / duration : 0;
  const shortFragments = segments.filter((segment) => number(segment.duration) < 4);
  const allowedMicroCutPurposes = new Set([
    "hook_montage", "impact", "reaction", "evidence_insert",
    "visual_proof", "contradiction", "climax_punctuation"
  ]);
  const purposefulMicroCuts = shortFragments.filter((segment) => {
    const index = segments.indexOf(segment);
    const raw = rawSegments[index] || {};
    const evidence = evidenceById.get(text(segment.evidenceId)) || {};
    const purpose = text(raw.microCutPurpose || raw.micro_cut_purpose).toLowerCase();
    return phaseOf(raw, evidence).includes("hook") || allowedMicroCutPurposes.has(purpose);
  });
  const riskyShortFragments = shortFragments.filter((segment) => !purposefulMicroCuts.includes(segment));
  const narrationArc = script.narration_arc || script.narrationArc || {};
  const narrationBeats = Array.isArray(narrationArc.beats) ? narrationArc.beats : [];
  const narrationBeatIds = new Set(narrationBeats.map((beat) => (
    text(beat?.narrationBeatId || beat?.narration_beat_id)
  )).filter(Boolean));
  const missingNarrationBeatRefs = profile.independent
    ? voiceoverSegments.map((segment) => {
      const index = segments.indexOf(segment);
      const raw = rawSegments[index] || {};
      const beatId = text(raw.narrationBeatId || raw.narration_beat_id);
      return beatId && narrationBeatIds.has(beatId) ? null : index;
    }).filter(Number.isInteger)
    : [];
  const sourceNarratorPolicy = text(
    script.source_narrator_policy || script.sourceNarratorPolicy
  ).toLowerCase();
  const hookColdViewerTest = script.hook_cold_viewer_test || script.hookColdViewerTest || {};
  const hookColdViewerSignals = [
    hookColdViewerTest.identifiedActor,
    hookColdViewerTest.identifiedConflict,
    hookColdViewerTest.identifiedStake
  ].filter((value) => text(value)).length;
  const hookColdViewerPassed = hookColdViewerTest.passes === true && hookColdViewerSignals >= 2;
  const longVoiceovers = segments.filter((segment) => (
    profile.maxVoiceoverSec > 0
    && segment.audioMode !== "original_audio"
    && number(segment.duration) > profile.maxVoiceoverSec + 0.05
  ));
  let sourceJumpCount = 0;
  let contiguousPairs = 0;
  const sourceJumps = [];
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    const previousRaw = rawSegments[index - 1] || {};
    const currentRaw = rawSegments[index] || {};
    const previousEvidence = evidenceById.get(text(previous.evidenceId)) || {};
    const currentEvidence = evidenceById.get(text(current.evidenceId)) || {};
    const previousRunId = text(previousRaw.sourceRunId || previousRaw.source_run_id || previousEvidence.sourceRunId);
    const currentRunId = text(currentRaw.sourceRunId || currentRaw.source_run_id || currentEvidence.sourceRunId);
    const sameSourceRun = Boolean(previousRunId && currentRunId && previousRunId === currentRunId);
    if (sameSourceRun || Math.abs(number(current.sourceStartSec) - number(previous.sourceEndSec)) <= 0.35) {
      contiguousPairs += 1;
    } else {
      sourceJumpCount += 1;
      sourceJumps.push({
        fromSegment: index,
        toSegment: index + 1,
        fromSourceEndSec: number(previous.sourceEndSec),
        toSourceStartSec: number(current.sourceStartSec),
        gapSec: Number(Math.abs(number(current.sourceStartSec) - number(previous.sourceEndSec)).toFixed(3))
      });
    }
  }
  const audioRuns = [];
  segments.forEach((segment, index) => {
    const mode = segment.audioMode === "original_audio" ? "original_audio" : "voiceover_only";
    const evidence = evidenceById.get(text(segment.evidenceId)) || {};
    const rawSegment = rawSegments[index] || {};
    const actionOverride = segment.actionOverride === true
      || rawSegment.actionOverride === true
      || rawSegment.action_override === true
      || evidence.actionOverride === true
      || evidence.mustInclude === true;
    const sustainedBeatOverride = segment.sustainedBeatOverride === true
      || rawSegment.sustainedBeatOverride === true
      || rawSegment.sustained_beat_override === true;
    const lastRun = audioRuns[audioRuns.length - 1];
    if (lastRun?.mode === mode) {
      lastRun.duration += number(segment.duration);
      lastRun.segmentCount += 1;
      lastRun.actionOverride = lastRun.actionOverride || actionOverride;
      lastRun.sustainedBeatOverride = lastRun.sustainedBeatOverride || sustainedBeatOverride;
    } else {
      audioRuns.push({ mode, duration: number(segment.duration), segmentCount: 1, actionOverride, sustainedBeatOverride });
    }
  });
  const seriesRunLimit = profile.pacing === "story_first" ? 30 : profile.pacing === "balanced" ? 18 : 15;
  const oversizedSeriesRuns = profile.seriesMode && profile.interleavedAudioEnabled
    ? audioRuns.filter((run) => run.duration > seriesRunLimit + 0.05 && !run.actionOverride && !run.sustainedBeatOverride)
    : [];
  const protectedActionRuns = audioRuns.filter((run) => run.actionOverride && run.mode === "original_audio");
  const protectedSustainedBeatRuns = audioRuns.filter((run) => run.sustainedBeatOverride && run.mode === "original_audio");
  const continuityRatio = segments.length > 1 ? contiguousPairs / (segments.length - 1) : 1;
  let hookSequenceEndIndex = 0;
  while (hookSequenceEndIndex + 1 < segments.length) {
    const nextIndex = hookSequenceEndIndex + 1;
    const nextEvidence = evidenceById.get(text(segments[nextIndex]?.evidenceId)) || {};
    if (!/hook/.test(phaseOf(rawSegments[nextIndex] || {}, nextEvidence))) break;
    hookSequenceEndIndex = nextIndex;
  }
  const actorIdentityMap = Array.isArray(script.actor_identity_map || script.actorIdentityMap)
    ? (script.actor_identity_map || script.actorIdentityMap)
    : Array.isArray(evidencePayload?.actorIdentityMap || evidencePayload?.actor_identity_map)
    ? (evidencePayload.actorIdentityMap || evidencePayload.actor_identity_map)
    : [];
  const actorById = new Map(actorIdentityMap.map((actor) => [text(actor.actorId || actor.actor_id), actor]));
  const actorIdsForSegment = (index) => {
    const raw = rawSegments[index] || {};
    const normalized = segments[index] || {};
    const evidence = evidenceById.get(text(normalized.evidenceId)) || {};
    return [...new Set([
      ...idList(raw.actor_ids || raw.actorIds),
      ...idList(normalized.actorIds),
      ...idList(evidence.actorIds || evidence.actor_ids),
      text(raw.primary_actor_id || raw.primaryActorId || normalized.primaryActorId || evidence.primaryActorId),
      text(raw.speaker_actor_id || raw.speakerActorId || normalized.speakerActorId || evidence.speakerActorId)
    ].filter(Boolean))];
  };
  const hookActorIds = [...new Set(
    segments.slice(0, hookSequenceEndIndex + 1).flatMap((_segment, index) => actorIdsForSegment(index))
  )];
  const postHookWindowIndexes = [];
  let postHookWindowSec = 0;
  for (let index = hookSequenceEndIndex + 1; index < segments.length && postHookWindowSec < 15; index += 1) {
    postHookWindowIndexes.push(index);
    postHookWindowSec += number(segments[index]?.duration);
  }
  const postHookActorIds = [...new Set(postHookWindowIndexes.flatMap((index) => actorIdsForSegment(index)))];
  const introducedPostHookActorIds = postHookActorIds.filter((actorId) => !hookActorIds.includes(actorId));
  const hookTransitionTest = script.hook_transition_test || script.hookTransitionTest || {};
  const hookTransitionText = [
    hookTransitionTest.bridgeText,
    hookTransitionTest.first15SecCausalLink,
    hookTransitionTest.reason,
    ...postHookWindowIndexes.flatMap((index) => {
      const raw = rawSegments[index] || {};
      return [segments[index]?.voiceoverText, raw.transitionReason, raw.transition_reason];
    })
  ].map((value) => text(value).toLowerCase()).filter(Boolean).join(" ");
  const introducedActorTerms = introducedPostHookActorIds
    .flatMap((actorId) => actorTerms(actorById.get(actorId) || {}));
  const bridgeNamesIntroducedActor = !introducedPostHookActorIds.length
    || introducedActorTerms.some((term) => hookTransitionText.includes(term));
  const hookTransitionPassed = hookTransitionTest.passes === true
    && text(hookTransitionTest.first15SecCausalLink)
    && (!introducedPostHookActorIds.length
      || (hookTransitionTest.relationshipExplained === true
        && text(hookTransitionTest.bridgeText)
        && bridgeNamesIntroducedActor));
  const hookSelectionAudit = script.hook_selection_audit || script.hookSelectionAudit || {};
  const requestedHookPriority = normalizedHookPriority(hookSelectionAudit.requestedPriority);
  const configuredHookPriority = profile.independentOptions?.hookPriority || INDEPENDENT_HOOK_TYPES;
  const selectedHookType = text(hookSelectionAudit.selectedType);
  const fallbackLevel = number(hookSelectionAudit.fallbackLevel, 0);
  const rejectedHigherPriorityCandidates = Array.isArray(hookSelectionAudit.rejectedHigherPriorityCandidates)
    ? hookSelectionAudit.rejectedHigherPriorityCandidates
    : [];
  const expectedFallbackLevel = configuredHookPriority.indexOf(selectedHookType) + 1;
  const hookPriorityMatches = requestedHookPriority.join("|") === configuredHookPriority.join("|");
  const hookSelectionAuditPassed = Boolean(Object.keys(hookSelectionAudit).length)
    && hookPriorityMatches
    && INDEPENDENT_HOOK_TYPES.includes(selectedHookType)
    && fallbackLevel === expectedFallbackLevel
    && text(hookSelectionAudit.reason)
    && (fallbackLevel <= 1 || rejectedHigherPriorityCandidates.length >= fallbackLevel - 1)
    && rejectedHigherPriorityCandidates.every((item) => text(item?.reason));
  const viralMomentInventory = script.viralMomentInventory || script.viral_moment_inventory || {};
  const hookTournamentAudit = script.hookTournamentAudit || script.hook_tournament_audit || {};
  const hookReplacementAudit = script.hookReplacementAudit || script.hook_replacement_audit || {};
  const hookCandidates = Array.isArray(viralMomentInventory.hookCandidates)
    ? viralMomentInventory.hookCandidates
    : Array.isArray(viralMomentInventory.hook_candidates) ? viralMomentInventory.hook_candidates : [];
  const interactionGold = Array.isArray(viralMomentInventory.interactionGold)
    ? viralMomentInventory.interactionGold
    : Array.isArray(viralMomentInventory.interaction_gold) ? viralMomentInventory.interaction_gold : [];
  const qualifiedHookCandidates = hookCandidates.filter((candidate) => text(candidate.qualification).toLowerCase() === "pass");
  const winnerCandidateId = text(hookTournamentAudit.winnerCandidateId || hookTournamentAudit.winner_candidate_id);
  const winnerCandidate = hookCandidates.find((candidate) => text(candidate.candidateId || candidate.candidate_id) === winnerCandidateId);
  const winnerStartSec = number(winnerCandidate?.sourceStartSec ?? winnerCandidate?.source_start_sec, -1);
  const winnerEndSec = number(winnerCandidate?.sourceEndSec ?? winnerCandidate?.source_end_sec, -1);
  const firstHookStartSec = number(segments[0]?.sourceStartSec, -1);
  const firstHookEndSec = number(segments[Math.max(0, hookSequenceEndIndex)]?.sourceEndSec, -1);
  const hookWinnerRangeMatched = winnerStartSec >= 0 && winnerEndSec > winnerStartSec
    && Math.abs(firstHookStartSec - winnerStartSec) <= 0.15
    && firstHookEndSec >= winnerEndSec - 0.15;
  const first3SecEvent = text(winnerCandidate?.first3SecEvent || winnerCandidate?.first_3_sec_event);
  const drivingOnlyHook = /(?:driv|patrol car|vehicle moving|road|camera shake|walking|establishing|sirens? only|cruis)/i.test(first3SecEvent)
    && !/(?:crash|ram|hit|fight|punch|kick|gun|shot|weapon|scream|yell|argu|accus|confess|deni|lie|contradict|reveal|arrest|tackle|chase)/i.test(first3SecEvent);
  const tournamentPassed = hookCandidates.length >= 5
    && qualifiedHookCandidates.length > 0
    && Boolean(winnerCandidate)
    && hookWinnerRangeMatched
    && !drivingOnlyHook;
  const selectedEvidenceIds = new Set(segments.flatMap((segment) => (
    Array.isArray(segment.evidenceIds) ? segment.evidenceIds : [segment.evidenceId]
  )).map((value) => text(value)).filter(Boolean));
  const selectedInteractionGold = interactionGold.filter((item) => {
    const evidenceIds = Array.isArray(item.evidenceIds) ? item.evidenceIds : [item.evidenceId];
    if (evidenceIds.some((value) => selectedEvidenceIds.has(text(value)))) return true;
    const itemStart = number(item.sourceStartSec ?? item.source_start_sec, -1);
    const itemEnd = number(item.sourceEndSec ?? item.source_end_sec, -1);
    return itemStart >= 0 && itemEnd > itemStart && segments.some((segment) => (
      number(segment.sourceStartSec, -1) < itemEnd && number(segment.sourceEndSec, -1) > itemStart
    ));
  });
  const hookReplacementDelta = number(hookReplacementAudit.scoreDelta ?? hookReplacementAudit.score_delta, 0);
  const hookReplacementRequired = hookReplacementAudit.replacementRequired === true
    || hookReplacementAudit.replacement_required === true
    || hookReplacementDelta >= 1;
  const reviewDecision = text(script.reviewDecision || script.review_decision).toLowerCase();
  const actorMetadataMissing = profile.independent
    ? rawSegments.map((_segment, index) => actorIdsForSegment(index).length ? null : index).filter(Number.isInteger)
    : [];
  const actorReferenceViolations = profile.independent
    ? rawSegments.map((raw, index) => {
      const ids = actorIdsForSegment(index);
      const primary = text(raw.primary_actor_id || raw.primaryActorId || segments[index]?.primaryActorId);
      const speaker = text(raw.speaker_actor_id || raw.speakerActorId || segments[index]?.speakerActorId);
      const unknown = ids.filter((actorId) => actorIdentityMap.length && !actorById.has(actorId));
      const detached = [primary, speaker].filter((actorId) => actorId && !ids.includes(actorId));
      return unknown.length || detached.length ? { index, unknown, detached } : null;
    }).filter(Boolean)
    : [];
  const postHookBackwardJumps = [];
  const postHookUnjustifiedBackwardJumps = [];
  const postHookUnbridgedJumps = [];
  for (let index = hookSequenceEndIndex + 2; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    const previousRaw = rawSegments[index - 1] || {};
    const currentRaw = rawSegments[index] || {};
    const previousEvidence = evidenceById.get(text(previous.evidenceId)) || {};
    const currentEvidence = evidenceById.get(text(current.evidenceId)) || {};
    const previousRunId = text(previousRaw.sourceRunId || previousRaw.source_run_id || previousEvidence.sourceRunId);
    const currentRunId = text(currentRaw.sourceRunId || currentRaw.source_run_id || currentEvidence.sourceRunId);
    const sameSourceRun = Boolean(previousRunId && currentRunId && previousRunId === currentRunId);
    const sourceGapSec = number(current.sourceStartSec) - number(previous.sourceEndSec);
    const backward = number(current.sourceStartSec) < number(previous.sourceStartSec) - 0.35;
    const transitionReason = text(currentRaw.transitionReason || currentRaw.transition_reason);
    const transitionExplainedBy = text(
      currentRaw.transitionExplainedBy || currentRaw.transition_explained_by
    ).toLowerCase();
    const hasVoiceBridge = previous.audioMode !== "original_audio" || current.audioMode !== "original_audio";
    const hasExplicitExplanation = ["voiceover", "direct_dialogue", "visual_match"].includes(transitionExplainedBy);
    if (backward) {
      const item = {
        fromSegment: index,
        toSegment: index + 1,
        fromSourceStartSec: number(previous.sourceStartSec),
        toSourceStartSec: number(current.sourceStartSec),
        transitionReason,
        transitionExplainedBy,
        justified: Boolean(storyDrivenNonlinear && transitionReason && (hasVoiceBridge || hasExplicitExplanation))
      };
      postHookBackwardJumps.push(item);
      if (!item.justified) postHookUnjustifiedBackwardJumps.push(item);
    }
    const nonContiguous = !sameSourceRun && Math.abs(sourceGapSec) > 0.35;
    if (nonContiguous && !backward && (!transitionReason || (!hasVoiceBridge && !hasExplicitExplanation))) {
      postHookUnbridgedJumps.push({
        fromSegment: index,
        toSegment: index + 1,
        gapSec: Number(sourceGapSec.toFixed(3)),
        hasVoiceBridge,
        hasTransitionReason: Boolean(transitionReason),
        transitionExplainedBy
      });
    }
  }
  const phases = new Set(segments.map((segment, index) => (
    phaseOf(rawSegments[index] || {}, evidenceById.get(text(segment.evidenceId)) || {})
  )).filter(Boolean));
  const hasHook = [...phases].some((phase) => /hook/.test(phase));
  const hasEscalation = [...phases].some((phase) => /escalat|twist|conflict/.test(phase));
  const hasEnding = [...phases].some((phase) => /climax|consequence|resolution|aftermath|outro/.test(phase));
  const requiresFinalResolution = !profile.seriesMode || profile.partNumber >= 3;
  const unsafeEvidenceCount = segments.filter((segment) => {
    const evidence = evidenceById.get(text(segment.evidenceId));
    return evidence && (evidence.completeBeat === false || evidence.cutSafety === "unsafe");
  }).length;
  const transitionReasonCount = rawSegments.filter(
    (segment) => text(segment.transitionReason || segment.transition_reason)
  ).length;
  const macroBlockKeys = [];
  const missingMacroMetadataCount = rawSegments.filter((segment) => (
    !text(segment.macroBlockId || segment.macro_block_id)
    || !text(segment.storyFunction || segment.story_function)
  )).length;
  rawSegments.forEach((segment, index) => {
    const normalized = segments[index] || {};
    const evidence = evidenceById.get(text(normalized.evidenceId)) || {};
    const explicit = text(segment.macroBlockId || segment.macro_block_id);
    const sourceRunId = text(segment.sourceRunId || segment.source_run_id || evidence.sourceRunId);
    const storyFunction = phaseOf(segment, evidence);
    const key = explicit || `${sourceRunId || "unknown"}:${storyFunction || "unknown"}`;
    if (!macroBlockKeys.includes(key)) macroBlockKeys.push(key);
  });
  const macroBlockCount = macroBlockKeys.length;
  const hasStoryBlueprint = Boolean(
    script.story_blueprint?.macroBlocks?.length || script.storyBlueprint?.macroBlocks?.length
  );
  const narrativePurposes = rawSegments.map((segment, index) => (
    text(segment.narrativePurpose || segment.narrative_purpose)
      || phaseOf(segment, evidenceById.get(text(segments[index]?.evidenceId)) || {})
  ).toLowerCase());
  const findPurposeAfter = (pattern, afterIndex) => narrativePurposes.findIndex((purpose, index) => (
    index > afterIndex && pattern.test(purpose)
  ));
  const contextIndex = findPurposeAfter(/rewind_context|\bcontext\b|setup/, hookSequenceEndIndex);
  const escalationIndex = findPurposeAfter(/escalat|conflict|twist|reveal|build/, Math.max(hookSequenceEndIndex, contextIndex));
  const climaxEvidenceIndex = storySpine.climaxEvidenceIds.length
    ? segments.findIndex((segment, index) => (
      index > escalationIndex && storySpine.climaxEvidenceIds.includes(text(segment.evidenceId))
    ))
    : -1;
  const labeledClimaxIndex = findPurposeAfter(/climax_return|\bclimax\b/, Math.max(hookSequenceEndIndex, escalationIndex));
  const climaxReturnIndex = climaxEvidenceIndex >= 0 ? climaxEvidenceIndex : labeledClimaxIndex;
  const payoffEvidenceIndex = storySpine.payoffEvidenceIds.length
    ? segments.findIndex((segment, index) => (
      index > climaxReturnIndex && storySpine.payoffEvidenceIds.includes(text(segment.evidenceId))
    ))
    : -1;
  const labeledPayoffIndex = findPurposeAfter(/aftermath_payoff|payoff|consequence|resolution|aftermath|outro/, climaxReturnIndex);
  const payoffIndex = payoffEvidenceIndex >= 0 ? payoffEvidenceIndex : labeledPayoffIndex;
  const inferredFinalOutcomeEvidenceIds = profile.independent
    ? (evidencePayload?.evidence || [])
      .filter((item) => {
        const stakeRole = text(item.stakeRole || item.stake_role).toLowerCase();
        return item.mustInclude === true
          && ["legal_resolution", "suspect_resolution"].includes(stakeRole);
      })
      .map((item) => text(item.evidenceId))
      .filter(Boolean)
    : [];
  const finalOutcomeRequired = storySpine.finalOutcomeRequired
    || narrativeContract.secondaryPayoff.required
    || inferredFinalOutcomeEvidenceIds.length > 0;
  const finalOutcomeEvidenceIds = [...new Set([
    ...storySpine.finalOutcomeEvidenceIds,
    ...narrativeContract.secondaryPayoff.evidenceIds,
    ...inferredFinalOutcomeEvidenceIds
  ])];
  const finalOutcomeDeclarationComplete = !finalOutcomeRequired || (
    storySpine.finalOutcomeRequired
    && narrativeContract.secondaryPayoff.required
    && narrativeContract.secondaryPayoff.mustBeFinal
  );
  const finalOutcomeSegmentIndexes = finalOutcomeEvidenceIds
    .map((evidenceId) => segments.findIndex((segment, index) => (
      index > payoffIndex && text(segment.evidenceId) === evidenceId
    )))
    .filter((index) => index >= 0);
  const labeledFinalOutcomeIndex = findPurposeAfter(/final_outcome|legal_outcome|sentence|current_status/, payoffIndex);
  const finalOutcomeIndex = finalOutcomeSegmentIndexes.length
    ? Math.max(...finalOutcomeSegmentIndexes)
    : labeledFinalOutcomeIndex;
  const finalOutcomePassed = !finalOutcomeRequired || (
    finalOutcomeEvidenceIds.length > 0
    && finalOutcomeSegmentIndexes.length === finalOutcomeEvidenceIds.length
    && finalOutcomeIndex > payoffIndex
    && finalOutcomeIndex === segments.length - 1
  );
  const storySpineMissingFields = [
    ["centralViewerQuestion", storySpine.centralViewerQuestion],
    ["hookPromise", storySpine.hookPromise],
    ["rewindContext", storySpine.rewindContext],
    ["escalationPath", storySpine.escalationPath.length],
    ["climax", storySpine.climax],
    ["climaxEvidenceIds", storySpine.climaxEvidenceIds.length],
    ["payoff", storySpine.payoff],
    ["payoffEvidenceIds", storySpine.payoffEvidenceIds.length],
    ...(finalOutcomeRequired ? [
      ["finalOutcome", storySpine.finalOutcome],
      ["finalOutcomeEvidenceIds", storySpine.finalOutcomeEvidenceIds.length]
    ] : [])
  ].filter(([, value]) => !value).map(([field]) => field);
  const storySpineSequencePassed = contextIndex > hookSequenceEndIndex
    && escalationIndex > contextIndex
    && climaxReturnIndex > escalationIndex
    && payoffIndex > climaxReturnIndex
    && finalOutcomePassed;
  const storySpineContractAligned = (!storySpine.centralViewerQuestion || !narrativeContract.primaryAudienceQuestion
      || comparableStoryText(storySpine.centralViewerQuestion) === comparableStoryText(narrativeContract.primaryAudienceQuestion))
    && (!storySpine.hookPromise || !narrativeContract.hookPromise
      || comparableStoryText(storySpine.hookPromise) === comparableStoryText(narrativeContract.hookPromise))
    && (storySpine.finalOutcomeRequired === narrativeContract.secondaryPayoff.required)
    && finalOutcomeDeclarationComplete;
  const storySpinePassed = storySpine.present
    && !storySpineMissingFields.length
    && storySpineSequencePassed
    && storySpineContractAligned;
  const groundingFailures = [];
  const burnedTextConflicts = [];
  segments.forEach((segment, index) => {
    if (segment.audioMode === "original_audio" || !text(segment.voiceoverText)) return;
    const evidence = evidenceById.get(text(segment.evidenceId));
    if (!evidence) return;
    const grounding = measureVoiceGrounding(segment.voiceoverText, evidence);
    if (grounding.criticalUnsupported.length) {
      groundingFailures.push({
        index,
        evidenceId: segment.evidenceId,
        ratio: grounding.ratio,
        unsupported: grounding.criticalUnsupported.slice(0, 6)
      });
    }
    if (evidenceHasBurnedText(evidence) && grounding.ratio < 0.7) {
      burnedTextConflicts.push({ index, evidenceId: segment.evidenceId });
    }
  });
  const essentialEvidence = (evidencePayload?.evidence || []).filter((item) => item.mustInclude === true);
  const usedEvidenceIds = new Set(segments.map((segment) => text(segment.evidenceId)));
  const missingEssentialEvidence = essentialEvidence.filter((item) => !usedEvidenceIds.has(text(item.evidenceId)));
  const requiredResolutionIds = narrativeContract.mandatoryResolution.evidenceIds;
  const missingResolutionEvidenceIds = requiredResolutionIds.filter((evidenceId) => !usedEvidenceIds.has(evidenceId));
  const resolutionSegmentIndexes = requiredResolutionIds
    .map((evidenceId) => segments.findIndex((segment) => text(segment.evidenceId) === evidenceId))
    .filter((index) => index >= 0);
  const firstLaterOutcomeIndex = segments.findIndex((segment, index) => (
    segmentTimelinePhase(rawSegments[index] || {}, evidenceById.get(text(segment.evidenceId)) || {}) === "later_outcome"
  ));
  const resolutionBeforeLaterTimeJump = !narrativeContract.mandatoryResolution.mustAppearBeforeLaterTimeJump
    || firstLaterOutcomeIndex < 0
    || (resolutionSegmentIndexes.length === requiredResolutionIds.length
      && resolutionSegmentIndexes.every((index) => index < firstLaterOutcomeIndex));
  const stakeResolutionPassed = !narrativeContract.mandatoryResolution.required
    || (!missingResolutionEvidenceIds.length && resolutionBeforeLaterTimeJump);
  const contractPreferredVisualIds = narrativeContract.mandatoryResolution.preferredVisualEvidenceIds;
  const inferredVisualResolutionIds = (evidencePayload?.evidence || [])
    .filter((item) => {
      const modality = text(item.resolutionModality || item.resolution_modality).toLowerCase();
      const stakeRole = text(item.stakeRole || item.stake_role).toLowerCase();
      const visualScore = number(item.visualProofScore ?? item.visual_proof_score, 0);
      const resolves = text(item.resolvesQuestion || item.resolves_question).toLowerCase();
      const target = narrativeContract.primaryAudienceQuestion.toLowerCase();
      return ["visual", "mixed"].includes(modality)
        && ["victim_resolution", "hazard_resolution"].includes(stakeRole)
        && visualScore >= 7
        && (!target || !resolves || resolves === target);
    })
    .map((item) => text(item.evidenceId));
  const availableVisualResolutionIds = [...new Set([
    ...contractPreferredVisualIds,
    ...inferredVisualResolutionIds
  ])].filter((evidenceId) => evidenceById.has(evidenceId));
  const selectedVisualResolutionIds = availableVisualResolutionIds.filter((evidenceId) => usedEvidenceIds.has(evidenceId));
  const visualPayoffRequired = narrativeContract.mandatoryResolution.required
    && narrativeContract.mandatoryResolution.visualFirstRequired
    && availableVisualResolutionIds.length > 0;
  const visualPayoffPassed = !visualPayoffRequired || selectedVisualResolutionIds.length > 0;
  const resolutionMacroBlockIds = new Set(
    resolutionSegmentIndexes
      .map((index) => text(rawSegments[index]?.macroBlockId || rawSegments[index]?.macro_block_id))
      .filter(Boolean)
  );
  const adaptiveMacroBlockMax = profile.maxMacroBlocks + Math.min(2, resolutionMacroBlockIds.size || requiredResolutionIds.length);
  const structuralBridgePurposes = new Set(["stake_resolution", "time_jump", "jargon_clarity"]);
  const structuralBridgeCount = rawSegments.filter((segment, index) => (
    segments[index]?.audioMode !== "original_audio" && structuralBridgePurposes.has(segmentBridgePurpose(segment))
  )).length;
  const jargonIssues = segments.map((segment, index) => {
    const raw = rawSegments[index] || {};
    const evidence = evidenceById.get(text(segment.evidenceId)) || {};
    const containsJargon = evidence.containsUnexplainedJargon === true
      || evidence.contains_unexplained_jargon === true;
    if (!containsJargon) return null;
    const sameOrNearbyBridge = [index - 1, index, index + 1].some((candidateIndex) => {
      if (candidateIndex < 0 || candidateIndex >= segments.length) return false;
      const candidateRaw = rawSegments[candidateIndex] || {};
      const candidate = segments[candidateIndex] || {};
      return candidate.audioMode !== "original_audio"
        && segmentBridgePurpose(candidateRaw) === "jargon_clarity"
        && Boolean(text(candidateRaw.jargonExplanation || candidateRaw.jargon_explanation || candidate.voiceoverText));
    });
    if (sameOrNearbyBridge || text(raw.jargonExplanation || raw.jargon_explanation)) return null;
    return {
      index,
      evidenceId: text(segment.evidenceId),
      terms: idList(evidence.jargonTerms || evidence.jargon_terms),
      durationSec: number(segment.duration),
      lowVisualRetention: number(evidence.visualRetentionScore, number(evidence.visual_retention_score, 10)) <= 4
    };
  }).filter(Boolean);
  const jargonDeadZones = jargonIssues.filter((item) => item.lowVisualRetention && item.durationSec >= 6);
  const proceduralBloatSegments = segments.map((segment, index) => {
    const evidence = evidenceById.get(text(segment.evidenceId)) || {};
    const flagged = evidenceIsProceduralBloat(evidence);
    const retentionScore = number(evidence.retentionScore, number(evidence.retentionPotential, 0));
    if (!flagged || (retentionScore > 7 && evidence.proceduralBloat !== true)) return null;
    return {
      index,
      evidenceId: text(segment.evidenceId),
      durationSec: number(segment.duration),
      type: text(evidence.proceduralBloatType || evidence.procedural_bloat_type || "routine_administration")
    };
  }).filter((item) => item && item.durationSec >= 3);
  const payoffEvidenceIds = new Set([
    ...requiredResolutionIds,
    ...narrativeContract.secondaryPayoff.evidenceIds
  ]);
  const justifiedSourceJumps = sourceJumps.filter((jump) => {
    const targetIndex = Math.max(0, number(jump.toSegment, 1) - 1);
    const target = segments[targetIndex] || {};
    const raw = rawSegments[targetIndex] || {};
    return payoffEvidenceIds.has(text(target.evidenceId))
      || structuralBridgePurposes.has(segmentBridgePurpose(raw));
  });
  const adaptiveSourceJumpMax = profile.maxSourceJumps + Math.min(2, justifiedSourceJumps.length);
  const semanticCandidates = profile.independent && Array.isArray(script.semantic_must_include_candidates)
    ? script.semantic_must_include_candidates
    : [];
  const missingSemanticCandidates = semanticCandidates.filter((item) => (
    item?.mustInclude === true
    && !usedEvidenceIds.has(text(item.evidenceId))
    && !text(item.omissionReason)
  ));
  const speechMetadataMissing = profile.independent
    ? rawSegments.filter((segment) => {
      const hasSpeech = text(segment.caption)
        || text(segment.voiceover_text || segment.voiceoverText)
        || segment.source_narrator_detected === true;
      if (!hasSpeech) return false;
      return !text(segment.speaker_role || segment.speakerRole)
        || !text(segment.speech_type || segment.speechType);
    })
    : [];
  const narratorOriginalAudioViolations = profile.independent
    ? segments.map((segment, index) => {
      const rawSegment = rawSegments[index] || {};
      const evidence = evidenceById.get(text(segment.evidenceId)) || {};
      const speechType = text(rawSegment.speech_type || rawSegment.speechType || segment.speechType).toLowerCase();
      const narratorDetected = rawSegment.source_narrator_detected === true
        || rawSegment.sourceNarratorDetected === true
        || segment.sourceNarratorDetected === true
        || ["source_narration", "mixed_speech", "mixed_narration_dialogue"].includes(speechType)
        || evidenceHasSourceNarrator(evidence);
      return segment.audioMode === "original_audio" && narratorDetected
        ? { index, evidenceId: text(segment.evidenceId), speechType }
        : null;
    }).filter(Boolean)
    : [];
  const protectedOriginalAudioViolations = profile.independent
    ? segments.map((segment, index) => {
      const raw = rawSegments[index] || {};
      const evidence = evidenceById.get(text(segment.evidenceId)) || {};
      const protectedAudio = raw.original_audio_protected === true
        || raw.originalAudioProtected === true
        || segment.originalAudioProtected === true
        || evidence.originalAudioProtected === true
        || number(raw.original_audio_value_score ?? raw.originalAudioValueScore ?? segment.originalAudioValueScore ?? evidence.originalAudioValueScore) >= 8;
      const narratorDetected = raw.source_narrator_detected === true
        || raw.sourceNarratorDetected === true
        || evidenceHasSourceNarrator(evidence);
      return protectedAudio && segment.audioMode !== "original_audio" && !narratorDetected
        ? {
          index,
          evidenceId: text(segment.evidenceId),
          score: number(raw.original_audio_value_score ?? raw.originalAudioValueScore ?? segment.originalAudioValueScore ?? evidence.originalAudioValueScore),
          reason: text(raw.original_audio_value_reason || raw.originalAudioValueReason || segment.originalAudioValueReason || evidence.originalAudioValueReason)
        }
        : null;
    }).filter(Boolean)
    : [];
  const directDialogueVoiceoverRisks = profile.independent
    ? segments.map((segment, index) => {
      const raw = rawSegments[index] || {};
      const evidence = evidenceById.get(text(segment.evidenceId)) || {};
      const speechType = text(raw.speech_type || raw.speechType || segment.speechType).toLowerCase();
      const directDialogue = speechType === "direct_scene_dialogue"
        || evidence.sourceAudioType === "scene_dialogue";
      const narratorDetected = raw.source_narrator_detected === true || evidenceHasSourceNarrator(evidence);
      return segment.audioMode !== "original_audio" && directDialogue && !narratorDetected
        ? { index, evidenceId: text(segment.evidenceId) }
        : null;
    }).filter(Boolean)
    : [];
  const independentVoiceLanguageIssues = [];
  if (profile.independent) {
    voiceoverSegments.forEach((segment, index) => {
      const voiceText = text(segment.voiceoverText);
      if (!voiceText) return;
      const sentences = voiceText.split(/(?<=[.!?])\s+/).filter(Boolean);
      const oversized = sentences.filter((sentence) => sentence.split(/\s+/).filter(Boolean).length > 28);
      const reportLike = /\b(?:the incident|the individual|subsequently|upon arrival|law enforcement personnel|according to authorities|officially slapped with|officially charged with multiple serious felonies|an official investigation quickly linked|now faces losing (?:his|her|their) badge forever)\b/i.test(voiceText);
      if (oversized.length || reportLike) {
        independentVoiceLanguageIssues.push({ index, oversizedSentenceCount: oversized.length, reportLike });
      }
    });
  }

  if (first.audioMode !== "original_audio") {
    score -= 16;
    issues.push("Hook mở đầu không dùng âm thanh gốc.");
  }
  if (profile.independent && !hookColdViewerPassed) {
    score -= 10;
    issues.push(
      "Hook chưa qua cold-viewer gate: trong 3 giây đầu phải làm rõ ít nhất 2/3 yếu tố actor, conflict và stake, đồng thời hook_cold_viewer_test.passes=true."
    );
  } else if (profile.independent) {
    strengths.push("Hook đã qua cold-viewer comprehension gate.");
  }
  if (profile.independent && !actorIdentityMap.length) {
    issues.push("Thiếu actor_identity_map; tool chưa thể khóa danh tính và quan hệ nhân vật xuyên cảnh.");
  }
  if (profile.independent && actorMetadataMissing.length) {
    issues.push(`${actorMetadataMissing.length}/${segments.length} segment thiếu actor_ids; có nguy cơ gán hành động hoặc hậu quả cho sai người.`);
  }
  if (actorReferenceViolations.length) {
    score -= Math.min(12, actorReferenceViolations.length * 4);
    issues.push(`${actorReferenceViolations.length} segment tham chiếu actorId không nhất quán với actor_identity_map.`);
  }
  if (profile.independent && !Object.keys(hookTransitionTest).length) {
    issues.push("Thiếu hook_transition_test; chưa kiểm tra được Hook cùng 15 giây đầu sau Hook.");
  } else if (profile.independent && !hookTransitionPassed) {
    score -= 14;
    issues.push(
      `Hook Transition Gate không đạt: ${introducedPostHookActorIds.length
        ? `15 giây sau Hook đưa vào actor mới (${introducedPostHookActorIds.join(", ")}) nhưng bridge chưa xác nhận rõ danh tính/quan hệ.`
        : "chưa giải thích rõ quan hệ nguyên nhân hoặc lần reset timeline sau Hook."}`
    );
  } else if (profile.independent) {
    strengths.push("Hook và 15 giây đầu sau Hook đã qua kiểm tra danh tính, quan hệ và mạch thời gian.");
  }
  if (profile.independent && !Object.keys(hookSelectionAudit).length) {
    issues.push("Thiếu hook_selection_audit; JSON cũ vẫn được chấp nhận nhưng tool chưa xác minh được thứ tự ưu tiên Hook và lý do fallback.");
  } else if (profile.independent && !hookSelectionAuditPassed) {
    score -= 10;
    issues.push(
      `Hook Selection Audit không hợp lệ: thứ tự yêu cầu phải là ${configuredHookPriority.join(" → ")}; selectedType, fallbackLevel và lý do loại ưu tiên cao hơn phải nhất quán.`
    );
  } else if (profile.independent) {
    strengths.push(`Hook đã tuân thủ priority fallback ở mức ${fallbackLevel}: ${selectedHookType}.`);
  }
  if (profile.independent && !hookCandidates.length) {
    score -= 8;
    issues.push("Thiếu Semantic Hook Tournament; Gemini chưa chứng minh đã so sánh Hook hành động, xung đột, WTF tâm lý, rage/irony và evidence reveal trước khi dựng.");
  } else if (profile.independent && !tournamentPassed) {
    score -= drivingOnlyHook ? 18 : 12;
    issues.push(
      drivingOnlyHook
        ? `Hook bị loại bởi First-3-Second Gate: "${first3SecEvent || "không mô tả"}" chỉ là chuyển động/establishing, chưa có sự kiện viral thật.`
        : `Semantic Hook Tournament chưa đạt: cần ít nhất 5 ứng viên, một winner hợp lệ và timeline Hook phải dùng đúng nguồn của winner ${winnerCandidateId || "đã chọn"}.`
    );
  } else if (profile.independent) {
    strengths.push(`Semantic Hook Tournament đã so sánh ${hookCandidates.length} ứng viên và khóa winner ${winnerCandidateId}.`);
  }
  if (profile.independent && accessStage.includes("draft_review") && !draftCoveragePassed) {
    score -= 20;
    issues.push(
      `Draft Access Gate không đạt: Gemini khai đã review draft nhưng coverage chỉ đến ${draftCoverageEndSec.toFixed(3)}s`
      + (expectedDraftDurationSec ? ` trên ${expectedDraftDurationSec.toFixed(3)}s.` : ".")
    );
  } else if (profile.independent && accessStage.includes("draft_review")) {
    strengths.push("Draft Access Gate xác nhận Gemini đã xem đủ timeline video nháp.");
  }
  if (profile.independent && accessStage.includes("draft_review") && !hookTriggerVerified) {
    score -= 8;
    issues.push("Hook Trigger Audit chưa được xác nhận từ hook-audition clip; không thể tin mốc in-point dưới một giây.");
  }
  if (profile.independent && hookTriggerLatencySec !== null && hookTriggerLatencySec > 1.5) {
    score -= 18;
    issues.push(`Hook Trigger Gate lỗi nặng: còn ${hookTriggerLatencySec.toFixed(3)}s setup trước sự kiện viral thật; cần trim/rebuild Hook.`);
  } else if (profile.independent && hookTriggerLatencySec !== null && hookTriggerLatencySec > 0.5) {
    score -= 10;
    issues.push(`Hook Trigger Gate cảnh báo: còn ${hookTriggerLatencySec.toFixed(3)}s setup trước trigger, vượt mức 0.5s.`);
  } else if (profile.independent && hookTriggerLatencySec !== null) {
    strengths.push(`Hook Trigger latency ${hookTriggerLatencySec.toFixed(3)}s đạt yêu cầu.`);
  }
  if (profile.independent && !teaserClimaxHandoffPassed) {
    score -= 12;
    issues.push(
      `Teaser-Climax Handoff chưa đạt: overlap ${hookClimaxOverlapSec.toFixed(3)}s`
      + (semanticRepriseDeclared && reprisePolicy !== "continue_after_teaser"
        ? " và cùng sự kiện nhưng chưa khai báo continue_after_teaser."
        : ` vượt mức replay ${allowedHookReplaySec.toFixed(3)}s.`)
    );
  }
  if (profile.independent && interactionGold.length && !selectedInteractionGold.length) {
    score -= 8;
    issues.push(`${interactionGold.length} interactionGold đã được phát hiện nhưng timeline bỏ qua toàn bộ câu thoại mỉa mai, mâu thuẫn hoặc rage-bait có giá trị.`);
  } else if (profile.independent && selectedInteractionGold.length) {
    strengths.push(`Timeline giữ ${selectedInteractionGold.length} interactionGold có giá trị tương tác.`);
  }
  if (profile.independent && Object.keys(hookReplacementAudit).length && hookReplacementRequired && reviewDecision !== "rebuild") {
    score -= 15;
    issues.push(`Hook Replacement Gate yêu cầu dựng lại vì Hook nguồn mạnh hơn V1 ${hookReplacementDelta.toFixed(1)} điểm, nhưng reviewDecision chưa đặt thành rebuild.`);
  }
  if (profile.independent && sourceNarratorPolicy !== "forbidden") {
    score -= 6;
    issues.push('Kịch bản độc lập thiếu source_narrator_policy="forbidden"; không thể khóa chính sách loại narrator nguồn.');
  }
  if (hasMeasuredHookScore && hookScore < 7.5) {
    score -= 12;
    issues.push(`Hook chỉ đạt ${hookScore.toFixed(1)}/10 theo evidence; nên chọn khoảnh khắc mạnh hơn.`);
  } else if (hasMeasuredHookScore) {
    strengths.push(`Hook evidence ${hookScore.toFixed(1)}/10.`);
  }
  const allowedHookMaxSec = profile.independent ? profile.hookMaxSec : 30;
  if (hookDuration < 3 || hookDuration > allowedHookMaxSec + 0.05) {
    score -= 7;
    issues.push(`Hook dài ${hookDuration.toFixed(1)}s; cấu hình hiện tại cho phép khoảng 3-${allowedHookMaxSec}s cho một Hook hoàn chỉnh.`);
  }
  if (profile.seriesMode && profile.sharedHookEnabled && (hookDuration < 5 || hookDuration > 30.05)) {
    score -= 6;
    issues.push(`Cold Open dùng chung dài ${hookDuration.toFixed(1)}s; profile Series cho phép complete beat thuần âm gốc 5-30s và phải cắt trước khi narrator nguồn bắt đầu.`);
  }
  if (!monetizationEligible) {
    score -= 30;
    issues.push(
      `Tổng thời lượng ${duration.toFixed(1)}s dưới mức an toàn 60.5s; variant không đạt điều kiện thời lượng kiếm tiền TikTok.`
    );
  } else if (duration < profile.minDuration) {
    score -= 9;
    issues.push(
      `Tổng thời lượng ${duration.toFixed(1)}s thấp hơn vùng ưu tiên ${profile.minDuration}-${profile.maxDuration}s của Script ${profile.scriptId}.`
    );
  } else if (duration > profile.maxDuration) {
    score -= 7;
    issues.push(
      `Tổng thời lượng ${duration.toFixed(1)}s vượt vùng ưu tiên ${profile.minDuration}-${profile.maxDuration}s của Script ${profile.scriptId}.`
    );
  }
  if (riskyShortFragments.length > Math.max(1, Math.floor(segments.length * 0.2))) {
    score -= 12;
    issues.push(`${riskyShortFragments.length}/${segments.length} cảnh ngắn dưới 4s không có microCutPurpose hợp lệ, video có nguy cơ bị băm vụn.`);
  } else if (purposefulMicroCuts.length) {
    strengths.push(`${purposefulMicroCuts.length} micro-cut ngắn có mục đích dựng rõ ràng.`);
  }
  if (sourceJumpCount > adaptiveSourceJumpMax) {
    if (!profile.independent) score -= Math.min(28, (sourceJumpCount - adaptiveSourceJumpMax) * 6);
    issues.push(
      profile.independent
        ? `Tham chiếu dựng: có ${sourceJumpCount} lần nhảy xa trên timeline nguồn, cao hơn mức thường dùng ${adaptiveSourceJumpMax}. Chỉ cần sửa khi các jump không phục vụ Story Spine hoặc gây khó hiểu.`
        : `Có ${sourceJumpCount} lần nhảy xa trên timeline nguồn, vượt ngân sách thích ứng ${adaptiveSourceJumpMax} của Script ${profile.scriptId}.`
    );
  } else if (justifiedSourceJumps.length) {
    strengths.push(`${justifiedSourceJumps.length} lần nhảy nguồn được chấp nhận vì đóng payoff hoặc làm cầu nối cấu trúc bắt buộc.`);
  }
  if (profile.independent && postHookUnjustifiedBackwardJumps.length) {
    score -= Math.min(24, postHookUnjustifiedBackwardJumps.length * 12);
    issues.push(
      `${postHookUnjustifiedBackwardJumps.length} lần nhảy ngược timeline chưa có transitionReason/cơ chế giải thích phù hợp với Story Spine.`
    );
  } else if (storyDrivenNonlinear && postHookBackwardJumps.length) {
    strengths.push(`${postHookBackwardJumps.length} lần đảo timeline có cầu nối và mục đích Story Spine rõ ràng.`);
  }
  if (profile.independent && postHookUnbridgedJumps.length) {
    score -= Math.min(18, postHookUnbridgedJumps.length * 6);
    issues.push(
      `${postHookUnbridgedJumps.length} lần nhảy nguồn sau Hook chưa có voice bridge và transitionReason đầy đủ; người xem có thể mất mạch nguyên nhân-kết quả.`
    );
  }
  if (profile.independent && unresolvedTransitionCount) {
    const notAlreadyCounted = Math.max(0, unresolvedTransitionCount - postHookUnbridgedJumps.length);
    score -= Math.min(12, notAlreadyCounted * 5);
    issues.push(
      `Transition Coverage Gate: ${unresolvedTransitionCount}/${requiredTransitionCount} ranh giới nhảy nguồn chưa được giải thích bằng voiceover, direct dialogue hoặc visual anchor có bằng chứng.`
    );
  } else if (profile.independent && requiredTransitionCount) {
    strengths.push(`Transition Coverage đạt 100% cho ${requiredTransitionCount} ranh giới cần giải thích.`);
  }
  if (continuityRatio >= 0.5) {
    strengths.push(`${Math.round(continuityRatio * 100)}% chuyển cảnh bám vùng nguồn liền kề.`);
  }
  if (longVoiceovers.length) {
    score -= Math.min(12, longVoiceovers.length * 4);
    issues.push(
      `${longVoiceovers.length} đoạn voiceover dài hơn ${profile.maxVoiceoverSec}s của Script ${profile.scriptId}, dễ làm nhịp kể đều và che hành động thật.`
    );
  }
  if (genZVoiceTexts.length) {
    const forbiddenFormalWords = [
      "erratic", "inexplicably", "ironclad", "unprovoked assault", "devastating charges", "altercation"
    ];
    const usedFormalWords = forbiddenFormalWords.filter((term) => (
      genZVoiceTexts.some((voiceText) => voiceText.toLowerCase().includes(term))
    ));
    if (usedFormalWords.length) {
      issues.push(`Cảnh báo Gen Z: voiceover còn dùng từ trang trọng bị cấm: ${usedFormalWords.join(", ")}.`);
    }
    const firstVoice = genZVoiceTexts[0].toLowerCase();
    const hasCuriosityGap = /\?|wait until|but (?:here(?:'s| is)|why|what)|the audacity|makes? (?:zero|no) sense|you won't believe|how (?:did|could)|why (?:did|would)/i.test(firstVoice);
    if (!hasCuriosityGap) {
      issues.push("Cảnh báo Gen Z: câu voiceover đầu tiên chưa tạo curiosity gap rõ ràng.");
    }
    const reportLikeCount = genZVoiceTexts.filter((voiceText) => (
      /\b(?:the incident|the individual|subsequently|upon arrival|law enforcement personnel|according to authorities)\b/i.test(voiceText)
    )).length;
    if (reportLikeCount) {
      issues.push(`Cảnh báo Gen Z: ${reportLikeCount} đoạn voiceover vẫn mang giọng báo cáo/công vụ; nên viết lại tự nhiên hơn.`);
    }
  }
  const adaptiveVoiceoverMax = profile.scriptId === 1
    ? 3 + Math.min(1, structuralBridgeCount)
    : profile.scriptId === 4
    ? 4 + Math.min(1, structuralBridgeCount)
    : Infinity;
  if (profile.scriptId === 4 && !profile.seriesMode && (voiceoverSegments.length < 3 || voiceoverSegments.length > adaptiveVoiceoverMax)) {
    issues.push(`Tham chiếu dựng: Script 4 có ${voiceoverSegments.length} đoạn voiceover. Không cần đổi số lượng nếu mọi đoạn đều phục vụ Story Spine và không che âm gốc giá trị.`);
  }
  if (profile.scriptId === 1 && !profile.seriesMode && (voiceoverSegments.length < 2 || voiceoverSegments.length > adaptiveVoiceoverMax)) {
    if (voiceoverSegments.length < 2) {
      score -= 18;
      issues.push(
        `Narrator Presence Gate: Script 1 chỉ có ${voiceoverSegments.length} đoạn voiceover; profile Narrated Raw Reality cần ít nhất 2 nhịp narrator ngắn, không liền nhau, gồm rewind/context hoặc causal bridge trước Climax và một nhịp escalation/stake-resolution/Payoff. Một câu kết án duy nhất ở cuối không hợp lệ.`
      );
    } else {
      issues.push(`Tham chiếu dựng: Script 1 có ${voiceoverSegments.length} đoạn voiceover; hãy giữ 2-4 nhịp ngắn có vai trò riêng, không thêm filler để đạt quota.`);
    }
  } else if (profile.scriptId === 1 && !profile.seriesMode) {
    strengths.push(`Script 1 có ${voiceoverSegments.length} đoạn narrator ngắn đúng profile.`);
  }
  if (profile.policeBlotter && voiceoverSegments.length !== 4) {
    score -= 12;
    issues.push(`Viral Police Blotter có ${voiceoverSegments.length}/4 khối narrator bắt buộc.`);
  }
  if (oversizedSeriesRuns.length) {
    score -= Math.min(15, oversizedSeriesRuns.length * 5);
    issues.push(
      `${oversizedSeriesRuns.length} nhịp audio liên tục vượt ${seriesRunLimit}s của profile ${profile.label}; hãy xen kẽ ở ranh giới câu/beat hoàn chỉnh.`
    );
  } else if (profile.seriesMode && profile.interleavedAudioEnabled && audioRuns.length >= 4) {
    strengths.push(`Nhịp Voiceover / Âm gốc được xen kẽ thành ${audioRuns.length} khối.`);
  }
  if (protectedActionRuns.length) {
    strengths.push(`${protectedActionRuns.length} action sequence được giữ nguyên, không bị giới hạn bởi Audio Sandwich.`);
  }
  if (protectedSustainedBeatRuns.length) {
    strengths.push(`${protectedSustainedBeatRuns.length} complete narrative beat được giữ nguyên, không bị giới hạn bởi Audio Sandwich.`);
  }
  if (missingEssentialEvidence.length) {
    score -= Math.min(30, 12 + (missingEssentialEvidence.length - 1) * 4);
    issues.push(
      `Kịch bản bỏ sót ${missingEssentialEvidence.length} evidence hành động mustInclude: ${missingEssentialEvidence.slice(0, 8).map((item) => item.evidenceId).join(", ")}.`
    );
  }
  if (profile.independent && !semanticCandidates.length) {
    score -= 5;
    issues.push("Kịch bản độc lập thiếu semantic_must_include_candidates; chưa chứng minh đã quét confession, contradiction, evidence reveal và consequence trước khi chọn cảnh.");
  }
  if (missingSemanticCandidates.length) {
    score -= Math.min(20, missingSemanticCandidates.length * 10);
    issues.push(
      `Kịch bản bỏ sót ${missingSemanticCandidates.length} semantic payoff bắt buộc mà không nêu omissionReason: `
      + missingSemanticCandidates.slice(0, 8).map((item) => text(item.evidenceId) || "unknown").join(", ")
      + "."
    );
  }
  if (speechMetadataMissing.length) {
    score -= Math.min(12, speechMetadataMissing.length * 3);
    issues.push(`${speechMetadataMissing.length} segment có lời nói nhưng thiếu speaker_role hoặc speech_type; có nguy cơ lẫn narrator nguồn và gán sai người nói.`);
  }
  if (narratorOriginalAudioViolations.length) {
    score -= Math.min(30, 18 + (narratorOriginalAudioViolations.length - 1) * 6);
    issues.push(
      `${narratorOriginalAudioViolations.length} đoạn original_audio còn giao với narrator nguồn: `
      + narratorOriginalAudioViolations.map((item) => `cảnh ${item.index + 1} (${item.evidenceId || "không có evidenceId"})`).join(", ")
      + ". Phải chọn đoạn sạch hoặc chuyển đúng khoảng đó sang voiceover_only và mute nguồn hoàn toàn."
    );
  }
  if (protectedOriginalAudioViolations.length) {
    score -= Math.min(24, protectedOriginalAudioViolations.length * 12);
    issues.push(
      `${protectedOriginalAudioViolations.length} đoạn voiceover đang thay thế lời thoại/âm thanh gốc đã được đánh dấu giá trị cao: `
      + protectedOriginalAudioViolations.map((item) => `cảnh ${item.index + 1}${item.reason ? ` (${item.reason})` : ""}`).join("; ")
      + ". Hãy trả lại original_audio hoặc chọn một hình bridge khác."
    );
  }
  const unprotectedDialogueRisks = directDialogueVoiceoverRisks.filter((risk) => (
    !protectedOriginalAudioViolations.some((item) => item.index === risk.index)
  ));
  if (unprotectedDialogueRisks.length) {
    score -= Math.min(8, unprotectedDialogueRisks.length * 2);
    issues.push(`${unprotectedDialogueRisks.length} đoạn voiceover đang mute direct scene dialogue; cần xác nhận lời gốc không có giá trị kể chuyện trước khi giữ lựa chọn này.`);
  }
  if (independentVoiceLanguageIssues.length) {
    score -= Math.min(12, independentVoiceLanguageIssues.length * 4);
    issues.push(`${independentVoiceLanguageIssues.length} đoạn voiceover độc lập còn câu quá dài hoặc mang giọng báo cáo; cần rút thành spoken American English tự nhiên.`);
  }
  if (estimatedVoiceTimingRisks.length) {
    issues.push(
      `Voice budget cảnh báo: ${estimatedVoiceTimingRisks.map((item) => (
        `cảnh ${item.index + 1}${item.segmentId ? ` (${item.segmentId})` : ""} `
        + `ước tính ${item.estimatedVoiceSec.toFixed(1)}s/${item.plannedDurationSec.toFixed(1)}s (${item.estimatedFitRatio.toFixed(2)}x)`
      )).join("; ")}. Render vẫn được phép, nhưng hình sẽ phải kéo chậm mạnh; hãy rút text hoặc mở rộng source range.`
    );
  }
  if (macroBlockCount > adaptiveMacroBlockMax) {
    if (!profile.independent) score -= Math.min(24, (macroBlockCount - adaptiveMacroBlockMax) * 5);
    issues.push(
      profile.independent
        ? `Tham chiếu dựng: có ${macroBlockCount} macro-block, cao hơn mức thường dùng ${adaptiveMacroBlockMax}. Chỉ cần gộp khi block không phục vụ Story Spine hoặc làm câu chuyện vụn.`
        : `Có ${macroBlockCount} macro-block, vượt ngân sách thích ứng ${adaptiveMacroBlockMax}; kịch bản có nguy cơ thành montage vụn.`
    );
  } else if (macroBlockCount >= 3) {
    strengths.push(`${macroBlockCount} macro-block nằm trong profile Script ${profile.scriptId}.`);
  }
  if (!hasStoryBlueprint) {
    score -= 10;
    issues.push("Thiếu story_blueprint; chưa chứng minh kịch bản được lập theo câu chuyện trước khi chọn cảnh.");
  }
  if (profile.independent && !storySpine.present) {
    score -= 25;
    issues.push("Thiếu story_blueprint.storySpine; chưa khóa Central Viewer Question, Hook Promise, Climax và Payoff trước khi chọn cảnh.");
  } else if (profile.independent && storySpineMissingFields.length) {
    score -= Math.min(24, storySpineMissingFields.length * 4);
    issues.push(`Story Spine thiếu trường bắt buộc: ${storySpineMissingFields.join(", ")}.`);
  }
  if (profile.independent && storySpine.present && !storySpineContractAligned) {
    score -= 8;
    issues.push("Story Spine và Narrative Contract đang mở hai câu hỏi/Hook Promise khác nhau; video có nguy cơ đổi câu chuyện giữa chừng.");
  }
  if (profile.independent && storySpine.present && !storySpineSequencePassed) {
    score -= 24;
    issues.push("Story Spine chưa được thực thi đúng thứ tự: Climax teaser → Rewind/Context → Escalation → trở lại Climax → Aftermath/Payoff.");
  } else if (profile.independent && storySpinePassed) {
    strengths.push("Story Spine đã khóa một câu hỏi trung tâm và quay lại đúng Climax/Payoff đã hứa.");
  }
  if (profile.independent && finalOutcomeRequired && !finalOutcomePassed) {
    score -= 24;
    issues.push(
      `Final Outcome Gate không đạt: video chưa kết thúc bằng kết quả cuối đã xác minh (${finalOutcomeEvidenceIds.join(", ") || "thiếu evidenceId"}); không được dừng ở lời bào chữa/phỏng vấn trước kết án hoặc current status.`
    );
  } else if (profile.independent && finalOutcomeRequired) {
    strengths.push("Video kết thúc bằng final outcome đã xác minh sau primary payoff.");
  }
  if (profile.independent && inferredFinalOutcomeEvidenceIds.length && !finalOutcomeDeclarationComplete) {
    score -= 12;
    issues.push(
      `Evidence đã khóa có kết quả cuối bắt buộc (${inferredFinalOutcomeEvidenceIds.join(", ")}) nhưng Story Spine/Narrative Contract chưa khai báo finalOutcomeRequired + secondaryPayoff.required/mustBeFinal.`
    );
  }
  if (profile.independent && !narrativeContract.present) {
    issues.push("Thiếu narrative_contract; JSON cũ vẫn được import nhưng tool chưa thể xác minh Hook có trả đúng payoff đã hứa hay không.");
  } else if (profile.independent && narrativeContract.mandatoryResolution.required && !stakeResolutionPassed) {
    score -= 24;
    if (missingResolutionEvidenceIds.length) {
      issues.push(
        `Narrative Contract chưa đóng: thiếu payoff evidence ${missingResolutionEvidenceIds.join(", ")} cho câu hỏi "${narrativeContract.primaryAudienceQuestion || "(trống)"}".`
      );
    }
    if (!resolutionBeforeLaterTimeJump) {
      issues.push("Narrative Contract sai thứ tự: video đã nhảy sang hậu quả về sau trước khi giải quyết nguy cơ/nạn nhân mà Hook mở ra.");
    }
  } else if (profile.independent && narrativeContract.mandatoryResolution.required) {
    strengths.push("Hook promise và payoff bắt buộc đã khép kín đúng thứ tự.");
  }
  if (profile.independent && visualPayoffRequired && !visualPayoffPassed) {
    score -= 20;
    issues.push(
      `Visual Payoff Gate không đạt: kịch bản dùng xác nhận bằng lời nhưng bỏ qua bằng chứng hình ảnh mạnh hơn (${availableVisualResolutionIds.join(", ")}).`
    );
  } else if (profile.independent && visualPayoffRequired) {
    strengths.push(`Visual payoff đã dùng bằng chứng ưu tiên: ${selectedVisualResolutionIds.join(", ")}.`);
  }
  if (proceduralBloatSegments.length) {
    score -= Math.min(24, proceduralBloatSegments.reduce((sum, item) => (
      sum + (item.durationSec >= 8 ? 10 : 6)
    ), 0));
    issues.push(
      `${proceduralBloatSegments.length} đoạn thủ tục hành chính tạo retention dead zone: `
      + proceduralBloatSegments.map((item) => `cảnh ${item.index + 1} (${item.type}, ${item.durationSec.toFixed(1)}s)`).join("; ")
      + ". Hãy thay bằng hành động, xung đột hoặc visual payoff đã khóa."
    );
  }
  if (jargonIssues.length) {
    score -= Math.min(14, jargonIssues.length * 5 + jargonDeadZones.length * 3);
    issues.push(
      `${jargonIssues.length} đoạn chứa mã radio/thuật ngữ khó hiểu nhưng chưa có bridge jargon_clarity.`
      + (jargonDeadZones.length ? ` ${jargonDeadZones.length} đoạn đồng thời có hình yếu và kéo dài, tạo dead zone.` : "")
    );
  }
  if (missingMacroMetadataCount) {
    score -= Math.min(15, missingMacroMetadataCount * 3);
    issues.push(
      `${missingMacroMetadataCount}/${segments.length} segment thiếu macroBlockId hoặc storyFunction; không thể xác minh đầy đủ cấu trúc story-first.`
    );
  }
  if (!hasHook || !hasEscalation || (requiresFinalResolution && !hasEnding)) {
    score -= 10;
    issues.push(requiresFinalResolution
      ? "Nhãn mạch truyện chưa thể hiện đủ Hook → Escalation → Climax/Consequence."
      : "Part 1-2 chưa thể hiện đủ Hook → Escalation/Cliffhanger mà không tiết lộ resolution.");
  } else {
    strengths.push(requiresFinalResolution
      ? "Có đủ các nhịp Hook, Escalation và kết quả."
      : "Có đủ Hook và Escalation/Cliffhanger cho Part chưa được phép tiết lộ resolution.");
  }
  if (unsafeEvidenceCount) {
    score -= Math.min(15, unsafeEvidenceCount * 5);
    issues.push(`${unsafeEvidenceCount} cảnh dùng evidence chưa trọn beat hoặc điểm cắt chưa an toàn.`);
  }
  if (evidencePayload && transitionReasonCount < Math.max(0, segments.length - 1)) {
    score -= 6;
    issues.push("Gemini chưa giải thích đầy đủ lý do nối từng cảnh; continuity cần được xem lại thủ công.");
  }
  if (groundingFailures.length) {
    score -= Math.min(28, groundingFailures.length * 14);
    issues.push(
      `${groundingFailures.length} đoạn voiceover chứa claim không được evidence hỗ trợ: `
      + groundingFailures.map((item) => (
        `cảnh ${item.index + 1} (${item.evidenceId}, từ nghi vấn: ${item.unsupported.join(", ")})`
      )).join("; ")
      + "."
    );
  }
  if (burnedTextConflicts.length) {
    score -= Math.min(18, burnedTextConflicts.length * 9);
    issues.push(
      `${burnedTextConflicts.length} cảnh voiceover dùng hình có chữ burn sẵn nhưng nội dung không khớp voice mới.`
    );
  }
  if (sourceAudioOnly && originalAudioRatio < 0.99) {
    score -= 20;
    issues.push("Variant source-audio-only vẫn chứa đoạn voiceover.");
  }
  if (!sourceAudioOnly && originalAudioRatio < 0.35) {
    if (!profile.independent) score -= 8;
    issues.push(`Âm thanh gốc chỉ chiếm ${Math.round(originalAudioRatio * 100)}%; video có thể thiếu cảm giác chân thực.`);
  } else if (originalAudioRatio >= 0.55) {
    strengths.push(`Âm thanh gốc chiếm ${Math.round(originalAudioRatio * 100)}%.`);
  }

  const previousSegments = Array.isArray(previousNormalizedScript?.segments)
    ? previousNormalizedScript.segments
    : [];
  const previousSignatures = new Set(previousSegments.map(segmentSignature));
  const currentSignatures = segments.map(segmentSignature);
  const unchangedSegmentCount = currentSignatures.filter((signature) => previousSignatures.has(signature)).length;
  const structuralSimilarity = previousSegments.length && segments.length
    ? unchangedSegmentCount / Math.max(previousSegments.length, segments.length)
    : 0;
  const previousStakeFailed = previousPreflight?.metrics?.stakeResolutionPassed === false
    || (previousPreflight?.issues || []).some((issue) => /Narrative Contract|payoff evidence|nguy cơ\/nạn nhân/i.test(text(issue)));
  const previousEditorialFailed = number(previousPreflight?.scoreBreakdown?.editorialReadiness?.score, 100) < 72;
  const structuralRebuildRequired = Boolean(previousSegments.length && (previousStakeFailed || previousEditorialFailed));
  const structuralRebuildPassed = !structuralRebuildRequired
    || (structuralSimilarity < 0.75 && (!previousStakeFailed || stakeResolutionPassed));
  if (!structuralRebuildPassed) {
    score -= 12;
    issues.push(
      `V2 vẫn giữ ${Math.round(structuralSimilarity * 100)}% cấu trúc V1 dù V1 chưa qua gate nội dung; Gemini cần dựng lại thứ tự/cảnh, không chỉ sửa câu chữ.`
    );
  } else if (structuralRebuildRequired) {
    strengths.push(`V2 đã thay đổi cấu trúc đủ lớn so với V1 (${Math.round((1 - structuralSimilarity) * 100)}%).`);
  }

  score = Math.round(clamp(score, 0, 100));
  const grade = score >= 85 ? "A" : score >= 72 ? "B" : score >= 58 ? "C" : "D";
  const technicalIssues = [];
  let technicalScore = 100;
  if (!monetizationEligible) {
    technicalScore -= 35;
    technicalIssues.push("Output duration is below the 60.5 second monetization floor.");
  }
  if (narratorOriginalAudioViolations.length) {
    technicalScore -= Math.min(30, narratorOriginalAudioViolations.length * 10);
    technicalIssues.push("Original-audio ranges still overlap detected source narrator speech.");
  }
  if (speechMetadataMissing.length) {
    technicalScore -= Math.min(15, speechMetadataMissing.length * 3);
    technicalIssues.push("Spoken ranges are missing speaker/source-audio classification.");
  }
  if (actorReferenceViolations.length) {
    technicalScore -= Math.min(20, actorReferenceViolations.length * 5);
    technicalIssues.push("One or more segments reference inconsistent actor identities.");
  }
  if (unsafeEvidenceCount) {
    technicalScore -= Math.min(20, unsafeEvidenceCount * 5);
    technicalIssues.push("One or more source trims are not verified as safe complete beats.");
  }
  if (estimatedVoiceTimingRisks.length) {
    technicalScore -= Math.min(25, estimatedVoiceTimingRisks.length * 8);
    technicalIssues.push("One or more voiceover blocks exceed the learned voice budget and would require excessive visual slowdown.");
  }
  const editorialIssues = [];
  let editorialScore = 100;
  if (profile.independent && profile.scriptId === 1 && !profile.seriesMode && voiceoverSegments.length < 2) {
    editorialScore -= 25;
    editorialIssues.push("Script 1 collapses the narrator-led profile into original audio with only one or zero tool-narration beats.");
  }
  if (hasMeasuredHookScore && hookScore < 7.5) {
    editorialScore -= 20;
    editorialIssues.push("The selected Hook is weak according to the locked source evidence.");
  }
  if (profile.independent && hookCandidates.length && !tournamentPassed) {
    editorialScore -= drivingOnlyHook ? 30 : 20;
    editorialIssues.push("The Hook did not win a valid semantic tournament or fails the first-three-second event gate.");
  }
  if (profile.independent && interactionGold.length && !selectedInteractionGold.length) {
    editorialScore -= 15;
    editorialIssues.push("The timeline omits every verified rage, irony, contradiction, or standout interaction discovered before assembly.");
  }
  if (profile.independent && Object.keys(hookReplacementAudit).length && hookReplacementRequired && reviewDecision !== "rebuild") {
    editorialScore -= 25;
    editorialIssues.push("The reviewer found a materially stronger source Hook but did not rebuild V1 around it.");
  }
  if (riskyShortFragments.length > Math.max(1, Math.floor(segments.length * 0.2))) {
    editorialScore -= 18;
    editorialIssues.push("Too many isolated short fragments make the story feel chopped up.");
  }
  if (profile.independent && voiceoverSegments.length && (!narrationBeats.length || missingNarrationBeatRefs.length)) {
    editorialScore -= 12;
    editorialIssues.push("The narrator-led edit has no complete narration_arc or contains voiceover segments detached from it.");
    issues.push(`Narration arc chưa đầy đủ: ${missingNarrationBeatRefs.length}/${voiceoverSegments.length} đoạn voice chưa tham chiếu narrationBeatId hợp lệ.`);
  }
  if (!profile.independent && sourceJumpCount > adaptiveSourceJumpMax) {
    editorialScore -= Math.min(24, (sourceJumpCount - adaptiveSourceJumpMax) * 6);
    editorialIssues.push("The edit makes too many major source-timeline jumps.");
  }
  if (!hasStoryBlueprint) {
    editorialScore -= 15;
    editorialIssues.push("The script has no explicit causal story blueprint.");
  }
  if (profile.independent && !storySpinePassed) {
    editorialScore -= 35;
    editorialIssues.push("The edit does not prove one complete Story Spine from central viewer question through promised climax and payoff.");
  }
  if (profile.independent && finalOutcomeRequired && !finalOutcomePassed) {
    editorialScore -= 30;
    editorialIssues.push("The edit ends before the verified final legal/current-status outcome required by its own Story Spine.");
  }
  if (profile.independent && Object.keys(hookTransitionTest).length && !hookTransitionPassed) {
    editorialScore -= 25;
    editorialIssues.push("The Hook and first 15 post-Hook seconds fail actor/relationship/chronology continuity.");
  }
  if (protectedOriginalAudioViolations.length) {
    editorialScore -= Math.min(24, protectedOriginalAudioViolations.length * 12);
    editorialIssues.push("Tool narration replaces authentic source audio that carries indispensable story value.");
  }
  if (missingEssentialEvidence.length || missingSemanticCandidates.length) {
    editorialScore -= Math.min(30, (missingEssentialEvidence.length + missingSemanticCandidates.length) * 8);
    editorialIssues.push("The script omits verified action or semantic payoff candidates.");
  }
  if (narrativeContract.mandatoryResolution.required && !stakeResolutionPassed) {
    editorialScore -= 30;
    editorialIssues.push("The Hook's primary stake is not resolved before the later outcome.");
  }
  if (visualPayoffRequired && !visualPayoffPassed) {
    editorialScore -= 25;
    editorialIssues.push("The edit substitutes verbal confirmation for stronger available visual payoff evidence.");
  }
  if (proceduralBloatSegments.length) {
    editorialScore -= Math.min(24, proceduralBloatSegments.length * 10);
    editorialIssues.push("Routine police administration creates a short-form retention dead zone.");
  }
  if (jargonIssues.length) {
    editorialScore -= Math.min(18, jargonIssues.length * 6);
    editorialIssues.push("Selected source audio contains unexplained jargon or a low-value jargon dead zone.");
  }
  if (!structuralRebuildPassed) {
    editorialScore -= 18;
    editorialIssues.push("V2 preserves a failed V1 structure instead of rebuilding the story.");
  }
  technicalScore = Math.round(clamp(technicalScore, 0, 100));
  editorialScore = Math.round(clamp(editorialScore, 0, 100));
  return {
    score,
    grade,
    passed: score >= 72 && monetizationEligible,
    scoreBreakdown: {
      technicalReadiness: {
        score: technicalScore,
        passed: technicalScore >= 80,
        issues: technicalIssues
      },
      editorialReadiness: {
        score: editorialScore,
        passed: editorialScore >= 72,
        issues: editorialIssues,
        note: "Editorial readiness is a heuristic warning, not a guarantee of virality."
      }
    },
    issues,
    strengths,
    diagnostics: {
      sourceJumps,
      shortFragments: shortFragments.map((segment) => ({
        segment: number(segment.index, segments.indexOf(segment)) + 1,
        durationSec: number(segment.duration),
        evidenceId: text(segment.evidenceId)
      })),
      purposefulMicroCuts: purposefulMicroCuts.map((segment) => ({
        segment: number(segment.index, segments.indexOf(segment)) + 1,
        durationSec: number(segment.duration),
        evidenceId: text(segment.evidenceId),
        microCutPurpose: text(rawSegments[segments.indexOf(segment)]?.microCutPurpose || rawSegments[segments.indexOf(segment)]?.micro_cut_purpose)
      })),
      riskyShortFragments: riskyShortFragments.map((segment) => ({
        segment: number(segment.index, segments.indexOf(segment)) + 1,
        durationSec: number(segment.duration),
        evidenceId: text(segment.evidenceId)
      })),
      longVoiceovers: longVoiceovers.map((segment) => ({
        segment: number(segment.index, segments.indexOf(segment)) + 1,
        durationSec: number(segment.duration),
        evidenceId: text(segment.evidenceId)
      })),
      groundingFailures: groundingFailures.map((item) => ({
        segment: item.index + 1,
        evidenceId: item.evidenceId,
        groundingRatio: Number(item.ratio.toFixed(3)),
        unsupportedClaims: item.unsupported
      })),
      burnedTextConflicts: burnedTextConflicts.map((item) => ({
        segment: item.index + 1,
        evidenceId: item.evidenceId
      })),
      missingSemanticCandidates: missingSemanticCandidates.map((item) => ({
        evidenceId: text(item.evidenceId),
        semanticType: text(item.semanticType),
        exactQuoteOrFact: text(item.exactQuoteOrFact)
      })),
      speechMetadataMissingCount: speechMetadataMissing.length,
      independentVoiceLanguageIssues,
      estimatedVoiceTimingRisks,
      narratorOriginalAudioViolations,
      actorReferenceViolations,
      actorMetadataMissingSegments: actorMetadataMissing.map((index) => index + 1),
      hookTransition: {
        passed: Boolean(hookTransitionPassed),
        hookActorIds,
        postHookActorIds,
        introducedPostHookActorIds,
        bridgeNamesIntroducedActor,
        checkedWindowSec: Number(postHookWindowSec.toFixed(3))
      },
      semanticHookTournament: {
        passed: tournamentPassed,
        candidateCount: hookCandidates.length,
        qualifiedCandidateCount: qualifiedHookCandidates.length,
        winnerCandidateId,
        winnerRangeMatched: hookWinnerRangeMatched,
        first3SecEvent,
        drivingOnlyHook
      },
      viralMomentInventory: {
        interactionGoldCount: interactionGold.length,
        selectedInteractionGoldCount: selectedInteractionGold.length
      },
      hookReplacement: {
        audited: Boolean(Object.keys(hookReplacementAudit).length),
        scoreDelta: Number(hookReplacementDelta.toFixed(3)),
        replacementRequired: hookReplacementRequired,
        reviewDecision
      },
      inputAccess: {
        stage: accessStage,
        draftCoveragePassed,
        draftCoverageEndSec: Number(draftCoverageEndSec.toFixed(3)),
        expectedDraftDurationSec: Number(expectedDraftDurationSec.toFixed(3))
      },
      hookTrigger: {
        verifiedAgainstHookAuditClip: hookTriggerVerified,
        triggerSourceSec: Number.isFinite(hookTriggerSourceSec) ? Number(hookTriggerSourceSec.toFixed(3)) : null,
        latencySec: hookTriggerLatencySec === null ? null : Number(hookTriggerLatencySec.toFixed(3))
      },
      teaserClimaxHandoff: {
        overlapSec: Number(hookClimaxOverlapSec.toFixed(3)),
        allowedReplaySec: Number(allowedHookReplaySec.toFixed(3)),
        semanticRepriseDeclared,
        reprisePolicy,
        passed: teaserClimaxHandoffPassed
      },
      transitionCoverage: {
        requiredBoundaryCount: requiredTransitionCount,
        unresolvedBoundaryCount: unresolvedTransitionCount,
        coverageRatio: Number(transitionCoverageRatio.toFixed(3))
      },
      protectedOriginalAudioViolations,
      directDialogueVoiceoverRisks,
      postHookBackwardJumps,
      postHookUnjustifiedBackwardJumps,
      postHookUnbridgedJumps,
      narrativeContract,
      missingResolutionEvidenceIds,
      resolutionSegmentIndexes: resolutionSegmentIndexes.map((index) => index + 1),
      firstLaterOutcomeSegment: firstLaterOutcomeIndex >= 0 ? firstLaterOutcomeIndex + 1 : null,
      jargonIssues: jargonIssues.map((item) => ({ ...item, index: item.index + 1 })),
      proceduralBloatSegments: proceduralBloatSegments.map((item) => ({ ...item, index: item.index + 1 })),
      visualPayoff: {
        required: visualPayoffRequired,
        passed: visualPayoffPassed,
        availableEvidenceIds: availableVisualResolutionIds,
        selectedEvidenceIds: selectedVisualResolutionIds
      },
      justifiedSourceJumps,
      structuralComparison: {
        required: structuralRebuildRequired,
        passed: structuralRebuildPassed,
        similarity: Number(structuralSimilarity.toFixed(3)),
        unchangedSegmentCount
      },
      storySpine: {
        ...storySpine,
        passed: storySpinePassed,
        missingFields: storySpineMissingFields,
        contractAligned: storySpineContractAligned,
        sequencePassed: storySpineSequencePassed,
        finalOutcomeRequired,
        finalOutcomePassed,
        finalOutcomeDeclarationComplete,
        finalOutcomeEvidenceIds,
        inferredFinalOutcomeEvidenceIds,
        finalOutcomeSegmentIndexes: finalOutcomeSegmentIndexes.map((index) => index + 1),
        indexes: {
          hookEnd: hookSequenceEndIndex + 1,
          context: contextIndex >= 0 ? contextIndex + 1 : null,
          escalation: escalationIndex >= 0 ? escalationIndex + 1 : null,
          climaxReturn: climaxReturnIndex >= 0 ? climaxReturnIndex + 1 : null,
          payoff: payoffIndex >= 0 ? payoffIndex + 1 : null,
          finalOutcome: finalOutcomeIndex >= 0 ? finalOutcomeIndex + 1 : null
        }
      }
    },
    metrics: {
      durationSec: Number(duration.toFixed(3)),
      monetizationEligible,
      durationWithinProfile,
      scriptId: profile.scriptId,
      profile: profile.label,
      timelinePolicy,
      storyDrivenNonlinear,
      seriesMode: profile.seriesMode,
      partNumber: profile.partNumber || 0,
      seriesPacing: profile.pacing || "",
      hookDurationSec: Number(hookDuration.toFixed(3)),
      hookPriority: profile.independent ? configuredHookPriority : [],
      hookSelectedType: profile.independent ? selectedHookType : "",
      hookFallbackLevel: profile.independent ? fallbackLevel : 0,
      hookSelectionAuditPassed: profile.independent ? hookSelectionAuditPassed : null,
      hookTournamentPassed: profile.independent ? tournamentPassed : null,
      hookTournamentCandidateCount: profile.independent ? hookCandidates.length : 0,
      draftAccessCoveragePassed: profile.independent && accessStage.includes("draft_review") ? draftCoveragePassed : null,
      hookTriggerVerified: profile.independent ? hookTriggerVerified : null,
      hookTriggerLatencySec: hookTriggerLatencySec === null ? null : Number(hookTriggerLatencySec.toFixed(3)),
      hookClimaxOverlapSec: Number(hookClimaxOverlapSec.toFixed(3)),
      teaserClimaxHandoffPassed: profile.independent ? teaserClimaxHandoffPassed : null,
      requiredTransitionCount,
      unresolvedTransitionCount,
      transitionCoverageRatio: Number(transitionCoverageRatio.toFixed(3)),
      selectedInteractionGoldCount: profile.independent ? selectedInteractionGold.length : 0,
      hookScore: hasMeasuredHookScore ? Number(hookScore.toFixed(2)) : null,
      hookScoreMeasured: hasMeasuredHookScore,
      originalAudioRatio: Number(originalAudioRatio.toFixed(3)),
      voiceoverDurationSec: Number(voiceoverDuration.toFixed(3)),
      voiceoverSegmentCount: voiceoverSegments.length,
      sourceJumpCount,
      adaptiveSourceJumpMax,
      justifiedSourceJumpCount: justifiedSourceJumps.length,
      macroBlockCount,
      adaptiveMacroBlockMax,
      hasStoryBlueprint,
      missingMacroMetadataCount,
      continuityRatio: Number(continuityRatio.toFixed(3)),
      shortFragmentCount: shortFragments.length,
      purposefulMicroCutCount: purposefulMicroCuts.length,
      riskyShortFragmentCount: riskyShortFragments.length,
      longVoiceoverCount: longVoiceovers.length,
      oversizedSeriesAudioRunCount: oversizedSeriesRuns.length,
      unsafeEvidenceCount,
      groundingFailureCount: groundingFailures.length,
      burnedTextConflictCount: burnedTextConflicts.length,
      essentialActionEvidenceCount: essentialEvidence.length,
      missingEssentialActionEvidenceCount: missingEssentialEvidence.length,
      semanticCandidateCount: semanticCandidates.length,
      missingSemanticCandidateCount: missingSemanticCandidates.length,
      speechMetadataMissingCount: speechMetadataMissing.length,
      independentVoiceLanguageIssueCount: independentVoiceLanguageIssues.length,
      voiceProfileWordsPerSecond: voiceProfileWordsPerSecond > 0 ? Number(voiceProfileWordsPerSecond.toFixed(3)) : null,
      estimatedVoiceTimingRiskCount: estimatedVoiceTimingRisks.length,
      sourceNarratorPolicy,
      narratorOriginalAudioViolationCount: narratorOriginalAudioViolations.length,
      actorIdentityCount: actorIdentityMap.length,
      actorMetadataMissingCount: actorMetadataMissing.length,
      actorReferenceViolationCount: actorReferenceViolations.length,
      hookColdViewerPassed,
      hookColdViewerSignalCount: hookColdViewerSignals,
      hookSequenceSegmentCount: hookSequenceEndIndex + 1,
      hookTransitionPassed: Boolean(hookTransitionPassed),
      hookTransitionIntroducedActorCount: introducedPostHookActorIds.length,
      protectedOriginalAudioViolationCount: protectedOriginalAudioViolations.length,
      directDialogueVoiceoverRiskCount: directDialogueVoiceoverRisks.length,
      postHookBackwardJumpCount: postHookBackwardJumps.length,
      postHookUnjustifiedBackwardJumpCount: postHookUnjustifiedBackwardJumps.length,
      postHookUnbridgedJumpCount: postHookUnbridgedJumps.length,
      narrationArcBeatCount: narrationBeats.length,
      missingNarrationBeatRefCount: missingNarrationBeatRefs.length,
      protectedActionRunCount: protectedActionRuns.length,
      protectedSustainedBeatRunCount: protectedSustainedBeatRuns.length,
      narrativeContractPresent: narrativeContract.present,
      storySpinePresent: storySpine.present,
      storySpinePassed,
      finalOutcomeRequired,
      finalOutcomePassed,
      finalOutcomeDeclarationComplete,
      stakeResolutionRequired: narrativeContract.mandatoryResolution.required,
      stakeResolutionPassed,
      missingResolutionEvidenceCount: missingResolutionEvidenceIds.length,
      resolutionBeforeLaterTimeJump,
      jargonIssueCount: jargonIssues.length,
      jargonDeadZoneCount: jargonDeadZones.length,
      proceduralBloatSegmentCount: proceduralBloatSegments.length,
      visualPayoffRequired,
      visualPayoffPassed,
      availableVisualResolutionCount: availableVisualResolutionIds.length,
      selectedVisualResolutionCount: selectedVisualResolutionIds.length,
      structuralBridgeCount,
      structuralRebuildRequired,
      structuralRebuildPassed,
      structuralSimilarity: Number(structuralSimilarity.toFixed(3))
    }
  };
}

function rankManualGeminiVariants(variants = []) {
  return [...variants]
    .sort((left, right) => number(right?.viralPreflight?.score) - number(left?.viralPreflight?.score))
    .map((variant, index) => ({ ...variant, viralRank: index + 1 }));
}

module.exports = {
  evidenceHasBurnedText,
  measureVoiceGrounding,
  rankManualGeminiVariants,
  resolveScriptProfile,
  scoreManualGeminiVariant
};
