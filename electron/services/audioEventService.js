// AutoStory v3 — Phase 2/3: non-speech audio events + word timestamps.
// Local, cheap, and defensive: any failure returns [] so the pipeline never
// breaks on a missing python/ffmpeg. Feeds story-model.audioEvents and tension.

const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

function resolvePython(service) {
  return (service && service.settings && (service.settings.pythonPath || service.settings.pythonBin)) || process.env.PYTHON || 'python';
}
function ffmpegPath(service) {
  return (service && service.ffmpeg && service.ffmpeg.ffmpegPath) || (service && service.settings && service.settings.ffmpegPath) || 'ffmpeg';
}

// Detect loudness spikes / sudden silences via the local python tool (ffmpeg
// ebur128). Returns [{type,startSec,endSec,peak}]. Never throws.
function detect(service, videoPath, durationSec, signal) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(Array.isArray(v) ? v : []); } };
    try {
      const script = path.join(__dirname, '..', '..', 'tools', 'audio_events.py');
      const args = [script, '--input', videoPath, '--ffmpeg', ffmpegPath(service)];
      if (Number.isFinite(durationSec)) args.push('--duration', String(durationSec));
      const proc = spawn(resolvePython(service), args, { signal });
      let out = '';
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.on('error', () => finish([]));
      proc.on('close', () => {
        try {
          const parsed = JSON.parse(out.trim() || '[]');
          finish(Array.isArray(parsed) ? parsed : (parsed.events || []));
        } catch (_) { finish([]); }
      });
    } catch (_) { finish([]); }
  });
}

// Best-effort load of word-level timestamps already produced by the ASR pipeline
// (faster_whisper_transcribe.py writes <transcript>.words.json). Returns a flat
// [{word,start,end,probability}]. Never throws.
async function loadWordTimestamps(project = {}) {
  const candidates = [];
  if (project.subtitleSourcePath) {
    candidates.push(project.subtitleSourcePath.replace(/\.[^.]+$/, '.words.json'));
    candidates.push(`${project.subtitleSourcePath}.words.json`);
  }
  if (project.sourceTranscriptPath) candidates.push(project.sourceTranscriptPath.replace(/\.[^.]+$/, '.words.json'));
  for (const file of candidates) {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      const segments = Array.isArray(data.segments) ? data.segments : [];
      const words = [];
      for (const s of segments) for (const w of (s.words || [])) {
        if (Number.isFinite(w.start) && Number.isFinite(w.end)) words.push({ word: w.word, start: w.start, end: w.end, probability: w.probability });
      }
      if (words.length) return words;
    } catch (_) { /* try next */ }
  }
  return [];
}

module.exports = { detect, loadWordTimestamps };
