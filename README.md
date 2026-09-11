# RecapTool Studio

RecapTool Studio là ứng dụng Electron chạy cục bộ trên Windows để phân tích, cắt, thuyết minh và xuất video ngắn. Video, voice cache, proxy, transcript và file dự án được xử lý trên máy; chỉ các tác vụ AI mà người dùng chủ động chọn mới gửi dữ liệu tới provider tương ứng.

## Chức năng chính

- Highlight Cut từ một hoặc nhiều JSON variant.
- Luồng Gemini Draft Review hai lượt, không yêu cầu Gemini API.
- Story Recut dựng lại video theo cấu trúc phi tuyến có kiểm tra continuity.
- DIY Story Remix tái dựng video DIY viral bằng Visual Process Map, Story Blueprint và voice thật khóa theo cảnh.
- Podcast Viral Cut nén hội thoại dài thành 1-5 video ngắn chỉ dùng lời nói và âm thanh nguồn.
- Chọn video local hoặc dán URL YouTube/TikTok để tải nguồn tốt nhất tối đa 1080p; transcript tiếng Anh có sẵn được tải và chọn tự động.
- Oddly Satisfying / DIY Storytime.
- Dubbing và dịch lời thoại.
- Render draft nhanh, nghe thử từng cảnh và xuất video hoàn chỉnh.
- Render draft lần lượt cho toàn bộ Highlight variant, có trạng thái riêng cho từng variant.
- Timeline có thể seek, đổi cảnh và đồng bộ với danh sách lời thoại.
- Voice timing đo bằng thời lượng audio thật.
- Nền mờ, canvas dọc, caption đầu video và mixer âm thanh.
- Cache metadata, proxy, transcript, voice và bản dịch preview.
- QA sau render và report chi tiết theo dự án.
- Khôi phục render job bị gián đoạn sau khi ứng dụng đóng hoặc crash.

Video tải từ URL được lưu gọn trong thư mục `sources` cạnh thư mục `projects` của workspace. Tool ưu tiên phụ đề tiếng Anh do tác giả cung cấp, sau đó mới thử auto-caption `en-orig` và `en`. Không có transcript không làm thất bại việc tải video; các mode cần transcript vẫn có thể dùng Whisper sau đó.

## Các chế độ

### Highlight Cut

Highlight sử dụng timestamp nguồn tuyệt đối:

```json
{
  "title": "Video title",
  "language": "en",
  "sourceLanguage": "en",
  "total_target_sec": 75,
  "segments": [
    {
      "id": "highlight_0001",
      "sceneId": "scene_0001",
      "evidenceId": "evidence_0001",
      "sourceStartSec": 100,
      "sourceEndSec": 112,
      "startSec": 0,
      "endSec": 12,
      "playbackSpeed": 1,
      "audio_mode": "original_audio",
      "voiceover_text": "",
      "caption": "",
      "preview_vi": "Mô tả tiếng Việt chỉ dùng trong preview",
      "action_notes": "Mô tả bằng chứng hình ảnh và âm thanh"
    }
  ]
}
```

Quy tắc:

- `sourceStartSec/sourceEndSec` thuộc timeline video gốc.
- `startSec/endSec` thuộc timeline video output và phải nối tiếp nhau.
- `endSec - startSec = (sourceEndSec - sourceStartSec) / playbackSpeed`.
- Có `voiceover_text`: tool tắt hoàn toàn âm nguồn và phát voice của tool.
- Không có `voiceover_text`: tool giữ âm thanh gốc.
- `preview_vi` chỉ hiển thị khi preview, không tự động burn vào video cuối.

### Gemini Draft Review hai lượt

Mode này giữ cách tạo timeline trực tiếp của Highlight Cut, sau đó dùng chính video draft để Gemini review:

