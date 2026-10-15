/* Dedicated recap wizard. Existing fields are moved, never duplicated, so other
 * modes keep their own controls and listeners when the user switches back. */
(() => {
  const labels = ["Nguồn video", "Nội dung", "Giọng & âm thanh", "Hình & phụ đề", "Góc kể & hook", "Duyệt & xuất"];
  const stages = { validate_inputs: "Kiểm tra video nguồn", proxy_generation: "Tạo video phân tích", scene_detection: "Tìm ranh giới cảnh",
    hierarchical_analysis: "AI phân tích nội dung video", story_synthesis: "Tổng hợp cốt truyện", story_angles: "Đề xuất góc kể",
    hook_generation: "Viết các hook mở đầu", hook_audition: "Dựng và đọc thử hook", edit_planning: "Lập kế hoạch dựng",
    narration_generation: "Viết lời kể", tts_synthesis: "Tạo giọng đọc", clause_alignment: "Căn hình theo mệnh đề đang đọc", duration_repair: "Điều chỉnh thời lượng",
    draft_rendering: "Dựng video nháp", quality_review: "AI kiểm tra video nháp", quality_repair: "Sửa video nháp",
    anchor_audit: "Đối chiếu lại mốc cảnh nguồn", quality_blocked: "Video cần sửa trước khi xuất", final_render: "Xuất video cuối", completed: "Đã xuất video" };
  const duration = (ms) => { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; };
  const $ = (id) => document.getElementById(id);
  const escape = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const field = (id, label, control) => `<div class="recap-field"><label for="${id}">${label}</label>${control}</div>`;
  const movedFields = [
    ["project-title", ".field-card", "recap-source-fields"], ["project-picker", ".field-card", "recap-old-projects"],
    ["source-video-path", ".source-picker-card", "recap-source-fields"],
    ["target-duration", ".field-card", "recap-duration-fields"], ["recap-preset", null, "recap-content-fields"],
    ["recap-editorial-selection", null, "recap-content-fields"], ["viral-optimization", ".field-card", "recap-narrative-advanced"],
    ["recap-narration-language", null, "recap-voice-fields"], ["recap-narration-style", null, "recap-voice-fields"],
    ["recap-mute-source-audio", ".field-card", "recap-audio-fields"], ["voice-speed", ".field-card", "recap-voice-advanced"],
    ["recap-aspect-ratio", null, "recap-frame-fields"], ["recap-framing", null, "recap-frame-fields"],
    ["recap-caption-style", null, "recap-frame-fields"], ["recap-visual-lead", ".field-card", "recap-sync-advanced"],
    ["recap-allow-reuse", ".field-card", "recap-sync-advanced"], ["recap-workflow-mode", ".field-card", "recap-export-fields"]
  ];
  class RecapSetupUi {
    constructor(callbacks) {
      this.callbacks = callbacks; this.moves = []; this.active = false; this.project = null; this.result = null;
      this.lastSignature = ""; this.voiceRequest = 0; this.loadedVoiceKey = "";
      const card = $("setup-view").querySelector(".setup-card");
      this.categoryTabs = card.querySelector(".mode-category-tabs");
      this.categoryAnchor = document.createComment("mode-category-tabs original location");
      this.categoryTabs.before(this.categoryAnchor);
      const root = document.createElement("div"); root.id = "recap-setup-panels"; root.className = "hidden";
      root.innerHTML = `
        <div id="recap-run-status" class="recap-run-status hidden">
          <div class="recap-run-heading"><strong id="recap-run-stage" role="status"></strong><button id="recap-run-stop" type="button" class="secondary-button danger">Dừng xử lý</button></div>
          <p id="recap-run-detail"></p><div id="recap-run-timing" class="recap-run-timing"></div>
          <p id="recap-run-wait" class="recap-run-wait"></p>
          <div id="recap-provider-recovery" class="recap-provider-recovery hidden">
            <p id="recap-provider-recovery-note"></p>
            <button id="recap-resume-vertex" class="primary-button" type="button">Đổi sang Vertex AI và chạy tiếp</button>
            <button id="recap-provider-settings" class="secondary-button hidden" type="button">Mở cài đặt AI</button>
          </div>
        </div>
        <section data-recap-step="1" class="recap-step hidden"><h2>Chọn nguồn video</h2><p class="recap-step-hint">Đặt tên dự án và chọn video cần recap.</p><div id="recap-source-fields"></div><details><summary>Mở dự án đã có</summary><div id="recap-old-projects"></div></details></section>
        <section data-recap-step="2" class="recap-step hidden"><h2>Bạn muốn kể theo cách nào?</h2><p class="recap-step-hint">Chọn loại nội dung, thời lượng và cách chọn mở đầu.</p>
          <div class="recap-preset-choices" role="group" aria-label="Loại nội dung">${[["recap", "Recap", "Kể diễn biến và kết quả"], ["review", "Review", "Nhận xét có dẫn chứng"], ["explain", "Giải thích", "Trả lời một câu hỏi"]].map(([value, label, detail]) => `<button type="button" class="recap-choice" data-recap-preset="${value}" aria-pressed="false"><strong>${label}</strong><small>${detail}</small></button>`).join("")}</div>
          <div id="recap-content-fields" class="recap-fields"></div><h3>Thời lượng mục tiêu</h3><div class="recap-duration-choices" role="group" aria-label="Thời lượng mục tiêu">${[[75, "75 giây"], [120, "2 phút"], [240, "4 phút"]].map(([value, label]) => `<button type="button" class="secondary-button" data-recap-duration="${value}" aria-pressed="false">${label}</button>`).join("")}</div><div id="recap-duration-fields"></div>
          <details><summary>Tùy chọn kể chuyện</summary><div id="recap-narrative-advanced"></div></details></section>
        <section data-recap-step="3" class="recap-step hidden"><h2>Giọng và âm thanh</h2><p class="recap-step-hint">Chọn ngôn ngữ, giọng kể và nghe thử trước khi phân tích.</p><div id="recap-voice-fields" class="recap-fields"></div><div class="recap-fields">
          ${field("recap-voice-provider", "Nguồn giọng", '<select id="recap-voice-provider"><option value="edge_neural">Edge Neural</option><option value="kokoro">Kokoro · tiếng Anh</option><option value="elevenlabs">ElevenLabs</option><option value="windows_local">Giọng Windows</option><option value="advanced">Thiết kế / clone giọng</option></select>')}
          ${field("recap-voice-id", "Giọng đọc", '<select id="recap-voice-id"></select>')}
          </div><div class="recap-voice-actions"><button id="recap-voice-preview" class="secondary-button" type="button">Nghe thử giọng</button><button id="recap-voice-refresh" class="ghost-button" type="button">Tải thêm giọng</button></div><div id="recap-voice-message" class="recap-inline-message" role="status"></div><div id="recap-audio-fields"></div>
          <details id="recap-voice-extra"><summary>Tùy chọn giọng nâng cao</summary><div id="recap-voice-advanced"></div><div id="recap-original-voice"></div></details></section>
        <section data-recap-step="4" class="recap-step hidden"><h2>Hình và phụ đề</h2><p class="recap-step-hint">Xác nhận khung hình trước khi AI tạo các bản mở đầu.</p><div class="recap-frame-layout"><div><div id="recap-frame-fields" class="recap-fields"></div><details><summary>Đồng bộ hình và lời kể</summary><div id="recap-sync-advanced"></div></details></div><div class="recap-layout-preview" aria-label="Xem bố cục khung hình"><div id="recap-preview-frame" class="recap-preview-frame"><span>Khung hình video</span><div id="recap-preview-caption">PHỤ ĐỀ MẪU</div></div><small>Minh họa bố cục · draft sẽ dùng video nguồn</small></div></div></section>
        <section data-recap-step="5" class="recap-step hidden"><h2>Chọn góc kể và hook</h2><p class="recap-step-hint">Xem các bản mở đầu được tạo từ nguồn, rồi chọn bản muốn dùng.</p><div id="recap-setup-editorial-empty" class="recap-empty">Chưa có hook thử. Hoàn tất bước Hình & phụ đề rồi bấm “Phân tích và tạo hook”.</div><div id="recap-setup-editorial" class="hidden"><label for="recap-setup-angle">Góc kể</label><div class="recap-angle-actions"><select id="recap-setup-angle"></select><button id="recap-setup-regenerate" type="button" class="secondary-button">Tạo hook cho góc này</button></div><p id="recap-setup-angle-detail" class="recap-step-hint"></p><div id="recap-setup-hooks" class="recap-hook-grid"></div></div></section>
        <section data-recap-step="6" class="recap-step hidden"><h2>Duyệt và xuất</h2><p class="recap-step-hint">Xem draft, kết quả kiểm tra và lời kể trước khi xuất bản cuối.</p><div id="recap-export-fields"></div><div id="recap-setup-quality" class="recap-inline-message" role="status">Chưa dựng draft.</div><video id="recap-setup-draft" class="recap-draft-player hidden" controls preload="metadata"></video><div class="recap-review-actions"><button id="recap-setup-recheck" type="button" class="secondary-button hidden">Sửa / kiểm tra lại draft</button><button id="recap-setup-studio" type="button" class="secondary-button hidden">Mở trong Studio</button></div><details><summary>Lời kể của draft</summary><div id="recap-setup-script" class="recap-script"></div></details></section>
        <div id="recap-setup-error" class="recap-inline-error hidden" role="alert"></div>`;
      card.querySelector(".setup-footer").before(root); this.root = root;
      const sidebar = document.createElement("aside"); sidebar.id = "recap-setup-summary"; sidebar.className = "recap-setup-summary hidden";
      sidebar.innerHTML = `<h3>Video bạn sẽ tạo</h3><dl id="recap-setup-summary-values"></dl><div id="recap-setup-cache-note" class="recap-cache-note" role="status">Lựa chọn được lưu khi bạn chuyển bước.</div>`;
      $("setup-activity-panel").before(sidebar); this.summary = sidebar;
      this.status = document.createElement("span"); this.status.id = "recap-setup-footer-status"; this.status.className = "hidden";
      $("prev-step").after(this.status);
      movedFields.forEach(([id, selector, destination]) => this.registerMove(selector ? $(id).closest(selector) : $(id).parentElement, $(destination)));
      const voicePanel = card.querySelector('[data-step-panel="3"]');
      const voiceContents = document.createElement("div"); voiceContents.id = "recap-legacy-voice-wrapper";
      [...voicePanel.children].forEach((node) => voiceContents.append(node)); voicePanel.append(voiceContents);
      this.registerMove(voiceContents, $("recap-original-voice"));
      this.setupVoiceOptions(); this.bindEvents();
      $("recap-run-stop").addEventListener("click", () => {
        if (!this.runtime?.running) return;
        this.runtime.stopping = true; this.renderRuntime(); $("cancel-render").click();
      });
      $("recap-resume-vertex").addEventListener("click", () => { this.recoveryPromise = this.resumeWithVertex(); });
      $("recap-provider-settings").addEventListener("click", () => this.callbacks.openSettings?.());
    }
    registerMove(node, destination) {
      const anchor = document.createComment("recap field original location"); node.before(anchor); this.moves.push({ node, destination, anchor });
    }
    sync({ active, step, busy }) {
      if (active !== this.active) {
        this.moves.forEach(({ node, destination, anchor }) => active ? destination.append(node) : anchor.after(node));
        if (active) $("wizard-steps").before(this.categoryTabs); else this.categoryAnchor.after(this.categoryTabs);
        this.active = active;
      }
      $("setup-view").classList.toggle("recap-guided", active); this.root.classList.toggle("hidden", !active); this.summary.classList.toggle("hidden", !active); this.status.classList.toggle("hidden", !active);
      const title = $("setup-view").querySelector(".setup-title h1"); title.textContent = active ? "AI Video Recap" : "Cấu hình dự án";
      this.root.querySelectorAll("[data-recap-step]").forEach((panel) => panel.classList.toggle("hidden", !active || Number(panel.dataset.recapStep) !== step));
      this.root.querySelectorAll("button, input, select").forEach((control) => { control.disabled = Boolean(busy); });
      $("recap-run-stop").disabled = !this.runtime?.running || !this.runtime?.cancellable || Boolean(this.runtime?.stopping);
      if (!active) return;
      $("next-step").classList.remove("hidden"); $("start-ingest").classList.add("hidden");
      $("next-step").textContent = this.nextLabel(step);
      $("next-step").disabled = Boolean(busy) || (step === 5 && !this.editorialAvailable()) || (step === 6 && !this.canExport() && this.result?.status === "quality_blocked" && this.isFresh());
      $("prev-step").disabled = Boolean(busy) || step === 1;
      this.status.textContent = "Lựa chọn được lưu tự động";
      if (busy) this.status.textContent = this.runtime?.title || "Đang xử lý";
      this.updateSummary(); this.renderReview();
      $("recap-duration-preset").value = [75, 120, 240].includes(Number($("target-duration").value)) ? $("target-duration").value : "0";
      this.root.querySelectorAll("[data-recap-preset]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.recapPreset === $("recap-preset").value)));
      this.root.querySelectorAll("[data-recap-duration]").forEach((button) => button.setAttribute("aria-pressed", String(Number(button.dataset.recapDuration) === Number($("target-duration").value))));
      $("recap-preview-frame").classList.toggle("original", $("recap-aspect-ratio").value === "original");
      $("recap-preview-caption").classList.toggle("hidden", $("recap-caption-style").value === "off");
    }
    basicVoice() {
      return $("recap-voice-provider").value === "advanced" ? null : { voiceProvider: $("recap-voice-provider").value, voiceId: $("recap-voice-id").value, cloneSourceVoice: false };
    }
    serialize() { return { voiceProvider: $("recap-voice-provider").value, voiceId: $("recap-voice-id").value, projectId: this.project?.id || "", signature: this.lastSignature }; }
    restore(saved) {
      if (!saved) return;
      if ([...$("recap-voice-provider").options].some((item) => item.value === saved.voiceProvider)) $("recap-voice-provider").value = saved.voiceProvider;
      this.setupVoiceOptions(saved.voiceId);
      if (saved.projectId) this.resumeProjectId = saved.projectId;
      this.lastSignature = saved.signature || "";
    }
    signature() {
      const p = this.callbacks.getPayload();
      return JSON.stringify([p.title, p.sourceVideoPath, p.targetDurationSec, p.voiceProvider, p.voiceId, p.voiceSpeed,
        p.recapPreset, p.recapNarrationLanguage, p.recapNarrationStyle, p.recapAspectRatio, p.recapFraming, p.recapCaptionStyle,
        p.recapMuteSourceAudio, p.allowShotReuse, p.visualLeadSec, p.viralOptimization, p.viralAngleSetting, p.retentionAggressiveness, p.spoilerControl, p.loopEnding]);
    }
    isFresh() { return this.signature() === this.lastSignature; }
    editorialAvailable() { return Boolean(this.project?.recapEditorial?.hooks?.length && this.isFresh()); }
    selectionFresh() {
      const editorial = this.project?.recapEditorial;
      if (!editorial?.hooks?.length) return true;
      return $("recap-setup-angle").value === editorial.selectedAngleId
        && this.root.querySelector('input[name="recap-setup-hook"]:checked')?.value === editorial.selectedHookId;
    }
    canExport() { return this.result?.status === "review_ready" && this.isFresh() && this.selectionFresh(); }
    nextLabel(step) {
      if (step < 4) return ["Chọn nội dung", "Chọn giọng và âm thanh", "Chọn hình và phụ đề"][step - 1];
      if (step === 4) return "Phân tích và tạo hook";
      if (step === 5) return this.editorialAvailable() ? "Dựng draft với hook đã chọn" : "Tạo hook từ nguồn";
      if (this.result?.status === "completed" && this.isFresh()) return "Mở video trong Studio";
      return this.canExport() ? "Duyệt draft và xuất bản cuối" : "Dựng lại draft";
    }
    updateSummary() {
      if (!this.active) return;
      const voice = this.basicVoice();
      const rows = [["Nguồn", $("source-video-path").value.split(/[\\/]/).pop() || "Chưa chọn"],
        ["Nội dung", { recap: "Recap", review: "Review", explain: "Giải thích" }[$("recap-preset").value]],
        ["Mục tiêu", `${$("target-duration").value} giây`], ["Lời kể", $("recap-narration-language").value === "vi" ? "Tiếng Việt" : "Tiếng Anh (US)"],
        ["Giọng", voice ? $("recap-voice-id").selectedOptions[0]?.textContent || "Chưa chọn" : "Thiết kế / clone"], ["Âm thanh gốc", $("recap-mute-source-audio").checked ? "Tắt hoàn toàn" : "Giữ nhỏ dưới lời kể"],
        ["Khung hình", $("recap-aspect-ratio").value === "9:16" ? "9:16 · 1080 × 1920" : "Khung gốc"],
        ["Phụ đề", { off: "Tắt", phrase: "Cụm từ", karaoke: "Highlight từng từ" }[$("recap-caption-style").value]],
        ["Hook", $("recap-editorial-selection").value === "manual" ? "Bạn chọn sau khi xem thử" : "AI tự chọn"]];
      $("recap-setup-summary-values").innerHTML = rows.map(([label, value]) => `<dt>${label}</dt><dd>${escape(value)}</dd>`).join("");
      $("recap-setup-cache-note").textContent = this.project ? this.isFresh() ? "Đã có kết quả phân tích; tiếp tục dùng dữ liệu đã lưu." : "Thiết lập đã thay đổi. Cần tạo lại phần phụ thuộc trước khi xuất." : "Lựa chọn được lưu khi bạn chuyển bước.";
    }
    error(message = "") {
      $("recap-setup-error").textContent = message; $("recap-setup-error").classList.toggle("hidden", !message);
      if (message) this.callbacks.toast(message);
    }
    validate(step) {
      this.error();
      if (!$("project-title").value.trim() && step === 1) { this.error("Hãy đặt tên dự án."); return false; }
      if (!$("source-video-path").value.trim() && step === 1) { this.error("Hãy chọn video nguồn trước."); return false; }
      const duration = Number($("target-duration").value);
      if (step === 2 && (!Number.isFinite(duration) || duration < 15 || duration > 600)) { this.error("Thời lượng cần nằm trong 15–600 giây."); return false; }
      if (step === 3) {
        const p = this.callbacks.getPayload();
        if (p.recapNarrationLanguage === "vi" && p.voiceProvider === "kokoro") { this.error("Kokoro chưa hỗ trợ tiếng Việt. Hãy chọn Edge Neural hoặc giọng phù hợp khác."); return false; }
        if (this.basicVoice() && !this.basicVoice().voiceId) { this.error("Hãy chọn giọng đọc hoặc tải danh sách giọng."); return false; }
      }
      return true;
    }
    setupVoiceOptions(preferred = "") {
      let provider = $("recap-voice-provider").value;
      const language = $("recap-narration-language").value;
      const kokoroOption = [...$("recap-voice-provider").options].find((option) => option.value === "kokoro");
      kokoroOption.disabled = language === "vi";
      let switched = false;
      if (provider === "kokoro" && language === "vi") { provider = "edge_neural"; $("recap-voice-provider").value = provider; switched = true; }
      const choices = provider === "edge_neural" ? language === "vi"
        ? [["vi-VN-NamMinhNeural", "Nam Minh · giọng nam"], ["vi-VN-HoaiMyNeural", "Hoài My · giọng nữ"]]
        : [["en-US-ChristopherNeural", "Christopher · giọng nam"], ["en-US-JennyNeural", "Jenny · giọng nữ"], ["en-US-GuyNeural", "Guy · giọng nam"]]
        : provider === "kokoro" ? [["am_adam", "Adam · giọng nam"], ["af_heart", "Heart · giọng nữ"]] : [];
      if (preferred && !choices.some(([id]) => id === preferred) && (provider !== "edge_neural" || preferred.startsWith(language === "vi" ? "vi-VN-" : "en-US-"))) choices.push([preferred, preferred]);
      $("recap-voice-id").innerHTML = choices.map(([id, name]) => `<option value="${escape(id)}">${escape(name)}</option>`).join("");
      if (choices.some(([id]) => id === preferred)) $("recap-voice-id").value = preferred;
      $("recap-voice-id").closest(".recap-field").classList.toggle("hidden", provider === "advanced");
      $("recap-original-voice").classList.toggle("hidden", provider !== "advanced");
      if (provider === "advanced") $("recap-voice-extra").open = true;
      $("recap-voice-message").textContent = switched ? "Đã chọn Edge Neural để kể tiếng Việt." : !choices.length && provider !== "advanced" ? "Bấm Tải thêm giọng để chọn giọng từ provider." : "";
      this.loadedVoiceKey = `${provider}:${language}`;
    }
    async loadVoices() {
      const provider = $("recap-voice-provider").value, language = $("recap-narration-language").value;
      if (provider === "advanced") return;
      const requestId = ++this.voiceRequest, selected = $("recap-voice-id").value;
      $("recap-voice-message").textContent = "Đang tải danh sách giọng...";
      try {
        const voices = await window.cineviral.listVoices(provider);
        if (requestId !== this.voiceRequest || this.loadedVoiceKey !== `${provider}:${language}`) return;
        const visible = (voices || []).filter((voice) => provider !== "edge_neural" || (voice.voice_id || voice.id || "").startsWith(language === "vi" ? "vi-VN-" : "en-US-"));
        if (!visible.length) throw new Error("Chưa có giọng phù hợp. Kiểm tra cấu hình provider hoặc chọn Edge Neural.");
        $("recap-voice-id").innerHTML = visible.map((voice) => `<option value="${escape(voice.voice_id || voice.id)}">${escape(voice.name || voice.voice_id || voice.id)}</option>`).join("");
        if ([...$("recap-voice-id").options].some((voice) => voice.value === selected)) $("recap-voice-id").value = selected;
        $("recap-voice-message").textContent = `Có ${visible.length} giọng phù hợp.`; this.callbacks.persist(); this.callbacks.refresh();
      } catch (error) { if (requestId === this.voiceRequest) $("recap-voice-message").textContent = error.message; }
    }
    async perform(action, { kind = "recap" } = {}) {
      if (this.callbacks.isBusy()) return;
      this.lastAction = { action, kind };
      this.runtime = { running: true, kind, cancellable: kind !== "voice", startedAt: Date.now(), stageStartedAt: Date.now(), lastActivityAt: Date.now(),
        title: kind === "voice" ? "Đang tạo audio nghe thử" : "Đang chuẩn bị tác vụ recap", detail: "Tiến độ xử lý sẽ hiển thị tại đây." };
      this.renderRuntime(); this.root.scrollTop = 0;
      clearInterval(this.runtimeTimer); this.runtimeTimer = setInterval(() => this.renderRuntime(), 1000);
      this.error(); this.callbacks.busy(true); this.callbacks.cancellable(this.runtime.cancellable);
      try {
        await action();
        this.runtime.title = this.result?.status === "quality_blocked" ? stages.quality_blocked
          : this.result?.status === "editorial_ready" ? "Đã tạo hook · sẵn sàng chọn mở đầu"
          : this.result?.status === "completed" ? stages.completed : "Đã xử lý xong · sẵn sàng duyệt";
        this.runtime.outcome = this.result?.status === "quality_blocked" ? "blocked" : "done";
        if (this.runtime.outcome === "done") this.runtime.detail = this.result?.status === "completed"
          ? this.result.finalVideoPath || "Video đã xuất xong."
          : this.result?.status === "editorial_ready" ? "Chọn góc kể và hook ở bước tiếp theo." : "Bạn có thể xem và duyệt kết quả.";
        if (kind === "voice") { this.runtime.title = "Audio nghe thử đã sẵn sàng"; this.runtime.detail = "Bạn có thể đổi giọng và nghe thử lại."; this.runtime.outcome = "done"; }
      }
      catch (error) {
        const cancelled = /cancel|abort|đã dừng|đã hủy/i.test(`${error.kind || ""} ${error.name || ""} ${error.message}`);
        this.runtime.outcome = cancelled ? "cancelled" : "error";
        this.runtime.title = cancelled ? "Đã dừng xử lý" : "Xử lý thất bại";
        this.runtime.detail = error.message;
        const settings = this.callbacks.getSettings?.() || {};
        const antigravity = this.runtime.providerLabel === "Antigravity CLI" || settings.aiProvider === "antigravity_cli";
        this.runtime.providerUnavailable = !cancelled && kind === "recap" && antigravity &&
          (error.kind === "provider_unavailable" || /No capacity available|hết công suất|hết thời gian chờ trước khi bắt đầu xem video|\b503\b/i.test(error.message));
        if (this.runtime.providerUnavailable) this.runtime.title = "Antigravity chưa sẵn sàng";
        this.error(error.message); this.callbacks.log(error.message, "ERROR");
        if (this.project?.id) this.project = await window.cineviral.getProject(this.project.id).catch(() => this.project);
      } finally {
        clearInterval(this.runtimeTimer); this.runtime.running = false; this.runtime.endedAt = Date.now();
        this.callbacks.busy(false); this.callbacks.persist(); this.callbacks.refresh(); this.renderRuntime();
      }
    }
    async resumeWithVertex() {
      if (this.callbacks.isBusy() || !this.runtime?.providerUnavailable || !this.project?.id || !this.lastAction) return;
      const settings = this.callbacks.getSettings?.() || {};
      if (!settings.vertexCredentialPath && !settings.vertexProjectId) return this.callbacks.openSettings?.();
      const payload = this.callbacks.getPayload();
      if (payload.sourceVideoPath !== this.project.sourceVideoPath || payload.title !== this.project.title) {
        this.error("Nguồn hoặc tên dự án đã thay đổi. Hãy chạy lại từ bước Hình & phụ đề."); return;
      }
      const previous = this.lastAction;
      await this.perform(async () => {
        await this.callbacks.switchProvider("vertex_ai");
        this.callbacks.log(`Đã chuyển sang Vertex AI; tiếp tục dự án ${this.project.id}, giữ dữ liệu nguồn đã xử lý.`);
        await previous.action();
      }, { kind: previous.kind });
    }
    handleProgress(payload) {
      const run = this.runtime;
      if (!run?.running) return;
      const stage = payload.stage || payload.step;
      if (stages[stage] && stage !== run.stage) {
        run.stage = stage; run.title = stages[stage]; run.stageStartedAt = Date.now();
        run.chunkIndex = null; run.chunkCount = null; run.chunkPart = null; run.aiPending = false;
        run.aiStartedAt = null; run.aiTimeoutMs = null; run.inactivityTimeoutMs = null;
        run.pid = null; run.providerLabel = "";
        run.model = "";
      }
      if (payload.chunkIndex) { if (payload.chunkIndex !== run.chunkIndex) run.chunkPart = null; run.chunkIndex = payload.chunkIndex; run.chunkCount = payload.chunkCount; }
      if (payload.chunkPart) run.chunkPart = payload.chunkPart;
      if (payload.aiRequestStarted) {
        run.aiPending = true; run.lastActivityAt = null; run.pid = null;
        run.aiTimeoutMs = null; run.inactivityTimeoutMs = null;
      }
      if (payload.aiRequestFinished) { run.aiPending = false; run.pid = null; }
      for (const key of ["aiStartedAt", "lastActivityAt", "aiTimeoutMs", "inactivityTimeoutMs", "providerLabel", "model", "pid"]) {
        if (payload[key] != null) run[key] = payload[key];
      }
      if (!payload.heartbeat) {
        if (payload.message) run.detail = payload.message;
        if (payload.lastActivityAt == null) run.lastActivityAt = Date.now();
      }
      this.renderRuntime();
    }
    renderRuntime() {
      const run = this.runtime; if (!run) return;
      const now = run.endedAt || Date.now(), elapsed = now - run.startedAt;
      const waitingMs = now - (run.lastActivityAt || run.aiStartedAt || run.stageStartedAt);
      const panel = $("recap-run-status"); panel.classList.remove("hidden"); panel.dataset.outcome = run.outcome || "running";
      $("recap-run-stage").textContent = `${run.running && run.stopping ? "Đang gửi yêu cầu dừng…" : run.title}${run.running && run.chunkIndex ? ` · Chunk ${run.chunkIndex}/${run.chunkCount}${run.chunkPart ? ` · Phần ${run.chunkPart}/2` : ""}` : ""}`;
      $("recap-run-detail").textContent = run.detail || "";
      $("recap-run-timing").textContent = [`Tổng thời gian ${duration(elapsed)}`, run.running ? `Công đoạn này ${duration(now - run.stageStartedAt)}` : "",
        run.running && run.providerLabel ? run.providerLabel : "", run.running && run.pid ? `PID ${run.pid}` : ""].filter(Boolean).join(" · ");
      if (run.running && run.model) $("recap-run-timing").textContent += ` · ${run.model}`;
      let wait = "";
      if (run.running && run.aiPending) {
        wait = `${run.lastActivityAt ? "Phản hồi gần nhất cách đây" : "Đang chờ phản hồi AI"} ${duration(waitingMs)}.`;
        if (waitingMs >= 60000) wait += " Chưa có phản hồi mới; chưa thể kết luận tiến trình bị treo.";
        const remaining = [run.aiTimeoutMs ? run.aiTimeoutMs - (now - run.aiStartedAt) : Infinity,
          run.inactivityTimeoutMs ? run.inactivityTimeoutMs - waitingMs : Infinity];
        const deadline = Math.min(...remaining);
        if (Number.isFinite(deadline)) wait += deadline > 0 ? ` Còn tối đa ${duration(deadline)} trước giới hạn chờ hiện tại.` : " Đã đến giới hạn chờ; đang chờ tiến trình trả trạng thái.";
      } else if (!run.running && ["error", "cancelled"].includes(run.outcome)) wait = run.providerUnavailable
        ? "Antigravity chưa cung cấp được lượt xử lý. Bạn có thể chuyển provider để tiếp tục dự án đang dở."
        : run.kind === "voice" ? "Kiểm tra nguồn giọng rồi bấm Nghe thử giọng để chạy lại." : "Bấm lại để tiếp tục. Các chunk phân tích đã hoàn tất sẽ được dùng lại.";
      $("recap-run-wait").textContent = wait; $("recap-run-wait").classList.toggle("hidden", !wait);
      $("recap-run-stop").classList.toggle("hidden", !run.running || !run.cancellable); $("recap-run-stop").disabled = Boolean(run.stopping) || !run.cancellable;
      const recover = !run.running && run.providerUnavailable && this.project?.id && this.lastAction;
      const settings = this.callbacks.getSettings?.() || {}, vertexConfigured = Boolean(settings.vertexCredentialPath || settings.vertexProjectId);
      $("recap-provider-recovery").classList.toggle("hidden", !recover);
      $("recap-resume-vertex").classList.toggle("hidden", !vertexConfigured);
      $("recap-resume-vertex").disabled = Boolean(run.running);
      $("recap-provider-settings").classList.toggle("hidden", vertexConfigured);
      $("recap-provider-recovery-note").textContent = vertexConfigured
        ? "Đổi provider mặc định sang Vertex AI và dùng lại dự án này. Vertex có thể phát sinh phí Google Cloud."
        : "Cấu hình Vertex AI trong Cài đặt để dùng provider khác. Dữ liệu nguồn của dự án vẫn được giữ lại.";
      if (this.active) {
        if (run.running) this.status.textContent = $("recap-run-stage").textContent;
        $("sidecar-status").textContent = run.running ? "Recap: Đang xử lý" : "Bộ xử lý cục bộ: Sẵn sàng";
        $("cancel-render").textContent = run.running ? "Dừng xử lý" : "Dừng xuất";
      }
    }
    async prepare() {
      if (![1, 2, 3].every((step) => this.validate(step))) return;
      await this.perform(async () => {
        const payload = this.callbacks.getPayload();
        if (!this.project && this.resumeProjectId) this.project = await window.cineviral.getProject(this.resumeProjectId).catch(() => null);
        if (!this.project || this.project.sourceVideoPath !== payload.sourceVideoPath || this.project.title !== payload.title) {
          const created = await window.cineviral.createProject(payload); this.project = created.project;
          this.callbacks.log(`Đã tạo dự án recap: ${this.project.id}`); this.result = null;
        } else {
          await window.cineviral.updateProjectSettings(this.project.id, { ...payload, recapSelectedAngleId: this.isFresh() ? this.project.recapSelectedAngleId : "", recapSelectedHookId: this.isFresh() ? this.project.recapSelectedHookId : "", recapEditorialApprovedKey: "" });
        }
        await this.run({ recapEditorialSelection: "manual", recapWorkflow: "review" });
        if (this.result.status === "editorial_ready") {
          this.renderEditorial(); this.callbacks.go(5);
          if (payload.recapEditorialSelection === "auto") await this.buildDraftInternal();
        } else {
          this.callbacks.go(6);
          if (this.canExport() && payload.recapWorkflow === "full_auto") await this.exportInternal();
        }
        await this.callbacks.projectChanged();
      });
    }
    async run(options = {}) {
      const payload = this.callbacks.getPayload();
      this.result = null;
      this.result = await window.cineviral.runRecap(this.project.id, { recapDraftOnly: true, voiceSpeed: payload.voiceSpeed, ...options });
      this.project = await window.cineviral.getProject(this.project.id); this.lastSignature = this.signature();
      this.callbacks.persist(); this.renderEditorial(); this.renderReview();
    }
    async buildDraftInternal() {
      const editorial = this.project?.recapEditorial;
      const angleId = $("recap-setup-angle").value, hookId = this.root.querySelector('input[name="recap-setup-hook"]:checked')?.value;
      if (!editorial || !hookId) throw new Error("Hãy chọn một hook đã có bản nghe thử.");
      if (angleId !== editorial.selectedAngleId) {
        await window.cineviral.chooseRecapEditorial(this.project.id, { angleId, hookId, approve: false });
        await this.run({ recapEditorialSelection: "manual", recapWorkflow: "review" });
        this.callbacks.go(5); return;
      }
      await window.cineviral.chooseRecapEditorial(this.project.id, { angleId, hookId, approve: true });
      await this.run({ recapEditorialSelection: "manual", recapWorkflow: "review" });
      this.callbacks.go(this.result.status === "editorial_ready" ? 5 : 6);
      if (this.result.status === "review_ready" && $("recap-workflow-mode").value === "full_auto") await this.exportInternal();
    }
    async exportInternal() {
      if (!this.canExport()) throw new Error("Draft chưa đạt kiểm tra hoặc thiết lập đã thay đổi. Hãy dựng và kiểm tra lại.");
      this.result = null;
      this.result = await window.cineviral.renderRecapFinal(this.project.id);
      this.project = await window.cineviral.getProject(this.project.id); this.lastSignature = this.signature();
      if (this.result.status === "completed") this.callbacks.log(`Đã xuất video recap: ${this.result.finalVideoPath}`, "SUCCESS");
      this.renderReview(); await this.callbacks.projectChanged();
    }
    async next(step) {
      if (!this.validate(step)) return;
      if (step < 4) return this.callbacks.go(step + 1);
      if (step === 4 || !this.isFresh() || !this.project) return this.prepare();
      if (step === 5) return this.perform(() => this.buildDraftInternal());
      if (!this.selectionFresh() && this.editorialAvailable()) return this.perform(() => this.buildDraftInternal());
      if (this.result?.status === "completed") return this.callbacks.openStudio(this.project);
      if (this.canExport()) return this.perform(() => this.exportInternal());
      if (this.result?.status === "quality_blocked" && this.isFresh()) { this.error("Draft còn lỗi cần sửa. Bấm Sửa / kiểm tra lại draft trước khi xuất."); return; }
      return this.prepare();
    }
    renderEditorial() {
      const editorial = this.project?.recapEditorial;
      $("recap-setup-editorial-empty").classList.toggle("hidden", Boolean(editorial?.hooks?.length));
      $("recap-setup-editorial").classList.toggle("hidden", !editorial?.hooks?.length);
      if (!editorial?.hooks?.length) return;
      $("recap-setup-angle").innerHTML = editorial.angles.map((angle) => `<option value="${escape(angle.id)}">${escape(angle.title)}</option>`).join("");
      $("recap-setup-angle").value = editorial.selectedAngleId;
      this.angleDescription();
      $("recap-setup-hooks").innerHTML = editorial.hooks.map((hook) => `<article class="recap-hook-card"><label><input type="radio" name="recap-setup-hook" value="${escape(hook.id)}" ${hook.id === editorial.selectedHookId ? "checked" : ""}>${escape(hook.text)}</label><p>${Number(hook.durationSec).toFixed(1)} giây · Độ phù hợp ${hook.score}/10</p><video controls preload="metadata" src="${escape(this.callbacks.fileUrl(hook.videoPath))}"></video></article>`).join("");
    }
    angleDescription() {
      const angle = this.project?.recapEditorial?.angles.find((item) => item.id === $("recap-setup-angle").value);
      $("recap-setup-angle-detail").textContent = angle?.central_question || "";
      const changed = angle && angle.id !== this.project.recapEditorial.selectedAngleId;
      $("recap-setup-hooks").classList.toggle("hidden", Boolean(changed));
      if (changed) $("recap-setup-angle-detail").textContent += " · Bấm Tạo hook để có bản thử cho góc kể này.";
    }
    renderReview() {
      if (!this.active) return;
      const recap = this.project?.recap || {}, fresh = this.isFresh() && this.selectionFresh(), status = this.result?.status;
      const message = !this.project ? "Chưa dựng draft." : !fresh ? "Thiết lập đã thay đổi. Hãy dựng lại trước khi xuất." : status === "quality_blocked" ? "Chưa đạt kiểm tra chất lượng; chưa xuất bản cuối." : status === "review_ready" ? "Draft đã đạt kiểm tra. Xem trước rồi duyệt xuất." : status === "completed" ? "Đã xuất bản cuối." : "Chọn hook rồi dựng draft để kiểm tra.";
      $("recap-setup-quality").textContent = [message, recap.duration ? `Thời lượng: ${Number(recap.duration.actual).toFixed(1)} / ${recap.duration.target} giây.` : "", recap.qualityScore != null ? `Điểm review: ${Number(recap.qualityScore).toFixed(2)}/1.` : "", ...(recap.qualityIssues || []).map((issue) => `${issue.severity}: ${issue.description}`)].filter(Boolean).join(" ");
      const draft = recap.draftVideoPath || this.result?.draftVideoPath;
      $("recap-setup-draft").classList.toggle("hidden", !draft);
      if (draft && $("recap-setup-draft").dataset.path !== draft) { $("recap-setup-draft").src = this.callbacks.fileUrl(draft); $("recap-setup-draft").dataset.path = draft; }
      $("recap-setup-recheck").classList.toggle("hidden", !this.project || !fresh || !["review_ready", "quality_blocked"].includes(status));
      $("recap-setup-studio").classList.toggle("hidden", !this.project);
      $("recap-setup-script").textContent = (recap.speechUnits || []).map((unit, i) => `${i + 1}. ${unit.text}`).join("\n\n");
    }
    bindEvents() {
      this.root.addEventListener("click", (event) => {
        const preset = event.target.closest("[data-recap-preset]");
        if (preset) { $("recap-preset").value = preset.dataset.recapPreset; $("recap-preset").dispatchEvent(new Event("change", { bubbles: true })); }
        const duration = event.target.closest("[data-recap-duration]");
        if (duration) { $("recap-duration-preset").value = duration.dataset.recapDuration; $("target-duration").value = duration.dataset.recapDuration; $("target-duration").dispatchEvent(new Event("change", { bubbles: true })); }
      });
      this.root.addEventListener("change", (event) => {
        if (event.target.id === "recap-narration-language" || event.target.id === "recap-voice-provider") {
          this.voiceRequest++; this.setupVoiceOptions();
          if (["elevenlabs", "windows_local"].includes($("recap-voice-provider").value)) this.loadVoices();
        }
        if (event.target.id === "recap-setup-angle") this.angleDescription();
        this.callbacks.persist(); this.callbacks.refresh();
      });
      this.root.addEventListener("input", () => { this.updateSummary(); this.renderReview(); this.callbacks.persist(); });
      $("recap-voice-refresh").addEventListener("click", () => this.loadVoices());
      $("recap-voice-preview").addEventListener("click", () => {
        if (!this.validate(3)) return;
        return this.perform(async () => {
        const p = this.callbacks.getPayload();
        const result = await window.cineviral.testVoice({ provider: p.voiceProvider, voiceId: p.voiceId, language: p.recapNarrationLanguage,
          text: p.recapNarrationLanguage === "vi" ? "Thị trấn cứ ngỡ mọi chuyện đã ổn. Nhưng sự thật còn ở phía trước." : "The town thought the problem was over. Then they discovered what was really happening." });
        if (!result?.outputPath) throw new Error("Chưa nhận được audio nghe thử.");
        await this.callbacks.playAudio(result.outputPath);
        }, { kind: "voice" });
      });
      $("recap-setup-regenerate").addEventListener("click", () => this.perform(async () => {
        const hookId = this.project?.recapEditorial?.selectedHookId;
        await window.cineviral.chooseRecapEditorial(this.project.id, { angleId: $("recap-setup-angle").value, hookId, approve: false });
        await this.run({ recapEditorialSelection: "manual", recapWorkflow: "review" });
      }));
      $("recap-setup-recheck").addEventListener("click", () => this.perform(async () => { await this.run({ recapRecheck: true, recapWorkflow: "review" }); }));
      $("recap-setup-studio").addEventListener("click", () => { if (this.project) this.callbacks.openStudio(this.project); });
    }
    resetStep(step) {
      if (step === 1) {
        $("project-title").value = "project_default"; $("source-video-path").value = "";
        delete $("source-video-path").dataset.sourceKind; delete $("source-video-path").dataset.sourceOriginUrl;
        $("source-download-url").value = ""; this.project = null; this.resumeProjectId = "";
      }
      if (step === 2) { $("recap-preset").value = "recap"; $("target-duration").value = "75"; $("recap-editorial-selection").value = "manual"; }
      if (step === 3) {
        $("recap-voice-provider").value = "edge_neural"; $("recap-narration-language").value = "en";
        $("recap-narration-style").value = "natural"; $("voice-speed").value = "1.00"; $("recap-mute-source-audio").checked = false;
        this.setupVoiceOptions();
      }
      if (step === 4) { $("recap-aspect-ratio").value = "9:16"; $("recap-framing").value = "fit_blur"; $("recap-caption-style").value = "phrase"; $("recap-visual-lead").value = "0.25"; $("recap-allow-reuse").checked = false; }
      if (step === 6) $("recap-workflow-mode").value = "review";
      this.result = null; this.lastSignature = ""; this.renderEditorial(); this.renderReview();
    }
  }
  window.RecapSetupUi = { labels, create: (callbacks) => new RecapSetupUi(callbacks) };
})();
