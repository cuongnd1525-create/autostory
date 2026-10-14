// V4 narrative-continuity floor. A source-time jump is not inherently bad,
// but a substantial jump with RAW audio on both sides needs a visible/audio
// orientation the current Director contract cannot independently prove.
// Ask the Director to supply one grounded narrator handoff, keeping the EDL
// and the real evidentiary exchanges intact. Never inject synthetic narration
// or rewrite footage deterministically.
const Delivery = require('./deliveryBlockService');

const MIN_FORWARD_GAP_SEC = 20;
const MIN_BACKWARD_GAP_SEC = 20;
const round1 = x => Math.round(x * 10) / 10;

function check(spine, { narrationEnabled = true } = {}) {
  const beats = Array.isArray(spine?.beats) ? spine.beats : [];
  const blocks = Delivery.blocksOf(spine);
  const owners = new Map();
  for (const block of blocks) for (const id of block.beatIds || []) owners.set(id, block);
  const violations = [];
  const boundaries = [];
  for (let i = 1; i < beats.length; i++) {
    const previous = beats[i - 1], next = beats[i];
    const delta = Number(next.sourceStartSec) - Number(previous.sourceEndSec);
    if (!Number.isFinite(delta)) continue;
    // A clearly declared temporal rewind/callback is a meaningful cut even
    // when its source-time distance is under the long-jump threshold.
    const chronology = String(next.chronologyMode || '').toLowerCase();
    const semanticRewind = ['rewind', 'callback'].includes(chronology)
      && previous.chronologyMode !== next.chronologyMode;
    const significant = delta >= MIN_FORWARD_GAP_SEC
      || delta <= -MIN_BACKWARD_GAP_SEC || semanticRewind;
    if (!significant) continue;
    const prior = owners.get(previous.beatId), following = owners.get(next.beatId);
    const narrator = [prior, following].find(b => b?.mode === 'narrated_story'
      && String(b.narrationIntent || '').trim());
    const caseName = semanticRewind ? `semantic ${chronology} transition`
      : delta < 0 ? 'rewind/source-time reversal' : 'source-time jump';
    const bound = { fromBeatId: previous.beatId, toBeatId: next.beatId,
      sourceGapSec: round1(delta), fromSourceEndSec: previous.sourceEndSec,
      toSourceStartSec: next.sourceStartSec,
      fromDeliveryBlockId: prior?.blockId || null,
      toDeliveryBlockId: following?.blockId || null,
      hasNarratorHandoff: Boolean(narrator) };
    boundaries.push(bound);
    if (!narrationEnabled || narrator) continue;
    violations.push({
      code: 'UNBRIDGED_EDL_TIME_JUMP',
      ...bound,
      message: `Unexplained ${caseName} of ${round1(Math.abs(delta))}s between beats '${previous.beatId}' and '${next.beatId}'. Both sides currently rely on unbridged original audio. Preserve the essential raw quote/action, but place a SHORT, evidence-grounded narrated_story passage on an adjacent existing beat (or regroup consecutive beats) explaining why the viewer moves to the next moment. For a teaser rewind explicitly orient the viewer to the earlier moment. Do not invent dialogue, hide the payoff, or narrate over crucial evidence.`
    });
  }
  return { passed: !violations.length, violations, boundaries, narrationEnabled,
    narratedBlocks: blocks.filter(b => b.mode === 'narrated_story').length,
    rawBlocks: blocks.filter(b => b.mode === 'raw_evidence').length };
}

module.exports = { check, MIN_FORWARD_GAP_SEC, MIN_BACKWARD_GAP_SEC };
