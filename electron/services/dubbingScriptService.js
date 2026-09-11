const { DEFAULT_WORDS_PER_SECOND } = require("./voiceTimingPolicy");

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeText(value, fallback = "") {
  return String(value || fallback).replace(/\s+/g, " ").trim();
}

function countWords(text = "") {
  return safeText(text).split(/\s+/).filter(Boolean).length;
}

function maxWordsForDuration(durationSec) {
  return Math.max(2, Math.floor(Math.max(0.2, safeNumber(durationSec, 0)) * DEFAULT_WORDS_PER_SECOND));
}

function normalizeStorytimeScript(rawScript, videoDuration = 0) {
  const parsed = typeof rawScript === "string" ? JSON.parse(rawScript) : rawScript;
  const sourceSegments = Array.isArray(parsed?.segments) ? parsed.segments : [];
  if (!sourceSegments.length) {
    throw new Error("File JSON không có mảng segments.");
  }

  const segments = sourceSegments.map((segment, index) => {
    const startSec = safeNumber(
      segment.sourceStartSec ?? segment.inputStartSec ?? segment.videoStartSec ?? segment.startSec ?? segment.start ?? segment.from,
      -1
    );
    let endSec = safeNumber(
      segment.sourceEndSec ?? segment.inputEndSec ?? segment.videoEndSec ?? segment.endSec ?? segment.end ?? segment.to,
      -1
    );
    const text = safeText(
      segment.text ||
      segment.voiceover_text ||
      segment.voiceoverText ||
      segment.voiceover ||
      segment.narration ||
      segment.dubbingLine ||
      segment.storyText ||
      ""
    );
    const audioMode = safeText(segment.audioMode || segment.audio_mode || (text ? "voiceover_only" : "original_audio"));
    const caption = safeText(segment.caption || segment.subtitle || text);
    if (startSec < 0 || endSec <= startSec) {
      throw new Error(`Segment ${index + 1} thiếu timestamp hợp lệ. Dùng sourceStartSec/sourceEndSec hoặc startSec/endSec, với 0 <= start < end.`);
    }
    if (!text && audioMode !== "original_audio") {
      throw new Error(`Segment ${index + 1} thiếu text.`);
    }
    const overflowSec = videoDuration ? endSec - videoDuration : 0;
    const allowClampOverflowSec = Math.max(2, videoDuration * 0.02);
    if (videoDuration && overflowSec > 0 && overflowSec <= allowClampOverflowSec && videoDuration > startSec + 0.3) {
      endSec = videoDuration;
    } else if (videoDuration && endSec > videoDuration + 0.5) {
      throw new Error(`Segment ${index + 1} vượt quá thời lượng video (${endSec.toFixed(2)}s > ${videoDuration.toFixed(2)}s).`);
    }
    return {
      id: segment.id || `story_${String(index + 1).padStart(4, "0")}`,
      sceneId: safeText(segment.sceneId || segment.scene_id || segment.id || `story_${String(index + 1).padStart(4, "0")}`),
      index,
      startSec: Number(startSec.toFixed(3)),
      endSec: Number(endSec.toFixed(3)),
      duration: Number((endSec - startSec).toFixed(3)),
      audioMode,
      sourceVolume: audioMode === "original_audio" ? 1 : 0,
      text: text || caption,
      translatedText: caption,
      dubbingLine: text,
      caption,
      speaker: segment.speaker || "STORYTELLER",
      emotion: segment.emotion || "curious",
      pace: segment.pace || "normal",
      maxWords: maxWordsForDuration(endSec - startSec)
    };
  }).sort((a, b) => a.startSec - b.startSec);

  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index].startSec < segments[index - 1].endSec - 0.02) {
      throw new Error(`Segment ${index + 1} bị chồng timeline với segment ${index}.`);
    }
  }

  const warnings = segments.flatMap((segment) => {
    const words = countWords(segment.dubbingLine);
    const warningItems = words > segment.maxWords + 2
      ? [`Segment ${segment.index + 1} có ${words}/${segment.maxWords} từ, có thể quá dài so với ${segment.duration.toFixed(2)}s.`]
      : [];
    const sourceSegment = sourceSegments[segment.index] || {};
    const originalEndSec = safeNumber(
      sourceSegment.sourceEndSec ?? sourceSegment.inputEndSec ?? sourceSegment.videoEndSec ?? sourceSegment.endSec ?? sourceSegment.end ?? sourceSegment.to,
      segment.endSec
    );
    if (videoDuration && originalEndSec > videoDuration && Math.abs(segment.endSec - videoDuration) < 0.01) {
      warningItems.push(`Segment ${segment.index + 1} vượt nhẹ thời lượng video (${originalEndSec.toFixed(2)}s > ${videoDuration.toFixed(2)}s), đã tự co endSec về cuối video.`);
    }
    return warningItems;
  });

  return {
    title: parsed.title || "Oddly Satisfying Storytime",
    topHeader: safeText(parsed.top_banner_text || parsed.top_header || parsed.topHeader || ""),
    language: parsed.language || "auto",
    style: parsed.style || "storytime_engagement_bait",
    segments,
    warnings
  };
}

module.exports = {
  normalizeStorytimeScript
};
