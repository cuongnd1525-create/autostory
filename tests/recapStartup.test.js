const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Media = require('../electron/services/recap/recapMediaService');
const Vertex = require('../electron/services/vertexAiService');
const Provider = require('../electron/services/recap/recapProviderService');
const Pipeline = require('../electron/services/recap/recapPipelineService');
const Store = require('../electron/services/projectStore');

const cloudError = reason => JSON.stringify({ error: { message: reason === 'BILLING_DISABLED'
  ? 'This API method requires billing to be enabled.' : 'The API is disabled.', details: [
  { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, metadata: { service: 'aiplatform.googleapis.com' } }
] } });

test('billing disabled cannot be mistaken for service disabled when API and BILLING_DISABLED appear in the same response', () => {
  const error = Vertex.formatVertexApiError(403, cloudError('BILLING_DISABLED'), 'actual-project');
  assert.equal(error.reason, 'BILLING_DISABLED'); assert.equal(error.httpStatus, 403); assert.equal(error.kind, 'auth');
  assert.match(error.message, /Billing/); assert.match(error.actionUrl, /project=actual-project/);
  assert.doesNotMatch(error.message, /API chưa được bật/);
  const service = Vertex.formatVertexApiError(403, cloudError('SERVICE_DISABLED'), 'actual-project');
  assert.equal(service.reason, 'SERVICE_DISABLED'); assert.match(service.actionUrl, /aiplatform.googleapis.com/);
  const unrelated = Vertex.formatVertexApiError(403, JSON.stringify({ error: { message: 'Unrelated policy restriction',
    details: [{ reason: 'ORG_POLICY_DISABLED', metadata: { service: 'aiplatform.googleapis.com' } }] } }), 'p');
  assert.equal(unrelated.httpStatus, 403); assert.equal(unrelated.reason, undefined);
});

test('Vertex preflight validates the actual model using text only and caches only successful checks', async t => {
  const vertex = new Vertex({ vertexProjectId: 'p' }); let calls = 0, fail = true;
  vertex.getAccessToken = async () => 'test-token';
  t.mock.method(global, 'fetch', async (url, options) => {
    calls++; assert.match(url, /:countTokens$/); assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body); assert.deepEqual(Object.keys(body), ['contents']);
    assert.deepEqual(body.contents[0].parts, [{ text: 'Connection check.' }]);
    if (fail) return { ok: false, status: 403, text: async () => cloudError('BILLING_DISABLED') };
    return { ok: true, json: async () => ({ totalTokens: 3 }) };
  });
  try {
    await assert.rejects(vertex.checkAccess({ model: 'model-one' }), error => error.reason === 'BILLING_DISABLED');
    fail = false; assert.equal((await vertex.checkAccess({ model: 'model-one' })).ok, true);
    assert.equal((await vertex.checkAccess({ model: 'model-one' })).cached, true); assert.equal(calls, 2);
    await vertex.checkAccess({ model: 'model-two' }); assert.equal(calls, 3);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(vertex.checkAccess({ signal: controller.signal }), { name: 'AbortError' }); assert.equal(calls, 3);
  } finally { await vertex.dispatcher.close(); }
});

test('provider forwards the selected analysis model and cancellation to startup preflight', async () => {
  const controller = new AbortController(); let checked = 0;
  const provider = new Provider({ aiProvider: 'vertex_ai', vertexAnalysisModel: 'selected-model' }, { vertex: {
    checkAccess: async request => { checked++; assert.equal(request.model, 'selected-model'); assert.equal(request.signal, controller.signal); }
  } });
  await provider.preflight({ signal: controller.signal }); assert.equal(checked, 1);
  await new Provider({ aiProvider: 'antigravity_cli' }).preflight({});
});

test('startup preserves model fallback for capacity/retired models but never retries a billing failure on another model', async () => {
  const attempted = [];
  const provider = new Provider({ aiProvider: 'vertex_ai', vertexAnalysisModel: 'flash', vertexQualityModel: 'pro' }, { vertex: {
    checkAccess: async ({ model }) => { attempted.push(model); if (model === 'flash') throw Object.assign(Error('No capacity'), { httpStatus: 429 }); }
  } });
  await provider.preflight(); assert.deepEqual(attempted, ['flash', 'pro']);
  attempted.length = 0;
  provider.vertex.checkAccess = async ({ model }) => { attempted.push(model); throw Vertex.formatVertexApiError(403, cloudError('BILLING_DISABLED'), 'p'); };
  await assert.rejects(provider.preflight(), error => error.reason === 'BILLING_DISABLED');
  assert.deepEqual(attempted, ['flash']);
});

