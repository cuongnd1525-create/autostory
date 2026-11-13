const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const assert = require("assert/strict");
const fs = require("fs/promises");
const Config = require("../electron/services/configStore");

const root = path.resolve(__dirname, "../.tmp/ai-model-settings-ui-check");
app.setPath("userData", path.join(root, "user-data"));

const errors = [];
const listCalls = [];

ipcMain.handle("recap-ui-check", (_event, method, args) => {
  const testSettings = {
    ...new Config("unused", root).getDefaultSettings(),
    aiProvider: "vertex_ai",
    vertexProjectId: "test-proj-001",
    vertexLocation: "global",
    geminiApiKey: "test-key-001",
    vertexEconomyModel: "gemini-2.5-flash-lite",
    vertexAnalysisModel: "gemini-3.8-flash",
    vertexQualityModel: "gemini-3.8-flash",
    geminiModel: "gemini-3.8-flash"
  };
  if (method === "bootstrap") {
    return { settings: testSettings, projects: [], recoverableRenderJobs: [] };
  }
  if (method === "getSettings") {
    return testSettings;
  }
  if (method === "listVertexModels") {
    listCalls.push({ provider: "vertex", payload: args[0] || {} });
    return {
      projectId: args[0]?.vertexProjectId || "test-proj-001",
      location: args[0]?.vertexLocation || "global",
      models: [
        { value: "gemini-4-argon", label: "gemini-4-argon", launchStage: "GA" },
        { value: "gemini-3.8-flash", label: "gemini-3.8-flash", launchStage: "GA" },
        { value: "gemini-3.5-flash-lite", label: "gemini-3.5-flash-lite", launchStage: "GA" },
        { value: "gemini-3.1-pro-preview", label: "gemini-3.1-pro-preview (Preview)", launchStage: "PUBLIC_PREVIEW" }
      ]
    };
  }
  if (method === "listGeminiModels") {
    listCalls.push({ provider: "gemini", payload: args[0] || {} });
    return {
      models: [
        { value: "gemini-3.8-flash", label: "gemini-3.8-flash" },
        { value: "gemini-2.5-pro", label: "gemini-2.5-pro" }
      ]
    };
  }
  if (method === "listProjects" || method === "listRecoverableRenderJobs" || method === "listTtsModels" || method === "listLocalTranslationModels") {
    return [];
  }
  return {};
});

