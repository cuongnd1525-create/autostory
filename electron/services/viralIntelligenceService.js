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

function normalizeScore(value, fallback = 0.5) {
  const number = safeNumber(value, fallback);
  return clamp(number > 1 ? number / 10 : number, 0, 1);
}

function wordCount(text) {
  return safeText(text).split(/\s+/).filter(Boolean).length;
}

function includesAny(text, terms) {
  const haystack = safeText(text).toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

function normalizeForGuard(text) {
  return safeText(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s_-]/g, " ");
}

const GUARDED_FACT_TERMS = [
  { term: "betray", aliases: ["betray", "traitor", "betrayal", "phan boi"], category: "relationship_twist" },
  { term: "secret", aliases: ["secret", "hidden truth", "bi mat", "su that"], category: "reveal" },
  { term: "father", aliases: ["father", "dad", "nguoi cha"], category: "relationship" },
  { term: "mother", aliases: ["mother", "mom", "nguoi me"], category: "relationship" },
  { term: "brother", aliases: ["brother", "anh trai", "em trai"], category: "relationship" },
  { term: "sister", aliases: ["sister", "chi gai", "em gai"], category: "relationship" },
  { term: "android", aliases: ["android", "robot", "machine", "nguoi may"], category: "identity" },
  { term: "alien", aliases: ["alien", "extraterrestrial", "nguoi ngoai hanh tinh"], category: "identity" },
  { term: "killer", aliases: ["killer", "murderer", "sat nhan"], category: "identity" },
  { term: "dead", aliases: ["dead", "dies", "death", "da chet"], category: "outcome" },
  { term: "revenge", aliases: ["revenge", "vengeance", "tra thu"], category: "motive" }
];

function evidenceGraphCorpus(evidenceGraph) {
  const nodeText = Array.isArray(evidenceGraph?.nodes)
    ? evidenceGraph.nodes.map((node) => [
        node.label,
        node.type,
        node.sceneId,
        node.data?.text,
        node.data?.summary,
        node.data?.sceneId,
        ...(Array.isArray(node.data?.evidenceIds) ? node.data.evidenceIds : [])
      ].filter(Boolean).join(" "))
    : [];
  const factText = Array.isArray(evidenceGraph?.facts) ? evidenceGraph.facts.map((fact) => fact.text) : [];
  return normalizeForGuard([...nodeText, ...factText].join(" "));
}

function normalizedContainsTerm(text, alias) {
  const normalizedAlias = normalizeForGuard(alias).trim();
  if (!normalizedAlias) return false;
  if (normalizedAlias.includes(" ")) {
    return text.includes(normalizedAlias);
  }
  return new RegExp(`(^|\\s)${normalizedAlias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`).test(text);
}

function termSupportedByEvidence(termSpec, corpus) {
  return termSpec.aliases.some((alias) => normalizedContainsTerm(corpus, alias));
}

function guardedTermsInText(text) {
  const normalized = normalizeForGuard(text);
  return GUARDED_FACT_TERMS.filter((termSpec) =>
    termSpec.aliases.some((alias) => normalizedContainsTerm(normalized, alias))
  );
}

function buildViralFactGuard({ viralAnalysis, retentionPlan, viralTimeline, segments, evidenceGraph }) {
  const corpus = evidenceGraphCorpus(evidenceGraph);
  const issues = [];
  const inspectText = (entryId, location, text, sceneId = "") => {
    const terms = guardedTermsInText(text);
    for (const termSpec of terms) {
      if (!termSupportedByEvidence(termSpec, corpus)) {
        issues.push({
          entryId,
          location,
          sceneId,
          severity: "high",
          code: "viral_fact_without_evidence",
          category: termSpec.category,
          term: termSpec.term,
          message: `Viral layer introduced '${termSpec.term}' without Evidence Graph support.`,
          text: safeText(text)
        });
      }
    }
  };

  for (const [index, candidate] of (viralAnalysis?.topHookCandidates || []).entries()) {
    const entryId = `hook_${String(index + 1).padStart(2, "0")}`;
    inspectText(entryId, "topHookCandidates.hookLineIdea", candidate.hookLineIdea, candidate.sceneId);
    inspectText(entryId, "topHookCandidates.reason", candidate.reason, candidate.sceneId);
  }
  for (const [index, moment] of (viralAnalysis?.topTwistMoments || []).entries()) {
    inspectText(`twist_${String(index + 1).padStart(2, "0")}`, "topTwistMoments.reason", moment.reason, moment.sceneId);
  }
  for (const [index, gap] of (retentionPlan?.curiosityGaps || []).entries()) {
    inspectText(`gap_${String(index + 1).padStart(2, "0")}`, "retentionPlan.curiosityGaps.question", gap.question);
  }
  for (const [index, block] of (viralTimeline?.blocks || []).entries()) {
    inspectText(`block_${String(index + 1).padStart(2, "0")}`, "viralTimeline.viewerQuestion", block.viewerQuestion, block.sceneIds?.[0] || "");
    inspectText(`block_${String(index + 1).padStart(2, "0")}`, "viralTimeline.retentionReason", block.retentionReason, block.sceneIds?.[0] || "");
  }
  for (const [index, segment] of (segments || []).entries()) {
    inspectText(`segment_${String(index + 1).padStart(2, "0")}`, "segment.narrationLine", segment.narrationLine || segment.subtitleText, segment.sceneId);
  }

  return {
    schemaVersion: "viral-fact-guard.v1",
    generatedAt: new Date().toISOString(),
    checkedAgainst: evidenceGraph?.schemaVersion || "none",
    passed: !issues.some((issue) => issue.severity === "high"),
    issueCount: issues.length,
    issues,
    policy: {
      allowedChanges: ["phrasing", "hook framing", "curiosity timing", "cliffhanger wording", "retention pacing"],
      forbiddenChanges: ["new character facts", "new relationships", "new motives", "new twists", "new outcomes"]
    }
  };
}

