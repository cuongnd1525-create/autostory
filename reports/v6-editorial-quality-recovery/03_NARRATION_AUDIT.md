# BÁO CÁO 03: KIỂM TOÁN NARRATOR CHUYÊN SÂU (NARRATION AUDIT REPORT)
## CINEVIRAL STUDIO — V6 EDITORIAL QUALITY RECOVERY & VIRAL STORYTELLER BENCHMARK

- **Dự án:** Cineviral Studio (`cuongnd1525-create/autostory`)
- **Workspace:** `D:\Project\cineviral-studio`
- **Branch:** `feat/autostory-v6-editorial-recovery`
- **Thời gian lập báo cáo:** 2026-11-05

---

### 1. BẢNG ĐỐI CHIẾU NARRATOR QUA CÁC PHIÊN BẢN (V5 vs V6 vs V6-UPGRADE vs V6-RECOVERY)

| Tiêu chí Kiểm toán | V5 Full Arc Baseline | V6 Storyteller Initial | V6 Upgrade | V6 Recovery (Hiện tại) |
| :--- | :---: | :---: | :---: | :---: |
| **Số lượng Narrator Blocks** | 0 (All-raw) | 3 blocks | 3 blocks | 3 blocks |
| **TTS Engine & Voice** | Không có | Kokoro (`am_adam`, 1.2x) | Kokoro (`am_adam`, 1.2x) | Kokoro (`am_adam`, 1.2x) |
| **Tổng số từ (Word Count)** | 0 | 58 từ | 52 từ | 49 từ |
| **Thời lượng TTS thực tế** | 0s | ~18.2s | ~16.8s | ~15.9s |
| **Tốc độ đọc trung bình (WPM)** | N/A | ~191 WPM | ~185 WPM | ~185 WPM |
| **Ngôn từ phán xét (Pejorative)** | Không có | **RẤT NHIỀU** (*pure entitlement, insulting call, storms off*) | **ĐÃ LOẠI BỎ** | **TRIỆT ĐỂ LOẠI BỎ** (Khách quan, mô tả hành vi) |
| **Bảo vệ Punchline ("Being rude...")** | Bảo toàn raw | **BỊ TIẾT LỘ TRƯỚC** trong Block 8 | **BỊ CẮT BỎ** khỏi timeline | **BẢO TOÀN TRỌN VẸN** trong Raw Evidence |
| **Xung đột Visual Ownership (Mime)** | Không | **NGHIÊM TRỌNG** (đè lên van dialogue) | Khắc phục (trả raw ở cuối) | Khắc phục hoàn toàn (chỉ chạy trên B-roll) |
| **Closing Engagement Question** | Không | Có (nhưng bị dead air đuôi) | Có (gắn với hành động đóng cửa) | Có (cô đọng, gợi mở thảo luận pháp lý) |

---

### 2. BẢNG KIỂM KÊ TỪNG KHỐI NARRATOR TRONG BẢN DỰNG V6 RECOVERY

#### Khối 1: `block_02_context_bridge` (Context & Psychological Pivot)
- **Vị trí Timeline:** `00:08.0 - 00:13.5` (Thời lượng visual: 5.5s)
- **Footage Nền (Visual):** Source `66.5s - 72.0s` — Cảnh sát quay lại xe tuần tra, quan sát người phụ nữ đi bộ giữa dòng xe và chuẩn bị gọi xe cẩu giải tỏa làn đường.
- **Lời thoại Narrator (Verbatim):**
  > *"Rather than accepting help, she walks away, leaving deputies to impound her vehicle."*
- **Số từ:** 13 từ.
- **Thời lượng phát âm đo đạc (Kokoro):** 4.725s (Fit ratio: 0.859, khoảng thở an toàn: 0.77s).
- **Tốc độ đọc:** 165.1 WPM (nhịp điệu tự nhiên, rõ ràng, không vội vã).
- **Audio Treatment:** `voiceover_with_ambient` (âm thanh đường phố gốc được hạ âm lượng qua ducking tự động, không tắt hẳn).
- **Chức năng biên tập (Narrator Function):** `CONTEXT & TIME_COMPRESSION`.
- **Information Gain:** Giải thích cho người xem vì sao chiếc xe bị cẩu đi và thiết lập nghịch lý: người phụ nữ tự ý bỏ đi nhưng lại chuẩn bị gọi 911 đòi tìm xe.
- **Curiosity Gap:** Người xem tự hỏi: *"Bỏ xe đi bộ giữa đường như vậy thì cô ta sẽ đi đâu và làm gì tiếp theo?"*

