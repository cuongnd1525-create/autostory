function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value) {
  return Number(safeNumber(value, 0).toFixed(3));
}

function getSegmentId(segment = {}, index = 0) {
  return String(segment.sceneId || segment.id || `scene_${String(index + 1).padStart(4, "0")}`);
}

function resolveVisualStrategy(plannedDurationSec, resolvedDurationSec, hasVoice) {
  if (!hasVoice || Math.abs(resolvedDurationSec - plannedDurationSec) <= 0.03) {
    return "as_requested";
  }
  if (resolvedDurationSec > plannedDurationSec) {
    const ratio = resolvedDurationSec / Math.max(0.3, plannedDurationSec);
    return ratio <= 1.08 ? "distributed_slowdown" : ratio <= 1.2 ? "extended_visual_warning" : "major_extension_warning";
  }
  return "cut_at_semantic_boundary";
}

function compileResolvedTimeline({
  mode = "",
  segments = [],
  voiceReports = [],
  voiceDrivenVisuals = true,
  generatedAt = new Date().toISOString()
} = {}) {
  let cursor = 0;
  const items = (Array.isArray(segments) ? segments : []).map((segment, index) => {
    const report = voiceReports[index] || {};
    const sourceStartSec = Math.max(0, safeNumber(segment.sourceStartSec ?? segment.startSec, 0));
    const sourceEndFallback = sourceStartSec + safeNumber(segment.sourceDuration || segment.duration || segment.durationSec, 1);
    const sourceEndSec = Math.max(sourceStartSec + 0.2, safeNumber(segment.sourceEndSec ?? segment.endSec, sourceEndFallback));
    const plannedStartSec = Math.max(0, safeNumber(segment.startSec, cursor));
    const plannedEndSec = Math.max(
      plannedStartSec + 0.2,
      safeNumber(segment.endSec, plannedStartSec + safeNumber(segment.duration || segment.durationSec, sourceEndSec - sourceStartSec))
    );
    const plannedDurationSec = Math.max(
      0.2,
      safeNumber(report.plannedTimelineSec ?? report.requestedTimelineSec, plannedEndSec - plannedStartSec)
    );
    const actualVoiceDurationSec = Math.max(0, safeNumber(report.rawVoiceSec ?? report.actualVoiceDurationSec, 0));
    const hasVoice = Boolean(String(report.renderedText || segment.voiceoverText || segment.dubbingLine || segment.storyText || "").trim());
    const resolvedDurationSec = voiceDrivenVisuals && hasVoice && actualVoiceDurationSec > 0.05
      ? actualVoiceDurationSec
      : plannedDurationSec;
    const resolvedStartSec = cursor;
    const resolvedEndSec = resolvedStartSec + resolvedDurationSec;
    const item = {
      index,
      segmentId: getSegmentId(segment, index),
      source: {
        startSec: round(sourceStartSec),
        endSec: round(sourceEndSec),
        durationSec: round(sourceEndSec - sourceStartSec)
      },
      planned: {
        startSec: round(plannedStartSec),
        endSec: round(plannedEndSec),
        durationSec: round(plannedDurationSec)
      },
      voice: {
        textHash: String(report.textHash || segment.fastDraftTextHash || ""),
        durationSec: round(actualVoiceDurationSec),
        coverageRatio: round(actualVoiceDurationSec / Math.max(0.2, plannedDurationSec)),
        status: String(report.status || "")
      },
      resolved: {
        startSec: round(resolvedStartSec),
        endSec: round(resolvedEndSec),
        durationSec: round(resolvedDurationSec),
        visualStrategy: resolveVisualStrategy(plannedDurationSec, resolvedDurationSec, hasVoice)
      }
    };
    cursor = resolvedEndSec;
    return item;
  });

  return {
    schemaVersion: 1,
    generatedAt,
    mode,
    voiceDrivenVisuals: Boolean(voiceDrivenVisuals),
    plannedDurationSec: round(items.reduce((sum, item) => sum + item.planned.durationSec, 0)),
    resolvedDurationSec: round(cursor),
    segments: items
  };
}

module.exports = {
  compileResolvedTimeline,
  resolveVisualStrategy
};
