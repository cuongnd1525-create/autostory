const fs = require("fs/promises");
const { getCancelToken, throwIfCancelled, trackChild } = require("./cancelToken");

const RETRY_DELAYS_MS = [2000, 5000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientStatus(status) {
  return status === 429 || status >= 500;
}

function isTransientError(error) {
  return !error.status || isTransientStatus(error.status);
}

function clampSetting(value) {
  return Math.max(0, Math.min(1, Number(value)));
}

const DEFAULT_PREMADE_VOICES = [
  { voice_id: "JBFqnCBsd6RMkjVDRZzb", name: "George - Nam Anh (UK Warm / Storytime Craftsman)", labels: { accent: "british", gender: "male" } },
  { voice_id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel - Nam Anh (UK Authoritative / Documentary)", labels: { accent: "british", gender: "male" } },
  { voice_id: "pNInz6obpgDQGcFmaJgB", name: "Adam - Nam Mỹ (US Deep Narrator / Reddit Storytime)", labels: { accent: "american", gender: "male" } },
  { voice_id: "nPczCjzI2devNBz1zQrb", name: "Brian - Nam Mỹ (US Deep Resonant / Contractor)", labels: { accent: "american", gender: "male" } },
  { voice_id: "N2lVS1w4EtoT3dr4eOWO", name: "Callum - Nam (Intense / Character Storyteller)", labels: { accent: "transatlantic", gender: "male" } },
  { voice_id: "CwhRBWXzGAHq8TQ4Fs17", name: "Roger - Nam Mỹ (Confident / Casual)", labels: { accent: "american", gender: "male" } },
  { voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah - Nữ Mỹ (Natural / Clear)", labels: { accent: "american", gender: "female" } }
];

function formatElevenLabsError(label, rawMessage = "") {
  const text = String(rawMessage || "").trim();
  if (text.includes("api_key_id_used_as_api_key")) {
    return `${label} thất bại: Bạn đang dán nhầm "API Key ID" (mã định danh hiển thị ngoài bảng) thay vì "API Key" thực tế. API Key hợp lệ của ElevenLabs bắt buộc phải bắt đầu bằng "sk_..." (chỉ hiển thị 1 lần lúc bấm Create API Key hoặc Rotate Key trên trang ElevenLabs).`;
  }
  if (text.includes("invalid_api_key")) {
    return `${label} thất bại: API Key ElevenLabs không hợp lệ hoặc đã bị thu hồi. Hãy kiểm tra lại mã bắt đầu bằng "sk_..." trong Cài đặt.`;
  }
  return `${label} failed: ${text}`;
}

class ElevenLabsService {
  constructor(apiKey, modelId, settings = {}) {
    const cleanKey = String(apiKey || "").trim().replace(/^["']+|["']+$/g, "");
    if (!cleanKey) {
      throw new Error("Chưa có ElevenLabs API Key. Hãy nhập mã bắt đầu bằng 'sk_...' trong Cài đặt.");
    }
    this.apiKey = cleanKey;
    this.modelId = modelId || "eleven_multilingual_v2";
    this.baseUrl = "https://api.elevenlabs.io/v1";
    this.settings = settings || {};
  }

  async fetchWithRetry(makeRequest, label) {
    let lastError = null;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      const token = getCancelToken();
      throwIfCancelled(token);
      const controller = new AbortController();
      const untrack = trackChild({ kill: () => controller.abort() }, token);
      try {
        const response = await makeRequest(controller.signal);
        if (response.ok) {
          untrack();
          return response;
        }

        const message = await response.text();
        const error = new Error(formatElevenLabsError(label, message));
        error.rawDetail = message;
        error.status = response.status;
        if (!isTransientStatus(response.status) || attempt === RETRY_DELAYS_MS.length) {
          throw error;
        }
        lastError = error;
      } catch (error) {
        if (token?.cancelled) {
          throwIfCancelled(token);
        }
        if (!isTransientError(error) || attempt === RETRY_DELAYS_MS.length) {
          throw error;
        }
        lastError = error;
      } finally {
        untrack();
      }

      await sleep(RETRY_DELAYS_MS[attempt]);
    }

    throw lastError;
  }

  async runWithRetry(makeOperation, label) {
    let lastError = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return await makeOperation();
      } catch (error) {
        if (!isTransientError(error) || attempt === RETRY_DELAYS_MS.length) {
          throw error;
        }
        lastError = error;
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
    throw lastError || new Error(`${label} failed.`);
  }

  async listVoices() {
    try {
      const response = await this.fetchWithRetry((signal) => fetch(`${this.baseUrl}/voices`, {
        signal,
        headers: {
          "xi-api-key": this.apiKey
        }
      }), "ElevenLabs voice list");
      const payload = await response.json();
      return payload.voices?.length ? payload.voices : DEFAULT_PREMADE_VOICES;
    } catch (error) {
      if (String(error?.rawDetail || error?.message || "").includes("missing_permissions")) {
        return DEFAULT_PREMADE_VOICES;
      }
      throw error;
    }
  }

  buildVoiceSettings(performanceMode = "narration", genreMode = "thriller", emotionTag = "", overrides = {}) {
    if (Number.isFinite(Number(overrides?.stability))) {
      return {
        stability: clampSetting(overrides.stability),
        similarity_boost: clampSetting(overrides.similarityBoost ?? this.settings.elevenLabsSimilarityBoost ?? 0.78),
        style: clampSetting(overrides.style ?? this.settings.elevenLabsStyle ?? 0.62),
        use_speaker_boost: overrides.speakerBoost !== undefined
          ? Boolean(overrides.speakerBoost)
          : (this.settings.elevenLabsSpeakerBoost !== false)
      };
    }

    if (this.settings.elevenLabsVoiceSettingsMode === "custom") {
      return {
        stability: clampSetting(this.settings.elevenLabsStability ?? 0.40),
        similarity_boost: clampSetting(this.settings.elevenLabsSimilarityBoost ?? 0.78),
        style: clampSetting(this.settings.elevenLabsStyle ?? 0.58),
        use_speaker_boost: this.settings.elevenLabsSpeakerBoost !== false
      };
    }

    let settings;
    
    // Emotion tags override the base performance mode settings
    const e = String(emotionTag || "").toUpperCase();
    if (e === "URGENT" || e === "SHOUT") {
      performanceMode = "panic";
    } else if (e === "SAD" || e === "WHISPER") {
      performanceMode = "narration";
    }

    if (performanceMode === "storytime") {
      return {
        stability: clampSetting(this.settings.storytimeTtsStability ?? 0.40),
        similarity_boost: clampSetting(this.settings.elevenLabsSimilarityBoost ?? 0.78),
        style: clampSetting(this.settings.elevenLabsStyle ?? 0.62),
        use_speaker_boost: true
      };
    }

    if (performanceMode === "hook") {
      settings = {
        stability: 0.22,
        similarity_boost: 0.74,
        style: 0.72,
        use_speaker_boost: true
      };
    } else if (performanceMode === "panic") {
      settings = {
        stability: 0.15,
        similarity_boost: 0.85,
        style: 0.90,
        use_speaker_boost: true
      };
    } else if (performanceMode === "story") {
      settings = {
        stability: 0.32,
        similarity_boost: 0.78,
        style: 0.58,
        use_speaker_boost: true
      };
    } else if (performanceMode === "cliffhanger") {
      settings = {
        stability: 0.30,
        similarity_boost: 0.78,
        style: 0.60,
        use_speaker_boost: true
      };
    } else {
      settings = {
        stability: 0.34,
        similarity_boost: 0.78,
        style: 0.52,
        use_speaker_boost: true
      };
    }

    if (e === "WHISPER") {
       settings.style = 0.95; // Extreme style exxageration for whisper
    }

    const genreAdjustments = {
      thriller: { stability: -0.06, similarity_boost: -0.02, style: 0.08 },
      action: { stability: -0.05, similarity_boost: -0.04, style: 0.12 },
      drama: { stability: -0.02, similarity_boost: -0.01, style: 0.05 },
      mystery: { stability: -0.04, similarity_boost: -0.01, style: 0.06 },
      comedy: { stability: -0.03, similarity_boost: 0, style: 0.10 },
      horror: { stability: -0.08, similarity_boost: -0.03, style: 0.15 },
      healing: { stability: 0.05, similarity_boost: 0.02, style: -0.05 }
    };

    const adjustment = genreAdjustments[genreMode] || { stability: 0, similarity_boost: 0, style: 0 };

    return {
      stability: clampSetting(settings.stability + adjustment.stability),
      similarity_boost: clampSetting(settings.similarity_boost + adjustment.similarity_boost),
      style: clampSetting(settings.style + adjustment.style),
      use_speaker_boost: settings.use_speaker_boost
    };
  }

  async synthesizeSpeech({
    text,
    voiceId,
    outputPath,
    languageCode,
    performanceMode,
    genreMode,
    emotionTag,
    stability,
    similarityBoost,
    style,
    speakerBoost
  }) {
    if (!voiceId) {
      throw new Error("Voice ID is missing. Select or paste an ElevenLabs voice ID.");
    }

    const voiceSettings = this.buildVoiceSettings(performanceMode, genreMode, emotionTag, {
      stability,
      similarityBoost,
      style,
      speakerBoost
    });

    const audioBuffer = await this.runWithRetry(async () => {
      const response = await this.fetchWithRetry((signal) => fetch(`${this.baseUrl}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
        signal,
        method: "POST",
        headers: {
          "xi-api-key": this.apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg"
        },
        body: JSON.stringify({
          text,
          model_id: this.modelId,
          voice_settings: voiceSettings
        })
      }), "ElevenLabs TTS");
      return Buffer.from(await response.arrayBuffer());
    }, "ElevenLabs TTS body");
    await fs.writeFile(outputPath, audioBuffer);
    return outputPath;
  }

  async synthesizeSpeechWithTimestamps({
    text,
    voiceId,
    outputPath,
    alignmentPath,
    performanceMode,
    genreMode,
    emotionTag
  }) {
    if (!voiceId) {
      throw new Error("Voice ID is missing. Select or paste an ElevenLabs voice ID.");
    }

    const payload = await this.runWithRetry(async () => {
      const response = await this.fetchWithRetry((signal) => fetch(`${this.baseUrl}/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
        signal,
        method: "POST",
        headers: {
          "xi-api-key": this.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          text,
          model_id: this.modelId,
          voice_settings: this.buildVoiceSettings(performanceMode || "story", genreMode, emotionTag)
        })
      }), "ElevenLabs timed TTS");
      return response.json();
    }, "ElevenLabs timed TTS body");
    const audioBuffer = Buffer.from(payload.audio_base64, "base64");
    await fs.writeFile(outputPath, audioBuffer);
    if (alignmentPath) {
      await fs.writeFile(alignmentPath, JSON.stringify(payload, null, 2), "utf8");
    }
    return {
      outputPath,
      alignment: payload.normalized_alignment || payload.alignment || null,
      rawResponse: payload
    };
  }
}

module.exports = ElevenLabsService;
