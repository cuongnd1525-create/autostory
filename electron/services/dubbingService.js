const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

const FfmpegService = require("./ffmpegService");
const SceneDetectionService = require("./sceneDetectionService");
const EdgeTtsService = require("./edgeTtsService");
const OmniVoiceService = require("./omniVoiceService");
const KokoroVoiceService = require("./kokoroVoiceService");
const LocalTranslationService = require("./localTranslationService");
const SubtitleService = require("./subtitleService");
const WindowsVoiceService = require("./windowsVoiceService");
const ElevenLabsService = require("./elevenLabsService");
const VoiceProfileService = require("./voiceProfileService");
const RenderQaService = require("./renderQaService");
const {
  DEFAULT_WORDS_PER_SECOND,
  VOICE_TIMING_THRESHOLDS,
  estimateSpeechSeconds: estimateSpeechSecondsWithPolicy,
  measureVoiceTiming,
  resolveVoiceVisualFit
} = require("./voiceTimingPolicy");
const { compileResolvedTimeline } = require("./resolvedTimelineService");
const { createAiProvider, LocalFallbackProvider } = require("./aiProviderRegistry");
const { DubbingSpeechPlanner } = require("./dubbingSpeechPlanner");
const {
  buildExportFilePath,
  buildVideoTitleOverlaySvg,
  calculateVideoTitleWrapChars,
  clearFastDraftArtifacts,
  pruneDraftArtifacts,
  publishDraftVideo,
  publishFinalVideo,
  resolveEffectiveVideoEditProject,
  resolveSuggestedTopCaption,
  resolvePartLabelText,
  resolveSourceSubtitleMask,
  resolveVariantFileMetadata,
  resolveVideoCanvasDimensions,
  resolveVideoTitleRasterDimensions,
  sanitizeFilePart,
  wrapVideoTitle
} = require("./dubbingArtifactService");
const { normalizeStorytimeScript } = require("./dubbingScriptService");
const {
  rankManualGeminiVariants,
  scoreManualGeminiVariant
} = require("./manualGeminiViralPreflightService");
const { compilePodcastEdlFile } = require("./podcastViralService");
const {
  consolidateStoryRecutSegments,
  scoreStoryRecutVariant
} = require("./storyRecutService");
const {
  parseGeminiJsonObject,
  unwrapStoryScript
} = require("./geminiJsonArtifactService");
const { validateDiyFinalScript } = require("./diyStoryRemixService");
const { compileStorySpineScript, isStorySpineScript } = require("./storySpineCompilerService");
const {
  buildTikTokKaraokeAssContent,
  buildWordTimestampsFromSegments
} = require("./karaokeSubtitleService");
const { getCancelToken, throwIfCancelled } = require("./cancelToken");

function runCommand(command, args, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const child = spawn(command, args, { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}: ${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function resolveManualGeminiManifestPath(packageDir) {
  const candidates = [
    path.join(packageDir, "01-GUI-GEMINI", "scene-manifest.json"),
    path.join(packageDir, "scene-manifest.json")
  ];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile() && stat.size > 2) return candidate;
    } catch (_error) {
      // Continue to the legacy package layout.
    }
  }
  return "";
}

function toSrtTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const sec = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const min = totalMinutes % 60;
  const hour = Math.floor(totalMinutes / 60);
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function audioExtensionForProvider(provider) {
  return provider === "omnivoice" || provider === "kokoro" || provider === "windows_local" ? ".wav" : ".mp3";
}

function buildVoiceBatchGroups(segments = [], { maxDurationSec = 45, maxGapSec = 0.15 } = {}) {
  const groups = [];
  let current = null;
  for (const [index, segment] of segments.entries()) {
    const startSec = Math.max(0, safeNumber(segment.startSec, 0));
    const endSec = Math.max(startSec + 0.2, safeNumber(segment.endSec, startSec + safeNumber(segment.duration, 1)));
    const text = safeText(segment.dubbingLine || segment.text || segment.translatedText || segment.caption || "");
    if (!current) {
      current = { startSec, endSec, items: [{ index, segment, startSec, endSec, text }] };
      continue;
    }
    const gapSec = startSec - current.endSec;
    const nextDuration = endSec - current.startSec;
    if (gapSec > maxGapSec || nextDuration > maxDurationSec) {
      groups.push(current);
      current = { startSec, endSec, items: [{ index, segment, startSec, endSec, text }] };
      continue;
    }
    current.endSec = Math.max(current.endSec, endSec);
    current.items.push({ index, segment, startSec, endSec, text });
  }
  if (current) {
    groups.push(current);
  }
  return groups.map((group, groupIndex) => ({
    ...group,
    groupIndex,
    text: group.items.map((item) => item.text).filter(Boolean).join("\n")
  }));
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeText(value, fallback = "") {
  return stripGeminiCitationMarkers(String(value || fallback)).replace(/\s+/g, " ").trim();
}

function stripGeminiCitationMarkers(value = "") {
  return String(value || "")
    .replace(/\[\s*cite\s*:\s*[^\]]+\]/gi, "")
    .replace(/【\s*\d+(?:†[^】]*)?】/g, "")
    .replace(/\s+([,.;!?])/g, "$1")
    .trim();
}

function hasGeminiCitationMarkers(value = "") {
  const text = String(value || "");
  return /\[\s*cite\s*:\s*[^\]]+\]/i.test(text) || /【\s*\d+(?:†[^】]*)?】/.test(text);
}

function shouldUseStorytimeVoiceBatch({
  voiceProvider,
  storytimeVoiceRenderMode,
  omniVoiceRenderMode,
  useContinuousStorytimeVoice
}) {
  if (voiceProvider === "omnivoice") {
    return !useContinuousStorytimeVoice && omniVoiceRenderMode === "batch";
  }
  return storytimeVoiceRenderMode === "clustered";
}

function hasVietnameseDiacritics(text = "") {
  return /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(String(text || ""));
}

function hasEnglishWords(text = "") {
  return /\b[a-z]{3,}\b/i.test(String(text || ""));
}

function splitSubtitlePhrases(text = "", maxWords = 12) {
  const normalized = safeText(text);
  if (!normalized) return [];
  const sentences = normalized.match(/[^.!?;:]+(?:[.!?;:]+|$)/g) || [normalized];
  const phrases = [];
  for (const sentence of sentences.map((item) => safeText(item)).filter(Boolean)) {
    const words = sentence.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) {
      phrases.push(sentence);
      continue;
    }
    const commaParts = sentence.split(/(?<=[,])\s+/).map((item) => safeText(item)).filter(Boolean);
    if (commaParts.length > 1 && commaParts.every((item) => item.split(/\s+/).length <= maxWords + 3)) {
      phrases.push(...commaParts);
      continue;
    }
    for (let index = 0; index < words.length; index += maxWords) {
      phrases.push(words.slice(index, index + maxWords).join(" "));
    }
  }
  return phrases;
}

function buildTimedSubtitlePhrases({ id = "preview", text = "", startSec = 0, endSec = 0 } = {}) {
  const phrases = splitSubtitlePhrases(text);
  if (!phrases.length) return [];
  const safeStart = Math.max(0, safeNumber(startSec, 0));
  const safeEnd = Math.max(safeStart + 0.2, safeNumber(endSec, safeStart + 0.2));
  const weights = phrases.map((phrase) => Math.max(1, phrase.split(/\s+/).filter(Boolean).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = safeStart;
  return phrases.map((phrase, index) => {
    const phraseEnd = index === phrases.length - 1
      ? safeEnd
      : cursor + ((safeEnd - safeStart) * weights[index] / totalWeight);
    const cue = {
      id: `${id}__voice_${String(index + 1).padStart(3, "0")}`,
      startSec: Number(cursor.toFixed(3)),
      endSec: Number(Math.max(cursor + 0.05, phraseEnd).toFixed(3)),
      text: phrase,
      previewSubtitleVi: hasVietnameseDiacritics(phrase) ? phrase : ""
    };
    cursor = phraseEnd;
    return cue;
  });
}

function subtitleWords(text = "") {
  return safeText(text)
    .split(/\s+/)
    .map((word) => ({
      raw: word,
      normalized: word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    }))
    .filter((word) => word.normalized);
}

function suffixPrefixWordOverlap(previousText = "", currentText = "") {
  const previous = subtitleWords(previousText);
  const current = subtitleWords(currentText);
  const maxOverlap = Math.min(previous.length, current.length);
  for (let count = maxOverlap; count >= 1; count -= 1) {
    const previousSuffix = previous.slice(previous.length - count).map((word) => word.normalized).join(" ");
    const currentPrefix = current.slice(0, count).map((word) => word.normalized).join(" ");
    if (previousSuffix === currentPrefix) return count;
  }
  return 0;
}

function normalizeRollingSubtitleCues(cues = [], {
  transientCueMaxSec = 0.08,
  adjacentGapMaxSec = 0.2,
  minimumOverlapWords = 2
} = {}) {
  const sorted = (Array.isArray(cues) ? cues : [])
    .map((cue, index) => ({
      ...cue,
      id: cue.id || `source_subtitle_${String(index + 1).padStart(5, "0")}`,
      startSec: Math.max(0, safeNumber(cue.startSec, 0)),
      endSec: Math.max(safeNumber(cue.startSec, 0) + 0.01, safeNumber(cue.endSec, safeNumber(cue.startSec, 0) + 0.01)),
      text: safeText(cue.text || cue.originalText || "")
    }))
    .filter((cue) => cue.text)
    .sort((left, right) => left.startSec - right.startSec || left.endSec - right.endSec);
  const transientCueCount = sorted.filter((cue) => cue.endSec - cue.startSec <= transientCueMaxSec).length;
  const overlapPairCount = sorted.slice(1).filter((cue, index) => {
    const previous = sorted[index];
    return cue.startSec - previous.endSec <= adjacentGapMaxSec
      && suffixPrefixWordOverlap(previous.text, cue.text) >= minimumOverlapWords;
  }).length;
  const looksLikeRollingCaptions = transientCueCount >= Math.max(2, Math.floor(sorted.length * 0.05))
    || overlapPairCount >= Math.max(3, Math.floor(sorted.length * 0.2));
  if (!looksLikeRollingCaptions) return sorted;
  const hasUsableCues = transientCueCount < sorted.length;
  const stable = hasUsableCues
    ? sorted.filter((cue) => cue.endSec - cue.startSec > transientCueMaxSec)
    : sorted;
  const normalized = [];
  let previousSourceCue = null;
  for (const cue of stable) {
    let text = cue.text;
    if (previousSourceCue && cue.startSec - previousSourceCue.endSec <= adjacentGapMaxSec) {
      const overlapWords = suffixPrefixWordOverlap(previousSourceCue.text, cue.text);
      const currentWords = subtitleWords(cue.text);
      if (overlapWords === currentWords.length && overlapWords > 0) {
        previousSourceCue = cue;
        continue;
      }
      if (overlapWords >= minimumOverlapWords) {
        text = currentWords.slice(overlapWords).map((word) => word.raw).join(" ");
      }
    }
    if (text) normalized.push({ ...cue, text });
    previousSourceCue = cue;
  }
  return normalized;
}

function readWordTimestampClusters(payload = {}, minimumGapSec = 0.65) {
  const words = (Array.isArray(payload?.segments) ? payload.segments : [])
    .flatMap((segment) => Array.isArray(segment?.words) ? segment.words : [])
    .map((word) => ({
      text: safeText(word.word || word.text || ""),
      startSec: Math.max(0, safeNumber(word.start, word.startSec)),
      endSec: Math.max(safeNumber(word.start, word.startSec) + 0.01, safeNumber(word.end, word.endSec))
    }))
    .filter((word) => word.text)
    .sort((left, right) => left.startSec - right.startSec);
  const clusters = [];
  for (const word of words) {
    const current = clusters.at(-1);
    if (!current || word.startSec - current.endSec >= minimumGapSec) {
      clusters.push({ startSec: word.startSec, endSec: word.endSec, words: [word] });
      continue;
    }
    current.endSec = Math.max(current.endSec, word.endSec);
    current.words.push(word);
  }
  return clusters;
}

function buildDraftVoiceTranscriptEntries({ entries = [], wordTimestampPayload = null } = {}) {
  const clusters = readWordTimestampClusters(wordTimestampPayload || {});
  const canUseClusters = clusters.length === entries.length;
  return entries.map((entry, position) => {
    const durationSec = Math.max(0.2, entry.reelEndSec - entry.reelStartSec);
    const cluster = canUseClusters ? clusters[position] : null;
    const localStartSec = cluster
      ? Math.max(0, Math.min(durationSec - 0.05, cluster.startSec - entry.reelStartSec))
      : 0;
    const localEndSec = cluster
      ? Math.max(localStartSec + 0.05, Math.min(durationSec, cluster.endSec - entry.reelStartSec))
      : durationSec;
    return {
      index: entry.index,
      cues: buildTimedSubtitlePhrases({
        id: `highlight_voice_${entry.index + 1}`,
        text: entry.renderedText,
        startSec: localStartSec,
        endSec: localEndSec
      })
    };
  });
}

function getOriginalAudioTranscriptCandidate(segment = {}) {
  const candidates = [
    segment.sourceDialogue,
    segment.source_dialogue,
    segment.dialogueTranscript,
    segment.dialogue_transcript,
    segment.sourceTranscript,
    segment.source_transcript,
    segment.previewSubtitleVi,
    segment.previewVi,
    segment.preview_vi,
    segment.translatedText,
    segment.caption
  ].map((value) => safeText(value)).filter((value) => value && hasEnglishWords(value));
  return candidates.sort((left, right) => right.split(/\s+/).length - left.split(/\s+/).length)[0] || "";
}

function shouldUseOriginalAudioTranscriptCandidate({ cues = [], candidateText = "", startSec = 0, endSec = 0 } = {}) {
  const durationSec = Math.max(0.2, safeNumber(endSec, 0) - safeNumber(startSec, 0));
  const candidateWords = safeText(candidateText).split(/\s+/).filter(Boolean).length;
  if (candidateWords < Math.max(8, Math.floor(durationSec))) return false;
  if (!cues.length) return true;
  const sorted = [...cues].sort((a, b) => safeNumber(a.startSec, 0) - safeNumber(b.startSec, 0));
  const leadingGapSec = Math.max(0, safeNumber(sorted[0]?.startSec, startSec) - safeNumber(startSec, 0));
  const trailingGapSec = Math.max(0, safeNumber(endSec, 0) - safeNumber(sorted.at(-1)?.endSec, endSec));
  const coveredSec = sorted.reduce((total, cue) => total + Math.max(
    0,
    Math.min(safeNumber(endSec, 0), safeNumber(cue.endSec, 0))
      - Math.max(safeNumber(startSec, 0), safeNumber(cue.startSec, 0))
  ), 0);
  const coverageRatio = Math.min(1, coveredSec / durationSec);
  return leadingGapSec > 0.8 || trailingGapSec > 1.2 || coverageRatio < 0.72;
}

function inferFastDraftLanguage(text = "", project = {}) {
  const content = safeText(text);
  if (hasVietnameseDiacritics(content)) return "vi";
  const englishWords = content.match(/\b[a-z]{3,}\b/gi) || [];
  if (englishWords.length >= 2) return "en";
  const projectLanguage = safeText(project.targetLanguage || project.narrationLanguage || project.language || "");
  if (/^en\b/i.test(projectLanguage)) return "en";
  if (/^vi\b/i.test(projectLanguage)) return "vi";
  return projectLanguage || "vi";
}

async function translatePreviewSegmentsToVietnamese({ settings = {}, segments = [], sourceLanguage = "en", onProgress }) {
  const errors = [];
  if (settings.localPreviewTranslationEnabled !== false) {
    try {
      const localTranslator = new LocalTranslationService(settings);
      return await localTranslator.translateToVietnamese({
        segments,
        sourceLanguage,
        onProgress
      });
    } catch (error) {
      errors.push(`Dịch local: ${error.message}`);
    }
  }

  const translateWithProvider = async (providerSettings) => {
    const provider = createAiProvider(providerSettings);
    if (provider instanceof LocalFallbackProvider) {
      throw new Error("AI provider hiện tại không hỗ trợ dịch phụ đề preview.");
    }
    if (typeof provider.translatePreviewSubtitles === "function") {
      return provider.translatePreviewSubtitles({ segments, sourceLanguage });
    }
    if (typeof provider.translateSegments === "function") {
      return provider.translateSegments({
        segments,
        targetLanguage: "vi",
        sourceLanguage,
        sceneCards: [],
        scenes: [],
        media: {}
      });
    }
    throw new Error("AI provider hiện tại không có hàm dịch phụ đề.");
  };

  try {
    return await translateWithProvider(settings);
  } catch (error) {
    errors.push(`AI provider: ${error.message}`);
  }
  if (settings.geminiApiKey && (settings.aiProvider || settings.defaultAiProvider) !== "gemini") {
    try {
      return await translateWithProvider({ ...settings, aiProvider: "gemini" });
    } catch (error) {
      errors.push(`Gemini fallback: ${error.message}`);
    }
  }
  throw new Error(errors.join(" | "));
}

function isQuotaExceededError(error) {
  return /quota[_\s-]*exceeded|exceeds your quota|credits remaining/i.test(error?.message || "");
}

function inferVolumeFromText(text, fallback = 0.2) {
  const match = safeText(text).match(/(\d{1,3})\s*%/);
  if (!match) {
    return fallback;
  }
  return Math.max(0, Math.min(1, Number(match[1]) / 100));
}

function normalizeForSimilarity(value = "") {
  return safeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function measureRewriteSimilarity(segments = []) {
  const comparable = segments
    .map((segment) => ({
      source: normalizeForSimilarity(segment.originalText || segment.text || ""),
      rewritten: normalizeForSimilarity(segment.rewrittenScript || segment.dubbingLine || segment.translatedText || "")
    }))
    .filter((item) => item.source && item.rewritten);
  if (!comparable.length) {
    return { total: 0, unchanged: 0, ratio: 1 };
  }
  const unchanged = comparable.filter((item) => item.source === item.rewritten).length;
  return {
    total: comparable.length,
    unchanged,
    ratio: unchanged / comparable.length
  };
}

function countWords(text) {
  return safeText(text).split(/\s+/).filter(Boolean).length;
}

function estimateSpeechSeconds(text) {
  return estimateSpeechSecondsWithPolicy(text, DEFAULT_WORDS_PER_SECOND);
}

function getVoiceDrivenRenderDuration(baseDurationSec, rawVoiceSec, hasVoice = true) {
  const baseDuration = Math.max(0.3, safeNumber(baseDurationSec, 0.3));
  const voiceDuration = Math.max(0, safeNumber(rawVoiceSec, 0));
  if (!hasVoice || voiceDuration <= 0.05) {
    return baseDuration;
  }
  return Math.max(0.3, Number(voiceDuration.toFixed(3)));
}

function getHighlightNarrationSourceVolume(project = {}) {
  const mixer = project.mixer || {};
  if (mixer.narrationSourceAudioOverride !== true) return 0;
  return Math.max(0, Math.min(1, safeNumber(mixer.sourceVolume, 0) / 100));
}

function getHighlightAudioMode(segment = {}, hasVoice = Boolean(getHighlightVoiceText(segment)), project = {}) {
  if (!hasVoice) return "original_audio";
  const requested = String(segment.audioMode || segment.audio_mode || segment.requestedAudioMode || "").toLowerCase();
  if (requested === "voiceover_with_ambient" || requested === "mixed_ducking") {
    return "voiceover_with_ambient";
  }
  if (getHighlightNarrationSourceVolume(project) > 0) {
    return "voiceover_with_ambient";
  }
  return "voiceover_only";
}

function getHighlightAmbientVolume(segment = {}, project = {}) {
  if (getHighlightAudioMode(segment, Boolean(getHighlightVoiceText(segment)), project) !== "voiceover_with_ambient") return 0;
  const projectVol = getHighlightNarrationSourceVolume(project);
  if (projectVol > 0) return projectVol;
  const segVol = safeNumber(segment.sourceAmbientVolume ?? segment.source_ambient_volume, 0.15);
  return Math.max(0.08, Math.min(0.3, segVol));
}

// One 30fps frame plus mp4 container rounding.
const BLOCK_DURATION_TOLERANCE_SEC = (1 / 30) + 0.02;

// Ambient bed under a narrated block (voiceover_with_ambient): same policy as a
// voiced segment, applied once to the whole block.
function getBlockAmbientVolume(segment = {}, project = {}) {
  const projectVol = getHighlightNarrationSourceVolume(project);
  if (projectVol > 0) return projectVol;
  const segVol = safeNumber(segment.sourceAmbientVolume ?? segment.source_ambient_volume, 0.15);
  return Math.max(0.08, Math.min(0.3, segVol));
}

// Per-member draft report for a block: visual timing only (the voice belongs to
// the block, so no member is voice-fitted or retimed on its own).
function memberReportsFor(pieces = [], blockReport = {}) {
  return pieces.map((p, offset) => ({
    index: (blockReport.startIndex || 0) + offset,
    sceneId: p.segment.sceneId || p.segment.id,
    startSec: Number(p.sourceStartSec.toFixed(3)),
    endSec: Number(p.sourceEndSec.toFixed(3)),
    sourceDurationSec: Number(p.sourceDurationSec.toFixed(3)),
    requestedTimelineSec: Number(p.durationSec.toFixed(3)),
    timelineSec: Number(p.durationSec.toFixed(3)),
    playbackSpeed: Number((p.sourceDurationSec / Math.max(0.3, p.durationSec)).toFixed(4)),
    mode: "narrated_block_member",
    deliveryBlockId: blockReport.blockId || p.segment.deliveryBlockId,
    audioMode: blockReport.sourceAudioTreatment || p.segment.audioMode,
    visualFitStrategy: "as_requested",
    voiceFitStrategy: "block_continuous"
  }));
}

// Output placement of each rendered block (visual durations are the EDL's).
function placeNarratedBlocks(segments = [], blockReports = []) {
  const starts = []; let cursor = 0;
  segments.forEach((segment, index) => { starts[index] = cursor; cursor += Math.max(0.3, safeNumber(segment.duration, 0)); });
  return blockReports.map((report) => {
    const outputStartSec = Number((starts[report.startIndex] || 0).toFixed(3));
    return { ...report, outputStartSec, outputEndSec: Number((outputStartSec + report.blockTimelineSec).toFixed(3)), durationSec: report.blockTimelineSec,
      fittedVoicePath: undefined, blockVideoPath: undefined };
  });
}

function resolveHighlightVoiceFit(segment = {}, plannedDurationSec, actualVoiceDurationSec) {
  const audioMode = getHighlightAudioMode(segment, true);
  const protectedVisual = segment.actionOverride === true
    || segment.sustainedBeatOverride === true
    || segment.completeNarrativeBeat === true
    || segment.originalAudioProtected === true;
  return resolveVoiceVisualFit({
    plannedDurationSec,
    actualVoiceDurationSec,
    hasVoice: true,
    audioMode,
    protectedVisual
  });
}

function describeHighlightVoiceFitWarning(index, fitPolicy) {
  if (!fitPolicy?.warningCode) return "";
  const prefix = `Highlight ${index + 1}: voice ${fitPolicy.actualVoiceDurationSec.toFixed(2)}s / cảnh kế hoạch ${fitPolicy.plannedDurationSec.toFixed(2)}s.`;
  if (fitPolicy.warningCode === "voice_far_too_long" || fitPolicy.warningCode === "visual_slowdown_limit_exceeded") {
    return `${prefix} Voice quá dài; tool giữ đủ câu và chỉ tăng nhịp tối đa khoảng 8%, nhưng cảnh vẫn cần được viết gọn hoặc bổ sung B-roll đã xác minh.`;
  }
  if (fitPolicy.warningCode === "voice_too_long") {
    return `${prefix} Tool đã tăng nhẹ nhịp đọc và giãn hình có giới hạn; nên rút gọn câu ở lần review tiếp theo.`;
  }
  if (fitPolicy.warningCode === "voice_far_too_short") {
    return `${prefix} Voice quá ngắn; tool ${fitPolicy.strategy === "trim_flexible_broll_to_voice" ? "cắt B-roll linh hoạt theo voice" : "giữ trọn hành động và bàn giao phần còn lại cho ambience"}.`;
  }
  return prefix;
}

function coalesceContiguousOriginalAudioSegments(segments = [], options = {}) {
  const allowCoalesce = options.allowCoalesce !== false;
  const frameToleranceSec = Math.max(0.001, safeNumber(options.frameToleranceSec, (1 / 30) + 0.005));
  const maxBlockDurationSec = Math.max(1, safeNumber(options.maxBlockDurationSec, 30));
  const groups = [];

  for (const [index, segment] of segments.entries()) {
    const sourceStartSec = Math.max(0, safeNumber(segment.sourceStartSec ?? segment.startSec, 0));
    const sourceEndSec = Math.max(
      sourceStartSec + 0.3,
      safeNumber(segment.sourceEndSec, sourceStartSec + safeNumber(segment.sourceDuration || segment.duration, 1))
    );
    const outputStartSec = safeNumber(segment.startSec, groups.at(-1)?.endSec || 0);
    const outputEndSec = Math.max(
      outputStartSec + 0.3,
      safeNumber(segment.endSec, outputStartSec + safeNumber(segment.duration, sourceEndSec - sourceStartSec))
    );
    const playbackSpeed = safeNumber(
      segment.playbackSpeed,
      (sourceEndSec - sourceStartSec) / Math.max(0.3, outputEndSec - outputStartSec)
    );
    const renderMember = { index, segment };
    const group = {
      ...segment,
      sourceStartSec,
      sourceEndSec,
      sourceDuration: sourceEndSec - sourceStartSec,
      startSec: outputStartSec,
      endSec: outputEndSec,
      duration: outputEndSec - outputStartSec,
      playbackSpeed,
      evidenceIds: [safeText(segment.evidenceId)].filter(Boolean),
      renderMembers: [renderMember]
    };
    const hasVoice = Boolean(getHighlightVoiceText(segment));
    const isCleanOriginalAudio = !hasVoice
      && !segment.replaceSourceNarrator
      && !segment.forceSourceMute;
    const previous = groups.at(-1);
    const previousHasVoice = previous ? Boolean(getHighlightVoiceText(previous)) : false;
    const previousIsCleanOriginalAudio = previous
      && !previousHasVoice
      && !previous.replaceSourceNarrator
      && !previous.forceSourceMute;
    const sourceIsContiguous = previous
      && Math.abs(previous.sourceEndSec - sourceStartSec) <= frameToleranceSec;
    const outputIsContiguous = previous
      && Math.abs(previous.endSec - outputStartSec) <= frameToleranceSec;
    const speedMatches = previous
      && Math.abs(safeNumber(previous.playbackSpeed, 1) - playbackSpeed) <= 0.002;
    const mergedDuration = previous ? outputEndSec - previous.startSec : group.duration;

    if (
      allowCoalesce
      && isCleanOriginalAudio
      && previousIsCleanOriginalAudio
      && sourceIsContiguous
      && outputIsContiguous
      && speedMatches
      && mergedDuration <= maxBlockDurationSec + frameToleranceSec
    ) {
      previous.sourceEndSec = sourceEndSec;
      previous.sourceDuration = previous.sourceEndSec - previous.sourceStartSec;
      previous.endSec = outputEndSec;
      previous.duration = previous.endSec - previous.startSec;
      previous.evidenceIds.push(...group.evidenceIds);
      previous.renderMembers.push(renderMember);
      previous.id = `${previous.id || "highlight"}__${segment.id || `segment_${index + 1}`}`;
      continue;
    }

    groups.push(group);
  }

  return groups;
}

function getSegmentSourceTiming(segment = {}) {
  const sourceStartSec = Math.max(0, safeNumber(segment.sourceStartSec ?? segment.startSec, 0));
  const sourceEndFallback = sourceStartSec + safeNumber(segment.sourceDuration || segment.duration || segment.durationSec, 1);
  const sourceEndSec = Math.max(sourceStartSec + 0.3, safeNumber(segment.sourceEndSec ?? segment.endSec, sourceEndFallback));
  return {
    sourceStartSec,
    sourceEndSec,
    sourceDurationSec: sourceEndSec - sourceStartSec
  };
}

function textHash(text = "") {
  return crypto
    .createHash("sha1")
    .update(safeText(text).replace(/\s+/g, " ").trim())
    .digest("hex")
    .slice(0, 16);
}

function maxWordsForDuration(durationSec) {
  return Math.max(2, Math.floor(Math.max(0.2, safeNumber(durationSec, 0)) * DEFAULT_WORDS_PER_SECOND));
}

function getStorytimeVoiceText(segment = {}) {
  const audioMode = safeText(segment.audioMode || segment.audio_mode || "");
  const explicitVoiceText = safeText(
    segment.dubbingLine ||
    segment.storyText ||
    segment.voiceover_text ||
    segment.voiceoverText ||
    segment.voiceover ||
    segment.narration ||
    ""
  );
  if (audioMode === "original_audio" && !explicitVoiceText) {
    return "";
  }
  return safeText(segment.dubbingLine || segment.storyText || segment.text || segment.translatedText || "");
}

function getStorytimeLastEndSec(segments = []) {
  return Math.max(0, ...segments.map((segment) => {
    const startSec = Math.max(0, safeNumber(segment.startSec, 0));
    return Math.max(startSec, safeNumber(segment.endSec, startSec + safeNumber(segment.durationSec || segment.duration, 0)));
  }));
}

function getStorytimeBridgeLines(language = "en", sampleText = "") {
  const vietnameseBridgeLines = [
    "Và từng giây của quá trình này càng làm phần kết quả cuối cùng trở nên đáng chờ đợi hơn.",
    "Mọi thứ vẫn tiếp tục tiến triển, từng chi tiết nhỏ dần biến toàn bộ khung hình thành thứ rất cuốn mắt.",
    "Điều khiến đoạn này thỏa mãn là mỗi bước nhỏ đều làm kết quả thay đổi rõ rệt hơn.",
    "Sau đó quá trình biến đổi tiếp tục diễn ra từng lớp một, cho đến khi mọi thứ trông hoàn toàn khác trước.",
    "Đến lúc này, đây không chỉ là tiến độ nữa, mà chính là phần khiến người xem muốn ở lại đến cuối."
  ];
  const englishBridgeLines = [
    "And every second of this build makes the final reveal feel more impossible.",
    "The process keeps moving, and each detail slowly turns the whole scene into something worth watching.",
    "What makes this so satisfying is how each small step quietly changes the entire result.",
    "Then the transformation keeps going, layer by layer, until the project starts to look completely different.",
    "By this point, the work is not just progress anymore, it is the part that keeps people watching."
  ];
  return /^vi\b/i.test(language) || hasVietnameseDiacritics(sampleText)
    ? vietnameseBridgeLines
    : englishBridgeLines;
}

function buildContinuousStorytimeText(segments = [], targetDurationSec = 0, language = "en") {
  const baseParts = segments.map(getStorytimeVoiceText).filter(Boolean);
  const bridgeLines = getStorytimeBridgeLines(language, baseParts.join(" "));
  const targetWords = Math.max(countWords(baseParts.join(" ")), Math.floor(Math.max(1, targetDurationSec) * DEFAULT_WORDS_PER_SECOND * 0.94));
  const maxWords = Math.floor(Math.max(1, targetDurationSec) * 2.65);
  const parts = [...baseParts];
  let guard = 0;
  while (countWords(parts.join(" ")) < targetWords && countWords(parts.join(" ")) < maxWords && guard < 40) {
    parts.push(bridgeLines[guard % bridgeLines.length]);
    guard += 1;
  }
  return safeText(parts.join(" "));
}

function buildSceneLockedStorytimeText(segment = {}, durationSec = 0, language = "en", index = 0) {
  const baseText = getStorytimeVoiceText(segment);
  const bridgeLines = getStorytimeBridgeLines(language, baseText);
  const targetWords = Math.max(countWords(baseText), Math.floor(Math.max(1, durationSec) * DEFAULT_WORDS_PER_SECOND * 0.88));
  const maxWords = Math.floor(Math.max(1, durationSec) * 2.65);
  const parts = [baseText].filter(Boolean);
  let guard = 0;
  while (countWords(parts.join(" ")) < targetWords && countWords(parts.join(" ")) < maxWords && guard < 10) {
    parts.push(bridgeLines[(index + guard) % bridgeLines.length]);
    guard += 1;
  }
  return safeText(parts.join(" ")) || bridgeLines[index % bridgeLines.length];
}

function buildDraftVoiceGeminiPrompt({ title = "", segments = [], warnings = [], independentNarrationPolicy = false }) {
  const lines = independentNarrationPolicy
    ? [
      "Bạn là Gemini. Hãy sửa Story Spine của kịch bản true-crime/bodycam dựa trên timing TTS thật bên dưới.",
      "",
      "Yêu cầu bắt buộc:",
      "- Giữ nguyên central viewer question, Hook promise, Climax và Payoff đã khóa; chỉ sửa cấu trúc audio/narration cần thiết.",
      "- Không có block voiceover_only liên tục nào được vượt quá 8.0 giây TTS thật.",
      "- Ngoại lệ source-narrator replacement tối đa 10.0 giây khi không có dialogue/action audio đáng giữ.",
      "- Không rút ngắn text rồi giữ nguyên một source range 30-60 giây. Phải tách thành: VO bridge 3-8s -> original_audio evidence -> VO bridge 3-6s tùy chọn.",
      "- Không đặt hai voiceover_only beat liền nhau. Mỗi VO phải bàn giao ngay cho một quote, command, reaction, discovery hoặc action thật.",
      "- Hook và Climax dùng original_audio khi có participant dialogue hoặc action sound sạch.",
      "- Mọi đoạn có tool narrator phải dùng voiceover_only; renderer mặc định tắt hoàn toàn soundtrack nguồn. User có thể chủ động bật lại âm nền trong tab Chỉnh sửa video.",
      "- Không dùng minimum word quota và không cố phủ 85%-100% timeline. Một câu ngắn, hoàn chỉnh là hợp lệ.",
      "- Được thay đổi sourceStartSec/sourceEndSec và tách thêm Narrative Beat để tạo nhịp đúng; không tự tạo output start/end.",
      "- Không bịa thêm sự kiện, câu nói hoặc timestamp không có trong source transcript/proxy.",
      "- Trả về đúng một JSON object hoàn chỉnh trong một Markdown code block ```json, không có prose bên ngoài.",
      ""
    ]
    : [
      "Bạn là Gemini. Hãy viết lại các cảnh Storytime bị lỗi timing voice bên dưới.",
      "",
      "Yêu cầu bắt buộc:",
      "- Giữ nguyên schema JSON hiện tại, thứ tự cảnh, startSec và endSec.",
      "- Chỉ sửa nội dung thuyết minh của các cảnh bị liệt kê.",
      "- Không bịa thêm sự kiện trái với hình ảnh trong cảnh.",
      "- Viết thành một câu chuyện liền mạch, nối ý tự nhiên giữa cảnh trước và cảnh sau.",
      "- Không viết kiểu mô tả từng cảnh rời rạc như checklist biên tập video.",
      "- Mục tiêu là giọng TTS tiếng Anh đọc tự nhiên, phủ khoảng 85%-100% thời lượng mỗi cảnh.",
      "- Không để voice quá ngắn gây khoảng câm, cũng không quá dài khiến bị cắt khi sang cảnh tiếp theo.",
      "- Trả về đúng một JSON object hoàn chỉnh trong đúng một Markdown code block bắt đầu bằng ```json và kết thúc bằng ```.",
      "- Không thêm hội thoại, tiêu đề, nhãn file hoặc giải thích trước hay sau code block.",
      "- Kiểm tra để nội dung trong code block có thể được JSON.parse trực tiếp trước khi trả lời.",
      ""
    ];
  if (title) {
    lines.push(`Tiêu đề dự án: ${title}`, "");
  }
  if (segments.length) {
    lines.push("Bối cảnh toàn bộ câu chuyện để giữ mạch kể:");
    segments.forEach((item) => {
      const marker = item.status === "ok" ? "OK" : "CẦN SỬA";
      const text = safeText(item.currentText || "").slice(0, 700);
      lines.push(`- Cảnh ${item.sceneNumber} [${marker}] ${item.startSec}s-${item.endSec}s: ${text}`);
    });
    lines.push("");
  }
  lines.push("Các cảnh cần viết lại:");
  warnings.forEach((item) => {
    lines.push(
      "",
      `Cảnh ${item.sceneNumber} (${item.startSec}s-${item.endSec}s, timeline ${item.timelineSec}s):`,
      `- Audio mode hiện tại: ${item.audioMode}.`,
      `- Lỗi: ${item.problem}`,
      `- Voice hiện tại: ${item.rawVoiceSec}s, tỷ lệ phủ ${Math.round(item.coverageRatio * 100)}%.`,
      independentNarrationPolicy
        ? "- Mục tiêu: mỗi block TTS tối đa 8.0s và phải được ngăn cách bằng original_audio evidence."
        : `- Mục tiêu voice mới: ${item.targetVoiceRangeSec.min}s-${item.targetVoiceRangeSec.max}s.`,
      `- Gợi ý chỉnh: ${item.recommendation}`,
      `- Text hiện tại: ${item.currentText || "(trống)"}`
    );
  });
  return lines.join("\n");
}

function buildDraftVoiceAlignmentReport({ project = {}, segments = [], draftVoiceReports = [] }) {
  const { minCoverage, maxCoverage } = VOICE_TIMING_THRESHOLDS;
  const activeVariant = getActiveHighlightVariant(project);
  const independentNarrationPolicy = project.analysisWorkflow === "manual_gemini_draft_review"
    && safeText(activeVariant?.promptProfile).toLowerCase() === "independent";
  const items = segments.map((segment = {}, index) => {
    const report = draftVoiceReports[index] || {};
    const startSec = Number(safeNumber(report.startSec, safeNumber(segment.startSec, 0)).toFixed(3));
    const endSec = Number(safeNumber(report.endSec, safeNumber(segment.endSec, startSec)).toFixed(3));
    const plannedTimelineSec = Math.max(
      0.3,
      safeNumber(report.plannedTimelineSec ?? report.requestedTimelineSec, endSec - startSec)
    );
    const resolvedTimelineSec = Math.max(0.3, safeNumber(report.resolvedTimelineSec ?? report.timelineSec, plannedTimelineSec));
    const currentText = safeText(report.renderedText || "") || getStorytimeVoiceText(segment) || getHighlightVoiceText(segment);
    const rawVoiceSec = Math.max(0, safeNumber(report.rawVoiceSec, estimateSpeechSeconds(currentText)));
    const hasVoice = Boolean(currentText);
    const timing = measureVoiceTiming({
      plannedDurationSec: plannedTimelineSec,
      actualVoiceDurationSec: rawVoiceSec,
      text: currentText,
      profileWordsPerSecond: safeNumber(report.voiceProfileWordsPerSecond, 0)
    });
    if (!hasVoice) {
      timing.status = "not_applicable";
      timing.severity = "ok";
      timing.problem = "Cảnh dùng âm thanh gốc, không có voice thuyết minh.";
      timing.recommendation = "Giữ nguyên audio mode.";
      timing.suggestedWordDelta = 0;
    }
    if (report.mode === "narrated_block_member") {
      // Voice belongs to the continuous narrated block, fitted once for the whole block.
      timing.status = "ok";
      timing.severity = "ok";
      timing.problem = `Thuộc khối narrator liên tục ${report.deliveryBlockId}; voice được đo và khớp một lần cho cả khối.`;
      timing.recommendation = "Giữ nguyên.";
      timing.suggestedWordDelta = 0;
    }

    return {
      index,
      sceneId: safeText(report.sceneId || segment.sceneId || segment.id || `scene_${String(index + 1).padStart(4, "0")}`),
      sceneNumber: index + 1,
      audioMode: safeText(segment.audioMode || segment.audio_mode || (hasVoice ? "voiceover_only" : "original_audio")),
      hasVoice,
      status: timing.status,
      severity: timing.severity,
      startSec,
      endSec,
      timelineSec: timing.plannedDurationSec,
      plannedTimelineSec: timing.plannedDurationSec,
      resolvedTimelineSec: Number(resolvedTimelineSec.toFixed(3)),
      rawVoiceSec: timing.actualVoiceDurationSec,
      coverageRatio: timing.coverageRatio,
      deadAirSec: timing.deadAirSec,
      overflowSec: timing.overflowSec,
      wordCount: timing.wordCount,
      estimatedWordsPerSecond: timing.measuredWordsPerSecond,
      profileWordsPerSecond: timing.profileWordsPerSecond,
      voiceProfileKey: report.voiceProfileKey || "",
      voiceProfileSampleCount: safeNumber(report.voiceProfileSampleCount, 0),
      suggestedWordDelta: timing.suggestedWordDelta,
      targetVoiceRangeSec: timing.targetVoiceRangeSec,
      currentText,
      textHash: report.textHash || textHash(currentText),
      originalText: safeText(segment.originalText || ""),
      caption: safeText(segment.caption || ""),
      problem: timing.problem,
      recommendation: timing.recommendation,
      visualFitStrategy: report.visualFitStrategy || "as_requested",
      voiceFitStrategy: report.voiceFitStrategy || "as_requested",
      voiceFitWarning: safeText(report.voiceFitWarning || "")
    };
  });
  items.forEach((item) => {
    if (!item.voiceFitWarning) return;
    item.problem = `${item.problem} ${item.voiceFitWarning}`.trim();
    if (["ok", "not_applicable"].includes(item.status)) {
      item.status = "voice_visual_fit_warning";
      item.severity = "warning";
    }
  });
  if (independentNarrationPolicy) {
    items.forEach((item, index) => {
      item.editorialWarnings = [];
      if (!item.hasVoice) return;
      const report = draftVoiceReports[index] || {};
      const maxContinuousSec = report.sourceNarratorReplaced ? 10 : 8;
      if (item.rawVoiceSec > maxContinuousSec + 0.05) {
        item.editorialWarnings.push(
          `Block narrator dài ${item.rawVoiceSec.toFixed(1)}s, vượt giới hạn ${maxContinuousSec.toFixed(1)}s.`
        );
        item.problem = `${item.problem} Block narrator liên tục quá dài, khiến video giống audiobook.`.trim();
        item.recommendation = "Tách source range thành VO bridge 3-8s, original_audio evidence, rồi VO bridge 3-6s nếu thật sự cần.";
        if (["ok", "not_applicable"].includes(item.status)) {
          item.status = "narration_block_too_long";
          item.severity = "warning";
        }
      }
      const previous = items[index - 1];
      if (previous?.hasVoice) {
        item.editorialWarnings.push(`Cảnh ${previous.sceneNumber} và ${item.sceneNumber} là hai block narrator liền nhau.`);
        item.problem = `${item.problem} Hai block voiceover_only đang đứng liền nhau mà không có bằng chứng âm thanh gốc.`.trim();
        item.recommendation = "Chèn một original_audio beat có quote, command, reaction, discovery hoặc action thật giữa hai block narrator.";
        if (["ok", "not_applicable"].includes(item.status)) {
          item.status = "adjacent_narration_blocks";
          item.severity = "warning";
        }
      }
    });
  }
  const warnings = items.filter((item) => (
    !["ok", "not_applicable"].includes(item.status)
    || (Array.isArray(item.editorialWarnings) && item.editorialWarnings.length)
  ));
  return {
    generatedAt: new Date().toISOString(),
    passed: warnings.length === 0,
    warningCount: warnings.length,
    thresholds: {
      minCoverage,
      maxCoverage,
      targetCoverage: independentNarrationPolicy ? "No minimum quota" : "85%-100% timeline",
      maxContinuousNarrationSec: independentNarrationPolicy ? 8 : null,
      maxSourceNarratorReplacementSec: independentNarrationPolicy ? 10 : null,
      adjacentNarrationAllowed: independentNarrationPolicy ? false : null
    },
    segments: items,
    warnings,
    geminiPrompt: buildDraftVoiceGeminiPrompt({
      title: safeText(project.title || project.name || ""),
      segments: items,
      warnings,
      independentNarrationPolicy
    })
  };
}

function buildSceneManifest({ media = {}, segments = [], mode = "" }) {
  const scenes = (Array.isArray(segments) ? segments : []).map((segment, index) => {
    const sourceStartSec = safeNumber(segment.sourceStartSec, safeNumber(segment.startSec, 0));
    const sourceEndSec = safeNumber(segment.sourceEndSec, safeNumber(segment.endSec, sourceStartSec + safeNumber(segment.duration, 0)));
    const timelineStartSec = safeNumber(segment.startSec, sourceStartSec);
    const timelineEndSec = safeNumber(segment.endSec, sourceEndSec);
    const durationSec = Math.max(0.2, timelineEndSec - timelineStartSec);
    const narrationText = mode === "highlight_cut" ? getHighlightVoiceText(segment) : getStorytimeVoiceText(segment);
    return {
      sceneId: safeText(segment.sceneId || segment.id || `scene_${String(index + 1).padStart(4, "0")}`),
      index,
      sourceStartSec: Number(sourceStartSec.toFixed(3)),
      sourceEndSec: Number(sourceEndSec.toFixed(3)),
      timelineStartSec: Number(timelineStartSec.toFixed(3)),
      timelineEndSec: Number(timelineEndSec.toFixed(3)),
      durationSec: Number(durationSec.toFixed(3)),
      recommendedVoiceBudgetSec: Number((durationSec * 0.92).toFixed(3)),
      targetVoiceCoverage: { min: 0.82, idealMin: 0.85, idealMax: 1.0, max: 1.08 },
      audioMode: segment.audioMode || segment.audio_mode || (narrationText ? "voiceover_only" : "original_audio"),
      hasVoiceover: Boolean(narrationText),
      narrationTextHash: textHash(narrationText),
      visualSummary: safeText(segment.sceneType || segment.caption || segment.originalText || segment.text || `Scene ${index + 1}`).slice(0, 280),
      actionNotes: safeText(segment.actionNotes || segment.action_notes || "")
    };
  });
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode,
    videoDurationSec: Number(safeNumber(media.duration, 0).toFixed(3)),
    sceneCount: scenes.length,
    scenes
  };
}

function isDurationVoiceIssue(issue = {}) {
  return /^fast_draft_voice_/i.test(issue.code || "")
    || /voice[_\s-]*(too|timing|duration)|timing|silent|sparse|too_short|too_long/i.test(`${issue.code || ""} ${issue.message || ""}`);
}

function getSegmentNarrationForQualityGate(segment = {}, mode = "") {
  if (mode === "highlight_cut") return getHighlightVoiceText(segment);
  if (mode === "satisfying_storytime") return getStorytimeVoiceText(segment);
  return safeText(segment.narrationLine || segment.dubbingLine || segment.text || segment.translatedText || "");
}

function buildSegmentQualityGate(segment = {}, index = 0, mode = "") {
  const narrationText = getSegmentNarrationForQualityGate(segment, mode);
  const hasVoice = Boolean(narrationText);
  const currentTextHash = textHash(narrationText);
  const durationReasons = [];
  let durationStatus = "ok";
  if (hasVoice) {
    const fastDraftStatus = safeText(segment.fastDraftVoiceStatus || "");
    const fastDraftRatio = safeNumber(segment.fastDraftFitRatio, 0);
    const measuredTextHash = safeText(segment.fastDraftTextHash || "");
    const ratio = fastDraftRatio;
    if (measuredTextHash && currentTextHash && measuredTextHash !== currentTextHash) {
      durationStatus = "needs_human_review";
      durationReasons.push("Text voice đã thay đổi sau lần render nháp gần nhất. Hãy render nháp nhanh lại để đo audio thật.");
    } else if (fastDraftStatus === "stale") {
      durationStatus = "needs_human_review";
      durationReasons.push(segment.fastDraftVoiceWarning || "Text voice đã thay đổi. Hãy render nháp nhanh lại để đo audio thật.");
    } else if (!fastDraftStatus && !ratio) {
      durationStatus = "needs_human_review";
      durationReasons.push("Chưa có số đo voice draft bằng ffprobe. Hãy render nháp nhanh trước khi export.");
    } else if (["too_short", "too_long"].includes(fastDraftStatus)) {
      durationStatus = "needs_human_review";
      durationReasons.push(segment.fastDraftVoiceWarning || `Voice draft đang bị ${fastDraftStatus}.`);
    } else if (ratio > 0 && (ratio < 0.82 || ratio > 1.08)) {
      durationStatus = "needs_human_review";
      durationReasons.push(`Coverage ratio ${ratio.toFixed(2)} nằm ngoài ngưỡng 0.82-1.08.`);
    }
  } else {
    durationStatus = "not_required";
  }

  const review = segment.aiSceneReview || null;
  const semanticReasons = [];
  let semanticStatus = "ok";
  if (!review) {
    semanticStatus = "needs_human_review";
    semanticReasons.push("Chưa có AI review ngữ nghĩa cho cảnh này.");
  } else {
    const issues = Array.isArray(review.issues) ? review.issues : [];
    const semanticIssues = issues.filter((issue) => !isDurationVoiceIssue(issue));
    if (review.verdict === "needs_rewrite" && semanticIssues.length) {
      semanticStatus = "needs_human_review";
      semanticReasons.push(...semanticIssues.map((issue) => safeText(issue.message || issue.code || "AI báo cảnh cần viết lại.")));
    } else if (review.verdict === "needs_rewrite" && !issues.length && !["too_short", "too_long"].includes(segment.fastDraftVoiceStatus)) {
      semanticStatus = "needs_human_review";
      semanticReasons.push(review.summary || "AI báo cảnh cần viết lại.");
    } else if (semanticIssues.some((issue) => issue.severity === "error")) {
      semanticStatus = "needs_human_review";
      semanticReasons.push(...semanticIssues.filter((issue) => issue.severity === "error").map((issue) => safeText(issue.message || issue.code)));
    }
  }

  const sceneStatus = durationStatus === "needs_human_review" || semanticStatus === "needs_human_review"
    ? "needs_human_review"
    : (["too_short", "too_long"].includes(segment.fastDraftVoiceStatus) ? "auto_fixed" : "ok");
  return {
    index,
    sceneNumber: index + 1,
    sceneStatus,
    durationGate: {
      status: durationStatus,
      hasVoice,
      coverageRatio: safeNumber(segment.fastDraftFitRatio, safeNumber(segment.aiSceneReview?.voiceTiming?.coverageRatio, 0)),
      rawVoiceSec: segment.fastDraftVoiceSec,
      timelineSec: segment.fastDraftTimelineSec,
      textHash: currentTextHash,
      measuredTextHash: segment.fastDraftTextHash || "",
      measuredAt: segment.fastDraftMeasuredAt || "",
      reasons: durationReasons
    },
    semanticGate: {
      status: semanticStatus,
      verdict: review?.verdict || "unchecked",
      reasons: semanticReasons
    },
    reasons: [...durationReasons, ...semanticReasons]
  };
}

function buildProjectQualityGate(segments = [], mode = "") {
  const scenes = segments.map((segment, index) => buildSegmentQualityGate(segment, index, mode));
  const blockedScenes = scenes.filter((scene) => scene.sceneStatus === "needs_human_review");
  return {
    generatedAt: new Date().toISOString(),
    mode,
    exportAllowed: blockedScenes.length === 0,
    blockedCount: blockedScenes.length,
    totalScenes: scenes.length,
    scenes,
    blockedScenes
  };
}

function assertExportQualityGate({ project = {}, segments = [], mode = "" }) {
  const gate = buildProjectQualityGate(segments, mode || project.mode || "");
  if (gate.exportAllowed) return gate;
  const examples = gate.blockedScenes.slice(0, 4).map((scene) => (
    `Cảnh ${scene.sceneNumber}: ${scene.reasons.join(" ")}`
  ));
  return {
    ...gate,
    warningMessage:
      `Cảnh báo export: ${gate.blockedCount}/${gate.totalScenes} cảnh chưa qua quality gate. ` +
      `${examples.join(" | ")} ` +
      "Tool vẫn tiếp tục export theo quyết định của user."
  };
}

function mergeDraftVoiceReview(segment = {}, voiceReport = null) {
  if (!voiceReport) return segment.aiSceneReview || null;
  const previousReview = segment.aiSceneReview || {};
  const voiceTiming = {
    ...(previousReview.voiceTiming || {}),
    source: "fast_draft_ffprobe",
    estimatedSpeechSec: voiceReport.rawVoiceSec,
    actualSpeechSec: voiceReport.rawVoiceSec,
    sceneDurationSec: voiceReport.timelineSec,
    fitRatio: voiceReport.coverageRatio,
    coverageRatio: voiceReport.coverageRatio,
    deadAirSec: voiceReport.deadAirSec,
    overflowSec: voiceReport.overflowSec,
    wordsPerSecond: voiceReport.estimatedWordsPerSecond,
    profileWordsPerSecond: voiceReport.profileWordsPerSecond || voiceReport.estimatedWordsPerSecond,
    voiceProfileKey: voiceReport.voiceProfileKey || "",
    voiceProfileSampleCount: voiceReport.voiceProfileSampleCount || 0,
    textHash: voiceReport.textHash || "",
    status: voiceReport.status,
    checkedAt: new Date().toISOString()
  };
  if (["ok", "not_applicable"].includes(voiceReport.status)) {
    return {
      ...previousReview,
      voiceTiming
    };
  }
  const previousIssues = Array.isArray(previousReview.issues) ? previousReview.issues : [];
  const retainedIssues = previousIssues.filter((issue) => !/^fast_draft_voice_/i.test(issue.code || ""));
  return {
    ...previousReview,
    verdict: "needs_rewrite",
    summary: voiceReport.problem,
    voiceTiming,
    issues: [
      ...retainedIssues,
      {
        code: `fast_draft_voice_${voiceReport.status}`,
        severity: voiceReport.severity,
        message: `${voiceReport.problem} ${voiceReport.recommendation}`
      }
    ],
    rewriteSuggestion: previousReview.rewriteSuggestion
  };
}

function invalidateFastDraftMeasurement(segment = {}) {
  const retainedReview = segment.aiSceneReview ? {
    ...segment.aiSceneReview,
    voiceTiming: {
      ...(segment.aiSceneReview.voiceTiming || {}),
      status: "stale",
      checkedAt: new Date().toISOString()
    },
    issues: (Array.isArray(segment.aiSceneReview.issues) ? segment.aiSceneReview.issues : [])
      .filter((issue) => !/^fast_draft_voice_/i.test(issue.code || ""))
  } : null;
  return {
    ...segment,
    fastDraftVoiceSec: 0,
    fastDraftTimelineSec: 0,
    fastDraftFitRatio: 0,
    fastDraftTextHash: "",
    fastDraftMeasuredAt: "",
    fastDraftVoiceStatus: "stale",
    fastDraftVoiceWarning: "Kịch bản đã được import lại từ Gemini. Hãy render nháp nhanh để đo voice thật.",
    aiSceneReview: retainedReview
  };
}

function shortenTextForTtsDuration(text, targetDuration, measuredDuration, attempt = 1) {
  const original = safeText(text);
  const words = original.split(/\s+/).filter(Boolean);
  if (words.length <= 4) return original;
  const target = Math.max(0.3, safeNumber(targetDuration, 0));
  const measured = Math.max(target, safeNumber(measuredDuration, target));
  const ratio = Math.max(0.35, Math.min(0.92, target / measured));
  const safety = attempt > 1 ? 0.76 : 0.86;
  const keepWords = Math.max(4, Math.floor(words.length * ratio * safety));
  if (keepWords >= words.length) {
    return original;
  }
  let shortened = words.slice(0, keepWords).join(" ");
  shortened = shortened.replace(/[,:;–-]\s*[^,;:–-]*$/, "").trim();
  if (!/[.!?…]$/.test(shortened)) {
    shortened += ".";
  }
  return shortened;
}

function getVoiceCoverageRatio(text, durationSec) {
  const safeDuration = Math.max(0.2, safeNumber(durationSec, 0));
  return Math.max(0, Math.min(2, estimateSpeechSeconds(text) / safeDuration));
}

function getHighlightVoiceText(segment = {}) {
  const requestedAudioMode = safeText(segment.requestedAudioMode || segment.audio_mode || segment.audioMode || "");
  return safeText(
    segment.voiceoverText ||
    segment.voiceover_text ||
    segment.dubbingLine ||
    segment.narration ||
    (requestedAudioMode && requestedAudioMode !== "original_audio" ? segment.text : "") ||
    ""
  );
}

async function autoStoryDraftKey(project, variant, settings) {
  const effective = resolveEffectiveVideoEditProject({ ...project, analysis: { ...project.analysis, activeVariantId: variant.id } });
  const source = await fs.stat(project.sourceVideoPath);
  const subtitles = project.subtitleSourcePath ? await fs.stat(project.subtitleSourcePath).catch(() => null) : null;
  return crypto.createHash("sha256").update(JSON.stringify({
    version: 3, source: [project.sourceVideoPath, source.size, source.mtimeMs],
    subtitles: [project.subtitleSourcePath, subtitles?.size, subtitles?.mtimeMs], title: variant.title,
    decoration: effective.videoDecoration, mask: effective.sourceSubtitleMask, mixer: effective.mixer,
    subtitleStyle: project.subtitleStyle, draftVoiceMode: project.draftVoiceMode,
    segments: variant.segments.map(s => ({ sourceStartSec: s.sourceStartSec, sourceEndSec: s.sourceEndSec, duration: s.duration,
      audio: getHighlightAudioMode(s, Boolean(getHighlightVoiceText(s)), project),
      voice: getHighlightVoiceText(s) ? getVoiceCacheInfo({ settings, project, text: getHighlightVoiceText(s), outputPath: "voice.wav", voiceRenderOptions: getSegmentVoiceRenderOptions(s) }).spec : null,
      block: s.deliveryBlockId ? [s.deliveryBlockId, s.deliveryMode, s.deliveryBlockPosition, s.blockSourceAudio,
        s.blockNarrationText ? getVoiceCacheInfo({ settings, project, text: s.blockNarrationText, outputPath: "voice.wav", voiceRenderOptions: getSegmentVoiceRenderOptions(s) }).spec : null] : null,
      previewVi: undefined, cues: undefined }))
  })).digest("hex");
}

async function canReuseAutoStoryDraft(project, variant, settings) {
  if (!variant?.artifacts?.fastDraftVideoPath) return false;
  try {
    await fs.access(variant.artifacts.fastDraftVideoPath);
    return project.analysisWorkflow !== "vertex_auto_story"
      || variant.artifacts.autoStoryDraftKey === await autoStoryDraftKey(project, variant, settings);
  } catch (_) { return false; }
}

const DELIVERY_RATE_DEFAULTS = {
  mystery_hook: 0.92,
  urgent_hook: 1.06,
  warm_story: 0.98,
  process_energy: 1.04,
  intimate_payoff: 0.92,
  natural: 1
};

function getSegmentVoiceRenderOptions(segment = {}) {
  const deliveryProfile = safeText(segment.deliveryProfile || segment.delivery_profile || "natural").toLowerCase();
  const configuredRate = safeNumber(segment.speechRateMultiplier ?? segment.speech_rate_multiplier, NaN);
  return {
    deliveryProfile,
    speechRateMultiplier: Math.max(0.85, Math.min(1.12, Number.isFinite(configuredRate)
      ? configuredRate
      : (DELIVERY_RATE_DEFAULTS[deliveryProfile] || 1))),
    pauseAfterPhrase: safeText(segment.pauseAfterPhrase || segment.pause_after_phrase || ""),
    pauseDurationMs: Math.max(0, Math.min(600, safeNumber(segment.pauseDurationMs ?? segment.pause_duration_ms, 0))),
    emphasisWords: Array.isArray(segment.emphasisWords || segment.emphasis_words)
      ? (segment.emphasisWords || segment.emphasis_words).map((value) => safeText(value)).filter(Boolean)
      : [],
    // AutoStory v3 (Phase 12): carry storytelling intent to the TTS engines.
    emotionTag: safeText(segment.emotionTag || segment.emotion_tag || segment.emotion || ""),
    prosody: (segment.prosody && typeof segment.prosody === "object") ? segment.prosody : null
  };
}

function splitTextAfterPhrase(text, phrase) {
  const source = safeText(text);
  const needle = safeText(phrase);
  if (!source || !needle) return null;
  const index = source.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return null;
  const splitAt = index + needle.length;
  return {
    before: source.slice(0, splitAt).trim(),
    after: source.slice(splitAt).trim()
  };
}

function getEdgeRateWithDelivery(baseRate, voiceRenderOptions = {}) {
  const normalizedBaseRate = safeNumber(baseRate, 0);
  const deliveryDelta = Math.round((safeNumber(voiceRenderOptions.speechRateMultiplier, 1) - 1) * 100);
  return Math.max(-50, Math.min(100, normalizedBaseRate + deliveryDelta));
}

function getVoiceCacheInfo({ settings, project, text, outputPath, voiceRenderOptions = {} }) {
  const provider = project.voiceProvider || settings.defaultVoiceProvider || "edge_neural";
  const voiceId = provider === "omnivoice"
    ? getOmniVoiceVoiceName(project, settings)
    : provider === "kokoro"
      ? project.voiceId || "af_heart"
      : project.voiceId || settings.defaultVoiceId || "";
  const language = inferFastDraftLanguage(text, project);
  const payload = {
    version: 5,
    provider,
    voiceId,
    text: safeText(text),
    language,
    elevenLabsModel: settings.elevenLabsModel || "",
    elevenLabsVoiceSettingsMode: settings.elevenLabsVoiceSettingsMode || "auto",
    elevenLabsStability: Number(settings.elevenLabsStability ?? 0.32),
    elevenLabsSimilarityBoost: Number(settings.elevenLabsSimilarityBoost ?? 0.78),
    elevenLabsStyle: Number(settings.elevenLabsStyle ?? 0.58),
    elevenLabsSpeakerBoost: settings.elevenLabsSpeakerBoost !== false,
    omniVoiceModel: settings.omniVoiceModel || "",
    omniVoiceDevice: settings.omniVoiceDevice || "",
    omniVoiceInstruct: settings.omniVoiceInstruct || "",
    omniVoiceNumStep: Number(project.omniVoiceNumStep || settings.omniVoiceNumStep || 8),
    kokoroModel: settings.kokoroModel || "",
    kokoroDevice: settings.kokoroDevice || "",
    kokoroSpeed: Number(settings.kokoroSpeed || 1),
    deliveryProfile: safeText(voiceRenderOptions.deliveryProfile || "natural"),
    speechRateMultiplier: safeNumber(voiceRenderOptions.speechRateMultiplier, 1),
    pauseAfterPhrase: safeText(voiceRenderOptions.pauseAfterPhrase || ""),
    pauseDurationMs: safeNumber(voiceRenderOptions.pauseDurationMs, 0),
    emphasisWords: Array.isArray(voiceRenderOptions.emphasisWords) ? voiceRenderOptions.emphasisWords : [],
    // v3 only: keep the cache key byte-stable for existing v2 projects (no emotionTag).
    ...(safeText(voiceRenderOptions.emotionTag || "") ? { emotionTag: safeText(voiceRenderOptions.emotionTag), prosody: voiceRenderOptions.prosody || null } : {}),
    cloneSourceVoice: Boolean(project.cloneSourceVoice),
    windowsVoiceRate: Number(project.windowsVoiceRate || settings.windowsVoiceRate || 0),
    edgeVoicePreset: settings.edgeVoicePreset || "natural",
    edgeVoiceRate: Number(project.edgeVoiceRate ?? settings.edgeVoiceRate ?? 0),
    edgeVoicePitchHz: Number(project.edgeVoicePitchHz ?? settings.edgeVoicePitchHz ?? 0),
    edgeVoiceVolume: Number(project.edgeVoiceVolume ?? settings.edgeVoiceVolume ?? 100),
    genreMode: project.genreMode || "drama",
    voiceVolumeIndependent: true
  };
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
  const extension = path.extname(outputPath) || audioExtensionForProvider(provider);
  const cacheDir = path.join(path.dirname(outputPath), ".voice-cache");
  return {
    cacheDir,
    cachePath: path.join(cacheDir, `${provider}-${hash}${extension}`),
    cacheKey: hash,
    provider,
    voiceId,
    language,
    spec: payload
  };
}

function getOmniVoiceVoiceName(project = {}, settings = {}) {
  if (project.cloneSourceVoice) {
    return safeText(project.voiceId || project.voiceDesign?.samplePath || "");
  }
  return safeText(project.voiceId || project.voiceDesign?.prompt || settings.omniVoiceInstruct || "");
}

async function assertOmniVoiceCloneReady(project = {}) {
  if (project.voiceProvider !== "omnivoice" || !project.cloneSourceVoice) {
    return;
  }
  const samplePath = safeText(project.voiceId || project.voiceDesign?.samplePath || "");
  if (!samplePath) {
    throw new Error("OmniVoice clone chưa có file giọng mẫu. Hãy chọn file mẫu trong tab Clone giọng nói rồi tạo lại dự án.");
  }
  try {
    const stat = await fs.stat(samplePath);
    if (!stat.isFile()) {
      throw new Error("not_file");
    }
  } catch (_error) {
    throw new Error(`Không tìm thấy file giọng mẫu OmniVoice clone: ${samplePath}`);
  }
}

function buildDubbingQa(segments) {
  const issues = [];
  const segmentReports = (Array.isArray(segments) ? segments : []).map((segment, index) => {
    const duration = Math.max(0.2, safeNumber(segment.endSec, 0) - safeNumber(segment.startSec, 0));
    const sourceText = safeText(segment.text || segment.originalText || "");
    const dubbingLine = safeText(segment.dubbingLine || segment.translatedText || "");
    const wordCount = countWords(dubbingLine);
    const maxWords = maxWordsForDuration(duration);
    const estimatedSpeechSec = estimateSpeechSeconds(dubbingLine);
    const fitRatio = duration > 0 ? estimatedSpeechSec / duration : 0;
    const segmentIssues = [];
    if (!sourceText) {
      segmentIssues.push({ code: "missing_source", severity: "warning", message: "Không có transcript nguồn cho phân đoạn này." });
    }
    if (!dubbingLine) {
      segmentIssues.push({ code: "missing_dubbing_line", severity: "error", message: "Không có câu dubbing để dịch." });
    }
    if (wordCount > maxWords + 2 || fitRatio > 1.18) {
      segmentIssues.push({
        code: "duration_overflow",
        severity: fitRatio > 1.35 ? "error" : "warning",
        message: `Câu dịch có thể quá dài so với ${duration.toFixed(2)} giây (${wordCount}/${maxWords} từ, tỷ lệ ${fitRatio.toFixed(2)}).`
      });
    }
    if (sourceText && dubbingLine && sourceText === dubbingLine) {
      segmentIssues.push({ code: "untranslated", severity: "warning", message: "Câu dịch giống hệt câu nguồn." });
    }
    issues.push(...segmentIssues.map((issue) => ({ ...issue, segmentId: segment.id, index })));
    return {
      id: segment.id,
      index,
      speaker: segment.speaker || "",
      duration,
      wordCount,
      maxWords,
      estimatedSpeechSec: Number(estimatedSpeechSec.toFixed(3)),
      fitRatio: Number(fitRatio.toFixed(3)),
      issues: segmentIssues
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    passed: !issues.some((issue) => issue.severity === "error"),
    issueCount: issues.length,
    issues,
    segments: segmentReports
  };
}

function formatSrtTime(totalSeconds) {
  const safe = Math.max(0, safeNumber(totalSeconds, 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = Math.floor(safe % 60);
  const milliseconds = Math.min(999, Math.round((safe - Math.floor(safe)) * 1000));
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}

function formatSeconds(totalSeconds) {
  return Math.max(0, safeNumber(totalSeconds, 0)).toFixed(3);
}

function parseSrtTime(value) {
  const match = String(value || "").trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!match) {
    return 0;
  }
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4]}`);
}

function parseSrt(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .map((block, index) => {
      const lines = block.split("\n").filter(Boolean);
      const timingLine = lines.find((line) => line.includes("-->"));
      if (!timingLine) {
        return null;
      }
      const [startRaw, endRaw] = timingLine.split("-->").map((part) => part.trim());
      const textLines = lines.slice(lines.indexOf(timingLine) + 1);
      const cleanText = textLines.join(" ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (!cleanText) {
        return null;
      }
      return {
        id: `seg_${String(index + 1).padStart(4, "0")}`,
        index,
        startSec: parseSrtTime(startRaw),
        endSec: parseSrtTime(endRaw),
        text: cleanText,
        translatedText: cleanText,
        speaker: `SPEAKER_${String(index % 2).padStart(2, "0")}`,
        gender: index % 2 === 0 ? "female" : "male"
      };
    })
    .filter(Boolean);
}

function buildSceneFallbackSegments(scenes) {
  return (Array.isArray(scenes) ? scenes : []).map((scene, index) => ({
    id: `seg_${String(index + 1).padStart(4, "0")}`,
    index,
    startSec: scene.startSec,
    endSec: scene.endSec,
    text: `Scene ${index + 1}`,
    translatedText: `Scene ${index + 1}`,
    speaker: `SPEAKER_${String(index % 2).padStart(2, "0")}`,
    gender: index % 2 === 0 ? "female" : "male",
    sceneId: scene.sceneId
  }));
}

function buildSceneCards(scenes, segments) {
  return (Array.isArray(scenes) ? scenes : []).map((scene, index) => {
    const linked = segments.filter((segment) => (
      segment.startSec < scene.endSec && segment.endSec > scene.startSec
    ));
    return {
      id: scene.sceneId || `scene_${String(index + 1).padStart(4, "0")}`,
      index,
      startSec: scene.startSec,
      endSec: scene.endSec,
      duration: scene.duration,
      segmentCount: linked.length,
      text: linked.map((segment) => segment.text).join(" ").slice(0, 280)
    };
  });
}

function buildSrt(segments, field = "translatedText") {
  return segments.map((segment, index) => {
    const text = segment[field] || segment.text || "";
    return [
      String(index + 1),
      `${formatSrtTime(segment.startSec)} --> ${formatSrtTime(segment.endSec)}`,
      text
    ].join("\n");
  }).join("\n\n");
}

// Consecutive members of one narrated block, and exactly one canonical passage
// (on the first member). Anything else would make the renderer guess.
function narratedBlockRuns(segments = []) {
  const runs = [];
  segments.forEach((segment, index) => {
    if (segment.deliveryMode !== "narrated_story" || !segment.deliveryBlockId) return;
    const last = runs[runs.length - 1];
    if (last && last.blockId === segment.deliveryBlockId && last.end === index - 1) { last.end = index; return; }
    runs.push({ blockId: segment.deliveryBlockId, start: index, end: index });
  });
  return runs;
}

function validateNarratedDeliveryBlocks(segments = []) {
  const runs = narratedBlockRuns(segments);
  const seen = new Set();
  for (const run of runs) {
    if (seen.has(run.blockId)) throw new Error(`Narrated block ${run.blockId} is split into non-consecutive segments.`);
    seen.add(run.blockId);
    const members = segments.slice(run.start, run.end + 1);
    const withText = members.filter((segment) => segment.blockNarrationText);
    if (withText.length !== 1 || !members[0].blockNarrationText) {
      throw new Error(`Narrated block ${run.blockId} must carry exactly one block_narration_text on its first segment (found ${withText.length}).`);
    }
    if (members.some((segment) => segment.voiceoverText)) throw new Error(`Narrated block ${run.blockId} members must not carry per-segment voiceover_text.`);
    if (new Set(members.map((segment) => segment.blockSourceAudio)).size !== 1) throw new Error(`Narrated block ${run.blockId} must use one source audio treatment.`);
  }
  return runs;
}

function normalizeHighlightCutScript(rawScript, videoDuration = 0) {
  const parsed = typeof rawScript === "string" ? JSON.parse(rawScript) : rawScript;
  const sourceSegments = Array.isArray(parsed?.segments) ? parsed.segments : [];
  if (!sourceSegments.length) {
    throw new Error("File JSON không có mảng segments.");
  }
  let cursor = 0;
  const timelineRepairWarnings = [];
  const allowedModes = new Set(["original_audio", "mixed_ducking", "voiceover_only", "voiceover_with_ambient"]);
  const segments = sourceSegments.map((segment, index) => {
    const hasExplicitSourceTimeline = [
      segment.sourceStartSec,
      segment.source_start_sec,
      segment.inputStartSec,
      segment.videoStartSec,
      segment.sourceEndSec,
      segment.source_end_sec,
      segment.inputEndSec,
      segment.videoEndSec
    ].some((value) => value !== undefined && value !== null && value !== "");
    const sourceStartSec = safeNumber(
      segment.sourceStartSec ?? segment.source_start_sec ?? segment.inputStartSec ?? segment.videoStartSec ?? segment.startSec ?? segment.start ?? segment.from,
      -1
    );
    let sourceEndSec = safeNumber(
      segment.sourceEndSec ?? segment.source_end_sec ?? segment.inputEndSec ?? segment.videoEndSec ?? segment.endSec ?? segment.end ?? segment.to,
      -1
    );
    const originalSourceEndSec = sourceEndSec;
    const requestedAudioMode = safeText(segment.audio_mode || segment.audioMode || "").toLowerCase();
    const sourceNarratorDetected = segment.source_narrator_detected === true || segment.sourceNarratorDetected === true;
    // AutoStory V5 delivery blocks: a narrated_story block owns ONE continuous
    // narration passage (on its first member only); members carry no voiceover_text.
    const deliveryBlockId = safeText(segment.delivery_block_id || segment.deliveryBlockId || "");
    const deliveryMode = deliveryBlockId ? safeText(segment.delivery_mode || segment.deliveryMode || "") : "";
    const inNarratedBlock = deliveryMode === "narrated_story";
    const blockNarrationText = inNarratedBlock
      ? safeText(segment.block_narration_text || segment.blockNarrationText || "").replace(/\s+/g, " ").trim()
      : "";
    const blockSourceAudio = inNarratedBlock
      ? (safeText(segment.block_source_audio || segment.blockSourceAudio || "") === "voiceover_only" || sourceNarratorDetected ? "voiceover_only" : "voiceover_with_ambient")
      : "";
    const rawVoiceoverText = String(
      segment.voiceoverText || segment.voiceover_text || segment.dubbingLine || segment.narration
      || (requestedAudioMode && requestedAudioMode !== "original_audio" ? segment.text : "") || ""
    ).replace(/\s+/g, " ").trim();
    const voiceoverText = getHighlightVoiceText({ ...segment, requestedAudioMode });
    if (hasGeminiCitationMarkers(rawVoiceoverText)) {
      timelineRepairWarnings.push(`Highlight đoạn ${index + 1}: tool đã xóa citation/footnote của Gemini khỏi voiceover_text trước khi tạo TTS.`);
    }
    const caption = safeText(segment.caption || segment.subtitle || "");
    const previewSubtitleVi = safeText(
      segment.preview_vi ||
      segment.previewVi ||
      segment.previewSubtitleVi ||
      segment.subtitleVi ||
      segment.captionVi ||
      segment.viCaption ||
      ""
    );
    if (sourceStartSec < 0 || sourceEndSec <= sourceStartSec) {
      throw new Error(`Highlight segment ${index + 1} thiếu timestamp nguồn hợp lệ. Dùng sourceStartSec/sourceEndSec hoặc startSec/endSec, với 0 <= start < end.`);
    }
    if (sourceNarratorDetected && !voiceoverText && !inNarratedBlock) {
      throw new Error(
        `Highlight segment ${index + 1} đánh dấu source_narrator_detected=true nhưng thiếu voiceover_text. `
        + "Hãy dùng lời narrator đã xác minh để tool thay bằng giọng được chọn."
      );
    }
    const sourceOverflowSec = videoDuration ? sourceEndSec - videoDuration : 0;
    const allowClampOverflowSec = Math.max(2, videoDuration * 0.02);
    if (videoDuration && sourceOverflowSec > 0 && sourceOverflowSec <= allowClampOverflowSec && videoDuration > sourceStartSec + 0.3) {
      sourceEndSec = videoDuration;
    } else if (videoDuration && sourceEndSec > videoDuration + 0.5) {
      throw new Error(`Highlight segment ${index + 1} vượt quá thời lượng video (${sourceEndSec.toFixed(2)}s > ${videoDuration.toFixed(2)}s).`);
    }
    let normalizedAudioMode = inNarratedBlock
      ? blockSourceAudio
      : voiceoverText
      ? (["voiceover_with_ambient", "mixed_ducking"].includes(requestedAudioMode) ? "voiceover_with_ambient" : "voiceover_only")
      : "original_audio";
    if (sourceNarratorDetected && normalizedAudioMode === "voiceover_with_ambient") {
      normalizedAudioMode = "voiceover_only";
      timelineRepairWarnings.push(
        `Highlight đoạn ${index + 1}: nguồn có narrator ngoài nên tool đã tắt ambient để tránh lẫn hai giọng.`
      );
    }
    const actionNotes = safeText(segment.action_notes || segment.actionNotes || "");
    const sourceAmbientVolume = Math.max(0.1, Math.min(0.2, safeNumber(
      segment.sourceAmbientVolume ?? segment.source_ambient_volume,
      0.15
    )));
    const sourceVolume = normalizedAudioMode === "voiceover_with_ambient"
      ? sourceAmbientVolume
      : (voiceoverText || inNarratedBlock) ? 0 : 1;
    const sourceDuration = sourceEndSec - sourceStartSec;
    const playbackSpeedRaw = safeNumber(segment.playbackSpeed ?? segment.playback_speed, NaN);
    const outputStartValue = segment.startSec ?? segment.outputStartSec;
    const outputEndValue = segment.endSec ?? segment.outputEndSec;
    const requestedStartSec = hasExplicitSourceTimeline ? safeNumber(outputStartValue, NaN) : NaN;
    const requestedEndSec = hasExplicitSourceTimeline ? safeNumber(outputEndValue, NaN) : NaN;
    const hasRequestedOutputRange = Number.isFinite(requestedStartSec)
      && Number.isFinite(requestedEndSec)
      && requestedEndSec > requestedStartSec;
    const hasRequestedPlaybackSpeed = Number.isFinite(playbackSpeedRaw) && playbackSpeedRaw > 0;
    const requestedDuration = hasRequestedOutputRange ? requestedEndSec - requestedStartSec : NaN;

    // Source range + explicit playback speed are authoritative. Output timestamps
    // are derived data and are always reflowed so stale Gemini math cannot break import.
    const playbackSpeed = hasRequestedPlaybackSpeed
      ? playbackSpeedRaw
      : hasRequestedOutputRange
        ? sourceDuration / requestedDuration
        : 1;
    const duration = sourceDuration / Math.max(0.05, playbackSpeed);
    const startSec = cursor;
    const endSec = startSec + duration;
    const computedPlaybackSpeed = sourceDuration / Math.max(0.001, duration);
    if (hasRequestedOutputRange && (
      Math.abs(requestedStartSec - startSec) > 0.005
      || Math.abs(requestedEndSec - endSec) > 0.005
    )) {
      timelineRepairWarnings.push(
        `Highlight đoạn ${index + 1}: tool đã tự tính lại timeline output `
        + `${requestedStartSec.toFixed(3)}-${requestedEndSec.toFixed(3)}s thành `
        + `${startSec.toFixed(3)}-${endSec.toFixed(3)}s từ timestamp nguồn và playbackSpeed.`
      );
    }
    cursor = endSec;
    const segmentId = safeText(segment.id || segment.segmentId || segment.segment_id)
      || `highlight_${String(index + 1).padStart(4, "0")}`;
    const requestedVisualLayout = safeText(segment.visual_layout || segment.visualLayout || "fullscreen");
    const visualLayout = ["fullscreen", "split_screen_911", "blur_censored"].includes(requestedVisualLayout)
      ? requestedVisualLayout
      : "fullscreen";
    const captionEmphasisWords = Array.isArray(segment.caption_emphasis_words || segment.captionEmphasisWords)
      ? (segment.caption_emphasis_words || segment.captionEmphasisWords)
        .map((value) => safeText(value))
        .filter(Boolean)
        .slice(0, 2)
      : [];
    return {
      id: segmentId,
      segmentId,
      evidenceId: safeText(segment.evidenceId || segment.evidence_id || ""),
      evidenceIds: Array.isArray(segment.evidenceIds)
        ? segment.evidenceIds.map((value) => safeText(value)).filter(Boolean)
        : [safeText(segment.evidenceId || segment.evidence_id || "")].filter(Boolean),
      sceneId: safeText(segment.sceneId || segment.scene_id || segment.id || `highlight_${String(index + 1).padStart(4, "0")}`),
      sceneIds: Array.isArray(segment.sceneIds)
        ? segment.sceneIds.map((value) => safeText(value)).filter(Boolean)
        : [safeText(segment.sceneId || segment.scene_id || segment.id || `highlight_${String(index + 1).padStart(4, "0")}`)].filter(Boolean),
      sourceRunId: safeText(segment.sourceRunId || segment.source_run_id || ""),
      macroBlockId: safeText(segment.macroBlockId || segment.macro_block_id || ""),
      storyFunction: safeText(segment.storyFunction || segment.story_function || ""),
      speakerRole: safeText(segment.speaker_role || segment.speakerRole || ""),
      speechType: safeText(segment.speech_type || segment.speechType || ""),
      narrativePurpose: safeText(segment.narrativePurpose || segment.narrative_purpose || ""),
      narrationBeatId: safeText(segment.narrationBeatId || segment.narration_beat_id || ""),
      microCutPurpose: safeText(segment.microCutPurpose || segment.micro_cut_purpose || "none"),
      bridgePurpose: safeText(segment.bridgePurpose || segment.bridge_purpose || ""),
      timelinePhase: safeText(segment.timelinePhase || segment.timeline_phase || ""),
      jargonExplanation: safeText(segment.jargonExplanation || segment.jargon_explanation || ""),
      visualClaimType: safeText(segment.visualClaimType || segment.visual_claim_type || "neutral"),
      deliveryProfile: safeText(segment.deliveryProfile || segment.delivery_profile || "natural"),
      speechRateMultiplier: Math.max(0.5, Math.min(1.5, safeNumber(segment.speechRateMultiplier ?? segment.speech_rate_multiplier, 1))),
      pauseAfterPhrase: safeText(segment.pauseAfterPhrase || segment.pause_after_phrase || ""),
      pauseDurationMs: Math.max(0, Math.min(1000, safeNumber(segment.pauseDurationMs ?? segment.pause_duration_ms, 0))),
      emphasisWords: Array.isArray(segment.emphasisWords || segment.emphasis_words)
        ? (segment.emphasisWords || segment.emphasis_words).map((value) => safeText(value)).filter(Boolean)
        : [],
      transitionReason: safeText(segment.transitionReason || segment.transition_reason || ""),
      transitionExplainedBy: safeText(segment.transitionExplainedBy || segment.transition_explained_by || "none"),
      actionCandidateId: safeText(segment.actionCandidateId || segment.action_candidate_id || ""),
      actionSequenceId: safeText(segment.actionSequenceId || segment.action_sequence_id || ""),
      actionOverride: segment.actionOverride === true || segment.action_override === true,
      sourceNarratorDetected,
      completeNarrativeBeat: segment.completeNarrativeBeat === true || segment.complete_narrative_beat === true,
      completeNarrativeBeatType: safeText(segment.completeNarrativeBeatType || segment.complete_narrative_beat_type || ""),
      sustainedBeatId: safeText(segment.sustainedBeatId || segment.sustained_beat_id || ""),
      sustainedBeatOverride: segment.sustainedBeatOverride === true || segment.sustained_beat_override === true,
      beatId: safeText(segment.beat_id || segment.beatId || ""),
      deliveryBlockId,
      deliveryMode,
      deliveryBlockOrder: deliveryBlockId ? safeNumber(segment.delivery_block_order ?? segment.deliveryBlockOrder, 0) : null,
      deliveryBlockPosition: deliveryBlockId ? safeNumber(segment.delivery_block_position ?? segment.deliveryBlockPosition, 0) : null,
      deliveryBlockSize: deliveryBlockId ? safeNumber(segment.delivery_block_size ?? segment.deliveryBlockSize, 1) : null,
      blockSourceAudio,
      blockNarrationText,
      blockNarrationPreviewVi: blockNarrationText ? safeText(segment.block_narration_preview_vi || segment.blockNarrationPreviewVi || "") : "",
      blockNarratorFunction: blockNarrationText ? safeText(segment.block_narrator_function || segment.blockNarratorFunction || "") : "",
      blockNarrationIntent: blockNarrationText ? safeText(segment.block_narration_intent || segment.blockNarrationIntent || "") : "",
      blockStoryFunction: blockNarrationText ? safeText(segment.block_story_function || segment.blockStoryFunction || "") : "",
      blockEmotionTag: blockNarrationText ? safeText(segment.block_emotion_tag || segment.blockEmotionTag || "") : "",
      blockHandoffTargetBeatId: blockNarrationText ? safeText(segment.block_handoff_target_beat_id || segment.blockHandoffTargetBeatId || "") : "",
      blockNarrationHash: blockNarrationText ? safeText(segment.block_narration_hash || segment.blockNarrationHash || "") : "",
      index,
      startSec: Number(startSec.toFixed(3)),
      endSec: Number(endSec.toFixed(3)),
      outputStartSec: Number(startSec.toFixed(3)),
      outputEndSec: Number(endSec.toFixed(3)),
      requestedOutputStartSec: Number.isFinite(requestedStartSec) ? Number(requestedStartSec.toFixed(3)) : null,
      requestedOutputEndSec: Number.isFinite(requestedEndSec) ? Number(requestedEndSec.toFixed(3)) : null,
      duration: Number(duration.toFixed(3)),
      sourceStartSec: Number(sourceStartSec.toFixed(3)),
      sourceEndSec: Number(sourceEndSec.toFixed(3)),
      originalSourceEndSec: Number(originalSourceEndSec.toFixed(3)),
      sourceDuration: Number(sourceDuration.toFixed(3)),
      playbackSpeed: Number(computedPlaybackSpeed.toFixed(4)),
      requestedPlaybackSpeed: Number.isFinite(playbackSpeedRaw) && playbackSpeedRaw > 0 ? Number(playbackSpeedRaw.toFixed(4)) : null,
      speedMode: safeText(segment.speedMode || segment.speed_mode || (Math.abs(computedPlaybackSpeed - 1) > 0.02 ? "retime" : "normal")),
      sceneType: safeText(segment.scene_type || segment.sceneType || `Highlight ${index + 1}`),
      audioMode: normalizedAudioMode,
      requestedAudioMode: allowedModes.has(requestedAudioMode) ? requestedAudioMode : "",
      voiceoverText,
      sourceVolume,
      sourceAmbientVolume,
      text: voiceoverText || previewSubtitleVi || caption || segment.scene_type || `Highlight ${index + 1}`,
      originalText: actionNotes,
      translatedText: caption,
      dubbingLine: voiceoverText,
      caption,
      previewSubtitleVi,
      previewVi: previewSubtitleVi,
      visualLayout,
      captionEmphasisWords,
      actionNotes,
      actorIds: Array.isArray(segment.actor_ids || segment.actorIds)
        ? [...(segment.actor_ids || segment.actorIds)].map((item) => safeText(item)).filter(Boolean)
        : [],
      primaryActorId: safeText(segment.primary_actor_id || segment.primaryActorId || ""),
      speakerActorId: safeText(segment.speaker_actor_id || segment.speakerActorId || ""),
      originalAudioValueScore: safeNumber(segment.original_audio_value_score ?? segment.originalAudioValueScore, 0),
      originalAudioValueReason: safeText(segment.original_audio_value_reason || segment.originalAudioValueReason || ""),
      originalAudioProtected: segment.original_audio_protected === true || segment.originalAudioProtected === true,
      replaceSourceNarrator: sourceNarratorDetected || Boolean(segment.replaceSourceNarrator),
      forceSourceMute: sourceNarratorDetected || Boolean(segment.forceSourceMute),
      sourceNarratorReplacementText: sourceNarratorDetected
        ? (safeText(segment.sourceNarratorReplacementText) || voiceoverText)
        : safeText(segment.sourceNarratorReplacementText || ""),
      speaker: "NARRATOR",
      maxWords: maxWordsForDuration(duration)
    };
  });
  validateNarratedDeliveryBlocks(segments);
  const totalDuration = Number((segments.at(-1)?.endSec || 0).toFixed(3));
  const requestedTotal = safeNumber(parsed.total_target_sec ?? parsed.totalTargetSec, totalDuration);
  const warnings = [...timelineRepairWarnings];
  if (Math.abs(totalDuration - requestedTotal) > 1) {
    warnings.push(`Tổng duration thực tế ${totalDuration.toFixed(1)}s khác total_target_sec ${requestedTotal.toFixed(1)}s.`);
  }
  const legacyMixedSegments = segments
    .filter((segment) => segment.requestedAudioMode === "mixed_ducking")
    .map((segment) => segment.index + 1);
  if (legacyMixedSegments.length) {
    warnings.push(
      `Highlight đoạn ${legacyMixedSegments.join(", ")} dùng mixed_ducking cũ. Tool giữ tương thích bằng voiceover_only; hãy dùng voiceover_with_ambient khi nguồn chỉ có ambience sạch.`
    );
  }
  const clampedSegments = segments
    .filter((segment) => videoDuration && Number(segment.originalSourceEndSec || 0) > videoDuration && Math.abs(Number(segment.sourceEndSec || 0) - videoDuration) < 0.01)
    .map((segment) => `đoạn ${segment.index + 1} ${Number(segment.originalSourceEndSec || 0).toFixed(2)}s > ${videoDuration.toFixed(2)}s`);
  if (clampedSegments.length) {
    warnings.push(`Một số Highlight vượt nhẹ cuối video nên đã tự co sourceEndSec về cuối video: ${clampedSegments.join(", ")}.`);
  }
  const vietnameseVoiceSegments = segments
    .filter((segment) => segment.voiceoverText && hasVietnameseDiacritics(segment.voiceoverText))
    .map((segment) => segment.index + 1);
  const englishCaptionSegments = segments
    .filter((segment) => hasEnglishWords(segment.caption || segment.text || ""))
    .map((segment) => segment.index + 1);
  if (vietnameseVoiceSegments.length && englishCaptionSegments.length) {
    warnings.push(
      `Highlight JSON đang trộn ngôn ngữ: voiceover_text có tiếng Việt ở đoạn ${vietnameseVoiceSegments.join(", ")}, trong khi caption/đoạn khác có tiếng Anh. Highlight Cut không tự dịch; hãy yêu cầu Gemini xuất voiceover_text và caption cùng ngôn ngữ với video gốc.`
    );
  }
  if (vietnameseVoiceSegments.length && /en|english/i.test(safeText(parsed.language || parsed.sourceLanguage || parsed.videoLanguage || ""))) {
    warnings.push(
      `JSON khai báo video/ngôn ngữ là English nhưng voiceover_text có tiếng Việt ở đoạn ${vietnameseVoiceSegments.join(", ")}.`
    );
  }
  const originalAudioSegments = segments
    .filter((segment) => segment.audioMode === "original_audio")
    .map((segment) => segment.index + 1);
  if (originalAudioSegments.length) {
    warnings.push(
      `Highlight đoạn ${originalAudioSegments.join(", ")} dùng original_audio nên tool không tạo giọng thuyết minh; nếu nguồn ở các đoạn này im/nhỏ tiếng thì output cũng sẽ im/nhỏ tiếng.`
    );
  }
  const sparseVoiceSegments = segments
    .filter((segment) => segment.audioMode !== "original_audio" && segment.deliveryMode !== "narrated_story")
    .map((segment) => ({
      index: segment.index + 1,
      audioMode: segment.audioMode,
      duration: segment.duration,
      estimatedSpeech: estimateSpeechSeconds(segment.voiceoverText),
      coverage: getVoiceCoverageRatio(segment.voiceoverText, segment.duration)
    }))
    .filter((item) => item.coverage < 0.55);
  if (sparseVoiceSegments.length) {
    warnings.push(
      `Một số đoạn có voiceover_text quá ngắn so với khung: ${sparseVoiceSegments.map((item) => `đoạn ${item.index} ~${Math.round(item.coverage * 100)}%`).join(", ")}. Với Highlight Cut, đoạn có voice sẽ tắt âm gốc hoàn toàn, nên phần thiếu voice sẽ im.`
    );
  }
  return {
    title: parsed.title || "Highlight Cut",
    language: parsed.language || "auto",
    sourceLanguage: parsed.sourceLanguage || parsed.source_language || parsed.language || "auto",
    style: parsed.style || "highlight_cut",
    toneProfile: safeText(parsed.toneProfile || parsed.tone_profile || ""),
    toneIntensity: safeNumber(parsed.toneIntensity ?? parsed.tone_intensity, 0),
    workflow: safeText(parsed.workflow || ""),
    diyNarrationQuality: parsed._diyNarrationQuality || parsed.diyNarrationQuality || null,
    promptProfile: safeText(parsed.prompt_profile || parsed.promptProfile || ""),
    sourceNarratorPolicy: safeText(parsed.source_narrator_policy || parsed.sourceNarratorPolicy || ""),
    timelinePolicy: safeText(parsed.timeline_policy || parsed.timelinePolicy || ""),
    independentPromptOptions: parsed.independent_prompt_options || parsed.independentPromptOptions || null,
    storyContract: parsed.storyContract || parsed.story_contract || null,
    storyCompiler: parsed.storyCompiler || parsed.story_compiler || null,
    narrativeContract: parsed.narrative_contract
      || parsed.narrativeContract
      || parsed.story_blueprint?.narrativeContract
      || parsed.storyBlueprint?.narrativeContract
      || null,
    hookSelectionAudit: parsed.hook_selection_audit || parsed.hookSelectionAudit || null,
    hookColdViewerTest: parsed.hook_cold_viewer_test || parsed.hookColdViewerTest || null,
    hookTransitionTest: parsed.hook_transition_test || parsed.hookTransitionTest || null,
    narrationArc: parsed.narration_arc || parsed.narrationArc || null,
    actorIdentityMap: Array.isArray(parsed.actor_identity_map || parsed.actorIdentityMap)
      ? (parsed.actor_identity_map || parsed.actorIdentityMap).map((item) => ({ ...item }))
      : [],
    seriesMode: safeText(parsed.series_mode || parsed.seriesMode || ""),
    seriesId: safeText(parsed.series_id || parsed.seriesId || ""),
    partNumber: safeNumber(parsed.part_number ?? parsed.partNumber, 0),
    partBadge: safeText(parsed.part_badge || parsed.partBadge || ""),
    cameraLabel: safeText(parsed.camera_label || parsed.cameraLabel || ""),
    titleStyle: safeText(parsed.title_style || parsed.titleStyle || ""),
    subtitleStyle: safeText(parsed.subtitle_style || parsed.subtitleStyle || ""),
    sharedTopBannerText: safeText(parsed.shared_top_banner_text || parsed.sharedTopBannerText || ""),
    topHeader: safeText(parsed.top_banner_text || parsed.top_header || parsed.topHeader || ""),
    onScreenElements: Array.isArray(parsed.on_screen_elements || parsed.onScreenElements)
      ? (parsed.on_screen_elements || parsed.onScreenElements)
      : [],
    sharedHookEnabled: parsed.shared_hook_enabled !== false,
    interleavedAudioEnabled: parsed.interleaved_audio_enabled !== false,
    cinematicNarratorEnabled: parsed.cinematic_narrator_enabled !== false,
    cliffhangerEnabled: parsed.cliffhanger_enabled !== false,
    targetDurationMinSec: safeNumber(parsed.target_duration_min_sec ?? parsed.targetDurationMinSec, 0),
    targetDurationMaxSec: safeNumber(parsed.target_duration_max_sec ?? parsed.targetDurationMaxSec, 0),
    seriesPacing: safeText(parsed.series_pacing || parsed.seriesPacing || ""),
    totalDuration,
    requestedTotal,
    segments,
    warnings
  };
}

function makeHighlightVariantId(index) {
  return `variant_${String(index + 1).padStart(2, "0")}`;
}

function makeHighlightVariantLabel(filePath, script, index) {
  const fromTitle = safeText(script?.title || "");
  const fromFile = safeText(filePath ? path.parse(filePath).name : "");
  return fromTitle || fromFile || `Variant ${index + 1}`;
}

function buildHighlightScenes(segments = []) {
  return segments.map((segment) => ({
    sceneId: segment.sceneId || segment.id,
    startSec: segment.startSec,
    endSec: segment.endSec,
    duration: segment.duration,
    sourceStartSec: segment.sourceStartSec,
    sourceEndSec: segment.sourceEndSec,
    sourceDuration: segment.sourceDuration,
    playbackSpeed: segment.playbackSpeed,
    transcript: segment.previewSubtitleVi || segment.caption || segment.voiceoverText || segment.sceneType
  }));
}

function getActiveHighlightVariant(project = {}) {
  const analysis = project.analysis || {};
  const variants = Array.isArray(analysis.highlightVariants) ? analysis.highlightVariants : [];
  const activeVariantId = analysis.activeVariantId || variants[0]?.id || "";
  const activeVariant = variants.find((variant) => variant.id === activeVariantId) || variants[0] || null;
  if (activeVariant) {
    return activeVariant;
  }
  return {
    id: "variant_01",
    index: 0,
    label: "Variant 1",
    warnings: analysis.warnings || [],
    segments: Array.isArray(analysis.segments) ? analysis.segments : [],
    artifacts: {}
  };
}

function extractSourceNarratorVoiceText(evidence = {}, rangeStartSec = -1, rangeEndSec = -1) {
  const dialogueEvidence = Array.isArray(evidence.dialogueEvidence) ? evidence.dialogueEvidence : [];
  const chunks = [];
  dialogueEvidence.forEach((item) => {
    const text = safeText(item?.text || item);
    if (!text) return;
    const itemStartSec = safeNumber(item?.startSec, NaN);
    const itemEndSec = safeNumber(item?.endSec, NaN);
    const hasTimedRange = Number.isFinite(itemStartSec) && Number.isFinite(itemEndSec) && itemEndSec > itemStartSec;
    if (hasTimedRange
      && Number.isFinite(rangeStartSec)
      && Number.isFinite(rangeEndSec)
      && (itemEndSec <= rangeStartSec || itemStartSec >= rangeEndSec)) {
      return;
    }

    const pattern = /\[(?:source\s+)?narrator\]\s*([\s\S]*?)(?=(?:\s*-\s*)?\[[^\]]+\]|$)/gi;
    let match;
    let foundTaggedNarrator = false;
    while ((match = pattern.exec(text))) {
      foundTaggedNarrator = true;
      const chunk = safeText(match[1]).replace(/^[\s-]+|[\s-]+$/g, "").trim();
      if (chunk) chunks.push(chunk);
    }
    if (!foundTaggedNarrator && evidence.sourceAudioType === "source_narration") {
      chunks.push(text.replace(/\[(?:source\s+)?narrator\]/gi, "").trim());
    }
  });
  const extracted = [...new Set(chunks.filter(Boolean))].join(" ").replace(/\s+/g, " ").trim();
  return extracted || safeText(evidence.sourceNarratorText) || safeText(evidence.storyMeaning);
}

function resolveReviewedHighlightVariant(project = {}, reviewedScript = {}, isDraftReview = false) {
  const activeVariant = getActiveHighlightVariant(project);
  const variants = Array.isArray(project.analysis?.highlightVariants)
    ? project.analysis.highlightVariants
    : [];
  const reviewedScriptId = safeNumber(reviewedScript.scriptId ?? reviewedScript.script_id, 0);
  if (!reviewedScriptId) return activeVariant;
  const matchedVariant = variants.find((variant) => safeNumber(variant.scriptId, 0) === reviewedScriptId);
  if (!matchedVariant) {
    throw new Error(
      `${isDraftReview ? "File review" : "JSON thay thế"} dành cho Script ${reviewedScriptId}, `
      + "nhưng project hiện tại không có variant tương ứng. Hãy mở đúng project hoặc chọn đúng JSON."
    );
  }
  return matchedVariant;
}

function getInspectedDraftRevision(inputAccessAudit = {}) {
  const revisions = (Array.isArray(inputAccessAudit?.inspectedInputs) ? inputAccessAudit.inspectedInputs : [])
    .filter((item) => item?.opened === true && item?.parsed === true)
    .map((item) => safeText(item?.name).match(/(?:^|[\\/])draft-v(\d+)\.mp4$/i))
    .filter(Boolean)
    .map((match) => safeNumber(match[1], 0))
    .filter((revision) => revision > 0);
  return revisions.length === 1 ? revisions[0] : 0;
}

function getPackagedReviewRevision(variant = {}) {
  const explicit = safeNumber(variant.artifacts?.draftReviewRevision, 0);
  if (explicit) return explicit;
  const packagePath = safeText(variant.artifacts?.draftReviewPackagePath);
  const match = packagePath.match(/-v(\d+)-\d{8,}(?:[\\/]|$)/i);
  return match ? safeNumber(match[1], 0) : 0;
}

function resolveDraftReviewBinding({ projectId, variant, artifact, jsonPath, artifactHash }) {
  const currentRevision = Math.max(1, safeNumber(variant?.revisionNumber, 1));
  const declaredRevision = safeNumber(artifact?.reviewedRevision, 0);
  const target = artifact?.reviewTarget || artifact?.review_target || null;
  const expectedBindingId = safeText(variant?.artifacts?.draftReviewBindingId);
  const packagedRevision = getPackagedReviewRevision(variant);
  let reviewedRevision = declaredRevision;
  let warning = "";

  if (target && safeText(target.reviewBindingId || target.review_binding_id)) {
    const receivedBindingId = safeText(target.reviewBindingId || target.review_binding_id);
    if (!expectedBindingId || receivedBindingId !== expectedBindingId) {
      throw new Error("File Gemini review không thuộc gói review mới nhất của variant này. Hãy dùng JSON trả về từ đúng thư mục review hiện tại.");
    }
    const targetProjectId = safeText(target.projectId || target.project_id);
    const targetVariantId = safeText(target.variantId || target.variant_id);
    const targetScriptId = safeNumber(target.scriptId ?? target.script_id, 0);
    const targetRevision = safeNumber(target.reviewedRevision ?? target.reviewed_revision, 0);
    if ((targetProjectId && targetProjectId !== safeText(projectId))
      || (targetVariantId && targetVariantId !== safeText(variant?.id))
      || (targetScriptId && targetScriptId !== safeNumber(variant?.scriptId, 0))
      || !targetRevision
      || (packagedRevision && targetRevision !== packagedRevision)) {
      throw new Error("reviewTarget trong JSON không khớp project, variant hoặc revision của gói review hiện tại.");
    }
    reviewedRevision = targetRevision;
    if (declaredRevision && declaredRevision !== targetRevision) {
      warning = `Gemini ghi reviewedRevision=${declaredRevision} sai, tool dùng reviewTarget đã khóa là V${targetRevision}.`;
    }
  } else if (declaredRevision && declaredRevision !== currentRevision) {
    const inspectedDraftRevision = getInspectedDraftRevision(artifact?.inputAccessAudit);
    if (inspectedDraftRevision === currentRevision && packagedRevision === currentRevision) {
      reviewedRevision = currentRevision;
      warning = `Gemini ghi reviewedRevision=${declaredRevision} sai, nhưng inputAccessAudit xác nhận đã mở draft-v${currentRevision}.mp4; tool tự sửa thành V${currentRevision}.`;
    }
  }

  const currentReviewPath = safeText(
    variant?.artifacts?.draftReviewImportPath
    || variant?.draftReview?.sourcePath
    || variant?.sourceJsonPath
  );
  const currentReviewHash = safeText(variant?.artifacts?.draftReviewImportHash);
  const sameImportedArtifact = Boolean(
    (currentReviewPath && path.resolve(currentReviewPath).toLowerCase() === path.resolve(jsonPath).toLowerCase())
    || (currentReviewHash && artifactHash && currentReviewHash === artifactHash)
  );
  const reapplyCurrentReviewFile = Boolean(
    reviewedRevision
    && currentRevision === reviewedRevision + 1
    && sameImportedArtifact
  );

  if (reviewedRevision && reviewedRevision !== currentRevision && !reapplyCurrentReviewFile) {
    throw new Error(
      `File Gemini review dành cho V${reviewedRevision}, nhưng variant hiện tại đang là V${currentRevision}. `
      + "Hãy tạo lại gói review từ draft hiện tại để tránh ghi đè nhầm revision."
    );
  }
  return { reviewedRevision, reapplyCurrentReviewFile, warning };
}

function snapshotHighlightRevision(variant = {}) {
  return {
    revisionNumber: Math.max(1, safeNumber(variant.revisionNumber, 1)),
    label: variant.revisionLabel || `V${Math.max(1, safeNumber(variant.revisionNumber, 1))}`,
    savedAt: new Date().toISOString(),
    title: variant.title || variant.label || "",
    sourceJsonPath: variant.sourceJsonPath || "",
    viralPreflight: variant.viralPreflight || null,
    review: variant.draftReview || null,
    segments: Array.isArray(variant.segments) ? variant.segments : [],
    artifacts: variant.artifacts || {}
  };
}

function appendHighlightRevisionHistory(variant = {}) {
  const revisionNumber = Math.max(1, safeNumber(variant.revisionNumber, 1));
  const history = Array.isArray(variant.revisionHistory) ? [...variant.revisionHistory] : [];
  const existingIndex = history.findIndex((item) => safeNumber(item.revisionNumber) === revisionNumber);
  const snapshot = snapshotHighlightRevision(variant);
  if (existingIndex >= 0) history[existingIndex] = snapshot;
  else history.push(snapshot);
  return history.sort((left, right) => safeNumber(left.revisionNumber) - safeNumber(right.revisionNumber));
}

function hydrateDraftReviewStructure(reviewedScript = {}, activeVariant = {}) {
  if (isStorySpineScript(reviewedScript)) return { ...reviewedScript };
  const previousSegments = Array.isArray(activeVariant.segments) ? activeVariant.segments : [];
  const previousById = new Map(previousSegments.map((segment) => [
    safeText(segment.id || segment.segmentId),
    segment
  ]).filter(([id]) => id));
  const reviewedSegments = Array.isArray(reviewedScript?.segments) ? reviewedScript.segments : [];
  const structuralFields = [
    ["evidenceId", "evidence_id"],
    ["sourceRunId", "source_run_id"],
    ["macroBlockId", "macro_block_id"],
    ["storyFunction", "story_function"],
    ["transitionReason", "transition_reason"]
  ];
  const segments = reviewedSegments.map((segment) => {
    const previous = previousById.get(safeText(segment.id || segment.segmentId));
    if (!previous) return { ...segment };
    const hydrated = { ...segment };
    structuralFields.forEach(([camelKey, snakeKey]) => {
      if (safeText(hydrated[camelKey] ?? hydrated[snakeKey])) return;
      const previousValue = previous[camelKey] ?? previous[snakeKey];
      if (previousValue !== undefined && previousValue !== null && previousValue !== "") {
        hydrated[camelKey] = previousValue;
      }
    });
    return hydrated;
  });
  return {
    ...reviewedScript,
    story_blueprint: reviewedScript.story_blueprint
      || reviewedScript.storyBlueprint
      || activeVariant.storyBlueprint
      || null,
    segments
  };
}

function buildDraftReviewReadiness(variant = {}, voiceAlignmentReport = {}) {
  const review = variant.draftReview;
  if (!review) return null;
  const issues = Array.isArray(review.issues) ? review.issues : [];
  const clampScore = (value) => Math.max(0, Math.min(100, safeNumber(value, 0)));
  const issueCount = (...categories) => issues.filter((item) => categories.includes(safeText(item.category).toLowerCase())).length;
  const creative = clampScore(review.scoreAfterEstimated || review.scoreBefore || 0);
  const continuity = clampScore(100 - issueCount("hook", "continuity", "ending") * 18);
  const semantic = clampScore(100 - issueCount("voice_visual_match", "grounding") * 22);
  const measuredVoice = (voiceAlignmentReport.segments || []).filter((item) => item.status !== "not_applicable");
  const voice = measuredVoice.length ? measuredVoice.reduce((sum, item) => {
    const ratio = safeNumber(item.coverageRatio, 0);
    const score = ratio >= 0.82 && ratio <= 1.08
      ? 100
      : ratio < 0.82
      ? (ratio / 0.82) * 100
      : (1.08 / Math.max(1.08, ratio)) * 100;
    return sum + clampScore(score);
  }, 0) / measuredVoice.length : 100;
  const errors = measuredVoice.filter((item) => item.severity === "error").length;
  const warnings = measuredVoice.filter((item) => item.severity === "warning").length;
  const technical = clampScore(100 - errors * 20 - warnings * 8);
  const score = Math.round(creative * 0.30 + continuity * 0.25 + voice * 0.20 + semantic * 0.15 + technical * 0.10);
  return {
    score,
    grade: score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : "D",
    generatedAt: voiceAlignmentReport.generatedAt || new Date().toISOString(),
    components: {
      geminiCreative: Math.round(creative),
      continuity: Math.round(continuity),
      measuredVoiceCoverage: Math.round(voice),
      voiceVisualMatch: Math.round(semantic),
      technical: Math.round(technical)
    },
    measuredVoiceSceneCount: measuredVoice.length
  };
}

function resolveContiguousSceneSpan(manifestScenes = [], sourceStartSec, sourceEndSec, toleranceSec = 0.12) {
  if (!Number.isFinite(sourceStartSec) || !Number.isFinite(sourceEndSec) || sourceEndSec <= sourceStartSec) return [];
  const orderedScenes = [...manifestScenes]
    .filter((scene) => Number.isFinite(Number(scene?.startSec)) && Number.isFinite(Number(scene?.endSec)))
    .sort((a, b) => Number(a.startSec) - Number(b.startSec));
  const coveredScenes = orderedScenes.filter((scene) => (
    Number(scene.endSec) > sourceStartSec + 0.001
    && Number(scene.startSec) < sourceEndSec - 0.001
  ));
  if (!coveredScenes.length) return [];
  if (Number(coveredScenes[0].startSec) > sourceStartSec + toleranceSec) return [];
  if (Number(coveredScenes.at(-1).endSec) < sourceEndSec - toleranceSec) return [];
  for (let index = 1; index < coveredScenes.length; index += 1) {
    const previousEnd = Number(coveredScenes[index - 1].endSec);
    const currentStart = Number(coveredScenes[index].startSec);
    if (currentStart - previousEnd > toleranceSec) return [];
  }
  return coveredScenes;
}

function normalizeDeclaredNarratorRanges(parsed = {}, sourceSegments = []) {
  const declared = parsed.source_narrator_ranges || parsed.sourceNarratorRanges;
  const rawRanges = Array.isArray(declared) && declared.length
    ? declared
    : sourceSegments
      .filter((segment) => segment.source_narrator_detected === true || segment.sourceNarratorDetected === true)
      .map((segment) => ({
        startSec: segment.sourceStartSec ?? segment.source_start_sec,
        endSec: segment.sourceEndSec ?? segment.source_end_sec,
        replacementText: getHighlightVoiceText(segment),
        confidence: "segment_flag"
      }));
  return rawRanges
    .map((range, index) => ({
      index,
      startSec: safeNumber(range.startSec ?? range.sourceStartSec, -1),
      endSec: safeNumber(range.endSec ?? range.sourceEndSec, -1),
      replacementText: safeText(
        range.replacementText
        || range.sourceNarratorText
        || range.voiceover_text
        || range.voiceoverText
      ),
      confidence: safeText(range.confidence || "unknown")
    }))
    .filter((range) => range.startSec >= 0 && range.endSec > range.startSec)
    .sort((left, right) => left.startSec - right.startSec || left.endSec - right.endSec);
}

function enforceDeclaredNarratorRanges(parsed, sourceSegments, repairWarnings, jsonPath = "") {
  const serializedSeries = safeText(parsed?.series_mode || parsed?.seriesMode).toLowerCase() === "interleaved_multipart"
    || ["serialized_interleaved", "serialized_genz"].includes(
      safeText(parsed?.prompt_profile || parsed?.promptProfile).toLowerCase()
    );
  const promptProfile = safeText(parsed?.prompt_profile || parsed?.promptProfile).toLowerCase();
  const sourceNarratorPolicy = safeText(
    parsed?.source_narrator_policy || parsed?.sourceNarratorPolicy
  ).toLowerCase();
  const independentCleanNarratorPolicy = promptProfile === "independent"
    || sourceNarratorPolicy === "forbidden";
  if (!serializedSeries && !independentCleanNarratorPolicy) return;
  const declaredNarratorRanges = normalizeDeclaredNarratorRanges(parsed, sourceSegments);
  const ignoredNarratorRanges = declaredNarratorRanges.filter((range) => !range.replacementText);
  if (ignoredNarratorRanges.length) {
    repairWarnings.push(...ignoredNarratorRanges.map((range) => (
      `Bỏ qua vùng narrator ${range.startSec.toFixed(3)}-${range.endSec.toFixed(3)}s vì AI không cung cấp `
      + "replacementText/bằng chứng lời nói đã xác minh. Timestamp đơn lẻ không đủ để tắt âm gốc."
    )));
  }
  const narratorRanges = declaredNarratorRanges.filter((range) => range.replacementText);
  if (!narratorRanges.length) {
    if (!declaredNarratorRanges.length) {
      repairWarnings.push(
        "JSON chưa có source_narrator_ranges và không có segment nào đánh dấu narrator. Tool chưa thể đối chiếu chéo narrator nguồn."
      );
    }
    const sanitizedSegments = [];
    sourceSegments.forEach((segment, segmentIndex) => {
      const requestedMode = safeText(segment.audio_mode || segment.audioMode).toLowerCase();
      const narratorFlagged = segment.source_narrator_detected === true || segment.sourceNarratorDetected === true;
      const existingVoiceText = getHighlightVoiceText(segment);
      if (!narratorFlagged || requestedMode !== "original_audio" || existingVoiceText) {
        sanitizedSegments.push(segment);
        return;
      }
      const transcriptEvidence = getOriginalAudioTranscriptCandidate(segment);
      const explicitlyNarratorLabeled = /(?:^|[\[(])\s*(?:source\s+)?(?:narrator|host|reporter|news\s+anchor)\s*(?:[\]):>-]|$)/i
        .test(transcriptEvidence);
      if (transcriptEvidence && !explicitlyNarratorLabeled) {
        sanitizedSegments.push({
          ...segment,
          source_narrator_detected: false,
          sourceNarratorDetected: false
        });
        repairWarnings.push(
          `Segment ${segmentIndex + 1}: đã gỡ source_narrator_detected vì AI không cung cấp replacementText, `
          + "trong khi transcript đính kèm thể hiện lời thoại hiện trường không có nhãn narrator/host."
        );
        return;
      }
      repairWarnings.push(
        `Segment ${segmentIndex + 1}: đã loại khỏi revision vì AI đánh dấu narrator nhưng không cung cấp `
        + "replacementText hoặc transcript trực tiếp để thay thế an toàn."
      );
    });
    sourceSegments.splice(0, sourceSegments.length, ...sanitizedSegments);
    parsed.source_narrator_ranges = [];
    return;
  }

  const toleranceSec = 0.01;
  const existingNarratorReplacements = sourceSegments.map((segment, index) => ({
    index,
    startSec: safeNumber(segment.sourceStartSec ?? segment.source_start_sec, -1),
    endSec: safeNumber(segment.sourceEndSec ?? segment.source_end_sec, -1),
    audioMode: safeText(segment.audio_mode || segment.audioMode).toLowerCase(),
    voiceText: getHighlightVoiceText(segment)
  })).filter((segment) => (
    segment.startSec >= 0
    && segment.endSec > segment.startSec
    && segment.audioMode !== "original_audio"
    && segment.voiceText
  ));
  const rebuilt = [];
  sourceSegments.forEach((segment, segmentIndex) => {
    const sourceStartSec = safeNumber(segment.sourceStartSec ?? segment.source_start_sec, -1);
    const sourceEndSec = safeNumber(segment.sourceEndSec ?? segment.source_end_sec, -1);
    const requestedMode = safeText(segment.audio_mode || segment.audioMode).toLowerCase();
    const existingVoiceText = getHighlightVoiceText(segment);
    if (sourceStartSec < 0 || sourceEndSec <= sourceStartSec || requestedMode !== "original_audio" || existingVoiceText) {
      rebuilt.push(segment);
      return;
    }
    const overlaps = narratorRanges.filter((range) => (
      range.startSec < sourceEndSec - toleranceSec && range.endSec > sourceStartSec + toleranceSec
    ));
    if (!overlaps.length) {
      rebuilt.push(segment);
      return;
    }

    const boundaries = [...new Set([
      sourceStartSec,
      sourceEndSec,
      ...overlaps.flatMap((range) => [
        Math.max(sourceStartSec, range.startSec),
        Math.min(sourceEndSec, range.endSec)
      ])
    ].map((value) => Number(value.toFixed(3))))].sort((a, b) => a - b);
    const baseId = safeText(segment.id || segment.segmentId || `highlight_${String(segmentIndex + 1).padStart(4, "0")}`);
    for (let sliceIndex = 0; sliceIndex < boundaries.length - 1; sliceIndex += 1) {
      const sliceStart = boundaries[sliceIndex];
      const sliceEnd = boundaries[sliceIndex + 1];
      if (sliceEnd - sliceStart < 0.05) continue;
      const narratorRange = overlaps.find((range) => (
        range.startSec <= sliceStart + toleranceSec && range.endSec >= sliceEnd - toleranceSec
      ));
      const narratorAlreadyReplaced = narratorRange && existingNarratorReplacements.some((replacement) => (
        replacement.index !== segmentIndex
        && replacement.startSec <= sliceStart + toleranceSec
        && replacement.endSec >= sliceEnd - toleranceSec
      ));
      if (narratorAlreadyReplaced) continue;
      const slice = {
        ...segment,
        id: `${baseId}_${narratorRange ? "narrator" : "clean"}_${sliceIndex + 1}`,
        segmentId: `${baseId}_${narratorRange ? "narrator" : "clean"}_${sliceIndex + 1}`,
        sourceStartSec: sliceStart,
        sourceEndSec: sliceEnd
      };
      if (narratorRange) {
        slice.audio_mode = "voiceover_only";
        slice.voiceover_text = narratorRange.replacementText;
        slice.source_narrator_detected = true;
        slice.replaceSourceNarrator = true;
        slice.forceSourceMute = true;
        slice.sourceNarratorReplacementText = narratorRange.replacementText;
      } else {
        slice.audio_mode = "original_audio";
        slice.voiceover_text = "";
        slice.source_narrator_detected = false;
      }
      rebuilt.push(slice);
    }
    repairWarnings.push(
      `Segment ${segmentIndex + 1} giao với source_narrator_ranges; tool đã tự sửa thành ${boundaries.length - 1} lát, `
      + "khóa mute/TTS cho phần narrator và chỉ giữ original_audio ở phần sạch."
    );
  });
  sourceSegments.splice(0, sourceSegments.length, ...rebuilt);
  parsed.source_narrator_ranges = narratorRanges.map((range) => ({
    startSec: range.startSec,
    endSec: range.endSec,
    replacementText: range.replacementText,
    confidence: range.confidence
  }));
}

function validateManualGeminiScript(rawScript, manifest, jsonPath = "", evidencePayload = null, options = {}) {
  const rawParsed = typeof rawScript === "string"
    ? parseGeminiJsonObject(rawScript, path.basename(jsonPath) || "Story Recut JSON")
    : rawScript;
  const parsed = unwrapStoryScript(rawParsed);
  const compiledStorySpine = parsed?.story_spine_compiled === true;
  const sourceSegments = Array.isArray(parsed?.segments) ? parsed.segments : [];
  if (!sourceSegments.length) {
    if (Array.isArray(rawParsed?.evidence) || Array.isArray(rawParsed?.sceneEvidence)) {
      throw new Error(
        `File "${path.basename(jsonPath) || "JSON"}" là scene evidence của Giai đoạn 1, không phải kịch bản Story Recut. `
        + 'Hãy gửi các file trong thư mục "02-GUI-GEMINI" cho Gemini, tải đúng "story-recut.json", rồi chọn file đó.'
      );
    }
    const keys = rawParsed && typeof rawParsed === "object" ? Object.keys(rawParsed) : [];
    throw new Error(
      `File "${path.basename(jsonPath) || "JSON"}" không đúng schema Story Recut: thiếu mảng "segments" có dữ liệu. `
      + `Các key hiện có: ${keys.length ? keys.join(", ") : "(không có)"}.`
    );
  }
  const audioStrategy = safeText(parsed?.audio_strategy || parsed?.audioStrategy).toLowerCase();
  const seriesMode = safeText(parsed?.series_mode || parsed?.seriesMode).toLowerCase();
  const promptProfile = safeText(parsed?.prompt_profile || parsed?.promptProfile).toLowerCase();
  const sourceNarratorPolicy = safeText(
    parsed?.source_narrator_policy || parsed?.sourceNarratorPolicy
  ).toLowerCase();
  const serializedSeries = seriesMode === "interleaved_multipart"
    || ["serialized_interleaved", "serialized_genz"].includes(promptProfile);
  const independentCleanNarratorPolicy = options.independentNarratorPolicy === true
    || promptProfile === "independent"
    || sourceNarratorPolicy === "forbidden";
  const requestedSourceAudioOnly = ["source_audio_only", "clean_source_audio_only"].includes(audioStrategy)
    || parsed?.voiceover_enabled === false;
  const sourceAudioOnly = options.forceSourceAudioOnly === true
    || (!serializedSeries && requestedSourceAudioOnly && !independentCleanNarratorPolicy);
  const manifestScenes = Array.isArray(manifest?.scenes) ? manifest.scenes : [];
  const sceneById = new Map(manifestScenes.map((scene) => [safeText(scene.sceneId), scene]));
  const evidenceItems = Array.isArray(evidencePayload?.evidence) ? evidencePayload.evidence : [];
  const evidenceById = new Map(evidenceItems.map((item) => [safeText(item.evidenceId), item]));
  const repairWarnings = [];
  const preserveSourceNarrator = options.preserveSourceNarrator === true;
  if (serializedSeries && requestedSourceAudioOnly && options.forceSourceAudioOnly !== true) {
    parsed.audio_strategy = "interleaved";
    parsed.voiceover_enabled = true;
    repairWarnings.push(
      "Series Part 1-3 không dùng ngoại lệ source_audio_only của Highlight cũ; tool đã bật lại bộ lọc narrator nguồn cho Part này."
    );
  }
  if (independentCleanNarratorPolicy) {
    if (!promptProfile) parsed.prompt_profile = "independent";
    parsed.source_narrator_policy = "forbidden";
    const independentScriptId = safeNumber(parsed?.scriptId ?? parsed?.script_id, 0);
    if (independentScriptId === 1 && options.forceSourceAudioOnly !== true) {
      parsed.audio_strategy = "clean_hybrid";
      parsed.voiceover_enabled = true;
      if (requestedSourceAudioOnly) {
        repairWarnings.push(
          "Script 1 độc lập dùng profile Narrated Raw Reality; tool đã bật clean_hybrid. JSON cũ vẫn cần 2-3 đoạn voiceover_text do Gemini viết."
        );
      }
    } else if (requestedSourceAudioOnly) {
      parsed.audio_strategy = "clean_source_audio_only";
      parsed.voiceover_enabled = false;
    }
  }
  if (sourceAudioOnly) {
    parsed.audio_strategy = "source_audio_only";
    parsed.voiceover_enabled = false;
    sourceSegments.forEach((segment) => {
      segment.audio_mode = "original_audio";
      segment.voiceover_text = "";
      if (options.forceSourceAudioOnly === true) {
        segment.playbackSpeed = 1;
      }
      segment.replaceSourceNarrator = false;
      segment.forceSourceMute = false;
      delete segment.sourceNarratorReplacementText;
    });
  }
  if (!sceneById.size) {
    throw new Error("Gói Gemini không có scene-manifest hợp lệ. Hãy tạo lại gói phân tích.");
  }

  if (compiledStorySpine && evidencePayload) {
    const unknownEvidenceIds = [...new Set(sourceSegments.flatMap((segment) => (
      Array.isArray(segment.evidenceIds)
        ? segment.evidenceIds
        : [segment.evidenceId || segment.evidence_id]
    )).map((value) => safeText(value)).filter(Boolean))]
      .filter((evidenceId) => !evidenceById.has(evidenceId));
    if (unknownEvidenceIds.length) {
      throw new Error(
        `JSON ${path.basename(jsonPath) || ""}: Narrative Beat tham chiếu evidenceId không tồn tại: ${unknownEvidenceIds.join(", ")}.`
      );
    }
    repairWarnings.push(
      "Story Spine Compiler giữ nguyên các Narrative Beat liên tục; locked evidence chỉ dùng để kiểm chứng, không co beat về một evidence đơn lẻ."
    );
  }
  if (evidencePayload && !compiledStorySpine) {
    const narratorReplacementErrors = [];
    let narratorReplacementCount = 0;
    sourceSegments.forEach((segment, index) => {
      const requestedAudioMode = safeText(segment.audio_mode || segment.audioMode).toLowerCase();
      const requestedVoiceText = getHighlightVoiceText(segment);
      const evidenceId = safeText(segment.evidenceId || segment.evidence_id || "");
      const evidence = evidenceById.get(evidenceId);
      const dialogueEvidence = Array.isArray(evidence?.dialogueEvidence) ? evidence.dialogueEvidence : [];
      const sourceNarratorDetected = segment.source_narrator_detected === true || segment.sourceNarratorDetected === true;
      const sourceNarratorPresent = sourceNarratorDetected
        || evidence?.sourceNarratorPresent === true
        || ["source_narration", "mixed_narration_dialogue"].includes(
          safeText(evidence?.sourceAudioType).toLowerCase()
        )
        || dialogueEvidence.some((item) => (
          /\[(?:source\s+)?narrator\]|\bnarrator\s*:/i.test(safeText(item?.text || item))
        ));

      if (sourceAudioOnly || (preserveSourceNarrator && requestedAudioMode === "original_audio" && !requestedVoiceText)) {
        segment.audio_mode = "original_audio";
        segment.voiceover_text = "";
        segment.replaceSourceNarrator = false;
        segment.forceSourceMute = false;
        delete segment.sourceNarratorReplacementText;
        return;
      }
      const independentScriptId = safeNumber(parsed?.scriptId ?? parsed?.script_id, 0);
      if (independentCleanNarratorPolicy && requestedSourceAudioOnly && independentScriptId !== 1 && !sourceNarratorPresent) {
        segment.audio_mode = "original_audio";
        segment.voiceover_text = "";
        segment.source_narrator_detected = false;
        segment.replaceSourceNarrator = false;
        segment.forceSourceMute = false;
        delete segment.sourceNarratorReplacementText;
        return;
      }
      if (!evidence) return;
      if (!sourceNarratorPresent) return;

      let voiceText = getHighlightVoiceText(segment);
      if (!voiceText) {
        const requestedStartSec = safeNumber(segment.sourceStartSec ?? segment.source_start_sec, -1);
        const requestedEndSec = safeNumber(segment.sourceEndSec ?? segment.source_end_sec, -1);
        voiceText = extractSourceNarratorVoiceText(evidence, requestedStartSec, requestedEndSec);
        if (!voiceText) {
          narratorReplacementErrors.push(`segment ${index + 1} (${evidenceId})`);
          return;
        }
        segment.voiceover_text = voiceText;
      }
      segment.audio_mode = "voiceover_only";
      segment.source_narrator_detected = true;
      segment.replaceSourceNarrator = true;
      segment.forceSourceMute = true;
      segment.sourceNarratorReplacementText = voiceText;
      narratorReplacementCount += 1;
      repairWarnings.push(
        `Segment ${index + 1} (${evidenceId}) chứa narrator gốc: tool giữ hình ảnh, tắt audio nguồn và tạo lại lời narrator bằng voice đã chọn.`
      );
    });
    if (narratorReplacementErrors.length) {
      throw new Error(
        `JSON ${path.basename(jsonPath) || ""}: không trích được lời narrator nguồn cho ${narratorReplacementErrors.join(", ")}. `
        + "Hãy bổ sung sourceNarratorText hoặc dialogueEvidence có nhãn [Narrator] trong scene-evidence.json."
      );
    }
    if (independentCleanNarratorPolicy && requestedSourceAudioOnly && narratorReplacementCount > 0) {
      parsed.audio_strategy = "clean_hybrid";
      parsed.voiceover_enabled = true;
      repairWarnings.push(
        `Script độc lập có ${narratorReplacementCount} đoạn narrator nguồn thiết yếu; tool đã chuyển sang clean_hybrid để không phát narrator gốc.`
      );
    }

    sourceSegments.forEach((segment, index) => {
      if (getHighlightAudioMode(segment, Boolean(getHighlightVoiceText(segment))) !== "voiceover_with_ambient") return;
      const evidenceId = safeText(segment.evidenceId || segment.evidence_id || "");
      const evidence = evidenceById.get(evidenceId);
      const sourceAudioType = safeText(evidence?.sourceAudioType).toLowerCase();
      const dialogueEvidence = Array.isArray(evidence?.dialogueEvidence) ? evidence.dialogueEvidence : [];
      const narratorPresent = segment.source_narrator_detected === true
        || segment.sourceNarratorDetected === true
        || evidence?.sourceNarratorPresent === true
        || ["source_narration", "mixed_narration_dialogue"].includes(sourceAudioType);
      const importantDialoguePresent = evidence?.sceneDialoguePresent === true
        || ["scene_dialogue", "mixed_narration_dialogue"].includes(sourceAudioType)
        || dialogueEvidence.some((item) => !/\[(?:source\s+)?narrator\]|\bnarrator\s*:/i.test(safeText(item?.text || item)));
      if (!narratorPresent && !importantDialoguePresent) {
        segment.source_ambient_volume = getHighlightAmbientVolume(segment);
        segment.sourceAmbientVolume = segment.source_ambient_volume;
        return;
      }
      segment.audio_mode = "voiceover_only";
      segment.audioMode = "voiceover_only";
      segment.source_ambient_volume = 0;
      segment.sourceAmbientVolume = 0;
      repairWarnings.push(
        `Segment ${index + 1} (${evidenceId || "không có evidenceId"}) có lời thoại hoặc narrator nguồn; tool đã tắt ambient để không chồng giọng.`
      );
    });

    let outputCursor = 0;
    sourceSegments.forEach((segment, index) => {
      const evidenceId = safeText(segment.evidenceId || segment.evidence_id || "");
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) {
        throw new Error(
          `JSON ${path.basename(jsonPath) || ""}, segment ${index + 1}: evidenceId "${evidenceId || "(trống)"}" không tồn tại trong scene-evidence.json đã khóa.`
        );
      }

      const requestedSceneId = safeText(segment.sceneId || segment.scene_id || "");
      const requestedStartSec = safeNumber(
        segment.sourceStartSec ?? segment.source_start_sec ?? segment.inputStartSec ?? segment.videoStartSec,
        -1
      );
      const requestedEndSec = safeNumber(
        segment.sourceEndSec ?? segment.source_end_sec ?? segment.inputEndSec ?? segment.videoEndSec,
        -1
      );
      const evidenceStartSec = Number(evidence.sourceStartSec);
      const evidenceEndSec = Number(evidence.sourceEndSec);
      const requestedRangeValid = Number.isFinite(requestedStartSec)
        && Number.isFinite(requestedEndSec)
        && requestedEndSec > requestedStartSec;
      let lockedStartSec = requestedRangeValid ? Math.max(evidenceStartSec, requestedStartSec) : evidenceStartSec;
      let lockedEndSec = requestedRangeValid ? Math.min(evidenceEndSec, requestedEndSec) : evidenceEndSec;
      const usedFullEvidenceFallback = lockedEndSec - lockedStartSec < 0.2;
      if (usedFullEvidenceFallback) {
        lockedStartSec = evidenceStartSec;
        lockedEndSec = evidenceEndSec;
      }

      const changed = requestedSceneId !== safeText(evidence.sceneId)
        || Math.abs(lockedStartSec - requestedStartSec) > 0.005
        || Math.abs(lockedEndSec - requestedEndSec) > 0.005;
      if (changed) {
        repairWarnings.push(
          `Segment ${index + 1} đã được khóa theo ${evidenceId}: `
          + `${requestedSceneId || "(trống)"} ${requestedStartSec.toFixed(3)}-${requestedEndSec.toFixed(3)}s → `
          + `${safeText(evidence.sceneId)} ${lockedStartSec.toFixed(3)}-${lockedEndSec.toFixed(3)}s`
          + `${usedFullEvidenceFallback ? " (dùng toàn bộ evidence vì khoảng Gemini chọn không giao hợp lệ)" : ""}.`
        );
      }

      const requestedOutputStart = safeNumber(segment.startSec ?? segment.outputStartSec, outputCursor);
      const requestedOutputEnd = safeNumber(segment.endSec ?? segment.outputEndSec, requestedOutputStart);
      const requestedOutputDuration = Math.max(0, requestedOutputEnd - requestedOutputStart);
      const requestedPlaybackSpeed = safeNumber(segment.playbackSpeed ?? segment.playback_speed, NaN);
      const sourceDuration = lockedEndSec - lockedStartSec;
      const playbackSpeed = Number.isFinite(requestedPlaybackSpeed) && requestedPlaybackSpeed > 0
        ? requestedPlaybackSpeed
        : requestedOutputDuration > 0.05
        ? sourceDuration / requestedOutputDuration
        : 1;
      const outputDuration = sourceDuration / Math.max(0.05, playbackSpeed);

      segment.evidenceId = evidenceId;
      segment.sceneId = safeText(evidence.sceneId);
      const requestedSourceRunId = safeText(segment.sourceRunId || segment.source_run_id);
      segment.sourceRunId = safeText(evidence.sourceRunId);
      segment.actionCandidateId = safeText(evidence.actionCandidateId);
      segment.actionSequenceId = safeText(evidence.actionSequenceId || evidence.actionCandidateId);
      segment.actionOverride = evidence.actionOverride === true || evidence.mustInclude === true;
      if (requestedSourceRunId && requestedSourceRunId !== segment.sourceRunId) {
        repairWarnings.push(
          `Segment ${index + 1} (${evidenceId}) có sourceRunId "${requestedSourceRunId}" không khớp evidence; tool đã khóa lại thành "${segment.sourceRunId}".`
        );
      }
      segment.sourceStartSec = Number(lockedStartSec.toFixed(3));
      segment.sourceEndSec = Number(lockedEndSec.toFixed(3));
      segment.startSec = Number(outputCursor.toFixed(3));
      segment.endSec = Number((outputCursor + outputDuration).toFixed(3));
      segment.playbackSpeed = Number(playbackSpeed.toFixed(4));
      outputCursor += outputDuration;
    });
    if (Number.isFinite(Number(parsed.total_target_sec))) {
      parsed.total_target_sec = Number(outputCursor.toFixed(3));
    }
  }

  if (evidencePayload && compiledStorySpine) {
    sourceSegments.forEach((segment, index) => {
      if (getHighlightAudioMode(segment, Boolean(getHighlightVoiceText(segment))) !== "voiceover_with_ambient") return;
      const evidenceIds = Array.isArray(segment.evidenceIds) ? segment.evidenceIds : [segment.evidenceId || segment.evidence_id];
      const evidences = evidenceIds.map((value) => evidenceById.get(safeText(value))).filter(Boolean);
      const unsafeAmbient = evidences.some((evidence) => {
        const sourceAudioType = safeText(evidence.sourceAudioType).toLowerCase();
        const dialogueEvidence = Array.isArray(evidence.dialogueEvidence) ? evidence.dialogueEvidence : [];
        return evidence.sourceNarratorPresent === true
          || evidence.sceneDialoguePresent === true
          || ["source_narration", "scene_dialogue", "mixed_narration_dialogue"].includes(sourceAudioType)
          || dialogueEvidence.length > 0;
      });
      if (!unsafeAmbient) return;
      segment.audio_mode = "voiceover_only";
      segment.audioMode = "voiceover_only";
      segment.source_ambient_volume = 0;
      segment.sourceAmbientVolume = 0;
      repairWarnings.push(`Narrative Beat ${index + 1} có lời nói nguồn; tool đã tắt ambient để tránh chồng giọng.`);
    });
  }

  if (!sourceAudioOnly && !preserveSourceNarrator) {
    enforceDeclaredNarratorRanges(parsed, sourceSegments, repairWarnings, jsonPath);
  }

  sourceSegments.forEach((segment, index) => {
    let sceneId = safeText(segment.sceneId || segment.scene_id || "");
    const sourceStartSec = safeNumber(
      segment.sourceStartSec ?? segment.source_start_sec ?? segment.inputStartSec ?? segment.videoStartSec,
      -1
    );
    const sourceEndSec = safeNumber(
      segment.sourceEndSec ?? segment.source_end_sec ?? segment.inputEndSec ?? segment.videoEndSec,
      -1
    );
    const toleranceSec = 0.12;
    const contiguousSceneSpan = evidencePayload && !compiledStorySpine
      ? []
      : resolveContiguousSceneSpan(manifestScenes, sourceStartSec, sourceEndSec, toleranceSec);
    const primarySpanSceneId = safeText(contiguousSceneSpan[0]?.sceneId);
    if ((!sceneId || !sceneById.has(sceneId)) && primarySpanSceneId) {
      repairWarnings.push(
        `Segment ${index + 1}: sceneId "${sceneId || "(trống)"}" không khớp timestamp; tool đã gán theo scene bắt đầu ${primarySpanSceneId}.`
      );
      sceneId = primarySpanSceneId;
      segment.sceneId = sceneId;
    }
    if (!sceneId || !sceneById.has(sceneId)) {
      throw new Error(
        `JSON ${path.basename(jsonPath) || ""}, segment ${index + 1}: sceneId "${sceneId || "(trống)"}" không tồn tại trong scene-manifest.json.`
      );
    }
    if ((!evidencePayload || compiledStorySpine) && primarySpanSceneId && sceneId !== primarySpanSceneId) {
      repairWarnings.push(
        `Segment ${index + 1}: sceneId "${sceneId}" không chứa điểm bắt đầu ${sourceStartSec.toFixed(3)}s; tool đã chuẩn hóa thành ${primarySpanSceneId}.`
      );
      sceneId = primarySpanSceneId;
      segment.sceneId = sceneId;
    }
    const scene = sceneById.get(sceneId);
    const autoRepairToleranceSec = 0.5;
    const sceneStartSec = Number(scene.startSec);
    const sceneEndSec = Number(scene.endSec);
    const startOverflowSec = Math.max(0, sceneStartSec - sourceStartSec);
    const endOverflowSec = Math.max(0, sourceEndSec - sceneEndSec);
    const repairedStartSec = Math.max(sceneStartSec, sourceStartSec);
    const repairedEndSec = Math.min(sceneEndSec, sourceEndSec);
    const outputStartSec = safeNumber(segment.startSec ?? segment.outputStartSec, 0);
    const outputEndSec = safeNumber(segment.endSec ?? segment.outputEndSec, outputStartSec);
    const outputDurationSec = Math.max(0, outputEndSec - outputStartSec);
    const repairedPlaybackSpeed = outputDurationSec > 0.05
      ? (repairedEndSec - repairedStartSec) / outputDurationSec
      : safeNumber(segment.playbackSpeed, 1);
    const canAutoRepair = (!evidencePayload || compiledStorySpine)
      && startOverflowSec <= autoRepairToleranceSec
      && endOverflowSec <= autoRepairToleranceSec
      && (startOverflowSec > toleranceSec || endOverflowSec > toleranceSec)
      && repairedPlaybackSpeed >= 0.9
      && repairedPlaybackSpeed <= 1.1;
    if (canAutoRepair) {
      segment.sourceStartSec = Number(repairedStartSec.toFixed(3));
      segment.sourceEndSec = Number(repairedEndSec.toFixed(3));
      if (outputDurationSec > 0.05) {
        segment.playbackSpeed = Number(repairedPlaybackSpeed.toFixed(4));
      }
      repairWarnings.push(
        `Segment ${index + 1} được tự sửa theo biên ${sceneId}: nguồn ${sourceStartSec.toFixed(3)}-${sourceEndSec.toFixed(3)}s → ${repairedStartSec.toFixed(3)}-${repairedEndSec.toFixed(3)}s, playbackSpeed ${Number(segment.playbackSpeed || 1).toFixed(4)}.`
      );
      return;
    }
    if ((!evidencePayload || compiledStorySpine) && contiguousSceneSpan.length > 1) {
      const sceneIds = contiguousSceneSpan.map((item) => safeText(item.sceneId)).filter(Boolean);
      segment.sceneId = sceneIds[0];
      segment.sceneIds = sceneIds;
      segment.sceneSpan = true;
      repairWarnings.push(
        `Segment ${index + 1} đi liên tục qua ${sceneIds.length} scene (${sceneIds.join(", ")}); `
        + `tool giữ nguyên nguồn ${sourceStartSec.toFixed(3)}-${sourceEndSec.toFixed(3)}s và một track voice duy nhất.`
      );
      return;
    }
    if (sourceStartSec < sceneStartSec - toleranceSec || sourceEndSec > sceneEndSec + toleranceSec) {
      throw new Error(
        `JSON ${path.basename(jsonPath) || ""}, segment ${index + 1}: nguồn ${sourceStartSec.toFixed(3)}-${sourceEndSec.toFixed(3)}s nằm ngoài ${sceneId} (${sceneStartSec.toFixed(3)}-${sceneEndSec.toFixed(3)}s).`
      );
    }

    if (evidencePayload && !compiledStorySpine) {
      const evidenceId = safeText(segment.evidenceId || segment.evidence_id || "");
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) {
        throw new Error(
          `JSON ${path.basename(jsonPath) || ""}, segment ${index + 1}: evidenceId "${evidenceId || "(trống)"}" không tồn tại trong scene-evidence.json đã khóa.`
        );
      }
      const evidenceStartSec = Number(evidence.sourceStartSec);
      const evidenceEndSec = Number(evidence.sourceEndSec);
      const exactToleranceSec = 0.005;
      if (safeText(evidence.sceneId) !== sceneId
        || sourceStartSec < evidenceStartSec - exactToleranceSec
        || sourceStartSec >= evidenceEndSec - exactToleranceSec
        || sourceEndSec > evidenceEndSec + exactToleranceSec) {
        throw new Error(
          `JSON ${path.basename(jsonPath) || ""}, segment ${index + 1}: nguồn không nằm trọn trong hành lang ${evidenceId} `
          + `${safeText(evidence.sceneId)} ${evidenceStartSec.toFixed(3)}-${evidenceEndSec.toFixed(3)}s.`
        );
      }
    }
  });
  if (evidencePayload) {
    const usedEvidenceIds = new Set(sourceSegments.flatMap((segment) => (
      Array.isArray(segment.evidenceIds)
        ? segment.evidenceIds
        : [segment.evidenceId || segment.evidence_id]
    )).map((value) => safeText(value)).filter(Boolean));
    const missingEssential = (evidencePayload.evidence || []).filter((item) => (
      item.mustInclude === true && !usedEvidenceIds.has(safeText(item.evidenceId))
    ));
    if (missingEssential.length) {
      repairWarnings.push(
        `Cảnh báo action coverage: kịch bản bỏ sót ${missingEssential.length} evidence mustInclude (${missingEssential.slice(0, 8).map((item) => item.evidenceId).join(", ")}).`
      );
    }
  }
  parsed._toolValidationWarnings = [...new Set([
    ...(Array.isArray(parsed._toolValidationWarnings) ? parsed._toolValidationWarnings : []),
    ...repairWarnings
  ])];
  return parsed;
}

function getOverlappingTranscriptText(transcriptSegments = [], startSec = 0, endSec = 0) {
  return transcriptSegments
    .filter((segment) => Number(segment.startSec || 0) < endSec && Number(segment.endSec || 0) > startSec)
    .map((segment) => segment.text || segment.originalText || "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildCompactRepairEvidence(evidencePayload = {}) {
  return {
    artifactType: "locked_repair_evidence",
    sourceVideo: safeText(evidencePayload.sourceVideo),
    sourceRuns: (Array.isArray(evidencePayload.sourceRuns) ? evidencePayload.sourceRuns : []).map((run) => ({
      sourceRunId: safeText(run.sourceRunId),
      sourceStartSec: safeNumber(run.sourceStartSec),
      sourceEndSec: safeNumber(run.sourceEndSec),
      durationSec: safeNumber(run.durationSec),
      evidenceIds: Array.isArray(run.evidenceIds) ? run.evidenceIds.map(safeText).filter(Boolean) : []
    })),
    evidence: (Array.isArray(evidencePayload.evidence) ? evidencePayload.evidence : []).map((item) => ({
      evidenceId: safeText(item.evidenceId),
      sceneId: safeText(item.sceneId),
      sourceRunId: safeText(item.sourceRunId),
      sourceStartSec: safeNumber(item.sourceStartSec),
      sourceEndSec: safeNumber(item.sourceEndSec),
      narrativePhase: safeText(item.narrativePhase),
      completeBeat: item.completeBeat !== false,
      cutSafety: safeText(item.cutSafety),
      sourceAudioType: safeText(item.sourceAudioType),
      sourceNarratorPresent: item.sourceNarratorPresent === true,
      sourceNarratorText: safeText(item.sourceNarratorText),
      sceneDialoguePresent: item.sceneDialoguePresent === true,
      burnedTextPresent: item.burnedTextPresent === true,
      burnedTextContent: safeText(item.burnedTextContent),
      safeForVoiceover: item.safeForVoiceover !== false,
      actionCandidateId: safeText(item.actionCandidateId),
      actionSequenceId: safeText(item.actionSequenceId),
      actionType: safeText(item.actionType),
      actionIntensity: safeNumber(item.actionIntensity),
      visualRetentionScore: safeNumber(item.visualRetentionScore),
      narrativeEssential: item.narrativeEssential === true,
      mustInclude: item.mustInclude === true,
      stakeRole: safeText(item.stakeRole),
      stakeActorIds: Array.isArray(item.stakeActorIds) ? item.stakeActorIds.map(safeText).filter(Boolean) : [],
      opensQuestion: safeText(item.opensQuestion),
      resolvesQuestion: safeText(item.resolvesQuestion),
      resolutionType: safeText(item.resolutionType),
      resolutionModality: safeText(item.resolutionModality),
      visualProofScore: safeNumber(item.visualProofScore),
      proceduralBloat: item.proceduralBloat === true,
      proceduralBloatType: safeText(item.proceduralBloatType),
      mustAppearBeforeLaterTimeJump: item.mustAppearBeforeLaterTimeJump === true,
      containsUnexplainedJargon: item.containsUnexplainedJargon === true,
      jargonTerms: Array.isArray(item.jargonTerms) ? item.jargonTerms.map(safeText).filter(Boolean) : [],
      actionOverride: item.actionOverride === true,
      visualFacts: Array.isArray(item.visualFacts) ? item.visualFacts : [],
      dialogueEvidence: Array.isArray(item.dialogueEvidence) ? item.dialogueEvidence : [],
      storyMeaning: safeText(item.storyMeaning),
      soundCues: Array.isArray(item.soundCues) ? item.soundCues : [],
      keywords: Array.isArray(item.keywords) ? item.keywords : [],
      hookScore: safeNumber(item.hookScore),
      viralScore: safeNumber(item.viralScore)
    }))
  };
}

class DubbingService {
  constructor(projectStore) {
    this.projectStore = projectStore;
    this.voiceProfiles = new VoiceProfileService();
  }

  async getViralRepairContext({ workspaceRoot, projectId }) {
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    if (!project.manualGeminiPackPath) {
      return { evidence: [], sourceRuns: [], warning: "Project không có gói evidence Gemini Pro." };
    }
    const evidencePath = path.join(project.manualGeminiPackPath, "scene-evidence.json");
    const evidencePayload = JSON.parse(await fs.readFile(evidencePath, "utf8").catch(() => {
      throw new Error("Không đọc được scene-evidence.json để tạo prompt sửa kịch bản.");
    }));
    return buildCompactRepairEvidence(evidencePayload);
  }

  async emitProgress({ workspaceRoot, projectId, onProgress, step, percent, message, partial = {} }) {
    const project = await this.projectStore.updateProject(workspaceRoot, projectId, {
      status: step,
      progressPercent: percent,
      statusMessage: message,
      ...partial
    });
    // Progress crosses Electron's structured-clone boundary. Sending the full
    // project on every event repeatedly cloned large timelines and render
    // reports, then forced the renderer to rebuild the complete studio UI.
    onProgress?.({ projectId, step, percent, message });
    return project;
  }

  async recordVoiceProfileSample({ workspaceRoot, settings, project, text, measuredDurationSec, segmentDurationSec, source = "draft", providerOverride = "", voiceIdOverride = "" }) {
    if (!workspaceRoot || !safeText(text) || !Number(measuredDurationSec)) {
      return null;
    }
    try {
      const provider = providerOverride || project.voiceProvider || settings.defaultVoiceProvider || "edge_neural";
      const language = inferFastDraftLanguage(text, project);
      const draftVoiceId = project.draftVoiceMode === "custom" ? project.draftVoiceId : project.voiceId;
      return await this.voiceProfiles.recordSample(workspaceRoot, {
        settings,
        project,
        provider,
        voiceId: voiceIdOverride
          || (provider === "omnivoice"
            ? getOmniVoiceVoiceName(project, settings)
            : provider === "kokoro"
              ? draftVoiceId || "af_heart"
              : draftVoiceId || settings.defaultVoiceId || settings.defaultWindowsVoice || ""),
        language,
        style: project.genreMode || project.analysis?.style || project.mode || "default"
      }, {
        text,
        measuredDurationSec,
        segmentDurationSec,
        source
      });
    } catch (_error) {
      return null;
    }
  }

  async getVoiceProfileContext({ workspaceRoot, settings, payload = {} }) {
    const provider = payload.voiceProvider || settings.defaultVoiceProvider || "edge_neural";
    const requestedMode = safeText(payload.mode || "satisfying_storytime");
    const mode = requestedMode === "manual_gemini_pro" ? "highlight_cut" : requestedMode;
    const requestedLanguage = ["highlight_cut", "satisfying_storytime"].includes(mode)
      ? "en"
      : safeText(payload.language || payload.targetLanguage || payload.narrationLanguage || "en");
    const language = provider === "kokoro" && /^vi\b/i.test(requestedLanguage)
      ? "en"
      : requestedLanguage;
    const style = safeText(payload.style || payload.genreMode || "thriller");
    const voiceId = safeText(payload.voiceId || (
      provider === "elevenlabs"
        ? settings.defaultVoiceId
        : provider === "kokoro"
          ? "af_heart"
          : ""
    ));
    const project = {
      id: "voice-profile-context",
      mode,
      voiceProvider: provider,
      voiceId,
      cloneSourceVoice: Boolean(payload.cloneSourceVoice),
      targetLanguage: language,
      narrationLanguage: language,
      genreMode: style,
      voiceDesign: payload.voiceDesign || {}
    };
    if (provider === "omnivoice" && project.cloneSourceVoice && !project.voiceId && project.voiceDesign?.samplePath) {
      project.voiceId = project.voiceDesign.samplePath;
    }
    const resolvedVoiceId = provider === "omnivoice"
      ? getOmniVoiceVoiceName(project, settings)
      : provider === "kokoro"
        ? project.voiceId || "af_heart"
        : project.voiceId || settings.defaultVoiceId || settings.defaultWindowsVoice || "";
    const profile = await this.voiceProfiles.getProfile(workspaceRoot, {
      settings,
      project,
      provider,
      voiceId: resolvedVoiceId,
      language,
      style
    });
    if (!Number(profile.sampleCount || 0)) {
      return { generatedAt: new Date().toISOString(), profile: null, samples: [], wordBudgets: [], promptSnippet: "" };
    }
    const durations = [5, 8, 10, 12, 15, 20, 30];
    const wordBudgets = durations.map((durationSec) => {
      const [minWords, maxWords] = this.voiceProfiles.getTargetWordRange(
        durationSec,
        profile,
        { minCoverage: 0.85, maxCoverage: 0.98 }
      );
      return { durationSec, minWords, maxWords };
    });
    return {
      generatedAt: new Date().toISOString(),
      profile,
      samples: [],
      wordBudgets,
      promptSnippet: ""
    };
  }

  async calibrateVoiceProfile({ workspaceRoot, settings, payload = {}, onProgress }) {
    const provider = payload.voiceProvider || settings.defaultVoiceProvider || "edge_neural";
    const requestedMode = safeText(payload.mode || "satisfying_storytime");
    const mode = requestedMode === "manual_gemini_pro" ? "highlight_cut" : requestedMode;
    const isEnglishNarrationMode = ["highlight_cut", "satisfying_storytime"].includes(mode);
    const requestedLanguage = isEnglishNarrationMode
      ? "en"
      : safeText(payload.language || payload.targetLanguage || payload.narrationLanguage || "en");
    const language = provider === "kokoro" && /^vi\b/i.test(requestedLanguage)
      ? "en"
      : requestedLanguage;
    const style = safeText(payload.style || payload.genreMode || "storytime");
    const voiceId = safeText(payload.voiceId || (provider === "elevenlabs" ? settings.defaultVoiceId : provider === "kokoro" ? "af_heart" : ""));
    const project = {
      id: "voice-calibration",
      mode,
      voiceProvider: provider,
      voiceId,
      cloneSourceVoice: Boolean(payload.cloneSourceVoice),
      targetLanguage: language,
      narrationLanguage: language,
      genreMode: style,
      voiceDesign: payload.voiceDesign || {}
    };
    if (provider === "omnivoice" && project.cloneSourceVoice && !project.voiceId && project.voiceDesign?.samplePath) {
      project.voiceId = project.voiceDesign.samplePath;
    }
    if (provider === "omnivoice") {
      await assertOmniVoiceCloneReady(project);
    }

    const ffmpeg = new FfmpegService(settings);
    const outputDir = path.join(workspaceRoot, ".cineviral", "voice-calibration");
    await fs.mkdir(outputDir, { recursive: true });
    const sampleTexts = /^vi/i.test(language)
      ? [
        "Đây là một câu thử ngắn để đo tốc độ đọc thật của giọng này.",
        "Khi câu chuyện bắt đầu trở nên căng thẳng, từng chi tiết nhỏ trên màn hình đều phải khớp với nhịp thuyết minh.",
        "Tôi cần giọng đọc tự nhiên, liền mạch, có nhịp nghỉ vừa đủ nhưng không tạo khoảng lặng quá dài trong video."
      ]
      : [
        "This is a short test sentence to measure the real speaking speed of this voice.",
        "As the story becomes more intense, every small visual detail needs to match the rhythm of the narration.",
        "I need a natural continuous voice with enough pacing to sound human, but without leaving long silent gaps in the video."
      ];
    const samples = [];
    for (const [index, text] of sampleTexts.entries()) {
      onProgress?.(`Đang đo tốc độ giọng ${index + 1}/${sampleTexts.length}`);
      const outputPath = path.join(outputDir, `calibration-${Date.now()}-${index + 1}${audioExtensionForProvider(provider)}`);
      await this.synthesizeDubbingVoice({
        settings,
        project,
        text,
        outputPath,
        durationSec: Math.max(3, estimateSpeechSeconds(text)),
        onProgress
      });
      const meta = await ffmpeg.probeAudio(outputPath);
      const wordCount = countWords(text);
      const measuredDurationSec = Math.max(0.25, Number(meta.duration || 0));
      const profile = await this.voiceProfiles.recordSample(workspaceRoot, {
        settings,
        project,
        provider,
        voiceId: provider === "omnivoice"
          ? getOmniVoiceVoiceName(project, settings)
          : provider === "kokoro"
            ? project.voiceId || "af_heart"
            : project.voiceId || settings.defaultVoiceId || settings.defaultWindowsVoice || "",
        language,
        style
      }, {
        text,
        measuredDurationSec,
        segmentDurationSec: measuredDurationSec,
        source: "manual_calibration"
      });
      samples.push({
        index,
        text,
        outputPath,
        wordCount,
        measuredDurationSec: Number(measuredDurationSec.toFixed(3)),
        wordsPerSecond: Number((wordCount / measuredDurationSec).toFixed(3)),
        profileKey: profile.key
      });
    }
    const profile = await this.voiceProfiles.getProfile(workspaceRoot, {
      settings,
      project,
      provider,
      voiceId: provider === "omnivoice"
        ? getOmniVoiceVoiceName(project, settings)
        : provider === "kokoro"
          ? project.voiceId || "af_heart"
          : project.voiceId || settings.defaultVoiceId || settings.defaultWindowsVoice || "",
      language,
      style
    });
    const durations = [5, 8, 10, 12, 15, 20, 30];
    const wordBudgets = durations.map((durationSec) => {
      const [minWords, maxWords] = this.voiceProfiles.getTargetWordRange(durationSec, profile, { minCoverage: 0.85, maxCoverage: 0.98 });
      return { durationSec, minWords, maxWords };
    });
    const promptSnippet = [
      "Use this calibrated voice speed for the JSON script:",
      `- Provider: ${provider}`,
      `- Voice/model profile key: ${profile.key}`,
      `- Language: ${language}`,
      `- Style: ${style}`,
      `- Real measured speed: ${profile.wordsPerSecond} words/second`,
      "- Target narration coverage per segment: 85%-98% of segment duration",
      "- For each segment, calculate:",
      "  minWords = ceil(durationSec * measuredWordsPerSecond * 0.85)",
      "  maxWords = floor(durationSec * measuredWordsPerSecond * 0.98)",
      "- Keep voiceover_text within that word range unless the segment uses original_audio.",
      "",
      "Word budget table:",
      ...wordBudgets.map((item) => `- ${item.durationSec}s: ${item.minWords}-${item.maxWords} words`)
    ].join("\n");

    return {
      generatedAt: new Date().toISOString(),
      profile,
      samples,
      wordBudgets,
      promptSnippet
    };
  }

  async createProxy(ffmpeg, sourceVideoPath, outputPath) {
    await ffmpeg.run(ffmpeg.ffmpegPath, [
      "-y",
      "-i",
      sourceVideoPath,
      "-vf",
      "scale=-2:480",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "26",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      outputPath
    ], { captureStdout: false });
  }

  async extractAudio(ffmpeg, sourceVideoPath, outputPath) {
    await ffmpeg.run(ffmpeg.ffmpegPath, [
      "-y",
      "-i",
      sourceVideoPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      outputPath
    ], { captureStdout: false });
  }

  async createSilentAudio(ffmpeg, outputPath, durationSec) {
    await ffmpeg.run(ffmpeg.ffmpegPath, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-t",
      formatSeconds(Math.max(0.05, durationSec)),
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outputPath
    ], { captureStdout: false });
  }

  async maybeMaskSourceSubtitles(ffmpeg, project, inputPath, outputPath) {
    const mask = project.sourceSubtitleMask || {};
    if (!mask.enabled) {
      return inputPath;
    }
    await ffmpeg.maskSubtitleArea({
      inputPath,
      outputPath,
      mode: mask.mode || "blur",
      xPercent: mask.xPercent ?? 0,
      widthPercent: mask.widthPercent ?? 100,
      heightPercent: mask.heightPercent ?? 16,
      bottomPercent: mask.bottomPercent ?? 6,
      blurStrength: mask.strength ?? 18,
      darkness: Math.max(0.15, Math.min(0.95, Number(mask.strength || 18) / 40))
    });
    return outputPath;
  }

  async createVideoTitleOverlay(svg, outputPath, width, height) {
    if (!svg) return "";
    let window;
    try {
      const { BrowserWindow } = require("electron");
      if (typeof BrowserWindow !== "function") {
        throw new Error("Chromium renderer is unavailable");
      }
      const targetWidth = Math.max(180, Math.round(Number(width) || 1080));
      const targetHeight = Math.max(180, Math.round(Number(height) || 1920));
      const raster = resolveVideoTitleRasterDimensions(targetWidth, targetHeight);
      const renderWidth = raster.width;
      const renderHeight = raster.height;
      window = new BrowserWindow({
        show: false,
        frame: false,
        transparent: true,
        width: renderWidth,
        height: renderHeight,
        webPreferences: { offscreen: true }
      });
      const html = `<style>
html,body{margin:0;width:${renderWidth}px;height:${renderHeight}px;background:transparent;overflow:hidden}
#overlay-root{width:${targetWidth}px;height:${targetHeight}px;transform:scale(${raster.scaleX},${raster.scaleY});transform-origin:0 0}
</style><div id="overlay-root">${svg}</div>`;
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const image = await window.webContents.capturePage({ x: 0, y: 0, width: renderWidth, height: renderHeight });
      if (image.isEmpty()) throw new Error("Chromium returned an empty title image");
      const png = image.toPNG();
      if (!png?.length) throw new Error("Chromium returned an invalid title image");
      await fs.writeFile(outputPath, png);
      return outputPath;
    } catch (error) {
      throw new Error(`Không tạo được lớp tiêu đề WYSIWYG: ${error?.message || error}`);
    } finally {
      if (window && !window.isDestroyed()) window.destroy();
    }
  }

  async applyProjectVideoDecoration({
    ffmpeg,
    project,
    paths,
    inputPath,
    outputPath,
    name = "video",
    draft = false
  }) {
    const decoration = project.videoDecoration || {};
    const resolvedMask = resolveSourceSubtitleMask(project, draft);
    const renderProject = resolvedMask === project.sourceSubtitleMask
      ? project
      : { ...project, sourceSubtitleMask: resolvedMask };
    const canvasEnabled = Boolean(decoration.canvasEnabled);
    const blurBackgroundEnabled = Boolean(decoration.blurBackgroundEnabled);
    const topCaptionEnabled = Boolean(decoration.topCaptionEnabled);
    const partLabelText = resolvePartLabelText(project, decoration);
    const partLabelEnabled = Boolean(decoration.partLabelEnabled && partLabelText);
    const foregroundLayoutEnabled = Number(decoration.foregroundScalePercent ?? 100) !== 100
      || Math.abs(Number(decoration.foregroundXPercent ?? 50) - 50) > 0.01
      || Math.abs(Number(decoration.foregroundYPercent ?? 50) - 50) > 0.01;
    const maskEnabled = Boolean(resolvedMask?.enabled);
    if (!canvasEnabled && !blurBackgroundEnabled && !topCaptionEnabled && !partLabelEnabled && !foregroundLayoutEnabled) {
      if (maskEnabled) {
        await this.maybeMaskSourceSubtitles(ffmpeg, renderProject, inputPath, outputPath);
      } else if (inputPath !== outputPath) {
        await ffmpeg.copyMedia({ inputPath, outputPath });
      }
      return outputPath;
    }

    const canvas = resolveVideoCanvasDimensions(decoration, draft);
    const topCaptionFontSize = decoration.topCaptionFontSize ?? 52;
    const automaticTitle = decoration.topCaptionAutoFromScript === true
      ? resolveSuggestedTopCaption(project)
      : "";
    const title = wrapVideoTitle(
      automaticTitle || decoration.topCaptionText || project.title || "",
      calculateVideoTitleWrapChars(canvas.width, topCaptionFontSize)
    );
    const titleTextPath = path.join(paths.tempDir, `${sanitizeFilePart(name)}-top-caption.txt`);
    const titleSvgPath = path.join(paths.tempDir, `${sanitizeFilePart(name)}-top-caption.svg`);
    let titleOverlayPath = "";
    const cameraLabelEnabled = Boolean(decoration.cameraLabelEnabled && decoration.cameraLabelText);
    if ((topCaptionEnabled && title) || partLabelEnabled || cameraLabelEnabled) {
      await this.projectStore.writeText(titleTextPath, title);
      const titleSvg = buildVideoTitleOverlaySvg({
        title: topCaptionEnabled ? title : "",
        width: canvas.width,
        height: canvas.height,
        fontSize: topCaptionFontSize,
        yPercent: decoration.topCaptionYPercent ?? 8,
        titleStyle: decoration.topCaptionStyle || decoration.titleStyle || "default",
        titleBackgroundColor: decoration.topCaptionBackgroundColor || decoration.titleBackgroundColor || null,
        titleTextColor: decoration.topCaptionTextColor || decoration.titleTextColor || null,
        cameraLabel: cameraLabelEnabled ? {
          text: decoration.cameraLabelText || "CAM 1",
          textColor: decoration.cameraLabelTextColor || "#ff3333",
          xPercent: decoration.cameraLabelXPercent ?? 12,
          yPercent: decoration.cameraLabelYPercent ?? 28,
          fontSize: decoration.cameraLabelFontSize ?? 36
        } : null,
        partLabel: partLabelEnabled ? {
          text: partLabelText,
          xPercent: decoration.partLabelXPercent ?? 12,
          yPercent: decoration.partLabelYPercent ?? 8,
          fontSize: decoration.partLabelFontSize ?? 38,
          textColor: decoration.partLabelTextColor || "#ffffff",
          backgroundColor: decoration.partLabelBackgroundColor || (decoration.partLabelStyle === "viral_green" ? "#00A63E" : "#0b0d11"),
          backgroundOpacity: decoration.partLabelBackgroundOpacity ?? 0.82,
          uppercase: decoration.partLabelUppercase !== false,
          alignment: decoration.partLabelAlignment || "center",
          style: decoration.partLabelStyle || "compact"
        } : null
      });
      await this.projectStore.writeText(titleSvgPath, titleSvg);
      try {
        titleOverlayPath = await this.createVideoTitleOverlay(
          titleSvg,
          path.join(paths.tempDir, `${sanitizeFilePart(name)}-top-caption.png`),
          canvas.width,
          canvas.height
        );
      } catch (e) {
        console.warn(`[VideoDecoration] HTML renderer failed: ${e.message}. Falling back to native FFmpeg drawtext.`);
        titleOverlayPath = "";
      }
    }
    const decorationInputPath = maskEnabled
      ? path.join(paths.tempDir, `${sanitizeFilePart(name)}-source-subtitle-masked.mp4`)
      : inputPath;
    if (maskEnabled) {
      await this.maybeMaskSourceSubtitles(ffmpeg, renderProject, inputPath, decorationInputPath);
    }
    await ffmpeg.applyVideoDecoration({
      inputPath: decorationInputPath,
      outputPath,
      titleTextPath: topCaptionEnabled && title ? titleTextPath : "",
      titleOverlayPath,
      blurBackgroundEnabled,
      blurStrength: decoration.blurStrength ?? 24,
      topCaptionEnabled: topCaptionEnabled && Boolean(title),
      topCaptionFontSize,
      topCaptionYPercent: decoration.topCaptionYPercent ?? 8,
      foregroundScalePercent: decoration.foregroundScalePercent ?? 100,
      foregroundXPercent: decoration.foregroundXPercent ?? 50,
      foregroundYPercent: decoration.foregroundYPercent ?? 50,
      width: canvas.width,
      height: canvas.height,
      preset: draft ? "ultrafast" : "fast",
      crf: draft ? 29 : 21,
      masterAudio: project.autoStoryContractVersion === 3 || Boolean(project.mixer?.masterAudio)
    });
    return outputPath;
  }

  async transcribeWithWhisper({ settings, audioPath, outputDir, sourceLanguage, workspaceRoot, projectId, onProgress }) {
    const service = new SubtitleService(settings);
    const profile = await service.detectRuntime({ language: sourceLanguage });
    await this.emitProgress({
      workspaceRoot,
      projectId,
      onProgress,
      step: "transcribing",
      percent: 52,
      message: `ASR: ${profile.model} · ${profile.device}/${profile.computeType} (${profile.reason})`
    });
    const transcript = await service.transcribeToSrt({
      audioPath,
      outputDir,
      narrationLanguage: sourceLanguage,
      cacheDir: path.join(outputDir, "asr-chunk-cache")
    });
    const raw = await fs.readFile(transcript.subtitlePath, "utf8");
    return {
      ...transcript,
      segments: parseSrt(raw)
    };
  }

  async readSubtitleSegments(subtitlePath) {
    const raw = await fs.readFile(subtitlePath, "utf8");
    return parseSrt(raw);
  }

  async ingestProject({ workspaceRoot, projectId, settings, onProgress }) {
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const ffmpeg = new FfmpegService(settings);
    const sceneDetection = new SceneDetectionService(settings);

    await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "ingesting", percent: 5, message: "Đang đọc thông tin media" });
    const videoMeta = await ffmpeg.probeVideo(project.sourceVideoPath);

    const proxyPath = path.join(paths.rootDir, "proxy.mp4");
    await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "ingesting", percent: 14, message: "Đang tạo proxy 480p" });
    await this.createProxy(ffmpeg, project.sourceVideoPath, proxyPath);

    await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "detecting", percent: 28, message: "Đang phát hiện cảnh" });
    const detected = await sceneDetection.detectScenes({ videoPath: proxyPath, sourceDuration: videoMeta.duration });
    const scenes = detected.scenes.length ? detected.scenes : [{
      sceneId: "scene_0001",
      startSec: 0,
      endSec: videoMeta.duration,
      duration: videoMeta.duration
    }];

    let transcriptResult = null;
    let segments = [];
    if (project.subtitleSourcePath) {
      await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "transcribing", percent: 45, message: "Đang đọc SRT nguồn" });
      segments = await this.readSubtitleSegments(project.subtitleSourcePath);
      transcriptResult = { provider: "srt_file", subtitlePath: project.subtitleSourcePath };
    } else if (project.autoWhisper !== false) {
      const audioPath = path.join(paths.tempDir, "source-audio.wav");
      await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "transcribing", percent: 45, message: "Đang trích âm thanh nguồn" });
      await this.extractAudio(ffmpeg, project.sourceVideoPath, audioPath);
      const transcribeEngine = settings.whisperEngine === "openai-whisper"
        ? "Whisper CLI"
        : settings.whisperEngine === "faster-whisper"
        ? "faster-whisper"
        : "ASR tự động";
      await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "transcribing", percent: 55, message: `Đang nhận diện lời thoại bằng ${transcribeEngine}` });
      try {
        transcriptResult = await this.transcribeWithWhisper({
          settings,
          audioPath,
          outputDir: paths.analysisDir,
          sourceLanguage: project.sourceLanguage || "auto",
          workspaceRoot,
          projectId,
          onProgress
        });
        segments = transcriptResult.segments;
      } catch (error) {
        transcriptResult = { provider: "scene_fallback", error: error.message };
        segments = buildSceneFallbackSegments(scenes);
      }
    } else {
        transcriptResult = { provider: "scene_fallback", error: "Whisper ASR đã bị tắt trong cài đặt dự án." };
      segments = buildSceneFallbackSegments(scenes);
    }

    if (!segments.length) {
      segments = buildSceneFallbackSegments(scenes);
    }

    segments = segments.map((segment, index) => ({
      ...segment,
      id: segment.id || `seg_${String(index + 1).padStart(4, "0")}`,
      index,
      duration: Math.max(0.1, safeNumber(segment.endSec, 0) - safeNumber(segment.startSec, 0))
    }));

    await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "thumbnails", percent: 68, message: "Đang trích ảnh đại diện cảnh" });
    const thumbnailDir = path.join(paths.rootDir, "thumbnails");
    await fs.mkdir(thumbnailDir, { recursive: true });
    const thumbnailScenes = scenes.slice(0, 40);
    for (const scene of thumbnailScenes) {
      const thumbPath = path.join(thumbnailDir, `${scene.sceneId}.jpg`);
      await ffmpeg.extractThumbnail(project.sourceVideoPath, thumbPath, scene.startSec + Math.min(1, scene.duration / 2)).catch(() => {});
      scene.thumbnailPath = thumbPath;
    }

    const sceneCards = buildSceneCards(scenes, segments);
    const analysis = {
      mode: project.mode || "dubbing",
      summary: `${segments.length} subtitle segments across ${scenes.length} detected scenes.`,
      media: videoMeta,
      scenes,
      sceneCards,
      segments,
      speakers: [],
      warnings: transcriptResult?.error ? [`Whisper không khả dụng: ${transcriptResult.error}`] : [],
      kpi: {
        sceneCount: scenes.length,
        segmentCount: segments.length,
        voiceTotal: Number(segments.reduce((total, segment) => total + segment.duration, 0).toFixed(1))
      }
    };

    await this.projectStore.writeJson(path.join(paths.analysisDir, "scene_cards.json"), sceneCards);
    await this.projectStore.writeJson(path.join(paths.analysisDir, "analysis.json"), analysis);

    return await this.emitProgress({
      workspaceRoot,
      projectId,
      onProgress,
      step: "ready",
      percent: 100,
      message: "Nạp dữ liệu hoàn tất",
      partial: {
        analysis,
        artifacts: {
          proxyPath,
          transcriptPath: transcriptResult?.subtitlePath || "",
          sceneCardsPath: path.join(paths.analysisDir, "scene_cards.json"),
          analysisPath: path.join(paths.analysisDir, "analysis.json")
        }
      }
    });
  }

  async translateProject({ workspaceRoot, projectId, settings, onProgress }) {
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const analysis = project.analysis || {};
    const fallback = new LocalFallbackProvider(settings);
    let provider = fallback;
    try {
      provider = createAiProvider(settings);
    } catch (error) {
      analysis.warnings = [...(analysis.warnings || []), `AI provider không khả dụng: ${error.message}`];
    }

    let workingSegments = Array.isArray(analysis.segments) ? analysis.segments : [];
    let speakers = Array.isArray(analysis.speakers) ? analysis.speakers : [];
    if (!speakers.length && workingSegments.length) {
      await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "diarizing", percent: 35, message: "Đang phân vai giọng cho dubbing" });
      try {
        const diarized = await provider.diarizeSegments({ segments: workingSegments });
        workingSegments = diarized.segments || workingSegments;
        speakers = diarized.speakers || speakers;
      } catch (error) {
        analysis.warnings = [...(analysis.warnings || []), `Đã dùng phân vai dự phòng: ${error.message}`];
        const diarized = await fallback.diarizeSegments({ segments: workingSegments });
        workingSegments = diarized.segments || workingSegments;
        speakers = diarized.speakers || speakers;
      }
    }

    await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "translating", percent: 50, message: "Đang dịch với ngữ cảnh cảnh phim" });
    let segments;
    try {
      segments = await provider.translateSegments({
        segments: workingSegments,
        targetLanguage: project.targetLanguage || project.narrationLanguage || "vi",
        sourceLanguage: project.sourceLanguage || "auto",
        sceneCards: analysis.sceneCards || [],
        scenes: analysis.scenes || [],
        media: analysis.media || {}
      });
    } catch (error) {
      analysis.warnings = [...(analysis.warnings || []), `Đã dùng dịch dự phòng: ${error.message}`];
      segments = await fallback.translateSegments({ segments: workingSegments });
    }

    const translationDraftPath = path.join(paths.analysisDir, "translation-draft.json");
    await this.projectStore.writeJson(translationDraftPath, {
      generatedAt: new Date().toISOString(),
      provider: settings.aiProvider || "gemini",
      sourceLanguage: project.sourceLanguage || "auto",
      targetLanguage: project.targetLanguage || project.narrationLanguage || "vi",
      segments
    });

    await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "adapting", percent: 72, message: "Đang tối ưu câu dịch theo thời lượng gốc" });
    try {
      segments = await provider.adaptDubbingSegments({
        segments,
        targetLanguage: project.targetLanguage || project.narrationLanguage || "vi",
        sceneCards: analysis.sceneCards || [],
        scenes: analysis.scenes || []
      });
    } catch (error) {
      analysis.warnings = [...(analysis.warnings || []), `Đã dùng tối ưu timing dự phòng: ${error.message}`];
      segments = await fallback.adaptDubbingSegments({ segments });
    }

    const dubbingScriptPath = path.join(paths.analysisDir, "dubbing-script.json");
    const dubbingQaPath = path.join(paths.analysisDir, "dubbing-qa.json");
    const dubbingQa = buildDubbingQa(segments);
    await this.projectStore.writeJson(dubbingScriptPath, {
      generatedAt: new Date().toISOString(),
      targetLanguage: project.targetLanguage || project.narrationLanguage || "vi",
      speakers,
      segments
    });
    await this.projectStore.writeJson(dubbingQaPath, dubbingQa);

    const updatedAnalysis = {
      ...analysis,
      speakers,
      segments,
      dubbingQa,
      artifacts: {
        ...(analysis.artifacts || {}),
        translationDraftPath,
        dubbingScriptPath,
        dubbingQaPath
      },
      summary: `Translated and timing-fitted ${segments.length} dubbing segments to ${project.targetLanguage || project.narrationLanguage || "vi"}.`
    };
    await this.projectStore.writeJson(path.join(paths.analysisDir, "analysis.json"), updatedAnalysis);
    return await this.emitProgress({
      workspaceRoot,
      projectId,
      onProgress,
      step: "ready",
      percent: 100,
      message: "Kịch bản dubbing chuẩn đã sẵn sàng",
      partial: { analysis: updatedAnalysis }
    });
  }

  async rewriteScriptProject({ workspaceRoot, projectId, settings, onProgress }) {
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const analysis = project.analysis || {};
    const fallback = new LocalFallbackProvider(settings);
    let provider;
    try {
      provider = createAiProvider(settings);
    } catch (error) {
      throw new Error(`Che do viet lai kich ban can AI provider that. Hay cau hinh Gemini hoac Antigravity. Loi hien tai: ${error.message}`);
    }
    if (provider instanceof LocalFallbackProvider) {
      throw new Error("Che do viet lai kich ban khong the dung provider du phong Local, vi provider nay chi giu nguyen loi thoai goc. Hay chon Gemini hoac Antigravity trong Cai dat.");
    }

    let workingSegments = Array.isArray(analysis.segments) ? analysis.segments : [];
    let speakers = Array.isArray(analysis.speakers) ? analysis.speakers : [];
    if (!workingSegments.length) {
      throw new Error("Khong co loi thoai/transcript de viet lai kich ban.");
    }

    if (!speakers.length) {
      await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "diarizing", percent: 42, message: "Dang phan vai nguoi noi truoc khi viet lai" });
      try {
        const diarized = await provider.diarizeSegments({ segments: workingSegments });
        workingSegments = diarized.segments || workingSegments;
        speakers = diarized.speakers || speakers;
      } catch (error) {
        analysis.warnings = [...(analysis.warnings || []), `Da dung phan vai du phong: ${error.message}`];
        const diarized = await fallback.diarizeSegments({ segments: workingSegments });
        workingSegments = diarized.segments || workingSegments;
        speakers = diarized.speakers || speakers;
      }
    }

    await this.emitProgress({
      workspaceRoot,
      projectId,
      onProgress,
      step: "rewriting",
      percent: 62,
      message: "AI dang viet lai kich ban dua tren loi thoai va canh goc"
    });

    const rewriteResult = await provider.rewriteScriptSegments({
      segments: workingSegments,
      targetLanguage: project.targetLanguage || project.narrationLanguage || "auto",
      sourceLanguage: project.sourceLanguage || "auto",
      sceneCards: analysis.sceneCards || [],
      scenes: analysis.scenes || [],
      media: analysis.media || {}
    });

    const segments = rewriteResult.segments || workingSegments;
    const similarity = measureRewriteSimilarity(segments);
    if ((similarity.total <= 2 && similarity.unchanged === similarity.total) || (similarity.total > 2 && similarity.ratio >= 0.7)) {
      throw new Error(
        `AI tra ve kich ban qua giong ban goc (${similarity.unchanged}/${similarity.total} doan gan nhu khong doi). ` +
        "Hay chay lai voi AI provider tot hon hoac kiem tra transcript dau vao."
      );
    }
    const rewrittenScriptPath = path.join(paths.analysisDir, "rewritten-script.json");
    const rewriteQaPath = path.join(paths.analysisDir, "rewrite-qa.json");
    const rewriteQa = {
      generatedAt: new Date().toISOString(),
      mode: "script_rewrite",
      noFabricationRules: [
        "Khong them su kien moi",
        "Khong doi nhan vat/quan he/dong co",
        "Khong doi thu tu nguyen nhan ket qua",
        "Khong doi ket cuc"
      ],
      storyGuardrails: rewriteResult.storyGuardrails || [],
      segmentCount: segments.length,
      unchangedSegmentCount: similarity.unchanged,
      unchangedRatio: Number(similarity.ratio.toFixed(3)),
      warnings: analysis.warnings || []
    };

    await this.projectStore.writeJson(rewrittenScriptPath, {
      generatedAt: new Date().toISOString(),
      sourceLanguage: project.sourceLanguage || "auto",
      targetLanguage: project.targetLanguage || project.narrationLanguage || "vi",
      speakers,
      storyGuardrails: rewriteResult.storyGuardrails || [],
      segments
    });
    await this.projectStore.writeJson(rewriteQaPath, rewriteQa);

    const updatedAnalysis = {
      ...analysis,
      mode: "script_rewrite",
      speakers,
      segments,
      rewriteQa,
      artifacts: {
        ...(analysis.artifacts || {}),
        rewrittenScriptPath,
        rewriteQaPath
      },
      summary: `Rewritten ${segments.length} grounded script segments without changing the original story.`
    };
    await this.projectStore.writeJson(path.join(paths.analysisDir, "analysis.json"), updatedAnalysis);
    return await this.emitProgress({
      workspaceRoot,
      projectId,
      onProgress,
      step: "ready",
      percent: 100,
      message: "Kich ban viet lai da san sang",
      partial: { analysis: updatedAnalysis }
    });
  }

  async diarizeProject({ workspaceRoot, projectId, settings, onProgress }) {
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    const analysis = project.analysis || {};
    const fallback = new LocalFallbackProvider(settings);
    let provider = fallback;
    try {
      provider = createAiProvider(settings);
    } catch (error) {
      analysis.warnings = [...(analysis.warnings || []), `AI provider không khả dụng: ${error.message}`];
    }

    await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "diarizing", percent: 55, message: "Đang gắn vai người nói" });
    let result;
    try {
      result = await provider.diarizeSegments({ segments: analysis.segments || [] });
    } catch (error) {
      analysis.warnings = [...(analysis.warnings || []), `Đã dùng phân vai dự phòng: ${error.message}`];
      result = await fallback.diarizeSegments({ segments: analysis.segments || [] });
    }

    const updatedAnalysis = {
      ...analysis,
      speakers: result.speakers,
      segments: result.segments,
      summary: `Assigned ${result.speakers.length || 2} speaker profiles across ${result.segments.length} segments.`
    };
    return await this.emitProgress({
      workspaceRoot,
      projectId,
      onProgress,
      step: "ready",
      percent: 100,
      message: "Phân vai giọng hoàn tất",
      partial: { analysis: updatedAnalysis }
    });
  }

  async updateSegments({ workspaceRoot, projectId, segments }) {
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    const analysis = {
      ...(project.analysis || {}),
      segments: Array.isArray(segments) ? segments : project.analysis?.segments || []
    };
    return this.projectStore.updateProject(workspaceRoot, projectId, { analysis });
  }

  async importStorytimeProject({ workspaceRoot, projectId, settings, onProgress }) {
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const ffmpeg = new FfmpegService(settings);
    if (!project.storyScriptPath) {
      throw new Error("Chưa chọn file kịch bản Storytime JSON.");
    }

    await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "storytime", percent: 12, message: "Đang đọc video và kịch bản JSON" });
    const media = await ffmpeg.probeVideo(project.sourceVideoPath);
    const raw = await fs.readFile(project.storyScriptPath, "utf8");
    const script = normalizeStorytimeScript(raw, media.duration);
    let transcriptResult = { provider: "none", segments: [] };
    let sourceTranscriptSegments = [];
    if (project.subtitleSourcePath) {
      await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "storytime", percent: 26, message: "Đang đọc SRT gốc để đối chiếu lời thoại" });
      sourceTranscriptSegments = await this.readSubtitleSegments(project.subtitleSourcePath);
      transcriptResult = { provider: "srt_file", subtitlePath: project.subtitleSourcePath, segments: sourceTranscriptSegments };
    } else if (project.autoWhisper !== false) {
      try {
        const audioPath = path.join(paths.tempDir, "storytime-source-audio.wav");
        await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "storytime", percent: 30, message: "Đang trích âm thanh gốc để nhận diện lời thoại" });
        await this.extractAudio(ffmpeg, project.sourceVideoPath, audioPath);
        await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "storytime", percent: 42, message: "Đang nhận diện lời thoại gốc bằng Whisper/faster-whisper" });
        transcriptResult = await this.transcribeWithWhisper({
          settings,
          audioPath,
          outputDir: paths.analysisDir,
          sourceLanguage: project.sourceLanguage || "auto",
          workspaceRoot,
          projectId,
          onProgress
        });
        sourceTranscriptSegments = transcriptResult.segments || [];
      } catch (error) {
        transcriptResult = { provider: "whisper_failed", error: error.message, segments: [] };
        script.warnings.push(`Không nhận diện được lời thoại gốc: ${error.message}`);
      }
    } else {
      script.warnings.push("ASR đang tắt, phần kịch bản gốc sẽ không có transcript đối chiếu.");
    }

    const storySegments = script.segments.map((segment) => {
      const sourceText = getOverlappingTranscriptText(sourceTranscriptSegments, segment.startSec, segment.endSec);
      return {
        ...segment,
        storyText: segment.dubbingLine || segment.text || "",
        originalText: sourceText,
        text: sourceText,
        translatedText: segment.caption || segment.dubbingLine || segment.text || "",
        dubbingLine: segment.dubbingLine || segment.storyText || segment.text || ""
      };
    });
    if (!sourceTranscriptSegments.length) {
      script.warnings.push("Chưa có transcript gốc. Hãy chọn SRT hoặc bật Whisper/faster-whisper để hiện kịch bản gốc.");
    }
    const storytimeScriptPath = path.join(paths.analysisDir, "storytime-script.json");
    const validationPath = path.join(paths.analysisDir, "storytime-validation.json");
    const sourceTranscriptPath = path.join(paths.analysisDir, "storytime-source-transcript.json");
    const sceneManifestPath = path.join(paths.analysisDir, "scene-manifest.json");
    const sceneManifest = buildSceneManifest({ media, segments: storySegments, mode: "satisfying_storytime" });
    const validation = {
      generatedAt: new Date().toISOString(),
      passed: true,
      warnings: script.warnings,
      segmentCount: storySegments.length,
      duration: media.duration,
      transcriptProvider: transcriptResult.provider,
      rules: [
        "Mỗi segment cần startSec/endSec/text",
        "Timeline không được chồng đoạn",
        "Text nên đủ ngắn để fit voice an toàn"
      ]
    };

    await this.projectStore.writeJson(storytimeScriptPath, {
      title: script.title,
      language: script.language,
      style: script.style,
      segments: storySegments
    });
    await this.projectStore.writeJson(sourceTranscriptPath, {
      generatedAt: new Date().toISOString(),
      provider: transcriptResult.provider,
      subtitlePath: transcriptResult.subtitlePath || "",
      error: transcriptResult.error || "",
      segments: sourceTranscriptSegments
    });
    await this.projectStore.writeJson(sceneManifestPath, sceneManifest);
    await this.projectStore.writeJson(validationPath, validation);

    const analysis = {
      mode: "satisfying_storytime",
      summary: `Imported ${storySegments.length} storytime segments from Gemini JSON.`,
      scriptTitle: script.title,
      topHeader: script.topHeader || "",
      media,
      sceneManifest,
      scenes: storySegments.map((segment) => ({
        sceneId: segment.sceneId || segment.id,
        startSec: segment.startSec,
        endSec: segment.endSec,
        duration: segment.duration,
        transcript: segment.originalText || segment.dubbingLine
      })),
      sceneCards: [],
      sourceTranscriptSegments,
      segments: storySegments,
      speakers: [{ id: "STORYTELLER", voice: project.voiceDesign?.prompt || "storytime narrator" }],
      warnings: script.warnings,
      kpi: {
        sceneCount: storySegments.length,
        segmentCount: storySegments.length,
        voiceTotal: Number(storySegments.reduce((sum, segment) => sum + segment.duration, 0).toFixed(1))
      },
      artifacts: {
        storytimeScriptPath,
        sourceTranscriptPath,
        sceneManifestPath,
        validationPath
      }
    };

    await this.projectStore.writeJson(path.join(paths.analysisDir, "analysis.json"), analysis);
    return await this.emitProgress({
      workspaceRoot,
      projectId,
      onProgress,
      step: "ready",
      percent: 100,
      message: "Kịch bản Storytime đã sẵn sàng",
      partial: {
        analysis,
        artifacts: {
          storytimeScriptPath,
          sourceTranscriptPath,
          validationPath
        }
      }
    });
  }

  async importHighlightCutProject({ workspaceRoot, projectId, settings, onProgress }) {
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const ffmpeg = new FfmpegService(settings);
    const jsonPaths = (Array.isArray(project.storyScriptPaths) && project.storyScriptPaths.length
      ? project.storyScriptPaths
      : [project.storyScriptPath]).filter(Boolean);
    if (!jsonPaths.length) {
      throw new Error("Chua chon file Highlight Cut JSON.");
    }
    const isStoryRecutWorkflow = project.analysisWorkflow === "manual_gemini_story_recut";
    const isDiyStoryRemixWorkflow = project.analysisWorkflow === "manual_gemini_diy_story_remix";
    const isPodcastViralWorkflow = project.analysisWorkflow === "manual_gemini_podcast_cut";
    const isManualGeminiWorkflow = [
      "manual_gemini_pro",
      "manual_gemini_pro_two_pass",
      "manual_gemini_draft_review",
      "manual_gemini_story_recut",
      "manual_gemini_diy_story_remix",
      "manual_gemini_podcast_cut"
    ].includes(project.analysisWorkflow);
    const isTwoPassGeminiWorkflow = ["manual_gemini_pro_two_pass", "manual_gemini_draft_review"]
      .includes(project.analysisWorkflow);
    const usesLockedEvidence = project.analysisWorkflow === "manual_gemini_pro_two_pass" || isStoryRecutWorkflow || isDiyStoryRemixWorkflow;
    const configuredIndependentCount = Math.max(
      1,
      Math.min(5, safeNumber(project.manualGeminiPromptOptions?.independent?.scriptCount, 2))
    );
    const maxManualJsonFiles = isPodcastViralWorkflow
      ? 5
      : project.manualGeminiPromptOptions?.profile === "independent"
      ? configuredIndependentCount
      : 3;
    if (isManualGeminiWorkflow && jsonPaths.length > maxManualJsonFiles) {
      throw new Error(isPodcastViralWorkflow
        ? "Podcast Viral Cut nhận tối đa 5 JSON output."
        : project.manualGeminiPromptOptions?.profile === "independent"
        ? `Mode kịch bản độc lập đang cấu hình tối đa ${configuredIndependentCount} JSON variant.`
        : "Mode Series nhận tối đa 3 JSON variant: Script 1, 3 và 4.");
    }
    if (isPodcastViralWorkflow) {
      const expectedPodcastOutputs = Math.max(1, Math.min(5, Math.round(Number(project.manualGeminiPromptOptions?.outputCount || 1))));
      if (jsonPaths.length !== expectedPodcastOutputs) {
        throw new Error(`Podcast Viral Cut đã cấu hình ${expectedPodcastOutputs} output nhưng đang chọn ${jsonPaths.length} JSON.`);
      }
    }
    if (isStoryRecutWorkflow && jsonPaths.length !== 1) {
      throw new Error("Mode Story Recut chỉ nhận đúng một file story-recut.json.");
    }
    if (isDiyStoryRemixWorkflow && jsonPaths.length !== 1) {
      throw new Error("Mode DIY Story Remix chỉ nhận đúng một file diy-story-remix.json.");
    }

    await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "highlight", percent: 15, message: "Dang doc video va Highlight Cut JSON" });
    const media = await ffmpeg.probeVideo(project.sourceVideoPath);
    let manualManifest = null;
    let manualEvidence = null;
    let diyBlueprint = null;
    if (isManualGeminiWorkflow) {
      if (!project.manualGeminiPackPath) {
        throw new Error("Project chưa có đường dẫn gói phân tích Gemini Pro.");
      }
      const manualManifestPath = await resolveManualGeminiManifestPath(project.manualGeminiPackPath);
      if (!manualManifestPath) {
        throw new Error(
          "Không đọc được scene-manifest.json trong gói Gemini Pro (đã kiểm tra thư mục 01-GUI-GEMINI và thư mục gốc). Hãy tạo lại gói."
        );
      }
      manualManifest = JSON.parse(await fs.readFile(manualManifestPath, "utf8").catch(() => {
        throw new Error(`Không đọc được scene-manifest.json tại "${manualManifestPath}". Hãy tạo lại gói.`);
      }));
      if (manualManifest.sourceVideo && path.basename(project.sourceVideoPath) !== manualManifest.sourceVideo) {
        throw new Error(
          `Gói Gemini thuộc video "${manualManifest.sourceVideo}", không phải video đang chọn "${path.basename(project.sourceVideoPath)}".`
        );
      }
      if (Math.abs(Number(manualManifest.videoDurationSec || 0) - Number(media.duration || 0)) > 0.25) {
        throw new Error(
          `Gói Gemini có thời lượng nguồn ${Number(manualManifest.videoDurationSec || 0).toFixed(2)}s, nhưng video đang chọn dài ${Number(media.duration || 0).toFixed(2)}s. Hãy tạo lại gói từ đúng video.`
        );
      }
      if (usesLockedEvidence) {
        const manualEvidencePath = path.join(project.manualGeminiPackPath, "scene-evidence.json");
        manualEvidence = JSON.parse(await fs.readFile(manualEvidencePath, "utf8").catch(() => {
          throw new Error("Chưa có scene-evidence.json đã được tool kiểm tra. Hãy hoàn tất giai đoạn 2 trước khi nhập kịch bản.");
        }));
        if (!Array.isArray(manualEvidence.evidence) || !manualEvidence.evidence.length) {
          throw new Error("scene-evidence.json không có bằng chứng hợp lệ. Hãy nhập lại scene evidence.");
        }
        if (isDiyStoryRemixWorkflow) {
          diyBlueprint = JSON.parse(await fs.readFile(
            path.join(project.manualGeminiPackPath, "diy-story-blueprint.json"),
            "utf8"
          ).catch(() => {
            throw new Error("Chưa có diy-story-blueprint.json đã được tool kiểm tra. Hãy hoàn tất giai đoạn Blueprint.");
          }));
        }
      }
    }
    const importVoiceProfileContext = isTwoPassGeminiWorkflow
      ? await this.getVoiceProfileContext({
        workspaceRoot,
        settings,
        payload: {
          mode: project.mode,
          voiceProvider: project.voiceProvider,
          voiceId: project.voiceId,
          cloneSourceVoice: project.cloneSourceVoice,
          language: "en",
          style: project.genreMode || "thriller",
          genreMode: project.genreMode || "thriller",
          voiceDesign: project.voiceDesign || {}
        }
      })
      : null;
    const variants = [];
    for (const [variantIndex, jsonPath] of jsonPaths.entries()) {
      const raw = await fs.readFile(jsonPath, "utf8");
      const parsedArtifact = parseGeminiJsonObject(raw, path.basename(jsonPath));
      if (String(parsedArtifact?.artifactType || "") === "gemini_draft_review") {
        throw new Error(
          `File ${path.basename(jsonPath)} là kết quả review V2, không phải variant V1. `
          + "Hãy mở project gốc và dùng Import JSON thay thế; tool sẽ tự nhận diện review V2 và kiểm tra đúng revision."
        );
      }
      if (isDiyStoryRemixWorkflow && safeText(parsedArtifact?.workflow) !== "diy_story_remix") {
        throw new Error(`File ${path.basename(jsonPath)} thiếu workflow="diy_story_remix".`);
      }
      let scriptInput = isPodcastViralWorkflow
        ? await compilePodcastEdlFile({ jsonPath, packageDir: project.manualGeminiPackPath })
        : isStorySpineScript(parsedArtifact)
        ? compileStorySpineScript(parsedArtifact, {
            manifest: manualManifest,
            videoDuration: media.duration,
            maxDurationSec: project.manualGeminiPromptOptions?.profile === "independent"
              ? safeNumber(
                  project.manualGeminiPromptOptions?.independent?.durations?.[
                    `script${safeNumber(parsedArtifact.scriptId ?? parsedArtifact.script_id, [1, 3, 4, 2, 5][variantIndex] || 1)}`
                  ]?.max,
                  0
                )
              : 0
          })
        : project.analysisWorkflow === "vertex_auto_story" ? parsedArtifact : raw;
      if (manualManifest) {
        let diyValidationWarnings = [];
        let diyNarrationQuality = null;
        if (isDiyStoryRemixWorkflow) {
          const diyValidated = validateDiyFinalScript(parsedArtifact, manualEvidence, diyBlueprint);
          diyValidationWarnings = Array.isArray(diyValidated?._toolValidationWarnings)
            ? diyValidated._toolValidationWarnings
            : [];
          diyNarrationQuality = diyValidated?._diyNarrationQuality || null;
        }
        scriptInput = validateManualGeminiScript(scriptInput, manualManifest, jsonPath, manualEvidence, {
          preserveSourceNarrator: isStoryRecutWorkflow,
          forceSourceAudioOnly: isStoryRecutWorkflow,
          independentNarratorPolicy: project.manualGeminiPromptOptions?.profile === "independent"
        });
        if (diyValidationWarnings.length) {
          scriptInput._toolValidationWarnings = [...new Set([
            ...(Array.isArray(scriptInput._toolValidationWarnings) ? scriptInput._toolValidationWarnings : []),
            ...diyValidationWarnings
          ])];
        }
        if (diyNarrationQuality) scriptInput._diyNarrationQuality = diyNarrationQuality;
      }
      const configuredPromptOptions = project.manualGeminiPromptOptions || {};
      if (["serialized_interleaved", "serialized_genz"].includes(configuredPromptOptions.profile)) {
        const configuredProfile = configuredPromptOptions.profile;
        const explicitProfile = safeText(scriptInput.prompt_profile || scriptInput.promptProfile || "");
        if (explicitProfile && explicitProfile !== configuredProfile) {
          throw new Error(
            `File ${path.basename(jsonPath)} dùng prompt_profile="${explicitProfile}" nhưng project đang chọn "${configuredProfile}". Hãy tạo lại JSON từ đúng prompt hiện tại.`
          );
        }
        const scriptId = safeNumber(scriptInput.scriptId ?? scriptInput.script_id, [1, 3, 4][variantIndex] || 4);
        const partNumber = new Map([[1, 1], [3, 2], [4, 3]]).get(scriptId) || 0;
        scriptInput = {
          ...scriptInput,
          prompt_profile: configuredProfile,
          series_mode: "interleaved_multipart",
          part_number: safeNumber(scriptInput.part_number ?? scriptInput.partNumber, partNumber),
          part_badge: safeText(scriptInput.part_badge || scriptInput.partBadge || `PART ${partNumber}`),
          target_duration_min_sec: safeNumber(
            scriptInput.target_duration_min_sec ?? scriptInput.targetDurationMinSec,
            configuredPromptOptions.minDuration || 75
          ),
          target_duration_max_sec: safeNumber(
            scriptInput.target_duration_max_sec ?? scriptInput.targetDurationMaxSec,
            configuredPromptOptions.maxDuration || 110
          ),
          series_pacing: safeText(scriptInput.series_pacing || scriptInput.seriesPacing || configuredPromptOptions.pacing || "strict_10"),
          shared_hook_enabled: scriptInput.shared_hook_enabled ?? configuredPromptOptions.sharedHook !== false,
          interleaved_audio_enabled: scriptInput.interleaved_audio_enabled ?? configuredPromptOptions.interleavedAudio !== false,
          cinematic_narrator_enabled: scriptInput.cinematic_narrator_enabled ?? configuredPromptOptions.cinematicNarrator !== false,
          cliffhanger_enabled: scriptInput.cliffhanger_enabled ?? configuredPromptOptions.cliffhanger !== false
        };
      } else if (configuredPromptOptions.profile === "independent") {
        const explicitProfile = safeText(scriptInput.prompt_profile || scriptInput.promptProfile || "");
        if (explicitProfile && explicitProfile !== "independent") {
          throw new Error(
            `File ${path.basename(jsonPath)} dùng prompt_profile="${explicitProfile}" nhưng project đang chọn "independent". Hãy tạo lại JSON từ đúng prompt hiện tại.`
          );
        }
        scriptInput = {
          ...scriptInput,
          prompt_profile: "independent",
          independent_prompt_options: configuredPromptOptions.independent || scriptInput.independent_prompt_options || scriptInput.independentPromptOptions || null
        };
      } else if (configuredPromptOptions.profile === "viral_police_blotter") {
        const explicitProfile = safeText(scriptInput.prompt_profile || scriptInput.promptProfile || "");
        if (explicitProfile && explicitProfile !== "viral_police_blotter") {
          throw new Error(
            `File ${path.basename(jsonPath)} dùng prompt_profile="${explicitProfile}" nhưng project đang chọn Viral Police Blotter. Hãy tạo lại JSON từ đúng prompt hiện tại.`
          );
        }
        scriptInput = {
          ...scriptInput,
          prompt_profile: "viral_police_blotter"
        };
      } else if (configuredPromptOptions.profile === "viral_tiktok_crime_part1") {
        const explicitProfile = safeText(scriptInput.prompt_profile || scriptInput.promptProfile || "");
        if (explicitProfile && explicitProfile !== "viral_tiktok_crime_part1") {
          throw new Error(
            `File ${path.basename(jsonPath)} dùng prompt_profile="${explicitProfile}" nhưng project đang chọn TikTok Viral Bodycam. Hãy tạo lại JSON từ đúng prompt hiện tại.`
          );
        }
        const scriptId = safeNumber(scriptInput.scriptId ?? scriptInput.script_id, [1, 3, 4][variantIndex] || 1);
        const partNumber = new Map([[1, 1], [3, 2], [4, 3]]).get(scriptId) || (variantIndex + 1);
        scriptInput = {
          ...scriptInput,
          prompt_profile: "viral_tiktok_crime_part1",
          part_number: partNumber,
          part_badge: safeText(scriptInput.partBadge || scriptInput.part_badge || `PART ${partNumber}`),
          camera_label: safeText(scriptInput.cameraLabel || scriptInput.camera_label || "CAM 1")
        };
      }
      const script = normalizeHighlightCutScript(scriptInput, media.duration);
      if (configuredPromptOptions.profile === "independent") {
        const importedScriptId = safeNumber(
          scriptInput.scriptId ?? scriptInput.script_id,
          [1, 3, 4, 2, 5][variantIndex] || 1
        );
        const configuredMaxDuration = safeNumber(
          configuredPromptOptions.independent?.durations?.[`script${importedScriptId}`]?.max,
          0
        );
        const actualDuration = script.segments.reduce(
          (sum, segment) => sum + safeNumber(segment.duration, 0),
          0
        );
        if (configuredMaxDuration > 0 && actualDuration > configuredMaxDuration + 0.05) {
          throw new Error(
            `${path.basename(jsonPath)}: Script ${importedScriptId} dài ${actualDuration.toFixed(1)}s, `
            + `vượt mức tối đa user đã đặt ${configuredMaxDuration.toFixed(1)}s. `
            + "Hãy yêu cầu AI rút gọn beat phụ/dead air; tool không tự cắt giữa câu thoại hoặc cao trào."
          );
        }
      }
      if (Array.isArray(scriptInput?._toolValidationWarnings)) {
        script.warnings.push(...scriptInput._toolValidationWarnings);
      }
      const viralPreflight = isStoryRecutWorkflow
        ? scoreStoryRecutVariant({
          script: scriptInput,
          normalizedScript: script,
          evidencePayload: manualEvidence
        })
        : isTwoPassGeminiWorkflow
        ? scoreManualGeminiVariant({
          script: scriptInput,
          normalizedScript: script,
          evidencePayload: manualEvidence,
          expectedScriptId: safeNumber(
            scriptInput.scriptId ?? scriptInput.script_id,
            [1, 3, 4, 2, 5][variantIndex] || 1
          ),
          voiceProfile: importVoiceProfileContext?.profile || null
        })
        : null;
      if (viralPreflight?.issues?.length) {
        script.warnings.push(
          `Viral readiness ${viralPreflight.score}/100 (${viralPreflight.grade}): ${viralPreflight.issues.join(" ")}`
        );
      }
      const storedSegments = isStoryRecutWorkflow
        ? consolidateStoryRecutSegments(script.segments, { maxSourceGapSec: 4 })
        : script.segments;
      const consolidatedCount = script.segments.length - storedSegments.length;
      const filledSourceGapSec = storedSegments.reduce(
        (sum, segment) => sum + safeNumber(segment.filledSourceGapSec, 0),
        0
      );
      const storedTotalDuration = Number(
        storedSegments.reduce((sum, segment) => sum + safeNumber(segment.duration, 0), 0).toFixed(3)
      );
      if (isStoryRecutWorkflow && consolidatedCount > 0) {
        script.warnings.push(
          `Story Recut đã hợp nhất ${consolidatedCount} ranh giới scene kỹ thuật thành ${storedSegments.length} khối truyện liên tục.`
          + (filledSourceGapSec > 0.01
            ? ` Tool giữ thêm ${filledSourceGapSec.toFixed(2)}s chuyển tiếp bên trong cùng sourceRun để tránh âm thanh và hình ảnh bị băm vụn.`
            : "")
        );
      }
      const variantId = makeHighlightVariantId(variantIndex);
      variants.push({
        id: variantId,
        index: variantIndex,
        label: makeHighlightVariantLabel(jsonPath, script, variantIndex),
        sourceJsonPath: jsonPath,
        title: script.title,
        language: script.language,
        sourceLanguage: script.sourceLanguage,
        style: script.style,
        promptProfile: script.promptProfile,
        sourceNarratorPolicy: script.sourceNarratorPolicy,
        timelinePolicy: script.timelinePolicy,
        independentPromptOptions: script.independentPromptOptions,
        storyContract: script.storyContract,
        storyCompiler: script.storyCompiler,
        narrativeContract: script.narrativeContract,
        hookSelectionAudit: script.hookSelectionAudit,
        hookColdViewerTest: script.hookColdViewerTest,
        hookTransitionTest: script.hookTransitionTest,
        narrationArc: script.narrationArc,
        actorIdentityMap: script.actorIdentityMap,
        seriesMode: script.seriesMode,
        seriesId: script.seriesId,
        partNumber: script.partNumber,
        partBadge: script.partBadge,
        cameraLabel: script.cameraLabel,
        titleStyle: script.titleStyle,
        subtitleStyle: script.subtitleStyle,
        sharedTopBannerText: script.sharedTopBannerText,
        topHeader: script.topHeader,
        onScreenElements: script.onScreenElements,
        sharedHookEnabled: script.sharedHookEnabled,
        interleavedAudioEnabled: script.interleavedAudioEnabled,
        cinematicNarratorEnabled: script.cinematicNarratorEnabled,
        cliffhangerEnabled: script.cliffhangerEnabled,
        targetDurationMinSec: script.targetDurationMinSec,
        targetDurationMaxSec: script.targetDurationMaxSec,
        seriesPacing: script.seriesPacing,
        sourceNarratorRanges: Array.isArray(scriptInput.source_narrator_ranges)
          ? scriptInput.source_narrator_ranges.map((range) => ({ ...range }))
          : Array.isArray(scriptInput.sourceNarratorRanges)
          ? scriptInput.sourceNarratorRanges.map((range) => ({ ...range }))
          : [],
        audioStrategy: safeText(scriptInput.audio_strategy || scriptInput.audioStrategy || ""),
        voiceoverEnabled: scriptInput.voiceover_enabled !== false,
        storyBlueprint: scriptInput.story_blueprint || scriptInput.storyBlueprint || null,
        scriptId: isStoryRecutWorkflow || isDiyStoryRemixWorkflow
          ? 0
          : project.analysisWorkflow === "vertex_auto_story" ? Number(scriptInput.scriptId)
          : viralPreflight?.metrics?.scriptId
            || safeNumber(scriptInput.scriptId ?? scriptInput.script_id, [1, 3, 4, 2, 5][variantIndex] || 0),
        workflow: isStoryRecutWorkflow ? "story_recut" : isDiyStoryRemixWorkflow ? "diy_story_remix" : "highlight_cut",
        totalDuration: isStoryRecutWorkflow ? storedTotalDuration : script.totalDuration,
        requestedTotal: script.requestedTotal,
        viralPreflight,
        revisionNumber: 1,
        revisionLabel: "V1 - Gemini tạo trực tiếp",
        revisionHistory: [],
        draftReview: null,
        warnings: script.warnings,
        segments: storedSegments.map((segment) => ({ ...segment, variantId })),
        artifacts: {}
      });
      await this.emitProgress({
        workspaceRoot,
        projectId,
        onProgress,
        step: "highlight",
        percent: Math.min(70, 20 + Math.round(((variantIndex + 1) / Math.max(1, jsonPaths.length)) * 45)),
        message: `Da doc Highlight variant ${variantIndex + 1}/${jsonPaths.length}`
      });
    }
    const explicitSharedTitles = variants
      .map((variant) => safeText(variant.sharedTopBannerText))
      .filter(Boolean);
    const sharedTopBannerText = safeText(
      explicitSharedTitles[0]
      || variants[0]?.topHeader
      || variants[0]?.title
      || project.title
      || ""
    ).slice(0, 180);
    if (new Set(explicitSharedTitles.map((value) => value.toLowerCase())).size > 1) {
      variants.forEach((variant) => variant.warnings.push(
        `Các JSON dùng shared_top_banner_text khác nhau; tool đã khóa tiêu đề chung theo file đầu tiên: "${sharedTopBannerText}".`
      ));
    }
    const serializedVariants = variants.filter((variant) => variant.seriesMode === "interleaved_multipart");
    if (serializedVariants.length) {
      const expectedPartByScriptId = new Map([[1, 1], [3, 2], [4, 3]]);
      serializedVariants.forEach((variant) => {
        const expectedPart = expectedPartByScriptId.get(Number(variant.scriptId));
        if (!expectedPart || Number(variant.partNumber) !== expectedPart) {
          throw new Error(
            `Series JSON sai mapping: scriptId ${variant.scriptId || "?"} phải là part_number ${expectedPart || "1/2/3"}, nhưng file đang ghi ${variant.partNumber || "?"}.`
          );
        }
      });
      const sharedHookVariants = serializedVariants.filter((variant) => variant.sharedHookEnabled !== false);
      if (sharedHookVariants.length > 1) {
        const leadingHookSegments = (variant) => {
          const result = [];
          for (const segment of variant.segments || []) {
            if (!/hook/i.test(safeText(segment.storyFunction || segment.sceneType))) break;
            result.push(segment);
          }
          return result;
        };
        const hookSignature = (variant) => leadingHookSegments(variant).map((segment) => ({
          sceneId: safeText(segment.sceneId),
          sourceStartSec: Number(safeNumber(segment.sourceStartSec).toFixed(3)),
          sourceEndSec: Number(safeNumber(segment.sourceEndSec).toFixed(3)),
          macroBlockId: safeText(segment.macroBlockId),
          sourceRunId: safeText(segment.sourceRunId),
          actionSequenceId: safeText(segment.actionSequenceId)
        }));
        const reference = hookSignature(sharedHookVariants[0]);
        const mismatch = sharedHookVariants.find((variant) => {
          const candidate = hookSignature(variant);
          return !reference.length || JSON.stringify(candidate) !== JSON.stringify(reference);
        });
        if (mismatch) {
          throw new Error(
            "Series bật Cold Open dùng chung nhưng toàn bộ chuỗi Hook đầu của ba Part không trùng sceneId, timestamp nguồn và action sequence. Hãy yêu cầu Gemini dùng cùng một Hook hành động hoàn chỉnh 5-30s, chia theo scene khi cần và cắt trước narrator nguồn."
          );
        }
      }
      const narratorRangeSignature = (variant) => JSON.stringify(
        (variant.sourceNarratorRanges || []).map((range) => ({
          startSec: Number(safeNumber(range.startSec ?? range.sourceStartSec).toFixed(3)),
          endSec: Number(safeNumber(range.endSec ?? range.sourceEndSec).toFixed(3)),
          replacementText: safeText(range.replacementText || range.text),
          confidence: safeText(range.confidence)
        }))
      );
      const narratorReference = narratorRangeSignature(serializedVariants[0]);
      const narratorMismatch = serializedVariants.find(
        (variant) => narratorRangeSignature(variant) !== narratorReference
      );
      if (narratorMismatch) {
        throw new Error(
          "Ba Part dùng source_narrator_ranges khác nhau. Hãy yêu cầu Gemini quét narrator nguồn một lần và chép cùng bản đồ timestamp narrator vào cả ba JSON."
        );
      }
    }
    if (isTwoPassGeminiWorkflow) {
      const ranked = rankManualGeminiVariants(variants);
      const rankById = new Map(ranked.map((variant) => [variant.id, variant.viralRank]));
      variants.forEach((variant) => {
        variant.viralRank = rankById.get(variant.id) || variants.length;
      });
    }
    const activeVariant = variants[0];
    const recommendedVariant = [...variants]
      .sort((left, right) => Number(right.viralPreflight?.score || 0) - Number(left.viralPreflight?.score || 0))[0];
    const scriptPath = path.join(paths.analysisDir, "highlight-cut-script.json");
    const validationPath = path.join(paths.analysisDir, "highlight-cut-validation.json");
    const sceneManifestPath = path.join(paths.analysisDir, "scene-manifest.json");
    const sceneManifest = buildSceneManifest({ media, segments: activeVariant.segments, mode: "highlight_cut" });
    await this.projectStore.writeJson(scriptPath, {
      variants,
      activeVariantId: activeVariant.id,
      recommendedVariantId: recommendedVariant?.id || activeVariant.id,
      sharedTopBannerText,
      title: activeVariant.title,
      language: activeVariant.language,
      style: activeVariant.style,
      totalDuration: activeVariant.totalDuration,
      requestedTotal: activeVariant.requestedTotal,
      segments: activeVariant.segments
    });
    await this.projectStore.writeJson(validationPath, {
      generatedAt: new Date().toISOString(),
      passed: true,
      warnings: variants.flatMap((variant) => variant.warnings.map((warning) => `${variant.label}: ${warning}`)),
      variantCount: variants.length,
      segmentCount: activeVariant.segments.length,
      sourceDuration: media.duration,
      outputDuration: activeVariant.totalDuration,
      rules: [
        "sourceStartSec/sourceEndSec la moc cat trong video goc",
        "startSec/endSec la timeline output va phai noi tiep tu 0 den total_target_sec",
        "playbackSpeed = (sourceEndSec - sourceStartSec) / (endSec - startSec)",
        "preview_vi duoc dung de hien thi phu de tieng Viet trong preview, khong dung de render voice",
        "caption nen de rong neu khong muon burn chu vao video",
        "mọi đoạn có tool narrator dùng voiceover_only và tắt hoàn toàn soundtrack nguồn; chỉ user được bật lại âm nền trong tab Chỉnh sửa video",
        "voiceover_text chi bat buoc khi audio_mode khong phai original_audio"
      ]
    });
    await this.projectStore.writeJson(sceneManifestPath, sceneManifest);

    const analysis = {
      mode: "highlight_cut",
      workflow: project.analysisWorkflow || "standard_highlight",
      summary: variants.length > 1
        ? ["manual_gemini_pro", "manual_gemini_pro_two_pass", "manual_gemini_draft_review"].includes(project.analysisWorkflow)
          ? `Imported ${variants.length} variants from the manual Gemini Pro evidence package.`
          : `Imported ${variants.length} Highlight Cut variants from Gemini JSON.`
        : isDiyStoryRemixWorkflow
        ? `Imported one DIY Story Remix with ${activeVariant.segments.length} visual-grounded segments.`
        : isStoryRecutWorkflow
        ? `Imported one Story Recut with ${activeVariant.segments.length} locked segments.`
        : `Imported ${activeVariant.segments.length} highlight segments from Gemini JSON.`,
      media,
      sceneManifest,
      scenes: buildHighlightScenes(activeVariant.segments),
      sceneCards: [],
      activeVariantId: activeVariant.id,
      recommendedVariantId: recommendedVariant?.id || activeVariant.id,
      sharedTopBannerText,
      highlightVariants: variants,
      segments: activeVariant.segments,
      speakers: [{ id: "NARRATOR", voice: project.voiceDesign?.prompt || "highlight narrator" }],
      warnings: [
        ...(recommendedVariant && recommendedVariant.id !== activeVariant.id
          ? [`Tool đề xuất kiểm tra Variant #${recommendedVariant.index + 1} trước: Viral readiness ${recommendedVariant.viralPreflight?.score || 0}/100.`]
          : []),
        ...activeVariant.warnings
      ],
      kpi: {
        variantCount: variants.length,
        sceneCount: activeVariant.segments.length,
        segmentCount: activeVariant.segments.length,
        voiceTotal: Number(activeVariant.segments.filter((segment) => segment.voiceoverText).reduce((sum, segment) => sum + segment.duration, 0).toFixed(1))
      },
      artifacts: {
        highlightCutScriptPath: scriptPath,
        sceneManifestPath,
        validationPath
      }
    };

    await this.projectStore.writeJson(path.join(paths.analysisDir, "analysis.json"), analysis);
    return await this.emitProgress({
      workspaceRoot,
      projectId,
      onProgress,
      step: "ready",
      percent: 100,
      message: variants.length > 1 ? "Cac Highlight Cut variant da san sang" : "Highlight Cut JSON da san sang",
      partial: {
        storyScriptPath: activeVariant.sourceJsonPath,
        storyScriptPaths: jsonPaths,
        analysis,
        artifacts: {
          highlightCutScriptPath: scriptPath,
          validationPath
        }
      }
    });
  }
  buildSpeechFirstQa({ plan, durationFitReport, warnings, fallbackToLegacy = false }) {
    const durationByCluster = new Map((durationFitReport || []).map((item) => [item.clusterId, item]));
    const issues = [];
    const clusters = (plan?.clusters || []).map((cluster) => {
      const duration = durationByCluster.get(cluster.clusterId) || {};
      const risk = [...(cluster.risk || [])];
      if (duration.fitStrategy === "overflow_keep_full") risk.push("duration_overflow_after_tts");
      if (duration.trimmed) risk.push("trimmed_audio_detected");
      if (duration.fitStrategy === "legacy_trim") risk.push("legacy_trim_used");
      if (duration.ttsStatus && duration.ttsStatus !== "ok") risk.push(duration.ttsStatus);
      if (duration.fitStrategy === "pad_silence") risk.push("silence_inserted");
      const clusterIssues = risk.map((code) => ({
        code,
        severity: /overflow|trimmed|failed/.test(code) ? "warning" : "info",
        message: code
      }));
      issues.push(...clusterIssues.map((issue) => ({ ...issue, clusterId: cluster.clusterId })));
      return {
        clusterId: cluster.clusterId,
        sourceSegmentIds: cluster.sourceSegmentIds,
        start: cluster.start,
        end: cluster.end,
        translatedText: cluster.translatedText,
        adaptedText: cluster.adaptedText,
        estimatedDuration: cluster.estimatedSpeechDuration,
        generatedDuration: duration.outputDuration || duration.rawVoiceDuration || 0,
        fitStrategy: duration.fitStrategy || "",
        risk,
        suggestedFix: risk.includes("duration_overflow_after_tts")
          ? "Rút gọn câu dubbing hoặc tăng max cluster duration; speech-first không cắt cụt audio."
          : ""
      };
    });
    if (fallbackToLegacy) {
      issues.push({
        code: "fallback_to_legacy",
        severity: "warning",
        message: "Speech-first render failed; legacy segment TTS was used."
      });
    }
    return {
      generatedAt: new Date().toISOString(),
      mode: plan?.mode || "speech_first_clustered",
      passed: !issues.some((issue) => issue.severity === "error"),
      fallback_to_legacy: fallbackToLegacy,
      issueCount: issues.length,
      warnings,
      issues,
      clusters
    };
  }

  async synthesizeKokoroWithDelivery({ settings, project, text, outputPath, language, voiceRenderOptions, onProgress }) {
    const kokoro = new KokoroVoiceService(settings);
    const voiceName = project.voiceId || "af_heart";
    const speed = Math.max(0.5, Math.min(2,
      Number(settings.kokoroSpeed || 1) * safeNumber(voiceRenderOptions?.speechRateMultiplier, 1)));
    const pauseDurationMs = safeNumber(voiceRenderOptions?.pauseDurationMs, 0);
    const split = pauseDurationMs >= 150
      ? splitTextAfterPhrase(text, voiceRenderOptions?.pauseAfterPhrase)
      : null;
    if (!split?.before) {
      await kokoro.synthesizeSpeech({ text, voiceName, outputPath, language, speed, timeoutMs: 10 * 60 * 1000, onProgress });
      return;
    }
    const extension = path.extname(outputPath) || ".wav";
    const basePath = outputPath.slice(0, -extension.length);
    const firstPath = `${basePath}-delivery-a${extension}`;
    const secondPath = `${basePath}-delivery-b${extension}`;
    const ffmpeg = new FfmpegService(settings);
    const generatedPaths = [firstPath];
    try {
      await kokoro.synthesizeSpeech({ text: split.before, voiceName, outputPath: firstPath, language, speed, timeoutMs: 10 * 60 * 1000, onProgress });
      if (split.after) {
        generatedPaths.push(secondPath);
        await kokoro.synthesizeSpeech({ text: split.after, voiceName, outputPath: secondPath, language, speed, timeoutMs: 10 * 60 * 1000, onProgress });
      }
      const args = ["-y", "-i", firstPath, "-f", "lavfi", "-t", formatSeconds(pauseDurationMs / 1000), "-i", "anullsrc=channel_layout=mono:sample_rate=24000"];
      if (split.after) args.push("-i", secondPath);
      const inputCount = split.after ? 3 : 2;
      const filters = Array.from({ length: inputCount }, (_item, index) => (
        `[${index}:a]aresample=24000,aformat=sample_fmts=s16:channel_layouts=mono[a${index}]`
      ));
      filters.push(`${Array.from({ length: inputCount }, (_item, index) => `[a${index}]`).join("")}concat=n=${inputCount}:v=0:a=1[out]`);
      args.push("-filter_complex", filters.join(";"), "-map", "[out]", "-ar", "24000", "-ac", "1");
      if (extension.toLowerCase() === ".wav") args.push("-c:a", "pcm_s16le");
      else args.push("-c:a", "aac", "-b:a", "192k");
      args.push(outputPath);
      await ffmpeg.run(ffmpeg.ffmpegPath, args, { captureStdout: false });
    } finally {
      await Promise.all(generatedPaths.map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
    }
  }

  async synthesizeDubbingVoice({ settings, project, text, outputPath, durationSec, onProgress, voiceRenderOptions = {} }) {
    const provider = project.voiceProvider || settings.defaultVoiceProvider || "edge_neural";
    const voiceId = project.voiceId || "";
    const language = inferFastDraftLanguage(text, project);
    const useCache = settings.voiceCacheEnabled !== false;
    const cache = getVoiceCacheInfo({ settings, project, text, outputPath, voiceRenderOptions });
    // AutoStory v3 (Phase 12): resolve storytelling intent once; null for v2 (no emotionTag) so behavior is unchanged.
    const ttsIntentValue = voiceRenderOptions.emotionTag
      ? require("./ttsIntent").resolveTtsIntent({ emotionTag: voiceRenderOptions.emotionTag, prosody: voiceRenderOptions.prosody })
      : null;
    if (useCache) {
      try {
        const cacheStat = await fs.stat(cache.cachePath);
        if (!cacheStat.isFile() || cacheStat.size < 512) {
          throw new Error("invalid_voice_cache");
        }
        await fs.copyFile(cache.cachePath, outputPath);
        onProgress?.(`Dùng voice cache: ${cache.cacheKey}`);
        return { outputPath, cacheHit: true, cachePath: cache.cachePath, cacheKey: cache.cacheKey, voiceRenderSpec: cache.spec };
      } catch (_error) {
        // Cache miss, synthesize below.
      }
    }
    if (provider === "omnivoice") {
      await assertOmniVoiceCloneReady(project);
      const omniVoice = new OmniVoiceService(settings);
      const omniVoiceName = getOmniVoiceVoiceName(project, settings);
      await omniVoice.synthesizeSpeech({
        text,
        voiceName: omniVoiceName,
        outputPath,
        language,
        durationSec,
        numStep: 8,
        timeoutMs: 10 * 60 * 1000,
        onProgress
      });
      if (useCache) {
        await fs.mkdir(cache.cacheDir, { recursive: true });
        await fs.copyFile(outputPath, cache.cachePath).catch(() => {});
      }
      return { outputPath, cacheHit: false, cachePath: cache.cachePath, cacheKey: cache.cacheKey, voiceRenderSpec: cache.spec };
    }
    if (provider === "kokoro") {
      // AutoStory v3 (Phase 12): fold emotion rate into Kokoro's speed multiplier.
      const kokoroOptions = ttsIntentValue
        ? { ...voiceRenderOptions, speechRateMultiplier: Math.max(0.7, Math.min(1.3, safeNumber(voiceRenderOptions.speechRateMultiplier, 1) * (1 + ttsIntentValue.prosody.rateDelta))) }
        : voiceRenderOptions;
      await this.synthesizeKokoroWithDelivery({
        settings,
        project,
        text,
        outputPath,
        language,
        voiceRenderOptions: kokoroOptions,
        onProgress
      });
      if (useCache) {
        await fs.mkdir(cache.cacheDir, { recursive: true });
        await fs.copyFile(outputPath, cache.cachePath).catch(() => {});
      }
      return { outputPath, cacheHit: false, cachePath: cache.cachePath, cacheKey: cache.cacheKey, voiceRenderSpec: cache.spec };
    }
    if (provider === "windows_local") {
      const windowsVoice = new WindowsVoiceService();
      await windowsVoice.synthesizeSpeech({
        text,
        voiceName: voiceId || settings.defaultWindowsVoice || "",
        outputPath,
        rate: 0
      });
      if (useCache) {
        await fs.mkdir(cache.cacheDir, { recursive: true });
        await fs.copyFile(outputPath, cache.cachePath).catch(() => {});
      }
      return { outputPath, cacheHit: false, cachePath: cache.cachePath, cacheKey: cache.cacheKey, voiceRenderSpec: cache.spec };
    }
    if (provider === "elevenlabs") {
      const elevenLabs = new ElevenLabsService(settings.elevenLabsApiKey, settings.elevenLabsModel, settings);
      await elevenLabs.synthesizeSpeech({
        text,
        voiceId: voiceId || settings.defaultVoiceId,
        outputPath,
        languageCode: language === "vi" || language === "auto" ? "vi" : language,
        performanceMode: ttsIntentValue ? require("./ttsIntent").applyToEngine("elevenlabs", ttsIntentValue).performanceMode : "story",
        genreMode: project.genreMode || "drama"
      });
      if (useCache) {
        await fs.mkdir(cache.cacheDir, { recursive: true });
        await fs.copyFile(outputPath, cache.cachePath).catch(() => {});
      }
      return { outputPath, cacheHit: false, cachePath: cache.cachePath, cacheKey: cache.cacheKey, voiceRenderSpec: cache.spec };
    }
    const edgeTts = new EdgeTtsService();
    let edgeRate = getEdgeRateWithDelivery(project.edgeVoiceRate ?? settings.edgeVoiceRate, voiceRenderOptions);
    let edgePitch = project.edgeVoicePitchHz ?? settings.edgeVoicePitchHz;
    let edgeVolume = project.edgeVoiceVolume ?? settings.edgeVoiceVolume;
    // AutoStory v3 (Phase 12): fold emotion prosody deltas into Edge's numeric params.
    if (ttsIntentValue) {
      const p = ttsIntentValue.prosody;
      edgeRate = Math.max(-50, Math.min(100, edgeRate + Math.round(p.rateDelta * 100)));
      edgePitch = Math.max(-60, Math.min(60, safeNumber(edgePitch, 0) + Math.round(p.pitchDelta * 200)));
      edgeVolume = Math.max(0, Math.min(100, safeNumber(edgeVolume, 100) + Math.round(p.volumeDelta * 100)));
    }
    const edgeResult = await edgeTts.synthesizeSpeech({
      text,
      voiceName: voiceId,
      outputPath,
      language,
      genreMode: project.genreMode || "drama",
      rate: edgeRate,
      pitch: edgePitch,
      volume: edgeVolume,
      retries: 1,
      timeoutMs: 35000
    });
    if (useCache) {
      await fs.mkdir(cache.cacheDir, { recursive: true });
      await fs.copyFile(outputPath, cache.cachePath).catch(() => {});
    }
    return {
      outputPath,
      cacheHit: false,
      cachePath: cache.cachePath,
      cacheKey: cache.cacheKey,
      voiceRenderSpec: {
        ...cache.spec,
        resolvedVoiceId: edgeResult?.resolvedVoice || cache.voiceId,
        fallbackUsed: Boolean(edgeResult?.fallbackUsed)
      }
    };
  }

  async synthesizeFastDraftVoice({ project, settings = {}, text, outputPath, voiceRenderOptions = {} }) {
    if (settings.autoStoryResourceManaged) {
      return require("./autoStoryWorkQueue").serial("auto-story-synthesis", () => this.synthesizeFastDraftVoiceDirect({ project, settings, text, outputPath, voiceRenderOptions }));
    }
    return this.synthesizeFastDraftVoiceDirect({ project, settings, text, outputPath, voiceRenderOptions });
  }
  async synthesizeFastDraftVoiceDirect({ project, settings = {}, text, outputPath, voiceRenderOptions = {} }) {
    if (project.analysisWorkflow === "vertex_auto_story" && project.draftVoiceMode === "final") {
      const cache = getVoiceCacheInfo({ settings, project, text, outputPath, voiceRenderOptions });
      const measuredPath = project.autoStoryVoiceCache?.[cache.cacheKey];
      if (measuredPath) {
        try {
          const stat = await fs.stat(measuredPath);
          if (stat.size > 512) {
            if (path.resolve(measuredPath) !== path.resolve(outputPath)) await fs.copyFile(measuredPath, outputPath);
            return { outputPath, cacheHit: true, provider: cache.provider, voiceId: cache.voiceId };
          }
        } catch (_) { /* Recreate missing measured audio using the selected voice. */ }
      }
    }
    const draftMode = project.draftVoiceMode || "edge_neural";
    const provider = draftMode === "final"
      ? (project.voiceProvider || settings.defaultVoiceProvider || "edge_neural")
      : draftMode === "custom"
        ? (project.draftVoiceProvider || "edge_neural")
        : "edge_neural";
    let voiceId = draftMode === "final"
      ? (project.voiceId || "")
      : draftMode === "custom"
        ? (project.draftVoiceId || "")
        : "";
    if (provider === "kokoro" && !/^[ab][fm]_[a-z0-9_]+$/i.test(voiceId)) {
      voiceId = project.voiceProvider === "kokoro" && /^[ab][fm]_[a-z0-9_]+$/i.test(project.voiceId || "")
        ? project.voiceId
        : "af_heart";
    }
    if (provider === "edge_neural" && voiceId && !/Neural$/i.test(voiceId)) {
      voiceId = "";
    }
    if (provider !== "edge_neural") {
      const draftProject = {
        ...project,
        voiceProvider: provider,
        voiceId,
        cloneSourceVoice: draftMode === "final" ? project.cloneSourceVoice : false,
        voiceDesign: {
          ...(project.voiceDesign || {}),
          presetProvider: provider,
          presetVoiceId: voiceId
        }
      };
      return this.synthesizeDubbingVoice({
        settings,
        project: draftProject,
        text,
        outputPath,
        durationSec: Math.max(3, estimateSpeechSeconds(text)),
        voiceRenderOptions
      });
    }
    const edgeTts = new EdgeTtsService();
    const language = inferFastDraftLanguage(text, project);
    const edgeRate = getEdgeRateWithDelivery(settings.edgeVoiceRate, voiceRenderOptions);
    await edgeTts.synthesizeSpeech({
      text,
      voiceName: voiceId || "",
      outputPath,
      language,
      genreMode: "drama",
      rate: edgeRate,
      pitch: settings.edgeVoicePitchHz,
      volume: settings.edgeVoiceVolume,
      retries: 1,
      timeoutMs: 25000
    });
    return { outputPath, provider, voiceId };
  }

  getFastDraftVoiceProvider(project = {}, settings = {}) {
    const mode = project.draftVoiceMode || "edge_neural";
    if (mode === "final") return project.voiceProvider || settings.defaultVoiceProvider || "edge_neural";
    if (mode === "custom") return project.draftVoiceProvider || "edge_neural";
    return "edge_neural";
  }

  async importReviewedScriptProject({ workspaceRoot, projectId, settings, jsonPath }) {
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const ffmpeg = new FfmpegService(settings);
    const raw = await fs.readFile(jsonPath, "utf8");
    const artifactHash = crypto.createHash("sha256").update(raw).digest("hex");
    const parsedArtifact = parseGeminiJsonObject(raw, path.basename(jsonPath));
    const reviewedScriptPayload = unwrapStoryScript(parsedArtifact);
    const draftReviewArtifact = String(parsedArtifact?.artifactType || "") === "gemini_draft_review"
      || Boolean(parsedArtifact?.revisedScript || parsedArtifact?.revised_script)
      ? parsedArtifact
      : null;
    const media = project.analysis?.media || await ffmpeg.probeVideo(project.sourceVideoPath);
    const now = new Date().toISOString();

    if (project.mode === "satisfying_storytime") {
      const script = normalizeStorytimeScript(reviewedScriptPayload, media.duration);
      const sourceTranscriptSegments = Array.isArray(project.analysis?.sourceTranscriptSegments)
        ? project.analysis.sourceTranscriptSegments
        : [];
      const storySegments = script.segments.map((segment) => {
        const sourceText = getOverlappingTranscriptText(sourceTranscriptSegments, segment.startSec, segment.endSec);
        return invalidateFastDraftMeasurement({
          ...segment,
          storyText: segment.dubbingLine || segment.text || "",
          originalText: sourceText,
          text: sourceText,
          translatedText: segment.caption || segment.dubbingLine || segment.text || "",
          dubbingLine: segment.dubbingLine || segment.storyText || segment.text || ""
        });
      });
      const storytimeScriptPath = project.analysis?.artifacts?.storytimeScriptPath || path.join(paths.analysisDir, "storytime-script.json");
      const validationPath = path.join(paths.analysisDir, "storytime-review-import-validation.json");
      const sceneManifestPath = path.join(paths.analysisDir, "scene-manifest.json");
      const sceneManifest = buildSceneManifest({ media, segments: storySegments, mode: "satisfying_storytime" });
      await this.projectStore.writeJson(storytimeScriptPath, {
        title: script.title,
        language: script.language,
        style: script.style,
        importedReviewJsonPath: jsonPath,
        importedAt: now,
        segments: storySegments
      });
      await this.projectStore.writeJson(sceneManifestPath, sceneManifest);
      await this.projectStore.writeJson(validationPath, {
        generatedAt: now,
        source: "gemini_review_rewrite",
        importedJsonPath: jsonPath,
        passed: true,
        warnings: script.warnings,
        segmentCount: storySegments.length,
        duration: media.duration
      });
      const previousWarnings = Array.isArray(project.analysis?.warnings) ? project.analysis.warnings : [];
      const retainedWarnings = previousWarnings.filter((warning) => {
        const text = safeText(warning);
        return !text.startsWith("Draft voice cảnh ") && !text.startsWith("Quality gate:");
      });
      const analysis = {
        ...(project.analysis || {}),
        mode: "satisfying_storytime",
        summary: `Imported Gemini reviewed Storytime script from ${path.basename(jsonPath)}.`,
        scriptTitle: script.title,
        topHeader: script.topHeader || project.analysis?.topHeader || "",
        media,
        sceneManifest,
        scenes: storySegments.map((segment) => ({
          sceneId: segment.sceneId || segment.id,
          startSec: segment.startSec,
          endSec: segment.endSec,
          duration: segment.duration,
          transcript: segment.originalText || segment.dubbingLine
        })),
        sourceTranscriptSegments,
        segments: storySegments,
        warnings: [...retainedWarnings, ...script.warnings, "Đã import JSON Gemini sửa sau draft. Hãy render nháp nhanh lại để đo voice thật."],
        qualityGate: buildProjectQualityGate(storySegments, "satisfying_storytime"),
        kpi: {
          ...(project.analysis?.kpi || {}),
          sceneCount: storySegments.length,
          segmentCount: storySegments.length,
          voiceTotal: Number(storySegments.reduce((sum, segment) => sum + segment.duration, 0).toFixed(1))
        },
        artifacts: {
          ...clearFastDraftArtifacts(project.analysis?.artifacts || {}),
          storytimeScriptPath,
          sceneManifestPath,
          validationPath,
          reviewedScriptJsonPath: jsonPath
        }
      };
      await this.projectStore.writeJson(path.join(paths.analysisDir, "analysis.json"), analysis);
      return this.projectStore.updateProject(workspaceRoot, projectId, {
        artifacts: clearFastDraftArtifacts(project.artifacts || {}),
        analysis
      });
    }

    if (project.mode === "highlight_cut") {
      const activeVariant = resolveReviewedHighlightVariant(
        project,
        reviewedScriptPayload,
        Boolean(draftReviewArtifact)
      );
      const variantId = activeVariant.id || "variant_01";
      let reapplyCurrentReviewFile = false;
      let effectiveReviewedRevision = 0;
      let reviewBindingWarning = "";
      if (draftReviewArtifact) {
        const binding = resolveDraftReviewBinding({
          projectId,
          variant: activeVariant,
          artifact: draftReviewArtifact,
          jsonPath,
          artifactHash
        });
        effectiveReviewedRevision = binding.reviewedRevision;
        reapplyCurrentReviewFile = binding.reapplyCurrentReviewFile;
        reviewBindingWarning = binding.warning;
      }
      const isStoryRecutWorkflow = project.analysisWorkflow === "manual_gemini_story_recut";
      const isDiyStoryRemixWorkflow = project.analysisWorkflow === "manual_gemini_diy_story_remix";
      const isTwoPassGeminiWorkflow = ["manual_gemini_pro_two_pass", "manual_gemini_draft_review"]
        .includes(project.analysisWorkflow);
      const isDraftReviewWorkflow = project.analysisWorkflow === "manual_gemini_draft_review";
      const usesManualManifest = isStoryRecutWorkflow || isDiyStoryRemixWorkflow || isTwoPassGeminiWorkflow || isDraftReviewWorkflow;
      const usesLockedEvidence = isStoryRecutWorkflow || isDiyStoryRemixWorkflow || project.analysisWorkflow === "manual_gemini_pro_two_pass";
      let scriptInput = draftReviewArtifact
        ? hydrateDraftReviewStructure(reviewedScriptPayload, activeVariant)
        : reviewedScriptPayload;
      let manualManifest = null;
      let manualEvidence = null;
      let diyValidationWarnings = [];
      let diyNarrationQuality = null;
      if (usesManualManifest) {
        if (!project.manualGeminiPackPath) {
          throw new Error("Project chưa có gói Gemini Pro để kiểm tra lại JSON đã sửa.");
        }
        const manualManifestPath = await resolveManualGeminiManifestPath(project.manualGeminiPackPath);
        if (!manualManifestPath) {
          throw new Error("Không đọc được scene-manifest.json trong gói Gemini Pro. Hãy tạo lại gói trước khi import JSON sửa.");
        }
        manualManifest = JSON.parse(await fs.readFile(manualManifestPath, "utf8"));
        if (usesLockedEvidence) {
          const manualEvidencePath = path.join(project.manualGeminiPackPath, "scene-evidence.json");
          manualEvidence = JSON.parse(await fs.readFile(manualEvidencePath, "utf8").catch(() => {
            throw new Error("Không đọc được scene-evidence.json đã khóa. Hãy hoàn tất lại giai đoạn 2.");
          }));
        }
        if (isDiyStoryRemixWorkflow) {
          const diyBlueprint = JSON.parse(await fs.readFile(
            path.join(project.manualGeminiPackPath, "diy-story-blueprint.json"),
            "utf8"
          ).catch(() => {
            throw new Error("Không đọc được diy-story-blueprint.json đã khóa.");
          }));
          const diyValidated = validateDiyFinalScript(reviewedScriptPayload, manualEvidence, diyBlueprint);
          diyValidationWarnings = Array.isArray(diyValidated?._toolValidationWarnings)
            ? diyValidated._toolValidationWarnings
            : [];
          diyNarrationQuality = diyValidated?._diyNarrationQuality || null;
        }
        if (isStorySpineScript(scriptInput)) {
          const reviewScriptId = safeNumber(
            scriptInput.scriptId ?? scriptInput.script_id,
            activeVariant.scriptId || 1
          );
          scriptInput = compileStorySpineScript(scriptInput, {
            manifest: manualManifest,
            videoDuration: media.duration,
            maxDurationSec: safeText(activeVariant.promptProfile).toLowerCase() === "independent"
              ? safeNumber(
                  (activeVariant.independentPromptOptions || project.manualGeminiPromptOptions?.independent)?.durations?.[`script${reviewScriptId}`]?.max,
                  0
                )
              : 0
          });
        }
        scriptInput = validateManualGeminiScript(scriptInput, manualManifest, jsonPath, manualEvidence, {
          preserveSourceNarrator: isStoryRecutWorkflow,
          forceSourceAudioOnly: isStoryRecutWorkflow,
          independentNarratorPolicy: safeText(activeVariant.promptProfile).toLowerCase() === "independent"
        });
        if (diyValidationWarnings.length) {
          scriptInput._toolValidationWarnings = [...new Set([
            ...(Array.isArray(scriptInput._toolValidationWarnings) ? scriptInput._toolValidationWarnings : []),
            ...diyValidationWarnings
          ])];
        }
        if (diyNarrationQuality) scriptInput._diyNarrationQuality = diyNarrationQuality;
      }
      if (activeVariant.seriesMode === "interleaved_multipart") {
        scriptInput = {
          ...scriptInput,
          prompt_profile: safeText(scriptInput.prompt_profile || scriptInput.promptProfile || activeVariant.promptProfile || "serialized_interleaved"),
          series_mode: "interleaved_multipart",
          series_id: safeText(scriptInput.series_id || scriptInput.seriesId || activeVariant.seriesId || ""),
          part_number: safeNumber(scriptInput.part_number ?? scriptInput.partNumber, activeVariant.partNumber || 0),
          part_badge: safeText(scriptInput.part_badge || scriptInput.partBadge || activeVariant.partBadge || ""),
          target_duration_min_sec: safeNumber(scriptInput.target_duration_min_sec ?? scriptInput.targetDurationMinSec, activeVariant.targetDurationMinSec || 75),
          target_duration_max_sec: safeNumber(scriptInput.target_duration_max_sec ?? scriptInput.targetDurationMaxSec, activeVariant.targetDurationMaxSec || 110),
          series_pacing: safeText(scriptInput.series_pacing || scriptInput.seriesPacing || activeVariant.seriesPacing || "strict_10"),
          shared_hook_enabled: scriptInput.shared_hook_enabled ?? activeVariant.sharedHookEnabled !== false,
          interleaved_audio_enabled: scriptInput.interleaved_audio_enabled ?? activeVariant.interleavedAudioEnabled !== false,
          cinematic_narrator_enabled: scriptInput.cinematic_narrator_enabled ?? activeVariant.cinematicNarratorEnabled !== false,
          cliffhanger_enabled: scriptInput.cliffhanger_enabled ?? activeVariant.cliffhangerEnabled !== false,
          top_banner_text: safeText(scriptInput.top_banner_text || scriptInput.topHeader || activeVariant.topHeader || ""),
          on_screen_elements: Array.isArray(scriptInput.on_screen_elements)
            ? scriptInput.on_screen_elements
            : (activeVariant.onScreenElements || [])
        };
      } else if (safeText(activeVariant.promptProfile).toLowerCase() === "independent") {
        scriptInput = {
          ...scriptInput,
          prompt_profile: "independent",
          independent_prompt_options: activeVariant.independentPromptOptions
            || project.manualGeminiPromptOptions?.independent
            || scriptInput.independent_prompt_options
            || scriptInput.independentPromptOptions
            || null
        };
      }
      const script = normalizeHighlightCutScript(scriptInput, media.duration);
      if (safeText(activeVariant.promptProfile).toLowerCase() === "independent") {
        const importedScriptId = safeNumber(scriptInput.scriptId ?? scriptInput.script_id, activeVariant.scriptId || 1);
        const configuredMaxDuration = safeNumber(
          (activeVariant.independentPromptOptions || project.manualGeminiPromptOptions?.independent)
            ?.durations?.[`script${importedScriptId}`]?.max,
          0
        );
        const actualDuration = script.segments.reduce(
          (sum, segment) => sum + safeNumber(segment.duration, 0),
          0
        );
        if (configuredMaxDuration > 0 && actualDuration > configuredMaxDuration + 0.05) {
          throw new Error(
            `${path.basename(jsonPath)}: Script ${importedScriptId} dài ${actualDuration.toFixed(1)}s, `
            + `vượt mức tối đa user đã đặt ${configuredMaxDuration.toFixed(1)}s. `
            + "Hãy yêu cầu AI rút gọn beat phụ/dead air; tool không tự cắt giữa câu thoại hoặc cao trào."
          );
        }
      }
      if (Array.isArray(scriptInput?._toolValidationWarnings)) {
        script.warnings.push(...scriptInput._toolValidationWarnings);
      }
      if (reapplyCurrentReviewFile) {
        script.warnings.push(
          "Tool đã biên dịch lại đúng file review hiện tại bằng audio policy mới; revision không bị tăng thêm."
        );
      }
      const viralPreflight = isStoryRecutWorkflow
        ? scoreStoryRecutVariant({
          script: scriptInput,
          normalizedScript: script,
          evidencePayload: manualEvidence
        })
        : isTwoPassGeminiWorkflow
        ? scoreManualGeminiVariant({
          script: scriptInput,
          normalizedScript: script,
          evidencePayload: manualEvidence,
          expectedScriptId: Number(activeVariant.scriptId || scriptInput.scriptId || 4),
          previousNormalizedScript: activeVariant,
          previousPreflight: activeVariant.viralPreflight || null,
          voiceProfile: (await this.getVoiceProfileContext({
            workspaceRoot,
            settings,
            payload: {
              mode: project.mode,
              voiceProvider: project.voiceProvider,
              voiceId: project.voiceId,
              cloneSourceVoice: project.cloneSourceVoice,
              language: "en",
              style: project.genreMode || "thriller",
              genreMode: project.genreMode || "thriller",
              voiceDesign: project.voiceDesign || {}
            }
          }))?.profile || null
        })
        : null;
      const previousPreflight = activeVariant.viralPreflight || null;
      const previousScore = Number(previousPreflight?.score);
      const candidateScore = Number(viralPreflight?.score);
      const previousIssueCount = Array.isArray(previousPreflight?.issues) ? previousPreflight.issues.length : 0;
      const candidateIssueCount = Array.isArray(viralPreflight?.issues) ? viralPreflight.issues.length : 0;
      const scoreRegressed = Number.isFinite(previousScore)
        && Number.isFinite(candidateScore)
        && candidateScore < previousScore;
      const sameScoreMoreErrors = Number.isFinite(previousScore)
        && Number.isFinite(candidateScore)
        && candidateScore === previousScore
        && candidateIssueCount > previousIssueCount;
      if (scoreRegressed || sameScoreMoreErrors) {
        const regressionWarningPath = path.join(paths.analysisDir, "highlight-cut-review-regression-warning.json");
        await this.projectStore.writeJson(regressionWarningPath, {
          generatedAt: now,
          accepted: true,
          importedWithWarning: true,
          importedJsonPath: jsonPath,
          current: previousPreflight,
          candidate: viralPreflight,
          reason: scoreRegressed ? "score_regressed" : "same_score_more_errors"
        });
        const newIssues = (viralPreflight?.issues || []).slice(0, 4).join(" ");
        script.warnings.push(
          `Cảnh báo chất lượng V2: ${previousScore}/100 → ${candidateScore}/100`
          + `, số lỗi ${previousIssueCount} → ${candidateIssueCount}. Tool vẫn import theo quyết định của user.`
          + (newIssues ? ` ${newIssues}` : "")
        );
      }
      if (viralPreflight?.issues?.length) {
        script.warnings.push(
          `Viral readiness ${viralPreflight.score}/100 (${viralPreflight.grade}): ${viralPreflight.issues.join(" ")}`
        );
      }
      const normalizedSegments = isStoryRecutWorkflow
        ? consolidateStoryRecutSegments(script.segments, { maxSourceGapSec: 4 })
        : script.segments;
      const consolidatedCount = script.segments.length - normalizedSegments.length;
      const filledSourceGapSec = normalizedSegments.reduce(
        (sum, segment) => sum + safeNumber(segment.filledSourceGapSec, 0),
        0
      );
      if (isStoryRecutWorkflow && consolidatedCount > 0) {
        script.warnings.push(
          `Story Recut đã hợp nhất ${consolidatedCount} ranh giới scene kỹ thuật thành ${normalizedSegments.length} khối truyện liên tục.`
          + (filledSourceGapSec > 0.01
            ? ` Tool giữ thêm ${filledSourceGapSec.toFixed(2)}s chuyển tiếp bên trong cùng sourceRun để tránh âm thanh và hình ảnh bị băm vụn.`
            : "")
        );
      }
      const segments = normalizedSegments.map((segment) => invalidateFastDraftMeasurement({ ...segment, variantId }));
      const totalDuration = Number(
        segments.reduce((sum, segment) => sum + safeNumber(segment.duration, 0), 0).toFixed(3)
      );
      const variant = {
        ...activeVariant,
        id: variantId,
        title: script.title,
        language: script.language,
        sourceLanguage: script.sourceLanguage,
        style: script.style,
        promptProfile: script.promptProfile || activeVariant.promptProfile || "",
        sourceNarratorPolicy: script.sourceNarratorPolicy || activeVariant.sourceNarratorPolicy || "",
        timelinePolicy: script.timelinePolicy || activeVariant.timelinePolicy || "",
        independentPromptOptions: script.independentPromptOptions || activeVariant.independentPromptOptions || null,
        storyContract: script.storyContract || activeVariant.storyContract || null,
        storyCompiler: script.storyCompiler || activeVariant.storyCompiler || null,
        narrativeContract: script.narrativeContract || activeVariant.narrativeContract || null,
        hookSelectionAudit: script.hookSelectionAudit || activeVariant.hookSelectionAudit || null,
        hookColdViewerTest: script.hookColdViewerTest || activeVariant.hookColdViewerTest || null,
        hookTransitionTest: script.hookTransitionTest || activeVariant.hookTransitionTest || null,
        narrationArc: script.narrationArc || activeVariant.narrationArc || null,
        actorIdentityMap: script.actorIdentityMap?.length ? script.actorIdentityMap : (activeVariant.actorIdentityMap || []),
        seriesMode: script.seriesMode || activeVariant.seriesMode || "",
        seriesId: script.seriesId || activeVariant.seriesId || "",
        partNumber: script.partNumber || activeVariant.partNumber || 0,
        partBadge: script.partBadge || activeVariant.partBadge || "",
        topHeader: script.topHeader || activeVariant.topHeader || "",
        onScreenElements: script.onScreenElements?.length ? script.onScreenElements : (activeVariant.onScreenElements || []),
        sharedHookEnabled: script.seriesMode ? script.sharedHookEnabled : (activeVariant.sharedHookEnabled !== false),
        interleavedAudioEnabled: script.seriesMode ? script.interleavedAudioEnabled : (activeVariant.interleavedAudioEnabled !== false),
        cinematicNarratorEnabled: script.seriesMode ? script.cinematicNarratorEnabled : (activeVariant.cinematicNarratorEnabled !== false),
        cliffhangerEnabled: script.seriesMode ? script.cliffhangerEnabled : (activeVariant.cliffhangerEnabled !== false),
        targetDurationMinSec: script.targetDurationMinSec || activeVariant.targetDurationMinSec || 0,
        targetDurationMaxSec: script.targetDurationMaxSec || activeVariant.targetDurationMaxSec || 0,
        seriesPacing: script.seriesPacing || activeVariant.seriesPacing || "",
        audioStrategy: safeText(scriptInput.audio_strategy || scriptInput.audioStrategy || activeVariant.audioStrategy || ""),
        voiceoverEnabled: scriptInput.voiceover_enabled !== false,
        storyBlueprint: scriptInput.story_blueprint || scriptInput.storyBlueprint || null,
        workflow: isStoryRecutWorkflow ? "story_recut" : activeVariant.workflow || "highlight_cut",
        scriptId: isStoryRecutWorkflow
          ? 0
          : project.analysisWorkflow === "vertex_auto_story" ? Number(scriptInput.scriptId || activeVariant.scriptId)
          : Number(viralPreflight?.metrics?.scriptId || activeVariant.scriptId || scriptInput.scriptId || 0),
        viralPreflight,
        viralRank: viralPreflight ? activeVariant.viralRank : undefined,
        revisionNumber: draftReviewArtifact
          ? reapplyCurrentReviewFile
            ? Math.max(1, safeNumber(activeVariant.revisionNumber, 1))
            : Math.max(1, safeNumber(activeVariant.revisionNumber, 1)) + 1
          : Math.max(1, safeNumber(activeVariant.revisionNumber, 1)),
        revisionLabel: draftReviewArtifact
          ? reapplyCurrentReviewFile
            ? `V${Math.max(1, safeNumber(activeVariant.revisionNumber, 1))} - Gemini Draft Review (recompiled)`
            : `V${Math.max(1, safeNumber(activeVariant.revisionNumber, 1)) + 1} - Gemini Draft Review`
          : activeVariant.revisionLabel || "V1",
        revisionHistory: draftReviewArtifact
          ? reapplyCurrentReviewFile
            ? activeVariant.revisionHistory || []
            : appendHighlightRevisionHistory(activeVariant)
          : activeVariant.revisionHistory || [],
        draftReview: draftReviewArtifact ? {
          artifactType: "gemini_draft_review",
          reviewedRevision: effectiveReviewedRevision || safeNumber(activeVariant.revisionNumber, 1),
          reviewTarget: draftReviewArtifact.reviewTarget || draftReviewArtifact.review_target || null,
          reviewBindingWarning,
          reviewDecision: safeText(draftReviewArtifact.reviewDecision || draftReviewArtifact.review_decision || "patch"),
          idealEditAudit: draftReviewArtifact.idealEditAudit || draftReviewArtifact.ideal_edit_audit || null,
          importedAt: now,
          sourcePath: jsonPath,
          ...(draftReviewArtifact.review || {})
        } : activeVariant.draftReview || null,
        totalDuration,
        requestedTotal: script.requestedTotal,
        warnings: reviewBindingWarning ? [...(script.warnings || []), reviewBindingWarning] : (script.warnings || []),
        sourceJsonPath: jsonPath,
        segments,
        artifacts: {
          ...clearFastDraftArtifacts(activeVariant.artifacts || {}),
          reviewedScriptJsonPath: jsonPath,
          draftReviewImportPath: draftReviewArtifact ? jsonPath : activeVariant.artifacts?.draftReviewImportPath || "",
          draftReviewImportHash: draftReviewArtifact ? artifactHash : activeVariant.artifacts?.draftReviewImportHash || ""
        }
      };
      let variants = (Array.isArray(project.analysis?.highlightVariants) && project.analysis.highlightVariants.length
        ? project.analysis.highlightVariants
        : [activeVariant]).map((item) => (item.id === variantId ? variant : item));
      if (isTwoPassGeminiWorkflow) {
        const ranked = rankManualGeminiVariants(variants);
        const rankById = new Map(ranked.map((item) => [item.id, item.viralRank]));
        variants = variants.map((item) => ({
          ...item,
          viralRank: rankById.get(item.id) || variants.length
        }));
      }
      const scriptPath = project.analysis?.artifacts?.highlightCutScriptPath || path.join(paths.analysisDir, "highlight-cut-script.json");
      const validationPath = path.join(paths.analysisDir, "highlight-cut-review-import-validation.json");
      const sceneManifestPath = path.join(paths.analysisDir, "scene-manifest.json");
      const sceneManifest = buildSceneManifest({ media, segments, mode: "highlight_cut" });
      await this.projectStore.writeJson(scriptPath, {
        variants,
        activeVariantId: variantId,
        title: script.title,
        language: script.language,
        style: script.style,
        totalDuration,
        requestedTotal: script.requestedTotal,
        importedReviewJsonPath: jsonPath,
        importedAt: now,
        segments
      });
      await this.projectStore.writeJson(sceneManifestPath, sceneManifest);
      await this.projectStore.writeJson(validationPath, {
        generatedAt: now,
        source: "gemini_review_rewrite",
        importedJsonPath: jsonPath,
        passed: true,
        warnings: script.warnings,
        viralPreflight,
        variantId,
        segmentCount: segments.length,
        sourceDuration: media.duration,
        outputDuration: totalDuration
      });
      const previousWarnings = Array.isArray(project.analysis?.warnings) ? project.analysis.warnings : [];
      const staleVariantWarnings = new Set(Array.isArray(activeVariant.warnings) ? activeVariant.warnings : []);
      const retainedWarnings = previousWarnings.filter((warning) => {
        const text = safeText(warning);
        return !staleVariantWarnings.has(warning)
          && !text.startsWith("Draft voice cảnh ")
          && !text.startsWith("Quality gate:")
          && !text.startsWith("Viral readiness ")
          && !text.startsWith("Story Recut đã hợp nhất ")
          && !text.startsWith("Đã import JSON Gemini sửa ");
      });
      const analysis = {
        ...(project.analysis || {}),
        mode: "highlight_cut",
        summary: draftReviewArtifact
          ? `Imported Gemini Draft Review revision V${variant.revisionNumber} from ${path.basename(jsonPath)}.`
          : `Imported Gemini reviewed Highlight script from ${path.basename(jsonPath)}.`,
        media,
        sceneManifest,
        scenes: buildHighlightScenes(segments),
        activeVariantId: variantId,
        highlightVariants: variants,
        segments,
        warnings: [
          ...retainedWarnings,
          ...script.warnings,
          draftReviewArtifact
            ? `Đã tạo Revision V${variant.revisionNumber} từ Gemini Draft Review. V${variant.revisionNumber - 1} vẫn được lưu để đối chiếu.`
            : "Đã import JSON Gemini sửa sau draft. Hãy render nháp nhanh lại để đo voice thật.",
          "Hãy render nháp nhanh lại để đo voice thật trước khi xuất."
        ],
        qualityGate: buildProjectQualityGate(segments, "highlight_cut"),
        kpi: {
          ...(project.analysis?.kpi || {}),
          variantCount: variants.length,
          sceneCount: segments.length,
          segmentCount: segments.length,
          voiceTotal: Number(segments.filter((segment) => segment.voiceoverText).reduce((sum, segment) => sum + segment.duration, 0).toFixed(1))
        },
        artifacts: {
          ...clearFastDraftArtifacts(project.analysis?.artifacts || {}),
          highlightCutScriptPath: scriptPath,
          sceneManifestPath,
          validationPath,
          reviewedScriptJsonPath: jsonPath
        }
      };
      await this.projectStore.writeJson(path.join(paths.analysisDir, "analysis.json"), analysis);
      return this.projectStore.updateProject(workspaceRoot, projectId, {
        storyScriptPath: jsonPath,
        artifacts: clearFastDraftArtifacts(project.artifacts || {}),
        analysis
      });
    }

    throw new Error("Import JSON đã review chỉ hỗ trợ Storytime và Highlight Cut.");
  }

  async renderSegmentVoice({ workspaceRoot, projectId, segmentIndex, settings, openOutput }) {
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const segments = project.analysis?.segments || [];
    const index = Number(segmentIndex || 0);
    const segment = segments[index];
    if (!segment) {
      throw new Error("Không tìm thấy đoạn cần tạo voice.");
    }
    const text = project.mode === "highlight_cut"
      ? getHighlightVoiceText(segment)
      : project.mode === "recap"
        ? (segment.narrationLine || segment.subtitleText || segment.text || "")
        : (segment.dubbingLine || segment.translatedText || segment.storyText || segment.text || "");
    if (!safeText(text)) {
      throw new Error(project.mode === "highlight_cut"
        ? "Đoạn Highlight này không có voice thuyết minh. Nó sẽ dùng âm gốc khi render."
        : "Đoạn này chưa có nội dung để tạo voice.");
    }
    const provider = project.voiceProvider || settings.defaultVoiceProvider || "edge_neural";
    const rawExt = audioExtensionForProvider(provider);
    const outputPath = path.join(paths.outputDir, `segment-${String(index + 1).padStart(4, "0")}-voice-test${rawExt}`);
    const durationSec = Math.max(0.3, safeNumber(segment.endSec, 0) - safeNumber(segment.startSec, 0) || safeNumber(segment.duration, 3));
    await this.synthesizeDubbingVoice({
      settings,
      project,
      text,
      outputPath,
      durationSec,
      voiceRenderOptions: getSegmentVoiceRenderOptions(segment)
    });
    await openOutput?.(outputPath);
    return {
      outputPath,
      segmentIndex: index,
      text,
      durationSec
    };
  }

  async renderStorytimeSegmentPreview({ workspaceRoot, projectId, segmentIndex, settings, openOutput }) {
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    if (project.mode !== "satisfying_storytime") {
      throw new Error("Render thử đoạn hiện chỉ hỗ trợ mode Oddly Satisfying Storytime.");
    }
    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const ffmpeg = new FfmpegService(settings);
    const segment = project.analysis?.segments?.[Number(segmentIndex || 0)];
    if (!segment) throw new Error("Không tìm thấy đoạn cần render thử.");
    const index = Number(segmentIndex || 0);
    const startSec = Math.max(0, Number(segment.startSec || 0));
    const durationSec = Math.max(0.3, Number(segment.endSec || startSec + 1) - startSec);
    const draftVoiceProvider = this.getFastDraftVoiceProvider(project, settings);
    const rawVoicePath = path.join(paths.audioDir, `preview-segment-${String(index + 1).padStart(4, "0")}${audioExtensionForProvider(draftVoiceProvider)}`);
    const fittedVoicePath = path.join(paths.audioDir, `preview-segment-${String(index + 1).padStart(4, "0")}.m4a`);
    const clipPath = path.join(paths.outputDir, `preview-segment-${String(index + 1).padStart(4, "0")}-clip.mp4`);
    const voicedPath = path.join(paths.outputDir, `preview-segment-${String(index + 1).padStart(4, "0")}-voiced.mp4`);
    const subtitlePath = path.join(paths.outputDir, `preview-segment-${String(index + 1).padStart(4, "0")}.srt`);
    const outputPath = path.join(paths.outputDir, `preview-segment-${String(index + 1).padStart(4, "0")}.mp4`);
    const text = segment.dubbingLine || segment.storyText || segment.text || "";
    if (!safeText(text)) throw new Error("Đoạn này chưa có text Storytime để render thử.");

    await this.synthesizeFastDraftVoice({ project, settings, text, outputPath: rawVoicePath });
    const rawVoiceMeta = await ffmpeg.probeAudio(rawVoicePath).catch(() => ({ duration: estimateSpeechSeconds(text) }));
    const renderDurationSec = getVoiceDrivenRenderDuration(durationSec, rawVoiceMeta.duration, true);
    await ffmpeg.fitDubbingClusterAudio({
      inputPath: rawVoicePath,
      outputPath: fittedVoicePath,
      targetDuration: renderDurationSec,
      maxStretchRatio: project.dubbingMaxSafeStretch || settings.dubbingMaxSafeStretch || 0.08,
      normalize: project.dubbingVoiceNormalize ?? settings.dubbingVoiceNormalize ?? true,
      allowTrim: false
    });
    await ffmpeg.extractVoiceDrivenClipWithAudio({
      sourcePath: project.sourceVideoPath,
      outputPath: clipPath,
      startSec,
      sourceDurationSec: durationSec,
      targetDurationSec: renderDurationSec,
      width: 540,
      preset: "ultrafast",
      crf: 32
    });
    await ffmpeg.mixVideoAudioWithVoice({
      videoPath: clipPath,
      voicePath: fittedVoicePath,
      outputPath: voicedPath,
      sourceVolume: Math.max(0, Number(project.mixer?.sourceVolume ?? 0) / 100),
      voiceVolume: Math.max(0.2, Number(project.mixer?.voiceVolume ?? 100) / 100),
      limiter: true
    });
    await this.projectStore.writeText(subtitlePath, buildSrt([{ startSec: 0, endSec: renderDurationSec, translatedText: segment.caption || text }], "translatedText"));
    await ffmpeg.copyMedia({ inputPath: voicedPath, outputPath });
    await openOutput?.(outputPath);
    return { outputPath, segmentIndex: index };
  }

  async renderHighlightSegmentPreview({ workspaceRoot, projectId, segmentIndex, settings, openOutput }) {
    let project = await this.projectStore.getProject(workspaceRoot, projectId);
    project = resolveEffectiveVideoEditProject(project);
    if (project.mode !== "highlight_cut") {
      throw new Error("Render thử đoạn Highlight chỉ hỗ trợ mode Highlight Cut.");
    }
    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const ffmpeg = new FfmpegService(settings);
    const index = Number(segmentIndex || 0);
    const segment = project.analysis?.segments?.[index];
    if (!segment) throw new Error("Không tìm thấy đoạn Highlight cần render thử.");

    const sourceStartSec = Math.max(0, Number(segment.sourceStartSec ?? segment.startSec ?? 0));
    const sourceEndSec = Math.max(sourceStartSec + 0.3, Number(segment.sourceEndSec ?? sourceStartSec + Number(segment.sourceDuration || segment.duration || 1)));
    const sourceDurationSec = sourceEndSec - sourceStartSec;
    const durationSec = Math.max(0.3, Number(segment.duration ?? (((segment.endSec || 0) - (segment.startSec || 0)) || sourceDurationSec)));
    const voiceText = getHighlightVoiceText(segment);
    const audioMode = getHighlightAudioMode(segment, Boolean(voiceText), project);

    const rawClipPath = path.join(paths.outputDir, `preview-highlight-${String(index + 1).padStart(4, "0")}-raw.mp4`);
    const rawVoicePath = path.join(paths.audioDir, `preview-highlight-${String(index + 1).padStart(4, "0")}${audioExtensionForProvider(project.voiceProvider || settings.defaultVoiceProvider || "edge_neural")}`);
    const fittedVoicePath = path.join(paths.audioDir, `preview-highlight-${String(index + 1).padStart(4, "0")}-fit.m4a`);
    const voicedPath = path.join(paths.outputDir, `preview-highlight-${String(index + 1).padStart(4, "0")}-voiced.mp4`);
    const finalPath = path.join(paths.outputDir, `preview-highlight-${String(index + 1).padStart(4, "0")}.mp4`);

    let clipForCaption = rawClipPath;
    let fit = null;
    let fitPolicy = null;
    let renderDurationSec = durationSec;
    if (voiceText) {
      await this.synthesizeDubbingVoice({
        settings,
        project,
        text: voiceText,
        outputPath: rawVoicePath,
        durationSec,
        voiceRenderOptions: getSegmentVoiceRenderOptions(segment)
      });
      const rawVoiceMeta = await ffmpeg.probeAudio(rawVoicePath).catch(() => ({ duration: estimateSpeechSeconds(voiceText) }));
      fitPolicy = resolveHighlightVoiceFit(segment, durationSec, rawVoiceMeta.duration);
      renderDurationSec = fitPolicy.renderDurationSec;
      fit = await ffmpeg.fitDubbingClusterAudio({
        inputPath: rawVoicePath,
        outputPath: fittedVoicePath,
        targetDuration: renderDurationSec,
        normalize: false,
        allowTrim: false,
        allowSlowDown: false,
        allowSpeedUp: true,
        maxStretchRatio: 0.08
      });
    }
    await ffmpeg.extractVoiceDrivenClipWithAudio({
      sourcePath: project.sourceVideoPath,
      outputPath: rawClipPath,
      startSec: sourceStartSec,
      sourceDurationSec,
      targetDurationSec: renderDurationSec,
      includeAudio: !voiceText || audioMode === "voiceover_with_ambient"
    });
    if (voiceText) {
      await ffmpeg.mixVideoAudioWithVoice({
        videoPath: rawClipPath,
        voicePath: fittedVoicePath,
        outputPath: voicedPath,
        sourceVolume: getHighlightAmbientVolume(segment, project),
        voiceVolume: Math.max(0.2, Number(project.mixer?.voiceVolume ?? 100) / 100),
        limiter: false
      });
      clipForCaption = voicedPath;
    }

    await ffmpeg.copyMedia({ inputPath: clipForCaption, outputPath: finalPath });

    await this.projectStore.writeJson(path.join(paths.outputDir, `preview-highlight-${String(index + 1).padStart(4, "0")}-audio-report.json`), {
      generatedAt: new Date().toISOString(),
      segmentIndex: index,
      audioMode,
      sourceAmbientVolume: getHighlightAmbientVolume(segment, project),
      sourceStartSec,
      sourceEndSec,
      sourceDurationSec,
      durationSec,
      playbackSpeed: Number((sourceDurationSec / Math.max(0.3, durationSec)).toFixed(4)),
      hasVoice: Boolean(voiceText),
      voiceFit: fitPolicy,
      rawVoicePath: voiceText ? rawVoicePath : "",
      fittedVoicePath: voiceText ? fittedVoicePath : "",
      fit,
      sourceNarratorReplaced: Boolean(segment.sourceNarratorDetected || segment.replaceSourceNarrator),
      sourceAudioRemoved: Boolean(voiceText)
    });
    await openOutput?.(finalPath);
    return { outputPath: finalPath, segmentIndex: index, audioMode, hasVoice: Boolean(voiceText) };
  }

  async buildAudioPlan({ workspaceRoot, projectId, settings }) {
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const segments = project.analysis?.segments || [];
    const provider = project.voiceProvider || settings.defaultVoiceProvider || "edge_neural";
    const extension = audioExtensionForProvider(provider);
    const items = [];

    for (const [index, segment] of segments.entries()) {
      const sourceStartSec = Math.max(0, Number(segment.sourceStartSec ?? segment.startSec ?? 0));
      const sourceEndSec = Math.max(sourceStartSec + 0.3, Number(segment.sourceEndSec ?? segment.endSec ?? sourceStartSec + Number(segment.sourceDuration || segment.duration || 1)));
      const sourceDurationSec = sourceEndSec - sourceStartSec;
      const durationSec = project.mode === "highlight_cut"
        ? Math.max(0.3, Number(segment.duration ?? (((segment.endSec || 0) - (segment.startSec || 0)) || sourceDurationSec)))
        : sourceDurationSec;
      const voiceText = project.mode === "highlight_cut"
        ? getHighlightVoiceText(segment)
        : (segment.dubbingLine || segment.storyText || segment.translatedText || segment.text || "");
      const outputPath = path.join(paths.audioDir, `audio-plan-${String(index + 1).padStart(4, "0")}${extension}`);
      const voiceRenderOptions = getSegmentVoiceRenderOptions(segment);
      const cache = voiceText ? getVoiceCacheInfo({ settings, project, text: voiceText, outputPath, voiceRenderOptions }) : null;
      const cacheHit = cache ? await fs.access(cache.cachePath).then(() => true).catch(() => false) : false;
      items.push({
        index,
        segmentNumber: index + 1,
        audioMode: getHighlightAudioMode(segment, Boolean(voiceText), project),
        durationSec: Number(durationSec.toFixed(3)),
        sourceDurationSec: Number(sourceDurationSec.toFixed(3)),
        playbackSpeed: Number((sourceDurationSec / Math.max(0.3, durationSec)).toFixed(4)),
        voiceText,
        characterCount: voiceText.length,
        estimatedSpeechSec: Number(estimateSpeechSeconds(voiceText).toFixed(3)),
        cacheHit,
        cacheKey: cache?.cacheKey || "",
        cachePath: cache?.cachePath || "",
        deliveryProfile: voiceRenderOptions.deliveryProfile,
        speechRateMultiplier: voiceRenderOptions.speechRateMultiplier,
        pauseAfterPhrase: voiceRenderOptions.pauseAfterPhrase,
        pauseDurationMs: voiceRenderOptions.pauseDurationMs
      });
    }

    const voiceItems = items.filter((item) => item.voiceText);
    const missingCacheItems = voiceItems.filter((item) => !item.cacheHit);
    const plan = {
      generatedAt: new Date().toISOString(),
      projectId,
      mode: project.mode,
      provider,
      voiceId: project.voiceId || settings.defaultVoiceId || "",
      cacheEnabled: settings.voiceCacheEnabled !== false,
      totalSegments: items.length,
      originalAudioSegments: items.filter((item) => !item.voiceText).length,
      voiceSegments: voiceItems.length,
      cachedVoiceSegments: voiceItems.filter((item) => item.cacheHit).length,
      newVoiceSegments: missingCacheItems.length,
      totalVoiceCharacters: voiceItems.reduce((sum, item) => sum + item.characterCount, 0),
      newVoiceCharacters: missingCacheItems.reduce((sum, item) => sum + item.characterCount, 0),
      items
    };
    const outputPath = path.join(paths.outputDir, "audio-plan.json");
    await this.projectStore.writeJson(outputPath, plan);
    return { ...plan, outputPath };
  }

  async buildStorytimeFastDraftPreviewSubtitles({ workspaceRoot, projectId, project, settings, onProgress }) {
    const analysis = project.analysis || {};
    const sourceSegments = Array.isArray(analysis.segments) ? analysis.segments : [];
    const subtitleSegments = sourceSegments.map((segment, index) => {
      const voiceText = safeText(segment.dubbingLine || segment.storyText || segment.text || segment.translatedText || "");
      const sourceHash = textHash(voiceText);
      const cachedVi = segment.previewSubtitleSourceHash === sourceHash
        && hasVietnameseDiacritics(segment.previewSubtitleVi)
        ? safeText(segment.previewSubtitleVi)
        : "";
      const voiceIsVietnamese = hasVietnameseDiacritics(voiceText);
      return {
        ...segment,
        id: segment.id || `draft_preview_${String(index + 1).padStart(4, "0")}`,
        text: voiceText,
        previewSubtitleVi: cachedVi || (voiceIsVietnamese ? voiceText : ""),
        previewSubtitleSourceHash: sourceHash
      };
    });
    const needsTranslation = subtitleSegments.filter((segment) => segment.text && !segment.previewSubtitleVi);

    if (!needsTranslation.length) {
      return subtitleSegments;
    }

    onProgress?.({
      projectId,
      step: "draft",
      percent: 86,
      message: "Đang tạo phụ đề tiếng Việt cho bản nháp xem trước"
    });

    let translatedSegments = [];
    try {
      translatedSegments = await translatePreviewSegmentsToVietnamese({
        settings,
        segments: needsTranslation.map((segment, index) => ({
          id: segment.id,
          index,
          startSec: segment.startSec,
          endSec: segment.endSec,
          text: segment.text
        })),
        sourceLanguage: "en",
        onProgress: (message) => onProgress?.({
          projectId,
          step: "draft",
          percent: 87,
          message
        })
      });
    } catch (error) {
      const warnings = [...(analysis.warnings || []), `Không dịch được phụ đề Việt cho fast draft: ${error.message}`];
      await this.projectStore.updateProject(workspaceRoot, projectId, {
        analysis: { ...analysis, warnings }
      }).catch(() => {});
      return subtitleSegments.map((segment) => ({
        ...segment,
        previewSubtitleVi: segment.previewSubtitleVi
          || safeText(segment.preview_vi || segment.previewVi || segment.subtitleVi || segment.captionVi || segment.viCaption || "")
      }));
    }

    let translatedById = new Map(translatedSegments.map((segment) => {
      const text = safeText(segment.previewSubtitleVi || segment.translatedText || segment.dubbingLine || segment.text || "");
      return [segment.id, hasVietnameseDiacritics(text) ? text : ""];
    }));
    let translatedCount = subtitleSegments.filter((segment) => translatedById.get(segment.id) || hasVietnameseDiacritics(segment.previewSubtitleVi || "")).length;
    if (translatedCount < needsTranslation.length && settings?.geminiApiKey && (settings?.aiProvider || settings?.defaultAiProvider) !== "gemini") {
      try {
        const geminiProvider = createAiProvider({ ...settings, aiProvider: "gemini" });
        const geminiTranslatedSegments = await geminiProvider.translatePreviewSubtitles({
          segments: needsTranslation.map((segment, index) => ({
            id: segment.id,
            index,
            startSec: segment.startSec,
            endSec: segment.endSec,
            text: segment.text
          })),
          sourceLanguage: project.targetLanguage || project.narrationLanguage || project.sourceLanguage || "auto"
        });
        translatedById = new Map(geminiTranslatedSegments.map((segment) => {
          const text = safeText(segment.previewSubtitleVi || segment.translatedText || segment.dubbingLine || segment.text || "");
          return [segment.id, hasVietnameseDiacritics(text) ? text : ""];
        }));
        translatedCount = subtitleSegments.filter((segment) => translatedById.get(segment.id) || hasVietnameseDiacritics(segment.previewSubtitleVi || "")).length;
      } catch (fallbackError) {
        const warnings = [...(analysis.warnings || []), `Gemini fallback không tạo được phụ đề preview tiếng Việt: ${fallbackError.message}`];
        await this.projectStore.updateProject(workspaceRoot, projectId, {
          analysis: { ...analysis, warnings }
        }).catch(() => {});
      }
    }
    const updatedSegments = sourceSegments.map((segment, index) => {
      const draftSegment = subtitleSegments[index] || {};
      const translated = translatedById.get(draftSegment.id) || "";
      return {
        ...segment,
        previewSubtitleVi: translated || draftSegment.previewSubtitleVi || "",
        previewSubtitleSourceHash: draftSegment.previewSubtitleSourceHash || textHash(draftSegment.text || "")
      };
    });
    translatedCount = updatedSegments.filter((segment) => hasVietnameseDiacritics(segment.previewSubtitleVi || "")).length;
    if (translatedCount < needsTranslation.length) {
      const warnings = [...(analysis.warnings || []), `Phụ đề preview tiếng Việt chỉ tạo được ${translatedCount}/${needsTranslation.length} đoạn. Kiểm tra AI provider nếu overlay còn thiếu.`];
      await this.projectStore.updateProject(workspaceRoot, projectId, {
        analysis: { ...analysis, warnings }
      }).catch(() => {});
    }
    const updatedAnalysis = {
      ...analysis,
      artifacts: {
        ...(analysis.artifacts || {}),
        fastDraftPreviewSubtitleLanguage: "vi"
      },
      segments: updatedSegments
    };
    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    await this.projectStore.writeJson(path.join(paths.analysisDir, "review-plan.json"), updatedAnalysis).catch(() => {});
    await this.projectStore.updateProject(workspaceRoot, projectId, { analysis: updatedAnalysis }).catch(() => {});

    return updatedSegments.map((segment, index) => ({
      ...(subtitleSegments[index] || segment),
      ...segment
    }));
  }

  async ensureHighlightPreviewTranscript({ workspaceRoot, projectId, project, settings, segments = [], onProgress }) {
    const analysis = project.analysis || {};
    const originalAudioSegments = segments.filter((segment) => (
      safeText(segment.audioMode || segment.audio_mode || "original_audio") === "original_audio"
    ));
    let subtitleSourceFingerprint = project.subtitleSourcePath || "";
    if (project.subtitleSourcePath) {
      try {
        const subtitleStat = await fs.stat(project.subtitleSourcePath);
        subtitleSourceFingerprint = `${project.subtitleSourcePath}:${subtitleStat.size}:${subtitleStat.mtimeMs}`;
      } catch (_error) {
        // The read step below will report a useful error if the subtitle disappeared.
      }
    }
    const selectionHash = project.subtitleSourcePath
      ? textHash(`highlight-preview-transcript-v4:srt:${subtitleSourceFingerprint}`)
      : textHash(`highlight-preview-transcript-v3:${JSON.stringify(originalAudioSegments.map((segment) => ({
        startSec: safeNumber(segment.sourceStartSec, segment.startSec),
        endSec: safeNumber(segment.sourceEndSec, segment.endSec)
      })))}`);
    const cachedSegments = Array.isArray(analysis.sourceTranscriptSegments)
      ? analysis.sourceTranscriptSegments
      : [];
    if (cachedSegments.length && analysis.highlightTranscriptSelectionHash === selectionHash) {
      return cachedSegments;
    }
    if (!project.subtitleSourcePath && (project.autoWhisper === false || !originalAudioSegments.length)) {
      return [];
    }

    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    let transcriptResult = { provider: "none", segments: [] };
    try {
      if (project.subtitleSourcePath) {
        onProgress?.({
          projectId,
          step: "draft",
          percent: 83,
          message: "Đang đọc SRT tiếng Anh cho phụ đề preview"
        });
        const transcriptSegments = normalizeRollingSubtitleCues(
          await this.readSubtitleSegments(project.subtitleSourcePath)
        );
        transcriptResult = {
          provider: "srt_file",
          subtitlePath: project.subtitleSourcePath,
          segments: transcriptSegments
        };
      } else {
        const ffmpeg = new FfmpegService(settings);
        const transcriptSegments = [];
        onProgress?.({
          projectId,
          step: "draft",
          percent: 83,
          message: `Đang trích ${originalAudioSegments.length} cảnh âm thanh gốc để tạo phụ đề preview`
        });
        for (const [index, segment] of originalAudioSegments.entries()) {
          const sourceStartSec = Math.max(0, safeNumber(segment.sourceStartSec, segment.startSec));
          const sourceEndSec = Math.max(sourceStartSec + 0.2, safeNumber(segment.sourceEndSec, segment.endSec));
          const durationSec = sourceEndSec - sourceStartSec;
          const clipPath = path.join(paths.tempDir, `highlight-preview-original-${String(index + 1).padStart(3, "0")}.wav`);
          await ffmpeg.run(ffmpeg.ffmpegPath, [
            "-y",
            "-ss",
            formatSeconds(sourceStartSec),
            "-t",
            formatSeconds(durationSec),
            "-i",
            project.sourceVideoPath,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            clipPath
          ], { captureStdout: false });
          onProgress?.({
            projectId,
            step: "draft",
            percent: 84,
            message: `Whisper đang nhận diện cảnh original_audio ${index + 1}/${originalAudioSegments.length}`
          });
          const clipTranscript = await this.transcribeWithWhisper({
            settings,
            audioPath: clipPath,
            outputDir: paths.analysisDir,
            sourceLanguage: project.sourceLanguage || "en",
            workspaceRoot,
            projectId,
            onProgress
          });
          for (const cue of clipTranscript.segments || []) {
            const localStartSec = Math.max(0, safeNumber(cue.startSec, 0));
            const localEndSec = Math.max(localStartSec + 0.05, safeNumber(cue.endSec, localStartSec + 0.05));
            if (localStartSec >= durationSec) continue;
            transcriptSegments.push({
              ...cue,
              startSec: sourceStartSec + Math.min(localStartSec, durationSec),
              endSec: sourceStartSec + Math.min(localEndSec, durationSec)
            });
          }
        }
        transcriptResult = {
          provider: "whisper_per_source_segment",
          segments: transcriptSegments
        };
      }
    } catch (error) {
      const warnings = [
        ...(analysis.warnings || []),
        `Không nhận diện được lời thoại gốc cho phụ đề preview Highlight: ${error.message}`
      ];
      await this.projectStore.updateProject(workspaceRoot, projectId, {
        analysis: { ...analysis, warnings }
      }).catch(() => {});
      return [];
    }

    const sourceTranscriptSegments = Array.isArray(transcriptResult.segments)
      ? transcriptResult.segments
      : [];
    const transcriptPath = path.join(paths.analysisDir, "highlight-source-transcript.json");
    await this.projectStore.writeJson(transcriptPath, {
      generatedAt: new Date().toISOString(),
      provider: transcriptResult.provider || "unknown",
      subtitlePath: transcriptResult.subtitlePath || "",
      selectionHash,
      segments: sourceTranscriptSegments
    }).catch(() => {});
    await this.projectStore.updateProject(workspaceRoot, projectId, {
      analysis: {
        ...analysis,
        sourceTranscriptSegments,
        highlightTranscriptSelectionHash: selectionHash,
        artifacts: {
          ...(analysis.artifacts || {}),
          highlightSourceTranscriptPath: transcriptPath
        }
      }
    }).catch(() => {});
    return sourceTranscriptSegments;
  }

  async buildHighlightDraftVoiceTranscript({ workspaceRoot, projectId, project, settings, draftVoiceReports = [], onProgress }) {
    const reports = draftVoiceReports.filter((report) => report?.fittedVoicePath && report?.renderedText);
    if (!reports.length) return new Map();
    if (project.autoStoryPipelineVersion === "editorial-v1") {
      // TTS text is known. Phrase timing is proportional within the measured audio, not word-level alignment.
      return new Map(reports.map(report => [report.index, buildTimedSubtitlePhrases({
        id: `auto-story-voice-${report.index}`, text: report.renderedText, startSec: 0, endSec: report.timelineSec
      })]));
    }
    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const selectionHash = textHash(`highlight-draft-voice-transcript-v2:${JSON.stringify(reports.map((report) => ({
      index: report.index,
      textHash: report.textHash,
      timelineSec: report.timelineSec,
      rawVoiceSec: report.rawVoiceSec,
      voiceProfileKey: report.voiceProfileKey
    })))}`);
    const cachePath = path.join(paths.analysisDir, `highlight-draft-voice-transcript-${selectionHash}.json`);
    try {
      const cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
      if (Array.isArray(cached?.entries)) {
        return new Map(cached.entries.map((entry) => [entry.index, entry.cues || []]));
      }
    } catch (_error) {
      // Generate a fresh alignment reel below.
    }

    const ffmpeg = new FfmpegService(settings);
    const silenceSec = 0.45;
    const silencePath = path.join(paths.tempDir, `highlight-draft-voice-gap-${selectionHash}.m4a`);
    const reelPath = path.join(paths.tempDir, `highlight-draft-voice-alignment-${selectionHash}.m4a`);
    await this.createSilentAudio(ffmpeg, silencePath, silenceSec);
    const audioPieces = [];
    const entries = [];
    let reelCursor = 0;
    for (const [position, report] of reports.entries()) {
      const durationSec = Math.max(0.2, safeNumber(report.timelineSec, safeNumber(report.rawVoiceSec, 0.2)));
      entries.push({
        index: report.index,
        reelStartSec: reelCursor,
        reelEndSec: reelCursor + durationSec,
        renderedText: safeText(report.renderedText)
      });
      audioPieces.push(report.fittedVoicePath);
      reelCursor += durationSec;
      if (position < reports.length - 1) {
        audioPieces.push(silencePath);
        reelCursor += silenceSec;
      }
    }
    await ffmpeg.concatAudioSegments(audioPieces, reelPath);
    onProgress?.({
      projectId,
      step: "draft",
      percent: 85,
      message: "Đang căn phụ đề theo voice đã render"
    });

    const transcript = await this.transcribeWithWhisper({
      settings,
      audioPath: reelPath,
      outputDir: paths.analysisDir,
      sourceLanguage: inferFastDraftLanguage(reports.map((report) => report.renderedText).join(" "), project),
      workspaceRoot,
      projectId,
      onProgress
    });
    let wordTimestampPayload = null;
    try {
      wordTimestampPayload = JSON.parse(await fs.readFile(transcript.wordTimestampsPath, "utf8"));
    } catch (_error) {
      // Exact rendered text remains the authoritative fallback for every voice segment.
    }
    const mappedEntries = buildDraftVoiceTranscriptEntries({ entries, wordTimestampPayload });
    await this.projectStore.writeJson(cachePath, {
      generatedAt: new Date().toISOString(),
      selectionHash,
      entries: mappedEntries
    }).catch(() => {});
    return new Map(mappedEntries.map((entry) => [entry.index, entry.cues]));
  }

  async buildHighlightFastDraftPreviewSubtitles({ workspaceRoot, projectId, project, settings, segments, draftVoiceReports = [], onProgress }) {
    const analysis = project.analysis || {};
    const sourceSegments = Array.isArray(segments) ? segments : [];
    const needsOriginalAudioTranscript = sourceSegments.some((segment) => (
      safeText(segment.audioMode || segment.audio_mode || "original_audio") === "original_audio"
    ));
    const sourceTranscriptSegments = needsOriginalAudioTranscript
      ? await this.ensureHighlightPreviewTranscript({
        workspaceRoot,
        projectId,
        project,
        settings,
        segments: sourceSegments,
        onProgress
      })
      : [];
    let voiceTranscriptByIndex = new Map();
    try {
      voiceTranscriptByIndex = await this.buildHighlightDraftVoiceTranscript({
        workspaceRoot,
        projectId,
        project,
        settings,
        draftVoiceReports,
        onProgress
      });
    } catch (error) {
      const warnings = [...(analysis.warnings || []), `Không căn được phụ đề theo voice thật; đang dùng mốc câu dự phòng: ${error.message}`];
      await this.projectStore.updateProject(workspaceRoot, projectId, {
        analysis: { ...analysis, warnings }
      }).catch(() => {});
    }
    let cursor = 0;
    const subtitleSegments = sourceSegments.map((segment, index) => {
      const durationSec = Math.max(
        0.3,
        safeNumber(
          draftVoiceReports[index]?.timelineSec,
          safeNumber(segment.duration, safeNumber(segment.sourceEndSec, 0) - safeNumber(segment.sourceStartSec, 0))
        )
      );
      const startSec = cursor;
      const endSec = startSec + durationSec;
      cursor = endSec;
      const segmentId = segment.id || `highlight_preview_${String(index + 1).padStart(4, "0")}`;
      const subtitleCueId = `${segmentId}__timeline_${String(index + 1).padStart(4, "0")}`;
      const audioMode = safeText(segment.audioMode || segment.audio_mode || "original_audio");
      const sourceStartSec = safeNumber(segment.sourceStartSec, segment.startSec);
      const sourceEndSec = safeNumber(segment.sourceEndSec, segment.endSec);
      const sourceDurationSec = Math.max(0.2, sourceEndSec - sourceStartSec);
      const playbackSpeed = sourceDurationSec / durationSec;
      let originalAudioCues = audioMode === "original_audio"
        ? sourceTranscriptSegments
          .filter((cue) => safeNumber(cue.startSec, 0) < sourceEndSec && safeNumber(cue.endSec, 0) > sourceStartSec)
          .map((cue, cueIndex) => {
            const clippedStart = Math.max(sourceStartSec, safeNumber(cue.startSec, sourceStartSec));
            const clippedEnd = Math.min(sourceEndSec, safeNumber(cue.endSec, sourceEndSec));
            const cueText = safeText(cue.text || cue.originalText || "");
            return {
              id: `${subtitleCueId}__original_${String(cueIndex + 1).padStart(3, "0")}`,
              startSec: startSec + ((clippedStart - sourceStartSec) / playbackSpeed),
              endSec: startSec + ((clippedEnd - sourceStartSec) / playbackSpeed),
              text: cueText,
              previewSubtitleVi: hasVietnameseDiacritics(cueText) ? cueText : ""
            };
          })
          .filter((cue) => cue.text && cue.endSec > cue.startSec)
        : [];
      const geminiTranscriptCandidate = audioMode === "original_audio"
        ? getOriginalAudioTranscriptCandidate(segment)
        : "";
      if (!project.subtitleSourcePath && shouldUseOriginalAudioTranscriptCandidate({
        cues: originalAudioCues,
        candidateText: geminiTranscriptCandidate,
        startSec,
        endSec
      })) {
        originalAudioCues = buildTimedSubtitlePhrases({
          id: `${subtitleCueId}__gemini_source`,
          text: geminiTranscriptCandidate,
          startSec,
          endSec
        }).map((cue) => ({ ...cue, subtitleSource: "gemini_original_audio_transcript" }));
      }
      const originalAudioText = originalAudioCues.map((cue) => cue.text).join(" ");
      const voiceText = safeText(
        getHighlightVoiceText(segment)
        || originalAudioText
        || segment.caption
        || segment.translatedText
        || segment.text
        || ""
      );
      const sourceHash = textHash(voiceText);
      const reviewedSubtitle = project.autoStoryPipelineVersion === "editorial-v1"
        ? (project.autoStoryPreviewSubtitleRepairs || []).find(item => item.segmentId === segmentId
          && Number(item.scriptId) === Number((analysis.highlightVariants || []).find(v => v.id === analysis.activeVariantId)?.scriptId)
          && item.audioMode === audioMode && Math.abs(item.sourceStartSec - sourceStartSec) < 0.001
          && Math.abs(item.sourceEndSec - sourceEndSec) < 0.001
          && (audioMode === "original_audio" || item.voiceText === voiceText) && item.correctedVi?.trim()) : null;
      if (reviewedSubtitle) return { ...segment, id: segmentId, startSec, endSec, text: voiceText,
        previewSubtitleVi: reviewedSubtitle.correctedVi, previewSubtitleSourceHash: sourceHash,
        previewSubtitleCues: buildTimedSubtitlePhrases({ id: subtitleCueId, text: reviewedSubtitle.correctedVi, startSec, endSec })
          .map(cue => ({ ...cue, previewSubtitleVi: cue.text, subtitleSource: "reviewed_preview_translation" })) };
      const autoStoryVi = project.autoStoryPipelineVersion === "editorial-v1" && audioMode !== "original_audio"
        ? (project.autoStoryNarrationTranslations || []).find(item => item.text === voiceText)?.vi : "";
      const trustedVi = hasVietnameseDiacritics(autoStoryVi) ? autoStoryVi : "";
      const cachedVi = segment.previewSubtitleSourceHash === sourceHash
        && hasVietnameseDiacritics(segment.previewSubtitleVi)
        ? safeText(segment.previewSubtitleVi)
        : "";
      const voiceIsVietnamese = hasVietnameseDiacritics(voiceText);
      const alignedVoiceCues = audioMode !== "original_audio" && voiceText
        ? (voiceTranscriptByIndex.get(index) || []).map((cue, cueIndex) => ({
          ...cue,
          id: `${subtitleCueId}__voice_${String(cueIndex + 1).padStart(3, "0")}`,
          startSec: startSec + Math.max(0, safeNumber(cue.startSec, 0)),
          endSec: startSec + Math.min(durationSec, safeNumber(cue.endSec, durationSec)),
          previewSubtitleVi: hasVietnameseDiacritics(cue.text) ? cue.text : ""
        }))
        : [];
      const voiceSubtitleCues = audioMode !== "original_audio" && voiceText
        ? (trustedVi ? buildTimedSubtitlePhrases({ id: subtitleCueId, text: trustedVi, startSec, endSec }) : alignedVoiceCues.length
          ? alignedVoiceCues
          : buildTimedSubtitlePhrases({ id: subtitleCueId, text: voiceText, startSec, endSec }))
        : [];
      return {
        ...segment,
        id: segmentId,
        startSec,
        endSec,
        text: voiceText,
        previewSubtitleVi: trustedVi || cachedVi || (voiceIsVietnamese ? voiceText : ""),
        previewSubtitleSourceHash: sourceHash,
        previewSubtitleCues: originalAudioCues.length ? originalAudioCues : voiceSubtitleCues
      };
    });
    const translationItems = subtitleSegments.flatMap((segment) => (
      segment.previewSubtitleCues?.length ? segment.previewSubtitleCues : [segment]
    ));
    const needsTranslation = translationItems.filter((item) => item.text && !item.previewSubtitleVi);

    if (!needsTranslation.length) {
      return subtitleSegments;
    }

    onProgress?.({
      projectId,
      step: "draft",
      percent: 86,
      message: "Đang tạo phụ đề tiếng Việt cho bản nháp Highlight"
    });

    let translatedSegments = [];
    try {
      translatedSegments = await translatePreviewSegmentsToVietnamese({
        settings,
        segments: needsTranslation.map((item, index) => ({
          id: item.id,
          index,
          startSec: item.startSec,
          endSec: item.endSec,
          text: item.text
        })),
        sourceLanguage: "en",
        onProgress: (message) => onProgress?.({
          projectId,
          step: "draft",
          percent: 87,
          message
        })
      });
    } catch (error) {
      const warnings = [...(analysis.warnings || []), `Không dịch được phụ đề Việt cho Highlight fast draft: ${error.message}`];
      await this.projectStore.updateProject(workspaceRoot, projectId, {
        analysis: { ...analysis, warnings }
      }).catch(() => {});
      return subtitleSegments.map((segment) => ({
        ...segment,
        previewSubtitleVi: segment.previewSubtitleVi
          || safeText(segment.preview_vi || segment.previewVi || segment.subtitleVi || segment.captionVi || segment.viCaption || ""),
        previewSubtitleCues: (segment.previewSubtitleCues || []).map((cue) => ({
          ...cue,
          previewSubtitleVi: cue.previewSubtitleVi || ""
        }))
      }));
    }

    const translatedById = new Map(translatedSegments.map((segment) => {
      const translated = safeText(segment.previewSubtitleVi || segment.translatedText || segment.dubbingLine || "");
      return [segment.id, hasVietnameseDiacritics(translated) ? translated : ""];
    }));
    return subtitleSegments.map((segment) => {
      const previewSubtitleCues = (segment.previewSubtitleCues || []).map((cue) => ({
        ...cue,
        previewSubtitleVi: translatedById.get(cue.id) || cue.previewSubtitleVi || ""
      }));
      const translatedText = previewSubtitleCues.length
        ? previewSubtitleCues.map((cue) => cue.previewSubtitleVi).filter(Boolean).join(" ")
        : translatedById.get(segment.id);
      return {
        ...segment,
        previewSubtitleVi: translatedText || segment.previewSubtitleVi || "",
        previewSubtitleSourceHash: segment.previewSubtitleSourceHash || textHash(segment.text || ""),
        previewSubtitleCues
      };
    });
  }

  async renderHighlightFastDraft({ workspaceRoot, projectId, settings, onProgress, project: suppliedProject = null }) {
    let project = suppliedProject || await this.projectStore.getProject(workspaceRoot, projectId);
    project = resolveEffectiveVideoEditProject(project);
    if (project.mode !== "highlight_cut") {
      throw new Error("Render nháp nhanh Highlight chỉ hỗ trợ mode Highlight Cut.");
    }
    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const ffmpeg = new FfmpegService(settings);
    const autoStorySourceStat = project.analysisWorkflow === "vertex_auto_story" ? await fs.stat(project.sourceVideoPath) : null;
    const activeVariant = getActiveHighlightVariant(project);
    const variantId = activeVariant.id || "variant_01";
    const variantMetadata = resolveVariantFileMetadata(project, activeVariant);
    const variantSuffix = variantMetadata.fileTag;
    const segments = activeVariant.segments?.length ? activeVariant.segments : project.analysis?.segments || [];
    if (!segments.length) {
      throw new Error("Chưa có Highlight Cut JSON để render nháp.");
    }

    const draftStamp = Date.now();
    const outputPath = path.join(paths.outputDir, `highlight-cut-${variantSuffix}-fast-draft-${draftStamp}.mp4`);
    const undecoratedOutputPath = path.join(paths.tempDir, `highlight-cut-${variantSuffix}-fast-draft-${draftStamp}-base.mp4`);
    const decoratedOutputPath = path.join(paths.tempDir, `highlight-cut-${variantSuffix}-fast-draft-${draftStamp}-decorated.mp4`);
    const subtitlePath = path.join(paths.outputDir, `highlight-cut-${variantSuffix}-fast-draft-${draftStamp}.vi.srt`);
    const voiceWarningReportPath = path.join(paths.outputDir, `highlight-cut-${variantSuffix}-fast-draft-${draftStamp}-voice-warnings.json`);
    const geminiRewritePromptPath = path.join(paths.outputDir, `highlight-cut-${variantSuffix}-fast-draft-${draftStamp}-gemini-rewrite-prompt.txt`);
    const clipPaths = [];
    const draftVoiceReports = [];
    const draftVoiceProvider = this.getFastDraftVoiceProvider(project, settings);
    const draftVoiceExt = audioExtensionForProvider(draftVoiceProvider);
    const blockRuns = new Map(narratedBlockRuns(segments).map((run) => [run.start, run]));
    const blockVoiceReports = [];
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      const blockRun = blockRuns.get(index);
      if (blockRun) {
        // AutoStory V5: narrated_story delivery block — ONE narration passage,
        // synthesized once, fitted once, mixed and ducked once across all of the
        // block's visual cuts. Visual durations stay exactly the EDL's.
        onProgress?.({ projectId, step: "draft", percent: Math.min(82, 10 + Math.round((index / Math.max(1, segments.length)) * 68)),
          message: `Đang render khối narrator ${blockRun.blockId} (${blockRun.end - blockRun.start + 1} cảnh)` });
        const block = await this.renderNarratedDeliveryBlock({
          ffmpeg, project, settings, workspaceRoot, paths, variantSuffix, draftVoiceProvider, draftVoiceExt, autoStorySourceStat,
          members: segments.slice(blockRun.start, blockRun.end + 1), startIndex: blockRun.start
        });
        clipPaths.push(block.clipPath);
        blockVoiceReports.push(block.report);
        block.memberReports.forEach((report, offset) => { draftVoiceReports[blockRun.start + offset] = report; });
        index = blockRun.end;
        continue;
      }
      const sourceStartSec = Math.max(0, Number(segment.sourceStartSec ?? segment.startSec ?? 0));
      const sourceEndSec = Math.max(sourceStartSec + 0.3, Number(segment.sourceEndSec ?? sourceStartSec + Number(segment.sourceDuration || segment.duration || 1)));
      const sourceDurationSec = sourceEndSec - sourceStartSec;
      const durationSec = Math.max(0.3, Number(segment.duration ?? (((segment.endSec || 0) - (segment.startSec || 0)) || sourceDurationSec)));
      const voiceText = getHighlightVoiceText(segment);
      const audioMode = getHighlightAudioMode(segment, Boolean(voiceText), project);
      const rawClipPath = path.join(paths.clipsDir, `draft-highlight-${variantSuffix}-${String(index + 1).padStart(4, "0")}-raw.mp4`);
      const normalizedClipPath = path.join(paths.clipsDir, `draft-highlight-${variantSuffix}-${String(index + 1).padStart(4, "0")}-normalized.mp4`);
      const voicedClipPath = path.join(paths.clipsDir, `draft-highlight-${variantSuffix}-${String(index + 1).padStart(4, "0")}-voiced.mp4`);
      const rawVoicePath = path.join(paths.audioDir, `draft-highlight-${variantSuffix}-${String(index + 1).padStart(4, "0")}${draftVoiceExt}`);
      const fittedVoicePath = path.join(paths.audioDir, `draft-highlight-${variantSuffix}-${String(index + 1).padStart(4, "0")}.m4a`);

      onProgress?.({
        projectId,
        step: "draft",
        percent: Math.min(82, 10 + Math.round((index / Math.max(1, segments.length)) * 68)),
        message: `Đang render nháp Highlight ${index + 1}/${segments.length}`
      });
      let rawVoiceMeta = null;
      let voiceProfile = null;
      let fitPolicy = null;
      let renderDurationSec = durationSec;
      if (voiceText) {
        await this.synthesizeFastDraftVoice({
          project,
          settings,
          text: voiceText,
          outputPath: rawVoicePath,
          voiceRenderOptions: getSegmentVoiceRenderOptions(segment)
        });
        rawVoiceMeta = await ffmpeg.probeAudio(rawVoicePath).catch(() => ({ duration: estimateSpeechSeconds(voiceText) }));
        fitPolicy = resolveHighlightVoiceFit(segment, durationSec, rawVoiceMeta.duration);
        renderDurationSec = fitPolicy.renderDurationSec;
        voiceProfile = await this.recordVoiceProfileSample({
          workspaceRoot,
          settings,
          project,
          text: voiceText,
          measuredDurationSec: rawVoiceMeta.duration,
          segmentDurationSec: renderDurationSec,
          source: "highlight_fast_draft",
          providerOverride: draftVoiceProvider
        });
      }
      let autoClipCache = null;
      if (autoStorySourceStat) {
        const key = crypto.createHash("sha256").update(JSON.stringify({
          version: 1, source: project.sourceVideoPath, size: autoStorySourceStat.size, modified: autoStorySourceStat.mtimeMs,
          sourceStartSec, sourceDurationSec, durationSec, renderDurationSec, audioMode,
          voice: voiceText ? getVoiceCacheInfo({ settings, project, text: voiceText, outputPath: rawVoicePath, voiceRenderOptions: getSegmentVoiceRenderOptions(segment) }).spec : null,
          sourceVolume: getHighlightAmbientVolume(segment, project), voiceVolume: project.mixer?.voiceVolume ?? 100,
          normalize: project.dubbingVoiceNormalize ?? settings.dubbingVoiceNormalize ?? true,
          stretch: project.dubbingMaxSafeStretch || settings.dubbingMaxSafeStretch || 0.08
        })).digest("hex");
        const cacheDir = path.join(paths.clipsDir, ".auto-story-cache");
        await fs.mkdir(cacheDir, { recursive: true });
        autoClipCache = { clip: path.join(cacheDir, `${key}.mp4`), report: path.join(cacheDir, `${key}.json`), voice: path.join(cacheDir, `${key}.m4a`) };
        try {
          const report = JSON.parse(await fs.readFile(autoClipCache.report, "utf8"));
          const clipStat = await fs.stat(autoClipCache.clip);
          if (clipStat.size <= 512) throw new Error("invalid clip cache");
          if (voiceText) {
            await fs.access(autoClipCache.voice);
            draftVoiceReports[index] = { ...report, index, sceneId: segment.sceneId || segment.id, fittedVoicePath: autoClipCache.voice };
          }
          clipPaths.push(autoClipCache.clip);
          continue;
        } catch (_) { /* Render only the changed or missing source/voice clip. */ }
      }
      await ffmpeg.extractVoiceDrivenClipWithAudio({
        sourcePath: project.sourceVideoPath,
        outputPath: rawClipPath,
        startSec: sourceStartSec,
        sourceDurationSec,
        targetDurationSec: renderDurationSec,
        width: 540,
        preset: "ultrafast",
        crf: 32,
        includeAudio: !voiceText || audioMode === "voiceover_with_ambient"
      });
      if (voiceText) {
        await (audioMode === "voiceover_with_ambient" ? ffmpeg.normalizeVideoKeepAudio.bind(ffmpeg) : ffmpeg.normalizeVideoOnlyDuration.bind(ffmpeg))({
          inputPath: rawClipPath,
          outputPath: normalizedClipPath,
          targetDuration: renderDurationSec
        });
      } else {
        await ffmpeg.normalizeMediaDuration({
          inputPath: rawClipPath,
          outputPath: normalizedClipPath,
          targetDuration: renderDurationSec
        });
      }

      if (voiceText) {
        await ffmpeg.fitDubbingClusterAudio({
          inputPath: rawVoicePath,
          outputPath: fittedVoicePath,
          targetDuration: renderDurationSec,
          maxStretchRatio: Math.min(0.08, project.dubbingMaxSafeStretch || settings.dubbingMaxSafeStretch || 0.08),
          normalize: project.dubbingVoiceNormalize ?? settings.dubbingVoiceNormalize ?? true,
          allowTrim: false,
          allowSlowDown: false,
          allowSpeedUp: true
        });
        await ffmpeg.mixVideoAudioWithVoice({
          videoPath: normalizedClipPath,
          voicePath: fittedVoicePath,
          outputPath: voicedClipPath,
          sourceVolume: getHighlightAmbientVolume(segment, project),
          voiceVolume: Math.max(0.2, Number(project.mixer?.voiceVolume ?? 100) / 100),
          limiter: true,
          // AutoStory v3 (Phase 13): sidechain-duck the source instead of a flat mix.
          duck: project.mixer?.narrationDuckDefault === true
        });
        draftVoiceReports[index] = {
          index,
          sceneId: segment.sceneId || segment.id,
          startSec: Number(sourceStartSec.toFixed(3)),
          endSec: Number(sourceEndSec.toFixed(3)),
          sourceDurationSec: Number(sourceDurationSec.toFixed(3)),
          requestedTimelineSec: Number(durationSec.toFixed(3)),
          timelineSec: Number(renderDurationSec.toFixed(3)),
          playbackSpeed: Number((sourceDurationSec / Math.max(0.3, renderDurationSec)).toFixed(4)),
          rawVoiceSec: Number(Number(rawVoiceMeta.duration || 0).toFixed(3)),
          fitRatio: Number((Number(rawVoiceMeta.duration || 0) / Math.max(0.3, renderDurationSec)).toFixed(3)),
          requestedFitRatio: Number((Number(rawVoiceMeta.duration || 0) / Math.max(0.3, durationSec)).toFixed(3)),
          visualFitStrategy: renderDurationSec > durationSec + 0.03 ? "distributed_slowdown_to_voice" : renderDurationSec < durationSec - 0.03 ? "cut_to_voice" : "as_requested",
          voiceFitStrategy: fitPolicy?.strategy || "as_requested",
          voiceFitWarning: describeHighlightVoiceFitWarning(index, fitPolicy),
          audioMode,
          sourceAmbientVolume: getHighlightAmbientVolume(segment, project),
          mode: "highlight_segment",
          renderedText: voiceText,
          textHash: textHash(voiceText),
          fittedVoicePath,
          voiceProfileKey: voiceProfile?.key || "",
          voiceProfileWordsPerSecond: voiceProfile?.wordsPerSecond || 0,
          voiceProfileSampleCount: voiceProfile?.sampleCount || 0,
          sourceNarratorReplaced: Boolean(segment.sourceNarratorDetected || segment.replaceSourceNarrator),
          sourceAudioRemoved: audioMode !== "voiceover_with_ambient"
        };
        clipPaths.push(voicedClipPath);
      } else {
        clipPaths.push(normalizedClipPath);
      }
      if (autoClipCache) {
        await fs.copyFile(clipPaths.at(-1), autoClipCache.clip);
        if (voiceText) await fs.copyFile(fittedVoicePath, autoClipCache.voice);
        await fs.writeFile(autoClipCache.report, JSON.stringify(draftVoiceReports[index] || {}));
      }
    }

    onProgress?.({ projectId, step: "draft", percent: 90, message: "Đang ghép bản nháp Highlight" });
    await ffmpeg.concatSegmentsByFilter(clipPaths, undecoratedOutputPath);
    if (project.sourceSubtitleMask?.enabled) {
      const mask = project.sourceSubtitleMask;
      onProgress?.({
        projectId,
        step: "draft",
        percent: 93,
        message: `Đang làm mờ vùng phụ đề X ${Number(mask.xPercent || 0).toFixed(1)}% · rộng ${Number(mask.widthPercent || 100).toFixed(1)}%`
      });
    }
    await this.applyProjectVideoDecoration({
      ffmpeg,
      project,
      paths,
      inputPath: undecoratedOutputPath,
      outputPath: decoratedOutputPath,
      name: `highlight-${variantSuffix}-draft`,
      draft: true
    });
    const previewSubtitleSegments = await this.buildHighlightFastDraftPreviewSubtitles({
      workspaceRoot,
      projectId,
      project,
      settings,
      segments,
      draftVoiceReports,
      onProgress
    });
    const previewSubtitleCues = previewSubtitleSegments.flatMap((segment) => (
      segment.previewSubtitleCues?.length
        ? segment.previewSubtitleCues.map((cue) => ({
          ...cue,
          translatedText: cue.previewSubtitleVi || ""
        }))
        : [{
          ...segment,
          translatedText: segment.previewSubtitleVi || ""
        }]
    ));
    await this.projectStore.writeText(subtitlePath, buildSrt(previewSubtitleCues, "translatedText"));
    const isTikTokKaraoke = project.videoDecoration?.subtitleStyle === "tiktok_karaoke";
    let effectiveSubtitlePath = subtitlePath;
    if (isTikTokKaraoke) {
      const assPath = subtitlePath.replace(/\.srt$/, ".ass");
      const karaokeCues = previewSubtitleSegments.flatMap((segment) => (
        segment.previewSubtitleCues?.length
          ? segment.previewSubtitleCues.map((cue) => ({
            ...cue,
            voiceover_text: cue.text || cue.translatedText || segment.voiceover_text || ""
          }))
          : [{
            ...segment,
            voiceover_text: segment.text || segment.voiceover_text || segment.caption || ""
          }]
      ));
      const words = buildWordTimestampsFromSegments(karaokeCues);
      const assContent = buildTikTokKaraokeAssContent(words);
      await this.projectStore.writeText(assPath, assContent);
      effectiveSubtitlePath = assPath;
    }
    const hasPreviewSubtitles = previewSubtitleCues.some((cue) => safeText(cue.translatedText));
    const embedPreviewSubtitles = (hasPreviewSubtitles && project.analysisWorkflow !== "vertex_auto_story") || isTikTokKaraoke;
    if (embedPreviewSubtitles) {
      onProgress?.({
        projectId,
        step: "draft",
        percent: 96,
        message: isTikTokKaraoke
          ? "Đang nhúng phụ đề TikTok Karaoke vào bản nháp"
          : "Đang nhúng phụ đề tiếng Việt vào bản nháp"
      });
      await ffmpeg.burnSubtitles({ videoPath: decoratedOutputPath, subtitlePath: effectiveSubtitlePath, outputPath });
    } else {
      await ffmpeg.copyMedia({ inputPath: decoratedOutputPath, outputPath });
    }
    const voiceAlignmentReport = buildDraftVoiceAlignmentReport({
      project,
      segments,
      draftVoiceReports
    });
    const resolvedTimeline = compileResolvedTimeline({
      mode: "highlight_cut",
      segments,
      voiceReports: voiceAlignmentReport.segments.map((item, index) => ({
        ...draftVoiceReports[index],
        ...item
      })),
      voiceDrivenVisuals: true,
      generatedAt: voiceAlignmentReport.generatedAt
    });
    const resolvedTimelinePath = path.join(paths.outputDir, `highlight-cut-${variantSuffix}-fast-draft-${draftStamp}-resolved-timeline.json`);
    const deliveryBlockReportPath = blockVoiceReports.length
      ? path.join(paths.outputDir, `highlight-cut-${variantSuffix}-fast-draft-${draftStamp}-delivery-blocks.json`) : "";
    const blockNarrationSubtitlePath = blockVoiceReports.length
      ? path.join(paths.outputDir, `highlight-cut-${variantSuffix}-fast-draft-${draftStamp}.narration.srt`) : "";
    if (blockVoiceReports.length) {
      const blockOutput = placeNarratedBlocks(segments, blockVoiceReports);
      await this.projectStore.writeJson(deliveryBlockReportPath, { contract: "continuous-narrated-blocks-v1", generatedAt: new Date().toISOString(), blocks: blockOutput }).catch(() => {});
      await this.projectStore.writeText(blockNarrationSubtitlePath, buildSrt(blockOutput.map((b) => ({
        startSec: b.outputStartSec, endSec: b.outputStartSec + Math.min(b.fittedTtsSec || b.rawTtsSec || b.durationSec, b.durationSec), text: b.narrationText
      })), "text")).catch(() => {});
    }
    await this.projectStore.writeJson(voiceWarningReportPath, voiceAlignmentReport).catch(() => {});
    await this.projectStore.writeJson(resolvedTimelinePath, resolvedTimeline).catch(() => {});
    await this.projectStore.writeText(geminiRewritePromptPath, voiceAlignmentReport.geminiPrompt || "").catch(() => {});
    const updatedSegments = segments.map((segment, index) => ({
      ...segment,
      previewSubtitleVi: previewSubtitleSegments[index]?.previewSubtitleVi || segment.previewSubtitleVi || "",
      previewSubtitleSourceHash: previewSubtitleSegments[index]?.previewSubtitleSourceHash || segment.previewSubtitleSourceHash || "",
      previewSubtitleCues: previewSubtitleSegments[index]?.previewSubtitleCues || segment.previewSubtitleCues || [],
      fastDraftVoiceSec: draftVoiceReports[index]?.rawVoiceSec ?? segment.fastDraftVoiceSec,
      fastDraftTimelineSec: voiceAlignmentReport.segments[index]?.plannedTimelineSec ?? segment.fastDraftTimelineSec,
      fastDraftResolvedTimelineSec: voiceAlignmentReport.segments[index]?.resolvedTimelineSec ?? segment.fastDraftResolvedTimelineSec,
      fastDraftFitRatio: voiceAlignmentReport.segments[index]?.coverageRatio ?? segment.fastDraftFitRatio,
      resolvedPreviewStartSec: resolvedTimeline.segments[index]?.resolved.startSec,
      resolvedPreviewEndSec: resolvedTimeline.segments[index]?.resolved.endSec,
      fastDraftTextHash: voiceAlignmentReport.segments[index]?.textHash || draftVoiceReports[index]?.textHash || segment.fastDraftTextHash || "",
      fastDraftMeasuredAt: voiceAlignmentReport.generatedAt,
      fastDraftVoiceMode: draftVoiceReports[index]?.mode || segment.fastDraftVoiceMode,
      fastDraftVoiceProfileKey: draftVoiceReports[index]?.voiceProfileKey || segment.fastDraftVoiceProfileKey || "",
      fastDraftVoiceProfileWordsPerSecond: draftVoiceReports[index]?.voiceProfileWordsPerSecond || segment.fastDraftVoiceProfileWordsPerSecond || 0,
      fastDraftVoiceProfileSampleCount: draftVoiceReports[index]?.voiceProfileSampleCount || segment.fastDraftVoiceProfileSampleCount || 0,
      fastDraftVoiceStatus: voiceAlignmentReport.segments[index]?.status || segment.fastDraftVoiceStatus,
      fastDraftVoiceWarning: !["ok", "not_applicable"].includes(voiceAlignmentReport.segments[index]?.status)
        ? voiceAlignmentReport.segments[index]?.problem
        : "",
      aiSceneReview: mergeDraftVoiceReview(segment, voiceAlignmentReport.segments[index])
    }));
    const qualityGate = buildProjectQualityGate(updatedSegments, "highlight_cut");
    const latestProject = await this.projectStore.getProject(workspaceRoot, projectId).catch(() => project);
    const publishedDraftPath = await publishDraftVideo({
      settings,
      project: latestProject,
      sourcePath: outputPath,
      mode: "highlight",
      variant: `${variantMetadata.fileTag}-${activeVariant.label || variantId}`
    });
    const variants = Array.isArray(latestProject.analysis?.highlightVariants) ? latestProject.analysis.highlightVariants : [];
    const previousWarnings = Array.isArray(latestProject.analysis?.warnings) ? latestProject.analysis.warnings : [];
    const retainedWarnings = previousWarnings.filter((warning) => {
      const text = safeText(warning);
      return !text.startsWith("Draft voice cảnh ") && !text.startsWith("Quality gate:");
    });
    const draftVoiceWarnings = voiceAlignmentReport.warnings.map((warning) => (
      `Draft voice cảnh ${warning.sceneNumber}: ${warning.problem} ${warning.recommendation}`
    ));
    const qualityGateWarnings = qualityGate.exportAllowed
      ? []
      : [`Quality gate: ${qualityGate.blockedCount}/${qualityGate.totalScenes} cảnh nên duyệt trước khi export. Tool vẫn cho phép export nếu user muốn.`];
    const autoStoryKey = project.analysisWorkflow === "vertex_auto_story"
      ? await autoStoryDraftKey(project, { ...activeVariant, segments: updatedSegments }, settings) : undefined;
    const updatedVariants = variants.map((variant) => variant.id === variantId ? {
      ...variant,
      segments: updatedSegments,
      draftReviewReadiness: buildDraftReviewReadiness(variant, voiceAlignmentReport),
      artifacts: {
        ...(variant.artifacts || {}),
        fastDraftVideoPath: publishedDraftPath,
        internalFastDraftVideoPath: outputPath,
        fastDraftBaseVideoPath: undecoratedOutputPath,
        fastDraftSubtitlePath: subtitlePath,
        fastDraftSubtitleLanguage: "vi",
        fastDraftSubtitlesEmbedded: embedPreviewSubtitles,
        fastDraftVoiceWarningReportPath: voiceWarningReportPath,
        fastDraftResolvedTimelinePath: resolvedTimelinePath,
        fastDraftGeminiRewritePromptPath: geminiRewritePromptPath,
        fastDraftDeliveryBlockReportPath: deliveryBlockReportPath,
        fastDraftBlockNarrationSubtitlePath: blockNarrationSubtitlePath,
        fastDraftRenderedAt: voiceAlignmentReport.generatedAt,
        autoStoryDraftKey: autoStoryKey
      }
    } : variant);
    await this.projectStore.updateProject(workspaceRoot, projectId, {
      artifacts: {
        ...(latestProject.artifacts || {}),
        previewVideoPath: publishedDraftPath,
        fastDraftVideoPath: publishedDraftPath,
        internalFastDraftVideoPath: outputPath,
        fastDraftBaseVideoPath: undecoratedOutputPath,
        fastDraftSubtitlePath: subtitlePath,
        fastDraftSubtitleLanguage: "vi",
        fastDraftSubtitlesArePreviewOnly: true,
        fastDraftSubtitlesEmbedded: embedPreviewSubtitles,
        fastDraftRenderedAt: voiceAlignmentReport.generatedAt,
        previewRenderedAt: voiceAlignmentReport.generatedAt
      },
      analysis: {
        ...(latestProject.analysis || {}),
        activeVariantId: variantId,
        qualityGate,
        warnings: [...retainedWarnings, ...draftVoiceWarnings, ...qualityGateWarnings],
        artifacts: {
          ...(latestProject.analysis?.artifacts || {}),
          fastDraftVoiceWarningReportPath: voiceWarningReportPath,
          fastDraftResolvedTimelinePath: resolvedTimelinePath,
          fastDraftGeminiRewritePromptPath: geminiRewritePromptPath
        },
        highlightVariants: updatedVariants.length ? updatedVariants : latestProject.analysis?.highlightVariants,
        segments: updatedSegments,
        scenes: buildHighlightScenes(updatedSegments)
      }
    }).catch(() => {});
    await pruneDraftArtifacts(paths.outputDir, `highlight-cut-${variantMetadata.variantTag}-`, 3).catch(() => {});
    return {
      outputPath: publishedDraftPath,
      internalOutputPath: outputPath,
      subtitlePath,
      variantId,
      previewSubtitleLanguage: "vi",
      previewOnly: true,
      voiceWarningCount: voiceAlignmentReport.warningCount,
      voiceWarningReportPath,
      resolvedTimelinePath,
      geminiRewritePromptPath,
      deliveryBlockReportPath,
      deliveryBlocks: blockVoiceReports
    };
  }

  // AutoStory V5 continuous block primitive. members = the consecutive segments
  // of ONE narrated_story delivery block (first member carries the passage).
  async renderNarratedDeliveryBlock({ ffmpeg, project, settings, workspaceRoot, paths, variantSuffix, draftVoiceProvider, draftVoiceExt, autoStorySourceStat, members, startIndex }) {
    const lead = members[0];
    const text = safeText(lead.blockNarrationText);
    if (!text) throw new Error(`Narrated block ${lead.deliveryBlockId} has no narration passage.`);
    const treatment = lead.blockSourceAudio === "voiceover_only" ? "voiceover_only" : "voiceover_with_ambient";
    const tag = `draft-highlight-${variantSuffix}-block-${String(startIndex + 1).padStart(4, "0")}`;
    const pieces = members.map((segment) => {
      const sourceStartSec = Math.max(0, Number(segment.sourceStartSec ?? segment.startSec ?? 0));
      const sourceEndSec = Math.max(sourceStartSec + 0.3, Number(segment.sourceEndSec ?? sourceStartSec + Number(segment.sourceDuration || segment.duration || 1)));
      const sourceDurationSec = sourceEndSec - sourceStartSec;
      // Exact EDL timing: a narrated block never retimes a visual beat.
      const durationSec = Math.max(0.3, Number(segment.duration ?? sourceDurationSec));
      return { segment, sourceStartSec, sourceEndSec, sourceDurationSec, durationSec };
    });
    const blockTimelineSec = pieces.reduce((sum, p) => sum + p.durationSec, 0);
    const ambientVolume = treatment === "voiceover_only" ? 0 : getBlockAmbientVolume(lead, project);
    const duck = project.mixer?.narrationDuckDefault === true;
    const voiceVolume = Math.max(0.2, Number(project.mixer?.voiceVolume ?? 100) / 100);
    const maxStretchRatio = Math.min(0.08, project.dubbingMaxSafeStretch || settings.dubbingMaxSafeStretch || 0.08);
    const voiceRenderOptions = getSegmentVoiceRenderOptions(lead);
    const rawVoicePath = path.join(paths.audioDir, `${tag}${draftVoiceExt}`);
    const fittedVoicePath = path.join(paths.audioDir, `${tag}.m4a`);
    const blockVideoPath = path.join(paths.clipsDir, `${tag}-video.mp4`);
    const timedBlockVideoPath = path.join(paths.clipsDir, `${tag}-video-timed.mp4`);
    const voicedClipPath = path.join(paths.clipsDir, `${tag}-voiced.mp4`);
    const durationFixedClipPath = path.join(paths.clipsDir, `${tag}-voiced-timed.mp4`);

    let cache = null;
    if (autoStorySourceStat) {
      const key = crypto.createHash("sha256").update(JSON.stringify({
        version: 2, kind: "narrated_block", source: project.sourceVideoPath, size: autoStorySourceStat.size, modified: autoStorySourceStat.mtimeMs,
        pieces: pieces.map((p) => [p.sourceStartSec, p.sourceDurationSec, p.durationSec]), treatment, ambientVolume, duck, voiceVolume, maxStretchRatio,
        voice: getVoiceCacheInfo({ settings, project, text, outputPath: rawVoicePath, voiceRenderOptions }).spec,
        normalize: project.dubbingVoiceNormalize ?? settings.dubbingVoiceNormalize ?? true
      })).digest("hex");
      const cacheDir = path.join(paths.clipsDir, ".auto-story-cache");
      await fs.mkdir(cacheDir, { recursive: true });
      cache = { clip: path.join(cacheDir, `${key}.mp4`), report: path.join(cacheDir, `${key}.json`) };
      try {
        const cached = JSON.parse(await fs.readFile(cache.report, "utf8"));
        if ((await fs.stat(cache.clip)).size > 512 && cached?.blockId === lead.deliveryBlockId) {
          return { clipPath: cache.clip, report: { ...cached, cached: true }, memberReports: memberReportsFor(pieces, cached) };
        }
      } catch (_) { /* render */ }
    }

    // 1-4. Extract + normalize every visual range exactly as the per-segment path
    // does, keeping (or silencing) the source audio, then concat into ONE block video.
    const piecePaths = [];
    for (const [offset, p] of pieces.entries()) {
      const rawClipPath = path.join(paths.clipsDir, `${tag}-${String(offset + 1).padStart(2, "0")}-raw.mp4`);
      const normalizedClipPath = path.join(paths.clipsDir, `${tag}-${String(offset + 1).padStart(2, "0")}-normalized.mp4`);
      await ffmpeg.extractVoiceDrivenClipWithAudio({
        sourcePath: project.sourceVideoPath, outputPath: rawClipPath, startSec: p.sourceStartSec, sourceDurationSec: p.sourceDurationSec,
        targetDurationSec: p.durationSec, width: 540, preset: "ultrafast", crf: 32, includeAudio: treatment === "voiceover_with_ambient"
      });
      // Narrated-block pieces must carry a full-length ambient bed. The older
      // keep-audio helper stream-copies audio and can become shorter than the
      // visual range on Windows/AAC packet boundaries. normalizeMediaDuration
      // pads/trims BOTH streams to the exact EDL piece duration.
      await ffmpeg.normalizeMediaDuration({ inputPath: rawClipPath, outputPath: normalizedClipPath, targetDuration: p.durationSec });
      piecePaths.push(normalizedClipPath);
    }
    await ffmpeg.concatSegmentsByFilter(piecePaths, blockVideoPath);
    // Concat/mux rounding can still leave the ambient stream a few packets
    // shorter, especially for a one-piece narrated block. Re-normalize the
    // complete block BEFORE mixing so -shortest can never amputate narration.
    await ffmpeg.normalizeMediaDuration({ inputPath: blockVideoPath, outputPath: timedBlockVideoPath, targetDuration: blockTimelineSec });

    // 5-6. Synthesize the WHOLE passage once; measure it.
    await this.synthesizeFastDraftVoice({ project, settings, text, outputPath: rawVoicePath, voiceRenderOptions });
    const rawVoiceMeta = await ffmpeg.probeAudio(rawVoicePath);
    const rawVoiceSec = Number(rawVoiceMeta.duration || 0);
    const fitRatio = rawVoiceSec / Math.max(0.3, blockTimelineSec);
    // Never trim spoken words: a passage longer than the safe speed-up must be rewritten upstream.
    if (fitRatio > 1 + maxStretchRatio + 1e-6) {
      const error = new Error(`BLOCK_VOICE_OVERFLOW: narrated block ${lead.deliveryBlockId} voice ${rawVoiceSec.toFixed(2)}s exceeds its ${blockTimelineSec.toFixed(2)}s block (ratio ${fitRatio.toFixed(3)} > ${(1 + maxStretchRatio).toFixed(2)}). Rewrite the block narration; words are never trimmed.`);
      error.code = "BLOCK_VOICE_OVERFLOW";
      error.details = { blockId: lead.deliveryBlockId, rawVoiceSec, blockTimelineSec, fitRatio };
      throw error;
    }
    // 7. Fit ONCE against the whole block (light speed-up or natural finish + silence pad).
    const fit = await ffmpeg.fitDubbingClusterAudio({
      inputPath: rawVoicePath, outputPath: fittedVoicePath, targetDuration: blockTimelineSec, maxStretchRatio,
      normalize: project.dubbingVoiceNormalize ?? settings.dubbingVoiceNormalize ?? true,
      allowTrim: false, allowSlowDown: false, allowSpeedUp: true
    });
    // 8-9. Mix ONCE; the sidechain duck runs continuously across the internal cuts.
    await ffmpeg.mixVideoAudioWithVoice({ videoPath: timedBlockVideoPath, voicePath: fittedVoicePath, outputPath: voicedClipPath,
      sourceVolume: ambientVolume, voiceVolume, limiter: true, duck, separateAmbientInput: true });
    // The voiced block must keep the planned EDL duration. We first prevent the
    // known truncation at its source by timing the ambient block above. If the
    // final mux still drifts beyond one 30fps frame, perform ONE deterministic
    // media-duration correction (pad/trim streams, no EDL change), then re-probe.
    const voicedMeta = await ffmpeg.probeVideo(voicedClipPath).catch(() => null);
    const preCorrectionVoicedSec = Number(voicedMeta?.duration);
    let finalClipPath = voicedClipPath;
    let voicedSec = preCorrectionVoicedSec;
    let durationCorrectionApplied = false;
    if (Number.isFinite(voicedSec) && Math.abs(voicedSec - blockTimelineSec) > BLOCK_DURATION_TOLERANCE_SEC) {
      await ffmpeg.normalizeMediaDuration({ inputPath: voicedClipPath, outputPath: durationFixedClipPath, targetDuration: blockTimelineSec });
      const correctedMeta = await ffmpeg.probeVideo(durationFixedClipPath).catch(() => null);
      const correctedSec = Number(correctedMeta?.duration);
      if (!Number.isFinite(correctedSec) || Math.abs(correctedSec - blockTimelineSec) > BLOCK_DURATION_TOLERANCE_SEC) {
        const error = new Error(`BLOCK_DURATION_DRIFT: narrated block ${lead.deliveryBlockId} rendered ${Number.isFinite(preCorrectionVoicedSec) ? preCorrectionVoicedSec.toFixed(3) : "unknown"}s and duration normalization could not reach planned ${blockTimelineSec.toFixed(3)}s.`);
        error.code = "BLOCK_DURATION_DRIFT";
        error.details = { blockId: lead.deliveryBlockId, voicedSec: preCorrectionVoicedSec, correctedSec, blockTimelineSec };
        throw error;
      }
      finalClipPath = durationFixedClipPath;
      voicedSec = correctedSec;
      durationCorrectionApplied = true;
    }
    await this.recordVoiceProfileSample({ workspaceRoot, settings, project, text, measuredDurationSec: rawVoiceSec,
      segmentDurationSec: blockTimelineSec, source: "highlight_fast_draft_block", providerOverride: draftVoiceProvider }).catch(() => null);
    const report = {
      mode: "narrated_block", blockId: lead.deliveryBlockId, beatIds: members.map((m) => m.beatId || ""), segmentIds: members.map((m) => m.id),
      startIndex, memberCount: members.length, narrationText: text, textHash: textHash(text),
      blockTimelineSec: Number(blockTimelineSec.toFixed(3)), rawTtsSec: Number(rawVoiceSec.toFixed(3)),
      fittedTtsSec: Number(Number(fit?.outputDuration || rawVoiceSec).toFixed(3)), fitRatio: Number(fitRatio.toFixed(3)),
      voicedClipSec: Number.isFinite(voicedSec) ? Number(voicedSec.toFixed(3)) : null,
      preCorrectionVoicedClipSec: Number.isFinite(preCorrectionVoicedSec) ? Number(preCorrectionVoicedSec.toFixed(3)) : null,
      durationCorrectionApplied,
      voiceFitStrategy: fit?.fitStrategy || "", sourceAudioTreatment: treatment, sourceAmbientVolume: ambientVolume, duck,
      internalCutOffsetsSec: pieces.slice(0, -1).reduce((acc, p) => [...acc, Number(((acc.at(-1) || 0) + p.durationSec).toFixed(3))], []),
      storyFunction: lead.blockStoryFunction || "", narratorFunction: lead.blockNarratorFunction || "", narrationIntent: lead.blockNarrationIntent || "",
      handoffTargetBeatId: lead.blockHandoffTargetBeatId || "", fittedVoicePath, blockVideoPath: timedBlockVideoPath
    };
    if (cache) {
      await fs.copyFile(finalClipPath, cache.clip);
      await fs.writeFile(cache.report, JSON.stringify(report));
    }
    return { clipPath: finalClipPath, report, memberReports: memberReportsFor(pieces, report) };
  }

  async renderAllHighlightFastDraftVariants({ workspaceRoot, projectId, settings, onProgress, onVariantReady, reuseCompleted = false }) {
    let project = await this.projectStore.getProject(workspaceRoot, projectId);
    if (project.mode !== "highlight_cut") {
      throw new Error("Render nháp tất cả variant chỉ hỗ trợ mode Highlight Cut.");
    }
    const variants = Array.isArray(project.analysis?.highlightVariants) ? project.analysis.highlightVariants : [];
    if (variants.length <= 1) {
      if (reuseCompleted && await canReuseAutoStoryDraft(project, variants[0], settings)) {
        try { await fs.access(variants[0].artifacts.fastDraftVideoPath); await onVariantReady?.(project); return project; } catch (_) {}
      }
      await this.renderHighlightFastDraft({ workspaceRoot, projectId, settings, onProgress, project });
      await onVariantReady?.(await this.projectStore.getProject(workspaceRoot, projectId));
      return this.projectStore.getProject(workspaceRoot, projectId);
    }

    const originalVariantId = project.analysis.activeVariantId || variants[0].id;
    const variantBatch = variants.map((variant, index) => ({
      id: variant.id,
      index,
      label: variant.label || variant.id || `Variant ${index + 1}`,
      status: "waiting",
      error: "",
      outputPath: ""
    }));
    const failures = [];
    const sendVariantBatch = ({ index = -1, percent = 0, message = "" } = {}) => {
      onProgress?.({
        projectId,
        step: "variant_draft_batch",
        percent: Math.max(0, Math.min(100, Math.round(percent))),
        message,
        variantBatch: {
          kind: "fast_draft",
          activeIndex: index,
          total: variantBatch.length,
          items: variantBatch.map((item) => ({ ...item }))
        }
      });
    };

    sendVariantBatch({ message: `Đã xếp hàng ${variantBatch.length} bản nháp Highlight` });
    for (const [variantIndex, initialVariant] of variants.entries()) {
      throwIfCancelled(getCancelToken());
      project = await this.projectStore.getProject(workspaceRoot, projectId);
      const currentVariants = Array.isArray(project.analysis?.highlightVariants)
        ? project.analysis.highlightVariants
        : variants;
      const variant = currentVariants.find((item) => item.id === initialVariant.id) || initialVariant;
      if (reuseCompleted && await canReuseAutoStoryDraft(project, variant, settings)) {
        try {
          await fs.access(variant.artifacts.fastDraftVideoPath);
          variantBatch[variantIndex].status = "done";
          variantBatch[variantIndex].outputPath = variant.artifacts.fastDraftVideoPath;
          await onVariantReady?.(project);
          continue;
        } catch (_) {}
      }
      variantBatch[variantIndex].status = "processing";
      sendVariantBatch({
        index: variantIndex,
        percent: (variantIndex / variants.length) * 100,
        message: `Đang render nháp variant ${variantIndex + 1}/${variants.length}: ${variant.label || variant.id}`
      });
      const projectForVariant = {
        ...project,
        analysis: {
          ...(project.analysis || {}),
          activeVariantId: variant.id,
          segments: variant.segments || [],
          scenes: buildHighlightScenes(variant.segments || []),
          warnings: variant.warnings || []
        }
      };
      const onVariantProgress = (payload = {}) => {
        const variantPercent = Math.max(0, Math.min(100, safeNumber(payload.percent, 0)));
        sendVariantBatch({
          index: variantIndex,
          percent: ((variantIndex + (variantPercent / 100)) / variants.length) * 100,
          message: `Nháp ${variantIndex + 1}/${variants.length} · ${payload.message || "Đang xử lý"}`
        });
      };
      try {
        const result = await this.renderHighlightFastDraft({
          workspaceRoot,
          projectId,
          settings,
          onProgress: onVariantProgress,
          project: projectForVariant
        });
        variantBatch[variantIndex].status = "done";
        variantBatch[variantIndex].outputPath = result.outputPath || "";
        await onVariantReady?.(await this.projectStore.getProject(workspaceRoot, projectId));
      } catch (error) {
        if (getCancelToken()?.cancelled) throw error;
        variantBatch[variantIndex].status = "failed";
        variantBatch[variantIndex].error = error.message;
        failures.push({
          variantId: variant.id,
          label: variant.label || variant.id,
          error: error.message
        });
      }
      sendVariantBatch({
        index: variantIndex,
        percent: ((variantIndex + 1) / variants.length) * 100,
        message: variantBatch[variantIndex].status === "done"
          ? `Bản nháp variant ${variantIndex + 1}/${variants.length} đã hoàn tất`
          : `Bản nháp variant ${variantIndex + 1}/${variants.length} bị lỗi; tiếp tục variant kế tiếp`
      });
    }

    project = await this.projectStore.getProject(workspaceRoot, projectId);
    const finalVariants = Array.isArray(project.analysis?.highlightVariants)
      ? project.analysis.highlightVariants
      : variants;
    const activeVariant = finalVariants.find((variant) => variant.id === originalVariantId) || finalVariants[0];
    const activeArtifacts = activeVariant?.artifacts || {};
    return this.projectStore.updateProject(workspaceRoot, projectId, {
      artifacts: {
        ...(project.artifacts || {}),
        previewVideoPath: activeArtifacts.fastDraftVideoPath || project.artifacts?.previewVideoPath || "",
        fastDraftVideoPath: activeArtifacts.fastDraftVideoPath || project.artifacts?.fastDraftVideoPath || "",
        fastDraftRenderedAt: activeArtifacts.fastDraftRenderedAt || project.artifacts?.fastDraftRenderedAt || ""
      },
      analysis: {
        ...(project.analysis || {}),
        activeVariantId: activeVariant?.id || originalVariantId,
        segments: activeVariant?.segments || project.analysis?.segments || [],
        scenes: buildHighlightScenes(activeVariant?.segments || project.analysis?.segments || []),
        warnings: activeVariant?.warnings || project.analysis?.warnings || [],
        variantDraftBatch: {
          completedAt: new Date().toISOString(),
          items: variantBatch,
          failures
        }
      },
      statusMessage: failures.length
        ? `Đã render nháp tất cả variant; ${failures.length} variant lỗi`
        : "Đã render nháp tất cả Highlight variant"
    });
  }

  async renderStorytimeFastDraft({ workspaceRoot, projectId, settings, onProgress, openOutput }) {
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    if (project.mode !== "satisfying_storytime") {
      throw new Error("Render nháp nhanh hiện chỉ hỗ trợ mode Oddly Satisfying Storytime.");
    }
    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const ffmpeg = new FfmpegService(settings);
    const segments = project.analysis?.segments || [];
    if (!segments.length) throw new Error("Chưa có kịch bản Storytime để render nháp.");
    const mixerSourceVolume = Math.max(0, Number(project.mixer?.sourceVolume ?? 0));
    const mixerVoiceVolume = Math.max(0, Number(project.mixer?.voiceVolume ?? 100));
    const draftStamp = `${Date.now()}-src${Math.round(mixerSourceVolume)}-vo${Math.round(mixerVoiceVolume)}`;
    const outputPath = path.join(paths.outputDir, `satisfying-storytime-fast-draft-${draftStamp}.mp4`);
    const undecoratedOutputPath = path.join(paths.tempDir, `satisfying-storytime-fast-draft-${draftStamp}-base.mp4`);
    const voicedPath = path.join(paths.outputDir, `satisfying-storytime-fast-draft-${draftStamp}-voiced.mp4`);
    const narrationTrackPath = path.join(paths.outputDir, `satisfying-storytime-fast-draft-${draftStamp}-voice.m4a`);
    const subtitlePath = path.join(paths.outputDir, `satisfying-storytime-fast-draft-${draftStamp}.srt`);
    const draftReportPath = path.join(paths.outputDir, `satisfying-storytime-fast-draft-${draftStamp}-report.json`);
    const meta = await ffmpeg.probeVideo(project.sourceVideoPath);
    const storytimeVoiceRenderMode = project.storytimeVoiceRenderMode
      || (project.storytimeContinuousVoice !== false ? "clustered" : "per_scene");
    const useContinuousVoice = storytimeVoiceRenderMode === "scene_locked";
    const useClusteredVoice = storytimeVoiceRenderMode === "clustered";
    const audioPieces = [];
    const draftClipPaths = [];
    const draftVoiceReports = [];
    const useVoiceDrivenVisuals = project.storytimeVoiceDrivenVisuals !== false && !useClusteredVoice;
    const draftVoiceProvider = this.getFastDraftVoiceProvider(project, settings);
    const draftVoiceExt = audioExtensionForProvider(draftVoiceProvider);
    let cursor = 0;

    if (useClusteredVoice) {
      const groups = buildVoiceBatchGroups(segments, {
        maxDurationSec: Number(project.storytimeVoiceClusterMaxDurationSec || 35),
        maxGapSec: 0.15
      });
      for (const group of groups) {
        const targetDuration = Math.max(0.3, group.endSec - group.startSec);
        const rawVoicePath = path.join(paths.audioDir, `draft-story-cluster-${String(group.groupIndex + 1).padStart(4, "0")}${draftVoiceExt}`);
        const fittedVoicePath = path.join(paths.audioDir, `draft-story-cluster-${String(group.groupIndex + 1).padStart(4, "0")}.m4a`);
        onProgress?.({
          projectId,
          step: "draft",
          percent: Math.min(76, 10 + Math.round((group.groupIndex / Math.max(1, groups.length)) * 62)),
          message: `Đang tạo voice nháp cụm ${group.groupIndex + 1}/${groups.length} bằng ${draftVoiceProvider}`
        });
        await this.synthesizeFastDraftVoice({
          project,
          settings,
          text: group.text || " ",
          outputPath: rawVoicePath
        });
        const rawVoiceMeta = await ffmpeg.probeAudio(rawVoicePath).catch(() => ({ duration: estimateSpeechSeconds(group.text) }));
        await ffmpeg.fitDubbingClusterAudio({
          inputPath: rawVoicePath,
          outputPath: fittedVoicePath,
          targetDuration,
          maxStretchRatio: project.dubbingMaxSafeStretch || settings.dubbingMaxSafeStretch || 0.08,
          normalize: project.dubbingVoiceNormalize ?? settings.dubbingVoiceNormalize ?? true,
          allowTrim: false
        });
        const voiceProfile = await this.recordVoiceProfileSample({
          workspaceRoot,
          settings,
          project,
          text: group.text,
          measuredDurationSec: rawVoiceMeta.duration,
          segmentDurationSec: targetDuration,
          source: "storytime_fast_draft_cluster",
          providerOverride: draftVoiceProvider
        });
        for (const item of group.items) {
          const plannedDuration = Math.max(0.2, item.endSec - item.startSec);
          const allocatedVoiceSec = Number(rawVoiceMeta.duration || 0) * (plannedDuration / targetDuration);
          draftVoiceReports[item.index] = {
            index: item.index,
            sceneId: item.segment.sceneId || item.segment.id,
            startSec: item.startSec,
            endSec: item.endSec,
            requestedTimelineSec: Number(plannedDuration.toFixed(3)),
            timelineSec: Number(plannedDuration.toFixed(3)),
            rawVoiceSec: Number(allocatedVoiceSec.toFixed(3)),
            fitRatio: Number((allocatedVoiceSec / plannedDuration).toFixed(3)),
            requestedFitRatio: Number((allocatedVoiceSec / plannedDuration).toFixed(3)),
            visualFitStrategy: "cluster_timeline_preserved",
            measurementScope: "cluster",
            clusterIndex: group.groupIndex,
            clusterRawVoiceSec: Number(Number(rawVoiceMeta.duration || 0).toFixed(3)),
            clusterTimelineSec: Number(targetDuration.toFixed(3)),
            mode: "clustered_continuous",
            renderedText: item.text,
            textHash: textHash(item.text),
            voiceProfileKey: voiceProfile?.key || "",
            voiceProfileWordsPerSecond: voiceProfile?.wordsPerSecond || 0,
            voiceProfileSampleCount: voiceProfile?.sampleCount || 0
          };
        }
        audioPieces.push(fittedVoicePath);
      }
      onProgress?.({ projectId, step: "draft", percent: 82, message: "Đang ghép voice nháp liên tục theo cụm" });
      await ffmpeg.concatAudioSegments(audioPieces, narrationTrackPath);
    } else if (useContinuousVoice) {
      const baseText = segments.map(getStorytimeVoiceText).filter(Boolean).join(" ");
      const narrationLanguage = inferFastDraftLanguage(baseText, project);
      for (const [index, segment] of segments.entries()) {
        const startSec = Math.max(0, Number(segment.startSec || 0));
        const endSec = Math.max(startSec + 0.2, Number(segment.endSec || startSec + 1));
        const durationSec = endSec - startSec;
        const { sourceStartSec, sourceEndSec, sourceDurationSec } = getSegmentSourceTiming(segment);
        if (!useVoiceDrivenVisuals && startSec > cursor + 0.03) {
          const gapDuration = startSec - cursor;
          const gapFitPath = path.join(paths.audioDir, `draft-story-gap-${String(index).padStart(4, "0")}.m4a`);
          await this.createSilentAudio(ffmpeg, gapFitPath, gapDuration);
          audioPieces.push(gapFitPath);
        }
        onProgress?.({
          projectId,
          step: "draft",
          percent: Math.min(76, 10 + Math.round((index / Math.max(1, segments.length)) * 62)),
          message: `Đang tạo voice nháp khóa theo cảnh ${index + 1}/${segments.length} bằng ${draftVoiceProvider}`
        });
        const rawVoicePath = path.join(paths.audioDir, `draft-story-locked-${String(index + 1).padStart(4, "0")}${draftVoiceExt}`);
        const fittedVoicePath = path.join(paths.audioDir, `draft-story-locked-${String(index + 1).padStart(4, "0")}.m4a`);
        const rawClipPath = path.join(paths.clipsDir, `draft-story-locked-${String(index + 1).padStart(4, "0")}-raw.mp4`);
        const voicedClipPath = path.join(paths.clipsDir, `draft-story-locked-${String(index + 1).padStart(4, "0")}-voiced.mp4`);
        const voiceText = getStorytimeVoiceText(segment);
        await this.synthesizeFastDraftVoice({
          project,
          settings,
          text: voiceText || " ",
          outputPath: rawVoicePath
        });
        const rawVoiceMeta = await ffmpeg.probeAudio(rawVoicePath).catch(() => ({ duration: estimateSpeechSeconds(voiceText) }));
        const renderDurationSec = getVoiceDrivenRenderDuration(durationSec, rawVoiceMeta.duration, Boolean(voiceText));
        const voiceProfile = await this.recordVoiceProfileSample({
          workspaceRoot,
          settings,
          project,
          text: voiceText,
          measuredDurationSec: rawVoiceMeta.duration,
          segmentDurationSec: renderDurationSec,
          source: "storytime_fast_draft",
          providerOverride: draftVoiceProvider
        });
        await ffmpeg.fitAudioToDuration({
          inputPath: rawVoicePath,
          outputPath: fittedVoicePath,
          targetDuration: renderDurationSec
        });
        await ffmpeg.extractVoiceDrivenClipWithAudio({
          sourcePath: project.sourceVideoPath,
          outputPath: rawClipPath,
          startSec: sourceStartSec,
          sourceDurationSec,
          targetDurationSec: renderDurationSec,
          width: 540,
          preset: "ultrafast",
          crf: 32
        });
        await ffmpeg.mixVideoAudioWithVoice({
          videoPath: rawClipPath,
          voicePath: fittedVoicePath,
          outputPath: voicedClipPath,
          sourceVolume: mixerSourceVolume / 100,
          voiceVolume: Math.max(0.2, mixerVoiceVolume / 100),
          limiter: true
        });
        draftVoiceReports[index] = {
          index,
          sceneId: segment.sceneId || segment.id,
          startSec,
          endSec,
          requestedTimelineSec: Number(durationSec.toFixed(3)),
          timelineSec: Number(renderDurationSec.toFixed(3)),
          rawVoiceSec: Number(Number(rawVoiceMeta.duration || 0).toFixed(3)),
          fitRatio: Number((Number(rawVoiceMeta.duration || 0) / Math.max(0.3, renderDurationSec)).toFixed(3)),
          requestedFitRatio: Number((Number(rawVoiceMeta.duration || 0) / Math.max(0.3, durationSec)).toFixed(3)),
          visualFitStrategy: renderDurationSec > durationSec + 0.03 ? "distributed_slowdown_to_voice" : renderDurationSec < durationSec - 0.03 ? "cut_to_voice" : "as_requested",
          mode: "scene_locked_continuous",
          renderedText: voiceText,
          textHash: textHash(voiceText),
          voiceProfileKey: voiceProfile?.key || "",
          voiceProfileWordsPerSecond: voiceProfile?.wordsPerSecond || 0,
          voiceProfileSampleCount: voiceProfile?.sampleCount || 0
        };
        audioPieces.push(fittedVoicePath);
        draftClipPaths.push(voicedClipPath);
        cursor = endSec;
      }
      if (!useVoiceDrivenVisuals && meta.duration > cursor + 0.03) {
        const tailDuration = meta.duration - cursor;
        const tailFitPath = path.join(paths.audioDir, "draft-story-tail-locked.m4a");
        await this.createSilentAudio(ffmpeg, tailFitPath, tailDuration);
        audioPieces.push(tailFitPath);
      }
      onProgress?.({ projectId, step: "draft", percent: 82, message: "Đang ghép voice nháp khóa theo cảnh" });
      await ffmpeg.concatAudioSegments(audioPieces, narrationTrackPath);
    } else {
      for (const [index, segment] of segments.entries()) {
        const startSec = Math.max(0, Number(segment.startSec || 0));
        const endSec = Math.max(startSec + 0.2, Number(segment.endSec || startSec + 1));
        const durationSec = endSec - startSec;
        const { sourceStartSec, sourceEndSec, sourceDurationSec } = getSegmentSourceTiming(segment);
        if (!useVoiceDrivenVisuals && startSec > cursor + 0.03) {
          const gapPath = path.join(paths.audioDir, `draft-gap-${String(index).padStart(4, "0")}.m4a`);
          await this.createSilentAudio(ffmpeg, gapPath, startSec - cursor);
          audioPieces.push(gapPath);
        }
        onProgress?.({
          projectId,
          step: "draft",
          percent: Math.min(76, 10 + Math.round((index / Math.max(1, segments.length)) * 62)),
          message: `Đang tạo voice nháp ${index + 1}/${segments.length} bằng ${draftVoiceProvider}`
        });
        const rawVoicePath = path.join(paths.audioDir, `draft-story-${String(index + 1).padStart(4, "0")}${draftVoiceExt}`);
        const fittedVoicePath = path.join(paths.audioDir, `draft-story-${String(index + 1).padStart(4, "0")}.m4a`);
        const rawClipPath = path.join(paths.clipsDir, `draft-story-${String(index + 1).padStart(4, "0")}-raw.mp4`);
        const voicedClipPath = path.join(paths.clipsDir, `draft-story-${String(index + 1).padStart(4, "0")}-voiced.mp4`);
        await this.synthesizeFastDraftVoice({
          project,
          settings,
          text: getStorytimeVoiceText(segment) || " ",
          outputPath: rawVoicePath
        });
        const voiceText = getStorytimeVoiceText(segment) || " ";
        const rawVoiceMeta = await ffmpeg.probeAudio(rawVoicePath).catch(() => ({ duration: estimateSpeechSeconds(voiceText) }));
        const renderDurationSec = getVoiceDrivenRenderDuration(durationSec, rawVoiceMeta.duration, Boolean(safeText(voiceText)));
        const voiceProfile = await this.recordVoiceProfileSample({
          workspaceRoot,
          settings,
          project,
          text: voiceText,
          measuredDurationSec: rawVoiceMeta.duration,
          segmentDurationSec: renderDurationSec,
          source: "storytime_fast_draft",
          providerOverride: draftVoiceProvider
        });
        await ffmpeg.fitDubbingClusterAudio({
          inputPath: rawVoicePath,
          outputPath: fittedVoicePath,
          targetDuration: renderDurationSec,
          maxStretchRatio: project.dubbingMaxSafeStretch || settings.dubbingMaxSafeStretch || 0.08,
          normalize: project.dubbingVoiceNormalize ?? settings.dubbingVoiceNormalize ?? true,
          allowTrim: false
        });
        await ffmpeg.extractVoiceDrivenClipWithAudio({
          sourcePath: project.sourceVideoPath,
          outputPath: rawClipPath,
          startSec: sourceStartSec,
          sourceDurationSec,
          targetDurationSec: renderDurationSec,
          width: 540,
          preset: "ultrafast",
          crf: 32
        });
        await ffmpeg.mixVideoAudioWithVoice({
          videoPath: rawClipPath,
          voicePath: fittedVoicePath,
          outputPath: voicedClipPath,
          sourceVolume: mixerSourceVolume / 100,
          voiceVolume: Math.max(0.2, mixerVoiceVolume / 100),
          limiter: true
        });
        draftVoiceReports[index] = {
          index,
          sceneId: segment.sceneId || segment.id,
          startSec,
          endSec,
          requestedTimelineSec: Number(durationSec.toFixed(3)),
          timelineSec: Number(renderDurationSec.toFixed(3)),
          rawVoiceSec: Number(Number(rawVoiceMeta.duration || 0).toFixed(3)),
          fitRatio: Number((Number(rawVoiceMeta.duration || 0) / Math.max(0.3, renderDurationSec)).toFixed(3)),
          requestedFitRatio: Number((Number(rawVoiceMeta.duration || 0) / Math.max(0.3, durationSec)).toFixed(3)),
          visualFitStrategy: renderDurationSec > durationSec + 0.03 ? "distributed_slowdown_to_voice" : renderDurationSec < durationSec - 0.03 ? "cut_to_voice" : "as_requested",
          mode: "segment",
          renderedText: voiceText,
          textHash: textHash(voiceText),
          voiceProfileKey: voiceProfile?.key || "",
          voiceProfileWordsPerSecond: voiceProfile?.wordsPerSecond || 0,
          voiceProfileSampleCount: voiceProfile?.sampleCount || 0
        };
        audioPieces.push(fittedVoicePath);
        draftClipPaths.push(voicedClipPath);
        cursor = endSec;
      }
      if (!useVoiceDrivenVisuals && meta.duration > cursor + 0.03) {
        const tailPath = path.join(paths.audioDir, "draft-tail-gap.m4a");
        await this.createSilentAudio(ffmpeg, tailPath, meta.duration - cursor);
        audioPieces.push(tailPath);
      }
      onProgress?.({ projectId, step: "draft", percent: 82, message: "Đang ghép voice nháp" });
      await ffmpeg.concatAudioSegments(audioPieces, narrationTrackPath);
    }
    const previewSubtitleSegments = await this.buildStorytimeFastDraftPreviewSubtitles({
      workspaceRoot,
      projectId,
      project,
      settings,
      onProgress
    });
    await this.projectStore.writeText(subtitlePath, buildSrt(previewSubtitleSegments.map((segment) => ({
      ...segment,
      translatedText: segment.previewSubtitleVi || ""
    })), "translatedText"));
    if (useVoiceDrivenVisuals && draftClipPaths.length) {
      await ffmpeg.concatSegmentsByFilter(draftClipPaths, voicedPath);
    } else {
      let sourceForDraft = project.sourceVideoPath;
      if (useClusteredVoice) {
        const clusteredSourcePath = path.join(paths.tempDir, `draft-story-cluster-source-${draftStamp}.mp4`);
        const plannedDuration = Math.min(meta.duration, getStorytimeLastEndSec(segments));
        await ffmpeg.extractRetimeClipWithAudio({
          sourcePath: project.sourceVideoPath,
          outputPath: clusteredSourcePath,
          startSec: 0,
          sourceDurationSec: plannedDuration,
          targetDurationSec: plannedDuration,
          width: 540,
          preset: "ultrafast",
          crf: 32
        });
        sourceForDraft = clusteredSourcePath;
      }
      const sourceForDraftMix = sourceForDraft;
      await ffmpeg.mixVideoAudioWithVoice({
        videoPath: sourceForDraftMix,
        voicePath: narrationTrackPath,
        outputPath: voicedPath,
        sourceVolume: mixerSourceVolume / 100,
        voiceVolume: Math.max(0.2, mixerVoiceVolume / 100),
        limiter: true
      });
    }
    const voiceAlignmentReport = buildDraftVoiceAlignmentReport({
      project,
      segments,
      draftVoiceReports
    });
    const resolvedTimeline = compileResolvedTimeline({
      mode: "satisfying_storytime",
      segments,
      voiceReports: voiceAlignmentReport.segments.map((item, index) => ({
        ...draftVoiceReports[index],
        ...item
      })),
      voiceDrivenVisuals: useVoiceDrivenVisuals,
      generatedAt: voiceAlignmentReport.generatedAt
    });
    const voiceWarningReportPath = path.join(paths.outputDir, `satisfying-storytime-fast-draft-${draftStamp}-voice-warnings.json`);
    const resolvedTimelinePath = path.join(paths.outputDir, `satisfying-storytime-fast-draft-${draftStamp}-resolved-timeline.json`);
    const geminiRewritePromptPath = path.join(paths.outputDir, `satisfying-storytime-fast-draft-${draftStamp}-gemini-rewrite-prompt.txt`);
    await this.projectStore.writeJson(voiceWarningReportPath, voiceAlignmentReport).catch(() => {});
    await this.projectStore.writeJson(resolvedTimelinePath, resolvedTimeline).catch(() => {});
    await this.projectStore.writeText(geminiRewritePromptPath, voiceAlignmentReport.geminiPrompt || "").catch(() => {});
    await this.projectStore.writeJson(draftReportPath, {
      generatedAt: new Date().toISOString(),
      outputPath,
      sourceVolumePercent: mixerSourceVolume,
      voiceVolumePercent: mixerVoiceVolume,
      voiceRenderMode: useClusteredVoice ? "clustered_continuous" : useContinuousVoice ? "scene_locked_segmented" : "per_scene",
      resolvedTimelinePath,
      resolvedTimeline,
      segments: draftVoiceReports,
      voiceAlignment: {
        passed: voiceAlignmentReport.passed,
        warningCount: voiceAlignmentReport.warningCount,
        warningReportPath: voiceWarningReportPath,
        geminiRewritePromptPath,
        warnings: voiceAlignmentReport.warnings
      },
      sourceAudioMuted: mixerSourceVolume <= 0,
      voiceCacheEnabled: settings.voiceCacheEnabled !== false
    }).catch(() => {});
    onProgress?.({ projectId, step: "draft", percent: 92, message: "Đang encode nháp nhanh 540p" });
    await ffmpeg.transcodeFastPreview({ inputPath: voicedPath, outputPath: undecoratedOutputPath, width: 540 });
    await this.applyProjectVideoDecoration({
      ffmpeg,
      project,
      paths,
      inputPath: undecoratedOutputPath,
      outputPath,
      name: "storytime-draft",
      draft: true
    });
    const currentProject = await this.projectStore.getProject(workspaceRoot, projectId).catch(() => project);
    const currentAnalysis = currentProject.analysis || {};
    const currentSegments = Array.isArray(currentAnalysis.segments) ? currentAnalysis.segments : segments;
    const previewSubtitleByIndex = new Map(previewSubtitleSegments.map((segment, index) => [
      index,
      {
        text: safeText(segment.previewSubtitleVi || ""),
        sourceHash: safeText(segment.previewSubtitleSourceHash || "")
      }
    ]));
    const updatedPreviewSegments = currentSegments.map((segment, index) => ({
      ...segment,
      previewSubtitleVi: previewSubtitleByIndex.get(index)?.text || segment.previewSubtitleVi || "",
      previewSubtitleSourceHash: previewSubtitleByIndex.get(index)?.sourceHash || segment.previewSubtitleSourceHash || "",
      fastDraftVoiceSec: draftVoiceReports[index]?.rawVoiceSec ?? segment.fastDraftVoiceSec,
      fastDraftTimelineSec: voiceAlignmentReport.segments[index]?.plannedTimelineSec ?? segment.fastDraftTimelineSec,
      fastDraftResolvedTimelineSec: voiceAlignmentReport.segments[index]?.resolvedTimelineSec ?? segment.fastDraftResolvedTimelineSec,
      fastDraftFitRatio: voiceAlignmentReport.segments[index]?.coverageRatio ?? segment.fastDraftFitRatio,
      resolvedPreviewStartSec: resolvedTimeline.segments[index]?.resolved.startSec,
      resolvedPreviewEndSec: resolvedTimeline.segments[index]?.resolved.endSec,
      fastDraftTextHash: voiceAlignmentReport.segments[index]?.textHash || draftVoiceReports[index]?.textHash || segment.fastDraftTextHash || "",
      fastDraftMeasuredAt: voiceAlignmentReport.generatedAt,
      fastDraftVoiceMode: draftVoiceReports[index]?.mode || segment.fastDraftVoiceMode,
      fastDraftVoiceProfileKey: draftVoiceReports[index]?.voiceProfileKey || segment.fastDraftVoiceProfileKey || "",
      fastDraftVoiceProfileWordsPerSecond: draftVoiceReports[index]?.voiceProfileWordsPerSecond || segment.fastDraftVoiceProfileWordsPerSecond || 0,
      fastDraftVoiceProfileSampleCount: draftVoiceReports[index]?.voiceProfileSampleCount || segment.fastDraftVoiceProfileSampleCount || 0,
      fastDraftVoiceStatus: voiceAlignmentReport.segments[index]?.status || segment.fastDraftVoiceStatus,
      fastDraftVoiceWarning: !["ok", "not_applicable"].includes(voiceAlignmentReport.segments[index]?.status)
        ? voiceAlignmentReport.segments[index]?.problem
        : "",
      aiSceneReview: mergeDraftVoiceReview(segment, voiceAlignmentReport.segments[index])
    }));
    const qualityGate = buildProjectQualityGate(updatedPreviewSegments, "satisfying_storytime");
    const previousWarnings = Array.isArray(currentAnalysis.warnings) ? currentAnalysis.warnings : [];
    const retainedWarnings = previousWarnings.filter((warning) => {
      const text = safeText(warning);
      return !text.startsWith("Draft voice cảnh ") && !text.startsWith("Quality gate:");
    });
    const draftVoiceWarnings = voiceAlignmentReport.warnings.map((warning) => (
      `Draft voice cảnh ${warning.sceneNumber}: ${warning.problem} ${warning.recommendation}`
    ));
    const qualityGateWarnings = qualityGate.exportAllowed
      ? []
      : [`Quality gate: ${qualityGate.blockedCount}/${qualityGate.totalScenes} cảnh nên duyệt trước khi export. Tool vẫn cho phép export nếu user muốn.`];
    const publishedDraftPath = await publishDraftVideo({
      settings,
      project: currentProject,
      sourcePath: outputPath,
      mode: "storytime"
    });
    await this.projectStore.updateProject(workspaceRoot, projectId, {
      artifacts: {
        ...(currentProject.artifacts || {}),
        previewVideoPath: publishedDraftPath,
        fastDraftVideoPath: publishedDraftPath,
        internalFastDraftVideoPath: outputPath,
        fastDraftBaseVideoPath: undecoratedOutputPath,
        fastDraftSubtitlePath: subtitlePath,
        fastDraftReportPath: draftReportPath,
        fastDraftResolvedTimelinePath: resolvedTimelinePath,
        fastDraftSubtitleLanguage: "vi",
        fastDraftSubtitlesArePreviewOnly: true,
        fastDraftRenderedAt: voiceAlignmentReport.generatedAt,
        previewRenderedAt: voiceAlignmentReport.generatedAt
      },
      analysis: {
        ...currentAnalysis,
        artifacts: {
          ...(currentAnalysis.artifacts || {}),
          fastDraftPreviewSubtitleLanguage: "vi",
          fastDraftVoiceWarningReportPath: voiceWarningReportPath,
          fastDraftResolvedTimelinePath: resolvedTimelinePath,
          fastDraftGeminiRewritePromptPath: geminiRewritePromptPath
        },
        qualityGate,
        warnings: [...retainedWarnings, ...draftVoiceWarnings, ...qualityGateWarnings],
        segments: updatedPreviewSegments
      }
    }).catch(() => {});
    await pruneDraftArtifacts(paths.outputDir, "satisfying-storytime-fast-draft-", 3).catch(() => {});
    return {
      outputPath: publishedDraftPath,
      internalOutputPath: outputPath,
      subtitlePath,
      reportPath: draftReportPath,
      previewSubtitleLanguage: "vi",
      previewOnlySubtitles: true,
      voiceWarningCount: voiceAlignmentReport.warningCount,
      voiceWarningReportPath,
      resolvedTimelinePath,
      geminiRewritePromptPath
    };
  }

  async renderProject({ workspaceRoot, projectId, settings, onProgress }) {
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    if (project.mode === "highlight_cut") {
      return this.renderHighlightCutProject({ workspaceRoot, projectId, settings, onProgress, project });
    }
    if (project.mode === "satisfying_storytime") {
      return this.renderStorytimeProject({ workspaceRoot, projectId, settings, onProgress, project });
    }
    const mode = project.dubbingRenderMode || settings.dubbingRenderMode || "speech_first_clustered";
    if (mode === "legacy_segment_strict") {
      return this.renderLegacyProject({ workspaceRoot, projectId, settings, onProgress });
    }
    try {
      return await this.renderSpeechFirstProject({ workspaceRoot, projectId, settings, onProgress, project });
    } catch (error) {
      const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
      const warning = `Speech-first dubbing render lỗi, fallback legacy: ${error.message}`;
      await this.projectStore.writeJson(path.join(paths.outputDir, "dubbing-qa.json"), {
        generatedAt: new Date().toISOString(),
        mode: "speech_first_clustered",
        fallback_to_legacy: true,
        issues: [{ code: "fallback_to_legacy", severity: "warning", message: warning }]
      });
      await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "warning", percent: 22, message: warning });
      return this.renderLegacyProject({ workspaceRoot, projectId, settings, onProgress });
    }
  }

  async renderAllHighlightCutVariants({ workspaceRoot, projectId, settings, onProgress }) {
    let project = await this.projectStore.getProject(workspaceRoot, projectId);
    if (project.mode !== "highlight_cut") {
      throw new Error("Render tat ca variant chi ho tro mode Highlight Cut.");
    }
    const variants = Array.isArray(project.analysis?.highlightVariants) ? project.analysis.highlightVariants : [];
    if (variants.length <= 1) {
      return this.renderHighlightCutProject({ workspaceRoot, projectId, settings, onProgress, project });
    }
    const originalVariantId = project.analysis.activeVariantId || variants[0].id;
    let latestProject = project;
    const variantBatch = variants.map((variant, index) => ({
      id: variant.id,
      index,
      label: variant.label || variant.id || `Variant ${index + 1}`,
      status: "waiting",
      error: ""
    }));
    const failures = [];
    const sendVariantBatch = ({ index = -1, percent = 0, message = "" } = {}) => {
      onProgress?.({
        projectId,
        step: "variant_batch",
        percent: Math.max(0, Math.min(100, Math.round(percent))),
        message,
        variantBatch: {
          activeIndex: index,
          total: variantBatch.length,
          items: variantBatch.map((item) => ({ ...item }))
        }
      });
    };
    sendVariantBatch({
      percent: 0,
      message: `Đã xếp hàng ${variantBatch.length} Highlight variant`
    });
    for (const [variantIndex, variant] of variants.entries()) {
      variantBatch[variantIndex].status = "processing";
      sendVariantBatch({
        index: variantIndex,
        percent: (variantIndex / variants.length) * 100,
        message: `Đang xử lý variant ${variantIndex + 1}/${variants.length}: ${variant.label || variant.id}`
      });
      const projectForVariant = {
        ...latestProject,
        analysis: {
          ...(latestProject.analysis || {}),
          activeVariantId: variant.id,
          segments: variant.segments || [],
          scenes: buildHighlightScenes(variant.segments || []),
          warnings: variant.warnings || []
        }
      };
      const onVariantProgress = (payload = {}) => {
        const variantPercent = Math.max(0, Math.min(100, safeNumber(payload.percent, 0)));
        const overallPercent = ((variantIndex + (variantPercent / 100)) / variants.length) * 100;
        sendVariantBatch({
          index: variantIndex,
          percent: overallPercent,
          message: `Variant ${variantIndex + 1}/${variants.length} · ${payload.message || "Đang xử lý"}`
        });
      };
      try {
        latestProject = await this.renderHighlightCutProject({
          workspaceRoot,
          projectId,
          settings,
          onProgress: onVariantProgress,
          project: projectForVariant
        });
        variantBatch[variantIndex].status = "done";
      } catch (error) {
        variantBatch[variantIndex].status = "failed";
        variantBatch[variantIndex].error = error.message;
        failures.push({
          variantId: variant.id,
          label: variant.label || variant.id,
          error: error.message
        });
      }
      sendVariantBatch({
        index: variantIndex,
        percent: ((variantIndex + 1) / variants.length) * 100,
        message: variantBatch[variantIndex].status === "done"
          ? `Variant ${variantIndex + 1}/${variants.length} đã hoàn tất`
          : `Variant ${variantIndex + 1}/${variants.length} bị lỗi; tiếp tục variant kế tiếp`
      });
    }
    latestProject = await this.projectStore.getProject(workspaceRoot, projectId);
    const finalVariants = Array.isArray(latestProject.analysis?.highlightVariants) ? latestProject.analysis.highlightVariants : variants;
    const activeVariant = finalVariants.find((variant) => variant.id === originalVariantId) || finalVariants[0];
    return this.projectStore.updateProject(workspaceRoot, projectId, {
      analysis: {
        ...(latestProject.analysis || {}),
        activeVariantId: activeVariant?.id || originalVariantId,
        segments: activeVariant?.segments || latestProject.analysis?.segments || [],
        scenes: buildHighlightScenes(activeVariant?.segments || latestProject.analysis?.segments || []),
        warnings: activeVariant?.warnings || latestProject.analysis?.warnings || [],
        variantExportBatch: {
          completedAt: new Date().toISOString(),
          items: variantBatch,
          failures
        }
      },
      status: "done",
      progressPercent: 100,
      statusMessage: failures.length
        ? `Đã xử lý tất cả Highlight variant; ${failures.length} variant lỗi`
        : "Tất cả Highlight variant đã render xong"
    });
  }

  async renderHighlightCutProject({ workspaceRoot, projectId, settings, onProgress, project }) {
    project = resolveEffectiveVideoEditProject(project);
    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const ffmpeg = new FfmpegService(settings);
    const activeVariant = getActiveHighlightVariant(project);
    const variantId = activeVariant.id || "variant_01";
    const variantMetadata = resolveVariantFileMetadata(project, activeVariant);
    const variantSuffix = variantMetadata.fileTag;
    const sourceSegments = activeVariant.segments?.length ? activeVariant.segments : project.analysis?.segments || [];
    if (!sourceSegments.length) {
      throw new Error("Chua co Highlight Cut JSON de render.");
    }
    const segments = project.analysisWorkflow === "manual_gemini_story_recut"
      ? consolidateStoryRecutSegments(sourceSegments, { maxSourceGapSec: 4 })
      : sourceSegments;
    const qualityGate = assertExportQualityGate({ project, segments, mode: "highlight_cut" });

    const outputPath = path.join(paths.outputDir, `highlight-cut-${variantSuffix}-final.mp4`);
    const undecoratedOutputPath = path.join(paths.tempDir, `highlight-cut-${variantSuffix}-final-base.mp4`);
    const clipPaths = [];
    const renderReport = [];
    const warnings = [...(activeVariant.warnings || project.analysis?.warnings || [])];
    const renderSegments = coalesceContiguousOriginalAudioSegments(segments, {
      allowCoalesce: true,
      maxBlockDurationSec: 30
    });
    const coalescedCount = segments.length - renderSegments.length;
    if (coalescedCount > 0) {
      warnings.push(
        `Renderer đã gộp ${coalescedCount} ranh giới âm gốc liền nhau để giảm khựng hình/âm thanh; evidence logic vẫn được giữ nguyên.`
      );
    }
    if (!qualityGate.exportAllowed && qualityGate.warningMessage) {
      warnings.push(qualityGate.warningMessage);
      await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "warning", percent: 8, message: qualityGate.warningMessage });
    }
    await fs.unlink(outputPath).catch(() => {});
    for (const [index, segment] of renderSegments.entries()) {
      const sourceStartSec = Math.max(0, Number(segment.sourceStartSec ?? segment.startSec ?? 0));
      const sourceEndSec = Math.max(sourceStartSec + 0.3, Number(segment.sourceEndSec ?? sourceStartSec + Number(segment.sourceDuration || segment.duration || 1)));
      const sourceDurationSec = sourceEndSec - sourceStartSec;
      const durationSec = Math.max(0.3, Number(segment.duration ?? (((segment.endSec || 0) - (segment.startSec || 0)) || sourceDurationSec)));
      const requestedAudioMode = segment.requestedAudioMode || segment.audio_mode || segment.audioMode || "";
      const voiceText = segment.voiceoverText || segment.dubbingLine || (requestedAudioMode && requestedAudioMode !== "original_audio" ? segment.text : "") || "";
      const audioMode = getHighlightAudioMode(segment, Boolean(voiceText), project);
      const rawClipPath = path.join(paths.clipsDir, `highlight-${variantSuffix}-${String(index + 1).padStart(4, "0")}-raw.mp4`);
      const voicedClipPath = path.join(paths.clipsDir, `highlight-${variantSuffix}-${String(index + 1).padStart(4, "0")}-voiced.mp4`);
      const finalClipPath = path.join(paths.clipsDir, `highlight-${variantSuffix}-${String(index + 1).padStart(4, "0")}-final.mp4`);

      await this.emitProgress({
        workspaceRoot,
        projectId,
        onProgress,
        step: "clips",
        percent: Math.min(75, 12 + Math.round((index / Math.max(1, renderSegments.length)) * 58)),
        message: `Dang cat ${activeVariant.label || variantId}: block ${index + 1}/${renderSegments.length}`
      });
      let voiceResult = null;
      let rawVoiceMeta = null;
      let renderDurationSec = durationSec;
      let fittedVoicePath = "";
      let fit = null;
      let fitPolicy = null;
      if (voiceText) {
        const rawVoicePath = path.join(paths.audioDir, `highlight-${variantSuffix}-voice-${String(index + 1).padStart(4, "0")}${audioExtensionForProvider(project.voiceProvider || settings.defaultVoiceProvider || "edge_neural")}`);
        fittedVoicePath = path.join(paths.audioDir, `highlight-${variantSuffix}-voice-${String(index + 1).padStart(4, "0")}-fit.m4a`);
        await this.emitProgress({
          workspaceRoot,
          projectId,
          onProgress,
          step: "voice",
          percent: Math.min(82, 22 + Math.round((index / Math.max(1, renderSegments.length)) * 56)),
          message: `Dang tao voice ${activeVariant.label || variantId}: ${index + 1}/${renderSegments.length}`
        });
        try {
          voiceResult = await this.synthesizeDubbingVoice({
            settings,
            project,
            text: voiceText,
            outputPath: rawVoicePath,
            durationSec,
            voiceRenderOptions: getSegmentVoiceRenderOptions(segment),
            onProgress: (message) => onProgress?.({ projectId, step: "voice", percent: 30, message })
          });
        } catch (error) {
          if (isQuotaExceededError(error)) {
            throw new Error(`ElevenLabs het credits khi tao voice highlight ${index + 1}/${renderSegments.length}. Chi tiet: ${error.message}`);
          }
          throw error;
        }
        rawVoiceMeta = await ffmpeg.probeAudio(rawVoicePath).catch(() => ({ duration: estimateSpeechSeconds(voiceText) }));
        fitPolicy = resolveHighlightVoiceFit(segment, durationSec, rawVoiceMeta.duration);
        renderDurationSec = fitPolicy.renderDurationSec;
        fit = await ffmpeg.fitDubbingClusterAudio({
          inputPath: rawVoicePath,
          outputPath: fittedVoicePath,
          targetDuration: renderDurationSec,
          maxStretchRatio: Math.min(0.08, project.dubbingMaxSafeStretch || settings.dubbingMaxSafeStretch || 0.08),
          normalize: false,
          allowTrim: false,
          allowSlowDown: false,
          allowSpeedUp: true
        });
        await this.recordVoiceProfileSample({
          workspaceRoot,
          settings,
          project,
          text: voiceText,
          measuredDurationSec: fit.rawDuration,
          segmentDurationSec: renderDurationSec,
          source: "highlight_final"
        });
      }
      await ffmpeg.extractVoiceDrivenClipWithAudio({
        sourcePath: project.sourceVideoPath,
        outputPath: rawClipPath,
        startSec: sourceStartSec,
        sourceDurationSec,
        targetDurationSec: renderDurationSec,
        includeAudio: !voiceText || audioMode === "voiceover_with_ambient"
      });
      const rawClipMeta = await ffmpeg.probeVideo(rawClipPath);
      if (!voiceText && !rawClipMeta.hasAudio) {
        warnings.push(`Highlight ${index + 1}: source ${sourceStartSec.toFixed(2)}s-${sourceEndSec.toFixed(2)}s has no audio.`);
      }

      let clipForCaption = rawClipPath;
      if (voiceText) {
        const voiceFitWarning = describeHighlightVoiceFitWarning(index, fitPolicy);
        if (voiceFitWarning) warnings.push(voiceFitWarning);
        const voiceCoverage = fit.rawDuration / Math.max(0.3, renderDurationSec);
        if (voiceCoverage < 0.55) {
          warnings.push(`Highlight ${index + 1}: voice ${fit.rawDuration.toFixed(2)}s chi phu ${Math.round(voiceCoverage * 100)}% khung render ${renderDurationSec.toFixed(2)}s.`);
        }
        await ffmpeg.mixVideoAudioWithVoice({
          videoPath: rawClipPath,
          voicePath: fittedVoicePath,
          outputPath: voicedClipPath,
          sourceVolume: getHighlightAmbientVolume(segment, project),
          voiceVolume: Math.max(0.2, Number(project.mixer?.voiceVolume ?? 100) / 100),
          limiter: false
        });
        clipForCaption = voicedClipPath;
        renderReport.push({
          index: segment.renderMembers?.[0]?.index ?? index,
          segmentId: safeText(segment.segmentId || segment.id || ""),
          evidenceId: safeText(segment.evidenceId || ""),
          sceneId: safeText(segment.sceneId || ""),
          sourceRunId: safeText(segment.sourceRunId || ""),
          macroBlockId: safeText(segment.macroBlockId || ""),
          storyFunction: safeText(segment.storyFunction || ""),
          audioMode,
          sourceStartSec,
          sourceEndSec,
          sourceDurationSec: Number(sourceDurationSec.toFixed(3)),
          requestedDurationSec: Number(durationSec.toFixed(3)),
          durationSec: Number(renderDurationSec.toFixed(3)),
          playbackSpeed: Number((sourceDurationSec / Math.max(0.3, renderDurationSec)).toFixed(4)),
          rawVoiceDuration: Number(fit.rawDuration.toFixed(3)),
          fittedVoiceDuration: Number(fit.outputDuration.toFixed(3)),
          voiceCoverage: Number(voiceCoverage.toFixed(3)),
          voiceCacheHit: Boolean(voiceResult?.cacheHit),
          voiceCacheKey: voiceResult?.cacheKey || "",
          fitStrategy: fit.fitStrategy,
          visualFitStrategy: fitPolicy?.strategy || (renderDurationSec > durationSec + 0.03 ? "distributed_slowdown_to_voice" : renderDurationSec < durationSec - 0.03 ? "cut_to_voice" : "as_requested"),
          voiceFitWarning,
          sourceAmbientVolume: getHighlightAmbientVolume(segment, project),
          sourceNarratorReplaced: Boolean(segment.sourceNarratorDetected || segment.replaceSourceNarrator),
          sourceAudioRemoved: audioMode !== "voiceover_with_ambient"
        });
      } else {
        for (const member of segment.renderMembers || [{ index, segment }]) {
          const memberSegment = member.segment;
          const memberSourceStart = Number(memberSegment.sourceStartSec ?? memberSegment.startSec ?? 0);
          const memberSourceEnd = Number(
            memberSegment.sourceEndSec
            ?? memberSourceStart + Number(memberSegment.sourceDuration || memberSegment.duration || 1)
          );
          const memberDuration = Number(
            memberSegment.duration
            ?? ((Number(memberSegment.endSec || 0) - Number(memberSegment.startSec || 0)) || (memberSourceEnd - memberSourceStart))
          );
          renderReport.push({
            index: member.index,
            segmentId: safeText(memberSegment.segmentId || memberSegment.id || ""),
            evidenceId: safeText(memberSegment.evidenceId || ""),
            sceneId: safeText(memberSegment.sceneId || ""),
            sourceRunId: safeText(memberSegment.sourceRunId || ""),
            macroBlockId: safeText(memberSegment.macroBlockId || ""),
            storyFunction: safeText(memberSegment.storyFunction || ""),
            audioMode,
            sourceStartSec: memberSourceStart,
            sourceEndSec: memberSourceEnd,
            sourceDurationSec: Number((memberSourceEnd - memberSourceStart).toFixed(3)),
            requestedDurationSec: Number(memberDuration.toFixed(3)),
            durationSec: Number(memberDuration.toFixed(3)),
            playbackSpeed: Number(((memberSourceEnd - memberSourceStart) / Math.max(0.3, memberDuration)).toFixed(4)),
            rawVoiceDuration: 0,
            fittedVoiceDuration: 0,
            voiceCoverage: 0,
            fitStrategy: segment.renderMembers?.length > 1 ? "original_audio_coalesced" : "original_audio",
            sourceNarratorReplaced: false,
            sourceAudioRemoved: false
          });
        }
      }

      // Review translations belong to the draft only, never the final export.
      await ffmpeg.copyMedia({ inputPath: clipForCaption, outputPath: finalClipPath });
      const normalizedClipPath = path.join(paths.clipsDir, `highlight-${variantSuffix}-${String(index + 1).padStart(4, "0")}-normalized.mp4`);
      await ffmpeg.normalizeMediaDuration({
        inputPath: finalClipPath,
        outputPath: normalizedClipPath,
        targetDuration: renderDurationSec
      });
      clipPaths.push(normalizedClipPath);
    }

    await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "rendering", percent: 88, message: `Dang ghep ${activeVariant.label || variantId}` });
    await ffmpeg.concatSegmentsByFilter(clipPaths, undecoratedOutputPath);
    if (project.sourceSubtitleMask?.enabled) {
      const mask = project.sourceSubtitleMask;
      await this.emitProgress({
        workspaceRoot,
        projectId,
        onProgress,
        step: "rendering",
        percent: 91,
        message: `Đang làm mờ vùng phụ đề X ${Number(mask.xPercent || 0).toFixed(1)}% · rộng ${Number(mask.widthPercent || 100).toFixed(1)}%`
      });
    }
    await this.applyProjectVideoDecoration({
      ffmpeg,
      project,
      paths,
      inputPath: undecoratedOutputPath,
      outputPath,
      name: `highlight-${variantSuffix}-final`
    });
    const finalTimeline = compileResolvedTimeline({
      mode: "highlight_cut",
      segments,
      voiceReports: renderReport.map((item) => ({
        rawVoiceSec: item.rawVoiceDuration,
        requestedTimelineSec: item.requestedDurationSec,
        timelineSec: item.durationSec,
        renderedText: getHighlightVoiceText(segments[item.index] || {}),
        visualFitStrategy: item.visualFitStrategy
      })),
      voiceDrivenVisuals: true
    });
    const finalTimelinePath = path.join(paths.outputDir, `highlight-cut-${variantSuffix}-resolved-timeline.json`);
    const renderQaPath = path.join(paths.outputDir, `highlight-cut-${variantSuffix}-render-qa.json`);
    await this.projectStore.writeJson(finalTimelinePath, finalTimeline);
    await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "qa", percent: 94, message: "Đang kiểm tra âm thanh, khoảng lặng và khung hình Highlight" });
    const renderQa = await new RenderQaService(settings).inspect({
      videoPath: outputPath,
      targetDuration: finalTimeline.resolvedDurationSec,
      subtitlePath: "not_requested",
      expectedAudioSegments: finalTimeline.segments.map((item) => ({
        segmentId: item.segmentId,
        startSec: item.resolved.startSec,
        endSec: item.resolved.endSec
      }))
    }).catch((error) => ({
      passed: false,
      inspectedAt: new Date().toISOString(),
      issues: [{ severity: "warning", code: "qa_failed", message: error.message }]
    }));
    await this.projectStore.writeJson(renderQaPath, renderQa);
    warnings.push(...(renderQa.issues || []).map((issue) => `Render QA: ${issue.message}`));
    const publishedOutputPath = await publishFinalVideo({
      settings,
      project,
      sourcePath: outputPath,
      mode: "highlight",
      variant: `${variantMetadata.fileTag}-${activeVariant.label || variantId}`
    });
    const finalRenderedAt = new Date().toISOString();
    const reportPath = path.join(paths.outputDir, `highlight-cut-${variantSuffix}-render-report.json`);
    await this.projectStore.writeJson(reportPath, {
      generatedAt: new Date().toISOString(),
      sourceVideoPath: project.sourceVideoPath,
      variantId,
      variantLabel: activeVariant.label || variantId,
      revisionNumber: Math.max(1, safeNumber(activeVariant.revisionNumber, 1)),
      promptProfile: safeText(activeVariant.promptProfile || ""),
      audioStrategy: safeText(activeVariant.audioStrategy || ""),
      sourceNarratorPolicy: safeText(activeVariant.sourceNarratorPolicy || ""),
      outputPath: publishedOutputPath,
      internalOutputPath: outputPath,
      resolvedTimelinePath: finalTimelinePath,
      renderQaPath,
      renderQa,
      warnings,
      segments: renderReport
    });
    const runHistory = Array.isArray(project.runHistory) ? [...project.runHistory] : [];
    runHistory.unshift({
      renderedAt: finalRenderedAt,
      finalVideoPath: publishedOutputPath,
      internalFinalVideoPath: outputPath,
      mode: "highlight_cut",
      variantId,
      variantLabel: activeVariant.label || variantId,
      reportPath
    });
    const variants = Array.isArray(project.analysis?.highlightVariants) ? project.analysis.highlightVariants : [];
    const updatedVariants = variants.map((variant) => variant.id === variantId ? {
      ...variant,
      segments,
      warnings,
      artifacts: {
        ...(variant.artifacts || {}),
        finalVideoPath: publishedOutputPath,
        internalFinalVideoPath: outputPath,
        finalRenderedAt,
        renderReportPath: reportPath,
        resolvedTimelinePath: finalTimelinePath,
        renderQaPath
      }
    } : variant);
    return await this.emitProgress({
      workspaceRoot,
      projectId,
      onProgress,
      step: "done",
      percent: 100,
      message: `Video Highlight Cut ${activeVariant.label || variantId} da san sang`,
      partial: {
        artifacts: {
          ...(project.artifacts || {}),
          finalVideoPath: publishedOutputPath,
          internalFinalVideoPath: outputPath,
          finalRenderedAt,
          renderReportPath: reportPath,
          resolvedTimelinePath: finalTimelinePath,
          renderQaPath
        },
        analysis: {
          ...(project.analysis || {}),
          activeVariantId: variantId,
          highlightVariants: updatedVariants.length ? updatedVariants : project.analysis?.highlightVariants,
          segments,
          scenes: buildHighlightScenes(segments),
          renderReport,
          resolvedTimeline: finalTimeline,
          renderQa,
          warnings
        },
        runHistory
      }
    });
  }
  async renderStorytimeProject({ workspaceRoot, projectId, settings, onProgress, project }) {
    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const ffmpeg = new FfmpegService(settings);
    const segments = project.analysis?.segments || [];
    if (!segments.length) {
      throw new Error("Chua co kich ban Storytime de render.");
    }
    const qualityGate = assertExportQualityGate({ project, segments, mode: "satisfying_storytime" });

    const outputPath = path.join(paths.outputDir, "satisfying-storytime-final.mp4");
    const undecoratedOutputPath = path.join(paths.tempDir, "satisfying-storytime-final-base.mp4");
    const voicedPath = path.join(paths.outputDir, "satisfying-storytime-voiced.mp4");
    const narrationTrackPath = path.join(paths.outputDir, "satisfying-storytime-voice-track.m4a");
    const subtitlePath = path.join(paths.outputDir, "satisfying-storytime-caption.srt");
    const fitReportPath = path.join(paths.outputDir, "satisfying-storytime-fit-report.json");
    const voiceProvider = project.voiceProvider || settings.defaultVoiceProvider || "edge_neural";
    const sourceMeta = await ffmpeg.probeVideo(project.sourceVideoPath);
    const audioPieces = [];
    const finalClipPaths = [];
    const fitReport = [];
    const warnings = [...(project.analysis?.warnings || [])];
    if (!qualityGate.exportAllowed && qualityGate.warningMessage) {
      warnings.push(qualityGate.warningMessage);
      await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "warning", percent: 8, message: qualityGate.warningMessage });
    }
    let cursor = 0;
    const storytimeVoiceRenderMode = project.storytimeVoiceRenderMode
      || (project.storytimeContinuousVoice !== false ? "clustered" : "per_scene");
    const useContinuousStorytimeVoice = storytimeVoiceRenderMode === "scene_locked";
    const useOmniVoiceBatch = shouldUseStorytimeVoiceBatch({
      voiceProvider,
      storytimeVoiceRenderMode,
      omniVoiceRenderMode: project.omniVoiceRenderMode,
      useContinuousStorytimeVoice
    });
    const useVoiceDrivenVisuals = project.storytimeVoiceDrivenVisuals !== false && !useOmniVoiceBatch;

    if (useContinuousStorytimeVoice) {
      const baseText = segments.map(getStorytimeVoiceText).filter(Boolean).join(" ");
      const narrationLanguage = inferFastDraftLanguage(baseText, project);
      await this.emitProgress({
        workspaceRoot,
        projectId,
        onProgress,
        step: "voice",
        percent: 18,
        message: "Đang tạo voice Storytime liên tục khóa theo từng cảnh"
      });
      for (const [index, segment] of segments.entries()) {
        const startSec = Math.max(0, Number(segment.startSec || 0));
        const endSec = Math.max(startSec + 0.2, Number(segment.endSec || startSec + 1));
        const targetDuration = endSec - startSec;
        const { sourceStartSec, sourceDurationSec } = getSegmentSourceTiming(segment);
        if (!useVoiceDrivenVisuals && startSec > cursor + 0.03) {
          const gapDuration = startSec - cursor;
          const gapFitPath = path.join(paths.audioDir, `story-locked-gap-${String(index).padStart(4, "0")}-fit.m4a`);
          await this.createSilentAudio(ffmpeg, gapFitPath, gapDuration);
          audioPieces.push(gapFitPath);
        }
        await this.emitProgress({
          workspaceRoot,
          projectId,
          onProgress,
          step: "voice",
          percent: Math.min(72, 18 + Math.round((index / Math.max(1, segments.length)) * 52)),
          message: `Đang tạo voice Storytime khóa theo cảnh ${index + 1}/${segments.length}`
        });
        const rawVoicePath = path.join(paths.audioDir, `story-locked-voice-${String(index + 1).padStart(4, "0")}${audioExtensionForProvider(voiceProvider)}`);
        const fittedVoicePath = path.join(paths.audioDir, `story-locked-voice-${String(index + 1).padStart(4, "0")}-fit.m4a`);
        const rawClipPath = path.join(paths.clipsDir, `story-locked-${String(index + 1).padStart(4, "0")}-raw.mp4`);
        const voicedClipPath = path.join(paths.clipsDir, `story-locked-${String(index + 1).padStart(4, "0")}-voiced.mp4`);
        let voiceText = getStorytimeVoiceText(segment);
        await this.synthesizeDubbingVoice({
          settings,
          project,
          text: voiceText || " ",
          outputPath: rawVoicePath,
          durationSec: targetDuration,
          onProgress: (message) => onProgress?.({ projectId, step: "voice", percent: 24, message })
        });
        let rawMeta = await ffmpeg.probeAudio(rawVoicePath);
        const renderDurationSec = getVoiceDrivenRenderDuration(targetDuration, rawMeta.duration, Boolean(voiceText));
        await this.recordVoiceProfileSample({
          workspaceRoot,
          settings,
          project,
          text: voiceText,
          measuredDurationSec: rawMeta.duration,
          segmentDurationSec: renderDurationSec,
          source: "storytime_final"
        });
        let autoShortened = false;
        let originalVoiceText = "";
        for (let attempt = 1; false && Number(rawMeta.duration || 0) > targetDuration * 1.14 && attempt <= 2; attempt += 1) {
          const shortenedText = shortenTextForTtsDuration(voiceText, targetDuration, rawMeta.duration, attempt);
          if (!shortenedText || shortenedText === voiceText) break;
          originalVoiceText = originalVoiceText || voiceText;
          voiceText = shortenedText;
          autoShortened = true;
          warnings.push(`Storytime cảnh ${index + 1}: voice khóa cảnh dài ${Number(rawMeta.duration || 0).toFixed(2)}s so với khung ${targetDuration.toFixed(2)}s, đã tự rút gọn text lần ${attempt}.`);
          await this.synthesizeDubbingVoice({
            settings,
            project,
            text: voiceText || " ",
            outputPath: rawVoicePath,
            durationSec: targetDuration,
            onProgress: (message) => onProgress?.({ projectId, step: "voice", percent: 24, message })
          });
          rawMeta = await ffmpeg.probeAudio(rawVoicePath);
          await this.recordVoiceProfileSample({
            workspaceRoot,
            settings,
            project,
            text: voiceText,
            measuredDurationSec: rawMeta.duration,
            segmentDurationSec: targetDuration,
            source: "storytime_final_rewrite"
          });
        }
        await ffmpeg.fitAudioToDuration({
          inputPath: rawVoicePath,
          outputPath: fittedVoicePath,
          targetDuration: renderDurationSec
        });
        await ffmpeg.extractVoiceDrivenClipWithAudio({
          sourcePath: project.sourceVideoPath,
          outputPath: rawClipPath,
          startSec: sourceStartSec,
          sourceDurationSec,
          targetDurationSec: renderDurationSec
        });
        await ffmpeg.mixVideoAudioWithVoice({
          videoPath: rawClipPath,
          voicePath: fittedVoicePath,
          outputPath: voicedClipPath,
          sourceVolume: Math.max(0, Number(project.mixer?.sourceVolume ?? 12) / 100),
          voiceVolume: Math.max(0.2, Number(project.mixer?.voiceVolume ?? 100) / 100),
          limiter: true
        });
        fitReport.push({
          id: segment.id,
          index,
          sceneLockedContinuous: true,
          startSec,
          endSec,
          requestedDuration: Number(targetDuration.toFixed(3)),
          targetDuration: Number(renderDurationSec.toFixed(3)),
          rawDuration: Number(Number(rawMeta.duration || 0).toFixed(3)),
          outputDuration: Number(renderDurationSec.toFixed(3)),
          wordCount: countWords(voiceText),
          fitStrategy: "scene_locked_continuous_voice_driven",
          visualFitStrategy: renderDurationSec > targetDuration + 0.03 ? "distributed_slowdown_to_voice" : renderDurationSec < targetDuration - 0.03 ? "cut_to_voice" : "as_requested",
          status: autoShortened ? "auto_shortened_ok" : "ok",
          autoShortened,
          originalText: originalVoiceText,
          text: voiceText
        });
        audioPieces.push(fittedVoicePath);
        finalClipPaths.push(voicedClipPath);
        cursor = endSec;
      }
      if (!useVoiceDrivenVisuals && sourceMeta.duration > cursor + 0.03) {
        const tailDuration = sourceMeta.duration - cursor;
        const tailFitPath = path.join(paths.audioDir, "story-locked-tail-fit.m4a");
        await this.createSilentAudio(ffmpeg, tailFitPath, tailDuration);
        audioPieces.push(tailFitPath);
      }
    } else if (useOmniVoiceBatch) {
      const groups = buildVoiceBatchGroups(segments, {
        maxDurationSec: Number(project.omniVoiceBatchMaxDurationSec || 45),
        maxGapSec: 0.15
      });
      await this.emitProgress({
        workspaceRoot,
        projectId,
        onProgress,
        step: "voice",
        percent: 18,
        message: `${voiceProvider}: gộp ${segments.length} đoạn thành ${groups.length} cụm voice liên tục`
      });
      for (const group of groups) {
        const startSec = Math.max(0, group.startSec);
        const endSec = Math.max(startSec + 0.2, group.endSec);
        const targetDuration = endSec - startSec;
        if (!useVoiceDrivenVisuals && startSec > cursor + 0.03) {
          const gapPath = path.join(paths.audioDir, `story-batch-gap-${String(group.groupIndex).padStart(4, "0")}.m4a`);
          await this.createSilentAudio(ffmpeg, gapPath, startSec - cursor);
          audioPieces.push(gapPath);
        }

        await this.emitProgress({
          workspaceRoot,
          projectId,
          onProgress,
          step: "voice",
          percent: Math.min(72, 18 + Math.round((group.groupIndex / Math.max(1, groups.length)) * 52)),
          message: `Voice cụm ${group.groupIndex + 1}/${groups.length}: ${group.items.length} cảnh`
        });

        const rawVoicePath = path.join(paths.audioDir, `story-batch-voice-${String(group.groupIndex + 1).padStart(4, "0")}${audioExtensionForProvider(voiceProvider)}`);
        const fittedVoicePath = path.join(paths.audioDir, `story-batch-voice-${String(group.groupIndex + 1).padStart(4, "0")}-fit.m4a`);
        await this.synthesizeDubbingVoice({
          settings,
          project,
          text: group.text || " ",
          outputPath: rawVoicePath,
          durationSec: targetDuration,
          onProgress: (message) => onProgress?.({ projectId, step: "voice", percent: 24, message })
        });
        const fit = await ffmpeg.fitDubbingClusterAudio({
          inputPath: rawVoicePath,
          outputPath: fittedVoicePath,
          targetDuration,
          maxStretchRatio: project.dubbingMaxSafeStretch || settings.dubbingMaxSafeStretch || 0.08,
          normalize: project.dubbingVoiceNormalize ?? settings.dubbingVoiceNormalize ?? true,
          allowTrim: false
        });
        await this.recordVoiceProfileSample({
          workspaceRoot,
          settings,
          project,
          text: group.text || " ",
          measuredDurationSec: fit.rawDuration,
          segmentDurationSec: targetDuration,
          source: "storytime_final_batch"
        });
        const allowedOverflowSec = Math.min(0.5, Math.max(0.3, targetDuration * 0.03));
        const overflowSec = Math.max(0, fit.outputDuration - targetDuration);
        const overflowWithinTolerance = overflowSec <= allowedOverflowSec;
        fitReport.push({
          id: `batch-${group.groupIndex + 1}`,
          batch: true,
          batchIndex: group.groupIndex,
          segmentIndexes: group.items.map((item) => item.index),
          segmentCount: group.items.length,
          startSec,
          endSec,
          targetDuration: Number(targetDuration.toFixed(3)),
          rawDuration: Number(fit.rawDuration.toFixed(3)),
          outputDuration: Number(fit.outputDuration.toFixed(3)),
          fitStrategy: fit.fitStrategy,
          allowedOverflowSec: Number(allowedOverflowSec.toFixed(3)),
          overflowSec: Number(overflowSec.toFixed(3)),
          status: overflowSec > 0 ? overflowWithinTolerance ? "auto_tolerated_overflow" : "overflow" : "ok",
          text: group.text
        });
        if (fit.outputDuration > targetDuration + allowedOverflowSec) {
          const warning = `Voice batch ${group.groupIndex + 1} dài ${fit.outputDuration.toFixed(2)}s nhưng khung chỉ ${targetDuration.toFixed(2)}s; tool đã ép fit để tiếp tục export.`;
          warnings.push(warning);
          await this.emitProgress({
            workspaceRoot,
            projectId,
            onProgress,
            step: "warning",
            percent: Math.min(74, 20 + Math.round((group.groupIndex / Math.max(1, groups.length)) * 52)),
            message: warning
          });
          await ffmpeg.fitAudioToDuration({
            inputPath: rawVoicePath,
            outputPath: fittedVoicePath,
            targetDuration
          });
          fitReport[fitReport.length - 1] = {
            ...fitReport[fitReport.length - 1],
            outputDuration: Number(targetDuration.toFixed(3)),
            fitStrategy: "forced_fit_after_overflow",
            status: "forced_fit_warning",
            warning
          };
        }
        audioPieces.push(fittedVoicePath);
        cursor = endSec;
      }
    } else {
      for (const [index, segment] of segments.entries()) {
      const startSec = Math.max(0, Number(segment.startSec || 0));
      const endSec = Math.max(startSec + 0.2, Number(segment.endSec || startSec + 1));
      const targetDuration = endSec - startSec;
      const { sourceStartSec, sourceDurationSec } = getSegmentSourceTiming(segment);
      if (!useVoiceDrivenVisuals && startSec > cursor + 0.03) {
        const gapPath = path.join(paths.audioDir, `story-gap-${String(index).padStart(4, "0")}.m4a`);
        await this.createSilentAudio(ffmpeg, gapPath, startSec - cursor);
        audioPieces.push(gapPath);
      }

      await this.emitProgress({
        workspaceRoot,
        projectId,
        onProgress,
        step: "voice",
        percent: Math.min(72, 18 + Math.round((index / Math.max(1, segments.length)) * 52)),
        message: `Đang tạo voice Storytime ${index + 1}/${segments.length}`
      });

      const rawVoicePath = path.join(paths.audioDir, `story-voice-${String(index + 1).padStart(4, "0")}${audioExtensionForProvider(voiceProvider)}`);
      const fittedVoicePath = path.join(paths.audioDir, `story-voice-${String(index + 1).padStart(4, "0")}-fit.m4a`);
      const rawClipPath = path.join(paths.clipsDir, `story-${String(index + 1).padStart(4, "0")}-raw.mp4`);
      const voicedClipPath = path.join(paths.clipsDir, `story-${String(index + 1).padStart(4, "0")}-voiced.mp4`);
      let voiceText = segment.dubbingLine || segment.text || " ";
      await this.synthesizeDubbingVoice({
        settings,
        project,
        text: voiceText,
        outputPath: rawVoicePath,
        durationSec: targetDuration,
        onProgress: (message) => onProgress?.({ projectId, step: "voice", percent: 24, message })
      });
      const rawMeta = await ffmpeg.probeAudio(rawVoicePath).catch(() => ({ duration: estimateSpeechSeconds(voiceText) }));
      const renderDurationSec = getVoiceDrivenRenderDuration(targetDuration, rawMeta.duration, Boolean(safeText(voiceText)));
      let fit = await ffmpeg.fitDubbingClusterAudio({
        inputPath: rawVoicePath,
        outputPath: fittedVoicePath,
        targetDuration: renderDurationSec,
        maxStretchRatio: project.dubbingMaxSafeStretch || settings.dubbingMaxSafeStretch || 0.08,
        normalize: project.dubbingVoiceNormalize ?? settings.dubbingVoiceNormalize ?? true,
        allowTrim: false
      });
      await this.recordVoiceProfileSample({
        workspaceRoot,
        settings,
        project,
        text: voiceText,
        measuredDurationSec: fit.rawDuration,
        segmentDurationSec: renderDurationSec,
        source: "storytime_final"
      });
      const allowedOverflowSec = Math.min(0.5, Math.max(0.3, targetDuration * 0.03));
      let overflowSec = Math.max(0, fit.outputDuration - targetDuration);
      let autoShortened = false;
      let originalVoiceText = "";
      for (let shortenAttempt = 1; false && fit.outputDuration > targetDuration + allowedOverflowSec && shortenAttempt <= 2; shortenAttempt += 1) {
        const shortenedText = shortenTextForTtsDuration(voiceText, targetDuration, fit.outputDuration, shortenAttempt);
        if (!shortenedText || shortenedText === voiceText) break;
        originalVoiceText = originalVoiceText || voiceText;
        voiceText = shortenedText;
        autoShortened = true;
        segment.dubbingLine = voiceText;
        segment.storyText = voiceText;
        segment.text = voiceText;
        warnings.push(`Storytime đoạn ${index + 1}: voice dài ${fit.outputDuration.toFixed(2)}s so với khung ${targetDuration.toFixed(2)}s, đã tự rút gọn text lần ${shortenAttempt}.`);
        await this.emitProgress({
          workspaceRoot,
          projectId,
          onProgress,
          step: "voice",
          percent: Math.min(74, 20 + Math.round((index / Math.max(1, segments.length)) * 52)),
          message: `Voice đoạn ${index + 1} quá dài, đang tự rút gọn và tạo lại`
        });
        await this.synthesizeDubbingVoice({
          settings,
          project,
          text: voiceText,
          outputPath: rawVoicePath,
          durationSec: targetDuration,
          onProgress: (message) => onProgress?.({ projectId, step: "voice", percent: 24, message })
        });
        fit = await ffmpeg.fitDubbingClusterAudio({
          inputPath: rawVoicePath,
          outputPath: fittedVoicePath,
          targetDuration,
          maxStretchRatio: project.dubbingMaxSafeStretch || settings.dubbingMaxSafeStretch || 0.08,
          normalize: project.dubbingVoiceNormalize ?? settings.dubbingVoiceNormalize ?? true,
          allowTrim: false
        });
        await this.recordVoiceProfileSample({
          workspaceRoot,
          settings,
          project,
          text: voiceText,
          measuredDurationSec: fit.rawDuration,
          segmentDurationSec: targetDuration,
          source: "storytime_final_rewrite"
        });
        overflowSec = Math.max(0, fit.outputDuration - targetDuration);
      }
      const overflowWithinTolerance = overflowSec <= allowedOverflowSec;
      fitReport.push({
        id: segment.id,
        index,
        startSec,
        endSec,
        requestedDuration: Number(targetDuration.toFixed(3)),
        targetDuration: Number(renderDurationSec.toFixed(3)),
        rawDuration: Number(fit.rawDuration.toFixed(3)),
        outputDuration: Number(renderDurationSec.toFixed(3)),
        fitStrategy: "voice_driven_visual_fit",
        visualFitStrategy: renderDurationSec > targetDuration + 0.03 ? "distributed_slowdown_to_voice" : renderDurationSec < targetDuration - 0.03 ? "cut_to_voice" : "as_requested",
        allowedOverflowSec: Number(allowedOverflowSec.toFixed(3)),
        overflowSec: Number(overflowSec.toFixed(3)),
        status: overflowSec > allowedOverflowSec ? "visual_adjusted_warning" : "ok",
        autoShortened,
        originalText: originalVoiceText,
        text: voiceText
      });
      if (fit.outputDuration > targetDuration + allowedOverflowSec) {
        const warning = `Voice đoạn ${index + 1} dài ${fit.outputDuration.toFixed(2)}s so với khung JSON ${targetDuration.toFixed(2)}s; tool đã kéo video theo voice để tiếp tục export.`;
        warnings.push(warning);
        await this.emitProgress({
          workspaceRoot,
          projectId,
          onProgress,
          step: "warning",
          percent: Math.min(74, 20 + Math.round((index / Math.max(1, segments.length)) * 52)),
          message: warning
        });
        fitReport[fitReport.length - 1] = {
          ...fitReport[fitReport.length - 1],
          outputDuration: Number(renderDurationSec.toFixed(3)),
          fitStrategy: "voice_driven_visual_fit",
          status: "visual_adjusted_warning",
          warning
        };
      }
      await ffmpeg.extractVoiceDrivenClipWithAudio({
        sourcePath: project.sourceVideoPath,
        outputPath: rawClipPath,
        startSec: sourceStartSec,
        sourceDurationSec,
        targetDurationSec: renderDurationSec
      });
      await ffmpeg.mixVideoAudioWithVoice({
        videoPath: rawClipPath,
        voicePath: fittedVoicePath,
        outputPath: voicedClipPath,
        sourceVolume: Math.max(0, Number(project.mixer?.sourceVolume ?? 12) / 100),
        voiceVolume: Math.max(0.2, Number(project.mixer?.voiceVolume ?? 100) / 100),
        limiter: true
      });
      if (overflowSec > 0) {
        await this.emitProgress({
          workspaceRoot,
          projectId,
          onProgress,
          step: "voice",
          percent: Math.min(74, 20 + Math.round((index / Math.max(1, segments.length)) * 52)),
          message: `Voice đoạn ${index + 1} dư ${overflowSec.toFixed(2)}s, đã tự xử lý trong ngưỡng an toàn`
        });
      }
      audioPieces.push(fittedVoicePath);
      finalClipPaths.push(voicedClipPath);
      cursor = endSec;
      }
    }

    if (!useVoiceDrivenVisuals && !useContinuousStorytimeVoice && sourceMeta.duration > cursor + 0.03) {
      const tailPath = path.join(paths.audioDir, "story-tail-gap.m4a");
      await this.createSilentAudio(ffmpeg, tailPath, sourceMeta.duration - cursor);
      audioPieces.push(tailPath);
    }

    await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "rendering", percent: 76, message: "Đang ghép track voice Storytime" });
    await ffmpeg.concatAudioSegments(audioPieces, narrationTrackPath);
    const captionSegments = segments.map((segment) => ({
      ...segment,
      translatedText: segment.caption || segment.dubbingLine || segment.text || ""
    }));
    await this.projectStore.writeText(subtitlePath, buildSrt(captionSegments, "translatedText"));
    await this.projectStore.writeJson(fitReportPath, {
      generatedAt: new Date().toISOString(),
      passed: true,
      voiceRenderMode: useContinuousStorytimeVoice ? "scene_locked_segmented" : useOmniVoiceBatch ? "clustered_continuous" : "per_scene",
      segments: fitReport
    });

    await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "rendering", percent: 84, message: "Đang ghép video theo thời lượng voice thật" });
    if (useVoiceDrivenVisuals && finalClipPaths.length) {
      await ffmpeg.concatSegmentsByFilter(finalClipPaths, voicedPath);
    } else {
      let sourceForFinal = project.sourceVideoPath;
      if (useOmniVoiceBatch) {
        const clusteredSourcePath = path.join(paths.tempDir, "storytime-cluster-source.mp4");
        const plannedDuration = Math.min(sourceMeta.duration, getStorytimeLastEndSec(segments));
        await ffmpeg.extractRetimeClipWithAudio({
          sourcePath: project.sourceVideoPath,
          outputPath: clusteredSourcePath,
          startSec: 0,
          sourceDurationSec: plannedDuration,
          targetDurationSec: plannedDuration
        });
        sourceForFinal = clusteredSourcePath;
      }
      const sourceForFinalMix = sourceForFinal;
      await ffmpeg.mixVideoAudioWithVoice({
        videoPath: sourceForFinalMix,
        voicePath: narrationTrackPath,
        outputPath: voicedPath,
        sourceVolume: Math.max(0, Number(project.mixer?.sourceVolume ?? 12) / 100),
        voiceVolume: Math.max(0.2, Number(project.mixer?.voiceVolume ?? 100) / 100),
        limiter: true
      });
    }

    await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "rendering", percent: 92, message: "Đang xuất video Storytime không kèm caption" });
    await this.applyProjectVideoDecoration({
      ffmpeg,
      project,
      paths,
      inputPath: voicedPath,
      outputPath: undecoratedOutputPath,
      name: "storytime-final"
    });
    await ffmpeg.copyMedia({ inputPath: undecoratedOutputPath, outputPath });
    const finalVoiceReports = segments.map((segment, index) => {
      const direct = fitReport.find((item) => Number(item.index) === index);
      if (direct) {
        return {
          rawVoiceSec: direct.rawDuration,
          requestedTimelineSec: direct.requestedDuration ?? direct.targetDuration,
          timelineSec: direct.outputDuration,
          renderedText: direct.text || getStorytimeVoiceText(segment),
          visualFitStrategy: direct.visualFitStrategy
        };
      }
      const batch = fitReport.find((item) => Array.isArray(item.segmentIndexes) && item.segmentIndexes.includes(index));
      if (batch) {
        const plannedDuration = Math.max(0.2, Number(segment.endSec || 0) - Number(segment.startSec || 0));
        const share = plannedDuration / Math.max(0.2, Number(batch.targetDuration || plannedDuration));
        return {
          rawVoiceSec: Number(batch.rawDuration || 0) * share,
          requestedTimelineSec: plannedDuration,
          timelineSec: plannedDuration,
          renderedText: getStorytimeVoiceText(segment),
          visualFitStrategy: "clustered_voice"
        };
      }
      return {
        rawVoiceSec: Number(segment.fastDraftVoiceSec || 0),
        requestedTimelineSec: Math.max(0.2, Number(segment.endSec || 0) - Number(segment.startSec || 0)),
        renderedText: getStorytimeVoiceText(segment)
      };
    });
    const finalTimeline = compileResolvedTimeline({
      mode: "satisfying_storytime",
      segments,
      voiceReports: finalVoiceReports,
      voiceDrivenVisuals: useVoiceDrivenVisuals
    });
    const finalTimelinePath = path.join(paths.outputDir, "satisfying-storytime-resolved-timeline.json");
    const renderQaPath = path.join(paths.outputDir, "satisfying-storytime-render-qa.json");
    await this.projectStore.writeJson(finalTimelinePath, finalTimeline);
    await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "qa", percent: 95, message: "Đang kiểm tra âm thanh, khoảng lặng và khung hình Storytime" });
    const renderQa = await new RenderQaService(settings).inspect({
      videoPath: outputPath,
      targetDuration: finalTimeline.resolvedDurationSec,
      narrationPath: narrationTrackPath,
      subtitlePath: "not_requested",
      expectedAudioSegments: finalTimeline.segments
        .filter((item) => item.voice.durationSec > 0)
        .map((item) => ({
          segmentId: item.segmentId,
          startSec: item.resolved.startSec,
          endSec: item.resolved.endSec
        }))
    }).catch((error) => ({
      passed: false,
      inspectedAt: new Date().toISOString(),
      issues: [{ severity: "warning", code: "qa_failed", message: error.message }]
    }));
    await this.projectStore.writeJson(renderQaPath, renderQa);
    warnings.push(...(renderQa.issues || []).map((issue) => `Render QA: ${issue.message}`));
    const publishedOutputPath = await publishFinalVideo({
      settings,
      project,
      sourcePath: outputPath,
      mode: "storytime"
    });
    const finalRenderedAt = new Date().toISOString();

    const runHistory = Array.isArray(project.runHistory) ? [...project.runHistory] : [];
    runHistory.unshift({
      renderedAt: finalRenderedAt,
      finalVideoPath: publishedOutputPath,
      internalFinalVideoPath: outputPath,
      subtitlePath,
      narrationTrackPath,
      resolvedTimelinePath: finalTimelinePath,
      renderQaPath,
      mode: "satisfying_storytime"
    });

    return await this.emitProgress({
      workspaceRoot,
      projectId,
      onProgress,
      step: "done",
      percent: 100,
      message: "Video Oddly Satisfying Storytime đã sẵn sàng",
      partial: {
        artifacts: {
          finalVideoPath: publishedOutputPath,
          internalFinalVideoPath: outputPath,
          finalRenderedAt,
          subtitlePath,
          voicedOutputPath: voicedPath,
          narrationTrackPath,
          durationFitReportPath: fitReportPath,
          resolvedTimelinePath: finalTimelinePath,
          renderQaPath
        },
        analysis: {
          ...(project.analysis || {}),
          segments,
          renderSegments: captionSegments,
          resolvedTimeline: finalTimeline,
          renderQa,
          warnings
        },
        runHistory
      }
    });
  }

  async renderSpeechFirstProject({ workspaceRoot, projectId, settings, onProgress, project }) {
    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const ffmpeg = new FfmpegService(settings);
    const segments = project.analysis?.segments || [];
    if (!segments.length) {
      throw new Error("Không có phân đoạn phụ đề để render.");
    }

    const outputPath = path.join(paths.outputDir, "dubbing-final.mp4");
    const undecoratedOutputPath = path.join(paths.tempDir, "dubbing-speech-first-final-base.mp4");
    const voicedPath = path.join(paths.outputDir, "dubbing-voiced.mp4");
    const narrationTrackPath = path.join(paths.outputDir, "dubbing-voice-track.m4a");
    const speechPlanPath = path.join(paths.analysisDir, "dubbing-speech-plan.json");
    const durationFitReportPath = path.join(paths.outputDir, "dubbing-duration-report.json");
    const subtitlePath = path.join(paths.outputDir, "dubbing-subtitle-aligned.srt");
    const subtitleAlignmentReportPath = path.join(paths.outputDir, "dubbing-subtitle-alignment-report.json");
    const qaPath = path.join(paths.outputDir, "dubbing-qa.json");
    const warnings = [...(project.analysis?.warnings || [])];
    const planner = new DubbingSpeechPlanner({
      minClusterDuration: project.dubbingMinClusterDuration || settings.dubbingMinClusterDuration || 5,
      maxClusterDuration: project.dubbingMaxClusterDuration || settings.dubbingMaxClusterDuration || 12,
      maxSafeStretch: project.dubbingMaxSafeStretch || settings.dubbingMaxSafeStretch || 0.08,
      targetLanguage: project.targetLanguage || project.narrationLanguage || "vi",
      voiceSpeed: project.voiceSpeed || 1
    });

    await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "rendering", percent: 18, message: "Đang lập kế hoạch speech-first cho dubbing" });
    const plan = planner.buildPlan(segments);
    await this.projectStore.writeJson(speechPlanPath, plan);

    const audioPieces = [];
    const subtitleSegments = [];
    const durationFitReport = [];
    const sourceMeta = await ffmpeg.probeVideo(project.sourceVideoPath);
    let cursor = 0;

    for (const [clusterIndex, cluster] of plan.clusters.entries()) {
      const clusterStart = Math.max(cluster.start, cursor);
      if (clusterStart > cursor + 0.05) {
        const gapPath = path.join(paths.audioDir, `cluster-gap-${String(clusterIndex).padStart(4, "0")}.m4a`);
        await this.createSilentAudio(ffmpeg, gapPath, clusterStart - cursor);
        audioPieces.push(gapPath);
      }

      await this.emitProgress({
        workspaceRoot,
        projectId,
        onProgress,
        step: "rendering",
        percent: Math.min(66, 24 + Math.round((clusterIndex / Math.max(1, plan.clusters.length)) * 40)),
        message: `Đang tạo giọng theo cụm ${clusterIndex + 1}/${plan.clusters.length}`
      });

      const voiceProvider = project.voiceProvider || settings.defaultVoiceProvider || "edge_neural";
      const rawVoicePath = path.join(paths.audioDir, `${cluster.clusterId}${audioExtensionForProvider(voiceProvider)}`);
      const fittedVoicePath = path.join(paths.audioDir, `${cluster.clusterId}.m4a`);
      let rawDuration = cluster.targetDuration;
      let outputDuration = cluster.targetDuration;
      let fitStrategy = "natural";
      let ttsStatus = "ok";
      let trimmed = false;
      try {
        await this.synthesizeDubbingVoice({
          settings,
          project,
          text: cluster.adaptedText || cluster.translatedText || " ",
          outputPath: rawVoicePath,
          durationSec: cluster.targetDuration,
          onProgress: (message) => onProgress?.({ projectId, step: "voice", percent: 24, message })
        });
        const fit = await ffmpeg.fitDubbingClusterAudio({
          inputPath: rawVoicePath,
          outputPath: fittedVoicePath,
          targetDuration: cluster.targetDuration,
          maxStretchRatio: project.dubbingMaxSafeStretch || settings.dubbingMaxSafeStretch || 0.08,
          normalize: project.dubbingVoiceNormalize ?? settings.dubbingVoiceNormalize ?? true,
          allowTrim: project.dubbingAllowStrictTrim || settings.dubbingAllowStrictTrim || false
        });
        rawDuration = fit.rawDuration;
        outputDuration = fit.outputDuration;
        fitStrategy = fit.fitStrategy;
        trimmed = fit.trimmed;
      } catch (error) {
        ttsStatus = "tts_failed";
        warnings.push(`TTS lỗi ở ${cluster.clusterId}; đã chèn khoảng lặng (${error.message}).`);
        await this.createSilentAudio(ffmpeg, fittedVoicePath, cluster.targetDuration);
        outputDuration = cluster.targetDuration;
        fitStrategy = "tts_failed_silence";
      }

      audioPieces.push(fittedVoicePath);
      subtitleSegments.push(...planner.buildSubtitleSegments(cluster, clusterStart, outputDuration));
      durationFitReport.push({
        clusterId: cluster.clusterId,
        sourceSegmentIds: cluster.sourceSegmentIds,
        speaker: cluster.speakerId,
        start: cluster.start,
        placedStart: Number(clusterStart.toFixed(3)),
        targetDuration: cluster.targetDuration,
        estimatedSpeechDuration: cluster.estimatedSpeechDuration,
        rawVoiceDuration: Number(rawDuration.toFixed(3)),
        outputDuration: Number(outputDuration.toFixed(3)),
        speedRatio: Number((rawDuration / Math.max(0.3, cluster.targetDuration)).toFixed(3)),
        fitStrategy,
        trimmed,
        ttsStatus,
        risk: cluster.risk || [],
        text: cluster.adaptedText
      });
      cursor = clusterStart + outputDuration;
    }

    if (sourceMeta.duration > cursor + 0.05) {
      const tailPath = path.join(paths.audioDir, "tail-gap.m4a");
      await this.createSilentAudio(ffmpeg, tailPath, sourceMeta.duration - cursor);
      audioPieces.push(tailPath);
    }

    await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "rendering", percent: 70, message: "Đang ghép track giọng speech-first" });
    await ffmpeg.concatAudioSegments(audioPieces, narrationTrackPath);
    await this.projectStore.writeText(subtitlePath, buildSrt(subtitleSegments, "translatedText"));
    await this.projectStore.writeJson(subtitleAlignmentReportPath, {
      generatedAt: new Date().toISOString(),
      provider: "cluster_text_distribution",
      subtitleCount: subtitleSegments.length,
      clusters: plan.clusters.map((cluster) => ({
        clusterId: cluster.clusterId,
        sourceSegmentIds: cluster.sourceSegmentIds
      }))
    });
    await this.projectStore.writeJson(durationFitReportPath, {
      generatedAt: new Date().toISOString(),
      mode: "speech_first_clustered",
      passed: !durationFitReport.some((item) => item.trimmed || item.ttsStatus !== "ok"),
      warnings: durationFitReport.filter((item) => item.fitStrategy !== "natural" || item.risk?.length),
      clusters: durationFitReport
    });
    const dubbingQa = this.buildSpeechFirstQa({ plan, durationFitReport, warnings });
    await this.projectStore.writeJson(qaPath, dubbingQa);

    await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "rendering", percent: 78, message: "Đang trộn giọng đã normalize với âm thanh gốc" });
    await ffmpeg.mixVideoAudioWithVoice({
      videoPath: project.sourceVideoPath,
      voicePath: narrationTrackPath,
      outputPath: voicedPath,
      sourceVolume: Math.max(0, Number(project.mixer?.sourceVolume ?? 20) / 100),
      voiceVolume: 1.0,
      limiter: true
    });

    if (project.showSubtitles === false) {
      await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "rendering", percent: 86, message: "Đang xuất video không kèm phụ đề" });
      await ffmpeg.copyMedia({ inputPath: voicedPath, outputPath: undecoratedOutputPath });
    } else {
      await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "rendering", percent: 86, message: "Đang chèn phụ đề đã căn theo cụm" });
      let effectiveSubtitlePath = subtitlePath;
      if (project.videoDecoration?.subtitleStyle === "tiktok_karaoke") {
        const assPath = subtitlePath.replace(/\.srt$/, ".ass");
        const assContent = buildTikTokKaraokeAssContent(buildWordTimestampsFromSegments(subtitleSegments));
        await this.projectStore.writeText(assPath, assContent);
        effectiveSubtitlePath = assPath;
      }
      await ffmpeg.burnSubtitles({ videoPath: voicedPath, subtitlePath: effectiveSubtitlePath, outputPath: undecoratedOutputPath });
    }
    await this.applyProjectVideoDecoration({
      ffmpeg,
      project,
      paths,
      inputPath: undecoratedOutputPath,
      outputPath,
      name: "dubbing-final"
    });
    const publishedOutputPath = await publishFinalVideo({
      settings,
      project,
      sourcePath: outputPath,
      mode: "dubbing"
    });
    const finalRenderedAt = new Date().toISOString();

    const runHistory = Array.isArray(project.runHistory) ? [...project.runHistory] : [];
    runHistory.unshift({
      renderedAt: finalRenderedAt,
      finalVideoPath: publishedOutputPath,
      internalFinalVideoPath: outputPath,
      subtitlePath,
      narrationTrackPath,
      mode: "dubbing",
      dubbingRenderMode: "speech_first_clustered"
    });

    return await this.emitProgress({
      workspaceRoot,
      projectId,
      onProgress,
      step: "done",
      percent: 100,
      message: "Bản xuất dubbing speech-first đã sẵn sàng",
      partial: {
        artifacts: {
          finalVideoPath: publishedOutputPath,
          internalFinalVideoPath: outputPath,
          finalRenderedAt,
          subtitlePath,
          voicedOutputPath: voicedPath,
          narrationTrackPath,
          durationFitReportPath,
          speechPlanPath,
          subtitleAlignmentReportPath,
          dubbingQaPath: qaPath
        },
        analysis: {
          ...(project.analysis || {}),
          renderSegments: subtitleSegments,
          dubbingQa,
          warnings
        },
        runHistory
      }
    });
  }

  async renderLegacyProject({ workspaceRoot, projectId, settings, onProgress }) {
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const ffmpeg = new FfmpegService(settings);
    const segments = project.analysis?.segments || [];
    if (!segments.length) {
      throw new Error("Không có phân đoạn phụ đề để render.");
    }

    await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "rendering", percent: 20, message: "Đang chuẩn bị timeline phụ đề và giọng đọc" });
    const subtitlePath = path.join(paths.outputDir, "dubbing-export.srt");
    const voicedPath = path.join(paths.outputDir, "dubbing-voiced.mp4");
    const outputPath = path.join(paths.outputDir, "dubbing-final.mp4");
    const undecoratedOutputPath = path.join(paths.tempDir, "dubbing-legacy-final-base.mp4");
    const durationFitReportPath = path.join(paths.outputDir, "duration-fit-report.json");

    let videoForSubtitles = project.sourceVideoPath;
    let narrationTrackPath = "";
    let exportSegments = segments;
    const warnings = [...(project.analysis?.warnings || [])];
    const durationFitReport = [];

    try {
      const audioPieces = [];
      const timedSegments = [];
      const sourceMeta = await ffmpeg.probeVideo(project.sourceVideoPath);
      let cursor = 0;
      for (const segment of segments) {
        const index = Number(segment.index || audioPieces.length);
        const startSec = Math.max(0, Number(segment.startSec || 0));
        const endSec = Math.max(startSec + 0.2, Number(segment.endSec || startSec + 1));
        const sourceDuration = Math.max(0.2, endSec - startSec);
        const voiceStartSec = Math.max(startSec, cursor);

        if (voiceStartSec > cursor + 0.05) {
          const gapPath = path.join(paths.audioDir, `gap-${String(index).padStart(4, "0")}.m4a`);
          await this.createSilentAudio(ffmpeg, gapPath, voiceStartSec - cursor);
          audioPieces.push(gapPath);
        }

        await this.emitProgress({
          workspaceRoot,
          projectId,
          onProgress,
          step: "rendering",
          percent: Math.min(65, 24 + Math.round((index / Math.max(1, segments.length)) * 36)),
          message: `Đang tạo giọng ${index + 1}/${segments.length}`
        });

        const voiceProvider = project.voiceProvider || settings.defaultVoiceProvider || "edge_neural";
        const rawVoicePath = path.join(paths.audioDir, `voice-${String(index + 1).padStart(4, "0")}${audioExtensionForProvider(voiceProvider)}`);
        const fittedVoicePath = path.join(paths.audioDir, `voice-${String(index + 1).padStart(4, "0")}-fit.m4a`);
        const dubbingText = segment.dubbingLine || segment.translatedText || segment.text || " ";
        let rawDuration = sourceDuration;
        let ttsStatus = "ok";
        try {
          await this.synthesizeDubbingVoice({
            settings,
            project,
            text: dubbingText,
            outputPath: rawVoicePath,
            durationSec: sourceDuration,
            onProgress: (message) => onProgress?.({ projectId, step: "voice", percent: 24, message })
          });
          const rawMeta = await ffmpeg.probeAudio(rawVoicePath);
          rawDuration = Math.max(0.2, Number(rawMeta.duration || sourceDuration));
          await ffmpeg.fitAudioToDuration({
            inputPath: rawVoicePath,
            outputPath: fittedVoicePath,
            targetDuration: sourceDuration
          });
        } catch (error) {
          ttsStatus = "tts_failed_silence";
          warnings.push(`TTS lỗi ở phân đoạn ${index + 1}; đã chèn khoảng lặng (${error.message}).`);
          await this.createSilentAudio(ffmpeg, fittedVoicePath, sourceDuration);
        }
        const requestedRate = rawDuration / sourceDuration;
        const fittedDuration = sourceDuration;
        if (requestedRate > 1.18) {
          warnings.push(
            `Rủi ro lệch thời lượng giọng ở phân đoạn ${index + 1}: audio gốc ${rawDuration.toFixed(2)} giây phải khớp ${sourceDuration.toFixed(2)} giây. Hãy rút gọn câu dubbing nếu nghe bị gấp.`
          );
        }
        audioPieces.push(fittedVoicePath);
        const voiceEndSec = voiceStartSec + fittedDuration;
        timedSegments.push({
          ...segment,
          originalStartSec: segment.startSec,
          originalEndSec: segment.endSec,
          startSec: Number(voiceStartSec.toFixed(3)),
          endSec: Number(voiceEndSec.toFixed(3)),
          duration: Number(fittedDuration.toFixed(3)),
          translatedText: dubbingText,
          dubbingLine: dubbingText
        });
        durationFitReport.push({
          id: segment.id,
          index,
          speaker: segment.speaker || "",
          sourceDuration: Number(sourceDuration.toFixed(3)),
          rawVoiceDuration: Number(rawDuration.toFixed(3)),
          fittedDuration: Number(fittedDuration.toFixed(3)),
          speedRatio: Number(requestedRate.toFixed(3)),
          status: ttsStatus !== "ok" ? ttsStatus : requestedRate > 1.35 ? "error" : requestedRate > 1.18 ? "warning" : "ok",
          text: dubbingText
        });
        cursor = voiceEndSec;
      }

      if (sourceMeta.duration > cursor + 0.05) {
        const tailPath = path.join(paths.audioDir, "tail-gap.m4a");
        await this.createSilentAudio(ffmpeg, tailPath, sourceMeta.duration - cursor);
        audioPieces.push(tailPath);
      }

      exportSegments = timedSegments.length ? timedSegments : segments;
      narrationTrackPath = path.join(paths.outputDir, "dubbing-voice-track.m4a");
      await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "rendering", percent: 68, message: "Đang ghép track giọng đọc" });
      await ffmpeg.concatAudioSegments(audioPieces, narrationTrackPath);
      await this.projectStore.writeJson(durationFitReportPath, {
        generatedAt: new Date().toISOString(),
        passed: !durationFitReport.some((item) => item.status === "error"),
        warnings: durationFitReport.filter((item) => item.status !== "ok"),
        segments: durationFitReport
      });
      await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "rendering", percent: 76, message: "Đang trộn giọng thuyết minh với âm thanh gốc" });
      await ffmpeg.mixVideoAudioWithVoice({
        videoPath: project.sourceVideoPath,
        voicePath: narrationTrackPath,
        outputPath: voicedPath,
        sourceVolume: Math.max(0, Number(project.mixer?.sourceVolume ?? 20) / 100),
        voiceVolume: Math.max(0.2, Number(project.mixer?.voiceVolume ?? 100) / 100),
        limiter: true
      });
      videoForSubtitles = voicedPath;
    } catch (error) {
      warnings.push(`Đã bỏ qua render giọng TTS: ${error.message}`);
    }

    await this.projectStore.writeText(subtitlePath, buildSrt(exportSegments, "translatedText"));

    if (project.showSubtitles === false) {
      await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "rendering", percent: 84, message: "Đang xuất video không kèm phụ đề" });
      await ffmpeg.copyMedia({ inputPath: videoForSubtitles, outputPath: undecoratedOutputPath });
    } else {
      await this.emitProgress({ workspaceRoot, projectId, onProgress, step: "rendering", percent: 84, message: "Đang chèn phụ đề vào video" });
      let effectiveSubtitlePath = subtitlePath;
      if (project.videoDecoration?.subtitleStyle === "tiktok_karaoke") {
        const assPath = subtitlePath.replace(/\.srt$/, ".ass");
        const assContent = buildTikTokKaraokeAssContent(buildWordTimestampsFromSegments(exportSegments));
        await this.projectStore.writeText(assPath, assContent);
        effectiveSubtitlePath = assPath;
      }
      await ffmpeg.burnSubtitles({
        videoPath: videoForSubtitles,
        subtitlePath: effectiveSubtitlePath,
        outputPath: undecoratedOutputPath
      });
    }
    await this.applyProjectVideoDecoration({
      ffmpeg,
      project,
      paths,
      inputPath: undecoratedOutputPath,
      outputPath,
      name: "dubbing-final"
    });
    const publishedOutputPath = await publishFinalVideo({
      settings,
      project,
      sourcePath: outputPath,
      mode: "dubbing"
    });
    const finalRenderedAt = new Date().toISOString();

    const runHistory = Array.isArray(project.runHistory) ? [...project.runHistory] : [];
    runHistory.unshift({
      renderedAt: finalRenderedAt,
      finalVideoPath: publishedOutputPath,
      internalFinalVideoPath: outputPath,
      subtitlePath,
      narrationTrackPath,
      mode: "dubbing"
    });

    return await this.emitProgress({
      workspaceRoot,
      projectId,
      onProgress,
      step: "done",
      percent: 100,
      message: "Bản xuất dubbing đã sẵn sàng",
      partial: {
        artifacts: {
          finalVideoPath: publishedOutputPath,
          internalFinalVideoPath: outputPath,
          finalRenderedAt,
          subtitlePath,
          voicedOutputPath: videoForSubtitles === voicedPath ? voicedPath : "",
          narrationTrackPath,
          durationFitReportPath
        },
        analysis: {
          ...(project.analysis || {}),
          renderSegments: exportSegments,
          dubbingQa: buildDubbingQa(exportSegments),
          warnings
        },
        runHistory
      }
    });
  }
}

module.exports = DubbingService;
module.exports.validateManualGeminiScript = validateManualGeminiScript;
module.exports.coalesceContiguousOriginalAudioSegments = coalesceContiguousOriginalAudioSegments;
module.exports.shouldUseStorytimeVoiceBatch = shouldUseStorytimeVoiceBatch;
module.exports.buildExportFilePath = buildExportFilePath;
module.exports.publishDraftVideo = publishDraftVideo;
module.exports.canReuseAutoStoryDraft = canReuseAutoStoryDraft;
module.exports.resolveVideoCanvasDimensions = resolveVideoCanvasDimensions;
module.exports.resolveVideoTitleRasterDimensions = resolveVideoTitleRasterDimensions;
module.exports.buildVideoTitleOverlaySvg = buildVideoTitleOverlaySvg;
module.exports.resolveSourceSubtitleMask = resolveSourceSubtitleMask;
module.exports.resolveManualGeminiManifestPath = resolveManualGeminiManifestPath;
module.exports.wrapVideoTitle = wrapVideoTitle;
module.exports.calculateVideoTitleWrapChars = calculateVideoTitleWrapChars;
module.exports.snapshotHighlightRevision = snapshotHighlightRevision;
module.exports.appendHighlightRevisionHistory = appendHighlightRevisionHistory;
module.exports.hydrateDraftReviewStructure = hydrateDraftReviewStructure;
module.exports.buildDraftReviewReadiness = buildDraftReviewReadiness;
module.exports.buildDraftVoiceAlignmentReport = buildDraftVoiceAlignmentReport;
module.exports.buildDraftVoiceGeminiPrompt = buildDraftVoiceGeminiPrompt;
module.exports.normalizeHighlightCutScript = normalizeHighlightCutScript;
module.exports.narratedBlockRuns = narratedBlockRuns;
module.exports.placeNarratedBlocks = placeNarratedBlocks;
module.exports.autoStoryDraftKey = autoStoryDraftKey;
module.exports.resolveReviewedHighlightVariant = resolveReviewedHighlightVariant;
module.exports.getInspectedDraftRevision = getInspectedDraftRevision;
module.exports.resolveDraftReviewBinding = resolveDraftReviewBinding;
module.exports.resolveSuggestedTopCaption = resolveSuggestedTopCaption;
module.exports.resolvePartLabelText = resolvePartLabelText;
module.exports.resolveEffectiveVideoEditProject = resolveEffectiveVideoEditProject;
module.exports.resolveVariantFileMetadata = resolveVariantFileMetadata;
module.exports.getSegmentVoiceRenderOptions = getSegmentVoiceRenderOptions;
module.exports.getEdgeRateWithDelivery = getEdgeRateWithDelivery;
module.exports.splitTextAfterPhrase = splitTextAfterPhrase;
module.exports.getVoiceCacheInfo = getVoiceCacheInfo;
module.exports.splitSubtitlePhrases = splitSubtitlePhrases;
module.exports.buildTimedSubtitlePhrases = buildTimedSubtitlePhrases;
module.exports.buildSrt = buildSrt;
module.exports.getOriginalAudioTranscriptCandidate = getOriginalAudioTranscriptCandidate;
module.exports.shouldUseOriginalAudioTranscriptCandidate = shouldUseOriginalAudioTranscriptCandidate;
module.exports.getHighlightNarrationSourceVolume = getHighlightNarrationSourceVolume;
module.exports.normalizeRollingSubtitleCues = normalizeRollingSubtitleCues;
module.exports.buildDraftVoiceTranscriptEntries = buildDraftVoiceTranscriptEntries;

