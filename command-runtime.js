(() => {
  "use strict";

  const Config = globalThis.YOLOConfig;
  const Shared = globalThis.YOLOShared;
  const Lifecycle = globalThis.YOLOLifecycle;
  const Platforms = globalThis.YOLOPlatforms;
  const Commands = globalThis.YOLOCommands;
  const CommandUI = globalThis.YOLOCommandUI;
  if (!Config || !Shared || !Lifecycle || !Platforms || !Commands || !CommandUI) return;

  if (window.__YOLO_COMMAND_RUNTIME__?.version === Config.VERSION) return;
  window.__YOLO_COMMAND_RUNTIME__?.destroy?.();

  const POLL_MS = Lifecycle.VISIBLE_WORKFLOW_POLL_MS;
  const RESPONSE_SETTLE_MS = 1200;
  const ROLLOVER_SESSION_KEY = "yoloRolloverProjectV1";
  const NEW_CHAT_CONFIRM_TIMEOUT_MS = 15 * 1000;
  const BOOTSTRAP_CONFIRM_TIMEOUT_MS = 60 * 1000;

  function loadRolloverProjectId() {
    try { return String(sessionStorage.getItem(ROLLOVER_SESSION_KEY) || "").trim().slice(0, 180); } catch { return ""; }
  }
  function saveRolloverProjectId(projectId) {
    const id = String(projectId || "").trim().slice(0, 180);
    try { if (id) sessionStorage.setItem(ROLLOVER_SESSION_KEY, id); else sessionStorage.removeItem(ROLLOVER_SESSION_KEY); } catch {}
    return id;
  }
  const state = {
    destroyed: false,
    pageId: "",
    workflow: Commands.freshWorkflow(),
    ui: null,
    pollTimer: null,
    routeInFlight: false,
    tickInFlight: false,
    lastQueueAttemptAt: 0,
    unregisterEngineClient: null,
    lifecycleHandlers: [],
    mutationLock: Shared.createLock(),
    ownerId: Shared.makeId("command"),
    rolloverProjectId: loadRolloverProjectId()
  };

  const now = () => Date.now();
  const engine = () => window.__YOLO_EXTENSION__?.commandApi || null;

  const withWorkflowLock = (task) => Shared.withLock(state.mutationLock, task);

  const backgroundSend = (message) => Shared.sendMessage(message, {
    soft: true,
    isDestroyed: () => state.destroyed
  });


  function adapter() {
    return Platforms.adapterForLocation();
  }

  function composer() {
    return Platforms.findComposer(adapter());
  }

  function composerText() {
    return Platforms.composerText(composer());
  }

  function setComposerText(value) {
    const target = composer();
    if (!target) return false;
    Platforms.setComposerValue(target, value);
    return true;
  }

  function latestAssistantFingerprint() {
    return Commands.fingerprint(Platforms.latestAssistantText(adapter()));
  }

  function latestUserFingerprint() {
    return Commands.fingerprint(Platforms.latestUserText(adapter()));
  }

  async function record(message, level = "info", code = "command.status", log = true) {
    const api = engine();
    if (api?.recordStatus) await api.recordStatus(message, level, code, log);
  }

  function applyWorkflowResponse(response, targetPageId = state.pageId) {
    if (response?.workflow && state.pageId === targetPageId) {
      state.workflow = Commands.normalizeWorkflow(response.workflow);
      syncUI();
    }
  }

  async function readWorkflow(pageId = state.pageId) {
    const response = await backgroundSend({ type: "YOLO_WORKFLOW_GET", pageId });
    return response?.ok ? Commands.normalizeWorkflow(response.workflow) : Commands.freshWorkflow();
  }

  async function refreshWorkflow(pageId = state.pageId) {
    const workflow = await readWorkflow(pageId);
    if (state.pageId === pageId) {
      state.workflow = workflow;
      syncUI();
    }
    return workflow;
  }

  async function readProject(projectId = state.workflow.projectId) {
    const id = String(projectId || "").trim();
    const response = await backgroundSend(id
      ? { type: "YOLO_PROJECT_GET", projectId: id }
      : { type: "YOLO_PROJECT_GET", pageId: state.pageId });
    return response?.ok ? response.project : null;
  }

  async function recoverPendingRolloverProject() {
    if (state.rolloverProjectId || !state.pageId || Config.isDurablePageId(state.pageId)) return null;
    const response = await backgroundSend({ type: "YOLO_PROJECT_RECOVER_PENDING", maxAgeMs: BOOTSTRAP_CONFIRM_TIMEOUT_MS });
    if (!response?.ok || !response.project?.id || response.ambiguous) return null;
    state.rolloverProjectId = saveRolloverProjectId(response.project.id);
    await record("Recovered persisted rollover ownership in ChatGPT New Chat", "info", "supervisor.rollover.pending_recovered");
    return response.project;
  }

  async function claimProjectRollover(project) {
    if (!project?.id) return null;
    const response = await backgroundSend({
      type: "YOLO_PROJECT_ROLLOVER_CLAIM",
      projectId: project.id,
      expectedRevision: project.revision,
      ownerId: state.ownerId
    });
    return response?.ok ? response : null;
  }

  async function releaseProjectRollover(project, leaseToken) {
    if (!project?.id || !leaseToken) return null;
    const response = await backgroundSend({
      type: "YOLO_PROJECT_ROLLOVER_RELEASE",
      projectId: project.id,
      expectedRevision: project.revision,
      ownerId: state.ownerId,
      leaseToken
    });
    return response?.ok ? response : null;
  }

  async function fallbackProjectRollover(project, leaseToken) {
    if (!project?.id || !leaseToken) return null;
    const response = await backgroundSend({
      type: "YOLO_PROJECT_ROLLOVER_FALLBACK",
      projectId: project.id,
      expectedRevision: project.revision,
      ownerId: state.ownerId,
      leaseToken
    });
    return response?.ok ? response : null;
  }

  async function planProactiveWorkflow(workflow, growth) {
    const pageId = state.pageId;
    const response = await backgroundSend({
      type: "YOLO_WORKFLOW_PROACTIVE_ROLLOVER",
      pageId,
      expectedRevision: workflow.revision,
      ownerId: state.ownerId,
      workflow,
      growth
    });
    applyWorkflowResponse(response, pageId);
    if (response?.ok && response.project?.id) state.rolloverProjectId = saveRolloverProjectId(response.project.id);
    return response;
  }

  async function abortProactiveWorkflow(project, leaseToken, reason) {
    const pageId = state.pageId;
    const response = await backgroundSend({ type: "YOLO_WORKFLOW_PROACTIVE_ABORT", pageId, projectId: project.id, expectedRevision: state.workflow.revision, expectedProjectRevision: project.revision, ownerId: state.ownerId, leaseToken, reason });
    applyWorkflowResponse(response, pageId);
    if (response?.ok) { clearRolloverSession(); await record(reason, "warning", "supervisor.rollover.proactive.aborted"); }
    return response;
  }

  async function mutateProject(project, type, leaseToken, extra = {}) {
    if (!project?.id) return null;
    return backgroundSend({
      type,
      projectId: project.id,
      expectedRevision: project.revision,
      ownerId: state.ownerId,
      leaseToken,
      ...extra
    });
  }

  async function prepareProactiveHandoffGeneration(project, leaseToken) {
    return mutateProject(project, "YOLO_PROJECT_PROACTIVE_HANDOFF_GENERATION_PREPARE", leaseToken, {
      baselineAssistantFingerprint: latestAssistantFingerprint(),
      baselineUserFingerprint: latestUserFingerprint()
    });
  }

  async function prepareProactiveHandoffVerification(project, leaseToken) {
    return mutateProject(project, "YOLO_PROJECT_PROACTIVE_HANDOFF_VERIFICATION_PREPARE", leaseToken, {
      baselineAssistantFingerprint: latestAssistantFingerprint(),
      baselineUserFingerprint: latestUserFingerprint()
    });
  }

  async function saveProjectHandoff(project, leaseToken, text) {
    return mutateProject(project, "YOLO_PROJECT_HANDOFF_SAVE", leaseToken, { text });
  }

  async function verifyProjectHandoff(project, leaseToken, verificationText) {
    return mutateProject(project, "YOLO_PROJECT_HANDOFF_VERIFY", leaseToken, { verificationText });
  }

  async function advanceProjectRollover(project, leaseToken, stage, extra = {}) {
    return mutateProject(project, "YOLO_PROJECT_ROLLOVER_ADVANCE", leaseToken, { stage, ...extra });
  }

  async function prepareProjectBootstrap(project, leaseToken) {
    return mutateProject(project, "YOLO_PROJECT_BOOTSTRAP_PREPARE", leaseToken);
  }

  async function markNewChatOpening(project, leaseToken) {
    return mutateProject(project, "YOLO_PROJECT_NEW_CHAT_MARK_OPENING", leaseToken, {
      finalPromptFingerprint: latestUserFingerprint(),
      finalAssistantFingerprint: latestAssistantFingerprint(),
      lastVerifiedCheckpoint: state.workflow?.supervisor?.lastProgressFingerprint || project?.latestVerifiedCheckpoint?.id || ""
    });
  }

  async function markBootstrapSubmitting(project, leaseToken) {
    return mutateProject(project, "YOLO_PROJECT_BOOTSTRAP_MARK_SUBMITTING", leaseToken);
  }

  async function cancelBootstrapSubmitting(project, leaseToken) {
    return mutateProject(project, "YOLO_PROJECT_BOOTSTRAP_CANCEL_SUBMITTING", leaseToken);
  }

  async function markBootstrapUnknown(project, leaseToken, reason) {
    return mutateProject(project, "YOLO_PROJECT_BOOTSTRAP_DELIVERY_UNKNOWN", leaseToken, { reason });
  }

  async function persistBootstrapUnknown(project, leaseToken, reason) {
    const unknown = await markBootstrapUnknown(project, leaseToken, reason);
    if (!unknown?.ok) return false;
    clearRolloverSession();
    await record(reason, "warning", "supervisor.rollover.bootstrap_delivery_unknown");
    return true;
  }

  async function observeBootstrap(project, leaseToken, successorPageId, observedUserText) {
    return mutateProject(project, "YOLO_PROJECT_BOOTSTRAP_OBSERVE", leaseToken, {
      successorPageId,
      observedUserText
    });
  }

  async function verifyBootstrap(project, leaseToken, responseText) {
    return mutateProject(project, "YOLO_PROJECT_BOOTSTRAP_VERIFY", leaseToken, { responseText });
  }

  function clearRolloverSession() {
    state.rolloverProjectId = "";
    saveRolloverProjectId("");
  }

  function currentIsDurableSuccessor(project) {
    return Config.isDurablePageId(state.pageId)
      && state.pageId !== project?.rollover?.sourcePageId;
  }

  async function writeWorkflow(workflow = state.workflow, pageId = state.pageId) {
    const normalized = Commands.normalizeWorkflow(workflow);
    const response = await backgroundSend({
      type: "YOLO_WORKFLOW_SET",
      pageId,
      expectedRevision: normalized.revision,
      workflow: normalized
    });
    applyWorkflowResponse(response, pageId);
    return Boolean(response?.ok && state.pageId === pageId);
  }

  async function clearWorkflow(pageId = state.pageId) {
    const response = await backgroundSend({
      type: "YOLO_WORKFLOW_CLEAR",
      pageId,
      expectedRevision: state.workflow.revision
    });
    applyWorkflowResponse(response, pageId);
    return Boolean(response?.ok && state.pageId === pageId);
  }

  async function claimWorkflow() {
    const pageId = state.pageId;
    const response = await backgroundSend({
      type: "YOLO_WORKFLOW_CLAIM",
      pageId,
      ownerId: state.ownerId
    });
    applyWorkflowResponse(response, pageId);
    return Boolean(response?.ok && state.pageId === pageId);
  }

  function releaseWorkflow() {
    if (!state.pageId || state.workflow.runnerId !== state.ownerId) return;
    backgroundSend({
      type: "YOLO_WORKFLOW_RELEASE",
      pageId: state.pageId,
      ownerId: state.ownerId
    });
  }

  async function queueState(pageId = state.pageId) {
    return backgroundSend({ type: "YOLO_QUEUE_GET", pageId });
  }

  async function removeQueueItem(itemId, pageId = state.pageId) {
    if (!itemId) return true;
    const response = await backgroundSend({ type: "YOLO_QUEUE_REMOVE", pageId, itemId });
    return Boolean(response?.ok || response?.code === "queue.not_found");
  }

  async function queuePrompt(text, { workflow = null, source = "command", dedupeKey = "" } = {}) {
    const prompt = String(text || "").trim();
    const pageId = state.pageId;
    if (!prompt) return { ok: false, reason: "Command produced an empty prompt" };

    let response;
    if (workflow) {
      const next = Commands.normalizeWorkflow(workflow);
      next.awaitingResponse = false;
      next.sawGeneration = false;
      next.responseCandidateFingerprint = "";
      next.responseCandidateSince = 0;
      next.manualInterruptionPending = false;
      next.manualInterruptionUserFingerprint = "";
      next.manualInterruptionAt = 0;
      next.manualInterruptionSawGeneration = false;
      next.baselineFingerprint = latestAssistantFingerprint();
      next.lastAssistantFingerprint = next.baselineFingerprint;
      next.promptFingerprint = Commands.fingerprint(prompt);
      next.lastPromptAt = now();
      next.reason = "Queued command prompt";
      next.updatedAt = now();
      response = await backgroundSend({
        type: "YOLO_WORKFLOW_QUEUE_ADD",
        pageId,
        expectedRevision: next.revision,
        ownerId: state.ownerId,
        workflow: next,
        item: {
          text: prompt,
          source,
          sourceId: next.id
        }
      });
      applyWorkflowResponse(response, pageId);
    } else {
      response = await backgroundSend({
        type: "YOLO_QUEUE_ADD",
        pageId,
        front: true,
        item: { text: prompt, source, sourceId: "", dedupeKey }
      });
    }
    if (!response?.ok) return response || { ok: false, reason: "Could not add the command prompt to the queue" };
    if (response.alreadyCompleted) return { ...response, sent: false };

    const api = engine();
    const sent = api ? await api.runAction("queue-next") : false;
    if (workflow && sent && state.pageId === pageId) await refreshWorkflow(pageId);
    return { ...response, sent };
  }

  async function cancelPendingWorkflowPrompt(workflow = state.workflow) {
    if (!workflow.pendingItemId) return { ok: true, removed: false };
    const response = await backgroundSend({
      type: "YOLO_QUEUE_REMOVE",
      pageId: state.pageId,
      itemId: workflow.pendingItemId
    });
    if (response?.ok || response?.code === "queue.not_found") return { ok: true, removed: true };
    if (response?.code === "queue.sending") {
      return { ok: true, removed: false, reason: "The current workflow prompt is already sending and cannot be unsent" };
    }
    return { ok: false, removed: false, reason: response?.reason || "Could not remove the pending workflow prompt" };
  }

  async function startWorkflow(kind, args) {
    await syncRoute();
    const latest = await readWorkflow(state.pageId);
    state.workflow = latest;
    syncUI();

    if (latest.status !== "idle") {
      if (latest.status === "running" && (latest.pendingItemId || latest.awaitingResponse || engine()?.getState?.().generating)) {
        return { ok: false, reason: "Pause or stop the active workflow after its current turn finishes before replacing it", keepOpen: true };
      }
      if (!window.confirm(`Replace the active ${latest.kind} workflow?`)) {
        return { ok: false, reason: "Existing workflow kept", keepOpen: true };
      }
      const cancelled = await cancelPendingWorkflowPrompt(latest);
      if (!cancelled.ok) return { ok: false, reason: cancelled.reason, keepOpen: true };
    }

    const current = Commands.startWorkflow(kind, args, {
      at: now(),
      baselineFingerprint: latestAssistantFingerprint()
    });
    if (!current.ok) return { ...current, keepOpen: true };
    current.workflow.revision = latest.revision;
    current.workflow.runnerId = state.ownerId;
    state.workflow = current.workflow;
    const prompt = Commands.workflowPrompt(state.workflow, "initial");
    const queued = await queuePrompt(prompt, { workflow: state.workflow, source: `workflow:${kind}` });
    if (!queued.ok) {
      await markWorkflow("blocked", queued.reason || "Could not queue workflow prompt", `command.${kind}.blocked`);
      return { ...queued, keepOpen: true };
    }
    await record(`Started /${kind}: ${state.workflow.objective}`, "success", `command.${kind}.started`);
    return { ok: true };
  }

  async function runOneShot(name, args) {
    if (state.workflow.status === "running") {
      return { ok: false, reason: "Pause the active goal or loop before running another prompt command", keepOpen: true };
    }
    const prompt = Commands.oneShotPrompt(name, args);
    if (!prompt) return { ok: false, reason: `/${name} requires more detail`, keepOpen: true };
    const queued = await queuePrompt(prompt, { source: `command:${name}` });
    if (!queued.ok) {
      await record(`/${name} failed: ${queued.reason || "queue unavailable"}`, "error", `command.${name}.failed`);
      return { ...queued, keepOpen: true };
    }
    await record(queued.sent ? `Ran /${name}` : `Queued /${name}`, "success", `command.${name}`);
    return { ok: true };
  }

  async function setStatus(status, reason) {
    if (state.workflow.status === "idle") return { ok: false, reason: "No active goal or loop", keepOpen: true };
    if (status === "paused") {
      const cancelled = await cancelPendingWorkflowPrompt(state.workflow);
      if (!cancelled.ok || (state.workflow.pendingItemId && !cancelled.removed)) {
        return { ok: false, reason: cancelled.reason || "The workflow prompt is already sending", keepOpen: true };
      }
      if (cancelled.reason) reason = `${reason}. ${cancelled.reason}`;
    }
    const next = Commands.setWorkflowStatus(state.workflow, status, reason, now());
    const ok = await writeWorkflow(next);
    if (ok) await record(`${state.workflow.kind} ${status}`, status === "blocked" ? "warning" : "info", `command.workflow.${status}`);
    return { ok, reason: ok ? "" : "Workflow changed in another tab", keepOpen: !ok };
  }

  async function resumeWorkflow() {
    if (!["paused", "stalled", "rate_limited", "human_required", "blocked"].includes(state.workflow.status)) return { ok: false, reason: "Workflow is not paused", keepOpen: true };
    const next = Commands.normalizeWorkflow(state.workflow);
    next.status = "running";
    next.reason = "Resumed by user";
    next.updatedAt = now();
    const phase = next.supervisor.verificationPending ? "verification" : (next.iteration === 0 ? "initial" : "continue");
    const prompt = Commands.workflowPrompt(next, phase);
    return queuePrompt(prompt, { workflow: next, source: `workflow:${next.kind}` });
  }

  async function showStatus() {
    const apiState = engine()?.getState?.() || {};
    const queue = await queueState();
    const workflow = Commands.normalizeWorkflow(state.workflow);
    const project = await readProject(state.rolloverProjectId || workflow.projectId);
    state.ui?.showStatus({
      Conversation: state.pageId || "Unavailable",
      Project: project?.id || (workflow.status === "idle" ? "-" : (workflow.projectId || "Unlinked")),
      "Project generation": project?.currentGeneration || "-",
      "Rollover stage": project?.rollover?.stage || "-",
      "Bootstrap state": project?.rollover?.bootstrapState || "-",
      "Handoff source": project?.rollover?.handoffSource || "-",
      Workflow: workflow.status === "idle" ? "None" : `/${workflow.kind} · ${workflow.status}`,
      Phase: workflow.status === "idle" ? "—" : Commands.workflowPhase(workflow),
      Objective: workflow.status === "idle" ? "—" : workflow.objective,
      Cycle: workflow.status === "idle" ? "—" : Commands.workflowIterationLabel(workflow),
      "Progress evidence": workflow.status === "idle" ? "—" : (workflow.supervisor.lastProgressFingerprint ? "Recorded" : "None"),
      "No progress": workflow.status === "idle" ? "—" : `${workflow.supervisor.noProgressCount}/${Commands.SUPERVISOR_LIMITS.noProgressResponses}`,
      "Repeated response": workflow.status === "idle" ? "—" : `${workflow.supervisor.repeatedResponseCount}/${Commands.SUPERVISOR_LIMITS.repeatedResponses}`,
      Recovery: workflow.status === "idle" ? "—" : `${workflow.supervisor.recoveryAttempts}/${Commands.SUPERVISOR_LIMITS.recoveryAttempts}`,
      Verification: workflow.status === "idle" ? "—" : `${workflow.supervisor.verificationAttempts}/${Commands.SUPERVISOR_LIMITS.verificationAttempts}`,
      Reason: workflow.status === "idle" ? "—" : (workflow.reason || "None"),
      Queue: queue?.ok ? `${queue.state.items.length} item${queue.state.items.length === 1 ? "" : "s"}${queue.state.paused ? " · paused" : ""}` : "Unavailable",
      Runner: workflow.status === "running" ? (workflow.runnerId === state.ownerId ? "This tab" : (workflow.runnerId ? "Another tab" : "Acquiring")) : "—",
      Generation: apiState.generating ? "Active" : "Idle",
      Profile: apiState.settings?.profile || "Unknown",
      "Session actions": apiState.runtime?.sessionActionCount ?? 0,
      "Last action": apiState.lastAction?.message || "Idle"
    });
    return { ok: true, focusComposer: false };
  }

  async function executeCommandUnlocked(name, args = "") {
    await syncRoute();
    const api = engine();
    if (!api || !await api.ensureReady()) return { ok: false, reason: "YOLO is not ready in this conversation", keepOpen: true };
    if (["goal", "loop"].includes(name)) return startWorkflow(name, args);
    if (["plan", "review", "fix", "handoff", "continue"].includes(name)) return runOneShot(name, args);
    if (name === "status") return showStatus();
    if (name === "pause") return setStatus("paused", "Paused by user");
    if (name === "resume") return resumeWorkflow();
    if (name === "stop") {
      if (state.workflow.status === "idle") return { ok: false, reason: "No active goal or loop", keepOpen: true };
      if (!window.confirm(`Stop and clear the active ${state.workflow.kind} workflow?`)) return { ok: false, reason: "Workflow kept", keepOpen: true };
      const cancelled = await cancelPendingWorkflowPrompt(state.workflow);
      if (!cancelled.ok || (state.workflow.pendingItemId && !cancelled.removed)) {
        return { ok: false, reason: cancelled.reason || "The workflow prompt is already sending", keepOpen: true };
      }
      const ok = await clearWorkflow();
      if (ok) await record(cancelled.reason || "Stopped and cleared command workflow", "info", "command.workflow.stopped");
      return { ok, reason: ok ? "" : "Workflow changed in another tab", keepOpen: !ok };
    }
    if (name === "settings") {
      chrome.runtime.openOptionsPage?.();
      return { ok: true, focusComposer: false };
    }
    if (name === "help") {
      state.ui?.open();
      return { ok: true, keepOpen: true, focusComposer: false };
    }
    return { ok: false, reason: "Unknown command", keepOpen: true };
  }

  function executeCommand(name, args = "") {
    return withWorkflowLock(() => executeCommandUnlocked(name, args));
  }

  function syncUI() {
    state.ui?.update({ workflow: state.workflow });
  }

  async function syncRoute() {
    const nextPageId = Config.pageId(location.href);
    if (!Config.isSupportedUrl(location.href) || nextPageId === state.pageId || state.routeInFlight) return;
    state.routeInFlight = true;
    try {
      state.pageId = nextPageId;
      state.workflow = await readWorkflow(nextPageId);
      syncUI();
    } finally {
      state.routeInFlight = false;
    }
  }

  async function markWorkflow(status, reason, code) {
    const next = Commands.setWorkflowStatus(state.workflow, status, reason, now());
    const saved = await writeWorkflow(next);
    if (saved) await record(`${state.workflow.kind} ${status}: ${reason}`, status === "completed" ? "success" : "warning", code);
    return saved;
  }

  async function processResponse() {
    const workflow = Commands.normalizeWorkflow(state.workflow);
    const text = Platforms.latestAssistantText(adapter());
    const fingerprint = Commands.fingerprint(text);
    if (!text || fingerprint === workflow.baselineFingerprint || fingerprint === workflow.lastAssistantFingerprint) return false;

    const decision = Commands.decideWorkflowResponse(workflow, text, {
      userFingerprint: latestUserFingerprint(),
      at: now()
    });
    state.workflow = decision.workflow;
    if (decision.action === "ignore") return false;
    if (decision.action === "verify") {
      const prompt = Commands.workflowPrompt(state.workflow, "verification");
      const queued = await queuePrompt(prompt, { workflow: state.workflow, source: `workflow:${state.workflow.kind}` });
      if (!queued.ok) await markWorkflow("blocked", queued.reason || "Could not queue the completion verification prompt", "supervisor.verify.queue_failed");
      else await record(decision.reason, "info", decision.code);
      return true;
    }
    if (decision.action === "interrupted") {
      const prompt = Commands.workflowPrompt(state.workflow, "continue");
      const queued = await queuePrompt(prompt, { workflow: state.workflow, source: `workflow:${state.workflow.kind}` });
      if (!queued.ok) await markWorkflow("blocked", queued.reason || "Could not resume the Goal after a manual conversation turn", "command.workflow.interruption_queue_failed");
      else await record(decision.reason, "info", decision.code);
      return true;
    }
    if (decision.action === "recover") {
      const prompt = Commands.workflowPrompt(state.workflow, "recovery");
      const queued = await queuePrompt(prompt, { workflow: state.workflow, source: `workflow:${state.workflow.kind}` });
      if (!queued.ok) await markWorkflow("blocked", queued.reason || "Could not queue the workflow recovery prompt", "supervisor.recover.queue_failed");
      else await record(decision.reason, "info", decision.code);
      return true;
    }
    if (decision.action !== "continue") {
      await markWorkflow(decision.action, decision.reason, decision.code);
      return true;
    }

    if (state.workflow.kind === "goal") {
      const growth = Platforms.conversationGrowthSnapshot(adapter(), document);
      const proactive = Commands.proactiveRolloverEvidence(state.workflow, growth);
      if (proactive.triggered) {
        const planned = await planProactiveWorkflow(state.workflow, growth);
        if (planned?.ok) {
          await record(proactive.reason, "info", proactive.code);
          await handleRollover();
          return true;
        }
        if (planned?.code === "workflow.conflict") {
          await refreshWorkflow();
          return true;
        }
      }
    }

    const prompt = Commands.workflowPrompt(state.workflow, "continue");
    const queued = await queuePrompt(prompt, { workflow: state.workflow, source: `workflow:${state.workflow.kind}` });
    if (!queued.ok) await markWorkflow("blocked", queued.reason || "Could not queue the next workflow iteration", "command.workflow.queue_failed");
    return true;
  }

  async function handlePendingWorkflowItem(apiState) {
    const workflow = Commands.normalizeWorkflow(state.workflow);
    const queue = await queueState();
    if (!queue?.ok) return false;
    const item = queue.state.items.find((entry) => entry.id === workflow.pendingItemId);
    if (item?.state === "failed") {
      const removed = await removeQueueItem(item.id);
      const reason = removed
        ? (item.error || "Workflow prompt failed")
        : `${item.error || "Workflow prompt failed"}. The failed queue item could not be removed.`;
      await markWorkflow("blocked", reason, "command.workflow.delivery_failed");
      return true;
    }
    if (item) {
      if (!apiState.generating && now() - state.lastQueueAttemptAt >= POLL_MS) {
        state.lastQueueAttemptAt = now();
        const sent = await engine()?.runAction?.("queue-next");
        if (sent) await refreshWorkflow();
      }
      return false;
    }

    const refreshed = await refreshWorkflow();
    if (refreshed.awaitingResponse || !refreshed.pendingItemId) return false;

    const completedExactly = queue.state.completions.some((completion) =>
      completion.itemId === workflow.pendingItemId && completion.sourceId === workflow.id);
    if (completedExactly) {
      const next = Commands.normalizeWorkflow(refreshed);
      next.pendingItemId = "";
      next.awaitingResponse = true;
      next.sawGeneration = false;
      next.responseCandidateFingerprint = "";
      next.responseCandidateSince = 0;
      next.reason = "Waiting for ChatGPT";
      next.updatedAt = now();
      await writeWorkflow(next);
      return false;
    }

    await markWorkflow("blocked", "Workflow prompt was removed before confirmed delivery", "command.workflow.prompt_removed");
    return true;
  }

  async function failProjectRollover(project, leaseToken, reason, code = "supervisor.rollover.failed") {
    const failed = await advanceProjectRollover(project, leaseToken, "failed", { error: reason });
    if (failed?.ok) {
      clearRolloverSession();
      await record(reason, "warning", code);
    }
    return Boolean(failed?.ok);
  }

  async function proactiveProjectPromptResult(project) {
    const rollover = project?.rollover || {};
    const prompt = String(rollover.handoffPromptText || "").trim();
    const promptFingerprint = String(rollover.handoffPromptFingerprint || "");
    if (!prompt || !promptFingerprint || !["generate", "verify"].includes(rollover.handoffAction)) return { kind: "invalid" };
    const userFingerprint = latestUserFingerprint();
    if (userFingerprint !== promptFingerprint) {
      if (userFingerprint !== String(rollover.handoffBaselineUserFingerprint || "")) return { kind: "ownership_lost" };
      const dedupeKey = ["project-handoff", project.id, project.currentGeneration, rollover.handoffAction, promptFingerprint].join(":");
      const queued = await queuePrompt(prompt, { source: "project:handoff", dedupeKey });
      return queued?.ok ? { kind: "waiting" } : { kind: "queue_failed", reason: queued?.reason || "Could not queue proactive handoff prompt" };
    }
    const api = engine();
    if (!api || !await api.ensureReady()) return { kind: "waiting" };
    const apiState = api.getState();
    if (!apiState.hydrated || apiState.generating) return { kind: "waiting" };
    const text = Platforms.latestAssistantText(adapter());
    const fingerprint = Commands.fingerprint(text);
    if (!text || fingerprint === rollover.handoffBaselineAssistantFingerprint) return { kind: "waiting" };
    const quietSince = Math.max(rollover.handoffPromptPreparedAt || 0, apiState.lastDomActivityAt || 0, apiState.lastGenerationAt || 0);
    if (now() - quietSince < RESPONSE_SETTLE_MS) return { kind: "waiting" };
    return { kind: "response", text, fingerprint };
  }

  async function submitBootstrap(project, leaseToken) {
    const text = String(project.rollover?.bootstrapText || "").trim();
    const target = composer();
    if (!text || !target) return false;
    if (Platforms.latestUserText(adapter()) || Platforms.latestAssistantText(adapter())) {
      if (!Config.isDurablePageId(state.pageId)) {
        await record("Rollover bootstrap is waiting for the fresh New Chat surface", "info", "supervisor.rollover.destination_transition", false);
        return false;
      }
      return failProjectRollover(project, leaseToken, "New Chat bootstrap refused because the destination already contains conversation history", "supervisor.rollover.destination_not_fresh");
    }
    if (Platforms.composerText(target).trim()) {
      await record("Rollover bootstrap is waiting for an empty composer", "warning", "supervisor.rollover.composer_busy", false);
      return false;
    }
    const marked = await markBootstrapSubmitting(project, leaseToken);
    if (!marked?.ok) return false;
    project = marked.project;
    try {
      Platforms.setComposerValue(target, text);
      const written = Commands.fingerprint(Platforms.composerText(target)) === project.rollover.bootstrapFingerprint;
      if (!written) {
        await cancelBootstrapSubmitting(project, leaseToken);
        return false;
      }
      const submitted = Platforms.submitComposer(adapter(), target, document);
      if (!submitted) {
        if (Commands.fingerprint(Platforms.composerText(target)) === project.rollover.bootstrapFingerprint) Platforms.setComposerValue(target, "");
        await cancelBootstrapSubmitting(project, leaseToken);
        return false;
      }
      await record("Submitted persisted rollover bootstrap through ChatGPT New Chat", "info", "supervisor.rollover.bootstrap_submitted");
      return true;
    } catch (error) {
      return persistBootstrapUnknown(project, leaseToken, `Bootstrap submission side effect became uncertain: ${Shared.errorMessage(error)}`);
    }
  }

  async function resumeSuccessorGoal(project, leaseToken) {
    if (!currentIsDurableSuccessor(project) || state.pageId !== project.currentConversationId) return false;
    let current = await refreshWorkflow(state.pageId);
    if (project.rollover.stage === "successor_bound") {
      const advancing = await advanceProjectRollover(project, leaseToken, "resuming");
      if (!advancing?.ok) return false;
      project = advancing.project;
    }
    if (project.rollover.stage !== "resuming") return false;

    if (!(current.kind === "goal" && current.projectId === project.id && current.status === "running")) {
      if (current.status !== "idle") return failProjectRollover(project, leaseToken, "Successor conversation already has an unrelated workflow", "supervisor.rollover.successor_busy");
      const started = Commands.startWorkflow("goal", project.objective, {
        at: now(),
        baselineFingerprint: latestAssistantFingerprint()
      });
      if (!started.ok) return failProjectRollover(project, leaseToken, started.reason || "Could not resume Goal workflow");
      const next = Commands.normalizeWorkflow({
        ...started.workflow,
        projectId: project.id,
        supervisor: project.supervisor,
        revision: current.revision,
        runnerId: state.ownerId
      });
      const prompt = Commands.workflowPrompt(next, "continue");
      const queued = await queuePrompt(prompt, { workflow: next, source: "workflow:goal" });
      if (!queued.ok) return failProjectRollover(project, leaseToken, queued.reason || "Could not queue successor Goal workflow");
      current = await refreshWorkflow(state.pageId);
    }

    project = await readProject(project.id);
    if (!project || project.rollover.stage !== "resuming") return false;
    const completed = await advanceProjectRollover(project, leaseToken, "complete");
    if (!completed?.ok) return false;
    clearRolloverSession();
    await record(`Project rollover completed in generation ${completed.project.currentGeneration}`, "success", "supervisor.rollover.complete");
    return true;
  }

  async function progressProactiveHandoff(project, leaseToken) {
    if (state.pageId !== project.rollover.sourcePageId) return { project, waiting: true };
    if (project.rollover.stage === "required") {
      const prepared = await prepareProactiveHandoffGeneration(project, leaseToken);
      if (!prepared?.ok) return null;
      project = prepared.project;
      await record("Preparing a verified proactive rollover handoff", "info", "supervisor.rollover.proactive.handoff_generation");
    }
    if (project.rollover.stage !== "handoff_pending") return { project, waiting: false };
    if (project.rollover.handoffAction === "idle" && project.latestHandoff?.text && !project.latestHandoff?.verified) {
      const prepared = await prepareProactiveHandoffVerification(project, leaseToken);
      if (!prepared?.ok) return null;
      project = prepared.project;
    }
    if (!["generate", "verify"].includes(project.rollover.handoffAction)) return { project, waiting: false };
    const action = project.rollover.handoffAction;
    const result = await proactiveProjectPromptResult(project);
    if (result.kind === "waiting") return { project, waiting: true };
    if (result.kind === "ownership_lost") {
      await abortProactiveWorkflow(project, leaseToken, "Conversation advanced outside the proactive rollover handoff; Goal paused for explicit recovery");
      return null;
    }
    if (result.kind === "queue_failed") {
      const fallback = await fallbackProjectRollover(project, leaseToken);
      if (!fallback?.ok) return null;
      await record("Proactive handoff delivery failed; continuing from verified durable fallback", "warning", "supervisor.rollover.proactive.handoff_fallback");
      return { project: fallback.project, waiting: false };
    }
    if (result.kind !== "response") {
      await abortProactiveWorkflow(project, leaseToken, result.reason || "Proactive rollover handoff could not be delivered safely; Goal paused for explicit recovery");
      return null;
    }
    if (action === "generate") {
      const saved = await saveProjectHandoff(project, leaseToken, result.text);
      if (!saved?.ok) {
        const fallback = await fallbackProjectRollover(saved?.project || project, leaseToken);
        if (!fallback?.ok) return null;
        await record("Fresh proactive handoff was unusable; continuing rollover from verified durable fallback", "warning", "supervisor.rollover.proactive.handoff_fallback");
        return { project: fallback.project, waiting: false };
      }
      project = saved.project;
      const verification = await prepareProactiveHandoffVerification(project, leaseToken);
      if (!verification?.ok) return null;
      return { project: verification.project, waiting: true };
    }
    const verified = await verifyProjectHandoff(project, leaseToken, result.text);
    if (!verified?.ok) {
      const fallback = await fallbackProjectRollover(verified?.project || project, leaseToken);
      if (!fallback?.ok) return null;
      await record("Proactive handoff verification did not pass; using verified durable fallback", "warning", "supervisor.rollover.proactive.verification_fallback");
      return { project: fallback.project, waiting: false };
    }
    await record("Proactive rollover handoff verified", "success", "supervisor.rollover.proactive.handoff_verified");
    return { project: verified.project, waiting: false };
  }

  async function handleRollover() {
    const workflow = Commands.normalizeWorkflow(state.workflow);
    if (!state.rolloverProjectId && state.pageId && !Config.isDurablePageId(state.pageId)) await recoverPendingRolloverProject();
    const projectId = state.rolloverProjectId || (workflow.kind === "goal" ? workflow.projectId : "");
    if (!projectId) return false;
    let project = await readProject(projectId);
    if (!project) {
      clearRolloverSession();
      return false;
    }
    if (["completed", "stopped"].includes(project.status) || project.rollover?.stage === "complete") {
      clearRolloverSession();
      return false;
    }
    if (project.rollover?.mode === "proactive" && state.pageId === project.rollover.sourcePageId) {
      const apiState = engine()?.getState?.() || {};
      const stopState = Platforms.workflowStopState(adapter(), apiState.settings || {}, document);
      if (stopState?.status === "rollover_required") {
        const marked = await markWorkflow(stopState.status, stopState.reason, stopState.code);
        if (!marked) return false;
        project = await readProject(project.id);
        if (!project) return false;
      }
    }
    if (project.rollover?.stage === "failed" || project.rollover?.bootstrapState === "delivery_unknown") {
      clearRolloverSession();
      return false;
    }
    if (state.pageId === project.rollover?.sourcePageId && project.rollover?.stage === "bootstrap_pending" && project.rollover?.newChatOpeningAt) {
      const elapsed = now() - project.rollover.newChatOpeningAt;
      if (project.rollover.bootstrapState !== "prepared" || elapsed <= NEW_CHAT_CONFIRM_TIMEOUT_MS) return false;
    }

    const claimed = await claimProjectRollover(project);
    if (!claimed) return false;
    project = claimed.project;
    const leaseToken = claimed.leaseToken;
    state.rolloverProjectId = saveRolloverProjectId(project.id);

    if (project.rollover.mode === "proactive" && ["required", "handoff_pending"].includes(project.rollover.stage)) {
      const progressed = await progressProactiveHandoff(project, leaseToken);
      if (!progressed) return false;
      project = progressed.project;
      if (progressed.waiting) return true;
    }
    if (project.rollover.mode !== "proactive" && ["required", "handoff_pending"].includes(project.rollover.stage)) {
      const fallback = await fallbackProjectRollover(project, leaseToken);
      if (!fallback?.ok) return false;
      project = fallback.project;
      await record(`Conversation rollover handoff is ready from ${fallback.fallback?.kind || "durable project state"}`, "info", "supervisor.rollover.handoff_ready");
    }

    if (project.rollover.stage === "handoff_ready") {
      const pending = await advanceProjectRollover(project, leaseToken, "successor_pending");
      if (!pending?.ok) return false;
      project = pending.project;
    }

    if (project.rollover.stage === "successor_pending") {
      const prepared = await prepareProjectBootstrap(project, leaseToken);
      if (!prepared?.ok) return false;
      project = prepared.project;
    }

    if (project.rollover.stage === "bootstrap_pending" && project.rollover.bootstrapState === "prepared") {
      if (!project.rollover.newChatOpeningAt) {
        if (state.pageId !== project.rollover.sourcePageId) {
          return failProjectRollover(project, leaseToken, "Rollover left the source chat before New Chat navigation intent was persisted", "supervisor.rollover.navigation_untracked");
        }
        const control = Platforms.findNewChatControl(adapter(), document);
        if (!control) return false;
        const marked = await markNewChatOpening(project, leaseToken);
        if (!marked?.ok) return false;
        project = marked.project;
        const released = await releaseProjectRollover(project, leaseToken);
        if (!released?.ok) return false;
        project = released.project;
        try {
          control.click();
          await record("Opened ChatGPT New Chat for project rollover", "info", "supervisor.rollover.new_chat_opened");
          return true;
        } catch (error) {
          await record(`New Chat navigation click became uncertain after durable intent was persisted: ${Shared.errorMessage(error)}`, "warning", "supervisor.rollover.new_chat_click_uncertain");
          return true;
        }
      }
      if (state.pageId === project.rollover.sourcePageId) {
        if (now() - project.rollover.newChatOpeningAt > NEW_CHAT_CONFIRM_TIMEOUT_MS) {
          return failProjectRollover(project, leaseToken, "New Chat navigation was not observed after the persisted click intent", "supervisor.rollover.new_chat_not_observed");
        }
        return false;
      }
      if (now() - project.rollover.newChatOpeningAt > BOOTSTRAP_CONFIRM_TIMEOUT_MS) {
        return failProjectRollover(project, leaseToken, "Fresh New Chat surface was not ready within the bootstrap navigation window", "supervisor.rollover.new_chat_stale");
      }
      return submitBootstrap(project, leaseToken);
    }

    if (project.rollover.stage === "bootstrap_pending" && project.rollover.bootstrapState === "submitting") {
      if (currentIsDurableSuccessor(project)) {
        const observedText = Platforms.latestUserText(adapter());
        if (observedText) {
          const observed = await observeBootstrap(project, leaseToken, state.pageId, observedText);
          if (observed?.ok) project = observed.project;
          else if (observed?.code === "project.bootstrap_receipt_mismatch") {
            return persistBootstrapUnknown(project, leaseToken, "A different user message appeared while the rollover bootstrap was awaiting delivery confirmation");
          }
        }
      }
      if (project.rollover.bootstrapState === "submitting") {
        if (now() - project.rollover.bootstrapSubmittedAt > BOOTSTRAP_CONFIRM_TIMEOUT_MS) {
          return persistBootstrapUnknown(project, leaseToken, "Rollover bootstrap delivery could not be confirmed on a durable successor route");
        }
        return false;
      }
    }

    if (project.rollover.stage === "bootstrap_pending" && project.rollover.bootstrapState === "observed") {
      if (state.pageId !== project.rollover.successorPageId) return false;
      const api = engine();
      if (!api || !await api.ensureReady()) return false;
      const apiState = api.getState();
      if (!apiState.hydrated || apiState.generating) return false;
      const responseText = Platforms.latestAssistantText(adapter());
      if (!responseText) return false;
      const quietSince = Math.max(project.rollover.bootstrapObservedAt || 0, apiState.lastDomActivityAt || 0, apiState.lastGenerationAt || 0);
      if (now() - quietSince < RESPONSE_SETTLE_MS) return false;
      const verified = await verifyBootstrap(project, leaseToken, responseText);
      if (!verified?.ok) {
        return failProjectRollover(project, leaseToken, verified?.reason || "Successor bootstrap response did not verify", "supervisor.rollover.bootstrap_verification_failed");
      }
      project = verified.project;
    }

    if (["successor_bound", "resuming"].includes(project.rollover.stage)) {
      return resumeSuccessorGoal(project, leaseToken);
    }
    return false;
  }

  async function handleManualGoalInterruption(workflow, apiState) {
    if (workflow.kind !== "goal" || !workflow.awaitingResponse || !workflow.promptFingerprint) return false;
    const userFingerprint = latestUserFingerprint();
    if (!userFingerprint || userFingerprint === workflow.promptFingerprint) return false;

    const next = Commands.normalizeWorkflow(workflow);
    if (!next.manualInterruptionPending || next.manualInterruptionUserFingerprint !== userFingerprint) {
      next.manualInterruptionPending = true;
      next.manualInterruptionUserFingerprint = userFingerprint;
      next.manualInterruptionAt = now();
      next.manualInterruptionSawGeneration = false;
      next.responseCandidateFingerprint = "";
      next.responseCandidateSince = 0;
      next.reason = "Manual conversation turn interrupted the persistent Goal";
      next.updatedAt = now();
      if (!await writeWorkflow(next)) return true;
    }

    const current = Commands.normalizeWorkflow(state.workflow);
    if (apiState.generating) {
      if (!current.manualInterruptionSawGeneration || current.responseCandidateFingerprint) {
        current.manualInterruptionSawGeneration = true;
        current.responseCandidateFingerprint = "";
        current.responseCandidateSince = 0;
        current.reason = "Waiting for the manual conversation turn to finish";
        current.updatedAt = now();
        await writeWorkflow(current);
      }
      return true;
    }

    if (!current.manualInterruptionSawGeneration) return true;
    const assistantText = Platforms.latestAssistantText(adapter());
    const candidateFingerprint = Commands.fingerprint(assistantText);
    if (!assistantText || candidateFingerprint === current.lastAssistantFingerprint) return true;
    if (current.responseCandidateFingerprint !== candidateFingerprint) {
      current.responseCandidateFingerprint = candidateFingerprint;
      current.responseCandidateSince = now();
      current.reason = "Waiting for the manual conversation response to settle";
      current.updatedAt = now();
      await writeWorkflow(current);
      return true;
    }
    const quietSince = Math.max(current.responseCandidateSince, apiState.lastDomActivityAt || 0, apiState.lastGenerationAt || 0);
    if (now() - quietSince < Lifecycle.responseStableMs("continue")) return true;

    const prompt = Commands.workflowPrompt(current, "continue");
    const queued = await queuePrompt(prompt, { workflow: current, source: "workflow:goal" });
    if (!queued.ok) await markWorkflow("blocked", queued.reason || "Could not resume the Goal after a manual conversation turn", "command.workflow.interruption_queue_failed");
    else await record("Manual conversation turn completed; resumed the persistent Goal", "info", "command.workflow.interruption_resumed");
    return true;
  }

  async function handleConversationLimitBeforeWorkflow() {
    const workflow = Commands.normalizeWorkflow(state.workflow);
    if (workflow.kind !== "goal" || !workflow.objective || ["idle", "completed"].includes(workflow.status)) return false;
    const api = engine();
    if (!api || !await api.ensureReady()) return false;
    const apiState = api.getState();
    if (!apiState.hydrated) return false;
    const stopState = Platforms.conversationLimitState(adapter(), document);
    if (!stopState) return false;
    if (workflow.status !== "rollover_required" && !await markWorkflow("rollover_required", stopState.reason, stopState.code)) return true;
    await handleRollover();
    return true;
  }

  async function handleWorkflow() {
    if (Commands.normalizeWorkflow(state.workflow).status !== "running") return false;
    if (!await claimWorkflow()) return false;
    const workflow = Commands.normalizeWorkflow(state.workflow);
    if (workflow.runnerId !== state.ownerId) return false;
    const api = engine();
    if (!api || !await api.ensureReady()) return false;
    const apiState = api.getState();
    if (!apiState.hydrated) return false;

    if (workflow.pendingItemId) return handlePendingWorkflowItem(apiState);
    if (!workflow.awaitingResponse) return false;

    const stopState = Platforms.workflowStopState(adapter(), apiState.settings || {}, document);
    if (stopState) {
      const marked = await markWorkflow(stopState.status, stopState.reason, stopState.code);
      if (marked && stopState.status === "rollover_required") await handleRollover();
      return true;
    }

    if (await handleManualGoalInterruption(Commands.normalizeWorkflow(state.workflow), apiState)) return true;

    if (apiState.generating) {
      if (!workflow.sawGeneration || workflow.responseCandidateFingerprint) {
        workflow.sawGeneration = true;
        workflow.responseCandidateFingerprint = "";
        workflow.responseCandidateSince = 0;
        workflow.reason = "ChatGPT is working";
        workflow.updatedAt = now();
        await writeWorkflow(workflow);
      }
      return false;
    }

    if (now() - workflow.lastPromptAt < RESPONSE_SETTLE_MS) return false;
    const assistantText = Platforms.latestAssistantText(adapter());
    const candidateFingerprint = Commands.fingerprint(assistantText);
    if (!assistantText || candidateFingerprint === workflow.baselineFingerprint || candidateFingerprint === workflow.lastAssistantFingerprint) return false;
    if (workflow.responseCandidateFingerprint !== candidateFingerprint) {
      workflow.responseCandidateFingerprint = candidateFingerprint;
      workflow.responseCandidateSince = now();
      workflow.reason = "Waiting for ChatGPT response to settle";
      workflow.updatedAt = now();
      await writeWorkflow(workflow);
      return false;
    }
    const outcome = Commands.evaluateResponse(assistantText);
    const quietSince = Math.max(workflow.responseCandidateSince, apiState.lastDomActivityAt || 0, apiState.lastGenerationAt || 0);
    if (now() - quietSince < Lifecycle.responseStableMs(outcome)) return false;
    return processResponse();
  }

  async function tick() {
    if (state.destroyed || state.tickInFlight) return;
    state.tickInFlight = true;
    try {
      await withWorkflowLock(async () => {
        await syncRoute();
        await handleConversationLimitBeforeWorkflow();
        await handleRollover();
        await handleWorkflow();
      });
      syncUI();
      if (!document.hidden) state.ui?.reposition?.();
    } finally {
      state.tickInFlight = false;
    }
  }

  function editWorkflow(workflow) {
    setComposerText(`/${workflow.kind} ${workflow.kind === "loop" ? `${workflow.maxIterations} ` : ""}${workflow.objective}`);
    composer()?.focus?.();
  }

  function mountUI() {
    state.ui = CommandUI.mount({
      execute: executeCommand,
      pause: () => executeCommand("pause"),
      resume: () => executeCommand("resume"),
      stop: () => executeCommand("stop"),
      edit: editWorkflow,
      getComposer: composer,
      getComposerText: composerText,
      setComposerText
    });
    syncUI();
  }

  function getHealth() {
    const workflow = Commands.normalizeWorkflow(state.workflow);
    return {
      status: workflow.status,
      active: ["running", "rollover_pending"].includes(workflow.status),
      awaitingResponse: workflow.awaitingResponse,
      pendingItemId: workflow.pendingItemId,
      iteration: workflow.iteration,
      lastPromptAt: workflow.lastPromptAt
    };
  }

  function schedulePoll(immediate = false) {
    window.clearTimeout(state.pollTimer);
    if (state.destroyed) return;
    const apiState = engine()?.getState?.() || {};
    const delay = immediate ? 0 : Lifecycle.workflowPollDelay({
      hidden: document.hidden,
      workflowActive: getHealth().active,
      generating: Boolean(apiState.generating)
    });
    state.pollTimer = window.setTimeout(async () => {
      try {
        await tick();
      } catch (error) {
        await record(`Workflow poll failed: ${Shared.errorMessage(error)}`, "error", "command.workflow.poll_failed").catch((recordError) => {
          console.error(`Workflow poll status record failed: ${Shared.errorMessage(recordError)}`);
        });
      } finally {
        schedulePoll();
      }
    }, delay);
  }

  function addLifecycleHandler(target, eventName, handler) {
    target.addEventListener(eventName, handler);
    state.lifecycleHandlers.push({ target, eventName, handler });
  }

  function wakeRuntime() {
    if (!state.destroyed) schedulePoll(true);
  }

  function destroy() {
    if (state.destroyed) return;
    releaseWorkflow();
    state.destroyed = true;
    window.clearTimeout(state.pollTimer);
    state.unregisterEngineClient?.();
    state.ui?.destroy?.();
    for (const { target, eventName, handler } of state.lifecycleHandlers) target.removeEventListener(eventName, handler);
    state.lifecycleHandlers = [];
  }

  window.__YOLO_COMMAND_RUNTIME__ = { version: Config.VERSION, destroy, getHealth };
  mountUI();
  const api = engine();
  state.unregisterEngineClient = api?.registerClient?.(destroy) || null;
  addLifecycleHandler(document, "visibilitychange", wakeRuntime);
  addLifecycleHandler(window, "pageshow", wakeRuntime);
  addLifecycleHandler(document, "resume", wakeRuntime);
  syncRoute().then(() => schedulePoll(true));
})();
