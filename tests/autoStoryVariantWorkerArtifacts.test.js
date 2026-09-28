// Bug-3 test: worker input-artifact prep must tolerate a missing V2 plan.json
// (V3) and still succeed, while V2 still copies its artifacts.
// Run: node tests/autoStoryVariantWorkerArtifacts.test.js
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require(path.join(__dirname, '..', 'electron', 'services', 'autoStoryVariantWorker.js'));

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log('  ok -', name); };

(async () => {
  console.log('variant worker input-artifact prep');

  await ok('V3 (no plan.json): prep does not throw and copies nothing legacy', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-v3-'));
    const src = path.join(root, 'src'); const dst = path.join(root, 'dst');
    fs.mkdirSync(src, { recursive: true }); fs.mkdirSync(dst, { recursive: true });
    // V3 writes only script-N.json / beat-casting / narration-gates — NOT plan/evidence/edit.
    fs.writeFileSync(path.join(src, 'script-1.json'), '{}');
    fs.writeFileSync(path.join(src, 'beat-casting-1.json'), '{}');
    const copied = await W.copyWorkerInputArtifacts(src, dst, 1); // must NOT throw ENOENT
    assert.deepEqual(copied, [], 'no legacy artifacts copied for V3');
    assert.ok(!fs.existsSync(path.join(dst, 'plan.json')), 'plan.json not created');
    fs.rmSync(root, { recursive: true, force: true });
  });

  await ok('V2 (plan.json present): prep copies plan/evidence/edit as before', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-v2-'));
    const src = path.join(root, 'src'); const dst = path.join(root, 'dst');
    fs.mkdirSync(src, { recursive: true }); fs.mkdirSync(dst, { recursive: true });
    fs.writeFileSync(path.join(src, 'plan.json'), '{"stories":[]}');
    fs.writeFileSync(path.join(src, 'evidence-1.json'), '[]');
    fs.writeFileSync(path.join(src, 'edit-1.json'), '{}');
    const copied = await W.copyWorkerInputArtifacts(src, dst, 1);
    assert.deepEqual(copied.sort(), ['edit-1.json', 'evidence-1.json', 'plan.json'], 'all V2 artifacts copied');
    assert.ok(fs.existsSync(path.join(dst, 'plan.json')), 'plan.json copied to worker');
    fs.rmSync(root, { recursive: true, force: true });
  });

  await ok('copyIfExists returns false for missing, true for present', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-cp-'));
    fs.writeFileSync(path.join(root, 'a.json'), '1');
    assert.equal(await W.copyIfExists(path.join(root, 'a.json'), path.join(root, 'b.json')), true);
    assert.equal(await W.copyIfExists(path.join(root, 'missing.json'), path.join(root, 'c.json')), false);
    assert.ok(fs.existsSync(path.join(root, 'b.json')));
    fs.rmSync(root, { recursive: true, force: true });
  });

  console.log(`\nAll ${passed} worker-artifact assertions passed.`);
})().catch(e => { console.error(e); process.exit(1); });
