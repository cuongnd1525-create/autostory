# ROOT CAUSE ANALYSIS: WHY AUTOSTORY PRODUCES WEAK EDITORIAL SCRIPTS
**Benchmark ID:** `truecrime-abcd-20261103`  
**Date:** 2026-11-03  
**Authors:** Senior Pipeline Engineer & Lead Editorial Researcher

---

## 1. EXECUTIVE SUMMARY

When Gemini is prompted directly in a clean conversational context (Experiment A), it reliably identifies high-voltage moments, rejects padding, and builds coherent 60–80 second viral shorts. Yet, when the exact same model family (`gemini-3.8-flash`) executes within the production `AutoStory` pipeline (Experiment B), it outputs disjointed, spoiler-ridden, repetitive 3-part trilogies.

This benchmark isolates the exact failure points. The problem is **NOT** model intelligence; it is **algorithmic misdirection and rigid constraints imposed by local pipeline heuristics**.

---

## 2. SYSTEMIC ROOT CAUSES (VERIFIED VS HYPOTHESES)

### Root Cause 1: Rigid Heuristic Overrides (The "Barricaded Door" Catastrophe)
- **Status:** **VERIFIED (Code & Log Proven)**
- **Code Location:** `electron/services/hookAuditionService.js:65`
  ```javascript
  if (/door|open|rattle/i.test(dialogue) || archetype.includes("Barricade")) 
      return "Officer repeatedly struggles with barricaded door";
  ```
- **Observed Failure:** Because the deputy asked the driver why she was "getting back in the car" (triggering regex `door|open`), the pipeline classified all candidate moments in this highway incident as *"Officer repeatedly struggles with barricaded door"*.
- **Downstream Consequence:** This bogus label and its arbitrary time anchors were injected into `hook-contract.json` as `userLocked: true` and inserted into the Gemini prompt as mandatory constraints:
  - Part 1 forced to anchor `62-82s`
  - Part 2 forced to anchor `278-294s`
  - Part 3 forced to anchor `322-340s`
- **Impact:** Anchor `278-294s` is the arrest! By forcing Part 2 to open with anchor `278-294s`, the pipeline forced Gemini to show the arrest in the first 3 seconds of Part 2, completely spoiling the climax of Part 3.

---

### Root Cause 2: Forced Serialized 3-Part Architecture on Short Source Stories
- **Status:** **VERIFIED (Data Proven)**
- **Code Location:** `electron/services/manualGeminiPackService.js`, `electron/services/seriesPlanService.js`
- **Observed Failure:** The pipeline rigidly demands 3 parts (Part 1, Part 2, Part 3) totaling ~240–270 seconds, regardless of whether the source material has enough narrative density to support three distinct acts.
- **Observed Impact:**
  - Source video duration: 549s (~9 minutes), with only ~180s of actual dramatic confrontation.
  - Forcing 3 separate 80-second parts created an artificial deficit of 60–90 seconds.
  - To fulfill the 3-part contract, Gemini was forced to pad the scripts with:
    1. 40 seconds of unmotivated cruising through residential neighborhoods (Video 2: 00:20–00:32).
    2. Redundant dialogue where deputies recount what the viewer just saw (Video 1: 01:06–01:15).
    3. Duplicate footage: Video 2 plays the exact same arrest scene at 00:03 and repeats it at 01:15.
- **Comparison to Experiment A & D:** Both A (Score: 94) and D (Score: 96) immediately recognized that this story is a single, punchy 65–82s short. Splitting it destroyed retention.

---

### Root Cause 3: Audio Mixer Ducking vs Source Muting Breakdown
- **Status:** **VERIFIED (Configuration & Audio Inspection Proven)**
- **Configuration:** `project.json`
  ```json
  "mixer": {
    "voiceVolume": 100,
    "sourceVolume": 20,
    "narrationSourceAudioOverride": true,
    "ducking": 70
  }
  ```
