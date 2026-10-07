"use strict";

// Phase-aware fake for the `agy` CLI used by Stage 1 tests. It inspects the
// --print prompt, emits realistic stream-json step_update events (view_file
// calls with AbsolutePath) and returns the envelope for that phase.

const { EventEmitter } = require("events");
const { PassThrough, Writable } = require("stream");

function buildUnderstanding(durationSec = 20) {
  const step = durationSec / 10;
  const event = (index, eventType, summary, extra = {}) => ({
    eventId: `e${String(index + 1).padStart(2, "0")}`,
    sourceStartSec: Number((index * step).toFixed(3)),
    sourceEndSec: Number(((index + 1) * step).toFixed(3)),
    sceneIds: ["scene_0001"],
    eventType,
    summary,
    visualFacts: ["Bodycam view of the doorway."],
    dialogueFacts: [{ sourceSec: Number((index * step + 0.5).toFixed(3)), speaker: "Officer A", quote: "Open the door!" }],
    sourceNarratorPresent: false,
    storyImportance: 60 + index,
    ...extra
  });
  const timeline = [
    event(0, "arrival", "Officers arrive at the house."),
    event(1, "confrontation", "Resident shouts through the door."),
    event(2, "confrontation", "Officers force the door open."),
    event(3, "escalation", "Resident resists."),
    event(4, "interrogation", "Officers question the resident."),
    event(5, "lie", "Resident claims nothing happened."),
    event(6, "evidence", "Victim's account contradicts the resident."),
    event(7, "climax", "Resident is restrained."),
    event(8, "arrest", "Resident is handcuffed."),
    event(9, "consequence", "Resident is placed in the patrol car.")
  ];
  const candidate = (index, why) => ({ eventId: timeline[index].eventId, sourceStartSec: timeline[index].sourceStartSec, sourceEndSec: timeline[index].sourceEndSec, why });
  return {
    artifactType: "source_understanding",
    schemaVersion: 2,
    videoDurationSec: durationSec,
    caseSummary: "Officers respond to a disturbance call and confront a resident.",
    centralConflict: "The resident refuses to explain why the victim was locked inside.",
    centralViewerQuestion: "Will the officers uncover what happened inside the house?",
    characters: [{ id: "c1", nameOrRole: "Officer A", description: "Bodycam officer" }, { id: "c2", nameOrRole: "Resident", description: "Suspect" }],
    storyTimeline: timeline,
    hookCandidates: [candidate(1, "Shouting at the door")],
    confrontationCandidates: [candidate(2, "Door forced")],
    interrogationCandidates: [candidate(4, "Questioning")],
    climaxCandidates: [candidate(7, "Restraint")],
    resolutionCandidates: [{ ...candidate(8, "Arrest"), verified: true }]
  };
}

function buildScript(scriptId, { start = 0, end = 6 } = {}) {
  return {
    artifactType: "highlight_cut_script",
    schemaVersion: 1,
    scriptId,
    title: `Script ${scriptId}`,
    segments: [{
      id: `highlight_${scriptId}_001`,
      sceneId: "scene_0001",
      sourceStartSec: start,
      sourceEndSec: end,
      audio_mode: "original_audio",
      voiceover_text: ""
    }]
  };
}

function buildSeriesPlan(durationSec = 20) {
  const third = durationSec / 3;
  return {
    artifactType: "series_plan",
    schemaVersion: 1,
    centralViewerQuestion: "Will the officers uncover what happened inside?",
    hookPromise: "A shouting standoff at the door.",
    parts: [
      { scriptId: 1, partNumber: 1, partBadge: "PART 1", scope: "Confrontation", hookRange: { sourceStartSec: 1, sourceEndSec: 4 },
        sceneAllocation: [{ sourceStartSec: 0, sourceEndSec: third, purpose: "confrontation" }], mustNotReveal: ["arrest"],
        cliffhanger: "The resident refuses to answer.", cliffhangerRange: { sourceStartSec: third - 1, sourceEndSec: third } },
      { scriptId: 3, partNumber: 2, partBadge: "PART 2", scope: "Interrogation", hookRange: { sourceStartSec: third, sourceEndSec: third + 1 },
        sceneAllocation: [{ sourceStartSec: third, sourceEndSec: 2 * third, purpose: "interrogation" }], mustNotReveal: ["arrest"],
        cliffhanger: "A contradiction surfaces.", cliffhangerRange: { sourceStartSec: 2 * third - 1, sourceEndSec: 2 * third } },
      { scriptId: 4, partNumber: 3, partBadge: "PART 3", scope: "Verdict", hookRange: { sourceStartSec: 2 * third, sourceEndSec: 2 * third + 1 },
        sceneAllocation: [{ sourceStartSec: 2 * third, sourceEndSec: durationSec, purpose: "arrest" }], mustNotReveal: [],
        payoff: "The resident is arrested.", payoffRanges: [{ sourceStartSec: durationSec - 3, sourceEndSec: durationSec }] }
    ],
    sharedRanges: [],
    duplicatePrevention: "Each Part owns its own ranges."
  };
}

function classifyPrompt(prompt = "") {
  if (prompt.includes("Phase A (Source Understanding)")) return "phase_a";
  if (prompt.includes("You have already inspected 100% of the required source proxy videos.")) return "phase_a_repair";
  if (prompt.includes("MANDATORY VIDEO COVERAGE GATE FAILED")) return "phase_a_coverage_retry";
  if (prompt.includes("Phase B1 (Series Plan)")) return "series_plan";
  if (prompt.includes("series plan was rejected")) return "series_plan_repair";
  if (prompt.includes("Phase B (Script Generation)")) return "phase_b";
  return "other";
}

