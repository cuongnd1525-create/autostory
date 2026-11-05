# BÁO CÁO 06: KẾT QUẢ KIỂM THỬ TỰ ĐỘNG (AUTOMATED TEST RESULTS)
## CINEVIRAL STUDIO — V6 EDITORIAL QUALITY RECOVERY & VIRAL STORYTELLER BENCHMARK

- **Dự án:** Cineviral Studio (`cuongnd1525-create/autostory`)
- **Workspace:** `D:\Project\cineviral-studio`
- **Branch:** `feat/autostory-v6-editorial-recovery`
- **Thời gian lập báo cáo:** 2026-11-05

---

### TỔNG HỢP KIỂM THỬ HỆ THỐNG

| Test Suite | Số lượng Tests | Trạng thái | Ghi chú |
| :--- | :---: | :---: | :--- |
| `tests/deliveryBlocks.test.js` | 29 | **PASS (29/29)** | Kiểm tra continuous delivery blocks, visual ownership, punchline protection, và ending boundary. |
| `tests/storyScopeArchitecture.test.js` | 61 | **PASS (61/61)** | Kiểm tra toàn bộ kiến trúc Story Scope, dynamic boundary, EDL duration limits, và không có hardcode literal. |
| `sourceEndingBoundaryService` Verification | 2 | **PASS (2/2)** | Kiểm tra phát hiện ranh giới tự động trên 2 nguồn thực tế (`m6ow9dqxqcg` và `bwqdruna5pa`). |

---

### CHI TIẾT CÁC BÀI TEST TIÊU BIỂU

#### 1. `tests/deliveryBlocks.test.js` (29 Passed)
- **Cấu trúc Delivery Block:**
  - `ok - 1. every EDL beat belongs to exactly one delivery block`
  - `ok - 2. non-contiguous beat membership is invalid`
  - `ok - 3. block ordering cannot reorder EDL beats`
- **Tích hợp Giọng đọc & Fit thời lượng:**
  - `ok - 4. narrated_story produces ONE canonical narration passage (compile -> artifact -> import)`
  - `ok - 5. safe word target is based on the WHOLE block; measured TTS fit is authoritative`
  - `ok - 6. raw_evidence remains original audio end to end`
  - `ok - 7. narration-disabled mode: narrated blocks are rejected; all-raw delivery still compiles`
- **Render Primitives & Mux Audio:**
  - `ok - Render primitive: ONE synthesis, ONE fit over the whole block, ONE ducked mix; visual cuts kept at EDL durations`
  - `ok - Render primitive: mux drift gets one deterministic duration correction; only unrecoverable drift fails`
  - `ok - Render primitive: a passage that cannot fit is reported (BLOCK_VOICE_OVERFLOW), never trimmed or dropped`
- **Writer & Guardrails:**
  - `ok - Writer: ONE request covers the block; voice measured ONCE against the whole block`
  - `ok - Writer: advisory word target never blocks a passage whose measured TTS fits`
  - `ok - Writer: voice that cannot fit -> text-only rewrite FIRST; still unfit -> director repair request`
  - `ok - Writer gate: narrated block may compress its OWN source dialogue; redundancy is checked against the NEXT raw handoff`
  - `ok - Writer: the existing narration gates run on the block passage`
- **Critic & Acceptance Gates:**
  - `ok - Critic: delivery issues map to regions + delivery blocks; cold-viewer verdict is enforced`
  - `ok - Critic: prompt inspects the last 3-5 seconds VISUALLY and every transition; transcript is not evidence`
  - `ok - Critic: visual evidence overrides a story-level PASS; transition / opening findings map to delivery blocks for repair`
- **Storyteller & V6 Quality Upgrade:**
  - `ok - V6 Storyteller: expanded narrator functions, commentary hedging, and critic promotion of overlong raw stretches`
  - `ok - V6 Editorial Quality Upgrade: non-judgmental wording, punchline protection, visual ownership, and live-action ending boundary`

#### 2. `tests/storyScopeArchitecture.test.js` (61 Passed)
- **Scope Contract & Limits:**
  - `ok - A/B/C: run() selects Story Scope BEFORE the EDL; director receives the scope and scope-reel MEDIA + manifest`
  - `ok - A: invalid scope goes back to Gemini, never into an EDL`
  - `ok - Scope contract: limits have one source of truth (instruction + validator)`
  - `ok - Scope repair: initial over-limit -> repair with explicit count + failing candidate -> valid repair is returned`
- **Media Packing & Reel Manifest:**
  - `ok - Pack A: 13 logical scopeWindows are a VALID Story Scope`
  - `ok - Pack B/C: 13 logical windows pack into <= provider-limit reel files; manifest maps every segment to exact source time`
  - `ok - Pack D: two distant windows packed into the SAME reel file remain separate logical windows`
  - `ok - Pack G: no EDL beat may map outside the original logical scope windows`
- **Duration Tuning & Repair Primitives:**
  - `ok - Duration A: director aims at Story Scope targetDurationSec band 72-78`
  - `ok - Duration B: 64.6s, duration is the ONLY violation -> technical adjustment >= 65s, no further Gemini call`
  - `ok - Duration C: 64.6s with no safe contiguous extension -> MEDIA-grounded under-min repair`
  - `ok - Compression A: 163.1s OVER_MAX -> compression repair gets required 73.1s, beat budget table`
  - `ok - UNDER_MIN stall D: extension opportunity geometry is exact and JS selects / extends nothing`
- **Kiểm tra Tuyệt đối Không Hardcode (Literal Audit):**
  - `ok - No benchmark-specific literals in production AutoStory code`: Đảm bảo không còn bất kỳ hằng số cố định nào (như `529.8`, `529.85`, hoặc các giá trị riêng của benchmark) xuất hiện trong mã nguồn chính thức.

#### 3. Kiểm chứng Độc lập Module Dynamic Ending Boundary
- **Nguồn 1: `m6ow9dqxqcg` (911 Roadside Confrontation)**
  - Outro cue phát hiện: `533.0s` (*"Thanks for watching! See you on the next ride along."*)
  - Scene cut phát hiện: `scene_0044` bắt đầu tại `530.0s`.
  - Kết quả tính toán ranh giới: `529.8s` (chính xác đến 0.2s trước visual cut).
- **Nguồn 2: `bwqdruna5pa` (Courtroom / Arrest Bodycam)**
  - Outro cue phát hiện: `861.5s` (*"charges were dropped... sentenced to 6 months"*)
  - Scene cut phát hiện: Bắt đầu slide tổng kết tòa án tại `860.4s`.
  - Kết quả tính toán ranh giới: `860.2s`.

**Kết luận:** Hệ thống kiểm thử hoàn toàn xanh (100% PASS), chứng minh các thay đổi vừa triệt để về mặt logic vừa an toàn về mặt kiến trúc.
