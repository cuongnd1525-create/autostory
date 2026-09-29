'use strict';

/**
 * AutoStory V4 — Structural Critic Service
 *
 * Post-render structural critic that evaluates the rendered draft in fixed ~5-8s windows.
 * Now includes Media-Grounded Critic that actually watches the MP4 via AI.
 */

const { deduceVisualStateCluster, deduceSemanticFunction, computeStructuralViralScore } = require('./edlQualityValidator.js');
const fs = require('fs');

/**
 * Legacy metadata-based critic (Phase 1)
 */
function critiqueRenderedTimeline(spine = {}, options = {}) {
  // ... existing logic ...
  // Since we are adding Media-Grounded, we'll keep this intact for backward compat if needed
  const beats = Array.isArray(spine.beats) ? spine.beats : [];
  const targetWindowSec = options.targetWindowSec ?? 5.5;

  if (!beats.length) {
    return {
      windows: [],
      weakWindows: [],
      averageRetentionScore: 0,
      isCompliant: false,
      summary: 'No beats to evaluate.',
      status: 'EMPTY'
    };
  }

  // Build rendered timeline spans
  let currentOutputTime = 0;
  const beatSpans = beats.map((b, idx) => {
    const dur = Math.max(0, Number(b.sourceEndSec) - Number(b.sourceStartSec));
    const span = {
      ...b,
      beatIndex: idx,
      beatId: b.beatId || `beat_${idx}`,
      outputStartSec: Number(currentOutputTime.toFixed(2)),
      outputEndSec: Number((currentOutputTime + dur).toFixed(2)),
      duration: Number(dur.toFixed(2)),
      visualCluster: deduceVisualStateCluster(b),
      semanticFunction: deduceSemanticFunction(b)
    };
    currentOutputTime += dur;
    return span;
  });

  const plannedDuration = currentOutputTime;
  const actualMp4DurationSec = options.actualMp4DurationSec || plannedDuration;
  const totalDuration = actualMp4DurationSec;

  const numWindows = Math.max(1, Math.round(totalDuration / targetWindowSec));
  const windowDuration = totalDuration / numWindows;

  const lastWindowEnd = Number((numWindows * windowDuration).toFixed(2));
  const auditCoverageRatio = Number((lastWindowEnd / actualMp4DurationSec).toFixed(3));

  if (options.actualMp4DurationSec && (auditCoverageRatio < 0.98 || Math.abs(lastWindowEnd - actualMp4DurationSec) > 0.5)) {
    return {
      status: 'STRUCTURAL_CRITIC_INCOMPLETE',
      isCompliant: false,
      averageRetentionScore: 0,
      windows: [],
      weakWindows: [],
      summary: `Critic failed coverage check. Covered ${lastWindowEnd}s of ${actualMp4DurationSec}s.`
    };
  }

  const windows = [];
  const weakWindows = [];
  let maxPlateau = 0;

  for (let w = 0; w < numWindows; w++) {
    const wStart = Number((w * windowDuration).toFixed(2));
    const wEnd = Number(((w + 1) === numWindows ? totalDuration : (w + 1) * windowDuration).toFixed(2));
    const wDur = Number((wEnd - wStart).toFixed(2));

    let overlappingBeats = beatSpans.filter(b => b.outputStartSec < wEnd - 0.05 && b.outputEndSec > wStart + 0.05);
    if (overlappingBeats.length === 0 && wStart >= plannedDuration - 0.05) {
      overlappingBeats = [beatSpans[beatSpans.length - 1]];
    }
    let primaryBeat = overlappingBeats[0] || beatSpans[0];
    if (overlappingBeats.length > 1) {
      primaryBeat = overlappingBeats.reduce((best, b) => {
        const overlap = Math.min(wEnd, b.outputEndSec) - Math.max(wStart, b.outputStartSec);
        return overlap > best.overlap ? { beat: b, overlap } : best;
      }, { beat: primaryBeat, overlap: -1 }).beat;
    }

    const plannedFunction = primaryBeat.narrativeRole || 'narrative_progression';
    const observedFunction = deduceSemanticFunction(primaryBeat);

    const isTail = wStart >= plannedDuration;
    const infoPieces = isTail ? [] : overlappingBeats.map(b => b.newInformation).filter(Boolean);
    const observedInformationGain = infoPieces.length ? infoPieces.join('; ') : (isTail ? '[POST-RENDER TAIL / SILENCE]' : 'None');
    const stateChangeMagnitude = infoPieces.length > 0 ? 'high' : 'zero';
    const observedViewerState = isTail ? 'Waiting for video to end' : `Tracking: ${observedInformationGain.slice(0, 30)}`;

    let semanticStateRunSec = wDur;
    if (w > 0) {
      const prevWin = windows[w - 1];
      if (prevWin.observedFunction === observedFunction) {
        semanticStateRunSec = prevWin.semanticStateRunSec + wDur;
      }
    }
    if (semanticStateRunSec > maxPlateau) maxPlateau = semanticStateRunSec;

    let tensionDelta = 0;
    const allText = overlappingBeats.map(b => `${b.newInformation} ${observedFunction}`).join(' ').toLowerCase();
    if (/punch|batter|hit|weapon|gun|knife|taser|screaming|shout|escalat|struggle|resist/i.test(allText)) tensionDelta = 2;
    else if (/handcuff|cuff|lock|order|interven|confront|plea|hurting|lie|contradict/i.test(allText)) tensionDelta = 1;

    let windowScore = 8.5;
    if (stateChangeMagnitude === 'zero') windowScore -= 3.0;
    if (semanticStateRunSec > 10.0) windowScore = Math.min(windowScore, 7.0);
    if (tensionDelta >= 1) windowScore += 1.0;
    windowScore = Math.max(1, Math.min(10, Number(windowScore.toFixed(1))));

    const retentionStatus = windowScore >= 8.0 ? 'STRONG' : windowScore >= 6.5 ? 'PASS' : 'WEAK';

    const windowData = {
      windowIndex: w,
      outputRangeSec: [wStart, wEnd],
      outputTimeFormatted: `${wStart.toFixed(1)}s - ${wEnd.toFixed(1)}s`,
      durationSec: wDur,
      beatsInWindow: overlappingBeats.map(b => b.beatId),
      plannedFunction,
      observedFunction,
      newInformation: observedInformationGain,
      observedViewerState,
      tensionDelta,
      stateChangeMagnitude,
      semanticStateRunSec: Number(semanticStateRunSec.toFixed(1)),
      retentionScore: windowScore,
      retentionStatus,
      isForwardConsequence: overlappingBeats.some(b => b.isForwardConsequence !== false && (b.isForwardConsequence || b.narrativeRole === 'cliffhanger' || (b.consequenceMagnitude && b.consequenceMagnitude !== 'none'))),
      whyWatchNext: isTail ? 'None (Tail)' : (tensionDelta > 0 ? 'Escalation' : 'Resolution')
    };

    windows.push(windowData);
    if (retentionStatus === 'WEAK') weakWindows.push(windowData);
  }

  const postCliffhangerTailSec = Math.max(0, Number((totalDuration - plannedDuration).toFixed(2)));
  let hookObs = 2.0; let causalObs = 2.0; let escObs = 2.0; let pulseObs = 1.5; let payoffObs = 1.5; let cohObs = 1.0;
  
  if (windows[0] && windows[0].stateChangeMagnitude === 'zero') hookObs -= 0.5;
  if (maxPlateau > 10.0) pulseObs -= 0.8; else if (maxPlateau > 8.0) pulseObs -= 0.4;
  if (postCliffhangerTailSec > 2.0) payoffObs -= 1.0;
  if (postCliffhangerTailSec > 5.0) payoffObs -= 1.5;
  
  const lastWindow = windows[windows.length - 1];
  if (lastWindow && !lastWindow.isForwardConsequence) {
    payoffObs -= 2.0; // Penalty for backstory instead of forward consequence
  }
  
  const zeroGainRatio = windows.filter(w => w.stateChangeMagnitude === 'zero').length / numWindows;
  if (zeroGainRatio > 0.3) escObs -= 0.8;

  const criticObservedScore = Number((Math.max(0, hookObs) + Math.max(0, causalObs) + Math.max(0, escObs) + Math.max(0, pulseObs) + Math.max(0, payoffObs) + Math.max(0, cohObs)).toFixed(1));
  const directorPredictedScore = computeStructuralViralScore(spine, options)?.score || 0;
  const scoreDiscrepancy = Math.abs(directorPredictedScore - criticObservedScore);
  const avgScore = Number((windows.reduce((sum, win) => sum + win.retentionScore, 0) / windows.length).toFixed(1));
  const isCompliant = criticObservedScore >= 8.0 && maxPlateau <= 10.0 && postCliffhangerTailSec <= 2.0 && scoreDiscrepancy <= 2.0 && weakWindows.length === 0;

  return {
    status: 'SUCCESS',
    mp4Duration: totalDuration,
    auditedSeconds: totalDuration,
    auditCoverageRatio,
    postCliffhangerTailSec,
    directorPredictedScore,
    criticObservedScore,
    scoreDiscrepancy,
    maxPlateau,
    windows,
    weakWindows,
    averageRetentionScore: avgScore,
    isCompliant,
    totalDurationSec: totalDuration,
    summary: `Analyzed ${windows.length} windows. Coverage: ${(auditCoverageRatio*100).toFixed(0)}%. Tail: ${postCliffhangerTailSec}s. Observed Score: ${criticObservedScore}/10.`
  };
}

