"use strict";

/**
 * Owns the local gemini-web-bridge.exe (a patched fork of
 * github.com/ntthanh2603/gemini-web-to-api, MIT; see tools/gemini-web-bridge).
 *
 * Security model:
 *  - the Google cookie is stored encrypted (Electron safeStorage) and only ever
 *    handed to the child through its environment, never written to disk/logs;
 *  - the child listens on 127.0.0.1 on a random port and rejects every request
 *    without a per-launch random token (upstream listened on all interfaces
 *    with CORS "*", i.e. any web page could drive the signed-in account).
 *
 * One bridge per app; it is started lazily and stopped when the app quits.
 */

const fs = require("fs");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const STATUS_PATH = "/bridge/v1/status";

/**
 * Newest gemini-web-bridge*.exe in tools/gemini-web-bridge/bin: a running
 * bridge locks its exe on Windows, so updates ship as gemini-web-bridge-N.exe.
 */
function defaultBinaryPath() {
  const dir = path.join(__dirname, "..", "..", "tools", "gemini-web-bridge", "bin").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
  const ext = process.platform === "win32" ? ".exe" : "";
  let best = path.join(dir, `gemini-web-bridge${ext}`);
  let bestTime = -1;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith("gemini-web-bridge") || (ext && !name.toLowerCase().endsWith(ext))) continue;
      const time = fs.statSync(path.join(dir, name)).mtimeMs;
      if (time > bestTime) { bestTime = time; best = path.join(dir, name); }
    }
  } catch (_) { /* bin folder missing: report the default path */ }
  return best;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Keep only the cookies the bridge needs; validate the two it requires. */
function normalizeCookieHeader(raw) {
  let text = String(raw || "").trim();
  text = text.replace(/^cookie:\s*/i, "").replace(/[\r\n]+/g, " ").trim();
  const pairs = text.split(";").map((pair) => pair.trim()).filter((pair) => pair.includes("="));
  const names = new Set(pairs.map((pair) => pair.slice(0, pair.indexOf("=")).trim()));
  const missing = ["__Secure-1PSID", "__Secure-1PSIDTS"].filter((name) => !names.has(name));
  if (missing.length) {
    throw Object.assign(new Error(`Cookie thiếu ${missing.join(" và ")}. Hãy copy cả header Cookie của request gemini.google.com (DevTools > Network).`), { code: "cookie_invalid" });
  }
  return pairs.join("; ");
}

class GeminiWebBridgeProcess {
  constructor({ getSettings, decryptCookies, logDir, workDir, spawnImpl = spawn, fetchImpl = (...args) => require("./geminiWebTransport").localFetch(...args) } = {}) {
    this.getSettings = getSettings || (() => ({}));
    this.decryptCookies = decryptCookies || (() => "");
    this.logDir = logDir;
    this.workDir = workDir;
    this.spawnImpl = spawnImpl;
    this.fetchImpl = fetchImpl;
    this.child = null;
    this.endpoint = null;
    this.token = null;
    this.signature = "";
    this.starting = null;
  }

  binaryPath(settings = this.getSettings()) {
    return String(settings.geminiWebBridgePath || "").trim() || defaultBinaryPath();
  }

  /** Changing cookie / account slot restarts the bridge. */
  launchSignature(settings, cookies) {
    return crypto.createHash("sha256").update(JSON.stringify([cookies, settings.geminiWebAuthUser || "", this.binaryPath(settings)])).digest("hex");
  }

  async ensureStarted({ timeoutMs = 90000, onProgress } = {}) {
    const settings = this.getSettings();
    const cookies = normalizeCookieHeader(await this.decryptCookies(settings));
    const signature = this.launchSignature(settings, cookies);
    if (this.child && this.signature === signature && this.endpoint) {
      const status = await this.status().catch(() => null);
      if (status?.healthy) return { endpoint: this.endpoint, token: this.token, status };
    }
    if (this.starting) return this.starting;
    this.starting = this.start({ settings, cookies, signature, timeoutMs, onProgress }).finally(() => { this.starting = null; });
    return this.starting;
  }

