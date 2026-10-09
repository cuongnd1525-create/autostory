"use strict";

/**
 * Story-first editorial contracts for True Crime Series V1.
 *
 * This service is deterministic and source-grounded: it never generates new
 * factual events or quoted dialogue. Gemini is the creative writer; the host
 * builds the evidence plan and audits its script before anything is rendered.
 */
const fs = require("fs/promises");
const path = require("path");

const compact = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const num = (value, fallback = NaN) => value === "" || value === null || value === undefined
  ? fallback : (Number.isFinite(Number(value)) ? Number(value) : fallback);
const range = (item) => {
  const start = num(item?.sourceStartSec ?? item?.startSec);
  const end = num(item?.sourceEndSec ?? item?.endSec);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
};
const overlaps = (left, right) => Boolean(left && right && Math.min(left.end, right.end) > Math.max(left.start, right.start));
const unique = (values) => [...new Set(values.filter(Boolean))];
const readJson = async (file) => {
  if (!file) return null;
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (_error) { return null; }
};

const EVENT_ROLES = [
  [/dispatch|arrival|call|report|crash|traffic_stop/, "setup"],
  [/refus|denial|conflict|confront|argument|resist/, "conflict"],
  [/evidence|discover|contradict|confess|admission|search|reveal/, "reveal"],
  [/escalat|fight|struggle|pursuit|chase|violence/, "escalation"],
  [/climax|takedown|restrain/, "climax"],
  [/arrest|charge|consequence|resolution|verdict|sentenc|transport/, "consequence"]
];
function storyRole(item) {
  const subject = `${compact(item.eventType)} ${compact(item.summary)}`.toLowerCase();
  return EVENT_ROLES.find(([re]) => re.test(subject))?.[1] || "development";
}

/** Keep an evidence reference even when the understanding uses eventId rather than evidenceId. */
function makeStoryIntelligence(understanding = {}, { hookContract = null, sourceDurationSec = 0 } = {}) {
  const timeline = Array.isArray(understanding.storyTimeline) ? understanding.storyTimeline : [];
  const events = timeline.map((event, index) => {
    const originalRange = range(event);
    if (!originalRange) return null;
    const visualFacts = (Array.isArray(event.visualFacts) ? event.visualFacts : []).map(compact).filter(Boolean);
    const dialogueFacts = (Array.isArray(event.dialogueFacts) ? event.dialogueFacts : [])
      .map((item) => ({ speaker: compact(item.speaker), quote: compact(item.quote), sourceSec: num(item.sourceSec, null) }))
      .filter((item) => item.quote);
    return {
      eventId: compact(event.eventId) || `event_${String(index + 1).padStart(4, "0")}`,
      sourceStartSec: originalRange.start,
      sourceEndSec: originalRange.end,
      storyRole: storyRole(event),
      summary: compact(event.summary),
      visualFacts,
      dialogueFacts,
      storyImportance: num(event.storyImportance ?? event.importance, 0),
      verifiedFrom: "source_understanding"
    };
  }).filter(Boolean).sort((a, b) => a.sourceStartSec - b.sourceStartSec);
  const anchor = hookContract?.variants?.variant_01?.anchorRange || hookContract?.anchorRange || null;
  const hookRange = range(anchor);
  const hookCandidates = (Array.isArray(understanding.hookCandidates) ? understanding.hookCandidates : []).map((candidate) => ({
    eventId: compact(candidate.eventId),
    sourceStartSec: num(candidate.sourceStartSec, null),
    sourceEndSec: num(candidate.sourceEndSec, null),
    reason: compact(candidate.why)
  }));
  return {
    artifactType: "story_intelligence",
    schemaVersion: 1,
    sourceDurationSec: num(sourceDurationSec || understanding.videoDurationSec, 0),
    caseSummary: compact(understanding.caseSummary),
    centralConflict: compact(understanding.centralConflict),
    centralViewerQuestion: compact(understanding.centralViewerQuestion),
    characters: Array.isArray(understanding.characters) ? understanding.characters : [],
    events,
    hookCandidates,
    selectedHookRange: hookRange ? { sourceStartSec: hookRange.start, sourceEndSec: hookRange.end } : null,
    factsPolicy: "Only confirmed visual/source dialogue evidence is factual. A person's statement is a claim, not a verified truth. Never invent motives, charges, or outcomes.",
    qualityWarnings: [
      ...(!events.length ? ["Source Understanding has no events with usable source ranges."] : []),
      ...(!compact(understanding.centralConflict) ? ["Missing explicit centralConflict."] : []),
      ...(!compact(understanding.centralViewerQuestion) ? ["Missing explicit centralViewerQuestion."] : [])
    ]
  };
}

