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
      document.querySelectorAll('[data-ai-provider-settings]').forEach(e => e.classList.toggle('hidden', e.dataset.aiProviderSettings !== 'vertex_ai'));
      document.querySelector('[data-ai-provider-settings="vertex_ai"] details').open = true;
    });
    for (const width of [1400, 800, 480]) {
      await page.setViewportSize({ width, height: 900 });
      const input = page.locator('#vertex-auto-story-review-model');
      await input.fill('my-custom-model');
      await input.scrollIntoViewIfNeeded();
      assert.equal(await input.inputValue(), 'my-custom-model');
      const b = await input.boundingBox();
      assert(b.width > 100 && b.x >= 0 && b.x + b.width <= width);
    }
    console.log('Auto Story custom model settings fit desktop and narrow windows');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
