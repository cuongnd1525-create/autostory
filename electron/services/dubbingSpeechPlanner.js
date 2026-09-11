function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeText(value, fallback = "") {
  return String(value || fallback).replace(/\s+/g, " ").trim();
}

function countWords(text) {
  return safeText(text).split(/\s+/).filter(Boolean).length;
}

function splitSentences(text) {
  return safeText(text)
    .split(/(?<=[.!?。！？])\s+|[;]\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function estimateSpeechDuration(text, language = "vi", voiceSpeed = 1) {
  const speed = Math.max(0.5, Math.min(1.8, safeNumber(voiceSpeed, 1)));
  const normalized = safeText(text);
  if (!normalized) return 0;
  if (/^(ja|zh|ko)/i.test(String(language || ""))) {
    const chars = normalized.replace(/\s+/g, "").length;
    return chars / (5.2 * speed);
  }
  return countWords(normalized) / (DEFAULT_WORDS_PER_SECOND * speed);
}

function maxWordsForDuration(durationSec, language = "vi", voiceSpeed = 1) {
  return Math.max(2, Math.floor(Math.max(0.3, durationSec) * DEFAULT_WORDS_PER_SECOND * Math.max(0.5, voiceSpeed)));
}

function compactForDuration(text, targetDuration, language, voiceSpeed) {
  const normalized = safeText(text);
  const maxWords = maxWordsForDuration(targetDuration, language, voiceSpeed);
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) {
    return normalized;
  }
  const sentences = splitSentences(normalized);
  if (sentences.length > 1) {
    const kept = [];
    for (const sentence of sentences) {
      const next = [...kept, sentence].join(" ");
      if (countWords(next) > maxWords) break;
      kept.push(sentence);
    }
    if (kept.length) return kept.join(" ");
  }
  return words.slice(0, maxWords).join(" ");
}

function segmentDuration(segment) {
  return Math.max(0.1, safeNumber(segment.endSec, 0) - safeNumber(segment.startSec, 0));
}

function segmentText(segment) {
  return safeText(segment.dubbingLine || segment.translatedText || segment.naturalTranslation || segment.text || segment.originalText || "");
}

function sourceText(segment) {
  return safeText(segment.text || segment.originalText || segment.sourceText || "");
}

function sameSpeaker(left, right) {
  return safeText(left?.speaker || "SPEAKER_00") === safeText(right?.speaker || "SPEAKER_00");
}

function sameScene(left, right) {
  const leftScene = safeText(left?.sceneId || left?.metadataSummary?.sceneId || "");
  const rightScene = safeText(right?.sceneId || right?.metadataSummary?.sceneId || "");
  return !leftScene || !rightScene || leftScene === rightScene;
}

function splitLongCluster(cluster, maxDuration) {
  if (cluster.originalDuration <= maxDuration + 3 || cluster.segments.length <= 1) {
    return [cluster];
  }
  const result = [];
  let current = [];
  for (const segment of cluster.segments) {
    const start = current.length ? current[0].startSec : segment.startSec;
    const proposedDuration = Math.max(0.1, safeNumber(segment.endSec, 0) - safeNumber(start, 0));
    if (current.length && proposedDuration > maxDuration) {
      result.push(current);
      current = [segment];
    } else {
      current.push(segment);
    }
  }
  if (current.length) result.push(current);
  return result.map(buildRawCluster);
}

function buildRawCluster(segments) {
  const first = segments[0] || {};
  const last = segments[segments.length - 1] || first;
  return {
    segments,
    speakerId: safeText(first.speaker || "SPEAKER_00"),
    sceneId: safeText(first.sceneId || first.metadataSummary?.sceneId || ""),
    start: safeNumber(first.startSec, 0),
    end: safeNumber(last.endSec, safeNumber(first.endSec, 0)),
    originalDuration: Math.max(0.1, safeNumber(last.endSec, 0) - safeNumber(first.startSec, 0))
  };
}

function distributeTextAcrossSegments(text, segments, clusterStart, clusterDuration) {
  const words = safeText(text).split(/\s+/).filter(Boolean);
  const totalWeight = segments.reduce((sum, segment) => sum + Math.max(1, countWords(sourceText(segment)) || countWords(segmentText(segment))), 0);
  let wordCursor = 0;
  let timeCursor = clusterStart;
  return segments.map((segment, index) => {
    const isLast = index === segments.length - 1;
    const weight = Math.max(1, countWords(sourceText(segment)) || countWords(segmentText(segment)));
    const wordCount = isLast ? words.length - wordCursor : Math.max(1, Math.round((weight / totalWeight) * words.length));
    const cueText = words.slice(wordCursor, wordCursor + wordCount).join(" ") || segmentText(segment);
    wordCursor += wordCount;
    const duration = isLast
      ? Math.max(0.3, clusterStart + clusterDuration - timeCursor)
      : Math.max(0.3, clusterDuration * (weight / totalWeight));
    const startSec = timeCursor;
    const endSec = startSec + duration;
    timeCursor = endSec;
    return {
      ...segment,
      startSec: Number(startSec.toFixed(3)),
      endSec: Number(endSec.toFixed(3)),
      translatedText: cueText,
      dubbingLine: cueText,
      clusterSubtitle: true
    };
  });
}

class DubbingSpeechPlanner {
  constructor(options = {}) {
    this.minClusterDuration = safeNumber(options.minClusterDuration, 5);
    this.maxClusterDuration = safeNumber(options.maxClusterDuration, 12);
    this.maxPauseSec = safeNumber(options.maxPauseSec, 1.0);
    this.maxSafeStretch = safeNumber(options.maxSafeStretch, 0.08);
    this.targetLanguage = options.targetLanguage || "vi";
    this.voiceSpeed = safeNumber(options.voiceSpeed, 1);
  }

  buildPlan(segments = []) {
    const normalized = (Array.isArray(segments) ? segments : [])
      .filter((segment) => segment && Number.isFinite(Number(segment.startSec)) && Number.isFinite(Number(segment.endSec)))
      .sort((left, right) => safeNumber(left.startSec, 0) - safeNumber(right.startSec, 0));
    const rawClusters = [];
    let current = [];

    for (const segment of normalized) {
      if (!current.length) {
        current.push(segment);
        continue;
      }
      const previous = current[current.length - 1];
      const gap = safeNumber(segment.startSec, 0) - safeNumber(previous.endSec, 0);
      const currentStart = safeNumber(current[0].startSec, 0);
      const proposedDuration = safeNumber(segment.endSec, 0) - currentStart;
      const hardBreak = !sameSpeaker(previous, segment) || !sameScene(previous, segment);
      const softBreak = gap > this.maxPauseSec || proposedDuration > this.maxClusterDuration;
      if (hardBreak || (softBreak && (proposedDuration > 1.2 || segmentDuration(previous) >= 1.2))) {
        rawClusters.push(buildRawCluster(current));
        current = [segment];
      } else {
        current.push(segment);
      }
    }
    if (current.length) rawClusters.push(buildRawCluster(current));

    const expanded = rawClusters.flatMap((cluster) => splitLongCluster(cluster, this.maxClusterDuration));
    const merged = this.mergeShortClusters(expanded);
    const clusters = merged.map((cluster, index) => this.finalizeCluster(cluster, index));
    return {
      generatedAt: new Date().toISOString(),
      mode: "speech_first_clustered",
      targetLanguage: this.targetLanguage,
      voiceSpeed: this.voiceSpeed,
      settings: {
        minClusterDuration: this.minClusterDuration,
        maxClusterDuration: this.maxClusterDuration,
        maxPauseSec: this.maxPauseSec,
        maxSafeStretch: this.maxSafeStretch
      },
      clusters
    };
  }

  mergeShortClusters(clusters) {
    const result = [];
    for (const cluster of clusters) {
      const previous = result[result.length - 1];
      const gap = previous ? cluster.start - previous.end : 999;
      if (
        previous
        && previous.originalDuration < this.minClusterDuration
        && previous.originalDuration + gap + cluster.originalDuration <= this.maxClusterDuration
        && previous.speakerId === cluster.speakerId
        && (!previous.sceneId || !cluster.sceneId || previous.sceneId === cluster.sceneId)
        && gap <= this.maxPauseSec
      ) {
        previous.segments.push(...cluster.segments);
        previous.end = cluster.end;
        previous.originalDuration = Math.max(0.1, previous.end - previous.start);
      } else {
        result.push({ ...cluster, segments: [...cluster.segments] });
      }
    }
    return result;
  }

  finalizeCluster(cluster, index) {
    const translatedText = cluster.segments.map(segmentText).filter(Boolean).join(" ");
    const source = cluster.segments.map(sourceText).filter(Boolean).join(" ");
    const targetDuration = cluster.originalDuration;
    const minSafeDuration = targetDuration * (1 - this.maxSafeStretch);
    const maxSafeDuration = targetDuration * (1 + this.maxSafeStretch);
    let adaptedText = safeText(translatedText);
    const risk = [];
    const beforeDuration = estimateSpeechDuration(adaptedText, this.targetLanguage, this.voiceSpeed);
    if (beforeDuration > maxSafeDuration) {
      risk.push("duration_overflow_before_tts");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        adaptedText = compactForDuration(adaptedText, maxSafeDuration, this.targetLanguage, this.voiceSpeed);
        if (estimateSpeechDuration(adaptedText, this.targetLanguage, this.voiceSpeed) <= maxSafeDuration) {
          risk.push("local_shortened_for_duration");
          break;
        }
      }
    }
    const estimatedSpeechDuration = estimateSpeechDuration(adaptedText, this.targetLanguage, this.voiceSpeed);
    if (estimatedSpeechDuration > maxSafeDuration) {
      risk.push("duration_overflow");
    }
    if (cluster.segments.length > 1 && cluster.segments.some((segment) => segmentDuration(segment) < 1.2)) {
      risk.push("merged_short_segments");
    }
    return {
      clusterId: `dub_cluster_${String(index + 1).padStart(3, "0")}`,
      speakerId: cluster.speakerId,
      sceneId: cluster.sceneId,
      sourceSegmentIds: cluster.segments.map((segment) => segment.id).filter(Boolean),
      start: Number(cluster.start.toFixed(3)),
      end: Number(cluster.end.toFixed(3)),
      originalDuration: Number(cluster.originalDuration.toFixed(3)),
      sourceText: source,
      translatedText,
      adaptedText,
      targetDuration: Number(targetDuration.toFixed(3)),
      minSafeDuration: Number(minSafeDuration.toFixed(3)),
      maxSafeDuration: Number(maxSafeDuration.toFixed(3)),
      estimatedSpeechDuration: Number(estimatedSpeechDuration.toFixed(3)),
      risk,
      ttsMode: "cluster",
      segments: cluster.segments
    };
  }

  buildSubtitleSegments(cluster, generatedStart, generatedDuration) {
    return distributeTextAcrossSegments(
      cluster.adaptedText || cluster.translatedText,
      cluster.segments || [],
      generatedStart,
      Math.max(0.3, generatedDuration || cluster.targetDuration || cluster.originalDuration)
    );
  }
}

module.exports = {
  DubbingSpeechPlanner,
  estimateSpeechDuration,
  compactForDuration,
  distributeTextAcrossSegments
};
const { DEFAULT_WORDS_PER_SECOND } = require("./voiceTimingPolicy");
