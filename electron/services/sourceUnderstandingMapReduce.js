"use strict";

// Chunked MAP / REDUCE source understanding (Phase A).
//
//   proxy chunk N --AGY map (1 video, its own transcript/scene/action slice)--> chunk-understanding-N.json
//   all chunk JSONs --AGY reduce (TEXT ONLY, no tools)--> source-understanding.json (schema v2)
//
// Real-run evidence (2026-10-07, 3 proxies / 772s): one global conversation that
// holds all three proxies failed its synthesis turn repeatedly with INTERNAL 500 /
// "stream interrupted" (~100-140s each) until the print timeout, and the
// same-conversation serialization failed the same way. Each map conversation here
// carries ONE ~4-minute chunk; the reducer carries no video at all.
//
// This module is pure (no AGY calls): slicing, prompts, schema validation,
// cache keys and per-chunk cache I/O. Orchestration lives in
// ManualAntigravityStage1Service.runChunkedSourceUnderstanding.

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const CHUNK_SCHEMA_VERSION = 1;
const MAP_PROMPT_VERSION = 3; // v3: durable file-first output + stdout fallback after mandatory video view
const REDUCE_PROMPT_VERSION = 2; // v2: durable file-first output + stdout fallback
const DEFAULT_HANDLE_SEC = 4;
const MAX_CHUNK_EVENTS = 15;
const CANDIDATE_TYPES = ["hook", "confrontation", "interrogation", "climax", "resolution", "context"];

function sha(value, length = 24) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex").slice(0, length);
}

function num(value, fallback = NaN) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function overlaps(start, end, rangeStart, rangeEnd) {
  return end > rangeStart && start < rangeEnd;
}

// ---------------------------------------------------------------------------
// Deterministic slicing (±handle seconds at the chunk boundaries)
// ---------------------------------------------------------------------------
function sliceTranscriptForRange(cues = [], startSec, endSec, handleSec = DEFAULT_HANDLE_SEC) {
  const from = startSec - handleSec;
  const to = endSec + handleSec;
  return cues.filter((cue) => overlaps(num(cue.start), num(cue.end), from, to));
}

function sliceScenesForRange(scenes = [], startSec, endSec, handleSec = DEFAULT_HANDLE_SEC) {
  const from = startSec - handleSec;
  const to = endSec + handleSec;
  return scenes.filter((scene) => overlaps(num(scene.startSec), num(scene.endSec), from, to));
}

function sliceActionCandidatesForRange(candidates = [], startSec, endSec, handleSec = DEFAULT_HANDLE_SEC) {
  const from = startSec - handleSec;
  const to = endSec + handleSec;
  return candidates.filter((item) => overlaps(num(item.sourceStartSec), num(item.sourceEndSec), from, to));
}

function chunkIdFor(index) {
  return `chunk-${String(index + 1).padStart(3, "0")}`;
}

/** Builds one map task per expected proxy with its own deterministic text slices. */
function buildMapTasks({ expectedProxyList = [], cues = [], scenes = [], actionCandidates = [], videoDurationSec = 0, handleSec = DEFAULT_HANDLE_SEC }) {
  return expectedProxyList.map((proxy, index) => {
    const startSec = num(proxy.sourceStartSec, index === 0 ? 0 : NaN);
    const endSec = num(proxy.sourceEndSec, expectedProxyList.length === 1 ? num(videoDurationSec, 0) : NaN);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
      throw new Error(`Proxy ${proxy.filename} thiếu khoảng SOURCE hợp lệ; không thể chia map chunk.`);
    }
    const transcript = sliceTranscriptForRange(cues, startSec, endSec, handleSec);
    const sceneSlice = sliceScenesForRange(scenes, startSec, endSec, handleSec);
    const actionSlice = sliceActionCandidatesForRange(actionCandidates, startSec, endSec, handleSec);
    return {
      index,
      chunkId: chunkIdFor(index),
      proxy,
      sourceStartSec: Number(startSec.toFixed(3)),
      sourceEndSec: Number(endSec.toFixed(3)),
      handleSec,
      transcript,
      scenes: sceneSlice,
      actions: actionSlice
    };
  });
}