/**
 * Story-aware second-round hook ranking AFTER Phase A has watched the source.
 * Candidate windows are sourced from the precomputed hook audition; no new
 * footage, quote or payoff may be invented here.
 * Scores are planning heuristics, NOT measured audience retention.
 */
function makeHookTournament(intelligence = {}, { hookCandidates = null, hookContract = null } = {}) {
  const raw = Array.isArray(hookCandidates?.topCandidates) ? hookCandidates.topCandidates : [];
  const words = (str) => new Set(compact(str).toLowerCase().split(/[^a-z0-9]+/).filter((w) =>
    w.length > 3 && !new Set(["with", "from", "that", "were", "this", "into", "they", "them", "what", "when"]).has(w)
  ));
  const conflictTerms = words(`${intelligence.centralConflict} ${intelligence.centralViewerQuestion}`);
  const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0));
  const overlapCount = (one, another) => [...one].filter((w) => another.has(w)).length;
  const candidates = raw.map((candidate, index) => {
    const selectedRange = range(candidate.anchorRange || candidate);
    if (!selectedRange || !Number.isFinite(intelligence.sourceDurationSec)
      || selectedRange.end > intelligence.sourceDurationSec + 1) return null;
    const sourceEvent = (intelligence.events || []).find((event) => overlaps(selectedRange, range(event))) || null;
    const eventTerms = words(`${sourceEvent?.summary || ""} ${sourceEvent?.visualFacts?.join(" ") || ""} ${candidate.coreEventDescription || ""}`);
    const storyRelevance = sourceEvent
      ? clamp(45 + 35 * Math.min(1, overlapCount(eventTerms, conflictTerms) / Math.max(1, conflictTerms.size * 0.3))
        + 20 * Math.min(1, num(sourceEvent.storyImportance, 0) / 100))
      : 25;
    const s = candidate.scores || {};
    const visual = clamp(s.visual_immediacy ?? 50);
    const curiosity = clamp(s.curiosity_gap ?? 50);
    const clarity = clamp(((Number(s.dialogue_strength) || 50) + (Number(s.conflict) || 50)) / 2);
    const payoffEvents = (intelligence.events || [])
      .filter((e) => e.sourceStartSec > selectedRange.end + 0.5
        && ["reveal", "escalation", "climax", "consequence"].includes(e.storyRole));
    const payoff = clamp((payoffEvents.length ? 50 : 15) + Math.min(50, Number(s.payoff_potential) || 0) * 0.5);
    const spoiler = clamp(s.spoiler_risk ?? 0)
      + (sourceEvent?.storyRole === "consequence" ? 25 : 0);
    const score = clamp(0.20 * visual + 0.25 * curiosity + 0.25 * storyRelevance
      + 0.15 * clarity + 0.15 * payoff - 0.20 * Math.min(100, spoiler));
    return {
      candidateId: compact(candidate.hookId || candidate.candidateId) || `hook_${index + 1}`,
      sourceStartSec: selectedRange.start,
      sourceEndSec: selectedRange.end,
      sourceEventId: sourceEvent?.eventId || null,
      candidateTitle: compact(candidate.title),
      triggerQuote: compact(candidate.keyDialogue),
      scores: { overall: Math.round(score), visual: Math.round(visual), curiosity: Math.round(curiosity),
        storyRelevance: Math.round(storyRelevance), clarity: Math.round(clarity), payoff: Math.round(payoff), spoiler: Math.round(spoiler) },
      payoffEventIds: payoffEvents.slice(0, 4).map((e) => e.eventId),
      bridgeRequired: Boolean(sourceEvent && (intelligence.events || []).some((event) => event.sourceEndSec < sourceEvent.sourceStartSec - 15)),
      qualityCaveat: !sourceEvent ? "Candidate has no overlapping verified Story Timeline event; review before selecting." : "",
      provisional: hookContract?.isUserLocked !== true
    };
  }).filter(Boolean).sort((a, b) => b.scores.overall - a.scores.overall);
  const lockedRange = range(hookContract?.variants?.variant_01?.anchorRange || hookContract?.anchorRange);
  const lockedCandidate = lockedRange && candidates.find((item) =>
    overlaps(range(item), lockedRange)
  );
  return {
    artifactType: "story_hook_tournament", schemaVersion: 1,
    assessmentKind: "source_grounded_editorial_heuristic_not_audience_metric",
    userLocked: hookContract?.isUserLocked === true,
    lockedRange: lockedRange ? { sourceStartSec: lockedRange.start, sourceEndSec: lockedRange.end } : null,
    originalAutoCandidateId: compact(hookCandidates?.defaultRecommendedHook?.hookId || hookCandidates?.defaultRecommendedHook?.candidateId),
    recommendedCandidateId: hookContract?.isUserLocked === true
      ? (lockedCandidate?.candidateId || "USER_LOCKED_HOOK")
      : (candidates[0]?.candidateId || null),
    candidates,
    selectionRule: hookContract?.isUserLocked === true
      ? "Must use the user-locked hook; only trim within allowed tolerance."
      : "Compare top candidates with entire source and 15-second post-hook handoff; prefer the strongest REAL hook with later payoff, not the loudest action. Gemini may reject the heuristic top pick if other grounded evidence is stronger.",
    insufficientCoverage: candidates.length === 0
  };
}

