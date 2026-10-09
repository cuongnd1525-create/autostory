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


## October 9 quality corrections (post-video review)

- Stage 1 now scores the same normalized output timeline with the same production Viral Preflight used at import; there is no longer a passing 95-point structural report hiding a 41-point production score. Production deficits are included in editorial repair diagnostics before import.
- An **independent Cold Viewer text-only model pass** reviews the actual script sequence for hook question, handoff to the next 15 seconds, narrator's informational contribution, slow/unclear stretches and concrete chapter payoff. The review runs before and after at most one script repair; unsubstantiated/missing structured reports fail closed. The same model provider still cannot predict real audience retention.
- The structural guard rejects an opening source beat over 12 seconds and temporal rewinds justified solely by metadata. Time travel needs an audible narrator bridge or a supported explicitly rendered title.
- On import and before render, the target series requires normalized Viral Preflight >=72, editorial readiness >=72 and technical readiness >=80 (where present). See analysis/story-first-import-rejected-script-N.json for failures.
- US English bodycam preview keeps **English subtitles** by default; no automatic local English->Vietnamese translation. Optional storyFirstPreviewSubtitleLanguage is en, vi, or off. An explicit Vietnamese choice preserves legacy translation.
- Draft logs include each misaligned TTS scene and voice/timeline seconds. A voice-issue draft is inspectable but marked needs_voice_repair; without voice issues it still needs_real_video_review.
- Developer switches: storyFirstColdViewerEnabled=false or storyFirstUnifiedPreflightEnabled=false isolate tests; storyFirstAllowLowQualityDraft=true allows intentional low-quality diagnostic previews only. None of these mean the draft is production-ready.

### Inspect these diagnostics

- \`01-ANTIGRAVITY-RESULT/audience-review-initial.json\`
- \`01-ANTIGRAVITY-RESULT/audience-review-repaired.json\` (when repair occurred)
- \`01-ANTIGRAVITY-RESULT/editorial-quality-report.json\` (structure + cold viewer + production preflight)
- \`analysis/story-first-import-rejected-script-N.json\` (if still rejected at import)
- \`...fast-draft-...-voice-warnings.json\` (measured voice alignment)
- \`...fast-draft-....en.srt\` (US series English draft captions)

Actual multimodal review of the **rendered MP4** still belongs to the subsequent Gemini Draft Review step. Text-only Cold Viewer is not a substitute for watching the output, and a passing CI test does not guarantee virality.


## October 9: multi-Part repair trap and forbidden run_command

A live run successfully locked Series Plan, generated all 3 Parts, and completed Cold Viewer. All Parts failed the unified normalized `production_preflight` gate. The previous **monolithic three-Part** editorial-repair prompt made the model try `run_command`; the read-only safety guard correctly terminated it instead of executing shell commands.

The repair protocol now:

1. Logs each Part's production score, editorial/technical sub-scores and first three deducted-issue explanations before attempting repair.
2. Saves immutable pre-repair scripts and repairs **only rejected Part IDs**, individually. Accepted Parts are preserved.
3. Gives each Part the precise normalized production-readiness deductions, independent audience issues and host validation errors inline; the writer may only view explicitly approved source evidence JSON. It is told not to run scripts or modify source files.
4. If a Part tries a disallowed command, aborts that attempt and starts **one new, completely tool-free** 180-second inline-JSON recovery for that Part. Original script, verified event ranges and exact failure reasons are included in the new prompt; there is no shell execution or source rewatch.
5. Enforces exactly one complete `script-N.json` per affected Part, then re-runs the full structural, production and independent cold-viewer gates. Unresolved V1 failures still block export; they are never silently approved.

Tests cover multiple Part-specific repairs, an attempted forbidden `run_command` and the tool-free fallback. This is not a claim that a live model will always return a quality-approved rewrite; it prevents the previous forbidden-tool crash and produces explicit diagnostics when the creative criteria are not met.


## October 9 — Windows 24k argv overflow in Part-3 editorial repair

Real run `1008_03`: Source Understanding cache, Series Plan cache, Phase B and initial Cold Viewer completed. Actual Part production scores were 40/51/46, with `technicalReadiness=100`. The Part-3 repair attempted an unauthorized file/tool operation, correctly invoking the read-only guard. The **fallback then crashed before launching AGY** because it embedded `35,102` characters of raw source JSON/evidence in `--print`, above the Windows CLI safety limit of `24,000`.

Changes:
- Initial per-Part repair and forbidden-tool recovery now reference **one host-written `editorial-repair-part-N-packet.json` file** containing full script, QA, verified source timeline and Part allocations. No truncation of large source evidence into the Windows `--print` command line.
- A fresh recovery process may use `view_file` on that **single packet path only**, while shell, code editing, task-management and unrelated file reads are blocked. Legitimate first-pass reads of `scene-manifest.json` and source transcript are explicitly permitted by exact path.
- Regression test includes a synthetic original Part JSON **over 60,000 characters**, a simulated forbidden `run_command`, a fresh recovery turn with prompt under 24k, and one explicitly whitelisted `view_file` call.
- Discovered a second deterministic problem: **viral_tiktok_crime_part1's Series Planner locks 110–125s per Part**, but the generic serialized Production Preflight incorrectly used 75–110s whenever the model omitted target duration metadata. Real drafts at 115.5–116.4s were penalized unfairly. This profile now has a host-locked 110–125s contract in the Preflight scorer, Phase B generation, repair prompt, and every saved/repaired Part JSON. A true overlong 126s Part still gets flagged. Stage 1 and downstream import therefore use the same duration contract.
- Store all Production Preflight issues in the QA report/recovery packet (not just the first 14); UI progress is intentionally abbreviated.

CI covers these invariants on Linux and Windows with mock AGY. An actual Antigravity rerun and actual MP4 review remain necessary before claiming user-facing video quality. **No bypass of Quality Gate, no merge to main.**