function renderChunkContext(task) {
  const lines = [];
  lines.push(`CHUNK ${task.chunkId}: SOURCE ${task.sourceStartSec.toFixed(2)}-${task.sourceEndSec.toFixed(2)}s (video file ${task.proxy.filename}). Text context below includes ±${task.handleSec}s handles; times are absolute SOURCE seconds.`);
  lines.push(`SCENES (${task.scenes.length} overlapping; sceneId start-end):`);
  for (let index = 0; index < task.scenes.length; index += 6) {
    lines.push(task.scenes.slice(index, index + 6).map((scene) => `${scene.sceneId} ${num(scene.startSec).toFixed(1)}-${num(scene.endSec).toFixed(1)}`).join(" | "));
  }
  lines.push(task.actions.length
    ? `ACTION RADAR (local motion/audio heuristics, not editorial decisions): ${task.actions.map((item) => `[${num(item.sourceStartSec).toFixed(1)}-${num(item.sourceEndSec).toFixed(1)}] ${item.localActionType || "action"} score ${num(item.actionPriorityScore, 0).toFixed(1)}`).join("; ")}`
    : "ACTION RADAR: none in this interval.");
  lines.push(task.transcript.length ? `TRANSCRIPT (${task.transcript.length} cues, complete for this interval):` : "TRANSCRIPT: no cues in this interval; rely on audible dialogue in the video.");
  let current = null;
  const flush = () => {
    if (current) lines.push(`[${current.start.toFixed(1)}-${current.end.toFixed(1)}] ${current.text}`);
    current = null;
  };
  for (const cue of task.transcript) {
    if (current && current.text.length + cue.text.length + 1 <= 280 && cue.start - current.end <= 2.5) {
      current.end = cue.end;
      current.text = `${current.text} ${cue.text}`;
    } else {
      flush();
      current = { ...cue };
    }
  }
  flush();
  return `${lines.join("\n")}\n`;
}

const CHUNK_SCHEMA_EXAMPLE = {
  artifactType: "source_chunk_understanding",
  schemaVersion: CHUNK_SCHEMA_VERSION,
  chunkId: "chunk-002",
  sourceStartSec: 0,
  sourceEndSec: 0,
  openStateAtStart: "",
  charactersSeen: [{ id: "", nameOrRole: "", description: "" }],
  importantEvents: [{
    eventId: "e1",
    sourceStartSec: 0,
    sourceEndSec: 0,
    sceneIds: [""],
    eventType: "setup|arrival|confrontation|escalation|interrogation|lie|evidence|climax|arrest|consequence|aftermath|source_narration",
    summary: "",
    visualFacts: [""],
    dialogueFacts: [{ sourceSec: 0, speaker: "", quote: "" }],
    importantQuotes: [""],
    continuesFromPreviousChunk: false,
    continuesIntoNextChunk: false,
    sourceNarratorPresent: false,
    importance: 0,
    viralValue: 0
  }],
  candidateMoments: [{ sourceStartSec: 0, sourceEndSec: 0, sceneIds: [""], type: CANDIDATE_TYPES.join("|"), reason: "" }],
  openStateAtEnd: ""
};

function chunkTransportExample(task) {
  return { ...CHUNK_SCHEMA_EXAMPLE, chunkId: task.chunkId, sourceStartSec: task.sourceStartSec, sourceEndSec: task.sourceEndSec };
}

/**
 * contextText  -> the chunk's compact text context is inlined (default).
 * contextPath  -> the context is a chunk-local file read with ONE view_file in
 *                 the same first response (used when the inline prompt is too
 *                 long or was rejected by the prompt policy filter).
 * strictCoverage -> the targeted coverage retry after a turn that answered
 *                 without calling view_file on the chunk video.
 */
