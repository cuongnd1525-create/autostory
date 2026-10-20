"use strict";

// Antigravity token guard: wait for the keyring rotation instead of failing,
// and retry ONCE after a 401 (CLI logs 2026-10-02..19, see antigravityAuthGuard.js).

const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const Guard = require("../electron/services/antigravityAuthGuard");
const Stage1 = require("../electron/services/manualAntigravityStage1Service");
const { AntigravityCliProvider } = require("../electron/services/aiProviderRegistry");
const { createPhaseAwareSpawn } = require("./helpers/fakeAntigravity");

const AUTH_401_STDERR = 'Error: UNAUTHENTICATED (code 401): Request had invalid authentication credentials.\nAGY_ERROR: {"short_error":"UNAUTHENTICATED (code 401)","status":"UNAUTHENTICATED","error_code":401,"retryable":false}\n';
const token = (minutes, expiredFlag = false) => ({ expiresAt: new Date(Date.now() + minutes * 60000), expiredFlag });

async function guardUnitTests() {
  // Real log line format.
  const parsed = Guard.parseKeyringExpiry("I1019 10:21:41.182100     244 keyring.go:64] keyringAuth: loaded token, expiry=2026-10-19 11:16:28.2656326 +0700 +07 expired=false");
  assert.strictEqual(parsed.expiresAt.toISOString(), "2026-10-19T04:16:28.000Z");
  assert.strictEqual(parsed.expiredFlag, false);

  assert(Guard.isAntigravityAuthError(new Error(`agy exited with code 1: ${AUTH_401_STDERR}`)));
  assert(Guard.isAntigravityAuthError("error getting token source: You are not logged into Antigravity."));
  assert(!Guard.isAntigravityAuthError("UNAVAILABLE (code 503): No capacity available"));
  assert(!Guard.isAntigravityAuthError('{"duration_seconds": 401.2}'));

  // The 2026-10-19 11:04 case: 11m48s left, 12 min required -> ONE long sleep
  // until just after the app's rotation (expiry - 300 s), then OK.
  {
    const sleeps = [];
    let probes = 0;
    const result = await Guard.waitForAntigravityToken({
      probe: async () => { probes += 1; return probes === 1 ? { expiresAt: new Date(Date.now() + 708000), expiredFlag: false } : token(55); },
      requiredSec: 720,
      sleep: async (ms) => { sleeps.push(ms); }
    });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.rotated, true);
    assert.deepStrictEqual(sleeps, [418000], "sleep 708-300+10 s, not a poll storm");
    assert.strictEqual(probes, 2);
  }
  // Never rotates -> "short" once the budget is spent; expired -> "expired".
  {
    const result = await Guard.waitForAntigravityToken({ probe: async () => token(6), requiredSec: 720, maxWaitSec: 90, pollSec: 30, sleep: async () => {} });
    assert.strictEqual(result.status, "short");
    assert.strictEqual(result.waitedSec, 90);
    const expired = await Guard.waitForAntigravityToken({ probe: async () => token(-1, true), requiredSec: 720, maxWaitSec: 60, pollSec: 30, sleep: async () => {} });
    assert.strictEqual(expired.status, "expired");
  }
  // Expired token that the CLI refreshes after expiry -> OK after polling.
  {
    let probes = 0;
    const result = await Guard.waitForAntigravityToken({ probe: async () => (++probes < 3 ? token(-0.5, true) : token(60)), requiredSec: 720, pollSec: 30, sleep: async () => {} });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.waitedSec, 60);
  }
  // Unknown expiry and cancellation.
  assert.strictEqual((await Guard.waitForAntigravityToken({ probe: async () => null, requiredSec: 720 })).status, "unknown");
  {
    let cancelled = false;
    const result = await Guard.waitForAntigravityToken({ probe: async () => token(6), requiredSec: 720, sleep: async () => { cancelled = true; }, isCancelled: () => cancelled });
    assert.strictEqual(result.status, "cancelled");
  }
  // Long enough on the first probe: no sleep, no second probe.
  {
    let probes = 0;
    const result = await Guard.waitForAntigravityToken({ probe: async () => { probes += 1; return token(40); }, requiredSec: 720, sleep: async () => { throw new Error("must not sleep"); } });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(probes, 1);
  }
}

