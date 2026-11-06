#!/usr/bin/env node
'use strict';
/**
 * STAGE C — MULTIPLE SOURCES GENERALIZATION RUNNER
 *
 * 1. Verifies dynamic multimodal ending-boundary detection (`detectSourceEndingBoundary` v2)
 *    across 4 distinct non-911-benchmark videos on disk:
 *      - `source-cqf2r254dy8` (743.75s bodycam with "CASE DETAILS: Kyle's Verdict/Sentencing" card at 698.125s)
 *      - `source-ualmmh8bb4g` (652.25s bodycam with Officer John studio commentary wrap-up at 637.125s)
 *      - `source-5ztfoq-8rs0` (Full-HD true-crime case)
 *      - `va.mp4` (107.367s clean live-action reference with NO outro — false-positive control)
 * 2. Runs a full non-911 Story Scope -> Editorial Director -> Block Narration -> Hook Audition
 *    pass on `source-cqf2r254dy8` (project `v6-followup-secondary-cqf2`) to prove that boundary
 *    propagation, narrator commentary planning, and hook verification generalize cleanly beyond
 *    the primary 911 benchmark.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const ProjectStore = require('../electron/services/projectStore');
const DubbingService = require('../electron/services/dubbingService');
const AutoStoryRunner = require('../electron/services/autoStoryRunner');
const FfmpegService = require('../electron/services/ffmpegService');
const { detectSourceEndingBoundary } = require('../electron/services/sourceEndingBoundaryService');
const { verifyHookTitle, runHookAudition } = require('../electron/services/hookAuditionService');

const CONFIG_PATH = process.env.BENCH_CONFIG || 'C:\\Users\\Admin\\AppData\\Roaming\\cineviral-studio\\config.json';
const WORKSPACE_ROOT = process.env.BENCH_WORKSPACE || 'D:\\OutputVideo';

const log = msg => console.log(`[${new Date().toISOString().slice(11, 19)}] [Stage C] ${msg}`);
const readJson = async f => { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch (_) { return null; } };

const SECONDARY_SOURCES = [
  {
    id: 'source-cqf2r254dy8',
    label: 'Bodycam Case cqf2r254dy8 (Kyle Sentencing Epilogue Card Outro)',
    videoPath: 'D:\\Video\\source-cqf2r254dy8-gemini-analysis-pack\\temp\\analysis-proxy-full.mp4',
    srtPath: 'D:\\Video\\source-cqf2r254dy8-gemini-analysis-pack\\01-GUI-GEMINI\\source-transcript.srt',
    manifestPath: 'D:\\Video\\source-cqf2r254dy8-gemini-analysis-pack\\01-GUI-GEMINI\\scene-manifest.json',
    expectedBehavior: 'Must detect CASE DETAILS sentencing epilogue card near ~698.1s and cap liveActionEndSec before it.'
  },
  {
    id: 'source-ualmmh8bb4g',
    label: 'Bodycam Case ualmmh8bb4g (Officer John Channel Commentary Outro)',
    videoPath: 'D:\\Video\\source-ualmmh8bb4g-gemini-analysis-pack\\temp\\analysis-proxy-full.mp4',
    srtPath: 'D:\\Video\\source-ualmmh8bb4g-gemini-analysis-pack\\01-GUI-GEMINI\\source-transcript.srt',
    manifestPath: 'D:\\Video\\source-ualmmh8bb4g-gemini-analysis-pack\\01-GUI-GEMINI\\scene-manifest.json',
    expectedBehavior: 'Must detect channel host wrap-up ("Because our purpose here isn’t just to show you videos...") near ~637.1s.'
  },
  {
    id: 'source-5ztfoq-8rs0',
    label: 'Full-HD True Crime Case 5ztfoq-8rs0',
    videoPath: 'D:\\sources\\queue\\e99b424b-85db-4ff9-972c-b1ff5b5709db\\youtube-5ztfoq-8rs0\\source-5ztfoq-8rs0.mp4',
    srtPath: 'D:\\sources\\queue\\e99b424b-85db-4ff9-972c-b1ff5b5709db\\youtube-5ztfoq-8rs0\\source-5ztfoq-8rs0.en.srt',
    manifestPath: '',
    expectedBehavior: 'Must inspect trailing media & cues dynamically without crashing or applying 911 timestamps.'
  },
  {
    id: 'va-reference-no-outro',
    label: 'Clean Live-Action Reference Cut (va.mp4 — No Outro Control)',
    videoPath: 'C:\\Users\\Admin\\Videos\\va.mp4',
    srtPath: '',
    manifestPath: '',
    expectedBehavior: 'Must report hasOutro=false and preserve full live-action duration without false-positive trimming.'
  }
];

async function main() {
  const skipE2e = process.argv.includes('--boundary-only');
  const settings = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
  const store = new ProjectStore();
  const dubbing = new DubbingService(store);
  const ffmpeg = new FfmpegService(settings);
  const tmpCacheBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'cv-stage-c-'));

  const boundaryResults = [];
  try {
    for (const src of SECONDARY_SOURCES) {
      if (!fs.existsSync(src.videoPath)) {
        log(`Skipping ${src.id} (not found at ${src.videoPath})`);
        boundaryResults.push({ id: src.id, skipped: true, reason: 'file_not_found' });
        continue;
      }
      log(`Probing dynamic ending boundary on ${src.id}...`);
      const probe = await ffmpeg.probeVideo(src.videoPath);
      const cues = (src.srtPath && fs.existsSync(src.srtPath))
        ? DubbingService.normalizeRollingSubtitleCues(await dubbing.readSubtitleSegments(src.srtPath))
        : [];
      const sceneManifest = (src.manifestPath && fs.existsSync(src.manifestPath))
        ? await readJson(src.manifestPath)
        : null;
      const srcCache = path.join(tmpCacheBase, src.id);
      await fsp.mkdir(srcCache, { recursive: true });

      const boundary = await detectSourceEndingBoundary({
        sourcePath: src.videoPath,
        durationSec: probe.duration,
        cues,
        sceneManifest,
        cacheDir: srcCache
      });
      log(`  -> ${src.id}: duration=${probe.duration.toFixed(2)}s | hasOutro=${boundary.hasOutro} | outroStartSec=${boundary.outroStartSec} | liveActionEndSec=${boundary.liveActionEndSec} | type=${boundary.outroType} | confidence=${boundary.confidence} | uncertain=${boundary.uncertain}`);
      boundaryResults.push({
        id: src.id,
        label: src.label,
        videoPath: src.videoPath,
        durationSec: probe.duration,
        expectedBehavior: src.expectedBehavior,
        boundary
      });
    }
  } finally {
    await fsp.rm(tmpCacheBase, { recursive: true, force: true }).catch(() => {});
  }

  let secondaryPipelineRun = null;
  const e2eCandidate = SECONDARY_SOURCES[0];
  if (!skipE2e && fs.existsSync(e2eCandidate.videoPath)) {
    const projectId = 'v6-followup-secondary-cqf2';
    log(`\nRunning full Story Scope + Director + Narration + Hook Audition on secondary source ${e2eCandidate.id} (${projectId})...`);
    const paths = store.getProjectPaths(WORKSPACE_ROOT, projectId);
    if (fs.existsSync(paths.rootDir)) {
      await fsp.rm(paths.rootDir, { recursive: true, force: true });
    }
    for (const d of [paths.rootDir, paths.analysisDir, paths.assetsDir, paths.audioDir, paths.clipsDir, paths.outputDir, paths.tempDir]) {
      await fsp.mkdir(d, { recursive: true });
    }
    // Copy scene-manifest.json alongside source or let pipeline read SRT cues + media probe
    const autoStoryConfig = {
      outputCount: 1,
      targetDurationMinSec: 65,
      targetDurationMaxSec: 90,
      narration: { enabled: true, style: 'investigative' },
      storyMode: 'serialized_part',
      pacingMode: 'commentary_led',
      preferCliffhanger: false,
      editorialArchitecture: 'scope_media_director'
    };
    await store.saveProject(WORKSPACE_ROOT, {
      id: projectId,
      title: 'V6-Secondary-Source-Generalization-cqf2',
      sourceVideoPath: e2eCandidate.videoPath,
      subtitleSourcePath: e2eCandidate.srtPath,
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
      showSubtitles: true,
      videoDecoration: {
        canvasEnabled: true,
        canvasAspect: '9:16',
        customWidth: 1080,
        customHeight: 1920,
        blurBackgroundEnabled: true,
        topCaptionEnabled: true,
        topCaptionAutoFromScript: false,
        topCaptionText: ''
      },
      autoStoryConfig,
      autoStoryEditorialConfig: autoStoryConfig
    });

    // If scene-manifest.json exists in 01-GUI-GEMINI, copy next to temp proxy if missing so pipeline also sees scene boundaries
    const proxyAdjacentManifest = path.join(path.dirname(e2eCandidate.videoPath), 'scene-manifest.json');
    let copiedManifest = false;
    if (e2eCandidate.manifestPath && fs.existsSync(e2eCandidate.manifestPath) && !fs.existsSync(proxyAdjacentManifest)) {
      await fsp.copyFile(e2eCandidate.manifestPath, proxyAdjacentManifest);
      copiedManifest = true;
    }

    const runner = new AutoStoryRunner(settings, store, dubbing);
    let runErr = null;
    try {
      await runner.run({
        workspaceRoot: WORKSPACE_ROOT,
        projectId,
        scriptId: 1,
        onProgress: p => {
          if (p.heartbeat) return;
          log(`[${projectId}] ${p.percent !== undefined ? `[${p.percent}%] ` : ''}${p.stage ? `<${p.stage}> ` : ''}${p.message || ''}`);
        }
      });
    } catch (err) {
      runErr = err;
      log(`[${projectId}] Runner warning/error: ${err.message}`);
    } finally {
      if (copiedManifest) await fsp.rm(proxyAdjacentManifest, { force: true }).catch(() => {});
    }

    const fastDir = path.join(paths.analysisDir, 'auto-story-fast');
    const boundaryDoc = await readJson(path.join(fastDir, 'source-ending-boundary.json'));
    const scopeDoc = await readJson(path.join(fastDir, 'story-scope.json'));
    const spineDoc = await readJson(path.join(fastDir, 'story-spine.json'));
    const spine = spineDoc?.spines?.[0] || null;
    const scriptDoc = await readJson(path.join(fastDir, 'script-1.json'));
    const reviewDoc = await readJson(path.join(fastDir, 'review-state-1.json'));
    const cues = DubbingService.normalizeRollingSubtitleCues(await dubbing.readSubtitleSegments(e2eCandidate.srtPath));

    let hookReport = null;
    if (spine && scopeDoc) {
      const postRunAi = new (require('../electron/services/vertexAiService'))(settings);
      try {
        const proj = await store.getProject(WORKSPACE_ROOT, projectId);
        const cacheDir = proj?.autoStorySourceV3?.cache || '';
        const secModel = cacheDir ? await require('../electron/services/sourceStoryModelService').load(cacheDir) : {};
        const ha = await runHookAudition({
          aiService: postRunAi,
          ffmpeg: runner.producer.ffmpeg,
          dubbing,
          project: proj,
          paths,
          scope: scopeDoc.chosen || scopeDoc.scope || {},
          spine,
          model: secModel || {},
          cues,
          outputDir: fastDir
        });
        hookReport = ha.report;
      } catch (err) {
        log(`Secondary hook audition warning: ${err.message}`);
      } finally {
        await postRunAi.close?.().catch?.(() => {});
      }
    }

    const maxBeatEndSec = Array.isArray(spine?.beats) && spine.beats.length
      ? Math.max(...spine.beats.map(b => Number(b.sourceEndSec) || 0))
      : null;
    const narratedBlocks = (scriptDoc?.delivery_blocks || spine?.deliveryBlocks || []).filter(b => b.mode === 'narrated_story');

    secondaryPipelineRun = {
      projectId,
      sourceId: e2eCandidate.id,
      runnerError: runErr?.message || null,
      endingBoundary: boundaryDoc,
      scopeTitle: scopeDoc?.chosen?.title || null,
      scopeMaxWindowEndSec: Array.isArray(scopeDoc?.chosen?.scopeWindows)
        ? Math.max(...scopeDoc.chosen.scopeWindows.map(w => Number(w.endSec) || 0))
        : null,
      beatCount: spine?.beats?.length || 0,
      maxBeatSourceEndSec: maxBeatEndSec,
      strictlyWithinLiveActionBoundary: boundaryDoc?.liveActionEndSec && maxBeatEndSec !== null
        ? maxBeatEndSec <= boundaryDoc.liveActionEndSec + 0.02
        : null,
      narratedBlockCount: narratedBlocks.length,
      narratedBlocks: narratedBlocks.map(b => ({
        blockId: b.blockId,
        narratorFunction: b.narratorFunction,
        narrationText: b.narrationText || b.narrationIntent || ''
      })),
      hookAuditionSelectedTitle: hookReport?.selectedTitle || null,
      hookTitleValid: hookReport?.selectedTitle ? verifyHookTitle(hookReport.selectedTitle, { cues }).valid : null,
      reviewStatus: reviewDoc?.acceptanceStatus || reviewDoc?.status || null
    };
  }

  const outPath = path.join('D:\\Project\\cineviral-studio\\reports\\v6-recovery-followup', 'stage-c-secondary-sources.json');
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    boundaryGeneralizationCount: boundaryResults.length,
    boundaryResults,
    secondaryPipelineRun
  }, null, 2));
  log(`Saved Stage C generalization report -> ${outPath}`);
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

