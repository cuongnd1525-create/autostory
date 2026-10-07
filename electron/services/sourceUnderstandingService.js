"use strict";

// Persistent, source-scoped "source understanding" artifact for the
// manual_gemini_draft_review / Antigravity Stage 1 workflow.
//
// The artifact is produced ONCE per source (Phase A: the model watches 100% of
// the proxy chunks via multimodal view_file) and reused by every later Stage 1
// run of the same source. It lives in the persistent source cache
// (<workspace>/.cineviral/cache/gemini-analysis/<sourceFingerprint>/), never
// inside 01-GUI-GEMINI, because ManualGeminiPackService.create() deletes and
// rebuilds 01-GUI-GEMINI on every package rebuild.
//
// A cache hit requires a valid envelope whose metadata matches the current
// key components. File existence alone is never a hit.

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const SOURCE_UNDERSTANDING_SCHEMA_VERSION = 2;
// Bump when the Phase A prompt changes in a way that changes the semantic
// content of the artifact. Editorial/profile/voice/hook settings must NOT be
// part of this prompt, so they never invalidate the understanding.
const UNDERSTANDING_PROMPT_VERSION = 2;
// Mirrors manualGeminiPackService PROXY_SCHEMA_VERSION (proxy burn-in layout).
const DEFAULT_PROXY_SCHEMA_VERSION = 3;
const CACHE_FILE_PREFIX = "source-understanding-v2";

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function finite(value, fallback = NaN) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function readTextIfAvailable(filePath) {
  if (!filePath) return null;
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (_error) {
    return null;
  }
}

/**
 * Build the cache key from everything the semantic understanding depends on:
 * the source bytes (fingerprint), the proxy layout the model actually watched,
 * the scene manifest and the transcript it cross-checked, and the schema and
 * prompt versions. Nothing editorial (profile, hook, voice, duration) is included.
 */
async function computeSourceUnderstandingKey({
  sourceFingerprint,
  expectedProxyList = [],
  sceneManifestPath = "",
  transcriptPath = "",
  proxySchemaVersion = DEFAULT_PROXY_SCHEMA_VERSION
}) {
  if (!sourceFingerprint) {
    throw new Error("Thiếu sourceFingerprint; không thể tạo khóa cache source-understanding.");
  }
  const sceneManifestText = await readTextIfAvailable(sceneManifestPath);
  let sceneManifestKey = "none";
  if (sceneManifestText) {
    try {
      const manifest = JSON.parse(sceneManifestText);
      sceneManifestKey = sha256({
        videoDurationSec: finite(manifest.videoDurationSec, 0),
        scenes: (Array.isArray(manifest.scenes) ? manifest.scenes : []).map((scene) => [
          String(scene.sceneId || ""), finite(scene.startSec, 0), finite(scene.endSec, 0)
        ])
      }).slice(0, 24);
    } catch (_error) {
      sceneManifestKey = sha256(sceneManifestText).slice(0, 24);
    }
  }
  const transcriptText = await readTextIfAvailable(transcriptPath);
  const transcriptKey = transcriptText ? sha256(transcriptText.replace(/\r\n/g, "\n")).slice(0, 24) : "none";
  const proxyLayoutKey = sha256(expectedProxyList.map((proxy) => [
    String(proxy.filename || ""),
    finite(proxy.sourceStartSec, -1),
    finite(proxy.sourceEndSec, -1),
    finite(proxy.sizeBytes, -1)
  ])).slice(0, 24);
  const components = {
    sourceUnderstandingSchemaVersion: SOURCE_UNDERSTANDING_SCHEMA_VERSION,
    understandingPromptVersion: UNDERSTANDING_PROMPT_VERSION,
    sourceFingerprint: String(sourceFingerprint),
    proxySchemaVersion: Number(proxySchemaVersion) || DEFAULT_PROXY_SCHEMA_VERSION,
    proxyLayoutKey,
    sceneManifestKey,
    transcriptKey
  };
  return { key: sha256(components).slice(0, 24), components };
}

function cacheFilePath(cacheDir, key) {
  return path.join(cacheDir, `${CACHE_FILE_PREFIX}-${key}.json`);
}

function rangeOf(item = {}) {
  const start = finite(item.sourceStartSec ?? item.startSec);
  const end = finite(item.sourceEndSec ?? item.endSec);
  return { start, end };
}

const CANDIDATE_FIELDS = [
  "hookCandidates",
  "confrontationCandidates",
  "interrogationCandidates",
  "climaxCandidates",
  "resolutionCandidates"
];
const MIN_STORY_EVENTS = 3;
const MAX_STORY_EVENTS = 40;

/**
 * Structural validation of the compact semantic memory (schema v2).
 * It is NOT a scene database: scene-manifest.json already indexes every
 * detected scene. storyTimeline holds only the meaningful story events
 * (typically 10-30). Returns { ok, errors, warnings }.
 */
