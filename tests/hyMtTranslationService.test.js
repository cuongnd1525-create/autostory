const assert = require("assert");
const HyMtTranslationService = require("../electron/services/hyMtTranslationService");

(async () => {
  const service = new HyMtTranslationService({ hyMt2BatchSize: 2 });
  assert.strictEqual(service.model, "hf.co/unsloth/Hy-MT2-7B-GGUF:UD-Q4_K_XL");
  assert.deepStrictEqual(
    HyMtTranslationService.extractJson('```json\n{"translations":[]}\n```'),
    { translations: [] }
  );

  service.request = async (prompt) => {
    const input = JSON.parse(prompt.match(/Input JSON: (\[[\s\S]*\])$/)[1]);
    return {
      translations: input.map((item) => ({ id: item.id, text: `VI: ${item.text}` }))
    };
  };
  const translated = await service.translateToVietnamese({
    sourceLanguage: "en",
    segments: [
      { id: "a", text: "He opened the door." },
      { id: "b", text: "The officer stepped inside." },
      { id: "c", text: "They found the evidence." }
    ]
  });
  assert.deepStrictEqual(translated.map((item) => item.previewSubtitleVi), [
    "VI: He opened the door.",
    "VI: The officer stepped inside.",
    "VI: They found the evidence."
  ]);

  const routed = new (require("../electron/services/localTranslationService"))({
    localTranslationProvider: "hy_mt2_ollama"
  });
  assert.strictEqual(routed.provider, "hy_mt2_ollama");

  console.log("hyMtTranslationService tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
