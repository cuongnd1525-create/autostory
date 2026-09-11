const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const Service = require('../electron/services/autoStoryFastService');
const Runner = require('../electron/services/autoStoryRunner');
const Dubbing = require('../electron/services/dubbingService');
const patches = require('../electron/services/autoStoryReviewPatch');
const metrics = require('../electron/services/autoStoryRunMetrics');
const { serial } = require('../electron/services/autoStoryWorkQueue');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-production-'));
  const oldReuse = Dubbing.canReuseAutoStoryDraft;
  try {
    let calls = 0;
    const service = new Service({}, {}, { vertex: { generateJsonFromFiles: async () => {
      if (++calls === 1) throw new Error('Vertex AI request failed (503): unavailable'); return { ok: true };
    } } });
    await service.stage(root, 'transient', {}, { filePaths: ['media'], prompt: 'test' }, v => assert(v.ok));
    assert.equal(calls, 2);
    const abort = new AbortController();
    service.vertex.generateJsonFromFiles = async () => { abort.abort(); throw new Error('Vertex AI request failed (503): unavailable'); };
    await assert.rejects(service.stage(root, 'abort', {}, { prompt: 'test' }, () => {}, null, abort.signal));
    const original = { segments: [{ id: 'a', text: 'keep' }, { id: 'b', text: 'before' }] };
    const revised = patches.apply({ verdict: 'MINOR_REVISE', patch: { order: ['a', 'b'], changedSegments: [{ id: 'b', text: 'after' }] } }, original);
    assert.deepEqual(revised.revisedScript.segments[0], original.segments[0]);
    assert.equal(original.segments[1].text, 'before');
    assert.throws(() => patches.apply({ verdict: 'PASS', patch: { order: ['b'], changedSegments: [] } }, original));
    assert.throws(() => patches.apply({ patch: { order: ['a', 'a'], changedSegments: [] } }, original));
    await Promise.all(Array.from({ length: 10 }, (_, i) => metrics.append(root, { scriptId: i, category: 'editing', usd: 1, cached: false })));
    const ledger = JSON.parse(await fs.readFile(path.join(root, 'run-costs.json')));
    assert.equal(ledger.entries.length, 10, 'concurrent writes cannot lose usage');
    const order = [];
    await Promise.all([serial('test', async () => { order.push(1); throw new Error('x'); }).catch(() => {}), serial('test', async () => order.push(2))]);
    assert.deepEqual(order, [1, 2], 'a failed resource task cannot poison its queue');
    const source = path.join(root, 'draft.mp4'); await fs.writeFile(source, 'draft');
    const settings = { exportRoot: root };
    const exportProject = { title: 'retention', exportRoot: root };
    const published = await Dubbing.publishDraftVideo({ settings, project: exportProject, sourcePath: source });
    const match = path.basename(published).match(/^(.*-)\d{14}(\.[^.]+)$/);
    assert(match);
    const locked = path.join(path.dirname(published), `${match[1]}20000101000000${match[2]}`);
    await fs.writeFile(locked, 'old draft');
    const rm = fs.rm;
    fs.rm = async (file, options) => { if (file === locked) throw Object.assign(new Error('locked'), { code: 'EBUSY' }); return rm(file, options); };
    try {
      const output = await Dubbing.publishDraftVideo({ settings, project: exportProject, sourcePath: source, keepRuns: 1 });
      assert.equal(await fs.readFile(output, 'utf8'), 'draft');
      await fs.access(locked);
    } finally { fs.rm = rm; }

    let project = { id: 'p', analysisWorkflow: 'vertex_auto_story', autoStoryConfig: { outputCount: 3 }, analysis: { highlightVariants: [] } };
    const store = { getProject: async () => structuredClone(project), getProjectPaths: () => ({ analysisDir: root }),
      updateProject: async (_w, _id, p) => (project = { ...project, ...p }) };
    let firstDraft, producerDone = false, renderActive = 0, peak = 0;
    const firstReady = new Promise(resolve => { firstDraft = resolve; });
    const events = [];
    const dubbing = {
      importHighlightCutProject: async () => {
        const id = Number(project.storyScriptPath);
        project.analysis = { highlightVariants: [{ id: `v${id}`, scriptId: id, sourceJsonPath: String(id), segments: [] }] };
      },
      renderHighlightFastDraft: async ({ project: p }) => {
        peak = Math.max(peak, ++renderActive);
        const id = p.analysis.activeVariantId;
        events.push(`render:${id}`);
        const v = project.analysis.highlightVariants.find(v => v.id === id);
        v.artifacts = { fastDraftVideoPath: `${id}.mp4` };
        if (id === 'v1') { assert(!producerDone, 'first draft must not wait for all scripts'); firstDraft(); }
        renderActive--;
      }
    };
    Dubbing.canReuseAutoStoryDraft = async (_p, v) => !!v.artifacts?.fastDraftVideoPath;
    const make = () => ({
      recoverScriptIds: async () => structuredClone(project),
      run: async ({ onScriptReady }) => {
        project.autoStoryPipelineVersion = 'editorial-v1';
        onScriptReady({ scriptId: 1, scriptPath: '1' });
        await firstReady;
        onScriptReady({ scriptId: 2, scriptPath: '2' });
        onScriptReady({ scriptId: 3, scriptPath: '3' });
        producerDone = true;
        return { failures: [] };
      },
      mergePreservedVariants: async (_w, _id, before) => {
        project.analysis.highlightVariants = [...before.analysis.highlightVariants, ...project.analysis.highlightVariants];
        return structuredClone(project);
      },
      auditDrafts: async ({ scriptId }) => {
        events.push(`review:${scriptId}`);
        if (scriptId === 2) throw new Error('synthetic review failure');
        const a = { scriptId, complete: true, verdict: 'PASS' };
        await fs.mkdir(path.join(root, 'auto-story-fast'), { recursive: true });
        await fs.writeFile(path.join(root, 'auto-story-fast', `review-state-${scriptId}.json`), JSON.stringify(a));
        return { audits: [a] };
      }
    });
    const result = await new Runner({}, store, dubbing, make).run({ workspaceRoot: root, projectId: 'p' });
    assert.equal(peak, 1);
    assert.deepEqual(events, ['render:v1', 'review:1', 'render:v2', 'review:2', 'render:v3', 'review:3']);
    assert.equal(result.project.analysis.highlightVariants.length, 3, 'later imports preserve early drafts');
    assert.equal(result.project.autoStoryState.failures[0].scriptId, 2);
    assert.equal(result.project.autoStoryState.audits.length, 2);
    assert.equal(result.project.autoStoryProduction.finished, true);
    events.length = 0;
    await new Runner({}, store, dubbing, make).run({ workspaceRoot: root, projectId: 'p', scriptId: 2 });
    assert.deepEqual(events, ['review:2'], 'retry keeps all existing drafts');
    console.log('Production overlap, failure isolation, patch, retry and usage tests passed');
  } finally { Dubbing.canReuseAutoStoryDraft = oldReuse; await fs.rm(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