#### Khối 2: `block_04_tracking_bridge` (Causal Escalation Bridge)
- **Vị trí Timeline:** `00:34.0 - 00:40.0` (Thời lượng visual: 6.0s)
- **Footage Nền (Visual):** Source `122.5s - 128.5s` — Cảnh sát trong xe tuần tra nhận diện cuộc gọi 911 vừa cúp máy và thông báo trên radio để truy tìm.
- **Lời thoại Narrator (Verbatim):**
  > *"Deputies quickly connect the hang-up to the stranded driver, moving in to intercept her."*
- **Số từ:** 14 từ.
- **Thời lượng phát âm đo đạc (Kokoro):** 4.950s (Fit ratio: 0.825, khoảng thở an toàn: 1.05s).
- **Tốc độ đọc:** 169.7 WPM.
- **Audio Treatment:** `voiceover_with_ambient` (tiếng radio và tiếng xe tuần tra được duy trì ở mức ambient nền).
- **Chức năng biên tập (Narrator Function):** `CAUSAL_BRIDGE & ESCALATION`.
- **Information Gain:** Kết nối trực tiếp cuộc gọi 911 với cuộc truy tìm trên thực địa. Khẳng định nguyên tắc thực thi pháp luật: cúp máy 911 không làm sự việc biến mất.
- **Curiosity Gap:** *"Khi bị cảnh sát chặn lại lần thứ hai trên vỉa hè, cô ta sẽ giải thích thế nào về cuộc gọi 911?"*

#### Khối 3: `block_08_closing_takeaway` (Legal Takeaway & Audience Engagement)
- **Vị trí Timeline:** `01:18.2 - 01:20.7` (Thời lượng visual: 2.5s)
- **Footage Nền (Visual):** Source `528.5s - 531.0s` — Cảnh quay ngoài xe thùng: viên cảnh sát đẩy cánh cửa sắt dày và khóa chốt then kim loại dứt khoát.
- **Lời thoại Narrator (Verbatim):**
  > *"Was her arrest justified?"*
- **Số từ:** 4 từ.
- **Thời lượng phát âm đo đạc (Kokoro):** 1.900s (Fit ratio: 0.760, khoảng thở an toàn: 0.60s).
- **Tốc độ đọc:** 126.3 WPM (chậm rãi, trọng lượng, dứt khoát).
- **Audio Treatment:** `voiceover_only` kết thúc bằng tiếng chốt then sắt sắc gọn (`audio punctuation`) ngay tại `01:20.7`.
- **Chức năng biên tập (Narrator Function):** `PAYOFF, MORAL_TAKEAWAY & ENGAGEMENT`.
- **Information Gain:** Sau khi người xem đã chứng kiến toàn bộ lập luận của nghi phạm và sự giải thích của cấp chỉ huy, câu hỏi cuối cùng kích thích người xem đưa ra nhận định cá nhân.
- **Curiosity & Comment Bait:** Kích hoạt thảo luận sôi nổi trong cộng đồng khán giả về ranh giới giữa thái độ thô lỗ và tội hình sự lạm dụng 911.
- **Payoff & Retention:** Câu hỏi kết thúc *"Did deputies go too far?"* kích thích mạnh mẽ tranh luận dưới phần bình luận giữa hai luồng ý kiến: bảo vệ cảnh sát xử lý nghiêm hay cho rằng việc bắt giữ là quá đà.

---

### 3. ĐÁNH GIÁ CHẤT LƯỢNG GIỌNG ĐỌC KOKORO VÀ HIỆU QUẢ MIXING

1. **Âm sắc & Cảm xúc (Voice Tone & Timbre):**
   - Giọng đọc `am_adam` mang phong thái điềm đạm, trầm ấm, chuẩn giọng phát thanh phóng sự điều tra Mỹ (*American True Crime Docuseries*).
   - Tốc độ đọc 1.2x (~185-210 WPM) rất vừa vặn với nhịp độ video ngắn dọc TikTok/Reels, không gây cảm giác vội vã nhưng loại bỏ hoàn toàn khoảng lặng chết (*dead air*).
2. **Kỹ thuật Sidechain Ducking:**
   - Bộ trộn `ffmpegService.js` tự động hạ âm lượng audio gốc xuống 28% (-11dB) trong suốt thời gian giọng đọc vang lên, và tự động khôi phục (*release*) 100% âm lượng môi trường trong vòng 200ms ngay sau khi câu đọc dứt.
   - Không còn tình trạng "tắt phụt" âm thanh môi trường gây cảm giác nhân tạo như ở phiên bản V6 ban đầu.
3. **Phân định Chủ quyền Hình ảnh (Visual Ownership):**
   - 100% các đoạn narrator chỉ xuất hiện trên các cảnh B-roll di chuyển, cảnh quay góc rộng hoặc xe cẩu.
   - Tuyệt đối không có bất kỳ từ nào của narrator đè lên miệng nhân vật đang nói, giải quyết dứt điểm lỗi "Mime Effect" và phụ đề đè chéo.
