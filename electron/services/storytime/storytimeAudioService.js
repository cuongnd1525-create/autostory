const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const RecapTtsService = require("../recap/recapTtsService");
const SubtitleService = require("../subtitleService");

function stripTtsMarkup(text = "") {
  return String(text || "")
    .replace(/<break\b[^>]*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeWordForAlign(word = "") {
  return String(word || "")
    .toLowerCase()
    .replace(/[^a-z0-9$£€]/g, "");
}

/**
 * Injects dramatic breathing pauses (<break time="300ms"/> and/or em-dashes — / semicolons ;)
 * before high-impact price figures, measurements, and rhetorical punchlines.
 */
function injectDramaticPauses(text = "", { provider = "elevenlabs", pauseMs = 300, useBreakTags = true } = {}) {
  const cleanBase = stripTtsMarkup(text);
  if (!cleanBase) {
    return { taggedText: "", ttsInputText: "", cleanDisplayText: "" };
  }

  const clampedPause = Math.max(150, Math.min(700, Math.round(Number(pauseMs) || 300)));
  const breakTag = `<break time="${clampedPause}ms"/>`;

  let punctuated = cleanBase;

  // 1. Insert em-dash before price figures preceded by action/billing verbs if not already punctuated
  punctuated = punctuated.replace(
    /\b(invoiced|charged|quoted|paid|cost|worth|billed|asking)\s+((?:[$£€]\s?\d[\d,.]*)|(?:\d[\d,.]*\s+(?:pounds|dollars|quid|bucks|grand)))\b/gi,
    "$1 — $2"
  );

  // 2. Insert em-dash before rhetorical robbery / fair-price punchlines if not already preceded by — or ;
  punctuated = punctuated.replace(
    /([^—;:,.!?])\s+\b(is that (?:absolute )?(?:daylight|highway) robbery|or is it just|worth every (?:single )?penny)\b/gi,
    "$1 — $2"
  );

  // 3. Build taggedText with <break time="300ms"/> at dramatic pause markers (—, ;) and right before standalone currency hooks
  let taggedText = punctuated
    .replace(/\s*—\s*/g, ` — ${breakTag} `)
    .replace(/;\s+/g, `; ${breakTag} `);

  // If sentence has a price figure and no break tag yet, inject a break right before the price figure
  if (!taggedText.includes("<break") && /([$£€]\s?\d[\d,.]*|\b\d[\d,.]*\s+(?:pounds|dollars|quid|bucks)\b)/i.test(taggedText)) {
    taggedText = taggedText.replace(
      /([$£€]\s?\d[\d,.]*|\b\d[\d,.]*\s+(?:pounds|dollars|quid|bucks)\b)/i,
      `${breakTag} $1`
    );
  }

  taggedText = taggedText.replace(/\s+/g, " ").trim();

  // Providers that natively parse <break time="300ms"/> (ElevenLabs) receive the full tagged text;
  // Local/prosodic engines (OmniVoice, Kokoro, Edge CLI) receive punctuation pauses (— / ;) so they never read XML tags aloud.
  const supportsSsmlBreak = provider === "elevenlabs" && useBreakTags !== false;
  const ttsInputText = supportsSsmlBreak
    ? taggedText
    : punctuated.replace(/\s+/g, " ").trim();

  return {
    taggedText,
    ttsInputText,
    cleanDisplayText: punctuated.replace(/\s+/g, " ").trim()
  };
}

class StorytimeAudioService {
  constructor(settings = {}) {
    this.settings = settings;
    this.ffmpegPath = settings.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
    this.ffprobePath = settings.ffprobePath || process.env.FFPROBE_PATH || "ffprobe";
    this.ttsService = new RecapTtsService(settings);
    this.subtitleService = new SubtitleService(settings);
  }

  static stripTtsMarkup(text) {
    return stripTtsMarkup(text);
  }

  static injectDramaticPauses(text, options) {
    return injectDramaticPauses(text, options);
  }

  async runCommand(binary, args, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { windowsHide: true });
      const stdoutChunks = [];
      const stderrChunks = [];
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`${binary} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      child.stdout.on("data", (c) => stdoutChunks.push(c));
      child.stderr.on("data", (c) => stderrChunks.push(c));
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString();
          reject(new Error(`${binary} failed (code ${code}): ${stderr.slice(-600)}`));
          return;
        }
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString(),
          stderr: Buffer.concat(stderrChunks).toString()
        });
      });
    });
  }

  async probeAudioDuration(audioPath) {
    try {
      const { stdout } = await this.runCommand(this.ffprobePath, [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        audioPath
      ], 15000);
      const val = parseFloat(stdout.trim());
      return Number.isFinite(val) ? Number(val.toFixed(3)) : 0;
    } catch (_err) {
      return 0;
    }
  }

  resolveSafeVoiceId(provider, requestedVoiceId) {
    const raw = String(requestedVoiceId || "").trim();
    if (provider === "kokoro") {
      if (raw && /^(a[fm]|b[fm])_[a-z0-9_]+$/i.test(raw)) return raw;
      const preset = String(this.settings?.lastVoiceSetup?.presetVoiceId || "").trim();
      if (preset && /^(a[fm]|b[fm])_[a-z0-9_]+$/i.test(preset)) return preset;
      return "am_adam";
    }
    if (provider === "edge_neural") {
      if (raw && /Neural$/i.test(raw)) return raw;
      return "en-US-ChristopherNeural";
    }
    if (provider === "elevenlabs") {
      return raw || this.settings?.defaultVoiceId || "pNInz6obpgDQGcFmaJgB";
    }
    if (provider === "omnivoice") {
      return raw || this.settings?.omniVoiceInstruct || "male, middle-aged, low pitch, british accent";
    }
    return raw || "am_adam";
  }

  /**
   * Aligns canonical script tokens within each segment against real acoustic word timestamps
   * extracted by faster-whisper so every word has accurate real-time audio timing AND clean script spelling.
   */
  alignSegmentsWithWhisperWords(segments = [], whisperSegments = []) {
    const flatWhisperWords = [];
    for (const wSeg of (Array.isArray(whisperSegments) ? whisperSegments : [])) {
      if (Array.isArray(wSeg.words)) {
        for (const w of wSeg.words) {
          const text = String(w.word || "").trim();
          if (!text) continue;
          flatWhisperWords.push({
            word: text,
            norm: normalizeWordForAlign(text),
            start: Number(w.start || 0),
            end: Number(w.end || 0)
          });
        }
      }
    }

    if (flatWhisperWords.length === 0) {
      return segments;
    }

    return segments.map((seg) => {
      const segStart = Number(seg.startSec || 0);
      const segEnd = Number(seg.endSec || segStart + (seg.durationSec || 3));
      const cleanText = stripTtsMarkup(seg.text || seg.dubbingLine || seg.voiceoverText || "");
      const scriptTokens = cleanText.split(/\s+/).filter(Boolean);
      if (!scriptTokens.length) return seg;

      // Find Whisper words falling inside this segment's acoustic window
      const windowWords = flatWhisperWords.filter(
        (w) => w.end > segStart - 0.08 && w.start < segEnd + 0.08
      );

      if (windowWords.length === 0) {
        return seg;
      }

      // Map script tokens to the acoustic timestamps in windowWords
      const alignedWords = [];
      const nScript = scriptTokens.length;
      const nWhisper = windowWords.length;
      let wCursor = 0;

      for (let i = 0; i < nScript; i += 1) {
        const token = scriptTokens[i];
        const normToken = normalizeWordForAlign(token);

        // Look ahead up to 2 positions in windowWords for a normalized match
        let matchedIdx = -1;
        for (let look = wCursor; look < Math.min(nWhisper, wCursor + 3); look += 1) {
          const wNorm = windowWords[look].norm;
          if (wNorm && normToken && (wNorm === normToken || wNorm.includes(normToken) || normToken.includes(wNorm))) {
            matchedIdx = look;
            break;
          }
        }

        if (matchedIdx === -1) {
          // Proportional index mapping within windowWords
          matchedIdx = Math.min(nWhisper - 1, Math.max(wCursor, Math.floor((i / nScript) * nWhisper)));
        }

        const wItem = windowWords[matchedIdx];
        wCursor = Math.min(nWhisper - 1, matchedIdx + 1);

        const prevEnd = alignedWords.length > 0 ? alignedWords[alignedWords.length - 1].end : segStart;
        const start = Math.max(prevEnd, Math.min(segEnd - 0.04, Math.max(segStart, Number(wItem.start.toFixed(3)))));
        const rawEnd = Math.max(start + 0.06, Math.min(segEnd, Number(wItem.end.toFixed(3))));
        const end = i === nScript - 1 ? Math.max(rawEnd, Number((segEnd - 0.02).toFixed(3))) : rawEnd;

        alignedWords.push({
          word: token,
          start: Number(start.toFixed(3)),
          end: Number(end.toFixed(3))
        });
      }

      return {
        ...seg,
        words: alignedWords
      };
    });
  }

  /**
   * Runs faster-whisper word-level timestamp extraction on the synthesized master voice track
   * and attaches real-time `words: [{ word, start, end }]` to each segment.
   */
  async extractWordTimestamps({ audioPath, segments = [], outputDir, onProgress }) {
    try {
      onProgress?.({ message: "Extracting real-time word-level timestamps via Whisper ASR..." });
      const asrDir = path.join(outputDir, "asr_words");
      await fs.mkdir(asrDir, { recursive: true });
      const totalDur = segments.length > 0 ? segments[segments.length - 1].endSec : 60;
      const asrResult = await this.subtitleService.transcribeToSrt({
        audioPath,
        outputDir: asrDir,
        narrationLanguage: "en",
        audioDurationSec: totalDur
      });

      if (asrResult?.wordTimestampsPath) {
        const rawWordsJson = await fs.readFile(asrResult.wordTimestampsPath, "utf8");
        const parsed = JSON.parse(rawWordsJson);
        if (Array.isArray(parsed?.segments) && parsed.segments.length > 0) {
          return this.alignSegmentsWithWhisperWords(segments, parsed.segments);
        }
      }
    } catch (_err) {
      // Fallback gracefully to weighted syllable word timing if Whisper ASR is unavailable
    }
    return segments;
  }

  /**
   * Synthesizes each segment clip with emotion stability (0.35-0.45) and automatic 300ms pause injection,
   * trims leading/trailing silence, concatenates with an 80ms breath pause, and extracts real-time word timestamps.
   */
  async synthesizeNarration({
    segments = [],
    storyText = "",
    outputDir,
    voiceProvider = "kokoro",
    voiceId = "am_adam",
    stability = 0.40,
    injectPauses = true,
    pauseMs = 300,
    enableWordTimestamps = true,
    breathGapSec = 0.08,
    signal,
    onProgress
  }) {
    await fs.mkdir(outputDir, { recursive: true });
    const provider = voiceProvider || this.settings.defaultVoiceProvider || "kokoro";
    const resolvedVoice = this.resolveSafeVoiceId(provider, voiceId);
    const clampedStability = Math.max(0.20, Math.min(0.85, Number(stability ?? this.settings.storytimeTtsStability ?? 0.40)));

    onProgress?.({
      message: `Synthesizing narration using ${provider} (${resolvedVoice}, stability=${clampedStability.toFixed(2)})...`
    });

    const fullAudioPath = path.join(outputDir, "storytime_voice_full.wav");

    if (!Array.isArray(segments) || segments.length === 0) {
      const pauseProcessed = injectPauses
        ? injectDramaticPauses(storyText || "Storytime narration.", { provider, pauseMs })
        : { ttsInputText: stripTtsMarkup(storyText), cleanDisplayText: stripTtsMarkup(storyText), taggedText: storyText };
      await this.ttsService.synthesizeRaw({
        text: pauseProcessed.ttsInputText || "Storytime narration.",
        outputPath: fullAudioPath,
        provider,
        voiceId: resolvedVoice,
        signal,
        options: {
          performanceMode: "storytime",
          stability: clampedStability
        }
      });
      const dur = await this.probeAudioDuration(fullAudioPath);
      return {
        fullAudioPath,
        totalDurationSec: dur,
        segments: []
      };
    }

    const synthesizedSegments = [];
    const concatInputs = [];
    const filterParts = [];
    let cursorSec = 0;
    const gapSec = Math.max(0, Number(breathGapSec ?? 0.08));

    const gapWavPath = path.join(outputDir, "breath_gap.wav");
    if (gapSec > 0 && segments.length > 1) {
      await this.runCommand(this.ffmpegPath, [
        "-y",
        "-f", "lavfi",
        "-i", "anullsrc=r=24000:cl=mono",
        "-t", String(gapSec),
        "-c:a", "pcm_s16le",
        gapWavPath
      ], 15000);
    }

    for (let i = 0; i < segments.length; i += 1) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const seg = segments[i];
      const segPath = path.join(outputDir, `seg_${String(i + 1).padStart(2, "0")}.wav`);

      onProgress?.({
        percent: Math.round(((i + 1) / segments.length) * 80),
        message: `Synthesizing audio segment ${i + 1}/${segments.length}...`
      });

      const rawSpokenText = String(seg.text || seg.dubbingLine || seg.voiceoverText || "").trim() || " ";
      const pauseProcessed = injectPauses
        ? injectDramaticPauses(rawSpokenText, { provider, pauseMs })
        : {
          taggedText: rawSpokenText,
          ttsInputText: stripTtsMarkup(rawSpokenText),
          cleanDisplayText: stripTtsMarkup(rawSpokenText)
        };

      await this.ttsService.synthesizeRaw({
        text: pauseProcessed.ttsInputText || " ",
        outputPath: segPath,
        provider,
        voiceId: resolvedVoice,
        signal,
        options: {
          performanceMode: "storytime",
          stability: clampedStability
        }
      });

      await this.ttsService.trimAudioSilence(segPath, segPath).catch(() => {});

      const dur = Math.max(0.2, await this.probeAudioDuration(segPath));
      const startSec = Number(cursorSec.toFixed(3));
      const endSec = Number((startSec + dur).toFixed(3));
      cursorSec = endSec + (i < segments.length - 1 ? gapSec : 0);

      synthesizedSegments.push({
        ...seg,
        index: i + 1,
        text: pauseProcessed.cleanDisplayText,
        ttsTaggedText: pauseProcessed.taggedText,
        audioPath: segPath,
        startSec,
        endSec,
        durationSec: dur,
        actualDurationSec: dur
      });

      concatInputs.push("-i", segPath);
      if (gapSec > 0 && i < segments.length - 1) {
        concatInputs.push("-i", gapWavPath);
      }
    }

    const totalInputCount = concatInputs.length / 2;
    if (totalInputCount === 1) {
      await fs.copyFile(synthesizedSegments[0].audioPath, fullAudioPath);
    } else {
      for (let idx = 0; idx < totalInputCount; idx += 1) {
        filterParts.push(`[${idx}:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=mono[a${idx}]`);
      }
      const streamLabels = Array.from({ length: totalInputCount }, (_, idx) => `[a${idx}]`).join("");
      const filterComplex = `${filterParts.join(";")};${streamLabels}concat=n=${totalInputCount}:v=0:a=1[outa]`;

      await this.runCommand(this.ffmpegPath, [
        "-y",
        ...concatInputs,
        "-filter_complex", filterComplex,
        "-map", "[outa]",
        "-c:a", "pcm_s16le",
        "-ar", "44100",
        fullAudioPath
      ], 90000);
    }

    const finalSegments = enableWordTimestamps !== false
      ? await this.extractWordTimestamps({
        audioPath: fullAudioPath,
        segments: synthesizedSegments,
        outputDir,
        onProgress
      })
      : synthesizedSegments;

    return {
      fullAudioPath,
      totalDurationSec: Number(cursorSec.toFixed(3)),
      stability: clampedStability,
      segments: finalSegments
    };
  }

  /**
   * Extracts raw Foley/ASMR audio from the source video (e.g. scraping, excavating, cleaning).
   */
  async extractFoleyAudio({ sourceVideoPath, outputPath, durationSec = 0 }) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    const args = ["-y", "-i", sourceVideoPath];
    if (durationSec > 0) {
      args.push("-t", String(durationSec));
    }
    args.push(
      "-vn",
      "-af", "highpass=f=75,lowpass=f=12000,volume=1.0",
      "-c:a", "pcm_s16le",
      "-ar", "44100",
      outputPath
    );

    await this.runCommand(this.ffmpegPath, args, 60000);
    return outputPath;
  }

  /**
   * Mixes Voiceover (at 0dB) with Source Foley ASMR (reduced volume or muted) into master audio.
   * When foleyAudioPath is null or foleyVolume <= 0, outputs pure clean voiceover (+ optional BGM).
   */
  async mixMasterAudio({
    voiceAudioPath,
    foleyAudioPath = null,
    outputPath,
    foleyVolume = 0.16, // 0 = muted, 0.10 = -20dB, 0.16 = -16dB, 0.25 = -12dB
    bgmPath = null,
    bgmVolume = 0.08,   // -22dB
    durationSec = 0
  }) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const effectiveFoleyVol = Math.max(0, Math.min(1, Number(foleyVolume ?? 0)));
    const hasFoley = Boolean(foleyAudioPath && effectiveFoleyVol > 0.001);

    // Case 1: Pure Voice (no Foley, no BGM) -> 100% muted source audio
    if (!hasFoley && !bgmPath) {
      await fs.copyFile(voiceAudioPath, outputPath);
      return outputPath;
    }

    // Case 2: Voice + BGM only (no Foley)
    if (!hasFoley && bgmPath) {
      const args = [
        "-y",
        "-i", voiceAudioPath,
        "-i", bgmPath,
        "-filter_complex", `[1:a]volume=${bgmVolume}[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=2[out]`,
        "-map", "[out]",
        "-c:a", "pcm_s16le",
        "-ar", "44100"
      ];
      if (durationSec > 0) args.push("-t", String(durationSec));
      args.push(outputPath);
      await this.runCommand(this.ffmpegPath, args, 60000);
      return outputPath;
    }

    // Case 3: Voice + Foley ASMR (+ optional BGM)
    const inputs = ["-i", voiceAudioPath, "-i", foleyAudioPath];
    let filterComplex = "";

    if (bgmPath) {
      inputs.push("-i", bgmPath);
      filterComplex = `[1:a]volume=${effectiveFoleyVol.toFixed(3)}[foley];[2:a]volume=${bgmVolume}[bgm];[0:a][foley][bgm]amix=inputs=3:duration=first:dropout_transition=2[out]`;
    } else {
      filterComplex = `[1:a]volume=${effectiveFoleyVol.toFixed(3)}[foley];[0:a][foley]amix=inputs=2:duration=first:dropout_transition=2[out]`;
    }

    const args = [
      "-y",
      ...inputs,
      "-filter_complex", filterComplex,
      "-map", "[out]",
      "-c:a", "pcm_s16le",
      "-ar", "44100"
    ];

    if (durationSec > 0) {
      args.push("-t", String(durationSec));
    }
    args.push(outputPath);

    await this.runCommand(this.ffmpegPath, args, 60000);
    return outputPath;
  }
}

StorytimeAudioService.stripTtsMarkup = stripTtsMarkup;
StorytimeAudioService.injectDramaticPauses = injectDramaticPauses;

module.exports = StorytimeAudioService;
