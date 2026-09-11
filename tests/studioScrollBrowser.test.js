const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  // Use the complete app shell: isolated status fixtures miss ancestor clipping.
  const html = (await fs.readFile(path.join(root, 'src/index.html'), 'utf8'))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*rel="stylesheet"[^>]*>/gi, '');
  const css = await fs.readFile(path.join(root, 'src/styles.css'), 'utf8');
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    await page.addStyleTag({ content: css });
    await page.evaluate(() => {
      document.getElementById('setup-view').classList.add('hidden');
      for (const id of ['studio-view', 'export-progress', 'auto-story-status']) {
        document.getElementById(id).classList.remove('hidden');
      }
      document.getElementById('auto-story-status').innerHTML = `
        <div class="auto-story-heading">Review status</div>
        <details class="auto-story-script-list"><summary>3 scripts</summary>
        <div class="auto-story-rows">${[1, 2, 3, 4, 5].map(i => `
          <div class="auto-story-row"><div class="auto-story-name"><strong>Script ${i}</strong><small>65s</small></div>
          <span>Needs review</span><div class="auto-story-actions"><button>Review again</button></div></div>`).join('')}</div></details>
        <details class="auto-story-diagnostics"><summary>Details</summary><div>${'<p>Review diagnostics</p>'.repeat(20)}</div></details>`;
    });
    const out = path.join(root, '.tmp', 'studio-scroll');
    await fs.mkdir(out, { recursive: true });
    for (const [width, height] of [[1511, 920], [1920, 1080], [1366, 768], [1000, 650], [480, 800]]) {
      await page.setViewportSize({ width, height });
      for (const expanded of [false, true]) {
        await page.evaluate(expand => {
          document.querySelectorAll('#auto-story-status details').forEach(d => { d.open = expand; });
          document.getElementById('studio-view').scrollTop = 0;
        }, expanded);
        const geometry = await page.evaluate(() => {
          const box = s => document.querySelector(s).getBoundingClientRect().toJSON();
          return { preview: box('.preview-panel'), controls: box('.preview-control-bar'), status: box('#auto-story-status'),
            toolbar: box('.timeline-toolbar'), tracks: box('.timeline-grid'), panel: box('.timeline-panel') };
        });
        assert(geometry.preview.height >= 450, `preview collapsed at ${width}`);
        assert(geometry.controls.bottom <= geometry.preview.bottom + 1, 'preview controls clipped');
        assert(geometry.toolbar.top >= geometry.status.bottom - 1, 'status overlaps toolbar');
        assert(geometry.tracks.top >= geometry.toolbar.bottom - 1, 'toolbar overlaps tracks');
        assert(geometry.panel.bottom >= geometry.tracks.bottom - 1, `tracks clipped by panel: ${width} ${expanded} ${JSON.stringify(geometry)}`);
        await page.locator('.timeline-grid').scrollIntoViewIfNeeded();
        const reachable = await page.locator('.timeline-grid').evaluate(e => {
          const r = e.getBoundingClientRect();
          const studio = document.getElementById('studio-view').getBoundingClientRect();
          return r.bottom <= Math.min(innerHeight, studio.bottom) + 1 && r.top >= 0;
        });
        assert(reachable, `timeline not reachable at ${width}, expanded=${expanded}`);
        if (expanded) await page.screenshot({ path: path.join(out, `${width}-bottom.png`) });
      }
    }
    console.log('Studio full-layout scroll checks passed (5 viewports, collapsed/expanded).');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
