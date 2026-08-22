"use strict";

importScripts("config.js", "shared.js", "coordinator.js", "portable-store.js", "queue.js", "commands.js", "projects.js");

const Config = globalThis.YOLOConfig;
const Shared = globalThis.YOLOShared;
const Coordinator = globalThis.YOLOCoordinator;
const PortableStore = globalThis.YOLOPortableStore;
const Queue = globalThis.YOLOQueue;
const Commands = globalThis.YOLOCommands;
const Projects = globalThis.YOLOProjects;
const queueLock = Shared.createLock();
const workflowLock = Shared.createLock();
const projectLock = Shared.createLock();
const actionLock = Shared.createLock();
const MAX_CONVERSATION_QUEUES = 25;
const MAX_ACTIVE_WORKFLOWS = 25;
const MAX_RETAINED_COMPLETED_WORKFLOWS = 100;
const ACTIVE_WORKFLOW_STATUSES = new Set(["running", "paused", "stalled", "rate_limited", "human_required", "rollover_required", "blocked"]);
const WORKFLOW_LEASE_MS = 2 * 60 * 1000;
const WORKFLOW_RENEW_WINDOW_MS = 30 * 1000;

const storageGet = Shared.storageGet;
const storageSet = Shared.storageSet;
const storageRemove = Shared.storageRemove;
const withLock = Shared.withLock;

async function readQueueMap() {
  const stored = await storageGet([Config.STORAGE_KEYS.queues]);
  const value = stored[Config.STORAGE_KEYS.queues];
  return value && typeof value === "object" ? value : {};
}

async function readQueueState(pageId) {
  return withLock(queueLock, async () => {
    const map = await readQueueMap();
    const state = Queue.normalizeState(map[pageId]);
    return { ok: true, state, summary: Queue.summary(state) };
  });
}

async function readProjectMap() {
  const stored = await storageGet([Config.STORAGE_KEYS.projects]);
  return Projects.normalizeProjectMap(stored[Config.STORAGE_KEYS.projects]);
}

async function automationBlockForPage(pageId) {
  const map = await readProjectMap();
  const tombstone = Projects.tombstoneForConversation(map, pageId);
  if (!tombstone) return null;
  return {
    ok: false,
    reason: "This ChatGPT conversation is exhausted and permanently blocked from YOLO automated continuation",
    code: "project.conversation_exhausted",
    projectId: tombstone.projectId,
    successorPageId: tombstone.conversation.successorPageId || ""
  };
}

function ensureQueueCapacity(map, pageId, current) {
  if (Object.prototype.hasOwnProperty.call(map, pageId) || Object.keys(map).length < MAX_CONVERSATION_QUEUES) return null;
  const emptyQueues = Object.entries(map)
    .filter(([, value]) => Queue.normalizeState(value).items.length === 0)
    .sort((a, b) => (a[1]?.updatedAt || 0) - (b[1]?.updatedAt || 0));
  while (Object.keys(map).length >= MAX_CONVERSATION_QUEUES && emptyQueues.length) {
    delete map[emptyQueues.shift()[0]];
  }
  if (Object.keys(map).length < MAX_CONVERSATION_QUEUES) return null;
  return {
    ok: false,
    reason: `Active queue limit of ${MAX_CONVERSATION_QUEUES} conversations reached; clear an old queue first`,
    code: "queue.conversation_limit",
    state: current,
    summary: Queue.summary(current)
  };
}

async function mutateQueue(pageId, mutator) {
  return withLock(queueLock, async () => {
    const map = await readQueueMap();
    const current = Queue.normalizeState(map[pageId]);
    const result = await mutator(current);
    const state = Queue.normalizeState(result?.state || current);
    const capacityError = ensureQueueCapacity(map, pageId, current);
    if (capacityError) return capacityError;

    delete map[pageId];
    map[pageId] = state;
    await storageSet({ [Config.STORAGE_KEYS.queues]: map });
    return { ...result, state, summary: Queue.summary(state) };
  });
}

