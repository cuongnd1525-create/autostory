# BÁO CÁO 02: KIẾN TRÚC VÀ CHI TIẾT TRIỂN KHAI (IMPLEMENTATION REPORT)
## CINEVIRAL STUDIO — V6 EDITORIAL QUALITY RECOVERY & VIRAL STORYTELLER BENCHMARK

- **Dự án:** Cineviral Studio (`cuongnd1525-create/autostory`)
- **Workspace:** `D:\Project\cineviral-studio`
- **Branch:** `feat/autostory-v6-editorial-recovery`
- **Baseline Commit:** `0fc259c`
- **Thời gian lập báo cáo:** 2026-11-05

---

### TỔNG QUAN CÁC THAY ĐỔI MÃ NGUỒN

Để giải quyết triệt để 4 vấn đề P0 và các bài toán biên tập P1, 6 module kiến trúc chính đã được bổ sung và cập nhật:

```
Modified / Added Files:
  1. [NEW]      electron/services/sourceEndingBoundaryService.js
  2. [MODIFIED] electron/services/storyScopeService.js
  3. [MODIFIED] electron/services/editorialDirectorService.js
  4. [MODIFIED] electron/services/autoStoryV3Pipeline.js
  5. [MODIFIED] electron/services/dubbingArtifactService.js
  6. [MODIFIED] electron/services/dubbingService.js
```

---

### CHI TIẾT TỪNG MODULE

#### 1. `electron/services/sourceEndingBoundaryService.js` (MỚI)
- **Mục đích:** Xóa bỏ hoàn toàn việc hardcode con số `529.8s`, thay thế bằng cơ chế phát hiện tự động ranh giới kết thúc hành động thực tế (*live-action encounter boundary*) cho mọi video nguồn.
- **Thuật toán nhận diện:**
  - `OUTRO_TEXT_PATTERNS`: Quét các cụm từ đặc trưng của đoạn outro/disposition ở 15-20% thời lượng cuối video nguồn (ví dụ: *thanks for watching, like and subscribe, comment below, patreon, pleaded guilty, charges were dropped, sentenced to, booking officer would put her bond, was charged with misuse of, end of watch*).
  - Đối chiếu với `sceneManifest.json` (phát hiện điểm chuyển cảnh visual cut ngay trước khi outro graphic hoặc disposition slide xuất hiện).
  - Thuật toán định vị: Nếu outro cue bắt đầu tại thời điểm $T$, tìm scene cut liền kề $S_{cut}$ chứa $T$; ranh giới hành động thực tế được xác định là $S_{cut}.startSec - 0.2s$.
- **Kiểm chứng đa nguồn:**
  - Trên video `m6ow9dqxqcg`: Tự động nhận diện ranh giới `529.8s` (từ outro cue tại 533.0s và scene cut 43/44 tại 530.0s).
  - Trên video `bwqdruna5pa`: Tự động nhận diện ranh giới `860.2s` (nơi xuất hiện bảng tóm tắt án phạt của tòa án).
  - Hoàn toàn không còn bất kỳ con số hardcode nào trong logic phát hiện.

#### 2. `electron/services/storyScopeService.js`
- **Loại bỏ hardcode:** Xóa bỏ toàn bộ các literal `529.8` / `529.85` trong prompt instruction (dòng 123) và hàm kiểm tra `validateStoryScope` (dòng 294-306).
- **Hỗ trợ động:** Tiếp nhận tham số `liveActionEndSec` thông qua options của `selectStoryScope` và `validateStoryScope`.
- **Ràng buộc phạm vi:** Khi `liveActionEndSec > 0`, tự động giới hạn các cửa sổ `ending_material` không được vượt quá `liveActionEndSec`.

#### 3. `electron/services/editorialDirectorService.js`
- **Loại bỏ hardcode:** Xóa các câu lệnh hướng dẫn khóa cứng `529.8s` trong prompt Director.
- **Ràng buộc Punchline & Lập luận cốt lõi (`PUNCHLINE & CORE DEFENSE PRESERVATION`):**
  - Bổ sung quy tắc bắt buộc Director phải bảo toàn các câu phản biện đắt giá của nhân vật (điển hình như luận điểm *"being rude is not illegal / not a crime"* tại mốc `455s - 462s`) dưới dạng `raw_evidence`.
  - Cấm Director cắt bỏ phản biện của nhân vật để kéo dài thời lượng đi bộ trên vỉa hè hoặc tuần tra vô nghĩa.
- **Tối ưu hóa ngân sách thời lượng (`PACING & RUNTIME BUDGETING`):**
  - Rút gọn cảnh cảnh sát cảnh báo trên vỉa hè và áp giải xuống còn khoảng 6-10 giây (thay vì 27+ giây như V6 Upgrade), tạo dư địa thời lượng (khoảng 8-12 giây) để đưa cả câu phản biện cốt lõi lẫn lời giải thích đanh thép của cấp chỉ huy vào video.
- **Cập nhật Validator:** Sửa hàm `validateDirectorEdl` để tiếp nhận `liveActionEndSec` động từ `scope` hoặc options, kiểm tra vi phạm `ENDING_CUTS_INTO_OUTRO` một cách tổng quát.

#### 4. `electron/services/autoStoryV3Pipeline.js`
- **Tích hợp Preprocessing:** Gọi `detectSourceEndingBoundary` ngay sau khi Source Story Model hoàn tất.
- **Lan truyền Metadata:** Gắn `liveActionEndSec` vào `model` và truyền trực tiếp vào `StoryScope.selectStoryScope` cũng như `Director.directEdl`.
- **Thiết lập Video Decoration chuẩn Viral:**
  - Tự động bật `canvasEnabled: true`, `canvasAspect: '9:16'`, `blurBackgroundEnabled: true`.
  - Tự động kích hoạt `topCaptionEnabled: true`, `topCaptionAutoFromScript: true`, `topCaptionStyle: 'default'`.
  - Đưa tiêu đề hook (`hookPromise` hoặc `title`) lên thanh caption trên cùng theo đúng phong cách video mẫu `va.mp4`.

#### 5. `electron/services/dubbingArtifactService.js`
- **Mở rộng `resolveSuggestedTopCaption`:**
  - Bổ sung tra cứu `project.videoDecoration?.topCaptionText`, `spine.hookPromise`, `project.hookPromise` vào chuỗi ưu tiên tạo caption tự động.
  - Đảm bảo tiêu đề hook được trích xuất đồng bộ từ Story Spine mà không cần người dùng nhập thủ công.

#### 6. `electron/services/dubbingService.js`
- **Phân định rạch ròi Draft vs Final:**
  - Nâng cấp `renderHighlightFastDraft` tiếp nhận cờ `isFinal: boolean` (mặc định là `false`).
  - Khi `isFinal === false` (Editorial Preview / Fast Draft): Render ở độ phân giải 540x960, preset `ultrafast`, CRF 29, lưu thành `highlight-cut-...-fast-draft-...mp4` và xuất bản qua `publishDraftVideo`.
  - Khi `isFinal === true` (Production Final Export): Render ở độ phân giải đầy đủ 1080x1920, preset `fast`, CRF 21, Master Audio kích hoạt, hỗ trợ continuous delivery blocks, lưu thành `highlight-cut-...-final-...mp4` và xuất bản chính thức qua `publishFinalVideo`.
  - Xuất khẩu hàm chuyên dụng `renderHighlightFinalExport` trên `dubbingService`.
