function cleanList(items = []) {
  return [...new Set((Array.isArray(items) ? items : [items])
    .map((item) => String(item || "").trim())
    .filter(Boolean))];
}

function buildGeminiInputAccessGate({
  stage = "gemini_workflow",
  requiredInputs = [],
  allowProxyCoverage = true
} = {}) {
  const inputs = cleanList(requiredInputs);
  const inputLines = inputs.length
    ? inputs.map((item) => `- ${item}`).join("\n")
    : "- Every attachment and every structured input block named by this prompt.";
  return `STEP 0 - VERIFIED INPUT ACCESS GATE (SUPREME; RUN BEFORE EDITORIAL REASONING)

REQUIRED INPUTS FOR THIS STAGE:
${inputLines}

ACCESS PROCEDURE:
1. Inventory the files actually attached in this chat. A visible filename, thumbnail, citation token, prior-chat memory, or prompt description is NOT proof that its contents were opened.
2. Open and inspect every required input. Parse every required JSON/SRT/TXT file instead of relying on its filename or a truncated UI preview.
3. For video input, actually play/inspect every supplied proxy or proxy chunk. Verify first and last source timestamps and confirm that the chunks collectively cover the source range claimed by the manifest.${allowProxyCoverage ? " Complete proxy-chunk coverage is valid; direct access to the original full-resolution source is not required." : ""}
3A. For a rendered draft, coverageEndSec MUST equal the verified draft duration within 1.0 second. A draft entry with coverageStartSec=0 and coverageEndSec=0 is proof of NO review, not successful access.
3B. When a hook-audition clip is supplied, inspect it frame-by-frame and report the local trigger offset plus the corresponding source timestamp. Do not copy the containing scene start as the Hook in-point.
4. Cross-check source identity, duration, scene/timestamp ranges, transcript coverage, and IDs across the inputs. Never combine files from different source videos or projects.
5. Do not claim full multimodal access when only transcript/metadata was readable. Record the truthful accessMode.
6. Do not infer missing dialogue, visuals, actions, identities, chronology, evidence, or outcomes from titles, filenames, action scores, prior conversations, or general knowledge.

FAIL CLOSED - NEVER GUESS:
- If any required input is missing, unreadable, truncated, source-mismatched, or has an unexplained coverage gap, STOP. Do not create evidence, a blueprint, a script, or a review.
- Return exactly one Markdown json code block containing this object and no prose:
{
  "artifactType": "gemini_input_access_failure",
  "schemaVersion": 1,
  "stage": "${stage}",
  "accessGranted": false,
  "missingInputs": [],
  "unreadableInputs": [],
  "coverageGaps": [],
  "mismatchDetails": "",
  "recommendedAction": ""
}

SUCCESS AUDIT - REQUIRED IN EVERY SUCCESSFUL ROOT JSON OBJECT:
- Add inputAccessAudit at the root of every output object. For multiple scripts, repeat the same truthful audit in every file.
- inputAccessAudit must use this structure:
{
  "accessGranted": true,
  "stage": "${stage}",
  "accessMode": "full_multimodal | proxy_multimodal | candidate_reel | transcript_locked | structured_locked",
  "inspectedInputs": [{
    "name": "exact attached filename or inline block name",
    "role": "video | proxy | manifest | transcript | evidence | blueprint | draft | timing_report | other",
    "opened": true,
    "parsed": true,
    "coverageStartSec": 0,
    "coverageEndSec": 0
  }],
  "sourceIdentityMatched": true,
  "timelineCoverageVerified": true,
  "noGuessingConfirmed": true
}
- accessGranted=true is permitted only after all required inputs pass. Before returning, re-check that every factual claim and timestamp is supported by an inspected input.`;
}

module.exports = { buildGeminiInputAccessGate };