function buildMapPrompt({ task, contextText = "", contextPath = "", contextLineCount = 0, strictCoverage = false, outputPath = "" }) {
  const inline = Boolean(contextText);
  const videoCall = `view_file("${task.proxy.absolutePath}")`;
  return [
    `You are a Phase A MAP worker of RecapTool Studio. Understand ONLY source interval ${task.sourceStartSec.toFixed(2)}-${task.sourceEndSec.toFixed(2)}s (${task.chunkId}). Editorial-neutral: no scripts, hooks, titles or narration.`,
    "",
    ...(strictCoverage
      ? [`MANDATORY: your FIRST tool action must be ${videoCall}. A previous attempt answered without watching the video and was rejected. Any answer before that call is rejected again.`, ""]
      : []),
    "STEP 1 - your first response makes exactly these tool calls and nothing else:",
    `  1. ${videoCall}`,
    ...(inline ? [] : [`  2. view_file("${contextPath}", StartLine=1, EndLine=${Math.max(1, contextLineCount)})`]),
    "Watching the video with view_file is mandatory (audited). Never extract frames with Python/OpenCV/FFmpeg. Do not open any other file, do not list directories, do not run commands. Do not view the video twice.",
    "Burned-in SOURCE timestamps on the frames are absolute; local player time is not.",
    "",
    "STEP 2 - after the video tool returns, serialize the compact understanding immediately.",
    ...(outputPath ? [
      "PREFERRED TRANSPORT: call write_to_file exactly ONCE and write ONLY the JSON object to this exact file:",
      `  ${outputPath}`,
      "After write_to_file succeeds, reply only MAP_DONE. Do not perform more analysis or use any other tool.",
      "If write_to_file is unavailable, return the same bare JSON object directly in the response.",
    ] : ["Return the bare JSON object directly in the response."]),
    "- importantEvents: 3-8 meaningful story events for this interval (never more than 12). Never one per scene; merge scenes that carry the same beat.",
    "- Each event: exact SOURCE range inside this interval, sceneIds, eventType, one-sentence summary, at most 2 short visualFacts, at most 2 dialogueFacts (short exact quote, SOURCE second, speaker), importance and viralValue 0-100.",
    "- Mark continuesFromPreviousChunk / continuesIntoNextChunk when an event is cut by the interval boundary.",
    "- openStateAtStart: what is already in progress when the interval begins. openStateAtEnd: what is unresolved when it ends. One sentence each.",
    "- candidateMoments: at most 5 (hook|confrontation|interrogation|climax|resolution|context) with exact SOURCE ranges.",
    "- Only facts visible in the frames or audible / present in the transcript. Never invent names, charges, outcomes or motives. Do not copy the transcript.",
    "- Keep the JSON under ~900 words.",
    "",
    ...(inline ? ["TEXT CONTEXT FOR THIS INTERVAL (already complete; do not open any file for it):", contextText.trim(), ""] : []),
    "JSON SHAPE (root object; no wrapper and no Markdown inside the file/response):",
    JSON.stringify(chunkTransportExample(task))
  ].join("\n");
}

function rangeOk(item, minSec, maxSec) {
  const start = num(item?.sourceStartSec);
  const end = num(item?.sourceEndSec);
  return Number.isFinite(start) && Number.isFinite(end) && end > start && start >= minSec && end <= maxSec;
}