function makeNarrativeBlueprint(intelligence, { seriesPlan = null, series = null } = {}) {
  const parts = (series?.parts || []).map((definition) => {
    const locked = (seriesPlan?.parts || []).find((item) => num(item.scriptId, -1) === num(definition.scriptId, -2)) || {};
    const allowed = (Array.isArray(locked.sceneAllocation) ? locked.sceneAllocation : []).map(range).filter(Boolean);
    const selectedEvents = intelligence.events.filter((event) => allowed.some((item) => overlaps(range(event), item)));
    const hook = range(locked.hookRange || intelligence.selectedHookRange || {});
    const plannedEvents = selectedEvents.map((event, index) => ({
      beatId: `part${definition.partNumber}_beat${String(index + 1).padStart(3, "0")}`,
      eventId: event.eventId,
      storyFunction: event.storyRole,
      sourceStartSec: event.sourceStartSec,
      sourceEndSec: event.sourceEndSec,
      newInformation: event.summary,
      narrativePurpose: index === 0 ? "Establish where and why the story starts" : "Show a verifiable change since the preceding beat",
      sourceGrounding: [event.eventId]
    }));
    return {
      scriptId: definition.scriptId,
      partNumber: definition.partNumber,
      name: definition.name,
      chapterRole: definition.scope,
      storyQuestion: compact(seriesPlan?.centralViewerQuestion || intelligence.centralViewerQuestion),
      hookPromise: compact(seriesPlan?.hookPromise),
      hookRange: hook ? { sourceStartSec: hook.start, sourceEndSec: hook.end } : null,
      sceneAllocation: locked.sceneAllocation || [],
      hookHandoff: locked.hookHandoff || null,
      causalProgression: Array.isArray(locked.causalProgression) ? locked.causalProgression : [],
      plannedNarratorArc: Array.isArray(locked.narratorArc) ? locked.narratorArc : [],
      engagementIntent: locked.engagementIntent || null,
      endingType: definition.ending,
      expectedEnding: compact(definition.ending === "payoff" ? locked.payoff : locked.cliffhanger),
      endingRange: definition.ending === "payoff" ? (locked.payoffRanges || []) : (locked.cliffhangerRange || null),
      prohibitedReveals: locked.mustNotReveal || [],
      plannedEvents,
      narratorInstructions: {
        purpose: "Bridge gaps in time, place, causality and meaning; never voice what is already obvious.",
        jobs: ["context", "bridge", "escalation", "reinterpretation", "anticipation", "payoff"],
        handoff: "Lead into authentic meaningful original dialogue/action and yield the audio stage to that footage.",
        minimumMeaningfulBridges: 1,
        style: "Natural US conversational true-crime storytelling. Concise, source-grounded, no repetitive clickbait or administrative report prose.",
        prohibited: ["unverified charges or motives", "repeating the same event", "fake stakes", "Follow for Part 2 instead of an actual cliffhanger"]
      }
    };
  });
  return {
    artifactType: "narrative_blueprint",
    schemaVersion: 1,
    primaryQuestion: compact(seriesPlan?.centralViewerQuestion || intelligence.centralViewerQuestion),
    centralConflict: intelligence.centralConflict,
    caseSummary: intelligence.caseSummary,
    storyEvents: intelligence.events,
    seriesParts: parts,
    editorialPolicy: "Story before footage. Every major jump needs an intelligible bridge; every hook promise needs verified later evidence. End Part 1/2 with a meaningful development, not a bare call-to-follow.",
    engagementPolicy: "Invite reflection only if verified events naturally raise a relevant question. Never force outrage, likes or comments."
  };
}

