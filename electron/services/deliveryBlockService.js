// AutoStory V5 — DELIVERY BLOCKS (continuous narrated story blocks).
//
// The exact EDL beats stay the ONLY owner of source ranges, order, chronology,
// narrative role and scope membership. Delivery blocks are a layer ABOVE the
// beats that says who owns the AUDIO of a run of consecutive beats:
//
//   raw_evidence    the real moment speaks (original audio)
//   narrated_story  ONE continuous narration passage spans every beat in the
//                   block; visual cuts stay, only audio ownership spans them.
//
// Gemini (the Editorial Director) decides the editorial ownership. JS here only
// validates STRUCTURE (membership, contiguity, order) and derives the technical
// per-beat audio mode from the block. No quotas, counts or duration heuristics.

const crypto = require('crypto');

const DELIVERY_CONTRACT = 'continuous-narrated-blocks-v1';
const MODES = ['raw_evidence', 'narrated_story'];
const NARRATED_SOURCE_AUDIO = ['voiceover_with_ambient', 'voiceover_only'];
const DEFAULT_NARRATED_SOURCE_AUDIO = 'voiceover_with_ambient';

const num = v => (Number.isFinite(Number(v)) ? Number(v) : NaN);
const round3 = n => Math.round(n * 1000) / 1000;
const beatSec = b => Math.max(0, num(b.sourceEndSec) - num(b.sourceStartSec));

// ---------------------------------------------------------------- schema
const text = { type: 'string' };
const deliveryBlockSchema = {
  type: 'object',
  required: ['blockId', 'mode', 'beatIds', 'storyFunction', 'blockSummary', 'viewerStateChanges', 'ownershipReason'],
  additionalProperties: true,
  properties: {
    blockId: text,
    mode: { type: 'string', enum: MODES },
    beatIds: { type: 'array', items: text, maxItems: 40 },
    storyFunction: text,
    // Director self-check (block level, not per beat): the whole block in one
    // sentence, how many genuinely NEW viewer-state changes it produces, and why
    // this ownership (raw proof/emotion vs narrated comprehension/compression).
    blockSummary: text,
    viewerStateChanges: { type: 'number' },
    ownershipReason: text,
    // narrated_story only
    sourceAudioTreatment: { type: 'string', enum: NARRATED_SOURCE_AUDIO },
    narratorFunction: text,
    narrationIntent: text,
    handoffTargetBeatId: text,
    // raw_evidence only
    evidenceFunction: text
  }
};

// Director's transition self-check, one per boundary between consecutive blocks.
const transitionCheckSchema = {
  type: 'object',
  required: ['fromBlockId', 'toBlockId', 'coldViewerUnderstandsWhy', 'howTheViewerKnows'],
  additionalProperties: true,
  properties: { fromBlockId: text, toBlockId: text, coldViewerUnderstandsWhy: { type: 'boolean' }, howTheViewerKnows: text }
};

