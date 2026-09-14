const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'production-ui-'));
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.setContent('<!doctype html><html lang="vi"><meta charset="utf-8"><body style="background:#0c1015;font-family:Arial"><button id="open-production-queue">Hàng đợi</button></body></html>');
    await page.addStyleTag({ path: path.resolve('src/productionQueue.css') });
    await page.evaluate(() => {
      window.calls = [];
      window.snapshot = { paused: true, active: 0, limit: 2, jobs: ['queued', 'failed', 'complete', 'needs_attention', 'interrupted', 'cancelled'].map((status, i) => ({
        id: String(i), projectId: `project-${i}`, title: `Video ${i + 1}: Câu chuyện và bằng chứng được xác minh tại hiện trường`, status,
        error: status === 'failed' ? 'Lỗi kết nối tạm thời. Draft hiện tại được giữ lại. '.repeat(6) : '', message: 'Đã lưu tiến trình hiện tại.'
      })) };
      window.cineviral = {
        listProjects: async () => [{ id: 'p', title: 'Dự án mẫu', analysisWorkflow: 'vertex_auto_story', draftVoiceId: 'am_adam', autoStoryConfig: { outputCount: 3 } }],
        productionQueueList: async () => window.snapshot,
        productionQueueAdd: async ids => { window.calls.push(['add', ids]); return window.snapshot; },
        productionQueueAddVideos: async id => { window.calls.push(['files', id]); return window.snapshot; },
        productionQueueAddUrls: async (id, urls) => { window.calls.push(['urls', id, urls]); return window.snapshot; },
        productionQueueAction: async (id, action) => { window.calls.push([action, id]); window.snapshot.paused = action === 'pause'; return window.snapshot; },
        productionQueueOpen: async id => ({ id }), onProductionProgress: fn => { window.progress = fn; }
      };
    });
    await page.addScriptTag({ path: path.resolve('src/productionQueueUi.js') });
    await page.evaluate(() => window.initProductionQueue(project => { window.opened = project.id; }));
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.click('#open-production-queue'); await page.waitForSelector('.production-row');
    await page.click('[data-files]'); assert.deepEqual(await page.evaluate(() => window.calls[0]), ['files', 'p']);
    await page.click('.production-urls summary');
    await page.fill('[data-urls]', 'https://www.youtube.com/watch?v=example\nhttps://www.tiktok.com/@test/video/1');
    await page.click('[data-add-urls]');
    assert.equal((await page.evaluate(() => window.calls[1]))[2].length, 2);
    assert.equal(await page.inputValue('[data-urls]'), '');
    await page.click('.production-urls summary');
    await page.click('[data-start]'); assert.equal(await page.locator('[data-start]').isDisabled(), true);
    await page.screenshot({ path: path.join(dir, 'desktop.png') });
    await page.setViewportSize({ width: 390, height: 640 });
    await page.screenshot({ path: path.join(dir, 'mobile.png') });
    assert.equal(await page.evaluate(() => {
      const d = document.querySelector('dialog'); return d.scrollWidth <= d.clientWidth + 1 && d.getBoundingClientRect().bottom <= innerHeight;
    }), true, 'Dialog must fit narrow screen without horizontal overflow');
    await page.locator('.production-row').last().getByText('Mở dự án', { exact: true }).click();
    assert.equal(await page.evaluate(() => window.opened), '5');
    assert.equal(await page.locator('dialog').isVisible(), false); assert.deepEqual(errors, []);
    console.log(`productionQueueUi passed; screenshots: ${dir}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