function validPageId(pageId) {
  return typeof pageId === "string" && pageId.length <= 1000 && Config.isDurablePageId(pageId);
}

function senderMatchesPageId(sender, pageId) {
  if (!sender?.tab?.url) return true;
  if (!Config.isSupportedUrl(sender.tab.url)) return false;
  return Config.pageId(sender.tab.url) === pageId;
}

async function mutateActionGuards(mutator) {
  return withLock(actionLock, async () => {
    const stored = await storageGet([Config.STORAGE_KEYS.actionGuards]);
    const current = Coordinator.normalizeState(stored[Config.STORAGE_KEYS.actionGuards]);
    const result = await mutator(current);
    const state = Coordinator.normalizeState(result?.state || current);
    await storageSet({ [Config.STORAGE_KEYS.actionGuards]: state });
    return { ...result, state };
  });
}

async function handleActionMessage(message, sender) {
  const pageId = message.pageId;
  if (!validPageId(pageId)) return { ok: false, reason: "A saved ChatGPT conversation is required", code: "action.page_invalid" };
  if (!senderMatchesPageId(sender, pageId)) {
    return { ok: false, reason: "Conversation identifier does not match the sending tab", code: "action.page_mismatch" };
  }
  if (["YOLO_ACTION_CLAIM", "YOLO_ACTION_BEGIN"].includes(message.type)) {
    const blocked = await automationBlockForPage(pageId);
    if (blocked) return blocked;
  }
  const actionKey = String(message.actionKey || "").trim().slice(0, 240);
  if (message.type !== "YOLO_ACTION_RESET" && !actionKey) {
    return { ok: false, reason: "Action key is required", code: "action.guard_invalid" };
  }
  const guardKey = `${pageId}::${actionKey}`;
  if (message.type === "YOLO_ACTION_CLAIM") {
    return mutateActionGuards((state) => Coordinator.claim(state, guardKey, message.ownerId, {
      leaseMs: message.leaseMs,
      cooldownMs: message.cooldownMs
    }));
  }
  if (message.type === "YOLO_ACTION_BEGIN") {
    return mutateActionGuards((state) => Coordinator.begin(state, guardKey, message.token));
  }
  if (message.type === "YOLO_ACTION_COMPLETE") {
    return mutateActionGuards((state) => Coordinator.complete(state, guardKey, message.token));
  }
  if (message.type === "YOLO_ACTION_RELEASE") {
    return mutateActionGuards((state) => Coordinator.release(state, guardKey, message.token));
  }
  if (message.type === "YOLO_ACTION_RESET") {
    return mutateActionGuards((state) => actionKey
      ? Coordinator.reset(state, guardKey)
      : Coordinator.resetPrefix(state, `${pageId}::`));
  }
  return { ok: false, reason: "Unknown action guard operation", code: "action.unknown" };
}

function normalizeTemplate(raw, fallbackId = "") {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name || "").trim().slice(0, 80);
  const text = String(raw.text || "").trim().slice(0, Queue.MAX_TEXT_LENGTH);
  if (!name || !text) return null;
  const requestedId = String(raw.id || fallbackId || "").trim().slice(0, 180);
  return {
    id: requestedId || Queue.makeId("template"),
    name,
    text,
    builtIn: Boolean(raw.builtIn),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now()
  };
}

function templatesFromStorage(stored) {
  const raw = Array.isArray(stored?.[Config.STORAGE_KEYS.templates])
    ? stored[Config.STORAGE_KEYS.templates]
    : Config.DEFAULT_TEMPLATES;
  const templates = [];
  const ids = new Set();
  for (const entry of raw) {
    if (templates.length >= 50) break;
    const template = normalizeTemplate(entry);
    if (!template || ids.has(template.id)) continue;
    ids.add(template.id);
    templates.push(template);
  }
  return templates;
}