function validateChunkUnderstanding(data, task) {
  const errors = [];
  const warnings = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, errors: ["chunk understanding không phải JSON object."], warnings };
  if (data.artifactType !== "source_chunk_understanding") errors.push('artifactType phải là "source_chunk_understanding".');
  const minSec = task.sourceStartSec - task.handleSec - 2;
  const maxSec = task.sourceEndSec + task.handleSec + 2;
  const events = Array.isArray(data.importantEvents) ? data.importantEvents : null;
  if (!events) errors.push("importantEvents phải là mảng.");
  else {
    if (!events.length) errors.push("importantEvents trống.");
    if (events.length > MAX_CHUNK_EVENTS) errors.push(`importantEvents có ${events.length} sự kiện (tối đa ${MAX_CHUNK_EVENTS}); không liệt kê từng cảnh.`);
    events.forEach((event, index) => {
      if (!rangeOk(event, minSec, maxSec)) errors.push(`importantEvents[${index}] thiếu hoặc nằm ngoài khoảng ${task.sourceStartSec}-${task.sourceEndSec}s.`);
      if (typeof event?.summary !== "string" || !event.summary.trim()) errors.push(`importantEvents[${index}].summary trống.`);
    });
  }
  if (!Array.isArray(data.candidateMoments)) errors.push("candidateMoments phải là mảng.");
  else data.candidateMoments.forEach((item, index) => {
    if (!rangeOk(item, minSec, maxSec)) errors.push(`candidateMoments[${index}] thiếu hoặc nằm ngoài khoảng chunk.`);
  });
  if (!Array.isArray(data.charactersSeen)) errors.push("charactersSeen phải là mảng.");
  if (typeof data.openStateAtEnd !== "string") errors.push("openStateAtEnd phải là chuỗi.");
  if (typeof data.openStateAtStart !== "string") warnings.push("openStateAtStart thiếu.");
  if (events && events.length && events.length < 3) warnings.push(`chỉ có ${events.length} sự kiện.`);
  return { ok: errors.length === 0, errors, warnings };
}

function normalizeChunkUnderstanding(data, task) {
  if (!data || typeof data !== "object") return data;
  return {
    ...data,
    artifactType: data.artifactType || (Array.isArray(data.importantEvents) ? "source_chunk_understanding" : data.artifactType),
    schemaVersion: CHUNK_SCHEMA_VERSION,
    chunkId: task.chunkId,
    sourceStartSec: task.sourceStartSec,
    sourceEndSec: task.sourceEndSec,
    openStateAtStart: typeof data.openStateAtStart === "string" ? data.openStateAtStart : ""
  };
}

/**
 * A truncated chunk serialization can end inside its last list item. Keep
 * only complete events/candidates (valid range + summary), default missing
 * containers; nothing is invented and the result must still validate.
 */
function sanitizeRecoveredChunk(data) {
  if (!data || typeof data !== "object") return data;
  const validRange = (item) => Number.isFinite(num(item?.sourceStartSec)) && Number.isFinite(num(item?.sourceEndSec)) && num(item.sourceEndSec) > num(item.sourceStartSec);
  const recovery = { truncatedSerialization: true, droppedIncompleteItems: 0, defaultedFields: [] };
  const result = { ...data };
  const events = Array.isArray(result.importantEvents) ? result.importantEvents : [];
  result.importantEvents = events.filter((event) => validRange(event) && typeof event.summary === "string" && event.summary.trim());
  recovery.droppedIncompleteItems += events.length - result.importantEvents.length;
  const candidates = Array.isArray(result.candidateMoments) ? result.candidateMoments : [];
  if (!Array.isArray(result.candidateMoments)) recovery.defaultedFields.push("candidateMoments");
  result.candidateMoments = candidates.filter(validRange);
  recovery.droppedIncompleteItems += candidates.length - result.candidateMoments.length;
  if (!Array.isArray(result.charactersSeen)) { result.charactersSeen = []; recovery.defaultedFields.push("charactersSeen"); }
  if (typeof result.openStateAtEnd !== "string") { result.openStateAtEnd = ""; recovery.defaultedFields.push("openStateAtEnd"); }
  result.hostRecovery = recovery;
  return result;
}

