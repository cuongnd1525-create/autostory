const fs = require("fs/promises");
const path = require("path");
const SubtitleService = require("../subtitleService");
const { alignWords } = require("./recapCaptionService");
const { fingerprint } = require("./recapEditorialService");
const tokens = text => String(text || "").split(/\s+/).filter(Boolean);
const normalized = text => String(text || "").normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

class RecapClauseAlignmentService {
  constructor(settings = {}, dependencies = {}) {
    this.settings = settings;
    this.subtitleFactory = dependencies.subtitleFactory || (options => new SubtitleService(options));
  }
  async prepare({ speechUnits, audioTracks, directory, language = "en", signal, onProgress }) {
    await fs.mkdir(directory, { recursive: true });
    for (const unit of speechUnits) {
      signal?.throwIfAborted();
      const clauses = unit.clauses || [], groups = [];
      for (const clause of clauses) {
        const ids = [...new Set(clause.visual_event_ids || [])], key = [...ids].sort().join("|");
        if (groups.at(-1)?.key === key) { groups.at(-1).text += ` ${clause.text}`; groups.at(-1).clauseIds.push(clause.clause_id); }
        else groups.push({ key, text: clause.text, visual_event_ids: ids, clauseIds: [clause.clause_id] });
      }
      const track = audioTracks[unit.id];
      if (groups.length < 2) { if (track) delete track.clauseSpans; continue; }
      if (normalized(groups.map(group => group.text).join(" ")) !== normalized(unit.text)
        || groups.reduce((sum, group) => sum + tokens(group.text).length, 0) !== tokens(unit.text).length) {
        throw new Error(`Mệnh đề của ${unit.id} không khớp lời đọc. Không thể căn hình theo câu bị thiếu hoặc khác nội dung.`);
      }
      if (!track?.audioPath || !(track.durationSec > 0)) throw new Error(`Thiếu audio TTS hợp lệ cho ${unit.id}; chưa thể căn hình theo lời đọc.`);
      const stat = await fs.stat(track.audioPath);
      const key = fingerprint({ version: 1, text: unit.text, groups, audio: track.audioPath, size: stat.size, modified: stat.mtimeMs, language });
      const cachePath = path.join(directory, `${key}.json`); let spans;
      try { spans = JSON.parse(await fs.readFile(cachePath, "utf8")); } catch (_) {}
      if (!Array.isArray(spans) || spans.length !== groups.length || spans.some((span, i) =>
        span.key !== groups[i].key || span.text !== groups[i].text || !Array.isArray(span.visual_event_ids)
        || [...span.visual_event_ids].sort().join("|") !== groups[i].key || !(span.matchedRatio >= .8)
        || !Number.isFinite(span.startSec) || !Number.isFinite(span.endSec)
        || span.startSec < 0 || span.endSec <= span.startSec || span.endSec > track.durationSec
        || (i > 0 && span.startSec <= spans[i - 1].startSec))) spans = null;
      if (!spans) {
        onProgress?.({ message: `Đang căn hình theo lời đọc thực tế: ${unit.id} (${groups.length} nhóm mệnh đề)...` });
        const model = this.settings.recapCaptionAsrModel || (language === "en" ? "base.en" : "base");
        let aligned;
        for (let attempt = 0; attempt < 2; attempt++) {
          signal?.throwIfAborted();
          if (attempt) onProgress?.({ message: `ASR chưa khớp ${unit.id}; đang nhận dạng lại với beam 5, không dùng batch...` });
          const subtitles = this.subtitleFactory({ ...this.settings, whisperEngine: "faster-whisper", whisperModel: model,
            ...(attempt ? { whisperBeamSize: 5, whisperBatchSize: 1 } : {}) });
          const result = await subtitles.transcribeToSrt({ audioPath: track.audioPath, outputDir: directory,
            narrationLanguage: language, cacheDir: path.join(directory, "asr-cache"), timeoutMs: 600000, signal });
          signal?.throwIfAborted();
          const payload = JSON.parse(await fs.readFile(result.wordTimestampsPath, "utf8"));
          const recognized = (payload.segments || []).flatMap(segment => segment.words || []);
          aligned = alignWords(unit.text, recognized, 0, track.durationSec);
          if (aligned.matchedRatio >= .8) break;
        }
        if (aligned.matchedRatio < .8) throw new Error(`Không căn được mệnh đề ${unit.id} tin cậy với TTS (${Math.round(aligned.matchedRatio * 100)}%). Chưa dựng hình bằng mốc ước lượng.`);
        let offset = 0;
        spans = groups.map(group => {
          const length = tokens(group.text).length, words = aligned.words.slice(offset, offset + length); offset += length;
          return { ...group, startSec: words[0].start, endSec: words.at(-1).end, matchedRatio: aligned.matchedRatio };
        });
        await fs.writeFile(cachePath, JSON.stringify(spans), "utf8");
      }
      track.clauseSpans = spans;
    }
    return audioTracks;
  }
}
module.exports = RecapClauseAlignmentService;
