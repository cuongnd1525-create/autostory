#!/usr/bin/env node
"use strict";

// Stage 1 (Antigravity) cold/warm benchmark on ONE existing analysis package.
//
//   node tools/run-stage1-benchmark.js "D:\Video\source-r-b4owcb8c8-gemini-analysis-pack"
//
// Run 1 deletes nothing except, with --cold, the persistent source-understanding
// cache entries for this source (so Phase A really runs). Run 2 runs Stage 1
// again on the same package and must report CACHE HIT / PHASE_A SKIPPED /
// 0 video view_file. Results: tools/stage1-benchmark-<timestamp>.json
//
// Options: --cold (force a cold first run)  --warm-only (skip run 1)
// Env: BENCH_CONFIG = path to the app config.json (defaults to the app's).

const fs = require("fs/promises");
const path = require("path");

const ManualAntigravityStage1Service = require("../electron/services/manualAntigravityStage1Service");

const CONFIG_PATH = process.env.BENCH_CONFIG || "C:\\Users\\Admin\\AppData\\Roaming\\cineviral-studio\\config.json";

function pick(su = {}) {
  return {
    cacheHit: su.cacheHit,
    phaseASkipped: su.phaseASkipped,
    durationMs: su.durationMs,
    proxyCount: su.proxyCount,
    sourceVideoDurationSec: su.sourceVideoDurationSec,
    viewFileCount: su.viewFileCount,
    duplicateVideoViewCount: su.duplicateVideoViewCount,
    transcriptReadCount: su.transcriptReadCount,
    manifestReadCount: su.manifestReadCount,
    contextReadCount: su.contextReadCount,
    agentTurnCount: su.agentTurnCount,
    agyProcessCount: su.agyProcessCount,
    timeoutOccurred: su.timeoutOccurred,
    serializationRepairUsed: su.serializationRepairUsed,
    fullMultimodalRestartCount: su.fullMultimodalRestartCount,
    inputTokens: su.inputTokens,
    outputTokens: su.outputTokens,
    timeoutMs: su.timeoutMs,
    failureKind: su.failureKind || null
  };
}

async function runOnce(label, settings, packageDir) {
  const service = new ManualAntigravityStage1Service(settings);
  const startedAt = Date.now();
  const messages = [];
  let error = null;
  try {
    await service.run({
      packageDir,
      onProgress: (item) => {
        const message = String(item.message || "");
        if (/^\[(SOURCE_UNDERSTANDING|PHASE_A|PHASE_B|SERIES_PLAN)/.test(message)) {
          messages.push(message);
          console.log(`[${label}] ${message}`);
        }
      }
    });
  } catch (caught) {
    error = caught;
    console.error(`[${label}] FAILED: ${caught.message}`);
  }
  const timing = JSON.parse(await fs.readFile(path.join(packageDir, "pipeline-timing.json"), "utf8").catch(() => "null")) || {};
  return {
    label,
    wallMs: Date.now() - startedAt,
    error: error ? { kind: error.kind || null, message: error.message } : null,
    stage1Ms: timing.stage1Ms ?? null,
    sourceUnderstanding: pick(timing.sourceUnderstanding),
    seriesPlanMs: timing.seriesPlan?.durationMs ?? null,
    phaseBMs: timing.scriptGeneration?.durationMs ?? null,
    phaseBVideoViews: timing.scriptGeneration?.videoViewFileCount ?? null,
    messages
  };
}

(async () => {
  const packageDir = path.resolve(process.argv[2] || "");
  if (!process.argv[2]) throw new Error("Usage: node tools/run-stage1-benchmark.js <packageDir> [--cold] [--warm-only]");
  const settings = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  const info = JSON.parse(await fs.readFile(path.join(packageDir, "package-info.json"), "utf8"));
  if (process.argv.includes("--cold") && info.cache?.cacheDir) {
    for (const name of await fs.readdir(info.cache.cacheDir).catch(() => [])) {
      if (/^source-understanding-v\d+-.*\.json$/.test(name)) {
        await fs.rename(path.join(info.cache.cacheDir, name), path.join(info.cache.cacheDir, `${name}.bench-backup-${Date.now()}`));
        console.log(`moved aside ${name}`);
      }
    }
  }
  const runs = [];
  if (!process.argv.includes("--warm-only")) runs.push(await runOnce("RUN1", settings, packageDir));
  runs.push(await runOnce("RUN2", settings, packageDir));
  const report = { packageDir, model: settings.antigravityModel || "", createdAt: new Date().toISOString(), runs };
  const outPath = path.join(__dirname, `stage1-benchmark-${Date.now()}.json`);
  await fs.writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(runs.map(({ messages, ...rest }) => rest), null, 2));
  console.log(`report: ${outPath}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