function applyViralFactGuard(viralAnalysis, guardReport) {
  if (!viralAnalysis || !guardReport?.issues?.length) {
    return viralAnalysis;
  }
  const unsafeHookSceneIds = new Set(
    guardReport.issues
      .filter((issue) => issue.severity === "high" && issue.location.startsWith("topHookCandidates"))
      .map((issue) => safeText(issue.sceneId))
      .filter(Boolean)
  );
  const filteredHooks = (viralAnalysis.topHookCandidates || []).filter((candidate) => !unsafeHookSceneIds.has(safeText(candidate.sceneId)));
  return {
    ...viralAnalysis,
    topHookCandidates: filteredHooks.length ? filteredHooks : (viralAnalysis.topHookCandidates || []).map((candidate) => ({
      ...candidate,
      hookLineIdea: safeText(candidate.evidence?.[0] || candidate.reason || candidate.sceneId, candidate.hookLineIdea),
      risk: [...(candidate.risk || []), "viral_fact_guard_rewritten_to_evidence"]
    })),
    viralFactGuard: guardReport,
    debug: {
      ...(viralAnalysis.debug || {}),
      viralFactGuardIssueCount: guardReport.issueCount,
      filteredUnsafeHookCount: unsafeHookSceneIds.size
    }
  };
}

function sceneText(item = {}) {
  const metadata = item.metadataSummary || item;
  return [
    item.role,
    item.narrativeBeat,
    item.storyBeatRole,
    item.description,
    item.reason,
    item.emotionalAnchor,
    item.visualEvidence,
    item.transcriptEvidence,
    item.whatChanged,
    metadata.audioTranscript,
    metadata.motionIntensity,
    metadata.audioEnergy,
    metadata.lightChange,
    ...(Array.isArray(metadata.localVisualTags) ? metadata.localVisualTags : [])
  ].filter(Boolean).join(" ");
}

function inferHookType(item = {}) {
  const text = sceneText(item).toLowerCase();
  if (includesAny(text, ["betray", "traitor", "lie", "secret"])) return "betrayal";
  if (includesAny(text, ["unfair", "helpless", "punish", "abandon", "forced"])) return "injustice";
  if (includesAny(text, ["monster", "attack", "chase", "trap", "danger", "kill", "hunt"])) return "danger";
  if (includesAny(text, ["why", "strange", "weird", "mystery", "unknown", "rule"])) return "mystery";
  if (includesAny(text, ["choice", "save", "sacrifice", "moral"])) return "moral_dilemma";
  if (includesAny(text, ["impossible", "cannot", "no way", "survive"])) return "impossible_situation";
  return "shock";
}

