"use strict";

/**
 * Antigravity (AGY CLI) OAuth token guard shared by the manual Stage 1
 * service and the generic AntigravityCliProvider.
 *
 * Evidence (CLI logs 2026-09-22 .. 2026-10-19, ~/.gemini/antigravity-cli/log):
 *  - The Google OAuth access token lives 1 h and sits in the OS keyring; every
 *    AGY process loads it at start ("keyringAuth: loaded token, expiry=...").
 *  - While the Antigravity app is open and signed in, the keyring token is
 *    rotated ~5 min BEFORE it expires (55-min cadence: 09:26:28 -> 10:21:28 ->
 *    11:16:28 on 2026-10-19), with no "token refreshed" line in any CLI log.
 *    A new process therefore always sees 5..60 min of remaining lifetime.
 *  - Inside a running process the CLI refreshes only 5-50 s AFTER expiry
 *    ("browser.go: token refreshed"); a request sent in that gap gets 401 and
 *    the run ends (4 of 7 crossings). In all 4 failures the refreshed token had
 *    already been written to the keyring, so ONE fresh process succeeds.
 *
 * Consequences for the host:
 *  - A short token is not an error: wait for the rotation (bounded) instead of
 *    failing. Opening the app does not force a refresh.
 *  - A 401 is retried once with a fresh process after re-probing the token.
 */

const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const KEYRING_EXPIRY_PATTERN = /keyringAuth: loaded token, expiry=(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? ([+-]\d{2})(\d{2})\S* \S+ expired=(true|false)/;
const AUTH_ERROR_PATTERN = /\bUNAUTHENTICATED\b|\(code 401\)|\b401\b.*(?:auth|credential)|invalid authentication credentials|not logged into Antigravity/i;

/** Seconds before expiry at which the Antigravity app rotates the keyring token (observed). */
const APP_ROTATION_LEAD_SEC = 300;

function parseKeyringExpiry(logText = "") {
  let found = null;
  for (const line of String(logText || "").split(/\r?\n/)) {
    const match = line.match(KEYRING_EXPIRY_PATTERN);
    if (match) found = match;
  }
  if (!found) return null;
  const expiresAt = new Date(`${found[1]}T${found[2]}${found[3]}:${found[4]}`);
  if (Number.isNaN(expiresAt.getTime())) return null;
  return { expiresAt, expiredFlag: found[5] === "true" };
}

function defaultLogDir() {
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "log");
}

/** Reads the token expiry the AGY CLI logged after `startedAtMs` (warmup). */
async function readAntigravityTokenExpiry({ startedAtMs = 0, logDir = defaultLogDir() } = {}) {
  try {
    const entries = await fs.readdir(logDir);
    const candidates = [];
    for (const name of entries.filter((item) => /^cli-.*\.log$/.test(item))) {
      const stat = await fs.stat(path.join(logDir, name)).catch(() => null);
      if (stat && stat.mtimeMs >= startedAtMs - 2000) candidates.push({ name, mtimeMs: stat.mtimeMs });
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const candidate of candidates) {
      const parsed = parseKeyringExpiry(await fs.readFile(path.join(logDir, candidate.name), "utf8"));
      if (parsed) return { ...parsed, logFile: candidate.name };
    }
  } catch (_error) { /* no log dir */ }
  return null;
}

/**
 * Runs `agy models` (no model turn) so the CLI logs the keyring token expiry,
 * then reads it from the newest CLI log. Returns null when it cannot tell.
 */
async function probeAntigravityToken({ commandParts = ["agy"], env = process.env, spawnImpl = spawn, logDir = defaultLogDir(), warmupTimeoutMs = 8000 } = {}) {
  const startedAtMs = Date.now();
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      const warmup = spawnImpl(commandParts[0] || "agy", [...commandParts.slice(1), "models"], { windowsHide: true, env });
      warmup.on("close", finish);
      warmup.on("error", finish);
      setTimeout(() => { try { warmup.kill(); } catch (_) { /* gone */ } finish(); }, warmupTimeoutMs);
    } catch (_error) {
      finish();
    }
  });
  return readAntigravityTokenExpiry({ startedAtMs, logDir });
}