// ---------------------------------------------------------------------------
// Per-chunk persistent cache
// ---------------------------------------------------------------------------
function computeChunkKey({ task, sourceFingerprint, proxySchemaVersion = 3 }) {
  const components = {
    chunkSchemaVersion: CHUNK_SCHEMA_VERSION,
    mapPromptVersion: MAP_PROMPT_VERSION,
    sourceFingerprint: String(sourceFingerprint),
    chunkId: task.chunkId,
    chunkRange: `${task.sourceStartSec.toFixed(3)}-${task.sourceEndSec.toFixed(3)}`,
    proxyFile: String(task.proxy.filename || ""),
    proxySizeBytes: num(task.proxy.sizeBytes, -1),
    proxySchemaVersion: Number(proxySchemaVersion) || 3,
    transcriptSliceKey: sha(task.transcript.map((cue) => [Number(cue.start.toFixed(3)), Number(cue.end.toFixed(3)), cue.text])),
    sceneSliceKey: sha(task.scenes.map((scene) => [String(scene.sceneId), num(scene.startSec), num(scene.endSec)])),
    actionSliceKey: sha(task.actions.map((item) => [num(item.sourceStartSec), num(item.sourceEndSec), num(item.actionPriorityScore, 0)])),
    handleSec: task.handleSec
  };
  return { key: sha(components), components };
}

function chunkCachePath(cacheDir, task, key) {
  return path.join(cacheDir, "chunk-understanding", `${task.chunkId}-${key}.json`);
}

