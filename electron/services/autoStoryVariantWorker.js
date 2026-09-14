const fs = require('fs/promises');
const path = require('path');
const Store = require('./projectStore');
const Dubbing = require('./dubbingService');
const Service = require('./autoStoryFastService');
const { serial } = require('./autoStoryWorkQueue');

// Each variant owns its journal, media and mutable project snapshot.
async function run({ settings, store, workspaceRoot, projectId, scriptId, scriptPath, signal, onProgress, callBudget }) {
  const base = store.getProjectPaths(workspaceRoot, projectId);
  const workerRoot = path.join(base.rootDir, '.variant-workers', String(scriptId));
  const local = new Store(), paths = local.getProjectPaths(workerRoot, projectId);
  // saveProject writes metadata only; workers also need the normal media workspace.
  for (const key of ['rootDir', 'analysisDir', 'assetsDir', 'audioDir', 'clipsDir', 'outputDir', 'tempDir']) {
    await fs.mkdir(paths[key], { recursive: true });
  }
  const parent = await store.getProject(workspaceRoot, projectId);
  const sourceAnalysis = path.join(base.analysisDir, 'auto-story-fast');
  const analysis = path.join(paths.analysisDir, 'auto-story-fast');
  await fs.mkdir(analysis, { recursive: true });
  const previous = await local.getProject(workerRoot, projectId).catch(() => null);
  const variant = parent.analysis?.highlightVariants?.find(v => Number(v.scriptId) === scriptId);
  // Preserve private recovery journals only while the parent revision is unchanged.
  const identity = JSON.stringify(variant || { scriptPath });
  if (previous?.workerParentIdentity !== identity) {
    for (const entry of await fs.readdir(analysis)) {
      if (/^(review-|before-review-|final-check-)/.test(entry) && entry.endsWith('.json')) await fs.rm(path.join(analysis, entry), { force: true });
    }
  }
  for (const name of ['plan.json', `evidence-${scriptId}.json`, `edit-${scriptId}.json`]) {
    await fs.copyFile(path.join(sourceAnalysis, name), path.join(analysis, name));
  }
  await local.saveProject(workerRoot, { ...parent, workerParentIdentity: identity,
    storyScriptPaths: scriptPath ? [scriptPath] : [], storyScriptPath: scriptPath || '',
    analysis: variant ? { ...parent.analysis, highlightVariants: [variant], activeVariantId: variant.id, segments: variant.segments } : null,
    artifacts: variant?.artifacts || {}, exportRoot: paths.outputDir });
  const dubbing = new Dubbing(local);
  const service = new Service(settings, local, { dubbing, callBudget });
  const publish = async () => serial(`variant-commit:${base.rootDir}`, async () => {
    const result = await local.getProject(workerRoot, projectId);
    const selected = result.analysis?.highlightVariants?.find(v => Number(v.scriptId) === scriptId);
    if (!selected) return;
    const current = await store.getProject(workspaceRoot, projectId);
    const variants = [...(current.analysis?.highlightVariants || []).filter(v => Number(v.scriptId) !== scriptId), selected]
      .sort((a, b) => Number(a.scriptId) - Number(b.scriptId));
    const active = variants.find(v => v.id === current.analysis?.activeVariantId) || variants[0];
    const audit = await fs.readFile(path.join(analysis, `review-state-${scriptId}.json`), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (audit) await store.writeText(path.join(sourceAnalysis, `review-state-${scriptId}.json`), audit);
    if (audit) await fs.copyFile(path.join(analysis, `edit-${scriptId}.json`), path.join(sourceAnalysis, `edit-${scriptId}.json`));
    const entries = [];
    const ledgers = [path.join(sourceAnalysis, 'run-costs.json')];
    for (let id = 1; id <= 5; id++) ledgers.push(path.join(base.rootDir, '.variant-workers', String(id), projectId, 'analysis', 'auto-story-fast', 'run-costs.json'));
    for (const file of ledgers) {
      try { entries.push(...JSON.parse(await fs.readFile(file, 'utf8')).entries); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await store.updateProject(workspaceRoot, projectId, {
      analysis: { ...current.analysis, highlightVariants: variants, activeVariantId: active.id, segments: active.segments },
      artifacts: active.artifacts || {},
      autoStoryCosts: require('./autoStoryRunMetrics').summarize(entries),
      autoStoryNarrationTranslations: [...(result.autoStoryNarrationTranslations || []), ...(current.autoStoryNarrationTranslations || [])]
        .filter((entry, index, all) => all.findIndex(other => other.text === entry.text) === index),
      autoStoryVoiceCache: { ...current.autoStoryVoiceCache, ...result.autoStoryVoiceCache }
    });
    await local.updateProject(workerRoot, projectId, { workerParentIdentity: JSON.stringify(selected) });
    return store.getProject(workspaceRoot, projectId);
  });
  try {
    signal?.throwIfAborted();
    let project = await local.getProject(workerRoot, projectId);
    if (!variant) project = await dubbing.importHighlightCutProject({ workspaceRoot: workerRoot, projectId, settings, onProgress });
    let selected = project.analysis.highlightVariants.find(v => Number(v.scriptId) === scriptId);
    if (!variant) {
      // A one-file import always starts at variant_01; give each worker a stable ID.
      selected = { ...selected, id: `variant_${String(scriptId).padStart(2, '0')}` };
      project = await local.updateProject(workerRoot, projectId, { analysis: {
        ...project.analysis, highlightVariants: [selected], activeVariantId: selected.id, segments: selected.segments
      } });
    }
    await publish();
    if (!await Dubbing.canReuseAutoStoryDraft(project, selected, settings)) {
      await dubbing.renderHighlightFastDraft({ workspaceRoot: workerRoot, projectId, settings, project, onProgress });
    }
    const ready = await publish();
    onProgress?.({ stage: 'reviewing', autoStoryDraftReady: true, project: ready, percent: 78, message: `Script ${scriptId}: draft sẵn sàng, đang review` });
    const result = await service.auditDrafts({ workspaceRoot: workerRoot, projectId, scriptId, signal, onProgress });
    await publish();
    return result.audits.find(a => Number(a.scriptId) === scriptId);
  } finally {
    await service.vertex?.dispatcher?.close();
  }
}
module.exports = { run };
