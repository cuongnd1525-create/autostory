// AutoStory — SCOPE REEL PACKER (media transport layer for the Editorial Director).
//
// Separates two things that must never be coupled:
//   - LOGICAL scope windows: editorial candidate regions chosen by Gemini in the
//     Story Scope. Their number and breadth are an editorial matter.
//   - MEDIA reel files: the video files actually sent to Gemini in ONE director
//     request. Their number is bounded by the provider (videos per prompt).
//
// Pipeline (all deterministic, no story judgment):
//   1. one MEDIA SEGMENT per logical window (+ context padding, never overlapping a
//      neighbour's segment, so no footage is sent twice);
//   2. if the segments exceed the reel-duration budget, broad windows are COMPACTED
//      for media only: kept around the Source Story Model events/quotes and scope
//      anchors inside them (plus the window's head and tail for context). The logical
//      window itself is untouched;
//   3. segments are PACKED, in source order, into <= maxReelFiles composite reel
//      files. Several distant windows may share a file; each keeps its own manifest
//      rows (reelFile, reelStartSec, reelEndSec, sourceStartSec, sourceEndSec,
//      scopeWindowId, purposes), so any reel time maps back to exact source time.

const crypto = require('crypto');
const path = require('path');

// Provider transport limit: Gemini video models accept at most 10 video files in
// one prompt. This bounds REEL FILES only — never the number of scope windows.
const PROVIDER_MAX_VIDEO_FILES = 10;
const DEFAULT_MAX_REEL_SEC = 360;         // existing cost budget for the director reel
const DEFAULT_PADDING_SEC = 2;            // context around each logical window
const COMPACT_MIN_WINDOW_SEC = 30;        // windows shorter than this are always sent whole
const ANCHOR_CONTEXT_SEC = 3;             // context kept around each anchor in a compacted window
const EDGE_CONTEXT_SEC = 6;               // head/tail of a compacted window kept for continuity
const EPS = 0.01;

const num = v => (Number.isFinite(Number(v)) ? Number(v) : NaN);
const round2 = n => Math.round(n * 100) / 100;
const windowPurposes = w => [...new Set([...(Array.isArray(w?.purposes) ? w.purposes : []), ...(w?.purpose ? [w.purpose] : [])])];

function mergeIntervals(list) {
  const sorted = list.filter(r => r[1] - r[0] > EPS).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + EPS) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}
const sumIntervals = list => list.reduce((n, r) => n + (r[1] - r[0]), 0);

// Logical windows as { windowId, startSec, endSec, purposes } in source order.
function logicalWindows(scope) {
  return (scope?.scopeWindows || [])
    .map((w, i) => ({ windowId: String(w.windowId || `w${i + 1}`), startSec: num(w.startSec), endSec: num(w.endSec), purposes: windowPurposes(w) }))
    .filter(w => Number.isFinite(w.startSec) && Number.isFinite(w.endSec) && w.endSec > w.startSec)
    .sort((a, b) => a.startSec - b.startSec);
}

// Anchors inside a window: model events/quotes and scope references that are
// strictly narrower than the window (an event spanning the whole window says
// nothing about where inside it the moments are).
function anchorsFor(win, { model, scope }) {
  const len = win.endSec - win.startSec;
  const refs = [
    ...(model?.events || []).map(e => [num(e.startSec), num(e.endSec)]),
    ...(model?.quotes || []).map(q => [num(q.startSec), num(q.endSec)]),
    ...(scope?.causalSpine || []).map(n => [num(n.sourceStartSec), num(n.sourceEndSec)]),
    ...(scope?.candidateEndingEvents || []).map(n => [num(n.sourceStartSec), num(n.sourceEndSec)]),
    ...(scope?.hookCandidates || []).map(n => [num(n.sourceStartSec), num(n.sourceEndSec)]),
    ...(scope?.scopeWindows || []).flatMap(w => (w.purposeRanges || []).map(p => [num(p.startSec), num(p.endSec)]))
  ];
  return refs
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s && (e - s) < len * 0.9)
    .map(([s, e]) => [Math.max(win.startSec, s), Math.min(win.endSec, e)])
    .filter(([s, e]) => e - s > EPS);
}

// Media-only compaction of one broad window: head + anchors (+context) + tail.
function compactWindow(win, ctx) {
  const anchors = anchorsFor(win, ctx).map(([s, e]) => [Math.max(win.startSec, s - ANCHOR_CONTEXT_SEC), Math.min(win.endSec, e + ANCHOR_CONTEXT_SEC)]);
  const head = [win.startSec, Math.min(win.endSec, win.startSec + EDGE_CONTEXT_SEC)];
  const tail = [Math.max(win.startSec, win.endSec - EDGE_CONTEXT_SEC), win.endSec];
  let parts = mergeIntervals([head, ...anchors, tail]);
  if (!anchors.length) {
    // No finer-grained structure known: evenly spaced samples keep the window
    // observable without sending all of it.
    const n = Math.max(1, Math.floor((win.endSec - win.startSec) / 30));
    const samples = Array.from({ length: n }, (_, i) => {
      const c = win.startSec + ((i + 1) * (win.endSec - win.startSec)) / (n + 1);
      return [Math.max(win.startSec, c - 4), Math.min(win.endSec, c + 4)];
    });
    parts = mergeIntervals([head, ...samples, tail]);
  }
  return parts;
}

