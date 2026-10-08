const fs = require("fs/promises");
const path = require("path");

function safeText(value, fallback = "") {
  return String(value || fallback).replace(/\s+/g, " ").trim();
}

function sanitizeFilePart(value = "") {
  return safeText(value, "variant")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "variant";
}

function wrapVideoTitle(value, maxChars = 36) {
  const rawText = String(value || "").trim();
  if (!rawText) return "";
  const rawLines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const finalLines = [];
  for (const rawLine of rawLines) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && candidate.length > maxChars) {
        finalLines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) finalLines.push(current);
  }
  return finalLines.slice(0, 3).join("\n");
}

function wrapTikTokHookTitle(value) {
  const words = String(value || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return "";
  if (words.length === 1) return words[0].toUpperCase();
  let bestIndex = 1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 1; index < words.length; index += 1) {
    const left = words.slice(0, index).join(" ");
    const right = words.slice(index).join(" ");
    const longest = Math.max(left.length, right.length);
    const imbalance = Math.abs(left.length - right.length);
    const score = longest * 2 + imbalance;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return [
    words.slice(0, bestIndex).join(" "),
    words.slice(bestIndex).join(" ")
  ].filter(Boolean).join("\n").toUpperCase();
}

function escapeSvgText(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeHexColor(value, fallback) {
  const normalized = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized : fallback;
}

function resolvePartLabelText(project = {}, decoration = project.videoDecoration || {}) {
  if (!decoration.partLabelEnabled) return "";
  if (decoration.partLabelAutoFromPart !== false) {
    const variants = Array.isArray(project.analysis?.highlightVariants)
      ? project.analysis.highlightVariants
      : [];
    const active = variants.find((variant) => variant.id === project.analysis?.activeVariantId)
      || variants[0]
      || {};
    const matchedIndex = variants.findIndex((variant) => variant.id === active.id);
    const partNumber = Number(active.partNumber || active.part_number)
      || (matchedIndex >= 0 ? matchedIndex + 1 : 0);
    if (partNumber > 0) return `PART ${partNumber}`;
    const badge = safeText(active.partBadge || active.part_badge || "");
    if (badge) return badge;
  }
  return safeText(decoration.partLabelText || "").slice(0, 48);
}

function buildVideoTitleOverlaySvg({
  title = "",
  width = 1080,
  height = 1920,
  fontSize = 52,
  yPercent = 8,
  titleStyle = "default",
  titleBackgroundColor = null,
  titleTextColor = null,
  cameraLabel = null,
  partLabel = null
} = {}) {
  const canvasWidth = Math.max(180, Math.round(Number(width) || 1080));
  const canvasHeight = Math.max(180, Math.round(Number(height) || 1920));
  const baseScaledFontSize = Math.max(16, Math.round((Number(fontSize) || 52) * (canvasWidth / 1080)));
  const lines = String(title || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 3);
  const isTikTokHook = titleStyle === "tiktok_hook";
  const inset = Math.max(8, Math.round(canvasWidth * (isTikTokHook ? 0.07 : 0.09)));
  const boxWidth = canvasWidth - inset * 2;
  const isViralGreen = titleStyle === "viral_green" || partLabel?.style === "viral_green";
  const isUppercase = isTikTokHook || isViralGreen || (lines.length > 0 && lines.every((l) => l === l.toUpperCase()));
  const glyphFactor = isTikTokHook ? 0.62 : (isUppercase ? 0.70 : 0.54);
  const maxAvailableTextWidth = boxWidth - (isTikTokHook ? 18 : 36);
  const maxLineWidthChars = Math.max(...lines.map((l) => l.length), 0);
  let scaledFontSize = baseScaledFontSize;
  if (maxLineWidthChars > 0 && maxLineWidthChars * baseScaledFontSize * glyphFactor > maxAvailableTextWidth) {
    scaledFontSize = Math.max(16, Math.floor(maxAvailableTextWidth / (maxLineWidthChars * glyphFactor)));
  }
  const paddingY = Math.max(6, Math.round(scaledFontSize * (isTikTokHook ? 0.16 : 0.55)));
  const lineHeight = Math.round(scaledFontSize * (isTikTokHook ? 1.02 : 1.12));
  const boxHeight = lines.length * lineHeight + paddingY * 2;
  const top = Math.round(canvasHeight * Math.max(3, Math.min(75, Number(yPercent) || (isTikTokHook ? 11 : 8))) / 100);
  const radius = Math.max(4, Math.round(scaledFontSize * 0.46));
  const firstBaseline = top + paddingY + Math.round(scaledFontSize * (isTikTokHook ? 0.88 : 0.84));
  const resolvedTitleBg = safeHexColor(titleBackgroundColor, isViralGreen ? "#00A63E" : "#ffffff");
  const resolvedTitleText = safeHexColor(titleTextColor, isViralGreen ? "#ffffff" : "#0b0d11");
  const textSpans = lines.map((line, index) => (
    `<tspan x="${canvasWidth / 2}" y="${firstBaseline + index * lineHeight}"${isTikTokHook && index === 1 ? ' fill="#FFE600"' : ""}>${escapeSvgText(line)}</tspan>`
  )).join("");
  const titleMarkup = lines.length ? (isTikTokHook ? `
  <text x="${canvasWidth / 2}" text-anchor="middle" font-family="Arial Black, Segoe UI, Arial, sans-serif" font-size="${scaledFontSize}" font-weight="900" fill="#FFFFFF" stroke="#000000" stroke-width="${Math.max(4, Math.round(scaledFontSize * 0.11))}" stroke-linejoin="round" paint-order="stroke fill" filter="url(#shadow)">${textSpans}</text>`
  : `
  <rect x="${inset}" y="${top}" width="${boxWidth}" height="${boxHeight}" rx="${radius}" ry="${radius}" fill="${resolvedTitleBg}" fill-opacity="0.96" filter="url(#shadow)"/>
  <text x="${canvasWidth / 2}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="${scaledFontSize}" font-weight="800" fill="${resolvedTitleText}">${textSpans}</text>`) : "";
  const rawPartText = safeText(partLabel?.text || "").slice(0, 48);
  const partText = partLabel?.uppercase === false ? rawPartText : rawPartText.toUpperCase();
  const partFontSize = Math.max(12, Math.round((Number(partLabel?.fontSize) || 38) * (canvasWidth / 1080)));
  const partPaddingX = Math.max(8, Math.round(partFontSize * 0.62));
  const partPaddingY = Math.max(5, Math.round(partFontSize * 0.35));
  const estimatedPartWidth = Math.round(partText.length * partFontSize * 0.62) + partPaddingX * 2;
  const partBoxWidth = Math.max(partFontSize * 3, Math.min(canvasWidth * 0.82, estimatedPartWidth));
  const partBoxHeight = partFontSize + partPaddingY * 2;
  const partCenterX = canvasWidth * Math.max(5, Math.min(95, Number(partLabel?.xPercent) || 12)) / 100;
  const partCenterY = canvasHeight * Math.max(3, Math.min(97, Number(partLabel?.yPercent) || 8)) / 100;
  const partLeft = Math.max(0, Math.min(canvasWidth - partBoxWidth, partCenterX - partBoxWidth / 2));
  const partTop = Math.max(0, Math.min(canvasHeight - partBoxHeight, partCenterY - partBoxHeight / 2));
  const isPartViralGreen = partLabel?.style === "viral_green";
  const partTextColor = safeHexColor(partLabel?.textColor, "#ffffff");
  const partBackgroundColor = safeHexColor(partLabel?.backgroundColor, isPartViralGreen ? "#00A63E" : "#0b0d11");
  const partOpacity = Math.max(0, Math.min(1, Number(partLabel?.backgroundOpacity ?? 0.82)));
  const partStyle = safeText(partLabel?.style || "compact");
  const partAlignment = ["left", "right"].includes(partLabel?.alignment) ? partLabel.alignment : "center";
  const textAnchor = partAlignment === "left" ? "start" : partAlignment === "right" ? "end" : "middle";
  const partTextX = partAlignment === "left"
    ? partLeft + partPaddingX
    : partAlignment === "right"
      ? partLeft + partBoxWidth - partPaddingX
      : partLeft + partBoxWidth / 2;
  const partBackground = partStyle === "no_background"
    ? ""
    : `<rect x="${partLeft}" y="${partTop}" width="${partBoxWidth}" height="${partBoxHeight}" rx="${partStyle === "bold" ? 4 : Math.max(4, Math.round(partFontSize * 0.28))}" fill="${partBackgroundColor}" fill-opacity="${partOpacity.toFixed(2)}"/>`;
  const partMarkup = partText ? `
  ${partBackground}
  <text x="${partTextX}" y="${partTop + partPaddingY + Math.round(partFontSize * 0.82)}" text-anchor="${textAnchor}" font-family="Segoe UI, Arial, sans-serif" font-size="${partFontSize}" font-weight="800" fill="${partTextColor}">${escapeSvgText(partText)}</text>` : "";

  const rawCamText = safeText(cameraLabel?.text || "").slice(0, 24);
  let cameraMarkup = "";
  if (rawCamText) {
    const camFontSize = Math.max(16, Math.round((Number(cameraLabel?.fontSize) || 36) * (canvasWidth / 1080)));
    const camColor = safeHexColor(cameraLabel?.textColor, "#ff2222");
    const camXPercent = Number(cameraLabel?.xPercent ?? 12);
    const camYPercent = Number(cameraLabel?.yPercent ?? 28);
    const camX = Math.round(canvasWidth * Math.max(2, Math.min(95, camXPercent)) / 100);
    const camY = Math.round(canvasHeight * Math.max(2, Math.min(95, camYPercent)) / 100);
    cameraMarkup = `
  <text x="${camX}" y="${camY}" font-family="Segoe UI, Arial, sans-serif" font-size="${camFontSize}" font-weight="900" fill="${camColor}" stroke="#000000" stroke-width="${Math.max(2, Math.round(camFontSize * 0.12))}" stroke-linejoin="round" paint-order="stroke fill">${escapeSvgText(rawCamText)}</text>`;
  }

  if (!titleMarkup && !partMarkup && !cameraMarkup) return "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">
  <defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="${Math.max(2, Math.round(scaledFontSize * 0.12))}" stdDeviation="${Math.max(2, Math.round(scaledFontSize * 0.16))}" flood-color="#000000" flood-opacity="0.22"/></filter></defs>
  ${titleMarkup}${partMarkup}${cameraMarkup}
</svg>`;
}

function calculateVideoTitleWrapChars(width = 1080, referenceFontSize = 52, isUppercase = false) {
  const targetWidth = Math.max(320, Number(width) || 1080);
  const fontSize = Math.max(16, (Number(referenceFontSize) || 52) * (targetWidth / 1080));
  const boxWidth = targetWidth * 0.82;
  const horizontalPadding = fontSize * 0.65;
  const estimatedGlyphWidth = fontSize * (isUppercase ? 0.68 : 0.5);
  return Math.max(10, Math.min(42, Math.floor(
    (boxWidth - (horizontalPadding * 2)) / Math.max(1, estimatedGlyphWidth)
  )));
}

function resolveVideoTitleRasterDimensions(width = 1080, height = 1920) {
  const targetWidth = Math.max(180, Math.round(Number(width) || 1080));
  const targetHeight = Math.max(180, Math.round(Number(height) || 1920));
  const divisor = Math.max(1, Math.ceil(Math.max(targetWidth / 1080, targetHeight / 960)));
  return {
    width: Math.max(180, Math.round(targetWidth / divisor)),
    height: Math.max(180, Math.round(targetHeight / divisor)),
    scaleX: Math.max(180, Math.round(targetWidth / divisor)) / targetWidth,
    scaleY: Math.max(180, Math.round(targetHeight / divisor)) / targetHeight
  };
}

function normalizeCanvasDimension(value, fallback) {
  const bounded = Math.max(320, Math.min(3840, Number(value) || fallback));
  return Math.max(320, Math.round(bounded / 2) * 2);
}

function resolveVideoCanvasDimensions(decoration = {}, draft = false) {
  const aspect = safeText(decoration.canvasAspect || "9:16");
  let width = 1080;
  let height = 1920;
  if (aspect === "4:3") {
    width = 1440;
    height = 1080;
  } else if (aspect === "3:4") {
    width = 1080;
    height = 1440;
  } else if (aspect === "custom") {
    width = normalizeCanvasDimension(decoration.customWidth, 1080);
    height = normalizeCanvasDimension(decoration.customHeight, 1920);
  }
  if (!draft) return { width, height };
  const maxWidth = width > height ? 720 : 540;
  const scale = Math.min(1, maxWidth / width, 960 / height);
  return {
    width: Math.max(180, Math.round((width * scale) / 2) * 2),
    height: Math.max(180, Math.round((height * scale) / 2) * 2)
  };
}

function resolveSourceSubtitleMask(project = {}, draft = false) {
  const mask = project.sourceSubtitleMask || {};
  if (!mask.enabled || mask.coordinateSpace === "source_v2") return mask;
  const decoration = project.videoDecoration || {};
  const canvas = resolveVideoCanvasDimensions(decoration, draft);
  const media = project.analysis?.media || {};
  const sourceWidth = Math.max(1, Number(media.width) || 1080);
  const sourceHeight = Math.max(1, Number(media.height) || 1920);
  const sourceRatio = sourceWidth / sourceHeight;
  const canvasRatio = canvas.width / canvas.height;
  const baseWidth = sourceRatio > canvasRatio ? canvas.width : canvas.height * sourceRatio;
  const baseHeight = sourceRatio > canvasRatio ? canvas.width / sourceRatio : canvas.height;
  const scale = Math.max(0.5, Math.min(1.6, Number(decoration.foregroundScalePercent ?? 100) / 100));
  const foregroundWidth = baseWidth * scale;
  const foregroundHeight = baseHeight * scale;
  const foregroundLeft = (canvas.width * Math.max(0, Math.min(100, Number(decoration.foregroundXPercent ?? 50))) / 100) - foregroundWidth / 2;
  const foregroundTop = (canvas.height * Math.max(0, Math.min(100, Number(decoration.foregroundYPercent ?? 50))) / 100) - foregroundHeight / 2;
  const legacyHeight = Math.max(4, Math.min(45, Number(mask.heightPercent ?? 16)));
  const legacyTop = 100 - Math.max(0, Number(mask.bottomPercent ?? 6)) - legacyHeight;
  const widthPercent = Math.max(4, Math.min(100, Number(mask.widthPercent ?? 100) * canvas.width / foregroundWidth));
  const heightPercent = Math.max(4, Math.min(45, legacyHeight * canvas.height / foregroundHeight));
  const xPercent = Math.max(0, Math.min(100 - widthPercent, ((Number(mask.xPercent ?? 0) * canvas.width / 100) - foregroundLeft) / foregroundWidth * 100));
  const topPercent = Math.max(0, Math.min(100 - heightPercent, ((legacyTop * canvas.height / 100) - foregroundTop) / foregroundHeight * 100));
  return {
    ...mask,
    coordinateSpace: "source_v2",
    xPercent: Number(xPercent.toFixed(3)),
    widthPercent: Number(widthPercent.toFixed(3)),
    heightPercent: Number(heightPercent.toFixed(3)),
    bottomPercent: Number((100 - topPercent - heightPercent).toFixed(3))
  };
}

function resolveSuggestedTopCaption(project = {}) {
  const analysis = project.analysis || {};
  const variants = Array.isArray(analysis.highlightVariants) ? analysis.highlightVariants : [];
  const firstVariant = variants[0] || {};
  const activeVariant = variants.find(variant => variant.id === analysis.activeVariantId) || firstVariant;
  // AutoStory variants may represent DIFFERENT story scopes. Never inherit another
  // variant's viral headline just because it was imported first.
  if (project.analysisWorkflow === "vertex_auto_story" || project.autoStoryContractVersion >= 3) {
    const own = safeText(activeVariant.topHeader || activeVariant.title || analysis.scriptTitle);
    if (own) return own.slice(0, 180);
  }
  return safeText(
    analysis.hookHeadline
    || analysis.sharedTopBannerText
    || analysis.shared_top_banner_text
    || analysis.topHeader
    || analysis.top_banner_text
    || analysis.top_header
    || analysis.scriptTitle
    || analysis.title
    || firstVariant.hookHeadline
    || firstVariant.sharedTopBannerText
    || firstVariant.topHeader
    || firstVariant.top_banner_text
    || firstVariant.top_header
    || firstVariant.title
    || project.title
    || ""
  ).slice(0, 180);
}

function resolveEffectiveVideoEditProject(project = {}) {
  const analysis = project.analysis || {};
  const variants = Array.isArray(analysis.highlightVariants) ? analysis.highlightVariants : [];
  const activeVariant = variants.find((variant) => variant.id === analysis.activeVariantId) || variants[0] || {};
  const overrides = project.mode === "highlight_cut" ? (activeVariant.videoEditOverrides || {}) : {};
  const globalDecoration = project.videoDecoration || {};
  return {
    ...project,
    mixer: { ...(project.mixer || {}), ...(overrides.mixer || {}) },
    videoDecoration: {
      ...globalDecoration,
      ...(overrides.videoDecoration || {}),
      topCaptionEnabled: globalDecoration.topCaptionEnabled,
      topCaptionText: globalDecoration.topCaptionText,
      topCaptionAutoFromScript: globalDecoration.topCaptionAutoFromScript,
      topCaptionFontSize: globalDecoration.topCaptionFontSize,
      topCaptionYPercent: globalDecoration.topCaptionYPercent
    },
    sourceSubtitleMask: { ...(project.sourceSubtitleMask || {}), ...(overrides.sourceSubtitleMask || {}) },
    subtitleStyle: overrides.subtitleStyle ?? project.subtitleStyle,
    showSubtitles: overrides.showSubtitles ?? project.showSubtitles,
    transitionStyle: overrides.transitionStyle ?? project.transitionStyle,
    visualRemixEnabled: overrides.visualRemixEnabled ?? project.visualRemixEnabled,
    autoFitVoice: overrides.autoFitVoice ?? project.autoFitVoice
  };
}

function resolveVariantFileMetadata(project = {}, variant = {}) {
  const variants = Array.isArray(project.analysis?.highlightVariants)
    ? project.analysis.highlightVariants
    : [];
  const matchedIndex = variants.findIndex((item) => item?.id && item.id === variant?.id);
  const storedIndex = Number(variant?.index);
  const zeroBasedIndex = matchedIndex >= 0
    ? matchedIndex
    : (Number.isFinite(storedIndex) && storedIndex >= 0 ? storedIndex : 0);
  const variantNumber = zeroBasedIndex + 1;
  const rawScore = Number(variant?.viralPreflight?.score);
  const score = Number.isFinite(rawScore)
    ? Math.max(0, Math.min(100, Math.round(rawScore)))
    : null;
  const variantTag = `variant-${String(variantNumber).padStart(2, "0")}`;
  const scoreTag = score === null ? "score-na" : `score-${score}`;
  return {
    variantNumber,
    score,
    variantTag,
    scoreTag,
    fileTag: `${variantTag}-${scoreTag}`
  };
}

async function pruneDraftArtifacts(outputDir, filePrefix, keepRuns = 3) {
  const entries = await fs.readdir(outputDir, { withFileTypes: true }).catch(() => []);
  const groups = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(filePrefix)) continue;
    const match = /fast-draft-(\d{10,})/.exec(entry.name);
    if (!match) continue;
    const stamp = Number(match[1]);
    if (!groups.has(stamp)) groups.set(stamp, []);
    groups.get(stamp).push(path.join(outputDir, entry.name));
  }
  const staleGroups = [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .slice(Math.max(1, Number(keepRuns) || 3));
  await Promise.all(staleGroups.flatMap(([, files]) => files.map((filePath) => fs.rm(filePath, { force: true }))));
}

function clearFastDraftArtifacts(artifacts = {}) {
  const {
    previewVideoPath,
    fastDraftVideoPath,
    internalFastDraftVideoPath,
    fastDraftBaseVideoPath,
    fastDraftSubtitlePath,
    fastDraftReportPath,
    fastDraftSubtitleLanguage,
    fastDraftSubtitlesArePreviewOnly,
    fastDraftSubtitlesEmbedded,
    fastDraftVoiceWarningReportPath,
    fastDraftResolvedTimelinePath,
    fastDraftGeminiRewritePromptPath,
    fastDraftRenderedAt,
    previewRenderedAt,
    ...rest
  } = artifacts || {};
  return rest;
}

function buildExportFilePath({ settings = {}, project = {}, mode = "video", variant = "", extension = ".mp4" }) {
  const exportRoot = safeText(project.exportRoot || settings.exportRoot || "");
  if (!exportRoot) return "";
  const layout = safeText(project.exportLayout || settings.exportLayout || "flat");
  const title = sanitizeFilePart(project.title || project.id || "project");
  const safeMode = sanitizeFilePart(mode);
  const safeVariant = variant ? `-${sanitizeFilePart(variant)}` : "";
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const suffix = extension.startsWith(".") ? extension : `.${extension}`;
  const fileName = `${title}-${safeMode}${safeVariant}-${stamp}${suffix}`;
  return layout === "project_folder"
    ? path.join(exportRoot, `${title}-${sanitizeFilePart(project.id || "project")}`, fileName)
    : path.join(exportRoot, fileName);
}

async function publishFinalVideo({ settings = {}, project = {}, sourcePath, mode = "video", variant = "" }) {
  const extension = path.extname(sourcePath || "") || ".mp4";
  const exportPath = buildExportFilePath({ settings, project, mode, variant, extension });
  if (!exportPath) return sourcePath;
  await fs.mkdir(path.dirname(exportPath), { recursive: true });
  await fs.copyFile(sourcePath, exportPath);
  return exportPath;
}

async function publishDraftVideo({ settings = {}, project = {}, sourcePath, mode = "draft", variant = "", keepRuns = 3 }) {
  const extension = path.extname(sourcePath || "") || ".mp4";
  const exportPath = buildExportFilePath({
    settings,
    project,
    mode: `${sanitizeFilePart(mode)}-draft`,
    variant,
    extension
  });
  if (!exportPath) return sourcePath;
  await fs.mkdir(path.dirname(exportPath), { recursive: true });
  await fs.copyFile(sourcePath, exportPath);

  const fileName = path.basename(exportPath);
  const match = fileName.match(/^(.*-)\d{14}(\.[^.]+)$/);
  if (match) {
    const entries = await fs.readdir(path.dirname(exportPath), { withFileTypes: true }).catch(() => []);
    const siblingDrafts = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(match[1]) && entry.name.endsWith(match[2]))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a));
    await Promise.all(siblingDrafts
      .slice(Math.max(1, Number(keepRuns) || 3))
      .map((name) => fs.rm(path.join(path.dirname(exportPath), name), { force: true }).catch(() => {
        // Retention cleanup must not invalidate the newly published draft.
        // A locked old file can be pruned on a later publication.
      })));
  }
  return exportPath;
}

module.exports = {
  buildExportFilePath,
  buildVideoTitleOverlaySvg,
  calculateVideoTitleWrapChars,
  clearFastDraftArtifacts,
  pruneDraftArtifacts,
  publishDraftVideo,
  publishFinalVideo,
  resolveSuggestedTopCaption,
  resolvePartLabelText,
  resolveSourceSubtitleMask,
  resolveEffectiveVideoEditProject,
  resolveVariantFileMetadata,
  resolveVideoCanvasDimensions,
  resolveVideoTitleRasterDimensions,
  sanitizeFilePart,
  wrapVideoTitle,
  wrapTikTokHookTitle
};
