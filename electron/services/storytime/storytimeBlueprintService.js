const BUILTIN_BLUEPRINTS = {
  artisan_fair_price: {
    id: "artisan_fair_price",
    name: "Tranh cãi Giá Thợ Lành Nghề vs. Thợ Mạng DIY (5-Step Artisan Fair-Price)",
    badge: "Viral UK/US Craft",
    version: "2.0",
    visualSyncMode: "visual_grounded",
    description: "Cấu trúc 5 bước chuẩn: Shocking Price Hook -> DIY Rivalry -> Technical Stakes -> Mastercraft Steps -> Polarizing Outro. Giữ nguyên nhịp độ & thành ngữ thợ bản xứ.",
    hookFormula:
      "Open in the first 3 seconds with a shocking price-to-size contrast and a direct question (e.g., '£1,200 for a 50-centimeter piece of rotted wood — is that absolute daylight robbery, or the fair price for proper British craftsmanship?'). Zero greetings, zero filler.",
    beats: [
      {
        id: "step_1_shocking_price_hook",
        label: "Bước 1 (0–12%): Shocking Price Hook (Cú sốc giá tiền & kích thước)",
        durationRatio: 0.12,
        directive:
          "Drop the exact invoice price against the seemingly small physical repair area right in sentence one, pausing with an em-dash (—) before asking if it's 'daylight robbery' or fair value for proper master craftsmanship."
      },
      {
        id: "step_2_diy_rivalry",
        label: "Bước 2 (12–26%): DIY Rivalry (Cà khịa thợ mạng 10 phút)",
        durationRatio: 0.14,
        directive:
          "Call out armchair DIY commenters who claim they'd get this 'sorted' in 10 minutes with a cheap tub of filler and a slap of paint, and explain why that bodged shortcut fails out in the real world."
      },
      {
        id: "step_3_technical_stakes",
        label: "Bước 3 (26–46%): Technical Stakes (Chẩn đoán rủi ro & Phá dỡ phẫu thuật)",
        durationRatio: 0.20,
        directive:
          "Anchor directly to the opening demolition/chiseling visuals on screen: diagnose the deep wet rot or damp in the period house structure and explain why surgical removal down to sound timber is critical without weakening the original frame."
      },
      {
        id: "step_4_mastercraft_steps",
        label: "Bước 4 (46–84%): Mastercraft Steps (Chuỗi kỹ thuật bậc thầy bám sát hình)",
        durationRatio: 0.38,
        directive:
          "Walk through every visible mastercraft step in chronological order: measuring to the millimeter, cutting a bespoke replacement block, brushing two coats of preservative primer, fitting with high-strength adhesive, pre-drilling and countersinking screws below the surface, applying two-part resin filler, sanding dead flush, and weatherproof painting."
      },
      {
        id: "step_5_polarizing_outro",
        label: "Bước 5 (84–100%): Polarizing Outro (Kết quả tàng hình & Câu hỏi chia phe)",
        durationRatio: 0.16,
        directive:
          "Match the final seamless reveal on screen: emphasize that the repair is 100% invisible so nobody ever knows you were there. Restate the time spent (e.g., half a day's graft) and the exact invoice price, then ask a polarizing question that forces viewers to comment whether it's a rip-off or worth every penny."
      }
    ],
    endingFormula:
      "Conclude right on the finished reveal shot: state the total time and exact invoice price, then ask viewers directly: 'Be honest — for half a day's proper graft on a period house, is — [PRICE] a rip-off or worth every single penny?'",
    styleNotes:
      "Confident, seasoned craftsman voice. Do NOT summarize or condense: maintain full word volume across all 5 steps. Use authentic regional slang (UK: graft, bespoke, period house, sorted, daylight robbery, dead flush, sound timber). Use em-dashes (—) or semicolons (;) before price reveals and punchlines for natural breathing pauses. Highlight money figures, tool names, and action verbs in emphasisWords.",
    defaultRenderProfile: {
      headerStyle: "native_pill",
      wordsPerGroup: 2,
      selectiveHighlight: true,
      highlightColor: "yellow",
      enableFoley: false,
      maskSourceSubtitles: false
    }
  },

  botched_diy_rescue: {
    id: "botched_diy_rescue",
    name: "Giải cứu Thảm họa Sửa Ẩu / Thợ Rẻ Tiền (Botched DIY Rescue)",
    badge: "Reddit Contractor Karma",
    version: "1.0",
    visualSyncMode: "visual_grounded",
    description: "Khách hàng thuê thợ giá rẻ hoặc tự làm hỏng nặng rồi mới gọi thợ xịn đến cứu -> Bóc trần sai lầm dưới lớp vỏ ngoài -> Phục chế chuẩn chỉnh từng bước -> Báo giá gấp đôi và bài học đắt giá.",
    hookFormula:
      "Open immediately with the cost of a cheap shortcut: 'The homeowner hired a $150 handyman to fix this first — and that cheap shortcut just cost them $1,400 to undo.'",
    beats: [
      {
        id: "beat_1_botched_backstory",
        label: "Nhịp 1 (0–18%): Cái giá của thợ rẻ tiền",
        durationRatio: 0.18,
        directive:
          "State what the previous cheap worker or DIY attempt did wrong and how they tried to hide the damage instead of fixing the root cause."
      },
      {
        id: "beat_2_exposing_the_rot",
        label: "Nhịp 2 (18–45%): Bóc lớp ngụy trang & Phơi bày hư hỏng thật",
        durationRatio: 0.27,
        directive:
          "Sync with the stripping/cutting/cleaning visuals on screen: describe peeling back the cosmetic cover-up and exposing the trapped moisture, rot, or structural mess underneath."
      },
      {
        id: "beat_3_proper_rebuild",
        label: "Nhịp 3 (45–83%): Quy trình phục chế chuẩn kỹ thuật",
        durationRatio: 0.38,
        directive:
          "Follow the visible tools and materials step by step as the repair is rebuilt properly from the core out—fitting, sealing, fastening, filling, and finishing."
      },
      {
        id: "beat_4_karma_verdict",
        label: "Nhịp 4 (83–100%): Màn lột xác & Tranh luận tiền công",
        durationRatio: 0.17,
        directive:
          "Show the flawless finished result, state the final bill, and ask the audience if charging extra to fix someone else's botched work is fair or harsh."
      }
    ],
    endingFormula:
      "End on the pristine final shot with a debate trigger: 'I charged [PRICE] to fix what a $150 shortcut ruined — am I wrong for charging extra to clean up someone else's mess?'",
    styleNotes:
      "Sharp, no-nonsense restoration specialist tone. Combine Reddit r/Contractor storytelling with real visual actions on screen.",
    defaultRenderProfile: {
      headerStyle: "native_pill",
      wordsPerGroup: 2,
      selectiveHighlight: true,
      highlightColor: "yellow",
      enableFoley: false
    }
  },

  micro_detail_mystery: {
    id: "micro_detail_mystery",
    name: "Bí ẩn Kỹ thuật 3 Giây ('Why Nobody Does This')",
    badge: "Retention Curiosity",
    version: "1.0",
    visualSyncMode: "visual_grounded",
    description: "Mở đầu bằng một chi tiết ngược đời trên hình ('Tại sao 99% thợ bỏ qua bước này?') -> Giải thích cơ chế vật lý/hóa học đằng sau từng thao tác -> Chốt hạ bằng độ bền 50 năm.",
    hookFormula:
      "Open with a counter-intuitive technical hook tied to the visual: 'Why do 99% of builders skip this one step — when it's the only thing keeping this from rotting in two winters?'",
    beats: [
      {
        id: "beat_1_curiosity_gap",
        label: "Nhịp 1 (0–15%): Câu hỏi kỹ thuật gây tò mò",
        durationRatio: 0.15,
        directive:
          "Point out a specific detail or problem visible in the opening seconds and state why most people get it completely wrong."
      },
      {
        id: "beat_2_hidden_science",
        label: "Nhịp 2 (15–50%): Giải mã nguyên nhân & Chuẩn bị phôi",
        durationRatio: 0.35,
        directive:
          "Explain the hidden physics of moisture, expansion, or wear while narrating the exact cutting, chiseling, or prep work shown on screen."
      },
      {
        id: "beat_3_precision_execution",
        label: "Nhịp 3 (50–85%): Tuyệt chiêu xử lý bề mặt & Liên kết",
        durationRatio: 0.35,
        directive:
          "Detail the exact sequence of priming, fastening, two-part resin/filling, and sanding visible in the video, emphasizing precision tolerances."
      },
      {
        id: "beat_4_seamless_reveal",
        label: "Nhịp 4 (85–100%): Bề mặt liền khối & Thử thách người xem",
        durationRatio: 0.15,
        directive:
          "Reveal the seamless final coat, challenge viewers to spot the seam, and ask tradespeople in the comments how they would have tackled it."
      }
    ],
    endingFormula:
      "Challenge the viewer on the final frame: 'Look closely at the finished surface — can you even spot where the splice begins, or would you have replaced the whole unit?'",
    styleNotes:
      "Authoritative, hyper-observant insider tone. Fast, rhythmic pacing designed for maximum watch-time retention.",
    defaultRenderProfile: {
      headerStyle: "native_pill",
      wordsPerGroup: 2,
      selectiveHighlight: true,
      highlightColor: "cyan",
      enableFoley: false
    }
  },

  reddit_aita_confession: {
    id: "reddit_aita_confession",
    name: "Tâm sự & Tranh chấp Khách hàng (Classic US Reddit AITA Storytime)",
    badge: "Classic Storytime",
    version: "1.0",
    visualSyncMode: "free_flow",
    description: "Khuôn kinh điển US TikTok: Mở bằng con số hợp đồng lớn -> Kể câu chuyện kịch tính với khách hàng oái oăm trên nền video thỏa mãn -> Cao trào đối chất -> Câu hỏi phán xét đạo đức.",
    hookFormula:
      "Open immediately with a high-stakes contract figure or outrageous client demand in sentence one (e.g., 'They offered me $3,000 to clear 30 kilometers of ditches... I told them $5,000 minimum.').",
    beats: [
      {
        id: "beat_1_contract_hook",
        label: "Nhịp 1 (0–15%): Báo giá & Điều kiện khắc nghiệt",
        durationRatio: 0.15,
        directive:
          "State the exact dollar figure, the brutal scope of the job, and why nobody else wanted to touch it."
      },
      {
        id: "beat_2_visceral_obstacle",
        label: "Nhịp 2 (15–50%): Thực tế khắc nghiệt & Sự cố phát sinh",
        durationRatio: 0.35,
        directive:
          "Describe the grueling physical reality and the unexpected complication that emerged halfway through the job."
      },
      {
        id: "beat_3_client_confrontation",
        label: "Nhịp 3 (50–82%): Cao trào đối chất khách hàng",
        durationRatio: 0.32,
        directive:
          "The client tries to renegotiate, refuses to pay for the extra hazard, or makes an entitled demand; narrator stands firm."
      },
      {
        id: "beat_4_aita_verdict",
        label: "Nhịp 4 (82–100%): Chốt hạ & Hỏi ý kiến cộng đồng",
        durationRatio: 0.18,
        directive:
          "Deliver the final resolution and ask viewers in the comments who was in the right."
      }
    ],
    endingFormula:
      "End with a polarizing moral question: 'They paid the bill but threatened to blacklist us — would you have stood your ground or walked away?'",
    styleNotes:
      "First-person American blue-collar storyteller. Punchy, high-drama narrative flow.",
    defaultRenderProfile: {
      headerStyle: "white_box",
      wordsPerGroup: 3,
      selectiveHighlight: false,
      highlightColor: "cyan",
      enableFoley: true
    }
  },

  custom_blueprint: {
    id: "custom_blueprint",
    name: "Khuôn Tự Định Nghĩa (Custom Story Blueprint)",
    badge: "Tùy biến 100%",
    version: "1.0",
    visualSyncMode: "visual_grounded",
    description: "Tự thiết lập công thức Hook, các nhịp dẫn chuyện, công thức câu kết và chỉ dẫn phong cách cho LLM để thích ứng tức thì khi xu hướng TikTok thay đổi.",
    hookFormula:
      "Open in the first 3 seconds with a high-curiosity statement, shocking price/number, or visual paradox that stops the scroll immediately.",
    beats: [
      {
        id: "beat_1_setup",
        label: "Nhịp 1 (0–20%): Mở bài & Đặt vấn đề",
        durationRatio: 0.2,
        directive: "Introduce the core conflict, price, or mystery and contrast it with common misconceptions."
      },
      {
        id: "beat_2_process",
        label: "Nhịp 2 (20–75%): Diễn biến & Giải quyết theo hình ảnh",
        durationRatio: 0.55,
        directive: "Narrate the progression of actions visible on screen while escalating the stakes or technical insight."
      },
      {
        id: "beat_3_payoff",
        label: "Nhịp 3 (75–100%): Kết quả & Kích hoạt bình luận",
        durationRatio: 0.25,
        directive: "Deliver the satisfying payoff on the final visual reveal and ask a polarizing question for the comments."
      }
    ],
    endingFormula:
      "Finish on the final visual transformation and ask a direct two-sided question that compels viewers to take sides in the comments.",
    styleNotes:
      "Keep sentences concise (10-18 words), natural spoken rhythm, zero AI clichés ('In today's video', 'Let's dive in').",
    defaultRenderProfile: {
      headerStyle: "native_pill",
      wordsPerGroup: 2,
      selectiveHighlight: true,
      highlightColor: "yellow",
      enableFoley: false
    }
  }
};

