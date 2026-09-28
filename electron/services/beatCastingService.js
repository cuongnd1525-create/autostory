// AutoStory v3 — Phase 7: Beat -> Clip casting by narrative-fit constraint
// satisfaction (NOT a single global weighted sum).
//
// For each story beat, choose the real source event that best PERFORMS the
// beat's narrative function, under hard constraints, with lexicographic
// tie-breaking. De-duplicates by narrative PURPOSE, not just source overlap.
//
// model.events: [{ id, startSec, endSec, type, peopleIds, tension, visualQuality,
//                  novelty, dialogueImpact?, isReveal, audioType?, audioConfidence? }]
// beats:        [{ beatId, narrativeRole, sourceEventId?, requiredPeopleIds?,
//                  tensionBefore?, tensionAfter?, ... }]
//
// Returns beats with a resolved `sourceEventId`, `sourceStartSec/EndSec`,
// `tension`, `audioType/audioConfidence`, `castReason`, and any `unresolved`.

const MIN_VISUAL_QUALITY = 0.20;

// Which event types most naturally satisfy each role (soft prior, top tie-break).
const ROLE_AFFINITY = {
  hook: ['confrontation', 'action', 'reveal', 'reaction'],
  cold_open: ['confrontation', 'action', 'reveal', 'interaction'],
  cold_open_hook: ['confrontation', 'action', 'reveal', 'interaction'],
  setup: ['context', 'dialogue', 'arrival', 'interaction'],
  context: ['context', 'dialogue', 'arrival', 'interaction'],
  crisis_context: ['context', 'confrontation', 'dialogue', 'arrival'],
  escalation: ['confrontation', 'argument', 'action', 'resistance'],
  complication: ['confrontation', 'argument', 'obstacle'],
  contradiction: ['dialogue', 'confrontation', 'argument', 'reveal'],
  reveal: ['reveal', 'discovery', 'evidence'],
  evidence_reveal: ['reveal', 'discovery', 'evidence'],
  reversal: ['reveal', 'twist', 'discovery'],
  confrontation: ['confrontation', 'argument', 'command'],
  pursuit: ['pursuit', 'chase', 'action', 'flight'],
  apprehension: ['arrest', 'apprehension', 'struggle', 'action', 'command'],
  climax: ['confrontation', 'arrest', 'reveal', 'action'],
  payoff: ['payoff', 'reveal', 'resolution', 'outcome'],
  delayed_payoff: ['payoff', 'reveal', 'resolution', 'outcome'],
  cliffhanger: ['confrontation', 'reveal', 'escalation', 'reaction'],
  resolution: ['resolution', 'outcome', 'aftermath'],
  aftermath: ['aftermath', 'reaction', 'consequence', 'explanation'],
  button: ['reaction', 'aftermath', 'outcome']
};

function affinity(role, type) {
  const list = ROLE_AFFINITY[role] || [];
  const idx = list.indexOf(type);
  return idx < 0 ? 0 : (list.length - idx) / list.length; // 1..~0
}

