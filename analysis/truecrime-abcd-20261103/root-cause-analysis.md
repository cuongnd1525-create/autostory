# ROOT CAUSE ANALYSIS: TRUE CRIME EDITORIAL FAILURE MODES
**Benchmark ID:** `truecrime-abcd-20261103`  
**Investigation Target:** AutoStory True Crime / US Bodycam Pipeline  
**Source Incident:** `m6ow9dqxqcg` ("Entitled Driver Abandons Car In Traffic / Misuse of 911")  
**Audit Status:** Fully Verified with Live Vertex AI and Subagent Executions  

---

## 1. EXECUTIVE SUMMARY

The previous investigation into the AutoStory pipeline revealed that drafts produced by the production pipeline (`manual_gemini_draft_review` / Baseline B) suffered from severe editorial flaws:
1. Hallucinated "barricaded door" anchors on a simple roadside incident.
2. Premature spoiling of the arrest in Part 2 at second 0.
3. Jarring reverse-chronology and broken causality.
4. Redundant filler driving footage.

Through the controlled A/B/C/D benchmark, we proved that **these failures were NOT caused by limitations in Gemini's multimodal intelligence**. When running Gemini without pipeline constraints (Experiment A) or through the media-grounded Editorial Director (Experiment D), Gemini demonstrated world-class editorial judgment.

Furthermore, our live ablation test (Experiment C) proved that **removing a single 27-line prompt block (the automatic Hook Contract) immediately eliminated the Part 2 spoiler and restored chronological integrity**, raising the editorial score from **32 to 71**.

---

## 2. THE FIVE ARCHITECTURAL ROOT CAUSES

### Root Cause 1: The Misleading `USER-LOCKED` Prompt Injection Lie
- **The Code Location:** `electron/services/hookContractService.js` (lines 186–193).
- **The Mechanism:**
  When `buildSeriesHookContractBlock()` generates the prompt injection, it hardcodes:
  ```text
  ================================================================================
  SERIES HOOK CONTRACT (USER-LOCKED ANCHORS FOR ONE 3-PART STORY)
  ================================================================================
  ...
  Mandate: Script 1 Beat 1 MUST open with this anchor.
  ```
- **The Flaw:**
  The stored database JSON (`hook-contract.json`) had `userLocked: false`. The user had **never** locked these anchors. Yet the pipeline told the LLM that a human creator had explicitly mandated these exact timestamps.
- **The Impact on the LLM:**
  Gemini obeys user-locked constraints above all else. Because the prompt told Gemini that the anchors were human-locked mandates, Gemini was forced to obey them, even when the model's visual reasoning knew there was no barricaded door and that 278s was the climax arrest.

---

### Root Cause 2: Heuristic Hallucination of Action Candidates ("Barricaded Door")
- **The Mechanism:**
  The upstream candidate extraction service (`action-candidates.json`) scanned motion vectors and audio peaks. A routine moment of the deputy walking up to the car door was classified as:
  `"Officer repeatedly struggles with barricaded door" (Archetype: Physical Friction / Barricade Suspense)`
- **The Flaw:**
  This was an algorithmic guess based on regex and scene boundary heuristics. There was no barricade, no house, no SWAT team, and no door struggle. It was an entitled driver refusing to talk through a car window.
- **The Impact:**
  Because this phantom candidate was picked as Candidate 004 and Candidate 015, the pipeline promoted it into the Hook Contract and forced it onto all three scripts.

---

### Root Cause 3: Fatal Anchor Assignment to Part 2 (The Spoiler Catastrophe)
- **The Mechanism:**
  The automatic series allocation heuristic split the source into three chronological zones:
  - Part 1: [0s – 180s]
  - Part 2: [180s – 360s]
  - Part 3: [360s – 549s]
  Inside Part 2's zone [180s – 360s], the candidate generator found candidate_015 at `278.0s – 294.0s` and assigned it as the **mandatory opener** for Part 2!
- **The Editorial Disaster:**
  `278.0s – 294.0s` is the exact moment deputies place handcuffs on the suspect for 911 misuse.
  By forcing Part 2 to open with `278.0s – 294.0s`, the pipeline forced Part 2 to reveal the handcuffs at second 0! Then, to fill Part 2's 80-second duration, Gemini had to rewind to 204s, play the sidewalk conversation, and end by repeating the exact same handcuffing scene at 1:16.

---

### Root Cause 4: Dogmatic 3-Part Serialization on Short Incidents
- **The Architectural Flaw:**
  The production pipeline enforces an immutable 3-part series rule:
  `PART 1 = The Confrontation, PART 2 = The Interrogation, PART 3 = The Verdict & Arrest`
- **The Mismatch with Source Footage:**
  The source video is only 9 minutes long (549 seconds). It contains **one continuous roadside stop, walkaway, and arrest**.
  - There is no separate 2-hour interrogation.
  - There is no trial or verdict.
  - Slicing 9 minutes into three 85-second shorts (~255 seconds of total edit) requires recycling over 50% of the entire source footage, forcing massive amounts of dead-air driving shots and administrative radio chatter.
- **What Unconstrained Intelligence Discovered:**
  Both **Experiment A** (Free Editorial) and **Experiment D** (Editorial Director) independently determined that this footage supports **exactly ONE master standalone short (68s–74s)**. Slicing it into 3 parts was the root cause of the audience drop-off and pacing drag.

---

### Root Cause 5: Text-Only JSON Scripts vs. Multimodal Media Grounding
- **Pipeline B/C:**
  Gemini is given a 30KB text prompt containing timestamps, scene manifests, and SRT text. While 3 proxy videos are attached, the prompt emphasizes text schemas and JSON structures. Gemini operates primarily as a text JSON compiler rather than a video director.
- **Pipeline D & A:**
  In Experiment D, the Story Scope isolates candidate footage, packs a dedicated `scope-reel` MP4, and submits the reel to `editorialDirectorService`. Gemini watches the actual video frames (42,372 video tokens) and writes the EDL directly from visual observations (`observedInFootage`), creating a grounded narrative that downstream JavaScript compiler passes cannot distort.

---

## 3. SUMMARY COMPARISON MATRIX

| Dimension | Baseline B (Current Pipeline) | Ablation C (No Hook Contract) | Director D (Scope Director) | Free A (Antigravity Director) |
|---|---|---|---|---|
| **Opener Part 1** | Forced 62–82s (Barricade) | Discovered 39–53s (Confrontation) | Discovered 35–45s (Confrontation) | In Medias Res 455–461s (Cruiser) |
| **Opener Part 2** | Forced 278–294s (Handcuffs) | Discovered 216–230s (Pursuit) | N/A (Single Story) | N/A (Single Story) |
| **Spoiler Boundary** | **BROKEN** (Spoiled at 0:04) | **PROTECTED** (Arrest at Beat 4) | **PROTECTED** (Arrest at Beat 8) | **PROTECTED** (Charge at Beat 8) |
| **Story Count** | Forced 3 Parts | Forced 3 Parts | 1 Standalone Story | 1 Standalone Story |
| **Format Target** | 3 x 85s (255s total) | 3 x 82s (246s total) | 1 x 68s | 1 x 74s |
| **Score** | **32 / 100** | **71 / 100** | **87 / 100** | **97 / 100** |
