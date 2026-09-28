const fs = require('fs/promises');
const path = require('path');
const Service = require('./autoStoryFastService');

// Isolated variant workers can render while the producer prepares other scripts.
class AutoStoryRunner {
  constructor(settings, store, dubbing, createService = (s, d) => new Service(s, store, d)) {
    this.settings = { autoStorySourceContract: true, ...settings, autoStoryResourceManaged: true, autoStoryBoundedRun: true };
    this.store = store; this.dubbing = dubbing;
    const callBudget = { calls: 0, runId: require('crypto').randomUUID() };
    this.callBudget = callBudget;
    this.isolatedWorkers = typeof store.saveProject === 'function';
    this.createService = createService;
    this.producer = createService(this.settings, { dubbing, callBudget });
    this.consumer = createService(this.settings, { dubbing, callBudget });
  }
  async run({ workspaceRoot, projectId, scriptId = null, signal, onProgress }) {
    const startedAt = Date.now(), jobs = {}, queued = new Set(), failures = [];
    let chain = Promise.resolve(), analysis, fatal;
    const pending = [];
    const workers = [];
    const stateFile = path.join(this.store.getProjectPaths(workspaceRoot, projectId).analysisDir, 'auto-story-fast', 'production-timing.json');
    const state = async (id, phase, error = '') => require('./autoStoryWorkQueue').serial(`production-state:${stateFile}`, async () => {
      jobs[id] = { ...jobs[id], phase, error, updatedAt: new Date().toISOString() };
      const timing = { startedAt, elapsedMs: Date.now() - startedAt, jobs };
      await this.store.updateProject(workspaceRoot, projectId, { autoStoryProduction: structuredClone(timing) });
      await fs.mkdir(path.dirname(stateFile), { recursive: true });
      await fs.writeFile(stateFile, JSON.stringify(timing, null, 2));
      onProgress?.({ stage: phase, message: `Script ${id}: ${phase === 'reviewing' ? 'review draft thật' : phase === 'rendering' ? 'dựng draft' : phase === 'failed' ? error : 'đã xử lý'}` });
    });
    const enqueue = item => { pending.push(item); if (this.isolatedWorkers) dispatch(item); };
    const dispatch = ({ scriptId: id, scriptPath }) => {
      if (queued.has(id)) return;
      queued.add(id);
      if (this.isolatedWorkers) {
        const work = require('./productionResourcePool').withSlot(`variants:${stateFile}`, 2, signal, async () => {
          try {
            await state(id, 'rendering');
            const audit = await require('./autoStoryVariantWorker').run({ settings: this.settings, store: this.store,
              workspaceRoot, projectId, scriptId: id, scriptPath, signal, callBudget: this.callBudget,
              dubbing: this.dubbing, createService: this.createService,
              onProgress: p => { onProgress?.({ ...p, message: `Script ${id}: ${p.message || p.stage || ''}` }); } });
            if (!audit?.complete) throw new Error(audit?.error || 'Chưa có review hoàn chỉnh.');
            const finalPhase = audit.finalCheck?.error ? 'failed' : audit.needsUserReview ? 'needs_attention' : 'complete';
            await state(id, finalPhase, audit.finalCheck?.error || '');
            onProgress?.({ stage: finalPhase, level: finalPhase === 'complete' ? 'INFO' : 'WARNING',
              message: `Script ${id}: ${finalPhase === 'complete' ? 'đã hoàn tất' : finalPhase === 'needs_attention' ? 'cần bạn xem' : 'đã kết thúc với lỗi'}` });
          } catch (error) {
            if (signal?.aborted) throw error;
            failures.push({ scriptId: id, error: error.message });
            onProgress?.({ stage: 'failed', level: 'ERROR', message: `Script ${id}: ${error.message}` });
            await state(id, 'failed', error.message);
          }
        });
        work.catch(() => {}); workers.push(work); return;
      }
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
          if (!a?.complete && !a?.error) throw new Error('Chưa có kết quả review hoàn chỉnh cho script này; draft được giữ lại.');
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
      const missing = variants.length < (project.autoStoryConfig?.outputCount || (project.autoStoryPipelineVersion ? 2 : 1));
      for (const v of variants) if (!scriptId || Number(v.scriptId) === scriptId) enqueue({ scriptId: Number(v.scriptId), scriptPath: v.sourceJsonPath });
      const generate = !variants.length || (scriptId ? !variants.some(v => Number(v.scriptId) === scriptId) : missing);
      if (generate) analysis = await this.producer.run({ workspaceRoot, projectId, scriptId, signal, onProgress,
        retryFailed: project.autoStoryPipelineVersion === 'editorial-v1', onScriptReady: enqueue });
    } catch (error) { fatal = error; }
    // Recover missing scripts independently using the producer's checkpoints.
    // One additional pass per failed script, sharing the same API call budget.
    const blocked = error => /401|403|429|budget|giới hạn|hard limit|access|truy cập|chưa đọc đủ/i.test(error || '');
    let generationFailures = analysis?.failures || [];
    if (fatal && !signal?.aborted && !blocked(fatal.message)) {
      try { generationFailures = JSON.parse(await fs.readFile(path.join(path.dirname(stateFile), 'failures.json'), 'utf8')); }
      catch (_) { /* No recoverable script checkpoint. */ }
    }
    for (const failure of [...generationFailures]) {
      const id = Number(failure.scriptId);
      if (signal?.aborted || !Number.isInteger(id) || (scriptId && id !== scriptId)
        || pending.some(p => p.scriptId === id) || blocked(failure.error) || failure.kind) continue;
      onProgress?.({ stage: 'recovering', message: `Script ${id}: tự phục hồi bước lỗi từ dữ liệu đã lưu (1/1)`, level: 'WARNING' });
      try {
        const recovered = await this.producer.run({ workspaceRoot, projectId, scriptId: id,
          retryFailed: true, signal, onProgress, onScriptReady: enqueue });
        generationFailures = generationFailures.filter(f => Number(f.scriptId) !== id);
        generationFailures.push(...(recovered.failures || []).filter(f => Number(f.scriptId) === id));
      } catch (error) {
        generationFailures = generationFailures.map(f => Number(f.scriptId) === id ? { scriptId: id, error: error.message } : f);
      }
    }
    if (analysis || generationFailures.length || pending.length) {
      analysis = { ...analysis, failures: generationFailures };
      if (!generationFailures.length && pending.length && !signal?.aborted) fatal = null;
    }
    // Complete the shared planning/editing phase before starting any draft.
    if (!signal?.aborted) for (const item of pending) dispatch(item);
    try { await chain; } catch (error) { fatal ||= error; }
    const results = await Promise.allSettled(workers);
    for (const result of results) if (result.status === 'rejected') fatal ||= result.reason;
    const current = await this.store.getProject(workspaceRoot, projectId);
    const variants = current.analysis?.highlightVariants || [];
    const combined = [...(current.autoStoryState?.failures || []).filter(f => scriptId && Number(f.scriptId) !== scriptId), ...(analysis?.failures || []), ...failures];
    const audits = [];
    for (const v of variants) {
      try { audits.push(JSON.parse(await fs.readFile(path.join(path.dirname(stateFile), `review-state-${v.scriptId}.json`), 'utf8'))); } catch (e) { if (e.code !== 'ENOENT') fatal ||= e; }
    }
    const requested = current.autoStoryConfig?.outputCount || (current.autoStoryContractVersion === 2 ? 1 : 2);
    const needsAttention = variants.length < requested || audits.some(a => a.needsUserReview || a.finalCheck?.verdict === 'NEEDS_ATTENTION');
    const updated = await this.store.updateProject(workspaceRoot, projectId, {
      ...(require('./autoStoryProviderErrors').isRateLimit(fatal) ? { autoStoryCapacityWarning:'' } : {}),
      storyScriptPaths: variants.map(v => v.sourceJsonPath).filter(Boolean),
      autoStoryProduction: { startedAt, elapsedMs: Date.now() - startedAt, jobs, finished: true },
      autoStoryState: { ...current.autoStoryState, failures: combined, audits,
        boundedRun: true,
        needsAttention,
        phase: signal?.aborted ? 'cancelled' : fatal || combined.length || variants.length < requested || Object.values(jobs).some(j => j.phase === 'failed') ? 'review_failed' : 'complete',
        error: fatal?.message || '', errorKind: fatal?.kind || '', failedStage: fatal?.stage || '' }
    });
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify(updated.autoStoryProduction, null, 2));
    for (const service of [this.producer, this.consumer]) await service.vertex?.dispatcher?.close();
    const hasErrors = Boolean(fatal || combined.length || variants.length < requested || Object.values(jobs).some(j => j.phase === 'failed'));
    onProgress?.({ percent: 100, stage: hasErrors ? 'failed' : 'complete',
      level: hasErrors ? 'WARNING' : 'INFO', project: updated,
      message: hasErrors ? `Lượt chạy đã kết thúc · Có ${variants.length}/${requested} kịch bản · Xem lỗi trong Thống kê & cảnh báo`
        : `Lượt chạy đã kết thúc · Có ${variants.length}/${requested} kịch bản${needsAttention ? ' · Cần xem kết quả kiểm tra' : ''}` });
    if (fatal) throw fatal;
    return { project: updated, analysis, audits: updated.autoStoryState?.audits || [] };
  }
}
module.exports = AutoStoryRunner;
