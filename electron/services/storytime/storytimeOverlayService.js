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

function normalizeTokenForMatch(word) {
  return String(word || "")
    .toUpperCase()
    .replace(/^[^A-Z0-9$£€]+|[^A-Z0-9%]+$/g, "");
}

function stripTtsMarkup(text = "") {
  return String(text || "")
    .replace(/<break\b[^>]*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "A", "AN", "THE", "AND", "OR", "BUT", "SO", "TO", "OF", "IN", "ON", "AT",
  "BY", "FOR", "WITH", "FROM", "INTO", "IS", "ARE", "WAS", "WERE", "BE",
  "BEEN", "IT", "ITS", "THIS", "THAT", "THESE", "THOSE", "I", "YOU", "WE",
  "THEY", "HE", "SHE", "MY", "YOUR", "OUR", "THEIR", "ME", "HIM", "HER",
  "US", "THEM", "AS", "IF", "UP", "OUT", "JUST", "CAN", "WILL", "WOULD",
  "COULD", "SHOULD", "HAVE", "HAS", "HAD", "DO", "DOES", "DID", "NOT", "NO"
]);

// Money/Measurement units, Tool/Material nouns, Action verbs, and UK/US Craftsman Slang
const HIGH_IMPACT_KEYWORDS = new Set([
  // Money & Measurements
  "POUNDS", "DOLLARS", "QUID", "BUCKS", "GRAND", "INVOICED", "CHARGED", "QUOTED",
  "CENTIMETER", "MILLIMETER", "MINUTES", "HOURS", "YEARS", "50-CENTIMETER", "100-YEAR-OLD",
  // Tools & Materials
  "CHISEL", "OSCILLATING", "MULTI-TOOL", "SAW", "BLADE", "DRILL", "SCREW", "SCREWS",
  "SANDPAPER", "SANDER", "SCRAPER", "EXCAVATOR", "WASHER", "PRIMER", "RESIN", "EPOXY",
  "FILLER", "ADHESIVE", "GLUE", "SEALANT", "CAULK", "PAINT", "TIMBER", "WOOD", "SILL",
  "FRAME", "SPLICE", "BLOCK", "JOINT", "ROT", "DAMP", "MUD", "RUST",
  // Action Verbs & Slang / Power Words
  "CHISELING", "CUTTING", "CARVING", "SAWING", "DRILLING", "PRE-DRILLING", "COUNTERSINKING",
  "SANDING", "PRIMING", "SEALING", "PAINTING", "FITTING", "STRIPPING", "DEMOLITION",
  "SURGICAL", "RESTORING", "REBUILDING", "MEASURING", "DOUBLE-TREATED", "WEATHERPROOF",
  "WEATHERPROOFING", "ROBBERY", "DAYLIGHT", "RIP-OFF", "GRAFT", "BESPOKE", "SORTED",
  "BODGED", "INVISIBLE", "FLAWLESS", "ROTTED", "RIDDLED", "WEAKENING", "CRAFTSMANSHIP", "PENNY"
]);

function isHighImpactKeyword(token = "", emphasisSet = new Set()) {
  const norm = normalizeTokenForMatch(token);
  if (!norm || STOPWORDS.has(norm)) return false;
  if (emphasisSet.has(norm)) return true;
  if (/[\d$£€%]/.test(token)) return true;
  if (HIGH_IMPACT_KEYWORDS.has(norm)) return true;
  // Also check hyphenated parts (e.g. "50-CENTIMETER", "DOUBLE-TREATED", "PRE-DRILLING")
  if (norm.includes("-")) {
    const parts = norm.split("-").filter(Boolean);
    if (parts.some((p) => HIGH_IMPACT_KEYWORDS.has(p) || emphasisSet.has(p))) return true;
  }
  return false;
}