const PURE_ACTION_NARRATION = /^(?:the|a|an|then|now|here|you can see|we can see|as you can see)\s+(?:officer|police|suspect|driver|man|woman|person|he|she|they|we|the officer|the driver|the man)\s+(?:is |are |starts? |begins? |goes? |walks? |runs? |says? |tells? |looks? |gets? |approaches? |moves? )/i;
const GENERIC_NARRATION = /\b(?:what happens next|you won't believe|things took a shocking turn|little did (?:they|he|she) know|stay tuned for part|follow for part)\b/i;
const FACTUAL_ANCHOR_WORDS = /\b(?:earlier|later|minutes?|hours?|because|but|instead|after|before|meanwhile|however|revealed|discovered|found|reported|according|while|until|despite|when|why|evidence|claim|contradict|investigat|realiz|question)\b/i;
function scriptSegments(script) {
  return Array.isArray(script?.segments) ? script.segments : Array.isArray(script?.narrativeBeats) ? script.narrativeBeats : [];
}
function extractVoice(segment) {
  return compact(segment?.voiceover_text ?? segment?.voiceoverText ?? segment?.narration ?? "");
}
function extractMode(segment) {
  return compact(segment?.audio_mode ?? segment?.audioMode).toLowerCase();
}
function bridgeTextAt(segments, index) {
  return [segments[index - 1], segments[index]].filter(Boolean).map((item) => [
    extractVoice(item), compact(item.transitionReason || item.transition_reason),
    compact(item.bridgePurpose || item.bridge_purpose)
  ].join(" ")).join(" ");
}
function evaluateEditorialScript(script = {}, blueprint = {}, { minScore = 80, strict = true } = {}) {
  const errors = [], warnings = [], feedback = [];
  const segments = scriptSegments(script);
  const part = (blueprint.seriesParts || []).find((p) => Number(p.scriptId) === Number(script.scriptId));
  const addError = (code, message, index = -1) => { errors.push({ code, message, segmentIndex: index }); };
  if (!part) addError("missing_part", "No locked Narrative Blueprint for this script.");
  if (!segments.length) addError("empty_script", "Script must contain at least one source segment.");
  const voices = [];
  let originalAudioCount = 0;
  let unbridgedJumps = 0;
  let previousRange = null;
  const sceneRange = (part?.sceneAllocation || []).map(range).filter(Boolean);
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const sourceRange = range(segment);
    if (!sourceRange) { addError("invalid_source_range", "Missing/invalid source range.", i); continue; }
    const inLockedRange = [...sceneRange, range(part?.hookRange), ...(Array.isArray(part?.endingRange) ? part.endingRange.map(range) : [range(part?.endingRange)])]
      .filter(Boolean).some((allowed) => sourceRange.end > allowed.start - 2 && sourceRange.start < allowed.end + 2);
    if (part && !inLockedRange) addError("outside_series_plan", "Segment is outside the locked Part allocation.", i);
    const voice = extractVoice(segment);
    const audioMode = extractMode(segment);
    if (audioMode === "original_audio") originalAudioCount++;
    if (voice) {
      voices.push({ index: i, text: voice });
      if (audioMode === "original_audio") addError("voice_over_original_audio", "Narrator text cannot replace protected original audio implicitly.", i);
      if (PURE_ACTION_NARRATION.test(voice) && !FACTUAL_ANCHOR_WORDS.test(voice)) {
        addError("descriptive_voice", "Narrator merely describes visible action; add verified context, meaning, causal connection, or remove the narration.", i);
      }
      if (GENERIC_NARRATION.test(voice)) addError("generic_clickbait", "Remove generic clickbait/forced Part CTA.", i);
      if (voice.split(/\s+/).length > 36) warnings.push({ code: "long_voice", index: i, message: "Narrator sentence/block may be too long for a natural delivery." });
    }
    // Transition metadata is invisible to a viewer. Require an actual
    // spoken temporal cue (or an explicitly rendered supported time card).
    // A 'transitionReason: earlier' string alone cannot justify the edit.
    const transitionSpoken = [segments[i - 1], segment, segments[i + 1]]
      .filter(Boolean).map((entry) => extractVoice(entry)).join(" ");
    const renderedTimeCard = compact(segment.onScreenTimeCard || segment.renderedTimeCard);
    if (previousRange && sourceRange.start < previousRange.start - 15) {
      if (!/earlier|before|rewind|flashback|back to|previously|hours? ago|minutes? ago|trước đó|quay lại/i.test(transitionSpoken + " " + renderedTimeCard)) {
        unbridgedJumps++;
        addError("unbridged_flashback",
          "Major rewind lacks an AUDIBLE narrator cue or explicitly rendered time card; transitionReason metadata alone does not count.", i);
      }
    }
    if (previousRange && sourceRange.start > previousRange.end + 90) {
      if (!transitionSpoken.trim() && !renderedTimeCard) {
        addError("unbridged_forward_jump",
          "Major forward jump lacks spoken time/causal orientation; hidden JSON metadata is not enough.", i);
      }
    }
    previousRange = sourceRange;
  }
  if (part && segments.length > 0 && num(part.partNumber) === 1) {
    const firstRange = range(segments[0]), hook = range(part.hookRange);
    if (hook && firstRange && !overlaps(firstRange, hook)) addError("hook_misaligned", "Part 1 must start on the locked hook source range.", 0);
    if (firstRange && firstRange.end - firstRange.start > 12) {
      addError("oversized_opening_hook", "The initial bodycam hold exceeds 12 seconds without an editorial handoff; extract the trigger and move promptly to verified context.", 0);
    }
    if (extractMode(segments[0]) !== "original_audio") warnings.push({ code: "hook_muted", index: 0, message: "Consider retaining compelling authentic hook audio." });
  }
  if (part && voices.length < 2) addError("narrator_not_directing", "Narration requires at least two meaningful bridge/interpretation beats; footage-only summary fails the narrator-led series profile.");
  const normalizedNarrations = voices.map((v) => v.text.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim());
  for (let i = 1; i < normalizedNarrations.length; i++) {
    if (normalizedNarrations[i].length > 12 && normalizedNarrations[i] === normalizedNarrations[i - 1]) {
      addError("repeated_narration", "Identical narrator lines repeat without new information.", voices[i].index);
    }
  }
  const meaningful = voices.filter((v) => v.text.split(/\s+/).length >= 4 && FACTUAL_ANCHOR_WORDS.test(v.text));
  if (part && voices.length && !meaningful.length) addError("empty_narrative_function", "Narrator has no evident contextual/causal contribution.");
  if (part && originalAudioCount === 0) addError("no_original_evidence", "No original bodycam/dialogue/action audio to demonstrate the narrator's claims.");
  if (part && !compact(part.expectedEnding)) addError("missing_locked_ending", "Locked Part has no source-grounded payoff/cliffhanger.");
  if (part && segments.length) {
    const endingRanges = (Array.isArray(part.endingRange) ? part.endingRange : [part.endingRange]).map(range).filter(Boolean);
    const endingFootagePresent = endingRanges.length > 0 && segments.slice(-2).some((item) =>
      endingRanges.some((ending) => overlaps(range(item), ending))
    );
    if (endingRanges.length && !endingFootagePresent) {
      addError("missing_ending_footage", `The final two beats omit the locked ${part.endingType}; a call-to-follow cannot substitute for the promised cliffhanger/payoff.`, segments.length - 1);
    }
  }
  if (voices.length > 0 && originalAudioCount === 0) warnings.push({ code: "over_narrated", message: "No handoff from narrator to authentic source evidence." });
  const baseScore = 100;
  const score = Math.max(0, baseScore - errors.length * 14 - warnings.length * 5);
  if (score < minScore) feedback.push(`Editorial score ${score}/100 is below ${minScore}/100.`);
  feedback.push(...errors.map((item) => `${item.code}: ${item.message} (segment ${item.segmentIndex + 1})`));
  feedback.push(...warnings.map((item) => `${item.code}: ${item.message} (segment ${(item.index ?? -1) + 1})`));
  return {
    scriptId: num(script.scriptId, 0), score, passed: Boolean(!errors.length && score >= minScore),
    status: !strict ? "report_only" : (!errors.length && score >= minScore ? "accepted" : "rejected"),
    errors, warnings, feedback,
    metrics: { segmentCount: segments.length, narrationBeats: voices.length, originalAudioBeats: originalAudioCount, unbridgedJumps }
  };
}