function castBeats(beats = [], model = {}, options = {}) {
  const minQuality = Number.isFinite(options.minVisualQuality) ? options.minVisualQuality : MIN_VISUAL_QUALITY;
  const events = (model.events || []).slice();
  const byId = new Map(events.map(e => [e.id, e]));
  const usedEventIds = new Set();
  const usedPurposes = new Set(); // `${role}:${eventCluster}` — purpose-level dedup

  const cluster = ev => `${Math.round((ev.startSec || 0) / 25)}`; // ~25s bucket for real scene separation

  let lastChosenSec = null;
  let consecutiveSameCluster = 0;
  let lastCluster = null;

  const out = beats.map(beat => {
    // If Gemini Editorial Director explicitly provided the exact EDL timestamps,
    // validate bounds and pass through directly — DO NOT recast or alter.
    if (Number.isFinite(beat.sourceStartSec) && Number.isFinite(beat.sourceEndSec) && beat.sourceEndSec > beat.sourceStartSec) {
      const duration = model.durationSec || 1800;
      const startSec = Math.max(0, Math.min(duration - 0.5, beat.sourceStartSec));
      const endSec = Math.max(startSec + 0.5, Math.min(duration, beat.sourceEndSec));
      let matchingEv = beat.sourceEventId ? byId.get(beat.sourceEventId) : null;
      if (!matchingEv) {
        matchingEv = events.find(e => Number.isFinite(e.startSec) && Number.isFinite(e.endSec) && e.startSec <= endSec && e.endSec >= startSec) || events[0];
      }
      return {
        ...beat,
        sourceEventId: matchingEv ? matchingEv.id : beat.sourceEventId,
        sourceStartSec: startSec,
        sourceEndSec: endSec,
        tension: beat.tensionAfter ?? beat.tension ?? matchingEv?.tension ?? 0.7,
        audioType: matchingEv?.audioType || (beat.audioMode === 'original_audio' ? 'participant_speech' : 'mixed'),
        audioConfidence: Number.isFinite(matchingEv?.audioConfidence) ? matchingEv.audioConfidence : 0.8,
        isReveal: matchingEv?.isReveal === true || beat.narrativeRole === 'micro_payoff' || beat.narrativeRole === 'confrontation',
        castReason: 'editorial director explicit edl lock',
        audioMode: beat.audioMode || 'original_audio',
        chronologyMode: beat.chronologyMode || 'chronological'
      };
    }

    const role = beat.narrativeRole;
    const requiredPeople = Array.isArray(beat.requiredPeopleIds) ? beat.requiredPeopleIds : [];
    const desiredDelta = Number.isFinite(beat.tensionAfter) && Number.isFinite(beat.tensionBefore)
      ? beat.tensionAfter - beat.tensionBefore : null;

    // Hard-constraint candidate pool with graceful fallbacks.
    const filterCandidates = (peopleFilterMode) => {
      return events.filter(ev => {
        if (usedEventIds.has(ev.id)) return false;
        if ((ev.visualQuality ?? 1) < minQuality) return false;

        // People matching: 'strict' = every, 'loose' = some, 'none' = ignore
        if (requiredPeople.length) {
          const evPeople = ev.peopleIds || [];
          if (peopleFilterMode === 'strict' && !requiredPeople.every(p => evPeople.includes(p))) return false;
          if (peopleFilterMode === 'loose' && !requiredPeople.some(p => evPeople.includes(p))) return false;
        }

        const purposeKey = `${role}:${cluster(ev)}`;
        if (usedPurposes.has(purposeKey)) return false;

        // Guard against > 2 consecutive beats in the same 25s cluster (anti-stretch),
        // but ALLOW scene continuity when chronological narrative progression is desired.
        const allowContinuity = options.preferContinuity || beat.chronologyMode === 'chronological';
        if (!allowContinuity && lastCluster && cluster(ev) === lastCluster && consecutiveSameCluster >= 2) return false;

        return true;
      });
    };

    let pool = filterCandidates('strict');
    if (!pool.length && requiredPeople.length) {
      pool = filterCandidates('loose');
    }
    if (!pool.length) {
      pool = filterCandidates('none');
    }

    // Seed the model's own suggestion first if it survives basic constraints.
    const suggested = beat.sourceEventId && byId.get(beat.sourceEventId);
    let chosen = null;
    let castReason = '';

    // Semantic Lock: If the LLM's designed event is still available and viable, keep it to preserve information and semantic purpose.
    if (suggested && !usedEventIds.has(suggested.id) && (suggested.visualQuality ?? 1) >= minQuality) {
      const evPeople = suggested.peopleIds || [];
      const hasPeople = !requiredPeople.length || requiredPeople.some(p => evPeople.includes(p));
      if (hasPeople) {
        chosen = suggested;
        castReason = 'kept model suggestion (semantic lock)';
      }
    }

    if (!chosen) {
      let pool = filterCandidates('strict');
      if (!pool.length && requiredPeople.length) {
        pool = filterCandidates('loose');
      }
      if (!pool.length) {
        pool = filterCandidates('none');
      }

      const candidates = pool.slice();

      if (!candidates.length) {
        return { ...beat, sourceEventId: null, unresolved: true, castReason: 'no eligible source event under constraints' };
      }

      const allowContinuity = options.preferContinuity || beat.chronologyMode === 'chronological';

      // Novelty & Editorial scoring tie-break:
      // 1) narrative-role affinity
      // 2) scene novelty / temporal separation OR chronological proximity
      // 3) tension-delta match
      // 4) dialogue impact
      // 5) healthy duration (prefer 3-12s events over micro-slivers)
      candidates.sort((a, b) => {
        const af = affinity(role, b.type) - affinity(role, a.type);
        if (Math.abs(af) > 1e-9) return af;

        // Temporal ordering: when continuity is enabled, prefer natural forward progression
        if (lastChosenSec !== null) {
          if (allowContinuity) {
            // Forward chronological continuity: prefer events that occur AFTER lastChosenSec within 60s
            const aForward = (a.startSec || 0) >= lastChosenSec;
            const bForward = (b.startSec || 0) >= lastChosenSec;
            if (aForward !== bForward) return aForward ? -1 : 1;
            const distA = Math.abs((a.startSec || 0) - lastChosenSec);
            const distB = Math.abs((b.startSec || 0) - lastChosenSec);
            if (Math.abs(distA - distB) > 5) return distA - distB;
          } else {
            // Distinct scene hopping (legacy)
            const distA = Math.abs((a.startSec || 0) - lastChosenSec);
            const distB = Math.abs((b.startSec || 0) - lastChosenSec);
            const aTooClose = distA < 15;
            const bTooClose = distB < 15;
            if (aTooClose !== bTooClose) return aTooClose ? 1 : -1;
          }
        }

        if (desiredDelta !== null) {
          const da = Math.abs((a.tension ?? 0.5) - clampTarget(beat.tensionBefore, desiredDelta));
          const db = Math.abs((b.tension ?? 0.5) - clampTarget(beat.tensionBefore, desiredDelta));
          if (Math.abs(da - db) > 1e-9) return da - db;
        } else {
          const t = (b.tension ?? 0) - (a.tension ?? 0);
          if (Math.abs(t) > 1e-9) return t;
        }

        const di = (b.dialogueImpact ?? 0) - (a.dialogueImpact ?? 0);
        if (Math.abs(di) > 1e-9) return di;

        const nv = (b.novelty ?? 0) - (a.novelty ?? 0);
        if (Math.abs(nv) > 1e-9) return nv;

        // Prefer usable duration: events >= 3.0s win over micro-cuts
        const durA = dur(a);
        const durB = dur(b);
        const usefulA = durA >= 3.0 ? 1 : 0;
        const usefulB = durB >= 3.0 ? 1 : 0;
        if (usefulA !== usefulB) return usefulB - usefulA;

        return durA - durB;
      });

      chosen = candidates[0];
      castReason = `recast to stronger ${chosen.type || 'event'} for role ${role}`;
    }

    usedEventIds.add(chosen.id);
    const chosenCluster = cluster(chosen);
    usedPurposes.add(`${role}:${chosenCluster}`);

    if (lastCluster === chosenCluster) {
      consecutiveSameCluster++;
    } else {
      consecutiveSameCluster = 1;
      lastCluster = chosenCluster;
    }
    lastChosenSec = chosen.startSec || 0;

    return {
      ...beat,
      sourceEventId: chosen.id,
      sourceStartSec: chosen.startSec,
      sourceEndSec: chosen.endSec,
      tension: chosen.tension ?? beat.tensionAfter ?? 0.5,
      audioType: chosen.audioType || 'uncertain',
      audioConfidence: Number.isFinite(chosen.audioConfidence) ? chosen.audioConfidence : 0,
      isReveal: chosen.isReveal === true,
      castReason: castReason
    };
  });

  return { beats: out, unresolved: out.filter(b => b.unresolved).map(b => b.beatId) };
}

function dur(ev) { return Math.max(0.1, (ev.endSec || 0) - (ev.startSec || 0)); }
function clampTarget(before, delta) {
  const v = Number(before);
  const b = Number.isFinite(v) ? v : 0.5;
  return Math.max(0, Math.min(1, b + delta));
}

module.exports = { castBeats, affinity, MIN_VISUAL_QUALITY };
