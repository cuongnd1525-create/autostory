# Bodycam Antigravity: V1/V2 quality-regression test

Target **only**: **Viết kịch bản rồi review video thật** -> **TikTok Viral Bodycam (Part 1 - 8 nhịp xen kẽ)** -> **Antigravity**. This is NOT Vertex AutoStory V4.

## V1-first quality pipeline (new)

**Do not** import previous score-13 V1 JSON. This branch has a new V1 editorial compiler/quality policy; generate new scripts even when Phase A understanding is cached.

- Stage1 Phase A: reuse the verified 7/7 source proxy understanding.
- Stage1 Series Plan: keep the verified same-incident 3-Part chronology.
- Stage1 Phase B: generate **all three 8-beat scripts** with source-event IDs, a first-3-second hook, verified payoff/grounded next-Part question and strong last beat.
- **V1_EDITORIAL_GATE**: check source ranges, 110-125s of meaningful footage, eight alternating raw/narrator runs, natural TTS density, Hook 0-3s, evidence IDs, headline/Hook relationship, visual obstructions, Part ending, plus the same viral preflight scorer used at import (minimum 65).
- If V1 fails, run one **fresh Phase B full-script rebuild** from the verified source understanding + locked series plan; keep separate logs and retry once. Source video is not rewatched.
- If the rebuild still fails, stop **before** importing/rendering poor footage. Inspect \`bodycam-v1-quality-initial.json\`, \`bodycam-v1-quality.json\` and \`antigravity-output-phaseB-v1-rebuild.log\`.
- The V1 JSON import path repeats checks. Old JSON without locked \`source-understanding.json\`/\`series-plan.json\` or low preflight score is rejected.
- Bodycam V1 rendered preview now uses **English SRT/captions** rather than Vietnamese auto-translation; other modes are unchanged.

What passing means: the generated script and its declared evidence meet the host's structural and preflight requirements **before rendering**. It still does not guarantee genuine cold-viewer retention, realistic TTS intonation, correct face tracking or TikTok distribution. Inspect V1 directly before posting.

## Before testing
Use a clean checkout of branch `feat/antigravity-bodycam-review-quality`:
```powershell
git fetch origin
git switch -c feat/antigravity-bodycam-review-quality --track origin/feat/antigravity-bodycam-review-quality
npm ci
npm run check
npm run test:bodycam
npm start
```
If branch exists locally, use `git switch feat/antigravity-bodycam-review-quality` and `git pull --ff-only` instead.

1. Configure provider **Antigravity** in Settings and check FFmpeg/FFprobe/TTS.
2. Create a **NEW** manual Gemini Draft Review project using the **original bodycam source** that produced Variant01/02; do NOT upload one of the rendered drafts as the original source.
3. Select **TikTok Viral Bodycam (Part 1 - 8 nhịp xen kẽ)**, generate Stage1 package, run **Antigravity GĐ1**, import resulting script JSONs (1/3/4).
4. Render one V1 draft. In the relevant variant run **AI review Draft V1** with Antigravity.
5. Check `02-DRAFT-REVIEW/<variant>-v1-.../02-CONFIGURED-AI-RESULT/bodycam-quality-gate.json` and, on rejection, `bodycam-rejected-review-*.json`. One bounded automatic retry is allowed. Do not treat a quality-gate failure as an accepted review.
6. If V2 passes the candidate-script gate, **Apply V2** and **Render Draft** again. Compare real V1/V2 video. You can explicitly run Draft Review again on V2 for an independent second inspection. **Passing the V1->V2 script gate does not imply the new rendered V2 audio/framing automatically passes.**

## Failure targets (same source as previous two variants)
- Variant01: high-stakes hospital teaser must have a supported later resolution/continuation or a specific authentic Part2 open loop; no unrelated random 911/crash progression.
- Variant01: actual top headline must be meaningful for THAT Part's Hook, not copied from another variant.
- Variant02: ~38-68s static patrol-car shot should be shortened/replaced unless the review cites an indispensable new event.
- Variant02: ~88.9-94.95s low audio must be accounted for by FFmpeg signal QA and the reviewer; quiet dramatic moments may legitimately remain with evidence.
- Variant02: blocked/obscured ending must be flagged, and a better grounded final source range selected.
- Listen to narrator as heard: prompt/QA now flags robotic voice but does not change TTS model/voice engine automatically.
- Inspect 9:16 face/framing and captions by watching rendered MP4; quality flags detect issues, but there is not yet an automatic crop engine or TikTok caption restyler.

## Troubleshooting: `SERIES_PLAN_REPAIR` timeout

If Stage 1 reports `series-plan không phải object` followed by `[agy] print timeout after 6m0s`, it failed **before** script generation, not during rendering/review. The old retry kept the same AGY conversation and sometimes started browsing `renderer.js` / `manualAntigravityStage1Service.js` via `manage_task`.

Branch fix:
- Recovers JSON envelopes from AGY stream-json `result.response` or fragmented `text_delta`.
- Uses text-only listed evidence files from an isolated `phase-b-input` work directory, with no app code or script schema inspection.
- A malformed first plan gets exactly one **fresh** generation (not a resumed conversation), bounded to 180s and with CLI `--print-timeout` enforced.
- Preserves `antigravity-output-seriesPlan-initial.log` and `antigravity-output-seriesPlan-fresh-retry.log`.
- A validated `series-plan.json` is cached only for the same source understanding, Hook, transcript, manifest and three-Part configuration.

After pulling, rerun Stage 1 using the **same analysis pack**; the validated Source Understanding cache is preserved. If it still fails, send the new `antigravity-output-seriesPlan-initial.log`, `antigravity-output-seriesPlan-fresh-retry.log`, and the final status. Do not delete the Phase A / video caches as a first response.

Run `node tests/antigravitySeriesPlanRecovery.test.js` to check stream JSON extraction, a clean retry, restricted input-tool access and cache invalidation.

## Artifacts
- `gemini-draft-review.json`: revised script and per-window `bodycamQualityAudit`
- `bodycam-quality-gate.json`: local structural/media-coverage verdict; accepts a **candidate script**, not a final published video
- `bodycam-rejected-review-*.json`: rejected AI output preserved for diagnostics
- `analysis/bodycam-v2-import-rejected.json`: attempt to bypass the gate by direct manual import
- Existing `review-context.json`, `draft-timeline.json` and `script-v1.json` map V1 output to source

**Limitations:** full Windows/Electron/Antigravity/FFmpeg/TTS end-to-end tests must be performed locally; JS syntax checks and unit tests do not establish video quality or viral/CRP eligibility.
