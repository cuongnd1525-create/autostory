const { critiqueMediaGroundedTimeline, formatRetentionAuditMarkdown } = require('../electron/services/structuralCriticService');
const VertexAiService = require('../electron/services/vertexAiService');
const fs = require('fs');
const { execFileSync } = require('child_process');

const apiKeyPath = 'C:\\Users\\Admin\\AppData\\Roaming\\cineviral-studio\\config.json';
const config = JSON.parse(fs.readFileSync(apiKeyPath, 'utf8'));
const ai = new VertexAiService(config);

const spinePath = 'D:\\OutputVideo\\0925-v3-edl-quality-rebuild\\analysis\\auto-story-fast\\story-spine.json';
const mp4Path = 'D:\\Video\\0925-v3-edl-quality-rebuild-highlight-variant-01-score-na-a-routine-domestic-c-20260928065330.mp4';

async function main() {
  const spineData = JSON.parse(fs.readFileSync(spinePath, 'utf8'));
  const spine = spineData.spines ? spineData.spines[0] : spineData;
  
  const probeOut = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', mp4Path], { encoding: 'utf8' });
  const actualMp4DurationSec = Number(JSON.parse(probeOut).format.duration);
  
  console.log(`Running Final Media Critic on Repaired MP4 (${actualMp4DurationSec.toFixed(2)}s)...`);
  
  const result = await critiqueMediaGroundedTimeline(spine, {
    aiService: ai,
    mp4Path,
    actualMp4DurationSec,
    targetWindowSec: 5.5
  });
  
  console.log('Result Status:', result.status);
  console.log('Observed Score:', result.criticObservedScore);
  console.log('Compliance:', result.isCompliant ? 'PASS' : 'FAIL');
  
  const md = formatRetentionAuditMarkdown(result);
  fs.writeFileSync('C:\\Users\\Admin\\.gemini\\antigravity\\brain\\a7f556ed-0358-438d-9ff8-590936478f20\\final_audit.md', md);
  console.log('Wrote final_audit.md!');
}

main().catch(console.error);
