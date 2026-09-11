const accessFailureProperties = {
  artifactType: { type: "string" },
  stage: { type: "string" },
  accessGranted: { type: "boolean" },
  missingInputs: { type: "array", items: { type: "string" } },
  mismatchDetails: { type: "string" },
  recommendedAction: { type: "string" }
};

const canonicalAnalysisSchema = {
  type: "object",
  required: ["inputAccessAudit", "videoSummary", "storyType", "mainConflict", "characters", "events", "causalLinks", "mandatoryFacts", "mandatoryResolutions", "hookCandidates", "boringSegments", "uncertainFacts"],
  properties: {
    ...accessFailureProperties,
    inputAccessAudit: {
      type: "object",
      required: ["accessGranted", "inspectedInputs"],
      properties: {
        accessGranted: { type: "boolean" },
        inspectedInputs: { type: "array", items: { type: "string" } },
        timelineCoverageStartSec: { type: "number" },
        timelineCoverageEndSec: { type: "number" },
        verificationNote: { type: "string" }
      }
    },
    videoSummary: { type: "string" },
    storyType: { type: "string" },
    mainConflict: { type: "string" },
    characters: { type: "array", items: { type: "object" } },
    timeline: { type: "array", items: { type: "object" } },
    events: { type: "array", minItems: 1, items: { type: "object" } },
    causalLinks: { type: "array", items: { type: "object" } },
    mandatoryFacts: { type: "array", items: { type: "object" } },
    mandatoryResolutions: { type: "array", items: { type: "object" } },
    hookCandidates: { type: "array", items: { type: "object" } },
    visualPayoffs: { type: "array", items: { type: "object" } },
    dialoguePayoffs: { type: "array", items: { type: "object" } },
    boringSegments: { type: "array", items: { type: "object" } },
    uncertainFacts: { type: "array", items: { type: "object" } }
  }
};

const canonicalTimestampRepairSchema = {
  type: "object",
  required: ["events"],
  properties: {
    events: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["eventId", "start", "end"],
        properties: {
          eventId: { type: "string" },
          start: { type: "number" },
          end: { type: "number" }
        }
      }
    }
  }
};

const canonicalChunkSchema = {
  type: "object",
  required: ["inputAccessAudit", "events"],
  properties: {
    inputAccessAudit: {
      type: "object",
      required: ["accessGranted", "inspectedInputs"],
      properties: {
        accessGranted: { type: "boolean" },
        inspectedInputs: { type: "array", items: { type: "string" } }
      }
    },
    events: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["eventId", "start", "end", "title", "description", "participants", "eventType", "storyRoleCandidates", "visualEvidence", "audioEvidence", "dialogue", "requiresContext", "spoils", "confidence", "sourceNarratorPresent", "informationGain"],
        properties: {
          eventId: { type: "string" },
          start: { type: "number" },
          end: { type: "number" },
          title: { type: "string" },
          description: { type: "string" },
          participants: { type: "array", items: { type: "string" } },
          eventType: { type: "string" },
          storyRoleCandidates: { type: "array", items: { type: "string" } },
          visualEvidence: { type: "string" },
          audioEvidence: { type: "string" },
          dialogue: { type: "string" },
          requiresContext: { type: "boolean" },
          spoils: { type: "boolean" },
          confidence: { type: "number" },
          sourceNarratorPresent: { type: "boolean" },
          informationGain: { type: "number" }
        }
      }
    }
  }
};

const canonicalRootSummarySchema = {
  type: "object",
  required: ["inputAccessAudit", "videoSummary", "storyType", "mainConflict", "characters", "causalLinks", "mandatoryFacts", "mandatoryResolutions", "hookCandidates", "boringSegments", "uncertainFacts"],
  properties: {
    inputAccessAudit: canonicalAnalysisSchema.properties.inputAccessAudit,
    videoSummary: { type: "string" },
    storyType: { type: "string" },
    mainConflict: { type: "string" },
    characters: { type: "array", items: { type: "object" } },
    causalLinks: { type: "array", items: { type: "object" } },
    mandatoryFacts: { type: "array", items: { type: "object" } },
    mandatoryResolutions: { type: "array", items: { type: "object" } },
    hookCandidates: { type: "array", items: { type: "object" } },
    visualPayoffs: { type: "array", items: { type: "object" } },
    dialoguePayoffs: { type: "array", items: { type: "object" } },
    boringSegments: { type: "array", items: { type: "object" } },
    uncertainFacts: { type: "array", items: { type: "object" } }
  }
};

const eventScoresSchema = {
  type: "object",
  properties: {
    ...accessFailureProperties,
    inputAccessAudit: { type: "object" },
    scores: { type: "array", minItems: 1, items: { type: "object" } }
  }
};

const storyCandidatesSchema = {
  type: "object",
  properties: {
    ...accessFailureProperties,
    inputAccessAudit: { type: "object" },
    candidates: { type: "array", minItems: 1, items: { type: "object" } }
  }
};

const lockedStoriesSchema = {
  type: "object",
  properties: {
    ...accessFailureProperties,
    inputAccessAudit: { type: "object" },
    capacityWarning: { type: "string" },
    lockedStories: { type: "array", minItems: 1, items: { type: "object" } }
  }
};

const finalEdlSchema = {
  type: "object",
  properties: {
    ...accessFailureProperties,
    inputAccessAudit: { type: "object" },
    scripts: { type: "array", minItems: 1, items: { type: "object" } }
  }
};

const finalAuditSchema = {
  type: "object",
  properties: {
    ...accessFailureProperties,
    inputAccessAudit: { type: "object" },
    verdict: { type: "string", enum: ["PASS", "MINOR_REVISE", "MAJOR_REVISE"] },
    score: { type: "number" },
    issues: { type: "array", items: { type: "object" } },
    revisionScope: { type: "string" }
  }
};

module.exports = {
  canonicalAnalysisSchema,
  canonicalTimestampRepairSchema,
  canonicalChunkSchema,
  canonicalRootSummarySchema,
  eventScoresSchema,
  storyCandidatesSchema,
  lockedStoriesSchema,
  finalEdlSchema,
  finalAuditSchema
};
