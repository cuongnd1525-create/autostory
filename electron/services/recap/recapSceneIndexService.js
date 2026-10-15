const fs = require("fs/promises"), path = require("path");
const { fingerprint } = require("./recapEditorialService");
const { validateVisualEvent, validateChunkTimeline } = require("./recapTypes");
class RecapSceneIndexService {
  constructor(media) { this.media = media; }
  async prepare({ proxyPath, chunkPath, chunk, scenes, directory, signal }) {
    const stat = await fs.stat(proxyPath);
    const key = fingerprint({ version: 2, proxyPath, size: stat.size, modified: stat.mtimeMs, chunk, scenes });
    const root = path.join(directory, key.slice(0, 16)); await fs.mkdir(root, { recursive: true });
    const entries = scenes.filter(scene => scene.endSec > chunk.sourceStartSec && scene.startSec < chunk.sourceEndSec).flatMap((scene, index) => {
      const start = Math.max(scene.startSec, chunk.sourceStartSec), end = Math.min(scene.endSec, chunk.sourceEndSec);
      const count = Math.max(1, Math.ceil((end - start) / 6)), length = (end - start) / count;
      return Array.from({ length: count }, (_, part) => ({ scene_id: `${scene.sceneId || `scene_${index}`}_p${part + 1}`,
        source_start: start + part * length, source_end: start + (part + 1) * length,
        source_time: start + (part + .5) * length }));
    });
    if (!entries.length) throw new Error("Không có cảnh đã xác định thời gian để lập chỉ mục nguồn.");
    for (let index = 0; index < entries.length; index++) {
      signal?.throwIfAborted();
      const entry = entries[index], file = path.join(root, `frame-${String(index).padStart(3, "0")}.png`);
      try { await fs.access(file); } catch (_) {
        await this.media.runCommand(this.media.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(entry.source_time),
          "-i", proxyPath, "-vf", `scale=480:-2,drawtext=text='${entry.scene_id} ${entry.source_time.toFixed(2)}s':fontcolor=white:box=1:boxcolor=black:fontsize=20:x=4:y=4`,
          "-frames:v", "1", "-threads", "1", file]);
      }
    }
    const filePaths = [];
    for (let index = 0; index < Math.ceil(entries.length / 12); index++) {
      signal?.throwIfAborted();
      const file = path.join(root, `sheet-${index}.png`);
      await this.media.runCommand(this.media.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-start_number", String(index * 12),
        "-i", path.join(root, "frame-%03d.png"), "-vf", "tile=4x3", "-frames:v", "1", "-threads", "1", file]);
      filePaths.push(file);
    }
    const metadata = await this.media.probeVideo(chunkPath);
    if (metadata.hasAudio) {
      const audio = path.join(root, "source.wav");
      await this.media.runCommand(this.media.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-i", chunkPath,
        "-vn", "-ar", "16000", "-ac", "1", audio]); filePaths.push(audio);
    }
    await fs.writeFile(path.join(root, "index.json"), JSON.stringify({ entries, filePaths }, null, 2));
    return { entries, filePaths };
  }
  static compile(raw, index, chunk) {
    const byId = new Map(index.entries.map((entry, position) => [entry.scene_id, { ...entry, position }]));
    if (!Array.isArray(raw.events) || !raw.events.length) throw Object.assign(new Error("Chỉ mục cảnh không có sự kiện hợp lệ."), { kind: "invalid_json" });
    const events = raw.events.filter(event => event.content_kind !== "outro").map((event, position) => {
      const ids = [...new Set(event.scene_ids || [])], references = ids.map(id => byId.get(id));
      if (!references.length || references.some(entry => !entry)) throw Object.assign(new Error("AI chọn ID cảnh không có trong khung hình nguồn."), { kind: "invalid_json" });
      references.sort((a, b) => a.position - b.position);
      if (references.some((entry, i) => i > 0 && entry.position !== references[i - 1].position + 1))
        throw Object.assign(new Error("Sự kiện AI ghép các cảnh không liên tiếp."), { kind: "invalid_json" });
      if (references.at(-1).source_end - references[0].source_start > 24)
        throw Object.assign(new Error("Sự kiện ghép quá 24 giây; phải tách các hành động và loại outro khỏi cốt truyện."), { kind: "invalid_json" });
      const anchor = references.find(entry => entry.scene_id === event.anchor_scene_id) || references[0];
      if (event.anchor_scene_id && !references.some(entry => entry.scene_id === event.anchor_scene_id))
        throw Object.assign(new Error("Cảnh neo chính không nằm trong sự kiện đã chọn."), { kind: "invalid_json" });
      return { ...validateVisualEvent({ ...event, id: `chunk_${chunk.chunkIndex}_scene_event_${position + 1}`,
        scene_id: references[0].scene_id, source_start: Math.max(references[0].source_start,
          typeof anchor.source_time === "number" ? anchor.source_time - .8 : references[0].source_start), source_end: references.at(-1).source_end }),
        anchorMethod: "scene_frames", anchorSceneIds: references.map(entry => entry.scene_id) };
    });
    if (!events.length) throw Object.assign(new Error("Đoạn nguồn chỉ chứa outro, chưa có hành động cốt truyện."), { kind: "invalid_json" });
    events.sort((a, b) => a.source_start - b.source_start);
    validateChunkTimeline(events, chunk);
    return { ...raw, events, timestamp_mode: "absolute" };
  }
}
module.exports = RecapSceneIndexService;
