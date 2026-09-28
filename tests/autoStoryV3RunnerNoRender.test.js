// Bug-2 orchestration test: a failed V3 generation (0 scripts) must NOT call
// draft rendering. Run: node tests/autoStoryV3RunnerNoRender.test.js
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Runner = require(path.join(__dirname, '..', 'electron', 'services', 'autoStoryRunner.js'));
const outcome = require(path.join(__dirname, '..', 'electron', 'services', 'autoStoryRunOutcome.js'));

(async () => {
  console.log('AutoStory v3 Runner — no render on failed generation');
  const analysisDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-runner-'));

  let project = { id: 'p1', analysis: { highlightVariants: [] }, autoStoryConfig: { outputCount: 1 }, autoStoryState: {} };
  const store = {
    getProject: async () => project,
    getProjectPaths: () => ({ analysisDir }),
    updateProject: async (_w, _p, patch) => { project = { ...project, ...patch }; return project; }
    // no saveProject => Runner uses the non-isolated chain path
  };

  let renderCalls = 0;
  const dubbing = {
    renderHighlightFastDraft: async () => { renderCalls++; return {}; },
    importHighlightCutProject: async () => project,
    canReuseAutoStoryDraft: async () => false
  };

  // Fake service whose generation produces ZERO scripts + a failure (like the
  // real safeWords failure), never calling onScriptReady.
  const fakeService = {
    vertex: { dispatcher: { close: async () => {} } },
    recoverScriptIds: async () => project,
    run: async () => ({ scriptPaths: [], failures: [{ scriptId: 1, error: 'Narration exceeds safeWords', kind: 'VOICE_FIT_LIMIT' }] }),
    auditDrafts: async () => ({ audits: [] }),
    mergePreservedVariants: async () => project
  };

  const runner = new Runner({}, store, dubbing, () => fakeService);
  const result = await runner.run({ workspaceRoot: '/w', projectId: 'p1', onProgress: () => {} });

  assert.equal(renderCalls, 0, 'renderHighlightFastDraft was NOT called on a failed generation');
  assert.ok((result.analysis?.failures?.length || project.autoStoryState?.failures?.length) > 0, 'failure preserved');
  assert.equal(project.autoStoryState.phase, 'review_failed', 'phase reflects failure');
  assert.equal(outcome.isFailedGeneration(result), true, 'outcome flagged as failed → UI will stop');

  fs.rmSync(analysisDir, { recursive: true, force: true });
  console.log('\nAll 4 Runner assertions passed.');
})().catch(e => { console.error(e); process.exit(1); });