function isAntigravityAuthError(errorOrText) {
  const text = typeof errorOrText === "string"
    ? errorOrText
    : `${errorOrText?.message || ""} ${errorOrText?.stderr || ""} ${errorOrText?.stdout || ""}`;
  return errorOrText?.code === 401 || AUTH_ERROR_PATTERN.test(text);
}

function formatDuration(totalSec) {
  const sec = Math.max(0, Math.round(Number(totalSec) || 0));
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  if (!minutes) return `${seconds}s`;
  return seconds ? `${minutes} phút ${seconds}s` : `${minutes} phút`;
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Next probe delay. While the token is still valid and far from expiry, sleep
 * until just after the app's expected rotation (expiry - 300 s); otherwise poll.
 */
function nextDelaySec({ remainingSec, expired, pollSec }) {
  if (!expired && remainingSec > APP_ROTATION_LEAD_SEC + pollSec) {
    return Math.max(pollSec, remainingSec - APP_ROTATION_LEAD_SEC + 10);
  }
  return pollSec;
}

/**
 * Bounded wait until the keyring token outlives `requiredSec`.
 *
 * `probe({ fresh })` returns { expiresAt: Date, expiredFlag } or null. The
 * wait budget is counted from the requested sleeps (deterministic in tests).
 * Never throws for a short token: the caller decides from `status`:
 *   ok       token is long enough (rotated=true when it changed while waiting)
 *   unknown  the expiry could not be read
 *   short    still valid but shorter than required after the whole budget
 *   expired  expired / < 60 s after the whole budget
 *   cancelled
 */
async function waitForAntigravityToken({
  probe,
  requiredSec,
  maxWaitSec = 900,
  pollSec = 30,
  sleep = realSleep,
  isCancelled = () => false,
  onWait = null,
  now = Date.now,
  firstFresh = false
}) {
  const budgetSec = Math.max(0, Number(maxWaitSec) || 0);
  const pollEverySec = Math.max(1, Number(pollSec) || 30);
  let waitedSec = 0;
  let polls = 0;
  let initialExpiresAtMs = null;
  for (;;) {
    const result = await probe({ fresh: firstFresh || polls > 0 });
    const expiresAtMs = result?.expiresAt instanceof Date ? result.expiresAt.getTime() : null;
    if (expiresAtMs === null) return { status: "unknown", probe: result || null, waitedSec, polls };
    if (initialExpiresAtMs === null) initialExpiresAtMs = expiresAtMs;
    const remainingSec = Math.round((expiresAtMs - now()) / 1000);
    const expired = result.expiredFlag === true || remainingSec <= 0;
    const base = { probe: result, expiresAtMs, remainingSec, waitedSec, polls, rotated: expiresAtMs !== initialExpiresAtMs };
    if (!expired && remainingSec >= requiredSec) return { status: "ok", ...base };
    if (isCancelled()) return { status: "cancelled", ...base };
    const leftSec = budgetSec - waitedSec;
    if (leftSec <= 0 || polls >= 120) return { status: expired || remainingSec < 60 ? "expired" : "short", ...base };
    const delaySec = Math.min(leftSec, nextDelaySec({ remainingSec, expired, pollSec: pollEverySec }));
    onWait?.({ remainingSec, requiredSec, expired, delaySec, waitedSec, maxWaitSec: budgetSec, polls });
    await sleep(delaySec * 1000);
    if (isCancelled()) return { status: "cancelled", ...base };
    waitedSec += delaySec;
    polls += 1;
  }
}

module.exports = {
  APP_ROTATION_LEAD_SEC,
  parseKeyringExpiry,
  readAntigravityTokenExpiry,
  probeAntigravityToken,
  isAntigravityAuthError,
  waitForAntigravityToken,
  formatDuration
};
