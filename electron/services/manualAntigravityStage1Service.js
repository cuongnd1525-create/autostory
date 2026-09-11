const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const { buildCliEnv } = require("./cliEnv");
const { inspectGeminiJsonFiles } = require("./geminiJsonArtifactService");

const RESULT_DIR_NAME = "01-ANTIGRAVITY-RESULT";
const REQUIRED_SCRIPT_IDS = [1, 3, 4, 2, 5];

function getRequestedScriptIds(promptText = "") {
  const match = String(promptText).match(/INDEPENDENT_USER_OPTIONS_JSON_BEGIN\s*([\s\S]*?)\s*INDEPENDENT_USER_OPTIONS_JSON_END/i);
  let count = 3;
  try {
    count = Math.max(1, Math.min(5, Number(JSON.parse(match?.[1] || "{}").scriptCount) || 3));
  } catch (_error) {
    count = 3;
  }
  return REQUIRED_SCRIPT_IDS.slice(0, count);
}

function splitArgs(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  const matches = text.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  return matches.map((part) => part.replace(/^"|"$/g, ""));
}

function hasArg(args, ...names) {
  return args.some((arg) => names.includes(arg) || names.some((name) => arg.startsWith(`${name}=`)));
}

function buildOutputSchema(scriptIds = REQUIRED_SCRIPT_IDS) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["artifacts"],
    properties: {
      artifacts: {
        type: "array",
        minItems: 1,
        maxItems: scriptIds.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["filename", "script"],
          properties: {
            filename: {
              type: "string",
              enum: scriptIds.map((id) => `script-${id}.json`)
            },
            script: {
              type: "object",
              required: ["scriptId"],
              anyOf: [
                { required: ["segments"] },
                { required: ["narrativeBeats"] }
              ],
              properties: {
                scriptId: { type: "number", enum: scriptIds },
                segments: {
                  type: "array",
                  minItems: 1,
                  items: { type: "object" }
                },
                narrativeBeats: {
                  type: "array",
                  minItems: 1,
                  items: { type: "object" }
                }
              },
              additionalProperties: true
            }
          }
        }
      },
      notes: { type: "string" }
    }
  };
}

function parseJsonCandidate(value) {
  if (value && typeof value === "object") return value;
  const text = String(value || "").replace(/^\uFEFF/, "").trim();
  if (!text) return null;
  const candidates = [text];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1].trim());
  }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (_error) {
      // Try the next representation returned by the CLI.
    }
  }
  return null;
}

function findArtifactEnvelope(value, seen = new Set()) {
  const parsed = parseJsonCandidate(value);
  if (!parsed && typeof value === "string") {
    const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
    for (const line of lines) {
      const nested = findArtifactEnvelope(parseJsonCandidate(line), seen);
      if (nested) return nested;
    }
  }
  if (!parsed || typeof parsed !== "object" || seen.has(parsed)) return null;
  seen.add(parsed);
  if (Array.isArray(parsed.artifacts)) return parsed;
  if (Array.isArray(parsed.segments) || Array.isArray(parsed.narrativeBeats)) {
    return {
      artifacts: [{ filename: `script-${Number(parsed.scriptId || 0) || 1}.json`, script: parsed }]
    };
  }
  for (const key of ["result", "response", "output", "text", "content", "message", "data", "final"]) {
    if (parsed[key] == null) continue;
    const nested = findArtifactEnvelope(parsed[key], seen);
    if (nested) return nested;
  }
  for (const nestedValue of Object.values(parsed)) {
    if (!nestedValue || typeof nestedValue !== "object") continue;
    const nested = findArtifactEnvelope(nestedValue, seen);
    if (nested) return nested;
  }
  return null;
}

function normalizeArtifact(artifact) {
  const script = artifact?.script || artifact?.content || artifact?.json || artifact?.data || artifact;
  const scriptId = Number(script?.scriptId || script?.script_id || 0);
  if (!REQUIRED_SCRIPT_IDS.includes(scriptId)) {
    throw new Error(`Antigravity trả scriptId=${scriptId || "trống"}; chỉ chấp nhận 1, 3 hoặc 4.`);
  }
  const hasSegments = Array.isArray(script.segments) && script.segments.length > 0;
  const hasNarrativeBeats = Array.isArray(script.narrativeBeats) && script.narrativeBeats.length > 0;
  if (!hasSegments && !hasNarrativeBeats) {
    throw new Error(`Script ${scriptId} thiếu segments hoặc narrativeBeats có dữ liệu.`);
  }
  return {
    filename: `script-${scriptId}.json`,
    script: { ...script, scriptId }
  };
}

