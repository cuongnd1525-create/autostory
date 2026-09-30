// AutoStory — MEDIA-GROUNDED EDITORIAL DIRECTOR (single owner of the exact EDL).
//
// Gemini WATCHES a compact reel of the selected Story Scope (source-clock proxies
// with a manifest back to absolute source time) and returns the complete EDL:
// exact ranges, order, teaser borrowing, rewind placement, narrative role, audio
// role (original dialogue vs narration), and the ending.
//
// Downstream JS must not re-rank, reorder, inject, extend or trim this EDL. The
// deterministic checks here are TECHNICAL only (bounds, duration, exact
// duplicates, renderer requirements) plus one grounding check: every beat must
// come from footage the director was actually shown, which is the scope reel.
// Any violation goes back to Gemini for a targeted repair (max 2 passes). JS never
// picks replacement material.

const path = require('path');
const { StoryError } = require('./autoStoryRepairRouter');
const { NARRATIVE_ROLES, NARRATOR_FUNCTIONS, toV2Role } = require('./autoStoryV3Taxonomy');
const Scope = require('./storyScopeService');
const Packer = require('./scopeReelPacker');
const Delivery = require('./deliveryBlockService');

const DIRECTOR_CONTRACT = 'scope-media-director-v1';
const DIRECTOR_REEL_FPS = 4;          // proxy encode fps (Vertex samples at videoFps=2)
const MIN_BEAT_SEC = 1.0;             // renderer/playability floor, not an editorial rule
const GROUNDING_TOLERANCE_SEC = 0.25; // max seconds of a beat allowed outside watched, in-scope footage
const DUR_EPS = 0.25;
const DUP_EPS = 0.05;

// ---------------------------------------------------------------- generation fuse
// TECHNICAL safety fuse, not an editorial rule. Valid director EDLs observed on
// the benchmark are 3,649-4,252 candidate tokens for 14 beats (~260 tokens/beat
// + ~400 header). The schema's hard beat ceiling (40) would need ~11k tokens, so
// 16,000 admits every contract-legal EDL with headroom, while a degenerate
// generation (e.g. a sentence looping inside one string) now stops after 16k
// tokens (~2 min, ~$0.04 output) instead of the model default 65,536 (~9 min,
// ~$0.16). Hitting it never imports partial JSON and is never auto-resent.
const DIRECTOR_MAX_OUTPUT_TOKENS = 16000;
// Every recorded director call (successful and failed) ran with thinkingBudget 0;
// the failure had no thought tokens. Pinned explicitly so the fuse above is spent
// only on the JSON itself and the behaviour no longer depends on an implicit default.
const DIRECTOR_THINKING_BUDGET = 0;
const DIRECTOR_GENERATION = Object.freeze({ maxOutputTokens: DIRECTOR_MAX_OUTPUT_TOKENS, thinkingBudget: DIRECTOR_THINKING_BUDGET });
// A single director text field is one sentence (observed max 322 chars). A string
// this long is generation degeneration, not editorial content: fail fast, no repair.
const MAX_DIRECTOR_TEXT_CHARS = 2000;

const num = v => (Number.isFinite(Number(v)) ? Number(v) : NaN);
const round2 = n => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- schema
const flexible = (required, optional = {}) => ({ type: 'object', required: Object.keys(required), properties: { ...required, ...optional }, additionalProperties: true });
const text = { type: 'string' };
const number = { type: 'number' };
const boolean = { type: 'boolean' };
const list = (items, maxItems = 40) => ({ type: 'array', items, maxItems });
const choice = (...values) => ({ type: 'string', enum: values });

const SCOPE_MEMBERSHIP = ['hook', 'core', 'supporting_context', 'bridge_picture', 'ending'];

const directorBeat = flexible({
  beatId: text,
  sourceStartSec: number,
  sourceEndSec: number,
  chronologyMode: choice('teaser', 'chronological', 'rewind', 'callback'),
  narrativeRole: choice(...NARRATIVE_ROLES),
  scopeMembership: choice(...SCOPE_MEMBERSHIP),
  observedInFootage: text,
  viewerStateBefore: text,
  viewerStateAfter: text,
  newInformation: text,
  whyNecessaryNow: text
}, {
  // Derived from the owning delivery block (JS); accepted for backwards compatibility.
  audioMode: choice('original_audio', 'voiceover_with_ambient', 'voiceover_only'),
  wantsNarration: boolean,
  narratorFunction: choice(...NARRATOR_FUNCTIONS, 'NONE'),
  narrationIntent: text,
  sourceEventId: text,
  viewerQuestion: text,
  payoffTiming: choice('immediate', 'delayed', 'part_2', 'none'),
  isForwardConsequence: boolean,
  expectedNextConsequence: text,
  cliffhangerQuestion: text,
  whyCutHere: text
});

const directorSpine = flexible({
  centralViewerQuestion: text,
  hookPromise: text,
  hookStrategy: text,
  reason: text,
  beats: list(directorBeat, 40)
}, {
  // Required by validateDirectorEdl (not by the transport schema) so a missing
  // layer is reported with a precise, repairable message.
  deliveryBlocks: list(Delivery.deliveryBlockSchema, 40),
  openLoops: list(flexible({ id: text, question: text }), 12)
});

const directorEdl = {
  type: 'object', required: ['accessGranted', 'reelObservations', 'spine'], additionalProperties: false,
  properties: { accessGranted: boolean, reelObservations: text, spine: directorSpine }
};

const schemas = { directorEdl, directorBeat, directorSpine };