function scoreViralCandidate(item = {}, genreMode = "thriller", selectedIndex = 0) {
  const text = sceneText(item).toLowerCase();
  const role = safeText(item.role || item.narrativeBeat || item.storyBeatRole).toLowerCase();
  const metadata = item.metadataSummary || item;
  const highMotion = includesAny(`${metadata.motionIntensity} ${metadata.audioEnergy} ${metadata.lightChange}`, ["high", "loud", "flash"]);
  const danger = includesAny(text, ["attack", "danger", "chase", "trap", "monster", "predator", "kill", "hunt", "fight"]);
  const mystery = includesAny(text, ["mystery", "secret", "unknown", "strange", "weird", "why", "truth"]);
  const emotion = includesAny(text, ["cry", "love", "lose", "betray", "sacrifice", "angry", "fear", "helpless"]);
  const conflict = includesAny(text, ["but", "however", "fight", "against", "obstacle", "enemy", "forced", "escape"]);
  const twist = includesAny(text, ["reveal", "twist", "truth", "secret", "betray", "realize"]);
  const payoff = includesAny(text, ["finally", "revenge", "escape", "defeat", "save", "wins", "pays"]);
  const visualTags = Array.isArray(metadata.localVisualTags) ? metadata.localVisualTags.join(" ").toLowerCase() : "";
  const visualImpact = normalizeScore(item.visualImpactScore || item.openingImpactScore || item.visualClarityScore || item.motionScore, 0.45)
    + (highMotion ? 0.18 : 0)
    + (danger ? 0.10 : 0)
    + (visualTags ? 0.05 : 0);
  const plotImportance = normalizeScore(item.plotImportanceScore || item.contextScore || item.sceneValue || item.qualityScore, 0.55);
  const curiosityScore = normalizeScore(item.curiosityScore, mystery ? 0.82 : role === "hook" ? 0.72 : 0.45);
  const emotionalImpactScore = normalizeScore(item.emotionalImpactScore || item.emotionScore, emotion ? 0.78 : 0.45);
  const injusticeScore = normalizeScore(item.injusticeScore, includesAny(text, ["unfair", "betray", "abandon", "helpless", "forced"]) ? 0.78 : 0.30);
  const conflictDensityScore = normalizeScore(item.conflictDensityScore || item.tensionScore, conflict || danger ? 0.78 : 0.42);
  const twistValueScore = normalizeScore(item.twistValueScore, twist ? 0.82 : 0.30);
  const payoffScore = normalizeScore(item.payoffScore, payoff ? 0.75 : 0.35);
  const shareabilityScore = normalizeScore(item.shareabilityScore, injusticeScore > 0.65 || twistValueScore > 0.65 ? 0.72 : 0.42);
  const commentTriggerScore = normalizeScore(item.commentTriggerScore, includesAny(text, ["choice", "wrong", "deserved", "would you"]) ? 0.75 : 0.40);
  const contextCost = normalizeScore(item.contextCost || item.dialogueDependency, role === "setup" || role === "context" ? 0.52 : 0.35);
  const spoilerRisk = normalizeScore(item.spoilerRisk, twist ? 0.70 : 0.25);
  const spoilerRiskIfTooEarly = selectedIndex <= 1 ? spoilerRisk : spoilerRisk * 0.35;
  const genreBoost = {
    horror: { curiosityScore: 0.06, conflictDensityScore: 0.06, visualImpactScore: 0.04 },
    thriller: { curiosityScore: 0.07, conflictDensityScore: 0.05 },
    mystery: { curiosityScore: 0.10, twistValueScore: 0.05 },
    romance: { emotionalImpactScore: 0.10, payoffScore: 0.05 },
    action: { visualImpactScore: 0.10, conflictDensityScore: 0.06 },
    drama: { injusticeScore: 0.08, emotionalImpactScore: 0.07 }
  }[genreMode] || {};

  const adjusted = {
    plotImportance,
    curiosityScore: clamp(curiosityScore + (genreBoost.curiosityScore || 0)),
    emotionalImpactScore: clamp(emotionalImpactScore + (genreBoost.emotionalImpactScore || 0)),
    injusticeScore: clamp(injusticeScore + (genreBoost.injusticeScore || 0)),
    conflictDensityScore: clamp(conflictDensityScore + (genreBoost.conflictDensityScore || 0)),
    visualImpactScore: clamp(visualImpact + (genreBoost.visualImpactScore || 0)),
    twistValueScore: clamp(twistValueScore + (genreBoost.twistValueScore || 0)),
    payoffScore: clamp(payoffScore + (genreBoost.payoffScore || 0)),
    shareabilityScore,
    commentTriggerScore,
    spoilerRisk,
    contextCost
  };
  const retentionScore = clamp(
    0.20 * adjusted.plotImportance
    + 0.18 * adjusted.curiosityScore
    + 0.15 * adjusted.emotionalImpactScore
    + 0.12 * adjusted.conflictDensityScore
    + 0.10 * adjusted.visualImpactScore
    + 0.10 * adjusted.twistValueScore
    + 0.08 * adjusted.payoffScore
    + 0.07 * adjusted.shareabilityScore
    - 0.15 * adjusted.contextCost
    - 0.20 * spoilerRiskIfTooEarly
  );
  return {
    ...adjusted,
    scrollStopScore: clamp((adjusted.visualImpactScore * 0.38) + (adjusted.curiosityScore * 0.32) + (adjusted.conflictDensityScore * 0.30)),
    retentionScore,
    finalRetentionScore: retentionScore
  };
}

function makeHookLineIdea(candidate = {}, scores = {}) {
  const hookType = inferHookType(candidate);
  const evidence = safeText(candidate.whatChanged || candidate.description || candidate.visualEvidence || candidate.reason, "A visible story turn changes the stakes.");
  return `${hookType}: ${evidence}`;
}

function buildTimeRanges(targetDuration) {
  const target = Math.max(12, safeNumber(targetDuration, 60));
  const ranges = [
    { start: 0, end: Math.min(3, target), purpose: "hook", emotion: "shock / curiosity", rewardPolicy: "delay" },
    { start: 3, end: Math.min(10, target), purpose: "context_without_slowing_down", emotion: "curiosity", rewardPolicy: "partial_answer" },
    { start: 10, end: Math.min(25, target), purpose: "incident_or_conflict", emotion: "tension", rewardPolicy: "raise_stakes" },
    { start: 25, end: Math.min(45, target), purpose: "escalation", emotion: "danger / urgency", rewardPolicy: "delay" },
    { start: 45, end: Math.max(45, target - 10), purpose: "mini_reveal_or_payoff", emotion: "surprise", rewardPolicy: "mini_payoff" },
    { start: Math.max(0, target - 10), end: target, purpose: "loop_ending", emotion: "unresolved question", rewardPolicy: "loop" }
  ];
  return ranges.filter((range) => range.end > range.start).map((range) => ({
    timeRange: `${Math.round(range.start)}-${Math.round(range.end)}`,
    purpose: range.purpose,
    requiredEmotion: range.emotion,
    viewerQuestion: "",
    rewardPolicy: range.rewardPolicy,
    allowedBeats: [],
    forbidden: range.start < 10 ? ["long_context", "character_backstory"] : []
  }));
}

