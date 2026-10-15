const fs = require("fs/promises");
const path = require("path");
const Media = require("./recapMediaService");
const { fingerprint } = require("./recapEditorialService");
class RecapDraftReviewService {
  constructor(settings = {}, dependencies = {}) {
    this.media = dependencies.media || new Media(settings);
    this.chunkSec = Math.max(40, Math.min(120, Number(settings.recapReviewChunkSec) || 70));
  }
  async review(request, reviewSingle) {
    const signal = request.signal || request.cancelToken?.signal;
    signal?.throwIfAborted();
    const metadata = await this.media.probeVideo(request.draftVideoPath);
    if (!(metadata.duration > this.chunkSec + 10)) return reviewSingle(request);
    const stat = await fs.stat(request.draftVideoPath);
    const key = fingerprint({ version: 1, file: request.draftVideoPath, size: stat.size, modified: stat.mtimeMs,
      decisions: request.decisions || request.timeline, story: request.storyModel, chunkSec: this.chunkSec });
    const root = path.join(path.dirname(request.draftVideoPath), ".recap-review", key.slice(0, 24));
    const legacyRoot = path.join(path.dirname(request.draftVideoPath), ".recap-review", key);
    await fs.mkdir(root, { recursive: true });
    const spans = [];
    for (let start = 0; start < metadata.duration - 4; start += this.chunkSec) {
      let end = Math.min(metadata.duration, start + this.chunkSec + 2);
      if (metadata.duration - end < 15) end = metadata.duration;
      spans.push({ start, end }); if (end === metadata.duration) break;
    }
    const reviews = [], coverage = [];
    for (let index = 0; index < spans.length; index++) {
      signal?.throwIfAborted();
      const span = spans[index], cache = path.join(root, `review-${index}.json`);
      let review;
      try { review = JSON.parse(await fs.readFile(cache, "utf8")); } catch (_) {}
      if (!review) try { review = JSON.parse(await fs.readFile(path.join(legacyRoot, `review-${index}.json`), "utf8")); } catch (_) {}
      if (!(typeof review?.overall_score === "number" && review.overall_score >= 0 && review.overall_score <= 1 && Array.isArray(review.issues)
        && review.issues.every(issue => ["low", "medium", "high", "critical"].includes(issue.severity)))) review = null;
      const onProgress = value => request.onProgress?.({ ...value, chunkIndex: index + 1, chunkCount: spans.length });
      if (!review) {
        onProgress({ message: `Kiểm tra draft đoạn ${index + 1}/${spans.length} (${span.start.toFixed(1)}–${span.end.toFixed(1)}s)...` });
        const clip = await this.media.extractProxyChunk({ proxyPath: request.draftVideoPath, outputDir: root,
          chunk: { chunkIndex: `review-${index + 1}`, sourceStartSec: span.start, sourceEndSec: span.end, durationSec: span.end - span.start } });
        review = await reviewSingle({ ...request, draftVideoPath: clip, signal, onProgress,
          reviewWindow: { ...span, duration: metadata.duration, index, count: spans.length } });
        await fs.writeFile(cache, JSON.stringify(review));
      } else onProgress({ message: `Khôi phục review draft đoạn ${index + 1}/${spans.length} đã kiểm tra.` });
      reviews.push(review); coverage.push({ start: span.start, end: span.end });
    }
    if (!reviews.length || coverage[0].start !== 0 || Math.abs(coverage.at(-1).end - metadata.duration) > .001
      || coverage.some((span, index) => index > 0 && span.start > coverage[index - 1].end)) throw new Error("Review chưa bao phủ đủ toàn bộ draft.");
    const result = { overall_score: Math.min(...reviews.map(review => review.overall_score)),
      summary: reviews.map((review, index) => `Đoạn ${index + 1}: ${review.summary}`).join(" "),
      issues: reviews.flatMap((review, index) => review.issues.map(issue => ({ ...issue, issue_id: `${index + 1}_${issue.issue_id}` }))), coverage };
    await fs.writeFile(path.join(root, "review.json"), JSON.stringify(result, null, 2));
    return result;
  }
}
module.exports = RecapDraftReviewService;
