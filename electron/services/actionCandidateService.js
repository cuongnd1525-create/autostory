const FfmpegService = require("./ffmpegService");

const ACTION_ANALYSIS_SCHEMA_VERSION = 1;

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function percentile(values, ratio, fallback = 0) {
  const sorted = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return fallback;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
}

function parseMetadataSeries(output, key) {
  const rows = [];
  let currentTime = null;
  const timePattern = /pts_time:([-0-9.]+)/;
  const valuePattern = new RegExp(`${String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([-+a-zA-Z0-9.]+)`);
  String(output || "").split(/\r?\n/).forEach((line) => {
    const timeMatch = line.match(timePattern);
    if (timeMatch) currentTime = Number(timeMatch[1]);
    const valueMatch = line.match(valuePattern);
    if (!valueMatch || !Number.isFinite(currentTime)) return;
    const value = Number(valueMatch[1]);
    if (Number.isFinite(value)) rows.push({ timeSec: currentTime, value });
  });
  return rows;
}

function valuesInRange(series, startSec, endSec) {
  return (series || [])
    .filter((item) => item.timeSec >= startSec && item.timeSec < endSec)
    .map((item) => item.value)
    .filter(Number.isFinite);
}

function normalizeSignal(value, low, high) {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low + 0.0001) return 0.5;
  return clamp((value - low) / (high - low));
}

function splitRange(startSec, endSec, maxDurationSec) {
  const ranges = [];
  let cursor = startSec;
  while (cursor < endSec - 0.001) {
    const next = Math.min(endSec, cursor + maxDurationSec);
    ranges.push({ startSec: cursor, endSec: next });
    cursor = next;
  }
  return ranges;
}

function sceneSlicesForRange(manifest, startSec, endSec) {
  return (manifest?.scenes || [])
    .map((scene) => {
      const sliceStart = Math.max(startSec, Number(scene.startSec));
      const sliceEnd = Math.min(endSec, Number(scene.endSec));
      if (!(sliceEnd > sliceStart + 0.001)) return null;
      return {
        sceneId: scene.sceneId,
        sourceStartSec: Number(sliceStart.toFixed(3)),
        sourceEndSec: Number(sliceEnd.toFixed(3))
      };
    })
    .filter(Boolean);
}

function buildActionCandidates({
  motionSeries = [],
  audioSeries = [],
  manifest = {},
  durationSec = 0,
  windowSec = 4,
  maxCandidateDurationSec = 60,
  maxCandidates = 20
} = {}) {
  const duration = Math.max(0, Number(durationSec || manifest?.videoDurationSec || 0));
  if (!duration) return [];
  const safeWindow = Math.max(2, Number(windowSec) || 4);
  const motionValues = motionSeries.map((item) => item.value).filter(Number.isFinite);
  const audioValues = audioSeries.map((item) => item.value).filter(Number.isFinite);
  const motionLow = percentile(motionValues, 0.2, 0);
  const motionHigh = percentile(motionValues, 0.9, motionLow + 1);
  const audioLow = percentile(audioValues, 0.2, -60);
  const audioHigh = percentile(audioValues, 0.9, -12);
  const windows = [];

  for (let startSec = 0; startSec < duration - 0.001; startSec += safeWindow) {
    const endSec = Math.min(duration, startSec + safeWindow);
    const motionRaw = percentile(valuesInRange(motionSeries, startSec, endSec), 0.75, motionLow);
    const audioRaw = percentile(valuesInRange(audioSeries, startSec, endSec), 0.75, audioLow);
    const motion = normalizeSignal(motionRaw, motionLow, motionHigh);
    const audio = audioSeries.length ? normalizeSignal(audioRaw, audioLow, audioHigh) : 0;
    const cuts = (manifest?.scenes || []).filter((scene) => (
      Number(scene.startSec) > startSec + 0.001 && Number(scene.startSec) < endSec - 0.001
    )).length;
    const cutPace = clamp(cuts / 3);
    const combined = clamp((motion * 0.65) + (audio * 0.25) + (cutPace * 0.1));
    windows.push({ startSec, endSec, motion, audio, cutPace, combined });
  }

  const combinedThreshold = Math.max(0.52, percentile(windows.map((item) => item.combined), 0.75, 0.52));
  const selected = windows.filter((item) => (
    item.combined >= combinedThreshold
    || item.motion >= 0.88
    || (item.motion >= 0.68 && item.audio >= 0.68)
  ));
  if (!selected.length) {
    selected.push(...[...windows].sort((a, b) => b.combined - a.combined).slice(0, Math.min(6, windows.length)));
    selected.sort((a, b) => a.startSec - b.startSec);
  }

  const merged = [];
  selected.forEach((item) => {
    const previous = merged[merged.length - 1];
    if (previous && item.startSec <= previous.endSec + 0.1) {
      previous.endSec = item.endSec;
      previous.windows.push(item);
    } else {
      merged.push({ startSec: item.startSec, endSec: item.endSec, windows: [item] });
    }
  });

  const expanded = merged.flatMap((item) => {
    const startSec = Math.max(0, item.startSec - 2);
    const endSec = Math.min(duration, item.endSec + 2);
    return splitRange(startSec, endSec, Math.max(12, Number(maxCandidateDurationSec) || 60)).map((range) => ({
      ...range,
      windows: item.windows.filter((window) => (
        window.endSec > range.startSec && window.startSec < range.endSec
      ))
    }));
  }).filter((item) => item.endSec - item.startSec >= 4);

  const ranked = expanded.map((item) => {
    const motion = percentile(item.windows.map((window) => window.motion), 0.75, 0);
    const audio = percentile(item.windows.map((window) => window.audio), 0.75, 0);
    const combined = percentile(item.windows.map((window) => window.combined), 0.75, 0);
    return { ...item, motion, audio, combined };
  }).sort((a, b) => b.combined - a.combined).slice(0, Math.max(4, Number(maxCandidates) || 20));

  const rankByRange = new Map(ranked.map((item, index) => [`${item.startSec}:${item.endSec}`, index + 1]));
  return ranked
    .sort((a, b) => a.startSec - b.startSec)
    .map((item, index) => {
      const rank = rankByRange.get(`${item.startSec}:${item.endSec}`) || index + 1;
      const priority = Number((item.combined * 10).toFixed(2));
      return {
        actionCandidateId: `action_${String(index + 1).padStart(4, "0")}`,
        rank,
        sourceStartSec: Number(item.startSec.toFixed(3)),
        sourceEndSec: Number(item.endSec.toFixed(3)),
        durationSec: Number((item.endSec - item.startSec).toFixed(3)),
        motionScore: Number((item.motion * 10).toFixed(2)),
        audioEnergyScore: Number((item.audio * 10).toFixed(2)),
        actionPriorityScore: priority,
        mustReview: rank <= 8 || priority >= 7.5,
        localActionType: "high_motion_or_audio_event",
        sceneSlices: sceneSlicesForRange(manifest, item.startSec, item.endSec)
      };
    });
}

