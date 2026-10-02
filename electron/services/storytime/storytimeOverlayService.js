const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const {
  buildTikTokKaraokeAssContent,
  buildWordTimestampsFromSegments,
  secondsToAssTime
} = require("../karaokeSubtitleService");

function escapePathForFilter(filePath) {
  return String(filePath || "")
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function escapeAss(str) {
  return String(str || "")
    .replace(/[{}]/g, "")
    .replace(/\r?\n/g, " ")
    .trim();
}

function escapeSvg(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const COLOR_PRESETS = {
  cyan: "&H00FFFF00&",     // Cyan (Template 1 Avatar cleaner)
  yellow: "&H0000FFFF&",   // Yellow (Template 2 & 3 Contractor / Diver)
  neon_green: "&H0066FF00&",
  white: "&H00FFFFFF&"
};

class StorytimeOverlayService {
  constructor(settings = {}) {
    this.settings = settings;
    this.ffmpegPath = settings.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
    this.ffprobePath = settings.ffprobePath || process.env.FFPROBE_PATH || "ffprobe";
  }

  async runCommand(binary, args, timeoutMs = 90000) {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { windowsHide: true });
      const stdoutChunks = [];
      const stderrChunks = [];
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`${binary} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      child.stdout.on("data", (c) => stdoutChunks.push(c));
      child.stderr.on("data", (c) => stderrChunks.push(c));
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString();
          reject(new Error(`${binary} failed (code ${code}): ${stderr.slice(-600)}`));
          return;
        }
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString(),
          stderr: Buffer.concat(stderrChunks).toString()
        });
      });
    });
  }

  /**
   * Generates a 3-line viral Header Hook Card as an SVG overlay (matching Template 3).
   * Placed at y=120px (under TikTok search bar) with rounded corners and subtle drop shadow.
   */
  generateHeaderCardSvg({
    headerCard = {},
    width = 1080,
    height = 1920,
    yOffset = 120,
    cardBgColor = "#FFFFFF",
    line1Color = "#111827",
    line2Color = "#374151",
    line3Color = "#047857"
  } = {}) {
    const l1 = escapeSvg(headerCard.line1 || "CONTRACT JOB").toUpperCase();
    const l2 = escapeSvg(headerCard.line2 || "HIGH RISK CLEANING").toUpperCase();
    const l3 = escapeSvg(headerCard.line3 || "$12,000 PAYOUT").toUpperCase();

    const scale = width / 1080;
    const cardWidth = Math.round(860 * scale);
    const cardHeight = Math.round(230 * scale);
    const cardX = Math.round((width - cardWidth) / 2);
    const cardY = Math.round(yOffset * (height / 1920));
    const cornerRadius = Math.round(22 * scale);

    const f1Size = Math.round(38 * scale);
    const f2Size = Math.round(32 * scale);
    const f3Size = Math.round(44 * scale);

    const l1Y = cardY + Math.round(58 * scale);
    const l2Y = cardY + Math.round(116 * scale);
    const l3Y = cardY + Math.round(184 * scale);
    const centerX = Math.round(width / 2);

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="6" stdDeviation="12" flood-color="#000000" flood-opacity="0.32" />
    </filter>
  </defs>
  <!-- Header Card Box -->
  <rect x="${cardX}" y="${cardY}" width="${cardWidth}" height="${cardHeight}" rx="${cornerRadius}" ry="${cornerRadius}" fill="${cardBgColor}" filter="url(#cardShadow)" />
  
  <!-- Line 1: Catchy Premise / Context -->
  <text x="${centerX}" y="${l1Y}" text-anchor="middle" font-family="'Segoe UI', 'Impact', 'Arial Black', sans-serif" font-size="${f1Size}" font-weight="900" fill="${line1Color}" letter-spacing="1">
    ${l1}
  </text>
  
  <!-- Line 2: Tool / Condition -->
  <text x="${centerX}" y="${l2Y}" text-anchor="middle" font-family="'Segoe UI', 'Arial', sans-serif" font-size="${f2Size}" font-weight="700" fill="${line2Color}" letter-spacing="0.5">
    / ${l2}
  </text>
  
  <!-- Line 3: Dollar Payout / Stakes -->
  <text x="${centerX}" y="${l3Y}" text-anchor="middle" font-family="'Segoe UI', 'Impact', 'Arial Black', sans-serif" font-size="${f3Size}" font-weight="900" fill="${line3Color}" letter-spacing="1.5">
    / ${l3}
  </text>
</svg>`;
  }

  /**
   * Renders the SVG Header Card to a transparent PNG.
   * Uses Electron BrowserWindow offscreen rendering if available, with graceful fallback.
   */
  async renderCardToPng({ svgContent, outputPath, width = 1080, height = 1920 }) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    try {
      const { BrowserWindow } = require("electron");
      if (typeof BrowserWindow === "function") {
        const win = new BrowserWindow({
          show: false,
          frame: false,
          transparent: true,
          width,
          height,
          webPreferences: { offscreen: true }
        });

        const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:transparent;overflow:hidden;">${svgContent}</body></html>`;
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        const img = await win.webContents.capturePage({ x: 0, y: 0, width, height });
        win.destroy();

        if (!img.isEmpty()) {
          await fs.writeFile(outputPath, img.toPNG());
          return outputPath;
        }
      }
    } catch (_err) {
      // Electron BrowserWindow not available (e.g. running in pure CLI/test runner)
    }

    // Fallback: write the SVG directly
    const svgPath = outputPath.replace(/\.png$/, ".svg");
    await fs.writeFile(svgPath, svgContent, "utf8");
    return svgPath;
  }

  /**
   * Generates Kinetic TikTok ASS Subtitles.
   * 1-3 words per flash, bold uppercase with heavy black stroke and active word highlight.
   */
  generateKineticAssSubtitles({
    segments = [],
    headerCard = null,
    durationSec = 60,
    width = 1080,
    height = 1920,
    highlightColor = "cyan", // 'cyan' | 'yellow' | 'neon_green'
    wordsPerGroup = 3,
    fontSize = 62,
    marginV = 640 // Positioned in lower-middle sweet spot (avoids TikTok UI buttons)
  } = {}) {
    const activeColor = COLOR_PRESETS[highlightColor] || COLOR_PRESETS.cyan;

    // Convert segments into flat word timestamps
    const wordList = buildWordTimestampsFromSegments(segments);

    // Build ASS content with heavy outline (4.5px) for maximum contrast against busy satisfying backgrounds
    let assContent = buildTikTokKaraokeAssContent(wordList, {
      width,
      height,
      fontSize,
      outline: 4.5,
      shadow: 2,
      marginV,
      fontName: "Arial Black",
      wordsPerGroup,
      activeColor,
      inactiveColor: "&H00FFFFFF&"
    });

    // If headerCard is provided, inject Top Header Hook Card directly into ASS
    if (headerCard && (headerCard.line1 || headerCard.line2 || headerCard.line3)) {
      const endAssTime = secondsToAssTime(durationSec || 300);
      const scale = width / 1080;
      const f1 = Math.round(38 * scale);
      const f2 = Math.round(32 * scale);
      const f3 = Math.round(44 * scale);
      const cx = Math.round(width / 2);
      const cardY = Math.round(230 * (height / 1920));
      const l1Y = cardY - Math.round(55 * scale);
      const l2Y = cardY;
      const l3Y = cardY + Math.round(62 * scale);

      const headerCardStyles = `Style: HeaderCardBox,Arial Black,${f1},&H00111827,&H00000000,&H00FFFFFF,&H60000000,-1,0,0,0,100,100,0,0,3,24,6,5,40,40,0,1\n`;

      const l1 = escapeAss(headerCard.line1 || "").toUpperCase();
      const l2 = escapeAss(headerCard.line2 || "").toUpperCase();
      const l3 = escapeAss(headerCard.line3 || "").toUpperCase();

      const cardText = `{\\pos(${cx},${cardY})}{\\c&H00111827&}${l1}\\N{\\fnArial\\fs${f2}\\c&H00374151}/ ${l2}\\N{\\fnArial Black\\fs${f3}\\c&H00047857}/ ${l3}`;
      const headerCardEvents = `Dialogue: 0,0:00:00.00,${endAssTime},HeaderCardBox,,0,0,0,,${cardText}\n`;

      assContent = assContent.replace("[Events]", headerCardStyles + "\n[Events]");
      assContent = assContent.replace(/(Format: Layer[^\n]*\n)/, `$1${headerCardEvents}`);
    }

    return assContent;
  }

  /**
   * Burns Header Hook Card and Kinetic Subtitles onto the source video.
   */
  async burnVideoOverlays({
    videoPath,
    cardImagePath = null,
    assSubtitlePath = null,
    outputPath,
    durationSec = 0,
    onProgress
  }) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    onProgress?.({ message: "Burning header card and kinetic captions onto video..." });

    const inputs = ["-y", "-i", videoPath];
    let filterComplex = "";

    const hasCardPng = cardImagePath && cardImagePath.endsWith(".png");
    const hasAss = assSubtitlePath && assSubtitlePath.endsWith(".ass");

    if (hasCardPng && hasAss) {
      inputs.push("-i", cardImagePath);
      const escapedAss = escapePathForFilter(assSubtitlePath);
      filterComplex = `[0:v][1:v]overlay=0:0[vcard];[vcard]ass='${escapedAss}'[vout]`;
    } else if (hasCardPng) {
      inputs.push("-i", cardImagePath);
      filterComplex = `[0:v][1:v]overlay=0:0[vout]`;
    } else if (hasAss) {
      const escapedAss = escapePathForFilter(assSubtitlePath);
      filterComplex = `[0:v]ass='${escapedAss}'[vout]`;
    } else {
      filterComplex = `[0:v]null[vout]`;
    }

    const args = [
      ...inputs,
      "-filter_complex", filterComplex,
      "-map", "[vout]",
      "-map", "0:a?",
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "20",
      "-c:a", "copy",
      "-movflags", "+faststart"
    ];

    if (durationSec > 0) {
      args.push("-t", String(durationSec));
    }
    args.push(outputPath);

    await this.runCommand(this.ffmpegPath, args, 180000);
    return outputPath;
  }
}

StorytimeOverlayService.COLOR_PRESETS = COLOR_PRESETS;

module.exports = StorytimeOverlayService;
