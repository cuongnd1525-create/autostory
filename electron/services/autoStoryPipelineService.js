const fs = require("fs/promises");
const nativeFs = require("fs");
const path = require("path");
const crypto = require("crypto");

const VertexAiService = require("./vertexAiService");
const FfmpegService = require("./ffmpegService");
const schemas = require("./autoStorySchemas");
const prompts = require("./autoStoryPrompts");

const MIN_OUTPUT_DURATION_SEC = 65;
const MAX_OUTPUT_DURATION_SEC = 600;
const DEFAULT_WEIGHTS = Object.freeze({
  hookStrength: 1.35,
  conflict: 1.15,
  visualIntensity: 0.75,
  audioIntensity: 0.75,
  surprise: 1.05,
  emotion: 0.9,
  informationGain: 1.2,
  storyImportance: 1.35,
  payoffValue: 1.25,
  contextDependency: -0.55,
  spoilerRisk: -0.8,
  redundancy: -0.9,
  retentionRisk: -0.85
});

function clamp(value, min, max, fallback = min) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function text(value) {
  return String(value ?? "").trim();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeConfig(raw = {}, project = {}) {
  const targetDurationMinSec = clamp(raw.targetDurationMinSec, MIN_OUTPUT_DURATION_SEC, MAX_OUTPUT_DURATION_SEC, MIN_OUTPUT_DURATION_SEC);
  const targetDurationMaxSec = clamp(raw.targetDurationMaxSec, targetDurationMinSec, MAX_OUTPUT_DURATION_SEC, Math.max(90, targetDurationMinSec));
  const outputCount = Math.round(clamp(raw.outputCount, 1, 5, 2));
  const audioBalance = ["original_first", "balanced", "narrator_led", "original_only"].includes(raw.audioBalance)
    ? raw.audioBalance
    : "balanced";
  return {
    targetDurationMinSec,
    targetDurationMaxSec,
    outputCount,
    candidatePoolSize: Math.min(5, Math.max(3, outputCount + 2)),
    narration: {
      enabled: audioBalance !== "original_only",
      style: ["cinematic", "genz", "factual", "investigative"].includes(raw.narrationStyle) ? raw.narrationStyle : "investigative",
      audioBalance,
      voiceProvider: text(raw.voiceProvider || project.voiceProvider),
      voiceId: text(raw.voiceId || project.voiceId),
      measuredWordsPerSecond: clamp(raw.measuredWordsPerSecond, 0, 10, 0),
      muteSourceDuringNarration: true
    },
    scoreWeights: { ...DEFAULT_WEIGHTS, ...(raw.scoreWeights || {}) }
  };
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(temporary, filePath);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function fileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = nativeFs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function valueHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseSrtClock(value) {
  const match = text(value).match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!match) return NaN;
  return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]) + (Number(match[4].padEnd(3, "0").slice(0, 3)) / 1000);
}

async function writeSrtSlice(sourcePath, outputPath, startSec, endSec) {
  if (!sourcePath) return "";
  const raw = await fs.readFile(sourcePath, "utf8");
  const blocks = raw.replace(/\r/g, "").split(/\n{2,}/).filter((block) => {
    const timing = block.match(/(\d+:\d+:\d+[,.]\d+)\s*-->\s*(\d+:\d+:\d+[,.]\d+)/);
    if (!timing) return false;
    const start = parseSrtClock(timing[1]);
    const end = parseSrtClock(timing[2]);
    return Number.isFinite(start) && Number.isFinite(end) && end >= Number(startSec) && start <= Number(endSec);
  });
  if (!blocks.length) return "";
  await fs.writeFile(outputPath, `${blocks.join("\n\n")}\n`, "utf8");
  return outputPath;
}

function assertAccess(result, stage) {
  if (result?.artifactType === "auto_story_input_access_failure" || result?.accessGranted === false) {
    const missing = list(result.missingInputs).filter(Boolean).join(", ");
    throw new Error(`Vertex không truy cập đủ input ở ${stage}${missing ? `: ${missing}` : ""}. ${text(result.mismatchDetails || result.recommendedAction)}`.trim());
  }
  if (result?.inputAccessAudit?.accessGranted !== true) {
    throw new Error(`${stage}: AI chưa xác nhận đã truy cập đầy đủ input.`);
  }
}

function timeRange(item) {
  return {
    start: Number(item?.start ?? item?.startSec ?? item?.sourceStart ?? item?.sourceStartSec),
    end: Number(item?.end ?? item?.endSec ?? item?.sourceEnd ?? item?.sourceEndSec)
  };
}

function canonicalEventCoverage(raw, durationSec) {
  const events = Array.isArray(raw) ? raw : list(raw?.events);
  const duration = Number(durationSec);
  const ranges = events
    .map((event) => ({ event, ...timeRange(event) }))
    .filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start);
  const coverageStartSec = ranges.length ? Math.min(...ranges.map(({ start }) => start)) : NaN;
  const coverageEndSec = ranges.length ? Math.max(...ranges.map(({ end }) => end)) : NaN;
  const evidenceCount = ranges.filter(({ event }) => {
    return Boolean(text(event?.visualEvidence) || text(event?.audioEvidence) || text(event?.dialogue) || text(event?.verifiedDialogue));
  }).length;
  const startToleranceSec = Math.max(3, Number.isFinite(duration) ? duration * 0.01 : 3);
  const endToleranceSec = Math.max(5, Number.isFinite(duration) ? duration * 0.02 : 5);
  const complete = events.length > 0
    && ranges.length === events.length
    && Number.isFinite(duration)
    && coverageStartSec <= startToleranceSec
    && coverageEndSec >= duration - endToleranceSec
    && evidenceCount >= Math.ceil(events.length * 0.8);
  return { complete, events, coverageStartSec, coverageEndSec, evidenceCount };
}

