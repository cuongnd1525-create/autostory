const PROMPT_VERSIONS = Object.freeze({
  canonical: "video_understanding_chunked_v3",
  scoring: "event_scoring_v1",
  planning: "story_planner_v1",
  judge: "story_judge_v1",
  edl: "edl_generator_v2",
  audit: "final_audit_v2"
});

function json(value) {
  return JSON.stringify(value, null, 2);
}

function accessGate(stage) {
  return `INPUT ACCESS GATE - FAIL CLOSED:
- Confirm that every supplied file was opened and parsed before doing the task.
- For video input, inspect the complete chronology from beginning to end, including audio.
- Never infer an event, quote, identity, injury, charge, motive, or outcome that is not visible, audible, or explicitly supported by supplied text.
- If access is incomplete, return only {"artifactType":"auto_story_input_access_failure","stage":"${stage}","accessGranted":false,"missingInputs":[],"mismatchDetails":"","recommendedAction":""}.
- A successful result must include inputAccessAudit.accessGranted=true and list the inspected inputs.`;
}

function canonicalPrompt({ durationSec, transcriptIncluded }) {
  return `${accessGate("canonical_understanding")}

You are a forensic multimodal analyst for American true-crime and police/bodycam footage. Build the immutable canonical understanding of this source. Do not create a TikTok script, edit sequence, EDL, or narration.

Inspect the complete source in chronology. Identify characters without guessing names, every story-changing event, exact timestamp corridors, verified dialogue, visual/audio evidence, causal links, mandatory facts, mandatory resolutions, Hook candidates, visual/dialogue payoffs, procedural/dead-air ranges, source narrator ranges, and uncertain facts.

Keep the artifact compact enough for downstream stages: include at most 120 story-changing events, merge adjacent moments that perform the same narrative function, quote only the decisive sentence, and keep every description/evidence field concise. Do not create frame-by-frame or subtitle-by-subtitle entries.

Video duration: ${Number(durationSec || 0).toFixed(3)} seconds.
Timestamped transcript supplied: ${transcriptIncluded ? "yes" : "no; use the complete source audio and mark uncertain dialogue"}.

Every event must contain eventId, start, end, title, description, participants, eventType, storyRoleCandidates, visualEvidence, audioEvidence, dialogue, requiresContext, spoils, confidence, sourceNarratorPresent, and informationGain. Use only valid source seconds. Supported causal relations: CAUSES, EXPLAINS, REQUIRES_CONTEXT, CONTRADICTS, RESOLVES, REVEALS.`;
}

function canonicalChunkPrompt({ sourceStartSec, sourceEndSec, sourceDurationSec, transcriptIncluded, chunkIndex, chunkCount }) {
  const localDuration = Math.max(0, Number(sourceEndSec) - Number(sourceStartSec));
  return `${accessGate("canonical_chunk_${chunkIndex}")}

You are a forensic multimodal analyst for American true-crime and police/bodycam footage. This is chunk ${chunkIndex}/${chunkCount} of one source. Inspect the ENTIRE attached chunk from local beginning to local end, including audio. Extract only story-changing events; do not write a script or EDL.

TIMESTAMP CONTRACT:
- chunk local 0.000s = original source ${Number(sourceStartSec).toFixed(3)}s
- chunk local ${localDuration.toFixed(3)}s = original source ${Number(sourceEndSec).toFixed(3)}s
- complete source duration = ${Number(sourceDurationSec).toFixed(3)}s
- Every event start/end MUST use ORIGINAL SOURCE seconds and remain inside ${Number(sourceStartSec).toFixed(3)}-${Number(sourceEndSec).toFixed(3)}.
- The attached SRT${transcriptIncluded ? " contains only this chunk and keeps original-source timestamps" : " is unavailable; verify words from source audio"}.

Each event must be concise and contain eventId, start, end, title, description, participants, eventType, storyRoleCandidates, visualEvidence, audioEvidence, dialogue, requiresContext, spoils, confidence, sourceNarratorPresent, and informationGain. Keep decisive dialogue only. Merge adjacent moments with the same narrative function. Include the final meaningful outcome in this chunk, but do not create filler events solely to cover silence.

Return only one root object.`;
}

