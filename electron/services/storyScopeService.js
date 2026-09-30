// AutoStory — STORY SCOPE stage (first-class, runs BEFORE any exact EDL exists).
//
// A Story Scope declares WHICH mini-story a short-form edit tells: one central
// conflict, one active viewer question, a causal spine of source events, the
// explicit source-time boundary, the branches that are deliberately left out,
// and the candidate endings that are consequences of the central conflict.
//
// Ownership split (do not blur it):
//   - Gemini CHOOSES the scope (story judgment) from the canonical Source Story Model.
//   - This module only VALIDATES the structure of what Gemini declared (bounds,
//     internal consistency, footage/cost budget) and turns the scope into a
//     compact media reel plan with a manifest back to absolute source time.
//   - No story-quality ranking happens here. There are no genre, character,
//     location or timestamp rules.
//
// The scope is a STORY CONSTRAINT, not an EDL: the media-grounded Editorial
// Director still chooses exact footage inside it.

const { StoryError } = require('./autoStoryRepairRouter');

const SCOPE_CONTRACT_VERSION = 'story-scope-v1';
const DEFAULT_MAX_SCOPE_REEL_SEC = 360;   // cost budget for the director's media reel
const DEFAULT_REEL_PADDING_SEC = 2;       // context around each declared window
const TIME_EPS = 0.5;

const num = v => (Number.isFinite(Number(v)) ? Number(v) : NaN);
const round2 = n => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- schema
const object = properties => ({ type: 'object', required: Object.keys(properties), properties, additionalProperties: false });
const flexible = (required, optional = {}) => ({ type: 'object', required: Object.keys(required), properties: { ...required, ...optional }, additionalProperties: true });
const text = { type: 'string' };
const number = { type: 'number' };
const boolean = { type: 'boolean' };
const list = (items, maxItems = 20) => ({ type: 'array', items, maxItems });
const choice = (...values) => ({ type: 'string', enum: values });

const END_TARGETS = ['payoff', 'partial_payoff', 'forward_cliffhanger'];
const WINDOW_PURPOSES = ['core', 'hook_material', 'ending_material', 'supporting_context'];

const spineNode = flexible({ eventId: text, sourceStartSec: number, sourceEndSec: number }, { role: text, whyInScope: text });
const scopeWindow = flexible({ startSec: number, endSec: number, purpose: choice(...WINDOW_PURPOSES) }, { why: text });
const supportingContext = flexible({ description: text, sourceStartSec: number, sourceEndSec: number, treatment: choice('narration_only', 'footage') });
const branch = flexible({ description: text, sourceStartSec: number, sourceEndSec: number }, { whyExcluded: text });
const ending = flexible({ sourceStartSec: number, sourceEndSec: number, endingType: choice(...END_TARGETS) }, { eventId: text, whyItIsAConsequence: text });

const storyScope = flexible({
  storyScopeId: text,
  centralConflict: text,
  centralViewerQuestion: text,
  scopeStartState: text,
  scopeEndTarget: choice(...END_TARGETS),
  whyThisIsOneStory: text,
  primaryEntities: list(text, 8),
  causalSpine: list(spineNode, 16),
  scopeWindows: list(scopeWindow, 8),
  mustResolve: list(text, 8),
  mustWithhold: list(text, 8),
  allowedSupportingContext: list(supportingContext, 8),
  explicitScopeBoundary: flexible({ startSec: number, endSec: number }, { rationale: text }),
  outOfScopeBranches: list(branch, 12),
  targetDurationSec: number,
  candidateEndingEvents: list(ending, 6),
  footageAvailability: text
});

const storyScopeSelection = flexible({
  accessGranted: boolean,
  candidates: list(storyScope, 4),
  chosenStoryScopeId: text
}, { selectionRationale: text });

const schemas = { storyScope, storyScopeSelection };

