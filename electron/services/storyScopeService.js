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
const Packer = require('./scopeReelPacker');

const SCOPE_CONTRACT_VERSION = 'story-scope-v1';
const DEFAULT_MAX_SCOPE_REEL_SEC = 360;   // cost budget for the director's media reel
const DEFAULT_REEL_PADDING_SEC = 2;       // context around each declared window
const TIME_EPS = 0.5;
const SCOPE_MAX_OUTPUT_TOKENS = 16384;
const SCOPE_THINKING_BUDGET = 0;
const SCOPE_GENERATION = Object.freeze({ maxOutputTokens: SCOPE_MAX_OUTPUT_TOKENS, thinkingBudget: SCOPE_THINKING_BUDGET });
const MAX_SCOPE_TEXT_CHARS = 1500;

// ONE source of truth for every Story Scope count limit. The same object renders
// into the Gemini instruction, drives the deterministic validator (with explicit
// "contains N; maximum M" messages) and the repair prompt. Array sizes are NOT
// enforced by the JSON schema: the provider transport strips maxItems, so a
// schema-level check could only ever produce an opaque "array size outside
// contract" error that Gemini cannot act on.
//
// scopeWindows are LOGICAL, EDITORIAL candidate regions and have no count cap.
// They are NOT transport units: the provider's videos-per-prompt limit applies only
// to the packed reel FILES (scopeReelPacker), and media cost is bounded by the
// reel-duration budget (maxScopeReelSec), measured after media packing/compaction.
// Windows are UNIQUE source ranges: a range that is both core and hook/ending
// material is one window with several purposes, never two.
const SCOPE_LIMITS = Object.freeze({
  candidates: { min: 1, max: 4 },
  scopeWindows: { min: 1, max: Infinity },
  causalSpine: { min: 2, max: 16 },
  candidateEndingEvents: { min: 1, max: 6 },
  hookCandidates: { min: 0, max: 4 },
  primaryEntities: { min: 0, max: 8 },
  mustResolve: { min: 0, max: 8 },
  mustWithhold: { min: 0, max: 8 },
  allowedSupportingContext: { min: 0, max: 8 },
  outOfScopeBranches: { min: 0, max: 12 }
});
const PURPOSE_PRIORITY = ['core', 'hook_material', 'ending_material', 'supporting_context'];

const num = v => (Number.isFinite(Number(v)) ? Number(v) : NaN);
const round2 = n => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- schema
const object = properties => ({ type: 'object', required: Object.keys(properties), properties, additionalProperties: false });
const flexible = (required, optional = {}) => ({ type: 'object', required: Object.keys(required), properties: { ...required, ...optional }, additionalProperties: true });
const text = { type: 'string' };
const number = { type: 'number' };
const boolean = { type: 'boolean' };
// Unbounded at the schema level on purpose — see SCOPE_LIMITS.
const list = items => ({ type: 'array', items });
const choice = (...values) => ({ type: 'string', enum: values });

const END_TARGETS = ['payoff', 'partial_payoff', 'forward_cliffhanger'];
const WINDOW_PURPOSES = ['core', 'hook_material', 'ending_material', 'supporting_context'];

const spineNode = flexible({ eventId: text, sourceStartSec: number, sourceEndSec: number }, { role: text, whyInScope: text });
const scopeWindow = flexible({ startSec: number, endSec: number }, { windowId: text, purposes: { type: 'array', items: choice(...WINDOW_PURPOSES) }, purpose: choice(...WINDOW_PURPOSES), why: text });
const hookCandidate = flexible({ windowId: text, sourceStartSec: number, sourceEndSec: number }, { hookType: text, curiosityQuestion: text, why: text });
const commentaryOpportunity = flexible({ sourceStartSec: number, sourceEndSec: number }, { editorialAngle: text, whyNarratorNeeded: text });
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
  primaryEntities: list(text),
  causalSpine: list(spineNode),
  scopeWindows: list(scopeWindow),
  mustResolve: list(text),
  mustWithhold: list(text),
  allowedSupportingContext: list(supportingContext),
  explicitScopeBoundary: flexible({ startSec: number, endSec: number }, { rationale: text }),
  outOfScopeBranches: list(branch),
  targetDurationSec: number,
  candidateEndingEvents: list(ending),
  footageAvailability: text
}, { hookCandidates: list(hookCandidate), commentaryOpportunities: list(commentaryOpportunity) });

