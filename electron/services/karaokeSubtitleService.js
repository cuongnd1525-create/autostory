function secondsToAssTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const centis = Math.min(99, Math.round((safe - Math.floor(safe)) * 100));
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

function escapeAssText(text) {
  return String(text || "")
    .replace(/[{}]/g, "")
    .replace(/\r?\n/g, " ")
    .trim();
}

/**
 * Groups flat word timestamps into short phrases (2-4 words per group)
 * and generates ASS karaoke events where the currently spoken word is highlighted.
 */
function buildTikTokKaraokeAssEvents(words = [], options = {}) {
  const maxWordsPerGroup = Math.max(2, Math.min(6, Number(options.wordsPerGroup || 3)));
  const activeColor = options.activeColor || "&H00FFFF00&"; // Cyan in BGR ASS
  const inactiveColor = options.inactiveColor || "&H00FFFFFF&"; // White

  const cleanWords = (Array.isArray(words) ? words : [])
    .filter((w) => w && typeof w.word === "string" && String(w.word).trim())
    .map((w) => ({
      word: escapeAssText(w.word).toUpperCase(),
      start: Math.max(0, Number(w.start) || 0),
      end: Math.max(0.05, Number(w.end) || Number(w.start) + 0.3)
    }));

  if (cleanWords.length === 0) return [];

  // Group into short phrases
  const groups = [];
  let currentGroup = [];

  for (let i = 0; i < cleanWords.length; i += 1) {
    const word = cleanWords[i];
    const prevWord = currentGroup[currentGroup.length - 1];
    const gap = prevWord ? word.start - prevWord.end : 0;

    // Split if group full, or if natural pause > 0.6s
    if (currentGroup.length >= maxWordsPerGroup || (currentGroup.length > 0 && gap > 0.6)) {
      groups.push(currentGroup);
      currentGroup = [word];
    } else {
      currentGroup.push(word);
    }
  }
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  // Generate an event for each word within each group
  const events = [];
  for (const group of groups) {
    const groupStart = group[0].start;
    const groupEnd = group[group.length - 1].end;

    for (let wordIndex = 0; wordIndex < group.length; wordIndex += 1) {
      const activeWord = group[wordIndex];
      const startSec = activeWord.start;
      // Word display extends to next word start, or group end
      const nextWord = group[wordIndex + 1];
      const endSec = nextWord ? nextWord.start : activeWord.end;

      if (endSec <= startSec) continue;

      // Construct line text with the active word colored
      const lineParts = group.map((item, idx) => {
        if (idx === wordIndex) {
          return `{\\c${activeColor}}${item.word}{\\c${inactiveColor}}`;
        }
        return item.word;
      });

      const lineText = lineParts.join(" ");
      events.push({
        startSec,
        endSec,
        text: lineText
      });
    }
  }

  return events;
}

function buildTikTokKaraokeAssContent(wordsOrEvents = [], options = {}) {
  const width = Math.max(320, Number(options.width || 1080));
  const height = Math.max(320, Number(options.height || 1920));
  const fontSize = Math.max(24, Math.round((Number(options.fontSize || 54) * (width / 1080))));
  const outline = Math.max(1, Math.round((Number(options.outline || 3.5) * (width / 1080))));
  const shadow = Math.max(0, Math.round((Number(options.shadow || 1) * (width / 1080))));
  const marginV = Math.max(50, Math.round(Number(options.marginV || 620) * (height / 1920)));
  const fontName = options.fontName || "Arial Black";

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 1
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: TikTokKaraoke,${fontName},${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outline},${shadow},2,30,30,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  let events = [];
  if (wordsOrEvents.length > 0 && wordsOrEvents[0].words) {
    // If array of segments with words property, flatten
    const flatWords = wordsOrEvents.flatMap((s) => s.words || []);
    events = buildTikTokKaraokeAssEvents(flatWords, options);
  } else if (wordsOrEvents.length > 0 && typeof wordsOrEvents[0].word === "string") {
    // Flat words array
    events = buildTikTokKaraokeAssEvents(wordsOrEvents, options);
  } else {
    // Pre-built events
    events = wordsOrEvents;
  }

  const dialogueLines = events.map((e) => {
    return `Dialogue: 0,${secondsToAssTime(e.startSec)},${secondsToAssTime(e.endSec)},TikTokKaraoke,,0,0,0,,${e.text}`;
  });

  return header + dialogueLines.join("\n") + "\n";
}

/**
 * Resolves flat word timestamps from an array of timeline segments.
 * If segment has word timestamps, offsets them by output timeline.
 * Otherwise, interpolates words across the segment duration.
 */
function buildWordTimestampsFromSegments(segments = []) {
  const result = [];
  let timelineCursor = 0;

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const duration = Math.max(0.1, Number(seg.duration || seg.timelineSec || (seg.endSec - seg.startSec) || 0));
    const startSec = Number.isFinite(Number(seg.startSec)) ? Number(seg.startSec) : timelineCursor;
    const endSec = Number.isFinite(Number(seg.endSec)) ? Number(seg.endSec) : startSec + duration;
    timelineCursor = endSec;

    // Check if segment has detailed words
    if (Array.isArray(seg.words) && seg.words.length > 0) {
      for (const w of seg.words) {
        result.push({
          word: w.word,
          start: Math.max(startSec, Number(w.start) || startSec),
          end: Math.min(endSec, Number(w.end) || endSec)
        });
      }
      continue;
    }

    // Otherwise, check voiceover text or caption
    const text = String(seg.voiceover_text || seg.voiceoverText || seg.text || seg.caption || "").trim();
    if (!text) continue;

    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;

    const wordDuration = Math.max(0.08, (endSec - startSec) / tokens.length);
    for (let t = 0; t < tokens.length; t += 1) {
      const wStart = startSec + t * wordDuration;
      const wEnd = Math.min(endSec, wStart + wordDuration);
      result.push({
        word: tokens[t],
        start: Number(wStart.toFixed(3)),
        end: Number(wEnd.toFixed(3))
      });
    }
  }

  return result;
}

module.exports = {
  secondsToAssTime,
  buildTikTokKaraokeAssEvents,
  buildTikTokKaraokeAssContent,
  buildWordTimestampsFromSegments
};
