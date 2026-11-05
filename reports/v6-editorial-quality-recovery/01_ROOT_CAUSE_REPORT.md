# BÁO CÁO 01: PHÂN TÍCH NGUYÊN NHÂN GỐC RỄ (ROOT CAUSE AUDIT REPORT)
## CINEVIRAL STUDIO — V6 EDITORIAL QUALITY RECOVERY & VIRAL STORYTELLER BENCHMARK

- **Dự án:** Cineviral Studio (`cuongnd1525-create/autostory`)
- **Workspace:** `D:\Project\cineviral-studio`
- **Branch:** `feat/autostory-v6-editorial-recovery`
- **Baseline Commit:** `0fc259c`
- **Thời gian lập báo cáo:** 2026-11-05

---

### TỔNG QUAN HỆ THỐNG VÀ 4 VẤN ĐỀ P0 ĐÃ XÁC ĐỊNH

Sau đợt nâng cấp V6 Upgrade (`0fc259c`), mặc định kiểm thử đơn vị đều vượt qua (29/29 tests PASS), nhưng qua kiểm tra media forensics và audit chuyên sâu độc lập trên video MP4 thực tế (`v6-upgrade-storyteller-benchmark-final.mp4`), hệ thống bộc lộ 4 vấn đề P0 nghiêm trọng:

1. **P0 — Narrator Audit thiếu nghiệm thu đo lường thực tế:**
   Báo cáo V6 Upgrade trước đó không cung cấp bảng kiểm kê chi tiết từng block narrator (thời lượng phát âm thực tế, tốc độ đọc WPM, năng lượng âm học, chức năng biên tập). Điều này tiềm ẩn nguy cơ narrator bị biến thành "phát thanh viên tóm tắt" thay vì một người dẫn chuyện điện ảnh tạo tension và curiosity gap.

2. **P0 — Đánh mất câu thoại đối chất đắt giá ("Being rude is not illegal"):**
   Trong V5 baseline (`v5-full-arc-benchmark-1104-final.mp4`), câu đối chất kinh điển của nhân vật ("Being rude is not illegal" tại mốc source `455.5s - 461.5s`) được giữ trọn vẹn ở chế độ `original_audio`. Nhưng sang V6 Upgrade, đoạn này bị Director cắt bỏ hoàn toàn vì runtime budget bị chiếm dụng bởi các đoạn cảnh bên đường và di chuyển cảnh sát kéo dài tới hơn 27 giây.

3. **P0 — Hardcode ranh giới kết thúc 529.8s trong core logic:**
   Cột mốc `529.8s` (thời điểm cánh cửa xe thùng đóng lại trước khi video YouTube gốc chuyển sang màn hình 3 ô recap) đã bị hardcode trực tiếp vào prompt instruction của `editorialDirectorService.js` (dòng 181) và validator của `storyScopeService.js` (dòng 294). Đây là lỗi kiến trúc nghiêm trọng vì làm hỏng tính tổng quát hóa của hệ thống khi chạy trên các video nguồn khác nhau.

4. **P0 — Fast Draft (540x960) bị gán nhãn thành Production Final:**
   Bản dựng benchmark V6 Upgrade có kích thước 540x960, preset ultrafast, CRF 29, và được sao chép trực tiếp từ `fastDraftVideoPath` rồi đổi tên thành `final.mp4`. Pipeline thiếu bước final export tách biệt đạt chuẩn sản xuất 1080x1920 với delivery blocks liên tục.

---

### TRẢ LỜI 10 CÂU HỎI ROOT CAUSE BẮT BUỘC

#### 1. Vì sao narrator trước đây có câu mang tính phán xét quá mức?
- **Cơ chế phát sinh:** Prompt của Director và Writer trong `blockNarrationService.js` khuyến khích "tạo kịch tính và góc nhìn sắc bén", nhưng không thiết lập guardrail cấm các tính từ định kiến chủ quan (*pejorative labels*).
- **Điểm khiếm khuyết:** `narrationGate.js` ban đầu chỉ kiểm tra tính grounding sự kiện cơ bản, không có danh mục nhận diện các cụm từ thiên vị như *"pure entitlement"*, *"insulting"*, *"stormed off"*, *"karen"*.
- **Hệ quả biên tập:** Khán giả cảm thấy narrator áp đặt suy nghĩ thay vì để hành vi và chứng cứ thực tế tự bộc lộ bản chất của vụ việc.

#### 2. Vì sao narrator lại tiết lộ câu thoại đắt giá trước khi footage phát (Punchline Spoiling)?
- **Cơ chế phát sinh:** Writer module xử lý từng delivery block độc lập dựa trên ngữ cảnh toàn bộ transcript. Khi thấy trích dẫn hay trong transcript tương lai ("being rude is not against the law"), LLM Writer tự ý đưa câu này vào khối dẫn nhập (*framing*) để tóm tắt cho người xem.
- **Điểm khiếm khuyết:** Thiếu hợp đồng ràng buộc giữa Narrator và Evidence liền kề (*Narrator-to-Evidence Reveal Contract*). Writer không kiểm tra xem câu thoại đó có được nhân vật tự nói ra trong raw beat kế tiếp hay không.
- **Hệ quả biên tập:** Khi raw beat phát lại câu nói đó, yếu tố bất ngờ bị triệt tiêu hoàn toàn; khán giả mất đi cảm xúc thỏa mãn khi nghe nhân vật tự đối chất.

#### 3. Có cơ chế kiểm tra trùng thông tin narrator/footage không?
- **Thực trạng trước nâng cấp:** Hệ thống chỉ có `detectInformationEcho` để kiểm tra độ lặp từ vựng giữa narrator block trước và narrator block sau.
- **Lỗ hổng:** Hoàn toàn KHÔNG có logic so sánh ngữ nghĩa giữa câu thoại của narrator và transcript của raw evidence tiếp theo. Do đó, hiện tượng tiết lộ trước tình tiết hoàn toàn lọt qua cổng kiểm duyệt.