1. Tool tạo `01-GUI-GEMINI` gồm proxy có sceneId/timestamp nguồn, manifest, transcript và prompt trực tiếp.
2. Gemini xem video nguồn và trả ba code block JSON độc lập theo thứ tự Script 1, Script 3, Script 4; tải chúng thành `script-1.json`, `script-3.json`, `script-4.json`.
3. User có thể chọn 1, 2 hoặc cả 3 JSON. Tool kiểm tra sceneId, timestamp nguồn, timeline output và import các file đã chọn thành variant V1.
4. User chọn một variant và render draft bằng cấu hình voice đã chọn.
5. Nút **Tạo gói review Gemini** tạo `02-DRAFT-REVIEW/.../01-UPLOAD-TO-GEMINI` với tối đa 10 file. Script V1, timeline output→source, manifest và báo cáo voice được gộp trong `review-context.json`; thư mục tải lên còn chứa video draft thật, transcript và tối đa 5 proxy nguồn liên quan.
6. Gemini xem toàn bộ draft trong một chat mới, đánh giá Hook, mạch truyện, audio, dead air và độ khớp voice/cảnh rồi trả `gemini-draft-review.json`.
7. Tool đọc `revisedScript`, tạo Revision V2 và giữ nguyên V1 để so sánh. Ngoài luồng review, user có thể import trực tiếp một JSON kịch bản thay thế tại Studio mà không cần render draft trước.
8. Render draft V2, dùng thanh **So sánh draft** để xem V1/V2 rồi mới xuất.

Gemini chỉ quyết định chất lượng sáng tạo và độ khớp ngữ nghĩa. Duration, voice coverage, word budget, scene boundary và output continuity do tool đo hoặc kiểm tra và được xem là dữ liệu có thẩm quyền. Luồng này không khóa variant theo `hookScore` tự khai và không yêu cầu Gemini suy luận từ blueprint trung gian mà không được xem video.

Các lớp cache metadata, proxy và transcript vẫn được dùng lại theo fingerprint video và cấu hình phân tích. Chọn tạo lại bắt buộc khi muốn bỏ cache.

Thư mục chứa gói phân tích được cấu hình một lần tại **Cài đặt → Thư mục gói phân tích Gemini**. Khi bấm **Tạo gói phân tích**, tool bắt đầu xử lý ngay và tự tạo gói trong thư mục này, không mở hộp chọn thư mục ở Giai đoạn 1.

### DIY Story Remix

Mode này dành cho video DIY/storytelling ngắn đã có hình ảnh tốt nhưng cần đảo một số phần và viết lời kể mới. Dự án vẫn dùng renderer Highlight để hỗ trợ timestamp nguồn phi tuyến, nhưng có workflow và validator riêng:

1. **Visual Process Map:** Gemini xem toàn bộ proxy và trả `diy_visual_process_map`, gồm trạng thái trước, thao tác nhìn thấy, trạng thái sau, Hook/payoff và dependency vật lý của từng beat.
2. **Process Quality Gate:** tool khóa sceneId/timestamp, phát hiện dependency thiếu hoặc vòng lặp, kiểm tra đủ trạng thái ban đầu, quá trình, trở ngại và thành phẩm. Map yếu được trả lại bằng prompt sửa riêng.
3. **DIY Story Blueprint:** Gemini chọn một Hook flash-forward rồi gom các beat thành macro-block. Sau Hook, phần thân phải trở về điểm bắt đầu và giữ đúng thứ tự vật lý.
4. **Voice-Locked Script:** Gemini viết đúng một `diy-story-remix.json` bằng ngôn ngữ và voice budget lấy từ cấu hình giọng đã đo. Mỗi câu phải tham chiếu beat hình ảnh đã khóa.
5. Tool import JSON bằng validator DIY, render draft bằng provider đã chọn, đo duration TTS thật và dùng cơ chế voice fit hiện có.
6. Có thể tạo gói Gemini Draft Review từ chính video draft. Bộ tiêu chí review riêng kiểm tra curiosity Hook, object-state continuity, mạch kể, voice/cảnh và payoff; không dùng quy tắc True Crime.

