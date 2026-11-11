const VertexAiService = require("../vertexAiService");
const GeminiService = require("../geminiService");
const StorytimeBlueprintService = require("./storytimeBlueprintService");

const PERSONAS = {
  artisan_craftsman: {
    id: "artisan_craftsman",
    name: "Master Restoration Craftsman / Joiner",
    description: "Seasoned master joiner and restoration specialist who takes immense pride in invisible, long-lasting architectural repairs and calls out corner-cutting."
  },
  contractor: {
    id: "contractor",
    name: "Veteran Contractor",
    description: "Experienced, pragmatic blue-collar contractor who knows his worth and doesn't take nonsense from clients."
  },
  cinema_cleaner: {
    id: "cinema_cleaner",
    name: "Cinema / Venue Cleaner",
    description: "Cynical, observant worker exposing the shocking and disgusting state humans leave public venues in."
  },
  deep_sea_diver: {
    id: "deep_sea_diver",
    name: "Commercial Hull Diver",
    description: "High-risk commercial diver scraping barnacles, untangling ship propellers, and inspecting dark hulls."
  },
  excavator_operator: {
    id: "excavator_operator",
    name: "Heavy Equipment Operator",
    description: "Skilled machinery operator carving through clogged canals, ditches, and massive earthwork."
  },
  pressure_washer: {
    id: "pressure_washer",
    name: "Pressure Washing Pro",
    description: "Perfectionist restoration technician turning unbelievable grime, grease, and filth into spotless perfection."
  },
  carpet_restorer: {
    id: "carpet_restorer",
    name: "Deep Cleaning Specialist",
    description: "Specialist dealing with biohazards, hoarder houses, and neglected filth with sharp commentary."
  }
};

const CONFLICTS = {
  craft_vs_diy: {
    id: "craft_vs_diy",
    name: "Artisan Craft vs. 10-Minute DIY Shortcut",
    description: "Contrasting proper surgical restoration and its high invoice price against armchair DIY commenters who claim they'd slap filler and paint on it in 10 minutes."
  },
  botched_job_rescue: {
    id: "botched_job_rescue",
    name: "Rescuing a Botched Cheap Repair",
    description: "Fixing a disaster left behind by a cheap handyman or DIY shortcut that trapped moisture/damage underneath."
  },
  contract_dispute: {
    id: "contract_dispute",
    name: "Contract & Money Dispute",
    description: "Client tries to lowball, renegotiate mid-job, or claim the price is unfair after agreed terms."
  },
  disgusting_karen: {
    id: "disgusting_karen",
    name: "Entitled Customer / Karen",
    description: "Demanding customer leaves an outrageous disaster or behaves with extreme entitlement."
  },
  unsettling_discovery: {
    id: "unsettling_discovery",
    name: "Bizarre / Unsettling Discovery",
    description: "Uncovering a strange, valuable, or eerie object buried beneath layers of mud, filth, or rust."
  },
  impossible_deadline: {
    id: "impossible_deadline",
    name: "High-Stakes Emergency",
    description: "Extreme time pressure where failure means tens of thousands of dollars in damages or severe penalties."
  }
};

const CONTROVERSY_LEVELS = {
  1: {
    level: 1,
    name: "Fascinating Craft & Precision",
    promptDirective: "Focus on the impressive technical skill, hidden physics of the repair, and satisfying invisible finish."
  },
  2: {
    level: 2,
    name: "Fair Price Debate (Comment Magnet)",
    promptDirective: "Frame the narrative around the financial and craftsmanship debate. State exact currency figures (e.g. $1,200 / £1,200, $3,000 vs $5,000). Ask the viewer directly at the end if the price was daylight robbery or worth every penny for master quality."
  },
  3: {
    level: 3,
    name: "Extreme Moral Conflict / AITA (Viral Outrage)",
    promptDirective: "Create an intense dilemma where the narrator stands their ground against corner-cutting or an unfair client, dividing the audience into opposing camps in the comments."
  }
};

