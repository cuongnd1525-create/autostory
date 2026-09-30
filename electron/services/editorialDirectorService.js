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

const DIRECTOR_CONTRACT = 'scope-media-director-v1';
const DIRECTOR_REEL_FPS = 4;          // proxy encode fps (Vertex samples at videoFps=2)
const MIN_BEAT_SEC = 1.0;             // renderer/playability floor, not an editorial rule
const REEL_COVERAGE_MIN = 0.9;        // share of a beat that must lie inside watched reel footage
const DUR_EPS = 0.25;
const DUP_EPS = 0.05;

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
  audioMode: choice('original_audio', 'voiceover_with_ambient', 'voiceover_only'),
  scopeMembership: choice(...SCOPE_MEMBERSHIP),
  observedInFootage: text,
  viewerStateBefore: text,
  viewerStateAfter: text,
  newInformation: text,
  whyNecessaryNow: text
}, {
  wantsNarration: boolean,
  narratorFunction: choice(...NARRATOR_FUNCTIONS, 'NONE'),
  narrationIntent: text,
  sourceEventId: text,
  viewerQuestion: text,
  whyNextFollows: text,
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
  openLoops: list(flexible({ id: text, question: text }), 12)
});

const directorEdl = {
  type: 'object', required: ['accessGranted', 'reelObservations', 'spine'], additionalProperties: false,
  properties: { accessGranted: boolean, reelObservations: text, spine: directorSpine }
};

const schemas = { directorEdl, directorBeat, directorSpine };

// ---------------------------------------------------------------- instruction
const instruction = `PASS 1B — MEDIA-GROUNDED EDITORIAL DIRECTOR. You own the exact EDL.
The attached video files are the ONLY footage you may cut from. They are the reel of the selected Story Scope. Each file is listed in SOURCE MEDIA with its absolute sourceStartSec/sourceEndSec, and the picture has the SOURCE clock burned in. Always output ABSOLUTE source seconds.
input.storyScope is the story you are telling. Do not tell a different one.

WATCH FIRST. Before choosing a range, look at what is actually on screen and what is actually said there. observedInFootage must describe what you SAW and HEARD in that exact range: who is visible, the physical action, the key words. Never pick a range because of a text summary. If the footage does not show it, the beat does not exist.

EVERY BEAT MUST BE BOTH NOVEL AND CAUSALLY COHERENT WITH THE SCOPE.
- For every beat, answer: why is it needed NOW (whyNecessaryNow), what changes for the viewer (viewerStateBefore -> viewerStateAfter, newInformation), and why the next beat follows (whyNextFollows).
- A different timestamp, speaker or line is not progress. "It is interesting" is not a reason.
- If removing a beat makes the story clearer with no causal loss, remove it.
- A continuous exchange in one place can be excellent when each exchange changes the conflict, exposes a contradiction, raises the stakes or moves toward the consequence. Do not cut away just to get visual variety.
- Large jumps in source time are fine when the viewer understands why they are now seeing the later moment (use a one-line narration bridge). An unexplained jump from one interesting moment to another is not fine.

ORIGINAL FOOTAGE TELLS THE STORY ("edited, not generated").
- Use original audio for confrontation, allegation, denial, contradiction, emotional reaction, commands, discovery and consequence.
- Use narration (voiceover_with_ambient) only to fill a real comprehension gap: who someone is, what the call was, a fact that lives outside the scope (input.storyScope.allowedSupportingContext with treatment narration_only, or outOfScopeBranches) compressed into one sentence, or a time bridge. The narration runs over in-scope footage that fits it. narrationIntent says exactly what the line must convey. Never replace strong original dialogue with narration.
- A narrated beat needs enough seconds for its sentence (input.narrationWordsPerSecond words per second when given, otherwise about 2.5).
- If input.narrationEnabled is false, every beat must use original_audio.

HOOK = A COMPACT MINI-ARC FROM INSIDE THE SCOPE.
- An optional cold open (chronologyMode 'teaser', scopeMembership 'hook') may borrow from later inside the scope: conflict -> escalation -> partial reveal -> cut before the resolution. It must not spend input.storyScope.mustWithhold.
- Then rewind (chronologyMode 'rewind') to the start of the causal spine. After the rewind the viewer must still have an open question. Replaying part of the hook later in its full context is allowed. An exact duplicate of a range is not.
- The FIRST beat must use a hook role (teaser_conflict, cold_open, cold_open_hook, hook or micro_payoff).

ENDING = A CONSEQUENCE OF THE CENTRAL CONFLICT.
- The final beat (scopeMembership 'ending') must come from input.storyScope.candidateEndingEvents or an ending_material window, and must match input.storyScope.scopeEndTarget. For a forward cliffhanger, name the specific consequence that is now likely and stop before it is shown (payoffTiming 'part_2', isForwardConsequence=true, expectedNextConsequence, whyCutHere). A new question from another branch is not an ending.

SCOPE MEMBERSHIP
- hook | core | supporting_context | bridge_picture | ending. bridge_picture = in-reel footage used as picture under a narration bridge. Beats outside the reel are impossible.

DURATION: the beats must sum to between input.targetDurationMinSec and input.targetDurationMaxSec seconds. Choose beat lengths editorially (a beat may be short or long), but every beat must be at least 1 second.
Set accessGranted=true only after actually watching the attached reel. reelObservations: 2-4 sentences on what the reel actually shows.`;