Story Profile **Tự động theo câu chuyện gốc (Gemini)** yêu cầu Gemini nhận diện chủ đề, cấu trúc cảm xúc và các tín hiệu kể chuyện của video nguồn, sau đó viết một câu chuyện mới có cùng chủ đề và quỹ đạo cảm xúc. Câu chuyện mới không sao chép câu chữ nguồn, không được mâu thuẫn với thao tác đang hiển thị và không được biến chi tiết sáng tạo thành dữ kiện cụ thể về người thật, vật liệu, chi phí hoặc thời gian thi công.

Quy tắc âm thanh:

- Mặc định `audio_mode: "voiceover_only"` để tránh chồng lời nguồn với voice của tool.
- Chỉ dùng `original_audio` cho tiếng thao tác thỏa mãn thị giác khi Process Map xác nhận không có lời nói nguồn.
- `caption` phải rỗng; `preview_vi` chỉ phục vụ màn preview.
- Duration và coverage cuối cùng lấy từ audio TTS thật, không lấy số từ ước tính của Gemini làm chuẩn.

### Podcast Viral Cut

Mode này dành cho podcast hoặc video hội thoại dài. User chọn từ `1` đến `5` output, nhập URL YouTube công khai của đúng video và chọn video local tương ứng để render:

1. Mode Podcast chỉ xử lý tiếng Anh. Tool thử subtitle tác giả `en`, sau đó auto-caption gốc `en-orig`, rồi auto-caption `en`; không tải subtitle dịch tiếng Việt.
2. Nếu YouTube không có caption, tool trích audio từ chính video local để giữ timeline tuyệt đối rồi chạy faster-whisper English. Batch size được chọn theo GPU/RAM, có Silero VAD, word timestamp và cache theo chunk.
3. Transcript đầy đủ được lưu nội bộ dưới dạng TXT, SRT và JSON, sau đó chia thành các `dialogueUnitId` và `cutOptionId` an toàn để giữ nguyên, bỏ từ đệm hoặc bỏ từ lặp.
4. User có thể chọn `Hai lượt chất lượng` hoặc `Một lượt nhanh`. Một lượt nhanh giữ cách cũ: Gemini scene-mine và trả EDL ngay. Hai lượt chất lượng tách việc tìm cảnh và dựng nhịp để Gemini không phải vừa đọc hàng nghìn cue vừa tối ưu JSON trong cùng một lần.
5. Ở lượt 1 của chế độ chất lượng, Gemini trả một `podcast_candidate_map` schema v2. Mỗi story candidate có thể chứa nhiều `sourceSpans` không liền nhau để khóa riêng Hook/setup, action/reveal và reaction/payoff mà không kéo theo hàng phút chờ đợi. Mọi candidate, không chỉ `visual_action`, đều bắt buộc có `mustIncludeMoments` trả lời đúng `centralViewerQuestion` và phải có đủ tổng footage hữu ích để tự dựng một output đạt thời lượng tối thiểu user đã chọn.
6. Tool kiểm tra từng span, tổng footage hữu ích, khoảng chồng lấn và Promise/Payoff coverage trước khi cắt Candidate Reel. Reel ghép đúng các span đã khóa rồi chạy faster-whisper để lấy word timestamp. Candidate chỉ có lời hứa như “wipe it off” nhưng thiếu hành động/kết quả sẽ bị từ chối ngay tại lượt 1.
7. Thư mục `02-ASSEMBLY-GEMINI` luôn có tối đa 10 file: prompt Assembly, source map, Candidate Map đã resolve, Candidate Reel và các phần dialogue-unit đã tinh chỉnh. Gemini lượt 2 phải chọn toàn bộ `requiredMomentUnitIds` của candidate được dùng; compiler từ chối EDL làm mất action, reveal, reaction hoặc payoff.
8. Tool giữ `podcast-dialogue-units.full.json` và `podcast-assembly-dialogue-units.full.json` nội bộ để biên dịch chính xác, nhưng không gửi các file lớn này lên Gemini. Video dài vẫn được Gemini xem qua URL; chỉ Candidate Reel ngắn được upload ở lượt 2.
9. Trước khi dựng, Gemini phải đọc đủ mọi dialogue-unit part, đối chiếu đầu/giữa/cuối và xác nhận `sourceMatchId`. Mỗi option row chứa `cutOptionId` đầy đủ và phải được copy nguyên văn; tool có fallback an toàn từ `_aggressive` sang `_tight`/`_full` khi Gemini vẫn chọn một hậu tố không tồn tại. Nếu URL không xem được nhưng transcript đầy đủ, Gemini dùng `transcript_locked`; ở lượt Assembly dùng `candidate_reel`.
10. Gemini chỉ được chọn ID đã khóa; không được viết lại hội thoại hoặc tự tạo timestamp. Repetition có giá trị cảm xúc được giữ, còn dead air và filler được loại bằng `cutOptionId`. Tool biên dịch ID thành timestamp local, kiểm tra continuity, rồi import thành Highlight variant dùng `original_audio` 100%; mode này không tạo narrator hoặc TTS.