// Step 1+2: media segments (with compaction when over the reel budget).
function planMediaSegments(scope, { durationSec = Infinity, paddingSec = DEFAULT_PADDING_SEC, maxReelSec = DEFAULT_MAX_REEL_SEC, model = null } = {}) {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Infinity;
  const wins = logicalWindows(scope);
  // Padding never makes two windows' media overlap: split the gap at its midpoint.
  const bounds = wins.map((w, i) => {
    const prev = wins[i - 1], next = wins[i + 1];
    const lo = prev ? Math.max(w.startSec - paddingSec, (prev.endSec + w.startSec) / 2, prev.endSec) : Math.max(0, w.startSec - paddingSec);
    const hi = next ? Math.min(w.endSec + paddingSec, (w.endSec + next.startSec) / 2, next.startSec) : Math.min(dur, w.endSec + paddingSec);
    return [Math.max(0, Math.min(lo, w.startSec)), Math.min(dur, Math.max(hi, w.endSec))];
  });
  const plan = wins.map((w, i) => ({ win: w, pad: bounds[i], parts: [[w.startSec, w.endSec]], compacted: false }));
  const total = () => plan.reduce((n, p) => n + mediaSec(p), 0);
  const ctx = { model, scope };
  // Compact the broadest eligible windows first until the budget holds.
  const eligible = plan.filter(p => p.win.endSec - p.win.startSec >= COMPACT_MIN_WINDOW_SEC)
    .sort((a, b) => (b.win.endSec - b.win.startSec) - (a.win.endSec - a.win.startSec));
  for (const p of eligible) {
    if (total() <= maxReelSec + EPS) break;
    const parts = compactWindow(p.win, ctx);
    if (sumIntervals(parts) < (p.win.endSec - p.win.startSec) - EPS) { p.parts = parts; p.compacted = true; }
  }
  const segments = [];
  for (const p of plan) {
    p.parts.forEach(([s, e], k) => {
      const first = k === 0, last = k === p.parts.length - 1;
      // Context padding only on the outer edges of a window's media.
      const ms = first ? Math.min(s, p.pad[0]) : s;
      const me = last ? Math.max(e, p.pad[1]) : e;
      segments.push({
        segmentId: `${p.win.windowId}${p.parts.length > 1 ? `_p${k + 1}` : ''}`,
        scopeWindowId: p.win.windowId, purposes: p.win.purposes,
        sourceStartSec: round2(ms), sourceEndSec: round2(me),
        windowStartSec: p.win.startSec, windowEndSec: p.win.endSec,
        compacted: p.compacted
      });
    });
  }
  return {
    segments,
    logicalWindowCount: wins.length,
    logicalFootageSec: round2(sumIntervals(mergeIntervals(wins.map(w => [w.startSec, w.endSec])))),
    mediaSec: round2(segments.reduce((n, s) => n + (s.sourceEndSec - s.sourceStartSec), 0)),
    compactedWindowIds: plan.filter(p => p.compacted).map(p => p.win.windowId),
    withinBudget: total() <= maxReelSec + EPS,
    maxReelSec
  };
  function mediaSec(p) {
    return p.parts.reduce((n, [s, e], k) => n + ((k === p.parts.length - 1 ? Math.max(e, p.pad[1]) : e) - (k === 0 ? Math.min(s, p.pad[0]) : s)), 0);
  }
}

// Step 3: pack segments (source order) into <= maxFiles composite reel files.
function packSegments(segments, { maxFiles = PROVIDER_MAX_VIDEO_FILES } = {}) {
  const sorted = [...segments].sort((a, b) => a.sourceStartSec - b.sourceStartSec);
  const n = sorted.length;
  const k = Math.max(1, Math.min(n, maxFiles));
  const files = [];
  let idx = 0;
  for (let f = 0; f < k; f++) {
    const size = Math.floor(n / k) + (f < n % k ? 1 : 0);
    const group = sorted.slice(idx, idx + size); idx += size;
    let cursor = 0;
    const reelId = `reel_${String(f + 1).padStart(2, '0')}`;
    const segs = group.map(s => {
      const d = round2(s.sourceEndSec - s.sourceStartSec);
      const row = { ...s, reelFile: reelId, reelStartSec: round2(cursor), reelEndSec: round2(cursor + d) };
      cursor += d;
      return row;
    });
    files.push({ reelId, segments: segs, durationSec: round2(cursor) });
  }
  return files.filter(f => f.segments.length);
}

