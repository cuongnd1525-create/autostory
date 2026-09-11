const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

function candidateCommands() {
  return [
    process.env.OLLAMA_COMMAND,
    process.env.CINEVIRAL_OLLAMA_COMMAND,
    "ollama",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe") : "",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Ollama", "ollama.exe") : "",
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Ollama", "ollama.exe") : "",
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Ollama", "ollama.exe") : ""
  ].filter(Boolean);
}

function commandExists(command) {
  if (command === "ollama") return true;
  try {
    return fs.existsSync(command);
  } catch (_error) {
    return false;
  }
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(String(stdout || ""));
    });
  });
}

function pullWithCommand(command, modelName, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["pull", modelName], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const append = (chunk) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-12000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Tải Hy-MT2 timed out."));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ model: modelName, command, detail: output.trim() });
      else reject(new Error(output.trim() || `ollama pull exited with code ${code}`));
    });
  });
}

async function runOllama(args, timeoutMs = 12000) {
  const errors = [];
  for (const command of candidateCommands()) {
    if (!commandExists(command)) continue;
    try {
      return {
        command,
        stdout: await runCommand(command, args, timeoutMs)
      };
    } catch (error) {
      errors.push(`${command}: ${error.message}`);
      if (!/ENOENT/i.test(error.message)) {
        break;
      }
    }
  }
  throw new Error(
    "Không tìm thấy Ollama CLI. Hãy cài Ollama hoặc đặt biến môi trường OLLAMA_COMMAND/CINEVIRAL_OLLAMA_COMMAND trỏ tới ollama.exe. " +
    (errors.length ? `Chi tiết: ${errors.join(" | ")}` : "")
  );
}

function parseList(output) {
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const dataLines = lines.slice(1);
  return dataLines.map((line) => {
    const match = line.match(/^(\S+)\s+(\S+)\s+(\d+(?:\.\d+)?\s+\S+)\s+(.+)$/);
    if (!match) {
      const [name] = line.split(/\s+/);
      return { name, id: "", size: "", modified: "" };
    }
    return {
      name: match[1],
      id: match[2],
      size: match[3].trim(),
      modified: match[4].trim()
    };
  }).filter((model) => model.name);
}

function parseShow(output) {
  const text = String(output || "");
  const info = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = trimmed.match(/^([A-Za-z][A-Za-z _-]+)\s+(.+)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase().replace(/\s+/g, "_");
    info[key] = match[2].trim();
  }
  return {
    family: info.family || info.families || "",
    parameterSize: info.parameter_size || "",
    quantization: info.quantization_level || "",
    contextLength: info.context_length || "",
    embeddingLength: info.embedding_length || "",
    license: info.license || "",
    raw: text.slice(0, 4000)
  };
}

class OllamaService {
  async listModels() {
    const result = await runOllama(["list"]);
    const models = parseList(result.stdout);
    return { models, command: result.command };
  }

  async getModelInfo(modelName) {
    if (!modelName) {
      return { name: "", details: {} };
    }
    const result = await runOllama(["show", modelName], 15000);
    return {
      name: modelName,
      command: result.command,
      details: parseShow(result.stdout)
    };
  }

  async pullModel(modelName, timeoutMs = 60 * 60 * 1000) {
    if (!modelName) throw new Error("Thiếu tên model Ollama cần tải.");
    const errors = [];
    for (const command of candidateCommands()) {
      if (!commandExists(command)) continue;
      try {
        return await pullWithCommand(command, modelName, timeoutMs);
      } catch (error) {
        errors.push(`${command}: ${error.message}`);
        if (!/ENOENT/i.test(error.message)) break;
      }
    }
    throw new Error(`Không tải được Hy-MT2 bằng Ollama. ${errors.join(" | ")}`);
  }
}

module.exports = OllamaService;
