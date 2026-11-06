# CODE CHANGES & ARCHITECTURAL UPGRADES — V6 RECOVERY FOLLOW-UP

**Repository:** `cuongnd1525-create/autostory`  
**Base Commit:** `63212e6` (`feat/autostory-v6-editorial-recovery`)  
**Working Branch:** `feat/autostory-v6-recovery-followup`  
**Date:** November 2026  

---

## 1. Summary of Changes by Subsystem

### A. Production Integrity Subsystem (Eliminating Outro & Dead Air)
1. **`electron/services/sourceEndingBoundaryService.js` (Major Enhancement — v2 Detector)**
   - Added cache invalidation bound to `sourceFingerprint` (SHA-256 of first/last 64KB + file size) and `VERSION = 2`.
   - Implemented multi-modal evidence collection:
     - Subtitle cue patterns for channel outro phrases, case resolution voiceovers, and subscribe prompts.
     - FFmpeg scene change detection (`select='gt(scene,0.2)'`) to identify visual cuts in the trailing 60s.
     - Dual-band split-screen analysis to detect multi-panel recap/outro layouts.
     - Black/static card probe to pinpoint title cards and credits.
   - Computes conservative `liveActionEndSec` with a mandatory `0.20s` safety backoff.
   - Flags `uncertain: true` if confidence is low, preventing unjustified technical PASS.

2. **`electron/services/ffmpegService.js` (Audio Fit & Tail Settle)**
   - Added `probeSpeechTailEnd(audioPath)` using FFmpeg `silencedetect=n=-36dB:d=0.25` to find the exact end of speech/room-tone before container padding.
   - Refactored `fitDubbingClusterAudio`:
     - Natural breath lead-in (0.04s) on spoken narration blocks.
     - Closing block settle (`closingBlockSettle = 0.35s`) with exponential audio fade-out to prevent abrupt audio cutoffs.
     - Replaced brittle `apad=whole_dur` with `asetpts=N/SR/TB` + `apad=pad_dur` + `atrim` pipeline to avoid time distortion after atempo/adelay filters.
   - In `applyVideoDecoration`: added `alimiter=limit=0.82:attack=5:release=50:asc=1` to guarantee final mix peaks remain strictly within broadcast specs.

3. **`electron/services/finalQualityGateService.js` (New Service — 2-Tier Quality Gate)**
   - Two distinct gates: **Technical Gate** and **Multimodal Editorial Gate**.
   - Technical Gate:
     - Exact dimensions check (must match `1080x1920` for Production Final).
     - Strict duration compliance: computes expected timeline from `script.measuredDuration` -> `script.segments` -> `spine.beats`.
     - FFmpeg visual anomaly detection: scans for frozen frames (`freezedetect`), black frames (`blackdetect`), and flash frames.
     - FFmpeg silence detection: flags audio dead air > 0.8s within the final 3.0s (`tailSilences`).
     - Frame-level outro check: extracts dense frames across final 3.0s (0.1s intervals) to confirm no outro card intrusion.
     - Subtitle boundary compliance: checks for text overflowing past video end.
   - Editorial Gate:
     - 12 criteria: `hook`, `storyClarity`, `narratorValue`, `commentary`, `narratorNaturalness`, `pacing`, `curiosityProgression`, `sourceFidelity`, `punchline`, `payoff`, `ending`, `overallWatchability`.
   - Cryptographic SHA-256 binding: `verifyFinalQaBinding` guarantees the QA report matches the delivered MP4 byte-for-byte.

### B. Storytelling & Narration Restoration Subsystem
4. **`electron/services/deliveryBlockService.js` & `electron/services/editorialDirectorService.js`**
   - Replaced flat `narrated_story` mode with 9 specialized Narrator Delivery Functions:
     - `CONTEXT`: Sets the scene and stakes without spoiling outcomes.
     - `CAUSAL_BRIDGE`: Connects non-contiguous scenes with narrative rationale.
     - `ANTICIPATION`: Builds tension before high-impact raw evidence.
     - `COMMENTARY`: Analyzes motivations, contradictions, and officer tactics.
     - `INTERPRETATION`: Unpacks complex procedural or legal nuances.
     - `REHOOK`: Re-engages audience curiosity across pacing transitions.
     - `ESCALATION`: Accelerates momentum into the climax.
     - `PAYOFF`: Delivers emotional/investigative closure.
     - `CLOSING`: Poses provocative, open-ended discussion questions.
   - Enabled `commentary_led` pacing preset targeting 30–45% organic narrator share.
   - Added visual re-targeting: when active dialogue occurs in source footage, narration is assigned to establishing/B-roll visual clips rather than being dropped.

