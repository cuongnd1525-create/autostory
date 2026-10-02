const fs = require("fs/promises");
const path = require("path");

const GeminiService = require("./geminiService");
const VertexAiService = require("./vertexAiService");
const ManualAntigravityStage1Service = require("./manualAntigravityStage1Service");
const { inspectGeminiJsonFiles } = require("./geminiJsonArtifactService");

const STAGE1_RESULT_DIR = "01-CONFIGURED-AI-RESULT";
const DRAFT_RESULT_DIR = "02-CONFIGURED-AI-RESULT";
const SCRIPT_IDS = [1, 3, 4, 2, 5];

function providerDescriptor(settings = {}) {
  const provider = settings.aiProvider || "gemini";
  if (provider === "gemini") {
    if (!settings.geminiApiKey) throw new Error("Gemini đang được chọn nhưng chưa có API key trong Cài đặt.");
    return { provider, label: "Gemini", model: settings.geminiModel || "gemini-2.5-pro" };
  }
  if (provider === "vertex_ai") {
    if (!settings.vertexProjectId && !settings.vertexCredentialPath) {
      throw new Error("Vertex AI cần Google Cloud Project ID; hoặc chọn service account JSON có project_id.");
    }
    if (!settings.vertexCredentialPath && !settings.vertexGcloudCommand) {
      throw new Error("Vertex AI cần file JSON service account hoặc Application Default Credentials.");
    }
    return {
      provider,
      label: "Vertex AI",
      model: settings.vertexAnalysisModel || "gemini-2.5-flash",
      qualityModel: settings.vertexQualityModel || "gemini-2.5-pro"
    };
  }
  if (provider === "antigravity_cli") {
    const model = ManualAntigravityStage1Service.normalizeAntigravityModel?.(settings.antigravityModel)
      || settings.antigravityModel
      || "mặc định CLI";
    return { provider, label: "Antigravity", model };
  }
  if (provider === "ollama_local") {
    throw new Error("Ollama Local chưa được dùng cho phân tích package video đa phương thức. Hãy chọn Gemini hoặc Antigravity trong Cài đặt.");
  }
  throw new Error(`AI provider "${provider}" chưa hỗ trợ luồng phân tích package.`);
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Không đọc được ${label}: ${error.message}`);
  }
}

async function writeJson(filePath, payload) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}

function parseJsonValue(value) {
  if (value && typeof value === "object") return value;
  const text = String(value || "").replace(/^\uFEFF/, "").trim();
  const candidates = [text];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1].trim());
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
  candidates.push(...lines);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (_error) {
      // Continue with nested JSON representations.
    }
  }
  return null;
}

function findObject(value, predicate, seen = new Set()) {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== "object" || seen.has(parsed)) return null;
  seen.add(parsed);
  if (predicate(parsed)) return parsed;
  for (const key of ["response", "result", "output", "data", "content", "text", "final"]) {
    if (parsed[key] == null) continue;
    const nested = findObject(parsed[key], predicate, seen);
    if (nested) return nested;
  }
  for (const nestedValue of Object.values(parsed)) {
    if (!nestedValue || typeof nestedValue !== "object") continue;
    const nested = findObject(nestedValue, predicate, seen);
    if (nested) return nested;
  }
  return null;
}

async function listPackageFiles(folder) {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(folder, entry.name));
}

async function collectStage1InputFiles(root, info = {}) {
  const inputDir = path.resolve(info.pass1UploadDir || path.join(root, "01-GUI-GEMINI"));
  const configuredBatchDirs = Array.isArray(info.proxyUploadBatchDirs) ? info.proxyUploadBatchDirs : [];
  const directories = [...new Set([inputDir, ...configuredBatchDirs].map((folder) => path.resolve(folder)))];
  const files = [];
  for (const directory of directories) {
    try {
      files.push(...await listPackageFiles(directory));
    } catch (error) {
      throw new Error(`Không đọc được thư mục input Vertex ${directory}: ${error.message}`);
    }
  }
  const deduplicated = [...new Map(files.map((file) => [path.resolve(file).toLowerCase(), path.resolve(file)])).values()];
  const chunkManifestPath = path.join(inputDir, "proxy-chunks-manifest.json");
  let chunkManifest = null;
  try {
    chunkManifest = await readJson(chunkManifestPath, "proxy-chunks-manifest.json");
  } catch (_error) {
    // Short videos legitimately use one analysis-proxy.mp4 and no chunk manifest.
  }
  const chunks = Array.isArray(chunkManifest?.chunks) ? chunkManifest.chunks : [];
  if (chunks.length) {
    const availableNames = new Set(deduplicated.map((file) => path.basename(file).toLowerCase()));
    const missing = chunks.filter((chunk) => !availableNames.has(path.basename(chunk.file || "").toLowerCase()));
    if (missing.length) {
      throw new Error(
        `Gói GĐ1 thiếu ${missing.length}/${chunks.length} proxy đã khai báo (${missing.slice(0, 3).map((chunk) => chunk.file).join(", ")}). `
        + "Hãy bấm Tạo gói lại; có thể giữ cache để tool khôi phục file proxy."
      );
    }
  }
  return { inputDir, files: deduplicated };
}

function selectFiles(files, maxFiles = 10) {
  const priority = (filePath) => {
    const name = path.basename(filePath).toLowerCase();
    if (/draft-v\d+\.mp4/.test(name)) return 0;
    if (name.includes("hook-audition")) return 1;
    if (name.includes("analysis-proxy") || name.includes("proxy-part") || name.endsWith(".mp4")) return 2;
    if (name.includes("review-context") || name.includes("scene-manifest")) return 3;
    if (name.includes("transcript")) return 4;
    if (name.includes("action-candidate") || name.includes("proxy-chunks-manifest")) return 5;
    if (name.endsWith(".json") || name.endsWith(".srt")) return 6;
    return 9;
  };
  return [...files].sort((left, right) => priority(left) - priority(right) || left.localeCompare(right)).slice(0, maxFiles);
}

function getRequestedScriptIds(promptText = "") {
  const match = String(promptText).match(/INDEPENDENT_USER_OPTIONS_JSON_BEGIN\s*([\s\S]*?)\s*INDEPENDENT_USER_OPTIONS_JSON_END/i);
  let count = 3;
  try {
    count = Math.max(1, Math.min(5, Number(JSON.parse(match?.[1] || "{}").scriptCount) || 3));
  } catch (_error) {
    count = 3;
  }
  return SCRIPT_IDS.slice(0, count);
}

function buildStage1TransportPrompt(promptText) {
  const scriptIds = getRequestedScriptIds(promptText);
  return [
    promptText,
    "",
    "AUTOMATED PROVIDER TRANSPORT OVERRIDE:",
    "Confirm access by actually inspecting every attached input before writing scripts. Do not infer access from filenames.",
    "Return one JSON object only with this envelope:",
    JSON.stringify({ artifacts: scriptIds.map((id) => ({ filename: `script-${id}.json`, script: {} })), notes: "" }),
    `Each script object must follow the REQUIRED ROOT SCHEMA in the editorial prompt. Return exactly ${scriptIds.length} requested script${scriptIds.length === 1 ? "" : "s"}. Do not return prose or Markdown.`
  ].join("\n");
}

function buildDraftTransportPrompt(promptText, packageDir, options = {}) {
  const resultDir = options.resultDir || "";
  return [
    promptText,
    "",
    "AUTOMATED PROVIDER EXECUTION:",
    "================================================================================",
    "CRITICAL MANDATORY EXECUTION CONSTRAINTS (PREVENT TIMEOUT & ELIMINATE SCRIPTING):",
    "================================================================================",
    `INPUT_FOLDER: ${packageDir}`,
    ...(resultDir ? [`RESULT_FOLDER: ${resultDir}`] : []),
    "",
    "STRICTLY PROHIBITED ACTIONS FOR AGENTS/CLI:",
    "1. PROHIBITED: Do NOT write or execute any Python, shell, PowerShell, batch, or Node.js scripts (no scripts in `scratch/` or any other directory).",
    "2. PROHIBITED: Do NOT extract video frames to image files (no FFmpeg frame extraction, no OpenCV image slicing, no frame dumping).",
    "3. PROHIBITED: Do NOT run ffprobe, ffmpeg, or exploratory shell commands (e.g., Get-ChildItem, dir, ls, Test-Path, find). All files are already located in INPUT_FOLDER.",
    "4. All necessary review inputs (draft video, hook audition clip, transcript SRT, manifests) are already provided in INPUT_FOLDER.",
    "5. Use the `view_file` tool directly to inspect video clips, SRT, and JSON metadata.",
    "",
    "REVIEW DECISION & OUTPUT CONTRACT:",
    "1. This is a one-turn headless execution. Do NOT stop after making an implementation plan, do NOT ask for approval, and do NOT return a plan file.",
    "2. Watch the complete draft and inspect every supplied review input before deciding. Synthesize your review directly using multimodal inspection.",
    "3. OUTPUT: Write the completed `gemini-draft-review.json` directly into INPUT_FOLDER (or emit the single complete JSON object wrapped in the required schema).",
    "4. Return ONLY the valid `gemini_draft_review` JSON object required by the prompt. Do not return prose or Markdown.",
    "================================================================================"
  ].join("\n");
}

class ConfiguredAiWorkflowService {
  constructor(settings = {}, projectStore = null) {
    this.settings = settings;
    this.projectStore = projectStore;
    this.activeDelegate = null;
    this.abortController = null;
  }

  cancel() {
    this.abortController?.abort();
    return Boolean(this.activeDelegate?.cancel?.() || this.abortController);
  }

  async runGemini({ files, prompt, onProgress }) {
    this.abortController = new AbortController();
    const gemini = new GeminiService(this.settings.geminiApiKey, this.settings.geminiModel);
    try {
      return await gemini.generateJsonFromFiles({
        filePaths: selectFiles(files, 10),
        prompt,
        temperature: 0.18,
        signal: this.abortController.signal,
        onProgress
      });
    } finally {
      this.abortController = null;
    }
  }

  async runVertex({ files, prompt, onProgress, taskType }) {
    this.abortController = new AbortController();
    const vertex = new VertexAiService(this.settings);
    try {
      const response = await vertex.generateJsonFromFiles({
        filePaths: selectFiles(files, files.length),
        prompt,
        temperature: taskType === "draft_review" ? 0.16 : 0.18,
        taskType,
        signal: this.abortController.signal,
        onProgress
      });
      return {
        response,
        usage: vertex.lastUsage || null,
        timings: vertex.lastTimings || null,
        budget: await vertex.budgetStatus()
      };
    } finally {
      this.abortController = null;
    }
  }

  async runAntigravity({ folder, prompt, onProgress, options = {} }) {
    const delegate = new ManualAntigravityStage1Service(this.settings);
    this.activeDelegate = delegate;
    try {
      const config = delegate.buildCommand(prompt, "", folder, options);
      const result = await delegate.runCli({
        ...config,
        prompt,
        cwd: folder,
        onProgress: (progress) => onProgress?.({ ...progress, step: "configured_ai_draft_review" }),
        progressStep: "configured_ai_draft_review"
      });
      return result.stdout;
    } catch (error) {
      const reviewPath = path.join(folder, "gemini-draft-review.json");
      try {
        const review = await readJson(reviewPath, "gemini-draft-review.json");
        if (review && review.artifactType === "gemini_draft_review") {
          onProgress?.({
            step: "configured_ai_draft_review",
            percent: 98,
            message: "Antigravity đã lưu gemini-draft-review.json thành công trước khi kết thúc."
          });
          return JSON.stringify(review);
        }
      } catch (_) {}
      throw error;
    } finally {
      this.activeDelegate = null;
    }
  }

  async runStage1({ packageDir, onProgress } = {}) {
    const descriptor = providerDescriptor(this.settings);
    if (!packageDir) throw new Error("Hãy tạo gói GĐ1 trước khi phân tích bằng AI.");
    if (descriptor.provider === "antigravity_cli") {
      const delegate = new ManualAntigravityStage1Service(this.settings);
      this.activeDelegate = delegate;
      try {
        const result = await delegate.run({ packageDir, onProgress });
        return { ...result, provider: descriptor.provider, providerLabel: descriptor.label, model: descriptor.model };
      } finally {
        this.activeDelegate = null;
      }
    }

    const root = path.resolve(packageDir);
    const info = await readJson(path.join(root, "package-info.json"), "package-info.json của GĐ1");
    if (info.workflow !== "manual_gemini_draft_review") {
      throw new Error("Phân tích tự động GĐ1 hiện chỉ dùng cho chế độ Viết kịch bản rồi review video thật.");
    }
    const collected = await collectStage1InputFiles(root, info);
    const inputDir = collected.inputDir;
    const promptPath = path.resolve(info.promptPath || path.join(inputDir, "01-gemini-highlight-scripts-prompt.txt"));
    const promptText = await fs.readFile(promptPath, "utf8");
    const requestedScriptIds = getRequestedScriptIds(promptText);
    const files = collected.files.filter((file) => (
      path.resolve(file) !== promptPath
      && !/^00-UPLOAD-.*\.txt$/i.test(path.basename(file))
      && !/^00-UPLOAD-ORDER\.txt$/i.test(path.basename(file))
    ));
    const resultDir = path.join(root, STAGE1_RESULT_DIR);
    await fs.mkdir(resultDir, { recursive: true });
    onProgress?.({ step: "configured_ai_stage1", percent: 5, message: `Đang chuẩn bị GĐ1 cho ${descriptor.label}` });
    const vertexRun = descriptor.provider === "vertex_ai"
      ? await this.runVertex({
          files,
          prompt: buildStage1TransportPrompt(promptText),
          taskType: "stage1",
          onProgress: (progress) => onProgress?.({ ...progress, step: "configured_ai_stage1" })
        })
      : null;
    const response = vertexRun?.response || await this.runGemini({
        files,
        prompt: buildStage1TransportPrompt(promptText),
        onProgress: (progress) => onProgress?.({ ...progress, step: "configured_ai_stage1" })
      });
    const envelope = ManualAntigravityStage1Service.findArtifactEnvelope(response);
    if (!envelope?.artifacts?.length) throw new Error(`${descriptor.label} không trả về artifacts JSON hợp lệ.`);
    const normalized = envelope.artifacts.map(ManualAntigravityStage1Service.normalizeArtifact);
    const deduplicated = new Map(normalized.map((artifact) => [Number(artifact.script.scriptId), artifact]));
    const outputFiles = [];
    for (const scriptId of requestedScriptIds) {
      const artifact = deduplicated.get(scriptId);
      if (!artifact) continue;
      const outputPath = path.join(resultDir, artifact.filename);
      await writeJson(outputPath, artifact.script);
      outputFiles.push(outputPath);
    }
    const inspections = await inspectGeminiJsonFiles(outputFiles);
    const acceptedTypes = new Set(["story_recut_script", "story_spine_edit_script"]);
    const validFiles = inspections.filter((item) => item.validJson && acceptedTypes.has(item.type) && item.segmentCount > 0).map((item) => item.filePath);
    if (!validFiles.length) throw new Error(`${descriptor.label} không tạo được variant hợp lệ. Xem kết quả tại ${resultDir}.`);
    const warnings = inspections.filter((item) => !validFiles.includes(item.filePath)).map((item) => `${path.basename(item.filePath)}: ${item.error || item.type}`);
    await writeJson(path.join(resultDir, "configured-ai-run-info.json"), {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      ...descriptor,
      packageDir: root,
      promptPath,
      inputFiles: selectFiles(files, 10),
      validFiles,
      warnings,
      usage: vertexRun?.usage || null,
      timings: vertexRun?.timings || null,
      budget: vertexRun?.budget || null
    });
    onProgress?.({ step: "configured_ai_stage1", percent: 100, message: `${descriptor.label} đã tạo ${validFiles.length} variant` });
    return {
      resultDir,
      files: outputFiles,
      validFiles,
      inspections,
      warnings,
      usage: vertexRun?.usage || null,
      timings: vertexRun?.timings || null,
      budget: vertexRun?.budget || null,
      ...descriptor
    };
  }

  async runDraftReview({ workspaceRoot, projectId, packageDir, onProgress } = {}) {
    const descriptor = providerDescriptor(this.settings);
    const runDescriptor = descriptor.provider === "vertex_ai"
      ? { ...descriptor, model: descriptor.qualityModel || descriptor.model }
      : descriptor;
    if (!packageDir) throw new Error("Hãy tạo gói review Draft V1 trước.");
    const inputDir = path.resolve(packageDir);
    const packageRoot = path.dirname(inputDir);
    const info = await readJson(path.join(packageRoot, "review-package-info.json"), "review-package-info.json");
    if (info.projectId !== projectId) throw new Error("Gói review không thuộc project hiện tại.");
    const promptPath = path.join(inputDir, "gemini-draft-review-prompt.txt");
    const promptText = await fs.readFile(promptPath, "utf8");
    const files = (await listPackageFiles(inputDir)).filter((file) => file !== promptPath);
    const resultDir = path.join(packageRoot, DRAFT_RESULT_DIR);
    await fs.mkdir(resultDir, { recursive: true });
    onProgress?.({ step: "configured_ai_draft_review", percent: 5, message: `Đang chuẩn bị Draft V${info.revision} cho ${descriptor.label}` });
    const expectedBinding = info.reviewTarget?.reviewBindingId;
    let review = null;
    const existingCandidates = [
      path.join(resultDir, "gemini-draft-review.json"),
      path.join(inputDir, "gemini-draft-review.json")
    ];
    for (const candidatePath of existingCandidates) {
      try {
        const candidate = await readJson(candidatePath, "existing gemini-draft-review.json");
        const actualBinding = candidate?.reviewTarget?.reviewBindingId || candidate?.review_target?.reviewBindingId;
        if (candidate?.artifactType === "gemini_draft_review" && (!expectedBinding || actualBinding === expectedBinding)) {
          review = candidate;
          onProgress?.({
            step: "configured_ai_draft_review",
            percent: 95,
            message: `Tìm thấy file review Draft V${info.revision} đã hoàn tất hợp lệ trên đĩa.`
          });
          break;
        }
      } catch (_) {}
    }

    let vertexRun = null;
    if (!review) {
      const transportPrompt = buildDraftTransportPrompt(promptText, inputDir, { resultDir });
      vertexRun = descriptor.provider === "vertex_ai"
        ? await this.runVertex({
            files,
            prompt: transportPrompt,
            taskType: "draft_review",
            onProgress: (progress) => onProgress?.({ ...progress, step: "configured_ai_draft_review" })
          })
        : null;
      const raw = descriptor.provider === "gemini"
        ? await this.runGemini({
            files,
            prompt: transportPrompt,
            onProgress: (progress) => onProgress?.({ ...progress, step: "configured_ai_draft_review" })
          })
        : descriptor.provider === "vertex_ai"
          ? vertexRun.response
          : await this.runAntigravity({
              folder: inputDir,
              prompt: transportPrompt,
              onProgress,
              options: { packageInfo: info }
            });
      review = findObject(raw, (value) => value.artifactType === "gemini_draft_review");
      if (!review) {
        for (const candidatePath of [path.join(inputDir, "gemini-draft-review.json"), path.join(resultDir, "gemini-draft-review.json")]) {
          try {
            const candidate = await readJson(candidatePath, "gemini-draft-review.json");
            if (candidate?.artifactType === "gemini_draft_review") {
              review = candidate;
              break;
            } else if (candidate?.artifactType === "gemini_input_access_failure") {
              const detail = candidate.mismatchDetails || candidate.recommendedAction || "Lỗi kiểm tra đầu vào.";
              throw new Error(`AI từ chối review: ${detail}`);
            }
          } catch (candidateErr) {
            if (candidateErr.message.includes("AI từ chối review")) throw candidateErr;
          }
        }
      }
    }
    if (!review || review.artifactType !== "gemini_draft_review") {
      throw new Error(`${descriptor.label} không trả về gemini_draft_review JSON hợp lệ.`);
    }
    const actualBinding = review.reviewTarget?.reviewBindingId || review.review_target?.reviewBindingId;
    if (expectedBinding && actualBinding !== expectedBinding) {
      throw new Error("AI trả về reviewBindingId không khớp Draft V1 hiện tại.");
    }
    const resultPath = path.join(resultDir, "gemini-draft-review.json");
    await writeJson(resultPath, review);
    await writeJson(path.join(resultDir, "configured-ai-run-info.json"), {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      ...runDescriptor,
      projectId,
      variantId: info.variantId,
      revision: info.revision,
      reviewBindingId: expectedBinding || "",
      packageDir: inputDir,
      resultPath,
      usage: vertexRun?.usage || null,
      timings: vertexRun?.timings || null,
      budget: vertexRun?.budget || null
    });
    if (this.projectStore && workspaceRoot) {
      const project = await this.projectStore.getProject(workspaceRoot, projectId);
      const variants = (project.analysis?.highlightVariants || []).map((variant) => variant.id === info.variantId ? {
        ...variant,
        artifacts: {
          ...(variant.artifacts || {}),
          draftReviewAiResultPath: resultPath,
          draftReviewAiResultDir: resultDir,
          draftReviewAiProvider: descriptor.provider,
          draftReviewAiModel: runDescriptor.model,
          draftReviewAiCompletedAt: new Date().toISOString()
        }
      } : variant);
      await this.projectStore.updateProject(workspaceRoot, projectId, {
        analysis: { ...(project.analysis || {}), highlightVariants: variants }
      });
    }
    onProgress?.({ step: "configured_ai_draft_review", percent: 100, message: `${descriptor.label} đã hoàn tất review Draft V${info.revision}` });
    return {
      resultDir,
      resultPath,
      revision: info.revision,
      variantId: info.variantId,
      usage: vertexRun?.usage || null,
      timings: vertexRun?.timings || null,
      budget: vertexRun?.budget || null,
      ...runDescriptor
    };
  }
}

ConfiguredAiWorkflowService.providerDescriptor = providerDescriptor;
ConfiguredAiWorkflowService.collectStage1InputFiles = collectStage1InputFiles;

module.exports = ConfiguredAiWorkflowService;
