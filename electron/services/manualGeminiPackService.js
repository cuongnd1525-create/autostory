const fs = require("fs/promises");
const path = require("path");
const { parseGeminiJsonObject } = require("./geminiJsonArtifactService");
const { buildGeminiInputAccessGate } = require("./geminiInputAccessGate");
const crypto = require("crypto");

const FfmpegService = require("./ffmpegService");
const SceneDetectionService = require("./sceneDetectionService");
const SubtitleService = require("./subtitleService");
const ActionCandidateService = require("./actionCandidateService");
const HookAuditionService = require("./hookAuditionService");
const { parseSrtCues } = require("./hookMiningService");
const { buildHookContract, injectHookContractToPrompt } = require("./hookContractService");
const {
  buildDiyBlueprintPrompt,
  buildDiyProcessMapPrompt,
  buildDiyVoiceScriptPrompt,
  evaluateDiyProcessMapQuality,
  validateDiyBlueprint,
  validateDiyProcessMap
} = require("./diyStoryRemixService");

const CACHE_SCHEMA_VERSION = 3;
const DETECTION_PROXY_SCHEMA_VERSION = 1;
const PROXY_SCHEMA_VERSION = 3;
const TRANSCRIPT_SCHEMA_VERSION = 2;
const JSON_CODE_FENCE = "```";
const LONG_PROXY_THRESHOLD_SEC = 8 * 60;
const PROXY_CHUNK_TARGET_SEC = 4 * 60;
const PROXY_CHUNK_MAX_SEC = 5 * 60;
const MAX_ROOT_PROXY_CHUNKS = 5;
const MAX_EARLY_BATCH_PROXY_CHUNKS = 8;
const DEFAULT_INDEPENDENT_HOOK_PRIORITY = [
  "high_action",
  "dialogue_conflict",
  "psychological_wtf",
  "rage_irony",
  "evidence_reveal"
];

function normalizeIndependentHookPriority(value) {
  const requested = Array.isArray(value) ? value : [];
  const result = requested
    .map((item) => String(item || "").trim())
    .filter((item, index, list) => DEFAULT_INDEPENDENT_HOOK_PRIORITY.includes(item) && list.indexOf(item) === index);
  DEFAULT_INDEPENDENT_HOOK_PRIORITY.forEach((item) => {
    if (!result.includes(item)) result.push(item);
  });
  return result;
}

function normalizeIndependentPromptOptions(value = {}) {
  const durations = value?.durations || {};
  const normalizeRange = (range, fallbackMin, fallbackMax) => {
    const min = Math.max(60.5, Math.min(300, Number(range?.min) || fallbackMin));
    const max = Math.max(min, Math.min(600, Number(range?.max) || fallbackMax));
    return { min: Number(min.toFixed(1)), max: Number(max.toFixed(1)) };
  };
  return {
    scriptCount: Math.max(1, Math.min(5, Number(value?.scriptCount) || 2)),
    hookPriority: normalizeIndependentHookPriority(value?.hookPriority),
    hookMaxSec: Math.max(4, Math.min(30, Number(value?.hookMaxSec) || 30)),
    narratorTone: ["profile_default", "cinematic", "genz", "factual"].includes(value?.narratorTone) ? value.narratorTone : "profile_default",
    audioBalance: ["original_first", "balanced", "narrator_led"].includes(value?.audioBalance) ? value.audioBalance : "original_first",
    pacing: ["fast", "balanced", "story_first"].includes(value?.pacing) ? value.pacing : "balanced",
    ending: ["verified_payoff", "payoff_comment", "grounded_open_loop"].includes(value?.ending) ? value.ending : "verified_payoff",
    overlays: value?.overlays !== false,
    powerWords: String(value?.powerWords || "").trim(),
    durations: {
      script1: normalizeRange(durations.script1, 60.5, 120),
      script2: normalizeRange(durations.script2, 60.5, 150),
      script3: normalizeRange(durations.script3, 90, 240),
      script4: normalizeRange(durations.script4, 60.5, 120),
      script5: normalizeRange(durations.script5, 60.5, 150)
    }
  };
}

function getRequestedIndependentScriptIds(options = normalizeIndependentPromptOptions()) {
  return [1, 3, 4, 2, 5].slice(0, Math.max(1, Math.min(5, Number(options.scriptCount || 2))));
}

function extractIndependentPromptOptions(basePrompt = "") {
  const match = String(basePrompt).match(/INDEPENDENT_USER_OPTIONS_JSON_BEGIN\s*([\s\S]*?)\s*INDEPENDENT_USER_OPTIONS_JSON_END/i);
  if (!match) return normalizeIndependentPromptOptions();
  try {
    return normalizeIndependentPromptOptions(JSON.parse(match[1]));
  } catch (_error) {
    return normalizeIndependentPromptOptions();
  }
}

function buildIndependentHookFallbackRules(options = normalizeIndependentPromptOptions()) {
  const labels = {
    high_action: "high_action (complete high-adrenaline action or loud confrontation)",
    dialogue_conflict: "dialogue_conflict (intelligible accusation, denial, argument, or contradiction)",
    psychological_wtf: "psychological_wtf (absurd, manipulative, entitled, bizarre, or self-incriminating statement)",
    rage_irony: "rage_irony (verified hypocrisy, audacity, sharp comeback, or consequence-rich contradiction)",
    evidence_reveal: "evidence_reveal (verified discovery, consequence, or visual twist)"
  };
  return `HOOK PRIORITY FALLBACK - USER LOCKED:
- Evaluate categories in this exact order: ${options.hookPriority.map((item, index) => `${index + 1}) ${labels[item]}`).join("; ")}.
- A category qualifies only when a candidate passes cold-viewer comprehension in the first 3 seconds, verified evidence/timestamps, intelligible core action or words, zero audible external source narrator, and a complete high-value beat within ${options.hookMaxSec} seconds.
- high_action fails qualification when the first 3 seconds show only driving, a moving patrol car, camera shake, casual walking, routine vehicle approach, or an establishing shot. HIGH-FRICTION ACTIONS QUALIFY: repeatedly rattling a locked door handle, banging on a barricaded entrance, physical standoff, or forced-entry attempts are valid high_action. Motion and audio-energy scores are discovery radar, never editorial ranking.
- If no candidate in one category passes every gate, fall through to the next category. Never force a weak candidate from a higher category.
- Multi-scene Hooks are allowed across consecutive source ranges. Preserve the decisive payoff and immediate reaction with one actionSequenceId and storyFunction="hook".
- Populate hook_selection_audit with requestedPriority, selectedType, fallbackLevel, selectedEvidenceIds, reason, and rejectedHigherPriorityCandidates.`;
}

function buildIndependentVariantOptionRules(options = normalizeIndependentPromptOptions()) {
  const tone = {
    profile_default: "Preserve the distinct voice of the selected Script profile.",
    cinematic: "Use concise cinematic true-crime American English without police-report wording or unsupported hype.",
    genz: "Use conversational Gen-Z/Millennial internet English as the audience's inner voice while keeping every fact verified.",
    factual: "Use restrained, plain, objective American English with minimal dramatic adjectives."
  }[options.narratorTone];
  const audio = {
    original_first: "Use the lowest useful narration amount inside mandatory bridge limits and preserve clean protected source dialogue/action.",
    balanced: "Balance concise narration with sustained clean source dialogue; protected original audio always wins.",
    narrator_led: "Use the upper useful end of this profile's existing narration limits for verified context, without exceeding bridge limits or replacing protected original audio."
  }[options.audioBalance];
  const pacing = {
    fast: "Compress pauses and repetitive procedure aggressively while preserving decisive lines and immediate reactions.",
    balanced: "Use concise transitions plus sustained complete exchanges when they carry tension or causality.",
    story_first: "Narrative comprehension outranks cut frequency; preserve long complete exchanges or action runs when splitting weakens the story."
  }[options.pacing];
  const ending = {
    verified_payoff: "End immediately after the strongest verified resolution, consequence, or current status.",
    payoff_comment: "Deliver the verified payoff first, then one concise evidence-grounded discussion question.",
    grounded_open_loop: "Deliver all known results promised by this standalone script, then open one unresolved evidence-grounded question. Never hide a known outcome."
  }[options.ending];
  return `INDEPENDENT USER EDITORIAL OPTIONS:
- scriptCount=${options.scriptCount}; generate exactly ${options.scriptCount} requested independent JSON file${options.scriptCount === 1 ? "" : "s"}.
- narratorTone=${options.narratorTone}: ${tone}
- audioBalance=${options.audioBalance}: ${audio}
- pacing=${options.pacing}: ${pacing}
- ending=${options.ending}: ${ending}
- overlays=${options.overlays}: ${options.overlays ? "Populate supported title and visual-cue metadata." : "Keep optional overlay metadata empty."}
- optionalPowerWords=${options.powerWords || "none"}. Use only when evidence and tone support them.
- These options never override factuality, source-narrator muting, protected original audio, Actor Identity, Hook Transition, schema, timestamp, or the requested script count.`;
}

function buildSingleJsonCodeBlockContract(fileName, rootRule = "") {
  return `JSON CODE-BLOCK CONTRACT - HIGHEST PRIORITY
- Return exactly one complete valid JSON object inside exactly one Markdown code block beginning with ${JSON_CODE_FENCE}json and ending with ${JSON_CODE_FENCE}.
- Do not output conversational prose, headings, labels, tables, Canvas, or text before or after the code block.
- Validate the object with JSON.parse before responding.
- The code block is the complete content to download and save as "${fileName}".
${rootRule ? `- ${rootRule}` : ""}`.trim();
}

function buildThreeJsonCodeBlockContract(scriptIds = [1, 3, 4]) {
  const ids = Array.isArray(scriptIds) && scriptIds.length ? scriptIds : [1, 3, 4];
  return `JSON CODE-BLOCK CONTRACT - HIGHEST PRIORITY
- Return exactly ${ids.length} independent Markdown JSON code block${ids.length === 1 ? "" : "s"} and nothing else.
- Required order: ${ids.map((id) => `Script ${id}`).join(", then ")}.
${ids.map((id, index) => `- Block ${index + 1} must be one complete root object with scriptId=${id} and is saved as "script-${id}.json".`).join("\n")}
- Treat each code block as one separate downloadable file. Never put multiple scripts in one code block.
- Every block must begin with ${JSON_CODE_FENCE}json, end with ${JSON_CODE_FENCE}, and parse independently with JSON.parse.
- Do not combine the scripts into an array or wrap them in data, result, output, scripts, review, or any shared outer object.
- Do not output prose, headings, filename labels, explanations, tables, or text before, between, or after the JSON blocks.`;
}

