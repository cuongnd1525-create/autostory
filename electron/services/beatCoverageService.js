// AutoStory v3 — Beat Coverage (Phase 3/4 quality fix). Pure + testable.
//
// PROBLEM this solves (the "16.8s -> 65s via extend" smell): Story Design +
// Beat Casting can produce very few beats that together cover only a fraction
// of the requested duration. Duration Fit then STRETCHES those same few clips
// (one static scene) to fill time, so the video is editorially thin and repetitive.
//
// FIX: after deterministic casting and BEFORE narration, detect a STRUCTURAL
// deficit (too little real content OR too few distinct events) and augment the
// timeline with the highest-NOVELTY UNUSED Source Story Model events as new
// visual/original-audio beats. This brings DISTINCT scenes (different people,
// places, actions, moments) instead of replaying one. Fully deterministic — no
// Vertex call, no fabricated facts (every added beat is a real modeled event).
//
// Runs before audio-role assignment so added beats get roles/narration-gap
// treatment like any other beat. Duration Fit afterwards only fine-tunes.

const { timelineSeconds } = require('./autoStoryDurationFit');

const STRUCTURAL_RATIO = 0.7;      // base < 0.7*min => structural deficit (not a small gap)
const MIN_BEAT_SEC = 2.0;          // never add a sub-2s flash
const MAX_COVERAGE_BEAT_SEC = 12;  // keep added scenes punchy (retention), never a long hold
const MIN_VISUAL_QUALITY = 0.35;   // same floor beat casting uses
const MAX_ADD = 12;                // hard cap on inserted scenes
const MAX_PER_LOCATION = 2;        // force spread: at most 2 added beats share a location
const EPS = 0.25;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const len = b => Math.max(0, num(b.sourceEndSec) - num(b.sourceStartSec));

// Tokenize a short summary for information-overlap novelty (stopword-light).
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'at', 'is', 'are', 'was', 'were', 'his', 'her', 'him', 'she', 'he', 'they', 'it', 'with', 'for', 'as', 'by', 'from', 'into', 'out']);
function tokens(s) {
  return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
}
function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

// Resolve the model event backing a beat (beats carry sourceEventId), merged
// with any fields the beat already holds so raw beats or full events both work.
function eventOf(beat, byId) {
  const ev = beat.sourceEventId && byId.get(beat.sourceEventId);
  return { ...(ev || {}), ...beat, id: beat.sourceEventId || beat.id, startSec: num(beat.sourceStartSec, ev?.startSec), endSec: num(beat.sourceEndSec, ev?.endSec) };
}

function locationKey(ev) {
  const loc = String(ev.location || '').trim().toLowerCase();
  if (loc) return loc;
  // Fall back to a coarse source-time cluster so nearby unlabeled moments count
  // as "the same scene" for de-clustering purposes.
  return `t${Math.round(num(ev.startSec) / 30)}`;
}

// Novelty of ONE candidate event against the already-selected set. Each
// component in [0,1]; aggregate is a weighted blend. Higher = adds more that is
// genuinely new to the viewer.
function noveltyScores(candidate, selected = []) {
  const seenIds = new Set(selected.map(e => e.id));
  const seenPeople = new Set(selected.flatMap(e => e.peopleIds || []));
  const seenLoc = selected.map(locationKey);
  const seenLocCount = seenLoc.reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {});
  const seenTypes = new Set(selected.map(e => e.type).filter(Boolean));
  const seenSummaryTokens = selected.map(e => tokens(e.summary));

  const eventNovelty = seenIds.has(candidate.id) ? 0 : 1;
  const cp = candidate.peopleIds || [];
  const personNovelty = cp.length ? cp.filter(p => !seenPeople.has(p)).length / cp.length : (seenPeople.size ? 0.5 : 1);
  const lk = locationKey(candidate);
  const locationNovelty = 1 / (1 + (seenLocCount[lk] || 0)); // 1, .5, .33 ...
  const actionNovelty = candidate.type ? (seenTypes.has(candidate.type) ? 0.3 : 1) : 0.5;
  const ct = tokens(candidate.summary);
  const maxOverlap = seenSummaryTokens.reduce((mx, s) => Math.max(mx, jaccard(ct, s)), 0);
  const informationNovelty = 1 - maxOverlap;
  const visualNovelty = clamp(num(candidate.visualQuality, 0.5), 0, 1) * (0.5 + 0.5 * locationNovelty);
  const audioMomentStrength = clamp(num(candidate.dialogueImpact) * 0.6 + num(candidate.audioConfidence) * 0.2 + (candidate.isReveal ? 0.2 : 0), 0, 1);

  const aggregate = clamp(
    0.24 * informationNovelty + 0.20 * eventNovelty + 0.16 * locationNovelty +
    0.14 * personNovelty + 0.12 * actionNovelty + 0.08 * visualNovelty + 0.06 * audioMomentStrength,
    0, 1);
  return { informationNovelty, eventNovelty, personNovelty, locationNovelty, actionNovelty, visualNovelty, audioMomentStrength, aggregate };
}

