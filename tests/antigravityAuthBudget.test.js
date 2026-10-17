"use strict";

// Regression for the real 2026-10-09 case: Phase B starts with 12m57s
// of OAuth TTL but its MAXIMUM timeout is 15m + 2m margin.
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const Stage1 = require("../electron/services/manualAntigravityStage1Service");
const { createPhaseAwareSpawn, defaultResponder } = require("./helpers/fakeAntigravity");

const ttl = (seconds) => ({ expiresAt: new Date(Date.now() + seconds * 1000), expiredFlag: false });

async function checkAuthBudget() {
  const service = new Stage1({}, { authProbe: async () => ttl(777) });
  await assert.rejects(
    service.ensureAntigravityAuth({ label: "PHASE_A", stageTimeoutMs: 900000 }),
    (error) => error.kind === "auth_ttl",
    "video phase still requires a full safe timeout"
  );
  const auth = await service.ensureAntigravityAuth({ label: "PHASE_B", stageTimeoutMs: 900000, textOnly: true });
  assert(auth.tokenRemainingSec >= 775, "valid token must be usable for a text-only phase");
  const original = { command: "agy", args: ["--print-timeout", "900s", "--print=prompt"], timeoutMs: 900000 };
  const bounded = service.boundTextPhaseCommand(original, auth);
  assert(bounded.timeoutMs >= 620000 && bounded.timeoutMs <= 630000, "bounded timeout respects expiry - margin - hard grace");
  assert.deepStrictEqual(bounded.args.slice(-2), ["--print-timeout", `${bounded.timeoutMs / 1000}s`]);
  assert.strictEqual(original.timeoutMs, 900000, "caller config is unchanged");
  assert.deepStrictEqual(original.args.slice(0, 2), ["--print-timeout", "900s"]);
  const metrics = { agyProcessCount: 0, attempts: [], retryCount: 0 };
  let dispatched = null;
  service.runAgyOnce = async ({ commandConfig }) => {
    dispatched = commandConfig;
    return { ok: true, result: { stdout: "OK" } };
  };
  const result = await service.runAgyPhase({
    label: "PHASE_B", commandConfig: original, prompt: "prompt", resultDir: os.tmpdir(),
    metrics, logs: [], viewedProxySet: new Set()
  });
  assert.strictEqual(result.stdout, "OK");
  assert(dispatched.timeoutMs < 900000 && dispatched.timeoutMs > 600000);

  const noTime = new Stage1({}, { authProbe: async () => ttl(150) });
  await assert.rejects(
    noTime.ensureAntigravityAuth({ label: "PHASE_B", stageTimeoutMs: 900000, textOnly: true }),
    (error) => error.kind === "auth_ttl",
    "no attempt if less than minimum turn time plus safety"
  );
  const unknown = new Stage1({}, { authProbe: async () => null });
  const missing = await unknown.ensureAntigravityAuth({ label: "PHASE_B", stageTimeoutMs: 900000, textOnly: true });
  assert.strictEqual(unknown.boundTextPhaseCommand(original, missing), original, "unknown expiry retains configured deadline");

  let generation = 0;
  const refreshed = new Stage1({}, { authProbe: async () => ttl(++generation > 1 ? 3600 : 777) });
  const retriedTimeouts = [];
  refreshed.runAgyOnce = async ({ commandConfig }) => {
    retriedTimeouts.push(commandConfig.timeoutMs);
    return retriedTimeouts.length === 1
      ? { ok: false, kind: "auth", error: new Error("401") }
      : { ok: true, result: { stdout: "new token" } };
  };
  const retryMetrics = { agyProcessCount: 0, attempts: [], retryCount: 0 };
  const retried = await refreshed.runAgyPhase({
    label: "PHASE_B", commandConfig: original, prompt: "prompt", resultDir: os.tmpdir(),
    metrics: retryMetrics, logs: [], viewedProxySet: new Set()
  });
  assert.strictEqual(retried.stdout, "new token");
  assert.strictEqual(retriedTimeouts.length, 2, "retry once only after verified token rotation");
  assert.strictEqual(retryMetrics.retryCount, 1);
  assert(retriedTimeouts[1] > retriedTimeouts[0]);

  const notRefreshed = new Stage1({}, { authProbe: async () => ttl(777) });
  let unrefreshedAttempts = 0;
  notRefreshed.runAgyOnce = async () => {
    unrefreshedAttempts += 1;
    return { ok: false, kind: "auth", error: new Error("401") };
  };
  await assert.rejects(notRefreshed.runAgyPhase({
    label: "PHASE_B", commandConfig: original, prompt: "prompt", resultDir: os.tmpdir(),
    metrics: { agyProcessCount: 0, attempts: [], retryCount: 0 }, logs: [], viewedProxySet: new Set()
  }), (error) => error.kind === "auth");
  assert.strictEqual(unrefreshedAttempts, 1, "do not blind-retry 401 with the same token");
}

