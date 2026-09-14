const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const Store = require('../electron/services/projectStore');
const { install } = require('../electron/services/productionQueueIpc');
const { createCancelToken, clearCancelToken } = require('../electron/services/cancelToken');
const Download = require('../electron/services/sourceDownloadService');
const delay = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-ipc-'));
  const runnerPath = require.resolve('../electron/services/autoStoryRunner');
  const original = require.cache[runnerPath];
  const originalDownload = Download.prototype.download;
  const received = [];
  require.cache[runnerPath] = { id: runnerPath, filename: runnerPath, loaded: true, exports: class {
    constructor(settings) { this.settings = settings; }
    async run(args) {
      received.push({ ...args, settings: this.settings });
      args.onProgress({ percent: 90, project: { id: 'must-not-switch-preview' }, autoStoryDraftReady: true });
      return { project: { autoStoryConfig: { outputCount: 1 }, analysis: { highlightVariants: [{}] },
        autoStoryProduction: { jobs: { 1: { phase: 'complete' } } } } };
    }
  } };
  try {
    const store = new Store(), handlers = new Map(), events = [];
    const source = path.join(root, 'input.mp4'), second = path.join(root, 'second.mp4');
    await fs.writeFile(source, 'fixture'); await fs.writeFile(second, 'fixture');
    const template = await store.createProject(root, { sourceVideoPath: source, analysisWorkflow: 'vertex_auto_story',
      autoStoryConfig: { outputCount: 3, minDurationSec: 65, maxDurationSec: 150 }, voiceProvider: 'kokoro', voiceId: 'am_adam',
      draftVoiceId: 'am_adam', videoDecoration: { topCaptionText: 'Do not copy this title' } });
    const manager = install({ ipcMain: { handle: (key, fn) => handlers.set(key, fn) },
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [second] }) },
      app: { getPath: () => root }, BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel, payload) => events.push({ channel, payload }) } }] },
      store, dubbing: {}, getSettings: () => ({ vertexAutoStoryEditModel: 'selected-model', secret: 'do-not-persist' }), getWorkspaceRoot: () => root });
    const call = (key, ...args) => handlers.get(`production:${key}`)(null, ...args);
    const foreground = createCancelToken('foreground');
    await assert.rejects(call('add', [template.id]), /đợi thao tác/); clearCancelToken(foreground);
    await assert.rejects(call('add', ['../outside']), /không hợp lệ/);
    const added = await call('addVideos', template.id);
    assert.equal(added.jobs.length, 1);
    const created = await store.getProject(root, added.jobs[0].projectId);
    assert.equal(created.sourceVideoPath, second); assert.equal(created.draftVoiceId, 'am_adam');
    assert.deepEqual(created.autoStoryConfig, template.autoStoryConfig);
    assert.equal(created.videoDecoration.topCaptionText, ''); assert.equal(created.analysis, null);
    await call('action', null, 'start');
    for (let i = 0; i < 300 && (await call('list')).jobs[0].status !== 'complete'; i++) await delay(5);
    const done = await call('list'); assert.equal(done.jobs[0].status, 'complete');
    assert.equal(manager.isRunning(), false); assert.equal(received.length, 1);
    assert.equal(received[0].settings.vertexAutoStoryEditModel, 'selected-model');
    assert.ok(events.every(e => e.channel === 'production:progress'), 'Never send foreground pipeline progress');
    assert.equal((await call('open', done.jobs[0].id)).id, created.id);
    const disk = await fs.readFile(path.join(root, 'production-queue.json'), 'utf8');
    assert.ok(!disk.includes('do-not-persist'));
    await call('action', null, 'pause');
    await assert.rejects(call('addUrls', template.id, ['https://example.com/video']), /YouTube và TikTok/);
    const urls = await call('addUrls', template.id, ['https://www.youtube.com/watch?v=example', 'https://www.youtube.com/watch?v=example']);
    assert.equal(urls.jobs.length, 2); assert.equal(urls.jobs[1].pendingSourceUrl, 'https://www.youtube.com/watch?v=example');
    assert.equal(urls.jobs[1].templateConfig.draftVoiceId, 'am_adam');
    await assert.rejects(call('open', urls.jobs[1].id), /chưa tải xong/);
    let downloaded = 0;
    Download.prototype.download = async function ({ onProgress }) {
      downloaded++; assert.match(this.settings.sourceDownloadRoot, /queue/);
      onProgress({ percent: 50, message: 'Đang tải video' });
      return { videoPath: source, subtitlePath: '', title: 'Downloaded fixture' };
    };
    await call('action', null, 'start');
    for (let i = 0; i < 300 && (await call('list')).jobs[1].status !== 'complete'; i++) await delay(5);
    const downloadedJob = (await call('list')).jobs[1];
    assert.equal(downloadedJob.status, 'complete'); assert.equal(downloadedJob.pendingSourceUrl, undefined);
    assert.equal(downloaded, 1); assert.equal((await call('open', downloadedJob.id)).title, 'Downloaded fixture');
    assert.equal(received.length, 2);
    console.log('productionQueueIpc: model snapshot, template copying, foreground guard, output routing and secrets passed');
  } finally {
    Download.prototype.download = originalDownload;
    if (original) require.cache[runnerPath] = original; else delete require.cache[runnerPath];
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
