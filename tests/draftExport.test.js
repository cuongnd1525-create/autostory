const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  buildExportFilePath,
  publishDraftVideo,
  resolveEffectiveVideoEditProject,
  resolveSuggestedTopCaption,
  resolveVariantFileMetadata,
  resolveVideoCanvasDimensions,
  getHighlightNarrationSourceVolume
} = require("../electron/services/dubbingService");

assert.strictEqual(getHighlightNarrationSourceVolume({ mixer: { sourceVolume: 20 } }), 0);
assert.strictEqual(getHighlightNarrationSourceVolume({
  mixer: { sourceVolume: 20, narrationSourceAudioOverride: true }
}), 0.2);

// Export must never inherit preview translation settings, including legacy saved projects.
const Dubbing = require("../electron/services/dubbingService");
const finalRender = Dubbing.prototype.renderHighlightCutProject.toString();
assert(!finalRender.includes("burnSubtitles"), "final Highlight export must not burn review subtitles");
assert(!finalRender.includes("project.showSubtitles"), "preview flag cannot enable export captions");
assert(!finalRender.includes("segment.translatedText"));
assert(finalRender.includes('subtitlePath: "not_requested"'));
assert(Dubbing.prototype.renderHighlightFastDraft.toString().includes("ffmpeg.burnSubtitles"), "draft retains Vietnamese review subtitles");
assert(Dubbing.prototype.renderAllHighlightCutVariants.toString().includes("renderHighlightCutProject"), "batch export follows the same clean render path");

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cineviral-draft-export-test-"));
  const sourcePath = path.join(root, "internal-draft.mp4");
  const exportRoot = path.join(root, "exports");
  const project = {
    id: "demo-project-1234",
    title: "Demo Project",
    exportRoot,
    exportLayout: "flat"
  };
  try {
    await fs.writeFile(sourcePath, "draft-video");
    const expectedPath = buildExportFilePath({
      project,
      mode: "storytime-draft",
      extension: ".mp4"
    });
    assert.strictEqual(path.dirname(expectedPath), exportRoot);
    assert.ok(path.basename(expectedPath).includes("storytime-draft"));

    const publishedPath = await publishDraftVideo({
      project,
      sourcePath,
      mode: "storytime"
    });
    assert.strictEqual(path.dirname(publishedPath), exportRoot);
    assert.ok(path.basename(publishedPath).includes("storytime-draft"));
    assert.strictEqual(await fs.readFile(publishedPath, "utf8"), "draft-video");

    assert.deepStrictEqual(resolveVideoCanvasDimensions({ canvasAspect: "9:16" }), { width: 1080, height: 1920 });
    assert.deepStrictEqual(resolveVideoCanvasDimensions({ canvasAspect: "3:4" }), { width: 1080, height: 1440 });
    assert.deepStrictEqual(resolveVideoCanvasDimensions({ canvasAspect: "4:3" }), { width: 1440, height: 1080 });
    assert.deepStrictEqual(resolveVideoCanvasDimensions({ canvasAspect: "4:3" }, true), { width: 720, height: 540 });
    assert.deepStrictEqual(
      resolveVideoCanvasDimensions({ canvasAspect: "custom", customWidth: 1001, customHeight: 777 }),
      { width: 1002, height: 778 }
    );

    const variantProject = {
      title: "Project folder title",
      analysis: {
        activeVariantId: "variant_02",
        sharedTopBannerText: "One verified mystery connects every cut",
        highlightVariants: [
          { id: "variant_01", title: "Variant one" },
          { id: "variant_02", title: "Variant two", topHeader: "Gemini header two" }
        ]
      }
    };
    assert.strictEqual(resolveSuggestedTopCaption(variantProject), "One verified mystery connects every cut");
    variantProject.analysis.activeVariantId = "variant_01";
    assert.strictEqual(resolveSuggestedTopCaption(variantProject), "One verified mystery connects every cut");
    delete variantProject.analysis.sharedTopBannerText;
    assert.strictEqual(resolveSuggestedTopCaption(variantProject), "Variant one");
    variantProject.analysis.activeVariantId = "variant_02";
    assert.strictEqual(resolveSuggestedTopCaption(variantProject), "Variant one");
    assert.strictEqual(resolveSuggestedTopCaption({
      title: "Fallback project title",
      analysis: {
        scriptTitle: "Gemini story title",
        topHeader: "Gemini story header"
      }
    }), "Gemini story header");
    assert.deepStrictEqual(resolveVariantFileMetadata({
      analysis: {
        highlightVariants: [
          { id: "variant_01" },
          { id: "variant_02" },
          { id: "variant_03" }
        ]
      }
    }, {
      id: "variant_03",
      viralPreflight: { score: 48.6 }
    }), {
      variantNumber: 3,
      score: 49,
      variantTag: "variant-03",
      scoreTag: "score-49",
      fileTag: "variant-03-score-49"
    });
    assert.strictEqual(resolveVariantFileMetadata({}, { id: "variant_01" }).fileTag, "variant-01-score-na");
    const effectiveVariantProject = resolveEffectiveVideoEditProject({
      mode: "highlight_cut",
      mixer: { sourceVolume: 20, voiceVolume: 100 },
      videoDecoration: {
        canvasAspect: "9:16",
        topCaptionText: "Shared title",
        partLabelEnabled: true,
        partLabelAutoFromPart: true,
        partLabelXPercent: 12
      },
      sourceSubtitleMask: { enabled: false },
      analysis: {
        activeVariantId: "variant_02",
        highlightVariants: [{
          id: "variant_02",
          videoEditOverrides: {
            mixer: { sourceVolume: 0 },
            videoDecoration: {
              canvasAspect: "4:3",
              foregroundScalePercent: 120,
              topCaptionText: "Must not override",
              partLabelXPercent: 76,
              partLabelStyle: "bold"
            },
            sourceSubtitleMask: { enabled: true }
          }
        }]
      }
    });
    assert.strictEqual(effectiveVariantProject.mixer.sourceVolume, 0);
    assert.strictEqual(effectiveVariantProject.videoDecoration.canvasAspect, "4:3");
    assert.strictEqual(effectiveVariantProject.videoDecoration.foregroundScalePercent, 120);
    assert.strictEqual(effectiveVariantProject.videoDecoration.topCaptionText, "Shared title");
    assert.strictEqual(effectiveVariantProject.videoDecoration.partLabelEnabled, true);
    assert.strictEqual(effectiveVariantProject.videoDecoration.partLabelXPercent, 76);
    assert.strictEqual(effectiveVariantProject.videoDecoration.partLabelStyle, "bold");
    assert.strictEqual(effectiveVariantProject.sourceSubtitleMask.enabled, true);
    console.log("draft export tests passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
