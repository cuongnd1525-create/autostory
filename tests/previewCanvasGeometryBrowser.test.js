const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');
const { buildVideoTitleOverlaySvg } = require('../electron/services/dubbingArtifactService');

(async () => {
  const root = path.resolve(__dirname, '..');
  const source = await fs.readFile(path.join(root, 'src/renderer.js'), 'utf8');
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1511, height: 920 } });
    await page.setContent(`<style>${await fs.readFile(path.join(root, 'src/styles.css'), 'utf8')}</style>
      <div class="preview-panel" style="width:600px;height:400px"><div class="video-stage">
      <div class="video-frame"><video id="preview-player"></video><div class="video-title-overlay"></div></div>
      <div class="preview-control-bar">Preview</div></div></div>`);
    await page.evaluate(() => {
      window.state = { currentProject: { title: "The Son's Heartbreaking Revelation", analysis: { media: { width: 1920, height: 1080 } } } };
      window.el = { previewPlayer: document.querySelector('video'), videoTitleOverlay: document.querySelector('.video-title-overlay'),
        videoCanvasEnabled: { checked: true }, topCaptionEnabled: { checked: true }, topCaptionY: { value: '26' }, topCaptionFontSize: { value: '52' } };
      window.decorated = false;
      window.getPreviewVideoPath = () => 'test.mp4';
      window.isDecoratedPreviewVideo = () => decorated;
      window.getVideoCanvasDimensions = () => ({ width: 1080, height: 1920, label: '9:16' });
      window.wrapPreviewVideoTitle = s => s;
      window.calculatePreviewTitleWrapChars = () => 30;
      window.updateSubtitleMaskPreview = window.positionPreviewSubtitleOverlay = () => {};
      Object.defineProperties(el.previewPlayer, { videoWidth: { value: 1080 }, videoHeight: { value: 1920 } });
    });
    for (const name of ['getPreviewFrameSpace', 'updateVideoDecorationPreview']) {
      const start = source.indexOf(`function ${name}(`);
      await page.addScriptTag({ content: source.slice(start, source.indexOf('\nfunction ', start + 1)) });
    }
    const svg = buildVideoTitleOverlaySvg({ title: 'Title', width: 1080, height: 1920, yPercent: 26 });
    const exportTop = Number(svg.match(/<rect x="[^"]+" y="([^"]+)"/)[1]) / 1920;
    for (const height of [400, 520, 700]) {
      for (const decorated of [false, true]) {
        await page.evaluate(({ height, rendered }) => {
          document.querySelector('.preview-panel').style.height = `${height}px`;
          window.decorated = rendered; updateVideoDecorationPreview();
        }, { height, rendered: decorated });
        const g = await page.evaluate(() => {
          const box = s => document.querySelector(s).getBoundingClientRect().toJSON();
          return { frame: box('.video-frame'), video: box('video'), title: box('.video-title-overlay'), controls: box('.preview-control-bar') };
        });
        assert(Math.abs(g.frame.width / g.frame.height - 9 / 16) < 0.003, 'canvas must not be height-clamped');
        assert(g.frame.bottom <= g.controls.top + 1, 'canvas must fit above playback controls');
        if (!decorated) {
          assert(Math.abs((g.title.top - g.frame.top) / g.frame.height - exportTop) < 0.003, 'title matches export Y');
          assert(Math.abs((g.video.top - g.frame.top + g.video.height / 2) / g.frame.height - 0.5) < 0.003, 'foreground centered in SAME canvas');
        } else {
          assert.equal(g.video.height, g.frame.height);
        }
      }
    }
    console.log('Preview/export canvas geometry passed at 3 panel heights, edit and rendered modes.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
