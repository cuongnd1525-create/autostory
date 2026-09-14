const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { serial } = require('./autoStoryWorkQueue');
const { createScopedToken, runWithCancelToken, cancelToken } = require('./cancelToken');
class ProductionQueue {
  constructor(file, execute, notify = () => {}) {
    this.file = file; this.execute = execute; this.notify = notify; this.jobs = []; this.active = new Map(); this.paused = true;
  }
  async load() {
    try { this.jobs = JSON.parse(await fs.readFile(this.file, 'utf8')).jobs || []; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const j of this.jobs) if (j.status === 'running') { j.status = 'interrupted'; j.error = 'Ứng dụng đóng khi đang xử lý. Bấm thử lại để tiếp tục.'; }
    await this.save(); return this.snapshot();
  }
  snapshot() { return { paused: this.paused, jobs: structuredClone(this.jobs), active: this.active.size, limit: 2 }; }
  publish() { try { this.notify(this.snapshot()); } catch (_) { /* UI disconnection must not interrupt processing. */ } }
  async save() {
    return serial(this.file, async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      await fs.writeFile(temp, JSON.stringify({ jobs: this.jobs }, null, 2)); await fs.rename(temp, this.file);
      this.publish();
    });
  }
  async add(items) {
    if (!Array.isArray(items) || items.some(item => !item.workspaceRoot || !item.projectId || !item.sourceKey)) throw new Error('Thiếu thông tin dự án hoặc nguồn video.');
    for (const item of items) {
      if (this.jobs.some(j => j.workspaceRoot === item.workspaceRoot && j.projectId === item.projectId && ['queued', 'running', 'interrupted'].includes(j.status))) continue;
      this.jobs.push({ ...structuredClone(item), id: crypto.randomUUID(), status: 'queued', progress: 0, createdAt: new Date().toISOString(), error: '' });
    }
    await this.save(); this.pump(); return this.snapshot();
  }
  async action(id, action) {
    if (action === 'start') this.paused = false;
    else if (action === 'pause') this.paused = true;
    else {
      const j = this.jobs.find(j => j.id === id); if (!j) throw new Error('Không tìm thấy công việc.');
      if (action === 'cancel' && ['running', 'queued', 'interrupted'].includes(j.status)) { if (this.active.has(id)) cancelToken(this.active.get(id)); else j.status = 'cancelled'; }
      else if (action === 'retry' && ['failed', 'cancelled', 'interrupted', 'needs_attention'].includes(j.status) && !this.active.has(id)) {
        if (this.jobs.some(other => other.id !== id && other.workspaceRoot === j.workspaceRoot && other.projectId === j.projectId && ['queued', 'running', 'interrupted'].includes(other.status))) throw new Error('Dự án đã có trong hàng đợi.');
        j.status = 'queued'; j.error = ''; j.progress = 0; j.message = ''; delete j.finishedAt;
      }
      else throw new Error('Thao tác không hợp lệ.');
    }
    await this.save(); this.pump(); return this.snapshot();
  }
  pump() {
    if (this.paused) return;
    while (this.active.size < 2) {
      const j = this.jobs.find(j => j.status === 'queued' && !this.jobs.some(a => this.active.has(a.id) && (a.sourceKey === j.sourceKey || (a.workspaceRoot === j.workspaceRoot && a.projectId === j.projectId))));
      if (!j) break;
      const token = createScopedToken(j.id); this.active.set(j.id, token); j.status = 'running'; j.startedAt = new Date().toISOString();
      void this.process(j, token).catch(error => {
        this.paused = true; j.status = 'failed'; j.error = `Không lưu được hàng đợi: ${error.message}`; this.publish();
      });
    }
  }
  async process(j, token) {
    try {
      await this.save();
      const result = await runWithCancelToken(token, () => this.execute(j, token.abortController.signal, progress => {
        j.progress = Math.max(j.progress, Math.min(99, Number(progress.percent) || 0));
        j.message = progress.message || j.message;
        // Queue progress is separate from the foreground preview stream.
        this.publish();
      }));
      if (token.cancelled) throw new Error(token.reason || 'Đã dừng công việc.');
      j.status = result?.needsAttention ? 'needs_attention' : 'complete'; j.progress = 100; j.error = result?.error || '';
      j.outputProjectId = result?.projectId || j.projectId || '';
    } catch (e) { j.status = token.cancelled ? 'cancelled' : 'failed'; j.error = e.message || String(e); }
    finally { this.active.delete(j.id); j.finishedAt = new Date().toISOString(); await this.save(); this.pump(); }
  }
}
module.exports = ProductionQueue;
