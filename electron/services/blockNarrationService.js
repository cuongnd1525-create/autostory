// AutoStory V5 — BLOCK-AWARE NARRATION WRITER + BLOCK VOICE FIT.
//
// For every narrated_story delivery block the narration model writes ONE
// coherent passage for the WHOLE block (it may contain several natural
// sentences). The passage is later synthesized ONCE and rendered as one
// continuous track across the block's visual cuts.
//
// JS only: builds the evidence payload, computes an advisory safe-word target
// from the whole block duration, runs the existing deterministic narration gates,
// and measures real TTS once per block. REAL measured voice duration is the
// authoritative fit test; word count is only a first-pass writing target. Anything
// that cannot be fixed by a text-only rewrite becomes a typed repair request for
// the Editorial Director; narration is never silently discarded, trimmed or
// reverted to raw.

const { StoryError } = require('./autoStoryRepairRouter');
const { NARRATOR_FUNCTIONS } = require('./autoStoryV3Taxonomy');
const Delivery = require('./deliveryBlockService');
const compiler = require('./autoStoryTimelineCompiler');
const narrationGate = require('./narrationGate');

// Same ceiling the renderer's voice fit may absorb with atempo (fitDubbingClusterAudio
// maxStretchRatio 0.08, never trimming words).
const BLOCK_MAX_SPEEDUP = 0.08;
const MAX_TEXT_REWRITES = 3;

const text = { type: 'string' };
const list = (items, maxItems = 20) => ({ type: 'array', items, maxItems });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const blockNarrationLine = object({
  blockId: text, narrationText: text, previewVi: text,
  narratorFunction: { type: 'string', enum: NARRATOR_FUNCTIONS },
  newInformation: list(text, 10), newInformationRefs: list(text, 10), emotionTag: text
});
const schema = object({ accessGranted: { type: 'boolean' }, narrations: list(blockNarrationLine, 40) });