app.whenReady().then(async () => {
  await fs.mkdir(root, { recursive: true });
  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, "verify-recap-ui-preload.cjs"),
      sandbox: false,
      contextIsolation: false,
      nodeIntegration: false
    }
  });
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });

  await win.loadFile(path.resolve(__dirname, "../src/index.html"));
  await win.webContents.executeJavaScript("new Promise((resolve) => setTimeout(resolve, 400))");
  assert.deepEqual(errors, [], "renderer bootstrap must not throw");

  const vertexState = await win.webContents.executeJavaScript(`(async () => {
    document.getElementById("open-settings").click();
    await new Promise((r) => setTimeout(r, 250));
    const economySelect = document.getElementById("vertex-economy-model");
    const reviewSelect = document.getElementById("vertex-auto-story-review-model");
    const economyThinking = document.getElementById("vertex-economy-thinking-level");
    const analysisThinking = document.getElementById("vertex-analysis-thinking-level");
    const qualityThinking = document.getElementById("vertex-quality-thinking-level");
    const statusText = document.getElementById("vertex-models-status").textContent;
    const statusWarn = document.getElementById("vertex-models-status").classList.contains("is-warning");
    const optionValues = [...economySelect.options].map((o) => o.value);
    const reviewValues = [...reviewSelect.options].map((o) => o.value);
    economySelect.value = "gemini-3.5-flash-lite";
    reviewSelect.value = "gemini-3.1-pro-preview";
    economyThinking.value = "low";
    analysisThinking.value = "medium";
    qualityThinking.value = "high";
    const readBack = readSettings();
    return {
      economyTag: economySelect.tagName,
      reviewTag: reviewSelect.tagName,
      thinkingTag: qualityThinking.tagName,
      statusText,
      statusWarn,
      optionValues,
      reviewValues,
      savedEconomy: readBack.vertexEconomyModel,
      savedReview: readBack.vertexAutoStoryReviewModel,
      savedEconomyThinking: readBack.vertexEconomyThinkingLevel,
      savedAnalysisThinking: readBack.vertexAnalysisThinkingLevel,
      savedQualityThinking: readBack.vertexQualityThinkingLevel
    };
  })()`);

  assert.equal(vertexState.economyTag, "SELECT");
  assert.equal(vertexState.reviewTag, "SELECT");
  assert.equal(vertexState.thinkingTag, "SELECT");
  assert.equal(vertexState.statusWarn, true, "unavailable legacy model should trigger warning banner");
  assert.match(vertexState.statusText, /gemini-2\.5-flash-lite/);
  assert.ok(vertexState.optionValues.includes("gemini-3.8-flash"));
  assert.ok(vertexState.optionValues.includes("gemini-2.5-flash-lite"), "unavailable saved model stays visible with warning label");
  assert.equal(vertexState.reviewValues[0], "", "Auto Story override keeps inherit option first");
  assert.equal(vertexState.savedEconomy, "gemini-3.5-flash-lite");
  assert.equal(vertexState.savedReview, "gemini-3.1-pro-preview");
  assert.equal(vertexState.savedEconomyThinking, "low");
  assert.equal(vertexState.savedAnalysisThinking, "medium");
  assert.equal(vertexState.savedQualityThinking, "high");

  const geminiState = await win.webContents.executeJavaScript(`(async () => {
    const provider = document.getElementById("ai-provider");
    provider.value = "gemini";
    provider.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 250));
    const select = document.getElementById("gemini-model");
    const thinkingSelect = document.getElementById("gemini-thinking-level");
    const values = [...select.options].map((o) => o.value);
    const statusText = document.getElementById("gemini-models-status").textContent;
    select.value = "gemini-2.5-pro";
    thinkingSelect.value = "high";
    const s = readSettings();
    return {
      tag: select.tagName,
      thinkingTag: thinkingSelect.tagName,
      values,
      statusText,
      selected: s.geminiModel,
      thinking: s.geminiThinkingLevel
    };
  })()`);

  assert.equal(geminiState.tag, "SELECT");
  assert.equal(geminiState.thinkingTag, "SELECT");
  assert.deepEqual(geminiState.values, ["gemini-3.8-flash", "gemini-2.5-pro"]);
  assert.match(geminiState.statusText, /Có 2 model khả dụng/);
  assert.equal(geminiState.selected, "gemini-2.5-pro");
  assert.equal(geminiState.thinking, "high");

  for (const width of [1400, 800, 480]) {
    win.setContentSize(width, 900);
    await win.webContents.executeJavaScript("new Promise((r) => setTimeout(r, 100))");
    const bounds = await win.webContents.executeJavaScript(`(() => {
      const provider = document.getElementById("ai-provider");
      provider.value = "vertex_ai";
      syncAiProviderSettingsUi();
      const details = document.querySelector('[data-ai-provider-settings="vertex_ai"] details');
      details.open = true;
      const economy = document.getElementById("vertex-economy-model");
      const review = document.getElementById("vertex-auto-story-review-model");
      const btn = document.getElementById("refresh-vertex-models");
      const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, right: r.right, height: r.height }; };
      economy.scrollIntoView();
      const er = box(economy);
      review.scrollIntoView();
      const rr = box(review);
      btn.scrollIntoView();
      const br = box(btn);
      return { vw: window.innerWidth, er, rr, br };
    })()`);
    assert(bounds.er.width > 100 && bounds.er.x >= 0 && bounds.er.right <= bounds.vw, `economy bounds overflow at ${width}: ${JSON.stringify(bounds)}`);
    assert(bounds.rr.width > 100 && bounds.rr.x >= 0 && bounds.rr.right <= bounds.vw, `review bounds overflow at ${width}: ${JSON.stringify(bounds)}`);
    assert(bounds.br.x >= 0 && bounds.br.right <= bounds.vw, `refresh button overflow at ${width}: ${JSON.stringify(bounds)}`);
  }

  assert.deepEqual(errors, []);
  console.log("verify-ai-model-settings-ui passed: Electron settings dropdowns load account models, warn on unavailable legacy model, persist readSettings(), and fit [1400, 800, 480].");
  win.destroy();
  await fs.rm(root, { recursive: true, force: true });
  app.quit();
}).catch(async (error) => {
  console.error(error);
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  app.exit(1);
});