class StorytimeBlueprintService {
  constructor(settings = {}) {
    this.settings = settings;
  }

  static get BUILTIN_BLUEPRINTS() {
    return BUILTIN_BLUEPRINTS;
  }

  listBlueprints(settings = this.settings) {
    const customList = Array.isArray(settings?.storytimeCustomBlueprints)
      ? settings.storytimeCustomBlueprints
      : [];
    const merged = { ...BUILTIN_BLUEPRINTS };
    for (const item of customList) {
      if (item && item.id) {
        merged[item.id] = {
          ...BUILTIN_BLUEPRINTS.custom_blueprint,
          ...item
        };
      }
    }
    return Object.values(merged);
  }

  getBlueprint(blueprintId = "artisan_fair_price", customBlueprint = null, settings = this.settings) {
    const all = this.listBlueprints(settings);
    const found = all.find((b) => b.id === blueprintId) || BUILTIN_BLUEPRINTS.artisan_fair_price;

    if (!customBlueprint || typeof customBlueprint !== "object") {
      return { ...found };
    }

    const customBeats = Array.isArray(customBlueprint.beats) && customBlueprint.beats.length > 0
      ? customBlueprint.beats
      : (typeof customBlueprint.beatsText === "string" && customBlueprint.beatsText.trim()
        ? this._parseBeatsText(customBlueprint.beatsText)
        : found.beats);

    return {
      ...found,
      ...customBlueprint,
      hookFormula: String(customBlueprint.hookFormula || found.hookFormula).trim(),
      endingFormula: String(customBlueprint.endingFormula || found.endingFormula).trim(),
      styleNotes: String(customBlueprint.styleNotes || found.styleNotes).trim(),
      visualSyncMode: customBlueprint.visualSyncMode || found.visualSyncMode || "visual_grounded",
      beats: customBeats,
      defaultRenderProfile: {
        ...(found.defaultRenderProfile || {}),
        ...(customBlueprint.defaultRenderProfile || {})
      }
    };
  }

