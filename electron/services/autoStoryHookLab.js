const path = require("path");
const fs = require("fs/promises");
const schemas = require("./autoStorySchemas");

async function generateAndSelectHooks(engine, candidates, config) {
  // This will accept candidates, generate multiple variants via vertex AI concurrently, score them using semantic schema, and select best one
  const variantsToGenerate = config?.variants || 3;
  const results = [];
  
  for (const candidate of candidates) {
    const promises = [];
    for (let i = 0; i < variantsToGenerate; i++) {
      promises.push(
        engine.vertex.generateJsonFromFiles({
          filePaths: [],
          prompt: `Generate a hook variant for this candidate: ${JSON.stringify(candidate)}`,
          temperature: 0.7,
          taskType: "quality",
          responseSchema: {
            type: "object",
            properties: {
              hook_text: { type: "string" },
              semantic_score: { type: "number" }
            }
          }
        })
      );
    }
    
    const variants = await Promise.allSettled(promises);
    let bestVariant = null;
    let highestScore = -1;
    
    for (const v of variants) {
      if (v.status === 'fulfilled' && v.value && v.value.semantic_score > highestScore) {
        highestScore = v.value.semantic_score;
        bestVariant = v.value;
      }
    }
    
    results.push({
      candidateId: candidate.candidateId,
      bestHook: bestVariant
    });
  }
  
  return results;
}

module.exports = { generateAndSelectHooks };
