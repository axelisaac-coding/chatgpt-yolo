((root, factory) => {
  const Shared = typeof module === "object" && module.exports ? require("./shared.js") : root.YOLOShared;
  const api = factory(Shared);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YOLOCommands = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (Shared) => {
  "use strict";

  const MAX_OBJECTIVE_LENGTH = 4000;
  const MAX_ITERATIONS = 50;
  const DEFAULT_MAX_ITERATIONS = 12;
  const GOAL_MAX_ITERATIONS = 0;
  const WORKFLOW_SCHEMA_VERSION = 3;
  const SUPERVISOR_LIMITS = Object.freeze({ repeatedResponses: 2, noProgressResponses: 3, recoveryAttempts: 3, verificationAttempts: 2 });
  const WORKFLOW_STATUSES = new Set(["idle", "running", "paused", "stalled", "rate_limited", "human_required", "completed", "blocked"]);
  const WORKFLOW_KINDS = new Set(["goal", "loop"]);
  const STANDALONE_MARKER_RE = /(?:^|\n)[ \t]*\[YOLO:(CONTINUE|DONE|BLOCKED)\][ \t]*(?=\n|$)/gi;
  const TERMINAL_MARKER_RE = /(?:^|\n)[ \t]*\[YOLO:(CONTINUE|DONE|BLOCKED)\][ \t]*$/i;
  const PROGRESS_MARKER_RE = /(?:^|\n)[ \t]*\[YOLO:(?:PROGRESS:([^\]\r\n]{1,160})|(NO_PROGRESS))\][ \t]*(?=\n|$)/gi;

  const COMMANDS = Object.freeze([
    Object.freeze({ name: "goal", title: "Goal", description: "Start a persistent marker-driven objective that can continue while meaningful work remains.", args: "objective", group: "Automated workflows", kind: "workflow" }),
    Object.freeze({ name: "loop", title: "Loop", description: "Run bounded, marker-driven iterations toward one objective.", args: "[iterations] objective", group: "Automated workflows", kind: "workflow" }),
    Object.freeze({ name: "plan", title: "Plan", description: "Queue a prompt asking ChatGPT to produce an execution plan.", args: "objective", group: "Prompt shortcuts", kind: "prompt" }),
    Object.freeze({ name: "review", title: "Review", description: "Queue an adversarial review prompt for the current work or scope.", args: "[scope]", group: "Prompt shortcuts", kind: "prompt" }),
    Object.freeze({ name: "fix", title: "Fix", description: "Queue a prompt asking ChatGPT to diagnose, repair, and validate work.", args: "[scope]", group: "Prompt shortcuts", kind: "prompt" }),
    Object.freeze({ name: "handoff", title: "Handoff", description: "Ask ChatGPT to write a continuation brief; this does not compact ChatGPT context.", args: "[focus]", group: "Prompt shortcuts", kind: "prompt" }),
    Object.freeze({ name: "continue", title: "Continue", description: "Queue a prompt to continue the current task, optionally with a direction.", args: "[direction]", group: "Prompt shortcuts", kind: "prompt" }),
    Object.freeze({ name: "status", title: "Status", description: "Show YOLO workflow, queue, generation, limits, and last-action state.", args: "", group: "YOLO controls", kind: "control" }),
    Object.freeze({ name: "pause", title: "Pause", description: "Pause the active YOLO goal or loop without deleting it.", args: "", group: "YOLO controls", kind: "control" }),
    Object.freeze({ name: "resume", title: "Resume", description: "Resume the active paused or blocked YOLO workflow.", args: "", group: "YOLO controls", kind: "control" }),
    Object.freeze({ name: "stop", title: "Stop", description: "Stop and clear the active YOLO goal or loop after confirmation.", args: "", group: "YOLO controls", kind: "control" }),
    Object.freeze({ name: "settings", title: "Settings", description: "Open YOLO Advanced settings.", args: "", group: "YOLO controls", kind: "control" }),
    Object.freeze({ name: "help", title: "Help", description: "Open the YOLO action palette and reference.", args: "", group: "YOLO controls", kind: "control" })
  ]);

  const COMMAND_BY_NAME = new Map(COMMANDS.map((command) => [command.name, command]));

  const cleanText = (value, max = MAX_OBJECTIVE_LENGTH) => String(value ?? "").trim().slice(0, max);
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const makeId = Shared.makeId;

  function command(name) {
    return COMMAND_BY_NAME.get(String(name || "").toLowerCase()) || null;
  }

  function filterCommands(query = "") {
    const needle = cleanText(query, 120).replace(/^\//, "").toLowerCase();
    if (!needle) return [...COMMANDS];
    return COMMANDS
      .map((entry) => {
        const name = entry.name.toLowerCase();
        const title = entry.title.toLowerCase();
        const description = entry.description.toLowerCase();
        let score = 0;
        if (name === needle) score += 100;
        if (name.startsWith(needle)) score += 60;
        if (title.startsWith(needle)) score += 40;
        if (name.includes(needle)) score += 25;
        if (description.includes(needle)) score += 10;
        return { entry, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
      .map(({ entry }) => entry);
  }

  function parseInvocation(input) {
    const text = String(input || "").trim();
    const match = text.match(/^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i);
    if (!match) return null;
    const entry = command(match[1]);
    if (!entry) return null;
    return { command: entry, args: cleanText(match[2] || "") };
  }

  function parseLoopArgs(input) {
    const text = cleanText(input);
    const match = text.match(/^(\d{1,3})\s+([\s\S]+)$/);
    if (!match) return { objective: text, maxIterations: DEFAULT_MAX_ITERATIONS };
    return {
      objective: cleanText(match[2]),
      maxIterations: clamp(Math.round(Number(match[1])), 1, MAX_ITERATIONS)
    };
  }

  function fingerprint(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${value.length}:${(hash >>> 0).toString(36)}`;
  }

  function freshSupervisorState() {
    return {
      repeatedResponseCount: 0,
      noProgressCount: 0,
      recoveryAttempts: 0,
      verificationPending: false,
      verificationAttempts: 0,
      verificationClaimFingerprint: "",
      lastResponseFingerprint: "",
      lastProgressFingerprint: "",
      lastProgressAt: 0,
      lastRecoveryAt: 0,
      lastVerificationAt: 0,
      recoveryReason: "",
      verificationReason: ""
    };
  }

  function normalizeSupervisorState(raw = {}) {
    const fallback = freshSupervisorState();
    if (!raw || typeof raw !== "object") return fallback;
    return {
      repeatedResponseCount: Math.max(0, Math.round(finite(raw.repeatedResponseCount, 0))),
      noProgressCount: Math.max(0, Math.round(finite(raw.noProgressCount, 0))),
      recoveryAttempts: Math.max(0, Math.round(finite(raw.recoveryAttempts, 0))),
      verificationPending: Boolean(raw.verificationPending),
      verificationAttempts: Math.max(0, Math.round(finite(raw.verificationAttempts, 0))),
      verificationClaimFingerprint: cleanText(raw.verificationClaimFingerprint, 180),
      lastResponseFingerprint: cleanText(raw.lastResponseFingerprint, 180),
      lastProgressFingerprint: cleanText(raw.lastProgressFingerprint, 180),
      lastProgressAt: Math.max(0, finite(raw.lastProgressAt, 0)),
      lastRecoveryAt: Math.max(0, finite(raw.lastRecoveryAt, 0)),
      lastVerificationAt: Math.max(0, finite(raw.lastVerificationAt, 0)),
      recoveryReason: cleanText(raw.recoveryReason, 500),
      verificationReason: cleanText(raw.verificationReason, 500)
    };
  }

  function observeSupervisorState(raw, observation = {}, at = Date.now()) {
    const state = normalizeSupervisorState(raw);
    const responseFingerprint = cleanText(observation.responseFingerprint, 180);
    if (responseFingerprint) {
      state.repeatedResponseCount = responseFingerprint === state.lastResponseFingerprint
        ? state.repeatedResponseCount + 1
        : 0;
      state.lastResponseFingerprint = responseFingerprint;
    }
    if (observation.progressed === true) {
      state.noProgressCount = 0;
      state.lastProgressAt = at;
      state.lastProgressFingerprint = cleanText(observation.progressFingerprint || responseFingerprint, 180);
      state.recoveryAttempts = 0;
      state.recoveryReason = "";
    } else if (observation.progressed === false) {
      state.noProgressCount += 1;
    }
    if (observation.recoveryResolved) {
      state.recoveryAttempts = 0;
      state.recoveryReason = "";
    }
    if (observation.recoveryAttempted) {
      state.recoveryAttempts += 1;
      state.lastRecoveryAt = at;
      state.recoveryReason = cleanText(observation.recoveryReason, 500);
    }
    if (observation.verificationResolved) {
      state.verificationPending = false;
      state.verificationAttempts = 0;
      state.verificationClaimFingerprint = "";
      state.verificationReason = "";
    }
    if (observation.verificationStarted) {
      state.verificationPending = true;
      state.verificationAttempts += 1;
      state.lastVerificationAt = at;
      state.verificationClaimFingerprint = cleanText(observation.verificationClaimFingerprint, 180);
      state.verificationReason = cleanText(observation.verificationReason, 500);
    }
    return state;
  }

  function supervisorDisposition(raw, limits = SUPERVISOR_LIMITS) {
    const state = normalizeSupervisorState(raw);
    if (state.repeatedResponseCount >= limits.repeatedResponses) {
      return { action: "stalled", reason: "Repeated assistant responses exceeded the safety threshold", code: "supervisor.stalled.repeated_response" };
    }
    if (state.noProgressCount >= limits.noProgressResponses) {
      return { action: "stalled", reason: "No-progress observations exceeded the safety threshold", code: "supervisor.stalled.no_progress" };
    }
    if (state.recoveryAttempts >= limits.recoveryAttempts) {
      return { action: "stalled", reason: "Recovery attempts exceeded the safety threshold", code: "supervisor.stalled.recovery_limit" };
    }
    return { action: "continue", reason: "Supervisor circuit breakers are clear", code: "supervisor.continue" };
  }

  function freshWorkflow(at = Date.now()) {
    return {
      version: WORKFLOW_SCHEMA_VERSION,
      revision: 0,
      id: "",
      kind: "",
      objective: "",
      status: "idle",
      maxIterations: DEFAULT_MAX_ITERATIONS,
      iteration: 0,
      pendingItemId: "",
      awaitingResponse: false,
      sawGeneration: false,
      baselineFingerprint: "",
      lastAssistantFingerprint: "",
      promptFingerprint: "",
      responseCandidateFingerprint: "",
      responseCandidateSince: 0,
      runnerId: "",
      runnerExpiresAt: 0,
      lastPromptAt: 0,
      lastResponseAt: 0,
      reason: "",
      supervisor: freshSupervisorState(),
      createdAt: at,
      updatedAt: at
    };
  }

  function normalizeWorkflow(raw, at = Date.now()) {
    const fallback = freshWorkflow(at);
    if (!raw || typeof raw !== "object") return fallback;
    const kind = WORKFLOW_KINDS.has(raw.kind) ? raw.kind : "";
    const objective = cleanText(raw.objective);
    const status = WORKFLOW_STATUSES.has(raw.status) ? raw.status : (kind && objective ? "paused" : "idle");
    const revision = Math.max(0, Math.round(finite(raw.revision, 0)));
    if (!kind || !objective || status === "idle") {
      return {
        ...fallback,
        revision,
        createdAt: finite(raw.createdAt, fallback.createdAt),
        updatedAt: finite(raw.updatedAt, at)
      };
    }
    return {
      version: WORKFLOW_SCHEMA_VERSION,
      revision,
      id: cleanText(raw.id, 180) || makeId(kind),
      kind,
      objective,
      status,
      maxIterations: kind === "goal"
        ? GOAL_MAX_ITERATIONS
        : clamp(Math.round(finite(raw.maxIterations, DEFAULT_MAX_ITERATIONS)), 1, MAX_ITERATIONS),
      iteration: Math.max(0, Math.round(finite(raw.iteration, 0))),
      pendingItemId: cleanText(raw.pendingItemId, 180),
      awaitingResponse: Boolean(raw.awaitingResponse),
      sawGeneration: Boolean(raw.sawGeneration),
      baselineFingerprint: cleanText(raw.baselineFingerprint, 180),
      lastAssistantFingerprint: cleanText(raw.lastAssistantFingerprint, 180),
      promptFingerprint: cleanText(raw.promptFingerprint, 180),
      responseCandidateFingerprint: Boolean(raw.awaitingResponse) ? cleanText(raw.responseCandidateFingerprint, 180) : "",
      responseCandidateSince: Boolean(raw.awaitingResponse) ? Math.max(0, finite(raw.responseCandidateSince, 0)) : 0,
      runnerId: status === "running" ? cleanText(raw.runnerId, 220) : "",
      runnerExpiresAt: status === "running" ? Math.max(0, finite(raw.runnerExpiresAt, 0)) : 0,
      lastPromptAt: Math.max(0, finite(raw.lastPromptAt, 0)),
      lastResponseAt: Math.max(0, finite(raw.lastResponseAt, 0)),
      reason: cleanText(raw.reason, 500),
      supervisor: normalizeSupervisorState(raw.supervisor),
      createdAt: finite(raw.createdAt, at),
      updatedAt: finite(raw.updatedAt, at)
    };
  }

  function startWorkflow(kind, input, { at = Date.now(), baselineFingerprint = "" } = {}) {
    if (!WORKFLOW_KINDS.has(kind)) return { ok: false, reason: "Unsupported workflow type" };
    const parsed = kind === "loop" ? parseLoopArgs(input) : { objective: cleanText(input), maxIterations: GOAL_MAX_ITERATIONS };
    if (!parsed.objective) return { ok: false, reason: `/${kind} requires an objective` };
    return {
      ok: true,
      workflow: normalizeWorkflow({
        id: makeId(kind),
        kind,
        objective: parsed.objective,
        status: "running",
        maxIterations: parsed.maxIterations,
        iteration: 0,
        baselineFingerprint,
        lastAssistantFingerprint: baselineFingerprint,
        createdAt: at,
        updatedAt: at
      }, at)
    };
  }

  function setWorkflowStatus(raw, status, reason = "", at = Date.now()) {
    const workflow = normalizeWorkflow(raw, at);
    if (workflow.status === "idle") return workflow;
    workflow.status = WORKFLOW_STATUSES.has(status) ? status : workflow.status;
    workflow.reason = cleanText(reason, 500);
    workflow.updatedAt = at;
    if (workflow.status !== "running") {
      workflow.pendingItemId = "";
      workflow.awaitingResponse = false;
      workflow.sawGeneration = false;
      workflow.responseCandidateFingerprint = "";
      workflow.responseCandidateSince = 0;
      workflow.runnerId = "";
      workflow.runnerExpiresAt = 0;
    }
    return workflow;
  }

  function goalInitialPrompt(workflow) {
    return [
      "You are now working in YOLO Goal mode.",
      `Persistent objective: ${workflow.objective}`,
      "Work toward the objective concretely. Inspect the current conversation and continue from the actual state instead of restarting or repeating prior commentary.",
      "When continuing, immediately before the terminal control marker emit exactly one progress marker: [YOLO:PROGRESS:<short durable checkpoint or evidence id>] only if concrete new progress was actually persisted or verified; otherwise [YOLO:NO_PROGRESS]. Reuse the same progress id if the durable checkpoint did not advance.",
      "At the very end of every response, emit exactly one control marker on its own line:",
      "[YOLO:CONTINUE] when more work remains toward the objective; [YOLO:DONE] only when the objective is genuinely complete; [YOLO:BLOCKED] when specific user input or unavailable access is required.",
      "Do not emit more than one marker. Begin now."
    ].join("\n\n");
  }

  function goalContinuationPrompt(workflow) {
    return [
      `Continue YOLO Goal mode for this persistent objective: ${workflow.objective}`,
      `This is continuation ${workflow.iteration + 1}. Goal mode has no arbitrary total-turn cap while meaningful progress continues.`,
      "Continue from the latest completed work. Critically inspect assumptions, close gaps, execute the next concrete steps, and validate what you change. Do not repeat the previous answer.",
      "If ending with [YOLO:CONTINUE], immediately before it emit exactly one progress marker: [YOLO:PROGRESS:<short durable checkpoint or evidence id>] only for genuinely new persisted/verified progress, otherwise [YOLO:NO_PROGRESS].",
      "End with exactly one marker on its own line: [YOLO:CONTINUE], [YOLO:DONE], or [YOLO:BLOCKED]."
    ].join("\n\n");
  }

  function goalRecoveryPrompt(workflow) {
    const attempt = Math.max(1, workflow.supervisor.recoveryAttempts);
    return [
      `Recover YOLO Goal mode for this persistent objective: ${workflow.objective}`,
      `Recovery attempt ${attempt} of ${SUPERVISOR_LIMITS.recoveryAttempts}. The previous turn ended without the required terminal control marker.`,
      "Do not assume the interrupted operation completed. Inspect the actual conversation and any durable project state, files, logs, tests, or artifacts available through your tools. Identify the last verified completed operation and the first incomplete or uncertain operation.",
      "Recover from that exact point. Re-run or verify uncertain work where necessary, preserve/checkpoint meaningful results as soon as practical, and then continue toward the persistent objective without repeating prior commentary.",
      "If ending with [YOLO:CONTINUE], immediately before it emit [YOLO:PROGRESS:<short durable checkpoint or evidence id>] only when recovery produced new persisted/verified progress, otherwise [YOLO:NO_PROGRESS].",
      "At the very end, emit exactly one marker on its own line: [YOLO:CONTINUE], [YOLO:DONE], or [YOLO:BLOCKED]."
    ].join("\n\n");
  }

  function goalVerificationPrompt(workflow) {
    const attempt = Math.max(1, workflow.supervisor.verificationAttempts);
    return [
      `Verify completion for this persistent objective: ${workflow.objective}`,
      `Verification attempt ${attempt} of ${SUPERVISOR_LIMITS.verificationAttempts}. A prior work turn claimed the objective was complete.`,
      "Do not trust the completion claim by default. Inspect the actual conversation and durable project state, files, artifacts, logs, tests, unresolved errors, TODOs, and explicit requirements available through your tools.",
      "Compare the evidence against the full persistent objective. If any required work, validation, preservation, or blocker remains, continue the project rather than declaring success.",
      "At the very end emit exactly one marker on its own line: [YOLO:DONE] only if the objective is verified complete; [YOLO:CONTINUE] if work remains; [YOLO:BLOCKED] only when specific user input or unavailable access is genuinely required."
    ].join("\n\n");
  }

  function loopInitialPrompt(workflow) {
    return [
      "You are now working in YOLO Loop mode.",
      `Loop objective: ${workflow.objective}`,
      `Maximum iterations: ${workflow.maxIterations}.`,
      "Perform one meaningful iteration now. Build on the current conversation, make concrete progress, inspect your own work, and avoid repeating prior commentary.",
      "At the very end, emit exactly one marker on its own line: [YOLO:DONE] if complete, [YOLO:BLOCKED] if user input is required, or [YOLO:CONTINUE] when another iteration would help. Missing or malformed markers pause the loop."
    ].join("\n\n");
  }

  function loopContinuationPrompt(workflow) {
    return [
      `Run the next YOLO Loop iteration for: ${workflow.objective}`,
      `Iteration ${workflow.iteration + 1} of ${workflow.maxIterations}.`,
      "Continue from the latest work, find the highest-value unfinished step, execute it, and validate the result. Do not restate the objective or repeat the prior response.",
      "At the very end, emit exactly one marker on its own line: [YOLO:DONE], [YOLO:BLOCKED], or [YOLO:CONTINUE]. Missing or malformed markers pause the loop."
    ].join("\n\n");
  }

  function workflowPrompt(raw, phase = "initial") {
    const workflow = normalizeWorkflow(raw);
    if (workflow.status === "idle") return "";
    if (workflow.kind === "goal") {
      if (phase === "initial") return goalInitialPrompt(workflow);
      if (phase === "recovery") return goalRecoveryPrompt(workflow);
      if (phase === "verification") return goalVerificationPrompt(workflow);
      return goalContinuationPrompt(workflow);
    }
    return phase === "initial" ? loopInitialPrompt(workflow) : loopContinuationPrompt(workflow);
  }

  function evaluateResponse(text) {
    const source = String(text || "");
    const markers = [...source.matchAll(STANDALONE_MARKER_RE)].map((match) => match[1].toLowerCase());
    if (!markers.length) return "missing";
    const terminal = source.match(TERMINAL_MARKER_RE);
    if (!terminal || markers.length !== 1) return "malformed";
    return terminal[1].toLowerCase();
  }

  function evaluateProgress(text) {
    const source = String(text || "");
    const markers = [...source.matchAll(PROGRESS_MARKER_RE)];
    if (!markers.length) return { kind: "missing", evidence: "", fingerprint: "" };
    if (markers.length !== 1) return { kind: "malformed", evidence: "", fingerprint: "" };
    if (markers[0][2]) return { kind: "no_progress", evidence: "", fingerprint: "" };
    const evidence = cleanText(markers[0][1], 160);
    if (!evidence) return { kind: "malformed", evidence: "", fingerprint: "" };
    return { kind: "progress", evidence, fingerprint: fingerprint(evidence) };
  }

  function decideWorkflowResponse(raw, responseText, { userFingerprint = "", at = Date.now() } = {}) {
    const workflow = normalizeWorkflow(raw, at);
    if (workflow.status !== "running" || !workflow.awaitingResponse) {
      return { workflow, action: "ignore", reason: "Workflow is not awaiting a response", code: "workflow.not_waiting" };
    }
    if (!workflow.promptFingerprint || userFingerprint !== workflow.promptFingerprint) {
      return {
        workflow,
        action: "paused",
        reason: "Conversation advanced outside the active workflow",
        code: "command.workflow.ownership_lost"
      };
    }

    const text = String(responseText || "").trim();
    if (!text) return { workflow, action: "ignore", reason: "No assistant response is available", code: "workflow.response_missing" };

    workflow.awaitingResponse = false;
    workflow.sawGeneration = false;
    workflow.responseCandidateFingerprint = "";
    workflow.responseCandidateSince = 0;
    const responseFingerprint = fingerprint(text);
    workflow.lastAssistantFingerprint = responseFingerprint;
    workflow.supervisor = observeSupervisorState(workflow.supervisor, { responseFingerprint }, at);
    workflow.lastResponseAt = at;
    workflow.iteration += 1;
    workflow.updatedAt = at;
    const outcome = evaluateResponse(text);
    const verifyingCompletion = workflow.kind === "goal" && workflow.supervisor.verificationPending;
    if (["continue", "done", "blocked"].includes(outcome) && workflow.supervisor.recoveryAttempts > 0) {
      workflow.supervisor = observeSupervisorState(workflow.supervisor, { recoveryResolved: true }, at);
    }

    if (verifyingCompletion) {
      if (outcome === "done") {
        workflow.supervisor = observeSupervisorState(workflow.supervisor, { verificationResolved: true }, at);
        return { workflow, action: "completed", reason: "Completion was verified against durable project evidence", code: "supervisor.completed.verified" };
      }
      if (outcome === "continue") {
        workflow.supervisor = observeSupervisorState(workflow.supervisor, { verificationResolved: true }, at);
        return { workflow, action: "continue", reason: "Completion verification found remaining work", code: "supervisor.verification.incomplete" };
      }
      if (outcome === "blocked") {
        workflow.supervisor = observeSupervisorState(workflow.supervisor, { verificationResolved: true }, at);
        return { workflow, action: "blocked", reason: "Completion verification requires user input or unavailable access", code: "supervisor.verification.blocked" };
      }
      if (["missing", "malformed"].includes(outcome)) {
        if (workflow.supervisor.verificationAttempts >= SUPERVISOR_LIMITS.verificationAttempts) {
          return { workflow, action: "stalled", reason: "Completion verification protocol failed repeatedly", code: "supervisor.stalled.verification_limit" };
        }
        workflow.supervisor = observeSupervisorState(workflow.supervisor, {
          verificationStarted: true,
          verificationClaimFingerprint: workflow.supervisor.verificationClaimFingerprint,
          verificationReason: `Verification response was ${outcome}`
        }, at);
        return { workflow, action: "verify", reason: "Retry completion verification after an invalid verification response", code: `supervisor.verify.${outcome}` };
      }
    }

    if (outcome === "done" && workflow.kind === "goal") {
      workflow.supervisor = observeSupervisorState(workflow.supervisor, {
        verificationStarted: true,
        verificationClaimFingerprint: responseFingerprint,
        verificationReason: "Goal reported completion; independent verification required"
      }, at);
      return { workflow, action: "verify", reason: "Goal reported completion; verify durable evidence before accepting it", code: "supervisor.verify.requested" };
    }
    if (outcome === "done") {
      return { workflow, action: "completed", reason: "ChatGPT reported the objective complete", code: "command.workflow.completed" };
    }
    if (outcome === "blocked") {
      return { workflow, action: "blocked", reason: "ChatGPT requested user input or unavailable access", code: "command.workflow.blocked" };
    }
    if (outcome === "missing") {
      if (workflow.kind === "goal") {
        workflow.supervisor = observeSupervisorState(workflow.supervisor, {
          recoveryAttempted: true,
          recoveryReason: "Goal response omitted the required terminal control marker"
        }, at);
        if (workflow.supervisor.recoveryAttempts >= SUPERVISOR_LIMITS.recoveryAttempts) {
          return {
            workflow,
            action: "stalled",
            reason: "Goal recovery attempts reached the safety limit after repeated missing terminal markers",
            code: "supervisor.stalled.recovery_limit"
          };
        }
        return {
          workflow,
          action: "recover",
          reason: "Goal response ended without a terminal marker; recover from durable state before continuing",
          code: "supervisor.recover.marker_missing"
        };
      }
      return {
        workflow,
        action: "paused",
        reason: "Loop response omitted the required terminal control marker",
        code: "command.workflow.marker_missing"
      };
    }
    if (outcome === "malformed") {
      const label = workflow.kind === "goal" ? "Goal" : "Loop";
      return {
        workflow,
        action: "paused",
        reason: `${label} response contained multiple or misplaced terminal control markers`,
        code: "command.workflow.marker_malformed"
      };
    }
    if (workflow.kind === "goal" && outcome === "continue") {
      const progress = evaluateProgress(text);
      if (progress.kind === "progress") {
        const advanced = progress.fingerprint !== workflow.supervisor.lastProgressFingerprint;
        workflow.supervisor = observeSupervisorState(workflow.supervisor, {
          progressed: advanced,
          progressFingerprint: progress.fingerprint
        }, at);
      } else if (progress.kind === "no_progress") {
        workflow.supervisor = observeSupervisorState(workflow.supervisor, { progressed: false }, at);
      }
    }

    if (workflow.kind === "loop" && workflow.iteration >= workflow.maxIterations) {
      return {
        workflow,
        action: "paused",
        reason: `Reached the ${workflow.maxIterations}-iteration safety cap`,
        code: "command.workflow.cap_reached"
      };
    }
    if (workflow.kind === "goal") {
      const disposition = supervisorDisposition(workflow.supervisor);
      if (disposition.action === "stalled") {
        return { workflow, action: "stalled", reason: disposition.reason, code: disposition.code };
      }
    }
    return { workflow, action: "continue", reason: "Continue workflow", code: "command.workflow.continue" };
  }

  function oneShotPrompt(name, args = "") {
    const scope = cleanText(args);
    if (name === "plan") {
      if (!scope) return "";
      return [
        `Plan this objective before implementation: ${scope}`,
        "Inspect the current conversation first. Produce a concrete, ordered plan with assumptions, dependencies, risks, validation criteria, and the smallest sensible execution sequence. Ask only for input that is genuinely required. Do not begin implementation yet."
      ].join("\n\n");
    }
    if (name === "review") {
      return [
        scope ? `Review scope: ${scope}` : "Review the work completed so far in this conversation.",
        "Perform an adversarial, evidence-based review. Find concrete correctness, reliability, security, UX, maintainability, and completeness issues. Prioritize findings by severity, avoid generic praise, verify assumptions against the actual work, and distinguish blockers from optional improvements."
      ].join("\n\n");
    }
    if (name === "fix") {
      return [
        scope ? `Fix scope: ${scope}` : "Fix the current work from the latest known state.",
        "Identify concrete defects and unfinished parts, repair them directly, validate the result, and continue until the scoped work is complete or a real blocker remains. Do not stop at a plan and do not repeat prior commentary."
      ].join("\n\n");
    }
    if (name === "handoff") {
      return [
        scope ? `Handoff focus: ${scope}` : "Write a continuation handoff for the current work.",
        "Summarize the objective, decisions, constraints, completed work, exact current state, unresolved defects, risks, relevant identifiers, validation evidence, and next actions. Remove incidental repetition. This is a written handoff only; do not claim that ChatGPT context was compacted, truncated, or changed."
      ].join("\n\n");
    }
    if (name === "continue") {
      return [
        scope ? `Continue with this direction: ${scope}` : "Continue from the current state and keep going deeper.",
        "Do not repeat the previous answer. Critically inspect assumptions, close gaps, execute the next concrete steps toward the original objective, and validate the result."
      ].join("\n\n");
    }
    return "";
  }

  function requiresArgs(name) {
    return ["goal", "loop", "plan"].includes(String(name || ""));
  }

  return Object.freeze({
    COMMANDS,
    MAX_OBJECTIVE_LENGTH,
    MAX_ITERATIONS,
    DEFAULT_MAX_ITERATIONS,
    GOAL_MAX_ITERATIONS,
    WORKFLOW_SCHEMA_VERSION,
    SUPERVISOR_LIMITS,
    freshSupervisorState,
    normalizeSupervisorState,
    observeSupervisorState,
    supervisorDisposition,
    command,
    filterCommands,
    parseInvocation,
    parseLoopArgs,
    fingerprint,
    freshWorkflow,
    normalizeWorkflow,
    startWorkflow,
    setWorkflowStatus,
    workflowPrompt,
    evaluateResponse,
    evaluateProgress,
    decideWorkflowResponse,
    oneShotPrompt,
    requiresArgs
  });
});