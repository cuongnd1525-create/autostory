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
Each block is ONE continuous narration passage that plays across ALL of the block's consecutive beats; the visual cuts inside the block stay, the voice does not restart at them. Write ONE coherent passage per block (it may contain several natural sentences) that serves the block's storyFunction, narratorFunction and narrationIntent, and carries the viewer from viewerStateEntering to viewerStateLeaving.
You are an American True Crime Storyteller and Commentary Editor. The narrator owns comprehension, compression, orientation, causal connection, behavioral commentary (COMMENTARY / INTERPRETATION), contrast framing, anticipation, moral takeaway and momentum:
- Editorial Commentary & Contrast Framing: Do not write dry timestamp labels or flat summaries. Frame the behavioral contrast and legal cause-and-effect using objective, incisive language:
  - Good: "Instead of accepting assistance with her disabled car, she refuses to cooperate and walks away, leaving deputies with no choice but to tow the vehicle."
  - Good: "Rather than waiting for roadside help, she dials 911 to complain about the deputy's tone—treating an emergency line like customer service."
  - BAD (FORBIDDEN): Never use subjective, derogatory labels or emotional insults like "pure entitlement", "arrogant attitude", "stupid", "idiot", or "acting like a brat". Focus on observable actions, decisions, and statutory reality.
- Natural Spoken Cadence & Breath Pauses: Write 1-2 punchy, spoken-English sentences per block with deliberate clause breaks (commas, periods) so the voice delivers each thought with natural pauses and authority.
- Clean Handoff & Punchline Protection (Narrator-to-Evidence Reveal Contract):
  - When followingRawBlock is present, hand the viewer directly to the real moment that follows by setting up what is at stake, the escalating situation, or what the subject is attempting to do.
  - CRITICAL PUNCHLINE RULE: NEVER spoil, summarize, or paraphrase the subject's exact words, legal defense, or punchline quote that the upcoming raw clip is about to deliver!
  - Good: "Locked inside the transport van, she demands to speak with a supervisor, insisting her actions did not warrant an arrest." (Sets up the confrontation without stealing her defense).
  - BAD (FORBIDDEN): "Locked inside the transport van, she attempts to justify her actions to a supervisor—arguing that being rude isn't against the law." (Spoils her exact line before she says it on camera).
  - Inspect input.blocks[].mustWithholdUpcomingQuotes: do not use the key words or arguments from these quotes in your narration text.
- Closing Lesson Takeaway & Thoughtful Engagement Question (when isClosingBlock is true or followingRawBlock is null at the end of the video): The final narrated block MUST deliver a two-part outro (kept concise within ~80-88% of safeWords so the voice finishes cleanly before the video ends):
  1. Sentence 1 (Lesson / Takeaway Summary): Deliver a measured summary connecting the legal cause and outcome, distinguishing the statutory violation from attitude ("What began as an offer of roadside assistance ended in an arrest for misuse of emergency dispatch.").
  2. Sentence 2 (Comment-Provoking Engagement Question): End with a genuine, debatable question exploring both perspectives ("Did the situation warrant criminal charges, or should deputies have handled it differently?"). Do not ask loaded or rhetorical questions like "did she deserve even worse?".
