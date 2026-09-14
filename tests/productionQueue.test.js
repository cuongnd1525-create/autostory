const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const Queue = require('../electron/services/productionQueue');
const tokens = require('../electron/services/cancelToken');
const { withSlot } = require('../electron/services/productionResourcePool');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const until = async fn => {
  for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('Test timed out');
};
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'production-queue-test-'));
  try {
    const foreground = tokens.createCancelToken('foreground');
    const a = tokens.createScopedToken('a'), b = tokens.createScopedToken('b');
    const barrier = deferred(), killed = [];
    const taskA = tokens.runWithCancelToken(a, async () => {
      assert.equal(tokens.createCancelToken('nested'), a);
      tokens.clearCancelToken();
      tokens.trackChild({ kill: () => killed.push('a') });
      await barrier.promise; assert.equal(tokens.getCancelToken(), a);
      assert.throws(() => tokens.throwIfCancelled());
    });
    const taskB = tokens.runWithCancelToken(b, async () => {
      tokens.trackChild({ kill: () => killed.push('b') });
      await barrier.promise; assert.equal(tokens.getCancelToken(), b); tokens.throwIfCancelled();
    });
    tokens.cancelToken(a); barrier.resolve();
    await taskA; await taskB;
    assert.deepEqual(killed, ['a']); assert.equal(tokens.getCancelToken(), foreground);
    tokens.clearCancelToken(foreground);

    let running = 0, peak = 0;
    const release = deferred(), admitted = [], calls = [];
    for (let i = 0; i < 6; i++) calls.push(withSlot('test-ai', 2, null, async () => {
      running++; peak = Math.max(peak, running); admitted.push(i);
      await release.promise; running--; if (i === 2) throw new Error('request failed');
    }).catch(e => e.message));
    await until(() => admitted.length === 2); assert.equal(running, 2);
    release.resolve(); await Promise.all(calls); assert.equal(peak, 2); assert.equal(admitted.length, 6);
    const held = deferred(), controller = new AbortController();
    const first = withSlot('cancel-pool', 1, null, () => held.promise);
    const waiting = withSlot('cancel-pool', 1, controller.signal, () => assert.fail('Cancelled waiter executed')).catch(e => e);
    controller.abort(new Error('cancel waiter')); assert.match((await waiting).message, /cancel waiter/);
    held.resolve(); await first; await withSlot('cancel-pool', 1, null, async () => {});

    const started = [], gates = {}, events = [];
    const file = path.join(root, 'queue.json');
    const queue = new Queue(file, async (job, signal, progress) => {
      assert.equal(tokens.getCancelToken().label, job.id);
      started.push(job.projectId); gates[job.projectId] = deferred();
      progress({ percent: 80, message: 'Review' }); progress({ percent: 40 });
      await gates[job.projectId].promise;
      if (job.projectId === 'b') throw new Error('Provider unavailable');
      return { needsAttention: job.projectId === 'd' };
    }, snapshot => events.push(snapshot));
    await queue.load();
    const item = (projectId, sourceKey = projectId) => ({ workspaceRoot: root, projectId, sourceKey });
    await queue.add([item('a'), item('b'), item('c', 'a'), item('d')]);
    await queue.add([item('a')]); assert.equal(queue.jobs.length, 4); assert.equal(started.length, 0);
    await queue.action(null, 'start'); await until(() => started.length === 2);
    assert.deepEqual(started, ['a', 'b']); assert.equal(queue.jobs[0].progress, 80);
    gates.b.resolve(); await until(() => started.includes('d'));
    assert.ok(!started.includes('c'), 'Same source must not run concurrently');
    await queue.action(null, 'pause');
    await queue.action(queue.jobs[0].id, 'cancel'); gates.a.resolve(); gates.d.resolve();
    await until(() => queue.active.size === 0); await queue.save();
    assert.equal(queue.jobs[0].status, 'cancelled');
    assert.equal(queue.jobs[1].status, 'failed'); assert.equal(queue.jobs[3].status, 'needs_attention');
    assert.equal(queue.jobs[2].status, 'queued');
    await queue.action(null, 'start'); await until(() => started.includes('c')); gates.c.resolve();
    await until(() => queue.jobs[2].status === 'complete' && queue.active.size === 0); await queue.save();
    assert.ok(events.every(e => e.active <= 2));
    await assert.rejects(queue.action(queue.jobs[2].id, 'retry'), /không hợp lệ/);
    await queue.action(null, 'pause'); await queue.action(queue.jobs[1].id, 'retry');
    assert.equal(queue.jobs[1].status, 'queued');
    queue.jobs[0].status = 'running'; await queue.save();
    const restored = new Queue(file, () => assert.fail('Must not auto-run after restart'));
    await restored.load(); assert.equal(restored.paused, true); assert.equal(restored.jobs[0].status, 'interrupted');
    assert.equal(restored.jobs[2].status, 'complete');
    await assert.rejects(restored.add([{ projectId: 'invalid' }]), /Thiếu thông tin/);

    const disconnected = new Queue(path.join(root, 'disconnect.json'), async () => ({}), () => { throw new Error('Window closed'); });
    await disconnected.load(); await disconnected.add([item('x')]); await disconnected.action(null, 'start');
    await until(() => disconnected.jobs[0].status === 'complete' && disconnected.active.size === 0); await disconnected.save();
    console.log('productionQueue: isolation, global limits, source locks, cancellation, failure recovery, restart and UI disconnect passed');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