async function loadChunkUnderstanding({ cacheDir, task, key, components }) {
  const filePath = chunkCachePath(cacheDir, task, key);
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (_error) {
    return { status: "miss", path: filePath };
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (error) {
    return { status: "invalid", path: filePath, reason: `JSON hỏng: ${error.message}` };
  }
  if (envelope?.artifactType !== "source_chunk_understanding_cache" || envelope.cacheKey !== key) {
    return { status: "invalid", path: filePath, reason: "envelope/cacheKey không khớp" };
  }
  for (const [name, value] of Object.entries(components)) {
    if (envelope.keyComponents?.[name] !== value) return { status: "invalid", path: filePath, reason: `metadata ${name} không khớp` };
  }
  if (envelope.map?.videoViewed !== true) return { status: "invalid", path: filePath, reason: "không có bằng chứng đã xem video chunk" };
  const validation = validateChunkUnderstanding(envelope.data, task);
  if (!validation.ok) return { status: "invalid", path: filePath, reason: validation.errors.slice(0, 2).join(" ") };
  return { status: "hit", path: filePath, data: envelope.data, envelope };
}

async function saveChunkUnderstanding({ cacheDir, task, key, components, data, map = {} }) {
  const validation = validateChunkUnderstanding(data, task);
  if (!validation.ok) throw new Error(`Không lưu chunk cache không hợp lệ: ${validation.errors.join(" ")}`);
  if (map.videoViewed !== true) throw new Error("Không lưu chunk cache khi chưa có bằng chứng xem video chunk.");
  const filePath = chunkCachePath(cacheDir, task, key);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const envelope = {
    artifactType: "source_chunk_understanding_cache",
    schemaVersion: CHUNK_SCHEMA_VERSION,
    cacheKey: key,
    keyComponents: components,
    createdAt: new Date().toISOString(),
    map,
    data
  };
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tempPath, JSON.stringify(envelope, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
  return filePath;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------
function computeReducerKey({ sourceFingerprint, videoDurationSec, chunkKeys = [] }) {
  const components = {
    sourceUnderstandingSchemaVersion: 2,
    reducePromptVersion: REDUCE_PROMPT_VERSION,
    architecture: "chunked_map_reduce",
    sourceFingerprint: String(sourceFingerprint),
    videoDurationSec: Number(num(videoDurationSec, 0).toFixed(3)),
    chunkKeys: chunkKeys.join(",")
  };
  return { key: sha(components), components };
}

function clip(text, max) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Compact, line-based rendering of all chunk understandings for the reducer prompt. */
function renderReducerInput(chunks = [], { summaryMax = 220, factMax = 3, quoteMax = 140, includeDialogue = true } = {}) {
  const lines = [];
  for (const { task, data } of chunks) {
    lines.push(`=== ${task.chunkId} SOURCE ${task.sourceStartSec.toFixed(2)}-${task.sourceEndSec.toFixed(2)}s ===`);
    if (data.openStateAtStart) lines.push(`openStateAtStart: ${clip(data.openStateAtStart, 300)}`);
    lines.push(`openStateAtEnd: ${clip(data.openStateAtEnd, 300)}`);
    const characters = (data.charactersSeen || []).map((item) => `${clip(item.nameOrRole || item.id, 60)}${item.description ? ` (${clip(item.description, 80)})` : ""}`);
    if (characters.length) lines.push(`charactersSeen: ${characters.join("; ")}`);
    lines.push("events:");
    for (const event of data.importantEvents || []) {
      const dialogue = (includeDialogue ? (event.dialogueFacts || []) : []).slice(0, factMax).map((fact) => (
        typeof fact === "string" ? `"${clip(fact, quoteMax)}"` : `${num(fact.sourceSec, 0).toFixed(1)}s ${clip(fact.speaker, 30)}: "${clip(fact.quote, quoteMax)}"`
      ));
      const visual = (event.visualFacts || []).slice(0, factMax).map((fact) => clip(fact, 120));
      lines.push([
        `- ${task.chunkId}/${event.eventId || "e"} [${num(event.sourceStartSec).toFixed(1)}-${num(event.sourceEndSec).toFixed(1)}]`,
        `scenes ${(event.sceneIds || []).join(",") || "-"}`,
        `${event.eventType || "event"}`,
        `imp ${num(event.importance, 0)} viral ${num(event.viralValue, 0)}`,
        `${event.continuesFromPreviousChunk ? "CONT_FROM_PREV " : ""}${event.continuesIntoNextChunk ? "CONT_INTO_NEXT " : ""}${clip(event.summary, summaryMax)}`,
        visual.length ? `visual: ${visual.join("; ")}` : "",
        dialogue.length ? `dialogue: ${dialogue.join("; ")}` : "",
        event.sourceNarratorPresent ? "SOURCE_NARRATOR" : ""
      ].filter(Boolean).join(" | "));
    }
    const candidates = (data.candidateMoments || []).map((item) => `- ${item.type || "context"} [${num(item.sourceStartSec).toFixed(1)}-${num(item.sourceEndSec).toFixed(1)}] scenes ${(item.sceneIds || []).join(",") || "-"} | ${clip(item.reason, 160)}`);
    if (candidates.length) lines.push("candidates:", ...candidates);
  }
  return lines.join("\n");
}

function renderReducerInputWithinBudget(chunks, maxChars, { includeDialogue = true } = {}) {
  const levels = [
    { summaryMax: 220, factMax: 3, quoteMax: 140 },
    { summaryMax: 180, factMax: 2, quoteMax: 110 },
    { summaryMax: 140, factMax: 1, quoteMax: 90 },
    { summaryMax: 110, factMax: 1, quoteMax: 70 }
  ];
  for (const base of levels) {
    const level = { ...base, includeDialogue };
    const text = renderReducerInput(chunks, level);
    if (text.length <= maxChars) return { text, level };
  }
  const last = { ...levels[levels.length - 1], includeDialogue };
  return { text: renderReducerInput(chunks, last), level: last, overBudget: true };
}

function buildReducePrompt({ reducerInput, videoDurationSec = 0, chunkCount = 0, schemaExample, errors = [], outputPath = "" }) {
  return [
    "You are the Phase A REDUCER of RecapTool Studio. TEXT ONLY.",
    "Do NOT call any tool. Do NOT call view_file. Do NOT open, list or read any file. Everything you need is below.",
    `Merge the ${chunkCount} chronological chunk understandings of ONE source video (${num(videoDurationSec, 0).toFixed(1)}s) into one global source understanding:`,
    "- caseSummary, centralConflict, centralViewerQuestion for the whole story.",
    "- characters: merge the same person seen in several chunks into one entry.",
    "- storyTimeline: 10-30 global events in chronological order. Merge an event split by a chunk boundary (CONT_INTO_NEXT followed by CONT_FROM_PREV) into one event. Reconcile each chunk's openStateAtEnd with the next chunk's openStateAtStart.",
    "- Keep SOURCE timestamps and sceneIds exactly as given by the chunks (you may merge adjacent ranges; never invent a range no chunk reported).",
    "- hookCandidates, confrontationCandidates, interrogationCandidates, climaxCandidates, resolutionCandidates: at most 5 each, with eventIds from your storyTimeline and exact SOURCE ranges.",
    "- Use only facts present in the chunk inputs. Never invent names, charges, outcomes or motives.",
    "- Keep the JSON under ~6,000 words.",
    ...(errors.length ? ["", "Your previous output was rejected by the host validator:", ...errors.slice(0, 8).map((error) => `- ${error}`)] : []),
    "",
    "CHUNK UNDERSTANDINGS:",
    reducerInput,
    "",
    ...(outputPath ? [
      "PREFERRED TRANSPORT: call write_to_file exactly ONCE and write the JSON object below to this exact file:",
      `  ${outputPath}`,
      "After write_to_file succeeds, reply only REDUCE_DONE. Do not call any other tool.",
      "If write_to_file is unavailable, return the same JSON object directly.",
    ] : ["TRANSPORT: return exactly one JSON object, no prose, no Markdown."]),
    JSON.stringify({ artifacts: [{ filename: "source-understanding.json", script: schemaExample }], notes: "" })
  ].join("\n");
}

/** Every reduced event must be grounded in at least one chunk event/candidate range (±5s). */
function validateReducerGrounding(understanding, chunks = []) {
  const ranges = [];
  for (const { data } of chunks) {
    for (const item of [...(data.importantEvents || []), ...(data.candidateMoments || [])]) {
      const start = num(item.sourceStartSec);
      const end = num(item.sourceEndSec);
      if (Number.isFinite(start) && Number.isFinite(end)) ranges.push([start - 5, end + 5]);
    }
  }
  const errors = [];
  (understanding?.storyTimeline || []).forEach((event, index) => {
    const start = num(event.sourceStartSec);
    const end = num(event.sourceEndSec);
    if (!ranges.some(([from, to]) => overlaps(start, end, from, to))) {
      errors.push(`storyTimeline[${index}] (${start}-${end}s) không khớp sự kiện nào mà các chunk đã báo cáo.`);
    }
  });
  return errors;
}

function resolveMapReduceTimeouts(settings = {}, { chunkDurationSec = 240 } = {}) {
  const configured = (key) => {
    const value = Number(settings[key]);
    return Number.isFinite(value) && value > 0 ? Math.max(60000, value) : 0;
  };
  const minutes = Math.max(0.5, num(chunkDurationSec, 240) / 60);
  return {
    mapChunkTimeoutMs: configured("antigravityMapChunkTimeoutMs") || Math.round(Math.min(480000, Math.max(240000, 180000 + minutes * 30000))),
    mapSerializationTimeoutMs: configured("antigravityMapSerializationTimeoutMs") || 90000,
    reduceTimeoutMs: configured("antigravityReduceTimeoutMs") || 240000
  };
}

module.exports = {
  CHUNK_SCHEMA_VERSION,
  MAP_PROMPT_VERSION,
  REDUCE_PROMPT_VERSION,
  DEFAULT_HANDLE_SEC,
  sliceTranscriptForRange,
  sliceScenesForRange,
  sliceActionCandidatesForRange,
  buildMapTasks,
  renderChunkContext,
  buildMapPrompt,
  validateChunkUnderstanding,
  normalizeChunkUnderstanding,
  sanitizeRecoveredChunk,
  MAP_PROMPT_VERSION_CURRENT: MAP_PROMPT_VERSION,
  computeChunkKey,
  chunkCachePath,
  loadChunkUnderstanding,
  saveChunkUnderstanding,
  computeReducerKey,
  renderReducerInput,
  renderReducerInputWithinBudget,
  buildReducePrompt,
  validateReducerGrounding,
  resolveMapReduceTimeouts
};