// ---------------------------------------------------------------- instruction
const instruction = `PASS 1B — MEDIA-GROUNDED EDITORIAL DIRECTOR. You own the exact EDL.
The attached video files are the ONLY footage you may cut from. They are the packed media reel of the selected Story Scope: a file may contain SEVERAL source segments back to back. SOURCE MEDIA (and input.scopeReelManifest) lists, per file, each segment's reelStartSec/reelEndSec, its absolute sourceStartSec/sourceEndSec and its scopeWindowId. Map reel time to source time with sourceSec = segment.sourceStartSec + (reelSec - segment.reelStartSec); when sourceClockBurned is true the picture also shows the SOURCE clock. Always output ABSOLUTE source seconds, and never let one beat span two segments. Cut only inside a segment's logical scope window (windowStartSec..windowEndSec); the rest of a segment is context.
input.storyScope is the story you are telling. Do not tell a different one.

WATCH FIRST. Before choosing a range, look at what is actually on screen and what is actually said there. observedInFootage must describe what you SAW and HEARD in that exact range: who is visible, the physical action, the key words. Never pick a range because of a text summary. If the footage does not show it, the beat does not exist.

EVERY BEAT MUST BE BOTH NOVEL AND CAUSALLY COHERENT WITH THE SCOPE.
- For every beat, answer: why is it needed NOW, right after the previous beat (whyNecessaryNow), and what changes for the viewer (viewerStateBefore -> viewerStateAfter, newInformation).
- Every text field is ONE short sentence (about 25 words at most). State each point once; never repeat a sentence or restate another field.
- A different timestamp, speaker or line is not progress. "It is interesting" is not a reason.
- If removing a beat makes the story clearer with no causal loss, remove it.
- A continuous exchange in one place can be excellent when each exchange changes the conflict, exposes a contradiction, raises the stakes or moves toward the consequence. Do not cut away just to get visual variety.
- Large jumps in source time are fine when the viewer understands why they are now seeing the later moment (a narrated block can bridge it). An unexplained jump from one interesting moment to another is not fine.

DELIVERY: THE NARRATOR AND THE REAL MOMENT SHARE THE STORY.
The NARRATOR owns comprehension, compression, orientation, causal connection, anticipation and momentum.
SOURCE AUDIO owns proof, confrontation, emotion, authenticity, the strongest quote, reaction, discovery and consequence.
For each stretch of the EDL decide: does the viewer need to UNDERSTAND this section? A narrated_story block may own it. Does the viewer need to EXPERIENCE or BELIEVE this moment? A raw_evidence block should own it.
Useful grammar when it fits: NARRATE TO THE MOMENT -> LET THE REAL MOMENT SPEAK -> NARRATE OUT OF IT.
Narration may: set up or rewind context, identify people, compress procedural or repetitive explanation, bridge a meaningful time jump, establish whose account we are hearing, frame a contradiction, build anticipation, set up a reveal, open an unresolved question.
Narration must not: describe obvious movement, paraphrase a strong quote we are about to hear, talk over an important confrontation, invent information, or spoil input.storyScope.mustWithhold.
A fact that lives outside the scope (input.storyScope.allowedSupportingContext with treatment narration_only, or outOfScopeBranches) can only enter as narration over in-scope footage that fits it.

DELIVERY BLOCKS (spine.deliveryBlocks) — the audio-ownership layer over your beats.
- Every beat belongs to exactly one block; a block's beatIds are CONSECUTIVE beats in EDL order; blocks follow EDL order. Blocks never change a beat's range, order or role.
- raw_evidence: the real moment speaks with its original audio. Give evidenceFunction (what the viewer must see/hear/believe).
- narrated_story: ONE continuous narration passage runs across ALL of the block's beats (visual cuts stay; only the voice spans them). Give storyFunction, narratorFunction, narrationIntent (exactly what the passage must make the viewer understand) and sourceAudioTreatment: voiceover_with_ambient (keep and duck the scene ambience) or voiceover_only (mute the source, e.g. it contains another narrator or unusable speech). handoffTargetBeatId names the raw beat the passage hands the viewer to, when there is one.
- A narrated block needs enough seconds for its whole passage (input.narrationWordsPerSecond words per second when given, otherwise about 2.5). The narration text itself is written later from your narrationIntent.
- Each beat's audio follows its block; you do not need to set beat audioMode.
- If input.narrationEnabled is false, every block must be raw_evidence.

HOOK = A COMPACT MINI-ARC FROM INSIDE THE SCOPE.
- An optional cold open (chronologyMode 'teaser', scopeMembership 'hook') may borrow from later inside the scope: conflict -> escalation -> partial reveal -> cut before the resolution. It must not spend input.storyScope.mustWithhold.
- Then rewind (chronologyMode 'rewind') to the start of the causal spine. After the rewind the viewer must still have an open question. Replaying part of the hook later in its full context is allowed. An exact duplicate of a range is not.
- The FIRST beat must use a hook role (teaser_conflict, cold_open, cold_open_hook, hook or micro_payoff).

ENDING = A CONSEQUENCE OF THE CENTRAL CONFLICT.
- The final beat (scopeMembership 'ending') must come from input.storyScope.candidateEndingEvents or an ending_material window, and must match input.storyScope.scopeEndTarget. For a forward cliffhanger, name the specific consequence that is now likely and stop before it is shown (payoffTiming 'part_2', isForwardConsequence=true, expectedNextConsequence, whyCutHere). A new question from another branch is not an ending.

SCOPE MEMBERSHIP
- hook | core | supporting_context | bridge_picture | ending. bridge_picture = in-reel footage used as picture under a narration bridge. Beats outside the reel are impossible.

DURATION: aim the total at input.targetDurationSec seconds — inside the preferred band input.targetBandMinSec..input.targetBandMaxSec. input.targetDurationMinSec..input.targetDurationMaxSec is only the hard acceptance range; do NOT aim at its minimum. FINAL TIMELINE DURATION = sum(sourceEndSec - sourceStartSec) over every selected beat. The returned EDL must land inside the preferred band whenever suitable footage allows it, and MUST NOT exceed input.targetDurationMaxSec. The JSON you return is final: no arithmetic, drafts, corrections or repeated text inside any field. Choose beat lengths editorially (a beat may be short or long), but every beat must be at least 1 second.
Set accessGranted=true only after actually watching the attached reel. reelObservations: 2-4 sentences on what the reel actually shows.`;

function repairInstruction(kind, payload) {
  if (kind === 'technical') {
    return `TECHNICAL REPAIR — your EDL failed deterministic validation. Return the COMPLETE EDL again, including spine.deliveryBlocks covering every beat. Change only what these violations require and keep every unaffected beat exactly as it was (same ranges, same order). Replacement footage must come from the attached reel and serve the same story function inside the same scope:
${payload.violations.map((v, i) => `${i + 1}. [${v.code}] ${v.message}`).join('\n')}`;
  }
  return `TARGETED EDITORIAL REPAIR — the RENDERED video of your EDL was watched by a media critic, who found the problems listed in input.criticFindings. Each has an output-time region and the beat ids it maps to (input.weakRegions).
- Return the COMPLETE repaired EDL.
- Fix the problems by changing ONLY the beats in the weak regions, plus an adjacent beat if the transition itself needs it. Preserve every other beat exactly (same ranges, same order).
- Delivery findings (who owns the audio) are repaired in spine.deliveryBlocks: you may change raw_evidence / narrated_story ownership, block membership or narrationIntent for the weak regions. Keep every other block as it was. Return deliveryBlocks covering every beat.
- Stay inside input.storyScope. Replacement footage must come from the attached scope reel. Do not introduce a new branch of the incident to fill time.
- Keep the total duration inside input.targetDurationMinSec..input.targetDurationMaxSec.`;
}

// ---------------------------------------------------------------- pure checks
function beatLen(b) { return Math.max(0, num(b.sourceEndSec) - num(b.sourceStartSec)); }
function timelineSec(beats) { return (beats || []).reduce((n, b) => n + beatLen(b), 0); }

// ---------------------------------------------------------------- duration control
// The hard product range (targetDurationMinSec..targetDurationMaxSec, e.g. 65-90s)
// is an ACCEPTANCE constraint. The GENERATION objective is the Story Scope's own
// targetDurationSec (Gemini-declared, clamped into the hard range with margin), with
// a preferred band around it, so the director never aims at the hard minimum.
const BAND_HALF_WIDTH_SEC = 3;
const BAND_EDGE_MARGIN_SEC = 2;
const TECHNICAL_ADJUST_MAX_DEFICIT_SEC = 1.0;
function durationTargets(scope, cfg = {}) {
  const hardMinSec = cfg.targetDurationMinSec || 65;
  const hardMaxSec = Math.max(hardMinSec, cfg.targetDurationMaxSec || 90);
  const lo = Math.min(hardMaxSec, hardMinSec + BAND_EDGE_MARGIN_SEC + BAND_HALF_WIDTH_SEC);
  const hi = Math.max(lo, hardMaxSec - BAND_EDGE_MARGIN_SEC - BAND_HALF_WIDTH_SEC);
  const declared = num(scope?.targetDurationSec);
  const raw = Number.isFinite(declared) ? declared : (hardMinSec + hardMaxSec) / 2;
  const targetDurationSec = round2(Math.min(hi, Math.max(lo, raw)));
  return {
    hardMinSec, hardMaxSec, targetDurationSec,
    targetBandMinSec: round2(Math.max(hardMinSec + BAND_EDGE_MARGIN_SEC, targetDurationSec - BAND_HALF_WIDTH_SEC)),
    targetBandMaxSec: round2(Math.min(hardMaxSec - BAND_EDGE_MARGIN_SEC, targetDurationSec + BAND_HALF_WIDTH_SEC)),
    targetSource: Number.isFinite(declared) ? 'storyScope.targetDurationSec' : 'hard-range midpoint'
  };
}
// Both directions explicit. deltaFromTargetSec is signed (+ = too long). The
// UNDER-direction fields (missingTo*) exist only when the timeline is below target,
// so an over-long timeline never reports a misleading "missingToTargetSec: 0".
function durationDelta(totalSec, { hardMinSec, hardMaxSec, targetDurationSec, targetBandMinSec = null, targetBandMaxSec = null }) {
  const t = round2(totalSec);
  const out = {
    currentDurationSec: t, minimumDurationSec: hardMinSec, maximumDurationSec: hardMaxSec, targetDurationSec,
    ...(Number.isFinite(targetBandMinSec) && Number.isFinite(targetBandMaxSec) ? { targetBandMinSec, targetBandMaxSec } : {}),
    deficitBelowMinimumSec: round2(Math.max(0, hardMinSec - totalSec)),
    excessAboveMaximumSec: round2(Math.max(0, totalSec - hardMaxSec)),
    deltaFromTargetSec: round2(totalSec - targetDurationSec)
  };
  if (totalSec > targetDurationSec) {
    out.requiredReductionToMaximumSec = out.excessAboveMaximumSec;
    out.preferredReductionToTargetSec = round2(totalSec - targetDurationSec);
    if (out.targetBandMinSec !== undefined) {
      out.preferredReductionRangeSec = { minSec: round2(Math.max(0, totalSec - targetBandMaxSec)), maxSec: round2(Math.max(0, totalSec - targetBandMinSec)) };
    }
  } else {
    out.missingToMinimumSec = out.deficitBelowMinimumSec;
    out.missingToTargetSec = round2(Math.max(0, targetDurationSec - totalSec));
  }
  return out;
}
const DURATION_CODES = new Set(['TOTAL_DURATION_UNDER_MIN', 'TOTAL_DURATION_OVER_MAX']);
const onlyDurationViolations = vs => Array.isArray(vs) && vs.length > 0 && vs.every(v => DURATION_CODES.has(v.code));

