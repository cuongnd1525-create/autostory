const fs = require("fs/promises");
const path = require("path");
const Media = require("./recapMediaService");
const { fingerprint } = require("./recapEditorialService");
class RecapDraftReviewService {
  constructor(settings = {}, dependencies = {}) {
    this.media = dependencies.media || new Media(settings);
    this.explicitChunkSec = Number(settings.recapReviewChunkSec) || 0;
    this.chunkSec = Math.max(40, Math.min(180, this.explicitChunkSec || 70));
  }
  async review(request, reviewSingle, reviewEditorial) {
    const signal = request.signal || request.cancelToken?.signal;
    signal?.throwIfAborted();
    const metadata = await this.media.probeVideo(request.draftVideoPath);
    const effectiveChunkSec = (!this.explicitChunkSec && metadata.duration > 240) ? 140 : this.chunkSec;
    if (!(metadata.duration > effectiveChunkSec + 10)) return reviewSingle(request);
    const stat = await fs.stat(request.draftVideoPath);
    const key = fingerprint({ version: 4, file: request.draftVideoPath, size: stat.size, modified: stat.mtimeMs,
      decisions: request.decisions || request.timeline, story: request.storyModel, sourceEvents: request.sourceEvents,
      editorialContext: request.editorialContext, chunkSec: effectiveChunkSec });
    const root = path.join(path.dirname(request.draftVideoPath), ".recap-review", key.slice(0, 24));
    const legacyRoot = path.join(path.dirname(request.draftVideoPath), ".recap-review", key);
    await fs.mkdir(root, { recursive: true });
    const spans = [];
    for (let start = 0; start < metadata.duration - 4; start += effectiveChunkSec) {
      let end = Math.min(metadata.duration, start + effectiveChunkSec + 2);
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
    const minScore = Math.min(...reviews.map(review => review.overall_score));
    const assessments = reviews.map(review => review.duration_assessment).filter(Boolean);
    const result = { overall_score: minScore,
      summary: reviews.map((review, index) => `Đoạn ${index + 1}: ${review.summary}`).join(" "),
      issues: reviews.flatMap((review, index) => review.issues.map(issue => ({
        ...issue,
        issue_id: `${index + 1}_${issue.issue_id}`
      }))), coverage };
    if (!request.editorialContext?.qualityFirst && assessments.length === reviews.length) result.duration_assessment = {
      verdict: assessments.find(item => item.verdict !== "appropriate")?.verdict || "appropriate",
      reason: [...new Set(assessments.map(item => item.reason))].join(" ")
    };
    if (request.editorialContext?.qualityFirst) {
      if (typeof reviewEditorial !== "function") throw new Error("Thiếu bước review toàn bộ nội dung; không dùng nhận xét từng đoạn để kết luận thiếu cốt truyện.");
      // Invalidate only the text verdict after removing the unverified story outline;
      // the already completed audiovisual observations remain reusable.
      const cache = path.join(root, `editorial-v4-${fingerprint(reviews).slice(0, 12)}.json`);
      const valid = item => typeof item?.overall_score === "number" && Number.isFinite(item.overall_score)
        && item.overall_score >= 0 && item.overall_score <= 1 && Array.isArray(item.issues)
        && item.issues.every(issue => ["low", "medium", "high", "critical"].includes(issue.severity))
        && ["appropriate", "too_short", "too_long"].includes(item.duration_assessment?.verdict)
        && String(item.duration_assessment?.reason || "").trim();
      let editorial;
      try { editorial = JSON.parse(await fs.readFile(cache, "utf8")); } catch (_) {}
      if (!valid(editorial)) {
        request.onProgress?.({ message: "Đang đánh giá toàn bộ lời kể, diễn biến và kết thúc sau khi kiểm tra đủ các đoạn video..." });
        editorial = await reviewEditorial({ ...request, signal });
        if (!valid(editorial)) throw new Error("Review toàn bộ nội dung không hợp lệ; chưa xác minh được cốt truyện và thời lượng.");
        await fs.writeFile(cache, JSON.stringify(editorial));
      }
      result.overall_score = Math.min(result.overall_score, editorial.overall_score);
      result.summary += ` Toàn bộ nội dung: ${editorial.summary}`;
      result.issues.push(...editorial.issues);
      result.duration_assessment = editorial.duration_assessment;
    }
    await fs.writeFile(path.join(root, "review.json"), JSON.stringify(result, null, 2));
    return result;
  }
}
module.exports = RecapDraftReviewService;
