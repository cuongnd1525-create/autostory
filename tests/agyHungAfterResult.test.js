"use strict";

// Live 2026-10-20 SERIES_PLAN: AGY wrote series-plan.json, answered
// SERIES_PLAN_DONE and emitted result SUCCESS at 138 s, then the process never
// exited; the host waited for the 480 s hard timeout and discarded the plan.

const assert = require("assert");
const { EventEmitter } = require("events");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { PassThrough, Writable } = require("stream");

const Stage1 = require("../electron/services/manualAntigravityStage1Service");

/** A child that emits the given result event and then stays alive until killed. */
function hangingSpawn({ result, calls }) {
  return (command, args) => {
    const child = new EventEmitter();
    child.pid = 70000 + calls.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let closed = false;
    const call = { killed: false };
    calls.push(call);
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    child.stdin.on("finish", () => {
      child.stdout.write(`${JSON.stringify({ event: "init", conversation_id: "conv-hang" })}\n`);
      child.stdout.write(`${JSON.stringify({ event: "step_update", step_update: { conversation_id: "conv-hang", step_index: 1, state: "DONE", step_type: "agent_response", duration_seconds: 2, usage: { input_tokens: 100, output_tokens: 10 } } })}\n`);
      child.stdout.write(`${JSON.stringify({ event: "result", result: result })}\n`);
      // no close: the real CLI kept running background requests
    });
    child.kill = () => {
      call.killed = true;
      if (closed) return;
      closed = true;
      setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit("close", 1); });
    };
    return child;
  };
}

async function runPhase(result, timers) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-hang-"));
  const calls = [];
  const messages = [];
  const service = new Stage1(
    { antigravityCommand: "agy", antigravityModel: "gemini-3.8-flash-high", antigravityCapacityRetryBaseMs: 0 },
    {
      spawn: hangingSpawn({ result, calls }),
      sleep: async () => {},
      authProbe: async () => ({ expiresAt: new Date(Date.now() + 50 * 60000), expiredFlag: false }),
      timers: { heartbeatMs: 20, hardTimeoutGraceMs: 0, ...timers }
    }
  );
  const metrics = Stage1.newMetrics();
  const startedAt = Date.now();
  let output = null;
  let error = null;
  try {
    output = await service.runAgyPhase({
      label: "SERIES_PLAN",
      commandConfig: service.buildCommand("plan", path.join(dir, "schema.json"), dir, { timeoutMs: 5000 }),
      prompt: "plan",
      resultDir: dir,
      onProgress: (item) => messages.push(String(item.message || "")),
      expectedProxyList: [],
      viewedProxySet: new Set(),
      metrics,
      logs: [],
      logBase: "seriesPlan"
    });
  } catch (caught) {
    error = caught;
  }
  await fs.rm(dir, { recursive: true, force: true });
  return { output, error, calls, messages, metrics, elapsedMs: Date.now() - startedAt };
}

(async () => {
  // SUCCESS result, process hangs -> killed after the grace, result accepted (not a 5 s timeout).
  {
    const run = await runPhase({ conversation_id: "conv-hang", status: "SUCCESS", response: "SERIES_PLAN_DONE\n" }, { postResultExitGraceMs: 50 });
    assert.ifError(run.error);
    assert(run.output.stdout.includes("SERIES_PLAN_DONE"));
    assert.strictEqual(run.calls.length, 1, "no retry, no second process");
    assert.strictEqual(run.calls[0].killed, true);
    assert(run.elapsedMs < 3000, `accepted after the grace, not the stage timeout (${run.elapsedMs} ms)`);
    const attempt = run.metrics.attempts[0];
    assert.strictEqual(attempt.ok, true);
    assert.strictEqual(attempt.terminationReason, "host_kill_after_result");
    assert.strictEqual(attempt.hungAfterResult, true);
    assert(run.messages.some((message) => message.includes("không tự thoát")));
  }
  // ERROR result keeps its existing handling (killed immediately, classified, not accepted).
  {
    const run = await runPhase({ conversation_id: "conv-hang", status: "ERROR", error: "The stream was interrupted" }, { postResultExitGraceMs: 50 });
    assert(run.error);
    assert.strictEqual(run.error.kind, "stream_interrupted");
  }
  // No result event at all -> still the normal stage timeout.
  {
    const calls = [];
    const service = new Stage1({ antigravityCommand: "agy" }, {
      spawn: (command, args) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
        calls.push(child);
        child.kill = () => setImmediate(() => child.emit("close", 1));
        return child;
      },
      sleep: async () => {},
      authProbe: async () => ({ expiresAt: new Date(Date.now() + 50 * 60000), expiredFlag: false }),
      timers: { heartbeatMs: 20, hardTimeoutGraceMs: 0, postResultExitGraceMs: 50 }
    });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-hang-"));
    await assert.rejects(service.runAgyPhase({
      label: "SERIES_PLAN", commandConfig: service.buildCommand("plan", path.join(dir, "s.json"), dir, { timeoutMs: 300 }),
      prompt: "plan", resultDir: dir, expectedProxyList: [], viewedProxySet: new Set(), metrics: Stage1.newMetrics(), logs: [], logBase: "p"
    }), (error) => ["hard_timeout", "inactivity_timeout"].includes(error.kind));
    await fs.rm(dir, { recursive: true, force: true });
  }
  console.log("agyHungAfterResult tests passed (SUCCESS result + hung process accepted after grace; errors/timeouts unchanged)");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
