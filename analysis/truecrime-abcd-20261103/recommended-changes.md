# RECOMMENDED PIPELINE CHANGES: AUTOSTORY PRODUCTION
**Benchmark ID:** `truecrime-abcd-20261103`  
**Date:** 2026-11-03  
**Status:** Grounded in Verified Live Benchmark Executions (A/B/C/D)  

---

## 1. PHASE 1: IMMEDIATE HOTFIXES (P0 - MANDATORY PRE-PRODUCTION)

These hotfixes directly address the specific root causes verified in Experiments B and C:

### 1.1 Stop Injecting the Deceptive `USER-LOCKED` Header in `hookContractService.js`
- **File:** `electron/services/hookContractService.js:188`
- **Defect:** 
  The function `buildSeriesHookContractBlock()` hardcoded:
  `"SERIES HOOK CONTRACT (USER-LOCKED ANCHORS FOR ONE 3-PART STORY)"`
  even when the contract had `userLocked: false`. This coerced Gemini into treating algorithmic candidate guesses as inviolable human mandates.
- **Fix:** 
  Only output `"USER-LOCKED ANCHORS"` and `"Mandate: Script X Beat 1 MUST open with this anchor"` if `Boolean(contract.userLocked) === true`.
  When `userLocked: false`, inject advisory candidates:
  `"ADVISORY HOOK CANDIDATES: Consider these moments, but choose the opening that best preserves chronological tension and protects the series payoff."`
- **Expected Impact:** Immediately allows Gemini to reject poor anchors and select natural openers (as proven by Experiment C's jump from 32 to 71).

### 1.2 Purge Static Regex Overrides in `hookAuditionService.js` & Candidate Extraction
- **File:** `electron/services/hookAuditionService.js:65`
- **Defect:** 
  Regex pattern `/door|open|rattle/i` assigned the title `"Officer repeatedly struggles with barricaded door"` (Archetype: `Physical Friction / Barricade Suspense`) to a simple car door on a roadside stop.
- **Fix:** 
  Purge static archetype strings. Candidate descriptions must come directly from Gemini's visual observations or verified ASR transcripts. If no model description exists, use neutral metadata (`"Roadside Traffic Stop"`).

### 1.3 Fix Anchor Assignment Heuristics for Multi-Part Series
- **File:** `electron/services/hookContractService.js`, `electron/services/manualGeminiPackService.js`
- **Defect:** 
  Heuristics assigned candidate_015 (`278.0s - 294.0s`, the actual arrest/handcuffs) to Part 2 Beat 1. This forced Part 2 to spoil the series payoff at second 0.
- **Rule:** 
  **Strict Spoiler Filter:** Any candidate that depicts or mentions handcuffs, arrest, Miranda warnings, or charges is categorized as `payoff_material` and is strictly banned from being assigned as a hook anchor for Part 1 or Part 2.

### 1.4 Enforce 100% Source Audio Mute on `voiceover_only` Segments
- **File:** `electron/services/dubbingService.js`, `electron/services/ffmpegService.js`
- **Defect:** 
  Original YouTube narrator speech leaked into draft renders because ducking (`volume=0.2`) was applied instead of full muting (`volume=0`).
- **Fix:** 
  For any segment marked `voiceover_only`, force `volume=0` on the source audio stream. Reserve ducking exclusively for `voiceover_with_ambient` where source audio contains ambient noise without dialogue.

---

## 2. PHASE 2: EDITORIAL ARCHITECTURE MIGRATION (P1 - CORE REFACTOR)

Migrate production from the text-heavy `manual_gemini_draft_review` to the **Media-Grounded Editorial Director (`scope-media-director-v1`)** proven in Experiment D (Score: 87) and Experiment A (Score: 97).

### 2.1 Autonomous Story Count & Format Selection
- **Defect:** Dogmatically forcing every source into a 3-part series creates massive filler on short incidents.
- **Refactor:**
  Before committing to 3 parts, evaluate the active conflict duration ($T_{\text{active}}$):
  - If $T_{\text{active}} \le 180\text{s}$ (e.g. 9-minute video with 1 central arrest): Output **exactly ONE master standalone short (65s–75s)**.
  - If $T_{\text{active}} > 180\text{s}$ (e.g. multi-phase 30-minute incident with distinct car chase, foot pursuit, and K9 standoff): Generate a 2-part or 3-part series where each episode has an independent payoff.

### 2.2 Formal State Tracking: In Medias Res & Chronology Modes
- **Schema:** Adopt the `chronologyMode` schema from `editorialDirectorService.js`:
  - `teaser` (e.g. cruiser punchline at 455s–461s: *"Being rude is not illegal!"*)
  - `rewind` (e.g. highway catalyst at 35s: *"When a deputy pulled up to help..."*)
  - `chronological` (progressive escalation)
  - `payoff` (resolution and legal outcome)
- **Constraint:** Downstream compiler passes must not re-order or artificially extend director beats.

### 2.3 Media-Grounded Reel Packing (Tokens & Quality)
- **Architecture:** 
  Instead of sending 3 full proxy videos (~550 seconds, 100k tokens), continue using `scopeReelPacker.js` to extract candidate windows ($\sim 180$ seconds). This reduces prompt tokens by 40% while giving Gemini full multimodal fidelity over the key dramatic moments.

---

## 3. IMPLEMENTATION TIMELINE

| Step | Task | Target Files | Risk Level |
|---|---|---|:---:|
| **Step 1** | Remove fake `USER-LOCKED` string & add spoiler ban for Part 1/2 hooks | `hookContractService.js` | Low |
| **Step 2** | Purge static regex "barricaded door" overrides | `hookAuditionService.js` | Low |
| **Step 3** | Force `volume=0` on `voiceover_only` segments in FFmpeg filtergraph | `dubbingService.js` | Low |
| **Step 4** | Enable autonomous Story Count (1 vs 3 parts) in Story Scope | `storyScopeService.js` | Medium |
| **Step 5** | Default new projects to `editorialArchitecture: "scope_media_director"` | `configStore.js`, `renderer.js` | Medium |