function buildPhaseBEditorialGuidance({ intelligencePath, blueprintPath }) {
  return [
    "STORY-FIRST EDITORIAL DIRECTIVE (APPLIES TO EVERY TRUE-CRIME SERIES PART):",
    `- STORY_INTELLIGENCE (source evidence, characters and causal anchors): ${intelligencePath}`,
    `- NARRATIVE_BLUEPRINT (Part-specific contracts, ending and narration direction): ${blueprintPath}`,
    "- Open BOTH JSON files with view_file before producing any script; treat their event source ranges as evidence, never fabricated dialogue.",
    "- For each Part, first establish an intelligible emotional and causal story spine. The actual cold-open Hook should create one grounded question; the next ~15s must clearly connect that Hook to characters, time and context.",
    "- Follow per-Part causalProgression, hookHandoff and plannedNarratorArc from the locked Series Plan. These specify why the next event matters and where voice must bridge or yield to original dialogue.",
    "- Write narrator text as a storyteller, not as a visual describer or police report. Each narration sentence must ADD verified background, explain a chronological/causal jump, reinterpret evidence, or set up the next authentic beat.",
    "- Interleave narrator with authentic original_audio. Never bury the crucial officer/suspect quote, scream, impact or reveal beneath voiceover; hand back to live audio promptly.",
    "- At least two purposeful narrator beats per Part unless user explicitly selected source-audio-only mode. Do NOT hit a narration quota with filler.",
    "- Every backward source jump greater than ~15 seconds MUST be anchored by ACTUALLY SPOKEN rewind/earlier narration or a time title which WILL BE RENDERED. A transitionReason hidden in JSON does not count. Explain character changes and spatial jumps.",
    "- In a multipart True Crime cold open, do not hold the opening source beat for more than about 8s without new information. Hard limit 12s unless source dialogue is both exceptional and absolutely indispensable.",
    "- Include an explicit per-Part story_blueprint and narration_arc with grounded narrator functions, evidence anchors, source time ranges and actual performed transitions. These fields must agree with the locked narrative-blueprint.json and the rendered segment list; metadata is not a substitute for a spoken bridge.",
    "- Each new beat must have a narrative function and information gain. Discard procedural bloat and repeated facts, but keep subtle consequential reactions and essential context.",
    "- Respect all source-grounded hook promises, scene allocations, Part boundaries and spoiler restrictions. End Part 1/2 on a verified consequential unanswered question, not 'follow for part 2'.",
    "- Conversation-friendly natural US English; short sentences, varied rhythm, no 'what happened next' filler, never fake conclusions/charges/motives.",
    "- Every output must include audio_mode, sourceStartSec/sourceEndSec, voiceover_text, transitionReason, and storyFunction for each segment. The host will reject structurally weak results.",
    "- Write a single full artifact response, not an outline. Check story continuity and narrator handoffs before responding."
  ].join("\n");
}


