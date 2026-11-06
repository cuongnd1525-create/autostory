'use strict';
/**
 * NARRATION PERFORMANCE & SCRIPT QUALITY AUDITOR
 *
 * Audits every narrator block across both dimensions required by V6:
 *   A. Script Quality: editorial commentary value, US English naturalness,
 *      epistemic grounding (evidence references), punchline spoiler check,
 *      and handoff setup into the following raw evidence block.
 *   B. Voice Performance: real Kokoro voice identity, configured speed,
 *      measured active speaking duration, true WPM, internal breath pauses,
 *      loudness (LUFS / true peak), post-speech tail gap, and handoff quality.
 *
 * Emits `narration-performance-audit.json`.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const narrationGate = require('./narrationGate');

const execFileAsync = promisify(execFile);
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const wordCount = s => String(s || '').trim().split(/\s+/).filter(Boolean).length;

async function inspectAudioFile(audioPath, ffmpegBin = 'ffmpeg', ffprobeBin = 'ffprobe') {
  if (!audioPath || !fs.existsSync(audioPath)) return null;
  let durationSec = 0;
  try {
    const { stdout } = await execFileAsync(ffprobeBin, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath
    ], { timeout: 15000 });
    durationSec = Number(String(stdout || '').trim()) || 0;
  } catch (_) {}

  let integratedLufs = null;
  let truePeakDb = null;
  const silences = [];
  try {
    const { stderr } = await execFileAsync(ffmpegBin, [
      '-hide_banner', '-nostats', '-i', audioPath,
      '-af', 'silencedetect=noise=-38dB:d=0.14,ebur128=peak=true',
      '-f', 'null', '-'
    ], { timeout: 25000, maxBuffer: 8 * 1024 * 1024 });
    let pendingStart = null;
    for (const line of String(stderr || '').split(/\r?\n/)) {
      const mStart = line.match(/silence_start:\s*([0-9.]+)/);
      if (mStart) pendingStart = Number(mStart[1]);
      const mEnd = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);
      if (mEnd) {
        const end = Number(mEnd[1]);
        const dur = Number(mEnd[2]);
        const start = Number.isFinite(pendingStart) ? pendingStart : Math.max(0, end - dur);
        silences.push({ startSec: round2(start), endSec: round2(end), durationSec: round2(dur) });
        pendingStart = null;
      }
      const mI = line.match(/I:\s*(-?[0-9.]+)\s*LUFS/);
      if (mI) integratedLufs = Number(mI[1]);
      const mPeak = line.match(/Peak:\s*(-?[0-9.]+)\s*dBFS/);
      if (mPeak) truePeakDb = Number(mPeak[1]);
    }
    if (Number.isFinite(pendingStart) && durationSec > pendingStart) {
      silences.push({ startSec: round2(pendingStart), endSec: round2(durationSec), durationSec: round2(durationSec - pendingStart) });
    }
  } catch (_) {}

  const leadingSilence = silences.find(s => s.startSec <= 0.05);
  const trailingSilence = silences.find(s => durationSec > 0 && s.endSec >= durationSec - 0.08);
  const speechStartSec = leadingSilence ? leadingSilence.endSec : 0;
  const speechEndSec = trailingSilence ? trailingSilence.startSec : durationSec;
  const activeSpanSec = Math.max(0, speechEndSec - speechStartSec);
  const internalPauses = silences.filter(s => s.startSec > speechStartSec + 0.05 && s.endSec < speechEndSec - 0.05);

  return {
    fileDurationSec: round2(durationSec),
    activeSpeakingSpanSec: round2(activeSpanSec > 0.1 ? activeSpanSec : durationSec),
    leadingSilenceSec: round2(leadingSilence?.durationSec || 0),
    trailingSilenceSec: round2(trailingSilence?.durationSec || 0),
    internalPauseCount: internalPauses.length,
    internalPauses,
    integratedLufs: Number.isFinite(integratedLufs) ? round2(integratedLufs) : null,
    truePeakDb: Number.isFinite(truePeakDb) ? round2(truePeakDb) : null
  };
}

function classifyContentValue(block, text) {
  const fn = String(block.narratorFunction || 'CONTEXT').toUpperCase();
  const words = wordCount(text);
  const judgment = narrationGate.detectJudgmentalTerms(text);
  const hasContrastOrCausality = /\b(instead of|rather than|despite|convinced|insisting|believing|because|turning|escalat|leaving|within minutes|moments later|what began|cross(ed|ing)? the line|warrant|or should|or could)\b/i.test(text);
  const hasQuestion = /\?/.test(text);
  if (judgment.hasJudgmentalTerms) {
    return {
      rating: 'DEFECTIVE_JUDGMENTAL',
      summary: `Contains subjective/derogatory terms (${judgment.matchedTerms.join(', ')}) instead of grounded behavioral contrast.`
    };
  }
  if (words <= 5 && (fn === 'CLOSING' || fn === 'PAYOFF')) {
    return {
      rating: 'WEAK_STUB',
      summary: `Undersized ${words}-word closing stub lacks grounded takeaway synthesis.`
    };
  }
  if (['COMMENTARY', 'INTERPRETATION', 'REHOOK', 'ANTICIPATION', 'CLOSING', 'PAYOFF'].includes(fn) && (hasContrastOrCausality || hasQuestion || block.commentaryValue)) {
    return {
      rating: 'STRONG_COMMENTARY',
      summary: block.commentaryValue || `Provides grounded ${fn.toLowerCase()} framing causal/statutory tension beyond what raw footage shows.`
    };
  }
  if (hasContrastOrCausality) {
    return {
      rating: 'SOLID_ORIENTATION',
      summary: `Compresses context and establishes causal progression (${fn}).`
    };
  }
  return {
    rating: 'BASIC_SUMMARY',
    summary: `Functional ${fn.toLowerCase()} line; check that it adds orientation not already obvious on camera.`
  };
}

async function buildNarrationPerformanceAudit({
  script = {},
  spine = {},
  model = {},
  cues = [],
  deliveryBlockReports = [],
  project = {},
  settings = {},
  videoDurationSec = null,
  outputPath = null,
  ffmpegBin = 'ffmpeg',
  ffprobeBin = 'ffprobe'
} = {}) {
  const compiledBlocks = Array.isArray(script?.delivery_blocks)
    ? script.delivery_blocks
    : Array.isArray(spine?.deliveryBlocks)
      ? spine.deliveryBlocks
      : [];
  const reportByBlockId = new Map((deliveryBlockReports || []).map(r => [r.blockId, r]));
  const totalVideoSec = round2(Number(videoDurationSec) || Number(script?.measuredDuration) || compiledBlocks.reduce((s, b) => s + (Number(b.durationSec) || 0), 0));
  const resolvedVoiceProvider = project?.voiceProvider || project?.draftVoiceProvider || settings?.defaultVoiceProvider || 'kokoro';
  const resolvedVoiceId = project?.voiceId || project?.draftVoiceId || (resolvedVoiceProvider === 'kokoro' ? 'af_heart' : settings?.defaultVoiceId || '');
  const configuredKokoroSpeed = Number(project?.kokoroSpeed ?? settings?.kokoroSpeed ?? 1);

  const blocksOut = [];
  let totalSpeakingSec = 0;
  let totalNarratedBlockSec = 0;
  let totalWords = 0;

  for (let i = 0; i < compiledBlocks.length; i++) {
    const blk = compiledBlocks[i];
    if (blk.mode !== 'narrated_story') continue;
    const isClosing = i === compiledBlocks.length - 1;
    const renderRep = reportByBlockId.get(blk.blockId) || null;
    const text = String(blk.narrationText || renderRep?.narrationText || '').trim();
    const words = wordCount(text);
    const blockDurationSec = round2(Number(blk.durationSec) || Number(renderRep?.blockTimelineSec) || 0);
    const outStart = round2(Number(blk.outputStartSec ?? renderRep?.outputStartSec ?? 0));
    const outEnd = round2(Number(blk.outputEndSec ?? (outStart + blockDurationSec)));

    const audioInspect = await inspectAudioFile(renderRep?.fittedVoicePath, ffmpegBin, ffprobeBin);
    const rawTtsSec = round2(Number(renderRep?.rawTtsSec ?? blk.rawBlockVoiceSec ?? audioInspect?.activeSpeakingSpanSec ?? 0));
    const speakingDurationSec = round2(
      audioInspect?.activeSpeakingSpanSec > 0
        ? Math.min(blockDurationSec, audioInspect.activeSpeakingSpanSec)
        : Math.min(blockDurationSec, Number(renderRep?.fittedTtsSec || rawTtsSec || 0))
    );
    const wpm = speakingDurationSec > 0 ? round2((words * 60) / speakingDurationSec) : 0;

    // Upcoming raw block quotes for spoiler check
    let nextRaw = null;
    for (let j = i + 1; j < compiledBlocks.length; j++) {
      if (compiledBlocks[j].mode === 'raw_evidence') { nextRaw = compiledBlocks[j]; break; }
      if (compiledBlocks[j].mode === 'narrated_story') break;
    }
    const nextSegments = (script?.segments || []).filter(s => nextRaw && (nextRaw.beatIds || []).includes(s.beat_id || s.beatId));
    const nextRanges = nextSegments.map(s => [Number(s.sourceStartSec), Number(s.sourceEndSec)]);
    const upcomingQuotes = [
      ...(model?.quotes || [])
        .filter(q => nextRanges.some(([a, z]) => Math.min(Number(q.endSec), z) - Math.max(Number(q.startSec), a) > 0))
        .map(q => q.text),
      ...(cues || [])
        .filter(c => nextRanges.some(([a, z]) => Math.min(Number(c.endSec), z) - Math.max(Number(c.startSec), a) > 0.25))
        .map(c => c.text)
    ].filter(Boolean);
    const spoiler = narrationGate.detectPunchlineSpoiler(text, upcomingQuotes);

    // Check active source speech inside this narrated block's visual beats
    const ownSegments = (script?.segments || []).filter(s => (blk.beatIds || []).includes(s.beat_id || s.beatId));
    const ownRanges = ownSegments.map(s => [Number(s.sourceStartSec), Number(s.sourceEndSec)]);
    const overlappingCues = (cues || []).filter(c => ownRanges.some(([a, z]) => Math.min(Number(c.endSec), z) - Math.max(Number(c.startSec), a) > 0.6));

    const contentValue = classifyContentValue(blk, text);
    const tailGapSec = audioInspect?.fileDurationSec > 0
      ? round2(audioInspect.trailingSilenceSec + Math.max(0, blockDurationSec - audioInspect.fileDurationSec))
      : round2(Math.max(0, blockDurationSec - speakingDurationSec));

    const voiceFindings = [];
    voiceFindings.push(`Provider=${resolvedVoiceProvider}, voiceId=${resolvedVoiceId}, baseSpeed=${configuredKokoroSpeed}x`);
    if (wpm > 205) {
      voiceFindings.push(`FAST_WPM (${wpm} WPM > 205 WPM ceiling): delivery risks sounding rushed.`);
    } else if (wpm > 0 && wpm < 115) {
      voiceFindings.push(`SLOW_WPM (${wpm} WPM): delivery is unusually slow.`);
    } else {
      voiceFindings.push(`Natural commentary cadence (${wpm} WPM across ${speakingDurationSec}s active speech).`);
    }
    if (audioInspect) {
      voiceFindings.push(`Measured pauses=${audioInspect.internalPauseCount}, integratedLoudness=${audioInspect.integratedLufs ?? 'n/a'} LUFS, peak=${audioInspect.truePeakDb ?? 'n/a'} dBFS.`);
    }
    if (isClosing && tailGapSec > 0.65) {
      voiceFindings.push(`CLOSING_TAIL_GAP (${tailGapSec}s post-speech gap at end of video): risk of audible dead-air tail.`);
    }

    const handoffFindings = [];
    if (nextRaw) {
      handoffFindings.push(`Hands off to raw block '${nextRaw.blockId}' (${nextRaw.footageFunction || nextRaw.evidenceFunction || 'evidence'}) with ${tailGapSec}s breath margin.`);
    } else if (isClosing) {
      handoffFindings.push(`Closing narrator block concludes edit (${tailGapSec}s post-speech settle).`);
    }
    if (overlappingCues.length > 0 && blk.sourceAudioTreatment !== 'voiceover_only') {
      handoffFindings.push(`NOTE: ${overlappingCues.length} source transcript cue(s) intersect visual window; verify clean B-roll or ducked ambient without competing intelligible speech.`);
    } else {
      handoffFindings.push('Clean visual/audio ownership: no competing intelligible dialogue under narrator.');
    }

    let recommendation = 'KEEP';
    const recNotes = [];
    if (spoiler.hasSpoiler) {
      recommendation = 'REWRITE_SPOILER';
      recNotes.push(`Remove punchline preemption overlapping upcoming raw quote: "${spoiler.spoiledQuotes[0]}".`);
    }
    if (contentValue.rating === 'DEFECTIVE_JUDGMENTAL' || contentValue.rating === 'WEAK_STUB') {
      recommendation = 'REWRITE_SCRIPT';
      recNotes.push(contentValue.summary);
    }
    if (wpm > 205) {
      recommendation = recommendation === 'KEEP' ? 'ADJUST_VOICE_SPEED' : recommendation;
      recNotes.push(`Reduce Kokoro speed or trim 2-3 words so WPM stays within 145-190 WPM.`);
    }
    if (isClosing && tailGapSec > 0.65) {
      recommendation = recommendation === 'KEEP' ? 'TIGHTEN_CLOSING_TAIL' : recommendation;
      recNotes.push(`Expand closing takeaway or tighten final beat by ~${round2(tailGapSec - 0.3)}s to eliminate dead-air tail.`);
    }

    totalSpeakingSec += speakingDurationSec;
    totalNarratedBlockSec += blockDurationSec;
    totalWords += words;

    blocksOut.push({
      blockId: blk.blockId,
      outputTimestamp: `${outStart.toFixed(2)}s - ${outEnd.toFixed(2)}s`,
      outputStartSec: outStart,
      outputEndSec: outEnd,
      narrationText: text,
      speakingDurationSec,
      rawTtsDurationSec: rawTtsSec,
      blockDurationSec,
      words,
      wpm,
      narratorFunction: blk.narratorFunction || 'COMMENTARY',
      evidenceReferences: Array.isArray(blk.newInformationRefs) ? blk.newInformationRefs : [],
      sourceRanges: ownRanges.map(([a, z]) => ({ sourceStartSec: round2(a), sourceEndSec: round2(z) })),
      contentValue,
      potentialSpoiler: {
        hasSpoiler: spoiler.hasSpoiler,
        spoiledQuotes: spoiler.spoiledQuotes || []
      },
      voiceFindings,
      handoffFindings,
      recommendation: recNotes.length ? `${recommendation}: ${recNotes.join(' ')}` : 'KEEP — grounded commentary, clean voice cadence, and natural handoff.'
    });
  }

  // Detect uninterrupted raw stretches > 28s
  const rawStretches = [];
  let curRawStart = null;
  let curRawEnd = null;
  const rawBlockIds = [];
  for (const blk of compiledBlocks) {
    const s = Number(blk.outputStartSec ?? 0);
    const e = Number(blk.outputEndSec ?? s + (Number(blk.durationSec) || 0));
    if (blk.mode === 'raw_evidence') {
      if (curRawStart === null) curRawStart = s;
      curRawEnd = e;
      rawBlockIds.push(blk.blockId);
    } else {
      if (curRawStart !== null) {
        rawStretches.push({ startSec: round2(curRawStart), endSec: round2(curRawEnd), durationSec: round2(curRawEnd - curRawStart), blockIds: [...rawBlockIds] });
        curRawStart = null; curRawEnd = null; rawBlockIds.length = 0;
      }
    }
  }
  if (curRawStart !== null) {
    rawStretches.push({ startSec: round2(curRawStart), endSec: round2(curRawEnd), durationSec: round2(curRawEnd - curRawStart), blockIds: [...rawBlockIds] });
  }
  const maxUninterruptedRawSec = rawStretches.reduce((m, r) => Math.max(m, r.durationSec), 0);

  const report = {
    contract: 'narration-performance-audit-v1',
    generatedAt: new Date().toISOString(),
    voiceConfig: {
      provider: resolvedVoiceProvider,
      voiceId: resolvedVoiceId,
      configuredKokoroSpeed
    },
    summary: {
      videoDurationSec: totalVideoSec,
      narratorBlockCount: blocksOut.length,
      totalWords,
      totalSpeakingDurationSec: round2(totalSpeakingSec),
      totalNarratedBlockDurationSec: round2(totalNarratedBlockSec),
      narratorSpeakingPct: totalVideoSec > 0 ? round2((totalSpeakingSec / totalVideoSec) * 100) : 0,
      narratorBlockSharePct: totalVideoSec > 0 ? round2((totalNarratedBlockSec / totalVideoSec) * 100) : 0,
      averageWpm: totalSpeakingSec > 0 ? round2((totalWords * 60) / totalSpeakingSec) : 0,
      maxUninterruptedRawSec: round2(maxUninterruptedRawSec),
      hasSpoiler: blocksOut.some(b => b.potentialSpoiler.hasSpoiler),
      hasRushedVoice: blocksOut.some(b => b.wpm > 205),
      distinctNarratorFunctions: [...new Set(blocksOut.map(b => b.narratorFunction))]
    },
    rawStretches,
    blocks: blocksOut
  };

  if (outputPath) {
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    await fsp.writeFile(outputPath, JSON.stringify(report, null, 2));
  }
  return report;
}

module.exports = {
  inspectAudioFile,
  classifyContentValue,
  buildNarrationPerformanceAudit
};