function buildViralAnalysis({ videoId, platform = "tiktok", targetDuration, genreMode, viralAngle, candidates, segments, filmMemory }) {
  const source = (Array.isArray(candidates) && candidates.length ? candidates : segments) || [];
  const scored = source.map((item, index) => ({
    item,
    index,
    scores: scoreViralCandidate(item, genreMode, index)
  })).sort((a, b) => b.scores.finalRetentionScore - a.scores.finalRetentionScore);
  const hookCandidates = scored.slice(0, 8).map(({ item, scores }, index) => ({
    sceneId: safeText(item.sceneId || item.id || `scene_${String(index + 1).padStart(3, "0")}`),
    beatId: safeText(item.beatId || item.narrativeBeat || item.role || ""),
    hookType: inferHookType(item),
    hookLineIdea: makeHookLineIdea(item, scores),
    scrollStopScore: Number(scores.scrollStopScore.toFixed(3)),
    curiosityScore: Number(scores.curiosityScore.toFixed(3)),
    visualImpactScore: Number(scores.visualImpactScore.toFixed(3)),
    emotionalImpactScore: Number(scores.emotionalImpactScore.toFixed(3)),
    spoilerRisk: Number(scores.spoilerRisk.toFixed(3)),
    reason: safeText(item.reason || item.description || item.whatChanged, "High retention candidate from local metadata."),
    evidence: [item.visualEvidence, item.transcriptEvidence, item.whatChanged].map((entry) => safeText(entry)).filter(Boolean).slice(0, 3)
  }));
  const avoidMoments = scored
    .filter(({ scores }) => scores.finalRetentionScore < 0.38 || scores.contextCost > 0.76)
    .slice(0, 8)
    .map(({ item, scores }) => ({
      sceneId: safeText(item.sceneId || item.id),
      reason: scores.contextCost > 0.76 ? "too_much_context" : "low_retention"
    }));
  const angleName = viralAngle?.label || viralAngle?.name || "Auto TikTok Retention";
  return {
    videoId: safeText(videoId, "project"),
    platform: safeText(platform, "tiktok"),
    targetDuration: safeNumber(targetDuration, 60),
    viralAngles: [{
      angleId: safeText(viralAngle?.id, "auto"),
      name: angleName,
      description: safeText(viralAngle?.instruction, "Choose the strongest mystery, danger, injustice, or payoff thread without inventing facts."),
      bestForGenres: [safeText(genreMode, "thriller")],
      score: hookCandidates[0]?.scrollStopScore || 0.6,
      risk: ["spoiler_risk_medium"]
    }],
    topHookCandidates: hookCandidates,
    topCuriosityMoments: hookCandidates.filter((entry) => entry.curiosityScore >= 0.68).slice(0, 6),
    topInjusticeMoments: scored.filter(({ scores }) => scores.injusticeScore >= 0.62).slice(0, 6).map(({ item, scores }) => ({
      sceneId: safeText(item.sceneId || item.id),
      score: Number(scores.injusticeScore.toFixed(3)),
      reason: safeText(item.whatChanged || item.reason || item.description)
    })),
    topTwistMoments: scored.filter(({ scores }) => scores.twistValueScore >= 0.62).slice(0, 6).map(({ item, scores }) => ({
      sceneId: safeText(item.sceneId || item.id),
      score: Number(scores.twistValueScore.toFixed(3)),
      reason: safeText(item.whatChanged || item.reason || item.description)
    })),
    topPayoffMoments: scored.filter(({ scores }) => scores.payoffScore >= 0.60).slice(0, 6).map(({ item, scores }) => ({
      sceneId: safeText(item.sceneId || item.id),
      score: Number(scores.payoffScore.toFixed(3)),
      reason: safeText(item.whatChanged || item.reason || item.description)
    })),
    bestLoopEndingCandidates: hookCandidates.slice(0, 3).map((entry) => ({
      sceneId: entry.sceneId,
      type: "unresolved_threat",
      lineIdea: `Leave the viewer asking: ${safeText(filmMemory?.curiosityGap, entry.hookLineIdea)}`
    })),
    commentTriggerIdeas: [
      safeText(filmMemory?.curiosityGap, "Which choice would you make in this situation?"),
      "Was the character right to keep going?"
    ],
    shareTriggerIdeas: [
      "A high-stakes turn that is easy to explain in one sentence.",
      "A moral dilemma viewers can argue about."
    ],
    avoidMoments,
    debug: {
      sourceCount: source.length,
      scoringFormula: "0.20 plot + 0.18 curiosity + 0.15 emotion + 0.12 conflict + 0.10 visual + 0.10 twist + 0.08 payoff + 0.07 share - 0.15 context - 0.20 early spoiler"
    }
  };
}