const CRITICAL_AUDIENCE_CODES = new Set(["hook_not_clear", "hook_handoff", "temporal_confusion",
  "causal_gap", "narrator_repeats_visual", "narrator_missing_bridge",
  "dead_zone", "missing_payoff", "false_claim", "wrong_actor", "missing_evidence"]);

/**
 * An independently prompted critic does not receive the Writer's self-reported
 * scores or the structural-gate score. It reviews only source-backed scripts.
 * This is still an AI opinion, not observed watch-time or true MP4 review.
 */
function buildColdViewerPrompt({ scriptPaths = [], blueprintPath = "", intelligencePath = "", scriptIds = [] } = {}) {
  return [
    "You are an INDEPENDENT COLD VIEWER / TRUE-CRIME EDITOR, not the script writer.",
    "Evaluate the exact order and spoken words in each proposed edit as if you have NEVER seen the case.",
    "TEXT INPUTS ONLY: do not open video files. Read these script files using view_file:",
    ...scriptPaths.map((p) => `- ${p}`),
    `Evidence-backed source understanding: ${intelligencePath}`,
    `Locked Part story plan: ${blueprintPath}`,
    "Do not read previous Editorial Gate scores, Writer rationale or earlier AI review reports.",
    "First identify a specific curiosity question the opening creates and whether the NEXT 15 seconds orient viewers to the characters, location, cause and time jump.",
    "Audit each bridge with the exact SPOKEN narrator text and the source event it connects. A transitionReason metadata string that is NOT narrated or rendered as a title does not orient the audience.",
    "Audit the middle for stretches of routine dialogue or footage that make no meaningful narrative progress. A quiet meaningful reaction is NOT dead air.",
    "Audit whether the ending VISIBLY/AUDIBLY delivers the locked cliffhanger/payoff, not just the word cliffhanger, a static label or Follow for Part 2.",
    "Do not use missing facts or invent legal charges, motives, timecode, dialogue or a person. Treat unverified claims by characters as claims, not proven truth.",
    "List precise beat indices (ZERO BASED) with a verified source eventId / time window and a concrete viewer-level consequence for EACH substantial problem.",
    "Assess the story without assuming a million views. A superficially valid schema must NOT earn a high score.",
    "If there is any unresolved hook-to-context, causal/temporal continuity, narrator grounding or ending problem, set accepted=false.",
    "Use 80/100 as the minimum recommendation threshold, but never pass based on score alone.",
    "Return EXACTLY ONE JSON envelope with artifacts=[{filename:\"audience-review.json\", script:{artifactType:\"audience_review\",schemaVersion:1,parts:[...]}}]. NO Markdown.",
    `One part entry for each scriptId: ${scriptIds.join(", ")}.`,
    "Each part MUST have these fields: scriptId:number, score:number 0..100, accepted:boolean, hookQuestion:string,",
    "hookHandoffAssessment:string, narratorContribution:string, weakestMoment:string, endingPayoffAssessment:string,",
    "issues:array of {code, segmentIndex:number 0-based, sourceEventId:string, whyViewerLeaves:string, requiredChange:string}.",
    `Allowed critical issue codes: ${[...CRITICAL_AUDIENCE_CODES].join(", ")}.`,
    "Use issues=[] only when the Part is genuinely compelling, unambiguous and evidence-grounded, and justify it in all assessment fields."
  ].join("\n");
}

