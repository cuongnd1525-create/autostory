#!/usr/bin/env node
'use strict';
/**
 * AUTOSTORY — STORY SCOPE + MEDIA-GROUNDED DIRECTOR — REAL PRODUCTION BENCHMARK
 *
 * Development tool (not a runtime dependency). Runs the normal production flow:
 *   AutoStoryRunner -> V3 pipeline (contract 4 => scope_media_director)
 *   -> Source Story Model (cache-first; reused if identity/version match)
 *   -> Story Scope selection (Gemini) -> scope reel -> Editorial Director (Gemini watches reel)
 *   -> buildScript (validator-only downstream) -> render -> scope-aware media critic
 *   -> targeted director repair (<=2) -> final render.
 *
 * It does NOT inject an EDL, does NOT supply timestamps, and the viral reference
 * is NOT available to the runtime. Usage (Windows, from the repo root):
 *   node tools/run-scope-director-benchmark.js
 * Optional env: BENCH_SOURCE, BENCH_WORKSPACE, BENCH_PROJECT_ID, BENCH_CONFIG.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFileSync } = require('child_process');
const ProjectStore = require('../electron/services/projectStore');
const DubbingService = require('../electron/services/dubbingService');
const AutoStoryRunner = require('../electron/services/autoStoryRunner');

const CONFIG_PATH = process.env.BENCH_CONFIG || 'C:\\Users\\Admin\\AppData\\Roaming\\cineviral-studio\\config.json';
const SOURCE_PATH = process.env.BENCH_SOURCE || 'C:\\Users\\Admin\\Videos\\YTDown.com_YouTube_Abusive-Mom-s-Worst-Nightmare-Came-True_Media_Y6A531KEfhM_001_1080p.mp4';
const WORKSPACE_ROOT = process.env.BENCH_WORKSPACE || 'D:\\OutputVideo';
const PROJECT_ID = process.env.BENCH_PROJECT_ID || 'v5-scope-director-benchmark';

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
  if (fs.existsSync(paths.rootDir)) { log(`Cleaning previous benchmark project ${paths.rootDir}`); await fsp.rm(paths.rootDir, { recursive: true, force: true }); }
  for (const d of [paths.rootDir, paths.analysisDir, paths.assetsDir, paths.audioDir, paths.clipsDir, paths.outputDir, paths.tempDir]) await fsp.mkdir(d, { recursive: true });

  const autoStoryConfig = {
    outputCount: 1, targetDurationMinSec: 65, targetDurationMaxSec: 90,
    narration: { enabled: true, style: 'investigative' }, storyMode: 'serialized_part', preferCliffhanger: true,
    editorialArchitecture: 'scope_media_director'
  };
  await store.saveProject(WORKSPACE_ROOT, {
    id: PROJECT_ID, title: 'Scope Director Benchmark', sourceVideoPath: SOURCE_PATH,
    exportRoot: 'D:\\Video', exportLayout: 'flat', mode: 'highlight_cut', analysisWorkflow: 'vertex_auto_story',
    autoStoryContractVersion: 4, autoStoryPipelineVersion: 'source-story-v3',
    targetLanguage: 'en', sourceLanguage: 'en', draftVoiceMode: 'final', draftVoiceProvider: 'kokoro', draftVoiceId: 'am_adam',
    autoFitVoice: false, showSubtitles: false, subtitleStyle: 'white_black_outline',
    videoDecoration: { canvasEnabled: true, canvasAspect: '9:16', customWidth: 1080, customHeight: 1920, blurBackgroundEnabled: false, blurStrength: 24,
      topCaptionEnabled: false, foregroundScalePercent: 100, foregroundXPercent: 50, foregroundYPercent: 50 },
    mixer: { voiceVolume: 100, sourceVolume: 28, narrationSourceAudioOverride: true, narrationDuckDefault: true, bgmVolume: 40, ducking: 70, bgmPath: '' },
    autoStoryConfig, autoStoryEditorialConfig: autoStoryConfig
  });

  const runner = new AutoStoryRunner(settings, store, dubbing);
  const t0 = Date.now();
  let runtimeError = null;
  try {
    await runner.run({ workspaceRoot: WORKSPACE_ROOT, projectId: PROJECT_ID, scriptId: 1,
      onProgress: p => log(`${p.percent !== undefined ? `[${p.percent}%] ` : ''}${p.stage ? `<${p.stage}> ` : ''}${p.message || ''}`) });
  } catch (e) { runtimeError = e; log(`Runner error: ${e.message}`); }
  log(`Runner finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const A = path.join(paths.analysisDir, 'auto-story-fast');
  const scope = await readJson(path.join(A, 'story-scope.json'));
  const spineDoc = await readJson(path.join(A, 'story-spine.json'));
  const spine = spineDoc?.spines?.[0] || null;
  const review = await readJson(path.join(A, 'review-state-1.json'));
  const audits = ['initial-media-audit-1.json', 'repair-1-media-audit-1.json', 'repair-2-media-audit-1.json'];
  const lastAudit = (await Promise.all(audits.map(f => readJson(path.join(A, f))))).filter(Boolean).pop() || null;
  const mp4s = [paths.outputDir, path.join(paths.rootDir, '.variant-workers', '1', PROJECT_ID, 'output')]
    .filter(d => fs.existsSync(d)).flatMap(d => fs.readdirSync(d).filter(f => f.endsWith('.mp4')).map(f => path.join(d, f)))
    .map(f => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => a.m - b.m).map(x => x.f);
  const finalMp4 = mp4s[mp4s.length - 1] || null;
  const finalDuration = finalMp4 ? probe(finalMp4) : null;
  const costs = await readJson(path.join(A, 'run-costs.json'));
  const directorCalls = (costs?.entries || []).filter(e => /^v5-editorial-director/.test(e.stage || '')).map(e => ({ stage: e.stage, cached: !!e.cached,
    promptTokens: e.promptTokens ?? e.inputTokens ?? null, candidatesTokens: e.candidatesTokens ?? null, thoughtsTokens: e.thoughtsTokens ?? null,
    totalTokens: e.totalTokens ?? null, maxOutputTokens: e.requestedMaxOutputTokens ?? null, thinkingBudget: e.requestedThinkingBudget ?? null,
    finishReason: e.finishReason || '', modelMs: e.modelMs ?? null, usd: e.usd ?? null, error: e.error || '' }));
  // On a failed run there is no stamped spine: rebuild the path from the per-call artifacts.
  const attemptFiles = spine?.directorMeta?.attempts ? [] : fs.readdirSync(A).filter(f => /^v5-editorial-director-1(_(fix|duration|compress)\d+)?\.json$/.test(f))
    .map(f => ({ f, m: fs.statSync(path.join(A, f)).mtimeMs })).sort((a, b) => a.m - b.m);
  const fromFiles = await Promise.all(attemptFiles.map(async ({ f }, i) => { const j = await readJson(path.join(A, f)); return { attempt: i, mode: j?.mode, valid: j?.validation?.valid,
    metrics: j?.validation?.metrics, violations: j?.validation?.violations || [], durationCompression: j?.durationCompression, beatCountBefore: j?.beatCountBefore, beatCountAfter: j?.beatCountAfter }; }));
  const directorAttempts = (spine?.directorMeta?.attempts || fromFiles).map(a => ({ attempt: a.attempt, mode: a.mode, valid: a.valid, mediaFiles: a.mediaFiles,
    totalSec: a.metrics?.totalSec ?? null, beatCount: a.metrics?.beatCount ?? null, violations: (a.violations || []).map(v => v.code), technicalDurationAdjustment: a.technicalDurationAdjustment || null,
    ...(a.durationCompression ? { compressedFromSec: a.durationCompression.currentDurationSec, beatsBefore: a.beatCountBefore, beatsAfter: a.beatCountAfter,
      requiredReductionToMaximumSec: a.durationCompression.requiredReductionToMaximumSec, preferredReductionToTargetSec: a.durationCompression.preferredReductionToTargetSec,
      preferredReductionRangeSec: a.durationCompression.preferredReductionRangeSec || null } : {}) }));

  // Delivery report: compiled blocks (script) joined with the renderer's measured block voice.
  const scriptDoc = await readJson(path.join(A, 'script-1.json'));
  const renderDirs = [paths.outputDir, path.join(paths.rootDir, '.variant-workers', '1', PROJECT_ID, 'output')].filter(d => fs.existsSync(d));
  const blockReports = renderDirs.flatMap(d => fs.readdirSync(d).filter(f => f.endsWith('-delivery-blocks.json')).map(f => path.join(d, f)))
    .map(f => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => a.m - b.m).map(x => x.f);
  const rendered = blockReports.length ? await readJson(blockReports[blockReports.length - 1]) : null;
  const compiledBlocks = scriptDoc?.delivery_blocks || [];
  const deliveryReport = compiledBlocks.map((b, i) => {
    const r = (rendered?.blocks || []).find(x => x.blockId === b.blockId) || {};
    return { blockId: b.blockId, mode: b.mode, beatIds: b.beatIds, outputStartSec: b.outputStartSec, outputEndSec: b.outputEndSec, durationSec: b.durationSec,
      storyFunction: b.storyFunction || '', narratorFunction: b.narratorFunction || '', narrationIntent: b.narrationIntent || '', narrationText: b.narrationText || '',
      rawTtsSec: r.rawTtsSec ?? b.rawBlockVoiceSec ?? null, fittedTtsSec: r.fittedTtsSec ?? null, fitRatio: r.fitRatio ?? b.fitRatio ?? null,
      sourceAudioTreatment: b.sourceAudioTreatment, handoffFrom: compiledBlocks[i - 1]?.blockId || null, handoffTo: compiledBlocks[i + 1]?.blockId || null,
      handoffTargetBeatId: b.handoffTargetBeatId || null };
  });
  if (deliveryReport.length) await fsp.writeFile(path.join(A, 'delivery-report.json'), JSON.stringify({ contract: scriptDoc?.delivery_contract || null, blocks: deliveryReport, renderedBlockReport: blockReports[blockReports.length - 1] || null }, null, 2));

  const summary = {
    generatedAt: new Date().toISOString(), runtimeError: runtimeError?.message || null,
    deliveryBlocks: deliveryReport,
    storyScope: scope?.chosen || null, scopeReel: scope?.reel || null, scopeCandidates: (scope?.candidates || []).map(c => ({ id: c.storyScopeId, question: c.centralViewerQuestion, boundary: c.explicitScopeBoundary })),
    editorialContract: spine?.editorialContract || null,
    finalEdl: (spine?.beats || []).map(b => ({ beatId: b.beatId, sourceStartSec: b.sourceStartSec, sourceEndSec: b.sourceEndSec, dur: +(b.sourceEndSec - b.sourceStartSec).toFixed(2),
      chronologyMode: b.chronologyMode, narrativeRole: b.narrativeRole, scopeMembership: b.scopeMembership, audioMode: b.audioMode, observedInFootage: b.observedInFootage, whyNecessaryNow: b.whyNecessaryNow })),
    directorCalls, directorAttempts, edlBeatCount: (spine?.beats || []).length,
    edlTotalSec: +((spine?.beats || []).reduce((n, b) => n + (b.sourceEndSec - b.sourceStartSec), 0)).toFixed(2),
    finalMp4, finalDuration, allMp4s: mp4s.map(f => ({ f, duration: probe(f) })),
    review: review ? { verdict: review.finalCheck?.verdict, repairPasses: review.repairPasses ?? 0, metrics: review.metrics, issues: review.finalCheck?.issues } : null,
    lastCritic: lastAudit ? { scopeSurvived: lastAudit.scopeSurvived, centralQuestionActiveThroughout: lastAudit.centralQuestionActiveThroughout, endingIsConsequence: lastAudit.endingIsConsequence,
      finalFootageUsable: lastAudit.finalFootageUsable, coldViewerCanFollow: lastAudit.coldViewerCanFollow ?? null, coldViewerNotes: lastAudit.coldViewerNotes || '',
      deliveryIssues: lastAudit.deliveryIssues || [], observedStory: lastAudit.observedStory, issues: lastAudit.issues } : null
  };
  const out = path.join(A, 'benchmark-summary.json');
  await fsp.writeFile(out, JSON.stringify(summary, null, 2));
  log(`Story Scope: ${summary.storyScope?.storyScopeId} — ${summary.storyScope?.centralViewerQuestion}`);
  log(`Boundary: ${JSON.stringify(summary.storyScope?.explicitScopeBoundary)}`);
  console.table(summary.finalEdl.map(({ observedInFootage, whyNecessaryNow, ...r }) => r));
  if (directorCalls.length) console.table(directorCalls.map(({ error, ...r }) => r));
  if (directorAttempts.length) log(`Director repair path: ${directorAttempts.map(a => `${a.mode}[${a.totalSec}s/${a.beatCount} beats${a.requiredReductionToMaximumSec !== undefined ? `; from ${a.compressedFromSec}s must cut >=${a.requiredReductionToMaximumSec}s, prefer ~${a.preferredReductionToTargetSec}s` : ''}]${a.valid ? '✓' : `✗(${a.violations.join('+')})`}`).join(' -> ')}`);
  if (deliveryReport.length) console.table(deliveryReport.map(b => ({ blockId: b.blockId, mode: b.mode, beats: b.beatIds.join(','), out: `${Number(b.outputStartSec).toFixed(1)}-${Number(b.outputEndSec).toFixed(1)}`,
    rawTts: b.rawTtsSec, fitted: b.fittedTtsSec, fit: b.fitRatio, audio: b.sourceAudioTreatment })));
  log(`EDL beats ${summary.edlBeatCount} | EDL total ${summary.edlTotalSec}s | final MP4 ${finalMp4} (${finalDuration}s) | verdict ${summary.review?.verdict} | repairs ${summary.review?.repairPasses}`);
  log(`Summary written: ${out}`);
  const inRange = finalDuration >= 65 && finalDuration <= 90;
  console.log(!runtimeError && finalMp4 && inRange ? 'BENCHMARK RUN COMPLETE (review story quality with the comparison step)' : `BENCHMARK RUN INCOMPLETE — ${runtimeError?.message || `duration ${finalDuration}s`}`);
  if (runtimeError) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
