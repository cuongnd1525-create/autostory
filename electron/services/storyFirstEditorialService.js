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
const FACTUAL_ANCHOR_WORDS = /\b(?:earlier|later|minutes?|hours?|because|but|instead|after|before|meanwhile|however|revealed|discovered|found|reported|according|while|until|despite|when|why|evidence|claim|contradict|investigat|realiz|question|suspect|crash|called|dispatch|officer|vehicle|witness|victim)\b/i;
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
      if (PURE_ACTION_NARRATION.test(voice)) warnings.push({ code: "descriptive_voice", index: i, message: "Narrator describes obvious action instead of bridging meaning." });
      if (GENERIC_NARRATION.test(voice)) addError("generic_clickbait", "Remove generic clickbait/forced Part CTA.", i);
      if (voice.split(/\s+/).length > 36) warnings.push({ code: "long_voice", index: i, message: "Narrator sentence/block may be too long for a natural delivery." });
    }
    if (previousRange && sourceRange.start < previousRange.start - 15) {
      if (!/earlier|before|rewind|flashback|back to|previously|hours? ago|minutes? ago|trước đó|quay lại/i.test(bridgeTextAt(segments, i))) {
        unbridgedJumps++;
        addError("unbridged_flashback", "Major backward source jump has no explicit temporal bridge.", i);
      }
    }
    if (previousRange && sourceRange.start > previousRange.end + 90) {
      if (!bridgeTextAt(segments, i).trim()) warnings.push({ code: "unexplained_forward_jump", index: i, message: "Large forward jump needs causal/time orientation." });
    }
    previousRange = sourceRange;
  }
  if (part && segments.length > 0 && num(part.partNumber) === 1) {
    const firstRange = range(segments[0]), hook = range(part.hookRange);
    if (hook && firstRange && !overlaps(firstRange, hook)) addError("hook_misaligned", "Part 1 must start on the locked hook source range.", 0);
    if (extractMode(segments[0]) !== "original_audio") warnings.push({ code: "hook_muted", index: 0, message: "Consider retaining compelling authentic hook audio." });
  }
  if (part && voices.length < 2) addError("narrator_not_directing", "Narration requires at least two meaningful bridge/interpretation beats; footage-only summary fails the narrator-led series profile.");
  const meaningful = voices.filter((v) => v.text.split(/\s+/).length >= 4 && FACTUAL_ANCHOR_WORDS.test(v.text));
  if (part && voices.length && !meaningful.length) addError("empty_narrative_function", "Narrator has no evident contextual/causal contribution.");
  if (part && originalAudioCount === 0) addError("no_original_evidence", "No original bodycam/dialogue/action audio to demonstrate the narrator's claims.");
  if (part && !compact(part.expectedEnding)) addError("missing_locked_ending", "Locked Part has no source-grounded payoff/cliffhanger.");
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
    "- Write narrator text as a storyteller, not as a visual describer or police report. Each narration sentence must ADD verified background, explain a chronological/causal jump, reinterpret evidence, or set up the next authentic beat.",
    "- Interleave narrator with authentic original_audio. Never bury the crucial officer/suspect quote, scream, impact or reveal beneath voiceover; hand back to live audio promptly.",
    "- At least two purposeful narrator beats per Part unless user explicitly selected source-audio-only mode. Do NOT hit a narration quota with filler.",
    "- Every backward source jump greater than ~15 seconds must be anchored by a CLEAR explicit rewind/earlier transition in narration or transitionReason. Explain character changes and spatial jumps when needed.",
    "- Each new beat must have a narrative function and information gain. Discard procedural bloat and repeated facts, but keep subtle consequential reactions and essential context.",
    "- Respect all source-grounded hook promises, scene allocations, Part boundaries and spoiler restrictions. End Part 1/2 on a verified consequential unanswered question, not 'follow for part 2'.",
    "- Conversation-friendly natural US English; short sentences, varied rhythm, no 'what happened next' filler, never fake conclusions/charges/motives.",
    "- Every output must include audio_mode, sourceStartSec/sourceEndSec, voiceover_text, transitionReason, and storyFunction for each segment. The host will reject structurally weak results.",
    "- Write a single full artifact response, not an outline. Check story continuity and narrator handoffs before responding."
  ].join("\n");
}

function buildEditorialRepairPrompt({ previousFiles = [], reportPath = "", blueprintPath = "", intelligencePath = "", scriptIds = [] } = {}) {
  return [
    "You are executing Phase B (Script Generation) EDITORIAL REPAIR of True Crime AutoStory. TEXT INPUTS ONLY. Do not view any .mp4.",
    `Original scripts to repair: ${previousFiles.join(" ; ")}`,
    `Independent host editorial gate results (read first): ${reportPath}`,
    `Locked narrative blueprint: ${blueprintPath}`,
    `Source intelligence: ${intelligencePath}`,
    "Fix EVERY hard error. Restructure the timeline or rewrite narrator where necessary. Do not merely add JSON boolean pass flags.",
    "If the hook is ungrounded, do not invent a new hook; reuse the locked valid hook and fix the handoff. Retain original verified dialogue and source references.",
    "Keep Part IDs, locked allocations, central viewer question, source ranges and spoiler boundaries. Do not invent footage, testimony, legal outcomes or timecodes.",
    "Narrator must function as bridge, setup or reinterpretation and yield to original audio. Ensure at least two meaningful narrator beats and original_audio evidence per Part.",
    `Return one JSON object with artifacts: [{filename: "script-N.json", script: completeRewrittenScript}] for Script IDs ${scriptIds.join(", ")}. No prose, no Markdown.`
  ].join("\n");
}

module.exports = { makeStoryIntelligence, makeNarrativeBlueprint, evaluateEditorialScript, buildPhaseBEditorialGuidance, buildEditorialRepairPrompt, readJson };
