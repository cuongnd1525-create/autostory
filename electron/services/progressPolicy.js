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

module.exports = {
  clampProgressPercent,
  createMonotonicProgressNormalizer
};
