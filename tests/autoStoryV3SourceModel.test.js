// Source Story Model: caching, bounded caps, merge/dedup, MAX_TOKENS recovery.
// Run: node tests/autoStoryV3SourceModel.test.js
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require(path.join(__dirname, '..', 'electron', 'services', 'sourceStoryModelService.js'));

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log('  ok -', name); };

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-sm-'));
const ev = (id, s, e, extra = {}) => ({ id, startSec: s, endSec: e, type: 'event', summary: `evt ${id}`, tension: 0.5, ...extra });
const qt = (id, eventId, s, e, text, extra = {}) => ({ id, eventId, speaker: 'x', startSec: s, endSec: e, text, epistemic: 'known_fact', editorialValue: 0.6, ...extra });
const rawModel = (nE = 3, nQ = 3) => ({
  accessGranted: true,
  people: [{ id: 'p1', label: 'Driver', role: 'suspect', firstSeenSec: 1 }],
  events: Array.from({ length: nE }, (_, i) => ev(`e${i + 1}`, i * 10, i * 10 + 5)),
  quotes: Array.from({ length: nQ }, (_, i) => qt(`q${i + 1}`, `e1`, i, i + 1, `line ${i}`))
});

// Fake engine that records ask() calls and can be scripted to throw/return.
function makeEngine(cacheDir, askScript) {
  const calls = [];
  return {
    cache: cacheDir, duration: 1200, cues: [], sourceHash: 'HASH', progress: [],
    onProgress(p) { this.progress.push(p.message || ''); },
    async metric() {},
    async prepare(ranges) { return ranges.map((r, i) => ({ id: 'c' + i, file: 'c' + i + '.mp4', sourceStart: r.sourceStartSec, duration: r.sourceEndSec - r.sourceStartSec })); },
    async ask(key, input, schema, instruction /* , evidence, validate, task, options */) {
      calls.push({ key, schema, instruction });
      const step = askScript(key, calls.length);
      if (step instanceof Error) throw step;
      return step;
    },
    _calls: calls
  };
}
const maxTokensErr = () => new Error('Vertex AI đã chạm giới hạn (MAX_TOKENS). JSON chưa hoàn chỉnh.');

const V3 = require(path.join(__dirname, '..', 'electron', 'services', 'autoStoryV3Contracts.js'));
const buildOpts = {
  schema: V3.schemas.sourceModel, instruction: V3.instructions.sourceModel,
  compactSchema: V3.schemas.compactSourceModel, compactInstruction: V3.instructions.sourceModelCompact,
  chunkInstruction: V3.instructions.sourceModelChunk
};

