# Báo cáo: Hook Contract authority & V4 EDL acceptance

Nhánh `fix/autostory-hook-authority-v4-acceptance` (từ `feat/autostory-v4-ui-engine` @ a70dd6d). Chưa merge, chưa push.
Dữ liệu máy đọc được: `D-acceptance-audit.json` (tạo lại bằng `tools/audit-d-acceptance.js`), `hook-contract-before-after.json`.

## 1. Nguyên nhân gốc (đã kiểm chứng)

### RC-A — Hook tự động bị trình bày như mệnh lệnh của người dùng
- `electron/services/hookContractService.js`
  - `injectHookContractToPrompt` / `buildSeriesHookContractBlock` không đọc `isUserLocked`. Chúng luôn in "USER-LOCKED ANCHORS" và "Mandate: Script 1 Beat 1 MUST open with this anchor".
  - Nhánh non-series luôn in "SCRIPT 1 MUST use this event" kèm cấu trúc 5 beat.
  - `buildHookContract` mặc định `isUserLocked = true`.
  - `storyDirectives` ("Must be the opening beat") luôn được ghi vào `hook-contract.json`, mà file này lại được đính kèm cho Gemini.
- `electron/services/manualGeminiPackService.js:2635` (Auto Mode) đã truyền `isUserLocked: false`, nhưng prompt vẫn ra mệnh lệnh.
- `electron/services/manualAntigravityStage1Service.js` `buildSeriesPlanPrompt` gắn nhãn mọi hook-contract là "user-locked hook anchors" và bắt "Part 1 hook must be its variant_01 anchor".
- Đính chính benchmark: trong B, `baseline-B/hook-contract.json` thực tế có `isUserLocked: true` (không có trường `userLocked`). File này được tạo qua Hook Picker `confirmHookAndLock` (`src/renderer.js` ~5892). Picker tự điền sẵn 3 slot bằng top[0..2] (`openHookPickerModal`, ~5671–5673). Lỗi nặng thực sự của B là RC-B.

### RC-B — Radar regex/motion tự bịa nội dung sự kiện
- `hookMiningService.js`:
  - mọi action hit có motion ≥ 6.5 được gán `physical_friction`, mô tả "barricade struggle";
  - `mapTriggerToArchetype` biến `physical_friction` hoặc bất kỳ chữ "door" nào thành "Physical Friction / Barricade Suspense".
- `hookAuditionService.generateHookTitle`:
  - archetype chứa "Barricade" hoặc thoại khớp /door|open|rattle/ → "Officer repeatedly struggles with barricaded door";
  - ngoài ra còn bịa câu thoại `Suspect: "That's not my child"` và "Officer draws weapon at point blank".
- Đã tái hiện: với 3 range của B, phiên bản cũ cho cả 3 cùng tiêu đề barricade (xem mục 4).

### RC-C — "68s target vs 122s EDL" của Experiment D: lỗi báo cáo, không phải lỗi pipeline
- Cấu hình thật trong `project.json` autoStoryConfig: hard range **65–150s**, `editorialArchitecture: scope_media_director`.
- Story Scope target 110s, preferred band 107–113s.
- Lần director đầu (86.5s, teaser–rewind) bị media critic loại (`hook_spends_payoff`, `opening_lacks_curiosity`, …).
- Repair pass 1:
  - attempt 0 vi phạm `OUTSIDE_SCOPE_REEL` và `ENDING_NOT_IN_SCOPE`;
  - attempt technical hợp lệ → 122s, 9 beat, chronological.
- Critic chấp nhận. EDL được persist vào `story-spine.json`. `script-1.json` và draft (122.034s) giữ đúng thứ tự và range.
- Số "68s" trong benchmark chính là `reel_03.durationSec`. "122.0s Reel" và `totalReelSec: 184.5` cũng sai (reel thật 321s).
- Khoảng trống thật trong code:
  - acceptance chỉ dựa trên `critique.isCompliant`;
  - không ghi trạng thái ACCEPTED/REJECTED/NEEDS_EDITORIAL_REVIEW;
  - tại thời điểm chấp nhận không kiểm tra lại render so với EDL, cũng như thứ tự script so với EDL;
  - không ghi lại việc 122s nằm ngoài preferred band.

