// Semantic Synchronization and Edit Decision Solver for Recap Mode.
// Solves mapping between SpeechUnits (narration clauses) and VisualEvents.
// Enforces 5-tier mismatch resolution ladder, visual lead (0-500ms),
// strict retiming bounds, and shot reuse policies.

const { validateEditDecision, safeNumber, safeText, safeArray } = require("./recapTypes");

class RecapSyncSolver {
  constructor(options = {}) {
    this.targetVisualLeadSec = safeNumber(options.targetVisualLeadSec, 0.25); // 250ms lead
    this.minVisualLeadSec = safeNumber(options.minVisualLeadSec, 0.10);       // 100ms
    this.maxVisualLeadSec = safeNumber(options.maxVisualLeadSec, 0.45);       // 450ms
    this.minShotDurationSec = safeNumber(options.minShotDurationSec, 1.2);
    this.maxShotDurationSec = safeNumber(options.maxShotDurationSec, 8.0);
    this.allowShotReuse = Boolean(options.allowShotReuse);

    // Speed bounds strictly clamped
    this.minVoiceSpeed = safeNumber(options.minVoiceSpeed, 0.97);
    this.maxVoiceSpeed = safeNumber(options.maxVoiceSpeed, 1.05);
    this.minVideoSpeedNormal = safeNumber(options.minVideoSpeedNormal, 0.92);
    this.maxVideoSpeedNormal = safeNumber(options.maxVideoSpeedNormal, 1.08);
    this.minVideoSpeedTalking = safeNumber(options.minVideoSpeedTalking, 0.98);
    this.maxVideoSpeedTalking = safeNumber(options.maxVideoSpeedTalking, 1.02);

    // Natural pause between speech units
    this.interUnitPaddingSec = safeNumber(options.interUnitPaddingSec, 0.20);
    this.logger = options.logger || console;
  }