function templateMutationPlan(message, stored) {
  let templates = templatesFromStorage(stored);
  const now = Date.now();
  if (message.type === "YOLO_TEMPLATES_RESET") {
    templates = Config.DEFAULT_TEMPLATES.map((template) => normalizeTemplate({ ...template, createdAt: now, updatedAt: now }));
    return { setItems: { [Config.STORAGE_KEYS.templates]: templates }, result: { templates } };
  }
  if (message.type === "YOLO_TEMPLATE_ADD") {
    const requestedId = String(message.template?.id || "").trim().slice(0, 180);
    if (!requestedId) return { ok: false, reason: "Template identifier is required", code: "template.id_required" };
    const existing = templates.find((template) => template.id === requestedId);
    if (existing) return { mutate: false, result: { templates, template: existing, deduplicated: true } };
    if (templates.length >= 50) return { ok: false, reason: "Template limit reached", code: "template.limit" };
    const template = normalizeTemplate({ ...message.template, id: requestedId, createdAt: now, updatedAt: now });
    if (!template) return { ok: false, reason: "Template name and text are required" };
    templates.push(template);
    return { setItems: { [Config.STORAGE_KEYS.templates]: templates }, result: { templates, template } };
  }
  if (message.type === "YOLO_TEMPLATE_UPDATE") {
    const requestedId = String(message.template?.id || "").trim().slice(0, 180);
    const index = templates.findIndex((template) => template.id === requestedId);
    if (index < 0) return { ok: false, reason: "Template not found" };
    const template = normalizeTemplate({ ...templates[index], ...message.template, id: requestedId, builtIn: false, updatedAt: now });
    if (!template) return { ok: false, reason: "Template name and text are required" };
    templates[index] = template;
    return { setItems: { [Config.STORAGE_KEYS.templates]: templates }, result: { templates, template } };
  }
  if (message.type === "YOLO_TEMPLATE_REMOVE") {
    const requestedId = String(message.templateId || "").trim().slice(0, 180);
    if (!templates.some((entry) => entry.id === requestedId)) return { ok: false, reason: "Template not found" };
    templates = templates.filter((entry) => entry.id !== requestedId);
    return { setItems: { [Config.STORAGE_KEYS.templates]: templates }, result: { templates } };
  }
  if (message.type === "YOLO_TEMPLATES_REORDER") {
    const order = Array.isArray(message.orderedIds) ? message.orderedIds.map((id) => String(id).trim().slice(0, 180)) : [];
    const byId = new Map(templates.map((template) => [template.id, template]));
    const ordered = [];
    for (const id of order) {
      if (!byId.has(id)) continue;
      ordered.push(byId.get(id));
      byId.delete(id);
    }
    for (const template of templates) if (byId.has(template.id)) ordered.push(template);
    return { setItems: { [Config.STORAGE_KEYS.templates]: ordered }, result: { templates: ordered } };
  }
  return { ok: false, reason: "Unknown template operation" };
}

async function handleTemplateMessage(message) {
  if (message.type === "YOLO_TEMPLATES_GET") {
    return PortableStore.read(({ stored, revision }) => ({ ok: true, templates: templatesFromStorage(stored), revision }));
  }
  return PortableStore.mutate(({ stored }) => templateMutationPlan(message, stored));
}