function canonicalRepairPrompt({ rawEvents, durationSec, transcriptIncluded }) {
  return `You are repairing serialization only. A multimodal Vertex pass inspected the complete supplied proxy${transcriptIncluded ? " and timestamped transcript" : " with its source audio"} but mistakenly returned its events array without the required root object. Do not invent a new event, quote, timestamp, person, charge, motive, or outcome. Derive only concise root-level summaries and relationships supported by these events.

Return one compact JSON object with inputAccessAudit, videoSummary, storyType, mainConflict, characters, causalLinks, mandatoryFacts, mandatoryResolutions, hookCandidates, visualPayoffs, dialoguePayoffs, boringSegments, and uncertainFacts.

Set inputAccessAudit.accessGranted=true only because the completed attached-source passes produced evidence-backed events covering the source chronology. inspectedInputs must list "complete analysis proxy chunks with audio"${transcriptIncluded ? ' and "matching timestamped transcript slices"' : ""}. Set timelineCoverageStartSec and timelineCoverageEndSec from the supplied coverage. CRITICAL: Do NOT return events or timeline; local code will attach the immutable events. First character {, last character }. No Markdown.

SOURCE DURATION: ${Number(durationSec || 0).toFixed(3)}
MULTIMODAL EVENTS:
${json(rawEvents)}`;
}

function canonicalContinuationPrompt({ sourceStartSec, sourceEndSec, previousCoverageEndSec, transcriptIncluded }) {
  const localDuration = Math.max(0, Number(sourceEndSec) - Number(sourceStartSec));
  return `${accessGate("canonical_continuation")}

The attached video is a continuous excerpt from the original source. Inspect this complete excerpt from beginning to end, including its audio, and return ONLY story-changing events that extend canonical coverage beyond ${Number(previousCoverageEndSec).toFixed(3)} source seconds.

TIMESTAMP MAP:
- excerpt local 0.000s = original source ${Number(sourceStartSec).toFixed(3)}s
- excerpt local ${localDuration.toFixed(3)}s = original source ${Number(sourceEndSec).toFixed(3)}s
- Every event start/end MUST use ORIGINAL SOURCE seconds, not excerpt-local seconds.
- The timestamped transcript${transcriptIncluded ? " is supplied as corroborating evidence and retains original source timestamps" : " is not supplied; verify dialogue from excerpt audio and mark uncertainty"}.

Do not repeat an event whose complete action ends at or before ${Number(previousCoverageEndSec).toFixed(3)}s. Do not invent any event, quote, identity, injury, charge, motive, or outcome. Keep entries concise and merge adjacent moments with the same narrative purpose.

Each event must contain eventId, start, end, title, description, participants, eventType, storyRoleCandidates, visualEvidence, audioEvidence, dialogue, requiresContext, spoils, confidence, sourceNarratorPresent, and informationGain.

Return one root JSON object.`;
}

function canonicalTimestampRepairPrompt({ events, durationSec }) {
  return `You are a forensic timestamp aligner, not a story writer. The supplied canonical events were already extracted from the video, but their numeric timestamps drifted and some exceed the real source duration. Use the attached timestamped SRT as the sole timing authority.

For every supplied event, locate its verified dialogue or the nearest transcript context that describes the same source moment. Return the SAME eventId exactly once with corrected original-source start and end seconds. Preserve event order. Do not add, remove, merge, split, rename, summarize, or rewrite events. Every timestamp must satisfy 0 <= start < end <= ${Number(durationSec).toFixed(3)}.

For visual-only events with no exact spoken sentence, anchor them inside the immediately surrounding verified transcript corridor. Never fabricate a timestamp. If a precise frame is uncertain, use the narrowest evidence-supported corridor and keep it within the neighboring events.

Return one root object. The events array must contain exactly ${listForPrompt(events).length} entries.

EVENTS TO ALIGN:
${json(listForPrompt(events).map((event) => ({
    eventId: event.eventId,
    title: event.title,
    description: event.description,
    dialogue: event.dialogue,
    currentStart: event.start,
    currentEnd: event.end
  })))}`;
}