  /**
   * Main entry point: solves synchronization across all speech units and visual events.
   *
   * @param {Object} params
   * @param {Array<Object>} params.speechUnits
   * @param {Array<Object>|Map<string, Object>} params.visualEvents
   * @param {Object} [params.audioTracks] - { [speechUnitId]: { audioPath, durationSec } }
   * @param {Array<Object>} [params.scenes] - Scene boundaries from SceneDetectionService
   * @param {number} [params.sourceDurationSec] - Source video duration
   * @returns {{ decisions: Array<Object>, traceability: Array<Object>, metrics: Object, rewriteRecommendations: Array<Object> }}
   */
  solve({
    speechUnits = [],
    visualEvents = [],
    audioTracks = {},
    scenes = [],
    sourceDurationSec = 0
  } = {}) {
    const eventsMap = this._normalizeEventsMap(visualEvents);
    const scenesList = safeArray(scenes);
    const usedIntervals = []; // [{ start, end, eventId, speechUnitId }]
    const decisions = [];
    const traceability = [];
    const rewriteRecommendations = [];
    const clauseBudgets = [];

    let currentTimelineSec = 0.0;

    for (let uIdx = 0; uIdx < speechUnits.length; uIdx++) {
      const unit = speechUnits[uIdx];
      const audioInfo = audioTracks[unit.id] || {};
      const rawAudioDuration = safeNumber(audioInfo.durationSec, safeNumber(unit.target_duration_budget, 3.0));
      const audioPath = safeText(audioInfo.audioPath, "");

      // Resolve visual events linked to this unit or its clauses
      const assignedEvents = this._resolveEventsForUnit(unit, eventsMap);

      // Solve clips for this speech unit
      const unitSolution = this._solveUnitClips({
        unit,
        assignedEvents,
        rawAudioDuration,
        scenesList,
        usedIntervals,
        sourceDurationSec,
        currentTimelineSec,
        unitIndex: uIdx,
        clauseSpans: audioInfo.clauseSpans
      });
      clauseBudgets.push(...(unitSolution.clauseBudgets || []));

      // Update used intervals tracking
      for (const clip of unitSolution.clips) {
        usedIntervals.push({
          start: clip.source_start,
          end: clip.source_end,
          eventId: clip.event_id,
          speechUnitId: unit.id
        });
      }

      const decisionObj = {
        speech_unit_id: unit.id,
        audio_path: audioPath,
        audio_duration: rawAudioDuration,
        voice_tempo: unitSolution.voiceTempo,
        text: unit.text,
        clips: unitSolution.clips,
        total_video_duration: unitSolution.totalVideoDuration
      };

      const validatedDecision = validateEditDecision(decisionObj, uIdx);
      decisions.push(validatedDecision);

      // Build traceability entries
      for (const clip of unitSolution.clips) {
        traceability.push({
          speechUnitId: unit.id,
          text: unit.text,
          eventId: clip.event_id,
          sourceStartSec: clip.source_start,
          sourceEndSec: clip.source_end,
          outputStartSec: clip.output_start,
          outputEndSec: clip.output_end,
          leadMs: clip.lead_ms,
          videoSpeed: clip.video_speed,
          voiceTempo: unitSolution.voiceTempo,
          lipSyncRisk: clip.lip_sync_risk,
          adaptationTier: unitSolution.tierUsed,
          notes: unitSolution.notes
        });
      }

      if (unitSolution.needsRewrite) {
        rewriteRecommendations.push({
          speechUnitId: unit.id,
          text: unit.text,
          currentDuration: rawAudioDuration,
          targetDuration: unitSolution.suggestedTargetDuration,
          deltaRatio: unitSolution.deltaRatio,
          reason: unitSolution.rewriteReason,
          clauseBudgets: unitSolution.clauseBudgets
        });
      }

      // Advance timeline: visual spans to the end of its clips, plus audio lead & inter-unit buffer
      const unitVideoEnd = unitSolution.clips.length > 0
        ? unitSolution.clips[unitSolution.clips.length - 1].output_end
        : currentTimelineSec + rawAudioDuration;

      const effectiveAudioDuration = rawAudioDuration / unitSolution.voiceTempo;
      const unitAudioEnd = currentTimelineSec + (unitSolution.clips[0]?.lead_ms || 250) / 1000 + effectiveAudioDuration;

      currentTimelineSec = Math.max(unitVideoEnd, unitAudioEnd) + this.interUnitPaddingSec;
    }

    // Compute metrics
    const totalDuration = currentTimelineSec > 0 ? Number((currentTimelineSec - this.interUnitPaddingSec).toFixed(3)) : 0;
    const totalWords = speechUnits.reduce((acc, u) => acc + (u.text || "").split(/\s+/).filter(Boolean).length, 0);
    const avgVisualLeadMs = traceability.length > 0
      ? Math.round(traceability.reduce((sum, t) => sum + t.leadMs, 0) / traceability.length)
      : 250;

    const metrics = {
      totalTimelineDurationSec: totalDuration,
      totalSpeechUnits: speechUnits.length,
      totalClips: decisions.reduce((acc, d) => acc + d.clips.length, 0),
      totalWords,
      averageVisualLeadMs: avgVisualLeadMs,
      rewriteRecommendationCount: rewriteRecommendations.length,
      usedIntervalCount: usedIntervals.length,
      semanticTimingMismatchCount: rewriteRecommendations.filter(item => item.clauseBudgets?.some(group => !group.passed)).length
    };

    return {
      decisions,
      traceability,
      metrics,
      clauseBudgets,
      rewriteRecommendations
    };
  }