// Intrinsic editorial pull of an event (independent of what's selected).
function intrinsicValue(ev) {
  return num(ev.tension) + num(ev.dialogueImpact) * 0.6 + num(ev.visualQuality) * 0.4 + (ev.isReveal ? 0.5 : 0) + num(ev.novelty) * 0.3;
}

function distinctEventCount(beats) { return new Set(beats.map(b => b.sourceEventId).filter(Boolean)).size; }
function minDistinctFor(min) { return clamp(Math.round(min / 12), 3, 8); }

// Insert added coverage beats spread across the middle (never before the hook,
// never after the final beat), de-clustered so two same-location scenes are not
// adjacent. Existing designed beats keep their order and open-loop integrity.
function distributeInserts(beats, additions) {
  if (!additions.length) return beats;
  const head = beats[0];
  const tail = beats[beats.length - 1];
  const middle = beats.slice(1, -1);
  // Interleave additions across the middle at even gaps, in the order given.
  const slots = middle.length + 1;
  const out = [];
  let ai = 0;
  const perSlot = additions.length / slots;
  for (let s = 0; s <= middle.length; s++) {
    const target = Math.round((s + 1) * perSlot);
    while (ai < target && ai < additions.length) out.push(additions[ai++]);
    if (s < middle.length) out.push(middle[s]);
  }
  while (ai < additions.length) out.push(additions[ai++]);
  // Single de-cluster pass: if two adjacent beats share a location, try to swap
  // the later one forward past a different-location neighbor.
  for (let i = 1; i < out.length; i++) {
    if ((out[i]._loc || '') && out[i]._loc === out[i - 1]._loc) {
      for (let j = i + 1; j < out.length; j++) {
        if (out[j]._loc !== out[i]._loc && out[j]._loc !== out[i - 1]._loc) { const t = out[i]; out[i] = out[j]; out[j] = t; break; }
      }
    }
  }
  return [head, ...out, tail].map(b => { const { _loc, ...rest } = b; return rest; });
}

// Determine what structural deficit an unused candidate event can fill
function detectDeficitFilled(candidate, beats = []) {
  if (!beats.length) return null;
  const cStart = num(candidate.startSec);
  const cEnd = num(candidate.endSec);

  // 1. Missing Bridge: does candidate sit between two consecutive beats with a large time gap (> 45s)?
  for (let i = 0; i < beats.length - 1; i++) {
    const b1End = num(beats[i].sourceEndSec);
    const b2Start = num(beats[i + 1].sourceStartSec);
    if (b2Start > b1End + 30 && cStart >= b1End && cEnd <= b2Start) {
      return { deficit: 'MISSING_BRIDGE', slotIndex: i + 1, why: `Bridges timeline gap between ${round1(b1End)}s and ${round1(b2Start)}s` };
    }
  }

  // 2. Missing Context: does candidate precede the hook or first confrontation?
  if (beats.length > 0 && candidate.type === 'context' && cStart < num(beats[0].sourceStartSec)) {
    return { deficit: 'MISSING_CONTEXT', slotIndex: 1, why: 'Provides essential grounding context before confrontation' };
  }

  // 3. Missing Evidence / Contradiction: is candidate a reveal or quote that supports or contradicts active claims?
  if (candidate.isReveal || candidate.dialogueImpact > 0.6) {
    const role = candidate.isReveal ? 'evidence_reveal' : 'contradiction';
    // Find closest beat
    let closestIdx = 1;
    let minD = Infinity;
    for (let i = 0; i < beats.length; i++) {
      const d = Math.abs(cStart - num(beats[i].sourceStartSec));
      if (d < minD) { minD = d; closestIdx = i + 1; }
    }
    return { deficit: candidate.isReveal ? 'MISSING_EVIDENCE' : 'MISSING_CONTRADICTION', slotIndex: closestIdx, why: `Provides concrete evidence/contradiction: ${candidate.summary || ''}` };
  }

  // 4. Missing Escalation: high tension moment
  if (candidate.tension >= 0.75) {
    return { deficit: 'MISSING_ESCALATION', slotIndex: Math.max(1, beats.length - 1), why: 'Elevates conflict before climax' };
  }

  return null;
}

const round1 = n => Math.round((Number(n) || 0) * 10) / 10;

