function buildVariantHookEntry(variantData = {}, fallbackCandidate = {}) {
  const c = variantData?.candidate || fallbackCandidate || {};
  const startSec = Number(variantData?.userAnchorRange?.startSec ?? c.sourceStartSec ?? 0);
  const endSec = Number(variantData?.userAnchorRange?.endSec ?? c.sourceEndSec ?? (startSec + 10));
  const tol = variantData?.trimmingTolerance || { startOffsetMaxSec: 2.0, endOffsetMaxSec: 3.0 };
  return {
    scriptId: Number(variantData?.scriptId) || 1,
    variantName: variantData?.variantName || "Variant",
    storyAngle: String(variantData?.storyAngle || ""),
    hookId: c.hookId || c.candidateId || "hook_01",
    title: c.title || c.coreEventDescription || "Selected Hook Event",
    archetype: c.archetype || "Physical Friction / Barricade Suspense",
    anchorRange: {
      startSec: Number(startSec.toFixed(3)),
      endSec: Number(endSec.toFixed(3)),
      durationSec: Number((endSec - startSec).toFixed(3))
    },
    trimmingTolerance: {
      startOffsetMaxSec: Math.max(0, Math.min(5, Number(tol.startOffsetMaxSec) || 2.0)),
      endOffsetMaxSec: Math.max(0, Math.min(6, Number(tol.endOffsetMaxSec) || 3.0))
    },
    coreEventDescription: c.coreEventDescription || "",
    keyDialogue: c.keyDialogue || "",
    scores: c.scores || {}
  };
}

function buildHookContract({
  candidate = {},
  userAnchorRange = null,
  trimmingTolerance = { startOffsetMaxSec: 2.0, endOffsetMaxSec: 3.0 },
  storyFormat = "non_linear_rewind",
  isUserLocked = true,
  isMultiVariant = false,
  hasDuplicates = false,
  variants = null
} = {}) {
  // Multi-variant mode
  if (isMultiVariant || (variants && typeof variants === "object")) {
    const v1 = buildVariantHookEntry(variants?.variant_01, candidate);
    const v2 = buildVariantHookEntry(variants?.variant_02, candidate);
    const v3 = buildVariantHookEntry(variants?.variant_03, candidate);

    const dup = Boolean(
      hasDuplicates ||
      (v1.hookId && v2.hookId && v1.hookId === v2.hookId) ||
      (v1.hookId && v3.hookId && v1.hookId === v3.hookId) ||
      (v2.hookId && v3.hookId && v2.hookId === v3.hookId) ||
      (Math.abs(v1.anchorRange.startSec - v2.anchorRange.startSec) < 0.5) ||
      (Math.abs(v1.anchorRange.startSec - v3.anchorRange.startSec) < 0.5) ||
      (Math.abs(v2.anchorRange.startSec - v3.anchorRange.startSec) < 0.5)
    );

    return {
      contractVersion: 2,
      isUserLocked: Boolean(isUserLocked),
      isMultiVariant: true,
      hasDuplicates: dup,
      variants: {
        variant_01: v1,
        variant_02: v2,
        variant_03: v3
      },
      // Backward compatibility fields referencing variant_01
      hookId: v1.hookId,
      title: v1.title,
      archetype: v1.archetype,
      anchorRange: v1.anchorRange,
      trimmingTolerance: v1.trimmingTolerance,
      coreEventDescription: v1.coreEventDescription,
      keyDialogue: v1.keyDialogue,
      scores: v1.scores,
      storyDirectives: {
        format: storyFormat,
        hookRole: "Must be the opening beat (Beat 1). Hook the friction or question, never spoil the outcome.",
        rewindRole: "Beat 2 rewinds to origin of incident ('Fifteen minutes earlier...') to establish peaceful context before escalation.",
        progressionRole: "Beats 3-4 build tension progressively back towards the Hook event.",
        payoffRole: "Beat 5 resolves the confrontation and ends with verified aftermath/charges."
      }
    };
  }

  // Single candidate mode (legacy / fallback)
  const startSec = Number(userAnchorRange?.startSec ?? candidate.sourceStartSec ?? 0);
  const endSec = Number(userAnchorRange?.endSec ?? candidate.sourceEndSec ?? (startSec + 10));

  return {
    contractVersion: 1,
    isUserLocked: Boolean(isUserLocked),
    isMultiVariant: false,
    hasDuplicates: false,
    hookId: candidate.hookId || candidate.candidateId || "hook_01",
    title: candidate.title || "Selected Hook Event",
    archetype: candidate.archetype || "Physical Friction / Barricade Suspense",
    anchorRange: {
      startSec: Number(startSec.toFixed(3)),
      endSec: Number(endSec.toFixed(3)),
      durationSec: Number((endSec - startSec).toFixed(3))
    },
    trimmingTolerance: {
      startOffsetMaxSec: Math.max(0, Math.min(5, Number(trimmingTolerance?.startOffsetMaxSec) || 2.0)),
      endOffsetMaxSec: Math.max(0, Math.min(6, Number(trimmingTolerance?.endOffsetMaxSec) || 3.0))
    },
    coreEventDescription: candidate.coreEventDescription || "High stakes confrontation",
    keyDialogue: candidate.keyDialogue || "",
    scores: candidate.scores || {},
    storyDirectives: {
      format: storyFormat,
      hookRole: "Must be the opening beat (Beat 1). Hook the friction or question, never spoil the outcome.",
      rewindRole: "Beat 2 rewinds to origin of incident ('Fifteen minutes earlier...') to establish peaceful context before escalation.",
      progressionRole: "Beats 3-4 build tension progressively back towards the Hook event.",
      payoffRole: "Beat 5 resolves the confrontation and ends with verified aftermath/charges."
    }
  };
}