const INSTRUCTION = `PASS 3B — BLOCK NARRATION. Write narration ONLY for the requested narrated_story blocks in input.blocks.
Each block is ONE continuous narration passage that plays across ALL of the block's consecutive beats; the visual cuts inside the block stay, the voice does not restart at them. Write ONE coherent passage per block (it may contain several natural sentences) that serves the block's storyFunction, narratorFunction, commentaryValue and narrationIntent, carrying the viewer from viewerKnows / viewerStateEntering to viewerWantsToKnow / viewerStateLeaving.
You are an American True Crime Storyteller and Commentary Editor. The narrator is the SCENE-TRANSITION BRIDGE and CASE STORYTELLER—NEVER a caption reader describing what is visibly happening on screen:
- STRICT ANTI-PLAY-BY-PLAY RULE (NEVER DESCRIBE VISIBLE SCREEN ACTION):
  - input.blocks[].beats[].observedInFootage is shown ONLY so you know what B-roll is on screen and DO NOT describe it.
  - NEVER narrate literal camera movement or physical action visible on screen (e.g., NEVER write "An officer pulls into a gas station" just because the B-roll shows a cruiser pulling in, and NEVER write "Officers walk her to the patrol car" while that walk is on screen).
  - Instead, treat the visual B-roll purely as background wallpaper while your voice bridges FROM precedingRawBlock TO followingRawBlock.
- Function-Specific Editorial Value (Scene-Transition Bridges & Case Setup):
  - POST-HOOK CASE-FILE REWIND INTRO (CONTEXT right after the opening hook): Right after the opening climax flashpoint throws the viewer into peak tension, step in to rewind the timeline and introduce the case background—how, when, where, and why the incident began (what driving behavior, dispatch call, or violation triggered the stop and who responded)—and hand off directly into the first raw exchange in followingRawBlock.
  - SCENE-TRANSITION BRIDGE (CAUSAL_BRIDGE / TIME_JUMP / ESCALATION): Connect the scene that just ended (precedingRawBlock) to the next scene (followingRawBlock) by summarizing what happened across the omitted time or location shift (using sourceContext.events) and framing what is about to be tested or challenged next.
  - COMMENTARY / INTERPRETATION: Surface the core contradiction between a subject's assumptions/claims and the statutory or operational reality officers are acting on, grounded strictly in input.blocks[].sourceContext.
  - ANTICIPATION / REHOOK: Pivot the story into its next phase (such as moving from roadside arrest to station booking or supervisor confrontation) by planting a concrete curiosity gap before the upcoming raw evidence without giving away the answer.
  - PAYOFF / CLOSING: Connect the inciting decision to the concrete legal consequence and leave the viewer with a balanced, comment-provoking takeaway question.
- Grounded Contrast Without Insults:
  - Good (Post-Hook Case Intro): "To understand how this traffic stop ended in shattered glass, we go back to earlier that night—when Officer Von Seem spotted a vehicle swerving across the center line and initiated a stop."
  - Good (Scene-Transition Bridge): "Instead of accepting assistance with her disabled car, she walks away from the scene—leaving deputies with an obstructing vehicle and no cooperative driver."
  - Good (Time-Jump / Escalation Bridge): "Minutes after refusing help at the roadside, she dials 911 to report the deputy's demeanor—using an emergency dispatch line over a dispute about tone."
  - Good (Re-hook / Location Bridge before custody confrontation): "Once inside the transport van, she demands a supervisor, convinced that her words alone could not cross a criminal line."
  - BAD (FORBIDDEN): Never use subjective, derogatory labels or emotional insults like "pure entitlement", "arrogant attitude", "stupid", "idiot", or "acting like a brat". Never state unverified legal conclusions as fact, and never describe literal on-screen B-roll movement.
- Natural Spoken Cadence & Breath Pauses: Write 1-2 crisp, spoken American English sentences per block with deliberate clause breaks (commas, em-dashes, periods) so the voice delivers each thought with natural pauses, weight and authority.
- Clean Handoff & Punchline Protection (Narrator-to-Evidence Reveal Contract):
  - Inspect input.blocks[].heldBackForFootage and input.blocks[].mustWithholdUpcomingQuotes.
  - CRITICAL PUNCHLINE RULE: NEVER spoil, summarize, or paraphrase the subject's exact words, legal defense, or punchline quote that the upcoming raw clip is about to deliver!
  - Good: "Locked inside the transport van, she demands to speak with a supervisor, insisting her actions did not warrant an arrest." (Sets up the confrontation without stealing her defense).
  - BAD (FORBIDDEN): "Locked inside the transport van, she attempts to justify her actions to a supervisor—arguing that being rude isn't against the law." (Spoils her exact line before she says it on camera).
- Closing Lesson Takeaway & Thoughtful Engagement Question (when isClosingBlock is true or followingRawBlock is null at the end of the video): The final narrated block MUST deliver a complete two-part closing (~82-92% of safeWords so the voice fills the closing block cleanly without leaving dead-air silence, never a bare 3-5 word question stub):
  1. Sentence 1 (Grounded Synthesis): Connect the inciting choice to the concrete outcome, distinguishing the statutory issue from attitude.
  2. Sentence 2 (Balanced Discussion Question): End with a genuine, debatable question exploring the tension in the case ("Did this call cross the line into a crime, or could deputies have resolved it without an arrest?"). Do not ask loaded questions like "did she deserve even worse?".
- Grounding & Epistemic Safety: Ground every factual claim in input.blocks[].sourceContext (events, quotes, facts) and return their valid ids in newInformationRefs. Prefer referencing event IDs (e.g. e1, e2) in newInformationRefs when describing observable actions or outcomes; only reference a quote ID whose epistemic status is not known_fact if narrationText itself explicitly attributes or hedges the claim ("the caller said/reported...", "she complained/insisted that...", "according to her"). Never invent information, never describe obvious movement the picture already shows, never spoil input.mustWithhold.
safeWords is an ADVISORY first-pass target for the whole block, never a quota. Aim around 82-92% of safeWords so the voice finishes cleanly with a natural breath before the next raw clip or video end. The real TTS measurement is authoritative: a passage may be slightly above safeWords when its measured voice still fits the block within the allowed safe speed-up. Finish naturally and do not pad empty words.
Active voice, spoken American English, grounded and incisive. previewVi is a natural Vietnamese rendering of the passage.`;

