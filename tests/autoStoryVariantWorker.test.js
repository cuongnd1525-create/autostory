const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const Store = require('../electron/services/projectStore');
const Dubbing = require('../electron/services/dubbingService');
const Service = require('../electron/services/autoStoryFastService');
const worker = require('../electron/services/autoStoryVariantWorker');
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'variant-isolation-'));
  const store = new Store();
  const saved = { reuse: Dubbing.canReuseAutoStoryDraft, audit: Service.prototype.auditDrafts,
    import: Dubbing.prototype.importHighlightCutProject, render: Dubbing.prototype.renderHighlightFastDraft };
  try {
    const p = await store.createProject(root, { sourceVideoPath: 'source.mp4' });
    const variants = [1, 2].map(id => ({ id: `v${id}`, scriptId: id, segments: [{ id: `s${id}` }], artifacts: { fastDraftVideoPath: `draft${id}.mp4` } }));
    await store.updateProject(root, p.id, { analysis: { highlightVariants: variants, activeVariantId: 'v1', segments: variants[0].segments } });
    const dir = path.join(store.getProjectPaths(root, p.id).analysisDir, 'auto-story-fast');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'plan.json'), JSON.stringify({ stories: [{ scriptId: 1 }, { scriptId: 2 }] }));
    for (const id of [1, 2]) for (const prefix of ['edit', 'evidence']) await fs.writeFile(path.join(dir, `${prefix}-${id}.json`), '{}');
    Dubbing.canReuseAutoStoryDraft = async () => true;
    let active = 0, peak = 0;
    Service.prototype.auditDrafts = async function ({ workspaceRoot, projectId, scriptId }) {
      active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 30));
      const local = await this.store.getProject(workspaceRoot, projectId);
      assert.equal(local.analysis.highlightVariants.length, 1);
      const v = local.analysis.highlightVariants[0];
      v.segments = [{ id: `revised-${scriptId}` }];
      await this.store.updateProject(workspaceRoot, projectId, { analysis: { ...local.analysis, highlightVariants: [v] } });
      const audit = { scriptId, complete: true, verdict: 'PASS' };
      await this.store.writeJson(path.join(this.store.getProjectPaths(workspaceRoot, projectId).analysisDir, 'auto-story-fast', `review-state-${scriptId}.json`), audit);
      active--; return { audits: [audit] };
    };
    await Promise.all([1, 2].map(scriptId => worker.run({ settings: {}, store, workspaceRoot: root, projectId: p.id, scriptId })));
    const result = await store.getProject(root, p.id);
    assert.equal(peak, 2, 'reviews must overlap');
    assert.deepEqual(result.analysis.highlightVariants.map(v => v.segments[0].id), ['revised-1', 'revised-2']);
    assert.equal(result.analysis.activeVariantId, 'v1');
    assert.equal(result.analysis.segments[0].id, 'revised-1');
    for (const id of [1, 2]) assert.equal(JSON.parse(await fs.readFile(path.join(dir, `review-state-${id}.json`))).scriptId, id);
    // A new worker must have the same directories as a normal project before rendering.
    for (const prefix of ['edit', 'evidence']) await fs.writeFile(path.join(dir, `${prefix}-3.json`), '{}');
    Dubbing.prototype.importHighlightCutProject = async function ({ workspaceRoot, projectId }) {
      const paths = store.getProjectPaths(workspaceRoot, projectId);
      for (const key of ['assetsDir', 'audioDir', 'clipsDir', 'outputDir', 'tempDir']) {
        assert.ok((await fs.stat(paths[key])).isDirectory(), `missing worker ${key}`);
      }
      return store.updateProject(workspaceRoot, projectId, { analysis: {
        highlightVariants: [{ id: 'v3', scriptId: 3, segments: [{ id: 's3' }], artifacts: {} }], activeVariantId: 'v3'
      } });
    };
    Dubbing.canReuseAutoStoryDraft = async () => false;
    let rendered = false;
    Dubbing.prototype.renderHighlightFastDraft = async function ({ workspaceRoot, projectId }) {
      await fs.writeFile(path.join(store.getProjectPaths(workspaceRoot, projectId).tempDir, 'base.mp4'), 'test');
      rendered = true;
    };
    await worker.run({ settings: {}, store, workspaceRoot: root, projectId: p.id, scriptId: 3, scriptPath: 'script-3.json' });
    assert.ok(rendered);
    assert.equal((await store.getProject(root, p.id)).analysis.highlightVariants.length, 3);
    assert.equal((await store.getProject(root, p.id)).analysis.highlightVariants.find(v => v.scriptId === 3).id, 'variant_03');
    Dubbing.prototype.renderHighlightFastDraft = async () => { throw new Error('test render failure'); };
    await assert.rejects(worker.run({ settings: {}, store, workspaceRoot: root, projectId: p.id, scriptId: 3, scriptPath: 'script-3.json' }), /test render failure/);
    assert.equal((await store.getProject(root, p.id)).analysis.highlightVariants.length, 3, 'render failure must preserve imported scripts');
    console.log('Variant worker: overlapping reviews, private snapshots, target-only merge and active selection passed');
  } finally {
    Dubbing.canReuseAutoStoryDraft = saved.reuse; Service.prototype.auditDrafts = saved.audit;
    Dubbing.prototype.importHighlightCutProject = saved.import; Dubbing.prototype.renderHighlightFastDraft = saved.render;
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