const COLOR_PRESETS = {
  cyan: "&H00FFFF00&",     // Cyan (BGR)
  yellow: "&H0000FFFF&",   // Yellow (BGR)
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
   * Generates a compact TikTok-native white rounded pill sticker at the top safe zone (matching the UK Craftsman reference video).
   * Example: "Why does NOBODY do this ? 🙄"
   */
  generateNativePillSvg({
    stickerText = "Why does NOBODY do this ? 🙄",
    width = 1080,
    height = 1920,
    yOffset = 304,
    minWidth = 876,
    pillBgColor = "#FFFFFF",
    textColor = "#0F172A"
  } = {}) {
    const cleanText = String(stickerText || "Why does NOBODY do this ? 🙄").trim();
    const escapedText = escapeSvg(cleanText);
    const scale = width / 1080;

    // Auto-size font and pill width so it stays sleek and never overflows
    const charCount = cleanText.length;
    const baseFontSize = charCount > 36 ? 36 : charCount > 28 ? 40 : 44;
    const fontSize = Math.round(baseFontSize * scale);
    const estimatedTextWidth = Math.round(charCount * fontSize * 0.56);
    const horizontalPad = Math.round(80 * scale);
    const pillWidth = Math.max(Math.round(minWidth * scale), Math.min(Math.round(980 * scale), estimatedTextWidth + horizontalPad));
    const pillHeight = Math.round(104 * scale);
    const pillX = Math.round((width - pillWidth) / 2);
    const pillY = Math.round(yOffset * (height / 1920));
    const rx = Math.round(24 * scale);
    const centerX = Math.round(width / 2);
    const textY = pillY + Math.round(pillHeight * 0.65);

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <filter id="pillShadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="5" stdDeviation="10" flood-color="#000000" flood-opacity="0.34" />
    </filter>
  </defs>
  <rect x="${pillX}" y="${pillY}" width="${pillWidth}" height="${pillHeight}" rx="${rx}" ry="${rx}" fill="${pillBgColor}" filter="url(#pillShadow)" />
  <text x="${centerX}" y="${textY}" text-anchor="middle" font-family="'Segoe UI', 'Inter', 'Arial', 'Segoe UI Emoji', sans-serif" font-size="${fontSize}" font-weight="800" fill="${textColor}" letter-spacing="0.2">
    ${escapedText}
  </text>
</svg>`;
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
   * Renders the SVG Header Card or Pill to a transparent PNG.
   * Uses Electron BrowserWindow offscreen rendering with paint stabilization, with graceful fallback.
   */
  async renderCardToPng({ svgContent, outputPath, width = 1080, height = 1920 }) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    try {
      const { app, BrowserWindow } = require("electron");
      if (typeof BrowserWindow === "function") {
        if (app && typeof app.listenerCount === "function" && app.listenerCount("window-all-closed") === 0) {
          app.on("window-all-closed", () => {});
        }
        const win = new BrowserWindow({
          show: false,
          frame: false,
          transparent: true,
          width,
          height,
          webPreferences: { offscreen: true }
        });

        try {
          const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:transparent;overflow:hidden;">${svgContent}</body></html>`;
          await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
          await win.webContents.executeJavaScript(
            "document.fonts ? document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))) : Promise.resolve()"
          ).catch(() => {});
          await new Promise((r) => setTimeout(r, 120));
          const img = await win.webContents.capturePage({ x: 0, y: 0, width, height });
          if (!img.isEmpty()) {
            await fs.writeFile(outputPath, img.toPNG());
            return outputPath;
          }
        } finally {
          if (!win.isDestroyed()) win.destroy();
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
   * Builds weighted word timestamps from segments and marks emphasis words for selective highlighting.
   */
  buildWeightedWordsFromSegments(segments = []) {
    const result = [];
    let timelineCursor = 0;

    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const duration = Math.max(0.15, Number(seg.actualDurationSec || seg.durationSec || seg.duration || (seg.endSec - seg.startSec) || 0));
      const startSec = Number.isFinite(Number(seg.startSec)) ? Number(seg.startSec) : timelineCursor;
      const endSec = Number.isFinite(Number(seg.endSec)) ? Number(seg.endSec) : startSec + duration;
      timelineCursor = endSec;

      const emphasisSet = new Set();
      if (Array.isArray(seg.emphasisWords)) {
        for (const phrase of seg.emphasisWords) {
          for (const part of String(phrase || "").split(/\s+/)) {
            const norm = normalizeTokenForMatch(part);
            if (norm) emphasisSet.add(norm);
          }
        }
      }

      if (Array.isArray(seg.words) && seg.words.length > 0) {
        for (const w of seg.words) {
          const cleanWord = stripTtsMarkup(w.word).replace(/^[—–-]+|[—–-]+$/g, "").trim();
          if (!cleanWord || !/[a-zA-Z0-9$£€]/.test(cleanWord)) continue;
          result.push({
            word: cleanWord,
            start: Math.max(startSec, Number(w.start) || startSec),
            end: Math.min(endSec, Number(w.end) || endSec),
            isEmphasis: isHighImpactKeyword(cleanWord, emphasisSet)
          });
        }
        continue;
      }

      const rawText = String(seg.voiceover_text || seg.voiceoverText || seg.text || seg.caption || "");
      const text = stripTtsMarkup(rawText);
      if (!text) continue;
      const tokens = text
        .split(/\s+/)
        .map((tk) => tk.replace(/^[—–-]+|[—–-]+$/g, "").trim())
        .filter((tk) => tk && /[a-zA-Z0-9$£€]/.test(tk));
      if (!tokens.length) continue;

      const weights = tokens.map((token) => {
        const cleanLen = token.replace(/[^a-zA-Z0-9]/g, "").length;
        const punctBonus = /[,.!?;:—-]$/.test(token) ? 1.8 : 0;
        const numberBonus = /\d/.test(token) ? 1.5 : 0;
        return Math.max(2.2, cleanLen * 0.75 + punctBonus + numberBonus);
      });
      const totalWeight = weights.reduce((sum, w) => sum + w, 0) || tokens.length;
      const span = Math.max(0.15, endSec - startSec);

      let cursor = startSec;
      for (let t = 0; t < tokens.length; t += 1) {
        const token = tokens[t];
        const wDur = (weights[t] / totalWeight) * span;
        const wStart = cursor;
        const wEnd = t === tokens.length - 1 ? endSec : Math.min(endSec, cursor + wDur);
        cursor = wEnd;
        result.push({
          word: token,
          start: Number(wStart.toFixed(3)),
          end: Number(wEnd.toFixed(3)),
          isEmphasis: isHighImpactKeyword(token, emphasisSet)
        });
      }
    }

    return result;
  }

  /**
   * Generates Kinetic TikTok ASS Subtitles.
   * Supports 1-3 word phrases synced to real-time audio timestamps with selective keyword highlighting
   * (money, tool names, action verbs) and thick black stroke + deep drop shadow (no blur box required).
   */
  generateKineticAssSubtitles({
    segments = [],
    headerCard = null,
    headerSticker = "",
    headerStyle = "white_box",
    includeAssHeader = true,
    selectiveHighlight = true,
    durationSec = 60,
    width = 1080,
    height = 1920,
    highlightColor = "cyan", // 'cyan' | 'yellow' | 'neon_green'
    wordsPerGroup = 3,
    fontSize = 68,
    outline = 6.5,
    shadow = 3.5,
    marginV = 445 // Lower-middle safe zone floating cleanly above bottom TikTok UI
  } = {}) {
    const activeColor = COLOR_PRESETS[highlightColor] || COLOR_PRESETS.cyan;
    const inactiveColor = "&H00FFFFFF&";

    const hasExplicitWords = segments.some((s) => Array.isArray(s.words) && s.words.length > 0);
    const wordList = hasExplicitWords && !selectiveHighlight
      ? buildWordTimestampsFromSegments(segments)
      : this.buildWeightedWordsFromSegments(segments);

    let assContent;
    if (selectiveHighlight) {
      const maxWords = Math.max(1, Math.min(3, Number(wordsPerGroup || 3)));
      const cleanWords = wordList
        .filter((w) => w && typeof w.word === "string" && String(w.word).trim())
        .map((w) => ({
          word: escapeAss(w.word).toUpperCase(),
          start: Math.max(0, Number(w.start) || 0),
          end: Math.max(0.05, Number(w.end) || Number(w.start) + 0.25),
          isEmphasis: Boolean(w.isEmphasis)
        }));

      const groups = [];
      let currentGroup = [];
      for (let i = 0; i < cleanWords.length; i += 1) {
        const w = cleanWords[i];
        const prev = currentGroup[currentGroup.length - 1];
        const gap = prev ? w.start - prev.end : 0;
        const prevEndsClause = prev && /[,.!?;:—-]$/.test(prev.word);
        const charLen = currentGroup.reduce((s, item) => s + item.word.length, 0) + w.word.length;

        if (
          currentGroup.length >= maxWords ||
          (currentGroup.length > 0 && (gap > 0.28 || prevEndsClause || charLen > 18))
        ) {
          groups.push(currentGroup);
          currentGroup = [w];
        } else {
          currentGroup.push(w);
        }
      }
      if (currentGroup.length > 0) groups.push(currentGroup);

      const events = [];
      for (const group of groups) {
        const groupHasEmphasis = group.some((item) => item.isEmphasis);
        for (let wIdx = 0; wIdx < group.length; wIdx += 1) {
          const activeWord = group[wIdx];
          const startSec = activeWord.start;
          const nextWord = group[wIdx + 1];
          const endSec = nextWord ? nextWord.start : activeWord.end;
          if (endSec <= startSec) continue;

          const lineParts = group.map((item, idx) => {
            const isSpoken = idx === wIdx;
            const shouldColor = item.isEmphasis || (isSpoken && !groupHasEmphasis);
            if (isSpoken && shouldColor) {
              return `{\\fscx108\\fscy108\\c${activeColor}}${item.word}{\\fscx100\\fscy100\\c${inactiveColor}}`;
            }
            if (isSpoken) {
              return `{\\fscx105\\fscy105\\c${inactiveColor}}${item.word}{\\fscx100\\fscy100}`;
            }
            if (item.isEmphasis) {
              return `{\\c${activeColor}}${item.word}{\\c${inactiveColor}}`;
            }
            return item.word;
          });

          events.push({
            startSec,
            endSec,
            text: lineParts.join(" ")
          });
        }
      }

      assContent = buildTikTokKaraokeAssContent(events, {
        width,
        height,
        fontSize,
        outline,
        shadow,
        marginV,
        fontName: "Arial Black",
        wordsPerGroup: maxWords,
        activeColor,
        inactiveColor
      });
    } else {
      assContent = buildTikTokKaraokeAssContent(wordList, {
        width,
        height,
        fontSize,
        outline,
        shadow,
        marginV,
        fontName: "Arial Black",
        wordsPerGroup,
        activeColor,
        inactiveColor
      });
    }

    // Inject ASS header fallback only when requested (e.g., unit tests or when PNG overlay is not used)
    if (includeAssHeader) {
      const endAssTime = secondsToAssTime(durationSec || 300);
      const scale = width / 1080;
      const cx = Math.round(width / 2);

      if (headerStyle === "native_pill" && headerSticker) {
        const fPill = Math.round(40 * scale);
        const pillY = Math.round(195 * (height / 1920));
        const cleanSticker = escapeAss(headerSticker.replace(/[^\x20-\x7E\u00A0-\u024F\u1E00-\u1EFF]/g, "").trim() || "Why does NOBODY do this ?");
        const headerCardStyles = `Style: HeaderCardBox,Arial Black,${fPill},&H000F172A,&H00000000,&H00FFFFFF,&H60000000,-1,0,0,0,100,100,0,0,3,22,4,5,40,40,0,1\n`;
        const cardText = `{\\pos(${cx},${pillY})}{\\c&H000F172A&}  ${cleanSticker}  `;
        const headerCardEvents = `Dialogue: 0,0:00:00.00,${endAssTime},HeaderCardBox,,0,0,0,,${cardText}\n`;
        assContent = assContent.replace("[Events]", headerCardStyles + "\n[Events]");
        assContent = assContent.replace(/(Format: Layer[^\n]*\n)/, `$1${headerCardEvents}`);
      } else if (headerCard && (headerCard.line1 || headerCard.line2 || headerCard.line3)) {
        const f1 = Math.round(38 * scale);
        const f2 = Math.round(32 * scale);
        const f3 = Math.round(44 * scale);
        const cardY = Math.round(230 * (height / 1920));

        const headerCardStyles = `Style: HeaderCardBox,Arial Black,${f1},&H00111827,&H00000000,&H00FFFFFF,&H60000000,-1,0,0,0,100,100,0,0,3,24,6,5,40,40,0,1\n`;

        const l1 = escapeAss(headerCard.line1 || "").toUpperCase();
        const l2 = escapeAss(headerCard.line2 || "").toUpperCase();
        const l3 = escapeAss(headerCard.line3 || "").toUpperCase();

        const cardText = `{\\pos(${cx},${cardY})}{\\c&H00111827&}${l1}\\N{\\fnArial\\fs${f2}\\c&H00374151}/ ${l2}\\N{\\fnArial Black\\fs${f3}\\c&H00047857}/ ${l3}`;
        const headerCardEvents = `Dialogue: 0,0:00:00.00,${endAssTime},HeaderCardBox,,0,0,0,,${cardText}\n`;

        assContent = assContent.replace("[Events]", headerCardStyles + "\n[Events]");
        assContent = assContent.replace(/(Format: Layer[^\n]*\n)/, `$1${headerCardEvents}`);
      }
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
StorytimeOverlayService.HIGH_IMPACT_KEYWORDS = HIGH_IMPACT_KEYWORDS;
StorytimeOverlayService.isHighImpactKeyword = isHighImpactKeyword;

module.exports = StorytimeOverlayService;
