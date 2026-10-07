const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

function safeText(value, fallback = "") {
  return String(value || fallback).replace(/\s+/g, " ").trim();
}

function countWords(text) {
  return safeText(text).split(/\s+/).filter(Boolean).length;
}

function clamp(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

function getProviderModel({ provider, settings = {} }) {
  if (provider === "elevenlabs") return settings.elevenLabsModel || "eleven_multilingual_v2";
  if (provider === "omnivoice") return settings.omniVoiceModel || "k2-fsa/OmniVoice";
  if (provider === "kokoro") return settings.kokoroModel || "hexgrad/Kokoro-82M";
  if (provider === "windows_local") return "windows_sapi";
  return "edge_neural";
}

function buildProviderTuning({ provider, settings = {}, project = {} }) {
  if (provider === "elevenlabs") {
    return {
      settingsMode: settings.elevenLabsVoiceSettingsMode || "auto",
      stability: Number(settings.elevenLabsStability ?? 0.32),
      similarityBoost: Number(settings.elevenLabsSimilarityBoost ?? 0.78),
      style: Number(settings.elevenLabsStyle ?? 0.58),
      speakerBoost: settings.elevenLabsSpeakerBoost !== false,
      genreMode: project.genreMode || "drama"
    };
  }
  if (provider === "omnivoice") {
    return {
      device: settings.omniVoiceDevice || "",
      instruct: settings.omniVoiceInstruct || "",
      numStep: Number(project.omniVoiceNumStep || settings.omniVoiceNumStep || 8),
      cloneSourceVoice: Boolean(project.cloneSourceVoice)
    };
  }
  if (provider === "kokoro") {
    return {
      device: settings.kokoroDevice || "",
      preset: settings.kokoroVoicePreset || "natural",
      speed: Number(settings.kokoroSpeed || 1)
    };
  }
  if (provider === "windows_local") {
    return { rate: Number(project.windowsVoiceRate || settings.windowsVoiceRate || 0) };
  }
  return {
    preset: settings.edgeVoicePreset || "natural",
    rate: Number(project.edgeVoiceRate ?? settings.edgeVoiceRate ?? 0),
    pitchHz: Number(project.edgeVoicePitchHz ?? settings.edgeVoicePitchHz ?? 0),
    volume: Number(project.edgeVoiceVolume ?? settings.edgeVoiceVolume ?? 100),
    genreMode: project.genreMode || "drama"
  };
}

function percentile(values = [], ratio = 0.5) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

class VoiceProfileService {
  constructor(fileName = "voice-profiles.json") {
    this.fileName = fileName;
  }

  getProfilePath(workspaceRoot) {
    return path.join(workspaceRoot, ".cineviral", this.fileName);
  }

  buildProfileKey({ settings = {}, project = {}, provider, voiceId = "", language = "auto", style = "" }) {
    const resolvedProvider = provider || project.voiceProvider || settings.defaultVoiceProvider || "edge_neural";
    const resolvedVoiceId = resolvedProvider === "kokoro"
      ? voiceId || project.voiceId || "af_heart"
      : voiceId || project.voiceId || settings.defaultVoiceId || settings.defaultWindowsVoice || "";
    const model = getProviderModel({ provider: resolvedProvider, settings });
    const resolvedLanguage = safeText(language || project.targetLanguage || project.narrationLanguage || project.language || "auto").toLowerCase();
    const resolvedStyle = safeText(style || project.genreMode || project.style || "default").toLowerCase();
    const identity = {
      provider: resolvedProvider,
      voiceId: resolvedVoiceId,
      model,
      language: resolvedLanguage,
      style: resolvedStyle,
      tuning: buildProviderTuning({
        provider: resolvedProvider,
        settings,
        project
      })
    };
    const hash = crypto.createHash("sha1").update(JSON.stringify(identity)).digest("hex").slice(0, 16);
    return { key: hash, identity };
  }

  async readStore(workspaceRoot) {
    const profilePath = this.getProfilePath(workspaceRoot);
    try {
      const parsed = JSON.parse(await fs.readFile(profilePath, "utf8"));
      return {
        version: 2,
        profiles: parsed && typeof parsed.profiles === "object" ? parsed.profiles : {}
      };
    } catch (_error) {
      return { version: 2, profiles: {} };
    }
  }

  async writeStore(workspaceRoot, store) {
    const profilePath = this.getProfilePath(workspaceRoot);
    await fs.mkdir(path.dirname(profilePath), { recursive: true });
    const tempPath = `${profilePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify({ ...store, version: 2 }, null, 2), "utf8");
    try {
      await fs.rename(tempPath, profilePath);
    } catch (error) {
      if (!["EEXIST", "EPERM"].includes(error.code)) {
        await fs.rm(tempPath, { force: true }).catch(() => {});
        throw error;
      }
      await fs.rm(profilePath, { force: true });
      await fs.rename(tempPath, profilePath);
    }
  }

  async getProfile(workspaceRoot, identityPayload) {
    const store = await this.readStore(workspaceRoot);
    const { key, identity } = this.buildProfileKey(identityPayload);
    return store.profiles[key] || {
      key,
      identity,
      sampleCount: 0,
      wordsPerSecond: 2.35,
      conservativeWordsPerSecond: 2.35,
      avgDurationSec: 0,
      updatedAt: ""
    };
  }

  async recordSample(workspaceRoot, identityPayload, options = {}) {
    // Serialize read-modify-write of the shared profile store: concurrent
    // variant renders would otherwise drop samples or collide on temp files.
    const previousWrite = this.recordQueue || Promise.resolve();
    const operation = previousWrite.catch(() => {}).then(() => this.recordSampleUnlocked(workspaceRoot, identityPayload, options));
    this.recordQueue = operation;
    return operation;
  }

  async recordSampleUnlocked(workspaceRoot, identityPayload, { text, measuredDurationSec, segmentDurationSec = 0, source = "tts" } = {}) {
    const wordCount = countWords(text);
    const duration = Number(measuredDurationSec || 0);
    if (wordCount < 2 || !Number.isFinite(duration) || duration <= 0.25) {
      return this.getProfile(workspaceRoot, identityPayload);
    }

    const store = await this.readStore(workspaceRoot);
    const { key, identity } = this.buildProfileKey(identityPayload);
    const previous = store.profiles[key] || {
      key,
      identity,
      sampleCount: 0,
      wordsPerSecond: 2.35,
      avgDurationSec: 0,
      samples: []
    };
    const measuredWordsPerSecond = clamp(wordCount / duration, 0.8, 5.2);
    const sample = {
      at: new Date().toISOString(),
      source,
      wordCount,
      measuredDurationSec: Number(duration.toFixed(3)),
      segmentDurationSec: Number(Number(segmentDurationSec || 0).toFixed(3)),
      wordsPerSecond: Number(measuredWordsPerSecond.toFixed(3))
    };
    const samples = [sample, ...(previous.samples || [])].slice(0, 50);
    const sampleSpeeds = samples.map((item) => Number(item.wordsPerSecond)).filter(Number.isFinite);
    const sampleDurations = samples.map((item) => Number(item.measuredDurationSec)).filter(Number.isFinite);
    const wordsPerSecond = percentile(sampleSpeeds, 0.5) || measuredWordsPerSecond;
    // A lower WPS produces a safer, smaller word budget for slow samples.
    const conservativeWordsPerSecond = percentile(sampleSpeeds, 0.2) || wordsPerSecond;
    const avgDurationSec = sampleDurations.length
      ? sampleDurations.reduce((sum, value) => sum + value, 0) / sampleDurations.length
      : duration;
    const updated = {
      ...previous,
      key,
      identity,
      sampleCount: (previous.sampleCount || 0) + 1,
      wordsPerSecond: Number(wordsPerSecond.toFixed(3)),
      conservativeWordsPerSecond: Number(conservativeWordsPerSecond.toFixed(3)),
      avgDurationSec: Number(avgDurationSec.toFixed(3)),
      updatedAt: sample.at,
      samples
    };
    store.profiles[key] = updated;
    await this.writeStore(workspaceRoot, store);
    return updated;
  }

  getTargetWordRange(durationSec, profile, { minCoverage = 0.85, maxCoverage = 1.0 } = {}) {
    const duration = Math.max(0.3, Number(durationSec || 0));
    const wps = clamp(profile?.conservativeWordsPerSecond || profile?.wordsPerSecond || 2.35, 1.2, 4.2);
    return [
      Math.max(2, Math.ceil(duration * minCoverage * wps)),
      Math.max(3, Math.floor(duration * maxCoverage * wps))
    ];
  }
}

module.exports = VoiceProfileService;