  _parseBeatsText(beatsText = "") {
    const lines = String(beatsText || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return BUILTIN_BLUEPRINTS.custom_blueprint.beats;
    const ratio = Number((1 / lines.length).toFixed(2));
    return lines.map((line, idx) => ({
      id: `custom_beat_${idx + 1}`,
      label: `Nhịp ${idx + 1}`,
      durationRatio: ratio,
      directive: line.replace(/^[-*\d.)+\s]+/, "").trim() || line
    }));
  }

  compilePromptSection(blueprint, targetDurationSec = 68, hasVideo = false) {
    const resolved = blueprint || BUILTIN_BLUEPRINTS.artisan_fair_price;
    const beats = Array.isArray(resolved.beats) && resolved.beats.length
      ? resolved.beats
      : BUILTIN_BLUEPRINTS.artisan_fair_price.beats;

    let cursorSec = 0;
    const beatLines = beats.map((beat, idx) => {
      const ratio = Number(beat.durationRatio) || (1 / beats.length);
      const startSec = Math.round(cursorSec);
      const endSec = idx === beats.length - 1
        ? Math.round(targetDurationSec)
        : Math.min(Math.round(targetDurationSec), Math.round(cursorSec + targetDurationSec * ratio));
      cursorSec = endSec;
      return `${idx + 1}. ${beat.label || `Beat ${idx + 1}`} (~Seconds ${startSec}s - ${endSec}s):\n   - ${beat.directive}`;
    });

    const visualSyncDirective = hasVideo && resolved.visualSyncMode === "visual_grounded"
      ? [
        "VISUAL GROUNDING REQUIREMENT (CRITICAL - DO NOT HALLUCINATE UNRELATED ACTIONS):",
        "- You have been provided the actual video file. Watch the chronological progression of tools, hands, materials, and surface states from 0s to the end.",
        "- Each segment's `text` MUST align with what is visually happening on screen during that segment's [startSec -> endSec] window.",
        "- When the worker is chiseling/demolishing, talk about the hook/problem and removing the damaged material.",
        "- When the worker is measuring, cutting, priming, drilling, filling, sanding, or painting, weave those exact visible actions naturally into the narrative argument.",
        "- When the final finished surface is revealed near the end of the video, deliver the payoff and comment-bait question."
      ].join("\n")
      : [
        "NARRATIVE PACING REQUIREMENT:",
        "- Maintain relentless momentum across every segment with zero dead air or filler."
      ].join("\n");

    return [
      `ACTIVE STORY BLUEPRINT: "${resolved.name}" (${resolved.id})`,
      `BLUEPRINT DESCRIPTION: ${resolved.description || ""}`,
      "",
      "OPENING HOOK FORMULA (First 0 - 4 Seconds):",
      `- ${resolved.hookFormula}`,
      "",
      "STRUCTURAL NARRATIVE BEATS (Follow this exact progression):",
      ...beatLines,
      "",
      "CLOSING PAYOFF & COMMENT-BAIT FORMULA:",
      `- ${resolved.endingFormula}`,
      "",
      "STYLE & VOICE DIRECTIVES:",
      `- ${resolved.styleNotes}`,
      "",
      visualSyncDirective
    ].join("\n");
  }