function listForPrompt(value) {
  return Array.isArray(value) ? value : [];
}

function scoringPrompt({ canonical, weights }) {
  return `${accessGate("event_scoring")}

Score every canonical event independently from 0 to 10 on hookStrength, conflict, visualIntensity, audioIntensity, surprise, emotion, informationGain, storyImportance, payoffValue, contextDependency, spoilerRisk, redundancy, and retentionRisk. Do not alter events or timestamps. Do not emit a combined viral score; local code computes it using configurable weights.

WEIGHTS FOR CONTEXT ONLY:
${json(weights)}

CANONICAL SOURCE OF TRUTH:
${json(canonical)}

Return one root object.`;
}

function planningPrompt({ canonical, scoredEvents, config, candidatePoolSize }) {
  return `${accessGate("story_planning")}

Act as a senior TikTok true-crime story architect. Create exactly ${candidatePoolSize} genuinely different complete story candidates from the immutable canonical events. Optimize the BEST SEQUENCE, never Top-N event concatenation.

Each candidate needs candidateId, strategy, centralViewerQuestion, hookPromise, estimatedDuration, hook, sequence, openQuestions, resolvedQuestions, mandatoryEventIds, optionalEventIds, forbiddenEventIds, storyRisks, and diversityReason. Every sequence item has storyRole, eventIds, informationGain, and causalTransition.

Target for EACH output: ${config.targetDurationMinSec}-${config.targetDurationMaxSec} seconds. Minimum is hard 65 seconds. Preferred pattern when supported: climax teaser -> minimum rewind/context -> causal escalation -> full climax -> immediate aftermath/resolution. A cold open may be nonlinear but must not falsify causality or spoil the only meaningful reveal. Every selected event must add information, stakes, curiosity, conflict, necessary context, or payoff. Use mandatory resolutions whenever the candidate opens their question.

NARRATION PROFILE:
${json(config.narration)}

CANONICAL SOURCE OF TRUTH:
${json(canonical)}

EVENT SCORES WITH LOCAL COMPUTED SCORE:
${json(scoredEvents)}

Return one root object.`;
}

function judgePrompt({ canonical, scoredEvents, candidates, config }) {
  return `${accessGate("story_judge")}

Act as a merciless Viral Critic Agent. Do not invent a new source event. Rank the supplied candidates based on their Viral Retention Curve:
1. Curiosity Gap: Does the hook immediately raise a question in the first 3 seconds?
2. Pacing: Is there a 5-second context immediately following the hook, followed by rapid escalation without dead air?
3. Payoff: Is the climax visually and emotionally satisfying?
Lock exactly ${config.outputCount} winning stories. Reject candidates with a weak Curiosity Gap or slow pacing. Each locked story must include scriptId, candidateId, judgeScore, reason, centralViewerQuestion, hookPromise, lockedSequence, mandatoryEvents, optionalEvents, forbiddenEvents, targetDuration, retentionRisks, and resolutionEventIds.

REQUEST:
${json(config)}

CANONICAL SOURCE OF TRUTH:
${json(canonical)}

EVENT SCORES:
${json(scoredEvents)}

CANDIDATES:
${json(candidates)}

Return one root object.`;
}

