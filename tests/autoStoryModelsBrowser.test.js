const fs = require('fs/promises');
const path = require('path');
const assert = require('assert/strict');
const { chromium } = require('playwright');
(async () => {
  const root = path.resolve(__dirname, '..');
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const page = await browser.newPage();
    const html = (await fs.readFile(path.join(root, 'src/index.html'), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link[^>]*rel="stylesheet"[^>]*>/gi, '');
    await page.setContent(html);
    await page.addStyleTag({ content: await fs.readFile(path.join(root, 'src/styles.css'), 'utf8') });
    await page.evaluate(() => {
      document.getElementById('settings-modal').classList.remove('hidden');
      const modelIds = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview'];
      for (const selectId of ['vertex-economy-model', 'vertex-analysis-model', 'vertex-quality-model']) {
        const select = document.getElementById(selectId);
        select.innerHTML = modelIds.map((id) => `<option value="${id}">${id}</option>`).join('');
        select.value = 'gemini-3.8-flash';
      }
      const reviewSelect = document.getElementById('vertex-auto-story-review-model');
      for (const id of modelIds) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = id;
        reviewSelect.appendChild(option);
      }
    });
    for (const width of [1400, 800, 480]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => {
        document.querySelectorAll('[data-ai-provider-settings]').forEach(e => e.classList.toggle('hidden', e.dataset.aiProviderSettings !== 'vertex_ai'));
        document.querySelector('[data-ai-provider-settings="vertex_ai"] details').open = true;
      });
      const select = page.locator('#vertex-auto-story-review-model');
      await select.selectOption('gemini-3.8-flash');
      await select.scrollIntoViewIfNeeded();
      assert.equal(await select.inputValue(), 'gemini-3.8-flash');
      const b = await select.boundingBox();
      assert(b.width > 100 && b.x >= 0 && b.x + b.width <= width);

      const economySelect = page.locator('#vertex-economy-model');
      await economySelect.selectOption('gemini-3.5-flash-lite');
      const eb = await economySelect.boundingBox();
      assert(eb.width > 100 && eb.x >= 0 && eb.x + eb.width <= width);

      const refreshBtn = page.locator('#refresh-vertex-models');
      const rb = await refreshBtn.boundingBox();
      assert(rb.x >= 0 && rb.x + rb.width <= width);
    }
    console.log('Auto Story custom model settings fit desktop and narrow windows');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