const num = v => (Number.isFinite(Number(v)) ? Number(v) : NaN);
const overlaps = (s, e, a, z) => Math.min(e, z) - Math.max(s, a) > 0;

function cadenceForNarratorFunction(fn, isClosing = false) {
  if (isClosing || fn === 'CLOSING' || fn === 'PAYOFF') return { deliveryProfile: 'intimate_payoff', speechRateMultiplier: 1.0 };
  if (fn === 'COMMENTARY' || fn === 'INTERPRETATION') return { deliveryProfile: 'warm_story', speechRateMultiplier: 1.0 };
  if (fn === 'REHOOK' || fn === 'ANTICIPATION' || fn === 'ESCALATION') return { deliveryProfile: 'process_energy', speechRateMultiplier: 1.0 };
  return { deliveryProfile: 'natural', speechRateMultiplier: 1.0 };
}

function sourceContext(model, ranges, { isClosingBlock = false, isOpeningContextBlock = false, bridgeGapRange = null, storyScope = null } = {}) {
  const inside = (s, e) => ranges.some(([a, z]) => overlaps(num(s), num(e), a, z));
  const allEvents = Array.isArray(model?.events) ? model.events : [];
  let matchedEvents = allEvents.filter(e => inside(e.startSec, e.endSec));
  const ids = new Set(matchedEvents.map(e => e.id));
  const addEvent = e => {
    if (e && e.id && !ids.has(e.id)) {
      matchedEvents.push(e);
      ids.add(e.id);
    }
  };
  if (isOpeningContextBlock && allEvents.length) {
    // Provide the earliest inciting/approach events so the post-hook narrator can
    // introduce how/when/where the case began instead of describing the B-roll clip.
    for (const e of allEvents.filter(ev => !['teaser', 'commentary'].includes(ev.type)).slice(0, 3)) {
      addEvent(e);
    }
  }
  if (Array.isArray(bridgeGapRange) && Number.isFinite(bridgeGapRange[0]) && Number.isFinite(bridgeGapRange[1]) && bridgeGapRange[1] > bridgeGapRange[0]) {
    // Include omitted events between precedingRawBlock and followingRawBlock so the
    // narrator can bridge what transpired across the cut time or location shift.
    for (const e of allEvents) {
      if (overlaps(num(e.startSec), num(e.endSec), bridgeGapRange[0], bridgeGapRange[1])) addEvent(e);
    }
  }
  if (isClosingBlock && allEvents.length) {
    for (const e of [allEvents[0], allEvents[1], ...allEvents.slice(-3)]) {
      addEvent(e);
    }
  }
  if (!matchedEvents.length && allEvents.length) {
    const wid = ranges.map(([a, z]) => [a - 30, z + 30]);
    matchedEvents = allEvents.filter(e => wid.some(([a, z]) => overlaps(num(e.startSec), num(e.endSec), a, z)));
    if (!matchedEvents.length) matchedEvents = allEvents.slice(0, 6);
  }
  matchedEvents.sort((a, b) => num(a.startSec) - num(b.startSec));
  const baseFacts = (model?.facts || []).map(f => ({ id: f.id, text: f.text || f.summary || '', epistemic: f.epistemic || 'known_fact' }));
  if (storyScope?.scopeStartState && isOpeningContextBlock) {
    baseFacts.push({ id: 'scope_start_state', text: storyScope.scopeStartState, epistemic: 'known_fact' });
  }
  if (Array.isArray(storyScope?.allowedSupportingContext)) {
    storyScope.allowedSupportingContext.forEach((ctx, idx) => {
      if (ctx?.description) {
        baseFacts.push({ id: `support_ctx_${idx + 1}`, text: ctx.description, epistemic: 'known_fact' });
      }
    });
  }
  return {
    events: matchedEvents.map(e => ({ id: e.id, startSec: e.startSec, endSec: e.endSec, summary: e.summary, isReveal: !!e.isReveal })),
    quotes: (model?.quotes || []).filter(q => inside(q.startSec, q.endSec))
      .map(q => ({ id: q.id, speaker: q.speaker, startSec: q.startSec, endSec: q.endSec, text: q.text, epistemic: q.epistemic })),
    facts: baseFacts
  };
}

