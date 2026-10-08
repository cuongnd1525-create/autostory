# Bodycam Antigravity: V1/V2 quality-regression test

Target **only**: **Viết kịch bản rồi review video thật** -> **TikTok Viral Bodycam (Part 1 - 8 nhịp xen kẽ)** -> **Antigravity**. This is NOT Vertex AutoStory V4.

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

## Artifacts
- `gemini-draft-review.json`: revised script and per-window `bodycamQualityAudit`
- `bodycam-quality-gate.json`: local structural/media-coverage verdict; accepts a **candidate script**, not a final published video
- `bodycam-rejected-review-*.json`: rejected AI output preserved for diagnostics
- `analysis/bodycam-v2-import-rejected.json`: attempt to bypass the gate by direct manual import
- Existing `review-context.json`, `draft-timeline.json` and `script-v1.json` map V1 output to source

**Limitations:** full Windows/Electron/Antigravity/FFmpeg/TTS end-to-end tests must be performed locally; JS syntax checks and unit tests do not establish video quality or viral/CRP eligibility.
