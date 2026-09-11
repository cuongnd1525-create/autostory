const DEFAULT_WORDS_PER_SECOND = 2.35;

const VOICE_TIMING_THRESHOLDS = Object.freeze({
  minCoverage: 0.82,
  idealMinCoverage: 0.85,
  idealMaxCoverage: 1,
  maxCoverage: 1.08,
  minDeadAirWarningSec: 1,
  minOverflowWarningSec: 0.35
});

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function countWords(text = "") {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function estimateSpeechSeconds(text = "", wordsPerSecond = DEFAULT_WORDS_PER_SECOND) {
  const safeWordsPerSecond = Math.max(0.8, safeNumber(wordsPerSecond, DEFAULT_WORDS_PER_SECOND));
  return countWords(text) / safeWordsPerSecond;
}

function getPlannedDuration(report = {}, segment = {}) {
  const startSec = safeNumber(report.startSec, safeNumber(segment.startSec, 0));
  const endSec = safeNumber(report.endSec, safeNumber(segment.endSec, startSec));
  return Math.max(
    0.3,
    safeNumber(
      report.plannedTimelineSec ?? report.requestedTimelineSec,
      Math.max(0.3, endSec - startSec)
    )
  );
}

function measureVoiceTiming({
  plannedDurationSec,
  actualVoiceDurationSec,
  text = "",
  profileWordsPerSecond = 0,
  thresholds = VOICE_TIMING_THRESHOLDS
} = {}) {
  const plannedDuration = Math.max(0.3, safeNumber(plannedDurationSec, 0.3));
  const actualVoiceDuration = Math.max(
    0,
    safeNumber(actualVoiceDurationSec, estimateSpeechSeconds(text, profileWordsPerSecond || DEFAULT_WORDS_PER_SECOND))
  );
  const coverageRatio = actualVoiceDuration / plannedDuration;
  const deadAirSec = Math.max(0, plannedDuration - actualVoiceDuration);
  const overflowSec = Math.max(0, actualVoiceDuration - plannedDuration);
  const wordCount = countWords(text);
  const measuredWordsPerSecond = actualVoiceDuration > 0.3 && wordCount > 0
    ? wordCount / actualVoiceDuration
    : DEFAULT_WORDS_PER_SECOND;
  const wordsPerSecond = safeNumber(profileWordsPerSecond, 0) || measuredWordsPerSecond;
  const targetMinSec = Number((plannedDuration * thresholds.idealMinCoverage).toFixed(3));
  const targetMaxSec = Number((plannedDuration * thresholds.idealMaxCoverage).toFixed(3));
  let status = "ok";
  let severity = "ok";
  let problem = "Voice khớp timeline kế hoạch.";
  let recommendation = "Giữ nguyên nội dung.";
  let suggestedWordDelta = 0;

  if (coverageRatio < thresholds.minCoverage && deadAirSec > thresholds.minDeadAirWarningSec) {
    status = "too_short";
    severity = coverageRatio < 0.6 || deadAirSec > 4 ? "error" : "warning";
    suggestedWordDelta = Math.max(5, Math.round((targetMinSec - actualVoiceDuration) * Math.max(2.2, wordsPerSecond)));
    problem = `Voice quá ngắn, còn khoảng ${deadAirSec.toFixed(2)}s dễ bị câm trước khi sang cảnh mới.`;
    recommendation = `Viết dài hơn khoảng ${suggestedWordDelta} từ, bám đúng hành động đang xảy ra trong cảnh, không thêm sự kiện mới.`;
  } else if (coverageRatio > thresholds.maxCoverage && overflowSec > thresholds.minOverflowWarningSec) {
    status = "too_long";
    severity = overflowSec > 2 ? "error" : "warning";
    suggestedWordDelta = -Math.max(4, Math.round((actualVoiceDuration - targetMaxSec) * Math.max(2.2, wordsPerSecond)));
    problem = `Voice quá dài, dư khoảng ${overflowSec.toFixed(2)}s so với timeline kế hoạch.`;
    recommendation = `Rút ngắn khoảng ${Math.abs(suggestedWordDelta)} từ, giữ ý chính và nhịp kể tự nhiên.`;
  }

  return {
    status,
    severity,
    plannedDurationSec: Number(plannedDuration.toFixed(3)),
    actualVoiceDurationSec: Number(actualVoiceDuration.toFixed(3)),
    coverageRatio: Number(coverageRatio.toFixed(3)),
    deadAirSec: Number(deadAirSec.toFixed(3)),
    overflowSec: Number(overflowSec.toFixed(3)),
    wordCount,
    measuredWordsPerSecond: Number(measuredWordsPerSecond.toFixed(3)),
    profileWordsPerSecond: Number(wordsPerSecond.toFixed(3)),
    targetVoiceRangeSec: {
      min: Number(targetMinSec.toFixed(2)),
      max: Number(targetMaxSec.toFixed(2))
    },
    suggestedWordDelta,
    problem,
    recommendation
  };
}

function resolveVoiceVisualFit({
  plannedDurationSec,
  actualVoiceDurationSec,
  hasVoice = true,
  audioMode = "voiceover_only",
  protectedVisual = false,
  handoffPaddingSec = 0.25,
  maxVoiceSpeedUp = 1.08,
  minVisualSpeed = 0.9
} = {}) {
  const plannedDuration = Math.max(0.3, safeNumber(plannedDurationSec, 0.3));
  const actualVoiceDuration = Math.max(0, safeNumber(actualVoiceDurationSec, 0));
  const mode = ["original_audio", "voiceover_only", "voiceover_with_ambient"].includes(audioMode)
    ? audioMode
    : "voiceover_only";
  if (!hasVoice || mode === "original_audio" || actualVoiceDuration <= 0.05) {
    return {
      plannedDurationSec: Number(plannedDuration.toFixed(3)),
      actualVoiceDurationSec: Number(actualVoiceDuration.toFixed(3)),
      renderDurationSec: Number(plannedDuration.toFixed(3)),
      requestedFitRatio: 0,
      voiceSpeedRatio: 1,
      visualSpeedRatio: 1,
      strategy: "original_audio_protected",
      requiresRewrite: false,
      requiresSceneRebuild: false,
      warningCode: ""
    };
  }

  const ratio = actualVoiceDuration / plannedDuration;
  let renderDuration = plannedDuration;
  let strategy = "as_requested";
  let requiresRewrite = false;
  let requiresSceneRebuild = false;
  let warningCode = "";

  if (ratio > 1.2) {
    // Keep the complete voice without trimming. The report explicitly marks that
    // editorial rewrite/extra verified B-roll is still required.
    renderDuration = actualVoiceDuration / Math.max(1, maxVoiceSpeedUp);
    strategy = "preserve_voice_pending_rewrite";
    requiresRewrite = true;
    warningCode = "voice_far_too_long";
  } else if (ratio > 1.08) {
    renderDuration = Math.min(
      actualVoiceDuration / Math.max(1, maxVoiceSpeedUp),
      plannedDuration / Math.max(0.5, minVisualSpeed)
    );
    strategy = "light_voice_speedup_and_visual_extension";
    requiresRewrite = ratio > 1.15;
    warningCode = requiresRewrite ? "voice_too_long" : "";
  } else if (ratio < 0.8) {
    requiresSceneRebuild = true;
    warningCode = "voice_far_too_short";
    if (protectedVisual || mode === "voiceover_with_ambient") {
      renderDuration = plannedDuration;
      strategy = "protected_visual_ambient_handoff";
    } else {
      renderDuration = Math.max(0.3, Math.min(plannedDuration, actualVoiceDuration + handoffPaddingSec));
      strategy = "trim_flexible_broll_to_voice";
    }
  } else if (ratio < 0.92) {
    if (protectedVisual || mode === "voiceover_with_ambient") {
      renderDuration = plannedDuration;
      strategy = "protected_visual_ambient_handoff";
    } else {
      renderDuration = Math.max(0.3, Math.min(plannedDuration, actualVoiceDuration + handoffPaddingSec));
      strategy = "trim_flexible_broll_to_voice";
    }
  }

  const voiceSpeedRatio = actualVoiceDuration / Math.max(0.3, renderDuration);
  const visualSpeedRatio = plannedDuration / Math.max(0.3, renderDuration);
  if (visualSpeedRatio < minVisualSpeed - 0.001) {
    requiresRewrite = true;
    warningCode ||= "visual_slowdown_limit_exceeded";
  }

  return {
    plannedDurationSec: Number(plannedDuration.toFixed(3)),
    actualVoiceDurationSec: Number(actualVoiceDuration.toFixed(3)),
    renderDurationSec: Number(renderDuration.toFixed(3)),
    requestedFitRatio: Number(ratio.toFixed(3)),
    voiceSpeedRatio: Number(voiceSpeedRatio.toFixed(3)),
    visualSpeedRatio: Number(visualSpeedRatio.toFixed(3)),
    strategy,
    requiresRewrite,
    requiresSceneRebuild,
    warningCode
  };
}

module.exports = {
  DEFAULT_WORDS_PER_SECOND,
  VOICE_TIMING_THRESHOLDS,
  countWords,
  estimateSpeechSeconds,
  getPlannedDuration,
  measureVoiceTiming,
  resolveVoiceVisualFit
};