async function activeWorkflowLimitError(key, current, workflow) {
  const startsActiveWorkflow = ACTIVE_WORKFLOW_STATUSES.has(workflow.status) && !ACTIVE_WORKFLOW_STATUSES.has(current.status);
  if (!startsActiveWorkflow) return null;

  const allStored = await storageGet(null);
  const workflowEntries = Object.entries(allStored)
    .filter(([storedKey]) => storedKey.startsWith("yoloWorkflow:") && storedKey !== key)
    .map(([storedKey, value]) => [storedKey, Commands.normalizeWorkflow(value)]);
  const activeCount = workflowEntries.filter(([, entry]) => ACTIVE_WORKFLOW_STATUSES.has(entry.status)).length;
  if (activeCount >= MAX_ACTIVE_WORKFLOWS) {
    return {
      ok: false,
      reason: `Active workflow limit of ${MAX_ACTIVE_WORKFLOWS} conversations reached; pause or clear an old workflow first`,
      code: "workflow.conversation_limit",
      workflow: current
    };
  }

  const completed = workflowEntries
    .filter(([, entry]) => entry.status === "completed")
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const excess = completed.slice(0, Math.max(0, completed.length - MAX_RETAINED_COMPLETED_WORKFLOWS));
  if (excess.length) await storageRemove(excess.map(([storedKey]) => storedKey));
  return null;
}

async function enqueueWorkflowPrompt(pageId, key, current, message) {
  return withLock(queueLock, async () => {
    const projectMap = await readProjectMap();
    const tombstone = Projects.tombstoneForConversation(projectMap, pageId);
    if (tombstone) return { ok: false, reason: "Exhausted conversations cannot queue automated workflow prompts", code: "project.conversation_exhausted", workflow: current };
    const map = await readQueueMap();
    const queueCurrent = Queue.normalizeState(map[pageId]);
    const queueResult = Queue.addItem(queueCurrent, message.item, { front: true });
    if (!queueResult.ok) return { ...queueResult, workflow: current, summary: Queue.summary(queueCurrent) };
    const capacityError = ensureQueueCapacity(map, pageId, queueCurrent);
    if (capacityError) return { ...capacityError, workflow: current };

    const timestamp = Date.now();
    const ownerId = String(message.ownerId || "").trim().slice(0, 220);
    const baseWorkflow = Commands.normalizeWorkflow({
      ...message.workflow,
      revision: current.revision + 1,
      pendingItemId: queueResult.item.id,
      awaitingResponse: false,
      sawGeneration: false,
      responseCandidateFingerprint: "",
      responseCandidateSince: 0,
      runnerId: ownerId,
      runnerExpiresAt: ownerId ? timestamp + WORKFLOW_LEASE_MS : 0,
      updatedAt: timestamp
    });
    const linked = Projects.ensureProjectForWorkflow(projectMap, pageId, baseWorkflow, timestamp);
    const workflow = linked.workflow;
    const limitError = await activeWorkflowLimitError(key, current, workflow);
    if (limitError) return limitError;

    delete map[pageId];
    map[pageId] = queueResult.state;
    await storageSet({
      [Config.STORAGE_KEYS.queues]: map,
      [key]: workflow,
      ...(linked.project ? { [Config.STORAGE_KEYS.projects]: linked.map } : {})
    });
    return {
      ok: true,
      workflow,
      item: queueResult.item,
      state: queueResult.state,
      summary: Queue.summary(queueResult.state)
    };
  });
}

async function completeQueueClaim(pageId, message) {
  // Workflow enqueue already uses workflow -> queue lock order. Keep the same order here.
  return withLock(workflowLock, () => withLock(queueLock, async () => {
    const map = await readQueueMap();
    const queueCurrent = Queue.normalizeState(map[pageId]);
    const queueResult = Queue.completeClaim(queueCurrent, message.itemId, message.claimToken);
    if (!queueResult.ok) return { ...queueResult, state: queueCurrent, summary: Queue.summary(queueCurrent) };

    const queueState = Queue.normalizeState(queueResult.state);
    const setItems = { [Config.STORAGE_KEYS.queues]: { ...map, [pageId]: queueState } };
    let workflow = null;
    const completedItem = queueResult.item;
    if (completedItem?.source?.startsWith("workflow:") && completedItem.sourceId) {
      const key = Config.workflowKey(pageId);
      const stored = await storageGet([key]);
      const current = Commands.normalizeWorkflow(stored[key]);
      if (current.status === "running"
        && current.id === completedItem.sourceId
        && current.pendingItemId === completedItem.id) {
        workflow = Commands.normalizeWorkflow({
          ...current,
          revision: current.revision + 1,
          pendingItemId: "",
          awaitingResponse: true,
          sawGeneration: false,
          responseCandidateFingerprint: "",
          responseCandidateSince: 0,
          reason: "Waiting for ChatGPT",
          updatedAt: Date.now()
        });
        setItems[key] = workflow;
      }
    }

    await storageSet(setItems);
    return {
      ...queueResult,
      state: queueState,
      summary: Queue.summary(queueState),
      ...(workflow ? { workflow } : {})
    };
  }));
}

