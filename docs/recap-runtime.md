# Recap local runtime

Recap now treats duration as a soft editorial preference by default. Its normal
reference range is 80–120% of the requested length. It does not add footage or
rewrite narration merely to fill time. Measured clause/audio synchronization
still blocks an invalid edit. A deviation above 35% must be resolved by improving
the content or choosing a more suitable target; it cannot silently export as a
successful approximation.

Actual draft review must score at least 0.80, retain all high/critical defects,
and explain whether the chosen length serves a complete, well-paced story.
Review errors, incomplete coverage and failed repairs never fabricate approval
or downgrade blocking issues. Long-draft review uses the weakest excerpt score.
Changing the review policy or duration context invalidates prior approval caches.
The legacy `strictDurationGate` option remains available for explicit hard-range
workflows; the guided recap UI describes the default quality-first behavior.

Install an isolated Python 3.11 runtime from the project root:

```powershell
.\tools\setup-local-runtime.ps1 -BasePython 'C:\path\to\Python311\python.exe' -Cuda
node tools/configure-local-runtime.cjs
```

Omit `-Cuda` for CPU-only ASR. The runtime lives in `.venv-local`, which is not
committed or bundled into the desktop installer. `configure-local-runtime.cjs`
preserves the existing AI/voice settings and backs up the previous config before
setting the ASR, Kokoro and local translation Python paths. Restart the desktop
app after changing its saved config externally.

Verify real synthesis, translation and transcription:

```powershell
node tools/verify-recap-local-runtime.cjs
node tools/verify-recap-local-runtime.cjs --gpu
```

The first run downloads Kokoro, OPUS-MT and tiny.en test models. The GPU check
uses CUDA 12 cuBLAS and cuDNN 9 wheels; `python_runtime_bootstrap.py` registers
their DLL folders before loading faster-whisper. ASR Auto uses CPU when these
DLLs or the NVIDIA driver are unavailable. Explicit CUDA reports the actual
runtime error instead of silently switching devices.

Verify the configured AI provider against a generated six-second video:

```powershell
node tools/verify-recap-provider.cjs
node tools/verify-recap-provider.cjs --vertex
```

These checks use the saved provider credentials and may incur provider usage.
Antigravity must actually inspect the supplied video before its JSON is accepted.