#### 4. Bước nào chọn footage để phát trong lúc narrator nói?
- **Vị trí kiến trúc:** `Editorial Director` (`electron/services/editorialDirectorService.js`) trong giai đoạn biên tập timeline beats.
- **Cơ chế phân bổ:** Director quyết định beat nào mang `narrativeRole` là `bridge_picture` hoặc `context`, sau đó gắn vào `deliveryBlocks` với `mode: 'narrated_story'`.
- **Lỗ hổng cũ:** Director không kiểm tra mật độ hội thoại của đoạn footage được chọn. Nếu đoạn đó có nhân vật đang mấp máy môi nói chuyện trực diện với cảnh sát hoặc có phụ đề tiếng Anh gắn chết trên video gốc, Director vẫn vô tư phủ `voiceover_only` lên.

#### 5. Vì sao phụ đề nguồn vẫn có thể hiển thị dưới voice narrator ("Mime Effect")?
- **Đặc thù footage:** Video nguồn `source-m6ow9dqxqcg.mp4` là bản phát hành của kênh YouTube "Police Ride-Alongs", vốn đã được nhà đài burn trực tiếp phụ đề chữ xanh vào pixel hình ảnh.
- **Xung đột audio/visual:** Khi Director chọn đoạn đối thoại trong xe thùng (`523.2s - 527.2s`) làm nền cho block narrator kết thúc với chế độ `voiceover_only`, FFmpeg tắt âm thanh gốc để phát giọng đọc Kokoro. Nhưng trên màn hình, khán giả vẫn nhìn thấy miệng nhân vật chuyển động và đọc được phụ đề tiếng Anh nói câu khác hẳn giọng đọc, tạo ra hiệu ứng "kịch câm" gây khó chịu và mất uy tín biên tập.

#### 6. Vì sao ending chuyển layout đột ngột sang màn hình 3 ô chia tách?
- **Đặc thù footage:** Tại timestamp `529.8s` (`scene_0043`), viên cảnh sát chốt then cửa sắt xe thùng, đánh dấu kết thúc bodycam thực tế. Từ `530.0s` (`scene_0044`), video nguồn chuyển sang màn hình đồ họa 3 khung hình tổng kết (*split-screen outro*) kèm logo kênh và lời kêu gọi subscribe.
- **Lỗ hổng:** `storyScopeService.js` không nhận diện được ranh giới này nên đã mở rộng cửa sổ scope đến `535.0s`. Director chọn beat kết thúc kéo dài tới `531.0s`, khiến 1.2 giây cuối bị văng vào bố cục 3 ô đồ họa.

#### 7. Vì sao audio cuối có khoảng gần im lặng (Digital Dead Air)?
- **Cơ chế âm học:** Ở đoạn outro 3 khung hình (`530.0s+`), audio của video gốc vốn đã tắt tiếng nói và chỉ có nhạc nền mờ. Khi kết hợp với chế độ `voiceover_only` và bộ lọc `apad` trong FFmpeg của `dubbingService.js`, voiceover TTS kết thúc sớm khiến bộ lọc FFmpeg đệm khoảng lặng số (*digital dead air*) kéo dài hơn 2 giây cuối.

#### 8. Vì sao Media Critic hoặc Render QA chưa phát hiện các vấn đề trên?
- **Phân tích Critic:** `scopeMediaCriticService.js` dựa chủ yếu vào LLM đọc transcript và metadata text của manifest. Khi không "nhìn" thấy pixel phụ đề xanh hay "nghe" thấy dead air thực tế, Critic dễ dàng cấp chứng nhận PASS dựa trên văn bản logic.
- **Phân tích Render QA:** `RenderQaService` chỉ kiểm tra sai lệch thời lượng tổng thể giữa timeline và tệp MP4, không đo đạc biên độ RMS của đuôi âm thanh và không kiểm tra tương quan giữa visual scene cut và outro graphic.

#### 9. Vì sao có sự nhầm lẫn giữa Fast Draft và Production Final?
- **Lịch sử kiến trúc:** Trong các phiên bản trước V5, pipeline chỉ có quy trình render draft để người dùng xem trước trên giao diện Electron. Khi AutoStory V5/V6 bổ sung continuous delivery blocks, logic này được tích hợp vào `renderHighlightFastDraft`. Do thiếu hàm `renderHighlightFinalExport` hỗ trợ delivery blocks ở độ phân giải 1080x1920 (preset fast, CRF 21, Master Audio), benchmark đã lấy luôn file draft 540x960 rồi copy sang thư mục `D:\Video` đặt tên là `final.mp4`.
- **Hệ quả:** Bản video được nghiệm thu mang độ phân giải thấp (540x960), chất lượng nén thấp (CRF 29), không xứng tầm bản phát hành chính thức.

#### 10. Phân loại lỗi Biên tập và lỗi Kỹ thuật:
- **Lỗi biên tập (Editorial):**
  - Viết lời narrator mang tính định kiến áp đặt.
  - Tiết lộ trước câu đối đáp quan trọng của nhân vật.
  - Phân bổ ngân sách runtime kém (để cảnh đi bộ chiếm 27 giây, bóp nghẹt câu phản biện cốt lõi và lời giải thích của cấp chỉ huy).
- **Lỗi kỹ thuật (Technical):**
  - Hardcode timestamp `529.8s` trong codebase tổng quát.
  - Thiếu module phát hiện dynamic ending boundary dựa trên SRT patterns và scene cuts.
  - Thiếu luồng Production Final Render 1080x1920 chuẩn hóa cho delivery blocks.
