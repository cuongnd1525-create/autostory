# ROOT CAUSE ANALYSIS — V6 RECOVERY FOLLOW-UP

**Repository:** `cuongnd1525-create/autostory`  
**Branch:** `feat/autostory-v6-recovery-followup`  
**Date:** November 2026  
**Auditor:** Senior Software Architect & AI Video Systems Engineer  

---

## 1. Root Cause Summary Matrix

| Issue | Observed Timestamp | Evidence | File/Function | Root Cause | Fix | Verification |
|---|---|---|---|---|---|---|
| **Outro Intrusion (P0-A)** | Final MP4 79.767s (Frame 2393) | Final frame 2392 shows van door closing; frame 2393 snaps to 3-panel YouTube recap/outro. | `sourceEndingBoundaryService.js` / `detectSourceEndingBoundary`<br>`storyScopeService.js` / `compileStoryScope` | Boundary detector v1 relied solely on loose subtitle regex (`/thanks for watching/i`) without visual SCD / split-screen probe; source outro begins at 530.03s, but EDL extended to 531.0s. | Multimodal boundary detector v2: combines subtitle cues (`misuse of 911`), FFmpeg visual scene change detection (`scdScore`), black/split-screen card detection; caps `liveActionEndSec` to 529.83s with 0.20s safety margin. | Frame inspection at 73.0s, 73.5s, 74.0s, 74.3s shows zero outro frames. `outroFrameCount: 0`. |
| **Trailing Audio Dead Air (P0-A)** | Final MP4 79.803s → 80.757s (0.95s) | FFmpeg `silencedetect` reported 0.954s dead air at tail of audio track. | `ffmpegService.js` / `fitDubbingClusterAudio`<br>`dubbingService.js` | Source slice 528.5–531.0s had no dialogue in source audio after door closed; `apad` filter padded audio blindly to video container end. | Added `probeSpeechTailEnd` with `silencedetect=-36dB` to detect ambient/speech cutoff; trimmed tail pad to natural audio room-tone floor and applied `closingBlockSettle` (0.35s fade). | Technical QA checks silence: `tailSilences: []`. Dead air completely eliminated. |
| **Narrator Regression to 14.33% (P0-B)** | V6 Recovery: 11.575s speaking (14.33%), 3 blocks, 31 words. 38s unbroken raw audio run (00:40–01:18). | Narration audit showed narrator only summarized surface action ("Rather than accepting help...", "Was her arrest justified?"). | `deliveryBlockService.js` / `planDeliveryBlocks`<br>`editorialDirectorService.js`<br>`blockNarrationService.js` | `NARRATED_BLOCK_ACTIVE_DIALOGUE` validator strictly disqualified narrator from any segment with character speech, causing the Director to demote blocks to `raw_evidence` rather than seeking B-roll / establishing visuals. Director prompt lacked 9 narrative functions. | Implemented 9 distinct Narrator Functions (`CONTEXT`, `CAUSAL_BRIDGE`, `ANTICIPATION`, `COMMENTARY`, `INTERPRETATION`, `REHOOK`, `ESCALATION`, `PAYOFF`, `CLOSING`). Added visual ownership re-routing to source B-roll; introduced `commentary_led` pacing preset with 30–45% narrator target. | Option B achieved 31.05% narrator speaking share (23.1s across 4 blocks, 50 words), max raw run reduced from 38s to 20.0s, zero active dialogue collisions. |
| **Iconic Quote / Punchline Spoilers** | Pre-upgrade draft | Narrator text explicitly stated: *"She argues that being rude isn't illegal"* immediately before the subject said the exact words. | `blockNarrationService.js` / `validateNarratorPunchlineLeaks`<br>`editorialDirectorService.js` | Lack of an anti-spoiler gate allowed LLM to summarize upcoming high-impact quotes directly in narration text. | Created `validateNarratorPunchlineLeaks` gate checking 1-gram to 4-gram overlap against high-impact raw dialogue quotes within the subsequent 10 seconds. | In Option B, narration sets anticipation: *"Inside the cruiser, she challenges the basis of the stop — insisting attitude alone doesn't warrant detention."* followed by the subject's authentic quote: *"Being rude is not illegal!"* |
| **Duration Drift / QA Validator Mismatch** | Post-render QA | Technical Gate reported `DURATION_OUT_OF_BOUNDS (drifts 2.8s from EDL 77.2s)`. | `finalQualityGateService.js` / `runFinalQualityGate`<br>`autoStoryVariantWorker.js` | When `auditDirectorDraft` exited via `UNREPAIRABLE` (presentation review only), the repaired spine (74.35s) was stored in `last-rendered-story-spine-1.json`, but `story-spine.json` remained at 77.2s. QA calculated `expectedTimelineSec` from unrepaired `spine.beats` instead of `script.segments`. | 1. Updated `finalQualityGateService.js` to prioritize `script.measuredDuration` -> `script.segments` -> `spine.beats`.<br>2. Updated `autoStoryVariantWorker.js` to sync `last-rendered-story-spine-${scriptId}.json` to `parentSpineData`. | Technical QA evaluates `74.4s` against `74.35s` (drift = `0.05s` <= `0.85s`). Technical Gate: **PASS**, Overall QA: **PASS**. |
| **Hook Title Factual Accuracy & Anti-Copycat** | Prior benchmark: "24yo Abuses 911..." | Unverified age claim (24yo); wording closely mimicked reference headline; spoiled arrest consequence. | `hookAuditionService.js` / `verifyHookTitle`<br>`hookAuditionService.js` / `runHookAudition` | Hook selection scored purely on LLM transcript novelty without multimodal preview render or factual cross-examination against incident record. | Hook Audition generates >= 2 rendered 9:16 video previews; verifies age/names against transcript cues; enforces anti-copycat similarity threshold (`jaccard <= 0.60`); penalizes outcome spoilers. | Selected Option B Title: *"She Left Her Stalled Car Behind Until A Severe Warning Followed"* — 100% verified, 0 spoilers, anti-copycat PASS. |