Đảo timeline là tùy chọn, không phải mặc định. Mỗi chuyển cảnh phi tuyến phải giữ rõ chủ thể, trạng thái hình ảnh tương thích và đạt continuity gate. Các output có thể dùng chung một ít context cần thiết nhưng không được chỉ là các bản sao đổi thứ tự.

Tool so duration YouTube với video local trước khi dùng caption; lệch trên `2s` sẽ bị chặn để tránh sai timestamp. Nếu YouTube không có caption và Whisper vượt timeout 5 phút, chunk ASR đã hoàn thành vẫn được cache để lần tạo gói sau tiếp tục.

Khung 9:16, crop và auto-cropping thuộc renderer local, không phải đầu vào Gemini. Với kết quả `transcript_locked`, draft sẽ có cảnh báo nhắc user kiểm tra continuity hình ảnh trước khi xuất.

### Story Recut

Story Recut là workflow Gemini thủ công riêng, không thay đổi ba profile Highlight cũ:

1. Tool tạo gói `gemini-story-recut-pack` với proxy, manifest, transcript và prompt evidence.
2. Gemini phân tích toàn bộ video thành evidence có sceneId, sourceRun và quan hệ trước-sau.
3. Tool khóa evidence rồi tạo prompt lượt 2.
4. Gemini trả về đúng một code block JSON; tải block đó thành `story-recut.json`.
5. Tool kiểm tra Story Blueprint, Hook, macro-block, source jump, 100% âm thanh nguồn và độ an toàn điểm cắt.
6. User preview, đọc cảnh báo và vẫn có quyền xuất video.

Story Recut sắp xếp lại các macro-block hoàn chỉnh, không đảo ngẫu nhiên từng shot. Profile mặc định:

- Tổng thời lượng tối thiểu `60s`, không có giới hạn tối đa cứng.
- Hook dài tối thiểu `5s`, dùng âm thanh gốc và phải giữ trọn beat; không cắt giữa ý chỉ để đạt một con số thời lượng.
- Ít nhất `3` macro-block có đủ Hook, thân truyện và payoff. Số khối thực tế do nội dung quyết định.
- Một macro-block nguồn liên tục có thể dài `2-3 phút` hoặc hơn nếu toàn bộ đoạn đó cần thiết để giữ bối cảnh, quan hệ nhân quả và cao trào.
- Tối đa `4` lần nhảy xa trên timeline nguồn.
- `100%` thời lượng dùng âm thanh nguyên bản của các đoạn nguồn.
- Không tạo narrator, TTS hoặc voice bridge. Narrator gốc, hội thoại, radio, ambience, hiệu ứng và nhạc nguồn đều được giữ nguyên.
- Khi import, tool ép mọi segment về `audio_mode: "original_audio"` và xóa `voiceover_text`, kể cả khi Gemini trả sai quy tắc.
- File lượt 1 có `artifactType: "scene_evidence"` và mảng `evidence`; file lượt 2 có `artifactType: "story_recut_script"` và mảng `segments`. Tool từ chối ngay nếu chọn nhầm file evidence ở ô Story Recut JSON.
- Timestamp luôn được khóa theo `evidenceId`, `sceneId` và `sourceRunId`.