async function checkSeriesCache() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-ttl-series-"));
  const pass1Dir = path.join(root, "01-GUI-GEMINI");
  const cacheDir = path.join(root, "source-cache");
  try {
    await fs.mkdir(pass1Dir, { recursive: true });
    const promptPath = path.join(pass1Dir, "01-gemini-highlight-scripts-prompt.txt");
    await fs.writeFile(promptPath, "### SELECTED PROMPT PROFILE\n- prompt_profile: viral_tiktok_crime_part1\nGenerate Script 1, Script 3 and Script 4.", "utf8");
    await fs.writeFile(path.join(pass1Dir, "scene-manifest.json"), JSON.stringify({ videoDurationSec: 20, scenes: [] }));
    await fs.writeFile(path.join(pass1Dir, "analysis-proxy.mp4"), "proxy");
    await fs.writeFile(path.join(root, "package-info.json"), JSON.stringify({
      workflow: "manual_gemini_draft_review", pass1UploadDir: pass1Dir, promptPath,
      cache: { sourceFingerprint: "stable-case-fingerprint", cacheDir }
    }));
    const firstCalls = [];
    const responder = defaultResponder({ durationSec: 20 });
    const first = new Stage1({ antigravityCommand: "agy", antigravityModel: "test-model" }, {
      authProbe: async () => ttl(3600),
      spawn: createPhaseAwareSpawn({ calls: firstCalls, respond: (kind, prompt, call) => kind === "phase_b"
        ? { resultObject: { status: "ERROR", error: "UNAUTHENTICATED (code 401)" }, exitCode: 1 }
        : responder(kind, prompt, call) })
    });
    await assert.rejects(first.run({ packageDir: root }), (error) => error.kind === "auth");
    assert(firstCalls.some((call) => call.kind === "series_plan"), "first run must lock a real plan");

    const secondCalls = [];
    const second = new Stage1({ antigravityCommand: "agy", antigravityModel: "test-model" }, {
      authProbe: async () => ttl(777),
      spawn: createPhaseAwareSpawn({ calls: secondCalls, respond: responder })
    });
    const result = await second.run({ packageDir: root });
    assert.strictEqual(result.timing.seriesPlan.cacheHit, true, "a valid locked plan survives a retry");
    assert.strictEqual(result.timing.seriesPlan.agyProcessCount, 0, "cached plan uses no extra AGY call");
    assert.deepStrictEqual(secondCalls.map((call) => call.kind), ["phase_b"], "no source rewatch and no second series plan");
    assert(secondCalls[0].args.includes("--print-timeout"));
    const timeoutIdx = secondCalls[0].args.indexOf("--print-timeout");
    assert(Number.parseInt(secondCalls[0].args[timeoutIdx + 1], 10) < 900, "Phase B uses bounded timeout");

    await fs.writeFile(path.join(pass1Dir, "hook-contract.json"), JSON.stringify({ selectedHookId: "changed" }));
    const changedCalls = [];
    const third = new Stage1({ antigravityCommand: "agy", antigravityModel: "test-model" }, {
      authProbe: async () => ttl(3600),
      spawn: createPhaseAwareSpawn({ calls: changedCalls, respond: responder })
    });
    await third.run({ packageDir: root });
    assert(changedCalls.some((call) => call.kind === "series_plan"), "hook change invalidates plan cache");
    assert(!changedCalls.some((call) => call.kind === "map"), "hook change does not require video rewatch");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

(async () => {
  await checkAuthBudget();
  await checkSeriesCache();
  console.log("antigravity auth budget and series-plan recovery tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