const LOCALE_FLAVORS = {
  uk_craftsman: {
    id: "uk_craftsman",
    name: "Anh Quốc / UK Master Craftsman",
    directive:
      "MANDATORY REGIONAL IDIOMS & SLANG (BRITISH / UK CRAFTSMAN):\n" +
      "- You MUST preserve and naturally weave authentic British tradesman idioms and slang into the script.\n" +
      "- Required vocabulary pool (use at least 4–6 naturally across the script): 'graft', 'bespoke', 'period house', 'sorted', 'daylight robbery', 'sound timber', 'dead flush', 'proper job', 'bodged', 'worth every penny'.\n" +
      "- Use British currency (£ / pounds) and metric measurements (centimeters / millimeters) where appropriate."
  },
  us_tradesman: {
    id: "us_tradesman",
    name: "Mỹ / US Blue-Collar Pro",
    directive:
      "MANDATORY REGIONAL IDIOMS & SLANG (AMERICAN / US TRADESMAN):\n" +
      "- You MUST preserve and naturally weave authentic American blue-collar idioms and slang into the script.\n" +
      "- Required vocabulary pool (use at least 4–6 naturally across the script): 'highway robbery', 'armchair quarterback', 'hack job', 'dead flush', 'structural integrity', 'up to code', 'dime a dozen', 'worth every penny'."
  },
  auto_preserve: {
    id: "auto_preserve",
    name: "Tự động giữ thành ngữ & từ lóng theo bối cảnh nguồn",
    directive:
      "MANDATORY REGIONAL IDIOMS & SLANG (CONTEXTUAL PRESERVATION):\n" +
      "- Detect the regional context of the video/source notes and strictly preserve its local trade idioms and slang.\n" +
      "- If UK/British context: use 'graft', 'bespoke', 'period house', 'sorted', 'daylight robbery', 'dead flush'.\n" +
      "- If US/American context: use 'highway robbery', 'hack job', 'up to code', 'dead flush', 'worth every penny'."
  }
};

const DURATION_MODES = {
  preserve_full: {
    id: "preserve_full",
    name: "Giữ nguyên 100% thời lượng video gốc (Cấm tóm tắt - Paraphrase/Spin)"
  },
  smart_trim: {
    id: "smart_trim",
    name: "Cho phép LLM tự cắt gọn cảnh thừa thãi (Smart Scene Trim)"
  }
};

class StorytimeScriptService {
  constructor(settings = {}) {
    this.settings = settings;
    this.vertex = new VertexAiService(settings);
    this.gemini = new GeminiService(settings);
    this.blueprintService = new StorytimeBlueprintService(settings);
  }

  async runAiCall({ prompt, filePaths = [], responseSchema = null, temperature = 0.35, signal, onProgress }) {
    const provider = this.settings.aiProvider || "vertex_ai";

    if (provider === "gemini" && this.settings.geminiApiKey) {
      onProgress?.({ message: "Generating story via Gemini Developer API..." });
      return this.gemini.generateJson({
        prompt,
        responseSchema,
        temperature,
        signal
      });
    }

    onProgress?.({ message: "Generating story via Vertex AI..." });
    const activeModel = this.settings.vertexQualityModel || "gemini-2.5-flash";
    return this.vertex.generateJsonFromFiles({
      filePaths,
      prompt,
      temperature,
      taskType: "story_synthesis",
      responseSchema: null,
      maxOutputTokens: 16384,
      thinkingBudget: /flash/i.test(activeModel) ? 0 : 512,
      strictRootJson: false,
      modelOverride: activeModel,
      signal,
      onProgress
    });
  }

