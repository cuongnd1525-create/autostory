# NARRATION PERFORMANCE AUDIT — V6 RECOVERY FOLLOW-UP

**Artifact Source:** `D:\OutputVideo\v6-followup-commentary-b\analysis\auto-story-fast\narration-performance-audit.json`  
**Delivered MP4:** `D:\Video\v6-followup-storyteller-benchmark-final.mp4` (SHA-256: `6877284292b08d84eecbb586a02ffdff83589d98cdfaf0947403435fd0e231b2`)  
**Pacing Preset:** `commentary_led` (Option B)  
**Voice Engine:** Kokoro TTS (`am_adam`, speed 1.04x)  

---

## 1. Executive Performance Summary

| Metric | V6 Recovery (Broken) | V6 Follow-up Option A (Evidence-Heavy) | V6 Follow-up Option B (Commentary-Led) |
|---|---|---|---|
| **Total MP4 Duration** | 80.77s | 70.67s | **74.40s** |
| **Narrator Blocks** | 3 blocks | 3 blocks | **4 blocks** |
| **Total Spoken Words** | 31 words | 38 words | **50 words** |
| **Speaking Duration** | 11.575s | 18.30s | **23.10s** |
| **Narrator Speaking Share** | **14.33%** (Severe regression) | **25.90%** | **31.05%** (Target 30–45% met) |
| **Average WPM** | 160.7 WPM (Rushed) | 124.6 WPM (Deliberate) | **129.87 WPM** (Natural conversational) |
| **Max Uninterrupted Raw Dialogue Run** | 38.0s (00:40 → 01:18) | 35.7s | **20.0s** (Dynamic commentary pacing) |
| **Punchline Spoilers** | None | None | **Zero (Anti-spoiler gate verified)** |
| **Active Dialogue / Subtitle Collisions** | Demoted narration to raw | Clean visual re-routing | **Zero (Subtitles & ambient ducked cleanly)** |

---

## 2. Block-by-Block Delivery Audit

### Block 1: `blk_02_context` (Narrator Function: `CONTEXT`)
- **Output Timestamp:** `7.05s → 12.65s` (5.60s duration)
- **Source Footage Timestamps:** `66.40s → 72.00s` (B-roll of subject walking away from stalled vehicle)
- **Exact Narration Script:**  
  > *"Leaving her disabled car blocking traffic, she walks away on foot."*
- **Speech Metrics:** 11 words, 5.60s speaking duration, **117.86 WPM**. Raw TTS duration = 4.63s.
- **Editorial Intent:** Quickly compresses the setup without reciting tedious dispatcher introductions, framing the central procedural question of why leaving a stalled car caused police intervention.
- **Spoiler Status:** `PASS` (No punchline leaks).
- **Handoff:** Transitions smoothly into `blk_03_dispatch` (authentic 911 dispatch audio) with a natural breath lead-in.

### Block 2: `blk_04_bridge` (Narrator Function: `CAUSAL_BRIDGE`)
- **Output Timestamp:** `21.35s → 27.35s` (6.00s duration)
- **Source Footage Timestamps:** `186.00s → 192.00s` (Cruiser dashcam arriving at parking lot)
- **Exact Narration Script:**  
  > *"Tracking her dispatch call, deputies quickly locate her walking through a nearby parking lot."*
- **Speech Metrics:** 14 words, 6.00s speaking duration, **140.00 WPM**. Raw TTS duration = 5.75s.
- **Editorial Intent:** Connects the 911 phone disconnect to the visual intercept in the commercial parking lot. Bridges space and time causally.
- **Spoiler Status:** `PASS`.
- **Handoff:** Direct handoff to `blk_05_arrest` where officers command her to stop and place her in handcuffs.

### Block 3: `blk_06_rehook` (Narrator Function: `ANTICIPATION`)
- **Output Timestamp:** `42.85s → 48.35s` (5.50s duration)
- **Source Footage Timestamps:** `293.00s → 298.50s` (Establishing shot outside police cruiser)
- **Exact Narration Script:**  
  > *"Now under arrest, she remains convinced her 911 call broke no laws."*
- **Speech Metrics:** 12 words, 5.50s speaking duration, **130.91 WPM**. Raw TTS duration = 5.40s.
- **Editorial Intent:** Re-hooks the viewer at the midpoint before the explosive back-and-forth van debate. Sets up her perspective without spoiling her exact legal rebuttal.
- **Spoiler Status:** `PASS` (Anti-spoiler gate verified: does not leak *"Being rude is not illegal"*).
- **Handoff:** Hands off directly to `blk_07_van_climax` where she exclaims: *"Being rude is not illegal!"* and argues with the sergeant.

### Block 4: `blk_08_closing` (Narrator Function: `CLOSING`)
- **Output Timestamp:** `68.35s → 74.35s` (6.00s duration)
- **Source Footage Timestamps:** `523.50s → 529.50s` (Officer closes transport van door, ending at 529.50s safely before 529.83s live-action boundary)
- **Exact Narration Script:**  
  > *"A roadside dispute led to criminal charges. Did calling 911 warrant an arrest?"*
- **Speech Metrics:** 13 words, 6.00s speaking duration, **130.00 WPM**. Raw TTS duration = 6.15s.
- **Editorial Intent:** Synthesizes the core legal conflict, provoking viewer comment section engagement on whether the arrest was justified under Florida statute.
- **Handoff & Settle:** Equipped with `closingBlockSettle = 0.35s`. Audio naturally decays to background room tone as the van door closes shut at 74.3s.

---

## 3. Kokoro TTS Voice Performance Audit

- **Voice ID:** `am_adam` (US English Male, grounded investigative timbre).
- **Speed Setting:** `kokoroSpeed = 1.04x` (delivers natural pacing between 117 and 140 WPM, eliminating the robotic 1.20x rush).
- **Cadence & Pauses:**
  - Lead-in breath: 0.04s natural pre-speech buffer.
  - Inter-phrase pause: Natural micro-silences (0.15s–0.25s) detected between sentences.
  - Dynamic range: Peak audio capped via `alimiter=0.82` with true peak at +0.9 dBFS; integrated loudness at -12.4 LUFS (well within broadcast tolerances of -14 ±2 LUFS).
- **Audio Handoff Verification:** Zero cross-talk or dialogue masking between Kokoro narration and raw bodycam audio. Ambient audio cleanly ducks under narration blocks.