## 2. File đã thay đổi
| File | Thay đổi |
|---|---|
| `hookContractService.js` | Mặc định `isUserLocked=false`. Prompt và `storyDirectives` phụ thuộc vào `isUserLocked === true`. Contract tự động dùng khối "AUTOMATIC RADAR CANDIDATES – ADVISORY, NOT USER-LOCKED": không ép Beat 1, cho cả chronological lẫn teaser-rewind, teaser sự kiện muộn chỉ khi không tiêu payoff. Văn bản của hook đã khóa giữ nguyên. Bỏ 2 ví dụ đặc thù vụ án ("96 mph", "passenger/pet"). |
| `hookMiningService.js` | Action hit → `action_radar` ("Motion/audio radar spike …; content not verified"). Mô tả regex chỉ còn nói chuyện "Transcript: …". Không còn archetype "Barricade" tự động. Thêm `provenance: deterministic_radar`, `semanticStatus: unverified`. |
| `hookAuditionService.js` | Tiêu đề chỉ chứa bằng chứng: `Transcript: "<câu khớp>"` hoặc `Motion/audio spike at mm:ss`. Rationale trung tính. Điểm số và thứ hạng không đổi. |
| `manualAntigravityStage1Service.js` | Series Plan đọc `isUserLocked` từ hook-contract.json. Chỉ khi đã khóa mới bắt variant_01 làm hook Part 1. |
| `editorialDirectorService.js` | Thêm `acceptanceReport()` thuần (read-only). Kiểm tra: tổng beat thật so với hard min/max, grounding theo reel đã xem, trùng lặp, hook role, ending, delivery blocks, thứ tự/range trong script, độ dài render (±1s), verdict critic (scope, câu hỏi trung tâm, ending là hệ quả, footage dùng được). Ra ACCEPTED / REJECTED / NEEDS_EDITORIAL_REVIEW. Báo lệch preferred band nhưng không loại. |
| `autoStoryV3Pipeline.js` (`auditDirectorDraft`) | Chỉ PASS khi `ACCEPTED`. Lỗi chỉ về duration → vòng repair có giới hạn (runDirector trả vi phạm về Gemini). Lỗi render, thứ tự hoặc grounding → dừng, ghi lại, không tốn call. Ghi `initial-acceptance-N.json`, `repair-N-acceptance-N.json` và `acceptanceStatus` trong `review-state-N.json`. Spine được chấp nhận có tem `acceptance`. Không pad, cắt hay đổi thứ tự. |
| `tests/hookAuthority.test.js` (mới) | Car door ven đường, barricade thật (người khóa), spike chỉ có motion, footage muộn không bị cấm, Series Plan theo lock, không có text đặc thù. |
| `tests/directorAcceptance.test.js` (mới) | 122s bị loại ở 65–90 nhưng hợp lệ ở 65–150, beat dài, chronological và teaser-rewind, technical PASS ≠ editorial PASS, ngoài reel, trùng lặp, đổi thứ tự, pad render, thiếu provenance. |
| `tests/hookAudition.test.js` | Ca khóa truyền `isUserLocked: true` tường minh (đúng như `lockHookContract`). |
| `tests/storyScopeArchitecture.test.js` (H) | Mock probe trả độ dài draft thật (76s/78s) thay vì cố định 72s. |
| `package.json` | Thêm các test mới vào `test` và `test:v4-production`. |

## 3. Kết quả test (VM Linux)
- PASS: 78/82 file test trong `test`, `test:auto-story`, `test:v4-production` và `test:vertex`, gồm hookAuthority, directorAcceptance, hookAudition, seriesPlan, storyScopeArchitecture (61/61), editorialDirector, autoStoryV3Routing, autoStoryV4Ui, v3AcceptanceAssertions, manualAntigravityStage1Service, sourceUnderstanding*.
- FAIL đã có sẵn ở HEAD (không do thay đổi này):
  - `manualGeminiPackService` (path Windows `C:\video\input.mp4` trên Linux);
  - `ffmpegVideoDecoration`;
  - `v4StoryStructureGeneralization` (Domestic Disturbance structural critic);
  - `autoStoryV4ProductionRepair` (Test 1–10 pass, sau đó cần mạng Edge TTS mà VM không có).

## 4. Prompt Hook Contract trước/sau
Dùng transcript thật và 3 range action của B (Auto Mode, `isUserLocked:false`).

Trước:
```
SERIES HOOK CONTRACT (USER-LOCKED ANCHORS FOR ONE 3-PART STORY)
PART 1 (Script 1) cold-open hook anchor: "Officer repeatedly struggles with barricaded door" (Physical Friction / Barricade Suspense)
   - Source Time Range: 62.000s - 82.000s (~20.0s)
   - Mandate: Script 1 Beat 1 MUST open with this anchor.
```
Danh sách ứng viên trước: 62–82, 278–294 và 322–340 đều là "Officer repeatedly struggles with barricaded door".

Sau:
```
SERIES HOOK CONTRACT (AUTOMATIC RADAR CANDIDATES - ADVISORY, NOT USER-LOCKED)
These anchors were proposed automatically by a deterministic transcript/motion radar. Nobody has confirmed them.
Their titles and categories are search hints, NOT verified descriptions of the footage. Do not repeat them as facts.
Watch the footage yourself. Use a candidate only if what is seen and heard there supports it; otherwise ignore it.
No candidate has to be Beat 1. Open on the strongest verified moment: a chronological opening and a teaser-then-rewind are both valid.
A later moment may be teased only if it raises a real unanswered question without giving away the payoff.
PART 1 (Script 1) radar candidate: "Motion/audio spike at 01:02" (Unverified Motion/Audio Spike)
   - Source Time Range: 62.000s - 82.000s (~20.0s)
   - Status: automatic radar candidate (advisory, not a mandate).
```
Hook do người dùng khóa vẫn giữ nguyên "USER-LOCKED" và "Mandate", có test.

