const fs = require('fs/promises');
const path = require('path');
const { hash, range } = require('./autoStoryTimelineCompiler');
const { serial } = require('./autoStoryWorkQueue');
function merge(ranges, evidence, duration, padding = 0) {
  const sorted = ranges.map(r => { const t = range(r, evidence, duration); return { start: Math.max(0, t.start - padding), end: Math.min(duration, t.end + padding) }; }).sort((a,b) => a.start-b.start);
  const out = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r.start <= last.end + .01) last.end = Math.max(last.end, r.end); else out.push({ ...r });
  }
  return out;
}
async function prepare(service, project, cache, ranges, evidence, duration, cues = [], signal, padding = 0, fps = 8, onProgress) {
  const preparedEvidence = [];
  for (const r of merge(ranges, evidence, duration, padding)) {
    signal?.throwIfAborted();
    const id = `source-${hash({ r, clock: 2, fps })}`, file = path.join(cache, `${id}.mp4`);
    await serial(`source-media:${file}`, async () => {
      try { const m = await service.ffmpeg.probeVideo(file); if (Math.abs(m.duration - (r.end-r.start)) > .3) throw new Error('duration'); }
      catch (_) {
        const temp = `${file}.${process.pid}.tmp.mp4`;
        const started=Date.now();
        onProgress?.({stage:'source_media',message:`Chuẩn bị video nguồn ${r.start.toFixed(1)}-${r.end.toFixed(1)}s.`});
        const heartbeat=typeof onProgress==='function'?setInterval(()=>onProgress({stage:'source_media',heartbeat:true,message:`Đang chuẩn bị video nguồn ${r.start.toFixed(1)}-${r.end.toFixed(1)}s · ${Math.round((Date.now()-started)/1000)}s`}),12000):null;
        heartbeat?.unref?.();
        try {
          await service.ffmpeg.createAnalysisProxyChunk({ videoPath: project.sourceVideoPath, outputPath: temp,
            startSec: r.start, durationSec: r.end-r.start, width: 640, fps, sourceClock: true });
          const m = await service.ffmpeg.probeVideo(temp);
          if (Math.abs(m.duration - (r.end-r.start)) > .3) throw new Error('Evidence duration mismatch.');
          await fs.rename(temp, file);
        } finally { clearInterval(heartbeat); await fs.rm(temp, { force: true }).catch(() => {}); }
      }
    });
    preparedEvidence.push({ id, file, sourceStart: r.start, duration: r.end-r.start,
      transcript: cues.filter(c => c.endSec > r.start && c.startSec < r.end).map(c => ({ sourceStartSec: c.startSec, sourceEndSec: c.endSec, text: c.text })) });
  }
  return preparedEvidence;
}
// The model sees the source clock, not an offset conversion instruction.
function manifest(evidence) { return evidence.map(e => { const start = e.sourceStart ?? e.sourceStartSec; const end = start + (e.duration ?? (e.sourceEndSec - e.sourceStartSec)); return { file: e.file ? path.basename(e.file) : e.id, sourceStartSec: start, sourceEndSec: end, transcript: e.transcript }; }); }
module.exports = { prepare, manifest, merge };
