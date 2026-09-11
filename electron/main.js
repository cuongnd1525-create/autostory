const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const { spawn } = require("child_process");

const ConfigStore = require("./services/configStore");
const ProjectStore = require("./services/projectStore");
const PipelineService = require("./services/pipelineService");
const DubbingService = require("./services/dubbingService");
const ManualGeminiPackService = require("./services/manualGeminiPackService");
const ManualAntigravityStage1Service = require("./services/manualAntigravityStage1Service");
const ConfiguredAiWorkflowService = require("./services/configuredAiWorkflowService");
const VertexAiService = require("./services/vertexAiService");
const AutoStoryPipelineService = require("./services/autoStoryFastService");
const PodcastViralService = require("./services/podcastViralService");
const PodcastCandidateService = require("./services/podcastCandidateService");
const SourceDownloadService = require("./services/sourceDownloadService");
const GeminiDraftReviewService = require("./services/geminiDraftReviewService");
const ElevenLabsService = require("./services/elevenLabsService");
const WindowsVoiceService = require("./services/windowsVoiceService");
const EdgeTtsService = require("./services/edgeTtsService");
const OmniVoiceService = require("./services/omniVoiceService");
const KokoroVoiceService = require("./services/kokoroVoiceService");
const LocalTranslationService = require("./services/localTranslationService");
const SubtitleService = require("./services/subtitleService");
const OllamaService = require("./services/ollamaService");
const RenderJobService = require("./services/renderJobService");
const { createMonotonicProgressNormalizer } = require("./services/progressPolicy");
const { buildCliEnv } = require("./services/cliEnv");
const { createCancelToken, clearCancelToken, cancelActiveOperation } = require("./services/cancelToken");
const { inspectGeminiJsonFiles } = require("./services/geminiJsonArtifactService");

let mainWindow;
let configStore;
let projectStore;
let pipelineService;
let dubbingService;
let ollamaService;
let renderJobService;
let geminiDraftReviewService;
let manualAntigravityStage1Service;
let configuredAiWorkflowService;
let mainWindowRendererReady = false;
let rendererRecoveryAttempts = [];
let recoveredRenderJobs = [];
let renderRecoveryScanned = false;

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function sanitizeFilePart(value = "") {
  return String(value || "video")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "video";
}

function buildMirrorOutputPath(inputPath, intervalSec, settings = {}) {
  const parsed = path.parse(inputPath);
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const safeInterval = String(intervalSec).replace(/[^\d.]/g, "").replace(".", "p") || "3";
  const exportRoot = settings.exportRoot || parsed.dir;
  return path.join(exportRoot, `${sanitizeFilePart(parsed.name)}-mirror-${safeInterval}s-${stamp}.mp4`);
}

function sendToFrameSafe(frame, channel, payload) {
  try {
    if (!frame || frame.isDestroyed?.() || frame.detached) {
      return false;
    }
    frame.send(channel, payload);
    return true;
  } catch (error) {
    const message = String(error?.message || error || "");
    if (/Render frame was disposed|WebFrameMain|Object has been destroyed|frame was disposed/i.test(message)) {
      return false;
    }
    console.warn(`Could not send ${channel}: ${message}`);
    return false;
  }
}

function sendToWebContentsSafe(webContents, channel, payload) {
  try {
    if (!webContents || webContents.isDestroyed?.()) {
      return false;
    }
    return sendToFrameSafe(webContents.mainFrame, channel, payload);
  } catch (_error) {
    return false;
  }
}

function sendMainWindowSafe(channel, payload) {
  if (!mainWindowRendererReady || !mainWindow || mainWindow.isDestroyed()) {
    return false;
  }
  return sendToWebContentsSafe(mainWindow.webContents, channel, payload);
}

function sendPipelineProgress(payload) {
  return sendMainWindowSafe("pipeline:progress", payload);
}

function sendVoiceProgressSafe(event, payload) {
  return sendToFrameSafe(event?.senderFrame, "voice:progress", payload);
}

function createPipelineProgressSender(event, { onNormalized } = {}) {
  const targetFrame = event?.senderFrame;
  const normalize = createMonotonicProgressNormalizer();
  return (payload) => {
    const normalizedPayload = normalize(payload);
    onNormalized?.(normalizedPayload);
    return sendToFrameSafe(targetFrame, "pipeline:progress", normalizedPayload);
  };
}

function runCheckCommand(command, args = [], timeoutMs = 8000) {
  return new Promise((resolve) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    const child = spawn(command, args, { windowsHide: true, env: buildCliEnv() });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ ok: false, detail: `${command} timed out.` });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, detail: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = Buffer.concat(stdoutChunks).toString() || Buffer.concat(stderrChunks).toString();
      resolve({ ok: code === 0, detail: output.split(/\r?\n/).find(Boolean) || `exit code ${code}` });
    });
  });
}