async function runAgyPhaseTests() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-auth-"));
  const build = (responses, settings = {}) => {
    const calls = [];
    let index = 0;
    const respond = () => responses[Math.min(index++, responses.length - 1)];
    const probes = [];
    const service = new Stage1(
      { antigravityCommand: "agy", antigravityModel: "gemini-3.8-flash-high", antigravityCapacityRetryBaseMs: 0, ...settings },
      {
        spawn: createPhaseAwareSpawn({ calls, respond }),
        sleep: async () => {},
        authProbe: async () => { probes.push(Date.now()); return token(50); }
      }
    );
    return { service, calls, probes };
  };
  const runPhase = async (service, messages) => service.runAgyPhase({
    label: "PHASE_B_SCRIPT_1",
    commandConfig: service.buildCommand("write script-1.json", path.join(dir, "schema.json"), dir, { timeoutMs: 600000 }),
    prompt: "write script-1.json",
    resultDir: dir,
    onProgress: (item) => messages.push(String(item.message || "")),
    expectedProxyList: [],
    viewedProxySet: new Set(),
    metrics: Stage1.newMetrics(),
    logs: [],
    logBase: "script1"
  });
  const AUTH = { rawResult: "", exitCode: 1, stderr: AUTH_401_STDERR };
  const OK = { rawResult: "PART_DONE" };

  // 401 once -> fresh re-probe + one retry -> success.
  {
    const { service, calls, probes } = build([AUTH, OK]);
    const messages = [];
    const result = await runPhase(service, messages);
    assert(result);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(probes.length, 2, "initial probe + fresh re-probe after 401 (cache bypassed)");
    assert(messages.some((message) => message.startsWith("[PHASE_B_SCRIPT_1] 401 UNAUTHENTICATED")));
  }
  // 401 twice -> auth error after exactly one retry.
  {
    const { service, calls } = build([AUTH, AUTH]);
    await assert.rejects(runPhase(service, []), (error) => error.kind === "auth" && /401/.test(error.message));
    assert.strictEqual(calls.length, 2);
  }
  // Retry disabled -> old behaviour.
  {
    const { service, calls } = build([AUTH, OK], { antigravityAuthRetryOn401: false });
    await assert.rejects(runPhase(service, []), (error) => error.kind === "auth");
    assert.strictEqual(calls.length, 1);
  }
  // Short token -> waits for the rotation, then runs (no error).
  {
    const calls = [];
    let probeNo = 0;
    const sleeps = [];
    const service = new Stage1(
      { antigravityCommand: "agy", antigravityModel: "gemini-3.8-flash-high" },
      {
        spawn: createPhaseAwareSpawn({ calls, respond: () => OK }),
        sleep: async (ms) => { sleeps.push(ms); },
        authProbe: async () => { probeNo += 1; return probeNo === 1 ? { expiresAt: new Date(Date.now() + 708000), expiredFlag: false } : token(55); }
      }
    );
    const messages = [];
    await runPhase(service, messages);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(sleeps, [418000]);
    assert(messages.some((message) => message.includes("Đang chờ token mới")));
  }
  await fs.rm(dir, { recursive: true, force: true });
}

async function providerTests() {
  const make = ({ outputs, probes, settings = {} }) => {
    const calls = [];
    const sleeps = [];
    let probeIndex = 0;
    const provider = new AntigravityCliProvider({ antigravityCommand: "agy", ...settings }, {
      runCliJson: async (options) => {
        calls.push(options);
        const next = outputs[Math.min(calls.length - 1, outputs.length - 1)];
        if (next instanceof Error) throw next;
        return next;
      },
      authProbe: async () => probes[Math.min(probeIndex++, probes.length - 1)],
      sleep: async (ms) => { sleeps.push(ms); }
    });
    return { provider, calls, sleeps, probeCount: () => probeIndex };
  };
  const auth401 = () => new Error(`agy exited with code 1: ${AUTH_401_STDERR}`);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    // 401 once -> re-probe + retry once.
    {
      const run = make({ outputs: [auth401(), '{"ok":true}'], probes: [token(50), token(58)] });
      assert.deepStrictEqual(await run.provider.generateJson("translate"), { ok: true });
      assert.strictEqual(run.calls.length, 2);
      assert.strictEqual(run.probeCount(), 2);
    }
    // 401 twice -> throws.
    {
      const run = make({ outputs: [auth401(), auth401()], probes: [token(50)] });
      await assert.rejects(run.provider.generateJson("translate"), /401/);
      assert.strictEqual(run.calls.length, 2);
    }
    // Non-auth errors are not retried here.
    {
      const run = make({ outputs: [new Error("agy exited with code 1: UNAVAILABLE (code 503)")], probes: [token(50)] });
      await assert.rejects(run.provider.generateJson("translate"), /503/);
      assert.strictEqual(run.calls.length, 1);
    }
    // Token shorter than 6 min -> waits for rotation, then calls once.
    {
      const run = make({ outputs: ['{"ok":1}'], probes: [token(5.5), token(55)] });
      assert.deepStrictEqual(await run.provider.generateJson("review"), { ok: 1 });
      assert.strictEqual(run.calls.length, 1);
      assert.strictEqual(run.sleeps.length, 1);
    }
    // Expiry cannot be read -> proceed without waiting; cached across calls.
    {
      const run = make({ outputs: ['{"a":1}'], probes: [null] });
      await run.provider.generateJson("x");
      await run.provider.generateJson("y");
      assert.strictEqual(run.calls.length, 2);
      assert.strictEqual(run.probeCount(), 1, "unknown result is cached, no probe per call");
    }
    // Guard can be switched off.
    {
      const run = make({ outputs: ['{"a":1}'], probes: [token(1)], settings: { antigravityProviderAuthGuard: false } });
      await run.provider.generateJson("x");
      assert.strictEqual(run.probeCount(), 0);
    }
  } finally {
    console.warn = originalWarn;
  }
}

(async () => {
  await guardUnitTests();
  await runAgyPhaseTests();
  await providerTests();
  console.log("antigravityAuthGuard tests passed (rotation wait, 401 retry in runAgyPhase and AntigravityCliProvider)");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