function validateColdViewerReview(raw, scriptIds = []) {
  const errors = [];
  const parts = Array.isArray(raw?.parts) ? raw.parts : [];
  if (raw?.artifactType !== "audience_review") errors.push("Missing artifactType audience_review");
  const seen = new Set();
  const normalized = [];
  for (const requestedId of scriptIds) {
    const matches = parts.filter((part) => Number(part?.scriptId) === Number(requestedId));
    if (matches.length !== 1) {
      errors.push(`Reviewer must provide exactly one assessment for script ${requestedId}.`);
      continue;
    }
    const item = matches[0];
    seen.add(Number(requestedId));
    const required = ["hookQuestion", "hookHandoffAssessment", "narratorContribution", "weakestMoment", "endingPayoffAssessment"];
    const missing = required.filter((key) => compact(item[key]).length < 8);
    if (missing.length) errors.push(`Script ${requestedId} has unsupported/missing narrative explanations: ${missing.join(", ")}`);
    const score = num(item.score);
    if (!(score >= 0 && score <= 100)) errors.push(`Script ${requestedId} has invalid independent score.`);
    if (typeof item.accepted !== "boolean") errors.push(`Script ${requestedId} has no explicit acceptance decision.`);
    const issues = Array.isArray(item.issues) ? item.issues : null;
    if (!issues) errors.push(`Script ${requestedId} has no issue list.`);
    const normalizedIssues = (issues || []).map((issue, index) => {
      const code = compact(issue?.code);
      const segmentIndex = num(issue?.segmentIndex);
      const whyViewerLeaves = compact(issue?.whyViewerLeaves);
      const requiredChange = compact(issue?.requiredChange);
      if (!CRITICAL_AUDIENCE_CODES.has(code) || !Number.isInteger(segmentIndex) || segmentIndex < 0
        || whyViewerLeaves.length < 12 || requiredChange.length < 12) {
        errors.push(`Script ${requestedId}, issue ${index + 1}: missing grounded, actionable problem.`);
      }
      return { code, segmentIndex, sourceEventId: compact(issue?.sourceEventId),
        whyViewerLeaves, requiredChange };
    });
    normalized.push({ scriptId: Number(requestedId), score, accepted: item.accepted === true
        && score >= 80 && normalizedIssues.length === 0 && missing.length === 0,
      hookQuestion: compact(item.hookQuestion), hookHandoffAssessment: compact(item.hookHandoffAssessment),
      narratorContribution: compact(item.narratorContribution), weakestMoment: compact(item.weakestMoment),
      endingPayoffAssessment: compact(item.endingPayoffAssessment), issues: normalizedIssues });
  }
  if (parts.length !== scriptIds.length || seen.size !== scriptIds.length) errors.push("Reviewer part coverage does not match the requested series.");
  return { artifactType: "audience_review_validation", accepted: errors.length === 0 && normalized.every((p) => p.accepted),
    errors, parts: normalized };
}

function attachAudienceReview(gate, audience) {
  const results = (gate.results || []).map((item) => {
    const critique = audience.parts.find((part) => part.scriptId === item.scriptId);
    const combined = item.passed && audience.errors.length === 0 && critique?.accepted === true;
    return {
      ...item, structuralScore: item.score, audienceScore: critique?.score ?? null,
      audienceIssues: critique?.issues || [], passed: combined,
      score: critique ? Math.min(item.score, critique.score) : 0,
      errors: [
        ...(item.errors || []),
        ...((critique?.issues || []).map((issue) => ({
          code: issue.code, segmentIndex: issue.segmentIndex,
          message: issue.whyViewerLeaves + " Required: " + issue.requiredChange
        }))),
        ...(!critique?.accepted && !(critique?.issues?.length)
          ? [{code:"audience_review_rejected",message: "Cold viewer did not endorse this Part; inspect the independent review artifact."}] : [])
      ],
      feedback: [...(item.feedback || []),
        ...(critique?.issues || []).map((issue) => `audience/${issue.code}: ${issue.whyViewerLeaves} → ${issue.requiredChange}`)]
    };
  });
  return { ...gate, accepted: audience.accepted && results.every((r) => r.passed),
    results, independentAudienceReview: audience };
}

