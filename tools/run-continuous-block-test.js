#!/usr/bin/env node
/*
 * AutoStory V5 — CONTINUOUS NARRATED BLOCK render diagnostic.
 *
 * Repeats the Antigravity narrated-block capability test (same three sentences,
 * same three consecutive source ranges, Kokoro am_adam, renderHighlightFastDraft)
 * but through the NEW continuous delivery-block path, then measures:
 *   - ONE raw TTS duration / ONE fitted block TTS duration
 *   - narration continuity and the voice gap at each INTERNAL visual cut
 *   - ducked-ambient gain immediately before/after each cut (release/attack?)
 *   - clipping, final MP4 duration
 * Writes continuous-block-test.mp4 + continuous-block-test-result.json.
 *
 *   node tools/run-continuous-block-test.js --source "C:\\Users\\Admin\\Videos\\<source>.mp4" --out "D:\\OutputVideo\\continuous-block-test"
 *   (--offset N shifts the source ranges when --source is a clip starting at N seconds of the original)
 *   (--old-mp4 <path> also measures the old per-segment render for comparison)
 *   Kokoro speed defaults to 1.05 (the Antigravity test); override with --speed.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const svc = p => path.join(__dirname, '..', 'electron', 'services', p);
const ProjectStore = require(svc('projectStore.js'));
const DubbingService = require(svc('dubbingService.js'));
const Delivery = require(svc('deliveryBlockService.js'));
const { compileV3, highlightV3 } = require(svc('autoStoryV3Compile.js'));

const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const SOURCE = arg('source');
const OFFSET = Number(arg('offset', 0));
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), 'continuous-block-test')));
const OLD_MP4 = arg('old-mp4');
const SPEED = Number(arg('speed', 1.05));
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

// The Antigravity test (narrated-block-capability-test): same sentences, same ranges.
const SENTENCES = [
  'Officers were responding to a report of an assault in progress.',
  'The caller said his girlfriend was inside the house being attacked by her parents.',
  'But as the officer approached the door, he still had no idea what was waiting inside.'
];
const RANGES = [[8.5, 13.5], [13.5, 19], [19, 24.5]];
const PREVIOUS = { boundaryGapsMs: [1750, 1300], ttsDurations: [4.125, 5.125, 5.3], status: 'BLOCK_RENDER_NEEDS_CONTINUOUS_TRACK' };

const r3 = n => Math.round(n * 1000) / 1000;
const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const runErr = (bin, args) => { try { execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); return ''; } catch (e) { return String(e.stderr || ''); } };
const ffErr = args => { const r = require('child_process').spawnSync(FFMPEG, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); return String(r.stderr || ''); };
const duration = file => Number(run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).trim());

function silences(file, noiseDb = -40, minSec = 0.15) {
  const log = ffErr(['-hide_banner', '-nostats', '-i', file, '-af', `silencedetect=noise=${noiseDb}dB:d=${minSec}`, '-f', 'null', '-']);
  const out = []; let start = null;
  for (const line of log.split('\n')) {
    const s = line.match(/silence_start: (-?[\d.]+)/); if (s) start = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end: ([\d.]+)/); if (e && start !== null) { out.push([r3(start), r3(Number(e[1]))]); start = null; }
  }
  if (start !== null) out.push([r3(start), r3(duration(file))]);
  return out;
}
// Mono float PCM samples at 8 kHz for RMS windows.
function pcm(file, rate = 8000) {
  const buf = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'], { maxBuffer: 256 * 1024 * 1024 });
  return { rate, data: new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)) };
}
function rmsDb({ rate, data }, a, z) {
  const i0 = Math.max(0, Math.floor(a * rate)), i1 = Math.min(data.length, Math.floor(z * rate));
  let sum = 0; for (let i = i0; i < i1; i++) sum += data[i] * data[i];
  const rms = Math.sqrt(sum / Math.max(1, i1 - i0));
  return r3(20 * Math.log10(Math.max(rms, 1e-9)));
}
function peak(file) {
  const log = ffErr(['-hide_banner', '-nostats', '-i', file, '-af', 'astats=metadata=0:reset=0', '-f', 'null', '-']);
  const peaks = [...log.matchAll(/Peak level dB: (-?[\d.inf]+)/g)].map(m => Number(m[1]));
  return peaks.length ? Math.max(...peaks.filter(Number.isFinite)) : null;
}
const gapAt = (sil, t, tol = 0.06) => { const hit = sil.find(([a, z]) => a <= t + tol && z >= t - tol); return hit ? r3(hit[1] - hit[0]) : 0; };

async function main() {
  if (!SOURCE || !fs.existsSync(SOURCE)) throw new Error('--source <video> is required (the Antigravity test source video, or a clip of it with --offset).');
  await fsp.mkdir(OUT, { recursive: true });
  const work = path.join(OUT, 'work');
  await fsp.rm(work, { recursive: true, force: true });
  await fsp.mkdir(work, { recursive: true });
  const store = new ProjectStore();
  const dubbing = new DubbingService(store);
  const sourceDuration = duration(SOURCE);

  // ---- EDL: three consecutive beats, ONE narrated_story delivery block.
  const beats = RANGES.map(([s, e], i) => ({ beatId: `b${i + 1}`, sourceStartSec: r3(s - OFFSET), sourceEndSec: r3(e - OFFSET),
    narrativeRole: i === 0 ? 'cold_open' : 'context', chronologyMode: 'chronological', scopeMembership: 'core',
    audioStrategy: 'narrator_over', speaks: true, narratorText: '', audioType: 'dialogue', audioConfidence: 1 }));
  const blocks = [{ blockId: 'story_setup', mode: 'narrated_story', beatIds: beats.map(b => b.beatId), storyFunction: 'set up the call',
    narratorFunction: 'CONTEXT', narrationIntent: 'the call, the caller, and what the officer does not know', sourceAudioTreatment: 'voiceover_with_ambient' }];
  const withBlocks = Delivery.applyDeliveryBlocks(beats, blocks);
  const passage = SENTENCES.join(' ');
  const narrated = Delivery.blockTimeline(withBlocks, blocks).map(b => ({ ...b, narrationText: passage }));
  const evidence = [{ id: 'src', sourceStart: 0, duration: sourceDuration }];
  const config = { targetDurationMinSec: 10, targetDurationMaxSec: 30, narration: { enabled: true, measuredWordsPerSecond: 3.0 } };
  const script = compileV3(withBlocks, { story: { scriptId: 1, title: 'continuous block test' }, evidence, config, sourceDuration, deliveryBlocks: narrated });
  const artifact = highlightV3(script, { scriptId: 1 }, evidence);
  await fsp.writeFile(path.join(OUT, 'continuous-block-test-script.json'), JSON.stringify(artifact, null, 2));
  const normalized = DubbingService.normalizeHighlightCutScript(artifact, sourceDuration);

  const project = await store.createProject(work, { name: 'continuous-block-test', sourceVideoPath: SOURCE });
  await store.updateProject(work, project.id, {
    mode: 'highlight_cut', analysisWorkflow: 'vertex_auto_story', draftVoiceMode: 'final', voiceProvider: 'kokoro', voiceId: 'am_adam',
    mixer: { sourceVolume: 28, voiceVolume: 100, narrationSourceAudioOverride: true, narrationDuckDefault: true },
    dubbingVoiceNormalize: true, dubbingMaxSafeStretch: 0.08,
    videoDecoration: { canvasEnabled: false, blurBackgroundEnabled: false, topCaptionEnabled: false },
    analysis: { activeVariantId: 'variant_01', highlightVariants: [{ id: 'variant_01', label: 'block', title: 'continuous block test', segments: normalized.segments, artifacts: {} }], segments: normalized.segments }
  });
  const settings = { kokoroSpeed: SPEED, dubbingVoiceNormalize: true, dubbingMaxSafeStretch: 0.08, outputDir: '', exportDir: '' };

  const t0 = Date.now();
  const rendered = await dubbing.renderHighlightFastDraft({ workspaceRoot: work, projectId: project.id, settings, onProgress: p => p?.message && console.log(`  ${p.message}`) });
  const renderMs = Date.now() - t0;
  const block = rendered.deliveryBlocks?.[0];
  if (!block) throw new Error('Renderer did not use the continuous block path (no delivery block report).');
  const finalMp4 = path.join(OUT, 'continuous-block-test.mp4');
  await fsp.copyFile(rendered.internalOutputPath || rendered.outputPath, finalMp4);

  // ---- measurements
  const cuts = block.internalCutOffsetsSec;
  const voice = block.fittedVoicePath;
  const voiceSil = silences(voice, -40, 0.15);
  const speechStart = voiceSil.length && voiceSil[0][0] === 0 ? voiceSil[0][1] : 0;
  const lastSil = voiceSil[voiceSil.length - 1];
  const speechEnd = lastSil && lastSil[1] >= duration(voice) - 0.05 ? lastSil[0] : duration(voice);
  const internalPauses = voiceSil.filter(([a, z]) => a > speechStart + 0.01 && z < speechEnd - 0.01).map(([a, z]) => ({ startSec: a, endSec: z, durationSec: r3(z - a) }));
  const voiceGapAtCutsSec = cuts.map(t => gapAt(voiceSil, t));

  // Ducked ambient bed alone: same sidechain as ffmpegService.mixVideoAudioWithVoice, bed mapped out.
  const bedWav = path.join(OUT, 'work', 'ducked-bed.wav');
  const rawBedWav = path.join(OUT, 'work', 'raw-bed.wav');
  const vol = block.sourceAmbientVolume;
  run(FFMPEG, ['-y', '-v', 'error', '-i', block.blockVideoPath, '-i', voice, '-filter_complex',
    [`[0:a]volume=${vol.toFixed(3)},aresample=async=1:first_pts=0,aformat=channel_layouts=stereo[bg_raw]`,
      `[1:a]volume=1.000,aresample=async=1:first_pts=0,aformat=channel_layouts=stereo[vo]`,
      `[bg_raw][vo]sidechaincompress=threshold=-30dB:ratio=10:attack=8:release=260:makeup=1[bg]`].join(';'),
    '-map', '[bg]', bedWav]);
  run(FFMPEG, ['-y', '-v', 'error', '-i', block.blockVideoPath, '-af', `volume=${vol.toFixed(3)}`, '-vn', rawBedWav]);
  // Counterfactual with NO cut: a steady noise bed under the SAME continuous voice.
  // Any duck swing present there comes from the voice (phrase pauses), not from a cut.
  const refWav = path.join(OUT, 'work', 'ref-bed.wav'), refRawWav = path.join(OUT, 'work', 'ref-raw.wav');
  const blockDur = duration(block.blockVideoPath);
  run(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-t', String(blockDur), '-i', 'anoisesrc=color=pink:amplitude=0.05:seed=7', '-i', voice, '-filter_complex',
    [`[0:a]aformat=channel_layouts=stereo[bg_raw]`, `[1:a]aresample=async=1:first_pts=0,aformat=channel_layouts=stereo[vo]`,
      `[bg_raw][vo]sidechaincompress=threshold=-30dB:ratio=10:attack=8:release=260:makeup=1[bg]`].join(';'), '-map', '[bg]', refWav]);
  run(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-t', String(blockDur), '-i', 'anoisesrc=color=pink:amplitude=0.05:seed=7', '-ac', '2', refRawWav]);
  const bed = pcm(bedWav), rawBed = pcm(rawBedWav), ref = pcm(refWav), refRaw = pcm(refRawWav);
  const W = 0.12, GUARD = 0.02;
  const ambientAtCuts = cuts.map(t => {
    const before = [t - GUARD - W, t - GUARD], after = [t + GUARD, t + GUARD + W];
    const duckBefore = r3(rmsDb(bed, ...before) - rmsDb(rawBed, ...before));
    const duckAfter = r3(rmsDb(bed, ...after) - rmsDb(rawBed, ...after));
    const refBefore = r3(rmsDb(ref, ...before) - rmsDb(refRaw, ...before));
    const refAfter = r3(rmsDb(ref, ...after) - rmsDb(refRaw, ...after));
    const voiceBefore = rmsDb(pcm(voice), ...before), voiceAfter = rmsDb(pcm(voice), ...after);
    return { cutSec: t, voiceDbBefore: voiceBefore, voiceDbAfter: voiceAfter,
      sourceBedDbBefore: rmsDb(rawBed, ...before), sourceBedDbAfter: rmsDb(rawBed, ...after), duckedBedDbBefore: rmsDb(bed, ...before), duckedBedDbAfter: rmsDb(bed, ...after),
      duckGainDbBefore: duckBefore, duckGainDbAfter: duckAfter, duckGainJumpDb: r3(duckAfter - duckBefore),
      noCutReferenceDuckJumpDb: r3(refAfter - refBefore),
      duckJumpAttributableToCutDb: r3((duckAfter - duckBefore) - (refAfter - refBefore)) };
  });
  const finalWav = path.join(OUT, 'work', 'final.wav');
  run(FFMPEG, ['-y', '-v', 'error', '-i', finalMp4, '-vn', '-ac', '1', finalWav]);
  const finalPcm = pcm(finalWav);
  const finalAtCuts = cuts.map(t => ({ cutSec: t, mixDbBefore: rmsDb(finalPcm, t - GUARD - W, t - GUARD), mixDbAfter: rmsDb(finalPcm, t + GUARD, t + GUARD + W) }));
  const finalSil = silences(finalMp4, -40, 0.15);
  const peakDb = peak(finalMp4);
  const finalDurationSec = r3(duration(finalMp4));

  // Same measurement on the OLD per-segment voice (3 separate syntheses, each padded
  // to its own segment, as the per-segment renderer does) for a like-for-like comparison.
  const perSegDir = path.join(OUT, 'work', 'per-segment');
  await fsp.mkdir(perSegDir, { recursive: true });
  const segDur = RANGES.map(([a, z]) => z - a);
  const perSegFiles = [];
  for (const [i, sentence] of SENTENCES.entries()) {
    const raw = path.join(perSegDir, `seg${i + 1}.wav`), padded = path.join(perSegDir, `seg${i + 1}-padded.wav`);
    const proj = await store.getProject(work, project.id);
    await dubbing.synthesizeFastDraftVoice({ project: proj, settings, text: sentence, outputPath: raw });
    run(FFMPEG, ['-y', '-v', 'error', '-i', raw, '-af', `apad=pad_dur=${segDur[i]},atrim=0:${segDur[i]}`, '-ar', '24000', '-ac', '1', padded]);
    perSegFiles.push({ raw, padded, rawSec: r3(duration(raw)) });
  }
  const perSegTrack = path.join(perSegDir, 'per-segment-voice.wav');
  run(FFMPEG, ['-y', '-v', 'error', ...perSegFiles.flatMap(f => ['-i', f.padded]), '-filter_complex', `${perSegFiles.map((_, i) => `[${i}:a]`).join('')}concat=n=${perSegFiles.length}:v=0:a=1[a]`, '-map', '[a]', perSegTrack]);
  const perSegSil = silences(perSegTrack, -40, 0.15);
  const perSegment = { ttsSynthesisCount: 3, rawTtsSec: perSegFiles.map(f => f.rawSec), voiceGapAtInternalCutsSec: cuts.map(t => gapAt(perSegSil, t)) };

  let old = null;
  if (OLD_MP4 && fs.existsSync(OLD_MP4)) {
    const oldSil = silences(OLD_MP4, -40, 0.15);
    old = { path: OLD_MP4, durationSec: r3(duration(OLD_MP4)), silencesSec: oldSil, gapAtCutsSec: [5, 10.5].map(t => gapAt(oldSil, t)), peakDb: peak(OLD_MP4) };
  }

  // ---- acceptance (the Antigravity failure modes)
  const MAX_CUT_GAP_SEC = 0.6;          // a natural phrase pause, far below the old 1.3-1.75s restarts
  const MAX_DUCK_JUMP_DB = 3;           // a release/attack cycle caused by the cut = >3 dB swing not present without the cut
  const reasons = [];
  if (voiceGapAtCutsSec.some(g => g >= MAX_CUT_GAP_SEC)) reasons.push(`voice gap at an internal cut >= ${MAX_CUT_GAP_SEC}s: ${voiceGapAtCutsSec.join(', ')}s`);
  if (internalPauses.some(p => p.durationSec >= 1.0)) reasons.push(`narration contains a ${Math.max(...internalPauses.map(p => p.durationSec))}s internal pause`);
  const jumps = ambientAtCuts.map(a => Math.abs(a.duckJumpAttributableToCutDb));
  if (jumps.some(j => j > MAX_DUCK_JUMP_DB)) reasons.push(`ambient duck gain swing attributable to a cut: ${jumps.join(', ')} dB`);
  if (peakDb !== null && peakDb > -0.1) reasons.push(`clipping: peak ${peakDb} dBFS`);
  if (Math.abs(finalDurationSec - block.blockTimelineSec) > 0.1) reasons.push(`final duration ${finalDurationSec}s != block ${block.blockTimelineSec}s`);
  if (block.fitRatio > 1.08) reasons.push(`voice does not fit the block (ratio ${block.fitRatio})`);

  const result = {
    status: reasons.length ? 'CONTINUOUS_BLOCK_RENDER_FAILED' : 'CONTINUOUS_BLOCK_RENDER_OK',
    reasons, generatedAt: new Date().toISOString(), renderMs,
    test: { sentences: SENTENCES, sourceRanges: RANGES, sourceOffsetSec: OFFSET, voice: 'kokoro am_adam', kokoroSpeed: SPEED, source: SOURCE },
    implementation: 'renderHighlightFastDraft -> renderNarratedDeliveryBlock (one synthesis, one fit, one ducked mix)',
    ttsSynthesisCount: 1,
    rawTtsSec: block.rawTtsSec, fittedTtsSec: block.fittedTtsSec, blockTimelineSec: block.blockTimelineSec, fitRatio: block.fitRatio, voiceFitStrategy: block.voiceFitStrategy,
    internalCutOffsetsSec: cuts, voiceGapAtInternalCutsSec: voiceGapAtCutsSec,
    narrationSpeechSpanSec: [r3(speechStart), r3(speechEnd)], narrationInternalPauses: internalPauses,
    ambientAtInternalCuts: ambientAtCuts, finalMixAtInternalCuts: finalAtCuts,
    finalSilencesSec: finalSil, peakDbfs: peakDb, clippingDetected: peakDb !== null && peakDb > -0.1,
    finalMp4Path: finalMp4, finalMp4DurationSec: finalDurationSec,
    previousPerSegmentResult: PREVIOUS, perSegmentVoiceSameMeasurement: perSegment, oldRenderMeasured: old,
    deliveryBlockReportPath: rendered.deliveryBlockReportPath
  };
  const resultPath = path.join(OUT, 'continuous-block-test-result.json');
  await fsp.writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: result.status, reasons, perSegmentVoiceGapAtCutsSec: perSegment.voiceGapAtInternalCutsSec, rawTtsSec: result.rawTtsSec, fittedTtsSec: result.fittedTtsSec, voiceGapAtInternalCutsSec: voiceGapAtCutsSec,
    duckJumpAttributableToCutDb: ambientAtCuts.map(a => a.duckJumpAttributableToCutDb), peakDbfs: peakDb, finalMp4DurationSec: finalDurationSec }, null, 2));
  console.log(`${result.status}\nResult: ${resultPath}\nMP4: ${finalMp4}`);
  // The Kokoro worker stays warm between requests; exit explicitly.
  process.exit(reasons.length ? 2 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