// Full reel plan: segments + files + flat manifest.
function planReel(scope, opts = {}) {
  const maxFiles = opts.maxReelFiles || PROVIDER_MAX_VIDEO_FILES;
  const media = planMediaSegments(scope, opts);
  const files = packSegments(media.segments, { maxFiles });
  const manifest = files.flatMap(f => f.segments.map(s => ({
    reelFile: f.reelId, reelStartSec: s.reelStartSec, reelEndSec: s.reelEndSec,
    sourceStartSec: s.sourceStartSec, sourceEndSec: s.sourceEndSec,
    scopeWindowId: s.scopeWindowId, purposes: s.purposes, segmentId: s.segmentId, compacted: s.compacted,
    windowStartSec: s.windowStartSec, windowEndSec: s.windowEndSec
  })));
  return {
    contract: 'scope-reel-packed-v1',
    storyScopeId: scope?.storyScopeId || null,
    paddingSec: opts.paddingSec ?? DEFAULT_PADDING_SEC,
    // `ranges` = media segments in source order (absolute source time).
    ranges: manifest.map(m => ({ ...m })).sort((a, b) => a.sourceStartSec - b.sourceStartSec),
    files: files.map(f => ({ reelId: f.reelId, durationSec: f.durationSec, segmentCount: f.segments.length })),
    manifest,
    fileCount: files.length,
    maxReelFiles: maxFiles,
    totalSec: media.mediaSec,
    logicalWindowCount: media.logicalWindowCount,
    logicalFootageSec: media.logicalFootageSec,
    compactedWindowIds: media.compactedWindowIds,
    withinBudget: media.withinBudget,
    maxReelSec: media.maxReelSec
  };
}

// Map a reel-file time back to absolute source time (and the logical window).
function reelToSource(reel, reelFile, reelSec) {
  const row = (reel?.manifest || []).find(m => m.reelFile === reelFile && reelSec >= m.reelStartSec - EPS && reelSec <= m.reelEndSec + EPS);
  if (!row) return null;
  return { sourceSec: round2(row.sourceStartSec + (reelSec - row.reelStartSec)), scopeWindowId: row.scopeWindowId, segmentId: row.segmentId };
}

// Build the composite reel files (cached by content hash) and return evidence
// items carrying their segment mapping. One provider file per reel file.
async function buildReelFiles(engine, reel, { fps = 4, width = 640 } = {}) {
  const maxFiles = reel.maxReelFiles || PROVIDER_MAX_VIDEO_FILES;
  if (reel.fileCount > maxFiles) throw new Error(`Scope reel packs into ${reel.fileCount} files; the provider limit is ${maxFiles}.`);
  const ffmpeg = engine.service?.ffmpeg;
  const videoPath = engine.project?.sourceVideoPath;
  const cues = engine.cues || [];
  const out = [];
  for (const f of reel.files) {
    const segs = reel.manifest.filter(m => m.reelFile === f.reelId);
    const key = crypto.createHash('sha256').update(JSON.stringify({ v: 1, fps, width, segs: segs.map(s => [s.sourceStartSec, s.sourceEndSec]) })).digest('hex').slice(0, 16);
    const file = path.join(engine.cache, `scope-reel-${key}.mp4`);
    let ok = false;
    try { const m = await ffmpeg.probeVideo(file); ok = Math.abs(m.duration - f.durationSec) <= 0.5; } catch (_) { ok = false; }
    let clock = true;
    if (!ok) {
      const temp = `${file}.${process.pid}.tmp.mp4`;
      const entries = segs.map(s => ({ sourceStartSec: s.sourceStartSec, sourceEndSec: s.sourceEndSec }));
      clock = await ffmpeg.createScopeReel({ videoPath, entries, outputPath: temp, fps, width });
      const m = await ffmpeg.probeVideo(temp);
      if (Math.abs(m.duration - f.durationSec) > 0.5) throw new Error(`Scope reel ${f.reelId} duration ${m.duration}s != planned ${f.durationSec}s.`);
      await require('fs/promises').rename(temp, file);
    }
    out.push({
      id: `scope-${f.reelId}-${key}`, file, reelId: f.reelId, composite: true, sourceClockBurned: clock !== false,
      duration: f.durationSec,
      segments: segs.map(s => ({ reelStartSec: s.reelStartSec, reelEndSec: s.reelEndSec, sourceStartSec: s.sourceStartSec, sourceEndSec: s.sourceEndSec, scopeWindowId: s.scopeWindowId, purposes: s.purposes, windowStartSec: s.windowStartSec, windowEndSec: s.windowEndSec })),
      transcript: cues.filter(c => segs.some(s => c.endSec > s.sourceStartSec && c.startSec < s.sourceEndSec))
        .map(c => ({ sourceStartSec: c.startSec, sourceEndSec: c.endSec, text: c.text }))
    });
  }
  return out;
}

module.exports = {
  PROVIDER_MAX_VIDEO_FILES, DEFAULT_MAX_REEL_SEC, DEFAULT_PADDING_SEC, COMPACT_MIN_WINDOW_SEC,
  logicalWindows, anchorsFor, compactWindow, planMediaSegments, packSegments, planReel, reelToSource, buildReelFiles, mergeIntervals
};
