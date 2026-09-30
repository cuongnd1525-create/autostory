# Implementation plan: Story Scope + media-grounded Editorial Director

Baseline HEAD: 688edaad86ef2a38c599c462b578bec69fba6ff1

## Root cause (as found in code)
1. **There is no binding scope stage.** `storyScope` is an optional sub-object inside the same
   text-only EDL call (`v3-story-design`). Gemini fills it in afterwards to fit whatever beats it
   chose. In the benchmark run it declared `episodeStart=8.5, episodeEnd=1415.7`, which is the
   whole incident. Nothing downstream reads it.
2. **The EDL author is text-only.** `buildStoryDesign` calls `engine.ask(..., evidence=[])`, so
   exact footage is chosen from about 40 summary events. The critic later found beats whose
   footage did not contain the claimed content.
3. **The constraints reward wandering.** The Story Design instruction, the repair prompt and
   `edlQualityValidator` (hard violations) impose a 12s "visual state" ceiling, 13–16 micro-beats
   of 3.5–6.5s, strict forward chronology, zero teaser replay, and an evidence ladder
   (claim→witness→admission→consequence). The repair text for `VISUAL_STATE_COLLAPSE` literally
   says "switch to … witness/victim testimony from unused moments in the source model". A
   coherent continuous confrontation is rejected, and the only way to satisfy the rules is to
   jump across the whole source.
4. **There are competing timeline owners.** RetentionArc rewrites roles and audio defaults.
   DurationFit extends ranges and accepts ±10s outside the requested bounds. Coverage and
   DurationFit can add unused events on non-lock paths.
5. **Benchmark overfitting already exists** in production code: `edlQualityValidator`
   (mother/nathan/daughter/melody plus source timestamps), `retentionArcPlanService`
   ('nightmare', 'georgia', 'bathroom'), and the critic prompt examples.

## New flow (contract 4 default, `editorialArchitecture: 'scope_media_director'`)
```
Source Story Model (cache-first, unchanged)
  -> storyScopeService.selectStoryScope      [Gemini, text over model; candidates + chosen]
       validateStoryScope (deterministic structure + media budget) -> <=2 Gemini repairs
  -> storyScopeService.planScopeReel          [scope windows -> source ranges + manifest]
  -> engine.prepare(reel ranges)              [source-clock proxies, cached, reused by repair]
  -> editorialDirectorService.directEdl       [Gemini WATCHES reel; outputs exact EDL]
       validateDirectorEdl (technical + scope membership vs Gemini's own scope) -> <=2 Gemini repairs
  -> buildScript (director mode): cast = bounds check only, NO retention arc rewrite,
       NO coverage, DurationFit = validate only (failure -> DIRECTOR_REPAIR_REQUIRED),
       narration for director-chosen voiceover beats, assertEdlIntact()
  -> compileV3 (exact duplicate guard) -> render
  -> scopeMediaCriticService.critiqueScopedRender [Gemini watches MP4; issues only]
  -> editorialDirectorService.repairEdl       [scope + current EDL + weak region + same reel] (<=2)
```

## Ownership
- Exact EDL: `editorialDirectorService` (Gemini). This is the single owner.
- RetentionArc, BeatCoverage and DurationFit do not modify anything on the director path.
  DurationFit becomes validation only. BeatCasting keeps its bounds clamp and adds nothing.
- The compiler compiles. Its exact-duplicate guard stays.
- Legacy contract 3 and `editorialArchitecture: 'legacy_v4'` keep the old behaviour.

## Cost
- Scope selection is text-only, 1 call.
- The director reel is limited to scope windows, capped by `maxScopeReelSec` (default 360s) and
  sent at low fps. Proxies are hash-cached, and repair reuses the same files.
- The whole source is never re-sent. The Source Story Model cache is unchanged.
- The call reserve is increased by one to cover scope selection.

## Tests (new: `tests/storyScopeArchitecture.test.js`)
A. Scope is built before the EDL. B. The director receives the scope. C. The director receives
media files and the manifest. D. An out-of-scope dramatic event is not injected by coverage or
duration fit. E. RetentionArc does not reorder a director EDL. F. A duration failure goes back to
Gemini. G. The exact-duplicate guard stays active. H. Repair receives scope, EDL, weak region and
media. I. The legacy path is unchanged. Plus: no benchmark literals in production code.
