const fs = require('fs');
const path = require('path');
const VertexAiService = require('../electron/services/vertexAiService');
const { generateTargetedRepairSpecification } = require('../electron/services/structuralCriticService');

const apiKeyPath = 'C:\\Users\\Admin\\AppData\\Roaming\\cineviral-studio\\config.json';
const config = JSON.parse(fs.readFileSync(apiKeyPath, 'utf8'));
const ai = new VertexAiService(config);

const spinePath = 'D:\\OutputVideo\\0925-v3-edl-quality-rebuild\\analysis\\auto-story-fast\\story-spine.json';
const auditPath = 'scratch/media-audit.json';

async function main() {
  const spineData = JSON.parse(fs.readFileSync(spinePath, 'utf8'));
  const spine = spineData.spines ? spineData.spines[0] : spineData;
  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  
  // Create a mock result object to generate the repair spec
  const mockResult = {
    mp4Duration: audit.mp4Duration,
    postCliffhangerTailSec: 0,
    weakWindows: [
      {
        windowStart: 48.69,
        windowEnd: 54.1,
        outputTimeFormatted: '48.7s - 54.1s',
        retentionScore: 5.5,
        observedAction: 'The daughter continues to speak, looking distressed.',
        observedNewInformation: 'None'
      }
    ]
  };

  const repairSpec = generateTargetedRepairSpecification(mockResult, spine);

  const prompt = `
You are the Gemini Editorial Director.
We ran the Media-Grounded Critic against the actual rendered MP4 of your EDL.
The critic found a structural violation:

Repair Specification:
${JSON.stringify(repairSpec, null, 2)}

Your task:
Perform ONE targeted EDL repair to fix this pacing plateau.
You may:
- REMOVE or SHORTEN the static dialogue beat to eliminate the plateau.
- REPLACE the beat with a different, more active beat from the source video (if you know one).
- ADD a minimal bridge.

Current Story Spine:
${JSON.stringify(spine.beats, null, 2)}

Return the COMPLETE Repaired Story Spine JSON containing the updated array of beats.
Output ONLY a JSON object:
{
  "beats": [ ... ]
}
`;

  console.log('Sending real repair prompt to AI...');
  const result = await ai.generateJsonFromFiles({ filePaths: [], prompt, taskType: 'repair' });
  
  if (!fs.existsSync('scratch')) fs.mkdirSync('scratch');
  spine.beats = result.beats || result;
  spineData.spines = [spine];
  fs.writeFileSync('scratch/repaired-story-spine-real.json', JSON.stringify(spineData, null, 2));
  console.log('Done! Wrote to scratch/repaired-story-spine-real.json');
}

main().catch(console.error);
