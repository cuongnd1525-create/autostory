const { spawn } = require("child_process");
const { getCancelToken, throwIfCancelled, trackChild } = require("./cancelToken");

class WindowsVoiceService {
  runPowerShell(script) {
    return new Promise((resolve, reject) => {
      const token = getCancelToken();
      try {
        throwIfCancelled(token);
      } catch (error) {
        reject(error);
        return;
      }
      const child = spawn("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script
      ], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const untrackChild = trackChild(child, token);

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        untrackChild();
        reject(error);
      });
      child.on("close", (code) => {
        untrackChild();
        if (token?.cancelled) {
          reject(new Error(token.reason || "Đã dừng xuất video."));
          return;
        }
        if (code === 0) {
          resolve(stdout.trim());
          return;
        }
        reject(new Error(stderr || `Windows Local Free TTS failed with code ${code}`));
      });
    });
  }

  escapeSingleQuoted(text) {
    return String(text || "").replace(/'/g, "''");
  }

  async listVoices() {
    const script = [
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "Add-Type -AssemblyName System.Speech",
      "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      "$voices = $synth.GetInstalledVoices() | ForEach-Object {",
      "  $info = $_.VoiceInfo",
      "  [PSCustomObject]@{",
      "    voice_id = $info.Name",
      "    name = $info.Name",
      "    provider = 'windows_local'",
      "  }",
      "}",
      "$synth.Dispose()",
      "$voices | ConvertTo-Json -Depth 3"
    ].join("; ");

    const output = await this.runPowerShell(script);
    if (!output) {
      return [];
    }

    const payload = JSON.parse(output);
    return Array.isArray(payload) ? payload : [payload];
  }

  async synthesizeSpeech({ text, voiceName, outputPath, rate = 0 }) {
    const script = [
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "Add-Type -AssemblyName System.Speech",
      "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      voiceName ? `$synth.SelectVoice('${this.escapeSingleQuoted(voiceName)}')` : "",
      `$synth.Rate = ${Number(rate) || 0}`,
      `$synth.SetOutputToWaveFile('${this.escapeSingleQuoted(outputPath)}')`,
      `$synth.Speak('${this.escapeSingleQuoted(text)}')`,
      "$synth.Dispose()"
    ].filter(Boolean).join("; ");

    await this.runPowerShell(script);
    return outputPath;
  }
}

module.exports = WindowsVoiceService;
