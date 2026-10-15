const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const assert = require("assert/strict");
const fs = require("fs/promises");
const Config = require("../electron/services/configStore");
const root = path.resolve(__dirname, "../.tmp/recap-ui-check");
app.setPath("userData", path.join(root, "user-data"));
const calls = [], errors = [];
const sample = path.resolve(__dirname, "../.tmp/recap-presentation-check/renderDraft-fit_blur-phrase.mp4");
const project = { id: "ui-fixture", title: "Recap UI check", mode: "recap", status: "editorial_ready", targetDurationSec: 75,
  sourceVideoPath: sample, segments: [], artifacts: {}, recapAspectRatio: "9:16", recapCaptionStyle: "phrase",
  recapEditorial: { selectedAngleId: "a1", selectedHookId: "h1", angles: [{ id: "a1", title: "Góc kể đã có bằng chứng", score: 9 }],
    hooks: [1, 2, 3].map((id) => ({ id: `h${id}`, text: `Hook thử số ${id}`, durationSec: 4.2, score: 9, videoPath: sample })) } };
ipcMain.handle("recap-ui-check", (_event, method, args) => {
  calls.push({ method, args });
  if (method === "bootstrap") return { settings: new Config("unused", root).getDefaultSettings(), projects: [], recoverableRenderJobs: [] };
  if (method === "getProject") return project;
  if (method === "updateProjectSettings") { Object.assign(project, args[1]); return project; }
  if (method === "runRecap") { project.status = "quality_blocked"; project.recap = { status: "quality_blocked", draftVideoPath: sample, speechUnits: [{ text: "Narration preview fixture" }], qualityIssues: [{ severity: "high", description: "Test review blocker" }] }; return { status: "quality_blocked", blockers: project.recap.qualityIssues }; }
  if (method === "checkSettings") return { checks: [], results: [] };
  return [];
});
app.whenReady().then(async () => {
  await fs.mkdir(root, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 1500, height: 1000, webPreferences: { preload: path.join(__dirname, "verify-recap-ui-preload.cjs"), sandbox: false, contextIsolation: false, nodeIntegration: false } });
  win.webContents.on("console-message", (_event, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(path.resolve(__dirname, "../src/index.html"));
  await win.webContents.executeJavaScript(`new Promise(resolve => setTimeout(resolve, 300))`);
  assert.deepEqual(errors, [], "renderer bootstrap must not throw");
  const data = await win.webContents.executeJavaScript(`(async () => {
    selectSetupMode('recap', {persist:false});
    document.getElementById('recap-duration-preset').value='75'; document.getElementById('recap-duration-preset').dispatchEvent(new Event('change'));
    const duration = document.getElementById('target-duration').value;
    document.getElementById('recap-narration-language').value='vi'; writeSetupDraft(); document.getElementById('recap-narration-language').value='en'; applySetupDraft();
    const language = document.getElementById('recap-narration-language').value;
    showStudio(${JSON.stringify(project)});
    const hookCount = document.querySelectorAll('.recap-hook-card video').length;
    document.querySelector('input[name="recap-hook-choice"][value="h2"]').checked=true;
    document.getElementById('recap-confirm-editorial').click(); await new Promise(resolve => setTimeout(resolve,100));
    const blocked = document.getElementById('recap-quality-status').textContent;
    document.getElementById('recap-studio-language').value='vi'; document.getElementById('recap-apply-prefs').click(); await new Promise(resolve=>setTimeout(resolve,100));
    return {duration,language,hookCount,blocked, preview:getPreviewVideoPath(state.currentProject),script:document.getElementById('recap-script-preview').textContent};
  })()`);
  assert.equal(data.duration, "75"); assert.equal(data.language, "vi"); assert.equal(data.hookCount, 3); assert.match(data.blocked, /Test review blocker/);
  assert.equal(data.preview, sample); assert.match(data.script, /Narration preview fixture/);
  assert.ok(calls.some((c) => c.method === "chooseRecapEditorial" && c.args[1].hookId === "h2" && c.args[1].approve));
  assert.ok(calls.some((c) => c.method === "updateProjectSettings" && c.args[1].recapNarrationLanguage === "vi"));
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(root, "studio.png"), (await win.webContents.capturePage()).toPNG());
  console.log("Recap UI passed: presets, saved preferences, three video previews, hook selection, quality blocker and settings actions.");
  await fs.writeFile(path.join(root, "result.json"), JSON.stringify({ passed: true, data, calls, errors }, null, 2));
  win.destroy(); app.quit();
}).catch(async (error) => { console.error(error.stack); await fs.writeFile(path.join(root, "result.json"), JSON.stringify({ passed: false, error: error.stack, errors, calls }, null, 2)); app.exit(1); });
