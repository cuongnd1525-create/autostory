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
const { NARRATIVE_ROLES, NARRATOR_FUNCTIONS, FOOTAGE_FUNCTIONS, toV2Role } = require('./autoStoryV3Taxonomy');
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
const DIRECTOR_MAX_OUTPUT_TOKENS = 16000;
const DIRECTOR_THINKING_BUDGET = 0;
const DIRECTOR_GENERATION = Object.freeze({ maxOutputTokens: DIRECTOR_MAX_OUTPUT_TOKENS, thinkingBudget: DIRECTOR_THINKING_BUDGET });
const MAX_DIRECTOR_TEXT_CHARS = 2000;

const num = v => (Number.isFinite(Number(v)) ? Number(v) : NaN);
const round2 = n => Math.round(n * 100) / 100;

function resolveLiveActionBoundary({ liveActionEndSec = null, endingBoundary = null, scope = null, model = null, durationSec = Infinity } = {}) {
  const dur = Number.isFinite(num(durationSec)) && num(durationSec) > 0 ? num(durationSec) : Infinity;
  const candidates = [
    liveActionEndSec,
    endingBoundary?.liveActionEndSec,
    scope?.liveActionEndSec,
    scope?.endingBoundary?.liveActionEndSec,
    model?.liveActionEndSec,
    model?.endingBoundary?.liveActionEndSec,
    model?.liveActionBoundary?.liveActionEndSec
  ].map(num).filter(v => Number.isFinite(v) && v > 0);
  if (!candidates.length) return dur;
  return Math.min(dur, ...candidates);
}

// ---------------------------------------------------------------- schema
const flexible = (required, optional = {}) => ({ type: 'object', required: Object.keys(required), properties: { ...required, ...optional }, additionalProperties: true });
const text = { type: 'string' };
const number = { type: 'number' };
const boolean = { type: 'boolean' };
const list = (items, maxItems = 40) => ({ type: 'array', items, maxItems });
const choice = (...values) => ({ type: 'string', enum: values });

const SCOPE_MEMBERSHIP = ['hook', 'core', 'supporting_context', 'bridge_picture', 'ending'];
const PACING_MODES = ['commentary_led', 'evidence_heavy'];

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
  audioMode: choice('original_audio', 'voiceover_with_ambient', 'voiceover_only'),
  wantsNarration: boolean,
  narratorFunction: choice(...NARRATOR_FUNCTIONS, 'NONE'),
  footageFunction: choice(...FOOTAGE_FUNCTIONS),
  narrationIntent: text,
  sourceEventId: text,
  viewerQuestion: text,
  payoffTiming: choice('immediate', 'delayed', 'part_2', 'none'),
  isForwardConsequence: boolean,
  expectedNextConsequence: text,
  cliffhangerQuestion: text,
  whyCutHere: text
});

const OPENING_STRATEGIES = ['chronological', 'conflict_teaser_rewind'];
const openingStrategy = flexible({
  chronologicalOption: text,
  conflictTeaserOption: text,
  chosen: choice(...OPENING_STRATEGIES),
  why: text
});

const narrativePlanMoment = flexible({
  targetBlockId: text,
  role: text,
  whyNarratorOwnsIt: text,
  editorialCommentaryPoint: text,
  handsOffToRawMoment: text
}, {
  viewerKnows: text,
  viewerWantsToKnow: text,
  heldBackForFootage: text
});
const narrativePlan = flexible({
  storytellerAngle: text,
  alternationPattern: text,
  plannedNarratedMoments: list(narrativePlanMoment, 12)
}, {
  pacingMode: choice(...PACING_MODES),
  viewerJourneySummary: text
});

const directorSpine = {
  type: 'object',
  required: ['centralViewerQuestion', 'hookPromise', 'hookStrategy', 'openingStrategy', 'reason', 'beats', 'transitionChecks'],
  properties: {
    centralViewerQuestion: text,
    hookPromise: text,
    hookStrategy: text,
    openingStrategy,
    narrativePlan,
    reason: text,
    beats: list(directorBeat, 40),
    deliveryBlocks: list(Delivery.deliveryBlockSchema, 40),
    transitionChecks: list(Delivery.transitionCheckSchema, 40),
    openLoops: list(flexible({ id: text, question: text }), 12)
  },
  additionalProperties: true
};

const directorSpineStoryteller = {
  ...directorSpine,
  required: ['centralViewerQuestion', 'hookPromise', 'hookStrategy', 'openingStrategy', 'narrativePlan', 'reason', 'beats', 'deliveryBlocks', 'transitionChecks']
};

const directorEdl = {
  type: 'object', required: ['accessGranted', 'reelObservations', 'spine'], additionalProperties: false,
  properties: { accessGranted: boolean, reelObservations: text, spine: directorSpine,
    repairOutcome: flexible({ status: choice('repaired', 'scope_infeasible'), reason: text }) }
};

const directorEdlStoryteller = {
  ...directorEdl,
  properties: { ...directorEdl.properties, spine: directorSpineStoryteller }
};

const deliveryRepairResult = {
  type: 'object', required: ['reason', 'deliveryBlocks', 'transitionChecks'], additionalProperties: false,
  properties: {
    reason: text,
    deliveryBlocks: list(Delivery.deliveryBlockSchema, 40),
    transitionChecks: list(Delivery.transitionCheckSchema, 40)
  }
};

const schemas = { directorEdl, directorEdlStoryteller, directorBeat, directorSpine, deliveryRepairResult };

// ---------------------------------------------------------------- instruction
const instruction = `PASS 1B — MEDIA-GROUNDED EDITORIAL DIRECTOR. You own the exact EDL.
The attached video files are the ONLY footage you may cut from. They are the packed media reel of the selected Story Scope: a file may contain SEVERAL source segments back to back. SOURCE MEDIA (and input.scopeReelManifest) lists, per file, each segment's reelStartSec/reelEndSec, its absolute sourceStartSec/sourceEndSec and its scopeWindowId. Map reel time to source time with sourceSec = segment.sourceStartSec + (reelSec - segment.reelStartSec); when sourceClockBurned is true the picture also shows the SOURCE clock. Always output ABSOLUTE source seconds, and never let one beat span two segments. Cut only inside a segment's logical scope window (windowStartSec..windowEndSec), and NEVER past input.liveActionEndSec when provided.
input.storyScope is the story you are telling. Do not tell a different one.

WATCH FIRST. Before choosing a range, look at what is actually on screen and what is actually said there. observedInFootage must describe what you SAW and HEARD in that exact range: who is visible, the physical action, the key words. Never pick a range because of a text summary. If the footage does not show it, the beat does not exist.

EVERY BEAT MUST BE BOTH NOVEL AND CAUSALLY COHERENT WITH THE SCOPE.
- For every beat, answer: why is it needed NOW, right after the previous beat (whyNecessaryNow), and what changes for the viewer (viewerStateBefore -> viewerStateAfter, newInformation).
- Every text field is ONE short sentence (about 25 words at most). State each point once; never repeat a sentence or restate another field.
- A different timestamp, speaker or line is not progress. "It is interesting" is not a reason.
- If removing a beat makes the story clearer with no causal loss, remove it.

DELIVERY: NARRATOR-LED TRUE CRIME COMMENTARY vs RAW EVIDENCE (NARRATOR <-> FOOTAGE PARTNERSHIP).
- The NARRATOR is the SCENE-TRANSITION BRIDGE and CASE STORYTELLER driving the viewer experience: owning case-file rewind introductions, scene-to-scene transitions across omitted time or location shifts, comprehension, compression, causal connection, behavioral/legal interpretation (COMMENTARY / INTERPRETATION), curiosity re-hooks (REHOOK / ANTICIPATION), contrast framing, and closing synthesis (CLOSING / PAYOFF).
- STRICT ANTI-PLAY-BY-PLAY RULE: The narrator is NEVER a caption reader describing what is visibly happening on screen! Visual B-roll under a narrated_story block is purely background imagery; narration must NEVER describe the literal camera movement or visible action of that B-roll clip. Instead, every narrated_story block must bridge FROM the preceding scene TO the upcoming raw scene.
- SOURCE FOOTAGE owns authentic proof, emotional confrontation, high-value quotes, character reveal, turning points, and real consequences (CONFLICT | REAL_EVIDENCE | REACTION | CHARACTER_REVEAL | CONSEQUENCE | TURNING_POINT | PAYOFF).
- Never insert empty or generic filler voiceover merely to raise narrator seconds; every narrated_story block must answer in its plan/block fields: what the viewer already knows (viewerKnows), what curiosity question is now active (viewerWantsToKnow), what analytical/commentary insight the narrator adds (commentaryValue), and what raw quote or reveal is deliberately held back so the footage delivers the punchline (heldBackForFootage).
- PACING MODE (input.pacingMode):
  * When input.pacingMode is 'commentary_led' (default True Crime Storyteller style): organize the viewer journey dynamically around CLIMAX FLASHPOINT HOOK -> NARRATOR CASE-FILE REWIND INTRO -> EVIDENCE -> NARRATOR SCENE-TRANSITION BRIDGE -> NEW CONFLICT / CLIMAX -> NARRATOR LOCATION/PHASE BRIDGE -> CONSEQUENCE -> NARRATOR CLOSING SYNTHESIS. Do NOT leave a 30-40s uninterrupted wall of raw procedural footage spanning multiple story phases or jumping abruptly across locations (e.g. street arrest -> police station booking room) without a narrator transition bridge. Instead, connect distinct phases with purposeful narrated_story blocks (typically 4 to 5 substantive blocks of ~5.5-9.5s each across a 75-88s edit) over clean visual B-roll/action from input.visualOwnershipMap.cleanVisualBrollWindows:
    1. CONTEXT / SETUP after the opening hook (Post-Hook Case-File Rewind Intro): right after throwing the viewer into the opening climax flashpoint, rewind to the start of the case and introduce when, where, and how the incident began (what driving behavior, dispatch call, or violation triggered the encounter) before handing off directly to the first raw dialogue clip (~5.5-8.5s).
    2. CAUSAL_BRIDGE / INTERPRETATION (Scene-Transition Bridge): bridge across omitted time or location changes (e.g. summarizing minutes of roadside refusal leading up to a supervisor's ultimatum, or transitioning from the roadside arrest into the police station booking room) and frame what to listen for next (~5.5-8.5s).
    3. REHOOK / ANTICIPATION before the climax/custody argument: re-ignite curiosity when the encounter shifts from arrest to verbal rationalization or station reckoning — contrast the subject's mindset with the legal standard WITHOUT paraphrasing or spoiling the upcoming punchline quote (~5.0-8.0s).
    4. CLOSING / PAYOFF synthesis (~4.5-7.0s): after the authoritative rebuttal/consequence plays out in raw audio, deliver a sharp 2-sentence takeaway contrasting personal grievance with legal reality plus a situation-specific, non-loaded viewer debate question.
  * When input.pacingMode is 'evidence_heavy' (comparison option): keep narrator concise (2-3 tight orientation/bridge/closing blocks) and allocate more runtime to extended original-audio exchanges while still preserving clarity and closing cleanly.
- Fill spine.narrativePlan FIRST (storytellerAngle, alternationPattern, pacingMode, viewerJourneySummary, plannedNarratedMoments with targetBlockId, role, viewerKnows, viewerWantsToKnow, whyNarratorOwnsIt, editorialCommentaryPoint, heldBackForFootage, handsOffToRawMoment) BEFORE writing spine.beats and spine.deliveryBlocks, and realize EVERY plannedNarratedMoment as a mode='narrated_story' block.
- PROTECT HIGH-VALUE QUOTES & NEVER SPOIL PUNCHLINES:
  * Check input.visualOwnershipMap.highValueRawQuotes and input.modelContext.quotes: preserve the incident's sharpest verbal confrontations, warnings, suspect rationalizations/punchlines, and supervisor/officer rebuttals as mode='raw_evidence' (5-9s tight cuts around the strongest lines).
  * NEVER let narration quote or paraphrase a punchline right before the subject says it on camera (e.g., frame that the subject offers a bold legal rationalization, then cut to raw_evidence so the viewer hears the exact words firsthand).
- VISUAL OWNERSHIP FOR NARRATED BLOCKS (MANDATORY):
  * Every mode='narrated_story' block MUST run over clean visual B-roll, establishing shots, walking/driving/handcuffing/door-latching movement, dispatch waveform, or silent reaction windows — consult input.visualOwnershipMap.cleanVisualBrollWindows for verified low-speech ranges inside the scope reel!
  * NEVER place voiceover over active multi-turn on-camera conversations with moving lips or heavy burned-in dialogue subtitles. If a narrated block needs visual coverage while characters are talking elsewhere, select a clean visual B-roll sub-range from the same scene/event in input.visualOwnershipMap.cleanVisualBrollWindows instead of deleting the narrator block!
- STRICT LIVE-ACTION ENDING BOUNDARY:
  * NEVER cut any beat past input.liveActionEndSec. Post-incident split-screen recaps, sentencing cards, channel outros, and promo screens are strictly forbidden in EVERY beat.

DELIVERY BLOCKS (spine.deliveryBlocks) — the audio-ownership layer over your beats.
- Every beat belongs to exactly one block; a block's beatIds are CONSECUTIVE beats in EDL order; blocks follow EDL order.
- raw_evidence: original audio plays. Set evidenceFunction and footageFunction (CONFLICT | REAL_EVIDENCE | REACTION | CHARACTER_REVEAL | CONSEQUENCE | TURNING_POINT | PAYOFF).
- narrated_story: ONE continuous narration passage spans the block's beats. Set storyFunction, narratorFunction (CONTEXT | CAUSAL_BRIDGE | ANTICIPATION | COMMENTARY | INTERPRETATION | REHOOK | ESCALATION | PAYOFF | CLOSING | HOOK | BRIDGE | TIME_JUMP | CLIFFHANGER), narrationIntent, viewerKnows, viewerWantsToKnow, commentaryValue, heldBackForFootage, and sourceAudioTreatment ('voiceover_only' or 'voiceover_with_ambient').
- Size narrated_story blocks generously enough for natural human delivery (~2.45 words/sec, never rushed): ~5.5-9.5s for setup/bridge/rehook commentary blocks, and ~4.5-7.0s for the closing synthesis + question block (group 1-2 clean visual beats if needed).
- Each beat's audioMode must match its block ('original_audio' for raw_evidence; 'voiceover_only' or 'voiceover_with_ambient' for narrated_story).
- If input.narrationEnabled is false, every block must be raw_evidence.

DELIVERY SELF-CHECK (answer in the block fields before finalizing spine.deliveryBlocks; the goal is correct ownership, not more or less narration).
- For every raw_evidence block (ownershipReason): does the viewer need to HEAR this material directly — proof, emotion, confrontation, reaction, authenticity? Or is it mostly explanation or backstory that narration could compress? If several consecutive raw beats do the same explanatory job, keep only the strongest real quote(s) and let a narrated_story block carry the connective information and editorial commentary.
- For every narrated_story block (ownershipReason): what comprehension, compression, commentary or orientation does the narrator add, and which real moment does it set up or hand off to (or what closing takeaway and viewer question does it deliver at the end)?
- BLOCK-LEVEL DENSITY, not per beat: blockSummary = the WHOLE block in one sentence; viewerStateChanges = how many genuinely new viewer-state changes happen across the whole block. Distinct lines are not distinct changes. A long block whose sentences all serve one explanatory function should be compressed editorially: fewer, stronger raw beats, or narration.

TRANSITIONS (spine.transitionChecks, one per boundary between consecutive blocks).
- For each boundary answer: could a cold viewer understand why the next scene is being shown (coldViewerUnderstandsWhy) and how they know (howTheViewerKnows: the picture, the dialogue, or the narration)? Judge from what the viewer sees and hears, not from how far apart the timestamps are.
- If the honest answer is no, fix it before returning: change delivery ownership, narrationIntent or the block boundary. Do not return coldViewerUnderstandsWhy=false.

OPENING STRATEGY (spine.openingStrategy) — compare BOTH before choosing the first beat:
1. chronologicalOption: open on immediate interpersonal friction or an absurd refusal/excuse loop at the start of the encounter, followed by a narrated_story CONTEXT setup block.
2. conflictTeaserOption: throw the cold viewer straight into the peak climax/confrontation flashpoint from input.storyScope.hookCandidates (the highest-tension ultimatum + defiant dare, physical glass breach, or takedown moment, cut at peak cliffhanger tension so the viewer urgently wonders what happened and why it escalated that far without spending input.storyScope.mustWithhold's final legal outcome), followed immediately by a narrated_story rewind/case-setup block introducing when, where, and how the incident began.
Choose (chosen) whichever creates stronger verified curiosity while keeping causal clarity; neither is preferred by default, though when the reel contains an explosive climax flashpoint or high-stakes confrontation dare, conflict_teaser_rewind is strongly favored for immediate hook retention. The FIRST beat must use a hook role (teaser_conflict, cold_open, cold_open_hook, hook or micro_payoff).

ENDING = AUTHORITATIVE CONSEQUENCE + CLEAN NARRATOR CLOSING SYNTHESIS.
- Ending beats (scopeMembership 'ending') must come from input.storyScope.candidateEndingEvents or an ending_material window, ending strictly <= input.liveActionEndSec.
- Let the raw_evidence payoff show the authoritative rebuttal/charge explanation and the subject's final reaction first, then conclude with a 4.5-7.0s narrated_story CLOSING/PAYOFF block over clean live-action closure footage (up to input.liveActionEndSec, before any outro graphics) delivering a grounded 1-sentence takeaway + 1-sentence viewer debate question.

DURATION: aim the total at input.targetDurationSec — inside the preferred band input.targetBandMinSec..input.targetBandMaxSec. input.targetDurationMinSec..input.targetDurationMaxSec is only the hard acceptance range; do NOT aim at its minimum. FINAL TIMELINE DURATION = sum(sourceEndSec - sourceStartSec) over every selected beat. The returned EDL must land inside the preferred band whenever suitable footage allows it, and MUST NOT exceed input.targetDurationMaxSec. The JSON you return is final: no arithmetic, drafts, corrections or repeated text inside any field. Choose beat lengths editorially (a beat may be short or long), and every beat is at least 1 second.
Set accessGranted=true only after watching the attached reel. reelObservations: 2-4 sentences on what the reel actually shows.`;