  /**
   * Internal helper: Solves video clips and retiming for a single speech unit.
   */
  _solveUnitClips({
    unit,
    assignedEvents,
    rawAudioDuration,
    scenesList,
    usedIntervals,
    sourceDurationSec,
    currentTimelineSec,
    unitIndex,
    clauseSpans
  }) {
    if (clauseSpans?.length > 1) return this._solveAlignedUnit({ unit, assignedEvents, rawAudioDuration, scenesList,
      usedIntervals, currentTimelineSec, clauseSpans });
    // Determine visual lead
    const leadSec = Math.min(this.maxVisualLeadSec, Math.max(this.minVisualLeadSec, this.targetVisualLeadSec));
    const leadMs = Math.round(leadSec * 1000);

    // Target total video duration for this unit
    // Video should lead by leadSec, play throughout narration, and post-roll by ~0.15s
    const postRollSec = 0.15;
    const targetVideoDuration = rawAudioDuration + leadSec + postRollSec;

    let tierUsed = 0; // 0 = perfect fit, 1 = rewrite recommended, 2 = footage extended/trimmed, 3 = lead adjusted, 4 = video speed retimed, 5 = voice retimed
    let needsRewrite = false;
    let rewriteReason = "";
    let deltaRatio = 0;
    let voiceTempo = 1.0;
    let notes = "Direct fit";

    // If no events matched, create a synthetic fallback span
    const candidateEvents = assignedEvents.length > 0 ? assignedEvents : [this._createFallbackEvent(unit, sourceDurationSec, unitIndex)];

    // Check primary event duration
    const totalRawEventDuration = candidateEvents.reduce((acc, ev) => acc + (ev.source_end - ev.source_start), 0);
    deltaRatio = Math.abs(rawAudioDuration - totalRawEventDuration) / Math.max(0.5, totalRawEventDuration);

    // Tier 1: Flag significant mismatches (> 35% delta)
    if (deltaRatio > 0.35) {
      tierUsed = 1;
      needsRewrite = true;
      rewriteReason = rawAudioDuration > totalRawEventDuration
        ? `Speech duration (${rawAudioDuration.toFixed(2)}s) exceeds visual footage (${totalRawEventDuration.toFixed(2)}s) by ${(deltaRatio * 100).toFixed(0)}%.`
        : `Speech duration (${rawAudioDuration.toFixed(2)}s) is much shorter than visual beat (${totalRawEventDuration.toFixed(2)}s).`;
    }

    // Allocate target video duration across candidate events
    const allocatedClips = [];
    let clipTimelineStart = currentTimelineSec;

    for (let eIdx = 0; eIdx < candidateEvents.length; eIdx++) {
      const ev = candidateEvents[eIdx];
      const evShare = (ev.source_end - ev.source_start) / Math.max(0.1, totalRawEventDuration);
      const targetClipDuration = candidateEvents.length === 1
        ? targetVideoDuration
        : Math.max(this.minShotDurationSec, targetVideoDuration * evShare);

      // Resolve footage boundaries considering reuse policy
      let sourceStart = ev.source_start;
      let sourceEnd = ev.source_end;
      const rawClipDuration = sourceEnd - sourceStart;

      // Tier 2: Footage selection adjustment
      if (!this.allowShotReuse && this._isOverlapping(sourceStart, sourceEnd, usedIntervals)) {
        // Try finding clean neighboring window in same scene or shift start
        const shifted = this._findAlternativeInterval(sourceStart, sourceEnd, scenesList, usedIntervals, sourceDurationSec);
        sourceStart = shifted.start;
        sourceEnd = shifted.end;
      }

      if (targetClipDuration > (sourceEnd - sourceStart)) {
        // Speech longer than visual: expand within scene
        const expanded = this._expandWithinScene(sourceStart, sourceEnd, targetClipDuration, scenesList, sourceDurationSec);
        sourceStart = expanded.start;
        sourceEnd = expanded.end;
        if (tierUsed < 2) tierUsed = 2;
        notes = "Footage extended within scene boundary";
      } else if (targetClipDuration < (sourceEnd - sourceStart) * 0.85) {
        // Speech shorter than visual: trim gracefully (keep action focal point)
        sourceEnd = Number((sourceStart + Math.max(this.minShotDurationSec, targetClipDuration)).toFixed(3));
        if (tierUsed < 2) tierUsed = 2;
        notes = "Footage trimmed to narration length";
      }

      // Tier 4: Video speed retiming calculation
      let currentDuration = sourceEnd - sourceStart;
      let videoSpeed = 1.0;
      const isLipSyncRisk = Boolean(ev.lip_sync_risk || (ev.face_closeup && ev.dialogue_present));

      const minVideoSpeed = isLipSyncRisk ? this.minVideoSpeedTalking : this.minVideoSpeedNormal;
      const maxVideoSpeed = isLipSyncRisk ? this.maxVideoSpeedTalking : this.maxVideoSpeedNormal;

      if (currentDuration > 0 && Math.abs(currentDuration - targetClipDuration) > 0.2) {
        const requiredSpeed = currentDuration / targetClipDuration;
        videoSpeed = Math.max(minVideoSpeed, Math.min(maxVideoSpeed, requiredSpeed));
        if (Math.abs(videoSpeed - 1.0) > 0.01 && tierUsed < 4) {
          tierUsed = 4;
          notes = `Video retimed to ${videoSpeed.toFixed(2)}x (${isLipSyncRisk ? "talking head clamped" : "normal motion"})`;
        }
      }

      const effectiveClipDuration = Number((currentDuration / videoSpeed).toFixed(3));
      const clipTimelineEnd = Number((clipTimelineStart + effectiveClipDuration).toFixed(3));

      allocatedClips.push({
        clip_id: `clip_${unit.id}_${eIdx + 1}`,
        event_id: ev.id,
        source_start: Number(sourceStart.toFixed(3)),
        source_end: Number(sourceEnd.toFixed(3)),
        output_start: Number(clipTimelineStart.toFixed(3)),
        output_end: clipTimelineEnd,
        video_speed: Number(videoSpeed.toFixed(3)),
        lead_ms: eIdx === 0 ? leadMs : 0,
        face_closeup: Boolean(ev.face_closeup),
        lip_sync_risk: isLipSyncRisk,
        focus_x: ev.focus_x ?? 0.5, focus_y: ev.focus_y ?? 0.5
      });

      clipTimelineStart = clipTimelineEnd;
    }

    const totalVideoDuration = Number((clipTimelineStart - currentTimelineSec).toFixed(3));

    // Tier 5: Voice tempo retiming if residual mismatch remains
    const requiredAudioDuration = Math.max(0.5, totalVideoDuration - leadSec - postRollSec);
    if (Math.abs(rawAudioDuration - requiredAudioDuration) > 0.3) {
      const requiredTempo = rawAudioDuration / requiredAudioDuration;
      voiceTempo = Math.max(this.minVoiceSpeed, Math.min(this.maxVoiceSpeed, requiredTempo));
      if (Math.abs(voiceTempo - 1.0) > 0.01) {
        if (tierUsed < 5) tierUsed = 5;
        notes = `${notes}; Voice tempo adjusted to ${voiceTempo.toFixed(2)}x`;
      }
    }

    return {
      clips: allocatedClips,
      voiceTempo: Number(voiceTempo.toFixed(3)),
      totalVideoDuration,
      tierUsed,
      needsRewrite,
      rewriteReason,
      deltaRatio: Number(deltaRatio.toFixed(3)),
      suggestedTargetDuration: Number(totalRawEventDuration.toFixed(2)),
      notes
    };
  }

