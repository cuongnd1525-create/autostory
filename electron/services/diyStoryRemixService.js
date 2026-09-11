const path = require("path");
const { buildGeminiInputAccessGate } = require("./geminiInputAccessGate");

function safeText(value = "") {
  return String(value || "")
    .replace(/\[\s*cite\s*:\s*[^\]]+\]/gi, "")
    .replace(/【\s*\d+(?:†[^】]*)?】/g, "")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function textList(value) {
  if (Array.isArray(value)) return value.map(safeText).filter(Boolean);
  const text = safeText(value);
  return text ? [text] : [];
}

function clamp(value, min, max, fallback = min) {
  return Math.min(max, Math.max(min, safeNumber(value, fallback)));
}

const DIY_NARRATIVE_PURPOSES = new Set([
  "hidden_context",
  "stakes",
  "emotion",
  "contradiction",
  "anticipation",
  "transition",
  "payoff_meaning",
  "technical_clarity",
  "satisfying_sound"
]);

const DIY_ARTIFACT_STATES = new Set(["rough", "in_progress", "near_complete", "complete", "human_payoff"]);
const DIY_VISUAL_CLAIM_TYPES = new Set(["process", "near_complete", "completed_result", "human_payoff", "neutral"]);
const DIY_DELIVERY_PROFILES = new Set(["mystery_hook", "urgent_hook", "warm_story", "process_energy", "intimate_payoff", "natural"]);

function contentTokens(value = "") {
  const stopWords = new Set([
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "had", "has", "have",
    "he", "her", "his", "i", "in", "into", "is", "it", "its", "my", "of", "on", "or", "our", "she",
    "so", "that", "the", "their", "then", "they", "this", "to", "was", "we", "were", "with", "you"
  ]);
  return new Set(safeText(value).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((token) => token.length > 2 && !stopWords.has(token)));
}

function tokenOverlap(left = "", right = "") {
  const leftTokens = contentTokens(left);
  const rightTokens = contentTokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return overlap / Math.max(1, Math.min(leftTokens.size, rightTokens.size));
}

function normalizeStorySpineEntry(value, fallback = "") {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      text: safeText(value.text || value.value || fallback),
      evidenceBeatIds: textList(value.evidenceBeatIds || value.visualBeatIds || value.evidenceIds),
      grounding: safeText(value.grounding || "source_evidence").toLowerCase()
    };
  }
  return { text: safeText(value || fallback), evidenceBeatIds: [], grounding: "source_evidence" };
}

function buildDiyStoryProfileFewShot(storyAngle = "gemini_auto_story") {
  const examples = {
    gemini_auto_story: `PROFILE FEW-SHOT - GEMINI AUTO STORY:
- Evidence: a stripped bus shell, children testing unfinished bunks, and a final family reaction.
- Bad VO: "Next, I installed the windows and built the beds."
- Good VO: "The shell was never the real goal. Every risky cut was buying six people a little more room to call their own."
- Spine: premise=turning an unwanted shell into belonging; stakes=one structural mistake could end the plan; payoff=the family's verified reaction.`,
    failure_to_success: `PROFILE FEW-SHOT - FAILURE TO SUCCESS:
- Evidence: a failed seal, visible water ingress, a repaired edge, and a dry final test.
- Bad VO: "Then I removed the seal and applied a new one."
- Good VO: "The first rain exposed the one shortcut I thought nobody would notice. Fixing it meant undoing hours of work before the damage spread."
- Spine: premise=a promising build; struggle=a verified failure; turningPoint=choosing to redo it correctly; payoff=the successful retest.`,
    transformation_journey: `PROFILE FEW-SHOT - TRANSFORMATION JOURNEY:
- Evidence: a corroded empty shell gradually becomes a finished living space.
- Bad VO: "After that, I added insulation and wall panels."
- Good VO: "At first, every surface made the project feel temporary. The turning point came when the empty shell finally began to feel like somewhere a person could stay."
- Spine: premise=unusable beginning; progression=visible irreversible changes; payoff=before/after contrast plus verified first use.`,
    impossible_challenge: `PROFILE FEW-SHOT - IMPOSSIBLE CHALLENGE:
- Evidence: limited space, difficult fit, repeated measurements, and a component finally locking into place.
- Bad VO: "I measured the cabinet and pushed it inside."
- Good VO: "There was almost no room for error. If this piece missed by even a little, the rest of the layout would have nowhere to go."
- Spine: premise=a visually difficult constraint; stakes=verified dependency; struggle=failed or careful attempts; payoff=the fit succeeds. Never invent cost or deadlines.`,
    emotional_story: `PROFILE FEW-SHOT - EMOTIONAL STORY:
- Evidence: a spoken dedication, a child interacting with the build, or a verified proposal/reaction at the payoff.
- Bad VO: "I built the bed and my family was happy."
- Good VO: "The smallest bunk carried the biggest promise: this project was finally becoming a place the children could recognize as theirs."
- Spine: premise=verified human reason; struggle=what threatens it; turningPoint=commitment shown on screen; payoff=the timestamped human reaction. If human evidence is absent, leave emotional claims empty and use a transformation profile instead.`
  };
  return examples[storyAngle] || examples.gemini_auto_story;
}

