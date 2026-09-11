const fs = require("fs/promises");
const path = require("path");

function safeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function normalizeId(value) {
  return safeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function splitWords(text) {
  return safeText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);
}

function unique(values) {
  const list = Array.isArray(values) ? values : safeText(values).split(/[,\n]/);
  return Array.from(new Set(list.map((value) => safeText(value)).filter(Boolean)));
}

function inferConfidence({ hasTranscript, visualTags, motionScore, source }) {
  let score = 0.2;
  if (hasTranscript) score += 0.22;
  if (visualTags.length) score += Math.min(0.25, visualTags.length * 0.045);
  if (motionScore > 0) score += Math.min(0.16, motionScore / 100);
  if (source === "transcript") score += 0.18;
  if (source === "visual_tags") score += 0.08;
  if (source === "fallback") score -= 0.12;
  return Number(clamp(score, 0.05, 0.95).toFixed(3));
}

function normalizeScene(scene = {}, index = 0) {
  const startSec = safeNumber(scene.startSec ?? scene.start ?? scene.start_seconds, 0);
  const endSec = safeNumber(scene.endSec ?? scene.end ?? scene.end_seconds, startSec + safeNumber(scene.duration_seconds ?? scene.duration, 0));
  const duration = Math.max(0, safeNumber(scene.duration_seconds ?? scene.duration, endSec - startSec));
  const sceneId = safeText(scene.sceneId || scene.scene_id || scene.id, `scene_${String(index + 1).padStart(4, "0")}`);
  const transcript = safeText(scene.audioTranscript || scene.audio_transcript || scene.transcript || scene.text);
  const visualTags = unique(scene.localVisualTags || scene.local_visual_tags || scene.visualTags || scene.objects || []);
  const motionScore = safeNumber(scene.motion_score || scene.motionScore, 0);
  return {
    raw: scene,
    sceneId,
    startSec,
    endSec: Math.max(startSec + 0.001, endSec || startSec + duration),
    durationSeconds: duration || Math.max(0, endSec - startSec),
    timestamp: safeText(scene.timestamp, `${startSec.toFixed(3)} -> ${Math.max(startSec, endSec).toFixed(3)}`),
    transcript,
    visualTags,
    motionIntensity: safeText(scene.motionIntensity || scene.motion_intensity || "UNKNOWN"),
    motionScore,
    audioEnergy: safeText(scene.audioEnergy || scene.audio_energy || "UNKNOWN"),
    lightChange: safeText(scene.lightChange || scene.light_change || "UNKNOWN"),
    lightChangeScore: safeNumber(scene.light_change_score || scene.lightChangeScore, 0),
    reframe: scene.reframe || null
  };
}

function buildActionCaption(scene) {
  const transcript = scene.transcript;
  const tags = scene.visualTags;
  const actionTags = tags.filter((tag) => /run|fight|attack|hide|walk|look|talk|shoot|fall|chase|escape|open|enter|creature|monster|robot|android|predator|person|woman|man/i.test(tag));
  const motion = scene.motionIntensity.toUpperCase();
  const light = scene.lightChange.toUpperCase();
  if (transcript) {
    const shortTranscript = transcript.length > 180 ? `${transcript.slice(0, 177)}...` : transcript;
    return `Scene contains dialogue/transcript evidence: "${shortTranscript}"`;
  }
  if (actionTags.length) {
    return `Visible evidence suggests: ${actionTags.slice(0, 6).join(", ")}.`;
  }
  if (motion === "HIGH") {
    return "Scene has high motion, suggesting an active visual event, but the exact action is not confirmed.";
  }
  if (light === "FLASH") {
    return "Scene has a strong light change/flash, but the exact action is not confirmed.";
  }
  if (tags.length) {
    return `Visible tags detected: ${tags.slice(0, 6).join(", ")}.`;
  }
  return "No reliable visual action caption is available for this scene.";
}

function makeEvidenceId(sceneId, type, index) {
  return `ev_${normalizeId(sceneId)}_${type}_${String(index + 1).padStart(2, "0")}`;
}

function buildObjects(scene) {
  return scene.visualTags.map((tag, index) => ({
    objectId: `obj_${normalizeId(scene.sceneId)}_${String(index + 1).padStart(2, "0")}`,
    label: tag,
    source: "local_visual_tags",
    confidence: inferConfidence({
      hasTranscript: Boolean(scene.transcript),
      visualTags: [tag],
      motionScore: scene.motionScore,
      source: "visual_tags"
    })
  }));
}