function edlPrompt({ canonical, lockedStories, config, measuredWordsPerSecond }) {
  return `${accessGate("exact_edl")}

Act as an execution editor. The stories below are locked. You may refine clip in/out points inside canonical event corridors, but you may not change strategy, central question, climax, mandatory event, resolution, fact, or chronology in a way that changes causality.

Create exactly one script for every locked story. Each script must contain scriptId, title, top_header, language="en", targetDuration, storyContract, narrationArc, and segments. Each segment requires segmentId, eventId, storyRole, sourceStart, sourceEnd, playbackSpeed, reason, narrativePurpose, audioMode, voiceoverText, sourceNarratorDetected, speakerFocus, focusPriority, subtitlePriority, and previewVi.

Audio modes: original_audio, voiceover_only, or mixed_ducking.
- original_audio requires voiceoverText="" and must contain clean participant/dialogue/action audio with no external source narrator.
- voiceover_only requires concise verified English narration and mutes the complete source soundtrack.
- mixed_ducking: High-energy English narration over ducked ambient source sound (~15% volume). Essential for viral TikTok openings (Type B Hook) and cognitive framing over bodycam movement. Preserves realism while delivering urgent storytelling.
Preserve decisive quotes, commands, impacts, shots, denials, discoveries, reactions, and aftermath as original_audio when clean. Narration connects context, causality, time jumps, contradictions, stakes, and verified outcomes; it never describes an obvious visual.
DEAD AIR ELIMINATION RULE: Uninterrupted ambient sound without participant dialogue or voiceover MUST NEVER exceed 3.0 seconds. Any scene transition over 3 seconds must have connecting narration or be trimmed out.

For voiceover_only and mixed_ducking segments, you MUST provide an emotionTag (e.g., "URGENT", "WHISPER", "SHOUT", "SAD", "NEUTRAL") to direct the TTS engine's emotional pacing. Choose the emotion that best fits the scene's tension. For original_audio, use "NEUTRAL".

For every segment, previewVi is mandatory Vietnamese subtitle text. For original_audio, translate the exact audible participant speech; for voiceover_only and mixed_ducking, translate voiceoverText. Never copy previewVi from another segment. If a clean original_audio beat has no speech, previewVi may be empty. sourceNarratorDetected=true is only valid with voiceover_only or mixed_ducking with verified replacement narration.

Audio balance is a story target, not a duration quota: original_first preserves more strong authentic source beats; balanced alternates concise narration bridges with decisive source audio; narrator_led permits more short narration bridges but must still preserve the strongest clean scene audio; original_only forbids voiceover_only and mixed_ducking. Allow opening hook narration or cognitive framing bridges up to 25 seconds when establishing high-stakes context over approach/movement footage, but always alternate with authentic participant audio (Audio Sandwich formula).

Narrator measured speed: ${Number(measuredWordsPerSecond || 0) > 0 ? `${Number(measuredWordsPerSecond).toFixed(3)} words/second` : "not measured; keep every narration beat concise"}.
Narration configuration:
${json(config.narration)}

Each script must be ${config.targetDurationMinSec}-${config.targetDurationMaxSec} seconds in the rendered output. For original_audio, duration is (sourceEnd-sourceStart)/playbackSpeed. For voiceover_only and mixed_ducking, rendered duration is driven by spoken word count / measured narrator speed, not by a long muted source window. Match each narration visual window closely to its estimated spoken duration; do not hide missing runtime inside muted footage. Enter late and exit immediately after payoff. Never cut a spoken sentence, decisive action, or immediate reaction. Remove dead air, repeated proof, procedural material, long lead-ins, and long exits first.

CANONICAL SOURCE OF TRUTH:
${json(canonical)}

LOCKED STORIES:
${json(lockedStories)}

Return one root object.`;
}

function auditPrompt({ canonical, lockedStory, edl }) {
  return `${accessGate("final_video_audit")}

Audit the supplied rendered draft as a senior American TikTok bodycam editor. Do not redesign the source story. Compare execution against the locked story and EDL: Hook, pacing, clarity, continuity, visual/audio payoff, escalation, climax, resolution, dead time, repetition, confusion, missing source payoff, and bad clip selection.

Return one root object.

CANONICAL SUMMARY:
${json({ videoSummary: canonical.videoSummary, mainConflict: canonical.mainConflict, mandatoryResolutions: canonical.mandatoryResolutions })}

LOCKED STORY:
${json(lockedStory)}

EDL:
${json(edl)}`;
}

module.exports = {
  PROMPT_VERSIONS,
  canonicalPrompt,
  canonicalChunkPrompt,
  canonicalRepairPrompt,
  canonicalContinuationPrompt,
  canonicalTimestampRepairPrompt,
  scoringPrompt,
  planningPrompt,
  judgePrompt,
  edlPrompt,
  auditPrompt
};
