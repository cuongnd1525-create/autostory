const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const GeminiService = require('../electron/services/geminiService');

const VertexAiService = require('../electron/services/vertexAiService');

const apiKeyPath = 'C:\\Users\\Admin\\AppData\\Roaming\\cineviral-studio\\config.json';
const config = JSON.parse(fs.readFileSync(apiKeyPath, 'utf8'));
const ai = new VertexAiService(config);

const mp4Path = 'D:\\OutputVideo\\0925-v3-edl-quality-rebuild\\output\\highlight-cut-variant-01-score-na-final.mp4';
const spinePath = 'D:\\OutputVideo\\0925-v3-edl-quality-rebuild\\analysis\\auto-story-fast\\story-spine.json';

async function main() {
  const spineData = JSON.parse(fs.readFileSync(spinePath, 'utf8'));
  const spine = spineData.spines ? spineData.spines[0] : spineData;
  
  const probeOut = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', mp4Path], { encoding: 'utf8' });
  const actualMp4DurationSec = Number(JSON.parse(probeOut).format.duration);
  
  const targetWindowSec = 5.5;
  const numWindows = Math.max(1, Math.round(actualMp4DurationSec / targetWindowSec));
  const windowDuration = actualMp4DurationSec / numWindows;
  
  const windows = [];
  for (let w = 0; w < numWindows; w++) {
    windows.push({
      windowIndex: w + 1,
      startSec: Number((w * windowDuration).toFixed(2)),
      endSec: Number(((w + 1) === numWindows ? actualMp4DurationSec : (w + 1) * windowDuration).toFixed(2))
    });
  }
  
  const prompt = `
You are an expert movie structure critic.
Watch the uploaded video. It is EXACTLY ${actualMp4DurationSec.toFixed(2)} seconds long.
I have divided the video into ${numWindows} contiguous windows of ~${windowDuration.toFixed(2)} seconds.

For EVERY window, output:
- windowStart
- windowEnd
- observedAction (what is physically happening on screen)
- observedDialogue (transcribe or summarize key spoken words)
- observedNewInformation (what new fact does the viewer learn in this window?)
- observedViewerStateBefore (what did the viewer believe going into this window?)
- observedViewerStateAfter (what does the viewer believe leaving this window?)
- observedQuestion (what is the viewer wondering now?)
- observedPayoff (what tension was resolved?)
- observedCausalLink (how does this connect to the previous window?)
- observedFunction (narrative role: e.g. teaser_conflict, escalation, suspect_defense_excuse, physical_evidence_revelation, kinetic_pursuit_action, cliffhanger, etc.)
- whyWatchNext (why should they keep watching?)

Also output:
- mp4Duration: ${actualMp4DurationSec.toFixed(2)}
- lastWindowEnd: the end of the last window
- auditedSeconds: total seconds audited
- auditCoverageRatio: lastWindowEnd / mp4Duration (must be 1.0)

Output ONLY a JSON object:
{
  "mp4Duration": 64.97,
  "lastWindowEnd": 64.97,
  "auditedSeconds": 64.97,
  "auditCoverageRatio": 1.0,
  "windows": [
    {
      "windowIndex": 1,
      "windowStart": 0.0,
      "windowEnd": 5.41,
      "observedAction": "...",
      "observedDialogue": "...",
      "observedNewInformation": "...",
      "observedViewerStateBefore": "...",
      "observedViewerStateAfter": "...",
      "observedQuestion": "...",
      "observedPayoff": "...",
      "observedCausalLink": "...",
      "observedFunction": "...",
      "whyWatchNext": "..."
    }
  ]
}
`;

  console.log('Sending video to AI for media-grounded critique...');
  const result = await ai.generateJsonFromFiles({
    filePaths: [mp4Path],
    prompt: prompt,
    taskType: 'analysis',
    onProgress: (p) => console.log(p.message)
  });
  
  if (!fs.existsSync('scratch')) fs.mkdirSync('scratch');
  fs.writeFileSync('scratch/media-audit.json', JSON.stringify(result, null, 2));
  console.log('Done! Wrote to scratch/media-audit.json');
}

main().catch(console.error);
