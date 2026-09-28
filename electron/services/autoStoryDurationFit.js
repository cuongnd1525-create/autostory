// AutoStory v3 — deterministic Duration Fit (pure, testable).
// Runs AFTER narration + safeWords demotion + narration gates, BEFORE compile.
// Brings a timeline whose total is outside [min,max] back into range without
// regenerating the story: extend/add for TOO SHORT, trim/remove for TOO LONG.
// Bounded to 2 passes; if still impossible, the caller raises a structured
// failure with actual/min/max instead of the generic compiler error.
//
// Timeline seconds = sum of (sourceEndSec - sourceStartSec) per beat
// (playbackSpeed is 1 in v3), which is exactly what compiler.validateDuration measures.

const EPS = 0.25;                 // matches autoStoryTimelineCompiler.validateDuration tolerance
const MIN_BEAT_SEC = 2.0;         // never trim a beat below this
const MAX_GROW_PER_BEAT_SEC = 2.5; // strict continuity guard: never stretch a beat more than 2.5s (prevents visual freeze)

// Roles whose beats must be preserved (never removed, hook never trimmed).
const PROTECTED_ROLES = new Set([
  'hook', 'cold_open', 'cold_open_hook', 'escalation', 'reveal', 'evidence_reveal',
  'reversal', 'confrontation', 'pursuit', 'apprehension', 'climax', 'payoff', 'delayed_payoff', 'cliffhanger'
]);
// Roles that may be dropped entirely if a timeline is far too long.
const REMOVABLE_ROLES = new Set(['setup', 'context', 'complication', 'aftermath', 'button']);

function len(b) { return Math.max(0, (Number(b.sourceEndSec) || 0) - (Number(b.sourceStartSec) || 0)); }
function timelineSeconds(beats) { return (beats || []).reduce((n, b) => n + len(b), 0); }

// Editorial value of a beat: original-audio / strong dialogue / tension win.
function beatValue(b) {
  const originalBonus = (b.audioStrategy === 'original' || b.speaks === false) ? 0.4 : 0;
  const cleanBonus = (b.audioType === 'participant_speech' || b.audioType === 'officer_speech') ? 0.3 : 0;
  return originalBonus + cleanBonus + (Number(b.tension) || 0) + (Number(b.dialogueImpact) || 0) * 0.5 + (Number(b.audioConfidence) || 0) * 0.2;
}

const STRUCTURAL_DEFICIT_RATIO = 0.70; // below 70% is a story under-casting problem, not a minor duration tweak

// TOO SHORT (1/2): grow high-value beats into free adjacent source, with strict 15% ceiling per beat.
function extendShort(beats, deficit, sourceDuration, maxGrow = MAX_GROW_PER_BEAT_SEC) {
  let need = deficit;
  const order = beats.map((b, i) => ({ i, v: beatValue(b) })).sort((a, b) => b.v - a.v);
  for (const { i } of order) {
    if (need <= EPS) break;
    const b = beats[i];
    const bLen = len(b);
    // Strict extension cap: at most 15% of clip duration or maxGrow
    const beatCap = Math.max(0.5, Math.min(maxGrow, bLen * 0.15));

    const others = beats.filter((_, j) => j !== i);
    const nextStart = Math.min(sourceDuration, ...others.filter(o => o.sourceStartSec >= b.sourceEndSec).map(o => o.sourceStartSec), sourceDuration);
    const prevEnd = Math.max(0, ...others.filter(o => o.sourceEndSec <= b.sourceStartSec).map(o => o.sourceEndSec), 0);
    let grown = 0;
    let growEnd = Math.max(0, Math.min(need, beatCap - grown, nextStart - b.sourceEndSec));
    b.sourceEndSec += growEnd; need -= growEnd; grown += growEnd;
    let growStart = Math.max(0, Math.min(need, beatCap - grown, b.sourceStartSec - prevEnd));
    b.sourceStartSec -= growStart; need -= growStart; grown += growStart;
  }
  return need;
}

