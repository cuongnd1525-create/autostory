# AutoStory v3 — UI Integration Report

**Goal:** let a real user pick AutoStory V3 in the UI and run the full flow (create → select V3 → configure → Generate → progress → draft → review → final) without hand-editing `project.json` and without any `if (true)` hack.

**Status:** implemented and committed. The version selection flows UI → payload root → `createProject` → Runner → `autoStoryFastService.run()` → `autoStoryV3Pipeline.run()`. Routing/persistence and the deterministic core are unit-tested and passing here. The live GUI + Vertex render (Step 13) could not be executed from this cloud container — exact reason and run steps in §7.

---

## 1. UI Changes

A native **AutoStory Engine** selector was added to the existing AutoStory settings card (`#auto-story-options`), directly above the duration/output grid — the same card where target duration, output count, narration style and audio balance already live. No new settings screen.

- `index.html`: a labeled `<select id="auto-story-engine-version">` with `V2 — Legacy` (default) and `V3 — Story Model`, plus a live hint (`#auto-story-engine-hint`). Styled with a new `.auto-story-engine-field` card in `styles.css` reusing the app's tokens (`--border`, `--panel-3`, `--radius-card`, `--border-active`).
- The review/summary line now shows the engine (`V3 Story Model · 1 video · 65–90s · …`).
- The AutoStory **status panel** now shows an `AutoStory V3` / `AutoStory V2` badge in its heading and an **"Mở thư mục phân tích" (Open Analysis Folder)** button (wired to the existing `openProjectFolder` IPC) so v3 artifacts are one click away.
- Convenience: selecting V3 auto-sets output count to **1** if it was still at the default 2 (per your "default 1 for the first v3 test").

## 2. Persistence

The selection becomes `project.autoStoryContractVersion` at the **project root** (not inside `autoStoryConfig`), because the live service checks `project.autoStoryContractVersion`. In `readProjectPayload()`:

```js
autoStoryContractVersion: isAutoStoryMode(setupMode) && Number(el.autoStoryEngineVersion?.value) === 3 ? 3 : undefined,
```

- V3 → `autoStoryContractVersion: 3` persisted via the normal `project:create` IPC → `projectStore.createProject`. No JSON is written from the renderer.
- V2 / legacy → field left **undefined** (dropped by IPC serialization) → existing behavior preserved exactly; no silent migration.
- The selector value also persists in the existing setup **draft** (`writeSetupDraft`/apply-draft, key `autoStoryEngineVersion`) so it survives app restarts, and `updateAutoStoryEngineHint()` keeps the hint in sync.

## 3. Routing (verified)

```
Setup UI  (#auto-story-engine-version = V3)
  └─ readProjectPayload() → payload.autoStoryContractVersion = 3   [src/renderer.js]
       └─ window.cineviral.createProject(payload)                  [preload: project:create]
            └─ projectStore.createProject(...)  → project.json (root field)   [electron/main.js:687]
  └─ runAutoStoryPipeline(projectId)                               [preload: autoStory:run]
       └─ analysisWorkflow === "vertex_auto_story" → new AutoStoryRunner(...).run()  [main.js:712]
            └─ producer.run() === autoStoryFastService.run()
                 └─ if (project.autoStoryContractVersion === 3) → autoStoryV3Pipeline.run()   ← FORK
            └─ consumer.auditDrafts()
                 └─ if (contractVersion === 2 || 3) → autoStorySourceReview.run()  (draft-watching critic)
```

Confirmed by test that a project carrying `autoStoryContractVersion: 3` reaches `autoStoryV3Pipeline.run` with `outputCount: 1`, while `2`/legacy reach the v2 path.

## 4. Modified / Added Files

| File | Change |
|---|---|
| `src/index.html` | Added the AutoStory Engine `<select>` + hint inside `#auto-story-options`. |
| `src/styles.css` | Added `.auto-story-engine-field` / `.auto-story-engine-badge` / `.auto-story-open-folder` styles (native tokens). |
| `src/renderer.js` | Bound the new elements; persist/restore in setup draft; `autoStoryContractVersion` at payload root for V3; engine label in review summary; `updateAutoStoryEngineHint()`; V3→outputCount=1 convenience; version badge + Open-Analysis-Folder button in `renderAutoStoryStatus()`. |
| `electron/services/autoStoryV3Pipeline.js` | Added `[V3]` stage markers via the existing `onProgress` (Source Story Model / Story Design / Beat Casting / Audio roles / Narration / Narration gates / Script ready) for observability. |
| `tests/autoStoryV3Routing.test.js` | New — routing/persistence/no-fallback tests. |

