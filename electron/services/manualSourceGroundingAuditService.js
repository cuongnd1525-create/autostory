"use strict";
const {parseSrtCues} = require("./hookMiningService");
const wordSet = value => new Set(String(value || "").toLowerCase()
  .replace(/[^a-z0-9'\s]/g, " ").split(/\s+/).filter(w => w.length >= 3));

/**
 * Conservative SOURCE TRANSCRIPT alignment audit.
 * Timestamp and SRT quote overlap are independently checkable; visual truth,
 * actor attribution and final legal claims are NOT established by this report.
 */
function auditManualSourceGrounding({rawScript = {}, normalizedScript = {}, transcriptSrt = "", sourceVideo = ""} = {}) {
  const cues = parseSrtCues(transcriptSrt);
  const segments = Array.isArray(normalizedScript.segments) ? normalizedScript.segments : [];
  const rawSegments = Array.isArray(rawScript.segments) ? rawScript.segments : [];
  const findings = segments.map((segment, i) => {
    const startSec = Number(segment.sourceStartSec || 0);
    const endSec = Number(segment.sourceEndSec || 0);
    const cuesInRange = cues.filter(cue =>
      cue.startSec < endSec - 0.05 && cue.endSec > startSec + 0.05
    );
    const transcriptQuote = cuesInRange.map(cue => cue.text).join(" ").replace(/\s+/g, " ").slice(0, 650);
    const raw = rawSegments[i] || {};
    const claimedQuote = String(raw.source_quote || raw.sourceQuote || raw.key_dialogue
      || raw.keyDialogue || raw.originalDialogue || raw.authenticDialogue || "").trim();
    let quoteRecall = null;
    let quoteStatus = "no_declared_quote";
    if (claimedQuote) {
      const expected = wordSet(claimedQuote), received = wordSet(transcriptQuote);
      const overlap = [...expected].filter(word => received.has(word)).length;
      quoteRecall = expected.size ? Number((overlap / expected.size).toFixed(3)) : null;
      quoteStatus = !cues.length ? "no_srt_available"
        : quoteRecall !== null && quoteRecall >= 0.6 ? "transcript_supported"
        : "requires_manual_listening";
    }
    return {
      segmentId: String(segment.id || segment.segmentId || i + 1),
      sourceStartSec: startSec, sourceEndSec: endSec,
      audioMode: String(segment.audioMode || ""),
      srtCueCount: cuesInRange.length,
      transcriptExcerpt: transcriptQuote,
      ...(claimedQuote ? {declaredQuote: claimedQuote, quoteRecall, quoteStatus} : {}),
      transcriptCoverage: cuesInRange.length ? "srt_overlap" : "not_covered"
    };
  });
  return {
    artifactType: "manual_gemini_source_grounding_audit",
    schemaVersion: 1,
    sourceVideo,
    accessProof: "local_source_timestamps_and_optional_srt_only",
    limitations: "SRT overlap is NOT proof Gemini watched footage. ASR may mistranscribe dialogue; visual actions, case identities, motives and outcomes require audiovisual review.",
    hasTranscript: cues.length > 0,
    transcriptCueCount: cues.length,
    segmentCount: segments.length,
    quoteDeclaredCount: findings.filter(f => f.declaredQuote).length,
    quoteManualReviewCount: findings.filter(f => f.quoteStatus === "requires_manual_listening").length,
    findings
  };
}
module.exports = {auditManualSourceGrounding};