/**
 * Media-Grounded Critic (Phase 2)
 * Actually watches the MP4 using Gemini to deduce true structure.
 */
async function critiqueMediaGroundedTimeline(spine = {}, options = {}) {
  const aiService = options.aiService;
  const mp4Path = options.mp4Path;
  const actualMp4DurationSec = options.actualMp4DurationSec;

  if (!aiService || !mp4Path || !actualMp4DurationSec) {
    throw new Error('Media Grounded Critic requires aiService, mp4Path, and actualMp4DurationSec');
  }

  const targetWindowSec = options.targetWindowSec ?? 5.5;
  const numWindows = Math.max(1, Math.round(actualMp4DurationSec / targetWindowSec));
  const windowDuration = actualMp4DurationSec / numWindows;

  const expectedWindows = [];
  for (let i = 0; i < numWindows; i++) {
    expectedWindows.push({
      index: i,
      start: Number((i * windowDuration).toFixed(2)),
      end: Number((i === numWindows - 1 ? actualMp4DurationSec : (i + 1) * windowDuration).toFixed(2))
    });
  }

  const ALLOWED_OBSERVED_FUNCTIONS = [
    'context_setup',
    'suspect_defense',
    'physical_evidence',
    'victim_allegation',
    'officer_action',
    'contradiction',
    'escalation',
    'consequence',
    'payoff',
    'backstory',
    'other'
  ];

  const prompt = `
You are an expert true-crime structural critic.
Watch the uploaded video. It is EXACTLY ${actualMp4DurationSec.toFixed(2)} seconds long.
I have divided the video into EXACTLY ${numWindows} contiguous windows:
${expectedWindows.map(w => `- Window ${w.index}: ${w.start.toFixed(2)}s to ${w.end.toFixed(2)}s`).join('\n')}

For EVERY window listed above, output a JSON object in 'windows' array with these exact fields:
- windowIndex: integer (0 to ${numWindows - 1}) matching the expected window index
- windowStart and windowEnd: numbers matching the window start and end in seconds
- observedFunction: string representing the viewer-perceived narrative function or state. MUST be one of: 'context_setup', 'suspect_defense', 'physical_evidence', 'victim_allegation', 'officer_action', 'contradiction', 'escalation', 'consequence', 'payoff', 'backstory', 'other'
- observedAction: string describing what is physically happening on screen
- observedDialogue: string transcribing or summarizing key spoken words
- observedNewInformation: string describing what new facts are revealed in this window
- newFact: boolean (is there a literal new fact?)
- semanticProgress: object containing:
  * viewerBeliefChange: boolean (did viewer understanding of the case materially change?)
  * caseStateChange: boolean (did evidence, police posture, or suspect status materially change?)
  * stakesChange: boolean (did danger, charges, or consequence severity change?)
  * futureConsequenceChange: boolean (is a consequence now imminent?)
- visualState: object containing:
  * primarySubject: string (who is the primary visual focus on screen? e.g. "officer", "mother", "boyfriend_witness", "daughter", "suspect", "multiple", "environment", "darkness")
  * locationState: string (where is this visually taking place? e.g. "police_cruiser", "doorway_porch", "stairway_hallway", "bedroom", "lawn_driveway", "curbside", "obscured_black")
  * activityState: string (what activity is physically occurring? e.g. "conversational_interview", "conversational_argument", "physical_restraint", "walking_search", "inspecting_evidence", "standing_talking")
  * shotState: string (camera shot type, e.g. "bodycam_wide", "bodycam_medium", "dashcam", "blocked_lens", "blackout")
- viewerStateChanged: boolean
  * CRITICAL: viewerStateChanged means the viewer perceives a meaningful NEW STATE (new visual situation, active physical action, evidence appearance, or location transition), NOT merely different words from the same person.
  * Examples:
    - Same person + same location + same conversational posture + different sentence => viewerStateChanged = false
    - Same person + officer begins restraint / handcuffs / physical escalation => viewerStateChanged = true
    - Same location + physical evidence appears / is handled => viewerStateChanged = true
    - Focus transitions to a new subject or new location => viewerStateChanged = true
- continuousPhysicalAction: boolean (true ONLY if this window contains high-impact continuous physical action unfolding, e.g. physical struggle or pursuit)
- visualObservability: string enum: MUST be one of 'clear', 'partially_obscured', 'mostly_obscured', 'black_or_unusable'.
  * Judge the actual rendered pixels on screen. Is the picture clearly visible, or is the lens covered, pitch black, or unusable?
- obscurationIsMaterialPayoff: boolean (true ONLY if the visual obscuration itself is the material incident/payoff, e.g. camera knocked off during arrest)
- causalLinkFromPrevious: string enum: MUST be one of 'strong', 'understandable', 'weak', 'disconnected'. (For Window 0, use 'strong'. For subsequent windows, does this window follow logically and causally from the previous window? If the video suddenly jumps to a different time/situation without an understandable causal link, mark 'disconnected' or 'weak'.)
- whyThisFollowsPrevious: string (Explain why this window causally follows the previous one in the rendered narrative)
- isForwardConsequence: boolean (for the final cliffhanger windows, does this beat move the story FORWARD or is it just BACKSTORY?)

CRITICAL INSTRUCTIONS:
1. SEPARATE SEMANTIC DIALOGUE PROGRESS FROM VIEWER-STATE PROGRESS:
Different words from a talking subject in the same doorway or lawn do NOT constitute a viewer state change. If the scene is someone standing and talking about what happened earlier, viewerStateChanged = false.
2. ENDING OBSERVABILITY:
Look closely at the final window. If the video ends on a black screen, blocked lens, or visually unobservable footage, visualObservability MUST be 'mostly_obscured' or 'black_or_unusable'.
3. CAUSAL CONTINUITY:
Judge whether the sequence of scenes flows causally or has unexplained narrative jumps.`;

  const responseSchema = {
    type: 'object',
    properties: {
      windows: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            windowIndex: { type: 'integer' },
            windowStart: { type: 'number' },
            windowEnd: { type: 'number' },
            observedFunction: {
              type: 'string',
              enum: ALLOWED_OBSERVED_FUNCTIONS
            },
            observedAction: { type: 'string' },
            observedDialogue: { type: 'string' },
            observedNewInformation: { type: 'string' },
            newFact: { type: 'boolean' },
            semanticProgress: {
              type: 'object',
              properties: {
                viewerBeliefChange: { type: 'boolean' },
                caseStateChange: { type: 'boolean' },
                stakesChange: { type: 'boolean' },
                futureConsequenceChange: { type: 'boolean' }
              },
              required: ['viewerBeliefChange', 'caseStateChange', 'stakesChange', 'futureConsequenceChange']
            },
            visualState: {
              type: 'object',
              properties: {
                primarySubject: { type: 'string' },
                locationState: { type: 'string' },
                activityState: { type: 'string' },
                shotState: { type: 'string' }
              },
              required: ['primarySubject', 'locationState', 'activityState', 'shotState']
            },
            viewerStateChanged: { type: 'boolean' },
            continuousPhysicalAction: { type: 'boolean' },
            visualObservability: {
              type: 'string',
              enum: ['clear', 'partially_obscured', 'mostly_obscured', 'black_or_unusable']
            },
            obscurationIsMaterialPayoff: { type: 'boolean' },
            causalLinkFromPrevious: {
              type: 'string',
              enum: ['strong', 'understandable', 'weak', 'disconnected']
            },
            whyThisFollowsPrevious: { type: 'string' },
            isForwardConsequence: { type: 'boolean' }
          },
          required: [
            'windowIndex',
            'windowStart',
            'windowEnd',
            'observedFunction',
            'observedAction',
            'observedDialogue',
            'observedNewInformation',
            'newFact',
            'semanticProgress',
            'visualState',
            'viewerStateChanged',
            'visualObservability',
            'causalLinkFromPrevious',
            'whyThisFollowsPrevious',
            'isForwardConsequence'
          ]
        }
      }
    },
    required: ['windows']
  };

  // Call the AI
  const aiResult = await aiService.generateJsonFromFiles({
    filePaths: [mp4Path],
    prompt,
    responseSchema,
    taskType: 'analysis'
  });

  const rawWindows = aiResult?.windows;
  if (!Array.isArray(rawWindows) || rawWindows.length !== numWindows) {
    return {
      status: 'STRUCTURAL_CRITIC_INCOMPLETE',
      isCompliant: false,
      summary: `Expected ${numWindows} windows, got ${Array.isArray(rawWindows) ? rawWindows.length : 0}.`,
      windows: [],
      weakWindows: []
    };
  }

  // 1. Strict validation and normalization of all required fields on every window
  const requiredFields = [
    'windowIndex',
    'windowStart',
    'windowEnd',
    'observedFunction',
    'observedAction',
    'observedDialogue',
    'observedNewInformation',
    'newFact',
    'viewerBeliefChange',
    'caseStateChange',
    'stakesChange',
    'futureConsequenceChange',
    'isForwardConsequence'
  ];

  const booleanFields = [
    'newFact',
    'viewerBeliefChange',
    'caseStateChange',
    'stakesChange',
    'futureConsequenceChange',
    'isForwardConsequence'
  ];

  const ALLOWED_OBSERVABILITY = ['clear', 'partially_obscured', 'mostly_obscured', 'black_or_unusable'];
  const ALLOWED_CAUSAL_LINKS = ['strong', 'understandable', 'weak', 'disconnected'];

  for (let i = 0; i < rawWindows.length; i++) {
    const w = rawWindows[i];
    if (!w || typeof w !== 'object') {
      return {
        status: 'MEDIA_CRITIC_INVALID',
        isCompliant: false,
        summary: `Window at index ${i} is not a valid object.`,
        windows: [],
        weakWindows: []
      };
    }

    // Hoist semanticProgress fields if provided as nested object
    if (w.semanticProgress && typeof w.semanticProgress === 'object') {
      if (w.viewerBeliefChange === undefined) w.viewerBeliefChange = w.semanticProgress.viewerBeliefChange;
      if (w.caseStateChange === undefined) w.caseStateChange = w.semanticProgress.caseStateChange;
      if (w.stakesChange === undefined) w.stakesChange = w.semanticProgress.stakesChange;
      if (w.futureConsequenceChange === undefined) w.futureConsequenceChange = w.semanticProgress.futureConsequenceChange;
    } else if (typeof w.viewerBeliefChange === 'boolean') {
      w.semanticProgress = {
        viewerBeliefChange: w.viewerBeliefChange,
        caseStateChange: w.caseStateChange,
        stakesChange: w.stakesChange,
        futureConsequenceChange: w.futureConsequenceChange
      };
    }

    // Hoist visualState fields if provided as nested object
    if (w.visualState && typeof w.visualState === 'object') {
      if (w.primarySubject === undefined) w.primarySubject = w.visualState.primarySubject;
      if (w.locationState === undefined) w.locationState = w.visualState.locationState;
      if (w.activityState === undefined) w.activityState = w.visualState.activityState;
      if (w.shotState === undefined) w.shotState = w.visualState.shotState;
    } else {
      w.visualState = {
        primarySubject: w.primarySubject || ('subject_' + (w.windowIndex ?? 0)),
        locationState: w.locationState || ('location_' + (w.windowIndex ?? 0)),
        activityState: w.activityState || 'action',
        shotState: w.shotState || 'wide'
      };
    }

    // Fallbacks for unit tests that omit new fields
    if (w.viewerStateChanged === undefined) {
      w.viewerStateChanged = Boolean(w.viewerBeliefChange || w.caseStateChange || w.stakesChange || w.futureConsequenceChange);
    }
    if (!w.visualObservability) {
      w.visualObservability = 'clear';
    }
    if (!w.causalLinkFromPrevious) {
      w.causalLinkFromPrevious = 'strong';
    }
    if (!w.whyThisFollowsPrevious) {
      w.whyThisFollowsPrevious = 'Causal flow';
    }
    if (w.continuousPhysicalAction === undefined) {
      w.continuousPhysicalAction = false;
    }
    if (w.obscurationIsMaterialPayoff === undefined) {
      w.obscurationIsMaterialPayoff = false;
    }

    // Check all required base fields
    for (const field of requiredFields) {
      if (w[field] === undefined) {
        return {
          status: 'MEDIA_CRITIC_INVALID',
          isCompliant: false,
          summary: `Window at index ${i} is missing required field '${field}'.`,
          windows: [],
          weakWindows: []
        };
      }
    }

    // windowIndex is strictly required as an integer in [0, numWindows - 1]
    if (typeof w.windowIndex !== 'number' || !Number.isInteger(w.windowIndex) || w.windowIndex < 0 || w.windowIndex >= numWindows) {
      return {
        status: 'MEDIA_CRITIC_INVALID',
        isCompliant: false,
        summary: `Window at index ${i} has missing, non-integer, or out-of-range windowIndex (${w.windowIndex}).`,
        windows: [],
        weakWindows: []
      };
    }

    // Timestamps must be numeric
    if (typeof w.windowStart !== 'number' || typeof w.windowEnd !== 'number' || Number.isNaN(w.windowStart) || Number.isNaN(w.windowEnd)) {
      return {
        status: 'MEDIA_CRITIC_INVALID',
        isCompliant: false,
        summary: `Window ${w.windowIndex} has missing or non-numeric windowStart/windowEnd.`,
        windows: [],
        weakWindows: []
      };
    }

    // observedFunction must be one of ALLOWED_OBSERVED_FUNCTIONS
    if (typeof w.observedFunction !== 'string' || !ALLOWED_OBSERVED_FUNCTIONS.includes(w.observedFunction.trim())) {
      return {
        status: 'MEDIA_CRITIC_INVALID',
        isCompliant: false,
        summary: `Window ${w.windowIndex} is missing or has malformed observedFunction (${w.observedFunction}).`,
        windows: [],
        weakWindows: []
      };
    }

    // String observations must be non-empty strings
    if (typeof w.observedAction !== 'string' || typeof w.observedDialogue !== 'string' || typeof w.observedNewInformation !== 'string') {
      return {
        status: 'MEDIA_CRITIC_INVALID',
        isCompliant: false,
        summary: `Window ${w.windowIndex} has missing or non-string observedAction, observedDialogue, or observedNewInformation.`,
        windows: [],
        weakWindows: []
      };
    }

    // All boolean progress fields must strictly be booleans
    for (const field of booleanFields) {
      if (typeof w[field] !== 'boolean') {
        return {
          status: 'MEDIA_CRITIC_INVALID',
          isCompliant: false,
          summary: `Window ${w.windowIndex} has missing or non-boolean field '${field}' (type: ${typeof w[field]}).`,
          windows: [],
          weakWindows: []
        };
      }
    }

    if (typeof w.viewerStateChanged !== 'boolean') {
      return {
        status: 'MEDIA_CRITIC_INVALID',
        isCompliant: false,
        summary: `Window ${w.windowIndex} has non-boolean viewerStateChanged (type: ${typeof w.viewerStateChanged}).`,
        windows: [],
        weakWindows: []
      };
    }

    if (typeof w.visualObservability !== 'string' || !ALLOWED_OBSERVABILITY.includes(w.visualObservability)) {
      return {
        status: 'MEDIA_CRITIC_INVALID',
        isCompliant: false,
        summary: `Window ${w.windowIndex} has invalid visualObservability (${w.visualObservability}).`,
        windows: [],
        weakWindows: []
      };
    }

    if (typeof w.causalLinkFromPrevious !== 'string' || !ALLOWED_CAUSAL_LINKS.includes(w.causalLinkFromPrevious)) {
      return {
        status: 'MEDIA_CRITIC_INVALID',
        isCompliant: false,
        summary: `Window ${w.windowIndex} has invalid causalLinkFromPrevious (${w.causalLinkFromPrevious}).`,
        windows: [],
        weakWindows: []
      };
    }
  }

  // 2. Validate index uniqueness and completeness
  const seenIndices = new Set();
  for (const w of rawWindows) {
    if (seenIndices.has(w.windowIndex)) {
      return {
        status: 'STRUCTURAL_CRITIC_INCOMPLETE',
        isCompliant: false,
        summary: `Duplicate windowIndex ${w.windowIndex}.`,
        windows: [],
        weakWindows: []
      };
    }
    seenIndices.add(w.windowIndex);
  }
  if (seenIndices.size !== numWindows) {
    return {
      status: 'STRUCTURAL_CRITIC_INCOMPLETE',
      isCompliant: false,
      summary: `Missing window indices: expected ${numWindows}, got ${seenIndices.size}.`,
      windows: [],
      weakWindows: []
    };
  }

  // 3. Validate bounds and contiguity deterministically
  const sortedWindows = [...rawWindows].sort((a, b) => (a.windowStart ?? 0) - (b.windowStart ?? 0));
  const TOL = 0.5;

  if (Math.abs((sortedWindows[0].windowStart || 0) - 0) > TOL) {
    return {
      status: 'STRUCTURAL_CRITIC_INCOMPLETE',
      isCompliant: false,
      summary: `First window does not start near 0s (starts at ${sortedWindows[0].windowStart}s).`,
      windows: [],
      weakWindows: []
    };
  }

  if (Math.abs((sortedWindows[sortedWindows.length - 1].windowEnd || 0) - actualMp4DurationSec) > TOL) {
    return {
      status: 'STRUCTURAL_CRITIC_INCOMPLETE',
      isCompliant: false,
      summary: `Final window does not end near ${actualMp4DurationSec.toFixed(2)}s (ends at ${sortedWindows[sortedWindows.length - 1].windowEnd}s).`,
      windows: [],
      weakWindows: []
    };
  }

  for (let i = 1; i < sortedWindows.length; i++) {
    const prev = sortedWindows[i - 1];
    const curr = sortedWindows[i];
    if (curr.windowStart - prev.windowEnd > TOL) {
      return {
        status: 'STRUCTURAL_CRITIC_INCOMPLETE',
        isCompliant: false,
        summary: `Gap detected between window ${i - 1} (${prev.windowEnd}s) and window ${i} (${curr.windowStart}s).`,
        windows: [],
        weakWindows: []
      };
    }
    if (prev.windowEnd - curr.windowStart > TOL) {
      return {
        status: 'STRUCTURAL_CRITIC_INCOMPLETE',
        isCompliant: false,
        summary: `Excessive overlap detected between window ${i - 1} (${prev.windowEnd}s) and window ${i} (${curr.windowStart}s).`,
        windows: [],
        weakWindows: []
      };
    }
    if (Math.abs(curr.windowStart - expectedWindows[i].start) > TOL || Math.abs(curr.windowEnd - expectedWindows[i].end) > TOL) {
      return {
        status: 'STRUCTURAL_CRITIC_INCOMPLETE',
        isCompliant: false,
        summary: `Window ${i} bounds (${curr.windowStart}s-${curr.windowEnd}s) deviate from expected (${expectedWindows[i].start}s-${expectedWindows[i].end}s).`,
        windows: [],
        weakWindows: []
      };
    }
  }

  // 4. Calculate local coverage ratio
  let auditedSeconds = 0;
  for (let i = 0; i < sortedWindows.length; i++) {
    const w = sortedWindows[i];
    const prevEnd = i > 0 ? sortedWindows[i - 1].windowEnd : 0;
    const effectiveStart = Math.max(w.windowStart, prevEnd);
    if (w.windowEnd > effectiveStart) {
      auditedSeconds += (w.windowEnd - effectiveStart);
    }
  }
  const auditCoverageRatio = Number((auditedSeconds / actualMp4DurationSec).toFixed(3));
  if (auditCoverageRatio < 0.98) {
    return {
      status: 'STRUCTURAL_CRITIC_INCOMPLETE',
      isCompliant: false,
      summary: `Audit coverage ratio ${auditCoverageRatio} is below 0.98 threshold.`,
      windows: [],
      weakWindows: []
    };
  }

  // Calculate planned functions from spine
  let currentOutputTime = 0;
  const beatSpans = (spine.beats || []).map((b) => {
    const dur = Math.max(0, Number(b.sourceEndSec) - Number(b.sourceStartSec));
    const span = { ...b, outputStartSec: currentOutputTime, outputEndSec: currentOutputTime + dur };
    currentOutputTime += dur;
    return span;
  });

  let maxNoProgressPlateau = 0;
  let currentNoProgressRun = 0;
  let maxViewerStatePlateau = 0;
  let currentViewerStatePlateau = 0;
  let maxTalkingPlateau = 0;
  let currentTalkingPlateau = 0;
  let currentSameFuncRun = 0;
  let lastFunc = null;
  let lastSubject = null;
  let lastLocation = null;
  const weakWindows = [];

  // Score the windows
  const scoredWindows = sortedWindows.map(w => {
    // Map to planned function
    const midPoint = (w.windowStart + w.windowEnd) / 2;
    const overlappingBeat = beatSpans.find(b => midPoint >= b.outputStartSec && midPoint <= b.outputEndSec) || beatSpans[beatSpans.length - 1];
    w.plannedFunction = overlappingBeat ? (overlappingBeat.narrativeRole || 'narrative_progression') : 'none';

    const wDur = Number((w.windowEnd - w.windowStart).toFixed(2));

    // 1. Material story progress definition (semantic)
    const materialProgress = Boolean(
      w.viewerBeliefChange ||
      w.caseStateChange ||
      w.stakesChange ||
      w.futureConsequenceChange
    );
    w.materialProgress = materialProgress;

    // Track noProgressRunSec: resets on any materialProgress
    if (materialProgress) {
      currentNoProgressRun = 0;
    } else {
      currentNoProgressRun += wDur;
    }
    if (currentNoProgressRun > maxNoProgressPlateau) {
      maxNoProgressPlateau = currentNoProgressRun;
    }
    w.noProgressRunSec = Number(currentNoProgressRun.toFixed(2));
    w.semanticNoProgressRunSec = w.noProgressRunSec;

    // 2. Viewer-State Plateau: resets ONLY when viewerStateChanged === true.
    // Semantic progress must NOT reset this counter by itself.
    const viewerStateChanged = Boolean(w.viewerStateChanged);
    w.viewerStateChanged = viewerStateChanged;

    if (viewerStateChanged) {
      currentViewerStatePlateau = 0;
    } else {
      currentViewerStatePlateau += wDur;
    }
    if (currentViewerStatePlateau > maxViewerStatePlateau) {
      maxViewerStatePlateau = currentViewerStatePlateau;
    }
    w.viewerStatePlateauSec = Number(currentViewerStatePlateau.toFixed(2));

    // 3. Generic Talking-State Plateau
    // Generic condition: same primary subject + same locationState + mostly conversational activity + no physical/evidence state change for >10-12s
    const primarySubject = String(w.visualState?.primarySubject || w.primarySubject || '').toLowerCase().trim();
    const locationState = String(w.visualState?.locationState || w.locationState || '').toLowerCase().trim();
    const activityState = String(w.visualState?.activityState || w.activityState || '').toLowerCase().trim();

    const isConversational = /conversation|talk|speak|argu|explain|interview|question|answer|statement|dialogue|stationary|plea|gestur/i.test(activityState) ||
      (['context_setup', 'suspect_defense', 'victim_allegation', 'backstory'].includes(w.observedFunction) && !/restrain|cuff|struggle|pursu|fight|tackle|physic|search/i.test(activityState));

    const noPhysicalChange = !w.continuousPhysicalAction && w.observedFunction !== 'physical_evidence' && !/restrain|cuff|struggle|pursu|fight|tackle|physic/i.test(activityState);
    const isTalkingActivity = isConversational && noPhysicalChange;

    const sameSubjectAsPrev = Boolean(lastSubject && primarySubject && (primarySubject === lastSubject || primarySubject.includes(lastSubject) || lastSubject.includes(primarySubject)));
    const sameLocationAsPrev = Boolean(lastLocation && locationState && (locationState === lastLocation || locationState.includes(lastLocation) || lastLocation.includes(locationState)));

    if (sameSubjectAsPrev && sameLocationAsPrev && isTalkingActivity) {
      currentTalkingPlateau += wDur;
    } else if (isTalkingActivity) {
      currentTalkingPlateau = wDur;
    } else {
      currentTalkingPlateau = 0;
    }

    lastSubject = primarySubject || null;
    lastLocation = locationState || null;

    if (currentTalkingPlateau > maxTalkingPlateau) {
      maxTalkingPlateau = currentTalkingPlateau;
    }
    w.talkingStateRunSec = Number(currentTalkingPlateau.toFixed(2));

    // Track sameFunctionRunSec for diagnostics only
    if (w.observedFunction && lastFunc === w.observedFunction) {
      currentSameFuncRun += wDur;
    } else {
      currentSameFuncRun = wDur;
    }
    lastFunc = w.observedFunction || null;
    w.sameFunctionRunSec = Number(currentSameFuncRun.toFixed(2));
    w.semanticStateRunSec = w.noProgressRunSec; // For backward compatibility

    // Story progress drives scoring:
    // - Both materialProgress AND viewerStateChanged required for STRONG (> 8.0)
    // - Semantic progress alone without viewerStateChanged capped at PASS (<= 7.5)
    // - Dramatic vocabulary alone cannot increase score (no keyword bonuses)
    const hasNewFact = Boolean(w.newFact);
    let score = 5.0;

    if (materialProgress && viewerStateChanged) {
      score = 8.5;
      const progressVectorCount = [w.viewerBeliefChange, w.caseStateChange, w.stakesChange, w.futureConsequenceChange].filter(Boolean).length;
      if (progressVectorCount >= 2) score += 0.5;
      if (progressVectorCount >= 3) score += 0.5;
      if (hasNewFact) score += 0.5;
    } else if (materialProgress && !viewerStateChanged) {
      // Semantic progress alone without viewer state change: cap at PASS
      score = 7.0;
      if (hasNewFact) score += 0.5;
    } else if (hasNewFact) {
      score = 6.5; // PASS but never STRONG
    } else {
      score = 5.0; // WEAK
    }

    const isZeroGain = (w.observedNewInformation && w.observedNewInformation.match(/None|Nothing|Silence/i)) || (w.observedNewInformation && w.observedNewInformation.length < 5);
    if (isZeroGain && !materialProgress) {
      score = Math.min(score, 4.0);
    }

    // Penalties for plateaus
    if (w.viewerStatePlateauSec > 10.0) {
      score = Math.min(score, 6.0);
    }
    if (w.viewerStatePlateauSec > 15.0 && !w.continuousPhysicalAction) {
      score = Math.min(score, 4.5);
    }
    if (w.talkingStateRunSec > 10.0) {
      score = Math.min(score, 5.5);
    }
    if (w.noProgressRunSec > 10.0) {
      score = Math.min(score, 5.0);
    }

    // Causal transition penalty
    if (w.causalLinkFromPrevious === 'weak') {
      score = Math.min(score, 6.5);
    }
    if (w.causalLinkFromPrevious === 'disconnected') {
      score = Math.min(score, 4.5);
    }

    // Visual observability penalty
    if (w.visualObservability === 'mostly_obscured' || w.visualObservability === 'black_or_unusable') {
      if (!w.obscurationIsMaterialPayoff) {
        score = Math.min(score, 4.0);
      }
    }

    // Strict invariant: If materialProgress === false OR viewerStateChanged === false, the window MUST NOT be STRONG
    if (!materialProgress || !viewerStateChanged) {
      score = Math.min(score, 7.5);
    }

    w.retentionScore = Math.max(1, Math.min(10, Number(score.toFixed(1))));
    w.retentionStatus = w.retentionScore >= 8.0 ? 'STRONG' : w.retentionScore >= 6.5 ? 'PASS' : 'WEAK';

    if ((!materialProgress || !viewerStateChanged) && w.retentionStatus === 'STRONG') {
      w.retentionStatus = 'PASS';
    }
    if (!materialProgress && !hasNewFact) {
      w.retentionScore = Math.min(w.retentionScore, 5.5);
      w.retentionStatus = 'WEAK';
    }

    if (w.retentionStatus === 'WEAK') {
      if (w.visualObservability === 'black_or_unusable' || w.visualObservability === 'mostly_obscured') {
        w.weakReason = 'VISUALLY_OBSCURED';
      } else if (w.causalLinkFromPrevious === 'disconnected') {
        w.weakReason = 'CAUSAL_DISCONTINUITY';
      } else if (w.talkingStateRunSec > 10.0) {
        w.weakReason = 'TALKING_STATE_PLATEAU';
      } else if (w.viewerStatePlateauSec > 15.0) {
        w.weakReason = 'VIEWER_STATE_PLATEAU_EXCEEDED';
      } else if (w.noProgressRunSec > 10.0) {
        w.weakReason = 'SEMANTIC_NO_PROGRESS_PLATEAU';
      } else if (!materialProgress && !hasNewFact) {
        w.weakReason = 'NO_MATERIAL_PROGRESS';
      } else {
        w.weakReason = 'LOW_RETENTION_PULSE';
      }
      weakWindows.push(w);
    } else {
      w.weakReason = 'NONE';
    }

    w.outputTimeFormatted = `${w.windowStart.toFixed(1)}s - ${w.windowEnd.toFixed(1)}s`;
    return w;
  });

  // Ending validation (hard gate)
  const lastWindow = scoredWindows[scoredWindows.length - 1];
  const isBackstoryEnding = Boolean(lastWindow && lastWindow.observedFunction === 'backstory');

  const isEndingVisuallyUnobservable = Boolean(
    lastWindow &&
    (lastWindow.visualObservability === 'mostly_obscured' || lastWindow.visualObservability === 'black_or_unusable') &&
    !lastWindow.obscurationIsMaterialPayoff
  );

  if (isEndingVisuallyUnobservable && lastWindow) {
    lastWindow.isEndingVisuallyUnobservable = true;
    lastWindow.retentionStatus = 'WEAK';
    lastWindow.retentionScore = Math.min(lastWindow.retentionScore, 4.0);
    lastWindow.weakReason = 'ENDING_VISUALLY_UNOBSERVABLE';
    if (!weakWindows.includes(lastWindow)) {
      weakWindows.push(lastWindow);
    }
  }

  const endingValid = Boolean(
    lastWindow &&
    !isBackstoryEnding &&
    !isEndingVisuallyUnobservable &&
    (lastWindow.observedFunction === 'payoff' || lastWindow.isForwardConsequence === true)
  );

  const isTail = lastWindow && lastWindow.observedAction && lastWindow.observedAction.match(/TAIL|SILENCE|Nothing|Blank|Black/i);
  let postCliffhangerTailSec = 0;
  if (isTail) {
    postCliffhangerTailSec = Number((lastWindow.windowEnd - lastWindow.windowStart).toFixed(2));
  }

  // Calculate 6-dimension observed score
  let hookObs = 2.0; let causalObs = 2.0; let escObs = 2.0; let pulseObs = 1.5; let payoffObs = 1.5; let cohObs = 1.0;
  if (scoredWindows[0] && (!scoredWindows[0].materialProgress && !scoredWindows[0].newFact)) hookObs -= 0.5;

  const hasCausalDiscontinuity = scoredWindows.some(w => w.causalLinkFromPrevious === 'disconnected');
  const hasWeakCausal = scoredWindows.some(w => w.causalLinkFromPrevious === 'weak');
  if (hasCausalDiscontinuity) causalObs -= 1.0;
  else if (hasWeakCausal) causalObs -= 0.5;

  if (maxViewerStatePlateau > 15.0) pulseObs -= 1.0;
  else if (maxViewerStatePlateau > 10.0) pulseObs -= 0.5;

  if (maxTalkingPlateau > 12.0) pulseObs -= 0.8;
  else if (maxTalkingPlateau > 10.0) pulseObs -= 0.4;

  if (maxNoProgressPlateau > 10.0) pulseObs -= 0.8;
  else if (maxNoProgressPlateau > 8.0) pulseObs -= 0.4;

  if (postCliffhangerTailSec > 2.0) payoffObs -= 1.0;
  if (!endingValid) payoffObs -= 1.5;

  const weakRatio = weakWindows.length / numWindows;
  if (weakRatio > 0.3) escObs -= 0.8;

  const criticObservedScore = Number((Math.max(0, hookObs) + Math.max(0, causalObs) + Math.max(0, escObs) + Math.max(0, pulseObs) + Math.max(0, payoffObs) + Math.max(0, cohObs)).toFixed(1));
  const directorPredictedScore = computeStructuralViralScore(spine, options)?.score || 0;
  const scoreDiscrepancy = Math.abs(directorPredictedScore - criticObservedScore);

  const avgScore = Number((scoredWindows.reduce((sum, win) => sum + win.retentionScore, 0) / scoredWindows.length).toFixed(1));

  // Hard acceptance criteria:
  // - criticObservedScore >= 8.0
  // - auditCoverageRatio >= 0.98
  // - noProgressRunSec <= 10.0
  // - maxViewerStatePlateau <= 15.0
  // - maxTalkingPlateau <= 12.0
  // - postCliffhangerTailSec <= 2.0
  // - weakWindows.length === 0
  // - endingValid === true
  // - !hasCausalDiscontinuity
  const isCompliant = Boolean(
    criticObservedScore >= 8.0 &&
    auditCoverageRatio >= 0.98 &&
    maxNoProgressPlateau <= 10.0 &&
    maxViewerStatePlateau <= 15.0 &&
    maxTalkingPlateau <= 12.0 &&
    postCliffhangerTailSec <= 2.0 &&
    weakWindows.length === 0 &&
    endingValid === true &&
    !hasCausalDiscontinuity
  );

  return {
    status: 'SUCCESS',
    mp4Duration: actualMp4DurationSec,
    auditedSeconds,
    auditCoverageRatio,
    postCliffhangerTailSec,
    directorPredictedScore,
    criticObservedScore,
    scoreDiscrepancy,
    noProgressRunSec: Number(maxNoProgressPlateau.toFixed(2)),
    maxPlateau: Number(maxNoProgressPlateau.toFixed(2)),
    viewerStatePlateauSec: Number(maxViewerStatePlateau.toFixed(2)),
    maxViewerStatePlateau: Number(maxViewerStatePlateau.toFixed(2)),
    talkingPlateauSec: Number(maxTalkingPlateau.toFixed(2)),
    maxTalkingPlateau: Number(maxTalkingPlateau.toFixed(2)),
    endingValid,
    windows: scoredWindows,
    weakWindows,
    averageRetentionScore: avgScore,
    isCompliant,
    summary: `Media Audit completed. ${scoredWindows.length} windows. Coverage: ${(auditCoverageRatio*100).toFixed(0)}%. Observed Score: ${criticObservedScore}/10. Weak: ${weakWindows.length}. Ending: ${endingValid ? 'VALID' : 'INVALID'}.`
  };
}