---

## 2. In-Depth Technical Traces

### Trace 1: The Outro Boundary Failure (Frame 2393 at 79.767s)
```
SOURCE FOOTAGE (549.74s total)
  ├── 00:00 - 529.83s: Authentic live-action police bodycam (Officer closes van door)
  ├── 530.03s: Hard cut to YouTube channel split-screen recap & subscribe graphics
  └── 533.04s: Channel narrator voiceover & legal charge recap

V6 RECOVERY (OLD FAILED STATE):
  - detectSourceEndingBoundary v1: Only scanned for text "thanks for watching"
  - Result: Missed 530.03s split-screen cut; reported liveActionEndSec = 549.74s
  - Editorial Director EDL: Selected Beat 8 from 528.5s to 531.0s (2.5s duration)
  - Result in Rendered MP4:
      * 0.000s - 79.733s (Frames 0 - 2392): Live action
      * 79.767s (Frame 2393): CUT TO CHANNEL OUTRO CARD
      * 79.803s - 80.757s: 0.95s Dead air silence padded by FFmpeg apad

V6 RECOVERY FOLLOW-UP (REPAIRED STATE):
  - detectSourceEndingBoundary v2:
      * Subtitle trigger: ">> The officer charged her with misuse of 911..." at 533.04s
      * FFmpeg visual scene change detection: scdScore=20, dividerBands=2 at 530.03s
      * Static/black card detector: confirmed non-live-action transition at 530.03s
      * Safety Margin: -0.20s backoff -> liveActionEndSec = 529.83s
  - Story Scope & Director EDL: Clamped Beat 8 sourceEndSec to 529.80s
  - Rendered MP4: Exactly 74.40s. Frame 74.3s shows van door securely shut. Zero outro frames.
```

### Trace 2: Narrator Suppression & Recovery
```
PRE-RECOVERY SUPPRESSION:
  - Delivery Block Validator: NARRATED_BLOCK_ACTIVE_DIALOGUE was treated as a binary fatal error.
  - When the Director attempted to insert commentary during the middle act (the 38-second interrogation),
    the validator detected dialogue from the subject and forced the block into `raw_evidence`.
  - The Director prompt was biased toward preserving 100% raw speech, reducing narrator to 3 shallow bridges (14.33%).

V6 FOLLOW-UP RESTORATION:
  - Added B-Roll re-targeting: When narrator commentary is required, the compiler pairs narration with
    establishing shots (cruiser driving, subject walking away from car, exterior tree line) rather than active speaking faces.
  - Preserved iconic dialogue: The subject's key rebuttal ("Being rude is not illegal!") is guaranteed a standalone
    `raw_evidence` delivery block immediately following the narrator's setup.
  - Pacing Options:
      * Option A (Evidence-Heavy): 3 blocks, 18.3s speaking (25.9%), max raw stretch 35.7s.
      * Option B (Commentary-Led): 4 blocks, 23.1s speaking (31.05%), max raw stretch 20.0s.
```