  _solveAlignedUnit({ unit, assignedEvents, rawAudioDuration, scenesList, usedIntervals, currentTimelineSec, clauseSpans }) {
    const lead = Math.min(this.maxVisualLeadSec, Math.max(this.minVisualLeadSec, this.targetVisualLeadSec));
    const events = new Map(assignedEvents.map(event => [event.id, event])), occupied = [...usedIntervals], clips = [], budgets = [];
    const freeWindows = (start, end) => {
      let windows = [{ start, end }];
      if (this.allowShotReuse) return windows;
      for (const used of occupied) windows = windows.flatMap(window => {
        if (used.end <= window.start || used.start >= window.end) return [window];
        return [{ start: window.start, end: Math.min(window.end, used.start) }, { start: Math.max(window.start, used.end), end: window.end }].filter(window => window.end - window.start >= .1);
      });
      return windows.sort((a, b) => b.end - b.start - (a.end - a.start));
    };
    for (let groupIndex = 0; groupIndex < clauseSpans.length; groupIndex++) {
      const group = clauseSpans[groupIndex];
      const start = groupIndex === 0 ? currentTimelineSec : currentTimelineSec + group.startSec;
      const end = groupIndex + 1 < clauseSpans.length ? currentTimelineSec + clauseSpans[groupIndex + 1].startSec : currentTimelineSec + lead + rawAudioDuration + .15;
      const candidates = group.visual_event_ids.map(id => events.get(id)).filter(Boolean);
      const weight = candidates.reduce((sum, event) => sum + event.source_end - event.source_start, 0);
      let cursor = start, availableDuration = 0, groundedCapacity = 0; const missingEventIds = [];
      for (const event of candidates) {
        const wanted = (end - start) * (event.source_end - event.source_start) / Math.max(.01, weight);
        const scene = scenesList.find(s => event.source_start >= (s.startSec ?? s.start ?? 0) && event.source_end <= (s.endSec ?? s.end ?? 0));
        const from = scene ? Math.max(scene.startSec ?? scene.start, event.source_start - 1.5) : event.source_start;
        const to = scene ? Math.min(scene.endSec ?? scene.end, event.source_end + 1.5) : event.source_end;
        const window = freeWindows(from, to)[0];
        if (!window) { missingEventIds.push(event.id); cursor += wanted; continue; }
        if (!this.allowShotReuse) {
          let reserve = 0;
          for (let next = groupIndex + 1; next < clauseSpans.length; next++) {
            const later = clauseSpans[next];
            const laterEnd = next + 1 < clauseSpans.length ? clauseSpans[next + 1].startSec : lead + rawAudioDuration + .15;
            const laterEvents = later.visual_event_ids.map(id => events.get(id)).filter(Boolean);
            const laterWeight = laterEvents.reduce((sum, item) => sum + item.source_end - item.source_start, 0);
            for (const item of laterEvents) {
              if (item.source_end <= window.start || item.source_start >= window.end) continue;
              const laterWanted = (laterEnd - later.startSec) * (item.source_end - item.source_start) / Math.max(.01, laterWeight);
              reserve += Math.max(.1, (laterWanted - 1.5 / laterEvents.length) * this.minVideoSpeedNormal);
            }
          }
          // Reserve a distinct source interval for later clauses referencing
          // this footage; consuming the entire window here creates false shortages.
          if (reserve > 0) window.end = Math.max(window.start + .1, window.end - reserve);
        }
        const lipRisk = Boolean(event.lip_sync_risk || (event.face_closeup && event.dialogue_present));
        const minSpeed = lipRisk ? this.minVideoSpeedTalking : this.minVideoSpeedNormal;
        groundedCapacity += (window.end - window.start) / minSpeed;
        const speed = Math.max(minSpeed, Math.min(1, (window.end - window.start) / wanted));
        const sourceEnd = Math.min(window.end, window.start + wanted * speed);
        const available = (sourceEnd - window.start) / speed;
        availableDuration += available;
        clips.push({ clip_id: `clip_${unit.id}_group${groupIndex + 1}_${clips.length + 1}`, event_id: event.id,
          source_start: Number(window.start.toFixed(3)), source_end: Number(sourceEnd.toFixed(3)),
          output_start: Number(cursor.toFixed(3)), output_end: Number((cursor + wanted).toFixed(3)),
          video_speed: speed, lead_ms: clips.length === 0 ? Math.round(lead * 1000) : 0,
          face_closeup: Boolean(event.face_closeup), lip_sync_risk: lipRisk, focus_x: event.focus_x ?? .5, focus_y: event.focus_y ?? .5 });
        occupied.push({ start: window.start, end: sourceEnd }); cursor += wanted;
      }
      const wanted = end - start, hold = Math.max(0, wanted - availableDuration);
      budgets.push({ speechUnitId: unit.id, clauseIds: group.clauseIds, text: group.text, visual_event_ids: group.visual_event_ids,
        currentDuration: Number(wanted.toFixed(3)), targetDuration: Number(Math.min(wanted, availableDuration + 1.5).toFixed(3)),
        maxGroundedDuration: Number((groundedCapacity + 1.5).toFixed(3)),
        targetWordCount: Math.max(3, Math.floor(group.text.split(/\s+/).filter(Boolean).length * Math.min(1, (availableDuration + 1.5) / wanted) * .94)),
        holdSec: Number(hold.toFixed(3)), missingEventIds, passed: hold <= 1.5 && missingEventIds.length === 0 });
    }
    const needsRewrite = budgets.some(budget => !budget.passed);
    return { clips, voiceTempo: 1, totalVideoDuration: rawAudioDuration + lead + .15,
      tierUsed: needsRewrite ? 1 : 0, needsRewrite, clauseBudgets: budgets,
      rewriteReason: needsRewrite ? "Some measured clauses outlast their grounded footage. Shorten those clauses or select additional supporting events; preserve the overall spoken budget." : "",
      deltaRatio: 0, suggestedTargetDuration: budgets.reduce((sum, budget) => sum + budget.targetDuration, 0),
      notes: "Visual switches follow measured spoken clause boundaries; voice tempo unchanged." };
  }