function repairInstruction(kind, payload) {
  if (kind === 'technical') {
    return `TECHNICAL REPAIR — your EDL failed deterministic validation. Return the COMPLETE EDL again, including spine.narrativePlan, spine.deliveryBlocks, and spine.transitionChecks covering every beat.
CRITICAL RULES FOR REPAIR:
- NEVER fix NARRATED_BLOCK_ACTIVE_DIALOGUE by deleting narrated_story blocks and collapsing the edit into raw-only clips! Instead, swap the narrated block's visual beat range to a clean low-dialogue B-roll/action window from input.visualOwnershipMap.cleanVisualBrollWindows in the same story phase so your planned commentary survives intact!
- NEVER fix BEAT_CUTS_INTO_OUTRO / ENDING_CUTS_INTO_OUTRO by keeping timestamps past input.liveActionEndSec; clamp or shift to clean live-action footage strictly <= input.liveActionEndSec.
- Preserve high-value raw quotes (input.visualOwnershipMap.highValueRawQuotes) as raw_evidence.
Violations to fix:
${payload.violations.map((v, i) => `${i + 1}. [${v.code}] ${v.message}`).join('\n')}`;
  }
  return `TARGETED EDITORIAL REPAIR — the RENDERED video of your EDL was watched by a media critic, who found the problems listed in input.criticFindings (mapped to input.weakRegions).
- Return the COMPLETE repaired EDL (strictly <= input.liveActionEndSec on every beat).
- Delivery findings (who owns the audio; input.weakRegions[].deliveryBlockIds) are repaired in spine.deliveryBlocks: you may change raw_evidence / narrated_story ownership, block membership or narrationIntent, and the weak-region beats themselves. Fix the weak regions without gutting narrator storytelling: if a narrated block clashed with active on-camera dialogue or burned-in subtitles, move its visual range to a clean window in input.visualOwnershipMap.cleanVisualBrollWindows rather than deleting the narrator commentary.
- Weak opening or ending replacement: when weakRegions flags the opening or the ending (payoff_unsatisfying, ending_cuts_mid_line, unusable_footage, ending_layout_jump), replace the ending with another in-scope ending candidate or shorten the ending beat to a visually usable endpoint <= input.liveActionEndSec, or replace/extend the opening using stronger hook_material / hookCandidates from the attached scope reel.
- Preserve high-value raw quotes/punchlines in raw_evidence and keep the total duration inside input.targetDurationMinSec..input.targetDurationMaxSec.`;
}

// ---------------------------------------------------------------- pure checks
function beatLen(b) { return Math.max(0, num(b.sourceEndSec) - num(b.sourceStartSec)); }
function timelineSec(beats) { return (beats || []).reduce((n, b) => n + beatLen(b), 0); }

// ---------------------------------------------------------------- duration control
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
    out.requiredAdditionToMinimumSec = out.deficitBelowMinimumSec;
    out.preferredAdditionToTargetSec = out.missingToTargetSec;
  }
  return out;
}
const DURATION_CODES = new Set(['TOTAL_DURATION_UNDER_MIN', 'TOTAL_DURATION_OVER_MAX']);
const onlyDurationViolations = vs => Array.isArray(vs) && vs.length > 0 && vs.every(v => DURATION_CODES.has(v.code));

function technicalDurationAdjustment(spine, reel, { hardMinSec, durationSec = Infinity, liveActionEndSec = null, maxDeficitSec = TECHNICAL_ADJUST_MAX_DEFICIT_SEC } = {}) {
  const beats = spine?.beats || [];
  const total = timelineSec(beats);
  const need = round2(Math.ceil((hardMinSec - total) * 100 - 1e-6) / 100);
  if (!(need > 0)) return { applied: false, reason: 'no deficit' };
  if (need > maxDeficitSec + 1e-9) return { applied: false, reason: `deficit ${need}s exceeds ${maxDeficitSec}s` };
  const maxLive = resolveLiveActionBoundary({ liveActionEndSec, scope: spine?.storyScope, durationSec });
  const rows = (reel?.ranges || []).map(r => ({
    row: r,
    lo: Math.max(num(r.sourceStartSec), Number.isFinite(num(r.windowStartSec)) ? num(r.windowStartSec) : -Infinity, 0),
    hi: Math.min(num(r.sourceEndSec), Number.isFinite(num(r.windowEndSec)) ? num(r.windowEndSec) : Infinity, durationSec, maxLive)
  })).filter(r => r.hi > r.lo);
  const others = i => beats.filter((_, j) => j !== i).map(b => [num(b.sourceStartSec), num(b.sourceEndSec)]);
  const free = (i, a, z) => others(i).every(([s, e]) => Math.min(e, z) - Math.max(s, a) <= 1e-6);
  const options = [];
  beats.forEach((b, i) => {
    const s = num(b.sourceStartSec), e = num(b.sourceEndSec);
    const home = rows.find(r => s >= r.lo - 1e-6 && e <= r.hi + 1e-6);
    if (!home) return;
    if (e + need <= home.hi + 1e-6 && free(i, e, e + need)) options.push({ i, side: 'end', room: home.hi - e, home });
    if (s - need >= home.lo - 1e-6 && free(i, s - need, s)) options.push({ i, side: 'start', room: s - home.lo, home });
  });
  if (!options.length) return { applied: false, reason: 'no contiguous watched footage inside the same scope window without overlapping another beat' };
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

function cuttableRanges(reelRanges, maxEndSec = Infinity) {
  const cap = Number.isFinite(num(maxEndSec)) && num(maxEndSec) > 0 ? num(maxEndSec) : Infinity;
  return Packer.mergeIntervals((reelRanges || []).map(r => [
    Math.max(num(r.sourceStartSec), Number.isFinite(num(r.windowStartSec)) ? num(r.windowStartSec) : -Infinity),
    Math.min(num(r.sourceEndSec), Number.isFinite(num(r.windowEndSec)) ? num(r.windowEndSec) : Infinity, cap)
  ]).filter(([a, z]) => z > a));
}
function coveredByReel(b, reelRanges, maxEndSec = Infinity) {
  const s = num(b.sourceStartSec), e = num(b.sourceEndSec);
  if (!(e > s)) return 0;
  const inside = cuttableRanges(reelRanges, maxEndSec).reduce((n, [rs, re]) => n + Math.max(0, Math.min(e, re) - Math.max(s, rs)), 0);
  return inside / (e - s);
}

function technicalWindowPaddingAdjustment(spine, reel, { durationSec = Infinity, liveActionEndSec = null } = {}) {
  const beats = spine?.beats || [];
  if (!beats.length) return { applied: false, reason: 'no beats' };
  const maxLive = resolveLiveActionBoundary({ liveActionEndSec, scope: spine?.storyScope, durationSec });
  const rows = (reel?.ranges || []).map(r => ({
    row: r,
    padLo: Math.max(0, num(r.sourceStartSec)),
    padHi: Math.min(num(r.sourceEndSec), durationSec, maxLive),
    winLo: Math.max(0, num(r.sourceStartSec), Number.isFinite(num(r.windowStartSec)) ? num(r.windowStartSec) : -Infinity),
    winHi: Math.min(num(r.sourceEndSec), Number.isFinite(num(r.windowEndSec)) ? num(r.windowEndSec) : Infinity, durationSec, maxLive)
  })).filter(r => r.winHi > r.winLo && r.padHi >= r.winHi - 1e-6 && r.padLo <= r.winLo + 1e-6);

  const adjustments = [];
  const nextBeats = beats.map((b, i) => {
    const s = num(b.sourceStartSec), e = num(b.sourceEndSec);
    if (!(e > s)) return b;
    const cov = coveredByReel(b, reel?.ranges || [], maxLive);
    if ((e - s) * (1 - cov) <= GROUNDING_TOLERANCE_SEC) return b;
    const home = rows.find(r =>
      s >= r.padLo - 0.1
      && e <= r.padHi + 0.1
      && Math.min(e, r.winHi) - Math.max(s, r.winLo) >= (e - s) * 0.5
    );
    if (!home) return b;
    const clampedStart = round2(Math.max(s, home.winLo));
    const clampedEnd = round2(Math.min(e, home.winHi));
    const isNarrated = (b.audioMode && b.audioMode !== 'original_audio') || b.deliveryMode === 'narrated_story';
    const minBeatDur = isNarrated ? 3.8 : MIN_BEAT_SEC;
    let newStart = clampedStart;
    let newEnd = clampedEnd;
    if (newEnd - newStart < minBeatDur && (home.winHi - home.winLo) >= minBeatDur) {
      const targetLen = Math.min(e - s, home.winHi - home.winLo);
      if (e > home.winHi) {
        newEnd = round2(home.winHi);
        newStart = round2(Math.max(home.winLo, newEnd - targetLen));
      } else if (s < home.winLo) {
        newStart = round2(home.winLo);
        newEnd = round2(Math.min(home.winHi, newStart + targetLen));
      }
    }
    if (!(newEnd - newStart >= MIN_BEAT_SEC) || (Math.abs(newStart - s) < 1e-6 && Math.abs(newEnd - e) < 1e-6)) return b;
    const collides = beats.some((other, j) => j !== i && Math.min(num(other.sourceEndSec), newEnd) - Math.max(num(other.sourceStartSec), newStart) > 1e-6);
    if (collides) return b;
    adjustments.push({
      beatId: b.beatId,
      oldStartSec: s,
      oldEndSec: e,
      newStartSec: newStart,
      newEndSec: newEnd,
      sourceWindowId: home.row.scopeWindowId || null,
      reason: `clamped watched reel padding overhang (${s}-${e}s -> ${newStart}-${newEnd}s) into logical window ${round2(home.winLo)}-${round2(home.winHi)}s`
    });
    return { ...b, sourceStartSec: newStart, sourceEndSec: newEnd };
  });

  if (!adjustments.length) return { applied: false, reason: 'no eligible watched-padding overhang' };
  return {
    applied: true,
    spine: { ...spine, beats: nextBeats },
    adjustments
  };
}

function endingMaterialRanges(scope) {
  const out = [];
  for (const w of scope?.scopeWindows || []) {
    const ranges = (Array.isArray(w.purposeRanges) ? w.purposeRanges : []).filter(r => r?.purpose === 'ending_material');
    if (ranges.length) ranges.forEach(r => out.push([num(r.startSec), num(r.endSec)]));
    else if (w.purpose === 'ending_material' || (Array.isArray(w.purposes) && w.purposes.includes('ending_material'))) out.push([num(w.startSec), num(w.endSec)]);
  }
  return out;
}

function spokenWordCount(rawText) {
  return String(rawText || '')
    .replace(/\[[^\]]*\]|\([^)]*\)|>>/g, ' ')
    .split(/\s+/)
    .filter(w => /[a-z0-9]/i.test(w)).length;
}