// TOO SHORT (3): add unused source events that support the spine, preserving chronological flow.
function addUnusedEvents(beats, model, need, max, maxEvents = 4) {
  const usedIds = new Set(beats.map(b => b.sourceEventId).filter(Boolean));
  const usedRanges = beats.map(b => [b.sourceStartSec, b.sourceEndSec]);
  const overlaps = (s, e) => usedRanges.some(([a, b]) => s < b && e > a);
  const candidates = (model.events || [])
    .filter(e => !usedIds.has(e.id) && Number.isFinite(e.startSec) && Number.isFinite(e.endSec)
      && (e.endSec - e.startSec) >= MIN_BEAT_SEC && !overlaps(e.startSec, e.endSec))
    .map(e => ({
      e,
      v: (Number(e.tension) || 0) + (Number(e.dialogueImpact) || 0) * 0.5 + (Number(e.visualQuality) || 0) * 0.3 + (Number(e.novelty) || 0) * 0.4
    }))
    .sort((a, b) => b.v - a.v);

  let added = 0;
  for (const { e } of candidates) {
    if (need <= EPS || added >= maxEvents) break;
    const room = max + EPS - timelineSeconds(beats);
    if (room < MIN_BEAT_SEC) break;
    const wanted = Math.min(e.endSec - e.startSec, Math.max(need, MIN_BEAT_SEC), room);
    const role = e.isReveal ? 'reveal' : (e.tension >= 0.7 ? 'escalation' : 'context');
    const beat = {
      beatId: `fit_${e.id}`, narrativeRole: role, sourceEventId: e.id,
      sourceStartSec: e.startSec, sourceEndSec: e.startSec + wanted,
      audioStrategy: 'original', speaks: false, narratorText: '', previewVi: '',
      audioType: e.audioType || 'uncertain', audioConfidence: Number(e.audioConfidence) || 0,
      tension: Number(e.tension) || 0, dialogueImpact: Number(e.dialogueImpact) || 0, addedByDurationFit: true
    };

    // Find chronological insertion point between hook (first) and payoff (last)
    let insertIdx = beats.length - 1;
    for (let i = 1; i < beats.length; i++) {
      if (beats[i].sourceStartSec > beat.sourceStartSec) {
        insertIdx = i;
        break;
      }
    }
    beats.splice(Math.max(1, insertIdx), 0, beat);
    usedRanges.push([beat.sourceStartSec, beat.sourceEndSec]);
    usedIds.add(e.id);
    need -= wanted;
    added++;
  }
  return need;
}

// TOO LONG (1/2): trim low-value lead-in/tail. Protected roles (hook,
// escalation, reveal/payoff, confrontation, apprehension...) are preserved;
// only removable setup/context/aftermath-style beats are trimmed.
function trimLong(beats, excess) {
  let over = excess;
  const order = beats.map((b, i) => ({ i, v: beatValue(b) })).sort((a, b) => a.v - b.v); // lowest value first
  for (const { i } of order) {
    if (over <= EPS) break;
    const b = beats[i];
    if (PROTECTED_ROLES.has(b.narrativeRole)) continue; // never trim hook/escalation/reveal/payoff/...
    const canTrim = Math.max(0, len(b) - MIN_BEAT_SEC);
    const trim = Math.min(over, canTrim);
    b.sourceEndSec -= trim; over -= trim; // trim the (low-value) tail
  }
  return over;
}

// TOO LONG (3): drop the single weakest optional beat, preserving structure.
function removeWeakest(beats) {
  let idx = -1, best = Infinity;
  const pick = predicate => {
    for (let i = 1; i < beats.length - 1; i++) {
      const b = beats[i];
      if (!predicate(b)) continue;
      const v = beatValue(b);
      if (v < best) { best = v; idx = i; }
    }
  };
  pick(b => REMOVABLE_ROLES.has(b.narrativeRole) && !b.speaks);
  if (idx === -1) pick(b => REMOVABLE_ROLES.has(b.narrativeRole)); // then allow narration beats
  if (idx >= 0) return beats.splice(idx, 1)[0];
  return null;
}

