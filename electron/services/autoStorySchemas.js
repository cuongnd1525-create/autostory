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
    characters: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "name", "role", "description"],
        properties: { id: { type: "string" }, name: { type: "string" }, role: { type: "string" }, description: { type: "string" } }
      }
    },
    timeline: {
      type: "array",
      items: {
        type: "object",
        required: ["start", "end", "description"],
        properties: { start: { type: "number" }, end: { type: "number" }, description: { type: "string" } }
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
    },
    causalLinks: { type: "array", items: { type: "object", required: ["sourceEventId", "targetEventId", "relationType"], properties: { sourceEventId: { type: "string" }, targetEventId: { type: "string" }, relationType: { type: "string" } } } },
    mandatoryFacts: { type: "array", items: { type: "object", required: ["description", "importance"], properties: { description: { type: "string" }, importance: { type: "string" } } } },
    mandatoryResolutions: { type: "array", items: { type: "object", required: ["question", "answer"], properties: { question: { type: "string" }, answer: { type: "string" } } } },
    hookCandidates: { type: "array", items: { type: "object", required: ["eventId", "reason", "category"], properties: { eventId: { type: "string" }, reason: { type: "string" }, category: { type: "string" } } } },
    visualPayoffs: { type: "array", items: { type: "object", required: ["eventId", "description"], properties: { eventId: { type: "string" }, description: { type: "string" } } } },
    dialoguePayoffs: { type: "array", items: { type: "object", required: ["eventId", "dialogue"], properties: { eventId: { type: "string" }, dialogue: { type: "string" } } } },
    boringSegments: { type: "array", items: { type: "object", required: ["start", "end", "reason"], properties: { start: { type: "number" }, end: { type: "number" }, reason: { type: "string" } } } },
    uncertainFacts: { type: "array", items: { type: "object", required: ["description", "confidence"], properties: { description: { type: "string" }, confidence: { type: "number" } } } }
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
    characters: canonicalAnalysisSchema.properties.characters,
    causalLinks: canonicalAnalysisSchema.properties.causalLinks,
    mandatoryFacts: canonicalAnalysisSchema.properties.mandatoryFacts,
    mandatoryResolutions: canonicalAnalysisSchema.properties.mandatoryResolutions,
    hookCandidates: canonicalAnalysisSchema.properties.hookCandidates,
    visualPayoffs: canonicalAnalysisSchema.properties.visualPayoffs,
    dialoguePayoffs: canonicalAnalysisSchema.properties.dialoguePayoffs,
    boringSegments: canonicalAnalysisSchema.properties.boringSegments,
    uncertainFacts: canonicalAnalysisSchema.properties.uncertainFacts
  }
};

const eventScoresSchema = {
  type: "object",
  required: ["inputAccessAudit", "scores"],
  properties: {
    ...accessFailureProperties,
    inputAccessAudit: canonicalAnalysisSchema.properties.inputAccessAudit,
    scores: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["eventId", "hookStrength", "conflict", "visualIntensity", "audioIntensity", "surprise", "emotion", "informationGain", "storyImportance", "payoffValue", "contextDependency", "spoilerRisk", "redundancy", "retentionRisk"],
        properties: {
          eventId: { type: "string" }, hookStrength: { type: "number" }, conflict: { type: "number" }, visualIntensity: { type: "number" }, audioIntensity: { type: "number" }, surprise: { type: "number" }, emotion: { type: "number" }, informationGain: { type: "number" }, storyImportance: { type: "number" }, payoffValue: { type: "number" }, contextDependency: { type: "number" }, spoilerRisk: { type: "number" }, redundancy: { type: "number" }, retentionRisk: { type: "number" }
        }
      }
    }
  }
};