function hashValue(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

async function readJsonIfAvailable(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

async function nonEmptyFileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch (_error) {
    return false;
  }
}

async function copyFileAtomic(sourcePath, destinationPath) {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const tempPath = `${destinationPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.copyFile(sourcePath, tempPath);
  await fs.rm(destinationPath, { force: true }).catch(() => {});
  await fs.rename(tempPath, destinationPath);
}

async function linkOrCopyFile(sourcePath, destinationPath) {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.rm(destinationPath, { force: true }).catch(() => {});
  try {
    await fs.link(sourcePath, destinationPath);
  } catch (_error) {
    await copyFileAtomic(sourcePath, destinationPath);
  }
}

async function writeJsonAtomic(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.rm(filePath, { force: true }).catch(() => {});
  await fs.rename(tempPath, filePath);
}

async function buildSourceFingerprint(sourceVideoPath) {
  const resolvedPath = path.resolve(sourceVideoPath);
  const stat = await fs.stat(resolvedPath);
  const sampleSize = Math.min(stat.size, 256 * 1024);
  const first = Buffer.alloc(sampleSize);
  const last = Buffer.alloc(sampleSize);
  const handle = await fs.open(resolvedPath, "r");
  try {
    if (sampleSize) {
      await handle.read(first, 0, sampleSize, 0);
      await handle.read(last, 0, sampleSize, Math.max(0, stat.size - sampleSize));
    }
  } finally {
    await handle.close();
  }
  const digest = crypto.createHash("sha256")
    .update(resolvedPath.toLowerCase())
    .update(String(stat.size))
    .update(String(Math.round(stat.mtimeMs)))
    .update(first)
    .update(last)
    .digest("hex")
    .slice(0, 24);
  return {
    key: digest,
    sourcePath: resolvedPath,
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

function buildAnalysisCacheKeys({ sourceFingerprint, settings = {}, sourceLanguage = "auto" }) {
  const detectionProxyWidth = Number(settings.sceneDetectionProxyWidth || 480);
  const detectionProxyFps = Number(settings.sceneDetectionProxyFps || 8);
  const sceneKey = hashValue({
    schema: CACHE_SCHEMA_VERSION,
    sourceFingerprint,
    detector: "ffmpeg+scene_detect.py+fixed_windows",
    pythonPath: settings.pythonPath || process.env.PYTHON || "python",
    ffmpegPath: settings.ffmpegPath || "ffmpeg",
    detectionProxyWidth,
    detectionProxyFps,
    threshold: Number(settings.sceneDetectionThreshold || 0.32),
    maxSceneDurationSec: Number(settings.sceneDetectionMaxSceneDurationSec || 45)
  });
  return {
    sceneKey,
    detectionProxyKey: hashValue({
      schema: DETECTION_PROXY_SCHEMA_VERSION,
      sourceFingerprint,
      ffmpegPath: settings.ffmpegPath || "ffmpeg",
      width: detectionProxyWidth,
      fps: detectionProxyFps,
      audio: false
    }),
    actionKey: hashValue({
      schema: 1,
      sourceFingerprint,
      sceneKey,
      detectionProxyWidth,
      detectionProxyFps,
      windowSec: Number(settings.actionAnalysisWindowSec || 4),
      maxCandidateDurationSec: Number(settings.actionCandidateMaxDurationSec || 60),
      maxCandidates: Number(settings.actionCandidateMaxCount || 20)
    }),
    proxyKey: hashValue({
      schema: PROXY_SCHEMA_VERSION,
      sceneKey,
      width: 720,
      labels: "sceneId+absolute-source-timestamps"
    }),
    transcriptKey: hashValue({
      schema: TRANSCRIPT_SCHEMA_VERSION,
      sourceFingerprint,
      whisperCommand: settings.whisperCommand || process.env.WHISPER_COMMAND || "whisper",
      whisperModel: settings.whisperModel || process.env.WHISPER_MODEL || "auto",
      whisperEngine: settings.whisperEngine || process.env.WHISPER_ENGINE || "auto",
      whisperDevice: settings.whisperDevice || process.env.WHISPER_DEVICE || "auto",
      whisperComputeType: settings.whisperComputeType || process.env.WHISPER_COMPUTE_TYPE || "auto",
      whisperChunkSec: Number(settings.whisperChunkSec || process.env.WHISPER_CHUNK_SEC || 240),
      sourceLanguage: sourceLanguage || "auto"
    })
  };
}

function buildProxyCacheKey(sceneKey, manifest) {
  return hashValue({
    schema: PROXY_SCHEMA_VERSION,
    sceneKey,
    width: 720,
    fps: 12,
    videoBitrate: "650k",
    audioBitrate: "64k",
    faststart: true,
    labels: "sceneId+absolute-source-timestamps",
    detector: manifest?.sceneDetector || "",
    scenes: (manifest?.scenes || []).map((scene) => [
      scene.sceneId,
      scene.startSec,
      scene.endSec
    ])
  });
}

function buildProxyChunkPlan(manifest = {}, {
  thresholdSec = LONG_PROXY_THRESHOLD_SEC,
  targetSec = PROXY_CHUNK_TARGET_SEC,
  maxSec = PROXY_CHUNK_MAX_SEC
} = {}) {
  const sourceDurationSec = Math.max(0, Number(manifest.videoDurationSec || 0));
  if (sourceDurationSec <= Math.max(1, Number(thresholdSec) || LONG_PROXY_THRESHOLD_SEC)) return [];
  const target = Math.max(60, Math.min(Number(maxSec) || PROXY_CHUNK_MAX_SEC, Number(targetSec) || PROXY_CHUNK_TARGET_SEC));
  const maximum = Math.max(target, Number(maxSec) || PROXY_CHUNK_MAX_SEC);
  const sceneEnds = (Array.isArray(manifest.scenes) ? manifest.scenes : [])
    .map((scene) => Number(scene.endSec))
    .filter((value) => Number.isFinite(value) && value > 0 && value < sourceDurationSec)
    .sort((left, right) => left - right);
  const chunks = [];
  let cursor = 0;
  while (cursor < sourceDurationSec - 0.001) {
    const remaining = sourceDurationSec - cursor;
    let endSec = sourceDurationSec;
    if (remaining > maximum) {
      const targetEnd = cursor + target;
      const maximumEnd = cursor + maximum;
      const candidates = sceneEnds.filter((value) => value > cursor + 30 && value <= maximumEnd + 0.001);
      endSec = candidates.length
        ? candidates.reduce((best, value) => (
          Math.abs(value - targetEnd) < Math.abs(best - targetEnd) ? value : best
        ), candidates[0])
        : maximumEnd;
    }
    endSec = Math.min(sourceDurationSec, Math.max(cursor + 0.25, endSec));
    const index = chunks.length + 1;
    chunks.push({
      chunkId: `proxy_chunk_${String(index).padStart(3, "0")}`,
      file: `analysis-proxy-chunk-${String(index).padStart(3, "0")}.mp4`,
      sourceStartSec: Number(cursor.toFixed(3)),
      sourceEndSec: Number(endSec.toFixed(3)),
      durationSec: Number((endSec - cursor).toFixed(3)),
      localStartSec: 0,
      localEndSec: Number((endSec - cursor).toFixed(3))
    });
    cursor = endSec;
  }
  return chunks;
}

function buildProxyInputGuide(proxyChunksManifest = null) {
  const chunks = Array.isArray(proxyChunksManifest?.chunks) ? proxyChunksManifest.chunks : [];
  if (!chunks.length) {
    return `VIDEO INPUT CONTRACT:
- Watch analysis-proxy.mp4 from beginning to end.
- Scene labels and SOURCE timestamps burned into the proxy are authoritative.`;
  }
  return `CHUNKED VIDEO INPUT CONTRACT - HIGHEST PRIORITY:
- The long analysis proxy was intentionally split into ${chunks.length} shorter files because Gemini may reject one long upload.
- Read proxy-chunks-manifest.json, then watch EVERY analysis-proxy-chunk-XXX.mp4 in chunkId order before selecting evidence or writing scripts.
- Every chunk keeps normal playback speed and original proxy audio.
- The SOURCE timestamps burned into each frame are absolute timestamps from the original video and are authoritative.
- The local player time inside a chunk starts near 00:00 and is NOT a source timestamp. Never use local chunk time as sourceStartSec/sourceEndSec.
- Never add the chunk offset to a timestamp already burned on screen.
- Treat adjacent chunk boundaries as one continuous source timeline; do not omit a story event merely because it crosses two chunk files.`;
}

function partitionProxyChunksForUpload(chunks = []) {
  if (chunks.length <= MAX_ROOT_PROXY_CHUNKS) return [chunks];
  const finalCount = Math.min(MAX_ROOT_PROXY_CHUNKS, chunks.length);
  const early = chunks.slice(0, chunks.length - finalCount);
  const groups = [];
  for (let index = 0; index < early.length; index += MAX_EARLY_BATCH_PROXY_CHUNKS) {
    groups.push(early.slice(index, index + MAX_EARLY_BATCH_PROXY_CHUNKS));
  }
  groups.push(chunks.slice(chunks.length - finalCount));
  return groups;
}

async function deployProxyChunkUploads({ pass1UploadDir, chunks, chunkCacheDir }) {
  const groups = partitionProxyChunksForUpload(chunks);
  const batched = groups.length > 1;
  const uploadBatchDirs = [];
  for (const [groupIndex, group] of groups.entries()) {
    const isFinal = groupIndex === groups.length - 1;
    const batchDir = batched
      ? path.join(
        pass1UploadDir,
        `UPLOAD-BATCH-${String(groupIndex + 1).padStart(2, "0")}${isFinal ? "-FINAL" : ""}`
      )
      : pass1UploadDir;
    await fs.mkdir(batchDir, { recursive: true });
    for (const chunk of group) {
      const sourcePath = path.join(chunkCacheDir, chunk.file);
      const targetPath = path.join(batchDir, chunk.file);
      await linkOrCopyFile(sourcePath, targetPath);
      chunk.uploadBatch = batched ? groupIndex + 1 : 1;
      chunk.uploadRelativePath = path.relative(pass1UploadDir, targetPath).replace(/\\/g, "/");
    }
    if (batched && !isFinal) {
      await fs.writeFile(
        path.join(batchDir, "00-UPLOAD-THIS-BATCH-FIRST.txt"),
        "Upload every file in this folder to the SAME Gemini chat. Ask Gemini only to acknowledge receipt. Do not request scripts yet. Continue with the next numbered batch.\n",
        "utf8"
      );
    }
    uploadBatchDirs.push(batchDir);
  }
  return { batched, uploadBatchDirs, finalBatchDir: uploadBatchDirs[uploadBatchDirs.length - 1] };
}

function clampScore(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function normalizeTextList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item?.text ?? item ?? "").trim())
    .filter(Boolean);
}

function normalizeActorIdentityMap(value, warnings = []) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.map((item, index) => {
    const actorId = String(item?.actorId || item?.actor_id || `actor_${String(index + 1).padStart(3, "0")}`).trim();
    if (seen.has(actorId)) warnings.push(`actorIdentityMap: actorId "${actorId}" is duplicated.`);
    seen.add(actorId);
    return {
      actorId,
      displayLabel: String(item?.displayLabel || item?.display_label || item?.name || item?.role || "").trim(),
      visualIdentity: String(item?.visualIdentity || item?.visual_identity || "").trim(),
      role: String(item?.role || "unknown").trim().toLowerCase(),
      aliases: normalizeTextList(item?.aliases),
      relationshipFacts: normalizeTextList(item?.relationshipFacts || item?.relationship_facts),
      firstSeenSec: Number.isFinite(Number(item?.firstSeenSec ?? item?.first_seen_sec))
        ? Number(Number(item.firstSeenSec ?? item.first_seen_sec).toFixed(3))
        : null,
      evidenceIds: normalizeIdList(item?.evidenceIds || item?.evidence_ids),
      confidence: clampScore(item?.confidence, 0, 1, 0.5)
    };
  }).filter((item) => item.actorId);
}

function normalizeDialogueEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") {
        return { text: item.trim() };
      }
      if (!item || typeof item !== "object") return null;
      const text = String(item.text || item.quote || item.dialogue || "").trim();
      if (!text) return null;
      const normalized = { text };
      if (Number.isFinite(Number(item.startSec))) normalized.startSec = Number(Number(item.startSec).toFixed(3));
      if (Number.isFinite(Number(item.endSec))) normalized.endSec = Number(Number(item.endSec).toFixed(3));
      return normalized;
    })
    .filter(Boolean);
}

function dialogueContainsSourceNarrator(dialogueEvidence = []) {
  return dialogueEvidence.some((item) => (
    /\[(?:source\s+)?narrator\]|\bnarrator\s*:/i.test(String(item?.text || ""))
  ));
}

function extractSourceNarratorText(dialogueEvidence = []) {
  const chunks = [];
  dialogueEvidence.forEach((item) => {
    const text = String(item?.text || "").trim();
    const pattern = /\[(?:source\s+)?narrator\]\s*([\s\S]*?)(?=(?:\s*-\s*)?\[[^\]]+\]|$)/gi;
    let match;
    while ((match = pattern.exec(text))) {
      const chunk = String(match[1] || "").replace(/^[\s-]+|[\s-]+$/g, "").trim();
      if (chunk) chunks.push(chunk);
    }
  });
  return [...new Set(chunks)].join(" ").trim();
}

function buildSourceRuns(evidence = [], maxGapSec = 4) {
  const ordered = [...evidence]
    .filter((item) => Number.isFinite(item.sourceStartSec) && Number.isFinite(item.sourceEndSec))
    .sort((left, right) => left.sourceStartSec - right.sourceStartSec);
  const runs = [];
  let current = null;

  ordered.forEach((item) => {
    const gapSec = current ? item.sourceStartSec - current.sourceEndSec : Number.POSITIVE_INFINITY;
    if (!current || gapSec > maxGapSec) {
      current = {
        sourceRunId: `source_run_${String(runs.length + 1).padStart(4, "0")}`,
        sourceStartSec: item.sourceStartSec,
        sourceEndSec: item.sourceEndSec,
        evidenceIds: [],
        narrativePhases: []
      };
      runs.push(current);
    }
    current.sourceEndSec = Math.max(current.sourceEndSec, item.sourceEndSec);
    current.evidenceIds.push(item.evidenceId);
    if (item.narrativePhase && !current.narrativePhases.includes(item.narrativePhase)) {
      current.narrativePhases.push(item.narrativePhase);
    }
    item.sourceRunId = current.sourceRunId;
    item.sourceRunPosition = current.evidenceIds.length;
  });

  const itemById = new Map(evidence.map((item) => [item.evidenceId, item]));
  runs.forEach((run) => {
    run.durationSec = Number((run.sourceEndSec - run.sourceStartSec).toFixed(3));
    run.evidenceCount = run.evidenceIds.length;
    run.evidenceIds.forEach((evidenceId, index) => {
      const item = itemById.get(evidenceId);
      if (!item) return;
      item.previousEvidenceId = run.evidenceIds[index - 1] || "";
      item.nextEvidenceId = run.evidenceIds[index + 1] || "";
      item.sourceRunStartSec = run.sourceStartSec;
      item.sourceRunEndSec = run.sourceEndSec;
    });
  });
  return runs;
}

function normalizeActionCandidateDecisions(value, candidateMap, errors, warnings) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.map((item, index) => {
    const actionCandidateId = String(item?.actionCandidateId || item?.candidateId || "").trim();
    const verdict = String(item?.verdict || item?.decision || "").trim().toLowerCase();
    const reason = String(item?.reason || item?.visualReason || "").trim();
    if (!candidateMap.has(actionCandidateId)) {
      errors.push(`actionCandidateDecisions ${index + 1}: actionCandidateId "${actionCandidateId || "(trống)"}" không tồn tại.`);
    }
    if (!new Set(["essential", "supporting", "not_relevant"]).has(verdict)) {
      errors.push(`actionCandidateDecisions ${index + 1}: verdict phải là essential, supporting hoặc not_relevant.`);
    }
    if (!reason) warnings.push(`actionCandidateDecisions ${index + 1}: thiếu lý do hình ảnh cụ thể.`);
    if (seen.has(actionCandidateId)) warnings.push(`actionCandidateDecisions: "${actionCandidateId}" bị đánh giá lặp.`);
    seen.add(actionCandidateId);
    return {
      actionCandidateId,
      verdict,
      reason,
      actionType: String(item?.actionType || "").trim(),
      actionSequenceId: String(item?.actionSequenceId || actionCandidateId).trim(),
      evidenceIds: normalizeIdList(item?.evidenceIds)
    };
  });
}

function measureCandidateCoverage(candidate, evidence) {
  const start = Number(candidate?.sourceStartSec || 0);
  const end = Number(candidate?.sourceEndSec || start);
  const duration = Math.max(0.001, end - start);
  const intervals = evidence
    .filter((item) => item.actionCandidateId === candidate.actionCandidateId)
    .map((item) => [Math.max(start, item.sourceStartSec), Math.min(end, item.sourceEndSec)])
    .filter(([left, right]) => right > left)
    .sort((left, right) => left[0] - right[0]);
  const merged = [];
  intervals.forEach(([left, right]) => {
    const previous = merged[merged.length - 1];
    if (previous && left <= previous[1] + 0.01) previous[1] = Math.max(previous[1], right);
    else merged.push([left, right]);
  });
  const coveredSec = merged.reduce((sum, [left, right]) => sum + right - left, 0);
  return {
    coveredSec: Number(coveredSec.toFixed(3)),
    coverageRatio: Number((coveredSec / duration).toFixed(3))
  };
}

function validateSceneEvidence(payload, manifest, sourceName = "scene-evidence.json", actionCandidatesPayload = {}) {
  const rawItems = Array.isArray(payload)
    ? payload
    : payload?.evidence || payload?.sceneEvidence || payload?.items || payload?.scenes;
  if (!Array.isArray(rawItems) || !rawItems.length) {
    const emptyArrayDetected = Array.isArray(rawItems);
    throw new Error(
      emptyArrayDetected
        ? `${sourceName}: Gemini đã trả về "evidence": [] nên không có cảnh nào để dựng. `
          + "Đây là file khung rỗng, không phải kết quả phân tích. Hãy gửi lại toàn bộ file trong thư mục 01-GUI-GEMINI "
          + "và yêu cầu Gemini xem hết video proxy (hoặc toàn bộ proxy chunk theo đúng thứ tự) rồi tạo lại scene-evidence.json có evidence thực."
        : `${sourceName}: không tìm thấy mảng evidence. File phải có cấu trúc {"schemaVersion":1,"sourceVideo":"...","evidence":[...]}`
    );
  }

  const sceneMap = new Map((manifest?.scenes || []).map((scene) => [scene.sceneId, scene]));
  const errors = [];
  const warnings = [];
  const seenIds = new Set();
  const actionCandidates = Array.isArray(actionCandidatesPayload?.candidates)
    ? actionCandidatesPayload.candidates
    : [];
  const actionCandidateMap = new Map(actionCandidates.map((item) => [item.actionCandidateId, item]));
  const actorIdentityMap = normalizeActorIdentityMap(
    payload?.actorIdentityMap || payload?.actor_identity_map,
    warnings
  );
  const actorIdSet = new Set(actorIdentityMap.map((item) => item.actorId));
  if (payload?.sourceVideo && manifest?.sourceVideo && path.basename(String(payload.sourceVideo)) !== manifest.sourceVideo) {
    errors.push(`sourceVideo "${payload.sourceVideo}" không khớp gói "${manifest.sourceVideo}".`);
  }
  const evidence = rawItems.map((item, index) => {
    const label = `evidence ${index + 1}`;
    const sceneId = String(item?.sceneId || "").trim();
    const scene = sceneMap.get(sceneId);
    const sourceStartSec = Number(item?.sourceStartSec ?? item?.startSec);
    const sourceEndSec = Number(item?.sourceEndSec ?? item?.endSec);
    const visualFacts = normalizeTextList(item?.visualFacts || item?.visualEvidence);
    const dialogueEvidence = normalizeDialogueEvidence(item?.dialogueEvidence || item?.dialogue || item?.audioEvidence);
    const sourceNarratorPresent = typeof item?.sourceNarratorPresent === "boolean"
      ? item.sourceNarratorPresent
      : dialogueContainsSourceNarrator(dialogueEvidence);
    const sceneDialoguePresent = typeof item?.sceneDialoguePresent === "boolean"
      ? item.sceneDialoguePresent
      : dialogueEvidence.some((entry) => !dialogueContainsSourceNarrator([entry]));
    const sourceAudioType = String(
      item?.sourceAudioType
      || (sourceNarratorPresent && sceneDialoguePresent
        ? "mixed_narration_dialogue"
        : sourceNarratorPresent
        ? "source_narration"
        : sceneDialoguePresent
        ? "scene_dialogue"
        : "ambient_sfx")
    ).trim();
    const sourceNarratorText = String(
      item?.sourceNarratorText || extractSourceNarratorText(dialogueEvidence)
    ).trim();
    const storyMeaning = String(
      item?.storyMeaning || item?.narrativeMeaning || item?.storyRole || item?.summary || ""
    ).trim();
    const hookScore = clampScore(item?.hookScore ?? item?.hookPotential, 0, 10, 0);
    const quoteShock = clampScore(item?.quoteShock ?? item?.semanticHookScore ?? item?.absurdityScore, 0, 10, 0);
    const hookType = String(item?.hookType || item?.hook_type || "").trim().toLowerCase();
    const retentionScore = clampScore(item?.retentionScore ?? item?.retentionPotential, 0, 10, 0);
    const clarityScore = clampScore(item?.clarityScore, 0, 10, 0);
    const completeBeat = typeof item?.completeBeat === "boolean" ? item.completeBeat : null;
    const cutSafety = String(item?.cutSafety || "").trim().toLowerCase();
    const continuityBefore = String(item?.continuityBefore || "").trim();
    const continuityAfter = String(item?.continuityAfter || "").trim();
    const burnedTextPresent = typeof item?.burnedTextPresent === "boolean"
      ? item.burnedTextPresent
      : visualFacts.some((fact) => /\b(on-screen text|subtitle|caption|text (?:reads|displays|states|shows))\b/i.test(fact));
    const burnedTextContent = String(item?.burnedTextContent || "").trim();
    const safeForVoiceover = typeof item?.safeForVoiceover === "boolean"
      ? item.safeForVoiceover
      : !burnedTextPresent;
    const actionCandidateId = String(item?.actionCandidateId || "").trim();
    const linkedActionCandidate = actionCandidateId ? actionCandidateMap.get(actionCandidateId) : null;
    const actionSequenceId = String(item?.actionSequenceId || actionCandidateId || "").trim();
    const narrativeEssential = item?.narrativeEssential === true;
    const mustInclude = item?.mustInclude === true || narrativeEssential;
    const stakeRole = String(item?.stakeRole || item?.stake_role || "none").trim().toLowerCase();
    const stakeActorIds = normalizeIdList(item?.stakeActorIds || item?.stake_actor_ids);
    const opensQuestion = String(item?.opensQuestion || item?.opens_question || "").trim();
    const resolvesQuestion = String(item?.resolvesQuestion || item?.resolves_question || "").trim();
    const resolutionType = String(item?.resolutionType || item?.resolution_type || "").trim().toLowerCase();
    const resolutionModality = String(item?.resolutionModality || item?.resolution_modality || "none").trim().toLowerCase();
    const visualProofScore = clampScore(item?.visualProofScore ?? item?.visual_proof_score, 0, 10, 0);
    const proceduralBloat = item?.proceduralBloat === true || item?.procedural_bloat === true;
    const proceduralBloatType = String(item?.proceduralBloatType || item?.procedural_bloat_type || "none").trim().toLowerCase();
    const mustAppearBeforeLaterTimeJump = item?.mustAppearBeforeLaterTimeJump === true
      || item?.must_appear_before_later_time_jump === true;
    const containsUnexplainedJargon = item?.containsUnexplainedJargon === true
      || item?.contains_unexplained_jargon === true;
    const jargonTerms = normalizeTextList(item?.jargonTerms || item?.jargon_terms);
    const actorIds = normalizeIdList(item?.actorIds || item?.actor_ids);
    const primaryActorId = String(item?.primaryActorId || item?.primary_actor_id || actorIds[0] || "").trim();
    const speakerActorId = String(item?.speakerActorId || item?.speaker_actor_id || "").trim();
    const relationshipFacts = normalizeTextList(item?.relationshipFacts || item?.relationship_facts);

    [...actorIds, primaryActorId, speakerActorId].filter(Boolean).forEach((actorId) => {
      if (actorIdentityMap.length && !actorIdSet.has(actorId)) {
        warnings.push(`${label}: actorId "${actorId}" does not exist in actorIdentityMap.`);
      }
    });

    if (!scene) {
      errors.push(`${label}: sceneId "${sceneId || "(trống)"}" không tồn tại.`);
    }
    if (!Number.isFinite(sourceStartSec) || !Number.isFinite(sourceEndSec) || sourceEndSec <= sourceStartSec) {
      errors.push(`${label}: thiếu sourceStartSec/sourceEndSec hợp lệ.`);
    } else if (scene) {
      if (sourceStartSec < Number(scene.startSec) - 0.001 || sourceStartSec >= Number(scene.endSec) - 0.001) {
        errors.push(`${label}: sourceStartSec ${sourceStartSec.toFixed(3)}s nằm ngoài ${sceneId} (${Number(scene.startSec).toFixed(3)}-${Number(scene.endSec).toFixed(3)}s).`);
      }
      if (sourceEndSec > Number(scene.endSec) + 0.001) {
        errors.push(`${label}: sourceEndSec ${sourceEndSec.toFixed(3)}s vượt khỏi ${sceneId} (${Number(scene.startSec).toFixed(3)}-${Number(scene.endSec).toFixed(3)}s).`);
      }
    }
    if (!visualFacts.length) {
      errors.push(`${label}: thiếu visualFacts cụ thể.`);
    }
    if (!storyMeaning) {
      errors.push(`${label}: thiếu storyMeaning.`);
    }
    if (actionCandidateId && !linkedActionCandidate) {
      errors.push(`${label}: actionCandidateId "${actionCandidateId}" không tồn tại trong action-candidates.json.`);
    }

    let evidenceId = String(item?.evidenceId || `evidence_${String(index + 1).padStart(4, "0")}`).trim();
    if (seenIds.has(evidenceId)) {
      warnings.push(`${label}: evidenceId "${evidenceId}" bị trùng và đã được tạo lại.`);
      evidenceId = `evidence_${String(index + 1).padStart(4, "0")}`;
    }
    seenIds.add(evidenceId);

    if (visualFacts.join(" ").length < 24) {
      warnings.push(`${label}: visualFacts quá ngắn, Gemini có thể đang mô tả chung chung.`);
    }
    if (visualFacts.some((fact) => /\b(tension rises|things escalate|situation escalates|shocking (moment|event)|police respond)\b/i.test(fact))) {
      warnings.push(`${label}: visualFacts còn chứa mô tả chung chung; nên yêu cầu Gemini nêu hành động nhìn thấy cụ thể.`);
    }
    if (!dialogueEvidence.length) {
      warnings.push(`${label}: không có dialogueEvidence; chỉ nên dùng khi cảnh thực sự không có lời thoại quan trọng.`);
    }
    if (completeBeat === false || cutSafety === "unsafe") {
      warnings.push(`${label}: điểm cắt chưa giữ trọn hành động/lời thoại/phản ứng.`);
    }
    if (!continuityBefore && !continuityAfter) {
      warnings.push(`${label}: thiếu continuityBefore/continuityAfter, khó kiểm tra mạch nối ở lượt viết kịch bản.`);
    }
    if (burnedTextPresent && !burnedTextContent) {
      warnings.push(`${label}: có chữ burn sẵn nhưng thiếu burnedTextContent để kiểm tra xung đột với voice mới.`);
    }
    if (!new Set([
      "none", "threat_open", "stake_context", "escalation", "victim_resolution",
      "hazard_resolution", "suspect_resolution", "legal_resolution"
    ]).has(stakeRole)) {
      warnings.push(`${label}: stakeRole "${stakeRole}" chưa được hỗ trợ; tool sẽ coi như none.`);
    }
    if (/victim_resolution|hazard_resolution/.test(stakeRole) && !resolvesQuestion) {
      warnings.push(`${label}: evidence giải quyết stake nhưng thiếu resolvesQuestion cụ thể.`);
    }
    if (!new Set(["none", "visual", "verbal", "mixed"]).has(resolutionModality)) {
      warnings.push(`${label}: resolutionModality "${resolutionModality}" chưa được hỗ trợ; tool sẽ coi như none.`);
    }
    if (/victim_resolution|hazard_resolution/.test(stakeRole) && resolutionModality === "none") {
      warnings.push(`${label}: evidence giải quyết stake nhưng chưa phân loại visual/verbal payoff.`);
    }
    if (proceduralBloat && proceduralBloatType === "none") {
      warnings.push(`${label}: proceduralBloat=true nhưng thiếu proceduralBloatType.`);
    }
    if (containsUnexplainedJargon && !jargonTerms.length) {
      warnings.push(`${label}: đánh dấu có jargon nhưng thiếu jargonTerms.`);
    }

    return {
      evidenceId,
      sceneId,
      sourceStartSec: Number.isFinite(sourceStartSec) ? Number(sourceStartSec.toFixed(3)) : null,
      sourceEndSec: Number.isFinite(sourceEndSec) ? Number(sourceEndSec.toFixed(3)) : null,
      visualFacts,
      dialogueEvidence,
      sourceAudioType,
      sourceNarratorPresent,
      sourceNarratorText,
      sceneDialoguePresent,
      storyMeaning,
      viralScore: clampScore(item?.viralScore ?? item?.viralPotential, 0, 10, 5),
      hookScore,
      quoteShock,
      hookType,
      retentionScore,
      clarityScore,
      confidence: clampScore(item?.confidence, 0, 1, 0.5),
      narrativePhase: String(item?.narrativePhase || item?.phase || "").trim(),
      completeBeat,
      cutSafety,
      continuityBefore,
      continuityAfter,
      uniqueMoment: String(item?.uniqueMoment || "").trim(),
      emotionalTrigger: String(item?.emotionalTrigger || "").trim(),
      payoff: String(item?.payoff || "").trim(),
      recommendedUse: String(item?.recommendedUse || "").trim(),
      burnedTextPresent,
      burnedTextContent,
      safeForVoiceover,
      actionCandidateId,
      actionSequenceId,
      actionType: String(item?.actionType || "").trim(),
      actionIntensity: clampScore(item?.actionIntensity, 0, 10, linkedActionCandidate?.actionPriorityScore || 0),
      visualRetentionScore: clampScore(item?.visualRetentionScore, 0, 10, linkedActionCandidate?.actionPriorityScore || 0),
      dialogueDependency: String(item?.dialogueDependency || "unknown").trim().toLowerCase(),
      actorIds,
      primaryActorId,
      speakerActorId,
      relationshipFacts,
      originalAudioValueScore: clampScore(item?.originalAudioValueScore ?? item?.original_audio_value_score, 0, 10, 0),
      originalAudioValueReason: String(item?.originalAudioValueReason || item?.original_audio_value_reason || "").trim(),
      originalAudioProtected: item?.originalAudioProtected === true || item?.original_audio_protected === true,
      narrativeEssential,
      mustInclude,
      stakeRole: new Set([
        "none", "threat_open", "stake_context", "escalation", "victim_resolution",
        "hazard_resolution", "suspect_resolution", "legal_resolution"
      ]).has(stakeRole) ? stakeRole : "none",
      stakeActorIds,
      opensQuestion,
      resolvesQuestion,
      resolutionType,
      resolutionModality: new Set(["none", "visual", "verbal", "mixed"]).has(resolutionModality)
        ? resolutionModality
        : "none",
      visualProofScore,
      proceduralBloat,
      proceduralBloatType,
      mustAppearBeforeLaterTimeJump,
      containsUnexplainedJargon,
      jargonTerms,
      actionOverride: item?.actionOverride === true || mustInclude,
      soundCues: normalizeTextList(item?.soundCues),
      keywords: normalizeTextList(item?.keywords)
    };
  });

  const actionCandidateDecisions = normalizeActionCandidateDecisions(
    payload?.actionCandidateDecisions || payload?.actionDecisions,
    actionCandidateMap,
    errors,
    warnings
  );
  const decisionMap = new Map(actionCandidateDecisions.map((item) => [item.actionCandidateId, item]));
  evidence.forEach((item) => {
    const decision = decisionMap.get(item.actionCandidateId);
    if (decision?.verdict !== "essential") return;
    item.narrativeEssential = true;
    item.mustInclude = true;
    item.actionOverride = true;
    item.actionSequenceId = decision.actionSequenceId || item.actionSequenceId || item.actionCandidateId;
  });

  if (errors.length) {
    const visibleErrors = errors.slice(0, 12).join(" | ");
    const suffix = errors.length > 12 ? ` | ... và ${errors.length - 12} lỗi khác.` : "";
    throw new Error(`${sourceName}: scene evidence không hợp lệ. ${visibleErrors}${suffix}`);
  }
  const sourceRuns = buildSourceRuns(evidence);
  const sustainedRuns = sourceRuns.filter((run) => run.durationSec >= 12 && run.evidenceCount >= 2);

  if (evidence.length < 10) {
    warnings.push(`Chỉ có ${evidence.length} bằng chứng; có thể chưa đủ để dựng video dài trên 60 giây mà vẫn bám sát nguồn và giữ mạch truyện.`);
  }
  const phases = new Set(evidence.map((item) => item.narrativePhase.toLowerCase()).filter(Boolean));
  [
    ["hook", "hook"],
    ["context", "context"],
    ["escalation", "escalation"],
    ["climax/consequence", ["climax", "consequence"]]
  ].forEach(([label, accepted]) => {
    const acceptedPhases = Array.isArray(accepted) ? accepted : [accepted];
    if (!acceptedPhases.some((phase) => phases.has(phase))) {
      warnings.push(`Scene evidence chưa có nhóm ${label} được gắn nhãn rõ ràng.`);
    }
  });
  const lowConfidenceCount = evidence.filter((item) => item.confidence < 0.7).length;
  if (lowConfidenceCount) {
    warnings.push(`${lowConfidenceCount}/${evidence.length} bằng chứng có confidence dưới 0.70; nên kiểm tra lại trước khi viết kịch bản.`);
  }
  const strongHooks = evidence.filter((item) => (
    item.hookScore >= 8
    && (item.completeBeat !== false || (item.quoteShock >= 8 && /semantic|quote|in.?media.?res/.test(item.hookType)))
  ));
  if (!strongHooks.length) {
    warnings.push("Scene evidence chưa có ứng viên hook hoàn chỉnh đạt hookScore từ 8/10.");
  }
  const completeBeatCount = evidence.filter((item) => item.completeBeat === true).length;
  if (completeBeatCount < Math.ceil(evidence.length * 0.6)) {
    warnings.push(`Chỉ ${completeBeatCount}/${evidence.length} evidence xác nhận completeBeat=true; nguy cơ cắt cụt lời thoại hoặc phản ứng còn cao.`);
  }
  if (!sustainedRuns.length) {
    warnings.push("Scene evidence chưa tạo được source run liên tục tối thiểu 12s với từ hai evidence; Pass 2 có nguy cơ tiếp tục ghép cảnh vụn.");
  }

  const actorTaggedEvidenceCount = evidence.filter((item) => item.actorIds.length || item.primaryActorId).length;
  if (!actorIdentityMap.length) {
    warnings.push("Scene evidence is missing actorIdentityMap; cross-scene identity and relationship checks are unavailable.");
  } else if (actorTaggedEvidenceCount < Math.ceil(evidence.length * 0.7)) {
    warnings.push(`Only ${actorTaggedEvidenceCount}/${evidence.length} evidence items have actorIds/primaryActorId; cross-scene identity may be ambiguous.`);
  }

  const actionCoverageItems = actionCandidates.map((candidate) => {
    const decision = decisionMap.get(candidate.actionCandidateId);
    const measured = measureCandidateCoverage(candidate, evidence);
    return {
      actionCandidateId: candidate.actionCandidateId,
      mustReview: candidate.mustReview === true,
      reviewed: Boolean(decision),
      verdict: decision?.verdict || "unreviewed",
      actionSequenceId: decision?.actionSequenceId || candidate.actionCandidateId,
      ...measured
    };
  });
  const actionCoverage = {
    candidateCount: actionCandidates.length,
    mustReviewCount: actionCandidates.filter((item) => item.mustReview === true).length,
    reviewedMustReviewCount: actionCoverageItems.filter((item) => item.mustReview && item.reviewed).length,
    essentialCount: actionCoverageItems.filter((item) => item.verdict === "essential").length,
    items: actionCoverageItems
  };

  return {
    artifactType: "scene_evidence",
    schemaVersion: 1,
    sourceVideo: manifest?.sourceVideo || "",
    timelineType: "source_timeline",
    generatedBy: "gemini_manual_pass_1",
    validatedAt: new Date().toISOString(),
    actorIdentityMap,
    evidence,
    actionCandidateDecisions,
    actionCoverage,
    sourceRuns,
    viralReadiness: {
      strongHookCandidates: strongHooks.length,
      completeBeatRatio: Number((completeBeatCount / evidence.length).toFixed(3)),
      lowConfidenceCount,
      sourceRunCount: sourceRuns.length,
      sustainedSourceRunCount: sustainedRuns.length,
      actorIdentityCount: actorIdentityMap.length,
      actorTaggedEvidenceRatio: Number((actorTaggedEvidenceCount / evidence.length).toFixed(3))
    },
    warnings
  };
}

function evaluateEvidenceQuality(evidencePayload, manifest = {}, actionCandidatesPayload = {}) {
  const evidence = Array.isArray(evidencePayload?.evidence) ? evidencePayload.evidence : [];
  const durationSec = Number(manifest?.videoDurationSec || 0);
  const minimumEvidenceCount = durationSec > 300
    ? 20
    : durationSec > 60
    ? 12
    : Math.max(4, Math.min(8, Number(manifest?.scenes?.length || 4) * 2));
  const sustainedRunMinSec = Math.min(12, Math.max(4, durationSec * 0.75));
  const phases = new Set(evidence.map((item) => String(item.narrativePhase || "").toLowerCase()).filter(Boolean));
  const requiredPhases = [
    { key: "hook", accepted: ["hook"] },
    { key: "context", accepted: ["context", "setup"] },
    { key: "escalation", accepted: ["escalation", "conflict", "twist", "reveal"] },
    { key: "climax/consequence", accepted: ["climax", "consequence", "resolution", "aftermath"] }
  ];
  const missingPhases = requiredPhases
    .filter((group) => !group.accepted.some((phase) => phases.has(phase)))
    .map((group) => group.key);
  const strongHooks = evidence.filter((item) => (
    Number(item.hookScore || 0) >= 8
    && String(item.cutSafety || "").toLowerCase() === "safe"
    && (item.completeBeat === true || (Number(item.quoteShock || 0) >= 8 && /semantic|quote|in.?media.?res/.test(String(item.hookType || ""))))
  ));
  const completeBeatCount = evidence.filter((item) => item.completeBeat === true).length;
  const completeBeatRatio = evidence.length ? completeBeatCount / evidence.length : 0;
  const lowConfidenceCount = evidence.filter((item) => Number(item.confidence || 0) < 0.7).length;
  const lowConfidenceRatio = evidence.length ? lowConfidenceCount / evidence.length : 1;
  const sourceRuns = Array.isArray(evidencePayload?.sourceRuns) ? evidencePayload.sourceRuns : [];
  const sustainedRuns = sourceRuns.filter((run) => (
    Number(run.durationSec || 0) >= sustainedRunMinSec
    && Number(run.evidenceCount || 0) >= 2
  ));
  const failures = [];
  const recommendations = [];
  let score = 100;

  if (evidence.length < minimumEvidenceCount) {
    score -= 20;
    failures.push(`Chỉ có ${evidence.length}/${minimumEvidenceCount} evidence tối thiểu cho video dài ${durationSec.toFixed(1)}s.`);
    recommendations.push("Xem lại toàn bộ proxy và bổ sung các cảnh có giá trị ở đầu, giữa và cuối video.");
  }
  if (!strongHooks.length) {
    score -= 20;
    failures.push("Không có hook semantic hoặc action đạt hookScore từ 8/10 và cắt an toàn.");
    recommendations.push("Bổ sung hook candidate có quoteShock/semanticHookScore cao hoặc action hook rõ ràng; Hook được phép bắt đầu giữa exchange nếu timestamp vẫn chính xác.");
  }
  if (completeBeatRatio < 0.7) {
    score -= 20;
    failures.push(`Complete beat chỉ đạt ${Math.round(completeBeatRatio * 100)}%, thấp hơn ngưỡng 70%.`);
    recommendations.push("Mở rộng hoặc thay các evidence bị cắt giữa câu, giữa hành động hay thiếu phản ứng ngay sau đó.");
  }
  if (!sustainedRuns.length) {
    score -= 20;
    failures.push(`Không có source run liên tục tối thiểu ${sustainedRunMinSec.toFixed(1)} giây gồm ít nhất hai evidence liền kề.`);
    recommendations.push("Bổ sung setup và phản ứng liền kề quanh các cảnh cao trào để hình thành khối truyện liên tục.");
  }
  if (missingPhases.length) {
    score -= Math.min(20, missingPhases.length * 5);
    failures.push(`Thiếu evidence cho nhịp truyện: ${missingPhases.join(", ")}.`);
    recommendations.push("Bổ sung causal path hoàn chỉnh từ Hook qua Context/Escalation đến Climax hoặc Consequence.");
  }
  if (lowConfidenceRatio > 0.3) {
    score -= 10;
    failures.push(`${lowConfidenceCount}/${evidence.length} evidence có confidence dưới 0.70.`);
    recommendations.push("Xác minh lại visualFacts, dialogueEvidence và timestamp của các evidence độ tin cậy thấp.");
  }
  const actionCandidates = Array.isArray(actionCandidatesPayload?.candidates) ? actionCandidatesPayload.candidates : [];
  const actionCoverageItems = Array.isArray(evidencePayload?.actionCoverage?.items)
    ? evidencePayload.actionCoverage.items
    : [];
  const unreviewedActionCandidates = actionCoverageItems.filter((item) => item.mustReview && !item.reviewed);
  const undercoveredEssentialActions = actionCoverageItems.filter((item) => (
    item.verdict === "essential" && Number(item.coverageRatio || 0) < 0.6
  ));
  if (actionCandidates.length && unreviewedActionCandidates.length) {
    score -= 20;
    failures.push(`${unreviewedActionCandidates.length} ứng viên hành động bắt buộc chưa được Gemini xem và phân loại.`);
    recommendations.push("Xem từng actionCandidate mustReview trong proxy và bổ sung actionCandidateDecisions với lý do hình ảnh cụ thể.");
  }
  if (undercoveredEssentialActions.length) {
    score -= 25;
    failures.push(`${undercoveredEssentialActions.length} action sequence thiết yếu chưa được evidence phủ tối thiểu 60% thời lượng.`);
    recommendations.push("Bổ sung các evidence scene-bounded liên tiếp, dùng chung actionSequenceId, để giữ trọn hành động và phản ứng ngay sau đó.");
  }

  const normalizedScore = Math.max(0, Math.round(score));
  return {
    passed: failures.length === 0 && normalizedScore >= 80,
    score: normalizedScore,
    failures,
    recommendations: [...new Set(recommendations)],
    metrics: {
      evidenceCount: evidence.length,
      minimumEvidenceCount,
      sustainedRunMinSec: Number(sustainedRunMinSec.toFixed(3)),
      strongHookCount: strongHooks.length,
      completeBeatRatio: Number(completeBeatRatio.toFixed(3)),
      lowConfidenceRatio: Number(lowConfidenceRatio.toFixed(3)),
      sustainedSourceRunCount: sustainedRuns.length,
      actionCandidateCount: actionCandidates.length,
      unreviewedActionCandidateCount: unreviewedActionCandidates.length,
      undercoveredEssentialActionCount: undercoveredEssentialActions.length,
      missingPhases
    }
  };
}

function buildEvidenceRepairPrompt({ candidate, qualityGate, manifest, actionCandidates = {} }) {
  return `${buildGeminiInputAccessGate({
    stage: "scene_evidence_repair",
    requiredInputs: ["complete analysis proxy/proxy chunks", "scene-manifest.json", "source transcript when supplied", "action-candidates.json", "current candidate JSON"]
  })}

USER TASK INSTRUCTION - REPAIR PASS 1 SCENE EVIDENCE

The uploaded candidate was structurally valid, but it failed the local Evidence Quality Gate. Repair the evidence before any script is written. Re-watch the complete analysis proxy and use the manifest/transcript supplied in this folder. Do not create a story script.

FAILED QUALITY GATE:
${qualityGate.failures.map((item, index) => `${index + 1}. ${item}`).join("\n")}

REQUIRED REPAIRS:
${qualityGate.recommendations.map((item, index) => `${index + 1}. ${item}`).join("\n")}

HARD RULES:
1. Preserve only facts verified by the proxy, source audio, transcript, and scene-manifest.json.
2. Every evidence range must remain inside exactly one sceneId.
3. Preserve complete dialogue/action/reaction beats; never cut a sentence or decisive reaction in half.
4. Create adjacent setup and reaction evidence around important moments so at least one source run lasts 12 seconds or longer.
5. Include a complete causal path covering hook, context, escalation, and climax/consequence.
6. Do not merely increase scores. Replace weak evidence with concrete visual/dialogue evidence and truthful timestamps.
7. Return scene-evidence.json using the mandatory JSON code-block contract below.
8. Review every mustReview item in action-candidates.json. Never omit a major physical event merely because it has little or no transcript.
9. Every essential action must use linked scene-bounded evidence covering at least 60% of the candidate range and preserving the immediate reaction.
10. For each victim/hazard resolution candidate, classify resolutionModality and visualProofScore. Keep the strongest visual/mixed proof available, not only a spoken confirmation.
11. Mark routine written statements, paperwork, phone-number collection, name spelling, forms, report details, or station instructions as proceduralBloat unless the range contains indispensable conflict or unique evidence.

${buildSingleJsonCodeBlockContract("scene-evidence.json", 'The root must contain artifactType="scene_evidence" and a non-empty evidence array; it must not contain top-level segments.')}

SOURCE MANIFEST:
${JSON.stringify(manifest, null, 2)}

LOCAL ACTION CANDIDATES:
${JSON.stringify(actionCandidates, null, 2)}

CURRENT CANDIDATE TO REPAIR:
${JSON.stringify(candidate, null, 2)}`;
}

function normalizeIdList(value) {
  return Array.isArray(value) ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))] : [];
}

function normalizeNarrativeContract(value = {}, validEvidenceIds = null) {
  const hasContract = Boolean(value && typeof value === "object" && Object.keys(value).length);
  const input = hasContract ? value : {};
  const mandatoryInput = input.mandatoryResolution || input.mandatory_resolution || {};
  const secondaryInput = input.secondaryPayoff || input.secondary_payoff || {};
  const cleanEvidenceIds = (items) => normalizeIdList(items).filter((evidenceId) => (
    !validEvidenceIds || validEvidenceIds.has(evidenceId)
  ));
  return {
    hookPromise: String(input.hookPromise || input.hook_promise || "").trim(),
    primaryAudienceQuestion: String(
      input.primaryAudienceQuestion || input.primary_audience_question || input.audienceQuestion || ""
    ).trim(),
    primaryStakeType: String(input.primaryStakeType || input.primary_stake_type || "").trim().toLowerCase(),
    stakeActorIds: normalizeIdList(input.stakeActorIds || input.stake_actor_ids),
    mandatoryResolution: {
      required: hasContract && mandatoryInput.required !== false,
      resolutionType: String(mandatoryInput.resolutionType || mandatoryInput.resolution_type || "").trim().toLowerCase(),
      evidenceIds: cleanEvidenceIds(mandatoryInput.evidenceIds || mandatoryInput.evidence_ids),
      preferredVisualEvidenceIds: cleanEvidenceIds(
        mandatoryInput.preferredVisualEvidenceIds || mandatoryInput.preferred_visual_evidence_ids
      ),
      fallbackVerbalEvidenceIds: cleanEvidenceIds(
        mandatoryInput.fallbackVerbalEvidenceIds || mandatoryInput.fallback_verbal_evidence_ids
      ),
      visualFirstRequired: mandatoryInput.visualFirstRequired !== false
        && mandatoryInput.visual_first_required !== false,
      mustAppearBeforeLaterTimeJump: mandatoryInput.mustAppearBeforeLaterTimeJump !== false
        && mandatoryInput.must_appear_before_later_time_jump !== false,
      verifiedOutcome: String(mandatoryInput.verifiedOutcome || mandatoryInput.verified_outcome || "").trim()
    },
    secondaryPayoff: {
      required: secondaryInput.required === true,
      mustBeFinal: secondaryInput.mustBeFinal === true || secondaryInput.must_be_final === true,
      question: String(secondaryInput.question || "").trim(),
      evidenceIds: cleanEvidenceIds(secondaryInput.evidenceIds || secondaryInput.evidence_ids),
      verifiedOutcome: String(secondaryInput.verifiedOutcome || secondaryInput.verified_outcome || "").trim()
    }
  };
}

function normalizeStorySpine(value = {}, validEvidenceIds = null) {
  const input = value && typeof value === "object" ? value : {};
  const cleanEvidenceIds = (items) => normalizeIdList(items).filter((evidenceId) => (
    !validEvidenceIds || validEvidenceIds.has(evidenceId)
  ));
  return {
    centralViewerQuestion: String(
      input.centralViewerQuestion || input.central_viewer_question || ""
    ).trim(),
    hookPromise: String(input.hookPromise || input.hook_promise || "").trim(),
    rewindContext: String(input.rewindContext || input.rewind_context || "").trim(),
    escalationPath: normalizeTextList(input.escalationPath || input.escalation_path),
    climax: String(input.climax || "").trim(),
    climaxEvidenceIds: cleanEvidenceIds(input.climaxEvidenceIds || input.climax_evidence_ids),
    payoff: String(input.payoff || "").trim(),
    payoffEvidenceIds: cleanEvidenceIds(input.payoffEvidenceIds || input.payoff_evidence_ids),
    finalOutcomeRequired: input.finalOutcomeRequired === true || input.final_outcome_required === true,
    finalOutcome: String(input.finalOutcome || input.final_outcome || "").trim(),
    finalOutcomeEvidenceIds: cleanEvidenceIds(input.finalOutcomeEvidenceIds || input.final_outcome_evidence_ids)
  };
}

function validateStoryBlueprint(payload, evidencePayload, sourceName = "story-blueprint.json") {
  const input = payload?.story_blueprint || payload?.storyBlueprint || payload;
  const macroBlocks = Array.isArray(input?.macroBlocks) ? input.macroBlocks : [];
  if (!input || typeof input !== "object" || !macroBlocks.length) {
    throw new Error(`${sourceName}: thiếu story_blueprint.macroBlocks có dữ liệu.`);
  }
  const validEvidenceIds = new Set((evidencePayload?.evidence || []).map((item) => item.evidenceId));
  const evidenceById = new Map((evidencePayload?.evidence || []).map((item) => [item.evidenceId, item]));
  const errors = [];
  const seenMacroIds = new Set();
  const normalizedBlocks = macroBlocks.map((block, index) => {
    const macroBlockId = String(block?.macroBlockId || `macro_${String(index + 1).padStart(2, "0")}`).trim();
    const storyFunction = String(block?.storyFunction || block?.phase || "").trim().toLowerCase();
    const evidenceIds = normalizeIdList(block?.evidenceIds || block?.evidence_ids);
    const sourceRunIds = normalizeIdList(block?.sourceRunIds || block?.source_run_ids);
    if (seenMacroIds.has(macroBlockId)) errors.push(`macro-block ${index + 1}: macroBlockId "${macroBlockId}" bị trùng.`);
    seenMacroIds.add(macroBlockId);
    if (!storyFunction) errors.push(`macro-block ${index + 1}: thiếu storyFunction.`);
    if (!evidenceIds.length) errors.push(`macro-block ${index + 1}: thiếu evidenceIds.`);
    evidenceIds.forEach((evidenceId) => {
      if (!validEvidenceIds.has(evidenceId)) errors.push(`macro-block ${index + 1}: evidenceId "${evidenceId}" chưa được khóa.`);
    });
    const derivedRuns = normalizeIdList(evidenceIds.map((evidenceId) => evidenceById.get(evidenceId)?.sourceRunId));
    const partNumbers = [...new Set((Array.isArray(block?.partNumbers) ? block.partNumbers : [])
      .map((value) => Number(value))
      .filter((value) => [1, 2, 3].includes(value)))];
    return {
      macroBlockId,
      storyFunction,
      sourceRunIds: sourceRunIds.length ? sourceRunIds : derivedRuns,
      evidenceIds,
      partNumbers,
      summary: String(block?.summary || "").trim(),
      transitionReason: String(block?.transitionReason || block?.transition_reason || "").trim()
    };
  });
  const phases = new Set(normalizedBlocks.map((block) => block.storyFunction));
  const blueprintEvidenceIds = new Set(normalizedBlocks.flatMap((block) => block.evidenceIds));
  const narrativeContract = normalizeNarrativeContract(
    input.narrativeContract || input.narrative_contract,
    validEvidenceIds
  );
  const storySpine = normalizeStorySpine(input.storySpine || input.story_spine, validEvidenceIds);
  if (narrativeContract.mandatoryResolution.required) {
    if (!narrativeContract.hookPromise) errors.push("Blueprint thiếu narrativeContract.hookPromise.");
    if (!narrativeContract.primaryAudienceQuestion) errors.push("Blueprint thiếu narrativeContract.primaryAudienceQuestion.");
    if (!narrativeContract.mandatoryResolution.evidenceIds.length) {
      errors.push("Blueprint thiếu mandatoryResolution.evidenceIds để khóa payoff chính.");
    }
    const missingResolutionEvidence = narrativeContract.mandatoryResolution.evidenceIds
      .filter((evidenceId) => !blueprintEvidenceIds.has(evidenceId));
    if (missingResolutionEvidence.length) {
      errors.push(`Blueprint chưa đưa resolution evidence bắt buộc vào macroBlocks: ${missingResolutionEvidence.join(", ")}.`);
    }
  }
  if (narrativeContract.secondaryPayoff.required) {
    if (!narrativeContract.secondaryPayoff.evidenceIds.length) {
      errors.push("Blueprint đánh dấu secondaryPayoff.required=true nhưng thiếu evidenceIds.");
    }
    const missingFinalEvidence = narrativeContract.secondaryPayoff.evidenceIds
      .filter((evidenceId) => !blueprintEvidenceIds.has(evidenceId));
    if (missingFinalEvidence.length) {
      errors.push(`Blueprint chưa đưa final-outcome evidence bắt buộc vào macroBlocks: ${missingFinalEvidence.join(", ")}.`);
    }
  }
  const missingEssentialEvidence = (evidencePayload?.evidence || [])
    .filter((item) => item.mustInclude === true && !blueprintEvidenceIds.has(item.evidenceId));
  if (missingEssentialEvidence.length) {
    errors.push(`Blueprint bỏ sót ${missingEssentialEvidence.length} evidence hành động mustInclude: ${missingEssentialEvidence.slice(0, 8).map((item) => item.evidenceId).join(", ")}.`);
  }
  if (![...phases].some((phase) => /hook/.test(phase))) errors.push("Blueprint thiếu macro-block Hook.");
  if (![...phases].some((phase) => /escalat|conflict|twist|reveal/.test(phase))) errors.push("Blueprint thiếu macro-block Escalation/Reveal.");
  if (![...phases].some((phase) => /climax|consequence|resolution|aftermath|outro/.test(phase))) errors.push("Blueprint thiếu Climax/Consequence/Payoff.");
  if (errors.length) throw new Error(`${sourceName}: blueprint không hợp lệ. ${errors.slice(0, 12).join(" | ")}`);
  return {
    artifactType: "story_blueprint",
    schemaVersion: 1,
    centralCharacter: String(input.centralCharacter || "").trim(),
    primaryConflict: String(input.primaryConflict || "").trim(),
    audienceQuestion: String(input.audienceQuestion || "").trim(),
    factualCausalChain: normalizeTextList(input.factualCausalChain || input.causalChain),
    setup: String(input.setup || "").trim(),
    escalation: String(input.escalation || "").trim(),
    climax: String(input.climax || "").trim(),
    consequence: String(input.consequence || "").trim(),
    finalPayoff: String(input.finalPayoff || "").trim(),
    storySpine,
    narrativeContract,
    macroBlocks: normalizedBlocks
  };
}

function isSerializedPrompt(basePrompt = "") {
  return /prompt_profile\s*[:=]\s*(?:serialized_interleaved|serialized_genz)|BUILD A 3-PART SERIALIZED TRUE-CRIME SERIES/i.test(String(basePrompt || ""));
}

function serializedPromptProfile(basePrompt = "") {
  return /prompt_profile\s*[:=]\s*serialized_genz/i.test(String(basePrompt || ""))
    ? "serialized_genz"
    : "serialized_interleaved";
}

function buildStoryBlueprintPrompt({ evidencePayload, manifest, basePrompt = "" }) {
  const serialized = isSerializedPrompt(basePrompt);
  const independentOptions = extractIndependentPromptOptions(basePrompt);
  const independentHookRules = serialized ? "" : buildIndependentHookFallbackRules(independentOptions);
  const serializedBlueprintRules = serialized
    ? `SERIALIZED SERIES BLUEPRINT OVERRIDE - HIGHEST PRIORITY:
- This is ONE continuous case divided into Part 1, Part 2, and Part 3, not three independent thematic variants.
- Ignore all independent-variant profile semantics. The numeric script IDs are compatibility identifiers only and never define different editorial styles in this workflow.
- Assign every macroBlock a required partNumbers array. The shared Hook uses [1,2,3]. Every non-Hook macro-block normally belongs to exactly one Part so the chapters advance instead of cloning each other.
- Part 1 establishes the verified premise and immediate stakes, then ends on a verified unresolved escalation.
- Part 2 begins after the shared Hook with a concise recap bridge, advances the central conflict with new evidence/action, and ends on the strongest verified pre-climax turn.
- Part 3 begins after the shared Hook with a concise final-chapter orientation, delivers the climax, immediate consequence, and only the outcome explicitly verified by evidence.
- SPOILER BAN: Part 1 and Part 2 must not contain the final plot twist, decisive hidden evidence, test result, formal arrest, court sentence, or ultimate legal consequence. Assign those reveals only to Part 3. Do not duplicate the arrest, sentence or final Karma payoff across Parts.
- Part 1 may establish the premise, bizarre behavior and immediate stakes, but must stop at an unresolved confrontation, suspicious lie, request to search or another verified open question.
- Part 2 may show blame, contradiction, argument, refusal and middle escalation, but must stop at the boiling-point pre-climax turn before the decisive reveal.
- Distribute mustInclude evidence across the three Parts according to causal order. Do not force every mustInclude action into every Part. Apart from the shared Hook and a very short evidence-grounded recap, do not duplicate macro-blocks across Parts.
- CRITICAL ANTI-TALKING-HEAD RULE: A series cannot be built only from aftermath interviews, roadside explanations, or static conversations. If the source title, visual proxy, action candidates, or evidence indicates a major physical event, include the actual event and immediate reaction in the appropriate Part even when it has no dialogue or SRT text.
- ANTI-HALLUCINATION PROTOCOL: consequence and finalPayoff may state only the last verified immediate result. If the source does not explicitly verify a suspect name, charge, plea, sentence, jail term, death, or court outcome, write unknown/not established and end at the arrest, custody, rescue, medical response, or investigation actually shown. Never recycle facts from another case or prior conversation.`
    : "";
  return `${buildGeminiInputAccessGate({
    stage: "story_blueprint",
    requiredInputs: ["locked scene-evidence JSON", "scene-manifest summary", "the complete editorial prompt"]
  })}

USER TASK INSTRUCTION - BUILD THE SHARED STORY BLUEPRINT

Create the shared causal story plan before writing any variant timeline. Use only the locked evidence below. Do not create Script 1, Script 3, Script 4, or output segments yet.

${serializedBlueprintRules}

${independentHookRules}

STORY SPINE - HIGHEST EDITORIAL PRIORITY:
- Before selecting any footage or macro-block, identify ONE central viewer question created by the Hook.
- Build the complete video around answering that one question. Every selected beat must increase the stakes, reveal new information, escalate the conflict, move closer to the answer, deliver the promised climax, or provide its immediate payoff.
- Preferred structure: CLIMAX TEASER / HIGH-STAKES HOOK -> brief rewind/context -> escalating causal events -> return to the promised climax -> immediate aftermath/payoff.
- Remove footage that is interesting but does not advance this story. Do not abandon the Hook's primary question to show a secondary twist, arrest, or legal outcome.
- Write storySpine BEFORE narrativeContract and macroBlocks. centralViewerQuestion and hookPromise must match narrativeContract.primaryAudienceQuestion and narrativeContract.hookPromise.
- climaxEvidenceIds must contain the source event that fulfills the Hook promise. payoffEvidenceIds must contain the visual-first aftermath or verified answer that resolves the viewer's emotional investment.
- TWO-LAYER PAYOFF: payoff/payoffEvidenceIds close the immediate victim, hazard, evidence, or physical question. When the source explicitly verifies a later arrest, sentence, legal result, or current status, set finalOutcomeRequired=true, populate finalOutcome/finalOutcomeEvidenceIds, and make narrativeContract.secondaryPayoff required + mustBeFinal. The final timeline must end on that verified outcome after the primary payoff. If the source does not verify one, set finalOutcomeRequired=false and never invent it.
- If the planned timeline does not fulfill hookPromise and answer centralViewerQuestion, reject it internally and rebuild it before returning JSON.

TASK:
1. ${serialized
    ? "Choose the strongest ACTION-FIRST Hook by scanning the entire source, transcript, action candidates, and locked evidence. Prefer a clear high-adrenaline sequence with setup, confrontation/action, climax, and immediate reaction. The complete Hook may last 5-30 seconds and may span consecutive evidence slices sharing one actionSequenceId."
    : `Choose the Hook by applying the user-locked priority fallback above. The complete Hook may last 4-${independentOptions.hookMaxSec} seconds and may span consecutive evidence slices sharing one actionSequenceId.`}
2. Define storySpine first, then the central character, primary conflict, audience question, factual causal chain, setup, escalation, climax, consequence, and final payoff.
2A. Write narrativeContract BEFORE macroBlocks. Identify the exact promise made by the Hook, the primary victim/person/object/hazard at stake, and the locked evidence that explicitly resolves that stake. The suspect's later arrest or legal outcome does not resolve a victim-safety question.
2B. If the Hook opens a concrete life, safety, hostage, missing-person, weapon, crash, or injury question, mandatoryResolution.required=true. Its evidenceIds must show or explicitly state the verified immediate outcome and must appear before any later-time suspect/legal payoff.
2C. VISUAL-FIRST RESOLUTION: Compare every locked resolution candidate. Put the strongest visual/mixed proof in preferredVisualEvidenceIds and weaker dialogue-only confirmation in fallbackVerbalEvidenceIds. When a visual rescue, safe victim, removed hazard, crash aftermath, recovered object, or physical evidence exists, visualFirstRequired=true and the verbal fallback may not replace it.
3. Build the minimum causal macroBlocks needed for a complete story, typically 4-8. This is an adaptive budget, not permission to amputate a required victim/hazard resolution. Prefer continuous sourceRunId ranges and consecutive evidenceIds.
4. Each block after the hook must explain a concrete temporal or causal connection to the previous block.
5. Do not sort evidence by viralScore and do not create a montage of isolated shocks.
6. Use only locked evidenceId/sourceRunId values. Never invent a timestamp, fact, legal result, person, weapon, or outcome.
7. Every evidence item with mustInclude=true MUST appear in a macroBlock. Keep evidence sharing one actionSequenceId in one sustained action macro-block.
8. Do not interrupt an actionOverride sequence merely to alternate voiceover and original audio. Preserve the action and immediate reaction, then place narration before or after it.
9. VISUAL EVENT COVERAGE: If witnesses talk about a major action and locked evidence contains that physical event, the physical event must be a macroBlock. Immediately after each hook, select the strongest available visual-stakes evidence showing the danger, injury, weapon, crash, trapped person, or concrete consequence implied by the hook. Talking about an event never substitutes for showing the verified event.
10. UNKNOWN OUTCOME IS VALID: Do not manufacture a legal resolution merely to fill consequence or finalPayoff. Use the final verified immediate consequence and mark later outcomes unknown when evidence stops there.
11. STAKE RESOLUTION GATE: Every mandatoryResolution.evidenceId MUST appear in a resolution/consequence macroBlock. Never jump to "later", "months later", court, surrender, arrest, or sentencing while the Hook's immediate victim/hazard question remains unresolved.
12. CLARITY OVER JARGON: Do not rely on unexplained police codes, street callouts, radio shorthand, or procedural language as a story beat. Omit weak jargon ranges or plan a concise bridge that explains their concrete meaning.
13. TIKTOK PROCEDURAL-BLOAT FILTER: Exclude routine administrative footage without intense emotion, contradiction, direct conflict, or unique evidence: written-statement requests, paperwork, phone-number collection, spelling names, forms, routine report details, or invitations to visit the station. These are not escalation or payoff.

DELIVERY CONTRACT:
${buildSingleJsonCodeBlockContract("story-blueprint.json", 'Root artifactType must equal "story_blueprint" and the root must not contain a segments array.')}

REQUIRED SCHEMA:
{
  "artifactType": "story_blueprint",
  "schemaVersion": 1,
  "independentPromptOptions": ${serialized ? "null" : JSON.stringify(independentOptions, null, 2)},
  "hookSelectionAudit": ${serialized ? "null" : `{
    "requestedPriority": ${JSON.stringify(independentOptions.hookPriority)},
    "selectedType": "high_action|dialogue_conflict|psychological_wtf|evidence_reveal",
    "fallbackLevel": 1,
    "selectedEvidenceIds": ["evidence_0001"],
    "reason": "Why the first qualifying category and candidate won",
    "rejectedHigherPriorityCandidates": []
  }`},
  "centralCharacter": "",
  "primaryConflict": "",
  "audienceQuestion": "",
  "factualCausalChain": ["because...", "therefore..."],
  "setup": "",
  "escalation": "",
  "climax": "",
  "consequence": "",
  "finalPayoff": "",
  "storySpine": {
    "centralViewerQuestion": "What the viewer desperately wants to know after the Hook",
    "hookPromise": "What the opening implicitly promises the viewer will see or learn",
    "rewindContext": "The minimum verified context needed after the teaser",
    "escalationPath": ["Verified beat that raises stakes", "Verified beat that moves toward the promised climax"],
    "climax": "The source event that fulfills the Hook promise",
    "climaxEvidenceIds": ["evidence_0008"],
    "payoff": "The immediate emotional or factual answer",
    "payoffEvidenceIds": ["evidence_0010"],
    "finalOutcomeRequired": true,
    "finalOutcome": "The later verified sentence, legal result, or current status",
    "finalOutcomeEvidenceIds": ["evidence_0012"]
  },
  "narrativeContract": {
    "hookPromise": "The concrete verified promise opened by the Hook",
    "primaryAudienceQuestion": "The exact question a cold viewer now needs answered",
    "primaryStakeType": "victim_safety|hostage|missing_person|injury|weapon|crash|evidence|suspect_outcome|other",
    "stakeActorIds": ["actor_001"],
    "mandatoryResolution": {
      "required": true,
      "resolutionType": "rescue|safety_confirmation|medical_outcome|hazard_removed|evidence_reveal|suspect_outcome|unknown",
      "evidenceIds": ["evidence_0009"],
      "preferredVisualEvidenceIds": ["evidence_0010"],
      "fallbackVerbalEvidenceIds": ["evidence_0009"],
      "visualFirstRequired": true,
      "mustAppearBeforeLaterTimeJump": true,
      "verifiedOutcome": "Exact outcome supported by the locked evidence"
    },
    "secondaryPayoff": {
      "required": true,
      "mustBeFinal": true,
      "question": "Later suspect/legal question when explicitly verified by source evidence",
      "evidenceIds": ["evidence_0012"],
      "verifiedOutcome": "Optional later verified payoff"
    }
  },
  "macroBlocks": [{
    "macroBlockId": "macro_01",
    "storyFunction": "hook | context | escalation | reveal | climax | consequence | outro",
    "sourceRunIds": ["source_run_0001"],
    "evidenceIds": ["evidence_0001"],
    "partNumbers": ${serialized ? "[1, 2, 3]" : "[]"},
    "summary": "A complete factual beat understandable to a cold viewer.",
    "transitionReason": "Concrete causal or temporal connection from the preceding block."
  }]
}

SOURCE MANIFEST SUMMARY:
${JSON.stringify({ sourceVideo: manifest?.sourceVideo || "", videoDurationSec: manifest?.videoDurationSec || 0 }, null, 2)}

LOCKED SCENE EVIDENCE:
${JSON.stringify(evidencePayload, null, 2)}`;
}

function extractVoiceCalibrationBlock(basePrompt = "") {
  const match = String(basePrompt).match(/VOICE CALIBRATION PARAMETERS PROVIDED BY USER:[\s\S]*?(?=\n---|\n###)/i);
  return match ? match[0].trim() : "VOICE CALIBRATION PARAMETERS PROVIDED BY USER:\n- measuredWordsPerSecond: NOT_MEASURED";
}

function extractSerializedDurationBounds(basePrompt = "") {
  const match = String(basePrompt).match(/target duration for EACH Part:\s*([\d.]+)\s*-\s*([\d.]+)\s*seconds/i);
  const min = Math.max(60.5, Number(match?.[1]) || 75);
  const max = Math.max(min, Number(match?.[2]) || 110);
  return { min, max };
}

function buildSerializedSinglePartPrompt({ scriptId, evidencePayload, blueprint, manifest, basePrompt = "" }) {
  const partNumber = new Map([[1, 1], [3, 2], [4, 3]]).get(Number(scriptId));
  if (!partNumber) throw new Error(`Không hỗ trợ Script ${scriptId} trong Series Part 1-3.`);
  const { min, max } = extractSerializedDurationBounds(basePrompt);
  const promptProfile = serializedPromptProfile(basePrompt);
  const genZRules = promptProfile === "serialized_genz"
    ? `GEN-Z / MILLENNIAL VOICE OVERRIDE - HIGHEST PRIORITY FOR NARRATION:
- Write fast-paced conversational internet English, as if gossiping with the viewer about a wild verified situation. Never sound like a formal news report, documentary, or police report.
- The first voiceover sentence in this Part MUST create a curiosity gap by asking a question or pointing out a verified absurdity. Do not merely describe the visible action.
- Voiceover acts as the audience's inner reaction: call out verified contradictions, add hidden verified context, or sharpen the stakes. Never merely repeat an obvious on-screen action.
- Suggested phrases may include "This Karen literally lost her mind", "Instant karma", "Main character syndrome", "Her excuse makes zero sense", "Wait until you see what she does next", "The audacity", and "Unhinged behavior", but only where locked evidence supports the underlying claim.
- Do not use formal terms such as "erratic", "inexplicably", "ironclad", "unprovoked assault", "devastating charges", or "altercation". Prefer grounded casual equivalents.
- TONE DECOUPLING: Facts remain exact and evidence-grounded while wording stays dramatic and casual. Do not upgrade arguing into fighting, crying into violence, or refusal into a physical struggle.`
    : "";
  const assignedBlocks = (blueprint?.macroBlocks || []).filter((block) => (
    (block.partNumbers || []).includes(partNumber)
  ));
  const assignedEvidenceIds = [...new Set(assignedBlocks.flatMap((block) => block.evidenceIds || []))];
  const chapterRole = partNumber === 1
    ? "Establish the verified premise and immediate stakes, then end on the assigned unresolved escalation."
    : partNumber === 2
    ? "After the shared Hook, use one concise recap bridge, advance the conflict with NEW assigned evidence, and end on the assigned pre-climax turn."
    : "After the shared Hook, orient the final chapter, deliver the assigned climax and immediate verified consequence, then end cleanly.";
  return `${buildGeminiInputAccessGate({
    stage: `serialized_part_${partNumber}`,
    requiredInputs: ["locked shared story blueprint", "locked scene evidence", "scene-manifest summary", "voice calibration block"]
  })}

USER TASK INSTRUCTION - CREATE SERIALIZED PART ${partNumber} ONLY

Create exactly one production JSON timeline for Part ${partNumber} of one continuous three-Part case. Compatibility requires scriptId=${scriptId}, but this numeric ID has no editorial meaning in this workflow.

SERIALIZATION IDENTITY - HIGHEST PRIORITY:
- prompt_profile="${promptProfile}", series_mode="interleaved_multipart", scriptId=${scriptId}, part_number=${partNumber}, part_badge="PART ${partNumber}".
- Populate shared_top_banner_text with one concise, evidence-grounded curiosity title for the COMPLETE case. It is a shared series banner, not a Part title: use the exact same value in Parts 1, 2, and 3. Prefer 6-14 words, create a truthful curiosity gap, and do not reveal the final outcome.
- Do not apply any independent-variant profile or thematic-angle rules. This output is a serialized chapter and must advance the same locked case story.
- ${chapterRole}
- Final duration must be ${min}-${max} seconds and never below 60.5 seconds.
- Use only macroBlocks whose partNumbers contains ${partNumber}. Do not import another Part's blocks merely to fill duration.
- Apart from the exact shared Hook and a concise evidence-grounded recap in Parts 2-3, do not repeat another Part's footage or opening narration.

${genZRules}

SHARED COLD OPEN:
- Start with the exact complete shared Hook macro-block assigned to [1,2,3]. Every Part must use the same ordered evidenceId/sceneId/sourceStartSec/sourceEndSec sequence.
- The Hook must be pure original_audio and may last 5-30 seconds. Preserve setup/warning -> confrontation/action -> climax -> immediate reaction. Do not cut before the verified payoff merely to shorten it.
- When the Hook crosses a scene boundary, return consecutive Hook segments with storyFunction="hook" and the same macroBlockId, sourceRunId, actionSequenceId, sustainedBeatId, actionOverride=true, and sustainedBeatOverride=true. No voiceover or unrelated footage may appear between Hook slices.
- End immediately before any external source narrator starts. Never extend the Hook into narrator speech merely to reach a duration target.

SERIALIZATION & MYSTERY PRESERVATION - SUPREME STORY RULE:
- Script 1 / Part 1 and Script 3 / Part 2 are forbidden from revealing the final plot twist, decisive hidden evidence, test result, formal arrest, court sentence or ultimate legal consequence.
- Part 1 establishes the premise, bizarre behavior and immediate stakes, then ends on an unresolved confrontation, suspicious lie, request to search or another assigned evidence-grounded open question.
- Part 2 focuses on new middle escalation such as blame, contradiction, argument or refusal, then ends at the boiling-point pre-climax turn.
- Only Script 4 / Part 3 may reveal the ultimate verified truth, decisive hidden evidence, formal arrest and court consequence. Do not repeat the arrest, sentence or final Karma payoff in another Part.
- ANTI-HALLUCINATION VISUAL RULE: "fighting officers", "resisting arrest", "violent struggle" and equivalent physical-action claims require visible fighting, wrestling, physical restraint or handcuffs being applied in that exact evidence. Verbal arguing or crying must remain verbal arguing, blaming, playing the victim or throwing a tantrum when verified. Never upgrade verbal conflict into physical violence.

CRITICAL ANTI-TALKING-HEAD RULE:
- Do not build this Part only from aftermath interviews, roadside explanations, interrogation talking heads, or static conversations.
- If the assigned blocks contain the actual physical event promised by the source title or discussed by witnesses, include the ACTUAL event and immediate reaction even when it has zero dialogue and no SRT text. Dynamic verified action outranks people talking about that action.
- Keep evidence sharing one actionSequenceId together, in source order, as one sustained actionOverride block. Do not replace the action with a verbal summary.

ZERO-TOLERANCE SOURCE NARRATOR FILTER - SUPREME OVERRIDE:
- Every segment must populate source_narrator_detected.
- original_audio requires source_narrator_detected=false, locked sourceNarratorPresent=false, and audible speech belonging only to directly involved officers, suspects, victims, witnesses, interview subjects or dispatchers, or clean ambient/action sound.
- Completely cut or mute every external host, news anchor and documentary narrator. The source narrator must never be audible in the final output.
- This rule overrides Sustained Beat, Complete Narrative Beat, Action Sequence, actionOverride and all pacing rules.
- If the narrator starts during a valuable beat, split at the most precise supported timestamp: keep original_audio only until immediately before the narrator begins, then use voiceover_only or another verified source range.
- If direct character speech and external narration overlap and cannot be separated, use voiceover_only for the complete overlapping range and sacrifice raw audio. Mute the source soundtrack and recreate only verified factual meaning with the user's selected tool voice.
- Populate root source_narrator_ranges with every verified external-narrator interval used or intersected by this Part. Include startSec, endSec, replacementText, and confidence. Split selected segments at those exact boundaries; no original_audio slice may overlap a declared narrator range.

ANTI-HALLUCINATION PROTOCOL:
- Use only facts in this Part's assigned locked evidence. Never use memory, web knowledge, another case, another Gemini chat, or an earlier project.
- Do not invent or recycle a suspect name, charge, plea, sentence, jail term, death, motive, medical result, or court outcome.
- If later legal resolution is absent, end with the last verified immediate consequence such as arrest, custody, rescue, medical response, or the investigation continuing. State that later outcome is not established by the supplied source when necessary.
- A required climax/consequence is a story function, not permission to invent a court result.

VOICE AND CONTINUITY:
- The first voiceover after the shared Hook must be unique to Part ${partNumber} and perform this Part's chapter role.
- Preserve authentic commands, cries, confessions, dispatcher calls, impacts, and reactions as original_audio when no external narrator overlaps them.
- Every voiceover_only claim must be supported by its own evidenceId and fit the calibrated word budget.
- Every segment after the first needs a concrete causal/temporal transitionReason. Preserve complete spoken lines and immediate reactions.
- ONE-SCENE-PER-SEGMENT: sourceStartSec/sourceEndSec stay inside both the locked evidence and exactly one sceneId. Never cross a scene boundary in one segment. Split at boundaries, preserve macroBlockId/sourceRunId/actionSequenceId, divide narration without duplication, and recalculate startSec/endSec continuously from zero.
- endSec-startSec=(sourceEndSec-sourceStartSec)/playbackSpeed. No silence, freeze frames, credits, filler, or repeated footage to reach duration.
- OUTPUT TIMELINE IS DERIVED, NOT EDITORIAL: sourceStartSec/sourceEndSec and playbackSpeed are authoritative. Finalize them first, then recalculate startSec/endSec continuously from zero with at least 3 decimal places. Never keep stale output timestamps after an edit. The local tool will reflow output timestamps and its calculation is authoritative.

${extractVoiceCalibrationBlock(basePrompt)}

${buildSingleJsonCodeBlockContract(`script-${scriptId}.json`, `Root scriptId must equal ${scriptId}, part_number must equal ${partNumber}, and segments must be non-empty.`)}

REQUIRED ROOT SCHEMA:
{
  "artifactType": "highlight_cut_script",
  "schemaVersion": 1,
  "scriptId": ${scriptId},
  "prompt_profile": "${promptProfile}",
  "series_mode": "interleaved_multipart",
  "series_id": "stable-case-series-id",
  "part_number": ${partNumber},
  "part_badge": "PART ${partNumber}",
  "shared_top_banner_text": "One truthful curiosity title shared by all Parts",
  "title": "",
  "language": "en",
  "sourceLanguage": "en",
  "total_target_sec": ${min},
  "target_duration_min_sec": ${min},
  "target_duration_max_sec": ${max},
  "shared_hook_enabled": true,
  "interleaved_audio_enabled": true,
  "voiceover_enabled": true,
  "source_narrator_ranges": [{
    "startSec": 0,
    "endSec": 5,
    "replacementText": "Exact verified narrator meaning",
    "confidence": "high"
  }],
  "story_blueprint": ${JSON.stringify({ ...blueprint, macroBlocks: assignedBlocks }, null, 2)},
  "segments": [{
    "id": "highlight_0001",
    "segmentId": "highlight_0001",
    "evidenceId": "${assignedEvidenceIds[0] || "evidence_0001"}",
    "sceneId": "scene_0001",
    "sourceRunId": "source_run_0001",
    "macroBlockId": "macro_01",
    "storyFunction": "hook|context|escalation|climax|consequence",
    "transitionReason": "",
    "actionCandidateId": "",
    "actionSequenceId": "",
    "actionOverride": false,
    "sourceStartSec": 0,
    "sourceEndSec": 5,
    "startSec": 0,
    "endSec": 5,
    "playbackSpeed": 1,
    "source_narrator_detected": false,
    "audio_mode": "original_audio|voiceover_only",
    "voiceover_text": "",
    "caption": "",
    "preview_vi": "",
    "action_notes": "Concrete source-grounded edit instruction"
  }]
}

LOCKED PART ${partNumber} MACRO-BLOCKS:
${JSON.stringify(assignedBlocks, null, 2)}

LOCKED EVIDENCE IDS ALLOWED IN THIS PART:
${JSON.stringify(assignedEvidenceIds, null, 2)}

SOURCE MANIFEST SUMMARY:
${JSON.stringify({ sourceVideo: manifest?.sourceVideo || "", videoDurationSec: manifest?.videoDurationSec || 0 }, null, 2)}

LOCKED SCENE EVIDENCE:
${JSON.stringify(evidencePayload, null, 2)}`;
}

function buildSingleVariantPrompt({ scriptId, evidencePayload, blueprint, manifest, basePrompt = "" }) {
  if (isSerializedPrompt(basePrompt)) {
    return buildSerializedSinglePartPrompt({ scriptId, evidencePayload, blueprint, manifest, basePrompt });
  }
  const independentOptions = extractIndependentPromptOptions(basePrompt);
  const durationByScript = {
    1: independentOptions.durations.script1,
    2: independentOptions.durations.script2,
    3: independentOptions.durations.script3,
    4: independentOptions.durations.script4,
    5: independentOptions.durations.script5
  };
  const profiles = {
    1: {
      title: "Caught in 4K / Narrated Raw Reality",
      duration: `${durationByScript[1].min}-${durationByScript[1].max} seconds`,
      macroBlocks: "4-6",
      maxJumps: 4,
      voiceRule: "Set audio_strategy=clean_hybrid, voiceover_enabled=true, and source_narrator_policy=forbidden. Script 1 is narrator-led and must contain 2-4 concise, non-adjacent voiceover_only beats: at least one rewind/context or indispensable causal bridge before the promised Climax, plus at least one later escalation, stake-resolution, or verified Payoff beat. A single legal-outcome voiceover at the end is invalid. Never add filler or speak over an indispensable source quote or action sound."
    },
    3: {
      title: "Viral Mini-Doc / Deep Dive",
      duration: `${durationByScript[3].min}-${durationByScript[3].max} seconds`,
      macroBlocks: "5-8",
      maxJumps: 5,
      voiceRule: "Use original audio for unique dialogue and complete exchanges. Use evidence-grounded voiceover bridges only when source audio can be safely muted. Every voiceover_only block must be 12 seconds or shorter."
    },
    4: {
      title: "80/20 Raw Reality / Strategic Bridges",
      duration: `${durationByScript[4].min}-${durationByScript[4].max} seconds`,
      macroBlocks: "5-7",
      maxJumps: 3,
      voiceRule: "Prefer mostly strong original audio when it can carry the causal story. Use short voiceover_only bridges only where Context, chronology, contradiction, stake resolution, jargon clarity, or payoff would otherwise be unclear. The 70-85% original-audio range and 3-4 narration blocks are references, never quotas."
    },
    2: {
      title: "Dialogue-First Confrontation",
      duration: `${durationByScript[2].min}-${durationByScript[2].max} seconds`,
      macroBlocks: "4-7",
      maxJumps: 4,
      voiceRule: "Build around the strongest complete verified exchange. Use concise voiceover_only only to orient a necessary source jump or deliver a verified payoff."
    },
    5: {
      title: "Evidence and Consequence",
      duration: `${durationByScript[5].min}-${durationByScript[5].max} seconds`,
      macroBlocks: "4-7",
      maxJumps: 4,
      voiceRule: "Build around the strongest verified discovery, contradiction, reaction, and consequence. Narration connects evidence but never replaces decisive original proof."
    }
  };
  const profile = profiles[scriptId];
  if (!profile) throw new Error(`Không hỗ trợ Script ${scriptId}.`);
  return `${buildGeminiInputAccessGate({
    stage: `independent_script_${scriptId}`,
    requiredInputs: ["locked shared story blueprint", "locked scene evidence", "scene-manifest summary", "voice calibration block"]
  })}

USER TASK INSTRUCTION - CREATE ONLY SCRIPT ${scriptId}

Create exactly one production JSON timeline for Script ${scriptId}: ${profile.title}. The shared blueprint and evidence are locked. Do not create or discuss any other variant.

PROFILE:
- Final duration: ${profile.duration}; never below 60.5 seconds after playbackSpeed.
- Macro-block reference: approximately ${profile.macroBlocks} when that is the shortest complete causal story; this is not a quota or rejection gate.
- Source-jump reference: approximately ${profile.maxJumps} major non-contiguous jumps or fewer when possible; use as many as the shortest complete causal story genuinely needs.
- ${profile.voiceRule}

${buildIndependentHookFallbackRules(independentOptions)}

${buildIndependentVariantOptionRules(independentOptions)}

STORY RULES:
1. Copy the shared blueprint storySpine into story_blueprint.storySpine and treat it as the highest editorial authority. Follow its centralViewerQuestion -> hookPromise -> rewindContext -> escalationPath -> climax -> primary payoff -> required finalOutcome chain. You may adapt block duration for this profile but may not replace its factual story with unrelated high-score moments.
1AA. Every segment must include narrativePurpose explaining exactly how it advances the central viewer question: hook_teaser, rewind_context, context, escalation, climax_return, aftermath_payoff, or indispensable_bridge. Remove a segment whose only purpose is "interesting footage".
1A. USER-RANKED HOOK: Scan the complete locked evidence and transcript, not merely action scores. Apply the exact Hook priority fallback above and do not silently replace it with a fixed action-first or psychological-first preference. Start at the core qualified beat, use original_audio with empty voiceover_text, and cut exactly before the narrator begins when an external source narrator follows.
1B. SCRIPT NARRATIVE CONTRACT: Copy the shared blueprint narrativeContract into root narrative_contract, then update hookPromise/primaryAudienceQuestion only when this Script selects a materially different Hook. Lock mandatoryResolution to specific evidence IDs that answer this Hook's primary stake. A later suspect arrest, surrender, interview, or legal outcome cannot replace an immediate victim/hazard resolution.
1C. VISUAL PAYOFF OUTRANKS VERBAL CONFIRMATION: When mandatoryResolution.visualFirstRequired=true and preferredVisualEvidenceIds are available, at least one preferred visual evidence item must appear before later_outcome. A casual line such as "we have the victim" cannot replace visible rescue/safety/aftermath proof.
2. Select evidence inside each planned macro-block, preferring consecutive evidenceIds from the same sourceRunId.
3. Preserve complete spoken lines, decisive actions, and immediate reactions. Avoid fragments under 4 seconds unless indispensable.
4. Every segment after the first needs a factual transitionReason. Visual similarity is not a causal transition.
5. Every concrete voiceover claim must be supported by the same evidenceId. Respect burnedTextPresent and safeForVoiceover.
6. EDITORIAL MACRO-BLOCK RANGE: One segment is one continuous source range and may cross consecutive technical scene boundaries when that preserves a complete dialogue, action, reaction, or narration beat. Set sceneId to the scene containing sourceStartSec and list every crossed scene in sceneIds. Never join non-contiguous source ranges inside one segment.
7. Duration formula: endSec-startSec=(sourceEndSec-sourceStartSec)/playbackSpeed.
   OUTPUT TIMELINE IS DERIVED, NOT EDITORIAL: sourceStartSec/sourceEndSec and playbackSpeed are authoritative. Finalize them first, then recalculate all startSec/endSec from zero with at least 3 decimal places. Never preserve stale output timestamps after changing source timestamps or speed. The local tool will reflow the output timeline and its calculation is authoritative.
8. playbackSpeed 0.5-0.75 is allowed only for a verified split-second physical action, never to pad dialogue or silence.
9. End immediately after the verified payoff. No credits, blank screens, repeated footage, or dead audio.
10. Every mustInclude evidence in the shared blueprint must appear. Keep evidence sharing one actionSequenceId together as one sustained action block.
11. ACTION SEQUENCE EXCEPTION: actionOverride=true suspends normal audio alternation limits. Preserve original_audio through the complete high-adrenaline action and immediate reaction; cut only at a natural lull, repetition, or loss of story value.
11A. STAKE RESOLUTION GATE: Every narrative_contract.mandatoryResolution.evidenceId must appear before any segment with timelinePhase="later_outcome". Do not jump to months-later, surrender, court, or sentencing while the Hook's immediate physical/victim question remains open.
11A2. FINAL OUTCOME COMPLETION GATE: When storySpine.finalOutcomeRequired=true or narrative_contract.secondaryPayoff.required=true, every finalOutcome/secondaryPayoff evidenceId must appear after the primary payoff and the last meaningful segment must deliver that verified sentence, legal result, arrest status, or current status. Never end on a suspect excuse, interview answer, or cliffhanger before this required outcome. If no later outcome is verified, keep required=false and do not invent one.
11B. SOFT EDITORIAL REFERENCES: Macro-block count, source-jump count, narrator frequency, and audio ratio describe a typical good result; they are never reasons by themselves to reject a coherent story. Use the shortest complete causal sequence that fulfills storySpine, label necessary bridges, and never omit climax/payoff evidence merely to satisfy a number.
11C. JARGON CLARITY: When locked evidence has containsUnexplainedJargon=true, omit the weak range or provide a concise voiceover_only bridge with bridgePurpose="jargon_clarity" and jargonExplanation. Loud radio jargon is not automatically valuable original audio.
11D. PROCEDURAL DEAD-ZONE BAN: Do not select evidence marked proceduralBloat=true unless it contains an indispensable contradiction, confrontation, or proof unavailable elsewhere. Written statements, paperwork, phone numbers, name spelling, forms, and routine station instructions cannot serve as escalation or stake resolution.
${scriptId === 1
    ? "12. External source narrator is forbidden. Use clean original_audio only for direct participants and ambient action. For a narrator-covered essential visual, use voiceover_only, mute source audio completely, and faithfully recreate verified facts with the selected tool voice; narrator frequency remains story-driven."
    : scriptId === 4
    ? "12. Never allow the source narrator and tool narrator to overlap. Avoid sourceNarratorPresent evidence outside the two planned voiceover bridges. If such evidence is indispensable, use its sourceNarratorText as one of those two bridges, set voiceover_only, and mute source audio completely."
    : "12. Never allow the source narrator and tool narrator to overlap. For indispensable evidence with sourceNarratorPresent=true, set voiceover_only, mute source audio completely, and faithfully recreate sourceNarratorText with the selected tool voice without adding claims."}

${extractVoiceCalibrationBlock(basePrompt)}

DELIVERY CONTRACT:
${buildSingleJsonCodeBlockContract(`script-${scriptId}.json`, `Root scriptId must equal ${scriptId}; the root must contain story_blueprint and a non-empty segments array. Do not return other scripts.`)}

SEGMENT SCHEMA:
{
  "scriptId": ${scriptId},
  "title": "",
  "language": "en",
  "sourceLanguage": "en",
  "total_target_sec": 60.5,
  "independent_prompt_options": ${JSON.stringify(independentOptions, null, 2)},
  "hook_selection_audit": {
    "requestedPriority": ${JSON.stringify(independentOptions.hookPriority)},
    "selectedType": "high_action|dialogue_conflict|psychological_wtf|evidence_reveal",
    "fallbackLevel": 1,
    "selectedEvidenceIds": ["evidence_0001"],
    "reason": "Why the first qualifying category and candidate won",
    "rejectedHigherPriorityCandidates": []
  },
  "audio_strategy": "${scriptId === 1 ? "clean_hybrid" : "hybrid"}",
  "voiceover_enabled": true,
  "narrative_contract": ${JSON.stringify(blueprint.narrativeContract || {}, null, 2)},
  "story_blueprint": ${JSON.stringify(blueprint, null, 2)},
  "segments": [{
    "id": "highlight_0001",
    "evidenceId": "evidence_0001",
    "sceneId": "scene_0001",
    "sourceRunId": "source_run_0001",
    "macroBlockId": "macro_01",
    "storyFunction": "hook",
    "narrativePurpose": "hook_teaser|rewind_context|context|escalation|climax_return|aftermath_payoff|indispensable_bridge",
    "transitionReason": "Opening beat",
    "bridgePurpose": "none|context|causal|stake_resolution|time_jump|jargon_clarity|payoff",
    "timelinePhase": "hook|immediate_event|immediate_resolution|later_outcome",
    "jargonExplanation": "",
    "actionCandidateId": "action_0001",
    "actionSequenceId": "action_0001",
    "actionOverride": true,
    "sourceStartSec": 0,
    "sourceEndSec": 5,
    "startSec": 0,
    "endSec": 5,
    "playbackSpeed": 1,
    "audio_mode": "original_audio",
    "voiceover_text": "",
    "caption": "",
    "preview_vi": "Tóm tắt tiếng Việt để duyệt cảnh",
    "action_notes": "Concrete edit instruction grounded in this evidence"
  }]
}

SOURCE MANIFEST SUMMARY:
${JSON.stringify({ sourceVideo: manifest?.sourceVideo || "", videoDurationSec: manifest?.videoDurationSec || 0 }, null, 2)}

LOCKED SHARED STORY BLUEPRINT:
${JSON.stringify(blueprint, null, 2)}

LOCKED SCENE EVIDENCE:
${JSON.stringify(evidencePayload, null, 2)}`;
}

function buildLockedEvidenceScriptPrompt({ basePrompt, evidencePayload, manifest, workflow = "manual_gemini_pro_two_pass" }) {
  if (workflow === "manual_gemini_story_recut") {
    return `${buildGeminiInputAccessGate({
      stage: "story_recut_script",
      requiredInputs: ["locked scene evidence", "scene-manifest summary", "the complete Story Recut task"]
    })}

USER TASK INSTRUCTION - EXECUTE THIS FILE IMMEDIATELY

The upload of this file is the user's explicit request to perform Story Recut Pass 2. Execute it immediately. Do not summarize the files or ask for another instruction.

IMPORTANT: The evidence below has already been validated by the local tool.

LOCKED-EVIDENCE RULES:
1. Create exactly ONE Story Recut JSON, not Script 1, Script 3, Script 4, or alternate variants.
2. Use only LOCKED_SCENE_EVIDENCE below.
3. Every technical segment must include evidenceId and use the same sceneId and sourceRunId as that evidence item.
4. sourceStartSec/sourceEndSec may be narrower but must stay completely inside the evidence range.
5. Scene boundaries are technical boundaries, not story boundaries. When one complete spoken thought or action spans consecutive evidence in the same sourceRunId, include the FULL consecutive evidence chain, assign every slice the SAME macroBlockId, and do not omit small transition gaps from the middle of that chain. The local tool will consolidate those slices into one sustained Story Recut block.
6. Every claim must be supported by the referenced evidence.
7. startSec/endSec are derived output timestamps and must be contiguous from 0. sourceStartSec/sourceEndSec and playbackSpeed are authoritative. Finalize source edits first, then recalculate the full output timeline with at least 3 decimal places. Never preserve stale output timestamps; the local tool will reflow them and its calculation is authoritative.
8. Preserve complete beats and truthful causal order even when macro-blocks are reordered.
9. This workflow is source-audio-only. Every segment must use audio_mode="original_audio" with voiceover_text="".
10. Preserve the complete soundtrack in every selected range, including source narrator, dialogue, radio, ambience, sound effects, and music.
11. Never create voiceover_only or mixed_ducking segments. Never replace, synthesize, mute, or duck the source narrator.
12. Return the JSON code block requested by the task below.
13. An isolated segment under 5 seconds is invalid unless it is an indispensable complete Hook or reaction. A sub-5-second technical slice is allowed only when it is immediately adjacent to other slices with the same macroBlockId and sourceRunId so their combined source span is at least 8 seconds.
14. A new sceneId MUST NOT create a new macroBlockId. Start a new macro-block only when the story function or source run genuinely changes.

PASS 2 OUTPUT SCHEMA GATE:
- The JSON code block is saved as "story-recut.json".
- Root artifactType must equal "story_recut_script".
- Root mode must equal "story_recut".
- Root segments must be a non-empty array.
- Root evidence must not exist. Do not return scene-evidence.json again.
- Do not wrap the Story Recut object in data, result, output, script, or an outer array.
- Parse the completed file and repair it before returning if any condition above fails.

${buildSingleJsonCodeBlockContract("story-recut.json", 'Root artifactType must equal "story_recut_script", mode must equal "story_recut", and segments must be non-empty.')}

SOURCE MANIFEST SUMMARY:
- Source video: ${manifest?.sourceVideo || ""}
- Source duration: ${Number(manifest?.videoDurationSec || 0).toFixed(3)}s
- Validated evidence count: ${evidencePayload.evidence.length}

LOCKED_SCENE_EVIDENCE:
${JSON.stringify(evidencePayload, null, 2)}

FINAL STORY RECUT TASK:
${String(basePrompt || "")}`;
  }
  return `${buildGeminiInputAccessGate({
    stage: "locked_evidence_scripts",
    requiredInputs: ["locked scene evidence", "scene-manifest summary", "the complete editorial prompt", "voice calibration block"]
  })}

USER TASK INSTRUCTION - EXECUTE THIS FILE IMMEDIATELY

The upload of this file is the user's explicit request to perform Pass 2 below. This file is an executable task instruction, NOT reference material and NOT content to summarize.

Do not infer a different user intent from the absence of a separate chat message. Do not summarize the case, explain the prompt, ask what the user wants, or return conversational prose. Execute the script-generation task immediately.

IMPORTANT: THIS IS PASS 2. The source evidence below has already been validated by the local tool.

LOCKED-EVIDENCE RULES:
1. Write exactly three final scripts, Script 1, Script 3, and Script 4, ONLY from LOCKED_SCENE_EVIDENCE below. Do not generate Script 2.
2. Every output segment MUST include evidenceId and use the same sceneId. It may select a narrower source subrange, but sourceStartSec/sourceEndSec must remain completely inside that evidence item's source range.
3. Never invent, estimate, expand, shift, merge, or recalculate a source range outside its evidence item.
4. If two evidence items are needed in sequence, return two separate segments. Never create one segment spanning them.
5. Every narration claim and action_notes statement must be supported by visualFacts, dialogueEvidence, storyMeaning, or soundCues from its referenced evidenceId.
6. Do not write generic filler. Name the exact person, action, object, spoken line, reaction, or consequence present in the evidence.
7. OUTPUT TIMELINE IS DERIVED, NOT EDITORIAL: startSec/endSec are derived output timestamps. sourceStartSec/sourceEndSec and playbackSpeed are authoritative. Finalize every source edit and speed first, then recalculate them contiguously from 0 using the Duration Formula and at least 3 decimal places. Never preserve stale output timestamps; the local tool will reflow them and its calculation is authoritative.
8. Before returning JSON, cross-check every output segment against LOCKED_SCENE_EVIDENCE. If a source range extends outside its evidence item, clamp it back inside and recalculate the output timeline.
9. Return exactly three standalone valid JSON objects in separate JSON code blocks, in this order: Script 1, Script 3, Script 4.
10. The segment schema shown later is extended with the REQUIRED field "evidenceId". Never omit it.
11. If a sustained original-audio moment crosses scene boundaries, preserve it as consecutive original_audio segments referencing consecutive evidence items. Do not merge their source ranges.
12. SOURCE NARRATOR REPLACEMENT: Every output segment must populate source_narrator_detected as a boolean. Set it true whenever its locked evidence has sourceNarratorPresent=true or the selected source subrange visibly/audibly contains an external host. When true, audio_mode must be "voiceover_only". A false value never overrides sourceNarratorPresent=true in locked evidence, and original_audio is allowed only when both checks are false.
13. A visually valuable evidence item MUST NOT be discarded merely because it contains the source narrator. Keep its video, set audio_mode="voiceover_only", mute the source audio, and put sourceNarratorText into voiceover_text so the tool recreates the same narration using the user's selected voice.
14. You may lightly clean punctuation or remove repeated filler from sourceNarratorText, but preserve every factual claim and never add information.
15. If sourceNarratorPresent=true but sourceNarratorText is empty, write a faithful replacement from dialogueEvidence and storyMeaning. Keep it within the calibrated word budget.
16. Build sustained original-audio blocks only from clean "scene_dialogue" or "ambient_sfx" evidence. The final output must contain only the newly selected TTS narrator, never the source video's narrator.
17. VOICEOVER AUDIO SAFETY: Prefer "voiceover_only" evidence with sourceAudioType "ambient_sfx" or "music", or sceneDialoguePresent=false. If important authentic dialogue, a command, confession, argument, or reaction should be heard, use "original_audio".
18. The renderer always mutes source audio 100% for "voiceover_only". If you intentionally narrate over a visually valuable scene that contains source dialogue, state in action_notes that the source dialogue is intentionally muted.
19. Do not merge evidence ranges in JSON. Consecutive clean "original_audio" evidence may remain separate logical segments; the local renderer will safely coalesce physically contiguous ranges during export while preserving their evidenceIds.
20. FINAL RESPONSE GATE: Return exactly three standalone valid JSON objects for Script 1, Script 3, and Script 4 in separate JSON code blocks as requested below. Do not add an introduction, summary, explanation, or text outside those three JSON blocks. Never return Script 2.
21. INDEPENDENT SCRIPT 1 NARRATED CLEAN-HYBRID GATE: When prompt_profile="independent", Script 1 must set audio_strategy="clean_hybrid", voiceover_enabled=true, and source_narrator_policy="forbidden". It MUST contain multiple non-adjacent voiceover_only beats that construct a true "Audio Sandwich". Do not limit to just 2-4 VOs; narrate to maintain pace. Every voiceover must map to narration_arc through narrationBeatId. Never add filler, mute indispensable authentic proof, or preserve external source narrator.
22. SERIALIZED NARRATOR OVERRIDE: When prompt_profile="serialized_interleaved" or series_mode="interleaved_multipart", scriptId=1 means Part 1, NOT the legacy source-audio-only variant. Rules 12-16 apply to Part 1, Part 2, and Part 3 equally. Never set audio_strategy="source_audio_only" merely because a serialized Part uses scriptId=1. Every selected range with sourceNarratorPresent=true must use voiceover_only and the user's selected tool voice.
23. SCRIPT 4 STORY-FIRST GATE: Script 4 is the dedicated "60/40 Audio Sandwich TikTok Pacing" variant. It must use a qualified in-media-res visual/audio Hook and immediately follow it with visual-stakes evidence when available. Macro-block, source-jump, voiceover-count, and 60/40 figures are descriptive references only; Story Spine and audience comprehension determine the actual edit.
24. SCRIPT 4 SOURCE-ADJACENCY GATE: Prefer consecutive evidenceIds and continuous source runs. At least 70% of original-audio duration should come from no more than two continuous source runs whenever locked evidence permits. Consecutive evidence items from one source run remain separate JSON segments but count as one macro-block.
25. SCRIPT 4 CONTINUITY GATE: Do not select an isolated dramatic fragment merely because it has a high viralScore. Every block must causally answer or advance the previous block. Preserve complete spoken lines and immediate reactions; avoid original-audio fragments under 5 seconds unless indispensable.
26. SCRIPT RATIO & PACING PRIORITY: The 60/40 ratio (60% original audio, 40% narrator voiceover) is the target pacing standard for TikTok virality. Causal continuity, complete dialogue beats, and audience comprehension take priority, but you MUST inject voiceovers frequently to break up long original audio sequences.
27. STORY SPINE GATE - HIGHEST EDITORIAL PRIORITY: Before writing each JSON, populate story_blueprint.storySpine with centralViewerQuestion, hookPromise, rewindContext, escalationPath, climax, climaxEvidenceIds, payoff, and payoffEvidenceIds. Build CLIMAX TEASER -> brief rewind/context -> escalation -> return to the promised climax -> immediate aftermath/payoff. Every segment must declare narrativePurpose and advance that one question. Reject and rebuild any script that does not fulfill the Hook Promise and answer the Central Viewer Question. A collection of dramatic clips is not a story.
28. SEMANTIC HOOK SELECTION GATE: Compare all evidence with hookScore, clarityScore, WTF/absurdity, quoteShock, transcript intelligibility, and payoff. Motion/audio radar scores are discovery hints only. Select the most shocking intelligible soundbite or confrontation, even when it begins mid-exchange; it does not need a complete setup.
29. HOOK CUT GATE: Prefer cutSafety="safe". A semantic quote hook may have completeBeat=false when quoteShock>=8 and hookType is semantic_quote/in_media_res. If an unsafe evidence item is indispensable, select a safer narrower subrange and explain the exact risk in top-level continuity_warning.
30. FRAGMENTATION GATE: Avoid clips under 4 seconds except one indispensable micro-hook/reaction. Prefer sustained 8-30 second source blocks containing setup, action, and reaction.
31. TRANSITION GATE: Every segment after the first must include storyFunction and transitionReason. transitionReason must explain the factual causal or temporal connection to the preceding segment; visual similarity alone is not sufficient.
32. RETENTION GATE: Each 8-15 second window must either introduce a concrete question, reveal new evidence, escalate conflict, preserve an authentic exchange, or deliver a payoff. Remove repetition and generic narration.
33. FINAL SELF-CHECK: Verify hook comprehension, causal continuity, complete dialogue, source jumps, original-audio ratio, narration blocks, climax, and payoff. Repair the JSON before returning it; do not merely describe a problem.
34. CLAIM-TO-EVIDENCE GATE: Every concrete noun, action, weapon, person, location, legal result, and causal claim in voiceover_text must appear in the referenced evidence item's visualFacts, dialogueEvidence, sourceNarratorText, storyMeaning, keywords, or payoff. Never use one evidence item as generic B-roll for a different event.
35. BURNED-TEXT GATE: If burnedTextPresent=true or safeForVoiceover=false, do not write unrelated replacement narration over that footage. Use original_audio, preserve the matching source narration, or choose another evidence item whose visible text agrees with the new voiceover.
36. SOURCE-JUMP GATE: More than three major non-contiguous source jumps is a failed plan for Script 4. Rebuild the macro-block plan before returning JSON. A narration bridge does not make an unrelated visual jump coherent.
37. STORY-BLUEPRINT GATE: Before selecting output segments, create a top-level story_blueprint containing centralCharacter, primaryConflict, audienceQuestion, setup, escalation, climax, consequence, finalPayoff, and macroBlocks. Do not build the story by sorting evidence by viralScore.
37A. NARRATIVE-CONTRACT GATE: Every independent root must contain narrative_contract with hookPromise, primaryAudienceQuestion, primaryStakeType, stakeActorIds, mandatoryResolution and optional secondaryPayoff. Mandatory resolution evidence must appear before any later-time suspect/legal payoff. The suspect's outcome does not answer a victim-safety question.
38. SOURCE-RUN-FIRST GATE: Select sourceRunId ranges and macro-blocks first, then select evidence items inside those runs. Prefer consecutive evidenceIds from the same sourceRunId. An isolated high-viralScore evidence item may be used only when it completes a required story function that no continuous run can provide.
39. MACRO-BLOCK GATE: Every segment must include macroBlockId and sourceRunId. Consecutive segments from the same source run and story function share one macroBlockId. A new JSON segment does not automatically mean a new macro-block.
40. CAUSAL-CHAIN GATE: Every macro-block after the hook must connect to the preceding block through a concrete temporal or causal relation: because, therefore, but, or as a result. If no such relation exists, remove or replace the block.
41. PROFILE GATE: Set scriptId to 1, 3, or 4. HARD MONETIZATION MINIMUM: every final script MUST be at least 60.5 seconds after playbackSpeed. Script 1 targets 60.5-120s with soft budgets of 6 macro-blocks/4 major source jumps. Script 3 targets 90-240s with soft budgets of 8 macro-blocks/5 major source jumps. Script 4 targets 60.5-120s with soft budgets of 5-7 macro-blocks/3 major source jumps. Mandatory victim/hazard resolution outranks these budgets. Use additional relevant continuous source runs or justified slow motion on a key physical action when needed; never use dead-air, filler, credits, repetition, unsupported claims, or fragmented micro-clips.
42. AUDIO SANDWICH PACING: The narrator voiceover must make up roughly 40% of the total video duration. ORIGINAL AUDIO DEAD-AIR LIMIT: Original audio without narrator must NEVER run continuously for more than 15 seconds. If a scene runs long, you MUST inject a short voiceover sentence (voiceover_only) to provide context, react to the suspect, or bridge the gap. Voiceover blocks themselves can be 3 to 15 seconds long.
43. SOURCE-RUN COMPLETENESS: Within a selected source run, preserve the setup, decisive line/action, and immediate reaction. Do not cherry-pick only the loudest sentence from the middle of an exchange.
44. FINAL STORY TEST: Read only story_blueprint and the macro-block summaries. They must form one understandable story without relying on action_notes or hidden source context. If they read like a list of exciting moments, rebuild the plan.
45. MONETIZATION DURATION GATE: Before returning each JSON, calculate the exact output duration after playbackSpeed. If total_target_sec or the final endSec is below 60.5, the JSON is invalid. Rebuild from additional relevant source runs or justified 0.5-0.75 slow motion until it reaches at least 60.5 seconds while preserving continuity.
46. SLOW-MOTION GATE: playbackSpeed between 0.5 and 0.75 is allowed only for a verified split-second physical action such as a weapon draw, sudden reach, impact, takedown, or physical confrontation. Never slow ordinary dialogue, walking, static footage, warning screens, credits, or weak B-roll. action_notes must identify the exact action and reason.
47. ABSURD-DIALOGUE GATE: Preserve bizarre, funny, shocking, confessional, or decisive source quotes as original_audio with empty voiceover_text. Never replace a unique authentic quote with tool narration.
48. END-CLEANUP GATE: End immediately after the verified climax, consequence, brief outcome, or discussion question. Never select blank screens, Patreon/credit screens, unrelated channel outros, or empty audio padding.
49. ESSENTIAL-ACTION GATE: Every locked evidence item with mustInclude=true must appear in every final script. Evidence sharing an actionSequenceId must remain one sustained macro-block in source order.
50. ACTION SEQUENCE EXCEPTION: For actionOverride=true, visual action outranks transcript density and normal audio-sandwich limits. Preserve original_audio through the complete action and immediate reaction. There is no fixed maximum duration; cut only at a natural lull, repetition, or loss of story value. Never interrupt a chase, escape, vehicle theft, struggle, crash, or takedown with tool voiceover.
51. SHARED TOP BANNER GATE: All three JSON objects MUST use the exact same shared_top_banner_text. Write one concise 6-14 word English headline for the complete source story, grounded in verified evidence, specific enough to describe the real incident, curiosity-driven without revealing the final payoff, and free of unsupported clickbait. Per-variant title may differ for file naming, but it never controls the rendered top banner.
52. ACTOR IDENTITY GATE: Copy the validated LOCKED_SCENE_EVIDENCE.actorIdentityMap into each root actor_identity_map. Every segment must copy actor_ids, primary_actor_id, and speaker_actor_id from its evidence. Never attach one actor's action, arrest, relationship, or consequence to another actor.
53. HOOK TRANSITION GATE: Populate hook_transition_test after evaluating the complete Hook plus the first 15 output seconds that follow it. If the Hook resets to an earlier time or the next block introduces different actorIds, bridgeText must explicitly identify the verified people/relationship and explain the chronology. Generic narration fails this gate. Prefer a linear Hook when the reset would create identity confusion.
54. ORIGINAL AUDIO VALUE GATE: Copy originalAudioValueScore/Reason/Protected from locked evidence into every segment. If originalAudioProtected=true and sourceNarratorPresent=false, audio_mode must be original_audio and voiceover_text must be empty. Put narration before or after the protected range; never replace the authentic quote, command, reaction, impact, radio call, or confrontation.
55. VIRAL PACING & JCS EDITORIAL GATE:
   - HOOK: Select the opening beat strictly from the 5 Viral Hook Archetypes:
     1) The Physical Friction & Barricade Suspense: Active struggle against a locked barrier, violent door rattling, window pounding, or physical standoff before entry (creates massive curiosity gap; never open with casual door opening or routine approach).
     2) The Absurd Contradiction: Defiant denial or bizarre claim directly contradicted by obvious physical reality.
     3) In Medias Res: Drop directly into peak physical struggle, shouted commands, or sudden escalation with zero lead-in.
     4) Instant Karma / The Fatal Mistake: Arrogant provocation immediately meeting an instant counter-attack or takedown.
     5) Unbelievable Stakes: An outrageous or bizarre trigger revealing the absurd premise of the altercation.
     STRICT CASUAL vs FRICTION RULE: Casual walking, routine vehicle approach, polite greetings, or opening an ordinary door is BANNED filler. But violent door rattling, barricade pounding, or forced-entry attempts are Tier-S hooks.
     SPOILER BAN ON HOOKS: Never open with the empty aftermath or already-handcuffed suspect if it spoils the central mystery. Hook the tension/question, not the final answer.
   - VOICEOVER: Limit sentences to <= 25 words. Use fast-paced, high-energy present tense. Adopt a conversational, sensational TikTok true-crime tone (e.g., "Watch what happens when..."). Ruthlessly contrast suspect lies with camera facts to trigger outrage. Ban academic language.
   - PACING: Enter late, exit early. Eliminate dead-air/silence > 1.5s between dialogue exchanges.
   - OUTRO: End video within 2-3s of the final verified payoff/aftermath. Zero lingering paperwork or idle outro footage.

