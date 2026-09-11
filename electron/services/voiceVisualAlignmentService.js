const fs = require("fs/promises");

function safeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function tokenize(text) {
  const stopwords = new Set([
    "the", "and", "that", "this", "with", "from", "into", "then", "when", "while", "but", "because",
    "một", "của", "và", "là", "khi", "nhưng", "rồi", "này", "đó", "cho", "với", "trong", "đang"
  ]);
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !stopwords.has(word));
}

function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  return intersection / Math.max(1, a.size + b.size - intersection);
}

function estimateSpeechSeconds(text, voiceSpeed = 1) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  const wordsPerSecond = 2.55 * Math.max(0.65, Math.min(1.6, Number(voiceSpeed || 1)));
  return words / wordsPerSecond;
}

function getVisualText(segment) {
  const metadata = segment.metadataSummary || {};
  return [
    segment.description,
    segment.reason,
    segment.screenText,
    segment.beatPurpose,
    segment.continuityNote,
    metadata.audioTranscript,
    metadata.motionIntensity,
    metadata.audioEnergy,
    metadata.lightChange,
    ...(Array.isArray(metadata.localVisualTags) ? metadata.localVisualTags : []),
    ...(Array.isArray(segment.keywords) ? segment.keywords : [])
  ].filter(Boolean).join(" ");
}

class VoiceVisualAlignmentService {
  inspect({ segments, targetDuration, voiceSpeed = 1 }) {
    const inspectedSegments = (Array.isArray(segments) ? segments : []).map((segment, index) => {
      const narration = safeText(segment.narrationLine || segment.subtitleText);
      const visualText = getVisualText(segment);
      const narrationTokens = tokenize(narration);
      const visualTokens = tokenize(visualText);
      const semanticOverlap = jaccard(narrationTokens, visualTokens);
      const estimatedSpeechSec = Number(segment.rawAudioDuration || estimateSpeechSeconds(narration, voiceSpeed));
      const renderDuration = Math.max(0.3, Number(segment.renderDuration || segment.clipDuration || estimatedSpeechSec || 0.3));
      const durationRatio = estimatedSpeechSec / renderDuration;
      const issues = [];
      if (narration && semanticOverlap < 0.045 && narrationTokens.length >= 4 && visualTokens.length >= 4) {
        issues.push({
          severity: "warning",
          code: "low_voice_visual_match",
          message: `Narration may not match the visual beat well enough.`
        });
      }
      if (durationRatio > 1.12) {
        issues.push({
          severity: "error",
          code: "voice_too_long_for_visual",
          message: `Voice is ${estimatedSpeechSec.toFixed(2)}s for a ${renderDuration.toFixed(2)}s visual block.`
        });
      } else if (durationRatio < 0.58 && narrationTokens.length > 0) {
        issues.push({
          severity: "warning",
          code: "voice_too_short_for_visual",
          message: `Voice is short for this visual block; pacing may feel empty.`
        });
      }
      if (segment.narrativeBeat && segment.beatPurpose && narrationTokens.length > 0) {
        const beatOverlap = jaccard(narrationTokens, tokenize(segment.beatPurpose));
        if (beatOverlap < 0.02 && String(segment.beatPurpose).split(/\s+/).length >= 4) {
          issues.push({
            severity: "warning",
            code: "beat_purpose_mismatch",
            message: `Narration may not satisfy the ${segment.narrativeBeat} beat purpose.`
          });
        }
      }
      return {
        index,
        role: segment.role,
        narrativeBeat: segment.narrativeBeat || segment.role,
        timelineStart: Number(segment.timelineStart || 0),
        timelineEnd: Number(segment.timelineEnd || 0),
        renderDuration,
        estimatedSpeechSec,
        rawAudioDuration: Number(segment.rawAudioDuration || 0),
        durationRatio: Number(durationRatio.toFixed(3)),
        semanticOverlap: Number(semanticOverlap.toFixed(3)),
        narrationPreview: narration.slice(0, 180),
        visualSummary: visualText.slice(0, 240),
        issues
      };
    });

    const issues = inspectedSegments.flatMap((segment) =>
      segment.issues.map((issue) => ({
        ...issue,
        segmentIndex: segment.index,
        narrativeBeat: segment.narrativeBeat
      }))
    );
    return {
      inspectedAt: new Date().toISOString(),
      targetDuration: Number(targetDuration || 0),
      passed: !issues.some((issue) => issue.severity === "error"),
      averageSemanticOverlap: Number((
        inspectedSegments.reduce((sum, segment) => sum + segment.semanticOverlap, 0) / Math.max(1, inspectedSegments.length)
      ).toFixed(3)),
      issues,
      segments: inspectedSegments
    };
  }

  async inspectAndWrite({ segments, targetDuration, voiceSpeed, outputPath }) {
    const report = this.inspect({ segments, targetDuration, voiceSpeed });
    if (outputPath) {
      await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
    }
    return report;
  }
}

module.exports = VoiceVisualAlignmentService;
