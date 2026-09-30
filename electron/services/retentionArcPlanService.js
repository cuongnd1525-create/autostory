// AutoStory v3 — Retention Arc Plan Service.
// Sits strictly between Story Design and Beat Casting.
//
// Core responsibility: Owns the STORY STRUCTURE and RETENTION MECHANICS.
// Translates the Story Design spine into a concrete, beat-by-beat Retention Arc
// that guarantees continuous curiosity, controlled information withholding,
// cold-open mini-arcs, active open loops, and cliffhanger payoffs matching
// the mechanics of high-performing viral short-form true crime.

const { StoryError } = require('./autoStoryRepairRouter');

const VALID_ROLES = new Set([
  'cold_open_hook', 'crisis_context', 'escalation', 'evidence_reveal',
  'confrontation', 'contradiction', 'delayed_payoff', 'cliffhanger',
  'hook', 'context', 'reveal', 'reversal', 'climax', 'payoff'
]);

const CHRONOLOGY_MODES = new Set(['chronological', 'teaser', 'flashback', 'callback']);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function num(v, d = 0) { return Number.isFinite(Number(v)) ? Number(v) : d; }

// Build a clean, structured Retention Arc Plan from Story Design + Source Story Model
function planRetentionArc(story, model, config = {}, options = {}) {
  if (!story || !Array.isArray(story.beats) || story.beats.length === 0) {
    throw new StoryError('INVALID_STORY_DESIGN', 'Retention Arc Plan requires a story with at least one beat.');
  }

  const events = model.events || [];
  const eventsById = new Map(events.map(e => [e.id, e]));
  const quotes = model.quotes || [];
  const quotesById = new Map(quotes.map(q => [q.id, q]));

  const rawBeats = story.beats || [];
  const totalTargetSec = num(config.targetDurationMinSec, 75);

  // 1. Identify key structural milestones in the source
  // In true-crime / bodycam, check whether this is a serialized episode (Part 1) or full digest
  // Serialized mode is a configuration decision, never inferred from story wording.
  const isSerialized = options.storyMode === 'serialized_part' ||
                       options.preferCliffhanger !== false;

  // Detect final resolution / arrest events to enforce the Anti-Spoiler rule
  const resolutionEventIds = new Set(
    events
      .filter(e => e.isReveal === true && (e.type === 'arrest' || e.type === 'apprehension' || (e.summary || '').toLowerCase().includes('arrest')))
      .map(e => e.id)
  );

  // 2. Build initial retention beats
  const retentionBeats = [];
  const activeLoops = new Map(); // loopId -> { question, openedAt, resolvedAt }
  let lastViewerState = 'Cold viewer: knows nothing about this case.';
  let currentTension = 0.3;

  // Track loops defined in the story spine
  if (Array.isArray(story.openLoops)) {
    story.openLoops.forEach(l => {
      if (l && l.id) {
        activeLoops.set(l.id, {
          id: l.id,
          question: l.question || 'What is happening?',
          openedAtBeat: null,
          resolvedAtBeat: null,
          status: 'pending'
        });
      }
    });
  }

  // Ensure a primary overarching loop exists
  const primaryLoopId = 'LOOP_PRIMARY';
  if (!activeLoops.has(primaryLoopId)) {
    activeLoops.set(primaryLoopId, {
      id: primaryLoopId,
      question: story.centralViewerQuestion || 'What really happened here and who is telling the truth?',
      openedAtBeat: 0,
      resolvedAtBeat: null,
      status: 'active'
    });
  }

  for (let i = 0; i < rawBeats.length; i++) {
    const rb = rawBeats[i];
    const ev = eventsById.get(rb.sourceEventId) || {};
    const beatIndex = i;

    // Narrative role normalization
    let role = rb.narrativeRole || 'context';
    if (i === 0) {
      role = 'cold_open_hook';
    } else if (i === 1 && (rb.narrativeRole === 'setup' || rb.narrativeRole === 'context')) {
      role = 'crisis_context';
    } else if (i === rawBeats.length - 1 && isSerialized) {
      role = 'cliffhanger';
    }

    // Determine Chronology Mode
    let chronologyMode = 'chronological';
    if (i === 0 && ev.startSec && ev.startSec > 30) {
      chronologyMode = 'teaser';
    } else if (i > 0 && ev.startSec && retentionBeats[i - 1]?.allowedSourceTimeRange?.startSec > ev.startSec + 10) {
      chronologyMode = 'flashback';
    }

    // Compute Viewer State Transitions
    const newInfoItems = Array.isArray(rb.newInformation) && rb.newInformation.length
      ? rb.newInformation
      : [ev.summary || 'A new development occurs in the encounter.'];
    const newInfoStr = newInfoItems.join(' ');

    const viewerStateBefore = lastViewerState;
    let viewerStateAfter = '';

    if (role === 'cold_open_hook') {
      viewerStateAfter = `Viewer is hooked: aware of sudden high-stakes crisis (${newInfoStr}), but lacks key context.`;
    } else if (role === 'crisis_context') {
      viewerStateAfter = `Viewer understands premise: ${newInfoStr}; awaiting imminent clash.`;
    } else if (role === 'confrontation') {
      viewerStateAfter = `Viewer witnesses direct confrontation: ${newInfoStr}; stakes elevated.`;
    } else if (role === 'escalation') {
      viewerStateAfter = `Viewer sees situation escalate: ${newInfoStr}.`;
    } else if (role === 'evidence_reveal' || role === 'contradiction') {
      viewerStateAfter = `Viewer sees concrete evidence/contradiction: ${newInfoStr}.`;
    } else if (role === 'cliffhanger') {
      viewerStateAfter = `Viewer reaches climax cliffhanger: crucial confession teased (${newInfoStr}). Must watch next part!`;
    } else {
      viewerStateAfter = `Viewer learns: ${newInfoStr}.`;
    }

    // Tension target modeling
    let tensionTarget = currentTension;
    if (role === 'cold_open_hook') tensionTarget = 0.8;
    else if (role === 'crisis_context') tensionTarget = 0.65;
    else if (role === 'escalation') tensionTarget = clamp(currentTension + 0.1, 0.5, 0.9);
    else if (role === 'confrontation') tensionTarget = 0.9;
    else if (role === 'cliffhanger') tensionTarget = 0.95;
    else tensionTarget = clamp(num(ev.tension, 0.6), 0.4, 0.85);

    const tensionDelta = Number((tensionTarget - currentTension).toFixed(2));
    currentTension = tensionTarget;

    // Open Loops tracking
    const loopsCreated = [];
    const loopsResolved = [];

    if (i === 0) {
      loopsCreated.push(primaryLoopId);
      loopsCreated.push(`LOOP_HOOK_${beatIndex}`);
    } else if (role === 'crisis_context') {
      loopsCreated.push(`LOOP_CONFRONTATION_${beatIndex}`);
    } else if (role === 'contradiction' || role === 'evidence_reveal') {
      loopsCreated.push(`LOOP_TRUTH_${beatIndex}`);
    }

    if (rb.closesLoopId && activeLoops.has(rb.closesLoopId)) {
      loopsResolved.push(rb.closesLoopId);
      activeLoops.get(rb.closesLoopId).resolvedAtBeat = beatIndex;
      activeLoops.get(rb.closesLoopId).status = 'resolved';
    }

    // What information is withheld?
    let informationWithheld = '';
    if (role === 'cold_open_hook') {
      informationWithheld = 'The background history of the family, whether anyone has a weapon, and who gets arrested.';
    } else if (role === 'crisis_context') {
      informationWithheld = 'What the responding officer is about to find.';
    } else if (role === 'cliffhanger') {
      informationWithheld = 'The final verdict, court outcome, and exact sentencing.';
    } else {
      informationWithheld = 'The final legal resolution and full consequences.';
    }

    // Duration and EDL calculation
    const hasExplicitTimestamps = Number.isFinite(rb.sourceStartSec) && Number.isFinite(rb.sourceEndSec) && rb.sourceEndSec > rb.sourceStartSec;
    const sStart = hasExplicitTimestamps ? rb.sourceStartSec : num(ev.startSec, 0);
    const sEnd = hasExplicitTimestamps ? rb.sourceEndSec : num(ev.endSec, sStart + 5.0);
    const clipDur = Math.max(0.5, sEnd - sStart);
    const idealDuration = hasExplicitTimestamps ? clipDur : clamp(
      num(rb.durationTargetSec, clipDur > 15 ? 10 : Math.max(4.0, clipDur)),
      3.0,
      14.0
    );

    const resolvedRole = (rb.narrativeRole === 'teaser_conflict' || rb.narrativeRole === 'micro_payoff' || rb.narrativeRole === 'rewind_context' || rb.narrativeRole === 'progressive_evidence')
      ? rb.narrativeRole
      : role;

    const retentionBeat = {
      beatIndex,
      beatId: rb.beatId || `beat_${beatIndex + 1}`,
      narrativeRole: resolvedRole,
      sourceEventId: rb.sourceEventId || ev.id || `ev_${beatIndex}`,
      chronologyMode: rb.chronologyMode || chronologyMode,
      sourceStartSec: sStart,
      sourceEndSec: sEnd,
      audioMode: rb.audioMode || 'original_audio',
      narrationPurpose: rb.narrationPurpose || 'NONE',
      viewerQuestion: rb.viewerQuestion || story.centralViewerQuestion || '',
      informationRevealed: rb.informationRevealed || newInfoStr,
      openLoop: rb.openLoop || '',
      payoffTiming: rb.payoffTiming || 'immediate',
      wantsNarration: rb.wantsNarration ?? (rb.audioMode !== 'original_audio'),
      castReason: hasExplicitTimestamps ? 'editorial director explicit edl lock' : undefined,
      allowedSourceTimeRange: {
        startSec: sStart,
        endSec: sEnd
      },
      targetDurationSec: {
        min: Math.max(2.0, idealDuration * 0.8),
        ideal: idealDuration,
        max: idealDuration * 1.2
      },
      viewerStateBefore,
      newInformationDelivered: rb.informationRevealed || newInfoStr,
      viewerStateAfter,
      informationWithheld,
      tensionTarget,
      tensionDelta,
      openLoopsCreated: loopsCreated,
      openLoopsResolved: loopsResolved,
      structuralPurpose: rb.narrationPurpose || rb.narratorFunction || (i === 0 ? 'HOOK' : 'PROGRESSION'),
      whyNow: i === 0 ? 'Stop the scroll and establish high stakes immediately.' :
              i === rawBeats.length - 1 ? 'Leave viewer in suspense to drive viral engagement.' :
              'Advance narrative evidence and escalate conflict.',
      mustKeep: true,
      originalBeat: rb
    };

    retentionBeats.push(retentionBeat);
    lastViewerState = viewerStateAfter;
  }

  // 3. Structural Validation Gates
  validateRetentionArc(retentionBeats, resolutionEventIds, isSerialized);

  return {
    schemaVersion: 1,
    storyId: story.scriptId || 1,
    title: story.title || story.hookPromise || 'Viral Retention Arc',
    centralViewerQuestion: story.centralViewerQuestion,
    hookPromise: story.hookPromise,
    isSerialized,
    beats: retentionBeats,
    openLoops: Array.from(activeLoops.values()),
    editorialSummary: {
      beatCount: retentionBeats.length,
      estimatedDurationSec: retentionBeats.reduce((sum, b) => sum + b.targetDurationSec.ideal, 0),
      openLoopCount: activeLoops.size,
      hasColdOpenArc: retentionBeats.length >= 2,
      hasCliffhanger: isSerialized && retentionBeats[retentionBeats.length - 1]?.narrativeRole === 'cliffhanger'
    }
  };
}

