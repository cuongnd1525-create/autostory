const fs = require("fs");
const path = require("path");

function localPythonCommand(fallback = "python") {
  const runtime = path.join(__dirname, "..", "..", ".venv-local", "Scripts", "python.exe");
  return fs.existsSync(runtime) ? runtime : fallback;
}

function pythonArgs(command, args) {
  return /^py(?:\.exe)?$/i.test(path.win32.basename(String(command || ""))) ? ["-3", ...args] : args;
}

function installHint(command, packages) {
  const escaped = String(command).replace(/'/g, "''");
  return `& '${escaped}' ${[...pythonArgs(command, []), "-m", "pip", "install", ...packages].map((arg) => /[<>\s]/.test(arg) ? `'${arg.replace(/'/g, "''")}'` : arg).join(" ")}`;
}

function runtimeError(error) {
  const message = String(error?.message || error || "").trim();
  const module = message.match(/No module named ['"]([^'"]+)['"]/i)?.[1];
  const kind = module ? "missing_module" : /timed out|timeout/i.test(message) ? "timeout"
    : /ENOENT|EACCES|EPERM|not recognized|not found/i.test(message) ? "launch_error" : "import_error";
  return { kind, module: module || null, message: message.split(/\r?\n/).filter(Boolean).slice(-1)[0] || message };
}

function runtimeFailureMessage(error, label, command, packages) {
  const detail = runtimeError(error);
  if (detail.kind === "timeout") return `${label}: kiểm tra Python vượt thời gian chờ; chưa thể kết luận thiếu gói. ${detail.message}`;
  if (detail.kind === "launch_error") return `${label}: không chạy được Python đã chọn (${command}). ${detail.message}`;
  if (detail.kind === "missing_module") return `${label}: Python đã chọn thiếu ${detail.module}. Cài bằng: ${installHint(command, packages)}`;
  return `${label}: lỗi import runtime Python. ${detail.message}`;
}

module.exports = { localPythonCommand, pythonArgs, installHint, runtimeError, runtimeFailureMessage };