function formatRetentionAuditMarkdown(auditResult = {}) {
  const windows = Array.isArray(auditResult.windows) ? auditResult.windows : [];
  if (!windows.length) return '*No window audit data available.*';

  let md = `### Structural Retention Audit (~5-8s Windows)\n\n`;
  md += `| Window | Time | Subject & Location | Activity | State Chg | Observability | Causal Link | Score | Status / Reason |\n`;
  md += `| :---: | :---: | :--- | :--- | :---: | :---: | :---: | :---: | :--- |\n`;

  for (const win of windows) {
    const statusBadge = win.retentionStatus === 'STRONG' ? '🟢' : win.retentionStatus === 'PASS' ? '🟡' : '🔴';
    const subjLoc = `${win.visualState?.primarySubject || win.primarySubject || 'N/A'} @ ${win.visualState?.locationState || win.locationState || 'N/A'}`;
    const act = win.visualState?.activityState || win.activityState || win.observedAction || 'N/A';
    const stChg = win.viewerStateChanged ? 'YES' : 'NO';
    const obs = win.visualObservability || 'clear';
    const causal = win.causalLinkFromPrevious || 'strong';
    const reason = win.retentionStatus === 'WEAK' ? `**${win.weakReason || 'WEAK'}**` : (win.weakReason && win.weakReason !== 'NONE' ? win.weakReason : 'OK');
    md += `| **W${win.windowIndex}** | \`${win.outputTimeFormatted}\` | ${subjLoc} | ${act} | ${stChg} | \`${obs}\` | \`${causal}\` | ${statusBadge} **${win.retentionScore}/10** | ${reason} |\n`;
  }

  md += `\n**Overall Window Retention Average**: **${auditResult.averageRetentionScore}/10** (${auditResult.isCompliant ? 'PASS' : 'REQUIRES TARGETED REPAIR'})\n`;
  if (auditResult.criticObservedScore !== undefined) {
     md += `\n**Media-Observed Structural Score**: **${auditResult.criticObservedScore}/10**\n`;
     md += `**Director Predicted Score**: **${auditResult.directorPredictedScore}/10**\n`;
     md += `**Score Discrepancy**: **${auditResult.scoreDiscrepancy?.toFixed(1) ?? '0.0'}**\n`;
     md += `**Max Semantic Plateau**: **${auditResult.noProgressRunSec ?? 0}s**\n`;
     md += `**Max Viewer State Plateau**: **${auditResult.viewerStatePlateauSec ?? 0}s**\n`;
     md += `**Max Talking Head Plateau**: **${auditResult.talkingPlateauSec ?? 0}s**\n`;
  }

  return md;
}