// Deterministic TECHNICAL range reconciliation for a sub-second deficit. Allowed only
// when duration is the ONLY violation and the deficit is <= 1.0s. Extends ONE existing
// beat into contiguous, already-watched footage of the SAME reel segment and SAME
// logical scope window, without touching any other selected source range. No new
// event or story material is introduced; nothing is padded or frozen.
function technicalDurationAdjustment(spine, reel, { hardMinSec, durationSec = Infinity, maxDeficitSec = TECHNICAL_ADJUST_MAX_DEFICIT_SEC } = {}) {
  const beats = spine?.beats || [];
  const total = timelineSec(beats);
  const need = round2(Math.ceil((hardMinSec - total) * 100 - 1e-6) / 100);
  if (!(need > 0)) return { applied: false, reason: 'no deficit' };
  if (need > maxDeficitSec + 1e-9) return { applied: false, reason: `deficit ${need}s exceeds ${maxDeficitSec}s` };
  const rows = (reel?.ranges || []).map(r => ({
    row: r,
    lo: Math.max(num(r.sourceStartSec), Number.isFinite(num(r.windowStartSec)) ? num(r.windowStartSec) : -Infinity, 0),
    hi: Math.min(num(r.sourceEndSec), Number.isFinite(num(r.windowEndSec)) ? num(r.windowEndSec) : Infinity, durationSec)
  })).filter(r => r.hi > r.lo);
  const others = i => beats.filter((_, j) => j !== i).map(b => [num(b.sourceStartSec), num(b.sourceEndSec)]);
  const free = (i, a, z) => others(i).every(([s, e]) => Math.min(e, z) - Math.max(s, a) <= 1e-6);
  const options = [];
  beats.forEach((b, i) => {
    const s = num(b.sourceStartSec), e = num(b.sourceEndSec);
    const home = rows.find(r => s >= r.lo - 1e-6 && e <= r.hi + 1e-6); // beat fully inside one cuttable range
    if (!home) return;
    if (e + need <= home.hi + 1e-6 && free(i, e, e + need)) options.push({ i, side: 'end', room: home.hi - e, home });
    if (s - need >= home.lo - 1e-6 && free(i, s - need, s)) options.push({ i, side: 'start', room: s - home.lo, home });
  });
  if (!options.length) return { applied: false, reason: 'no contiguous watched footage inside the same scope window without overlapping another beat' };
  // Deterministic choice: extend an end before a start; most room; earliest beat.
  options.sort((a, b) => (a.side === b.side ? 0 : a.side === 'end' ? -1 : 1) || (b.room - a.room) || (a.i - b.i));
  const o = options[0];
  const b = beats[o.i];
  const newStart = o.side === 'start' ? round2(num(b.sourceStartSec) - need) : num(b.sourceStartSec);
  const newEnd = o.side === 'end' ? round2(num(b.sourceEndSec) + need) : num(b.sourceEndSec);
  const adjustment = {
    beatId: b.beatId, side: o.side, oldStartSec: num(b.sourceStartSec), oldEndSec: num(b.sourceEndSec), newStartSec: newStart, newEndSec: newEnd,
    addedSec: need, sourceWindowId: o.home.row.scopeWindowId || null, segmentId: o.home.row.segmentId || null,
    reason: `technical range reconciliation: ${round2(total)}s -> ${round2(total + need)}s (hard minimum ${hardMinSec}s)`
  };
  const adjusted = { ...spine, beats: beats.map((x, j) => (j === o.i ? { ...x, sourceStartSec: newStart, sourceEndSec: newEnd } : x)) };
  return { applied: true, spine: adjusted, adjustment };
}

// Share of a beat that lies inside CUTTABLE footage: media the director was shown
// (reel segment) AND inside the segment's original logical scope window (context
// padding and compaction gaps are watchable but not cuttable).
function cuttableRanges(reelRanges) {
  return Packer.mergeIntervals((reelRanges || []).map(r => [
    Math.max(num(r.sourceStartSec), Number.isFinite(num(r.windowStartSec)) ? num(r.windowStartSec) : -Infinity),
    Math.min(num(r.sourceEndSec), Number.isFinite(num(r.windowEndSec)) ? num(r.windowEndSec) : Infinity)
  ]));
}
function coveredByReel(b, reelRanges) {
  const s = num(b.sourceStartSec), e = num(b.sourceEndSec);
  if (!(e > s)) return 0;
  const inside = cuttableRanges(reelRanges).reduce((n, [rs, re]) => n + Math.max(0, Math.min(e, re) - Math.max(s, rs)), 0);
  return inside / (e - s);
}

