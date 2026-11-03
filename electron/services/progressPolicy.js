function clampProgressPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(100, numeric));
}

function createMonotonicProgressNormalizer(initialPercent = 0) {
  let highWaterMark = clampProgressPercent(initialPercent) || 0;

  return (payload = {}) => {
    const reportedPercent = clampProgressPercent(payload.percent);
    if (reportedPercent === null) return { ...payload };

    const percent = Math.max(highWaterMark, reportedPercent);
    highWaterMark = percent;
    if (percent === reportedPercent) {
      return { ...payload, percent };
    }
    return {
      ...payload,
      percent,
      reportedPercent
    };
  };
}

/**
 * Percent of one Auto Story run event. Only the runner's final event (final: true) may reach 100:
 * the progress bar fades out at 100%, so a nested step reporting 100 (one AI request, one draft
 * render) made the bar vanish and reappear on every later event.
 */
function autoStoryRunPercent(item = {}) {
  return Math.min(item.final ? 100 : 99, Number(item.percent) || 0);
}

module.exports = {
  clampProgressPercent,
  createMonotonicProgressNormalizer,
  autoStoryRunPercent
};
