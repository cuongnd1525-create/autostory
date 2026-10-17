"use strict";
const assert = require("node:assert/strict");
const { injectHookContractToPrompt } = require("../electron/services/hookContractService");
const base = "prompt_profile: viral_tiktok_crime_part1\nDIRECT HIGHLIGHT CONTENT RULES:\n";
const baseContract = {
  anchorRange:{startSec:120,endSec:128},
  trimmingTolerance:{startOffsetMaxSec:2,endOffsetMaxSec:3},
  title:"Police stop",archetype:"Action",hookId:"h1"
};
const automatic = injectHookContractToPrompt(base, {...baseContract,isUserLocked:false});
const manual = injectHookContractToPrompt(base, {...baseContract,isUserLocked:true});
assert.match(automatic,/AUTO-RANKED, NOT USER-LOCKED/);
assert.match(automatic,/may replace this auto-ranked anchor/);
assert.doesNotMatch(automatic,/USER-LOCKED ANCHORS/);
assert.match(manual,/USER-LOCKED ANCHORS/);
assert.match(manual,/MUST use the explicitly USER-LOCKED anchor/);
assert.match(automatic,/The Incident Begins/);
console.log("Auto Hook is provisional; explicitly user-locked Hook remains locked: PASS");