function buildEditorialRepairPrompt({
  previousFiles = [], reportPath = "", blueprintPath = "", intelligencePath = "",
  seriesPlanPath = "", transcriptPath = "", sceneManifestPath = "",
  scriptIds = [], partIssues = null, repairPacketPath = "", recoveryFromForbiddenTool = false
} = {}) {
  const uniquePart = scriptIds.length === 1 ? scriptIds[0] : null;
  // NEVER paste a full script/source intelligence into the --print argv on
  // Windows. Every large input belongs in a host-written JSON file; the CLI
  // prompt carries only bounded context and the exact read-only file paths.
  const shortFailure = (value) => JSON.stringify(value || {}).slice(0, 2300);
  return [
    "You are executing Phase B (Script Generation) EDITORIAL REPAIR of True Crime AutoStory.",
    "You are an editorial SCRIPT WRITER, not a software developer or file maintainer.",
    "NO run_command, terminal, shell, manage_task, write_to_file, search or codebase tools.",
    "Do NOT inspect JavaScript source code or open any .mp4. ONLY view_file on the listed evidence JSON/text files is permitted.",
    "Never run a JSON fixer or validation script. The HOST validates your final response.",
    uniquePart
      ? `Repair EXACTLY Part Script ${uniquePart}; return ONE complete script JSON artifact. Preserve all other Part boundaries.`
      : `Repair exactly these Script IDs: ${scriptIds.join(", ")}.`,
    ...(recoveryFromForbiddenTool
      ? [
        "ISOLATED RECOVERY AFTER A FORBIDDEN TOOL ATTEMPT: DO NOT resume the prior conversation.",
        "The previous agent called a tool outside the whitelist. The HOST terminated that run.",
        "This is NOT an instruction to debug, inspect or change application code.",
        "FIRST open the single HOST_PREPARED_REPAIR_PACKET below with view_file; it contains the FULL original script, exact Preflight deductions, episode evidence and locked Part allocation.",
        `HOST_PREPARED_REPAIR_PACKET (read with view_file, do not execute): ${repairPacketPath}`,
        "Do not call view_file on any other path. Do not call run_command even to read JSON.",
        "If you cannot read the packet, return a clear input-access failure rather than inventing source facts."
      ]
      : [
        `Original script to repair (view_file): ${previousFiles.join(" ; ")}`,
        `Host QA report (view_file): ${reportPath}`,
        `Locked Narrative Blueprint (view_file): ${blueprintPath}`,
        `Source Intelligence (view_file): ${intelligencePath}`,
        ...(seriesPlanPath ? [`LOCKED SERIES PLAN (view_file): ${seriesPlanPath}`] : []),
        ...(sceneManifestPath ? [`Source scene boundaries (view_file only if necessary): ${sceneManifestPath}`] : []),
        ...(transcriptPath ? [`Source transcript (view_file only if necessary): ${transcriptPath}`] : []),
        ...(repairPacketPath ? [`HOST_PREPARED_REPAIR_PACKET (full problems and Part-specific evidence; view_file): ${repairPacketPath}`] : []),
        "Host-identified errors (abbreviated; read FULL failure report from JSON):",
        shortFailure(partIssues)
      ]),
    "Fix EVERY hard error that is genuinely supported by the evidence, without making up source facts or passing by fake metadata.",
    "Repair priorities based on the live normalized Production Preflight:",
    "- Keep the Part's COMPLETE playable duration within its locked series range (normally 75-110s), and ALWAYS above 60.5s. If longer, remove low-value source beats; do not truncate an essential exchange or pad duration.",
    "- No voiceover segment should exceed 12s of actual spoken narration. Use SHORT contextual bridges and original audio with clear handoffs.",
    "- Avoid original-audio / voiceover runs over 15s when the series profile requests interleaving; do not cut away mid-sentence or hide evidence.",
    "- Avoid >7 distant source jumps per Part unless the story genuinely requires them; prioritize causal continuity over arbitrary hop counts.",
    "- Part 1 must establish the hook conflict and audible context/rewind bridge within the opening ~15s, preserving the selected authentic hook.",
    "- Every Part needs a verified cliffhanger or payoff according to the locked Part ending. No generic 'Follow for Part 2' CTA.",
    "- Set macroBlockId/storyFunction and story_blueprint to reflect the ACTUAL story; do not simply add labels or pass flags.",
    "- Preserve source quotes, actors, timestamps, original bodycam audio and Part boundaries; do not invent charges, motives or outcomes.",
    "- Preserve all necessary import fields including scriptId, segments, audio_mode, sourceStartSec, sourceEndSec and voiceover_text.",
    "IMPORTANT: Return a COMPLETE replacement SCRIPT artifact. Do not return a plan, a patch, shell instructions, or a file-write action.",
    `Return ONE JSON envelope: {\"artifacts\":[{\"filename\":\"script-${uniquePart || "N"}.json\",\"script\":{...COMPLETE SCRIPT...}}]}. No prose, no Markdown.`
  ].join("\n");
}

module.exports = { makeStoryIntelligence, makeHookTournament, makeNarrativeBlueprint, evaluateEditorialScript, buildPhaseBEditorialGuidance, buildEditorialRepairPrompt, buildColdViewerPrompt, validateColdViewerReview, attachAudienceReview, readJson };
