((root, factory) => {
  const Shared = typeof module === "object" && module.exports ? require("./shared.js") : root.YOLOShared;
  const Commands = typeof module === "object" && module.exports ? require("./commands.js") : root.YOLOCommands;
  const api = factory(Shared, Commands);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YOLOProjects = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (Shared, Commands) => {
  "use strict";

  const PROJECT_SCHEMA_VERSION = 1;
  const MAX_PROJECTS = 100;
  const MAX_CONVERSATIONS = 64;
  const PROJECT_STATUSES = new Set(["active", "rollover_required", "rolling_over", "completed", "stopped"]);
  const CONVERSATION_STATUSES = new Set(["active", "rolling_over", "exhausted", "completed", "failed"]);
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
      latestHandoff: { text: "", verified: false, at: 0 },
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
    if (currentConversation?.doNotContinue && !["completed", "stopped"].includes(status)) status = "rollover_required";
    const checkpoint = raw?.latestVerifiedCheckpoint && typeof raw.latestVerifiedCheckpoint === "object"
      ? raw.latestVerifiedCheckpoint : {};
    const handoff = raw?.latestHandoff && typeof raw.latestHandoff === "object" ? raw.latestHandoff : {};
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
      latestHandoff: { text: cleanText(handoff.text, 12000), verified: Boolean(handoff.verified), at: Math.max(0, finite(handoff.at, 0)) },
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
    project.status = "rollover_required";
    project.currentConversationId = pageId;
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

  return Object.freeze({
    PROJECT_SCHEMA_VERSION,
    MAX_PROJECTS,
    MAX_CONVERSATIONS,
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
    tombstoneForConversation
  });
});
