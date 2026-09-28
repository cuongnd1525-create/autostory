const fs = require('fs');
let code = fs.readFileSync('electron/services/autoStoryV3Contracts.js', 'utf8');

code = code.replace(/6\. EVIDENCE & ESCALATION LADDER:\n([\s\S]*?)7\. ORIGINAL AUDIO AS EVIDENCE:/, 
`6. EVIDENCE & ESCALATION LADDER (SEMANTIC COMPRESSION):
   - Progress from suspicion/claim -> contradiction -> witness -> physical marks/evidence -> admission -> consequence.
   - Do NOT present the strongest evidence too early unless intentionally borrowed for the teaser.
   - SEMANTIC COMPRESSION: NEVER string together consecutive beats repeating the same defense/excuses/viewer belief.
   - For every beat, output: viewerBeliefBefore, viewerBeliefAfter, informationDelta.
   - If multiple candidate beats result in substantially the same viewerBeliefAfter, KEEP ONLY THE STRONGEST 4-6 second MOMENT and CUT THE REST.
   - Do not spend >8-10 seconds proving the same story state.
   - Max run in any single visual scene is 12.0s! Alternate perspectives between suspect, officer physical action, evidence inspection, and victim testimony.

7. ORIGINAL AUDIO AS EVIDENCE:`);

code = code.replace(/8\. ENDING \/ CLIFFHANGER LOGIC:\n([\s\S]*?)- The final beat MUST have:/,
`8. ENDING / CLIFFHANGER LOGIC (FORWARD CONSEQUENCE):
   - Choose between PAYOFF ENDING and OPEN CONSEQUENCE CLIFFHANGER based on the archetype.
   - The final beat MUST move the story FORWARD. A late witness statement that merely explains past events is BACKSTORY. Do not label backstory as a cliffhanger.
   - FORWARD CONSEQUENCE REVEAL: A specific new fact that materially changes what is likely to happen next, making a consequence feel imminent.
   - Examples: victim reveals unknown assault, officer discovers weapon, suspect makes incriminating admission, officer announces detention.
   - Do NOT end merely on a statement that reconstructs the past. Move such context earlier.
   - For serialized Part 1, the FINAL BEAT MUST be a strong forward consequence cliffhanger: SPECIFIC NEW FACT -> IMPORTANT CONSEQUENCE IS NOW LIKELY -> CONSEQUENCE NOT SHOWN YET.
   - The final beat MUST have:
     * isForwardConsequence: boolean (true if it moves the present story forward)
     * newCaseState: how the case changed right now
     * expectedNextConsequence: what will likely happen
     * whyCutHere: justification for ending exactly here
     - Plus the existing cliffhanger fields:`);

fs.writeFileSync('electron/services/autoStoryV3Contracts.js', code);
