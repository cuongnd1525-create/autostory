# RecapTool Studio (cineviral-studio) — Root-Cause Audit & Redesign

**Scope:** Why the pipeline can understand a video, generate a script, and render a video, yet still fail to produce an editor-grade True-Crime / Bodycam TikTok recap — and exactly what to change, mapped onto the real codebase.

**Method:** The full `electron/services/` tree, `tools/`, `main.js`, prompts, schemas and tests were read from the connected `D:\Project\cineviral-studio` folder. Every claim below is tied to a file and approximate line. Where the code contradicted an initial hypothesis, the conclusion was changed (noted explicitly). Nothing was modified.

---

## 1. Executive Diagnosis

The tool does not fail because "the prompt is weak" or "the hook needs work." It fails for three structural reasons, in order of impact:

**(A) There is no single, authoritative, whole-video understanding.** The system never builds one rich, persistent "what happened in this source" model. Instead it has *two disconnected understanding tracks* — a local OpenCV+transcript heuristic track (`scene_metadata.py`, `evidenceStoreService.js`) that never watches the video and explicitly refuses to assess emotion, and a Vertex multimodal track (`autoStorySourceEngine.js`) that watches only **6–10 candidate windows at 2 fps, low resolution**, and **re-derives understanding from clips on every stage** rather than reading a shared artifact. Non-speech audio (gunshots, sirens, crashes, the raised voice, the silence before an answer) is **not detected anywhere**. Because the AI never holds the whole story with tension, audio events and epistemic status attached, it cannot reliably find the strongest moments or build genuine escalation. It reconstructs from a coarse proxy and a transcript — which is exactly what "AI-generated / chronological summary" feels like.

**(B) The best editorial machinery the project already owns is wired into dead or legacy paths, or downgraded to advisory warnings — so the live path runs on heuristics and model self-assessment.** The deterministic narration-grounding, provenance and voice/visual-alignment services (`narrationGroundingService.js`, `narrationProvenanceService.js`, `voiceVisualAlignmentService.js`) are referenced **only** in `pipelineService.js` — the previous-generation recap engine that the README says is hidden from the UI (`pipelineService.js:19,3370,3421,3436`; README line ~315). Real sidechain **audio ducking** exists (`ffmpegService.js:468,856`) but is called **only** from that same legacy dubbing path — the live highlight path hard-mutes source audio instead. Story-beat compilers with causal-link and arc-order enforcement (`storySpineCompilerService.js`) validate a *manual* Gemini plan, not the automated output. The live automated engine (`autoStorySourceEngine.js`) therefore leans on **model-self-reported** flags (`assessment.grounded`, `duplicateMeaning`) with no deterministic evidence or dialogue-redundancy check.

**(C) Voice/TTS is a flat layer bolted on top, and it destroys the footage instead of collaborating with it.** The `emotionTag` the script model emits is **parsed and then dropped** before synthesis — `grep emotionTag dubbingService.js` returns zero hits (`dubbingScriptService.js:73` sets it; the dispatcher `dubbingService.js:4429–4527` never passes it). The default audio mode mutes original bodycam audio to zero under narration (`dubbingService.js:514,518`; `ffmpegService.js:486,511`), so the narrator competes with — and erases — the very audio that carries the tension. Segments are hard-concatenated with no crossfade (`ffmpegService.js:1040`), and short/failed voice in muted segments produces literal dead air.

The net effect: an intermediate JSON that reads plausibly, rendered by a pipeline that never watched the whole story, judged by heuristics, and voiced by a flat engine over muted source. That is why it feels *generated*, not *edited*.

One important correction to a common hypothesis (per your Rule 2): **the live `autoStory` v2 path is NOT a single overloaded generation pass.** It is already multi-stage (discovery → hook audition → blueprint → layout → narration → voice-fit → review; see §2). The "one AI does everything at once" failure mode is real, but it lives in the **manual Gemini** and **legacy editorial** prompts (`autoStoryEditorial.js:75-83`, `manualGeminiPackService.js:1291-1320` — 13 numbered tasks in one instruction), not in the automated engine. So the fix is not "split the pass" — it is "give the already-split passes a real shared brain, wire in the gates you already built, and stop muting the footage."

---

## 2. Current Pipeline (reconstructed from code)

The app is `RecapTool Studio`, a local-first Electron app (`package.json`, README). There is not one pipeline — there are **four parallel engines** plus dead code:

| Engine | Files | Status | Notes |
|---|---|---|---|
| **A. Legacy recap** | `pipelineService.js` (268 KB) + `viralIntelligenceService.js` | Half-wired: `new PipelineService` at `main.js:474`; IPC `project:plan/preview/render` at `main.js:822–1221`. README says AI-recap modes hidden from UI. | Keyword-weighted-sum ranker, fixed 7-slot beat template. **Sole owner** of the deterministic grounding/provenance/voice-visual services and (via dubbing) sidechain ducking. |
| **B. AutoStory (LIVE)** | `autoStoryFastService.js` (aliased `AutoStoryPipelineService`, `main.js:14,710`) → forks to **v2** `autoStorySourcePipeline.js`+`autoStorySourceEngine.js` (`autoStoryFastService.js:560`) or inline v1 | **This is the live automated recap engine.** | Real Vertex multimodal on proxy clips. Multi-pass. Details below. |
| **C. Manual Gemini / Story spine / Recut / Podcast** | `manualGeminiPackService.js` (185 KB), `geminiDraftReviewService.js` (104 KB), `storySpineCompilerService.js`, `storyRecutService.js`, `podcastCandidateService.js` | Live as separate IPC channels (copy/paste-to-Gemini workflows). | Rich prompts + genuine narrative-beat validators, but **authoring is Gemini's**; these files only validate/compile. |
| **Dead** | real `AutoStoryPipelineService` class `run()` in `autoStoryPipelineService.js:476`; `autoStoryHookLab.js` (called only from that dead class, `autoStoryPipelineService.js:793`) | Never instantiated (only `Legacy.normalizeConfig` is used). | Metadata-only hook generation (empty `filePaths`, `autoStoryHookLab.js:14-26`). |

### The live automated pipeline (Engine B, v2 source-contract)

All `ask/stage` steps are **cloud (Vertex AI)**; all ffmpeg/TTS steps are **local**.

