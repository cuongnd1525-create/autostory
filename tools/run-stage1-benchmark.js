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
// Options: --cold (force a cold first run: moves aside the global AND per-chunk
//          understanding caches of this source)  --warm-only (skip run 1)
//          --concurrency=N (sourceUnderstandingMapConcurrency, default from config or 2)
//          --global (legacy global_single_pass Phase A, for comparison only)
//          --phase-a-only (map/reduce diagnostics only: no series plan, no Phase B)
//
// Diagnostic sequence (2026-10-07):
//   node tools/run-stage1-benchmark.js <pack> --cold --phase-a-only --concurrency=1
//   node tools/run-stage1-benchmark.js <pack> --cold --phase-a-only --concurrency=2   (only if the first is 3/3 + reducer OK)
// Env: BENCH_CONFIG = path to the app config.json (defaults to the app's).

const fs = require("fs/promises");
const path = require("path");

const ManualAntigravityStage1Service = require("../electron/services/manualAntigravityStage1Service");

const CONFIG_PATH = process.env.BENCH_CONFIG || "C:\\Users\\Admin\\AppData\\Roaming\\cineviral-studio\\config.json";

function pickChunk(chunk = {}) {
  return {
    chunkId: chunk.chunkId,
    range: `${chunk.sourceStartSec}-${chunk.sourceEndSec}`,
    cacheHit: chunk.cacheHit,
    cacheStatus: chunk.cacheStatus,
    durationMs: chunk.durationMs ?? null,
    agyRuntimeMs: chunk.agyRuntimeMs ?? null,
    agyProcessCount: chunk.agyProcessCount ?? 0,
    viewFileCount: chunk.viewFileCount ?? 0,
    agentTurns: chunk.agentTurns ?? 0,
    inputTokens: chunk.inputTokens ?? null,
    outputTokens: chunk.outputTokens ?? null,
    retryCount: chunk.retryCount ?? 0,
    promptChars: chunk.promptChars ?? null,
    contextMode: chunk.contextMode || null,
    runIds: chunk.runIds || [],
    pids: chunk.pids || [],
    conversationIds: chunk.conversationIds || [],
    startedAt: chunk.startedAt || null,
    endedAt: chunk.endedAt || null,
    terminationReasons: chunk.terminationReasons || [],
    streamInterrupted: chunk.streamInterrupted || false,
    promptBlocked: chunk.promptBlocked || false,
    promptBlockRetryCount: chunk.promptBlockRetryCount || 0,
    coverageRetryCount: chunk.coverageRetryCount || 0,
    coverage: chunk.coverage || null,
    serializationRepair: chunk.serializationRepair || null,
    eventCount: chunk.eventCount ?? null,
    failureKind: chunk.failureKind || null,
    failureMessage: chunk.failureMessage || null
  };
}