function repairInstruction(kind, payload) {
  if (kind === 'technical') {
    return `TECHNICAL REPAIR — your EDL failed deterministic validation. Return the COMPLETE EDL again. Change only what these violations require and keep every unaffected beat exactly as it was (same ranges, same order). Replacement footage must come from the attached reel and serve the same story function inside the same scope:
${payload.violations.map((v, i) => `${i + 1}. [${v.code}] ${v.message}`).join('\n')}`;
  }
  return `TARGETED EDITORIAL REPAIR — the RENDERED video of your EDL was watched by a media critic, who found the problems listed in input.criticFindings. Each has an output-time region and the beat ids it maps to (input.weakRegions).
- Return the COMPLETE repaired EDL.
- Fix the problems by changing ONLY the beats in the weak regions, plus an adjacent beat if the transition itself needs it. Preserve every other beat exactly (same ranges, same order, same audio mode).
- Stay inside input.storyScope. Replacement footage must come from the attached scope reel. Do not introduce a new branch of the incident to fill time.
- Keep the total duration inside input.targetDurationMinSec..input.targetDurationMaxSec.`;
}

// ---------------------------------------------------------------- pure checks
function beatLen(b) { return Math.max(0, num(b.sourceEndSec) - num(b.sourceStartSec)); }
function timelineSec(beats) { return (beats || []).reduce((n, b) => n + beatLen(b), 0); }

function coveredByReel(b, reelRanges) {
  const s = num(b.sourceStartSec), e = num(b.sourceEndSec);
  if (!(e > s)) return 0;
  const inside = reelRanges.reduce((n, r) => n + Math.max(0, Math.min(e, r.sourceEndSec) - Math.max(s, r.sourceStartSec)), 0);
  return inside / (e - s);
}

