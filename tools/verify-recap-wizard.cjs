const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const assert = require("assert/strict");
const Config = require("../electron/services/configStore");
const currentModels = require("../electron/services/antigravityModelDiscovery").parseModels(`gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)`);
const root = path.resolve(__dirname, "../.tmp/recap-wizard-check");
app.setPath("userData", path.join(root, "user-data"));
const sample = path.resolve(__dirname, "../.tmp/recap-presentation-check/renderDraft-fit_blur-phrase.mp4");
const calls = [], errors = []; let project, blocked = false, unavailable = false;
let testSettings = { ...new Config("unused", root).getDefaultSettings(), aiProvider: "antigravity_cli", vertexCredentialPath: "fixture-credential.json" };
const editorial = { selectedAngleId: "a1", selectedHookId: "h1", angles: [1, 2].map((id) => ({ id: `a${id}`, title: `Góc kể ${id}`, central_question: "Chuyện gì đã xảy ra?", score: 9 })),
  hooks: [1, 2, 3].map((id) => ({ id: `h${id}`, text: `Hook thử ${id}`, durationSec: 4, score: 9, videoPath: sample })) };
ipcMain.handle("recap-ui-check", (_event, method, args) => {
  calls.push({ method, args });
  if (method === "bootstrap") return { settings: testSettings, projects: [], recoverableRenderJobs: [] };
  if (method === "saveSettings") { testSettings = { ...testSettings, ...args[0] }; return testSettings; }
  if (method === "checkSettings") return { checks: [], results: [] };
  if (method === "getAntigravityModels") return { models: currentModels };
  if (method === "createProject") { project = { ...args[0], id: "wizard-fixture", artifacts: {}, recap: {}, segments: [] }; return { project, projects: [project] }; }
  if (method === "getProject") return project;
  if (method === "updateProjectSettings") { Object.assign(project, args[1]); return project; }
  if (method === "chooseRecapEditorial") {
    project.recapEditorial.selectedAngleId = args[1].angleId; project.recapEditorial.selectedHookId = args[1].hookId;
    project.recapEditorialApprovedKey = args[1].approve ? "approved" : ""; return project;
  }
  if (method === "runRecap") {
    if (unavailable) throw new Error("Antigravity đang hết công suất (503). Checkpoint đã giữ lại.");
    if (!project.recapEditorialApprovedKey) { project.recapEditorial = JSON.parse(JSON.stringify(editorial)); project.status = "editorial_ready"; return { status: "editorial_ready", editorial: project.recapEditorial }; }
    const status = blocked ? "quality_blocked" : "review_ready";
    project.status = status; project.recap = { status, draftVideoPath: sample, speechUnits: [{ text: "Narration for the selected hook." }],
      duration: { actual: 74, target: 75 }, qualityScore: blocked ? .5 : .85, qualityIssues: blocked ? [{ severity: "high", description: "Wizard review blocker" }] : [] };
    return { status, draftVideoPath: sample };
  }
  if (method === "renderRecapFinal") {
    assert.equal(project.recap.status, "review_ready"); project.recap.status = "completed"; project.status = "completed"; project.recap.finalVideoPath = sample;
    return { status: "completed", finalVideoPath: sample };
  }
  if (method === "listProjects") return project ? [project] : [];
  if (method === "listVoices") return [{ voice_id: "vi-VN-NamMinhNeural", name: "Nam Minh" }, { voice_id: "en-US-ChristopherNeural", name: "Christopher" }];
  return [];
});
app.whenReady().then(async () => {
  await fs.mkdir(root, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 1900, height: 1080, webPreferences: { preload: path.join(__dirname, "verify-recap-ui-preload.cjs"), sandbox: false, contextIsolation: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (_event, level, message) => { if (level >= 3) errors.push(message); });
  await win.webContents.session.clearStorageData({ storages: ["localstorage"] });
  await win.loadFile(path.resolve(__dirname, "../src/index.html"));
  await win.webContents.executeJavaScript(`new Promise(resolve => setTimeout(resolve, 350))`);
  assert.deepEqual(errors, []);
  const setup = await win.webContents.executeJavaScript(`(async () => {
    const originalInput=document.getElementById('source-video-path');
    const moved=originalInput.closest('[data-recap-step]')?.dataset.recapStep;
    const missing=validateCurrentStep();
    originalInput.value=${JSON.stringify(sample)}; document.getElementById('project-title').value='Wizard verification';
    state.currentStep=2; renderSteps(); document.querySelector('[data-recap-duration="75"]').click();
    document.getElementById('recap-editorial-selection').value='manual'; document.getElementById('recap-workflow-mode').value='review';
    document.getElementById('recap-narration-language').value='vi'; document.getElementById('recap-narration-language').dispatchEvent(new Event('change',{bubbles:true}));
    state.currentStep=3; renderSteps(); const selectedVoice=readProjectPayload().voiceId;
    document.getElementById('recap-voice-provider').value='kokoro';
    const incompatible=validateCurrentStep();
    document.getElementById('recap-voice-provider').value='edge_neural'; document.getElementById('recap-voice-provider').dispatchEvent(new Event('change',{bubbles:true}));
    state.currentStep=2; renderSteps();
    selectSetupMode('dubbing',{persist:false}); state.currentStep=4; renderSteps();
    const restored=originalInput.closest('[data-step-panel]')?.dataset.stepPanel;
    selectSetupMode('recap',{persist:false}); state.currentStep=2; renderSteps();
    return {moved,missing,incompatible,restored,same:originalInput===document.getElementById('source-video-path'),selectedVoice,ids:[...document.querySelectorAll('[id]')].map(n=>n.id)};
  })()`);
  assert.equal(setup.moved, "1"); assert.equal(setup.restored, "4"); assert.equal(setup.same, true); assert.equal(setup.missing, false); assert.equal(setup.incompatible, false);
  assert.equal(setup.selectedVoice, "vi-VN-NamMinhNeural"); assert.equal(new Set(setup.ids).size, setup.ids.length, "no duplicate fields");
  const inventoryUi = await win.webContents.executeJavaScript(`(async()=>{
    fillAntigravityModelSelects('gemini-3.7-flash-high','high'); await refreshAntigravityModels({force:true});
    const values=[...document.getElementById('antigravity-model').options].map(option=>option.value);
    const stale=document.getElementById('antigravity-model').selectedOptions[0].textContent;
    document.getElementById('antigravity-model').value='gemini-3.8-flash'; fillAntigravityReasoningSelect('gemini-3.8-flash','low');
    return {values,stale,selected:readAntigravityModelSelects(),status:document.getElementById('antigravity-models-status').textContent};
  })()`);
  assert.ok(!inventoryUi.values.includes('gemini-3.7-flash') && !inventoryUi.values.includes('gemini-3.1-pro'));
  assert.match(inventoryUi.stale,/không có trong danh sách agy/); assert.equal(inventoryUi.selected.antigravityModel,'gemini-3.8-flash-low'); assert.match(inventoryUi.status,/6 model/);
  const geometry = [];
  for (const width of [1900, 1200, 1000, 800, 500]) {
    win.setSize(width, 1080);
    await win.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,70))`);
    const size = await win.webContents.executeJavaScript(`(() => {
      const pane=document.getElementById('setup-activity-panel').getBoundingClientRect();
      const summary=document.getElementById('recap-setup-summary').getBoundingClientRect();
      const active=document.querySelector('[data-recap-step="2"]');
      return {width:innerWidth, rightGap:innerWidth-pane.right, summaryLeft:summary.left, activityLeft:pane.left,
        summaryRight:summary.right,activityRight:pane.right,summaryBottom:summary.bottom,activityTop:pane.top,
        horizontalOverflow:document.documentElement.scrollWidth-innerWidth,
        fieldOverflow:active.scrollWidth-active.clientWidth,footerPosition:getComputedStyle(document.querySelector('.setup-footer')).position,
        labels:[...document.querySelectorAll('.wizard-step')].map(n=>n.textContent.trim())};
    })()`);
    geometry.push(size); assert.ok(size.horizontalOverflow < 3); assert.ok(size.fieldOverflow < 3); assert.equal(size.footerPosition, "static");
    if (width >= 1000) assert.ok(size.rightGap < 34, `activity pane right gap ${size.rightGap}`);
    assert.ok(Math.abs(size.summaryLeft-size.activityLeft)<2 && Math.abs(size.summaryRight-size.activityRight)<2,"summary and activity share one vertical column");
    assert.ok(size.activityTop>=size.summaryBottom,"activity appears below the video summary");
    await fs.writeFile(path.join(root, `step2-${width}.png`), (await win.webContents.capturePage()).toPNG());
  }
  win.setSize(1900, 1080);
  const waiting = await win.webContents.executeJavaScript(`(async()=>{
    state.currentStep=4; renderSteps();
    window.__recapPending=recapSetupUi.perform(()=>new Promise((_resolve,reject)=>{window.__recapFail=reject;}));
    const started=Date.now()-120000,activity=Date.now()-90000;
    window.__recapTestProgress({stage:'hierarchical_analysis',chunkIndex:2,chunkCount:3,percent:30,message:'Đang xem chunk 2'});
    window.__recapTestProgress({stage:'hierarchical_analysis',chunkIndex:2,chunkCount:3,aiRequestStarted:true,heartbeat:true,aiStartedAt:started,providerLabel:'Antigravity CLI'});
    window.__recapTestProgress({stage:'hierarchical_analysis',chunkIndex:2,chunkCount:3,heartbeat:true,aiStartedAt:started,lastActivityAt:activity,aiTimeoutMs:900000,inactivityTimeoutMs:600000,pid:12345,model:'gemini-3.8-flash-low'});
    return {stage:document.getElementById('recap-run-stage').textContent,wait:document.getElementById('recap-run-wait').textContent,
      detail:document.getElementById('recap-run-detail').textContent,header:document.getElementById('sidecar-status').textContent,timing:document.getElementById('recap-run-timing').textContent,
      busy:state.busy,stopEnabled:!document.getElementById('recap-run-stop').disabled,
      lastActivityAt:recapSetupUi.runtime.lastActivityAt,activity,
      visible:!document.getElementById('recap-run-status').classList.contains('hidden'),outcome:document.getElementById('recap-run-status').dataset.outcome};
  })()`);
  assert.match(waiting.stage, /AI phân tích.*Chunk 2\/3/); assert.match(waiting.wait, /1:30/);
  assert.match(waiting.wait, /chưa thể kết luận/); assert.equal(waiting.detail, "Đang xem chunk 2");
  assert.equal(waiting.lastActivityAt, waiting.activity); assert.equal(waiting.header, "Recap: Đang xử lý");
  assert.match(waiting.timing, /gemini-3\.8-flash-low/);
  assert.equal(waiting.visible, true); assert.equal(waiting.busy, true); assert.equal(waiting.stopEnabled, true); assert.equal(waiting.outcome, "running");
  await fs.writeFile(path.join(root, "step4-processing.png"), (await win.webContents.capturePage()).toPNG());
  const failed = await win.webContents.executeJavaScript(`(async()=>{
    window.__recapFail(new Error('Antigravity không có phản hồi trong 600s')); await window.__recapPending;
    return {stage:document.getElementById('recap-run-stage').textContent,detail:document.getElementById('recap-run-detail').textContent,
      busy:state.busy,timerStopped:!recapSetupUi.runtime.running,outcome:document.getElementById('recap-run-status').dataset.outcome};
  })()`);
  assert.equal(failed.outcome, "error"); assert.equal(failed.stage, "Xử lý thất bại"); assert.match(failed.detail, /600s/);
  assert.equal(failed.busy, false); assert.equal(failed.timerStopped, true);
  unavailable = true;
  const outage = await win.webContents.executeJavaScript(`(async()=>{
    state.currentStep=4; renderSteps(); await recapSetupUi.next(4);
    return {projectId:recapSetupUi.project.id,stage:document.getElementById('recap-run-stage').textContent,
      visible:!document.getElementById('recap-provider-recovery').classList.contains('hidden'),
      note:document.getElementById('recap-provider-recovery-note').textContent,
      buttonVisible:!document.getElementById('recap-resume-vertex').classList.contains('hidden'),provider:state.settings.aiProvider};
  })()`);
  assert.equal(outage.visible,true); assert.equal(outage.buttonVisible,true); assert.match(outage.stage,/Antigravity chưa sẵn sàng/);
  assert.match(outage.note,/phí Google Cloud/); assert.equal(outage.provider,'antigravity_cli');
  assert.equal(calls.filter(c=>c.method==='saveSettings').length,0,"outage cannot silently select a paid provider");
  await win.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,150))`);
  await fs.writeFile(path.join(root,'step4-provider-outage.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
  const missingCredential = await win.webContents.executeJavaScript(`(() => {
    const saved=state.settings; state.settings={...saved,vertexCredentialPath:'',vertexProjectId:''}; recapSetupUi.renderRuntime();
    const result={vertexHidden:document.getElementById('recap-resume-vertex').classList.contains('hidden'),
      settingsVisible:!document.getElementById('recap-provider-settings').classList.contains('hidden')};
    document.getElementById('recap-provider-settings').click(); result.settingsOpened=!document.getElementById('settings-modal').classList.contains('hidden');
    document.getElementById('settings-modal').classList.add('hidden'); state.settings=saved; recapSetupUi.renderRuntime(); return result;
  })()`);
  assert.equal(missingCredential.vertexHidden,true); assert.equal(missingCredential.settingsVisible,true); assert.equal(missingCredential.settingsOpened,true);
  const createsBefore=calls.filter(c=>c.method==='createProject').length;
  unavailable=false;
  const recovered=await win.webContents.executeJavaScript(`(async()=>{
    document.getElementById('recap-resume-vertex').click(); await recapSetupUi.recoveryPromise;
    return {provider:state.settings.aiProvider,projectId:recapSetupUi.project.id,status:recapSetupUi.result?.status,
      recoveryHidden:document.getElementById('recap-provider-recovery').classList.contains('hidden'),busy:state.busy};
  })()`);
  assert.equal(recovered.provider,'vertex_ai'); assert.equal(recovered.projectId,outage.projectId);
  assert.equal(recovered.status,'editorial_ready'); assert.equal(recovered.busy,false); assert.equal(recovered.recoveryHidden,true);
  assert.equal(calls.filter(c=>c.method==='createProject').length,createsBefore,"resume must not create a replacement project");
  assert.deepEqual(calls.find(c=>c.method==='saveSettings').args,[{aiProvider:'vertex_ai'}],"only the provider preference changes");
  const pipeline = await win.webContents.executeJavaScript(`(async()=>{
    state.currentStep=4; renderSteps(); await recapSetupUi.next(4);
    const hookCount=document.querySelectorAll('#recap-setup-hooks video').length,stepAfterAnalysis=state.currentStep;
    document.querySelector('input[name="recap-setup-hook"][value="h2"]').checked=true;
    await recapSetupUi.next(5); const stepAfterDraft=state.currentStep,ready=recapSetupUi.canExport();
    document.querySelector('[data-recap-step="6"] details').open=true;
    return {hookCount,stepAfterAnalysis,stepAfterDraft,ready,quality:document.getElementById('recap-setup-quality').textContent};
  })()`);
  assert.equal(pipeline.hookCount, 3); assert.equal(pipeline.stepAfterAnalysis, 5); assert.equal(pipeline.stepAfterDraft, 6); assert.equal(pipeline.ready, true);
  assert.ok(calls.some((c) => c.method === "chooseRecapEditorial" && c.args[1].hookId === "h2" && c.args[1].approve));
  await fs.writeFile(path.join(root, "step6-review.png"), (await win.webContents.capturePage()).toPNG());
  blocked = true;
  const rejected = await win.webContents.executeJavaScript(`(async()=>{
    await recapSetupUi.perform(()=>recapSetupUi.run({recapRecheck:true,recapWorkflow:'review'}));
    const before=recapSetupUi.result.status; await recapSetupUi.next(6);
    return {before,exportable:recapSetupUi.canExport(),blocked:document.getElementById('recap-setup-quality').textContent};
  })()`);
  assert.equal(rejected.before, "quality_blocked"); assert.equal(rejected.exportable, false); assert.match(rejected.blocked, /Wizard review blocker/);
  assert.equal(calls.filter((c) => c.method === "renderRecapFinal").length, 0);
  blocked = false;
  await win.webContents.executeJavaScript(`(async()=>{ await recapSetupUi.perform(()=>recapSetupUi.run({recapRecheck:true,recapWorkflow:'review'})); await recapSetupUi.next(6); })()`);
  assert.equal(calls.filter((c) => c.method === "renderRecapFinal").length, 1);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(root, "result.json"), JSON.stringify({ passed: true, setup, inventoryUi, geometry, waiting, failed, pipeline, rejected, calls }, null, 2));
  console.log("Guided recap wizard passed: responsive layout, right edge, mode restoration, voice compatibility, explicit provider recovery on the same project, hook/draft/export flow and quality gate.");
  win.destroy(); app.quit();
}).catch(async (error) => { await fs.mkdir(root, { recursive: true }); await fs.writeFile(path.join(root, "result.json"), JSON.stringify({ passed: false, error: error.stack, errors, calls }, null, 2)); console.error(error.stack); app.exit(1); });