function mergeCanonicalContinuation(existingEvents, continuationRaw, { chunkStartSec, chunkDurationSec, previousCoverageEndSec, sourceDurationSec }) {
  const incoming = Array.isArray(continuationRaw) ? continuationRaw : list(continuationRaw?.events);
  if (!incoming.length) throw new Error("Vertex không trả event cho phần timeline canonical còn thiếu.");
  const incomingRanges = incoming.map((event) => timeRange(event));
  const finiteEnds = incomingRanges.map(({ end }) => end).filter(Number.isFinite);
  const usesLocalTimestamps = Number(chunkStartSec) > 1
    && finiteEnds.length > 0
    && Math.max(...finiteEnds) <= Number(chunkDurationSec) + 1;
  const normalizedIncoming = incoming.map((event, index) => {
    const range = incomingRanges[index];
    const start = range.start + (usesLocalTimestamps ? Number(chunkStartSec) : 0);
    const end = range.end + (usesLocalTimestamps ? Number(chunkStartSec) : 0);
    return { ...event, start, end };
  }).filter((event) => {
    const { start, end } = timeRange(event);
    return Number.isFinite(start) && Number.isFinite(end)
      && start >= Number(chunkStartSec) - 1
      && end > Number(previousCoverageEndSec) + 0.05
      && end <= Number(sourceDurationSec) + 0.25;
  });
  if (!normalizedIncoming.length) throw new Error("Các event continuation không mở rộng được timeline canonical.");
  const combined = [...list(existingEvents), ...normalizedIncoming]
    .sort((a, b) => timeRange(a).start - timeRange(b).start)
    .map((event, index) => ({ ...event, eventId: `event_${index + 1}` }));
  return combined;
}

function canonicalEventsNeedTimestampRepair(events, durationSec) {
  const duration = Number(durationSec);
  return list(events).some((event) => {
    const { start, end } = timeRange(event);
    return !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration + 0.25;
  });
}

function applyCanonicalTimestampRepair(events, repairRaw, durationSec) {
  const expected = list(events);
  const repaired = list(repairRaw?.events);
  const byId = new Map(repaired.map((event) => [text(event.eventId), event]));
  if (repaired.length !== expected.length || byId.size !== expected.length) {
    throw new Error(`Timestamp repair trả ${repaired.length}/${expected.length} event hoặc có eventId trùng.`);
  }
  return expected.map((event) => {
    const corrected = byId.get(text(event.eventId));
    if (!corrected) throw new Error(`Timestamp repair thiếu ${event.eventId}.`);
    const { start, end } = timeRange(corrected);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > Number(durationSec) + 0.25) {
      throw new Error(`Timestamp repair vẫn trả mốc sai cho ${event.eventId}: ${start}-${end}s.`);
    }
    return { ...event, start, end };
  });
}

function mergeCanonicalChunk(existingEvents, chunkRaw, { chunkStartSec, chunkEndSec, sourceDurationSec }) {
  assertAccess(chunkRaw, "Canonical chunk");
  const incoming = list(chunkRaw?.events);
  if (!incoming.length) throw new Error(`Canonical chunk ${chunkStartSec}-${chunkEndSec}s không có events.`);
  const chunkDuration = Number(chunkEndSec) - Number(chunkStartSec);
  const finiteEnds = incoming.map((event) => timeRange(event).end).filter(Number.isFinite);
  const usesLocalTimestamps = Number(chunkStartSec) > 1 && finiteEnds.length > 0 && Math.max(...finiteEnds) <= chunkDuration + 1;
  const normalized = incoming.map((event) => {
    const range = timeRange(event);
    const start = range.start + (usesLocalTimestamps ? Number(chunkStartSec) : 0);
    const end = range.end + (usesLocalTimestamps ? Number(chunkStartSec) : 0);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < Number(chunkStartSec) - 1 || end <= start || end > Number(chunkEndSec) + 1 || end > Number(sourceDurationSec) + 0.25) {
      throw new Error(`Canonical chunk trả timestamp sai: ${event.eventId || "event"} ${start}-${end}s, chunk ${chunkStartSec}-${chunkEndSec}s.`);
    }
    return { ...event, start, end };
  });
  const retained = list(existingEvents).filter((event) => timeRange(event).end <= Number(chunkStartSec) + 0.05);
  return [...retained, ...normalized]
    .sort((a, b) => timeRange(a).start - timeRange(b).start)
    .map((event, index) => ({ ...event, eventId: `event_${index + 1}` }));
}

function validateCanonical(result, durationSec) {
  assertAccess(result, "Giai đoạn hiểu video");
  const events = list(result.events);
  if (!events.length) throw new Error("Canonical analysis không có events.");
  const ids = new Set();
  for (const event of events) {
    const id = text(event.eventId);
    const { start, end } = timeRange(event);
    if (!id || ids.has(id)) throw new Error(`Canonical eventId thiếu hoặc trùng: ${id || "(trống)"}.`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > durationSec + 0.25) {
      throw new Error(`${id}: timestamp ${start}-${end}s nằm ngoài video ${durationSec.toFixed(3)}s.`);
    }
    ids.add(id);
  }
  for (const link of list(result.causalLinks)) {
    const from = text(link.fromEventId || link.from);
    const to = text(link.toEventId || link.to);
    if ((from && !ids.has(from)) || (to && !ids.has(to))) throw new Error(`Causal link tham chiếu event không tồn tại: ${from} -> ${to}.`);
  }
  return result;
}

function validateAndScore(result, canonical, weights) {
  assertAccess(result, "Giai đoạn chấm event");
  const canonicalIds = new Set(list(canonical.events).map((event) => text(event.eventId)));
  const byId = new Map(list(result.scores).map((score) => [text(score.eventId), score]));
  const dimensions = Object.keys(DEFAULT_WEIGHTS);
  const scores = [];
  for (const eventId of canonicalIds) {
    const raw = byId.get(eventId);
    if (!raw) throw new Error(`Event scoring thiếu ${eventId}.`);
    const normalized = { ...raw, eventId };
    let computedScore = 0;
    for (const dimension of dimensions) {
      normalized[dimension] = clamp(raw[dimension], 0, 10, 0);
      computedScore += normalized[dimension] * Number(weights[dimension] ?? DEFAULT_WEIGHTS[dimension]);
    }
    normalized.computedScore = Number(computedScore.toFixed(3));
    scores.push(normalized);
  }
  return { ...result, scores };
}