async function writeJsonAtomic(filePath, payload) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}

async function readPackageInfo(packageDir) {
  const infoPath = path.join(packageDir, "package-info.json");
  let info;
  try {
    info = JSON.parse(await fs.readFile(infoPath, "utf8"));
  } catch (error) {
    throw new Error(`Không đọc được package-info.json của GĐ1: ${error.message}`);
  }
  if (info.workflow !== "manual_gemini_draft_review") {
    throw new Error("Phân tích bằng Antigravity hiện chỉ áp dụng cho chế độ Viết kịch bản rồi review video thật.");
  }
  return info;
}

function buildAgentPrompt({ pass1Dir, promptPath, resultDir, scriptIds = [1, 3, 4] }) {
  return [
    "You are executing Stage 1 of RecapTool Studio's existing manual Gemini draft-review workflow.",
    "Work in READ-ONLY analysis mode. Do not edit, rename, delete, or create anything inside the Stage 1 input folder.",
    `STAGE_1_INPUT_FOLDER: ${pass1Dir}`,
    `EDITORIAL_PROMPT_FILE: ${promptPath}`,
    `RESULT_FOLDER_FOR_THE_HOST_APP: ${resultDir}`,
    "",
    "MANDATORY ACCESS METHOD:",
    "1. Read the complete editorial prompt file first.",
    "2. Inspect every relevant local input referenced by that prompt: scene-manifest, action candidates, complete transcript, proxy or all numbered proxy chunks in manifest order.",
    "3. Do not claim visual access unless you actually inspect the proxy video/chunks. Do not invent dialogue, actions, identities, motives, evidence, or timestamps.",
    "4. Follow every editorial, timing, narrator, hook, schema, and safety rule from the existing prompt.",
    `5. Generate exactly these requested independent scripts in order: ${scriptIds.join(", ")}. Each script must exactly follow the root schema in the editorial prompt (including narrativeBeats when the Story Spine schema is requested).`,
    "6. This is a one-turn headless execution. Do NOT stop after making an implementation plan, do NOT ask for approval, and do NOT return a plan file. Complete the analysis and return the final artifacts now.",
    "",
    "TRANSPORT OVERRIDE FOR THIS CLI RUN ONLY:",
    "The editorial prompt asks for three JSON code blocks/files. Do not emit Markdown code fences here. Return one structured envelope matching the host-provided JSON schema:",
    JSON.stringify({ artifacts: scriptIds.map((id) => ({ filename: `script-${id}.json`, script: { scriptId: id } })), notes: "" }),
    "The script objects themselves must exactly follow the root schema required by the editorial prompt. Do not return conversational prose."
  ].join("\n");
}

class ManualAntigravityStage1Service {
  constructor(settings = {}, dependencies = {}) {
    this.settings = settings;
    this.spawnImpl = dependencies.spawn || spawn;
    this.activeChild = null;
    this.cancelled = false;
  }

