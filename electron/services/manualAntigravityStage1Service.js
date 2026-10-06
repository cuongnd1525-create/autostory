const fs = require("fs/promises");
const fsSync = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { buildCliEnv } = require("./cliEnv");
const { inspectGeminiJsonFiles } = require("./geminiJsonArtifactService");

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

function buildRetryPrompt({ missingProxies, scriptIds = [1, 3, 4] }) {
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
    `After calling \`view_file\` on all missing chunks, return the final JSON envelope containing artifacts for scripts: ${scriptIds.join(", ")}.`,
    "================================================================================"
  ].join("\n");
}

function buildAgentPrompt({ pass1Dir, promptPath, resultDir, scriptIds = [1, 3, 4], expectedProxyList = [], packageInfo = null }) {
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

  // Build explicit list of context files so the model never runs directory searches
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
    this.activeChild = null;
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
    viewedProxySet = new Set()
  }) {
    return new Promise((resolve, reject) => {
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutBuffer = "";
      let settled = false;
      this.cancelled = false;
      let lastActivityTime = Date.now();
      let currentPercent = 18;
      let conversationId = null;

      const child = this.spawnImpl(command, args, {
        cwd,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: buildCliEnv()
      });
      this.activeChild = child;

      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearInterval(heartbeatInterval);
        clearTimeout(hardTimer);
        this.activeChild = null;
        callback();
      };

      const inactivityLimitMs = Math.min(timeoutMs, 600000);
      const hardTimeoutMs = timeoutMs + 30000;

      const hardTimer = setTimeout(() => {
        this.terminateActiveChild();
        finish(() => reject(new Error(`Antigravity timed out after ${Math.round(timeoutMs / 1000)}s.`)));
      }, hardTimeoutMs);

      const heartbeatInterval = setInterval(() => {
        if (settled) return;
        const idleMs = Date.now() - lastActivityTime;
        if (idleMs >= inactivityLimitMs) {
          this.terminateActiveChild();
          finish(() => reject(new Error(`Antigravity không có phản hồi trong ${Math.round(idleMs / 1000)}s (quá thời gian chờ hoạt động).`)));
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
              emitProgress(99, "Antigravity đã tạo xong dữ liệu phân tích");
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

      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (code) => finish(() => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        const combined = `${stdout}\n${stderr}`;

        if (this.cancelled) {
          reject(new Error("Đã dừng phân tích GĐ1 bằng Antigravity."));
          return;
        }
        
        let validEnvelope = null;
        try {
          validEnvelope = findArtifactEnvelope(stdout);
        } catch (_e) {}
        
        if (combined.includes("[agy] print timeout after")) {
          if (validEnvelope && validEnvelope.artifacts && validEnvelope.artifacts.length > 0) {
            // Partial output contains valid scripts, so accept it!
            resolve({ stdout, stderr, conversationId, viewedProxySet });
            return;
          }
          const timeoutMatch = combined.match(/\[agy\] print timeout after (\S+)/i);
          const limitStr = timeoutMatch ? timeoutMatch[1] : `${Math.round(timeoutMs / 1000)}s`;
          const error = new Error(`Antigravity timed out after ${limitStr}.`);
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        
        if (code !== 0) {
          if (validEnvelope && validEnvelope.artifacts && validEnvelope.artifacts.length > 0) {
            resolve({ stdout, stderr, conversationId, viewedProxySet });
            return;
          }
          const error = new Error(`agy exited with code ${code}: ${stderr || stdout}`);
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        
        resolve({ stdout, stderr, conversationId, viewedProxySet });
      }));
      child.stdin.end();
    });
  }

  terminateActiveChild() {
    const child = this.activeChild;
    if (!child) return false;
    this.cancelled = true;
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

  cancel() {
    return this.terminateActiveChild();
  }

  async run({ packageDir, onProgress } = {}) {
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
    const resultDir = path.join(resolvedPackageDir, RESULT_DIR_NAME);
    await fs.mkdir(resultDir, { recursive: true });
    // Clean up all existing files in resultDir so Antigravity starts with a pristine workspace
    try {
      const existingResultFiles = await fs.readdir(resultDir);
      await Promise.all(
        existingResultFiles.map((file) => fs.rm(path.join(resultDir, file), { recursive: true, force: true }))
      );
    } catch (_err) {}
    const schemaPath = path.join(resultDir, "antigravity-output-schema.json");
    await writeJsonAtomic(schemaPath, buildOutputSchema(requestedScriptIds));

    // 1. Discover all expected proxy files
    const expectedProxyList = await getExpectedProxyList(pass1Dir, packageInfo);
    const viewedProxySet = new Set();

    const prompt = buildAgentPrompt({ pass1Dir, promptPath, resultDir, scriptIds: requestedScriptIds, expectedProxyList, packageInfo });
    const commandConfig = this.buildCommand(prompt, schemaPath, pass1Dir, { packageInfo });

    onProgress?.({ step: "antigravity_stage1", percent: 8, message: "Đang mở gói GĐ1 ở chế độ chỉ đọc" });
    onProgress?.({ step: "antigravity_stage1", percent: 18, message: "Antigravity đang phân tích prompt, transcript, manifest và proxy" });

    // Preflight token warmup: Ensures fresh 60-min OAuth credentials before starting long multimodal execution in production
    if (this.spawnImpl === spawn) {
      try {
        await new Promise((resolve) => {
          const warmup = spawn(commandConfig.command, ["models"], {
            windowsHide: true,
            env: buildCliEnv()
          });
          warmup.on("close", resolve);
          warmup.on("error", resolve);
          setTimeout(() => {
            try { warmup.kill(); } catch (_) {}
            resolve();
          }, 8000);
        });
      } catch (_) {}
    }

    let cliResult;
    const maxServerRetries = 2;
    for (let serverAttempt = 0; serverAttempt <= maxServerRetries; serverAttempt += 1) {
      try {
        cliResult = await this.runCli({
          ...commandConfig,
          prompt,
          cwd: resultDir,
          onProgress,
          progressStep: "antigravity_stage1",
          expectedProxyList,
          viewedProxySet
        });
        break;
      } catch (error) {
        const errorText = `${error.message || ""} ${error.stderr || ""} ${error.stdout || ""}`;
        const isServerUnavailable = /503|UNAVAILABLE|No capacity available|high traffic/i.test(errorText);
        if (isServerUnavailable && serverAttempt < maxServerRetries && !this.cancelled) {
          const delaySec = (serverAttempt + 1) * 8;
          onProgress?.({
            step: "antigravity_stage1",
            percent: 15,
            message: `Máy chủ AI tạm bận (503/High Traffic). Đang tự động thử lại sau ${delaySec}s (${serverAttempt + 1}/${maxServerRetries})...`
          });
          await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
          continue;
        }
        await Promise.all([
          fs.writeFile(path.join(resultDir, "antigravity-output.log"), error.stdout || "", "utf8"),
          fs.writeFile(path.join(resultDir, "antigravity-stderr.log"), error.stderr || error.message || "", "utf8")
        ]);
        throw error;
      }
    }

    let conversationId = cliResult.conversationId;
    let accumulatedStdout = cliResult.stdout || "";
    let accumulatedStderr = cliResult.stderr || "";

    // 2. Audit coverage: Live telemetry + transcript audit
    let coverage = await auditTranscriptForViewedProxies(conversationId, expectedProxyList, viewedProxySet);

    // 3. Retry loop if coverage < 100% and conversationId exists
    const maxRetries = 2;
    let retryAttempt = 0;
    while (!coverage.isComplete && retryAttempt < maxRetries && conversationId) {
      retryAttempt += 1;
      const missingCount = coverage.missingProxies.length;
      onProgress?.({
        step: "antigravity_stage1",
        percent: Math.min(80, 20 + retryAttempt * 20),
        message: `Chưa xem đủ proxy video (${coverage.coveragePercent}%, thiếu ${missingCount} chunk). Đang yêu cầu xem tiếp (thử ${retryAttempt}/${maxRetries})...`
      });

      const retryPrompt = buildRetryPrompt({ missingProxies: coverage.missingProxies, scriptIds: requestedScriptIds });
      const retryConfig = this.buildRetryCommand(conversationId, retryPrompt, pass1Dir, { packageInfo });

      try {
        const retryResult = await this.runCli({
          ...retryConfig,
          prompt: retryPrompt,
          cwd: resultDir,
          onProgress,
          progressStep: "antigravity_stage1",
          expectedProxyList,
          viewedProxySet
        });
        accumulatedStdout += `\n--- RETRY ${retryAttempt} ---\n${retryResult.stdout || ""}`;
        if (retryResult.stderr) accumulatedStderr += `\n--- RETRY ${retryAttempt} ---\n${retryResult.stderr}`;
        if (retryResult.conversationId) conversationId = retryResult.conversationId;
      } catch (retryError) {
        accumulatedStdout += `\n--- RETRY ${retryAttempt} ERROR ---\n${retryError.stdout || ""}`;
        accumulatedStderr += `\n--- RETRY ${retryAttempt} ERROR ---\n${retryError.stderr || retryError.message || ""}`;
        break;
      }

      coverage = await auditTranscriptForViewedProxies(conversationId, expectedProxyList, viewedProxySet);
    }

    await fs.writeFile(path.join(resultDir, "antigravity-output.log"), accumulatedStdout, "utf8");
    if (accumulatedStderr) {
      await fs.writeFile(path.join(resultDir, "antigravity-stderr.log"), accumulatedStderr, "utf8");
    }

    // 4. Hard Validation Gate: Coverage MUST be 100% if expected proxies exist!
    if (!coverage.isComplete) {
      const missingNames = coverage.missingProxyFiles.join(", ");
      const gateError = new Error(
        `Antigravity vi phạm quy tắc bắt buộc: Chưa xem đủ 100% proxy video qua multimodal view_file(). ` +
        `Đạt: ${coverage.totalViewed}/${coverage.totalExpected} chunks (${coverage.coveragePercent}%). ` +
        `Các file còn thiếu: [${missingNames}]. Kịch bản bị từ chối.`
      );
      gateError.coverage = coverage;
      throw gateError;
    }

    onProgress?.({ step: "antigravity_stage1", percent: 82, message: "Đang tách và kiểm tra các JSON variant" });

    let envelope = findArtifactEnvelope(accumulatedStdout);
    if (!envelope?.artifacts?.length) {
      const envPath = path.join(resultDir, "result-envelope.json");
      try {
        const raw = await fs.readFile(envPath, "utf8");
        const parsed = parseJsonCandidate(raw);
        if (parsed?.artifacts?.length) envelope = parsed;
      } catch (_) {}
    }
    if (!envelope?.artifacts?.length) {
      try {
        const existingEntries = await fs.readdir(resultDir);
        const scriptFiles = existingEntries.filter((f) => /^script-\d+\.json$/i.test(f));
        if (scriptFiles.length > 0) {
          const artifacts = [];
          for (const f of scriptFiles) {
            try {
              const content = await fs.readFile(path.join(resultDir, f), "utf8");
              const scriptObj = parseJsonCandidate(content);
              if (scriptObj) {
                artifacts.push({ filename: f, script: scriptObj });
              }
            } catch (_) {}
          }
          if (artifacts.length > 0) {
            envelope = { artifacts };
          }
        }
      } catch (_) {}
    }
    if (!envelope?.artifacts?.length) {
      throw new Error(`Antigravity không trả về artifacts JSON hợp lệ. Xem log tại ${resultDir}.`);
    }
    const normalized = envelope.artifacts.map(normalizeArtifact);
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
    if (!validFiles.length) {
      throw new Error(`Không có JSON variant hợp lệ. Xem kết quả tại ${resultDir}.`);
    }
    await writeJsonAtomic(path.join(resultDir, "antigravity-run-info.json"), {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      provider: "antigravity_cli",
      packageDir: resolvedPackageDir,
      pass1Dir,
      promptPath,
      model: this.settings.antigravityModel || "",
      conversationId: conversationId || null,
      expectedProxyFiles: coverage.expectedProxyFiles,
      viewedProxyFiles: coverage.viewedProxyFiles,
      missingProxyFiles: coverage.missingProxyFiles,
      videoCoveragePercent: coverage.coveragePercent,
      directMultimodalCoverage: coverage.isComplete,
      validFiles,
      warnings
    });
    onProgress?.({ step: "antigravity_stage1", percent: 100, message: `Đã tạo ${validFiles.length} JSON variant hợp lệ` });
    return { resultDir, files, validFiles, inspections, warnings, coverage };
  }
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

module.exports = ManualAntigravityStage1Service;
module.exports.resolveAntigravityTimeoutMs = resolveAntigravityTimeoutMs;
module.exports.getExpectedProxyList = getExpectedProxyList;
module.exports.validateVideoCoverage = validateVideoCoverage;
module.exports.auditTranscriptForViewedProxies = auditTranscriptForViewedProxies;
module.exports.buildAgentPrompt = buildAgentPrompt;
module.exports.buildRetryPrompt = buildRetryPrompt;