async function checkConfiguration(settings) {
  const checks = [];
  const add = (key, label, status, message, hint = "") => checks.push({ key, label, status, message, hint });

  try {
    await fs.mkdir(settings.workspaceRoot, { recursive: true });
    await fs.access(settings.workspaceRoot);
    add("workspaceRoot", "Thư mục làm việc", "ok", "Có thể truy cập thư mục làm việc.");
  } catch (error) {
    add("workspaceRoot", "Thư mục làm việc", "error", "Không thể truy cập hoặc tạo thư mục làm việc.", error.message);
  }

  try {
    await fs.mkdir(settings.exportRoot, { recursive: true });
    await fs.access(settings.exportRoot);
    add("exportRoot", "Thư mục xuất video và bản nháp", "ok", "Có thể xuất video và bản nháp vào thư mục này.");
  } catch (error) {
    add("exportRoot", "Thư mục xuất video và bản nháp", "error", "Không thể truy cập hoặc tạo thư mục xuất video.", error.message);
  }

  try {
    await fs.mkdir(settings.geminiAnalysisRoot, { recursive: true });
    await fs.access(settings.geminiAnalysisRoot);
    add("geminiAnalysisRoot", "Thư mục gói phân tích Gemini", "ok", "Có thể lưu gói phân tích Gemini vào thư mục này.");
  } catch (error) {
    add("geminiAnalysisRoot", "Thư mục gói phân tích Gemini", "error", "Không thể truy cập hoặc tạo thư mục gói phân tích Gemini.", error.message);
  }

  const ffmpeg = await runCheckCommand(settings.ffmpegPath || "ffmpeg", ["-version"]);
  add("ffmpegPath", "FFmpeg", ffmpeg.ok ? "ok" : "error", ffmpeg.ok ? "FFmpeg sẵn sàng." : "Không chạy được FFmpeg.", ffmpeg.detail);

  const ffprobe = await runCheckCommand(settings.ffprobePath || "ffprobe", ["-version"]);
  add("ffprobePath", "FFprobe", ffprobe.ok ? "ok" : "error", ffprobe.ok ? "FFprobe sẵn sàng." : "Không chạy được FFprobe.", ffprobe.detail);

  const ytDlp = await runCheckCommand(settings.ytDlpCommand || "yt-dlp", ["--version"]);
  add(
    "ytDlpCommand",
    "Tải nguồn YouTube/TikTok",
    ytDlp.ok ? "ok" : "warning",
    ytDlp.ok ? "yt-dlp sẵn sàng." : "Không chạy được yt-dlp; chức năng tải video từ URL sẽ không hoạt động.",
    ytDlp.detail
  );

  const aiProvider = settings.aiProvider || "gemini";
  add("aiProvider", "AI provider", aiProvider === "local" ? "warning" : "ok", `Đang dùng ${aiProvider}.`);
  add(
    "geminiApiKey",
    "Gemini API key",
    settings.geminiApiKey ? "ok" : aiProvider === "gemini" ? "error" : "ok",
    settings.geminiApiKey
      ? `Đã có API key, model: ${settings.geminiModel || "gemini-2.5-pro"}.`
      : aiProvider === "gemini" ? "Chưa nhập Gemini API key." : "Không dùng Gemini API key với provider hiện tại.",
    settings.geminiApiKey || aiProvider !== "gemini" ? "" : "Gemini đang là AI provider chính nên cần API key."
  );

  if (settings.aiProvider === "local") {
    add("aiProvider", "AI provider", "warning", "Đang dùng Local fallback.", "Các tác vụ review phức tạp có thể cần Gemini, Antigravity hoặc Ollama.");
  } else if (aiProvider === "ollama_local") {
    try {
      const service = ollamaService || new OllamaService();
      const result = await service.listModels();
      const modelName = settings.ollamaVisionModel || "gemma4";
      const hasModel = result.models.some((model) => model.name === modelName);
      add(
        "ollama",
        "Ollama Local",
        hasModel ? "ok" : "warning",
        hasModel ? `Ollama sẵn sàng, model: ${modelName}.` : `Ollama chạy được nhưng chưa thấy model ${modelName}.`,
        hasModel ? "" : "Tải model trong tab cấu hình hoặc đổi sang model Ollama đang có."
      );
    } catch (error) {
      add("ollama", "Ollama Local", "error", "Không chạy được Ollama Local.", error.message);
    }
  } else if (aiProvider === "vertex_ai") {
    let resolvedProjectId = String(settings.vertexProjectId || "").trim();
    let projectReady = Boolean(resolvedProjectId);
    const credentialPath = String(settings.vertexCredentialPath || "").trim();
    let credentialReady = false;
    let credentialHint = "";
    if (credentialPath) {
      try {
        const credential = JSON.parse(await fs.readFile(credentialPath, "utf8"));
        credentialReady = credential.type === "service_account" && Boolean(credential.client_email && credential.private_key);
        resolvedProjectId ||= String(credential.project_id || "").trim();
        projectReady = Boolean(resolvedProjectId);
        credentialHint = credentialReady ? "File service account hợp lệ." : "File không phải service account JSON hợp lệ.";
      } catch (error) {
        credentialHint = error.message;
      }
    } else {
      const command = String(settings.vertexGcloudCommand || "gcloud").trim().split(/\s+/)[0] || "gcloud";
      const adc = await runCheckCommand(command, ["auth", "application-default", "print-access-token"]);
      credentialReady = adc.ok;
      credentialHint = adc.ok ? "Application Default Credentials sẵn sàng." : adc.detail;
    }
    add(
      "vertexAi",
      "Vertex AI",
      projectReady && credentialReady ? "ok" : "error",
      projectReady && credentialReady
        ? `Vertex AI sẵn sàng tại project ${resolvedProjectId}; model phân tích ${settings.vertexAnalysisModel || "gemini-2.5-flash"}.`
        : "Vertex AI chưa đủ Project ID hoặc thông tin xác thực.",
      [projectReady ? "" : "Nhập Google Cloud Project ID.", credentialHint].filter(Boolean).join(" ")
    );
    add(
      "vertexBucket",
      "Bucket media Vertex",
      settings.vertexBucket ? "ok" : "warning",
      settings.vertexBucket
        ? `Media lớn sẽ cache tại gs://${String(settings.vertexBucket).trim().replace(/^gs:\/\//i, "")}.`
        : "Chưa có bucket; Vertex chỉ xử lý được tác vụ chữ/file nhỏ.",
      settings.vertexBucket ? "" : "Tạo một Cloud Storage bucket để phân tích video proxy và đặt lifecycle tự xóa sau 1-3 ngày."
    );
  } else if (aiProvider !== "gemini") {
    const command = String(settings.antigravityCommand || "agy").trim().split(/\s+/)[0] || "agy";
    const agy = await runCheckCommand(command, ["--version"]);
    const canUseGeminiFallback = !agy.ok && Boolean(settings.geminiApiKey);
    add(
      "antigravityCommand",
      "Antigravity",
      agy.ok ? "ok" : canUseGeminiFallback ? "warning" : "error",
      agy.ok ? "Antigravity CLI sẵn sàng." : canUseGeminiFallback ? "Không chạy được Antigravity CLI; sẽ dùng Gemini thay thế." : "Không chạy được Antigravity CLI.",
      canUseGeminiFallback ? `${agy.detail}. Đổi AI provider sang Gemini để hết cảnh báo này.` : agy.detail
    );
  }

  if ((settings.whisperEngine || "auto") === "openai-whisper") {
    const whisper = await runCheckCommand(settings.whisperCommand || "whisper", ["--help"]);
    add("whisperCommand", "Whisper", whisper.ok ? "ok" : "warning", whisper.ok ? "Whisper CLI sẵn sàng." : "Không chạy được Whisper CLI.", whisper.detail);
  } else {
    const profile = await new SubtitleService(settings).detectRuntime({ language: "en" });
    if (profile.engine === "nvidia-parakeet") {
      add(
        "whisperPythonCommand",
        "NVIDIA Parakeet",
        profile.parakeetAvailable ? "ok" : "error",
        profile.parakeetAvailable
          ? `Parakeet sẵn sàng: ${profile.model} · ${profile.device}.`
          : "Chưa cài NVIDIA NeMo ASR cho Python đã chọn.",
        `${profile.reason}. Cài đặt yêu cầu PyTorch/CUDA phù hợp và: py -3 -m pip install "nemo_toolkit[asr]" soundfile`
      );
    } else {
      const fallbackWhisper = profile.fasterWhisperAvailable
        ? null
        : await runCheckCommand(settings.whisperCommand || "whisper", ["--help"]);
      const asrStatus = profile.fasterWhisperAvailable
        ? "ok"
        : fallbackWhisper?.ok
        ? "warning"
        : "error";
      add(
        "whisperPythonCommand",
        settings.whisperEngine === "auto" ? "Nhận diện tự động" : "faster-whisper",
        asrStatus,
        profile.fasterWhisperAvailable
          ? `Sẵn sàng: ${profile.model} · ${profile.device}/${profile.computeType}.`
          : fallbackWhisper?.ok
          ? "Chưa cài faster-whisper; Whisper CLI dự phòng sẵn sàng."
          : "Chưa có faster-whisper hoặc Whisper CLI để nhận diện lời thoại.",
        `${profile.reason}. CPU ${profile.cpuThreads} luồng, RAM ${profile.totalMemoryGb} GB${profile.nvidiaVramMb ? `, NVIDIA ${Math.round(profile.nvidiaVramMb / 1024)} GB` : ""}.`
          + (profile.fasterWhisperAvailable ? "" : " Cài nhanh: py -3 -m pip install faster-whisper")
      );
    }
  }

  const voiceProvider = settings.defaultVoiceProvider || "edge_neural";
  if (voiceProvider === "elevenlabs") {
    add("defaultVoiceProvider", "Voice provider", settings.elevenLabsApiKey ? "ok" : "warning", settings.elevenLabsApiKey ? "ElevenLabs đã có API key." : "ElevenLabs thiếu API key.", "Có thể đổi sang Edge Neural nếu muốn dùng giọng miễn phí.");
    add("defaultVoiceId", "ElevenLabs voice ID", settings.defaultVoiceId ? "ok" : "warning", settings.defaultVoiceId ? "Đã có voice ID mặc định." : "Chưa có voice ID mặc định.", "Tải danh sách giọng, chọn ElevenLabs rồi bấm dùng giọng này, hoặc dán voice_id vào Settings.");
  } else if (voiceProvider === "omnivoice") {
    const omni = await runCheckCommand(settings.omniVoiceCommand || "omnivoice-infer", ["--help"]);
    add("defaultVoiceProvider", "Voice provider", omni.ok ? "ok" : "warning", omni.ok ? "OmniVoice command sẵn sàng." : "Không chạy được OmniVoice command.", omni.detail);
  } else if (voiceProvider === "kokoro") {
    const kokoro = await runCheckCommand(settings.kokoroPythonCommand || "python", ["-c", "import kokoro, soundfile; print('kokoro ok')"], 20000);
    add("defaultVoiceProvider", "Voice provider", kokoro.ok ? "ok" : "warning", kokoro.ok ? "Kokoro local sẵn sàng." : "Chưa cài được Kokoro cho Python đã chọn.", kokoro.ok ? "" : `${kokoro.detail} Cài bằng: python -m pip install kokoro>=0.9.4 soundfile`);
  } else {
    add("defaultVoiceProvider", "Voice provider", "ok", `Đang dùng ${voiceProvider}.`);
  }

  if (settings.localPreviewTranslationEnabled !== false) {
    if ((settings.localTranslationProvider || "opus_mt") === "hy_mt2_ollama") {
      try {
        const result = await ollamaService.listModels();
        const requestedModel = settings.hyMt2Model || "hf.co/unsloth/Hy-MT2-7B-GGUF:UD-Q4_K_XL";
        const modelReady = result.models.some((item) => item.name === requestedModel);
        add(
          "localPreviewTranslation",
          "Dịch preview bằng Hy-MT2",
          modelReady ? "ok" : "warning",
          modelReady ? `Hy-MT2 đã sẵn sàng: ${requestedModel}.` : "Ollama chạy được nhưng chưa tải model Hy-MT2.",
          modelReady ? "" : "Bấm Tải Hy-MT2 trong Cài đặt. Bản Q4 cần tải khoảng 4,8 GB."
        );
      } catch (error) {
        add("localPreviewTranslation", "Dịch preview bằng Hy-MT2", "warning", "Không chạy được Ollama.", error.message);
      }
    } else {
      const translationPython = settings.localTranslationPythonCommand || "python";
      const translationCheckArgs = translationPython === "py"
        ? ["-3", "-c", "import transformers, sentencepiece, torch; print('local translation ok')"]
        : ["-c", "import transformers, sentencepiece, torch; print('local translation ok')"];
      const localTranslation = await runCheckCommand(translationPython, translationCheckArgs, 20000);
      add(
        "localPreviewTranslation",
        "Dịch phụ đề preview local",
        localTranslation.ok ? "ok" : "warning",
        localTranslation.ok ? "OPUS-MT Anh-Vi đã đủ runtime." : "Thiếu runtime dịch local.",
        localTranslation.ok ? "" : `${localTranslation.detail} Cài bằng: python -m pip install transformers torch sentencepiece sacremoses`
      );
    }
  }

  const errorCount = checks.filter((item) => item.status === "error").length;
  const warningCount = checks.filter((item) => item.status === "warning").length;
  return {
    ok: errorCount === 0,
    errorCount,
    warningCount,
    checks
  };
}