  /**
   * Expands an interval backwards and forwards within scene boundaries up to desired duration.
   */
  _expandWithinScene(start, end, targetDuration, scenesList, sourceDurationSec) {
    const currentDur = end - start;
    if (currentDur >= targetDuration) return { start, end };

    const deficit = targetDuration - currentDur;
    // Find enclosing scene
    const scene = scenesList.find(s => start >= (s.startSec || s.start || 0) && end <= (s.endSec || s.end || Infinity));
    const sceneMin = scene ? (scene.startSec || scene.start || 0) : 0;
    const sceneMax = scene ? (scene.endSec || scene.end || sourceDurationSec || end + 10) : (sourceDurationSec || end + 10);

    // Expand symmetrically or as much as scene permits
    const expandBack = Math.min(start - sceneMin, deficit / 2);
    const newStart = Math.max(0, start - expandBack);

    const remainingDeficit = deficit - (start - newStart);
    const expandForward = Math.min(sceneMax - end, remainingDeficit);
    const newEnd = Math.min(sourceDurationSec || (end + expandForward), end + expandForward);

    return {
      start: Number(newStart.toFixed(3)),
      end: Number(newEnd.toFixed(3))
    };
  }

  /**
   * Checks if an interval [start, end] overlaps with previously used intervals above threshold.
   */
  _isOverlapping(start, end, usedIntervals) {
    const dur = end - start;
    if (dur <= 0) return false;

    for (const used of usedIntervals) {
      const overlapStart = Math.max(start, used.start);
      const overlapEnd = Math.min(end, used.end);
      if (overlapEnd > overlapStart) {
        const overlapDur = overlapEnd - overlapStart;
        if (overlapDur / dur > 0.25) {
          return true; // Overlaps more than 25%
        }
      }
    }
    return false;
  }