Mode này không cam kết nội dung được nền tảng công nhận là nguyên bản và không thay thế quyền sử dụng nội dung nguồn.

### Oddly Satisfying Storytime

Schema tối thiểu:

```json
{
  "title": "DIY Story",
  "language": "en",
  "style": "diy_storytime",
  "segments": [
    {
      "id": "story_0001",
      "startSec": 0,
      "endSec": 12,
      "text": "English narration for this scene.",
      "caption": ""
    }
  ]
}
```

Tool chấp nhận các alias như `voiceover_text`, `voiceoverText`, `dubbingLine` và `storyText`. Cảnh dùng voice phải có text; cảnh `original_audio` có thể để text rỗng.

### Dubbing

Luồng mặc định là `speech_first_clustered`:

1. Đọc SRT hoặc chạy ASR.
2. Dịch/viết lại theo provider AI.
3. Gom lời thoại thành cụm.
4. Tạo voice.
5. Đo duration thật bằng FFprobe.
6. Fit voice và hình ảnh.
7. Mix âm thanh và render.

Có thể dùng `legacy_segment_strict` trong Settings để tương thích dự án cũ.

## AI, ASR và Voice

AI provider:

- Gemini API.
- Antigravity CLI.
- Ollama Local.
- Local fallback cho các bước không cần suy luận phức tạp.

ASR:

- Faster Whisper.
- OpenAI Whisper CLI.
- NVIDIA Parakeet.
- Auto mode tự chọn cấu hình dựa trên CPU, RAM và GPU.
- Timeout mặc định là 5 phút; transcript chunk đã hoàn thành được cache.

Dịch phụ đề preview local:

- `OPUS-MT`: nhanh, nhẹ, phù hợp máy yếu và dịch Anh sang Việt.
- `Hy-MT2 7B`: dịch tự nhiên và giữ ngữ cảnh tốt hơn, chạy qua Ollama. Chọn trong Settings rồi bấm `Tải Hy-MT2` ở lần dùng đầu; bản `UD-Q4_K_XL` cần tải khoảng 4,8 GB.
- Hy-MT2 được giữ trong Ollama 15 phút để các batch tiếp theo không phải nạp lại. Nếu engine local lỗi, pipeline vẫn dùng chuỗi AI fallback hiện có.

Voice provider:

- ElevenLabs.
- Edge Neural.
- Kokoro.
- OmniVoice.
- Windows Local.

Kokoro và OmniVoice dùng persistent Python worker để model chỉ nạp một lần trong phiên. Voice cache được khóa theo provider, voice/model, ngôn ngữ, style và các thông số tuning.

## Voice timing và quality gate

Sau khi tạo audio, tool đo:

```text
coverageRatio = actualVoiceDurationSec / plannedSceneDurationSec
```

Ngưỡng mặc định:

- Nhỏ hơn `0.82`: voice quá ngắn.
- `0.85` đến `1.00`: vùng lý tưởng.
- Lớn hơn `1.08`: voice quá dài.

Fast draft tạo:

- Voice warning report.
- Gemini rewrite prompt.
- Resolved timeline.
- Quality gate theo duration và review ngữ nghĩa.

Quality gate chỉ cảnh báo; người dùng vẫn có quyền xuất video.

## Render job và khôi phục sau crash

