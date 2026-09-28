const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");
const { getCancelToken, throwIfCancelled, trackChild } = require("./cancelToken");

function getDefaultVoice(language = "auto") {
  if (language === "vi" || language === "auto") {
    return "vi-VN-HoaiMyNeural";
  }
  return "en-US-JennyNeural";
}

function getFallbackVoices(language = "auto") {
  if (language === "vi" || language === "auto") {
    return ["vi-VN-HoaiMyNeural", "vi-VN-NamMinhNeural"];
  }
  return ["en-US-JennyNeural", "en-US-GuyNeural", "en-US-AriaNeural"];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (_error) {
    return 0;
  }
}

function getRateForGenre(genreMode = "thriller") {
  const rates = {
    thriller: "-4%",
    action: "+8%",
    healing: "-8%",
    drama: "-5%",
    mystery: "-4%",
    comedy: "+8%",
    "sci-fi": "default"
  };
  return rates[genreMode] || "default";
}

function formatRelativePercent(value, fallback = "default") {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && /^(?:default|x-slow|slow|medium|fast|x-fast|[+-]?\d+(?:\.\d+)?%)$/i.test(value.trim())) {
    return value.trim();
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const clamped = Math.max(-50, Math.min(100, parsed));
  return `${clamped >= 0 ? "+" : ""}${clamped}%`;
}

function formatPitch(value) {
  if (value === undefined || value === null || value === "") return "+0Hz";
  if (typeof value === "string" && /^(?:default|x-low|low|medium|high|x-high|[+-]?\d+(?:\.\d+)?(?:Hz|st|%))$/i.test(value.trim())) {
    return value.trim();
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "+0Hz";
  const clamped = Math.max(-50, Math.min(50, parsed));
  return `${clamped >= 0 ? "+" : ""}${clamped}Hz`;
}

function formatVolume(value) {
  if (value === undefined || value === null || value === "") return 100;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(150, parsed)) : 100;
}

function inferLocaleFromVoice(voiceName) {
  const match = /\b[a-z]{2}-[A-Z]{2}\b/.exec(String(voiceName || ""));
  return match ? match[0] : "";
}

function escapeXml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

class EdgeTtsService {
  async resolveVoice(voiceName, language = "auto") {
    const fallback = getDefaultVoice(language);
    const input = String(voiceName || "").trim();
    if (!input) {
      return fallback;
    }
    if (inferLocaleFromVoice(input)) {
      return input;
    }

    try {
      const voices = await this.listVoices();
      const normalized = input.toLowerCase();
      const matched = voices.find((voice) => {
        return String(voice.voice_id || "").toLowerCase() === normalized
          || String(voice.name || "").toLowerCase() === normalized
          || String(voice.name || "").toLowerCase().includes(normalized);
      });
      return matched?.voice_id || fallback;
    } catch (_error) {
      return fallback;
    }
  }

  async listVoices() {
    const tts = new MsEdgeTTS();
    const voices = await tts.getVoices();
    return voices.map((voice) => ({
      voice_id: voice.ShortName || voice.Name,
      name: voice.FriendlyName || voice.ShortName || voice.Name,
      provider: "edge_neural",
      labels: {
        locale: voice.Locale,
        gender: voice.Gender,
        category: voice.VoiceTag?.ContentCategories?.join(", ") || ""
      }
    }));
  }

