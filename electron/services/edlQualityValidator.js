'use strict';

/**
 * AutoStory V3 — EDL Quality Validator
 *
 * Pure validation guardrail that evaluates an Edit Decision List (EDL) / Story Spine
 * for retention quality, pacing, overlap, and narrative coherence.
 *
 * CRITICAL DIRECTIVE:
 * This module is a pure VALIDATOR / GUARDRAIL. It NEVER modifies, edits, reorders,
 * or pads beats. If an EDL violates quality constraints, this module rejects it
 * and returns precise violation messages so Gemini Editorial Director can perform
 * a single targeted AI repair pass.
 */

const VALID_RETENTION_REASONS = new Set([
  'new_fact',
  'contradiction',
  'reaction',
  'escalation',
  'visual_reveal',
  'strong_quote',
  'new_question',
  'partial_payoff'
]);

/**
 * Merge an array of [start, end] ranges into disjoint sorted intervals.
 */
function mergeIntervals(ranges = []) {
  if (!ranges.length) return [];
  const sorted = ranges
    .filter(r => Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] > r[0])
    .map(r => [r[0], r[1]])
    .sort((a, b) => a[0] - b[0]);
  
  if (!sorted.length) return [];

  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const prev = merged[merged.length - 1];
    if (cur[0] <= prev[1] + 1e-4) {
      prev[1] = Math.max(prev[1], cur[1]);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

/**
 * Compute the total overlapping duration in seconds between two sets of intervals.
 */
function computeIntervalOverlap(intervalsA = [], intervalsB = []) {
  const mergedA = mergeIntervals(intervalsA);
  const mergedB = mergeIntervals(intervalsB);

  let overlapSec = 0;
  let i = 0;
  let j = 0;

  while (i < mergedA.length && j < mergedB.length) {
    const [startA, endA] = mergedA[i];
    const [startB, endB] = mergedB[j];

    const maxStart = Math.max(startA, startB);
    const minEnd = Math.min(endA, endB);

    if (maxStart < minEnd) {
      overlapSec += (minEnd - maxStart);
    }

    if (endA < endB) {
      i++;
    } else {
      j++;
    }
  }

  return overlapSec;
}

/**
 * Calculate total duration of an array of disjoint intervals.
 */
function totalIntervalDuration(intervals = []) {
  return intervals.reduce((sum, [start, end]) => sum + Math.max(0, end - start), 0);
}

/**
 * Deduce visual state cluster for a beat.
 */
function deduceVisualStateCluster(beat = {}) {
  if (beat.visualStateCluster) return String(beat.visualStateCluster).toLowerCase().trim();

  const start = Number(beat.sourceStartSec) || 0;
  const end = Number(beat.sourceEndSec) || 0;
  const text = `${beat.newInformation || ''} ${beat.informationRevealed || ''} ${beat.viewerStateBefore || ''} ${beat.viewerStateAfter || ''} ${beat.viewerQuestion || ''} ${beat.subject || ''} ${beat.location || ''} ${beat.visualDescription || ''}`.toLowerCase();

  // If beat explicitly provides subject and location
  if (beat.subject && beat.location) {
    return `${String(beat.subject).toLowerCase().trim()}_${String(beat.location).toLowerCase().trim()}`;
  }

  // 1. Foot pursuit / Kinetic chase
  if (text.includes('foot pursuit') || text.includes('foot chase') || text.includes('sprint') || text.includes('fleeing') || text.includes('bolts into') || text.includes('all-out sprint')) {
    if (text.includes('fence') || text.includes('vault') || text.includes('backyard')) return 'pursuit_fence_barrier';
    if (text.includes('shed') || text.includes('backpack') || text.includes('discard')) return 'pursuit_evidence_discard';
    if (text.includes('culvert') || text.includes('ditch') || text.includes('drainage') || text.includes('muddy')) {
      if (text.includes('tackle') || text.includes('slip') || text.includes('struggle')) return 'pursuit_culvert_tackle';
      return 'pursuit_culvert_chase';
    }
    return 'foot_pursuit_active';
  }

  // 2. Traffic stop / Vehicle interactions
  if (text.includes('traffic stop') || text.includes('patrol car') || text.includes('pulled over') || text.includes('sedan') || text.includes('driver window') || text.includes('steering wheel') || text.includes('passenger seat') || text.includes('glove box') || text.includes('hood')) {
    if (text.includes('patrol lights') || text.includes('cruiser skids') || text.includes('spotlight') || text.includes('hesitates')) return 'patrol_vehicle_lighting';
    if (text.includes('window') || text.includes('trembling') || text.includes('license') || text.includes('fake name')) return 'traffic_driver_window';
    if (text.includes('passenger') || text.includes('jacket') || text.includes('concealed')) return 'traffic_passenger_side';
    if (text.includes('steering wheel') || text.includes('taser') || text.includes('laser')) return 'traffic_taser_standoff';
    if (text.includes('hood') || text.includes('kicks door') || text.includes('surrender')) return 'traffic_exterior_takedown';
    return 'vehicle_interaction';
  }

  // 3. Burglary / Safecracking / Commercial facility
  if (text.includes('safe') || text.includes('warehouse') || text.includes('facility') || text.includes('bolt cutters') || text.includes('rfid') || text.includes('hostage')) {
    if (text.includes('aisle') || text.includes('boot print') || text.includes('executive suite')) return 'facility_aisle_sweep';
    if (text.includes('alarm') || text.includes('perimeter') || text.includes('padlock') || text.includes('bolt cutter')) return 'facility_perimeter_breach';
    if (text.includes('safe') || text.includes('accounts room') || text.includes('combination')) return 'facility_safe_standoff';
    if (text.includes('gloves') || text.includes('thermal') || text.includes('rfid') || text.includes('card')) return 'facility_forensic_evidence';
    if (text.includes('cash') || text.includes('gym bag') || text.includes('stacks')) return 'facility_loot_recovery';
    return 'facility_burglary_scene';
  }

  // 4. Hit-and-run / Street Deception
  if (text.includes('hit-and-run') || text.includes('collision') || text.includes('terrier') || text.includes('dog') || text.includes('windshield') || text.includes('key fob') || text.includes('panic button')) {
    if (text.includes('collision') || text.includes('crash site') || text.includes('paint chips')) return 'crash_scene_inspection';
    if (text.includes('dog') || text.includes('terrier') || text.includes('alibi') || text.includes('walking alone')) return 'pedestrian_alibi_interview';
    if (text.includes('boots') || text.includes('knuckles') || text.includes('cuts') || text.includes('glass')) return 'pedestrian_physical_evidence';
    if (text.includes('key fob') || text.includes('panic button') || text.includes('alarm horn')) return 'vehicle_key_fob_test';
    return 'street_deception_scene';
  }

  // 5. Residence / interior interactions — generic location/action vocabulary only.
  // (No person names, no incident-specific wording, no source timestamps.)
  if (start >= 0 && (beat.chronologyMode === 'rewind' || beat.narrativeRole === 'rewind_context') && (text.includes('dispatch') || text.includes('arrive') || text.includes('call'))) {
    return 'responder_arrival';
  }
  if (text.includes('outside') || text.includes('street') || text.includes('sidewalk') || text.includes('curb')) {
    return 'outside_scene';
  }
  if (text.includes('front door') || text.includes('porch') || text.includes('entrance')) {
    if (text.includes('talking') || text.includes('defend') || text.includes('excuse') || text.includes('deny') || text.includes('explain')) {
      return 'entrance_subject_talking';
    }
    return 'entrance_interaction';
  }
  if (text.includes('stairs') || text.includes('staircase') || text.includes('upstairs')) {
    return 'staircase_movement';
  }
  if (text.includes('pinning') || text.includes('holding down') || text.includes('pinned')) {
    return 'interior_restraint_intervention';
  }
  if (text.includes('hallway') || text.includes('corridor')) {
    return 'hallway_separation';
  }

  // Physical restraint / Handcuffing / Search across any incident
  if (text.includes('double lock')) {
    return 'officer_double_lock_action';
  }
  if (text.includes('handcuff') || text.includes('cuff') || text.includes('restrain')) {
    return 'officer_handcuffs_action';
  }

  // Evidence / Injury / Contradiction reveal
  if (text.includes('wrist') || text.includes('marks') || text.includes('bruise') || text.includes('injury') || text.includes('wound')) {
    return 'physical_evidence_inspection';
  }
  if (text.includes('weapon') || text.includes('glock') || text.includes('gun') || text.includes('knife') || text.includes('contraband') || text.includes('drugs') || text.includes('stolen')) {
    return 'weapon_contraband_discovery';
  }
  if (text.includes('punch') || text.includes('battery') || text.includes('escort')) {
    return 'custody_escort';
  }

  // Fallback to subject/location
  const subject = beat.subject || (text.includes('driver') ? 'driver' : text.includes('suspect') ? 'suspect' : text.includes('victim') ? 'victim' : text.includes('witness') ? 'witness' : text.includes('officer') ? 'officer' : 'scene');
  const loc = beat.location || (text.includes('car') ? 'car' : text.includes('hallway') ? 'hallway' : text.includes('street') ? 'street' : 'general');
  return `${subject}_${loc}`;
}

/**
 * Deduce semantic function for a beat.
 */
function deduceSemanticFunction(beat = {}) {
  if (beat.semanticFunction) return String(beat.semanticFunction).toLowerCase().trim();
  const text = `${beat.newInformation || ''} ${beat.informationRevealed || ''} ${beat.retentionReason || ''} ${beat.narrativeRole || ''}`.toLowerCase();

  if (text.includes('deny') || text.includes('denies') || text.includes('excuse') || text.includes('defense') || text.includes('abuse our children') || text.includes('family discussion') || text.includes('rules of the house') || text.includes('dui') || text.includes('lashing out') || text.includes('tried to run away') || text.includes('not mine') || text.includes('did not do it') || text.includes('just walking')) {
    return 'suspect_defense_excuse';
  }
  if (text.includes('wrist') || text.includes('punch') || text.includes('hit') || text.includes('marks') || text.includes('bruise') || text.includes('physical') || text.includes('batter') || text.includes('weapon') || text.includes('gun') || text.includes('knife') || text.includes('contraband') || text.includes('drugs') || text.includes('stolen')) {
    return 'physical_evidence_revelation';
  }
  if (text.includes('handcuff') || text.includes('order') || text.includes('interven') || text.includes('double lock') || text.includes('taser') || text.includes('tackle') || text.includes('patdown') || text.includes('search')) {
    return 'officer_physical_action';
  }
  if (text.includes('chase') || text.includes('sprint') || text.includes('flee') || text.includes('pursuit')) {
    return 'kinetic_pursuit_action';
  }
  return beat.narrativeRole || 'narrative_progression';
}

/**
 * Compute the 6-dimension Structural Viral Score (0 - 10.0) for an EDL / Story Spine.
 * 
 * Dimensions:
 * 1. Hook / Open Question (0 - 2.0)
 * 2. Causal Story Progression (0 - 2.0)
 * 3. Information / Evidence Escalation (0 - 2.0)
 * 4. Retention Pulse Density (0 - 1.5)
 * 5. Payoff / Cliffhanger Timing (0 - 1.5)
 * 6. Temporal / Context Coherence (0 - 1.0)
 * Total Max = 10.0
 * 
 * Hard Caps (Capped at 7.0 if any triggered):
 * - EARLY_PAYOFF_SPOILER
 * - VIEWER_STATE_PLATEAU
 * - UNEXPLAINED_TIME_JUMP
 * - DISAPPEARING_MAIN_LOOP
 * - NO_PAYOFF_OR_CLIFFHANGER
 * - DURATION_PADDING
 * - SEMANTIC_REDUNDANCY
 */
function computeStructuralViralScore(spine = {}, options = {}) {
  const beats = Array.isArray(spine.beats) ? spine.beats : [];
  const hardCaps = [];
  const deductions = [];

  const addDeduction = (dimension, deduction, beatId, reason) => {
    deductions.push({ dimension, deduction: Number(deduction.toFixed(2)), beatId: beatId || null, reason });
  };

  if (!beats.length) {
    return {
      score: 0,
      rawScore: 0,
      passed: false,
      dimensions: {
        hookOpenQuestion: { score: 0, max: 2.0, details: 'No beats' },
        causalProgression: { score: 0, max: 2.0, details: 'No beats' },
        informationEvidenceEscalation: { score: 0, max: 2.0, details: 'No beats' },
        retentionPulseDensity: { score: 0, max: 1.5, details: 'No beats' },
        payoffCliffhangerTiming: { score: 0, max: 1.5, details: 'No beats' },
        temporalContextCoherence: { score: 0, max: 1.0, details: 'No beats' }
      },
      hardCaps: ['EMPTY_SPINE'],
      deductions: [{ dimension: 'all', deduction: 10.0, beatId: null, reason: 'EDL contains no beats' }]
    };
  }

  // 1. Hook / Open Question (Max 2.0)
  let hookScore = 2.0;
  const centralQ = String(spine.centralViewerQuestion || spine.storyScope?.centralViewerQuestion || '').trim();
  if (!centralQ || centralQ.length < 10) {
    hookScore -= 0.6;
    addDeduction('hookOpenQuestion', 0.6, null, 'Missing or vague centralViewerQuestion (< 10 chars). Must state clear core mystery/conflict.');
  }

  const firstRewindIdx = beats.findIndex(b => b.chronologyMode === 'rewind');
  let teaserBeats = [];
  if (firstRewindIdx > 0) {
    teaserBeats = beats.slice(0, firstRewindIdx);
  } else {
    teaserBeats = beats.filter(b => b.chronologyMode === 'teaser');
  }

  const teaserDuration = teaserBeats.reduce((sum, b) => sum + Math.max(0, Number(b.sourceEndSec) - Number(b.sourceStartSec)), 0);

  if (teaserBeats.length > 0) {
    if (teaserDuration > 14.0) {
      hookScore -= 0.5;
      addDeduction('hookOpenQuestion', 0.5, teaserBeats[0]?.beatId, `Teaser duration is overlong (${teaserDuration.toFixed(1)}s > 14s).`);
    }
    const overlongPayoffBeat = teaserBeats.find(b => {
      const dur = Math.max(0, Number(b.sourceEndSec) - Number(b.sourceStartSec));
      return (b.narrativeRole === 'micro_payoff' || b.isReveal === true) && dur > 4.5;
    });
    if (overlongPayoffBeat) {
      hookScore -= 0.5;
      addDeduction('hookOpenQuestion', 0.5, overlongPayoffBeat.beatId, `Teaser beat '${overlongPayoffBeat.beatId}' nearly completes payoff before rewind.`);
    }

    const teaserText = teaserBeats.map(b => `${b.newInformation || ''} ${b.informationRevealed || ''}`).join(' ').toLowerCase();
    if (/arrest booking|jail transport|sentenced|verdict|final sentencing/i.test(teaserText)) {
      hookScore -= 1.0;
      hardCaps.push('EARLY_PAYOFF_SPOILER');
      addDeduction('hookOpenQuestion', 1.0, teaserBeats[0]?.beatId, 'Teaser prematurely spoils final arrest/verdict outcome.');
    }
  } else {
    const openingDuration = beats.slice(0, 2).reduce((sum, b) => sum + Math.max(0, Number(b.sourceEndSec) - Number(b.sourceStartSec)), 0);
    const openingText = beats.slice(0, 2).map(b => `${b.newInformation || ''} ${b.retentionReason || ''} ${b.narrativeRole || ''}`).join(' ').toLowerCase();
    const hasImmediateHook = /escalat|tension|suspicio|conflict|refus|nervous|struggle|pulled over|weapon|chase|flag|alert|danger|gun|taser/i.test(openingText);
    if (!hasImmediateHook && openingDuration > 15.0) {
      hookScore -= 0.4;
      addDeduction('hookOpenQuestion', 0.4, beats[0]?.beatId, 'Opening lacks immediate conflict, escalation, or high-stakes curiosity hook within first 15s.');
    }
  }

  const hasOpenLoop = Boolean(
    spine.centralViewerQuestion ||
    spine.storyScope?.centralViewerQuestion ||
    spine.storyScope?.mainOpenLoop ||
    (Array.isArray(spine.openLoops) && spine.openLoops.length > 0) ||
    beats.some(b => b.openLoopCreated || b.viewerQuestionBefore || b.viewerQuestion)
  );
  if (!hasOpenLoop) {
    hookScore -= 0.3;
    addDeduction('hookOpenQuestion', 0.3, null, 'No explicit main open loop or viewer curiosity question defined.');
  }
  hookScore = Math.max(0, Math.min(2.0, hookScore));

  // 2. Causal Story Progression (Max 2.0)
  let causalScore = 2.0;
  let unlinkedBeatsCount = 0;
  const postTeaserBeats = beats.filter(b => b.chronologyMode !== 'teaser');
  const targetCheckBeats = postTeaserBeats.length > 1 ? postTeaserBeats.slice(1) : beats.slice(1);

  for (const b of targetCheckBeats) {
    const hasExplicitCausal = b.causalParentBeat || b.causalRelation || b.whyThisBeatNow;
    const hasStoryLink = b.retentionReason && ['reaction', 'escalation', 'contradiction', 'new_fact', 'visual_reveal', 'strong_quote', 'partial_payoff'].includes(b.retentionReason);
    if (!hasExplicitCausal && !hasStoryLink) {
      unlinkedBeatsCount++;
    }
  }

  if (targetCheckBeats.length > 0 && (unlinkedBeatsCount / targetCheckBeats.length) > 0.3) {
    causalScore -= 0.5;
    addDeduction('causalProgression', 0.5, null, `${unlinkedBeatsCount} beats lack clear causal parent, relation, or narrative necessity.`);
  }

  let unanchoredBackwardJumps = 0;
  for (let i = 1; i < beats.length; i++) {
    const prev = beats[i - 1];
    const curr = beats[i];
    const prevEnd = Number(prev.sourceEndSec);
    const currStart = Number(curr.sourceStartSec);
    if (currStart < prevEnd - 2.0) {
      const mode = curr.chronologyMode || 'chronological';
      const isAnchored = mode === 'rewind' || mode === 'callback' || mode === 'teaser';
      if (!isAnchored) {
        unanchoredBackwardJumps++;
      }
    }
  }

  if (unanchoredBackwardJumps > 0) {
    causalScore -= 0.8;
    hardCaps.push('UNEXPLAINED_TIME_JUMP');
    addDeduction('causalProgression', 0.8, null, `${unanchoredBackwardJumps} unanchored backward jump(s) broke causal chronological forward motion.`);
  }
  causalScore = Math.max(0, Math.min(2.0, causalScore));

  // 3. Information / Evidence Escalation (Max 2.0)
  let infoScore = 2.0;
  let deadBeatCount = 0;
  let highNoveltyCount = 0;

  for (const b of beats) {
    const info = String(b.newInformation || b.informationRevealed || '').trim();
    if (!info || info.length < 5) {
      deadBeatCount++;
    }
    const rReason = b.retentionReason || '';
    if (['new_fact', 'contradiction', 'visual_reveal', 'escalation', 'strong_quote', 'partial_payoff'].includes(rReason)) {
      highNoveltyCount++;
    }
  }

  if (deadBeatCount > 0) {
    const ded = Math.min(1.2, deadBeatCount * 0.4);
    infoScore -= ded;
    addDeduction('informationEvidenceEscalation', ded, null, `${deadBeatCount} beat(s) deliver no new information (dead narrative).`);
  }

  const noveltyRatio = beats.length > 0 ? (highNoveltyCount / beats.length) : 0;
  if (noveltyRatio < 0.5) {
    infoScore -= 0.5;
    addDeduction('informationEvidenceEscalation', 0.5, null, `High novelty ratio is low (${(noveltyRatio * 100).toFixed(0)}% < 50%). Information ladder stagnates.`);
  }

  const evidenceBeats = beats.filter(b => b.evidenceType || b.retentionReason === 'visual_reveal' || b.retentionReason === 'contradiction');
  if (beats.length >= 8 && evidenceBeats.length === 0) {
    infoScore -= 0.3;
    addDeduction('informationEvidenceEscalation', 0.3, null, 'Story lacks concrete evidence, contradiction, or physical reveal moments.');
  }
  infoScore = Math.max(0, Math.min(2.0, infoScore));

  // 4. Retention Pulse Density (Max 1.5)
  let pulseScore = 1.5;
  let macroBeatCount = 0;
  let totalDur = 0;

  for (const b of beats) {
    const dur = Math.max(0, Number(b.sourceEndSec) - Number(b.sourceStartSec));
    totalDur += dur;
    if (dur > 10.0) {
      macroBeatCount++;
    }
  }

  if (macroBeatCount > 0) {
    const ded = Math.min(0.8, macroBeatCount * 0.4);
    pulseScore -= ded;
    addDeduction('retentionPulseDensity', ded, null, `${macroBeatCount} beat(s) exceed 10.0s (undifferentiated macro beats).`);
  }

  const avgDur = beats.length > 0 ? (totalDur / beats.length) : 0;
  if (avgDur > 8.0) {
    pulseScore -= 0.3;
    addDeduction('retentionPulseDensity', 0.3, null, `Average micro-beat duration (${avgDur.toFixed(1)}s) is too slow for viral pacing (> 8.0s).`);
  }

  const maxVisualRunSec = options.metrics?.sameVisualStateRunSec ?? 0;
  if (maxVisualRunSec > 12.0) {
    pulseScore -= 0.5;
    addDeduction('retentionPulseDensity', 0.5, null, `Visual state run exceeds 12.0s (${maxVisualRunSec.toFixed(1)}s) without visual novelty.`);
  }

  const staticSpeakerPlateauCount = options.metrics?.staticSpeakerPlateauCount ?? 0;
  if (staticSpeakerPlateauCount > 0) {
    pulseScore -= 0.6;
    hardCaps.push('VIEWER_STATE_PLATEAU');
    addDeduction('retentionPulseDensity', 0.6, null, `Static speaker plateau detected (${staticSpeakerPlateauCount} times).`);
  }

  const semanticRepetitionRun = options.metrics?.semanticRepetitionRun ?? 0;
  if (semanticRepetitionRun > 2) {
    pulseScore -= 0.5;
    hardCaps.push('SEMANTIC_REDUNDANCY');
    addDeduction('retentionPulseDensity', 0.5, null, `Suspect excuses/defense repeated ${semanticRepetitionRun} times consecutively.`);
  }
  pulseScore = Math.max(0, Math.min(1.5, pulseScore));

  // 5. Payoff / Cliffhanger Timing (Max 1.5)
  let payoffScore = 1.5;
  const cliffhangerBeat = beats.find(b => b.narrativeRole === 'cliffhanger') || beats[beats.length - 1];

  if (!cliffhangerBeat) {
    payoffScore -= 1.0;
    hardCaps.push('NO_PAYOFF_OR_CLIFFHANGER');
    addDeduction('payoffCliffhangerTiming', 1.0, null, 'Story lacks cliffhanger or meaningful resolution/payoff beat.');
  } else {
    const q = String(cliffhangerBeat.cliffhangerQuestion || cliffhangerBeat.viewerQuestion || cliffhangerBeat.openLoop || '').trim();
    const info = String(cliffhangerBeat.cliffhangerNewInformation || cliffhangerBeat.newInformation || cliffhangerBeat.informationRevealed || '').trim();
    const payoff = String(cliffhangerBeat.cliffhangerExpectedNextPayoff || '').trim();
    const timing = cliffhangerBeat.payoffTiming;

    const hasExplicitFlag = Boolean(cliffhangerBeat.cliffhangerSpecificFact || cliffhangerBeat.specificNewFact);
    const specificFactText = `${typeof cliffhangerBeat.cliffhangerSpecificFact === 'string' ? cliffhangerBeat.cliffhangerSpecificFact : ''} ${typeof cliffhangerBeat.specificNewFact === 'string' ? cliffhangerBeat.specificNewFact : ''} ${cliffhangerBeat.newInformation || ''} ${info}`.toLowerCase();
    const hasSpecificFact = hasExplicitFlag ||
      /punch|hit|grab|wrist|mark|bruise|batter|assault|handcuff|cuff|lock|weapon|gun|shot|gunshot|bullet|wound|knife|taser|flee|run|contraband|drugs|pocket|search|admit|confess|injur|refus|bail|ledger|text|conspir|warrant|stolen/i.test(specificFactText);

    let consequenceMagnitude = cliffhangerBeat.consequenceMagnitude || 'none';
    if (consequenceMagnitude === 'none') {
      if (/arrest|cuff|custody|jail|charge|felony|unlawful|prosecut/i.test(`${q} ${info} ${payoff}`)) {
        consequenceMagnitude = 'charges';
      } else if (/punch|hit|physical|violence|attack|batter|gun|shot|gunshot|bullet|wound|knife|weapon|taser/i.test(`${q} ${info} ${payoff}`)) {
        consequenceMagnitude = 'violence';
      } else if (/mark|wrist|bruise|evidence|contraband|drugs|search|cash|loot/i.test(`${q} ${info} ${payoff}`)) {
        consequenceMagnitude = 'evidence_found';
      } else if (/admit|confess|slip-up|concede/i.test(`${q} ${info} ${payoff}`)) {
        consequenceMagnitude = 'confession';
      }
    }

    if (!hasSpecificFact) {
      payoffScore -= 0.4;
      addDeduction('payoffCliffhangerTiming', 0.4, cliffhangerBeat.beatId, 'Cliffhanger/ending lacks specific concrete newly revealed fact.');
    }

    if (consequenceMagnitude === 'none') {
      payoffScore -= 0.4;
      addDeduction('payoffCliffhangerTiming', 0.4, cliffhangerBeat.beatId, 'Cliffhanger lacks significant consequence magnitude (charges, violence, evidence, confession).');
    }

    const hasNextSetup = payoff.length >= 6 || timing === 'part_2' || timing === 'delayed' || cliffhangerBeat.isPart2Setup === true;
    if (!hasNextSetup && cliffhangerBeat.narrativeRole !== 'full_payoff') {
      payoffScore -= 0.3;
      addDeduction('payoffCliffhangerTiming', 0.3, cliffhangerBeat.beatId, 'Cliffhanger missing Part 2 payoff setup or unresolved forward question.');
    }

    const combinedEndingText = `${q} ${info} ${cliffhangerBeat.informationRevealed || ''}`.toLowerCase();
    if (/transport|patrol car arrest|jail booking|sentenced|sentencing|final verdict/i.test(combinedEndingText) && (timing === 'part_2' || cliffhangerBeat.narrativeRole === 'cliffhanger')) {
      payoffScore -= 0.6;
      hardCaps.push('EARLY_PAYOFF_SPOILER');
      addDeduction('payoffCliffhangerTiming', 0.6, cliffhangerBeat.beatId, 'Cliffhanger spoils final booking/sentencing instead of maintaining unresolved tension.');
    }
  }
  payoffScore = Math.max(0, Math.min(1.5, payoffScore));

  // 6. Temporal / Context Coherence (Max 1.0)
  let temporalScore = 1.0;

  if (unanchoredBackwardJumps > 0) {
    temporalScore -= 0.5;
    addDeduction('temporalContextCoherence', 0.5, null, `${unanchoredBackwardJumps} unanchored backward jump(s).`);
  }

  let unexplainedForwardJumpCount = 0;
  for (let i = 1; i < beats.length; i++) {
    const prev = beats[i - 1];
    const curr = beats[i];
    const prevEnd = Number(prev.sourceEndSec);
    const currStart = Number(curr.sourceStartSec);
    const jump = currStart - prevEnd;
    if (jump > 60.0) {
      const hasReason = Boolean(curr.jumpReason || curr.jumpSeconds || curr.causalLink || curr.bridgeRequired || (curr.newInformation && curr.newInformation.length >= 10));
      if (!hasReason) {
        unexplainedForwardJumpCount++;
      }
      if (jump > 180.0 && !curr.jumpReason && !curr.causalLink && (!curr.newInformation || curr.newInformation.length < 10)) {
        hardCaps.push('UNEXPLAINED_TIME_JUMP');
        temporalScore -= 0.5;
        addDeduction('temporalContextCoherence', 0.5, curr.beatId, `Unexplained massive time jump (+${jump.toFixed(0)}s) without narrative context.`);
      }
    }
  }

  if (unexplainedForwardJumpCount > 0) {
    temporalScore -= 0.3;
    addDeduction('temporalContextCoherence', 0.3, null, `${unexplainedForwardJumpCount} large forward jump(s) (> 60s) without jumpReason or causalLink.`);
  }

  if (totalDur < 45.0) {
    temporalScore -= 0.5;
    hardCaps.push('DURATION_PADDING');
    addDeduction('temporalContextCoherence', 0.5, null, `Timeline duration is severely truncated (${totalDur.toFixed(1)}s < 45s).`);
  }
  temporalScore = Math.max(0, Math.min(1.0, temporalScore));

  const rawScore = Number((hookScore + causalScore + infoScore + pulseScore + payoffScore + temporalScore).toFixed(1));
  const uniqueHardCaps = [...new Set(hardCaps)];
  let score = rawScore;
  if (uniqueHardCaps.length > 0) {
    score = Math.min(score, 7.0);
  }
  score = Number(score.toFixed(1));

  const minRequiredScore = options.minStructuralViralScore ?? 8.0;
  const passed = score >= minRequiredScore && uniqueHardCaps.length === 0;

  return {
    score,
    rawScore,
    passed,
    dimensions: {
      hookOpenQuestion: { score: Number(hookScore.toFixed(2)), max: 2.0, details: hookScore >= 1.7 ? 'Strong hook and curiosity gap' : 'Needs hook or stakes improvement' },
      causalProgression: { score: Number(causalScore.toFixed(2)), max: 2.0, details: causalScore >= 1.7 ? 'Clear causal graph and forward momentum' : 'Gaps in causal progression' },
      informationEvidenceEscalation: { score: Number(infoScore.toFixed(2)), max: 2.0, details: infoScore >= 1.7 ? 'Consistent evidence ladder and high novelty' : 'Stagnant information gain' },
      retentionPulseDensity: { score: Number(pulseScore.toFixed(2)), max: 1.5, details: pulseScore >= 1.3 ? 'Dense micro-beat pulse (~3-8s) without plateaus' : 'Pacing or plateau detected' },
      payoffCliffhangerTiming: { score: Number(payoffScore.toFixed(2)), max: 1.5, details: payoffScore >= 1.3 ? 'High consequence payoff/cliffhanger with Part 2 setup' : 'Weak ending or spoiler' },
      temporalContextCoherence: { score: Number(temporalScore.toFixed(2)), max: 1.0, details: temporalScore >= 0.8 ? 'Coherent timeline without unanchored jumps' : 'Temporal discontinuity detected' }
    },
    hardCaps: uniqueHardCaps,
    deductions
  };
}

/**
 * Validates an EDL / Story Spine against the 5 core retention rules.
 *
 * @param {Object} spine Story Spine object with .beats array
 * @param {Object} options Configurable thresholds
 * @returns {Object} { valid: boolean, violations: Array<{ code, message, beatId }>, metrics: Object }
 */
function validateEdlQuality(spine = {}, options = {}) {
  const violations = [];
  const beats = Array.isArray(spine.beats) ? spine.beats : [];

  if (!beats.length) {
    return {
      valid: false,
      violations: [{ code: 'EMPTY_BEATS', message: 'EDL contains no beats.', beatId: null }],
      metrics: {}
    };
  }

  const maxTeaserDurationSec = options.maxTeaserDurationSec ?? 14.0;
  const maxTeaserOverlapSec = options.maxTeaserOverlapSec ?? 3.0;
  const maxTeaserOverlapRatio = options.maxTeaserOverlapRatio ?? 0.25;
  const maxMacroBeatDurationSec = options.maxMacroBeatDurationSec ?? 10.0;
  const maxAllowedBackwardJumpSec = options.maxAllowedBackwardJumpSec ?? 2.0;

  // 1. Partition beats into Teaser vs Main Narrative (Post-Rewind)
  const firstRewindIdx = beats.findIndex(b => b.chronologyMode === 'rewind');
  let teaserBeats = [];
  let mainBeats = [];

  if (firstRewindIdx > 0) {
    teaserBeats = beats.slice(0, firstRewindIdx);
    mainBeats = beats.slice(firstRewindIdx);
  } else {
    teaserBeats = beats.filter(b => b.chronologyMode === 'teaser');
    mainBeats = beats.filter(b => b.chronologyMode !== 'teaser');
  }

  const teaserIntervals = teaserBeats.map(b => [Number(b.sourceStartSec), Number(b.sourceEndSec)]);
  const mainIntervals = mainBeats.map(b => [Number(b.sourceStartSec), Number(b.sourceEndSec)]);
  const allIntervals = beats.map(b => [Number(b.sourceStartSec), Number(b.sourceEndSec)]);

  const teaserDuration = teaserBeats.reduce((sum, b) => sum + Math.max(0, Number(b.sourceEndSec) - Number(b.sourceStartSec)), 0);
  const totalTimelineDuration = beats.reduce((sum, b) => sum + Math.max(0, Number(b.sourceEndSec) - Number(b.sourceStartSec)), 0);

  // 0. Timeline Duration Budget
  const minTimelineDurationSec = Number.isFinite(options.minTimelineDurationSec) ? options.minTimelineDurationSec : 60.0;
  const maxTimelineDurationSec = Number.isFinite(options.maxTimelineDurationSec) ? options.maxTimelineDurationSec : 100.0;

  if (totalTimelineDuration < minTimelineDurationSec - 0.5) {
    violations.push({
      code: 'TOTAL_DURATION_UNDER_MIN',
      message: `Total timeline duration is only ${totalTimelineDuration.toFixed(1)}s (minimum required is ${minTimelineDurationSec}s). You must find additional causally useful material to extend the story. Add more chronological micro-beats advancing the narrative.`,
      beatId: null
    });
  } else if (totalTimelineDuration > maxTimelineDurationSec + 0.5) {
    violations.push({
      code: 'TOTAL_DURATION_OVER_MAX',
      message: `Total timeline duration is ${totalTimelineDuration.toFixed(1)}s (maximum allowed is ${maxTimelineDurationSec}s). Trim beat durations to stay within ${minTimelineDurationSec}-${maxTimelineDurationSec}s.`,
      beatId: null
    });
  }

  // 1. Rule 1: Teaser Borrow Budget (Overlap with Main Story)
  const teaserToMainSourceOverlapSeconds = computeIntervalOverlap(teaserIntervals, mainIntervals);
  const teaserToMainSourceOverlapRatio = teaserDuration > 0
    ? (teaserToMainSourceOverlapSeconds / teaserDuration)
    : 0;

  const teaserOverlaps = [];
  for (const tb of teaserBeats) {
    const tStart = Number(tb.sourceStartSec);
    const tEnd = Number(tb.sourceEndSec);
    if (!Number.isFinite(tStart) || !Number.isFinite(tEnd) || tEnd <= tStart) continue;
    for (const mb of mainBeats) {
      const mStart = Number(mb.sourceStartSec);
      const mEnd = Number(mb.sourceEndSec);
      if (!Number.isFinite(mStart) || !Number.isFinite(mEnd) || mEnd <= mStart) continue;
      const maxStart = Math.max(tStart, mStart);
      const minEnd = Math.min(tEnd, mEnd);
      if (maxStart < minEnd - 1e-4) {
        const overlapSec = Number((minEnd - maxStart).toFixed(2));
        teaserOverlaps.push({
          teaserBeatId: tb.beatId,
          mainBeatId: mb.beatId,
          teaserRange: [Number(tStart.toFixed(1)), Number(tEnd.toFixed(1))],
          mainRange: [Number(mStart.toFixed(1)), Number(mEnd.toFixed(1))],
          overlapSec,
          isExact: Math.abs(tStart - mStart) < 0.05 && Math.abs(tEnd - mEnd) < 0.05
        });
      }
    }
  }

  if (teaserToMainSourceOverlapSeconds > maxTeaserOverlapSec || teaserToMainSourceOverlapRatio > maxTeaserOverlapRatio) {
    violations.push({
      code: 'LARGE_TEASER_MAIN_OVERLAP',
      message: `Teaser-to-main source overlap is too high: ${teaserToMainSourceOverlapSeconds.toFixed(1)}s (${(teaserToMainSourceOverlapRatio * 100).toFixed(0)}% of teaser). Maximum allowed overlap is ${maxTeaserOverlapSec}s (25%). Cold open borrowed ranges must not be replayed in post-rewind narrative. Borrow shorter clips or focus post-rewind story on unshown footage.`,
      beatId: teaserBeats[0]?.beatId || null,
      overlaps: teaserOverlaps
    });
  }

  // 1b. Rule 1b: Pre-compile exact range duplicate check across all beats
  for (let i = 0; i < beats.length; i++) {
    const b1 = beats[i];
    const s1 = Number(b1.sourceStartSec);
    const e1 = Number(b1.sourceEndSec);
    if (!Number.isFinite(s1) || !Number.isFinite(e1) || e1 <= s1) continue;
    const audio1 = b1.audioMode || b1.audioIntent || 'original_audio';

    for (let j = i + 1; j < beats.length; j++) {
      const b2 = beats[j];
      const s2 = Number(b2.sourceStartSec);
      const e2 = Number(b2.sourceEndSec);
      if (!Number.isFinite(s2) || !Number.isFinite(e2) || e2 <= s2) continue;
      const audio2 = b2.audioMode || b2.audioIntent || 'original_audio';

      const isSameRange = Math.abs(s1 - s2) < 0.05 && Math.abs(e1 - e2) < 0.05;
      const isSameAudio = audio1 === audio2;

      if (isSameRange && isSameAudio) {
        violations.push({
          code: 'EXACT_EDL_DUPLICATE',
          message: `Exact duplicate source range [${s1.toFixed(1)}-${e1.toFixed(1)}s] between beat '${b1.beatId}' and beat '${b2.beatId}' with same effective audio treatment ('${audio1}'). Every beat in the EDL must feature distinct footage or narrative purpose.`,
          beatId: b2.beatId,
          firstBeatId: b1.beatId,
          secondBeatId: b2.beatId,
          sourceStartSec: s1,
          sourceEndSec: e1,
          audioTreatment: audio1
        });
      }
    }
  }

  // 3. Rule 2: Cold Open Duration & Payoff Completion
  if (teaserDuration > maxTeaserDurationSec) {
    violations.push({
      code: 'OVERLONG_TEASER',
      message: `Cold open is too long (${teaserDuration.toFixed(1)}s > ${maxTeaserDurationSec}s). Target a compact 7-12s teaser: conflict (2-3s) -> escalation (2-3s) -> partial reveal (2-3s) -> CUT to rewind before full payoff.`,
      beatId: teaserBeats[0]?.beatId || null
    });
  }

  const overlongPayoffBeat = teaserBeats.find(b => {
    const dur = Math.max(0, Number(b.sourceEndSec) - Number(b.sourceStartSec));
    return (b.narrativeRole === 'micro_payoff' || b.isReveal === true) && dur > 4.5;
  });
  if (overlongPayoffBeat) {
    const dur = Math.max(0, Number(overlongPayoffBeat.sourceEndSec) - Number(overlongPayoffBeat.sourceStartSec));
    violations.push({
      code: 'TEASER_COMPLETES_PAYOFF',
      message: `Teaser beat '${overlongPayoffBeat.beatId}' (${dur.toFixed(1)}s) nearly completes its full payoff before rewind. Teaser must sample the action and CUT after 2-3s of partial reveal before full resolution.`,
      beatId: overlongPayoffBeat.beatId
    });
  }

  // 4. Rule 3: Micro-Beats & Max Macro Beat Duration
  let maxMacroBeatDuration = 0;
  let deadNarrativeBeatCount = 0;
  let missingRetentionReasonCount = 0;

  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    const dur = Math.max(0, Number(b.sourceEndSec) - Number(b.sourceStartSec));
    if (dur > maxMacroBeatDuration) {
      maxMacroBeatDuration = dur;
    }

    if (dur > maxMacroBeatDurationSec) {
      violations.push({
        code: 'MACRO_BEAT_EXCEEDS_MAX',
        message: `Beat '${b.beatId}' is an undifferentiated macro beat (${dur.toFixed(1)}s > ${maxMacroBeatDurationSec}s). Split into micro-beats (3-8s each) with explicit retention reasons.`,
        beatId: b.beatId
      });
    }

    const info = String(b.newInformation || b.informationRevealed || '').trim();
    if (!info || info.length < 5) {
      deadNarrativeBeatCount++;
    }

    if (b.retentionReason && !VALID_RETENTION_REASONS.has(b.retentionReason)) {
      missingRetentionReasonCount++;
    }
  }

  if (deadNarrativeBeatCount > 0) {
    violations.push({
      code: 'DEAD_NARRATIVE_BEAT',
      message: `${deadNarrativeBeatCount} beat(s) have missing or insufficient newInformation. Every beat must deliver new information to retain viewer attention.`,
      beatId: null
    });
  }

  // 5. Rule 4: Unjustified Backward Jump
  let unanchoredBackwardJumpCount = 0;
  for (let i = 1; i < beats.length; i++) {
    const prev = beats[i - 1];
    const curr = beats[i];
    const prevEnd = Number(prev.sourceEndSec);
    const currStart = Number(curr.sourceStartSec);

    // If current beat jumps backwards in source time
    if (currStart < prevEnd - maxAllowedBackwardJumpSec) {
      const mode = curr.chronologyMode || 'chronological';
      const isAnchored = mode === 'rewind' || mode === 'callback' || mode === 'teaser';
      if (!isAnchored) {
        unanchoredBackwardJumpCount++;
        violations.push({
          code: 'UNANCHORED_BACKWARD_JUMP',
          message: `Unanchored backward jump at beat '${curr.beatId}': sourceStartSec (${currStart}s) is earlier than previous beat end (${prevEnd}s) by ${(prevEnd - currStart).toFixed(1)}s while chronologyMode='${mode}'. Backward jumps are only allowed in 'rewind' or 'callback' modes with explicit narrative anchors.`,
          beatId: curr.beatId
        });
      }
    }
  }

  // 5b. Visual-State & Viewer-State Collapse Analysis (Rule 4b)
  const maxSameVisualStateRunSecAllowed = options.maxSameVisualStateRunSec ?? 12.0;
  const maxSemanticRepetitionRunAllowed = options.maxSemanticRepetitionRun ?? 2;

  let maxSameVisualStateRunSec = 0;
  let currentVisualCluster = null;
  let currentVisualRunSec = 0;
  let visualStateChanges = 0;

  let maxSemanticRepetitionRun = 0;
  let currentSemanticFn = null;
  let currentSemanticRunCount = 0;

  let staticSpeakerPlateauCount = 0;
  let strongInformationGainCount = 0;
  let viewerStateChanges = 0;

  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    const dur = Math.max(0, Number(b.sourceEndSec) - Number(b.sourceStartSec));
    const cluster = deduceVisualStateCluster(b);
    const semFn = deduceSemanticFunction(b);

    // Visual state tracking
    if (cluster === currentVisualCluster) {
      currentVisualRunSec += dur;
    } else {
      if (i > 0) visualStateChanges++;
      currentVisualCluster = cluster;
      currentVisualRunSec = dur;
    }
    if (currentVisualRunSec > maxSameVisualStateRunSec) {
      maxSameVisualStateRunSec = currentVisualRunSec;
    }

    if (currentVisualRunSec > maxSameVisualStateRunSecAllowed + 0.5) {
      violations.push({
        code: 'VISUAL_STATE_COLLAPSE',
        message: `Consecutive beats span ${currentVisualRunSec.toFixed(1)}s in the same visual state '${cluster}'. Viewer perceives this as an unbroken static talking-head scene with zero visual novelty. Maximum allowed run in same visual state is ${maxSameVisualStateRunSecAllowed}s. Alternate camera perspective, subject, or physical action.`,
        beatId: b.beatId
      });
    }

    // Semantic function repetition tracking
    if (semFn === 'suspect_defense_excuse') {
      if (currentSemanticFn === 'suspect_defense_excuse') {
        currentSemanticRunCount++;
      } else {
        currentSemanticFn = 'suspect_defense_excuse';
        currentSemanticRunCount = 1;
      }
      if (currentSemanticRunCount > maxSemanticRepetitionRun) {
        maxSemanticRepetitionRun = currentSemanticRunCount;
      }
      if (currentSemanticRunCount > maxSemanticRepetitionRunAllowed) {
        violations.push({
          code: 'SEMANTIC_REPETITION_COLLAPSE',
          message: `Detected ${currentSemanticRunCount} consecutive beats repeating suspect defense/excuses without forward narrative progress. Micro-beats must deliver physical action, confrontation, or concrete evidence.`,
          beatId: b.beatId
        });
      }
    } else {
      currentSemanticFn = semFn;
      currentSemanticRunCount = 1;
    }

    // Static speaker plateau detection (3 consecutive beats of a subject talking at an entrance without physical action)
    if (i >= 2) {
      const bPrev1 = beats[i - 1];
      const bPrev2 = beats[i - 2];
      const c1 = deduceVisualStateCluster(bPrev1);
      const c2 = deduceVisualStateCluster(bPrev2);
      if (cluster === 'entrance_subject_talking' && c1 === 'entrance_subject_talking' && c2 === 'entrance_subject_talking') {
        const hasActionOrReveal = [bPrev2, bPrev1, b].some(x =>
          x.retentionReason === 'visual_reveal' ||
          x.retentionReason === 'escalation' ||
          x.narrativeRole === 'confrontation'
        );
        if (!hasActionOrReveal) {
          staticSpeakerPlateauCount++;
          violations.push({
            code: 'STATIC_SPEAKER_PLATEAU',
            message: `Detected 3 consecutive beats ('${bPrev2.beatId}', '${bPrev1.beatId}', '${b.beatId}') featuring the same subject talking in a static entrance position without physical action or visual reveal. REJECTED: Viewer retention collapses.`,
            beatId: b.beatId
          });
        }
      }
    }

    // Information gain and viewer state change tracking
    if (['new_fact', 'contradiction', 'visual_reveal', 'escalation'].includes(b.retentionReason) ||
        semFn === 'physical_evidence_revelation' || semFn === 'officer_physical_action') {
      strongInformationGainCount++;
    }

    if (Math.abs(Number(b.tensionDelta) || 0) > 0 || (b.viewerStateBefore && b.viewerStateAfter && b.viewerStateBefore !== b.viewerStateAfter)) {
      viewerStateChanges++;
    }
  }

  const visualStateChangeRate = beats.length > 1 ? Number((visualStateChanges / (beats.length - 1)).toFixed(2)) : 1;
  const viewerStateChangeRate = beats.length > 0 ? Number((viewerStateChanges / beats.length).toFixed(2)) : 1;
  const strongMomentDensity = totalTimelineDuration > 0 ? Number((strongInformationGainCount / (totalTimelineDuration / 60)).toFixed(1)) : 0;

  // 6. Rule 5: Concrete Cliffhanger Strength Signals
  const cliffhangerBeat = beats.find(b => b.narrativeRole === 'cliffhanger') || beats[beats.length - 1];
  let cliffhangerStrengthSignals = {
    beatId: cliffhangerBeat?.beatId || null,
    hasQuestion: false,
    hasNewInfo: false,
    hasNextPayoff: false,
    isPart2Setup: false,
    noPrematureArrestSpoiler: true,
    specificNewFact: false,
    consequenceMagnitude: 'none',
    unresolvedConsequence: '',
    isStrong: false
  };

  if (!cliffhangerBeat) {
    violations.push({
      code: 'MISSING_CLIFFHANGER',
      message: 'No cliffhanger beat found in story spine. Serialized Part 1 requires a final cliffhanger beat.',
      beatId: null
    });
  } else {
    const q = String(cliffhangerBeat.cliffhangerQuestion || cliffhangerBeat.viewerQuestion || cliffhangerBeat.openLoop || '').trim();
    const info = String(cliffhangerBeat.cliffhangerNewInformation || cliffhangerBeat.newInformation || cliffhangerBeat.informationRevealed || '').trim();
    const payoff = String(cliffhangerBeat.cliffhangerExpectedNextPayoff || '').trim();
    const timing = cliffhangerBeat.payoffTiming;

    // Check specific concrete new fact
    const hasExplicitFlag = Boolean(cliffhangerBeat.cliffhangerSpecificFact || cliffhangerBeat.specificNewFact);
    const specificFactText = `${typeof cliffhangerBeat.cliffhangerSpecificFact === 'string' ? cliffhangerBeat.cliffhangerSpecificFact : ''} ${typeof cliffhangerBeat.specificNewFact === 'string' ? cliffhangerBeat.specificNewFact : ''} ${cliffhangerBeat.newInformation || ''} ${info}`.toLowerCase();
    const hasSpecificNewFact = hasExplicitFlag || /punch|hit|grab|wrist|mark|bruise|batter|assault|handcuff|cuff|lock|weapon|gun|shot|gunshot|bullet|wound|phone|text|admit|confess|restrain|block|unlawful|illegal|force|injur|leave|flee/i.test(specificFactText);

    // Determine consequence magnitude
    let consequenceMagnitude = cliffhangerBeat.consequenceMagnitude || 'none';
    if (consequenceMagnitude === 'none') {
      if (/arrest|cuff|custody|jail|charge|felony|unlawful|prosecut/i.test(`${q} ${info} ${payoff}`)) {
        consequenceMagnitude = 'charges';
      } else if (/punch|hit|physical|violence|attack|batter|shot|gunshot|bullet|wound|bleeding/i.test(`${q} ${info} ${payoff}`)) {
        consequenceMagnitude = 'violence';
      } else if (/mark|wrist|bruise|evidence|photograph|contraband|drugs|cash|loot/i.test(`${q} ${info} ${payoff}`)) {
        consequenceMagnitude = 'evidence_found';
      } else if (/admit|confess|slip-up|concede/i.test(`${q} ${info} ${payoff}`)) {
        consequenceMagnitude = 'confession';
      }
    }

    const unresolvedConsequence = String(cliffhangerBeat.unresolvedConsequence || payoff || q).trim();

    cliffhangerStrengthSignals.hasQuestion = q.length >= 8;
    cliffhangerStrengthSignals.hasNewInfo = info.length >= 8;
    cliffhangerStrengthSignals.hasNextPayoff = payoff.length >= 6 || timing === 'part_2' || timing === 'delayed';
    cliffhangerStrengthSignals.isPart2Setup = timing === 'part_2' || timing === 'delayed' || timing === 'immediate_in_part_2';
    cliffhangerStrengthSignals.specificNewFact = hasSpecificNewFact;
    cliffhangerStrengthSignals.consequenceMagnitude = consequenceMagnitude;
    cliffhangerStrengthSignals.unresolvedConsequence = unresolvedConsequence;

    // Anti-spoiler check for serialized Part 1
    const combinedText = `${q} ${info} ${cliffhangerBeat.informationRevealed || ''}`.toLowerCase();
    const hasArrestSpoiler = /transport|patrol car arrest|jail booking|sentenced|sentencing|final verdict/i.test(combinedText);
    cliffhangerStrengthSignals.noPrematureArrestSpoiler = !hasArrestSpoiler;

    cliffhangerStrengthSignals.isStrong = (
      cliffhangerStrengthSignals.hasQuestion &&
      cliffhangerStrengthSignals.hasNewInfo &&
      cliffhangerStrengthSignals.hasNextPayoff &&
      cliffhangerStrengthSignals.isPart2Setup &&
      cliffhangerStrengthSignals.specificNewFact &&
      cliffhangerStrengthSignals.consequenceMagnitude !== 'none' &&
      cliffhangerStrengthSignals.noPrematureArrestSpoiler
    );

    if (!cliffhangerStrengthSignals.isStrong) {
      violations.push({
        code: 'WEAK_CLIFFHANGER',
        message: `Cliffhanger beat '${cliffhangerBeat.beatId}' is too weak. Must introduce a SPECIFIC new fact/discovery (${cliffhangerStrengthSignals.specificNewFact ? 'OK' : 'MISSING'}), significant consequence magnitude (${cliffhangerStrengthSignals.consequenceMagnitude}), unresolved consequence, and Part 2 payoff setup without arrest spoilers.`,
        beatId: cliffhangerBeat.beatId
      });
    }
  }

  // 7. Overall Source Utilization & Unique Seconds
  const mergedUniqueIntervals = mergeIntervals(allIntervals);
  const uniqueSourceSeconds = totalIntervalDuration(mergedUniqueIntervals);
  const uniqueSourceRatio = totalTimelineDuration > 0
    ? (uniqueSourceSeconds / totalTimelineDuration)
    : 0;

  // 8. Compute Structural Viral Score
  const structuralViralScore = computeStructuralViralScore(spine, {
    ...options,
    metrics: {
      totalBeats: beats.length,
      teaserBeatsCount: teaserBeats.length,
      mainBeatsCount: mainBeats.length,
      totalTimelineDuration: Number(totalTimelineDuration.toFixed(2)),
      teaserDuration: Number(teaserDuration.toFixed(2)),
      teaserToMainSourceOverlapSeconds: Number(teaserToMainSourceOverlapSeconds.toFixed(2)),
      teaserToMainSourceOverlapRatio: Number(teaserToMainSourceOverlapRatio.toFixed(3)),
      maxMacroBeatDuration: Number(maxMacroBeatDuration.toFixed(2)),
      unanchoredBackwardJumpCount,
      deadNarrativeBeatCount,
      sameVisualStateRunSec: Number(maxSameVisualStateRunSec.toFixed(2)),
      semanticRepetitionRun: maxSemanticRepetitionRun,
      staticSpeakerPlateauCount
    }
  });

  const minRequiredScore = options.minStructuralViralScore ?? 8.0;
  if (structuralViralScore.score < minRequiredScore || structuralViralScore.hardCaps.length > 0) {
    violations.push({
      code: 'STRUCTURAL_SCORE_BELOW_MIN',
      message: `Structural Viral Score is ${structuralViralScore.score.toFixed(1)}/10.0 (minimum required: ${minRequiredScore.toFixed(1)}/10.0). Hard caps: [${structuralViralScore.hardCaps.join(', ') || 'none'}]. Deductions:\n${structuralViralScore.deductions.map(d => ` - [${d.dimension}] -${d.deduction}: ${d.reason}`).join('\n')}`,
      beatId: null
    });
  }

  const valid = violations.length === 0;

  return {
    valid,
    violations,
    metrics: {
      totalBeats: beats.length,
      teaserBeatsCount: teaserBeats.length,
      mainBeatsCount: mainBeats.length,
      totalTimelineDuration: Number(totalTimelineDuration.toFixed(2)),
      teaserDuration: Number(teaserDuration.toFixed(2)),
      teaserToMainSourceOverlapSeconds: Number(teaserToMainSourceOverlapSeconds.toFixed(2)),
      teaserToMainSourceOverlapRatio: Number(teaserToMainSourceOverlapRatio.toFixed(3)),
      teaserOverlaps,
      uniqueSourceSeconds: Number(uniqueSourceSeconds.toFixed(2)),
      uniqueSourceRatio: Number(uniqueSourceRatio.toFixed(3)),
      maxMacroBeatDuration: Number(maxMacroBeatDuration.toFixed(2)),
      unanchoredBackwardJumpCount,
      deadNarrativeBeatCount,
      sameVisualStateRunSec: Number(maxSameVisualStateRunSec.toFixed(2)),
      visualStateChangeRate,
      viewerStateChangeRate,
      semanticRepetitionRun: maxSemanticRepetitionRun,
      staticSpeakerPlateauCount,
      strongInformationGainCount,
      strongMomentDensity,
      cliffhangerStrengthSignals,
      structuralViralScore
    }
  };
}

module.exports = {
  validateEdlQuality,
  computeStructuralViralScore,
  mergeIntervals,
  computeIntervalOverlap,
  VALID_RETENTION_REASONS,
  deduceVisualStateCluster,
  deduceSemanticFunction
};
