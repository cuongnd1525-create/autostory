const fs = require('fs');
let code = fs.readFileSync('electron/services/structuralCriticService.js', 'utf8');

const regexPrompt = /const prompt = `[\s\S]*?`\;/;
const newPrompt = `const prompt = \`
You are an expert true-crime structural critic.
Watch the uploaded video. It is EXACTLY \${actualMp4DurationSec.toFixed(2)} seconds long.
I have divided the video into \${numWindows} contiguous windows of ~\${windowDuration.toFixed(2)} seconds.

For EVERY window, output:
- windowStart and windowEnd
- observedAction (what is physically happening on screen)
- observedDialogue (transcribe or summarize key spoken words)
- observedNewInformation (what facts are revealed here)
- newFact (is there a literal new fact?)
- viewerBeliefChange (did viewer understanding materially change?)
- caseStateChange (did evidence or police posture change?)
- stakesChange (did danger or consequence severity change?)
- futureConsequenceChange (is a consequence now imminent?)
- isForwardConsequence (for the final cliffhanger windows, does this beat move the story FORWARD or is it just BACKSTORY?)

CRITICAL INSTRUCTION ON PROGRESS:
A window can contain NEW WORDS without meaningful STORY PROGRESS. Do not award a full retention pulse merely because dialogue is different. Strong progress requires material change in understanding, evidence, stakes, or consequences.

CRITICAL INSTRUCTION ON ENDINGS:
The final beat must move the story FORWARD. A late witness statement that merely explains what happened before police arrived is BACKSTORY. Forward consequence reveal changes what is likely to happen next (e.g. officer discovers weapon, announces charge).

Score each window 1-10 for pacing and structural tension. Penalize semantic plateaus where no material progress occurs.\`;`;

const regexSchema = /const windowSchema = \{[\s\S]*?\}\;\n      \}\n    \}\n  \};/;
const newSchema = `const windowSchema = {
    type: 'object',
    required: ['windows'],
    properties: {
      windows: {
        type: 'array',
        items: {
          type: 'object',
          required: ['windowStart', 'windowEnd', 'observedAction', 'observedDialogue', 'observedNewInformation', 'newFact', 'viewerBeliefChange', 'caseStateChange', 'stakesChange', 'futureConsequenceChange', 'isForwardConsequence', 'score_1_to_10'],
          properties: {
            windowStart: { type: 'number' },
            windowEnd: { type: 'number' },
            observedAction: { type: 'string' },
            observedDialogue: { type: 'string' },
            observedNewInformation: { type: 'string' },
            newFact: { type: 'boolean' },
            viewerBeliefChange: { type: 'string' },
            caseStateChange: { type: 'string' },
            stakesChange: { type: 'string' },
            futureConsequenceChange: { type: 'string' },
            isForwardConsequence: { type: 'boolean' },
            score_1_to_10: { type: 'number' }
          }
        }
      }
    }
  };`;

code = code.replace(regexPrompt, newPrompt);
code = code.replace(regexSchema, newSchema);
fs.writeFileSync('electron/services/structuralCriticService.js', code);