On Windows, a CLI descendant can briefly keep its request working directory
locked after the parent exits. Request cleanup retries separately with bounded
backoff, then performs at most two background attempts. Cleanup warnings never
replace the validated JSON, the original CLI/schema error or cancellation, and
never cause another AI request. See [Node.js fsPromises.rm](https://nodejs.org/api/fs.html#fspromisesrmpath-options).
`node tools/verify-recap-cleanup.cjs` reproduces a real Windows EBUSY lock and
verifies that a single successful request survives cleanup.
`tools/restart-recap-studio.ps1 -OnlyIfIdle` avoids restarting while the app still
owns external worker processes.

Recap visual indexing keeps the configured Antigravity Flash family but uses its
Low reasoning variant; story/editorial/review calls keep the configured model.
`recapAnalysisReasoning: "high"` in settings opts back into the configured
reasoning level. Stage model overrides now reach the actual CLI command.
Each source chunk requests at most 30 essential events and 9,000 characters of
compact JSON, covering the beginning, middle and end rather than every shot.
These are generation targets, not hard acceptance limits. Complete schema-valid
JSON and valid timeline anchors are retained even when the result is larger.
The model that succeeds becomes preferred for subsequent chunks in the same run,
without changing the configured editorial model or saved global settings.
Antigravity inventory is discovered from `agy models` before Recap inference,
cached for five minutes by configured CLI command, and force-refreshed if the
CLI rejects a model removed between discovery and execution. Historical IDs
are retained only to read saved settings; they are never invented as fallback
candidates. The settings UI loads the same live inventory and provides a refresh
button, marking a retired saved selection explicitly. On 2026-10-14 the CLI
removed Flash 3.7/3.6 and Pro 3.1; available Gemini choices were Flash 3.8
High/Medium/Low. Video preflight chooses from listed Gemini models and does not
silently use GPT-OSS or an unknown default. At most three listed models are tried
per request. If the selected family is gone, another listed family is chosen
before inference. Capacity and timeouts can switch only to a different listed
model family; Low/Medium/High of one family are not separate capacity pools.
Interrupted streams and malformed structured responses can use another listed
reasoning level. Cancellation,
credentials, forbidden tools and invalid request parameters stop immediately.
Visual-analysis requests allow three minutes for Flash and six for Pro, or the
shorter configured timeout. Editorial fallback allows four minutes for Flash
and six for Pro. A structured capacity error stops the recap CLI child as soon
as the error event is received. A CLI print timeout can recover a complete
schema-valid JSON object only after verified media coverage; truncated JSON,
explicit result errors, policy blocks and cancellation can never be recovered.
Logs show the actual model and reason for each switch. Provider credentials and
global model settings remain unchanged.
Capacity (503) remains an upstream availability failure. Exhausting eligible
models stops with an explicit recoverable capacity message and preserves
completed chunk checkpoints. Changing reasoning levels on the same service
does not guarantee spare capacity; an independently configured Vertex AI or
Gemini API provider is the alternative when Antigravity is unavailable.
The recap wizard displays an explicit “Đổi sang Vertex AI và chạy tiếp” action
on Antigravity capacity/unavailable failures. It explains Google Cloud usage
charges and changes only the default AI provider after the user clicks it,
then repeats the interrupted action on the same project. Missing Vertex
credentials show an AI settings action instead. Provider switches keep validated
source chunks and split parts under the same source/timestamp contract;
incompatible source metadata still invalidates them. The Electron wizard check
simulates a real IPC error to verify no automatic paid-provider switch, the same
project ID, settings preservation and recovery. It makes no model inference call.
`node tools/verify-recap-model-discovery.cjs` verifies the actual CLI list and
retired-model replacement without any model inference call.
If a video request times out before the CLI has inspected any attached video,
stop with `provider_unavailable` and preserve checkpoints instead of retrying
all reasoning levels and then splitting the same uninspected input.
If model fallback still ends with token exhaustion, timeout after media inspection or invalid JSON/timing,
only the affected chunk is
split into two smaller intervals, with no further recursive splitting. Completed
parts are checkpointed and reused after cancellation. Existing validated chunk
checkpoints survive changes to the analysis model. Each AI call logs elapsed time.

Proxy chunks are accurately decoded and re-encoded, rather than stream-copied
from the preceding keyframe. On the reported Simpsons project, the old second
120.125-second part was actually 146.564 seconds long. Versioned `accurate-v2`
files bypass that cache, verify video duration before inference and fingerprint
the proxy plus requested interval. `tests/recapProxyCut.test.js` uses a real
long-GOP video to check duration, the first source frame and cache invalidation.
An isolated invalid/inverted event interval is excluded before narration references
are generated, within the existing 15% guard; mostly invalid results still fail.
The prompt explicitly converts burned `00:03:46` to 226 seconds. A four-minute
chunk whose numerous sub-200ms events are compressed into a few seconds is
rejected as an ambiguous unit response, rather than automatically guessing
minute.second conversion. Saved chunk anchors are revalidated as well: only
invalid checkpoints and their derived story/script/render approval are removed.

`node tools/verify-recap-analysis-speed.cjs <project-directory>` benchmarks the
last existing proxy chunk with a three-minute cap and saves results under
`.tmp/recap-analysis-speed`. It uses the saved provider and may incur usage, but
does not alter the project. A 134.548-second Simpsons source segment completed
in 67.991 seconds with Gemini 3.7 Flash Low, returning 12 validated events.
This measures one analysis call, not end-to-end render time or a quality comparison.
Add `--fallback-check` to simulate the primary model failing, then validate a
real fallback analysis call. This saves a separate `fallback-result.json` report.
The same 134.548-second segment completed in 69.754 seconds on Flash 3.8 Low
after a simulated primary output-limit failure, with 12 validated events. Pro
handoff, exhausted fallback budgets and cancellation are covered by regression
tests; this live check does not simulate a real outage or prove relative quality.
Use `--chunk 1 --model gemini-3.8-flash-low` to benchmark a specific existing
chunk with a temporary model override. The affected 240.25-second first chunk
completed in 55.697 seconds with 20 events. The raw JSON was 8,789 characters;
normalization adds default fields and produced 10,190 characters. The test saves
raw JSON under `.tmp/recap-analysis-speed` for diagnosis without altering the
project. Occasional wholly out-of-chunk events (at most 15% of the response) are
recorded as excluded before narration references exist; intersecting ranges
are clipped to the chunk. A mostly invalid timeline triggers model/split recovery.

Regression and render verification:

```powershell
npm run test:recap
npm run test:queue
npm run check
```

## Recap / review editing

The recap setup now follows six steps: source video, content, voice/audio,
framing/captions, angle/hook, and draft approval/export. The activity pane sits
near the right window edge; the adjacent summary updates as settings change.
Source analysis starts from the framing step's explicit action. Users can inspect
the three hook auditions before rendering a draft, and open the result in Studio.
Draft requests pause even when an older final approval remains saved.

Changing setup modes restores the shared fields to their original panels.
Voice, source and setup choices are retained locally; an unfinished project can
reuse its saved source analysis. Changes that affect the draft require rebuilding
before export. Vietnamese filters Edge voices and disables incompatible Kokoro.

New recap projects can use a recap, review or explain preset, English or
Vietnamese narration, and natural, suspense, humorous or cinematic style.
Duration presets are 75, 120 and 240 seconds; custom targets are 15–600 seconds.
Measured TTS/timeline duration must be within 85–105% of the target. The pipeline
can rewrite twice to fit it, without relying on extreme voice speed changes.
Narration character limits follow the spoken word budget, not the shorter source
anchors. The budget preserves the actual measured voice cadence up to 5.2 words/s;
duration repair supplies an explicit total-word target derived from measured
TTS/timeline duration. This changes script length, never the requested voice speed.

With viral optimization enabled, AI proposes three grounded angles and five
hooks, then synthesizes and renders the best three usable hook auditions. Choose
manual selection to pause and listen in Studio before committing to a hook.
Changing the angle creates hooks for that angle; source analysis remains cached.
Scores describe editorial suitability, not predicted views.

Portrait export produces a 360×640 draft and 1080×1920 master. Fit with blurred
background preserves the full image; crop uses the AI event focus position and
falls back to the center. Phrase and karaoke captions use the original narration
text aligned with faster-whisper timestamps from the actual retimed TTS master.
English captions default to base.en, Vietnamese to base, with a minimum alignment
confidence of 65%. The first caption run may download the model. Kokoro supports
English here; use Edge Neural for Vietnamese.

Draft review inspects the rendered video. A score below 0.70, any high/critical
issue, invalid review or unavailable provider blocks master export. One review
repair is allowed, followed by another render and review. The final approval
button cannot bypass these checks. Studio shows the blockers and a recheck action.

Multi-event speech units are aligned against word timestamps from their actual
TTS audio before rendering. Consecutive clauses with identical visual references
form a measured group; its next image starts at the spoken boundary with the
configured visual lead. Source clip lengths no longer determine that boundary.
Alignment requires at least 80% recognized word matches and exact agreement
between the clause text and spoken script; invalid cached spans are rebuilt.
The voice waveform pace remains unchanged. Scene expansion stays within a single
detected scene, and unavailable or reused footage cannot silently substitute for
the referenced action. Groups that need more than 1.5s of held footage block
rendering and request a repair.

Repair only failed clause groups before rebuilding TTS. Bounded word targets
allow one token of counting variance; actual measured audio duration remains
the hard constraint. Preserve the
other narration and source references. One corrective response is allowed for
an invalid patch; timing is measured again afterwards. This avoids repeatedly
rewriting the entire recap without fixing the overflowing groups. Quality-only
repairs preserve the current spoken word budget instead of collapsing a long
recap into a short synopsis. Old timing approvals are invalidated by timing
version 3, while valid source analysis and unchanged audio remain reusable.

A high/critical semantic review also rechecks the implicated source anchors.
The audit extracts source frames at exact code-controlled times, plus a timed
source-audio transcript, and asks the analysis model to select actual frame
indexes. It does not accept guessed floating-point timestamps. Verified anchors
are constrained to detected scenes and persisted in both the event index and
chunk checkpoints. An absent, ambiguous or invalid match blocks the repair;
the subsequent draft is always rendered and reviewed again.

For a small remaining duration deficit (up to 15s), expand a uniquely referenced
group only when measured unused grounded footage has enough headroom. This
preserves the clips and narration that already fit rather than rewriting the
whole video. Spending-limit errors are terminal and preserve checkpoints.
Verification-only `--daily-limit` overrides never change the saved app limit;
raising a limit requires explicit user authorization.

Duration bounds retain the 85–105% target range, with one 30fps frame of
quantization tolerance. FFprobe output verification uses the actual encoded
frame rate for the same tolerance; larger duration deficits remain blocked.

Additional checks:

```powershell
node tools/verify-recap-presentation.cjs
.\node_modules\electron\dist\electron.exe tools/verify-recap-ui.cjs
node_modules\.bin\electron.cmd tools/verify-recap-wizard.cjs
node tools/verify-recap-editorial-live.cjs --vertex
```

The presentation check reuses the Kokoro audio created by the local runtime
check. The live editorial check reuses the audited Simpsons source analysis and
creates its own project under `.tmp`; it requires provider credentials.

For source-through-master verification using the actual preferences and media
of a saved project, run:

```powershell
node tools/verify-recap-source-flow.cjs 'D:\workspace\project-id' --media-only
node tools/verify-recap-source-flow.cjs 'D:\workspace\project-id' --provider antigravity_cli
node tools/verify-recap-source-flow.cjs 'D:\workspace\project-id' --provider vertex_ai
```

This clones the project/checkpoints under `.tmp/recap-source-flow`, uses real AI,
Kokoro, captions, rendering and draft review, and reports success only for a
completed master. It does not alter the user's project or global provider settings.
Use `--resume <clone-id>` to retain progress when testing a subsequent fix.
`--regenerate-narration` regenerates only the verification clone's narration;
`--verify-master` checks an existing clone's real output with FFprobe, including
target duration, portrait dimensions, audio and the final narration endpoint.
Provider requests can incur usage. A 2026-10-14 Antigravity run reproduced a
real 503 and stopped after one request in 189 seconds, preserving checkpoints.
An earlier 611.548-second Simpsons diagnostic completed through Vertex on 2026-10-14
with the original review preferences: 360s target, Kokoro am_adam at 1.15,
muted source, 9:16 and phrase captions. The final resumed run reanalyzed the
rejected first chunk (37s), reused the other two valid real analyses, and ran
story, hooks, narration, measured-duration repairs, captions, draft review and
master render. Its 1011s runtime excludes earlier failed diagnostic runs and
is not a fresh-run speed benchmark. Independent FFprobe verification measured
314.367s, 1080x1920, 30fps, H.264/AAC, with the last speech ending at 314.214s.
Draft review scored 0.85 with one medium final-scene timing issue, no blocking
issues. Evidence is in `.tmp/recap-source-flow/vertex_ai/result.json` and
`master-verification.json`; generated artifacts remain separate from the user
project. Changing original-audio mute invalidates the old quality approval,
so the newly rendered draft is reviewed again before master export. This older
master is diagnostic evidence only: subsequent detailed review exposed incorrect
source anchors. Its single full-video score is not acceptance evidence for the
current implementation.

Production source analysis now uses version 4 checkpoints. FFmpeg extracts
labelled images from detected scenes, splitting long scenes into intervals of
at most six seconds. The model selects those scene IDs; application code assigns
the source timestamps. Actual source audio accompanies the images. Retired
timestamp-based analysis and its derived narration/approvals are invalidated;
valid proxy and scene-detection work is retained. Schemas constrain downstream
event references to IDs present in this source index.

Narration with multiple visual groups is aligned to the actual TTS waveform.
If fast batched ASR fails the 80% word-match gate, it retries independent beam-5
decoding with a separate cache. Unreliable alignment blocks export. Overflowing
clauses are repaired using individually bounded word arrays, then measured again
with real TTS; this does not relax the duration or visual-footage gates.

Long drafts are reviewed in overlapping 70-second excerpts, with complete
coverage required and successful excerpt results checkpointed. A high-severity
source mismatch triggers a source-frame audit; unavailable review cannot approve
a final master. Source audits and review cache paths are shortened for Windows.

`--daily-limit` in the verification helper is temporary and requires explicit
spending authorization. It never changes the saved app configuration. Responses
are bounded to 16384 tokens and verification reserves $0.05 below its $6 ceiling.
A new final master has not been verified for this revision; passing local/render
tests must not be reported as that verification.

The 2026-10-21 Naruto log exposed two distinct grounding defects: source labels
misidentified the victim, and the timing solver expanded indexed source ranges
into adjacent actions. Indexed events now keep their exact source bounds even
for a single aligned group. Exhausted footage requests structural repair rather
than borrowing another action or truncating the story into fragments. A critical
visual continuity issue audits every reference of the affected narration unit.
For scene-indexed events, that audit watches each exact source clip in a separate
request, corrects descriptions, and cannot change its source timestamps. It uses
observable physical descriptions when an identity is uncertain, instead of
mixing neighbouring clips or guessing a character from the old label.
Unverified observations still block final export. Legacy anchors may use the
separate indexed-frame relocation path.

Quality repair returns only changed narration units and optional supported
additions in causal order, preserving the chosen hook and unaffected units. It
does not feed the obsolete unverified story outline back into local corrections.
Free-form factual/character review labels cannot bypass source verification.
One bounded extra measured timing repair is permitted for residual TTS drift
under 0.5 seconds per group and one second in total, with enough source evidence;
this does not relax the physical source or quality gates. Excerpt reviews
judge audiovisual defects; a separate complete-script editorial pass judges
story coverage and duration. Neither pass may manufacture a passing score.

`node tools/verify-recap-source-bounds.cjs <saved-project-directory>` replays the
real cached audio and timing decisions without AI calls or project mutations.
The Naruto checkpoint reproduced 48 old out-of-range clips; the bounded solver
returned 57 clips with no such violations, and seven groups still needing timing
repair. This verifies source bounds only. A subsequent real render/review of the
verification clone scored 0.70 and remained `quality_blocked`; it is not final
master acceptance evidence.

Vertex requests omit an unspecified thinking budget. Explicit zero is raised to
128 for Gemini 2.5 Pro, which cannot disable thinking; Flash retains zero.
See [Google's thinking documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thinking).

The October 22 upgrade introduces narration checkpoint version 4. It replans
the script once while retaining valid source/proxy analysis. Long-form planning
uses actual interval durations and source-supported developments instead of a
fixed seconds-per-event assumption or a plot template taken from the diagnostic
anime. In quality-first mode, nearby scenes are no longer appended automatically
just to increase coverage. Writers receive per-event speech budgets, verified
description markers, and explicit requirements for bridges between parallel
storylines.

A cached pre-TTS editorial pass checks actor/target claims, causal continuity,
payoff and estimated scope. It can make one local repair with concrete suggested
source events before expensive TTS, ASR and rendering. Cached measured cadence
is used when available; estimated clause timing reuses the actual sync solver.
This is text/caption inspection, never final audiovisual approval. A network or
invalid-result failure warns and leaves the mandatory real-video checks intact.

Verified source observations are cached separately from narration and review
issues. An unchanged interval can reuse its observation without cutting/uploading
the clip or calling AI again. Source file metadata, bounds, description, audit
model and sampling-policy changes invalidate that cache. Reuse establishes what
the footage shows; it cannot approve a new spoken claim. Short Vertex action
audits request 4 FPS so rapid motion is less likely to disappear between samples;
see [Google's video sampling documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/video-understanding).

Raw rendered segments persist under `output/.recap-segments` (or the output
file's parent). The cache identity includes source size/mtime, source range,
speed, framing, exact frame duration, encoder arguments and original-audio
handling. Only complete segments are published. Narration and subtitles are
assembled afterward, so they are updated even when visual segments are reused.
Removing this project cache simply makes the next render regenerate segments.

`node tools/verify-recap-upgrade.cjs <saved-project-directory>` performs a real
cold/warm draft render without AI calls and compares decoded audio/video hashes.
The native Naruto diagnostic reused all 60 segments: 12.881s cold versus 9.692s
warm (24.8% less repeat-render time), with identical decoded audio and video.
This is a repeat-draft measurement, not an end-to-end speed claim. Live preflight
testing requires `--preflight --daily-limit <approved-limit>`; add
`--preflight-only` to avoid rendering. The tested script grew from 523 to 732
words, estimated 159.456s to 221.224s, in a 45.326s pre-TTS pass. These are script
estimates; a new complete master has not been validated by this benchmark.

Quality repair can remove redundant secondary narration and insert supported
replacements at the original position, including when its anchor unit is removed.
The hook and source-backed payoff remain protected. Allowed beat IDs are supplied
explicitly; invalid patch IDs, anchors or beats produce specific diagnostic errors.
Whole-script editorial review uses the complete script and source descriptions,
excluding the unverified generated story outline. It must not demand a retreat or
victory solely because an earlier outline invented one. Only the text-review cache
is invalidated for this change; completed audiovisual observations remain reusable.

When Vertex reports capacity pressure, a configured alternative is tried without
first repeating the same model inside the provider. That failed model is skipped
for two minutes while an alternative exists. Cancellation, authorization and
spending limits still stop the request; fallback does not relax quality gates.

The October 28 narration failure was reproduced on the saved 301-event Naruto/
Neji project with Gemini 2.5 Pro. Its nested narration schema and `minItems: 12`
produced HTTP 400 `INVALID_ARGUMENT` even with a short diagnostic prompt. Removing
array bounds alone made the same schema acceptable to Vertex. Recap now sends
array bounds as descriptions and validates the original full contract locally,
including unit counts, per-array limits, beat IDs and event IDs at both unit and
clause level. It retains the ID enums, required fields and output token budget.
This follows [Google's structured-output complexity guidance](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output).
Existing analysis checkpoints do not need to be discarded for this transport fix.

A missing source file now reports `SOURCE_VIDEO_NOT_FOUND` with instructions to
select the completed video. It stops before media/AI work and never substitutes
a similarly named file automatically. A yt-dlp format/intermediate path can
disappear after merging; the completed `.webm` must be selected in that case.

Long-form narration checkpoint version 6 refreshes the script once while keeping
valid source/proxy analysis. Early inspection reports voice-cadence-based scope
and available unique source coverage; those are diagnostics, not footage quotas.

Recaps of 300 seconds or longer now write from the source video chapters,
including their dialogue, instead of a short-form prompt fed only representative
frame captions. The writer apportions the total word estimate using measured
voice cadence and unique source intervals. Named passages make the requested
level of detail explicit without requiring invented or repetitive content.
One targeted chapter retry is allowed for an unreasoned material shortfall.

A separate source pass assigns actual event IDs to passage IDs, including the
complete relevant action/dialogue sequence. It may omit unsupported paragraphs;
it cannot create supporting footage by filling an arbitrary nearby interval.
Both the written chapter and its source allocation are checkpointed, so a
cancelled or failed later chapter does not regenerate completed chapters. Derived
dialogue/context notes keep their source path and offset, preserve the original
visual captions, and are treated as automatic observations. The pre-TTS review
receives the real source chapters to verify those observations. The rendered
draft still requires its independent audiovisual quality review.

A long recap whose estimated scope still deviates by over 35% stops before TTS.
Measured TTS that falls outside that material-deviation limit stops before another
draft/render review. The usual 80–120% duration range remains a preference; the
application never fills the gap with slow speech, repeats, freeze frames or invented
facts. A blocked scope requires meaningful narrative development or a deliberate
target change, not repeated exports of the same short draft. These planning estimates
do not approve a master or replace actual audiovisual quality review.

If preflight identifies a material shortfall plus specific missing developments,
it requests one complete plan/narration scope repair. That request cannot fall
through to clause-only shortening merely because timing overflows are also
present. Minor factual/timing defects continue to use local patches. The preflight
cache policy is version 2 so an old completed-but-undersized inspection is not
silently reused after this change.

Repair patches normalize duplicate removals and let a removal supersede an edit
to the same unit. New-unit IDs are allocated locally on collisions, including a
removed `new_unit_1` being reintroduced elsewhere. Identical additions at the same
anchor are deduplicated. Unknown anchors, beats and source references still fail;
the approved hook and source-backed payoff stay protected.

Measured clause repairs enforce the final spoken word count in the correction
loop, rather than rejecting an overlong word array at the generic JSON boundary.
Valid repairs are retained; only the groups that exceeded their measured budget
are requested again with their actual count and limit. After two analysis-model
attempts, only unresolved groups go to the configured quality model for three
complete alternatives. Each alternative is a sentence string: nested word arrays
were sometimes interpreted as arrays of whole alternative sentences and joined
into a longer paragraph. The most detailed complete candidate within the hard
spoken-word budget is selected; words are never truncated into fragments.

Accepted sentence repairs are persisted immediately with fingerprints of their
original text, measured budget, language and source evidence. A later failure or
interruption retains them, so resume requests only unfinished groups. Exhausted
word-budget repairs return a structured quality-blocked checkpoint rather than
an unhandled IPC exception. Budget, authorization and cancellation errors keep
their original behavior.

Preflight also records the exact downstream script/plan/evidence fingerprint
after measured-timing and rendered-video repairs. Resume continues the current
stage instead of running a global script rewrite again; changed user inputs,
voice settings or source evidence invalidate that record. This record is only
stage provenance and cannot approve the rendered video. Timed blocking review
findings restrict patches to affected units and their immediate neighbors.
At most two quality patches are allowed for distinct remaining findings; the
same unresolved focus and issue type stops instead of repeating indefinitely.
All changed drafts still require a fresh audiovisual review and the existing
quality, source-support and duration gates.

Whole-script editorial findings now identify affected speech-unit IDs so local
text defects can be patched without invented audiovisual timestamps. The rubric
checks meaning against both visual evidence and source dialogue/context notes;
natural paraphrases and names merely omitted by sparse captions are not factual
contradictions. It must still identify unsupported claims and score independently.
Only the text-review cache advances to version 3; real video observations remain
reusable when the draft and its evidence have not changed.

When an exact source audit disproves an event's old label, its derived writing
notes move to `anchorAudit.invalidatedNarrativeContext` for history. They are
excluded from subsequent repair and review prompts, including old checkpoints
that still contain those notes. This prevents a contradicted draft claim from
reappearing through stale narrative context after the visual label is corrected.

### Final render recovery

Draft/master segment encodes bound decoder, filter-pool and encoder threads
separately. Three concurrent CPU encodes no longer each request all available
cores. Execution-only thread limits do not invalidate completed segment cache
entries; source, framing, speed, timing, audio and codec/quality settings still do.

A failed video batch waits for all siblings to settle before cleanup or retry.
Recognized encoder/resource failures get one serialized retry with a smaller
thread budget; only failed segments are retried. The same policy applies to the
final subtitle/audio mux. Cancellation, invalid parameters, missing inputs,
permission errors and full disks are not retried as resource pressure. Persistent
failures stop with their stage and actual segment index, preserving completed work.

FFmpeg errors retain complete stderr and the command. Diagnostic logs are saved
beside the output in `.recap-render-errors`; the UI summary includes opening error
lines and a linkable path, rather than only the generic final 600 characters.

### Protecting long-form scope during timing repairs

The planner estimates both the current script and the loss from fitting its
overflowing clauses before generating a new full narration track. A valid long
script cannot be replaced by a majorly shorter rewrite, even when every returned
event ID is valid. Candidate rewrites are grounded and measured with the current
voice cadence before admission. One bounded reallocation may be requested; a
rejected candidate leaves the previous script and cached audio intact. Resuming
the same rejected inputs does not repeat the paid repair. Actual TTS measurements
remain authoritative when a complete matching audio cache is available.

Legacy scene-frame projects can recover omitted supporting context only within
their already selected consecutive scene IDs, at most 24 seconds per candidate.
An independent pass watches and listens to the actual source chapters and must
approve both the event claim and the entire proposed range. The model cannot
invent timestamps or allocate unselected neighboring shots. Approvals are saved
chapter by chapter; failed or cancelled work resumes from unfinished chapters.
Audited events are excluded, and a changed source invalidates the observations.
An unambiguous cached chapter script may restore content lost by earlier global
shortening, but corrected source evidence prevents restoring obsolete claims.

When local shortening would collapse the recap's scope, the repair can redistribute
useful detail to uniquely referenced groups with verified spare moving footage.
The approved hook and shared footage are excluded. Expansion word targets are
planning guidance rather than per-sentence lower quotas; a useful complete
sentence is not padded merely to satisfy its target count. The hard upper word
budget and aggregate scope/fitted-duration checks still
apply before TTS. This is no guarantee that any requested duration is achievable:
insufficient evidence produces a structured scope block with the measured
capacity, rather than fabricated detail, repeated shots, slower speech or an
unhandled export exception. The independent rendered-video quality gate is
unchanged and cannot be satisfied by a preflight estimate.

Recap source-coverage and video-review calls supply model-specific deadlines
(Flash: two minutes; Pro: four minutes). Vertex now honors these per-request
limits, capped by the user's configured timeout, instead of silently waiting for
the global 15-minute default. An expired HTTP call is aborted and classified as
a retryable request timeout; model fallback retains the same media. Other Vertex
workflows keep their configured default when no per-request limit is supplied.
Missing AI JSON fields are response-contract errors rather than missing runtime
or credential errors. Exhausted clause contracts retain accepted repairs and
return a structured timing block instead of crashing the recap IPC handler.

### Dense chapter source alignment

Source alignment returns `placements: [{event_id, passage_id}]` instead of an
object with one required schema property and description per event. The previous
schema reproduced Vertex HTTP 400 on a real 132-event chapter; the same chapter
and model succeeded with the constant-shape list schema. Local validation still
requires every supplied event exactly once, with known event and passage IDs
(or an explicit `omit`). Duplicate, missing and unknown records are rejected.
Model record order cannot change the code-controlled chronological references.
Existing aligned chapter checkpoints remain reusable; changing this transport
does not rewrite completed chapters or the unaligned chapter's saved narration.

Scene indexing no longer imposes an arbitrary four-ID maximum on an event. A
single action can cross more than four short shots. Known IDs, consecutive
scene references, the observed anchor and the existing 24-second source-range
checks still apply. Valid rapid cuts do not spend extra model fallback calls
merely because their list contains five or more scene IDs.

### Measured timing recovery before global compression

Scope planning also projects the ordinary shortening margin below clause word
ceilings. A best-case fitted duration just above the 35% hard bound no longer
prevents source-context verification when natural repairs would fall well below
it. This runs before another global compression or a new narration track.

When independent source observations only extend the existing verified ranges,
the exact completed script review can be retained. Its prior fingerprint must
match, all event descriptions and contextual claims must be identical, and each
changed range must match both its approval and original bounds (within the
existing millisecond rounding tolerance). Timing estimates are recomputed.
Changed scripts, claims, unsupported ranges and incomplete observations cannot
inherit that review. The changed rendered video still requires fresh audiovisual
review; this optimization does not approve a draft or master.

Overlapping analysis chunks can give two IDs to the same pixels. If a reference
is wholly covered by a clip already rendered inside the same spoken clause
group, it is recorded as covered rather than falsely missing. The group timeline
is repartitioned without a duplicate output slot. No source capacity or hold
allowance is added, and an earlier clause/unit cannot supply this coverage.
Real draft/master render tests check both duration and narration across the cut.

When the only blocking quality verdict concerns missing narrative context,
repair that causal gap and any associated factual narration issues. Unrelated
nonblocking visual observations must not trigger a source-audit sweep. Blocking
visual or character issues still require source verification, and every changed
draft still receives fresh audiovisual and complete-narrative review.

The complete-narrative verdict uses the quality model and checks the whole script
for paraphrases before declaring a causal event missing. Its text cache is
versioned independently of the completed audiovisual observations. A successful
source audit checkpoints the pending repair stage before the next paid request;
an interruption retains the failed quality gate and resumes that repair instead
of repeating upstream script review. It cannot approve the unchanged draft.

Draft review also receives independent source-clip observations when a completed
fixed-range audit covers the exact rendered source interval. This helps resolve
ambiguous identities in the small portrait analysis preview. Unverified labels,
changed/outgrown ranges and clips outside the excerpt cannot supply that
context; the model must still assess the rendered timing and visible defects.
