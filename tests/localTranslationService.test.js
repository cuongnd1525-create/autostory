const assert = require("assert");
const LocalTranslationService = require("../electron/services/localTranslationService");

(async () => {
  const service = new LocalTranslationService();
  assert.strictEqual(service.model, "Helsinki-NLP/opus-mt-en-vi");
  await assert.rejects(
    () => service.translateToVietnamese({ segments: [{ id: "a", text: "Bonjour" }], sourceLanguage: "fr" }),
    /chỉ hỗ trợ nguồn tiếng Anh/i
  );

  console.log("localTranslationService tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
