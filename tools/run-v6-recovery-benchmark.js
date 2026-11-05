#!/usr/bin/env node
'use strict';
/**
 * AUTOSTORY V6 EDITORIAL RECOVERY BENCHMARK RUNNER
 *
 * Runs the end-to-end AutoStory V6 editorial recovery pipeline:
 *   1. Dynamic Source Ending Boundary Detection (no hardcoded timestamps)
 *   2. Story Scope Selection with punchline/defense preservation directives
 *   3. Editorial Director with runtime budget optimization and hook title framing
 *   4. Continuous delivery blocks narration & voice-fit with Kokoro TTS
 *   5. Editorial Fast Draft (540x960 preview)
 *   6. Production Final Export (1080x1920, draft: false, CRF 21, Master Audio)
 *   7. Independent Quality Assurance & Forensics Measurement
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFileSync } = require('child_process');
const ProjectStore = require('../electron/services/projectStore');
const DubbingService = require('../electron/services/dubbingService');
const AutoStoryRunner = require('../electron/services/autoStoryRunner');

const CONFIG_PATH = process.env.BENCH_CONFIG || 'C:\\Users\\Admin\\AppData\\Roaming\\cineviral-studio\\config.json';
const SOURCE_PATH = process.env.BENCH_SOURCE || 'C:\\Users\\Admin\\Documents\\MovieRecapToolWorkspace\\sources\\youtube-m6ow9dqxqcg\\source-m6ow9dqxqcg.mp4';
const SUBTITLE_PATH = process.env.BENCH_SUBTITLE || 'C:\\Users\\Admin\\Documents\\MovieRecapToolWorkspace\\sources\\youtube-m6ow9dqxqcg\\source-m6ow9dqxqcg.en.srt';
const WORKSPACE_ROOT = process.env.BENCH_WORKSPACE || 'D:\\OutputVideo';
const PROJECT_ID = process.env.BENCH_PROJECT_ID || 'v6-recovery-benchmark-mw34';

const log = msg => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const probe = f => { try { return Number(Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', f], { encoding: 'utf8' }).trim()).toFixed(2)); } catch (_) { return null; } };
const readJson = async f => { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch (_) { return null; } };

async function main() {
  if (!fs.existsSync(SOURCE_PATH)) throw new Error(`Source video not found: ${SOURCE_PATH}`);
  const settings = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
  const store = new ProjectStore();
  const dubbing = new DubbingService(store);
  await store.ensureWorkspaceRoot(WORKSPACE_ROOT);
  const paths = store.getProjectPaths(WORKSPACE_ROOT, PROJECT_ID);

  if (fs.existsSync(paths.rootDir)) {
    log(`Cleaning previous benchmark project directory: ${paths.rootDir}`);
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
    preferCliffhanger: true,
    editorialArchitecture: 'scope_media_director'
  };

  const topCaptionText = "24yo Abuses 911 Then Gets a Reality Check She Won't Forget";

  log(`Initializing project ${PROJECT_ID}...`);
  await store.saveProject(WORKSPACE_ROOT, {
    id: PROJECT_ID,
    title: 'V6-Recovery-Storyteller-Benchmark',
    sourceVideoPath: SOURCE_PATH,
    subtitleSourcePath: SUBTITLE_PATH,
    exportRoot: 'D:\\Video',
    exportLayout: 'flat',
    mode: 'highlight_cut',
    analysisWorkflow: 'vertex_auto_story',
    autoStoryContractVersion: 4,
    autoStoryPipelineVersion: 'source-story-v3',
    targetLanguage: 'en',
    sourceLanguage: 'en',
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
      topCaptionAutoFromScript: true,
      topCaptionStyle: 'default',
      topCaptionText,
      topCaptionFontSize: 52,
      topCaptionYPercent: 8,
      foregroundScalePercent: 100,
      foregroundXPercent: 50,
      foregroundYPercent: 50
    },
    mixer: {
      voiceVolume: 100,
      sourceVolume: 28,
      narrationSourceAudioOverride: true,
      narrationDuckDefault: true,
      bgmVolume: 40,
      ducking: 70,
      bgmPath: ''
    },
    autoStoryConfig,
    autoStoryEditorialConfig: autoStoryConfig
  });

  const runner = new AutoStoryRunner(settings, store, dubbing);
  const t0 = Date.now();
  let runtimeError = null;

  log('Starting AutoStoryRunner pipeline execution...');
  try {
    await runner.run({
      workspaceRoot: WORKSPACE_ROOT,
      projectId: PROJECT_ID,
      scriptId: 1,
      onProgress: p => log(`${p.percent !== undefined ? `[${p.percent}%] ` : ''}${p.stage ? `<${p.stage}> ` : ''}${p.message || ''}`)
    });
  } catch (e) {
    runtimeError = e;
    log(`Runner error: ${e.message}`);
  }
  log(`Runner completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Now run true Production Final Export (1080x1920, draft: false, CRF 21, Master Audio)
  log('Starting Production Final Export (1080x1920, Master Audio, delivery blocks)...');
  const tFinalStart = Date.now();
  let finalExportResult = null;
  try {
    finalExportResult = await dubbing.renderHighlightFinalExport({
      workspaceRoot: WORKSPACE_ROOT,
      projectId: PROJECT_ID,
      settings,
      onProgress: p => log(`[Final Export] [${p.percent || 0}%] <${p.step || 'export'}> ${p.message || ''}`)
    });
    log(`Final Export completed in ${((Date.now() - tFinalStart) / 1000).toFixed(1)}s`);
  } catch (err) {
    log(`Final Export error: ${err.message}`);
  }

  // Publish / copy production final video to D:\Video\v6-recovery-storyteller-benchmark-final.mp4
  const targetFinalVideoPath = 'D:\\Video\\v6-recovery-storyteller-benchmark-final.mp4';
  if (finalExportResult?.outputPath && fs.existsSync(finalExportResult.outputPath)) {
    log(`Copying final production render to ${targetFinalVideoPath}`);
    await fsp.copyFile(finalExportResult.outputPath, targetFinalVideoPath);
  } else if (finalExportResult?.internalOutputPath && fs.existsSync(finalExportResult.internalOutputPath)) {
    log(`Copying internal final production render to ${targetFinalVideoPath}`);
    await fsp.copyFile(finalExportResult.internalOutputPath, targetFinalVideoPath);
  }

  // Inspect generated artifacts
  const A = path.join(paths.analysisDir, 'auto-story-fast');
  const scope = await readJson(path.join(A, 'story-scope.json'));
  const spineDoc = await readJson(path.join(A, 'story-spine.json'));
  const spine = spineDoc?.spines?.[0] || null;
  const scriptDoc = await readJson(path.join(A, 'script-1.json'));

  const finalDuration = fs.existsSync(targetFinalVideoPath) ? probe(targetFinalVideoPath) : null;
  log(`Final Video: ${targetFinalVideoPath} (duration: ${finalDuration}s)`);

  const summary = {
    generatedAt: new Date().toISOString(),
    projectId: PROJECT_ID,
    runtimeError: runtimeError?.message || null,
    targetFinalVideoPath,
    finalDuration,
    finalExportResult: finalExportResult ? {
      outputPath: finalExportResult.outputPath,
      internalOutputPath: finalExportResult.internalOutputPath,
      isFinal: finalExportResult.isFinal,
      renderType: finalExportResult.renderType
    } : null,
    storyScope: scope?.chosen || null,
    beats: (spine?.beats || []).map(b => ({
      beatId: b.beatId,
      sourceStartSec: b.sourceStartSec,
      sourceEndSec: b.sourceEndSec,
      dur: +(b.sourceEndSec - b.sourceStartSec).toFixed(2),
      narrativeRole: b.narrativeRole,
      audioMode: b.audioMode,
      observedInFootage: b.observedInFootage,
      whyNecessaryNow: b.whyNecessaryNow
    })),
    deliveryBlocks: spine?.deliveryBlocks || []
  };

  await fsp.writeFile(path.join(A, 'v6-recovery-benchmark-summary.json'), JSON.stringify(summary, null, 2));
  log(`Benchmark summary saved to ${path.join(A, 'v6-recovery-benchmark-summary.json')}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