${buildThreeJsonCodeBlockContract()}

REQUIRED EVIDENCE-LINKED SOURCE FIELDS IN EVERY OUTPUT SEGMENT:
{
  "evidenceId": "evidence_0001",
  "sceneId": "scene_0001",
  "sourceRunId": "source_run_0001",
  "macroBlockId": "macro_01",
  "sourceStartSec": 0.0,
  "sourceEndSec": 5.0,
  "storyFunction": "hook | context | escalation | reveal | climax | consequence | outro",
  "transitionReason": "Concrete causal or temporal link from the previous segment",
  "actionCandidateId": "action_0001",
  "actionSequenceId": "action_0001",
  "actionOverride": true,
  "source_narrator_detected": false,
  "actor_ids": ["actor_001"],
  "primary_actor_id": "actor_001",
  "speaker_actor_id": "actor_001",
  "original_audio_value_score": 9.0,
  "original_audio_value_reason": "Exact authentic source value",
  "original_audio_protected": true
}

SOURCE MANIFEST SUMMARY:
- Source video: ${manifest?.sourceVideo || ""}
- Source duration: ${Number(manifest?.videoDurationSec || 0).toFixed(3)}s
- Validated evidence count: ${evidencePayload.evidence.length}

LOCKED_SCENE_EVIDENCE:
${JSON.stringify(evidencePayload, null, 2)}