// ---------------------------------------------------------------- instruction
const instruction = `PASS 1A — STORY SCOPE SELECTION (runs BEFORE any exact EDL).
You are the senior story editor of a short-form true-crime / bodycam channel. You are NOT cutting footage yet.
Your job: decide WHICH ONE mini-story this short video tells. The input is the canonical Source Story Model of the whole source (events, quotes, people, absolute source seconds).

WHAT A STORY SCOPE IS
- ONE central conflict and ONE viewer question that stays open across the whole edit.
- A CAUSAL SPINE: the ordered source events that belong to that conflict. Each one must be needed to understand or escalate it, or to deliver its consequence.
- An EXPLICIT BOUNDARY in source time. Everything outside it is out of scope, even if it is dramatic.
- The ending is a consequence of the central conflict: a payoff, a partial payoff, or a forward cliffhanger that names a specific consequence without showing it.

PRINCIPLES
1. A beat must be both NOVEL and CAUSALLY COHERENT with the active scope. A different timestamp, a different speaker, a new quote or a new fact is NOT progress by itself. Something interesting that belongs to another branch of the incident is the WRONG material for this story.
2. Prefer one continuous causal episode over a tour of the whole source. Later re-tellings, interviews and procedure that only re-describe the same conflict from another angle are usually out of scope. List them in outOfScopeBranches with the reason.
3. When the story needs a fact that lives outside the boundary (background, who someone is, a claim made later), put it in allowedSupportingContext with treatment='narration_only'. It will be delivered as one narrated sentence over in-scope footage, not by cutting to it. Use treatment='footage' only when the picture itself is causally necessary.
4. The requested duration (input.targetDurationMinSec..input.targetDurationMaxSec) must be supportable by in-scope footage. scopeWindows are the source windows the editor will be shown and may cut from. They must hold enough usable footage for the duration, but must stay compact: their total length must not exceed input.maxScopeReelSec.
5. The hook may borrow from later inside the SAME scope (hook_material window), but the scope must keep something to withhold (mustWithhold).
6. candidateEndingEvents must lie inside the scope windows and must be consequences of the central conflict, not a new question from another branch.

OUTPUT
- Propose 2-4 candidate scopes (different mini-stories the source could support). For each, fill every field with absolute source seconds.
- Choose ONE (chosenStoryScopeId) and explain why in selectionRationale. Judge by: clear conflict, causal completeness, footage and dialogue strength, physical/event progression, support for the requested duration, a strong in-scope ending, and minimal dependency on unrelated branches.
- scopeWindows purposes: core | hook_material | ending_material | supporting_context. supporting_context windows are only for allowedSupportingContext items with treatment='footage'.
- explicitScopeBoundary.startSec/endSec must contain every core, hook_material and ending_material window.
- Never invent events. Reference real event ids and real source seconds from the model. Set accessGranted=true after reading the model.`;

const repairInstruction = violations => `REPAIR — the previous Story Scope failed structural validation. Keep the same story if it is sound. Fix ONLY what these violations require and return the COMPLETE selection again:
${violations.map((v, i) => `${i + 1}. [${v.code}] ${v.message}`).join('\n')}`;

// ---------------------------------------------------------------- pure helpers
function mergeRanges(ranges) {
  const sorted = ranges
    .filter(r => Number.isFinite(r.startSec) && Number.isFinite(r.endSec) && r.endSec > r.startSec)
    .map(r => ({ ...r, purposes: [...(r.purposes || (r.purpose ? [r.purpose] : []))] }))
    .sort((a, b) => a.startSec - b.startSec);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startSec <= last.endSec + 0.01) {
      last.endSec = Math.max(last.endSec, r.endSec);
      for (const p of r.purposes) if (!last.purposes.includes(p)) last.purposes.push(p);
    } else out.push({ startSec: r.startSec, endSec: r.endSec, purposes: r.purposes });
  }
  return out;
}
const totalSec = ranges => ranges.reduce((n, r) => n + (r.endSec - r.startSec), 0);
const overlaps = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

function chosenScope(selection) {
  const candidates = Array.isArray(selection?.candidates) ? selection.candidates : [];
  return candidates.find(c => c && c.storyScopeId === selection.chosenStoryScopeId) || null;
}