const rawNeighbour = (timeline, k, dir) => {
  for (let j = k + dir; j >= 0 && j < timeline.length; j += dir) {
    const b = timeline[j];
    if (b.mode === 'raw_evidence') {
      return { blockId: b.blockId, footageFunction: b.footageFunction || '', evidenceFunction: b.evidenceFunction || b.storyFunction || '',
        beats: b.beats.map(x => ({ beatId: x.beatId, sourceStartSec: x.sourceStartSec, sourceEndSec: x.sourceEndSec, observedInFootage: x.observedInFootage || '', newInformation: x.newInformation || '' })) };
    }
    if (b.mode === 'narrated_story') return null; // another narrated block comes first
  }
  return null;
};

// Everything the narration model needs for one block (Phase 3 contract).
function blockPayload(timeline, k, model, wordsPerSecond, storyScope = null) {
  const blk = timeline[k];
  const isClosingBlock = k === timeline.length - 1;
  const isOpeningContextBlock = k <= 1 || blk.narratorFunction === 'CONTEXT';
  const prev = rawNeighbour(timeline, k, -1), next = rawNeighbour(timeline, k, +1);
  const ranges = [...blk.beats, ...(prev?.beats || []), ...(next?.beats || [])].map(b => [num(b.sourceStartSec), num(b.sourceEndSec)]);
  const nextRanges = (next?.beats || []).map(b => [num(b.sourceStartSec), num(b.sourceEndSec)]);
  const prevEndSec = prev?.beats?.length ? num(prev.beats[prev.beats.length - 1].sourceEndSec) : NaN;
  const nextStartSec = next?.beats?.length ? num(next.beats[0].sourceStartSec) : NaN;
  const bridgeGapRange = (!isOpeningContextBlock && Number.isFinite(prevEndSec) && Number.isFinite(nextStartSec) && nextStartSec > prevEndSec)
    ? [prevEndSec, nextStartSec]
    : null;
  const mustWithholdUpcomingQuotes = (model?.quotes || [])
    .filter(q => nextRanges.some(([a, z]) => overlaps(num(q.startSec), num(q.endSec), a, z)))
    .map(q => ({ speaker: q.speaker, text: q.text }));
  return {
    blockId: blk.blockId, isClosingBlock, storyFunction: blk.storyFunction || '', narratorFunction: blk.narratorFunction || '',
    narrationIntent: blk.narrationIntent || blk.blockSummary || blk.storyFunction || blk.ownershipReason || '',
    commentaryValue: blk.commentaryValue || '',
    viewerKnows: blk.viewerKnows || blk.beats[0]?.viewerStateBefore || '',
    viewerWantsToKnow: blk.viewerWantsToKnow || blk.beats[blk.beats.length - 1]?.viewerStateAfter || '',
    heldBackForFootage: blk.heldBackForFootage || '',
    sourceAudioTreatment: Delivery.audioModeFor(blk), handoffTargetBeatId: blk.handoffTargetBeatId || null,
    beats: blk.beats.map(b => ({ beatId: b.beatId, sourceStartSec: b.sourceStartSec, sourceEndSec: b.sourceEndSec,
      durationSec: Math.round((num(b.sourceStartSec !== undefined ? num(b.sourceEndSec) - num(b.sourceStartSec) : 0)) * 100) / 100, narrativeRole: b.narrativeRole,
      observedInFootage: b.observedInFootage || '', newInformation: b.newInformation || '' })),
    viewerStateEntering: blk.viewerKnows || blk.beats[0]?.viewerStateBefore || '',
    viewerStateLeaving: blk.viewerWantsToKnow || blk.beats[blk.beats.length - 1]?.viewerStateAfter || '',
    precedingRawBlock: prev, followingRawBlock: next,
    mustWithholdUpcomingQuotes,
    sourceContext: sourceContext(model, ranges, { isClosingBlock, isOpeningContextBlock, bridgeGapRange, storyScope }),
    blockVisualDurationSec: blk.durationSec,
    measuredWordsPerSecond: wordsPerSecond,
    safeWords: Delivery.blockSafeWords(blk.durationSec, wordsPerSecond)
  };
}