function planDurationFit(beats, { config, sourceDuration = Infinity, model = {} } = {}) {
  const min = config.targetDurationMinSec, max = config.targetDurationMaxSec;
  const inRange = d => d >= min - EPS && d <= max + EPS;
  const current = (beats || []).map(b => ({ ...b }));
  const actualBefore = timelineSeconds(current);
  const operations = [];

  const isStructuralDeficit = actualBefore < (min * STRUCTURAL_DEFICIT_RATIO);
  const hasEdlLock = current.some(b => b.castReason === 'editorial director explicit edl lock');

  // Guardrail: When Gemini Editorial Director owns the timeline,
  // accept EDL within +/- 10s of target bounds without forcing additions or removals.
  if (hasEdlLock && actualBefore >= min - 10 && actualBefore <= max + 10) {
    return {
      beats: current, actualBefore, actualAfter: actualBefore, min, max,
      fitted: true, impossible: false, changed: false, passes: 0, operations,
      structuralDeficit: false, undercast: false, extensionRatio: 0
    };
  }

  if (inRange(actualBefore)) {
    return {
      beats: current, actualBefore, actualAfter: actualBefore, min, max,
      fitted: true, impossible: false, changed: false, passes: 0, operations,
      structuralDeficit: false, undercast: false, extensionRatio: 0
    };
  }

  let passes = 0;
  for (; passes < 2; passes++) {
    const d = timelineSeconds(current);
    if (inRange(d)) break;

    if (d < min - EPS) {
      const need = min - d;

      // In Editorial Director mode, NEVER inject arbitrary events. Only gently extend if needed.
      if (hasEdlLock) {
        const rem = extendShort(current, need, sourceDuration, 1.0);
        operations.push({ op: 'extend_edl', requested: round(need), remaining: round(rem) });
      } else if (isStructuralDeficit && model.events && model.events.length) {
        const remEvents = addUnusedEvents(current, model, need, max, 5);
        operations.push({ op: 'addEvents', requested: round(need), remaining: round(remEvents) });
        const curAfterAdd = timelineSeconds(current);
        if (inRange(curAfterAdd)) break;
        const remNeed = Math.max(0, min - curAfterAdd);
        if (remNeed > EPS) {
          const remExt = extendShort(current, remNeed, sourceDuration, 2.5);
          operations.push({ op: 'extend', requested: round(remNeed), remaining: round(remExt) });
        }
      } else {
        const rem = extendShort(current, need, sourceDuration);
        operations.push({ op: 'extend', requested: round(need), remaining: round(rem) });
        if (rem > EPS && model.events) {
          const rem2 = addUnusedEvents(current, model, rem, max, 3);
          operations.push({ op: 'addEvents', remaining: round(rem2) });
        }
      }
    } else {
      const excess = d - max;
      let rem = trimLong(current, excess);
      operations.push({ op: 'trim', requested: round(excess), remaining: round(rem) });
      while (rem > EPS) {
        const removed = removeWeakest(current);
        if (!removed) break;
        operations.push({ op: 'removeBeat', beatId: removed.beatId });
        rem = Math.max(0, timelineSeconds(current) - max);
      }
    }
  }

  const actualAfter = timelineSeconds(current);
  const fitted = inRange(actualAfter);
  const extensionRatio = actualBefore > 0 ? (actualAfter - actualBefore) / actualBefore : 0;

  return {
    beats: current, actualBefore, actualAfter, min, max,
    fitted, impossible: !fitted, changed: true, passes, operations,
    structuralDeficit: isStructuralDeficit,
    undercast: isStructuralDeficit || extensionRatio > 1.5,
    extensionRatio: round(extensionRatio)
  };
}

function round(n) { return Math.round(n * 10) / 10; }

module.exports = {
  planDurationFit, timelineSeconds, beatValue, extendShort, trimLong, removeWeakest, addUnusedEvents,
  EPS, MIN_BEAT_SEC, MAX_GROW_PER_BEAT_SEC, STRUCTURAL_DEFICIT_RATIO, PROTECTED_ROLES, REMOVABLE_ROLES
};