  applyEmotionOffsets(emotionTag, baseRate, basePitch, baseVolume) {
    let rateMod = 0, pitchMod = 0, volMod = 0;
    switch (String(emotionTag || "").toUpperCase()) {
      case "URGENT": rateMod = 15; pitchMod = 10; volMod = 10; break;
      case "WHISPER": rateMod = -5; pitchMod = -10; volMod = -60; break;
      case "SHOUT": rateMod = 5; pitchMod = 20; volMod = 50; break;
      case "SAD": rateMod = -15; pitchMod = -15; volMod = -10; break;
      default: break;
    }
    
    // Parse current values (simple approximation for % and Hz)
    const parseNum = (val, defaultVal) => {
      const match = String(val).match(/[-+]?\d+(\.\d+)?/);
      return match ? Number(match[0]) : defaultVal;
    };
    
    let newRate = parseNum(baseRate, 0) + rateMod;
    let newPitch = parseNum(basePitch, 0) + pitchMod;
    let newVolume = (Number.isFinite(Number(baseVolume)) ? Number(baseVolume) : 100) + volMod;
    
    return {
      rate: newRate === 0 ? "default" : `${newRate >= 0 ? '+' : ''}${newRate}%`,
      pitch: newPitch === 0 ? "default" : `${newPitch >= 0 ? '+' : ''}${newPitch}Hz`,
      volume: Math.max(0, Math.min(150, newVolume))
    };
  }

  async synthesizeOnce({ text, voiceName, outputPath, language, genreMode, rate, pitch, volume, emotionTag, timeoutMs = 45000 }) {
    const token = getCancelToken();
    throwIfCancelled(token);
    const tts = new MsEdgeTTS();
    const untrack = trackChild({ kill: () => tts.close() }, token);
    const resolvedVoice = await this.resolveVoice(voiceName, language);
    try {
      await tts.setMetadata(
        resolvedVoice,
        OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3,
        { voiceLocale: inferLocaleFromVoice(resolvedVoice) || inferLocaleFromVoice(getDefaultVoice(language)) }
      );

      const finalMods = this.applyEmotionOffsets(
        emotionTag,
        formatRelativePercent(rate, getRateForGenre(genreMode)),
        formatPitch(pitch),
        formatVolume(volume)
      );

      const { audioStream } = await withTimeout(tts.toStream(escapeXml(text), {
        rate: finalMods.rate,
        volume: finalMods.volume,
        pitch: finalMods.pitch
      }), timeoutMs, "Edge TTS stream");

      await withTimeout(pipeline(audioStream, fs.createWriteStream(outputPath)), timeoutMs, "Edge TTS audio write");
      throwIfCancelled(token);
      const size = fileSize(outputPath);
      if (size < 512) {
        throw new Error(`Edge Neural Free returned an empty audio file (${size} bytes).`);
      }
      return { outputPath, voice: resolvedVoice, size };
    } finally {
      untrack();
      tts.close();
    }
  }

  async synthesizeSpeech({ text, voiceName, outputPath, language = "auto", genreMode = "thriller", rate, pitch, volume, emotionTag, retries = 3, timeoutMs = 45000 }) {
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    const preferredVoice = await this.resolveVoice(voiceName, language);
    const voiceAttempts = [
      preferredVoice,
      ...getFallbackVoices(language)
    ].filter((voice, index, voices) => voice && voices.indexOf(voice) === index);

    let lastError = null;
    const maxRetries = Math.max(1, Number(retries) || 1);
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      for (const voice of voiceAttempts) {
        await fs.promises.rm(outputPath, { force: true }).catch(() => {});
        try {
          const result = await this.synthesizeOnce({
            text,
            voiceName: voice,
            outputPath,
            language,
            genreMode,
            rate,
            pitch,
            volume,
            emotionTag,
            timeoutMs
          });
          return {
            ...result,
            requestedVoice: preferredVoice,
            resolvedVoice: result.voice,
            fallbackUsed: result.voice !== preferredVoice
          };
        } catch (error) {
          lastError = error;
        }
      }
      if (attempt < maxRetries) {
        await delay(700 * attempt);
      }
    }

    throw new Error(
      `Edge Neural Free could not produce a valid audio file after ${maxRetries} attempt(s). ` +
      `Last error: ${lastError?.message || "empty audio stream"}.`
    );
  }
}

module.exports = EdgeTtsService;
module.exports.formatRelativePercent = formatRelativePercent;
module.exports.formatPitch = formatPitch;
module.exports.formatVolume = formatVolume;
