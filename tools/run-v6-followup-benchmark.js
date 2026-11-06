#!/usr/bin/env node
'use strict';
/**
 * AUTOSTORY V6 RECOVERY FOLLOW-UP — REAL E2E BENCHMARK & PACING COMPARISON RUNNER
 *
 * Executes the complete, non-hardcoded Stage B production workflow on fresh projects:
 *   1. Loads source video & subtitle paths dynamically from prior project metadata
 *      (D:\OutputVideo\v6-recovery-benchmark-mw34\project.json) without modifying it.
 *   2. Runs Option B (commentary_led -> D:\OutputVideo\v6-followup-commentary-b)
 *      and Option A (evidence_heavy -> D:\OutputVideo\v6-followup-evidence-a):
 *      SOURCE -> BOUNDARY v2 -> STORY SCOPE -> NARRATIVE PLAN & DIRECTOR ->
 *      BLOCK NARRATION & KOKORO TTS -> FAST DRAFT -> MEDIA CRITIC -> TARGETED REPAIR
 *   3. Runs real Multimodal Hook Audition (>= 2 rendered 9:16 preview MP4s +
 *      deterministic factual/anti-copycat/anti-spoiler verification + Gemini video eval)
 *      and locks the winning verified topCaptionText onto the project.
 *   4. Renders true native 1080x1920 Production Final MP4s (`renderHighlightFinalExport`).
 *      Publishes Option B to NEW deliverable path:
 *        D:\Video\v6-followup-storyteller-benchmark-final.mp4
 *      and Option A to:
 *        D:\OutputVideo\v6-followup-evidence-a\v6-followup-option-a-evidence-heavy-final.mp4
 *   5. Generates `narration-performance-audit.json` (13 required fields + FFmpeg voice metrics).
 *   6. Runs `runFinalQualityGate` + `verifyFinalQaBinding` (Technical Gate + Multimodal Editorial Gate)
 *      on the exact delivered 1080x1920 MP4s.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const ProjectStore = require('../electron/services/projectStore');
const DubbingService = require('../electron/services/dubbingService');
const AutoStoryRunner = require('../electron/services/autoStoryRunner');
const VertexAiService = require('../electron/services/vertexAiService');
const sourceStoryModelService = require('../electron/services/sourceStoryModelService');
const { runHookAudition } = require('../electron/services/hookAuditionService');
const { buildNarrationPerformanceAudit } = require('../electron/services/narrationAuditService');
const { runFinalQualityGate, verifyFinalQaBinding } = require('../electron/services/finalQualityGateService');

const CONFIG_PATH = process.env.BENCH_CONFIG || 'C:\\Users\\Admin\\AppData\\Roaming\\cineviral-studio\\config.json';
const WORKSPACE_ROOT = process.env.BENCH_WORKSPACE || 'D:\\OutputVideo';
const PRIOR_PROJECT_JSON = process.env.BENCH_PRIOR_PROJECT || path.join(WORKSPACE_ROOT, 'v6-recovery-benchmark-mw34', 'project.json');
const FINAL_DELIVERABLE_MP4 = process.env.BENCH_FINAL_OUT || 'D:\\Video\\v6-followup-storyteller-benchmark-final.mp4';

const log = msg => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const readJson = async f => { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch (_) { return null; } };

async function findNewestFile(dir, matcher) {
  try {
    const entries = await fsp.readdir(dir);
    const matches = [];
    for (const name of entries) {
      if (!matcher(name)) continue;
      const full = path.join(dir, name);
      const st = await fsp.stat(full);
      if (st.isFile()) matches.push({ full, mtimeMs: st.mtimeMs });
    }
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return matches[0]?.full || null;
  } catch (_) {
    return null;
  }
}

async function runSinglePacingMode({
  pacingMode,
  projectId,
  publishedFinalTarget,
  sourceVideoPath,
  subtitleSourcePath,
  priorTopCaptionAsReferenceOnly,
  settings,
  store,
  dubbing
}) {
  log(`\n================================================================`);
  log(`STARTING STAGE B E2E RUN: pacingMode=${pacingMode} | project=${projectId}`);
  log(`================================================================`);

  const paths = store.getProjectPaths(WORKSPACE_ROOT, projectId);
  if (fs.existsSync(paths.rootDir)) {
    log(`Cleaning fresh follow-up project directory: ${paths.rootDir}`);
    await fsp.rm(paths.rootDir, { recursive: true, force: true });
  }
  for (const d of [paths.rootDir, paths.analysisDir, paths.assetsDir, paths.audioDir, paths.clipsDir, paths.outputDir, paths.tempDir]) {
    await fsp.mkdir(d, { recursive: true });
  }

  const autoStoryConfig = {
    outputCount: 1,
    targetDurationMinSec: 65,
    targetDurationMaxSec: 90,
    narration: { enabled: true, style: 'investigative' },
    storyMode: 'serialized_part',
    pacingMode,
    preferCliffhanger: false,
    editorialArchitecture: 'scope_media_director'
  };

  await store.saveProject(WORKSPACE_ROOT, {
    id: projectId,
    title: `V6-Followup-${pacingMode}`,
    sourceVideoPath,
    subtitleSourcePath,
    exportRoot: paths.outputDir,
    exportLayout: 'flat',
    mode: 'highlight_cut',
    analysisWorkflow: 'vertex_auto_story',
    autoStoryContractVersion: 4,
    autoStoryPipelineVersion: 'source-story-v3',
    targetLanguage: 'en',
    sourceLanguage: 'en',
    voiceProvider: 'kokoro',
    voiceId: 'am_adam',
    kokoroSpeed: 1.04,
    draftVoiceMode: 'final',
    draftVoiceProvider: 'kokoro',
    draftVoiceId: 'am_adam',
    autoFitVoice: false,
    showSubtitles: true,
    subtitleStyle: 'white_black_outline',
    videoDecoration: {
      canvasEnabled: true,
      canvasAspect: '9:16',
      customWidth: 1080,
      customHeight: 1920,
      blurBackgroundEnabled: true,
      blurStrength: 24,
      topCaptionEnabled: true,
      topCaptionAutoFromScript: false,
      topCaptionStyle: 'default',
      topCaptionText: '',
      topCaptionFontSize: 50,
      topCaptionYPercent: 8,
      foregroundScalePercent: 100,
      foregroundXPercent: 50,
      foregroundYPercent: 50
    },
    mixer: {
      voiceVolume: 100,
      sourceVolume: 16,
      narrationSourceAudioOverride: true,
      narrationDuckDefault: true,
      bgmVolume: 35,
      ducking: 74,
      bgmPath: ''
    },
    autoStoryConfig,
    autoStoryEditorialConfig: autoStoryConfig
  });

  const runner = new AutoStoryRunner(settings, store, dubbing);
  const tStart = Date.now();
  await runner.run({
    workspaceRoot: WORKSPACE_ROOT,
    projectId,
    scriptId: 1,
    onProgress: p => {
      if (p.heartbeat) return;
      log(`[${pacingMode}] ${p.percent !== undefined ? `[${p.percent}%] ` : ''}${p.stage ? `<${p.stage}> ` : ''}${p.message || ''}`);
    }
  });
  log(`[${pacingMode}] Pipeline stage completed in ${((Date.now() - tStart) / 1000).toFixed(1)}s`);

  const fastDir = path.join(paths.analysisDir, 'auto-story-fast');
  const scopeDoc = await readJson(path.join(fastDir, 'story-scope.json'));
  const scope = scopeDoc?.chosen || scopeDoc?.scope || null;
  const spineDoc = await readJson(path.join(fastDir, 'story-spine.json'));
  const spine = spineDoc?.spines?.[0] || null;
  const scriptDoc = await readJson(path.join(fastDir, 'script-1.json'));
  const endingBoundary = await readJson(path.join(fastDir, 'source-ending-boundary.json'));

  const projectAfterRun = await store.getProject(WORKSPACE_ROOT, projectId);
  const sourceCacheDir = projectAfterRun?.autoStorySourceV3?.cache || '';
  const model = sourceCacheDir ? await sourceStoryModelService.load(sourceCacheDir) : null;
  const cues = subtitleSourcePath
    ? DubbingService.normalizeRollingSubtitleCues(await dubbing.readSubtitleSegments(subtitleSourcePath))
    : [];

  const postRunAi = new VertexAiService(settings);
  try {
    // Step 3: Real Multimodal Hook Audition (>= 2 rendered 9:16 preview MP4s + factual verification)
    log(`[${pacingMode}] Running Multimodal Hook Audition...`);
    let hookAudition = null;
    try {
      hookAudition = await runHookAudition({
        aiService: postRunAi,
        ffmpeg: runner.producer.ffmpeg,
        dubbing,
        project: projectAfterRun,
        paths,
        scope: scope || {},
        spine: spine || {},
        model: model || {},
        cues,
        referenceTitle: priorTopCaptionAsReferenceOnly || '',
        outputDir: fastDir
      });
      log(`[${pacingMode}] Hook Audition selected (${hookAudition.chosen.candidateId}): "${hookAudition.chosen.title}"`);
      await store.updateProject(WORKSPACE_ROOT, projectId, {
        videoDecoration: {
          ...(projectAfterRun.videoDecoration || {}),
          topCaptionEnabled: true,
          topCaptionAutoFromScript: false,
          topCaptionText: hookAudition.chosen.title
        }
      });
    } catch (err) {
      log(`[${pacingMode}] Hook Audition warning: ${err.message}`);
    }

    // Step 4: Native 1080x1920 Production Final Export (`isFinal === true`)
    log(`[${pacingMode}] Rendering native 1080x1920 Production Final MP4...`);
    const tFinal = Date.now();
    const finalExportResult = await dubbing.renderHighlightFinalExport({
      workspaceRoot: WORKSPACE_ROOT,
      projectId,
      settings,
      onProgress: p => log(`[${pacingMode} Final] [${p.percent || 0}%] <${p.step || 'export'}> ${p.message || ''}`)
    });
    log(`[${pacingMode}] Production Final Export finished in ${((Date.now() - tFinal) / 1000).toFixed(1)}s`);

    const producedMp4 = (finalExportResult?.outputPath && fs.existsSync(finalExportResult.outputPath))
      ? finalExportResult.outputPath
      : finalExportResult?.internalOutputPath;
    if (!producedMp4 || !fs.existsSync(producedMp4)) {
      throw new Error(`[${pacingMode}] Production Final MP4 was not created.`);
    }

    await fsp.mkdir(path.dirname(publishedFinalTarget), { recursive: true });
    if (path.resolve(producedMp4) !== path.resolve(publishedFinalTarget)) {
      await fsp.copyFile(producedMp4, publishedFinalTarget);
    }
    log(`[${pacingMode}] Published Production Final MP4 -> ${publishedFinalTarget}`);

    // Step 5: Narration Performance Audit (`narration-performance-audit.json`)
    const newestBlocksFile = await findNewestFile(paths.outputDir, n => n.endsWith('-delivery-blocks.json'));
    const deliveryBlocksDoc = newestBlocksFile ? await readJson(newestBlocksFile) : null;
    const newestNarrationSrt = await findNewestFile(paths.outputDir, n => n.endsWith('.narration.srt'));
    const newestSubSrt = await findNewestFile(paths.outputDir, n => n.endsWith('.srt') && !n.endsWith('.narration.srt'));

    const finalProbe = await runner.producer.ffmpeg.probeVideo(publishedFinalTarget);
    const latestProject = await store.getProject(WORKSPACE_ROOT, projectId);
    const narrationAuditPath = path.join(fastDir, 'narration-performance-audit.json');
    const narrationAudit = await buildNarrationPerformanceAudit({
      script: scriptDoc || {},
      spine: spine || {},
      model: model || {},
      cues,
      deliveryBlockReports: deliveryBlocksDoc?.blocks || [],
      project: latestProject,
      settings,
      videoDurationSec: finalProbe?.duration || null,
      outputPath: narrationAuditPath
    });
    log(`[${pacingMode}] Narration Audit: ${narrationAudit.summary.narratorBlockCount} blocks, ${narrationAudit.summary.totalWords} words, speaking=${narrationAudit.summary.totalSpeakingDurationSec}s (${narrationAudit.summary.narratorShareBySpeakingPct}%), maxRawRun=${narrationAudit.summary.maxUninterruptedRawSec}s`);

    // Step 6: Post-render Final Quality Gate (Technical Gate + Multimodal Editorial Gate) + SHA-256 Binding Check
    log(`[${pacingMode}] Running Post-Render Final Quality Gate on ${publishedFinalTarget}...`);
    const finalQaPath = path.join(fastDir, 'final-quality-gate.json');
    const subtitlePaths = [newestNarrationSrt, newestSubSrt].filter(Boolean);
    const finalQa = await runFinalQualityGate({
      mp4Path: publishedFinalTarget,
      expectedWidth: 1080,
      expectedHeight: 1920,
      minDurationSec: 65,
      maxDurationSec: 90,
      spine,
      script: scriptDoc,
      endingBoundary,
      narrationAudit,
      model,
      cues,
      topCaptionText: latestProject?.videoDecoration?.topCaptionText || '',
      referenceTitle: priorTopCaptionAsReferenceOnly || '',
      subtitlePaths,
      pacingMode,
      aiService: postRunAi,
      outputPath: finalQaPath
    });
    const bindingCheck = await verifyFinalQaBinding(finalQa, publishedFinalTarget);
    log(`[${pacingMode}] Final QA Verdict: qaResult=${finalQa.qaResult}, publishReady=${finalQa.publishReady}, bindingValid=${bindingCheck.valid}, sha256=${finalQa.sha256}`);
    if (finalQa.blockingFindings?.length) {
      log(`[${pacingMode}] Blocking findings: ${JSON.stringify(finalQa.blockingFindings)}`);
    }

    const runSummary = {
      generatedAt: new Date().toISOString(),
      pacingMode,
      projectId,
      projectRoot: paths.rootDir,
      analysisDir: fastDir,
      publishedFinalTarget,
      runnerError: null,
      endingBoundary,
      selectedHookTitle: latestProject?.videoDecoration?.topCaptionText || null,
      hookAuditionPath: hookAudition?.reportPath || null,
      narrationAuditSummary: narrationAudit.summary,
      finalQaSummary: {
        qaResult: finalQa.qaResult,
        publishReady: finalQa.publishReady,
        sha256: finalQa.sha256,
        fileSize: finalQa.fileSize,
        duration: finalQa.duration,
        resolution: finalQa.resolution,
        technicalStatus: finalQa.technicalGate?.status,
        editorialStatus: finalQa.editorialGate?.status,
        blockingFindings: finalQa.blockingFindings,
        bindingValid: bindingCheck.valid
      }
    };
    await fsp.writeFile(path.join(fastDir, 'v6-followup-run-summary.json'), JSON.stringify(runSummary, null, 2));
    return runSummary;
  } finally {
    await postRunAi.close?.().catch?.(() => {});
  }
}

async function main() {
  const modeArgIdx = process.argv.indexOf('--mode');
  const requestedMode = modeArgIdx >= 0 ? String(process.argv[modeArgIdx + 1] || 'both') : (process.env.BENCH_MODE || 'both');

  const priorProject = await readJson(PRIOR_PROJECT_JSON);
  const sourceVideoPath = process.env.BENCH_SOURCE || priorProject?.sourceVideoPath;
  const subtitleSourcePath = process.env.BENCH_SUBTITLE || priorProject?.subtitleSourcePath || '';
  const priorTopCaptionAsReferenceOnly = priorProject?.videoDecoration?.topCaptionText || '';

  if (!sourceVideoPath || !fs.existsSync(sourceVideoPath)) {
    throw new Error(`Unable to resolve sourceVideoPath from ${PRIOR_PROJECT_JSON} (got: ${sourceVideoPath})`);
  }
  log(`Resolved source video from metadata: ${sourceVideoPath}`);
  log(`Resolved subtitle file from metadata: ${subtitleSourcePath}`);

  const settings = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
  const store = new ProjectStore();
  const dubbing = new DubbingService(store);
  await store.ensureWorkspaceRoot(WORKSPACE_ROOT);

  const results = {};

  if (requestedMode === 'both' || requestedMode === 'commentary_led') {
    results.commentary_led = await runSinglePacingMode({
      pacingMode: 'commentary_led',
      projectId: 'v6-followup-commentary-b',
      publishedFinalTarget: FINAL_DELIVERABLE_MP4,
      sourceVideoPath,
      subtitleSourcePath,
      priorTopCaptionAsReferenceOnly,
      settings,
      store,
      dubbing
    });
  }

  if (requestedMode === 'both' || requestedMode === 'evidence_heavy') {
    results.evidence_heavy = await runSinglePacingMode({
      pacingMode: 'evidence_heavy',
      projectId: 'v6-followup-evidence-a',
      publishedFinalTarget: path.join(WORKSPACE_ROOT, 'v6-followup-evidence-a', 'v6-followup-option-a-evidence-heavy-final.mp4'),
      sourceVideoPath,
      subtitleSourcePath,
      priorTopCaptionAsReferenceOnly,
      settings,
      store,
      dubbing
    });
  }

  const comparisonOut = path.join('D:\\Project\\cineviral-studio\\reports\\v6-recovery-followup', 'stage-b-pacing-comparison.json');
  await fsp.mkdir(path.dirname(comparisonOut), { recursive: true });
  await fsp.writeFile(comparisonOut, JSON.stringify({
    generatedAt: new Date().toISOString(),
    sourceVideoPath,
    results
  }, null, 2));
  log(`\nStage B benchmark runs complete! Comparison saved to ${comparisonOut}`);
}

let electronApp = null;
try {
  const electron = require('electron');
  if (electron && typeof electron === 'object' && electron.app) {
    electronApp = electron.app;
  }
} catch (_) {}

const startRunner = async () => {
  if (electronApp) {
    electronApp.commandLine?.appendSwitch?.('disable-gpu-sandbox');
    await electronApp.whenReady();
    electronApp.on('window-all-closed', e => e.preventDefault());
  }
  await main();
  if (electronApp) electronApp.exit(0);
  else process.exit(0);
};

startRunner().catch(err => {
  console.error(err);
  if (electronApp) electronApp.exit(1);
  else process.exit(1);
});

