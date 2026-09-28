// Bug-4 orchestration test: a compiled script whose DRAFT RENDER fails must be
// reported as failed (no rendered draft), so the UI stops (no success/finalize).
// Run: node tests/autoStoryV3RunnerRenderFail.test.js
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Runner = require(path.join(__dirname, '..', 'electron', 'services', 'autoStoryRunner.js'));
const outcome = require(path.join(__dirname, '..', 'electron', 'services', 'autoStoryRunOutcome.js'));

(async () => {
  console.log('AutoStory Runner — render failure after successful compile');
  const analysisDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-rfail-'));

  // A script compiled successfully -> variant exists, but has NO rendered draft yet.
  const variant = { scriptId: 1, id: 'variant_01', sourceJsonPath: '/x/script-1.json', segments: [{ id: 's1' }], artifacts: {} };
  let project = { id: 'p1', analysis: { highlightVariants: [variant], activeVariantId: 'variant_01', segments: variant.segments },
    autoStoryConfig: { outputCount: 1 }, autoStoryState: {} };

  const store = {
    getProject: async () => project,
    getProjectPaths: () => ({ analysisDir, rootDir: analysisDir }),
    updateProject: async (_w, _p, patch) => { project = { ...project, ...patch }; return project; },
    writeText: async () => {}
    // no saveProject => non-isolated chain path
  };

  let renderCalls = 0;
  const dubbing = {
    renderHighlightFastDraft: async () => { renderCalls++; throw new Error('ENOENT plan.json (render failed)'); },
    importHighlightCutProject: async () => project
  };
  // canReuseAutoStoryDraft is a static on the Dubbing class; stub via the module.
  require(path.join(__dirname, '..', 'electron', 'services', 'dubbingService.js')).canReuseAutoStoryDraft = async () => false;

  const fakeService = {
    vertex: { dispatcher: { close: async () => {} } },
    recoverScriptIds: async () => project,
    run: async () => ({ scriptPaths: ['/x/script-1.json'], failures: [] }),
    auditDrafts: async () => ({ audits: [] }),
    mergePreservedVariants: async () => project
  };

  const runner = new Runner({}, store, dubbing, () => fakeService);
  const result = await runner.run({ workspaceRoot: '/w', projectId: 'p1', onProgress: () => {} });

  assert.ok(renderCalls >= 1, 'render was attempted');
  assert.equal(outcome.renderedDraftCount(result), 0, 'no rendered draft produced');
  assert.equal(outcome.isFailedGeneration(result), true, 'render failure => run marked failed');
  const err = outcome.firstGenerationError(result);
  assert.match(err, /render failed|ENOENT/i, 'original render error preserved');
  assert.notEqual(project.autoStoryState.phase, 'complete', 'not reported complete');

  fs.rmSync(analysisDir, { recursive: true, force: true });
  console.log('\nAll 5 render-fail assertions passed.');
})().catch(e => { console.error(e); process.exit(1); });
