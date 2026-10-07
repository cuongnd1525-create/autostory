const fs = require("fs/promises");
const fsSync = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { buildCliEnv } = require("./cliEnv");
const { inspectGeminiJsonFiles } = require("./geminiJsonArtifactService");
const {
  CANDIDATE_FIELDS,
  SOURCE_UNDERSTANDING_SCHEMA_VERSION,
  computeSourceUnderstandingKey,
  validateSourceUnderstanding,
  loadSourceUnderstanding,
  saveSourceUnderstanding
} = require("./sourceUnderstandingService");
const { resetPipelineTiming } = require("./pipelineTimingService");
const MapReduce = require("./sourceUnderstandingMapReduce");

// Lazy: manualGeminiPackService is heavy and only needed for legacy packages
// whose package-info.json predates cache.sourceFingerprint.
function buildSourceFingerprint(sourceVideoPath) {
  return require("./manualGeminiPackService").buildSourceFingerprint(sourceVideoPath);
}

const RESULT_DIR_NAME = "01-ANTIGRAVITY-RESULT";
const REQUIRED_SCRIPT_IDS = [1, 3, 4, 2, 5];

function getRequestedScriptIds(promptText = "") {
  const match = String(promptText).match(/INDEPENDENT_USER_OPTIONS_JSON_BEGIN\s*([\s\S]*?)\s*INDEPENDENT_USER_OPTIONS_JSON_END/i);
  let count = 3;
  try {
    count = Math.max(1, Math.min(5, Number(JSON.parse(match?.[1] || "{}").scriptCount) || 3));
  } catch (_error) {
    count = 3;
  }
  return REQUIRED_SCRIPT_IDS.slice(0, count);
}

function splitArgs(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  const matches = text.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  return matches.map((part) => part.replace(/^"|"$/g, ""));
}

function hasArg(args, ...names) {
  return args.some((arg) => names.includes(arg) || names.some((name) => arg.startsWith(`${name}=`)));
}

const ANTIGRAVITY_MODEL_MAP = {
  "gemini 3.8 flash (high)": "gemini-3.8-flash-high",
  "gemini 3.8 flash (medium)": "gemini-3.8-flash-medium",
  "gemini 3.8 flash (low)": "gemini-3.8-flash-low",
  "gemini 3.7 flash (high)": "gemini-3.7-flash-high",
  "gemini 3.7 flash (medium)": "gemini-3.7-flash-medium",
  "gemini 3.7 flash (low)": "gemini-3.7-flash-low",
  "gemini 3.6 flash (high)": "gemini-3.6-flash-high",
  "gemini 3.6 flash (medium)": "gemini-3.6-flash-medium",
  "gemini 3.6 flash (low)": "gemini-3.6-flash-low",
  "gemini 3.1 pro (high)": "gemini-3.1-pro-high",
  "gemini 3.1 pro (low)": "gemini-3.1-pro-low",
  "claude sonnet 4.6 (thinking)": "claude-sonnet-4-6",
  "claude opus 4.6 (thinking)": "claude-opus-4-6-thinking",
  "gpt-oss 120b (medium)": "gpt-oss-120b-medium"
};

function normalizeAntigravityModel(model) {
  const text = String(model || "").trim();
  if (!text) return "";
  const lower = text.toLowerCase();
  return ANTIGRAVITY_MODEL_MAP[lower] || text;
}

function modelSupportsEffortFlag(model) {
  if (!model) return true;
  const lower = String(model).trim().toLowerCase();
  if (/\((?:high|medium|low|thinking)\)/i.test(lower)) return false;
  if (/-(?:high|medium|low|thinking)$/i.test(lower)) return false;
  if (/claude|gpt-oss/i.test(lower)) return false;
  return true;
}

function buildOutputSchema(scriptIds = REQUIRED_SCRIPT_IDS) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["artifacts"],
    properties: {
      artifacts: {
        type: "array",
        minItems: 1,
        maxItems: scriptIds.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["filename", "script"],
          properties: {
            filename: {
              type: "string",
              enum: scriptIds.map((id) => `script-${id}.json`)
            },
            script: {
              type: "object",
              required: ["scriptId"],
              anyOf: [
                { required: ["segments"] },
                { required: ["narrativeBeats"] }
              ],
              properties: {
                scriptId: { type: "number", enum: scriptIds },
                segments: {
                  type: "array",
                  minItems: 1,
                  items: { type: "object" }
                },
                narrativeBeats: {
                  type: "array",
                  minItems: 1,
                  items: { type: "object" }
                }
              },
              additionalProperties: true
            }
          }
        }
      },
      notes: { type: "string" }
    }
  };
}

function sanitizeJsonCandidate(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/:\s*None\b/g, ": null")
    .replace(/:\s*True\b/g, ": true")
    .replace(/:\s*False\b/g, ": false")
    .replace(/,\s*([\]}])/g, "$1");
}

function parseJsonCandidate(value) {
  if (value && typeof value === "object") return value;
  const text = String(value || "").replace(/^\uFEFF/, "").trim();
  if (!text) return null;
  const candidates = [text];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1].trim());
  }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (_error) {
      try {
        const sanitized = sanitizeJsonCandidate(candidate);
        return JSON.parse(sanitized);
      } catch (_e2) {
        // Try the next representation returned by the CLI.
      }
    }
  }
  return null;
}

function findArtifactEnvelope(value, seen = new Set()) {
  const parsed = parseJsonCandidate(value);
  if (!parsed && typeof value === "string") {
    const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
    for (const line of lines) {
      const nested = findArtifactEnvelope(parseJsonCandidate(line), seen);
      if (nested) return nested;
    }
  }
  if (!parsed || typeof parsed !== "object" || seen.has(parsed)) return null;
  seen.add(parsed);
  if (Array.isArray(parsed.artifacts)) return parsed;
  if (Array.isArray(parsed.segments) || Array.isArray(parsed.narrativeBeats)) {
    return {
      artifacts: [{ filename: `script-${Number(parsed.scriptId || 0) || 1}.json`, script: parsed }]
    };
  }
  for (const key of ["result", "response", "output", "text", "content", "message", "data", "final"]) {
    if (parsed[key] == null) continue;
    const nested = findArtifactEnvelope(parsed[key], seen);
    if (nested) return nested;
  }
  for (const nestedValue of Object.values(parsed)) {
    if (!nestedValue || typeof nestedValue !== "object") continue;
    const nested = findArtifactEnvelope(nestedValue, seen);
    if (nested) return nested;
  }
  return null;
}

function normalizeArtifact(artifact) {
  const script = artifact?.script || artifact?.content || artifact?.json || artifact?.data || artifact;
  if (script?.artifactType === "gemini_input_access_failure") {
    const missing = Array.isArray(script.missingInputs) ? script.missingInputs.join(", ") : "";
    const detail = script.mismatchDetails || script.recommendedAction || "Một số file đầu vào không tìm thấy";
    throw new Error(`AI dừng phân tích do thiếu file đầu vào (${missing || "không xác định"}): ${detail}`);
  }
  const scriptId = Number(script?.scriptId || script?.script_id || 0);
  if (!REQUIRED_SCRIPT_IDS.includes(scriptId)) {
    throw new Error(`Antigravity trả scriptId=${scriptId || "trống"}; chỉ chấp nhận 1, 3 hoặc 4.`);
  }
  const hasSegments = Array.isArray(script.segments) && script.segments.length > 0;
  const hasNarrativeBeats = Array.isArray(script.narrativeBeats) && script.narrativeBeats.length > 0;
  if (!hasSegments && !hasNarrativeBeats) {
    throw new Error(`Script ${scriptId} thiếu segments hoặc narrativeBeats có dữ liệu.`);
  }
  return {
    filename: `script-${scriptId}.json`,
    script: { ...script, scriptId }
  };
}

async function writeJsonAtomic(filePath, payload) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}

async function readPackageInfo(packageDir) {
  const infoPath = path.join(packageDir, "package-info.json");
  let info;
  try {
    info = JSON.parse(await fs.readFile(infoPath, "utf8"));
  } catch (error) {
    throw new Error(`Không đọc được package-info.json của GĐ1: ${error.message}`);
  }
  if (info.workflow !== "manual_gemini_draft_review") {
    throw new Error("Phân tích bằng Antigravity hiện chỉ áp dụng cho chế độ Viết kịch bản rồi review video thật.");
  }
  return info;
}

async function getExpectedProxyList(pass1Dir, packageInfo = null) {
  const expected = [];
  const seenPaths = new Set();

  const addIfFileExists = async (targetPath, id, extra = {}) => {
    if (!targetPath) return false;
    const resolved = path.resolve(targetPath);
    if (seenPaths.has(resolved)) return true;
    try {
      const stat = await fs.stat(resolved);
      if (stat.isFile()) {
        seenPaths.add(resolved);
        expected.push({
          id: id || path.basename(resolved),
          filename: path.basename(resolved),
          absolutePath: resolved,
          relativePath: path.relative(pass1Dir, resolved).replace(/\\/g, "/"),
          sizeBytes: stat.size,
          ...extra
        });
        return true;
      }
    } catch (_err) {
      // file does not exist
    }
    return false;
  };

  // 1. Try reading proxy-chunks-manifest.json
  const manifestPath = packageInfo?.proxyChunksManifestPath
    || path.join(pass1Dir, "proxy-chunks-manifest.json");
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw);
    if (Array.isArray(manifest?.chunks) && manifest.chunks.length > 0) {
      for (let idx = 0; idx < manifest.chunks.length; idx += 1) {
        const chunk = manifest.chunks[idx];
        const chunkId = chunk.chunkId || `proxy_chunk_${String(idx + 1).padStart(3, "0")}`;
        const extra = {
          sourceStartSec: chunk.sourceStartSec,
          sourceEndSec: chunk.sourceEndSec,
          durationSec: chunk.durationSec,
          uploadBatch: chunk.uploadBatch
        };

        let found = false;
        if (chunk.uploadRelativePath) {
          found = await addIfFileExists(path.join(pass1Dir, chunk.uploadRelativePath), chunkId, extra);
        }
        if (!found && chunk.file) {
          found = await addIfFileExists(path.join(pass1Dir, chunk.file), chunkId, extra);
        }
        if (!found && chunk.file) {
          try {
            const entries = await fs.readdir(pass1Dir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory() && entry.name.startsWith("UPLOAD-BATCH")) {
                const subPath = path.join(pass1Dir, entry.name, chunk.file);
                found = await addIfFileExists(subPath, chunkId, extra);
                if (found) break;
              }
            }
          } catch (_e) {}
        }
      }
    }
  } catch (_e) {
    // manifest missing or invalid
  }

  if (expected.length > 0) {
    return expected;
  }

  // 2. Check for single proxy video (analysis-proxy.mp4)
  if (packageInfo?.proxyPath) {
    await addIfFileExists(packageInfo.proxyPath, "proxy_main");
  }
  if (expected.length === 0) {
    await addIfFileExists(path.join(pass1Dir, "analysis-proxy.mp4"), "proxy_main");
  }
  if (expected.length > 0) {
    return expected;
  }

  // 3. Fallback scan for video files in pass1Dir and immediate subdirectories
  try {
    const entries = await fs.readdir(pass1Dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /\.(mp4|mov|webm|m4v)$/i.test(entry.name)) {
        await addIfFileExists(path.join(pass1Dir, entry.name), entry.name);
      } else if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== RESULT_DIR_NAME) {
        try {
          const subEntries = await fs.readdir(path.join(pass1Dir, entry.name), { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isFile() && /\.(mp4|mov|webm|m4v)$/i.test(sub.name)) {
              await addIfFileExists(path.join(pass1Dir, entry.name, sub.name), sub.name);
            }
          }
        } catch (_subErr) {}
      }
    }
  } catch (_scanErr) {}

  expected.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
  return expected;
}

function validateVideoCoverage(expectedProxyList = [], viewedProxySet = new Set()) {
  if (!expectedProxyList || expectedProxyList.length === 0) {
    return {
      totalExpected: 0,
      totalViewed: 0,
      coveragePercent: 100,
      isComplete: true,
      expectedProxyFiles: [],
      viewedProxyFiles: [],
      missingProxyFiles: [],
      expectedProxies: [],
      viewedProxies: [],
      missingProxies: []
    };
  }

  const normalizedViewed = new Set();
  for (const item of viewedProxySet) {
    if (!item) continue;
    const clean = String(item).trim().replace(/^"|"$/g, "").toLowerCase();
    normalizedViewed.add(clean);
    normalizedViewed.add(path.basename(clean));
    try {
      normalizedViewed.add(path.resolve(clean).toLowerCase());
    } catch (_e) {}
  }

  const viewedProxies = [];
  const missingProxies = [];

  for (const expected of expectedProxyList) {
    const idMatch = expected.id && normalizedViewed.has(String(expected.id).toLowerCase());
    const fileMatch = expected.filename && normalizedViewed.has(expected.filename.toLowerCase());
    const absMatch = expected.absolutePath && normalizedViewed.has(path.resolve(expected.absolutePath).toLowerCase());
    const relMatch = expected.relativePath && normalizedViewed.has(expected.relativePath.toLowerCase());

    if (idMatch || fileMatch || absMatch || relMatch) {
      viewedProxies.push(expected);
    } else {
      missingProxies.push(expected);
    }
  }

  const coveragePercent = Math.round((viewedProxies.length / expectedProxyList.length) * 100);
  const isComplete = missingProxies.length === 0;

  return {
    totalExpected: expectedProxyList.length,
    totalViewed: viewedProxies.length,
    coveragePercent,
    isComplete,
    expectedProxyFiles: expectedProxyList.map((p) => p.filename),
    viewedProxyFiles: viewedProxies.map((p) => p.filename),
    missingProxyFiles: missingProxies.map((p) => p.filename),
    expectedProxies: expectedProxyList,
    viewedProxies,
    missingProxies
  };
}

async function auditTranscriptForViewedProxies(conversationId, expectedProxyList = [], viewedProxySet = new Set(), customTranscriptPath = null) {
  if (!expectedProxyList || expectedProxyList.length === 0) {
    return validateVideoCoverage(expectedProxyList, viewedProxySet);
  }

  const candidatePaths = [];
  if (customTranscriptPath) {
    candidatePaths.push(customTranscriptPath);
  }
  if (conversationId) {
    const home = os.homedir();
    candidatePaths.push(
      path.join(home, ".gemini", "antigravity-cli", "brain", conversationId, ".system_generated", "logs", "transcript.jsonl"),
      path.join(home, ".gemini", "antigravity", "brain", conversationId, ".system_generated", "logs", "transcript.jsonl")
    );
  }

  for (const transcriptPath of candidatePaths) {
    try {
      const content = await fs.readFile(transcriptPath, "utf8");
      const lines = content.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const toolCalls = entry.tool_calls || [];
          for (const tc of toolCalls) {
            if (tc.name === "view_file") {
              const argPath = tc.args?.AbsolutePath || tc.args?.path || tc.args?.file || "";
              const clean = String(argPath).replace(/^"|"$/g, "").trim();
              if (clean && /\.(mp4|mov|webm|m4v)$/i.test(clean)) {
                viewedProxySet.add(clean);
                viewedProxySet.add(path.basename(clean));
              }
            }
          }
        } catch (_jsonErr) {}
      }
      break;
    } catch (_readErr) {
      // try next candidate
    }
  }

  return validateVideoCoverage(expectedProxyList, viewedProxySet);
}

// Windows CreateProcess limits the whole command line to 32,767 characters and
// agy receives the prompt through --print=<prompt>. Large inputs (source
// understanding, editorial prompt, series plan) are therefore passed as files
// that the model reads, never inlined into the command line.
const MAX_PRINT_PROMPT_CHARS = 24000;

const SERIES_PROFILES = {
  viral_tiktok_crime_part1: {
    profile: "viral_tiktok_crime_part1",
    durationMinSec: 110,
    durationMaxSec: 125,
    parts: [
      {
        scriptId: 1,
        partNumber: 1,
        partBadge: "PART 1",
        name: "The Confrontation",
        scope: "Cold-open hook, dispatch/arrival context, scene entry, escalation and the first confrontation. Ends on an unresolved, verified open question (cliffhanger) that makes the viewer need Part 2.",
        ending: "cliffhanger"
      },
      {
        scriptId: 3,
        partNumber: 2,
        partBadge: "PART 2",
        name: "The Interrogation",
        scope: "Questioning, explanations, lies, contradictions and evidence that surface after the confrontation. Ends on the strongest verified boiling-point turn BEFORE the arrest/verdict (cliffhanger).",
        ending: "cliffhanger"
      },
      {
        scriptId: 4,
        partNumber: 3,
        partBadge: "PART 3",
        name: "The Verdict & Arrest",
        scope: "The officers' decision, arrest/charges and the verified consequence. Delivers the payoff to the central viewer question. Only this Part may reveal the outcome.",
        ending: "payoff"
      }
    ]
  }
};

function detectSeriesProfile(promptText = "") {
  const match = String(promptText).match(/prompt_profile:\s*([a-z0-9_]+)/i);
  const profile = match ? match[1].toLowerCase() : "";
  return SERIES_PROFILES[profile] || null;
}

function assertPrintPromptSize(prompt, label) {
  if (String(prompt).length > MAX_PRINT_PROMPT_CHARS) {
    throw new Error(
      `${label} prompt dài ${String(prompt).length} ký tự, vượt giới hạn an toàn ${MAX_PRINT_PROMPT_CHARS} của dòng lệnh agy trên Windows. `
      + "Dữ liệu lớn phải được truyền bằng file."
    );
  }
  return prompt;
}

function buildRetryPrompt({ missingProxies, outputKind = "source_understanding" }) {
  const missingList = missingProxies.map((proxy, idx) => `  ${idx + 1}. view_file("${proxy.absolutePath}")`).join("\n");
  return [
    "================================================================================",
    "MANDATORY VIDEO COVERAGE GATE FAILED - MISSING PROXY CHUNKS DETECTED",
    "================================================================================",
    `You failed to inspect all proxy video chunks. You are missing ${missingProxies.length} chunk(s).`,
    "You MUST immediately call `view_file` on the following missing video chunks:",
    missingList,
    "",
    "Do NOT use Python, OpenCV, or FFmpeg to extract frames. Call `view_file` directly on each .mp4 file.",
    outputKind === "source_understanding"
      ? "After calling `view_file` on all missing chunks, return the COMPLETE source-understanding envelope again (all scenes from the first to the last second of the source), exactly as specified in the original instructions."
      : "After calling `view_file` on all missing chunks, return the final JSON envelope requested by the original instructions.",
    "================================================================================"
  ].join("\n");
}

const SOURCE_UNDERSTANDING_SCHEMA_EXAMPLE = {
  artifactType: "source_understanding",
  schemaVersion: 2,
  videoDurationSec: 0,
  caseSummary: "",
  centralConflict: "",
  centralViewerQuestion: "",
  characters: [{ id: "c1", nameOrRole: "", description: "" }],
  storyTimeline: [{
    eventId: "e01",
    sourceStartSec: 0,
    sourceEndSec: 0,
    sceneIds: ["scene_0001"],
    eventType: "setup|arrival|confrontation|escalation|interrogation|lie|evidence|climax|arrest|consequence|aftermath|source_narration",
    summary: "",
    visualFacts: [""],
    dialogueFacts: [{ sourceSec: 0, speaker: "", quote: "" }],
    sourceNarratorPresent: false,
    storyImportance: 0
  }],
  hookCandidates: [{ eventId: "e01", sourceStartSec: 0, sourceEndSec: 0, why: "" }],
  confrontationCandidates: [{ eventId: "", sourceStartSec: 0, sourceEndSec: 0, why: "" }],
  interrogationCandidates: [{ eventId: "", sourceStartSec: 0, sourceEndSec: 0, why: "" }],
  climaxCandidates: [{ eventId: "", sourceStartSec: 0, sourceEndSec: 0, why: "" }],
  resolutionCandidates: [{ eventId: "", sourceStartSec: 0, sourceEndSec: 0, why: "", verified: true }]
};