  /**
   * Finds alternative unused sub-interval within the same scene.
   */
  _findAlternativeInterval(start, end, scenesList, usedIntervals, sourceDurationSec) {
    const dur = end - start;
    const scene = scenesList.find(s => start >= (s.startSec || 0) && end <= (s.endSec || Infinity));
    if (!scene) return { start, end };

    const sceneStart = scene.startSec || 0;
    const sceneEnd = scene.endSec || sourceDurationSec;

    // Search forward in scene
    let candidateStart = end;
    let candidateEnd = candidateStart + dur;
    if (candidateEnd <= sceneEnd && !this._isOverlapping(candidateStart, candidateEnd, usedIntervals)) {
      return { start: candidateStart, end: candidateEnd };
    }

    // Search backwards in scene
    candidateEnd = start;
    candidateStart = candidateEnd - dur;
    if (candidateStart >= sceneStart && !this._isOverlapping(candidateStart, candidateEnd, usedIntervals)) {
      return { start: candidateStart, end: candidateEnd };
    }

    // Fallback to original
    return { start, end };
  }

  /**
   * Resolves visual events for a speech unit based on visual_event_ids.
   */
  _resolveEventsForUnit(unit, eventsMap) {
    const eventIds = safeArray(unit.visual_event_ids);
    const matched = [];

    for (const id of eventIds) {
      if (eventsMap.has(id)) {
        matched.push(eventsMap.get(id));
      }
    }

    // Also check clauses if unit-level had none
    if (Array.isArray(unit.clauses)) {
      for (const clause of unit.clauses) {
        for (const cId of safeArray(clause.visual_event_ids)) {
          if (eventsMap.has(cId) && !matched.some(m => m.id === cId)) {
            matched.push(eventsMap.get(cId));
          }
        }
      }
    }

    return matched;
  }

  _normalizeEventsMap(visualEvents) {
    const map = new Map();
    if (Array.isArray(visualEvents)) {
      for (const ev of visualEvents) {
        if (ev && ev.id) map.set(ev.id, ev);
      }
    } else if (visualEvents && typeof visualEvents === "object") {
      for (const [key, val] of Object.entries(visualEvents)) {
        if (val && (val.id || key)) {
          map.set(val.id || key, val);
        }
      }
    }
    return map;
  }

  _createFallbackEvent(unit, sourceDurationSec, index) {
    const defaultDur = 3.5;
    const maxStart = Math.max(0, (sourceDurationSec || 60) - defaultDur);
    const start = Math.min(maxStart, index * 4.0);
    const end = Math.min(sourceDurationSec || 60, start + defaultDur);

    return {
      id: `fallback_event_${index + 1}`,
      source_start: start,
      source_end: end,
      duration: end - start,
      description: `Fallback footage for ${unit.id}`,
      face_closeup: false,
      lip_sync_risk: false
    };
  }
}

module.exports = {
  RecapSyncSolver
};
