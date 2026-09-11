const DEFAULT_MODEL = "hf.co/unsloth/Hy-MT2-7B-GGUF:UD-Q4_K_XL";

function normalizeBaseUrl(value = "") {
  return String(value || "http://127.0.0.1:11434").replace(/\/+$/, "");
}

function extractJson(value = "") {
  const text = String(value || "").trim();
  try {
    return JSON.parse(text);
  } catch (_error) {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    try {
      return JSON.parse(fenced.trim());
    } catch (_error) {}
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(text.slice(start, end + 1));
  }
  throw new Error("Hy-MT2 không trả về JSON dịch hợp lệ.");
}

function sourceLanguageName(value = "en") {
  const language = String(value || "en").toLowerCase();
  if (language === "auto") return "the detected source language";
  if (language.startsWith("en")) return "English";
  if (language.startsWith("zh")) return "Chinese";
  if (language.startsWith("ja")) return "Japanese";
  if (language.startsWith("ko")) return "Korean";
  if (language.startsWith("th")) return "Thai";
  return value;
}

class HyMtTranslationService {
  constructor(settings = {}) {
    this.settings = settings;
    this.model = settings.hyMt2Model || DEFAULT_MODEL;
    this.baseUrl = normalizeBaseUrl(settings.hyMt2OllamaBaseUrl);
    this.batchSize = Math.max(1, Math.min(12, Number(settings.hyMt2BatchSize || 6)));
    this.timeoutMs = Math.max(60000, Number(settings.localTranslationTimeoutMs || 10 * 60 * 1000));
  }

  async request(prompt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          keep_alive: "15m",
          format: "json",
          messages: [{ role: "user", content: prompt }],
          options: {
            temperature: 0.1,
            top_p: 0.6,
            top_k: 20,
            repeat_penalty: 1.05,
            num_ctx: 4096
          }
        }),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = payload.error || `${response.status} ${response.statusText}`;
        if (/not found|pull model/i.test(detail)) {
          throw new Error(`Chưa tải model Hy-MT2 "${this.model}". Hãy bấm "Tải Hy-MT2" trong Cài đặt.`);
        }
        throw new Error(`Ollama/Hy-MT2: ${detail}`);
      }
      return extractJson(payload.message?.content || payload.response || "");
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("Hy-MT2 timed out khi dịch phụ đề preview.");
      }
      if (/fetch failed|ECONNREFUSED/i.test(error.message)) {
        throw new Error("Không kết nối được Ollama. Hãy mở Ollama rồi thử lại.");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async translateBatch(items, sourceLanguage) {
    const input = items.map((item) => ({ id: item.id, text: item.text }));
    const prompt = [
      `Translate the following subtitle entries from ${sourceLanguageName(sourceLanguage)} into natural Vietnamese.`,
      "Use the surrounding entries as context so pronouns, names, police terminology, and story continuity remain consistent.",
      "Preserve every id exactly. Do not summarize, explain, censor, add facts, or merge entries.",
      "Return ONLY valid JSON with this exact shape: {\"translations\":[{\"id\":\"...\",\"text\":\"...\"}]}",
      `Input JSON: ${JSON.stringify(input)}`
    ].join("\n");
    const payload = await this.request(prompt);
    const translations = Array.isArray(payload.translations) ? payload.translations : [];
    const translated = new Map(translations.map((item) => [String(item.id || ""), String(item.text || "").trim()]));
    const missing = items.filter((item) => !translated.get(item.id));
    if (missing.length) {
      throw new Error(`Hy-MT2 trả thiếu ${missing.length}/${items.length} câu dịch.`);
    }
    return translated;
  }

  async translateToVietnamese({ segments = [], sourceLanguage = "en", onProgress }) {
    const cleanSegments = segments
      .map((segment, index) => ({
        id: String(segment.id || `preview_${index + 1}`),
        text: String(segment.text || "").replace(/\s+/g, " ").trim()
      }))
      .filter((segment) => segment.text);
    if (!cleanSegments.length) return [];

    onProgress?.(`Đang dịch phụ đề bằng Hy-MT2 7B (${this.model}).`);
    const translated = new Map();
    for (let offset = 0; offset < cleanSegments.length; offset += this.batchSize) {
      const batch = cleanSegments.slice(offset, offset + this.batchSize);
      onProgress?.(`Hy-MT2 đang dịch ${offset + 1}-${offset + batch.length}/${cleanSegments.length}.`);
      const batchResult = await this.translateBatch(batch, sourceLanguage);
      batchResult.forEach((text, id) => translated.set(id, text));
    }

    return segments.map((segment, index) => {
      const id = String(segment.id || `preview_${index + 1}`);
      const text = translated.get(id) || "";
      return { ...segment, id, translatedText: text, previewSubtitleVi: text };
    });
  }
}

module.exports = HyMtTranslationService;
module.exports.DEFAULT_MODEL = DEFAULT_MODEL;
module.exports.extractJson = extractJson;