function buildRetentionPlan({ viralAnalysis, targetDuration, voiceSpeed, viralAngle }) {
  const selected = viralAnalysis?.viralAngles?.[0] || {};
  const topHook = viralAnalysis?.topHookCandidates?.[0] || {};
  const loop = viralAnalysis?.bestLoopEndingCandidates?.[0] || {};
  const curve = buildTimeRanges(targetDuration);
  curve.forEach((entry, index) => {
    if (index === 0) {
      entry.viewerQuestion = safeText(topHook.hookLineIdea, "What is happening here?");
      entry.allowedBeats = [safeText(topHook.beatId, "hook")];
    } else if (index === curve.length - 1) {
      entry.viewerQuestion = safeText(loop.lineIdea, "What happens next?");
      entry.allowedBeats = [safeText(loop.sceneId, "loop")];
    } else {
      entry.viewerQuestion = index % 2 === 0 ? "Why did the stakes get worse?" : "What is the hidden rule or consequence?";
    }
  });
  return {
    strategy: {
      angleId: safeText(selected.angleId || viralAngle?.id, "auto"),
      name: safeText(selected.name || viralAngle?.label, "Auto TikTok Retention"),
      summary: safeText(selected.description, "Open with the highest-question moment, then reveal context only as needed."),
      reason: safeText(topHook.reason, "Best available hook by metadata score.")
    },
    targetDuration: safeNumber(targetDuration, 60),
    voiceSpeed: safeNumber(voiceSpeed, 1),
    retentionCurve: curve,
    requiredStructure: ["hook", "context", "incident", "conflict", "escalation", "mini_reveal", "payoff_or_cliffhanger", "loop_ending"],
    curiosityGaps: [{
      gapId: "gap_01",
      question: safeText(topHook.hookLineIdea, "Why did this moment happen?"),
      introducedAt: "0-3",
      partialAnswerAt: "15-25",
      fullAnswerAt: `${Math.max(30, Math.round(safeNumber(targetDuration, 60) * 0.68))}-${Math.max(40, Math.round(safeNumber(targetDuration, 60) * 0.88))}`,
      doNotRevealBefore: Math.max(12, Math.round(safeNumber(targetDuration, 60) * 0.45))
    }],
    cliffhangerPoints: [{
      timeRange: `${Math.max(0, Math.round(safeNumber(targetDuration, 60) - 10))}-${Math.round(safeNumber(targetDuration, 60))}`,
      purpose: "loop_ending",
      sceneId: safeText(loop.sceneId || topHook.sceneId)
    }],
    delayRewardPlan: [{
      gapId: "gap_01",
      policy: "tease early, answer partially mid-video, keep one consequence unresolved"
    }],
    emotionCurve: [
      { time: 0, emotion: "shock", intensity: 0.9 },
      { time: Math.round(safeNumber(targetDuration, 60) * 0.25), emotion: "curiosity", intensity: 0.75 },
      { time: Math.round(safeNumber(targetDuration, 60) * 0.55), emotion: "tension", intensity: 0.85 },
      { time: Math.round(safeNumber(targetDuration, 60) * 0.88), emotion: "payoff_or_loop", intensity: 0.8 }
    ],
    loopEnding: {
      type: "question",
      lineIdea: safeText(loop.lineIdea, "End with the consequence that still has not been solved."),
      sceneId: safeText(loop.sceneId || topHook.sceneId)
    }
  };
}

function purposeForSegment(segment = {}, index = 0, total = 1) {
  const role = safeText(segment.narrativeBeat || segment.storyBeatRole || segment.role).toLowerCase();
  if (index === 0) return "hook";
  if (index === total - 1) return "loop_ending";
  if (role.includes("reveal") || role.includes("twist")) return "reveal";
  if (role.includes("payoff")) return "payoff";
  if (role.includes("escalation")) return "escalation";
  if (role.includes("conflict")) return "conflict";
  if (role.includes("incident")) return "incident";
  if (index <= 1) return "context";
  return "bridge";
}

function buildViralTimeline({ segments, retentionPlan, genreMode }) {
  const list = Array.isArray(segments) ? segments : [];
  return {
    strategy: retentionPlan?.strategy || null,
    blocks: list.map((segment, index) => {
      const scores = scoreViralCandidate(segment, genreMode, index);
      const purpose = purposeForSegment(segment, index, list.length);
      const viewerQuestion = index === 0
        ? retentionPlan?.curiosityGaps?.[0]?.question || "What is happening?"
        : purpose === "loop_ending"
          ? retentionPlan?.loopEnding?.lineIdea || "What happens next?"
          : purpose === "context"
            ? "What minimum context explains the hook?"
            : "How did the situation get worse?";
      return {
        blockId: `vblock_${String(index + 1).padStart(3, "0")}`,
        timeStart: Number(safeNumber(segment.timelineStart, 0).toFixed(3)),
        timeEnd: Number(safeNumber(segment.timelineEnd, segment.timelineStart + segment.renderDuration).toFixed(3)),
        purpose,
        sceneIds: [safeText(segment.sceneId || segment.id || `scene_${index + 1}`)].filter(Boolean),
        beatIds: [safeText(segment.beatId || segment.narrativeBeat || segment.role)].filter(Boolean),
        retentionScore: Number(scores.finalRetentionScore.toFixed(3)),
        retentionReason: safeText(segment.whatChanged || segment.reason || segment.description, "Selected because it advances story retention."),
        viewerQuestion,
        risk: [
          scores.contextCost > 0.72 ? "high_context_cost" : "",
          index <= 1 && scores.spoilerRisk > 0.62 ? "spoiler_too_early_risk" : ""
        ].filter(Boolean),
        scores
      };
    })
  };
}