// Main entry. Deterministically augment a structurally thin timeline with
// distinct unused events ONLY if they fill a documented structural deficit.
function augmentCoverage(beats = [], model = {}, config = {}, options = {}) {
  const min = num(config.targetDurationMinSec, 0);
  const max = num(config.targetDurationMaxSec, Infinity);
  const minQuality = Number.isFinite(options.minVisualQuality) ? options.minVisualQuality : MIN_VISUAL_QUALITY;
  const base = timelineSeconds(beats);
  const distinctBefore = distinctEventCount(beats);
  const minDistinct = minDistinctFor(min);
  const structural = base < STRUCTURAL_RATIO * min || distinctBefore < minDistinct;
  const byId = new Map((model.events || []).map(e => [e.id, e]));
  const selected = beats.map(b => eventOf(b, byId));

  const base_result = {
    beats, augmented: false, added: 0, base, structural,
    distinctBefore, minDistinct,
    reason: structural ? '' : 'no structural deficit'
  };

  // Guardrail: When Gemini Editorial Director outputs the exact EDL,
  // Coverage must NOT inject filler or reorder beats for diversity or duration.
  const hasEdlLock = beats.some(b => b.castReason === 'editorial director explicit edl lock' || b.castLock);
  if (hasEdlLock || options.disableCoverageAugment) {
    return {
      beats, augmented: false, added: 0, base, structural: false,
      distinctBefore, minDistinct,
      reason: 'editorial director explicit edl lock: coverage augmentation disabled'
    };
  }

  if (!structural) return base_result;
  if (beats.length < 2) return { ...base_result, reason: 'too few beats to place inserts safely' };

  // Aim to land the RAW timeline comfortably inside [min,max]
  const target = Math.min(max - 1, min + Math.max(3, (max - min) * 0.4));
  const usedIds = new Set(beats.map(b => b.sourceEventId).filter(Boolean));
  const usedRanges = beats.map(b => [num(b.sourceStartSec), num(b.sourceEndSec)]);
  const overlaps = (s, e) => usedRanges.some(([a, b]) => s < b && e > a);

  let pool = (model.events || []).filter(e =>
    !usedIds.has(e.id) && Number.isFinite(e.startSec) && Number.isFinite(e.endSec) &&
    (e.endSec - e.startSec) >= MIN_BEAT_SEC && num(e.visualQuality, 1) >= minQuality && !overlaps(e.startSec, e.endSec));

  let currentBeats = beats.slice();
  let current = base;
  const additions = [];

  while (current < target - EPS && additions.length < MAX_ADD && pool.length) {
    // Score pool by structural deficit + novelty
    const deficitCandidates = pool
      .map(e => {
        const deficitInfo = detectDeficitFilled(e, currentBeats);
        if (!deficitInfo) return null; // Reject if it fills NO structural deficit
        const nov = noveltyScores(e, currentBeats.map(b => eventOf(b, byId)));
        if (nov.informationNovelty < 0.15) return null; // Reject redundant information
        return {
          e,
          deficitInfo,
          nov,
          score: nov.aggregate * 0.5 + clamp(intrinsicValue(e) / 3, 0, 1) * 0.5
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.score - a.score) || (a.e.startSec - b.e.startSec));

    if (!deficitCandidates.length) break;

    const pick = deficitCandidates[0];
    const e = pick.e;
    const room = (max + EPS) - current;
    if (room < MIN_BEAT_SEC) break;
    const dur = clamp(Math.min(e.endSec - e.startSec, MAX_COVERAGE_BEAT_SEC, room), MIN_BEAT_SEC, MAX_COVERAGE_BEAT_SEC);

    const newBeat = {
      beatId: `cov_${e.id}`,
      narrativeRole: pick.deficitInfo.deficit === 'MISSING_EVIDENCE' ? 'reveal' :
                     pick.deficitInfo.deficit === 'MISSING_ESCALATION' ? 'escalation' : 'context',
      sourceEventId: e.id,
      sourceStartSec: e.startSec,
      sourceEndSec: e.startSec + dur,
      audioStrategy: 'original',
      speaks: false,
      narratorText: '',
      previewVi: '',
      audioType: e.audioType || 'uncertain',
      audioConfidence: num(e.audioConfidence),
      tension: num(e.tension),
      dialogueImpact: num(e.dialogueImpact),
      isReveal: e.isReveal === true,
      structuralDeficitFilled: pick.deficitInfo.deficit,
      viewerStateChange: e.summary || 'Uncovers additional key scene developments',
      informationGain: Number(pick.nov.informationNovelty.toFixed(3)),
      whyInsertedHere: pick.deficitInfo.why,
      coverageNovelty: Number(pick.nov.aggregate.toFixed(3)),
      addedByCoverage: true
    };

    // Insert at logical structural position
    const insertIdx = clamp(pick.deficitInfo.slotIndex, 1, currentBeats.length - 1);
    currentBeats.splice(insertIdx, 0, newBeat);

    additions.push(newBeat);
    usedRanges.push([e.startSec, e.startSec + dur]);
    pool = pool.filter(x => x.id !== e.id);
    current += dur;
  }

  if (!additions.length) {
    return { ...base_result, augmented: false, added: 0,
      reason: 'structural deficit evaluated: no candidate filled a documented structural deficit' };
  }

  return {
    beats: currentBeats, augmented: true, added: additions.length, base,
    after: timelineSeconds(currentBeats), structural, distinctBefore,
    distinctAfter: distinctEventCount(currentBeats), minDistinct, target,
    reason: `augmented ${additions.length} beat(s) filling structural deficits: ${additions.map(a => a.structuralDeficitFilled).join(', ')}`
  };
}

// Editorial quality metrics for a finished (post duration-fit) beat list, for
// persistence + tests + the report. Pure; no side effects.
function computeEditorialMetrics(beats = [], model = {}, config = {}, extra = {}) {
  const byId = new Map((model.events || []).map(e => [e.id, e]));
  const evs = beats.map(b => eventOf(b, byId));
  const meaningfulSeconds = timelineSeconds(beats);
  const min = num(config.targetDurationMinSec, 0);
  const max = num(config.targetDurationMaxSec, 0);
  const distinctEvents = new Set(beats.map(b => b.sourceEventId).filter(Boolean)).size;
  const locations = evs.map(locationKey);
  const distinctLocations = new Set(locations).size;
  const distinctPeople = new Set(evs.flatMap(e => e.peopleIds || [])).size;
  const distinctTypes = new Set(evs.map(e => e.type).filter(Boolean)).size;
  const beatCount = beats.length;

  let maxConsecutiveSameLocation = beatCount ? 1 : 0, run = 1;
  for (let i = 1; i < locations.length; i++) {
    run = locations[i] === locations[i - 1] ? run + 1 : 1;
    if (run > maxConsecutiveSameLocation) maxConsecutiveSameLocation = run;
  }
  // Per-beat novelty against everything before it (retention proxy).
  const noveltyProgression = evs.map((e, i) => Number(noveltyScores(e, evs.slice(0, i)).aggregate.toFixed(3)));
  const avgNovelty = noveltyProgression.length ? noveltyProgression.reduce((a, b) => a + b, 0) / noveltyProgression.length : 0;

  const hookRoles = new Set(['hook', 'cold_open']);
  const hookPresent = beats.length > 0 && hookRoles.has(beats[0].narrativeRole);
  const coverageRatio = min ? Number((meaningfulSeconds / min).toFixed(3)) : null;
  const repetitionScore = beatCount ? Number((1 - distinctLocations / beatCount).toFixed(3)) : 0;
  const distinctEventRatio = beatCount ? Number((distinctEvents / beatCount).toFixed(3)) : 0;

  const flags = [];
  if (min && meaningfulSeconds < STRUCTURAL_RATIO * min) flags.push('below_structural_minimum');
  if (distinctEvents < minDistinctFor(min)) flags.push('too_few_distinct_events');
  if (maxConsecutiveSameLocation >= 3) flags.push('repetitive_same_scene_run');
  if (!hookPresent) flags.push('no_hook_first');
  if (Number.isFinite(extra.extensionRatio) && extra.extensionRatio > 1.0) flags.push('over_extended');

  return {
    meaningfulSeconds: Number(meaningfulSeconds.toFixed(2)), targetMinSec: min, targetMaxSec: max,
    coverageRatio, inRange: min && max ? meaningfulSeconds >= min - EPS && meaningfulSeconds <= max + EPS : null,
    beatCount, distinctEvents, distinctEventRatio, distinctLocations, distinctPeople, distinctTypes,
    maxConsecutiveSameLocation, repetitionScore, avgBeatSec: beatCount ? Number((meaningfulSeconds / beatCount).toFixed(2)) : 0,
    avgNovelty: Number(avgNovelty.toFixed(3)), noveltyProgression, hookPresent,
    addedByCoverage: beats.filter(b => b.addedByCoverage).length,
    addedByDurationFit: beats.filter(b => b.addedByDurationFit).length,
    extensionRatio: Number.isFinite(extra.extensionRatio) ? Number(extra.extensionRatio.toFixed(3)) : null,
    minDistinctTarget: minDistinctFor(min), flags
  };
}

module.exports = {
  augmentCoverage, noveltyScores, computeEditorialMetrics,
  distinctEventCount, minDistinctFor, intrinsicValue, locationKey,
  STRUCTURAL_RATIO, MAX_COVERAGE_BEAT_SEC, MIN_BEAT_SEC, MAX_ADD, MAX_PER_LOCATION
};
