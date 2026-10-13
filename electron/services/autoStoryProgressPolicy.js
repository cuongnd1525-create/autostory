// The progress of each Vertex/FFmpeg request is not progress of the entire run.
const BANDS = Object.freeze({
  preprocess: [1, 7], understand: [8, 25], design: [30, 44],
  editing: [45, 67], draft_ready: [72, 80], rendering: [70, 82],
  reviewing: [83, 89], review_ready: [87, 90], final_export: [90, 98]
});
function createAutoStoryProgressTracker() {
  let overall = 0;
  return (payload = {}) => {
    const stage = String(payload.stage || payload.step || '').trim();
    const localPercent = typeof payload.percent === 'number' && Number.isFinite(payload.percent) ? payload.percent : null;
    const band = BANDS[stage];
    if (payload.overallComplete === true) overall = 100;
    else if (band) {
      const globalStage = ['preprocess','understand','design','editing'].includes(stage);
      const candidate = globalStage && localPercent !== null
        ? Math.max(band[0], Math.min(band[1], localPercent)) : band[0];
      overall = Math.max(overall, Math.min(99, candidate));
    }
    return { ...payload, ...(localPercent !== null ? { localPercent } : {}), percent: overall,
      progressScope: 'auto-story-overall' };
  };
}
module.exports = { createAutoStoryProgressTracker, BANDS };