Mỗi lần xuất tạo `render-job-<id>.json` trong thư mục output của project. Journal lưu step, phần trăm, attempt và trạng thái.

Nếu app đóng khi đang render:

1. Lần mở tiếp theo tool đánh dấu job cũ là `interrupted`.
2. Project hiển thị nút **Tiếp tục xuất**.
3. Tool tạo attempt mới từ project đã lưu.
4. Voice, transcript và clip cache hợp lệ được tái sử dụng.

FFmpeg không thể tiếp tục chính xác giữa một process đã chết. Vì vậy resume là chạy lại an toàn từ project state, không nối tiếp một file MP4 dở dang.

## Cấu trúc lưu trữ

```text
workspace/
  project-id/
    project.json
    analysis/
      analysis.json
      scene-manifest.json
      source-transcript.json
    assets/
    audio/
      .voice-cache/
    clips/
    output/
      render-job-*.json
      *-render-qa.json
      *-resolved-timeline.json
    temp/
```

Video draft và video cuối được publish sang `exportRoot`. Có thể chọn layout phẳng hoặc tạo một thư mục cho từng project. Các gói phân tích Gemini được lưu riêng tại `geminiAnalysisRoot`.

## Kiến trúc source

```text
electron/
  main.js                         IPC và vòng đời Electron
  preload.js                      API an toàn cho renderer
  services/
    dubbingService.js             Điều phối workflow dubbing/story/highlight
    dubbingScriptService.js       Chuẩn hóa schema Storytime
    dubbingArtifactService.js     Canvas, caption và publish artifact
    pipelineService.js            Pipeline recap AI thế hệ trước
    ffmpegService.js              Cắt, retime, mix và encode
    manualGeminiPackService.js    Proxy, manifest và prompt Gemini thủ công
    geminiDraftReviewService.js   Gói review draft thật và timeline V1/V2
    storyRecutService.js          Quality preflight cho Story Recut
    diyStoryRemixService.js       Process Map, Blueprint và final gate cho DIY Story Remix
    podcastViralService.js        Gói Podcast, dialogue ID và compiler EDL
    podcastCandidateService.js    Candidate Map, Candidate Reel và prompt Assembly lượt 2
    renderJobService.js           Journal và khôi phục render
    voiceProfileService.js        Học tốc độ từng voice profile
    voiceTimingPolicy.js          Chính sách timing dùng chung
src/
  index.html
  renderer.js
  styles.css
tools/
  faster_whisper_transcribe.py
  parakeet_transcribe.py
  omnivoice_worker.py
  kokoro_worker.py
tests/
```

Hai mode recap AI và viết lại từ video gốc đang được giữ trong source để tương thích nhưng tạm ẩn khỏi giao diện.

## Yêu cầu

- Windows 10/11.
- Node.js 20 trở lên.
- FFmpeg và FFprobe.
- Python khi dùng Whisper, Parakeet, Kokoro, OmniVoice hoặc dịch local.
- API key chỉ cần cho provider cloud được chọn.

Kiểm tra trong ứng dụng bằng nút **Kiểm tra cấu hình**. Portable EXE sẽ cảnh báo riêng từng thành phần còn thiếu.

## Chạy và kiểm thử

```powershell
npm install
npm run start
npm run check
npm test
```

Đóng gói:

```powershell
npm run dist:portable
npm run dist:win
```

## Giới hạn hiện tại

- Chất lượng lựa chọn cảnh vẫn phụ thuộc evidence và khả năng phân tích của AI.
- Resume render chạy lại attempt mới; không resume giữa một lệnh FFmpeg.
- OmniVoice chạy CPU có thể chậm và tốn RAM.
- Local translation hiện ưu tiên mô hình Anh sang Việt.
- API key hiện được lưu trong file cấu hình cục bộ của Electron.
- Timeline chưa phải trình dựng đa track đầy đủ như CapCut.
