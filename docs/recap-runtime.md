# Recap local runtime

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
are bounded to 8192 tokens and verification reserves $0.05 below its $6 ceiling.
The latest real-source run remains incomplete: it stopped at the temporary
Vertex daily spending limit. A new final master has not been verified for this
revision; passing local/render tests must not be reported as that verification.

Vertex requests omit an unspecified thinking budget. Explicit zero is raised to
128 for Gemini 2.5 Pro, which cannot disable thinking; Flash retains zero.
See [Google's thinking documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thinking).