```
Source video / YouTube URL
  └─ sourceDownloadService (yt-dlp, ≤1080p, prefer author EN subs)
  └─ subtitleService: local ASR — faster-whisper / Parakeet / whisper CLI (word timestamps produced)
1. PREPROCESS  (local)  autoStorySourcePipeline.js:70 — measure TTS words/sec, ffprobe duration
2. OVERVIEW PROXY (local ffmpeg)  :93 — 4 fps, 640px proxy of whole source
3. DISCOVERY (Vertex flash)  autoStorySourceDiscovery/engine.ask('v2-discovery') — IN: duration + full transcript cues + 4fps overview.  OUT: 6–10 scored candidate windows
4. RANK/PARTITION (local, no AI)  autoStorySourceGates.rank + partition → candidate-ranking-v2.json
5. EVIDENCE PROXY for selected (local ffmpeg)  engine.prepare(selected, fps 2, 640px)
6. HOOK AUDITION (Vertex)  autoStoryHookSelection.select — listens to real candidate-hook clips
7. BLUEPRINTS (Vertex flash)  engine.ask('v2-blueprints') — compact story blueprint per shortlisted story
8. PER-STORY EDIT (Vertex pro)  engine.edit → ask('v2-…-edit', schema=layout) "pick source ranges in order; DO NOT write narration yet"
9. NARRATION (Vertex pro)  engine.finish → ask('v2-narration') "write narration ONLY for flagged bridge ranges"
   9b. VOICE FIT (local TTS measure + Vertex 'v2-voice_repair')  shorten if measured audio overruns clip
10. COMPILE + VALIDATE (local)  autoStoryTimelineCompiler.compile + validateDuration → script-<id>.json
11. RENDER DRAFT (local ffmpeg)  dubbing.renderHighlightFastDraft (9:16, captions, mix)
12. REVIEW (Vertex pro)  autoStorySourceReview — watches the rendered draft proxy; verdict+score+issues
    12b. REPAIR (Vertex)  one revision only → re-render → re-check
Final render  (local ffmpeg)
```

**Hard-coded vs AI:** duration bounds `MIN 65s / MAX 600s` (`autoStoryPipelineService.js:11`), output count 1–5 (user), candidate pool `min(5,max(3,count+2))`, scene cap 50 (`autoStorySourceGates.js:73`), `playbackSpeed:1` (`autoStoryFastService.js:126`), `muteSourceDuringNarration:true` + `mixer.sourceVolume:0` (`autoStorySourcePipeline.js:86`) are **hard-coded**. Scene count, source ranges, `storyRole`, and `audioIntent` are **AI-chosen**.

**Call budget:** 16 Vertex calls/run default (`autoStoryFastService.js:180`), $240 total / $5-day budget guards (`vertexAiService.js:376-377`).

---

## 3. Root Causes (ranked by impact)

Format per your spec: **Evidence → Mechanism → Effect → Why it hurts retention → Fix.**

### RC-1 (P0) — No shared, whole-video "story memory"; understanding is coarse and re-derived per stage
- **Evidence:** Discovery sees only a 4 fps overview + transcript (`autoStorySourcePipeline.js:18,93`). Every later stage re-cuts clips and re-sends them; "understanding is re-elicited from clips each stage… no persisted 'what happens' artifact consumed downstream" (cost audit Q5; `autoStoryFastService.js:639-655,747-754`). The whole video is never uploaded on the live path; the model reasons over per-clip proxies at `videoFps:2, MEDIA_RESOLUTION_LOW` (`autoStorySourceEngine.js:43`). The legacy `pipelineService` re-uploads the full video three times (`geminiService.js:1689,1970,2048`).
- **Mechanism:** Because no stage holds the entire timeline of events, "find the strongest moments" is really "pick among 6–10 windows the discovery pass happened to surface from a 4 fps skim." Blueprints then reason over candidate *summaries* (`shortlist.map(publicStory)`), not the source.
- **Effect:** Missed strong moments; escalation that doesn't actually escalate (the model can't compare intensity across the whole source); a "chronological summary" feel.
- **Why it hurts retention:** Retention is won by *sequencing the single most arresting beats in a rising curve.* You cannot sequence what you never comprehensively saw.
- **Fix:** One **Source Story Model** pass over the whole source (low-fps, cached), persisted as an artifact every stage reads. See §6 / §7 / §14.

### RC-2 (P0) — The deterministic editorial gates the project already owns are not in the live path
- **Evidence:** `narrationGroundingService`, `narrationProvenanceService`, `voiceVisualAlignmentService` are imported/called **only** in `pipelineService.js:19,3370,3421,3436` (narration audit Q3). Sidechain ducking `sidechaincompress=…` exists at `ffmpegService.js:468,856` but callers are **only** `pipelineService.js:5059/5400/5513/5644` (TTS audit Q3). In the live v2 path, grounding is `assessment.grounded` — a **model-self-reported boolean** (`autoStorySourceContracts.js:14`) — and the only anti-redundancy is the model filling a `duplicateMeaning` array it is asked to populate (`autoStorySourceGates.js:52`).
- **Mechanism:** The live engine trusts the model to grade its own grounding, spoilers and redundancy. Grounding checks that *do* exist emit **warnings that never block** (`narrationGroundingService.js:404` — every issue is `severity:"warning"`, so `passed` is structurally always true; `renderQaService.js:395` ignores warnings).
- **Effect:** Descriptive narration, narration that repeats on-screen dialogue, and premature reveals slip through; source audio gets muted with no ducking fallback.
- **Why it hurts retention:** Redundant/descriptive narration is dead weight the viewer's brain discards; muted source kills the visceral moment.
- **Fix:** Unify on one engine and port these services in as **blocking** gates (§8, §15).

### RC-3 (P0) — `emotionTag` / storytelling intent is dropped before TTS; source audio is muted, not ducked
- **Evidence:** `dubbingScriptService.js:73` stores `emotion`; `grep emotionTag dubbingService.js` = 0 hits; dispatcher `dubbingService.js:4429-4527` passes none of it to any engine; `emphasisWords` collected (`:1233`) and hashed into the cache key (`:1289`) but never sent. Default path: `getHighlightAudioMode` returns `voiceover_only` (`:518`), `sourceVolume` defaults `0` (`:514,5230`), and `mixVideoAudioWithVoice` short-circuits to `replaceVideoAudio` dropping `[0:a]` when source≈0 (`ffmpegService.js:486,511`).
- **Mechanism:** The narrator reads flat regardless of scene tension, and the bodycam audio bed is deleted underneath it.
- **Effect:** "Emotionally flat," "voice sits on top of the video," "feels like an audiobook over a slideshow."
- **Why it hurts retention:** Prosody variance and authentic audio are the two biggest micro-retention levers in bodycam content; both are disabled.
- **Fix:** Carry emotion/prosody to TTS; make ducking the default (§12).

### RC-4 (P1) — Clip ranking optimizes low-level/keyword signals; "narrative role" is assigned by position, not content
- **Evidence:** `actionCandidateService.js:101` `combined = motion*0.65 + audio*0.25 + cutPace*0.1`, and its own output says "scores do not prove narrative importance" (`:212`). `viralIntelligenceService.js:254` is a hand-tuned weighted sum of **keyword-derived** sub-scores (`includesAny(text,["attack","danger"…])`, `:192-227`). Roles are positional: `purposeForSegment` returns `"hook"` because `index===0` and `"loop_ending"` for the last (`viralIntelligenceService.js:437`). The emotion curve is a hard-coded table (`:423-428`), not derived from content.
- **Mechanism:** The clip's role does not come from the clip; the story is a template clips are poured into.
- **Effect:** Individually-relevant clips that don't build momentum together — exactly your reported symptom.
- **Why it hurts retention:** No genuine setup→escalation→payoff means no reason to keep watching.
- **Fix:** Story-first beat design + narrative-function-scored selection (§5, §9). (Note: this is the *legacy* Engine A behavior; the v2 engine is better but still selects from a thin candidate set — RC-1.)

