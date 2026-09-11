const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const FfmpegService = require("../electron/services/ffmpegService");
const DubbingService = require("../electron/services/dubbingService");
const {
  wrapVideoTitle,
  buildVideoTitleOverlaySvg,
  calculateVideoTitleWrapChars,
  resolveVideoTitleRasterDimensions,
  resolvePartLabelText,
  resolveSourceSubtitleMask
} = require("../electron/services/dubbingService");

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cineviral-decoration-test-"));
  const sourcePath = path.join(root, "source.mp4");
  const titlePath = path.join(root, "title.txt");
  const outputPath = path.join(root, "decorated.mp4");
  const ffmpeg = new FfmpegService({ ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
  try {
    const wrapChars = calculateVideoTitleWrapChars(1080, 52);
    assert.strictEqual(wrapChars, 31);
    const wrappedTitle = wrapVideoTitle("Cops Catch Man After Dumping Chopped Up Body Into River", wrapChars);
    assert.strictEqual(wrappedTitle, "Cops Catch Man After Dumping\nChopped Up Body Into River");
    const titleSvg = buildVideoTitleOverlaySvg({
      title: "This 911 Call Would\nForever Haunt Officers",
      width: 1080,
      height: 1920,
      fontSize: 62,
      yPercent: 22
    });
    assert.ok(titleSvg.includes('font-family="Segoe UI, Arial, sans-serif"'));
    assert.ok(titleSvg.includes('font-weight="800"'));
    assert.ok(titleSvg.includes('<rect '));
    assert.ok(titleSvg.includes('rx="29"'));
    assert.strictEqual((titleSvg.match(/<tspan /g) || []).length, 2);
    const partOnlySvg = buildVideoTitleOverlaySvg({
      width: 1080,
      height: 1920,
      partLabel: {
        text: "Part 2",
        xPercent: 14,
        yPercent: 9,
        fontSize: 38,
        textColor: "#ffffff",
        backgroundColor: "#0b0d11",
        backgroundOpacity: 0.82,
        uppercase: true,
        alignment: "center",
        style: "compact"
      }
    });
    assert.ok(partOnlySvg.includes(">PART 2</text>"));
    assert.ok(partOnlySvg.includes('fill="#0b0d11"'));
    assert.ok(partOnlySvg.includes('fill-opacity="0.82"'));
    assert.strictEqual(resolvePartLabelText({
      analysis: {
        activeVariantId: "variant_02",
        highlightVariants: [{ id: "variant_01", partNumber: 1 }, { id: "variant_02", partNumber: 2 }]
      }
    }, { partLabelEnabled: true, partLabelAutoFromPart: true }), "PART 2");
    assert.strictEqual(resolvePartLabelText({}, {
      partLabelEnabled: true,
      partLabelAutoFromPart: false,
      partLabelText: "Episode finale"
    }), "Episode finale");
    assert.deepStrictEqual(resolveVideoTitleRasterDimensions(1080, 1920), {
      width: 540,
      height: 960,
      scaleX: 0.5,
      scaleY: 0.5
    });
    assert.deepStrictEqual(resolveVideoTitleRasterDimensions(540, 960), {
      width: 540,
      height: 960,
      scaleX: 1,
      scaleY: 1
    });
    const landscapeRaster = resolveVideoTitleRasterDimensions(1440, 1080);
    assert.strictEqual(landscapeRaster.width, 720);
    assert.strictEqual(landscapeRaster.height, 540);
    const migratedMask = resolveSourceSubtitleMask({
      analysis: { media: { width: 1920, height: 1080 } },
      videoDecoration: {
        canvasAspect: "9:16",
        foregroundScalePercent: 104,
        foregroundXPercent: 50,
        foregroundYPercent: 50
      },
      sourceSubtitleMask: {
        enabled: true,
        xPercent: 29.322,
        widthPercent: 43.051,
        heightPercent: 5,
        bottomPercent: 27
      }
    }, true);
    assert.strictEqual(migratedMask.coordinateSpace, "source_v2");
    assert.ok(migratedMask.bottomPercent <= 0.01);
    assert.ok(migratedMask.heightPercent >= 15 && migratedMask.heightPercent <= 15.3);
    await fs.writeFile(titlePath, wrappedTitle, "utf8");
    await ffmpeg.run("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "testsrc2=size=320x180:rate=30:duration=1",
      "-f", "lavfi",
      "-i", "sine=frequency=440:sample_rate=44100:duration=1",
      "-shortest",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-c:a", "aac",
      sourcePath
    ], { captureStdout: false });
    await ffmpeg.applyVideoDecoration({
      inputPath: sourcePath,
      outputPath,
      titleTextPath: titlePath,
      blurBackgroundEnabled: true,
      blurStrength: 18,
      topCaptionEnabled: true,
      topCaptionFontSize: 52,
      topCaptionYPercent: 32,
      width: 400,
      height: 300,
      preset: "ultrafast",
      crf: 30
    });
    const output = await ffmpeg.probeVideo(outputPath);
    assert.strictEqual(output.width, 400);
    assert.strictEqual(output.height, 300);
    assert.strictEqual(output.hasAudio, true);
    assert.ok(Math.abs(output.duration - 1) <= 0.15, `Expected 1s output, received ${output.duration}s`);

    const positionedOutputPath = path.join(root, "decorated-positioned.mp4");
    await ffmpeg.applyVideoDecoration({
      inputPath: sourcePath,
      outputPath: positionedOutputPath,
      blurBackgroundEnabled: true,
      blurStrength: 18,
      foregroundScalePercent: 72,
      foregroundXPercent: 68,
      foregroundYPercent: 35,
      width: 400,
      height: 300,
      preset: "ultrafast",
      crf: 30
    });
    const positionedOutput = await ffmpeg.probeVideo(positionedOutputPath);
    assert.strictEqual(positionedOutput.width, 400);
    assert.strictEqual(positionedOutput.height, 300);
    assert.strictEqual(positionedOutput.hasAudio, true);

    const maskFfmpeg = new FfmpegService({ ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
    let maskArgs = [];
    maskFfmpeg.run = async (_command, args) => {
      maskArgs = args;
    };
    await maskFfmpeg.maskSubtitleArea({
      inputPath: sourcePath,
      outputPath: path.join(root, "masked.mp4"),
      mode: "blur",
      xPercent: 12,
      widthPercent: 64,
      heightPercent: 14,
      bottomPercent: 7,
      blurStrength: 20
    });
    const maskFilter = maskArgs[maskArgs.indexOf("-filter_complex") + 1];
    assert.ok(maskFilter.includes("crop=iw*0.6400:ih*0.1400:iw*0.1200"));
    assert.ok(maskFilter.includes("overlay=main_w*0.1200"));

    await maskFfmpeg.maskSubtitleArea({
      inputPath: sourcePath,
      outputPath: path.join(root, "dark-mask.mp4"),
      mode: "dark",
      xPercent: 20,
      widthPercent: 50,
      heightPercent: 10,
      bottomPercent: 4
    });
    const darkFilter = maskArgs[maskArgs.indexOf("-vf") + 1];
    assert.ok(darkFilter.includes("drawbox=x=iw*0.2000"));
    assert.ok(darkFilter.includes("w=iw*0.5000"));

    const renderedMaskPath = path.join(root, "rendered-mask.mp4");
    await ffmpeg.maskSubtitleArea({
      inputPath: sourcePath,
      outputPath: renderedMaskPath,
      mode: "blur",
      xPercent: 10,
      widthPercent: 70,
      heightPercent: 15,
      bottomPercent: 5,
      blurStrength: 12
    });
    const renderedMask = await ffmpeg.probeVideo(renderedMaskPath);
    assert.strictEqual(renderedMask.width, 320);
    assert.strictEqual(renderedMask.height, 180);
    assert.ok(Math.abs(renderedMask.duration - 1) <= 0.15);

    const sharedPipelineOutput = path.join(root, "shared-pipeline-mask.mp4");
    const dubbingService = new DubbingService({
      writeText: (filePath, content) => fs.writeFile(filePath, content, "utf8")
    });
    await dubbingService.applyProjectVideoDecoration({
      ffmpeg,
      project: {
        sourceSubtitleMask: {
          enabled: true,
          mode: "blur",
          xPercent: 15,
          widthPercent: 60,
          heightPercent: 12,
          bottomPercent: 8,
          strength: 14
        },
        videoDecoration: {
          canvasEnabled: false,
          blurBackgroundEnabled: false,
          topCaptionEnabled: false
        }
      },
      paths: { tempDir: root },
      inputPath: sourcePath,
      outputPath: sharedPipelineOutput,
      name: "highlight-draft-test",
      draft: true
    });
    const sharedPipelineMask = await ffmpeg.probeVideo(sharedPipelineOutput);
    assert.strictEqual(sharedPipelineMask.width, 320);
    assert.strictEqual(sharedPipelineMask.height, 180);
    assert.ok(Math.abs(sharedPipelineMask.duration - 1) <= 0.15);

    const decoratedPipelineOutput = path.join(root, "decorated-pipeline-mask.mp4");
    await dubbingService.applyProjectVideoDecoration({
      ffmpeg,
      project: {
        sourceSubtitleMask: {
          enabled: true,
          mode: "blur",
          xPercent: 20,
          widthPercent: 55,
          heightPercent: 10,
          bottomPercent: 2,
          strength: 12
        },
        videoDecoration: {
          canvasEnabled: true,
          canvasAspect: "custom",
          customWidth: 400,
          customHeight: 320,
          blurBackgroundEnabled: true,
          blurStrength: 12,
          topCaptionEnabled: false
        }
      },
      paths: { tempDir: root },
      inputPath: sourcePath,
      outputPath: decoratedPipelineOutput,
      name: "highlight-decorated-mask-test",
      draft: false
    });
    const decoratedPipelineMask = await ffmpeg.probeVideo(decoratedPipelineOutput);
    assert.strictEqual(decoratedPipelineMask.width, 400);
    assert.strictEqual(decoratedPipelineMask.height, 320);
    assert.ok(Math.abs(decoratedPipelineMask.duration - 1) <= 0.15);
    console.log("ffmpeg video decoration tests passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