  async start({ settings, cookies, signature, timeoutMs, onProgress }) {
    await this.stop();
    const binary = this.binaryPath(settings);
    if (!fs.existsSync(binary)) throw Object.assign(new Error(`Không tìm thấy ${binary}.`), { code: "bridge_missing" });
    const port = await freePort();
    const token = crypto.randomBytes(24).toString("hex");
    if (this.workDir) fs.mkdirSync(this.workDir, { recursive: true });
    let logStream = null;
    if (this.logDir) {
      fs.mkdirSync(this.logDir, { recursive: true });
      logStream = fs.createWriteStream(path.join(this.logDir, "gemini-web-bridge.log"), { flags: "a" });
      logStream.write(`\n=== ${new Date().toISOString()} start port ${port} ===\n`);
    }
    const env = {
      ...process.env,
      GEMINI_COOKIES: cookies,
      GEMINI_AUTH_USER: String(settings.geminiWebAuthUser ?? "").trim(),
      GEMINI_REFRESH_INTERVAL: "1440",
      GEMINI_MAX_RETRIES: "2",
      GEMINI_GENERATE_TIMEOUT_SEC: String(Math.max(120, Number(settings.geminiWebGenerateTimeoutSec) || 900)),
      HOST: "127.0.0.1",
      PORT: String(port),
      BRIDGE_TOKEN: token,
      BODY_LIMIT_MB: "32",
      LOG_LEVEL: "info"
    };
    const child = this.spawnImpl(binary, [], { cwd: this.workDir || path.dirname(binary), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    this.endpoint = `http://127.0.0.1:${port}`;
    this.token = token;
    this.signature = signature;
    const redact = (chunk) => String(chunk).split(cookies).join("<cookies>");
    child.stdout?.on("data", (chunk) => logStream?.write(redact(chunk)));
    child.stderr?.on("data", (chunk) => logStream?.write(redact(chunk)));
    child.on("exit", (code) => {
      logStream?.write(`=== exit ${code} ===\n`);
      logStream?.end();
      if (this.child === child) { this.child = null; this.endpoint = null; }
    });
    onProgress?.("[GEMINI_WEB] Đang khởi động bridge cục bộ và đăng nhập Gemini Web bằng cookie...");
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      if (!this.child) throw Object.assign(new Error("Bridge Gemini Web thoát ngay khi khởi động. Xem logs/gemini-web-bridge.log."), { code: "bridge_exited" });
      last = await this.status().catch(() => null);
      if (last?.healthy && Array.isArray(last.models) && last.models.length) return { endpoint: this.endpoint, token, status: last };
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await this.stop();
    throw Object.assign(new Error("Gemini Web không đăng nhập được bằng cookie đã lưu (cookie hết hạn, sai slot /u/N/, hoặc Google chặn). Lấy lại cookie trong Cài đặt rồi thử lại."), { code: "auth_expired" });
  }

  async status() {
    if (!this.endpoint) return null;
    const response = await this.fetchImpl(`${this.endpoint}${STATUS_PATH}`, { headers: { Authorization: `Bearer ${this.token}` }, timeoutMs: 5000 });
    if (!response.ok) throw new Error(`bridge status HTTP ${response.status}`);
    return response.json();
  }

  async stop() {
    const child = this.child;
    this.child = null;
    this.endpoint = null;
    if (!child) return;
    try {
      if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      else child.kill("SIGTERM");
    } catch (_) { /* already gone */ }
  }
}

GeminiWebBridgeProcess.normalizeCookieHeader = normalizeCookieHeader;
GeminiWebBridgeProcess.defaultBinaryPath = defaultBinaryPath;
module.exports = GeminiWebBridgeProcess;
