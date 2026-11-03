const { mineHookCandidateRegions } = require("./hookMiningService");

const PREFERRED_ARCHETYPES = [
  "Physical Friction / Barricade Suspense",
  "The Absurd Contradiction",
  "In Medias Res",
  "Instant Karma / The Fatal Mistake",
  "Unbelievable Stakes",
  "Revelation / Shocking Discovery",
  "Accusation",
  "Emotional Shock",
  "Authority Reversal",
  "Dialogue Conflict",
  "Other"
];

function calculateOverallHookScore(scores = {}) {
  const visual = Math.max(0, Math.min(100, Number(scores.visual_immediacy) || 0));
  const conflict = Math.max(0, Math.min(100, Number(scores.conflict) || 0));
  const curiosity = Math.max(0, Math.min(100, Number(scores.curiosity_gap) || 0));
  const dialogue = Math.max(0, Math.min(100, Number(scores.dialogue_strength) || 0));
  const payoff = Math.max(0, Math.min(100, Number(scores.payoff_potential) || 75));
  const spoiler = Math.max(0, Math.min(100, Number(scores.spoiler_risk) || 0));

  const weighted = (visual * 0.25)
    + (conflict * 0.25)
    + (curiosity * 0.25)
    + (dialogue * 0.15)
    + (payoff * 0.10)
    - (spoiler * 0.20);

  return Math.max(1, Math.min(100, Math.round(weighted)));
}

function formatCandidateForAudit(candidate, rank = 1) {
  const scores = candidate.scores || {};
  const overall = calculateOverallHookScore(scores);
  return {
    rank,
    hookId: candidate.candidateId || `hook_${String(rank).padStart(2, "0")}`,
    title: candidate.title || generateHookTitle(candidate),
    archetype: candidate.archetype || "Unclassified Radar Candidate",
    provenance: candidate.provenance || "deterministic_radar",
    semanticStatus: candidate.semanticStatus || "unverified",
    sourceStartSec: Number(candidate.sourceStartSec || 0),
    sourceEndSec: Number(candidate.sourceEndSec || 0),
    durationSec: Number((candidate.sourceEndSec - candidate.sourceStartSec).toFixed(2)),
    coreEventDescription: candidate.coreEventDescription || "",
    keyDialogue: candidate.keyDialogue || "",
    scores: {
      overall,
      visual_immediacy: Number(scores.visual_immediacy || 60),
      conflict: Number(scores.conflict || 60),
      curiosity_gap: Number(scores.curiosity_gap || 60),
      dialogue_strength: Number(scores.dialogue_strength || 50),
      spoiler_risk: Number(scores.spoiler_risk || 15),
      payoff_potential: Number(scores.payoff_potential || 80)
    },
    rationale: generateHookRationale(candidate, overall)
  };
}

// Titles state only the evidence the radar actually has: the transcript words it
// matched, or the time of a motion/audio spike. They never describe an event
// (who does what to what) that nobody has watched.
function generateHookTitle(candidate) {
  const dialogue = String(candidate.keyDialogue || "").replace(/\s+/g, " ").trim();
  if (dialogue) return `Transcript: "${dialogue.length > 60 ? `${dialogue.slice(0, 57)}...` : dialogue}"`;
  return `Motion/audio spike at ${formatTime(candidate.sourceStartSec)}`;
}

function generateHookRationale(candidate, overallScore) {
  const reasons = [];
  if (candidate.scores?.visual_immediacy >= 80) reasons.push("Radar chuyển động/âm lượng cao (chưa xác minh nội dung)");
  if (candidate.scores?.dialogue_strength >= 80) reasons.push("Transcript khớp mẫu thoại xung đột");
  if (candidate.scores?.curiosity_gap >= 85) reasons.push("Tạo khoảng trống tò mò lớn khiến khán giả nán lại xem giải thích");
  if (candidate.scores?.spoiler_risk <= 20) reasons.push("Không nằm ở đoạn cuối video (rủi ro spoil thấp theo radar)");
  return reasons.join(". ") || `Điểm radar: ${overallScore}/100 (ứng viên tự động, cần xem footage)`;
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

class HookAuditionService {
  constructor(settings = {}) {
    this.settings = settings;
  }

  async audition({
    transcriptCues = [],
    actionCandidates = [],
    manifest = {},
    durationSec = 0,
    topCount = 5,
    aiService = null
  } = {}) {
    // Stage 1A: Mine 15-25 candidate regions
    const minedCandidates = mineHookCandidateRegions({
      transcriptCues,
      actionCandidates,
      manifest,
      durationSec,
      maxCandidates: 25
    });

    if (!minedCandidates.length) {
      return {
        success: false,
        warning: "Không tìm thấy ứng viên hook nào đủ điều kiện từ nguồn.",
        topCandidates: []
      };
    }

    // Sort by overall score
    const ranked = minedCandidates
      .map((c, idx) => formatCandidateForAudit(c, idx + 1))
      .sort((a, b) => b.scores.overall - a.scores.overall);

    const topCandidates = ranked.slice(0, Math.max(3, Math.min(topCount, 5)));

    return {
      success: true,
      totalMinedCount: minedCandidates.length,
      topCandidates,
      defaultRecommendedHook: topCandidates[0] || null
    };
  }
}

module.exports = HookAuditionService;
module.exports.PREFERRED_ARCHETYPES = PREFERRED_ARCHETYPES;
module.exports.calculateOverallHookScore = calculateOverallHookScore;
module.exports.formatCandidateForAudit = formatCandidateForAudit;