// Media reel plan for the Editorial Director: the scope windows (+ padding),
// merged, clamped to the source, with a manifest back to absolute time.
function planScopeReel(scope, { durationSec, paddingSec = DEFAULT_REEL_PADDING_SEC } = {}) {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Infinity;
  const windows = (scope?.scopeWindows || []).map(w => ({
    startSec: Math.max(0, num(w.startSec) - paddingSec),
    endSec: Math.min(dur, num(w.endSec) + paddingSec),
    purpose: w.purpose
  }));
  const ranges = mergeRanges(windows).map((r, i) => ({
    reelId: `reel_${String(i + 1).padStart(2, '0')}`,
    sourceStartSec: round2(r.startSec), sourceEndSec: round2(r.endSec), purposes: r.purposes
  }));
  return {
    contract: SCOPE_CONTRACT_VERSION,
    storyScopeId: scope?.storyScopeId || null,
    paddingSec,
    ranges,
    totalSec: round2(ranges.reduce((n, r) => n + (r.sourceEndSec - r.sourceStartSec), 0))
  };
}

// Deterministic STRUCTURAL validation of a Gemini-declared scope. It checks that
// the declaration is internally consistent, lies inside the source, can support the
// requested duration, and fits the reel cost budget. It does not judge story quality.
function validateStoryScope(scope, { durationSec, targetDurationMinSec = 65, maxScopeReelSec = DEFAULT_MAX_SCOPE_REEL_SEC, paddingSec = DEFAULT_REEL_PADDING_SEC } = {}) {
  const violations = [];
  const add = (code, message, extra = {}) => violations.push({ code, message, ...extra });
  if (!scope || typeof scope !== 'object') {
    add('SCOPE_MISSING', 'No chosen story scope (chosenStoryScopeId must match one candidate).');
    return { valid: false, violations, reel: null };
  }
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Infinity;
  const inSource = (s, e) => Number.isFinite(s) && Number.isFinite(e) && s >= -TIME_EPS && e <= dur + TIME_EPS && e > s;

  for (const f of ['storyScopeId', 'centralConflict', 'centralViewerQuestion', 'whyThisIsOneStory']) {
    if (!String(scope[f] || '').trim()) add('SCOPE_FIELD_EMPTY', `storyScope.${f} must be a non-empty string.`, { field: f });
  }
  if (!END_TARGETS.includes(scope.scopeEndTarget)) add('SCOPE_FIELD_EMPTY', `scopeEndTarget must be one of ${END_TARGETS.join('|')}.`, { field: 'scopeEndTarget' });

  const b = scope.explicitScopeBoundary || {};
  const b0 = num(b.startSec), b1 = num(b.endSec);
  if (!inSource(b0, b1)) add('SCOPE_BOUNDARY_INVALID', `explicitScopeBoundary ${b.startSec}-${b.endSec}s must be a valid range inside the source (0-${round2(dur)}s).`);

  const windows = Array.isArray(scope.scopeWindows) ? scope.scopeWindows : [];
  if (!windows.length) add('SCOPE_WINDOWS_EMPTY', 'scopeWindows must list the in-scope source windows the editor will watch.');
  const supportingFootage = (scope.allowedSupportingContext || []).filter(c => c && c.treatment === 'footage');
  windows.forEach((w, i) => {
    const s = num(w.startSec), e = num(w.endSec);
    if (!inSource(s, e)) { add('SCOPE_WINDOW_INVALID', `scopeWindows[${i}] ${w.startSec}-${w.endSec}s is not a valid source range.`, { index: i }); return; }
    if (!WINDOW_PURPOSES.includes(w.purpose)) add('SCOPE_WINDOW_INVALID', `scopeWindows[${i}].purpose must be one of ${WINDOW_PURPOSES.join('|')}.`, { index: i });
    if (w.purpose === 'supporting_context') {
      const declared = supportingFootage.some(c => overlaps(s, e, num(c.sourceStartSec), num(c.sourceEndSec)) > 0);
      if (!declared) add('SCOPE_SUPPORT_UNDECLARED', `scopeWindows[${i}] is supporting_context but no allowedSupportingContext item with treatment='footage' covers ${s}-${e}s.`, { index: i });
    } else if (Number.isFinite(b0) && Number.isFinite(b1) && (s < b0 - TIME_EPS || e > b1 + TIME_EPS)) {
      add('SCOPE_WINDOW_OUTSIDE_BOUNDARY', `scopeWindows[${i}] (${w.purpose}) ${s}-${e}s lies outside explicitScopeBoundary ${b0}-${b1}s.`, { index: i });
    }
  });

  const spine = Array.isArray(scope.causalSpine) ? scope.causalSpine : [];
  if (spine.length < 2) add('SCOPE_SPINE_TOO_SHORT', 'causalSpine must list at least two ordered source events of the central conflict.');
  spine.forEach((n, i) => {
    const s = num(n.sourceStartSec), e = num(n.sourceEndSec);
    if (!inSource(s, e)) add('SCOPE_SPINE_INVALID', `causalSpine[${i}] ${n.sourceStartSec}-${n.sourceEndSec}s is not a valid source range.`, { index: i });
    else if (!windows.some(w => overlaps(s, e, num(w.startSec), num(w.endSec)) > 0)) {
      add('SCOPE_SPINE_NOT_WATCHABLE', `causalSpine[${i}] (${n.eventId}) ${s}-${e}s is not covered by any scopeWindow, so the editor could not see it.`, { index: i });
    }
  });

  const endings = Array.isArray(scope.candidateEndingEvents) ? scope.candidateEndingEvents : [];
  if (!endings.length) add('SCOPE_ENDING_MISSING', 'candidateEndingEvents must name at least one in-scope ending that is a consequence of the central conflict.');
  endings.forEach((en, i) => {
    const s = num(en.sourceStartSec), e = num(en.sourceEndSec);
    if (!inSource(s, e)) add('SCOPE_ENDING_INVALID', `candidateEndingEvents[${i}] ${en.sourceStartSec}-${en.sourceEndSec}s is not a valid source range.`, { index: i });
    else if (!windows.some(w => w.purpose !== 'supporting_context' && overlaps(s, e, num(w.startSec), num(w.endSec)) > 0)) {
      add('SCOPE_ENDING_OUTSIDE_SCOPE', `candidateEndingEvents[${i}] ${s}-${e}s is not inside an in-scope window.`, { index: i });
    }
  });

  const reel = planScopeReel(scope, { durationSec, paddingSec });
  const watchable = totalSec(mergeRanges(windows.map(w => ({ startSec: num(w.startSec), endSec: num(w.endSec) }))));
  if (windows.length && watchable < targetDurationMinSec) {
    add('SCOPE_FOOTAGE_INSUFFICIENT', `In-scope windows hold only ${round2(watchable)}s of footage; the requested minimum duration is ${targetDurationMinSec}s. Widen the windows inside the same conflict (or choose a scope whose conflict has enough footage).`);
  }
  if (reel.totalSec > maxScopeReelSec + TIME_EPS) {
    add('SCOPE_REEL_OVER_BUDGET', `The scope media reel would be ${reel.totalSec}s (windows + ${paddingSec}s padding); the budget is ${maxScopeReelSec}s. Tighten the windows to the causal spine of ONE conflict.`);
  }
  return { valid: violations.length === 0, violations, reel };
}

