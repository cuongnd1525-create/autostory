# AutoStory v3 — Implementation Report

**Goal:** make the output feel *edited, not generated*, by giving the existing multi-pass AutoStory pipeline one shared understanding of the whole source, enforceable editorial rules, and narrator/original-audio cooperation — implemented additively as **AutoStory v3**, gated behind `autoStoryContractVersion === 3` so **v2 is untouched**.

**Status:** committed to the repo. Deterministic core is unit-tested and passing (22/22, covering required Tests A–H); v2 regression tests re-run and green; AI-pass modules syntax-checked. Two files you had edited mid-session were correctly protected by the mtime guard, then re-applied onto your newer versions and re-committed.

---

## 1. What Changed

The v2 skeleton was kept exactly as-is. v3 adds a parallel path that runs only when selected:

```
SOURCE
 └─ Pass 0  SOURCE STORY MODEL  (one whole-source Vertex Flash pass, persisted+cached)
       people · events(tension,visualQuality,novelty,isReveal,audio) · quotes(epistemic) · audioEvents · tensionCurve
 └─ Pass 2  local NON-SPEECH AUDIO EVENTS (ffmpeg) + WORD TIMESTAMPS merged into the model
 └─ Pass 1  STORY DESIGN  (text-only Vertex Pro; beats, open loops, information budget — no video re-sent)
 └─ Pass 7  BEAT→CLIP CASTING (deterministic constraint satisfaction + purpose-dedup; no AI)
 └─ Pass 8  AUDIO-ROLE STATE MACHINE (deterministic: original / setup_then_original / narrator_over / mute)
 └─ Pass 3  NARRATION (info-gap only, Vertex Pro) → BLOCKING narration gate + ≤2 targeted repairs
 └─ COMPILE (reuses v2 compiler primitives) → Highlight renderer contract (+ emotion/prosody/duck)
 └─ RENDER: source audio DUCKED (sidechain), not muted; emotion reaches TTS
 └─ REVIEW: reuses the existing draft-watching critic
```

The design intentionally leaves the **v2 pipeline, Highlight renderer, subtitle/ASR, measured voice-fit, and ffmpeg infrastructure** in place and reuses them.

---

## 2. Files Modified

| File | What changed | Why |
|---|---|---|
| `electron/services/autoStoryFastService.js` | Added a v3 branch at the `run()` fork (before the v2 branch), gated on `autoStoryContractVersion === 3 \|\| settings.autoStoryContractV3`; extended the `auditDrafts()` guard to route v3 to the existing draft-watching critic. | Entry point for v3 without disturbing v2. |
| `electron/services/ffmpegService.js` | `mixVideoAudioWithVoice(...)` gained an optional `duck=false` param; when true it uses a **sidechaincompress** graph (mirroring the existing `mixVideoWithNarrationTrack`). Default false ⇒ byte-identical to before. | Real ducking on the highlight render path (Phase 13). |
| `electron/services/dubbingService.js` | (a) highlight fast-draft mix call passes `duck: project.mixer?.narrationDuckDefault === true`; (b) `getSegmentVoiceRenderOptions` now carries `emotionTag`/`prosody`; (c) voice-cache key includes them **only when present** (v2 cache stays stable); (d) `synthesizeDubbingVoice` resolves intent once and threads it into Edge (rate/pitch/volume deltas), ElevenLabs (performanceMode), and Kokoro (speed). | Duck-not-mute + emotion→TTS (Phases 12/13). Guarded so v2 (no emotionTag) is unchanged. |
| `electron/services/vertexAiService.js` | Added `createCachedContent(...)` (Vertex `cachedContents` REST) and an optional `cachedContent` param to `generateJsonFromFiles` that, when set, skips re-attaching media and adds `cachedContent` to the request body. Default undefined ⇒ unchanged. | Context-cache scaffolding (Phase 16). |

## 3. Files Added

