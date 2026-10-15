const assert = require("node:assert/strict");
const test = require("node:test");
const Runtime = require("../electron/services/pythonRuntimeService");
const SubtitleService = require("../electron/services/subtitleService");

test("launcher and explicit Python paths use the correct arguments", () => {
  assert.deepEqual(Runtime.pythonArgs("py", ["worker.py"]), ["-3", "worker.py"]);
  assert.deepEqual(Runtime.pythonArgs("C:\\Windows\\py.exe", ["worker.py"]), ["-3", "worker.py"]);
  assert.deepEqual(Runtime.pythonArgs("C:\\runtime\\python.exe", ["worker.py"]), ["worker.py"]);
  assert.match(Runtime.installHint("C:\\My Runtime\\python.exe", ["transformers<5"]), /& 'C:\\My Runtime\\python.exe'.*'transformers<5'/);
});

test("diagnostics retain the actual failing module instead of the first traceback line", () => {
  const missing = new Error("Traceback (most recent call last):\n  File worker.py\nModuleNotFoundError: No module named 'numpy'");
  assert.equal(Runtime.runtimeError(missing).kind, "missing_module");
  assert.match(Runtime.runtimeFailureMessage(missing, "Kokoro", "py", ["numpy"]), /thiếu numpy.*-3 -m pip install numpy/);
  assert.equal(Runtime.runtimeError(new Error("worker timed out")).kind, "timeout");
  assert.doesNotMatch(Runtime.runtimeFailureMessage(new Error("worker timed out"), "ASR", "py", ["faster-whisper"]), /Cài bằng/);
  assert.equal(Runtime.runtimeError(new Error("spawn python ENOENT")).kind, "launch_error");
  assert.equal(Runtime.runtimeError(new Error("ImportError: DLL load failed")).kind, "import_error");
});

test("ASR cold starts get enough time and timeout is distinguished from a missing package", async () => {
  let limit;
  const service = new SubtitleService({ whisperEngine: "faster-whisper" }, { runCommand: async (_command, _args, timeout) => { limit = timeout; return { stdout: "ok" }; } });
  service.detectNvidiaVramMb = async () => 0;
  assert.equal((await service.detectRuntime()).fasterWhisperAvailable, true);
  assert.ok(limit >= 60000);
  service.runtimeCommand = async () => { throw new Error("py timed out"); };
  assert.equal((await service.detectRuntime()).runtimeError.kind, "timeout");
  service.runtimeCommand = async () => { throw new Error("ModuleNotFoundError: No module named 'faster_whisper'"); };
  assert.equal((await service.detectRuntime()).runtimeError.kind, "missing_module");
});

test("automatic ASR falls back to CPU when NVIDIA exists but CUDA DLLs do not", { skip: process.platform !== "win32" }, async () => {
  const service = new SubtitleService({ whisperEngine: "auto", whisperDevice: "auto" }, {
    runCommand: async (_command, args) => {
      if (args.some((arg) => arg.includes("WinDLL"))) throw new Error("FileNotFoundError: cublas64_12.dll unavailable");
      return { stdout: "ok" };
    }
  });
  service.detectNvidiaVramMb = async () => 12288;
  const profile = await service.detectRuntime({ language: "en" });
  assert.equal(profile.fasterWhisperAvailable, true);
  assert.equal(profile.cudaRuntimeAvailable, false);
  assert.equal(profile.device, "cpu");
  assert.equal(profile.computeType, "int8");
  assert.match(profile.reason, /CPU vì CUDA/);
  service.whisperDevice = "cuda";
  const explicit = await service.detectRuntime({ language: "en" });
  assert.equal(explicit.device, "cuda");
  await assert.rejects(service.transcribeWithFasterWhisper({ profile: explicit }), /thiếu CUDA runtime/);
});