  /**
   * Reverse-engineers a reusable Story Blueprint from any reference viral video using Gemini/Vertex.
   */
  async extractBlueprintFromVideo({ videoPath, scriptService, signal, onProgress }) {
    if (!videoPath) {
      throw new Error("Hãy chọn video mẫu để AI phân tích khuôn câu chuyện.");
    }
    if (!scriptService || typeof scriptService.runAiCall !== "function") {
      throw new Error("Thiếu StorytimeScriptService để gọi AI.");
    }

    onProgress?.({ percent: 15, message: "AI đang xem video mẫu và giải phẫu cấu trúc kể chuyện (Story Blueprint)..." });

    const prompt = [
      "Watch this viral short-form video carefully (both its spoken narrative/audio and its visual progression).",
      "Reverse-engineer its storytelling formula into a reusable 'Story Blueprint' so a creator can generate brand-new scripts using the exact same psychological retention structure.",
      "Abstract away the specific nouns of this single video into generalizable rules (with 1 concrete example in parentheses).",
      "",
      "Return JSON strictly matching the schema:",
      "- name: Catchy Vietnamese + English name for this storytelling blueprint",
      "- badge: Short 2-3 word tag",
      "- description: 1-2 sentence Vietnamese summary of why this formula hooks viewers",
      "- visualSyncMode: 'visual_grounded' if the narration references on-screen actions, or 'free_flow' if it tells an independent story over B-roll",
      "- hookFormula: Detailed rule for the first 3-4 seconds",
      "- beats: Array of 3 to 5 structural beats with { id, label, durationRatio, directive }",
      "- endingFormula: Rule for the final payoff and comment-section debate trigger",
      "- styleNotes: Tone, sentence pacing, and keyword emphasis rules",
      "- sampleHeaderSticker: Short 4-7 word top sticker hook with 1 emoji inspired by the video"
    ].join("\n");

    const schema = {
      type: "object",
      required: ["name", "description", "visualSyncMode", "hookFormula", "beats", "endingFormula", "styleNotes"],
      properties: {
        name: { type: "string" },
        badge: { type: "string" },
        description: { type: "string" },
        visualSyncMode: { type: "string", enum: ["visual_grounded", "free_flow"] },
        hookFormula: { type: "string" },
        beats: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "label", "durationRatio", "directive"],
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              durationRatio: { type: "number" },
              directive: { type: "string" }
            }
          }
        },
        endingFormula: { type: "string" },
        styleNotes: { type: "string" },
        sampleHeaderSticker: { type: "string" }
      }
    };

    const extracted = await scriptService.runAiCall({
      prompt,
      filePaths: [videoPath],
      responseSchema: schema,
      temperature: 0.25,
      signal,
      onProgress
    });

    const id = `learned_${Date.now().toString(36)}`;
    return {
      id,
      name: String(extracted.name || "Khuôn học từ video mẫu").trim(),
      badge: String(extracted.badge || "Learned Blueprint").trim(),
      version: "1.0",
      visualSyncMode: extracted.visualSyncMode === "free_flow" ? "free_flow" : "visual_grounded",
      description: String(extracted.description || "").trim(),
      hookFormula: String(extracted.hookFormula || "").trim(),
      beats: Array.isArray(extracted.beats) && extracted.beats.length ? extracted.beats : BUILTIN_BLUEPRINTS.artisan_fair_price.beats,
      endingFormula: String(extracted.endingFormula || "").trim(),
      styleNotes: String(extracted.styleNotes || "").trim(),
      sampleHeaderSticker: String(extracted.sampleHeaderSticker || "Why does NOBODY do this ? 🙄").trim(),
      defaultRenderProfile: {
        headerStyle: "native_pill",
        wordsPerGroup: 2,
        selectiveHighlight: true,
        highlightColor: "yellow",
        enableFoley: false
      }
    };
  }
}

module.exports = StorytimeBlueprintService;