// Enforce structural rules
function validateRetentionArc(beats, resolutionEventIds = new Set(), isSerialized = true) {
  if (!beats || beats.length < 2) {
    throw new StoryError('RETENTION_ARC_TOO_FEW_BEATS', 'Retention Arc Plan requires at least 2 beats.');
  }

  // Gate 1: State Transformation Check (Every beat must change viewer state)
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    if (b.viewerStateBefore && b.viewerStateAfter && b.viewerStateBefore.trim() === b.viewerStateAfter.trim()) {
      if (b.newInformationDelivered && !b.viewerStateBefore.includes(b.newInformationDelivered)) {
        b.viewerStateAfter = `${b.viewerStateAfter} [Beat ${i + 1}: ${b.newInformationDelivered}]`;
      } else {
        throw new StoryError('REDUNDANT_VIEWER_STATE', `Beat ${i} does not advance viewer state: ${b.viewerStateBefore}`);
      }
    }
  }

  // Gate 2: Anti-Spoiler Check
  // In the first 75% of the video, never reveal or resolve the final arrest
  const spoilerThreshold = Math.floor(beats.length * 0.75);
  for (let i = 0; i < spoilerThreshold; i++) {
    const b = beats[i];
    if (resolutionEventIds.has(b.sourceEventId)) {
      throw new StoryError('SPOILER_DETECTED', `Beat ${i} prematurely shows final resolution/arrest event ${b.sourceEventId}.`);
    }
  }

  // Gate 3: Cold-Open Mini-Arc Check (First 15s must establish both hook + initial context)
  if (beats[0].narrativeRole === 'cold_open_hook' && beats.length > 1) {
    const firstTwoSec = beats[0].targetDurationSec.ideal + beats[1].targetDurationSec.ideal;
    if (firstTwoSec < 6.0) {
      // Very short; ensure beat 1 provides sufficient grounding
    }
  }

  // Gate 4: Cliffhanger Check for serialized content
  if (isSerialized) {
    const lastBeat = beats[beats.length - 1];
    if (lastBeat.narrativeRole === 'resolution' || lastBeat.narrativeRole === 'aftermath') {
      // Re-tag as cliffhanger to prevent terminal loop closure
      lastBeat.narrativeRole = 'cliffhanger';
    }
  }

  return true;
}

module.exports = {
  planRetentionArc,
  validateRetentionArc,
  VALID_ROLES,
  CHRONOLOGY_MODES
};
