(() => {
  "use strict";

  const Config = globalThis.YOLOConfig;
  const Shared = globalThis.YOLOShared;
  const Lifecycle = globalThis.YOLOLifecycle;
  const Commands = globalThis.YOLOCommands;
  const Platforms = globalThis.YOLOPlatforms;
  const ContentState = globalThis.YOLOContentState;
  if (!Config || !Shared || !Lifecycle || !Commands || !Platforms || !ContentState) return;

  if (window.__YOLO_EXTENSION__?.version === Config.VERSION) return;
  window.__YOLO_EXTENSION__?.destroy?.();

  const COUNTER_BY_ACTION = Object.freeze({
    approval: "approvalsClicked",
    recovery: "continuesSent",
    nudge: "deepNudgesSent",
    refresh: "refreshesTriggered",
    queue: "queuedMessagesSent"
  });

  const LIMIT_FIELD_BY_ACTION = Object.freeze({
    approval: "approvalLimitPerHour",
    recovery: "errorLimitPerHour",
    nudge: "deepNudgeLimitPerHour",
    refresh: "refreshLimitPerHour",
    queue: "queueLimitPerHour"
  });

  const FAILED_RECOVERY_RETRY_MS = 15 * 1000;

  const state = ContentState.state;
  const randomMs = ContentState.randomMs;

  const now = () => Date.now();
  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const currentPageId = () => Config.pageId(location.href);
  const routeIsCurrent = () => currentPageId() === state.pageId;
  const workflowHealth = () => window.__YOLO_COMMAND_RUNTIME__?.getHealth?.() || {
    status: "idle",
    active: false,
    awaitingResponse: false,
    pendingItemId: ""
  };
  const isContextInvalidated = (error) => /context invalidated|extension context/i.test(Shared.errorMessage(error));

  function disableStaleContext(error) {
    if (!isContextInvalidated(error)) return false;
    destroy();
    return true;
  }

  const storageGet = (keys) => Shared.storageGet(keys, {
    soft: true,
    isDestroyed: () => state.destroyed,
    onContextInvalidated: disableStaleContext
  });

  const storageSet = (items) => Shared.storageSet(items, {
    soft: true,
    isDestroyed: () => state.destroyed,
    onContextInvalidated: disableStaleContext
  });

  const backgroundSend = (message) => Shared.sendMessage(message, {
    soft: true,
    isDestroyed: () => state.destroyed,
    onContextInvalidated: disableStaleContext
  });

  async function backgroundSendWithRetry(message, attempts = 3) {
    for (let index = 0; index < attempts; index += 1) {
      const response = await backgroundSend(message);
      if (response) return response;
      if (index < attempts - 1) await sleep(150 * (index + 1));
    }
    return null;
  }

  async function claimActionGuard(actionKey, cooldownMs = 0, leaseMs = 20 * 1000) {
    return backgroundSendWithRetry({
      type: "YOLO_ACTION_CLAIM",
      pageId: state.pageId,
      actionKey,
      ownerId: state.ownerId,
      cooldownMs,
      leaseMs
    });
  }

  async function beginActionGuard(actionKey, token) {
    return backgroundSendWithRetry({ type: "YOLO_ACTION_BEGIN", pageId: state.pageId, actionKey, token });
  }

  async function completeActionGuard(actionKey, token) {
    return backgroundSendWithRetry({ type: "YOLO_ACTION_COMPLETE", pageId: state.pageId, actionKey, token });
  }

  async function releaseActionGuard(actionKey, token) {
    return backgroundSendWithRetry({ type: "YOLO_ACTION_RELEASE", pageId: state.pageId, actionKey, token });
  }

  async function appendEvent(code, message, level = "info") {
    if (!state.pageId || state.destroyed) return;
    await backgroundSend({
      type: "YOLO_EVENT_APPEND",
      pageId: state.pageId,
      event: { code, message, level, at: now() }
    });
  }

  async function setLastAction(message, level = "info", code = "status", logEvent = false) {
    state.lastAction = { message, at: now(), level, code };
    const value = { ...state.lastAction, url: location.href, pageId: state.pageId };
    await storageSet({
      [Config.lastActionKey(state.pageId)]: value,
      [Config.STORAGE_KEYS.lastAction]: value
    });
    if (logEvent) await appendEvent(code, message, level);
  }

  async function setBlocked(code, message, { log = false } = {}) {
    const changed = state.blockedCode !== code || state.blockedReason !== message;
    state.blockedCode = code;
    state.blockedReason = message;
    if (log && changed) await appendEvent(code, message, "warning");
  }

  function clearBlocked(prefix = "") {
    if (!prefix || state.blockedCode.startsWith(prefix)) {
      state.blockedCode = "";
      state.blockedReason = "";
    }
  }

  async function incrementCounter(key) {
    if (!key) return;
    const stored = await storageGet([Config.STORAGE_KEYS.counters]);
    const counters = { ...(stored[Config.STORAGE_KEYS.counters] || {}) };
    counters[key] = (Number(counters[key]) || 0) + 1;
    counters.updatedAt = now();
    state.counters = { ...state.counters, ...counters };
    await storageSet({ [Config.STORAGE_KEYS.counters]: counters });
  }

  async function loadSettings() {
    const pageKey = Config.pageSettingsKey(state.pageId);
    const actionKey = Config.lastActionKey(state.pageId);
    const stored = await storageGet([
      Config.STORAGE_KEYS.global,
      Config.STORAGE_KEYS.pages,
      Config.STORAGE_KEYS.counters,
      Config.STORAGE_KEYS.lastAction,
      pageKey,
      actionKey
    ]);

    const globalSettings = stored[Config.STORAGE_KEYS.global] || {};
    const legacyPageSettings = stored[Config.STORAGE_KEYS.pages]?.[state.pageId] || {};
    const pageSettings = stored[pageKey] || legacyPageSettings;
    state.settings = Config.mergeSettings(Config.DEFAULT_SETTINGS, globalSettings, pageSettings);
    state.counters = { ...state.counters, ...(stored[Config.STORAGE_KEYS.counters] || {}) };

    const storedLastAction = stored[actionKey] || stored[Config.STORAGE_KEYS.lastAction];
    if (storedLastAction?.pageId === state.pageId && storedLastAction?.message) state.lastAction = storedLastAction;
    else state.lastAction = { message: "Idle", at: now(), level: "info", code: "idle" };

    state.runtime = ContentState.loadRuntime();
    ContentState.scheduleNextRefresh();
    ContentState.scheduleNextQueue();
    state.loaded = true;
  }

  async function ensureCurrentRoute() {
    if (!routeIsCurrent()) await handleRouteChange();
    for (let attempt = 0; attempt < 40 && state.routeInFlight; attempt += 1) await sleep(25);
    return routeIsCurrent() && !state.routeInFlight && state.loaded;
  }

  async function persistSettings(nextSettings) {
    if (!await ensureCurrentRoute()) throw new Error("Conversation navigation is still in progress");
    const normalized = Config.mergeSettings(state.settings, nextSettings);
    const response = await backgroundSendWithRetry({
      type: "YOLODATA_SETTINGS_SET",
      pageId: state.pageId,
      settings: normalized
    });
    if (!response?.ok) throw new Error(response?.reason || "Could not persist conversation settings");

    state.settings = Config.normalizeSettings(response.settings || normalized);
    ContentState.scheduleNextRefresh(true);
    ContentState.scheduleNextQueue(true);
    restartScanTimer();
    return state.settings;
  }

  function actionLimit(action) {
    return Number(state.settings[LIMIT_FIELD_BY_ACTION[action]]) || 0;
  }

  function checkActionLimit(action) {
    const status = Config.limitStatus(
      state.runtime?.history?.[action],
      actionLimit(action),
      state.runtime?.sessionActionCount || 0,
      state.settings.maxActionsPerSession,
      now()
    );
    if (state.runtime) state.runtime.history[action] = status.recent;
    if (!status.allowed) {
      state.blockedCode = status.code;
      state.blockedReason = status.reason;
    }
    return status;
  }

  async function recordAction(action, counterKey = COUNTER_BY_ACTION[action], { incrementSession = true } = {}) {
    const timestamp = now();
    state.runtime.history[action] = Config.pruneHistory([...(state.runtime.history[action] || []), timestamp], timestamp);
    if (incrementSession) state.runtime.sessionActionCount += 1;
    state.runtime.lastActionAt = timestamp;
    clearBlocked();
    ContentState.saveRuntime();
    await incrementCounter(counterKey);
  }

  function composerHasText(composer = Platforms.findComposer(state.platform)) {
    return Boolean(Platforms.composerText(composer).trim());
  }

  function probeHydration() {
    const composerPresent = Boolean(Platforms.findComposer(state.platform));
    if (document.readyState === "loading" || !composerPresent) {
      state.hydrated = false;
      state.hydratedAt = 0;
      state.hydrationCandidateSince = 0;
      return false;
    }
    if (state.hydrated) return true;
    const candidate = Lifecycle.hydrationCandidate({
      documentReadyState: document.readyState,
      composerPresent,
      lastDomActivityAt: state.lastDomActivityAt,
      now: now()
    });
    if (!candidate) {
      state.hydrationCandidateSince = 0;
      return false;
    }
    if (!state.hydrationCandidateSince) state.hydrationCandidateSince = now();
    if (now() - state.hydrationCandidateSince < Lifecycle.HYDRATION_QUIET_MS) return false;
    state.hydrated = true;
    state.hydratedAt = now();
    return true;
  }

  function automationReady() {
    if (!state.loaded || state.destroyed || !state.platform || !state.settings.enabled || !routeIsCurrent()) return false;
    if (!Config.isDurablePageId(state.pageId) || !probeHydration()) return false;
    return now() - Math.max(state.pageLoadedAt, state.hydratedAt) >= state.settings.loadGraceSec * 1000;
  }

  function hydrationRetryAfterMs(timestamp = now()) {
    if (state.hydrated || document.readyState === "loading") return 0;
    const anchor = state.hydrationCandidateSince || state.lastDomActivityAt;
    return Math.max(0, anchor + Lifecycle.HYDRATION_QUIET_MS - timestamp);
  }

  function checkSafeForInput(workflow = workflowHealth()) {
    const timestamp = now();
    const routeCurrent = routeIsCurrent();
    const durablePage = Config.isDurablePageId(state.pageId);
    const composer = routeCurrent && durablePage ? Platforms.findComposer(state.platform) : null;
    const hydrated = Boolean(composer) && probeHydration();
    return Lifecycle.inputSafety({
      routeCurrent,
      durablePage,
      composerPresent: Boolean(composer),
      hydrated,
      hydrationRetryAfterMs: hydrationRetryAfterMs(timestamp),
      workflowAwaitingResponse: Boolean(workflow.awaitingResponse),
      generating: state.generationActive || Platforms.isGenerating(state.platform),
      generationHoldUntil: state.generationHoldUntil,
      lastDomActivityAt: state.lastDomActivityAt,
      composerBusy: Boolean(composer && Platforms.composerText(composer).trim()),
      now: timestamp
    });
  }

  function safeForInput() {
    const workflow = workflowHealth();
    if (workflow.awaitingResponse) return false;
    return checkSafeForInput(workflow).safe;
  }

  function scheduleInputRetry(safety, automatic) {
    const retryAfterMs = Math.max(0, Number(safety?.retryAfterMs) || 0);
    if (retryAfterMs <= 0) return;
    if (!automatic) state.pendingManualQueueRetry = true;
    queueCycle(retryAfterMs + 25);
  }

  function updateGenerationState() {
    const active = Platforms.isGenerating(state.platform);
    const timestamp = now();
    const wasGenerating = state.generationActive;
    const transitioned = wasGenerating !== active;
    state.generationHoldUntil = Lifecycle.nextGenerationHoldUntil({
      wasGenerating,
      generating: active,
      currentHoldUntil: state.generationHoldUntil,
      now: timestamp
    });
    if (state.runtime) {
      if (active || (wasGenerating && !active)) state.runtime.lastGenerationAt = timestamp;
      if (transitioned || (active && timestamp - state.lastGenerationPersistAt >= 30_000)) {
        state.lastGenerationPersistAt = timestamp;
        ContentState.saveRuntime();
      }
    }
    state.generationActive = active;
    return active;
  }

  function inputActionCooldownPassed(action) {
    const lastAt = state.runtime?.history?.[action]?.at(-1) || 0;
    const cooldownSec = action === "recovery" ? state.settings.errorCooldownSec : state.settings.deepNudgeCooldownSec;
    return now() - lastAt >= cooldownSec * 1000;
  }

  async function writeAndSubmit(prompt, actionPageId) {
    let submissionAttempted = false;
    try {
      let composer = Platforms.findComposer(state.platform);
      if (!composer) {
        return { ok: false, code: "composer.missing", reason: "Message composer was not found", deliveryAmbiguous: false };
      }
      if (Platforms.composerText(composer).trim()) {
        return { ok: false, code: "composer.busy", reason: "Message composer contains a draft", deliveryAmbiguous: false };
      }

      const previousSnapshot = Platforms.userMessageSnapshot(state.platform, document, prompt);
      const expectedFingerprint = Commands.fingerprint(prompt);
      Platforms.setComposerValue(composer, prompt);
      await sleep(120);
      if (state.destroyed || state.pageId !== actionPageId || currentPageId() !== actionPageId) {
        return { ok: false, code: "route.changed", reason: "Conversation changed before the message was submitted", deliveryAmbiguous: false };
      }
      composer = Platforms.findComposer(state.platform) || composer;
      if (Commands.fingerprint(Platforms.composerText(composer)) !== expectedFingerprint) {
        return { ok: false, code: "composer.write_unconfirmed", reason: "The composer did not retain the queued message", deliveryAmbiguous: false };
      }

      submissionAttempted = true;
      if (!Platforms.submitComposer(state.platform, composer)) {
        return { ok: false, code: "composer.submit_failed", reason: "Message could not be submitted", deliveryAmbiguous: true };
      }

      const confirmationDeadline = now() + 15_000;
      while (now() < confirmationDeadline) {
        if (state.destroyed || state.pageId !== actionPageId || currentPageId() !== actionPageId) {
          return { ok: false, code: "route.changed", reason: "Conversation changed before delivery could be confirmed", deliveryAmbiguous: true };
        }
        if (Platforms.submissionObserved(state.platform, { expectedText: prompt, previousSnapshot })) {
          return { ok: true, deliveryAmbiguous: true };
        }
        await sleep(150);
      }
      const receipt = Platforms.userMessageSnapshot(state.platform, document, prompt);
      const receiptDiag = [
        `users=${receipt.count}`,
        `expected=${receipt.expectedCount}/${previousSnapshot.expectedCount}`,
        `latestLen=${receipt.latestText.length}`,
        `expectedLen=${receipt.expectedText.length}`,
        `latestFp=${Commands.fingerprint(receipt.latestText).slice(0, 12)}`,
        `expectedFp=${Commands.fingerprint(receipt.expectedText).slice(0, 12)}`
      ].join(" " );
      return {
        ok: false,
        code: "composer.unconfirmed",
        reason: `The matching user message did not appear in the conversation [${receiptDiag}]`,
        deliveryAmbiguous: true
      };
    } catch (error) {
      return {
        ok: false,
        code: "queue.exception",
        reason: Shared.errorMessage(error),
        deliveryAmbiguous: submissionAttempted
      };
    }
  }

  function actionDedupeKey(action, prompt, reason) {
    return `auto:${action}:${Commands.fingerprint(`${prompt}\n${reason}`)}`;
  }

  async function sendPrompt({ action, prompt, label, reason, delayMinSec = 0, delayMaxSec = 0, automatic = true }) {
    if (state.actionInFlight || !state.platform) return false;
    const actionPageId = state.pageId;
    if (automatic && !automationReady()) return false;
    if (!automatic && (!state.loaded || !routeIsCurrent() || !Config.isDurablePageId(state.pageId))) return false;
    if (!safeForInput()) return false;
    if ((action === "recovery" || action === "nudge") && !inputActionCooldownPassed(action)) return false;

    const limit = checkActionLimit(action);
    if (!limit.allowed) {
      await setLastAction(`${label} blocked: ${limit.reason}`, "warning", limit.code, true);
      return false;
    }

    const delayMs = automatic ? randomMs(delayMinSec, delayMaxSec) : 150;
    if (delayMs > 0) await sleep(delayMs);
    if (state.destroyed || state.pageId !== actionPageId || currentPageId() !== actionPageId || !safeForInput()) return false;

    const queued = await backgroundSend({
      type: "YOLO_QUEUE_ADD",
      pageId: actionPageId,
      front: true,
      requireUnpaused: automatic,
      dedupeWindowMs: automatic
        ? Math.max(1000, (action === "recovery" ? state.settings.errorCooldownSec : state.settings.deepNudgeCooldownSec) * 1000)
        : 0,
      item: {
        text: prompt,
        source: `action:${action}`,
        sourceId: reason,
        dedupeKey: automatic ? actionDedupeKey(action, prompt, reason) : ""
      }
    });
    if (!queued?.ok) {
      await setBlocked(queued?.code || `action.${action}.queue_failed`, queued?.reason || `Could not queue ${label}`);
      return false;
    }
    if (queued.alreadyCompleted) return true;

    const sent = await handleQueue(false);
    if (!sent && !queued.deduplicated) {
      await setLastAction(`Queued ${label} (${reason})`, "info", `action.${action}.queued`, true);
    }
    return sent;
  }

  async function sendContinue(reason, automatic = true) {
    return sendPrompt({ action: "recovery", prompt: "Continue", label: "Continue", reason, automatic });
  }

  async function sendDeepNudge(reason, automatic = true) {
    return sendPrompt({ action: "nudge", prompt: state.settings.deepNudgePrompt, label: "deep nudge", reason, automatic });
  }

  function refreshCooldownPassed() {
    const cooldownMs = state.settings.refreshCooldownMin * 60 * 1000;
    return now() - (state.runtime.lastRefreshAt || 0) >= cooldownMs;
  }

  async function refreshPage(reason, automatic = true, action = "refresh") {
    if (state.actionInFlight || !state.platform || state.reloadScheduled) return false;
    const actionPageId = state.pageId;
    if (automatic && !automationReady()) return false;
    if (!automatic && (!state.loaded || !routeIsCurrent() || !Config.isDurablePageId(state.pageId))) return false;
    const workflow = workflowHealth();
    const generating = updateGenerationState();
    if (action === "refresh" && automatic && !Lifecycle.canAutomaticRefresh({
      hydrated: state.hydrated,
      workflowActive: workflow.active,
      generating: generating || now() < state.generationHoldUntil,
      composerBusy: composerHasText(),
      lastDomActivityAt: state.lastDomActivityAt,
      now: now()
    })) return false;
    if (generating || composerHasText()) return false;
    if (action === "refresh" && !refreshCooldownPassed()) return false;

    const limit = checkActionLimit(action);
    if (!limit.allowed) {
      await setLastAction(`Refresh blocked: ${limit.reason}`, "warning", limit.code, true);
      return false;
    }

    const cooldownMs = state.settings.refreshCooldownMin * 60 * 1000;
    const guard = await claimActionGuard("refresh", cooldownMs, Math.max(2 * 60 * 1000, cooldownMs));
    if (!guard?.ok) return false;

    state.actionInFlight = true;
    let completedGuard = false;
    try {
      if (state.pageId !== actionPageId || currentPageId() !== actionPageId || composerHasText()) return false;
      state.runtime.lastRefreshAt = now();
      ContentState.scheduleNextRefresh(true);
      const completed = await completeActionGuard("refresh", guard.token);
      completedGuard = Boolean(completed?.ok);
      if (!completedGuard) {
        await setLastAction("Refresh blocked: could not persist the cross-tab cooldown", "error", "refresh.guard_unconfirmed", true);
        return false;
      }
      await recordAction(action, "refreshesTriggered");
      await setLastAction(`Refreshing (${reason})`, "success", `action.${action}.refresh`, true);
      state.reloadScheduled = true;
      window.setTimeout(() => {
        if (currentPageId() === actionPageId) location.reload();
        else {
          state.reloadScheduled = false;
          state.actionInFlight = false;
          queueCycle();
        }
      }, automatic ? 500 : 150);
      return true;
    } finally {
      if (!completedGuard) await releaseActionGuard("refresh", guard.token);
      if (!state.reloadScheduled) state.actionInFlight = false;
    }
  }

  function errorSignature(element) {
    const text = Platforms.normalizedText(element).replace(/\s+/g, " ").trim().slice(0, 320);
    return `${state.platform?.id || "unknown"}:${text}`;
  }

  async function handleErrorState() {
    if (!automationReady() || !state.settings.errorRecoveryEnabled || state.actionInFlight) return false;
    const error = Platforms.findErrorState(state.platform);
    if (!error) return false;

    const signature = errorSignature(error);
    const cooldownMs = state.settings.errorCooldownSec * 1000;
    if (signature === state.runtime.lastErrorSignature && now() - state.runtime.lastErrorHandledAt < cooldownMs) return false;

    const limit = checkActionLimit("recovery");
    if (!limit.allowed) {
      await setLastAction(`Recovery blocked: ${limit.reason}`, "warning", limit.code, true);
      return false;
    }

    const errorPageId = state.pageId;
    state.runtime.lastErrorSignature = signature;
    state.runtime.lastErrorHandledAt = now();
    ContentState.saveRuntime();
    await setLastAction("Detected error; attempting recovery", "warning", "recovery.detected", true);

    const delayMs = randomMs(state.settings.errorDelayMinSec, state.settings.errorDelayMaxSec);
    if (delayMs > 0) await sleep(delayMs);
    if (state.destroyed || state.pageId !== errorPageId || currentPageId() !== errorPageId) return false;

    const strategy = state.settings.errorRecoveryStrategy;
    let handled = false;
    if (strategy === "continue-only") handled = await sendContinue("error recovery");
    else if (strategy === "refresh-only") handled = await refreshPage("error recovery", true, "recovery");
    else if (strategy === "refresh-first") handled = (await refreshPage("error recovery", true, "recovery")) || await sendContinue("error recovery fallback");
    else handled = (await sendContinue("error recovery")) || await refreshPage("error recovery fallback", true, "recovery");

    if (!handled && state.runtime) {
      state.runtime.lastErrorHandledAt = now() - Math.max(0, cooldownMs - FAILED_RECOVERY_RETRY_MS);
      ContentState.saveRuntime();
    }
    return handled;
  }

  function pruneApprovalSignatures() {
    state.runtime.approvalSignatures = ContentState.normalizeApprovalSignatures(state.runtime.approvalSignatures, state.runtime.lastActionAt);
  }

  function recentlyApproved(signature) {
    pruneApprovalSignatures();
    return state.runtime.approvalSignatures.some((entry) => entry.signature === signature);
  }

  async function handleApprovalCards() {
    if (!automationReady() || !state.settings.approvalsEnabled || state.actionInFlight || !state.platform?.supportsApprovals) return false;
    if (updateGenerationState()) return false;

    const cooldownMs = state.settings.approvalCooldownSec * 1000;
    const lastApprovalAt = state.runtime.history.approval.at(-1) || 0;
    if (now() - lastApprovalAt < cooldownMs) return false;

    const limit = checkActionLimit("approval");
    if (!limit.allowed) return false;

    const approvalPageId = state.pageId;
    const candidates = Platforms.findApprovalCards(state.platform, state.settings.approvalPolicy);
    for (const candidate of candidates) {
      if (recentlyApproved(candidate.signature)) continue;

      state.actionInFlight = true;
      let guard = null;
      let clicked = false;
      try {
        await setLastAction(`Approval found: ${Platforms.buttonText(candidate.button) || "affirmative action"}`, "info", "approval.detected");
        await sleep(randomMs(state.settings.approvalDelayMinSec, state.settings.approvalDelayMaxSec));
        if (state.destroyed || state.pageId !== approvalPageId || currentPageId() !== approvalPageId) return false;
        updateGenerationState();
        if (state.generationActive || composerHasText()) return false;

        guard = await claimActionGuard("approval", cooldownMs, 10 * 60 * 1000);
        if (!guard?.ok) return false;
        const refreshedCandidate = Platforms.findApprovalCards(state.platform, state.settings.approvalPolicy)
          .find((entry) => entry.signature === candidate.signature);
        if (!refreshedCandidate || recentlyApproved(refreshedCandidate.signature)) return false;
        if (!refreshedCandidate.button.isConnected || !Platforms.visible(refreshedCandidate.button) || Platforms.isDisabled(refreshedCandidate.button)) return false;

        const begun = await beginActionGuard("approval", guard.token);
        if (!begun?.ok) return false;
        refreshedCandidate.button.click();
        clicked = true;
        const completed = await completeActionGuard("approval", guard.token);
        if (!completed?.ok) {
          await setLastAction("Approval clicked, but cross-tab completion could not be confirmed", "error", "approval.completion_unconfirmed", true);
          return true;
        }
        state.runtime.approvalSignatures = [
          ...state.runtime.approvalSignatures,
          { signature: refreshedCandidate.signature, at: now() }
        ].slice(-100);
        await recordAction("approval");
        await setLastAction(`Clicked approval: ${Platforms.buttonText(refreshedCandidate.button) || "affirmative action"}`, "success", `approval.${refreshedCandidate.risk}`, true);
        return true;
      } finally {
        if (guard?.ok && !clicked) await releaseActionGuard("approval", guard.token);
        state.actionInFlight = false;
      }
    }
    return false;
  }

  async function releaseQueueClaim(pageId, item, reason) {
    return backgroundSendWithRetry({
      type: "YOLO_QUEUE_RELEASE",
      pageId,
      itemId: item.id,
      claimToken: item.claimToken,
      reason
    });
  }

  async function failQueueClaim(pageId, item, error, options, errorCode = "queue.send_failed", deliveryAmbiguous = false) {
    return backgroundSendWithRetry({
      type: "YOLO_QUEUE_FAIL",
      pageId,
      itemId: item.id,
      claimToken: item.claimToken,
      error,
      errorCode,
      maxRetries: options.maxRetries,
      backoffSec: options.backoffSec,
      pauseOnFailure: options.pauseOnFailure,
      deliveryAmbiguous
    });
  }

  async function handleQueue(automatic = true) {
    if (state.actionInFlight || !state.platform) return false;
    if (automatic && (!automationReady() || !state.settings.queueAutoRunEnabled)) return false;
    if (!automatic) state.pendingManualQueueRetry = false;

    updateGenerationState();
    const safety = checkSafeForInput();
    if (!safety.safe) {
      if (!automatic) await setBlocked(safety.code, safety.reason);
      scheduleInputRetry(safety, automatic);
      return false;
    }
    if (!automatic && !state.loaded) return false;
    if (!automatic) clearBlocked();
    if (automatic && now() < (state.runtime.nextQueueAt || 0)) return false;

    if (automatic) {
      const idleBaseline = Math.max(state.pageLoadedAt, state.runtime.lastUserActivityAt, state.runtime.lastGenerationAt);
      if (now() - idleBaseline < state.settings.queueIdleSec * 1000) return false;
    }

    const limit = checkActionLimit("queue");
    if (!limit.allowed) {
      await setLastAction(`Queue blocked: ${limit.reason}`, "warning", limit.code, true);
      return false;
    }

    const queuePageId = state.pageId;
    const queueFailureOptions = {
      maxRetries: state.settings.queueMaxRetries,
      backoffSec: state.settings.queueRetryBackoffSec,
      pauseOnFailure: state.settings.queuePauseOnFailure
    };
    const claim = await backgroundSend({
      type: "YOLO_QUEUE_CLAIM",
      pageId: queuePageId,
      ownerId: state.ownerId
    });
    if (!claim?.ok || !claim.item) {
      if (claim?.code === "queue.paused") await setBlocked("queue.paused", "Queue is paused");
      else if (state.blockedCode.startsWith("queue.")) clearBlocked("queue.");
      return false;
    }

    const item = claim.item;
    let deliveryAmbiguous = false;
    state.actionInFlight = true;
    try {
      if (state.destroyed || state.pageId !== queuePageId || currentPageId() !== queuePageId) {
        await releaseQueueClaim(queuePageId, item, "Conversation changed before the queued message could send");
        return false;
      }
      updateGenerationState();
      const sendSafety = checkSafeForInput();
      if (!sendSafety.safe) {
        await releaseQueueClaim(queuePageId, item, `Queue paused before send: ${sendSafety.reason}`);
        if (!automatic) await setBlocked(sendSafety.code, sendSafety.reason);
        scheduleInputRetry(sendSafety, automatic);
        return false;
      }

      const markedSubmitting = await backgroundSendWithRetry({
        type: "YOLO_QUEUE_MARK_SUBMITTING",
        pageId: queuePageId,
        itemId: item.id,
        claimToken: item.claimToken
      });
      if (!markedSubmitting?.ok) {
        await releaseQueueClaim(queuePageId, item, "Could not persist the queue submission phase");
        await setLastAction("Queue send blocked: could not persist delivery intent", "error", "queue.submit_intent_failed", true);
        return false;
      }

      await setLastAction("Sending queued message", "info", "queue.sending");
      const submitted = await writeAndSubmit(item.text, queuePageId);
      deliveryAmbiguous = Boolean(submitted.deliveryAmbiguous);
      if (!submitted.ok) {
        await failQueueClaim(queuePageId, item, submitted.reason, queueFailureOptions, submitted.code, deliveryAmbiguous);
        await setLastAction(`Queue send failed: ${submitted.reason}`, "error", submitted.code, true);
        return false;
      }
      deliveryAmbiguous = true;

      const completed = await backgroundSendWithRetry({
        type: "YOLO_QUEUE_COMPLETE",
        pageId: queuePageId,
        itemId: item.id,
        claimToken: item.claimToken
      });
      if (!completed?.ok) {
        await setLastAction("Message sent, but queue completion could not be confirmed", "warning", "queue.completion_unconfirmed", true);
        return true;
      }

      await recordAction("queue");
      const sourceAction = item.source?.startsWith("action:") ? item.source.slice("action:".length) : "";
      if (["recovery", "nudge"].includes(sourceAction)) {
        await recordAction(sourceAction, COUNTER_BY_ACTION[sourceAction], { incrementSession: false });
      }
      ContentState.scheduleNextQueue(true);
      await setLastAction(sourceAction ? `Sent ${sourceAction} prompt` : "Sent queued message", "success", sourceAction ? `action.${sourceAction}` : "queue.sent", true);
      return true;
    } catch (error) {
      await failQueueClaim(queuePageId, item, Shared.errorMessage(error), queueFailureOptions, "queue.exception", deliveryAmbiguous);
      await setLastAction(`Queue send failed: ${Shared.errorMessage(error)}`, "error", "queue.failed", true);
      return false;
    } finally {
      state.actionInFlight = false;
    }
  }

  async function handleDeepNudge() {
    if (!automationReady() || !state.settings.deepNudgesEnabled || state.actionInFlight) return false;
    if (updateGenerationState() || !safeForInput()) return false;

    const lastNudgeAt = state.runtime.history.nudge.at(-1) || 0;
    if (now() - lastNudgeAt < state.settings.deepNudgeCooldownSec * 1000) return false;

    const idleBaseline = Math.max(state.pageLoadedAt, state.runtime.lastUserActivityAt, state.runtime.lastGenerationAt, state.runtime.lastActionAt);
    if (now() - idleBaseline < state.settings.deepNudgeIdleSec * 1000) return false;
    return sendDeepNudge("idle");
  }

  async function handlePeriodicRefresh() {
    if (!automationReady() || !state.settings.autoRefreshEnabled || state.actionInFlight) return false;
    ContentState.scheduleNextRefresh();
    if (now() < state.runtime.nextRefreshAt) return false;
    if (updateGenerationState() || !safeForInput()) return false;

    const idleBaseline = Math.max(state.pageLoadedAt, state.runtime.lastUserActivityAt, state.runtime.lastGenerationAt, state.runtime.lastActionAt);
    if (now() - idleBaseline < state.settings.refreshIdleMin * 60 * 1000) return false;
    return refreshPage("scheduled idle refresh");
  }

  async function runCycle() {
    if (state.destroyed || state.cycleInFlight || !state.loaded || state.reloadScheduled) return;
    state.cycleInFlight = true;
    try {
      if (!routeIsCurrent()) {
        await handleRouteChange();
        return;
      }
      updateGenerationState();
      if (!probeHydration()) return;
      if (await handleErrorState()) return;
      if (await handleApprovalCards()) return;
      if (state.pendingManualQueueRetry && await handleQueue(false)) return;
      if (await handleQueue(true)) return;
      if (await handleDeepNudge()) return;
      await handlePeriodicRefresh();
    } catch (error) {
      if (!disableStaleContext(error)) await setLastAction(`Automation error: ${Shared.errorMessage(error)}`, "error", "engine.error", true);
    } finally {
      state.cycleInFlight = false;
    }
  }

  function queueCycle(delayMs = null) {
    if (state.destroyed || state.reloadScheduled) return;
    const requested = delayMs == null
      ? Lifecycle.mutationDelay({ hidden: document.hidden, generating: state.generationActive })
      : delayMs;
    const delay = Math.max(0, Number.isFinite(Number(requested)) ? Number(requested) : 0);
    const wakeAt = now() + delay;
    if (state.scanQueued && state.scanWakeAt <= wakeAt) return;

    window.clearTimeout(state.scanWakeTimer);
    state.scanQueued = true;
    state.scanWakeAt = wakeAt;
    state.scanWakeTimer = window.setTimeout(() => {
      state.scanQueued = false;
      state.scanWakeTimer = null;
      state.scanWakeAt = 0;
      if (state.cycleInFlight) {
        queueCycle(50);
        return;
      }
      runCycle();
    }, Math.max(0, wakeAt - now()));
  }

  function restartScanTimer() {
    window.clearTimeout(state.scanTimer);
    if (state.destroyed || state.reloadScheduled) return;
    const delay = Lifecycle.scanDelay({
      hidden: document.hidden,
      generating: state.generationActive,
      configuredSec: state.settings.scanIntervalSec
    });
    state.scanTimer = window.setTimeout(async () => {
      try {
        await runCycle();
      } finally {
        restartScanTimer();
      }
    }, delay);
  }

  function restartRouteTimer() {
    window.clearTimeout(state.routeTimer);
    if (state.destroyed || state.reloadScheduled) return;
    state.routeTimer = window.setTimeout(async () => {
      try {
        await handleRouteChange();
      } catch (error) {
        if (!disableStaleContext(error)) await setLastAction(`Route synchronization failed: ${Shared.errorMessage(error)}`, "error", "route.sync_failed", true);
      } finally {
        restartRouteTimer();
      }
    }, Lifecycle.routeDelay({ hidden: document.hidden }));
  }

  async function handleRouteChange() {
    const nextPageId = currentPageId();
    if (nextPageId === state.pageId || state.routeInFlight || state.reloadScheduled) return;

    state.routeInFlight = true;
    try {
      ContentState.saveRuntime();
      state.pageId = nextPageId;
      state.platform = Platforms.adapterForLocation();
      state.pageLoadedAt = now();
      state.loaded = false;
      state.hydrated = false;
      state.hydratedAt = 0;
      state.hydrationCandidateSince = 0;
      state.lastDomActivityAt = now();
      state.generationHoldUntil = 0;
      state.lastGenerationPersistAt = 0;
      state.pendingManualQueueRetry = false;
      clearBlocked();
      state.generationActive = false;
      await loadSettings();
      restartScanTimer();
      await setLastAction("Loaded settings for this conversation", "info", "route.loaded");
      queueCycle();
    } finally {
      state.routeInFlight = false;
    }
  }

  function markUserActivity(event) {
    if (!state.runtime || event?.isTrusted === false) return;
    state.runtime.lastUserActivityAt = now();
    window.clearTimeout(state.activitySaveTimer);
    state.activitySaveTimer = window.setTimeout(ContentState.saveRuntime, 500);
  }


  function installStorageListener() {
    state.storageListener = (changes, areaName) => {
      if (state.destroyed || areaName !== "local") return;
      const settingsPageId = state.pageId;
      const pageKey = Config.pageSettingsKey(settingsPageId);
      const settingsChanged = Object.prototype.hasOwnProperty.call(changes, Config.STORAGE_KEYS.global)
        || Object.prototype.hasOwnProperty.call(changes, Config.STORAGE_KEYS.pages)
        || Object.prototype.hasOwnProperty.call(changes, pageKey);
      if (settingsChanged) {
        storageGet([Config.STORAGE_KEYS.global, Config.STORAGE_KEYS.pages, pageKey]).then((stored) => {
          if (state.destroyed || state.pageId !== settingsPageId || currentPageId() !== settingsPageId) return;
          const globalSettings = stored[Config.STORAGE_KEYS.global] || {};
          const legacyPageSettings = stored[Config.STORAGE_KEYS.pages]?.[settingsPageId] || {};
          const pageSettings = stored[pageKey] || legacyPageSettings;
          state.settings = Config.mergeSettings(Config.DEFAULT_SETTINGS, globalSettings, pageSettings);
          ContentState.scheduleNextRefresh(true);
          ContentState.scheduleNextQueue(true);
          restartScanTimer();
          queueCycle();
        });
      }
      const actionChange = changes[Config.lastActionKey(state.pageId)];
      if (actionChange?.newValue?.message) state.lastAction = actionChange.newValue;
    };
    chrome.storage.onChanged.addListener(state.storageListener);
  }

  function handleDomMutation() {
    state.lastDomActivityAt = now();
    queueCycle();
  }

  function addLifecycleHandler(target, eventName, handler) {
    target.addEventListener(eventName, handler);
    state.lifecycleHandlers.push({ target, eventName, handler });
  }

  function handleLifecycleWake() {
    if (state.destroyed) return;
    probeHydration();
    restartScanTimer();
    restartRouteTimer();
    queueCycle(0);
  }

  function handleLifecycleSuspend() {
    ContentState.saveRuntime();
  }

  function installObservers() {
    state.observer = new MutationObserver(handleDomMutation);
    state.observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

    for (const eventName of ["pointerdown", "keydown", "input", "focusin"]) {
      document.addEventListener(eventName, markUserActivity, true);
    }
    addLifecycleHandler(document, "visibilitychange", handleLifecycleWake);
    addLifecycleHandler(window, "pageshow", handleLifecycleWake);
    addLifecycleHandler(window, "pagehide", handleLifecycleSuspend);
    addLifecycleHandler(document, "freeze", handleLifecycleSuspend);
    addLifecycleHandler(document, "resume", handleLifecycleWake);

    restartScanTimer();
    restartRouteTimer();
  }


  async function runManualAction(action) {
    if (!await ensureCurrentRoute()) return false;
    if (action === "nudge") return sendDeepNudge("manual", false);
    if (action === "continue") return sendContinue("manual", false);
    if (action === "refresh") return refreshPage("manual", false);
    if (action === "queue-next") return handleQueue(false);
    if (action === "scan") {
      await runCycle();
      return true;
    }
    return false;
  }

  async function resetRuntime() {
    if (!await ensureCurrentRoute()) throw new Error("Conversation navigation is still in progress");
    const guardReset = await backgroundSendWithRetry({ type: "YOLO_ACTION_RESET", pageId: state.pageId, actionKey: "" });
    if (!guardReset?.ok) throw new Error(guardReset?.reason || "Could not reset the conversation action guards");
    state.runtime = ContentState.freshRuntime();
    ContentState.scheduleNextRefresh(true);
    ContentState.scheduleNextQueue(false);
    ContentState.saveRuntime();
    clearBlocked();
    await setLastAction("Reset session limits and action history", "info", "runtime.reset", true);
  }

  function registerClient(destroyClient) {
    if (typeof destroyClient !== "function" || state.destroyed) return () => {};
    state.clients.add(destroyClient);
    return () => state.clients.delete(destroyClient);
  }

  const commandApi = Object.freeze({
    getState: ContentState.responseState,
    ensureReady: ensureCurrentRoute,
    runAction: runManualAction,
    recordStatus: setLastAction,
    registerClient
  });

  function installMessages() {
    state.messageListener = (message, _sender, sendResponse) => {
      if (state.destroyed) return false;

      if (message?.type === "YOLOTAB_HEALTH_CHECK") {
        updateGenerationState();
        probeHydration();
        const workflow = workflowHealth();
        sendResponse({
          ok: true,
          pageId: state.pageId,
          hydrated: state.hydrated,
          generating: state.generationActive,
          visible: !document.hidden,
          lastDomActivityAt: state.lastDomActivityAt,
          workflow,
          settings: { protectActiveWorkflowTabs: state.settings.protectActiveWorkflowTabs }
        });
        return false;
      }

      if (message?.type === "YOLO_GET_STATE") {
        ensureCurrentRoute()
          .then((ready) => {
            if (ready) updateGenerationState();
            sendResponse(ready ? ContentState.responseState() : null);
          })
          .catch((error) => {
            console.error(`YOLO_GET_STATE failed: ${Shared.errorMessage(error)}`);
            sendResponse(null);
          });
        return true;
      }

      if (message?.type === "YOLO_SET_SETTINGS" || message?.type === "YOLO_SET_TAB_SETTINGS") {
        persistSettings(message.settings || {})
          .then((settings) => {
            sendResponse({ ok: true, settings, state: ContentState.responseState() });
            queueCycle();
          })
          .catch((error) => sendResponse({ ok: false, reason: Shared.errorMessage(error), state: ContentState.responseState() }));
        return true;
      }

      if (message?.type === "YOLO_APPLY_IMPORTED_SETTINGS") {
        ensureCurrentRoute()
          .then((ready) => {
            if (!ready) throw new Error("Conversation navigation is still in progress");
            state.settings = Config.normalizeSettings(message.settings || {});
            ContentState.scheduleNextRefresh(true);
            ContentState.scheduleNextQueue(true);
            restartScanTimer();
            queueCycle();
            sendResponse({ ok: true, settings: state.settings, state: ContentState.responseState() });
          })
          .catch((error) => sendResponse({ ok: false, reason: Shared.errorMessage(error), state: ContentState.responseState() }));
        return true;
      }

      if (message?.type === "YOLO_RUN_ACTION") {
        runManualAction(message.action)
          .then((ok) => sendResponse({ ok, state: ContentState.responseState() }))
          .catch((error) => sendResponse({ ok: false, reason: Shared.errorMessage(error), state: ContentState.responseState() }));
        return true;
      }

      if (message?.type === "YOLO_RESET_RUNTIME") {
        resetRuntime()
          .then(() => sendResponse({ ok: true, state: ContentState.responseState() }))
          .catch((error) => sendResponse({ ok: false, reason: Shared.errorMessage(error), state: ContentState.responseState() }));
        return true;
      }

      return false;
    };
    chrome.runtime.onMessage.addListener(state.messageListener);
  }

  function destroy() {
    state.destroyed = true;
    state.observer?.disconnect();
    window.clearTimeout(state.scanTimer);
    window.clearTimeout(state.scanWakeTimer);
    window.clearTimeout(state.routeTimer);
    window.clearTimeout(state.activitySaveTimer);
    if (state.messageListener) chrome.runtime.onMessage.removeListener(state.messageListener);
    if (state.storageListener) chrome.storage.onChanged.removeListener(state.storageListener);
    for (const destroyClient of state.clients) {
      try { destroyClient(); } catch { /* Client cleanup is best-effort. */ }
    }
    state.clients.clear();
    for (const eventName of ["pointerdown", "keydown", "input", "focusin"]) {
      document.removeEventListener(eventName, markUserActivity, true);
    }
    for (const { target, eventName, handler } of state.lifecycleHandlers) target.removeEventListener(eventName, handler);
    state.lifecycleHandlers = [];
  }

  window.__YOLO_EXTENSION__ = { version: Config.VERSION, destroy, commandApi };

  installMessages();
  loadSettings().then(() => {
    if (state.destroyed) return;
    installStorageListener();
    installObservers();
    runCycle();
  }).catch((error) => {
    if (!disableStaleContext(error)) setLastAction(`Startup failed: ${Shared.errorMessage(error)}`, "error", "startup.failed", true);
  });
})();
