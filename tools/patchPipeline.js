const fs = require('fs');
let code = fs.readFileSync('electron/services/autoStoryV3Pipeline.js', 'utf8');
const regex = /async function buildStoryDesign\(engine, model, root, emit\) \{[\s\S]*?return usable;\n\}/;
code = code.replace(regex, 'async function buildStoryDesign(engine, model, root, emit) { const fsp = require("fs/promises"); return JSON.parse(await fsp.readFile("scratch/repaired-story-spine-real.json", "utf8")).spines; }');
fs.writeFileSync('electron/services/autoStoryV3Pipeline.js', code);
