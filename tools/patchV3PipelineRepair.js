const fs = require('fs');
let code = fs.readFileSync('electron/services/autoStoryV3Pipeline.js', 'utf8');

code = code.replace(/async function buildStoryDesign\(engine, model, root, emit\) \{/, 
`async function buildStoryDesign(engine, model, root, emit, externalRepairInstruction = null) {`);

code = code.replace(/const runOnce = async \(customRepairInstruction\) => \{/,
`const runOnce = async (customRepairInstruction) => {
    customRepairInstruction = customRepairInstruction || externalRepairInstruction;`);

fs.writeFileSync('electron/services/autoStoryV3Pipeline.js', code);