| File | Purpose |
|---|---|
| `electron/services/autoStoryV3Taxonomy.js` | Narrative-role vocabulary, narrator-function/information-class/audio-strategy/epistemic enums, and the v3→v2 role + audio_mode mappers. |
| `electron/services/sourceStoryModelService.js` | Phase 0/1: `build()` (whole-source Vertex pass, cached), `normalize()` (pure enrichment: tension blended with audio events, word-timestamp windows, epistemic defaults), `load/persist`. |
| `electron/services/audioEventService.js` | Phase 2/3: spawns the python detector (defensive, returns `[]` on any failure) + loads ASR word timestamps. |
| `tools/audio_events.py` | Local ffmpeg (ebur128 + silencedetect) non-speech event detector: loud_spike / raised_voice / sudden_silence with normalized peak. |
| `electron/services/autoStoryV3Contracts.js` | Phase 17/18: one v3 contract — shared epistemic preamble + focused response schemas (sourceModel, storyDesign, narration) + per-pass instructions. |
| `electron/services/beatCastingService.js` | Phase 7: constraint-satisfaction casting with lexicographic tie-break + purpose-level de-dup. |
| `electron/services/audioRoleStateMachine.js` | Phase 8: deterministic audio strategy per beat. |
| `electron/services/narrationGate.js` | Phase 9/10/11: blocking gates (info-gap, function, dialogue/visual redundancy, grounding, spoiler, epistemic) + targeted repair ids. |
| `electron/services/ttsIntent.js` | Phase 12: emotion normalization + per-engine prosody mapping. |
| `electron/services/highlightAudioPlan.js` | Phase 13: duck-vs-mute decision per segment. |
| `electron/services/autoStoryV3Compile.js` | Beats+narration → renderer segment contract (reuses v2 `compiler` primitives) → `highlightV3()`. |
| `electron/services/autoStoryV3Pipeline.js` | Orchestrator composing Passes 0–6. |
| `tests/autoStoryV3.test.js` | 22 assertions incl. required Tests A–H + a compiler-integration test. |

## 4. Reused Existing Code (activated, not rewritten)

- **Highlight renderer contract** — `compileV3`/`highlightV3` emit the same `sourceStartSec/sourceEndSec/audio_mode/voiceover_text/preview_vi/storyFunction` fields the renderer already consumes (superset).
- **v2 compiler primitives** — `autoStoryTimelineCompiler.range/hash/words/budget/validateDuration` are reused directly (proven by the integration test).
- **Sidechain ducking** — `ffmpegService.mixVideoWithNarrationTrack`'s filter graph pattern is reused inside the new `duck` branch of `mixVideoAudioWithVoice`.
- **Audio classifier** — `autoStoryAudioClassifier.disposition` drives the "unclean ⇒ mute" branch of the audio-role machine.
- **Measured voice-fit** — `compiler.budget` + `service.measuredVoice` back the narration safeWords budget.
- **Word timestamps** — `faster_whisper_transcribe.py`'s `.words.json` is now consumed (previously discarded for story/narration).
- **Draft-watching critic** — v3 review routes to the existing `autoStorySourceReview`.
- **Engine primitives** — `autoStorySourceEngine.Engine` (`ask`, `prepare`, `metric`, cache/repair) is reused for all v3 Vertex calls.

## 5. Source Story Model (implemented schema)

```jsonc
{ "artifactType":"auto_story_source_model", "modelVersion":3, "sourceId":"…", "durationSec":1840,
  "people":[{ "id":"p1","label":"Driver","role":"suspect","firstSeenSec":42 }],
  "events":[{ "id":"e17","startSec":612.4,"endSec":631,"type":"confrontation","summary":"…",
              "peopleIds":["p1","p2"],"tension":0.86,"visualQuality":0.7,"novelty":0.8,
              "dialogueImpact":0.6,"causalParents":["e12"],"isReveal":false,"spoilsEventId":null,
              "audioType":"participant_speech","audioConfidence":0.9 }],
  "quotes":[{ "id":"q9","eventId":"e17","speaker":"p1","speakerRole":"suspect",
              "text":"I'm not getting out of the car","startSec":615.1,"endSec":617,"impact":0.9,
              "epistemic":"suspect_statement","wordStartSec":615.1,"wordEndSec":616.9,"wordCount":6 }],
  "audioEvents":[{ "type":"raised_voice","startSec":614,"endSec":618,"peak":0.94 }],
  "tensionCurve":[…], "visualQuality":[…] }
```
`tension` is blended: `max(modelTension, 0.5·model + 0.6·audioPeak)` — audio can only raise it. `epistemic` ∈ `known_fact | police_allegation | officer_claim | suspect_statement | witness_statement | inference | unknown`.