// ---------------------------------------------------------------- structure
// Pure structural validation. Returns violations in the director's format.
function validateDeliveryBlocks(beats = [], blocks, { narrationEnabled = true, requireSelfCheck = false } = {}) {
  const out = [];
  const add = (code, message, extra = {}) => out.push({ code, message, ...extra });
  if (!Array.isArray(blocks) || !blocks.length) {
    add('DELIVERY_BLOCKS_MISSING', 'spine.deliveryBlocks is missing or empty: every beat must belong to exactly one delivery block (raw_evidence or narrated_story).');
    return out;
  }
  const order = new Map(beats.map((b, i) => [b.beatId, i]));
  const owner = new Map();
  const ids = new Set();
  let lastEnd = -1;
  blocks.forEach((blk, k) => {
    const id = blk?.blockId || `#${k}`;
    if (ids.has(id)) add('DELIVERY_BLOCK_DUPLICATE_ID', `blockId '${id}' is used more than once.`, { blockId: id });
    ids.add(id);
    if (!MODES.includes(blk?.mode)) add('DELIVERY_BLOCK_MODE_INVALID', `Block '${id}' has mode '${blk?.mode}'; use raw_evidence or narrated_story.`, { blockId: id });
    const members = Array.isArray(blk?.beatIds) ? blk.beatIds : [];
    if (!members.length) { add('DELIVERY_BLOCK_EMPTY', `Block '${id}' has no beatIds.`, { blockId: id }); return; }
    const idx = [];
    for (const beatId of members) {
      if (!order.has(beatId)) { add('DELIVERY_BLOCK_UNKNOWN_BEAT', `Block '${id}' references beat '${beatId}', which is not in the EDL.`, { blockId: id, beatId }); continue; }
      if (owner.has(beatId)) add('DELIVERY_BEAT_IN_MULTIPLE_BLOCKS', `Beat '${beatId}' is in block '${owner.get(beatId)}' and in block '${id}'.`, { blockId: id, beatId });
      else owner.set(beatId, id);
      idx.push(order.get(beatId));
    }
    if (idx.length) {
      const sorted = [...idx].sort((a, b) => a - b);
      if (idx.join(',') !== sorted.join(',')) add('DELIVERY_BLOCK_REORDERS_BEATS', `Block '${id}' lists its beats out of EDL order.`, { blockId: id });
      if (sorted.some((v, i) => i > 0 && v !== sorted[i - 1] + 1)) add('DELIVERY_BLOCK_NOT_CONTIGUOUS', `Block '${id}' beats must be consecutive in EDL order (${members.join(', ')}).`, { blockId: id });
      if (sorted[0] <= lastEnd) add('DELIVERY_BLOCK_ORDER', `Block '${id}' starts before the previous block ends; blocks must follow EDL order.`, { blockId: id });
      lastEnd = Math.max(lastEnd, sorted[sorted.length - 1]);
    }
    if (requireSelfCheck && !String(blk?.blockSummary || '').trim()) add('DELIVERY_BLOCK_SELF_CHECK_MISSING', `Block '${id}' needs blockSummary: the whole block in one sentence.`, { blockId: id });
    if (requireSelfCheck && !(Number.isFinite(blk?.viewerStateChanges) && blk.viewerStateChanges >= 0)) add('DELIVERY_BLOCK_SELF_CHECK_MISSING', `Block '${id}' needs viewerStateChanges: how many genuinely new viewer-state changes the whole block produces.`, { blockId: id });
    if (requireSelfCheck && !String(blk?.ownershipReason || '').trim()) add('DELIVERY_BLOCK_SELF_CHECK_MISSING', `Block '${id}' needs ownershipReason: why the real moment (raw_evidence) or the narrator (narrated_story) owns it.`, { blockId: id });
    if (blk?.mode === 'narrated_story') {
      if (!narrationEnabled) add('NARRATION_DISABLED', `Block '${id}' is narrated_story but narration is disabled for this project; use raw_evidence.`, { blockId: id });
      if (!String(blk.narrationIntent || '').trim()) add('NARRATED_BLOCK_WITHOUT_INTENT', `Narrated block '${id}' needs narrationIntent: what the passage must make the viewer understand.`, { blockId: id });
      if (blk.handoffTargetBeatId && !order.has(blk.handoffTargetBeatId)) add('DELIVERY_HANDOFF_UNKNOWN_BEAT', `Block '${id}' hands off to unknown beat '${blk.handoffTargetBeatId}'.`, { blockId: id });
    }
  });
  const unassigned = beats.map(b => b.beatId).filter(bid => !owner.has(bid));
  if (unassigned.length) add('DELIVERY_BEAT_UNASSIGNED', `Every beat must belong to exactly one delivery block; unassigned: ${unassigned.join(', ')}.`, { beatIds: unassigned });
  return out;
}

// The Director's own transition answers. Structure only: every boundary between
// consecutive blocks is answered, and a boundary the Director itself says a cold
// viewer would NOT understand is sent back for a delivery change. No timestamp rule.
function validateTransitionChecks(blocks, checks) {
  const out = [];
  if (!Array.isArray(blocks) || blocks.length < 2) return out;
  const list = Array.isArray(checks) ? checks : [];
  for (let i = 1; i < blocks.length; i++) {
    const from = blocks[i - 1].blockId, to = blocks[i].blockId;
    const c = list.find(x => x && x.fromBlockId === from && x.toBlockId === to);
    if (!c) { out.push({ code: 'TRANSITION_CHECK_MISSING', message: `Answer spine.transitionChecks for the transition ${from} -> ${to}: could a cold viewer understand why the next scene is shown?`, blockIds: [from, to] }); continue; }
    if (c.coldViewerUnderstandsWhy === false) {
      out.push({ code: 'TRANSITION_NOT_UNDERSTOOD', message: `You judged that a cold viewer would not understand why ${to} follows ${from} (${c.howTheViewerKnows || 'no bridge'}). Change delivery ownership, narrationIntent or the block boundary so the viewer knows why we are there.`, blockIds: [from, to] });
    }
  }
  return out;
}

// Per-beat technical audio mode, derived from the owning block. Deterministic
// application of the director's block decision (no editorial choice here).
function audioModeFor(block) {
  if (!block || block.mode !== 'narrated_story') return 'original_audio';
  return NARRATED_SOURCE_AUDIO.includes(block.sourceAudioTreatment) ? block.sourceAudioTreatment : DEFAULT_NARRATED_SOURCE_AUDIO;
}

