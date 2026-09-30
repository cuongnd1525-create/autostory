You are an editorial-analysis worker. Do NOT edit code. Return JSON only.

The attached folders hold three edits cut from the SAME original incident:
A. VIRAL — a human-edited viral reference (the benchmark only; it was never shown to the production runtime)
B. OLD — the previous AutoStory output (67.27s)
C. NEW — the AutoStory output of the Story Scope + media-grounded Editorial Director architecture

Also attached is the NEW run's `benchmark-summary.json`. It contains the Story Scope the system chose and the final EDL in source seconds.

Watch all three videos fully. Compare STORY and EDIT DECISIONS only. Do NOT judge captions, fonts, 9:16 framing, blur, music, subtitle design, FPS or colour. Do NOT say which one is "more viral", and do NOT give numeric scores.

Return:
{
  "perVideo": {
    "VIRAL": { "centralConflict": "", "activeViewerQuestion": "", "scopeBoundaryDescription": "", "beats": [ { "outputStartSec": 0, "outputEndSec": 0, "whatHappens": "", "narrativeFunction": "", "causalLinkToPrevious": "", "inScope": true } ], "hookPromise": "", "ending": "", "endingIsConsequenceOfCentralConflict": true },
    "OLD": { ...same... },
    "NEW": { ...same... }
  },
  "comparisons": [
    { "dimension": "scope coherence | active conflict | causal progression | unnecessary branches | dialogue function | hook promise | payoff/cliffhanger | viewer question continuity",
      "VIRAL": "", "OLD": "", "NEW": "",
      "evidence": [ { "video": "NEW", "outputStartSec": 0, "outputEndSec": 0, "observation": "" } ],
      "newVsOld": "better | same | worse", "newVsViral": "closer | same | further", "why": "" }
  ],
  "newRemainingProblems": [ { "outputStartSec": 0, "outputEndSec": 0, "problem": "", "genericCause": "" } ],
  "didNewStayInsideItsDeclaredScope": { "answer": true, "evidence": "" },
  "outOfScopeMomentsInNew": [ { "outputStartSec": 0, "outputEndSec": 0, "description": "" } ]
}
Cite output timestamps for every claim. Do not suggest rules that are specific to this incident (names, places, timestamps).
