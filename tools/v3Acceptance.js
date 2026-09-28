#!/usr/bin/env node
// AutoStory V3 — acceptance verifier. Runs the 6 post-run assertion groups against a
// REAL product run's artifacts + the final MP4, and prints a single PASS/FAIL report
// with token telemetry, so a run is self-validating (no manual log reading).
//
// This does NOT fabricate anything: it only inspects what the product pipeline wrote.
// Do the real run first through the normal app (V3, 1 output, 65-90s, real Vertex/TTS/
// render), then point this at its output:
//
//   node tools/v3Acceptance.js \
//     --source-cache "D:\\Project\\...\\.cineviral\\auto-story-source\\<hash>\\source-contract-v3" \
//     --analysis     "D:\\Project\\...\\<project>\\analysis\\auto-story-fast" \
//     --mp4          "D:\\Project\\...\\<final-draft>.mp4" \
//     [--min 65 --max 90 --limit 16 --width 1080 --height 1920]
//
// Exit code 0 = E2E PASSED, 1 = E2E FAILED (with the exact failing checks).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const A = require('./v3AcceptanceAssertions.js');

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function listJson(dir, suffix) {
  try { return fs.readdirSync(dir).filter(f => f.endsWith(suffix)).map(f => ({ key: f.replace(suffix, ''), ...(readJson(path.join(dir, f)) || {}) })); }
  catch (_) { return []; }
}
function firstScriptId(analysisDir) {
  try { const f = fs.readdirSync(analysisDir).find(n => /^beat-casting-\d+\.json$/.test(n)); return f ? f.match(/(\d+)/)[1] : '1'; } catch (_) { return '1'; }
}

function ffprobe(mp4) {
  if (!mp4 || !fs.existsSync(mp4)) return { ok: false, bytes: 0, durationSec: 0, streams: [] };
  const bytes = fs.statSync(mp4).size;
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', mp4], { encoding: 'utf8' });
    const j = JSON.parse(out);
    const streams = (j.streams || []).map(s => ({ type: s.codec_type, codec: s.codec_name, width: s.width, height: s.height }));
    const durationSec = Number(j.format?.duration) || streams.reduce((m, s) => Math.max(m, Number(s.duration) || 0), 0);
    return { ok: true, bytes, durationSec, streams };
  } catch (e) { return { ok: false, bytes, durationSec: 0, streams: [], error: String(e.message || e).slice(0, 200) }; }
}

function main() {
  const sourceCache = arg('source-cache'), analysis = arg('analysis'), mp4 = arg('mp4');
  const minSec = Number(arg('min', 65)), maxSec = Number(arg('max', 90));
  const requestLimit = Number(arg('limit', 16));
  const expectWidth = Number(arg('width', 1080)), expectHeight = Number(arg('height', 1920));
  if (!sourceCache || !analysis) { console.error('Usage: node tools/v3Acceptance.js --source-cache <dir> --analysis <dir> --mp4 <path> [--min --max --limit --width --height]'); process.exit(2); }

  const model = readJson(path.join(sourceCache, 'story-model.json'));
  const coverage = readJson(path.join(sourceCache, 'chunk-coverage.json')); // absent for staged success
  const design = readJson(path.join(analysis, 'story-spine.json'));
  const sid = firstScriptId(analysis);
  const casting = readJson(path.join(analysis, `beat-casting-${sid}.json`));
  const editorial = readJson(path.join(analysis, `editorial-metrics-${sid}.json`));
  const script = readJson(path.join(analysis, `script-${sid}.json`));
  const segments = script?.segments || [];

  // Telemetry + runtime signals from per-call metadata/errors in both dirs.
  const metas = [...listJson(sourceCache, '-request-metadata.json'), ...listJson(analysis, '-request-metadata.json')]
    .map(m => ({ key: m.key, finishReason: m.finishReason || '', usage: m.usage || {}, requestedMaxOutputTokens: m.requestedMaxOutputTokens, requestedThinkingBudget: m.requestedThinkingBudget }));
  const errors = [...listJson(sourceCache, '-error.json'), ...listJson(analysis, '-error.json')].map(e => ({ key: e.key, message: e.message || '' }));

  const compiledDuration = segments.reduce((n, s) => n + Math.max(0, Number(s.sourceEndSec ?? s.end) - Number(s.sourceStartSec ?? s.start)), 0);
  const probe = ffprobe(mp4);
  const wps = editorial?.metrics?.measuredWordsPerSecond;

  const result = A.evaluate({
    sourceModel: { model, coverage },
    aiRuntime: { requestMetadatas: metas, errors, requestLimit },
    story: { design, beats: casting?.beats || [], model: model || {} },
    narration: { segments, wordsPerSecond: wps },
    duration: { segments, editorial, minSec, maxSec },
    render: { mp4Path: mp4, probe, expectedDurationSec: compiledDuration, expectWidth, expectHeight }
  });

  // ---- report ----
  console.log('\n=== AutoStory V3 — Acceptance Report ===');
  console.log(`source cache : ${sourceCache}`);
  console.log(`analysis dir : ${analysis}`);
  console.log(`final mp4    : ${mp4 || '(none provided)'}`);
  if (model) console.log(`source model : ${model.events?.length} events, ${model.quotes?.length} quotes, modelVersion=${model.modelVersion}`);
  if (coverage) console.log(`chunk strategy=${coverage.mode} reason=${coverage.strategyReason} windows=${coverage.plannedInitialWindows} coverageRatio=${coverage.coverageRatio} maxSplitDepth=${coverage.maxSplitDepth}`);
  else console.log('chunk strategy: staged whole/compact success (no chunk-coverage.json)');
  console.log(`compiled timeline: ${compiledDuration.toFixed(1)}s   final mp4: ${probe.durationSec}s (${probe.streams.map(s => s.type).join('+') || 'no streams'})`);

  console.log('\n-- token telemetry (per Source Model call) --');
  for (const m of metas) {
    const u = m.usage || {};
    console.log(`  ${m.key}: finishReason=${m.finishReason} maxOut=${m.requestedMaxOutputTokens} thinkBudget=${m.requestedThinkingBudget} prompt=${u.promptTokenCount ?? '?'} candidates=${u.candidatesTokenCount ?? '?'} thoughts=${u.thoughtsTokenCount ?? '?'} total=${u.totalTokenCount ?? '?'}`);
  }
  if (!metas.length) console.log('  (no *-request-metadata.json found — was this a cache-hit run?)');

  console.log('\n-- checks --');
  for (const c of result.checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  [${c.group}] ${c.name}${c.detail ? `  (${c.detail})` : ''}`);

  console.log(`\n=== ${result.passed ? 'E2E PASSED — all ' + result.total + ' checks green' : `E2E FAILED — ${result.failedCount}/${result.total} checks failed`} ===`);
  if (!result.passed) { console.log('First failing stage/cause:'); const f = result.failed[0]; console.log(`  [${f.group}] ${f.name} — ${f.detail}`); }
  process.exit(result.passed ? 0 : 1);
}

main();