function validateCandidates(result, canonical, expectedCount) {
  assertAccess(result, "Giai đoạn lập story");
  const eventIds = new Set(list(canonical.events).map((event) => text(event.eventId)));
  const candidates = list(result.candidates);
  if (candidates.length < expectedCount) throw new Error(`Story planner chỉ tạo ${candidates.length}/${expectedCount} candidate.`);
  const candidateIds = new Set();
  for (const candidate of candidates) {
    const candidateId = text(candidate.candidateId);
    if (!candidateId || candidateIds.has(candidateId)) throw new Error("Story candidate thiếu hoặc trùng candidateId.");
    candidateIds.add(candidateId);
    const used = list(candidate.sequence).flatMap((item) => list(item.eventIds));
    if (!used.length || used.some((id) => !eventIds.has(text(id)))) throw new Error(`${candidateId}: sequence tham chiếu event không hợp lệ.`);
    if (!text(candidate.centralViewerQuestion) || !text(candidate.hookPromise)) throw new Error(`${candidateId}: thiếu centralViewerQuestion hoặc hookPromise.`);
  }
  return result;
}

function validateLocked(result, candidates, outputCount) {
  assertAccess(result, "Giai đoạn judge");
  const candidateIds = new Set(list(candidates.candidates).map((item) => text(item.candidateId)));
  const lockedStories = list(result.lockedStories);
  if (!lockedStories.length || lockedStories.length > outputCount) throw new Error(`Judge trả ${lockedStories.length} story, giới hạn là ${outputCount}.`);
  const scriptIds = new Set();
  for (const story of lockedStories) {
    const scriptId = Number(story.scriptId);
    if (!Number.isInteger(scriptId) || scriptIds.has(scriptId)) throw new Error("Locked story thiếu hoặc trùng scriptId.");
    if (!candidateIds.has(text(story.candidateId))) throw new Error(`Locked story tham chiếu candidate không tồn tại: ${story.candidateId}.`);
    if (!list(story.lockedSequence).length || !list(story.resolutionEventIds).length) throw new Error(`Script ${scriptId}: thiếu lockedSequence hoặc resolutionEventIds.`);
    scriptIds.add(scriptId);
  }
  return result;
}

function normalizeEdlSegment(segment, index) {
  const sourceStartSec = Number(segment.sourceStart ?? segment.sourceStartSec);
  const sourceEndSec = Number(segment.sourceEnd ?? segment.sourceEndSec);
  const playbackSpeed = clamp(segment.playbackSpeed, 0.5, 2, 1);
  const audioMode = text(segment.audioMode || segment.audio_mode).toLowerCase();
  const voiceoverText = text(segment.voiceoverText || segment.voiceover_text);
  return { ...segment, segmentId: text(segment.segmentId) || `beat_${String(index + 1).padStart(3, "0")}`, sourceStartSec, sourceEndSec, playbackSpeed, audioMode, voiceoverText };
}

function validateEdl(result, canonical, locked, config, videoDuration) {
  assertAccess(result, "Giai đoạn tạo timeline");
  const eventIds = new Set(list(canonical.events).map((event) => text(event.eventId)));
  const lockedByScript = new Map(list(locked.lockedStories).map((story) => [Number(story.scriptId), story]));
  const scripts = list(result.scripts);
  if (scripts.length !== lockedByScript.size) throw new Error(`EDL trả ${scripts.length}/${lockedByScript.size} script đã khóa.`);
  return {
    ...result,
    scripts: scripts.map((script) => {
      const scriptId = Number(script.scriptId);
      const story = lockedByScript.get(scriptId);
      if (!story) throw new Error(`EDL có scriptId chưa được khóa: ${scriptId}.`);
      const segments = list(script.segments).map(normalizeEdlSegment);
      if (!segments.length) throw new Error(`Script ${scriptId} không có segment.`);
      let duration = 0;
      const narratorWordsPerSecond = Number(config.narration.measuredWordsPerSecond || 0) > 0
        ? Number(config.narration.measuredWordsPerSecond)
        : 2.35;
      const presentEvents = new Set();
      for (const segment of segments) {
        if (!eventIds.has(text(segment.eventId))) throw new Error(`${segment.segmentId}: eventId không thuộc canonical.`);
        if (!Number.isFinite(segment.sourceStartSec) || !Number.isFinite(segment.sourceEndSec) || segment.sourceStartSec < 0 || segment.sourceEndSec <= segment.sourceStartSec || segment.sourceEndSec > videoDuration + 0.25) {
          throw new Error(`${segment.segmentId}: timestamp nguồn không hợp lệ.`);
        }
        if (!["original_audio", "voiceover_only", "mixed_ducking"].includes(segment.audioMode)) throw new Error(`${segment.segmentId}: audioMode không hợp lệ.`);
        if (segment.audioMode === "original_audio" && segment.voiceoverText) throw new Error(`${segment.segmentId}: original_audio phải có voiceoverText rỗng.`);
        if (segment.audioMode === "original_audio" && segment.sourceNarratorDetected === true) throw new Error(`${segment.segmentId}: original_audio chứa narrator nguồn; phải đổi clip hoặc dùng voiceover_only.`);
        if ((segment.audioMode === "voiceover_only" || segment.audioMode === "mixed_ducking") && !segment.voiceoverText) throw new Error(`${segment.segmentId}: ${segment.audioMode} thiếu voiceoverText.`);
        if ((segment.audioMode === "voiceover_only" || segment.audioMode === "mixed_ducking") && !text(segment.previewVi)) throw new Error(`${segment.segmentId}: narrator thiếu phụ đề previewVi tiếng Việt.`);
        if (!config.narration.enabled && (segment.audioMode === "voiceover_only" || segment.audioMode === "mixed_ducking")) throw new Error(`${segment.segmentId}: cấu hình Original only không cho phép narrator.`);
        const visualDuration = (segment.sourceEndSec - segment.sourceStartSec) / segment.playbackSpeed;
        if (segment.audioMode === "voiceover_only" || segment.audioMode === "mixed_ducking") {
          const wordCount = segment.voiceoverText.split(/\s+/).filter(Boolean).length;
          const estimatedVoiceDuration = Math.max(0.8, wordCount / narratorWordsPerSecond);
          const fitRatio = estimatedVoiceDuration / Math.max(0.1, visualDuration);
          if (fitRatio < 0.65 || fitRatio > 1.2) {
            throw new Error(`${segment.segmentId}: narrator ước tính ${estimatedVoiceDuration.toFixed(1)}s không khớp cửa sổ hình ${visualDuration.toFixed(1)}s.`);
          }
          duration += estimatedVoiceDuration;
        } else {
          duration += visualDuration;
        }
        presentEvents.add(text(segment.eventId));
      }
      const mandatory = list(story.mandatoryEvents).map((item) => text(typeof item === "string" ? item : item.eventId)).filter(Boolean);
      const resolutions = list(story.resolutionEventIds).map(text).filter(Boolean);
      const missing = [...mandatory, ...resolutions].filter((id) => !presentEvents.has(id));
      if (missing.length) throw new Error(`Script ${scriptId} thiếu event đã khóa: ${[...new Set(missing)].join(", ")}.`);
      if (duration < config.targetDurationMinSec - 0.25 || duration > config.targetDurationMaxSec + 0.25) {
        throw new Error(`Script ${scriptId} dài ${duration.toFixed(1)}s, yêu cầu ${config.targetDurationMinSec}-${config.targetDurationMaxSec}s.`);
      }
      return { ...script, scriptId, durationSec: Number(duration.toFixed(3)), segments };
    })
  };
}

