// Automated final-export gate for Vertex Auto Story. Only an independently
// reviewed MP4 with a successful FINAL render is eligible for publication.
const fs = require('fs/promises');
const path = require('path');
const FfmpegService = require('./ffmpegService');

function assess({ audit, media, bytes, file, config = {}, renderQa = null }) {
  const issues = [];
  if (audit?.finalCheck?.verdict !== 'PASS' || audit?.needsUserReview) issues.push('AI media review has not passed.');
  if (!file || path.extname(file).toLowerCase() !== '.mp4' || bytes <= 4096) issues.push('Final MP4 missing or empty.');
  if (!(media?.duration > 0)) issues.push('Final MP4 has no readable duration.');
  if (!media?.hasAudio) issues.push('Final MP4 has no audio track.');
  if (!media?.width || !media?.height || media.width >= media.height
    || Math.abs(media.width / media.height - 9 / 16) > 0.06) issues.push('Final MP4 must be portrait 9:16.');
  if (media?.width < 720 || media?.height < 1280) issues.push('Final MP4 resolution is below 720x1280.');
  const min = Number(config.targetDurationMinSec), max = Number(config.targetDurationMaxSec);
  if (Number.isFinite(min) && min > 0 && media?.duration < min - 0.75) issues.push('Final duration below requested minimum.');
  if (Number.isFinite(max) && max > 0 && media?.duration > max + 0.75) issues.push('Final duration exceeds requested maximum.');
  if (renderQa?.passed === false) issues.push('Final render QA reported failure.');
  return { status: issues.length ? 'needs_attention' : 'ready_to_publish', issues,
    finalVideoPath: file || '', media: media || null, bytes: Number(bytes) || 0,
    checkedAt: new Date().toISOString() };
}

async function finalizeVariant({ store, dubbing, workspaceRoot, projectId, scriptId, settings = {}, audit, onProgress, probe = null }) {
  if (!audit || audit.finalCheck?.verdict !== 'PASS' || audit.needsUserReview) return audit;
  const record = path.join(store.getProjectPaths(workspaceRoot, projectId).analysisDir, 'auto-story-fast', `review-state-${scriptId}.json`);
  let release;
  try {
    const project = await store.getProject(workspaceRoot, projectId);
    const variant = project.analysis?.highlightVariants?.find(v => Number(v.scriptId) === Number(scriptId));
    if (!variant) throw new Error('Reviewed Auto Story variant missing.');
    let output = variant.artifacts?.finalVideoPath || '';
    const existingFinalAt = Date.parse(variant.artifacts?.finalRenderedAt || '') || 0;
    const latestDraftAt = Date.parse(variant.artifacts?.fastDraftRenderedAt || '') || 0;
    const reusable = output && existingFinalAt >= latestDraftAt
      && await fs.stat(output).then(s => s.size > 4096).catch(() => false);
    if (!reusable) {
      onProgress?.({ stage: 'final_export', message: `Script ${scriptId}: rendering full-quality final MP4` });
      await dubbing.renderHighlightCutProject({ workspaceRoot, projectId, settings, onProgress,
        project: { ...project, analysis: { ...project.analysis, activeVariantId: variant.id, segments: variant.segments } } });
    }
    const updated = await store.getProject(workspaceRoot, projectId);
    const finalVariant = updated.analysis?.highlightVariants?.find(v => Number(v.scriptId) === Number(scriptId));
    output = finalVariant?.artifacts?.finalVideoPath || output;
    const stat = await fs.stat(output);
    const ffmpeg = probe ? null : new FfmpegService(settings);
    const media = probe ? await probe(output) : await ffmpeg.probeVideo(output);
    const reportPath = finalVariant?.artifacts?.renderQaPath;
    const renderQa = reportPath ? await fs.readFile(reportPath, 'utf8').then(JSON.parse).catch(() => null) : null;
    release = assess({ audit, media, bytes: stat.size, file: output, config: updated.autoStoryEditorialConfig || updated.autoStoryConfig, renderQa });
    if (settings.autoStoryFinalFullDecode === true && release.status === 'ready_to_publish') {
      await ffmpeg.run(ffmpeg.ffmpegPath, ['-v', 'error', '-xerror', '-i', output, '-f', 'null', '-'], { captureStdout: false });
    }
  } catch (err) {
    release = { status: 'needs_attention', issues: [`Final export/QA failed: ${err.message}`], checkedAt: new Date().toISOString(), finalVideoPath: '' };
  }
  const ready = release.status === 'ready_to_publish';
  const updatedAudit = { ...audit, releaseGate: release, needsUserReview: !ready,
    finalCheck: ready ? audit.finalCheck : { ...audit.finalCheck, verdict: 'NEEDS_ATTENTION',
      issues: release.issues.map(reason => ({ reason })) } };
  await fs.mkdir(path.dirname(record), { recursive: true });
  await fs.writeFile(record, JSON.stringify(updatedAudit, null, 2));
  return updatedAudit;
}
module.exports = { assess, finalizeVariant };