async function handleWorkflowMessage(message, sender) {
  const pageId = message.pageId;
  if (!validPageId(pageId)) return { ok: false, reason: "Invalid conversation identifier", code: "workflow.page_invalid" };
  if (!senderMatchesPageId(sender, pageId)) {
    return { ok: false, reason: "Conversation identifier does not match the sending tab", code: "workflow.page_mismatch" };
  }

  return withLock(workflowLock, () => withLock(projectLock, async () => {
    const key = Config.workflowKey(pageId);
    const stored = await storageGet([key]);
    const current = Commands.normalizeWorkflow(stored[key]);
    const projectMap = await readProjectMap();
    const tombstone = Projects.tombstoneForConversation(projectMap, pageId);

    if (message.type === "YOLO_WORKFLOW_GET") {
      if (current.kind === "goal" && current.objective && !current.projectId) {
        const linked = Projects.ensureProjectForWorkflow(projectMap, pageId, current);
        const workflow = Commands.normalizeWorkflow({ ...linked.workflow, revision: current.revision + 1 });
        await storageSet({ [key]: workflow, [Config.STORAGE_KEYS.projects]: linked.map });
        return { ok: true, workflow, project: linked.project };
      }
      return { ok: true, workflow: current };
    }

    if (message.type === "YOLO_WORKFLOW_SET") {
      const expectedRevision = Math.max(0, Math.round(Number(message.expectedRevision) || 0));
      if (expectedRevision !== current.revision) {
        return { ok: false, reason: "Workflow changed in another tab", code: "workflow.conflict", workflow: current };
      }
      const requested = Commands.normalizeWorkflow({ ...message.workflow, revision: current.revision + 1 });
      if (tombstone && requested.status === "running") {
        return { ok: false, reason: "Exhausted conversations cannot restart automated workflows", code: "project.conversation_exhausted", workflow: current };
      }
      const linked = Projects.ensureProjectForWorkflow(projectMap, pageId, requested);
      const workflow = linked.workflow;
      const limitError = await activeWorkflowLimitError(key, current, workflow);
      if (limitError) return limitError;
      await storageSet({ [key]: workflow, ...(linked.project ? { [Config.STORAGE_KEYS.projects]: linked.map } : {}) });
      return { ok: true, workflow, ...(linked.project ? { project: linked.project } : {}) };
    }

    if (tombstone && ["YOLO_WORKFLOW_QUEUE_ADD", "YOLO_WORKFLOW_CLAIM"].includes(message.type)) {
      return { ok: false, reason: "Exhausted conversations cannot continue automated workflows", code: "project.conversation_exhausted", workflow: current };
    }

    if (message.type === "YOLO_WORKFLOW_QUEUE_ADD") {
      const expectedRevision = Math.max(0, Math.round(Number(message.expectedRevision) || 0));
      if (expectedRevision !== current.revision) {
        return { ok: false, reason: "Workflow changed in another tab", code: "workflow.conflict", workflow: current };
      }
      return enqueueWorkflowPrompt(pageId, key, current, message);
    }

    if (message.type === "YOLO_WORKFLOW_CLEAR") {
      const expectedRevision = Math.max(0, Math.round(Number(message.expectedRevision) || 0));
      if (expectedRevision !== current.revision) {
        return { ok: false, reason: "Workflow changed in another tab", code: "workflow.conflict", workflow: current };
      }
      await storageRemove([key]);
      return { ok: true, workflow: Commands.freshWorkflow() };
    }

    if (message.type === "YOLO_WORKFLOW_CLAIM") {
      if (current.status !== "running") return { ok: false, reason: "Workflow is not running", code: "workflow.not_running", workflow: current };
      const ownerId = String(message.ownerId || "").trim().slice(0, 220);
      if (!ownerId) return { ok: false, reason: "Workflow runner identifier is required", code: "workflow.owner_invalid", workflow: current };
      const timestamp = Date.now();
      if (current.runnerId && current.runnerId !== ownerId && current.runnerExpiresAt > timestamp) {
        return { ok: false, reason: "Workflow is active in another tab", code: "workflow.busy", workflow: current };
      }
      if (current.runnerId === ownerId && current.runnerExpiresAt > timestamp + WORKFLOW_RENEW_WINDOW_MS) {
        return { ok: true, workflow: current, renewed: false };
      }
      const workflow = Commands.normalizeWorkflow({
        ...current,
        revision: current.revision + 1,
        runnerId: ownerId,
        runnerExpiresAt: timestamp + WORKFLOW_LEASE_MS,
        updatedAt: timestamp
      });
      await storageSet({ [key]: workflow });
      return { ok: true, workflow, renewed: true };
    }

    if (message.type === "YOLO_WORKFLOW_RELEASE") {
      const ownerId = String(message.ownerId || "").trim().slice(0, 220);
      if (current.runnerId !== ownerId) return { ok: true, workflow: current, released: false };
      const workflow = Commands.normalizeWorkflow({
        ...current,
        revision: current.revision + 1,
        runnerId: "",
        runnerExpiresAt: 0,
        updatedAt: Date.now()
      });
      await storageSet({ [key]: workflow });
      return { ok: true, workflow, released: true };
    }

    return { ok: false, reason: "Unknown workflow operation" };
  }));
}

