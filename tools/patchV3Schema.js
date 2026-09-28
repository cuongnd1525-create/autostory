const fs = require('fs');
let code = fs.readFileSync('electron/services/autoStoryV3Contracts.js', 'utf8');

code = code.replace(/cliffhangerSpecificFact: text,/, 
`cliffhangerSpecificFact: text,
  viewerBeliefBefore: text,
  viewerBeliefAfter: text,
  informationDelta: text,
  isForwardConsequence: boolean,
  newCaseState: text,
  expectedNextConsequence: text,
  whyCutHere: text,`);

fs.writeFileSync('electron/services/autoStoryV3Contracts.js', code);