- Grounding & Epistemic Safety: Ground every factual claim in input.blocks[].sourceContext (events, quotes, facts) and return their valid ids in newInformationRefs. Prefer referencing event IDs (e.g. e1, e2) in newInformationRefs when describing observable actions or outcomes; only reference a quote ID whose epistemic status is not known_fact if narrationText itself explicitly attributes or hedges the claim ("the caller said/reported...", "she complained/insisted that...", "according to her"). Never invent information, never describe obvious movement the picture already shows, never spoil input.mustWithhold.
safeWords is an ADVISORY first-pass target for the whole block, never a quota. Aim slightly below safeWords (about 80-90% of safeWords) so the voice finishes cleanly with a natural breath before the next raw clip or video end. The real TTS measurement is authoritative: a passage may be slightly above safeWords when its measured voice still fits the block within the allowed safe speed-up. Finish naturally and do not pad words to fill the picture.
Active voice, spoken American English, grounded and incisive. previewVi is a natural Vietnamese rendering of the passage.`;

const num = v => (Number.isFinite(Number(v)) ? Number(v) : NaN);
const overlaps = (s, e, a, z) => Math.min(e, z) - Math.max(s, a) > 0;

function sourceContext(model, ranges, { isClosingBlock = false } = {}) {
  const inside = (s, e) => ranges.some(([a, z]) => overlaps(num(s), num(e), a, z));
  const allEvents = Array.isArray(model?.events) ? model.events : [];
  let matchedEvents = allEvents.filter(e => inside(e.startSec, e.endSec));
  if (isClosingBlock && allEvents.length) {
    const ids = new Set(matchedEvents.map(e => e.id));
    for (const e of [allEvents[0], allEvents[1], ...allEvents.slice(-3)]) {
      if (e && !ids.has(e.id)) { matchedEvents.push(e); ids.add(e.id); }
    }
  }
  if (!matchedEvents.length && allEvents.length) {
    const wid = ranges.map(([a, z]) => [a - 30, z + 30]);
    matchedEvents = allEvents.filter(e => wid.some(([a, z]) => overlaps(num(e.startSec), num(e.endSec), a, z)));
    if (!matchedEvents.length) matchedEvents = allEvents.slice(0, 6);
  }
  return {
    events: matchedEvents.map(e => ({ id: e.id, startSec: e.startSec, endSec: e.endSec, summary: e.summary, isReveal: !!e.isReveal })),
    quotes: (model?.quotes || []).filter(q => inside(q.startSec, q.endSec))
      .map(q => ({ id: q.id, speaker: q.speaker, startSec: q.startSec, endSec: q.endSec, text: q.text, epistemic: q.epistemic })),
    facts: (model?.facts || []).map(f => ({ id: f.id, text: f.text || f.summary || '', epistemic: f.epistemic || 'known_fact' }))
  };
}

const rawNeighbour = (timeline, k, dir) => {
  for (let j = k + dir; j >= 0 && j < timeline.length; j += dir) {
    const b = timeline[j];
    if (b.mode === 'raw_evidence') {
      return { blockId: b.blockId, evidenceFunction: b.evidenceFunction || b.storyFunction || '',
        beats: b.beats.map(x => ({ beatId: x.beatId, sourceStartSec: x.sourceStartSec, sourceEndSec: x.sourceEndSec, observedInFootage: x.observedInFootage || '', newInformation: x.newInformation || '' })) };
    }
    if (b.mode === 'narrated_story') return null; // another narrated block comes first
  }
  return null;
};

// Everything the narration model needs for one block (Phase 3 contract).
function blockPayload(timeline, k, model, wordsPerSecond) {
  const blk = timeline[k];
  const isClosingBlock = k === timeline.length - 1;
  const prev = rawNeighbour(timeline, k, -1), next = rawNeighbour(timeline, k, +1);
  const ranges = [...blk.beats, ...(prev?.beats || []), ...(next?.beats || [])].map(b => [num(b.sourceStartSec), num(b.sourceEndSec)]);
  const nextRanges = (next?.beats || []).map(b => [num(b.sourceStartSec), num(b.sourceEndSec)]);
  const mustWithholdUpcomingQuotes = (model?.quotes || [])
    .filter(q => nextRanges.some(([a, z]) => overlaps(num(q.startSec), num(q.endSec), a, z)))
    .map(q => ({ speaker: q.speaker, text: q.text }));
  return {
    blockId: blk.blockId, isClosingBlock, storyFunction: blk.storyFunction || '', narratorFunction: blk.narratorFunction || '', narrationIntent: blk.narrationIntent || blk.blockSummary || blk.storyFunction || blk.ownershipReason || '',
    sourceAudioTreatment: Delivery.audioModeFor(blk), handoffTargetBeatId: blk.handoffTargetBeatId || null,
    beats: blk.beats.map(b => ({ beatId: b.beatId, sourceStartSec: b.sourceStartSec, sourceEndSec: b.sourceEndSec,
      durationSec: Math.round((num(b.sourceStartSec !== undefined ? num(b.sourceEndSec) - num(b.sourceStartSec) : 0)) * 100) / 100, narrativeRole: b.narrativeRole,
      observedInFootage: b.observedInFootage || '', newInformation: b.newInformation || '' })),
    viewerStateEntering: blk.beats[0]?.viewerStateBefore || '',
    viewerStateLeaving: blk.beats[blk.beats.length - 1]?.viewerStateAfter || '',
    precedingRawBlock: prev, followingRawBlock: next,
    mustWithholdUpcomingQuotes,
    sourceContext: sourceContext(model, ranges, { isClosingBlock }),
    blockVisualDurationSec: blk.durationSec,
    measuredWordsPerSecond: wordsPerSecond,
    safeWords: Delivery.blockSafeWords(blk.durationSec, wordsPerSecond)
  };
}

async function askBlockNarration(engine, story, payloads, evidence, repair = null, attempt = 0) {
  const instruction = repair
    ? `${INSTRUCTION}\nREWRITE: the previous passage for each block in input.blocks failed a deterministic narration check (input.blocks[].rewriteReason). Return a complete, SHORTER or corrected passage for that block that still serves its narrationIntent. If rewriteTargetWords is present, stay at or below that many words. If rewriteReason contains "epistemic", narrationText MUST explicitly attribute the non-fact claim (for example "the caller said...", "the caller reported...", or "according to her..."); changing only newInformationRefs is not a fix. If rewriteReason contains "punchline_spoiler", DO NOT paraphrase or quote the subject's upcoming defense or dialogue; frame only the situation and anticipation. If rewriteReason contains "judgmental_framing", remove loaded or derogatory terms ("pure entitlement", etc.) and state the observable behavioral contrast and legal cause-and-effect objectively. Do not drop the block's purpose; do not cut mid-thought. This rewrite is text-only because the block was already media-grounded upstream and input.blocks[].sourceContext contains the allowed facts/quotes.`
    : INSTRUCTION;
  const attachedEvidence = repair ? [] : evidence;
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

  const payloads = new Map(narrated.map(({ b, k }) => [b.blockId, blockPayload(timeline, k, model, wps)]));
  const texts = await askBlockNarration(engine, story, [...payloads.values()], evidence);
  const measured = new Map();

  const problemsOf = async () => {
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
      }
    }
    return out;
  };

  let problems = await problemsOf();
  for (let attempt = 1; attempt <= MAX_TEXT_REWRITES && problems.size; attempt++) {
    const redo = [...problems.keys()].map(id => {
      const p = problems.get(id);
      return { ...payloads.get(id), previousNarrationText: texts.get(id)?.narrationText || '', rewriteReason: p.reason,
        ...(Number.isFinite(p.suggestedMaxWords) ? { rewriteTargetWords: p.suggestedMaxWords } : {}) };
    });
    audit.rewrites.push({ attempt, blocks: [...problems.entries()].map(([blockId, p]) => ({ blockId, ...p })) });
    const again = await askBlockNarration(engine, story, redo, evidence, true, attempt);
    for (const [id, line] of again) if (problems.has(id)) texts.set(id, line);
    problems = await problemsOf();
  }
  if (problems.size) {
    const [blockId, p] = problems.entries().next().value;
    throw repairRequest(blockId, p.code === 'BLOCK_VOICE_OVERFLOW' ? 'NARRATED_BLOCK_VOICE_OVERFLOW' : 'NARRATED_BLOCK_UNFIT', p.reason, {
      rawBlockVoiceSec: p.rawBlockVoiceSec,
      fitRatio: p.fitRatio,
      suggestedMaxWords: p.suggestedMaxWords,
      currentWords: p.currentWords
    });
  }

  const out = timeline.map(b => {
    if (b.mode !== 'narrated_story') return b;
    const line = texts.get(b.blockId);
    const t = String(line.narrationText).trim();
    const m = measured.get(t) || {};
    const blockOut = { ...b, narrationText: t, previewVi: line.previewVi || '', narratorFunction: line.narratorFunction || b.narratorFunction,
      newInformation: line.newInformation || [], newInformationRefs: line.newInformationRefs || [], emotionTag: line.emotionTag || 'NEUTRAL',
      sourceAudioTreatment: Delivery.audioModeFor(b), safeWords: payloads.get(b.blockId).safeWords, words: compiler.words(t),
      rawBlockVoiceSec: m.rawBlockVoiceSec ?? null, blockTimelineSec: b.durationSec,
      fitRatio: m.rawBlockVoiceSec ? Math.round((m.rawBlockVoiceSec / b.durationSec) * 1000) / 1000 : null };
    blockOut.fingerprint = Delivery.blockFingerprint(blockOut, beats);
    audit.blocks.push({ blockId: b.blockId, beatIds: b.beatIds, durationSec: b.durationSec, safeWords: blockOut.safeWords, words: blockOut.words,
      advisorySafeWordsExceeded: blockOut.safeWords > 0 && blockOut.words > blockOut.safeWords,
      rawBlockVoiceSec: blockOut.rawBlockVoiceSec, fitRatio: blockOut.fitRatio, narrationText: t });
    return blockOut;
  });
  return { blocks: out, audit };
}

module.exports = { INSTRUCTION, schema, blockPayload, gateBlocks, narrateBlocks, BLOCK_MAX_SPEEDUP };