function pick(su = {}) {
  return {
    architecture: su.architecture || null,
    totalDurationMs: su.totalDurationMs ?? su.durationMs ?? null,
    map: su.map ? {
      chunkCount: su.map.chunkCount,
      concurrency: su.map.concurrency,
      maxConcurrentAgyProcesses: su.map.maxConcurrentAgyProcesses,
      durationMs: su.map.durationMs,
      cacheHits: su.map.cacheHits,
      cacheMisses: su.map.cacheMisses,
      agyProcessCount: su.map.agyProcessCount,
      viewFileCount: su.map.viewFileCount,
      duplicateVideoViewCount: su.map.duplicateVideoViewCount,
      failedChunkCount: su.map.failedChunkCount,
      chunks: (su.map.chunks || []).map(pickChunk)
    } : null,
    reduce: su.reduce ? {
      cacheHit: su.reduce.cacheHit,
      durationMs: su.reduce.durationMs,
      agyProcessCount: su.reduce.agyProcessCount,
      videoViewFileCount: su.reduce.videoViewFileCount,
      retryCount: su.reduce.retryCount,
      promptBlockRetryCount: su.reduce.promptBlockRetryCount || 0,
      attempts: (su.reduce.attempts || []).map((attempt) => ({ runId: attempt.runId, pid: attempt.pid, ok: attempt.ok, kind: attempt.kind || null, durationMs: attempt.durationMs, terminationReason: attempt.terminationReason, streamInterrupted: attempt.streamInterrupted })),
      inputChars: su.reduce.inputChars,
      failureKinds: su.reduce.failureKinds
    } : null,
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
      stopAfter: process.argv.includes("--phase-a-only") ? "source_understanding" : null,
      onProgress: (item) => {
        const message = String(item.message || "");
        const hostStatus = /^\[(SOURCE_UNDERSTANDING|PHASE_A|PHASE_B|SERIES_PLAN|PHASE_A_REDUCE)[\] ]/.test(message)
          || /^\[(MAP chunk-\d+|REDUCE)\] (START|OK|FAILED|RETRY|CACHE)/.test(message)
          || /\] AUTH:/.test(message);
        if (hostStatus) {
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
  const concurrencyArg = process.argv.find((arg) => arg.startsWith("--concurrency="));
  if (concurrencyArg) settings.sourceUnderstandingMapConcurrency = Number(concurrencyArg.split("=")[1]);
  if (process.argv.includes("--global")) settings.sourceUnderstandingArchitecture = "global_single_pass";
  const info = JSON.parse(await fs.readFile(path.join(packageDir, "package-info.json"), "utf8"));
  if (process.argv.includes("--cold") && info.cache?.cacheDir) {
    for (const name of await fs.readdir(info.cache.cacheDir).catch(() => [])) {
      if (/^source-understanding-v\d+-.*\.json$/.test(name)) {
        await fs.rename(path.join(info.cache.cacheDir, name), path.join(info.cache.cacheDir, `${name}.bench-backup-${Date.now()}`));
        console.log(`moved aside ${name}`);
      }
    }
    const chunkDir = path.join(info.cache.cacheDir, "chunk-understanding");
    if (await fs.stat(chunkDir).then(() => true, () => false)) {
      const backup = `${chunkDir}.bench-backup-${Date.now()}`;
      await fs.rename(chunkDir, backup);
      console.log(`moved aside chunk-understanding -> ${path.basename(backup)}`);
    }
  }
  const runs = [];
  if (!process.argv.includes("--warm-only")) runs.push(await runOnce("RUN1", settings, packageDir));
  runs.push(await runOnce("RUN2", settings, packageDir));
  const report = {
    packageDir,
    model: settings.antigravityModel || "",
    mapConcurrency: settings.sourceUnderstandingMapConcurrency ?? "default(1)",
    phaseAOnly: process.argv.includes("--phase-a-only"),
    createdAt: new Date().toISOString(),
    runs
  };
  const outPath = path.join(__dirname, `stage1-benchmark-${Date.now()}.json`);
  await fs.writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(runs.map(({ messages, ...rest }) => rest), null, 2));
  for (const item of runs) {
    const su = item.sourceUnderstanding;
    console.log(`\n${item.label}: ${item.error ? `FAILED (${item.error.kind})` : "OK"} | Stage 1 ${(item.stage1Ms / 1000).toFixed(1)}s | Phase A ${((su.totalDurationMs || 0) / 1000).toFixed(1)}s`
      + ` (map ${((su.map?.durationMs || 0) / 1000).toFixed(1)}s, reduce ${((su.reduce?.durationMs || 0) / 1000).toFixed(1)}s)`
      + ` | series plan ${((item.seriesPlanMs || 0) / 1000).toFixed(1)}s | Phase B ${((item.phaseBMs || 0) / 1000).toFixed(1)}s`);
    console.log(`  view_file video=${su.viewFileCount ?? 0} AGY processes=${su.agyProcessCount ?? 0} chunk cache hit/miss=${su.map?.cacheHits ?? "-"}/${su.map?.cacheMisses ?? "-"} global cache=${su.cacheHit ? "HIT" : "MISS"} max concurrent maps=${su.map?.maxConcurrentAgyProcesses ?? "-"}`);
    for (const chunk of su.map?.chunks || []) {
      console.log(`  ${chunk.chunkId} [${chunk.range}] ${chunk.cacheHit ? "HIT" : chunk.failureKind ? `FAIL ${chunk.failureKind}` : "OK"} ${((chunk.durationMs || 0) / 1000).toFixed(1)}s agy=${((chunk.agyRuntimeMs || 0) / 1000).toFixed(1)}s view_file=${chunk.viewFileCount} events=${chunk.eventCount ?? "-"} turns=${chunk.agentTurns} tokens in/out=${chunk.inputTokens ?? "-"}/${chunk.outputTokens ?? "-"}`
        + ` pid=${(chunk.pids || []).join(",") || "-"} end=${(chunk.terminationReasons || []).join(",") || "-"} streamInterrupted=${chunk.streamInterrupted} promptBlockRetry=${chunk.promptBlockRetryCount} coverageRetry=${chunk.coverageRetryCount} repair=${chunk.serializationRepair || "none"} ${chunk.startedAt || ""}→${chunk.endedAt || ""}`);
    }
    if (su.reduce) console.log(`  reduce ${su.reduce.cacheHit ? "HIT" : ""} ${((su.reduce.durationMs || 0) / 1000).toFixed(1)}s processes=${su.reduce.agyProcessCount} video view_file=${su.reduce.videoViewFileCount} failures=${(su.reduce.failureKinds || []).join(",") || "-"}`);
  }
  console.log(`report: ${outPath}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