function annotateSegmentsWithViralTimeline(segments, viralTimeline) {
  const blocks = Array.isArray(viralTimeline?.blocks) ? viralTimeline.blocks : [];
  return (segments || []).map((segment, index) => {
    const block = blocks[index] || {};
    return {
      ...segment,
      blockId: block.blockId || segment.blockId || `vblock_${String(index + 1).padStart(3, "0")}`,
      purpose: block.purpose || segment.purpose || purposeForSegment(segment, index, segments.length),
      viewerQuestion: block.viewerQuestion || segment.viewerQuestion || "",
      retentionReason: block.retentionReason || segment.retentionReason || "",
      retentionScore: block.retentionScore ?? segment.retentionScore,
      spoilerRisk: segment.spoilerRisk ?? block.scores?.spoilerRisk,
      evidenceLevel: segment.evidenceLevel || "inferred"
    };
  });
}

function detectAttentionIssues({ segments, retentionPlan, viralTimeline, groundingReport, viralFactGuard }) {
  const issues = [];
  const list = Array.isArray(segments) ? segments : [];
  const blocks = Array.isArray(viralTimeline?.blocks) ? viralTimeline.blocks : [];
  const firstLine = safeText(list[0]?.narrationLine || list[0]?.subtitleText);
  if (!firstLine || /^b[oộ] phim n[aà]y k[eể]|^this movie is about/i.test(firstLine)) {
    issues.push({
      segmentId: list[0]?.blockId || "seg_001",
      issue: "weak_hook",
      severity: "high",
      reason: "The first line starts like a summary instead of a scroll-stopping moment.",
      suggestedRewrite: safeText(blocks[0]?.viewerQuestion, "Open with the strangest visible consequence, not the title premise.")
    });
  }
  if (firstLine && wordCount(firstLine) > 26) {
    issues.push({
      segmentId: list[0]?.blockId || "seg_001",
      issue: "slow_start",
      severity: "medium",
      reason: "The hook is too long for the first three seconds.",
      suggestedRewrite: "Cut the hook to one sharp sentence under 18 spoken words."
    });
  }
  let lastRetentionBeatEnd = 0;
  for (const [index, segment] of list.entries()) {
    const purpose = safeText(segment.purpose || blocks[index]?.purpose).toLowerCase();
    const line = safeText(segment.narrationLine || segment.subtitleText);
    const start = safeNumber(segment.timelineStart, blocks[index]?.timeStart || 0);
    const end = safeNumber(segment.timelineEnd, blocks[index]?.timeEnd || start);
    const isRetentionBeat = /hook|curiosity|incident|conflict|escalation|reveal|payoff|cliffhanger|loop/.test(purpose)
      || includesAny(line, ["nhưng", "vậy mà", "until", "but", "why", "secret", "danger", "truth", "worse"]);
    if (isRetentionBeat) {
      if (start - lastRetentionBeatEnd > 15) {
        issues.push({
          segmentId: segment.blockId || `seg_${String(index + 1).padStart(3, "0")}`,
          issue: "no_curiosity_gap",
          severity: "medium",
          reason: `There is a ${Number(start - lastRetentionBeatEnd).toFixed(1)}s gap without curiosity, escalation, reveal, or bridge.`,
          suggestedRewrite: "Add a short consequence bridge before this segment."
        });
      }
      lastRetentionBeatEnd = end;
    }
    if (line && wordCount(line) > Math.max(28, safeNumber(segment.renderDuration, 4) * 4.8)) {
      issues.push({
        segmentId: segment.blockId || `seg_${String(index + 1).padStart(3, "0")}`,
        issue: "subtitle_overload",
        severity: "medium",
        reason: "The narration line is likely too dense for subtitle reading and TTS timing.",
        suggestedRewrite: "Split or shorten this line to one core idea."
      });
    }
    if (line && /^((anh|c[oô]|h[aắ]n|ng[uư][oờ]i|the)\b.*\b(nh[iì]n|walks|goes|runs|stands|looks))/i.test(line)) {
      issues.push({
        segmentId: segment.blockId || `seg_${String(index + 1).padStart(3, "0")}`,
        issue: "scene_captioning_style",
        severity: "medium",
        reason: "The line describes visible action without motivation or consequence.",
        suggestedRewrite: "Rewrite around why the action changes the stakes."
      });
    }
    if (index <= 1 && /reveal|truth|secret|betray|twist|s[uự] th[aậ]t|b[ií] m[aậ]t/i.test(line)) {
      issues.push({
        segmentId: segment.blockId || `seg_${String(index + 1).padStart(3, "0")}`,
        issue: "reveal_too_early",
        severity: "high",
        reason: "A twist/reveal appears before setup.",
        suggestedRewrite: "Tease the consequence without naming the reveal yet."
      });
    }
  }
  const ending = safeText(list[list.length - 1]?.narrationLine || list[list.length - 1]?.subtitleText);
  if (!/[?]|b[iì]nh lu[aậ]n|ph[aầ]n sau|what would|would you|next|li[eệ]u|chuy[eệ]n g[iì]/i.test(ending)) {
    issues.push({
      segmentId: list[list.length - 1]?.blockId || `seg_${String(list.length).padStart(3, "0")}`,
      issue: "no_loop_ending",
      severity: "medium",
      reason: "The ending closes flatly instead of looping to a question or comment trigger.",
      suggestedRewrite: safeText(retentionPlan?.loopEnding?.lineIdea, "End with one unresolved consequence or viewer question.")
    });
  }
  const groundingIssues = Array.isArray(groundingReport?.issues) ? groundingReport.issues : [];
  for (const issue of groundingIssues.filter((entry) => entry.code === "weak_inference_overstated" || entry.code === "scene_only_captioning").slice(0, 6)) {
    issues.push({
      segmentId: `seg_${String((issue.segmentIndex || 0) + 1).padStart(3, "0")}`,
      issue: issue.code === "scene_only_captioning" ? "scene_captioning_style" : "clickbait_without_evidence",
      severity: issue.severity === "error" ? "high" : "medium",
      reason: issue.message || "Grounding QA detected weak support.",
      suggestedRewrite: "Keep the claim closer to visible/transcript evidence."
    });
  }
  const factGuardIssues = Array.isArray(viralFactGuard?.issues) ? viralFactGuard.issues : [];
  for (const issue of factGuardIssues.filter((entry) => entry.severity === "high").slice(0, 8)) {
    issues.push({
      segmentId: issue.entryId || issue.sceneId || "viral_fact_guard",
      issue: "viral_fact_without_evidence",
      severity: "high",
      reason: issue.message || "Viral layer introduced unsupported factual detail.",
      suggestedRewrite: "Remove the unsupported factual detail or rewrite using only supported evidence."
    });
  }
  return issues;
}