const storyCandidatesSchema = {
  type: "object",
  required: ["inputAccessAudit", "candidates"],
  properties: {
    ...accessFailureProperties,
    inputAccessAudit: canonicalAnalysisSchema.properties.inputAccessAudit,
    candidates: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["candidateId", "strategy", "centralViewerQuestion", "hookPromise", "estimatedDuration", "hook", "sequence", "openQuestions", "resolvedQuestions", "mandatoryEventIds", "optionalEventIds", "forbiddenEventIds", "storyRisks", "diversityReason"],
        properties: {
          candidateId: { type: "string" },
          strategy: { type: "string" },
          centralViewerQuestion: { type: "string" },
          hookPromise: { type: "string" },
          estimatedDuration: { type: "number" },
          hook: { type: "string" },
          sequence: {
            type: "array",
            items: {
              type: "object",
              required: ["storyRole", "eventIds", "informationGain", "causalTransition"],
              properties: { storyRole: { type: "string" }, eventIds: { type: "array", items: { type: "string" } }, informationGain: { type: "number" }, causalTransition: { type: "string" } }
            }
          },
          openQuestions: { type: "array", items: { type: "string" } },
          resolvedQuestions: { type: "array", items: { type: "string" } },
          mandatoryEventIds: { type: "array", items: { type: "string" } },
          optionalEventIds: { type: "array", items: { type: "string" } },
          forbiddenEventIds: { type: "array", items: { type: "string" } },
          storyRisks: { type: "array", items: { type: "string" } },
          diversityReason: { type: "string" }
        }
      }
    }
  }
};

const lockedStoriesSchema = {
  type: "object",
  required: ["inputAccessAudit", "lockedStories"],
  properties: {
    ...accessFailureProperties,
    inputAccessAudit: canonicalAnalysisSchema.properties.inputAccessAudit,
    capacityWarning: { type: "string" },
    lockedStories: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["scriptId", "candidateId", "judgeScore", "reason", "centralViewerQuestion", "hookPromise", "lockedSequence", "mandatoryEvents", "optionalEvents", "forbiddenEvents", "targetDuration", "retentionRisks", "resolutionEventIds"],
        properties: {
          scriptId: { type: "number" },
          candidateId: { type: "string" },
          judgeScore: { type: "number" },
          reason: { type: "string" },
          centralViewerQuestion: { type: "string" },
          hookPromise: { type: "string" },
          lockedSequence: { type: "array", items: { type: "string" } },
          mandatoryEvents: { type: "array", items: { type: "string" } },
          optionalEvents: { type: "array", items: { type: "string" } },
          forbiddenEvents: { type: "array", items: { type: "string" } },
          targetDuration: { type: "number" },
          retentionRisks: { type: "array", items: { type: "string" } },
          resolutionEventIds: { type: "array", items: { type: "string" } }
        }
      }
    }
  }
};

const finalEdlSchema = {
  type: "object",
  required: ["inputAccessAudit", "scripts"],
  properties: {
    ...accessFailureProperties,
    inputAccessAudit: canonicalAnalysisSchema.properties.inputAccessAudit,
    scripts: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["scriptId", "title", "segments"],
        properties: {
          scriptId: { type: "number" },
          title: { type: "string" },
          segments: {
            type: "array",
            items: {
              type: "object",
              required: ["eventId", "start", "end", "narratorText", "audioMode", "emotionTag"],
              properties: {
                eventId: { type: "string" },
                start: { type: "number" },
                end: { type: "number" },
                narratorText: { type: "string" },
                audioMode: { type: "string" },
                emotionTag: { type: "string" }
              }
            }
          }
        }
      }
    }
  }
};

const finalAuditSchema = {
  type: "object",
  required: ["inputAccessAudit", "verdict", "issues"],
  properties: {
    ...accessFailureProperties,
    inputAccessAudit: canonicalAnalysisSchema.properties.inputAccessAudit,
    verdict: { type: "string", enum: ["PASS", "MINOR_REVISE", "MAJOR_REVISE"] },
    score: { type: "number" },
    issues: {
      type: "array",
      items: {
        type: "object",
        required: ["segmentIndex", "issueType", "description"],
        properties: {
          segmentIndex: { type: "number" },
          issueType: { type: "string" },
          description: { type: "string" }
        }
      }
    },
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