const MAX_NARRATION_EVIDENCE_FILES = 10;

function selectNarrationEvidence(evidence, payloads) {
  if (!Array.isArray(evidence) || evidence.length <= MAX_NARRATION_EVIDENCE_FILES) return evidence || [];
  const primaryRanges = (payloads || []).flatMap(p => p.beats || []).map(b => [num(b.sourceStartSec), num(b.sourceEndSec)]);
  const handoffRanges = (payloads || [])
    .flatMap(p => [...(p.precedingRawBlock?.beats || []), ...(p.followingRawBlock?.beats || [])])
    .map(b => [num(b.sourceStartSec), num(b.sourceEndSec)]);
  const scored = evidence.map((ev, index) => {
    const start = num(ev?.sourceStart ?? ev?.sourceStartSec);
    const end = Number.isFinite(num(ev?.sourceEndSec))
      ? num(ev.sourceEndSec)
      : (Number.isFinite(start) && Number.isFinite(num(ev?.duration)) ? start + num(ev.duration) : NaN);
    let priority = 0;
    if (Number.isFinite(start) && Number.isFinite(end)) {
      if (primaryRanges.some(([a, z]) => overlaps(start, end, a, z))) priority = 2;
      else if (handoffRanges.some(([a, z]) => overlaps(start, end, a, z))) priority = 1;
    }
    return { ev, index, priority };
  });
  return scored
    .sort((a, b) => (b.priority - a.priority) || (a.index - b.index))
    .slice(0, MAX_NARRATION_EVIDENCE_FILES)
    .sort((a, b) => a.index - b.index)
    .map(x => x.ev);
}

async function askBlockNarration(engine, story, payloads, evidence, repair = null, attempt = 0) {
  const instruction = repair
    ? `${INSTRUCTION}\nREWRITE: the previous passage for each block in input.blocks failed a deterministic narration check (input.blocks[].rewriteReason). Return a complete, corrected passage for that block that still serves its narrationIntent and commentaryValue. If rewriteTargetWords is present, stay at or below that many words. If rewriteMinWords is present, expand into a complete grounded two-part takeaway + discussion question of at least rewriteMinWords words (while staying <= safeWords) so the closing block does not leave dead-air silence. If rewriteReason contains "epistemic", narrationText MUST explicitly attribute the non-fact claim (for example "the caller said...", "the caller reported...", or "according to her..."); changing only newInformationRefs is not a fix. If rewriteReason contains "punchline_spoiler", DO NOT paraphrase or quote the subject's upcoming defense or dialogue; frame only the situation and anticipation. If rewriteReason contains "judgmental_framing", remove loaded or derogatory terms ("pure entitlement", etc.) and state the observable behavioral contrast and legal cause-and-effect objectively. Do not drop the block's purpose; do not cut mid-thought. This rewrite is text-only because the block was already media-grounded upstream and input.blocks[].sourceContext contains the allowed facts/quotes.`
    : INSTRUCTION;
  const attachedEvidence = repair ? [] : selectNarrationEvidence(evidence, payloads);
  const result = await engine.ask(`v5-block-narration${repair ? `_rewrite${attempt}` : ''}-${story.scriptId}`,
    { spine: { centralViewerQuestion: story.centralViewerQuestion, hookPromise: story.hookPromise },
      mustWithhold: story.storyScope?.mustWithhold || [], blocks: payloads },
    schema, instruction, attachedEvidence, v => {
      if (!v || !Array.isArray(v.narrations)) throw new StoryError('INVALID_RESPONSE', 'Missing block narrations.');
      return v;
    }, 'auto_story_edit');
  return new Map(result.narrations.map(n => [n.blockId, n]));
}

