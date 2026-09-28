// AutoStory v3 — Phases 9/10/11: deterministic, BLOCKING narration gates.
//
// The model does NOT grade its own narration. Every narration line is checked
// here against the Source Story Model and the beat's own metadata. Any 'error'
// severity blocks compilation and returns targeted repair ids (only affected
// beats regenerate — never the whole pipeline).
//
// Checks:
//   A. no_information_gap   narration exists but adds nothing (Phase 9)
//   B. no_function          narration line without a valid narratorFunction (Phase 10)
//   C. dialogue_redundancy  narration parrots the original dialogue (Phase 11.B)
//   D. visual_redundancy    narration only describes the obvious visible action (11.C)
//   E. ungrounded           a factual claim with no evidence ref (11.A / Rule 8)
//   F. spoiler              narration reveals a later reveal beat (11.D / Phase 6)
//   G. epistemic            a non-fact statement narrated as established fact (11.E)
//
// Open loops (Phase 6) are explicitly allowed: setup-now / payoff-later is NOT a
// spoiler and NOT ungrounded as long as the fact is source-referenced.

const { NARRATOR_FUNCTIONS, NON_FACT_EPISTEMIC } = require('./autoStoryV3Taxonomy');

const DIALOGUE_OVERLAP_LIMIT = 0.5;   // Jaccard token overlap with original dialogue
const HEDGE = /\b(claim|claims|claimed|allege|alleged|allegedly|reportedly|says|said|according to|police say|appears|seems|would later|investigators|suspected|accused)\b/i;
const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'or', 'but', 'in', 'on', 'at', 'is', 'are', 'was', 'were', 'be', 'he', 'she', 'they', 'it', 'his', 'her', 'their', 'this', 'that', 'with', 'for', 'as', 'i', 'you', 'we', 'not', 'no']);

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(w => w && !STOP.has(w));
}
function jaccard(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
// Fuzzy token match tolerant of simple inflection (get/getting, refuse/refuses)
// so paraphrase of dialogue is caught, not just verbatim repeats.
function fuzzyMatch(a, b) {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 3 && l.startsWith(s)) return true;         // get -> getting
  let n = 0; while (n < s.length && s[n] === l[n]) n++;       // shared prefix
  return n >= 4;                                              // refus(es) -> refus(e)
}
// Max share of either side's content tokens that appear (fuzzily) in the other.
function contentContainment(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return 0;
  const inA = A.filter(x => B.some(y => fuzzyMatch(x, y))).length / A.length;
  const inB = B.filter(y => A.some(x => fuzzyMatch(x, y))).length / B.length;
  return Math.max(inA, inB);
}

// model: { events:[{id,isReveal}], quotes:[{id,text,epistemic}], facts?:[{id}] }
// beats: ordered array of casted beats:
//   { beatId, order, narratorText, narratorFunction, audioIntent|speaks,
//     newInformation:[], newInformationRefs:[ids], originalQuoteIds:[ids],
//     informationClass, opensLoopId, closesLoopId }
function inspect(beats = [], model = {}) {
  const issues = [];
  const quoteById = new Map((model.quotes || []).map(q => [q.id, q]));
  const eventById = new Map((model.events || []).map(e => [e.id, e]));
  const factIds = new Set((model.facts || []).map(f => f.id));
  const refExists = id => quoteById.has(id) || eventById.has(id) || factIds.has(id);

  // Order index for spoiler detection.
  const orderOf = new Map();
  beats.forEach((b, i) => orderOf.set(b.beatId, Number.isFinite(b.order) ? b.order : i));

  beats.forEach((beat, i) => {
    const speaks = beat.speaks === true || beat.audioIntent === 'narration';
    const text = String(beat.narratorText || '').trim();
    if (!speaks || !text) return; // original-audio beats are never gated on narration.

    const push = (code, reason, severity = 'error') =>
      issues.push({ beatId: beat.beatId, order: i, code, severity, reason });

    // B. Function required.
    if (!NARRATOR_FUNCTIONS.includes(beat.narratorFunction)) {
      push('no_function', `Narration has no valid narratorFunction (${beat.narratorFunction || 'none'}).`);
    }

    const newInfo = Array.isArray(beat.newInformation) ? beat.newInformation.filter(Boolean) : [];
    const refs = Array.isArray(beat.newInformationRefs) ? beat.newInformationRefs.filter(Boolean) : [];

    // A. Information gap: narration must add something or serve a transition function.
    const transitionFns = new Set(['BRIDGE', 'TIME_JUMP', 'LOCATION_CHANGE', 'RECAP']);
    if (!newInfo.length && !transitionFns.has(beat.narratorFunction)) {
      push('no_information_gap', 'Narration adds no new information and is not a transition; make the beat original audio.');
    }

    // C. Dialogue redundancy.
    const dialogue = (beat.originalQuoteIds || [])
      .map(id => quoteById.get(id)?.text || '')
      .join(' ');
    if (dialogue && contentContainment(text, dialogue) >= DIALOGUE_OVERLAP_LIMIT) {
      push('dialogue_redundancy', 'Narration repeats the original dialogue; remove or make it add setup/consequence.');
    }

    // D. Visual redundancy (describe-only): no new info + describe-y wording.
    if (!newInfo.length && /\b(walk|walks|walking|approach|approaches|steps|stands|sits|points|opens|closes|gets out|pulls over)\b/i.test(text)
        && !transitionFns.has(beat.narratorFunction)) {
      push('visual_redundancy', 'Narration only describes the visible action.');
    }

    // E. Grounding: every factual claim must reference a real evidence id.
    if (newInfo.length && !refs.length) {
      push('ungrounded', 'Narration states new information with no newInformationRefs to source evidence.');
    } else {
      for (const id of refs) {
        if (!refExists(id)) push('ungrounded', `newInformationRefs id "${id}" not found in the Source Story Model.`);
      }
    }

    // G. Epistemic safety: non-fact source must be hedged, not stated as fact.
    for (const id of refs) {
      const q = quoteById.get(id);
      if (q && NON_FACT_EPISTEMIC.has(q.epistemic) && !HEDGE.test(text)) {
        push('epistemic', `References ${q.epistemic} (id ${id}) but states it as fact without attribution/hedge.`);
      }
    }

    // F. Spoiler: don't narrate a later reveal event before its own beat.
    for (const id of refs) {
      const ev = eventById.get(id);
      if (!ev?.isReveal) continue;
      // Find the beat that actually delivers that reveal event.
      const revealBeat = beats.find(b => b.sourceEventId === id);
      if (revealBeat && orderOf.get(revealBeat.beatId) > i) {
        push('spoiler', `Narration reveals event ${id} before its reveal beat (${revealBeat.beatId}).`);
      }
    }
  });

  const errors = issues.filter(x => x.severity === 'error');
  return {
    passed: errors.length === 0,
    issues,
    repairBeatIds: [...new Set(errors.map(x => x.beatId))]
  };
}

module.exports = { inspect, jaccard, DIALOGUE_OVERLAP_LIMIT };