function buildAttentionQa({ segments, retentionPlan, viralTimeline, groundingReport, viralFactGuard }) {
  const issues = detectAttentionIssues({ segments, retentionPlan, viralTimeline, groundingReport, viralFactGuard });
  const high = issues.filter((issue) => issue.severity === "high").length;
  const medium = issues.filter((issue) => issue.severity === "medium").length;
  const penalty = high * 0.15 + medium * 0.07 + (issues.length - high - medium) * 0.03;
  const hookIssue = issues.find((issue) => issue.issue === "weak_hook" || issue.issue === "slow_start");
  const loopIssue = issues.find((issue) => issue.issue === "no_loop_ending");
  const curiosityIssues = issues.filter((issue) => /curiosity|reveal|payoff/.test(issue.issue));
  const groundingIssues = issues.filter((issue) => issue.issue === "clickbait_without_evidence");
  return {
    overallScore: Number(clamp(0.92 - penalty).toFixed(3)),
    hookScore: Number(clamp(hookIssue ? 0.62 : 0.90).toFixed(3)),
    curiosityScore: Number(clamp(0.90 - curiosityIssues.length * 0.10).toFixed(3)),
    emotionCurveScore: Number(clamp(0.84 - issues.filter((issue) => issue.issue === "flat_emotion_curve").length * 0.14).toFixed(3)),
    conflictDensityScore: Number(clamp(0.86 - issues.filter((issue) => issue.issue === "low_conflict_density").length * 0.12).toFixed(3)),
    groundingSafetyScore: Number(clamp(0.92 - groundingIssues.length * 0.18).toFixed(3)),
    completionLikelihood: Number(clamp((0.86 - penalty * 0.65) - (loopIssue ? 0.08 : 0)).toFixed(3)),
    issues
  };
}

