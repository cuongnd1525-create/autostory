const assert = require("assert/strict");
const fs = require("fs/promises");
const path = require("path");
const { chromium } = require("playwright");
(async () => {
  const root = path.resolve(__dirname, "..");
  const source = await fs.readFile(path.join(root, "src/renderer.js"), "utf8");
  const fn = name => {
    const start = source.indexOf(`function ${name}(`);
    const next = source.indexOf("\nfunction ", start + 1);
    return source.slice(start, next);
  };
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await page.setContent(`<style>${await fs.readFile(path.join(root, "src/styles.css"), "utf8")}</style>
      <main style="padding:24px"><div style="display:flex;justify-content:center"><div class="video-frame"><video id="preview-player"></video></div></div>
      <div id="auto-story-status"></div><button id="resume-auto-story"></button></main>`);
    if (process.env.PREVIEW_TEST_POSTER) {
      const poster = await fs.readFile(process.env.PREVIEW_TEST_POSTER);
      await page.locator("#preview-player").evaluate((v, data) => { v.poster = data; }, `data:image/png;base64,${poster.toString("base64")}`);
    }
    await page.evaluate(() => {
      window.$ = id => document.getElementById(id);
      window.escapeHtml = s => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
      window.fmt = (n, digits) => Number(n).toFixed(digits);
      window.getSegmentTimelineDuration = s => s.endSec - s.startSec;
      window.getHighlightVariants = p => p.analysis.highlightVariants;
      window.getActiveHighlightVariant = p => p.analysis.highlightVariants.find(v => v.id === p.analysis.activeVariantId);
      window.getPreviewSubtitleTextAtTime = () => "";
      window.getPreviewVideoPath = () => "";
      window.updateSubtitleMaskPreview = window.positionPreviewSubtitleOverlay = () => {};
      window.switchHighlightVariant = async id => { state.currentProject.analysis.activeVariantId = id; state.revisionPreviewPath = ""; };
      window.renderPreviewSource = () => {};
      window.resumeAutoStoryProject = id => { window.retried = id; };
      window.addLog = e => { throw new Error(e); };
      window.el = { previewPlayer: $("preview-player") };
      Object.defineProperties(el.previewPlayer, { videoWidth: { value: 540 }, videoHeight: { value: 960 } });
      window.state = { busy: false, videoEditPreviewMode: true, revisionPreviewPath: "old.mp4", currentProject: {
        id: "test", mode: "highlight_cut", analysisWorkflow: "vertex_auto_story", autoStoryConfig: { outputCount: 3 },
        autoStoryState: { phase: "complete", audits: [{ scriptId: 1, applied: true, complete: true, originalDraft: "old.mp4" },
          { scriptId: 2, complete: true, verdict: "PASS" }] }, analysis: { activeVariantId: "v1", highlightVariants: [1, 2, 3].map(id => ({
          id: `v${id}`, scriptId: id, title: `A complete story with a long title ${id}`, segments: [{ startSec: 0, endSec: 70 }],
          artifacts: { fastDraftVideoPath: `draft${id}.mp4`, fastDraftBaseVideoPath: `base${id}.mp4` }
        })) }
      } };
    });
    for (const name of ["getPreviewVideoPath", "isDecoratedPreviewVideo", "getPreviewFrameSpace", "updateVideoDecorationPreview", "renderAutoStoryStatus"]) await page.addScriptTag({ content: fn(name) });
    await page.evaluate(() => { updateVideoDecorationPreview(); renderAutoStoryStatus(); });
    const boxes = await page.evaluate(() => ({ frame: document.querySelector(".video-frame").getBoundingClientRect().toJSON(), video: el.previewPlayer.getBoundingClientRect().toJSON() }));
    assert.equal(boxes.video.width, boxes.frame.width);
    assert.equal(boxes.video.height, boxes.frame.height);
    assert.equal(await page.locator(".auto-story-script-list").getAttribute("open"), null);
    await page.locator(".auto-story-script-list > summary").click();
    assert.equal(await page.locator(".auto-story-row").count(), 3);
    await page.getByRole("button", { name: "Thử lại kiểm tra bản cuối", exact: true }).click();
    assert.equal(await page.evaluate(() => window.retried), 1);
    await page.getByRole("button", { name: "Xem bản hiện tại", exact: true }).nth(1).click();
    assert.deepEqual(await page.evaluate(() => [state.videoEditPreviewMode, getPreviewVideoPath(), isDecoratedPreviewVideo()]), [false, "draft2.mp4", true]);
    await page.evaluate(() => { state.videoEditPreviewMode = true; state.revisionPreviewPath = ""; });
    assert.deepEqual(await page.evaluate(() => [getPreviewVideoPath(), isDecoratedPreviewVideo()]), ["base2.mp4", false]);
    await page.evaluate(() => { state.revisionPreviewPath = "old.mp4"; });
    assert.equal(await page.evaluate(() => isDecoratedPreviewVideo()), true);
    const out = path.join(root, ".tmp", "preview-ui-check"); await fs.mkdir(out, { recursive: true });
    for (const width of [1400, 800, 480]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => { updateVideoDecorationPreview(); renderAutoStoryStatus(); });
      const overflow = await page.evaluate(() => [...document.querySelectorAll(".auto-story-row button")].some(b => b.getBoundingClientRect().right > document.documentElement.clientWidth));
      assert.equal(overflow, false, `buttons fit ${width}px`);
      await page.screenshot({ path: path.join(out, `${width}.png`), fullPage: true });
    }
    console.log("Preview browser tests passed: revision/edit modes, dimensions, script actions, responsive screenshots");
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