function validateHookContract(contract = {}, videoDurationSec = 0) {
  const errors = [];
  if (!contract || typeof contract !== "object") {
    return { valid: false, errors: ["Hook contract must be an object."] };
  }
  
  if (contract.isMultiVariant && contract.variants) {
    for (const [key, v] of Object.entries(contract.variants)) {
      const range = v?.anchorRange;
      if (!range || !Number.isFinite(range.startSec) || !Number.isFinite(range.endSec)) {
        errors.push(`Invalid anchorRange for ${key}: startSec and endSec must be numbers.`);
      } else if (range.startSec < 0) {
        errors.push(`anchorRange.startSec for ${key} cannot be negative.`);
      } else if (range.endSec <= range.startSec) {
        errors.push(`anchorRange.endSec for ${key} must be greater than startSec.`);
      } else if (videoDurationSec > 0 && range.endSec > videoDurationSec + 1.0) {
        errors.push(`anchorRange.endSec for ${key} (${range.endSec}s) exceeds video duration (${videoDurationSec}s).`);
      }
    }
    return { valid: errors.length === 0, errors };
  }

  const range = contract.anchorRange;
  if (!range || !Number.isFinite(range.startSec) || !Number.isFinite(range.endSec)) {
    errors.push("Invalid anchorRange: startSec and endSec must be numbers.");
  } else if (range.startSec < 0) {
    errors.push("anchorRange.startSec cannot be negative.");
  } else if (range.endSec <= range.startSec) {
    errors.push("anchorRange.endSec must be greater than startSec.");
  } else if (videoDurationSec > 0 && range.endSec > videoDurationSec + 1.0) {
    errors.push(`anchorRange.endSec (${range.endSec}s) exceeds video duration (${videoDurationSec}s).`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

const SERIES_PROMPT_PROFILE_PATTERN = /prompt_profile:\s*viral_tiktok_crime_part1\b/i;

function isSeriesHookContract(text = "", contract = {}) {
  if (SERIES_PROMPT_PROFILE_PATTERN.test(String(text || ""))) return true;
  const variants = contract?.variants ? Object.values(contract.variants) : [];
  return variants.some((variant) => /^part_\d/i.test(String(variant?.storyAngle || "")));
}

function describeAnchor(entry = {}, label = "") {
  const range = entry.anchorRange || {};
  const tol = entry.trimmingTolerance || { startOffsetMaxSec: 2.0, endOffsetMaxSec: 3.0 };
  const start = Number(range.startSec || 0);
  const end = Number(range.endSec || start);
  return [
    `${label}: "${entry.title || entry.coreEventDescription || "Selected Hook"}" (${entry.archetype || "Action"})`,
    `   - Source Time Range: ${start.toFixed(3)}s - ${end.toFixed(3)}s (~${(end - start).toFixed(1)}s)`,
    entry.keyDialogue ? `   - Key Dialogue / Quote: "${entry.keyDialogue}"` : "",
    `   - Editorial Trimming Tolerance: start up to ${Number(tol.startOffsetMaxSec || 0).toFixed(1)}s earlier, end up to ${Number(tol.endOffsetMaxSec || 0).toFixed(1)}s later.`
  ].filter(Boolean).join("\n");
}

// Series profiles (Part 1/2/3 of ONE story) must never receive the legacy
// "3 different stories" differentiation matrix: that matrix makes the Parts
// diverge into three unrelated edits.
function buildSeriesHookContractBlock(contract = {}) {
  const isMulti = Boolean(contract?.isMultiVariant && contract?.variants);
  const v1 = isMulti ? contract.variants.variant_01 : contract;
  const v2 = isMulti ? contract.variants.variant_02 : null;
  const v3 = isMulti ? contract.variants.variant_03 : null;
  const sameStart = (a, b) => a && b && Math.abs(Number(a.anchorRange?.startSec) - Number(b.anchorRange?.startSec)) < 0.5;
  const autoRecommended = contract.isUserLocked === false;
  const lines = [
    "================================================================================",
    autoRecommended
      ? "SERIES HOOK CONTRACT (AUTO-RECOMMENDED ANCHOR; SUBJECT TO STORY-FIRST REVIEW)"
      : "SERIES HOOK CONTRACT (USER-LOCKED ANCHORS FOR ONE 3-PART STORY)",
    "================================================================================",
    "Script 1, Script 3 and Script 4 are PART 1, PART 2 and PART 3 of ONE continuous story with ONE central viewer question. They are chapters, not alternative edits. Never invent three different angles of the same events.",
    "",
    describeAnchor(v1 || {}, "PART 1 (Script 1) cold-open hook anchor"),
    autoRecommended
      ? "   - Provisional: compare this hook against verified source events and the complete story. Series Plan may replace it when another REAL sourced hook gives better clarity, cause-and-effect handoff, and payoff."
      : "   - Mandate: Script 1 Beat 1 MUST open with this anchor."
  ];
  if (v2 && !sameStart(v2, v1)) {
    lines.push("", describeAnchor(v2, "PART 2 (Script 3) opener anchor"), "   - Use it as Part 2 Beat 1 only if it belongs to Part 2's scope and spoils nothing owned by Part 3.");
  }
  if (v3 && !sameStart(v3, v1) && !sameStart(v3, v2)) {
    lines.push("", describeAnchor(v3, "PART 3 (Script 4) opener anchor"), "   - Use it as Part 3 Beat 1 only if it belongs to Part 3's scope.");
  }
  lines.push(
    "",
    "SERIES RULES:",
    "- PART 1 = The Confrontation, PART 2 = The Interrogation, PART 3 = The Verdict & Arrest, in source chronology.",
    "- Each Part opens on its own strongest verified moment inside its own scope. Never reuse PART 1's hook footage as another Part's opener (a recap of at most 3s is allowed).",
    "- Spoiler boundary: PART 1 and PART 2 must not show or narrate the arrest, charges, verdict or final consequence. Only PART 3 delivers the payoff.",
    "- PART 1 and PART 2 end on verified unresolved cliffhangers that lead into the next Part.",
    "- When a locked series-plan.json is supplied, it is binding for hook, scope, scene allocation and cliffhangers.",
    "- An auto-selected hook is only a candidate; do NOT force it when SOURCE_UNDERSTANDING proves a better hook-to-payoff story. User-locked hooks are never overridden.",
    "================================================================================"
  );
  return lines.join("\n");
}

function injectHookContractToPrompt(basePrompt = "", contract = {}) {
  const text = String(basePrompt || "");
  const isMulti = Boolean(contract?.isMultiVariant && contract?.variants);
  const range = contract?.anchorRange;
  const tol = contract?.trimmingTolerance || { startOffsetMaxSec: 2.0, endOffsetMaxSec: 3.0 };
  if (isSeriesHookContract(text, contract) && (isMulti || range)) {
    const seriesBlock = buildSeriesHookContractBlock(contract);
    if (text.includes("DIRECT HIGHLIGHT CONTENT RULES:")) {
      return text.replace("DIRECT HIGHLIGHT CONTENT RULES:", `DIRECT HIGHLIGHT CONTENT RULES:\n\n${seriesBlock}\n`);
    }
    return `${seriesBlock}\n\n${text}`;
  }

  const differentiationMatrix = `
================================================================================
3-VARIANT NARRATIVE DIFFERENTIATION MATRIX (HIGHEST PRIORITY)
================================================================================
Each of the 3 scripts (Script 1, Script 3, Script 4) MUST pursue a distinct viral storytelling angle and opening hook. DO NOT create duplicate or similar narrative structures across the 3 scripts.

- SCRIPT 1 (VARIANT 1) — PURE HIGH-OCTANE THRILLER (ACCELERATION & CHASE):
  * Beat 1 (Hook): Maximum kinetic action, high-speed pursuit, or sudden dramatic escape. Ban casual tire-changing or mundane dialogue.
  * Body: Fast-paced escalation with live radio chatter, rising speed alerts, and physical road hazards.
  * Outro: Culminates directly in the crash and tactical takedown. Target duration: 60-75s.

- SCRIPT 3 (VARIANT 2) — NON-LINEAR IN MEDIAS RES (DECEPTION TO CATASTROPHE):
  * Beat 1 (Hook): The peak physical hazard or visual shock (e.g., bare rim grinding sparks at 96 mph, near rollover).
  * Beat 2 (Context/Rewind): Rewind to the routine origin ("Ten minutes earlier...") showing the deception or routine encounter.
  * Beats 3-4 (Escalation): Sudden revelation of warrants / betrayal, accelerating into high-speed chaos.
  * Beat 5 (Payoff): Resolves back at the crash scene and apprehension. Target duration: 80-95s.

- SCRIPT 4 (VARIANT 3) — TACTICAL STAND-OFF & RESCUE (INTENSE CLIMAX FIRST):
  * Beat 1 (Hook): High-friction tactical confrontation at the wreckage (baton shattering glass, commands, struggle over endangered passenger/pet).
  * Body: Immediate high-stakes physical standoff, overcoming resistance, securing the scene.
  * STRICT RETENTION RULE: Hard cut within 3 seconds of suspect being cuffed and scene secured.
    STRICT PROHIBITION: NEVER pad the ending with civilian chit-chat, vehicle towing logistics, or post-incident administrative dialogue. Zero dead-air aftermath! Target duration: 60-70s.
================================================================================
`.trim();

  let contractBlock = "";

  if (isMulti) {
    const v1 = contract.variants.variant_01;
    const v2 = contract.variants.variant_02;
    const v3 = contract.variants.variant_03;

    let duplicateWarningSection = "";
    if (contract.hasDuplicates) {
      duplicateWarningSection = `
================================================================================
CRITICAL MANDATE: DUPLICATE HOOK DIVERGENCE PROTOCOL (ZERO OVERLAP RULE)
================================================================================
ATTENTION: Two or more scripts share the SAME opening hook anchor event!
Gemini MUST write COMPLETELY DIFFERENT scripts for each variant to ensure zero redundancy:

1. DIVERGENT STORYTELLING ANGLES & LENSES:
   - SCRIPT 1 (VARIANT 01): High-Octane Action & Chase Thriller. Focus on vehicular speed, chase radio alerts, road hazard physics, and pursuit tension. Punchy, breathless pacing.
   - SCRIPT 3 (VARIANT 02): Psychological Crime & Deception Breakdown (JCS / EWU Formula). Open with the shock event, then rewind to the routine traffic stop / encounter ("Ten minutes earlier..."). Dissect suspect lies, body language, and police suspicions.
   - SCRIPT 4 (VARIANT 03): Climax-First Tactical Stand-off & Forced Breach. Focus heavily on officer tactical positioning, window-break commands, physical extraction, and immediate aftermath. Hard cut within 3 seconds of cuffs.

2. ABSOLUTE DIVERGENCE RULES:
   - ZERO DUPLICATE VOICEOVER LINES: Every single voiceover sentence in each script must be 100% unique. No copied or slightly paraphrased narration sentences between scripts.
   - DISTINCT INTERMEDIATE EVIDENCE SELECTION: When cutting from the hook to the rest of the story, each script MUST select different evidence scenes and alternate camera angles where available.
   - DISTINCT PACING & DURATION: Do not mirror segment durations or narration timestamps across variants.
================================================================================
`.trim() + "\n\n";
    }

    contractBlock = `
================================================================================
HOOK CONTRACT (USER-LOCKED EDITORIAL ANCHORS FOR ALL 3 VARIANTS)
================================================================================
The user has locked designated opening hooks for each of the 3 scripts:

1. SCRIPT 1 (VARIANT 01) — Hook Anchor:
   - Event: "${v1.title || 'Selected Hook'}" (${v1.archetype || 'Action'})
   - Source Time Range: ${v1.anchorRange.startSec.toFixed(3)}s - ${v1.anchorRange.endSec.toFixed(3)}s (~${v1.anchorRange.durationSec.toFixed(1)}s)
   ${v1.keyDialogue ? `- Key Dialogue / Quote: "${v1.keyDialogue}"` : ""}
   - Editorial Trimming Tolerance: Start up to ${v1.trimmingTolerance.startOffsetMaxSec.toFixed(1)}s earlier, end up to ${v1.trimmingTolerance.endOffsetMaxSec.toFixed(1)}s later.
   - Mandate: Script 1 Beat 1 MUST open with this anchor event.

2. SCRIPT 3 (VARIANT 02) — Hook Anchor:
   - Event: "${v2.title || 'Selected Hook'}" (${v2.archetype || 'Deception'})
   - Source Time Range: ${v2.anchorRange.startSec.toFixed(3)}s - ${v2.anchorRange.endSec.toFixed(3)}s (~${v2.anchorRange.durationSec.toFixed(1)}s)
   ${v2.keyDialogue ? `- Key Dialogue / Quote: "${v2.keyDialogue}"` : ""}
   - Editorial Trimming Tolerance: Start up to ${v2.trimmingTolerance.startOffsetMaxSec.toFixed(1)}s earlier, end up to ${v2.trimmingTolerance.endOffsetMaxSec.toFixed(1)}s later.
   - Mandate: Script 3 Beat 1 MUST open with this anchor event.

3. SCRIPT 4 (VARIANT 03) — Hook Anchor:
   - Event: "${v3.title || 'Selected Hook'}" (${v3.archetype || 'Tactical'})
   - Source Time Range: ${v3.anchorRange.startSec.toFixed(3)}s - ${v3.anchorRange.endSec.toFixed(3)}s (~${v3.anchorRange.durationSec.toFixed(1)}s)
   ${v3.keyDialogue ? `- Key Dialogue / Quote: "${v3.keyDialogue}"` : ""}
   - Editorial Trimming Tolerance: Start up to ${v3.trimmingTolerance.startOffsetMaxSec.toFixed(1)}s earlier, end up to ${v3.trimmingTolerance.endOffsetMaxSec.toFixed(1)}s later.
   - Mandate: Script 4 Beat 1 MUST open with this anchor event.
================================================================================

${duplicateWarningSection}${differentiationMatrix}
`.trim();

  } else if (range) {
    contractBlock = `
================================================================================
HOOK CONTRACT (USER-LOCKED EDITORIAL ANCHOR)
================================================================================
Anchor Event: "${contract.title || contract.coreEventDescription || 'Selected Hook'}"
Archetype: ${contract.archetype || 'Physical Friction / Barricade Suspense'}
Anchor Source Range: ${range.startSec.toFixed(3)}s - ${range.endSec.toFixed(3)}s (~${range.durationSec.toFixed(1)}s)
${contract.keyDialogue ? `Key Dialogue / Quote: "${contract.keyDialogue}"` : ""}
Core Event Description: ${contract.coreEventDescription || ""}

VIRAL NON-LINEAR STORYTELLING STRUCTURE:
- BEAT 1 (HOOK): 0–10s immediately kicks off with this physical friction / shocking discovery anchor.
- BEAT 2 (REWIND / CONTEXT): Rewind 10–15 minutes earlier ("Ten minutes earlier...") to establish the routine origin before escalation.
- BEATS 3-4 (ESCALATION): Tension builds progressively back towards the Hook event.
- BEAT 5 (PAYOFF): Decisive confrontation, takedown, and verified legal aftermath.

EDITORIAL TRIMMING RULES FOR THIS HOOK:
- SCRIPT 1 MUST use this event as its opening hook (Beat 1).
- EDITORIAL TRIMMING TOLERANCE: You are the editor. You MAY:
  * Trim dead air inside the selected range.
  * Start up to ${tol.startOffsetMaxSec.toFixed(1)}s earlier if needed to catch the start of speech or motion.
  * End up to ${tol.endOffsetMaxSec.toFixed(1)}s later if needed for speech/action completeness.
  * Use the punchiest subsection of this event.
- DO NOT replace Script 1's hook with an arbitrary establishing shot or routine dialogue.
================================================================================

${differentiationMatrix}
`.trim();
  } else {
    contractBlock = differentiationMatrix;
  }

  // If prompt has VIRAL EDITORIAL RULES or DIRECT HIGHLIGHT CONTENT RULES, inject right after
  if (text.includes("DIRECT HIGHLIGHT CONTENT RULES:")) {
    return text.replace(
      "DIRECT HIGHLIGHT CONTENT RULES:",
      `DIRECT HIGHLIGHT CONTENT RULES:\n\n${contractBlock}\n`
    );
  }

  return `${contractBlock}\n\n${text}`;
}

module.exports = {
  buildHookContract,
  validateHookContract,
  injectHookContractToPrompt
};