const storyScopeSelection = flexible({
  accessGranted: boolean,
  candidates: list(storyScope),
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
2. CAPTURE THE FULL CAUSAL ARC OF ONE CONFLICT (ACTION + VERBAL/LEGAL RECKONING): Prefer one coherent conflict arc over a tour of unrelated branches. However, do NOT artificially split one conflict into a "street action/detention scope" and a separate "post-detention justification/supervisor verdict scope" when the later exchange directly answers the central viewer question, exposes the subject's sharpest self-justification or contradiction quote (high editorialValue), or delivers an authoritative verbal shutdown / legal charge outcome. Include those high-value later moments as separate logical scopeWindows (with purposes hook_material, core, or ending_material) inside the SAME Story Scope and widen explicitScopeBoundary.endSec to cover them, while leaving routine procedural transport/waiting gaps out of scopeWindows so the packed reel stays compact. Only place genuinely unrelated branches (a different subject, an unrelated dispute, or repetitive low-value small talk that adds no thesis contradiction or payoff) into outOfScopeBranches.
3. When the story needs a brief fact that lives outside the scope windows (background, who someone is, a final court/charge disposition), put it in allowedSupportingContext with treatment='narration_only'. It will be delivered as one narrated sentence over in-scope footage, not by cutting to it. Use treatment='footage' only when the picture itself is causally necessary.
4. The requested duration (input.targetDurationMinSec..input.targetDurationMaxSec) must be supportable by in-scope footage. scopeWindows are the logical source regions the editor may cut from; list as many as the conflict needs. They must hold enough usable footage for the duration. The system packs them into a media reel for the editor and compacts broad windows around the model's events and quotes, but the packed reel must fit input.maxScopeReelSec, so keep the windows to the causal spine of ONE conflict.
5. AUDITION HOOK CANDIDATES ACROSS THE FULL SCOPE (hookCandidates): List 2-4 distinct hookCandidates (windowId + exact sub-range + hookType + curiosityQuestion) explicitly supporting an IN-MEDIAS-RES CLIMAX / PEAK-ESCALATION FLASHPOINT HOOK, and specifically a 2-PART SMASH-CUT COLD OPEN when the conflict features a verbal ultimatum/dare leading to a physical or legal climax:
   - Part 1 ('defiant_dare_trigger' / 'ultimatum_trigger', ~2.0-3.5s): the exact tight sub-range of the sharpest verbal ultimatum, defiant dare, or bold contradiction right before the climax (trimmed tightly to the punchline itself, skipping any slow procedural preamble or pauses).
   - Part 2 ('kinetic_climax_flashpoint', ~2.5-4.5s): the exact sub-range of the explosive physical climax, tactical breach, takedown, struggle, or decisive arrest shock that answers that dare, cut right at the peak impact before the aftermath settles.
   - You may also list an opening behavioral-friction hook candidate from the initial encounter for comparison, and MUST include early establishing/approach footage inside the first core scopeWindow so the Editorial Director has B-roll picture available for the post-hook narrator case-file rewind intro.
   - STRICT mustWithhold RULE: mustWithhold is ONLY for the final post-climax legal disposition, sentencing, or station twist at the very end of the story. NEVER put the physical climax, breach, takedown, or arrest flashpoint into mustWithhold! Ensure the scopeWindow containing the climax includes 'hook_material' in its purposes array (['core', 'hook_material']).
6. candidateEndingEvents must lie inside the scope windows and must deliver a genuine consequence or authoritative verbal/legal shutdown of the central conflict (never an unanswered question or a mid-argument pause). When a later supervisor rebuttal, charge explanation, or legal outcome resolves the central conflict more decisively than the moment handcuffs click, include its window as ending_material and list it in candidateEndingEvents. Extend the ending_material window through the physical conclusion of the live encounter (such as the suspect's final reaction and the transport door closing/latching up to input.liveActionEndSec), giving the editor clean physical action footage to conclude the scene. CRITICAL: When input.liveActionEndSec < input.model.durationSec (meaning post-incident outro/recap graphics, split-screen end cards, sentencing cards, or channel promos begin after input.liveActionEndSec), NEVER place or extend any scopeWindow, causalSpine node, hookCandidate, or candidateEndingEvent past input.liveActionEndSec. If a post-incident disposition fact from the outro is helpful, list it ONLY in allowedSupportingContext with treatment='narration_only'.
7. IDENTIFY NARRATOR-LED COMMENTARY & SCENE-TRANSITION BRIDGE OPPORTUNITIES (commentaryOpportunities): List 3-6 source moments inside the scope where a true-crime narrator acts as a connective bridge between scenes rather than describing visible screen action: (a) a POST-HOOK CASE-FILE REWIND INTRO right after the cold open that rewinds to introduce when, where, and how the incident began before handing off to the first raw exchange, (b) SCENE-TRANSITION BRIDGES across omitted time or location shifts (e.g., compressing minutes of roadside refusal into the arrival of a supervisor/tactical breach, or bridging from the roadside arrest into the police station booking room), (c) building anticipation for an upcoming high-value quote without spoiling its punchline, (d) delivering a mid-story REHOOK / interpretation when the encounter shifts from physical action to legal consequence, and (e) synthesizing the central contradiction at the close.

OUTPUT
- Propose 1-2 candidate scopes (prefer 1 strong candidate scope when the primary conflict arc is clear; at most 2 unless multiple distinct stories are needed). For each, fill every field with absolute source seconds.
- Choose ONE (chosenStoryScopeId) and explain why in selectionRationale. Judge by: clear conflict, full-arc causal completeness (inciting premise -> contradiction -> confrontation/detention -> verbal/legal reckoning), quote and footage strength, commentary richness, support for the requested duration, a decisive in-scope payoff, and minimal dependency on unrelated branches.
- scopeWindows are UNIQUE, NON-OVERLAPPING source ranges, each listed ONCE with a windowId and a purposes array (core | hook_material | ending_material | supporting_context). If one range is both core and hook or ending material, it is ONE window with purposes ['core','hook_material'] — never repeat a range for a second role. Reference hook material in hookCandidates (windowId + exact sub-range) and endings in candidateEndingEvents. supporting_context windows are only for allowedSupportingContext items with treatment='footage'.
- OUTPUT HYGIENE & ANTI-REPETITION (CRITICAL — PREVENTS MAX_TOKENS): Every identifier (storyScopeId, windowId, eventId) MUST be a short ASCII snake_case code <= 20 chars using simple sequential numbering (e.g., 'scope_01', 'w_01', 'w_02', 'w_03') — NEVER concatenate long descriptive words, camelCase phrases, or random digit sequences into an ID. Keep every text field (centralConflict, centralViewerQuestion, why, whyInScope, curiosityQuestion, whyNarratorNeeded, rationale, selectionRationale) to ONE concise sentence (<= 25 words). Never repeat characters, digits, or phrases.
- COUNT LIMITS (hard; "candidates" is per selection, all others per candidate): ${limitsText()}.
- explicitScopeBoundary.startSec/endSec must contain every core, hook_material and ending_material window, and must NOT exceed input.liveActionEndSec when provided.
- Never invent events. Reference real event ids and real source seconds from the model. Set accessGranted=true after reading the model.`;

function limitsText() {
  return Object.entries(SCOPE_LIMITS).map(([k, l]) => (Number.isFinite(l.max) ? `${k} ${l.min ? `${l.min}-` : '<= '}${l.max}` : `${k} >= ${l.min} (no count cap)`)).join('; ');
}
const repairInstruction = (violations, failing = null) => `REPAIR — your previous Story Scope selection (input.previousSelection) failed validation${failing ? ` in candidate '${failing}'` : ''}. Keep the same story if it is sound. Fix ONLY what these violations require and return the COMPLETE selection again. Returning the same object unchanged will fail again.
${violations.map((v, i) => `${i + 1}. [${v.code}] ${v.message}`).join('\n')}
Count limits (per candidate): ${limitsText()}. scopeWindows must be unique non-overlapping ranges (one window per range, several purposes allowed).`;

const COMPACT_SCOPE_RECOVERY_INSTRUCTION = `COMPACT ANTI-REPETITION RECOVERY: Your previous attempt hit MAX_TOKENS or truncated JSON due to overly verbose output or a token repetition loop. Return ONLY 1 candidate in candidates[] (the single strongest Story Scope). Use strictly short sequential IDs ('scope_01', 'w_01', 'w_02', 'w_03') <= 12 chars, and keep every string field to ONE short sentence (<= 18 words). Never repeat characters or digits.`;

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

const windowPurposes = w => [...new Set([...(Array.isArray(w?.purposes) ? w.purposes : []), ...(w?.purpose ? [w.purpose] : [])])];
const primaryPurpose = purposes => PURPOSE_PRIORITY.find(p => purposes.includes(p)) || null;

function resolveMaxLiveActionSec({ liveActionEndSec = null, endingBoundary = null, scope = null, model = null, durationSec = Infinity } = {}) {
  const dur = Number.isFinite(Number(durationSec)) && Number(durationSec) > 0 ? Number(durationSec) : Infinity;
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

// Lossless normalization of scopeWindows into UNIQUE source ranges.
function normalizeScopeWindows(windows = []) {
  const valid = [], notes = [];
  (Array.isArray(windows) ? windows : []).forEach((w, i) => {
    const s = num(w?.startSec), e = num(w?.endSec);
    if (!(Number.isFinite(s) && Number.isFinite(e) && e > s)) return;
    const id = String(w.windowId || `w${i + 1}`);
    const purposes = windowPurposes(w);
    valid.push({ id, s, e, purposes, why: w.why || '', index: i });
  });
  valid.sort((a, b) => a.s - b.s || a.e - b.e);
  const out = [];
  for (const w of valid) {
    const last = out[out.length - 1];
    const pr = w.purposes.map(p => ({ purpose: p, startSec: w.s, endSec: w.e, sourceWindowId: w.id }));
    if (last && overlaps(last.startSec, last.endSec, w.s, w.e) > 0.01) {
      last.endSec = Math.max(last.endSec, w.e);
      for (const p of w.purposes) if (!last.purposes.includes(p)) last.purposes.push(p);
      last.purposeRanges.push(...pr);
      last.mergedFrom.push(w.id);
      if (w.why && !last.why.includes(w.why)) last.why = last.why ? `${last.why} | ${w.why}` : w.why;
    } else {
      out.push({ windowId: w.id, startSec: w.s, endSec: w.e, purposes: [...w.purposes], purposeRanges: pr, mergedFrom: [w.id], why: w.why });
    }
  }
  const normalized = out.map(w => {
    if (w.mergedFrom.length > 1) notes.push({ merged: w.mergedFrom, into: w.windowId, startSec: w.startSec, endSec: w.endSec, purposes: w.purposes });
    return { windowId: w.windowId, startSec: w.startSec, endSec: w.endSec, purposes: w.purposes, purpose: primaryPurpose(w.purposes), purposeRanges: w.purposeRanges, why: w.why, ...(w.mergedFrom.length > 1 ? { mergedFrom: w.mergedFrom } : {}) };
  });
  return { windows: normalized, notes, declaredCount: Array.isArray(windows) ? windows.length : 0 };
}

function chosenScope(selection) {
  const candidates = Array.isArray(selection?.candidates) ? selection.candidates : [];
  return candidates.find(c => c && c.storyScopeId === selection.chosenStoryScopeId) || null;
}

// Media reel plan for the Editorial Director.
function planScopeReel(scope, { durationSec, paddingSec = DEFAULT_REEL_PADDING_SEC, maxScopeReelSec = DEFAULT_MAX_SCOPE_REEL_SEC, model = null, maxReelFiles, liveActionEndSec = null, endingBoundary = null } = {}) {
  const maxLive = resolveMaxLiveActionSec({ liveActionEndSec, endingBoundary, scope, model, durationSec });
  const effectiveDuration = Number.isFinite(maxLive) && maxLive > 0 ? Math.min(Number(durationSec) || maxLive, maxLive) : durationSec;
  return Packer.planReel(scope, { durationSec: effectiveDuration, paddingSec, maxReelSec: maxScopeReelSec, model, maxReelFiles });
}

// Deterministic STRUCTURAL validation of a Gemini-declared scope.
function validateStoryScope(scope, { durationSec, targetDurationMinSec = 65, maxScopeReelSec = DEFAULT_MAX_SCOPE_REEL_SEC, paddingSec = DEFAULT_REEL_PADDING_SEC, model = null, maxReelFiles, liveActionEndSec = null, endingBoundary = null } = {}) {
  const violations = [];
  const add = (code, message, extra = {}) => violations.push({ code, message, ...extra });
  if (!scope || typeof scope !== 'object') {
    add('SCOPE_MISSING', 'No chosen story scope (chosenStoryScopeId must match one candidate).');
    return { valid: false, violations, reel: null };
  }
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Infinity;
  const maxEndingSec = resolveMaxLiveActionSec({ liveActionEndSec, endingBoundary, scope, model, durationSec: dur });
  const hasOutroCap = Number.isFinite(maxEndingSec) && maxEndingSec > 0 && maxEndingSec < dur - 0.05;
  const inSource = (s, e) => Number.isFinite(s) && Number.isFinite(e) && s >= -TIME_EPS && e <= dur + TIME_EPS && e > s;

  for (const f of ['storyScopeId', 'centralConflict', 'centralViewerQuestion', 'whyThisIsOneStory']) {
    if (!String(scope[f] || '').trim()) add('SCOPE_FIELD_EMPTY', `storyScope.${f} must be a non-empty string.`, { field: f });
  }
  if (!END_TARGETS.includes(scope.scopeEndTarget)) add('SCOPE_FIELD_EMPTY', `scopeEndTarget must be one of ${END_TARGETS.join('|')}.`, { field: 'scopeEndTarget' });

  const b = scope.explicitScopeBoundary || {};
  const b0 = num(b.startSec), b1 = num(b.endSec);
  if (!inSource(b0, b1)) add('SCOPE_BOUNDARY_INVALID', `explicitScopeBoundary ${b.startSec}-${b.endSec}s must be a valid range inside the source (0-${round2(dur)}s).`);
  if (hasOutroCap && Number.isFinite(b0) && b0 >= maxEndingSec - 0.05) {
    add('SCOPE_BOUNDARY_IN_OUTRO', `explicitScopeBoundary starts at ${b0}s inside the post-incident outro region (liveActionEndSec=${round2(maxEndingSec)}s).`);
  }

  for (const field of Object.keys(SCOPE_LIMITS)) {
    if (field === 'candidates' || field === 'scopeWindows') continue;
    const arr = scope[field];
    if (arr === undefined && SCOPE_LIMITS[field].min === 0) continue;
    const n = Array.isArray(arr) ? arr.length : 0;
    if (n > SCOPE_LIMITS[field].max) add('SCOPE_COUNT_OVER_LIMIT', `${field} contains ${n} items; maximum allowed is ${SCOPE_LIMITS[field].max}.`, { field, count: n, max: SCOPE_LIMITS[field].max });
  }

  const declaredWindows = Array.isArray(scope.scopeWindows) ? scope.scopeWindows : [];
  declaredWindows.forEach((w, i) => {
    const s = num(w?.startSec), e = num(w?.endSec);
    if (!inSource(s, e)) add('SCOPE_WINDOW_INVALID', `scopeWindows[${i}] ${w?.startSec}-${w?.endSec}s is not a valid source range.`, { index: i });
    if (hasOutroCap && Number.isFinite(s) && s >= maxEndingSec - 0.1) {
      add('SCOPE_WINDOW_IN_OUTRO', `scopeWindows[${i}] (${w?.windowId || i}) starts at ${s}s inside post-incident outro/recap graphics (valid live-action footage ends at ${round2(maxEndingSec)}s). Put outro facts in allowedSupportingContext with treatment='narration_only'.`, { index: i, liveActionEndSec: round2(maxEndingSec) });
    }
    const ps = windowPurposes(w);
    if (!ps.length || ps.some(p => !WINDOW_PURPOSES.includes(p))) add('SCOPE_WINDOW_INVALID', `scopeWindows[${i}].purposes must be a non-empty subset of ${WINDOW_PURPOSES.join('|')}.`, { index: i });
  });
  const normalization = normalizeScopeWindows(declaredWindows);
  const windows = normalization.windows;
  if (!windows.length) add('SCOPE_WINDOWS_EMPTY', 'scopeWindows must list the in-scope source windows the editor will watch.');
  if (Number.isFinite(SCOPE_LIMITS.scopeWindows.max) && windows.length > SCOPE_LIMITS.scopeWindows.max) {
    add('SCOPE_COUNT_OVER_LIMIT', `scopeWindows contains ${windows.length} unique windows${normalization.declaredCount !== windows.length ? ` (${normalization.declaredCount} declared; overlapping duplicates already merged)` : ''}; maximum allowed is ${SCOPE_LIMITS.scopeWindows.max}.`, { field: 'scopeWindows', count: windows.length, declared: normalization.declaredCount, max: SCOPE_LIMITS.scopeWindows.max });
  }
  const inScope = w => w.purposes.some(p => p !== 'supporting_context');
  const supportingFootage = (scope.allowedSupportingContext || []).filter(c => c && c.treatment === 'footage');
  windows.forEach(w => {
    const s = w.startSec, e = w.endSec;
    if (!inScope(w)) {
      const declared = supportingFootage.some(c => overlaps(s, e, num(c.sourceStartSec), num(c.sourceEndSec)) > 0);
      if (!declared) add('SCOPE_SUPPORT_UNDECLARED', `scopeWindow '${w.windowId}' is supporting_context but no allowedSupportingContext item with treatment='footage' covers ${s}-${e}s.`, { windowId: w.windowId });
    } else if (Number.isFinite(b0) && Number.isFinite(b1) && (s < b0 - TIME_EPS || e > b1 + TIME_EPS)) {
      add('SCOPE_WINDOW_OUTSIDE_BOUNDARY', `scopeWindow '${w.windowId}' (${w.purposes.join('+')}) ${s}-${e}s lies outside explicitScopeBoundary ${b0}-${b1}s.`, { windowId: w.windowId });
    }
  });
  (Array.isArray(scope.hookCandidates) ? scope.hookCandidates : []).forEach((h, i) => {
    const s = num(h.sourceStartSec), e = num(h.sourceEndSec);
    if (!inSource(s, e) || !windows.some(w => inScope(w) && s >= w.startSec - TIME_EPS && e <= w.endSec + TIME_EPS)) {
      add('SCOPE_HOOK_OUTSIDE_SCOPE', `hookCandidates[${i}] ${h.sourceStartSec}-${h.sourceEndSec}s must lie inside one in-scope window.`, { index: i });
    }
    if (hasOutroCap && Number.isFinite(e) && e > maxEndingSec + 0.05) {
      add('SCOPE_HOOK_IN_OUTRO', `hookCandidates[${i}] ${s}-${e}s extends past valid liveActionEndSec (${round2(maxEndingSec)}s).`, { index: i });
    }
  });

  const spine = Array.isArray(scope.causalSpine) ? scope.causalSpine : [];
  if (spine.length < 2) add('SCOPE_SPINE_TOO_SHORT', 'causalSpine must list at least two ordered source events of the central conflict.');
  spine.forEach((n, i) => {
    const s = num(n.sourceStartSec), e = num(n.sourceEndSec);
    if (!inSource(s, e)) add('SCOPE_SPINE_INVALID', `causalSpine[${i}] ${n.sourceStartSec}-${n.sourceEndSec}s is not a valid source range.`, { index: i });
    else if (hasOutroCap && s >= maxEndingSec - 0.1) {
      add('SCOPE_SPINE_IN_OUTRO', `causalSpine[${i}] (${n.eventId}) starts at ${s}s inside post-incident outro (valid live-action ends at ${round2(maxEndingSec)}s).`, { index: i });
    } else if (!windows.some(w => overlaps(s, e, num(w.startSec), num(w.endSec)) > 0)) {
      add('SCOPE_SPINE_NOT_WATCHABLE', `causalSpine[${i}] (${n.eventId}) ${s}-${e}s is not covered by any scopeWindow, so the editor could not see it.`, { index: i });
    }
  });

  const endings = Array.isArray(scope.candidateEndingEvents) ? scope.candidateEndingEvents : [];
  if (!endings.length) add('SCOPE_ENDING_MISSING', 'candidateEndingEvents must name at least one in-scope ending that is a consequence of the central conflict.');
  endings.forEach((en, i) => {
    const s = num(en.sourceStartSec), e = num(en.sourceEndSec);
    if (!inSource(s, e)) add('SCOPE_ENDING_INVALID', `candidateEndingEvents[${i}] ${en.sourceStartSec}-${en.sourceEndSec}s is not a valid source range.`, { index: i });
    else if (hasOutroCap && s >= maxEndingSec - 0.1) {
      add('SCOPE_ENDING_IN_OUTRO', `candidateEndingEvents[${i}] starts at ${s}s inside post-incident outro (valid liveActionEndSec=${round2(maxEndingSec)}s).`, { index: i });
    } else if (!windows.some(w => inScope(w) && overlaps(s, e, w.startSec, w.endSec) > 0)) {
      add('SCOPE_ENDING_OUTSIDE_SCOPE', `candidateEndingEvents[${i}] ${s}-${e}s is not inside an in-scope window.`, { index: i });
    }
  });

  // Deterministically clamp ALL windows, purposeRanges, causalSpine, hooks, endings, and explicitScopeBoundary to maxEndingSec
  const clampEnd = (s, e) => (hasOutroCap && Number.isFinite(e) && e > maxEndingSec && Number.isFinite(s) && s < maxEndingSec ? round2(maxEndingSec) : e);
  const cappedWindows = windows
    .filter(w => !(hasOutroCap && w.startSec >= maxEndingSec - 0.05))
    .map(w => {
      if (hasOutroCap && w.endSec > maxEndingSec && w.startSec < maxEndingSec) {
        const cappedPr = Array.isArray(w.purposeRanges)
          ? w.purposeRanges
              .filter(pr => num(pr.startSec) < maxEndingSec - 0.05)
              .map(pr => ({ ...pr, endSec: clampEnd(num(pr.startSec), num(pr.endSec)) }))
          : w.purposeRanges;
        return { ...w, endSec: round2(maxEndingSec), purposeRanges: cappedPr };
      }
      return w;
    });
  const cappedEndings = endings
    .filter(en => !(hasOutroCap && num(en.sourceStartSec) >= maxEndingSec - 0.05))
    .map(en => ({ ...en, sourceEndSec: clampEnd(num(en.sourceStartSec), num(en.sourceEndSec)) }));
  const cappedSpine = spine
    .filter(n => !(hasOutroCap && num(n.sourceStartSec) >= maxEndingSec - 0.05))
    .map(n => ({ ...n, sourceEndSec: clampEnd(num(n.sourceStartSec), num(n.sourceEndSec)) }));
  const cappedHooks = Array.isArray(scope.hookCandidates)
    ? scope.hookCandidates
        .filter(h => !(hasOutroCap && num(h.sourceStartSec) >= maxEndingSec - 0.05))
        .map(h => ({ ...h, sourceEndSec: clampEnd(num(h.sourceStartSec), num(h.sourceEndSec)) }))
    : scope.hookCandidates;
  const cappedExplicitBoundary = scope.explicitScopeBoundary
    ? { ...scope.explicitScopeBoundary, endSec: clampEnd(b0, b1) }
    : scope.explicitScopeBoundary;

  const normalizedCommentary = Array.isArray(scope.commentaryOpportunities)
    ? scope.commentaryOpportunities.map(c => {
        const s = num(c?.sourceStartSec), e = clampEnd(num(c?.sourceStartSec), num(c?.sourceEndSec));
        if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
        const win = cappedWindows.find(w => inScope(w) && overlaps(s, e, w.startSec, w.endSec) > 0);
        if (!win) return c;
        return { ...c, sourceStartSec: round2(Math.max(s, win.startSec)), sourceEndSec: round2(Math.min(e, win.endSec)) };
      }).filter(Boolean)
    : undefined;

  const climaxSpineNodes = cappedSpine.filter(n => /climax|breach|takedown|window_break|extraction|force|struggle/i.test(`${n.role || ''} ${n.eventId || ''} ${n.whyInScope || ''}`));
  const enrichedWindows = cappedWindows.map(w => {
    const coversClimax = climaxSpineNodes.some(n => overlaps(w.startSec, w.endSec, num(n.sourceStartSec), num(n.sourceEndSec)) > 0.5);
    if (coversClimax && Array.isArray(w.purposes) && !w.purposes.includes('hook_material')) {
      return { ...w, purposes: [...w.purposes, 'hook_material'] };
    }
    return w;
  });
  const normalizedMustWithhold = Array.isArray(scope.mustWithhold)
    ? scope.mustWithhold.filter(item => !/\b(cold\s+open|teaser)\b/i.test(String(item || '')))
    : scope.mustWithhold;

  const resolvedBoundaryMeta = endingBoundary || scope?.endingBoundary || model?.endingBoundary || model?.liveActionBoundary || null;
  const normalizedScope = {
    ...scope,
    ...(normalizedMustWithhold !== undefined ? { mustWithhold: normalizedMustWithhold } : {}),
    explicitScopeBoundary: cappedExplicitBoundary,
    causalSpine: cappedSpine,
    candidateEndingEvents: cappedEndings,
    scopeWindows: enrichedWindows,
    ...(cappedHooks !== undefined ? { hookCandidates: cappedHooks } : {}),
    ...(normalizedCommentary ? { commentaryOpportunities: normalizedCommentary } : {}),
    ...(Number.isFinite(maxEndingSec) ? { liveActionEndSec: round2(maxEndingSec) } : {}),
    ...(resolvedBoundaryMeta ? { endingBoundary: resolvedBoundaryMeta } : {})
  };
  const reel = planScopeReel(normalizedScope, { durationSec: dur, paddingSec, maxScopeReelSec, model, maxReelFiles, liveActionEndSec: maxEndingSec, endingBoundary: resolvedBoundaryMeta });
  const watchable = totalSec(mergeRanges(enrichedWindows.map(w => ({ startSec: w.startSec, endSec: w.endSec }))));
  if (enrichedWindows.length && watchable < targetDurationMinSec) {
    add('SCOPE_FOOTAGE_INSUFFICIENT', `In-scope windows hold only ${round2(watchable)}s of usable live-action footage; the requested minimum duration is ${targetDurationMinSec}s. Widen the windows inside the same conflict.`);
  }
  if (reel.totalSec > maxScopeReelSec + TIME_EPS) {
    add('SCOPE_REEL_OVER_BUDGET', `The scope media reel would be ${reel.totalSec}s even after compacting broad windows around their events/quotes (logical footage ${reel.logicalFootageSec}s, ${paddingSec}s context padding); the budget is ${maxScopeReelSec}s. Tighten the windows to the causal spine of ONE conflict.`);
  }
  return { valid: violations.length === 0, violations, reel, normalizedScope, normalization: { declaredCount: normalization.declaredCount, uniqueCount: enrichedWindows.length, merges: normalization.notes, liveActionEndSec: Number.isFinite(maxEndingSec) ? round2(maxEndingSec) : null } };
}

function oversizedScopeText(v, pathPrefix = 'selection') {
  if (typeof v === 'string') {
    return v.length > MAX_SCOPE_TEXT_CHARS
      ? `${pathPrefix} length ${v.length} exceeds ${MAX_SCOPE_TEXT_CHARS} chars (likely token repetition loop)`
      : null;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const hit = oversizedScopeText(v[i], `${pathPrefix}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      const hit = oversizedScopeText(val, `${pathPrefix}.${k}`);
      if (hit) return hit;
    }
  }
  return null;
}