No changes to the v3 story architecture, the Highlight renderer, or the v2 pipeline.

## 5. V2 Compatibility

- The selector defaults to **V2**; a V2 (or legacy no-field) project sets **no** `autoStoryContractVersion`, so the fork falls through to the exact current behavior.
- `settings.autoStoryContractV3` is **not** set globally — version is per-project only.
- The Runner still forces `autoStorySourceContract: true` (unchanged), so legacy AutoStory projects continue on the v2 source pipeline.
- Verified: `autoStoryFastService.test.js` and `autoStorySourceV2.test.js` (16/16) still pass; a legacy project routes to v2 in the routing test.

## 6. Tests (actually run here)

- `tests/autoStoryV3Routing.test.js` — **6/6 pass**: V3 project → v3 pipeline; v3 gets `outputCount: 1`; V2 → v2; legacy+sourceContract → v2 (no silent migration); fatal v3 error stays a v3 error (no silent fallback); `auditDrafts` v3 → draft-watching critic.
- `tests/autoStoryV3.test.js` — **22/22 pass** (deterministic v3 core, unchanged).
- Regression: `autoStoryFastService.test.js` pass; `autoStorySourceV2.test.js` 16/16; `ffmpegVideoDecoration`, `dubbingScriptService`, `voiceTimingPolicy`, `autoStorySchemaBoundary` pass. `node --check` passes on `src/renderer.js`, `index.html`-adjacent JS, and all touched services.
- **Not runnable here:** DOM-level tests of the renderer (no `jsdom` in this container) — the routing test drives the real service instead, which is the load-bearing path.

## 7. Real End-to-End Result (Step 13)

**Not executed from this environment — blocked, not skipped.** Three hard blockers in this cloud container:
1. **No GUI/display** — the Electron app can't be launched headlessly to click through Create → V3 → Generate.
2. **No Vertex AI credentials** — Pass 0 (Source Story Model), Story Design, and Narration all call Vertex; there's no `vertexProjectId`/service-account here.
3. **No source video** — no local true-crime/bodycam file to analyze/render.

So no `story-model.json` / `story-spine.json` / `beat-casting*.json` / `narration-gates*.json` / MP4 were produced here. Everything up to the Vertex boundary is verified (routing, persistence, deterministic compile → renderer contract).

**To run it on your machine (the DoD flow):**
1. `npm start`, create a project, pick a true-crime/bodycam source.
2. In AutoStory settings choose **V3 — Story Model**, set **output count = 1**, duration 65–90s, voice + captions.
3. Click **Generate**. Watch the log for `[V3] Source Story Model started/completed`, `[V3] Story Design completed`, `[V3] Beat Casting completed`, `[V3] Audio roles planned`, `[V3] Narration generated`, `[V3] Narration gates passed/repaired`, `[V3] Script N ready`, then draft render → review → final.
4. Use **Open Analysis Folder** on the status panel and confirm `auto-story-fast/story-model.json`, `story-spine.json`, `beat-casting-1.json`, `narration-gates-1.json`, and the rendered MP4.

If the run errors, it will surface as a clear `[V3]` error in the log (no fallback to V2) — send me the exact message and I'll fix the integration.

## 8. Remaining Issues

- **First live v3 run is unproven end-to-end** (§7). The Vertex passes follow the verified v2 `engine.ask` patterns but need one real run to confirm prompt/schema round-trips.
- **Changing an existing project's engine** isn't exposed — version is chosen at create time (the DoD flow). A per-project "switch engine" control on an existing project would need a small `updateProjectSettings` call; not required for the create→V3→generate flow, so deferred.
- **Coarse stepper**: the 4-phase `pipeline-stepper` (planning/editing/rendering/reviewing) still maps v3's phases coarsely; the detailed `[V3]` stages appear in the log, not as stepper nodes.
- `tests/autoStoryV3Routing.test.js` and `tests/autoStoryV3.test.js` aren't yet in the `package.json` `test` script (avoided editing it to prevent an mtime clash); add them with `node tests/autoStoryV3.test.js && node tests/autoStoryV3Routing.test.js`.