function validateDirectorEdl(spine, scope, { durationSec, targetDurationMinSec = 65, targetDurationMaxSec = 90, reel, narrationEnabled = true } = {}) {
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
    if (cov < REEL_COVERAGE_MIN) {
      add('OUTSIDE_SCOPE_REEL', `Beat '${id}' (${s}-${e}s) is not footage from the attached scope reel (${Math.round(cov * 100)}% inside). Only watched, in-scope footage may be cut.`, { beatId: id, coverage: round2(cov) });
    }
    if (!String(b.observedInFootage || '').trim()) add('BEAT_NOT_GROUNDED', `Beat '${id}' has no observedInFootage: say what is seen/heard in that range.`, { beatId: id });
    if (!String(b.whyNecessaryNow || '').trim()) add('BEAT_UNJUSTIFIED', `Beat '${id}' has no whyNecessaryNow.`, { beatId: id });
    if (!narrationEnabled && b.audioMode && b.audioMode !== 'original_audio') {
      add('NARRATION_DISABLED', `Beat '${id}' uses ${b.audioMode} but narration is disabled for this project; use original_audio.`, { beatId: id });
    }
  });

  // Exact duplicate guard: identical footage with identical audio treatment.
  for (let i = 0; i < beats.length; i++) {
    for (let j = i + 1; j < beats.length; j++) {
      const a = beats[i], c = beats[j];
      if (Math.abs(num(a.sourceStartSec) - num(c.sourceStartSec)) <= DUP_EPS && Math.abs(num(a.sourceEndSec) - num(c.sourceEndSec)) <= DUP_EPS && (a.audioMode || '') === (c.audioMode || '')) {
        add('EXACT_EDL_DUPLICATE', `Beat '${c.beatId}' repeats the exact footage and audio of '${a.beatId}' (${a.sourceStartSec}-${a.sourceEndSec}s).`, { firstBeatId: a.beatId, secondBeatId: c.beatId });
      }
    }
  }

  const total = timelineSec(beats);
  if (total < targetDurationMinSec - DUR_EPS) add('TOTAL_DURATION_UNDER_MIN', `The timeline is ${round2(total)}s; it must be at least ${targetDurationMinSec}s.`, { totalSec: round2(total) });
  if (total > targetDurationMaxSec + DUR_EPS) add('TOTAL_DURATION_OVER_MAX', `The timeline is ${round2(total)}s; it must be at most ${targetDurationMaxSec}s.`, { totalSec: round2(total) });

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

function validateShape(v) {
  if (!v || !v.spine || !Array.isArray(v.spine.beats) || !v.spine.beats.length) throw new StoryError('INVALID_RESPONSE', 'Editorial Director returned no beats.');
  if (v.accessGranted !== true) throw new StoryError('INVALID_RESPONSE', 'Editorial Director did not confirm watching the attached scope reel (accessGranted must be true).');
  return v;
}

// Schema/shape failures are repairable like any other violation: the invalid
// artifact is handed back to the director instead of aborting the run.
async function askDirector(engine, key, input, instr, evidence, opts) {
  try {
    return { result: await engine.ask(key, input, schemas.directorEdl, instr, evidence, validateShape, 'auto_story_edit', opts) };
  } catch (e) {
    if (e?.invalidArtifact === undefined && e?.kind !== 'INVALID_RESPONSE') throw e;
    return { result: e.invalidArtifact || null, schemaError: e.message };
  }
}

// Stamp the director contract onto a validated spine. The scope and reel ride
// along so render/critic/repair all see exactly what the director saw.
function stampSpine(spine, scope, reel, meta = {}) {
  return {
    ...spine,
    editorialContract: DIRECTOR_CONTRACT,
    storyScope: scope,
    scopeReel: reel,
    beats: spine.beats.map((b, i) => ({ ...b, beatIndex: i, castLock: DIRECTOR_CONTRACT })),
    directorMeta: meta
  };
}

function isDirectorSpine(spine) { return spine?.editorialContract === DIRECTOR_CONTRACT; }

// ---------------------------------------------------------------- Gemini stage
async function prepareReel(engine, scope) {
  const reel = Scope.planScopeReel(scope, { durationSec: engine.duration, paddingSec: engine.config?.scopeReelPaddingSec ?? Scope.DEFAULT_REEL_PADDING_SEC });
  if (!reel.ranges.length) throw new StoryError('STORY_SCOPE_INVALID', 'Story Scope has no reel windows.');
  const evidence = await engine.prepare(reel.ranges.map(r => ({ sourceStartSec: r.sourceStartSec, sourceEndSec: r.sourceEndSec })), 0, engine.config?.directorReelFps || DIRECTOR_REEL_FPS);
  return { reel, evidence };
}