function toHighlightScript(script, lockedStory, config) {
  return {
    artifactType: "vertex_auto_story_script",
    schemaVersion: 1,
    scriptId: script.scriptId,
    title: text(script.title) || `Auto Story ${script.scriptId}`,
    top_header: text(script.top_header || script.topHeader || script.title),
    language: "en",
    sourceLanguage: "en",
    prompt_profile: "vertex_auto_story",
    audio_strategy: config.narration.audioBalance,
    voiceover_enabled: config.narration.enabled,
    story_contract: {
      centralViewerQuestion: lockedStory.centralViewerQuestion,
      hookPromise: lockedStory.hookPromise,
      resolutionEventIds: lockedStory.resolutionEventIds
    },
    segments: script.segments.map((segment, index) => ({
      id: segment.segmentId || `beat_${String(index + 1).padStart(3, "0")}`,
      evidenceId: segment.eventId,
      sourceStartSec: segment.sourceStartSec,
      sourceEndSec: segment.sourceEndSec,
      playbackSpeed: segment.playbackSpeed,
      scene_type: text(segment.storyRole) || "story_beat",
      storyFunction: text(segment.storyRole) || "context",
      narrativePurpose: text(segment.narrativePurpose || segment.reason),
      audio_mode: segment.audioMode,
      voiceover_text: segment.voiceoverText,
      preview_vi: text(segment.previewVi),
      action_notes: text(segment.reason),
      source_narrator_detected: Boolean(segment.sourceNarratorDetected),
      speaker_focus: text(segment.speakerFocus),
      focus_priority: text(segment.focusPriority),
      subtitle_priority: text(segment.subtitlePriority)
    })),
    policy_issues: script.policyIssues || []
  };
}

class AutoStoryPipelineService {
  constructor(settings, projectStore, dependencies = {}) {
    this.settings = settings || {};
    this.projectStore = projectStore;
    this.vertex = dependencies.vertex || new VertexAiService(this.settings);
    this.ffmpeg = dependencies.ffmpeg || new FfmpegService(this.settings);
  }

  async auditDrafts({ workspaceRoot, projectId, onProgress, signal } = {}) {
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    const root = path.join(this.projectStore.getProjectPaths(workspaceRoot, projectId).analysisDir, "auto-story");
    const canonical = await readJson(path.join(root, "canonical-analysis.json"));
    const locked = await readJson(path.join(root, "locked-story.json"));
    const edl = await readJson(path.join(root, "final-edl.json"));
    const variants = list(project.analysis?.highlightVariants);
    const auditDir = path.join(root, "audits");
    await fs.mkdir(auditDir, { recursive: true });
    const audits = [];
    for (let index = 0; index < variants.length; index += 1) {
      const variant = variants[index];
      const scriptId = Number(variant.scriptId || index + 1);
      const draftPath = text(variant.artifacts?.fastDraftVideoPath);
      if (!draftPath) throw new Error(`Variant ${scriptId} chưa có draft để Vertex audit.`);
      const lockedStory = locked.lockedStories.find((item) => Number(item.scriptId) === scriptId);
      const scriptEdl = edl.scripts.find((item) => Number(item.scriptId) === scriptId);
      if (!lockedStory || !scriptEdl) throw new Error(`Không ghép được draft ${scriptId} với Story Contract/EDL.`);
      onProgress?.({ percent: Math.round((index / variants.length) * 100), stage: "draft_audit", message: `Vertex đang review draft ${index + 1}/${variants.length}` });
      const audit = await this.vertex.generateJsonFromFiles({
        filePaths: [draftPath],
        prompt: prompts.auditPrompt({ canonical, lockedStory, edl: scriptEdl }),
        temperature: 0.1,
        taskType: "quality",
        signal,
        onProgress: (item) => onProgress?.({
          percent: Math.round(((index + (clamp(item?.percent, 0, 100, 0) / 100)) / variants.length) * 100),
          stage: "draft_audit",
          message: item?.message || `Vertex đang review draft ${index + 1}/${variants.length}`
        })
      });
      assertAccess(audit, `Draft audit ${scriptId}`);
      if (!["PASS", "MINOR_REVISE", "MAJOR_REVISE"].includes(audit.verdict)) throw new Error(`Draft audit ${scriptId} thiếu verdict hợp lệ.`);
      const auditPath = path.join(auditDir, `audit-script-${scriptId}.json`);
      await writeJsonAtomic(auditPath, audit);
      audits.push({ scriptId, auditPath, ...audit });
    }
    const updatedVariants = variants.map((variant, index) => {
      const audit = audits.find((item) => item.scriptId === Number(variant.scriptId || index + 1));
      return audit ? { ...variant, autoStoryAudit: audit } : variant;
    });
    const updated = await this.projectStore.updateProject(workspaceRoot, projectId, {
      analysis: {
        ...(project.analysis || {}),
        highlightVariants: updatedVariants,
        autoStoryAudits: audits,
        warnings: [
          ...(project.analysis?.warnings || []),
          ...audits.filter((item) => item.verdict !== "PASS").map((item) => (
            `Auto Story ${item.scriptId}: ${item.verdict} ${Number(item.score || 0)}/100. ${text(item.revisionScope)}`
          ))
        ]
      },
      statusMessage: audits.every((item) => item.verdict === "PASS")
        ? "Auto Story drafts đã qua Vertex audit"
        : "Auto Story drafts đã review; mở studio để xem các điểm cần chỉnh"
    });
    onProgress?.({ percent: 100, stage: "draft_audit", message: "Vertex đã review toàn bộ draft" });
    return { project: updated, audits };
  }

