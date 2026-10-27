"use strict";

/**
 * Editorial rules for serialized true-crime Parts, written from the Gemini
 * frame-by-frame review of drafts B/C vs a viral TikTok reference (Ticket 112).
 * Shared by the manual chat prompts (serializedGeminiWorkflowService) and the
 * automated Vertex session (vertexSeriesStage1Service), which also appends
 * them to packages generated before these rules existed.
 */

const PART_MARKER = "EDITORIAL QUALITY RULES v2";
const BLUEPRINT_MARKER = "BLUEPRINT EDITORIAL RULES v2";

function partRules() {
  return [
    `${PART_MARKER} (learned from a review of rendered drafts vs a viral reference; follow them strictly):`,
    "1. AUDIO OWNERSHIP: Never put voiceover over source dialogue, shouting, radio calls, banter/punchlines or any shot with burned-in dialogue captions. VO beds must be non-dialogue footage only (driving, walking, establishing, B-roll). Emotional peaks (panic, fear, jokes/banter, threats, commands) always play as original_audio.",
    "2. VO BED AMBIENCE: For every VO segment whose bed has no speech and no burned-in dialogue captions, use audio_mode=\"voiceover_with_ambient\" with clean_ambient_verified=true so sirens/engine stay audible under the narrator (~-16 dB). Use voiceover_only only when the bed contains any speech or an external source narrator.",
    "3. VO LENGTH: Each VO bridge (consecutive VO segments = one block) is 3-7s and <= 18 words, and never more words than 2.5 x its bed seconds. Do not narrate what the viewer already sees (crash, bailout, takedown) - let the original audio carry physical climaxes; at most a <= 3s setup before them.",
    "4. VO <-> PICTURE: When VO names a physical event or on-screen graphic (spike strips, crash, K9, arrest, an on-screen arrow/label), the VO bed or the immediately following clip MUST show that exact event. Never cut away right before the promised visual.",
    "5. WHO IS SPEAKING ABOUT WHOM: Before using a discovery/identity line ('we got eyes on him', 'located', 'that's him'), read +/-15s of transcript and watch the shot to confirm who it refers to (suspect vs a deputy/officer). Never re-label a scene to fit the story.",
    "6. CHRONOLOGY: After the Hook, keep segments in increasing source time (sourceStartSec ascending), VO beds included. Only the opening Hook may be a flash-forward.",
    "7. HOOK (first 0-2.5s): open on a shout, siren, bark, command or visible close-range action with the subject identifiable (face/handcuffs/K9). Never open on an empty road, a stationary conversational chat, or silence; cut leading silence and keep <= 0.3s after the Hook's last word.",
    "8. CUT POINTS: original_audio starts 0.15-0.25s before the first syllable and ends 0.15-0.3s after the last word of a complete sentence. Never cut inside a word or sentence; never leave a < 1s flash of the next/previous camera angle at a hard cut.",
    "9. DEAD AIR: No original_audio stretch longer than ~4s without speech unless it shows decisive new action (impact, struggle, escape). Trim repetitive driving/engine drone or use it as a short VO bed.",
    "10. ENDING: Parts 1/2 end on a 2-3s original-audio spike (bark, warning shout, radio call) or one specific unresolved question - never generic filler ('they are not playing around', 'things are about to get crazy'). Part 3 ends on the verified consequence; put epilogue VO over clean footage, not over the source narrator's burned-in caption slides.",
    "11. PART BANNER: Set part_top_banner_text to a 4-9 word banner for THIS Part's own visual payoff (e.g. chase vs K9 manhunt vs arrest), different for each Part; keep shared_top_banner_text unchanged.",
    "12. For every VO segment also add bed_check: {\"has_dialogue\": false, \"has_burned_in_dialogue_captions\": false, \"shows\": \"what the bed visibly shows\"} after you verify the frames."
  ].join("\n");
}

function blueprintRules() {
  return [
    `${BLUEPRINT_MARKER}:`,
    "- HOOK AUDITION (your editorial judgement, per Part): before fixing parts[].hook, watch at least 3 different opening moments inside that Part's own story scope and add parts[].hookAudition = {\"candidates\":[{\"sourceStartSec\":0,\"sourceEndSec\":0,\"first3sSeen\":\"what a scrolling viewer SEES in the first 3s\",\"first3sHeard\":\"what they HEAR (shout/siren/bark/quiet talk/silence)\",\"coldViewerUnderstands\":\"can someone who missed earlier Parts tell who is doing what?\",\"viewerQuestion\":\"the question it makes them ask\",\"spoilsOutcome\":false}],\"chosenIndex\":0,\"why\":\"why this one beats the others for a TikTok scroller\"}. parts[].hook must be the chosen candidate.",
    "- Every hookProof/sourceProof quote must be spoken (or the action visible) INSIDE that exact source range; check the transcript around it and who the line is about (+/-15s). A misplaced quote makes the Script open on the wrong moment.",
    "- Each Part Hook range starts on high-arousal audio/visual action (shout, siren, bark, command, physical struggle) with the subject identifiable - not a calm conversation or an empty road.",
    "- Plan chapterBeats in chronological source order inside each Part and include the visible payoff of any event the story mentions (e.g. the moment spikes are hit, the moment the suspect is found).",
    "- Add part_top_banner_text to each parts[] entry: a distinct 4-9 word banner for that Part's own payoff (shared_top_banner_text stays the common series title)."
  ].join("\n");
}

