const fs = require("fs/promises");
const path = require("path");
const { spawnSync } = require("child_process");
const { buildCliEnv } = require("../electron/services/cliEnv");

const target = "C:\\Users\\p\\OneDrive\\Documents\\MovieRecapToolWorkspace\\exports\\The_whole_Springfield_is_devastated_by_radiation__The_Simpsons___qU0igjkyETs_-recap-final.mp4";
const folder = path.resolve(__dirname, "../.tmp/recap-audio-audit");
async function main() {
  await fs.mkdir(folder, { recursive: true });
  const settings = JSON.parse(await fs.readFile(path.join(process.env.APPDATA, "cineviral-studio/config.json"), "utf8"));
  const env = buildCliEnv();
  const probe = (file) => {
    const result = spawnSync(settings.ffprobePath || "ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=index,codec_type,codec_name,sample_rate,channels,duration,start_time", "-of", "json", file], { encoding: "utf8", env, windowsHide: true });
    if (result.error || result.status !== 0) throw result.error || new Error(result.stderr);
    return JSON.parse(result.stdout);
  };
  console.log("Output probe:", JSON.stringify(probe(target)));
  console.log("Selected voice:", JSON.stringify({ provider: settings.defaultVoiceProvider, voice: settings.defaultVoiceId, workspaceRoot: settings.workspaceRoot }));
  const projects = [];
  for (const entry of await fs.readdir(settings.workspaceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectPath = path.join(settings.workspaceRoot, entry.name, "project.json");
    try {
      const project = JSON.parse(await fs.readFile(projectPath, "utf8"));
      if (project.finalVideoPath === target || String(project.title).includes("Springfield")) projects.push({ projectPath, project });
    } catch (_) {}
  }
  console.log("Matching projects:", projects.map(({ projectPath, project }) => ({ projectPath, id: project.id, voiceProvider: project.voiceProvider, voiceId: project.voiceId, finalVideoPath: project.finalVideoPath })));
  for (const item of projects) {
    try {
      const statePath = path.join(path.dirname(item.projectPath), "analysis/recap_state.json");
      const state = JSON.parse(await fs.readFile(statePath, "utf8"));
      console.log("State:", statePath, "units:", state.speechUnits?.length, "metrics:", state.syncMetrics);
      const decisions = state.decisions || [];
      console.log("Decisions:", decisions.map((d) => ({ id: d.speech_unit_id, tempo: d.voice_tempo, duration: d.audio_duration, clips: d.clips?.length, start: d.clips?.[0]?.output_start, lead: d.clips?.[0]?.lead_ms, text: d.text, audio: d.audio_path })));
      console.log("First voice files:", await Promise.all(decisions.slice(0, 3).map(async (d) => ({ file: d.audio_path, probe: probe(d.audio_path) }))));
      await fs.writeFile(path.join(folder, `${item.project.id}-manifest.json`), JSON.stringify({ target, project: item.project, state, settings: { ffmpegPath: settings.ffmpegPath, ffprobePath: settings.ffprobePath } }, null, 2));
    } catch (error) { console.error(error.message); }
  }
  const result = spawnSync(settings.ffmpegPath || "ffmpeg", ["-y", "-v", "error", "-i", target, "-t", "30", "-vn", "-ac", "1", "-ar", "24000", path.join(folder, "output-first30.wav")], { encoding: "utf8", env, windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr);
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