function validateSelectionShape(v) {
  if (!v || !Array.isArray(v.candidates) || !v.candidates.length) throw new StoryError('INVALID_RESPONSE', 'Story Scope selection returned no candidates.');
  if (!chosenScope(v)) throw new StoryError('INVALID_RESPONSE', 'chosenStoryScopeId does not match any candidate.');
  return v;
}

// Compact, text-only view of the model for scope selection.
function modelForScope(model) {
  return {
    durationSec: model.durationSec,
    people: model.people || [],
    events: (model.events || []).map(e => ({ id: e.id, startSec: e.startSec, endSec: e.endSec, type: e.type, summary: e.summary, location: e.location, peopleIds: e.peopleIds, tension: e.tension, isReveal: e.isReveal })),
    quotes: (model.quotes || []).map(q => ({ id: q.id, eventId: q.eventId, speaker: q.speaker, startSec: q.startSec, endSec: q.endSec, text: q.text, epistemic: q.epistemic }))
  };
}

// ---------------------------------------------------------------- Gemini stage
// Returns { scope, selection, reel, attempts } or throws StoryError('STORY_SCOPE_INVALID').
async function selectStoryScope(engine, model, { root = null, write = null, emit = () => {}, maxRepairs = 2 } = {}) {
  if (!model || !Array.isArray(model.events) || !model.events.length) {
    throw new StoryError('INPUT_MISSING', 'Story Scope requires a Source Story Model with events.');
  }
  const cfg = engine.config || {};
  const opts = {
    durationSec: engine.duration || model.durationSec,
    targetDurationMinSec: cfg.targetDurationMinSec || 65,
    maxScopeReelSec: cfg.maxScopeReelSec || DEFAULT_MAX_SCOPE_REEL_SEC,
    paddingSec: cfg.scopeReelPaddingSec ?? DEFAULT_REEL_PADDING_SEC
  };
  const input = {
    model: modelForScope(model),
    targetDurationMinSec: cfg.targetDurationMinSec || 65,
    targetDurationMaxSec: cfg.targetDurationMaxSec || 90,
    maxScopeReelSec: opts.maxScopeReelSec,
    storyMode: cfg.storyMode || 'serialized_part'
  };
  const attempts = [];
  let violations = null, previous = null;
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const repair = attempt > 0;
    let selection = null, schemaError = null;
    try {
      selection = await engine.ask(
        `v5-story-scope${repair ? `_repair${attempt}` : ''}`,
        repair ? { ...input, previousSelection: previous, violations } : input,
        schemas.storyScopeSelection,
        repair ? `${instruction}\n\n${repairInstruction(violations)}` : instruction,
        [],
        validateSelectionShape,
        'auto_story_edit',
        {}
      );
    } catch (e) {
      if (e?.invalidArtifact === undefined && e?.kind !== 'INVALID_RESPONSE') throw e;
      selection = e.invalidArtifact || null; schemaError = e.message;
    }
    const scope = schemaError ? null : chosenScope(selection);
    const report = schemaError
      ? { valid: false, violations: [{ code: 'SCHEMA_INVALID', message: `Response did not match the Story Scope contract: ${schemaError}` }], reel: null }
      : validateStoryScope(scope, opts);
    attempts.push({ attempt, chosenStoryScopeId: selection?.chosenStoryScopeId || null, valid: report.valid, violations: report.violations });
    if (write && root) {
      await write(require('path').join(root, `story-scope-selection${repair ? `-repair-${attempt}` : ''}.json`), { selection, validation: report });
    }
    if (report.valid) {
      const finalScope = { ...scope, contract: SCOPE_CONTRACT_VERSION, targetDurationMinSec: input.targetDurationMinSec, targetDurationMaxSec: input.targetDurationMaxSec };
      emit('design', `[Scope] Story Scope selected: ${finalScope.storyScopeId} — ${finalScope.centralViewerQuestion}`);
      return { scope: finalScope, selection, reel: report.reel, attempts };
    }
    emit('design', `[Scope] Story Scope needs repair #${attempt + 1}: ${report.violations.map(v => v.code).join(', ')}`, 'WARNING');
    violations = report.violations; previous = selection || previous;
  }
  throw new StoryError('STORY_SCOPE_INVALID', `Story Scope failed structural validation after ${maxRepairs} repair pass(es): ${violations.map(v => v.code).join(', ')}`, { violations, attempts });
}

// Additional in-scope candidates (validated) for outputCount > 1.
function alternateScopes(selection, chosenId, opts) {
  return (selection?.candidates || [])
    .filter(c => c && c.storyScopeId !== chosenId)
    .filter(c => validateStoryScope(c, opts).valid);
}

module.exports = {
  SCOPE_CONTRACT_VERSION, DEFAULT_MAX_SCOPE_REEL_SEC, DEFAULT_REEL_PADDING_SEC,
  schemas, instruction, selectStoryScope, validateStoryScope, planScopeReel, mergeRanges,
  chosenScope, alternateScopes, modelForScope
};
