# RECOMMENDED PIPELINE CHANGES: AUTOSTORY PRODUCTION
**Benchmark ID:** `truecrime-abcd-20261103`  
**Date:** 2026-11-03  
**Status:** Approved for Implementation Roadmap

---

## 1. PHASE 1: IMMEDIATE HOTFIXES (P0 - MANDATORY PRE-PRODUCTION)

These 3 fixes must be implemented immediately to prevent broken, unwatchable renders:

### 1.1 Purge Static Regex Overrides in `hookAuditionService.js`
- **File:** `electron/services/hookAuditionService.js:65`
- **Action:** Delete the regex `/door|open|rattle/i` and all static title fallbacks (`"Officer repeatedly struggles with barricaded door"`).
- **Replacement:** The Hook Candidate title must either be derived from Gemini's actual visual understanding or from verified transcript dialogue matching the exact segment. If no model title exists, use a neutral generic descriptor (`"High-Tension Dialogue Exchange"`) and never lock forced time anchors into downstream prompts.
- **Verification Criteria:** When running the analysis pack generator on `source-m6ow9dqxqcg.mp4`, `hook-contract.json` must NOT contain "barricaded door" or duplicate candidate titles.

### 1.2 Enforce 100% Source Audio Mute on `voiceover_only` Segments
- **File:** `electron/services/dubbingService.js`, `electron/services/ffmpegService.js`
- **Action:** Update the FFmpeg audio filtergraph generation. For any segment where `audio_mode === "voiceover_only"`, apply `volume=0` to the source stream rather than relying on ducking (`volume=0.2`).
- **Safety Rule:** Ducking (e.g. 70-80%) is only permitted when `audio_mode === "voiceover_with_ambient"` and the segment has verified lack of human speech.
- **Verification Criteria:** Draft 3 segment `seg_4_02` must render with zero audible leakage of the original YouTube narrator.

### 1.3 Fix Variant Title Injection in Video Decoration
- **File:** `electron/services/ffmpegVideoDecoration.js`, `src/productionQueueUi.js`
- **Action:** Ensure the top banner text receives `variant.title` or `script.title` dynamically rather than caching or defaulting to `project.title` / Part 1 title for all variants.
- **Verification Criteria:** Rendering Part 2 and Part 3 must burn the correct titles ("PART 2: THE SIDEWALK STANDOFF", "PART 3: ARREST FOR 911 MISUSE") rather than repeating Part 1's title.

---

## 2. PHASE 2: EDITORIAL ARCHITECTURE MIGRATION (P1 - CORE REFACTOR)

Migrate production from the rigid `manual_gemini_draft_review` 3-part script generator to the **Media-Grounded Editorial Director (`scope-media-director-v1`)** proven in Experiment D (Score: 96).

### 2.1 Replace Fixed 3-Part Serialization with Autonomous Story Count
- **Current Defect:** Forcing every source video into 3 parts totaling ~240–270s forces 40% filler and dead air on short source stories.
- **New Architecture:**
  1. **Source Valuation:** Gemini evaluates the total duration of active confrontation (`T_active`).
  2. If `T_active < 180s`: Output exactly ONE high-density standalone viral short (60–80s).
  3. If `T_active >= 180s`: Output two self-contained chapters with independent payoffs, never a diluted 3-part series unless source is a multi-hour standoff.
- **Implementation:** Integrated into `electron/services/storyScopeService.js` and `electron/services/seriesPlanService.js`.

### 2.2 Formal State Tracking: Open Loops & Chronology Modes
- **Implementation:** Incorporate `directorBeat` schema from `editorialDirectorService.js`:
  - `chronologyMode`: `teaser`, `rewind`, `chronological`, `callback`.
  - Every teaser hook MUST be paired with an explicit `rewind` beat that bridges back to the catalyst with clear temporal context (e.g., *"Twenty minutes earlier..."*).
  - Track `viewerStateBefore`, `viewerStateAfter`, and `openLoopDelta`.
- **Downstream Protection:** Downstream JS compilers are strictly prohibited from trimming, re-ordering, or extending beats produced by the Editorial Director.

### 2.3 Smart 9:16 Vertical Cropping & Watermark Exclusion
- **Current Defect:** 16:9 video placed in a blurred pillarbox canvas with visible YouTube channel watermarks.
- **Implementation:** Add an automated smart-crop filter in FFmpeg that isolates the active subject (driver/officer) in full 1080x1920 portrait format and crops out bottom third YouTube subtitles.

---

## 3. PHASE 3: LOCALIZATION & POLISH (P2 - SYSTEM REFINEMENTS)

### 3.1 Domain-Specific Legal Glossary for Video Subtitling
- Add an enforcement dictionary to `electron/services/localTranslationService.js`:
  ```json
  {
    "deputy": "sĩ quan cảnh sát / cảnh sát viên",
    "deputies": "các sĩ quan cảnh sát",
    "booked": "làm thủ tục tạm giữ / ghi sổ bắt giữ",
    "bond": "tiền bảo lãnh tại ngoại",
    "misuse of 911": "lạm dụng số khẩn cấp 911",
    "non-emergency": "đường dây không khẩn cấp"
  }
  ```

### 3.2 Automated Outro Banning
- Forbid any candidate selector or beat compiler from selecting footage within the final 15 seconds of a YouTube source video to prevent capturing split-screen end cards and "Subscribe" prompts.

---

## 4. VERIFICATION & ACCEPTANCE TEST PLAN

| Test ID | Target Component | Acceptance Criteria | Execution Method |
|---|---|---|---|
| **TEST-01** | `hookAuditionService` | No candidate receives "barricaded door" on non-barricade footage | Unit test in `tests/hookSelection.test.js` |
| **TEST-02** | `dubbingService` / Mixer | Zero decibel source audio leakage during `voiceover_only` | FFmpeg audio silence audit |
| **TEST-03** | `editorialDirector` | Full EDL compilation produces valid open loops and zero circular beats | `node tests/editorialDirector.test.js` |
| **TEST-04** | Benchmark A/B/C/D | Experiment D achieves score >= 90 on blind editorial evaluation | Run benchmark suite |