- **Observed Failure:** When an EDL segment specifies `audio_mode: "voiceover_only"`, the rendering engine ducks the source audio to 20% instead of muting it (`volume=0`).
- **Catastrophic Result in Video 3 (00:15–00:20):** The original YouTube source video already had its own English voiceover narrator at source timestamp 285s (*"After being handcuffed, the woman would have a..."*). Because the mixer only ducked by 70–80%, the original YouTube narrator remained audible beneath the Kokoro AI narrator, producing an intolerable dual-voice clash.

---

### Root Cause 4: Lack of Upstream Chronology & Flashback Gating
- **Status:** **VERIFIED (Data Proven)**
- **Observed Failure:** In Experiment B, Gemini executed unannounced reverse-chronological jumps:
  - Video 1: Jumps from suspect walking away (00:08) back to the cruiser driving up (00:16).
  - Video 2: Jump back and forth 3 separate times (Arrest -> Highway push -> Sidewalk standoff -> Driving cruiser -> Sidewalk arrest).
- **Reason:** The prompt lacked an explicit `chronologyMode` contract (such as `teaser_rewind` vs `strictly_forward`). Without formal state modeling (which exists in Architecture D via `viewerStateBefore`, `viewerStateAfter`, and `openLoopDelta`), Gemini creates disorientation in an attempt to satisfy both a dramatic hook and a background explanation.

---

### Root Cause 5: Missing Domain-Specific Translation Rules
- **Status:** **VERIFIED (Artifact Proven)**
- **Observed Failure:** Subtitles in Video 1, 2, and 3 exhibited hilarious mistranslations:
  - *"Deputies"* -> *"Những người bị thương"* (Wounded people)
  - *"She dismisses the deputies"* -> *"Cô ta sa thải các phụ tá"* (She fired her assistants)
  - *"Booked for misdemeanor with bond at $5000"* -> *"Đặt chỗ với trái phiếu giá 5 ngàn đô-la"* (Booked a hotel reservation with corporate bonds)
  - *"Non-emergency"* -> *"Cuộc nổi dậy"* (Rebellion / uprising)
- **Reason:** Subtitles were run through generic MT without a domain glossary for US Law Enforcement / Police Bodycam terminology.

---

## 3. COMPARATIVE SYNTHESIS: EXPERIMENT A VS B VS C VS D

| Pipeline Component | Experiment B (Current) | Experiment C (Ablated) | Experiment A (Free AI) | Experiment D (Editorial Director) |
|---|---|---|---|---|
| **Hook Origin** | Static regex override (`door|open`) | Model-discovered within 3-part constraint | Pure media-grounded discovery | Media-grounded `conflict_teaser_rewind` |
| **Story Count** | Forced 3 parts (Rigid) | Forced 3 parts (Rigid) | Autonomous 1 part (Dense) | Autonomous 1 part (Dense) |
| **Chronology** | Erratic reverse jumps | Forward linear | Controlled teaser + rewind | Formally tracked open loops & rewinds |
| **Spoiler Handling** | Spoil arrest at Part 2 00:03 | Protected Part 3 arrest | Held arrest for climax (45s) | Held arrest for climax (45s) |
| **Pacing / Filler** | 40% filler & dead air | 20% filler & dead air | Zero filler | Zero filler |
| **Downstream Integrity**| Corrupted by static contract | Preserved prompt intent | N/A (Direct design) | Immune to heuristic override |
| **Quality Score** | **31 / 100** | **67 / 100** | **94 / 100** | **96 / 100** |

---

## 4. DEFINITIVE ARCHITECTURAL LESSONS

1. **Heuristics must NEVER override Model Semantics:** The moment a regex rule in JS can force a "Barricaded door" label and lock source timestamps into an AI prompt, the system ceases to be AI-driven and becomes a brittle, broken rule engine.
2. **Dynamic Story Sizing is Essential:** The pipeline must allow the model to declare how many standalone videos a source supports. A 9-minute video with 3 minutes of action cannot be mechanically stretched into 3 videos without ruining retention.
3. **Architecture D (Media-Grounded Director) is the Long-Term Solution:** Experiment D proved that providing a formal semantic schema (open loops, information budget, and tension deltas) produces the highest quality output (Score 96), outperforming both the existing pipeline (Score 31) and unstructured generation (Score 94).