function blueprintCriticPrompt() {
  return [
    "EDITOR REVIEW of the series-blueprint.json you just wrote. Do NOT rewrite it in this turn.",
    "Re-watch each Part's Hook range and every chapterBeat range, then list only REAL, specific problems:",
    "- HOOK_WEAK: a Part's first 3s would not stop a TikTok scroller (empty road, calm talk, silence, subject not identifiable) while a stronger moment exists in that Part's scope.",
    "- PROOF_MISPLACED: a hookProof/sourceProof quote or action is not actually said/visible inside its range (give where it really is).",
    "- WRONG_REFERENT: a line is used as being about the suspect/someone but in context (+/-15s) refers to another person.",
    "- MISSING_PAYOFF: an event the plan relies on (spike strips hit, suspect found, arrest) is not inside any beat range of its Part.",
    "The caption excerpts below (if any) are machine pointers only; judge by watching.",
    "Return exactly ONE JSON object and nothing else:",
    '{"violations":[{"part":2,"rule":"PROOF_MISPLACED","evidence":"<quote> is said at <t>s, not inside the Hook range <a>-<b>s","fix":"move Part 2 Hook to <a2>-<b2>s"}]} (placeholders - use real values)',
    'Return {"violations":[]} if there is no real problem. Do not invent problems.'
  ].join("\n");
}

function criticPrompt(filename) {
  return [
    `EDITOR REVIEW of the ${filename} you just wrote. Do NOT rewrite it in this turn.`,
    "Re-watch the source ranges used by its segments and list only REAL, specific violations of these rules:",
    "- VO_OVER_DIALOGUE: a VO segment's bed contains speech, shouting, radio, banter or burned-in dialogue captions (the original line would be muted).",
    "- VO_EVENT_MISSING: VO names an event/graphic that neither its bed nor the next clip shows.",
    "- WRONG_REFERENT: a line is used as being about the suspect/someone but in context refers to another person.",
    "- HOOK_WEAK: the first 2.5s is not a high-energy, identifiable moment (empty road, calm talk, silence).",
    "- CLIMAX_NARRATED: VO covers a physical climax or punchline that should play as original audio.",
    "- BAD_CUT: original audio cut mid-word/sentence, or a < 1s flash of another camera angle.",
    "- BAD_ENDING: generic cliffhanger phrase or ending on a non-moment.",
    "Return exactly ONE JSON object and nothing else:",
    '{"violations":[{"segment":3,"rule":"VO_OVER_DIALOGUE","evidence":"<who> says <line> at <t>s inside this VO bed (<a>-<b>s); it would be muted","fix":"play <t1>-<t2>s as original_audio; move the VO to <x>-<y>s (no speech)"}]} (placeholders - use real values)',
    'Use absolute source seconds in evidence/fix. Return {"violations":[]} if the script has no real violation. Do not invent problems.'
  ].join("\n");
}

// Part prompts written into packages before these rules: swap the lines the
// rules supersede so an old pack does not carry two conflicting instructions.
const LEGACY_PART_LINES = [
  ["3-8s punchy VO bridges (max 10s)", "3-7s punchy VO bridges (max 7.5s, <= 18 words)"],
  ["Optionally finish with a verified 3-5s VO cliffhanger.", "Prefer ending on an original-audio spike; a VO cliffhanger is allowed only as one specific unresolved question (<= 3s, no generic filler)."],
  ["Avoid burned-in dialogue captions as background for muted voiceover.", "Never use footage with dialogue or burned-in dialogue captions as a VO bed."]
];
function upgradeLegacyPartPrompt(text) {
  let value = String(text || "");
  for (const [oldLine, newLine] of LEGACY_PART_LINES) value = value.split(oldLine).join(newLine);
  return value;
}

function appendIfMissing(text, block, marker) {
  const value = String(text || "");
  return value.includes(marker) ? value : `${value}\n\n${block}`;
}

module.exports = { upgradeLegacyPartPrompt, partRules, blueprintRules, criticPrompt, blueprintCriticPrompt, appendIfMissing, PART_MARKER, BLUEPRINT_MARKER };