/**
 * Estimates actual active spoken-dialogue span inside [s, e], bounding rolling
 * YouTube SRT `endSec` hangs by realistic speech rate (~2.5 words/sec + 0.35s)
 * so silent walking/driving/closing-door tails after short lines are NOT misclassified
 * as active dialogue!
 */
function estimatedSpeechSpan(cues, s, e) {
  if (!Array.isArray(cues) || !cues.length || !(e > s)) return { speechSec: 0, activeCues: [] };
  const intervals = [];
  const activeCues = [];
  for (const c of cues) {
    const rawStart = num(c.startSec);
    const rawEnd = num(c.endSec);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawEnd <= rawStart) continue;
    const w = spokenWordCount(c.text || c.translatedText || '');
    if (w <= 0) continue; // ignore [Music], [Radio], non-speech markers
    const estDur = Math.min(rawEnd - rawStart, Math.max(0.65, w / 2.5 + 0.35));
    const estEnd = rawStart + estDur;
    const cs = Math.max(s, rawStart);
    const ce = Math.min(e, estEnd);
    if (ce > cs + 0.12) {
      intervals.push([cs, ce]);
      activeCues.push({ startSec: round2(rawStart), endSec: round2(estEnd), words: w, text: String(c.text || '').trim() });
    }
  }
  if (!intervals.length) return { speechSec: 0, activeCues: [] };
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = intervals[0][0], curEnd = intervals[0][1];
  for (let i = 1; i < intervals.length; i++) {
    const [ns, ne] = intervals[i];
    if (ns <= curEnd + 0.15) curEnd = Math.max(curEnd, ne);
    else {
      total += curEnd - curStart;
      curStart = ns;
      curEnd = ne;
    }
  }
  total += curEnd - curStart;
  return { speechSec: round2(total), activeCues };
}

function mergedCueSpan(cues, s, e) {
  return estimatedSpeechSpan(cues, s, e).speechSec;
}

/**
 * Builds a clean B-roll & high-value quote map over the watched `scopeReel` so the
 * Editorial Director can place (or repair) `narrated_story` blocks onto verified
 * low-speech visual windows instead of deleting narrator commentary!
 */
function buildVisualOwnershipMap(reel, model, cues = [], liveActionEndSec = Infinity) {
  const cuttable = cuttableRanges(reel?.ranges || [], liveActionEndSec);
  const cleanVisualBrollWindows = [];
  for (const [segStart, segEnd] of cuttable) {
    // Scan in 1.0s steps for contiguous low-speech stretches >= 2.5s
    let winStart = null;
    for (let t = segStart; t + 1.0 <= segEnd + 0.01; t += 1.0) {
      const sliceEnd = Math.min(segEnd, t + 1.0);
      const { speechSec } = estimatedSpeechSpan(cues, t, sliceEnd);
      const isQuiet = speechSec <= 0.30;
      if (isQuiet && winStart === null) winStart = t;
      if (!isQuiet && winStart !== null) {
        if (t - winStart >= 2.5) {
          cleanVisualBrollWindows.push([round2(winStart), round2(t)]);
        }
        winStart = null;
      }
    }
    if (winStart !== null && segEnd - winStart >= 2.5) {
      cleanVisualBrollWindows.push([round2(winStart), round2(segEnd)]);
    }
  }

  const events = Array.isArray(model?.events) ? model.events : [];
  const annotatedCleanWindows = cleanVisualBrollWindows.slice(0, 24).map(([s, e]) => {
    const ev = events.find(x => Math.min(e, num(x.endSec)) - Math.max(s, num(x.startSec)) > 0.5);
    return {
      sourceStartSec: s,
      sourceEndSec: e,
      durationSec: round2(e - s),
      visualContext: ev ? `${ev.location || ev.type || 'scene'}: ${String(ev.summary || '').slice(0, 90)}` : 'in-scope visual footage'
    };
  });

  const inCuttable = (s, e) => cuttable.some(([cs, ce]) => Math.min(e, ce) - Math.max(s, cs) > 0.3);
  const highValueRawQuotes = (Array.isArray(model?.quotes) ? model.quotes : [])
    .filter(q => inCuttable(num(q.startSec), num(q.endSec)) && (num(q.editorialValue) >= 0.7 || /high|strong|iconic|key/i.test(String(q.editorialValue || q.epistemic || '')) || spokenWordCount(q.text) >= 4))
    .slice(0, 14)
    .map(q => ({
      quoteId: q.id || null,
      speaker: q.speaker || 'subject',
      sourceStartSec: q.startSec,
      sourceEndSec: q.endSec,
      text: String(q.text || '').slice(0, 140),
      rule: 'Play as raw_evidence when selected; never paraphrase or spoil this exact punchline in preceding narration.'
    }));

  return { cleanVisualBrollWindows: annotatedCleanWindows, highValueRawQuotes };
}

function validateDirectorEdl(spine, scope, { durationSec, targetDurationMinSec = 65, targetDurationMaxSec = 90, reel, narrationEnabled = true, preferredDurationSec = null, targetBandMinSec = null, targetBandMaxSec = null, requireDeliveryBlocks = false, cues = null, liveActionEndSec = null, endingBoundary: endingBoundaryMeta = null, pacingMode = 'commentary_led' } = {}) {
  const violations = [];
  const add = (code, message, extra = {}) => violations.push({ code, message, ...extra });
  const beats = Array.isArray(spine?.beats) ? spine.beats : [];
  if (!beats.length) {
    add('EMPTY_BEATS', 'The EDL contains no beats.');
    return { valid: false, violations, metrics: { totalSec: 0, beatCount: 0 } };
  }
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Infinity;
  const maxLiveSec = resolveLiveActionBoundary({ liveActionEndSec, endingBoundary: endingBoundaryMeta, scope, durationSec: dur });
  const hasLiveBoundary = Number.isFinite(maxLiveSec) && maxLiveSec > 0 && maxLiveSec < dur - 0.02;
  const reelRanges = reel?.ranges || [];
  const ids = new Set();

  let audioBeats = beats;
  if (requireDeliveryBlocks || spine?.deliveryBlocks !== undefined) {
    const blockViolations = Delivery.validateDeliveryBlocks(beats, spine?.deliveryBlocks, { narrationEnabled });
    violations.push(...blockViolations);
    if (!blockViolations.length) audioBeats = Delivery.applyDeliveryBlocks(beats, spine.deliveryBlocks);
  }
  if (requireDeliveryBlocks) {
    violations.push(...Delivery.validateDeliveryBlocks(beats, spine?.deliveryBlocks, { narrationEnabled, requireSelfCheck: true }).filter(v => v.code === 'DELIVERY_BLOCK_SELF_CHECK_MISSING'));
    violations.push(...Delivery.validateTransitionChecks(spine?.deliveryBlocks, spine?.transitionChecks));
    violations.push(...openingViolations(spine, beats));
    violations.push(...narrativePlanViolations(spine, beats, scope, { narrationEnabled, pacingMode }));
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
    // Layer B: Check EVERY beat against the valid live-action source boundary!
    if (hasLiveBoundary && (s >= maxLiveSec - 0.02 || e > maxLiveSec + 0.02)) {
      const code = i === beats.length - 1 ? 'ENDING_CUTS_INTO_OUTRO' : 'BEAT_CUTS_INTO_OUTRO';
      add(code, `Beat '${id}' (${s}-${e}s) crosses the valid live-action encounter boundary (${round2(maxLiveSec)}s) into post-incident outro/recap graphics. Every beat MUST end <= ${round2(maxLiveSec)}s.`, { beatId: id, sourceStartSec: s, sourceEndSec: e, liveActionEndSec: round2(maxLiveSec) });
    }
    if (e - s < MIN_BEAT_SEC) add('BEAT_TOO_SHORT', `Beat '${id}' is ${round2(e - s)}s; every beat must be at least ${MIN_BEAT_SEC}s to be playable.`, { beatId: id });
    const cov = coveredByReel(b, reelRanges, maxLiveSec);
    if ((e - s) * (1 - cov) > GROUNDING_TOLERANCE_SEC) {
      add('OUTSIDE_SCOPE_REEL', `Beat '${id}' (${s}-${e}s) is not inside watched, valid live-action footage of a logical scope window (${Math.round(cov * 100)}% inside; liveActionEndSec=${round2(maxLiveSec)}s). Cut only from the manifest segments' source ranges <= ${round2(maxLiveSec)}s.`, { beatId: id, coverage: round2(cov) });
    }
    if (!String(b.observedInFootage || '').trim()) add('BEAT_NOT_GROUNDED', `Beat '${id}' has no observedInFootage: say what is seen/heard in that range.`, { beatId: id });
    if (!String(b.whyNecessaryNow || '').trim()) add('BEAT_UNJUSTIFIED', `Beat '${id}' has no whyNecessaryNow.`, { beatId: id });
    if (!narrationEnabled && audioBeats[i].audioMode && audioBeats[i].audioMode !== 'original_audio' && !audioBeats[i].deliveryBlockId) {
      add('NARRATION_DISABLED', `Beat '${id}' uses ${b.audioMode} but narration is disabled for this project; use original_audio.`, { beatId: id });
    }
  });

  // Visual ownership: narrated blocks must run over clean B-roll or physical action,
  // using word-rate-bounded `estimatedSpeechSpan` so rolling-SRT silent tails are NOT false-flagged,
  // and pointing repairs directly to clean B-roll windows so narrator blocks are preserved!
  if (Array.isArray(cues) && cues.length) {
    const cleanWindows = buildVisualOwnershipMap(reel, null, cues, maxLiveSec).cleanVisualBrollWindows;
    beats.forEach((b, i) => {
      const id = b.beatId || `#${i}`;
      const ab = audioBeats[i];
      if (ab && (ab.audioMode === 'voiceover_only' || (ab.deliveryMode === 'narrated_story' && ab.audioMode !== 'original_audio'))) {
        const s = num(b.sourceStartSec), e = num(b.sourceEndSec);
        const len = Math.max(0.1, e - s);
        const { speechSec: dialogueSec, activeCues } = estimatedSpeechSpan(cues, s, e);
        const isFinalBeat = (i === beats.length - 1);
        const obsText = String(b.observedInFootage || '');
        const isPhysicalOrTransitionBroll = /waveform|911\s+audio|dispatch\s+screen|cruiser|patrol|transport\s+van|open\s+door|shuts?\b|latch|clos(?:es?|ing)\s+(?:the\s+)?(?:van\s+|patrol\s+|car\s+|vehicle\s+)?door|walking|approaching|escort|handcuff|cuffing|parking\s+lot|sidewalk|roadside|establishing/i.test(obsText)
          && !/arguing\s+that|explains\s+what|debating|heated\s+argument|lecture/i.test(obsText);
        const totalSpokenWords = activeCues.reduce((sum, c) => sum + (Number(c.words) || 0), 0);
        const isHeavySubstantiveDialogue = !isPhysicalOrTransitionBroll
          && activeCues.length >= 2
          && dialogueSec >= 4.5
          && (dialogueSec / len >= 0.72)
          && totalSpokenWords >= 18;
        const isExplicitVoiceoverOnlyEndingConflict = isFinalBeat
          && ab.audioMode === 'voiceover_only'
          && !isPhysicalOrTransitionBroll
          && dialogueSec >= 2.2
          && (dialogueSec / len >= 0.48);
        if (isHeavySubstantiveDialogue || isExplicitVoiceoverOnlyEndingConflict) {
          const firstCue = activeCues[0];
          const nearbyClean = cleanWindows
            .sort((w1, w2) => Math.abs(w1.sourceStartSec - s) - Math.abs(w2.sourceStartSec - s))
            .slice(0, 3)
            .map(w => `${w.sourceStartSec}-${w.sourceEndSec}s (${w.durationSec}s)`)
            .join(', ');
          add('NARRATED_BLOCK_ACTIVE_DIALOGUE', `Beat '${id}' (${s}-${e}s) runs voiceover over ${round2(dialogueSec)}s of active substantive dialogue ("${String(firstCue?.text || '').slice(0, 50)}..."). DO NOT delete the narrated_story block — instead swap '${id}' to a clean visual B-roll/action window from the scope reel${nearbyClean ? ` (e.g. ${nearbyClean})` : ''} or split the substantive quote into an adjacent raw_evidence beat while keeping narrator commentary over physical B-roll.`, { beatId: id, dialogueSec: round2(dialogueSec) });
        }
      }
    });
  }

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
    add('TOTAL_DURATION_UNDER_MIN', underMinMessage(d), { totalSec: d.currentDurationSec, ...d });
  }
  if (total > targetDurationMaxSec + DUR_EPS) {
    const d = durationDelta(total, deltaTargets);
    const range = d.preferredReductionRangeSec ? ` (${d.preferredReductionRangeSec.minSec}-${d.preferredReductionRangeSec.maxSec}s for the ${d.targetBandMinSec}-${d.targetBandMaxSec}s band)` : '';
    add('TOTAL_DURATION_OVER_MAX', `The timeline is ${d.currentDurationSec}s: ${d.excessAboveMaximumSec}s above the hard maximum (${targetDurationMaxSec}s) and ${d.deltaFromTargetSec}s above the preferred target (${d.targetDurationSec}s). Remove at least ${d.requiredReductionToMaximumSec}s, preferably about ${d.preferredReductionToTargetSec}s${range} by tightening slack inside long raw procedural beats (do NOT delete essential narrated_story commentary blocks or high-value raw punchlines).`, { totalSec: d.currentDurationSec, ...d });
  }

  if (toV2Role(beats[0].narrativeRole) !== 'hook') {
    add('FIRST_BEAT_NOT_HOOK', `The first beat '${beats[0].beatId}' has role '${beats[0].narrativeRole}'; the opening must use a hook role.`, { beatId: beats[0].beatId });
  }

  const last = beats[beats.length - 1];
  const endingRanges = [
    ...(scope?.candidateEndingEvents || []).map(e => [num(e.sourceStartSec), Math.min(maxLiveSec, num(e.sourceEndSec))]),
    ...endingMaterialRanges(scope).map(([s, e]) => [s, Math.min(maxLiveSec, e)])
  ].filter(([s, e]) => e > s);
  const ls = num(last.sourceStartSec), le = num(last.sourceEndSec);
  const inEndingRange = (bs, be) => endingRanges.some(([s, e]) => Math.min(be, e) - Math.max(bs, s) > 0);
  const lastAudioBeat = audioBeats[beats.length - 1] || last;
  const isClosingNarratedCallback = (
    lastAudioBeat.deliveryMode === 'narrated_story'
    || lastAudioBeat.audioMode === 'voiceover_with_ambient'
    || lastAudioBeat.audioMode === 'voiceover_only'
  ) && (
    last.scopeMembership === 'ending'
    || lastAudioBeat.narratorFunction === 'CLOSING'
    || lastAudioBeat.narratorFunction === 'PAYOFF'
    || /^(button|resolution|payoff)$/i.test(String(last.narrativeRole || ''))
  ) && coveredByReel(last, reelRanges, maxLiveSec) >= 0.95
    && beats.slice(0, -1).some(b => b.scopeMembership === 'ending' && inEndingRange(num(b.sourceStartSec), num(b.sourceEndSec)));
  if (endingRanges.length && !inEndingRange(ls, le) && !isClosingNarratedCallback) {
    add('ENDING_NOT_IN_SCOPE', `The final beat '${last.beatId}' (${ls}-${le}s) is not one of the scope's candidate endings or ending_material windows (<= ${round2(maxLiveSec)}s).`, { beatId: last.beatId });
  }

  return { valid: violations.length === 0, violations, metrics: { totalSec: round2(total), beatCount: beats.length, liveActionEndSec: Number.isFinite(maxLiveSec) ? round2(maxLiveSec) : null } };
}