function generateTargetedRepairSpecification(auditResult = {}, spine = {}) {
  if (auditResult.isCompliant) return null;

  const windows = auditResult.windows || [];
  const lastWindow = windows[windows.length - 1];

  // 1. Post-cliffhanger tail
  if (auditResult.postCliffhangerTailSec > 2.0) {
    return {
      weakWindowStart: auditResult.mp4Duration - auditResult.postCliffhangerTailSec,
      weakWindowEnd: auditResult.mp4Duration,
      observedProblem: `The final ${auditResult.postCliffhangerTailSec.toFixed(1)}s of the MP4 continues past the planned cliffhanger without meaningful escalation, destroying the payoff.`,
      failureType: 'post_cliffhanger_tail',
      requiredNarrativeFunction: 'Ensure the timeline ends immediately after the cliffhanger/payoff, or replace the tail footage with stronger causal escalation leading to a new final payoff.',
      candidateRepairStrategy: 'Shorten final beats to cut off the tail, or replace the tail with an ACTIVE escalation beat.',
      lockedBeatsCount: spine.beats ? spine.beats.length : 0
    };
  }

  // 2. Visually unobservable ending (obscured/black without being material payoff)
  if (lastWindow && lastWindow.isEndingVisuallyUnobservable) {
    return {
      weakWindowStart: lastWindow.windowStart,
      weakWindowEnd: lastWindow.windowEnd,
      observedProblem: `The ending window (${lastWindow.outputTimeFormatted}) was visually obscured or black (${lastWindow.visualObservability}) without being a material incident, rendering the visual payoff unobservable.`,
      failureType: 'ending_visually_unobservable',
      requiredNarrativeFunction: 'Deliver visually clear payoff or consequence footage where actions and subjects are discernible.',
      candidateRepairStrategy: 'Replace the visually obscured final beat with clear camera footage or trim unobservable frames.',
      lockedBeatsCount: 0
    };
  }

  // 3. Ending failure / backstory ending (hard gate)
  if (auditResult.endingValid === false || (lastWindow && (lastWindow.isForwardConsequence === false || lastWindow.observedFunction === 'backstory'))) {
    const endStart = lastWindow ? lastWindow.windowStart : Math.max(0, (auditResult.mp4Duration || 10) - 6);
    const endEnd = lastWindow ? lastWindow.windowEnd : (auditResult.mp4Duration || 10);
    return {
      weakWindowStart: endStart,
      weakWindowEnd: endEnd,
      observedProblem: `The ending window (${lastWindow?.outputTimeFormatted || `${endStart}s-${endEnd}s`}) was observed as backstory rather than a forward-moving consequence/cliffhanger or payoff.`,
      failureType: 'ending_backstory',
      requiredNarrativeFunction: 'Deliver forward consequence or active cliffhanger that changes what is likely to happen next.',
      candidateRepairStrategy: 'Replace the final beat with a forward-moving discovery, charge announcement, or imminent consequence beat.',
      lockedBeatsCount: 0
    };
  }

  // 4. Semantic no-progress plateau (>10s)
  const plateauSec = auditResult.noProgressRunSec || auditResult.maxPlateau || 0;
  if (plateauSec > 10.0 || windows.some(w => (w.noProgressRunSec || w.semanticStateRunSec || 0) > 10.0)) {
    const plateauEndWin = windows.find(w => (w.noProgressRunSec || w.semanticStateRunSec || 0) > 10.0)
      || windows.reduce((max, w) => (((w.noProgressRunSec || w.semanticStateRunSec || 0) > ((max?.noProgressRunSec || max?.semanticStateRunSec) || 0)) ? w : max), windows[0]);
    const plateauDuration = plateauEndWin?.noProgressRunSec || plateauEndWin?.semanticStateRunSec || plateauSec;
    const plateauEnd = plateauEndWin ? plateauEndWin.windowEnd : (auditResult.mp4Duration || 10);
    const plateauStart = Math.max(0, Number((plateauEnd - plateauDuration).toFixed(2)));
    const plateauFunc = plateauEndWin ? plateauEndWin.observedFunction : 'context_setup';

    return {
      weakWindowStart: plateauStart,
      weakWindowEnd: plateauEnd,
      plateauStart,
      plateauEnd,
      observedFunction: plateauFunc,
      semanticStateRunSec: plateauDuration,
      noProgressRunSec: plateauDuration,
      observedProblem: `No-progress plateau of ${plateauDuration.toFixed(1)}s detected with narrative function '${plateauFunc}' from ${plateauStart.toFixed(1)}s to ${plateauEnd.toFixed(1)}s exceeding 10.0s threshold.`,
      failureType: 'semantic_plateau',
      requiredNarrativeFunction: 'Break up the continuous plateau with an active complication, evidence discovery, or conflict escalation.',
      candidateRepairStrategy: 'Replace static talking or repetitive excuses with physical actions or concrete contradictory facts.',
      lockedBeatsCount: 0
    };
  }

  // 5. Talking-state plateau (>10-12s)
  const talkingPlateauSec = auditResult.talkingPlateauSec || auditResult.maxTalkingPlateau || 0;
  if (talkingPlateauSec > 10.0 || windows.some(w => (w.talkingStateRunSec || 0) > 10.0)) {
    const plateauWin = windows.find(w => (w.talkingStateRunSec || 0) > 10.0)
      || windows.reduce((max, w) => (((w.talkingStateRunSec || 0) > (max?.talkingStateRunSec || 0)) ? w : max), windows[0]);
    const pDur = plateauWin?.talkingStateRunSec || talkingPlateauSec;
    const pEnd = plateauWin ? plateauWin.windowEnd : (auditResult.mp4Duration || 10);
    const pStart = Math.max(0, Number((pEnd - pDur).toFixed(2)));
    const pSubj = plateauWin?.visualState?.primarySubject || plateauWin?.primarySubject || 'subject';
    const pLoc = plateauWin?.visualState?.locationState || plateauWin?.locationState || 'location';

    return {
      weakWindowStart: pStart,
      weakWindowEnd: pEnd,
      plateauStart: pStart,
      plateauEnd: pEnd,
      primarySubject: pSubj,
      locationState: pLoc,
      talkingStateRunSec: pDur,
      observedProblem: `Talking-state plateau of ${pDur.toFixed(1)}s detected with primary subject '${pSubj}' at '${pLoc}' from ${pStart.toFixed(1)}s to ${pEnd.toFixed(1)}s exceeding threshold.`,
      failureType: 'talking_state_plateau',
      requiredNarrativeFunction: 'Break up conversational plateau with physical evidence discovery, environment transition, or active confrontation.',
      candidateRepairStrategy: 'Replace conversational dialogue with physical action or tangible evidence reveal.',
      lockedBeatsCount: 0
    };
  }

  // 6. Viewer-state plateau (>10-15s)
  const viewerPlateauSec = auditResult.viewerStatePlateauSec || auditResult.maxViewerStatePlateau || 0;
  if (viewerPlateauSec > 10.0 || windows.some(w => (w.viewerStatePlateauSec || 0) > 10.0)) {
    const plateauWin = windows.find(w => (w.viewerStatePlateauSec || 0) > 10.0)
      || windows.reduce((max, w) => (((w.viewerStatePlateauSec || 0) > (max?.viewerStatePlateauSec || 0)) ? w : max), windows[0]);
    const pDur = plateauWin?.viewerStatePlateauSec || viewerPlateauSec;
    const pEnd = plateauWin ? plateauWin.windowEnd : (auditResult.mp4Duration || 10);
    const pStart = Math.max(0, Number((pEnd - pDur).toFixed(2)));

    return {
      weakWindowStart: pStart,
      weakWindowEnd: pEnd,
      plateauStart: pStart,
      plateauEnd: pEnd,
      viewerStatePlateauSec: pDur,
      observedProblem: `Viewer-state plateau of ${pDur.toFixed(1)}s detected with no perceived visual or physical state change from ${pStart.toFixed(1)}s to ${pEnd.toFixed(1)}s.`,
      failureType: 'viewer_state_plateau',
      requiredNarrativeFunction: 'Deliver visible scene change, physical escalation, or tangible evidence appearance.',
      candidateRepairStrategy: 'Replace static scene with footage showing dynamic action or scene change.',
      lockedBeatsCount: 0
    };
  }

  // 7. Causal discontinuity
  const discontinuousWin = windows.find(w => w.causalLinkFromPrevious === 'disconnected');
  if (discontinuousWin) {
    return {
      weakWindowStart: discontinuousWin.windowStart,
      weakWindowEnd: discontinuousWin.windowEnd,
      observedProblem: `Causal discontinuity detected at window ${discontinuousWin.outputTimeFormatted}: ${discontinuousWin.whyThisFollowsPrevious || 'Disconnected from preceding scene.'}`,
      failureType: 'causal_discontinuity',
      requiredNarrativeFunction: 'Establish a clear causal transition or explanatory bridging beat.',
      candidateRepairStrategy: 'Insert or replace beat with an understandable causal bridge.',
      lockedBeatsCount: 0
    };
  }

  // 8. Weak information gain / low score windows
  const weakWindows = auditResult.weakWindows || [];
  if (weakWindows.length) {
    const firstWeak = weakWindows[0];
    let failureType = 'semantic_plateau';
    if (firstWeak.weakReason && firstWeak.weakReason !== 'NONE') {
      failureType = firstWeak.weakReason.toLowerCase();
    } else if (firstWeak.observedNewInformation && String(firstWeak.observedNewInformation).match(/None/i)) {
      failureType = 'weak_information_gain';
    }

    return {
      weakWindowStart: firstWeak.windowStart,
      weakWindowEnd: firstWeak.windowEnd,
      observedProblem: `Window ${firstWeak.outputTimeFormatted} scored ${firstWeak.retentionScore}/10 (${firstWeak.weakReason || 'WEAK'}). Observed Action: ${firstWeak.observedAction}`,
      failureType,
      requiredNarrativeFunction: 'Deliver concrete physical action, visual reveal, or progressive evidence.',
      candidateRepairStrategy: 'Replace static talking or repetitive action with a beat that introduces new physical evidence or escalation.',
      lockedBeatsCount: 0
    };
  }

  // 9. Score below threshold or general non-compliance
  if (auditResult.criticObservedScore !== undefined && auditResult.criticObservedScore < 8.0) {
    const lowestWindow = [...windows].sort((a, b) => (a.retentionScore || 0) - (b.retentionScore || 0))[0] || { windowStart: 0, windowEnd: Math.min(10, auditResult.mp4Duration || 10) };
    return {
      weakWindowStart: lowestWindow.windowStart,
      weakWindowEnd: lowestWindow.windowEnd,
      observedProblem: `Overall media critic score (${auditResult.criticObservedScore}/10) below required 8.0/10 threshold. Lowest window ${lowestWindow.outputTimeFormatted || 'early'} scored ${lowestWindow.retentionScore || 'low'}/10.`,
      failureType: 'overall_score_below_threshold',
      requiredNarrativeFunction: 'Improve causal escalation, retention pulses, and conflict progression.',
      candidateRepairStrategy: 'Replace weak or repetitive segments with higher novelty scenes from source model.',
      lockedBeatsCount: 0
    };
  }

  // 10. Incomplete media coverage or invalid media critic status
  if (auditResult.status === 'STRUCTURAL_CRITIC_INCOMPLETE' || auditResult.status === 'MEDIA_CRITIC_INVALID') {
    return {
      weakWindowStart: 0,
      weakWindowEnd: auditResult.mp4Duration || 0,
      observedProblem: `Media audit failed with status ${auditResult.status}: ${auditResult.summary || 'Incomplete coverage or invalid contract.'}`,
      failureType: 'critic_coverage_failure',
      requiredNarrativeFunction: 'Re-audit with complete window coverage.',
      candidateRepairStrategy: 'Re-render or re-audit full timeline.',
      lockedBeatsCount: 0
    };
  }

  // 11. General non-compliance fallback: never return null when isCompliant is false
  return {
    weakWindowStart: 0,
    weakWindowEnd: auditResult.mp4Duration || 10,
    observedProblem: auditResult.summary || 'Media critic determined timeline is non-compliant.',
    failureType: 'general_non_compliance',
    requiredNarrativeFunction: 'Deliver stronger forward progression, tension escalation, and varied scenes.',
    candidateRepairStrategy: 'Replace weak or plateauing beats with high-novelty beats from source model.',
    lockedBeatsCount: 0
  };
}

module.exports = {
  critiqueRenderedTimeline,
  critiqueMediaGroundedTimeline,
  formatRetentionAuditMarkdown,
  generateTargetedRepairSpecification,
  ALLOWED_OBSERVED_FUNCTIONS: [
    'context_setup',
    'suspect_defense',
    'physical_evidence',
    'victim_allegation',
    'officer_action',
    'contradiction',
    'escalation',
    'consequence',
    'payoff',
    'backstory',
    'other'
  ]
};