class ActionCandidateService {
  constructor(settings = {}) {
    this.settings = settings;
    this.ffmpeg = new FfmpegService(settings);
  }

  async analyze({ sourceVideoPath, analysisVideoPath, manifest, onProgress }) {
    const durationSec = Number(manifest?.videoDurationSec || 0);
    onProgress?.({ step: "gemini_pack", percent: 27, message: "Đang đo chuyển động để tìm cảnh hành động" });
    const motionOutput = await this.ffmpeg.run(this.ffmpeg.ffmpegPath, [
      "-hide_banner", "-nostats", "-i", analysisVideoPath,
      "-vf", "fps=4,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
      "-an", "-f", "null", "-"
    ], { captureStdout: false });
    const motionSeries = parseMetadataSeries(motionOutput, "lavfi.signalstats.YAVG");

    let audioSeries = [];
    try {
      onProgress?.({ step: "gemini_pack", percent: 30, message: "Đang đo năng lượng âm thanh của cảnh" });
      const audioOutput = await this.ffmpeg.run(this.ffmpeg.ffmpegPath, [
        "-hide_banner", "-nostats", "-i", sourceVideoPath,
        "-vn",
        "-af", "aresample=8000,asetnsamples=n=4000:p=1,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
        "-f", "null", "-"
      ], { captureStdout: false });
      audioSeries = parseMetadataSeries(audioOutput, "lavfi.astats.Overall.RMS_level");
    } catch (_error) {
      audioSeries = [];
    }

    const candidates = buildActionCandidates({
      motionSeries,
      audioSeries,
      manifest,
      durationSec,
      windowSec: Number(this.settings.actionAnalysisWindowSec || 4),
      maxCandidateDurationSec: Number(this.settings.actionCandidateMaxDurationSec || 60),
      maxCandidates: Number(this.settings.actionCandidateMaxCount || 20)
    });
    return {
      artifactType: "action_candidates",
      schemaVersion: ACTION_ANALYSIS_SCHEMA_VERSION,
      sourceVideo: manifest?.sourceVideo || "",
      videoDurationSec: durationSec,
      generatedBy: "local_ffmpeg_motion_audio_v1",
      signalDescription: "Candidates are local motion/audio radar. Gemini must visually classify every mustReview item; scores do not prove narrative importance.",
      candidates
    };
  }
}

module.exports = ActionCandidateService;
module.exports.parseMetadataSeries = parseMetadataSeries;
module.exports.buildActionCandidates = buildActionCandidates;
module.exports.sceneSlicesForRange = sceneSlicesForRange;
