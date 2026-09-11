const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

// Reels are transport only. Editorial offsets always remain local to evidenceId.
async function pack(ffmpeg, evidence, story, root, signal, detailOnly = false, detailFps = 4) {
  const detailIds = new Set([...(story.detailUnitIds || []), ...(story.hookCandidates || []).flatMap(c => c.sourceUnitIds)]);
  const base = detailOnly ? [] : evidence.map(e => ({ e, start: 0, end: e.duration }));
  const details = [];
  for (const e of evidence) {
    for (const u of [...(e.sourceUnits || [])].sort((a, b) => a.start - b.start)) {
      if (!detailIds.has(u.id)) continue;
      const start = Math.max(0, u.start - e.sourceStart - 1);
      const end = Math.min(e.duration, u.end - e.sourceStart + 1);
      const last = details.at(-1);
      if (last?.e.id === e.id && start <= last.end) last.end = Math.max(last.end, end);
      else if (end > start) details.push({ e, start, end });
    }
  }
  const filePaths = [], videoFpsByPath = {}, locations = new Map(evidence.map(e => [e.id, []]));
  for (const [kind, views, fps] of [["overview", base, 1], ["detail", details, detailFps]]) {
    if (!views.length) continue;
    signal?.throwIfAborted();
    const identity = await Promise.all(views.map(async v => {
      const stat = await fs.stat(v.e.file);
      return [v.e.file, stat.size, stat.mtimeMs, v.start, v.end];
    }));
    const key = crypto.createHash("sha256").update(JSON.stringify(["reel-v1", kind, identity])).digest("hex").slice(0, 24);
    const file = path.join(root, `${kind}-${key}.mp4`);
    let offset = 0;
    const entries = views.map(v => {
      const duration = Math.ceil((v.end - v.start) * 8) / 8;
      const entry = { file: v.e.file, start: v.start, end: v.end, duration };
      locations.get(v.e.id).push({ file: path.basename(file), kind, reelStart: offset,
        reelEnd: offset + v.end - v.start, clipStart: v.start, clipEnd: v.end });
      offset += duration;
      return entry;
    });
    try {
      const m = await ffmpeg.probeVideo(file);
      if (Math.abs(m.duration - offset) > 0.15) throw new Error("stale reel");
    } catch (_) {
      await ffmpeg.createAutoStoryEvidenceReel(entries, file);
      const m = await ffmpeg.probeVideo(file);
      if (Math.abs(m.duration - offset) > 0.15) throw new Error("Evidence reel duration does not match timestamp map.");
    }
    filePaths.push(file); videoFpsByPath[file] = fps;
  }
  return { filePaths, videoFpsByPath, evidence: evidence.map(e => ({ ...e, mediaLocations: locations.get(e.id) })) };
}
// Preserve clip-local coordinates while sending only selected ranges and nearby context.
async function packSelected(ffmpeg, evidence, script, story, root, signal, { padding = 4, candidates = true, targetId = null } = {}) {
  const selected = targetId ? script.segments.filter(s => s.id === targetId) : script.segments;
  const input = evidence.map(e => {
    const ranges = selected.filter(s => s.evidenceId === e.id).map(s => ({ start: Math.max(0, s.start - padding), end: Math.min(e.duration, s.end + padding) }));
    if (candidates) for (const id of (story.hookCandidates || []).flatMap(c => c.sourceUnitIds || [])) {
      const u = e.sourceUnits?.find(u => u.id === id);
      if (u) ranges.push({ start: Math.max(0, u.start - e.sourceStart - padding), end: Math.min(e.duration, u.end - e.sourceStart + padding) });
    }
    ranges.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const r of ranges) {
      const last = merged.at(-1);
      if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
      else if (r.end > r.start) merged.push({ ...r });
    }
    return { ...e, sourceUnits: merged.map((r, i) => ({ id: `${e.id}-focus-${i}`, start: e.sourceStart + r.start, end: e.sourceStart + r.end })) };
  });
  const packed = await pack(ffmpeg, input, { detailUnitIds: input.flatMap(e => e.sourceUnits.map(u => u.id)) }, root, signal, true, 1);
  const critical = new Set(story.detailUnitIds || []);
  const highInput = evidence.map(e => ({ ...e, sourceUnits: [
    ...(e.sourceUnits || []).filter(u => critical.has(u.id) && selected.some(s => s.evidenceId === e.id && e.sourceStart + s.start < u.end && e.sourceStart + s.end > u.start)),
    ...selected.filter(s => s.evidenceId === e.id && /^(hook|climax)$/i.test(s.storyRole)).map(s => ({ id: `critical-${s.id}`, start: e.sourceStart + s.start, end: e.sourceStart + s.end }))
  ] }));
  const high = await pack(ffmpeg, highInput, { detailUnitIds: highInput.flatMap(e => e.sourceUnits.map(u => u.id)) }, root, signal, true, 4);
  packed.filePaths = [...new Set([...packed.filePaths, ...high.filePaths])];
  packed.videoFpsByPath = { ...packed.videoFpsByPath, ...high.videoFpsByPath };
  return { ...packed, evidence: evidence.map(e => {
    const mediaLocations = [...packed.evidence.find(p => p.id === e.id).mediaLocations, ...high.evidence.find(p => p.id === e.id).mediaLocations];
    return { ...e, mediaLocations, transcript: (e.transcript || []).filter(c => mediaLocations.some(l => c.start < l.clipEnd && c.end > l.clipStart)) };
  }) };
}
function assertSelectedChanges(script, previous, evidence) {
  for (const s of script.segments) {
    const old = previous.segments.find(p => p.id === s.id);
    if (old && ["evidenceId", "start", "end", "audioMode", "voiceoverText"].every(k => old[k] === s[k])) continue;
    const locations = evidence.find(e => e.id === s.evidenceId)?.mediaLocations || [];
    if (!locations.some(l => s.start >= l.clipStart - 0.01 && s.end <= l.clipEnd + 0.01)) {
      throw new Error(`${s.id}: bản sửa chọn vùng chưa được gửi để kiểm chứng; cần mở rộng bằng chứng trước, không đoán cảnh.`);
    }
  }
}
module.exports = { pack, packSelected, assertSelectedChanges };
