const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const Media = require("./recapMediaService");
const SubtitleService = require("../subtitleService");
const { fingerprint } = require("./recapEditorialService");

class RecapAnchorAuditService {
  constructor(settings = {}, dependencies = {}) {
    this.media = dependencies.media || new Media(settings);
    this.subtitleFactory = dependencies.subtitleFactory || (() => new SubtitleService({ ...settings, whisperEngine: "faster-whisper", whisperModel: "base.en" }));
  }
  async repair({ sourceVideoPath, sourceDuration, events, eventIds, issues, scenes = [], directory, ai, signal, onProgress }) {
    const selected = events.filter(event => eventIds.includes(event.id));
    if (!selected.length) return events;
    signal?.throwIfAborted();
    const stat = await fs.stat(sourceVideoPath);
    const key = fingerprint({ version: 2, sourceVideoPath, size: stat.size, modified: stat.mtimeMs, selected, issues });
    const root = path.join(directory, key.slice(0, 16)); await fs.mkdir(root, { recursive: true });
    const start = Math.max(0, Math.floor(Math.min(...selected.map(event => event.source_start)) - 45));
    const end = Math.min(sourceDuration, Math.ceil(Math.max(...selected.map(event => event.source_end)) + 45));
    const audioPath = path.join(root, "source-audio.wav");
    await this.media.runCommand(this.media.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(start), "-i", sourceVideoPath,
      "-t", String(end - start), "-vn", "-ar", "16000", "-ac", "1", audioPath]);
    const transcript = await this.subtitleFactory().transcribeToSrt({ audioPath, outputDir: root, narrationLanguage: "en",
      cacheDir: path.join(os.tmpdir(), "recap-audit-asr", key.slice(0, 20)), timeoutMs: 600000, signal });
    const words = JSON.parse(await fs.readFile(transcript.wordTimestampsPath, "utf8"));
    const sourceSegments = (words.segments || []).map(segment => ({ start: Number((start + segment.start).toFixed(2)),
      end: Number((start + segment.end).toFixed(2)), text: segment.text }));
    const frames = [];
    for (let time = start; time < end; time += 2) {
      signal?.throwIfAborted();
      const index = frames.length, file = path.join(root, `frame-${String(index).padStart(3, "0")}.png`);
      try { await fs.access(file); } catch (_) {
        await this.media.runCommand(this.media.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(time),
          "-i", sourceVideoPath, "-vf", `scale=480:-2,drawtext=text='FRAME ${index} SOURCE ${time}s':fontcolor=white:box=1:boxcolor=black:fontsize=20:x=4:y=4`,
          "-frames:v", "1", "-threads", "1", file]);
      }
      frames.push({ index, sourceTime: time });
    }
    const sheets = [];
    for (let index = 0; index < Math.ceil(frames.length / 12); index++) {
      signal?.throwIfAborted();
      const file = path.join(root, `sheet-${index}.png`);
      await this.media.runCommand(this.media.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-start_number", String(index * 12),
        "-i", path.join(root, "frame-%03d.png"), "-vf", "tile=4x3", "-frames:v", "1", "-threads", "1", file]);
      sheets.push(file);
    }
    onProgress?.({ message: `Đang đối chiếu lại ${selected.length} mốc cảnh với ${frames.length} khung hình nguồn có thời gian chính xác...` });
    const schema = { type: "object", required: ["matches"], properties: { matches: { type: "array", items: {
      type: "object", required: ["event_id", "frame_index", "confidence"], properties: {
        event_id: { type: "string" }, frame_index: { type: "integer" }, confidence: { type: "number" }, verified_description: { type: "string" }
      } } } } };
    const result = await ai.runVertexCall({ filePaths: sheets, modelOverride: ai.getAnalysisModel(), signal, onProgress,
      responseSchema: schema, prompt: ["Audit incorrect source anchors using these actual source frames. Each frame has a code-controlled FRAME index and SOURCE time.",
        "For each supplied event, select the single FRAME index that clearly shows its described action. Return confidence 0..1. If unseen, return frame_index -1 and confidence 0. Do not estimate timestamps or choose a merely related scene.",
        "If an event mixes a visible action with unsupported details, locate only its genuinely visible component and return verified_description containing only what these frames and transcript support. Remove invented dialogue, screens or outcomes. Do not substitute an unrelated action. If nothing described is supported, return -1.",
        "For spoken revelations, use the time-stamped source transcript to locate the actual statement. A similar-looking office or character elsewhere is not evidence for that revelation.",
        `Actual source transcript in absolute seconds: ${JSON.stringify(sourceSegments)}`,
        `Events to locate: ${JSON.stringify(selected.map(event => ({ id: event.id, description: event.description })))}`,
        `Rendered-video issues: ${JSON.stringify(issues)}`].join("\n") });
    const matches = result.matches || [], seen = new Set(), updated = structuredClone(events);
    await fs.writeFile(path.join(root, "audit-response.json"), JSON.stringify({ sourceSegments, frames, matches }, null, 2));
    for (const match of matches) {
      if (!selected.some(event => event.id === match.event_id) || seen.has(match.event_id)) throw new Error("Kết quả đối chiếu mốc nguồn không hợp lệ.");
      seen.add(match.event_id);
      const frame = frames[match.frame_index];
      if (!Number.isInteger(match.frame_index) || !frame || !Number.isFinite(match.confidence) || match.confidence < .8 || match.confidence > 1)
        throw new Error(`Chưa xác minh được hình nguồn cho ${match.event_id}. Không giữ lại mốc cảnh đã bị review báo sai.`);
      const event = updated.find(event => event.id === match.event_id);
      const scene = scenes.find(scene => frame.sourceTime >= (scene.startSec ?? scene.start) && frame.sourceTime < (scene.endSec ?? scene.end));
      event.source_start = Math.max(0, scene?.startSec ?? scene?.start ?? frame.sourceTime - 1);
      event.source_end = Math.min(sourceDuration, scene?.endSec ?? scene?.end ?? frame.sourceTime + 2);
      event.duration = event.source_end - event.source_start;
      if (typeof match.verified_description === "string" && match.verified_description.trim()) {
        event.description = match.verified_description.trim();
      }
      event.anchorAudit = { version: 2, frameIndex: frame.index, sourceTime: frame.sourceTime, confidence: match.confidence };
    }
    if (seen.size !== selected.length) throw new Error("Đối chiếu mốc nguồn thiếu sự kiện cần sửa.");
    await fs.writeFile(path.join(root, "audit.json"), JSON.stringify({ sourceSegments, frames, matches, events: updated.filter(event => seen.has(event.id)) }, null, 2));
    return updated;
  }
}
module.exports = RecapAnchorAuditService;
