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
    archetype: candidate.archetype || "High Stakes Altercation",
    sourceStartSec: Number(candidate.sourceStartSec || 0),
    sourceEndSec: Number(candidate.sourceEndSec || 0),
    durationSec: Number((candidate.sourceEndSec - candidate.sourceStartSec).toFixed(2)),
    coreEventDescription: candidate.coreEventDescription || "High friction altercation",
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

function generateHookTitle(candidate) {
  const dialogue = String(candidate.keyDialogue || "").trim();
  const archetype = String(candidate.archetype || "");
  if (/trunk|child/i.test(dialogue)) return 'Suspect: "That\'s not my child"';
  if (/door|open|rattle/i.test(dialogue) || archetype.includes("Barricade")) return "Officer repeatedly struggles with barricaded door";
  if (/gun|knife|drop/i.test(dialogue)) return "Officer draws weapon at point blank";
  if (/not\s+mine/i.test(dialogue)) return "Suspect boldly denies obvious evidence";
  if (candidate.triggerType === "physical_friction") return "High-friction barricade confrontation";
  if (candidate.keyDialogue) return `"${candidate.keyDialogue.slice(0, 48)}..."`;
  return `Confrontation at ${formatTime(candidate.sourceStartSec)}`;
}

function generateHookRationale(candidate, overallScore) {
  const reasons = [];
  if (candidate.scores?.visual_immediacy >= 80) reasons.push("Mạnh về thị giác (chuyển động lớn, giằng co gay gắt)");
  if (candidate.scores?.dialogue_strength >= 80) reasons.push("Thoại đối đầu đắt giá, rõ ràng");
  if (candidate.scores?.curiosity_gap >= 85) reasons.push("Tạo khoảng trống tò mò lớn khiến khán giả nán lại xem giải thích");
  if (candidate.scores?.spoiler_risk <= 20) reasons.push("Giữ kín kết cục, không bị spoil");
  return reasons.join(". ") || `Điểm tiềm năng giữ chân TikTok: ${overallScore}/100`;
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
