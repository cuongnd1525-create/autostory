const fs = require('fs/promises');
const path = require('path');
const ConfigStore = require('../../electron/services/configStore');
const VertexAiService = require('../../electron/services/vertexAiService');
const ManualAntigravityStage1Service = require('../../electron/services/manualAntigravityStage1Service');

function getRequestedScriptIds(promptText = '') {
  const match = promptText.match(/Required order:\s*([^\n\r]+)/i);
  if (!match) return [1, 3, 4];
  const ids = Array.from(match[1].matchAll(/Script\s*(\d+)/gi), m => Number(m[1]));
  return ids.length ? ids : [1, 3, 4];
}

function buildStage1TransportPrompt(promptText) {
  const scriptIds = getRequestedScriptIds(promptText);
  return [
    promptText,
    "",
    "AUTOMATED PROVIDER TRANSPORT OVERRIDE:",
    "Confirm access by actually inspecting every attached input before writing scripts. Do not infer access from filenames.",
    "Return one JSON object only with this envelope:",
    JSON.stringify({ artifacts: scriptIds.map((id) => ({ filename: `script-${id}.json`, script: {} })), notes: "" }),
    `Each script object must follow the REQUIRED ROOT SCHEMA in the editorial prompt. Return exactly ${scriptIds.length} requested script${scriptIds.length === 1 ? "" : "s"}. Do not return prose or Markdown.`
  ].join("\n");
}

async function main() {
  console.log('=== STARTING EXPERIMENT C EXECUTION VIA VERTEX AI ===');
  const cfgPath = path.join(process.env.APPDATA, 'cineviral-studio', 'config.json');
  const cs = new ConfigStore(cfgPath, 'D:\\OutputVideo');
  await cs.ensureLoaded();
  const settings = cs.getSettings();

  console.log('Using model:', settings.vertexAnalysisModel || 'gemini-3.8-flash');
  console.log('Project ID:', settings.vertexProjectId);
  console.log('Credentials:', settings.vertexCredentialPath);

  const baselineRunInfo = JSON.parse(await fs.readFile(path.join(__dirname, 'baseline-B', 'configured-ai-run-info.json'), 'utf8'));

  // Filter out hook-contract.json from input files
  const inputFiles = baselineRunInfo.inputFiles.filter(f => !f.toLowerCase().includes('hook-contract.json'));
  console.log('Input files count:', inputFiles.length);
  for (const f of inputFiles) {
    console.log(' -', path.basename(f));
  }

  const promptCText = await fs.readFile(path.join(__dirname, 'prompt_C.txt'), 'utf8');
  const finalPrompt = buildStage1TransportPrompt(promptCText);

  const vertex = new VertexAiService(settings);
  console.log('Starting Vertex AI request (this may take 40-70 seconds)...');
  const startedAt = Date.now();

  const response = await vertex.generateJsonFromFiles({
    filePaths: inputFiles,
    prompt: finalPrompt,
    temperature: 0.18,
    taskType: 'stage1',
    onProgress: (p) => {
      console.log(`[Progress ${p.percent}%] ${p.message}`);
    }
  });

  const elapsedMs = Date.now() - startedAt;
  console.log(`Vertex AI call finished in ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log('Usage:', vertex.lastUsage);
  console.log('Timings:', vertex.lastTimings);

  // Save raw response
  await fs.writeFile(path.join(__dirname, 'C-raw-response.json'), JSON.stringify(response, null, 2), 'utf8');

  // Parse envelope
  const envelope = ManualAntigravityStage1Service.findArtifactEnvelope(response);
  if (!envelope || !envelope.artifacts || !envelope.artifacts.length) {
    console.error('Failed to parse artifact envelope from response!');
    console.log('Response keys:', Object.keys(response));
    return;
  }

  console.log(`Found ${envelope.artifacts.length} artifacts in envelope.`);
  const cScriptsDir = path.join(__dirname, 'C-scripts');
  await fs.mkdir(cScriptsDir, { recursive: true });

  const parsedScripts = {};
  for (const art of envelope.artifacts) {
    const filename = art.filename || `script-${art.script?.scriptId || 'unknown'}.json`;
    const script = art.script || art;
    const scriptId = script.scriptId || (filename.match(/script-(\d+)/) ? Number(filename.match(/script-(\d+)/)[1]) : null);
    await fs.writeFile(path.join(cScriptsDir, filename), JSON.stringify(script, null, 2), 'utf8');
    parsedScripts[scriptId] = script;
    console.log(`Saved ${filename} (scriptId: ${scriptId}, beats: ${script.narrativeBeats?.length || script.segments?.length || 0})`);
  }

  // Construct structured C-no-auto-hook-contract.json
  const resultPayload = {
    experiment: 'C',
    name: 'Pipeline Without Automatic Hook Contract',
    status: 'VERIFIED_EXECUTED',
    executedAt: new Date().toISOString(),
    executionTelemetry: {
      provider: 'vertex_ai',
      model: settings.vertexAnalysisModel || 'gemini-3.8-flash',
      elapsedMs,
      usage: vertex.lastUsage,
      timings: vertex.lastTimings,
      inputFiles: inputFiles.map(f => path.basename(f))
    },
    promptDelta: {
      diffFile: 'prompt-diff-B-vs-C.diff',
      description: 'Removed lines 14-40 (the bogus "Barricaded door" SERIES HOOK CONTRACT block). Retained all other rules, schema constraints, and 3-part requirement.'
    },
    scripts: parsedScripts
  };

  await fs.writeFile(path.join(__dirname, 'C-no-auto-hook-contract.json'), JSON.stringify(resultPayload, null, 2), 'utf8');
  console.log('Successfully written C-no-auto-hook-contract.json');
}

main().catch(err => {
  console.error('Error executing Experiment C:', err);
  process.exit(1);
});