function buildCharacterCandidates(scene) {
  const tags = scene.visualTags.join(" ").toLowerCase();
  const transcriptTokens = splitWords(scene.transcript);
  const candidates = [];
  if (/\b(person|man|woman|boy|girl|child|face|human)\b/.test(tags)) {
    candidates.push({
      candidateId: `char_candidate_${normalizeId(scene.sceneId)}_person`,
      label: "unknown_person",
      visualProfile: scene.visualTags.filter((tag) => /person|man|woman|boy|girl|face|human|clothes|hair/i.test(tag)).slice(0, 8),
      firstAppearanceSceneId: scene.sceneId,
      confidence: inferConfidence({
        hasTranscript: Boolean(scene.transcript),
        visualTags: scene.visualTags,
        motionScore: scene.motionScore,
        source: "visual_tags"
      }),
      evidenceIds: []
    });
  }
  const possibleNames = transcriptTokens.filter((token) => /^[A-ZÀ-Ỹ]/.test(token)).slice(0, 4);
  for (const name of possibleNames) {
    candidates.push({
      candidateId: `char_candidate_${normalizeId(scene.sceneId)}_${normalizeId(name)}`,
      label: name,
      visualProfile: [],
      firstAppearanceSceneId: scene.sceneId,
      confidence: 0.25,
      evidenceIds: []
    });
  }
  return candidates;
}

function buildSceneEvidence(scene, index) {
  const evidence = [];
  const visualCaption = buildActionCaption(scene);
  evidence.push({
    evidenceId: makeEvidenceId(scene.sceneId, "visual", evidence.length),
    sceneId: scene.sceneId,
    type: "visual",
    timestamp: scene.timestamp,
    startSec: scene.startSec,
    endSec: scene.endSec,
    text: visualCaption,
    facts: visualCaption.startsWith("Scene contains dialogue/transcript evidence") ? [visualCaption] : [],
    hypotheses: visualCaption.startsWith("Scene contains dialogue/transcript evidence") ? [] : [visualCaption],
    source: scene.visualTags.length ? "local_visual_tags" : "fallback",
    confidence: inferConfidence({
      hasTranscript: Boolean(scene.transcript),
      visualTags: scene.visualTags,
      motionScore: scene.motionScore,
      source: scene.visualTags.length ? "visual_tags" : "fallback"
    }),
    metadata: {
      localVisualTags: scene.visualTags,
      motionIntensity: scene.motionIntensity,
      motionScore: scene.motionScore,
      lightChange: scene.lightChange,
      lightChangeScore: scene.lightChangeScore,
      reframe: scene.reframe
    }
  });
  if (scene.transcript) {
    evidence.push({
      evidenceId: makeEvidenceId(scene.sceneId, "dialogue", evidence.length),
      sceneId: scene.sceneId,
      type: "dialogue",
      timestamp: scene.timestamp,
      startSec: scene.startSec,
      endSec: scene.endSec,
      text: scene.transcript,
      facts: [scene.transcript],
      hypotheses: [],
      source: "transcript",
      confidence: inferConfidence({
        hasTranscript: true,
        visualTags: scene.visualTags,
        motionScore: scene.motionScore,
        source: "transcript"
      }),
      metadata: {
        audioEnergy: scene.audioEnergy
      }
    });
  }
  if (scene.motionIntensity !== "UNKNOWN" || scene.audioEnergy !== "UNKNOWN" || scene.lightChange !== "UNKNOWN") {
    evidence.push({
      evidenceId: makeEvidenceId(scene.sceneId, "signal", evidence.length),
      sceneId: scene.sceneId,
      type: "signal",
      timestamp: scene.timestamp,
      startSec: scene.startSec,
      endSec: scene.endSec,
      text: `Scene signal: motion=${scene.motionIntensity}, audio=${scene.audioEnergy}, light=${scene.lightChange}.`,
      facts: [],
      hypotheses: [`Scene intensity may be ${scene.motionIntensity.toLowerCase()} based on local signal metrics.`],
      source: "local_signal_metrics",
      confidence: inferConfidence({
        hasTranscript: Boolean(scene.transcript),
        visualTags: scene.visualTags,
        motionScore: scene.motionScore,
        source: "visual_tags"
      }),
      metadata: {
        motionIntensity: scene.motionIntensity,
        motionScore: scene.motionScore,
        audioEnergy: scene.audioEnergy,
        lightChange: scene.lightChange,
        lightChangeScore: scene.lightChangeScore
      }
    });
  }
  return evidence.map((entry, entryIndex) => ({
    ...entry,
    index: entryIndex,
    evidenceLevel: entry.confidence >= 0.72 ? "strong" : entry.confidence >= 0.45 ? "medium" : "weak"
  }));
}

class EvidenceStoreService {
  constructor(settings = {}) {
    this.settings = settings;
  }

