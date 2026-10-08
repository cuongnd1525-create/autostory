// AutoStory v3 routing/persistence tests. Run: node tests/autoStoryV3Routing.test.js
// Verifies UI-persisted project.autoStoryContractVersion drives the live fork:
//   3 -> autoStoryV3Pipeline.run ; 2/legacy -> v2 ; outputCount respected ; no silent fallback.
const assert = require('node:assert');
const path = require('path');
const svcDir = path.join(__dirname, '..', 'electron', 'services');

// Stub the two pipeline modules in the require cache BEFORE loading the service.
const v3Path = require.resolve(path.join(svcDir, 'autoStoryV3Pipeline.js'));
const v2Path = require.resolve(path.join(svcDir, 'autoStorySourcePipeline.js'));
let calls = {};
function stub(p, tag, impl) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports: {
    run: impl || (async (svc) => { calls[tag] = { project: await svc.store.getProject() }; return { routed: tag }; }),
    auditDrafts: async (svc, opts) => { calls[`${tag}_audit`] = { project: await svc.store.getProject(), opts }; return { routed: `${tag}_audit`, audits: [] }; }
  } };
}
stub(v3Path, 'v3');
stub(v2Path, 'v2');

const Service = require(path.join(svcDir, 'autoStoryFastService.js'));

function makeStore(project) {
  return {
    getProject: async () => project,
    getProjectPaths: () => ({ analysisDir: '/tmp/analysis' }),
    updateProject: async (_w, _p, patch) => Object.assign(project, patch)
  };
}
function makeService(project, settings = {}) {
  return new Service(settings, makeStore(project), { vertex: {}, ffmpeg: {}, dubbing: {}, callBudget: { calls: 0, runId: 't' } });
}

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log('  ok -', name); };

(async () => {
  console.log('AutoStory v3 routing');

  await ok('project.autoStoryContractVersion === 3 routes to v3 pipeline', async () => {
    calls = {};
    const project = { autoStoryContractVersion: 3, autoStoryConfig: { outputCount: 1 } };
    const res = await makeService(project).run({ workspaceRoot: '/w', projectId: 'p1' });
    assert.equal(res.routed, 'v3');
    assert.ok(calls.v3, 'v3.run was called');
  });

  await ok('v3 receives the UI-selected outputCount = 1', async () => {
    calls = {};
    const project = { autoStoryContractVersion: 3, autoStoryConfig: { outputCount: 1 } };
    await makeService(project).run({ workspaceRoot: '/w', projectId: 'p1' });
    assert.equal(calls.v3.project.autoStoryConfig.outputCount, 1);
  });

  await ok('project.autoStoryContractVersion === 4 routes to director-capable v3 orchestrator', async () => {
    calls = {};
    const project = { autoStoryContractVersion: 4, autoStoryConfig: { outputCount: 1 } };
    const res = await makeService(project).run({ workspaceRoot: '/w', projectId: 'p1' });
    assert.equal(res.routed, 'v3');
    assert.ok(calls.v3);
  });

  await ok('project.autoStoryContractVersion === 2 routes to v2 pipeline', async () => {
    calls = {};
    const project = { autoStoryContractVersion: 2 };
    const res = await makeService(project).run({ workspaceRoot: '/w', projectId: 'p1' });
    assert.equal(res.routed, 'v2');
    assert.ok(!calls.v3, 'v3 not called for v2 project');
  });

  await ok('legacy project (no field) with source contract stays v2 — no silent v3 migration', async () => {
    calls = {};
    const project = {}; // no autoStoryContractVersion, no pipelineVersion
    const res = await makeService(project, { autoStorySourceContract: true }).run({ workspaceRoot: '/w', projectId: 'p1' });
    assert.equal(res.routed, 'v2');
    assert.ok(!calls.v3);
  });

  await ok('no silent fallback: a fatal v3 error stays a v3 error', async () => {
    stub(v3Path, 'v3', async () => { throw new Error('Source Story Model failed'); });
    const project = { autoStoryContractVersion: 3, autoStoryConfig: { outputCount: 1 } };
    await assert.rejects(() => makeService(project).run({ workspaceRoot: '/w', projectId: 'p1' }), /Source Story Model failed/);
    stub(v3Path, 'v3'); // restore
  });

  await ok('auditDrafts routes v3 to autoStoryV3Pipeline.auditDrafts', async () => {
    calls = {};
    const project = { autoStoryContractVersion: 3 };
    const svc = makeService(project);
    svc.recoverScriptIds = async () => project;
    const res = await svc.auditDrafts({ workspaceRoot: '/w', projectId: 'p1' });
    assert.equal(res.routed, 'v3_audit');
    assert.ok(calls.v3_audit, 'v3 auditDrafts routed to autoStoryV3Pipeline.auditDrafts');
  });

  await ok('auditDrafts routes v4 to autoStoryV3Pipeline.auditDrafts', async () => {
    calls = {};
    const project = { autoStoryContractVersion: 4 };
    const svc = makeService(project);
    svc.recoverScriptIds = async () => project;
    const res = await svc.auditDrafts({ workspaceRoot: '/w', projectId: 'p1' });
    assert.equal(res.routed, 'v3_audit');
    assert.ok(calls.v3_audit, 'v4 auditDrafts routed to autoStoryV3Pipeline.auditDrafts');
  });

  await ok('auditDrafts routes v2 to autoStorySourceReview', async () => {
    const reviewPath = require.resolve(path.join(svcDir, 'autoStorySourceReview.js'));
    let reviewed = false;
    require.cache[reviewPath] = { id: reviewPath, filename: reviewPath, loaded: true, exports: { run: async () => { reviewed = true; return { audits: [] }; } } };
    const project = { autoStoryContractVersion: 2 };
    const svc = makeService(project);
    svc.recoverScriptIds = async () => project;
    await svc.auditDrafts({ workspaceRoot: '/w', projectId: 'p1' });
    assert.ok(reviewed, 'v2 auditDrafts used autoStorySourceReview');
  });

  console.log(`\nAll ${passed} routing assertions passed.`);
})().catch(e => { console.error(e); process.exit(1); });
