'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFileSync } = require('child_process');

const { critiqueMediaGroundedTimeline, formatRetentionAuditMarkdown } = require('../electron/services/structuralCriticService');
const VertexAiService = require('../electron/services/vertexAiService');

const CONFIG_PATH = 'C:\\Users\\Admin\\AppData\\Roaming\\cineviral-studio\\config.json';
const MP4_PATH = 'D:\\OutputVideo\\v4-production-live-e2e\\.variant-workers\\1\\v4-production-live-e2e\\output\\abusive-mom-s-worst-nightmare-came-true-highlight-draft-variant-01-score-na-a-chaotic-domestic-d-20260929070813.mp4';
const SPINE_PATH = 'D:\\OutputVideo\\v4-production-live-e2e\\analysis\\auto-story-fast\\story-spine.json';
const OUTPUT_JSON_PATH = 'D:\\OutputVideo\\v4-production-live-e2e\\analysis\\auto-story-fast\\media-audit-viewer-state-regression.json';

function probeDuration(filePath) {
  const out = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ], { encoding: 'utf8' }).trim();
  return Number(out);
}

async function main() {
  console.log('=== AUTOSTORY V4 — MEDIA CRITIC VIEWER-PERCEIVED PROGRESSION REGRESSION ===\n');

  if (!fs.existsSync(MP4_PATH)) {
    throw new Error(`Regression MP4 not found at: ${MP4_PATH}`);
  }
  if (!fs.existsSync(SPINE_PATH)) {
    throw new Error(`Spine not found at: ${SPINE_PATH}`);
  }

  const durationSec = probeDuration(MP4_PATH);
  console.log(`Regression MP4: ${MP4_PATH}`);
  console.log(`Duration: ${durationSec.toFixed(2)}s`);

  const spineRaw = JSON.parse(await fsp.readFile(SPINE_PATH, 'utf8'));
  const spine = Array.isArray(spineRaw.spines) ? spineRaw.spines[0] : spineRaw;

  const config = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
  const ai = new VertexAiService(config);

  console.log('\nInvoking updated Media-Grounded Critic (watching pixels on Vertex Gemini)...');
  const t0 = Date.now();

  const auditResult = await critiqueMediaGroundedTimeline(spine, {
    aiService: ai,
    mp4Path: MP4_PATH,
    actualMp4DurationSec: durationSec,
    targetWindowSec: 5.5
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Critic completed in ${elapsed}s. Status: ${auditResult.status}`);

  // Persist result
  await fsp.writeFile(OUTPUT_JSON_PATH, JSON.stringify(auditResult, null, 2), 'utf8');
  console.log(`\nPersisted audit result to: ${OUTPUT_JSON_PATH}`);

  // Also print formatted report
  console.log('\n=== WINDOW-BY-WINDOW PROGRESSION AUDIT TABLE ===');
  const tableData = (auditResult.windows || []).map(w => ({
    time: w.outputTimeFormatted,
    primarySubject: w.visualState?.primarySubject || w.primarySubject || 'N/A',
    locationState: w.visualState?.locationState || w.locationState || 'N/A',
    activityState: w.visualState?.activityState || w.activityState || 'N/A',
    viewerStateChanged: w.viewerStateChanged,
    semanticProgress: `B:${w.viewerBeliefChange ? 1 : 0} C:${w.caseStateChange ? 1 : 0} S:${w.stakesChange ? 1 : 0} F:${w.futureConsequenceChange ? 1 : 0}`,
    viewerStatePlateauSec: w.viewerStatePlateauSec,
    talkingStateRunSec: w.talkingStateRunSec,
    causalLinkFromPrevious: w.causalLinkFromPrevious,
    visualObservability: w.visualObservability,
    retentionScore: w.retentionScore,
    weakReason: w.weakReason
  }));
  console.table(tableData);

  console.log('\n=== SUMMARY METRICS ===');
  console.log(`mp4Duration: ${auditResult.mp4Duration}s`);
  console.log(`auditedSeconds: ${auditResult.auditedSeconds}s`);
  console.log(`auditCoverageRatio: ${auditResult.auditCoverageRatio}`);
  console.log(`criticObservedScore: ${auditResult.criticObservedScore}/10`);
  console.log(`averageRetentionScore: ${auditResult.averageRetentionScore}/10`);
  console.log(`maxSemanticPlateau (noProgressRunSec): ${auditResult.noProgressRunSec}s`);
  console.log(`maxViewerStatePlateau: ${auditResult.viewerStatePlateauSec}s`);
  console.log(`maxTalkingPlateau: ${auditResult.talkingPlateauSec}s`);
  console.log(`weakWindows count: ${auditResult.weakWindows?.length ?? 0}`);
  console.log(`endingValid: ${auditResult.endingValid}`);
  console.log(`isCompliant: ${auditResult.isCompliant}`);

  console.log('\n=== OBSERVATION VERIFICATION ===');
  console.log(`1. Long persistent conversational states observed: ${auditResult.talkingPlateauSec > 10 ? 'YES' : 'NO'} (${auditResult.talkingPlateauSec}s)`);
  console.log(`2. Viewer-state plateau observed: ${auditResult.viewerStatePlateauSec > 10 ? 'YES' : 'NO'} (${auditResult.viewerStatePlateauSec}s)`);
  const finalWin = auditResult.windows?.[auditResult.windows.length - 1];
  console.log(`3. Final window visual observability: ${finalWin?.visualObservability} (obscured/black: ${['mostly_obscured', 'black_or_unusable'].includes(finalWin?.visualObservability) ? 'YES' : 'NO'})`);
}

main().catch(err => {
  console.error('Regression run error:', err);
  process.exit(1);
});
