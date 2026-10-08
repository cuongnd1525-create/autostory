// Antigravity (agy) model catalog shared by the settings UI (renderer, loaded
// with a <script> tag) and the Electron services (require()).
//
// Source of truth: the "Available models" list printed by agy itself
// (CLI log 2026-10-07 14:51:25). In agy the reasoning level is PART of the
// model name ("Gemini 3.7 Flash (High)"); agy rejects `--effort` for these
// models ("--effort is not supported for model ...", log 2026-10-08 09:20).
// So the UI offers model + reasoning as two selects and the host combines
// them into one model value; `--effort` is never sent.
//
// Gemini values use the ids agy resolves to its labels (verified in CLI logs:
// "Resolving model gemini-3.1-pro-high" -> label "Gemini 3.1 Pro (High)").
// Claude / GPT-OSS use agy's exact labels (no id has been verified in logs).
(function (root, factory) {
  const catalog = factory();
  if (typeof module === "object" && module.exports) module.exports = catalog;
  else root.AntigravityModelCatalog = catalog;
})(typeof self !== "undefined" ? self : this, function () {
  const REASONING_LABELS = { high: "Cao (High)", medium: "Vừa (Medium)", low: "Thấp (Low)", thinking: "Thinking" };

  const FAMILIES = [
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", reasoning: ["high", "medium", "low"] },
    { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", reasoning: ["high", "medium", "low"] },
    { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", reasoning: ["high", "medium", "low"] },
    { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", reasoning: ["high", "low"] },
    { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6", reasoning: ["thinking"] },
    { id: "claude-opus-4.6", label: "Claude Opus 4.6", reasoning: ["thinking"] },
    { id: "gpt-oss-120b", label: "GPT-OSS 120B", reasoning: ["medium"] }
  ];

  const titleCase = (level) => level.charAt(0).toUpperCase() + level.slice(1);

  /** Exact agy label, e.g. "Gemini 3.7 Flash (High)". */
  function agyLabel(family, level) {
    return `${family.label} (${titleCase(level)})`;
  }

  /** Value passed to `agy --model`. */
  function agyModelValue(family, level) {
    return /^gemini-/.test(family.id) ? `${family.id}-${level}` : agyLabel(family, level);
  }

  function findFamily(familyId) {
    return FAMILIES.find((family) => family.id === familyId) || null;
  }

  function pickReasoning(family, preferred) {
    const wanted = String(preferred || "").trim().toLowerCase();
    if (family.reasoning.includes(wanted)) return wanted;
    return family.reasoning.includes("high") ? "high" : family.reasoning[0];
  }

  /** (familyId, reasoning) -> agy model value; "" family = agy default model. */
  function resolveModel(familyId, reasoning) {
    const family = findFamily(familyId);
    if (!family) return "";
    return agyModelValue(family, pickReasoning(family, reasoning));
  }

  const ALIASES = (() => {
    const map = new Map();
    for (const family of FAMILIES) {
      for (const level of family.reasoning) {
        const entry = { familyId: family.id, reasoning: level };
        map.set(agyModelValue(family, level).toLowerCase(), entry);
        map.set(agyLabel(family, level).toLowerCase(), entry);
        map.set(`${family.id}-${level}`.toLowerCase(), entry);
      }
    }
    // Legacy ids from the previous hard-coded map.
    map.set("claude-sonnet-4-6", { familyId: "claude-sonnet-4.6", reasoning: "thinking" });
    map.set("claude-opus-4-6-thinking", { familyId: "claude-opus-4.6", reasoning: "thinking" });
    map.set("gpt-oss-120b-medium", { familyId: "gpt-oss-120b", reasoning: "medium" });
    return map;
  })();

  /**
   * Any saved/typed value -> { familyId, reasoning, known }. Accepts ids
   * ("gemini-3.7-flash-high"), agy labels ("Gemini 3.7 Flash (High)") and bare
   * family names without reasoning ("Gemini 3.7 Flash" -> fallbackReasoning).
   */
  function parseModel(value, fallbackReasoning = "high") {
    const text = String(value || "").trim();
    if (!text) return { familyId: "", reasoning: "", known: true };
    const lower = text.toLowerCase();
    if (ALIASES.has(lower)) return { ...ALIASES.get(lower), known: true };
    const bare = FAMILIES.find((family) => family.label.toLowerCase() === lower || family.id === lower);
    if (bare) return { familyId: bare.id, reasoning: pickReasoning(bare, fallbackReasoning), known: true };
    return { familyId: "", reasoning: "", known: false, raw: text };
  }

  /** Normalizes any value to what `agy --model` accepts; unknown values pass through unchanged. */
  function normalizeModel(value, fallbackReasoning = "high") {
    const parsed = parseModel(value, fallbackReasoning);
    if (!parsed.known) return String(value || "").trim();
    return parsed.familyId ? resolveModel(parsed.familyId, parsed.reasoning) : "";
  }

  function displayName(value) {
    const parsed = parseModel(value);
    if (!parsed.known) return String(value || "").trim();
    const family = findFamily(parsed.familyId);
    return family ? agyLabel(family, parsed.reasoning) : "";
  }

  return { FAMILIES, REASONING_LABELS, resolveModel, parseModel, normalizeModel, displayName, agyLabel, findFamily };
});
