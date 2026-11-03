// Auto Story run progress (live 2026-11-03, V4 run "1011_01"): after the first Vertex request the
// bar showed "Vertex AI đang phân tích … 100%", faded out, and came back at 100% on every
// heartbeat. Vertex reports ONE request on its own 0-100 scale and that percent was forwarded as
// the run's percent; the renderer hides the bar 2.5 s after 100%.
// Run: node tests/autoStoryRunProgress.test.js
const assert = require('assert/strict');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const Service = require('../electron/services/autoStoryFastService');
const { createMonotonicProgressNormalizer, autoStoryRunPercent } = require('../electron/services/progressPolicy');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'run-progress-'));
  try {
    // 1. stage(): Vertex request progress keeps its message but not its request-local percent.
    const service = new Service({ vertexAutoStoryMaxCalls: 4 }, {}, { vertex: {
      getModel: () => 'gemini-3.8-flash',
      generateJsonFromFiles: async ({ onProgress }) => {
        onProgress({ percent: 45, message: 'Vertex AI đang chạy gemini-3.8-flash' });
        onProgress({ percent: 57, heartbeat: true, message: 'Vertex AI đang phân tích bằng gemini-3.8-flash · đã chạy 24s' });
        onProgress({ percent: 100, message: 'Vertex AI hoàn tất · ước tính $0.0100' });
        return { ok: true };
      }
    } });
    const events = [];
    await service.stage(root, 'v5-editorial-director-1', {}, { prompt: 'x' }, v => assert(v.ok), e => events.push(e));
    const vertexEvents = events.filter(e => /Vertex AI/.test(e.message || ''));
    assert.equal(vertexEvents.length, 3, 'messages still reach the log');
    assert.ok(vertexEvents.every(e => !('percent' in e)), `no request-local percent: ${JSON.stringify(vertexEvents)}`);
    assert.ok(vertexEvents.every(e => e.stage === 'v5-editorial-director-1'));
    assert.ok(vertexEvents.find(e => e.heartbeat), 'heartbeat flag kept (renderer does not log it)');

    // 2. main.js autoStory:run: only the runner's final event reaches 100%.
    const normalize = createMonotonicProgressNormalizer();
    let completed = 0;
    const send = item => { completed = Math.max(completed, Math.min(100, Number(autoStoryRunPercent(item)) || 0)); return normalize({ ...item, percent: completed }).percent; };
    assert.equal(send({ stage: 'design', percent: 30 }), 30);
    assert.equal(send({ stage: 'render', percent: 100, message: 'Đã dựng draft' }), 99, 'a nested 100 is not the end of the run');
    assert.equal(send({ stage: 'review', heartbeat: true }), 99);
    assert.equal(send({ stage: 'complete', percent: 100, final: true }), 100, 'the runner end shows 100%');

    // 3. Wiring: the runner marks its last event final; main uses the run percent policy.
    const runner = fsSync.readFileSync(path.join(__dirname, '..', 'electron', 'services', 'autoStoryRunner.js'), 'utf8');
    assert.match(runner, /emitProgress\?\.\(\{ percent: 100, final: true, stage: hasErrors \? 'failed' : 'complete'/);
    const main = fsSync.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
    assert.match(main, /const runnerProgress = \(item\) => onProgress\(\{ \.\.\.item, percent: autoStoryRunPercent\(item\) \}\);/);
    assert.match(main, /signal: controller\.signal, onProgress: runnerProgress \}\)/);
    console.log('autoStoryRunProgress tests passed (Vertex request percent not forwarded; only the final event reaches 100%)');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
