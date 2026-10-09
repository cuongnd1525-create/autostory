# Story-first V1 — True Crime Series (Antigravity)

This branch adds pre-render editorial QA for `viral_tiktok_crime_part1`, preserving the existing source-understanding cache and the earlier Antigravity token/series-plan recovery fix.

## Pipeline

1. `SOURCE_UNDERSTANDING`: reuse verified full-source Phase A cache or watch missing proxy chunks once.
2. `STORY_HOOK`: produce `story-hook-tournament.json` by rescoring local hook-audition candidates against Phase A's verified story timeline; a user-locked Hook remains binding. This is an **editorial heuristic**, not a measure of retention.
3. `SERIES_PLAN`: Gemini receives the ranked candidate set and is asked to lock the hook, cause-and-effect story progression, narrator handoffs and evidence-based cliffhanger/payoff for each Part. Validated plan is cached outside the cleaned run result.
4. `STORY_FIRST`: create `story-intelligence.json` and `narrative-blueprint.json`, with source evidence, locked Part allocations and narrator briefs.
5. `PHASE_B`: Gemini writes complete scripts guided by the blueprint. No video rewatch: unexpected `view_file` of video is rejected.
6. `EDITORIAL_GATE`: reject malformed Part ranges, missing original-audio handoffs, fewer than two meaningful narrator beats, purely descriptive narration, repeated narration, missing rewind bridges, generic clickbait, misaligned Part 1 hook, and missing closing cliffhanger/payoff footage.
7. `PHASE_B_EDITORIAL_REPAIR`: one **text-only** repair attempt if the first script fails. A second failure creates a detailed report and blocks automatic acceptance rather than silently shipping a low-quality V1.
8. `DRAFT_REVIEW`: review prompt explicitly requires a first-time-viewer audit of 0–3s trigger, 3–20s handoff, narrator function, causality, ending and engagement grounded in evidence.

## Key outputs

`01-ANTIGRAVITY-RESULT/story-intelligence.json`: grounded case and source events.

`01-ANTIGRAVITY-RESULT/story-hook-tournament.json`: candidate comparisons, verified later payoff references and user-lock policy.

`01-ANTIGRAVITY-RESULT/narrative-blueprint.json`: per-Part story and narrator guidance.

`01-ANTIGRAVITY-RESULT/editorial-quality-report.json`: passed/rejected per-script decisions with precise error codes and segment indexes.

`01-ANTIGRAVITY-RESULT/script-N-before-editorial-repair.json`: unapproved first draft, retained for diagnosis.

`01-ANTIGRAVITY-RESULT/phaseB-editorial-repair-output.log`: model response from the one permitted repair attempt.

## Settings and compatibility

- Default **on only for** `viral_tiktok_crime_part1`. Other project types use their existing workflow.
- `storyFirstEditorialEnabled: false` restores legacy behavior for focused rollback/testing.
- Hook contracts with `isUserLocked=true` cannot be overwritten. Auto-generated `isUserLocked=false` hooks are candidates, not binding.
- Source understanding is not discarded and no Phase A video is rewatched during text-only planning/writing.
- An editorial rejection is an intentional quality stop, not a rendering failure; inspect `editorial-quality-report.json`.
- Heuristic gate scores do **not** predict TikTok views or confirm compliance with any platform originality or monetization policy.

## Manual Windows acceptance test

1. Ensure Antigravity CLI is signed in and the model is available.
2. Checkout `feat/story-first-v1-editorial-engine-20261009` and run the same true-crime source used for the previous baseline.
3. Confirm source-understanding cache hit and no extra video views in text stages.
4. Inspect Hook Tournament, Series Plan and Narrative Blueprint for grounding, narrative arc and spoiler handling.
5. Force a weak Phase B script or examine a real natural failure: only one editorial repair should run and the gate must refuse a still-invalid script.
6. Render draft V1 when accepted. Watch the whole video yourself, and check hook first 3 seconds, actor/chronology clarity after the hook, narrator/bodycam handoffs, and credible ending.
7. Run actual Gemini draft review. Confirm issues include concrete video timecodes, not just JSON self-certification.
8. Compare objectively to the previous V1 using human blind reviews and real TikTok retention data. Do not infer guaranteed virality from QA score.

## Validation

GitHub Actions: `Story First V1 Editorial Regression` (Linux core + Windows packaging test) and `Stage 1 Antigravity auth regression`.

The test suite uses a fake Antigravity CLI. A live Windows run with real audio/video is still required to establish editorial effectiveness.

## Not yet covered by this branch

Separate two-**call** independent audience-only / repair-only review, per-voice-block real TTS rehearsal, full human-rated multi-case benchmark and in-app engagement analytics dashboard. These are distinct workstreams, not silently claimed complete by a passing unit test.