async function normalizeAiProviderForThisMachine() {
  const settings = configStore.getSettings();
  if ((settings.aiProvider || "gemini") !== "antigravity_cli" || !settings.geminiApiKey) {
    return;
  }
  const command = String(settings.antigravityCommand || "agy").trim().split(/\s+/)[0] || "agy";
  const agy = await runCheckCommand(command, ["--version"], 5000);
  if (!agy.ok && /ENOENT|not found|not recognized|kh�ng t�m th?y/i.test(agy.detail || "")) {
    await configStore.saveSettings({ aiProvider: "gemini" });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#09090b",
    title: "RecapTool Studio",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindowRendererReady = false;
  mainWindow.webContents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) mainWindowRendererReady = false;
  });
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindowRendererReady = true;
  });
  mainWindow.webContents.on("render-process-gone", (_event, details = {}) => {
    mainWindowRendererReady = false;
    const reason = String(details.reason || "unknown");
    const exitCode = Number(details.exitCode || 0);
    console.error(`Renderer process stopped during operation: ${reason} (exit ${exitCode}).`);
    const now = Date.now();
    rendererRecoveryAttempts = rendererRecoveryAttempts.filter((stamp) => now - stamp < 60000);
    if (!mainWindow || mainWindow.isDestroyed() || rendererRecoveryAttempts.length >= 2) {
      return;
    }
    rendererRecoveryAttempts.push(now);
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try {
        mainWindow.webContents.reload();
      } catch (error) {
        console.error(`Could not recover renderer: ${error.message}`);
      }
    }, 800);
  });
  mainWindow.on("closed", () => {
    mainWindowRendererReady = false;
    mainWindow = null;
  });
  mainWindow.loadFile(path.join(__dirname, "..", "src", "index.html"));
}