## 6. Story Beat Contract (v3)

Rich beat with `narrativeRole` (14-role taxonomy) mapped to the v2 `storyRole` at compile; `viewerQuestion`, `opensLoopId/closesLoopId`, `informationClass`, `tensionBefore/After`, `sourceEventId`, `audioStrategy`, `narratorFunction`, `narratorText`, `emotionTag`, `prosody`. Compiled segments additionally carry `audio_mode`/`duck`/`mute`/`narrator_function`/`emotionTag`/`information_class`/`opens_loop_id` for the renderer and TTS.

## 7. Narration Logic (implemented flow)

For every cast beat: audio-role machine decides if the tool speaks. Narration is written **only** for speaking beats (Pass 3), with a per-beat `safeWords` ceiling from measured voice speed. Then the **blocking gate** runs; failing beats get up to **2 targeted narration re-writes**; if still failing, the beat is **demoted to original audio** (safe fallback) — never blocking the whole render, and only the affected beat changes.

## 8. Audio Logic (state machine)

`narration disabled → original` · `high-impact (tension≥0.7 / audio event / confrontation-class) & clean → original (silent)` · `no info gap → original` · `needs setup before the moment → setup_then_original` · `source unclean (external/mixed) → narrator_over + MUTE` · `else → narrator_over + DUCK`. At render, clean narrator beats → `voiceover_with_ambient` with sidechain ducking (source preserved, `sourceVolume` 0.28); only unclean beats mute (`sourceVolume` 0).

## 9. TTS Changes

`emotionTag`+`prosody` now survive from segment → `getSegmentVoiceRenderOptions` → `synthesizeDubbingVoice`. Applied per engine: **Edge** (numeric rate/pitch/volume deltas), **ElevenLabs** (`performanceMode` from emotion: e.g. TENSE→cliffhanger, URGENT→panic), **Kokoro** (speed multiplier). Windows/OmniVoice degrade gracefully. When no `emotionTag` (all v2 output), the code path and voice-cache key are unchanged.

## 10. Deterministic Gates (blocking)