/**
 * options.respond(kind, prompt, call) -> { viewFiles?: string[], envelope?: object, rawResult?: string }
 */
/**
 * options.respond(kind, prompt, call) -> {
 *   viewFiles?: string[],          // DONE view_file steps (each preceded by an ACTIVE event)
 *   envelope?: object, rawResult?: string,
 *   omitResult?: boolean,          // e.g. print timeout before serialization
 *   extraEvents?: object[],        // additional raw stream events (before the result)
 *   stderr?: string, exitCode?: number
 * }
 * Lines are emitted one by one; a kill() stops emission immediately, which is
 * how the real CLI behaves when the host terminates it.
 */
function createPhaseAwareSpawn({ calls, respond }) {
  let conversationCounter = 0;
  return (command, args, options) => {
    const printArg = args.find((arg) => arg.startsWith("--print=")) || "";
    const prompt = printArg.slice("--print=".length);
    const kind = classifyPrompt(prompt);
    const conversationIndex = args.indexOf("--conversation");
    const conversationId = conversationIndex >= 0 ? args[conversationIndex + 1] : `conv-${++conversationCounter}`;
    const call = { command, args, options, prompt, kind, conversationId, resumed: conversationIndex >= 0, killed: false, emittedViews: 0 };
    calls.push(call);
    const response = respond(kind, prompt, call) || {};
    const child = new EventEmitter();
    child.pid = 40000 + calls.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    let closed = false;
    const close = (code) => {
      if (closed) return;
      closed = true;
      child.stdout.end();
      child.stderr.end();
      child.emit("close", code);
    };
    child.stdin.on("finish", () => {
      const lines = [JSON.stringify({ event: "init", conversation_id: conversationId, init: { conversation_id: conversationId } })];
      let stepIndex = 0;
      for (const file of response.viewFiles || []) {
        stepIndex += 1;
        const toolInfo = { name: "view_file", parameters: { AbsolutePath: file } };
        lines.push({ marker: "view", line: JSON.stringify({ event: "step_update", step_update: { conversation_id: conversationId, step_index: stepIndex, state: "ACTIVE", step_type: "tool", tool_name: "view_file", tool_info: toolInfo } }) });
        lines.push(JSON.stringify({ event: "step_update", step_update: { conversation_id: conversationId, step_index: stepIndex, state: "DONE", step_type: "tool", tool_name: "view_file", duration_seconds: 3, tool_info: toolInfo } }));
      }
      lines.push(JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: conversationId, step_index: 100, state: "DONE", step_type: "agent_response",
          duration_seconds: 2, usage: { input_tokens: 1000, output_tokens: 200, thinking_tokens: 50, cache_read_tokens: 0 }
        }
      }));
      for (const event of response.extraEvents || []) lines.push(JSON.stringify(event));
      if (!response.omitResult) {
        lines.push(JSON.stringify({
          event: "result",
          result: response.rawResult !== undefined ? response.rawResult : JSON.stringify(response.envelope || {})
        }));
      }
      const emitNext = (index) => {
        if (call.killed || closed) return;
        if (index >= lines.length) {
          if (response.stderr) child.stderr.write(response.stderr);
          setImmediate(() => close(response.exitCode ?? 0));
          return;
        }
        const entry = lines[index];
        if (typeof entry === "object") call.emittedViews += 1;
        child.stdout.write(`${typeof entry === "object" ? entry.line : entry}\n`);
        setImmediate(() => emitNext(index + 1));
      };
      setImmediate(() => emitNext(0));
    });
    child.kill = () => {
      call.killed = true;
      setImmediate(() => close(1));
    };
    return child;
  };
}

function proxyPathsFromPrompt(prompt = "") {
  return [...prompt.matchAll(/view_file\("([^"]+\.mp4)"\)/g)].map((match) => match[1]);
}

function contextPathsFromPrompt(prompt = "") {
  return [...prompt.matchAll(/view_file\("([^"]+phase-a-context\.txt)"/g)].map((match) => match[1]);
}

/** Default happy-path responder. */
function defaultResponder({ durationSec = 20, scriptIds = [1, 3, 4], phaseBViewFiles = [] } = {}) {
  return (kind, prompt) => {
    if (kind === "phase_a" || kind === "phase_a_coverage_retry") {
      return {
        viewFiles: [...proxyPathsFromPrompt(prompt), ...contextPathsFromPrompt(prompt)],
        envelope: { artifacts: [{ filename: "source-understanding.json", script: buildUnderstanding(durationSec) }] }
      };
    }
    if (kind === "phase_a_repair") {
      return { envelope: { artifacts: [{ filename: "source-understanding.json", script: buildUnderstanding(durationSec) }] } };
    }
    if (kind === "series_plan" || kind === "series_plan_repair") {
      return { envelope: { artifacts: [{ filename: "series-plan.json", script: buildSeriesPlan(durationSec) }] } };
    }
    if (kind === "phase_b") {
      const third = durationSec / 3;
      const ranges = { 1: { start: 0.5, end: third - 0.5 }, 3: { start: third + 0.5, end: 2 * third - 0.5 }, 4: { start: 2 * third + 0.5, end: durationSec - 0.5 } };
      return {
        viewFiles: phaseBViewFiles,
        envelope: { artifacts: scriptIds.map((id) => ({ filename: `script-${id}.json`, script: buildScript(id, ranges[id] || {}) })) }
      };
    }
    return { envelope: {} };
  };
}

module.exports = {
  buildUnderstanding,
  buildScript,
  buildSeriesPlan,
  createPhaseAwareSpawn,
  defaultResponder,
  proxyPathsFromPrompt,
  contextPathsFromPrompt
};