  /**
   * Generates a viral Storytime script using the Configurable Story Blueprint & Modular Story Matrix.
   */
  async generateStory({
    videoPath = null,
    targetDurationSec = 70,
    durationMode = "preserve_full", // 'preserve_full' | 'smart_trim'
    localeFlavor = "uk_craftsman",  // 'uk_craftsman' | 'us_tradesman' | 'auto_preserve'
    blueprintId = "artisan_fair_price",
    customBlueprint = null,
    persona = "contractor",
    customPersonaText = "",
    conflict = "contract_dispute",
    customConflictText = "",
    controversyLevel = 2,
    customIdea = "",
    sourceText = "",
    headerStickerText = "",
    signal,
    onProgress
  }) {
    const activeBlueprint = this.blueprintService.getBlueprint(blueprintId, customBlueprint, this.settings);
    const selectedPersona = PERSONAS[persona]?.description || customPersonaText || PERSONAS.contractor.description;
    const selectedConflict = CONFLICTS[conflict]?.description || customConflictText || CONFLICTS.contract_dispute.description;
    const selectedControversy = CONTROVERSY_LEVELS[Number(controversyLevel)] || CONTROVERSY_LEVELS[2];
    const selectedLocale = LOCALE_FLAVORS[localeFlavor] || LOCALE_FLAVORS.uk_craftsman;
    const isSmartTrim = durationMode === "smart_trim";

    const effectiveTargetSec = isSmartTrim
      ? Math.max(25, Number((targetDurationSec * 0.82).toFixed(1)))
      : Number(targetDurationSec);

    const wordsPerSecond = 2.65; // ~159 WPM crisp craftsman delivery to maintain full word density
    const targetWordCount = Math.round(effectiveTargetSec * wordsPerSecond * 0.96);
    const maxWordCount = Math.round(effectiveTargetSec * wordsPerSecond * 1.05);
    const targetSegmentCount = Math.max(10, Math.min(20, Math.round(effectiveTargetSec / 4.5)));

    const blueprintSection = this.blueprintService.compilePromptSection(
      activeBlueprint,
      effectiveTargetSec,
      Boolean(videoPath)
    );

    const durationRuleSection = isSmartTrim
      ? [
        "DURATION & SMART SCENE TRIMMING RULE (SMART TRIM MODE):",
        `- Source Video Total Duration: ${Number(targetDurationSec).toFixed(1)}s. Target Trimmed Duration: ~${effectiveTargetSec.toFixed(1)}s.`,
        "- You are allowed to cut out redundant, repetitive, or dead-air moments from the source video while keeping 100% of the visual progression and viral hook power.",
        `- For EVERY segment, output exact \`sourceStartSec\` and \`sourceEndSec\` within [0.0, ${Number(targetDurationSec).toFixed(1)}] in strictly increasing chronological order so the video editor can cut out filler gaps between segments.`,
        "- Keep all 5 structural beats intact (Shocking Price Hook -> DIY Rivalry -> Technical Stakes -> Mastercraft Steps -> Polarizing Outro)."
      ].join("\n")
      : [
        "CRITICAL DURATION & REWRITE RULE (PRESERVE FULL DURATION - DO NOT SUMMARIZE):",
        "- Do NOT summarize or condense the script! You are strictly forbidden from shortening the narrative into a brief summary.",
        `- Instead, PARAPHRASE / SPIN the full story while preserving the FULL word volume (~${targetWordCount} to ${maxWordCount} words) required to cover the entire ${Number(targetDurationSec).toFixed(1)}s video from start to finish.`,
        "- Follow the complete 5-step progression without skipping any step: Step 1: Shocking Price Hook -> Step 2: DIY Rivalry -> Step 3: Technical Stakes -> Step 4: Mastercraft Steps -> Step 5: Polarizing Outro.",
        `- Map the segments continuously from 0.0s to ${Number(targetDurationSec).toFixed(1)}s.`
      ].join("\n");

    const prompt = [
      "You are the master scriptwriter for viral TikTok/Reels 'Satisfying Craft & Storytime' videos.",
      `Source Video Duration: ${Number(targetDurationSec).toFixed(1)} seconds.`,
      `Target Word Count: ~${targetWordCount} words (range: ${Math.round(targetWordCount * 0.92)} to ${maxWordCount} words across ~${targetSegmentCount} segments).`,
      "",
      durationRuleSection,
      "",
      selectedLocale.directive,
      "",
      "STORYTELLING MATRIX CONFIGURATION:",
      `- Narrator Persona: ${selectedPersona}`,
      `- Conflict / Drama Focus: ${selectedConflict}`,
      `- Controversy & Comment Directive: ${selectedControversy.promptDirective}`,
      customIdea ? `- Custom Premise / Concept: "${customIdea}"` : "",
      sourceText ? `- Source Reference Story / Notes: "${sourceText}"` : "",
      "",
      blueprintSection,
      "",
      "DRAMATIC PAUSES & CADENCE RULES (FOR NATURAL TTS BREATHING):",
      "- Insert an em-dash (` — `) or semicolon (`; `) right before shocking price figures, measurements, and key punchlines so the TTS engine takes a natural 300ms breath before delivering the hook word.",
      "  - Example: '1,200 pounds for a 50-centimeter piece of wood — is that absolute daylight robbery?'",
      "  - Example: 'It took half a day's graft to save this window; and I invoiced — 1,200 pounds.'",
      "",
      "TOP OVERLAY STICKER & HEADER CARD REQUIREMENTS:",
      "1. `headerSticker`: A single short, ultra-curious 4-7 word TikTok native pill hook with 1 expressive emoji at the end.",
      "   - Examples: 'Why does NOBODY do this ? 🙄', '£1,200 for ONE piece of wood?! 😳', 'The $150 handyman ruined this 🤦‍♂️'",
      "   - Must provoke instant curiosity without giving away the ending.",
      "2. `headerCard`: 3 short lines for classic 3-line sticker mode (Line 1: Context, Line 2: Tool/Scope, Line 3: Price/Stakes).",
      "",
      "SEGMENTATION & KEYWORD HIGHLIGHT RULES (CRITICAL):",
      `- Break the narrative into ${targetSegmentCount - 2} to ${targetSegmentCount + 2} chronological segments whose durations sum to ~${effectiveTargetSec.toFixed(1)}s.`,
      "- Each segment should be 1-2 crisp spoken sentences (10 to 17 words).",
      "- In each segment, populate `emphasisWords` with 2 to 4 high-impact keywords from that segment focusing on: (1) MONEY / MEASUREMENTS (e.g. '1,200 POUNDS', '50-CENTIMETER'), (2) TOOL / MATERIAL NAMES (e.g. 'OSCILLATING TOOL', 'RESIN FILLER', 'PRIMER'), and (3) ACTION VERBS / SLANG (e.g. 'CHISELING', 'COUNTERSINKING', 'BESPOKE', 'GRAFT', 'ROBBERY').",
      "",
      "Return JSON adhering strictly to this schema:",
      "{",
      '  "title": "Short Catchy Title",',
      '  "headerSticker": "Why does NOBODY do this ? 🙄",',
      '  "headerCard": {',
      '    "line1": "100-year-old rotted sill",',
      '    "line2": "Surgical splice repair",',
      '    "line3": "£1,200"',
      "  },",
      '  "hook": "Opening hook sentence",',
      '  "storyText": "Full cohesive script text as one continuous spoken narrative",',
      `  "totalWords": ${targetWordCount},`,
      `  "estimatedDurationSec": ${effectiveTargetSec.toFixed(1)},`,
      '  "segments": [',
      "    {",
      '      "index": 1,',
      '      "text": "1,200 pounds for a 50-centimeter piece of wood — is that absolute daylight robbery, or proper British craftsmanship?",',
      '      "durationSec": 5.2,',
      ...(isSmartTrim ? ['      "sourceStartSec": 0.0,', '      "sourceEndSec": 5.2,'] : []),
      '      "emphasisWords": ["1,200 POUNDS", "50-CENTIMETER", "DAYLIGHT ROBBERY", "CRAFTSMANSHIP"]',
      "    }",
      "  ]",
      "}"
    ].filter(Boolean).join("\n");

    const schema = {
      type: "object",
      required: ["title", "headerSticker", "headerCard", "hook", "storyText", "segments"],
      properties: {
        title: { type: "string" },
        headerSticker: { type: "string" },
        headerCard: {
          type: "object",
          required: ["line1", "line2", "line3"],
          properties: {
            line1: { type: "string" },
            line2: { type: "string" },
            line3: { type: "string" }
          }
        },
        hook: { type: "string" },
        storyText: { type: "string" },
        totalWords: { type: "number" },
        estimatedDurationSec: { type: "number" },
        segments: {
          type: "array",
          items: {
            type: "object",
            required: ["index", "text", "durationSec"],
            properties: {
              index: { type: "number" },
              text: { type: "string" },
              durationSec: { type: "number" },
              sourceStartSec: { type: "number" },
              sourceEndSec: { type: "number" },
              emphasisWords: { type: "array", items: { type: "string" } }
            }
          }
        }
      }
    };

    const filePaths = videoPath ? [videoPath] : [];
    const raw = await this.runAiCall({
      prompt,
      filePaths,
      responseSchema: schema,
      signal,
      onProgress
    });

    const segments = Array.isArray(raw.segments) ? raw.segments : [];
    let rollingSec = 0;
    const timedSegments = segments.map((seg, idx) => {
      const dur = Math.max(1.5, Number(seg.durationSec || 3.5));
      const startSec = Number(rollingSec.toFixed(2));
      const endSec = Number((rollingSec + dur).toFixed(2));
      rollingSec += dur;
      const srcStart = Number.isFinite(Number(seg.sourceStartSec)) ? Number(seg.sourceStartSec) : startSec;
      const srcEnd = Number.isFinite(Number(seg.sourceEndSec)) && Number(seg.sourceEndSec) > srcStart
        ? Number(seg.sourceEndSec)
        : Number((srcStart + dur).toFixed(2));
      return {
        index: idx + 1,
        text: String(seg.text || "").trim(),
        startSec,
        endSec,
        sourceStartSec: Number(srcStart.toFixed(2)),
        sourceEndSec: Number(Math.min(targetDurationSec || 9999, srcEnd).toFixed(2)),
        durationSec: dur,
        emphasisWords: Array.isArray(seg.emphasisWords) ? seg.emphasisWords : []
      };
    });

    let finalSegments = timedSegments;
    if (!isSmartTrim && rollingSec > 0 && targetDurationSec > 10 && Math.abs(rollingSec - targetDurationSec) > 1.0) {
      const scaleFactor = (targetDurationSec - 0.3) / rollingSec;
      let scaledCursor = 0;
      finalSegments = timedSegments.map((seg) => {
        const dur = Math.max(1.0, Number((seg.durationSec * scaleFactor).toFixed(2)));
        const startSec = Number(scaledCursor.toFixed(2));
        const endSec = Number((scaledCursor + dur).toFixed(2));
        scaledCursor += dur;
        return {
          ...seg,
          startSec,
          endSec,
          sourceStartSec: startSec,
          sourceEndSec: endSec,
          durationSec: dur
        };
      });
      rollingSec = scaledCursor;
    }

    const fullStoryText = finalSegments.map((s) => s.text).join(" ") || String(raw.storyText || "").trim();
    const resolvedSticker = String(
      headerStickerText || raw.headerSticker || raw.headerCard?.line1 || "Why does NOBODY do this ? 🙄"
    ).trim();

    return {
      title: String(raw.title || "Satisfying Storytime").trim(),
      blueprintId: activeBlueprint.id,
      blueprintName: activeBlueprint.name,
      durationMode,
      localeFlavor,
      headerSticker: resolvedSticker,
      headerCard: {
        line1: String(raw.headerCard?.line1 || resolvedSticker || "Contract Job").trim(),
        line2: String(raw.headerCard?.line2 || "Master Restoration").trim(),
        line3: String(raw.headerCard?.line3 || "$1,200").trim()
      },
      hook: String(raw.hook || finalSegments[0]?.text || "").trim(),
      storyText: fullStoryText,
      totalWords: fullStoryText.split(/\s+/).filter(Boolean).length,
      estimatedDurationSec: Number(rollingSec.toFixed(2)),
      segments: finalSegments
    };
  }
}

StorytimeScriptService.PERSONAS = PERSONAS;
StorytimeScriptService.CONFLICTS = CONFLICTS;
StorytimeScriptService.CONTROVERSY_LEVELS = CONTROVERSY_LEVELS;
StorytimeScriptService.LOCALE_FLAVORS = LOCALE_FLAVORS;
StorytimeScriptService.DURATION_MODES = DURATION_MODES;
StorytimeScriptService.BLUEPRINTS = StorytimeBlueprintService.BUILTIN_BLUEPRINTS;

module.exports = StorytimeScriptService;
