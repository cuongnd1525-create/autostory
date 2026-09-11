const path = require("path");
const fs = require("fs/promises");

const GeminiService = require("./geminiService");
const ElevenLabsService = require("./elevenLabsService");
const FfmpegService = require("./ffmpegService");
const WindowsVoiceService = require("./windowsVoiceService");
const EdgeTtsService = require("./edgeTtsService");
const OmniVoiceService = require("./omniVoiceService");
const KokoroVoiceService = require("./kokoroVoiceService");
const SceneDetectionService = require("./sceneDetectionService");
const SceneMetadataService = require("./sceneMetadataService");
const { EvidenceStoreService } = require("./evidenceStoreService");
const { EvidenceGraphService } = require("./evidenceGraphService");
const { CharacterTrackingService } = require("./characterTrackingService");
const SubtitleService = require("./subtitleService");
const RenderQaService = require("./renderQaService");
const VoiceVisualAlignmentService = require("./voiceVisualAlignmentService");
const NarrationGroundingService = require("./narrationGroundingService");
const NarrationProvenanceService = require("./narrationProvenanceService");
const EvidenceQaService = require("./evidenceQaService");
const { ViralIntelligenceService } = require("./viralIntelligenceService");
const { createAiProvider, LocalFallbackProvider } = require("./aiProviderRegistry");
const { DEFAULT_WORDS_PER_SECOND } = require("./voiceTimingPolicy");

const VALID_ROLES = ["hook", "setup", "conflict", "escalation", "cliffhanger"];
const ONE_GB = 1024 * 1024 * 1024;
const STRICT_SYNC_MAX_DRIFT_SEC = 0.12;
const VIRAL_ANGLES = [
  {
    id: "survival",
    label: "Angle Sinh ton",
    instruction: "Emphasize hunger, poison, weather, injury, being hunted, and immediate physical danger."
  },
  {
    id: "revenge",
    label: "Angle Tra thu",
    instruction: "Emphasize the unfair starting wound, humiliation, rage, payback, and emotional satisfaction."
  },
  {
    id: "intelligence",
    label: "Angle Tri tue",
    instruction: "Emphasize how the character survives by noticing rules, exploiting weaknesses, and thinking faster than the threat."
  },
  {
    id: "bizarre_rules",
    label: "Angle The gioi quai di",
    instruction: "Emphasize the weird rule of the world, the one detail that feels wrong, and why normal logic fails here."
  },
  {
    id: "injustice",
    label: "Angle Uc che",
    instruction: "Emphasize helplessness, unfair pressure, betrayal, impossible choices, and why the audience should feel angry or protective."
  },
  {
    id: "curiosity_gap",
    label: "Angle Bi an",
    instruction: "Emphasize the unanswered question, suspicious detail, hidden motive, and the reason viewers must wait for the payoff."
  }
];

function isAntigravityQuotaError(error) {
  return /quota|weekly limit|individual quota|rate limit|upgrade your subscription|resets in/i.test(error?.message || "");
}

function hashString(input) {
  let hash = 0;
  const text = String(input || "");
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function selectViralAngle(project, genreMode) {
  const selectedSetting = safeText(project.viralAngleSetting).toLowerCase();
  const explicitMap = {
    mystery_first: "curiosity_gap",
    injustice_first: "injustice",
    shock_first: "survival",
    character_arc: "intelligence",
    villain_pov: "bizarre_rules",
    moral_dilemma: "injustice"
  };
  if (selectedSetting && selectedSetting !== "auto") {
    const explicit = VIRAL_ANGLES.find((angle) => angle.id === (explicitMap[selectedSetting] || selectedSetting));
    if (explicit) {
      return explicit;
    }
  }
  const preferred = {
    action: ["survival", "revenge", "intelligence"],
    thriller: ["bizarre_rules", "survival", "curiosity_gap"],
    mystery: ["curiosity_gap", "intelligence", "injustice"],
    drama: ["injustice", "revenge", "curiosity_gap"],
    comedy: ["bizarre_rules", "injustice", "curiosity_gap"],
    healing: ["injustice", "curiosity_gap", "survival"],
    "sci-fi": ["bizarre_rules", "intelligence", "curiosity_gap"]
  };
  const poolIds = preferred[genreMode] || VIRAL_ANGLES.map((angle) => angle.id);
  const pool = poolIds.map((id) => VIRAL_ANGLES.find((angle) => angle.id === id)).filter(Boolean);
  return pool[hashString(`${project.id}:${project.sourceVideoPath}:${genreMode}`) % pool.length] || VIRAL_ANGLES[0];
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= ONE_GB) {
    return `${(value / ONE_GB).toFixed(1)} GB`;
  }
  return `${(value / (1024 * 1024)).toFixed(0)} MB`;
}

async function getFreeDiskBytes(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
  const stats = await fs.statfs(dirPath);
  return Number(stats.bavail || stats.bfree || 0) * Number(stats.bsize || 0);
}

async function assertEnoughRenderDiskSpace(paths, targetDuration) {
  const safeTargetDuration = Math.max(8, Number(targetDuration || 30));
  const estimatedBytes = Math.max(2 * ONE_GB, safeTargetDuration * 45 * 1024 * 1024);
  let freeBytes = 0;
  try {
    freeBytes = await getFreeDiskBytes(paths.rootDir);
  } catch (_error) {
    return;
  }
  if (freeBytes < estimatedBytes) {
    throw new Error(
      `Not enough free disk space for rendering. Workspace drive has ${formatBytes(freeBytes)} free, ` +
      `but this render needs about ${formatBytes(estimatedBytes)} for clips, raw video, voiced video, and final output. ` +
      "H�y gi?i ph�ng dung lu?ng ? n�y ho?c chuy?n Thu m?c l�m vi?c trong C�i d?t sang ? l?n hon, v� d? D:\\."
    );
  }
}

function getSourceAudioVolume(role, genreMode) {
  const table = {
    thriller: { hook: 0.05, setup: 0.12, conflict: 0.25, escalation: 0.55, cliffhanger: 0.15 },
    action:   { hook: 0.45, setup: 0.30, conflict: 0.40, escalation: 0.50, cliffhanger: 0.25 },
    healing:  { hook: 0.10, setup: 0.12, conflict: 0.15, escalation: 0.20, cliffhanger: 0.10 },
    drama:    { hook: 0.15, setup: 0.10, conflict: 0.20, escalation: 0.35, cliffhanger: 0.20 },
    mystery:  { hook: 0.10, setup: 0.15, conflict: 0.25, escalation: 0.40, cliffhanger: 0.15 },
    comedy:   { hook: 0.25, setup: 0.20, conflict: 0.30, escalation: 0.45, cliffhanger: 0.30 },
    "sci-fi": { hook: 0.35, setup: 0.20, conflict: 0.35, escalation: 0.60, cliffhanger: 0.25 }
  };
  return (table[genreMode] || table.thriller)[role] || 0.20;
}

function getPerformanceModeForRole(role) {
  if (role === "hook") return "hook";
  if (role === "setup") return "narration";
  if (role === "conflict") return "story";
  if (role === "escalation") return "panic";
  if (role === "cliffhanger") return "cliffhanger";
  return "story";
}

function getSpeedFactor(role, genreMode) {
  const table = {
    thriller: { hook: 0.85, setup: 1.0, conflict: 1.0, escalation: 1.15, cliffhanger: 0.90 },
    action:   { hook: 1.0, setup: 1.20, conflict: 1.10, escalation: 1.25, cliffhanger: 1.0 },
    healing:  { hook: 0.80, setup: 0.95, conflict: 1.0, escalation: 1.0, cliffhanger: 0.85 },
    drama:    { hook: 0.85, setup: 1.0, conflict: 1.05, escalation: 1.10, cliffhanger: 0.90 },
    mystery:  { hook: 0.90, setup: 0.95, conflict: 1.0, escalation: 1.10, cliffhanger: 0.85 },
    comedy:   { hook: 1.15, setup: 1.10, conflict: 1.15, escalation: 1.25, cliffhanger: 1.10 },
    "sci-fi": { hook: 1.0, setup: 1.05, conflict: 1.10, escalation: 1.20, cliffhanger: 0.95 }
  };
  return (table[genreMode] || table.thriller)[role] || 1.0;
}

function getTransitionConfig(fromRole, toRole, genreMode) {
  if (fromRole === "hook" && toRole === "setup") return { type: "none", duration: 0 };
  if (fromRole === "conflict" && toRole === "escalation") return { type: "none", duration: 0 };
  
  if (genreMode === "action") {
    if (fromRole === "setup" && toRole === "conflict") return { type: "slideright", duration: 0.20 };
    if (fromRole === "escalation" && toRole === "cliffhanger") return { type: "wiperight", duration: 0.25 };
    return { type: "slideright", duration: 0.20 };
  }
  if (genreMode === "healing" || genreMode === "drama") {
    if (fromRole === "setup" && toRole === "conflict") return { type: "dissolve", duration: 0.40 };
    if (fromRole === "escalation" && toRole === "cliffhanger") return { type: "radial", duration: 0.45 };
    return { type: "dissolve", duration: 0.35 };
  }
  if (genreMode === "comedy") {
    return { type: "pixelize", duration: 0.20 };
  }
  if (genreMode === "mystery" || genreMode === "sci-fi") {
    if (fromRole === "setup" && toRole === "conflict") return { type: "fadeblack", duration: 0.35 };
    return { type: "fade", duration: 0.30 };
  }

  // default thriller
  if (fromRole === "setup" && toRole === "conflict") return { type: "fade", duration: 0.15 };
  if (fromRole === "escalation" && toRole === "cliffhanger") return { type: "fadeblack", duration: 0.35 };
  return { type: "fade", duration: 0.24 };
}

function buildTransitionPlan(segments, genreMode) {
  const transitions = [];
  for (let i = 0; i < segments.length - 1; i += 1) {
    transitions.push(getTransitionConfig(segments[i].role, segments[i + 1].role, genreMode));
  }
  return transitions;
}

