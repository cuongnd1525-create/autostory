const path = require("path");
const VertexAiService = require("../vertexAiService");
const GeminiService = require("../geminiService");

const PERSONAS = {
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
    name: "Fascinating Story",
    promptDirective: "Focus on the impressive skill, extreme physical reality, and high-dollar payoff. Keep the tone engaging and satisfying."
  },
  2: {
    level: 2,
    name: "Fair Price Debate (Comment Magnet)",
    promptDirective: "Frame the narrative around the financial debate. State exact dollar figures ($3,000 vs $5,000, $12,000). Ask the viewer if the price was fair or highway robbery to provoke comment debates."
  },
  3: {
    level: 3,
    name: "Extreme Moral Conflict / AITA (Viral Outrage)",
    promptDirective: "Create an intense 'Am I The A**hole?' dilemma where the narrator stands their ground against an abusive client or walks away, dividing the audience into opposing moral camps in the comments."
  }
};

class StorytimeScriptService {
  constructor(settings = {}) {
    this.settings = settings;
    this.vertex = new VertexAiService(settings);
    this.gemini = new GeminiService(settings);
  }

  async runAiCall({ prompt, filePaths = [], responseSchema = null, temperature = 0.35, signal, onProgress }) {
    const provider = this.settings.aiProvider || "vertex_ai";

    if (provider === "gemini") {
      onProgress?.({ message: "Generating story via Gemini Developer API..." });
      return this.gemini.generateJson({
        prompt,
        responseSchema,
        temperature,
        signal
      });
    }

    // Default: Vertex AI
    onProgress?.({ message: "Generating story via Vertex AI..." });
    return this.vertex.generateJsonFromFiles({
      filePaths,
      prompt,
      temperature,
      taskType: "story_synthesis",
      responseSchema,
      strictRootJson: true,
      modelOverride: this.settings.vertexQualityModel || "gemini-2.5-flash",
      signal,
      onProgress
    });
  }

