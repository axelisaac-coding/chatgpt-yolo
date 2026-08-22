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
    ownerId: Shared.makeId("command")
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

  async function queuePrompt(text, { workflow = null, source = "command" } = {}) {
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
        item: { text: prompt, source, sourceId: "" }
      });
    }
    if (!response?.ok) return response || { ok: false, reason: "Could not add the command prompt to the queue" };

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
    if (!["paused", "stalled", "blocked"].includes(state.workflow.status)) return { ok: false, reason: "Workflow is not paused", keepOpen: true };
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
    state.ui?.showStatus({
      Conversation: state.pageId || "Unavailable",
      Workflow: workflow.status === "idle" ? "None" : `/${workflow.kind} · ${workflow.status}`,
      Objective: workflow.status === "idle" ? "—" : workflow.objective,
      Iteration: workflow.status === "idle" ? "—" : `${workflow.iteration}/${workflow.maxIterations}`,
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
      return true;
    }
    if (decision.action === "recover") {
      const prompt = Commands.workflowPrompt(state.workflow, "recovery");
      const queued = await queuePrompt(prompt, { workflow: state.workflow, source: `workflow:${state.workflow.kind}` });
      if (!queued.ok) await markWorkflow("blocked", queued.reason || "Could not queue the workflow recovery prompt", "supervisor.recover.queue_failed");
      return true;
    }
    if (decision.action !== "continue") {
      await markWorkflow(decision.action, decision.reason, decision.code);
      return true;
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
      active: workflow.status === "running",
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