function buildSegmentLockedTransitionPlan(segments) {
  return (Array.isArray(segments) ? segments : []).slice(0, -1).map(() => ({
    type: "none",
    duration: 0
  }));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function secondsToSrtTime(totalSeconds) {
  const safe = Math.max(0, Number(totalSeconds || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = Math.floor(safe % 60);
  const milliseconds = Math.min(999, Math.round((safe - Math.floor(safe)) * 1000));
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}

function secondsToAssTime(totalSeconds) {
  const safe = Math.max(0, Number(totalSeconds || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = Math.floor(safe % 60);
  const centiseconds = Math.min(99, Math.round((safe - Math.floor(safe)) * 100));
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function buildAssFileContent(subtitleEntries, verticalWidth = 1080, verticalHeight = 1920) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${verticalWidth}
PlayResY: ${verticalHeight}
WrapStyle: 1

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,60,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,5,10,10,250,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const dialogueLines = subtitleEntries.map((entry) => {
    let text = entry.text;
    const keywords = entry.keywords || [];
    if (keywords.length > 0) {
      for (const kw of keywords) {
        if (!kw) continue;
        const regex = new RegExp(`\\b${kw}\\b`, 'gi');
        const color = entry.font_style === "horror_red" ? "&H000000FF&" : "&H0000FFFF&";
        text = text.replace(regex, `{\\c${color}}$&{\\c&H00FFFFFF&}`);
      }
    }
    
    if (entry.font_style === "shake_intense") {
      text = `{\\fscx110\\fscy110\\t(0,100,\\fscx100\\fscy100)}${text}`;
    }

    return `Dialogue: 0,${secondsToAssTime(entry.startSec)},${secondsToAssTime(entry.endSec)},Default,,0,0,0,,${text}`;
  });

  return header + dialogueLines.join("\n");
}

function safeText(value, fallback = "") {
  return String(value || fallback).replace(/\s+/g, " ").trim();
}

function countSpokenWords(text) {
  return safeText(text).split(/\s+/).filter(Boolean).length;
}

function estimateSpeechSeconds(text, voiceSpeed = 1) {
  const speed = Math.max(0.7, Math.min(1.5, safeNumber(voiceSpeed, 1)));
  return countSpokenWords(text) / (2.55 * speed);
}

function getHighlightVoiceoverLine(segment = {}) {
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

function buildHighlightRewriteFallback(segment = {}, narrationLine = "", sceneDurationSec = 0, voiceSpeed = 1) {
  const targetWords = Math.max(10, Math.round(Number(sceneDurationSec || 0) * 1.45 * Math.max(0.8, Math.min(1.2, Number(voiceSpeed || 1)))));
  const pieces = [
    narrationLine,
    segment.caption,
    segment.sceneType || segment.scene_type,
    segment.actionNotes || segment.action_notes,
    segment.text
  ].map((value) => safeText(value))
    .filter(Boolean)
    .map((value) => value.replace(/[^\p{L}\p{N}\s.,!?'"-]/gu, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const uniquePieces = [];
  for (const piece of pieces) {
    const normalized = piece.toLowerCase();
    if (!uniquePieces.some((existing) => existing.toLowerCase().includes(normalized) || normalized.includes(existing.toLowerCase()))) {
      uniquePieces.push(piece);
    }
  }
  let rewrite = uniquePieces.shift() || "This moment reveals an important detail in the case.";
  for (const piece of uniquePieces) {
    if (countSpokenWords(rewrite) >= targetWords) break;
    rewrite = `${rewrite} ${piece}`;
  }
  if (countSpokenWords(rewrite) < targetWords) {
    rewrite = `${rewrite} Keep watching this moment closely, because the next detail explains why this scene matters.`;
  }
  return safeText(rewrite);
}

function getNarrationWordTargets(targetDuration, voiceSpeed = 1) {
  const speed = Math.max(0.7, Math.min(1.5, Number(voiceSpeed || 1)));
  const targetWords = Math.max(18, Math.round(Number(targetDuration || 30) * DEFAULT_WORDS_PER_SECOND * speed));
  const minWords = Math.max(14, Math.round(targetWords * 0.90));
  const maxWords = Math.max(minWords + 6, Math.round(targetWords * 1.10));
  return { targetWords, minWords, maxWords, voiceSpeed: speed };
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampScore(value, fallback = 5) {
  return clamp(safeNumber(value, fallback), 1, 10);
}

function getGenreVoicePreset(genreMode) {
  const presets = {
    thriller: { label: "Thriller tense", windowsRate: -1, minSpeechRate: 0.88, maxSpeechRate: 1.08, pauseStyle: "suspense" },
    action: { label: "Action urgent", windowsRate: 2, minSpeechRate: 1.02, maxSpeechRate: 1.22, pauseStyle: "fast" },
    healing: { label: "Warm emotional", windowsRate: -2, minSpeechRate: 0.82, maxSpeechRate: 1.02, pauseStyle: "soft" },
    drama: { label: "Drama emotional", windowsRate: -1, minSpeechRate: 0.86, maxSpeechRate: 1.06, pauseStyle: "emotional" },
    mystery: { label: "Mystery controlled", windowsRate: -1, minSpeechRate: 0.88, maxSpeechRate: 1.07, pauseStyle: "suspense" },
    comedy: { label: "Comedy quick", windowsRate: 2, minSpeechRate: 1.00, maxSpeechRate: 1.20, pauseStyle: "fast" },
    "sci-fi": { label: "Sci-fi awe", windowsRate: 0, minSpeechRate: 0.92, maxSpeechRate: 1.12, pauseStyle: "cinematic" }
  };
  return presets[genreMode] || presets.thriller;
}

function polishNarrationText(text, role, genreMode) {
  let clean = safeText(text);
  if (!clean) {
    return "";
  }

  clean = clean
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\.{4,}/g, "...")
    .replace(/([.!?])\s+/g, "$1 ");

  const preset = getGenreVoicePreset(genreMode);
  if ((preset.pauseStyle === "suspense" || role === "cliffhanger") && clean.length > 52 && !clean.includes("...")) {
    const commaIndex = clean.indexOf(",");
    if (commaIndex > 18 && commaIndex < clean.length - 14) {
      clean = `${clean.slice(0, commaIndex)}...${clean.slice(commaIndex + 1)}`;
    }
  }

  return clean;
}

function scoreSceneQuality(segment) {
  const visualClarityScore = clampScore(segment.visualClarityScore, segment.role === "setup" ? 7 : 6);
  const emotionScore = clampScore(segment.emotionScore, 6);
  const motionScore = clampScore(segment.motionScore, segment.role === "escalation" ? 8 : 5);
  const contextScore = clampScore(segment.contextScore, segment.role === "setup" ? 8 : 6);
  const dialogueDependency = clampScore(segment.dialogueDependency, 4);
  const spoilerRisk = clampScore(segment.spoilerRisk, 4);
  const viralScore = clampScore(segment.viralScore || segment.importanceScore, 6);

  const qualityScore = clamp(
    (visualClarityScore * 0.24) +
    (emotionScore * 0.22) +
    (motionScore * 0.18) +
    (contextScore * 0.18) +
    (viralScore * 0.18) -
    (dialogueDependency * 0.12) -
    (spoilerRisk * 0.04),
    1,
    10
  );

  return {
    visualClarityScore,
    emotionScore,
    motionScore,
    contextScore,
    dialogueDependency,
    spoilerRisk,
    qualityScore: Number(qualityScore.toFixed(1))
  };
}

function normalizeCandidateScenes(rawCandidates, sourceDuration, spoilerMode = "medium") {
  const candidates = Array.isArray(rawCandidates) ? rawCandidates : [];
  return candidates
    .map((candidate, index) => {
      const startSec = clamp(safeNumber(candidate.startSec, 0), 0, Math.max(0, sourceDuration - 0.4));
      const endSec = clamp(safeNumber(candidate.endSec, startSec + 2.5), startSec + 0.4, sourceDuration);
      const role = safeText(candidate.role, "cutaway").toLowerCase();
      const quality = scoreSceneQuality({
        ...candidate,
        role,
        viralScore: candidate.viralScore || 5
      });
      const tensionScore = clampScore(candidate.tensionScore, role === "escalation" ? 8 : 6);
      const continuityScore = clampScore(candidate.continuityScore, 6);
      const plotImportanceScore = clampScore(candidate.plotImportanceScore, 6);
      const retentionScore = clampScore(candidate.retentionScore || candidate.viralScore, 6);
      const standaloneScore = clampScore(candidate.standaloneScore || candidate.contextScore, 6);
      const noveltyScore = clampScore(candidate.noveltyScore, 5);
      const suddenVisualChangeScore = clampScore(candidate.suddenVisualChangeScore, 5);
      const openingImpactScore = clampScore(candidate.openingImpactScore, role === "hook" ? 7 : 5);
      const hasShockException = ["shock", "fear", "dread", "awe"].includes(safeText(candidate.emotionalAnchor).toLowerCase())
        || /blood|gore|transform|mutation|monster|reveal|explosion|fall|crash|kill/i.test(`${candidate.description || ""} ${candidate.reason || ""}`);
      const staticDialoguePenalty = quality.motionScore <= 4 && quality.dialogueDependency >= 7 && !hasShockException ? 2.6 : 0;
      const visualHookBoost = role === "hook" && (
        suddenVisualChangeScore >= 8
        || openingImpactScore >= 8
        || (quality.motionScore >= 8 && clampScore(candidate.visual_energy || candidate.motionScore, 6) >= 8)
      ) ? 1.35 : 0;
      const spoilerPenalty = spoilerMode === "low" ? quality.spoilerRisk * 0.22 : spoilerMode === "medium" ? quality.spoilerRisk * 0.10 : 0;
      const sceneValue = clamp(
        quality.visualClarityScore * 0.16 +
        quality.emotionScore * 0.14 +
        quality.motionScore * 0.12 +
        tensionScore * 0.13 +
        quality.contextScore * 0.10 +
        continuityScore * 0.07 +
        clampScore(candidate.viralScore, 6) * 0.10 +
        plotImportanceScore * 0.08 +
        retentionScore * 0.07 +
        standaloneScore * 0.05 +
        noveltyScore * 0.04 -
        quality.dialogueDependency * 0.10 -
        spoilerPenalty -
        staticDialoguePenalty +
        visualHookBoost,
        1,
        10
      );

      return {
        id: `candidate-${String(index + 1).padStart(2, "0")}`,
        sceneId: safeText(candidate.sceneId, ""),
        index,
        role: ["hook", "setup", "conflict", "escalation", "cliffhanger", "cutaway"].includes(role) ? role : "cutaway",
        startSec,
        endSec,
        clipDuration: endSec - startSec,
        requestedDurationSec: endSec - startSec,
        renderDuration: endSec - startSec,
        description: safeText(candidate.description, ""),
        reason: safeText(candidate.reason, "High-value visual moment"),
        screenText: safeText(candidate.screenText, ""),
        emotionalAnchor: safeText(candidate.emotionalAnchor, "tension"),
        visual_energy: clampScore(candidate.visual_energy || candidate.motionScore, role === "escalation" ? 8 : 6),
        audio_vibe: safeText(candidate.audio_vibe, "Suspense"),
        font_style: safeText(candidate.font_style, "standard"),
        keywords: Array.isArray(candidate.keywords) ? candidate.keywords.map((keyword) => safeText(keyword)).filter(Boolean).slice(0, 3) : [],
        reframe: candidate.reframe || null,
        viralScore: clampScore(candidate.viralScore, 6),
        tensionScore,
        continuityScore,
        plotImportanceScore,
        retentionScore,
        standaloneScore,
        noveltyScore,
        suddenVisualChangeScore,
        openingImpactScore,
        staticDialoguePenalty,
        visualHookBoost,
        momentFocus: safeText(candidate.momentFocus, "full").toLowerCase(),
        momentDurationSec: Math.max(0, safeNumber(candidate.momentDurationSec, 0)),
        timestampLocked: Boolean(candidate.timestampLocked),
        ...quality,
        sceneValue: Number(sceneValue.toFixed(1)),
        narrationLine: "",
        subtitleText: ""
      };
    })
    .filter((candidate) => candidate.clipDuration >= 0.6)
    .sort((a, b) => b.sceneValue - a.sceneValue);
}

function attachSceneMetadata(items, sceneMetadata) {
  const scenes = Array.isArray(sceneMetadata?.scenes) ? sceneMetadata.scenes : [];
  const byId = new Map(scenes.map((scene) => [safeText(scene.sceneId || scene.scene_id, ""), scene]).filter(([sceneId]) => sceneId));
  return (Array.isArray(items) ? items : []).map((item) => {
    const metadata = byId.get(safeText(item.sceneId, ""));
    if (!metadata) {
      return item;
    }
    const keywords = [
      ...(Array.isArray(item.keywords) ? item.keywords : []),
      ...(Array.isArray(metadata.local_visual_tags) ? metadata.local_visual_tags : [])
    ].map((keyword) => safeText(keyword)).filter(Boolean);
    return {
      ...item,
      metadataSummary: {
        audioTranscript: safeText(metadata.audio_transcript, ""),
        motionIntensity: safeText(metadata.motion_intensity, ""),
        audioEnergy: safeText(metadata.audio_energy, ""),
        lightChange: safeText(metadata.light_change, ""),
        localVisualTags: Array.isArray(metadata.local_visual_tags) ? metadata.local_visual_tags : []
      },
      keywords: Array.from(new Set(keywords)).slice(0, 6),
      reframe: item.reframe || metadata.reframe || null
    };
  });
}

function summarizeLockedScenes(scenes) {
  return (Array.isArray(scenes) ? scenes : []).map((scene) => ({
    sceneId: scene.sceneId,
    startSec: Number(scene.startSec.toFixed(3)),
    endSec: Number(scene.endSec.toFixed(3)),
    duration: Number(scene.duration.toFixed(3))
  }));
}

function normalizeFilmMemory(memory) {
  const mustUseMoments = Array.isArray(memory?.mustUseMoments) ? memory.mustUseMoments : [];
  const avoidMoments = Array.isArray(memory?.avoidMoments) ? memory.avoidMoments : [];
  const storyGraph = memory?.storyGraph && typeof memory.storyGraph === "object" ? memory.storyGraph : {};
  const storyBeats = Array.isArray(storyGraph.storyBeats) ? storyGraph.storyBeats : [];
  const characterMap = Array.isArray(storyGraph.characterMap) ? storyGraph.characterMap : [];
  return {
    title: safeText(memory?.title, ""),
    logline: safeText(memory?.logline, ""),
    protagonist: safeText(memory?.protagonist, ""),
    goal: safeText(memory?.goal, ""),
    centralConflict: safeText(memory?.centralConflict, ""),
    stakes: safeText(memory?.stakes, ""),
    theBizarreElement: safeText(memory?.theBizarreElement, ""),
    theInjustice: safeText(memory?.theInjustice, ""),
    curiosityGap: safeText(memory?.curiosityGap, ""),
    selectedViralAngle: memory?.selectedViralAngle || null,
    tiktokThesis: safeText(memory?.tiktokThesis, ""),
    emotionalArc: Array.isArray(memory?.emotionalArc) ? memory.emotionalArc.map((entry) => safeText(entry)).filter(Boolean) : [],
    spoilerBoundary: safeText(memory?.spoilerBoundary, ""),
    narrationAngle: safeText(memory?.narrationAngle, ""),
    continuityRules: Array.isArray(memory?.continuityRules) ? memory.continuityRules.map((entry) => safeText(entry)).filter(Boolean) : [],
    storyGraph: {
      protagonist: safeText(storyGraph.protagonist || memory?.protagonist, ""),
      protagonistLabel: safeText(storyGraph.protagonistLabel || storyGraph.protagonist || memory?.protagonist, ""),
      objective: safeText(storyGraph.objective || memory?.goal, ""),
      mainThreat: safeText(storyGraph.mainThreat || memory?.centralConflict, ""),
      causeEffectChain: Array.isArray(storyGraph.causeEffectChain)
        ? storyGraph.causeEffectChain.map((entry) => safeText(entry)).filter(Boolean).slice(0, 12)
        : [],
      characterMap: characterMap.map((character, index) => ({
        id: safeText(character.id, `char_${String(index + 1).padStart(2, "0")}`),
        label: safeText(character.label || character.name || character.role, ""),
        role: safeText(character.role, ""),
        description: safeText(character.description || character.visualCue, "")
      })).filter((character) => character.label || character.role),
      storyBeats: storyBeats.map((beat, index) => ({
        beatId: safeText(beat.beatId || beat.id, `beat_${String(index + 1).padStart(2, "0")}`),
        beatType: safeText(beat.beatType || beat.type || beat.role, ""),
        sceneId: safeText(beat.sceneId, ""),
        cause: safeText(beat.cause, ""),
        effect: safeText(beat.effect, ""),
        audienceQuestion: safeText(beat.audienceQuestion || beat.viewerQuestion, ""),
        narrationPurpose: safeText(beat.narrationPurpose || beat.purpose, "")
      })).filter((beat) => beat.sceneId || beat.cause || beat.effect)
    },
    mustUseMoments: mustUseMoments.map((moment) => ({
      sceneId: safeText(moment.sceneId, ""),
      roleHint: safeText(moment.roleHint, ""),
      why: safeText(moment.why, ""),
      plotImportanceScore: clampScore(moment.plotImportanceScore, 6),
      retentionScore: clampScore(moment.retentionScore, 6),
      standaloneScore: clampScore(moment.standaloneScore, 6),
      emotion: safeText(moment.emotion, ""),
      momentFocus: safeText(moment.momentFocus, "full").toLowerCase(),
      momentDurationSec: Math.max(0, safeNumber(moment.momentDurationSec, 0))
    })).filter((moment) => moment.sceneId),
    avoidMoments: avoidMoments.map((moment) => ({
      sceneId: safeText(moment.sceneId, ""),
      reason: safeText(moment.reason, "")
    })).filter((moment) => moment.sceneId)
  };
}

function applyViralAngleToFilmMemory(filmMemory, viralAngle) {
  const memory = normalizeFilmMemory(filmMemory);
  return {
    ...memory,
    selectedViralAngle: memory.selectedViralAngle || viralAngle || null,
    narrationAngle: safeText(memory.narrationAngle, viralAngle?.instruction || ""),
    tiktokThesis: safeText(memory.tiktokThesis, memory.logline || viralAngle?.instruction || "")
  };
}

function normalizeFilmUnderstanding(understanding, filmMemory, sceneMetadata) {
  const storyGraph = normalizeFilmMemory(filmMemory).storyGraph;
  const sourceScenes = Array.isArray(sceneMetadata?.scenes) ? sceneMetadata.scenes : [];
  const rawCharacters = Array.isArray(understanding?.characterBible?.characters)
    ? understanding.characterBible.characters
    : [];
  const fallbackCharacters = Array.isArray(storyGraph.characterMap) && storyGraph.characterMap.length
    ? storyGraph.characterMap.map((character, index) => ({
        characterId: safeText(character.characterId || character.id, index === 0 ? "char_hero" : `char_${index + 1}`),
        stableLabel: safeText(character.stableLabel || character.label || character.name, index === 0 ? "the protagonist" : `character ${index + 1}`),
        role: safeText(character.role, index === 0 ? "protagonist" : "supporting"),
        traits: Array.isArray(character.traits) ? character.traits : [],
        visualCues: Array.isArray(character.visualCues) ? character.visualCues : [],
        firstSeenSceneId: safeText(character.firstSeenSceneId || character.sceneId, ""),
        confidence: Number(character.confidence || 0.45)
      }))
    : [{
        characterId: "char_hero",
        stableLabel: safeText(storyGraph.protagonistLabel, "the protagonist"),
        role: "protagonist",
        traits: [],
        visualCues: [],
        firstSeenSceneId: safeText(sourceScenes[0]?.sceneId || sourceScenes[0]?.scene_id, ""),
        confidence: 0.35
      }];
  const characterBible = {
    protagonistId: safeText(understanding?.characterBible?.protagonistId, fallbackCharacters[0]?.characterId || "char_hero"),
    characters: (rawCharacters.length ? rawCharacters : fallbackCharacters).map((character, index) => ({
      characterId: safeText(character.characterId || character.character_id, index === 0 ? "char_hero" : `char_${index + 1}`),
      stableLabel: safeText(character.stableLabel || character.stable_label || character.label || character.name, index === 0 ? "the protagonist" : `character ${index + 1}`),
      role: safeText(character.role, index === 0 ? "protagonist" : "supporting"),
      traits: Array.isArray(character.traits) ? character.traits : [],
      visualCues: Array.isArray(character.visualCues || character.visual_cues) ? (character.visualCues || character.visual_cues) : [],
      firstSeenSceneId: safeText(character.firstSeenSceneId || character.first_seen_scene_id, ""),
      confidence: clamp(Number(character.confidence || 0.5), 0, 1)
    }))
  };
  const rawEvents = Array.isArray(understanding?.plotTimeline?.events) ? understanding.plotTimeline.events : [];
  const fallbackEvents = Array.isArray(storyGraph.storyBeats) && storyGraph.storyBeats.length
    ? storyGraph.storyBeats.map((beat, index) => ({
        eventId: `event_${String(index + 1).padStart(3, "0")}`,
        sceneIds: [safeText(beat.sceneId, "")].filter(Boolean),
        summary: safeText(beat.summary || beat.beat || beat.description, "Story beat"),
        cause: safeText(beat.cause, ""),
        effect: safeText(beat.effect, ""),
        stakes: safeText(beat.stakes, ""),
        characterIds: [characterBible.protagonistId].filter(Boolean),
        confidence: Number(beat.confidence || 0.45)
      }))
    : sourceScenes.slice(0, 80).map((scene, index) => ({
        eventId: `event_${String(index + 1).padStart(3, "0")}`,
        sceneIds: [safeText(scene.sceneId || scene.scene_id, "")].filter(Boolean),
        summary: safeText(scene.audio_transcript || scene.audioTranscript || (Array.isArray(scene.local_visual_tags) ? scene.local_visual_tags.join(", ") : ""), "Visual story event"),
        cause: "",
        effect: "",
        stakes: "",
        characterIds: [characterBible.protagonistId].filter(Boolean),
        confidence: 0.30
      }));
  const events = (rawEvents.length ? rawEvents : fallbackEvents).map((event, index) => ({
    eventId: safeText(event.eventId || event.event_id || event.id, `event_${String(index + 1).padStart(3, "0")}`),
    sceneIds: Array.isArray(event.sceneIds || event.scene_ids) ? (event.sceneIds || event.scene_ids).map((sceneId) => safeText(sceneId)).filter(Boolean) : [],
    summary: safeText(event.summary || event.event, "Story event"),
    cause: safeText(event.cause, ""),
    effect: safeText(event.effect, ""),
    stakes: safeText(event.stakes, ""),
    characterIds: Array.isArray(event.characterIds || event.character_ids) ? (event.characterIds || event.character_ids) : [characterBible.protagonistId].filter(Boolean),
    confidence: clamp(Number(event.confidence || 0.5), 0, 1)
  }));
  const rawSceneRoleMap = Array.isArray(understanding?.sceneRoleMap) ? understanding.sceneRoleMap : [];
  const eventByScene = new Map();
  for (const event of events) {
    for (const sceneId of event.sceneIds) {
      if (sceneId && !eventByScene.has(sceneId)) eventByScene.set(sceneId, event);
    }
  }
  const sceneRoleMap = (rawSceneRoleMap.length ? rawSceneRoleMap : sourceScenes.slice(0, 160).map((scene, index) => {
    const sceneId = safeText(scene.sceneId || scene.scene_id, `scene_${String(index + 1).padStart(4, "0")}`);
    const event = eventByScene.get(sceneId) || events[Math.min(index, events.length - 1)] || {};
    return {
      sceneId,
      role: index === 0 ? "hook" : "cutaway",
      plotEventId: event.eventId || "",
      characterIds: event.characterIds || [characterBible.protagonistId].filter(Boolean),
      visualEvidence: safeText((scene.local_visual_tags || scene.localVisualTags || []).join ? (scene.local_visual_tags || scene.localVisualTags || []).join(", ") : "", ""),
      dialogueEvidence: safeText(scene.audio_transcript || scene.audioTranscript, ""),
      importanceScore: 5,
      confidence: 0.30
    };
  })).map((entry, index) => ({
    sceneId: safeText(entry.sceneId || entry.scene_id, `scene_${String(index + 1).padStart(4, "0")}`),
    role: safeText(entry.role, "cutaway"),
    plotEventId: safeText(entry.plotEventId || entry.plot_event_id, ""),
    characterIds: Array.isArray(entry.characterIds || entry.character_ids) ? (entry.characterIds || entry.character_ids) : [characterBible.protagonistId].filter(Boolean),
    visualEvidence: safeText(entry.visualEvidence || entry.visual_evidence, ""),
    dialogueEvidence: safeText(entry.dialogueEvidence || entry.dialogue_evidence, ""),
    importanceScore: clamp(Number(entry.importanceScore || entry.importance_score || 5), 1, 10),
    confidence: clamp(Number(entry.confidence || 0.5), 0, 1)
  }));
  return {
    characterBible,
    plotTimeline: { events },
    sceneRoleMap
  };
}

function normalizeNarrativeIntelligence(narrativeIntelligence, filmUnderstanding, filmMemory, sceneMetadata) {
  const understanding = normalizeFilmUnderstanding(filmUnderstanding, filmMemory, sceneMetadata);
  const characterBible = understanding.characterBible;
  const events = Array.isArray(understanding.plotTimeline?.events) ? understanding.plotTimeline.events : [];
  const sourceScenes = Array.isArray(sceneMetadata?.scenes) ? sceneMetadata.scenes : [];
  const rawCharacters = Array.isArray(narrativeIntelligence?.characterMentalModel?.characters)
    ? narrativeIntelligence.characterMentalModel.characters
    : [];
  const characters = (rawCharacters.length ? rawCharacters : characterBible.characters.map((character) => ({
    characterId: character.characterId,
    stableLabel: character.stableLabel,
    possibleNames: [],
    roleInStory: character.role || "unknown",
    visualDescription: (character.visualCues || []).join(", "),
    firstAppearanceSceneId: character.firstSeenSceneId,
    keyScenes: [character.firstSeenSceneId].filter(Boolean),
    goal: normalizeFilmMemory(filmMemory).goal || normalizeFilmMemory(filmMemory).storyGraph.objective || "",
    motivation: normalizeFilmMemory(filmMemory).stakes || "",
    fear: "",
    internalConflict: "",
    externalConflict: normalizeFilmMemory(filmMemory).centralConflict || normalizeFilmMemory(filmMemory).storyGraph.mainThreat || "",
    whatTheyKnowTimeline: events.slice(0, 12).map((event) => ({
      plotEventId: event.eventId,
      knows: [event.summary].filter(Boolean),
      doesNotKnow: Array.isArray(event.unresolvedQuestions) ? event.unresolvedQuestions : [],
      evidenceSceneIds: event.sceneIds || []
    })),
    emotionalStateTimeline: [],
    arcStateTimeline: events.slice(0, 12).map((event) => ({
      plotEventId: event.eventId,
      arcState: event.summary,
      whatChanged: event.effect || event.summary,
      confidenceScore: event.confidence || 0.35
    })),
    relationships: [],
    confidenceScore: character.confidence || 0.35,
    evidenceScenes: [character.firstSeenSceneId].filter(Boolean)
  }))).map((character, index) => ({
    characterId: safeText(character.characterId || character.character_id, index === 0 ? "char_hero" : `char_${index + 1}`),
    stableLabel: safeText(character.stableLabel || character.stable_label || character.label, index === 0 ? "the protagonist" : `character ${index + 1}`),
    possibleNames: Array.isArray(character.possibleNames || character.possible_names) ? (character.possibleNames || character.possible_names) : [],
    roleInStory: safeText(character.roleInStory || character.role_in_story || character.role, index === 0 ? "protagonist" : "unknown"),
    visualDescription: safeText(character.visualDescription || character.visual_description, ""),
    firstAppearanceSceneId: safeText(character.firstAppearanceSceneId || character.first_appearance_scene_id, ""),
    keyScenes: Array.isArray(character.keyScenes || character.key_scenes) ? (character.keyScenes || character.key_scenes).map((sceneId) => safeText(sceneId)).filter(Boolean) : [],
    goal: safeText(character.goal, ""),
    motivation: safeText(character.motivation, ""),
    fear: safeText(character.fear, ""),
    internalConflict: safeText(character.internalConflict || character.internal_conflict, ""),
    externalConflict: safeText(character.externalConflict || character.external_conflict, ""),
    whatTheyKnowTimeline: Array.isArray(character.whatTheyKnowTimeline || character.what_they_know_timeline) ? (character.whatTheyKnowTimeline || character.what_they_know_timeline) : [],
    emotionalStateTimeline: Array.isArray(character.emotionalStateTimeline || character.emotional_state_timeline) ? (character.emotionalStateTimeline || character.emotional_state_timeline) : [],
    arcStateTimeline: Array.isArray(character.arcStateTimeline || character.arc_state_timeline) ? (character.arcStateTimeline || character.arc_state_timeline) : [],
    relationships: Array.isArray(character.relationships) ? character.relationships : [],
    confidenceScore: clamp(Number(character.confidenceScore || character.confidence_score || 0.45), 0, 1),
    evidenceScenes: Array.isArray(character.evidenceScenes || character.evidence_scenes) ? (character.evidenceScenes || character.evidence_scenes).map((sceneId) => safeText(sceneId)).filter(Boolean) : []
  }));
  const rawRelationships = Array.isArray(narrativeIntelligence?.relationshipGraph?.relationships)
    ? narrativeIntelligence.relationshipGraph.relationships
    : [];
  const relationships = rawRelationships.map((entry) => ({
    sourceCharacterId: safeText(entry.sourceCharacterId || entry.source_character_id, ""),
    targetCharacterId: safeText(entry.targetCharacterId || entry.target_character_id, ""),
    relationshipType: safeText(entry.relationshipType || entry.relationship_type, "unknown"),
    relationshipStateTimeline: Array.isArray(entry.relationshipStateTimeline || entry.relationship_state_timeline) ? (entry.relationshipStateTimeline || entry.relationship_state_timeline) : [],
    trustLevelTimeline: Array.isArray(entry.trustLevelTimeline || entry.trust_level_timeline) ? (entry.trustLevelTimeline || entry.trust_level_timeline) : [],
    evidenceScenes: Array.isArray(entry.evidenceScenes || entry.evidence_scenes) ? (entry.evidenceScenes || entry.evidence_scenes) : [],
    confidenceScore: clamp(Number(entry.confidenceScore || entry.confidence_score || 0.45), 0, 1)
  })).filter((entry) => entry.sourceCharacterId || entry.targetCharacterId);
  const rawWorldState = Array.isArray(narrativeIntelligence?.worldStateTimeline) ? narrativeIntelligence.worldStateTimeline : [];
  const worldStateTimeline = (rawWorldState.length ? rawWorldState : events.map((event, index) => ({
    plotEventId: event.eventId,
    sceneIds: event.sceneIds || [],
    knownFacts: [event.summary].filter(Boolean),
    changedFacts: [event.effect].filter(Boolean),
    unresolvedQuestions: [],
    dangerLevel: clamp(4 + index, 1, 10),
    protagonistState: event.summary || "",
    antagonistState: "",
    stakes: event.stakes || "",
    causeFromPreviousEvent: event.cause || "",
    effectOnNextEvent: event.effect || ""
  }))).map((entry) => ({
    plotEventId: safeText(entry.plotEventId || entry.plot_event_id, ""),
    sceneIds: Array.isArray(entry.sceneIds || entry.scene_ids) ? (entry.sceneIds || entry.scene_ids).map((sceneId) => safeText(sceneId)).filter(Boolean) : [],
    knownFacts: Array.isArray(entry.knownFacts || entry.known_facts) ? (entry.knownFacts || entry.known_facts) : [],
    changedFacts: Array.isArray(entry.changedFacts || entry.changed_facts) ? (entry.changedFacts || entry.changed_facts) : [],
    unresolvedQuestions: Array.isArray(entry.unresolvedQuestions || entry.unresolved_questions) ? (entry.unresolvedQuestions || entry.unresolved_questions) : [],
    dangerLevel: clamp(Number(entry.dangerLevel || entry.danger_level || 4), 1, 10),
    protagonistState: safeText(entry.protagonistState || entry.protagonist_state, ""),
    antagonistState: safeText(entry.antagonistState || entry.antagonist_state, ""),
    stakes: safeText(entry.stakes, ""),
    causeFromPreviousEvent: safeText(entry.causeFromPreviousEvent || entry.cause_from_previous_event, ""),
    effectOnNextEvent: safeText(entry.effectOnNextEvent || entry.effect_on_next_event, "")
  }));
  const rawEmotionalTimeline = Array.isArray(narrativeIntelligence?.emotionalTimeline) ? narrativeIntelligence.emotionalTimeline : [];
  const emotionalTimeline = rawEmotionalTimeline.map((entry) => ({
    characterId: safeText(entry.characterId || entry.character_id, ""),
    plotEventId: safeText(entry.plotEventId || entry.plot_event_id, ""),
    emotionBefore: safeText(entry.emotionBefore || entry.emotion_before, ""),
    emotionAfter: safeText(entry.emotionAfter || entry.emotion_after, ""),
    trigger: safeText(entry.trigger, ""),
    visibleEvidence: safeText(entry.visibleEvidence || entry.visible_evidence, ""),
    transcriptEvidence: safeText(entry.transcriptEvidence || entry.transcript_evidence, ""),
    confidenceScore: clamp(Number(entry.confidenceScore || entry.confidence_score || 0.45), 0, 1)
  }));
  const rawBeats = Array.isArray(narrativeIntelligence?.storyBeatGraph?.beats)
    ? narrativeIntelligence.storyBeatGraph.beats
    : [];
  const fallbackBeats = events.map((event, index) => ({
    beatId: `beat_${String(index + 1).padStart(3, "0")}`,
    sceneIds: event.sceneIds || [],
    beatRole: index === 0 ? "hook" : index === 1 ? "setup" : index === 2 ? "incident" : index === events.length - 1 ? "cliffhanger" : "conflict",
    mainCharacters: event.characterIds || [characterBible.protagonistId].filter(Boolean),
    mainGoal: normalizeFilmMemory(filmMemory).goal,
    obstacle: normalizeFilmMemory(filmMemory).centralConflict,
    outcome: event.effect || event.summary,
    whatChanged: event.effect || event.summary,
    cause: event.cause || "",
    effect: event.effect || "",
    visualEvidence: "",
    transcriptEvidence: event.summary || "",
    importanceScore: 5,
    retentionScore: 5,
    evidenceLevel: event.confidence >= 0.6 ? "inferred" : "weak"
  }));
  const beats = (rawBeats.length ? rawBeats : fallbackBeats).map((beat, index) => ({
    beatId: safeText(beat.beatId || beat.beat_id, `beat_${String(index + 1).padStart(3, "0")}`),
    sceneIds: Array.isArray(beat.sceneIds || beat.scene_ids) ? (beat.sceneIds || beat.scene_ids).map((sceneId) => safeText(sceneId)).filter(Boolean) : [],
    beatRole: safeText(beat.beatRole || beat.beat_role || beat.role, "conflict"),
    mainCharacters: Array.isArray(beat.mainCharacters || beat.main_characters) ? (beat.mainCharacters || beat.main_characters) : [],
    mainGoal: safeText(beat.mainGoal || beat.main_goal, ""),
    obstacle: safeText(beat.obstacle, ""),
    outcome: safeText(beat.outcome, ""),
    whatChanged: safeText(beat.whatChanged || beat.what_changed, ""),
    cause: safeText(beat.cause, ""),
    effect: safeText(beat.effect, ""),
    visualEvidence: safeText(beat.visualEvidence || beat.visual_evidence, ""),
    transcriptEvidence: safeText(beat.transcriptEvidence || beat.transcript_evidence, ""),
    importanceScore: clamp(Number(beat.importanceScore || beat.importance_score || 5), 1, 10),
    retentionScore: clamp(Number(beat.retentionScore || beat.retention_score || 5), 1, 10),
    evidenceLevel: safeText(beat.evidenceLevel || beat.evidence_level, "inferred")
  }));
  return {
    characterMentalModel: { characters },
    relationshipGraph: { relationships },
    worldStateTimeline,
    emotionalTimeline,
    storyBeatGraph: { beats },
    source: rawBeats.length || rawCharacters.length ? "gemini" : "fallback"
  };
}

function enrichCandidatesWithFilmMemory(candidates, filmMemory) {
  const memory = normalizeFilmMemory(filmMemory);
  const mustUseMap = new Map(memory.mustUseMoments.map((moment) => [moment.sceneId, moment]));
  const avoidMap = new Map(memory.avoidMoments.map((moment) => [moment.sceneId, moment]));
  const storyBeatMap = new Map(memory.storyGraph.storyBeats.map((beat) => [beat.sceneId, beat]));
  return (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => !avoidMap.has(candidate.sceneId))
    .map((candidate) => {
      const moment = mustUseMap.get(candidate.sceneId);
      const storyBeat = storyBeatMap.get(candidate.sceneId);
      const storyPatch = storyBeat
        ? {
            narrativeBeat: storyBeat.beatType,
            beatPurpose: storyBeat.narrationPurpose || storyBeat.effect || storyBeat.audienceQuestion,
            continuityNote: combineTextParts([storyBeat.cause, storyBeat.effect]),
            viewerQuestion: storyBeat.audienceQuestion
          }
        : {};
      if (!moment) {
        return {
          ...candidate,
          ...storyPatch
        };
      }
      return {
        ...candidate,
        ...storyPatch,
        role: candidate.role || moment.roleHint,
        reason: safeText(candidate.reason, moment.why),
        emotionalAnchor: candidate.emotionalAnchor || moment.emotion,
        plotImportanceScore: Math.max(clampScore(candidate.plotImportanceScore, 5), moment.plotImportanceScore),
        retentionScore: Math.max(clampScore(candidate.retentionScore || candidate.viralScore, 5), moment.retentionScore),
        standaloneScore: Math.max(clampScore(candidate.standaloneScore || candidate.contextScore, 5), moment.standaloneScore),
        momentFocus: candidate.momentFocus || moment.momentFocus,
        momentDurationSec: candidate.momentDurationSec || moment.momentDurationSec,
        fromFilmMemory: true
      };
    });
}

function lockCandidateTimestampsToScenes(candidates, lockedScenes) {
  const scenes = Array.isArray(lockedScenes) ? lockedScenes : [];
  const sceneMap = new Map(scenes.map((scene) => [scene.sceneId, scene]));
  const findNearestScene = (candidate) => {
    const startSec = safeNumber(candidate.startSec, 0);
    const endSec = safeNumber(candidate.endSec, startSec + 1);
    const midpoint = (startSec + endSec) / 2;
    return scenes
      .map((scene) => {
        const sceneMidpoint = (scene.startSec + scene.endSec) / 2;
        const contains = midpoint >= scene.startSec && midpoint <= scene.endSec;
        return {
          scene,
          distance: contains ? 0 : Math.abs(sceneMidpoint - midpoint)
        };
      })
      .sort((a, b) => a.distance - b.distance)[0]?.scene || null;
  };
  return (Array.isArray(candidates) ? candidates : []).map((candidate) => {
    const scene = sceneMap.get(candidate.sceneId) || findNearestScene(candidate);
    if (!scene) {
      return candidate;
    }
    const candidateStart = safeNumber(candidate.startSec, scene.startSec);
    const candidateEnd = safeNumber(candidate.endSec, candidateStart + safeNumber(candidate.clipDuration, 2));
    const sceneStart = safeNumber(scene.startSec, 0);
    const sceneEnd = safeNumber(scene.endSec, sceneStart + safeNumber(scene.duration, 1));
    const sceneDuration = Math.max(0.4, sceneEnd - sceneStart);
    const candidateDuration = Math.max(0.4, candidateEnd - candidateStart);
    const midpoint = (candidateStart + candidateEnd) / 2;
    const candidateIsInsideScene = midpoint >= sceneStart && midpoint <= sceneEnd;
    const candidateHasSpecificTimestamp = candidateDuration < sceneDuration * 0.82 || safeNumber(candidate.momentDurationSec, 0) > 0;
    const startSec = candidateIsInsideScene && candidateHasSpecificTimestamp
      ? clamp(candidateStart, sceneStart, Math.max(sceneStart, sceneEnd - 0.4))
      : sceneStart;
    const endSec = candidateIsInsideScene && candidateHasSpecificTimestamp
      ? clamp(candidateEnd, startSec + 0.4, sceneEnd)
      : sceneEnd;
    return {
      ...candidate,
      sceneId: scene.sceneId,
      startSec,
      endSec,
      lockedSceneStartSec: sceneStart,
      lockedSceneEndSec: sceneEnd,
      clipDuration: Math.max(0.4, endSec - startSec),
      requestedDurationSec: Math.max(0.4, endSec - startSec),
      timestampLocked: true,
      timestampPreservedWithinScene: candidateIsInsideScene && candidateHasSpecificTimestamp
      };
    });
}

function trimCandidateToMoment(candidate, sourceDuration) {
  const fullStart = safeNumber(candidate.startSec, 0);
  const fullEnd = safeNumber(candidate.endSec, fullStart + 1);
  const fullDuration = Math.max(0.4, fullEnd - fullStart);
  const requested = Math.max(0, safeNumber(candidate.momentDurationSec, 0));
  const duration = requested > 0
    ? Math.min(fullDuration, Math.max(0.8, requested))
    : Math.min(fullDuration, Math.max(1.2, Math.min(5.5, fullDuration)));
  const focus = safeText(candidate.momentFocus, "full").toLowerCase();
  if (focus === "full" || duration >= fullDuration - 0.05) {
    return candidate;
  }

  let centerRatio = 0.5;
  if (focus === "early") centerRatio = 0.25;
  if (focus === "late") centerRatio = 0.75;
  const center = fullStart + fullDuration * centerRatio;
  const safeSourceDuration = Math.max(fullEnd, Number(sourceDuration || fullEnd));
  let startSec = clamp(center - duration / 2, fullStart, Math.max(fullStart, fullEnd - duration));
  let endSec = Math.min(fullEnd, startSec + duration);
  if (endSec > safeSourceDuration) {
    endSec = safeSourceDuration;
    startSec = Math.max(fullStart, endSec - duration);
  }

  return {
    ...candidate,
    startSec,
    endSec,
    clipDuration: Math.max(0.4, endSec - startSec),
    requestedDurationSec: Math.max(0.4, endSec - startSec),
    microMomentTrimmed: true,
    lockedSceneStartSec: candidate.lockedSceneStartSec ?? fullStart,
    lockedSceneEndSec: candidate.lockedSceneEndSec ?? fullEnd
  };
}

function refineCandidatesToMicroMoments(candidates, sourceDuration) {
  return (Array.isArray(candidates) ? candidates : []).map((candidate) => trimCandidateToMoment(candidate, sourceDuration));
}

function buildFallbackCandidates(sourceDuration, targetDuration) {
  const safeSourceDuration = Math.max(1, Number(sourceDuration || 1));
  const target = Math.max(3, Number(targetDuration || 30));
  const count = Math.min(12, Math.max(5, Math.ceil(target / 3)));
  const usableStart = Math.min(1, safeSourceDuration * 0.05);
  const usableEnd = Math.max(usableStart + 1, safeSourceDuration - Math.min(1, safeSourceDuration * 0.05));
  const span = Math.max(1, usableEnd - usableStart);
  const roles = ["hook", "setup", "conflict", "escalation", "cutaway", "cliffhanger"];

  return Array.from({ length: count }, (_value, index) => {
    const slotStart = usableStart + (span * index) / count;
    const duration = Math.min(Math.max(1.5, target / count), Math.max(1, span / count));
    const startSec = clamp(slotStart, 0, Math.max(0, safeSourceDuration - duration));
    const endSec = Math.min(safeSourceDuration, startSec + duration);
    const role = roles[Math.min(roles.length - 1, Math.floor((index / Math.max(1, count - 1)) * (roles.length - 1)))];
    return {
      id: `fallback-${index + 1}`,
      index,
      role,
      startSec,
      endSec,
      clipDuration: endSec - startSec,
      requestedDurationSec: endSec - startSec,
      renderDuration: endSec - startSec,
      description: "Fallback timeline scene",
      reason: "Fallback visual coverage because Gemini returned too few usable candidates",
      screenText: "",
      emotionalAnchor: "tension",
      visual_energy: role === "escalation" ? 8 : 6,
      audio_vibe: "Suspense",
      font_style: "standard",
      keywords: [],
      viralScore: 5,
      tensionScore: 5,
      continuityScore: 5,
      visualClarityScore: 5,
      emotionScore: 5,
      motionScore: 5,
      contextScore: 5,
      dialogueDependency: 5,
      spoilerRisk: 5,
      qualityScore: 5,
      sceneValue: 5,
      narrationLine: "",
      subtitleText: ""
    };
  });
}

function overlapsTooMuch(a, b) {
  const overlap = Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));
  return overlap > Math.min(a.clipDuration, b.clipDuration) * 0.45;
}

function roleDurationBudget(role, targetDuration) {
  const target = Number(targetDuration || 30);
  const budgets = {
    hook: [Math.max(2.0, target * 0.08), Math.max(3.2, target * 0.14)],
    setup: [Math.max(3.5, target * 0.14), Math.max(5.5, target * 0.22)],
    conflict: [Math.max(5.0, target * 0.20), Math.max(8.0, target * 0.30)],
    escalation: [Math.max(7.0, target * 0.28), Math.max(12.0, target * 0.42)],
    cliffhanger: [Math.max(2.5, target * 0.08), Math.max(4.5, target * 0.16)],
    cutaway: [1.2, Math.max(3.0, target * 0.12)]
  };
  return budgets[role] || budgets.cutaway;
}

function getNarrativeBeatPlan(targetDuration) {
  const target = Math.max(3, Number(targetDuration || 30));
  const base = [
    { beatType: "hook", role: "hook", minRatio: 0.08, maxRatio: 0.14, purpose: "stop the scroll with the most concrete danger or bizarre image" },
    { beatType: "context", role: "setup", minRatio: 0.12, maxRatio: 0.18, purpose: "orient the viewer: who is in trouble and where" },
    { beatType: "incident", role: "conflict", minRatio: 0.14, maxRatio: 0.20, purpose: "show the mistake, discovery, or event that changes the situation" },
    { beatType: "conflict", role: "conflict", minRatio: 0.16, maxRatio: 0.24, purpose: "make the threat and stakes impossible to ignore" },
    { beatType: "escalation", role: "escalation", minRatio: 0.20, maxRatio: 0.30, purpose: "increase danger with the strongest action or emotional pressure" },
    { beatType: "twist_payoff", role: "escalation", minRatio: 0.12, maxRatio: 0.20, purpose: "reveal a reversal, hidden rule, or consequence without breaking spoiler mode" },
    { beatType: "cliffhanger", role: "cliffhanger", minRatio: 0.08, maxRatio: 0.14, purpose: "leave one sharp unresolved question" }
  ];
  return base.map((beat, index) => ({
    ...beat,
    index,
    minDuration: Math.max(index === 0 ? 1.8 : 1.2, target * beat.minRatio),
    maxDuration: Math.max(index === 0 ? 2.8 : 2.0, target * beat.maxRatio),
    targetDuration: Math.max(1.0, target * ((beat.minRatio + beat.maxRatio) / 2))
  }));
}

function trimCandidateToDuration(candidate, duration) {
  const safeDuration = Math.max(0.6, Math.min(Number(duration), candidate.clipDuration));
  const center = (candidate.startSec + candidate.endSec) / 2;
  return {
    ...candidate,
    startSec: center - safeDuration / 2,
    endSec: center + safeDuration / 2,
    clipDuration: safeDuration,
    requestedDurationSec: safeDuration,
    renderDuration: safeDuration
  };
}

function findNarrativeBeatForCandidate(candidate, narrativeIntelligence) {
  const sceneId = safeText(candidate?.sceneId, "");
  const beats = Array.isArray(narrativeIntelligence?.storyBeatGraph?.beats) ? narrativeIntelligence.storyBeatGraph.beats : [];
  return beats.find((entry) => Array.isArray(entry.sceneIds) && entry.sceneIds.includes(sceneId)) || null;
}

function narrativeBeatRoleMatches(plannedBeatType, narrativeBeatRole) {
  const planned = safeText(plannedBeatType).toLowerCase();
  const role = safeText(narrativeBeatRole).toLowerCase();
  if (!planned || !role) return false;
  if (planned === role) return true;
  if (planned === "twist_payoff" && (role === "reveal" || role === "payoff")) return true;
  if (planned === "context" && role === "setup") return true;
  return false;
}

function candidateMatchesBeat(candidate, beat, filmMemory, narrativeIntelligence = null, selected = []) {
  if (!candidate || !beat) {
    return 0;
  }
  const role = safeText(candidate.role).toLowerCase();
  const description = `${candidate.description || ""} ${candidate.reason || ""} ${candidate.emotionalAnchor || ""}`.toLowerCase();
  const metadata = candidate.metadataSummary || {};
  const metadataText = `${metadata.motionIntensity || ""} ${metadata.audioEnergy || ""} ${metadata.lightChange || ""} ${(metadata.localVisualTags || []).join(" ")}`.toLowerCase();
  let score = Number(candidate.sceneValue || candidate.qualityScore || candidate.viralScore || 5);
  if (role === beat.role) score += 1.8;
  if (beat.beatType === "incident" && /mistake|discover|warn|first|enter|find|realize|accident|poison|trap|lured/i.test(description)) score += 1.2;
  if (beat.beatType === "conflict" && /danger|threat|attack|chase|monster|enemy|fight|risk|trapped/i.test(description)) score += 1.1;
  if (beat.beatType === "escalation" && (/high|loud|flash|fast motion/.test(metadataText) || Number(candidate.motionScore || 0) >= 7)) score += 1.3;
  if (beat.beatType === "twist_payoff" && /reveal|twist|truth|sudden|secret|betray|realizes|not what|rule/i.test(description)) score += 1.4;
  if (beat.beatType === "cliffhanger" && (role === "cliffhanger" || Number(candidate.spoilerRisk || 0) >= 6 || /escape|survive|ending|final|question/i.test(description))) score += 1.2;
  const graphBeat = normalizeFilmMemory(filmMemory).storyGraph.storyBeats.find((entry) => entry.sceneId && entry.sceneId === candidate.sceneId);
  if (graphBeat) {
    score += 1.5;
    if (safeText(graphBeat.beatType).toLowerCase() === beat.beatType) score += 1.4;
  }
  const narrativeBeat = findNarrativeBeatForCandidate(candidate, narrativeIntelligence);
  if (narrativeBeat) {
    if (narrativeBeatRoleMatches(beat.beatType, narrativeBeat.beatRole)) score += 2.2;
    if (safeText(narrativeBeat.whatChanged)) score += 1.3;
    if (safeText(narrativeBeat.cause) && safeText(narrativeBeat.effect)) score += 1.1;
    if (Array.isArray(narrativeBeat.mainCharacters) && narrativeBeat.mainCharacters.length) score += 0.8;
    if (safeText(narrativeBeat.mainGoal) && safeText(narrativeBeat.obstacle)) score += 1.0;
    score += clamp(Number(narrativeBeat.importanceScore || 0), 0, 10) * 0.12;
    score += clamp(Number(narrativeBeat.retentionScore || 0), 0, 10) * 0.10;
    if (safeText(narrativeBeat.evidenceLevel).toLowerCase() === "weak") score -= 1.2;
    const selectedBeatRoles = new Set(selected.map((entry) => safeText(entry.storyBeatRole || entry.narrativeBeat || entry.role).toLowerCase()));
    if ((narrativeBeat.beatRole === "escalation" || narrativeBeat.beatRole === "reveal" || narrativeBeat.beatRole === "payoff") && !selectedBeatRoles.has("conflict") && !selectedBeatRoles.has("incident")) {
      score -= 2.0;
    }
    if ((narrativeBeat.beatRole === "reveal" || narrativeBeat.beatRole === "payoff") && !selectedBeatRoles.has("setup") && !selectedBeatRoles.has("context")) {
      score -= 2.0;
    }
  } else if (Number(candidate.visualClarityScore || 0) >= 8 && Number(candidate.plotImportanceScore || candidate.contextScore || 0) < 5) {
    score -= 1.4;
  }
  return score;
}

function buildVisualTimeline(candidates, targetDuration, sourceDuration, filmMemory = null, narrativeIntelligence = null) {
  const target = Math.max(3, Number(targetDuration || 30));
  const beatPlan = getNarrativeBeatPlan(target);
  const selected = [];

  for (const beat of beatPlan) {
    const pool = candidates
      .filter((candidate) => !selected.some((picked) => overlapsTooMuch(candidate, picked)))
      .map((candidate) => ({ candidate, score: candidateMatchesBeat(candidate, beat, filmMemory, narrativeIntelligence, selected) }))
      .sort((a, b) => b.score - a.score);
    const chosen = pool[0]?.candidate;
    if (chosen) {
      const narrativeBeat = findNarrativeBeatForCandidate(chosen, narrativeIntelligence);
      selected.push({
        ...trimCandidateToDuration(chosen, clamp(chosen.clipDuration, beat.minDuration, beat.maxDuration)),
        narrativeBeat: beat.beatType,
        beatPurpose: beat.purpose,
        plannedRole: beat.role,
        beatId: narrativeBeat?.beatId || chosen.beatId || "",
        storyBeatRole: narrativeBeat?.beatRole || "",
        currentCharacterGoal: narrativeBeat?.mainGoal || chosen.currentCharacterGoal || "",
        whatChanged: narrativeBeat?.whatChanged || chosen.whatChanged || "",
        visualEvidence: narrativeBeat?.visualEvidence || chosen.visualEvidence || "",
        transcriptEvidence: narrativeBeat?.transcriptEvidence || chosen.transcriptEvidence || "",
        evidenceLevel: narrativeBeat?.evidenceLevel || chosen.evidenceLevel || ""
      });
    }
  }

  let total = sumDurations(selected, "renderDuration");
  const fillerPool = candidates
    .filter((candidate) => !selected.some((picked) => overlapsTooMuch(candidate, picked)))
    .sort((a, b) => b.sceneValue - a.sceneValue);

  for (const candidate of fillerPool) {
    if (total >= target - 0.35) {
      break;
    }
    const remaining = target - total;
    const duration = Math.min(candidate.clipDuration, Math.max(0.8, Math.min(remaining, roleDurationBudget(candidate.role, target)[1])));
    const narrativeBeat = findNarrativeBeatForCandidate(candidate, narrativeIntelligence);
    selected.push({
      ...trimCandidateToDuration(candidate, duration),
      beatId: narrativeBeat?.beatId || candidate.beatId || "",
      storyBeatRole: narrativeBeat?.beatRole || "",
      currentCharacterGoal: narrativeBeat?.mainGoal || candidate.currentCharacterGoal || "",
      whatChanged: narrativeBeat?.whatChanged || candidate.whatChanged || "",
      visualEvidence: narrativeBeat?.visualEvidence || candidate.visualEvidence || "",
      transcriptEvidence: narrativeBeat?.transcriptEvidence || candidate.transcriptEvidence || "",
      evidenceLevel: narrativeBeat?.evidenceLevel || candidate.evidenceLevel || ""
    });
    total += duration;
  }

  selected.sort((a, b) => {
    const beatOrder = { hook: 0, context: 1, incident: 2, conflict: 3, escalation: 4, twist_payoff: 5, cliffhanger: 6 };
    const orderDiff = (beatOrder[a.narrativeBeat] ?? 4) - (beatOrder[b.narrativeBeat] ?? 4);
    return orderDiff || a.startSec - b.startSec;
  });

  total = sumDurations(selected, "renderDuration");
  if (total > target + 0.05) {
    let overflow = total - target;
    for (let index = selected.length - 1; index >= 0 && overflow > 0.01; index -= 1) {
      const current = selected[index];
      const minDur = roleDurationBudget(current.role, target)[0] * 0.75;
      const reducible = Math.max(0, current.renderDuration - minDur);
      const take = Math.min(reducible, overflow);
      selected[index] = trimCandidateToDuration(current, current.renderDuration - take);
      overflow -= take;
    }
  } else if (total < target - 0.05 && selected.length) {
    let remaining = target - total;
    for (let index = selected.length - 1; index >= 0 && remaining > 0.01; index -= 1) {
      const current = selected[index];
      const room = Math.max(0, current.requestedDurationSec ? current.requestedDurationSec - current.renderDuration : 0);
      const take = Math.min(room, remaining);
      selected[index] = trimCandidateToDuration({ ...current, clipDuration: current.clipDuration + take, endSec: Math.min(sourceDuration, current.endSec + take) }, current.renderDuration + take);
      remaining -= take;
    }
  }

  let cursor = 0;
  return selected.map((shot, index) => {
    const renderDuration = index === selected.length - 1
      ? Math.max(0.6, target - cursor)
      : Math.max(0.6, Number(shot.renderDuration));
    const timelineShot = {
      ...shot,
      index,
      narrativeBeat: shot.narrativeBeat || shot.role,
      beatPurpose: shot.beatPurpose || "",
      timelineStart: cursor,
      timelineEnd: cursor + renderDuration,
      renderDuration,
      clipDuration: Math.max(0.6, shot.endSec - shot.startSec),
      energy: shot.role === "hook" || shot.role === "escalation" ? "panic" : shot.role === "setup" ? "setup" : "tense"
    };
    cursor += renderDuration;
    return timelineShot;
  });
}

function normalizeTimelineToTarget(segments, targetDuration) {
  const target = Math.max(0.6, Number(targetDuration || 0.6));
  const total = sumDurations(segments, "renderDuration");
  const scale = total > 0 ? target / total : 1;
  let cursor = 0;
  return segments.map((segment, index) => {
    const renderDuration = index === segments.length - 1
      ? Math.max(0.6, target - cursor)
      : Math.max(0.6, Number(segment.renderDuration || segment.clipDuration || 1) * scale);
    const updated = {
      ...segment,
      index,
      renderDuration,
      timelineStart: cursor,
      timelineEnd: cursor + renderDuration
    };
    cursor += renderDuration;
    return updated;
  });
}

function visualRangeSignature(segment) {
  const start = Math.round(safeNumber(segment.startSec, 0) * 10) / 10;
  const end = Math.round(safeNumber(segment.endSec, start + safeNumber(segment.clipDuration, 1)) * 10) / 10;
  return `${start.toFixed(1)}-${end.toFixed(1)}`;
}

function segmentVisualOverlapRatio(a, b) {
  const aStart = safeNumber(a.startSec, 0);
  const aEnd = safeNumber(a.endSec, aStart + safeNumber(a.clipDuration, 1));
  const bStart = safeNumber(b.startSec, 0);
  const bEnd = safeNumber(b.endSec, bStart + safeNumber(b.clipDuration, 1));
  const overlap = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  const shortest = Math.max(0.1, Math.min(aEnd - aStart, bEnd - bStart));
  return overlap / shortest;
}

function diversifyRepeatedVisualSegments(segments, candidates, sourceDuration) {
  const segmentList = Array.isArray(segments) ? segments : [];
  const candidatePool = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => safeNumber(candidate.endSec, 0) - safeNumber(candidate.startSec, 0) >= 0.6)
    .sort((a, b) => {
      const aTime = safeNumber(a.startSec, 0);
      const bTime = safeNumber(b.startSec, 0);
      const aScore = getSegmentQualityScore(a);
      const bScore = getSegmentQualityScore(b);
      return aTime - bTime || bScore - aScore;
    });

  if (segmentList.length < 2 || candidatePool.length < 2) {
    return segmentList;
  }

  const used = [];
  const signatureCounts = new Map();
  return segmentList.map((segment, index) => {
    const signature = visualRangeSignature(segment);
    const seenCount = signatureCounts.get(signature) || 0;
    signatureCounts.set(signature, seenCount + 1);

    const isRepeated = seenCount > 0 || used.some((picked) => segmentVisualOverlapRatio(segment, picked) > 0.72);
    if (!isRepeated) {
      used.push(segment);
      return segment;
    }

    const replacement = candidatePool.find((candidate) => {
      const candidateSignature = visualRangeSignature(candidate);
      if (used.some((picked) => visualRangeSignature(picked) === candidateSignature)) return false;
      return !used.some((picked) => segmentVisualOverlapRatio(candidate, picked) > 0.62);
    }) || candidatePool.find((candidate) => !used.some((picked) => visualRangeSignature(picked) === visualRangeSignature(candidate)));

    if (!replacement) {
      used.push(segment);
      return segment;
    }

    const startSec = clamp(safeNumber(replacement.startSec, segment.startSec), 0, Math.max(0, sourceDuration - 0.4));
    const endSec = clamp(safeNumber(replacement.endSec, startSec + safeNumber(replacement.clipDuration, 1)), startSec + 0.4, sourceDuration);
    const updated = {
      ...segment,
      sceneId: safeText(replacement.sceneId, segment.sceneId),
      startSec,
      endSec,
      clipDuration: Math.max(0.4, endSec - startSec),
      requestedDurationSec: Math.max(0.4, endSec - startSec),
      description: safeText(segment.description, replacement.description),
      reason: safeText(segment.reason, replacement.reason),
      screenText: safeText(segment.screenText, replacement.screenText),
      metadataSummary: replacement.metadataSummary || segment.metadataSummary,
      reframe: replacement.reframe || segment.reframe || null,
      visualDiversityReplacement: true,
      replacedRepeatedVisualFrom: signature
    };
    used.push(updated);
    return updated;
  });
}

function getVisualPacingConfig(genreMode, targetDuration) {
  const target = Math.max(3, Number(targetDuration || 30));
  const table = {
    action: { minBlock: 2.8, hookMin: 1.8, maxBlocksPer30: 8 },
    thriller: { minBlock: 3.2, hookMin: 2.0, maxBlocksPer30: 7 },
    mystery: { minBlock: 4.0, hookMin: 2.2, maxBlocksPer30: 6 },
    drama: { minBlock: 4.6, hookMin: 2.4, maxBlocksPer30: 6 },
    comedy: { minBlock: 3.2, hookMin: 1.8, maxBlocksPer30: 7 },
    healing: { minBlock: 5.0, hookMin: 2.6, maxBlocksPer30: 5 },
    "sci-fi": { minBlock: 3.6, hookMin: 2.0, maxBlocksPer30: 7 }
  };
  const selected = table[genreMode] || table.thriller;
  const durationScale = target < 20 ? 0.82 : target > 50 ? 1.12 : 1;
  const maxBlocks = clamp(
    Math.round(selected.maxBlocksPer30 * (target / 30)),
    target <= 20 ? 4 : 5,
    target <= 35 ? 8 : 14
  );

  return {
    minBlock: Math.min(target, selected.minBlock * durationScale),
    hookMin: Math.min(target, selected.hookMin * durationScale),
    maxBlocks
  };
}

function getSegmentQualityScore(segment) {
  return Number(
    segment.sceneValue
      || segment.qualityScore
      || segment.importanceScore
      || segment.viralScore
      || 0
  );
}

function combineTextParts(values) {
  return values
    .map((value) => safeText(value))
    .filter(Boolean)
    .join(" ");
}

function mergeVisualBlocks(left, right, sourceDuration) {
  const mergedFrom = [
    ...(Array.isArray(left.mergedFrom) ? left.mergedFrom : [left.index]),
    ...(Array.isArray(right.mergedFrom) ? right.mergedFrom : [right.index])
  ].filter((value) => Number.isFinite(Number(value)));
  const renderDuration = Math.max(0.6, Number(left.renderDuration || 0) + Number(right.renderDuration || 0));
  const leftQuality = getSegmentQualityScore(left);
  const rightQuality = getSegmentQualityScore(right);
  const primary = rightQuality > leftQuality ? right : left;
  const sourceStart = Math.min(Number(left.startSec || 0), Number(right.startSec || 0));
  const sourceEnd = Math.max(Number(left.endSec || left.startSec || 0), Number(right.endSec || right.startSec || 0));
  const sourceSpan = Math.max(0.4, sourceEnd - sourceStart);
  const sourceGap = Math.max(
    0,
    Math.max(Number(right.startSec || 0), Number(left.startSec || 0))
      - Math.min(Number(right.endSec || 0), Number(left.endSec || 0))
  );
  const shouldUseExpandedSource = sourceGap <= 1.4 || sourceSpan <= Math.max(6, renderDuration * 1.65);
  const startSec = shouldUseExpandedSource
    ? clamp(sourceStart, 0, Math.max(0, sourceDuration - 0.4))
    : clamp(Number(primary.startSec || 0), 0, Math.max(0, sourceDuration - 0.4));
  const endSec = shouldUseExpandedSource
    ? clamp(sourceEnd, startSec + 0.4, sourceDuration)
    : clamp(Number(primary.endSec || startSec + 2), startSec + 0.4, sourceDuration);

  return {
    ...primary,
    role: left.role === "hook" ? left.role : right.role === "cliffhanger" ? right.role : primary.role,
    narrativeBeat: left.narrativeBeat === "hook" ? left.narrativeBeat : right.narrativeBeat === "cliffhanger" ? right.narrativeBeat : primary.narrativeBeat,
    beatPurpose: combineTextParts([left.beatPurpose, right.beatPurpose]),
    continuityNote: combineTextParts([left.continuityNote, right.continuityNote]),
    viewerQuestion: safeText(right.viewerQuestion || left.viewerQuestion, ""),
    startSec,
    endSec,
    clipDuration: Math.max(0.4, endSec - startSec),
    renderDuration,
    requestedDurationSec: Math.max(
      0.4,
      Number(left.requestedDurationSec || left.renderDuration || 0)
        + Number(right.requestedDurationSec || right.renderDuration || 0)
    ),
    reason: combineTextParts([left.reason, right.reason]),
    narrationLine: combineTextParts([left.narrationLine, right.narrationLine]),
    subtitleText: combineTextParts([left.subtitleText || left.narrationLine, right.subtitleText || right.narrationLine]),
    screenText: safeText(left.screenText || right.screenText, ""),
    keywords: [
      ...new Set([
        ...(Array.isArray(left.keywords) ? left.keywords : []),
        ...(Array.isArray(right.keywords) ? right.keywords : [])
      ].map((keyword) => safeText(keyword)).filter(Boolean))
    ].slice(0, 5),
    mergedFrom,
    visualBlockMerged: true,
    sourceExpandedForContinuity: shouldUseExpandedSource,
    qualityScore: Math.max(Number(left.qualityScore || 0), Number(right.qualityScore || 0)),
    importanceScore: Math.max(Number(left.importanceScore || 0), Number(right.importanceScore || 0)),
    viralScore: Math.max(Number(left.viralScore || 0), Number(right.viralScore || 0)),
    sceneValue: Math.max(Number(left.sceneValue || 0), Number(right.sceneValue || 0)),
    energy: left.energy === "panic" || right.energy === "panic" ? "panic" : primary.energy
  };
}

function chooseMergeNeighbor(segments, index) {
  const current = segments[index];
  const options = [];
  if (index > 0) {
    const left = segments[index - 1];
    const gap = Math.max(0, Number(current.startSec || 0) - Number(left.endSec || 0));
    options.push({
      index: index - 1,
      score: gap + (left.role === current.role ? -0.6 : 0) + (left.energy === current.energy ? -0.25 : 0)
    });
  }
  if (index < segments.length - 1) {
    const right = segments[index + 1];
    const gap = Math.max(0, Number(right.startSec || 0) - Number(current.endSec || 0));
    options.push({
      index,
      score: gap + (right.role === current.role ? -0.6 : 0) + (right.energy === current.energy ? -0.25 : 0)
    });
  }
  return options.sort((a, b) => a.score - b.score)[0] || null;
}

function smoothVisualTimeline(segments, targetDuration, genreMode, sourceDuration) {
  const config = getVisualPacingConfig(genreMode, targetDuration);
  let blocks = normalizeTimelineToTarget(segments, targetDuration).map((segment, index) => ({
    ...segment,
    index,
    mergedFrom: Array.isArray(segment.mergedFrom) ? segment.mergedFrom : [index]
  }));
  const originalCount = blocks.length;
  let guard = 0;

  while (blocks.length > 1 && guard < 60) {
    const shortIndex = blocks.findIndex((segment, index) => {
      const minDuration = index === 0 && segment.role === "hook" ? config.hookMin : config.minBlock;
      return Number(segment.renderDuration || 0) < minDuration;
    });
    if (shortIndex < 0) {
      break;
    }
    const mergeTarget = chooseMergeNeighbor(blocks, shortIndex);
    if (!mergeTarget) {
      break;
    }
    blocks.splice(
      mergeTarget.index,
      2,
      mergeVisualBlocks(blocks[mergeTarget.index], blocks[mergeTarget.index + 1], sourceDuration)
    );
    guard += 1;
  }

  while (blocks.length > config.maxBlocks && blocks.length > 1 && guard < 120) {
    let bestIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let index = 0; index < blocks.length - 1; index += 1) {
      const left = blocks[index];
      const right = blocks[index + 1];
      const gap = Math.max(0, Number(right.startSec || 0) - Number(left.endSec || 0));
      const qualityPenalty = (getSegmentQualityScore(left) + getSegmentQualityScore(right)) * 0.02;
      const score = gap + (left.role === right.role ? -0.8 : 0) - qualityPenalty;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    blocks.splice(bestIndex, 2, mergeVisualBlocks(blocks[bestIndex], blocks[bestIndex + 1], sourceDuration));
    guard += 1;
  }

  blocks = normalizeTimelineToTarget(blocks, targetDuration).map((segment, index) => ({
    ...segment,
    index,
    visualBlockIndex: index
  }));

  return {
    segments: blocks,
    originalCount,
    visualBlockCount: blocks.length,
    config
  };
}

function buildQualityNotes(segments) {
  return segments
    .filter((segment) => segment.qualityScore < 6.2 || segment.dialogueDependency >= 7 || segment.spoilerRisk >= 8)
    .map((segment) => {
      const warnings = [];
      if (segment.qualityScore < 6.2) warnings.push("low visual/story quality score");
      if (segment.dialogueDependency >= 7) warnings.push("depends heavily on original dialogue");
      if (segment.spoilerRisk >= 8) warnings.push("high spoiler risk");
      return `Scene ${segment.index + 1} (${segment.role}) needs review: ${warnings.join(", ")}.`;
    });
}

async function writeNarrativeDebugReports({ projectStore, outputDir, narrativeIntelligence, groundingReport, segments }) {
  const issues = Array.isArray(groundingReport?.issues) ? groundingReport.issues : [];
  const issueSegments = Array.isArray(groundingReport?.segments) ? groundingReport.segments : [];
  const paths = {
    narrativeIntelligenceReportPath: path.join(outputDir, "narrative-intelligence-report.json"),
    characterConsistencyReportPath: path.join(outputDir, "character-consistency-report.json"),
    storyCoherenceReportPath: path.join(outputDir, "story-coherence-report.json"),
    groundingRiskReportPath: path.join(outputDir, "grounding-risk-report.json")
  };
  const characterCodes = new Set([
    "character_identity_mismatch",
    "character_goal_mismatch",
    "relationship_mismatch",
    "knowledge_state_mismatch",
    "emotion_not_supported"
  ]);
  const storyCodes = new Set([
    "event_order_violation",
    "reveal_before_setup",
    "scene_only_captioning",
    "weak_inference_overstated",
    "missing_plot_event"
  ]);
  const beats = Array.isArray(narrativeIntelligence?.storyBeatGraph?.beats) ? narrativeIntelligence.storyBeatGraph.beats : [];
  await projectStore.writeJson(paths.narrativeIntelligenceReportPath, {
    generatedAt: new Date().toISOString(),
    source: narrativeIntelligence?.source || "unknown",
    characterCount: Array.isArray(narrativeIntelligence?.characterMentalModel?.characters) ? narrativeIntelligence.characterMentalModel.characters.length : 0,
    relationshipCount: Array.isArray(narrativeIntelligence?.relationshipGraph?.relationships) ? narrativeIntelligence.relationshipGraph.relationships.length : 0,
    worldStateCount: Array.isArray(narrativeIntelligence?.worldStateTimeline) ? narrativeIntelligence.worldStateTimeline.length : 0,
    storyBeatCount: beats.length,
    weakBeats: beats.filter((beat) => safeText(beat.evidenceLevel).toLowerCase() === "weak" || !safeText(beat.whatChanged)).map((beat) => ({
      beatId: beat.beatId,
      beatRole: beat.beatRole,
      sceneIds: beat.sceneIds,
      evidenceLevel: beat.evidenceLevel,
      whatChanged: beat.whatChanged || ""
    }))
  }).catch(() => {});
  await projectStore.writeJson(paths.characterConsistencyReportPath, {
    generatedAt: new Date().toISOString(),
    passed: !issues.some((issue) => characterCodes.has(issue.code) && issue.severity === "error"),
    issues: issues.filter((issue) => characterCodes.has(issue.code)),
    segments: issueSegments.filter((segment) => (segment.issues || []).some((issue) => characterCodes.has(issue.code)))
  }).catch(() => {});
  await projectStore.writeJson(paths.storyCoherenceReportPath, {
    generatedAt: new Date().toISOString(),
    passed: !issues.some((issue) => storyCodes.has(issue.code) && issue.severity === "error"),
    issues: issues.filter((issue) => storyCodes.has(issue.code)),
    segments: issueSegments.filter((segment) => (segment.issues || []).some((issue) => storyCodes.has(issue.code))),
    segmentCount: Array.isArray(segments) ? segments.length : 0
  }).catch(() => {});
  await projectStore.writeJson(paths.groundingRiskReportPath, {
    generatedAt: new Date().toISOString(),
    passed: groundingReport?.passed !== false,
    weakSegmentCount: groundingReport?.weakSegmentCount || 0,
    issues,
    segments: issueSegments
  }).catch(() => {});
  return paths;
}

function buildGeminiCacheKey(project, settings, genreMode, perspective) {
  return {
    sourceVideoPath: project.sourceVideoPath,
    targetDuration: Number(project.targetDuration),
    genreMode,
    perspective,
    spoilerMode: project.spoilerMode || "",
    narrationEnabled: Boolean(project.narrationEnabled),
    rewriteVoiceover: Boolean(project.rewriteVoiceover),
    narrationLanguage: project.narrationLanguage || "vi",
    geminiModel: settings.geminiModel || "",
    promptVersion: "quality-v3"
  };
}

async function readGeminiAnalysisCache(cachePath, cacheKey) {
  try {
    const payload = JSON.parse(await fs.readFile(cachePath, "utf8"));
    if (JSON.stringify(payload.cacheKey) === JSON.stringify(cacheKey) && payload.analysis) {
      return payload.analysis;
    }
  } catch (_error) {
    return null;
  }
  return null;
}

async function writeGeminiAnalysisCache(cachePath, cacheKey, analysis) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify({
    cacheKey,
    cachedAt: new Date().toISOString(),
    analysis
  }, null, 2), "utf8");
}

function isEvidenceStoreTooWeakForMetadataOnly(evidenceStore, sceneMetadataResult) {
  const report = evidenceStore?.report || {};
  const evidenceCount = Number(report.evidenceCount || 0);
  const usefulEvidenceCount = Number(report.strongEvidenceCount || 0) + Number(report.mediumEvidenceCount || 0);
  const hasTranscript = Boolean(sceneMetadataResult?.transcriptPath) || /srt|whisper/i.test(sceneMetadataResult?.transcriptProvider || "");
  return evidenceCount > 0
    && usefulEvidenceCount === 0
    && !hasTranscript;
}

function normalizeRole(value, index) {
  const normalized = safeText(value).toLowerCase();
  if (VALID_ROLES.includes(normalized)) {
    return normalized;
  }
  return VALID_ROLES[Math.min(index, VALID_ROLES.length - 1)];
}

function sumDurations(segments, key = "clipDuration") {
  return segments.reduce((total, segment) => total + Number(segment[key] || 0), 0);
}

function expandSegmentsToTarget(segments, sourceDuration, targetCoverage) {
  const expanded = segments
    .map((segment) => ({ ...segment }))
    .sort((a, b) => a.startSec - b.startSec);

  let remaining = Math.max(0, Number(targetCoverage) - sumDurations(expanded));
  if (remaining <= 0.05) {
    return expanded;
  }

  let guard = 0;
  while (remaining > 0.05 && guard < 400) {
    let progressed = false;
    for (let index = 0; index < expanded.length && remaining > 0.05; index += 1) {
      const current = expanded[index];
      const prevEnd = index === 0 ? 0 : expanded[index - 1].endSec + 0.05;
      const nextStart = index === expanded.length - 1 ? sourceDuration : expanded[index + 1].startSec - 0.05;
      const beforeRoom = Math.max(0, current.startSec - prevEnd);
      const afterRoom = Math.max(0, nextStart - current.endSec);

      if (beforeRoom > 0.06 && remaining > 0.05) {
        const take = Math.min(0.22, beforeRoom, remaining);
        current.startSec -= take;
        current.clipDuration += take;
        remaining -= take;
        progressed = true;
      }

      if (afterRoom > 0.06 && remaining > 0.05) {
        const take = Math.min(0.22, afterRoom, remaining);
        current.endSec += take;
        current.clipDuration += take;
        remaining -= take;
        progressed = true;
      }
    }

    if (!progressed) {
      break;
    }
    guard += 1;
  }

  return expanded.map((segment) => ({
    ...segment,
    clipDuration: Math.max(0.4, segment.endSec - segment.startSec)
  }));
}

function assignRenderDurations(segments, targetDuration, transitionDuration) {
  const overlapBudget = transitionDuration * Math.max(0, segments.length - 1);
  const totalBudget = Number(targetDuration) + overlapBudget;
  const roleWeightMap = { hook: 0.50, setup: 0.80, conflict: 1.10, escalation: 1.50, cliffhanger: 0.60 };
  const weights = segments.map((segment) => {
    const base = Math.max(1.8, Number(segment.requestedDurationSec || segment.clipDuration || 1.8));
    const roleMultiplier = roleWeightMap[segment.role] || 1.0;
    return base * roleMultiplier;
  });
  const weightTotal = weights.reduce((sum, value) => sum + value, 0) || totalBudget;

  const renderDurations = weights.map((weight) => (weight / weightTotal) * totalBudget);
  const drift = totalBudget - renderDurations.reduce((sum, value) => sum + value, 0);
  renderDurations[renderDurations.length - 1] += drift;

  return segments.map((segment, index) => ({
    ...segment,
    renderDuration: Math.max(1.8, Number(renderDurations[index] || segment.clipDuration || 1.8))
  }));
}

function tightenOpeningPacing(segments, targetDuration) {
  const updated = segments.map((segment) => ({ ...segment }));
  if (!updated.length) {
    return updated;
  }

  const openingCap = Math.min(4.8, Math.max(3.6, Number(targetDuration) * 0.13));
  const secondBeatCap = Math.min(5.3, Math.max(4.0, Number(targetDuration) * 0.15));
  const firstTwoCap = Math.min(9.8, Math.max(8.2, Number(targetDuration) * 0.24));

  let freed = 0;

  if (updated[0].renderDuration > openingCap) {
    freed += updated[0].renderDuration - openingCap;
    updated[0].renderDuration = openingCap;
  }

  if (updated[1] && updated[1].renderDuration > secondBeatCap) {
    freed += updated[1].renderDuration - secondBeatCap;
    updated[1].renderDuration = secondBeatCap;
  }

  if (updated[1]) {
    const combined = updated[0].renderDuration + updated[1].renderDuration;
    if (combined > firstTwoCap) {
      const trim = combined - firstTwoCap;
      const reducibleSecond = Math.max(0, updated[1].renderDuration - 3.6);
      const takeSecond = Math.min(trim, reducibleSecond);
      updated[1].renderDuration -= takeSecond;
      freed += takeSecond;

      const remainingTrim = trim - takeSecond;
      if (remainingTrim > 0) {
        const reducibleFirst = Math.max(0, updated[0].renderDuration - 3.2);
        const takeFirst = Math.min(remainingTrim, reducibleFirst);
        updated[0].renderDuration -= takeFirst;
        freed += takeFirst;
      }
    }
  }

  if (freed > 0.02) {
    const recipients = updated.slice(2);
    const recipientWeights = recipients.map((segment) => {
      if (segment.energy === "panic") {
        return 1.55;
      }
      if (segment.energy === "tense") {
        return 1.2;
      }
      return 0.85;
    });
    const totalWeight = recipientWeights.reduce((sum, value) => sum + value, 0) || 1;

    recipients.forEach((segment, index) => {
      segment.renderDuration += (freed * recipientWeights[index]) / totalWeight;
    });
  }

  return updated;
}

function getExpansionWeight(segment, index) {
  if (segment.energy === "panic") {
    return 1.4 + index * 0.05;
  }
  if (segment.energy === "tense") {
    return 1.15 + index * 0.03;
  }
  return 0.9 + index * 0.02;
}

function getReductionWeight(segment, index) {
  if (segment.energy === "setup") {
    return 1.45 - index * 0.02;
  }
  if (segment.energy === "tense") {
    return 1.1;
  }
  return 0.82;
}

function distributeDurationDelta(durations, bounds, amount, direction, weightGetter) {
  let remaining = Math.max(0, amount);
  let guard = 0;

  while (remaining > 0.01 && guard < 50) {
    const capacities = durations.map((duration, index) => {
      const bound = bounds[index];
      const capacity = direction === "expand"
        ? Math.max(0, bound.max - duration)
        : Math.max(0, duration - bound.min);
      return {
        index,
        capacity,
        weight: capacity > 0 ? weightGetter(bound.segment, index) : 0
      };
    }).filter((entry) => entry.capacity > 0 && entry.weight > 0);

    if (!capacities.length) {
      break;
    }

    const weightedCapacity = capacities.reduce((sum, entry) => sum + entry.capacity * entry.weight, 0);
    if (weightedCapacity <= 0) {
      break;
    }

    let movedThisPass = 0;
    for (const entry of capacities) {
      const proposed = remaining * ((entry.capacity * entry.weight) / weightedCapacity);
      const delta = Math.min(entry.capacity, proposed);
      durations[entry.index] += direction === "expand" ? delta : -delta;
      movedThisPass += delta;
    }

    remaining -= movedThisPass;
    if (movedThisPass <= 0.001) {
      break;
    }
    guard += 1;
  }

  return durations;
}

function constrainNarrationRenderDurations(segments, targetDuration, transitionDuration, options = {}) {
  const minSpeechRate = Number(options.minSpeechRate || 0.92);
  const maxSpeechRate = Number(options.maxSpeechRate || 1.12);
  const overlapBudget = transitionDuration * Math.max(0, segments.length - 1);
  const targetBudget = Number(targetDuration) + overlapBudget;

  const bounds = segments.map((segment) => {
    const rawAudioDuration = Math.max(0.4, Number(segment.rawAudioDuration || segment.renderDuration || segment.clipDuration || 0.4));
    return {
      segment,
      min: rawAudioDuration / maxSpeechRate,
      max: rawAudioDuration / minSpeechRate
    };
  });

  const durations = segments.map((segment, index) => clamp(
    Number(segment.renderDuration || segment.rawAudioDuration || segment.clipDuration || 1.8),
    bounds[index].min,
    bounds[index].max
  ));

  const currentTotal = durations.reduce((sum, value) => sum + value, 0);

  if (currentTotal < targetBudget - 0.01) {
    distributeDurationDelta(
      durations,
      bounds,
      targetBudget - currentTotal,
      "expand",
      getExpansionWeight
    );
  } else if (currentTotal > targetBudget + 0.01) {
    distributeDurationDelta(
      durations,
      bounds,
      currentTotal - targetBudget,
      "reduce",
      getReductionWeight
    );
  }

  const finalTotal = durations.reduce((sum, value) => sum + value, 0);
  const drift = targetBudget - finalTotal;
  if (Math.abs(drift) > 0.01) {
    const direction = drift > 0 ? "expand" : "reduce";
    distributeDurationDelta(
      durations,
      bounds,
      Math.abs(drift),
      direction,
      direction === "expand" ? getExpansionWeight : getReductionWeight
    );
  }

  return segments.map((segment, index) => ({
    ...segment,
    minRenderDuration: bounds[index].min,
    maxRenderDuration: bounds[index].max,
    renderDuration: durations[index]
  }));
}

function getNaturalVoicePad(segment, index) {
  if (segment.role === "cliffhanger") {
    return 0.22;
  }
  if (segment.role === "hook") {
    return 0.08;
  }
  if (segment.role === "escalation") {
    return 0.10;
  }
  return index === 0 ? 0.08 : 0.14;
}

function useNaturalNarrationDurations(segments) {
  return segments.map((segment, index) => {
    const rawAudioDuration = Math.max(0.45, Number(segment.rawAudioDuration || segment.renderDuration || segment.clipDuration || 0.45));
    const renderDuration = rawAudioDuration + getNaturalVoicePad(segment, index);
    return {
      ...segment,
      minRenderDuration: rawAudioDuration,
      maxRenderDuration: renderDuration,
      renderDuration
    };
  });
}

function fitSegmentsToRenderDurations(segments, sourceDuration, genreMode) {
  const safeSourceDuration = Math.max(0.4, Number(sourceDuration) || 0.4);

  return segments.map((segment) => {
    const speed = Math.max(0.5, Math.min(2.0, getSpeedFactor(segment.role, genreMode)));
    const currentDuration = Math.max(0.4, Number(segment.clipDuration || segment.endSec - segment.startSec || 0.4));
    const renderDuration = Math.max(0.4, Number(segment.renderDuration || currentDuration));
    const desiredSourceDuration = Math.min(
      safeSourceDuration,
      Math.max(currentDuration, renderDuration * speed + 0.12)
    );

    if (desiredSourceDuration <= currentDuration + 0.05) {
      return segment;
    }

    const center = clamp(
      (Number(segment.startSec || 0) + Number(segment.endSec || 0)) / 2,
      desiredSourceDuration / 2,
      safeSourceDuration - desiredSourceDuration / 2
    );
    let startSec = center - desiredSourceDuration / 2;
    let endSec = center + desiredSourceDuration / 2;

    if (startSec < 0) {
      endSec = Math.min(safeSourceDuration, endSec - startSec);
      startSec = 0;
    }
    if (endSec > safeSourceDuration) {
      startSec = Math.max(0, startSec - (endSec - safeSourceDuration));
      endSec = safeSourceDuration;
    }

    return {
      ...segment,
      startSec,
      endSec,
      clipDuration: Math.max(0.4, endSec - startSec),
      expandedForRender: true
    };
  });
}

function ensureVisualCoverageForBeats(beats, sourceDuration, genreMode) {
  const safeSourceDuration = Math.max(0.4, Number(sourceDuration) || 0.4);
  return beats.map((beat) => {
    const speed = Math.max(0.25, Math.min(1.25, getSpeedFactor(beat.role, genreMode)));
    const neededSourceDuration = Math.min(safeSourceDuration, Math.max(0.5, Number(beat.renderDuration || beat.audioDuration || 0.5) * speed + 0.08));
    const currentDuration = Math.max(0.4, Number(beat.clipDuration || beat.endSec - beat.startSec || 0.4));
    if (currentDuration >= neededSourceDuration - 0.03) {
      return beat;
    }

    const midpoint = clamp(
      (Number(beat.startSec || 0) + Number(beat.endSec || 0)) / 2,
      neededSourceDuration / 2,
      safeSourceDuration - neededSourceDuration / 2
    );
    const startSec = clamp(midpoint - neededSourceDuration / 2, 0, Math.max(0, safeSourceDuration - neededSourceDuration));
    const endSec = Math.min(safeSourceDuration, startSec + neededSourceDuration);
    return {
      ...beat,
      startSec,
      endSec,
      clipDuration: Math.max(0.4, endSec - startSec),
      expandedForVoiceCoverage: true
    };
  });
}

function normalizeSegments(rawSegments, sourceDuration, targetDuration, narrationEnabled, genreMode = "thriller") {
  const fallbackRoles = ["hook", "setup", "conflict", "escalation", "cliffhanger"];
  const segmentSource = Array.isArray(rawSegments) && rawSegments.length > 0
    ? rawSegments
    : fallbackRoles.map((role, index) => {
        const slot = sourceDuration / fallbackRoles.length;
        const startSec = slot * index;
        const endSec = Math.min(sourceDuration, startSec + Math.min(slot * 0.8, targetDuration / fallbackRoles.length));
        return {
          role,
          startSec,
          endSec,
          reason: `Fallback ${role} segment`,
          narrationLine: "This moment changes everything.",
          subtitleText: "This moment changes everything.",
          screenText: "",
          emotionalAnchor: "curiosity",
          visual_energy: role === "escalation" ? 9 : role === "hook" ? 8 : 5,
        audio_vibe: "Suspense",
        font_style: "standard",
        reframe: segment.reframe || null,
        viralScore: 5
        };
      });

  return segmentSource
    .slice(0, 8)
    .map((segment, index) => {
      const startSec = clamp(Number(segment.startSec || 0), 0, Math.max(0, sourceDuration - 0.4));
      const endSec = clamp(Number(segment.endSec || startSec + 2.4), startSec + 0.4, sourceDuration);
      const viralScore = Number(segment.viralScore || segment.importanceScore || 5);
      const normalizedRole = normalizeRole(segment.role, index);
      const quality = scoreSceneQuality({ ...segment, role: normalizedRole, viralScore });
      return {
        index,
        role: normalizedRole,
        startSec,
        endSec,
        clipDuration: endSec - startSec,
        requestedDurationSec: Math.max(1.5, Number(segment.targetDurationSec || endSec - startSec)),
        reason: safeText(segment.reason, "Selected highlight"),
        narrationLine: narrationEnabled ? polishNarrationText(segment.narrationLine || "This moment changes everything.", normalizedRole, genreMode) : "",
        subtitleText: narrationEnabled ? safeText(segment.subtitleText || segment.narrationLine, "This moment changes everything.") : "",
        screenText: safeText(segment.screenText, ""),
        emotionalAnchor: safeText(segment.emotionalAnchor, "curiosity"),
        scenePurpose: safeText(segment.scenePurpose, ""),
        narrationTone: safeText(segment.narrationTone, ""),
        viewerQuestion: safeText(segment.viewerQuestion, ""),
        continuityNote: safeText(segment.continuityNote, ""),
        avoidSpoiler: Boolean(segment.avoidSpoiler),
        visual_energy: Number(segment.visual_energy) || (normalizedRole === "escalation" ? 9 : normalizedRole === "hook" ? 8 : 5),
        audio_vibe: safeText(segment.audio_vibe, "Suspense"),
        font_style: safeText(segment.font_style, "standard"),
        reframe: segment.reframe || null,
        keywords: Array.isArray(segment.keywords) ? segment.keywords.map((keyword) => safeText(keyword)).filter(Boolean).slice(0, 3) : [],
        viralScore,
        ...quality,
        energy: normalizedRole === "hook" || normalizedRole === "escalation" ? "panic" : normalizedRole === "setup" ? "setup" : "tense"
      };
    })
    .filter((segment) => segment.clipDuration > 0.35)
    .sort((a, b) => {
      if (a.role === "hook") return -1;
      if (b.role === "hook") return 1;
      return a.startSec - b.startSec;
    });
}

function getNarrationLanguageCode(language) {
  const normalized = safeText(language).toLowerCase();
  if (normalized === "vi") {
    return "vi";
  }
  if (normalized === "en") {
    return "en";
  }
  return undefined;
}

function getNarrationAudioExtension(voiceProvider) {
  return voiceProvider === "windows_local" || voiceProvider === "omnivoice" || voiceProvider === "kokoro" ? ".wav" : ".mp3";
}

function ensureNarrationSentence(text) {
  const clean = safeText(text);
  if (!clean) {
    return "";
  }
  return /[.!?]"?$/.test(clean) ? clean : `${clean}.`;
}

function buildContinuousNarrationPlan(segments) {
  const separator = " ";
  let cursor = 0;
  const entries = segments.map((segment) => {
    const text = ensureNarrationSentence(segment.narrationLine);
    const start = cursor;
    const end = start + text.length;
    cursor = end + separator.length;
    return {
      ...segment,
      narrationText: text,
      textStart: start,
      textEnd: end
    };
  });

  return {
    fullText: entries.map((entry) => entry.narrationText).join(separator),
    entries
  };
}

function buildTextToAlignmentIndexMap(text, alignmentCharacters) {
  const map = new Array(text.length).fill(-1);
  let textIndex = 0;
  let alignmentIndex = 0;

  while (textIndex < text.length && alignmentIndex < alignmentCharacters.length) {
    const textChar = text[textIndex];
    const alignedChar = alignmentCharacters[alignmentIndex];

    if (textChar === alignedChar || textChar.toLowerCase() === alignedChar.toLowerCase()) {
      map[textIndex] = alignmentIndex;
      textIndex += 1;
      alignmentIndex += 1;
      continue;
    }

    if (/\s/.test(textChar) && /\s/.test(alignedChar)) {
      map[textIndex] = alignmentIndex;
      textIndex += 1;
      alignmentIndex += 1;
      continue;
    }

    if (/\s/.test(textChar)) {
      textIndex += 1;
      continue;
    }

    if (/\s/.test(alignedChar)) {
      alignmentIndex += 1;
      continue;
    }

    alignmentIndex += 1;
  }

  return map;
}

function resolveTextRangeToAudioSpan(rangeStart, rangeEnd, indexMap, startTimes, endTimes) {
  let firstIndex = -1;
  let lastIndex = -1;

  for (let index = rangeStart; index < rangeEnd; index += 1) {
    const mapped = indexMap[index];
    if (mapped >= 0) {
      firstIndex = mapped;
      break;
    }
  }

  for (let index = rangeEnd - 1; index >= rangeStart; index -= 1) {
    const mapped = indexMap[index];
    if (mapped >= 0) {
      lastIndex = mapped;
      break;
    }
  }

  if (firstIndex === -1 || lastIndex === -1) {
    return null;
  }

  return {
    startSec: Number(startTimes[firstIndex] || 0),
    endSec: Number(endTimes[lastIndex] || startTimes[lastIndex] || 0)
  };
}

function buildWordTimingsFromAlignment(text, indexMap, startTimes, endTimes) {
  const words = [];
  const matcher = /\S+/g;
  let match;

  while ((match = matcher.exec(text)) !== null) {
    const wordStart = match.index;
    const wordEnd = match.index + match[0].length;
    const span = resolveTextRangeToAudioSpan(wordStart, wordEnd, indexMap, startTimes, endTimes);
    if (!span) {
      continue;
    }
    words.push({
      text: match[0],
      textStart: wordStart,
      textEnd: wordEnd,
      startSec: span.startSec,
      endSec: span.endSec
    });
  }

  return words;
}

function allocateBeatPadsFromNarration(beats) {
  return beats.map((beat, index) => getNaturalVoicePad(beat, index));
}

function buildBeatMapFromNarrationAlignment(segments, narrationPlan, alignment, targetDuration) {
  const characters = alignment?.characters || [];
  const startTimes = alignment?.character_start_times_seconds || [];
  const endTimes = alignment?.character_end_times_seconds || [];

  if (!characters.length || !startTimes.length || !endTimes.length) {
    throw new Error("ElevenLabs did not return usable alignment data.");
  }

  const indexMap = buildTextToAlignmentIndexMap(narrationPlan.fullText, characters);
  const words = buildWordTimingsFromAlignment(narrationPlan.fullText, indexMap, startTimes, endTimes);

  const beats = narrationPlan.entries.map((entry) => {
    const span = resolveTextRangeToAudioSpan(entry.textStart, entry.textEnd, indexMap, startTimes, endTimes);
    if (!span) {
      throw new Error(`Could not map narration timing for segment ${entry.index + 1}.`);
    }

    const beatWords = words.filter((word) => word.textStart >= entry.textStart && word.textEnd <= entry.textEnd);
    const audioDuration = Math.max(0.35, span.endSec - span.startSec);

    return {
      ...entry,
      audioStartSec: span.startSec,
      audioEndSec: span.endSec,
      audioDuration,
      beatWords
    };
  });

  const pads = allocateBeatPadsFromNarration(beats, targetDuration);

  return beats.map((beat, index) => ({
    ...beat,
    padAfterSec: pads[index],
    renderDuration: beat.audioDuration + pads[index]
  }));
}

function buildEstimatedBeatMapFromNarration(segments, narrationPlan, audioDuration) {
  const totalTextLength = narrationPlan.entries.reduce((sum, entry) => sum + Math.max(1, entry.narrationText.length), 0) || 1;
  let audioCursor = 0;

  return narrationPlan.entries.map((entry, index) => {
    const isLast = index === narrationPlan.entries.length - 1;
    const estimatedDuration = isLast
      ? Math.max(0.35, Number(audioDuration) - audioCursor)
      : Math.max(0.35, Number(audioDuration) * (Math.max(1, entry.narrationText.length) / totalTextLength));
    const beat = {
      ...entry,
      audioStartSec: audioCursor,
      audioEndSec: audioCursor + estimatedDuration,
      audioDuration: estimatedDuration,
      beatWords: []
    };
    audioCursor += estimatedDuration;
    const padAfterSec = getNaturalVoicePad(beat, index);
    return {
      ...beat,
      padAfterSec,
      renderDuration: estimatedDuration + padAfterSec
    };
  });
}

function getBeatMapDuration(beats) {
  return beats.reduce((sum, beat) => sum + Number(beat.renderDuration || beat.audioDuration || 0), 0);
}

function scaleBeatMapToDuration(beats, targetDuration) {
  const currentDuration = getBeatMapDuration(beats);
  const target = Math.max(0.3, Number(targetDuration || currentDuration || 0.3));
  const scale = currentDuration > 0 ? target / currentDuration : 1;
  return beats.map((beat) => ({
    ...beat,
    audioStartSec: Number(beat.audioStartSec || 0) * scale,
    audioEndSec: Number(beat.audioEndSec || 0) * scale,
    audioDuration: Number(beat.audioDuration || 0) * scale,
    padAfterSec: Number(beat.padAfterSec || 0) * scale,
    renderDuration: Number(beat.renderDuration || 0) * scale,
    beatWords: Array.isArray(beat.beatWords)
      ? beat.beatWords.map((word) => ({
          ...word,
          startSec: Number(word.startSec || 0) * scale,
          endSec: Number(word.endSec || 0) * scale
        }))
      : []
  }));
}

function validateNarrationDuration(beatMap, targetDuration) {
  const actualDuration = getBeatMapDuration(beatMap);
  const target = Number(targetDuration || 0);
  if (!target || (actualDuration >= target * 0.92 && actualDuration <= target * 1.12)) {
    return;
  }

  const missingSeconds = target - actualDuration;
  const suggestedWords = Math.ceil(Math.abs(missingSeconds) * DEFAULT_WORDS_PER_SECOND);
  throw new Error(
    `Narration duration does not match the requested ${Math.round(target)}s output. ` +
    `The generated voice is about ${actualDuration.toFixed(1)}s. ` +
    `${missingSeconds > 0 ? "Expand" : "Shorten"} the review narration by roughly ${suggestedWords} spoken words or regenerate the plan, then render again.`
  );
}

async function buildStrictSyncReport({
  ffmpeg,
  segmentPaths,
  renderPlanSegments,
  finalVideoPath,
  narrationPath,
  targetDuration,
  maxDriftSec = STRICT_SYNC_MAX_DRIFT_SEC
}) {
  const segments = [];
  let maxSegmentDriftSec = 0;

  for (let index = 0; index < segmentPaths.length; index += 1) {
    const segmentPath = segmentPaths[index];
    const plan = renderPlanSegments[index] || {};
    const expectedDuration = Math.max(0, Number(plan.renderDuration || 0));
    const segmentMeta = await ffmpeg.probeVideo(segmentPath);
    const actualDuration = Math.max(0, Number(segmentMeta.duration || 0));
    const driftSec = Math.abs(actualDuration - expectedDuration);
    maxSegmentDriftSec = Math.max(maxSegmentDriftSec, driftSec);
    segments.push({
      index: Number.isFinite(Number(plan.index)) ? Number(plan.index) : index,
      role: plan.role || "",
      narrativeBeat: plan.narrativeBeat || plan.role || "",
      path: segmentPath,
      expectedDuration,
      actualDuration,
      rawAudioDuration: Number(plan.rawAudioDuration || 0),
      speechFitRatio: expectedDuration > 0 ? Number((Number(plan.rawAudioDuration || 0) / expectedDuration).toFixed(3)) : 0,
      driftSec,
      passed: driftSec <= maxDriftSec
    });
  }

  const finalVideo = await ffmpeg.probeVideo(finalVideoPath);
  const expectedFinalDuration = Math.max(0.3, Number(targetDuration || finalVideo.duration || 0.3));
  const finalVideoDriftSec = Math.abs(Number(finalVideo.duration || 0) - expectedFinalDuration);
  let narration = null;
  let finalVoiceVideoDriftSec = null;

  if (narrationPath) {
    narration = await ffmpeg.probeAudio(narrationPath).catch(() => null);
    if (narration?.duration) {
      finalVoiceVideoDriftSec = Math.abs(Number(finalVideo.duration || 0) - Number(narration.duration || 0));
    }
  }

  const passed = segments.every((segment) => segment.passed)
    && finalVideoDriftSec <= maxDriftSec
    && (finalVoiceVideoDriftSec === null || finalVoiceVideoDriftSec <= maxDriftSec);

  return {
    mode: "strict-duration-sync",
    maxAllowedDriftSec: maxDriftSec,
    passed,
    targetDuration: expectedFinalDuration,
    finalVideo: {
      path: finalVideoPath,
      duration: Number(finalVideo.duration || 0),
      driftSec: finalVideoDriftSec,
      hasAudio: Boolean(finalVideo.hasAudio)
    },
    narration: narration
      ? {
          path: narrationPath,
          duration: Number(narration.duration || 0),
          videoDriftSec: finalVoiceVideoDriftSec
        }
      : null,
    maxSegmentDriftSec,
    segments
  };
}

function applyPolishedNarration(segments, polishResult, voiceSpeed = 1) {
  const polishedSegments = Array.isArray(polishResult?.segments) ? polishResult.segments : [];
  const shouldExpandSegments = polishedSegments.length > segments.length;
  const sourceSegments = shouldExpandSegments ? polishedSegments : segments;
  const updatedSegments = sourceSegments.map((sourceSegment, index) => {
    const segment = shouldExpandSegments
      ? {
        ...(segments[index] || segments[segments.length - 1] || {}),
        index,
        id: safeText(sourceSegment.id || sourceSegment.blockId, `polished_${String(index + 1).padStart(2, "0")}`)
      }
      : sourceSegment;
    const polished = polishedSegments.find((entry) => Number(entry.index) === index)
      || polishedSegments.find((entry) => safeText(entry.role).toLowerCase() === segment.role)
      || polishedSegments[index]
      || {};
    const narrationLine = safeText(polished.narrationLine, segment.narrationLine);
    const estimatedRenderDuration = shouldExpandSegments
      ? Math.max(1.4, estimateSpeechSeconds(narrationLine, voiceSpeed) + 0.55)
      : segment.renderDuration;
    return {
      ...segment,
      index,
      role: safeText(polished.role, segment.role),
      narrativeBeat: safeText(polished.narrativeBeat, segment.narrativeBeat || polished.purpose || ""),
      beatPurpose: safeText(polished.purpose, segment.beatPurpose || ""),
      narrationLine,
      subtitleText: safeText(polished.subtitleText, segment.subtitleText || polished.narrationLine || segment.narrationLine),
      renderDuration: estimatedRenderDuration,
      visualEvent: safeText(polished.visualEvent, segment.visualEvent || ""),
      plotEventId: safeText(polished.plotEventId, segment.plotEventId || ""),
      beatId: safeText(polished.beatId, segment.beatId || ""),
      characterIds: Array.isArray(polished.characterIds) ? polished.characterIds : (Array.isArray(segment.characterIds) ? segment.characterIds : []),
      evidenceIds: Array.isArray(polished.evidenceIds) ? polished.evidenceIds : (Array.isArray(segment.evidenceIds) ? segment.evidenceIds : []),
      currentCharacterGoal: safeText(polished.currentCharacterGoal, segment.currentCharacterGoal || ""),
      currentCharacterKnowledge: safeText(polished.currentCharacterKnowledge, segment.currentCharacterKnowledge || ""),
      emotionBefore: safeText(polished.emotionBefore, segment.emotionBefore || ""),
      emotionAfter: safeText(polished.emotionAfter, segment.emotionAfter || ""),
      whatChanged: safeText(polished.whatChanged, segment.whatChanged || ""),
      visualEvidence: safeText(polished.visualEvidence, segment.visualEvidence || ""),
      transcriptEvidence: safeText(polished.transcriptEvidence, segment.transcriptEvidence || ""),
      evidenceLevel: safeText(polished.evidenceLevel, segment.evidenceLevel || ""),
      groundingNote: safeText(polished.groundingNote, segment.groundingNote || "")
    };
  });
  return repairPrematureRevealNarration(updatedSegments);
}

function getSegmentAnchorTerms(segment) {
  const text = [
    segment.description,
    segment.reason,
    segment.screenText
  ].join(" ").toLowerCase();
  const terms = [];
  if (/android|robot|machine|mechanic|synthetic|legless|no legs|wires|face.*split|face.*tear|not human/.test(text)) {
    terms.push("android", "robot", "machine", "legless", "no legs", "not human", "wires", "mechanical");
  }
  return [...new Set(terms)];
}

function repairPrematureRevealNarration(segments) {
  const strictAnchors = segments
    .map((segment, index) => ({ index, terms: getSegmentAnchorTerms(segment) }))
    .filter((entry) => entry.terms.length);
  if (!strictAnchors.length) {
    return segments;
  }

  return segments.map((segment, index) => {
    let narrationLine = segment.narrationLine;
    let subtitleText = segment.subtitleText;
    for (const anchor of strictAnchors) {
      if (index >= anchor.index) {
        continue;
      }
      const pattern = new RegExp(`\\b(${anchor.terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "ig");
      if (pattern.test(narrationLine)) {
        narrationLine = safeText(narrationLine.replace(pattern, "something wrong"));
        subtitleText = safeText(subtitleText.replace(pattern, "something wrong"));
      }
    }
    return {
      ...segment,
      narrationLine,
      subtitleText
    };
  });
}

async function synthesizeContinuousNarration({
  voiceProvider,
  settings,
  project,
  genreMode,
  voicePreset,
  narrationText,
  outputPath,
  alignmentPath,
  onProgress
}) {
  if (voiceProvider === "elevenlabs") {
    const elevenLabs = settings.elevenLabsApiKey
      ? new ElevenLabsService(settings.elevenLabsApiKey, settings.elevenLabsModel, settings)
      : null;
    if (!elevenLabs) {
      throw new Error("ElevenLabs API key is missing.");
    }
    const ttsResult = await elevenLabs.synthesizeSpeechWithTimestamps({
      text: narrationText,
      voiceId: project.voiceId || settings.defaultVoiceId,
      outputPath,
      alignmentPath,
      languageCode: getNarrationLanguageCode(project.narrationLanguage),
      performanceMode: "story",
      genreMode
    });
    return { alignment: ttsResult.alignment };
  }

  if (voiceProvider === "edge_neural") {
    const edgeTts = new EdgeTtsService();
    try {
      await edgeTts.synthesizeSpeech({
        text: narrationText,
        voiceName: project.voiceId || "",
        outputPath,
        language: project.narrationLanguage || "auto",
        genreMode,
        rate: project.edgeVoiceRate ?? settings.edgeVoiceRate,
        pitch: project.edgeVoicePitchHz ?? settings.edgeVoicePitchHz,
        volume: project.edgeVoiceVolume ?? settings.edgeVoiceVolume
      });
    } catch (error) {
      if (typeof onProgress === "function") {
        await onProgress(`Edge Neural Free failed (${error.message}); falling back to Windows Local TTS.`);
      }
      const windowsVoiceService = new WindowsVoiceService();
      await windowsVoiceService.synthesizeSpeech({
        text: narrationText,
        voiceName: settings.defaultWindowsVoice || "",
        outputPath,
        rate: voicePreset.windowsRate
      });
    }
    return { alignment: null };
  }

  if (voiceProvider === "omnivoice") {
    const omniVoice = new OmniVoiceService(settings);
    await omniVoice.synthesizeSpeech({
      text: narrationText,
      voiceName: project.voiceId || settings.omniVoiceInstruct || "",
      outputPath,
      language: project.narrationLanguage || "auto",
      durationSec: project.targetDuration,
      onProgress
    });
    return { alignment: null };
  }

  if (voiceProvider === "kokoro") {
    const kokoro = new KokoroVoiceService(settings);
    await kokoro.synthesizeSpeech({
      text: narrationText,
      voiceName: project.voiceId || "af_heart",
      outputPath,
      language: project.narrationLanguage || "en",
      speed: settings.kokoroSpeed || 1,
      onProgress
    });
    return { alignment: null };
  }

  const windowsVoiceService = new WindowsVoiceService();
  await windowsVoiceService.synthesizeSpeech({
    text: narrationText,
    voiceName: project.voiceId || settings.defaultWindowsVoice || "",
    outputPath,
    rate: voicePreset.windowsRate
  });
  return { alignment: null };
}

function buildSubtitleEntriesFromBeatMap(beats) {
  const cues = [];
  let elapsed = 0;
  let cueIndex = 1;

  for (const beat of beats) {
    const beatStart = elapsed;
    const words = beat.beatWords || [];
    let bucket = [];

    const flush = () => {
      if (!bucket.length) {
        return;
      }
      cues.push({
        index: cueIndex,
        startSec: beatStart + bucket[0].startSec,
        endSec: beatStart + bucket[bucket.length - 1].endSec,
        text: bucket.map((word) => word.text).join(" "),
        keywords: beat.keywords || [],
        font_style: beat.font_style
      });
      cueIndex += 1;
      bucket = [];
    };

    const beatOffset = beat.audioStartSec;

    for (const word of words) {
      const relativeWord = {
        ...word,
        startSec: Math.max(0, word.startSec - beatOffset),
        endSec: Math.max(0.05, word.endSec - beatOffset)
      };

      bucket.push(relativeWord);
      const textLength = bucket.map((entry) => entry.text).join(" ").length;
      const duration = bucket[bucket.length - 1].endSec - bucket[0].startSec;
      const shouldBreak = /[,.!?]$/.test(relativeWord.text) || textLength >= 26 || bucket.length >= 6 || duration >= 2.4;
      if (shouldBreak) {
        flush();
      }
    }

    flush();
    if (!words.length) {
      const fallbackText = safeText(beat.subtitleText || beat.narrationLine || beat.narrationText || "");
      const fallbackWords = fallbackText.split(/\s+/).filter(Boolean);
      const phrases = [];
      let phrase = [];
      for (const word of fallbackWords) {
        phrase.push(word);
        if (/[,.!?]$/.test(word) || phrase.length >= 6 || phrase.join(" ").length >= 34) {
          phrases.push(phrase.join(" "));
          phrase = [];
        }
      }
      if (phrase.length) {
        phrases.push(phrase.join(" "));
      }
      const cueDuration = beat.renderDuration / Math.max(1, phrases.length);
      phrases.forEach((text, index) => {
        cues.push({
          index: cueIndex,
          startSec: beatStart + index * cueDuration,
          endSec: beatStart + (index + 1) * cueDuration,
          text,
          keywords: beat.keywords || [],
          font_style: beat.font_style
        });
        cueIndex += 1;
      });
    }
    elapsed += beat.renderDuration;
  }

  return cues;
}

function buildSubtitleEntriesFromNarrationText(fullText, targetDuration) {
  const words = safeText(fullText).split(/\s+/).filter(Boolean);
  if (!words.length) {
    return [];
  }

  const cues = [];
  let bucket = [];
  const phrases = [];
  for (const word of words) {
    bucket.push(word);
    const phrase = bucket.join(" ");
    if (/[,.!?]$/.test(word) || bucket.length >= 6 || phrase.length >= 34) {
      phrases.push(phrase);
      bucket = [];
    }
  }
  if (bucket.length) {
    phrases.push(bucket.join(" "));
  }

  const duration = Math.max(0.3, Number(targetDuration || 0));
  const cueDuration = duration / Math.max(1, phrases.length);
  phrases.forEach((text, index) => {
    cues.push({
      index: index + 1,
      startSec: index * cueDuration,
      endSec: Math.min(duration, (index + 1) * cueDuration),
      text,
      keywords: [],
      font_style: "standard"
    });
  });
  return cues;
}

function appendWordSubtitleEntries(subtitleEntries, {
  segment,
  elapsedSeconds,
  durationSec,
  alignment = null,
  rawAudioDuration = 0
}) {
  const subtitleDuration = Math.max(0.2, Number(durationSec) || Number(segment.renderDuration) || 1.2);
  const narrationText = ensureNarrationSentence(segment.narrationLine || segment.subtitleText || "");
  const fallbackText = safeText(segment.subtitleText || segment.narrationLine || "");

  if (
    alignment?.characters?.length &&
    alignment?.character_start_times_seconds?.length &&
    alignment?.character_end_times_seconds?.length &&
    narrationText
  ) {
    const indexMap = buildTextToAlignmentIndexMap(narrationText, alignment.characters);
    const alignedWords = buildWordTimingsFromAlignment(
      narrationText,
      indexMap,
      alignment.character_start_times_seconds,
      alignment.character_end_times_seconds
    );

    if (alignedWords.length > 0) {
      const alignmentDuration = Math.max(
        0.2,
        Number(rawAudioDuration) || alignedWords[alignedWords.length - 1].endSec || subtitleDuration
      );
      const scale = subtitleDuration / alignmentDuration;

      let bucket = [];
      const flush = () => {
        if (!bucket.length) {
          return;
        }
        const relativeStart = Math.max(0, bucket[0].startSec * scale);
        const relativeEnd = Math.max(relativeStart + 0.25, bucket[bucket.length - 1].endSec * scale);
        subtitleEntries.push({
          index: segment.index + 1,
          startSec: elapsedSeconds + Math.min(relativeStart, subtitleDuration),
          endSec: elapsedSeconds + Math.min(relativeEnd, subtitleDuration),
          text: bucket.map((entry) => entry.text).join(" "),
          keywords: segment.keywords || [],
          font_style: segment.font_style,
          timingSource: "tts_alignment"
        });
        bucket = [];
      };

      for (const word of alignedWords) {
        bucket.push(word);
        const phrase = bucket.map((entry) => entry.text).join(" ");
        const phraseDuration = bucket[bucket.length - 1].endSec - bucket[0].startSec;
        if (/[,.!?]$/.test(word.text) || bucket.length >= 6 || phrase.length >= 34 || phraseDuration >= 1.8) {
          flush();
        }
      }
      flush();
      return;
    }
  }

  const words = fallbackText.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return;
  }

  const cues = [];
  let bucket = [];
  for (const word of words) {
    bucket.push(word);
    const phrase = bucket.join(" ");
    if (/[,.!?]$/.test(word) || bucket.length >= 6 || phrase.length >= 34) {
      cues.push(phrase);
      bucket = [];
    }
  }
  if (bucket.length) {
    cues.push(bucket.join(" "));
  }

  const durationPerCue = subtitleDuration / cues.length;
  let currentCueStart = elapsedSeconds;
  for (const cue of cues) {
    subtitleEntries.push({
      index: segment.index + 1,
      startSec: currentCueStart,
      endSec: currentCueStart + durationPerCue,
      text: cue,
      keywords: segment.keywords || [],
      font_style: segment.font_style
    });
    currentCueStart += durationPerCue;
  }
}

class PipelineService {
  constructor(projectStore) {
    this.projectStore = projectStore;
    this.runningJobs = new Set();
  }

  async listVoices(settings, provider = "elevenlabs") {
    if (provider === "windows_local") {
      const windowsVoiceService = new WindowsVoiceService();
      return windowsVoiceService.listVoices();
    }
    if (provider === "edge_neural") {
      const edgeTts = new EdgeTtsService();
      return edgeTts.listVoices();
    }
    if (provider === "omnivoice") {
      const omniVoice = new OmniVoiceService(settings);
      return omniVoice.listVoices();
    }
    if (provider === "kokoro") {
      const kokoro = new KokoroVoiceService(settings);
      return kokoro.listVoices();
    }

    const elevenLabs = new ElevenLabsService(settings.elevenLabsApiKey, settings.elevenLabsModel, settings);
    const voices = await elevenLabs.listVoices();
    return voices.map((voice) => ({
      voice_id: voice.voice_id,
      name: voice.name,
      labels: voice.labels || {},
      provider: "elevenlabs"
    }));
  }

  async planProject({ workspaceRoot, projectId, settings, onProgress }) {
    const ffmpeg = new FfmpegService(settings);
    const emit = async (step, percent, message) => {
      onProgress?.({ projectId, step, percent, message });
      await this.projectStore.updateProject(workspaceRoot, projectId, {
        status: step,
        progressPercent: percent,
        statusMessage: message
      });
    };

    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);

    await emit("preparing", 5, "�ang ki?m tra video ngu?n");
    const videoMeta = await ffmpeg.probeVideo(project.sourceVideoPath);
    if (!videoMeta.duration) {
      throw new Error("Could not read the source video duration.");
    }
    if (project.targetDuration > videoMeta.duration) {
      throw new Error(`Target duration (${project.targetDuration}s) must be shorter than or equal to the source video (${videoMeta.duration.toFixed(1)}s).`);
    }

    const thumbnailPath = path.join(paths.assetsDir, "source-thumbnail.jpg");
    await ffmpeg.extractThumbnail(project.sourceVideoPath, thumbnailPath).catch(() => {});

    const genreMode = project.genreMode || "thriller";
    const perspective = project.perspective || "third_person";
    const viralAngle = selectViralAngle(project, genreMode);
    await emit("analyzing", 12, "�ang ph�t hi?n c?nh c?c b?");
    const sceneDetector = new SceneDetectionService(settings);
    const detectedScenePath = path.join(paths.analysisDir, "detected-scenes.json");
    const detectedScenesResult = await sceneDetector.detectScenes({
      videoPath: project.sourceVideoPath,
      sourceDuration: videoMeta.duration
    }).catch((error) => ({
      provider: "fallback_even_split",
      error: error.message,
      scenes: buildFallbackCandidates(videoMeta.duration, Math.min(videoMeta.duration, Math.max(project.targetDuration, 30))).map((scene, index) => ({
        sceneId: `scene_${String(index + 1).padStart(4, "0")}`,
        startSec: scene.startSec,
        endSec: scene.endSec,
        duration: scene.endSec - scene.startSec
      }))
    }));
    const lockedScenes = summarizeLockedScenes(detectedScenesResult.scenes);
    await this.projectStore.writeJson(detectedScenePath, {
      provider: detectedScenesResult.provider,
      error: detectedScenesResult.error || "",
      scenes: lockedScenes
    }).catch(() => {});
    await emit("analyzing", 14, "�ang x�y chu?i metadata c?nh c?c b?");
    const sceneMetadataService = new SceneMetadataService(settings);
    const sceneMetadataResult = await sceneMetadataService.build({
      videoPath: project.sourceVideoPath,
      detectedScenePath,
      paths,
      project,
      onProgress: async (message) => {
        await emit("analyzing", 14, `�ang x�y chu?i metadata c?nh c?c b?: ${message}`);
      }
    }).catch((error) => ({
      provider: "failed",
      metadataPath: "",
      transcriptPath: "",
      transcriptProvider: "failed",
      transcriptError: error.message,
      scenes: []
    }));
    const sceneMetadata = {
      provider: sceneMetadataResult.provider,
      transcriptProvider: sceneMetadataResult.transcriptProvider,
      transcriptError: sceneMetadataResult.transcriptError,
      scenes: sceneMetadataResult.scenes
    };
    const evidenceStorePath = path.join(paths.analysisDir, "evidence-store.json");
    const evidenceReportPath = path.join(paths.analysisDir, "evidence-report.json");
    let evidenceStoreResult = {
      evidenceStorePath,
      evidenceStore: null
    };
    try {
      await emit("analyzing", 15, "�ang x�y Evidence Store t? d? li?u th?t c?a c?nh");
      evidenceStoreResult = await new EvidenceStoreService(settings).buildAndWrite({
        sceneMetadata,
        project,
        videoPath: project.sourceVideoPath,
        outputPath: evidenceStorePath
      });
      await this.projectStore.writeJson(evidenceReportPath, evidenceStoreResult.evidenceStore.report).catch(() => {});
    } catch (error) {
      await this.projectStore.writeJson(evidenceReportPath, {
        generatedAt: new Date().toISOString(),
        failed: true,
        error: error.message,
        warning: "Evidence Store failed. Legacy hypothesis pipeline remains available, but recap accuracy is not evidence-gated."
      }).catch(() => {});
    }
    const geminiPromptPath = path.join(paths.analysisDir, "candidate-mining-prompt.txt");
    const geminiRawResponsePath = path.join(paths.analysisDir, "candidate-mining-response.txt");
    const geminiParsedResponsePath = path.join(paths.analysisDir, "candidate-mining-response.json");
    const filmMemoryPromptPath = path.join(paths.analysisDir, "film-memory-prompt.txt");
    const filmMemoryRawResponsePath = path.join(paths.analysisDir, "film-memory-response.txt");
    const filmMemoryParsedResponsePath = path.join(paths.analysisDir, "film-memory.json");
    const filmMemoryCachePath = path.join(paths.analysisDir, "film-memory-cache.json");
    const filmUnderstandingPromptPath = path.join(paths.analysisDir, "film-understanding-prompt.txt");
    const filmUnderstandingRawResponsePath = path.join(paths.analysisDir, "film-understanding-response.txt");
    const filmUnderstandingPath = path.join(paths.analysisDir, "film-understanding.json");
    const characterBiblePath = path.join(paths.analysisDir, "character-bible.json");
    const plotTimelinePath = path.join(paths.analysisDir, "plot-timeline.json");
    const sceneRoleMapPath = path.join(paths.analysisDir, "scene-role-map.json");
    const evidenceGraphPath = path.join(paths.analysisDir, "evidence-graph.json");
    const evidenceGraphReportPath = path.join(paths.analysisDir, "evidence-graph-report.json");
    const narrativeIntelligencePromptPath = path.join(paths.analysisDir, "narrative-intelligence-prompt.txt");
    const narrativeIntelligenceRawResponsePath = path.join(paths.analysisDir, "narrative-intelligence-response.txt");
    const narrativeIntelligencePath = path.join(paths.analysisDir, "narrative-intelligence.json");
    const characterMentalModelPath = path.join(paths.analysisDir, "character-mental-model.json");
    const relationshipGraphPath = path.join(paths.analysisDir, "relationship-graph.json");
    const characterTrackerPath = path.join(paths.analysisDir, "character-tracker.json");
    const characterTrackerReportPath = path.join(paths.analysisDir, "character-tracker-report.json");
    const worldStateTimelinePath = path.join(paths.analysisDir, "world-state-timeline.json");
    const emotionalTimelinePath = path.join(paths.analysisDir, "emotional-timeline.json");
    const storyBeatGraphPath = path.join(paths.analysisDir, "story-beat-graph.json");
    const geminiCachePath = path.join(paths.analysisDir, "candidate-scene-cache.json");
    const filmMemoryCacheKey = {
      sourceVideoPath: project.sourceVideoPath,
      targetDuration: Number(project.targetDuration),
      voiceSpeed: Number(project.voiceSpeed || 1),
      genreMode,
      spoilerMode: project.spoilerMode || "",
      narrationLanguage: project.narrationLanguage || "auto",
      viralAngle,
      geminiModel: settings.geminiModel || "",
      sceneProvider: detectedScenesResult.provider,
      sceneCount: lockedScenes.length,
      metadataProvider: sceneMetadataResult.provider,
      metadataSceneCount: sceneMetadataResult.scenes.length,
      evidenceStoreSchema: evidenceStoreResult.evidenceStore?.schemaVersion || "",
      evidenceUsefulCount: Number(evidenceStoreResult.evidenceStore?.report?.strongEvidenceCount || 0) + Number(evidenceStoreResult.evidenceStore?.report?.mediumEvidenceCount || 0),
      evidenceWeakCount: Number(evidenceStoreResult.evidenceStore?.report?.weakEvidenceCount || 0),
      promptVersion: "film-memory-metadata-evidence-v2-direct-video-on-weak"
    };
    const geminiCacheKey = {
      sourceVideoPath: project.sourceVideoPath,
      targetDuration: Number(project.targetDuration),
      voiceSpeed: Number(project.voiceSpeed || 1),
      genreMode,
      spoilerMode: project.spoilerMode || "",
      narrationLanguage: project.narrationLanguage || "auto",
      viralAngle,
      geminiModel: settings.geminiModel || "",
      sceneProvider: detectedScenesResult.provider,
      sceneCount: lockedScenes.length,
      metadataProvider: sceneMetadataResult.provider,
      metadataSceneCount: sceneMetadataResult.scenes.length,
      evidenceStoreSchema: evidenceStoreResult.evidenceStore?.schemaVersion || "",
      evidenceUsefulCount: Number(evidenceStoreResult.evidenceStore?.report?.strongEvidenceCount || 0) + Number(evidenceStoreResult.evidenceStore?.report?.mediumEvidenceCount || 0),
      evidenceWeakCount: Number(evidenceStoreResult.evidenceStore?.report?.weakEvidenceCount || 0),
      promptVersion: "candidate-mining-metadata-evidence-v3-preserve-subscene-timestamps"
    };

    await emit("analyzing", 15, "�ang hi?u c?t truy?n v� kho?nh kh?c viral");
    const gemini = new GeminiService(settings.geminiApiKey, settings.geminiModel);
    const forceVideoUnderstanding = isEvidenceStoreTooWeakForMetadataOnly(evidenceStoreResult.evidenceStore, sceneMetadataResult);
    let filmMemory = await readGeminiAnalysisCache(filmMemoryCachePath, filmMemoryCacheKey);
    if (filmMemory) {
      filmMemory = applyViralAngleToFilmMemory(filmMemory, viralAngle);
      await fs.writeFile(filmMemoryParsedResponsePath, JSON.stringify(filmMemory, null, 2), "utf8").catch(() => {});
    } else {
      let rawFilmMemory;
      try {
        if (forceVideoUnderstanding) {
          throw new Error("Evidence Store has no medium/strong transcript or visual evidence; forcing direct video understanding.");
        }
        rawFilmMemory = await gemini.understandFilmFromMetadata({
          sceneMetadata,
          evidenceStore: evidenceStoreResult.evidenceStore,
          targetDuration: project.targetDuration,
          genreMode,
          spoilerMode: project.spoilerMode,
          narrationLanguage: project.narrationLanguage || "auto",
          viralAngle,
          promptLogPath: filmMemoryPromptPath,
          rawResponsePath: filmMemoryRawResponsePath,
          parsedResponsePath: filmMemoryParsedResponsePath
        });
      } catch (_metadataError) {
        rawFilmMemory = await gemini.understandFilm({
          videoPath: project.sourceVideoPath,
          targetDuration: project.targetDuration,
          genreMode,
          spoilerMode: project.spoilerMode,
          narrationLanguage: project.narrationLanguage || "auto",
          viralAngle,
          lockedScenes,
          promptLogPath: filmMemoryPromptPath,
          rawResponsePath: filmMemoryRawResponsePath,
          parsedResponsePath: filmMemoryParsedResponsePath
        });
      }
      filmMemory = applyViralAngleToFilmMemory(rawFilmMemory, viralAngle);
      await writeGeminiAnalysisCache(filmMemoryCachePath, filmMemoryCacheKey, filmMemory).catch(() => {});
    }

    await emit("analyzing", 18, "�ang x�y Film Understanding Engine");
    let filmUnderstanding;
    try {
      const rawFilmUnderstanding = await gemini.analyzeFilmUnderstandingFromMetadata({
        sceneMetadata,
        evidenceStore: evidenceStoreResult.evidenceStore,
        filmMemory,
        targetDuration: project.targetDuration,
        genreMode,
        spoilerMode: project.spoilerMode,
        narrationLanguage: project.narrationLanguage || "auto",
        viralAngle,
        promptLogPath: filmUnderstandingPromptPath,
        rawResponsePath: filmUnderstandingRawResponsePath,
        parsedResponsePath: filmUnderstandingPath
      });
      filmUnderstanding = normalizeFilmUnderstanding(rawFilmUnderstanding, filmMemory, sceneMetadata);
    } catch (error) {
      filmUnderstanding = normalizeFilmUnderstanding(null, filmMemory, sceneMetadata);
      await fs.writeFile(filmUnderstandingRawResponsePath, `Film Understanding Engine fallback: ${error.message}`, "utf8").catch(() => {});
    }
    await this.projectStore.writeJson(filmUnderstandingPath, filmUnderstanding).catch(() => {});
    await this.projectStore.writeJson(characterBiblePath, filmUnderstanding.characterBible).catch(() => {});
    await this.projectStore.writeJson(plotTimelinePath, filmUnderstanding.plotTimeline).catch(() => {});
    await this.projectStore.writeJson(sceneRoleMapPath, filmUnderstanding.sceneRoleMap).catch(() => {});

    let evidenceGraphResult = {
      evidenceGraphPath,
      evidenceGraph: null
    };
    let characterTrackerResult = {
      characterTrackerPath,
      characterTracker: null
    };
    try {
      await emit("analyzing", 18, "�ang x�y Evidence Graph cho m?ch truy?n");
      evidenceGraphResult = await new EvidenceGraphService().buildAndWrite({
        evidenceStore: evidenceStoreResult.evidenceStore,
        filmUnderstanding,
        outputPath: evidenceGraphPath
      });
      await this.projectStore.writeJson(evidenceGraphReportPath, evidenceGraphResult.evidenceGraph.report).catch(() => {});
    } catch (error) {
      await this.projectStore.writeJson(evidenceGraphReportPath, {
        generatedAt: new Date().toISOString(),
        failed: true,
        error: error.message,
        warning: "Evidence Graph failed. Narrative Intelligence will use Evidence Store fallback."
      }).catch(() => {});
    }

    try {
      characterTrackerResult = await new CharacterTrackingService().buildAndWrite({
        evidenceStore: evidenceStoreResult.evidenceStore,
        filmUnderstanding,
        narrativeIntelligence: null,
        outputPath: characterTrackerPath
      });
      await this.projectStore.writeJson(characterTrackerReportPath, characterTrackerResult.characterTracker.report).catch(() => {});
    } catch (error) {
      await this.projectStore.writeJson(characterTrackerReportPath, {
        generatedAt: new Date().toISOString(),
        failed: true,
        error: error.message,
        warning: "Character Tracker pre-pass failed. Character QA will use narrative fallback."
      }).catch(() => {});
    }

    await emit("analyzing", 19, "�ang x�y l?p hi?u m?ch truy?n");
    let narrativeIntelligence;
    try {
      const rawNarrativeIntelligence = await gemini.analyzeNarrativeIntelligence({
        sceneMetadata,
        evidenceStore: evidenceStoreResult.evidenceStore,
        evidenceGraph: evidenceGraphResult.evidenceGraph,
        characterTracker: characterTrackerResult.characterTracker,
        filmMemory,
        filmUnderstanding,
        targetDuration: project.targetDuration,
        genreMode,
        spoilerMode: project.spoilerMode,
        narrationLanguage: project.narrationLanguage || "auto",
        viralAngle,
        promptLogPath: narrativeIntelligencePromptPath,
        rawResponsePath: narrativeIntelligenceRawResponsePath,
        parsedResponsePath: narrativeIntelligencePath
      });
      narrativeIntelligence = normalizeNarrativeIntelligence(rawNarrativeIntelligence, filmUnderstanding, filmMemory, sceneMetadata);
    } catch (error) {
      narrativeIntelligence = normalizeNarrativeIntelligence(null, filmUnderstanding, filmMemory, sceneMetadata);
      await fs.writeFile(narrativeIntelligenceRawResponsePath, `Narrative Intelligence fallback: ${error.message}`, "utf8").catch(() => {});
    }
    await this.projectStore.writeJson(narrativeIntelligencePath, narrativeIntelligence).catch(() => {});
    await this.projectStore.writeJson(characterMentalModelPath, narrativeIntelligence.characterMentalModel).catch(() => {});
    await this.projectStore.writeJson(relationshipGraphPath, narrativeIntelligence.relationshipGraph).catch(() => {});
    await this.projectStore.writeJson(worldStateTimelinePath, narrativeIntelligence.worldStateTimeline).catch(() => {});
    await this.projectStore.writeJson(emotionalTimelinePath, narrativeIntelligence.emotionalTimeline).catch(() => {});
    await this.projectStore.writeJson(storyBeatGraphPath, narrativeIntelligence.storyBeatGraph).catch(() => {});

    try {
      await emit("analyzing", 19, "�ang theo d�i nh�n v?t qua Evidence Store");
      characterTrackerResult = await new CharacterTrackingService().buildAndWrite({
        evidenceStore: evidenceStoreResult.evidenceStore,
        filmUnderstanding,
        narrativeIntelligence,
        outputPath: characterTrackerPath
      });
      await this.projectStore.writeJson(characterTrackerReportPath, characterTrackerResult.characterTracker.report).catch(() => {});
    } catch (error) {
      await this.projectStore.writeJson(characterTrackerReportPath, {
        generatedAt: new Date().toISOString(),
        failed: true,
        error: error.message,
        warning: "Character Tracker failed. Character QA will use narrative fallback."
      }).catch(() => {});
    }

    await emit("analyzing", 20, "�ang ch?n c�c c?nh gi� tr? cao");
    let analysis = await readGeminiAnalysisCache(geminiCachePath, geminiCacheKey);

    if (analysis) {
      await fs.writeFile(geminiParsedResponsePath, JSON.stringify(analysis, null, 2), "utf8").catch(() => {});
    } else {
      try {
        analysis = await gemini.mineCandidateScenesFromMetadata({
          sceneMetadata,
          evidenceStore: evidenceStoreResult.evidenceStore,
          targetDuration: project.targetDuration,
          genreMode,
          spoilerMode: project.spoilerMode,
          narrationLanguage: project.narrationLanguage || "auto",
          filmMemory,
          viralAngle,
          promptLogPath: geminiPromptPath,
          rawResponsePath: geminiRawResponsePath,
          parsedResponsePath: geminiParsedResponsePath
        });
      } catch (_metadataError) {
        analysis = await gemini.mineCandidateScenes({
          videoPath: project.sourceVideoPath,
          targetDuration: project.targetDuration,
          genreMode,
          spoilerMode: project.spoilerMode,
          narrationLanguage: project.narrationLanguage || "auto",
          lockedScenes,
          filmMemory,
          viralAngle,
          promptLogPath: geminiPromptPath,
          rawResponsePath: geminiRawResponsePath,
          parsedResponsePath: geminiParsedResponsePath
        });
      }
      await writeGeminiAnalysisCache(geminiCachePath, geminiCacheKey, analysis).catch(() => {});
    }

    let candidates = normalizeCandidateScenes(
      refineCandidatesToMicroMoments(
        attachSceneMetadata(enrichCandidatesWithFilmMemory(lockCandidateTimestampsToScenes(analysis.candidates, lockedScenes), filmMemory), sceneMetadata),
        videoMeta.duration
      ),
      videoMeta.duration,
      project.spoilerMode
    );
    if (candidates.length < 3) {
      candidates = buildFallbackCandidates(videoMeta.duration, project.targetDuration);
      candidates = attachSceneMetadata(candidates, sceneMetadata);
    }
    let visualPacing = smoothVisualTimeline(
      buildVisualTimeline(candidates, project.targetDuration, videoMeta.duration, filmMemory, narrativeIntelligence),
      project.targetDuration,
      genreMode,
      videoMeta.duration
    );
    let normalizedSegments = attachSceneMetadata(visualPacing.segments, sceneMetadata);

    if (!normalizedSegments.length) {
      throw new Error("Gemini did not return enough usable candidate scenes for this video.");
    }

    const normalizedAnalysis = {
      title: safeText(analysis.title, project.title),
      summary: safeText(analysis.summary || filmMemory.logline, "AI selected the strongest visual moments for a short recap draft."),
      fullNarration: "",
      editNotes: [
        filmMemory.logline ? `Film memory: ${filmMemory.logline}` : "",
        `Scene metadata chain: ${sceneMetadataResult.provider}, transcript ${sceneMetadataResult.transcriptProvider}${sceneMetadataResult.transcriptError ? ` (${sceneMetadataResult.transcriptError})` : ""}.`,
        evidenceStoreResult.evidenceStore?.report
          ? `Evidence Store: ${evidenceStoreResult.evidenceStore.report.evidenceCount} evidence item(s), ${evidenceStoreResult.evidenceStore.report.weakEvidenceCount} weak.`
          : "Evidence Store unavailable; legacy hypothesis pipeline is active.",
        evidenceGraphResult.evidenceGraph?.report
          ? `Evidence Graph: ${evidenceGraphResult.evidenceGraph.report.nodeCount} node(s), ${evidenceGraphResult.evidenceGraph.report.edgeCount} edge(s), ${evidenceGraphResult.evidenceGraph.report.unsupportedPlotEventCount} unsupported plot event(s).`
          : "Evidence Graph unavailable; Narrative Intelligence uses Evidence Store fallback.",
        characterTrackerResult.characterTracker?.report
          ? `Character Tracker: ${characterTrackerResult.characterTracker.report.characterCount} character(s), ${characterTrackerResult.characterTracker.report.weakCharacterCount} weak.`
          : "Character Tracker unavailable; character QA uses narrative fallback.",
        `Visual-first timeline locked to ${Number(project.targetDuration).toFixed(1)}s from ${candidates.length} candidate scenes.`,
        visualPacing.originalCount !== visualPacing.visualBlockCount
          ? `Visual pacing: merged ${visualPacing.originalCount} planned beats into ${visualPacing.visualBlockCount} smoother blocks (${genreMode} min ${visualPacing.config.minBlock.toFixed(1)}s).`
          : `Visual pacing: ${visualPacing.visualBlockCount} blocks, ${genreMode} min ${visualPacing.config.minBlock.toFixed(1)}s.`,
        `Viral angle: ${viralAngle.label}.`,
        `Voice preset: ${getGenreVoicePreset(genreMode).label}.`,
        ...buildQualityNotes(normalizedSegments)
      ].filter(Boolean),
      filmMemory,
      evidenceStore: evidenceStoreResult.evidenceStore ? {
        schemaVersion: evidenceStoreResult.evidenceStore.schemaVersion,
        evidenceStorePath,
        evidenceReportPath,
        report: evidenceStoreResult.evidenceStore.report
      } : null,
      evidenceGraph: evidenceGraphResult.evidenceGraph ? {
        schemaVersion: evidenceGraphResult.evidenceGraph.schemaVersion,
        evidenceGraphPath,
        evidenceGraphReportPath,
        report: evidenceGraphResult.evidenceGraph.report
      } : null,
      characterTracker: characterTrackerResult.characterTracker ? {
        schemaVersion: characterTrackerResult.characterTracker.schemaVersion,
        characterTrackerPath,
        characterTrackerReportPath,
        report: characterTrackerResult.characterTracker.report
      } : null,
      filmUnderstanding,
      narrativeIntelligence,
      candidates,
      visualPacing,
      sceneMetadata: {
        provider: sceneMetadataResult.provider,
        transcriptProvider: sceneMetadataResult.transcriptProvider,
        transcriptError: sceneMetadataResult.transcriptError,
        metadataPath: sceneMetadataResult.metadataPath,
        transcriptPath: sceneMetadataResult.transcriptPath
      },
      segments: normalizedSegments
    };

    if (project.narrationEnabled !== false) {
      const wordTargets = getNarrationWordTargets(project.targetDuration, project.voiceSpeed);
      await emit(
        "narrating",
        28,
        `�ang vi?t k?ch b?n recap c� th? ch?nh s?a b?ng Gemini (${wordTargets.minWords}-${wordTargets.maxWords} t?, gi?ng ${wordTargets.voiceSpeed.toFixed(2)}x)`
      );
      const narrationPolishPath = path.join(paths.analysisDir, "narration-polish.json");
      const narrationContinuityPath = path.join(paths.analysisDir, "narration-continuity.json");
      let polishResult = await gemini.polishNarrationForDuration({
        title: normalizedAnalysis.title,
        summary: normalizedAnalysis.summary,
        segments: normalizedSegments,
        targetDuration: project.targetDuration,
        voiceSpeed: project.voiceSpeed || 1,
        genreMode,
        perspective,
        narrationLanguage: project.narrationLanguage || "auto",
        filmMemory: normalizedAnalysis.filmMemory,
        evidenceStore: evidenceStoreResult.evidenceStore,
        evidenceGraph: evidenceGraphResult.evidenceGraph,
        characterTracker: characterTrackerResult.characterTracker,
        filmUnderstanding: normalizedAnalysis.filmUnderstanding,
        narrativeIntelligence: normalizedAnalysis.narrativeIntelligence,
        viralAngle
      });
      const continuityResult = await gemini.refineNarrativeContinuity({
        title: normalizedAnalysis.title,
        summary: normalizedAnalysis.summary,
        segments: normalizedSegments,
        polishResult,
        targetDuration: project.targetDuration,
        voiceSpeed: project.voiceSpeed || 1,
        genreMode,
        perspective,
        narrationLanguage: project.narrationLanguage || "auto",
        filmMemory: normalizedAnalysis.filmMemory,
        evidenceStore: evidenceStoreResult.evidenceStore,
        evidenceGraph: evidenceGraphResult.evidenceGraph,
        characterTracker: characterTrackerResult.characterTracker,
        filmUnderstanding: normalizedAnalysis.filmUnderstanding,
        narrativeIntelligence: normalizedAnalysis.narrativeIntelligence,
        viralAngle
      }).catch(() => null);
      if (continuityResult) {
        polishResult = {
          ...polishResult,
          ...continuityResult,
          selectedHook: polishResult.selectedHook,
          hookOptions: polishResult.hookOptions
        };
        await this.projectStore.writeJson(narrationContinuityPath, continuityResult).catch(() => {});
      }
      let polishedSegments = diversifyRepeatedVisualSegments(
        applyPolishedNarration(normalizedSegments, polishResult, project.voiceSpeed || 1),
        normalizedAnalysis.candidates,
        videoMeta.duration
      );
      normalizedAnalysis.segments = normalizeTimelineToTarget(polishedSegments, project.targetDuration);
      normalizedAnalysis.fullNarration = safeText(
        polishResult?.fullNarration,
        normalizedAnalysis.segments.map((segment) => ensureNarrationSentence(segment.narrationLine)).join(" ")
      );
      const narrationGroundingBeforePath = path.join(paths.analysisDir, "narration-grounding-before.json");
      const narrationGroundingAfterPath = path.join(paths.analysisDir, "narration-grounding-after.json");
      let narrationGroundingReport = await new NarrationGroundingService().inspectAndWrite({
        segments: normalizedAnalysis.segments,
        sceneMetadata,
        evidenceStore: evidenceStoreResult.evidenceStore,
        filmUnderstanding: normalizedAnalysis.filmUnderstanding,
        narrativeIntelligence: normalizedAnalysis.narrativeIntelligence,
        outputPath: narrationGroundingBeforePath
      }).catch(() => null);
      let narrationGroundingRepaired = false;
      if (narrationGroundingReport?.weakSegmentCount > 0) {
        const repairResult = await gemini.repairGroundedNarration({
          title: normalizedAnalysis.title,
          summary: normalizedAnalysis.summary,
          segments: normalizedAnalysis.segments,
          groundingReport: narrationGroundingReport,
          filmMemory: normalizedAnalysis.filmMemory,
          evidenceStore: evidenceStoreResult.evidenceStore,
          evidenceGraph: evidenceGraphResult.evidenceGraph,
          characterTracker: characterTrackerResult.characterTracker,
          filmUnderstanding: normalizedAnalysis.filmUnderstanding,
          narrativeIntelligence: normalizedAnalysis.narrativeIntelligence,
          targetDuration: project.targetDuration,
          voiceSpeed: project.voiceSpeed || 1,
          genreMode,
          perspective,
          narrationLanguage: project.narrationLanguage || "auto",
          viralAngle
        }).catch(() => null);
        if (repairResult?.segments?.length) {
          polishedSegments = diversifyRepeatedVisualSegments(
            applyPolishedNarration(normalizedAnalysis.segments, repairResult, project.voiceSpeed || 1),
            normalizedAnalysis.candidates,
            videoMeta.duration
          );
          normalizedAnalysis.segments = normalizeTimelineToTarget(polishedSegments, project.targetDuration);
          normalizedAnalysis.fullNarration = safeText(
            repairResult.fullNarration,
            normalizedAnalysis.segments.map((segment) => ensureNarrationSentence(segment.narrationLine)).join(" ")
          );
          narrationGroundingReport = await new NarrationGroundingService().inspectAndWrite({
            segments: normalizedAnalysis.segments,
            sceneMetadata,
            evidenceStore: evidenceStoreResult.evidenceStore,
            filmUnderstanding: normalizedAnalysis.filmUnderstanding,
            narrativeIntelligence: normalizedAnalysis.narrativeIntelligence,
            outputPath: narrationGroundingAfterPath
          }).catch(() => narrationGroundingReport);
          narrationGroundingRepaired = true;
        }
      }
      const narrationProvenancePreviewPath = path.join(paths.analysisDir, "narration-provenance-preview.json");
      const narrationProvenancePreview = await new NarrationProvenanceService().inspectAndWrite({
        stage: "preview",
        segments: normalizedAnalysis.segments,
        evidenceStore: evidenceStoreResult.evidenceStore,
        evidenceGraph: evidenceGraphResult.evidenceGraph,
        characterTracker: characterTrackerResult.characterTracker,
        narrationGroundingReport,
        outputPath: narrationProvenancePreviewPath
      }).catch(() => null);
      if (narrationProvenancePreview?.report?.blockedCount > 0) {
        normalizedAnalysis.editNotes.push(
          `Narration Provenance: ${narrationProvenancePreview.report.blockedCount} line(s) need evidence review before final render.`
        );
      }
      const voiceVisualDraftPath = path.join(paths.analysisDir, "voice-visual-draft-check.json");
      const voiceVisualDraft = await new VoiceVisualAlignmentService().inspectAndWrite({
        segments: normalizedAnalysis.segments,
        targetDuration: project.targetDuration,
        voiceSpeed: project.voiceSpeed || 1,
        outputPath: voiceVisualDraftPath
      }).catch(() => null);
      if (voiceVisualDraft?.issues?.length) {
        normalizedAnalysis.editNotes.push(
          ...voiceVisualDraft.issues.slice(0, 8).map((issue) => `Draft sync ${issue.severity}: segment ${issue.segmentIndex + 1} ${issue.code}.`)
        );
      }
      const draftNarrativeReportPaths = await writeNarrativeDebugReports({
        projectStore: this.projectStore,
        outputDir: paths.analysisDir,
        narrativeIntelligence: normalizedAnalysis.narrativeIntelligence,
        groundingReport: narrationGroundingReport,
        segments: normalizedAnalysis.segments
      });
      normalizedAnalysis.editNotes.push(
        `Editable narration generated with story graph + beat continuity for ${Number(project.targetDuration).toFixed(1)}s at ${Number(project.voiceSpeed || 1).toFixed(2)}x voice speed.`
      );
      normalizedAnalysis.artifacts = {
        ...(normalizedAnalysis.artifacts || {}),
        narrationPolishPath,
        narrationContinuityPath: continuityResult ? narrationContinuityPath : "",
        narrationGroundingBeforePath,
        narrationGroundingAfterPath: narrationGroundingRepaired ? narrationGroundingAfterPath : "",
        narrationProvenancePreviewPath,
        voiceVisualDraftPath,
        ...draftNarrativeReportPaths
      };
      await this.projectStore.writeJson(narrationPolishPath, {
        targetDuration: project.targetDuration,
        voiceSpeed: project.voiceSpeed || 1,
        wordTargets,
        polishResult,
        continuityResult
      }).catch(() => {});
    }

    await this.projectStore.writeJson(path.join(paths.analysisDir, "review-plan.json"), normalizedAnalysis);
    const updatedProject = await this.projectStore.updateProject(workspaceRoot, projectId, {
      status: "planned",
      progressPercent: 35,
      statusMessage: "Kế hoạch review đã sẵn sàng. Hãy xuất bản nháp xem trước, tinh chỉnh cảnh/lời thuyết minh rồi render bản cuối.",
      analysis: normalizedAnalysis,
      artifacts: {
        ...(normalizedAnalysis.artifacts || {}),
        thumbnailPath,
        detectedScenePath,
        sceneMetadataPath: sceneMetadataResult.metadataPath,
        metadataTranscriptPath: sceneMetadataResult.transcriptPath,
        evidenceStorePath,
        evidenceReportPath,
        filmMemoryPromptPath,
        filmMemoryRawResponsePath,
        filmMemoryParsedResponsePath,
        filmMemoryCachePath,
        filmUnderstandingPromptPath,
        filmUnderstandingRawResponsePath,
        filmUnderstandingPath,
        characterBiblePath,
        plotTimelinePath,
        sceneRoleMapPath,
        evidenceGraphPath,
        evidenceGraphReportPath,
        narrativeIntelligencePromptPath,
        narrativeIntelligenceRawResponsePath,
        narrativeIntelligencePath,
        characterMentalModelPath,
        relationshipGraphPath,
        characterTrackerPath,
        characterTrackerReportPath,
        worldStateTimelinePath,
        emotionalTimelinePath,
        storyBeatGraphPath,
        geminiPromptPath,
        geminiRawResponsePath,
        geminiParsedResponsePath,
        geminiCachePath
      }
    });

    onProgress?.({
      projectId,
      step: "planned",
      percent: 35,
      message: updatedProject.statusMessage,
      project: updatedProject
    });

    return updatedProject;
  }

  async updateProjectPlan({ workspaceRoot, projectId, analysis }) {
    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    if (project.mode === "highlight_cut") {
      const cleanSegments = (Array.isArray(analysis?.segments) ? analysis.segments : []).map((segment, index) => ({
        ...segment,
        index
      }));
      const activeVariantId = analysis?.activeVariantId || project.analysis?.activeVariantId || analysis?.highlightVariants?.[0]?.id || "";
      const incomingVariants = Array.isArray(analysis?.highlightVariants)
        ? analysis.highlightVariants
        : project.analysis?.highlightVariants || [];
      const cleanVariants = incomingVariants.map((variant) => variant.id === activeVariantId ? {
        ...variant,
        segments: cleanSegments,
        warnings: Array.isArray(analysis?.warnings) ? analysis.warnings : variant.warnings || []
      } : variant);
      const cleanAnalysis = {
        ...(project.analysis || {}),
        ...(analysis || {}),
        activeVariantId,
        highlightVariants: cleanVariants,
        segments: cleanSegments,
        scenes: cleanSegments.map((segment) => ({
          sceneId: segment.id,
          startSec: segment.startSec,
          endSec: segment.endSec,
          duration: segment.duration,
          sourceStartSec: segment.sourceStartSec,
          sourceEndSec: segment.sourceEndSec,
          transcript: segment.caption || segment.voiceoverText || segment.sceneType
        }))
      };
      await this.projectStore.writeJson(path.join(paths.analysisDir, "review-plan.json"), cleanAnalysis);
      return this.projectStore.updateProject(workspaceRoot, projectId, {
        status: "planned",
        progressPercent: 35,
        statusMessage: "Highlight Cut plan updated.",
        analysis: cleanAnalysis
      });
    }
    let cursor = 0;
    const rawSegments = Array.isArray(analysis?.segments) ? analysis.segments : [];
    const cleanSegments = normalizeTimelineToTarget(rawSegments.map((segment, index) => {
      const startSec = safeNumber(segment.startSec, 0);
      const endSec = Math.max(startSec + 0.4, safeNumber(segment.endSec, startSec + safeNumber(segment.renderDuration, 2)));
      const renderDuration = Math.max(0.6, safeNumber(segment.renderDuration, endSec - startSec));
      const updated = {
        ...segment,
        index,
        startSec,
        endSec,
        clipDuration: Math.max(0.4, endSec - startSec),
        renderDuration,
        timelineStart: cursor,
        timelineEnd: cursor + renderDuration,
        narrationLine: safeText(segment.narrationLine, ""),
        subtitleText: safeText(segment.subtitleText, segment.narrationLine || "")
      };
      cursor += renderDuration;
      return updated;
    }), project.targetDuration);

    const cleanAnalysis = {
      title: safeText(analysis?.title, project.analysis?.title || project.title),
      summary: safeText(analysis?.summary, project.analysis?.summary || ""),
      fullNarration: cleanSegments.map((segment) => ensureNarrationSentence(segment.narrationLine)).join(" "),
      editNotes: Array.isArray(analysis?.editNotes) ? analysis.editNotes.map((note) => safeText(note)).filter(Boolean) : project.analysis?.editNotes || [],
      candidates: Array.isArray(analysis?.candidates) ? analysis.candidates : project.analysis?.candidates || [],
      filmMemory: analysis?.filmMemory || project.analysis?.filmMemory || null,
      filmUnderstanding: analysis?.filmUnderstanding || project.analysis?.filmUnderstanding || null,
      narrativeIntelligence: analysis?.narrativeIntelligence || project.analysis?.narrativeIntelligence || null,
      sceneMetadata: analysis?.sceneMetadata || project.analysis?.sceneMetadata || null,
      artifacts: analysis?.artifacts || project.analysis?.artifacts || {},
      segments: cleanSegments
    };

    await this.projectStore.writeJson(path.join(paths.analysisDir, "review-plan.json"), cleanAnalysis);
    return this.projectStore.updateProject(workspaceRoot, projectId, {
      status: "planned",
      progressPercent: 35,
      statusMessage: "Kế hoạch review đã được cập nhật. Sẵn sàng render.",
      analysis: cleanAnalysis
    });
  }

  async reviewSceneScript({ workspaceRoot, projectId, segmentIndex, settings }) {
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    if (!["recap", "satisfying_storytime", "highlight_cut"].includes(project.mode)) {
      throw new Error("AI scene/script review is only available in Movie Recap, Storytime, and Highlight Cut modes.");
    }
    const selectedAiProvider = settings?.aiProvider || settings?.defaultAiProvider || "gemini";
    if (selectedAiProvider === "gemini" && !settings?.geminiApiKey) {
      throw new Error("Gemini API key is required for AI scene/script review. Or switch AI provider to Antigravity CLI in Settings.");
    }

    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const analysis = project.analysis || {};
    const segments = Array.isArray(analysis.segments) ? analysis.segments : [];
    const index = Math.max(0, Math.min(segments.length - 1, safeNumber(segmentIndex, 0)));
    const segment = segments[index];
    if (!segment) {
      throw new Error("No segment found to review.");
    }

    const narrationLine = project.mode === "satisfying_storytime"
      ? safeText(segment.dubbingLine || segment.storyText || segment.text || segment.translatedText || "")
      : project.mode === "highlight_cut"
        ? getHighlightVoiceoverLine(segment)
        : safeText(segment.narrationLine, segment.subtitleText || "");
    const sceneDurationSec = Math.max(
      0.4,
      safeNumber(segment.renderDuration, safeNumber(segment.endSec, 0) - safeNumber(segment.startSec, 0))
    );
    const measuredDraftVoiceSec = safeNumber(segment.fastDraftVoiceSec, 0);
    const measuredDraftTimelineSec = safeNumber(segment.fastDraftTimelineSec, 0);
    const estimatedSpeechSec = Math.max(
      0,
      measuredDraftVoiceSec || safeNumber(segment.rawAudioDuration, estimateSpeechSeconds(narrationLine, project.voiceSpeed || 1))
    );
    const voiceTiming = {
      source: measuredDraftVoiceSec ? "fast_draft_ffprobe" : "estimate",
      estimatedSpeechSec,
      actualSpeechSec: measuredDraftVoiceSec || 0,
      sceneDurationSec: measuredDraftTimelineSec || sceneDurationSec,
      fitRatio: (measuredDraftTimelineSec || sceneDurationSec) > 0 ? estimatedSpeechSec / (measuredDraftTimelineSec || sceneDurationSec) : 0,
      coverageRatio: (measuredDraftTimelineSec || sceneDurationSec) > 0 ? estimatedSpeechSec / (measuredDraftTimelineSec || sceneDurationSec) : 0,
      status: segment.fastDraftVoiceStatus || "",
      warning: segment.fastDraftVoiceWarning || "",
      textHash: segment.fastDraftTextHash || ""
    };
    const selectedSegment = {
      ...segment,
      narrationLine,
      subtitleText: safeText(segment.subtitleText || segment.caption || segment.translatedText, narrationLine),
      sceneDurationSec,
      estimatedSpeechSec,
      voiceTiming,
      fastDraftVoiceStatus: segment.fastDraftVoiceStatus || "",
      fastDraftVoiceWarning: segment.fastDraftVoiceWarning || "",
      fastDraftVoiceSec: segment.fastDraftVoiceSec,
      fastDraftTimelineSec: segment.fastDraftTimelineSec,
      fastDraftFitRatio: segment.fastDraftFitRatio,
      fastDraftTextHash: segment.fastDraftTextHash || ""
    };

    let provider = createAiProvider(settings || {});
    if (provider instanceof LocalFallbackProvider || typeof provider.reviewSceneScript !== "function") {
      throw new Error("AI scene/script review needs Gemini, Antigravity CLI, or Ollama Local. Please choose one in Settings.");
    }
    const reviewPayload = {
      projectMode: project.mode,
      title: safeText(analysis.title, project.title),
      summary: safeText(analysis.summary, ""),
      segment: selectedSegment,
      previousSegment: segments[index - 1] || null,
      nextSegment: segments[index + 1] || null,
      filmMemory: analysis.filmMemory || null,
      filmUnderstanding: analysis.filmUnderstanding || null,
      narrativeIntelligence: analysis.narrativeIntelligence || null,
      voiceSpeed: project.voiceSpeed || 1,
      narrationLanguage: project.targetLanguage || project.language || "vi"
    };
    let rawReview;
    try {
      rawReview = await provider.reviewSceneScript(reviewPayload);
    } catch (error) {
      const providerName = provider.constructor?.name || selectedAiProvider;
      if (providerName === "AntigravityCliProvider" && isAntigravityQuotaError(error)) {
        if (settings?.geminiApiKey) {
          provider = createAiProvider({ ...settings, aiProvider: "gemini" });
          rawReview = await provider.reviewSceneScript(reviewPayload);
        } else {
          throw new Error("Antigravity CLI đã hết quota model hiện tại. Hãy đổi Antigravity model sang nhóm Claude/GPT còn quota, hoặc nhập Gemini API key trong Settings để tool tự fallback.");
        }
      } else {
        throw error;
      }
    }
    const reviewProvider = provider.constructor?.name === "AntigravityCliProvider"
      ? "antigravity_cli"
      : provider.constructor?.name === "GeminiTextProvider"
        ? "gemini"
        : provider.constructor?.name === "OllamaLocalProvider"
          ? "ollama_local"
        : selectedAiProvider;

    const scores = rawReview?.scores || {};
    const normalizedIssues = Array.isArray(rawReview?.issues)
      ? rawReview.issues.map((issue) => ({
        code: safeText(issue?.code, "review_note"),
        severity: safeText(issue?.severity, "warning"),
        message: safeText(issue?.message, "")
      })).filter((issue) => issue.message)
      : [];
    const hardIssues = [];
    let forcedRewriteLine = "";
    let forcedRewriteReason = "";
    let forcedVerdict = ["pass", "warning", "needs_rewrite"].includes(rawReview?.verdict) ? rawReview.verdict : "warning";
    let forcedVoiceFitScore = clampScore(scores.voiceFit, 7);
    if (project.mode === "highlight_cut") {
      const requestedAudioMode = safeText(segment.requestedAudioMode || segment.audio_mode || segment.audioMode || "");
      const hasVoiceover = Boolean(narrationLine);
      const coverageRatio = voiceTiming.coverageRatio;
      if (hasVoiceover && coverageRatio < 0.35) {
        hardIssues.push({
          code: "voice_too_short_silent_gap",
          severity: "error",
          message: `Voice thuyết minh chỉ phủ khoảng ${Math.round(coverageRatio * 100)}% của cảnh ${sceneDurationSec.toFixed(1)}s. Vì Highlight tắt âm gốc khi có voice, phần còn lại rất dễ bị câm.`
        });
        forcedVerdict = "needs_rewrite";
        forcedVoiceFitScore = Math.min(forcedVoiceFitScore, 3);
        forcedRewriteLine = buildHighlightRewriteFallback(segment, narrationLine, sceneDurationSec, project.voiceSpeed || 1);
        forcedRewriteReason = "Voice hiện tại quá ngắn so với timeline nên dễ tạo khoảng câm; câu đề xuất được kéo dài để phủ cảnh tốt hơn.";
      } else if (hasVoiceover && coverageRatio < 0.6) {
        hardIssues.push({
          code: "voice_sparse_silent_risk",
          severity: "warning",
          message: `Voice thuyết minh chỉ phủ khoảng ${Math.round(coverageRatio * 100)}% timeline. Nên viết dài hơn hoặc đổi audio mode để tránh khoảng lặng.`
        });
        if (forcedVerdict === "pass") forcedVerdict = "warning";
        forcedVoiceFitScore = Math.min(forcedVoiceFitScore, 5);
        forcedRewriteLine = buildHighlightRewriteFallback(segment, narrationLine, sceneDurationSec, project.voiceSpeed || 1);
        forcedRewriteReason = "Voice hiện tại hơi thưa so với độ dài cảnh; câu đề xuất giúp giảm khoảng lặng khi âm gốc bị tắt.";
      }
      if (!hasVoiceover && requestedAudioMode && requestedAudioMode !== "original_audio") {
        hardIssues.push({
          code: "missing_voiceover_for_muted_mode",
          severity: "error",
          message: `Đoạn này đặt audio_mode là ${requestedAudioMode} nhưng không có voiceover_text, nên khi render có thể bị câm.`
        });
        forcedVerdict = "needs_rewrite";
        forcedVoiceFitScore = Math.min(forcedVoiceFitScore, 2);
        forcedRewriteLine = buildHighlightRewriteFallback(segment, "", sceneDurationSec, project.voiceSpeed || 1);
        forcedRewriteReason = "Audio mode yêu cầu thuyết minh nhưng đoạn chưa có voiceover_text; câu đề xuất dùng làm voice để tránh đoạn câm.";
      }
    }
    const aiRewriteLine = safeText(rawReview?.rewriteSuggestion?.narrationLine, "");
    const aiRewriteSubtitle = safeText(rawReview?.rewriteSuggestion?.subtitleText, aiRewriteLine);
    const finalRewriteLine = aiRewriteLine || forcedRewriteLine;
    const review = {
      reviewedAt: new Date().toISOString(),
      provider: reviewProvider,
      segmentIndex: index,
      sceneId: segment.sceneId || segment.metadataSummary?.sceneId || `scene_${String(index + 1).padStart(2, "0")}`,
      verdict: forcedVerdict,
      summary: safeText(rawReview?.summary, "AI review completed."),
      scores: {
        sceneMatch: clampScore(scores.sceneMatch, 7),
        storyCoherence: clampScore(scores.storyCoherence, 7),
        voiceFit: forcedVoiceFitScore,
        evidenceSupport: clampScore(scores.evidenceSupport, 7)
      },
      issues: [...hardIssues, ...normalizedIssues],
      rewriteSuggestion: {
        shouldApply: Boolean(rawReview?.rewriteSuggestion?.shouldApply || forcedRewriteLine),
        narrationLine: finalRewriteLine,
        subtitleText: aiRewriteSubtitle || finalRewriteLine,
        reason: safeText(rawReview?.rewriteSuggestion?.reason, forcedRewriteReason)
      },
      voiceTiming: {
        ...voiceTiming,
        estimatedSpeechSec: Number(estimatedSpeechSec.toFixed(3)),
        actualSpeechSec: Number(safeNumber(voiceTiming.actualSpeechSec, 0).toFixed(3)),
        sceneDurationSec: Number(safeNumber(voiceTiming.sceneDurationSec, sceneDurationSec).toFixed(3)),
        fitRatio: Number(voiceTiming.fitRatio.toFixed(3)),
        coverageRatio: Number(safeNumber(voiceTiming.coverageRatio, voiceTiming.fitRatio).toFixed(3))
      }
    };

    const updatedSegments = segments.map((item, itemIndex) => (
      itemIndex === index ? { ...item, aiSceneReview: review } : item
    ));
    const activeVariantId = analysis.activeVariantId || "";
    const updatedHighlightVariants = project.mode === "highlight_cut" && Array.isArray(analysis.highlightVariants)
      ? analysis.highlightVariants.map((variant) => variant.id === activeVariantId ? {
        ...variant,
        segments: updatedSegments
      } : variant)
      : analysis.highlightVariants;
    const reviewPath = path.join(paths.analysisDir, `scene-script-review-${String(index + 1).padStart(2, "0")}.json`);
    const cleanAnalysis = {
      ...analysis,
      highlightVariants: updatedHighlightVariants,
      artifacts: {
        ...(analysis.artifacts || {}),
        lastSceneScriptReviewPath: reviewPath
      },
      segments: updatedSegments
    };

    await this.projectStore.writeJson(reviewPath, review);
    await this.projectStore.writeJson(path.join(paths.analysisDir, "review-plan.json"), cleanAnalysis);
    return this.projectStore.updateProject(workspaceRoot, projectId, {
      status: "planned",
      progressPercent: Math.max(35, safeNumber(project.progressPercent, 35)),
      statusMessage: `AI đã đánh giá xong cảnh ${index + 1}.`,
      analysis: cleanAnalysis
    });
  }

  async rewriteFailedSceneScripts({ workspaceRoot, projectId, settings }) {
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    if (!["recap", "satisfying_storytime", "highlight_cut"].includes(project.mode)) {
      throw new Error("AI failed-scene rewrite is only available in Movie Recap, Storytime, and Highlight Cut modes.");
    }
    const selectedAiProvider = settings?.aiProvider || settings?.defaultAiProvider || "gemini";
    if (selectedAiProvider === "gemini" && !settings?.geminiApiKey) {
      throw new Error("Gemini API key is required for AI failed-scene rewrite. Or switch AI provider to Antigravity CLI in Settings.");
    }

    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const analysis = project.analysis || {};
    const segments = Array.isArray(analysis.segments) ? analysis.segments : [];
    if (!segments.length) {
      throw new Error("No segments found to rewrite.");
    }

    const isFailedReview = (segment) => {
      if (segment.fastDraftVoiceStatus === "stale") return true;
      if (["too_short", "too_long"].includes(segment.fastDraftVoiceStatus)) return true;
      const fastDraftFitRatio = safeNumber(segment.fastDraftFitRatio, 0);
      if (fastDraftFitRatio > 0 && (fastDraftFitRatio < 0.82 || fastDraftFitRatio > 1.08)) return true;
      const review = segment.aiSceneReview || null;
      if (!review) return false;
      if (review.verdict === "needs_rewrite") return true;
      const fitRatio = safeNumber(review.voiceTiming?.fitRatio, 0);
      if (fitRatio > 0 && (fitRatio < 0.82 || fitRatio > 1.08)) return true;
      const issues = Array.isArray(review.issues) ? review.issues : [];
      return issues.some((issue) => /voice|timing|silent|sparse|too_short|too_long|mismatch/i.test(`${issue.code || ""} ${issue.message || ""}`));
    };

    const getNarrationLine = (segment) => project.mode === "satisfying_storytime"
      ? safeText(segment.dubbingLine || segment.storyText || segment.text || segment.translatedText || "")
      : project.mode === "highlight_cut"
        ? getHighlightVoiceoverLine(segment)
        : safeText(segment.narrationLine, segment.subtitleText || "");

    const compactSegments = segments.map((segment, index) => {
      const startSec = safeNumber(segment.startSec, 0);
      const endSec = safeNumber(segment.endSec, startSec + safeNumber(segment.durationSec || segment.duration, 1));
      const narrationLine = getNarrationLine(segment);
      const wordCount = countSpokenWords(narrationLine);
      const measuredVoiceSec = safeNumber(segment.fastDraftVoiceSec, 0);
      const profileWordsPerSecond = safeNumber(segment.fastDraftVoiceProfileWordsPerSecond, 0);
      const measuredWordsPerSecond = profileWordsPerSecond || (measuredVoiceSec > 0.3 && wordCount > 0 ? wordCount / measuredVoiceSec : DEFAULT_WORDS_PER_SECOND);
      const durationSec = Math.max(0.3, endSec - startSec);
      const targetWordRange = [
        Math.max(2, Math.ceil(durationSec * 0.85 * measuredWordsPerSecond)),
        Math.max(3, Math.floor(durationSec * 1.0 * measuredWordsPerSecond))
      ];
      return {
        index,
        id: segment.id || segment.sceneId || `segment_${index + 1}`,
        startSec,
        endSec,
        durationSec,
        sourceStartSec: segment.sourceStartSec,
        sourceEndSec: segment.sourceEndSec,
        audioMode: segment.audioMode || segment.audio_mode || "",
        narrationLine,
        previousNarrationLine: index > 0 ? getNarrationLine(segments[index - 1]) : "",
        nextNarrationLine: index < segments.length - 1 ? getNarrationLine(segments[index + 1]) : "",
        wordCount,
        targetWordRange,
        caption: safeText(segment.caption || segment.subtitleText || segment.translatedText || ""),
        review: segment.aiSceneReview ? {
          verdict: segment.aiSceneReview.verdict,
          summary: segment.aiSceneReview.summary,
          issues: segment.aiSceneReview.issues || [],
          voiceTiming: segment.aiSceneReview.voiceTiming || {}
        } : null,
        fastDraftVoiceStatus: segment.fastDraftVoiceStatus || "",
        fastDraftVoiceWarning: segment.fastDraftVoiceWarning || "",
        fastDraftVoiceSec: segment.fastDraftVoiceSec,
        fastDraftTimelineSec: segment.fastDraftTimelineSec,
        fastDraftFitRatio: segment.fastDraftFitRatio,
        fastDraftTextHash: segment.fastDraftTextHash || "",
        fastDraftVoiceProfileKey: segment.fastDraftVoiceProfileKey || "",
        fastDraftVoiceProfileWordsPerSecond: segment.fastDraftVoiceProfileWordsPerSecond || 0,
        fastDraftVoiceProfileSampleCount: segment.fastDraftVoiceProfileSampleCount || 0
      };
    });
    const failedSegments = compactSegments.filter((segment) => isFailedReview(segments[segment.index]));
    if (!failedSegments.length) {
      throw new Error("Không có cảnh fail/cảnh báo timing để AI viết lại. Hãy bấm AI đánh giá toàn bộ cảnh trước.");
    }

    let provider = createAiProvider(settings || {});
    if (provider instanceof LocalFallbackProvider || typeof provider.rewriteFailedSceneScripts !== "function") {
      throw new Error("AI failed-scene rewrite needs Gemini, Antigravity CLI, or Ollama Local. Please choose one in Settings.");
    }

    const rewritePayload = {
      projectMode: project.mode,
      title: safeText(analysis.title, project.title),
      summary: safeText(analysis.summary, ""),
      segments: compactSegments,
      failedSegments,
      voiceSpeed: project.voiceSpeed || 1,
      narrationLanguage: project.targetLanguage || project.language || "vi"
    };
    let parsed;
    try {
      parsed = await provider.rewriteFailedSceneScripts(rewritePayload);
    } catch (error) {
      const providerName = provider.constructor?.name || selectedAiProvider;
      if (providerName === "AntigravityCliProvider" && isAntigravityQuotaError(error)) {
        if (settings?.geminiApiKey) {
          provider = createAiProvider({ ...settings, aiProvider: "gemini" });
          parsed = await provider.rewriteFailedSceneScripts(rewritePayload);
        } else {
          throw new Error("Antigravity CLI đã hết quota model hiện tại. Hãy đổi Antigravity model sang nhóm Claude/GPT còn quota, hoặc nhập Gemini API key trong Settings để tool tự fallback.");
        }
      } else {
        throw error;
      }
    }
    const rewrites = Array.isArray(parsed?.rewrites) ? parsed.rewrites : Array.isArray(parsed) ? parsed : [];
    const rewriteByIndex = new Map(rewrites.map((item) => [safeNumber(item.index, -1), item]));
    let rewriteCount = 0;
    const updatedSegments = segments.map((segment, index) => {
      const rewrite = rewriteByIndex.get(index);
      const narrationLine = safeText(rewrite?.narrationLine || rewrite?.voiceover_text || rewrite?.voiceoverText || "", "");
      if (!narrationLine) return segment;
      rewriteCount += 1;
      const previousReview = segment.aiSceneReview || {};
      return {
        ...segment,
        aiSceneReview: {
          ...previousReview,
          verdict: "needs_rewrite",
          summary: "AI đã viết lại cảnh lỗi theo batch. Kiểm tra rồi bấm áp dụng nếu phù hợp.",
          batchRewriteAt: new Date().toISOString(),
          rewriteSuggestion: {
            shouldApply: true,
            narrationLine,
            subtitleText: safeText(rewrite?.subtitleText || rewrite?.caption || "", narrationLine),
            reason: safeText(rewrite?.reason, "Viết lại theo danh sách cảnh fail để khớp timeline và mạch kể tốt hơn.")
          }
        }
      };
    });
    if (!rewriteCount) {
      throw new Error("AI không trả về câu viết lại hợp lệ cho các cảnh fail.");
    }

    const activeVariantId = analysis.activeVariantId || "";
    const updatedHighlightVariants = project.mode === "highlight_cut" && Array.isArray(analysis.highlightVariants)
      ? analysis.highlightVariants.map((variant) => variant.id === activeVariantId ? {
        ...variant,
        segments: updatedSegments
      } : variant)
      : analysis.highlightVariants;
    const cleanAnalysis = {
      ...analysis,
      highlightVariants: updatedHighlightVariants,
      segments: updatedSegments,
      artifacts: {
        ...(analysis.artifacts || {}),
        failedSceneBatchRewritePath: path.join(paths.analysisDir, "failed-scene-batch-rewrite.json")
      }
    };

    await this.projectStore.writeJson(path.join(paths.analysisDir, "failed-scene-batch-rewrite.json"), {
      generatedAt: new Date().toISOString(),
      provider: provider.constructor?.name || selectedAiProvider,
      failedCount: failedSegments.length,
      rewriteCount,
      failedSegments,
      rewrites
    });
    await this.projectStore.writeJson(path.join(paths.analysisDir, "review-plan.json"), cleanAnalysis);
    return this.projectStore.updateProject(workspaceRoot, projectId, {
      status: "planned",
      progressPercent: Math.max(35, safeNumber(project.progressPercent, 35)),
      statusMessage: `AI đã viết lại ${rewriteCount}/${failedSegments.length} cảnh lỗi.`,
      analysis: cleanAnalysis
    });
  }

  async previewProject({ workspaceRoot, projectId, settings, onProgress }) {
    if (this.runningJobs.has(projectId)) {
      throw new Error("This project is already rendering or previewing.");
    }

    this.runningJobs.add(projectId);
    const ffmpeg = new FfmpegService(settings);

    const emit = async (step, percent, message) => {
      onProgress?.({
        projectId,
        step,
        percent,
        message
      });
      await this.projectStore.updateProject(workspaceRoot, projectId, {
        status: step,
        progressPercent: percent,
        statusMessage: message
      });
    };

    try {
      const project = await this.projectStore.getProject(workspaceRoot, projectId);
      const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
      const segments = Array.isArray(project.analysis?.segments) ? project.analysis.segments : [];

      if (!segments.length) {
        throw new Error("Generate a review plan before creating a preview.");
      }

      await emit("previewing", 10, "�ang chu?n b? timeline xem tru?c");
      const videoMeta = await ffmpeg.probeVideo(project.sourceVideoPath);
      if (!videoMeta.duration) {
        throw new Error("Could not read the source video duration.");
      }

      const genreMode = project.genreMode || "thriller";
      const shouldUseSourceAudio = Boolean(videoMeta.hasAudio) && !project.muteSourceAudio;
      const previewSegmentPaths = [];
      const previewSegmentDurations = [];
      const subtitleEntries = [];
      let elapsedSeconds = 0;

      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        const startSec = Math.max(0, Number(segment.startSec || 0));
        const endSec = Math.min(videoMeta.duration, Math.max(startSec + 0.4, Number(segment.endSec || startSec + 1.2)));
        const clipDuration = Math.max(0.4, endSec - startSec);
        const renderDuration = Math.max(0.6, Number(segment.renderDuration || segment.clipDuration || clipDuration));
        const segmentLabel = `preview-segment-${String(index + 1).padStart(2, "0")}`;
        const previewSegmentPath = path.join(paths.clipsDir, `${segmentLabel}.mp4`);

        await emit("previewing", 14 + index * Math.max(1, Math.floor(52 / Math.max(1, segments.length))), `�ang render c?nh xem tru?c ${index + 1}/${segments.length}`);
        await ffmpeg.extractVerticalClip({
          sourcePath: project.sourceVideoPath,
          outputPath: previewSegmentPath,
          startSec,
          clipDuration,
          targetDuration: renderDuration,
          includeSourceAudio: shouldUseSourceAudio,
          role: segment.role,
          genreMode,
          sourceAudioVolume: project.rewriteVoiceover
            ? (project.sourceAudioVolumePercentage / 100)
            : getSourceAudioVolume(segment.role, genreMode),
          screenText: "",
          speedFactor: Math.min(1.15, getSpeedFactor(segment.role, genreMode)),
          visual_energy: segment.visual_energy,
          audio_vibe: segment.audio_vibe,
          font_style: segment.font_style,
          reframe: segment.reframe,
          includeSilentAudio: !shouldUseSourceAudio
        });

        previewSegmentPaths.push(previewSegmentPath);
        previewSegmentDurations.push(renderDuration);
        appendWordSubtitleEntries(subtitleEntries, {
          segment: {
            ...segment,
            index,
            startSec,
            endSec,
            clipDuration,
            renderDuration
          },
          elapsedSeconds,
          durationSec: renderDuration
        });
        elapsedSeconds += renderDuration;
      }

      const previewRawPath = path.join(paths.outputDir, "review-preview-raw.mp4");
      const previewSubtitlePath = path.join(paths.outputDir, "review-preview.ass");
      const previewVideoPath = path.join(paths.outputDir, "review-preview.mp4");

      await emit("previewing", 72, "�ang gh�p c�c c?nh xem tru?c");
      await ffmpeg.concatSegmentsWithTransitions(previewSegmentPaths, previewSegmentDurations, previewRawPath, 0);

      if (subtitleEntries.length > 0) {
        await emit("previewing", 84, "Đang tạo phụ đề xem trước riêng");
        const assText = buildAssFileContent(subtitleEntries, settings.verticalWidth || 1080, settings.verticalHeight || 1920);
        await this.projectStore.writeText(previewSubtitlePath, assText);
      }

      const updated = await this.projectStore.updateProject(workspaceRoot, projectId, {
        status: "previewed",
        progressPercent: 55,
        statusMessage: "Timeline preview is ready. Review scenes and subtitles before rendering final voice.",
        artifacts: {
          previewVideoPath: previewRawPath,
          previewRawPath,
          previewSubtitlePath: subtitleEntries.length > 0 ? previewSubtitlePath : ""
        }
      });

      onProgress?.({
        projectId,
        step: "previewed",
        percent: 55,
        message: "Timeline preview is ready.",
        project: updated
      });

      return updated;
    } catch (error) {
      await this.projectStore.updateProject(workspaceRoot, projectId, {
        status: "error",
        progressPercent: 0,
        statusMessage: error.message
      }).catch(() => {});
      onProgress?.({
        projectId,
        step: "error",
        percent: 0,
        message: error.message
      });
      throw error;
    } finally {
      this.runningJobs.delete(projectId);
    }
  }

  async renderProject({ workspaceRoot, projectId, settings, onProgress }) {
    if (this.runningJobs.has(projectId)) {
      throw new Error("This project is already rendering.");
    }

    this.runningJobs.add(projectId);
    const ffmpeg = new FfmpegService(settings);

    const emit = async (step, percent, message) => {
      onProgress?.({
        projectId,
        step,
        percent,
        message
      });
      await this.projectStore.updateProject(workspaceRoot, projectId, {
        status: step,
        progressPercent: percent,
        statusMessage: message
      });
    };

    try {
      const project = await this.projectStore.getProject(workspaceRoot, projectId);
      const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
      const voiceProvider = project.voiceProvider || settings.defaultVoiceProvider || "edge_neural";
      await assertEnoughRenderDiskSpace(paths, project.targetDuration);

      await emit("preparing", 5, "�ang ki?m tra video ngu?n");
      const videoMeta = await ffmpeg.probeVideo(project.sourceVideoPath);
      if (!videoMeta.duration) {
        throw new Error("Could not read the source video duration.");
      }

      if (project.targetDuration > videoMeta.duration) {
        throw new Error(`Target duration (${project.targetDuration}s) must be shorter than or equal to the source video (${videoMeta.duration.toFixed(1)}s).`);
      }

      const thumbnailPath = path.join(paths.assetsDir, "source-thumbnail.jpg");
      await ffmpeg.extractThumbnail(project.sourceVideoPath, thumbnailPath).catch(() => {});

      const genreMode = project.genreMode || "thriller";
      const voicePreset = getGenreVoicePreset(genreMode);
      const perspective = project.perspective || "third_person";
      const viralAngle = selectViralAngle(project, genreMode);
      await emit("analyzing", 12, "�ang ph�t hi?n c?nh c?c b?");
      const sceneDetector = new SceneDetectionService(settings);
      const detectedScenePath = path.join(paths.analysisDir, "detected-scenes.json");
      const detectedScenesResult = await sceneDetector.detectScenes({
        videoPath: project.sourceVideoPath,
        sourceDuration: videoMeta.duration
      }).catch((error) => ({
        provider: "fallback_even_split",
        error: error.message,
        scenes: buildFallbackCandidates(videoMeta.duration, Math.min(videoMeta.duration, Math.max(project.targetDuration, 30))).map((scene, index) => ({
          sceneId: `scene_${String(index + 1).padStart(4, "0")}`,
          startSec: scene.startSec,
          endSec: scene.endSec,
          duration: scene.endSec - scene.startSec
        }))
      }));
      const lockedScenes = summarizeLockedScenes(detectedScenesResult.scenes);
      await this.projectStore.writeJson(detectedScenePath, {
        provider: detectedScenesResult.provider,
        error: detectedScenesResult.error || "",
        scenes: lockedScenes
      }).catch(() => {});
      const geminiPromptPath = path.join(paths.analysisDir, "candidate-mining-prompt.txt");
      const geminiRawResponsePath = path.join(paths.analysisDir, "candidate-mining-response.txt");
      const geminiParsedResponsePath = path.join(paths.analysisDir, "candidate-mining-response.json");
      const filmMemoryPromptPath = path.join(paths.analysisDir, "film-memory-prompt.txt");
      const filmMemoryRawResponsePath = path.join(paths.analysisDir, "film-memory-response.txt");
      const filmMemoryParsedResponsePath = path.join(paths.analysisDir, "film-memory.json");
      const filmMemoryCachePath = path.join(paths.analysisDir, "film-memory-cache.json");

      const geminiCachePath = path.join(paths.analysisDir, "candidate-scene-cache.json");
      const transitionDuration = 0.24;
      let analysis = project.analysis;
      let normalizedSegments = Array.isArray(analysis?.segments) && analysis.segments.length
        ? analysis.segments.map((segment, index) => ({
            ...segment,
            index,
            startSec: clamp(safeNumber(segment.startSec, 0), 0, Math.max(0, videoMeta.duration - 0.4)),
            endSec: clamp(safeNumber(segment.endSec, safeNumber(segment.startSec, 0) + 2), 0.4, videoMeta.duration),
            clipDuration: Math.max(0.4, safeNumber(segment.endSec, 0) - safeNumber(segment.startSec, 0)),
            renderDuration: Math.max(0.6, safeNumber(segment.renderDuration, segment.timelineEnd && segment.timelineStart ? segment.timelineEnd - segment.timelineStart : segment.clipDuration || 2)),
            timelineStart: safeNumber(segment.timelineStart, 0),
            timelineEnd: safeNumber(segment.timelineEnd, 0),
            energy: segment.role === "hook" || segment.role === "escalation" ? "panic" : segment.role === "setup" ? "setup" : "tense"
          }))
        : null;
      if (normalizedSegments) {
        normalizedSegments = lockCandidateTimestampsToScenes(normalizedSegments, lockedScenes).map((segment, index) => ({
          ...segment,
          index,
          startSec: clamp(safeNumber(segment.startSec, 0), 0, Math.max(0, videoMeta.duration - 0.4)),
          endSec: clamp(safeNumber(segment.endSec, safeNumber(segment.startSec, 0) + 2), 0.4, videoMeta.duration),
          clipDuration: Math.max(0.4, safeNumber(segment.endSec, 0) - safeNumber(segment.startSec, 0)),
          requestedDurationSec: Math.max(0.4, safeNumber(segment.endSec, 0) - safeNumber(segment.startSec, 0))
        }));
      }

      if (normalizedSegments) {
        const existingMemory = normalizeFilmMemory(analysis?.filmMemory);
        if (!existingMemory.theBizarreElement && !existingMemory.theInjustice && !existingMemory.curiosityGap) {
          await emit("analyzing", 15, "�ang l�m m?i b? nh? phim TikTok cho b?n d?ng d� duy?t");
          const gemini = new GeminiService(settings.geminiApiKey, settings.geminiModel);
          const filmMemoryCacheKey = {
            sourceVideoPath: project.sourceVideoPath,
            targetDuration: Number(project.targetDuration),
            genreMode,
            spoilerMode: project.spoilerMode || "",
            narrationLanguage: project.narrationLanguage || "auto",
            viralAngle,
            geminiModel: settings.geminiModel || "",
            sceneProvider: detectedScenesResult.provider,
            sceneCount: lockedScenes.length,
            promptVersion: "film-memory-v2"
          };
          let refreshedMemory = await readGeminiAnalysisCache(filmMemoryCachePath, filmMemoryCacheKey);
          if (!refreshedMemory) {
            refreshedMemory = await gemini.understandFilm({
              videoPath: project.sourceVideoPath,
              targetDuration: project.targetDuration,
              genreMode,
              spoilerMode: project.spoilerMode,
              narrationLanguage: project.narrationLanguage || "auto",
              viralAngle,
              lockedScenes,
              promptLogPath: filmMemoryPromptPath,
              rawResponsePath: filmMemoryRawResponsePath,
              parsedResponsePath: filmMemoryParsedResponsePath
            });
            await writeGeminiAnalysisCache(filmMemoryCachePath, filmMemoryCacheKey, refreshedMemory).catch(() => {});
          }
          analysis = {
            ...analysis,
            filmMemory: applyViralAngleToFilmMemory(refreshedMemory, viralAngle),
            editNotes: [
              ...(Array.isArray(analysis?.editNotes) ? analysis.editNotes : []),
              `Viral angle: ${viralAngle.label}.`
            ]
          };
        }
        await emit("planning", 18, "�ang d�ng k? ho?ch c?nh d� duy?t");
      } else {
        await emit("analyzing", 15, "�ang hi?u c?t truy?n v� kho?nh kh?c viral");
        const gemini = new GeminiService(settings.geminiApiKey, settings.geminiModel);
        const filmMemoryCacheKey = {
          sourceVideoPath: project.sourceVideoPath,
          targetDuration: Number(project.targetDuration),
          genreMode,
          spoilerMode: project.spoilerMode || "",
          narrationLanguage: project.narrationLanguage || "auto",
          viralAngle,
          geminiModel: settings.geminiModel || "",
          sceneProvider: detectedScenesResult.provider,
          sceneCount: lockedScenes.length,
          promptVersion: "film-memory-v2"
        };
        let filmMemory = await readGeminiAnalysisCache(filmMemoryCachePath, filmMemoryCacheKey);
        if (filmMemory) {
          filmMemory = applyViralAngleToFilmMemory(filmMemory, viralAngle);
          await fs.writeFile(filmMemoryParsedResponsePath, JSON.stringify(filmMemory, null, 2), "utf8").catch(() => {});
        } else {
          filmMemory = applyViralAngleToFilmMemory(await gemini.understandFilm({
            videoPath: project.sourceVideoPath,
            targetDuration: project.targetDuration,
            genreMode,
            spoilerMode: project.spoilerMode,
            narrationLanguage: project.narrationLanguage || "auto",
            viralAngle,
            lockedScenes,
            promptLogPath: filmMemoryPromptPath,
            rawResponsePath: filmMemoryRawResponsePath,
            parsedResponsePath: filmMemoryParsedResponsePath
          }), viralAngle);
          await writeGeminiAnalysisCache(filmMemoryCachePath, filmMemoryCacheKey, filmMemory).catch(() => {});
        }

        await emit("analyzing", 20, "�ang ch?n c�c c?nh gi� tr? cao");
        const geminiCacheKey = {
          sourceVideoPath: project.sourceVideoPath,
          targetDuration: Number(project.targetDuration),
          genreMode,
          spoilerMode: project.spoilerMode || "",
          narrationLanguage: project.narrationLanguage || "auto",
          viralAngle,
          geminiModel: settings.geminiModel || "",
          sceneProvider: detectedScenesResult.provider,
          sceneCount: lockedScenes.length,
          promptVersion: "candidate-mining-film-memory-v5-preserve-subscene-timestamps"
        };
        analysis = await readGeminiAnalysisCache(geminiCachePath, geminiCacheKey);

        if (analysis) {
          await emit("analyzing", 18, "�ang d�ng nh�m c?nh ?ng vi�n d� luu");
          await fs.writeFile(geminiParsedResponsePath, JSON.stringify(analysis, null, 2), "utf8").catch(() => {});
        } else {
          analysis = await gemini.mineCandidateScenes({
            videoPath: project.sourceVideoPath,
            targetDuration: project.targetDuration,
            genreMode,
            spoilerMode: project.spoilerMode,
            narrationLanguage: project.narrationLanguage || "auto",
            lockedScenes,
            filmMemory,
            viralAngle,
            promptLogPath: geminiPromptPath,
            rawResponsePath: geminiRawResponsePath,
            parsedResponsePath: geminiParsedResponsePath
          });
          await writeGeminiAnalysisCache(geminiCachePath, geminiCacheKey, analysis).catch(() => {});
        }

        let candidates = normalizeCandidateScenes(
          refineCandidatesToMicroMoments(
            enrichCandidatesWithFilmMemory(lockCandidateTimestampsToScenes(analysis.candidates, lockedScenes), filmMemory),
            videoMeta.duration
          ),
          videoMeta.duration,
          project.spoilerMode
        );
        if (candidates.length < 3) {
          candidates = buildFallbackCandidates(videoMeta.duration, project.targetDuration);
        }
        const candidateNarrativeIntelligence = normalizeNarrativeIntelligence(
          analysis?.narrativeIntelligence,
          analysis?.filmUnderstanding,
          filmMemory,
          { scenes: lockedScenes }
        );
        const visualPacing = smoothVisualTimeline(
          buildVisualTimeline(candidates, project.targetDuration, videoMeta.duration, filmMemory, candidateNarrativeIntelligence),
          project.targetDuration,
          genreMode,
          videoMeta.duration
        );
        normalizedSegments = visualPacing.segments;
        analysis = {
          ...analysis,
          candidates,
          filmMemory,
          narrativeIntelligence: candidateNarrativeIntelligence,
          visualPacing,
          segments: normalizedSegments,
          editNotes: [
            filmMemory.logline ? `Film memory: ${filmMemory.logline}` : "",
            `Viral angle: ${viralAngle.label}.`,
            `Visual-first timeline locked to ${Number(project.targetDuration).toFixed(1)}s from ${candidates.length} candidate scenes.`,
            visualPacing.originalCount !== visualPacing.visualBlockCount
              ? `Visual pacing: merged ${visualPacing.originalCount} planned beats into ${visualPacing.visualBlockCount} smoother blocks (${genreMode} min ${visualPacing.config.minBlock.toFixed(1)}s).`
              : `Visual pacing: ${visualPacing.visualBlockCount} blocks, ${genreMode} min ${visualPacing.config.minBlock.toFixed(1)}s.`
          ].filter(Boolean)
        };
      }

      const renderVisualPacing = smoothVisualTimeline(normalizedSegments, project.targetDuration, genreMode, videoMeta.duration);
      normalizedSegments = renderVisualPacing.segments;
      const renderSceneMetadata = {
        scenes: normalizedSegments.map((segment) => ({
          ...(segment.metadataSummary || {}),
          sceneId: segment.sceneId || segment.metadataSummary?.sceneId || segment.metadataSummary?.scene_id || `segment_${segment.index + 1}`,
          audioTranscript: segment.metadataSummary?.audioTranscript || "",
          localVisualTags: segment.metadataSummary?.localVisualTags || [],
          motionIntensity: segment.metadataSummary?.motionIntensity || "",
          audioEnergy: segment.metadataSummary?.audioEnergy || "",
          lightChange: segment.metadataSummary?.lightChange || ""
        }))
      };
      const renderEvidenceStorePath = path.join(paths.analysisDir, "evidence-store.json");
      const renderEvidenceReportPath = path.join(paths.analysisDir, "evidence-report.json");
      let renderEvidenceStore = analysis?.evidenceStore || null;
      let renderEvidenceStoreData = analysis?.evidenceStore?.scenes ? analysis.evidenceStore : null;
      try {
        if (!renderEvidenceStore?.report) {
          const evidenceResult = await new EvidenceStoreService(settings).buildAndWrite({
            sceneMetadata: analysis?.sceneMetadata?.scenes ? analysis.sceneMetadata : renderSceneMetadata,
            project,
            videoPath: project.sourceVideoPath,
            outputPath: renderEvidenceStorePath
          });
          renderEvidenceStoreData = evidenceResult.evidenceStore;
          renderEvidenceStore = {
            schemaVersion: evidenceResult.evidenceStore.schemaVersion,
            evidenceStorePath: renderEvidenceStorePath,
            evidenceReportPath: renderEvidenceReportPath,
            report: evidenceResult.evidenceStore.report
          };
          await this.projectStore.writeJson(renderEvidenceReportPath, evidenceResult.evidenceStore.report).catch(() => {});
        } else if (!renderEvidenceStoreData) {
          renderEvidenceStoreData = JSON.parse(await fs.readFile(renderEvidenceStore.evidenceStorePath || renderEvidenceStorePath, "utf8"));
        }
      } catch (error) {
        renderEvidenceStore = {
          evidenceStorePath: renderEvidenceStorePath,
          evidenceReportPath: renderEvidenceReportPath,
          report: {
            failed: true,
            error: error.message
          }
        };
        renderEvidenceStoreData = null;
      }
      const filmUnderstanding = normalizeFilmUnderstanding(analysis?.filmUnderstanding, analysis?.filmMemory, renderSceneMetadata);
      const renderEvidenceGraphPath = path.join(paths.analysisDir, "evidence-graph.json");
      const renderEvidenceGraphReportPath = path.join(paths.analysisDir, "evidence-graph-report.json");
      let renderEvidenceGraph = analysis?.evidenceGraph || null;
      let renderEvidenceGraphData = analysis?.evidenceGraph?.nodes ? analysis.evidenceGraph : null;
      try {
        if (!renderEvidenceGraphData) {
          renderEvidenceGraphData = JSON.parse(await fs.readFile(renderEvidenceGraph?.evidenceGraphPath || renderEvidenceGraphPath, "utf8"));
        }
      } catch (_readGraphError) {
        try {
          const graphResult = await new EvidenceGraphService().buildAndWrite({
            evidenceStore: renderEvidenceStoreData,
            filmUnderstanding,
            outputPath: renderEvidenceGraphPath
          });
          renderEvidenceGraphData = graphResult.evidenceGraph;
          renderEvidenceGraph = {
            schemaVersion: graphResult.evidenceGraph.schemaVersion,
            evidenceGraphPath: renderEvidenceGraphPath,
            evidenceGraphReportPath: renderEvidenceGraphReportPath,
            report: graphResult.evidenceGraph.report
          };
          await this.projectStore.writeJson(renderEvidenceGraphReportPath, graphResult.evidenceGraph.report).catch(() => {});
        } catch (error) {
          renderEvidenceGraph = {
            evidenceGraphPath: renderEvidenceGraphPath,
            evidenceGraphReportPath: renderEvidenceGraphReportPath,
            report: {
              failed: true,
              error: error.message
            }
          };
          renderEvidenceGraphData = null;
        }
      }
      const narrativeIntelligence = normalizeNarrativeIntelligence(analysis?.narrativeIntelligence, filmUnderstanding, analysis?.filmMemory, renderSceneMetadata);
      const renderCharacterTrackerPath = path.join(paths.analysisDir, "character-tracker.json");
      const renderCharacterTrackerReportPath = path.join(paths.analysisDir, "character-tracker-report.json");
      let renderCharacterTracker = analysis?.characterTracker || null;
      let renderCharacterTrackerData = analysis?.characterTracker?.characters ? analysis.characterTracker : null;
      try {
        if (!renderCharacterTrackerData) {
          renderCharacterTrackerData = JSON.parse(await fs.readFile(renderCharacterTracker?.characterTrackerPath || renderCharacterTrackerPath, "utf8"));
        }
      } catch (_readCharacterTrackerError) {
        try {
          const trackerResult = await new CharacterTrackingService().buildAndWrite({
            evidenceStore: renderEvidenceStoreData,
            filmUnderstanding,
            narrativeIntelligence,
            outputPath: renderCharacterTrackerPath
          });
          renderCharacterTrackerData = trackerResult.characterTracker;
          renderCharacterTracker = {
            schemaVersion: trackerResult.characterTracker.schemaVersion,
            characterTrackerPath: renderCharacterTrackerPath,
            characterTrackerReportPath: renderCharacterTrackerReportPath,
            report: trackerResult.characterTracker.report
          };
          await this.projectStore.writeJson(renderCharacterTrackerReportPath, trackerResult.characterTracker.report).catch(() => {});
        } catch (error) {
          renderCharacterTracker = {
            characterTrackerPath: renderCharacterTrackerPath,
            characterTrackerReportPath: renderCharacterTrackerReportPath,
            report: {
              failed: true,
              error: error.message
            }
          };
          renderCharacterTrackerData = null;
        }
      }
      const normalizedAnalysis = {
        title: safeText(analysis?.title, project.title),
        summary: safeText(analysis?.summary, "AI selected the strongest visual moments for a short recap draft."),
        fullNarration: safeText(analysis?.fullNarration, normalizedSegments.map((segment) => ensureNarrationSentence(segment.narrationLine)).join(" ")),
        editNotes: [
          ...(Array.isArray(analysis?.editNotes) ? analysis.editNotes.map((note) => safeText(note)).filter(Boolean) : []),
          renderVisualPacing.originalCount !== renderVisualPacing.visualBlockCount
            ? `Render visual pacing: merged ${renderVisualPacing.originalCount} beats into ${renderVisualPacing.visualBlockCount} smoother blocks.`
            : "",
          ...buildQualityNotes(normalizedSegments)
        ].filter(Boolean),
        candidates: Array.isArray(analysis?.candidates) ? analysis.candidates : [],
        filmMemory: applyViralAngleToFilmMemory(analysis?.filmMemory, viralAngle),
        evidenceStore: renderEvidenceStore,
        evidenceGraph: renderEvidenceGraph,
        characterTracker: renderCharacterTracker,
        filmUnderstanding,
        narrativeIntelligence,
        sceneMetadata: analysis?.sceneMetadata || renderSceneMetadata,
        visualPacing: renderVisualPacing,
        segments: normalizedSegments
      };
      const viralService = new ViralIntelligenceService({ enabled: project.viralOptimization !== false });
      let viralAnalysis = null;
      let viralFactGuard = null;
      let retentionPlan = null;
      let viralTimeline = null;
      let attentionQa = null;
      let viralRepairResult = null;
      let viralArtifactPaths = {};
      let narrationProvenanceRender = null;
      let narrationProvenanceRenderPath = "";
      let viralOptimizationFallback = false;
      let viralOptimizationFallbackReason = "";
      try {
        const viralResult = viralService.buildAll({
          videoId: project.id || projectId,
          platform: project.viralPlatform || "tiktok",
          targetDuration: project.targetDuration,
          voiceSpeed: project.voiceSpeed || 1,
          genreMode,
          viralAngle,
          candidates: normalizedAnalysis.candidates,
          segments: normalizedSegments,
          filmMemory: normalizedAnalysis.filmMemory,
          filmUnderstanding: normalizedAnalysis.filmUnderstanding,
          narrativeIntelligence: normalizedAnalysis.narrativeIntelligence,
          evidenceGraph: renderEvidenceGraphData
        });
        if (viralResult.fallback) {
          viralOptimizationFallback = true;
          viralOptimizationFallbackReason = viralResult.fallbackReason || "viral_layer_disabled";
        } else {
          viralAnalysis = viralResult.viralAnalysis;
          viralFactGuard = viralResult.viralFactGuard;
          retentionPlan = viralResult.retentionPlan;
          viralTimeline = viralResult.viralTimeline;
          normalizedSegments = viralResult.annotatedSegments;
          normalizedAnalysis.segments = normalizedSegments;
          normalizedAnalysis.viralAnalysis = viralAnalysis;
          normalizedAnalysis.viralFactGuard = viralFactGuard;
          normalizedAnalysis.retentionPlan = retentionPlan;
          normalizedAnalysis.viralTimeline = viralTimeline;
          normalizedAnalysis.editNotes.push("Viral Intelligence Layer: retention plan and attention timeline generated.");
          if (viralFactGuard?.issues?.length) {
            normalizedAnalysis.editNotes.push(
              ...viralFactGuard.issues.slice(0, 6).map((issue) => `Viral Fact Guard ${issue.severity}: ${issue.code} (${issue.term}).`)
            );
          }
        }
      } catch (error) {
        viralOptimizationFallback = true;
        viralOptimizationFallbackReason = error.message;
        normalizedAnalysis.editNotes.push(`Viral optimization fallback: ${error.message}`);
      }
      viralArtifactPaths = await viralService.writeArtifacts({
        outputDir: paths.outputDir,
        projectStore: this.projectStore,
        viralAnalysis,
        viralFactGuard,
        retentionPlan,
        viralTimeline,
        fallbackReason: viralOptimizationFallbackReason
      }).catch(() => ({}));
      normalizedAnalysis.artifacts = {
        ...(normalizedAnalysis.artifacts || {}),
        ...viralArtifactPaths
      };
      normalizedAnalysis.viralOptimizationFallback = viralOptimizationFallback;
      normalizedAnalysis.viralOptimizationFallbackReason = viralOptimizationFallbackReason;
      let renderPlanSegments = normalizedSegments;
      let renderTargetDuration = Number(project.targetDuration);

      if (!normalizedSegments.length) {
        throw new Error("Gemini did not return any usable segments for this video.");
      }

      const builtSegmentPaths = [];
      const subtitleEntries = [];
      let elapsedSeconds = 0;
      const shouldUseSourceAudio = Boolean(videoMeta.hasAudio) && !project.muteSourceAudio;
      let continuousNarrationPath = null;
      let narrationAlreadyMixedIntoSegments = false;
      let narrationProject = project;
      let voiceVisualRenderReport = null;
      let narrationGroundingRenderReport = null;

      if (project.narrationEnabled && voiceProvider === "omnivoice" && project.cloneSourceVoice) {
        if (!videoMeta.hasAudio) {
          throw new Error("Clone voice from source video needs a video with an audio track.");
        }
        const referenceStartSec = Math.max(0, Math.min(
          Number(normalizedSegments[0]?.startSec || 0),
          Math.max(0, videoMeta.duration - 1)
        ));
        const referenceDurationSec = Math.min(18, Math.max(5, videoMeta.duration - referenceStartSec));
        const omniVoiceReferencePath = path.join(paths.audioDir, "source-voice-reference.wav");

        await emit("narrating", 19, "�ang tr�ch m?u gi?ng ngu?n cho OmniVoice");
        await ffmpeg.extractVoiceReferenceAudio({
          sourcePath: project.sourceVideoPath,
          outputPath: omniVoiceReferencePath,
          startSec: referenceStartSec,
          durationSec: referenceDurationSec
        });
        await this.projectStore.updateProject(workspaceRoot, projectId, {
          artifacts: {
            omniVoiceReferencePath
          }
        }).catch(() => {});
        narrationProject = {
          ...project,
          voiceId: omniVoiceReferencePath
        };
      }

      if (project.narrationEnabled) {
        const useSourceAudioBed = shouldUseSourceAudio;
        const wordTargets = getNarrationWordTargets(project.targetDuration, project.voiceSpeed);
        const hasEditableNarration = normalizedSegments.some((segment) => safeText(segment.narrationLine));
        const narrationPolishPath = path.join(paths.analysisDir, "narration-polish.json");
        let polishResult = null;
        let polishedDisplaySegments = normalizedSegments;
        let polishedFullNarration = normalizedSegments.map((segment) => ensureNarrationSentence(segment.narrationLine)).join(" ");
        let geminiForNarration = null;

        if (hasEditableNarration) {
          await emit("narrating", 21, `�ang d�ng l?i recap d� ch?nh (${wordTargets.minWords}-${wordTargets.maxWords} t? m?c ti�u, gi?ng ${wordTargets.voiceSpeed.toFixed(2)}x)`);
        } else {
          await emit("narrating", 21, `�ang vi?t l?i thuy?t minh d?ng b? b?ng Gemini (${wordTargets.minWords}-${wordTargets.maxWords} t? n�i, gi?ng ${wordTargets.voiceSpeed.toFixed(2)}x)`);
          geminiForNarration = new GeminiService(settings.geminiApiKey, settings.geminiModel);
          polishResult = await geminiForNarration.polishNarrationForDuration({
            title: normalizedAnalysis.title,
            summary: normalizedAnalysis.summary,
            segments: normalizedSegments,
            targetDuration: project.targetDuration,
            voiceSpeed: project.voiceSpeed || 1,
            genreMode,
            perspective,
            narrationLanguage: project.narrationLanguage || "auto",
            filmMemory: normalizedAnalysis.filmMemory,
            evidenceStore: renderEvidenceStoreData,
            evidenceGraph: renderEvidenceGraphData,
            characterTracker: renderCharacterTrackerData,
            filmUnderstanding: normalizedAnalysis.filmUnderstanding,
            viralAngle,
            viralAnalysis,
            retentionPlan,
            viralTimeline
          });
          const continuityResult = await geminiForNarration.refineNarrativeContinuity({
            title: normalizedAnalysis.title,
            summary: normalizedAnalysis.summary,
            segments: normalizedSegments,
            polishResult,
            targetDuration: project.targetDuration,
            voiceSpeed: project.voiceSpeed || 1,
            genreMode,
            perspective,
            narrationLanguage: project.narrationLanguage || "auto",
            filmMemory: normalizedAnalysis.filmMemory,
            evidenceStore: renderEvidenceStoreData,
            evidenceGraph: renderEvidenceGraphData,
            characterTracker: renderCharacterTrackerData,
            filmUnderstanding: normalizedAnalysis.filmUnderstanding,
            viralAngle,
            viralAnalysis,
            retentionPlan,
            viralTimeline
          }).catch(() => null);
          if (continuityResult) {
            polishResult = {
              ...polishResult,
              ...continuityResult,
              selectedHook: polishResult.selectedHook,
              hookOptions: polishResult.hookOptions
            };
          }
          polishedDisplaySegments = diversifyRepeatedVisualSegments(
            applyPolishedNarration(normalizedSegments, polishResult, project.voiceSpeed || 1),
            normalizedAnalysis.candidates,
            videoMeta.duration
          );
          polishedFullNarration = safeText(
            polishResult?.fullNarration,
            polishedDisplaySegments.map((segment) => ensureNarrationSentence(segment.narrationLine)).join(" ")
          );
        }
        const polishedWordCount = countSpokenWords(polishedFullNarration);
        await this.projectStore.writeJson(narrationPolishPath, {
          targetDuration: project.targetDuration,
          voiceSpeed: project.voiceSpeed || 1,
          wordTargets,
          wordCount: polishedWordCount,
          polishResult,
          usedEditedNarration: hasEditableNarration
        }).catch(() => {});
        normalizedAnalysis.fullNarration = polishedFullNarration;
        normalizedAnalysis.artifacts = {
          ...(normalizedAnalysis.artifacts || {}),
          narrationPolishPath
        };
        const narrationGroundingRenderPath = path.join(paths.analysisDir, "narration-grounding-render.json");
        narrationGroundingRenderReport = await new NarrationGroundingService().inspectAndWrite({
          segments: polishedDisplaySegments,
          sceneMetadata: normalizedAnalysis.sceneMetadata,
          evidenceStore: renderEvidenceStoreData,
          filmUnderstanding: normalizedAnalysis.filmUnderstanding,
          narrativeIntelligence: normalizedAnalysis.narrativeIntelligence,
          outputPath: narrationGroundingRenderPath
        }).catch(() => null);
        if (narrationGroundingRenderReport?.issues?.length) {
          normalizedAnalysis.editNotes.push(
            ...narrationGroundingRenderReport.issues.slice(0, 8).map((issue) => `Narration grounding ${issue.severity}: segment ${issue.segmentIndex + 1} ${issue.code}.`)
          );
        }
        if (!hasEditableNarration && narrationGroundingRenderReport?.weakSegmentCount > 0 && geminiForNarration) {
          const groundingRepairResult = await geminiForNarration.repairGroundedNarration({
            title: normalizedAnalysis.title,
            summary: normalizedAnalysis.summary,
            segments: polishedDisplaySegments,
            groundingReport: narrationGroundingRenderReport,
            filmMemory: normalizedAnalysis.filmMemory,
            evidenceStore: renderEvidenceStoreData,
            evidenceGraph: renderEvidenceGraphData,
            characterTracker: renderCharacterTrackerData,
            filmUnderstanding: normalizedAnalysis.filmUnderstanding,
            narrativeIntelligence: normalizedAnalysis.narrativeIntelligence,
            targetDuration: project.targetDuration,
            voiceSpeed: project.voiceSpeed || 1,
            genreMode,
            perspective,
            narrationLanguage: project.narrationLanguage || "auto",
            viralAngle
          }).catch(() => null);
          if (groundingRepairResult?.segments?.length) {
            polishedDisplaySegments = diversifyRepeatedVisualSegments(
              applyPolishedNarration(polishedDisplaySegments, groundingRepairResult, project.voiceSpeed || 1),
              normalizedAnalysis.candidates,
              videoMeta.duration
            );
            polishedFullNarration = safeText(
              groundingRepairResult.fullNarration,
              polishedDisplaySegments.map((segment) => ensureNarrationSentence(segment.narrationLine)).join(" ")
            );
            normalizedAnalysis.fullNarration = polishedFullNarration;
            normalizedAnalysis.editNotes.push("Narration Grounding Repair: rewrote weak voice/visual lines before TTS.");
            narrationGroundingRenderReport = await new NarrationGroundingService().inspectAndWrite({
              segments: polishedDisplaySegments,
              sceneMetadata: normalizedAnalysis.sceneMetadata,
              evidenceStore: renderEvidenceStoreData,
              filmUnderstanding: normalizedAnalysis.filmUnderstanding,
              narrativeIntelligence: normalizedAnalysis.narrativeIntelligence,
              outputPath: narrationGroundingRenderPath
            }).catch(() => narrationGroundingRenderReport);
          }
        }
        attentionQa = viralService.inspectAttention({
          segments: polishedDisplaySegments,
          retentionPlan,
          viralTimeline,
          groundingReport: narrationGroundingRenderReport,
          viralFactGuard
        });
        if (attentionQa?.issues?.length) {
          normalizedAnalysis.editNotes.push(
            ...attentionQa.issues.slice(0, 8).map((issue) => `Attention QA ${issue.severity}: ${issue.segmentId} ${issue.issue}.`)
          );
        }
        const shouldRepairViralNarration = !hasEditableNarration && attentionQa?.issues?.some((issue) => issue.severity === "high" || issue.issue === "no_loop_ending");
        if (shouldRepairViralNarration) {
          viralRepairResult = viralService.repair({
            segments: polishedDisplaySegments,
            attentionQa,
            retentionPlan
          });
          if (viralRepairResult?.segments?.length) {
            polishedDisplaySegments = viralRepairResult.segments;
            polishedFullNarration = safeText(
              viralRepairResult.fullNarration,
              polishedDisplaySegments.map((segment) => ensureNarrationSentence(segment.narrationLine)).join(" ")
            );
            normalizedAnalysis.fullNarration = polishedFullNarration;
            normalizedAnalysis.editNotes.push("Viral Repair Pass: applied safe hook/loop fixes before TTS.");
            narrationGroundingRenderReport = await new NarrationGroundingService().inspectAndWrite({
              segments: polishedDisplaySegments,
              sceneMetadata: normalizedAnalysis.sceneMetadata,
              evidenceStore: renderEvidenceStoreData,
              filmUnderstanding: normalizedAnalysis.filmUnderstanding,
              narrativeIntelligence: normalizedAnalysis.narrativeIntelligence,
              outputPath: narrationGroundingRenderPath
            }).catch(() => narrationGroundingRenderReport);
            attentionQa = viralService.inspectAttention({
              segments: polishedDisplaySegments,
              retentionPlan,
              viralTimeline,
              groundingReport: narrationGroundingRenderReport,
              viralFactGuard
            });
          }
        }
        viralArtifactPaths = await viralService.writeArtifacts({
          outputDir: paths.outputDir,
          projectStore: this.projectStore,
          viralAnalysis,
          viralFactGuard,
          retentionPlan,
          viralTimeline,
          attentionQa,
          repairResult: viralRepairResult,
          fallbackReason: viralOptimizationFallbackReason
        }).catch(() => viralArtifactPaths);
        normalizedAnalysis.segments = polishedDisplaySegments;
        const renderNarrativeReportPaths = await writeNarrativeDebugReports({
          projectStore: this.projectStore,
          outputDir: paths.outputDir,
          narrativeIntelligence: normalizedAnalysis.narrativeIntelligence,
          groundingReport: narrationGroundingRenderReport,
          segments: polishedDisplaySegments
        });
        narrationProvenanceRenderPath = path.join(paths.outputDir, "narration-provenance-render.json");
        narrationProvenanceRender = await new NarrationProvenanceService().inspectAndWrite({
          stage: "render",
          segments: polishedDisplaySegments,
          evidenceStore: renderEvidenceStoreData,
          evidenceGraph: renderEvidenceGraphData,
          characterTracker: renderCharacterTrackerData,
          narrationGroundingReport: narrationGroundingRenderReport,
          viralFactGuard,
          outputPath: narrationProvenanceRenderPath
        }).catch(() => null);
        if (narrationProvenanceRender?.report?.blockedCount > 0) {
          normalizedAnalysis.editNotes.push(
            `Narration Provenance: ${narrationProvenanceRender.report.blockedCount} line(s) are blocked by missing/weak evidence.`
          );
        }
        normalizedAnalysis.artifacts = {
          ...(normalizedAnalysis.artifacts || {}),
          ...viralArtifactPaths,
          narrationGroundingRenderPath,
          narrationProvenanceRenderPath,
          ...renderNarrativeReportPaths
        };
        const evidenceQaPreRenderPath = path.join(paths.outputDir, "evidence-qa-pre-render.json");
        const evidenceQaPreRender = await new EvidenceQaService().inspectAndWrite({
          stage: "pre_render",
          segments: polishedDisplaySegments,
          evidenceStore: renderEvidenceStoreData,
          evidenceGraph: renderEvidenceGraphData,
          characterTracker: renderCharacterTrackerData,
          narrationGroundingReport: narrationGroundingRenderReport,
          narrationProvenance: narrationProvenanceRender,
          viralFactGuard,
          attentionQa,
          outputPath: evidenceQaPreRenderPath
        }).catch((error) => ({
          schemaVersion: "evidence-qa.v1",
          passed: false,
          canRender: false,
          issues: [{
            severity: "error",
            code: "evidence_qa_failed",
            message: error.message
          }]
        }));
        normalizedAnalysis.artifacts = {
          ...(normalizedAnalysis.artifacts || {}),
          evidenceQaPreRenderPath
        };
        if (evidenceQaPreRender?.issues?.length) {
          normalizedAnalysis.editNotes.push(
            ...evidenceQaPreRender.issues.slice(0, 10).map((issue) => `Evidence QA ${issue.severity}: ${issue.code}. ${issue.message}`)
          );
        }
        if (!evidenceQaPreRender?.canRender) {
          throw new Error(`Evidence QA failed before render. Check ${evidenceQaPreRenderPath}`);
        }
        const segmentLockedNarration = true;
        if (segmentLockedNarration) {
          const useSourceAudioBed = shouldUseSourceAudio;
          const narrationBeatPaths = [];
          const segmentNarrationPaths = [];
          const segmentNarrationExtension = getNarrationAudioExtension(voiceProvider);
          let syncedSegments = normalizeTimelineToTarget(polishedDisplaySegments, renderTargetDuration);

          normalizedAnalysis.fullNarration = syncedSegments
            .map((segment) => ensureNarrationSentence(segment.narrationLine))
            .join(" ");

          for (let beatIndex = 0; beatIndex < syncedSegments.length; beatIndex += 1) {
            const segment = syncedSegments[beatIndex];
            const segmentLabel = `segment-${String(beatIndex + 1).padStart(2, "0")}`;
            const segmentNarrationPath = path.join(paths.audioDir, `${segmentLabel}-narration${segmentNarrationExtension}`);
            await emit("narrating", 24 + beatIndex * 5, `�ang t?o gi?ng cho kh?i h�nh ${beatIndex + 1}/${syncedSegments.length}`);
            const ttsResult = await synthesizeContinuousNarration({
              voiceProvider,
              settings,
              project: {
                ...narrationProject,
                targetDuration: segment.renderDuration
              },
              genreMode,
              voicePreset,
              narrationText: ensureNarrationSentence(segment.narrationLine),
              outputPath: segmentNarrationPath,
              alignmentPath: path.join(paths.analysisDir, `${segmentLabel}-alignment.json`),
              onProgress: async (message) => {
                if (voiceProvider === "omnivoice") {
                  await emit("narrating", 24 + beatIndex * 5, `OmniVoice kh?i ${beatIndex + 1}: ${safeText(message, "dang ch?y suy lu?n c?c b?")}`);
                }
              }
            });

            const rawAudioMeta = await ffmpeg.probeAudio(segmentNarrationPath);
            syncedSegments[beatIndex] = {
              ...segment,
              rawAudioDuration: rawAudioMeta.duration,
              narrationPath: segmentNarrationPath,
              alignment: ttsResult?.alignment || null
            };
            segmentNarrationPaths.push(segmentNarrationPath);
          }

          const transitionPlanForTiming = buildSegmentLockedTransitionPlan(syncedSegments);
          const totalTransitionDuration = transitionPlanForTiming.reduce((sum, transition) => sum + Number(transition.duration || 0), 0);
          syncedSegments = constrainNarrationRenderDurations(
            syncedSegments,
            renderTargetDuration,
            totalTransitionDuration / Math.max(1, syncedSegments.length - 1),
            { minSpeechRate: 0.94, maxSpeechRate: 1.08 }
          );
          renderTargetDuration = Math.min(
            Number(videoMeta.duration),
            Math.max(renderTargetDuration, sumDurations(syncedSegments, "renderDuration") - totalTransitionDuration)
          );
          let timingCursor = 0;
          syncedSegments = syncedSegments.map((segment, index) => {
            const renderDuration = Math.max(0.35, Number(segment.renderDuration || 0.35));
            const updated = {
              ...segment,
              index,
              timelineStart: timingCursor,
              timelineEnd: timingCursor + renderDuration,
              renderDuration
            };
            timingCursor += renderDuration;
            return updated;
          });

          const voiceVisualRenderPath = path.join(paths.analysisDir, "voice-visual-render-check.json");
          voiceVisualRenderReport = await new VoiceVisualAlignmentService().inspectAndWrite({
            segments: syncedSegments,
            targetDuration: renderTargetDuration,
            voiceSpeed: project.voiceSpeed || 1,
            outputPath: voiceVisualRenderPath
          }).catch(() => null);
          if (voiceVisualRenderReport?.issues?.length) {
            normalizedAnalysis.editNotes.push(
              ...voiceVisualRenderReport.issues.slice(0, 10).map((issue) => `Render sync ${issue.severity}: segment ${issue.segmentIndex + 1} ${issue.code}.`)
            );
          }
          normalizedAnalysis.artifacts = {
            ...(normalizedAnalysis.artifacts || {}),
            voiceVisualRenderPath
          };

          for (let beatIndex = 0; beatIndex < syncedSegments.length; beatIndex += 1) {
            const segment = syncedSegments[beatIndex];
            const segmentLabel = `segment-${String(beatIndex + 1).padStart(2, "0")}`;
            const fittedNarrationPath = path.join(paths.audioDir, `${segmentLabel}-fitted.m4a`);
            const visualPath = path.join(paths.clipsDir, `${segmentLabel}-visual.mp4`);
            const lockedVisualPath = path.join(paths.clipsDir, `${segmentLabel}-visual-locked.mp4`);
            const avPath = path.join(paths.clipsDir, `${segmentLabel}.mp4`);
            const lockedAvPath = path.join(paths.clipsDir, `${segmentLabel}-locked.mp4`);
            const segmentNarrationPath = segment.narrationPath || segmentNarrationPaths[beatIndex];

            await ffmpeg.fitAudioToDuration({
              inputPath: segmentNarrationPath,
              outputPath: fittedNarrationPath,
              targetDuration: segment.renderDuration
            });

            await emit("editing", 45 + beatIndex * 6, `�ang d?ng kh?i h�nh d?ng b? ${beatIndex + 1}/${syncedSegments.length}`);
            await ffmpeg.extractVerticalClip({
              sourcePath: project.sourceVideoPath,
              outputPath: visualPath,
              startSec: segment.startSec,
              clipDuration: segment.clipDuration,
              targetDuration: segment.renderDuration,
              includeSourceAudio: useSourceAudioBed,
              role: segment.role,
              genreMode,
              sourceAudioVolume: project.rewriteVoiceover ? (project.sourceAudioVolumePercentage / 100) : getSourceAudioVolume(segment.role, genreMode),
              screenText: "",
              speedFactor: Math.min(1.15, getSpeedFactor(segment.role, genreMode)),
              visual_energy: segment.visual_energy,
              audio_vibe: segment.audio_vibe,
              font_style: segment.font_style,
              reframe: segment.reframe,
              includeSilentAudio: !useSourceAudioBed
            });
            await ffmpeg.normalizeMediaDuration({
              inputPath: visualPath,
              outputPath: lockedVisualPath,
              targetDuration: segment.renderDuration
            });

            if (useSourceAudioBed) {
              await ffmpeg.mixVideoAndNarration({
                videoPath: lockedVisualPath,
                narrationPath: fittedNarrationPath,
                outputPath: avPath,
                targetDuration: segment.renderDuration,
                sourceAudioVolume: project.rewriteVoiceover ? (project.sourceAudioVolumePercentage / 100) : 0.24
              });
            } else {
              await ffmpeg.mergeVideoAndAudio({
                videoPath: lockedVisualPath,
                audioPath: fittedNarrationPath,
                outputPath: avPath
              });
            }
            await ffmpeg.normalizeMediaDuration({
              inputPath: avPath,
              outputPath: lockedAvPath,
              targetDuration: segment.renderDuration
            });

            builtSegmentPaths.push(lockedAvPath);
            narrationBeatPaths.push(fittedNarrationPath);
            appendWordSubtitleEntries(subtitleEntries, {
              segment: {
                ...segment,
                rawAudioDuration: segment.rawAudioDuration
              },
              elapsedSeconds,
              durationSec: segment.renderDuration,
              alignment: segment.alignment,
              rawAudioDuration: segment.rawAudioDuration
            });
            const overlapWithNext = Number(transitionPlanForTiming[beatIndex]?.duration || 0);
            elapsedSeconds += Math.max(0.05, segment.renderDuration - overlapWithNext);
          }

          continuousNarrationPath = path.join(paths.audioDir, "full-narration-fitted.m4a");
          await ffmpeg.concatAudioSegments(narrationBeatPaths, continuousNarrationPath);
          narrationAlreadyMixedIntoSegments = true;
          renderPlanSegments = syncedSegments.map((segment, segmentIndex) => ({
            index: segment.index,
            role: segment.role,
            narrativeBeat: segment.narrativeBeat || segment.role,
            startSec: segment.startSec,
            endSec: segment.endSec,
            clipDuration: segment.clipDuration,
            requestedDurationSec: segment.requestedDurationSec,
            reason: segment.reason,
            narrationLine: segment.narrationLine,
            subtitleText: segment.subtitleText,
            screenText: segment.screenText,
            energy: segment.energy,
            importanceScore: segment.importanceScore,
            rawAudioDuration: segment.rawAudioDuration || segment.renderDuration,
            minRenderDuration: segment.renderDuration,
            maxRenderDuration: segment.renderDuration,
            renderDuration: segment.renderDuration,
            qualityScore: segment.qualityScore,
            visualClarityScore: segment.visualClarityScore,
            emotionScore: segment.emotionScore,
            motionScore: segment.motionScore,
            contextScore: segment.contextScore,
            dialogueDependency: segment.dialogueDependency,
            spoilerRisk: segment.spoilerRisk,
            mergedFrom: segment.mergedFrom,
            visualBlockIndex: segment.visualBlockIndex,
            narrationPath: segment.narrationPath || segmentNarrationPaths[segmentIndex]
          }));
          normalizedAnalysis.segments = renderPlanSegments;
          normalizedAnalysis.editNotes.push(
            `Segment-locked narration: generated ${syncedSegments.length} separate voice blocks so each visual block carries only its own narration.`
          );
        } else {
        let currentFullNarration = polishedFullNarration;
        const narrationAudioExtension = getNarrationAudioExtension(voiceProvider);
        continuousNarrationPath = path.join(paths.audioDir, `full-narration${narrationAudioExtension}`);
        const continuousAlignmentPath = path.join(paths.analysisDir, "full-narration-alignment.json");
        let beatMap;

        await emit("narrating", 24, "�ang t?o m?t track thuy?t minh li�n t?c");
        let lastDuration = 0;
        const narrationAttempts = [];
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const attemptPath = path.join(
            paths.audioDir,
            `full-narration-attempt-${attempt}${narrationAudioExtension}`
          );
          const attemptAlignmentPath = path.join(paths.analysisDir, `full-narration-alignment-attempt-${attempt}.json`);
          const ttsResult = await synthesizeContinuousNarration({
            voiceProvider,
            settings,
            project: narrationProject,
            genreMode,
            voicePreset,
            narrationText: currentFullNarration,
            outputPath: attemptPath,
            alignmentPath: attemptAlignmentPath,
            onProgress: async (message) => {
              if (voiceProvider === "omnivoice") {
                await emit("narrating", 24 + attempt * 2, `OmniVoice l?n th? ${attempt}/3: ${safeText(message, "dang ch?y suy lu?n c?c b?")}`);
              }
            }
          });
          const audioMeta = await ffmpeg.probeAudio(attemptPath);
          lastDuration = audioMeta.duration;
          narrationAttempts.push({
            attempt,
            path: attemptPath,
            duration: lastDuration,
            wordCount: countSpokenWords(currentFullNarration)
          });
          continuousNarrationPath = attemptPath;

          beatMap = normalizedSegments.map((segment) => ({
            ...segment,
            audioDuration: segment.renderDuration,
            beatWords: []
          }));

          const ratio = lastDuration / Math.max(0.1, Number(project.targetDuration));
          if (ratio >= 0.85 && ratio <= 1.15) {
            break;
          }
          if (attempt === 3) {
            break;
          }

          await emit("narrating", 24 + attempt * 4, `�ang vi?t l?i l?i thuy?t minh d? kh?p ${project.targetDuration} gi�y (do du?c ${lastDuration.toFixed(1)} gi�y)`);
          const rewriteResult = await geminiForNarration.rewriteNarrationToFitDuration({
            fullNarration: currentFullNarration,
            segments: polishedDisplaySegments,
            targetDuration: project.targetDuration,
            voiceSpeed: project.voiceSpeed || 1,
            actualDuration: lastDuration,
            narrationLanguage: project.narrationLanguage || "auto",
            genreMode,
            perspective,
            filmMemory: normalizedAnalysis.filmMemory,
            filmUnderstanding: normalizedAnalysis.filmUnderstanding,
            viralAngle
          });
          const rewrittenDisplaySegments = diversifyRepeatedVisualSegments(
            applyPolishedNarration(polishedDisplaySegments, rewriteResult, project.voiceSpeed || 1),
            normalizedAnalysis.candidates,
            videoMeta.duration
          );
          currentFullNarration = safeText(
            rewriteResult?.fullNarration,
            rewrittenDisplaySegments.map((segment) => ensureNarrationSentence(segment.narrationLine)).join(" ")
          );
          normalizedAnalysis.fullNarration = currentFullNarration;
        }
        await this.projectStore.writeJson(path.join(paths.analysisDir, "narration-fit-attempts.json"), {
          targetDuration: project.targetDuration,
          attempts: narrationAttempts
        }).catch(() => {});

        const finalNarrationMeta = await ffmpeg.probeAudio(continuousNarrationPath);
        const finalNarrationDuration = Math.max(0.3, Number(finalNarrationMeta.duration || project.targetDuration));
        const finalRatio = finalNarrationDuration / Math.max(0.1, Number(project.targetDuration));
        if (finalRatio >= 0.85 && finalRatio <= 1.15) {
          const fittedNarrationPath = path.join(paths.audioDir, "full-narration-fitted.m4a");
          await ffmpeg.fitNarrationTrackToDuration({
            inputPath: continuousNarrationPath,
            outputPath: fittedNarrationPath,
            targetDuration: project.targetDuration
          });
          continuousNarrationPath = fittedNarrationPath;
          renderTargetDuration = Number(project.targetDuration);
          beatMap = scaleBeatMapToDuration(beatMap, renderTargetDuration);
        } else {
          renderTargetDuration = Math.min(Number(videoMeta.duration), finalNarrationDuration);
          normalizedSegments = normalizeTimelineToTarget(normalizedSegments, renderTargetDuration);
          beatMap = scaleBeatMapToDuration(beatMap, renderTargetDuration);
          normalizedAnalysis.editNotes.push(
            `Narration measured ${finalNarrationDuration.toFixed(1)}s after 3 attempts, outside the safe 15% atempo range. Timeline was extended to ${renderTargetDuration.toFixed(1)}s instead of distorting the voice.`
          );
        }
        validateNarrationDuration(beatMap, renderTargetDuration);
        const visualBeats = ensureVisualCoverageForBeats(normalizedSegments.map((segment, index) => ({
          ...segment,
          audioDuration: beatMap[index]?.audioDuration || segment.renderDuration,
          beatWords: beatMap[index]?.beatWords || [],
          audioStartSec: beatMap[index]?.audioStartSec || segment.timelineStart || 0,
          audioEndSec: beatMap[index]?.audioEndSec || segment.timelineEnd || 0
        })), videoMeta.duration, genreMode);
        for (const beat of visualBeats) {
          const segmentLabel = `segment-${String(beat.index + 1).padStart(2, "0")}`;
          const clipPath = path.join(paths.clipsDir, `${segmentLabel}.mp4`);
          await emit("editing", 42 + beat.index * 8, `�ang d?ng nh?p h�nh ${beat.index + 1}/${visualBeats.length}`);
          await ffmpeg.extractVerticalClip({
            sourcePath: project.sourceVideoPath,
            outputPath: clipPath,
            startSec: beat.startSec,
            clipDuration: beat.clipDuration,
            targetDuration: beat.renderDuration,
            includeSourceAudio: useSourceAudioBed,
            role: beat.role,
            genreMode,
            sourceAudioVolume: project.rewriteVoiceover ? (project.sourceAudioVolumePercentage / 100) : getSourceAudioVolume(beat.role, genreMode),
            screenText: "",
            speedFactor: Math.min(1.15, getSpeedFactor(beat.role, genreMode)),
            visual_energy: beat.visual_energy,
            audio_vibe: beat.audio_vibe,
            font_style: beat.font_style,
            reframe: beat.reframe,
            includeSilentAudio: !useSourceAudioBed
          });
          builtSegmentPaths.push(clipPath);
        }

        subtitleEntries.push(...buildSubtitleEntriesFromNarrationText(normalizedAnalysis.fullNarration, renderTargetDuration));
        renderPlanSegments = visualBeats.map((beat) => ({
          index: beat.index,
          role: beat.role,
          startSec: beat.startSec,
          endSec: beat.endSec,
          clipDuration: beat.clipDuration,
          requestedDurationSec: beat.requestedDurationSec,
          reason: beat.reason,
          narrationLine: beat.narrationLine,
          subtitleText: beat.subtitleText,
          screenText: beat.screenText,
          energy: beat.energy,
          importanceScore: beat.importanceScore,
          rawAudioDuration: beat.audioDuration,
          minRenderDuration: beat.audioDuration,
          maxRenderDuration: beat.renderDuration,
          renderDuration: beat.renderDuration,
          qualityScore: beat.qualityScore,
          visualClarityScore: beat.visualClarityScore,
          emotionScore: beat.emotionScore,
          motionScore: beat.motionScore,
          contextScore: beat.contextScore,
          dialogueDependency: beat.dialogueDependency,
          spoilerRisk: beat.spoilerRisk,
          expandedForVoiceCoverage: Boolean(beat.expandedForVoiceCoverage)
        }));
        normalizedAnalysis.segments = renderPlanSegments;
        }
      } else if (false) {
        const elevenLabs = voiceProvider === "elevenlabs" && settings.elevenLabsApiKey
          ? new ElevenLabsService(settings.elevenLabsApiKey, settings.elevenLabsModel, settings)
          : null;
        const windowsVoiceService = (voiceProvider === "windows_local" || voiceProvider === "elevenlabs")
          ? new WindowsVoiceService()
          : null;
        const useSourceAudioBed = shouldUseSourceAudio;

        if (voiceProvider === "elevenlabs") {
          const narrationBeatPaths = [];
          const narrationAudioPaths = [];

          for (let beatIndex = 0; beatIndex < normalizedSegments.length; beatIndex += 1) {
            const segment = normalizedSegments[beatIndex];
            const segmentLabel = `segment-${String(segment.index + 1).padStart(2, "0")}`;
            const segmentNarrationPath = path.join(paths.audioDir, `${segmentLabel}-narration.mp3`);
            const segmentAlignmentPath = path.join(paths.analysisDir, `${segmentLabel}-alignment.json`);

            await emit("narrating", 24 + beatIndex * 5, `�ang t?o gi?ng cho ${segment.role} (${beatIndex + 1}/${normalizedSegments.length})`);
            let narrationPath = segmentNarrationPath;
            let alignment = null;

            try {
              if (!elevenLabs) {
                throw new Error("ElevenLabs API key is missing.");
              }
              const ttsResult = await elevenLabs.synthesizeSpeechWithTimestamps({
                text: ensureNarrationSentence(segment.narrationLine),
                voiceId: project.voiceId || settings.defaultVoiceId,
                outputPath: segmentNarrationPath,
                alignmentPath: segmentAlignmentPath,
                languageCode: getNarrationLanguageCode(project.narrationLanguage),
                performanceMode: getPerformanceModeForRole(segment.role),
                genreMode
              });
              alignment = ttsResult.alignment;
            } catch (error) {
              await emit(
                "narrating",
                24 + beatIndex * 5,
                `ElevenLabs l?i ? ${segment.role}; dang chuy?n sang Windows Local TTS`
              );
              narrationPath = path.join(paths.audioDir, `${segmentLabel}-narration-fallback.wav`);
              await windowsVoiceService.synthesizeSpeech({
                text: ensureNarrationSentence(segment.narrationLine),
                voiceName: settings.defaultWindowsVoice || "",
                outputPath: narrationPath,
                rate: voicePreset.windowsRate
              }).catch((fallbackError) => {
                throw new Error(`ElevenLabs failed (${error.message}) and Windows Local TTS fallback failed (${fallbackError.message}).`);
              });
            }

            const audioMeta = await ffmpeg.probeAudio(narrationPath);
            narrationAudioPaths.push({
              ...segment,
              narrationPath,
              alignment,
              rawAudioDuration: audioMeta.duration
            });
          }

          const constrainedSegments = fitSegmentsToRenderDurations(
            useNaturalNarrationDurations(narrationAudioPaths),
            videoMeta.duration,
            genreMode
          );

          for (const segment of constrainedSegments) {
            const segmentLabel = `segment-${String(segment.index + 1).padStart(2, "0")}`;
            const visualPath = path.join(paths.clipsDir, `${segmentLabel}-visual.mp4`);
            const fittedNarrationPath = path.join(paths.audioDir, `${segmentLabel}-fitted.m4a`);

            await ffmpeg.fitAudioToDuration({
              inputPath: segment.narrationPath,
              outputPath: fittedNarrationPath,
              targetDuration: segment.renderDuration
            });

            await emit("editing", 55 + segment.index * 5, `�ang d?ng nh?p ${segment.index + 1}/${constrainedSegments.length}`);
            await ffmpeg.extractVerticalClip({
              sourcePath: project.sourceVideoPath,
              outputPath: visualPath,
              startSec: segment.startSec,
              clipDuration: segment.clipDuration,
              targetDuration: segment.renderDuration,
              includeSourceAudio: useSourceAudioBed,
              role: segment.role,
              genreMode,
              sourceAudioVolume: project.rewriteVoiceover ? (project.sourceAudioVolumePercentage / 100) : getSourceAudioVolume(segment.role, genreMode),
              screenText: "",
              speedFactor: getSpeedFactor(segment.role, genreMode),
              visual_energy: segment.visual_energy,
              audio_vibe: segment.audio_vibe,
              font_style: segment.font_style,
              reframe: segment.reframe
            });

            if (useSourceAudioBed) {
              const avPath = path.join(paths.clipsDir, `${segmentLabel}.mp4`);
              await ffmpeg.mixVideoAndNarration({
                videoPath: visualPath,
                narrationPath: fittedNarrationPath,
                outputPath: avPath,
                targetDuration: segment.renderDuration,
                sourceAudioVolume: project.rewriteVoiceover ? (project.sourceAudioVolumePercentage / 100) : 0.24
              });
              builtSegmentPaths.push(avPath);
            } else {
              const avPath = path.join(paths.clipsDir, `${segmentLabel}.mp4`);
              await ffmpeg.mergeVideoAndAudio({
                videoPath: visualPath,
                audioPath: fittedNarrationPath,
                outputPath: avPath
              });
              builtSegmentPaths.push(avPath);
            }

            narrationBeatPaths.push(fittedNarrationPath);
            const subtitleDisplayDuration = Math.max(1.2, segment.renderDuration);
            appendWordSubtitleEntries(subtitleEntries, {
              segment,
              elapsedSeconds,
              durationSec: subtitleDisplayDuration,
              alignment: segment.alignment,
              rawAudioDuration: segment.rawAudioDuration
            });
            elapsedSeconds += subtitleDisplayDuration;
          }

          renderPlanSegments = constrainedSegments.map((segment) => ({
            index: segment.index,
            role: segment.role,
            startSec: segment.startSec,
            endSec: segment.endSec,
            clipDuration: segment.clipDuration,
            requestedDurationSec: segment.requestedDurationSec,
            reason: segment.reason,
            narrationLine: segment.narrationLine,
            subtitleText: segment.subtitleText,
            screenText: segment.screenText,
            energy: segment.energy,
            importanceScore: segment.importanceScore,
            rawAudioDuration: segment.rawAudioDuration,
            minRenderDuration: segment.minRenderDuration,
            maxRenderDuration: segment.maxRenderDuration,
            renderDuration: segment.renderDuration
          }));
          normalizedAnalysis.segments = renderPlanSegments;

          normalizedAnalysis.artifacts = {};
        } else {
          const narrationDrafts = [];

          for (const segment of normalizedSegments) {
            const segmentLabel = `segment-${String(segment.index + 1).padStart(2, "0")}`;
            await emit("narrating", 24 + segment.index * 7, `�ang t?o thuy?t minh cho c?nh ${segment.index + 1}/${normalizedSegments.length}`);

            const audioExtension = "wav";
            const audioPath = path.join(paths.audioDir, `${segmentLabel}-raw.${audioExtension}`);
            const fittedNarrationPath = path.join(paths.audioDir, `${segmentLabel}-fitted.m4a`);

            await windowsVoiceService.synthesizeSpeech({
              text: segment.narrationLine,
              voiceName: project.voiceId || settings.defaultWindowsVoice || "",
              outputPath: audioPath,
              rate: voicePreset.windowsRate
            });

            const audioMeta = await ffmpeg.probeAudio(audioPath);
            narrationDrafts.push({
              ...segment,
              audioPath,
              fittedNarrationPath,
              visualPath: path.join(paths.clipsDir, `${segmentLabel}-visual.mp4`),
              avPath: path.join(paths.clipsDir, `${segmentLabel}.mp4`),
              rawAudioDuration: audioMeta.duration
            });
          }

          const naturalizedSegments = fitSegmentsToRenderDurations(
            useNaturalNarrationDurations(narrationDrafts),
            videoMeta.duration,
            genreMode
          );

          for (const segment of naturalizedSegments) {
            await ffmpeg.fitAudioToDuration({
              inputPath: segment.audioPath,
              outputPath: segment.fittedNarrationPath,
              targetDuration: segment.renderDuration
            });

            await emit("editing", 30 + segment.index * 8, `�ang d?ng clip ${segment.role} ${segment.index + 1}/${naturalizedSegments.length}`);
            await ffmpeg.extractVerticalClip({
              sourcePath: project.sourceVideoPath,
              outputPath: segment.visualPath,
              startSec: segment.startSec,
              clipDuration: segment.clipDuration,
              targetDuration: segment.renderDuration,
              includeSourceAudio: useSourceAudioBed,
              role: segment.role,
              genreMode,
              sourceAudioVolume: project.rewriteVoiceover ? (project.sourceAudioVolumePercentage / 100) : getSourceAudioVolume(segment.role, genreMode),
              screenText: "",
              speedFactor: getSpeedFactor(segment.role, genreMode),
              visual_energy: segment.visual_energy,
              audio_vibe: segment.audio_vibe,
              font_style: segment.font_style,
              reframe: segment.reframe
            });

            if (useSourceAudioBed) {
              await ffmpeg.mixVideoAndNarration({
                videoPath: segment.visualPath,
                narrationPath: segment.fittedNarrationPath,
                outputPath: segment.avPath,
                targetDuration: segment.renderDuration,
                sourceAudioVolume: project.rewriteVoiceover ? (project.sourceAudioVolumePercentage / 100) : 0.24
              });
            } else {
              await ffmpeg.mergeVideoAndAudio({
                videoPath: segment.visualPath,
                audioPath: segment.fittedNarrationPath,
                outputPath: segment.avPath
              });
            }

            builtSegmentPaths.push(segment.avPath);
            const subtitleDisplayDuration = Math.max(1.2, segment.renderDuration);
            appendWordSubtitleEntries(subtitleEntries, {
              segment,
              elapsedSeconds,
              durationSec: subtitleDisplayDuration
            });
            elapsedSeconds += subtitleDisplayDuration;
          }

          renderPlanSegments = naturalizedSegments.map((segment) => ({
            index: segment.index,
            role: segment.role,
            startSec: segment.startSec,
            endSec: segment.endSec,
            clipDuration: segment.clipDuration,
            requestedDurationSec: segment.requestedDurationSec,
            reason: segment.reason,
            narrationLine: segment.narrationLine,
            subtitleText: segment.subtitleText,
            screenText: "",
            energy: segment.energy,
            importanceScore: segment.importanceScore,
            rawAudioDuration: segment.rawAudioDuration,
            minRenderDuration: segment.minRenderDuration,
            maxRenderDuration: segment.maxRenderDuration,
            renderDuration: segment.renderDuration
          }));
          normalizedAnalysis.segments = renderPlanSegments;
        }
      } else {
        const useSourceAudioBed = shouldUseSourceAudio;
        for (const segment of normalizedSegments) {
          const segmentLabel = `segment-${String(segment.index + 1).padStart(2, "0")}`;
          await emit("editing", 28 + segment.index * 8, `�ang d?ng clip ${segment.index + 1}/${normalizedSegments.length}`);

          const clipPath = path.join(paths.clipsDir, `${segmentLabel}.mp4`);
          await ffmpeg.extractVerticalClip({
            sourcePath: project.sourceVideoPath,
            outputPath: clipPath,
            startSec: segment.startSec,
            clipDuration: segment.clipDuration,
            targetDuration: segment.renderDuration,
            includeSourceAudio: useSourceAudioBed,
            role: segment.role,
            genreMode,
            sourceAudioVolume: project.rewriteVoiceover ? (project.sourceAudioVolumePercentage / 100) : getSourceAudioVolume(segment.role, genreMode),
            screenText: "",
            speedFactor: getSpeedFactor(segment.role, genreMode),
            visual_energy: segment.visual_energy,
            audio_vibe: segment.audio_vibe,
            font_style: segment.font_style,
            reframe: segment.reframe,
            includeSilentAudio: !useSourceAudioBed
          });
          builtSegmentPaths.push(clipPath);
          const subtitleDisplayDuration = Math.max(
            1.2,
            segment.renderDuration - (segment.index < normalizedSegments.length - 1 ? transitionDuration : 0)
          );
          appendWordSubtitleEntries(subtitleEntries, {
            segment,
            elapsedSeconds,
            durationSec: subtitleDisplayDuration
          });
          elapsedSeconds += subtitleDisplayDuration;
        }
      }

      await this.projectStore.writeJson(path.join(paths.analysisDir, "review-plan.json"), normalizedAnalysis);
      await this.projectStore.updateProject(workspaceRoot, projectId, {
        analysis: normalizedAnalysis,
        artifacts: {
          ...(normalizedAnalysis.artifacts || {}),
          thumbnailPath,
          detectedScenePath,
          filmMemoryPromptPath,
          filmMemoryRawResponsePath,
          filmMemoryParsedResponsePath,
          filmMemoryCachePath,
          geminiPromptPath,
          geminiRawResponsePath,
          geminiParsedResponsePath,
          geminiCachePath
        }
      });

      await emit("assembling", 88, "�ang gh�p t?t c? c?nh d� ch?n");
      const rawOutputPath = path.join(paths.outputDir, "review-draft-raw.mp4");
      {
        const transitionPlan = narrationAlreadyMixedIntoSegments
          ? buildSegmentLockedTransitionPlan(renderPlanSegments)
          : buildTransitionPlan(renderPlanSegments, genreMode);
        const actualSegmentDurations = [];
        for (const segmentPath of builtSegmentPaths) {
          const segmentMeta = await ffmpeg.probeVideo(segmentPath);
          actualSegmentDurations.push(segmentMeta.duration || renderPlanSegments[actualSegmentDurations.length]?.renderDuration || 0);
        }
        await ffmpeg.concatSegmentsWithTransitions(
          builtSegmentPaths,
          actualSegmentDurations,
          rawOutputPath,
          transitionPlan
        );
      }

      let videoForSubtitlesPath = rawOutputPath;
      let finalVideoPath = rawOutputPath;
      let subtitlePath = null;
      let subtitleProvider = null;
      let voicedOutputPath = null;

      if (project.narrationEnabled && continuousNarrationPath && !narrationAlreadyMixedIntoSegments) {
        voicedOutputPath = path.join(paths.outputDir, "review-draft-voiced.mp4");
        await emit("assembling", 91, "�ang g?n track thuy?t minh li�n t?c");
        if (shouldUseSourceAudio) {
          await ffmpeg.mixVideoWithNarrationTrack({
            videoPath: rawOutputPath,
            narrationPath: continuousNarrationPath,
            outputPath: voicedOutputPath
          });
        } else {
          await ffmpeg.replaceVideoAudio({
            videoPath: rawOutputPath,
            audioPath: continuousNarrationPath,
            outputPath: voicedOutputPath
          });
        }
        videoForSubtitlesPath = voicedOutputPath;
        finalVideoPath = voicedOutputPath;
      }

      if (project.narrationEnabled && continuousNarrationPath && !narrationAlreadyMixedIntoSegments) {
        const subtitleService = new SubtitleService(settings);
        await emit("subtitles", 93, "�ang nh?n di?n l?i thuy?t minh d? d?ng b? ph? d?");
        try {
          const subtitleResult = await subtitleService.transcribeToSrt({
            audioPath: continuousNarrationPath,
            outputDir: paths.outputDir,
            narrationLanguage: project.narrationLanguage || "auto"
          });
          subtitlePath = subtitleResult.subtitlePath;
          subtitleProvider = subtitleResult.provider;
        } catch (error) {
          subtitlePath = path.join(paths.outputDir, "review-draft.ass");
          subtitleProvider = "estimated_ass_fallback";
          normalizedAnalysis.editNotes.push(
            `Whisper subtitle sync failed (${error.message}). Used estimated subtitle timing fallback. Install OpenAI Whisper CLI or set WHISPER_COMMAND for word-accurate subtitles.`
          );
          const assText = buildAssFileContent(subtitleEntries, settings.verticalWidth || 1080, settings.verticalHeight || 1920);
          await this.projectStore.writeText(subtitlePath, assText);
        }
      } else if (project.narrationEnabled && narrationAlreadyMixedIntoSegments && subtitleEntries.length > 0) {
        const hasTtsAlignment = subtitleEntries.some((entry) => entry.timingSource === "tts_alignment");
        if (hasTtsAlignment) {
          subtitlePath = path.join(paths.outputDir, "review-draft.ass");
          subtitleProvider = "tts_alignment_ass";
          const assText = buildAssFileContent(subtitleEntries, settings.verticalWidth || 1080, settings.verticalHeight || 1920);
          await this.projectStore.writeText(subtitlePath, assText);
        } else {
          const subtitleService = new SubtitleService(settings);
          await emit("subtitles", 93, "�ang nh?n di?n audio final d� tr?n d? d?ng b? ph? d?");
          try {
            const subtitleResult = await subtitleService.transcribeToSrt({
              audioPath: videoForSubtitlesPath,
              outputDir: paths.outputDir,
              narrationLanguage: project.narrationLanguage || "auto"
            });
            subtitlePath = subtitleResult.subtitlePath;
            subtitleProvider = `${subtitleResult.provider}_final_audio`;
          } catch (error) {
            subtitlePath = path.join(paths.outputDir, "review-draft.ass");
            subtitleProvider = "segment_locked_estimated_ass";
            normalizedAnalysis.editNotes.push(
              `Final-audio subtitle sync failed (${error.message}). Used segment-locked estimated subtitle timing fallback.`
            );
            const assText = buildAssFileContent(subtitleEntries, settings.verticalWidth || 1080, settings.verticalHeight || 1920);
            await this.projectStore.writeText(subtitlePath, assText);
          }
        }
      } else if (subtitleEntries.length > 0) {
        subtitlePath = path.join(paths.outputDir, "review-draft.ass");
        subtitleProvider = "estimated_ass_fallback";
        const assText = buildAssFileContent(subtitleEntries, settings.verticalWidth || 1080, settings.verticalHeight || 1920);
        await this.projectStore.writeText(subtitlePath, assText);
      }

      if (subtitlePath && project.showSubtitles !== false) {
        await emit("subtitles", 94, "�ang ch�n ph? d? v�o b?n nh�p cu?i");
        finalVideoPath = path.join(paths.outputDir, "review-draft-final.mp4");
        await ffmpeg.burnSubtitles({
          videoPath: videoForSubtitlesPath,
          subtitlePath,
          outputPath: finalVideoPath
        });
      }

      await emit("sync", 96, "�ang kh�a timing gi?ng v� h�nh");
      const strictSyncedPath = path.join(paths.outputDir, "review-draft-strict-sync.mp4");
      await ffmpeg.normalizeMediaDuration({
        inputPath: finalVideoPath,
        outputPath: strictSyncedPath,
        targetDuration: renderTargetDuration
      });
      finalVideoPath = strictSyncedPath;

      const syncReportPath = path.join(paths.outputDir, "sync-report.json");
      const narrationPathForStrictSync = narrationAlreadyMixedIntoSegments ? null : continuousNarrationPath;
      const syncReport = await buildStrictSyncReport({
        ffmpeg,
        segmentPaths: builtSegmentPaths,
        renderPlanSegments,
        finalVideoPath,
        narrationPath: narrationPathForStrictSync,
        targetDuration: renderTargetDuration
      });
      await this.projectStore.writeJson(syncReportPath, syncReport).catch(() => {});

      await emit("qa", 97, "�ang ki?m tra ch?t lu?ng video cu?i");
      const qaPath = path.join(paths.outputDir, "render-qa.json");
      const qaService = new RenderQaService(settings);
      const renderQa = await qaService.inspect({
        videoPath: finalVideoPath,
        targetDuration: renderTargetDuration,
        narrationPath: narrationPathForStrictSync,
        subtitlePath,
        syncReport,
        voiceVisualReport: voiceVisualRenderReport,
        narrationGroundingReport: narrationGroundingRenderReport,
        attentionQa,
        expectedWidth: 1080,
        expectedHeight: 1920
      });
      await this.projectStore.writeJson(qaPath, renderQa).catch(() => {});
      const evidenceQaFinalPath = path.join(paths.outputDir, "evidence-qa-final.json");
      const evidenceQaFinal = await new EvidenceQaService().inspectAndWrite({
        stage: "final",
        segments: renderPlanSegments,
        evidenceStore: renderEvidenceStoreData,
        evidenceGraph: renderEvidenceGraphData,
        characterTracker: renderCharacterTrackerData,
        narrationGroundingReport: narrationGroundingRenderReport,
        narrationProvenance: narrationProvenanceRender,
        viralFactGuard,
        attentionQa,
        voiceVisualReport: voiceVisualRenderReport,
        syncReport,
        renderQa,
        outputPath: evidenceQaFinalPath
      }).catch((error) => ({
        schemaVersion: "evidence-qa.v1",
        passed: false,
        canRender: false,
        issues: [{
          severity: "error",
          code: "evidence_qa_failed",
          message: error.message
        }]
      }));
      if (renderQa.issues.length) {
        normalizedAnalysis.editNotes.push(
          ...renderQa.issues.map((issue) => `QA ${issue.severity}: ${issue.message}`)
        );
      }
      if (evidenceQaFinal?.issues?.length) {
        normalizedAnalysis.editNotes.push(
          ...evidenceQaFinal.issues.slice(0, 10).map((issue) => `Evidence QA ${issue.severity}: ${issue.code}. ${issue.message}`)
        );
      }
      if (!renderQa.passed) {
        throw new Error(`Render QA failed. Check ${qaPath}`);
      }
      if (!evidenceQaFinal?.passed) {
        throw new Error(`Evidence QA failed. Check ${evidenceQaFinalPath}`);
      }

      const runHistory = Array.isArray(project.runHistory) ? [...project.runHistory] : [];
      runHistory.unshift({
        renderedAt: new Date().toISOString(),
        finalVideoPath,
        subtitlePath,
        qaPath,
        evidenceQaFinalPath,
        syncReportPath,
        narrationEnabled: project.narrationEnabled,
        voiceProvider,
        segmentCount: normalizedSegments.length
      });

      const updatedProject = await this.projectStore.updateProject(workspaceRoot, projectId, {
        status: "done",
        progressPercent: 100,
        statusMessage: "Review draft is ready",
        analysis: normalizedAnalysis,
        artifacts: {
          ...(normalizedAnalysis.artifacts || {}),
          finalVideoPath,
          rawOutputPath,
          voicedOutputPath,
          narrationPath: continuousNarrationPath,
          subtitlePath,
          subtitleProvider,
          qaPath,
          evidenceQaFinalPath,
          syncReportPath,
          thumbnailPath,
          detectedScenePath,
          filmMemoryPromptPath,
          filmMemoryRawResponsePath,
          filmMemoryParsedResponsePath,
          filmMemoryCachePath,
          geminiPromptPath,
          geminiRawResponsePath,
          geminiParsedResponsePath,
          geminiCachePath
        },
        runHistory
      });

      onProgress?.({
        projectId,
        step: "done",
        percent: 100,
        message: "Review draft is ready",
        project: updatedProject
      });

      return updatedProject;
    } catch (error) {
      await this.projectStore.updateProject(workspaceRoot, projectId, {
        status: "error",
        statusMessage: error.message,
        progressPercent: 0
      }).catch(() => {});
      onProgress?.({
        projectId,
        step: "error",
        percent: 0,
        message: error.message
      });
      throw error;
    } finally {
      this.runningJobs.delete(projectId);
    }
  }
}

module.exports = PipelineService;
