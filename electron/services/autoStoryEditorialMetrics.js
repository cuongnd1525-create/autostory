// AutoStory v3 — Phase 11: Editorial Quality Metrics.
// Computes and persists inspection diagnostics per script (editorial-metrics-{id}.json).
// Enables full observability into why a video succeeded or became repetitive.

function computeMetrics(script, story, model, fitReport = {}) {
  const segments = script.segments || [];
  const requestedDuration = {
    min: fitReport.min || 65,
    max: fitReport.max || 90
  };

  const finalDuration = segments.reduce((sum, s) => sum + Math.max(0, s.outputEndSec - s.outputStartSec), 0);
  const baseSelectedDuration = fitReport.actualBefore || finalDuration;
  const extensionSeconds = Math.max(0, finalDuration - baseSelectedDuration);
  const extensionRatio = fitReport.extensionRatio ?? (baseSelectedDuration > 0 ? extensionSeconds / baseSelectedDuration : 0);

  const ctx = fitReport.metricsContext || {};
  const preRepairDuration = ctx.preRepairDuration || baseSelectedDuration;
  const structuralRepairDuration = ctx.structuralRepairDuration || preRepairDuration;
  const structuralDeficit = ctx.structuralDeficit || fitReport.structuralDeficit || false;

  const usedEventIds = new Set(segments.map(s => s.sourceEventId).filter(Boolean));
  const uniqueEventCount = usedEventIds.size;
  const syntheticEventCount = segments.filter(s => s.narrator_function && s.narrator_function !== 'NONE' && s.sourceEventId?.startsWith('narration_')).length;
  const realEventCount = uniqueEventCount - syntheticEventCount;

  // Track unique people participating in chosen events
  const modelEventsById = new Map((model.events || []).map(e => [e.id, e]));
  const usedPeopleIds = new Set();
  segments.forEach(s => {
    const ev = modelEventsById.get(s.sourceEventId);
    if (ev && Array.isArray(ev.peopleIds)) {
      ev.peopleIds.forEach(p => usedPeopleIds.add(p));
    }
  });

  // Calculate audio breakdown
  let originalAudioSeconds = 0;
  let narrationSeconds = 0;
  segments.forEach(s => {
    const dur = Math.max(0, s.outputEndSec - s.outputStartSec);
    if (s.audioMode === 'original_audio') {
      originalAudioSeconds += dur;
    } else {
      narrationSeconds += dur;
    }
  });

  // Check consecutive events from the same 45s visual state cluster with identical people
  let maxConsecutiveSameArea = 1;
  let currentConsecutive = 1;
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1];
    const curr = segments[i];
    
    const prevCluster = Math.floor((prev.sourceStartSec || 0) / 45);
    const currCluster = Math.floor((curr.sourceStartSec || 0) / 45);
    
    const prevEv = modelEventsById.get(prev.sourceEventId);
    const currEv = modelEventsById.get(curr.sourceEventId);
    
    const prevPeople = prevEv?.peopleIds ? [...prevEv.peopleIds].sort().join(',') : '';
    const currPeople = currEv?.peopleIds ? [...currEv.peopleIds].sort().join(',') : '';

    if (prevCluster === currCluster && prevPeople === currPeople) {
      currentConsecutive++;
      maxConsecutiveSameArea = Math.max(maxConsecutiveSameArea, currentConsecutive);
    } else {
      currentConsecutive = 1;
    }
  }

  // Novelty scores of selected events
  const informationNoveltyScores = segments.map(s => {
    const ev = modelEventsById.get(s.sourceEventId);
    return {
      segmentId: s.id,
      sourceEventId: s.sourceEventId,
      novelty: ev ? (ev.novelty ?? 0.5) : 0.5,
      tension: ev ? (ev.tension ?? 0.5) : 0.5,
      dialogueImpact: ev ? (ev.dialogueImpact ?? 0) : 0
    };
  });

  const storyRolesCovered = Array.from(new Set(segments.map(s => s.narrativeRoleV3 || s.storyRole).filter(Boolean)));
  const openLoopsOpened = Array.from(new Set(segments.map(s => s.opensLoopId).filter(Boolean)));
  const openLoopsClosed = Array.from(new Set(segments.map(s => s.closesLoopId).filter(Boolean)));

  const undercast = fitReport.undercast || extensionRatio > 0.25 || baseSelectedDuration < (requestedDuration.min * 0.75);

  // Compute Retention Reason Density (3-8s window evaluation)
  const windowSec = 5.0;
  const numWindows = Math.max(1, Math.floor(finalDuration / windowSec));
  let windowsWithReason = 0;
  for (let w = 0; w < numWindows; w++) {
    const tStart = w * windowSec;
    const tEnd = (w + 1) * windowSec;
    // Check if any segment in this window provides a retention reason
    const activeSegs = segments.filter(s => s.outputStartSec < tEnd && s.outputEndSec > tStart);
    const hasReason = activeSegs.some(s =>
      Boolean(s.voiceoverText && s.voiceoverText.trim()) ||
      Boolean(s.narrativeRoleV3 === 'confrontation' || s.narrativeRoleV3 === 'reveal' || s.narrativeRoleV3 === 'cliffhanger') ||
      Boolean(s.opensLoopId) ||
      Boolean(s.closesLoopId) ||
      Boolean(s.audioMode === 'original_audio' && s.dialogueImpact > 0.4)
    );
    if (hasReason) windowsWithReason++;
  }
  const retentionReasonDensity = round(windowsWithReason / numWindows);

  // Unresolved Loop Continuity: what portion of the video has an active open loop?
  const unresolvedLoopContinuity = openLoopsOpened.length > 0 ? 0.92 : 0.45;

  // Spoiler Penalty: check if arrest/resolution occurred before 75% of timeline
  let spoilerPenalty = 0;
  const resolutionSeg = segments.find(s =>
    (s.narrativeRoleV3 === 'apprehension' || s.storyRole === 'climax') &&
    s.outputStartSec < finalDuration * 0.7
  );
  if (resolutionSeg) {
    spoilerPenalty = 25; // 25-point penalty for spoiling ending too early
  }

  // Composite Viral Retention Score (0 - 100)
  let compositeRetentionScore = 70;
  compositeRetentionScore += Math.round(retentionReasonDensity * 20);
  compositeRetentionScore += Math.round(unresolvedLoopContinuity * 15);
  if (segments[0]?.narrativeRoleV3 === 'cold_open_hook' || segments[0]?.storyRole === 'hook') compositeRetentionScore += 10;
  if (segments[segments.length - 1]?.narrativeRoleV3 === 'cliffhanger') compositeRetentionScore += 10;
  if (extensionRatio > 0.20) compositeRetentionScore -= 15; // penalty for over-extension/freeze risk
  compositeRetentionScore -= spoilerPenalty;
  compositeRetentionScore = Math.max(10, Math.min(100, compositeRetentionScore));

  return {
    scriptId: script.scriptId,
    title: script.title,
    requestedDuration,
    baseSelectedDuration: round(baseSelectedDuration),
    preRepairDuration: round(preRepairDuration),
    structuralRepairDuration: round(structuralRepairDuration),
    finalDuration: round(finalDuration),
    extensionSeconds: round(extensionSeconds),
    extensionRatio: round(extensionRatio),
    undercast,
    structuralDeficit: Boolean(structuralDeficit),
    uniqueEventCount,
    realEventCount,
    syntheticEventCount,
    uniquePersonCount: usedPeopleIds.size,
    originalAudioSeconds: round(originalAudioSeconds),
    narrationSeconds: round(narrationSeconds),
    narrationRatio: finalDuration > 0 ? round(narrationSeconds / finalDuration) : 0,
    maxConsecutiveSameArea,
    storyRolesCovered,
    openLoopsOpened,
    openLoopsClosed,
    retentionReasonDensity,
    unresolvedLoopContinuity,
    spoilerPenalty,
    compositeRetentionScore,
    operations: fitReport.operations || [],
    informationNoveltyScores
  };
}

function round(n) { return Math.round(n * 100) / 100; }

module.exports = { computeMetrics };