### RC-5 (P1) — The narrator cannot create curiosity: no open-loops/foreshadowing; strictly sequential; self-graded
- **Evidence:** No `open_loop` or `foreshadow` field exists in any schema (schema audit Q3). The system is explicitly sequential — "hook-to-context-to-first-dialogue handoff" (`autoStorySourceEngine.js:115`), and `reveal_before_setup` is **penalized** (`narrationGroundingService.js:343`). There is no per-segment `tension` field. Narration grounding to evidence and non-repetition of dialogue are model-self-attested in the live path (RC-2).
- **Mechanism:** The schema and grounding *actively prevent* the open-loop/foreshadow behavior you asked for ("maintain open loops," "foreshadow upcoming events"). The narrator can only summarize causally after the fact.
- **Effect:** No forward pull; narrator explains what's already visible.
- **Why it hurts retention:** Open loops are the primary retention mechanic; the model is structurally forbidden from opening them.
- **Fix:** Add open-loop / foreshadow / viewer-question fields as first-class, and reward (not punish) *setup-without-payoff* when a later beat closes the loop (§7, §8).

### RC-6 (P1) — The critic can't catch "missed strong moments" and optimizes on model opinion, not a retention proxy
- **Evidence:** The review watches the rendered draft proxy (good) but compares only against *supplied* evidence and is told "If an important alternative is not present in the supplied media, report that limitation rather than claiming a whole-source comparison" (`autoStoryEditorial.js:92`). Only **one** revision is allowed (`autoStorySourceReview.js:104-125`; "One automatic revision only" `autoStoryEditorial.js:88`). `attentionQa.hookScore` is `hookIssue ? 0.62 : 0.90` — a regex/word-count heuristic (`viralIntelligenceService.js:506-621`). `viralScore` carries the disclaimer "AI dimensions; locally weighted, not a view-count prediction" (`autoStorySourceGates.js:23`) and is recorded but never optimized toward.
- **Mechanism:** The critic can only critique what it was handed; it never re-scans the source for a better beat.
- **Effect:** Weak beats survive; the loop can't self-improve past one pass.
- **Fix:** Give the critic read access to the Source Story Model so it can say "stronger beat exists at t=…"; allow bounded multi-pass (§13).

### RC-7 (P1) — Non-speech audio and word-level timing are computed then discarded
- **Evidence:** No gunshot/siren/crash/SED detector anywhere (`grep gunshot|siren|crash|yamnet|panns|sed` = 0; source audit Q6). `audio_energy` is derived from **transcript punctuation** (`scene_metadata.py:76-93`). Word-level timestamps are written to `.words.json` (`faster_whisper_transcribe.py:150-164`) but the story engine ingests only segment-level cues (`autoStoryMediaIndexer.js`, `autoStorySourcePipeline.js:80`).
- **Mechanism:** The system is blind to the loudest, most cuttable moments (the slam, the scream, the silence) and can't cut on the beat because it throws away word timing.
- **Effect:** Cuts land off the emotional beat; the "strongest moment" is invisible to selection.
- **Fix:** Add a cheap non-speech audio-event pass and keep word timing in the Story Model (§6).

### RC-8 (P2) — Architectural sprawl and prompt/schema drift
- **Evidence:** Four engines + dead code (§2). Prompt asks for ~15 EDL fields but the schema validates only 6 (`autoStoryPrompts.js:175` vs `autoStorySchemas.js:275`). Three different hook-length rules coexist ("entry test not a duration limit" `autoStoryEditorial.js:42` vs "3–20 seconds maximum" `autoStorySourceContracts.js:39` vs judge "first 3 seconds" `autoStoryPrompts.js:151`). The access-gate block is re-stated verbatim in every prompt (token waste).
- **Mechanism:** Maintenance load is enormous; fixes made in one engine don't reach the live one; unvalidated fields let the model drift.
- **Effect:** Slow iteration, inconsistent behavior, wasted tokens.
- **Fix:** Consolidate to one engine, one schema (validate every field the prompt requests), one shared instruction block (§11, §15).

---

## 4. Why the Narrator Currently Fails (dedicated analysis)

Your instinct that "the narrator describes what's visible / summarizes / connects with flat sentences" is correct, but the cause is **not** a bad narration prompt — the prompts are actually good. Evidence: the live engine already instructs "Narration connects context, causality, time jumps… it never describes an obvious visual" (`autoStoryPrompts.js:177`) and "Add meaning rather than describe visible actions" (`autoStoryEditorial.js:75`), and it *does* pass the narrator the whole arc + all sibling decisions + the source transcript in one coherent pass (`autoStorySourceEngine.js:114`). So the narrator is being told the right thing and given decent context.

It fails downstream of the words, for five concrete reasons:

1. **No enforcement.** The instruction "don't describe / don't repeat dialogue" is graded by the model itself (`assessment.grounded`, `duplicateMeaning`), because the deterministic checks live in the legacy path (RC-2). When the model slips, nothing catches it.
2. **Thin evidence to be interesting about.** A great narrator line adds information the footage can't show — a prior fact, a contradiction, a consequence. But the Source Story Model doesn't contain that (RC-1, RC-7): no character roles/goals populated from raw source (`characterTrackingService.js:76-77` — `knowledgeState`/`emotionState` always empty), no epistemic status, no off-screen facts. With nothing external to add, the model falls back to describing what it *can* see.
3. **Curiosity is structurally forbidden.** No open-loop/foreshadow fields; premature-reveal is penalized (RC-5). The narrator can only close loops it already opened in-scene, so it defaults to after-the-fact connective tissue.
4. **Flat delivery.** Even a perfect line is read with no emotion because `emotionTag` is dropped before TTS (RC-3). "What the officer doesn't know yet…" delivered flat lands like a Wikipedia sentence.
5. **It competes with the footage instead of handing off to it.** Because source audio is muted under narration (RC-3), the intended "narrator sets up → bodycam delivers" rhythm becomes "narrator talks over a silenced clip." The handoff the prompt asks for (`:115`) is physically erased by the mixer.

**Conclusion:** the narrator is a *content and delivery* problem, not a *wording* problem. Fix the Story Model (give it something worth saying), enforce non-description deterministically, allow open loops, carry emotion to TTS, and duck rather than mute so the footage can answer.

---

## 5. Target Editorial Model (how the redesigned system should think)

Encode the human editor's questions as explicit stages, not hopes (your Rule / Task 17):

