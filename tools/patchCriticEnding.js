const fs = require('fs');
let code = fs.readFileSync('electron/services/structuralCriticService.js', 'utf8');

code = code.replace(/if \(postCliffhangerTailSec > 2\.0\) payoffObs -= 1\.0;\n  if \(postCliffhangerTailSec > 5\.0\) payoffObs -= 1\.5;/, 
`if (postCliffhangerTailSec > 2.0) payoffObs -= 1.0;
  if (postCliffhangerTailSec > 5.0) payoffObs -= 1.5;
  
  const lastWindow = scoredWindows[scoredWindows.length - 1];
  if (lastWindow && !lastWindow.isForwardConsequence) {
    payoffObs -= 2.0; // Penalty for backstory instead of forward consequence
  }`);

fs.writeFileSync('electron/services/structuralCriticService.js', code);