function validateSelectionShape(v) {
  if (!v || !Array.isArray(v.candidates) || !v.candidates.length) throw new StoryError('INVALID_RESPONSE', 'Story Scope selection returned no candidates.');
  const oversized = oversizedScopeText(v);
  if (oversized) throw new StoryError('INVALID_RESPONSE', `Story Scope response contains degenerate oversized text: ${oversized}.`);
  if (!chosenScope(v)) throw new StoryError('INVALID_RESPONSE', 'chosenStoryScopeId does not match any candidate.');
  return v;
}

// Compact, text-only view of the model for scope selection, annotated with live-action footage boundary.
function modelForScope(model, liveActionEndSec = null) {
  const maxLive = resolveMaxLiveActionSec({ liveActionEndSec, model, durationSec: model?.durationSec });
  const hasCap = Number.isFinite(maxLive) && maxLive > 0 && maxLive < (Number(model?.durationSec) || Infinity) - 0.05;
  return {
    durationSec: model.durationSec,
    ...(Number.isFinite(maxLive) ? { liveActionEndSec: round2(maxLive) } : {}),
    ...(model.endingBoundary ? { endingBoundary: { hasOutro: !!model.endingBoundary.hasOutro, outroStartSec: model.endingBoundary.outroStartSec, liveActionEndSec: model.endingBoundary.liveActionEndSec, outroType: model.endingBoundary.outroType, uncertain: !!model.endingBoundary.uncertain } } : {}),
    people: model.people || [],
    events: (model.events || []).map(e => ({
      id: e.id,
      startSec: e.startSec,
      endSec: hasCap && e.startSec < maxLive && e.endSec > maxLive ? round2(maxLive) : e.endSec,
      type: e.type,
      summary: e.summary,
      location: e.location,
      peopleIds: e.peopleIds,
      tension: e.tension,
      dialogueImpact: e.dialogueImpact,
      isReveal: e.isReveal,
      ...(hasCap && e.startSec >= maxLive - 0.05 ? { postLiveActionOutroOnly: true } : {})
    })),
    quotes: (model.quotes || [])
      .filter(q => !(hasCap && Number(q.startSec) >= maxLive - 0.05))
      .map(q => ({ id: q.id, eventId: q.eventId, speaker: q.speaker, startSec: q.startSec, endSec: hasCap ? Math.min(Number(q.endSec), round2(maxLive)) : q.endSec, text: q.text, epistemic: q.epistemic, editorialValue: q.editorialValue })),
    ...(Array.isArray(model.audioEvents) && model.audioEvents.length ? {
      audioEvents: model.audioEvents.filter(a => !(hasCap && Number(a.startSec ?? a.atSec ?? 0) >= maxLive - 0.05))
    } : {})
  };
}

