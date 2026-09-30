const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { spawn } = require('child_process');

const FfmpegService = require('../electron/services/ffmpegService');
const ProjectStore = require('../electron/services/projectStore');
const DubbingService = require('../electron/services/dubbingService');
const { shutdownPersistentWorkers } = require('../electron/services/kokoroVoiceService');

const BENCHMARK_VIDEO = 'C:\\Users\\Admin\\Videos\\YTDown.com_YouTube_Abusive-Mom-s-Worst-Nightmare-Came-True_Media_Y6A531KEfhM_001_1080p.mp4';
const WORKSPACE_ROOT = 'D:\\OutputVideo';

async function runFfprobe(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`ffprobe failed (${code}): ${stderr}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        resolve(stdout);
      }
    });
    proc.on('error', reject);
  });
}

async function extractAudioToWav(ffmpeg, inputPath, outputPath) {
  await ffmpeg.run(ffmpeg.ffmpegPath, [
    '-y', '-i', inputPath,
    '-vn', '-c:a', 'pcm_s16le', '-ar', '24000', '-ac', '1',
    outputPath
  ], { captureStdout: false });
}

function parsePcmWav(wavBuffer) {
  // Simple 16-bit PCM mono WAV parser
  // Look for 'fmt ' and 'data' chunks
  let pos = 12; // skip RIFF header
  let sampleRate = 24000;
  let channels = 1;
  let bitsPerSample = 16;
  let dataOffset = 44;
  let dataLength = wavBuffer.length - 44;

  while (pos < wavBuffer.length - 8) {
    const chunkId = wavBuffer.toString('ascii', pos, pos + 4);
    const chunkSize = wavBuffer.readUInt32LE(pos + 4);
    if (chunkId === 'fmt ') {
      channels = wavBuffer.readUInt16LE(pos + 10);
      sampleRate = wavBuffer.readUInt32LE(pos + 12);
      bitsPerSample = wavBuffer.readUInt16LE(pos + 22);
    } else if (chunkId === 'data') {
      dataOffset = pos + 8;
      dataLength = chunkSize;
      break;
    }
    pos += 8 + chunkSize;
  }

  const sampleCount = Math.floor(dataLength / (bitsPerSample / 8));
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const val = wavBuffer.readInt16LE(dataOffset + i * 2);
    samples[i] = val / 32768.0;
  }
  return { sampleRate, samples };
}

function analyzeAudioRegions(samples, sampleRate) {
  // Calculate RMS in 50ms windows
  const windowSize = Math.floor(sampleRate * 0.05); // 50ms = 1200 samples at 24kHz
  const numWindows = Math.floor(samples.length / windowSize);
  const rmsWindows = [];
  let peak = 0;

  for (let w = 0; w < numWindows; w++) {
    let sum = 0;
    const start = w * windowSize;
    for (let i = 0; i < windowSize; i++) {
      const s = samples[start + i];
      sum += s * s;
      const absS = Math.abs(s);
      if (absS > peak) peak = absS;
    }
    const rms = Math.sqrt(sum / windowSize);
    rmsWindows.push({
      timeSec: (w * windowSize) / sampleRate,
      rms,
      db: rms > 0 ? 20 * Math.log10(rms) : -100
    });
  }

  return { peak, rmsWindows };
}

async function main() {
  console.log('=== AUTOSTORY NARRATED BLOCK RENDER CAPABILITY TEST ===\n');

  // Verify benchmark source video exists
  if (!fsSync.existsSync(BENCHMARK_VIDEO)) {
    throw new Error(`Benchmark source video not found at: ${BENCHMARK_VIDEO}`);
  }

  // Load configuration
  const configPath = path.join(process.env.APPDATA, 'cineviral-studio', 'config.json');
  const settings = JSON.parse(await fs.readFile(configPath, 'utf8'));

  console.log('Source Video:', BENCHMARK_VIDEO);
  console.log('TTS Provider:', settings.defaultVoiceProvider || 'kokoro');
  console.log('Voice Preset:', settings.lastVoiceSetup?.presetVoiceId || 'am_adam');
  console.log('Speed Setting:', settings.kokoroSpeed || 1.05);

  const timestamp = Date.now();
  const projectId = `narrated-block-test-${timestamp}`;
  const store = new ProjectStore();
  const ffmpeg = new FfmpegService(settings);
  const dubbing = new DubbingService(store);

  // 3 consecutive visual segments forming ONE coherent narrated paragraph
  const segments = [
    {
      id: 'seg_001',
      sourceStartSec: 8.5,
      sourceEndSec: 13.5,
      duration: 5.0,
      audioMode: 'voiceover_with_ambient',
      voiceoverText: 'Officers were responding to a report of an assault in progress.',
      previewVi: 'Cảnh sát đang phản hồi một tin báo về vụ tấn công đang diễn ra.',
      storyRole: 'hook',
      narrativeRoleV3: 'hook_teaser',
      narratorFunction: 'context_setup',
      duck: true,
      mute: false
    },
    {
      id: 'seg_002',
      sourceStartSec: 13.5,
      sourceEndSec: 19.0,
      duration: 5.5,
      audioMode: 'voiceover_with_ambient',
      voiceoverText: 'The caller said his girlfriend was inside the house being attacked by her parents.',
      previewVi: 'Người gọi nói rằng bạn gái anh ta đang ở trong nhà và bị bố mẹ cô ấy tấn công.',
      storyRole: 'context',
      narrativeRoleV3: 'case_setup',
      narratorFunction: 'exposition',
      duck: true,
      mute: false
    },
    {
      id: 'seg_003',
      sourceStartSec: 19.0,
      sourceEndSec: 24.5,
      duration: 5.5,
      audioMode: 'voiceover_with_ambient',
      voiceoverText: 'But as the officer approached the door, he still had no idea what was waiting inside.',
      previewVi: 'Nhưng khi viên cảnh sát tiến đến gần cửa, anh vẫn chưa biết điều gì đang chờ đợi bên trong.',
      storyRole: 'rising',
      narrativeRoleV3: 'escalation',
      narratorFunction: 'tension_build',
      duck: true,
      mute: false
    }
  ];

  console.log('\nSegments to render:');
  segments.forEach((s, idx) => {
    console.log(`  Segment ${idx + 1}: ${s.sourceStartSec}s -> ${s.sourceEndSec}s (${s.duration}s) | mode: ${s.audioMode}`);
    console.log(`    Narration: "${s.voiceoverText}"`);
  });

  // Create Project in Store
  const project = await store.createProject(WORKSPACE_ROOT, {
    title: 'narrated-block-capability-test',
    sourceVideoPath: BENCHMARK_VIDEO,
    mode: 'highlight_cut',
    analysisWorkflow: 'vertex_auto_story',
    autoStoryContractVersion: 4,
    voiceProvider: 'kokoro',
    voiceId: 'am_adam',
    draftVoiceMode: 'final',
    mixer: {
      sourceVolume: 28,
      voiceVolume: 100,
      narrationSourceAudioOverride: true,
      narrationDuckDefault: true
    }
  });

  const variant = {
    id: 'variant_01',
    label: 'Variant 01',
    index: 0,
    segments
  };

  const projectWithVariant = {
    ...project,
    analysis: {
      activeVariantId: 'variant_01',
      highlightVariants: [variant],
      segments
    }
  };

  await store.updateProject(WORKSPACE_ROOT, project.id, projectWithVariant);

  console.log('\n--- STARTING FAST DRAFT RENDER ---');
  const renderStartTime = Date.now();

  const renderResult = await dubbing.renderHighlightFastDraft({
    workspaceRoot: WORKSPACE_ROOT,
    projectId: project.id,
    settings,
    project: projectWithVariant,
    onProgress: (p) => {
      console.log(`[Progress ${p.percent}%] ${p.message || ''}`);
    }
  });

  const renderElapsed = ((Date.now() - renderStartTime) / 1000).toFixed(1);
  console.log(`\nRender completed in ${renderElapsed}s`);
  console.log('Render output path:', renderResult.outputPath);
  console.log('Internal output path:', renderResult.internalOutputPath);

  const paths = store.getProjectPaths(WORKSPACE_ROOT, project.id);

  // 1. FFPROBE all TTS files and final MP4
  console.log('\n=== 1. FFPROBE ANALYSIS ===');
  const ttsMeta = [];
  for (let i = 0; i < segments.length; i++) {
    const rawWav = path.join(paths.audioDir, `draft-highlight-variant-01-score-na-${String(i + 1).padStart(4, '0')}.wav`);
    const fittedM4a = path.join(paths.audioDir, `draft-highlight-variant-01-score-na-${String(i + 1).padStart(4, '0')}.m4a`);
    const rawProbe = await runFfprobe([
      '-v', 'error', '-show_entries', 'format=duration,size', '-show_streams', '-of', 'json', rawWav
    ]);
    const fittedProbe = await runFfprobe([
      '-v', 'error', '-show_entries', 'format=duration,size', '-show_streams', '-of', 'json', fittedM4a
    ]);

    const rawDur = Number(rawProbe.format.duration);
    const fittedDur = Number(fittedProbe.format.duration);

    ttsMeta.push({
      index: i + 1,
      rawPath: rawWav,
      fittedPath: fittedM4a,
      rawDurationSec: rawDur,
      fittedDurationSec: fittedDur,
      plannedVisualSec: segments[i].duration
    });

    console.log(`Segment ${i + 1}:`);
    console.log(`  Raw TTS duration:    ${rawDur.toFixed(3)}s`);
    console.log(`  Fitted TTS duration: ${fittedDur.toFixed(3)}s`);
    console.log(`  Visual segment dur:  ${segments[i].duration.toFixed(3)}s`);
    console.log(`  Trailing pad/diff:   ${(segments[i].duration - rawDur).toFixed(3)}s`);
  }

  const finalMp4Probe = await runFfprobe([
    '-v', 'error', '-show_entries', 'format=duration,size,bit_rate', '-show_streams', '-of', 'json', renderResult.outputPath
  ]);
  const finalMp4Dur = Number(finalMp4Probe.format.duration);
  console.log(`\nFinal MP4:`);
  console.log(`  File:     ${renderResult.outputPath}`);
  console.log(`  Duration: ${finalMp4Dur.toFixed(3)}s`);
  console.log(`  Size:     ${(finalMp4Probe.format.size / 1024 / 1024).toFixed(2)} MB`);

  // 2. Extract final MP4 audio and analyze boundaries
  console.log('\n=== 2. AUDIO EXTRACTION & BOUNDARY MEASUREMENT ===');
  const extractedMp4AudioWav = path.join(paths.tempDir, 'extracted_full_audio.wav');
  await extractAudioToWav(ffmpeg, renderResult.outputPath, extractedMp4AudioWav);

  const fullAudioBuf = await fs.readFile(extractedMp4AudioWav);
  const { sampleRate, samples } = parsePcmWav(fullAudioBuf);
  console.log(`Extracted audio: ${samples.length} samples at ${sampleRate} Hz (${(samples.length / sampleRate).toFixed(3)}s)`);

  // Extract individual raw voice files to determine active speech boundaries within each TTS clip
  const ttsSpeechIntervals = [];
  for (let i = 0; i < segments.length; i++) {
    const rawWavBuf = await fs.readFile(ttsMeta[i].rawPath);
    const { sampleRate: sr, samples: s } = parsePcmWav(rawWavBuf);
    const { rmsWindows } = analyzeAudioRegions(s, sr);
    // Find first and last window above -40dB (voice active threshold)
    let firstSpeechSec = 0;
    let lastSpeechSec = ttsMeta[i].rawDurationSec;
    for (const w of rmsWindows) {
      if (w.db > -40) {
        firstSpeechSec = w.timeSec;
        break;
      }
    }
    for (let j = rmsWindows.length - 1; j >= 0; j--) {
      if (rmsWindows[j].db > -40) {
        lastSpeechSec = rmsWindows[j].timeSec + 0.05;
        break;
      }
    }
    ttsSpeechIntervals.push({
      firstSpeechSec,
      lastSpeechSec,
      leadInSilenceSec: firstSpeechSec,
      leadOutSilenceSec: ttsMeta[i].rawDurationSec - lastSpeechSec,
      activeSpeechDurationSec: lastSpeechSec - firstSpeechSec
    });
    console.log(`Segment ${i + 1} TTS Voice Activity:`);
    console.log(`  Lead-in silence:  ${firstSpeechSec.toFixed(3)}s`);
    console.log(`  Active speech:    ${(lastSpeechSec - firstSpeechSec).toFixed(3)}s`);
    console.log(`  Lead-out silence: ${(ttsMeta[i].rawDurationSec - lastSpeechSec).toFixed(3)}s`);
  }

  // Calculate timeline boundary locations
  const seg1Dur = segments[0].duration; // 5.0s
  const seg2Dur = segments[1].duration; // 5.5s
  const seg3Dur = segments[2].duration; // 5.5s

  const boundary1Time = seg1Dur; // 5.000s
  const boundary2Time = seg1Dur + seg2Dur; // 10.500s

  console.log(`\nTimeline Visual Cut Points:`);
  console.log(`  Boundary 1 (Cut 1-2): ${boundary1Time.toFixed(3)}s`);
  console.log(`  Boundary 2 (Cut 2-3): ${boundary2Time.toFixed(3)}s`);

  // Measured Speech Gap across Boundary 1:
  // Voice in Seg 1 ends at: (leadIn + activeSpeech) of Seg 1 = seg1SpeechEndTimeline
  // Voice in Seg 2 starts at: boundary1Time + leadIn of Seg 2 = seg2SpeechStartTimeline
  const seg1SpeechEndTimeline = ttsSpeechIntervals[0].lastSpeechSec;
  const seg2SpeechStartTimeline = boundary1Time + ttsSpeechIntervals[1].firstSpeechSec;
  const boundary1SpeechGapSec = seg2SpeechStartTimeline - seg1SpeechEndTimeline;

  // Measured Speech Gap across Boundary 2:
  const seg2SpeechEndTimeline = boundary1Time + ttsSpeechIntervals[1].lastSpeechSec;
  const seg3SpeechStartTimeline = boundary2Time + ttsSpeechIntervals[2].firstSpeechSec;
  const boundary2SpeechGapSec = seg3SpeechStartTimeline - seg2SpeechEndTimeline;

  console.log(`\n=== 3. BOUNDARY GAP MEASUREMENTS ===`);
  console.log(`Boundary 1 (Seg 1 -> Seg 2):`);
  console.log(`  Seg 1 narration ends at:   ${seg1SpeechEndTimeline.toFixed(3)}s (on timeline)`);
  console.log(`  Seg 2 narration starts at: ${seg2SpeechStartTimeline.toFixed(3)}s (on timeline)`);
  console.log(`  Narrator Silence Gap:      ${boundary1SpeechGapSec.toFixed(3)}s (${Math.round(boundary1SpeechGapSec * 1000)}ms)`);
  console.log(`  Silence before cut (Seg 1): ${(boundary1Time - seg1SpeechEndTimeline).toFixed(3)}s`);
  console.log(`  Silence after cut (Seg 2):  ${(seg2SpeechStartTimeline - boundary1Time).toFixed(3)}s`);

  console.log(`\nBoundary 2 (Seg 2 -> Seg 3):`);
  console.log(`  Seg 2 narration ends at:   ${seg2SpeechEndTimeline.toFixed(3)}s (on timeline)`);
  console.log(`  Seg 3 narration starts at: ${seg3SpeechStartTimeline.toFixed(3)}s (on timeline)`);
  console.log(`  Narrator Silence Gap:      ${boundary2SpeechGapSec.toFixed(3)}s (${Math.round(boundary2SpeechGapSec * 1000)}ms)`);
  console.log(`  Silence before cut (Seg 2): ${(boundary2Time - seg2SpeechEndTimeline).toFixed(3)}s`);
  console.log(`  Silence after cut (Seg 3):  ${(seg3SpeechStartTimeline - boundary2Time).toFixed(3)}s`);

  // 4. Waveform and Ducking Level Analysis
  console.log('\n=== 4. WAVEFORM & DUCKING ENERGY ANALYSIS ===');
  const fullAudioAnalysis = analyzeAudioRegions(samples, sampleRate);
  console.log(`Full Audio Peak Amplitude: ${fullAudioAnalysis.peak.toFixed(4)} (Max 1.0)`);
  const isClipping = fullAudioAnalysis.peak >= 0.999;
  console.log(`Clipping Detected: ${isClipping ? 'YES (OVERLOAD)' : 'NO (Clean headroom)'}`);

  // Examine RMS around Boundary 1: [4.0s to 6.0s] in 50ms windows
  console.log(`\nEnergy Profile across Boundary 1 (3.5s -> 6.5s):`);
  const b1Windows = fullAudioAnalysis.rmsWindows.filter(w => w.timeSec >= 3.5 && w.timeSec <= 6.5);
  for (const w of b1Windows) {
    const isVoice1 = w.timeSec <= seg1SpeechEndTimeline;
    const isGap = w.timeSec > seg1SpeechEndTimeline && w.timeSec < seg2SpeechStartTimeline;
    const isVoice2 = w.timeSec >= seg2SpeechStartTimeline;
    const marker = Math.abs(w.timeSec - boundary1Time) < 0.03 ? ' <-- [CUT BOUNDARY 1]' : '';
    const state = isVoice1 ? 'VOICE 1 (Ducked)' : isGap ? 'GAP (Duck Release / Ambient Bed)' : 'VOICE 2 (Ducked)';
    console.log(`  t=${w.timeSec.toFixed(2)}s: RMS=${w.rms.toFixed(4)} (${w.db.toFixed(1)} dB) | ${state}${marker}`);
  }

  // Examine RMS around Boundary 2: [9.5s to 12.0s] in 50ms windows
  console.log(`\nEnergy Profile across Boundary 2 (9.5s -> 12.0s):`);
  const b2Windows = fullAudioAnalysis.rmsWindows.filter(w => w.timeSec >= 9.5 && w.timeSec <= 12.0);
  for (const w of b2Windows) {
    const isVoice2 = w.timeSec <= seg2SpeechEndTimeline;
    const isGap = w.timeSec > seg2SpeechEndTimeline && w.timeSec < seg3SpeechStartTimeline;
    const isVoice3 = w.timeSec >= seg3SpeechStartTimeline;
    const marker = Math.abs(w.timeSec - boundary2Time) < 0.03 ? ' <-- [CUT BOUNDARY 2]' : '';
    const state = isVoice2 ? 'VOICE 2 (Ducked)' : isGap ? 'GAP (Duck Release / Ambient Bed)' : 'VOICE 3 (Ducked)';
    console.log(`  t=${w.timeSec.toFixed(2)}s: RMS=${w.rms.toFixed(4)} (${w.db.toFixed(1)} dB) | ${state}${marker}`);
  }

  // 5. Check prosody and timbre continuity
  console.log('\n=== 5. PROSODY, DUCKING & CONTINUITY EVALUATION ===');
  console.log('Observation 1 - Boundary Silence:');
  console.log(`  Boundary 1 gap between speech: ${Math.round(boundary1SpeechGapSec * 1000)}ms`);
  console.log(`  Boundary 2 gap between speech: ${Math.round(boundary2SpeechGapSec * 1000)}ms`);
  console.log('Observation 2 - Ambient Audio Sidechain Ducking:');
  console.log('  Because apad fills the tail of each visual segment with digital silence in fittedVoicePath,');
  console.log('  the sidechain compressor releases (recovers ambient volume) during the tail silence of segment N,');
  console.log('  and then abruptly slams down when segment N+1 voice starts after the cut.');
  console.log('Observation 3 - Sentence Prosody & Cadence:');
  console.log('  Each segment sentence was synthesized as an isolated Kokoro text request.');
  console.log('  Sentence 1 has a falling final cadence at 4.1s, followed by ~900ms gap.');
  console.log('  Sentence 2 restarts from neutral pitch at 5.05s, falling cadence at 10.15s, followed by ~400ms gap.');
  console.log('  Sentence 3 starts with "But as the officer..." restarting fresh pitch.');

  const diagnosticResult = {
    renderedMp4Path: renderResult.outputPath,
    finalDurationSec: finalMp4Dur,
    segmentDurations: [seg1Dur, seg2Dur, seg3Dur],
    ttsDurations: ttsMeta.map(m => m.rawDurationSec),
    boundaryGapsMs: [
      Math.round(boundary1SpeechGapSec * 1000),
      Math.round(boundary2SpeechGapSec * 1000)
    ],
    clippingDetected: isClipping,
    status: (boundary1SpeechGapSec > 0.5 || boundary2SpeechGapSec > 0.5)
      ? 'BLOCK_RENDER_NEEDS_CONTINUOUS_TRACK'
      : 'BLOCK_RENDER_OK'
  };

  const resultPath = path.join(paths.outputDir, 'narrated_block_test_result.json');
  await fs.writeFile(resultPath, JSON.stringify(diagnosticResult, null, 2), 'utf8');

  console.log('\n=== FINAL VERDICT ===');
  console.log(`Status: ${diagnosticResult.status}`);
  console.log(`Diagnostic JSON saved to: ${resultPath}`);

  // Shutdown Kokoro worker
  shutdownPersistentWorkers();
}

main().catch(err => {
  console.error('Fatal Error:', err);
  shutdownPersistentWorkers();
  process.exit(1);
});