5. **`electron/services/blockNarrationService.js`**
   - Added `selectNarrationEvidence`: filters and caps attached evidence clips to `<= 10` files to stay strictly within Vertex AI multimodal token and file count limits.
   - Added `validateNarratorPunchlineLeaks`: scans narrator draft text for verbatim n-gram leaks of upcoming dialogue within the next 10 seconds, preventing punchline spoilers.

6. **`electron/services/narrationAuditService.js` (New Service — 13-Field Performance Audit)**
   - Analyzes real Kokoro TTS audio files with FFmpeg `silencedetect` and `volumedetect`.
   - Produces `narration-performance-audit.json` with 13 required fields:
     `blockId`, `outputTimestamp`, `exactNarrationText`, `speakingDurationSec`, `blockDurationSec`, `wpm`, `narratorFunction`, `evidenceReference`, `contentValue`, `potentialSpoiler`, `voiceFindings`, `handoffFindings`, `recommendation`.
   - Computes narrator share by speaking time (`narratorShareBySpeakingPct`), average WPM, and max uninterrupted raw dialogue run (`maxUninterruptedRawSec`).

7. **`electron/services/hookAuditionService.js` (New Service — Multimodal Hook Lab)**
   - Renders at least 2 distinct 9:16 vertical hook preview MP4s using FFmpeg.
   - Performs multimodal evaluation using Vertex AI or deterministic factual verification:
     - Checks ages, locations, and names against transcript cues.
     - Verifies anti-copycat distance against reference titles (`jaccard <= 0.60`).
     - Penalizes outcome spoilers.
   - Automatically promotes the winning hook title to project `videoDecoration.topCaptionText`.

8. **`electron/services/dubbingService.js`**
   - Bumped narrated block voice cache version to v5.
   - Enabled `masterAudio` normalization and limiter processing for contract version 4.
   - Passed `isClosingBlock` flag down to `fitDubbingClusterAudio` for smooth room-tone decay.

9. **`electron/services/autoStoryVariantWorker.js`**
   - Fixed repair persistence: synchronizes `last-rendered-story-spine-${scriptId}.json` to `parentSpineData` on promoted technical pass, ensuring the parent project's `story-spine.json` reflects the repaired EDL.

---

## 2. Before vs. After Behavior Matrix

| Component | Before Follow-up | After Follow-up |
|---|---|---|
| **Outro Detection** | Text regex only; missed split-screen cuts | Multimodal SCD + subtitle cues + split-screen card detector (confidence 0.99) |
| **Tail Audio** | Blind `apad` padding causing 0.95s silence | `probeSpeechTailEnd` + natural room-tone settle; zero tail silence |
| **Narrator Speaking Share** | 14.33% (11.57s speaking, 3 blocks) | 31.05% (23.10s speaking, 4 blocks) |
| **Middle Act Narrative** | 38s unbroken raw dialogue run | Compressed to 20.0s max raw run with anticipation setup |
| **Iconic Dialogue** | Risk of punchline spoiler by narrator | Anti-spoiler gate prevents verbatim leaks; raw punchline preserved |
| **Hook Title Selection** | Text-only novelty score; 24yo unverified | Multimodal preview render + factual verification + anti-copycat check |
| **Final QA Validation** | Draft PASS assumed for final; hash unbound | Bound to exact delivered 1080x1920 MP4 via SHA-256; zero tolerance for outro |

---

## 3. Regression & Integration Test Status
- `tests/v6RecoveryFollowup.test.js`: **10/10 PASS** (all 13 required scenarios covered).
- `tests/storyScopeArchitecture.test.js`: **61/61 PASS**.
- `tests/deliveryBlocks.test.js`: **29/29 PASS**.
- `npm run test:v4-production`: **13/13 PASS**.
- `npm run test:auto-story`: **PASS (exit code 0)**.
- `npm run check`: **PASS (exit code 0)**.
