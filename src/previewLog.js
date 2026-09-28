(() => {
  function compact(message) {
    return String(message || '')
      .replace(/^(?:(?:auto_story|rendering|reviewing|draft_audit|final_check|complete|highlight|draft|ready):\s*)+/i, '')
      .replace(/(Script\s+\d+:\s*)(?:\1)+/gi, '$1')
      .replace(/Vertex AI đang phân tích bằng ([^·\n]+)\s*·\s*đã chạy /g, '$1 · ')
      .replace(/Vertex đã chuẩn bị /g, 'Chuẩn bị ');
  }

  const byId = id => document.getElementById(id);
  const entries = [];
  const list = byId('preview-log-entries');
  const filter = byId('preview-log-filter');
  const follow = byId('preview-log-follow');
  const smartList = byId('preview-smart-milestones');
  const rawContainer = byId('preview-raw-log-container');
  const btnSmart = byId('btn-log-smart');
  const btnRaw = byId('btn-log-raw');


  // Stepper Elements
  const stepperLabel = byId('stepper-current-label');
  const stepperPercent = byId('stepper-percent');
  const stepperFill = byId('stepper-bar-fill');

  // View Switcher logic
  let activeView = 'raw';
  function setView(view) {
    activeView = view;
    if (btnSmart) btnSmart.classList.toggle('active', view === 'smart');
    if (btnRaw) btnRaw.classList.toggle('active', view === 'raw');
    if (smartList) smartList.classList.toggle('hidden', view !== 'smart');
    if (rawContainer) rawContainer.classList.toggle('hidden', view !== 'raw');
    if (view === 'raw') {
      renderRaw();
    } else {
      renderSmart();
    }
  }

  if (btnSmart) btnSmart.addEventListener('click', () => setView('smart'));
  if (btnRaw) btnRaw.addEventListener('click', () => setView('raw'));

  // Milestone definitions
  const STEP_CONFIG = [
    { id: 1, name: 'Nạp nguồn', icon: '🎬', pattern: /source|preprocess|extract|video_info|analyze_scenes|evidence|nạp nguồn/i },
    { id: 2, name: 'Kịch bản V2', icon: '📝', pattern: /analysis|script|review|draft_audit|rewrite|spine|gemini|vertex|kịch bản/i },
    { id: 3, name: 'Thu âm AI', icon: '🎙️', pattern: /voice|tts|asr|speech|audio_gen|elevenlabs|kokoro|edge_tts|thu âm|giọng đọc/i },
    { id: 4, name: 'Cắt & Ducking', icon: '✂️', pattern: /render|draft|ducking|clip|video_cut|sidechain|ffmpeg|cắt ghép/i },
    { id: 5, name: 'Xuất bản', icon: '🚀', pattern: /publish|subtitle|final|ready|complete|export|hoàn tất|xuất bản/i }
  ];

  let currentStepId = 1;
  const milestones = [];

  function updateStepper(stepId, percent, message) {
    currentStepId = Math.max(1, Math.min(5, stepId));
    if (stepperLabel && message) stepperLabel.textContent = compact(message);
    if (stepperPercent && percent != null) stepperPercent.textContent = `${Math.round(percent)}%`;
    if (stepperFill && percent != null) stepperFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;

    const stepNodes = document.querySelectorAll('#pipeline-stepper .step-node');
    stepNodes.forEach((node) => {
      const id = parseInt(node.dataset.stepId, 10);
      node.classList.remove('active', 'completed');
      if (id < currentStepId) {
        node.classList.add('completed');
      } else if (id === currentStepId) {
        node.classList.add('active');
      }
    });
  }

  function detectStep(text, percent) {
    const s = String(text || '');
    for (let i = STEP_CONFIG.length - 1; i >= 0; i--) {
      if (STEP_CONFIG[i].pattern.test(s)) {
        return STEP_CONFIG[i].id;
      }
    }
    if (percent != null && percent > 0) {
      if (percent >= 98) return 5;
      if (percent >= 70) return 4;
      if (percent >= 45) return 3;
      if (percent >= 20) return 2;
      return 1;
    }
    return currentStepId;
  }

  function renderSmart() {
    if (!smartList) return;
    if (!milestones.length) {
      smartList.innerHTML = '<div class="milestone-empty">Chưa có giai đoạn xử lý nào được ghi nhận.</div>';
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const m of milestones) {
      const card = document.createElement('div');
      card.className = `smart-milestone-card ${m.status}`;
      
      const header = document.createElement('div');
      header.className = 'milestone-header';
      header.innerHTML = `
        <span class="milestone-icon">${m.icon}</span>
        <div class="milestone-title-group">
          <strong>${m.title}</strong>
          <span class="milestone-time">${m.time}</span>
        </div>
        <span class="milestone-badge ${m.status}">${m.statusText}</span>
      `;
      
      const body = document.createElement('div');
      body.className = 'milestone-body';
      body.textContent = m.details;

      card.append(header, body);
      fragment.append(card);
    }
    smartList.replaceChildren(fragment);
    smartList.scrollTop = smartList.scrollHeight;
  }

  function addOrUpdateMilestone(stepId, title, message, status = 'running') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const cfg = STEP_CONFIG[stepId - 1] || STEP_CONFIG[0];
    const statusLabels = {
      running: 'Đang chạy',
      success: 'Hoàn thành',
      warning: 'Cảnh báo',
      error: 'Lỗi'
    };

    const cleanMsg = compact(message);
    if (!cleanMsg) return;

    // If active milestone has same step and was running, update it
    const last = milestones[milestones.length - 1];
    if (last && last.stepId === stepId && last.status === 'running' && status === 'running') {
      last.time = time;
      last.details = cleanMsg;
    } else {
      // Mark previous running milestone as success if moving forward
      if (last && last.status === 'running' && last.stepId < stepId) {
        last.status = 'success';
        last.statusText = statusLabels.success;
      }
      milestones.push({
        id: Date.now(),
        stepId,
        icon: cfg.icon,
        title: title || cfg.name,
        time,
        status,
        statusText: statusLabels[status] || statusLabels.running,
        details: cleanMsg
      });
      if (milestones.length > 50) milestones.shift();
    }
    renderSmart();
  }

  function renderRaw() {
    if (!list) return;
    const top = list.scrollTop;
    const visible = entries.filter(e => filter?.value === 'all' || (filter?.value === 'issues'
      ? ['ERROR', 'WARNING'].includes(e.level) : e.level === filter?.value));
    const fragment = document.createDocumentFragment();
    for (const entry of visible) {
      const row = document.createElement('div');
      row.className = `preview-log-entry ${entry.level.toLowerCase()}`;
      const meta = document.createElement('small'), message = document.createElement('div');
      meta.textContent = `${entry.time} · ${entry.level === 'ERROR' ? 'Lỗi' : entry.level === 'WARNING' ? 'Cảnh báo' : 'Thông tin'}`;
      message.textContent = compact(entry.message);
      row.append(meta, message);
      fragment.append(row);
    }
    if (!visible.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = entries.length ? 'Không có mục phù hợp.' : 'Chưa có nhật ký.';
      fragment.append(empty);
    }
    list.replaceChildren(fragment);
    if (follow?.checked) {
      list.scrollTop = list.scrollHeight;
    } else {
      list.scrollTop = top;
    }
  }

  if (filter) filter.addEventListener('change', renderRaw);
  if (follow) follow.addEventListener('change', () => { if (follow.checked && list) list.scrollTop = list.scrollHeight; });

  const copyBtn = byId('preview-log-copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        let text = '';
        if (activeView === 'smart' && milestones.length) {
          text = milestones.map(m => `[${m.time}] [${m.status.toUpperCase()}] ${m.title}: ${m.details}`).join('\n');
        } else {
          text = entries.map(e => `${e.time} [${e.level}] ${e.message}`).join('\n');
        }
        await navigator.clipboard.writeText(text);
        copyBtn.title = 'Đã sao chép nhật ký';
      } catch (_) {
        copyBtn.title = 'Không sao chép được nhật ký';
      }
      copyBtn.setAttribute('aria-label', copyBtn.title);
    });
  }

  window.previewLog = {
    compact,
    append(message, level = 'INFO') {
      const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
      const upperLevel = String(level).toUpperCase();
      entries.push({ message: String(message), level: upperLevel, time });
      if (entries.length > 500) entries.shift();
      const timeEl = byId('preview-log-time');
      if (timeEl) timeEl.textContent = `Cập nhật ${time} · Phiên làm việc hiện tại`;
      
      const stepId = detectStep(message);
      if (upperLevel === 'ERROR') {
        addOrUpdateMilestone(stepId, STEP_CONFIG[stepId - 1].name, message, 'error');
      } else if (upperLevel === 'WARNING') {
        addOrUpdateMilestone(stepId, STEP_CONFIG[stepId - 1].name, message, 'warning');
      }

      if (activeView === 'raw') {
        renderRaw();
      }
    },
    progress(payload) {
      if (!payload) return;
      const step = payload.stage || payload.step || '';
      const msg = payload.message || step;
      const percent = payload.percent != null ? Number(payload.percent) : null;
      const stageEl = byId('preview-log-stage');
      if (stageEl) stageEl.textContent = compact(msg) || 'Đang xử lý';

      const stepId = detectStep(`${step} ${msg}`, percent);
      updateStepper(stepId, percent, msg);

      const isDone = percent != null && percent >= 100;
      addOrUpdateMilestone(stepId, STEP_CONFIG[stepId - 1].name, msg, isDone ? 'success' : 'running');
    },
    updateStepper,
    reset() {
      milestones.length = 0;
      entries.length = 0;
      updateStepper(1, 0, 'Sẵn sàng');
      renderSmart();
      renderRaw();
    }
  };

  renderSmart();
  renderRaw();
})();