function validateSourceUnderstanding(data, { videoDurationSec = 0 } = {}) {
  const errors = [];
  const warnings = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, errors: ["source understanding không phải JSON object."], warnings };
  }
  if (data.artifactType !== "source_understanding") errors.push('artifactType phải là "source_understanding".');
  for (const field of ["caseSummary", "centralConflict", "centralViewerQuestion"]) {
    if (typeof data[field] !== "string" || !data[field].trim()) errors.push(`${field} trống.`);
  }
  if (!Array.isArray(data.characters) || !data.characters.length) errors.push("characters phải là mảng có ít nhất 1 nhân vật.");
  for (const field of CANDIDATE_FIELDS) {
    if (!Array.isArray(data[field])) errors.push(`${field} phải là mảng.`);
  }
  const duration = finite(videoDurationSec, 0) || finite(data.videoDurationSec, 0);
  const events = Array.isArray(data.storyTimeline) ? data.storyTimeline : null;
  if (!events) {
    errors.push("storyTimeline phải là mảng.");
  } else {
    if (events.length < MIN_STORY_EVENTS) errors.push(`storyTimeline chỉ có ${events.length} sự kiện (tối thiểu ${MIN_STORY_EVENTS}).`);
    if (events.length > MAX_STORY_EVENTS) errors.push(`storyTimeline có ${events.length} sự kiện; đây phải là các sự kiện truyện quan trọng (tối đa ${MAX_STORY_EVENTS}), không phải danh sách mọi cảnh.`);
  }
  let firstStart = Infinity;
  let lastEnd = 0;
  (events || []).forEach((event, index) => {
    const { start, end } = rangeOf(event);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0) {
      errors.push(`storyTimeline[${index}] thiếu sourceStartSec/sourceEndSec hợp lệ.`);
      return;
    }
    if (duration && end > duration + 2) errors.push(`storyTimeline[${index}] vượt thời lượng nguồn (${end}s > ${duration}s).`);
    if (typeof event.summary !== "string" || !event.summary.trim()) errors.push(`storyTimeline[${index}].summary trống.`);
    firstStart = Math.min(firstStart, start);
    lastEnd = Math.max(lastEnd, end);
  });
  for (const field of CANDIDATE_FIELDS) {
    (Array.isArray(data[field]) ? data[field] : []).forEach((item, index) => {
      const { start, end } = rangeOf(item);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        errors.push(`${field}[${index}] thiếu sourceStartSec/sourceEndSec hợp lệ.`);
      }
    });
  }
  // Truncation guard: a memory that stops half way through the source (or
  // never covers its opening) must not be cached as the source understanding.
  if (duration && events && events.length >= MIN_STORY_EVENTS && Number.isFinite(firstStart)) {
    if (lastEnd < duration * 0.6) {
      errors.push(`storyTimeline chỉ tới ${lastEnd.toFixed(1)}s/${duration.toFixed(1)}s; phải bao trùm câu chuyện tới kết thúc.`);
    }
    if (firstStart > duration * 0.4) {
      errors.push(`storyTimeline bắt đầu ở ${firstStart.toFixed(1)}s; thiếu phần mở đầu câu chuyện.`);
    }
  }
  if (events && events.length && events.length < 8) warnings.push(`storyTimeline chỉ có ${events.length} sự kiện.`);
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Reads the persistent cache. Returns:
 *  { status: "hit", data, envelope, path }
 *  { status: "miss", path }                      – no file for this key
 *  { status: "invalid", reason, path }           – file exists but is malformed/incompatible
 */
async function loadSourceUnderstanding({ cacheDir, key, components, expectedProxyFiles = [], videoDurationSec = 0 }) {
  const filePath = cacheFilePath(cacheDir, key);
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
  if (!envelope || typeof envelope !== "object") return { status: "invalid", path: filePath, reason: "không phải object" };
  if (envelope.artifactType !== "source_understanding_cache") {
    return { status: "invalid", path: filePath, reason: "artifactType cache không đúng" };
  }
  if (envelope.cacheKey !== key) return { status: "invalid", path: filePath, reason: "cacheKey không khớp" };
  for (const [name, value] of Object.entries(components)) {
    if (envelope.keyComponents?.[name] !== value) {
      return { status: "invalid", path: filePath, reason: `metadata ${name} không khớp (${envelope.keyComponents?.[name]} ≠ ${value})` };
    }
  }
  const coverage = envelope.phaseA?.coverage || {};
  const viewed = new Set((coverage.viewedProxyFiles || []).map((name) => String(name).toLowerCase()));
  const missing = expectedProxyFiles.filter((name) => !viewed.has(String(name).toLowerCase()));
  if (coverage.isComplete !== true || missing.length) {
    return { status: "invalid", path: filePath, reason: `Phase A không có bằng chứng xem đủ proxy (thiếu: ${missing.join(", ") || "coverage"})` };
  }
  const validation = validateSourceUnderstanding(envelope.data, { videoDurationSec });
  if (!validation.ok) {
    return { status: "invalid", path: filePath, reason: `nội dung không đạt schema: ${validation.errors.slice(0, 3).join(" ")}` };
  }
  return { status: "hit", path: filePath, data: envelope.data, envelope };
}

async function saveSourceUnderstanding({ cacheDir, key, components, data, phaseA = {} }) {
  const validation = validateSourceUnderstanding(data, { videoDurationSec: phaseA.videoDurationSec });
  if (!validation.ok) {
    throw new Error(`Không lưu cache source-understanding không hợp lệ: ${validation.errors.join(" ")}`);
  }
  if (phaseA.coverage?.isComplete !== true) {
    throw new Error("Không lưu cache source-understanding khi Phase A chưa xem đủ 100% proxy.");
  }
  await fs.mkdir(cacheDir, { recursive: true });
  const filePath = cacheFilePath(cacheDir, key);
  const envelope = {
    artifactType: "source_understanding_cache",
    schemaVersion: SOURCE_UNDERSTANDING_SCHEMA_VERSION,
    cacheKey: key,
    keyComponents: components,
    createdAt: new Date().toISOString(),
    phaseA,
    data
  };
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, JSON.stringify(envelope, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
  return { path: filePath, warnings: validation.warnings };
}

module.exports = {
  CANDIDATE_FIELDS,
  SOURCE_UNDERSTANDING_SCHEMA_VERSION,
  UNDERSTANDING_PROMPT_VERSION,
  DEFAULT_PROXY_SCHEMA_VERSION,
  computeSourceUnderstandingKey,
  validateSourceUnderstanding,
  loadSourceUnderstanding,
  saveSourceUnderstanding,
  cacheFilePath
};