## 5. Báo cáo acceptance của Director EDL (Experiment D)
| EDL | Tổng | 65–150 (cấu hình thật) | 65–90 | Critic | Kết luận |
|---|---|---|---|---|---|
| Director ban đầu | 86.5s | hợp lệ (ngoài band) | hợp lệ | FAIL | bị loại ở bước editorial |
| Repair pass 1 (cuối) | 122.0s | hợp lệ, ngoài band 107–113 | **TOTAL_DURATION_OVER_MAX** | PASS | ACCEPTED ở 65–150; sẽ REJECTED ở 65–90 |

Gate mới chạy trên artifact thật:
- ở 65–150: `ACCEPTED`, render lệch 0.03s, thứ tự giữ nguyên;
- ở 65–90: `REJECTED` (`TOTAL_DURATION_OVER_MAX`).

## 6. Timeline nguồn cuối (đã chấp nhận) — 122.0s
| beat | nguồn | dài | vai trò |
|---|---|---|---|
| 01 | 35–45 | 10 | cold_open_hook |
| 02 | 45–63 | 18 | setup |
| 03 | 63–72 | 9 | complication |
| 04 | 117–122 | 5 | escalation |
| 05 | 122–131 | 9 | crisis_context |
| 06 | 268–278 | 10 | confrontation |
| 07 | 278–288 | 10 | reveal |
| 08 | 288–320 | 32 | payoff |
| 09 | 435–454 | 19 | resolution |

Toàn bộ beat là chronological và nằm 100% trong reel đã xem. `script-1.json` có 9 segment giống hệt, speed 1. Draft dài 122.034s.

## 7. API, cache, thời gian (run D, UTC 2026-11-03)
| Call | Input tok | Output tok | modelMs | prepareMs | USD |
|---|---|---|---|---|---|
| v3-source-model | 120,584 | 2,487 | 41,183 | 5,236 | 0.0998 |
| v5-story-scope | 4,190 | 4,553 (gồm 2,081 thoughts) | 37,620 | 0 | 0.0202 |
| v5-editorial-director-1 | 63,316 | 3,452 | 32,316 | 7,188 | 0.0604 |
| director-repair-1-1 (attempt 0) | không lưu | – | – | – | – |
| director-repair-1-1_fix1 | 67,152 | 3,366 | 26,472 | 940 | ≈0.063 (ước tính) |
| scope critic ×2 | không ghi trong run-costs | – | ~41s / ~44s (theo timestamp) | – | – |

- Cache hit: 0. `run-costs.json` ghi mọi call với `cached:false`.
- Tổng thời gian: 1,343s (04:07:47 → 04:30:10).
  - Source model xong lúc 04:18:04.
  - Director xong 04:21:12.
  - Render 1: 04:23:58.
  - Critic 1: 04:24:39.
  - Repair: 04:26:11.
  - Render 2: 04:29:26.
  - Critic 2: 04:30:10.
- Thay đổi này không thêm call AI nào ở luồng thành công. Gate acceptance chạy thuần JS. Test trong phiên này dùng 0 call API.

## 8. Việc cần người xem xét
1. **Chưa chạy được V4 isolated live run.** Proxy của VM trả 403 cho `aiplatform.googleapis.com`, và credential Vertex phải ở lại máy người dùng. Cách chạy:
   - trong app, tạo project **mới** từ `source-m6ow9dqxqcg.mp4` (không dùng lại 1011-01-c50a1488), chọn V4, 1 output;
   - sau khi chạy, kiểm tra `review-state-1.json.acceptanceStatus`, `initial-acceptance-1.json` và `repair-*-acceptance-1.json`;
   - draft cũ không bị đụng tới.
2. Hook Picker: bấm "Xác nhận" với slot tự điền sẵn hiện vẫn tính là user-locked. Có cần cờ "người dùng đã chọn slot này" không? Đây là quyết định sản phẩm.
3. Critic-driven repair có thể kéo dài tới gần hard max mà không có áp lực về preferred band (86.5 → 122s, band 107–113). Giờ việc này đã được ghi lại (`insidePreferredBand:false`) nhưng không bị chặn. 122s có quá dài không là phán đoán biên tập.
4. Critic call và repair attempt 0 không được ghi vào `run-costs.json`, nên chi phí thực bị báo thiếu.
5. `storyDirectives` của hook đã khóa vẫn áp cấu trúc rewind 5 beat (`non_linear_rewind`). Phần này giữ nguyên theo yêu cầu bảo toàn hành vi.
6. Các tài liệu benchmark cũ (manifest, blind-evaluation, D JSON) chứa số liệu sai. Chưa sửa vì là lịch sử; `D-acceptance-audit.json` ghi lại đính chính.
7. Hướng dẫn prompt về "Barricade" trong manualGeminiPackService, geminiDraftReviewService và autoStoryHookSelection là chỉ dẫn biên tập cho Gemini (Gemini tự xem footage). Chưa đổi.