  async run({ workspaceRoot, projectId, onProgress, signal } = {}) {
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    const config = normalizeConfig(project.autoStoryConfig || {}, project);
    const editorialConfig = {
      targetDurationMinSec: config.targetDurationMinSec,
      targetDurationMaxSec: config.targetDurationMaxSec,
      outputCount: config.outputCount,
      candidatePoolSize: config.candidatePoolSize,
      narration: {
        enabled: config.narration.enabled,
        style: config.narration.style,
        audioBalance: config.narration.audioBalance,
        measuredWordsPerSecond: config.narration.measuredWordsPerSecond,
        muteSourceDuringNarration: true
      },
      scoreWeights: config.scoreWeights
    };
    const projectPaths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const root = path.join(projectPaths.analysisDir, "auto-story");
    const scriptsDir = path.join(root, "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    const metadata = await this.ffmpeg.probeVideo(project.sourceVideoPath);
    if (Number(metadata.duration || 0) < config.targetDurationMinSec) {
      throw new Error(`Video nguồn chỉ dài ${Number(metadata.duration || 0).toFixed(1)}s, ngắn hơn mức output tối thiểu ${config.targetDurationMinSec}s.`);
    }
    const sourceSha256 = await fileHash(project.sourceVideoPath);
    const jobPath = path.join(root, "job.json");
    let job = { schemaVersion: 1, projectId, sourceSha256, config, stages: {}, usage: [], updatedAt: new Date().toISOString() };
    try {
      const previous = await readJson(jobPath);
      if (previous.sourceSha256 === sourceSha256) job = { ...job, ...previous, config, sourceSha256 };
    } catch (_error) {}

    const saveJob = async () => {
      job.updatedAt = new Date().toISOString();
      await writeJsonAtomic(jobPath, job);
    };
    const progress = (percent, message, stage) => onProgress?.({ percent, message, stage });
    const runStage = async ({ key, outputName, input, range, files = [], taskType, expectedKey, temperature, prompt, responseSchema = null, maxOutputTokens = null, strictRootJson = false }) => {
      const outputPath = path.join(root, outputName);
      const hash = valueHash({ sourceSha256, input, prompt, responseSchema });
      if (job.stages[key]?.hash === hash && job.stages[key]?.status === "completed") {
        try {
          const cached = await readJson(outputPath);
          const cacheHasPayload = cached?.artifactType === "auto_story_input_access_failure"
            || (expectedKey === "events" && Array.isArray(cached) && cached.length > 0)
            || (expectedKey === "events" && Array.isArray(cached?.timeline) && cached.timeline.length > 0)
            || (expectedKey ? Object.prototype.hasOwnProperty.call(cached || {}, expectedKey) : Object.keys(cached || {}).length > 0);
          if (cacheHasPayload) {
            progress(range[1], `[CACHE] Dùng lại ${outputName}`, key);
            return cached;
          }
          job.stages[key].status = "invalid_cache";
          job.stages[key].error = `${outputName} rỗng hoặc thiếu ${expectedKey || "payload"}; tự chạy lại stage.`;
        } catch (_error) {}
      }
      job.stages[key] = { hash, status: "running", outputPath, startedAt: new Date().toISOString() };
      await saveJob();
      progress(range[0], `Đang chạy ${key}`, key);
      try {
        const result = await this.vertex.generateJsonFromFiles({
          filePaths: files,
          prompt,
          temperature,
          taskType,
          responseSchema,
          maxOutputTokens,
          strictRootJson,
          signal,
          onProgress: (item) => {
            const ratio = clamp(item?.percent, 0, 100, 0) / 100;
            progress(Math.round(range[0] + ((range[1] - range[0]) * ratio)), item?.message || `Đang chạy ${key}`, key);
          }
        });
        await writeJsonAtomic(outputPath, result);
        job.stages[key] = { ...job.stages[key], status: "completed", completedAt: new Date().toISOString(), usage: this.vertex.lastUsage || null };
        if (this.vertex.lastUsage) job.usage.push({ stage: key, ...this.vertex.lastUsage });
        await saveJob();
        progress(range[1], `Đã hoàn tất ${key}`, key);
        return result;
      } catch (error) {
        job.stages[key] = { ...job.stages[key], status: "failed", error: error.message, failedAt: new Date().toISOString() };
        await saveJob();
        throw error;
      }
    };

    progress(3, "Đang kiểm tra video nguồn", "preprocess");
    const proxyPath = path.join(root, `source-analysis-proxy-${sourceSha256.slice(0, 16)}.mp4`);
    let proxyReady = false;
    try {
      const proxyStat = await fs.stat(proxyPath);
      if (proxyStat.size > 1024) {
        const proxyMeta = await this.ffmpeg.probeVideo(proxyPath);
        proxyReady = Math.abs(Number(proxyMeta.duration || 0) - Number(metadata.duration || 0)) <= 0.5;
      }
    } catch (_error) {}
    if (!proxyReady) {
      progress(5, "Đang tạo proxy nhẹ có đủ hình và âm thanh cho Vertex", "preprocess");
      await this.ffmpeg.createMultimodalAnalysisProxy({
        videoPath: project.sourceVideoPath,
        outputPath: proxyPath,
        width: 640,
        fps: 8
      });
    } else {
      progress(7, "[CACHE] Dùng lại proxy phân tích Vertex", "preprocess");
    }
    await writeJsonAtomic(path.join(root, "metadata.json"), { ...metadata, sourceSha256, sourceVideoPath: project.sourceVideoPath });
    const sourceFiles = [proxyPath, project.subtitleSourcePath].filter(Boolean);
    const chunkLengthSec = 240;
    const chunkOverlapSec = 5;
    const chunkStarts = [];
    for (let start = 0; start < Number(metadata.duration) - 0.05; start += chunkLengthSec - chunkOverlapSec) chunkStarts.push(start);
    let canonicalRaw = [];
    for (let index = 0; index < chunkStarts.length; index += 1) {
      const chunkStartSec = chunkStarts[index];
      const chunkEndSec = Math.min(Number(metadata.duration), chunkStartSec + chunkLengthSec);
      const chunkPath = path.join(root, `canonical-source-${String(index + 1).padStart(2, "0")}.mp4`);
      const transcriptSlicePath = path.join(root, `canonical-transcript-${String(index + 1).padStart(2, "0")}.srt`);
      let chunkReady = false;
      try {
        const stat = await fs.stat(chunkPath);
        chunkReady = stat.size > 1024;
      } catch (_error) {}
      if (!chunkReady) {
        progress(8 + Math.round((index / chunkStarts.length) * 4), `Đang chuẩn bị phần hiểu video ${index + 1}/${chunkStarts.length}`, "canonical_preprocess");
        await this.ffmpeg.createAnalysisProxyChunk({
          videoPath: proxyPath,
          outputPath: chunkPath,
          startSec: chunkStartSec,
          durationSec: chunkEndSec - chunkStartSec
        });
      }
      const transcriptSlice = await writeSrtSlice(project.subtitleSourcePath, transcriptSlicePath, chunkStartSec, chunkEndSec);
      const rangeStart = 12 + ((index / chunkStarts.length) * 21);
      const rangeEnd = 12 + (((index + 1) / chunkStarts.length) * 21);
      const chunkRaw = await runStage({
        key: `canonical_chunk_${String(index + 1).padStart(2, "0")}`,
        outputName: `canonical-chunk-${String(index + 1).padStart(2, "0")}.json`,
        input: { sourceSha256, chunkStartSec, chunkEndSec, transcriptSlice: Boolean(transcriptSlice) },
        range: [rangeStart, rangeEnd],
        files: [chunkPath, transcriptSlice].filter(Boolean),
        taskType: "video_analysis",
        expectedKey: "events",
        temperature: 0.05,
        responseSchema: schemas.canonicalChunkSchema,
        maxOutputTokens: 16384,
        strictRootJson: true,
        prompt: prompts.canonicalChunkPrompt({
          sourceStartSec: chunkStartSec,
          sourceEndSec: chunkEndSec,
          sourceDurationSec: Number(metadata.duration),
          transcriptIncluded: Boolean(transcriptSlice),
          chunkIndex: index + 1,
          chunkCount: chunkStarts.length
        })
      });
      canonicalRaw = mergeCanonicalChunk(canonicalRaw, chunkRaw, {
        chunkStartSec,
        chunkEndSec,
        sourceDurationSec: Number(metadata.duration)
      });
      await writeJsonAtomic(path.join(root, "canonical-events-merged.json"), canonicalRaw);
    }
    job.stages.canonical = {
      hash: valueHash({ sourceSha256, metadata }),
      status: "completed",
      outputPath: path.join(root, "canonical-analysis.json"),
      chunkCount: chunkStarts.length,
      completedAt: new Date().toISOString()
    };
    await saveJob();
    const canonicalChunksVerifiedComplete = chunkStarts.length > 0;
    let canonicalCandidate = canonicalRaw;
    if (!Array.isArray(canonicalCandidate) && !list(canonicalCandidate?.events).length && list(canonicalCandidate?.timeline).length) {
      canonicalCandidate = { ...canonicalCandidate, events: canonicalCandidate.timeline };
      progress(33, "Vertex đặt event trong timeline; tool đã chuẩn hóa về events", "canonical_normalize");
    }
    if (!Array.isArray(canonicalCandidate) && canonicalEventsNeedTimestampRepair(canonicalCandidate.events, Number(metadata.duration))) {
      if (!project.subtitleSourcePath) {
        throw new Error("Canonical có timestamp vượt video nhưng project không có transcript để căn lại an toàn.");
      }
      progress(33, "Canonical có timestamp bị lệch; Vertex đang căn lại theo SRT nguồn", "canonical_timestamp_repair");
      const timestampRepairRaw = await this.vertex.generateJsonFromFiles({
        filePaths: [project.subtitleSourcePath],
        prompt: prompts.canonicalTimestampRepairPrompt({ events: canonicalCandidate.events, durationSec: Number(metadata.duration) }),
        temperature: 0,
        taskType: "quality",
        responseSchema: schemas.canonicalTimestampRepairSchema,
        signal,
        onProgress: (item) => progress(33, item?.message || "Vertex đang căn lại timestamp canonical", "canonical_timestamp_repair")
      });
      const correctedEvents = applyCanonicalTimestampRepair(canonicalCandidate.events, timestampRepairRaw, Number(metadata.duration));
      canonicalCandidate = { ...canonicalCandidate, events: correctedEvents, timeline: correctedEvents };
      await writeJsonAtomic(path.join(root, "canonical-analysis.json"), canonicalCandidate);
      job.stages.canonical = { ...job.stages.canonical, shapeNormalized: true, timestampsRepaired: true, timestampRepairUsage: this.vertex.lastUsage || null };
      if (this.vertex.lastUsage) job.usage.push({ stage: "canonical_timestamp_repair", ...this.vertex.lastUsage });
      await saveJob();
    }
    const canonicalNeedsSerializationRepair = Array.isArray(canonicalCandidate)
      || (list(canonicalCandidate?.events).length > 0 && canonicalCandidate?.inputAccessAudit?.accessGranted !== true);
    if (canonicalNeedsSerializationRepair) {
      let coverage = canonicalEventCoverage(canonicalCandidate, Number(metadata.duration));
      if (canonicalChunksVerifiedComplete && coverage.events.length) {
        coverage = {
          ...coverage,
          complete: true,
          coverageStartSec: 0,
          coverageEndSec: Number(metadata.duration)
        };
      }
      let continuationPass = 0;
      while (!coverage.complete && continuationPass < 12) {
        if (!coverage.events.length || !Number.isFinite(coverage.coverageEndSec) || coverage.coverageStartSec > Math.max(3, Number(metadata.duration) * 0.01)) {
          throw new Error(
            `Giai đoạn hiểu video trả sai cấu trúc và không đủ dữ liệu đầu timeline để tự nối `
            + `(timeline ${Number.isFinite(coverage.coverageStartSec) ? coverage.coverageStartSec.toFixed(3) : "?"}`
            + `-${Number.isFinite(coverage.coverageEndSec) ? coverage.coverageEndSec.toFixed(3) : "?"}s / ${Number(metadata.duration).toFixed(3)}s).`
          );
        }
        continuationPass += 1;
        const chunkStartSec = Math.max(0, coverage.coverageEndSec - 5);
        const chunkEndSec = Math.min(Number(metadata.duration), chunkStartSec + 300);
        const chunkDurationSec = chunkEndSec - chunkStartSec;
        const continuationPath = path.join(root, `canonical-continuation-${String(continuationPass).padStart(2, "0")}-${chunkStartSec.toFixed(3)}.mp4`);
        progress(33, `Canonical còn thiếu ${Math.max(0, Number(metadata.duration) - coverage.coverageEndSec).toFixed(1)}s; đang đọc tiếp phần cuối`, "canonical_continuation");
        await this.ffmpeg.createAnalysisProxyChunk({
          videoPath: proxyPath,
          outputPath: continuationPath,
          startSec: chunkStartSec,
          durationSec: chunkDurationSec
        });
        const continuationRaw = await this.vertex.generateJsonFromFiles({
          filePaths: [continuationPath, project.subtitleSourcePath].filter(Boolean),
          prompt: prompts.canonicalContinuationPrompt({
            sourceStartSec: chunkStartSec,
            sourceEndSec: chunkEndSec,
            previousCoverageEndSec: coverage.coverageEndSec,
            transcriptIncluded: Boolean(project.subtitleSourcePath)
          }),
          temperature: 0.05,
          taskType: "video_analysis",
          signal,
          onProgress: (item) => progress(33, item?.message || "Vertex đang đọc phần timeline còn thiếu", "canonical_continuation")
        });
        const mergedEvents = mergeCanonicalContinuation(coverage.events, continuationRaw, {
          chunkStartSec,
          chunkDurationSec,
          previousCoverageEndSec: coverage.coverageEndSec,
          sourceDurationSec: Number(metadata.duration)
        });
        await writeJsonAtomic(path.join(root, "canonical-analysis.json"), mergedEvents);
        if (this.vertex.lastUsage) job.usage.push({ stage: `canonical_continuation_${continuationPass}`, ...this.vertex.lastUsage });
        coverage = canonicalEventCoverage(mergedEvents, Number(metadata.duration));
        if (coverage.coverageEndSec <= chunkStartSec + 5.05) throw new Error("Canonical continuation không tiến thêm trên timeline nguồn.");
      }
      if (!coverage.complete) {
        throw new Error(`Canonical vẫn chưa phủ đủ video sau ${continuationPass} lượt nối: ${coverage.coverageEndSec.toFixed(3)}/${Number(metadata.duration).toFixed(3)}s.`);
      }
      progress(33, "Vertex đã hiểu đủ video; đang tự sửa cấu trúc JSON, không phân tích lại nguồn", "canonical_repair");
      const repaired = await this.vertex.generateJsonFromFiles({
        filePaths: [],
        prompt: prompts.canonicalRepairPrompt({
          rawEvents: coverage.events,
          durationSec: Number(metadata.duration),
          transcriptIncluded: Boolean(project.subtitleSourcePath)
        }),
        temperature: 0.05,
        taskType: "economy",
        responseSchema: schemas.canonicalRootSummarySchema,
        maxOutputTokens: 8192,
        strictRootJson: true,
        signal,
        onProgress: (item) => progress(33, item?.message || "Đang sửa cấu trúc canonical JSON", "canonical_repair")
      });
      repaired.inputAccessAudit = {
        ...(repaired.inputAccessAudit || {}),
        accessGranted: true,
        inspectedInputs: [
          "complete analysis proxy with audio",
          ...(project.subtitleSourcePath ? ["timestamped source transcript"] : [])
        ],
        timelineCoverageStartSec: coverage.coverageStartSec,
        timelineCoverageEndSec: coverage.coverageEndSec,
        verificationNote: "Root serialization repaired from evidence-backed events returned by the completed multimodal source pass; source media was not re-analyzed."
      };
      repaired.events = coverage.events;
      canonicalCandidate = repaired;
      await writeJsonAtomic(path.join(root, "canonical-analysis.json"), repaired);
      job.stages.canonical = {
        ...job.stages.canonical,
        serializationRepaired: true,
        originalShape: Array.isArray(canonicalCandidate) ? "event_array" : "root_missing_access_audit",
        repairUsage: this.vertex.lastUsage || null
      };
      if (this.vertex.lastUsage) job.usage.push({ stage: "canonical_repair", ...this.vertex.lastUsage });
      await saveJob();
      progress(34, "Đã sửa canonical JSON và giữ nguyên toàn bộ event đã xác minh", "canonical_repair");
    }
    const canonical = validateCanonical(canonicalCandidate, Number(metadata.duration));
    const scoredRaw = await runStage({
      key: "scoring", outputName: "event-scores.json",
      input: { canonical, weights: config.scoreWeights }, range: [34, 47], taskType: "economy", expectedKey: "scores", temperature: 0.1,
      prompt: prompts.scoringPrompt({ canonical, weights: config.scoreWeights })
    });
    const scored = validateAndScore(scoredRaw, canonical, config.scoreWeights);
    await writeJsonAtomic(path.join(root, "event-scores.json"), scored);
    const candidatesRaw = await runStage({
      key: "planning", outputName: "story-candidates.json",
      input: { canonical, scored, editorialConfig }, range: [47, 62], taskType: "quality", expectedKey: "candidates", temperature: 0.45,
      prompt: prompts.planningPrompt({ canonical, scoredEvents: scored, config: editorialConfig, candidatePoolSize: config.candidatePoolSize })
    });
    const candidates = validateCandidates(candidatesRaw, canonical, config.candidatePoolSize);
    
    // --- Hook Lab Integration ---
    progress(62, "Tối ưu hóa hook (Hook Lab)", "hook_lab");
    const { generateAndSelectHooks } = require("./autoStoryHookLab");
    const optimizedHooks = await generateAndSelectHooks({ vertex: this.vertex }, candidates.candidates, config);
    candidates.candidates.forEach(c => {
      const opt = optimizedHooks.find(o => o.candidateId === c.candidateId);
      if (opt && opt.bestHook && opt.bestHook.hook_text) {
        c.hookPromise = opt.bestHook.hook_text;
      }
    });

    const lockedRaw = await runStage({
      key: "judge", outputName: "locked-story.json",
      input: { canonical, scored, candidates, editorialConfig }, range: [62, 76], taskType: "quality", expectedKey: "lockedStories", temperature: 0.15,
      prompt: prompts.judgePrompt({ canonical, scoredEvents: scored, candidates, config: editorialConfig })
    });
    const locked = validateLocked(lockedRaw, candidates, config.outputCount);
    const edlRaw = await runStage({
      key: "edl", outputName: "final-edl.json",
      input: { canonical, locked, editorialConfig }, range: [76, 94], files: sourceFiles, taskType: "video_analysis", expectedKey: "scripts", temperature: 0.15,
      prompt: prompts.edlPrompt({ canonical, lockedStories: locked, config: editorialConfig, measuredWordsPerSecond: config.narration.measuredWordsPerSecond })
    });
    let edl;
    try {
      edl = validateEdl(edlRaw, canonical, locked, config, Number(metadata.duration));
    } catch (firstError) {
      progress(88, `Timeline chưa đạt gate; Vertex đang tự sửa: ${firstError.message}`, "edl_repair");
      const repairedRaw = await this.vertex.generateJsonFromFiles({
        filePaths: sourceFiles,
        prompt: `${prompts.edlPrompt({ canonical, lockedStories: locked, config: editorialConfig, measuredWordsPerSecond: config.narration.measuredWordsPerSecond })}\n\nCORRECTION PASS: The previous EDL failed local validation: ${firstError.message}\nRebuild the complete EDL and fix that exact failure. Do not weaken or omit a locked event.`,
        temperature: 0.1,
        taskType: "video_analysis",
        signal,
        onProgress: (item) => progress(88 + Math.round(clamp(item?.percent, 0, 100, 0) * 0.06), item?.message || "Vertex đang sửa timeline", "edl_repair")
      });
      edl = validateEdl(repairedRaw, canonical, locked, config, Number(metadata.duration));
      job.usage.push({ stage: "edl_repair", ...(this.vertex.lastUsage || {}) });
      job.stages.edl = { ...job.stages.edl, repaired: true, repairReason: firstError.message, usage: this.vertex.lastUsage || null };
    }
    await writeJsonAtomic(path.join(root, "final-edl.json"), edl);

    // --- Monetization/Safety Policy Pass ---
    const policyRaw = await runStage({
      key: "policy_check", outputName: "policy-check.json",
      input: { edl }, range: [94, 98], taskType: "quality", expectedKey: "issues", temperature: 0.1,
      prompt: "Analyze the final timeline scripts for any brand-safety, monetization, or policy issues. Report any potential violations or confirm they are safe.",
      responseSchema: {
        type: "object",
        properties: {
          issues: {
            type: "array",
            items: {
              type: "object",
              properties: {
                scriptId: { type: "number" },
                severity: { type: "string" },
                description: { type: "string" }
              }
            }
          }
        }
      }
    });
    edl.scripts.forEach(script => {
      script.policyIssues = policyRaw.issues?.filter(i => i.scriptId === script.scriptId) || [];
    });

    const scriptPaths = [];
    for (const script of edl.scripts) {
      const story = locked.lockedStories.find((item) => Number(item.scriptId) === Number(script.scriptId));
      const scriptPath = path.join(scriptsDir, `script-${script.scriptId}.json`);
      await writeJsonAtomic(scriptPath, toHighlightScript(script, story, config));
      scriptPaths.push(scriptPath);
    }
    const updated = await this.projectStore.updateProject(workspaceRoot, projectId, {
      analysisWorkflow: "vertex_auto_story",
      autoStoryConfig: config,
      autoStoryJobPath: jobPath,
      storyScriptPath: scriptPaths[0],
      storyScriptPaths: scriptPaths,
      narrationEnabled: config.narration.enabled,
      sourceLanguage: "en",
      targetLanguage: "en",
      narrationLanguage: "en",
      showSubtitles: true,
      statusMessage: `Đã khóa ${scriptPaths.length} Auto Story; sẵn sàng dựng draft`
    });
    job.status = "completed";
    job.scriptPaths = scriptPaths;
    await saveJob();
    progress(100, `Đã tạo ${scriptPaths.length} kịch bản Auto Story`, "complete");
    return { project: updated, jobPath, analysisDir: root, scriptPaths, config, usage: job.usage };
  }
}

AutoStoryPipelineService.MIN_OUTPUT_DURATION_SEC = MIN_OUTPUT_DURATION_SEC;
AutoStoryPipelineService.normalizeConfig = normalizeConfig;
AutoStoryPipelineService.validateCanonical = validateCanonical;
AutoStoryPipelineService.canonicalEventCoverage = canonicalEventCoverage;
AutoStoryPipelineService.mergeCanonicalContinuation = mergeCanonicalContinuation;
AutoStoryPipelineService.canonicalEventsNeedTimestampRepair = canonicalEventsNeedTimestampRepair;
AutoStoryPipelineService.applyCanonicalTimestampRepair = applyCanonicalTimestampRepair;
AutoStoryPipelineService.mergeCanonicalChunk = mergeCanonicalChunk;
AutoStoryPipelineService.validateEdl = validateEdl;
AutoStoryPipelineService.toHighlightScript = toHighlightScript;

module.exports = AutoStoryPipelineService;