function validateDirectorEdl(spine, scope, { durationSec, targetDurationMinSec = 65, targetDurationMaxSec = 90, reel, narrationEnabled = true, preferredDurationSec = null, targetBandMinSec = null, targetBandMaxSec = null, requireDeliveryBlocks = false } = {}) {
  const violations = [];
  const add = (code, message, extra = {}) => violations.push({ code, message, ...extra });
  const beats = Array.isArray(spine?.beats) ? spine.beats : [];
  if (!beats.length) {
    add('EMPTY_BEATS', 'The EDL contains no beats.');
    return { valid: false, violations, metrics: { totalSec: 0, beatCount: 0 } };
  }
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Infinity;
  const reelRanges = reel?.ranges || [];
  const ids = new Set();
  // Delivery blocks: STRUCTURE only. When valid, each beat's audio follows its block.
  let audioBeats = beats;
  if (requireDeliveryBlocks || spine?.deliveryBlocks !== undefined) {
    const blockViolations = Delivery.validateDeliveryBlocks(beats, spine?.deliveryBlocks, { narrationEnabled });
    violations.push(...blockViolations);
    if (!blockViolations.length) audioBeats = Delivery.applyDeliveryBlocks(beats, spine.deliveryBlocks);
  }

  beats.forEach((b, i) => {
    const id = b.beatId || `#${i}`;
    if (ids.has(id)) add('DUPLICATE_BEAT_ID', `beatId '${id}' is used more than once.`, { beatId: id });
    ids.add(id);
    const s = num(b.sourceStartSec), e = num(b.sourceEndSec);
    if (!(Number.isFinite(s) && Number.isFinite(e)) || s < 0 || e > dur + 1e-6 || e <= s) {
      add('SOURCE_OUT_OF_BOUNDS', `Beat '${id}' has invalid source range ${b.sourceStartSec}-${b.sourceEndSec}s (source is 0-${round2(dur)}s).`, { beatId: id });
      return;
    }
    if (e - s < MIN_BEAT_SEC) add('BEAT_TOO_SHORT', `Beat '${id}' is ${round2(e - s)}s; every beat must be at least ${MIN_BEAT_SEC}s to be playable.`, { beatId: id });
    const cov = coveredByReel(b, reelRanges);
    if ((e - s) * (1 - cov) > GROUNDING_TOLERANCE_SEC) {
      add('OUTSIDE_SCOPE_REEL', `Beat '${id}' (${s}-${e}s) is not inside watched footage of a logical scope window (${Math.round(cov * 100)}% inside). Cut only from the manifest segments' source ranges, inside their scope windows.`, { beatId: id, coverage: round2(cov) });
    }
    if (!String(b.observedInFootage || '').trim()) add('BEAT_NOT_GROUNDED', `Beat '${id}' has no observedInFootage: say what is seen/heard in that range.`, { beatId: id });
    if (!String(b.whyNecessaryNow || '').trim()) add('BEAT_UNJUSTIFIED', `Beat '${id}' has no whyNecessaryNow.`, { beatId: id });
    if (!narrationEnabled && audioBeats[i].audioMode && audioBeats[i].audioMode !== 'original_audio' && !audioBeats[i].deliveryBlockId) {
      add('NARRATION_DISABLED', `Beat '${id}' uses ${b.audioMode} but narration is disabled for this project; use original_audio.`, { beatId: id });
    }
  });

  // Exact duplicate guard: identical footage with identical audio treatment.
  for (let i = 0; i < beats.length; i++) {
    for (let j = i + 1; j < beats.length; j++) {
      const a = beats[i], c = beats[j];
      if (Math.abs(num(a.sourceStartSec) - num(c.sourceStartSec)) <= DUP_EPS && Math.abs(num(a.sourceEndSec) - num(c.sourceEndSec)) <= DUP_EPS && (audioBeats[i].audioMode || '') === (audioBeats[j].audioMode || '')) {
        add('EXACT_EDL_DUPLICATE', `Beat '${c.beatId}' repeats the exact footage and audio of '${a.beatId}' (${a.sourceStartSec}-${a.sourceEndSec}s).`, { firstBeatId: a.beatId, secondBeatId: c.beatId });
      }
    }
  }

  const total = timelineSec(beats);
  const preferred = Number.isFinite(preferredDurationSec) ? preferredDurationSec : (targetDurationMinSec + targetDurationMaxSec) / 2;
  const deltaTargets = { hardMinSec: targetDurationMinSec, hardMaxSec: targetDurationMaxSec, targetDurationSec: preferred, targetBandMinSec, targetBandMaxSec };
  if (total < targetDurationMinSec - DUR_EPS) {
    const d = durationDelta(total, deltaTargets);
    add('TOTAL_DURATION_UNDER_MIN', `The timeline is ${d.currentDurationSec}s: ${d.missingToMinimumSec}s below the hard minimum (${targetDurationMinSec}s) and ${d.missingToTargetSec}s below the preferred target (${d.targetDurationSec}s). Do not add only ${d.missingToMinimumSec}s — repair toward approximately ${d.targetDurationSec}s.`, { totalSec: d.currentDurationSec, ...d });
  }
  if (total > targetDurationMaxSec + DUR_EPS) {
    const d = durationDelta(total, deltaTargets);
    const range = d.preferredReductionRangeSec ? ` (${d.preferredReductionRangeSec.minSec}-${d.preferredReductionRangeSec.maxSec}s for the ${d.targetBandMinSec}-${d.targetBandMaxSec}s band)` : '';
    add('TOTAL_DURATION_OVER_MAX', `The timeline is ${d.currentDurationSec}s: ${d.excessAboveMaximumSec}s above the hard maximum (${targetDurationMaxSec}s) and ${d.deltaFromTargetSec}s above the preferred target (${d.targetDurationSec}s). Remove at least ${d.requiredReductionToMaximumSec}s, preferably about ${d.preferredReductionToTargetSec}s${range}.`, { totalSec: d.currentDurationSec, ...d });
  }

  if (toV2Role(beats[0].narrativeRole) !== 'hook') {
    add('FIRST_BEAT_NOT_HOOK', `The first beat '${beats[0].beatId}' has role '${beats[0].narrativeRole}'; the opening must use a hook role.`, { beatId: beats[0].beatId });
  }

  // Ending must be one of the scope's declared consequence endings (Gemini's own declaration).
  const last = beats[beats.length - 1];
  const endingRanges = [
    ...(scope?.candidateEndingEvents || []).map(e => [num(e.sourceStartSec), num(e.sourceEndSec)]),
    ...(scope?.scopeWindows || []).filter(w => w.purpose === 'ending_material').map(w => [num(w.startSec), num(w.endSec)])
  ].filter(([s, e]) => e > s);
  const ls = num(last.sourceStartSec), le = num(last.sourceEndSec);
  if (endingRanges.length && !endingRanges.some(([s, e]) => Math.min(le, e) - Math.max(ls, s) > 0)) {
    add('ENDING_NOT_IN_SCOPE', `The final beat '${last.beatId}' (${ls}-${le}s) is not one of the scope's candidate endings or ending_material windows.`, { beatId: last.beatId });
  }

  return { valid: violations.length === 0, violations, metrics: { totalSec: round2(total), beatCount: beats.length } };
}

// Scope-local slice of the Source Story Model: only what the reel covers.
function modelContextForReel(model, reel) {
  const inReel = (s, e) => (reel?.ranges || []).some(r => Math.min(e, r.sourceEndSec) - Math.max(s, r.sourceStartSec) > 0);
  const events = (model?.events || []).filter(e => inReel(num(e.startSec), num(e.endSec)))
    .map(e => ({ id: e.id, startSec: e.startSec, endSec: e.endSec, type: e.type, summary: e.summary, location: e.location, peopleIds: e.peopleIds }));
  const quotes = (model?.quotes || []).filter(q => inReel(num(q.startSec), num(q.endSec)))
    .map(q => ({ id: q.id, eventId: q.eventId, speaker: q.speaker, startSec: q.startSec, endSec: q.endSec, text: q.text, epistemic: q.epistemic }));
  return { people: model?.people || [], events, quotes };
}

// ---------------------------------------------------------------- output fuse
// Compact, bounded stats of a (possibly huge) raw director response. Never
// returns the text itself beyond short samples.
function diagnoseDirectorOutput(rawText) {
  const s = String(rawText || '');
  const ids = [...s.matchAll(/"beatId"\s*:\s*"([^"]*)"/g)].map(m => m[1]);
  let longest = { key: null, chars: 0 };
  for (const m of s.matchAll(/"([A-Za-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)("?)/g)) {
    if (m[2].length > longest.chars) longest = { key: m[1], chars: m[2].length, closed: m[3] === '"' };
  }
  const counts = new Map();
  for (const sentence of s.split(/(?<=[.!?])\s+/)) {
    const t = sentence.trim();
    if (t.length >= 20) counts.set(t, (counts.get(t) || 0) + 1);
  }
  let top = { count: 0, sample: '' };
  for (const [t, c] of counts) if (c > top.count) top = { count: c, sample: t.slice(0, 160) };
  const unclosed = !/}\s*$/.test(s.trim());
  const classification = top.count >= 20 || longest.chars > MAX_DIRECTOR_TEXT_CHARS ? 'repetition_loop'
    : ids.length > schemas.directorSpine.properties.beats.maxItems ? 'runaway_beats'
      : unclosed ? 'truncated' : 'complete_json';
  return { chars: s.length, beatIdCount: ids.length, uniqueBeatIds: new Set(ids).size, lastBeatId: ids[ids.length - 1] || null,
    longestString: longest, topRepeatedSentence: top, endsInsideString: longest.closed === false, classification,
    head: s.slice(0, 160), tail: s.slice(-160) };
}