// Deterministic gate over block passages, reusing the existing narration gates.
// Each passage is placed right after its block's LAST beat so a reveal shown
// inside the block is not a spoiler, but a reveal in a later block is.
function gateBlocks(beats, timeline, texts, model) {
  const rows = [];
  const narratedAfter = new Map();
  const blockIndex = new Map(timeline.map((b, i) => [b.blockId, i]));
  timeline.filter(b => b.mode === 'narrated_story').forEach(b => narratedAfter.set(b.beatIds[b.beatIds.length - 1], b));
  for (const beat of beats) {
    rows.push({ ...beat, speaks: false, narratorText: '' });
    const blk = narratedAfter.get(beat.beatId);
    if (!blk) continue;
    const line = texts.get(blk.blockId) || {};

    // A narrated_story block OWNS the foreground audio of its own source span.
    // Dialogue inside that same span is source material the narrator is allowed
    // to compress/orient, so treating it as "original dialogue being repeated"
    // makes legitimate rewind/context narration impossible. The redundancy gate
    // instead protects the NEXT raw-evidence handoff: narration must not pre-say
    // the strong dialogue the viewer is about to hear for real.
    const k = blockIndex.get(blk.blockId);
    const nextRaw = Number.isFinite(k) ? rawNeighbour(timeline, k, +1) : null;
    const audibleRanges = (nextRaw?.beats || []).map(x => [num(x.sourceStartSec), num(x.sourceEndSec)]);
    const handoffQuoteIds = (model?.quotes || [])
      .filter(q => audibleRanges.some(([a, z]) => overlaps(num(q.startSec), num(q.endSec), a, z)))
      .map(q => q.id);

    rows.push({ beatId: blk.blockId, isBlock: true, speaks: true, narratorText: line.narrationText || '',
      narratorFunction: line.narratorFunction || blk.narratorFunction, newInformation: line.newInformation || [],
      newInformationRefs: line.newInformationRefs || [],
      originalQuoteIds: handoffQuoteIds });
  }
  rows.forEach((r, i) => { r.order = i; });
  const report = narrationGate.inspect(rows, model);
  return { ...report, repairBlockIds: report.repairBeatIds.filter(id => timeline.some(b => b.blockId === id)) };
}

function repairRequest(blockId, code, message, extra = {}) {
  return new StoryError('DIRECTOR_REPAIR_REQUIRED', `Narrated block '${blockId}': ${message}`,
    { violations: [{ code, blockId, message: `Narrated block '${blockId}': ${message} Change the block's length, membership or ownership, or its narrationIntent.`, ...extra }] });
}