// ---------------------------------------------------------------- Gemini stage
// Returns { scope, selection, reel, attempts } or throws StoryError('STORY_SCOPE_INVALID').
async function selectStoryScope(engine, model, { root = null, write = null, emit = () => {}, maxRepairs = 2, liveActionEndSec = null, endingBoundary = null } = {}) {
  if (!model || !Array.isArray(model.events) || !model.events.length) {
    throw new StoryError('INPUT_MISSING', 'Story Scope requires a Source Story Model with events.');
  }
  const cfg = engine.config || {};
  const resolvedBoundary = endingBoundary || model?.endingBoundary || model?.liveActionBoundary || null;
  const resolvedLiveActionEndSec = resolveMaxLiveActionSec({
    liveActionEndSec,
    endingBoundary: resolvedBoundary,
    model,
    durationSec: engine.duration || model.durationSec
  });
  const opts = {
    durationSec: engine.duration || model.durationSec,
    targetDurationMinSec: cfg.targetDurationMinSec || 65,
    maxScopeReelSec: cfg.maxScopeReelSec || DEFAULT_MAX_SCOPE_REEL_SEC,
    paddingSec: cfg.scopeReelPaddingSec ?? DEFAULT_REEL_PADDING_SEC,
    model,
    maxReelFiles: cfg.maxReelFiles || undefined,
    liveActionEndSec: resolvedLiveActionEndSec,
    endingBoundary: resolvedBoundary
  };
  const input = {
    model: modelForScope(model, resolvedLiveActionEndSec),
    liveActionEndSec: round2(resolvedLiveActionEndSec),
    ...(resolvedBoundary?.hasOutro ? { outroBoundaryWarning: `Post-incident outro/recap begins at ${resolvedBoundary.outroStartSec}s; ALL scopeWindows, causalSpine nodes, hookCandidates, and candidateEndingEvents MUST end <= ${round2(resolvedLiveActionEndSec)}s.` } : {}),
    targetDurationMinSec: cfg.targetDurationMinSec || 65,
    targetDurationMaxSec: cfg.targetDurationMaxSec || 90,
    maxScopeReelSec: opts.maxScopeReelSec,
    storyMode: cfg.storyMode || 'serialized_part'
  };
  const attempts = [];
  let violations = null, previous = null, failingId = null;
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const repair = attempt > 0;
    let selection = null, schemaError = null;
    const stageName = `v5-story-scope${repair ? `_repair${attempt}` : ''}`;
    const stageInput = repair ? { ...input, previousSelection: previous, failingStoryScopeId: failingId, violations } : input;
    const stageInstruction = repair ? `${instruction}\n\n${repairInstruction(violations, failingId)}` : instruction;
    try {
      selection = await engine.ask(
        stageName,
        stageInput,
        schemas.storyScopeSelection,
        stageInstruction,
        [],
        validateSelectionShape,
        'auto_story_edit',
        { ...SCOPE_GENERATION }
      );
    } catch (e) {
      const msg = String(e?.message || '');
      const isTokenOrTruncation = /MAX_TOKENS|JSON root bị cắt|không hoàn tất response|degenerate oversized text/i.test(msg);
      if (isTokenOrTruncation) {
        emit('design', `[Scope] Story Scope hit MAX_TOKENS/truncation; retrying with compact single-candidate anti-repetition mode...`, 'WARNING');
        try {
          selection = await engine.ask(
            `${stageName}_compact`,
            stageInput,
            schemas.storyScopeSelection,
            `${stageInstruction}\n\n${COMPACT_SCOPE_RECOVERY_INSTRUCTION}`,
            [],
            validateSelectionShape,
            'auto_story_edit',
            { ...SCOPE_GENERATION, noCache: true, temperature: 0.25 }
          );
        } catch (retryErr) {
          if (retryErr?.invalidArtifact === undefined && retryErr?.kind !== 'INVALID_RESPONSE') throw retryErr;
          selection = retryErr.invalidArtifact || null;
          schemaError = retryErr.message;
        }
      } else {
        if (e?.invalidArtifact === undefined && e?.kind !== 'INVALID_RESPONSE') throw e;
        selection = e.invalidArtifact || null;
        schemaError = e.message;
      }
    }
    const scope = schemaError ? null : chosenScope(selection);
    const nCandidates = Array.isArray(selection?.candidates) ? selection.candidates.length : 0;
    let report = schemaError
      ? { valid: false, violations: [{ code: 'SCHEMA_INVALID', message: `Response did not match the Story Scope contract: ${schemaError}. Count limits: ${limitsText()}.` }], reel: null }
      : validateStoryScope(scope, opts);
    if (!schemaError && nCandidates > SCOPE_LIMITS.candidates.max) {
      report = { ...report, valid: false, violations: [...report.violations, { code: 'SCOPE_COUNT_OVER_LIMIT', message: `candidates contains ${nCandidates} items; maximum allowed is ${SCOPE_LIMITS.candidates.max}.`, field: 'candidates', count: nCandidates, max: SCOPE_LIMITS.candidates.max }] };
    }
    attempts.push({ attempt, chosenStoryScopeId: selection?.chosenStoryScopeId || null, valid: report.valid, violations: report.violations,
      scopeWindowsDeclared: report.normalization?.declaredCount ?? null, scopeWindowsUnique: report.normalization?.uniqueCount ?? null,
      liveActionEndSec: round2(resolvedLiveActionEndSec),
      selectionFingerprint: selection ? require('crypto').createHash('sha256').update(JSON.stringify(selection)).digest('hex').slice(0, 16) : null });
    if (write && root) {
      await write(require('path').join(root, `story-scope-selection${repair ? `-repair-${attempt}` : ''}.json`), { selection, validation: report });
    }
    if (report.valid) {
      // The NORMALIZED scope (unique windows, clamped to liveActionEndSec) is what the reel, director and critic use.
      const finalScope = { ...report.normalizedScope, contract: SCOPE_CONTRACT_VERSION, targetDurationMinSec: input.targetDurationMinSec, targetDurationMaxSec: input.targetDurationMaxSec,
        windowNormalization: report.normalization };
      emit('design', `[Scope] Story Scope selected: ${finalScope.storyScopeId} (liveActionEndSec=${finalScope.liveActionEndSec}s) — ${finalScope.centralViewerQuestion}`);
      return { scope: finalScope, selection, reel: report.reel, attempts };
    }
    emit('design', `[Scope] Story Scope needs repair #${attempt + 1}: ${report.violations.map(v => v.code).join(', ')}`, 'WARNING');
    violations = report.violations; previous = selection || previous;
    failingId = scope?.storyScopeId || selection?.chosenStoryScopeId || failingId;
  }
  throw new StoryError('STORY_SCOPE_INVALID', `Story Scope failed structural validation after ${maxRepairs} repair pass(es): ${violations.map(v => v.code).join(', ')}`, { violations, attempts });
}

// Additional in-scope candidates (validated) for outputCount > 1.
function alternateScopes(selection, chosenId, opts) {
  return (selection?.candidates || [])
    .filter(c => c && c.storyScopeId !== chosenId)
    .map(c => validateStoryScope(c, opts))
    .filter(r => r.valid)
    .map(r => ({ ...r.normalizedScope, windowNormalization: r.normalization }));
}

module.exports = {
  SCOPE_CONTRACT_VERSION, DEFAULT_MAX_SCOPE_REEL_SEC, DEFAULT_REEL_PADDING_SEC, SCOPE_LIMITS,
  SCOPE_MAX_OUTPUT_TOKENS, SCOPE_THINKING_BUDGET, SCOPE_GENERATION, MAX_SCOPE_TEXT_CHARS,
  normalizeScopeWindows, limitsText, resolveMaxLiveActionSec, schemas, instruction, selectStoryScope,
  validateStoryScope, validateSelectionShape, planScopeReel, mergeRanges, chosenScope, alternateScopes, modelForScope
};