function repairSegmentsLocally({ segments, attentionQa, retentionPlan }) {
  const issues = Array.isArray(attentionQa?.issues) ? attentionQa.issues : [];
  const serious = issues.filter((issue) => issue.severity === "high" || issue.issue === "no_loop_ending" || issue.issue === "scene_captioning_style");
  if (!serious.length) {
    return null;
  }
  const repaired = (segments || []).map((segment, index) => ({ ...segment }));
  const firstIssues = serious.filter((issue) => issue.segmentId === (repaired[0]?.blockId || "seg_001") || issue.issue === "weak_hook");
  if (firstIssues.length && repaired[0]) {
    const question = safeText(repaired[0].viewerQuestion || retentionPlan?.curiosityGaps?.[0]?.question);
    const evidence = safeText(repaired[0].whatChanged || repaired[0].visualEvidence || repaired[0].retentionReason || repaired[0].description);
    repaired[0].narrationLine = safeText(question || evidence, repaired[0].narrationLine);
    repaired[0].subtitleText = repaired[0].narrationLine;
    repaired[0].viralRepairNote = "Repaired weak hook using existing retention question/evidence.";
  }
  const endingIssue = serious.find((issue) => issue.issue === "no_loop_ending");
  if (endingIssue && repaired.length) {
    const last = repaired[repaired.length - 1];
    const loopLine = safeText(retentionPlan?.loopEnding?.lineIdea, endingIssue.suggestedRewrite);
    if (loopLine) {
      last.narrationLine = /[?]$/.test(loopLine) ? loopLine : `${loopLine}?`;
      last.subtitleText = last.narrationLine;
      last.viralRepairNote = "Repaired flat ending with retention-plan loop ending.";
    }
  }
  return {
    repairedAt: new Date().toISOString(),
    provider: "local_safe_repair",
    reason: "Applied only evidence-based hook/loop fixes; no new plot facts were invented.",
    segments: repaired,
    fullNarration: repaired.map((segment) => safeText(segment.narrationLine || segment.subtitleText)).filter(Boolean).join(" ")
  };
}

class ViralIntelligenceService {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
  }

  buildAll({ videoId, platform, targetDuration, voiceSpeed, genreMode, viralAngle, candidates, segments, filmMemory, filmUnderstanding, narrativeIntelligence, evidenceGraph }) {
    if (!this.enabled) {
      return { fallback: true, fallbackReason: "viral_optimization_disabled" };
    }
    let viralAnalysis = buildViralAnalysis({ videoId, platform, targetDuration, genreMode, viralAngle, candidates, segments, filmMemory, filmUnderstanding, narrativeIntelligence });
    let viralFactGuard = buildViralFactGuard({ viralAnalysis, segments, evidenceGraph });
    viralAnalysis = applyViralFactGuard(viralAnalysis, viralFactGuard);
    const retentionPlan = buildRetentionPlan({ viralAnalysis, targetDuration, voiceSpeed, viralAngle });
    const viralTimeline = buildViralTimeline({ segments, retentionPlan, genreMode });
    viralFactGuard = buildViralFactGuard({ viralAnalysis, retentionPlan, viralTimeline, segments, evidenceGraph });
    const annotatedSegments = annotateSegmentsWithViralTimeline(segments, viralTimeline);
    return {
      fallback: false,
      viralAnalysis,
      viralFactGuard,
      retentionPlan,
      viralTimeline,
      annotatedSegments
    };
  }

  inspectAttention({ segments, retentionPlan, viralTimeline, groundingReport, viralFactGuard }) {
    return buildAttentionQa({ segments, retentionPlan, viralTimeline, groundingReport, viralFactGuard });
  }

  repair({ segments, attentionQa, retentionPlan }) {
    return repairSegmentsLocally({ segments, attentionQa, retentionPlan });
  }

  async writeArtifacts({ outputDir, projectStore, viralAnalysis, viralFactGuard, retentionPlan, viralTimeline, attentionQa, repairResult, fallbackReason }) {
    const paths = {
      viralAnalysisPath: path.join(outputDir, "viral-analysis.json"),
      viralFactGuardPath: path.join(outputDir, "viral-fact-guard.json"),
      retentionPlanPath: path.join(outputDir, "retention-plan.json"),
      viralTimelinePath: path.join(outputDir, "viral-timeline.json"),
      attentionQaPath: path.join(outputDir, "attention-qa.json")
    };
    const fallbackPayload = fallbackReason ? {
      viralOptimizationFallback: true,
      fallbackReason,
      generatedAt: new Date().toISOString()
    } : null;
    await fs.mkdir(outputDir, { recursive: true }).catch(() => {});
    const writer = projectStore?.writeJson
      ? (filePath, payload) => projectStore.writeJson(filePath, payload)
      : (filePath, payload) => fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
    await writer(paths.viralAnalysisPath, viralAnalysis || fallbackPayload || {}).catch(() => {});
    await writer(paths.viralFactGuardPath, viralFactGuard || fallbackPayload || {}).catch(() => {});
    await writer(paths.retentionPlanPath, retentionPlan || fallbackPayload || {}).catch(() => {});
    await writer(paths.viralTimelinePath, viralTimeline || fallbackPayload || {}).catch(() => {});
    await writer(paths.attentionQaPath, attentionQa || fallbackPayload || {}).catch(() => {});
    if (repairResult) {
      paths.viralRepairedNarrationPath = path.join(outputDir, "viral-repaired-narration.json");
      await writer(paths.viralRepairedNarrationPath, repairResult).catch(() => {});
    }
    return paths;
  }
}

module.exports = {
  ViralIntelligenceService,
  scoreViralCandidate,
  buildViralAnalysis,
  buildRetentionPlan,
  buildViralTimeline,
  buildAttentionQa,
  buildViralFactGuard,
  repairSegmentsLocally,
  annotateSegmentsWithViralTimeline
};
