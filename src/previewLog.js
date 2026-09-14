(() => {
  const byId = id => document.getElementById(id);
  const entries = [], list = byId('preview-log-entries');
  const filter = byId('preview-log-filter'), follow = byId('preview-log-follow');
  const tools = byId('segment-tools');
  byId('dialogue-tab').prepend(tools);
  function render() {
    const top = list.scrollTop;
    const visible = entries.filter(e => filter.value === 'all' || (filter.value === 'issues'
      ? ['ERROR', 'WARNING'].includes(e.level) : e.level === filter.value));
    const fragment = document.createDocumentFragment();
    for (const entry of visible) {
      const row = document.createElement('div');
      row.className = `preview-log-entry ${entry.level.toLowerCase()}`;
      const meta = document.createElement('small'), message = document.createElement('div');
      meta.textContent = `${entry.time} · ${entry.level === 'ERROR' ? 'Lỗi' : entry.level === 'WARNING' ? 'Cảnh báo' : 'Thông tin'}`;
      message.textContent = entry.message;
      row.append(meta, message); fragment.append(row);
    }
    if (!visible.length) {
      const empty = document.createElement('p');
      empty.className = 'muted'; empty.textContent = entries.length ? 'Không có mục phù hợp.' : 'Chưa có nhật ký.';
      fragment.append(empty);
    }
    list.replaceChildren(fragment);
    list.scrollTop = follow.checked ? list.scrollHeight : top;
  }
  filter.addEventListener('change', render);
  follow.addEventListener('change', () => { if (follow.checked) list.scrollTop = list.scrollHeight; });
  byId('preview-log-copy').addEventListener('click', async () => {
    const button = byId('preview-log-copy');
    try {
      await navigator.clipboard.writeText(entries.map(e => `${e.time} [${e.level}] ${e.message}`).join('\n'));
      button.title = 'Đã sao chép nhật ký';
    } catch (_) { button.title = 'Không sao chép được nhật ký'; }
    button.setAttribute('aria-label', button.title);
  });
  window.previewLog = {
    append(message, level = 'INFO') {
      const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
      entries.push({ message: String(message), level: String(level).toUpperCase(), time });
      if (entries.length > 500) entries.shift();
      byId('preview-log-time').textContent = `Cập nhật ${time} · Phiên làm việc hiện tại`;
      render();
    },
    progress(payload) {
      const step = payload.stage || payload.step;
      byId('preview-log-stage').textContent = [step, payload.message].filter(Boolean).join(': ') || 'Đang xử lý';
    }
  };
  render();
})();
