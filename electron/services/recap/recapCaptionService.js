const fs = require("fs/promises");
const path = require("path");
const SubtitleService = require("../subtitleService");
const { fingerprint } = require("./recapEditorialService");
const { buildTikTokKaraokeAssContent } = require("../karaokeSubtitleService");

const tokenKey = (text) => text.normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
function alignWords(text, recognized, start, end) {
  const tokens = String(text).split(/\s+/).filter(Boolean);
  const rows = Array.from({ length: tokens.length + 1 }, () => new Uint16Array(recognized.length + 1));
  for (let i = 1; i <= tokens.length; i++) for (let j = 1; j <= recognized.length; j++) {
    rows[i][j] = tokenKey(tokens[i - 1]) === tokenKey(recognized[j - 1].word)
      ? rows[i - 1][j - 1] + 1 : Math.max(rows[i - 1][j], rows[i][j - 1]);
  }
  const anchors = new Map();
  let i = tokens.length, j = recognized.length;
  while (i > 0 && j > 0) {
    if (tokenKey(tokens[i - 1]) === tokenKey(recognized[j - 1].word)) { anchors.set(i - 1, recognized[j - 1]); i--; j--; }
    else if (rows[i - 1][j] >= rows[i][j - 1]) i--; else j--;
  }
  const words = tokens.map((word, index) => {
    const anchor = anchors.get(index);
    if (anchor) return { word, start: Math.max(start, anchor.start), end: Math.min(end, Math.max(anchor.start + 0.01, anchor.end)) };
    const previous = [...anchors.keys()].filter((key) => key < index).sort((a, b) => b - a)[0];
    const next = [...anchors.keys()].filter((key) => key > index).sort((a, b) => a - b)[0];
    const from = previous === undefined ? start : anchors.get(previous).end;
    const to = next === undefined ? end : anchors.get(next).start;
    const firstIndex = previous === undefined ? 0 : previous + 1;
    const lastIndex = next === undefined ? tokens.length : next;
    const step = Math.max(0.01, (to - from) / Math.max(1, lastIndex - firstIndex));
    return { word, start: Math.min(end - 0.01, from + (index - firstIndex) * step), end: Math.min(end, from + (index - firstIndex + 1) * step) };
  });
  return { words, matchedRatio: anchors.size / Math.max(1, tokens.length) };
}
function phraseEvents(words) {
  const groups = []; let current = [];
  for (const word of words) {
    if (current.length && (current.length >= 4 || word.start - current.at(-1).end > 0.45 || /[.!?]$/.test(current.at(-1).word))) {
      groups.push(current); current = [];
    }
    current.push(word);
  }
  if (current.length) groups.push(current);
  return groups.map((group) => ({ startSec: group[0].start, endSec: group.at(-1).end,
    text: group.map((word) => word.word.replace(/[{}\\]/g, "")).join(" ") }));
}
function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

class RecapCaptionService {
  constructor(settings = {}, dependencies = {}) { this.settings = settings; this.subtitleFactory = dependencies.subtitleFactory || ((options) => new SubtitleService(options)); }
  async prepare({ narrationPath, decisions, directory, style, language = "en", width, height, onProgress }) {
    if (!style || style === "off") return null;
    await fs.mkdir(directory, { recursive: true });
    const key = fingerprint({ language, decisions: decisions.map((d) => ({ text: d.text, audio: d.audio_path, tempo: d.voice_tempo, start: d.clips[0]?.output_start, lead: d.clips[0]?.lead_ms })) });
    const alignedPath = path.join(directory, `${key}-aligned.json`);
    let aligned;
    try { aligned = JSON.parse(await fs.readFile(alignedPath, "utf8")); } catch (_) {}
    if (!aligned) {
      onProgress?.({ message: "Đang căn mốc phụ đề theo audio TTS..." });
      const subtitles = this.subtitleFactory({ ...this.settings, whisperEngine: "faster-whisper",
        whisperModel: this.settings.recapCaptionAsrModel || (language === "en" ? "base.en" : "base") });
      const result = await subtitles.transcribeToSrt({ audioPath: narrationPath, outputDir: directory,
        narrationLanguage: language, cacheDir: path.join(directory, "asr-cache"), timeoutMs: 600000 });
      const payload = JSON.parse(await fs.readFile(result.wordTimestampsPath, "utf8"));
      const recognized = (payload.segments || []).flatMap((segment) => segment.words || []);
      const units = decisions.map((d) => {
        const start = d.clips[0].output_start + (d.clips[0].lead_ms ?? 250) / 1000;
        const end = start + d.audio_duration / d.voice_tempo;
        return alignWords(d.text, recognized.filter((word) => word.start >= start - 0.12 && word.start < end + 0.12), start, end);
      });
      aligned = { words: units.flatMap((unit) => unit.words), matchedRatio: units.reduce((sum, unit) => sum + unit.matchedRatio, 0) / Math.max(1, units.length) };
      if (aligned.matchedRatio < 0.65) throw new Error("Không căn được phụ đề tin cậy với TTS. Hãy đổi model ASR hoặc tắt phụ đề và kiểm tra draft.");
      await fs.writeFile(alignedPath, JSON.stringify(aligned), "utf8");
    }
    const events = phraseEvents(aligned.words);
    const assPath = path.join(directory, `${key}-${style}-${width}x${height}.ass`);
    const assOptions = { width, height, fontName: "Arial", fontSize: 58, marginV: 480, wordsPerGroup: 4 };
    let content = buildTikTokKaraokeAssContent(style === "karaoke" ? aligned.words : events, assOptions);
    content = content.replace(",2,30,30,", `,2,${Math.round(width * 0.07)},${Math.round(width * 0.15)},`);
    await fs.writeFile(assPath, content, "utf8");
    const srtPath = path.join(directory, `${key}.srt`);
    await fs.writeFile(srtPath, events.map((event, index) => `${index + 1}\n${srtTime(event.startSec)} --> ${srtTime(event.endSec)}\n${event.text}\n`).join("\n"), "utf8");
    return { assPath, srtPath, matchedRatio: aligned.matchedRatio };
  }
}
module.exports = RecapCaptionService;
module.exports.alignWords = alignWords;
module.exports.phraseEvents = phraseEvents;
