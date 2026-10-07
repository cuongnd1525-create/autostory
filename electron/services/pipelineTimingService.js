"use strict";

// One machine-readable timing report per Gemini analysis package:
//   <packageDir>/pipeline-timing.json
// Stage 1 (re)creates it; render and draft review merge their sections in.
// Writes are serialized per file so concurrent variant renders cannot lose
// each other's sections.

const fs = require("fs/promises");
const path = require("path");

const FILE_NAME = "pipeline-timing.json";
const queues = new Map();

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

async function writeJson(filePath, payload) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}

function aggregate(report) {
  const renderVariants = Object.values(report.render?.variants || {});
  const reviewVariants = Object.values(report.review?.variants || {});
  report.tts = {
    durationMs: renderVariants.reduce((sum, item) => sum + num(item.ttsMs), 0),
    cacheHits: renderVariants.reduce((sum, item) => sum + num(item.ttsCacheHits), 0),
    cacheMisses: renderVariants.reduce((sum, item) => sum + num(item.ttsCacheMisses), 0)
  };
  report.render = {
    ...(report.render || {}),
    durationMs: num(report.render?.batchWallMs) || renderVariants.reduce((sum, item) => sum + num(item.durationMs), 0),
    segmentCacheHits: renderVariants.reduce((sum, item) => sum + num(item.segmentCacheHits), 0),
    segmentCacheMisses: renderVariants.reduce((sum, item) => sum + num(item.segmentCacheMisses), 0)
  };
  report.review = {
    ...(report.review || {}),
    packageMs: reviewVariants.reduce((sum, item) => sum + num(item.packageMs), 0),
    aiMs: reviewVariants.reduce((sum, item) => sum + num(item.aiMs), 0),
    inputVideoDurationSec: Number(reviewVariants.reduce((sum, item) => sum + num(item.inputVideoDurationSec), 0).toFixed(3))
  };
  report.totalMs = num(report.preprocessMs)
    + num(report.sourceUnderstanding?.durationMs)
    + num(report.seriesPlan?.durationMs)
    + num(report.scriptGeneration?.durationMs)
    + num(report.render.durationMs)
    + num(report.review.packageMs)
    + num(report.review.aiMs);
  report.updatedAt = new Date().toISOString();
  return report;
}

function enqueue(filePath, operation) {
  const previous = queues.get(filePath) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  queues.set(filePath, next);
  return next;
}

/** Replace the whole report (Stage 1 starts a fresh pipeline run). */
function resetPipelineTiming(packageDir, base = {}) {
  if (!packageDir) return Promise.resolve(null);
  const filePath = path.join(packageDir, FILE_NAME);
  return enqueue(filePath, async () => {
    const report = aggregate({ artifactType: "pipeline_timing", schemaVersion: 1, ...base });
    await writeJson(filePath, report);
    return report;
  });
}

/** Merge a per-variant entry into section "render" or "review". */
function mergeVariantTiming(packageDir, section, variantId, entry = {}, sectionPatch = {}) {
  if (!packageDir) return Promise.resolve(null);
  const filePath = path.join(packageDir, FILE_NAME);
  return enqueue(filePath, async () => {
    const report = (await readJson(filePath)) || { artifactType: "pipeline_timing", schemaVersion: 1 };
    const current = report[section] || {};
    report[section] = {
      ...current,
      ...sectionPatch,
      variants: { ...(current.variants || {}), ...(variantId ? { [variantId]: entry } : {}) }
    };
    aggregate(report);
    await writeJson(filePath, report);
    return report;
  }).catch(() => null);
}

module.exports = {
  FILE_NAME,
  resetPipelineTiming,
  mergeVariantTiming,
  aggregate
};