---

${String(basePrompt || "")}`;
}

function buildActionCandidatePromptBlock(actionCandidates = {}, { directScripts = false, editorialMacroBlocks = false } = {}) {
  const candidates = Array.isArray(actionCandidates?.candidates) ? actionCandidates.candidates : [];
  if (!candidates.length) return "LOCAL ACTION RADAR: unavailable. Perform a full visual action inventory manually.";
  const rules = directScripts
    ? `DIRECT-SCRIPT ACTION COVERAGE GATE:
- Inspect every candidate with mustReview=true in the proxy. Local scores are radar, not semantic truth.
- VISUAL ACTION OVERRIDE: Identify major physical events such as escape, vehicle theft, pursuit, struggle, crash, weapon draw, forced entry, takedown, panic, or an immediate physical reaction. These events outrank transcript density and ordinary dialogue.
- Every event that is central to the case or materially raises retention MUST appear in every script whose story covers that event.
- Add actionCandidateId and actionSequenceId to every linked segment. Use actionOverride=true for an unbroken high-adrenaline sequence.
- ACTION SEQUENCE EXCEPTION: Do not interrupt an unbroken important action merely to satisfy audio alternation. Keep original_audio through the complete action and immediate reaction. There is no fixed maximum; cut only at a natural lull, repetition, or loss of story value.`
    : `PASS-1 VISUAL ACTION INVENTORY GATE:
- Inspect every candidate with mustReview=true in the proxy. Local motion/audio scores are radar, not proof of narrative importance.
- Return one actionCandidateDecisions entry for EVERY mustReview candidate with verdict "essential", "supporting", or "not_relevant" and a concrete visual reason.
- Do not downgrade a candidate because dialogueEvidence is empty. Visual adrenaline and meaningful physical action may outrank spoken dialogue.
- If a candidate contains escape, vehicle theft, pursuit, struggle, crash, weapon draw, forced entry, takedown, panic, or another story-changing physical event, extract scene-bounded evidence for the complete action and immediate reaction.
- Link extracted evidence with actionCandidateId and one shared actionSequenceId. Set narrativeEssential=true and mustInclude=true when removing that event would break the causal story or remove a major viral payoff.
- An essential action may span multiple sceneIds. Return separate evidence slices inside each scene while preserving one actionSequenceId.
- ACTION SEQUENCE EXCEPTION: Preserve the complete original-audio action sequence. Do not split it merely to manufacture an 8-12 second audio sandwich; cut only at a natural lull, repetition, or loss of story value.`;
  const promptCandidates = editorialMacroBlocks
    ? candidates.map((candidate) => ({
      actionCandidateId: candidate.actionCandidateId,
      sourceStartSec: candidate.sourceStartSec,
      sourceEndSec: candidate.sourceEndSec,
      mustReview: candidate.mustReview === true,
      reviewReason: candidate.reviewReason || candidate.reason || ""
    }))
    : actionCandidates;
  return `${rules}