1. **"What actually happened, everywhere in this source?"** → one Source Story Model (events, people+roles, quotes with speaker+epistemic status, non-speech audio events, tension, visual quality), built once, cached, reused. (Replaces RC-1/RC-7.)
2. **"Of everything that happened, what is the ONE story worth telling in 60–90s?"** → a Story-Design pass that chooses a spine (central question, promise, escalation, turn, payoff) *before* any clip is chosen.
3. **"Which real moment best delivers each beat?"** → clip selection scored by *narrative function fit*, not raw salience; de-dup by *purpose*, not just footage.
4. **"What can the footage say by itself? What must the narrator add? When must the narrator shut up?"** → an audio-role decision per beat (ORIGINAL / NARRATOR-SETUP→ORIGINAL / NARRATOR-OVER / SILENCE) made *with* the footage, not after it.
5. **"Does this earn the next five seconds?"** → open-loop bookkeeping and a retention-curve check across the whole timeline.
6. **"Watch it like a viewer. Where do I get bored or confused?"** → a critic with whole-source awareness and bounded iteration.

The script is an *intermediate representation*; success is the watch experience (your Rule 5). Every stage below is judged by "does this make the final cut feel edited."

---

## 6. Proposed Architecture (complete redesigned pipeline)

Recommendation: **keep the v2 multi-pass shape — it's the right skeleton — but add a shared brain, wire in the gates, and unify.** Do **not** rebuild from scratch and do **not** collapse to a single pass.

```
                ┌───────────────────────────────────────────────┐
                │ INGEST (local): download, ASR (KEEP word ts),  │
                │ shot cuts, + NEW cheap non-speech audio-event   │
                │ pass (RMS/loudness peaks + optional YAMNet)     │
                └───────────────────────────────────────────────┘
                                     │
   PASS 0  SOURCE STORY MODEL  (Vertex flash, ONE whole-source pass, CACHED via cachedContent)
           IN: whole source @ low fps + full transcript + audio-event track
           OUT: persisted story-model.json — events[], people[], quotes[](speaker+epistemic),
                audioEvents[], tensionCurve[], visualQuality[]           ◄── every later stage READS this
                                     │
   PASS 1  STORY DESIGN  (Vertex pro, text-only — cheap)
           IN: story-model.json (NO video). OUT: 1–N story spines (beats, open-loops, info-budget)
                                     │
   PASS 2  BEAT→CLIP CASTING  (Vertex flash, targeted clips only)
           For each beat, choose the real moment that best serves its narrative_function;
           dedup by purpose; verify audio cleanliness on the chosen clip
                                     │
   PASS 3  AUDIO-STORY + NARRATION  (Vertex pro, one coherent pass over the whole timeline)
           Decide audio_mode per beat (ORIGINAL / SETUP→ORIGINAL / OVER / SILENCE);
           write narration ONLY for information-gap ranges; open/close loops; set emotion+prosody
                                     │
   PASS 4  COMPILE + DETERMINISTIC GATES  (local, BLOCKING)
           voice-fit (measured TTS) · narration-grounding · dialogue-redundancy ·
           spoiler/info-budget · beat-order · dedup · duration
                                     │
   PASS 5  RENDER DRAFT  (local ffmpeg) — DUCK source (default), crossfade handoffs
                                     │
   PASS 6  CRITIC  (Vertex pro) — watches draft proxy + can query story-model.json
           ("is there a stronger beat at t=… that was skipped?") → structured patch
                                     │
       bounded loop (≤2) → PATCH (regenerate only affected beats) → re-render → re-check
                                     │
   FINAL RENDER (local)
```

Model tiers: Pass 0 = flash (cached); Pass 1 = pro but text-only (cheap); Pass 2 = flash on targeted clips; Pass 3 & 6 = pro. This keeps pro reasoning for editorial judgment while the expensive multimodal understanding happens **once** (§14).

---

## 7. Story Representation (data model for beats)

Two artifacts. **Source Story Model** (the shared brain) and **Story Spine** (the chosen narrative). Your proposed per-beat fields are good; below is a refined taxonomy grounded in what this codebase can actually populate.

### 7a. Source Story Model (`story-model.json`) — built once in Pass 0
```jsonc
{
  "sourceId": "…", "durationSec": 1840,
  "people": [{ "id":"p1","label":"Driver","role":"suspect",
               "firstSeenSec":42.0,"knowledge":["knows warrant"],"epistemic":"inferred" }],
  "events": [{ "id":"e17","startSec":612.4,"endSec":631.0,"type":"confrontation",
               "summary":"Driver refuses to exit vehicle",
               "peopleIds":["p1","p2"],
               "tension":0.86,               // 0–1, from audio-events + visual motion + dialogue
               "visualQuality":0.7,          // clarity/framing usable for 9:16
               "novelty":0.8,"causalParents":["e12"],
               "isReveal":false,"spoilsEventId":null }],
  "quotes": [{ "id":"q9","eventId":"e17","speaker":"p1","speakerRole":"suspect",
               "text":"I'm not getting out of the car",
               "epistemic":"suspect_statement",     // known_fact | allegation | officer_claim | suspect_statement | inference | unknown
               "startSec":615.1,"endSec":617.0,"impact":0.9 }],
  "audioEvents": [{ "type":"raised_voice","startSec":614.0,"endSec":618.0,"peak":0.94 },
                  { "type":"door_slam","startSec":631.0,"peak":0.7 }]
}
```
The two additions that unlock everything: **`epistemic` on every quote/fact** (your Rule 8) and **`audioEvents` + `tension`** (RC-7). These are what let the narrator add non-visible information and let selection find the real peak.

### 7b. Story Spine beat (chosen narrative) — Pass 1/3
```jsonc
{
  "beatId":"b3",
  "narrativeRole":"escalation",        // taxonomy below
  "viewerQuestion":"Will he actually run?",   // the open question this beat services
  "opensLoopId":"L2", "closesLoopId":null,    // explicit open-loop bookkeeping
  "newInformation":["driver has an outstanding warrant"],
  "informationClass":"reveal",         // immediate | deferred | reveal | payoff | omit
  "tensionBefore":0.55,"tensionAfter":0.8,
  "sourceEventId":"e17",               // FK into story-model, timestamps come from here (locked)
  "audioMode":"setup_then_original",   // see §8/§12
  "originalQuoteIds":["q9"],
  "narratorFunction":"foreshadow",     // taxonomy §? (Task 6)
  "narratorText":"What the officer doesn't know yet is that this stop already came back with a warrant.",
  "transitionFromPrev":"time_continuous","transitionToNext":"hard_cut",
  "durationTargetSec":7.5
}
```

**Narrative-role taxonomy (refined from yours):** `cold_open` · `hook` · `setup` · `escalation` · `complication` · `reveal` · `reversal` · `confrontation` · `pursuit` · `apprehension` · `resolution` · `aftermath` · `button` (final 1–2s payoff-stinger). This maps cleanly onto existing `storyRole` values (`autoStorySourceContracts.js:19`) so the compiler needs only an alias table, not a rewrite.

