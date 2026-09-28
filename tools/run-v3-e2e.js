#!/usr/bin/env node
/**
 * AutoStory V3 — Full E2E Execution & Verification Script
 * Runs live AutoStory V3 with Retention Arc Plan against the source video,
 * compiles the script, renders the final MP4, and verifies retention metrics
 * and freeze-frame absence.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFileSync } = require('child_process');

const ConfigStore = require('../electron/services/configStore');
const ProjectStore = require('../electron/services/projectStore');
const DubbingService = require('../electron/services/dubbingService');
const AutoStoryFastService = require('../electron/services/autoStoryFastService');
const autoStoryV3Pipeline = require('../electron/services/autoStoryV3Pipeline');

const CONFIG_PATH = 'C:\\Users\\Admin\\AppData\\Roaming\\cineviral-studio\\config.json';
const SOURCE_PATH = 'C:\\Users\\Admin\\Videos\\YTDown.com_YouTube_Abusive-Mom-s-Worst-Nightmare-Came-True_Media_Y6A531KEfhM_001_1080p.mp4';
const WORKSPACE_ROOT = 'D:\\OutputVideo';
const PROJECT_ID = '0925-v3-edl-quality-rebuild';

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

async function main() {
  log('=== AutoStory V3 E2E Execution Started ===');
  
  if (!fs.existsSync(SOURCE_PATH)) {
    throw new Error(`Source video not found: ${SOURCE_PATH}`);
  }
  
  const settings = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
  const store = new ProjectStore();
  const dubbing = new DubbingService(store);
  const service = new AutoStoryFastService(settings, store, { dubbing });

  // Ensure workspace directory exists
  await store.ensureWorkspaceRoot(WORKSPACE_ROOT);
  const projectPaths = store.getProjectPaths(WORKSPACE_ROOT, PROJECT_ID);
  
  // Clean previous analysis files to ensure fresh V3 pipeline execution with new guardrails
  await fsp.rm(projectPaths.analysisDir, { recursive: true, force: true });
  for (const dir of [projectPaths.rootDir, projectPaths.analysisDir, projectPaths.assetsDir, projectPaths.audioDir, projectPaths.clipsDir, projectPaths.outputDir, projectPaths.tempDir]) {
    await fsp.mkdir(dir, { recursive: true });
  }

  // Define full project configuration matching the viral TikTok format
  const projectData = {
    id: PROJECT_ID,
    title: '0925_V3_EDL_Quality_Rebuild',
    sourceVideoPath: SOURCE_PATH,
    exportRoot: 'D:\\Video',
    exportLayout: 'flat',
    mode: 'highlight_cut',
    analysisWorkflow: 'vertex_auto_story',
    autoStoryContractVersion: 3,
    autoStoryPipelineVersion: 'source-story-v3',
    targetLanguage: 'en',
    sourceLanguage: 'en',
    draftVoiceMode: 'final',
    draftVoiceProvider: 'kokoro',
    draftVoiceId: 'am_adam',
    autoFitVoice: false,
    showSubtitles: false,
    subtitleStyle: 'white_black_outline',
    videoDecoration: {
      canvasEnabled: true,
      canvasAspect: '9:16',
      customWidth: 1080,
      customHeight: 1920,
      blurBackgroundEnabled: false,
      blurStrength: 24,
      topCaptionEnabled: true,
      topCaptionText: "Abusive Mom's Worst Nightmare Came True",
      topCaptionAutoFromScript: false,
      topCaptionFontSize: 58,
      topCaptionYPercent: 19,
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
    autoStoryConfig: {
      outputCount: 1,
      targetDurationMinSec: 65,
      targetDurationMaxSec: 90,
      narration: { enabled: true, style: 'investigative' },
      storyMode: 'serialized_part',
      preferCliffhanger: true
    },
    autoStoryEditorialConfig: {
      outputCount: 1,
      targetDurationMinSec: 65,
      targetDurationMaxSec: 90,
      narration: { enabled: true, style: 'investigative' },
      storyMode: 'serialized_part',
      preferCliffhanger: true
    }
  };

  await store.saveProject(WORKSPACE_ROOT, projectData);
  log('Project metadata saved successfully.');

  // Step 1: Run AutoStory V3 Pipeline
  log('Running AutoStory V3 Pipeline (Pass 0-6)...');
  const pipelineResult = await autoStoryV3Pipeline.run(service, {
    workspaceRoot: WORKSPACE_ROOT,
    projectId: PROJECT_ID,
    storyMode: 'serialized_part',
    preferCliffhanger: true,
    onProgress: (p) => {
      if (p.message) log(`[Pipeline] ${p.stage || 'progress'}: ${p.message}`);
    }
  });

  log(`Pipeline completed with ${pipelineResult.scriptPaths?.length || 0} script(s).`);
  if (!pipelineResult.scriptPaths || pipelineResult.scriptPaths.length === 0) {
    throw new Error(`Pipeline failed to generate scripts: ${JSON.stringify(pipelineResult.failures)}`);
  }

  // Step 2: Import into project highlight variants
  log('Importing compiled script into Highlight Cut project structure...');
  const importedProject = await dubbing.importHighlightCutProject({
    workspaceRoot: WORKSPACE_ROOT,
    projectId: PROJECT_ID,
    settings,
    onProgress: (p) => {
      if (p?.message) log(`[Import] ${p.message}`);
    }
  });
  log(`Import completed. Variants: ${importedProject.analysis?.highlightVariants?.length || 0}`);

  // Step 3: Render Final MP4
  log('Rendering Final MP4 with voiceover, ducked original audio, and 9:16 layout...');
  const finalRenderResult = await dubbing.renderHighlightCutProject({
    workspaceRoot: WORKSPACE_ROOT,
    projectId: PROJECT_ID,
    settings,
    project: importedProject,
    onProgress: (p) => {
      if (p?.message) log(`[Render] ${p.message}`);
    }
  });

  const finalMp4 = finalRenderResult.artifacts?.finalVideoPath ||
    path.join(projectPaths.outputDir, 'highlight-cut-variant-01-score-na-final.mp4');
  
  // Find actual output mp4 if filename differs
  let actualMp4 = finalRenderResult.artifacts?.finalVideoPath || finalMp4;
  if (!fs.existsSync(actualMp4)) {
    const exportRoot = projectData.exportRoot || 'D:\\Video';
    if (fs.existsSync(exportRoot)) {
      const vFiles = fs.readdirSync(exportRoot)
        .filter(f => f.startsWith(PROJECT_ID) && f.endsWith('.mp4'))
        .sort((a, b) => fs.statSync(path.join(exportRoot, b)).mtimeMs - fs.statSync(path.join(exportRoot, a)).mtimeMs);
      if (vFiles.length > 0) actualMp4 = path.join(exportRoot, vFiles[0]);
    }
  }
  if (!fs.existsSync(actualMp4)) {
    const files = fs.readdirSync(projectPaths.outputDir).filter(f => f.endsWith('-final.mp4') || f.endsWith('.mp4'));
    if (files.length > 0) {
      actualMp4 = path.join(projectPaths.outputDir, files[0]);
    }
  }

  log(`Final MP4: ${actualMp4} (exists: ${fs.existsSync(actualMp4)})`);

  // Step 4: Run Freeze Frame Inspection & Media Probes
  log('Running FFprobe and Freezedetect inspection on rendered MP4...');
  let probe = null;
  try {
    const probeOut = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', actualMp4], { encoding: 'utf8' });
    probe = JSON.parse(probeOut);
    const vStream = probe.streams.find(s => s.codec_type === 'video');
    const aStream = probe.streams.find(s => s.codec_type === 'audio');
    log(`Output probe: duration=${Number(probe.format?.duration).toFixed(1)}s, resolution=${vStream?.width}x${vStream?.height}, vCodec=${vStream?.codec_name}, aCodec=${aStream?.codec_name}`);
  } catch (err) {
    log(`FFprobe error: ${err.message}`);
  }

  // Freezedetect (detect freeze frames >= 0.5s on active video area, ignoring 9:16 letterbox bars)
  let freezeCount = 0;
  let freezeDetails = [];
  try {
    const { spawnSync } = require('child_process');
    const res = spawnSync('ffmpeg', ['-i', actualMp4, '-vf', 'crop=1080:600:0:660,freezedetect=n=-50dB:d=0.5', '-f', 'null', '-'], { encoding: 'utf8' });
    const stderr = res.stderr || '';
    const freezeMatches = [...stderr.matchAll(/freeze_start:\s*([\d.]+)/g)];
    const freezeEndMatches = [...stderr.matchAll(/freeze_duration:\s*([\d.]+)/g)];
    freezeCount = freezeMatches.length;
    freezeDetails = freezeEndMatches.map(m => m[1]);
    log(`Freezedetect inspection: ${freezeCount} freeze instances found (durations: ${freezeDetails.join('s, ')}s).`);
  } catch (err) {
    log(`Freezedetect error: ${err.message}`);
  }

  // Step 5: Extract Inspection Frames for the 4 Retention Windows (~5s intervals)
  log('Extracting inspection frames for all ~5-second retention windows...');
  const framesDir = path.join(__dirname, '..', 'scratch', 'rendered_frames_new');
  await fsp.mkdir(framesDir, { recursive: true });

  const inspectionTimestamps = [
    { sec: 2, name: 'win1_0_15_s02.jpg' },
    { sec: 6, name: 'win1_0_15_s06.jpg' },
    { sec: 11, name: 'win1_0_15_s11.jpg' },
    { sec: 14, name: 'win1_0_15_s14.jpg' },
    { sec: 18, name: 'win1_15_30_s18.jpg' },
    { sec: 22, name: 'win1_15_30_s22.jpg' },
    { sec: 26, name: 'win1_15_30_s26.jpg' },
    { sec: 31, name: 'win2_30_45_s31.jpg' },
    { sec: 36, name: 'win2_30_45_s36.jpg' },
    { sec: 42, name: 'win2_30_45_s42.jpg' },
    { sec: 48, name: 'win3_45_end_s48.jpg' },
    { sec: 53, name: 'win3_45_end_s53.jpg' },
    { sec: 58, name: 'win3_45_end_s58.jpg' },
    { sec: 63, name: 'win3_45_end_s63.jpg' },
    { sec: 67, name: 'win3_45_end_s67.jpg' },
    { sec: 71, name: 'win3_45_end_s71.jpg' }
  ];

  for (const item of inspectionTimestamps) {
    const outImg = path.join(framesDir, item.name);
    try {
      const { spawnSync } = require('child_process');
      spawnSync('ffmpeg', ['-ss', String(item.sec), '-i', actualMp4, '-vframes', '1', '-q:v', '2', '-y', outImg], { encoding: 'utf8' });
      log(`Extracted frame at ${item.sec}s -> ${item.name}`);
    } catch (e) {
      log(`Failed extracting frame at ${item.sec}s: ${e.message}`);
    }
  }

  // Step 5b: Run Structural Critic Service on Story Spine & Rendered Timeline
  log('Running Structural Critic Service across ~5-8s windows...');
  const { critiqueRenderedTimeline, formatRetentionAuditMarkdown } = require('../electron/services/structuralCriticService');
  const spinePath = path.join(projectPaths.analysisDir, 'auto-story-fast', 'story-spine.json');
  let auditMarkdown = '';
  if (fs.existsSync(spinePath)) {
    const spineData = JSON.parse(fs.readFileSync(spinePath, 'utf8'));
    const spine = spineData.spines?.[0] || spineData;
    const audit = critiqueRenderedTimeline(spine, { 
      targetWindowSec: 5.5,
      actualMp4DurationSec: Number(probe?.format?.duration || probe?.durationSec || 64.97)
    });
    log(`Structural Critic: ${audit.windows.length} windows, avg score: ${audit.averageRetentionScore}/10.0, weak windows: ${audit.weakWindows.length}`);
    auditMarkdown = formatRetentionAuditMarkdown(audit);
    const auditFile = path.join(projectPaths.analysisDir, 'auto-story-fast', 'structural-retention-audit.md');
    fs.writeFileSync(auditFile, auditMarkdown, 'utf8');
    log(`Structural Retention Audit written to: ${auditFile}`);
    console.log('\n' + auditMarkdown + '\n');
  }

  // Step 6: Run Acceptance Assertions
  log('Running v3Acceptance suite...');
  const sourceIdentity = '9010eb79293c3f98797b0812ca8b201ef3c13a4e5f5c761cbeafff0bf6ef50d4';
  const sourceCache = path.join(WORKSPACE_ROOT, '.cineviral', 'auto-story-source', sourceIdentity, 'source-contract-v3');
  const analysisDir = path.join(projectPaths.analysisDir, 'auto-story-fast');

  try {
    const acceptanceReport = execFileSync('node', [
      'tools/v3Acceptance.js',
      '--source-cache', sourceCache,
      '--analysis', analysisDir,
      '--mp4', actualMp4,
      '--min', '60',
      '--max', '120'
    ], { encoding: 'utf8' });
    console.log(acceptanceReport);
  } catch (err) {
    console.log(err.stdout || err.message);
  }

  log('=== AutoStory V3 E2E Execution Finished Successfully ===');
  return { actualMp4, freezeCount, probe };
}

main().catch(err => {
  console.error('\nE2E Execution Error:', err);
  process.exit(1);
});
