((root, factory) => {
  const Shared = typeof module === "object" && module.exports ? require("./shared.js") : root.YOLOShared;
  const Commands = typeof module === "object" && module.exports ? require("./commands.js") : root.YOLOCommands;
  const api = factory(Shared, Commands);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YOLOProjects = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (Shared, Commands) => {
  "use strict";

  const PROJECT_SCHEMA_VERSION = 2;
  const MAX_PROJECTS = 100;
  const MAX_CONVERSATIONS = 64;
  const PROJECT_STATUSES = new Set(["active", "rollover_required", "rolling_over", "completed", "stopped"]);
  const CONVERSATION_STATUSES = new Set(["active", "rolling_over", "exhausted", "completed", "failed"]);
  const ROLLOVER_STAGES = new Set(["idle", "required", "handoff_pending", "handoff_ready", "successor_pending", "bootstrap_pending", "successor_bound", "resuming", "complete", "failed"]);
  const ROLLOVER_LEASE_MS = 2 * 60 * 1000;
  const MAX_HANDOFF_LENGTH = 6000;
  const cleanText = (value, max = 4000) => String(value ?? "").trim().slice(0, max);
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

  function freshConversation(pageId = "", generation = 1, at = Date.now()) {
    return {
      generation: Math.max(1, Math.round(finite(generation, 1))),
      pageId: cleanText(pageId, 1000),
      status: "active",
      startedAt: at,
      endedAt: 0,
      rolloverReason: "",
      successorPageId: "",
      lastVerifiedCheckpoint: "",
      finalPromptFingerprint: "",
      finalAssistantFingerprint: "",
      doNotContinue: false
    };
  }
  function normalizeConversation(raw = {}, at = Date.now()) {
    const fallback = freshConversation(raw?.pageId, raw?.generation, at);
    const status = CONVERSATION_STATUSES.has(raw?.status) ? raw.status : fallback.status;
    const exhausted = status === "exhausted" || Boolean(raw?.doNotContinue);
    return {
      generation: Math.max(1, Math.round(finite(raw?.generation, fallback.generation))),
      pageId: cleanText(raw?.pageId, 1000),
      status: exhausted ? "exhausted" : status,
      startedAt: Math.max(0, finite(raw?.startedAt, fallback.startedAt)),
      endedAt: Math.max(0, finite(raw?.endedAt, 0)),
      rolloverReason: cleanText(raw?.rolloverReason, 500),
      successorPageId: cleanText(raw?.successorPageId, 1000),
      lastVerifiedCheckpoint: cleanText(raw?.lastVerifiedCheckpoint, 180),
      finalPromptFingerprint: cleanText(raw?.finalPromptFingerprint, 180),
      finalAssistantFingerprint: cleanText(raw?.finalAssistantFingerprint, 180),
      doNotContinue: exhausted
    };
  }

  function freshHandoff() {
    return { text: "", verified: false, fingerprint: "", sourcePageId: "", generation: 0, basisCheckpointId: "", at: 0, verifiedAt: 0 };
  }

  function normalizeHandoff(raw = {}) {
    const handoff = raw && typeof raw === "object" ? raw : {};
    return {
      text: cleanText(handoff.text, MAX_HANDOFF_LENGTH),
      verified: Boolean(handoff.verified),
      fingerprint: cleanText(handoff.fingerprint, 180),
      sourcePageId: cleanText(handoff.sourcePageId, 1000),
      generation: Math.max(0, Math.round(finite(handoff.generation, 0))),
      basisCheckpointId: cleanText(handoff.basisCheckpointId, 180),
      at: Math.max(0, finite(handoff.at, 0)),
      verifiedAt: Math.max(0, finite(handoff.verifiedAt, 0))
    };
  }

  function freshRollover() {
    return { stage: "idle", sourcePageId: "", reason: "", ownerId: "", leaseToken: "", leaseExpiresAt: 0, startedAt: 0, updatedAt: 0, handoffSource: "", handoffFingerprint: "", successorPageId: "", error: "" };
  }

  function normalizeRollover(raw = {}) {
    const rollover = raw && typeof raw === "object" ? raw : {};
    return {
      stage: ROLLOVER_STAGES.has(rollover.stage) ? rollover.stage : "idle",
      sourcePageId: cleanText(rollover.sourcePageId, 1000),
      reason: cleanText(rollover.reason, 500),
      ownerId: cleanText(rollover.ownerId, 220),
      leaseToken: cleanText(rollover.leaseToken, 220),
      leaseExpiresAt: Math.max(0, finite(rollover.leaseExpiresAt, 0)),
      startedAt: Math.max(0, finite(rollover.startedAt, 0)),
      updatedAt: Math.max(0, finite(rollover.updatedAt, 0)),
      handoffSource: cleanText(rollover.handoffSource, 80),
      handoffFingerprint: cleanText(rollover.handoffFingerprint, 180),
      successorPageId: cleanText(rollover.successorPageId, 1000),
      error: cleanText(rollover.error, 500)
    };
  }

  function freshProject(at = Date.now()) {
    return {
      version: PROJECT_SCHEMA_VERSION,
      revision: 0,
      id: "",
      objective: "",
      originalRequirements: "",
      status: "active",
      currentConversationId: "",
      currentGeneration: 1,
      latestVerifiedCheckpoint: { id: "", at: 0 },
      latestHandoff: freshHandoff(),
      rollover: freshRollover(),
      supervisor: Commands.freshSupervisorState(),
      conversationChain: [],
      createdAt: at,
      updatedAt: at
    };
  }
  function normalizeProject(raw = {}, fallbackId = "", at = Date.now()) {
    const fallback = freshProject(at);
    const id = cleanText(raw?.id || fallbackId, 180);
    const objective = cleanText(raw?.objective || raw?.originalRequirements, 4000);
    const chain = (Array.isArray(raw?.conversationChain) ? raw.conversationChain : [])
      .map((entry) => normalizeConversation(entry, at))
      .filter((entry) => entry.pageId)
      .sort((a, b) => a.generation - b.generation)
      .slice(-MAX_CONVERSATIONS);
    const currentGeneration = Math.max(1, Math.round(finite(raw?.currentGeneration, chain.at(-1)?.generation || 1)));
    const currentConversationId = cleanText(raw?.currentConversationId || chain.at(-1)?.pageId, 1000);
    let status = PROJECT_STATUSES.has(raw?.status) ? raw.status : fallback.status;
    const currentConversation = chain.find((entry) => entry.pageId === currentConversationId);
    if (currentConversation?.doNotContinue && status === "active") status = "rollover_required";
    const checkpoint = raw?.latestVerifiedCheckpoint && typeof raw.latestVerifiedCheckpoint === "object"
      ? raw.latestVerifiedCheckpoint : {};
    const handoff = normalizeHandoff(raw?.latestHandoff);
    const rollover = normalizeRollover(raw?.rollover);
    return {
      version: PROJECT_SCHEMA_VERSION,
      revision: Math.max(0, Math.round(finite(raw?.revision, 0))),
      id,
      objective,
      originalRequirements: cleanText(raw?.originalRequirements || objective, 12000),
      status,
      currentConversationId,
      currentGeneration,
      latestVerifiedCheckpoint: { id: cleanText(checkpoint.id, 180), at: Math.max(0, finite(checkpoint.at, 0)) },
      latestHandoff: handoff,
      rollover,
      supervisor: Commands.normalizeSupervisorState(raw?.supervisor),
      conversationChain: chain,
      createdAt: Math.max(0, finite(raw?.createdAt, at)),
      updatedAt: Math.max(0, finite(raw?.updatedAt, at))
    };
  }

  function normalizeProjectMap(raw = {}, at = Date.now()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const entries = Object.entries(raw).slice(-MAX_PROJECTS);
    const normalized = {};
    for (const [key, value] of entries) {
      const project = normalizeProject(value, key, at);
      if (!project.id || !project.objective) continue;
      normalized[project.id] = project;
    }
    return normalized;
  }
  function findProjectByConversation(rawMap, pageId, at = Date.now()) {
    const map = normalizeProjectMap(rawMap, at);
    const project = Object.values(map)
      .filter((entry) => entry.currentConversationId === pageId || entry.conversationChain.some((conversation) => conversation.pageId === pageId))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.revision - a.revision)[0] || null;
    return project ? { projectId: project.id, project, map } : { projectId: "", project: null, map };
  }

  function createProject({ objective = "", pageId = "", workflow = {}, at = Date.now() } = {}) {
    const project = freshProject(at);
    project.id = Shared.makeId("project");
    project.objective = cleanText(objective || workflow.objective, 4000);
    project.originalRequirements = project.objective;
    project.currentConversationId = cleanText(pageId, 1000);
    project.currentGeneration = 1;
    project.supervisor = Commands.normalizeSupervisorState(workflow.supervisor);
    if (project.currentConversationId) project.conversationChain = [freshConversation(project.currentConversationId, 1, at)];
    const checkpoint = cleanText(project.supervisor.lastProgressFingerprint, 180);
    if (checkpoint) project.latestVerifiedCheckpoint = { id: checkpoint, at: project.supervisor.lastProgressAt || at };
    return syncProjectFromWorkflow(normalizeProject(project, project.id, at), project.currentConversationId, workflow, at);
  }

  function markConversationExhausted(rawProject, pageId, { reason = "", workflow = {}, at = Date.now() } = {}) {
    const project = normalizeProject(rawProject, rawProject?.id, at);
    let entry = project.conversationChain.find((candidate) => candidate.pageId === pageId);
    if (!entry) {
      entry = freshConversation(pageId, project.currentGeneration || 1, at);
      project.conversationChain.push(entry);
    }
    entry.status = "exhausted";
    entry.doNotContinue = true;
    entry.endedAt = at;
    entry.rolloverReason = cleanText(reason || workflow.reason || "ChatGPT conversation context limit reached", 500);
    entry.finalPromptFingerprint = cleanText(workflow.promptFingerprint, 180);
    entry.finalAssistantFingerprint = cleanText(workflow.lastAssistantFingerprint, 180);
    entry.lastVerifiedCheckpoint = cleanText(workflow.supervisor?.lastProgressFingerprint, 180);
    if (project.status !== "rolling_over") project.status = "rollover_required";
    project.currentConversationId = pageId;
    const rollover = normalizeRollover(project.rollover);
    project.rollover = { ...rollover, stage: rollover.stage === "idle" ? "required" : rollover.stage, sourcePageId: pageId, reason: entry.rolloverReason, startedAt: rollover.startedAt || at, updatedAt: at, error: "" };
    project.supervisor = Commands.normalizeSupervisorState(workflow.supervisor || project.supervisor);
    project.updatedAt = at;
    project.revision += 1;
    return normalizeProject(project, project.id, at);
  }
  function syncProjectFromWorkflow(rawProject, pageId, rawWorkflow, at = Date.now()) {
    const workflow = Commands.normalizeWorkflow(rawWorkflow, at);
    let project = normalizeProject(rawProject, rawProject?.id, at);
    if (!project.objective) project.objective = workflow.objective;
    if (!project.originalRequirements) project.originalRequirements = project.objective;
    if (!project.currentConversationId) project.currentConversationId = pageId;
    if (!project.conversationChain.some((entry) => entry.pageId === pageId)) {
      project.conversationChain.push(freshConversation(pageId, project.currentGeneration || 1, at));
    }
    project.supervisor = Commands.normalizeSupervisorState(workflow.supervisor);
    const checkpoint = cleanText(project.supervisor.lastProgressFingerprint, 180);
    if (checkpoint) project.latestVerifiedCheckpoint = { id: checkpoint, at: project.supervisor.lastProgressAt || at };
    if (workflow.status === "rollover_required") {
      return markConversationExhausted(project, pageId, { reason: workflow.reason, workflow, at });
    }
    if (workflow.status === "completed") {
      project.status = "completed";
      const entry = project.conversationChain.find((candidate) => candidate.pageId === pageId);
      if (entry && !entry.doNotContinue) {
        entry.status = "completed";
        entry.endedAt = at;
      }
    }
    project.updatedAt = at;
    project.revision += 1;
    return normalizeProject(project, project.id, at);
  }

  function ensureProjectForWorkflow(rawMap, pageId, rawWorkflow, at = Date.now()) {
    const workflow = Commands.normalizeWorkflow(rawWorkflow, at);
    const map = normalizeProjectMap(rawMap, at);
    if (workflow.kind !== "goal" || !workflow.objective) return { map, project: null, workflow };
    let project = workflow.projectId ? map[workflow.projectId] : null;
    if (!project && !workflow.projectId) {
      const candidate = findProjectByConversation(map, pageId, at).project;
      if (candidate && candidate.objective === workflow.objective && !["completed", "stopped"].includes(candidate.status)) project = candidate;
    }
    if (!project) project = createProject({ objective: workflow.objective, pageId, workflow, at });
    else project = syncProjectFromWorkflow(project, pageId, workflow, at);
    map[project.id] = project;
    return {
      map,
      project,
      workflow: Commands.normalizeWorkflow({ ...workflow, projectId: project.id }, at)
    };
  }

  function tombstoneForConversation(rawMap, pageId, at = Date.now()) {
    const map = normalizeProjectMap(rawMap, at);
    const matches = [];
    for (const project of Object.values(map)) {
      const conversation = project.conversationChain.find((entry) => entry.pageId === pageId && entry.doNotContinue);
      if (conversation) matches.push({ projectId: project.id, project, conversation });
    }
    return matches.sort((a, b) => b.project.updatedAt - a.project.updatedAt || b.project.revision - a.project.revision)[0] || null;
  }

  function rolloverLeaseActive(rawProject, at = Date.now()) {
    const rollover = normalizeRollover(normalizeProject(rawProject, rawProject?.id, at).rollover);
    return Boolean(rollover.ownerId && rollover.leaseToken && rollover.leaseExpiresAt > at);
  }

  function claimRollover(rawProject, ownerId, { at = Date.now(), leaseMs = ROLLOVER_LEASE_MS } = {}) {
    const project = normalizeProject(rawProject, rawProject?.id, at);
    const owner = cleanText(ownerId, 220);
    if (!owner) return { ok: false, code: "project.rollover_owner_invalid", reason: "Rollover owner is required", project };
    if (!["rollover_required", "rolling_over"].includes(project.status)) return { ok: false, code: "project.rollover_not_required", reason: "Project does not require rollover", project };
    const rollover = normalizeRollover(project.rollover);
    if (rollover.ownerId && rollover.ownerId !== owner && rollover.leaseExpiresAt > at) return { ok: false, code: "project.rollover_busy", reason: "Rollover is active in another tab", project };
    if (rollover.ownerId === owner && rollover.leaseToken && rollover.leaseExpiresAt > at) return { ok: true, project, leaseToken: rollover.leaseToken, renewed: false };
    project.status = "rolling_over";
    project.rollover = { ...rollover, stage: rollover.stage === "idle" ? "required" : rollover.stage, ownerId: owner, leaseToken: Shared.makeId("rollover"), leaseExpiresAt: at + Math.max(1000, finite(leaseMs, ROLLOVER_LEASE_MS)), startedAt: rollover.startedAt || at, updatedAt: at, error: "" };
    project.revision += 1;
    project.updatedAt = at;
    return { ok: true, project: normalizeProject(project, project.id, at), leaseToken: project.rollover.leaseToken, renewed: true };
  }

  function rolloverLeaseMatches(project, ownerId, leaseToken, at = Date.now()) {
    const rollover = normalizeRollover(project.rollover);
    return Boolean(rollover.ownerId === cleanText(ownerId, 220) && rollover.leaseToken === cleanText(leaseToken, 220) && rollover.leaseExpiresAt > at);
  }

  function releaseRollover(rawProject, ownerId, leaseToken, at = Date.now()) {
    const project = normalizeProject(rawProject, rawProject?.id, at);
    if (!rolloverLeaseMatches(project, ownerId, leaseToken, at)) return { ok: false, code: "project.rollover_lease_lost", reason: "Rollover lease is not owned by this tab", project };
    project.rollover = { ...project.rollover, ownerId: "", leaseToken: "", leaseExpiresAt: 0, updatedAt: at };
    project.revision += 1;
    project.updatedAt = at;
    return { ok: true, project: normalizeProject(project, project.id, at) };
  }

  const ROLLOVER_TRANSITIONS = Object.freeze({
    required: new Set(["handoff_pending", "handoff_ready", "failed"]),
    handoff_pending: new Set(["handoff_ready", "required", "failed"]),
    handoff_ready: new Set(["successor_pending", "failed"]),
    successor_pending: new Set(["bootstrap_pending", "failed"]),
    bootstrap_pending: new Set(["successor_bound", "failed"]),
    successor_bound: new Set(["resuming", "failed"]),
    resuming: new Set(["complete", "failed"]),
    failed: new Set(["required"]),
    complete: new Set(),
    idle: new Set(["required"])
  });

  function advanceRollover(rawProject, stage, { ownerId = "", leaseToken = "", at = Date.now(), handoffSource = "", successorPageId = "", error = "" } = {}) {
    const project = normalizeProject(rawProject, rawProject?.id, at);
    const nextStage = ROLLOVER_STAGES.has(stage) ? stage : "";
    if (!nextStage) return { ok: false, code: "project.rollover_stage_invalid", reason: "Invalid rollover stage", project };
    if (!rolloverLeaseMatches(project, ownerId, leaseToken, at)) return { ok: false, code: "project.rollover_lease_lost", reason: "Rollover lease is not owned by this tab", project };
    const current = project.rollover.stage;
    if (nextStage !== current && !ROLLOVER_TRANSITIONS[current]?.has(nextStage)) return { ok: false, code: "project.rollover_transition_invalid", reason: "Cannot advance rollover from " + current + " to " + nextStage, project };
    project.rollover = { ...project.rollover, stage: nextStage, updatedAt: at, handoffSource: cleanText(handoffSource || project.rollover.handoffSource, 80), successorPageId: cleanText(successorPageId || project.rollover.successorPageId, 1000), error: cleanText(error, 500) };
    if (nextStage === "failed") project.status = "rollover_required";
    else if (nextStage === "complete") project.status = "active";
    else project.status = "rolling_over";
    project.revision += 1;
    project.updatedAt = at;
    return { ok: true, project: normalizeProject(project, project.id, at) };
  }

  function parseHandoffCandidate(rawProject, text) {
    const project = normalizeProject(rawProject, rawProject?.id);
    const value = cleanText(text, MAX_HANDOFF_LENGTH);
    if (value.length < 120) return { ok: false, code: "project.handoff_too_short", reason: "Handoff is too short to be durable", text: value, fingerprint: "" };
    const required = ["Project-ID: " + project.id, "Generation: " + project.currentGeneration, "Objective:", "Current-State:", "Completed:", "Unresolved:", "Validation:", "Next-Action:"];
    const missing = required.filter((marker) => !value.includes(marker));
    if (missing.length) return { ok: false, code: "project.handoff_structure_invalid", reason: "Handoff is missing required fields: " + missing.join(", "), text: value, fingerprint: "" };
    return { ok: true, code: "project.handoff_candidate_valid", reason: "Handoff candidate is structurally usable", text: value, fingerprint: Commands.fingerprint(value) };
  }

  function saveHandoffCandidate(rawProject, text, { ownerId = "", leaseToken = "", at = Date.now() } = {}) {
    const project = normalizeProject(rawProject, rawProject?.id, at);
    if (!rolloverLeaseMatches(project, ownerId, leaseToken, at)) return { ok: false, code: "project.rollover_lease_lost", reason: "Rollover lease is not owned by this tab", project };
    const parsed = parseHandoffCandidate(project, text);
    if (!parsed.ok) return { ...parsed, project };
    if (!["required", "handoff_pending"].includes(project.rollover.stage)) return { ok: false, code: "project.handoff_stage_invalid", reason: "Rollover is not accepting a handoff candidate", project };
    project.latestHandoff = { text: parsed.text, verified: false, fingerprint: parsed.fingerprint, sourcePageId: project.rollover.sourcePageId || project.currentConversationId, generation: project.currentGeneration, basisCheckpointId: project.latestVerifiedCheckpoint.id, at, verifiedAt: 0 };
    project.rollover = { ...project.rollover, stage: "handoff_pending", handoffFingerprint: parsed.fingerprint, handoffSource: "fresh_candidate", updatedAt: at, error: "" };
    project.revision += 1;
    project.updatedAt = at;
    return { ok: true, code: "project.handoff_saved", project: normalizeProject(project, project.id, at), fingerprint: parsed.fingerprint };
  }

  function handoffVerificationMarker(fingerprint, accepted) {
    return "[YOLO:HANDOFF_" + (accepted ? "VERIFIED" : "REJECTED") + ":" + cleanText(fingerprint, 180) + "]";
  }

  function evaluateHandoffVerification(text, fingerprint) {
    const value = String(text || "").trim();
    const markers = [...value.matchAll(/(?:^|\n)[ \t]*\[YOLO:HANDOFF_(VERIFIED|REJECTED):([^\]\r\n]{1,180})\][ \t]*(?=\n|$)/gi)];
    if (markers.length !== 1) return { kind: markers.length ? "malformed" : "missing", fingerprint: "" };
    const terminal = value.match(/(?:^|\n)[ \t]*\[YOLO:HANDOFF_(VERIFIED|REJECTED):([^\]\r\n]{1,180})\][ \t]*$/i);
    if (!terminal) return { kind: "malformed", fingerprint: "" };
    const found = cleanText(terminal[2], 180);
    if (found !== cleanText(fingerprint, 180)) return { kind: "stale", fingerprint: found };
    return { kind: terminal[1].toLowerCase() === "verified" ? "verified" : "rejected", fingerprint: found };
  }

  function verifyHandoff(rawProject, verificationText, { ownerId = "", leaseToken = "", at = Date.now() } = {}) {
    const project = normalizeProject(rawProject, rawProject?.id, at);
    if (!rolloverLeaseMatches(project, ownerId, leaseToken, at)) return { ok: false, code: "project.rollover_lease_lost", reason: "Rollover lease is not owned by this tab", project };
    const handoff = normalizeHandoff(project.latestHandoff);
    if (!handoff.text || !handoff.fingerprint || project.rollover.stage !== "handoff_pending") return { ok: false, code: "project.handoff_missing", reason: "No handoff candidate is awaiting verification", project };
    const result = evaluateHandoffVerification(verificationText, handoff.fingerprint);
    if (result.kind !== "verified") return { ok: false, code: "project.handoff_" + result.kind, reason: "Handoff verification was " + result.kind, project, verification: result };
    project.latestHandoff = { ...handoff, verified: true, verifiedAt: at };
    project.rollover = { ...project.rollover, stage: "handoff_ready", handoffSource: "verified_handoff", handoffFingerprint: handoff.fingerprint, updatedAt: at, error: "" };
    project.revision += 1;
    project.updatedAt = at;
    return { ok: true, code: "project.handoff_verified", project: normalizeProject(project, project.id, at), verification: result };
  }

  function selectRolloverFallback(rawProject) {
    const project = normalizeProject(rawProject, rawProject?.id);
    const handoff = normalizeHandoff(project.latestHandoff);
    if (handoff.verified && handoff.text) return { kind: "verified_handoff", handoff, checkpoint: project.latestVerifiedCheckpoint, objective: project.objective };
    if (project.latestVerifiedCheckpoint.id) return { kind: "checkpoint", handoff: freshHandoff(), checkpoint: project.latestVerifiedCheckpoint, objective: project.objective };
    return { kind: "machine_state", handoff: freshHandoff(), checkpoint: project.latestVerifiedCheckpoint, objective: project.objective };
  }

  function applyRolloverFallback(rawProject, { ownerId = "", leaseToken = "", at = Date.now() } = {}) {
    const project = normalizeProject(rawProject, rawProject?.id, at);
    if (!rolloverLeaseMatches(project, ownerId, leaseToken, at)) return { ok: false, code: "project.rollover_lease_lost", reason: "Rollover lease is not owned by this tab", project };
    if (!["required", "handoff_pending"].includes(project.rollover.stage)) return { ok: false, code: "project.rollover_fallback_stage_invalid", reason: "Rollover fallback is not valid in this stage", project };
    const fallback = selectRolloverFallback(project);
    project.rollover = { ...project.rollover, stage: "handoff_ready", handoffSource: fallback.kind, handoffFingerprint: fallback.handoff.fingerprint || "", updatedAt: at, error: "" };
    project.revision += 1;
    project.updatedAt = at;
    return { ok: true, code: "project.rollover_fallback_ready", project: normalizeProject(project, project.id, at), fallback };
  }

  function handoffGenerationPrompt(rawProject) {
    const project = normalizeProject(rawProject, rawProject?.id);
    return [
      "Create a concise durable rollover handoff for this long-running project before moving to a fresh ChatGPT conversation.",
      "Project-ID: " + project.id,
      "Generation: " + project.currentGeneration,
      "Authoritative objective: " + project.objective,
      "Latest verified checkpoint id: " + (project.latestVerifiedCheckpoint.id || "none"),
      "Inspect the actual conversation and durable files/artifacts available through tools. Do not assume uncertain operations succeeded. Preserve settled requirements and the first unfinished operation.",
      "Return only one handoff using these exact field labels, with compact factual content after each label:",
      "Project-ID: " + project.id,
      "Generation: " + project.currentGeneration,
      "Objective:", "Current-State:", "Completed:", "Unresolved:", "Validation:", "Next-Action:",
      "Keep the handoff under 6000 characters. Do not include YOLO terminal workflow markers."
    ].join("\n\n");
  }

  function handoffVerificationPrompt(rawProject) {
    const project = normalizeProject(rawProject, rawProject?.id);
    const handoff = normalizeHandoff(project.latestHandoff);
    if (!handoff.text || !handoff.fingerprint) return "";
    return [
      "Verify the following rollover handoff against the actual conversation and durable project evidence available through tools.",
      "Reject it if it omits a settled requirement, misstates completed work, loses the first unfinished/uncertain operation, or claims validation that cannot be verified.",
      "Do not rewrite the handoff in this response. End with exactly one terminal verification marker matching the candidate fingerprint.",
      "If adequate: " + handoffVerificationMarker(handoff.fingerprint, true),
      "If inadequate: " + handoffVerificationMarker(handoff.fingerprint, false),
      "Candidate handoff:", handoff.text
    ].join("\n\n");
  }

  return Object.freeze({
    PROJECT_SCHEMA_VERSION,
    MAX_PROJECTS,
    MAX_CONVERSATIONS,
    ROLLOVER_LEASE_MS,
    ROLLOVER_STAGES,
    freshHandoff,
    normalizeHandoff,
    freshRollover,
    normalizeRollover,
    freshConversation,
    normalizeConversation,
    freshProject,
    normalizeProject,
    normalizeProjectMap,
    findProjectByConversation,
    createProject,
    syncProjectFromWorkflow,
    markConversationExhausted,
    ensureProjectForWorkflow,
    tombstoneForConversation,
    rolloverLeaseActive,
    claimRollover,
    releaseRollover,
    advanceRollover,
    parseHandoffCandidate,
    saveHandoffCandidate,
    handoffVerificationMarker,
    evaluateHandoffVerification,
    verifyHandoff,
    selectRolloverFallback,
    applyRolloverFallback,
    handoffGenerationPrompt,
    handoffVerificationPrompt
  });
});