  /**
   * Generates a viral Storytime script using the Modular Story Matrix.
   */
  async generateStory({
    videoPath = null,
    targetDurationSec = 70,
    persona = "contractor",
    customPersonaText = "",
    conflict = "contract_dispute",
    customConflictText = "",
    controversyLevel = 2,
    customIdea = "",
    sourceText = "",
    signal,
    onProgress
  }) {
    const selectedPersona = PERSONAS[persona]?.description || customPersonaText || PERSONAS.contractor.description;
    const selectedConflict = CONFLICTS[conflict]?.description || customConflictText || CONFLICTS.contract_dispute.description;
    const selectedControversy = CONTROVERSY_LEVELS[Number(controversyLevel)] || CONTROVERSY_LEVELS[2];

    const wordsPerSecond = 2.7; // ~162 WPM spoken rate
    const targetWordCount = Math.round(targetDurationSec * wordsPerSecond * 0.92);
    const maxWordCount = Math.round(targetDurationSec * wordsPerSecond * 1.05);

    const prompt = [
      "You are the master scriptwriter for viral US TikTok 'Oddly Satisfying Storytime' and 'Blue-Collar Contractor Confessions' videos.",
      `Target Video Duration: ~${targetDurationSec} seconds.`,
      `Target Word Count: ${targetWordCount} words (strict upper limit: ${maxWordCount} words).`,
      "",
      "STORYTELLING MATRIX CONFIGURATION:",
      `- Narrator Persona: ${selectedPersona}`,
      `- Conflict / Drama Focus: ${selectedConflict}`,
      `- Controversy & Comment Directive: ${selectedControversy.promptDirective}`,
      customIdea ? `- Custom Premise / Concept: "${customIdea}"` : "",
      sourceText ? `- Source Reference Story / Notes: "${sourceText}"` : "",
      "",
      "VIRAL TIKTOK US STRUCTURAL FORMULA (CRITICAL):",
      "1. 3-SECOND FINANCIAL / EXTREME HOOK (Sentence 1):",
      "   - Open IMMEDIATELY with a specific dollar figure, contract payout, or shocking workplace extreme.",
      "   - Examples: 'They offered me $3,000 to clean 30 kilometers of ditches... I told them $5,000 minimum.' / 'A shipping company out of Houston gave me a 12 grand contract to scrape two years of growth off a cargo hull.' / 'I'm a cinema cleaner, and the worst film to ever clear after: Avatar.'",
      "   - ZERO fluff, no greetings ('Hi guys'), no pleasantries.",
      "",
      "2. THE VISCERAL REALITY & ESCALATING OBSTACLE (Seconds 5 - 35):",
      "   - Describe the grueling, disgusting, or daunting physical reality matching the satisfying work on screen.",
      "   - Explain why normal people couldn't do this job and what unexpected complication emerged.",
      "",
      "3. THE MID-POINT CLIMAX / CONFRONTATION (Seconds 35 - 50):",
      "   - The client intervenes, the machine jams, or a shocking discovery is made.",
      "   - Uncompromising contractor attitude: professional, firm, refuses to get cheated.",
      "",
      "4. THE VIRAL ENGAGEMENT PAYOFF / CONTROVERSY TRIGGER (Last 10 - 15 seconds):",
      "   - The job is finished with high satisfaction, but leave an open question or controversial resolution.",
      "   - Examples: 'They paid the 12 grand, but threatened to blacklist us. Would you have finished that job?' / 'He called me a thief for charging $5k, but tell me in the comments: is 30 kilometers of backed up silt worth less than that?'",
      "",
      "5. HEADER HOOK CARD (3 PUNCHY LINES):",
      "   - Generate exactly 3 short, punchy lines for the top white sticker box.",
      "   - Example: Line 1: 'Two years of Gulf growth', Line 2: 'one scraper', Line 3: '$12,000'",
      "",
      "Return JSON adhering strictly to this schema:",
      "{",
      '  "title": "Short Catchy Title",',
      '  "headerCard": {',
      '    "line1": "Catchy Context (e.g. Two years of Gulf growth)",',
      '    "line2": "The Tool/Condition (e.g. One scraper / 30km ditch)",',
      '    "line3": "The Payout/Stakes (e.g. $12,000 / $5,000 / Worst shift)"',
      '  },',
      '  "hook": "Opening hook sentence",',
      '  "storyText": "Full cohesive script text as one continuous spoken narrative",',
      '  "totalWords": 180,',
      '  "estimatedDurationSec": 68.5,',
      '  "segments": [',
      '    {',
      '      "index": 1,',
      '      "text": "They offered me $3,000 to clean out 30 kilometers of roadside drainage ditches.",',
      '      "durationSec": 4.5,',
      '      "emphasisWords": ["$3,000", "30 KILOMETERS"]',
      '    }',
      '  ]',
      "}"
    ].filter(Boolean).join("\n");

    const schema = {
      type: "object",
      required: ["title", "headerCard", "hook", "storyText", "segments"],
      properties: {
        title: { type: "string" },
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
      const dur = Math.max(1.5, Number(seg.durationSec || 3.0));
      const startSec = Number(rollingSec.toFixed(2));
      const endSec = Number((rollingSec + dur).toFixed(2));
      rollingSec += dur;
      return {
        index: idx + 1,
        text: String(seg.text || "").trim(),
        startSec,
        endSec,
        durationSec: dur,
        emphasisWords: Array.isArray(seg.emphasisWords) ? seg.emphasisWords : []
      };
    });

    let finalSegments = timedSegments;
    if (rollingSec > targetDurationSec && targetDurationSec > 10) {
      const scaleFactor = (targetDurationSec - 0.5) / rollingSec;
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
    } else {
      finalSegments = timedSegments.map((seg) => ({
        ...seg,
        sourceStartSec: seg.startSec,
        sourceEndSec: seg.endSec
      }));
    }

    return {
      title: String(raw.title || "Satisfying Storytime").trim(),
      headerCard: {
        line1: String(raw.headerCard?.line1 || "Contract Job").trim(),
        line2: String(raw.headerCard?.line2 || "Satisfying Work").trim(),
        line3: String(raw.headerCard?.line3 || "$5,000").trim()
      },
      hook: String(raw.hook || "").trim(),
      storyText: String(raw.storyText || "").trim(),
      totalWords: String(raw.storyText || "").split(/\s+/).filter(Boolean).length,
      estimatedDurationSec: Number(rollingSec.toFixed(2)),
      segments: finalSegments
    };
  }
}

StorytimeScriptService.PERSONAS = PERSONAS;
StorytimeScriptService.CONFLICTS = CONFLICTS;
StorytimeScriptService.CONTROVERSY_LEVELS = CONTROVERSY_LEVELS;

module.exports = StorytimeScriptService;