function getWorkspaceRoot() {
  const settings = configStore.getSettings();
  return settings.workspaceRoot;
}

async function bootstrapState() {
  const settings = configStore.getSettings();
  if (!renderRecoveryScanned) {
    recoveredRenderJobs = await renderJobService.recoverInterruptedJobs({
      workspaceRoot: getWorkspaceRoot()
    });
    renderRecoveryScanned = true;
  }
  const projects = await projectStore.listProjects(getWorkspaceRoot());
  return { settings, projects, recoverableRenderJobs: recoveredRenderJobs };
}

app.whenReady().then(async () => {
  const defaultWorkspaceRoot = path.join(app.getPath("documents"), "MovieRecapToolWorkspace", "projects");
  configStore = new ConfigStore(path.join(app.getPath("userData"), "config.json"), defaultWorkspaceRoot);
  await configStore.ensureLoaded();
  await normalizeAiProviderForThisMachine();
  projectStore = new ProjectStore();
  renderJobService = new RenderJobService(projectStore);
  pipelineService = new PipelineService(projectStore);
  dubbingService = new DubbingService(projectStore);
  geminiDraftReviewService = new GeminiDraftReviewService(projectStore);
  ollamaService = new OllamaService();

  createWindow();

  ipcMain.handle("app:bootstrap", async () => bootstrapState());

  ipcMain.handle("dialog:pickVideo", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: "Ch?n video ngu?n",
      properties: ["openFile"],
      filters: [
        { name: "Video", extensions: ["mp4", "mov", "mkv", "avi", "webm"] }
      ]
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("dialog:pickAudio", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Ch?n file gi?ng m?u",
      properties: ["openFile"],
      filters: [
        { name: "Audio", extensions: ["wav", "mp3", "m4a", "flac", "ogg"] }
      ]
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("dialog:pickSubtitle", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: "Ch?n t?p ph? d?",
      properties: ["openFile"],
      filters: [
          { name: "Ph? d?", extensions: ["srt"] }
      ]
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("dialog:pickJson", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Ch?n k?ch b?n JSON",
      properties: ["openFile"],
      filters: [
        { name: "JSON", extensions: ["json"] }
      ]
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("dialog:pickJsonFiles", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Chon mot hoac nhieu kich ban JSON",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "JSON", extensions: ["json"] }
      ]
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("dialog:pickFolder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: "Ch?n thu m?c luu d? �n",
      properties: ["openDirectory", "createDirectory"]
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("source:downloadUrl", async (event, payload) => {
    const service = new SourceDownloadService(configStore.getSettings());
    return service.download({
      ...(payload || {}),
      onProgress: (progress) => sendToFrameSafe(event?.senderFrame, "source:downloadProgress", progress)
    });
  });

  ipcMain.handle("file:open", async (_event, filePath) => {
    if (!filePath) {
      return false;
    }
    await shell.openPath(filePath);
    return true;
  });

  ipcMain.handle("settings:get", async () => configStore.getSettings());

  ipcMain.handle("settings:save", async (_event, payload) => {
    const previousWorkspaceRoot = configStore.getSettings().workspaceRoot;
    const saved = await configStore.saveSettings(payload);
    if (saved.workspaceRoot !== previousWorkspaceRoot) {
      renderRecoveryScanned = false;
      recoveredRenderJobs = [];
    }
    const projects = await projectStore.listProjects(saved.workspaceRoot);
    return { settings: saved, projects };
  });

  ipcMain.handle("settings:check", async (_event, payload) => {
    const settings = {
      ...configStore.getSettings(),
      ...(payload || {})
    };
    return checkConfiguration(settings);
  });

  ipcMain.handle("vertex:test", async (_event, payload) => {
    const settings = { ...configStore.getSettings(), ...(payload || {}) };
    return new VertexAiService(settings).testConnection();
  });

  ipcMain.handle("vertex:budgetStatus", async (_event, payload) => {
    const settings = { ...configStore.getSettings(), ...(payload || {}) };
    return new VertexAiService(settings).budgetStatus();
  });

  ipcMain.handle("ollama:listModels", async () => ollamaService.listModels());

  ipcMain.handle("ollama:modelInfo", async (_event, modelName) => ollamaService.getModelInfo(modelName));

  ipcMain.handle("translation:prepareHyMt2", async (_event, modelName) => (
    ollamaService.pullModel(modelName || "hf.co/unsloth/Hy-MT2-7B-GGUF:UD-Q4_K_XL")
  ));

  ipcMain.handle("analysis:createManualGeminiPack", async (event, payload) => {
    const settings = configStore.getSettings();
    const service = payload?.workflow === PodcastViralService.WORKFLOW
      ? new PodcastViralService(settings)
      : new ManualGeminiPackService(settings);
    return service.create({
      ...payload,
      destinationRoot: settings.geminiAnalysisRoot,
      onProgress: createPipelineProgressSender(event)
    });
  });

  ipcMain.handle("analysis:runManualAntigravityStage1", async (event, payload) => {
    if (manualAntigravityStage1Service) {
      throw new Error("Antigravity đang phân tích một gói GĐ1 khác. Hãy đợi hoặc bấm Dừng.");
    }
    const settings = configStore.getSettings();
    manualAntigravityStage1Service = new ManualAntigravityStage1Service(settings);
    try {
      return await manualAntigravityStage1Service.run({
        packageDir: payload?.packageDir,
        onProgress: createPipelineProgressSender(event)
      });
    } finally {
      manualAntigravityStage1Service = null;
    }
  });

  ipcMain.handle("analysis:cancelManualAntigravityStage1", async () => ({
    cancelled: Boolean(manualAntigravityStage1Service?.cancel())
  }));

  ipcMain.handle("analysis:runConfiguredAiStage1", async (event, payload) => {
    if (configuredAiWorkflowService) {
      throw new Error("AI đang xử lý một tác vụ khác. Hãy đợi hoặc bấm Dừng.");
    }
    configuredAiWorkflowService = new ConfiguredAiWorkflowService(configStore.getSettings(), projectStore);
    try {
      return await configuredAiWorkflowService.runStage1({
        packageDir: payload?.packageDir,
        onProgress: createPipelineProgressSender(event)
      });
    } finally {
      configuredAiWorkflowService = null;
    }
  });

  ipcMain.handle("analysis:cancelConfiguredAi", async () => ({
    cancelled: Boolean(configuredAiWorkflowService?.cancel())
  }));

  ipcMain.handle("analysis:importManualGeminiEvidence", async (_event, payload) => {
    const settings = configStore.getSettings();
    const service = new ManualGeminiPackService(settings);
    return service.importEvidence(payload || {});
  });

  ipcMain.handle("analysis:importPodcastCandidates", async (event, payload) => {
    const settings = configStore.getSettings();
    const service = new PodcastCandidateService(settings);
    return service.importCandidates({
      ...(payload || {}),
      onProgress: createPipelineProgressSender(event)
    });
  });

  ipcMain.handle("analysis:importManualGeminiBlueprint", async (_event, payload) => {
    const settings = configStore.getSettings();
    const service = new ManualGeminiPackService(settings);
    return service.importBlueprint(payload || {});
  });

  ipcMain.handle("analysis:inspectGeminiJsonFiles", async (_event, filePaths) => (
    inspectGeminiJsonFiles(Array.isArray(filePaths) ? filePaths : [])
  ));

  ipcMain.handle("project:create", async (_event, payload) => {
    const settings = configStore.getSettings();
    const project = await projectStore.createProject(getWorkspaceRoot(), {
      ...payload,
      exportRoot: payload.exportRoot || settings.exportRoot,
      exportLayout: payload.exportLayout || settings.exportLayout || "flat"
    });
    const projects = await projectStore.listProjects(getWorkspaceRoot());
    return { project, projects };
  });

  ipcMain.handle("autoStory:run", async (event, projectId, options = {}) => {
    const scriptId = options.scriptId == null ? null : Number(options.scriptId);
    if (scriptId !== null && (!Number.isInteger(scriptId) || scriptId < 1 || scriptId > 5)) throw new Error("Script ID không hợp lệ.");
    const settings = configStore.getSettings();
    const sendProgress = createPipelineProgressSender(event);
    let completedPercent = 0;
    const onProgress = (item) => {
      completedPercent = Math.max(completedPercent, Math.min(100, Number(item.percent) || 0));
      sendProgress({ ...item, percent: completedPercent });
    };
    const controller = new AbortController();
    const token = createCancelToken("vertexAutoStory");
    token.abortController = controller;
    try {
      const service = new AutoStoryPipelineService(settings, projectStore, { dubbing: dubbingService });
      const existingProject = await service.recoverScriptIds(getWorkspaceRoot(), projectId);
      if (existingProject.analysisWorkflow === "vertex_auto_story") {
        await service.vertex?.dispatcher?.close();
        const Runner = require("./services/autoStoryRunner");
        return await new Runner(settings, projectStore, dubbingService).run({ workspaceRoot: getWorkspaceRoot(), projectId,
          scriptId, signal: controller.signal, onProgress });
      }
      const missingScripts = !scriptId && existingProject.analysis?.highlightVariants?.length > 0
        && existingProject.analysis.highlightVariants.length < (existingProject.autoStoryConfig?.outputCount || 2);
      const retryFailed = Boolean((missingScripts || existingProject.autoStoryState?.failures?.some(f => !scriptId || Number(f.scriptId) === scriptId)) && existingProject.autoStoryPipelineVersion === "editorial-v1");
      const resumeRender = ["rendering", "reviewing", "verifying", "review_failed", "render_failed", "complete"].includes(existingProject.autoStoryState?.phase)
        && existingProject.autoStoryPipelineVersion === "editorial-v1"
        && existingProject.analysis?.highlightVariants?.length;
      const analysis = resumeRender && !retryFailed ? { project: existingProject, scriptPaths: existingProject.storyScriptPaths } : await service.run({
        workspaceRoot: getWorkspaceRoot(),
        projectId,
        signal: controller.signal,
        retryFailed,
        scriptId,
        onProgress: (item) => onProgress({
          ...item,
          step: item.step || item.stage || "auto_story",
          percent: Math.round(Number(item.percent || 0) * 0.65),
          message: item.message
        })
      });
      let imported = resumeRender && !retryFailed ? existingProject : await dubbingService.importHighlightCutProject({
        workspaceRoot: getWorkspaceRoot(),
        projectId,
        settings,
        onProgress: (item) => onProgress({
          ...item,
          step: item.step || "auto_story_import",
          percent: 65 + Math.round(Number(item.percent || 0) * 0.07),
          message: item.message
        })
      });
      if (retryFailed && existingProject.analysis?.highlightVariants?.length) imported = await service.mergePreservedVariants(getWorkspaceRoot(), projectId, existingProject);
      await projectStore.updateProject(getWorkspaceRoot(), projectId, { autoStoryState: { ...imported.autoStoryState, phase: "rendering" } });
      let rendered;
      if (scriptId) {
        const target = imported.analysis?.highlightVariants?.find(v => Number(v.scriptId) === scriptId);
        if (!target) throw new Error(`Chưa có kịch bản ${scriptId} để dựng.`);
        const exists = target.artifacts?.fastDraftVideoPath && await fs.access(target.artifacts.fastDraftVideoPath).then(() => true).catch(() => false);
        if (!exists) await dubbingService.renderHighlightFastDraft({ workspaceRoot: getWorkspaceRoot(), projectId, settings,
          project: { ...imported, analysis: { ...imported.analysis, activeVariantId: target.id, segments: target.segments } }, onProgress });
        rendered = await projectStore.getProject(getWorkspaceRoot(), projectId);
      } else rendered = await dubbingService.renderAllHighlightFastDraftVariants({
        workspaceRoot: getWorkspaceRoot(),
        projectId,
        settings,
        onVariantReady: async (project) => onProgress({ project, autoStoryDraftReady: true, percent: 85, step: "draft_ready", message: "Bản nháp đã sẵn sàng xem; tiếp tục xử lý các bản còn lại" }),
        reuseCompleted: Boolean(resumeRender),
        onProgress: (item) => onProgress({
          ...item,
          step: item.step || "auto_story_render",
          percent: 72 + Math.round(Number(item.percent || 0) * 0.22),
          message: item.message
        })
      });
      const reviewingProject = await projectStore.updateProject(getWorkspaceRoot(), projectId, { autoStoryState: { ...rendered.autoStoryState, phase: "reviewing" } });
      onProgress({ project: reviewingProject, percent: 94, step: "draft_audit", message: "Đang review video thật" });
      try {
        const audited = await service.auditDrafts({
          workspaceRoot: getWorkspaceRoot(),
          projectId,
          scriptId,
          signal: controller.signal,
          onDraft: async (project) => onProgress({ project, autoStoryDraftReady: true, percent: 96, step: "review_ready", message: "Đã có bản chỉnh sửa sau review" }),
          onProgress: (item) => onProgress({
            ...item,
            step: item.step || item.stage || "auto_story_audit",
            percent: 94 + Math.round(Number(item.percent || 0) * 0.06),
            message: item.message
          })
        });
        return { project: audited.project || rendered || imported, analysis, audits: audited.audits };
      } catch (auditError) {
        const latest = await projectStore.getProject(getWorkspaceRoot(), projectId);
        const projectWithWarning = await projectStore.updateProject(getWorkspaceRoot(), projectId, {
          analysis: {
            ...(latest.analysis || {}),
            warnings: [...(latest.analysis?.warnings || []), `Vertex draft audit chưa hoàn tất: ${auditError.message}`]
          },
          statusMessage: "Đã render draft; Vertex audit cần chạy lại"
        });
        onProgress({ percent: 100, step: "auto_story_audit", stage: "draft_audit", message: "Đã render draft; Vertex audit cần chạy lại" });
        return { project: projectWithWarning, analysis, audits: [], auditError: auditError.message };
      }
    } catch (error) {
      const latest = await projectStore.getProject(getWorkspaceRoot(), projectId);
      await projectStore.updateProject(getWorkspaceRoot(), projectId, { autoStoryState: {
        ...latest.autoStoryState, phase: latest.analysis?.highlightVariants?.length ? "render_failed" : "failed", error: error.message
      } });
      throw error;
    } finally {
      clearCancelToken(token);
    }
  });

  ipcMain.handle("autoStory:cancel", async () => {
    const cancelled = cancelActiveOperation("Đã dừng True Crime Auto Story theo yêu cầu của user.");
    return { cancelled };
  });

  ipcMain.handle("project:list", async () => projectStore.listProjects(getWorkspaceRoot()));

  ipcMain.handle("project:get", async (_event, projectId) => projectStore.getProject(getWorkspaceRoot(), projectId));

  ipcMain.handle("project:plan", async (_event, projectId) => {
    const settings = configStore.getSettings();
    return pipelineService.planProject({
      workspaceRoot: getWorkspaceRoot(),
      projectId,
      settings,
      onProgress: sendPipelineProgress
    });
  });

  ipcMain.handle("project:ingestDubbing", async (_event, projectId) => {
    const settings = configStore.getSettings();
    return dubbingService.ingestProject({
      workspaceRoot: getWorkspaceRoot(),
      projectId,
      settings,
      onProgress: sendPipelineProgress
    });
  });

  ipcMain.handle("project:translateDubbing", async (_event, projectId) => {
    const settings = configStore.getSettings();
    return dubbingService.translateProject({
      workspaceRoot: getWorkspaceRoot(),
      projectId,
      settings,
      onProgress: sendPipelineProgress
    });
  });

  ipcMain.handle("project:rewriteScript", async (_event, projectId) => {
    const settings = configStore.getSettings();
    return dubbingService.rewriteScriptProject({
      workspaceRoot: getWorkspaceRoot(),
      projectId,
      settings,
      onProgress: sendPipelineProgress
    });
  });

  ipcMain.handle("project:importStorytime", async (_event, projectId) => {
    const settings = configStore.getSettings();
    return dubbingService.importStorytimeProject({
      workspaceRoot: getWorkspaceRoot(),
      projectId,
      settings,
      onProgress: sendPipelineProgress
    });
  });

  ipcMain.handle("project:importHighlightCut", async (_event, projectId) => {
    const settings = configStore.getSettings();
    return dubbingService.importHighlightCutProject({
      workspaceRoot: getWorkspaceRoot(),
      projectId,
      settings,
      onProgress: sendPipelineProgress
    });
  });

  ipcMain.handle("project:importReviewedScript", async (_event, projectId, jsonPath) => {
    const settings = configStore.getSettings();
    return dubbingService.importReviewedScriptProject({
      workspaceRoot: getWorkspaceRoot(),
      projectId,
      settings,
      jsonPath
    });
  });

  ipcMain.handle("project:createGeminiDraftReviewPackage", async (_event, projectId) => (
    geminiDraftReviewService.createPackage({
      workspaceRoot: getWorkspaceRoot(),
      projectId,
      settings: configStore.getSettings()
    })
  ));

  ipcMain.handle("project:runConfiguredAiDraftReview", async (event, projectId, packageDir) => {
    if (configuredAiWorkflowService) {
      throw new Error("AI đang xử lý một tác vụ khác. Hãy đợi hoặc bấm Dừng.");
    }
    configuredAiWorkflowService = new ConfiguredAiWorkflowService(configStore.getSettings(), projectStore);
    try {
      return await configuredAiWorkflowService.runDraftReview({
        workspaceRoot: getWorkspaceRoot(),
        projectId,
        packageDir,
        onProgress: createPipelineProgressSender(event)
      });
    } finally {
      configuredAiWorkflowService = null;
    }
  });

  ipcMain.handle("project:getViralRepairContext", async (_event, projectId) => {
    return dubbingService.getViralRepairContext({
      workspaceRoot: getWorkspaceRoot(),
      projectId
    });
  });

  ipcMain.handle("project:diarizeDubbing", async (_event, projectId) => {
    const settings = configStore.getSettings();
    return dubbingService.diarizeProject({
      workspaceRoot: getWorkspaceRoot(),
      projectId,
      settings,
      onProgress: sendPipelineProgress
    });
  });

  ipcMain.handle("project:updateDubbingSegments", async (_event, projectId, segments) => {
    return dubbingService.updateSegments({
      workspaceRoot: getWorkspaceRoot(),
      projectId,
      segments
    });
  });

  ipcMain.handle("project:updatePlan", async (_event, projectId, analysis) => {
    return pipelineService.updateProjectPlan({
      workspaceRoot: getWorkspaceRoot(),
      projectId,
      analysis
    });
  });

  ipcMain.handle("project:updateSettings", async (_event, projectId, partial) => {
    return projectStore.updateProject(getWorkspaceRoot(), projectId, partial || {});
  });

  ipcMain.handle("project:reviewSceneScript", async (_event, projectId, segmentIndex) => {
    const settings = configStore.getSettings();
    return pipelineService.reviewSceneScript({
      workspaceRoot: getWorkspaceRoot(),
      projectId,
      segmentIndex,
      settings
    });
  });

  ipcMain.handle("project:rewriteFailedScenes", async (_event, projectId) => {
    const settings = configStore.getSettings();
    return pipelineService.rewriteFailedSceneScripts({
      workspaceRoot: getWorkspaceRoot(),
      projectId,
      settings
    });
  });

  ipcMain.handle("project:preview", async (_event, projectId) => {
    const settings = configStore.getSettings();
    return pipelineService.previewProject({
      workspaceRoot: getWorkspaceRoot(),
      projectId,
      settings,
      onProgress: sendPipelineProgress
    });
  });

  ipcMain.handle("project:openFolder", async (_event, projectId) => {
    const projectPaths = projectStore.getProjectPaths(getWorkspaceRoot(), projectId);
    await shell.openPath(projectPaths.rootDir);
    return true;
  });

  ipcMain.handle("project:openOutput", async (_event, projectId) => {
    const project = await projectStore.getProject(getWorkspaceRoot(), projectId);
    if (!project?.artifacts?.finalVideoPath) {
      return false;
    }
    await shell.showItemInFolder(project.artifacts.finalVideoPath);
    return true;
  });

  ipcMain.handle("voice:list", async (_event, provider) => {
    const settings = configStore.getSettings();
    return pipelineService.listVoices(settings, provider);
  });

  ipcMain.handle("voice:test", async (event, payload) => {
    const settings = configStore.getSettings();
    const provider = payload?.provider || settings.defaultVoiceProvider || "edge_neural";
    const sampleText = payload?.text || "Xin chào, đây là bản thử giọng thuyết minh cho video.";
    const outputExt = provider === "windows_local" || provider === "omnivoice" || provider === "kokoro" ? ".wav" : ".mp3";
    const outputPath = path.join(app.getPath("temp"), `cineviral-voice-test-${Date.now()}${outputExt}`);
    const sendVoiceProgress = (message) => {
      sendVoiceProgressSafe(event, {
        provider,
        message: String(message || "")
      });
    };

    if (provider === "elevenlabs") {
      const elevenLabs = new ElevenLabsService(settings.elevenLabsApiKey, settings.elevenLabsModel, settings);
      await elevenLabs.synthesizeSpeech({
        text: sampleText,
        voiceId: payload?.voiceId || settings.defaultVoiceId,
        outputPath,
        languageCode: payload?.language === "vi" || payload?.language === "auto" ? "vi" : payload?.language,
        performanceMode: "story",
        genreMode: payload?.genreMode || "thriller"
      });
    } else if (provider === "windows_local") {
      const windowsVoiceService = new WindowsVoiceService();
      await windowsVoiceService.synthesizeSpeech({
        text: sampleText,
        voiceName: payload?.voiceId || settings.defaultWindowsVoice || "",
        outputPath,
        rate: 0
      });
    } else if (provider === "omnivoice") {
      const omniVoice = new OmniVoiceService(settings);
      sendVoiceProgress("Đang thử giọng OmniVoice. Lần chạy đầu có thể mất vài phút để tải mô hình.");
      await omniVoice.synthesizeSpeech({
        text: payload?.text || "Đây là đoạn thử giọng ngắn của RecapTool Studio.",
        voiceName: payload?.voiceId || settings.omniVoiceInstruct || "",
        outputPath,
        language: payload?.language || "auto",
        numStep: 8,
        timeoutMs: 10 * 60 * 1000,
        onProgress: sendVoiceProgress
      });
      sendVoiceProgress("Đã tạo audio thử OmniVoice. Đang mở tệp WAV.");
    } else if (provider === "kokoro") {
      const kokoro = new KokoroVoiceService(settings);
      sendVoiceProgress("Đang tạo giọng Kokoro local.");
      await kokoro.synthesizeSpeech({
        text: sampleText,
        voiceName: payload?.voiceId || "af_heart",
        outputPath,
        language: payload?.language || "en",
        speed: settings.kokoroSpeed || 1,
        timeoutMs: 10 * 60 * 1000,
        onProgress: sendVoiceProgress
      });
      sendVoiceProgress("Đã tạo audio thử Kokoro.");
    } else {
      const edgeTts = new EdgeTtsService();
      await edgeTts.synthesizeSpeech({
        text: sampleText,
        voiceName: payload?.voiceId || "",
        outputPath,
        language: payload?.language || "auto",
        genreMode: payload?.genreMode || "thriller",
        rate: settings.edgeVoiceRate,
        pitch: settings.edgeVoicePitchHz,
        volume: settings.edgeVoiceVolume
      });
    }

    return { outputPath };
  });

  ipcMain.handle("voice:calibrate", async (event, payload) => {
    const settings = configStore.getSettings();
    return dubbingService.calibrateVoiceProfile({
      workspaceRoot: getWorkspaceRoot(),
      settings,
      payload,
      onProgress: (message) => sendVoiceProgressSafe(event, {
        provider: payload?.voiceProvider || settings.defaultVoiceProvider || "edge_neural",
        message: String(message || "")
      })
    });
  });

  ipcMain.handle("voice:getProfile", async (_event, payload) => {
    const settings = configStore.getSettings();
    return dubbingService.getVoiceProfileContext({
      workspaceRoot: getWorkspaceRoot(),
      settings,
      payload
    });
  });

  ipcMain.handle("video:probe", async (_event, videoPath) => {
    const settings = configStore.getSettings();
    const FfmpegService = require("./services/ffmpegService");
    const ffmpeg = new FfmpegService(settings);
    return await ffmpeg.probeVideo(videoPath);
  });

  ipcMain.handle("video:mirrorFlip", async (_event, payload) => {
    const inputPath = String(payload?.inputPath || "");
    const intervalSec = Math.max(0.5, Number(payload?.intervalSec || 3));
    if (!inputPath) {
      throw new Error("Missing input video path.");
    }
    const settings = configStore.getSettings();
    const FfmpegService = require("./services/ffmpegService");
    const ffmpeg = new FfmpegService(settings);
    await fs.mkdir(settings.exportRoot, { recursive: true });
    const outputPath = buildMirrorOutputPath(inputPath, intervalSec, settings);
    await ffmpeg.createMirrorFlipVideo({ inputPath, outputPath, intervalSec });
    return { outputPath, intervalSec };
  });

  ipcMain.handle("video:openOutputFile", async (_event, outputPath) => {
    if (!outputPath) {
      return false;
    }
    await shell.showItemInFolder(outputPath);
    return true;
  });

  ipcMain.handle("project:render", async (event, projectId) => {
    const settings = configStore.getSettings();
    const project = await projectStore.getProject(getWorkspaceRoot(), projectId);
    const token = createCancelToken("render");
    const job = await renderJobService.start({
      workspaceRoot: getWorkspaceRoot(),
      projectId,
      type: "final"
    });
    const onProgress = createPipelineProgressSender(event, {
      onNormalized: (payload) => renderJobService.progress(job.id, payload)
    });
    try {
      if (project.mode === "dubbing" || project.mode === "script_rewrite" || project.mode === "satisfying_storytime" || project.mode === "highlight_cut") {
        return await dubbingService.renderProject({
          workspaceRoot: getWorkspaceRoot(),
          projectId,
          settings,
          onProgress
        });
      }
      return await pipelineService.renderProject({
        workspaceRoot: getWorkspaceRoot(),
        projectId,
        settings,
        onProgress
      });
    } catch (error) {
      await renderJobService.finish(job.id, token.cancelled ? "cancelled" : "failed", error.message, {
        workspaceRoot: getWorkspaceRoot(),
        projectId
      });
      throw error;
    } finally {
      await renderJobService.finish(job.id, token.cancelled ? "cancelled" : "completed", "", {
        workspaceRoot: getWorkspaceRoot(),
        projectId
      }).catch(() => {});
      clearCancelToken(token);
    }
  });

  ipcMain.handle("project:resumeRender", async (event, projectId) => {
    const settings = configStore.getSettings();
    const project = await projectStore.getProject(getWorkspaceRoot(), projectId);
    const interrupted = await renderJobService.prepareResume({
      workspaceRoot: getWorkspaceRoot(),
      projectId
    });
    const token = createCancelToken(`resume:${interrupted.type}`);
    const job = await renderJobService.start({
      workspaceRoot: getWorkspaceRoot(),
      projectId,
      type: interrupted.type || "final",
      resumedFrom: interrupted
    });
    const onProgress = createPipelineProgressSender(event, {
      onNormalized: (payload) => renderJobService.progress(job.id, payload)
    });
    try {
      if (interrupted.type === "highlight_variants") {
        return await dubbingService.renderAllHighlightCutVariants({
          workspaceRoot: getWorkspaceRoot(),
          projectId,
          settings,
          onProgress
        });
      }
      if (["dubbing", "script_rewrite", "satisfying_storytime", "highlight_cut"].includes(project.mode)) {
        return await dubbingService.renderProject({
          workspaceRoot: getWorkspaceRoot(),
          projectId,
          settings,
          onProgress
        });
      }
      return await pipelineService.renderProject({
        workspaceRoot: getWorkspaceRoot(),
        projectId,
        settings,
        onProgress
      });
    } catch (error) {
      await renderJobService.finish(job.id, token.cancelled ? "cancelled" : "failed", error.message, {
        workspaceRoot: getWorkspaceRoot(),
        projectId
      });
      throw error;
    } finally {
      await renderJobService.finish(job.id, token.cancelled ? "cancelled" : "completed", "", {
        workspaceRoot: getWorkspaceRoot(),
        projectId
      }).catch(() => {});
      clearCancelToken(token);
    }
  });

  ipcMain.handle("project:cancelRender", async () => cancelActiveOperation("Đã dừng xuất video theo yêu cầu của user."));

  ipcMain.handle("project:audioPlan", async (_event, projectId) => {
    const settings = configStore.getSettings();
    return dubbingService.buildAudioPlan({
      workspaceRoot: getWorkspaceRoot(),
      projectId,
      settings
    });
  });

  ipcMain.handle("project:renderSegmentVoice", async (_event, projectId, segmentIndex) => {
    const settings = configStore.getSettings();
    return dubbingService.renderSegmentVoice({
      workspaceRoot: getWorkspaceRoot(),
      projectId,
      segmentIndex,
      settings,
      openOutput: async (outputPath) => shell.openPath(outputPath)
    });
  });

  ipcMain.handle("project:renderSegmentPreview", async (_event, projectId, segmentIndex) => {
    const settings = configStore.getSettings();
    const project = await projectStore.getProject(getWorkspaceRoot(), projectId);
    if (project.mode === "highlight_cut") {
      return dubbingService.renderHighlightSegmentPreview({
        workspaceRoot: getWorkspaceRoot(),
        projectId,
        segmentIndex,
        settings,
        openOutput: async (outputPath) => shell.openPath(outputPath)
      });
    }
    return dubbingService.renderStorytimeSegmentPreview({
      workspaceRoot: getWorkspaceRoot(),
      projectId,
      segmentIndex,
      settings,
      openOutput: async (outputPath) => shell.openPath(outputPath)
    });
  });

  ipcMain.handle("project:renderFastDraft", async (event, projectId) => {
    const settings = configStore.getSettings();
    const project = await projectStore.getProject(getWorkspaceRoot(), projectId);
    const onProgress = createPipelineProgressSender(event);
    if (project.mode === "highlight_cut") {
      return dubbingService.renderHighlightFastDraft({
        workspaceRoot: getWorkspaceRoot(),
        projectId,
        settings,
        onProgress
      });
    }
    return dubbingService.renderStorytimeFastDraft({
      workspaceRoot: getWorkspaceRoot(),
      projectId,
      settings,
      onProgress,
      openOutput: async (outputPath) => shell.openPath(outputPath)
    });
  });

  ipcMain.handle("project:renderHighlightDraftVariants", async (event, projectId) => {
    const settings = configStore.getSettings();
    const token = createCancelToken("renderHighlightDraftVariants");
    const onProgress = createPipelineProgressSender(event);
    try {
      return await dubbingService.renderAllHighlightFastDraftVariants({
        workspaceRoot: getWorkspaceRoot(),
        projectId,
        settings,
        onProgress
      });
    } finally {
      clearCancelToken(token);
    }
  });

  ipcMain.handle("project:renderHighlightVariants", async (event, projectId) => {
    const settings = configStore.getSettings();
    const token = createCancelToken("renderHighlightVariants");
    const job = await renderJobService.start({
      workspaceRoot: getWorkspaceRoot(),
      projectId,
      type: "highlight_variants"
    });
    const onProgress = createPipelineProgressSender(event, {
      onNormalized: (payload) => renderJobService.progress(job.id, payload)
    });
    try {
      return await dubbingService.renderAllHighlightCutVariants({
        workspaceRoot: getWorkspaceRoot(),
        projectId,
        settings,
        onProgress
      });
    } catch (error) {
      await renderJobService.finish(job.id, token.cancelled ? "cancelled" : "failed", error.message, {
        workspaceRoot: getWorkspaceRoot(),
        projectId
      });
      throw error;
    } finally {
      await renderJobService.finish(job.id, token.cancelled ? "cancelled" : "completed", "", {
        workspaceRoot: getWorkspaceRoot(),
        projectId
      }).catch(() => {});
      clearCancelToken(token);
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  manualAntigravityStage1Service?.cancel();
  OmniVoiceService.shutdownPersistentWorkers?.();
  KokoroVoiceService.shutdownPersistentWorkers?.();
  LocalTranslationService.shutdownPersistentWorkers?.();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
