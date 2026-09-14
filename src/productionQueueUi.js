(() => {
  window.initProductionQueue = openProject => {
    const api = window.cineviral;
    if (!api?.productionQueueList) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'production-dialog';
    dialog.innerHTML = `<header><h2>Hàng đợi Auto Story</h2><button type="button" data-close title="Đóng" aria-label="Đóng">×</button></header>
      <div class="production-toolbar"><label>Dự án / cấu hình mẫu<select data-project></select></label>
      <button data-add>Thêm dự án</button><button data-files>Thêm nhiều video…</button></div>
      <details class="production-urls"><summary>Thêm URL YouTube / TikTok</summary><label>Danh sách URL<textarea data-urls rows="3" placeholder="https://www.youtube.com/watch?v=…"></textarea></label><button data-add-urls>Thêm URL vào hàng đợi</button></details>
      <div class="production-toolbar"><button data-start>Bắt đầu hàng đợi</button><button data-pause>Tạm dừng nhận việc</button><span data-summary></span></div>
      <p class="production-error" data-error role="alert"></p>
      <div class="production-list" data-jobs></div>`;
    document.body.append(dialog);
    const $ = selector => dialog.querySelector(selector);
    const states = { queued: 'Chờ xử lý', running: 'Đang xử lý', complete: 'Đã xử lý', needs_attention: 'Cần xem kết quả', failed: 'Lỗi', cancelled: 'Đã dừng', interrupted: 'Bị gián đoạn' };
    let busy = false, snapshot;
    const apply = data => {
      snapshot = data;
      const done = data.jobs.filter(job => ['complete', 'needs_attention', 'failed'].includes(job.status)).length;
      $('[data-summary]').textContent = `${done}/${data.jobs.length} URL đã xử lý · ${data.active}/${data.limit} đang chạy · ${data.paused ? 'Đã dừng nhận việc mới' : 'Đang nhận việc'}`;
      $('[data-start]').disabled = busy || !data.paused;
      $('[data-pause]').disabled = busy || data.paused;
      $('[data-jobs]').replaceChildren();
      if (!data.jobs.length) { const p = document.createElement('p'); p.textContent = 'Chưa có video trong hàng đợi.'; $('[data-jobs]').append(p); }
      for (const job of data.jobs) {
        const row = document.createElement('article'); row.className = 'production-row';
        const details = document.createElement('div'); details.className = 'production-details';
        const title = document.createElement('strong'); title.textContent = job.title || job.projectId;
        const state = document.createElement('span'); state.className = `production-state ${job.status}`;
        state.textContent = states[job.status] || job.status;
        const message = document.createElement('p'); message.textContent = job.error || job.message || (job.pendingSourceUrl ? 'Đang chờ tải nguồn…' : '');
        details.append(title, state, message);
        const actions = document.createElement('div'); actions.className = 'production-actions';
        const button = (text, action) => {
          const b = document.createElement('button'); b.textContent = text; b.disabled = busy;
          b.onclick = () => execute(action); actions.append(b);
        };
        if (['running', 'queued', 'interrupted'].includes(job.status)) button('Dừng', () => api.productionQueueAction(job.id, 'cancel'));
        if (['failed', 'cancelled', 'interrupted', 'needs_attention'].includes(job.status)) button('Thử lại', () => api.productionQueueAction(job.id, 'retry'));
        if (!job.pendingSourceUrl && !['running', 'queued'].includes(job.status)) button('Mở dự án', async () => {
          const project = await api.productionQueueOpen(job.id); dialog.close(); openProject(project);
        });
        row.append(details, actions); $('[data-jobs]').append(row);
      }
    };
    const execute = async action => {
      if (busy) return; busy = true; $('[data-error]').textContent = '';
      if (snapshot) apply(snapshot);
      try { const result = await action(); if (result?.jobs) snapshot = result; }
      catch (error) { $('[data-error]').textContent = error.message || String(error); }
      finally { busy = false; if (snapshot) apply(snapshot); }
    };
    const refreshProjects = async () => {
      const projects = (await api.listProjects()).filter(p => p.analysisWorkflow === 'vertex_auto_story');
      const selected = $('[data-project]').value;
      $('[data-project]').replaceChildren();
      for (const p of projects) {
        const option = document.createElement('option'); option.value = p.id;
        option.textContent = `${p.title} · ${p.autoStoryConfig?.outputCount || 2} kịch bản · ${p.autoStoryConfig?.targetDurationMinSec || 65}–${p.autoStoryConfig?.targetDurationMaxSec || 90}s · ${p.draftVoiceId || p.voiceId || p.voiceProvider}`;
        $('[data-project]').append(option);
      }
      if (projects.some(p => p.id === selected)) $('[data-project]').value = selected;
      $('[data-add]').disabled = $('[data-files]').disabled = $('[data-add-urls]').disabled = !projects.length;
    };
    document.getElementById('open-production-queue').onclick = () => {
      dialog.showModal();
      execute(async () => { await refreshProjects(); return api.productionQueueList(); });
    };
    $('[data-close]').onclick = () => dialog.close();
    $('[data-start]').onclick = () => execute(() => api.productionQueueAction(null, 'start'));
    $('[data-pause]').onclick = () => execute(() => api.productionQueueAction(null, 'pause'));
    $('[data-add]').onclick = () => execute(() => api.productionQueueAdd([$('[data-project]').value]));
    $('[data-files]').onclick = () => execute(async () => {
      const result = await api.productionQueueAddVideos($('[data-project]').value); await refreshProjects(); return result;
    });
    $('[data-add-urls]').onclick = () => execute(async () => {
      const urls = $('[data-urls]').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const result = await api.productionQueueAddUrls($('[data-project]').value, urls); $('[data-urls]').value = ''; return result;
    });
    api.onProductionProgress(data => { snapshot = data; if (dialog.open) apply(data); });
  };
})();
