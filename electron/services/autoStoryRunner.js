const fs = require('fs/promises');
const path = require('path');
const Service = require('./autoStoryFastService');

// One producer and one serial draft/review consumer: at most two AI requests.
// Only the consumer imports or changes variant artifacts.
class AutoStoryRunner {
  constructor(settings, store, dubbing, createService = (s, d) => new Service(s, store, d)) {
    this.settings = { ...settings, autoStoryResourceManaged: true };
    this.store = store; this.dubbing = dubbing;
    const callBudget = { calls: 0 };
    this.producer = createService(this.settings, { dubbing, callBudget });
    this.consumer = createService(this.settings, { dubbing, callBudget });
  }
  async run({ workspaceRoot, projectId, scriptId = null, signal, onProgress }) {
    const startedAt = Date.now(), jobs = {}, queued = new Set(), failures = [];
    let chain = Promise.resolve(), analysis, fatal;
    const stateFile = path.join(this.store.getProjectPaths(workspaceRoot, projectId).analysisDir, 'auto-story-fast', 'production-timing.json');
    const state = async (id, phase, error = '') => {
      jobs[id] = { ...jobs[id], phase, error, updatedAt: new Date().toISOString() };
      const timing = { startedAt, elapsedMs: Date.now() - startedAt, jobs };
      await this.store.updateProject(workspaceRoot, projectId, { autoStoryProduction: structuredClone(timing) });
      await fs.mkdir(path.dirname(stateFile), { recursive: true });
      await fs.writeFile(stateFile, JSON.stringify(timing, null, 2));
      onProgress?.({ stage: phase, message: `Script ${id}: ${phase === 'reviewing' ? 'review draft thật' : phase === 'rendering' ? 'dựng draft' : phase === 'failed' ? error : 'đã xử lý'}` });
    };
    const enqueue = ({ scriptId: id, scriptPath }) => {
      if (queued.has(id)) return;
      queued.add(id);
      chain = chain.then(async () => {
        signal?.throwIfAborted();
        const before = await this.store.getProject(workspaceRoot, projectId);
        try {
          await state(id, 'rendering');
          let project = before;
          if (!before.analysis?.highlightVariants?.some(v => Number(v.scriptId) === id)) {
            try {
              await this.store.updateProject(workspaceRoot, projectId, { storyScriptPaths: [scriptPath], storyScriptPath: scriptPath });
              await this.dubbing.importHighlightCutProject({ workspaceRoot, projectId, settings: this.settings, onProgress });
              project = await this.consumer.mergePreservedVariants(workspaceRoot, projectId, before);
            } catch (error) {
              await this.store.updateProject(workspaceRoot, projectId, { analysis: before.analysis, artifacts: before.artifacts,
                storyScriptPaths: before.storyScriptPaths, storyScriptPath: before.storyScriptPath });
              throw error;
            }
          }
          const variant = project.analysis.highlightVariants.find(v => Number(v.scriptId) === id);
          const reuse = await require('./dubbingService').canReuseAutoStoryDraft(project, variant, this.settings);
          if (!reuse) await this.dubbing.renderHighlightFastDraft({ workspaceRoot, projectId, settings: this.settings, onProgress,
            project: { ...project, analysis: { ...project.analysis, activeVariantId: variant.id, segments: variant.segments } } });
          jobs[id] = { ...jobs[id], draftReadyMs: Date.now() - startedAt };
          onProgress?.({ project: await this.store.getProject(workspaceRoot, projectId), autoStoryDraftReady: true,
            stage: 'draft_ready', message: `Script ${id}: draft đã sẵn sàng, các script khác tiếp tục xử lý` });
          await state(id, 'reviewing');
          const result = await this.consumer.auditDrafts({ workspaceRoot, projectId, scriptId: id, signal, onProgress,
            onDraft: project => onProgress?.({ project, autoStoryDraftReady: true, stage: 'review_ready', message: `Script ${id}: đã có bản sửa` }) });
          const a = result.audits.find(a => a.scriptId === id);
          await state(id, a?.error || a?.finalCheck?.error ? 'failed' : a?.needsUserReview ? 'needs_attention' : 'complete', a?.error || a?.finalCheck?.error || '');
        } catch (error) {
          if (signal?.aborted) throw error;
          failures.push({ scriptId: id, error: error.message });
          await state(id, 'failed', error.message);
        }
      });
      // Keep rejection handled until the producer finishes; cancellation still drains below.
      chain.catch(() => {});
    };
    try {
      await this.store.updateProject(workspaceRoot, projectId, { autoStoryProduction: { startedAt, elapsedMs: 0, jobs: {}, finished: false } });
      const project = await this.producer.recoverScriptIds(workspaceRoot, projectId);
      const variants = project.analysis?.highlightVariants || [];
      const missing = variants.length < (project.autoStoryConfig?.outputCount || 2);
      for (const v of variants) if (!scriptId || Number(v.scriptId) === scriptId) enqueue({ scriptId: Number(v.scriptId), scriptPath: v.sourceJsonPath });
      const generate = !variants.length || (scriptId ? !variants.some(v => Number(v.scriptId) === scriptId) : missing);
      if (generate) analysis = await this.producer.run({ workspaceRoot, projectId, scriptId, signal, onProgress,
        retryFailed: project.autoStoryPipelineVersion === 'editorial-v1', onScriptReady: enqueue });
    } catch (error) { fatal = error; }
    try { await chain; } catch (error) { fatal ||= error; }
    const current = await this.store.getProject(workspaceRoot, projectId);
    const variants = current.analysis?.highlightVariants || [];
    const combined = [...(current.autoStoryState?.failures || []).filter(f => scriptId && Number(f.scriptId) !== scriptId), ...(analysis?.failures || []), ...failures];
    const audits = [];
    for (const v of variants) {
      try { audits.push(JSON.parse(await fs.readFile(path.join(path.dirname(stateFile), `review-state-${v.scriptId}.json`), 'utf8'))); } catch (e) { if (e.code !== 'ENOENT') fatal ||= e; }
    }
    const updated = await this.store.updateProject(workspaceRoot, projectId, {
      storyScriptPaths: variants.map(v => v.sourceJsonPath).filter(Boolean),
      autoStoryProduction: { startedAt, elapsedMs: Date.now() - startedAt, jobs, finished: true },
      autoStoryState: { ...current.autoStoryState, failures: combined, audits,
        phase: signal?.aborted ? 'cancelled' : fatal || combined.length || Object.values(jobs).some(j => j.phase === 'failed') ? 'review_failed' : 'complete',
        error: fatal?.message || '' }
    });
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify(updated.autoStoryProduction, null, 2));
    for (const service of [this.producer, this.consumer]) await service.vertex?.dispatcher?.close();
    if (fatal) throw fatal;
    return { project: updated, analysis, audits: updated.autoStoryState?.audits || [] };
  }
}
module.exports = AutoStoryRunner;
