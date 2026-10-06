const fs = require("fs/promises");
const path = require("path");

const CONFLICT_KEYWORDS = [
  // Refusal & Barricade
  { pattern: /\b(?:not|won'?t|refuse|never)\s+opening\b/i, weight: 1.0, type: "physical_friction", desc: "Refusal to open or comply" },
  { pattern: /\b(?:open|kick|break|smash)\s+(?:the|this|that)\s+door\b/i, weight: 0.95, type: "physical_friction", desc: "Door breach / barricade confrontation" },
  { pattern: /\b(?:step|get)\s+out\s+of\s+the\s+(?:car|vehicle|house)\b/i, weight: 0.9, type: "in_medias_res", desc: "High-stakes command to exit" },
  { pattern: /\b(?:drop|put\s+down)\s+(?:the\s+)?(?:weapon|gun|knife)\b/i, weight: 1.0, type: "in_medias_res", desc: "Lethal threat / weapon drawn" },
  { pattern: /\b(?:hands\s+up|show\s+me\s+your\s+hands|don'?t\s+move|freeze)\b/i, weight: 0.9, type: "in_medias_res", desc: "Direct standoff command" },
  
  // Shocking Discovery & Questions
  { pattern: /\bwhy\s+is\s+there\s+(?:a\s+)?(?:child|baby|body|gun|corpse|knife|blood|drugs?|cash|money)\b/i, weight: 1.0, type: "shocking_discovery", desc: "Shocking discovery question" },
  { pattern: /\bin\s+the\s+trunk\b/i, weight: 0.95, type: "shocking_discovery", desc: "Trunk / hidden compartment discovery" },
  { pattern: /\bwhose\s+(?:is\s+this|are\s+these|gun|knife|car|bag)\b/i, weight: 0.85, type: "shocking_discovery", desc: "Incriminating evidence inquiry" },
  { pattern: /\bis\s+that\s+(?:a\s+)?(?:gun|knife|blood|bomb|body)\b/i, weight: 0.95, type: "shocking_discovery", desc: "Alarming observation" },

  // Absurd Contradictions & Excuses
  { pattern: /\bthat'?s\s+not\s+(?:mine|my\s+child|my\s+car|my\s+gun|my\s+bag)\b/i, weight: 0.95, type: "absurd_contradiction", desc: "Blatant or absurd denial" },
  { pattern: /\bi\s+(?:didn'?t|never)\s+(?:do|touch|have|see|shoot|steal)\b/i, weight: 0.8, type: "absurd_contradiction", desc: "Immediate defensive denial" },
  { pattern: /\bi\s+am\s+(?:the\s+)?(?:sheriff|police|judge|attorney|mayor|owner)\b/i, weight: 0.9, type: "absurd_contradiction", desc: "Audacious entitlement claim" },
  { pattern: /\bdo\s+you\s+know\s+who\s+i\s+am\b/i, weight: 0.95, type: "absurd_contradiction", desc: "Entitlement / arrogant challenge" },

  // Vocal Escalation & Tension
  { pattern: /\b(?:taser|tase\s+him|shots?\s+fired|code\s+3)\b/i, weight: 0.95, type: "in_medias_res", desc: "Police tactical escalation" },
  { pattern: /\b(?:get\s+away\s+from\s+me|don'?t\s+touch\s+me|leave\s+me\s+alone)\b/i, weight: 0.85, type: "dialogue_conflict", desc: "Defiant vocal struggle" },
  { pattern: /\b(?:shut\s+up|shut\s+the\s+fuck\s+up|fuck\s+you|get\s+lost)\b/i, weight: 0.8, type: "dialogue_conflict", desc: "Heated verbal profanity / hostility" }
];

function parseSrtTimestamp(value = "") {
  const parts = String(value || "").trim().split(":");
  if (parts.length < 2) return 0;
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (parts.length === 3) {
    hours = Number(parts[0]) || 0;
    minutes = Number(parts[1]) || 0;
    seconds = Number(String(parts[2]).replace(",", ".")) || 0;
  } else {
    minutes = Number(parts[0]) || 0;
    seconds = Number(String(parts[1]).replace(",", ".")) || 0;
  }
  return Math.max(0, hours * 3600 + minutes * 60 + seconds);
}

function parseSrtCues(text = "") {
  const normalized = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const cues = [];
  blocks.forEach((block, index) => {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const timeLineIndex = lines.findIndex((l) => l.includes("-->"));
    if (timeLineIndex === -1) return;
    const [startRaw, endRaw] = lines[timeLineIndex].split("-->").map((s) => s.trim());
    const startSec = parseSrtTimestamp(startRaw);
    const endSec = parseSrtTimestamp(endRaw);
    const dialogueLines = lines.slice(timeLineIndex + 1);
    const textContent = dialogueLines.join(" ").replace(/<[^>]+>/g, "").trim();
    if (endSec > startSec && textContent) {
      cues.push({
        id: `cue_${String(index + 1).padStart(4, "0")}`,
        startSec: Number(startSec.toFixed(3)),
        endSec: Number(endSec.toFixed(3)),
        text: textContent
      });
    }
  });
  return cues;
}

function findDialogueCandidates(cues = [], durationSec = 0) {
  const matches = [];
  cues.forEach((cue) => {
    let bestWeight = 0;
    let matchedPattern = null;
    for (const kw of CONFLICT_KEYWORDS) {
      if (kw.pattern.test(cue.text)) {
        if (kw.weight > bestWeight) {
          bestWeight = kw.weight;
          matchedPattern = kw;
        }
      }
    }
    if (matchedPattern) {
      matches.push({
        cue,
        weight: bestWeight,
        type: matchedPattern.type,
        desc: matchedPattern.desc
      });
    }
  });

  // Group adjacent matching cues into windows of 8-16 seconds
  const regions = [];
  let currentGroup = null;

  matches.forEach((m) => {
    if (!currentGroup) {
      currentGroup = {
        startSec: Math.max(0, m.cue.startSec - 1.5),
        endSec: Math.min(durationSec || 99999, m.cue.endSec + 3.0),
        cues: [m.cue],
        types: [m.type],
        maxWeight: m.weight,
        descriptions: [m.desc]
      };
      return;
    }

    if (m.cue.startSec <= currentGroup.endSec + 4.0 && (m.cue.endSec - currentGroup.startSec) <= 20) {
      currentGroup.endSec = Math.min(durationSec || 99999, m.cue.endSec + 2.5);
      currentGroup.cues.push(m.cue);
      if (!currentGroup.types.includes(m.type)) currentGroup.types.push(m.type);
      if (m.weight > currentGroup.maxWeight) currentGroup.maxWeight = m.weight;
      if (!currentGroup.descriptions.includes(m.desc)) currentGroup.descriptions.push(m.desc);
    } else {
      regions.push(currentGroup);
      currentGroup = {
        startSec: Math.max(0, m.cue.startSec - 1.5),
        endSec: Math.min(durationSec || 99999, m.cue.endSec + 3.0),
        cues: [m.cue],
        types: [m.type],
        maxWeight: m.weight,
        descriptions: [m.desc]
      };
    }
  });
  if (currentGroup) regions.push(currentGroup);

  return regions.map((r, i) => {
    const fullText = r.cues.map((c) => c.text).join(" ");
    return {
      candidateId: `dialogue_hook_${String(i + 1).padStart(3, "0")}`,
      sourceStartSec: Number(r.startSec.toFixed(3)),
      sourceEndSec: Number(r.endSec.toFixed(3)),
      durationSec: Number((r.endSec - r.startSec).toFixed(3)),
      triggerType: r.types[0] || "dialogue_conflict",
      description: r.descriptions.join("; "),
      keyDialogue: fullText,
      semanticWeight: r.maxWeight,
      source: "transcript_semantic"
    };
  });
}

function mineHookCandidateRegions({
  transcriptCues = [],
  actionCandidates = [],
  manifest = {},
  durationSec = 0,
  maxCandidates = 25
} = {}) {
  const duration = Math.max(0, Number(durationSec || manifest?.videoDurationSec || 0));
  const dialogueHits = findDialogueCandidates(transcriptCues, duration);

  const actionHits = (actionCandidates || []).map((ac, idx) => {
    const motion = Number(ac.motionScore || 0);
    const audio = Number(ac.audioEnergyScore || 0);
    const isBarricadeOrStandOff = motion >= 6.5 || (motion >= 5.0 && audio >= 5.0);
    return {
      candidateId: `action_hook_${String(idx + 1).padStart(3, "0")}`,
      sourceStartSec: Number(ac.sourceStartSec || 0),
      sourceEndSec: Number(ac.sourceEndSec || 0),
      durationSec: Number((ac.sourceEndSec - ac.sourceStartSec).toFixed(3)),
      triggerType: isBarricadeOrStandOff ? "physical_friction" : "in_medias_res",
      description: isBarricadeOrStandOff
        ? "Physical friction / barricade struggle / high kinetic movement"
        : "Action radar alert with high audio / motion intensity",
      motionScore: motion,
      audioEnergyScore: audio,
      actionPriority: Number(ac.actionPriorityScore || 0),
      source: "action_candidates"
    };
  });

  // Combine and deduplicate overlapping regions (within 4 seconds of each other)
  const combined = [];
  const allRaw = [...dialogueHits, ...actionHits].sort((a, b) => a.sourceStartSec - b.sourceStartSec);

  allRaw.forEach((item) => {
    const existing = combined.find((c) => {
      const overlapStart = Math.max(c.sourceStartSec, item.sourceStartSec);
      const overlapEnd = Math.min(c.sourceEndSec, item.sourceEndSec);
      return overlapEnd > overlapStart || Math.abs(c.sourceStartSec - item.sourceStartSec) <= 4.0;
    });

    if (existing) {
      // Merge into hybrid
      existing.sourceStartSec = Number(Math.min(existing.sourceStartSec, item.sourceStartSec).toFixed(3));
      existing.sourceEndSec = Number(Math.max(existing.sourceEndSec, item.sourceEndSec).toFixed(3));
      existing.durationSec = Number((existing.sourceEndSec - existing.sourceStartSec).toFixed(3));
      if (item.source === "transcript_semantic") {
        existing.keyDialogue = item.keyDialogue || existing.keyDialogue;
        existing.semanticWeight = Math.max(existing.semanticWeight || 0, item.semanticWeight || 0);
      }
      if (item.source === "action_candidates") {
        existing.motionScore = Math.max(existing.motionScore || 0, item.motionScore || 0);
        existing.audioEnergyScore = Math.max(existing.audioEnergyScore || 0, item.audioEnergyScore || 0);
      }
      existing.triggerType = existing.keyDialogue && (existing.motionScore > 4 || existing.audioEnergyScore > 4)
        ? "hybrid"
        : (item.triggerType || existing.triggerType);
      existing.description = `${existing.description} + ${item.description}`;
    } else {
      combined.push({ ...item });
    }
  });

  // If candidate is too long (> 22s), constrain to the punchiest 12-16s
  const normalized = combined.map((item, idx) => {
    let start = item.sourceStartSec;
    let end = item.sourceEndSec;
    if (end - start > 22) {
      end = start + 18;
    }
    const dur = Number((end - start).toFixed(3));
    
    // Heuristic multi-dimension scores (0-100)
    const visual = Math.min(100, Math.round(((item.motionScore || 5.0) / 10) * 100));
    const dialogue = item.keyDialogue ? Math.min(100, Math.round((item.semanticWeight || 0.8) * 100)) : 40;
    const conflict = Math.min(100, Math.round((visual * 0.45) + (dialogue * 0.55)));
    
    const isIncriminating = /child|trunk|gun|knife|weapon|blood|drugs?|body|corpse/i.test(item.keyDialogue || "");
    const curiosity = isIncriminating ? 95 : (item.keyDialogue && /why|what|how/i.test(item.keyDialogue) ? 80 : 65);
    
    // Penalize routine maintenance / friendly tire change dialogue lacking urgent threat or confrontation
    const isRoutineMaintenance = /tire|spare|lug\s*nut|wrench|jack/i.test(item.keyDialogue || "") && !/refus|run|flee|drop|hands|gun|knife|tase|hit|crash|smash/i.test(item.keyDialogue || "");
    const maintenancePenalty = isRoutineMaintenance ? 35 : 0;
    
    // Spoiler penalty: if the candidate is in the last 15% of the video, it's likely aftermath/booking/charges
    const isLateInVideo = duration > 0 && start >= duration * 0.85;
    const spoilerRisk = isLateInVideo ? 80 : 15;
    const payoffPotential = 85;

    const overallScore = Math.max(10, Math.min(99, Math.round(
      visual * 0.25 + conflict * 0.25 + curiosity * 0.25 + dialogue * 0.15 + payoffPotential * 0.10 - spoilerRisk * 0.20 - maintenancePenalty
    )));

    return {
      candidateId: `candidate_${String(idx + 1).padStart(3, "0")}`,
      sourceStartSec: start,
      sourceEndSec: end,
      durationSec: dur,
      archetype: mapTriggerToArchetype(item.triggerType, item.keyDialogue),
      triggerType: item.triggerType,
      coreEventDescription: item.description,
      keyDialogue: item.keyDialogue || "",
      scores: {
        overall: overallScore,
        visual_immediacy: visual,
        conflict,
        curiosity_gap: curiosity,
        dialogue_strength: dialogue,
        spoiler_risk: spoilerRisk,
        payoff_potential: payoffPotential
      }
    };
  });

  // Rank by overall score descending, take top maxCandidates
  return normalized
    .sort((a, b) => b.scores.overall - a.scores.overall)
    .slice(0, Math.max(5, maxCandidates));
}

function mapTriggerToArchetype(triggerType = "", keyDialogue = "") {
  const dialogueLower = String(keyDialogue || "").toLowerCase();
  if (triggerType === "physical_friction" || /door|barricade|rattle|force/i.test(dialogueLower)) {
    return "Physical Friction / Barricade Suspense";
  }
  if (triggerType === "absurd_contradiction" || /not\s+mine|never\s+happened|sheriff|mayor|who\s+i\s+am/i.test(dialogueLower)) {
    return "The Absurd Contradiction";
  }
  if (/child|trunk|knife|gun|blood|what\s+is\s+this/i.test(dialogueLower)) {
    return "Revelation / Shocking Discovery";
  }
  if (triggerType === "in_medias_res" || /drop|freeze|taser|shots/i.test(dialogueLower)) {
    return "In Medias Res";
  }
  if (triggerType === "dialogue_conflict") {
    return "Dialogue Conflict";
  }
  return "High Stakes Altercation";
}

module.exports = {
  CONFLICT_KEYWORDS,
  parseSrtCues,
  findDialogueCandidates,
  mineHookCandidateRegions,
  mapTriggerToArchetype
};