function parseSrtForContext(text = "") {
  // Line-based parser: some SRT exports put a blank line between the timing
  // line and the cue text, so blank-line block splitting would drop text.
  const lines = String(text || "").replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
  const toSec = (value) => {
    const match = String(value).trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4]}`) : NaN;
  };
  const nextNonEmpty = (index) => {
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (lines[cursor].trim()) return lines[cursor];
    }
    return "";
  };
  const cues = [];
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (line.includes("-->")) {
      const [startRaw, endRaw] = line.split("-->");
      current = { start: toSec(startRaw), end: toSec(endRaw), text: "" };
      if (Number.isFinite(current.start) && Number.isFinite(current.end)) cues.push(current);
      else current = null;
      continue;
    }
    if (/^\d+$/.test(line) && nextNonEmpty(index).includes("-->")) continue; // cue index
    if (current) current.text = `${current.text} ${line}`.replace(/\s+/g, " ").trim();
  }
  // Drop empty cues and exact consecutive duplicates (YouTube-style rolling
  // captions repeat the previous line in a ~10 ms cue); no words are lost.
  const result = [];
  for (const cue of cues) {
    if (!cue.text) continue;
    const previous = result[result.length - 1];
    if (previous && previous.text === cue.text && cue.start - previous.end <= 0.5) {
      previous.end = Math.max(previous.end, cue.end);
      continue;
    }
    result.push(cue);
  }
  return result;
}

/**
 * Deterministic, compact text context for Phase A. It replaces opening
 * scene-manifest.json + source-transcript.srt with view_file: the AGY
 * view_file tool pages long text files (the 3,026-line SRT took 5 calls,
 * each a full model turn over ~100K tokens of video context). Every
 * transcript word is kept; only SRT numbering/blank lines are removed and
 * consecutive cues are merged into lines of at most ~280 characters.
 */
function buildPhaseAContext({ sceneManifest = null, transcriptText = "", expectedProxyList = [], videoDurationSec = 0 }) {
  const lines = [];
  lines.push(`SOURCE DURATION: ${Number(videoDurationSec || 0).toFixed(3)}s. All times below are absolute SOURCE seconds (the same timestamps burned into the proxy frames).`);
  lines.push(`PROXY CHUNKS: ${expectedProxyList.map((proxy) => `${proxy.filename} ${Number(proxy.sourceStartSec ?? 0).toFixed(2)}-${Number(proxy.sourceEndSec ?? videoDurationSec).toFixed(2)}s`).join(" | ")}`);
  const scenes = Array.isArray(sceneManifest?.scenes) ? sceneManifest.scenes : [];
  lines.push(`SCENE INDEX (${scenes.length} detected scenes; sceneId start-end):`);
  for (let index = 0; index < scenes.length; index += 6) {
    lines.push(scenes.slice(index, index + 6)
      .map((scene) => `${scene.sceneId} ${Number(scene.startSec).toFixed(1)}-${Number(scene.endSec).toFixed(1)}`)
      .join(" | "));
  }
  const cues = parseSrtForContext(transcriptText);
  lines.push(cues.length
    ? `TRANSCRIPT (Whisper/SRT, ${cues.length} cues merged; complete text):`
    : "TRANSCRIPT: not available. Use only audible dialogue from the proxy videos.");
  let current = null;
  const flush = () => {
    if (current) lines.push(`[${current.start.toFixed(1)}-${current.end.toFixed(1)}] ${current.text}`);
    current = null;
  };
  for (const cue of cues) {
    if (current && current.text.length + cue.text.length + 1 <= 280 && cue.start - current.end <= 2.5) {
      current.end = cue.end;
      current.text = `${current.text} ${cue.text}`;
    } else {
      flush();
      current = { ...cue };
    }
  }
  flush();
  const text = `${lines.join("\n")}\n`;
  return {
    text,
    lineCount: lines.length,
    cueCount: cues.length,
    transcriptCharacters: cues.reduce((sum, cue) => sum + cue.text.length, 0)
  };
}

function buildSourceUnderstandingPrompt({ expectedProxyList = [], contextPath = "", contextLineCount = 0, videoDurationSec = 0 }) {
  const viewCalls = [
    ...expectedProxyList.map((proxy) => `view_file("${proxy.absolutePath}")`),
    `view_file("${contextPath}", StartLine=1, EndLine=${Math.max(1, contextLineCount)})`
  ];
  return [
    "You are executing Phase A (Source Understanding) of RecapTool Studio's manual Gemini draft-review workflow.",
    "Goal: a COMPACT SEMANTIC MEMORY of the source story. It is not a scene database (the host already has the scene index), not an edit script, not narration.",
    "",
    "STEP 1 - IN YOUR FIRST RESPONSE, ISSUE ALL OF THESE TOOL CALLS AT ONCE (parallel, one response):",
    ...viewCalls.map((call, index) => `  ${index + 1}. ${call}`),
    `The ${expectedProxyList.length} .mp4 proxies (source ${Number(videoDurationSec || 0).toFixed(1)}s total) MUST be watched with view_file: coverage is audited and a missing chunk is a fatal rejection. Never extract frames with Python/OpenCV/FFmpeg.`,
    "The context file already contains the complete transcript and the scene index. Open it exactly once with the line range above.",
    "Burned-in SOURCE timestamps on the frames are absolute source time; local player time inside a chunk is not.",
    "",
    "STEP 2 - IN YOUR SECOND RESPONSE, RETURN THE JSON. No further tool calls:",
    "- Do NOT call view_file again. Do NOT open scene-manifest.json, source-transcript.srt or any other file. Do NOT list directories or run commands.",
    "- storyTimeline: 10-30 meaningful story events in chronological order (fewer only for a very simple source). Merge consecutive scenes that carry the same story beat. Never write one event per detected scene.",
    "- Each event: exact SOURCE range, the sceneIds it spans, eventType, a one-sentence summary, up to 3 short visualFacts, up to 3 dialogueFacts (exact quote + SOURCE second + speaker) and storyImportance 0-100. Mark sourceNarratorPresent when a third-party narrator/TV host speaks.",
    "- Candidate lists (hook/confrontation/interrogation/climax/resolution): at most 5 each, referencing eventIds with exact SOURCE ranges. resolutionCandidates covers arrest/charges/verdict/consequence; set verified=false when the outcome is only implied.",
    "- Every fact must be visible in the frames or audible/present in the transcript. Never invent names, charges, outcomes or motives.",
    "- Keep the whole JSON under ~6,000 words.",
    "",
    "TRANSPORT (return exactly one JSON object, no prose, no Markdown):",
    JSON.stringify({ artifacts: [{ filename: "source-understanding.json", script: SOURCE_UNDERSTANDING_SCHEMA_EXAMPLE }], notes: "" })
  ].join("\n");
}

// Same-conversation serialization continuation (P0-4 Case B). Exact contract:
// no tool calls, no re-analysis, only serialize what is already in context.
function buildSourceUnderstandingSerializationPrompt({ errors = [] } = {}) {
  return [
    "You have already inspected 100% of the required source proxy videos.",
    "",
    "DO NOT call view_file.",
    "DO NOT read the transcript again.",
    "DO NOT read any manifests again.",
    "DO NOT perform additional analysis.",
    "",
    "Immediately serialize the source understanding already present in your context into the required JSON schema and return it now.",
    ...(errors.length ? ["", "The host rejected the previous output for:", ...errors.slice(0, 8).map((error) => `- ${error}`)] : []),
    "",
    "Return exactly one JSON object, no prose:",
    JSON.stringify({ artifacts: [{ filename: "source-understanding.json", script: { artifactType: "source_understanding", schemaVersion: 2, storyTimeline: [] } }], notes: "" })
  ].join("\n");
}

// Backward-compatible name used by older callers/tests.
function buildSourceUnderstandingRepairPrompt({ errors = [] } = {}) {
  return buildSourceUnderstandingSerializationPrompt({ errors });
}

/**
 * Best-effort recovery of a JSON object whose serialization was cut off
 * (print timeout / stream interrupted). Text-only and deterministic: it
 * closes the open strings/arrays/objects of the LAST "artifactType":
 * "source_understanding" object found in the agent's response text. The
 * result is accepted only if it passes the normal schema validation.
 */
function recoverTruncatedUnderstanding(stdout = "") {
  const texts = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed);
      const result = event.result;
      const candidates = [result?.response, result?.text, typeof result === "string" ? result : "", event.step_update?.content, event.content];
      for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.includes("source_understanding")) texts.push(candidate);
      }
    } catch (_error) { /* not an event */ }
  }
  for (const text of texts.reverse()) {
    const marker = text.lastIndexOf('"artifactType"');
    if (marker < 0) continue;
    const start = text.lastIndexOf("{", marker);
    if (start < 0) continue;
    const fragment = text.slice(start).replace(/```\s*$/g, "");
    const stack = [];
    let inString = false;
    let escaped = false;
    let lastSafe = -1;
    for (let index = 0; index < fragment.length; index += 1) {
      const char = fragment[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") inString = false;
        continue;
      }
      if (char === "\"") inString = true;
      else if (char === "{" || char === "[") stack.push(char);
      else if (char === "}" || char === "]") {
        stack.pop();
        if (!stack.length) return parseJsonCandidate(fragment.slice(0, index + 1));
      }
      if (!inString && (char === "," || char === "}" || char === "]")) lastSafe = index;
    }
    if (lastSafe < 0) continue;
    // Cut back to the last complete element and close every open container.
    let body = fragment.slice(0, lastSafe + 1).replace(/,\s*$/, "");
    const reopened = [];
    let quote = false;
    let esc = false;
    for (const char of body) {
      if (quote) {
        if (esc) esc = false;
        else if (char === "\\") esc = true;
        else if (char === "\"") quote = false;
        continue;
      }
      if (char === "\"") quote = true;
      else if (char === "{" || char === "[") reopened.push(char);
      else if (char === "}" || char === "]") reopened.pop();
    }
    body += reopened.reverse().map((char) => (char === "{" ? "}" : "]")).join("");
    const parsed = parseJsonCandidate(body);
    if (parsed && typeof parsed === "object") return parsed;
  }
  return null;
}

/**
 * A truncated serialization can end inside its last list item. Remove only
 * incomplete items (no valid source range) and default missing candidate
 * lists to []. Nothing is invented; the result must still pass validation
 * (including the truncation guard on storyTimeline coverage).
 */
function sanitizeRecoveredUnderstanding(data) {
  if (!data || typeof data !== "object") return data;
  const validRange = (item) => {
    const start = Number(item?.sourceStartSec);
    const end = Number(item?.sourceEndSec);
    return Number.isFinite(start) && Number.isFinite(end) && end > start;
  };
  const recovery = { truncatedSerialization: true, droppedIncompleteItems: 0, defaultedFields: [] };
  const result = { ...data };
  for (const field of ["storyTimeline", ...CANDIDATE_FIELDS]) {
    if (!Array.isArray(result[field])) {
      if (field !== "storyTimeline") {
        result[field] = [];
        recovery.defaultedFields.push(field);
      }
      continue;
    }
    const kept = result[field].filter((item) => validRange(item) && (field !== "storyTimeline" || (typeof item.summary === "string" && item.summary.trim())));
    recovery.droppedIncompleteItems += result[field].length - kept.length;
    result[field] = kept;
  }
  if (!Array.isArray(result.characters)) {
    result.characters = [];
    recovery.defaultedFields.push("characters");
  }
  result.hostRecovery = recovery;
  return result;
}

// ---------------------------------------------------------------------------
// AGY failure classification. Only STRUCTURED error information is used:
// the AGY_ERROR line on stderr, the final "result" event's error/status, the
// tail of stderr, and kinds set by runCli itself (timeouts, cancel, forbidden
// tool). Never the whole stdout stream: a 44-minute stream contains numbers
// such as "duration_seconds":503.9 that previously matched /503/ and turned a
// print timeout into a "server busy" full Phase A restart.
// ---------------------------------------------------------------------------
function extractAgyErrorInfo(error = {}) {
  const parts = [];
  let status = "";
  let code = null;
  let retryable = null;
  for (const line of String(error.stderr || "").split(/\r?\n/)) {
    const match = line.match(/AGY_ERROR:\s*(\{.*\})\s*$/);
    if (!match) continue;
    try {
      const info = JSON.parse(match[1]);
      status = info.status || status;
      code = Number(info.error_code) || code;
      retryable = typeof info.retryable === "boolean" ? info.retryable : retryable;
      parts.push(info.short_error || "");
    } catch (_error) { /* malformed */ }
  }
  for (const line of String(error.stdout || "").split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.includes("\"event\":\"result\"") && !trimmed.includes("\"event\": \"result\"")) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event.result?.status === "ERROR" || event.result?.error) parts.push(String(event.result.error || ""));
    } catch (_error) { /* ignore */ }
    break;
  }
  const stderrTail = String(error.stderr || "").split(/\r?\n/).filter(Boolean).slice(-6).join("\n");
  parts.push(stderrTail);
  return { status, code, retryable, text: parts.filter(Boolean).join("\n") };
}

function classifyAgyFailure(error = {}) {
  if (error.kind) return error.kind;
  const info = extractAgyErrorInfo(error);
  const text = `${info.status} ${info.code || ""} ${info.text}`;
  if (info.code === 401 || /\bUNAUTHENTICATED\b|\b401\b|not logged into Antigravity|invalid authentication credentials/i.test(text)) return "auth";
  if (info.code === 503 || info.code === 429 || /\bUNAVAILABLE\b|\bRESOURCE_EXHAUSTED\b|No capacity available|high traffic|\(code 503\)|\(code 429\)/i.test(text)) return "capacity";
  if (/\[agy\] print timeout after/i.test(text)) return "print_timeout";
  return "cli_error";
}

function describeAgyFailure(kind, error) {
  switch (kind) {
    case "auth":
      return "Antigravity từ chối xác thực (401 UNAUTHENTICATED). Token đăng nhập đã hết hạn hoặc không hợp lệ: mở Antigravity để đăng nhập/làm mới rồi chạy lại.";
    case "capacity":
      return "Máy chủ AI tạm hết dung lượng (503/UNAVAILABLE).";
    case "print_timeout":
    case "hard_timeout":
      return `AGY hết thời gian chờ của giai đoạn (${error?.message || "print timeout"}).`;
    case "inactivity_timeout":
      return `AGY không phản hồi (${error?.message || "inactivity"}).`;
    case "forbidden_tool":
      return `AGY gọi công cụ bị cấm trong bước này (${error?.message || ""}); tiến trình đã bị dừng.`;
    case "cancelled":
      return "Đã dừng theo yêu cầu.";
    default:
      return error?.message || "AGY lỗi.";
  }
}

/**
 * Phase-specific timeouts. Phase A now only watches the proxies once, reads
 * one context file and serializes a compact memory (two model turns), so it
 * must not reuse the legacy "video analysis + script generation" formula
 * (proxyChunkCount*480s + 1200s = 44 min for three chunks).
 */
function resolvePhaseTimeoutMs(phase, settings = {}, { sourceDurationSec = 0 } = {}) {
  const configured = (key) => {
    const value = Number(settings[key]);
    return Number.isFinite(value) && value > 0 ? Math.max(60000, value) : 0;
  };
  if (phase === "phase_a") {
    const minutes = Math.max(1, Number(sourceDurationSec || 0) / 60);
    return configured("antigravityPhaseATimeoutMs") || Math.round(Math.min(1200000, Math.max(420000, 300000 + minutes * 20000)));
  }
  if (phase === "phase_a_serialization") return configured("antigravitySerializationTimeoutMs") || 240000;
  if (phase === "series_plan") return configured("antigravitySeriesPlanTimeoutMs") || 360000;
  if (phase === "phase_b") return configured("antigravityPhaseBTimeoutMs") || 900000;
  return resolveAntigravityTimeoutMs(settings.antigravityTimeoutMs);
}

/**
 * Phase A architecture. "chunked_map_reduce" (default): one AGY process per
 * proxy chunk + one text-only reducer. "global_single_pass": the previous
 * single conversation that watches every proxy (kept only as an explicit
 * opt-in; real runs on 2026-10-07 failed its synthesis turn repeatedly).
 */
function resolveSourceUnderstandingArchitecture(settings = {}) {
  return String(settings.sourceUnderstandingArchitecture || "").trim() === "global_single_pass"
    ? "global_single_pass"
    : "chunked_map_reduce";
}

function resolveMapConcurrency(settings = {}) {
  const value = Number(settings.sourceUnderstandingMapConcurrency);
  if (!Number.isFinite(value) || value <= 0) return 2;
  return Math.max(1, Math.min(4, Math.floor(value)));
}

