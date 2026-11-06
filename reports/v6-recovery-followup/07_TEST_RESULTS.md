# TEST SUITE & VERIFICATION RESULTS — V6 RECOVERY FOLLOW-UP

This report documents the verification across unit tests, regression suites, and end-to-end multi-pass benchmarks.

---

## 1. Test Execution Summary

| Test Suite / Phase | Command Executed | Tests Passed | Tests Failed | Skipped | Status |
|---|---|---|---|---|---|
| **Stage A Regression Suite** | `node --test tests/v6RecoveryFollowup.test.js` | 10 | 0 | 0 | **PASS** |
| **Story Scope Architecture** | `node tests/storyScopeArchitecture.test.js` | 61 | 0 | 0 | **PASS** |
| **Delivery Blocks System** | `node tests/deliveryBlocks.test.js` | 29 | 0 | 0 | **PASS** |
| **V4 Production Repair** | `npm run test:v4-production` | 13 | 0 | 0 | **PASS** |
| **AutoStory Core Tests** | `npm run test:auto-story` | Suite | 0 | 0 | **PASS** |
| **TypeScript / Linter Check** | `npm run check` | Checked | 0 | 0 | **PASS (exit code 0)** |
| **Stage B Benchmark (E2E)** | `node tools/run-v6-followup-benchmark.js --mode both` | 2 MP4s rendered | 0 | 0 | **PASS (Both A & B)** |
| **Stage C Generalization** | `node tools/run-v6-secondary-sources.js` | 4 sources | 0 | 0 | **PASS** |

---

## 2. Stage A Regression Scenarios (13 Required Scenarios)

1. **Scenario 1 (Frame 2393 Outro Intrusion & 0.95s Dead Air):**
   - Verified that `runFinalQualityGate` detects Frame 2393 split-screen outro intrusion and flags tail silence dead air > 0.8s.
   - Result: `OUTRO_INTRUSION_DETECTED` and `TRAILING_AUDIO_SILENCE` are correctly raised as blocking findings when outro frames are present.
2. **Scenario 2 (EDL Boundary Validator):**
   - Verified that any EDL beat extending past `liveActionEndSec` (529.83s) is rejected back to the Director with `EDL_BEAT_EXCEEDS_LIVE_ACTION_BOUNDARY`.
   - Verified that `uncertain: true` boundaries prevent automatic PASS.
3. **Scenario 3 (Cache Invalidation):**
   - Verified that stale v1 boundary metadata (`version: 1`) is discarded and cache automatically refreshes when `sourceFingerprint` changes.
4. **Scenarios 4 & 9 (QA Binding & Draft Isolation):**
   - Verified that `runFinalQualityGate` strictly requires `1080x1920` for Production Final and rejects 540x960 fast drafts with `DIMENSIONS_MISMATCH`.
   - Verified that altering a single byte in the rendered MP4 immediately invalidates the QA cryptographic SHA-256 binding (`bindingValid: false`).
5. **Scenarios 5 & 6 (Visual Ownership & Anti-Deletion Gate):**
   - Verified that when active dialogue occurs in source footage, the compiler re-targets narration to clean B-roll / establishing windows rather than deleting narrator blocks.
   - Verified that the Director repair loop cannot drop narrator share below threshold or drop high-impact iconic quotes.
6. **Scenario 7 (Anti-Spoiler & Hook Title Verification):**
   - Verified that narrator text containing verbatim punchline leaks (e.g. "She argues that being rude isn't illegal") is rejected by `validateNarratorPunchlineLeaks`.
   - Verified that Hook titles with unverified claims or high similarity to reference titles (`jaccard > 0.60`) are rejected.
7. **Scenario 8 (Narrative Expansion & Native Full-HD Clip Cache):**
   - Verified that closing narrator blocks shorter than 8 words trigger advisory expansion.
   - Verified that Production Final uses native Full-HD clip caching without proxy re-encoding.
8. **Scenarios 10 & 11 (Non-911 Generalization & False-Positive Control):**
   - Verified that `detectSourceEndingBoundary` correctly handles non-911 videos with outros at different timestamps (e.g. 698.1s) and reports `hasOutro: false` on clean reference footage (`va.mp4`) without trimming live action.
9. **Scenario 12 (Physical Closing / Transition B-Roll):**
   - Verified that ducked narration over physical transition footage (e.g. closing cruiser doors) is permitted while preventing overlap with substantive character speech.
10. **Scenario 13 (Vertex AI 10-File Limit & Master Audio Limiter):**
    - Verified that `selectNarrationEvidence` caps attached video clips to `<= 10` files to stay within Vertex AI multimodal token limits.
    - Verified that FFmpeg `fitDubbingClusterAudio` room-tone settle and `alimiter=0.82` pass Technical Final QA.

---

## 3. Source Coverage & Generalization Evidence

| Video Source ID | Duration | Content Type | Boundary Behavior |
|---|---|---|---|
| `source-m6ow9dqxqcg` | 549.74s | Stalled car 911 police bodycam (Primary benchmark) | Outro detected at 530.03s; live-action safely capped at 529.83s. Zero outro frames in final 74.4s MP4. |
| `source-cqf2r254dy8` | 743.75s | Police bodycam with sentencing title card | Outro detected at 698.125s; live action capped at 697.93s (`confidence: 0.93`). |
| `source-ualmmh8bb4g` | 652.25s | Police bodycam with channel commentary wrap-up | Detected no outro in bodycam media; preserved live action (`liveActionEndSec: 652.25s`). |
| `source-5ztfoq-8rs0` | 2095.96s | Full-HD true crime case | Detected recap outro at 2060.833s; capped live action at 2060.63s. |
| `va.mp4` | 107.37s | Curated true crime reference (False-positive control) | Reported `hasOutro: false`; 100% of live-action preserved without artificial trimming. |

---

## 4. Test Suite Limitations
- **Evaluation Model Diversity:** Multimodal evaluation currently relies on Google Vertex AI Gemini 3.8 Flash / Pro models. While anti-bias safeguards (blind shuffling, anonymous IDs, stripped prompt metadata) are enforced, results reflect this model family's evaluation criteria.
- **Hardware Acceleration:** Tests ran on Windows x64 with software/NVENC FFmpeg fallback. Audio normalization and render times reflect local workstation CPU/GPU capabilities.