function findDependencyCycle(beats) {
  const graph = new Map(beats.map((beat) => [beat.visualBeatId, beat.requiredBefore]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependencyId of graph.get(id) || []) {
      if (graph.has(dependencyId) && visit(dependencyId)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  return beats.some((beat) => visit(beat.visualBeatId));
}

function validateDiyProcessMap(payload, manifest, sourceName = "diy-process-map.json") {
  const rawBeats = payload?.visualBeats || payload?.visual_beats || payload?.beats;
  if (!Array.isArray(rawBeats) || !rawBeats.length) {
    if (Array.isArray(payload?.blocks || payload?.macroBlocks)) {
      throw new Error(`${sourceName}: đây là DIY Story Blueprint của Giai đoạn 3. Ở bước này hãy chọn Visual Process Map có mảng visualBeats.`);
    }
    if (Array.isArray(payload?.segments)) {
      throw new Error(`${sourceName}: đây là Voice-Locked Script của Giai đoạn 4. Ở bước này hãy chọn Visual Process Map từ Giai đoạn 1/2.`);
    }
    throw new Error(`${sourceName}: thiếu mảng visualBeats có dữ liệu.`);
  }
  const sceneMap = new Map((manifest?.scenes || []).map((scene) => [safeText(scene.sceneId), scene]));
  const schemaVersion = Math.max(1, safeNumber(payload?.schemaVersion, 1));
  const errors = [];
  const warnings = [];
  const ids = new Set();
  const beats = rawBeats.map((item, index) => {
    const visualBeatId = safeText(item?.visualBeatId || item?.beatId || `beat_${String(index + 1).padStart(4, "0")}`);
    const sceneId = safeText(item?.sceneId || item?.sceneIds?.[0]);
    const scene = sceneMap.get(sceneId);
    const sourceStartSec = safeNumber(item?.sourceStartSec ?? item?.startSec, NaN);
    const sourceEndSec = safeNumber(item?.sourceEndSec ?? item?.endSec, NaN);
    const visualFacts = textList(item?.visualFacts || item?.visualEvidence);
    const phase = safeText(item?.phase || item?.processPhase || item?.narrativePhase).toLowerCase();
    const requiredBefore = textList(item?.requiredBefore || item?.dependsOn);
    const requiredAfter = textList(item?.requiredAfter);
    if (!visualBeatId || ids.has(visualBeatId)) errors.push(`Visual beat ${index + 1}: visualBeatId trống hoặc bị trùng.`);
    ids.add(visualBeatId);
    if (!scene) errors.push(`${visualBeatId}: sceneId "${sceneId || "(trống)"}" không tồn tại.`);
    if (!Number.isFinite(sourceStartSec) || !Number.isFinite(sourceEndSec) || sourceEndSec <= sourceStartSec) {
      errors.push(`${visualBeatId}: sourceStartSec/sourceEndSec không hợp lệ.`);
    } else if (scene && (sourceStartSec < Number(scene.startSec) - 0.001 || sourceEndSec > Number(scene.endSec) + 0.001)) {
      errors.push(`${visualBeatId}: khoảng nguồn ${sourceStartSec.toFixed(3)}-${sourceEndSec.toFixed(3)}s nằm ngoài ${sceneId} (${Number(scene.startSec).toFixed(3)}-${Number(scene.endSec).toFixed(3)}s).`);
    }
    if (!visualFacts.length) errors.push(`${visualBeatId}: thiếu visualFacts cụ thể.`);
    if (!phase) errors.push(`${visualBeatId}: thiếu phase của quá trình DIY.`);
    const stateBefore = safeText(item?.stateBefore);
    const visibleAction = safeText(item?.visibleAction || item?.action);
    const stateAfter = safeText(item?.stateAfter);
    const artifactState = safeText(item?.artifactState || item?.artifact_state).toLowerCase();
    const completionLevel = clamp(item?.completionLevel ?? item?.completion_level, 0, 1, 0);
    const visibleCompletionEvidence = textList(item?.visibleCompletionEvidence || item?.visible_completion_evidence);
    if (schemaVersion >= 2 && !DIY_ARTIFACT_STATES.has(artifactState)) {
      errors.push(`${visualBeatId}: artifactState không hợp lệ hoặc bị thiếu.`);
    }
    if (["near_complete", "complete", "human_payoff"].includes(artifactState) && !visibleCompletionEvidence.length) {
      errors.push(`${visualBeatId}: trạng thái ${artifactState} cần visibleCompletionEvidence cụ thể.`);
    }
    if (artifactState === "complete" && completionLevel < 0.85) {
      errors.push(`${visualBeatId}: artifactState=complete nhưng completionLevel dưới 0.85.`);
    }
    if (artifactState === "human_payoff" && completionLevel < 0.7) {
      warnings.push(`${visualBeatId}: human_payoff xuất hiện khi công trình mới đạt ${Math.round(completionLevel * 100)}%; hãy xác nhận đây thực sự là payoff cá nhân.`);
    }
    const rawHumanStoryEvidence = Array.isArray(item?.humanStoryEvidence) ? item.humanStoryEvidence : [];
    const humanStoryEvidence = rawHumanStoryEvidence.map((evidence, evidenceIndex) => {
      const evidenceStartSec = safeNumber(evidence?.sourceStartSec ?? evidence?.startSec, NaN);
      const evidenceEndSec = safeNumber(evidence?.sourceEndSec ?? evidence?.endSec, NaN);
      const evidenceType = safeText(evidence?.evidenceType || evidence?.type).toLowerCase();
      const observedSignal = safeText(evidence?.observedSignal || evidence?.evidence || evidence?.quote);
      const supportedMeaning = safeText(evidence?.supportedMeaning || evidence?.meaning);
      const evidenceLabel = `${visualBeatId}.humanStoryEvidence[${evidenceIndex}]`;
      if (!Number.isFinite(evidenceStartSec) || !Number.isFinite(evidenceEndSec) || evidenceEndSec <= evidenceStartSec) {
        errors.push(`${evidenceLabel}: thiếu timestamp nguồn hợp lệ.`);
      } else if (Number.isFinite(sourceStartSec) && Number.isFinite(sourceEndSec)
        && (evidenceStartSec < sourceStartSec - 0.001 || evidenceEndSec > sourceEndSec + 0.001)) {
        errors.push(`${evidenceLabel}: timestamp phải nằm trong visual beat ${sourceStartSec.toFixed(3)}-${sourceEndSec.toFixed(3)}s.`);
      }
      if (!["spoken", "transcript", "on_screen_text", "visible_behavior"].includes(evidenceType)) {
        errors.push(`${evidenceLabel}: evidenceType phải là spoken, transcript, on_screen_text hoặc visible_behavior.`);
      }
      if (!observedSignal) errors.push(`${evidenceLabel}: thiếu observedSignal nhìn thấy hoặc nghe thấy được.`);
      if (!supportedMeaning) errors.push(`${evidenceLabel}: thiếu supportedMeaning được bằng chứng hỗ trợ.`);
      return {
        sourceStartSec: Number.isFinite(evidenceStartSec) ? Number(evidenceStartSec.toFixed(3)) : null,
        sourceEndSec: Number.isFinite(evidenceEndSec) ? Number(evidenceEndSec.toFixed(3)) : null,
        evidenceType,
        observedSignal,
        supportedMeaning,
        confidence: clamp(evidence?.confidence, 0, 1, 0.5)
      };
    });
    const rawPersonalPayoffEvidence = Array.isArray(item?.personalPayoffEvidence) ? item.personalPayoffEvidence : [];
    const personalPayoffEvidence = rawPersonalPayoffEvidence.map((evidence, evidenceIndex) => {
      const evidenceStartSec = safeNumber(evidence?.sourceStartSec ?? evidence?.startSec, NaN);
      const evidenceEndSec = safeNumber(evidence?.sourceEndSec ?? evidence?.endSec, NaN);
      const evidenceType = safeText(evidence?.evidenceType || evidence?.type).toLowerCase();
      const observedSignal = safeText(evidence?.observedSignal || evidence?.evidence || evidence?.quote);
      const supportedMeaning = safeText(evidence?.supportedMeaning || evidence?.meaning);
      const payoffType = safeText(evidence?.payoffType || evidence?.payoff_type || "other_verified").toLowerCase();
      const evidenceLabel = `${visualBeatId}.personalPayoffEvidence[${evidenceIndex}]`;
      if (!Number.isFinite(evidenceStartSec) || !Number.isFinite(evidenceEndSec) || evidenceEndSec <= evidenceStartSec) {
        errors.push(`${evidenceLabel}: thiếu timestamp nguồn hợp lệ.`);
      } else if (Number.isFinite(sourceStartSec) && Number.isFinite(sourceEndSec)
        && (evidenceStartSec < sourceStartSec - 0.001 || evidenceEndSec > sourceEndSec + 0.001)) {
        errors.push(`${evidenceLabel}: timestamp phải nằm trong visual beat ${sourceStartSec.toFixed(3)}-${sourceEndSec.toFixed(3)}s.`);
      }
      if (!["spoken", "transcript", "on_screen_text", "visible_behavior"].includes(evidenceType)) {
        errors.push(`${evidenceLabel}: evidenceType không hợp lệ.`);
      }
      if (!observedSignal) errors.push(`${evidenceLabel}: thiếu observedSignal.`);
      if (!supportedMeaning) errors.push(`${evidenceLabel}: thiếu supportedMeaning.`);
      return {
        sourceStartSec: Number.isFinite(evidenceStartSec) ? Number(evidenceStartSec.toFixed(3)) : null,
        sourceEndSec: Number.isFinite(evidenceEndSec) ? Number(evidenceEndSec.toFixed(3)) : null,
        evidenceType,
        payoffType,
        observedSignal,
        supportedMeaning,
        confidence: clamp(evidence?.confidence, 0, 1, 0.5)
      };
    });
    if (!visibleAction) warnings.push(`${visualBeatId}: thiếu visibleAction.`);
    if (!stateBefore && !stateAfter) warnings.push(`${visualBeatId}: thiếu stateBefore/stateAfter để kiểm tra continuity vật thể.`);
    return {
      visualBeatId,
      evidenceId: visualBeatId,
      sceneId,
      sourceStartSec: Number.isFinite(sourceStartSec) ? Number(sourceStartSec.toFixed(3)) : null,
      sourceEndSec: Number.isFinite(sourceEndSec) ? Number(sourceEndSec.toFixed(3)) : null,
      durationSec: Number.isFinite(sourceStartSec) && Number.isFinite(sourceEndSec)
        ? Number((sourceEndSec - sourceStartSec).toFixed(3))
        : 0,
      phase,
      narrativePhase: phase,
      visualFacts,
      stateBefore,
      visibleAction,
      stateAfter,
      artifactState: artifactState || (/payoff|result|finish/.test(phase) ? "complete" : "in_progress"),
      completionLevel,
      visibleCompletionEvidence,
      requiredBefore,
      requiredAfter,
      reorderSafety: safeText(item?.reorderSafety || "dependency_locked").toLowerCase(),
      completeBeat: item?.completeBeat !== false,
      storyMeaning: safeText(item?.storyMeaning || item?.narrativeValue || visibleAction || visualFacts[0]),
      humanStoryEvidence,
      personalPayoffEvidence,
      hookPotential: clamp(item?.hookPotential ?? item?.hookScore ?? item?.hookStrength, 0, 10, 0),
      hookScore: clamp(item?.hookPotential ?? item?.hookScore ?? item?.hookStrength, 0, 10, 0),
      payoffPotential: clamp(item?.payoffPotential ?? item?.payoffScore ?? item?.payoffStrength, 0, 10, 0),
      curiosityPotential: clamp(item?.curiosityPotential ?? item?.curiosityScore ?? item?.curiosityStrength, 0, 10, 0),
      confidence: clamp(item?.confidence, 0, 1, 0.5),
      safeForVoiceover: item?.safeForVoiceover !== false,
      sourceSpeechPresent: item?.sourceSpeechPresent === true,
      satisfyingSoundPresent: item?.satisfyingSoundPresent === true,
      soundCues: textList(item?.soundCues),
      burnedTextPresent: item?.burnedTextPresent === true,
      burnedTextContent: safeText(item?.burnedTextContent)
    };
  });
  const beatMap = new Map(beats.map((beat) => [beat.visualBeatId, beat]));
  beats.forEach((beat) => {
    [...beat.requiredBefore, ...beat.requiredAfter].forEach((dependencyId) => {
      if (!ids.has(dependencyId)) errors.push(`${beat.visualBeatId}: dependency "${dependencyId}" không tồn tại.`);
      if (dependencyId === beat.visualBeatId) errors.push(`${beat.visualBeatId}: không được phụ thuộc chính nó.`);
    });
    beat.requiredAfter.forEach((nextBeatId) => {
      const nextBeat = beatMap.get(nextBeatId);
      if (nextBeat && !nextBeat.requiredBefore.includes(beat.visualBeatId)) {
        nextBeat.requiredBefore.push(beat.visualBeatId);
      }
    });
  });
  if (findDependencyCycle(beats)) errors.push("Visual Process Map có vòng lặp dependency nên không thể xác định thứ tự DIY hợp lệ.");
  if (errors.length) throw new Error(`${sourceName}: ${errors.join(" | ")}`);
  return {
    artifactType: "diy_visual_process_map",
    schemaVersion,
    sourceVideo: manifest?.sourceVideo || path.basename(safeText(payload?.sourceVideo)),
    projectSummary: safeText(payload?.projectSummary || payload?.summary),
    finalResult: safeText(payload?.finalResult),
    centralTransformation: safeText(payload?.centralTransformation),
    sourceStorySummary: safeText(payload?.sourceStorySummary || payload?.sourceStory?.summary),
    sourceStoryTheme: safeText(payload?.sourceStoryTheme || payload?.sourceStory?.theme),
    sourceStoryArc: safeText(payload?.sourceStoryArc || payload?.sourceStory?.arc),
    sourceStorySignals: Array.isArray(payload?.sourceStorySignals || payload?.sourceStory?.signals)
      ? (payload.sourceStorySignals || payload.sourceStory.signals).map((signal) => ({
        sourceStartSec: safeNumber(signal?.sourceStartSec ?? signal?.startSec, 0),
        sourceEndSec: safeNumber(signal?.sourceEndSec ?? signal?.endSec, 0),
        type: safeText(signal?.type || "visual"),
        evidence: safeText(signal?.evidence || signal?.text)
      })).filter((signal) => signal.evidence)
      : [],
    visualBeats: beats,
    evidence: beats,
    warnings
  };
}

function evaluateDiyProcessMapQuality(processMap, manifest = {}) {
  const beats = processMap?.visualBeats || [];
  const phases = new Set(beats.map((beat) => beat.phase));
  const failures = [];
  const recommendations = [];
  let score = 100;
  const minimum = Math.max(4, Math.min(10, Math.ceil((manifest?.scenes?.length || 4) * 0.4)));
  if (beats.length < minimum) {
    score -= 20;
    failures.push(`Chỉ có ${beats.length}/${minimum} visual beat tối thiểu.`);
    recommendations.push("Bổ sung trạng thái ban đầu, các thao tác biến đổi quan trọng, trở ngại và thành phẩm.");
  }
  if (!beats.some((beat) => /before|setup|initial/.test(beat.phase))) {
    score -= 15;
    failures.push("Thiếu trạng thái ban đầu của vật thể/dự án.");
  }
  if (!beats.some((beat) => /process|build|transform|problem|failure|fix/.test(beat.phase))) {
    score -= 20;
    failures.push("Thiếu thao tác hoặc trở ngại chính của quá trình DIY.");
  }
  if (!beats.some((beat) => /payoff|result|after|reveal|finish/.test(beat.phase))) {
    score -= 20;
    failures.push("Thiếu thành phẩm/payoff nhìn thấy rõ.");
  }
  if (!beats.some((beat) => beat.hookPotential >= 8 || beat.payoffPotential >= 8 || beat.curiosityPotential >= 8)) {
    score -= 20;
    failures.push("Chưa có visual beat đủ mạnh để làm Hook.");
  }
  const stateCoverage = beats.filter((beat) => beat.visibleAction && (beat.stateBefore || beat.stateAfter)).length / Math.max(1, beats.length);
  if (stateCoverage < 0.7) {
    score -= 15;
    failures.push(`Chỉ ${Math.round(stateCoverage * 100)}% beat có hành động kèm trạng thái trước/sau.`);
  }
  const humanEvidenceCount = beats.reduce((sum, beat) => sum + (beat.humanStoryEvidence?.length || 0), 0);
  const personalPayoffCount = beats.reduce((sum, beat) => sum + (beat.personalPayoffEvidence?.length || 0), 0);
  if (!humanEvidenceCount) recommendations.push("Không tìm thấy humanStoryEvidence đã khóa; tránh dùng profile cảm xúc hoặc tuyên bố động lực cá nhân.");
  if (!personalPayoffCount) recommendations.push("Không tìm thấy personalPayoffEvidence; dùng payoff hình ảnh thay vì bịa phản ứng hoặc ý nghĩa cá nhân.");
  return {
    passed: failures.length === 0 && score >= 80,
    score: Math.max(0, score),
    failures,
    recommendations,
    metrics: { beatCount: beats.length, minimumBeatCount: minimum, phases: [...phases], stateCoverage, humanEvidenceCount, personalPayoffCount }
  };
}

function buildDiyProcessMapPrompt({ basePrompt = "", manifest, actionCandidates, proxyInputGuide = "" }) {
  return `${buildGeminiInputAccessGate({
    stage: "diy_visual_process_map",
    requiredInputs: ["all supplied DIY source proxy chunks", "scene-manifest.json", "source transcript/captions when supplied", "action-candidates.json"]
  })}

USER TASK INSTRUCTION - DIY VISUAL PROCESS MAP

Watch the complete supplied DIY/storytelling source before responding. This pass extracts visual truth only; do not write narration or an output timeline yet.

${proxyInputGuide}

PROCESS-GROUNDING RULES:
1. Identify the visible object/project state before each meaningful operation, the concrete action, and the visible state after it.
2. Every visual beat must stay inside one sceneId boundary from scene-manifest.json. Split a process across scene boundaries when needed.
3. Build dependency links with requiredBefore/requiredAfter. Physical process order outranks creative reordering.
4. Mark payoff/result/failure beats with hookPotential, payoffPotential and curiosityPotential. A future payoff may become a flash-forward Hook later.
5. Do not infer cost, elapsed time, motivation, ownership, relationships, measurements, materials, success, or failure unless visible/audible evidence supports it.
6. Analyze the complete source. action-candidates.json is only a motion/audio radar and must not replace visual inspection.
7. Keep complete operations intact. Do not create many tiny beats from one continuous action.
8. Analyze the original story carried by source speech, captions, on-screen text and the visual transformation. Record its summary, theme, emotional arc and timestamped story signals. Do not write the replacement story in this pass.
9. ANTI-EMOTIONAL-HALLUCINATION: Every humanStoryEvidence item MUST include an exact sourceStartSec/sourceEndSec and an observedSignal directly visible in frames or audible/verbatim in the source/transcript. Never invent motivation, hardship, family relationships, sacrifice, fear, hope, pride or emotional stakes. If a beat has no visual or audible human-story evidence, return humanStoryEvidence: []. Use empty strings for unsupported optional emotional fields; never fill them with a guess.
10. PERSONAL PAYOFF SCAN: Search specifically for verified human payoff moments such as a family reaction, first use, spoken dedication, proposal, gift reveal, relief, celebration or reflective statement. Store them in personalPayoffEvidence with exact timestamps. A finished object by itself is a visual payoff, not a personal payoff. If none exists, return personalPayoffEvidence: [].
11. COMPLETION STATE: Classify every beat as rough, in_progress, near_complete, complete or human_payoff. completionLevel must reflect only what is visibly finished. near_complete/complete/human_payoff require visibleCompletionEvidence naming the exact clean surface, installed component, switched-on light, first use or verified reaction visible in that range.

OUTPUT CONTRACT:
- Return exactly one valid JSON object inside exactly one Markdown code block marked json, with no prose before or after it.
- The root artifactType must be "diy_visual_process_map" and visualBeats must be non-empty.
- Validate the final object with JSON.parse before responding.
- Never include citation markers such as [cite: 8], [cite: 1, 6], footnotes or source-reference tokens in any JSON string.

REQUIRED SCHEMA:
{
  "artifactType": "diy_visual_process_map",
  "schemaVersion": 2,
  "sourceVideo": "${manifest?.sourceVideo || ""}",
  "projectSummary": "What is visibly being made, repaired, cleaned or transformed",
  "centralTransformation": "Concrete before-to-after transformation",
  "finalResult": "Visible result only",
  "sourceStorySummary": "What story the original video tells",
  "sourceStoryTheme": "Core theme such as rebuilding a home, persistence, family or transformation",
  "sourceStoryArc": "Original setup -> tension/challenge -> progression -> payoff",
  "sourceStorySignals": [{
    "sourceStartSec": 0,
    "sourceEndSec": 5,
    "type": "spoken_story | on_screen_text | visual_story",
    "evidence": "Exact source-grounded story signal"
  }],
  "visualBeats": [{
    "visualBeatId": "beat_0001",
    "sceneId": "scene_0001",
    "sourceStartSec": 0,
    "sourceEndSec": 5,
    "phase": "before_state | process | failure | fix | payoff",
    "visualFacts": ["Concrete visible fact"],
    "stateBefore": "Visible state before",
    "visibleAction": "Exact visible operation",
    "stateAfter": "Visible state after",
    "artifactState": "rough | in_progress | near_complete | complete | human_payoff",
    "completionLevel": 0.35,
    "visibleCompletionEvidence": ["Exact visible feature proving this completion state"],
    "requiredBefore": [],
    "requiredAfter": ["beat_0002"],
    "reorderSafety": "movable | dependency_locked | payoff_flash_forward_only",
    "completeBeat": true,
    "storyMeaning": "Why this advances the transformation",
    "humanStoryEvidence": [{
      "sourceStartSec": 0,
      "sourceEndSec": 3,
      "evidenceType": "spoken | transcript | on_screen_text | visible_behavior",
      "observedSignal": "Exact quote, on-screen text or concrete visible behavior",
      "supportedMeaning": "Narrow human-story meaning supported by that signal",
      "confidence": 0.9
    }],
    "personalPayoffEvidence": [{
      "sourceStartSec": 50,
      "sourceEndSec": 55,
      "evidenceType": "spoken | transcript | on_screen_text | visible_behavior",
      "payoffType": "family_reaction | personal_milestone | proposal | first_use | spoken_reflection | other_verified",
      "observedSignal": "Exact visible reaction or spoken line",
      "supportedMeaning": "Narrow personal payoff supported by the signal",
      "confidence": 0.95
    }],
    "hookPotential": 0,
    "payoffPotential": 0,
    "curiosityPotential": 0,
    "confidence": 0.9,
    "safeForVoiceover": true,
    "sourceSpeechPresent": false,
    "satisfyingSoundPresent": true,
    "soundCues": ["scraping"],
    "burnedTextPresent": false,
    "burnedTextContent": ""
  }]
}

SCENE MANIFEST SUMMARY:
${JSON.stringify({ sourceVideo: manifest?.sourceVideo || "", videoDurationSec: manifest?.videoDurationSec || 0, scenes: manifest?.scenes || [] }, null, 2)}

ACTION RADAR:
${JSON.stringify(actionCandidates || { candidates: [] }, null, 2)}

USER OPTIONS AND VOICE CONTEXT:
${basePrompt}`;
}

function buildDiyBlueprintPrompt({ processMap, manifest, basePrompt = "" }) {
  const storyAngleMatch = String(basePrompt || "").match(/storyAngle:\s*([a-z_]+)/i);
  const requestedStoryAngle = safeText(storyAngleMatch?.[1] || "gemini_auto_story").toLowerCase();
  const isAutoStory = requestedStoryAngle === "gemini_auto_story";
  return `${buildGeminiInputAccessGate({
    stage: "diy_story_blueprint",
    requiredInputs: ["tool-validated Visual Process Map", "scene-manifest summary", "user story profile/options"]
  })}

USER TASK INSTRUCTION - DIY STORY BLUEPRINT

Create one coherent DIY Story Remix blueprint from the tool-validated Visual Process Map below. Do not write final voiceover_text yet.

EDITORIAL LOGIC:
1. Select one high-curiosity failure, surprising operation, or final payoff as a short flash-forward Hook.
2. After the Hook, return clearly to the initial state.
3. Preserve every physical dependency in the body. Never show a result before its required operation except for the explicitly labeled Hook replay.
4. Group adjacent visual beats into understandable macro-blocks. Do not fragment one complete operation.
5. Build a complete arc: Hook -> initial state -> process -> obstacle/fix -> visible payoff.
6. Each block must explain why the transition is understandable to a cold viewer.
7. Use the requested story angle, but never invent facts not present in locked visualFacts, sourceStorySignals or timestamped humanStoryEvidence. A human motive or emotion without timestamped evidence is not a fact.
${isAutoStory ? `8. GEMINI AUTO STORY PROFILE: First identify the source story's core theme and emotional trajectory from sourceStorySummary/sourceStoryTheme/sourceStorySignals. Then create a NEW parallel story concept with the same broad subject and emotional shape, without copying the source wording.
9. The adapted story should feel like one continuous story, not a tutorial or a list of visible steps. Map each story beat to a compatible visible transformation beat.
10. Creative narration may introduce a generalized human premise, tension and resolution. It must not contradict the image or assert unsupported concrete facts about the real creator, materials, ownership, price, measurements, elapsed time or outcome.
11. Fill sourceStoryTheme, adaptedStoryConcept and adaptedStoryArc explicitly so the next pass cannot silently switch to a different subject.` : ""}
12. INFORMATION GAP HOOK: Build the Hook as [shocking result, visible failure or concrete risk] + [cause deliberately withheld]. Do not reveal the withheld cause in the Hook. Store the disclosure contract in informationGap. Choose a later revealAtBlockId and list the exact words/phrases that must not appear in narration before that block.
13. Example: the Hook may refer to the risk visible in beat_0008, while informationGap.withheldCause="water leak", revealAtBlockId="block_03", and forbiddenTermsBeforeReveal=["water leak", "water flooded"]. The first two narration blocks must preserve that gap.
14. STORY SPINE FIRST: Before arranging blocks, write one connected storySpine with premise, humanWant, stakes, centralStruggle, turningPoint, emotionalPayoff and endingMeaning. Each non-empty spine entry must list the locked evidenceBeatIds supporting it. Set grounding="creative_overlay" only for a generalized parallel-story line that is not presented as a fact about the real creator. Never manufacture a personal payoff when personalPayoffEvidence is empty.
15. PAYOFF VISUAL HARMONY: A payoff block about a finished result, lights turning on, first use, proposal or family reaction MUST use beats whose artifactState and visibleCompletionEvidence show that exact state. Prefer the cleanest complete/human_payoff beat. Never map completed-result language onto rough or in_progress construction footage.

${buildDiyStoryProfileFewShot(requestedStoryAngle)}

OUTPUT CONTRACT:
- Return exactly one JSON object in one json Markdown code block and no other prose.
- Root artifactType must be "diy_story_blueprint" and blocks must be non-empty.
- Never include citation markers, footnotes or source-reference tokens in any JSON string.

SCHEMA:
{
  "artifactType": "diy_story_blueprint",
  "schemaVersion": 2,
  "storyAngle": "${requestedStoryAngle}",
  "sourceStoryTheme": "Theme identified from the original video",
  "adaptedStoryConcept": "New parallel story with a similar subject and emotional trajectory",
  "adaptedStoryArc": ["Hook", "Setup", "Pressure", "Turning point", "Payoff"],
  "adaptationBoundaries": ["Do not contradict visible operations", "Do not invent concrete facts about the real creator"],
  "titleDirection": "Curiosity-driven truthful title direction",
  "narrativePromise": "What the viewer will see resolved",
  "storySpine": {
    "premise": { "text": "Core human or transformation premise", "evidenceBeatIds": ["beat_0001"], "grounding": "source_evidence | creative_overlay" },
    "humanWant": { "text": "Verified or generalized want", "evidenceBeatIds": ["beat_0001"], "grounding": "source_evidence | creative_overlay" },
    "stakes": { "text": "What can concretely be lost or fail", "evidenceBeatIds": ["beat_0003"], "grounding": "source_evidence | creative_overlay" },
    "centralStruggle": { "text": "Main obstacle driving the story", "evidenceBeatIds": ["beat_0003"], "grounding": "source_evidence" },
    "turningPoint": { "text": "Decision or visible change that redirects the outcome", "evidenceBeatIds": ["beat_0005"], "grounding": "source_evidence" },
    "emotionalPayoff": { "text": "Timestamp-supported personal payoff, or empty when absent", "evidenceBeatIds": ["beat_0008"], "grounding": "source_evidence" },
    "endingMeaning": { "text": "Meaning earned by the visible payoff", "evidenceBeatIds": ["beat_0008"], "grounding": "source_evidence | creative_overlay" }
  },
  "informationGap": {
    "hookStatement": "One-sentence shocking result or risk while its cause remains hidden",
    "withheldCause": "The exact source-grounded cause hidden by the Hook",
    "revealAtBlockId": "block_03",
    "forbiddenTermsBeforeReveal": ["exact cause term", "revealing synonym"],
    "payoffVisualBeatIds": ["beat_0008"]
  },
  "hookVisualBeatIds": ["beat_0008"],
  "blocks": [{
    "blockId": "block_01",
    "storyFunction": "hook | setup | process | obstacle | fix | payoff",
    "visualBeatIds": ["beat_0008"],
    "transitionType": "flash_forward | return_to_start | continuous | causal_jump",
    "transitionReason": "Concrete reason the cut remains understandable",
    "narrativeGoal": "Information this block adds",
    "preserveCausalOrder": true
  }]
}

SOURCE SUMMARY:
${JSON.stringify({ sourceVideo: manifest?.sourceVideo || "", durationSec: manifest?.videoDurationSec || 0 }, null, 2)}

LOCKED VISUAL PROCESS MAP:
${JSON.stringify(processMap, null, 2)}

USER-SELECTED STORY PROFILE:
${basePrompt}`;
}

function validateDiyBlueprint(payload, processMap, sourceName = "diy-story-blueprint.json") {
  const rawBlocks = payload?.blocks || payload?.macroBlocks;
  if (safeText(payload?.artifactType) !== "diy_story_blueprint" || !Array.isArray(rawBlocks) || !rawBlocks.length) {
    if (Array.isArray(payload?.segments)) {
      throw new Error(`${sourceName}: đây là Voice-Locked Script của Giai đoạn 4. Ở bước này hãy chọn file diy_story_blueprint có mảng blocks từ Giai đoạn 3.`);
    }
    if (Array.isArray(payload?.visualBeats)) {
      throw new Error(`${sourceName}: đây là Visual Process Map của Giai đoạn 1/2. Hãy gửi prompt Giai đoạn 3 cho Gemini và chọn file diy_story_blueprint.`);
    }
    throw new Error(`${sourceName}: cần artifactType="diy_story_blueprint" và mảng blocks có dữ liệu.`);
  }
  const beatMap = new Map((processMap?.visualBeats || []).map((beat) => [beat.visualBeatId, beat]));
  const errors = [];
  const blocks = rawBlocks.map((item, index) => {
    const visualBeatIds = textList(item?.visualBeatIds || item?.evidenceIds);
    visualBeatIds.forEach((id) => {
      if (!beatMap.has(id)) errors.push(`Block ${index + 1}: visualBeatId "${id}" chưa được khóa.`);
    });
    if (!visualBeatIds.length) errors.push(`Block ${index + 1}: thiếu visualBeatIds.`);
    return {
      blockId: safeText(item?.blockId || `block_${String(index + 1).padStart(2, "0")}`),
      storyFunction: safeText(item?.storyFunction).toLowerCase(),
      visualBeatIds,
      transitionType: safeText(item?.transitionType || "continuous").toLowerCase(),
      transitionReason: safeText(item?.transitionReason),
      narrativeGoal: safeText(item?.narrativeGoal),
      preserveCausalOrder: item?.preserveCausalOrder !== false
    };
  });
  if (!/hook/.test(blocks[0]?.storyFunction || "")) errors.push("Block đầu tiên phải là Hook.");
  if (!blocks.some((block) => /payoff|result|reveal|finish/.test(block.storyFunction))) errors.push("Blueprint thiếu block payoff/thành phẩm.");
  const schemaVersion = Math.max(1, safeNumber(payload?.schemaVersion, 1));
  const storyAngle = safeText(payload?.storyAngle || "failure_to_success");
  if (storyAngle === "gemini_auto_story") {
    if (!safeText(payload?.sourceStoryTheme || processMap?.sourceStoryTheme)) errors.push("Profile tự động thiếu sourceStoryTheme của câu chuyện gốc.");
    if (!safeText(payload?.adaptedStoryConcept || payload?.storyConcept)) errors.push("Profile tự động thiếu adaptedStoryConcept cho câu chuyện mới.");
    if (textList(payload?.adaptedStoryArc || payload?.storyArc).length < 3) errors.push("Profile tự động cần adaptedStoryArc có ít nhất 3 nhịp truyện.");
  }
  const rawStorySpine = payload?.storySpine || payload?.story_spine || {};
  const storySpine = {
    premise: normalizeStorySpineEntry(rawStorySpine?.premise),
    humanWant: normalizeStorySpineEntry(rawStorySpine?.humanWant || rawStorySpine?.human_want),
    stakes: normalizeStorySpineEntry(rawStorySpine?.stakes),
    centralStruggle: normalizeStorySpineEntry(rawStorySpine?.centralStruggle || rawStorySpine?.central_struggle),
    turningPoint: normalizeStorySpineEntry(rawStorySpine?.turningPoint || rawStorySpine?.turning_point),
    emotionalPayoff: normalizeStorySpineEntry(rawStorySpine?.emotionalPayoff || rawStorySpine?.emotional_payoff),
    endingMeaning: normalizeStorySpineEntry(rawStorySpine?.endingMeaning || rawStorySpine?.ending_meaning)
  };
  const requiredSpineEntries = ["premise", "humanWant", "stakes", "centralStruggle", "turningPoint", "endingMeaning"];
  if (schemaVersion >= 2) {
    requiredSpineEntries.forEach((key) => {
      if (!storySpine[key].text) errors.push(`storySpine.${key} không được để trống trong schema v2.`);
    });
  }
  Object.entries(storySpine).forEach(([key, entry]) => {
    if (!entry.text) return;
    if (!["source_evidence", "creative_overlay"].includes(entry.grounding)) {
      errors.push(`storySpine.${key}.grounding phải là source_evidence hoặc creative_overlay.`);
    }
    if (!entry.evidenceBeatIds.length) errors.push(`storySpine.${key} thiếu evidenceBeatIds.`);
    entry.evidenceBeatIds.forEach((beatId) => {
      if (!beatMap.has(beatId)) errors.push(`storySpine.${key}: evidenceBeatId "${beatId}" chưa được khóa.`);
    });
  });
  if (storySpine.emotionalPayoff.text && storySpine.emotionalPayoff.grounding !== "source_evidence") {
    errors.push("storySpine.emotionalPayoff chỉ được dùng source_evidence; không được tạo payoff cảm xúc bằng creative_overlay.");
  }
  if (storySpine.emotionalPayoff.text) {
    const hasVerifiedPersonalPayoff = storySpine.emotionalPayoff.evidenceBeatIds.some((beatId) => beatMap.get(beatId)?.personalPayoffEvidence?.length);
    if (!hasVerifiedPersonalPayoff) errors.push("storySpine.emotionalPayoff không có personalPayoffEvidence timestamped hỗ trợ.");
  }
  const rawInformationGap = payload?.informationGap || payload?.information_gap || {};
  const informationGap = {
    hookStatement: safeText(rawInformationGap?.hookStatement || rawInformationGap?.hook_statement),
    withheldCause: safeText(rawInformationGap?.withheldCause || rawInformationGap?.withheld_cause),
    revealAtBlockId: safeText(rawInformationGap?.revealAtBlockId || rawInformationGap?.reveal_at_block_id),
    forbiddenTermsBeforeReveal: textList(rawInformationGap?.forbiddenTermsBeforeReveal || rawInformationGap?.forbidden_terms_before_reveal),
    payoffVisualBeatIds: textList(rawInformationGap?.payoffVisualBeatIds || rawInformationGap?.payoff_visual_beat_ids)
  };
  const hasInformationGap = Object.values(informationGap).some((value) => Array.isArray(value) ? value.length : Boolean(value));
  if (hasInformationGap) {
    const revealBlockIndex = blocks.findIndex((block) => block.blockId === informationGap.revealAtBlockId);
    if (!informationGap.hookStatement) errors.push("informationGap thiếu hookStatement.");
    if (!informationGap.withheldCause) errors.push("informationGap thiếu withheldCause.");
    if (revealBlockIndex < 1) errors.push("informationGap.revealAtBlockId phải trỏ tới một block hợp lệ nằm sau Hook.");
    if (!informationGap.forbiddenTermsBeforeReveal.length) errors.push("informationGap thiếu forbiddenTermsBeforeReveal để tool kiểm tra lộ twist sớm.");
    const hookText = informationGap.hookStatement.toLowerCase();
    const leakedTerms = informationGap.forbiddenTermsBeforeReveal.filter((term) => hookText.includes(term.toLowerCase()));
    if (leakedTerms.length) errors.push(`Hook làm lộ nguyên nhân bị giấu qua từ khóa: ${leakedTerms.join(", ")}.`);
  }
  const bodyOrder = new Map();
  blocks.slice(1).forEach((block, blockIndex) => block.visualBeatIds.forEach((id) => bodyOrder.set(id, blockIndex)));
  for (const beat of processMap?.visualBeats || []) {
    for (const dependencyId of beat.requiredBefore || []) {
      if (bodyOrder.has(beat.visualBeatId) && bodyOrder.has(dependencyId)
        && bodyOrder.get(dependencyId) > bodyOrder.get(beat.visualBeatId)) {
        errors.push(`${beat.visualBeatId} xuất hiện trước dependency ${dependencyId} trong phần thân.`);
      }
    }
  }
  if (errors.length) throw new Error(`${sourceName}: ${errors.join(" | ")}`);
  return {
    artifactType: "diy_story_blueprint",
    schemaVersion,
    storyAngle,
    sourceStoryTheme: safeText(payload?.sourceStoryTheme || processMap?.sourceStoryTheme),
    adaptedStoryConcept: safeText(payload?.adaptedStoryConcept || payload?.storyConcept),
    adaptedStoryArc: textList(payload?.adaptedStoryArc || payload?.storyArc),
    adaptationBoundaries: textList(payload?.adaptationBoundaries),
    titleDirection: safeText(payload?.titleDirection),
    narrativePromise: safeText(payload?.narrativePromise),
    storySpine,
    informationGap,
    hookVisualBeatIds: textList(payload?.hookVisualBeatIds || blocks[0]?.visualBeatIds),
    blocks
  };
}

function buildDiyVoiceScriptPrompt({ blueprint, processMap, manifest, basePrompt = "" }) {
  const isAutoStory = safeText(blueprint?.storyAngle).toLowerCase() === "gemini_auto_story";
  return `${buildGeminiInputAccessGate({
    stage: "diy_voice_locked_script",
    requiredInputs: ["locked DIY Story Blueprint", "locked Visual Process Map", "scene-manifest summary", "voice calibration parameters"]
  })}

USER TASK INSTRUCTION - DIY VOICE-LOCKED SCRIPT

Write exactly one final DIY Story Remix script from the locked blueprint and visual facts. The local tool will render it with the user's selected voice and measure real TTS duration.

VOICE AND VISUAL RULES:
1. Every segment must reference one locked visualBeatId as evidenceId and copy its exact sceneId/source range or use a narrower range inside it.
2. ${isAutoStory ? "Narration must tell the adaptedStoryConcept as one connected story. Each story sentence must be assigned to a visually compatible transformation beat; do not turn it back into step-by-step DIY description." : "Narration must tell the locked storySpine as one connected story and remain compatible with the assigned visual beat."}
3. Follow blueprint block order. The Hook may flash forward; the body must preserve physical dependencies.
4. Use concise, connected storytelling rather than isolated descriptions. Each line must lead naturally into the next block.
5. Use audio_mode="voiceover_only" for narration. It mutes source speech completely.
6. A short audio_mode="original_audio" beat is allowed only for a verified satisfying operation sound with no source speech; voiceover_text must then be empty.
7. Keep narration inside the dynamic measured voice budget in USER VOICE CALIBRATION. Target 88%-98% coverage. The local measured TTS duration is authoritative.
8. Prefer 4-10 second narration beats. Split a long thought only at a natural sentence boundary and never split one visible operation into confusing fragments.
9. startSec/endSec are derived output timestamps. Finalize source ranges and playbackSpeed first, then calculate a contiguous output timeline from zero.
10. caption must stay empty. preview_vi is Vietnamese preview text only and is never spoken or exported as a caption.
11. Do not claim an effect, material, measurement, cost, elapsed time, failure, success, or motivation unless present in the locked facts.
${isAutoStory ? "12. Preserve the same subject, emotional trajectory and adaptedStoryArc chosen in the Blueprint. Creative story details must stay generalized and must never masquerade as concrete facts about the real people or build shown on screen." : ""}
13. INFORMATION GAP LOCK: Follow blueprint.informationGap exactly. Before revealAtBlockId, do not use any forbiddenTermsBeforeReveal or disclose the withheldCause through a synonym. Reveal it naturally at or after the designated block, then resolve the Hook promise by the payoff.
14. SHOW, DON'T TELL: If the image already makes an action obvious, voiceover MUST NOT merely name that action. Every voiced segment must add one thing the viewer cannot get from the frame alone: hidden context, stakes, emotion supported by evidence, contradiction, anticipation, transition logic, technical clarity that is genuinely necessary, or payoff meaning.
15. Every segment must set narrativePurpose to exactly one allowed value: hidden_context, stakes, emotion, contradiction, anticipation, transition, payoff_meaning, technical_clarity, or satisfying_sound. Do not use technical_clarity as a disguise for repetitive step-by-step narration.
16. TUTORIAL LANGUAGE BAN: Avoid chains such as "First I... Then I... Next I... After that I... Finally I...". A sequence of operations is not a story. Connect lines through cause, risk, choice, reversal and consequence.
17. TONALITY: Use grounded, authentic and warm DIY language with toneProfile="authentic_warm_diy" and toneIntensity between 0.25 and 0.60. Avoid cinematic, militaristic or inflated wording such as fortress, violently, brutally, forging destiny or industrial warfare. Do not replace those phrases with invented claims such as days of work, sweat, freezing weather or family stakes unless timestamped evidence supports them.
18. VISUAL HARMONY: Set visualClaimType for every segment. completed_result requires artifactState near_complete/complete; human_payoff requires artifactState human_payoff plus personalPayoffEvidence. Claims about lights, clean finishes, installed windows or first use require matching visibleCompletionEvidence in that exact beat. If no compatible beat exists, rewrite the voice claim instead of forcing a mismatched visual.
19. DELIVERY PLAN: Set one deliveryProfile per voiced segment. Use mystery_hook for a curiosity secret, urgent_hook only for fast visible action, warm_story for reflective context, process_energy for energetic progress, and intimate_payoff for a verified personal payoff. speechRateMultiplier must remain 0.85-1.12. A deliberate internal pause may use pauseAfterPhrase and pauseDurationMs=150-600; the phrase must appear verbatim in voiceover_text. Do not use punctuation as a substitute for a real pause.

${buildDiyStoryProfileFewShot(safeText(blueprint?.storyAngle).toLowerCase())}

OUTPUT CONTRACT:
- Return exactly one valid JSON object inside one json Markdown code block, with no prose before or after it.
- Save it as diy-story-remix.json.
- Root artifactType must be "highlight_cut_script", workflow must be "diy_story_remix", and segments must be non-empty.
- voiceover_text, preview_vi, action_notes, title and every other string must contain natural content only. Never append [cite: N], footnotes or source-reference tokens.

SCHEMA:
{
  "artifactType": "highlight_cut_script",
  "schemaVersion": 2,
  "workflow": "diy_story_remix",
  "title": "Truthful curiosity title",
  "language": "en",
  "sourceLanguage": "auto",
  "style": "DIY Story Remix",
  "toneProfile": "authentic_warm_diy",
  "toneIntensity": 0.4,
  "story_angle": "${blueprint?.storyAngle || "gemini_auto_story"}",
  "total_target_sec": 60,
  "story_blueprint": ${JSON.stringify(blueprint, null, 2)},
  "segments": [{
    "id": "diy_0001",
    "segmentId": "diy_0001",
    "evidenceId": "beat_0008",
    "visualBeatId": "beat_0008",
    "sceneId": "scene_0008",
    "macroBlockId": "block_01",
    "sourceStartSec": 40,
    "sourceEndSec": 46,
    "startSec": 0,
    "endSec": 6,
    "playbackSpeed": 1,
    "storyFunction": "hook",
    "narrativePurpose": "anticipation",
    "visualClaimType": "neutral",
    "deliveryProfile": "mystery_hook",
    "speechRateMultiplier": 0.92,
    "pauseAfterPhrase": "secret",
    "pauseDurationMs": 350,
    "emphasisWords": ["secret"],
    "transitionReason": "Flash-forward to the visible failure before returning to the initial state",
    "audio_mode": "voiceover_only",
    "voiceover_text": "One mistake nearly ruined the entire build.",
    "caption": "",
    "preview_vi": "Một sai lầm gần như phá hỏng toàn bộ công trình.",
    "action_notes": "Keep the complete visible operation"
  }]
}

LOCKED DIY STORY BLUEPRINT:
${JSON.stringify(blueprint || {}, null, 2)}

LOCKED VISUAL PROCESS MAP:
${JSON.stringify(processMap || {}, null, 2)}

LOCKED SOURCE SCENE MANIFEST:
${JSON.stringify(manifest || {}, null, 2)}

USER VOICE CALIBRATION AND STORY SETTINGS:
${basePrompt || "No extra settings were supplied. Use concise natural English narration."}`;
}

function evaluateDiyNarrationQuality(script, processMap) {
  const beatMap = new Map((processMap?.visualBeats || processMap?.evidence || []).map((beat) => [beat.visualBeatId || beat.evidenceId, beat]));
  const voicedSegments = (script?.segments || []).filter((segment) => {
    const audioMode = safeText(segment?.audio_mode || segment?.audioMode || "voiceover_only").toLowerCase();
    return audioMode !== "original_audio" && safeText(segment?.voiceover_text || segment?.voiceoverText || segment?.text);
  });
  const tutorialOpeners = /^(first(?:ly)?|then|next|after that|afterwards|once (?:that|the|it)|from there|finally|now (?:i|we)|i then|we then)\b/i;
  const tutorialSegments = [];
  const redundantSegments = [];
  const missingPurposeSegments = [];
  const overDramaticSegments = [];
  const purposeCounts = new Map();
  voicedSegments.forEach((segment, index) => {
    const text = safeText(segment?.voiceover_text || segment?.voiceoverText || segment?.text);
    const purpose = safeText(segment?.narrativePurpose || segment?.narrative_purpose).toLowerCase();
    const beatId = safeText(segment?.visualBeatId || segment?.evidenceId);
    const beat = beatMap.get(beatId) || {};
    const visibleDescription = [beat.visibleAction, ...(beat.visualFacts || []), beat.stateBefore, beat.stateAfter].filter(Boolean).join(" ");
    if (tutorialOpeners.test(text)) tutorialSegments.push(index + 1);
    if (contentTokens(text).size >= 4 && tokenOverlap(text, visibleDescription) >= 0.55) redundantSegments.push(index + 1);
    if (!purpose || !DIY_NARRATIVE_PURPOSES.has(purpose)) missingPurposeSegments.push(index + 1);
    if (/\b(fortress|violently|brutally|warfare|battle[- ]?ready|forging (?:our |my |their )?(?:destiny|future|boundaries)|industrial labor|industrial labour|against all odds|changed everything forever)\b/i.test(text)) {
      overDramaticSegments.push(index + 1);
    }
    if (purpose) purposeCounts.set(purpose, (purposeCounts.get(purpose) || 0) + 1);
  });
  const warnings = [];
  let score = 100;
  const tutorialRatio = tutorialSegments.length / Math.max(1, voicedSegments.length);
  const redundancyRatio = redundantSegments.length / Math.max(1, voicedSegments.length);
  const technicalRatio = (purposeCounts.get("technical_clarity") || 0) / Math.max(1, voicedSegments.length);
  const valueAddPurposes = ["hidden_context", "stakes", "emotion", "contradiction", "anticipation", "payoff_meaning"]
    .reduce((sum, purpose) => sum + (purposeCounts.get(purpose) || 0), 0);
  if (missingPurposeSegments.length) {
    score -= Math.min(25, missingPurposeSegments.length * 5);
    warnings.push(`Thiếu narrativePurpose hợp lệ ở đoạn ${missingPurposeSegments.join(", ")}.`);
  }
  if (tutorialSegments.length >= 2 && tutorialRatio >= 0.35) {
    score -= 25;
    warnings.push(`Phát hiện lời kể kiểu tutorial ở ${Math.round(tutorialRatio * 100)}% đoạn voice (${tutorialSegments.join(", ")}); hãy thay chuỗi First/Then/Next bằng nguyên nhân, rủi ro và hệ quả.`);
  }
  if (redundantSegments.length >= 2 && redundancyRatio >= 0.3) {
    score -= 25;
    warnings.push(`Show, Don't Tell chưa đạt: đoạn ${redundantSegments.join(", ")} có nội dung trùng mạnh với hành động đã nhìn thấy.`);
  }
  if (technicalRatio > 0.4) {
    score -= 15;
    warnings.push(`${Math.round(technicalRatio * 100)}% voice dùng technical_clarity; kịch bản có nguy cơ trở thành hướng dẫn thao tác.`);
  }
  if (voicedSegments.length >= 3 && valueAddPurposes < Math.ceil(voicedSegments.length * 0.5)) {
    score -= 15;
    warnings.push("Chưa đủ câu voice tạo giá trị kể chuyện như stakes, anticipation, contradiction, emotion hoặc payoff meaning.");
  }
  if (overDramaticSegments.length) {
    score -= Math.min(20, overDramaticSegments.length * 7);
    warnings.push(`Tone DIY bị cường điệu ở đoạn ${overDramaticSegments.join(", ")}; hãy dùng ngôn ngữ đời thường, ấm áp và cụ thể hơn.`);
  }
  return {
    passed: score >= 75,
    score: Math.max(0, score),
    warnings,
    metrics: {
      voicedSegmentCount: voicedSegments.length,
      tutorialSegmentCount: tutorialSegments.length,
      tutorialRatio,
      redundantSegmentCount: redundantSegments.length,
      redundancyRatio,
      technicalClarityRatio: technicalRatio,
      overDramaticSegmentCount: overDramaticSegments.length,
      narrativePurposeCounts: Object.fromEntries(purposeCounts)
    }
  };
}

function validateDiyFinalScript(script, processMap, blueprint) {
  if (safeText(script?.workflow) !== "diy_story_remix") {
    throw new Error('DIY Story Remix JSON phải có workflow="diy_story_remix".');
  }
  const segments = Array.isArray(script?.segments) ? script.segments : [];
  if (!segments.length) throw new Error("DIY Story Remix JSON thiếu mảng segments có dữ liệu.");
  const beatMap = new Map((processMap?.visualBeats || processMap?.evidence || []).map((beat) => [beat.visualBeatId || beat.evidenceId, beat]));
  const blueprintBlocks = blueprint?.blocks || [];
  const blockMap = new Map(blueprintBlocks.map((block, index) => [block.blockId, index]));
  const blockBeatMap = new Map(blueprintBlocks.map((block) => [block.blockId, new Set(block.visualBeatIds || [])]));
  const informationGap = blueprint?.informationGap || {};
  const revealBlockIndex = blockMap.get(safeText(informationGap?.revealAtBlockId));
  const forbiddenTermsBeforeReveal = textList(informationGap?.forbiddenTermsBeforeReveal).map((term) => term.toLowerCase());
  const errors = [];
  const warnings = [];
  const schemaVersion = Math.max(1, safeNumber(script?.schemaVersion, 1));
  const toneProfile = safeText(script?.toneProfile || script?.tone_profile).toLowerCase();
  const toneIntensity = safeNumber(script?.toneIntensity ?? script?.tone_intensity, NaN);
  if (schemaVersion >= 2 && toneProfile !== "authentic_warm_diy") {
    errors.push('toneProfile phải là "authentic_warm_diy" trong DIY Story Remix schema v2.');
  }
  if (schemaVersion >= 2 && (!Number.isFinite(toneIntensity) || toneIntensity < 0.25 || toneIntensity > 0.6)) {
    errors.push("toneIntensity phải nằm trong khoảng 0.25-0.60.");
  }
  const bodyPosition = new Map();
  const placedBeatsByBlock = new Map();
  let previousBlockIndex = -1;
  segments.forEach((segment, index) => {
    const beatId = safeText(segment?.visualBeatId || segment?.evidenceId);
    const beat = beatMap.get(beatId);
    const storyFunction = safeText(segment?.storyFunction || segment?.scene_type).toLowerCase();
    const audioMode = safeText(segment?.audio_mode || segment?.audioMode || "voiceover_only").toLowerCase();
    const voiceText = safeText(segment?.voiceover_text || segment?.voiceoverText || segment?.text);
    const narrativePurpose = safeText(segment?.narrativePurpose || segment?.narrative_purpose).toLowerCase();
    const visualClaimType = safeText(segment?.visualClaimType || segment?.visual_claim_type || "neutral").toLowerCase();
    const deliveryProfile = safeText(segment?.deliveryProfile || segment?.delivery_profile || "natural").toLowerCase();
    const speechRateMultiplier = safeNumber(segment?.speechRateMultiplier ?? segment?.speech_rate_multiplier, 1);
    const pauseAfterPhrase = safeText(segment?.pauseAfterPhrase || segment?.pause_after_phrase);
    const pauseDurationMs = safeNumber(segment?.pauseDurationMs ?? segment?.pause_duration_ms, 0);
    if (!beat) errors.push(`Segment ${index + 1}: visualBeatId/evidenceId "${beatId || "(trống)"}" chưa được khóa.`);
    if (audioMode === "original_audio" && beat?.sourceSpeechPresent) {
      errors.push(`Segment ${index + 1} (${beatId}): không được giữ âm gốc vì Process Map xác nhận có lời nói nguồn.`);
    }
    if (audioMode === "original_audio" && voiceText) errors.push(`Segment ${index + 1}: original_audio phải có voiceover_text rỗng.`);
    if (audioMode !== "original_audio" && !voiceText) errors.push(`Segment ${index + 1}: voiceover_only thiếu voiceover_text.`);
    if (schemaVersion >= 2 && audioMode !== "original_audio" && !DIY_NARRATIVE_PURPOSES.has(narrativePurpose)) {
      errors.push(`Segment ${index + 1}: narrativePurpose không hợp lệ hoặc bị thiếu.`);
    }
    if (schemaVersion >= 2 && audioMode === "original_audio" && narrativePurpose && narrativePurpose !== "satisfying_sound") {
      errors.push(`Segment ${index + 1}: original_audio chỉ được dùng narrativePurpose="satisfying_sound".`);
    }
    if (schemaVersion >= 2 && !DIY_VISUAL_CLAIM_TYPES.has(visualClaimType)) {
      errors.push(`Segment ${index + 1}: visualClaimType không hợp lệ hoặc bị thiếu.`);
    }
    if (schemaVersion >= 2 && !DIY_DELIVERY_PROFILES.has(deliveryProfile)) {
      errors.push(`Segment ${index + 1}: deliveryProfile không hợp lệ hoặc bị thiếu.`);
    }
    if (schemaVersion >= 2 && (speechRateMultiplier < 0.85 || speechRateMultiplier > 1.12)) {
      errors.push(`Segment ${index + 1}: speechRateMultiplier phải nằm trong khoảng 0.85-1.12.`);
    }
    if (pauseAfterPhrase && !voiceText.toLowerCase().includes(pauseAfterPhrase.toLowerCase())) {
      errors.push(`Segment ${index + 1}: pauseAfterPhrase không xuất hiện trong voiceover_text.`);
    }
    if (pauseDurationMs && (pauseDurationMs < 150 || pauseDurationMs > 600)) {
      errors.push(`Segment ${index + 1}: pauseDurationMs phải nằm trong khoảng 150-600ms.`);
    }
    if (visualClaimType === "completed_result" && !["near_complete", "complete"].includes(beat?.artifactState)) {
      errors.push(`Segment ${index + 1}: completed_result đang map vào ${beatId} có artifactState=${beat?.artifactState || "không rõ"}.`);
    }
    if (visualClaimType === "human_payoff" && (beat?.artifactState !== "human_payoff" || !beat?.personalPayoffEvidence?.length)) {
      errors.push(`Segment ${index + 1}: human_payoff không có personalPayoffEvidence phù hợp tại ${beatId}.`);
    }
    if (/\b(light|lights)\b.*\b(on|lit|illuminat|switch)/i.test(voiceText)) {
      const completionEvidence = (beat?.visibleCompletionEvidence || []).join(" ");
      if (!/\b(light|lights|lamp|led)\b/i.test(completionEvidence) || !/\b(on|lit|illuminat|switch|glow)\b/i.test(completionEvidence)) {
        errors.push(`Segment ${index + 1}: voice nói đèn đã sáng nhưng ${beatId} không có visibleCompletionEvidence tương ứng.`);
      }
    }
    if (/\b(propos(?:e|ed|al|ing)|marry|engaged|ring)\b/i.test(voiceText)) {
      const payoffEvidence = beat?.personalPayoffEvidence || [];
      if (!payoffEvidence.some((item) => item.payoffType === "proposal" || /\b(propos|marry|ring|engag)/i.test(`${item.observedSignal} ${item.supportedMeaning}`))) {
        errors.push(`Segment ${index + 1}: claim cầu hôn/nhẫn không có personalPayoffEvidence tại ${beatId}.`);
      }
    }
    if (safeText(segment?.caption)) errors.push(`Segment ${index + 1}: caption phải để trống; preview_vi chỉ dùng ở màn preview.`);
    const blockId = safeText(segment?.macroBlockId);
    const currentBlockIndex = blockMap.get(blockId);
    if (Number.isInteger(revealBlockIndex) && Number.isInteger(currentBlockIndex) && currentBlockIndex < revealBlockIndex && voiceText) {
      const normalizedVoiceText = voiceText.toLowerCase();
      const leakedTerms = forbiddenTermsBeforeReveal.filter((term) => normalizedVoiceText.includes(term));
      if (leakedTerms.length) {
        errors.push(`Segment ${index + 1}: làm lộ Information Gap trước ${informationGap.revealAtBlockId} qua từ khóa ${leakedTerms.join(", ")}.`);
      }
    }
    if (blockMap.size && !blockMap.has(blockId)) errors.push(`Segment ${index + 1}: macroBlockId "${blockId || "(trống)"}" không tồn tại trong blueprint.`);
    if (blockBeatMap.has(blockId) && !blockBeatMap.get(blockId).has(beatId)) {
      errors.push(`Segment ${index + 1}: ${beatId} không thuộc ${blockId} trong blueprint đã khóa.`);
    }
    if (blockId && beatId) {
      if (!placedBeatsByBlock.has(blockId)) placedBeatsByBlock.set(blockId, new Set());
      placedBeatsByBlock.get(blockId).add(beatId);
    }
    if (!/hook/.test(storyFunction)) {
      if (!bodyPosition.has(beatId)) bodyPosition.set(beatId, index);
      const blockIndex = blockMap.get(blockId);
      if (Number.isInteger(blockIndex) && blockIndex < previousBlockIndex) {
        errors.push(`Segment ${index + 1}: macro-block bị đảo ngược so với blueprint.`);
      }
      if (Number.isInteger(blockIndex)) previousBlockIndex = Math.max(previousBlockIndex, blockIndex);
    }
  });
  for (const beat of beatMap.values()) {
    for (const dependencyId of beat.requiredBefore || []) {
      if (bodyPosition.has(beat.visualBeatId) && bodyPosition.has(dependencyId)
        && bodyPosition.get(dependencyId) > bodyPosition.get(beat.visualBeatId)) {
        errors.push(`${beat.visualBeatId} xuất hiện trước dependency ${dependencyId} trong phần thân.`);
      }
    }
  }
  blueprintBlocks.forEach((block) => {
    const placed = placedBeatsByBlock.get(block.blockId) || new Set();
    const missing = (block.visualBeatIds || []).filter((beatId) => !placed.has(beatId));
    if (missing.length) warnings.push(`${block.blockId} đã lược bỏ visual beat không bắt buộc: ${missing.join(", ")}. Hãy kiểm tra preview để chắc chắn mạch thao tác vẫn dễ hiểu.`);
  });
  if (errors.length) throw new Error(`DIY Story Remix JSON chưa đạt final gate: ${errors.join(" | ")}`);
  const narrationQuality = evaluateDiyNarrationQuality(script, processMap);
  if (!narrationQuality.passed) {
    warnings.push(`DIY narration quality ${narrationQuality.score}/100 chưa đạt: ${narrationQuality.warnings.join(" | ")}`);
  } else {
    warnings.push(...narrationQuality.warnings);
  }
  script._diyNarrationQuality = narrationQuality;
  script._toolValidationWarnings = [...new Set([
    ...(Array.isArray(script._toolValidationWarnings) ? script._toolValidationWarnings : []),
    ...warnings
  ])];
  return script;
}

module.exports = {
  buildDiyBlueprintPrompt,
  buildDiyProcessMapPrompt,
  buildDiyVoiceScriptPrompt,
  evaluateDiyProcessMapQuality,
  evaluateDiyNarrationQuality,
  validateDiyBlueprint,
  validateDiyFinalScript,
  validateDiyProcessMap
};
