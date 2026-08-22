((root, factory) => {
  const Shared = typeof module === "object" && module.exports ? require("./shared.js") : root.YOLOShared;
  const Commands = typeof module === "object" && module.exports ? require("./commands.js") : root.YOLOCommands;
  const api = factory(Shared, Commands);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YOLOProjects = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (Shared, Commands) => {
  "use strict";

  const PROJECT_SCHEMA_VERSION = 4;
  const MAX_PROJECTS = 100;
  const MAX_CONVERSATIONS = 64;
  const PROJECT_STATUSES = new Set(["active", "rollover_required", "rolling_over", "completed", "stopped"]);
  const CONVERSATION_STATUSES = new Set(["active", "rolling_over", "exhausted", "completed", "failed"]);
  const ROLLOVER_STAGES = new Set(["idle", "required", "handoff_pending", "handoff_ready", "successor_pending", "bootstrap_pending", "successor_bound", "resuming", "complete", "failed"]);
  const ROLLOVER_LEASE_MS = 2 * 60 * 1000;
  const BOOTSTRAP_STATES = new Set(["idle", "prepared", "submitting", "observed", "verified", "delivery_unknown"]);
  const ROLLOVER_MODES = new Set(["idle", "hard", "proactive"]);
  const HANDOFF_ACTIONS = new Set(["idle", "generate", "verify"]);
  const MAX_HANDOFF_LENGTH = 6000;
  const MAX_BOOTSTRAP_LENGTH = 30000;
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
    const exhausted = status === "exhausted" || (status === "active" && Boolean(raw?.doNotContinue));
    const inert = exhausted || Boolean(raw?.doNotContinue);
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
      doNotContinue: inert
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
    return { stage: "idle", mode: "idle", sourcePageId: "", reason: "", ownerId: "", leaseToken: "", leaseExpiresAt: 0, startedAt: 0, updatedAt: 0, proactiveAttempts: 0, proactiveLastAttemptAt: 0, proactiveEvidenceCode: "", proactiveEvidenceMessages: 0, proactiveEvidenceChars: 0, proactiveEvidenceContinuations: 0, handoffSource: "", handoffFingerprint: "", handoffAction: "idle", handoffPromptText: "", handoffPromptFingerprint: "", handoffBaselineAssistantFingerprint: "", handoffBaselineUserFingerprint: "", handoffPromptPreparedAt: 0, successorPageId: "", newChatRequestedAt: 0, newChatOpeningAt: 0, bootstrapText: "", bootstrapFingerprint: "", bootstrapToken: "", bootstrapState: "idle", bootstrapSubmittedAt: 0, bootstrapObservedAt: 0, bootstrapVerifiedAt: 0, error: "" };
  }

  function normalizeRollover(raw = {}) {
    const rollover = raw && typeof raw === "object" ? raw : {};
    return {
      stage: ROLLOVER_STAGES.has(rollover.stage) ? rollover.stage : "idle",
      mode: ROLLOVER_MODES.has(rollover.mode) ? rollover.mode : (rollover.sourcePageId ? "hard" : "idle"),
      sourcePageId: cleanText(rollover.sourcePageId, 1000),
      reason: cleanText(rollover.reason, 500),
      ownerId: cleanText(rollover.ownerId, 220),
      leaseToken: cleanText(rollover.leaseToken, 220),
      leaseExpiresAt: Math.max(0, finite(rollover.leaseExpiresAt, 0)),
      startedAt: Math.max(0, finite(rollover.startedAt, 0)),
      updatedAt: Math.max(0, finite(rollover.updatedAt, 0)),
      proactiveAttempts: Math.max(0, Math.round(finite(rollover.proactiveAttempts, 0))),
      proactiveLastAttemptAt: Math.max(0, finite(rollover.proactiveLastAttemptAt, 0)),
      proactiveEvidenceCode: cleanText(rollover.proactiveEvidenceCode, 120),
      proactiveEvidenceMessages: Math.max(0, Math.round(finite(rollover.proactiveEvidenceMessages, 0))),
      proactiveEvidenceChars: Math.max(0, Math.round(finite(rollover.proactiveEvidenceChars, 0))),
      proactiveEvidenceContinuations: Math.max(0, Math.round(finite(rollover.proactiveEvidenceContinuations, 0))),
      handoffSource: cleanText(rollover.handoffSource, 80),
      handoffFingerprint: cleanText(rollover.handoffFingerprint, 180),
      handoffAction: HANDOFF_ACTIONS.has(rollover.handoffAction) ? rollover.handoffAction : "idle",
      handoffPromptText: cleanText(rollover.handoffPromptText, MAX_BOOTSTRAP_LENGTH),
      handoffPromptFingerprint: cleanText(rollover.handoffPromptFingerprint, 180),
      handoffBaselineAssistantFingerprint: cleanText(rollover.handoffBaselineAssistantFingerprint, 180),
      handoffBaselineUserFingerprint: cleanText(rollover.handoffBaselineUserFingerprint, 180),
      handoffPromptPreparedAt: Math.max(0, finite(rollover.handoffPromptPreparedAt, 0)),
      successorPageId: cleanText(rollover.successorPageId, 1000),
      newChatRequestedAt: Math.max(0, finite(rollover.newChatRequestedAt, 0)),
      newChatOpeningAt: Math.max(0, finite(rollover.newChatOpeningAt, 0)),
      bootstrapText: cleanText(rollover.bootstrapText, MAX_BOOTSTRAP_LENGTH),
      bootstrapFingerprint: cleanText(rollover.bootstrapFingerprint, 180),
      bootstrapToken: cleanText(rollover.bootstrapToken, 180),
      bootstrapState: BOOTSTRAP_STATES.has(rollover.bootstrapState) ? rollover.bootstrapState : "idle",
      bootstrapSubmittedAt: Math.max(0, finite(rollover.bootstrapSubmittedAt, 0)),
      bootstrapObservedAt: Math.max(0, finite(rollover.bootstrapObservedAt, 0)),
      bootstrapVerifiedAt: Math.max(0, finite(rollover.bootstrapVerifiedAt, 0)),
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
    const priorRollover = normalizeRollover(project.rollover);
    const rollover = priorRollover.sourcePageId && priorRollover.sourcePageId !== pageId ? freshRollover() : priorRollover;
    const retainAdvancedStage = ["handoff_ready", "successor_pending", "bootstrap_pending", "successor_bound", "resuming"].includes(rollover.stage);
    project.rollover = { ...rollover, mode: "hard", stage: retainAdvancedStage ? rollover.stage : "required", sourcePageId: pageId, reason: entry.rolloverReason, handoffAction: retainAdvancedStage ? rollover.handoffAction : "idle", handoffPromptText: retainAdvancedStage ? rollover.handoffPromptText : "", handoffPromptFingerprint: retainAdvancedStage ? rollover.handoffPromptFingerprint : "", handoffBaselineAssistantFingerprint: retainAdvancedStage ? rollover.handoffBaselineAssistantFingerprint : "", handoffBaselineUserFingerprint: retainAdvancedStage ? rollover.handoffBaselineUserFingerprint : "", handoffPromptPreparedAt: retainAdvancedStage ? rollover.handoffPromptPreparedAt : 0, startedAt: rollover.startedAt || at, updatedAt: at, error: "" };
    project.supervisor = Commands.normalizeSupervisorState(workflow.supervisor || project.supervisor);
    const checkpoint = cleanText(project.supervisor.lastProgressFingerprint, 180);
    if (checkpoint) project.latestVerifiedCheckpoint = { id: checkpoint, at: project.supervisor.lastProgressAt || at };
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

  function planProactiveRollover(rawProject, pageId, { workflow = {}, growth = {}, at = Date.now() } = {}) {
    const project = normalizeProject(rawProject, rawProject?.id, at);
    const page = cleanText(pageId, 1000);
    const activeWorkflow = Commands.normalizeWorkflow(workflow, at);
    const evidence = Commands.proactiveRolloverEvidence(activeWorkflow, growth);
    if (!evidence.triggered) return { ok: false, code: evidence.code, reason: evidence.reason, project, evidence };
    if (project.status !== "active" || project.currentConversationId !== page) return { ok: false, code: "project.proactive_not_active", reason: "Project is not active in this conversation", project, evidence };
    const source = project.conversationChain.find((entry) => entry.pageId === page);
    if (!source || source.doNotContinue) return { ok: false, code: "project.proactive_source_inert", reason: "Source conversation is not eligible for proactive rollover", project, evidence };
    const prior = normalizeRollover(project.rollover);
    const sameGenerationAttempt = prior.mode === "proactive" && prior.sourcePageId === page;
    const attempts = sameGenerationAttempt ? prior.proactiveAttempts : 0;
    const lastAttemptAt = sameGenerationAttempt ? prior.proactiveLastAttemptAt : 0;
    const limits = Commands.PROACTIVE_ROLLOVER_LIMITS;
    if (attempts >= limits.maxAttemptsPerGeneration) return { ok: false, code: "project.proactive_attempt_limit", reason: "Proactive rollover attempt limit reached for this conversation", project, evidence };
    if (lastAttemptAt && at - lastAttemptAt < limits.retryCooldownMs) return { ok: false, code: "project.proactive_cooldown", reason: "Proactive rollover retry cooldown is active", project, evidence };
    const rollover = freshRollover();
    project.status = "rollover_required";
    project.rollover = { ...rollover, mode: "proactive", stage: "required", sourcePageId: page, reason: cleanText(evidence.reason, 500), startedAt: at, updatedAt: at, proactiveAttempts: attempts + 1, proactiveLastAttemptAt: at, proactiveEvidenceCode: cleanText(evidence.code, 120), proactiveEvidenceMessages: evidence.metrics.totalMessages, proactiveEvidenceChars: evidence.metrics.visibleTextChars, proactiveEvidenceContinuations: evidence.metrics.continuations };
    project.supervisor = Commands.normalizeSupervisorState(activeWorkflow.supervisor || project.supervisor);
    const checkpoint = cleanText(project.supervisor.lastProgressFingerprint, 180);
    if (checkpoint) project.latestVerifiedCheckpoint = { id: checkpoint, at: project.supervisor.lastProgressAt || at };
    project.revision += 1; project.updatedAt = at;
    return { ok: true, code: "project.proactive_planned", project: normalizeProject(project, project.id, at), evidence };
  }

  function prepareProactiveHandoffGeneration(rawProject, { ownerId = "", leaseToken = "", baselineAssistantFingerprint = "", baselineUserFingerprint = "", at = Date.now() } = {}) {
    const project = normalizeProject(rawProject, rawProject?.id, at);
    if (!rolloverLeaseMatches(project, ownerId, leaseToken, at)) return { ok: false, code: "project.rollover_lease_lost", reason: "Rollover lease is not owned by this tab", project };
    if (project.rollover.mode !== "proactive" || project.rollover.stage !== "required") return { ok: false, code: "project.proactive_handoff_stage_invalid", reason: "Proactive handoff generation is not ready", project };
    const prompt = cleanText(handoffGenerationPrompt(project), MAX_BOOTSTRAP_LENGTH);
    project.rollover = { ...project.rollover, stage: "handoff_pending", handoffAction: "generate", handoffPromptText: prompt, handoffPromptFingerprint: Commands.fingerprint(prompt), handoffBaselineAssistantFingerprint: cleanText(baselineAssistantFingerprint, 180), handoffBaselineUserFingerprint: cleanText(baselineUserFingerprint, 180), handoffPromptPreparedAt: at, updatedAt: at, error: "" };
    project.revision += 1; project.updatedAt = at;
    return { ok: true, code: "project.proactive_handoff_generation_prepared", project: normalizeProject(project, project.id, at) };
  }


  function prepareProactiveHandoffVerification(rawProject, { ownerId = "", leaseToken = "", baselineAssistantFingerprint = "", baselineUserFingerprint = "", at = Date.now() } = {}) {
    const project = normalizeProject(rawProject, rawProject?.id, at);
    if (!rolloverLeaseMatches(project, ownerId, leaseToken, at)) return { ok: false, code: "project.rollover_lease_lost", reason: "Rollover lease is not owned by this tab", project };
    const handoff = normalizeHandoff(project.latestHandoff);
    if (project.rollover.mode !== "proactive" || project.rollover.stage !== "handoff_pending" || project.rollover.handoffAction !== "idle" || !handoff.text || handoff.verified) return { ok: false, code: "project.proactive_verification_stage_invalid", reason: "Proactive handoff verification is not ready", project };
    const prompt = cleanText(handoffVerificationPrompt(project), MAX_BOOTSTRAP_LENGTH);
    project.rollover = { ...project.rollover, handoffAction: "verify", handoffPromptText: prompt, handoffPromptFingerprint: Commands.fingerprint(prompt), handoffBaselineAssistantFingerprint: cleanText(baselineAssistantFingerprint, 180), handoffBaselineUserFingerprint: cleanText(baselineUserFingerprint, 180), handoffPromptPreparedAt: at, updatedAt: at, error: "" };
    project.revision += 1; project.updatedAt = at;
    return { ok: true, code: "project.proactive_handoff_verification_prepared", project: normalizeProject(project, project.id, at) };
  }

  function cancelProactiveRollover(rawProject, { ownerId = "", leaseToken = "", reason = "Proactive rollover aborted before navigation", at = Date.now() } = {}) {
    const project = normalizeProject(rawProject, rawProject?.id, at);
    if (!rolloverLeaseMatches(project, ownerId, leaseToken, at)) return { ok: false, code: "project.rollover_lease_lost", reason: "Rollover lease is not owned by this tab", project };
    const rollover = normalizeRollover(project.rollover);
    const source = project.conversationChain.find((entry) => entry.pageId === rollover.sourcePageId);
    const unsafeStage = ["successor_pending", "bootstrap_pending", "successor_bound", "resuming", "complete"].includes(rollover.stage);
    if (rollover.mode !== "proactive" || source?.doNotContinue || rollover.newChatOpeningAt || rollover.successorPageId || unsafeStage) return { ok: false, code: "project.proactive_abort_unsafe", reason: "Proactive rollover can no longer be safely aborted", project };
    project.status = "active";
    project.rollover = { ...rollover, stage: "failed", ownerId: "", leaseToken: "", leaseExpiresAt: 0, handoffAction: "idle", handoffPromptText: "", handoffPromptFingerprint: "", handoffBaselineAssistantFingerprint: "", handoffBaselineUserFingerprint: "", handoffPromptPreparedAt: 0, error: cleanText(reason, 500), updatedAt: at };
    project.revision += 1; project.updatedAt = at;
    return { ok: true, code: "project.proactive_aborted", project: normalizeProject(project, project.id, at) };
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
    project.rollover = { ...project.rollover, stage: nextStage, updatedAt: at, handoffSource: cleanText(handoffSource || project.rollover.handoffSource, 80), successorPageId: cleanText(successorPageId || project.rollover.successorPageId, 1000), newChatRequestedAt: nextStage === "successor_pending" ? (project.rollover.newChatRequestedAt || at) : project.rollover.newChatRequestedAt, error: cleanText(error, 500) };
    if (nextStage === "failed") project.status = "rollover_required";
    else if (nextStage === "complete") { project.status = "active"; project.rollover.ownerId = ""; project.rollover.leaseToken = ""; project.rollover.leaseExpiresAt = 0; }
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
    project.rollover = { ...project.rollover, stage: "handoff_pending", handoffFingerprint: parsed.fingerprint, handoffSource: "fresh_candidate", handoffAction: "idle", handoffPromptText: "", handoffPromptFingerprint: "", handoffBaselineAssistantFingerprint: "", handoffBaselineUserFingerprint: "", handoffPromptPreparedAt: 0, updatedAt: at, error: "" };
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
    project.rollover = { ...project.rollover, stage: "handoff_ready", handoffSource: "verified_handoff", handoffFingerprint: handoff.fingerprint, handoffAction: "idle", handoffPromptText: "", handoffPromptFingerprint: "", handoffBaselineAssistantFingerprint: "", handoffBaselineUserFingerprint: "", handoffPromptPreparedAt: 0, updatedAt: at, error: "" };
    project.revision += 1;
    project.updatedAt = at;
    return { ok: true, code: "project.handoff_verified", project: normalizeProject(project, project.id, at), verification: result };
  }

  function selectRolloverFallback(rawProject) {
    const project = normalizeProject(rawProject, rawProject?.id);
    const handoff = normalizeHandoff(project.latestHandoff);
    if (handoff.verified && handoff.text && handoff.generation === project.currentGeneration && handoff.sourcePageId === project.rollover.sourcePageId) return { kind: "verified_handoff", handoff, checkpoint: project.latestVerifiedCheckpoint, objective: project.objective };
    if (project.latestVerifiedCheckpoint.id) return { kind: "checkpoint", handoff: freshHandoff(), checkpoint: project.latestVerifiedCheckpoint, objective: project.objective };
    return { kind: "machine_state", handoff: freshHandoff(), checkpoint: project.latestVerifiedCheckpoint, objective: project.objective };
  }

  function applyRolloverFallback(rawProject, { ownerId = "", leaseToken = "", at = Date.now() } = {}) {
    const project = normalizeProject(rawProject, rawProject?.id, at);
    if (!rolloverLeaseMatches(project, ownerId, leaseToken, at)) return { ok: false, code: "project.rollover_lease_lost", reason: "Rollover lease is not owned by this tab", project };
    if (!["required", "handoff_pending"].includes(project.rollover.stage)) return { ok: false, code: "project.rollover_fallback_stage_invalid", reason: "Rollover fallback is not valid in this stage", project };
    const fallback = selectRolloverFallback(project);
    project.rollover = { ...project.rollover, stage: "handoff_ready", handoffSource: fallback.kind, handoffFingerprint: fallback.handoff.fingerprint || "", handoffAction: "idle", handoffPromptText: "", handoffPromptFingerprint: "", handoffBaselineAssistantFingerprint: "", handoffBaselineUserFingerprint: "", handoffPromptPreparedAt: 0, updatedAt: at, error: "" };
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

  function isDurableConversationPageId(value) {
    try {
      const parsed = new URL(String(value || ""));
      const host = parsed.hostname.toLowerCase();
      const validHost = host === "chatgpt.com" || host.endsWith(".chatgpt.com");
      const defaultPort = parsed.port === "" || parsed.port === "443";
      return parsed.protocol === "https:" && defaultPort && validHost
        && /(?:^|\/)c\/[^/]+$/i.test(parsed.pathname.replace(/\/+$/, ""));
    } catch {
      return false;
    }
  }

  function bootstrapVerificationMarker(token) {
    return "[YOLO:BOOTSTRAP_READY:" + cleanText(token, 180) + "]";
  }

  function bootstrapToken(rawProject) {
    const project = normalizeProject(rawProject, rawProject?.id);
    const fallback = selectRolloverFallback(project);
    const basis = fallback.kind === "verified_handoff"
      ? fallback.handoff.fingerprint
      : (fallback.checkpoint.id || fallback.kind);
    return Commands.fingerprint(project.id + "|" + (project.currentGeneration + 1) + "|" + basis);
  }

  function bootstrapPrompt(rawProject) {
    const project = normalizeProject(rawProject, rawProject?.id);
    const fallback = selectRolloverFallback(project);
    const token = bootstrapToken(project);
    const context = fallback.kind === "verified_handoff"
      ? fallback.handoff.text
      : fallback.kind === "checkpoint"
        ? "Latest verified checkpoint id: " + fallback.checkpoint.id + ". Recover exact state from durable project files/tools before continuing."
        : "No semantic handoff was safely available. Recover exact state from durable project files/tools and the project objective before continuing.";
    return [
      "Continue this existing long-running project in a fresh ChatGPT conversation. This is a rollover, not a new project.",
      "Project-ID: " + project.id,
      "Generation: " + (project.currentGeneration + 1),
      "Original objective: " + project.originalRequirements,
      "Rollover context:", context,
      "Preserve settled requirements. Verify uncertain state from durable files/tools. Do not redo settled audits or claim unverified work.",
      "For this bootstrap response only, summarize the state you successfully recovered and the first concrete next action. End with exactly:",
      bootstrapVerificationMarker(token)
    ].join("\n\n");
  }

  function markNewChatOpening(rawProject, options = {}) {
    const { ownerId = "", leaseToken = "", at = Date.now() } = options;
    const project = normalizeProject(rawProject, rawProject?.id, at);
    if (!rolloverLeaseMatches(project, ownerId, leaseToken, at)) return { ok: false, code: "project.rollover_lease_lost", reason: "Rollover lease is not owned by this tab", project };
    if (project.rollover.stage !== "bootstrap_pending" || project.rollover.bootstrapState !== "prepared") return { ok: false, code: "project.new_chat_stage_invalid", reason: "New Chat navigation is not ready", project };
    if (project.rollover.successorPageId) return { ok: false, code: "project.successor_already_known", reason: "Successor conversation already exists", project };
    if (project.rollover.newChatOpeningAt) return { ok: true, code: "project.new_chat_opening", project, alreadyMarked: true };
    const source = project.conversationChain.find((entry) => entry.pageId === project.rollover.sourcePageId);
    if (source && !source.doNotContinue) { source.doNotContinue = true; source.status = project.rollover.mode === "hard" ? "exhausted" : "rolling_over"; source.endedAt = at; source.rolloverReason = source.rolloverReason || project.rollover.reason; source.finalPromptFingerprint = cleanText(options.finalPromptFingerprint || source.finalPromptFingerprint, 180); source.finalAssistantFingerprint = cleanText(options.finalAssistantFingerprint || source.finalAssistantFingerprint, 180); source.lastVerifiedCheckpoint = cleanText(options.lastVerifiedCheckpoint || source.lastVerifiedCheckpoint, 180); }
    project.rollover = { ...project.rollover, newChatOpeningAt: at, updatedAt: at, error: "" };
    project.revision += 1; project.updatedAt = at;
    return { ok: true, code: "project.new_chat_opening", project: normalizeProject(project, project.id, at), alreadyMarked: false };
  }

  function prepareBootstrap(rawProject, options = {}) {
    const { ownerId = "", leaseToken = "", at = Date.now() } = options;
    const project = normalizeProject(rawProject, rawProject?.id, at);
    if (!rolloverLeaseMatches(project, ownerId, leaseToken, at)) return { ok: false, code: "project.rollover_lease_lost", reason: "Rollover lease is not owned by this tab", project };
    if (project.rollover.stage !== "successor_pending") return { ok: false, code: "project.bootstrap_stage_invalid", reason: "Bootstrap is not ready to prepare", project };
    const text = cleanText(bootstrapPrompt(project), MAX_BOOTSTRAP_LENGTH);
    const token = bootstrapToken(project);
    project.rollover = {
      ...project.rollover,
      stage: "bootstrap_pending",
      bootstrapText: text,
      bootstrapFingerprint: Commands.fingerprint(text),
      bootstrapToken: token,
      bootstrapState: "prepared",
      updatedAt: at,
      error: ""
    };
    project.revision += 1;
    project.updatedAt = at;
    return { ok: true, code: "project.bootstrap_prepared", project: normalizeProject(project, project.id, at) };
  }

  function markBootstrapSubmitting(rawProject, options = {}) {
    const { ownerId = "", leaseToken = "", at = Date.now() } = options;
    const project = normalizeProject(rawProject, rawProject?.id, at);
    if (!rolloverLeaseMatches(project, ownerId, leaseToken, at)) return { ok: false, code: "project.rollover_lease_lost", reason: "Rollover lease is not owned by this tab", project };
    if (project.rollover.stage !== "bootstrap_pending" || project.rollover.bootstrapState !== "prepared") return { ok: false, code: "project.bootstrap_not_prepared", reason: "Bootstrap is not safely prepared", project };
    project.rollover = { ...project.rollover, bootstrapState: "submitting", bootstrapSubmittedAt: at, updatedAt: at, error: "" };
    project.revision += 1;
    project.updatedAt = at;
    return { ok: true, code: "project.bootstrap_submitting", project: normalizeProject(project, project.id, at) };
  }

  function observeBootstrapSuccessor(rawProject, successorPageId, observedUserText, options = {}) {
    const { ownerId = "", leaseToken = "", at = Date.now() } = options;
    const project = normalizeProject(rawProject, rawProject?.id, at);
    if (!rolloverLeaseMatches(project, ownerId, leaseToken, at)) return { ok: false, code: "project.rollover_lease_lost", reason: "Rollover lease is not owned by this tab", project };
    if (project.rollover.stage !== "bootstrap_pending" || project.rollover.bootstrapState !== "submitting") return { ok: false, code: "project.bootstrap_not_submitting", reason: "Bootstrap submission is not awaiting observation", project };
    const successor = cleanText(successorPageId, 1000);
    if (!isDurableConversationPageId(successor) || successor === project.rollover.sourcePageId) return { ok: false, code: "project.successor_invalid", reason: "Successor must be a new durable ChatGPT conversation", project };
    if (project.conversationChain.some((entry) => entry.pageId === successor)) return { ok: false, code: "project.successor_duplicate", reason: "Successor conversation is already in this project lineage", project };
    const observedFingerprint = Commands.fingerprint(String(observedUserText || "").trim());
    if (!observedFingerprint || observedFingerprint !== project.rollover.bootstrapFingerprint) return { ok: false, code: "project.bootstrap_receipt_mismatch", reason: "Observed user message does not match the durable bootstrap", project };
    project.rollover = { ...project.rollover, successorPageId: successor, bootstrapState: "observed", bootstrapObservedAt: at, updatedAt: at, error: "" };
    project.revision += 1;
    project.updatedAt = at;
    return { ok: true, code: "project.bootstrap_observed", project: normalizeProject(project, project.id, at) };
  }

  function evaluateBootstrapVerification(text, token) {
    const value = String(text || "").trim();
    const markers = [...value.matchAll(/(?:^|\n)[ \t]*\[YOLO:BOOTSTRAP_READY:([^\]\r\n]{1,180})\][ \t]*(?=\n|$)/gi)];
    if (markers.length !== 1) return { kind: markers.length ? "malformed" : "missing", token: "" };
    const terminal = value.match(/(?:^|\n)[ \t]*\[YOLO:BOOTSTRAP_READY:([^\]\r\n]{1,180})\][ \t]*$/i);
    if (!terminal) return { kind: "malformed", token: "" };
    const found = cleanText(terminal[1], 180);
    if (found !== cleanText(token, 180)) return { kind: "stale", token: found };
    return { kind: "verified", token: found };
  }

  function verifyBootstrapSuccessor(rawProject, responseText, options = {}) {
    const { ownerId = "", leaseToken = "", at = Date.now() } = options;
    const project = normalizeProject(rawProject, rawProject?.id, at);
    if (!rolloverLeaseMatches(project, ownerId, leaseToken, at)) return { ok: false, code: "project.rollover_lease_lost", reason: "Rollover lease is not owned by this tab", project };
    if (project.rollover.stage !== "bootstrap_pending" || project.rollover.bootstrapState !== "observed" || !project.rollover.successorPageId) return { ok: false, code: "project.bootstrap_not_observed", reason: "Bootstrap successor is not ready for verification", project };
    const verification = evaluateBootstrapVerification(responseText, project.rollover.bootstrapToken);
    if (verification.kind !== "verified") return { ok: false, code: "project.bootstrap_" + verification.kind, reason: "Bootstrap verification was " + verification.kind, project, verification };
    const successor = project.rollover.successorPageId;
    const nextGeneration = project.currentGeneration + 1;
    const sourceEntry = project.conversationChain.find((entry) => entry.pageId === project.rollover.sourcePageId);
    if (sourceEntry) { sourceEntry.successorPageId = successor; sourceEntry.doNotContinue = true; if (sourceEntry.status === "active") sourceEntry.status = "rolling_over"; sourceEntry.endedAt = sourceEntry.endedAt || at; }
    project.conversationChain.push(freshConversation(successor, nextGeneration, at));
    project.currentConversationId = successor;
    project.currentGeneration = nextGeneration;
    project.status = "rolling_over";
    project.rollover = {
      ...project.rollover,
      stage: "successor_bound",
      bootstrapState: "verified",
      bootstrapVerifiedAt: at,
      updatedAt: at,
      error: ""
    };
    project.revision += 1;
    project.updatedAt = at;
    return { ok: true, code: "project.bootstrap_verified", project: normalizeProject(project, project.id, at), verification };
  }

  function cancelBootstrapSubmission(rawProject, options = {}) {
    const { ownerId = "", leaseToken = "", at = Date.now() } = options;
    const project = normalizeProject(rawProject, rawProject?.id, at);
    if (!rolloverLeaseMatches(project, ownerId, leaseToken, at)) return { ok: false, code: "project.rollover_lease_lost", reason: "Rollover lease is not owned by this tab", project };
    if (project.rollover.stage !== "bootstrap_pending" || project.rollover.bootstrapState !== "submitting" || project.rollover.successorPageId) return { ok: false, code: "project.bootstrap_cancel_unsafe", reason: "Bootstrap submission can no longer be safely cancelled", project };
    project.rollover = { ...project.rollover, bootstrapState: "prepared", bootstrapSubmittedAt: 0, updatedAt: at, error: "" };
    project.revision += 1; project.updatedAt = at;
    return { ok: true, code: "project.bootstrap_submission_cancelled", project: normalizeProject(project, project.id, at) };
  }

  function markBootstrapDeliveryUnknown(rawProject, options = {}) {
    const { ownerId = "", leaseToken = "", at = Date.now(), reason = "Bootstrap delivery could not be confirmed" } = options;
    const project = normalizeProject(rawProject, rawProject?.id, at);
    if (!rolloverLeaseMatches(project, ownerId, leaseToken, at)) return { ok: false, code: "project.rollover_lease_lost", reason: "Rollover lease is not owned by this tab", project };
    if (project.rollover.stage !== "bootstrap_pending" || project.rollover.bootstrapState !== "submitting") return { ok: false, code: "project.bootstrap_state_invalid", reason: "Bootstrap delivery is not ambiguous", project };
    project.rollover = { ...project.rollover, bootstrapState: "delivery_unknown", error: cleanText(reason, 500), updatedAt: at };
    project.status = "rollover_required";
    project.revision += 1;
    project.updatedAt = at;
    return { ok: true, code: "project.bootstrap_delivery_unknown", project: normalizeProject(project, project.id, at) };
  }

  return Object.freeze({
    PROJECT_SCHEMA_VERSION,
    MAX_PROJECTS,
    MAX_CONVERSATIONS,
    MAX_BOOTSTRAP_LENGTH,
    ROLLOVER_LEASE_MS,
    ROLLOVER_STAGES,
    BOOTSTRAP_STATES,
    ROLLOVER_MODES,
    HANDOFF_ACTIONS,
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
    planProactiveRollover,
    prepareProactiveHandoffGeneration,
    prepareProactiveHandoffVerification,
    cancelProactiveRollover,
    advanceRollover,
    parseHandoffCandidate,
    saveHandoffCandidate,
    handoffVerificationMarker,
    evaluateHandoffVerification,
    verifyHandoff,
    selectRolloverFallback,
    applyRolloverFallback,
    handoffGenerationPrompt,
    handoffVerificationPrompt,
    isDurableConversationPageId,
    bootstrapVerificationMarker,
    bootstrapToken,
    bootstrapPrompt,
    markNewChatOpening,
    prepareBootstrap,
    markBootstrapSubmitting,
    observeBootstrapSuccessor,
    evaluateBootstrapVerification,
    verifyBootstrapSuccessor,
    cancelBootstrapSubmission,
    markBootstrapDeliveryUnknown
  });
});