test('invalid cloud configuration stops before FFmpeg, scene indexing, media upload or model generation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recap-startup-'));
  try {
    const source = path.join(root, 'source.webm'); await fs.writeFile(source, 'fixture');
    const store = new Store(), project = await store.createProject(root, { title: 'startup', mode: 'recap', sourceVideoPath: source });
    let expensive = 0, checks = 0;
    const unexpected = () => { expensive++; throw Error('Unexpected expensive work'); };
    const service = new Pipeline({ projectStore: store, logger: { log() {} }, serviceFactories: {
      media: () => ({ probeVideo: async () => ({ duration: 12, width: 640, height: 360 }), ensureAnalysisProxy: unexpected, detectScenes: unexpected }),
      ai: () => ({ providerService: { preflight: async () => { checks++; throw Vertex.formatVertexApiError(403, cloudError('BILLING_DISABLED'), 'p'); } },
        analyzeVideoChunk: unexpected }), tts: () => ({}), renderer: () => ({})
    } });
    await assert.rejects(service.runRecapProject({ workspaceRoot: root, projectId: project.id }), error => error.reason === 'BILLING_DISABLED');
    assert.equal(checks, 1); assert.equal(expensive, 0);
    const state = await service._loadState(path.join(store.getProjectPaths(root, project.id).analysisDir, 'recap_state.json'));
    assert.equal(state.sourceMeta.duration, 12); assert.equal(state.proxyPath, undefined);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

async function proxyFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recap-proxy-recovery-'));
  const source = path.join(root, 'source.webm'); await fs.writeFile(source, 'source-unchanged');
  const media = new Media(), sourceMeta = { duration: 12, hasAudio: true, audioDurationSec: 12 };
  let duration = 12, encodes = 0, decodes = 0;
  const encodeArgs = [], warnings = [];
  media.probeVideo = async () => ({ duration, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true,
    audioDurationSec: duration, width: 480, height: 270, fps: 8 });
  const fixture = { root, media, encodeArgs, warnings, setDuration: value => { duration = value; },
    get encodes() { return encodes; }, get decodes() { return decodes; },
    encode: async () => {}, decode: async () => {},
    run: () => media.ensureAnalysisProxy({ sourceVideoPath: source, sourceMeta, outputDir: root,
      onProgress: value => warnings.push(value) }), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
  media.runCommand = async (binary, args) => {
    if (args.includes('null')) { decodes++; await fixture.decode(decodes); return {}; }
    encodes++; encodeArgs.push(args); await fs.writeFile(args.at(-1), Buffer.alloc(2048));
    await fixture.encode(encodes, args); return {};
  };
  return fixture;
}
const crash = code => Object.assign(Error('Native shutdown crash'), { exitCode: code, stderr: 'native crash' });

test('a shutdown access violation can recover only a complete proxy that fully decodes; cache reuse needs no re-encode', async () => {
  const f = await proxyFixture(); f.encode = async () => { throw crash(3221225477); };
  try {
    const file = await f.run(); assert.equal(f.encodes, 1); assert.equal(f.decodes, 1);
    assert.ok(f.warnings.some(item => item.level === 'WARNING' && /giải mã toàn bộ/.test(item.message)));
    assert.equal(await f.run(), file); assert.equal(f.encodes, 1); assert.equal(f.decodes, 1);
    assert.equal(await fs.readFile(path.join(f.root, 'source.webm'), 'utf8'), 'source-unchanged');
    const args = f.encodeArgs[0]; assert.ok(args.indexOf('-threads') < args.indexOf('-i'));
    assert.ok(args.indexOf('-threads:v') > args.indexOf('-i')); assert.ok(args.includes('-nostdin'));
    if (process.platform === 'win32') assert.match(args[args.indexOf('-vf') + 1], /fontfile=.*arial\.ttf/);
  } finally { await f.cleanup(); }
});

test('an incomplete native-crash output is discarded and retried once with a single decoder thread', async () => {
  const f = await proxyFixture();
  f.encode = async attempt => { f.setDuration(attempt === 1 ? 5 : 12); throw crash(-1073741819); };
  try {
    await f.run(); assert.equal(f.encodes, 2); assert.equal(f.decodes, 1);
    const args = f.encodeArgs[1]; assert.equal(args[args.indexOf('-threads') + 1], '1');
    assert.equal(args[args.indexOf('-threads:v') + 1], '2');
  } finally { await f.cleanup(); }
});

test('apparently complete but corrupt crash output never becomes an accepted proxy', async () => {
  const f = await proxyFixture(); f.encode = async () => { throw crash(3221225477); };
  f.decode = async () => { throw Error('Corrupt frame'); };
  try {
    await assert.rejects(f.run(), /Native shutdown crash/); assert.equal(f.encodes, 2); assert.equal(f.decodes, 2);
    const files = await fs.readdir(f.root); assert.ok(!files.some(file => file.endsWith('.mp4')));
    assert.ok(files.some(file => file.endsWith('.log')));
  } finally { await f.cleanup(); }
});

test('disk/ordinary FFmpeg failures cannot be ignored just because a file exists', async () => {
  const f = await proxyFixture(); f.encode = async () => { throw Object.assign(Error('No space left on device'), { exitCode: 1 }); };
  try {
    await assert.rejects(f.run(), /No space left/); assert.equal(f.encodes, 1); assert.equal(f.decodes, 0);
    assert.ok(!(await fs.readdir(f.root)).some(file => file.endsWith('.mp4')));
  } finally { await f.cleanup(); }
});
