# Worker task: three-video editorial reverse-engineering (development benchmark only)

Role: editorial-analysis WORKER. Do NOT edit production code. The lead architect reviews your output.

Substitution note: Antigravity CLI was not reachable from this session (no shell on the
user's computer), so this worker runs in the cloud workspace with ffmpeg + pre-computed
audio-fingerprint alignment + frame contact sheets. The task definition is unchanged.

## Inputs (cloud workspace)
- Source proxy (full 1726s, 720x406, burned "scene | SOURCE hh:mm:ss" band on top):
  /mnt/user-data/uploads/Video/source-y6a531kefhm-gemini-analysis-pack/temp/analysis-proxy-full.mp4
- Source transcript (ASR, [sourceSec] text): /home/claude/bench/source_transcript_clean.txt
- Viral human-edited reference (117.6s, 9:16): /mnt/user-data/uploads/Video/template_viral_tiktok.mp4
- Current AutoStory output (67.27s): /mnt/user-data/uploads/v4-production-live-e2e/.variant-workers/1/v4-production-live-e2e/output/*.mp4
- Current AutoStory EDL: /mnt/user-data/uploads/v4-production-live-e2e/analysis/auto-story-fast/story-spine.json
- Audio-fingerprint segments (HIGH confidence output->source mapping where original audio is audible):
  /home/claude/bench/viral_align_segments.json, /home/claude/bench/old_align_segments.json
- Visual nearest-frame hints (LOW confidence): /home/claude/bench/viral_vmatch.json
- Contact sheets 1 fps (timestamp top-left): /home/claude/bench/sheets/viral_*.jpg, old_*.jpg
- Caption-band strips 2 fps (label = output time x10): /home/claude/bench/sheets/viralcap_*.jpg

Where audio does not match (viral narration regions), establish source time VISUALLY: extract
frames from the viral at the time in question and from the source proxy at candidate times
(ffmpeg -ss T -i FILE -frames:v 1 ...), compare, and read the burned SOURCE band. Mark those
beats sourceConfidence "visual" vs "audio".

## Required output: JSON only, saved to
/home/claude/repo/analysis/editorial-benchmark/01-three-video-analysis.json

Beat arrays for viral and AutoStory, each beat:
outputStartSec, outputEndSec, sourceStartSec, sourceEndSec, sourceConfidence, audioMode
(original_dialogue | narration_over_source | mixed), primarySubject, location, physicalAction,
keyDialogue (short paraphrase, <=15 words verbatim), narrationText (if narration captions),
narrativeFunction, viewerStateBefore, viewerStateAfter, centralConflictContribution,
causalLinkToPrevious, causalLinkToNext, scopeMembership (in_scope | supporting | out_of_scope),
removalImpact.

Also: viralStoryScope, autoStoryStoryScope, viralCentralViewerQuestion,
autoStoryCentralViewerQuestion, viralScopeBoundary (source-time + narrative), autoStoryScopeBoundary,
sourceEventsAfterViralBoundary (what interesting source events exist later that the human excluded,
with source times), answers {whyExcludedLaterEvents, whyOneStory, whereIsBoundary,
activeViewerQuestion, whatChangesBeatToBeat, lossIfSecondaryBeatRemoved, coldOpenStructure,
rewindBehavior, endingFunction, narrationRole, dialogueRole},
genericEditorialPrinciples [{principle, evidenceFromViral, failureInAutoStory, generalization}].

Do NOT judge captions style, font, framing, blur, music, FPS, color.
Do NOT recommend benchmark-specific rules (names, locations, timestamps).
Be evidence-based; cite output and source times.