function oversizedText(v, pathLabel = '', out = []) {
  if (typeof v === 'string') { if (v.length > MAX_DIRECTOR_TEXT_CHARS) out.push({ path: pathLabel, chars: v.length }); }
  else if (Array.isArray(v)) v.forEach((x, i) => oversizedText(x, `${pathLabel}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) oversizedText(x, pathLabel ? `${pathLabel}.${k}` : k, out);
  return out;
}

// A degenerate generation is not a repairable EDL: re-sending it as "previous
// artifact" would only re-feed the loop. Fail fast with compact stats.
function assertNotDegenerate(v) {
  const big = oversizedText(v);
  if (big.length) {
    throw new StoryError('DIRECTOR_OUTPUT_DEGENERATE',
      `Editorial Director returned ${big.length} text field(s) over ${MAX_DIRECTOR_TEXT_CHARS} chars (${big.slice(0, 3).map(b => `${b.path}=${b.chars}`).join(', ')}); generation degenerated. Not imported, not repaired.`,
      { oversized: big.slice(0, 10) });
  }
}

function validateShape(v) {
  if (!v || !v.spine || !Array.isArray(v.spine.beats) || !v.spine.beats.length) throw new StoryError('INVALID_RESPONSE', 'Editorial Director returned no beats.');
  assertNotDegenerate(v);
  if (v.accessGranted !== true) throw new StoryError('INVALID_RESPONSE', 'Editorial Director did not confirm watching the attached scope reel (accessGranted must be true).');
  return v;
}

const NON_REPAIRABLE_OUTPUT = new Set(['DIRECTOR_OUTPUT_LIMIT', 'DIRECTOR_OUTPUT_DEGENERATE']);

// Provider MAX_TOKENS: the stage has already kept the raw text and refused to
// parse it. Turn it into a typed, non-repairable director failure with telemetry.
function outputLimitError(engine, key, cause) {
  const vertex = engine?.service?.vertex || {};
  const meta = vertex.lastResponseMetadata || {};
  const u = meta.usage || {};
  const diagnosis = diagnoseDirectorOutput(vertex.lastResponseText || '');
  const telemetry = { finishReason: meta.finishReason || 'MAX_TOKENS', promptTokenCount: u.promptTokenCount ?? null,
    candidatesTokenCount: u.candidatesTokenCount ?? null, thoughtsTokenCount: u.thoughtsTokenCount ?? 0, totalTokenCount: u.totalTokenCount ?? null,
    requestedMaxOutputTokens: meta.requestedMaxOutputTokens ?? null, requestedThinkingBudget: meta.requestedThinkingBudget ?? null, modelMs: meta.modelMs ?? null };
  return new StoryError('DIRECTOR_OUTPUT_LIMIT',
    `Editorial Director hit the output ceiling (${telemetry.finishReason}; candidates ${telemetry.candidatesTokenCount}, thoughts ${telemetry.thoughtsTokenCount}, max ${telemetry.requestedMaxOutputTokens}). Raw response kept as ${key}-raw-response.txt (${diagnosis.chars} chars, ${diagnosis.beatIdCount} beat id(s), ${diagnosis.classification}${diagnosis.topRepeatedSentence.count > 1 ? `, top sentence x${diagnosis.topRepeatedSentence.count}` : ''}). Partial JSON not imported; the request is not resent automatically.`,
    { key, telemetry, diagnosis, cause: cause?.message || String(cause) });
}

// Schema/shape failures are repairable like any other violation: the invalid
// artifact is handed back to the director instead of aborting the run.
// Output-limit / degenerate generations are NOT: they fail fast.
async function callDirector(engine, key, input, instr, evidence, shape) {
  try {
    return { result: await engine.ask(key, input, schemas.directorEdl, instr, evidence, shape, 'auto_story_edit', { ...DIRECTOR_GENERATION }) };
  } catch (e) {
    if (NON_REPAIRABLE_OUTPUT.has(e?.kind)) throw e;
    if (/MAX_TOKENS/.test(e?.message || '')) throw outputLimitError(engine, key, e);
    if (e?.invalidArtifact === undefined && e?.kind !== 'INVALID_RESPONSE') throw e;
    return { result: e.invalidArtifact || null, schemaError: e.message };
  }
}
const askDirector = (engine, key, input, instr, evidence) => callDirector(engine, key, input, instr, evidence, validateShape);

// Stamp the director contract onto a validated spine. The scope and reel ride
// along so render/critic/repair all see exactly what the director saw.
function stampSpine(spine, scope, reel, meta = {}) {
  return {
    ...spine,
    editorialContract: DIRECTOR_CONTRACT,
    storyScope: scope,
    scopeReel: reel,
    beats: deliveryBeats(spine).map((b, i) => ({ ...b, beatIndex: i, castLock: DIRECTOR_CONTRACT })),
    deliveryContract: Array.isArray(spine.deliveryBlocks) ? Delivery.DELIVERY_CONTRACT : undefined,
    directorMeta: meta
  };
}

// Each beat's technical audio mode follows its (structurally valid) delivery block.
function deliveryBeats(spine) {
  const beats = spine?.beats || [];
  if (!Array.isArray(spine?.deliveryBlocks)) return beats;
  if (Delivery.validateDeliveryBlocks(beats, spine.deliveryBlocks).length) return beats;
  return Delivery.applyDeliveryBlocks(beats, spine.deliveryBlocks);
}

function isDirectorSpine(spine) { return spine?.editorialContract === DIRECTOR_CONTRACT; }

// ---------------------------------------------------------------- Gemini stage
// Media packing: logical scope windows -> composite reel files (<= provider
// video-file limit) with an exact reel->source manifest. Cached by content hash,
// so repairs reuse the same files.
async function prepareReel(engine, scope, model = null) {
  const cfg = engine.config || {};
  const reel = Scope.planScopeReel(scope, { durationSec: engine.duration, paddingSec: cfg.scopeReelPaddingSec ?? Scope.DEFAULT_REEL_PADDING_SEC,
    maxScopeReelSec: cfg.maxScopeReelSec || Scope.DEFAULT_MAX_SCOPE_REEL_SEC, model, maxReelFiles: cfg.maxReelFiles || undefined });
  if (!reel.ranges.length) throw new StoryError('STORY_SCOPE_INVALID', 'Story Scope has no reel windows.');
  if (reel.fileCount > reel.maxReelFiles) throw new StoryError('STORY_SCOPE_INVALID', `Reel packs into ${reel.fileCount} files; provider limit is ${reel.maxReelFiles}.`);
  const evidence = await Packer.buildReelFiles(engine, reel, { fps: cfg.directorReelFps || DIRECTOR_REEL_FPS });
  return { reel, evidence };
}

// One director pass (initial or repair) followed by <=maxTechnicalRepairs technical
// repair passes. Returns { spine, report, evidence, reel, attempts }.
const DURATION_REPAIR_INSTRUCTION = `LIGHTWEIGHT DURATION REPAIR (text-only: NO video is attached to this request, and none is needed).
You already watched the scope reel in a previous pass. What you saw is recorded in input.currentEdl (each beat's observedInFootage) and input.reelObservations; input.cuttableRanges lists the watched, in-scope source ranges (reel segment ∩ logical scope window) you may cut from; input.scopeReelManifest maps them to reel files.
The EDL is story-complete and media-grounded. ONLY its total duration is wrong — see input.durationRepair (currentDurationSec, minimumDurationSec, targetDurationSec, missingToMinimumSec, missingToTargetSec) and input.violations.
Return the COMPLETE EDL with its total inside input.targetBandMinSec..input.targetBandMaxSec, preferably about input.targetDurationSec. Do not repair only to the hard minimum.
Allowed: lengthen existing beats inside the cuttable range that already contains them, and/or add beats from footage inside input.cuttableRanges that you already observed. Prefer recovering material you already watched next to existing beats.
Not allowed: footage outside input.cuttableRanges, overlapping another beat's source range, reordering or removing existing beats, new branches of the incident, or any change to the Story Scope. Keep beatIds, order and roles of existing beats. Return spine.deliveryBlocks covering every beat, including any beat you add (a new beat joins a block next to it, or gets its own).
Every beat keeps observedInFootage and whyNecessaryNow. Plan the beat lengths so their sum lands in the band; the JSON you return is final (no arithmetic, drafts or repeated text inside any field). Set accessGranted=true once you have read the EDL.`;

// OVER_MAX is COMPRESSION, a different operation from UNDER_MIN extension: the
// repaired EDL must be a shortened subset of the current one. JS supplies the
// arithmetic (beat budget table + required/preferred reductions); Gemini decides
// WHAT to cut. JS never selects story material.
const DURATION_COMPRESSION_INSTRUCTION = `DURATION COMPRESSION REPAIR (text-only: NO video is attached to this request, and none is needed).
Your EDL (input.currentEdl) is media-grounded but TOO LONG. This is COMPRESSION ONLY: return a shortened subset of input.currentEdl.
input.beatBudget lists every current beat: beatId, sourceStartSec, sourceEndSec, durationSec, narrativeRole, newInformation, whyNecessaryNow.
input.durationCompression gives the exact numbers: currentDurationSec, maximumDurationSec, requiredReductionToMaximumSec (you MUST remove at least this much), preferredReductionToTargetSec and preferredReductionRangeSec (remove about this much so the total lands inside targetBandMinSec..targetBandMaxSec).
Allowed: shorten an existing beat by trimming its start and/or its end INSIDE its current range; remove an existing beat that is redundant or least necessary to the central conflict.
Not allowed: new beats or new beatIds, moving any sourceStartSec earlier or any sourceEndSec later, new source material, reordering the surviving beats, any change to the Story Scope.
You decide what deserves time. Keep the moments that carry the central conflict; cut repetition, restated arguments, redundant context and slack inside long beats. The first beat keeps its hook role and the final beat remains the ending.
Surviving beats keep beatId, order and role; observedInFootage must still describe the trimmed range; every beat stays at least 1 second. Return spine.deliveryBlocks for the surviving beats (drop removed beatIds; keep each surviving beat in its block).
FINAL TIMELINE DURATION = sum(sourceEndSec - sourceStartSec) over every returned beat. The JSON you return is final: no arithmetic, drafts or repeated text inside any field. Set accessGranted=true once you have read the EDL.`;

const COMPRESSION_EPS_SEC = 0.05;   // float/rounding tolerance on a range edge
const STALL_EPS_SEC = 0.5;          // a "compression" that removes less than this made no progress

function beatBudget(edl) {
  return (edl?.beats || []).map(b => ({ beatId: b.beatId, sourceStartSec: b.sourceStartSec, sourceEndSec: b.sourceEndSec,
    durationSec: round2(beatLen(b)), narrativeRole: b.narrativeRole, newInformation: b.newInformation || '', whyNecessaryNow: b.whyNecessaryNow || '' }));
}

// Deterministic, monotonic contract of a compression response vs the EDL it compressed.
function compressionViolations(before, after) {
  const prev = before?.beats || [], next = after?.beats || [];
  const byId = new Map(prev.map(b => [b.beatId, b]));
  const out = [];
  if (next.length > prev.length) out.push({ code: 'COMPRESSION_BEAT_COUNT_INCREASED', message: `A compression repair may not add beats: ${prev.length} -> ${next.length}.` });
  const added = next.filter(b => !byId.has(b.beatId)).map(b => b.beatId);
  if (added.length) out.push({ code: 'COMPRESSION_ADDED_BEAT', message: `A compression repair may not introduce new beats: ${added.join(', ')}.`, beatIds: added });
  const expanded = next.filter(b => byId.has(b.beatId)).filter(b => {
    const o = byId.get(b.beatId);
    return num(b.sourceStartSec) < num(o.sourceStartSec) - COMPRESSION_EPS_SEC || num(b.sourceEndSec) > num(o.sourceEndSec) + COMPRESSION_EPS_SEC;
  }).map(b => {
    const o = byId.get(b.beatId);
    return `${b.beatId} ${o.sourceStartSec}-${o.sourceEndSec}s -> ${b.sourceStartSec}-${b.sourceEndSec}s`;
  });
  if (expanded.length) out.push({ code: 'COMPRESSION_RANGE_EXPANDED', message: `A compression repair may only trim inside a beat's current range: ${expanded.join('; ')}.` });
  const keptIds = next.map(b => b.beatId).filter(id => byId.has(id));
  const expectedOrder = prev.map(b => b.beatId).filter(id => keptIds.includes(id));
  if (keptIds.join('|') !== expectedOrder.join('|')) out.push({ code: 'COMPRESSION_REORDERED', message: 'A compression repair must keep the surviving beats in their original order.' });
  const t0 = timelineSec(prev), t1 = timelineSec(next);
  const sameRanges = next.length === prev.length && next.every((b, i) => b.beatId === prev[i].beatId
    && Math.abs(num(b.sourceStartSec) - num(prev[i].sourceStartSec)) <= COMPRESSION_EPS_SEC && Math.abs(num(b.sourceEndSec) - num(prev[i].sourceEndSec)) <= COMPRESSION_EPS_SEC);
  if (sameRanges || Math.abs(t0 - t1) < STALL_EPS_SEC) {
    out.push({ code: 'DURATION_REPAIR_STALLED', message: `The compression repair did not materially change the timeline (${round2(t0)}s -> ${round2(t1)}s${sameRanges ? ', same source ranges' : ''}).`, beforeSec: round2(t0), afterSec: round2(t1) });
  } else if (t1 >= t0) {
    out.push({ code: 'COMPRESSION_NOT_SHORTER', message: `A compression repair must reduce the total: ${round2(t0)}s -> ${round2(t1)}s.`, beforeSec: round2(t0), afterSec: round2(t1) });
  }
  return out;
}

function compressionReminder(d, previous) {
  const band = d.preferredReductionRangeSec ? ` (${d.preferredReductionRangeSec.minSec}-${d.preferredReductionRangeSec.maxSec}s puts it inside ${d.targetBandMinSec}-${d.targetBandMaxSec}s)` : '';
  const lines = [`CURRENT TOTAL ${d.currentDurationSec}s. You still need to remove at least ${d.requiredReductionToMaximumSec} seconds to satisfy the hard maximum (${d.maximumDurationSec}s) and approximately ${d.preferredReductionToTargetSec} seconds to reach the preferred target (${d.targetDurationSec}s)${band}.`];
  if (previous) lines.push(`Your previous compression attempt (${previous.beforeSec}s -> ${previous.afterSec}s) ${previous.accepted ? 'did not remove enough' : `was rejected: ${previous.codes.join(', ')}`}. Do not return the same ranges again; trims that change only text do not count.`);
  return lines.join('\n');
}

function validateTextShape(v) {
  if (!v || !v.spine || !Array.isArray(v.spine.beats) || !v.spine.beats.length) throw new StoryError('INVALID_RESPONSE', 'Duration repair returned no beats.');
  assertNotDegenerate(v);
  return v;
}

// Existing beats must survive a duration-only repair unchanged in identity and order.
function storyPreservationViolations(before, after, { allowRemoval = false } = {}) {
  const prev = (before?.beats || []).map(b => b.beatId);
  const nextIds = (after?.beats || []).map(b => b.beatId);
  const kept = nextIds.filter(id => prev.includes(id));
  const out = [];
  const missing = prev.filter(id => !nextIds.includes(id));
  if (missing.length && !allowRemoval) out.push({ code: 'DURATION_REPAIR_REMOVED_BEATS', message: `A duration-only repair must keep every existing beat; missing: ${missing.join(', ')}.` });
  const expected = prev.filter(id => kept.includes(id));
  if (kept.join('|') !== expected.join('|')) out.push({ code: 'DURATION_REPAIR_REORDERED', message: 'A duration-only repair must keep the existing beats in their original order.' });
  return out;
}

async function runDirector(engine, { model, scope, reel, evidence, key, extraInput = {}, repairText = null, root, write, emit = () => {}, maxTechnicalRepairs = 2 }) {
  const cfg = engine.config || {};
  const targets = durationTargets(scope, cfg);
  const baseInput = {
    storyScope: scope,
    // Full reel->source mapping: every attached file, its segments, and the logical
    // scope window each segment belongs to.
    scopeReelManifest: reel.manifest,
    scopeReelFiles: reel.files,
    sourceDurationSec: engine.duration,
    targetDurationMinSec: targets.hardMinSec,
    targetDurationMaxSec: targets.hardMaxSec,
    targetDurationSec: targets.targetDurationSec,
    targetBandMinSec: targets.targetBandMinSec,
    targetBandMaxSec: targets.targetBandMaxSec,
    storyMode: cfg.storyMode || 'serialized_part',
    narrationEnabled: cfg.narration?.enabled !== false,
    narrationWordsPerSecond: cfg.narration?.measuredWordsPerSecond || null,
    modelContext: modelContextForReel(model, reel),
    ...extraInput
  };
  const valOpts = { durationSec: engine.duration, targetDurationMinSec: targets.hardMinSec, targetDurationMaxSec: targets.hardMaxSec, reel,
    narrationEnabled: baseInput.narrationEnabled, preferredDurationSec: targets.targetDurationSec,
    targetBandMinSec: targets.targetBandMinSec, targetBandMaxSec: targets.targetBandMaxSec, requireDeliveryBlocks: true };
  const cuttable = cuttableRanges(reel.ranges).map(([s, e]) => ({ sourceStartSec: round2(s), sourceEndSec: round2(e),
    scopeWindowId: (reel.ranges || []).find(r => s >= num(r.sourceStartSec) - 1e-6 && e <= num(r.sourceEndSec) + 1e-6)?.scopeWindowId || null }));
  const attempts = [];
  let violations = null, current = extraInput.currentEdl || null, reelObservations = '', previousCompression = null;
  for (let attempt = 0; attempt <= maxTechnicalRepairs; attempt++) {
    const technical = attempt > 0;
    // Once the EDL is media-grounded and ONLY duration is wrong, repair it with a
    // lightweight text-only director call instead of re-watching all reel files.
    // UNDER_MIN extends; OVER_MAX compresses (a distinct, monotonic operation).
    const durationOnly = technical && current && onlyDurationViolations(violations);
    const compress = durationOnly && violations.some(v => v.code === 'TOTAL_DURATION_OVER_MAX');
    let result, schemaError, mode, callKey, compressionDelta = null;
    if (compress) {
      mode = 'duration_compression'; callKey = `${key}_compress${attempt}`;
      compressionDelta = durationDelta(timelineSec(current.beats), targets);
      const input = { ...baseInput, currentEdl: current, violations, reelObservations, beatBudget: beatBudget(current),
        durationCompression: compressionDelta, ...(previousCompression ? { previousCompression } : {}) };
      const instr = `${DURATION_COMPRESSION_INSTRUCTION}\n${compressionReminder(compressionDelta, previousCompression)}`;
      ({ result, schemaError } = await callDirector(engine, callKey, input, instr, [], validateTextShape));
    } else if (durationOnly) {
      mode = 'duration_lightweight'; callKey = `${key}_duration${attempt}`;
      const input = { ...baseInput, currentEdl: current, violations, reelObservations, cuttableRanges: cuttable,
        durationRepair: durationDelta(timelineSec(current.beats), targets) };
      ({ result, schemaError } = await callDirector(engine, callKey, input, DURATION_REPAIR_INSTRUCTION, [], validateTextShape));
    } else {
      mode = technical ? 'multimodal_technical' : 'multimodal'; callKey = `${key}${technical ? `_fix${attempt}` : ''}`;
      const input = technical ? { ...baseInput, currentEdl: current, violations } : baseInput;
      const instr = [instruction, repairText, technical ? repairInstruction('technical', { violations }) : null].filter(Boolean).join('\n\n');
      // Repairs are cacheable: their fingerprint already includes currentEdl + violations
      // (+ critic findings), so a resumed run reuses them instead of re-paying.
      ({ result, schemaError } = await askDirector(engine, callKey, input, instr, evidence));
    }
    let spine = result?.spine || null;
    // A compression may remove beats: drop block references to beats that no longer exist.
    if (spine && mode === 'duration_compression' && Array.isArray(spine.deliveryBlocks)) {
      spine = { ...spine, deliveryBlocks: Delivery.pruneRemovedBeats(spine.deliveryBlocks, spine.beats) };
    }
    let report = schemaError
      ? { valid: false, violations: [{ code: 'SCHEMA_INVALID', message: `Response did not match the EDL contract: ${schemaError}` }], metrics: {} }
      : validateDirectorEdl(spine, scope, valOpts);
    if (!schemaError && mode === 'duration_lightweight') {
      const extra = storyPreservationViolations(current, spine, { allowRemoval: violations.some(v => v.code === 'TOTAL_DURATION_OVER_MAX') });
      if (extra.length) report = { ...report, valid: false, violations: [...report.violations, ...extra] };
    }
    let monotonic = null;
    if (mode === 'duration_compression' && !schemaError) {
      monotonic = compressionViolations(current, spine);
      if (monotonic.length) report = { ...report, valid: false, violations: [...monotonic, ...report.violations] };
    }
    const textOnly = mode === 'duration_lightweight' || mode === 'duration_compression';
    if (result?.reelObservations && !textOnly) reelObservations = result.reelObservations;
    const entry = { attempt, mode, valid: report.valid, violations: report.violations, metrics: report.metrics, mediaFiles: textOnly ? 0 : evidence.length,
      ...(compressionDelta ? { durationCompression: compressionDelta, beatCountBefore: current.beats.length, beatCountAfter: spine?.beats?.length ?? null } : {}) };
    attempts.push(entry);
    if (write && root) await write(path.join(root, `${callKey}.json`), { mode, result, validation: report,
      ...(compressionDelta ? { durationCompression: compressionDelta, beatCountBefore: entry.beatCountBefore, beatCountAfter: entry.beatCountAfter } : {}) });
    if (report.valid) return { spine, report, reelObservations: reelObservations || result.reelObservations, attempts };

    if (mode === 'duration_compression') {
      const before = compressionDelta.currentDurationSec, after = spine ? round2(timelineSec(spine.beats)) : null;
      if ((monotonic || []).some(v => v.code === 'DURATION_REPAIR_STALLED')) {
        // Same ranges / same total: another equivalent call would be wasted.
        emit('design', `[Director] Duration compression stalled (${before}s -> ${after}s); stopping.`, 'WARNING');
        throw new StoryError('DIRECTOR_EDL_INVALID', `Editorial Director duration compression stalled at ${after}s (hard maximum ${targets.hardMaxSec}s): DURATION_REPAIR_STALLED`,
          { violations: report.violations, attempts, spine: current, stalled: true });
      }
      const rejected = schemaError ? ['SCHEMA_INVALID'] : (monotonic || []).map(v => v.code);
      if (rejected.length) {
        // Rejected response: keep compressing the last accepted EDL.
        previousCompression = { beforeSec: before, afterSec: after, accepted: false, codes: rejected };
        emit('design', `[Director] Compression response rejected (${rejected.join(', ')}); retrying from ${before}s.`, 'WARNING');
        continue;
      }
      // Monotonic progress (e.g. 163s -> 108s) is kept; the remaining violations drive the next pass.
      previousCompression = { beforeSec: before, afterSec: after, accepted: true, codes: [] };
    }

    // Sub-second deficit with no other violation: deterministic technical range
    // reconciliation inside already-watched, same-window footage; same validators rerun.
    if (spine && onlyDurationViolations(report.violations) && report.violations.every(v => v.code === 'TOTAL_DURATION_UNDER_MIN')) {
      const tech = technicalDurationAdjustment(spine, reel, { hardMinSec: targets.hardMinSec, durationSec: engine.duration });
      entry.technicalDurationAdjustment = tech.applied ? tech.adjustment : { applied: false, reason: tech.reason };
      if (tech.applied) {
        const recheck = validateDirectorEdl(tech.spine, scope, valOpts);
        entry.technicalRecheck = { valid: recheck.valid, violations: recheck.violations, metrics: recheck.metrics };
        if (write && root) await write(path.join(root, `${callKey}-technical-adjustment.json`), { technicalDurationAdjustment: tech.adjustment, validation: recheck });
        if (recheck.valid) {
          emit('design', `[Director] Technical duration adjustment: ${tech.adjustment.beatId} +${tech.adjustment.addedSec}s (${recheck.metrics.totalSec}s).`);
          return { spine: { ...tech.spine, technicalDurationAdjustment: tech.adjustment }, report: recheck, reelObservations: reelObservations || result.reelObservations, attempts, technicalDurationAdjustment: tech.adjustment };
        }
      }
    }
    emit('design', `[Director] EDL needs repair #${attempt + 1} (${onlyDurationViolations(report.violations) ? 'duration-only, lightweight' : 'multimodal'}): ${report.violations.map(v => v.code).join(', ')}`, 'WARNING');
    violations = report.violations; current = spine || current;
  }
  const lastViolations = attempts[attempts.length - 1]?.violations || violations;
  throw new StoryError('DIRECTOR_EDL_INVALID', `Editorial Director EDL failed validation after ${maxTechnicalRepairs} repair pass(es): ${lastViolations.map(v => v.code).join(', ')}`, { violations: lastViolations, attempts, spine: current });
}

async function directEdl(engine, { model, scope, root = null, write = null, emit = () => {}, scriptId = 1 }) {
  if (!scope) throw new StoryError('INPUT_MISSING', 'Editorial Director requires a selected Story Scope.');
  const { reel, evidence } = await prepareReel(engine, scope, model);
  emit('design', `[Director] Watching scope reel: ${reel.logicalWindowCount} logical window(s), ${reel.fileCount} reel file(s), ${reel.manifest.length} manifest segment(s), ${reel.totalSec}s of media (logical footage ${reel.logicalFootageSec}s).`);
  const out = await runDirector(engine, { model, scope, reel, evidence, key: `v5-editorial-director-${scriptId}`, root, write, emit });
  const spine = stampSpine(out.spine, scope, reel, { reelObservations: out.reelObservations, attempts: out.attempts });
  return { spine, evidence, reel, report: out.report };
}

// Repair from the RENDERED MP4 critique. Receives scope + complete current EDL +
// weak regions + the SAME scope reel media (cached proxies, not the whole source).
async function repairEdl(engine, { model, spine, critique, weakRegions = [], root = null, write = null, emit = () => {}, pass = 1, scriptId = 1 }) {
  if (!isDirectorSpine(spine)) throw new StoryError('INPUT_MISSING', 'repairEdl requires a director-owned spine.');
  const scope = spine.storyScope;
  const { reel, evidence } = await prepareReel(engine, scope, model);
  const currentEdl = { ...spine, storyScope: undefined, scopeReel: undefined, directorMeta: undefined };
  const out = await runDirector(engine, {
    model, scope, reel, evidence, key: `v5-editorial-director-repair-${scriptId}-${pass}`,
    extraInput: {
      currentEdl,
      weakRegions,
      criticFindings: { summary: critique?.summary || '', issues: critique?.issues || [], scopeSurvived: critique?.scopeSurvived, endingIsConsequence: critique?.endingIsConsequence }
    },
    repairText: repairInstruction('critic'),
    root, write, emit
  });
  const repaired = stampSpine(out.spine, scope, reel, { reelObservations: out.reelObservations, attempts: out.attempts, repairPass: pass });
  return { spine: repaired, evidence, reel, report: out.report, request: { scope, currentEdl, weakRegions, reel, evidenceFiles: evidence.map(e => e.file) } };
}

// Repair for a deterministic downstream finding (e.g. duration check in buildScript).
// Same owner, same scope, same reel; JS only reports the violation.
async function repairTechnical(engine, { model, spine, violations, root = null, write = null, emit = () => {}, scriptId = 1 }) {
  if (!isDirectorSpine(spine)) throw new StoryError('INPUT_MISSING', 'repairTechnical requires a director-owned spine.');
  const scope = spine.storyScope;
  const { reel, evidence } = await prepareReel(engine, scope, model);
  const currentEdl = { ...spine, storyScope: undefined, scopeReel: undefined, directorMeta: undefined };
  const out = await runDirector(engine, {
    model, scope, reel, evidence, key: `v5-editorial-director-downstream-fix-${scriptId}`,
    extraInput: { currentEdl, violations }, repairText: repairInstruction('technical', { violations }), root, write, emit
  });
  return { spine: stampSpine(out.spine, scope, reel, { reelObservations: out.reelObservations, attempts: out.attempts, downstreamRepair: true }), evidence, reel, report: out.report };
}

// Integrity check used by buildScript: downstream stages must hand the compiler
// exactly the director's ranges, in the director's order.
function assertEdlIntact(directorBeats, finalBeats, durationSec = Infinity) {
  const a = directorBeats || [], b = finalBeats || [];
  const fail = (message, extra) => { throw new StoryError('EDL_MUTATED', `Downstream stage altered the director EDL: ${message}`, extra); };
  if (a.length !== b.length) fail(`beat count ${a.length} -> ${b.length}`, { before: a.length, after: b.length });
  a.forEach((x, i) => {
    const y = b[i];
    if ((x.beatId || '') !== (y.beatId || '')) fail(`order/identity changed at index ${i} (${x.beatId} -> ${y.beatId})`, { index: i });
    const xs = Math.max(0, num(x.sourceStartSec)), xe = Math.min(durationSec, num(x.sourceEndSec));
    if (Math.abs(xs - num(y.sourceStartSec)) > 1e-6 || Math.abs(xe - num(y.sourceEndSec)) > 1e-6) {
      fail(`range of '${x.beatId}' changed ${x.sourceStartSec}-${x.sourceEndSec} -> ${y.sourceStartSec}-${y.sourceEndSec}`, { beatId: x.beatId });
    }
  });
  return true;
}

module.exports = {
  DIRECTOR_CONTRACT, SCOPE_MEMBERSHIP, schemas, instruction, repairInstruction,
  validateDirectorEdl, modelContextForReel, stampSpine, isDirectorSpine, prepareReel,
  directEdl, repairEdl, repairTechnical, runDirector, assertEdlIntact, timelineSec, coveredByReel,
  durationTargets, durationDelta, technicalDurationAdjustment, onlyDurationViolations, storyPreservationViolations, DURATION_REPAIR_INSTRUCTION,
  DURATION_COMPRESSION_INSTRUCTION, beatBudget, compressionViolations, compressionReminder,
  deliveryBeats, DIRECTOR_MAX_OUTPUT_TOKENS, DIRECTOR_THINKING_BUDGET, DIRECTOR_GENERATION, MAX_DIRECTOR_TEXT_CHARS, diagnoseDirectorOutput, validateShape
};
