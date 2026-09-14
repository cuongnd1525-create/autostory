const path = require('path');
const fs = require('fs/promises');
const Queue = require('./productionQueue');
const SourceDownload = require('./sourceDownloadService');
const { getCancelToken } = require('./cancelToken');

function install({ ipcMain, dialog, app, BrowserWindow, store, dubbing, getSettings, getWorkspaceRoot, isForegroundBusy = () => false }) {
  const foregroundBusy = () => isForegroundBusy() || Boolean(getCancelToken());
  let ready;
  let queue;
  const getQueue = () => ready ||= (async () => {
    queue = new Queue(path.join(app.getPath('userData'), 'production-queue.json'), async (job, signal, onProgress) => {
      const Runner = require('./autoStoryRunner');
      // Credentials stay in settings, not in the durable queue file.
      const settings = { ...getSettings(), ...job.modelSettings, workspaceRoot: job.workspaceRoot };
      if (job.pendingSourceUrl) {
        const source = await require('./productionResourcePool').withSlot('production-download', 1, signal,
          () => new SourceDownload({ ...settings, sourceDownloadRoot: path.join(path.dirname(job.workspaceRoot), 'sources', 'queue', job.id) }).download({ url: job.pendingSourceUrl,
            onProgress: p => onProgress({ message: p.message, percent: 0 }) }));
        signal.throwIfAborted();
        const project = await store.createProject(job.workspaceRoot, { ...job.templateConfig, sourceVideoPath: source.videoPath,
          subtitleSourcePath: source.subtitlePath, title: source.title });
        job.projectId = project.id; job.title = project.title;
        delete job.pendingSourceUrl; delete job.templateConfig;
        await queue.save();
      }
      const result = await new Runner(settings, store, dubbing).run({ workspaceRoot: job.workspaceRoot, projectId: job.projectId, signal, onProgress });
      const project = result.project;
      const jobs = Object.values(project.autoStoryProduction?.jobs || {});
      const failures = project.autoStoryState?.failures || [];
      const missing = (project.analysis?.highlightVariants?.length || 0) < (project.autoStoryConfig?.outputCount || 2);
      const needsAttention = missing || failures.length > 0 || !jobs.length || jobs.some(j => j.phase !== 'complete');
      return { needsAttention, projectId: project.id, error: [...failures.map(f => f.error), ...jobs.filter(j => j.error).map(j => j.error), missing ? 'Chưa đủ số kịch bản yêu cầu.' : ''].filter(Boolean).join('\n') };
    }, snapshot => {
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('production:progress', snapshot);
    });
    await queue.load(); return queue;
  })();
  const validateProject = async id => {
    if (typeof id !== 'string' || path.basename(id) !== id || id === '..') throw new Error('Dự án không hợp lệ.');
    const project = await store.getProject(getWorkspaceRoot(), id);
    if (project.analysisWorkflow !== 'vertex_auto_story') throw new Error('Hàng đợi chỉ hỗ trợ dự án Auto Story.');
    await fs.access(project.sourceVideoPath);
    return project;
  };
  const templateConfig = template => {
    const fields = ['autoStoryConfig', 'sourceLanguage', 'narrationLanguage', 'targetLanguage', 'voiceProvider', 'voiceId', 'voiceSpeed',
      'draftVoiceMode', 'draftVoiceProvider', 'draftVoiceId', 'targetDuration', 'framePreset', 'narrationEnabled'];
    const settings = getSettings();
    return { ...Object.fromEntries(fields.map(key => [key, template[key]])), analysisWorkflow: 'vertex_auto_story', mode: 'highlight_cut',
      exportRoot: settings.exportRoot, exportLayout: settings.exportLayout,
      videoDecoration: { ...template.videoDecoration, topCaptionText: '', partLabelText: '' } };
  };
  const modelSettings = () => Object.fromEntries(Object.entries(getSettings()).filter(([key]) => /^vertex(?:Economy|Analysis|Quality|AutoStory\w*)Model$/.test(key)));
  const add = async ids => {
    const q = await getQueue();
    if (foregroundBusy()) throw new Error('Hãy đợi thao tác hiện tại kết thúc trước khi thêm công việc.');
    const items = [];
    for (const id of ids) {
      const project = await validateProject(id);
      items.push({ projectId: id, title: project.title, workspaceRoot: getWorkspaceRoot(),
        sourceKey: (await fs.realpath(project.sourceVideoPath)).toLowerCase(), modelSettings: modelSettings() });
    }
    if (foregroundBusy()) throw new Error('Hãy đợi thao tác hiện tại kết thúc trước khi thêm công việc.');
    return q.add(items);
  };
  ipcMain.handle('production:list', async () => (await getQueue()).snapshot());
  ipcMain.handle('production:add', async (_event, ids) => {
    if (!Array.isArray(ids) || !ids.length || ids.length > 50) throw new Error('Chọn từ 1 đến 50 dự án.');
    return add(ids);
  });
  ipcMain.handle('production:action', async (_event, id, action) => {
    const q = await getQueue();
    if (['start', 'retry'].includes(action) && foregroundBusy()) throw new Error('Hãy đợi thao tác hiện tại kết thúc trước khi chạy hàng đợi.');
    return q.action(id, action);
  });
  ipcMain.handle('production:open', async (_event, id) => {
    const q = await getQueue(), job = q.jobs.find(j => j.id === id);
    if (!job) throw new Error('Không tìm thấy công việc.');
    if (q.active.has(id)) throw new Error('Video đang xử lý. Bạn có thể mở kết quả khi công việc dừng hoặc hoàn tất.');
    if (job.pendingSourceUrl) throw new Error('Nguồn chưa tải xong nên chưa có dự án để mở.');
    if (path.resolve(job.workspaceRoot) !== path.resolve(getWorkspaceRoot())) throw new Error('Hãy chọn lại thư mục workspace của công việc trong Cài đặt trước khi mở.');
    return store.getProject(job.workspaceRoot, job.projectId);
  });
  ipcMain.handle('production:addVideos', async (_event, templateId) => {
    if (foregroundBusy()) throw new Error('Hãy đợi thao tác hiện tại kết thúc trước khi thêm video.');
    const template = await validateProject(templateId);
    const selection = await dialog.showOpenDialog({ title: 'Chọn video cho hàng đợi Auto Story', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Video', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v'] }] });
    if (selection.canceled) return (await getQueue()).snapshot();
    if (selection.filePaths.length > 50) throw new Error('Mỗi lượt chọn tối đa 50 video.');
    const config = templateConfig(template), ids = [];
    for (const video of selection.filePaths) {
      const p = await store.createProject(getWorkspaceRoot(), { ...config, title: path.parse(video).name, sourceVideoPath: video });
      ids.push(p.id);
    }
    return add(ids);
  });
  ipcMain.handle('production:addUrls', async (_event, templateId, urls) => {
    if (foregroundBusy()) throw new Error('Hãy đợi thao tác hiện tại kết thúc trước khi thêm URL.');
    if (!Array.isArray(urls) || !urls.length || urls.length > 50) throw new Error('Nhập từ 1 đến 50 URL.');
    const template = await validateProject(templateId), config = templateConfig(template);
    const sources = [...new Set(urls.map(url => SourceDownload.validateSourceUrl(url).url))];
    const q = await getQueue();
    const items = sources.filter(url => !q.jobs.some(j => j.sourceKey === url && ['queued', 'running', 'interrupted'].includes(j.status))).map(url => ({
      projectId: `download-${require('crypto').randomUUID()}`, workspaceRoot: getWorkspaceRoot(), title: url, sourceKey: url,
      pendingSourceUrl: url, templateConfig: config, modelSettings: modelSettings()
    }));
    if (foregroundBusy()) throw new Error('Hãy đợi thao tác hiện tại kết thúc trước khi thêm URL.');
    return q.add(items);
  });
  return { isRunning: () => Boolean(queue?.active.size || (queue && !queue.paused && queue.jobs.some(j => j.status === 'queued'))) };
}
module.exports = { install };