function projectMutationOwner(message, sender) {
  const tabId = Number(sender?.tab?.id);
  if (Number.isInteger(tabId) && tabId >= 0) return "tab:" + tabId;
  return String(message?.ownerId || "").trim().slice(0, 220);
}

async function handleProjectMessage(message, sender) {
  const pageId = String(message.pageId || "").trim().slice(0, 1000);
  const projectId = String(message.projectId || "").trim().slice(0, 180);
  if (sender?.tab?.url && !Config.isSupportedUrl(sender.tab.url)) {
    return { ok: false, reason: "Project operations require a ChatGPT tab", code: "project.sender_invalid" };
  }
  if (pageId && (!validPageId(pageId) || !senderMatchesPageId(sender, pageId))) {
    return { ok: false, reason: "Conversation identifier does not match the sending tab", code: "project.page_mismatch" };
  }
  if (!pageId && !projectId) return { ok: false, reason: "Project or conversation identifier is required", code: "project.id_required" };

  return withLock(projectLock, async () => {
    const map = await readProjectMap();
    const found = projectId
      ? { projectId, project: map[projectId] || null }
      : Projects.findProjectByConversation(map, pageId);
    const current = found.project ? Projects.normalizeProject(found.project, found.projectId) : null;

    if (message.type === "YOLO_PROJECT_GET") return { ok: true, project: current };
    if (!current) return { ok: false, reason: "Project not found", code: "project.not_found" };

    const expectedRevision = Math.max(0, Math.round(Number(message.expectedRevision) || 0));
    if (expectedRevision !== current.revision) {
      return { ok: false, reason: "Project changed in another tab", code: "project.conflict", project: current };
    }
    let result = null;
    const ownerId = projectMutationOwner(message, sender);
    const options = { ownerId, leaseToken: message.leaseToken, at: Date.now() };
    if (message.type === "YOLO_PROJECT_ROLLOVER_CLAIM") {
      result = Projects.claimRollover(current, ownerId, { at: options.at, leaseMs: message.leaseMs });
    } else if (message.type === "YOLO_PROJECT_ROLLOVER_RELEASE") {
      result = Projects.releaseRollover(current, ownerId, message.leaseToken, options.at);
    } else if (message.type === "YOLO_PROJECT_ROLLOVER_ADVANCE") {
      result = Projects.advanceRollover(current, message.stage, {
        ...options,
        handoffSource: message.handoffSource,
        successorPageId: message.successorPageId,
        error: message.error
      });
    } else if (message.type === "YOLO_PROJECT_HANDOFF_SAVE") {
      result = Projects.saveHandoffCandidate(current, message.text, options);
    } else if (message.type === "YOLO_PROJECT_HANDOFF_VERIFY") {
      result = Projects.verifyHandoff(current, message.verificationText, options);
    } else if (message.type === "YOLO_PROJECT_ROLLOVER_FALLBACK") {
      result = Projects.applyRolloverFallback(current, options);
    } else if (message.type === "YOLO_PROJECT_NEW_CHAT_MARK_OPENING") {
      result = Projects.markNewChatOpening(current, options);
    } else if (message.type === "YOLO_PROJECT_BOOTSTRAP_PREPARE") {
      result = Projects.prepareBootstrap(current, options);
    } else if (message.type === "YOLO_PROJECT_BOOTSTRAP_MARK_SUBMITTING") {
      result = Projects.markBootstrapSubmitting(current, options);
    } else if (message.type === "YOLO_PROJECT_BOOTSTRAP_OBSERVE") {
      result = Projects.observeBootstrapSuccessor(current, message.successorPageId, message.observedUserText, options);
    } else if (message.type === "YOLO_PROJECT_BOOTSTRAP_VERIFY") {
      result = Projects.verifyBootstrapSuccessor(current, message.responseText, options);
    } else if (message.type === "YOLO_PROJECT_BOOTSTRAP_CANCEL_SUBMITTING") {
      result = Projects.cancelBootstrapSubmission(current, options);
    } else if (message.type === "YOLO_PROJECT_BOOTSTRAP_DELIVERY_UNKNOWN") {
      result = Projects.markBootstrapDeliveryUnknown(current, { ...options, reason: message.reason });
    } else if (message.type === "YOLO_PROJECT_HANDOFF_GENERATION_PROMPT") {
      return { ok: true, project: current, prompt: Projects.handoffGenerationPrompt(current) };
    } else if (message.type === "YOLO_PROJECT_HANDOFF_VERIFICATION_PROMPT") {
      return { ok: true, project: current, prompt: Projects.handoffVerificationPrompt(current) };
    } else {
      return { ok: false, reason: "Unknown project operation", code: "project.unknown", project: current };
    }
    if (!result?.ok) return result || { ok: false, reason: "Project mutation failed", code: "project.mutation_failed", project: current };
    const project = Projects.normalizeProject(result.project, current.id);
    map[project.id] = project;
    await storageSet({ [Config.STORAGE_KEYS.projects]: map });
    return { ...result, project };
  });
}
async function handleQueueMessage(message, sender) {
  const pageId = message.pageId;
  if (!validPageId(pageId)) return { ok: false, reason: "Invalid conversation identifier", code: "queue.page_invalid" };
  if (!senderMatchesPageId(sender, pageId)) {
    return { ok: false, reason: "Conversation identifier does not match the sending tab", code: "queue.page_mismatch" };
  }
  if (["YOLO_QUEUE_ADD", "YOLO_QUEUE_CLAIM", "YOLO_QUEUE_MARK_SUBMITTING", "YOLO_QUEUE_RETRY"].includes(message.type)) {
    const blocked = await automationBlockForPage(pageId);
    if (blocked) return blocked;
  }

  if (message.type === "YOLO_QUEUE_GET") {
    return readQueueState(pageId);
  }
  if (message.type === "YOLO_QUEUE_ADD") {
    return mutateQueue(pageId, async (state) => Queue.addItem(state, message.item, {
      front: Boolean(message.front),
      requireUnpaused: Boolean(message.requireUnpaused),
      dedupeWindowMs: message.dedupeWindowMs
    }));
  }
  if (message.type === "YOLO_QUEUE_UPDATE") {
    return mutateQueue(pageId, async (state) => Queue.updateItem(state, message.itemId, message.text));
  }
  if (message.type === "YOLO_QUEUE_REMOVE") {
    return mutateQueue(pageId, async (state) => Queue.removeItem(state, message.itemId));
  }
  if (message.type === "YOLO_QUEUE_REORDER") {
    return mutateQueue(pageId, async (state) => Queue.reorderItems(state, message.orderedIds));
  }
  if (message.type === "YOLO_QUEUE_PAUSE") {
    return mutateQueue(pageId, async (state) => Queue.setPaused(state, message.paused));
  }
  if (message.type === "YOLO_QUEUE_CLEAR") {
    return mutateQueue(pageId, async (state) => Queue.clearItems(state));
  }
  if (message.type === "YOLO_QUEUE_RETRY") {
    return mutateQueue(pageId, async (state) => Queue.retryItem(state, message.itemId));
  }
  if (message.type === "YOLO_QUEUE_CLAIM") {
    return mutateQueue(pageId, async (state) => Queue.claimNext(state, message.ownerId));
  }
  if (message.type === "YOLO_QUEUE_MARK_SUBMITTING") {
    return mutateQueue(pageId, async (state) => Queue.markSubmitting(state, message.itemId, message.claimToken));
  }
  if (message.type === "YOLO_QUEUE_RELEASE") {
    return mutateQueue(pageId, async (state) => Queue.releaseClaim(state, message.itemId, message.claimToken, { reason: message.reason }));
  }
  if (message.type === "YOLO_QUEUE_COMPLETE") {
    return completeQueueClaim(pageId, message);
  }
  if (message.type === "YOLO_QUEUE_FAIL") {
    return mutateQueue(pageId, async (state) => Queue.failClaim(state, message.itemId, message.claimToken, {
      error: message.error,
      errorCode: message.errorCode,
      maxRetries: message.maxRetries,
      backoffSec: message.backoffSec,
      pauseOnFailure: message.pauseOnFailure,
      deliveryAmbiguous: message.deliveryAmbiguous
    }));
  }
  if (message.type === "YOLO_EVENT_APPEND") {
    return mutateQueue(pageId, async (state) => ({ ok: true, state: Queue.appendEvent(state, message.event) }));
  }
  return { ok: false, reason: "Unknown queue operation" };
}

chrome.runtime.onInstalled.addListener((details) => {
  PortableStore.mutate(({ stored }) => Array.isArray(stored[Config.STORAGE_KEYS.templates])
    ? { mutate: false, result: { initialized: false } }
    : {
        setItems: {
          [Config.STORAGE_KEYS.templates]: Config.DEFAULT_TEMPLATES.map((template) => normalizeTemplate(template))
        },
        result: { initialized: true }
      }).catch(() => {});
  if (details?.reason === "install") {
    chrome.tabs?.create?.({ url: chrome.runtime.getURL("onboarding.html") });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type?.startsWith("YOLO_")) return false;
  const task = message.type.startsWith("YOLO_ACTION_")
    ? handleActionMessage(message, sender)
    : message.type.includes("TEMPLATE")
      ? handleTemplateMessage(message)
      : message.type.includes("PROJECT")
        ? handleProjectMessage(message, sender)
        : message.type.includes("WORKFLOW")
          ? handleWorkflowMessage(message, sender)
          : handleQueueMessage(message, sender);
  Promise.resolve(task)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, reason: Shared.errorMessage(error) }));
  return true;
});