function underMinMessage(d) {
  return `The timeline is ${d.currentDurationSec}s. You MUST add at least ${d.requiredAdditionToMinimumSec} meaningful seconds so the final timeline reaches the ${d.minimumDurationSec}s hard minimum. You MAY add up to ${d.preferredAdditionToTargetSec}s more toward ${d.targetDurationSec}s only if that material genuinely improves comprehension, proof, emotion, contradiction or payoff. Do not add filler merely to reach the preferred target.`;
}

function extensionOpportunities(beats, reel, durationSec = Infinity, liveActionEndSec = null) {
  const cap = Math.min(durationSec, Number.isFinite(num(liveActionEndSec)) && num(liveActionEndSec) > 0 ? num(liveActionEndSec) : Infinity);
  const cuts = cuttableRanges(reel?.ranges || [], cap).map(([a, z]) => [Math.max(0, a), Math.min(cap, z)]);
  return (beats || []).map((b, i) => {
    const s = num(b.sourceStartSec), e = num(b.sourceEndSec);
    const home = cuts.find(([a, z]) => s >= a - 1e-6 && e <= z + 1e-6);
    const row = { beatId: b.beatId, currentStartSec: s, currentEndSec: e };
    if (!home) return { ...row, cuttableStartSec: null, cuttableEndSec: null, availablePreviousSec: 0, availableNextSec: 0 };
    const others = beats.filter((_, j) => j !== i).map(o => [num(o.sourceStartSec), num(o.sourceEndSec)]);
    const nextWall = Math.min(home[1], ...others.filter(([os]) => os >= e - 1e-6).map(([os]) => os));
    const prevWall = Math.max(home[0], ...others.filter(([, oe]) => oe <= s + 1e-6).map(([, oe]) => oe));
    const inside = others.some(([os, oe]) => os < e - 1e-6 && oe > s + 1e-6);
    return { ...row, cuttableStartSec: round2(home[0]), cuttableEndSec: round2(home[1]),
      availablePreviousSec: inside ? 0 : round2(Math.max(0, s - prevWall)), availableNextSec: inside ? 0 : round2(Math.max(0, nextWall - e)) };
  });
}

function underMinStall(before, after) {
  const a = before?.beats || [], b = after?.beats || [];
  const same = a.length === b.length && a.every((x, i) => x.beatId === b[i].beatId
    && Math.abs(num(x.sourceStartSec) - num(b[i].sourceStartSec)) <= COMPRESSION_EPS_SEC && Math.abs(num(x.sourceEndSec) - num(b[i].sourceEndSec)) <= COMPRESSION_EPS_SEC);
  const t0 = timelineSec(a), t1 = timelineSec(b);
  if (same) {
    return { code: 'UNDER_MIN_REPAIR_STALLED', message: `The under-minimum repair returned the same ${round2(t1)}s timeline with identical source ranges.`,
      beforeSec: round2(t0), afterSec: round2(t1), unchangedBeatRanges: b.map(x => ({ beatId: x.beatId, sourceStartSec: x.sourceStartSec, sourceEndSec: x.sourceEndSec })) };
  }
  return null;
}

function extensionOverlapViolations(before, after) {
  const prev = new Map((before?.beats || []).map(b => [b.beatId, b]));
  const next = after?.beats || [];
  const out = [];
  next.forEach((b, i) => {
    const o = prev.get(b.beatId);
    if (!o || !(num(b.sourceStartSec) < num(o.sourceStartSec) - COMPRESSION_EPS_SEC || num(b.sourceEndSec) > num(o.sourceEndSec) + COMPRESSION_EPS_SEC)) return;
    const hit = next.find((x, j) => j !== i && Math.min(num(x.sourceEndSec), num(b.sourceEndSec)) - Math.max(num(x.sourceStartSec), num(b.sourceStartSec)) > COMPRESSION_EPS_SEC
      && !(Math.min(num(x.sourceEndSec), num(o.sourceEndSec)) - Math.max(num(x.sourceStartSec), num(o.sourceStartSec)) > COMPRESSION_EPS_SEC));
    if (hit) out.push({ code: 'UNDER_MIN_EXTENSION_OVERLAP', message: `Beat '${b.beatId}' was extended to ${b.sourceStartSec}-${b.sourceEndSec}s, through selected beat '${hit.beatId}' (${hit.sourceStartSec}-${hit.sourceEndSec}s). Extend only into footage no other beat uses.`, beatId: b.beatId, collidesWith: hit.beatId });
  });
  return out;
}

function openingViolations(spine, beats) {
  const o = spine?.openingStrategy;
  const out = [];
  if (!o || !String(o.chronologicalOption || '').trim() || !String(o.conflictTeaserOption || '').trim() || !OPENING_STRATEGIES.includes(o.chosen)) {
    out.push({ code: 'OPENING_COMPARISON_MISSING', message: 'spine.openingStrategy must describe BOTH the chronological opening and the conflict-first teaser + rewind opening, and name the chosen one.' });
    return out;
  }
  const first = beats[0];
  if (o.chosen === 'conflict_teaser_rewind' && first?.chronologyMode !== 'teaser') {
    out.push({ code: 'OPENING_STRATEGY_INCONSISTENT', message: `openingStrategy.chosen is conflict_teaser_rewind but the first beat '${first?.beatId}' is not a 'teaser' beat.`, beatId: first?.beatId });
  }
  if (o.chosen === 'chronological' && first?.chronologyMode === 'teaser') {
    out.push({ code: 'OPENING_STRATEGY_INCONSISTENT', message: `openingStrategy.chosen is chronological but the first beat '${first?.beatId}' is a teaser.`, beatId: first?.beatId });
  }
  return out;
}

function narrativePlanViolations(spine, beats, scope, { narrationEnabled = true, pacingMode = 'commentary_led' } = {}) {
  const out = [];
  if (!narrationEnabled) return out;
  const scopeOpportunities = Array.isArray(scope?.commentaryOpportunities) ? scope.commentaryOpportunities : [];
  const hasNarrativePlan = Boolean(spine?.narrativePlan);
  if (!hasNarrativePlan && !scopeOpportunities.length) return out;
  const moments = Array.isArray(spine?.narrativePlan?.plannedNarratedMoments) ? spine.narrativePlan.plannedNarratedMoments : [];
  const minForCommentaryLed = scopeOpportunities.length >= 3 && pacingMode !== 'evidence_heavy' ? 3 : (scopeOpportunities.length > 0 ? 2 : moments.length);
  if (minForCommentaryLed > 0 && moments.length < minForCommentaryLed) {
    out.push({
      code: 'NARRATIVE_PLAN_INCONSISTENT',
      message: `storyScope.commentaryOpportunities identified ${scopeOpportunities.length} storyteller commentary window(s), so in '${pacingMode}' mode spine.narrativePlan.plannedNarratedMoments must plan at least ${minForCommentaryLed} purposeful narrated moments (e.g. post-hook CONTEXT/SETUP, mid-story CAUSAL_BRIDGE/INTERPRETATION or REHOOK/ANTICIPATION, plus CLOSING takeaway) and realize each as a mode='narrated_story' block.`
    });
  }
  const blocks = Array.isArray(spine?.deliveryBlocks) ? spine.deliveryBlocks : [];
  const narratedBlocks = blocks.filter(b => b.mode === 'narrated_story');
  const requiredNarratedCount = Math.max(moments.length, minForCommentaryLed);
  if (requiredNarratedCount > 0 && narratedBlocks.length < requiredNarratedCount) {
    out.push({
      code: 'NARRATIVE_PLAN_INCONSISTENT',
      message: `spine.narrativePlan / storyScope.commentaryOpportunities declared ${requiredNarratedCount} narrated storyteller moment(s), but spine.deliveryBlocks only has ${narratedBlocks.length} block(s) with mode='narrated_story'. Realize every plannedNarratedMoment as a mode='narrated_story' block over clean B-roll windows.`
    });
  }
  if (scopeOpportunities.length > 0 && blocks.length > 0) {
    const lastBlock = blocks[blocks.length - 1];
    const prevBlock = blocks.length > 1 ? blocks[blocks.length - 2] : null;
    const hasClosingNarratedBlock = (lastBlock.mode === 'narrated_story' && (lastBlock.narratorFunction === 'PAYOFF' || lastBlock.narratorFunction === 'CLOSING' || !lastBlock.narratorFunction))
      || (prevBlock && prevBlock.mode === 'narrated_story' && (prevBlock.narratorFunction === 'PAYOFF' || prevBlock.narratorFunction === 'CLOSING' || !prevBlock.narratorFunction) && lastBlock.mode === 'raw_evidence');
    if (!hasClosingNarratedBlock && lastBlock.mode !== 'narrated_story') {
      out.push({
        code: 'NARRATIVE_PLAN_INCONSISTENT',
        blockId: lastBlock.blockId,
        message: `When storyteller commentary is active, the edit MUST include a closing narrated block (CLOSING / PAYOFF) delivering the grounded lesson takeaway and comment-provoking question.`
      });
    }
  }
  const beatMap = new Map((beats || []).map(b => [b.beatId, b]));
  // Prevent excessive uninterrupted raw-only walls (>34s) in commentary_led mode when commentaryOpportunities exist
  if (scopeOpportunities.length >= 3 && pacingMode !== 'evidence_heavy' && blocks.length > 0) {
    let rawRunSec = 0;
    let rawRunBlocks = [];
    const checkRun = () => {
      if (rawRunSec > 34.0) {
        out.push({
          code: 'UNINTERRUPTED_RAW_WALL',
          message: `Consecutive raw_evidence block(s) (${rawRunBlocks.join(', ')}) run for ${round2(rawRunSec)}s without editorial narrator guidance. In commentary_led mode, break distinct conflict phases with a concise REHOOK / INTERPRETATION / ANTICIPATION narrated_story block over clean in-scope B-roll so the narrator actively drives curiosity without spoiling upcoming raw punchlines.`
        });
      }
    };
    for (const blk of blocks) {
      const dur = (blk.beatIds || []).reduce((sum, id) => {
        const b = beatMap.get(id);
        return sum + (b ? Math.max(0, num(b.sourceEndSec) - num(b.sourceStartSec)) : 0);
      }, 0);
      if (blk.mode === 'raw_evidence') {
        rawRunSec += dur;
        rawRunBlocks.push(blk.blockId);
      } else {
        checkRun();
        rawRunSec = 0;
        rawRunBlocks = [];
      }
    }
    checkRun();
  }
  for (const nb of narratedBlocks) {
    const isEnding = (nb === blocks[blocks.length - 1] || nb.narratorFunction === 'CLOSING' || nb.narratorFunction === 'PAYOFF');
    const minDur = isEnding ? 3.8 : 4.5;
    const dur = (nb.beatIds || []).reduce((sum, id) => {
      const b = beatMap.get(id);
      return sum + (b ? Math.max(0, num(b.sourceEndSec) - num(b.sourceStartSec)) : 0);
    }, 0);
    if (dur > 0 && dur < minDur) {
      out.push({
        code: 'NARRATIVE_PLAN_INCONSISTENT',
        blockId: nb.blockId,
        message: `Narrated block '${nb.blockId}' is only ${round2(dur)}s long, which squeezes natural storyteller delivery (causing rushed speech or a 3-word fragment). Extend its clean visual beat range inside the cuttable scope window (<= liveActionEndSec) or group adjacent clean visual beat(s) so '${nb.blockId}' is ${isEnding ? '4.2-7.5s' : '5.0-10.0s'} long.`
      });
    }
  }
  return out;
}