  build({ sceneMetadata = {}, project = {}, videoPath = "" }) {
    const scenes = (Array.isArray(sceneMetadata.scenes) ? sceneMetadata.scenes : [])
      .map((scene, index) => normalizeScene(scene, index));
    const evidenceScenes = scenes.map((scene, index) => {
      const evidence = buildSceneEvidence(scene, index);
      const characterCandidates = buildCharacterCandidates(scene).map((candidate) => ({
        ...candidate,
        evidenceIds: evidence.map((entry) => entry.evidenceId).slice(0, 2)
      }));
      return {
        sceneId: scene.sceneId,
        timestamp: scene.timestamp,
        startSec: scene.startSec,
        endSec: scene.endSec,
        durationSeconds: scene.durationSeconds,
        visualCaptions: evidence.filter((entry) => entry.type === "visual").map((entry) => ({
          evidenceId: entry.evidenceId,
          text: entry.text,
          confidence: entry.confidence,
          evidenceLevel: entry.evidenceLevel
        })),
        transcript: {
          text: scene.transcript,
          confidence: scene.transcript ? 0.82 : 0,
          source: scene.transcript ? "transcript" : "none"
        },
        objects: buildObjects(scene),
        actions: evidence.filter((entry) => entry.type === "visual").map((entry) => ({
          actionId: `act_${normalizeId(entry.evidenceId)}`,
          description: entry.text,
          evidenceId: entry.evidenceId,
          confidence: entry.confidence
        })),
        emotion: {
          label: "",
          confidence: 0,
          note: "Phase 1 does not assert emotion without stronger visual/character tracking evidence."
        },
        characterCandidates,
        confidence: evidence.length
          ? Number((evidence.reduce((sum, entry) => sum + entry.confidence, 0) / evidence.length).toFixed(3))
          : 0,
        evidence
      };
    });
    const allEvidence = evidenceScenes.flatMap((scene) => scene.evidence);
    const weakScenes = evidenceScenes
      .filter((scene) => scene.confidence < 0.45)
      .map((scene) => ({
        sceneId: scene.sceneId,
        confidence: scene.confidence,
        reason: "Insufficient transcript/visual action evidence."
      }));
    return {
      schemaVersion: "evidence-store.v1",
      generatedAt: new Date().toISOString(),
      projectId: project.id || project.projectId || "",
      video: {
        path: videoPath || project.sourceVideoPath || "",
        title: project.title || ""
      },
      policy: {
        priority: ["Accuracy", "Grounding", "Story Coherence", "Retention", "Virality"],
        factRule: "Only evidence entries are truth. AI outputs are hypotheses unless supported by evidenceIds.",
        hypothesisLanguage: ["dường như", "có vẻ", "có thể"]
      },
      sources: {
        sceneMetadataProvider: sceneMetadata.provider || "unknown",
        transcriptProvider: sceneMetadata.transcriptProvider || sceneMetadata.transcript?.provider || "unknown",
        transcriptError: sceneMetadata.transcriptError || sceneMetadata.transcript?.error || ""
      },
      scenes: evidenceScenes,
      evidence: allEvidence,
      facts: allEvidence.flatMap((entry) => entry.facts.map((fact) => ({
        factId: `fact_${normalizeId(entry.evidenceId)}_${normalizeId(fact).slice(0, 20)}`,
        evidenceId: entry.evidenceId,
        sceneId: entry.sceneId,
        text: fact,
        confidence: entry.confidence
      }))),
      hypotheses: allEvidence.flatMap((entry) => entry.hypotheses.map((hypothesis) => ({
        hypothesisId: `hyp_${normalizeId(entry.evidenceId)}_${normalizeId(hypothesis).slice(0, 20)}`,
        evidenceId: entry.evidenceId,
        sceneId: entry.sceneId,
        text: hypothesis,
        confidence: Math.min(entry.confidence, 0.62)
      }))),
      report: {
        sceneCount: evidenceScenes.length,
        evidenceCount: allEvidence.length,
        strongEvidenceCount: allEvidence.filter((entry) => entry.evidenceLevel === "strong").length,
        mediumEvidenceCount: allEvidence.filter((entry) => entry.evidenceLevel === "medium").length,
        weakEvidenceCount: allEvidence.filter((entry) => entry.evidenceLevel === "weak").length,
        weakScenes,
        warnings: [
          weakScenes.length ? `${weakScenes.length} scene(s) have weak evidence and must not be narrated as confirmed facts.` : "",
          sceneMetadata.transcriptError ? `Transcript warning: ${sceneMetadata.transcriptError}` : ""
        ].filter(Boolean)
      }
    };
  }

  async buildAndWrite({ sceneMetadata, project, videoPath, outputPath }) {
    const store = this.build({ sceneMetadata, project, videoPath });
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(store, null, 2), "utf8");
    return {
      evidenceStorePath: outputPath,
      evidenceStore: store
    };
  }
}

module.exports = {
  EvidenceStoreService,
  normalizeScene,
  buildSceneEvidence
};
