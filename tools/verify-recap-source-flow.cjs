const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const Media = require("../electron/services/recap/recapMediaService");
const Pipeline = require("../electron/services/recap/recapPipelineService");
const Store = require("../electron/services/projectStore");
const Kokoro = require("../electron/services/kokoroVoiceService");
const { createScopedToken, cancelToken, runWithCancelToken } = require("../electron/services/cancelToken");
async function verifyMaster(media, project, state, file) {
  const metadata = await media.probeVideo(file), target = Number(project.targetDurationSec);
  const frameTolerance = 1 / (metadata.fps || 30);
  assert.ok(metadata.duration >= target * .85 - frameTolerance && metadata.duration <= target * 1.05 + frameTolerance, "Actual exported duration must pass the requested target gate within one encoded frame");
  assert.ok(metadata.hasAudio, "Master must contain narration audio");
  if (project.recapAspectRatio === "9:16") { assert.equal(metadata.width, 1080); assert.equal(metadata.height, 1920); }
  const lastSpeechEnd = Math.max(...(state.decisions || []).map(d => {
    const first = d.clips?.[0]; return (first?.output_start || 0) + (first?.lead_ms || 0) / 1000 + d.audio_duration / d.voice_tempo;
  }), 0);
  assert.ok(metadata.duration + .25 >= lastSpeechEnd, `Master cuts off narration: ${metadata.duration}s < ${lastSpeechEnd}s`);
  let measuredClauseGroups = 0, maxClauseBoundaryErrorSec = 0;
  if (state.syncTimingVersion >= 3) {
    assert.equal(state.semanticTimingGate?.passed, true, "Measured semantic timing gate must pass before exporting");
    for (const decision of state.decisions || []) {
      const spans = state.audioTracks?.[decision.speech_unit_id]?.clauseSpans;
      if (!spans?.length) continue;
      assert.equal(decision.voice_tempo, 1, "Measured clauses must preserve the actual voice waveform pace");
      const origin = decision.clips[0].output_start;
      for (let index = 0; index < spans.length; index++) {
        const span = spans[index], expected = origin + (index ? span.startSec : 0);
        const error = Math.min(...decision.clips.filter(clip => span.visual_event_ids.includes(clip.event_id)).map(clip => Math.abs(clip.output_start - expected)));
        assert.ok(error <= .035, `Visual boundary misses measured speech in ${decision.speech_unit_id}: ${error}s`);
        maxClauseBoundaryErrorSec = Math.max(maxClauseBoundaryErrorSec, error); measuredClauseGroups++;
      }
    }
    if (!project.allowShotReuse) {
      const clips = state.decisions.flatMap(decision => decision.clips).sort((a, b) => a.source_start - b.source_start);
      for (let index = 1; index < clips.length; index++) assert.ok(clips[index].source_start >= clips[index - 1].source_end - .003,
        "Export must obey the user's no-shot-reuse preference");
    }
  }
  return { passed: true, metadata, lastSpeechEnd, measuredClauseGroups, maxClauseBoundaryErrorSec, file };
}
async function main() {
  const sourceDir = process.argv[2]; if (!sourceDir) throw new Error("Specify a source project directory.");
  const providerArg = process.argv.indexOf("--provider"), provider = providerArg >= 0 ? process.argv[providerArg + 1] : "antigravity_cli";
  const settings = JSON.parse(await fs.readFile(path.join(process.env.APPDATA, "cineviral-studio", "config.json"), "utf8"));
  const limitArg = process.argv.indexOf("--daily-limit");
  if (limitArg >= 0) {
    const limit = Number(process.argv[limitArg + 1]);
    if (!(limit > 0 && limit <= 6)) throw new Error("Verification daily limit must be within the explicitly approved $6 ceiling.");
    settings.vertexDailyLimitUsd = limit;
    // Bound each verification response and leave at least $0.05 below the
    // human-approved ceiling for its final billed usage. Never save this setting.
    settings.vertexDailyLimitUsd = Math.min(limit, 5.95);
    settings.recapVertexMaxOutputTokens = 8192;
  }
  const sourceProject = JSON.parse(await fs.readFile(path.join(sourceDir, "project.json"), "utf8"));
  const sourceState = JSON.parse(await fs.readFile(path.join(sourceDir, "analysis", "recap_state.json"), "utf8"));
  const root = path.resolve(__dirname, "../.tmp/recap-source-flow"), media = new Media(settings);
  await fs.mkdir(root, { recursive: true });
  if (process.argv.includes("--media-only")) {
    const chunk = { chunkIndex: "1-part-2", sourceStartSec: 120.125, sourceEndSec: 240.25, durationSec: 120.125 };
    const outputDir = path.join(root, "media");
    const file = await media.extractProxyChunk({ proxyPath: sourceState.proxyPath, chunk, outputDir });
    const meta = await media.probeVideo(file);
    assert.ok(Math.abs(meta.duration - chunk.durationSec) <= .2);
    for (const [name, input, seek] of [["expected", sourceState.proxyPath, 120.125], ["actual", file, 0]]) {
      await media.runCommand(media.ffmpegPath, ["-y", "-ss", String(seek), "-i", input, "-frames:v", "1", path.join(outputDir, `${name}.png`)]);
    }
    const comparison = await media.runCommand(media.ffmpegPath, ["-i", path.join(outputDir, "expected.png"), "-i", path.join(outputDir, "actual.png"), "-lavfi", "ssim", "-frames:v", "1", "-f", "null", "-"]);
    const ssim = Number(comparison.stderr.match(/All:([\d.]+)/)?.[1]); assert.ok(ssim > .95, `First source frame mismatch: ${ssim}`);
    const report = { passed: true, expectedDuration: chunk.durationSec, actualDuration: meta.duration, firstFrameSsim: ssim, file };
    await fs.writeFile(path.join(root, "media-result.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); return;
  }
  const retryArg = process.argv.indexOf("--retry-provider"), executionProvider = retryArg >= 0 ? process.argv[retryArg + 1] : provider;
  settings.aiProvider = executionProvider;
  const qualityArg = process.argv.indexOf("--quality-model");
  if (qualityArg >= 0) {
    const model = process.argv[qualityArg + 1];
    if (![settings.vertexAnalysisModel || "gemini-2.5-flash", settings.vertexQualityModel || "gemini-2.5-pro"].includes(model)) throw new Error("Only an already configured Vertex model may be used for verification.");
    settings.vertexQualityModel = model;
  }
  if (provider === "vertex_ai" && !settings.vertexProjectId && settings.vertexCredentialPath) {
    const credential = JSON.parse(await fs.readFile(settings.vertexCredentialPath, "utf8")); settings.vertexProjectId = credential.project_id;
  }
  const caseArg = process.argv.indexOf("--case"), caseName = caseArg >= 0 ? process.argv[caseArg + 1] : "";
  if (caseName && !/^[a-z0-9-]+$/.test(caseName)) throw new Error("Invalid verification case name.");
  const testRoot = path.join(root, caseName ? `${provider}-${caseName}` : provider), store = new Store();
  const resumeArg = process.argv.indexOf("--resume");
  const project = resumeArg >= 0 ? await store.getProject(testRoot, process.argv[resumeArg + 1]) : await store.createProject(testRoot, {
    ...sourceProject, title: `Full review verification ${provider}${caseName ? ` ${caseName}` : ""}`, exportRoot: path.join(testRoot, "exports"), recapEditorialSelection: "auto", recapWorkflow: "full_auto" });
  const paths = store.getProjectPaths(testRoot, project.id);
  const reportArg = process.argv.indexOf("--anchor-report");
  if (reportArg >= 0) {
    if (resumeArg < 0) throw new Error("Applying an anchor report requires an existing verification clone.");
    const report = JSON.parse(await fs.readFile(process.argv[reportArg + 1], "utf8"));
    if (!report.passed || !report.events?.length) throw new Error("Only a verified anchor report may be applied.");
    const statePath = path.join(paths.analysisDir, "recap_state.json"), state = JSON.parse(await fs.readFile(statePath, "utf8"));
    const byId = new Map(report.events.map(event => {
      if (!state.visualEvents.some(existing => existing.id === event.id) || event.anchorAudit?.version < 2
        || !(event.anchorAudit?.confidence >= .8) || !Number.isFinite(event.source_start) || !Number.isFinite(event.source_end)
        || event.source_start < 0 || event.source_end <= event.source_start || event.source_end > state.sourceMeta.duration) throw new Error("Invalid audited event in verification report.");
      return [event.id, event];
    }));
    state.visualEvents = state.visualEvents.map(event => byId.get(event.id) || event);
    for (const analysis of Object.values(state.chunkAnalyses || {})) analysis.events = analysis.events.map(event => byId.get(event.id) || event);
    const groups = [];
    for (const unit of state.speechUnits) {
      for (const clause of unit.clauses || []) {
        if (!clause.visual_event_ids.some(id => byId.has(id))) continue;
        const previous = groups.at(-1), refs = JSON.stringify(clause.visual_event_ids);
        if (previous?.speechUnitId === unit.id && previous.refs === refs) {
          previous.text += ` ${clause.text}`; previous.clauseIds.push(clause.clause_id);
          previous.targetWordCount += clause.text.split(/\s+/).filter(Boolean).length;
        } else groups.push({ speechUnitId: unit.id, refs, minimumWordCount: 0, clauseIds: [clause.clause_id], text: clause.text,
          visual_event_ids: clause.visual_event_ids, targetWordCount: clause.text.split(/\s+/).filter(Boolean).length });
      }
    }
    if (groups.length) {
      const Ai = require("../electron/services/recap/recapAiService");
      const revised = await new Ai(settings).rewriteRecap({ events: state.visualEvents, recapPlan: state.recapPlan, speechUnits: state.speechUnits,
        options: { language: project.recapNarrationLanguage || "en" }, feedback: { duration: { passed: true }, clauseBudgets: groups },
        onProgress: value => { if (value.message) console.log(value.message); } });
      state.speechUnits = revised.speech_units;
    }
    for (const key of ["decisions", "traceability", "syncMetrics", "durationGate", "semanticTimingGate", "draftVideoPath", "finalVideoPath", "qualityScore", "qualitySummary", "qualityIssues", "qualityGate", "completed", "reviewReady", "reviewError", "manualDecisions"]) delete state[key];
    state.reviewIteration = 0; state.userApprovedFinal = false;
    await fs.writeFile(statePath, JSON.stringify(state, null, 2));
  }
  const anchorArg = process.argv.indexOf("--audit-anchors");
  if (anchorArg >= 0) {
    if (resumeArg < 0) throw new Error("Anchor audit requires an existing verification clone.");
    const statePath = path.join(paths.analysisDir, "recap_state.json"), state = JSON.parse(await fs.readFile(statePath, "utf8"));
    const Ai = require("../electron/services/recap/recapAiService"), Audit = require("../electron/services/recap/recapAnchorAuditService");
    const events = await new Audit(settings).repair({ sourceVideoPath: project.sourceVideoPath, sourceDuration: state.sourceMeta.duration,
      events: state.visualEvents, eventIds: process.argv[anchorArg + 1].split(","), issues: state.qualityIssues || [], scenes: state.scenes,
      directory: path.join(paths.analysisDir, "anchor-audit"), ai: new Ai(settings), onProgress: value => console.log(value.message) });
    state.visualEvents = events;
    const byId = new Map(events.map(event => [event.id, event]));
    for (const analysis of Object.values(state.chunkAnalyses || {})) analysis.events = analysis.events.map(event => byId.get(event.id) || event);
    for (const key of ["decisions", "traceability", "syncMetrics", "durationGate", "semanticTimingGate", "draftVideoPath", "finalVideoPath", "qualityScore", "qualitySummary", "qualityIssues", "qualityGate", "completed", "reviewReady", "reviewError", "manualDecisions"]) delete state[key];
    state.reviewIteration = 0; state.userApprovedFinal = false;
    await fs.writeFile(statePath, JSON.stringify(state, null, 2));
  }
  if (process.argv.includes("--verify-master")) {
    const state = JSON.parse(await fs.readFile(path.join(paths.analysisDir, "recap_state.json"), "utf8"));
    const report = await verifyMaster(media, project, state, project.finalVideoPath || state.finalVideoPath);
    await fs.writeFile(path.join(testRoot, "master-verification.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); return;
  }
  if (resumeArg < 0) { await fs.mkdir(paths.analysisDir, { recursive: true }); await fs.writeFile(path.join(paths.analysisDir, "recap_state.json"), JSON.stringify(sourceState)); }
  if (process.argv.includes("--regenerate-narration")) {
    if (resumeArg < 0) throw new Error("Regeneration requires --resume and modifies only the verification clone.");
    const statePath = path.join(paths.analysisDir, "recap_state.json"), state = JSON.parse(await fs.readFile(statePath, "utf8"));
    for (const key of ["speechUnits", "audioTracks", "decisions", "traceability", "syncMetrics", "durationGate", "draftVideoPath", "finalVideoPath", "qualityScore", "qualitySummary", "qualityIssues", "qualityGate", "completed", "reviewReady", "reviewError"]) delete state[key];
    state.reviewIteration = 0; state.userApprovedFinal = false;
    await fs.writeFile(statePath, JSON.stringify(state, null, 2));
  }
  const service = new Pipeline({ projectStore: store }), token = createScopedToken("full real recap verification");
  const deadline = executionProvider === "antigravity_cli" ? 900000 : 1200000;
  const timer = setTimeout(() => cancelToken(token, "Verification deadline exceeded"), deadline);
  let previous = "", lastReport = 0; const startedAt = Date.now();
  console.log(JSON.stringify({ provider: executionProvider, projectId: project.id, sourceDuration: sourceState.sourceMeta.duration, targetDuration: project.targetDurationSec, timeoutSeconds: deadline / 1000 }));
  try {
    const result = await runWithCancelToken(token, () => service.runRecapProject({ workspaceRoot: testRoot, projectId: project.id,
      settings: { ...settings, recapEditorialSelection: "auto", recapWorkflow: "full_auto", recapDraftOnly: false }, cancelToken: token,
      onProgress: (value) => { const message = `[${value.stage}] ${value.message || ""}`;
        if (value.message && message !== previous) { console.log(message); previous = message; }
        if (Date.now() - lastReport >= 30000) { lastReport = Date.now(); console.log(`Elapsed ${Math.round((Date.now() - startedAt) / 1000)}s`); }
      } }));
    const outputVerification = result.status === "completed" ? await verifyMaster(media, project,
      JSON.parse(await fs.readFile(path.join(paths.analysisDir, "recap_state.json"), "utf8")), result.finalVideoPath) : null;
    const report = { passed: result.status === "completed", elapsedSec: (Date.now() - startedAt) / 1000, provider: executionProvider, projectId: project.id, ...result, outputVerification };
    await fs.writeFile(path.join(testRoot, "result.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    if (result.status !== "completed") process.exitCode = 1;
  } catch (error) {
    const report = { passed: false, provider: executionProvider, projectId: project.id, elapsedSec: (Date.now() - startedAt) / 1000, kind: error.kind, error: error.message };
    await fs.writeFile(path.join(testRoot, "result.json"), JSON.stringify(report, null, 2)); console.error(JSON.stringify(report)); process.exitCode = 1;
  } finally { clearTimeout(timer); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => Kokoro.shutdownPersistentWorkers());