// Scope-local slice of the Source Story Model: only what the reel covers (clamped to liveActionEndSec).
function modelContextForReel(model, reel, liveActionEndSec = Infinity) {
  const cap = Number.isFinite(num(liveActionEndSec)) && num(liveActionEndSec) > 0 ? num(liveActionEndSec) : Infinity;
  const inReel = (s, e) => s < cap - 0.05 && (reel?.ranges || []).some(r => Math.min(e, r.sourceEndSec, cap) - Math.max(s, r.sourceStartSec) > 0);
  const events = (model?.events || []).filter(e => inReel(num(e.startSec), num(e.endSec)))
    .map(e => ({ id: e.id, startSec: e.startSec, endSec: Math.min(num(e.endSec), round2(cap)), type: e.type, summary: e.summary, location: e.location, peopleIds: e.peopleIds, tension: e.tension, dialogueImpact: e.dialogueImpact, isReveal: e.isReveal }));
  const quotes = (model?.quotes || []).filter(q => inReel(num(q.startSec), num(q.endSec)))
    .map(q => ({ id: q.id, eventId: q.eventId, speaker: q.speaker, startSec: q.startSec, endSec: Math.min(num(q.endSec), round2(cap)), text: q.text, epistemic: q.epistemic, editorialValue: q.editorialValue }));
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
    const useStoryteller = shape === validateShape
      && input?.narrationEnabled !== false
      && Array.isArray(input?.storyScope?.commentaryOpportunities)
      && input.storyScope.commentaryOpportunities.length > 0;
    const schema = useStoryteller ? schemas.directorEdlStoryteller : schemas.directorEdl;
    return { result: await engine.ask(key, input, schema, instr, evidence, shape, 'auto_story_edit', { ...DIRECTOR_GENERATION }) };
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
async function prepareReel(engine, scope, model = null, { liveActionEndSec = null, endingBoundary: endingBoundaryMeta = null } = {}) {
  const cfg = engine.config || {};
  const maxLive = resolveLiveActionBoundary({ liveActionEndSec, endingBoundary: endingBoundaryMeta, scope, model, durationSec: engine.duration });
  const reel = Scope.planScopeReel(scope, {
    durationSec: engine.duration,
    paddingSec: cfg.scopeReelPaddingSec ?? Scope.DEFAULT_REEL_PADDING_SEC,
    maxScopeReelSec: cfg.maxScopeReelSec || Scope.DEFAULT_MAX_SCOPE_REEL_SEC,
    model,
    maxReelFiles: cfg.maxReelFiles || undefined,
    liveActionEndSec: maxLive,
    endingBoundary: endingBoundaryMeta
  });
  if (!reel.ranges.length) throw new StoryError('STORY_SCOPE_INVALID', 'Story Scope has no reel windows.');
  if (reel.fileCount > reel.maxReelFiles) throw new StoryError('STORY_SCOPE_INVALID', `Reel packs into ${reel.fileCount} files; provider limit is ${reel.maxReelFiles}.`);
  const evidence = await Packer.buildReelFiles(engine, reel, { fps: cfg.directorReelFps || DIRECTOR_REEL_FPS });
  return { reel, evidence, liveActionEndSec: maxLive };
}

const UNDER_MIN_REPAIR_INSTRUCTION = `UNDER-MINIMUM REPAIR (the scope reel is attached again: watch it).
input.currentEdl is editorially coherent and structurally valid, but its total is below the hard minimum — see input.durationRepair.
This is a MINIMAL-CHANGE editorial repair. Reaching input.targetDurationMinSec is REQUIRED. Moving toward input.targetDurationSec is OPTIONAL and only for material that genuinely improves comprehension, proof, emotion, contradiction or payoff. Do not add filler or explanatory footage merely for duration.
FIRST preference: extend an EXISTING selected beat into adjacent meaningful footage inside the same cuttable logical scope segment (see input.extensionOpportunities, strictly within input.liveActionEndSec).
Only if meaningful extensions cannot reach the minimum: add a new meaningful beat BEFORE the ending (never after it), strictly within input.liveActionEndSec, and update delivery-block membership as required.
Return the COMPLETE EDL in its final order, with spine.deliveryBlocks, spine.transitionChecks and spine.openingStrategy.
Set repairOutcome.status='repaired', or 'scope_infeasible' with reason if the watched footage genuinely lacks material.`;
const DURATION_REPAIR_INSTRUCTION = UNDER_MIN_REPAIR_INSTRUCTION;

const DURATION_COMPRESSION_INSTRUCTION = `DURATION COMPRESSION REPAIR (text-only: NO video is attached to this request, and none is needed).
Your EDL (input.currentEdl) is media-grounded but TOO LONG. This is COMPRESSION ONLY: return a shortened subset of input.currentEdl.
input.beatBudget lists every current beat; input.durationCompression gives the exact reduction required.
Allowed: shorten an existing beat INSIDE its current range; remove an existing beat that is redundant or procedural slack.
CRITICAL: Preserve your narrated_story commentary blocks and preserve high-value raw quotes/punchlines (input.visualOwnershipMap.highValueRawQuotes); trim slack from overly long procedural raw beats first.
Not allowed: new beats, expanding any source range, reordering surviving beats, or changing Story Scope.
Return spine.deliveryBlocks for surviving beats and spine.transitionChecks for every consecutive block boundary. Set accessGranted=true once read.`;

const COMPRESSION_EPS_SEC = 0.05;
const STALL_EPS_SEC = 0.5;

function beatBudget(edl) {
  return (edl?.beats || []).map(b => ({ beatId: b.beatId, sourceStartSec: b.sourceStartSec, sourceEndSec: b.sourceEndSec,
    durationSec: round2(beatLen(b)), narrativeRole: b.narrativeRole, newInformation: b.newInformation || '', whyNecessaryNow: b.whyNecessaryNow || '' }));
}

function summarizeNarratorPlan(spine) {
  const beats = Array.isArray(spine?.beats) ? spine.beats : [];
  const beatMap = new Map(beats.map(b => [b.beatId, b]));
  const blocks = (Array.isArray(spine?.deliveryBlocks) ? spine.deliveryBlocks : []).filter(b => b?.mode === 'narrated_story');
  let narratedSec = 0;
  for (const blk of blocks) {
    for (const id of blk.beatIds || []) {
      const b = beatMap.get(id);
      if (b) narratedSec += beatLen(b);
    }
  }
  const totalSec = timelineSec(beats);
  return {
    narratedBlockCount: blocks.length,
    narratedDurationSec: round2(narratedSec),
    totalDurationSec: round2(totalSec),
    narratedShare: totalSec > 0 ? round2(narratedSec / totalSec) : 0,
    functions: blocks.map(b => b.narratorFunction || 'COMMENTARY')
  };
}

/**
 * Compares narrator coverage before and after a repair pass so validators/repairs
 * cannot silently gut commentary storytelling into a raw-only clip reel!
 */
function compareNarratorPlans(beforeSpine, afterSpine, { pacingMode = 'commentary_led', narrationEnabled = true } = {}) {
  const before = summarizeNarratorPlan(beforeSpine);
  const after = summarizeNarratorPlan(afterSpine);
  if (!narrationEnabled || pacingMode === 'evidence_heavy' || before.narratedBlockCount < 2) {
    return { before, after, regressed: false, violations: [] };
  }
  const violations = [];
  const blocksDropped = before.narratedBlockCount - after.narratedBlockCount;
  const durRatio = before.narratedDurationSec > 0 ? after.narratedDurationSec / before.narratedDurationSec : 1;
  if (blocksDropped >= 2 || (before.narratedBlockCount >= 3 && after.narratedBlockCount < 3) || (before.narratedDurationSec >= 14 && durRatio < 0.55)) {
    violations.push({
      code: 'NARRATOR_REGRESSION_IN_REPAIR',
      message: `Repair degraded narrator-led storytelling from ${before.narratedBlockCount} narrated blocks (${before.narratedDurationSec}s) down to ${after.narratedBlockCount} narrated blocks (${after.narratedDurationSec}s). Do NOT fix handoff or duration violations by deleting narrator commentary — swap narrated blocks onto clean visual B-roll windows in input.visualOwnershipMap.cleanVisualBrollWindows and trim slack from long raw beats instead.`,
      before,
      after
    });
  }
  return { before, after, regressed: violations.length > 0, violations };
}

/**
 * Ensures repairs do not strip high-value raw quotes/punchlines that were already present in `beforeSpine`.
 */
function punchlinePreservationViolations(beforeSpine, afterSpine, modelOrQuotes = null) {
  const explicitArray = Array.isArray(modelOrQuotes);
  const quotes = explicitArray ? modelOrQuotes : (Array.isArray(modelOrQuotes?.quotes) ? modelOrQuotes.quotes : []);
  if (!quotes.length || !beforeSpine?.beats?.length || !afterSpine?.beats?.length) return [];
  const beforeRaw = deliveryBeats(beforeSpine).filter(b => (b.audioMode || 'original_audio') === 'original_audio');
  const afterRaw = deliveryBeats(afterSpine).filter(b => (b.audioMode || 'original_audio') === 'original_audio');
  const isHighValue = q => explicitArray
    || num(q.editorialValue) >= 0.7
    || /^(high|critical|iconic|key|strong)$/i.test(String(q.editorialValue || q.epistemic || ''))
    || spokenWordCount(q.text) >= 5;
  const coversQuote = (rawBeats, q) => {
    const qs = num(q.sourceStartSec ?? q.startSec), qe = num(q.sourceEndSec ?? q.endSec);
    if (!(qe > qs)) return false;
    const span = qe - qs;
    return rawBeats.some(b => {
      const ov = Math.min(num(b.sourceEndSec), qe) - Math.max(num(b.sourceStartSec), qs);
      return ov >= Math.min(1.2, span * 0.65);
    });
  };
  const out = [];
  for (const q of quotes.filter(isHighValue)) {
    const qs = num(q.sourceStartSec ?? q.startSec), qe = num(q.sourceEndSec ?? q.endSec);
    if (coversQuote(beforeRaw, q) && !coversQuote(afterRaw, q)) {
      out.push({
        code: 'HIGH_VALUE_QUOTE_LOST_IN_REPAIR',
        quoteId: q.quoteId || q.id || null,
        message: `Repair dropped high-value raw quote (${qs}-${qe}s: "${String(q.text || '').slice(0, 80)}") that was preserved in the prior EDL. Keep iconic verbal punchlines and authoritative rebuttals as raw_evidence.`
      });
    }
  }
  return out;
}

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

async function runDirector(engine, { model, scope, reel, evidence, key, extraInput = {}, repairText = null, root, write, emit = () => {}, maxTechnicalRepairs = 2, liveActionEndSec = null, endingBoundary: endingBoundaryMeta = null, pacingMode = null }) {
  const cfg = engine.config || {};
  const resolvedPacingMode = pacingMode || cfg.pacingMode || 'commentary_led';
  const maxLiveSec = resolveLiveActionBoundary({ liveActionEndSec, endingBoundary: endingBoundaryMeta, scope, model, durationSec: engine.duration });
  const targets = durationTargets(scope, cfg);
  const cues = engine?.cues || [];
  const visualOwnershipMap = buildVisualOwnershipMap(reel, model, cues, maxLiveSec);
  const baseInput = {
    storyScope: scope,
    scopeReelManifest: reel.manifest,
    scopeReelFiles: reel.files,
    sourceDurationSec: engine.duration,
    liveActionEndSec: round2(maxLiveSec),
    ...(maxLiveSec < (Number(engine.duration) || Infinity) - 0.05 ? {
      endingBoundaryWarning: `Valid live-action incident footage ends strictly at ${round2(maxLiveSec)}s; post-incident outro/recap graphics start after ${round2(maxLiveSec)}s. Every beat's sourceEndSec MUST be <= ${round2(maxLiveSec)}s.`
    } : {}),
    targetDurationMinSec: targets.hardMinSec,
    targetDurationMaxSec: targets.hardMaxSec,
    targetDurationSec: targets.targetDurationSec,
    targetBandMinSec: targets.targetBandMinSec,
    targetBandMaxSec: targets.targetBandMaxSec,
    storyMode: cfg.storyMode || 'serialized_part',
    pacingMode: resolvedPacingMode,
    narrationEnabled: cfg.narration?.enabled !== false,
    narrationWordsPerSecond: cfg.narration?.measuredWordsPerSecond || 2.45,
    modelContext: modelContextForReel(model, reel, maxLiveSec),
    visualOwnershipMap,
    ...extraInput
  };
  const valOpts = {
    durationSec: engine.duration,
    targetDurationMinSec: targets.hardMinSec,
    targetDurationMaxSec: targets.hardMaxSec,
    reel,
    narrationEnabled: baseInput.narrationEnabled,
    preferredDurationSec: targets.targetDurationSec,
    targetBandMinSec: targets.targetBandMinSec,
    targetBandMaxSec: targets.targetBandMaxSec,
    requireDeliveryBlocks: true,
    cues,
    liveActionEndSec: maxLiveSec,
    endingBoundary: endingBoundaryMeta,
    pacingMode: resolvedPacingMode
  };
  const attempts = [];
  const baselineRepairSpine = extraInput.currentEdl || null;
  let violations = null, current = extraInput.currentEdl || null, reelObservations = '', previousCompression = null;
  let lastAccepted = null, lastInvalidRepair = null, previousUnderMin = null, stalledRepair = null;
  let effectiveMaxRepairs = maxTechnicalRepairs;
  for (let attempt = 0; attempt <= effectiveMaxRepairs; attempt++) {
    const technical = attempt > 0;
    const durationOnly = technical && current && onlyDurationViolations(violations);
    const compress = durationOnly && violations.some(v => v.code === 'TOTAL_DURATION_OVER_MAX');
    const underMin = durationOnly && !compress && violations.some(v => v.code === 'TOTAL_DURATION_UNDER_MIN');
    let result, schemaError, mode, callKey, compressionDelta = null;
    if (compress) {
      mode = 'duration_compression'; callKey = `${key}_compress${attempt}`;
      compressionDelta = durationDelta(timelineSec(current.beats), targets);
      const input = { ...baseInput, currentEdl: current, violations, reelObservations, beatBudget: beatBudget(current),
        durationCompression: compressionDelta, ...(previousCompression ? { previousCompression } : {}) };
      const instr = `${DURATION_COMPRESSION_INSTRUCTION}\n${compressionReminder(compressionDelta, previousCompression)}`;
      ({ result, schemaError } = await callDirector(engine, callKey, input, instr, [], validateTextShape));
    } else if (underMin) {
      mode = 'multimodal_under_min'; callKey = `${key}_undermin${attempt}`;
      const d = durationDelta(timelineSec(current.beats), targets);
      const input = { ...baseInput, currentEdl: current, violations, reelObservations, durationRepair: d,
        extensionOpportunities: extensionOpportunities(current.beats, reel, engine.duration, maxLiveSec),
        ...(previousUnderMin ? { previousUnderMinRepair: previousUnderMin } : {}) };
      const lines = [UNDER_MIN_REPAIR_INSTRUCTION,
        `You MUST add at least ${d.requiredAdditionToMinimumSec} meaningful seconds so the final timeline reaches the ${d.minimumDurationSec}s hard minimum.`,
        `You MAY add up to ${d.preferredAdditionToTargetSec}s more toward ${d.targetDurationSec}s only if that material genuinely improves comprehension, proof, emotion, contradiction or payoff. Do not add filler merely to reach the preferred target.`];
      if (previousUnderMin?.stalled) {
        lines.push(`Your previous repair returned the same ${previousUnderMin.afterSec}s timeline and did not satisfy the hard minimum. Do NOT return the same source ranges again (input.previousUnderMinRepair.unchangedBeatRanges); either extend/add meaningful watched footage inside <= input.liveActionEndSec or explicitly report repairOutcome.status='scope_infeasible'.`);
      } else if (previousUnderMin) {
        lines.push(`Your previous under-minimum repair (${previousUnderMin.beforeSec}s -> ${previousUnderMin.afterSec}s) was rejected: ${previousUnderMin.codes.join(', ')}. It is discarded; repair input.currentEdl (the last valid EDL) again.`);
      }
      const instr = [instruction, repairText, lines.join('\n')].filter(Boolean).join('\n\n');
      ({ result, schemaError } = await askDirector(engine, callKey, input, instr, evidence));
    } else {
      mode = technical ? 'multimodal_technical' : 'multimodal'; callKey = `${key}${technical ? `_fix${attempt}` : ''}`;
      const input = technical ? { ...baseInput, currentEdl: current, violations } : baseInput;
      const instr = [instruction, repairText, technical ? repairInstruction('technical', { violations }) : null].filter(Boolean).join('\n\n');
      ({ result, schemaError } = await askDirector(engine, callKey, input, instr, evidence));
    }
    let spine = result?.spine || null;
    if (spine && mode === 'duration_compression' && Array.isArray(spine.deliveryBlocks)) {
      spine = { ...spine, deliveryBlocks: Delivery.pruneRemovedBeats(spine.deliveryBlocks, spine.beats) };
    }
    let report = schemaError
      ? { valid: false, violations: [{ code: 'SCHEMA_INVALID', message: `Response did not match the EDL contract: ${schemaError}` }], metrics: {} }
      : validateDirectorEdl(spine, scope, valOpts);
    if (!schemaError && technical && spine && current) {
      const was = (current.beats || [])[current.beats.length - 1], now = (spine.beats || [])[spine.beats.length - 1];
      const nowBlocks = Array.isArray(spine.deliveryBlocks) ? spine.deliveryBlocks : [];
      const lastBlk = nowBlocks[nowBlocks.length - 1];
      const isNarratedClosingTail = Boolean(
        lastBlk
        && lastBlk.mode === 'narrated_story'
        && (lastBlk.narratorFunction === 'CLOSING' || lastBlk.narratorFunction === 'PAYOFF')
        && (lastBlk.beatIds || []).includes(now?.beatId)
        && (spine.beats || []).slice(0, -1).some(b => b.scopeMembership === 'ending')
      );
      if (was?.scopeMembership === 'ending' && now && now.scopeMembership !== 'ending' && !isNarratedClosingTail) {
        report = { ...report, valid: false, violations: [...report.violations, { code: 'ENDING_DISPLACED',
          message: `The repaired EDL no longer ends on its ending beat: '${now.beatId}' (${now.scopeMembership}) comes after it. Place new material BEFORE the ending.`, beatId: now.beatId }] };
      }
    }
    // Check narrator-plan regression & high-value punchline preservation across repairs
    let narratorComparison = null;
    const referencePriorSpine = baselineRepairSpine || (technical ? current : null);
    if (!schemaError && spine && referencePriorSpine) {
      narratorComparison = compareNarratorPlans(referencePriorSpine, spine, { pacingMode: resolvedPacingMode, narrationEnabled: baseInput.narrationEnabled });
      const lostQuotes = punchlinePreservationViolations(referencePriorSpine, spine, model);
      const extraRepairViolations = [...narratorComparison.violations, ...lostQuotes];
      if (extraRepairViolations.length) {
        report = { ...report, valid: false, violations: [...report.violations, ...extraRepairViolations] };
      }
    }
    if (!schemaError && mode === 'multimodal_under_min' && spine && current) {
      const overlaps = extensionOverlapViolations(current, spine);
      if (overlaps.length) report = { ...report, valid: false, violations: [...report.violations, ...overlaps] };
    }
    let monotonic = null;
    if (mode === 'duration_compression' && !schemaError) {
      monotonic = compressionViolations(current, spine);
      if (monotonic.length) report = { ...report, valid: false, violations: [...monotonic, ...report.violations] };
    }
    const textOnly = mode === 'duration_compression';
    if (result?.reelObservations && !textOnly) reelObservations = result.reelObservations;
    const entry = { attempt, mode, valid: report.valid, violations: report.violations, metrics: report.metrics, mediaFiles: textOnly ? 0 : evidence.length,
      ...(narratorComparison ? { narratorComparison: { before: narratorComparison.before, after: narratorComparison.after, regressed: narratorComparison.regressed } } : {}),
      ...(compressionDelta ? { durationCompression: compressionDelta, beatCountBefore: current.beats.length, beatCountAfter: spine?.beats?.length ?? null } : {}) };
    attempts.push(entry);
    if (write && root) await write(path.join(root, `${callKey}.json`), { mode, result, validation: report,
      ...(narratorComparison ? { narratorComparison } : {}),
      ...(compressionDelta ? { durationCompression: compressionDelta, beatCountBefore: entry.beatCountBefore, beatCountAfter: entry.beatCountAfter } : {}) });
    if (report.valid) return { spine, report, reelObservations: reelObservations || result.reelObservations, attempts, narratorComparison };
    const structurallyValid = Boolean(spine) && !schemaError && onlyDurationViolations(report.violations);
    entry.structurallyValid = structurallyValid;

    if (mode === 'duration_compression') {
      const before = compressionDelta.currentDurationSec, after = spine ? round2(timelineSec(spine.beats)) : null;
      if ((monotonic || []).some(v => v.code === 'DURATION_REPAIR_STALLED')) {
        emit('design', `[Director] Duration compression stalled (${before}s -> ${after}s); stopping.`, 'WARNING');
        throw new StoryError('DIRECTOR_EDL_INVALID', `Editorial Director duration compression stalled at ${after}s (hard maximum ${targets.hardMaxSec}s): DURATION_REPAIR_STALLED`,
          { violations: report.violations, attempts, spine: current, stalled: true });
      }
      const rejected = schemaError ? ['SCHEMA_INVALID'] : (monotonic || []).map(v => v.code);
      if (rejected.length) {
        previousCompression = { beforeSec: before, afterSec: after, accepted: false, codes: rejected };
        emit('design', `[Director] Compression response rejected (${rejected.join(', ')}); retrying from ${before}s.`, 'WARNING');
        continue;
      }
      if (!structurallyValid) {
        const codes = report.violations.filter(v => !DURATION_CODES.has(v.code)).map(v => v.code);
        previousCompression = { beforeSec: before, afterSec: after, accepted: false, codes };
        lastInvalidRepair = { attempt, mode, spine, violations: report.violations };
        emit('design', `[Director] Compression response rejected (${codes.join(', ')}); retrying from ${before}s.`, 'WARNING');
        continue;
      }
      previousCompression = { beforeSec: before, afterSec: after, accepted: true, codes: [] };
    }

    if (mode === 'multimodal_under_min' && !schemaError && spine) {
      if (result?.repairOutcome?.status === 'scope_infeasible' && String(result.repairOutcome.reason || '').trim()) {
        entry.repairOutcome = result.repairOutcome;
        emit('design', `[Director] Under-minimum repair: scope infeasible — ${result.repairOutcome.reason}`, 'WARNING');
        throw new StoryError('UNDER_MIN_SCOPE_INFEASIBLE', `Editorial Director reports that this Story Scope cannot reach the ${targets.hardMinSec}s hard minimum without filler: ${result.repairOutcome.reason}`,
          { reason: result.repairOutcome.reason, attempts, spine: lastAccepted || current, lastAcceptedSpine: lastAccepted || current, currentDurationSec: round2(timelineSec((lastAccepted || current).beats)) });
      }
    }
    const structurallyValidNow = Boolean(spine) && !schemaError && onlyDurationViolations(report.violations);
    if (mode === 'multimodal_under_min' && structurallyValidNow) {
      const stall = underMinStall(current, spine);
      if (stall) {
        previousUnderMin = { beforeSec: stall.beforeSec, afterSec: stall.afterSec, stalled: true, unchangedBeatRanges: stall.unchangedBeatRanges, codes: [stall.code] };
        entry.stalled = true; entry.violations = [stall, ...report.violations];
        report = { ...report, violations: [stall, ...report.violations] };
        stalledRepair = { attempt, mode, spine, violations: report.violations };
        emit('design', `[Director] Under-minimum repair stalled (${stall.afterSec}s, identical ranges); ${attempt < maxTechnicalRepairs ? 'next repair is told it stalled' : 'no repair slot remains'}.`, 'WARNING');
        continue;
      }
    }
    if (mode === 'multimodal_under_min' && !structurallyValidNow) {
      const codes = schemaError ? ['SCHEMA_INVALID'] : report.violations.filter(v => !DURATION_CODES.has(v.code)).map(v => v.code);
      previousUnderMin = { beforeSec: round2(timelineSec(current.beats)), afterSec: spine ? round2(timelineSec(spine.beats)) : null, codes };
      lastInvalidRepair = { attempt, mode, spine, violations: report.violations };
      entry.rejected = true;
      emit('design', `[Director] Under-minimum repair rejected (${codes.join(', ')}); ${attempt < maxTechnicalRepairs ? `retrying from the last valid EDL (${previousUnderMin.beforeSec}s)` : 'no repair slot remains'}.`, 'WARNING');
      continue;
    }
    if (structurallyValid) { lastAccepted = spine; if (mode === 'multimodal_under_min') previousUnderMin = null; }

    if (spine && !schemaError && report.violations.length > 0 && report.violations.every(v => v.code === 'OUTSIDE_SCOPE_REEL')) {
      const padTech = technicalWindowPaddingAdjustment(spine, reel, { durationSec: engine.duration, liveActionEndSec: maxLiveSec });
      if (padTech.applied) {
        const recheck = validateDirectorEdl(padTech.spine, scope, valOpts);
        if (recheck.valid) {
          entry.technicalWindowPaddingAdjustment = padTech.adjustments;
          entry.technicalRecheck = { valid: recheck.valid, violations: recheck.violations, metrics: recheck.metrics };
          if (write && root) await write(path.join(root, `${callKey}-padding-adjustment.json`), { technicalWindowPaddingAdjustment: padTech.adjustments, validation: recheck });
          emit('design', `[Director] Technical window-padding clamp: ${padTech.adjustments.map(a => `${a.beatId} ${a.oldStartSec}-${a.oldEndSec}s -> ${a.newStartSec}-${a.newEndSec}s`).join(', ')} (${recheck.metrics.totalSec}s).`);
          return { spine: { ...padTech.spine, technicalWindowPaddingAdjustment: padTech.adjustments }, report: recheck, reelObservations: reelObservations || result.reelObservations, attempts, narratorComparison };
        }
      }
    }

    if (spine && onlyDurationViolations(report.violations) && report.violations.every(v => v.code === 'TOTAL_DURATION_UNDER_MIN')) {
      const tech = technicalDurationAdjustment(spine, reel, { hardMinSec: targets.hardMinSec, durationSec: engine.duration, liveActionEndSec: maxLiveSec });
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
    const nextKind = !onlyDurationViolations(report.violations) ? 'multimodal technical'
      : report.violations.some(v => v.code === 'TOTAL_DURATION_OVER_MAX') ? 'text-only compression' : 'multimodal under-minimum';
    if (attempt === effectiveMaxRepairs && effectiveMaxRepairs === maxTechnicalRepairs && structurallyValid
      && !previousCompression && report.violations.every(v => v.code === 'TOTAL_DURATION_OVER_MAX')
      && Array.isArray(scope?.commentaryOpportunities) && scope.commentaryOpportunities.length > 0) {
      effectiveMaxRepairs = maxTechnicalRepairs + 1;
    }
    if (attempt < effectiveMaxRepairs) emit('design', `[Director] EDL needs repair #${attempt + 1} (${nextKind}): ${report.violations.map(v => v.code).join(', ')}`, 'WARNING');
    else emit('design', `[Director] EDL still invalid (${report.violations.map(v => v.code).join(', ')}); no repair slot remains.`, 'WARNING');
    violations = report.violations;
    current = structurallyValid ? spine : (lastAccepted || spine || current);
  }
  const lastViolations = attempts[attempts.length - 1]?.violations || violations;
  throw new StoryError('DIRECTOR_EDL_INVALID', `Editorial Director EDL failed validation after ${maxTechnicalRepairs} repair pass(es): ${lastViolations.map(v => v.code).join(', ')}`,
    { violations: lastViolations, attempts, spine: lastAccepted || current, lastAcceptedSpine: lastAccepted, lastInvalidRepair, stalledRepair });
}

async function directEdl(engine, { model, scope, root = null, write = null, emit = () => {}, scriptId = 1, liveActionEndSec = null, endingBoundary: endingBoundaryMeta = null, pacingMode = null, extraInput = {} }) {
  if (!scope) throw new StoryError('INPUT_MISSING', 'Editorial Director requires a selected Story Scope.');
  const { reel, evidence, liveActionEndSec: maxLive } = await prepareReel(engine, scope, model, { liveActionEndSec, endingBoundary: endingBoundaryMeta });
  const modeSuffix = pacingMode && pacingMode !== 'commentary_led' ? `-${pacingMode}` : '';
  emit('design', `[Director] Watching scope reel (${pacingMode || engine.config?.pacingMode || 'commentary_led'}, liveActionEndSec=${round2(maxLive)}s): ${reel.logicalWindowCount} logical window(s), ${reel.fileCount} reel file(s), ${reel.manifest.length} manifest segment(s), ${reel.totalSec}s of media.`);
  const out = await runDirector(engine, { model, scope, reel, evidence, key: `v5-editorial-director-${scriptId}${modeSuffix}`, extraInput, root, write, emit, liveActionEndSec: maxLive, endingBoundary: endingBoundaryMeta, pacingMode });
  const spine = stampSpine(out.spine, scope, reel, { reelObservations: out.reelObservations, attempts: out.attempts, liveActionEndSec: round2(maxLive), pacingMode: pacingMode || engine.config?.pacingMode || 'commentary_led' });
  return { spine, evidence, reel, report: out.report };
}

async function repairEdl(engine, { model, spine, critique, weakRegions = [], root = null, write = null, emit = () => {}, pass = 1, scriptId = 1, liveActionEndSec = null, endingBoundary: endingBoundaryMeta = null, pacingMode = null }) {
  if (!isDirectorSpine(spine)) throw new StoryError('INPUT_MISSING', 'repairEdl requires a director-owned spine.');
  const scope = spine.storyScope;
  const resolvedPacing = pacingMode || spine.directorMeta?.pacingMode || engine.config?.pacingMode || 'commentary_led';
  const { reel, evidence, liveActionEndSec: maxLive } = await prepareReel(engine, scope, model, { liveActionEndSec, endingBoundary: endingBoundaryMeta });
  const currentEdl = { ...spine, storyScope: undefined, scopeReel: undefined, directorMeta: undefined };
  const out = await runDirector(engine, {
    model, scope, reel, evidence, key: `v5-editorial-director-repair-${scriptId}-${pass}`,
    extraInput: {
      currentEdl,
      weakRegions,
      criticFindings: { summary: critique?.summary || '', issues: critique?.issues || [], scopeSurvived: critique?.scopeSurvived, endingIsConsequence: critique?.endingIsConsequence }
    },
    repairText: repairInstruction('critic'),
    root, write, emit,
    liveActionEndSec: maxLive,
    endingBoundary: endingBoundaryMeta,
    pacingMode: resolvedPacing
  });
  const narratorComparison = compareNarratorPlans(spine, out.spine, { pacingMode: resolvedPacing, narrationEnabled: engine.config?.narration?.enabled !== false });
  const repaired = stampSpine(out.spine, scope, reel, { reelObservations: out.reelObservations, attempts: out.attempts, repairPass: pass, liveActionEndSec: round2(maxLive), pacingMode: resolvedPacing, narratorComparison });
  return { spine: repaired, evidence, reel, report: out.report, narratorComparison, request: { scope, currentEdl, weakRegions, reel, evidenceFiles: evidence.map(e => e.file) } };
}

const DELIVERY_ONLY_REPAIR_INSTRUCTION = `DELIVERY-ONLY TECHNICAL REPAIR.
The EDL is LOCKED. input.currentEdl.beats are already media-grounded and MUST remain byte-for-byte equivalent in identity, order and source ranges. Do NOT output beats and do NOT select new footage.
Repair ONLY input.currentEdl.deliveryBlocks and transitionChecks to resolve input.violations.
Preserve every unaffected block when possible. Every existing beat must belong to exactly one block; block membership is consecutive in EDL order; blocks follow EDL order.
For NARRATED_BLOCK_VOICE_OVERFLOW / NARRATED_BLOCK_UNFIT:
- shorten the failing narrated block's narrationIntent so it fits comfortably at natural speaking speed;
- OR regroup adjacent clean visual beat(s) into the narrated block without talking over essential raw proof;
- Avoid deleting narrator commentary unless the underlying beat itself already conveys the full context in raw audio.
Return only reason, deliveryBlocks and transitionChecks.`;

async function repairDeliveryTechnical(engine, { model, spine, violations, root = null, write = null, emit = () => {}, scriptId = 1, liveActionEndSec = null, endingBoundary: endingBoundaryMeta = null }) {
  if (!isDirectorSpine(spine)) throw new StoryError('INPUT_MISSING', 'repairDeliveryTechnical requires a director-owned spine.');
  const scope = spine.storyScope;
  const maxLive = resolveLiveActionBoundary({ liveActionEndSec, endingBoundary: endingBoundaryMeta, scope, model, durationSec: engine.duration });
  const reel = spine.scopeReel || (await prepareReel(engine, scope, model, { liveActionEndSec: maxLive, endingBoundary: endingBoundaryMeta })).reel;
  const currentEdl = { ...spine, storyScope: undefined, scopeReel: undefined, directorMeta: undefined };
  const targets = durationTargets(scope, engine.config || {});
  const resolvedPacing = spine.directorMeta?.pacingMode || engine.config?.pacingMode || 'commentary_led';
  const valOpts = {
    durationSec: engine.duration,
    targetDurationMinSec: targets.hardMinSec,
    targetDurationMaxSec: targets.hardMaxSec,
    reel,
    narrationEnabled: engine.config?.narration?.enabled !== false,
    preferredDurationSec: targets.targetDurationSec,
    targetBandMinSec: targets.targetBandMinSec,
    targetBandMaxSec: targets.targetBandMaxSec,
    requireDeliveryBlocks: true,
    cues: engine?.cues || [],
    liveActionEndSec: maxLive,
    endingBoundary: endingBoundaryMeta,
    pacingMode: resolvedPacing
  };
  let accepted = null, validation = null;
  const key = `v5-editorial-director-delivery-fix-${scriptId}`;
  const input = {
    currentEdl,
    violations,
    narrationWordsPerSecond: engine.config?.narration?.measuredWordsPerSecond || 2.45
  };
  const result = await engine.ask(key, input, schemas.deliveryRepairResult, DELIVERY_ONLY_REPAIR_INSTRUCTION, [], v => {
    const candidate = { ...currentEdl, deliveryBlocks: v.deliveryBlocks, transitionChecks: v.transitionChecks };
    assertEdlIntact(spine.beats, candidate.beats, engine.duration);
    const report = validateDirectorEdl(candidate, scope, valOpts);
    if (!report.valid) throw new StoryError('INVALID_RESPONSE',
      `Delivery-only repair is invalid: ${report.violations.map(x => x.code).join(', ')}`,
      { violations: report.violations });
    accepted = candidate;
    validation = report;
  }, 'auto_story_repair', { ...DIRECTOR_GENERATION });
  if (!accepted) throw new StoryError('INVALID_RESPONSE', 'Delivery-only repair returned no accepted candidate.');
  if (write && root) await write(path.join(root, `${key}.json`), { mode: 'delivery_only', input: { violations }, result, validation });
  emit('design', `[Director] Delivery-only repair accepted; EDL remains locked at ${timelineSec(spine.beats)}s.`);
  return {
    spine: stampSpine(accepted, scope, reel, {
      ...(spine.directorMeta || {}),
      downstreamDeliveryRepair: true,
      deliveryRepairReason: result.reason,
      liveActionEndSec: round2(maxLive)
    }),
    reel,
    report: validation
  };
}

async function repairTechnical(engine, { model, spine, violations, root = null, write = null, emit = () => {}, scriptId = 1, liveActionEndSec = null, endingBoundary: endingBoundaryMeta = null }) {
  if (!isDirectorSpine(spine)) throw new StoryError('INPUT_MISSING', 'repairTechnical requires a director-owned spine.');
  const scope = spine.storyScope;
  const resolvedPacing = spine.directorMeta?.pacingMode || engine.config?.pacingMode || 'commentary_led';
  const { reel, evidence, liveActionEndSec: maxLive } = await prepareReel(engine, scope, model, { liveActionEndSec, endingBoundary: endingBoundaryMeta });
  const currentEdl = { ...spine, storyScope: undefined, scopeReel: undefined, directorMeta: undefined };
  const out = await runDirector(engine, {
    model, scope, reel, evidence, key: `v5-editorial-director-downstream-fix-${scriptId}`,
    extraInput: { currentEdl, violations }, repairText: repairInstruction('technical', { violations }), root, write, emit,
    liveActionEndSec: maxLive, endingBoundary: endingBoundaryMeta, pacingMode: resolvedPacing
  });
  return { spine: stampSpine(out.spine, scope, reel, { reelObservations: out.reelObservations, attempts: out.attempts, downstreamRepair: true, liveActionEndSec: round2(maxLive), pacingMode: resolvedPacing }), evidence, reel, report: out.report };
}

// ---------------------------------------------------------------- acceptance
const ACCEPTANCE_CONTRACT = 'director-edl-acceptance-v1';
const RENDER_DURATION_TOLERANCE_SEC = 1.0;
const ACCEPTANCE = Object.freeze({ ACCEPTED: 'ACCEPTED', REJECTED: 'REJECTED', NEEDS_EDITORIAL_REVIEW: 'NEEDS_EDITORIAL_REVIEW' });

const SPEECH_FAST_WPS = 3.5;
const SPEECH_NORMAL_WPS = 2.5;
const BOUNDARY_SLACK_SEC = 0.5;
function endingBoundary(beats, cues, scope = null, liveActionOverride = null) {
  const last = (beats || [])[(beats || []).length - 1];
  if (!last) return { checked: false };
  const cut = num(last.sourceEndSec);
  const liveActionEndSec = resolveLiveActionBoundary({ liveActionEndSec: liveActionOverride ?? last?.liveActionEndSec, scope, durationSec: Infinity });
  if (Number.isFinite(liveActionEndSec) && liveActionEndSec > 0 && (cut > liveActionEndSec + 0.02 || num(last.sourceStartSec) >= liveActionEndSec - 0.02)) {
    return { checked: true, complete: false, cutSec: cut, reason: 'ENDING_CUTS_INTO_OUTRO', liveActionEndSec: round2(liveActionEndSec), interruptedLine: 'Post-incident outro/recap graphics' };
  }
  if (!Array.isArray(cues) || !cues.length) return { checked: false };
  if (last.deliveryMode === 'narrated_story' || (last.audioMode && last.audioMode !== 'original_audio')) {
    return { checked: true, complete: true, cutSec: cut, narratedEnding: true };
  }
  const words = t => String(t || '').replace(/\[[^\]]*\]|>>/g, ' ').split(/\s+/).filter(w => /[a-z0-9]/i.test(w)).length;
  const firstSentenceWords = t => { const m = String(t || '').match(/^[^.?!]*[.?!]/); return m ? words(m[0]) : null; };
  const interrupted = cues.find(c => {
    const s = num(c.startSec), n = words(c.text);
    if (!(n > 0 && s < cut - 0.15 && s + n / SPEECH_FAST_WPS > cut + BOUNDARY_SLACK_SEC)) return false;
    const k = firstSentenceWords(c.text);
    return !(k && k < n && s + k / SPEECH_NORMAL_WPS <= cut + BOUNDARY_SLACK_SEC);
  });
  return interrupted
    ? { checked: true, complete: false, cutSec: cut, interruptedLine: String(interrupted.text).trim().slice(0, 160), lineStartSec: num(interrupted.startSec),
      earliestLineEndSec: round2(num(interrupted.startSec) + words(interrupted.text) / SPEECH_FAST_WPS) }
    : { checked: true, complete: true, cutSec: cut };
}

function editorialReadiness(critique, beats, cues, scope = null, liveActionEndSec = null) {
  const findings = [];
  const boundary = endingBoundary(beats, cues, scope, liveActionEndSec);
  if (boundary.checked && !boundary.complete) {
    if (boundary.reason === 'ENDING_CUTS_INTO_OUTRO') {
      findings.push({ code: 'ENDING_CUTS_INTO_OUTRO', message: `The final cut at ${boundary.cutSec}s cuts into post-incident outro/recap graphics. Must cut at or before ${boundary.liveActionEndSec || 'live-action boundary'}s.` });
    } else {
      findings.push({ code: 'ENDING_MID_UTTERANCE', message: `The final cut at ${boundary.cutSec}s interrupts a line that started at ${boundary.lineStartSec}s and cannot finish before ~${boundary.earliestLineEndSec}s ("${boundary.interruptedLine}").` });
    }
  }
  const c = critique || {};
  const oc = c.openingCuriosity || {};
  if (Number.isFinite(num(oc.strongerHookAtOutputSec)) && num(oc.strongerHookAtOutputSec) >= 0) {
    findings.push({ code: 'STRONGER_HOOK_BURIED', message: `The critic saw a stronger verified hook at output ${num(oc.strongerHookAtOutputSec)}s than the opening${oc.strongerHookEvidence ? ` (${String(oc.strongerHookEvidence).slice(0, 160)})` : ''}.` });
  }
  if (c.finalSeconds && c.finalSeconds.endsAtCompleteBoundary === false) {
    findings.push({ code: 'ENDING_INCOMPLETE', message: `The critic heard the ending cut before a line/action finished${c.finalSeconds.lastWordsHeard ? ` ("${String(c.finalSeconds.lastWordsHeard).slice(0, 120)}")` : ''}.` });
  }
  const lastBeat = (beats || [])[(beats || []).length - 1];
  const lastIsNarrated = Boolean(lastBeat && (lastBeat.deliveryMode === 'narrated_story' || (lastBeat.audioMode && lastBeat.audioMode !== 'original_audio')));
  const lastWords = String(c.finalSeconds?.lastWordsHeard || '').trim();
  const isViewerEngagementQuestion = /\b(do you think|what do you think|did (he|she|they) deserve|handled (this|her|him) fairly|deserve even worse|would you|who was in the wrong|justified)\b/i.test(lastWords);
  if (!lastIsNarrated && !isViewerEngagementQuestion && scope?.scopeEndTarget !== 'forward_cliffhanger' && /\?\s*["']?$/.test(lastWords) && /\b(how|why|what|for what|are you|who)\b/i.test(lastWords)) {
    findings.push({ code: 'PAYOFF_UNSATISFYING', message: `The final beat ends on an unanswered question ("${lastWords.slice(0, 120)}") without the authoritative rebuttal or consequence.` });
  }
  if (c.payoffFulfillsOpeningPromise === false && !findings.some(f => f.code === 'PAYOFF_UNSATISFYING')) {
    findings.push({ code: 'PAYOFF_UNSATISFYING', message: 'The critic judged that the ending does not pay off the promise made by the opening.' });
  }
  for (const it of c.issues || []) {
    if (it.severity !== 'minor') continue;
    const touchesEnd = (it.beatIds || []).includes(beats[beats.length - 1]?.beatId);
    const touchesStart = (it.beatIds || []).includes(beats[0]?.beatId);
    if (it.type === 'low_value_stretch' && touchesEnd && !findings.some(f => f.code === 'PAYOFF_UNSATISFYING')) findings.push({ code: 'PAYOFF_UNSATISFYING', message: `The final beat is a low-value stretch (${String(it.whyItFails || it.evidence || '').slice(0, 160)}).` });
    if ((it.type === 'low_value_stretch' || it.type === 'opening_lacks_curiosity' || it.type === 'hook_spends_payoff') && touchesStart) findings.push({ code: 'WEAK_OPENING', message: `The opening beat was flagged (${it.type}: ${String(it.whyItFails || it.evidence || '').slice(0, 160)}).` });
  }
  return { boundary, findings };
}

function presentationReadiness(critique) {
  const o = critique?.externalOverlays;
  if (!o || typeof o !== 'object') return { checked: false, findings: [] };
  const findings = [];
  if (o.promoGraphicVisible) findings.push({ code: 'PROMO_GRAPHIC_VISIBLE', message: `A subscribe/promo graphic from the source is visible${o.evidence ? ` (${String(o.evidence).slice(0, 160)})` : ''}.` });
  if (o.brandingVisible) findings.push({ code: 'SOURCE_BRANDING_VISIBLE', message: 'Source channel branding/watermark is visible in the output.' });
  if (o.burnedInSubtitlesVisible) findings.push({ code: 'SOURCE_SUBTITLES_VISIBLE', message: 'Subtitles burned into the source are visible (they will duplicate the app subtitles).' });
  return { checked: true, findings };
}

function acceptanceReport(spine, { config = {}, durationSec, scriptSegments = null, renderedDurationSec = null, critique = null, transcriptCues = null, liveActionEndSec = null, endingBoundary: endingBoundaryMeta = null } = {}) {
  const scope = spine?.storyScope || null;
  const reel = spine?.scopeReel || null;
  const beats = Array.isArray(spine?.beats) ? spine.beats : [];
  const targets = durationTargets(scope, config);
  const maxLiveSec = resolveLiveActionBoundary({ liveActionEndSec: liveActionEndSec ?? spine?.directorMeta?.liveActionEndSec, endingBoundary: endingBoundaryMeta, scope, durationSec });
  const violations = [];
  if (!scope || !reel) {
    violations.push({ code: 'ACCEPTANCE_INPUT_MISSING', message: 'The spine carries no storyScope/scopeReel; viewed-media grounding cannot be checked.' });
  }
  const validation = scope && reel ? validateDirectorEdl(spine, scope, {
    durationSec, targetDurationMinSec: targets.hardMinSec, targetDurationMaxSec: targets.hardMaxSec, reel,
    narrationEnabled: config.narration?.enabled !== false, preferredDurationSec: targets.targetDurationSec,
    targetBandMinSec: targets.targetBandMinSec, targetBandMaxSec: targets.targetBandMaxSec,
    requireDeliveryBlocks: spine?.deliveryBlocks !== undefined,
    cues: transcriptCues || [],
    liveActionEndSec: maxLiveSec,
    endingBoundary: endingBoundaryMeta,
    pacingMode: spine?.directorMeta?.pacingMode || config.pacingMode || 'commentary_led'
  }) : { valid: false, violations: [], metrics: { totalSec: round2(timelineSec(beats)), beatCount: beats.length } };
  violations.push(...validation.violations.map(v => ({ code: v.code, message: v.message, ...(v.beatId ? { beatId: v.beatId } : {}) })));

  // If boundary detector marked `uncertain: true`, require explicit manual/post-render visual verification instead of silent auto-PASS!
  const boundaryInfo = endingBoundaryMeta || scope?.endingBoundary || null;
  if (boundaryInfo?.uncertain) {
    violations.push({ code: 'SOURCE_BOUNDARY_UNCERTAIN', message: `Source ending boundary at ${boundaryInfo.liveActionEndSec}s has uncertain=true (${boundaryInfo.reason || 'unconfirmed visual cut'}); cannot auto-PASS without verified post-render frame gate.` });
  }

  let orderPreserved = null;
  if (Array.isArray(scriptSegments)) {
    try {
      assertEdlIntact(beats, scriptSegments.map(x => ({ beatId: x.beat_id ?? x.beatId, sourceStartSec: num(x.sourceStartSec), sourceEndSec: num(x.sourceEndSec) })), Number.isFinite(durationSec) ? durationSec : Infinity);
      orderPreserved = true;
    } catch (err) {
      orderPreserved = false;
      violations.push({ code: 'EDL_MUTATED', message: err.message });
    }
  }
  const expectedOutputSec = Array.isArray(scriptSegments)
    ? round2(scriptSegments.reduce((n, x) => n + Math.max(0, num(x.sourceEndSec) - num(x.sourceStartSec)) / (num(x.playbackSpeed) > 0 ? num(x.playbackSpeed) : 1), 0))
    : round2(timelineSec(beats));
  const rendered = Number.isFinite(num(renderedDurationSec)) && num(renderedDurationSec) > 0 ? round2(num(renderedDurationSec)) : null;
  const renderDeltaSec = rendered === null ? null : round2(rendered - expectedOutputSec);
  const renderViolations = [];
  if (renderDeltaSec !== null && Math.abs(renderDeltaSec) > RENDER_DURATION_TOLERANCE_SEC) {
    renderViolations.push({ code: 'RENDER_DURATION_MISMATCH', message: `Rendered draft is ${rendered}s but the EDL plays ${expectedOutputSec}s (delta ${renderDeltaSec}s > ${RENDER_DURATION_TOLERANCE_SEC}s): something padded or truncated the edit.` });
  }
  const total = round2(timelineSec(beats));
  const technical = {
    verdict: violations.length ? 'FAIL' : 'PASS',
    hardMinSec: targets.hardMinSec, hardMaxSec: targets.hardMaxSec,
    targetDurationSec: targets.targetDurationSec, targetBandMinSec: targets.targetBandMinSec, targetBandMaxSec: targets.targetBandMaxSec,
    liveActionEndSec: Number.isFinite(maxLiveSec) ? round2(maxLiveSec) : null,
    timelineSec: total, expectedOutputSec, renderedDurationSec: rendered, renderDeltaSec,
    insidePreferredBand: total >= targets.targetBandMinSec - 1e-6 && total <= targets.targetBandMaxSec + 1e-6,
    beatCount: beats.length, orderPreserved, renderViolations,
    timeline: beats.map(b => ({ beatId: b.beatId, sourceStartSec: num(b.sourceStartSec), sourceEndSec: num(b.sourceEndSec), durationSec: round2(beatLen(b)), narrativeRole: b.narrativeRole || null })),
    violations
  };
  const blocking = (critique?.issues || []).filter(x => x.severity === 'blocking').length;
  const continuityBroken = critique && (critique.scopeSurvived === false || critique.centralQuestionActiveThroughout === false || critique.endingIsConsequence === false || critique.finalFootageUsable === false);
  const editorial = !critique || critique.status === 'MEDIA_CRITIC_INVALID'
    ? { verdict: 'NOT_RUN', source: 'scope_media_critic' }
    : {
      verdict: critique.isCompliant && !continuityBroken && !blocking ? 'PASS' : 'FAIL',
      source: 'scope_media_critic',
      scopeSurvived: critique.scopeSurvived ?? null,
      centralQuestionActiveThroughout: critique.centralQuestionActiveThroughout ?? null,
      endingIsConsequence: critique.endingIsConsequence ?? null,
      finalFootageUsable: critique.finalFootageUsable ?? null,
      blockingIssues: blocking
    };
  const readiness = editorialReadiness(critique, beats, transcriptCues, scope, maxLiveSec);
  const presentation = presentationReadiness(critique);
  if (editorial.verdict === 'PASS' && readiness.findings.length) editorial.verdict = 'NEEDS_REVIEW';
  editorial.readiness = readiness;
  const status = technical.verdict === 'FAIL' ? ACCEPTANCE.REJECTED
    : renderViolations.length ? ACCEPTANCE.NEEDS_EDITORIAL_REVIEW
      : editorial.verdict === 'PASS' && !presentation.findings.length ? ACCEPTANCE.ACCEPTED : ACCEPTANCE.NEEDS_EDITORIAL_REVIEW;
  const qualityGate = {
    technicalGate: technical.verdict === 'PASS' && !renderViolations.length ? 'TECHNICAL_PASS' : 'REJECTED',
    editorialGate: editorial.verdict === 'PASS' && !presentation.findings.length ? 'EDITORIAL_PASS' : editorial.verdict === 'NOT_RUN' ? 'NOT_RUN' : 'NEEDS_REVIEW',
    finalGateStatus: status === ACCEPTANCE.ACCEPTED ? 'EDITORIAL_PASS' : status === ACCEPTANCE.REJECTED ? 'REJECTED' : 'NEEDS_REVIEW',
    publishReady: status === ACCEPTANCE.ACCEPTED
  };
  return { contract: ACCEPTANCE_CONTRACT, status, qualityGate, technical, editorial, presentation };
}

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
  DIRECTOR_CONTRACT, SCOPE_MEMBERSHIP, PACING_MODES, schemas, instruction, repairInstruction,
  resolveLiveActionBoundary, estimatedSpeechSpan, buildVisualOwnershipMap, summarizeNarratorPlan, compareNarratorPlans, punchlinePreservationViolations,
  validateDirectorEdl, modelContextForReel, stampSpine, isDirectorSpine, prepareReel,
  directEdl, repairEdl, repairTechnical, repairDeliveryTechnical, runDirector, assertEdlIntact, timelineSec, coveredByReel,
  durationTargets, durationDelta, technicalDurationAdjustment, technicalWindowPaddingAdjustment, onlyDurationViolations, storyPreservationViolations, DURATION_REPAIR_INSTRUCTION,
  DURATION_COMPRESSION_INSTRUCTION, UNDER_MIN_REPAIR_INSTRUCTION, extensionOpportunities, underMinStall, extensionOverlapViolations, beatBudget, compressionViolations, compressionReminder,
  acceptanceReport, ACCEPTANCE, ACCEPTANCE_CONTRACT, RENDER_DURATION_TOLERANCE_SEC, endingMaterialRanges, endingBoundary, editorialReadiness, presentationReadiness,
  deliveryBeats, openingViolations, OPENING_STRATEGIES, DELIVERY_ONLY_REPAIR_INSTRUCTION, DIRECTOR_MAX_OUTPUT_TOKENS, DIRECTOR_THINKING_BUDGET, DIRECTOR_GENERATION, MAX_DIRECTOR_TEXT_CHARS, diagnoseDirectorOutput, validateShape
};
