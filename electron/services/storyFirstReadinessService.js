"use strict";

/**
 * This reconciles the independent script-structure / cold-viewer checks with
 * the production preflight performed on the NORMALIZED edit timeline.
 *
 * A high Stage-1 score never overrides a low production-readiness result.
 * This is a publish/readiness gate; not an estimate of TikTok engagement.
 */
function resolveStoryFirstProfile(project = {}, activeVariant = {}) {
  return String(
    activeVariant.promptProfile
    || activeVariant.prompt_profile
    || project.manualGeminiPromptOptions?.profile
    || project.manualGeminiPromptOptions?.promptProfile
    || ""
  ).trim().toLowerCase();
}

function isStoryFirstSeries(project = {}, activeVariant = {}) {
  return project.analysisWorkflow === "manual_gemini_draft_review"
    && resolveStoryFirstProfile(project, activeVariant) === "viral_tiktok_crime_part1";
}

function preflightReadiness(project = {}, activeVariant = {}, settings = {}) {
  if (!isStoryFirstSeries(project, activeVariant)) {
    return { applicable: false, accepted: true, reasons: [] };
  }
  const preflight = activeVariant.viralPreflight;
  const score = Number(preflight?.score);
  const editorial = Number(preflight?.scoreBreakdown?.editorialReadiness?.score);
  const technical = Number(preflight?.scoreBreakdown?.technicalReadiness?.score);
  const reasons = [];
  if (!preflight || !Number.isFinite(score)) reasons.push("Không có Viral Preflight hợp lệ trên timeline đã chuẩn hóa.");
  else {
    if (score < 72 || preflight.passed === false) reasons.push(`Viral Preflight chỉ đạt ${score}/100 (<72).`);
    if (Number.isFinite(editorial) && editorial < 72) reasons.push(`Editorial readiness ${editorial}/100 (<72).`);
    if (Number.isFinite(technical) && technical < 80) reasons.push(`Technical readiness ${technical}/100 (<80).`);
  }
  // Explicit diagnostic override, never the default. It exists for comparing
  // deliberately bad drafts, not for declaring an output editorially ready.
  const overridden = settings.storyFirstAllowLowQualityDraft === true && reasons.length > 0;
  return {
    applicable: true, accepted: reasons.length === 0 || overridden,
    overridden, requiredScore: 72,
    score: Number.isFinite(score) ? score : null,
    editorialScore: Number.isFinite(editorial) ? editorial : null,
    technicalScore: Number.isFinite(technical) ? technical : null,
    reasons, preflightIssues: (preflight?.issues || []).slice(0, 8)
  };
}

/**
 * English is the default language of the US-facing true-crime Story First
 * preview. Never run English→Vietnamese local MT unless it was explicitly
 * selected or this is a legacy Vietnamese preview.
 */
function resolvePreviewSubtitleLanguage(project = {}, settings = {}, activeVariant = {}) {
  const explicit = String(
    project.storyFirstPreviewSubtitleLanguage
    || settings.storyFirstPreviewSubtitleLanguage
    || ""
  ).trim().toLowerCase();
  if (["en", "vi", "off"].includes(explicit)) return explicit;
  return isStoryFirstSeries(project, activeVariant) ? "en" : "vi";
}

module.exports = {
  isStoryFirstSeries, resolveStoryFirstProfile,
  preflightReadiness, resolvePreviewSubtitleLanguage
};
