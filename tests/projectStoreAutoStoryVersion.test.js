// Persistence test for the V3 integration bug fix. Run:
//   node tests/projectStoreAutoStoryVersion.test.js
// Exercises the REAL path: renderer-style payload -> ProjectStore.createProject()
// -> project.json written to disk -> ProjectStore.getProject() -> value survives.
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ProjectStore = require(path.join(__dirname, '..', 'electron', 'services', 'projectStore.js'));

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log('  ok -', name); };

(async () => {
  const store = new ProjectStore();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-ps-'));

  console.log('ProjectStore autoStoryContractVersion persistence');

  await ok('V3 payload persists autoStoryContractVersion=3 through save + reload', async () => {
    // Mirrors what src/renderer.js readProjectPayload() emits for a V3 selection.
    const payload = {
      title: 'v3-persist',
      sourceVideoPath: '/tmp/source.mp4',
      mode: 'highlight_cut',
      analysisWorkflow: 'vertex_auto_story',
      autoStoryContractVersion: 3,
      autoStoryConfig: { targetDurationMinSec: 65, targetDurationMaxSec: 90, outputCount: 1 }
    };
    const created = await store.createProject(workspace, payload);
    assert.equal(created.autoStoryContractVersion, 3, 'returned project has 3');

    // The value must be on disk, not just in the returned object.
    const raw = JSON.parse(fs.readFileSync(path.join(workspace, created.id, 'project.json'), 'utf8'));
    assert.equal(raw.autoStoryContractVersion, 3, 'project.json on disk has 3');

    // And it must survive a fresh reload.
    const reloaded = await store.getProject(workspace, created.id);
    assert.equal(reloaded.autoStoryContractVersion, 3, 'getProject returns 3');
    assert.equal(reloaded.analysisWorkflow, 'vertex_auto_story');
    assert.equal(reloaded.autoStoryConfig.outputCount, 1, 'outputCount preserved');
  });

  await ok('legacy payload (no field) stays undefined — v2 behavior preserved', async () => {
    const created = await store.createProject(workspace, {
      title: 'legacy-persist', sourceVideoPath: '/tmp/s2.mp4', mode: 'highlight_cut',
      analysisWorkflow: 'vertex_auto_story', autoStoryConfig: { outputCount: 2 }
    });
    const reloaded = await store.getProject(workspace, created.id);
    assert.equal(reloaded.autoStoryContractVersion, undefined, 'no field for legacy');
    assert.ok(!('autoStoryContractVersion' in JSON.parse(fs.readFileSync(path.join(workspace, created.id, 'project.json'), 'utf8'))),
      'field absent in project.json');
  });

  await ok('V2 payload (=== 2) stays undefined (only V3 is persisted)', async () => {
    const created = await store.createProject(workspace, {
      title: 'v2-persist', sourceVideoPath: '/tmp/s3.mp4', mode: 'highlight_cut',
      analysisWorkflow: 'vertex_auto_story', autoStoryContractVersion: 2, autoStoryConfig: { outputCount: 2 }
    });
    const reloaded = await store.getProject(workspace, created.id);
    assert.equal(reloaded.autoStoryContractVersion, undefined, 'v2 not persisted as a field → falls through to v2');
  });

  fs.rmSync(workspace, { recursive: true, force: true });
  console.log(`\nAll ${passed} persistence assertions passed.`);
})().catch(e => { console.error(e); process.exit(1); });