LOCAL ACTION CANDIDATES:
${JSON.stringify(editorialMacroBlocks ? { candidates: promptCandidates } : promptCandidates, null, 2)}`;
}

function buildPass1JsonFilePrompt(prompt = "", actionCandidates = {}, proxyChunksManifest = null) {
  const contract = buildSingleJsonCodeBlockContract(
    "scene-evidence.json",
    'The root must be one object with artifactType="scene_evidence" and a non-empty evidence array. No outer wrapper and no top-level segments.'
  );
  const accessGate = buildGeminiInputAccessGate({
    stage: "scene_evidence",
    requiredInputs: ["this complete prompt", "scene-manifest.json", "all supplied proxy/proxy-chunk videos", "source-transcript.srt when supplied", "action-candidates.json"]
  });
  return `${accessGate}\n\n${contract}\n\n${buildProxyInputGuide(proxyChunksManifest)}\n\n${buildActionCandidatePromptBlock(actionCandidates)}\n\n${String(prompt || "").trim()}\n\n${contract}`;
}

function buildDirectHighlightScriptsPrompt(prompt = "", manifest = {}, actionCandidates = {}, proxyChunksManifest = null) {
  const basePrompt = String(prompt || "").trim();
  const independentPrompt = basePrompt.includes("DURABLE EDITORIAL QUALITY CORE - INDEPENDENT SCRIPTS ONLY");
  const independentOptions = extractIndependentPromptOptions(basePrompt);
  const requestedScriptIds = getRequestedIndependentScriptIds(independentOptions);
  const timelineContract = independentPrompt
    ? `STORY SPINE COMPILER INPUT CONTRACT - INDEPENDENT SCRIPTS ONLY:
- Gemini chooses Story Contract, Narrative Beats, source ranges, audioMode, and globally connected narration. The local tool is the only technical timeline compiler.
- Return narrativeBeats, not renderer segments. Do not calculate startSec/endSec/outputStartSec/outputEndSec, scene spans, macro-block IDs, or output duration math.
- One Narrative Beat is one complete editorial idea and continuous source range. It may cross consecutive scene-manifest boundaries.
- Never split natural narration, sustained dialogue, or continuous action merely because scene detection created a boundary.
- Never combine non-contiguous source ranges inside one beat. Use a new beat with causalLinkFromPrevious for a genuine editorial jump.
- playbackSpeed defaults to 1. Set another value only for a justified split-second action.`
    : `ONE-SCENE-PER-SEGMENT TIMESTAMP GATE - HIGHEST PRIORITY:
- Every segment belongs to exactly one sceneId and must satisfy scene.startSec <= sourceStartSec < sourceEndSec <= scene.endSec.
- Never let one JSON segment cross a scene boundary. If one logical beat spans consecutive scenes, return one segment per scene, preserve source order, and keep the same macroBlockId/sourceRunId/actionSequenceId when applicable.
- Divide voiceover into non-duplicated complete phrases that fit the individual scene segments. Never copy the same voiceover_text into every split segment.
- After every split, recalculate startSec/endSec continuously from zero. Before responding, validate every segment against scene-manifest.json; any cross-scene segment makes the JSON invalid.`;
  const accessGate = basePrompt.includes("STEP 0 - VERIFIED INPUT ACCESS GATE")
    ? ""
    : buildGeminiInputAccessGate({
      stage: independentPrompt ? "direct_story_spine_scripts" : "direct_highlight_scripts",
      requiredInputs: ["this complete editorial prompt", "scene-manifest.json", "all supplied proxy/proxy-chunk videos", "source-transcript.srt when supplied", "action-candidates.json"]
    });
  const contract = `${accessGate}

${buildThreeJsonCodeBlockContract(independentPrompt ? requestedScriptIds : [1, 3, 4])}

DIRECT HIGHLIGHT CONTENT RULES:
- Watch the complete video input described by the VIDEO INPUT CONTRACT below and cross-check scene-manifest.json plus source-transcript.srt when present.
- Each code block root must be one complete ${independentPrompt ? "story_spine_edit_script with a non-empty narrativeBeats array" : "Highlight Cut script object with a non-empty segments array"}.
- For every independent story_spine_edit_script, run a final role audit against the actual narrativeBeats array: hook, context, escalation, climax, and payoff must all be present as distinct beats. Never emit a second payoff as a substitute for missing context.
- sourceStartSec/sourceEndSec refer only to the original source video. ${independentPrompt ? "The local tool derives the output timeline." : "startSec/endSec are the separate contiguous output timeline beginning at zero."}
- Do not create scene-evidence.json or story-blueprint.json. Reason internally, then write the final edit scripts directly from the video.
- For independent scripts, complete the Semantic Hook Tournament and Viral Moment Inventory required by the editorial prompt before choosing Narrative Beats. Local action-candidate order is never a Hook ranking.
- VIRAL EDITORIAL RULES (JCS / EWU STYLE):
  * HOOK: Must hit within the first second with one of 5 Archetypes: Physical Friction & Barricade Suspense, Absurd Contradiction, In Medias Res, Instant Karma, or Unbelievable Stakes. Distinguish routine approach/casual door opening (BANNED) from violent door rattling/barricade pounding/standoff (TIER-S HOOK). SPOILER BAN: Hook the tension/friction, never spoil the aftermath/resolution at second 0.
  * VOICEOVER: Sentence limit <= 25 words. Fast-paced, high-energy present tense. Sensational TikTok true-crime tone. Ruthlessly contrast suspect lies with camera facts to trigger outrage. Ban academic language.
  * PACING: Enter late, exit early. Eliminate dead-air/silence > 1.5s between dialogue exchanges.
  * OUTRO: End video within 2-3s of the final verified payoff/aftermath. Zero lingering paperwork or idle outro footage.

${timelineContract}

AUTHORITATIVE SOURCE SUMMARY:
- Source video: ${manifest.sourceVideo || ""}
- Source duration: ${Number(manifest.videoDurationSec || 0).toFixed(3)} seconds
- Scene count: ${Array.isArray(manifest.scenes) ? manifest.scenes.length : 0}

${buildProxyInputGuide(proxyChunksManifest)}