/** Bounded worker pool: never more than `limit` workers in flight. Workers must not throw. */
async function runBounded(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

const KEYRING_EXPIRY_PATTERN =/keyringAuth: loaded token, expiry=(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? ([+-]\d{2})(\d{2})\S* \S+ expired=(true|false)/;

function parseKeyringExpiry(logText = "") {
  let found = null;
  for (const line of String(logText || "").split(/\r?\n/)) {
    const match = line.match(KEYRING_EXPIRY_PATTERN);
    if (match) found = match;
  }
  if (!found) return null;
  const expiresAt = new Date(`${found[1]}T${found[2]}${found[3]}:${found[4]}`);
  if (Number.isNaN(expiresAt.getTime())) return null;
  return { expiresAt, expiredFlag: found[5] === "true" };
}

/** Reads the token expiry the AGY CLI logged after `startedAtMs` (warmup). */
async function readAntigravityTokenExpiry({ startedAtMs = 0, logDir = path.join(os.homedir(), ".gemini", "antigravity-cli", "log") } = {}) {
  try {
    const entries = await fs.readdir(logDir);
    const candidates = [];
    for (const name of entries.filter((item) => /^cli-.*\.log$/.test(item))) {
      const stat = await fs.stat(path.join(logDir, name)).catch(() => null);
      if (stat && stat.mtimeMs >= startedAtMs - 2000) candidates.push({ name, mtimeMs: stat.mtimeMs });
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const candidate of candidates) {
      const parsed = parseKeyringExpiry(await fs.readFile(path.join(logDir, candidate.name), "utf8"));
      if (parsed) return { ...parsed, logFile: candidate.name };
    }
  } catch (_error) { /* no log dir */ }
  return null;
}

function buildSeriesPlanPrompt({ series, understandingPath, hookContractPath = "", transcriptPath = "", sceneManifestPath = "", videoDurationSec = 0 }) {
  return [
    "You are executing Phase B1 (Series Plan) of RecapTool Studio's manual Gemini draft-review workflow.",
    "Work in READ-ONLY mode. Do NOT call view_file on any .mp4 file: the source video was already watched 100% in Phase A and its verified content is in SOURCE_UNDERSTANDING.",
    `SOURCE_UNDERSTANDING (read it first with view_file): ${understandingPath}`,
    ...(hookContractPath ? [`HOOK_CONTRACT (user-locked hook anchors): ${hookContractPath}`] : []),
    ...(sceneManifestPath ? [`SCENE_MANIFEST (legal source boundaries): ${sceneManifestPath}`] : []),
    ...(transcriptPath ? [`SOURCE_TRANSCRIPT (exact spoken lines): ${transcriptPath}`] : []),
    "",
    `Plan ONE continuous true-crime story told as a ${series.parts.length}-part series (profile ${series.profile}, every Part ${series.durationMinSec}-${series.durationMaxSec}s). The Parts are chapters of the SAME story with ONE central viewer question, not ${series.parts.length} separate stories.`,
    ...series.parts.map((part) => `- Script ${part.scriptId} = ${part.partBadge} "${part.name}": ${part.scope}`),
    "",
    "RULES:",
    "- Lock the central viewer question and the hook promise. Part 1 opens on the hook; Parts 2-3 pay it off progressively.",
    "- sceneAllocation: give each Part its own chronological SOURCE ranges. A range may appear in two Parts only if listed in sharedRanges with a reason (e.g. a 'previously on' recap of at most 8s). No other duplicates.",
    "- Spoiler boundaries: Part 1 and Part 2 must not include or narrate the arrest, charges, verdict or final consequence. Put those ranges in Part 3 payoffRanges.",
    "- Part 1 and Part 2 cliffhangers must be verified unresolved moments from the source. Part 3 payoff must be verified.",
    "- When HOOK_CONTRACT exists, the Part 1 hook must be its variant_01 anchor (trimming tolerance allowed).",
    "- Use only facts present in SOURCE_UNDERSTANDING or the transcript. Do not write scripts or narration yet.",
    `- All ranges must lie within 0-${Number(videoDurationSec || 0).toFixed(3)}s.`,
    "",
    "TRANSPORT (return exactly one JSON object, no prose, no Markdown):",
    JSON.stringify({
      artifacts: [{
        filename: "series-plan.json",
        script: {
          artifactType: "series_plan",
          schemaVersion: 1,
          profile: series.profile,
          centralViewerQuestion: "",
          hookPromise: "",
          parts: series.parts.map((part) => ({
            scriptId: part.scriptId,
            partNumber: part.partNumber,
            partBadge: part.partBadge,
            scope: "",
            hookRange: { sourceStartSec: 0, sourceEndSec: 0 },
            sceneAllocation: [{ sourceStartSec: 0, sourceEndSec: 0, purpose: "" }],
            mustNotReveal: [""],
            ...(part.ending === "payoff"
              ? { payoff: "", payoffRanges: [{ sourceStartSec: 0, sourceEndSec: 0 }] }
              : { cliffhanger: "", cliffhangerRange: { sourceStartSec: 0, sourceEndSec: 0 } })
          })),
          sharedRanges: [],
          duplicatePrevention: ""
        }
      }],
      notes: ""
    })
  ].join("\n");
}

function buildScriptGenerationPrompt({
  promptPath,
  understandingPath,
  seriesPlanPath = "",
  sceneManifestPath = "",
  transcriptPath = "",
  hookContractPath = "",
  actionCandidatesPath = "",
  resultDir,
  scriptIds = [1, 3, 4],
  coverageSummary = ""
}) {
  return [
    "You are executing Phase B (Script Generation) of RecapTool Studio's manual Gemini draft-review workflow.",
    "Work in READ-ONLY analysis mode. Do not run shell commands or list directories.",
    "",
    "INPUT FILES (open each with view_file; they are text/JSON):",
    `1. EDITORIAL_PROMPT_FILE (all editorial, timing, narrator, hook, schema and safety rules): ${promptPath}`,
    `2. SOURCE_UNDERSTANDING (host-verified multimodal understanding of the complete source video): ${understandingPath}`,
    ...(seriesPlanPath ? [`3. LOCKED_SERIES_PLAN (binding; already validated by the host): ${seriesPlanPath}`] : []),
    ...(sceneManifestPath ? [`- scene-manifest.json: ${sceneManifestPath}`] : []),
    ...(transcriptPath ? [`- source-transcript.srt: ${transcriptPath}`] : []),
    ...(hookContractPath ? [`- hook-contract.json: ${hookContractPath}`] : []),
    ...(actionCandidatesPath ? [`- action-candidates.json: ${actionCandidatesPath}`] : []),
    `RESULT_FOLDER_FOR_THE_HOST_APP: ${resultDir}`,
    "",
    "================================================================================",
    "HOST-VERIFIED INPUT ACCESS OVERRIDE (SUPERSEDES 'STEP 0 - VERIFIED INPUT ACCESS GATE' FOR THIS PHASE ONLY)",
    "================================================================================",
    `- The proxy video chunks were inspected 100% through multimodal view_file in Phase A and audited by the host (${coverageSummary || "complete coverage"}).`,
    "- SOURCE_UNDERSTANDING is the verified video input for this phase. Do NOT call view_file (or any other tool) on any .mp4 file. Do NOT return gemini_input_access_failure because the proxies are not re-opened.",
    "- In inputAccessAudit use accessMode=\"structured_locked\" and list source-understanding.json with role \"evidence\" plus the text files you opened.",
    "- If a fact cannot be verified from SOURCE_UNDERSTANDING or the transcript, leave it out. Never guess.",
    "",
    ...(seriesPlanPath ? [
      "SERIES LOCK (HIGHEST EDITORIAL PRIORITY):",
      "- Each Script is the Part assigned to it in LOCKED_SERIES_PLAN. Use only that Part's sceneAllocation/hookRange (plus declared sharedRanges).",
      "- Respect mustNotReveal and spoiler boundaries; Part 1/2 end on their planned cliffhanger, Part 3 delivers the planned payoff.",
      "- Ignore any '3-VARIANT NARRATIVE DIFFERENTIATION MATRIX' or 'DUPLICATE HOOK DIVERGENCE' text: the Parts are chapters of ONE story.",
      ""
    ] : []),
    "TIMELINE RULE: return only sceneId, sourceStartSec, sourceEndSec, audio_mode and voiceover_text (plus the editorial metadata the prompt asks for). Do NOT return startSec/endSec/outputStartSec/outputEndSec/duration; the local compiler derives the output timeline and playback speed.",
    "",
    `Generate exactly these scripts in order: ${scriptIds.join(", ")}. Each must follow the root schema of the editorial prompt.`,
    "This is a one-turn headless execution: do not stop at a plan, do not ask for approval.",
    "",
    "TRANSPORT (return exactly one JSON object, no prose, no Markdown):",
    JSON.stringify({ artifacts: scriptIds.map((id) => ({ filename: `script-${id}.json`, script: { scriptId: id } })), notes: "" })
  ].join("\n");
}

function overlapSec(a, b) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function toRange(item) {
  const start = Number(item?.sourceStartSec ?? item?.startSec);
  const end = Number(item?.sourceEndSec ?? item?.endSec);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}

function validateSeriesPlan(plan, { series, videoDurationSec = 0 } = {}) {
  const errors = [];
  const warnings = [];
  if (!plan || typeof plan !== "object") return { ok: false, errors: ["series-plan không phải object."], warnings };
  if (plan.artifactType !== "series_plan") errors.push('artifactType phải là "series_plan".');
  for (const field of ["centralViewerQuestion", "hookPromise"]) {
    if (typeof plan[field] !== "string" || !plan[field].trim()) errors.push(`${field} trống.`);
  }
  const parts = Array.isArray(plan.parts) ? plan.parts : [];
  const duration = Number(videoDurationSec) || Infinity;
  const allocations = new Map();
  for (const expected of series.parts) {
    const part = parts.find((item) => Number(item?.scriptId) === expected.scriptId);
    if (!part) { errors.push(`Thiếu Part cho Script ${expected.scriptId}.`); continue; }
    if (Number(part.partNumber) !== expected.partNumber) errors.push(`Script ${expected.scriptId} phải là partNumber ${expected.partNumber}.`);
    const ranges = (Array.isArray(part.sceneAllocation) ? part.sceneAllocation : []).map(toRange);
    if (!ranges.length || ranges.some((range) => !range)) errors.push(`Script ${expected.scriptId}: sceneAllocation trống hoặc sai range.`);
    if (ranges.some((range) => range && (range.start < 0 || range.end > duration + 1))) errors.push(`Script ${expected.scriptId}: sceneAllocation vượt thời lượng nguồn.`);
    if (expected.ending === "cliffhanger" && !(typeof part.cliffhanger === "string" && part.cliffhanger.trim())) {
      errors.push(`Script ${expected.scriptId}: thiếu cliffhanger.`);
    }
    if (expected.ending === "payoff") {
      if (!(typeof part.payoff === "string" && part.payoff.trim())) errors.push(`Script ${expected.scriptId}: thiếu payoff.`);
      const payoffRanges = (Array.isArray(part.payoffRanges) ? part.payoffRanges : []).map(toRange).filter(Boolean);
      if (!payoffRanges.length) errors.push(`Script ${expected.scriptId}: thiếu payoffRanges.`);
    }
    allocations.set(expected.scriptId, { part, ranges: ranges.filter(Boolean) });
  }
  const shared = (Array.isArray(plan.sharedRanges) ? plan.sharedRanges : []).map(toRange).filter(Boolean);
  const scriptIds = [...allocations.keys()];
  for (let i = 0; i < scriptIds.length; i += 1) {
    for (let j = i + 1; j < scriptIds.length; j += 1) {
      const left = allocations.get(scriptIds[i]).ranges;
      const right = allocations.get(scriptIds[j]).ranges;
      let duplicated = 0;
      for (const a of left) {
        for (const b of right) {
          const overlap = overlapSec(a, b);
          if (!overlap) continue;
          const intersection = { start: Math.max(a.start, b.start), end: Math.min(a.end, b.end) };
          const declared = shared.reduce((sum, range) => sum + overlapSec(range, intersection), 0);
          duplicated += Math.max(0, overlap - declared);
        }
      }
      if (duplicated > 3) errors.push(`Script ${scriptIds[i]} và Script ${scriptIds[j]} trùng ${duplicated.toFixed(1)}s nguồn ngoài sharedRanges.`);
    }
  }
  const payoffPart = series.parts.find((part) => part.ending === "payoff");
  const payoffRanges = payoffPart
    ? (allocations.get(payoffPart.scriptId)?.part?.payoffRanges || []).map(toRange).filter(Boolean)
    : [];
  for (const part of series.parts.filter((item) => item.ending === "cliffhanger")) {
    const leaked = (allocations.get(part.scriptId)?.ranges || [])
      .reduce((sum, range) => sum + payoffRanges.reduce((inner, payoff) => inner + overlapSec(range, payoff), 0), 0);
    if (leaked > 1) errors.push(`Script ${part.scriptId} dùng ${leaked.toFixed(1)}s thuộc payoff của Part 3 (spoiler).`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Post-generation adherence check of each script against its locked Part. */
function evaluateScriptsAgainstSeriesPlan(scripts = [], plan = null) {
  const warnings = [];
  const report = [];
  if (!plan?.parts) return { warnings, report };
  const shared = (plan.sharedRanges || []).map(toRange).filter(Boolean);
  for (const script of scripts) {
    const part = plan.parts.find((item) => Number(item.scriptId) === Number(script.scriptId));
    if (!part) continue;
    const allowed = [
      ...(part.sceneAllocation || []).map(toRange),
      toRange(part.hookRange || {}),
      ...(part.payoffRanges || []).map(toRange),
      ...shared
    ].filter(Boolean);
    const items = Array.isArray(script.segments) ? script.segments : (Array.isArray(script.narrativeBeats) ? script.narrativeBeats : []);
    let total = 0;
    let inside = 0;
    for (const item of items) {
      const range = toRange(item);
      if (!range) continue;
      total += range.end - range.start;
      // 2s tolerance on each side for editorial trimming.
      inside += allowed.reduce((sum, allowedRange) => sum + overlapSec(range, { start: allowedRange.start - 2, end: allowedRange.end + 2 }), 0);
    }
    const adherence = total > 0 ? Math.min(1, inside / total) : 0;
    report.push({ scriptId: Number(script.scriptId), partNumber: Number(part.partNumber), adherence: Number(adherence.toFixed(3)) });
    if (adherence < 0.8) {
      warnings.push(`Script ${script.scriptId} (${part.partBadge || `PART ${part.partNumber}`}) chỉ ${(adherence * 100).toFixed(0)}% thời lượng nằm trong phạm vi Part đã khóa trong series-plan.json.`);
    }
  }
  return { warnings, report };
}

function findObjectDeep(value, predicate, seen = new Set(), depth = 0) {
  if (depth > 12) return null;
  let parsed = value;
  if (typeof value === "string") {
    parsed = parseJsonCandidate(value);
    if (!parsed) {
      const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
      for (const line of lines) {
        const candidate = parseJsonCandidate(line);
        if (!candidate) continue;
        const nested = findObjectDeep(candidate, predicate, seen, depth + 1);
        if (nested) return nested;
      }
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || seen.has(parsed)) return null;
  seen.add(parsed);
  if (!Array.isArray(parsed) && predicate(parsed)) return parsed;
  for (const nestedValue of Object.values(parsed)) {
    if (nestedValue == null) continue;
    if (typeof nestedValue === "string" && !/[{[]/.test(nestedValue)) continue;
    const nested = findObjectDeep(nestedValue, predicate, seen, depth + 1);
    if (nested) return nested;
  }
  return null;
}

async function extractNamedArtifact(stdout, { filename, artifactType, resultDir }) {
  const fromEnvelope = (() => {
    // Prefer the latest result: scan stream lines from the end.
    const lines = String(stdout || "").split(/\r?\n/).filter(Boolean).reverse();
    for (const line of lines) {
      const envelope = findArtifactEnvelope(line);
      const artifact = envelope?.artifacts?.find((item) => item?.filename === filename);
      if (artifact?.script && typeof artifact.script === "object") return artifact.script;
    }
    const envelope = findArtifactEnvelope(stdout);
    return envelope?.artifacts?.find((item) => item?.filename === filename)?.script || null;
  })();
  if (fromEnvelope) return fromEnvelope;
  const deep = findObjectDeep(stdout, (object) => object.artifactType === artifactType);
  if (deep) return deep;
  if (resultDir) {
    try {
      const parsed = parseJsonCandidate(await fs.readFile(path.join(resultDir, filename), "utf8"));
      if (parsed && typeof parsed === "object") return parsed.artifacts?.[0]?.script || parsed;
    } catch (_error) { /* not written by the agent */ }
  }
  return null;
}

function buildAgentPrompt({ pass1Dir, promptPath, resultDir, scriptIds = [1, 3, 4], expectedProxyList = [], packageInfo = null }) {
  // Backward compatibility: use Phase A + B combined logic if called externally
  const promptLines = [
    "You are executing Stage 1 of RecapTool Studio's existing manual Gemini draft-review workflow.",
    "Work in READ-ONLY analysis mode. Do not edit, rename, delete, or create anything inside the Stage 1 input folder.",
    `STAGE_1_INPUT_FOLDER: ${pass1Dir}`,
    `EDITORIAL_PROMPT_FILE: ${promptPath}`,
    `RESULT_FOLDER_FOR_THE_HOST_APP: ${resultDir}`,
    ""
  ];

  if (expectedProxyList.length > 0) {
    promptLines.push(
      "================================================================================",
      "CRITICAL MANDATORY REQUIREMENT: 100% DIRECT MULTIMODAL VIDEO INSPECTION",
      "================================================================================",
      `You MUST call the \`view_file\` tool directly on ALL ${expectedProxyList.length} proxy video chunk(s) listed below in chronological order BEFORE generating any scripts:`,
      ...expectedProxyList.map((proxy, idx) => {
        const timeRange = proxy.sourceStartSec != null && proxy.sourceEndSec != null
          ? ` (Source: ${proxy.sourceStartSec}s -> ${proxy.sourceEndSec}s, duration: ${Math.round((proxy.durationSec || (proxy.sourceEndSec - proxy.sourceStartSec)) * 10) / 10}s)`
          : "";
        return `  ${idx + 1}. view_file("${proxy.absolutePath}")${timeRange}`;
      }),
      "",
      "STRICT RULES FOR VIDEO INSPECTION:",
      "1. You must call `view_file` on EVERY SINGLE proxy video listed above. Coverage must be 100%.",
      "2. PROHIBITED: Do NOT extract frames using Python, OpenCV, or FFmpeg to bypass video viewing.",
      "3. PROHIBITED: Do NOT rely solely on transcript or manifests without viewing the proxy chunks.",
      "4. The host application strictly audits your runtime tool calls and logs. If even 1 chunk is missing from your `view_file` calls, your execution will be REJECTED with a fatal error.",
      "================================================================================",
      ""
    );
  }

  const contextFiles = [];
  if (promptPath && fsSync.existsSync(promptPath)) {
    contextFiles.push({ label: "Editorial Prompt Instructions", path: promptPath });
  }
  const manifestCandidate = packageInfo?.proxyChunksManifestPath || path.join(pass1Dir, "proxy-chunks-manifest.json");
  if (fsSync.existsSync(manifestCandidate)) {
    contextFiles.push({ label: "Proxy Chunks Manifest", path: manifestCandidate });
  }
  const sceneManifestCandidate = packageInfo?.manifestPath || path.join(pass1Dir, "scene-manifest.json");
  if (fsSync.existsSync(sceneManifestCandidate)) {
    contextFiles.push({ label: "Scene Manifest", path: sceneManifestCandidate });
  }
  const transcriptCandidate = packageInfo?.transcriptPath || path.join(pass1Dir, "source-transcript.srt");
  if (fsSync.existsSync(transcriptCandidate)) {
    contextFiles.push({ label: "Source Transcript (Whisper)", path: transcriptCandidate });
  }
  const actionCandidate = packageInfo?.actionCandidatesPath || path.join(pass1Dir, "action-candidates.json");
  if (fsSync.existsSync(actionCandidate)) {
    contextFiles.push({ label: "Action Candidates", path: actionCandidate });
  }

  promptLines.push(
    "================================================================================",
    "MANDATORY CONTEXT AND METADATA INSPECTION",
    "================================================================================",
    "The following files are available as reference in STAGE_1_INPUT_FOLDER:",
    ...contextFiles.map((item, idx) => `  ${idx + 1}. ${item.path} (${item.label})`),
    "STRICT RULE: The editorial prompt contains all core rules, contracts, and candidates. DO NOT use the `view_file` tool to page through these long text/JSON files unless strictly necessary to resolve an ambiguity. Rely on your built-in reading capabilities or standard prompt context instead of tool calls.",
    "================================================================================",
    "",
    "CRITICAL EXECUTION CONSTRAINTS (PREVENT TIMEOUT & ELIMINATE WASTED TURNS):",
    "1. DO NOT run directory listing or shell commands (e.g., Get-ChildItem, dir, ls, Test-Path). All files you need are already explicitly provided above.",
    "2. DO NOT read or inspect `00-UPLOAD-ORDER.txt` or any auxiliary/cache files.",
    "3. DO NOT inspect, list, or read any files inside `RESULT_FOLDER_FOR_THE_HOST_APP`.",
    "4. IMMEDIATELY after inspecting the proxy video chunks, synthesize the complete story and write the final scripts. DO NOT call `view_file` on manifests or transcripts unless absolutely blocked.",
    "5. Follow every editorial, timing, narrator, hook, schema, and safety rule from the editorial prompt.",
    `6. Generate exactly these requested independent scripts in order: ${scriptIds.join(", ")}. Each script must exactly follow the root schema in the editorial prompt (including narrativeBeats when the Story Spine schema is requested).`,
    "7. This is a one-turn headless execution. Do NOT stop after making an implementation plan, do NOT ask for approval, and do NOT return a plan file. Complete the analysis and return the final artifacts now.",
    "",
    "TRANSPORT OVERRIDE FOR THIS CLI RUN ONLY:",
    "The editorial prompt asks for three JSON code blocks/files. Do not emit Markdown code fences here. Return one structured envelope matching the host-provided JSON schema:",
    JSON.stringify({ artifacts: scriptIds.map((id) => ({ filename: `script-${id}.json`, script: { scriptId: id } })), notes: "" }),
    "The script objects themselves must exactly follow the root schema required by the editorial prompt. Do not return conversational prose."
  );

  return promptLines.join("\n");
}

function resolveAntigravityTimeoutMs(settingsTimeout, packageInfo = null) {
  const configured = Number(settingsTimeout);
  let baseTimeout = Number.isFinite(configured) && configured > 0 ? configured : 900000;
  if (baseTimeout === 300000) {
    baseTimeout = 900000;
  }
  if (packageInfo) {
    const proxyChunkCount = Number(
      packageInfo.proxyChunkCount
      || packageInfo.sourceProxyFiles?.length
      || (Array.isArray(packageInfo.uploadFiles) ? packageInfo.uploadFiles.filter((f) => f.includes("proxy") || f.includes("draft")).length : 0)
      || 1
    );
    const sceneCount = Number(packageInfo.sceneCount || 0);
    // Allow 8 minutes per chunk + 20 minutes base for prompt/transcript/manifests + script generation
    const chunkTimeout = (Math.max(1, proxyChunkCount) * 480 + 1200) * 1000;
    const sceneTimeout = sceneCount > 50 ? 1500000 : 900000;
    baseTimeout = Math.max(baseTimeout, chunkTimeout, sceneTimeout);
  }
  return Math.max(15000, baseTimeout);
}

class ManualAntigravityStage1Service {
  constructor(settings = {}, dependencies = {}) {
    this.settings = settings;
    this.spawnImpl = dependencies.spawn || spawn;
    this.authProbe = dependencies.authProbe || null;
    this.activeChild = null;
    this.activeChildren = new Set();
    this.cancelled = false;
  }

  buildCommand(prompt, schemaPath, pass1Dir, options = {}) {
    const commandParts = splitArgs(this.settings.antigravityCommand || process.env.ANTIGRAVITY_COMMAND || "agy");
    const command = commandParts[0] || "agy";
    let args = [...commandParts.slice(1), ...splitArgs(this.settings.antigravityArgs || process.env.ANTIGRAVITY_ARGS || "")];
    const rawModel = String(this.settings.antigravityModel || process.env.ANTIGRAVITY_MODEL || "").trim();
    const model = normalizeAntigravityModel(rawModel);

    // Normalize any existing --model flag in args
    let activeModel = model;
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--model" && args[index + 1]) {
        args[index + 1] = normalizeAntigravityModel(args[index + 1]);
        activeModel = args[index + 1];
        break;
      }
      if (args[index].startsWith("--model=")) {
        const val = args[index].slice("--model=".length);
        const norm = normalizeAntigravityModel(val);
        args[index] = `--model=${norm}`;
        activeModel = norm;
        break;
      }
    }
    if (activeModel && !hasArg(args, "--model")) args.push("--model", activeModel);

    const modeSafeArgs = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--mode") {
        index += 1;
        continue;
      }
      if (arg.startsWith("--mode=")) continue;
      modeSafeArgs.push(arg);
    }
    args = [...modeSafeArgs, "--mode", "accept-edits"];
    // Headless agy cannot display permission prompts. Stage 1 needs command
    // access to inspect local JSON/SRT and proxy media, otherwise the command
    // tool is auto-denied and the CLI returns an empty successful response.
    if (!hasArg(args, "--dangerously-skip-permissions")) args.push("--dangerously-skip-permissions");

    const supportsEffort = modelSupportsEffortFlag(activeModel);
    if (!supportsEffort) {
      const cleaned = [];
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--effort") {
          index += 1;
          continue;
        }
        if (args[index].startsWith("--effort=")) continue;
        cleaned.push(args[index]);
      }
      args = cleaned;
    } else if (!hasArg(args, "--effort")) {
      args.push("--effort", "high");
    }

    if (!hasArg(args, "--output-format")) args.push("--output-format", "stream-json");
    // agy 1.1.22 terminates before model execution when --json-schema is used,
    // even with a minimal valid schema. The host validates the envelope and
    // each script strictly after the CLI response, so structured transport is
    // enforced locally instead of relying on this unstable CLI feature.
    if (hasArg(args, "--json-schema")) {
      const cleaned = [];
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--json-schema") {
          index += 1;
          continue;
        }
        if (arg.startsWith("--json-schema=")) continue;
        cleaned.push(arg);
      }
      args = cleaned;
    }
    if (!args.includes(pass1Dir)) args.push("--add-dir", pass1Dir);
    const timeoutMs = options.timeoutMs
      ? Math.max(15000, Number(options.timeoutMs))
      : resolveAntigravityTimeoutMs(this.settings.antigravityTimeoutMs, options.packageInfo);
    if (!hasArg(args, "--print-timeout")) args.push("--print-timeout", `${Math.ceil(timeoutMs / 1000)}s`);
    const expandedArgs = args.map((arg) => arg.replaceAll("{prompt}", prompt));
    args = [];
    let promptAttached = false;
    for (let index = 0; index < expandedArgs.length; index += 1) {
      const arg = expandedArgs[index];
      if (arg === "--print" || arg === "--prompt" || arg === "-p") {
        promptAttached = true;
        args.push(`${arg}=${prompt}`);
        if (expandedArgs[index + 1] === prompt) index += 1;
        continue;
      }
      if (arg.startsWith("--print=") || arg.startsWith("--prompt=") || arg.startsWith("-p=")) {
        promptAttached = true;
      }
      args.push(arg);
    }
    if (!promptAttached) args.push(`--print=${prompt}`);
    return { command, args, timeoutMs };
  }

  buildRetryCommand(conversationId, retryPrompt, pass1Dir, options = {}) {
    const commandParts = splitArgs(this.settings.antigravityCommand || process.env.ANTIGRAVITY_COMMAND || "agy");
    const command = commandParts[0] || "agy";
    let args = [
      ...commandParts.slice(1),
      "--conversation", conversationId,
      "--mode", "accept-edits",
      "--dangerously-skip-permissions",
      "--output-format", "stream-json"
    ];
    if (!args.includes(pass1Dir)) args.push("--add-dir", pass1Dir);

    const timeoutMs = options.timeoutMs
      ? Math.max(15000, Number(options.timeoutMs))
      : resolveAntigravityTimeoutMs(this.settings.antigravityTimeoutMs, options.packageInfo);
    if (!hasArg(args, "--print-timeout")) args.push("--print-timeout", `${Math.ceil(timeoutMs / 1000)}s`);

    args.push(`--print=${retryPrompt}`);
    return { command, args, timeoutMs };
  }

  runCli({
    command,
    args,
    prompt,
    cwd,
    timeoutMs,
    onProgress,
    progressStep = "antigravity_stage1",
    expectedProxyList = [],
    viewedProxySet = new Set(),
    forbiddenTools = [],
    toolGuard = null
  }) {
    return new Promise((resolve, reject) => {
      let forbiddenToolError = null;
      let failureKind = "";
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutBuffer = "";
      let settled = false;
      if (this.cancelled) {
        const error = new Error("Đã dừng phân tích GĐ1 bằng Antigravity.");
        error.kind = "cancelled";
        reject(error);
        return;
      }
      let lastActivityTime = Date.now();
      let currentPercent = 18;
      let conversationId = null;
      const stats = {
        agentTurns: 0,
        toolCalls: 0,
        viewFileVideoCount: 0,
        viewFileTextCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        cacheReadTokens: 0,
        modelSeconds: 0,
        videoFilesViewed: [],
        fileReads: {},
        usageReported: false
      };
      const countedSteps = new Set();
      const recordStep = (su) => {
        if (su.state === "ACTIVE") return;
        const stepKey = su.step_index ?? `anon-${countedSteps.size}`;
        if (countedSteps.has(stepKey)) return;
        countedSteps.add(stepKey);
        if (su.step_type === "agent_response") {
          stats.agentTurns += 1;
          stats.inputTokens += Number(su.usage?.input_tokens) || 0;
          stats.outputTokens += Number(su.usage?.output_tokens) || 0;
          stats.thinkingTokens += Number(su.usage?.thinking_tokens) || 0;
          stats.cacheReadTokens += Number(su.usage?.cache_read_tokens) || 0;
          if (su.usage) stats.usageReported = true;
          stats.modelSeconds += Number(su.duration_seconds) || 0;
        } else if (su.step_type === "tool") {
          stats.toolCalls += 1;
          const toolName = su.tool_name || su.tool_info?.name || "";
          if (toolName === "view_file") {
            const file = String(su.tool_info?.parameters?.AbsolutePath || "");
            const fileKey = path.basename(file.replace(/\\/g, "/")).toLowerCase();
            if (fileKey) stats.fileReads[fileKey] = (stats.fileReads[fileKey] || 0) + 1;
            if (/\.(mp4|mov|webm|m4v)$/i.test(file)) {
              stats.viewFileVideoCount += 1;
              stats.videoFilesViewed.push(path.basename(file));
            } else {
              stats.viewFileTextCount += 1;
            }
          }
        }
      };

      const child = this.spawnImpl(command, args, {
        cwd,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: buildCliEnv()
      });
      this.activeChild = child;
      this.activeChildren.add(child);
      const killThisChild = () => this.killChild(child);

      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearInterval(heartbeatInterval);
        clearTimeout(hardTimer);
        this.activeChildren.delete(child);
        if (this.activeChild === child) this.activeChild = null;
        callback();
      };

      const inactivityLimitMs = Math.min(timeoutMs, 600000);
      const hardTimeoutMs = timeoutMs + 30000;

      const rejectWith = (message, kind, extra = {}) => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        const error = new Error(message);
        Object.assign(error, { kind, stats, stdout, stderr, conversationId, viewedProxySet, ...extra });
        reject(error);
      };

      const hardTimer = setTimeout(() => {
        killThisChild();
        finish(() => rejectWith(`Antigravity timed out after ${Math.round(timeoutMs / 1000)}s.`, "hard_timeout"));
      }, hardTimeoutMs);

      const heartbeatInterval = setInterval(() => {
        if (settled) return;
        const idleMs = Date.now() - lastActivityTime;
        if (idleMs >= inactivityLimitMs) {
          killThisChild();
          finish(() => rejectWith(`Antigravity không có phản hồi trong ${Math.round(idleMs / 1000)}s (quá thời gian chờ hoạt động).`, "inactivity_timeout"));
        }
      }, 5000);

      let lastReportedMessage = "";
      let lastReportedPercent = 0;
      const emitProgress = (percent, message) => {
        const rounded = Math.round(percent);
        const cleanMsg = String(message || "").trim();
        if (cleanMsg === lastReportedMessage && rounded === lastReportedPercent) return;
        lastReportedMessage = cleanMsg;
        lastReportedPercent = rounded;
        onProgress?.({ step: progressStep, percent: rounded, message: cleanMsg.slice(0, 220) });
      };

      child.stdout.on("data", (chunk) => {
        stdoutChunks.push(chunk);
        lastActivityTime = Date.now();
        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
          try {
            const event = JSON.parse(trimmed);
            if (event.conversation_id) conversationId = event.conversation_id;
            if (event.init?.conversation_id) conversationId = event.init.conversation_id;
            if (event.step_update?.conversation_id) conversationId = event.step_update.conversation_id;

            if (event.event === "step_update" && event.step_update) {
              const su = event.step_update;
              recordStep(su);
              if (su.step_type === "tool" && (forbiddenTools.length || toolGuard) && !forbiddenToolError) {
                const toolName = su.tool_name || su.tool_info?.name || "";
                const file = String(su.tool_info?.parameters?.AbsolutePath || "");
                const guardReason = toolGuard ? toolGuard({ toolName, file, stepUpdate: su }) : null;
                if (guardReason || forbiddenTools.includes(toolName) || (forbiddenTools.includes("view_file:video") && toolName === "view_file" && /\.(mp4|mov|webm|m4v)$/i.test(file))) {
                  forbiddenToolError = `${toolName}${file ? ` ${path.basename(file.replace(/\\/g, "/"))}` : ""}${typeof guardReason === "string" ? ` (${guardReason})` : ""}`;
                  failureKind = "forbidden_tool";
                  killThisChild();
                }
              }
              if (su.step_type === "tool") {
                const toolName = su.tool_name || su.tool_info?.name || "công cụ";
                const paramFile = su.tool_info?.parameters?.AbsolutePath
                  || su.tool_info?.parameters?.Pattern
                  || su.tool_info?.parameters?.SearchDirectory
                  || "";
                const fileName = paramFile ? path.basename(paramFile) : "";
                const isVideoFile = /\.(mp4|mov|webm|m4v)$/i.test(fileName);
                let toolLabel = `Antigravity đang chạy ${toolName}`;

                if (toolName === "view_file") {
                  if (isVideoFile) {
                    viewedProxySet.add(fileName);
                    if (paramFile) viewedProxySet.add(paramFile);
                    const coverage = validateVideoCoverage(expectedProxyList, viewedProxySet);
                    const ratioStr = expectedProxyList.length > 0
                      ? ` (${coverage.totalViewed}/${coverage.totalExpected})`
                      : "";
                    toolLabel = `Antigravity đang xem proxy video${ratioStr}: ${fileName}`;
                  } else if (fileName.includes("manifest")) {
                    toolLabel = `Antigravity đang đọc scene manifest: ${fileName}`;
                  } else if (fileName.includes("transcript") || fileName.endsWith(".srt")) {
                    toolLabel = `Antigravity đang đọc transcript: ${fileName}`;
                  } else if (fileName.includes("prompt")) {
                    toolLabel = `Antigravity đang đọc prompt: ${fileName}`;
                  } else if (fileName) {
                    toolLabel = `Antigravity đang kiểm tra: ${fileName}`;
                  }
                } else if (toolName === "grep_search" || toolName === "find_by_name") {
                  toolLabel = "Antigravity đang tìm dữ liệu cảnh/transcript...";
                } else if (toolName === "run_command") {
                  toolLabel = "Antigravity đang xử lý lệnh phụ...";
                }
                currentPercent = Math.min(98, currentPercent + 2);
                emitProgress(currentPercent, toolLabel);
              } else if (su.step_type === "agent_response") {
                currentPercent = Math.min(98, Math.max(currentPercent, 35) + 0.2);
                emitProgress(currentPercent, "Antigravity đang phân tích và viết kịch bản...");
              }
            } else if (event.event === "result") {
              // Not a success signal: the host still has to parse and validate the JSON.
              const failed = event.result?.status === "ERROR" || Boolean(event.result?.error);
              emitProgress(currentPercent, failed
                ? `Antigravity kết thúc lượt với lỗi: ${String(event.result?.error || "ERROR").slice(0, 160)}`
                : "Antigravity đã trả kết quả; đang kiểm tra JSON...");
            }
          } catch (_e) {
            // Non-JSON line, ignore
          }
        }
      });

      child.stderr.on("data", (chunk) => {
        stderrChunks.push(chunk);
        lastActivityTime = Date.now();
        currentPercent = Math.min(98, currentPercent + 0.05);
        const message = String(chunk || "").trim().split(/\r?\n/).filter(Boolean).at(-1);
        if (message) emitProgress(currentPercent, message);
      });

      child.on("error", (error) => finish(() => {
        error.kind = error.kind || "spawn_error";
        error.stats = stats;
        reject(error);
      }));
      child.on("close", (code) => finish(() => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        const combined = `${stdout}\n${stderr}`;

        if (forbiddenToolError) {
          rejectWith(`Forbidden tool call: ${forbiddenToolError}`, "forbidden_tool");
          return;
        }
        if (this.cancelled) {
          rejectWith("Đã dừng phân tích GĐ1 bằng Antigravity.", "cancelled");
          return;
        }
        
        let validEnvelope = null;
        try {
          validEnvelope = findArtifactEnvelope(stdout);
        } catch (_e) {}
        
        if (combined.includes("[agy] print timeout after")) {
          if (validEnvelope && validEnvelope.artifacts && validEnvelope.artifacts.length > 0) {
            // Partial output contains valid scripts, so accept it!
            resolve({ stdout, stderr, conversationId, viewedProxySet, stats });
            return;
          }
          const timeoutMatch = combined.match(/\[agy\] print timeout after (\S+)/i);
          const limitStr = timeoutMatch ? timeoutMatch[1] : `${Math.round(timeoutMs / 1000)}s`;
          rejectWith(`Antigravity timed out after ${limitStr} ([agy] print timeout).`, "print_timeout");
          return;
        }
        
        if (code !== 0) {
          if (validEnvelope && validEnvelope.artifacts && validEnvelope.artifacts.length > 0) {
            resolve({ stdout, stderr, conversationId, viewedProxySet, stats });
            return;
          }
          const stderrTail = String(stderr || "").split(/\r?\n/).filter(Boolean).slice(-6).join("\n");
          rejectWith(`agy exited with code ${code}: ${stderrTail || "(no stderr)"}`, "");
          return;
        }
        
        resolve({ stdout, stderr, conversationId, viewedProxySet, stats });
      }));
      child.stdin.end();
    });
  }

  killChild(child) {
    if (!child) return false;
    if (process.platform === "win32" && child.pid) {
      try {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      } catch (_error) {
        child.kill("SIGKILL");
      }
    } else {
      child.kill("SIGKILL");
    }
    return true;
  }

  /** Cancel: kills every running AGY child (map stages may run in parallel). */
  terminateActiveChild({ asCancel = true } = {}) {
    const children = [...this.activeChildren];
    if (this.activeChild && !children.includes(this.activeChild)) children.push(this.activeChild);
    if (!children.length) return false;
    if (asCancel) this.cancelled = true;
    children.forEach((child) => this.killChild(child));
    return true;
  }

  cancel() {
    // Also covers the gaps between map chunks / retry delays when no child is running.
    this.cancelled = true;
    this.terminateActiveChild();
    return true;
  }

  emitLog(onProgress, percent, message, logs) {
    logs?.push(`${new Date().toISOString()} ${message}`);
    onProgress?.({ step: "antigravity_stage1", percent, message });
  }

  /**
   * Credentials preflight before EVERY new AGY process. The AGY CLI loads the
   * OAuth token from the OS keyring and does not refresh it itself (real logs:
   * "keyringAuth: loaded token, expiry=09:44:35" at 08:50 and again at 09:35;
   * the 09:35 retry then failed with 401 at 09:45). The warmup (`agy models`)
   * makes the CLI log the expiry; we read it so an expired token fails fast
   * with an explicit authentication error instead of after a long video turn.
   */
  async ensureAntigravityAuth({ label, diagnostics = null, onProgress, logs }) {
    let probe = null;
    if (this.authProbe) {
      probe = await this.authProbe({ label });
    } else if (this.spawnImpl === spawn) {
      const startedAtMs = Date.now();
      const commandParts = splitArgs(this.settings.antigravityCommand || process.env.ANTIGRAVITY_COMMAND || "agy");
      await new Promise((resolve) => {
        try {
          const warmup = spawn(commandParts[0] || "agy", [...commandParts.slice(1), "models"], { windowsHide: true, env: buildCliEnv() });
          warmup.on("close", resolve);
          warmup.on("error", resolve);
          setTimeout(() => { try { warmup.kill(); } catch (_) {} resolve(); }, 8000);
        } catch (_error) {
          resolve();
        }
      });
      probe = await readAntigravityTokenExpiry({ startedAtMs });
    }
    const now = Date.now();
    const expiresAtMs = probe?.expiresAt instanceof Date ? probe.expiresAt.getTime() : null;
    const remainingSec = expiresAtMs ? Math.round((expiresAtMs - now) / 1000) : null;
    const record = {
      label,
      checkedAt: new Date(now).toISOString(),
      tokenExpiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
      tokenRemainingSec: remainingSec
    };
    if (diagnostics) diagnostics.authChecks.push(record);
    if (probe?.expiredFlag === true || (remainingSec !== null && remainingSec < 60)) {
      const error = new Error(
        `[${label}] AUTH: token đăng nhập Antigravity ${remainingSec !== null && remainingSec > 0 ? `chỉ còn ${remainingSec}s` : "đã hết hạn"}`
        + `${record.tokenExpiresAt ? ` (hết hạn ${record.tokenExpiresAt})` : ""}. Mở Antigravity để đăng nhập/làm mới token rồi chạy lại. Không xem lại video nguồn.`
      );
      error.kind = "auth";
      throw error;
    }
    if (remainingSec !== null) {
      this.emitLog(onProgress, 12, `[${label}] AUTH: token còn ${Math.round(remainingSec / 60)} phút (hết hạn ${record.tokenExpiresAt}).`, logs);
    }
    return record;
  }

  /**
   * Runs ONE agy process (fresh or resumed). Never retries by itself: the
   * caller decides per failure kind. Every attempt's stdout/stderr is kept in
   * its own log file (previously a retry overwrote the first attempt's log).
   */
  async runAgyOnce({ label, commandConfig, prompt, resultDir, onProgress, expectedProxyList = [], viewedProxySet = new Set(), metrics, logs, logBase, forbiddenTools = [], toolGuard = null, cwd = null }) {
    metrics.agyProcessCount += 1;
    const attemptIndex = metrics.agyProcessCount;
    const startedAt = Date.now();
    const writeAttemptLogs = async (stdout, stderr) => {
      await fs.writeFile(path.join(resultDir, `antigravity-output-${logBase}-attempt${attemptIndex}.log`), stdout || "", "utf8").catch(() => {});
      if (stderr) await fs.writeFile(path.join(resultDir, `antigravity-stderr-${logBase}-attempt${attemptIndex}.log`), stderr, "utf8").catch(() => {});
    };
    try {
      const result = await this.runCli({
        ...commandConfig,
        prompt,
        cwd: cwd || resultDir,
        onProgress,
        progressStep: "antigravity_stage1",
        expectedProxyList,
        viewedProxySet,
        forbiddenTools,
        toolGuard
      });
      accumulateStats(metrics, result.stats);
      metrics.attempts.push({ label, attempt: attemptIndex, ok: true, durationMs: Date.now() - startedAt, resumed: commandConfig.args.includes("--conversation"), videoViews: result.stats?.viewFileVideoCount || 0 });
      await writeAttemptLogs(result.stdout, result.stderr);
      return { ok: true, result };
    } catch (error) {
      accumulateStats(metrics, error.stats);
      const kind = classifyAgyFailure(error);
      metrics.attempts.push({ label, attempt: attemptIndex, ok: false, kind, durationMs: Date.now() - startedAt, resumed: commandConfig.args.includes("--conversation"), videoViews: error.stats?.viewFileVideoCount || 0, message: String(error.message || "").slice(0, 300) });
      await writeAttemptLogs(error.stdout, error.stderr || error.message);
      return { ok: false, error, kind };
    }
  }

  /**
   * Text-only phases (series plan, Phase B). Capacity errors may be retried
   * with a fresh process (no video is involved); auth and timeouts are not.
   */
  async runAgyPhase({ label, commandConfig, prompt, resultDir, onProgress, expectedProxyList, viewedProxySet, metrics, logs, logBase }) {
    const maxCapacityRetries = 2;
    for (let attempt = 0; ; attempt += 1) {
      await this.ensureAntigravityAuth({ label, onProgress, logs });
      const outcome = await this.runAgyOnce({ label, commandConfig, prompt, resultDir, onProgress, expectedProxyList, viewedProxySet, metrics, logs, logBase });
      if (outcome.ok) return outcome.result;
      if (outcome.kind === "capacity" && attempt < maxCapacityRetries && !this.cancelled) {
        const delaySec = (attempt + 1) * 8;
        metrics.retryCount += 1;
        this.emitLog(onProgress, 15, `[${label}] 503/UNAVAILABLE: máy chủ AI hết dung lượng. Thử lại sau ${delaySec}s (${attempt + 1}/${maxCapacityRetries})...`, logs);
        await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
        continue;
      }
      const error = new Error(`[${label}] ${describeAgyFailure(outcome.kind, outcome.error)}`);
      Object.assign(error, { kind: outcome.kind, stdout: outcome.error.stdout, stderr: outcome.error.stderr, cause: outcome.error });
      throw error;
    }
  }

  /**
   * Phase A: watch every proxy ONCE, read ONE compact context file, serialize
   * a compact semantic memory. Recovery never restarts multimodal inspection
   * once any proxy has been viewed:
   *   - capacity error before any video view  -> fresh retry (nothing watched yet)
   *   - auth (401)                             -> fail immediately
   *   - timeout / bad JSON with coverage=100%  -> Case A (partial stdout),
   *     Case B (same-conversation serialization, tools forbidden),
   *     Case C (local text-only truncation repair), else explicit failure
   *   - incomplete coverage after a clean turn -> resume same conversation for
   *     the missing chunks only
   */
  async runPhaseA({ pass1Dir, packageInfo, resultDir, schemaPath, expectedProxyList, videoDurationSec, inputPaths, onProgress, metrics, logs, diagnostics }) {
    const phaseAInputDir = path.join(resultDir, "phase-a-input");
    await fs.mkdir(phaseAInputDir, { recursive: true });
    let sceneManifest = null;
    try { sceneManifest = JSON.parse(await fs.readFile(inputPaths.sceneManifestPath, "utf8")); } catch (_error) { sceneManifest = null; }
    const transcriptText = inputPaths.transcriptPath ? await fs.readFile(inputPaths.transcriptPath, "utf8").catch(() => "") : "";
    const context = buildPhaseAContext({ sceneManifest, transcriptText, expectedProxyList, videoDurationSec });
    const contextPath = path.join(phaseAInputDir, "phase-a-context.txt");
    await fs.writeFile(contextPath, context.text, "utf8");
    diagnostics.contextFile = { path: contextPath, lines: context.lineCount, transcriptCues: context.cueCount, bytes: Buffer.byteLength(context.text, "utf8") };

    const timeoutMs = resolvePhaseTimeoutMs("phase_a", this.settings, { sourceDurationSec: videoDurationSec });
    diagnostics.timeoutMs = timeoutMs;
    const promptA = assertPrintPromptSize(
      buildSourceUnderstandingPrompt({ expectedProxyList, contextPath, contextLineCount: context.lineCount, videoDurationSec }),
      "Phase A"
    );
    const commandConfigA = this.buildCommand(promptA, schemaPath, pass1Dir, { packageInfo, timeoutMs });
    const viewedProxySet = new Set();
    let conversationId = null;
    let stdoutA = "";
    let mainOutcome = null;
    const maxCapacityRetries = 2;

    for (let attempt = 0; ; attempt += 1) {
      await this.ensureAntigravityAuth({ label: "PHASE_A", diagnostics, onProgress, logs });
      const viewedBefore = viewedProxySet.size;
      mainOutcome = await this.runAgyOnce({
        label: "PHASE_A", commandConfig: commandConfigA, prompt: promptA, resultDir, onProgress,
        expectedProxyList, viewedProxySet, metrics, logs, logBase: "phaseA"
      });
      const source = mainOutcome.ok ? mainOutcome.result : mainOutcome.error;
      conversationId = source?.conversationId || conversationId;
      stdoutA += `${stdoutA ? "\n--- PHASE_A ATTEMPT ---\n" : ""}${source?.stdout || ""}`;
      if (mainOutcome.ok) break;
      diagnostics.failureKinds.push(mainOutcome.kind);
      if (mainOutcome.kind === "auth") {
        const error = new Error(`[PHASE_A] ${describeAgyFailure("auth", mainOutcome.error)}`);
        error.kind = "auth";
        throw error;
      }
      if (["print_timeout", "hard_timeout", "inactivity_timeout"].includes(mainOutcome.kind)) diagnostics.timeoutOccurred = true;
      const watchedInThisAttempt = viewedProxySet.size > viewedBefore || Number(source?.stats?.viewFileVideoCount || 0) > 0;
      if (mainOutcome.kind === "capacity" && !watchedInThisAttempt && viewedProxySet.size === 0 && attempt < maxCapacityRetries && !this.cancelled) {
        const delaySec = (attempt + 1) * 8;
        diagnostics.freshRetryBeforeAnyVideoCount += 1;
        this.emitLog(onProgress, 15, `[PHASE_A] 503/UNAVAILABLE trước khi xem video nào. Thử lại tiến trình mới sau ${delaySec}s (${attempt + 1}/${maxCapacityRetries})...`, logs);
        await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
        continue;
      }
      // Any other failure (timeout, capacity after videos were viewed, CLI
      // error): NO fresh multimodal restart. Recovery below works only from
      // what this conversation already produced.
      this.emitLog(onProgress, 40, `[PHASE_A] ${describeAgyFailure(mainOutcome.kind, mainOutcome.error)} Không khởi động lại việc xem video; chuyển sang khôi phục từ hội thoại hiện tại.`, logs);
      break;
    }
    if (mainOutcome.ok === false && mainOutcome.kind === "cancelled") throw mainOutcome.error;

    let coverage = await auditTranscriptForViewedProxies(conversationId, expectedProxyList, viewedProxySet);
    // Missing chunks after a CLEAN turn: ask the same conversation for those chunks only.
    for (let attempt = 1; mainOutcome.ok && !coverage.isComplete && attempt <= 2 && conversationId; attempt += 1) {
      this.emitLog(onProgress, Math.min(40, 20 + attempt * 10), `[PHASE_A] Chưa xem đủ proxy (${coverage.coveragePercent}%). Yêu cầu xem phần thiếu trong cùng hội thoại (${attempt}/2)...`, logs);
      await this.ensureAntigravityAuth({ label: "PHASE_A_COVERAGE", diagnostics, onProgress, logs });
      const retryPrompt = assertPrintPromptSize(buildRetryPrompt({ missingProxies: coverage.missingProxies, outputKind: "source_understanding" }), "Phase A coverage");
      const outcome = await this.runAgyOnce({
        label: "PHASE_A_COVERAGE", commandConfig: this.buildRetryCommand(conversationId, retryPrompt, pass1Dir, { packageInfo, timeoutMs }),
        prompt: retryPrompt, resultDir, onProgress, expectedProxyList, viewedProxySet, metrics, logs, logBase: "phaseA-coverage"
      });
      const source = outcome.ok ? outcome.result : outcome.error;
      stdoutA += `\n--- PHASE_A_COVERAGE ---\n${source?.stdout || ""}`;
      conversationId = source?.conversationId || conversationId;
      if (!outcome.ok) {
        diagnostics.failureKinds.push(outcome.kind);
        if (outcome.kind === "auth") {
          const error = new Error(`[PHASE_A] ${describeAgyFailure("auth", outcome.error)}`);
          error.kind = "auth";
          throw error;
        }
        break;
      }
      coverage = await auditTranscriptForViewedProxies(conversationId, expectedProxyList, viewedProxySet);
    }
    await fs.writeFile(path.join(resultDir, "antigravity-output-phaseA.log"), stdoutA, "utf8");
    diagnostics.coverage = { viewed: coverage.totalViewed, expected: coverage.totalExpected, percent: coverage.coveragePercent };
    if (!coverage.isComplete) {
      const gateError = new Error(
        `[PHASE_A] FAILED: Antigravity chưa xem đủ 100% proxy video qua multimodal view_file(). `
        + `Đạt ${coverage.totalViewed}/${coverage.totalExpected} chunks (${coverage.coveragePercent}%). `
        + `Thiếu: [${coverage.missingProxyFiles.join(", ")}]. `
        + `${diagnostics.timeoutOccurred ? "Phase A đã hết thời gian; không tự động xem lại toàn bộ video. " : ""}Không lưu cache, kịch bản bị từ chối.`
      );
      gateError.coverage = coverage;
      gateError.kind = diagnostics.timeoutOccurred ? "print_timeout" : "coverage";
      throw gateError;
    }

    // Coverage is 100% from here on: no new multimodal inspection may start.
    const parseFrom = async (text) => {
      const data = await extractNamedArtifact(text, { filename: "source-understanding.json", artifactType: "source_understanding", resultDir });
      return this.normalizeUnderstanding(data, videoDurationSec);
    };
    // Case A: the (possibly partial) stdout already contains a valid artifact.
    let parsed = await parseFrom(stdoutA);
    if (!parsed.validation.ok && conversationId) {
      // Case B: same conversation, serialization only, tools forbidden.
      diagnostics.serializationRepairUsed = "same_conversation";
      this.emitLog(onProgress, 44, `[PHASE_A] Coverage 100% nhưng chưa có JSON hợp lệ (${parsed.validation.errors.slice(0, 2).join(" ")}). Yêu cầu serialize trong cùng hội thoại (cấm view_file).`, logs);
      try {
        await this.ensureAntigravityAuth({ label: "PHASE_A_SERIALIZE", diagnostics, onProgress, logs });
        const serializationPrompt = buildSourceUnderstandingSerializationPrompt({ errors: parsed.validation.errors });
        const serializationTimeoutMs = resolvePhaseTimeoutMs("phase_a_serialization", this.settings);
        const viewsBefore = metrics.viewFileVideoCount;
        const outcome = await this.runAgyOnce({
          label: "PHASE_A_SERIALIZE",
          commandConfig: this.buildRetryCommand(conversationId, assertPrintPromptSize(serializationPrompt, "Phase A serialization"), pass1Dir, { packageInfo, timeoutMs: serializationTimeoutMs }),
          prompt: serializationPrompt, resultDir, onProgress, expectedProxyList, viewedProxySet: new Set(), metrics, logs,
          logBase: "phaseA-serialize",
          forbiddenTools: ["view_file", "run_command", "grep_search", "find_by_name", "list_dir", "codebase_search"]
        });
        diagnostics.serializationVideoViews = metrics.viewFileVideoCount - viewsBefore;
        const source = outcome.ok ? outcome.result : outcome.error;
        stdoutA += `\n--- PHASE_A_SERIALIZE ---\n${source?.stdout || ""}`;
        await fs.writeFile(path.join(resultDir, "antigravity-output-phaseA.log"), stdoutA, "utf8");
        if (!outcome.ok) diagnostics.failureKinds.push(outcome.kind);
        if (!outcome.ok && outcome.kind === "auth") {
          const error = new Error(`[PHASE_A] ${describeAgyFailure("auth", outcome.error)}`);
          error.kind = "auth";
          throw error;
        }
        parsed = await parseFrom(source?.stdout || "");
      } catch (error) {
        if (error.kind === "auth") throw error;
        diagnostics.failureKinds.push(error.kind || "serialization_error");
      }
    }
    if (!parsed.validation.ok) {
      // Case C: deterministic text-only repair of a truncated serialization.
      const recovered = this.normalizeUnderstanding(sanitizeRecoveredUnderstanding(recoverTruncatedUnderstanding(stdoutA)), videoDurationSec);
      if (recovered.validation.ok) {
        diagnostics.serializationRepairUsed = diagnostics.serializationRepairUsed
          ? `${diagnostics.serializationRepairUsed}+local_truncation_repair`
          : "local_truncation_repair";
        parsed = recovered;
      }
    }
    if (!parsed.validation.ok) {
      const error = new Error(
        `[PHASE_A] FAILED: đã xem đủ 100% proxy nhưng không khôi phục được source-understanding hợp lệ `
        + `(${parsed.validation.errors.slice(0, 4).join(" ")}). Không tự động xem lại video, không ghi cache. Xem log tại ${resultDir}.`
      );
      error.kind = "serialization";
      error.validation = parsed.validation;
      throw error;
    }
    return { data: parsed.data, coverage, conversationId, warnings: parsed.validation.warnings };
  }

  capacityRetryDelayMs(attempt) {
    const base = Number(this.settings.antigravityCapacityRetryBaseMs);
    return (Number.isFinite(base) && base >= 0 ? base : 8000) * (attempt + 1);
  }

  /**
   * Deterministic chunk tasks + cache keys. Pure local work (no AGY): the
   * reducer key is derived from the chunk keys, so a warm run can check the
   * global cache without starting any model process.
   */
  async prepareChunkedPhaseA({ packageInfo, inputPaths, expectedProxyList, videoDurationSec, sourceFingerprint }) {
    let sceneManifest = null;
    try { sceneManifest = JSON.parse(await fs.readFile(inputPaths.sceneManifestPath, "utf8")); } catch (_error) { sceneManifest = null; }
    const transcriptText = inputPaths.transcriptPath ? await fs.readFile(inputPaths.transcriptPath, "utf8").catch(() => "") : "";
    let actionCandidates = [];
    try {
      const parsed = JSON.parse(await fs.readFile(inputPaths.actionCandidatesPath, "utf8"));
      actionCandidates = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.candidates) ? parsed.candidates : []);
    } catch (_error) { actionCandidates = []; }
    const handleSec = Number.isFinite(Number(this.settings.sourceUnderstandingChunkHandleSec))
      ? Math.max(0, Math.min(10, Number(this.settings.sourceUnderstandingChunkHandleSec)))
      : MapReduce.DEFAULT_HANDLE_SEC;
    const tasks = MapReduce.buildMapTasks({
      expectedProxyList,
      cues: parseSrtForContext(transcriptText),
      scenes: Array.isArray(sceneManifest?.scenes) ? sceneManifest.scenes : [],
      actionCandidates,
      videoDurationSec,
      handleSec
    });
    const chunkKeys = tasks.map((task) => MapReduce.computeChunkKey({ task, sourceFingerprint, proxySchemaVersion: packageInfo.cache?.proxySchemaVersion }));
    const reducer = MapReduce.computeReducerKey({ sourceFingerprint, videoDurationSec, chunkKeys: chunkKeys.map((item) => item.key) });
    return { tasks, chunkKeys, reducer };
  }

  /**
   * Phase A, chunked MAP/REDUCE (default architecture).
   *   MAP: one AGY process per proxy chunk (bounded concurrency), each with only
   *        its own transcript/scene/action slice; result cached per chunk.
   *   REDUCE: one TEXT-ONLY AGY process over the chunk JSONs; any tool call
   *        other than writing source-understanding.json kills it (view_file = FAIL).
   * A failed chunk fails only itself: valid chunks are cached and never rewatched.
   */
  async runChunkedSourceUnderstanding({ pass1Dir, packageInfo, resultDir, schemaPath, expectedProxyList, videoDurationSec, inputPaths, sourceFingerprint, cacheDir, onProgress, logs }) {
    const startedAt = Date.now();
    const concurrency = resolveMapConcurrency(this.settings);
    const { tasks, chunkKeys, reducer } = await this.prepareChunkedPhaseA({ packageInfo, inputPaths, expectedProxyList, videoDurationSec, sourceFingerprint });
    const expectedProxyFiles = expectedProxyList.map((proxy) => proxy.filename);
    const maxChunkSec = Math.max(...tasks.map((task) => task.sourceEndSec - task.sourceStartSec));
    const timeouts = MapReduce.resolveMapReduceTimeouts(this.settings, { chunkDurationSec: maxChunkSec });
    const totals = newMetrics();
    const diagnostics = {
      architecture: "chunked_map_reduce",
      cacheHit: false,
      cacheStatus: "miss",
      cacheKey: reducer.key,
      cachePath: "",
      phaseASkipped: false,
      timeouts,
      map: {
        chunkCount: tasks.length,
        concurrency,
        maxConcurrentAgyProcesses: 0,
        durationMs: 0,
        cacheHits: 0,
        cacheMisses: 0,
        agyProcessCount: 0,
        viewFileCount: 0,
        duplicateVideoViewCount: 0,
        failedChunkCount: 0,
        chunks: []
      },
      reduce: {
        cacheHit: false,
        durationMs: 0,
        agyProcessCount: 0,
        videoViewFileCount: 0,
        viewFileCount: 0,
        retryCount: 0,
        inputChars: 0,
        failureKinds: []
      },
      totalDurationMs: 0,
      authChecks: [],
      failureKinds: []
    };
    const finalize = () => {
      diagnostics.totalDurationMs = Date.now() - startedAt;
      const videoReads = Object.entries(totals.fileReads).filter(([name]) => /\.(mp4|mov|webm|m4v)$/i.test(name));
      Object.assign(diagnostics, {
        durationMs: diagnostics.totalDurationMs,
        agyProcessCount: totals.agyProcessCount,
        viewFileCount: totals.viewFileVideoCount,
        videoViewFileCount: totals.viewFileVideoCount,
        textViewFileCount: totals.viewFileTextCount,
        duplicateVideoViewCount: videoReads.reduce((sum, [, count]) => sum + Math.max(0, count - 1), 0),
        transcriptReadCount: Object.entries(totals.fileReads).filter(([name]) => /transcript|\.srt$/i.test(name)).reduce((sum, [, count]) => sum + count, 0),
        manifestReadCount: Object.entries(totals.fileReads).filter(([name]) => /manifest/i.test(name)).reduce((sum, [, count]) => sum + count, 0),
        agentTurnCount: totals.agentTurns,
        // A rewatch = a second map process for a chunk whose earlier process had already viewed video.
        fullMultimodalRestartCount: diagnostics.map.chunks.reduce((sum, chunk) => sum + (chunk.rewatchCount || 0), 0),
        serializationRepairUsed: diagnostics.map.chunks.some((chunk) => chunk.serializationRepairUsed) ? "map_chunk_short_repair" : false,
        timeoutOccurred: diagnostics.failureKinds.some((kind) => /timeout/.test(kind)),
        retryCount: totals.retryCount,
        inputTokens: totals.usageReported ? totals.inputTokens : null,
        outputTokens: totals.usageReported ? totals.outputTokens : null,
        thinkingTokens: totals.usageReported ? totals.thinkingTokens : null,
        cacheReadTokens: totals.usageReported ? totals.cacheReadTokens : null,
        modelSeconds: totals.usageReported ? Number(totals.modelSeconds.toFixed(1)) : null,
        timeoutMs: timeouts.mapChunkTimeoutMs,
        expectedProxyCount: expectedProxyList.length,
        attempts: totals.attempts
      });
      diagnostics.map.duplicateVideoViewCount = diagnostics.map.chunks.reduce((sum, chunk) => sum + (chunk.duplicateVideoViewCount || 0), 0);
      return diagnostics;
    };
    const fail = (error, kind) => {
      error.kind = error.kind || kind;
      error.diagnostics = finalize();
      return error;
    };

    const [globalLoaded, chunkLoads] = await Promise.all([
      loadSourceUnderstanding({ cacheDir, key: reducer.key, components: reducer.components, expectedProxyFiles, videoDurationSec }),
      Promise.all(tasks.map((task, index) => MapReduce.loadChunkUnderstanding({ cacheDir, task, key: chunkKeys[index].key, components: chunkKeys[index].components })))
    ]);
    const chunkStatusLine = tasks.map((task, index) => `${task.chunkId}=${chunkLoads[index].status.toUpperCase()}`).join(" ");

    if (globalLoaded.status === "hit") {
      tasks.forEach((task, index) => {
        diagnostics.map.chunks.push({
          chunkId: task.chunkId, proxyFile: task.proxy.filename, sourceStartSec: task.sourceStartSec, sourceEndSec: task.sourceEndSec,
          cacheKey: chunkKeys[index].key, cacheHit: chunkLoads[index].status === "hit", cacheStatus: chunkLoads[index].status,
          durationMs: 0, agyRuntimeMs: 0, agyProcessCount: 0, viewFileCount: 0, duplicateVideoViewCount: 0, agentTurns: 0,
          inputTokens: null, outputTokens: null, retryCount: 0, rewatchCount: 0, ok: true
        });
      });
      diagnostics.map.cacheHits = chunkLoads.filter((item) => item.status === "hit").length;
      diagnostics.map.cacheMisses = tasks.length - diagnostics.map.cacheHits;
      Object.assign(diagnostics, { cacheHit: true, cacheStatus: "hit", cachePath: globalLoaded.path, phaseASkipped: true });
      diagnostics.reduce.cacheHit = true;
      this.emitLog(onProgress, 18, `[SOURCE_UNDERSTANDING] CACHE HIT key=${reducer.key} (${globalLoaded.path}); chunk cache: ${chunkStatusLine}`, logs);
      this.emitLog(onProgress, 19, `[PHASE_A] SKIPPED: dùng lại understanding (map/reduce) đã xác minh lúc ${globalLoaded.envelope.createdAt}; 0 tiến trình AGY, 0 view_file video.`, logs);
      const cachedCoverage = globalLoaded.envelope.phaseA?.coverage || {};
      return {
        data: globalLoaded.data,
        cacheKey: reducer.key,
        keyComponents: reducer.components,
        coverage: {
          isComplete: true, coveragePercent: 100, totalExpected: expectedProxyList.length, totalViewed: expectedProxyList.length,
          expectedProxyFiles, viewedProxyFiles: cachedCoverage.viewedProxyFiles || expectedProxyFiles, missingProxyFiles: [],
          source: "source_understanding_cache", verifiedAt: globalLoaded.envelope.createdAt, verifiedConversationId: null
        },
        diagnostics: finalize()
      };
    }

    diagnostics.cacheStatus = globalLoaded.status;
    this.emitLog(onProgress, 8, globalLoaded.status === "invalid"
      ? `[SOURCE_UNDERSTANDING] CACHE INVALID (${globalLoaded.reason}) → bỏ qua; chunk cache: ${chunkStatusLine}`
      : `[SOURCE_UNDERSTANDING] CACHE MISS key=${reducer.key}; chunk cache: ${chunkStatusLine}`, logs);
    const pendingCount = chunkLoads.filter((item) => item.status !== "hit").length;
    this.emitLog(onProgress, 10, `[PHASE_A] START map/reduce: ${tasks.length} chunk (${pendingCount} cần xem video, ${tasks.length - pendingCount} cache HIT), song song tối đa ${concurrency}; timeout map ${Math.round(timeouts.mapChunkTimeoutMs / 1000)}s/chunk, reduce ${Math.round(timeouts.reduceTimeoutMs / 1000)}s.`, logs);

    // ---------------------------- MAP ----------------------------------
    const mapStartedAt = Date.now();
    const stopState = { kind: null, reason: "" };
    const pool = { active: 0, maxActive: 0 };
    const mapResults = await runBounded(tasks, concurrency, async (task, index) => {
      try {
        return await this.runMapChunk({
          task, keyInfo: chunkKeys[index], cached: chunkLoads[index], pass1Dir, packageInfo, resultDir, schemaPath, cacheDir,
          timeouts, onProgress, logs, diagnostics, stopState, pool
        });
      } catch (error) {
        return {
          data: null,
          metrics: newMetrics(),
          record: {
            chunkId: task.chunkId, proxyFile: task.proxy.filename, sourceStartSec: task.sourceStartSec, sourceEndSec: task.sourceEndSec,
            cacheKey: chunkKeys[index].key, cacheHit: false, cacheStatus: chunkLoads[index].status, ok: false,
            failureKind: error.kind || "map_error", failureMessage: String(error.message || "").slice(0, 400)
          }
        };
      }
    });
    diagnostics.map.durationMs = Date.now() - mapStartedAt;
    diagnostics.map.maxConcurrentAgyProcesses = pool.maxActive;
    for (const result of mapResults) {
      mergeMetrics(totals, result.metrics);
      diagnostics.map.chunks.push(result.record);
      if (result.record.failureKind) diagnostics.failureKinds.push(result.record.failureKind);
    }
    diagnostics.map.cacheHits = mapResults.filter((result) => result.record.cacheHit).length;
    diagnostics.map.cacheMisses = tasks.length - diagnostics.map.cacheHits;
    diagnostics.map.agyProcessCount = mapResults.reduce((sum, result) => sum + result.metrics.agyProcessCount, 0);
    diagnostics.map.viewFileCount = mapResults.reduce((sum, result) => sum + result.metrics.viewFileVideoCount, 0);
    const failed = mapResults.filter((result) => !result.record.ok);
    diagnostics.map.failedChunkCount = failed.length;
    this.emitLog(onProgress, 40, `[PHASE_A] MAP xong sau ${(diagnostics.map.durationMs / 1000).toFixed(1)}s: ${tasks.length - failed.length}/${tasks.length} chunk hợp lệ, cache HIT ${diagnostics.map.cacheHits}, tiến trình AGY ${diagnostics.map.agyProcessCount}, view_file video ${diagnostics.map.viewFileCount}.`, logs);
    if (failed.length) {
      const okIds = mapResults.filter((result) => result.record.ok).map((result) => result.record.chunkId);
      const error = new Error(
        `[PHASE_A] FAILED: ${failed.length}/${tasks.length} map chunk lỗi: `
        + failed.map((result) => `${result.record.chunkId} (${result.record.failureKind}: ${String(result.record.failureMessage || "").slice(0, 160)})`).join("; ")
        + `. Các chunk hợp lệ đã được cache (${okIds.join(", ") || "không có"}) và sẽ KHÔNG bị xem lại; chạy lại chỉ xem các chunk lỗi. Chưa chạy reducer, không ghi cache toàn cục.`
      );
      const kinds = failed.map((result) => result.record.failureKind);
      throw fail(error, kinds.includes("auth") ? "auth" : kinds.includes("cancelled") ? "cancelled" : kinds[0] || "map_failed");
    }

    // ---------------------------- REDUCE -------------------------------
    const chunks = mapResults.map((result, index) => ({ task: tasks[index], data: result.data }));
    const reduceStartedAt = Date.now();
    const reduceMetrics = newMetrics();
    let reduced;
    try {
      reduced = await this.runReducer({ chunks, pass1Dir, packageInfo, resultDir, schemaPath, videoDurationSec, timeouts, onProgress, logs, diagnostics, metrics: reduceMetrics });
    } catch (error) {
      mergeMetrics(totals, reduceMetrics);
      Object.assign(diagnostics.reduce, {
        durationMs: Date.now() - reduceStartedAt,
        agyProcessCount: reduceMetrics.agyProcessCount,
        videoViewFileCount: reduceMetrics.viewFileVideoCount,
        viewFileCount: reduceMetrics.viewFileVideoCount + reduceMetrics.viewFileTextCount,
        attempts: reduceMetrics.attempts,
        failed: true
      });
      diagnostics.failureKinds.push(error.kind || "reduce_failed");
      error.message = `${error.message} Map chunk cache vẫn giữ nguyên: lần chạy lại chỉ chạy lại reducer (0 view_file video).`;
      throw fail(error, "reduce_failed");
    }
    mergeMetrics(totals, reduceMetrics);
    Object.assign(diagnostics.reduce, {
      durationMs: Date.now() - reduceStartedAt,
      agyProcessCount: reduceMetrics.agyProcessCount,
      videoViewFileCount: reduceMetrics.viewFileVideoCount,
      viewFileCount: reduceMetrics.viewFileVideoCount + reduceMetrics.viewFileTextCount,
      agentTurns: reduceMetrics.agentTurns,
      inputTokens: reduceMetrics.usageReported ? reduceMetrics.inputTokens : null,
      outputTokens: reduceMetrics.usageReported ? reduceMetrics.outputTokens : null,
      attempts: reduceMetrics.attempts,
      eventCount: reduced.data.storyTimeline.length
    });

    // Cache only after parse + schema validation + grounding check.
    const coverage = {
      isComplete: true,
      coveragePercent: 100,
      totalExpected: expectedProxyList.length,
      totalViewed: expectedProxyList.length,
      expectedProxyFiles,
      viewedProxyFiles: expectedProxyFiles,
      missingProxyFiles: [],
      source: "phase_a_map_reduce"
    };
    const saved = await saveSourceUnderstanding({
      cacheDir,
      key: reducer.key,
      components: reducer.components,
      data: reduced.data,
      phaseA: {
        architecture: "chunked_map_reduce",
        model: this.settings.antigravityModel || "",
        videoDurationSec,
        coverage: { isComplete: true, expectedProxyFiles, viewedProxyFiles: expectedProxyFiles },
        chunks: mapResults.map((result) => ({ chunkId: result.record.chunkId, cacheKey: result.record.cacheKey, cacheHit: result.record.cacheHit, cachePath: result.record.cachePath })),
        durationMs: Date.now() - startedAt
      }
    });
    diagnostics.cachePath = saved.path;
    (reduced.warnings || []).forEach((warning) => logs.push(`[PHASE_A] warning: ${warning}`));
    this.emitLog(onProgress, 46, `[PHASE_A] DONE (map/reduce): ${reduced.data.storyTimeline.length} sự kiện toàn cục; map ${(diagnostics.map.durationMs / 1000).toFixed(1)}s, reduce ${(diagnostics.reduce.durationMs / 1000).toFixed(1)}s; view_file video ${totals.viewFileVideoCount}; JSON đã kiểm tra và lưu cache: ${saved.path}`, logs);
    return { data: reduced.data, cacheKey: reducer.key, keyComponents: reducer.components, coverage, diagnostics: finalize() };
  }

  async runMapChunk({ task, keyInfo, cached, pass1Dir, packageInfo, resultDir, schemaPath, cacheDir, timeouts, onProgress, logs, diagnostics, stopState, pool }) {
    const startedAt = Date.now();
    const metrics = newMetrics();
    const label = `PHASE_A_MAP ${task.chunkId}`;
    const record = {
      chunkId: task.chunkId,
      proxyFile: task.proxy.filename,
      sourceStartSec: task.sourceStartSec,
      sourceEndSec: task.sourceEndSec,
      cacheKey: keyInfo.key,
      cacheHit: false,
      cacheStatus: cached.status,
      cacheReason: cached.reason || null,
      cachePath: cached.path,
      transcriptCueCount: task.transcript.length,
      sceneCount: task.scenes.length,
      actionCount: task.actions.length,
      ok: false
    };
    const finish = (extra = {}, data = null) => {
      const videoReads = Object.entries(metrics.fileReads).filter(([name]) => /\.(mp4|mov|webm|m4v)$/i.test(name));
      Object.assign(record, {
        durationMs: Date.now() - startedAt,
        agyRuntimeMs: metrics.attempts.reduce((sum, attempt) => sum + (attempt.durationMs || 0), 0),
        agyProcessCount: metrics.agyProcessCount,
        viewFileCount: metrics.viewFileVideoCount,
        textViewFileCount: metrics.viewFileTextCount,
        duplicateVideoViewCount: videoReads.reduce((sum, [, count]) => sum + Math.max(0, count - 1), 0),
        agentTurns: metrics.agentTurns,
        inputTokens: metrics.usageReported ? metrics.inputTokens : null,
        outputTokens: metrics.usageReported ? metrics.outputTokens : null,
        thinkingTokens: metrics.usageReported ? metrics.thinkingTokens : null,
        retryCount: record.retryCount || 0,
        rewatchCount: record.rewatchCount || 0,
        attempts: metrics.attempts,
        ...extra
      });
      return { record, metrics, data };
    };

    if (cached.status === "hit") {
      this.emitLog(onProgress, 14, `[PHASE_A] MAP ${task.chunkId} CACHE HIT (${task.sourceStartSec.toFixed(1)}-${task.sourceEndSec.toFixed(1)}s): 0 view_file video.`, logs);
      return finish({ ok: true, cacheHit: true }, cached.data);
    }
    if (stopState.kind) {
      return finish({ ok: false, failureKind: stopState.kind, failureMessage: `không chạy: ${stopState.reason}`.slice(0, 400), skipped: true });
    }
    if (this.cancelled) return finish({ ok: false, failureKind: "cancelled", failureMessage: "Đã dừng theo yêu cầu." });
    this.emitLog(onProgress, 12, cached.status === "invalid"
      ? `[PHASE_A] MAP ${task.chunkId} CACHE INVALID (${cached.reason}) → chỉ chạy lại chunk này.`
      : `[PHASE_A] MAP ${task.chunkId} CACHE MISS → xem ${task.proxy.filename} (${task.sourceStartSec.toFixed(1)}-${task.sourceEndSec.toFixed(1)}s).`, logs);

    // Chunk-specific inputs (kept for traceability; the compact context is inlined in the prompt).
    const chunkInputDir = path.join(resultDir, "phase-a-input", task.chunkId);
    await fs.mkdir(chunkInputDir, { recursive: true });
    const srtTime = (value) => {
      const ms = Math.max(0, Math.round(Number(value) * 1000));
      const pad = (number, width = 2) => String(number).padStart(width, "0");
      return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
    };
    const contextText = MapReduce.renderChunkContext(task);
    const contextPath = path.join(chunkInputDir, `${task.chunkId}-context.txt`);
    await Promise.all([
      fs.writeFile(path.join(chunkInputDir, `${task.chunkId}-transcript.srt`), task.transcript.map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`).join("\n"), "utf8"),
      writeJsonAtomic(path.join(chunkInputDir, `${task.chunkId}-scenes.json`), task.scenes),
      writeJsonAtomic(path.join(chunkInputDir, `${task.chunkId}-actions.json`), task.actions),
      fs.writeFile(contextPath, contextText, "utf8")
    ]);
    let prompt = MapReduce.buildMapPrompt({ task, contextText });
    let contextInline = true;
    if (prompt.length > MAX_PRINT_PROMPT_CHARS) {
      contextInline = false;
      prompt = MapReduce.buildMapPrompt({ task, contextPath, contextLineCount: contextText.split("\n").length });
    }
    assertPrintPromptSize(prompt, `Phase A map ${task.chunkId}`);
    Object.assign(record, { promptChars: prompt.length, contextInline });

    const transportName = `chunk-understanding-${task.chunkId}.json`;
    const allowedVideo = path.basename(String(task.proxy.absolutePath).replace(/\\/g, "/")).toLowerCase();
    const allowedContext = contextInline ? null : path.basename(contextPath).toLowerCase();
    const baseOf = (value) => path.basename(String(value || "").replace(/\\/g, "/")).toLowerCase();
    const toolGuard = ({ toolName, file, stepUpdate }) => {
      if (toolName === "view_file") {
        const name = baseOf(file);
        if (name === allowedVideo || (allowedContext && name === allowedContext)) return null;
        return `map ${task.chunkId} chỉ được xem ${task.proxy.filename}`;
      }
      if (toolName === "write_to_file") {
        const target = stepUpdate?.tool_info?.parameters?.TargetFile || file;
        return !target || baseOf(target) === transportName.toLowerCase() ? null : `map ${task.chunkId} chỉ được ghi ${transportName}`;
      }
      return `map ${task.chunkId} không được dùng ${toolName || "công cụ"}`;
    };
    const chunkProgress = (item = {}) => onProgress?.({
      step: item.step || "antigravity_stage1",
      percent: Math.min(40, Math.max(12, Math.round(12 + (Number(item.percent) - 18) * 0.35))),
      message: `[MAP ${task.chunkId}] ${String(item.message || "")}`.slice(0, 220)
    });

    const viewedProxySet = new Set();
    let outcome = null;
    let conversationId = null;
    let stdout = "";
    let videoViewedByEarlierProcess = false;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.ensureAntigravityAuth({ label, diagnostics, onProgress, logs });
      } catch (error) {
        stopState.kind = error.kind || "auth";
        stopState.reason = String(error.message || "").slice(0, 300);
        return finish({ ok: false, failureKind: stopState.kind, failureMessage: stopState.reason });
      }
      if (videoViewedByEarlierProcess) record.rewatchCount = (record.rewatchCount || 0) + 1;
      pool.active += 1;
      pool.maxActive = Math.max(pool.maxActive, pool.active);
      try {
        outcome = await this.runAgyOnce({
          label,
          commandConfig: this.buildCommand(prompt, schemaPath, pass1Dir, { packageInfo, timeoutMs: timeouts.mapChunkTimeoutMs }),
          prompt, resultDir, onProgress: chunkProgress, expectedProxyList: [task.proxy], viewedProxySet, metrics, logs,
          logBase: `map-${task.chunkId}`, toolGuard
        });
      } finally {
        pool.active -= 1;
      }
      const source = outcome.ok ? outcome.result : outcome.error;
      conversationId = source?.conversationId || conversationId;
      stdout += `${stdout ? `\n--- ${label} ATTEMPT ---\n` : ""}${source?.stdout || ""}`;
      if (outcome.ok) break;
      const viewedVideo = viewedProxySet.size > 0 || metrics.viewFileVideoCount > 0;
      videoViewedByEarlierProcess = videoViewedByEarlierProcess || viewedVideo;
      if (outcome.kind === "auth") {
        stopState.kind = "auth";
        stopState.reason = describeAgyFailure("auth", outcome.error);
        return finish({ ok: false, failureKind: "auth", failureMessage: stopState.reason });
      }
      if (outcome.kind === "cancelled") return finish({ ok: false, failureKind: "cancelled", failureMessage: "Đã dừng theo yêu cầu." });
      // Capacity before this chunk's video was viewed: nothing was watched yet, a fresh process is free.
      if (outcome.kind === "capacity" && !viewedVideo && attempt < 2 && !this.cancelled) {
        record.retryCount = (record.retryCount || 0) + 1;
        metrics.retryCount += 1;
        const delayMs = this.capacityRetryDelayMs(attempt);
        this.emitLog(onProgress, 14, `[PHASE_A] MAP ${task.chunkId} 503/UNAVAILABLE trước khi xem video. Thử lại tiến trình mới sau ${Math.round(delayMs / 1000)}s (${attempt + 1}/2)...`, logs);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      break;
    }
    await fs.writeFile(path.join(resultDir, `antigravity-output-map-${task.chunkId}.log`), stdout, "utf8").catch(() => {});

    const coverage = await auditTranscriptForViewedProxies(conversationId, [task.proxy], viewedProxySet);
    const parse = async (text) => {
      const raw = await extractNamedArtifact(text, { filename: transportName, artifactType: "source_chunk_understanding", resultDir });
      if (!raw) return { data: null, validation: { ok: false, errors: [`Không tìm thấy ${transportName} trong output.`], warnings: [] } };
      const data = MapReduce.normalizeChunkUnderstanding(raw, task);
      return { data, validation: MapReduce.validateChunkUnderstanding(data, task) };
    };
    const failureMessageOf = () => (outcome.ok ? "" : describeAgyFailure(outcome.kind, outcome.error));
    if (!coverage.isComplete) {
      const kind = outcome.ok ? "coverage" : outcome.kind;
      const message = `${failureMessageOf() ? `${failureMessageOf()} ` : ""}AGY chưa xem video ${task.proxy.filename} bằng view_file; JSON (nếu có) bị từ chối, không ghi cache.`;
      this.emitLog(onProgress, 30, `[PHASE_A] MAP ${task.chunkId} FAILED (${kind}): ${message}`, logs);
      return finish({ ok: false, failureKind: kind, failureMessage: message.slice(0, 400) });
    }
    let parsed = await parse(stdout);
    if (!parsed.validation.ok && conversationId && this.settings.sourceUnderstandingMapSerializationRepair === true && !this.cancelled) {
      // Opt-in only: a SHORT same-conversation serialization (tools forbidden).
      // The 2026-10-07 global run showed this does not help when the model turn
      // itself is failing server-side, so it is off by default.
      record.serializationRepairUsed = true;
      this.emitLog(onProgress, 32, `[PHASE_A] MAP ${task.chunkId}: video đã xem nhưng JSON chưa hợp lệ; thử serialize ngắn (${Math.round(timeouts.mapSerializationTimeoutMs / 1000)}s, cấm công cụ).`, logs);
      const repairPrompt = assertPrintPromptSize([
        `Return ONLY the ${transportName} transport JSON for ${task.chunkId} now, from what you already watched. Do not call any tool.`,
        ...parsed.validation.errors.slice(0, 6).map((error) => `- ${error}`)
      ].join("\n"), `Phase A map ${task.chunkId} repair`);
      const repair = await this.runAgyOnce({
        label: `${label} REPAIR`,
        commandConfig: this.buildRetryCommand(conversationId, repairPrompt, pass1Dir, { packageInfo, timeoutMs: timeouts.mapSerializationTimeoutMs }),
        prompt: repairPrompt, resultDir, onProgress: chunkProgress, expectedProxyList: [], viewedProxySet: new Set(), metrics, logs,
        logBase: `map-${task.chunkId}-repair`,
        forbiddenTools: ["view_file", "run_command", "grep_search", "find_by_name", "list_dir", "codebase_search"]
      });
      const source = repair.ok ? repair.result : repair.error;
      parsed = await parse(source?.stdout || "");
    }
    if (!parsed.validation.ok) {
      const kind = outcome.ok ? "invalid_json" : outcome.kind;
      const message = `${failureMessageOf() ? `${failureMessageOf()} ` : ""}Đã xem video chunk nhưng chunk JSON không hợp lệ (${parsed.validation.errors.slice(0, 3).join(" ")}). Chỉ chunk này lỗi; không ghi cache.`;
      this.emitLog(onProgress, 30, `[PHASE_A] MAP ${task.chunkId} FAILED (${kind}): ${message}`, logs);
      return finish({ ok: false, failureKind: kind, failureMessage: message.slice(0, 400) });
    }
    const savedPath = await MapReduce.saveChunkUnderstanding({
      cacheDir,
      task,
      key: keyInfo.key,
      components: keyInfo.components,
      data: parsed.data,
      map: {
        videoViewed: true,
        viewedProxyFiles: coverage.viewedProxyFiles,
        conversationId: conversationId || null,
        model: this.settings.antigravityModel || "",
        durationMs: Date.now() - startedAt,
        agyProcessCount: metrics.agyProcessCount,
        videoViewFileCount: metrics.viewFileVideoCount
      }
    });
    this.emitLog(onProgress, 36, `[PHASE_A] MAP ${task.chunkId} DONE: ${parsed.data.importantEvents.length} sự kiện, view_file video=${metrics.viewFileVideoCount}, ${((Date.now() - startedAt) / 1000).toFixed(1)}s. JSON đã kiểm tra và lưu cache: ${savedPath}`, logs);
    record.cachePath = savedPath;
    return finish({ ok: true, warnings: parsed.validation.warnings }, parsed.data);
  }

  async runReducer({ chunks, pass1Dir, packageInfo, resultDir, schemaPath, videoDurationSec, timeouts, onProgress, logs, diagnostics, metrics }) {
    const label = "PHASE_A_REDUCE";
    const overhead = MapReduce.buildReducePrompt({ reducerInput: "", videoDurationSec, chunkCount: chunks.length, schemaExample: SOURCE_UNDERSTANDING_SCHEMA_EXAMPLE, errors: ["x".repeat(900)] }).length;
    const { text: reducerInput, overBudget } = MapReduce.renderReducerInputWithinBudget(chunks, MAX_PRINT_PROMPT_CHARS - overhead - 200);
    diagnostics.reduce.inputChars = reducerInput.length;
    const inputDir = path.join(resultDir, "phase-a-input");
    await fs.mkdir(inputDir, { recursive: true });
    await fs.writeFile(path.join(inputDir, "reducer-input.txt"), reducerInput, "utf8");
    if (overBudget) {
      const error = new Error(`[${label}] FAILED: ${chunks.length} chunk understanding quá lớn cho prompt reducer (${reducerInput.length} ký tự).`);
      error.kind = "reduce_input_too_large";
      throw error;
    }
    const toolGuard = ({ toolName, file, stepUpdate }) => {
      if (toolName === "write_to_file") {
        const target = stepUpdate?.tool_info?.parameters?.TargetFile || file;
        if (!target || path.basename(String(target).replace(/\\/g, "/")).toLowerCase() === "source-understanding.json") return null;
      }
      return `reducer TEXT-ONLY: ${toolName || "công cụ"} bị cấm`;
    };
    const reduceProgress = (item = {}) => onProgress?.({
      step: item.step || "antigravity_stage1",
      percent: Math.min(45, Math.max(41, Math.round(41 + (Number(item.percent) - 18) * 0.05))),
      message: `[REDUCE] ${String(item.message || "")}`.slice(0, 220)
    });
    this.emitLog(onProgress, 41, `[PHASE_A] REDUCE START (text-only, ${reducerInput.length} ký tự từ ${chunks.length} chunk; timeout ${Math.round(timeouts.reduceTimeoutMs / 1000)}s).`, logs);
    let errors = [];
    let capacityRetries = 0;
    let repairs = 0;
    for (;;) {
      await this.ensureAntigravityAuth({ label, diagnostics, onProgress, logs });
      const prompt = assertPrintPromptSize(MapReduce.buildReducePrompt({
        reducerInput, videoDurationSec, chunkCount: chunks.length, schemaExample: SOURCE_UNDERSTANDING_SCHEMA_EXAMPLE, errors
      }), "Phase A reduce");
      const outcome = await this.runAgyOnce({
        label,
        commandConfig: this.buildCommand(prompt, schemaPath, pass1Dir, { packageInfo, timeoutMs: timeouts.reduceTimeoutMs }),
        prompt, resultDir, onProgress: reduceProgress, expectedProxyList: [], viewedProxySet: new Set(), metrics, logs,
        logBase: "phaseA-reduce", toolGuard
      });
      if (!outcome.ok) {
        diagnostics.reduce.failureKinds.push(outcome.kind);
        if (outcome.kind === "capacity" && capacityRetries < 2 && !this.cancelled) {
          const delayMs = this.capacityRetryDelayMs(capacityRetries);
          capacityRetries += 1;
          diagnostics.reduce.retryCount += 1;
          metrics.retryCount += 1;
          this.emitLog(onProgress, 42, `[${label}] 503/UNAVAILABLE. Reducer chỉ dùng văn bản; thử lại sau ${Math.round(delayMs / 1000)}s (${capacityRetries}/2)...`, logs);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        const error = new Error(`[${label}] FAILED: ${describeAgyFailure(outcome.kind, outcome.error)}`);
        error.kind = outcome.kind === "forbidden_tool" ? "reduce_forbidden_tool" : outcome.kind;
        throw error;
      }
      const raw = await extractNamedArtifact(outcome.result.stdout, { filename: "source-understanding.json", artifactType: "source_understanding", resultDir });
      const parsed = this.normalizeUnderstanding(raw, videoDurationSec);
      const groundingErrors = parsed.validation.ok ? MapReduce.validateReducerGrounding(parsed.data, chunks) : [];
      if (parsed.validation.ok && !groundingErrors.length) {
        return { data: parsed.data, warnings: parsed.validation.warnings };
      }
      errors = [...parsed.validation.errors, ...groundingErrors];
      diagnostics.reduce.failureKinds.push("invalid_json");
      if (repairs < 1 && !this.cancelled) {
        repairs += 1;
        diagnostics.reduce.retryCount += 1;
        metrics.retryCount += 1;
        this.emitLog(onProgress, 43, `[${label}] JSON chưa hợp lệ (${errors.slice(0, 2).join(" ")}). Chạy lại reducer text-only một lần (không có video).`, logs);
        continue;
      }
      const error = new Error(`[${label}] FAILED: source-understanding từ reducer không hợp lệ (${errors.slice(0, 4).join(" ")}).`);
      error.kind = "reduce_invalid";
      throw error;
    }
  }

  normalizeUnderstanding(data, videoDurationSec) {
    if (!data || typeof data !== "object") {
      return { data: null, validation: { ok: false, errors: ["Không tìm thấy source-understanding.json trong output."], warnings: [] } };
    }
    const normalized = {
      ...data,
      artifactType: data.artifactType || (Array.isArray(data.storyTimeline) ? "source_understanding" : data.artifactType),
      schemaVersion: SOURCE_UNDERSTANDING_SCHEMA_VERSION,
      videoDurationSec: Number(data.videoDurationSec) || videoDurationSec
    };
    return { data: normalized, validation: validateSourceUnderstanding(normalized, { videoDurationSec }) };
  }

  async runSeriesPlan({ series, pass1Dir, packageInfo, resultDir, schemaPath, understandingPath, inputPaths, videoDurationSec, onProgress, metrics, logs }) {
    const prompt = assertPrintPromptSize(buildSeriesPlanPrompt({
      series,
      understandingPath,
      hookContractPath: inputPaths.hookContractPath,
      transcriptPath: inputPaths.transcriptPath,
      sceneManifestPath: inputPaths.sceneManifestPath,
      videoDurationSec
    }), "Series plan");
    const commandConfig = this.buildCommand(prompt, schemaPath, pass1Dir, {
      packageInfo,
      timeoutMs: resolvePhaseTimeoutMs("series_plan", this.settings)
    });
    const videoViews = new Set();
    const result = await this.runAgyPhase({
      label: "SERIES_PLAN", commandConfig, prompt, resultDir, onProgress,
      expectedProxyList: [], viewedProxySet: videoViews, metrics, logs, logBase: "seriesPlan"
    });
    let stdout = result.stdout || "";
    let conversationId = result.conversationId;
    const parse = async () => {
      const plan = await extractNamedArtifact(stdout, { filename: "series-plan.json", artifactType: "series_plan", resultDir });
      const normalized = plan ? { ...plan, artifactType: plan.artifactType || "series_plan", profile: series.profile } : null;
      return { plan: normalized, validation: validateSeriesPlan(normalized, { series, videoDurationSec }) };
    };
    let parsed = await parse();
    if (!parsed.validation.ok && conversationId) {
      metrics.retryCount += 1;
      this.emitLog(onProgress, 56, `[SERIES_PLAN] Plan chưa hợp lệ (${parsed.validation.errors.slice(0, 2).join(" ")}). Yêu cầu sửa trong cùng hội thoại...`, logs);
      const repairPrompt = [
        "Your series plan was rejected by the host validator:",
        ...parsed.validation.errors.slice(0, 12).map((error) => `- ${error}`),
        "Return the COMPLETE corrected series-plan envelope now, exactly one JSON object, no prose. Do not open any .mp4 file."
      ].join("\n");
      const retryConfig = this.buildRetryCommand(conversationId, repairPrompt, pass1Dir, {
        packageInfo,
        timeoutMs: resolvePhaseTimeoutMs("series_plan", this.settings)
      });
      const retry = await this.runAgyPhase({
        label: "SERIES_PLAN_REPAIR", commandConfig: retryConfig, prompt: repairPrompt, resultDir, onProgress,
        expectedProxyList: [], viewedProxySet: videoViews, metrics, logs, logBase: "seriesPlan-retry"
      });
      stdout += `\n--- SERIES_PLAN_REPAIR ---\n${retry.stdout || ""}`;
      conversationId = retry.conversationId || conversationId;
      parsed = await parse();
    }
    await fs.writeFile(path.join(resultDir, "antigravity-output-seriesPlan.log"), stdout, "utf8");
    if (!parsed.validation.ok) {
      throw new Error(`[SERIES_PLAN] FAILED: series-plan.json không hợp lệ (${parsed.validation.errors.slice(0, 4).join(" ")}). Không sinh kịch bản khi plan chưa khóa.`);
    }
    const locked = { ...parsed.plan, lockedAt: new Date().toISOString(), lockedBy: "host_validator" };
    return { plan: locked, videoViews: videoViews.size };
  }

  async run({ packageDir, onProgress } = {}) {
    const stage1StartedAt = Date.now();
    this.cancelled = false;
    const logs = [];
    const resolvedPackageDir = path.resolve(String(packageDir || ""));
    if (!packageDir) throw new Error("Hãy tạo gói phân tích GĐ1 trước khi chạy Antigravity.");
    const packageInfo = await readPackageInfo(resolvedPackageDir);
    const pass1Dir = path.resolve(packageInfo.pass1UploadDir || path.join(resolvedPackageDir, "01-GUI-GEMINI"));
    const expectedPass1 = path.join(resolvedPackageDir, "01-GUI-GEMINI");
    if (pass1Dir !== path.resolve(expectedPass1)) {
      throw new Error("package-info.json chứa đường dẫn GĐ1 không hợp lệ.");
    }
    const promptPath = path.resolve(packageInfo.promptPath || path.join(pass1Dir, "01-gemini-highlight-scripts-prompt.txt"));
    if (path.dirname(promptPath) !== pass1Dir) {
      throw new Error("Prompt GĐ1 phải nằm trực tiếp trong thư mục 01-GUI-GEMINI.");
    }
    await fs.access(promptPath);
    const promptText = await fs.readFile(promptPath, "utf8");
    const requestedScriptIds = getRequestedScriptIds(promptText);
    const series = detectSeriesProfile(promptText);
    const resultDir = path.join(resolvedPackageDir, RESULT_DIR_NAME);
    await fs.mkdir(resultDir, { recursive: true });
    // Clean up all existing files in resultDir so Antigravity starts with a pristine workspace.
    // The persistent source understanding does NOT live here (see sourceUnderstandingService).
    try {
      const existingResultFiles = await fs.readdir(resultDir);
      await Promise.all(existingResultFiles.map((file) => fs.rm(path.join(resultDir, file), { recursive: true, force: true })));
    } catch (_err) {}
    const schemaPath = path.join(resultDir, "antigravity-output-schema.json");
    await writeJsonAtomic(schemaPath, buildOutputSchema(requestedScriptIds));

    const expectedProxyList = await getExpectedProxyList(pass1Dir, packageInfo);
    if (!expectedProxyList.length) {
      throw new Error("Gói GĐ1 không có proxy video nào để AI xem. Hãy bấm Tạo gói lại.");
    }
    const inputPaths = {
      sceneManifestPath: [packageInfo.manifestPath, path.join(pass1Dir, "scene-manifest.json")].find((item) => item && fsSync.existsSync(item)) || "",
      transcriptPath: [packageInfo.transcriptPath, path.join(pass1Dir, "source-transcript.srt")].find((item) => item && fsSync.existsSync(item)) || "",
      hookContractPath: [packageInfo.hookContractPath, path.join(pass1Dir, "hook-contract.json")].find((item) => item && fsSync.existsSync(item)) || "",
      actionCandidatesPath: [packageInfo.actionCandidatesPath, path.join(pass1Dir, "action-candidates.json")].find((item) => item && fsSync.existsSync(item)) || ""
    };
    let videoDurationSec = 0;
    try {
      videoDurationSec = Number(JSON.parse(await fs.readFile(inputPaths.sceneManifestPath, "utf8")).videoDurationSec) || 0;
    } catch (_error) {
      videoDurationSec = Number(expectedProxyList.at(-1)?.sourceEndSec) || 0;
    }

    // ---------------------------------------------------------------------
    // Persistent source-understanding cache (survives package rebuilds).
    // ---------------------------------------------------------------------
    const sourceFingerprint = packageInfo.cache?.sourceFingerprint
      || (packageInfo.sourceVideoPath ? (await buildSourceFingerprint(packageInfo.sourceVideoPath)).key : "");
    if (!sourceFingerprint) throw new Error("package-info.json thiếu sourceFingerprint và sourceVideoPath. Hãy bấm Tạo gói lại.");
    const cacheDir = packageInfo.cache?.cacheDir
      || path.join(this.settings.workspaceRoot || path.dirname(resolvedPackageDir), ".cineviral", "cache", "gemini-analysis", sourceFingerprint);
    const expectedProxyFiles = expectedProxyList.map((proxy) => proxy.filename);
    const watchedSourceSec = Number(expectedProxyList.reduce((sum, proxy) => (
      sum + Math.max(0, Number(proxy.sourceEndSec ?? 0) - Number(proxy.sourceStartSec ?? 0))
    ), 0).toFixed(3)) || videoDurationSec;

    const architecture = resolveSourceUnderstandingArchitecture(this.settings);
    let understandingKey = null;
    let understandingComponents = null;
    let understanding;
    let coverage;
    const timing = {
      artifactType: "pipeline_timing",
      schemaVersion: 1,
      packageDir: resolvedPackageDir,
      model: this.settings.antigravityModel || "",
      preprocessMs: Number(packageInfo.timings?.preprocessMs) || 0,
      sourceUnderstanding: {
        cacheHit: false,
        cacheStatus: "miss",
        architecture,
        cacheKey: null,
        cachePath: "",
        durationMs: 0,
        agyProcessCount: 0,
        viewFileCount: 0,
        videoViewFileCount: 0,
        expectedProxyCount: expectedProxyList.length,
        viewedProxyCount: 0,
        watchedSourceSec: 0,
        retryCount: 0,
        phaseASkipped: false,
        proxyCount: expectedProxyList.length,
        sourceVideoDurationSec: Number(Number(videoDurationSec || 0).toFixed(3))
      },
      seriesPlan: null,
      scriptGeneration: { durationMs: 0, agyProcessCount: 0 }
    };

    if (architecture === "chunked_map_reduce") {
      try {
        const chunked = await this.runChunkedSourceUnderstanding({
          pass1Dir, packageInfo, resultDir, schemaPath, expectedProxyList, videoDurationSec, inputPaths,
          sourceFingerprint, cacheDir, onProgress, logs
        });
        understanding = chunked.data;
        coverage = chunked.coverage;
        understandingKey = chunked.cacheKey;
        understandingComponents = chunked.keyComponents;
        Object.assign(timing.sourceUnderstanding, chunked.diagnostics, {
          viewedProxyCount: chunked.diagnostics.cacheHit ? 0 : chunked.diagnostics.map.cacheMisses,
          watchedSourceSec: chunked.diagnostics.cacheHit ? 0 : Number(chunked.diagnostics.map.chunks.filter((chunk) => !chunk.cacheHit).reduce((sum, chunk) => sum + (chunk.sourceEndSec - chunk.sourceStartSec), 0).toFixed(3))
        });
      } catch (error) {
        Object.assign(timing.sourceUnderstanding, error.diagnostics || {}, {
          failed: true,
          failureKind: error.kind || classifyAgyFailure(error),
          failureMessage: String(error.message || "").slice(0, 900)
        });
        const su = timing.sourceUnderstanding;
        this.emitLog(onProgress, 40, `[PHASE_A] FAILED (${su.failureKind}) sau ${((su.totalDurationMs || 0) / 1000).toFixed(1)}s; view_file video=${su.viewFileCount ?? 0}, tiến trình AGY=${su.agyProcessCount ?? 0}, chunk lỗi=${su.map?.failedChunkCount ?? "?"}, rewatch=${su.fullMultimodalRestartCount ?? 0}.`, logs);
        await this.writeTimingReport({ resolvedPackageDir, resultDir, timing, logs, stage1StartedAt }).catch(() => {});
        throw error;
      }
    } else {
      ({ key: understandingKey, components: understandingComponents } = await computeSourceUnderstandingKey({
        sourceFingerprint,
        expectedProxyList,
        sceneManifestPath: inputPaths.sceneManifestPath,
        transcriptPath: inputPaths.transcriptPath,
        proxySchemaVersion: packageInfo.cache?.proxySchemaVersion
      }));
      timing.sourceUnderstanding.cacheKey = understandingKey;
      const phaseAMetrics = newMetrics();
      const phaseADiagnostics = {
        authChecks: [],
        failureKinds: [],
        timeoutOccurred: false,
        serializationRepairUsed: false,
        serializationVideoViews: 0,
        freshRetryBeforeAnyVideoCount: 0,
        coverage: null,
        contextFile: null,
        timeoutMs: null
      };
      const loaded = await loadSourceUnderstanding({
        cacheDir,
        key: understandingKey,
        components: understandingComponents,
        expectedProxyFiles,
        videoDurationSec
      });
      if (loaded.status === "hit") {
        understanding = loaded.data;
        const cachedCoverage = loaded.envelope.phaseA?.coverage || {};
        coverage = {
          isComplete: true,
          coveragePercent: 100,
          totalExpected: expectedProxyList.length,
          totalViewed: expectedProxyList.length,
          expectedProxyFiles,
          viewedProxyFiles: cachedCoverage.viewedProxyFiles || expectedProxyFiles,
          missingProxyFiles: [],
          source: "source_understanding_cache",
          verifiedAt: loaded.envelope.createdAt,
          verifiedConversationId: loaded.envelope.phaseA?.conversationId || null
        };
        Object.assign(timing.sourceUnderstanding, {
          cacheHit: true,
          cacheStatus: "hit",
          cachePath: loaded.path,
          phaseASkipped: true,
          viewedProxyCount: 0,
          watchedSourceSec: 0
        });
        this.emitLog(onProgress, 18, `[SOURCE_UNDERSTANDING] CACHE HIT key=${understandingKey} (${loaded.path})`, logs);
        this.emitLog(onProgress, 19, `[PHASE_A] SKIPPED: dùng lại understanding đã xác minh lúc ${loaded.envelope.createdAt}; 0 view_file video toàn nguồn.`, logs);
      } else {
        timing.sourceUnderstanding.cacheStatus = loaded.status;
        this.emitLog(
          onProgress,
          8,
          loaded.status === "invalid"
            ? `[SOURCE_UNDERSTANDING] CACHE INVALID (${loaded.reason}) → bỏ qua file cache, chạy lại Phase A.`
            : `[SOURCE_UNDERSTANDING] CACHE MISS key=${understandingKey}`,
          logs
        );
        this.emitLog(onProgress, 10, `[PHASE_A] START: AI xem ${expectedProxyList.length} proxy (~${(watchedSourceSec / 60).toFixed(1)} phút nguồn).`, logs);
        const phaseAStartedAt = Date.now();
        let phaseA;
        try {
          phaseA = await this.runPhaseA({
            pass1Dir, packageInfo, resultDir, schemaPath, expectedProxyList, videoDurationSec, inputPaths,
            onProgress, metrics: phaseAMetrics, logs, diagnostics: phaseADiagnostics
          });
        } catch (error) {
          Object.assign(timing.sourceUnderstanding, summarizePhaseA(phaseAMetrics, phaseADiagnostics), {
            durationMs: Date.now() - phaseAStartedAt,
            failed: true,
            failureKind: error.kind || classifyAgyFailure(error),
            failureMessage: String(error.message || "").slice(0, 600)
          });
          this.emitLog(onProgress, 40, `[PHASE_A] FAILED (${timing.sourceUnderstanding.failureKind}) sau ${(timing.sourceUnderstanding.durationMs / 1000).toFixed(1)}s; view_file video=${timing.sourceUnderstanding.viewFileCount}, tiến trình AGY=${phaseAMetrics.agyProcessCount}, restart toàn bộ=0.`, logs);
          await this.writeTimingReport({ resolvedPackageDir, resultDir, timing, logs, stage1StartedAt }).catch(() => {});
          throw error;
        }
        understanding = phaseA.data;
        coverage = { ...phaseA.coverage, source: "phase_a_live" };
        const saved = await saveSourceUnderstanding({
          cacheDir,
          key: understandingKey,
          components: understandingComponents,
          data: understanding,
          phaseA: {
            conversationId: phaseA.conversationId || null,
            model: this.settings.antigravityModel || "",
            videoDurationSec,
            coverage: {
              isComplete: phaseA.coverage.isComplete,
              expectedProxyFiles: phaseA.coverage.expectedProxyFiles,
              viewedProxyFiles: phaseA.coverage.viewedProxyFiles
            },
            durationMs: Date.now() - phaseAStartedAt
          }
        });
        Object.assign(timing.sourceUnderstanding, {
          cachePath: saved.path,
          durationMs: Date.now() - phaseAStartedAt,
          viewedProxyCount: phaseA.coverage.totalViewed,
          watchedSourceSec
        });
        (phaseA.warnings || []).forEach((warning) => logs.push(`[PHASE_A] warning: ${warning}`));
        this.emitLog(onProgress, 46, `[PHASE_A] DONE: ${phaseA.coverage.totalViewed}/${expectedProxyList.length} proxy, ${phaseAMetrics.agyProcessCount} tiến trình AGY. Đã lưu cache: ${saved.path}`, logs);
      }
      Object.assign(timing.sourceUnderstanding, summarizePhaseA(phaseAMetrics, phaseADiagnostics));
    }

    // Phase B inputs are files (command-line length limit); the persistent
    // understanding is copied next to the run so the agent can read it.
    const phaseBInputDir = path.join(resultDir, "phase-b-input");
    await fs.mkdir(phaseBInputDir, { recursive: true });
    const understandingPath = path.join(phaseBInputDir, "source-understanding.json");
    await writeJsonAtomic(understandingPath, understanding);
    const coverageSummary = `${coverage.viewedProxyFiles.length}/${expectedProxyList.length} proxy chunks, ${coverage.source}${coverage.verifiedAt ? ` verified ${coverage.verifiedAt}` : ""}`;

    // ---------------------------------------------------------------------
    // Phase B1: lock the series plan before any Part is written.
    // ---------------------------------------------------------------------
    let seriesPlan = null;
    let seriesPlanPath = "";
    if (series) {
      const planMetrics = newMetrics();
      const planStartedAt = Date.now();
      this.emitLog(onProgress, 50, `[SERIES_PLAN] START: khóa kế hoạch ${series.parts.length} Part (${series.profile}) trước khi viết kịch bản.`, logs);
      const planned = await this.runSeriesPlan({
        series, pass1Dir, packageInfo, resultDir, schemaPath, understandingPath, inputPaths, videoDurationSec, onProgress, metrics: planMetrics, logs
      });
      seriesPlan = planned.plan;
      seriesPlanPath = path.join(resultDir, "series-plan.json");
      await writeJsonAtomic(seriesPlanPath, seriesPlan);
      await writeJsonAtomic(path.join(phaseBInputDir, "series-plan.json"), seriesPlan);
      timing.seriesPlan = {
        durationMs: Date.now() - planStartedAt,
        agyProcessCount: planMetrics.agyProcessCount,
        retryCount: planMetrics.retryCount,
        videoViewFileCount: planMetrics.viewFileVideoCount,
        tokens: tokenSummary(planMetrics),
        path: seriesPlanPath
      };
      this.emitLog(onProgress, 58, `[SERIES_PLAN] LOCKED: ${seriesPlanPath}`, logs);
    }

    // ---------------------------------------------------------------------
    // Phase B2: script generation from the verified understanding (text only).
    // ---------------------------------------------------------------------
    const phaseBMetrics = newMetrics();
    const startPhaseB = Date.now();
    this.emitLog(onProgress, 60, "[PHASE_B] START: sinh kịch bản từ source-understanding (không xem lại toàn bộ video).", logs);
    const promptB = assertPrintPromptSize(buildScriptGenerationPrompt({
      promptPath,
      understandingPath,
      seriesPlanPath: seriesPlan ? path.join(phaseBInputDir, "series-plan.json") : "",
      sceneManifestPath: inputPaths.sceneManifestPath,
      transcriptPath: inputPaths.transcriptPath,
      hookContractPath: inputPaths.hookContractPath,
      actionCandidatesPath: inputPaths.actionCandidatesPath,
      resultDir,
      scriptIds: requestedScriptIds,
      coverageSummary
    }), "Phase B");
    const commandConfigB = this.buildCommand(promptB, schemaPath, pass1Dir, {
      packageInfo,
      timeoutMs: resolvePhaseTimeoutMs("phase_b", this.settings)
    });
    // Phase B video views are tracked (not expected): a silent full-source rewatch must be visible.
    const phaseBVideoViews = new Set();
    let cliResultB;
    try {
      cliResultB = await this.runAgyPhase({
        label: "PHASE_B", commandConfig: commandConfigB, prompt: promptB, resultDir, onProgress,
        expectedProxyList: [], viewedProxySet: phaseBVideoViews, metrics: phaseBMetrics, logs, logBase: "phaseB"
      });
    } catch (error) {
      timing.scriptGeneration = {
        durationMs: Date.now() - startPhaseB,
        agyProcessCount: phaseBMetrics.agyProcessCount,
        failed: true,
        failureKind: error.kind || null,
        failureMessage: String(error.message || "").slice(0, 600),
        timeoutMs: commandConfigB.timeoutMs,
        attempts: phaseBMetrics.attempts,
        tokens: tokenSummary(phaseBMetrics)
      };
      await this.writeTimingReport({ resolvedPackageDir, resultDir, timing, logs, stage1StartedAt }).catch(() => {});
      throw error;
    }

    const accumulatedStdout = cliResultB.stdout || "";
    const accumulatedStderr = cliResultB.stderr || "";
    const conversationId = cliResultB.conversationId;
    await fs.writeFile(path.join(resultDir, "antigravity-output.log"), accumulatedStdout, "utf8");
    if (accumulatedStderr) await fs.writeFile(path.join(resultDir, "antigravity-stderr.log"), accumulatedStderr, "utf8");
    const phaseBProxyViews = expectedProxyList.filter((proxy) => (
      phaseBVideoViews.has(proxy.filename) || phaseBVideoViews.has(proxy.absolutePath)
    )).length;
    timing.scriptGeneration = {
      durationMs: Date.now() - startPhaseB,
      agyProcessCount: phaseBMetrics.agyProcessCount,
      retryCount: phaseBMetrics.retryCount,
      viewFileCount: phaseBMetrics.viewFileTextCount + phaseBMetrics.viewFileVideoCount,
      videoViewFileCount: phaseBMetrics.viewFileVideoCount,
      sourceProxyViewCount: phaseBProxyViews,
      fullSourceRewatched: phaseBProxyViews === expectedProxyList.length,
      transcriptReadCount: Object.entries(phaseBMetrics.fileReads).filter(([name]) => /transcript|\.srt$/i.test(name)).reduce((sum, [, count]) => sum + count, 0),
      manifestReadCount: Object.entries(phaseBMetrics.fileReads).filter(([name]) => /manifest/i.test(name)).reduce((sum, [, count]) => sum + count, 0),
      agentTurnCount: phaseBMetrics.agentTurns,
      timeoutMs: commandConfigB.timeoutMs,
      attempts: phaseBMetrics.attempts,
      tokens: tokenSummary(phaseBMetrics)
    };
    if (phaseBMetrics.viewFileVideoCount > 0) {
      this.emitLog(onProgress, 80, `[PHASE_B] WARNING: Phase B đã mở ${phaseBMetrics.viewFileVideoCount} file video (${phaseBProxyViews}/${expectedProxyList.length} proxy nguồn) dù đã có understanding.`, logs);
    } else {
      this.emitLog(onProgress, 80, "[PHASE_B] DONE: 0 view_file video.", logs);
    }

    onProgress?.({ step: "antigravity_stage1", percent: 82, message: "Đang tách và kiểm tra các JSON variant" });

    let envelope = findArtifactEnvelope(accumulatedStdout);
    if (!envelope?.artifacts?.length) {
      try {
        const parsed = parseJsonCandidate(await fs.readFile(path.join(resultDir, "result-envelope.json"), "utf8"));
        if (parsed?.artifacts?.length) envelope = parsed;
      } catch (_) {}
    }
    if (!envelope?.artifacts?.length) {
      try {
        const scriptFiles = (await fs.readdir(resultDir)).filter((f) => /^script-\d+\.json$/i.test(f));
        const artifacts = [];
        for (const f of scriptFiles) {
          try {
            const scriptObj = parseJsonCandidate(await fs.readFile(path.join(resultDir, f), "utf8"));
            if (scriptObj) artifacts.push({ filename: f, script: scriptObj });
          } catch (_) {}
        }
        if (artifacts.length) envelope = { artifacts };
      } catch (_) {}
    }
    if (!envelope?.artifacts?.length) {
      await this.writeTimingReport({ resolvedPackageDir, resultDir, timing, logs, stage1StartedAt });
      throw new Error(`Antigravity không trả về artifacts JSON hợp lệ. Xem log tại ${resultDir}.`);
    }

    const scriptArtifacts = envelope.artifacts.filter((a) => /^script-\d+\.json$/.test(a.filename) || a.script?.scriptId);
    const normalized = scriptArtifacts.map(normalizeArtifact);
    const deduplicated = new Map();
    for (const artifact of normalized) deduplicated.set(artifact.script.scriptId, artifact);
    const files = [];
    for (const scriptId of requestedScriptIds) {
      const artifact = deduplicated.get(scriptId);
      if (!artifact) continue;
      const filePath = path.join(resultDir, artifact.filename);
      await writeJsonAtomic(filePath, artifact.script);
      files.push(filePath);
    }
    const inspections = await inspectGeminiJsonFiles(files);
    const acceptedScriptTypes = new Set(["story_recut_script", "story_spine_edit_script"]);
    const validFiles = inspections
      .filter((item) => item.validJson && acceptedScriptTypes.has(item.type) && item.segmentCount > 0 && requestedScriptIds.includes(Number(item.scriptId)))
      .sort((left, right) => requestedScriptIds.indexOf(Number(left.scriptId)) - requestedScriptIds.indexOf(Number(right.scriptId)))
      .map((item) => item.filePath);
    const warnings = [];
    const missingIds = requestedScriptIds.filter((scriptId) => !inspections.some((item) => Number(item.scriptId) === scriptId));
    if (missingIds.length) warnings.push(`Antigravity chưa tạo Script ${missingIds.join(", ")}.`);
    for (const inspection of inspections.filter((item) => !item.validJson || !acceptedScriptTypes.has(item.type) || item.segmentCount < 1)) {
      warnings.push(`${path.basename(inspection.filePath)} không đạt schema variant: ${inspection.error || inspection.type}.`);
    }
    let seriesAdherence = null;
    if (seriesPlan) {
      seriesAdherence = evaluateScriptsAgainstSeriesPlan([...deduplicated.values()].map((item) => item.script), seriesPlan);
      warnings.push(...seriesAdherence.warnings);
    }
    if (timing.scriptGeneration.fullSourceRewatched) {
      warnings.push(`Phase B đã xem lại toàn bộ ${expectedProxyList.length} proxy nguồn dù đã có source understanding.`);
    }
    await this.writeTimingReport({ resolvedPackageDir, resultDir, timing, logs, stage1StartedAt });
    if (!validFiles.length) {
      throw new Error(`Không có JSON variant hợp lệ. Xem kết quả tại ${resultDir}.`);
    }
    await writeJsonAtomic(path.join(resultDir, "antigravity-run-info.json"), {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      provider: "antigravity_cli",
      packageDir: resolvedPackageDir,
      pass1Dir,
      promptPath,
      model: this.settings.antigravityModel || "",
      conversationId: conversationId || null,
      sourceUnderstanding: {
        cacheHit: timing.sourceUnderstanding.cacheHit,
        cacheKey: understandingKey,
        cachePath: timing.sourceUnderstanding.cachePath,
        keyComponents: understandingComponents
      },
      expectedProxyFiles: coverage.expectedProxyFiles,
      viewedProxyFiles: coverage.viewedProxyFiles,
      missingProxyFiles: coverage.missingProxyFiles,
      videoCoveragePercent: coverage.coveragePercent,
      directMultimodalCoverage: coverage.isComplete,
      coverageSource: coverage.source,
      seriesPlanPath: seriesPlanPath || null,
      seriesAdherence: seriesAdherence?.report || null,
      validFiles,
      warnings
    });
    onProgress?.({ step: "antigravity_stage1", percent: 100, message: `Đã tạo ${validFiles.length} JSON variant hợp lệ` });
    return {
      resultDir,
      files,
      validFiles,
      inspections,
      warnings,
      coverage,
      seriesPlanPath,
      timing,
      sourceUnderstanding: {
        cacheHit: timing.sourceUnderstanding.cacheHit,
        cachePath: timing.sourceUnderstanding.cachePath,
        cacheKey: understandingKey
      }
    };
  }

  async writeTimingReport({ resolvedPackageDir, resultDir, timing, logs, stage1StartedAt }) {
    timing.stage1Ms = Date.now() - stage1StartedAt;
    const report = await resetPipelineTiming(resolvedPackageDir, { ...timing, logs }).catch(() => null);
    await writeJsonAtomic(path.join(resultDir, "timing-report.json"), report || { ...timing, logs });
    return report;
  }
}

function newMetrics() {
  return {
    agyProcessCount: 0,
    retryCount: 0,
    attempts: [],
    fileReads: {},
    usageReported: false,
    agentTurns: 0,
    toolCalls: 0,
    viewFileVideoCount: 0,
    viewFileTextCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    modelSeconds: 0
  };
}

function mergeMetrics(target, source) {
  if (!source) return target;
  for (const [name, count] of Object.entries(source.fileReads || {})) {
    target.fileReads[name] = (target.fileReads[name] || 0) + count;
  }
  if (source.usageReported) target.usageReported = true;
  for (const key of ["agyProcessCount", "retryCount", "agentTurns", "toolCalls", "viewFileVideoCount", "viewFileTextCount", "inputTokens", "outputTokens", "thinkingTokens", "cacheReadTokens", "modelSeconds"]) {
    target[key] += Number(source[key]) || 0;
  }
  target.attempts.push(...(source.attempts || []));
  return target;
}

function accumulateStats(metrics, stats) {
  if (!stats) return;
  for (const [name, count] of Object.entries(stats.fileReads || {})) {
    metrics.fileReads[name] = (metrics.fileReads[name] || 0) + count;
  }
  if (stats.usageReported) metrics.usageReported = true;
  for (const key of ["agentTurns", "toolCalls", "viewFileVideoCount", "viewFileTextCount", "inputTokens", "outputTokens", "thinkingTokens", "cacheReadTokens", "modelSeconds"]) {
    metrics[key] += Number(stats[key]) || 0;
  }
}

function summarizePhaseA(metrics, diagnostics = {}) {
  const reads = metrics.fileReads || {};
  const sumReads = (predicate) => Object.entries(reads).filter(([name]) => predicate(name)).reduce((sum, [, count]) => sum + count, 0);
  const videoReads = Object.entries(reads).filter(([name]) => /\.(mp4|mov|webm|m4v)$/i.test(name));
  const phaseAAttempts = (metrics.attempts || []).filter((attempt) => attempt.label === "PHASE_A");
  // A "full multimodal restart" is a fresh Phase A process started after an
  // earlier Phase A process had already viewed at least one proxy.
  let fullMultimodalRestartCount = 0;
  let videosViewedSoFar = 0;
  for (const attempt of phaseAAttempts) {
    if (videosViewedSoFar > 0) fullMultimodalRestartCount += 1;
    videosViewedSoFar += Number(attempt.videoViews || 0);
  }
  return {
    agyProcessCount: metrics.agyProcessCount,
    viewFileCount: metrics.viewFileVideoCount,
    videoViewFileCount: metrics.viewFileVideoCount,
    textViewFileCount: metrics.viewFileTextCount,
    duplicateVideoViewCount: videoReads.reduce((sum, [, count]) => sum + Math.max(0, count - 1), 0),
    transcriptReadCount: sumReads((name) => /transcript|\.srt$/i.test(name)),
    manifestReadCount: sumReads((name) => /manifest/i.test(name)),
    contextReadCount: sumReads((name) => name === "phase-a-context.txt"),
    agentTurnCount: metrics.agentTurns,
    timeoutOccurred: Boolean(diagnostics.timeoutOccurred),
    serializationRepairUsed: diagnostics.serializationRepairUsed || false,
    serializationVideoViews: diagnostics.serializationVideoViews || 0,
    fullMultimodalRestartCount,
    freshRetryBeforeAnyVideoCount: diagnostics.freshRetryBeforeAnyVideoCount || 0,
    retryCount: metrics.retryCount,
    inputTokens: metrics.usageReported ? metrics.inputTokens : null,
    outputTokens: metrics.usageReported ? metrics.outputTokens : null,
    thinkingTokens: metrics.usageReported ? metrics.thinkingTokens : null,
    cacheReadTokens: metrics.usageReported ? metrics.cacheReadTokens : null,
    modelSeconds: metrics.usageReported ? Number(metrics.modelSeconds.toFixed(1)) : null,
    timeoutMs: diagnostics.timeoutMs || null,
    contextFile: diagnostics.contextFile || null,
    failureKinds: diagnostics.failureKinds || [],
    authChecks: diagnostics.authChecks || [],
    attempts: metrics.attempts || []
  };
}

function tokenSummary(metrics) {
  return {
    agentTurns: metrics.agentTurns,
    toolCalls: metrics.toolCalls,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    thinkingTokens: metrics.thinkingTokens,
    cacheReadTokens: metrics.cacheReadTokens,
    modelSeconds: Number(metrics.modelSeconds.toFixed(1))
  };
}

ManualAntigravityStage1Service.RESULT_DIR_NAME = RESULT_DIR_NAME;
ManualAntigravityStage1Service.findArtifactEnvelope = findArtifactEnvelope;
ManualAntigravityStage1Service.normalizeArtifact = normalizeArtifact;
ManualAntigravityStage1Service.normalizeAntigravityModel = normalizeAntigravityModel;
ManualAntigravityStage1Service.modelSupportsEffortFlag = modelSupportsEffortFlag;
ManualAntigravityStage1Service.resolveAntigravityTimeoutMs = resolveAntigravityTimeoutMs;
ManualAntigravityStage1Service.getExpectedProxyList = getExpectedProxyList;
ManualAntigravityStage1Service.validateVideoCoverage = validateVideoCoverage;
ManualAntigravityStage1Service.auditTranscriptForViewedProxies = auditTranscriptForViewedProxies;
ManualAntigravityStage1Service.buildAgentPrompt = buildAgentPrompt;
ManualAntigravityStage1Service.buildRetryPrompt = buildRetryPrompt;
ManualAntigravityStage1Service.buildSourceUnderstandingPrompt = buildSourceUnderstandingPrompt;
ManualAntigravityStage1Service.buildScriptGenerationPrompt = buildScriptGenerationPrompt;
ManualAntigravityStage1Service.buildSeriesPlanPrompt = buildSeriesPlanPrompt;
ManualAntigravityStage1Service.validateSeriesPlan = validateSeriesPlan;
ManualAntigravityStage1Service.evaluateScriptsAgainstSeriesPlan = evaluateScriptsAgainstSeriesPlan;
ManualAntigravityStage1Service.detectSeriesProfile = detectSeriesProfile;
ManualAntigravityStage1Service.SERIES_PROFILES = SERIES_PROFILES;
ManualAntigravityStage1Service.MAX_PRINT_PROMPT_CHARS = MAX_PRINT_PROMPT_CHARS;
ManualAntigravityStage1Service.classifyAgyFailure = classifyAgyFailure;
ManualAntigravityStage1Service.resolvePhaseTimeoutMs = resolvePhaseTimeoutMs;
ManualAntigravityStage1Service.buildPhaseAContext = buildPhaseAContext;
ManualAntigravityStage1Service.parseKeyringExpiry = parseKeyringExpiry;
ManualAntigravityStage1Service.recoverTruncatedUnderstanding = recoverTruncatedUnderstanding;
ManualAntigravityStage1Service.buildSourceUnderstandingSerializationPrompt = buildSourceUnderstandingSerializationPrompt;
ManualAntigravityStage1Service.resolveSourceUnderstandingArchitecture = resolveSourceUnderstandingArchitecture;
ManualAntigravityStage1Service.resolveMapConcurrency = resolveMapConcurrency;
ManualAntigravityStage1Service.parseSrtForContext = parseSrtForContext;

module.exports = ManualAntigravityStage1Service;
module.exports.resolveAntigravityTimeoutMs = resolveAntigravityTimeoutMs;
module.exports.getExpectedProxyList = getExpectedProxyList;
module.exports.validateVideoCoverage = validateVideoCoverage;
module.exports.auditTranscriptForViewedProxies = auditTranscriptForViewedProxies;
module.exports.buildAgentPrompt = buildAgentPrompt;
module.exports.buildRetryPrompt = buildRetryPrompt;
module.exports.buildSourceUnderstandingPrompt = buildSourceUnderstandingPrompt;
module.exports.buildScriptGenerationPrompt = buildScriptGenerationPrompt;