(async () => {
  console.log('Source Story Model');

  await ok('same source + same schema version => cache HIT, zero Vertex calls', async () => {
    const dir = tmp();
    await S.persist(dir, S.normalize(rawModel(3, 3), { duration: 1200, sourceId: 'HASH' }));
    const engine = makeEngine(dir, () => { throw new Error('ask must NOT be called on cache hit'); });
    const model = await S.build(engine, [], buildOpts);
    assert.equal(engine._calls.length, 0, 'no Vertex call');
    assert.ok(model.events.length >= 1);
    assert.ok(engine.progress.some(m => /cache HIT/.test(m)), 'logged cache HIT');
  });

  await ok('changed source (empty cache) => cache MISS, one whole-source call', async () => {
    const engine = makeEngine(tmp(), () => rawModel(4, 5));
    const model = await S.build(engine, [], buildOpts);
    assert.equal(engine._calls.length, 1);
    assert.equal(engine._calls[0].key, 'v3-source-model');
    assert.ok(engine.progress.some(m => /cache MISS/.test(m)));
    assert.ok(model.events.length >= 1);
  });

  await ok('changed schema version => cache MISS (stale model ignored)', async () => {
    const dir = tmp();
    const stale = S.normalize(rawModel(2, 2), { duration: 1200 });
    stale.modelVersion = S.MODEL_VERSION - 1; // simulate old schema
    fs.writeFileSync(path.join(dir, 'story-model.json'), JSON.stringify(stale));
    const { model, reason } = await S.loadWithReason(dir);
    assert.equal(model, null);
    assert.match(reason, /schema version/);
    const engine = makeEngine(dir, () => rawModel(3, 3));
    await S.build(engine, [], buildOpts);
    assert.equal(engine._calls.length, 1, 'regenerated');
  });

  await ok('MAX_TOKENS on whole-source => compact retry (NOT an identical resend)', async () => {
    const engine = makeEngine(tmp(), (key) => key === 'v3-source-model' ? maxTokensErr() : rawModel(3, 4));
    const model = await S.build(engine, [], buildOpts);
    assert.equal(engine._calls.length, 2, 'whole then compact');
    assert.equal(engine._calls[0].key, 'v3-source-model');
    assert.equal(engine._calls[1].key, 'v3-source-model_compact');
    assert.notStrictEqual(engine._calls[1].schema, engine._calls[0].schema, 'different (tighter) schema');
    assert.notEqual(engine._calls[1].instruction, engine._calls[0].instruction, 'different instruction');
    assert.ok(model.events.length >= 1);
    assert.ok(engine.progress.some(m => /MAX_TOKENS/.test(m)));
  });

  await ok('MAX_TOKENS on whole AND compact => chunked extraction + merge', async () => {
    const engine = makeEngine(tmp(), (key) => (key === 'v3-source-model' || key === 'v3-source-model_compact') ? maxTokensErr() : rawModel(2, 2));
    const model = await S.build(engine, [], buildOpts);
    assert.ok(engine._calls.some(c => /chunk/.test(c.key)), 'chunk calls made');
    assert.ok(model.events.length >= 1, 'merged model has events');
    assert.ok(engine.progress.some(m => /Chunked extraction/.test(m)));
  });

  await ok('non-recoverable error (INPUT_ACCESS) => rethrow, no compact retry', async () => {
    const engine = makeEngine(tmp(), () => new Error('INPUT_ACCESS: AI chưa xác minh truy cập input.'));
    await assert.rejects(() => S.build(engine, [], buildOpts), /INPUT_ACCESS/);
    assert.equal(engine._calls.length, 1, 'did not retry a non-recoverable failure');
  });

  console.log('  -- pure helpers --');

  await ok('normalize enforces deterministic caps', () => {
    const big = { accessGranted: true, people: [], events: Array.from({ length: 200 }, (_, i) => ev(`e${i}`, i, i + 1, { tension: Math.random() })),
      quotes: Array.from({ length: 100 }, (_, i) => qt(`q${i}`, 'e1', i, i + 1, `l${i}`, { editorialValue: Math.random() })) };
    const m = S.normalize(big, { duration: 5000 });
    assert.ok(m.events.length <= S.MAX_EVENTS, `events ${m.events.length} <= ${S.MAX_EVENTS}`);
    assert.ok(m.quotes.length <= S.MAX_QUOTES, `quotes ${m.quotes.length} <= ${S.MAX_QUOTES}`);
    const perE1 = m.quotes.filter(q => q.eventId === 'e1').length;
    assert.ok(perE1 <= S.MAX_QUOTES_PER_EVENT, `per-event quotes ${perE1} <= ${S.MAX_QUOTES_PER_EVENT}`);
  });

  await ok('normalize trims verbose summaries and quote text', () => {
    const m = S.normalize({ accessGranted: true, events: [ev('e1', 0, 5, { summary: Array(50).fill('word').join(' ') })],
      quotes: [qt('q1', 'e1', 0, 1, 'x'.repeat(1000))] }, { duration: 100 });
    assert.ok(m.events[0].summary.split(/\s+/).length <= 14, 'summary capped to <=14 words');
    assert.ok(m.quotes[0].text.length <= 240, 'quote text capped');
  });

  await ok('mergeSourceModels dedups overlapping events and duplicate quotes', () => {
    const a = { events: [ev('e1', 100, 110, { summary: 'driver refuses to exit', tension: 0.6 })], quotes: [qt('q1', 'e1', 101, 103, 'I am not getting out')] };
    const b = { events: [ev('e1', 100, 111, { summary: 'driver refuses to exit vehicle', tension: 0.9 })], quotes: [qt('q1', 'e1', 101.2, 103, 'I am not getting out')] };
    const merged = S.mergeSourceModels([a, b]);
    assert.equal(merged.events.length, 1, 'overlapping same-summary events merged');
    assert.equal(merged.events[0].tension, 0.9, 'kept the higher-tension version');
    assert.equal(merged.quotes.length, 1, 'duplicate quote removed');
  });

  console.log(`\nAll ${passed} source-model assertions passed.`);
})().catch(e => { console.error(e); process.exit(1); });
