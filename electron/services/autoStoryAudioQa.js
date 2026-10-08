// Cheap signal-level QA: measured silence is evidence for the MP4 critic,
// not an automatic editorial rejection (intentional suspense can be quiet).
function parseSilences(log, durationSec = 0, minSeconds = 2.8) {
  const spans = [];
  let start = null;
  for (const line of String(log || '').split(/\r?\n/)) {
    const s = line.match(/silence_start:\s*([0-9.]+)/);
    if (s) start = Number(s[1]);
    const e = line.match(/silence_end:\s*([0-9.]+)/);
    if (e && Number.isFinite(start)) {
      const end = Number(e[1]);
      if (end - start >= minSeconds) spans.push({ startSec: start, endSec: end, durationSec: end - start });
      start = null;
    }
  }
  if (Number.isFinite(start) && durationSec > start && durationSec - start >= minSeconds)
    spans.push({ startSec: start, endSec: durationSec, durationSec: durationSec - start });
  return spans.map(s => ({ startSec: Math.round(s.startSec * 100) / 100,
    endSec: Math.round(s.endSec * 100) / 100, durationSec: Math.round(s.durationSec * 100) / 100 }));
}
async function detectSilence(ffmpeg, mp4Path, durationSec, { thresholdDb = -36, minSeconds = 2.8 } = {}) {
  if (!ffmpeg?.runDirect || !mp4Path) return { available: false, windows: [] };
  const db = Math.min(-15, Math.max(-70, Number(thresholdDb) || -36));
  const sec = Math.max(1.5, Number(minSeconds) || 2.8);
  try {
    const output = await ffmpeg.runDirect(ffmpeg.ffmpegPath, [
      '-hide_banner', '-nostats', '-i', mp4Path, '-vn',
      '-af', 'silencedetect=noise=' + db + 'dB:d=' + sec,
      '-f', 'null', '-'
    ], { captureStdout: false });
    return { available: true, thresholdDb: db, minSeconds: sec,
      windows: parseSilences(output, durationSec, sec) };
  } catch (e) {
    return { available: false, windows: [], warning: 'Audio QA unavailable: ' + e.message };
  }
}
module.exports = { parseSilences, detectSilence };