// Writes, gates and voice-fits every narrated block. Returns the narrated
// blocks (with canonical narrationText + measurements) and an audit report.
async function narrateBlocks({ engine, service, story, model, beats, blocks, evidence }) {
  const wps = engine.config?.narration?.measuredWordsPerSecond;
  const timeline = Delivery.blockTimeline(beats, blocks);
  const narrated = timeline.map((b, k) => ({ b, k })).filter(x => x.b.mode === 'narrated_story');
  const audit = { contract: Delivery.DELIVERY_CONTRACT, blocks: [], rewrites: [] };
  if (!narrated.length) return { blocks: timeline, audit };
  if (engine.config?.narration?.enabled === false) throw repairRequest(narrated[0].b.blockId, 'NARRATION_DISABLED', 'narration is disabled for this project.');

  const payloads = new Map(narrated.map(({ b, k }) => [b.blockId, blockPayload(timeline, k, model, wps, story?.storyScope || null)]));
  const texts = await askBlockNarration(engine, story, [...payloads.values()], evidence);
  const measured = new Map();

  const problemsOf = async (rewritePass = 0) => {
    const out = new Map();
    for (const { b } of narrated) {
      const line = texts.get(b.blockId);
      const t = String(line?.narrationText || '').trim();
      if (!t) { out.set(b.blockId, { code: 'BLOCK_NARRATION_EMPTY', reason: 'no passage was returned for this block.' }); continue; }
      // Do NOT reject on estimated word count. safeWords is intentionally
      // conservative (0.92 margin) while the renderer can safely absorb up to
      // BLOCK_MAX_SPEEDUP. The real synthesized voice below decides fit.
    }
    const gate = gateBlocks(beats, timeline, texts, model);
    for (const id of gate.repairBlockIds) {
      if (!out.has(id)) out.set(id, { code: 'BLOCK_NARRATION_GATE', reason: gate.issues.filter(i => i.beatId === id && i.severity === 'error').map(i => `${i.code}: ${i.reason}`).join(' ') });
    }
    // Phase 6: measure the REAL voice once per passage against the WHOLE block.
    for (const { b } of narrated) {
      if (out.has(b.blockId)) continue;
      const t = String(texts.get(b.blockId).narrationText).trim();
      const payload = payloads.get(b.blockId);
      let m = measured.get(t);
      if (!m) {
        const { meta } = await service.measuredVoice(engine.project, t, engine.cache);
        m = { rawBlockVoiceSec: Number(meta?.duration) || 0 };
        measured.set(t, m);
      }
      const fitRatio = b.durationSec > 0 ? m.rawBlockVoiceSec / b.durationSec : Infinity;
      if (fitRatio > 1 + BLOCK_MAX_SPEEDUP) {
        const currentWords = compiler.words(t);
        const maxFitSec = b.durationSec * (1 + BLOCK_MAX_SPEEDUP);
        // Convert the measured overrun into a conservative rewrite target. This
        // is guidance for Gemini only; acceptance is still based on measured TTS.
        const measuredWps = currentWords / Math.max(0.01, m.rawBlockVoiceSec);
        const measuredTarget = Math.floor(measuredWps * maxFitSec * 0.85);
        const suggestedMaxWords = Math.max(1, Math.min(
          currentWords - 1,
          payload?.safeWords > 0 ? payload.safeWords : currentWords - 1,
          measuredTarget
        ));
        out.set(b.blockId, { code: 'BLOCK_VOICE_OVERFLOW', reason: `the passage measures ${m.rawBlockVoiceSec.toFixed(2)}s of speech for a ${b.durationSec}s block (fit ratio ${fitRatio.toFixed(3)}; at most ${(1 + BLOCK_MAX_SPEEDUP).toFixed(2)} can be absorbed without trimming words). Rewrite to about ${suggestedMaxWords} words or fewer, while preserving the narrationIntent.`,
          rawBlockVoiceSec: m.rawBlockVoiceSec, fitRatio, currentWords, safeWords: payload?.safeWords ?? 0, suggestedMaxWords });
      } else if (rewritePass === 0 && payload?.isClosingBlock && b.durationSec >= 3.8 && compiler.words(t) <= 6 && payload.safeWords >= 10 && (b.durationSec - m.rawBlockVoiceSec) > 0.9) {
        const minWords = Math.max(8, Math.min(payload.safeWords - 1, Math.floor(payload.safeWords * 0.75)));
        out.set(b.blockId, { code: 'BLOCK_CLOSING_UNDERSIZED', advisoryOnly: true,
          reason: `the closing passage is a ${compiler.words(t)}-word stub (${m.rawBlockVoiceSec.toFixed(2)}s in a ${b.durationSec}s closing block), which would leave ${(b.durationSec - m.rawBlockVoiceSec).toFixed(2)}s of dead-air silence at the end of the video. Expand into a complete two-part takeaway sentence + balanced viewer discussion question (~${minWords}-${payload.safeWords} words).`,
          rawBlockVoiceSec: m.rawBlockVoiceSec, fitRatio, currentWords: compiler.words(t), safeWords: payload.safeWords, suggestedMinWords: minWords });
      }
    }
    return out;
  };

  let problems = await problemsOf(0);
  for (let attempt = 1; attempt <= MAX_TEXT_REWRITES && problems.size; attempt++) {
    const redo = [...problems.keys()].map(id => {
      const p = problems.get(id);
      return { ...payloads.get(id), previousNarrationText: texts.get(id)?.narrationText || '', rewriteReason: p.reason,
        ...(Number.isFinite(p.suggestedMaxWords) ? { rewriteTargetWords: p.suggestedMaxWords } : {}),
        ...(Number.isFinite(p.suggestedMinWords) ? { rewriteMinWords: p.suggestedMinWords } : {}) };
    });
    audit.rewrites.push({ attempt, blocks: [...problems.entries()].map(([blockId, p]) => ({ blockId, ...p })) });
    const again = await askBlockNarration(engine, story, redo, evidence, true, attempt);
    for (const [id, line] of again) if (problems.has(id)) texts.set(id, line);
    problems = await problemsOf(attempt);
  }
  const blockingProblems = new Map([...problems.entries()].filter(([, p]) => !p.advisoryOnly));
  if (blockingProblems.size) {
    const [blockId, p] = blockingProblems.entries().next().value;
    throw repairRequest(blockId, p.code === 'BLOCK_VOICE_OVERFLOW' ? 'NARRATED_BLOCK_VOICE_OVERFLOW' : 'NARRATED_BLOCK_UNFIT', p.reason, {
      rawBlockVoiceSec: p.rawBlockVoiceSec,
      fitRatio: p.fitRatio,
      suggestedMaxWords: p.suggestedMaxWords,
      currentWords: p.currentWords
    });
  }

  const out = timeline.map((b, idx) => {
    if (b.mode !== 'narrated_story') return b;
    const line = texts.get(b.blockId);
    const t = String(line.narrationText).trim();
    const m = measured.get(t) || {};
    const resolvedFn = line.narratorFunction || b.narratorFunction;
    const cadence = cadenceForNarratorFunction(resolvedFn, idx === timeline.length - 1);
    const blockOut = { ...b, narrationText: t, previewVi: line.previewVi || '', narratorFunction: resolvedFn,
      newInformation: line.newInformation || [], newInformationRefs: line.newInformationRefs || [], emotionTag: line.emotionTag || 'NEUTRAL',
      deliveryProfile: cadence.deliveryProfile, speechRateMultiplier: cadence.speechRateMultiplier,
      sourceAudioTreatment: Delivery.audioModeFor(b), safeWords: payloads.get(b.blockId).safeWords, words: compiler.words(t),
      rawBlockVoiceSec: m.rawBlockVoiceSec ?? null, blockTimelineSec: b.durationSec,
      fitRatio: m.rawBlockVoiceSec ? Math.round((m.rawBlockVoiceSec / b.durationSec) * 1000) / 1000 : null };
    blockOut.fingerprint = Delivery.blockFingerprint(blockOut, beats);
    audit.blocks.push({ blockId: b.blockId, beatIds: b.beatIds, durationSec: b.durationSec, safeWords: blockOut.safeWords, words: blockOut.words,
      advisorySafeWordsExceeded: blockOut.safeWords > 0 && blockOut.words > blockOut.safeWords,
      rawBlockVoiceSec: blockOut.rawBlockVoiceSec, fitRatio: blockOut.fitRatio,
      narratorFunction: resolvedFn, deliveryProfile: cadence.deliveryProfile, speechRateMultiplier: cadence.speechRateMultiplier,
      narrationText: t });
    return blockOut;
  });
  return { blocks: out, audit };
}

module.exports = { INSTRUCTION, schema, blockPayload, gateBlocks, narrateBlocks, cadenceForNarratorFunction, selectNarrationEvidence, BLOCK_MAX_SPEEDUP };

