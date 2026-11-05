# BÁO CÁO 05: SO SÁNH ĐA CHIỀU CÁC PHIÊN BẢN (BENCHMARK COMPARISON)
## CINEVIRAL STUDIO — V6 EDITORIAL QUALITY RECOVERY & VIRAL STORYTELLER BENCHMARK

- **Dự án:** Cineviral Studio (`cuongnd1525-create/autostory`)
- **Workspace:** `D:\Project\cineviral-studio`
- **Branch:** `feat/autostory-v6-editorial-recovery`
- **Thời gian lập báo cáo:** 2026-11-05

---

### BẢNG ĐỐI CHIẾU THÔNG SỐ VÀ CHẤT LƯỢNG 5 VIDEO BENCHMARK

| Tiêu chí | Reference `va.mp4` | V5 Full Arc Baseline | V6 Storyteller Initial | V6 Upgrade | V6 Recovery (Hiện tại) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Tệp MP4** | `C:\Users\Admin\Videos\va.mp4` | `D:\Video\v5-full-arc-benchmark-1104-final.mp4` | `D:\Video\v6-storyteller-benchmark-1104-final.mp4` | `D:\Video\v6-upgrade-storyteller-benchmark-final.mp4` | `D:\Video\v6-recovery-storyteller-benchmark-final.mp4` |
| **Độ phân giải** | 720 × 1280 (Dọc 9:16) | 540 × 960 (Draft) | 540 × 960 (Draft) | 540 × 960 (Draft) | **1080 × 1920 (Production Final)** |
| **Khung hình (FPS)** | 30.00 fps | 30.00 fps | 30.00 fps | 30.00 fps | **30.00 fps (CFR)** |
| **Thời lượng (Duration)** | 107.37s | 85.77s | 82.03s | 79.37s | **79.40s (Chuẩn 75–85s)** |
| **Âm lượng Integrated Loudness** | -21.0 LUFS | -15.3 LUFS | -13.8 LUFS | -13.8 LUFS | **-14.0 LUFS (EBU R128 Master)** |
| **True Peak** | -1.5 dBTP | -1.0 dBTP | -0.8 dBTP | -0.8 dBTP | **-1.0 dBTP (Limiter chuẩn)** |
| **Top Caption Title Card** | **CÓ** ("24yo Abuses 911 Then Gets a Realty Check...") | Không | Không | Không | **CÓ** ("24yo Abuses 911 Then Gets a Reality Check...") |
| **Nền Canvas** | Blur 9:16 background | Blur 9:16 | Blur 9:16 | Blur 9:16 | **Blur 9:16 (High Quality)** |
| **Tỷ lệ Narrator / Raw** | All Raw (0% Narrator) | All Raw (0% Narrator) | 22% Narrator / 78% Raw | 21% Narrator / 79% Raw | **20% Narrator / 80% Raw (Cân bằng vàng)** |
| **Punchline "Being rude..."** | Có (phút 01:15) | **BẢO TOÀN** (`455.5-461.5s`) | Bị narrator spoil trước | **BỊ CẮT BỎ** (thiếu budget) | **BẢO TOÀN TRỌN VẸN** (`454.5-463.5s`) |
| **Supervisor Payoff** | Có | Có | Bị phủ voiceover | Có | **CÓ ĐẦY ĐỦ** (`485.2-492.5s`) |
| **Xung đột Visual Ownership** | Không | Không | **LỖI NẶNG** (kịch câm / phụ đề xanh) | Đã sửa (trả raw) | **HOÀN THIỆN** (chỉ phủ trên B-roll) |
| **Ending Visual Cut** | Cut tại cửa xe đóng | Cut đột ngột | **LỖI NẶNG** (văng vào outro 3 ô) | Dừng tại 529.8s (cửa đóng) | **DỪNG ĐỘNG** (tự động nhận diện ranh giới) |
| **Đuôi âm thanh (Tail Audio)** | Tự nhiên | Tự nhiên | **LỖI NẶNG** (digital dead air 2s) | Có ambient bed | **CHỐT THEN SẮT** (Audio punctuation sắc sảo) |
| **Bản dựng Render** | Production | Fast Draft copy | Fast Draft copy | Fast Draft copy | **TRUE PRODUCTION FINAL EXPORT** |

---

### PHÂN TÍCH ƯU THẾ VƯỢT TRỘI CỦA V6 RECOVERY

1. **So với Reference `va.mp4`:**
   - `va.mp4` kéo dài 107.37s và hoàn toàn là raw dialogue, phụ thuộc 100% vào sự kiên nhẫn của người xem để theo dõi từng câu thoại chậm chạp.
   - `v6-recovery` giải quyết trọn vẹn câu chuyện chỉ trong 79.4 giây (ngắn hơn 28 giây nhưng không mất bất kỳ tình tiết cốt lõi nào) nhờ sử dụng 2 khối narrator chuyển tiếp (`block_2` nén cảnh đi bộ, `block_4` bắc cầu cuộc truy tìm).
   - V6 Recovery tích hợp Top Caption Title Card bắt mắt không thua kém `va.mp4`, đồng thời bổ sung câu hỏi bình luận (*call-to-action engagement*) ở cuối mà `va.mp4` không có.

2. **So với V5 Baseline:**
   - V5 có câu chuyện đầy đủ nhưng thiếu giọng dẫn chuyện chuyên nghiệp, nhịp điệu giữa các đoạn chuyển cảnh bị rời rạc do phụ thuộc hoàn toàn vào footage thô.
   - V6 Recovery vừa giữ trọn vẹn câu phản biện đắt giá của V5 ("Being rude is not illegal"), vừa bổ sung lớp dẫn truyện lôi cuốn của Kokoro TTS, giúp người xem nắm bắt ngay bối cảnh pháp lý mà không bị ngợp.

3. **So với V6 Initial và V6 Upgrade:**
   - Khắc phục hoàn toàn 4 vấn đề P0: Không còn ngôn từ phán xét; không còn spoil punchline; không còn kịch câm đè phụ đề; không còn hardcode `529.8s`; và chấm dứt việc lấy file draft 540x960 gán nhãn final.
   - Bản xuất xưởng là video độ phân giải cao 1080x1920 sắc nét, âm thanh chuẩn EBU R128 (-14 LUFS) đạt tiêu chuẩn phát hành đa nền tảng (TikTok, YouTube Shorts, Facebook Reels).