${buildActionCandidatePromptBlock(actionCandidates, { directScripts: true, editorialMacroBlocks: independentPrompt })}`;
  if (independentPrompt) {
    const deduplicatedPrompt = basePrompt
      .replace(
        /(?:THREE|REQUESTED) JSON CODE-BLOCK CONTRACT - HIGHEST PRIORITY[\s\S]*?Do not output prose, headings, filename labels, explanations, tables, or text before, between, or after the (?:three|requested) code blocks\.\s*/gi,
        ""
      )
      .trim();
    return `${contract}\n\n${deduplicatedPrompt}`;
  }
  
  const deduplicatedBasePrompt = basePrompt
    .replace(
      /(?:THREE|REQUESTED) JSON CODE-BLOCK CONTRACT - HIGHEST PRIORITY[\s\S]*?Do not output prose, headings, filename labels, explanations, tables, or text before, between, or after the (?:three|requested) code blocks\.\s*/gi,
      ""
    )
    .trim();
    
  return `${contract}\n\n${deduplicatedBasePrompt}`;
}

function slugify(input) {
  return String(input || "video")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "video";
}

function formatTimestamp(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const wholeSeconds = Math.floor(safe % 60);
  const milliseconds = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function formatAssTimestamp(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const wholeSeconds = Math.floor(safe % 60);
  const centiseconds = Math.min(99, Math.round((safe - Math.floor(safe)) * 100));
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function escapeAssText(value) {
  return String(value || "")
    .replace(/[{}]/g, "")
    .replace(/\r?\n/g, " ");
}

function buildSceneReferenceAss(scenes) {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 640",
    "PlayResY: 360",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: SceneRef,Arial,18,&H00FFFFFF,&H00FFFFFF,&H00101820,&HC0101820,-1,0,0,0,100,100,0,0,3,1,0,8,16,16,14,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
  ];
  const events = scenes.map((scene) => {
    const label = `${scene.sceneId}  |  SOURCE ${formatTimestamp(scene.startSec)} - ${formatTimestamp(scene.endSec)}`;
    return `Dialogue: 0,${formatAssTimestamp(scene.startSec)},${formatAssTimestamp(scene.endSec)},SceneRef,,0,0,0,,${escapeAssText(label)}`;
  });
  return [...header, ...events, ""].join("\n");
}

function normalizeManifest({ media, sourceVideoPath, scenes, detector }) {
  return {
    schemaVersion: 1,
    timelineType: "source_timeline",
    sourceVideo: path.basename(sourceVideoPath),
    videoDurationSec: Number((media.duration || 0).toFixed(3)),
    width: Number(media.width || 0),
    height: Number(media.height || 0),
    hasAudio: Boolean(media.hasAudio),
    sceneDetector: detector || "unknown",
    instructions: {
      timestamps: "All scene startSec/endSec values refer to the original source video.",
      selection: "Gemini must select an existing sceneId and keep source timestamps inside that scene range.",
      outputTimeline: "The returned JSON must separately provide contiguous output startSec/endSec values beginning at 0."
    },
    scenes: scenes.map((scene, index) => ({
      sceneId: scene.sceneId || `scene_${String(index + 1).padStart(4, "0")}`,
      startSec: Number(Number(scene.startSec || 0).toFixed(3)),
      endSec: Number(Number(scene.endSec || 0).toFixed(3)),
      durationSec: Number(Math.max(0, Number(scene.endSec || 0) - Number(scene.startSec || 0)).toFixed(3))
    }))
  };
}

function buildPackageReadme({
  transcriptFile,
  warningCount,
  workflow = "manual_gemini_pro_two_pass",
  proxyChunksManifest = null,
  uploadBatchDirs = [],
  prompt = ""
}) {
  const isStoryRecut = workflow === "manual_gemini_story_recut";
  const isDraftReview = workflow === "manual_gemini_draft_review";
  const isDiyStoryRemix = workflow === "manual_gemini_diy_story_remix";
  const chunkCount = Array.isArray(proxyChunksManifest?.chunks) ? proxyChunksManifest.chunks.length : 0;
  const usesUploadBatches = chunkCount > 0 && uploadBatchDirs.length > 1;
  const requestedScriptIds = getRequestedIndependentScriptIds(extractIndependentPromptOptions(prompt));
  const requestedFiles = requestedScriptIds.map((scriptId) => `script-${scriptId}.json`);
  const uploadInstruction = usesUploadBatches
    ? `Upload lần lượt ${uploadBatchDirs.length} thư mục UPLOAD-BATCH vào CÙNG MỘT chat Gemini; chỉ yêu cầu xác nhận ở các batch đầu và gửi batch có hậu tố FINAL sau cùng.`
    : chunkCount > 0
      ? `Upload toàn bộ file trong 01-GUI-GEMINI, gồm đủ ${chunkCount} video proxy ngắn và proxy-chunks-manifest.json, vào cùng một chat Gemini.`
      : "Upload toàn bộ file trong 01-GUI-GEMINI vào một chat Gemini Pro mới.";
  if (isDiyStoryRemix) {
    return [
      "GÓI DIY STORY REMIX - BA LỚP KHÓA HÌNH VÀ VOICE",
      "",
      "GIAI ĐOẠN 1 - VISUAL PROCESS MAP",
      `1. ${uploadInstruction}`,
      "2. Gemini phải xem toàn bộ video, trả đúng một JSON diy_visual_process_map và không viết voice ở bước này.",
      "3. Nhập JSON vào tool để kiểm tra sceneId, timestamp, trạng thái trước/sau và dependency vật lý.",
      "",
      "GIAI ĐOẠN 2 - STORY BLUEPRINT",
      "4. Upload file trong 03-DIY-STORY-BLUEPRINT, tải JSON diy_story_blueprint và nhập vào tool.",
      "5. Blueprint chỉ được flash-forward ở Hook; phần thân phải giữ đúng dependency của quá trình DIY.",
      "",
      "GIAI ĐOẠN 3 - VOICE-LOCKED SCRIPT",
      "6. Mở 04-DIY-VOICE-SCRIPT và gửi prompt cho Gemini.",
      "7. Tải JSON cuối thành diy-story-remix.json, chọn trong tool rồi render draft.",
      "8. Tool dùng voice đã chọn, đo thời lượng audio thật và cảnh báo mọi đoạn không đạt coverage.",
      "",
      "Lưu ý:",
      "- sourceStartSec/sourceEndSec luôn là timeline video gốc; startSec/endSec là timeline output.",
      "- Không đảo ngược các bước có dependency vật lý.",
      "- Chỉ dùng original_audio cho âm thao tác DIY khi đoạn nguồn không có lời nói.",
      warningCount ? `- Có ${warningCount} cảnh báo kỹ thuật trong package-info.json.` : "- Gói được tạo không có cảnh báo kỹ thuật."
    ].join("\n");
  }
  if (isDraftReview) {
    return [
      "GÓI GEMINI DRAFT REVIEW - QUY TRÌNH HAI LƯỢT",
      "",
      "LƯỢT 1 - TẠO KỊCH BẢN HIGHLIGHT TRỰC TIẾP",
      `1. ${uploadInstruction}`,
      transcriptFile
        ? `2. Gói đã có ${transcriptFile} để đối chiếu lời thoại và timestamp.`
        : "2. Gói chưa có transcript; Gemini phải dựa vào audio trong proxy và không được bịa lời thoại.",
      `3. Gemini phải trả đúng ${requestedScriptIds.length} code block JSON độc lập theo thứ tự Script ${requestedScriptIds.join(", Script ")}; lưu thành ${requestedFiles.join(", ")}.`,
      `4. Chọn từ 1 đến ${requestedScriptIds.length} JSON hợp lệ trong tool để tạo project và render draft.`,
      "5. Gemini phải xem mọi mục mustReview trong action-candidates.json; đây là radar chuyển động/âm thanh, không phải kết luận ngữ nghĩa cuối cùng.",
      "",
      "LƯỢT 2 - REVIEW VIDEO DRAFT THẬT",
      "6. Trong màn Studio, chọn variant cần sửa và bấm Tạo gói review Gemini sau khi render draft.",
      "7. Upload toàn bộ file trong thư mục 02-DRAFT-REVIEW được tạo vào một chat Gemini Pro mới.",
      "8. Tải code block JSON duy nhất thành gemini-draft-review.json rồi bấm Import JSON thay thế trong tool.",
      "9. Render draft V2 và so sánh với V1 trước khi xuất.",
      "",
      "Lưu ý:",
      "- Không có bước scene evidence hoặc story blueprint bắt buộc trong luồng này.",
      "- Tool chịu trách nhiệm kiểm tra timestamp, output timeline và voice timing thật.",
      "- Gemini chịu trách nhiệm đánh giá câu chuyện, Hook và độ khớp ngữ nghĩa trên video draft.",
      warningCount ? `- Có ${warningCount} cảnh báo kỹ thuật trong package-info.json.` : "- Gói được tạo không có cảnh báo kỹ thuật."
    ].join("\n");
  }
  if (!isStoryRecut) {
    return [
      "GÓI PHÂN TÍCH GEMINI PRO - QUALITY GATE NHIỀU GIAI ĐOẠN",
      "",
      "GIAI ĐOẠN 1 - SCENE EVIDENCE",
      `1. ${uploadInstruction}`,
      transcriptFile
        ? `2. Gói đã có ${transcriptFile} để đối chiếu lời thoại và timestamp.`
        : "2. Gói chưa có transcript; độ chính xác lời thoại sẽ phụ thuộc audio trong proxy.",
      "3. Xem toàn bộ mục mustReview trong action-candidates.json; visual action có thể quan trọng dù transcript trống.",
      "4. Tải code block JSON duy nhất thành scene-evidence.json rồi bấm Nhập scene evidence trong tool.",
      "",
      "GIAI ĐOẠN 2 - EVIDENCE QUALITY GATE (CÓ ĐIỀU KIỆN)",
      "5. Nếu evidence fail, tool tạo thư mục 02-EVIDENCE-REPAIR. Gửi prompt sửa trong cùng chat Gemini rồi nhập lại scene-evidence.json.",
      "6. Nếu evidence đạt, tool tự bỏ qua bước sửa và tạo prompt blueprint.",
      "",
      "GIAI ĐOẠN 3 - STORY BLUEPRINT",
      "7. Upload file trong 03-GUI-GEMINI-BLUEPRINT, tải code block JSON duy nhất thành story-blueprint.json và nhập lại vào tool.",
      "",
      "GIAI ĐOẠN 4 - TỪNG VARIANT RIÊNG",
      "8. Tool tạo ba thư mục 04A-SCRIPT-1, 04B-SCRIPT-3 và 04C-SCRIPT-4.",
      "9. Gửi từng prompt riêng cho Gemini; mỗi prompt trả một code block JSON để tải thành script-1.json, script-3.json hoặc script-4.json.",
      "10. Chọn cả ba JSON trong tool. Variant nào không đạt preflight mới cần dùng prompt repair.",
      "",
      "Lưu ý:",
      "- Không yêu cầu Gemini tạo ba variant trong cùng một câu trả lời.",
      "- sourceStartSec/sourceEndSec luôn thuộc timeline nguồn; startSec/endSec thuộc timeline output.",
      "- Evidence và blueprint phải qua quality gate trước khi tạo variant.",
      warningCount ? `- Có ${warningCount} cảnh báo kỹ thuật trong package-info.json.` : "- Gói được tạo không có cảnh báo kỹ thuật."
    ].join("\n");
  }
  return [
    isStoryRecut ? "GÓI PHÂN TÍCH STORY RECUT" : "GÓI PHÂN TÍCH GEMINI PRO THỦ CÔNG",
    "",
    "GIAI ĐOẠN 1 - KHÓA BẰNG CHỨNG",
    `1. ${uploadInstruction}`,
    transcriptFile
      ? `2. Thư mục này đã có ${transcriptFile} để Gemini đối chiếu lời thoại và timestamp.`
      : "2. Gói chưa có transcript. Gemini vẫn có thể dùng audio trong proxy, nhưng độ chính xác lời thoại có thể thấp hơn.",
    "3. Gemini phải trả đúng một code block JSON. Tải block này thành scene-evidence.json rồi nhập vào tool.",
    "4. Trong tool, bấm \"Nhập scene evidence\". Tool sẽ kiểm tra sceneId/timestamp và tạo prompt Story Recut.",
    "",
    "GIAI ĐOẠN 2 - VIẾT KỊCH BẢN",
    "5. Mở thư mục 02-GUI-GEMINI và upload toàn bộ file trong đó cho Gemini. Prompt đã chứa scene evidence được tool xác nhận.",
    isStoryRecut
      ? "6. Tải code block JSON duy nhất thành story-recut.json rồi chọn file này trong tool."
      : "6. Gemini phải trả ba code block JSON độc lập theo thứ tự Script 1, Script 3, Script 4; tải thành ba file riêng rồi chọn cả ba file trong tool.",
    "",
    "Lưu ý:",
    "- Nhãn scene_XXXX và khoảng SOURCE trên proxy chỉ dùng để phân tích, không xuất hiện trong video cuối.",
    "- sourceStartSec/sourceEndSec luôn là timeline video gốc.",
    "- Mỗi khoảng nguồn phải nằm trọn trong sceneId đã chọn. Nếu đi qua ranh giới scene, phải tách thành nhiều segment.",
    "- Nếu sourceStartSec bằng endSec của một scene, timestamp đó thuộc scene kế tiếp chứ không thuộc scene vừa kết thúc.",
    "- startSec/endSec luôn là timeline video output và phải nối tiếp từ 0.",
    "- Không dùng JSON kịch bản do Gemini viết trước khi scene evidence vượt qua kiểm tra của tool.",
    warningCount ? `- Có ${warningCount} cảnh báo trong package-info.json.` : "- Gói được tạo không có cảnh báo."
  ].join("\n");
}

class ManualGeminiPackService {
  constructor(settings = {}) {
    this.settings = settings;
  }

  async create({
    sourceVideoPath,
    subtitleSourcePath = "",
    destinationRoot,
    prompt,
    workflow = "manual_gemini_pro_two_pass",
    sourceLanguage = "auto",
    autoWhisper = true,
    forceRebuild = false,
    onProgress
  }) {
    if (!sourceVideoPath) {
      throw new Error("Hãy chọn video nguồn trước khi tạo gói Gemini.");
    }
    const resolvedDestinationRoot = destinationRoot || this.settings.geminiAnalysisRoot;
    if (!resolvedDestinationRoot) {
      throw new Error("Hãy cấu hình thư mục gói phân tích Gemini trong Cài đặt.");
    }

    const ffmpeg = new FfmpegService(this.settings);
    const sceneDetection = new SceneDetectionService(this.settings);
    const subtitleService = new SubtitleService(this.settings);
    const actionCandidateService = new ActionCandidateService(this.settings);
    const packageSuffix = workflow === "manual_gemini_story_recut"
      ? "gemini-story-recut-pack"
      : workflow === "manual_gemini_diy_story_remix"
      ? "gemini-diy-story-remix-pack"
      : "gemini-analysis-pack";
    const packageDir = path.join(resolvedDestinationRoot, `${slugify(path.parse(sourceVideoPath).name)}-${packageSuffix}`);
    const tempDir = path.join(packageDir, "temp");
    const pass1UploadDir = path.join(packageDir, "01-GUI-GEMINI");
    const pass2UploadDir = path.join(packageDir, "02-GUI-GEMINI");
    const evidenceRepairDir = path.join(packageDir, "02-EVIDENCE-REPAIR");
    const blueprintDir = path.join(packageDir, "03-GUI-GEMINI-BLUEPRINT");
    const diyRepairDir = path.join(packageDir, "02-DIY-PROCESS-REPAIR");
    const diyBlueprintDir = path.join(packageDir, "03-DIY-STORY-BLUEPRINT");
    const variantRootDir = path.join(packageDir, "04-GUI-GEMINI-VARIANTS");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(pass1UploadDir, { recursive: true, force: true });
    await fs.rm(pass2UploadDir, { recursive: true, force: true });
    await fs.rm(evidenceRepairDir, { recursive: true, force: true });
    await fs.rm(blueprintDir, { recursive: true, force: true });
    await fs.rm(diyRepairDir, { recursive: true, force: true });
    await fs.rm(diyBlueprintDir, { recursive: true, force: true });
    await fs.rm(variantRootDir, { recursive: true, force: true });
    await Promise.all([
      "analysis-proxy.mp4",
      "scene-manifest.json",
      "action-candidates.json",
      "source-transcript.srt",
      "gemini-prompt.txt",
      "01-gemini-scene-evidence-prompt.txt",
      "02-gemini-script-prompt.txt",
      "scene-evidence.json",
      "story-blueprint.json",
      "HUONG-DAN.txt",
      "package-info.json"
    ].map((fileName) => fs.rm(path.join(packageDir, fileName), { force: true })));
    await Promise.all([
      fs.mkdir(tempDir, { recursive: true }),
      fs.mkdir(pass1UploadDir, { recursive: true }),
      fs.mkdir(pass2UploadDir, { recursive: true })
    ]);

    const sourceFingerprint = await buildSourceFingerprint(sourceVideoPath);
    const cacheKeys = buildAnalysisCacheKeys({
      sourceFingerprint: sourceFingerprint.key,
      settings: this.settings,
      sourceLanguage
    });
    const cacheRoot = path.join(
      this.settings.workspaceRoot || resolvedDestinationRoot,
      ".cineviral",
      "cache",
      "gemini-analysis"
    );
    const cacheDir = path.join(cacheRoot, sourceFingerprint.key);
    await fs.mkdir(cacheDir, { recursive: true });
    const cacheHits = [];
    const cacheMisses = [];
    const cacheCreated = [];
    const cacheEnabled = !forceRebuild;
    const reportCache = (layer, hit, percent) => {
      (hit ? cacheHits : cacheMisses).push(layer);
      onProgress?.({
        step: "gemini_pack",
        percent,
        message: hit ? `[CACHE] Dùng lại ${layer}.` : `[CACHE] Chưa có ${layer}; đang tạo mới.`
      });
    };

    const warnings = [];
    const mediaCachePath = path.join(cacheDir, "media.json");
    let media = cacheEnabled ? await readJsonIfAvailable(mediaCachePath) : null;
    if (media?.duration) {
      reportCache("metadata video", true, 8);
    } else {
      reportCache("metadata video", false, 8);
      media = await ffmpeg.probeVideo(sourceVideoPath);
      await writeJsonAtomic(mediaCachePath, media);
      cacheCreated.push("metadata video");
    }
    if (!media.duration) {
      throw new Error("Không đọc được thời lượng video nguồn.");
    }

    const detectionProxyWidth = Number(this.settings.sceneDetectionProxyWidth || 480);
    const detectionProxyFps = Number(this.settings.sceneDetectionProxyFps || 8);
    const detectionProxyCachePath = path.join(
      cacheDir,
      `scene-detection-proxy-${cacheKeys.detectionProxyKey}.mp4`
    );
    let detectionProxyValid = false;
    if (cacheEnabled && await nonEmptyFileExists(detectionProxyCachePath)) {
      const detectionProxyMeta = await ffmpeg.probeVideo(detectionProxyCachePath).catch(() => null);
      detectionProxyValid = Boolean(detectionProxyMeta?.duration);
      if (!detectionProxyValid) {
        await fs.rm(detectionProxyCachePath, { force: true }).catch(() => {});
      }
    }
    if (detectionProxyValid) {
      reportCache("proxy dò cảnh", true, 14);
    } else {
      reportCache("proxy dò cảnh", false, 14);
      onProgress?.({ step: "gemini_pack", percent: 16, message: "Đang tạo proxy nhẹ để dò cảnh" });
      const detectionProxyTempPath = path.join(tempDir, "scene-detection-proxy.mp4");
      try {
        await ffmpeg.createSceneDetectionProxy({
          videoPath: sourceVideoPath,
          outputPath: detectionProxyTempPath,
          width: detectionProxyWidth,
          fps: detectionProxyFps
        });
        await copyFileAtomic(detectionProxyTempPath, detectionProxyCachePath);
        detectionProxyValid = true;
        cacheCreated.push("proxy dò cảnh");
      } catch (error) {
        warnings.push(`Không tạo được proxy dò cảnh nhẹ; sẽ thử video gốc: ${error.message}`);
      } finally {
        await fs.rm(detectionProxyTempPath, { force: true }).catch(() => {});
      }
    }

    const manifestCachePath = path.join(cacheDir, `scene-manifest-${cacheKeys.sceneKey}.json`);
    let manifest = cacheEnabled ? await readJsonIfAvailable(manifestCachePath) : null;
    if (manifest?.scenes?.length && manifest.videoDurationSec === Number(media.duration.toFixed(3))) {
      reportCache("scene manifest", true, 20);
    } else {
      reportCache("scene manifest", false, 20);
      onProgress?.({ step: "gemini_pack", percent: 22, message: "Đang phát hiện ranh giới các cảnh" });
      let detected;
      try {
        detected = await sceneDetection.detectScenes({
          videoPath: detectionProxyValid ? detectionProxyCachePath : sourceVideoPath,
          sourceDuration: media.duration
        });
        if (detected.error) warnings.push(detected.error);
      } catch (error) {
        warnings.push(`Không chạy được bộ phát hiện cảnh: ${error.message}`);
        detected = {
          provider: "fixed_window_fallback",
          scenes: SceneDetectionService.buildFixedWindowScenes(
            media.duration,
            Number(this.settings.sceneDetectionMaxSceneDurationSec || 45)
          )
        };
      }
      manifest = normalizeManifest({
        media,
        sourceVideoPath,
        scenes: detected.scenes,
        detector: detected.provider
      });
      await writeJsonAtomic(manifestCachePath, manifest);
      cacheCreated.push("scene manifest");
    }
    const manifestPath = path.join(pass1UploadDir, "scene-manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const actionCandidatesPath = path.join(pass1UploadDir, "action-candidates.json");
    const actionCandidatesCachePath = path.join(cacheDir, `action-candidates-${cacheKeys.actionKey}.json`);
    let actionCandidates = cacheEnabled ? await readJsonIfAvailable(actionCandidatesCachePath) : null;
    if (Array.isArray(actionCandidates?.candidates) && actionCandidates.candidates.length) {
      reportCache("ứng viên hành động", true, 28);
    } else {
      reportCache("ứng viên hành động", false, 28);
      try {
        actionCandidates = await actionCandidateService.analyze({
          sourceVideoPath,
          analysisVideoPath: detectionProxyValid ? detectionProxyCachePath : sourceVideoPath,
          manifest,
          onProgress
        });
        await writeJsonAtomic(actionCandidatesCachePath, actionCandidates);
        cacheCreated.push("ứng viên hành động");
      } catch (error) {
        warnings.push(`Không tạo được ứng viên hành động tự động: ${error.message}`);
        actionCandidates = {
          artifactType: "action_candidates",
          schemaVersion: 1,
          sourceVideo: manifest.sourceVideo,
          videoDurationSec: manifest.videoDurationSec,
          generatedBy: "unavailable",
          candidates: []
        };
      }
    }
    await writeJsonAtomic(actionCandidatesPath, actionCandidates);

    const proxyChunkPlan = buildProxyChunkPlan(manifest);
    const usesChunkedProxy = proxyChunkPlan.length > 0;
    const rootProxyPath = path.join(pass1UploadDir, "analysis-proxy.mp4");
    cacheKeys.proxyKey = buildProxyCacheKey(cacheKeys.sceneKey, manifest);
    const proxyCachePath = path.join(cacheDir, `analysis-proxy-${cacheKeys.proxyKey}.mp4`);
    let proxyCacheValid = false;
    if (cacheEnabled && await nonEmptyFileExists(proxyCachePath)) {
      const cachedProxyMeta = await ffmpeg.probeVideo(proxyCachePath).catch(() => null);
      proxyCacheValid = Boolean(cachedProxyMeta?.duration);
      if (!proxyCacheValid) {
        await fs.rm(proxyCachePath, { force: true }).catch(() => {});
      }
    }
    if (proxyCacheValid) {
      reportCache("video proxy", true, 38);
      if (!usesChunkedProxy) await fs.copyFile(proxyCachePath, rootProxyPath);
    } else {
      reportCache("video proxy", false, 38);
      onProgress?.({ step: "gemini_pack", percent: 40, message: "Đang tạo nhãn sceneId và timestamp nguồn" });
      const assPath = path.join(tempDir, "scene-reference.ass");
      const proxyBuildPath = usesChunkedProxy
        ? path.join(tempDir, "analysis-proxy-full.mp4")
        : rootProxyPath;
      await fs.writeFile(assPath, buildSceneReferenceAss(manifest.scenes), "utf8");
      await ffmpeg.burnSubtitlesFast({
        videoPath: sourceVideoPath,
        subtitlePath: assPath,
        outputPath: proxyBuildPath,
        width: 720,
        fps: 12,
        videoBitrate: "650k",
        audioBitrate: "64k"
      });
      await copyFileAtomic(proxyBuildPath, proxyCachePath);
      cacheCreated.push("video proxy");
    }

    let proxyChunksManifest = null;
    let proxyChunkLayout = { batched: false, uploadBatchDirs: [], finalBatchDir: pass1UploadDir };
    if (usesChunkedProxy) {
      const chunkPlanKey = hashValue({
        schema: 1,
        proxyKey: cacheKeys.proxyKey,
        chunks: proxyChunkPlan.map((chunk) => [chunk.sourceStartSec, chunk.sourceEndSec])
      });
      const chunkCacheDir = path.join(cacheDir, `analysis-proxy-chunks-${chunkPlanKey}`);
      await fs.mkdir(chunkCacheDir, { recursive: true });
      onProgress?.({
        step: "gemini_pack",
        percent: 52,
        message: `Đang chuẩn bị ${proxyChunkPlan.length} proxy ngắn cho Gemini`
      });
      for (const [chunkIndex, chunk] of proxyChunkPlan.entries()) {
        const cachedChunkPath = path.join(chunkCacheDir, chunk.file);
        if (!cacheEnabled || !(await nonEmptyFileExists(cachedChunkPath))) {
          const tempChunkPath = path.join(tempDir, chunk.file);
          await ffmpeg.createAnalysisProxyChunk({
            videoPath: proxyCachePath,
            outputPath: tempChunkPath,
            startSec: chunk.sourceStartSec,
            durationSec: chunk.durationSec
          });
          await copyFileAtomic(tempChunkPath, cachedChunkPath);
          await fs.rm(tempChunkPath, { force: true }).catch(() => {});
        }
        onProgress?.({
          step: "gemini_pack",
          percent: Math.min(64, 52 + Math.round(((chunkIndex + 1) / proxyChunkPlan.length) * 12)),
          message: `Đã chuẩn bị proxy ngắn ${chunkIndex + 1}/${proxyChunkPlan.length}`
        });
      }
      proxyChunkLayout = await deployProxyChunkUploads({
        pass1UploadDir,
        chunks: proxyChunkPlan,
        chunkCacheDir
      });
      proxyChunksManifest = {
        artifactType: "analysis_proxy_chunks",
        schemaVersion: 1,
        sourceVideo: manifest.sourceVideo,
        sourceDurationSec: Number(media.duration.toFixed(3)),
        normalPlaybackSpeed: true,
        timestampRule: "Burned SOURCE timestamps are absolute original-video timestamps. Local chunk player time is not a source timestamp.",
        chunkTargetSec: PROXY_CHUNK_TARGET_SEC,
        chunkMaxSec: PROXY_CHUNK_MAX_SEC,
        uploadBatched: proxyChunkLayout.batched,
        uploadBatchCount: proxyChunkLayout.uploadBatchDirs.length,
        chunks: proxyChunkPlan
      };
      await writeJsonAtomic(path.join(pass1UploadDir, "proxy-chunks-manifest.json"), proxyChunksManifest);
      await fs.rm(rootProxyPath, { force: true }).catch(() => {});
    }
    const proxyPath = usesChunkedProxy ? proxyCachePath : rootProxyPath;

    let transcriptPath = "";
    let transcriptProvider = "none";
    if (subtitleSourcePath) {
      transcriptPath = path.join(pass1UploadDir, "source-transcript.srt");
      await fs.copyFile(subtitleSourcePath, transcriptPath);
      transcriptProvider = "srt_file";
      onProgress?.({ step: "gemini_pack", percent: 67, message: "[CACHE] Dùng file SRT do user cung cấp." });
    } else if (autoWhisper && media.hasAudio) {
      const transcriptCachePath = path.join(cacheDir, `source-transcript-${cacheKeys.transcriptKey}.srt`);
      const transcriptMetaPath = path.join(cacheDir, `source-transcript-${cacheKeys.transcriptKey}.json`);
      if (cacheEnabled && await nonEmptyFileExists(transcriptCachePath)) {
        reportCache("transcript Whisper", true, 67);
        transcriptPath = path.join(pass1UploadDir, "source-transcript.srt");
        await fs.copyFile(transcriptCachePath, transcriptPath);
        const transcriptMeta = await readJsonIfAvailable(transcriptMetaPath);
        transcriptProvider = transcriptMeta?.provider || "whisper_cli_cache";
      } else {
        reportCache("transcript Whisper", false, 67);
        onProgress?.({ step: "gemini_pack", percent: 69, message: "Đang nhận diện lời thoại cho gói phân tích" });
        try {
          const audioPath = path.join(tempDir, "source-audio.wav");
          await ffmpeg.run(ffmpeg.ffmpegPath, [
            "-y", "-i", sourceVideoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath
          ], { captureStdout: false });
          const transcript = await subtitleService.transcribeToSrt({
            audioPath,
            outputDir: tempDir,
            narrationLanguage: sourceLanguage,
            cacheDir: path.join(cacheDir, `transcript-chunks-${cacheKeys.transcriptKey}`),
            audioDurationSec: media.duration
          });
          transcriptPath = path.join(pass1UploadDir, "source-transcript.srt");
          await fs.copyFile(transcript.subtitlePath, transcriptPath);
          await copyFileAtomic(transcript.subtitlePath, transcriptCachePath);
          transcriptProvider = transcript.provider;
          await writeJsonAtomic(transcriptMetaPath, {
            provider: transcript.provider,
            generatedAt: new Date().toISOString(),
            whisperModel: this.settings.whisperModel || "auto",
            profile: transcript.profile || {},
            details: transcript.details || {},
            sourceLanguage
          });
          cacheCreated.push("transcript Whisper");
        } catch (error) {
          warnings.push(`Không tạo được transcript tự động: ${error.message}`);
        }
      }
    }

    onProgress?.({ step: "gemini_pack", percent: 86, message: "Đang đóng gói prompt và hướng dẫn" });
    const isDraftReview = workflow === "manual_gemini_draft_review";
    const isDiyStoryRemix = workflow === "manual_gemini_diy_story_remix";
    const evidencePromptPath = path.join(
      pass1UploadDir,
      isDiyStoryRemix
        ? "01-gemini-diy-process-map-prompt.txt"
        : isDraftReview
        ? "01-gemini-highlight-scripts-prompt.txt"
        : "01-gemini-scene-evidence-prompt.txt"
    );
    const promptPath = evidencePromptPath;
    const readmePath = path.join(packageDir, "HUONG-DAN.txt");
    const infoPath = path.join(packageDir, "package-info.json");

    let hookAuditionResult = null;
    let hookContract = null;
    if (isDraftReview) {
      try {
        onProgress?.({ step: "gemini_pack", percent: 88, message: "Đang dò tìm và chấm điểm các ứng viên Hook..." });
        let cues = [];
        if (transcriptPath && (await nonEmptyFileExists(transcriptPath))) {
          const srtRaw = await fs.readFile(transcriptPath, "utf8");
          cues = parseSrtCues(srtRaw);
        }
        const hookAuditionService = new HookAuditionService(this.settings);
        hookAuditionResult = await hookAuditionService.audition({
          transcriptCues: cues,
          actionCandidates: actionCandidates?.candidates || [],
          manifest,
          durationSec: media.duration,
          topCount: 5
        });
        if (hookAuditionResult?.defaultRecommendedHook) {
          hookContract = buildHookContract({ candidate: hookAuditionResult.defaultRecommendedHook, isUserLocked: false });
          await writeJsonAtomic(path.join(pass1UploadDir, "hook-candidates.json"), hookAuditionResult);
          await writeJsonAtomic(path.join(pass1UploadDir, "hook-contract.json"), hookContract);
        }
      } catch (hookErr) {
        warnings.push(`Không tạo được Hook Candidates: ${hookErr.message}`);
      }
    }

    let directHighlightPrompt = buildDirectHighlightScriptsPrompt(prompt, manifest, actionCandidates, proxyChunksManifest);
    if (hookContract) {
      directHighlightPrompt = injectHookContractToPrompt(directHighlightPrompt, hookContract);
    }

    await fs.writeFile(
      evidencePromptPath,
      isDiyStoryRemix
        ? buildDiyProcessMapPrompt({
          basePrompt: prompt,
          manifest,
          actionCandidates,
          proxyInputGuide: buildProxyInputGuide(proxyChunksManifest)
        })
        : isDraftReview
        ? directHighlightPrompt
        : buildPass1JsonFilePrompt(prompt, actionCandidates, proxyChunksManifest),
      "utf8"
    );
    if (proxyChunkLayout.batched) {
      const finalBatchFiles = [
        evidencePromptPath,
        manifestPath,
        actionCandidatesPath,
        path.join(pass1UploadDir, "proxy-chunks-manifest.json"),
        transcriptPath
      ].filter(Boolean);
      for (const filePath of finalBatchFiles) {
        if (await nonEmptyFileExists(filePath)) {
          await copyFileAtomic(filePath, path.join(proxyChunkLayout.finalBatchDir, path.basename(filePath)));
        }
      }
      await fs.writeFile(
        path.join(pass1UploadDir, "00-UPLOAD-ORDER.txt"),
        [
          "Upload the numbered UPLOAD-BATCH folders to ONE Gemini chat in order.",
          "For every non-final batch, upload all files and ask Gemini only to acknowledge receipt.",
          "Upload UPLOAD-BATCH-XX-FINAL last. Its prompt requests the final JSON output.",
          "Do not start a new chat between batches."
        ].join("\n"),
        "utf8"
      );
    }
    await fs.writeFile(readmePath, buildPackageReadme({
      transcriptFile: transcriptPath ? path.basename(transcriptPath) : "",
      warningCount: warnings.length,
      workflow,
      proxyChunksManifest,
      uploadBatchDirs: proxyChunkLayout.uploadBatchDirs,
      prompt
    }), "utf8");
    await fs.writeFile(infoPath, JSON.stringify({
      schemaVersion: 1,
      workflow,
      workflowStage: isDraftReview ? "variant_scripts_pending" : isDiyStoryRemix ? "diy_process_map_pending" : "evidence_pending",
      generatedAt: new Date().toISOString(),
      sourceVideoPath,
      packageDir,
      pass1UploadDir,
      pass2UploadDir,
      evidenceRepairDir,
      blueprintDir,
      variantRootDir,
      proxyPath,
      manifestPath,
      actionCandidatesPath,
      actionCandidateCount: actionCandidates.candidates.length,
      hookCandidatesPath: hookAuditionResult ? path.join(pass1UploadDir, "hook-candidates.json") : "",
      hookContractPath: hookContract ? path.join(pass1UploadDir, "hook-contract.json") : "",
      proxyChunksManifestPath: proxyChunksManifest ? path.join(pass1UploadDir, "proxy-chunks-manifest.json") : "",
      proxyChunkCount: proxyChunksManifest?.chunks?.length || 0,
      proxyUploadBatchDirs: proxyChunkLayout.uploadBatchDirs,
      promptPath,
      evidencePromptPath,
      transcriptPath,
      transcriptProvider,
      sceneCount: manifest.scenes.length,
      cache: {
        enabled: cacheEnabled,
        forceRebuild: Boolean(forceRebuild),
        sourceFingerprint: sourceFingerprint.key,
        cacheDir,
        hits: cacheHits,
        misses: cacheMisses,
        created: cacheCreated
      },
      warnings
    }, null, 2), "utf8");

    onProgress?.({ step: "gemini_pack", percent: 100, message: "Gói phân tích Gemini Pro đã sẵn sàng" });
    return {
      packageDir,
      pass1UploadDir,
      pass2UploadDir,
      proxyPath,
      manifestPath,
      actionCandidatesPath,
      actionCandidateCount: actionCandidates.candidates.length,
      hookCandidatesPath: hookAuditionResult ? path.join(pass1UploadDir, "hook-candidates.json") : "",
      hookContractPath: hookContract ? path.join(pass1UploadDir, "hook-contract.json") : "",
      hookAuditionResult,
      hookContract,
      proxyChunksManifestPath: proxyChunksManifest ? path.join(pass1UploadDir, "proxy-chunks-manifest.json") : "",
      proxyChunkCount: proxyChunksManifest?.chunks?.length || 0,
      proxyUploadBatchDirs: proxyChunkLayout.uploadBatchDirs,
      promptPath,
      evidencePromptPath,
      transcriptPath,
      sceneCount: manifest.scenes.length,
      cache: {
        enabled: cacheEnabled,
        forceRebuild: Boolean(forceRebuild),
        sourceFingerprint: sourceFingerprint.key,
        cacheDir,
        hits: cacheHits,
        misses: cacheMisses
      },
      warnings
    };
  }

  async importEvidence({
    packageDir,
    evidencePath,
    scriptPrompt,
    workflow = ""
  }) {
    if (!packageDir) {
      throw new Error("Chưa có gói phân tích Gemini.");
    }
    if (!evidencePath) {
      throw new Error("Hãy chọn file scene-evidence.json do Gemini tạo.");
    }

    const pass1UploadDir = path.join(packageDir, "01-GUI-GEMINI");
    const pass2UploadDir = path.join(packageDir, "02-GUI-GEMINI");
    const evidenceRepairDir = path.join(packageDir, "02-EVIDENCE-REPAIR");
    const blueprintDir = path.join(packageDir, "03-GUI-GEMINI-BLUEPRINT");
    const diyRepairDir = path.join(packageDir, "02-DIY-PROCESS-REPAIR");
    const diyBlueprintDir = path.join(packageDir, "03-DIY-STORY-BLUEPRINT");
    const nestedManifestPath = path.join(pass1UploadDir, "scene-manifest.json");
    const legacyManifestPath = path.join(packageDir, "scene-manifest.json");
    const manifestPath = await nonEmptyFileExists(nestedManifestPath)
      ? nestedManifestPath
      : legacyManifestPath;
    const infoPath = path.join(packageDir, "package-info.json");
    const packageInfo = await readJsonIfAvailable(infoPath) || {};
    const resolvedWorkflow = workflow || packageInfo.workflow || "manual_gemini_pro_two_pass";
    const manifest = await readJsonIfAvailable(manifestPath);
    const actionCandidatesPath = path.join(pass1UploadDir, "action-candidates.json");
    const actionCandidates = await readJsonIfAvailable(actionCandidatesPath) || { candidates: [] };
    if (!manifest?.scenes?.length) {
      throw new Error("Gói phân tích thiếu scene-manifest.json hợp lệ.");
    }

    let rawEvidence;
    try {
      rawEvidence = parseGeminiJsonObject(
        await fs.readFile(evidencePath, "utf8"),
        path.basename(evidencePath)
      );
    } catch (error) {
      throw new Error(`Không đọc được scene evidence JSON: ${error.message}`);
    }

    const isDiyStoryRemix = resolvedWorkflow === "manual_gemini_diy_story_remix";
    const validated = isDiyStoryRemix
      ? validateDiyProcessMap(rawEvidence, manifest, path.basename(evidencePath))
      : validateSceneEvidence(rawEvidence, manifest, path.basename(evidencePath), actionCandidates);
    const qualityGate = isDiyStoryRemix
      ? evaluateDiyProcessMapQuality(validated, manifest)
      : evaluateEvidenceQuality(validated, manifest, actionCandidates);
    const validatedEvidencePath = path.join(packageDir, isDiyStoryRemix ? "diy-process-map.json" : "scene-evidence.json");
    const isStoryRecut = resolvedWorkflow === "manual_gemini_story_recut";
    let scriptPromptPath = "";
    let nextStageDir = "";

    if (!isStoryRecut) {
      await fs.rm(path.join(packageDir, "story-blueprint.json"), { force: true });
      await fs.rm(path.join(packageDir, "diy-story-blueprint.json"), { force: true });
      await fs.rm(path.join(packageDir, "04-GUI-GEMINI-VARIANTS"), { recursive: true, force: true });
      await fs.rm(path.join(packageDir, "04-DIY-VOICE-SCRIPT"), { recursive: true, force: true });
    }

    if (isDiyStoryRemix && !qualityGate.passed) {
      await fs.rm(validatedEvidencePath, { force: true });
      await fs.rm(diyRepairDir, { recursive: true, force: true });
      await fs.mkdir(diyRepairDir, { recursive: true });
      await writeJsonAtomic(path.join(diyRepairDir, "diy-process-map-candidate.json"), validated);
      scriptPromptPath = path.join(diyRepairDir, "02-diy-process-map-repair-prompt.txt");
      await fs.writeFile(scriptPromptPath, `${buildDiyProcessMapPrompt({
        basePrompt: scriptPrompt,
        manifest,
        actionCandidates,
        proxyInputGuide: "Use the source proxy files already uploaded earlier in this same Gemini chat."
      })}\n\nREPAIR THE PREVIOUS CANDIDATE. QUALITY FAILURES:\n${qualityGate.failures.join("\n")}\n\nCANDIDATE:\n${JSON.stringify(validated, null, 2)}`, "utf8");
      nextStageDir = diyRepairDir;
    } else if (isDiyStoryRemix) {
      await fs.rm(diyBlueprintDir, { recursive: true, force: true });
      await fs.mkdir(diyBlueprintDir, { recursive: true });
      await writeJsonAtomic(validatedEvidencePath, validated);
      await writeJsonAtomic(path.join(packageDir, "scene-evidence.json"), validated);
      await writeJsonAtomic(path.join(diyBlueprintDir, "diy-process-map.json"), validated);
      scriptPromptPath = path.join(diyBlueprintDir, "03-diy-story-blueprint-prompt.txt");
      await fs.writeFile(scriptPromptPath, buildDiyBlueprintPrompt({
        processMap: validated,
        manifest,
        basePrompt: scriptPrompt
      }), "utf8");
      nextStageDir = diyBlueprintDir;
    } else if (!isStoryRecut && !qualityGate.passed) {
      await fs.rm(validatedEvidencePath, { force: true });
      await fs.rm(evidenceRepairDir, { recursive: true, force: true });
      await fs.mkdir(evidenceRepairDir, { recursive: true });
      const candidatePath = path.join(evidenceRepairDir, "scene-evidence-candidate.json");
      const repairPromptPath = path.join(evidenceRepairDir, "02-evidence-repair-prompt.txt");
      await writeJsonAtomic(candidatePath, validated);
      await fs.writeFile(repairPromptPath, buildEvidenceRepairPrompt({
        candidate: validated,
        qualityGate,
        manifest,
        actionCandidates
      }), "utf8");
      await fs.copyFile(manifestPath, path.join(evidenceRepairDir, "scene-manifest.json"));
      if (await nonEmptyFileExists(actionCandidatesPath)) {
        await fs.copyFile(actionCandidatesPath, path.join(evidenceRepairDir, "action-candidates.json"));
      }
      const transcriptSource = path.join(pass1UploadDir, "source-transcript.srt");
      if (await nonEmptyFileExists(transcriptSource)) {
        await fs.copyFile(transcriptSource, path.join(evidenceRepairDir, "source-transcript.srt"));
      }
      scriptPromptPath = repairPromptPath;
      nextStageDir = evidenceRepairDir;
    } else if (isStoryRecut) {
      await fs.mkdir(pass2UploadDir, { recursive: true });
      scriptPromptPath = path.join(pass2UploadDir, "02-gemini-script-prompt.txt");
      await writeJsonAtomic(validatedEvidencePath, validated);
      await fs.writeFile(scriptPromptPath, buildLockedEvidenceScriptPrompt({
        basePrompt: scriptPrompt,
        evidencePayload: validated,
        manifest,
        workflow: resolvedWorkflow
      }), "utf8");
      nextStageDir = pass2UploadDir;
      if (await nonEmptyFileExists(actionCandidatesPath)) {
        await fs.copyFile(actionCandidatesPath, path.join(pass2UploadDir, "action-candidates.json"));
      }
    } else {
      await fs.rm(blueprintDir, { recursive: true, force: true });
      await fs.mkdir(blueprintDir, { recursive: true });
      scriptPromptPath = path.join(blueprintDir, "03-story-blueprint-prompt.txt");
      await writeJsonAtomic(validatedEvidencePath, validated);
      await writeJsonAtomic(path.join(blueprintDir, "scene-evidence.json"), validated);
      if (await nonEmptyFileExists(actionCandidatesPath)) {
        await fs.copyFile(actionCandidatesPath, path.join(blueprintDir, "action-candidates.json"));
      }
      await fs.writeFile(scriptPromptPath, buildStoryBlueprintPrompt({
        evidencePayload: validated,
        manifest,
        basePrompt: scriptPrompt
      }), "utf8");
      nextStageDir = blueprintDir;
    }

    await writeJsonAtomic(infoPath, {
      ...packageInfo,
      workflow: resolvedWorkflow,
      workflowStage: isDiyStoryRemix && !qualityGate.passed
        ? "diy_process_repair_required"
        : isDiyStoryRemix
        ? "diy_blueprint_pending"
        : !isStoryRecut && !qualityGate.passed
        ? "evidence_repair_required"
        : isStoryRecut
        ? "script_ready"
        : "blueprint_pending",
      pass1UploadDir,
      pass2UploadDir,
      evidencePath: validatedEvidencePath,
      scriptPromptPath,
      evidenceCount: validated.evidence.length,
      evidenceWarnings: validated.warnings,
      evidenceQualityGate: qualityGate,
      evidenceImportedAt: new Date().toISOString()
    });

    return {
      packageDir,
      pass2UploadDir: nextStageDir,
      nextStageDir,
      evidencePath: qualityGate.passed || isStoryRecut ? validatedEvidencePath : "",
      scriptPromptPath,
      evidenceCount: validated.evidence.length,
      warnings: validated.warnings,
      qualityGate,
      nextStage: isDiyStoryRemix && !qualityGate.passed
        ? "diy_process_repair"
        : isDiyStoryRemix
        ? "diy_story_blueprint"
        : !isStoryRecut && !qualityGate.passed
        ? "evidence_repair"
        : isStoryRecut
        ? "variant_scripts"
        : "story_blueprint"
    };
  }

  async importBlueprint({ packageDir, blueprintPath, scriptPrompt = "" }) {
    if (!packageDir) throw new Error("Chưa có gói phân tích Gemini.");
    if (!blueprintPath) throw new Error("Hãy chọn file story-blueprint.json do Gemini tạo.");
    const infoPath = path.join(packageDir, "package-info.json");
    const packageInfo = await readJsonIfAvailable(infoPath) || {};
    if (packageInfo.workflow === "manual_gemini_story_recut") {
      throw new Error("Story Recut không sử dụng bước story blueprint riêng.");
    }
    const manifestPath = await nonEmptyFileExists(path.join(packageDir, "01-GUI-GEMINI", "scene-manifest.json"))
      ? path.join(packageDir, "01-GUI-GEMINI", "scene-manifest.json")
      : path.join(packageDir, "scene-manifest.json");
    const manifest = await readJsonIfAvailable(manifestPath);
    const isDiyStoryRemix = packageInfo.workflow === "manual_gemini_diy_story_remix";
    const evidencePath = path.join(packageDir, isDiyStoryRemix ? "diy-process-map.json" : "scene-evidence.json");
    const evidencePayload = await readJsonIfAvailable(evidencePath);
    if (!manifest?.scenes?.length || !evidencePayload?.evidence?.length) {
      throw new Error("Chưa có scene evidence đã qua quality gate. Hãy hoàn tất giai đoạn evidence trước.");
    }
    let rawBlueprint;
    try {
      rawBlueprint = parseGeminiJsonObject(
        await fs.readFile(blueprintPath, "utf8"),
        path.basename(blueprintPath)
      );
    } catch (error) {
      throw new Error(`Không đọc được story blueprint JSON: ${error.message}`);
    }
    const blueprint = isDiyStoryRemix
      ? validateDiyBlueprint(rawBlueprint, evidencePayload, path.basename(blueprintPath))
      : validateStoryBlueprint(rawBlueprint, evidencePayload, path.basename(blueprintPath));
    if (isDiyStoryRemix) {
      const storedBlueprintPath = path.join(packageDir, "diy-story-blueprint.json");
      const variantRootDir = path.join(packageDir, "04-DIY-VOICE-SCRIPT");
      const promptPath = path.join(variantRootDir, "04-diy-voice-locked-script-prompt.txt");
      await writeJsonAtomic(storedBlueprintPath, blueprint);
      await fs.rm(variantRootDir, { recursive: true, force: true });
      await fs.mkdir(variantRootDir, { recursive: true });
      await writeJsonAtomic(path.join(variantRootDir, "diy-process-map.json"), evidencePayload);
      await writeJsonAtomic(path.join(variantRootDir, "diy-story-blueprint.json"), blueprint);
      await fs.writeFile(promptPath, buildDiyVoiceScriptPrompt({
        blueprint,
        processMap: evidencePayload,
        manifest,
        basePrompt: scriptPrompt
      }), "utf8");
      const variantDirs = [{ scriptId: 0, variantDir: variantRootDir, promptPath }];
      await writeJsonAtomic(infoPath, {
        ...packageInfo,
        workflowStage: "diy_voice_script_pending",
        blueprintPath: storedBlueprintPath,
        blueprintImportedAt: new Date().toISOString(),
        variantRootDir,
        variantDirs
      });
      return {
        packageDir,
        blueprintPath: storedBlueprintPath,
        variantRootDir,
        variantDirs,
        macroBlockCount: blueprint.blocks.length,
        nextStage: "diy_voice_script"
      };
    }
    if (isSerializedPrompt(scriptPrompt)) {
      const missingAssignments = blueprint.macroBlocks.filter((block) => !block.partNumbers?.length);
      const sharedHooks = blueprint.macroBlocks.filter((block) => (
        /hook/.test(block.storyFunction) && [1, 2, 3].every((part) => block.partNumbers.includes(part))
      ));
      const missingPartChapters = [1, 2, 3].filter((part) => !blueprint.macroBlocks.some((block) => (
        block.partNumbers.includes(part) && !/hook/.test(block.storyFunction)
      )));
      const duplicatedNonHookBlocks = blueprint.macroBlocks.filter((block) => (
        !/hook/.test(block.storyFunction) && block.partNumbers.length > 1
      ));
      const assignmentErrors = [];
      if (missingAssignments.length) assignmentErrors.push(`${missingAssignments.length} macro-block chưa có partNumbers.`);
      if (!sharedHooks.length) assignmentErrors.push("Thiếu Hook chung có partNumbers=[1,2,3].");
      if (missingPartChapters.length) assignmentErrors.push(`Part ${missingPartChapters.join(", ")} chưa có chapter riêng ngoài Hook.`);
      if (duplicatedNonHookBlocks.length) {
        assignmentErrors.push(`${duplicatedNonHookBlocks.length} macro-block ngoài Hook đang bị lặp sang nhiều Part.`);
      }
      if (assignmentErrors.length) {
        throw new Error(
          `${path.basename(blueprintPath)}: phân bổ Series Part 1-3 chưa hợp lệ. ${assignmentErrors.join(" | ")}`
        );
      }
    }
    const storedBlueprintPath = path.join(packageDir, "story-blueprint.json");
    await writeJsonAtomic(storedBlueprintPath, blueprint);

    const variantRootDir = path.join(packageDir, "04-GUI-GEMINI-VARIANTS");
    await fs.rm(variantRootDir, { recursive: true, force: true });
    await fs.mkdir(variantRootDir, { recursive: true });
    const variantDirs = [];
    const independentOptions = extractIndependentPromptOptions(scriptPrompt);
    const requestedScriptIds = isSerializedPrompt(scriptPrompt)
      ? [1, 3, 4]
      : getRequestedIndependentScriptIds(independentOptions);
    for (const [index, scriptId] of requestedScriptIds.entries()) {
      const label = String.fromCharCode(65 + index);
      const variantDir = path.join(variantRootDir, `04${label}-SCRIPT-${scriptId}`);
      const promptPath = path.join(variantDir, `04${label}-script-${scriptId}-prompt.txt`);
      await fs.mkdir(variantDir, { recursive: true });
      await fs.writeFile(promptPath, buildSingleVariantPrompt({
        scriptId,
        evidencePayload,
        blueprint,
        manifest,
        basePrompt: scriptPrompt
      }), "utf8");
      await writeJsonAtomic(path.join(variantDir, "story-blueprint.json"), blueprint);
      variantDirs.push({ scriptId, variantDir, promptPath });
    }
    await writeJsonAtomic(infoPath, {
      ...packageInfo,
      workflowStage: "variants_pending",
      blueprintPath: storedBlueprintPath,
      blueprintImportedAt: new Date().toISOString(),
      variantRootDir,
      variantDirs
    });
    return {
      packageDir,
      blueprintPath: storedBlueprintPath,
      variantRootDir,
      variantDirs,
      macroBlockCount: blueprint.macroBlocks.length,
      nextStage: "variant_scripts"
    };
  }

  async getHookCandidates(packageDir) {
    if (!packageDir) throw new Error("Chưa có đường dẫn gói phân tích.");
    const pass1UploadDir = path.join(packageDir, "01-GUI-GEMINI");
    const infoPath = path.join(packageDir, "package-info.json");
    const info = (await readJsonIfAvailable(infoPath)) || {};
    const videoPath = info.sourceVideoPath || info.proxyPath || "";

    const candidatesPath = path.join(pass1UploadDir, "hook-candidates.json");
    let result = null;
    if (await nonEmptyFileExists(candidatesPath)) {
      result = await readJsonIfAvailable(candidatesPath);
    } else {
      const manifestPath = path.join(pass1UploadDir, "scene-manifest.json");
      const manifest = (await readJsonIfAvailable(manifestPath)) || {};
      const actionPath = path.join(pass1UploadDir, "action-candidates.json");
      const actionCandidates = (await readJsonIfAvailable(actionPath)) || {};
      const transcriptPath = path.join(pass1UploadDir, "source-transcript.srt");
      let cues = [];
      if (await nonEmptyFileExists(transcriptPath)) {
        cues = parseSrtCues(await fs.readFile(transcriptPath, "utf8"));
      }
      const hookAuditionService = new HookAuditionService(this.settings);
      result = await hookAuditionService.audition({
        transcriptCues: cues,
        actionCandidates: actionCandidates?.candidates || [],
        manifest,
        durationSec: manifest.videoDurationSec || 0,
        topCount: 5
      });
      if (result?.topCandidates?.length) {
        await writeJsonAtomic(candidatesPath, result);
      }
    }
    if (result) {
      result.sourceVideoPath = info.sourceVideoPath || "";
      result.proxyPath = info.proxyPath || "";
      result.videoPath = videoPath;
    }
    return result;
  }

  async lockHookContract({
    packageDir,
    candidate,
    userAnchorRange,
    trimmingTolerance,
    storyFormat = "non_linear_rewind",
    isMultiVariant = false,
    hasDuplicates = false,
    variants = null
  } = {}) {
    if (!packageDir) throw new Error("Chưa có đường dẫn gói phân tích.");
    if (!candidate && !variants) throw new Error("Chưa chọn ứng viên Hook.");
    const contract = buildHookContract({
      candidate,
      userAnchorRange,
      trimmingTolerance,
      storyFormat,
      isUserLocked: true,
      isMultiVariant: Boolean(isMultiVariant || variants),
      hasDuplicates: Boolean(hasDuplicates),
      variants
    });
    const pass1UploadDir = path.join(packageDir, "01-GUI-GEMINI");
    const contractPath = path.join(pass1UploadDir, "hook-contract.json");
    await writeJsonAtomic(contractPath, contract);

    const promptPath = path.join(pass1UploadDir, "01-gemini-highlight-scripts-prompt.txt");
    if (await nonEmptyFileExists(promptPath)) {
      const currentPrompt = await fs.readFile(promptPath, "utf8");
      let cleaned = currentPrompt;
      if (/DIRECT HIGHLIGHT CONTENT RULES:[\s\S]*?(?=- Watch the complete video input)/i.test(currentPrompt)) {
        cleaned = currentPrompt.replace(
          /DIRECT HIGHLIGHT CONTENT RULES:[\s\S]*?(?=- Watch the complete video input)/i,
          "DIRECT HIGHLIGHT CONTENT RULES:\n\n"
        ).trim();
      } else {
        cleaned = currentPrompt.replace(
          /={10,}\s*(?:HOOK CONTRACT|USER-SELECTED HOOK|3-VARIANT NARRATIVE DIFFERENTIATION|CRITICAL MANDATE: DUPLICATE HOOK DIVERGENCE)[\s\S]*?={10,}\s*/gi,
          ""
        ).replace(/\n{3,}/g, "\n\n").trim();
      }
      const updatedPrompt = injectHookContractToPrompt(cleaned, contract);
      await fs.writeFile(promptPath, updatedPrompt, "utf8");
    }

    const infoPath = path.join(packageDir, "package-info.json");
    if (await nonEmptyFileExists(infoPath)) {
      const info = (await readJsonIfAvailable(infoPath)) || {};
      info.hookContractPath = contractPath;
      info.selectedHookId = contract.hookId;
      info.isMultiVariantHook = contract.isMultiVariant;
      await writeJsonAtomic(infoPath, info);
    }

    return {
      success: true,
      contractPath,
      contract
    };
  }
}

module.exports = ManualGeminiPackService;
module.exports.buildSceneReferenceAss = buildSceneReferenceAss;
module.exports.normalizeManifest = normalizeManifest;
module.exports.formatTimestamp = formatTimestamp;
module.exports.buildSourceFingerprint = buildSourceFingerprint;
module.exports.buildAnalysisCacheKeys = buildAnalysisCacheKeys;
module.exports.buildProxyCacheKey = buildProxyCacheKey;
module.exports.buildSourceRuns = buildSourceRuns;
module.exports.validateSceneEvidence = validateSceneEvidence;
module.exports.evaluateEvidenceQuality = evaluateEvidenceQuality;
module.exports.validateStoryBlueprint = validateStoryBlueprint;
module.exports.buildStoryBlueprintPrompt = buildStoryBlueprintPrompt;
module.exports.buildSingleVariantPrompt = buildSingleVariantPrompt;
module.exports.buildLockedEvidenceScriptPrompt = buildLockedEvidenceScriptPrompt;
module.exports.buildPass1JsonFilePrompt = buildPass1JsonFilePrompt;
module.exports.buildDirectHighlightScriptsPrompt = buildDirectHighlightScriptsPrompt;
module.exports.buildProxyChunkPlan = buildProxyChunkPlan;
module.exports.buildProxyInputGuide = buildProxyInputGuide;
module.exports.partitionProxyChunksForUpload = partitionProxyChunksForUpload;
module.exports.buildSingleJsonCodeBlockContract = buildSingleJsonCodeBlockContract;
module.exports.buildThreeJsonCodeBlockContract = buildThreeJsonCodeBlockContract;
