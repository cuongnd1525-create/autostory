// True Crime Auto Story engine choices, shared by the setup UI (renderer, loaded with a
// <script> tag) and tests (require()).
//
//   V2 — Legacy pipeline (no project field: existing behavior).
//   V3 — Source Story Model + text-only Story Design (autoStoryContractVersion: 3).
//   V4 — Source Story Model + StoryScope + media-grounded Editorial Director
//        (autoStoryContractVersion: 4, autoStoryConfig.editorialArchitecture: "scope_media_director").
//
// A V3/V4 run rewrites project.autoStoryContractVersion to 3 for the renderer and stores the
// architecture it used in project.autoStoryEditorialArchitecture, so the engine of an existing
// project is read from the architecture (same precedence as autoStoryV3Pipeline.editorialArchitecture).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AutoStoryEngine = api;
})(typeof self !== "undefined" ? self : this, function () {
  const SCOPE_MEDIA_DIRECTOR = "scope_media_director";
  const LEGACY_TEXT_DESIGN = "legacy_text_design";

  const ENGINES = {
    2: {
      value: "2",
      label: "V2 — Legacy (ổn định, đang chạy production)",
      shortLabel: "V2 Legacy",
      badge: "AutoStory V2",
      badgeClass: "v2",
      contractVersion: undefined,
      editorialArchitecture: "",
      hint: "V2: pipeline production hiện tại (ổn định). Chọn V3 hoặc V4 để dùng story-model mới."
    },
    3: {
      value: "3",
      label: "V3 — Story Model (hiểu toàn nguồn, story beats, phối narrator/âm gốc)",
      shortLabel: "V3 Story Model",
      badge: "AutoStory V3",
      badgeClass: "",
      contractVersion: 3,
      editorialArchitecture: "",
      hint: "V3: hiểu toàn bộ nguồn một lần (Source Story Model), thiết kế story beats bằng văn bản, kiểm tra narrator (grounding/spoiler) và duck âm gốc thay vì tắt. Nên đặt số kịch bản = 1 khi test lần đầu."
    },
    4: {
      value: "4",
      label: "V4 — StoryScope + Editorial Director (chọn 1 câu chuyện, AI xem video để dựng)",
      shortLabel: "V4 StoryScope + Director",
      badge: "AutoStory V4",
      badgeClass: "v4",
      contractVersion: 4,
      editorialArchitecture: SCOPE_MEDIA_DIRECTOR,
      hint: "V4: sau Source Story Model, StoryScope chọn đúng một câu chuyện trong nguồn, rồi Editorial Director xem video của phạm vi đó (media-grounded) để tự dựng EDL, thay cho thiết kế story beats chỉ bằng văn bản của V3. Mặc định 1 kịch bản khi chọn lần đầu."
    }
  };

  function engine(value) {
    return ENGINES[String(value)] || ENGINES[2];
  }

  /**
   * Project fields for a new Auto Story project.
   * V2: no contract field; V3: contract 3; V4: contract 4 + editorialArchitecture in autoStoryConfig.
   */
  function projectFields(value) {
    const selected = engine(value);
    return {
      autoStoryContractVersion: selected.contractVersion,
      autoStoryConfigPatch: selected.editorialArchitecture ? { editorialArchitecture: selected.editorialArchitecture } : {}
    };
  }

  /** Architecture the backend will use (mirror of autoStoryV3Pipeline.editorialArchitecture). */
  function resolvedArchitecture(project = {}) {
    const explicit = project?.autoStoryConfig?.editorialArchitecture;
    if (explicit) return explicit;
    if (Number(project?.autoStoryContractVersion) === 4) return SCOPE_MEDIA_DIRECTOR;
    if (project?.autoStoryEditorialArchitecture) return project.autoStoryEditorialArchitecture;
    return LEGACY_TEXT_DESIGN;
  }

  /** Engine of an existing project (badge in Studio). */
  function engineOfProject(project = {}) {
    const contract = Number(project?.autoStoryContractVersion);
    const storyModel = contract === 3 || contract === 4 || project?.autoStoryPipelineVersion === "source-story-v3";
    if (storyModel && resolvedArchitecture(project) === SCOPE_MEDIA_DIRECTOR) return ENGINES[4];
    return storyModel ? ENGINES[3] : ENGINES[2];
  }

  /**
   * Output count when the engine select changes. V3 keeps its old convenience (2 -> 1).
   * V4 defaults to 1 the first time it is chosen; later the user's count is left alone.
   */
  function outputCountOnSelect(value, currentCount, v4Defaulted = false) {
    const count = String(currentCount || "2");
    if (String(value) === "4") return v4Defaulted ? { count, v4Defaulted: true } : { count: "1", v4Defaulted: true };
    if (String(value) === "3" && count === "2") return { count: "1", v4Defaulted };
    return { count, v4Defaulted };
  }

  return { ENGINES, SCOPE_MEDIA_DIRECTOR, LEGACY_TEXT_DESIGN, engine, projectFields, resolvedArchitecture, engineOfProject, outputCountOnSelect };
});