---

## 8. Narration Architecture (rules + narrator↔footage handoff)

**Principle (encode, don't hope):** narration is generated **only** for an *information gap* — the delta between (what the beat needs) − (what the footage shows) − (what the original dialogue says). Compute the gap explicitly; if it's empty, `audioMode` must be `original` and `narratorText=""`.

### Narrator functions (Task 6), as a required enum
`CONTEXT` · `BRIDGE` · `FORESHADOW` · `OPEN_LOOP` · `ESCALATION` · `CLARIFICATION` · `TIME_JUMP` · `LOCATION_CHANGE` · `IDENTITY` · `CONSEQUENCE` · `RECAP` · `PAYOFF_SETUP`. **A segment with no function ⇒ delete the narration** (make it `original`). Enforce in the compiler, not the prompt.

### Audio-role state machine (Tasks 7 & 8) — deterministic, per beat
```
                    ┌──────────────┐
 beat.tension≥0.7  │ high-impact? │  yes → ORIGINAL_AUDIO (let it breathe; narrator silent)
 or audioEvent     └──────┬───────┘        e.g. gunshot, crash, arrest, the answer, the denial
 in beat                  │ no
                          ▼
        infoGap empty? ──yes──► ORIGINAL_AUDIO
                          │no
                          ▼
   gap needs setup BEFORE the moment? ──yes──► NARRATOR_SETUP → ORIGINAL   (narrator sets up, then hands off)
                          │no
                          ▼
   original audio unclean (host/mixed, classifier)? ──yes──► NARRATOR_OVER (duck bed low)
                          │no
                          ▼
                  NARRATOR_OVER (ducked)   ── or ──  SILENCE/AMBIENCE for a 1–2s breath before a reveal
```
This is exactly the "narrator sets up → footage delivers" pattern you want, made mechanical. The clean-audio classifier already exists (`autoStoryAudioClassifier.js:3`, `participant/officer/scene_sound` = keepable, `external_narrator/mixed` = replace) — reuse it as the "unclean?" test.

### Deterministic narration gates (port from legacy, make BLOCKING)
- **Dialogue-redundancy gate (NEW, closes RC-2/RC-5):** token-overlap(narratorText, originalQuoteIds[].text) > 0.5 ⇒ reject "narration parrots dialogue." (Extend `voiceVisualAlignmentService`'s Jaccard, which today only flags *too-low* overlap, to also flag *too-high* overlap with spoken lines.)
- **Description gate:** reuse `narrationGroundingService.js:364` `scene_only_captioning` — promote from warning to **error**.
- **Spoiler/info-budget gate:** a beat whose `informationClass==="reveal"` may not appear before the beat that `opensLoopId` for it; a `payoff` line may not state what a later footage beat is about to show (extend `reveal_before_setup`, `:343`, but invert the sign for *foreshadow* — foreshadow that opens a loop closed later is REWARDED).
- **Grounding gate:** every `newInformation` item must cite a `story-model` event/quote id; uncited ⇒ reject (this is the real fix for "don't fabricate," your Rule 8, enforced not prompted).

---

## 9. Clip Selection System (candidate generation + selection)

Replace "score salience, pour into slots" with "design beats, cast the best real moment per beat."

**Candidate generation:** from the Source Story Model, every `event` is a candidate (you already have events with tension/visualQuality/novelty). No separate keyword pass needed — retire `viralIntelligenceService`'s keyword sub-scores and `actionCandidateService`'s motion-only combine for *selection* (they can stay as cheap priors that seed tension).

**Selection = constraint satisfaction, not weighted sum** (your Task 9 asked for the best method — this is it). For each beat in the chosen spine, pick the event that maximizes *fit to that beat's function* subject to hard constraints:
- hard: covers the beat's `viewerQuestion` / required moment; correct people present; audio usable or gap-fillable; `visualQuality ≥ τ`; not already used for another purpose (purpose-dedup).
- soft (tie-break, in priority order, NOT summed): narrative-function match > tension delta matches `tensionBefore→After` > dialogue impact > novelty > brevity.

Why not a weighted sum: a weighted sum lets a very "visual" but story-irrelevant clip win. Lexicographic tie-breaking under hard narrative constraints guarantees every selected clip *earns its place in the arc* — the exact failure you described ("clips relevant individually, no momentum together"). Keep the existing **exact-footage dedup** (`autoStoryTimelineCompiler.js:73`) and **add purpose-dedup**: two beats with the same `(narrativeRole, sourceEventId-cluster)` ⇒ reject the weaker.

**Momentum check:** after casting, verify `tensionAfter` is monotonic-ish across escalation beats (allow one release dip before climax). This replaces the hard-coded emotion curve (`viralIntelligenceService.js:423`) with a curve measured from the chosen events.

---

## 10. JSON Schema (redesigned + realistic example)

Design goal (your Task 13): every field supports a real editorial decision; nothing decorative. This **supersedes** the current split between the rich prompt (~15 fields) and the thin `finalEdlSchema` (6 fields, `autoStorySchemas.js:275`) — validate everything you ask for.

```jsonc
{
  "schemaVersion": 3,
  "title": "Traffic stop escalates when driver refuses to exit",
  "language": "en",
  "totalTargetSec": 78,
  "spine": {
    "centralViewerQuestion": "Why won't he get out of the car?",
    "hookPromise": "A routine stop turns into a standoff",
    "informationBudget": { "immediate": ["it's a traffic stop"],
                           "deferred": ["driver's identity"],
                           "reveals": ["outstanding warrant"],
                           "omit": ["officer's badge number"] }
  },
  "openLoops": [{ "id":"L2","question":"Will he run?","openedByBeat":"b2","closedByBeat":"b5" }],
  "segments": [
    {
      "id":"b1","beatId":"b1","narrativeRole":"hook",
      "sourceEventId":"e17","sourceStartSec":615.1,"sourceEndSec":619.4,
      "startSec":0,"endSec":4.3,"playbackSpeed":1,
      "audioMode":"original_audio",
      "originalQuoteIds":["q9"],
      "narratorFunction":null,"voiceoverText":"",
      "emotionTag":"NEUTRAL","tensionAfter":0.8,
      "transitionToNext":"hard_cut",
      "caption":"", "previewVi":"Tài xế từ chối ra khỏi xe"
    },
    {
      "id":"b2","beatId":"b2","narrativeRole":"setup",
      "sourceEventId":"e12","sourceStartSec":40.0,"sourceEndSec":47.2,
      "startSec":4.3,"endSec":11.5,"playbackSpeed":1,
      "audioMode":"narrator_setup_then_original",
      "originalQuoteIds":["q3"],
      "narratorFunction":"FORESHADOW",
      "voiceoverText":"What the officer doesn't know yet is that this plate already came back with a warrant.",
      "newInformation":["outstanding warrant"], "newInformationRefs":["e5.fact"],
      "informationClass":"reveal", "opensLoopId":"L2",
      "emotionTag":"LOW_URGENT","prosody":{"rateDelta":-0.04,"pauseBeforeSec":0.3},
      "tensionBefore":0.4,"tensionAfter":0.6,
      "transitionFromPrev":"time_jump","transitionToNext":"time_continuous",
      "caption":"", "previewVi":""
    }
  ]
}
```
Fields **added** vs today: `spine.informationBudget`, `openLoops[]`, per-segment `narrativeRole`, `narratorFunction`, `newInformationRefs` (grounding FKs), `informationClass`, `opensLoopId/closesLoopId`, `tensionBefore/After`, `prosody`. Fields **kept**: `sourceStartSec/EndSec`, `startSec/endSec`, `playbackSpeed`, `audio_mode`, `voiceover_text`, `caption`, `preview_vi` (so the existing Highlight renderer still consumes it — see §15). Fields **removed**: unvalidated drift fields (`focusPriority`, `subtitlePriority`, `sourceNarratorDetected` as free text — fold into `audioMode`).

---

## 11. Prompt Architecture (the passes)

One shared, deduplicated preamble (the access-gate + anti-fabrication block, currently copy-pasted into every prompt — `autoStoryPrompts.js:15`, `autoStoryEditorial.js:33`, `geminiInputAccessGate.js`) defined **once**. Then one focused prompt per pass:

- **P0 Source Story Model:** "Watch the whole source. Output the event/quote/people/audio-event model. Tag every quote's speaker and epistemic status (known_fact | allegation | officer_claim | suspect_statement | inference | unknown). Do NOT write a script, EDL, or narration." (This is the `canonicalPrompt` philosophy — `autoStoryPrompts.js:26` — extended with epistemic + audio events, and run ONCE not per candidate.)
- **P1 Story Design (text-only):** "Given this model, design the single strongest 60–90s spine: central question, promise, escalation, one turn, payoff. Define open loops and the information budget. Choose beats by narrative function. No timestamps yet."
- **P2 Beat→Clip Casting:** "For each beat, pick the one source event that best delivers its function; justify against the beat's viewer-question; flag audio cleanliness."
- **P3 Audio-Story + Narration:** the existing strong narration prompt (`autoStorySourceEngine.js:114-115`) + the audio-role state machine + "write narration only for information-gap ranges; you MAY open a loop that a later beat closes; emit emotionTag + prosody per line."
- **P6 Critic:** existing draft-watching prompt (`autoStorySourceReview.js:27`) + "you may query the story model; name any stronger unused beat by timestamp; return a structured patch, not a rewrite."

Fix the contradictions (RC-8): one hook-length rule, one emotionTag vocabulary, schema validates every requested field.

Keep P0/P2 on flash, P1/P3/P6 on pro (P1 is text-only so pro is cheap).

---

## 12. TTS & Audio Strategy

Three defects to fix (RC-3), all in `dubbingService.js` / `ffmpegService.js`:

**(1) Carry emotion + prosody to TTS.** Today `emotionTag` dies at `dubbingScriptService.js:73` and the dispatcher `dubbingService.js:4429-4527` never forwards it. Thread `segment.emotionTag` + `segment.prosody` through `synthesizeDubbingVoice` into each engine. Per-engine capability (from the audit) and what to pass:
- **Edge** (`edgeTtsService.js:185`, real rate/pitch/volume) — map emotionTag→`applyEmotionOffsets` (already exists, `:138`, currently unreachable). Best default engine for narration.
- **ElevenLabs** (`elevenLabsService.js:100,203`) — map emotionTag→`performanceMode`/`voice_settings` (presets `hook/panic/story/cliffhanger` already exist; currently hard-pinned to `"story"`).
- **Kokoro** (`kokoroVoiceService.js:262`) — emotionTag→speed already coded (`URGENT→1.15`), just pass it; add pause support (it's the only engine with per-phrase pauses, `:4393`).
- **OmniVoice** (`omniVoiceService.js:600`) — emotionTag→`instruct` string append (coded, unreachable).
- **Windows** — flat; acceptable only as fallback.

**(2) Duck, don't mute (default).** Change the default so `getHighlightAudioMode` (`dubbingService.js:518`) returns `voiceover_with_ambient` for narrator-over beats, and route through the **existing** sidechain ducking `mixVideoWithNarrationTrack` (`ffmpegService.js:468`, `sidechaincompress=threshold=-30dB:ratio=10:attack=8:release=260`) instead of `replaceVideoAudio`. Keep hard-mute only when the classifier says the bed is `external_narrator/mixed` (unclean). This single change is the difference between "voice on top of a slideshow" and "narrator riding the real scene."

**(3) Handoffs, not hard cuts.** The dubbing path concatenates with plain `concat` (`ffmpegService.js:1040`); the crossfade-capable `concatSegmentsWithTransitions` (`:934`, `acrossfade`) is unused. For `setup_then_original` beats, crossfade narrator→source over ~120ms; for reveals, allow a deliberate 0.3–0.8s ambient breath before the moment (this is *intentional* silence, distinct from the accidental dead air from `pad_silence`/`tts_failed_silence` at `:4345,8137`).

**Coverage/voice-fit:** the v2 measured voice-fit with one retry (`autoStorySourceEngine.js:85-102`) is good — keep it. But make overflow trigger a **narration rewrite in the same pass** (shorten to `safeWords`) rather than the dubbing path's `needs_human_review` flag (`dubbingService.js:994`). Speaking-rate adaptation should be driven by `emotionTag`+`narrativeRole` (tense→ slightly faster on Edge/Kokoro, reveal→slower with a pre-pause), replacing the current `deliveryProfile`-only ±12% (`dubbingService.js:1214`).

**Prosody from script → TTS:** since only Edge exposes real SSML-ish control, standardize on **Edge Neural for narration** and express intent as `{rateDelta, pitchDelta, pauseBeforeSec, emphasisWordIndices}` in the schema (§10). For engines without prosody control, degrade gracefully (rate only). Do not block on engines that can't emphasize.

---

## 13. Review / Critic Loop

Keep what works, fix three things (RC-6):

**Works, keep:** the critic already watches the rendered draft as video (`autoStorySourceReview.js:27,33`; upload proven at `geminiService.js:496-501`) and returns a structured verdict+issues with timestamps and `suggestedFix` (`autoStorySourceContracts.js:22,24`) — not just a score. That is genuinely good; don't lose it.

**Fix 1 — whole-source awareness.** Give the critic read access to `story-model.json` so it can flag *missed* strong beats: "a higher-tension confrontation exists at t=612 that was not used." Today it's told it *cannot* compare to the whole source (`autoStoryEditorial.js:92`) because it only holds supplied clips. This is the single biggest critic upgrade.

**Fix 2 — bounded iteration, targeted patch.** Raise the "one automatic revision only" cap (`autoStoryEditorial.js:88`; `autoStorySourceReview.js:104-125`) to **≤2**, and make repair regenerate **only the affected beats** (the v2 region-repair already supports this via `autoStoryRepairRouter.route`, `autoStoryReviewRecovery.js`) so cost stays bounded. Stop when verdict=PASS or no issue's severity is `error`, whichever first.

**Fix 3 — real editorial gates before the model even sees it.** Run the deterministic gates (§8) and `renderQaService` technical checks first; only spend a pro critic call on drafts that already pass mechanics. Promote `renderQaService` editorial-ish signals (`weak_attention_hook`, `retention_drop_risk`, `:360`) from warnings to blocking where they're reliable. Replace the regex `attentionQa.hookScore` (`viralIntelligenceService.js:506-621`) with the critic's watched-draft hook verdict — the heuristic is misleading and shouldn't gate anything.

**Retention proxy:** you have no behavioral data, and the `viralScore` disclaimer is honest (`autoStorySourceGates.js:23`) — don't pretend otherwise. The best available proxy is the watched-draft critic verdict + the measured tension curve monotonicity (§9). Log `finalViralScores` (already in `autoStoryRunMetrics.js:42`) and, once you publish, feed back real retention/completion from TikTok analytics to calibrate the tension weights — that's the only path to a *measured* signal.

---

## 14. Cost & Latency Optimization

The expensive thing is multimodal tokens, and today the video is re-sent on nearly every stage (RC-1; cost audit Q7): edit and review attach the **identical** `packed.filePaths` on the **pro** tier (`autoStoryFastService.js:654,749`), overview proxy is re-sent for plan+supplement, and there is **no Vertex `cachedContent`** — GCS dedup (`vertexAiService.js:417-451`) saves *bytes* but every `fileUri` is re-billed as input tokens.

**The redesign is also the cost fix:**
1. **Analyze the source once (Pass 0), cache it two ways:** (a) persist `story-model.json` and have Passes 1/2/3/6 read *text* from it instead of re-watching clips; (b) create a Vertex **`cachedContent`** handle keyed on the existing media fingerprint (`buildMediaObjectName`, `vertexAiService.js:417`) so any pass that *does* need the media reuses one primed context instead of re-uploading. Add a thin `createCachedContent` wrapper — none exists today (grep confirms only `cachedContentTokenCount` credit at `:230`).
2. **Pass 1 (Story Design) is text-only** — the most reasoning-heavy step touches no video, so pro is cheap there.
3. **Pass 2 casting sends only the targeted beat clips**, not the whole candidate set, and reuses the cached context.
4. **Don't re-attach identical clips** across edit→review; the review only needs the *draft* + the cached context.
5. Keep the existing per-stage disk result cache (`autoStoryFastService.js:140`) and the 16-call/run + USD budget guards (`:180`, `vertexAiService.js:376`).

Net expected effect: one whole-source multimodal pass (flash, cached) + several cheap text/targeted-clip passes, versus today's ~6+ overlapping multimodal pro re-sends. Quality up (shared understanding), cost down (no re-billing), latency down (fewer big uploads).

---

## 15. Code-Level Changes (KEEP / MODIFY / REMOVE / ADD)

Mapped onto real files. Migration risk noted.

### KEEP (unchanged)
| Module | Why |
|---|---|
| `autoStorySourcePipeline.js` / `autoStorySourceEngine.js` skeleton | Correct multi-pass shape; extend, don't replace. |
| `autoStoryHookSelection.js` | Already auditions real hook clips with the audio classifier — this is the good hook path. |
| `autoStorySourceReview.js` (draft-watching) | Critic already watches the rendered draft; only extend inputs. |
| `subtitleService.js` + `tools/faster_whisper_transcribe.py` | Local ASR with word timestamps already produced (just consume them). |
| `ffmpegService.js` sidechain ducking (`:468,856`) & crossfade (`:934`) | Exist and work — just call them from the live path. |
| `voiceTimingPolicy.js`, measured voice-fit (`autoStorySourceEngine.js:85`) | Sound coverage logic. |
| Highlight renderer / `dubbingArtifactService.js` (9:16, captions) | Output format is fine; keep the segment contract compatible (§10 keeps legacy field names). |

### MODIFY
| File / function | Current | Desired | Risk |
|---|---|---|---|
| `autoStorySourceEngine.js` (Pass 0) | Understanding re-derived per stage from clips | Add one whole-source `buildSourceModel()` producing `story-model.json`; later stages read it | Med — new artifact; gate behind `schemaVersion:3` |
| `autoStorySourceContracts.js` schemas | No epistemic/audioEvents/openLoop/tension fields | Add fields from §7/§10; add narrator-function enum | Low |
| `autoStorySchemas.js:275` `finalEdlSchema` | Validates 6 of ~15 fields | Validate every field the prompt requests (§10) | Low but catches drift |
| `dubbingService.js:4429-4527` `synthesizeDubbingVoice` | Drops `emotionTag`/prosody | Forward emotionTag+prosody to each engine | Med — touches cache keys (`:1289`) |
| `dubbingService.js:514-529` `getHighlightAudioMode` + `:5226` render | Default source volume 0 → mute | Default duck via `mixVideoWithNarrationTrack`; mute only when classifier=unclean | Med — audio regressions possible; A/B a few outputs |
| `autoStorySourceGates.js` semantic gate | Trusts model `grounded`/`duplicateMeaning` | Add deterministic grounding + dialogue-redundancy + spoiler gates (port from legacy services) | Med |
| `autoStorySourceReview.js:104` loop | 1 revision | ≤2, targeted patch, story-model access | Low |
| `autoStoryPrompts.js` / `autoStoryEditorial.js` | Duplicated preamble; contradictory hook rules; overloaded editPrompt | One shared preamble; one hook rule; split editPrompt into P1/P2/P3 | Med — prompt regression testing needed |
| `vertexAiService.js` | No cachedContent | Add `createCachedContent()` + reuse by fingerprint | Med |

### REMOVE / RETIRE
| Target | Evidence | Action |
|---|---|---|
| `autoStoryPipelineService.js` real `run()`/`auditDrafts()` (dead) + `autoStoryHookLab.js` (metadata-only, only caller is the dead class) | `orchestration audit Q1/Q5`; `autoStoryPipelineService.js:476,793` | Delete after confirming only `Legacy.normalizeConfig` is used. |
| `viralIntelligenceService.js` keyword sub-scores & positional `purposeForSegment`; hard-coded `emotionCurve`/`buildTimeRanges` | `:192-227,423-437` | Retire from selection; if `pipelineService` stays for the hidden classic mode, isolate it there only. |
| `actionCandidateService` motion-only combine as a *selector* | `:101,212` | Downgrade to a cheap prior feeding `story-model.tension`, not a selector. |
| Legacy `mixed_ducking`→`voiceover_only` downgrade | `dubbingService.js:1546` | Remove once real ducking is the default. |

### ADD
| New module | Purpose |
|---|---|
| `tools/audio_events.py` (or ffmpeg RMS/loudness + optional YAMNet) | Non-speech audio-event track (RC-7) feeding `story-model.audioEvents` + tension. |
| `sourceStoryModelService.js` | Owns Pass 0 build + persistence + cache-key. |
| `beatCastingService.js` | Pass 2 constraint-satisfaction selection (§9). |
| `audioRoleStateMachine.js` | Deterministic audio_mode decision (§8). |
| `narrationGate.js` | Blocking deterministic gates: grounding FKs, dialogue-redundancy, spoiler/info-budget (reuses/extends `narrationGroundingService` + `voiceVisualAlignmentService`). |
| `vertexCachedContent` wrapper in `vertexAiService.js` | Context caching (§14). |

**Migration strategy:** gate everything behind `schemaVersion:3` / `autoStoryContractVersion:3`, so v2 keeps running while you build v3 on the same renderer (the segment contract in §10 preserves the legacy field names the Highlight renderer already consumes). Ship Pass 0 + the audio-role/ducking change first (biggest quality delta), then the gates, then cost caching.

---

## 16. Priority Roadmap (P0 → P3)

**P0 — Root cause, mandatory (do these first):**
1. **Source Story Model (Pass 0)** — one cached whole-source understanding with epistemic status + audio events + tension; every stage reads it. (RC-1, RC-7) → `sourceStoryModelService.js`, `tools/audio_events.py`, `autoStorySourceEngine.js`.
2. **Duck instead of mute + carry emotionTag to TTS.** (RC-3) → `dubbingService.js`, `ffmpegService.js`, engines.
3. **Wire deterministic narration/grounding/redundancy/spoiler gates into the live path as blocking.** (RC-2, RC-5) → `narrationGate.js`, `autoStorySourceGates.js`.

**P1 — Major quality:**
4. Audio-role state machine (narrator↔footage handoff, silence on high-impact beats). (§8)
5. Beat-first casting with purpose-dedup + measured tension-curve check. (RC-4, §9)
6. Open-loop / foreshadow / information-budget fields + reward (not punish) loops that close later. (RC-5, §7)
7. Critic gets story-model access + ≤2 bounded targeted revisions. (RC-6)
8. Vertex `cachedContent` + stop re-sending identical clips. (§14)

**P2 — Optimization:**
9. Unify engines; delete dead code (`autoStoryPipelineService.run`, `autoStoryHookLab`); one shared prompt preamble; validate all schema fields. (RC-8)
10. Crossfade handoffs; intentional pre-reveal breaths; kill accidental dead air. (§12)
11. Per-scene prosody/rate from emotionTag+role. (§12)

**P3 — Nice-to-have:**
12. Feed real TikTok retention/completion back to calibrate tension weights. (§13)
13. Consolidate `manualGemini*` and `autoStory` prompt libraries.
14. Purpose-level (semantic) dedup across escalation beats.

---

## 17. Top 3 Changes (highest impact, evidence-based)

If you change only three things:

**#1 — Build one cached, whole-source "Story Model" that every stage reads (Pass 0).**
*Evidence:* understanding is re-derived per stage from 6–10 coarse windows, the whole video is never holistically seen, non-speech audio and epistemic status don't exist, and media is re-billed every stage (`autoStorySourcePipeline.js:18,93`; `autoStorySourceEngine.js:43`; cost audit Q5/Q7; source audit Q6). *Why it wins:* it simultaneously fixes "missed strong moments," weak escalation, ungrounded/thin narration, AND cost — the one change that unblocks four root causes.

**#2 — Stop muting the footage: duck the original bodycam audio and carry emotion into TTS.**
*Evidence:* default `sourceVolume 0` → `replaceVideoAudio` drops source (`dubbingService.js:514,518`; `ffmpegService.js:486,511`) while real sidechain ducking sits unused in the same file (`:468`); `emotionTag` is dropped before every synth call (`grep`=0; `dubbingService.js:4429-4527`). *Why it wins:* it directly converts "voice sitting on top / emotionally flat" into "narrator riding a real, tense scene" — the fastest visible/audible quality jump, low architectural risk.

**#3 — Move editorial judgment from model self-assessment to deterministic blocking gates, and let the narrator open loops.**
*Evidence:* the grounding/provenance/redundancy services exist but are wired only into the legacy path and emit non-blocking warnings (`pipelineService.js:19,3370`; `narrationGroundingService.js:404`); the live engine trusts `assessment.grounded`/`duplicateMeaning` (`autoStorySourceGates.js:52`); no open-loop field and premature-reveal is penalized (`narrationGroundingService.js:343`; schema audit Q3). *Why it wins:* it makes "don't describe, don't repeat dialogue, don't spoil, do create curiosity" mechanically true instead of a hope, closing the gap between the (already good) narration prompt and the (currently unenforced) result.

---

### Appendix — key evidence index (file:line)
- Live entry & alias: `main.js:14,474,696,710,712`; fork `autoStoryFastService.js:560`.
- Dead code: `autoStoryPipelineService.js:476,793`; `autoStoryHookLab.js:14-26`.
- Source understanding: `scene_metadata.py:76-93,408-426`; `evidenceStoreService.js:276-286,306`; `characterTrackingService.js:76-77`; `autoStorySourceEngine.js:40-43,61`; `autoStorySourceContracts.js:19,28`; `faster_whisper_transcribe.py:150-164`.
- Selection/story: `actionCandidateService.js:101,212`; `viralIntelligenceService.js:254-265,423-437,506-621`; `storySpineCompilerService.js:381-491`; `autoStoryTimelineCompiler.js:73,89`.
- Schema/prompts: `autoStorySchemas.js:275`; `autoStoryPrompts.js:26,175,177`; `autoStoryEditorial.js:37-44,75-88,92`; `manualGeminiPackService.js:1291-1320,1758-1776`.
- Narration: `autoStorySourceEngine.js:104-138`; `narrationGroundingService.js:343,364,404`; `autoStoryAudioClassifier.js:3-11`; `autoStoryRhythm.js:19-24`.
- TTS/audio: `dubbingScriptService.js:73`; `dubbingService.js:514-529,1214-1256,4429-4527,5226`; `ffmpegService.js:468,486,511,856,934,1040`; `voiceTimingPolicy.js:3`.
- Critic/QA: `autoStorySourceReview.js:27-33,104-125`; `renderQaService.js:360,395`; `autoStorySourceContracts.js:22,24`.
- Cost: `vertexAiService.js:230,417-451,376-377`; `autoStoryCostPolicy.js:10-16`; `autoStoryFastService.js:140,180,654,749`; `autoStoryRunMetrics.js:35-42`.