`no_information_gap`, `no_function`, `dialogue_redundancy` (fuzzy containment ≥0.5), `visual_redundancy`, `ungrounded` (every factual claim needs a `newInformationRefs` id present in the model), `spoiler` (can't narrate a later reveal event early), `epistemic` (non-fact must be hedged). Open loops (setup-now/payoff-later) are explicitly permitted. Repair is targeted (only failing beats); fallback demotes to original audio.

## 11. Critic Loop

v3 reuses the existing critic that **watches the rendered draft** (draft-proxy multimodal) via `autoStorySourceReview`. The pre-render deterministic gate already enforces grounding/redundancy/spoiler/epistemic, which the v2 path never had. **Partially implemented:** giving the critic direct `story-model.json` lookup to name a *stronger unused* source beat is scaffolded (the model is persisted and available) but not yet wired into the review prompt — see §14/§15.

## 12. Cost Changes

- **Whole-source understanding runs once** and is persisted (`story-model.json`, fingerprint-keyed); Story Design is **text-only** (no video re-sent); casting/audio-role/gates are **local (no AI)**. This removes the v2 pattern of re-deriving understanding from clips at every stage.
- `vertexAiService.createCachedContent` + the `cachedContent` passthrough are in place. **Partially implemented:** threading a `cachedContent` handle through `Engine.ask`/`service.stage` is the remaining one-layer wiring to make every media-bearing pass reuse one primed context.
- Model tiers: Pass 0 = Flash, Pass 1 = Pro (text-only), Pass 3 = Pro; casting/audio/gates = local.

## 13. Tests

Added `tests/autoStoryV3.test.js` — **22 assertions, all passing**, run with `node tests/autoStoryV3.test.js`:
- Test A no redundant narration ✓ · Test B setup_then_original ✓ · Test C high-impact original ✓ · Test D epistemic ✓ · Test E open loop allowed ✓ · Test F emotion reaches TTS ✓ · Test G duck-not-mute ✓ · Test H targeted recast to stronger event ✓ · plus spoiler/grounding/function gates, purpose-dedup, source-model normalize, and a **compiler integration** test (cast→compile→highlight produces renderer-correct segments).

**Regression (v2), re-run and passing here:** `autoStoryFastService` ✓, `autoStorySourceV2` (16/16) ✓, `ffmpegVoiceDrivenClip` ✓, `ffmpegVideoDecoration` ✓, `dubbingScriptService` ✓, `voiceTimingPolicy` ✓, `autoStorySchemaBoundary` ✓, `autoStoryFinalCheck` ✓, `autoStoryRhythm` ✓, `draftExport` ✓. Every AI-pass/module file passes `node --check`; `tools/audio_events.py` passes `ast.parse`.

**Not run (require an Electron/Vertex/ffmpeg/video runtime unavailable here):** the live end-to-end v3 pipeline (`autoStoryV3Pipeline.run`), `createCachedContent` against real Vertex, and `audio_events.py` against a real video. These are written to the verified v2 patterns and syntax-checked.

## 14. Remaining Risks

- **AI-pass code is unexecuted end-to-end.** `autoStoryV3Pipeline`, the three v3 prompts, and `createCachedContent` follow v2 conventions and pass `node --check`, but need one real run against Vertex + a source video to confirm schema round-trips and prompt behavior. Run one short source with `autoStoryContractVersion:3` (or `settings.autoStoryContractV3=true`) and inspect `story-model.json`, `story-spine.json`, `beat-casting-*.json`, `narration-gates-*.json`.
- **Vertex `cachedContents`** API shape/enablement isn't verified against your SDK; the wrapper fails closed (returns null → normal file attach), so the risk is "no savings yet," not breakage.
- **`audio_events.py`** parses ffmpeg `ebur128` stderr; format varies by ffmpeg build. It degrades to `[]` (tension then falls back to the model's read), so worst case is "no audio-event boost."
- **Casting depends on source-model event quality.** If Pass 0 returns few/weak events, casting can leave beats unresolved (the pipeline fails that script cleanly rather than forcing a bad one).
- **`package.json`** test script doesn't yet include `tests/autoStoryV3.test.js` (I avoided editing it to prevent a mid-session mtime clash). One-line follow-up.

## 15. Remaining P1/P2/P3 Work

**Implemented:** Source Story Model (P1), audio events + word timestamps (P2/P3), story design (P4/P5), open loops + information budget (P6), beat casting + purpose-dedup (P7), audio-role state machine (P8), narration=info-gap (P9), narrator function (P10), blocking gates (P11), emotion→TTS (P12), duck-not-mute (P13), v3 fork/wiring, deterministic tests.

**Partially implemented:** narrator↔footage crossfade handoff (P14 — ducking + release curve give the hand-off; explicit `acrossfade` on `setup_then_original` boundaries is not yet wired into the concat step); critic story-model awareness (P15 — critic watches draft; model lookup to surface stronger unused beats is scaffolded, not prompted); Vertex context cache end-to-end (P16 — wrapper + passthrough done; `Engine.ask` threading pending); prompt consolidation (P17 — v3 shares one preamble; the legacy/manual prompt libraries are untouched); schema consistency (P18 — v3 is one authoritative contract; the v2 EDL prompt/schema mismatch remains in v2).

**Not implemented (deliberately deferred):** dead-code removal (P19 — verified but not deleted; `autoStoryHookLab` + the dead `AutoStoryPipelineService.run` remain, isolated); registering the v3 test in `package.json`; a UI toggle to select v3 (currently enabled per-project via `autoStoryContractVersion:3` or globally via `settings.autoStoryContractV3`).

---

### How to turn v3 on
Set `settings.autoStoryContractV3 = true` (all new AutoStory runs use v3) **or** set `autoStoryContractVersion: 3` on a specific project. v2 remains the default and is byte-stable.
