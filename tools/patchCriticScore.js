const fs = require('fs');
let code = fs.readFileSync('electron/services/structuralCriticService.js', 'utf8');

code = code.replace(/const scoredWindows = windows\.map\(w => \{[\s\S]*?w\.retentionScore = Math\.min\(10\.0, Math\.max\(0\.0, score\)\);[\s\S]*?return w;\n  \}\);/, 
`const scoredWindows = windows.map(w => {
    // Map to planned function
    const midPoint = (w.windowStart + w.windowEnd) / 2;
    const overlappingBeat = beatSpans.find(b => midPoint >= b.outputStartSec && midPoint <= b.outputEndSec) || beatSpans[beatSpans.length - 1];
    w.plannedFunction = overlappingBeat ? (overlappingBeat.narrativeRole || 'narrative_progression') : 'none';

    let score = 5.0; // Base score

    // Progress checks (Information vs Progress)
    const hasNewFact = w.newFact === true;
    const meaningfulProgress = hasNewFact || (
      w.viewerBeliefChange !== 'none' && w.viewerBeliefChange.length > 5 ||
      w.caseStateChange !== 'none' && w.caseStateChange.length > 5 ||
      w.stakesChange !== 'none' && w.stakesChange.length > 5 ||
      w.futureConsequenceChange !== 'none' && w.futureConsequenceChange.length > 5
    );

    if (meaningfulProgress) {
      score += 3.5;
    }

    const isZeroGain = w.observedNewInformation.match(/None|Nothing|Silence/i) || w.observedNewInformation.length < 5;
    if (isZeroGain && !meaningfulProgress) score -= 3.0;
    
    // Tension delta check
    if (/scream|hit|weapon|fight|gun|blood|arrest/i.test(w.observedDialogue + w.observedAction)) {
      score += 1.0;
    }
    
    // Detect semantic plateaus by checking if viewerBeliefChange is practically unchanged for multiple windows
    // (For simplicity we just use observedFunction here but penalize if no meaningful progress)
    w.observedFunction = deduceSemanticFunction(w.observedAction, w.observedDialogue);
    
    const wDur = w.windowEnd - w.windowStart;
    if (lastFunc === w.observedFunction && !meaningfulProgress) {
      currentRun += wDur;
    } else {
      currentRun = wDur;
    }
    lastFunc = w.observedFunction;
    if (currentRun > maxPlateau) maxPlateau = currentRun;
    w.semanticStateRunSec = currentRun;

    if (currentRun > 10.0) score -= 2.0;
    else if (currentRun > 8.0) score -= 1.0;

    w.retentionStatus = score >= 8.0 ? 'STRONG' : 'WEAK';
    if (w.retentionStatus === 'WEAK') weakWindows.push(w);
    
    w.retentionScore = Math.min(10.0, Math.max(0.0, score));
    return w;
  });`);

fs.writeFileSync('electron/services/structuralCriticService.js', code);
