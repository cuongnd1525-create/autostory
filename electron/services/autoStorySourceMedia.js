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
  const merged = merge(ranges, evidence, duration, padding);
  // Seconds of source to prepare in this call and seconds done: the run progress uses them as the
  // real fraction of the media preparation (ffmpeg time=), instead of a guess.
  const mediaTotalSec = merged.reduce((sum, r) => sum + (r.end - r.start), 0);
  let mediaDoneSec = 0;
  for (const r of merged) {
    signal?.throwIfAborted();
    const id = `source-${hash({ r, clock: 2, fps })}`, file = path.join(cache, `${id}.mp4`);
    await serial(`source-media:${file}`, async () => {
      try { const m = await service.ffmpeg.probeVideo(file); if (Math.abs(m.duration - (r.end-r.start)) > .3) throw new Error('duration'); }
      catch (_) {
        const temp = `${file}.${process.pid}.tmp.mp4`;
        const started=Date.now();
        onProgress?.({stage:'source_media',message:`Chuẩn bị video nguồn ${r.start.toFixed(1)}-${r.end.toFixed(1)}s.`});
        let rangeDoneSec=0;
        const heartbeat=typeof onProgress==='function'?setInterval(()=>onProgress({stage:'source_media',heartbeat:true,mediaDoneSec:mediaDoneSec+rangeDoneSec,mediaTotalSec,message:`Đang chuẩn bị video nguồn ${r.start.toFixed(1)}-${r.end.toFixed(1)}s · ${Math.round((Date.now()-started)/1000)}s`}),12000):null;
        heartbeat?.unref?.();
        let lastReportAt=0;
        const ffmpegProgress=typeof onProgress==='function'?(p=>{
          rangeDoneSec=Math.min(r.end-r.start,Math.max(rangeDoneSec,Number(p?.currentSec)||0));
          if(Date.now()-lastReportAt<2000)return;
          lastReportAt=Date.now();
          onProgress({stage:'source_media',heartbeat:true,mediaDoneSec:mediaDoneSec+rangeDoneSec,mediaTotalSec,
            message:`Đang chuẩn bị video nguồn ${r.start.toFixed(1)}-${r.end.toFixed(1)}s · ${Math.round(((mediaDoneSec+rangeDoneSec)/Math.max(.001,mediaTotalSec))*100)}%`});
        }):null;
        try {
          await service.ffmpeg.createAnalysisProxyChunk({ videoPath: project.sourceVideoPath, outputPath: temp,
            startSec: r.start, durationSec: r.end-r.start, width: 640, fps, sourceClock: true, onProgress: ffmpegProgress });
          const m = await service.ffmpeg.probeVideo(temp);
          if (Math.abs(m.duration - (r.end-r.start)) > .3) throw new Error('Evidence duration mismatch.');
          await fs.rename(temp, file);
        } finally { clearInterval(heartbeat); await fs.rm(temp, { force: true }).catch(() => {}); }
      }
    });
    mediaDoneSec += r.end - r.start;
    onProgress?.({ stage: 'source_media', heartbeat: true, mediaDoneSec, mediaTotalSec, message: `Chuẩn bị video nguồn xong ${r.start.toFixed(1)}-${r.end.toFixed(1)}s.` });
    preparedEvidence.push({ id, file, sourceStart: r.start, duration: r.end-r.start,
      transcript: cues.filter(c => c.endSec > r.start && c.startSec < r.end).map(c => ({ sourceStartSec: c.startSec, sourceEndSec: c.endSec, text: c.text })) });
  }
  return preparedEvidence;
}
// The model sees the source clock, not an offset conversion instruction.
function manifest(evidence) { return evidence.map(e => {
  // Composite reel (several source ranges in one file): expose the exact
  // reel-time -> source-time mapping per segment instead of a single range.
  if (Array.isArray(e.segments) && e.composite) return { file: e.file ? path.basename(e.file) : e.id, composite: true, reelDurationSec: e.duration,
    sourceClockBurned: e.sourceClockBurned !== false, segments: e.segments, transcript: e.transcript };
  const start = e.sourceStart ?? e.sourceStartSec; const end = start + (e.duration ?? (e.sourceEndSec - e.sourceStartSec)); return { file: e.file ? path.basename(e.file) : e.id, sourceStartSec: start, sourceEndSec: end, transcript: e.transcript }; }); }
module.exports = { prepare, manifest, merge };