  buildCommand(prompt, schemaPath, pass1Dir) {
    const commandParts = splitArgs(this.settings.antigravityCommand || process.env.ANTIGRAVITY_COMMAND || "agy");
    const command = commandParts[0] || "agy";
    let args = [...commandParts.slice(1), ...splitArgs(this.settings.antigravityArgs || process.env.ANTIGRAVITY_ARGS || "")];
    const model = String(this.settings.antigravityModel || process.env.ANTIGRAVITY_MODEL || "").trim();
    if (model && !hasArg(args, "--model")) args.push("--model", model);
    const modeSafeArgs = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--mode") {
        index += 1;
        continue;
      }
      if (arg.startsWith("--mode=")) continue;
      modeSafeArgs.push(arg);
    }
    args = [...modeSafeArgs, "--mode", "accept-edits"];
    // Headless agy cannot display permission prompts. Stage 1 needs command
    // access to inspect local JSON/SRT and proxy media, otherwise the command
    // tool is auto-denied and the CLI returns an empty successful response.
    if (!hasArg(args, "--dangerously-skip-permissions")) args.push("--dangerously-skip-permissions");
    if (!hasArg(args, "--effort")) args.push("--effort", "high");
    if (!hasArg(args, "--output-format")) args.push("--output-format", "json");
    // agy 1.1.22 terminates before model execution when --json-schema is used,
    // even with a minimal valid schema. The host validates the envelope and
    // each script strictly after the CLI response, so structured transport is
    // enforced locally instead of relying on this unstable CLI feature.
    if (hasArg(args, "--json-schema")) {
      const cleaned = [];
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--json-schema") {
          index += 1;
          continue;
        }
        if (arg.startsWith("--json-schema=")) continue;
        cleaned.push(arg);
      }
      args = cleaned;
    }
    if (!args.includes(pass1Dir)) args.push("--add-dir", pass1Dir);
    const timeoutMs = Math.max(15000, Number(this.settings.antigravityTimeoutMs || 300000));
    if (!hasArg(args, "--print-timeout")) args.push("--print-timeout", `${Math.ceil(timeoutMs / 1000)}s`);
    const expandedArgs = args.map((arg) => arg.replaceAll("{prompt}", prompt));
    args = [];
    let promptAttached = false;
    for (let index = 0; index < expandedArgs.length; index += 1) {
      const arg = expandedArgs[index];
      if (arg === "--print" || arg === "--prompt" || arg === "-p") {
        promptAttached = true;
        args.push(`${arg}=${prompt}`);
        if (expandedArgs[index + 1] === prompt) index += 1;
        continue;
      }
      if (arg.startsWith("--print=") || arg.startsWith("--prompt=") || arg.startsWith("-p=")) {
        promptAttached = true;
      }
      args.push(arg);
    }
    if (!promptAttached) args.push(`--print=${prompt}`);
    return { command, args, timeoutMs };
  }

  runCli({ command, args, prompt, cwd, timeoutMs, onProgress }) {
    return new Promise((resolve, reject) => {
      const stdoutChunks = [];
      const stderrChunks = [];
      let settled = false;
      this.cancelled = false;
      const child = this.spawnImpl(command, args, {
        cwd,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: buildCliEnv()
      });
      this.activeChild = child;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeChild = null;
        callback();
      };
      const timer = setTimeout(() => {
        this.terminateActiveChild();
        finish(() => reject(new Error(`Antigravity timed out after ${Math.round(timeoutMs / 1000)}s.`)));
      }, timeoutMs);
      child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk) => {
        stderrChunks.push(chunk);
        const message = String(chunk || "").trim().split(/\r?\n/).filter(Boolean).at(-1);
        if (message) onProgress?.({ step: "antigravity_stage1", percent: 55, message: message.slice(0, 220) });
      });
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (code) => finish(() => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (this.cancelled) {
          reject(new Error("Đã dừng phân tích GĐ1 bằng Antigravity."));
          return;
        }
        if (code !== 0) {
          const error = new Error(`agy exited with code ${code}: ${stderr || stdout}`);
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      }));
      child.stdin.end();
    });
  }

  terminateActiveChild() {
    const child = this.activeChild;
    if (!child) return false;
    this.cancelled = true;
    if (process.platform === "win32" && child.pid) {
      try {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      } catch (_error) {
        child.kill("SIGKILL");
      }
    } else {
      child.kill("SIGKILL");
    }
    return true;
  }

  cancel() {
    return this.terminateActiveChild();
  }

  async run({ packageDir, onProgress } = {}) {
    const resolvedPackageDir = path.resolve(String(packageDir || ""));
    if (!packageDir) throw new Error("Hãy tạo gói phân tích GĐ1 trước khi chạy Antigravity.");
    const packageInfo = await readPackageInfo(resolvedPackageDir);
    const pass1Dir = path.resolve(packageInfo.pass1UploadDir || path.join(resolvedPackageDir, "01-GUI-GEMINI"));
    const expectedPass1 = path.join(resolvedPackageDir, "01-GUI-GEMINI");
    if (pass1Dir !== path.resolve(expectedPass1)) {
      throw new Error("package-info.json chứa đường dẫn GĐ1 không hợp lệ.");
    }
    const promptPath = path.resolve(packageInfo.promptPath || path.join(pass1Dir, "01-gemini-highlight-scripts-prompt.txt"));
    if (path.dirname(promptPath) !== pass1Dir) {
      throw new Error("Prompt GĐ1 phải nằm trực tiếp trong thư mục 01-GUI-GEMINI.");
    }
    await fs.access(promptPath);
    const promptText = await fs.readFile(promptPath, "utf8");
    const requestedScriptIds = getRequestedScriptIds(promptText);
    const resultDir = path.join(resolvedPackageDir, RESULT_DIR_NAME);
    await fs.mkdir(resultDir, { recursive: true });
    await Promise.all([
      ...REQUIRED_SCRIPT_IDS.map((scriptId) => fs.rm(path.join(resultDir, `script-${scriptId}.json`), { force: true })),
      fs.rm(path.join(resultDir, "antigravity-output.log"), { force: true }),
      fs.rm(path.join(resultDir, "antigravity-stderr.log"), { force: true })
    ]);
    const schemaPath = path.join(resultDir, "antigravity-output-schema.json");
    await writeJsonAtomic(schemaPath, buildOutputSchema(requestedScriptIds));
    const prompt = buildAgentPrompt({ pass1Dir, promptPath, resultDir, scriptIds: requestedScriptIds });
    const commandConfig = this.buildCommand(prompt, schemaPath, pass1Dir);

    onProgress?.({ step: "antigravity_stage1", percent: 8, message: "Đang mở gói GĐ1 ở chế độ chỉ đọc" });
    onProgress?.({ step: "antigravity_stage1", percent: 18, message: "Antigravity đang phân tích prompt, transcript, manifest và proxy" });
    let cliResult;
    try {
      cliResult = await this.runCli({
        ...commandConfig,
        prompt,
        cwd: resultDir,
        onProgress
      });
    } catch (error) {
      await Promise.all([
        fs.writeFile(path.join(resultDir, "antigravity-output.log"), error.stdout || "", "utf8"),
        fs.writeFile(path.join(resultDir, "antigravity-stderr.log"), error.stderr || error.message || "", "utf8")
      ]);
      throw error;
    }
    await fs.writeFile(path.join(resultDir, "antigravity-output.log"), cliResult.stdout || "", "utf8");
    if (cliResult.stderr) {
      await fs.writeFile(path.join(resultDir, "antigravity-stderr.log"), cliResult.stderr, "utf8");
    }
    onProgress?.({ step: "antigravity_stage1", percent: 82, message: "Đang tách và kiểm tra các JSON variant" });

    const envelope = findArtifactEnvelope(cliResult.stdout);
    if (!envelope?.artifacts?.length) {
      throw new Error(`Antigravity không trả về artifacts JSON hợp lệ. Xem log tại ${resultDir}.`);
    }
    const normalized = envelope.artifacts.map(normalizeArtifact);
    const deduplicated = new Map();
    for (const artifact of normalized) deduplicated.set(artifact.script.scriptId, artifact);
    const files = [];
    for (const scriptId of requestedScriptIds) {
      const artifact = deduplicated.get(scriptId);
      if (!artifact) continue;
      const filePath = path.join(resultDir, artifact.filename);
      await writeJsonAtomic(filePath, artifact.script);
      files.push(filePath);
    }
    const inspections = await inspectGeminiJsonFiles(files);
    const acceptedScriptTypes = new Set(["story_recut_script", "story_spine_edit_script"]);
    const validFiles = inspections
      .filter((item) => item.validJson && acceptedScriptTypes.has(item.type) && item.segmentCount > 0 && requestedScriptIds.includes(Number(item.scriptId)))
      .sort((left, right) => requestedScriptIds.indexOf(Number(left.scriptId)) - requestedScriptIds.indexOf(Number(right.scriptId)))
      .map((item) => item.filePath);
    const warnings = [];
    const missingIds = requestedScriptIds.filter((scriptId) => !inspections.some((item) => Number(item.scriptId) === scriptId));
    if (missingIds.length) warnings.push(`Antigravity chưa tạo Script ${missingIds.join(", ")}.`);
    for (const inspection of inspections.filter((item) => !item.validJson || !acceptedScriptTypes.has(item.type) || item.segmentCount < 1)) {
      warnings.push(`${path.basename(inspection.filePath)} không đạt schema variant: ${inspection.error || inspection.type}.`);
    }
    if (!validFiles.length) {
      throw new Error(`Không có JSON variant hợp lệ. Xem kết quả tại ${resultDir}.`);
    }
    await writeJsonAtomic(path.join(resultDir, "antigravity-run-info.json"), {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      provider: "antigravity_cli",
      packageDir: resolvedPackageDir,
      pass1Dir,
      promptPath,
      model: this.settings.antigravityModel || "",
      validFiles,
      warnings
    });
    onProgress?.({ step: "antigravity_stage1", percent: 100, message: `Đã tạo ${validFiles.length} JSON variant hợp lệ` });
    return { resultDir, files, validFiles, inspections, warnings };
  }
}

ManualAntigravityStage1Service.RESULT_DIR_NAME = RESULT_DIR_NAME;
ManualAntigravityStage1Service.findArtifactEnvelope = findArtifactEnvelope;
ManualAntigravityStage1Service.normalizeArtifact = normalizeArtifact;

module.exports = ManualAntigravityStage1Service;
