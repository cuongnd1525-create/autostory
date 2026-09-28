// AutoStory run outcome helpers (Bug-2 fix). Pure + testable.
// A run that produced zero usable scripts (or ended in a failed phase) must NOT
// trigger draft rendering; the original V3 failure is preserved and surfaced.

const FAILED_PHASES = new Set(['failed', 'review_failed', 'render_failed', 'cancelled']);

function scriptCount(result) {
  if (!result) return 0;
  return (result.analysis?.scriptPaths?.length)
    || (result.project?.storyScriptPaths?.length)
    || (result.project?.analysis?.highlightVariants?.length)
    || 0;
}

// Count variants that produced an ACTUAL rendered draft video.
function renderedDraftCount(result) {
  const variants = result?.project?.analysis?.highlightVariants || [];
  return variants.filter(v => v && v.artifacts && v.artifacts.fastDraftVideoPath).length;
}

// Bug-4 fix: success/failure keys off actually rendered drafts, not merely a
// compiled script count. A compile that later fails to render is a FAILURE.
function isFailedGeneration(result) {
  if (!result) return true;
  if (renderedDraftCount(result) >= 1) return false; // at least one usable rendered draft
  const phase = result.project?.autoStoryState?.phase;
  const failures = (result.analysis?.failures?.length)
    || (result.project?.autoStoryState?.failures?.length)
    || 0;
  // No rendered draft: failed if generation produced nothing, a failure was
  // recorded (e.g. render error after compile), or the run ended in a failed phase.
  return scriptCount(result) === 0 || failures > 0 || FAILED_PHASES.has(phase);
}

function firstGenerationError(result) {
  return result?.analysis?.failures?.[0]?.error
    || result?.project?.autoStoryState?.failures?.[0]?.error
    || result?.project?.autoStoryState?.error
    || result?.error
    || 'AutoStory V3 không tạo được kịch bản nào.';
}

// Draft rendering should proceed only when generation actually produced scripts.
function shouldRenderDrafts(result) {
  return !isFailedGeneration(result);
}

module.exports = { isFailedGeneration, firstGenerationError, shouldRenderDrafts, scriptCount, renderedDraftCount, FAILED_PHASES };
