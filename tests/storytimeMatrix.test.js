const assert = require("assert");
const fs = require("fs/promises");
const path = require("path");
const StorytimeBlueprintService = require("../electron/services/storytime/storytimeBlueprintService");
const StorytimeScriptService = require("../electron/services/storytime/storytimeScriptService");
const StorytimeOverlayService = require("../electron/services/storytime/storytimeOverlayService");
const StorytimeAudioService = require("../electron/services/storytime/storytimeAudioService");
const SatisfyingStorytimePipeline = require("../electron/services/storytime/satisfyingStorytimePipeline");

async function runTests() {
  console.log("=== Running Satisfying Storytime Matrix & Blueprint Tests ===");

  // 0. Test Storytime Blueprint Service
  console.log("Test 0: Configurable Story Blueprint architecture...");
  const blueprintService = new StorytimeBlueprintService();
  const blueprints = blueprintService.listBlueprints();
  assert.ok(blueprints.length >= 5, "Should have at least 5 built-in blueprints");
  const artisanBp = blueprintService.getBlueprint("artisan_fair_price");
  assert.strictEqual(artisanBp.id, "artisan_fair_price");
  assert.strictEqual(artisanBp.visualSyncMode, "visual_grounded");
  assert.ok(Array.isArray(artisanBp.beats) && artisanBp.beats.length === 5, "Artisan blueprint must have 5 steps (Shocking Price Hook -> DIY Rivalry -> Technical Stakes -> Mastercraft Steps -> Polarizing Outro)");
  assert.strictEqual(artisanBp.beats[0].id, "step_1_shocking_price_hook");
  assert.strictEqual(artisanBp.beats[1].id, "step_2_diy_rivalry");
  assert.strictEqual(artisanBp.beats[2].id, "step_3_technical_stakes");
  assert.strictEqual(artisanBp.beats[3].id, "step_4_mastercraft_steps");
  assert.strictEqual(artisanBp.beats[4].id, "step_5_polarizing_outro");
  const compiledPrompt = blueprintService.compilePromptSection(artisanBp, 68.6, true);
  assert.ok(compiledPrompt.includes("VISUAL GROUNDING REQUIREMENT"), "Visual grounding directive missing");
  console.log("  ✓ StorytimeBlueprintService 5-step architecture verified.");

  // 1. Test Modular Story Matrix Configs + Module 1 (Duration Mode & Regional Idioms)
  console.log("Test 1: Modular Story Matrix personas, conflicts, duration modes & regional idioms...");
  assert.ok(StorytimeScriptService.PERSONAS.artisan_craftsman, "artisan_craftsman persona missing");
  assert.ok(StorytimeScriptService.PERSONAS.contractor, "contractor persona missing");
  assert.ok(StorytimeScriptService.PERSONAS.cinema_cleaner, "cinema cleaner persona missing");
  assert.ok(StorytimeScriptService.PERSONAS.deep_sea_diver, "deep sea diver persona missing");
  assert.ok(StorytimeScriptService.PERSONAS.excavator_operator, "excavator operator missing");

  assert.ok(StorytimeScriptService.CONFLICTS.craft_vs_diy, "craft_vs_diy conflict missing");
  assert.ok(StorytimeScriptService.CONFLICTS.contract_dispute, "contract dispute missing");
  assert.ok(StorytimeScriptService.CONFLICTS.disgusting_karen, "disgusting karen missing");
  assert.ok(StorytimeScriptService.CONFLICTS.unsettling_discovery, "unsettling discovery missing");

  assert.ok(StorytimeScriptService.LOCALE_FLAVORS.uk_craftsman, "uk_craftsman locale flavor missing");
  assert.ok(StorytimeScriptService.LOCALE_FLAVORS.uk_craftsman.directive.includes("daylight robbery"), "UK idioms missing");
  assert.ok(StorytimeScriptService.LOCALE_FLAVORS.uk_craftsman.directive.includes("graft"), "UK 'graft' idiom missing");
  assert.ok(StorytimeScriptService.DURATION_MODES.preserve_full, "preserve_full duration mode missing");
  assert.ok(StorytimeScriptService.DURATION_MODES.smart_trim, "smart_trim duration mode missing");

  assert.strictEqual(StorytimeScriptService.CONTROVERSY_LEVELS[1].level, 1);
  assert.strictEqual(StorytimeScriptService.CONTROVERSY_LEVELS[2].level, 2);
  assert.strictEqual(StorytimeScriptService.CONTROVERSY_LEVELS[3].level, 3);
  console.log("  ✓ Matrix configurations, duration modes, and regional idioms verified.");

  // 1b. Test Module 2: Dramatic Pause Injection (<break time="300ms"/> & —)
  console.log("Test 1b: Module 2 TTS Dramatic Pause Injection...");
  const rawPriceLine = "The homeowner asked why this job cost £1,200 when a builder quoted £150.";
  const elevenInjected = StorytimeAudioService.injectDramaticPauses(rawPriceLine, {
    provider: "elevenlabs",
    pauseMs: 300
  });
  assert.ok(elevenInjected.ttsInputText.includes('<break time="300ms"/>'), "ElevenLabs <break> tag should be injected before price figure");
  assert.ok(elevenInjected.cleanDisplayText.includes("— £1,200"), "Em-dash should be injected before price figure");
  const cleanCaption = StorytimeAudioService.stripTtsMarkup(elevenInjected.taggedText);
  assert.ok(!cleanCaption.includes("<break"), "stripTtsMarkup must remove XML break tags for subtitles");
  console.log("  ✓ TTS dramatic pause injection & markup stripping verified.");

  // 2. Test Storytime Overlay - Header Hook Card SVG Generation
  console.log("Test 2: Header Hook Card SVG generation...");
  const overlayService = new StorytimeOverlayService();
  const headerCard = {
    line1: "Two years of Gulf growth",
    line2: "one scraper",
    line3: "$12,000"
  };
  const svg = overlayService.generateHeaderCardSvg({
    headerCard,
    width: 1080,
    height: 1920,
    yOffset: 120
  });

  assert.ok(svg.includes("<svg"), "SVG tag missing");
  assert.ok(svg.includes("TWO YEARS OF GULF GROWTH"), "Line 1 text missing");
  assert.ok(svg.includes("ONE SCRAPER"), "Line 2 text missing");
  assert.ok(svg.includes("$12,000"), "Line 3 text missing");
  assert.ok(svg.includes("cardShadow"), "Shadow filter missing");
  assert.ok(svg.includes("rect"), "Card bounding box missing");
  const pillSvg = overlayService.generateNativePillSvg({
    stickerText: "Why does NOBODY do this ? 🙄",
    width: 1080,
    height: 1920
  });
  assert.ok(pillSvg.includes("Why does NOBODY do this ?"), "Native pill text missing");
  assert.ok(pillSvg.includes("pillShadow"), "Native pill shadow missing");
  console.log("  ✓ Header Card & Native Pill SVG generated correctly.");

  // 3. Test Storytime Overlay - Kinetic ASS Subtitles
  console.log("Test 3: Kinetic ASS Subtitle generation with word highlights...");
  const mockSegments = [
    {
      index: 1,
      text: "They offered me $3,000 to clean out 30 kilometers of ditches.",
      startSec: 0.0,
      endSec: 4.0,
      durationSec: 4.0,
      words: [
        { word: "They", start: 0.0, end: 0.3 },
        { word: "offered", start: 0.3, end: 0.7 },
        { word: "me", start: 0.7, end: 1.0 },
        { word: "$3,000", start: 1.0, end: 1.6 },
        { word: "to", start: 1.6, end: 1.8 },
        { word: "clean", start: 1.8, end: 2.2 },
        { word: "out", start: 2.2, end: 2.5 },
        { word: "30", start: 2.5, end: 2.9 },
        { word: "kilometers", start: 2.9, end: 3.5 },
        { word: "of", start: 3.5, end: 3.7 },
        { word: "ditches.", start: 3.7, end: 4.0 }
      ]
    },
    {
      index: 2,
      text: "I told them $5,000 minimum.",
      startSec: 4.0,
      endSec: 6.5,
      durationSec: 2.5,
      words: [
        { word: "I", start: 4.0, end: 4.3 },
        { word: "told", start: 4.3, end: 4.7 },
        { word: "them", start: 4.7, end: 5.0 },
        { word: "$5,000", start: 5.0, end: 5.8 },
        { word: "minimum.", start: 5.8, end: 6.5 }
      ]
    }
  ];

  // Test Cyan highlight (Avatar cleaner style)
  const cyanAss = overlayService.generateKineticAssSubtitles({
    segments: mockSegments,
    width: 1080,
    height: 1920,
    highlightColor: "cyan"
  });

  assert.ok(cyanAss.includes("[Script Info]"), "ASS header missing");
  assert.ok(cyanAss.includes("TikTokKaraoke"), "ASS style name missing");
  assert.ok(cyanAss.includes("\\c&H00FFFF00&"), "Cyan highlight tag missing in ASS");
  assert.ok(cyanAss.includes("Dialogue:"), "Dialogue events missing");

  // Test Yellow highlight (Contractor style) + Module 4 High-Impact Keyword & Stroke/Shadow
  const yellowAss = overlayService.generateKineticAssSubtitles({
    segments: mockSegments,
    width: 1080,
    height: 1920,
    highlightColor: "yellow",
    wordsPerGroup: 3
  });
  assert.ok(yellowAss.includes("\\c&H0000FFFF&"), "Yellow highlight tag missing in ASS");
  assert.ok(yellowAss.includes(",6.5,3.5,"), "ASS style must have thick black stroke (6.5) and deep shadow (3.5)");
  assert.ok(StorytimeOverlayService.isHighImpactKeyword("£1,200"), "Money figure must be highlighted");
  assert.ok(StorytimeOverlayService.isHighImpactKeyword("CHISEL"), "Tool keyword must be highlighted");
  assert.ok(StorytimeOverlayService.isHighImpactKeyword("COUNTERSINKING"), "Action verb keyword must be highlighted");
  assert.ok(StorytimeOverlayService.isHighImpactKeyword("BESPOKE"), "Regional craftsman slang must be highlighted");
  console.log("  ✓ Kinetic ASS Subtitles, thick stroke/shadow, and keyword highlights verified.");

  // 4. Test Storytime Audio Ducking & Timing
  console.log("Test 4: Storytime Audio mixing parameters...");
  const audioService = new StorytimeAudioService();
  assert.ok(audioService.ttsService, "TTS service not initialized");
  assert.strictEqual(typeof audioService.probeAudioDuration, "function");
  assert.strictEqual(typeof audioService.extractFoleyAudio, "function");
  assert.strictEqual(typeof audioService.mixMasterAudio, "function");
  console.log("  ✓ Audio service methods verified.");

  // 5. Test Master Pipeline Instantiation
  console.log("Test 5: Satisfying Storytime Pipeline instantiation...");
  const pipeline = new SatisfyingStorytimePipeline();
  assert.ok(pipeline.scriptService, "pipeline.scriptService missing");
  assert.ok(pipeline.audioService, "pipeline.audioService missing");
  assert.ok(pipeline.overlayService, "pipeline.overlayService missing");
  assert.ok(pipeline.hardwareService, "pipeline.hardwareService missing");
  assert.strictEqual(typeof pipeline.run, "function");
  console.log("  ✓ Pipeline orchestrator verified.");

  console.log("\n>>> ALL SATISFYING STORYTIME MATRIX TESTS PASSED! <<<");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