// One director pass (initial or repair) followed by <=maxTechnicalRepairs technical
// repair passes. Returns { spine, report, evidence, reel, attempts }.
async function runDirector(engine, { model, scope, reel, evidence, key, extraInput = {}, repairText = null, root, write, emit = () => {}, maxTechnicalRepairs = 2 }) {
  const cfg = engine.config || {};
  const baseInput = {
    storyScope: scope,
    scopeReel: reel.ranges,
    sourceDurationSec: engine.duration,
    targetDurationMinSec: cfg.targetDurationMinSec || 65,
    targetDurationMaxSec: cfg.targetDurationMaxSec || 90,
    storyMode: cfg.storyMode || 'serialized_part',
    narrationEnabled: cfg.narration?.enabled !== false,
    narrationWordsPerSecond: cfg.narration?.measuredWordsPerSecond || null,
    modelContext: modelContextForReel(model, reel),
    ...extraInput
  };
  const valOpts = { durationSec: engine.duration, targetDurationMinSec: baseInput.targetDurationMinSec, targetDurationMaxSec: baseInput.targetDurationMaxSec, reel, narrationEnabled: baseInput.narrationEnabled };
  const attempts = [];
  let violations = null, current = extraInput.currentEdl || null;
  for (let attempt = 0; attempt <= maxTechnicalRepairs; attempt++) {
    const technical = attempt > 0;
    const input = technical ? { ...baseInput, currentEdl: current, violations } : baseInput;
    const instr = [instruction, repairText, technical ? repairInstruction('technical', { violations }) : null].filter(Boolean).join('\n\n');
    // Repairs are cacheable: their fingerprint already includes currentEdl + violations
    // (+ critic findings), so a resumed run reuses them instead of re-paying.
    const { result, schemaError } = await askDirector(engine, `${key}${technical ? `_fix${attempt}` : ''}`, input, instr, evidence, {});
    const spine = result?.spine || null;
    const report = schemaError
      ? { valid: false, violations: [{ code: 'SCHEMA_INVALID', message: `Response did not match the EDL contract: ${schemaError}` }], metrics: {} }
      : validateDirectorEdl(spine, scope, valOpts);
    attempts.push({ attempt, valid: report.valid, violations: report.violations, metrics: report.metrics });
    if (write && root) await write(path.join(root, `${key}${technical ? `-fix-${attempt}` : ''}.json`), { result, validation: report });
    if (report.valid) return { spine, report, reelObservations: result.reelObservations, attempts };
    emit('design', `[Director] EDL needs technical repair #${attempt + 1}: ${report.violations.map(v => v.code).join(', ')}`, 'WARNING');
    violations = report.violations; current = spine || current;
  }
  throw new StoryError('DIRECTOR_EDL_INVALID', `Editorial Director EDL failed validation after ${maxTechnicalRepairs} repair pass(es): ${violations.map(v => v.code).join(', ')}`, { violations, attempts, spine: current });
}

async function directEdl(engine, { model, scope, root = null, write = null, emit = () => {}, scriptId = 1 }) {
  if (!scope) throw new StoryError('INPUT_MISSING', 'Editorial Director requires a selected Story Scope.');
  const { reel, evidence } = await prepareReel(engine, scope);
  emit('design', `[Director] Watching scope reel: ${reel.ranges.length} window(s), ${reel.totalSec}s of source footage.`);
  const out = await runDirector(engine, { model, scope, reel, evidence, key: `v5-editorial-director-${scriptId}`, root, write, emit });
  const spine = stampSpine(out.spine, scope, reel, { reelObservations: out.reelObservations, attempts: out.attempts });
  return { spine, evidence, reel, report: out.report };
}

// Repair from the RENDERED MP4 critique. Receives scope + complete current EDL +
// weak regions + the SAME scope reel media (cached proxies, not the whole source).
async function repairEdl(engine, { model, spine, critique, weakRegions = [], root = null, write = null, emit = () => {}, pass = 1, scriptId = 1 }) {
  if (!isDirectorSpine(spine)) throw new StoryError('INPUT_MISSING', 'repairEdl requires a director-owned spine.');
  const scope = spine.storyScope;
  const { reel, evidence } = await prepareReel(engine, scope);
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
  const { reel, evidence } = await prepareReel(engine, scope);
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
  directEdl, repairEdl, repairTechnical, runDirector, assertEdlIntact, timelineSec, coveredByReel
};