// Returns beats with audioMode + delivery membership stamped. Only call on
// structurally valid blocks. Source ranges / order are never touched.
function applyDeliveryBlocks(beats = [], blocks = []) {
  const byBeat = new Map();
  blocks.forEach((blk, order) => blk.beatIds.forEach((id, position) => byBeat.set(id, { blk, order, position })));
  return beats.map(b => {
    const m = byBeat.get(b.beatId);
    if (!m) return b;
    return { ...b, audioMode: audioModeFor(m.blk), deliveryBlockId: m.blk.blockId, deliveryMode: m.blk.mode,
      deliveryBlockOrder: m.order, deliveryBlockPosition: m.position, deliveryBlockSize: m.blk.beatIds.length };
  });
}

// Backwards compatibility for spines produced before delivery blocks existed:
// one block per beat, mode from the beat's own audioMode (= the old per-beat model).
function legacyBlocks(beats = []) {
  return beats.map((b, i) => {
    const narrated = b.audioMode === 'voiceover_with_ambient' || b.audioMode === 'voiceover_only';
    return { blockId: `legacy_${i + 1}`, mode: narrated ? 'narrated_story' : 'raw_evidence', beatIds: [b.beatId],
      storyFunction: b.narrativeRole || '', legacyPerBeat: true,
      ...(narrated ? { sourceAudioTreatment: b.audioMode, narratorFunction: b.narratorFunction || '', narrationIntent: b.narrationIntent || b.newInformation || '' } : {}) };
  });
}

// A compression repair may REMOVE beats; references to beats that no longer
// exist are dropped (and blocks left empty disappear). Membership of surviving
// beats is untouched, so contiguity of every surviving block is preserved.
function pruneRemovedBeats(blocks, beats = []) {
  if (!Array.isArray(blocks)) return blocks;
  const alive = new Set(beats.map(b => b.beatId));
  return blocks.map(b => ({ ...b, beatIds: (b.beatIds || []).filter(id => alive.has(id)) })).filter(b => b.beatIds.length);
}

function blocksOf(spine) {
  return Array.isArray(spine?.deliveryBlocks) && spine.deliveryBlocks.length ? spine.deliveryBlocks : legacyBlocks(spine?.beats || []);
}
const isLegacy = blocks => (blocks || []).every(b => b.legacyPerBeat === true);

// Output-time layout of each block over the exact EDL (1x playback).
function blockTimeline(beats = [], blocks = []) {
  const at = new Map(); let cursor = 0;
  beats.forEach(b => { at.set(b.beatId, { start: cursor, end: cursor + beatSec(b), beat: b }); cursor += beatSec(b); });
  return blocks.map((blk, order) => {
    const rows = blk.beatIds.map(id => at.get(id)).filter(Boolean);
    const outputStartSec = rows.length ? rows[0].start : 0;
    const outputEndSec = rows.length ? rows[rows.length - 1].end : 0;
    return { ...blk, order, outputStartSec: round3(outputStartSec), outputEndSec: round3(outputEndSec),
      durationSec: round3(outputEndSec - outputStartSec),
      beats: rows.map(r => r.beat) };
  });
}

// Safe word CEILING for ONE passage over the WHOLE block's visual duration.
// Reuses the compiler's measured-rate budget (its 0.92 margin covers TTS
// variance and the Kokoro head/tail silence). A ceiling, never a quota.
function blockSafeWords(blockDurationSec, wordsPerSecond) {
  return require('./autoStoryTimelineCompiler').budget(Math.max(0, blockDurationSec), wordsPerSecond);
}

// Content fingerprint: membership + ranges + canonical text + audio treatment.
function blockFingerprint(block, beats = []) {
  const byId = new Map(beats.map(b => [b.beatId, b]));
  return crypto.createHash('sha256').update(JSON.stringify({
    c: DELIVERY_CONTRACT, id: block.blockId, mode: block.mode, treatment: block.mode === 'narrated_story' ? audioModeFor(block) : 'original_audio',
    beats: block.beatIds.map(id => [id, byId.get(id)?.sourceStartSec, byId.get(id)?.sourceEndSec]),
    text: block.narrationText || ''
  })).digest('hex').slice(0, 16);
}

module.exports = {
  DELIVERY_CONTRACT, MODES, NARRATED_SOURCE_AUDIO, DEFAULT_NARRATED_SOURCE_AUDIO, deliveryBlockSchema, transitionCheckSchema,
  validateDeliveryBlocks, validateTransitionChecks, applyDeliveryBlocks, audioModeFor, legacyBlocks, blocksOf, isLegacy, pruneRemovedBeats,
  blockTimeline, blockSafeWords, blockFingerprint
};
