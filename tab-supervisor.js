(() => {
  "use strict";

  const Config = globalThis.YOLOConfig;
  const Shared = globalThis.YOLOShared;
  const Lifecycle = globalThis.YOLOLifecycle;
  if (!Config || !Shared || !Lifecycle || !chrome.alarms || !chrome.tabs || !chrome.scripting) return;

  const ALARM_NAME = "yolo-tab-supervisor";
  const INJECTION_COOLDOWN_MS = 5 * 60 * 1_000;
  const MAX_INJECTIONS_PER_SWEEP = 2;
  const SCRIPT_FILES = Object.freeze([
    "config.js",
    "lifecycle.js",
    "platforms.js",
    "shared.js",
    "commands.js",
    "command-ui.js",
    "content-state.js",
    "content.js",
    "command-runtime.js"
  ]);
  const lastInjectionAt = new Map();

  const tabsQuery = (queryInfo) => new Promise((resolve) => {
    chrome.tabs.query(queryInfo, (tabs) => resolve(chrome.runtime.lastError ? [] : tabs || []));
  });

  const tabsGet = (tabId) => new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => resolve(chrome.runtime.lastError ? null : tab || null));
  });

  const storageGet = (keys) => Shared.storageGet(keys, { soft: true });

  const tabsUpdate = (tabId, updateProperties) => new Promise((resolve) => {
    chrome.tabs.update(tabId, updateProperties, (tab) => resolve(chrome.runtime.lastError ? null : tab || null));
  });

  const sendHealth = (tabId) => new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "YOLOTAB_HEALTH_CHECK" }, (response) => {
      resolve(chrome.runtime.lastError ? null : response || null);
    });
  });

  const injectScripts = (tabId) => new Promise((resolve) => {
    chrome.scripting.executeScript({ target: { tabId }, files: SCRIPT_FILES }, () => {
      resolve(!chrome.runtime.lastError);
    });
  });

  function ensureAlarm() {
    chrome.alarms.get(ALARM_NAME, (alarm) => {
      if (!alarm) chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
    });
  }

  function canInspect(tab) {
    return Boolean(tab?.id
      && Config.isSupportedUrl(tab.url || tab.pendingUrl || "")
      && !tab.discarded
      && !tab.frozen
      && tab.status !== "loading");
  }

  async function readProtection(tab) {
    const pageId = Config.pageId(tab.url || tab.pendingUrl || "");
    if (!Config.isDurablePageId(pageId)) return false;
    const pageKey = Config.pageSettingsKey(pageId);
    const workflowKey = Config.workflowKey(pageId);
    const stored = await storageGet([Config.STORAGE_KEYS.global, Config.STORAGE_KEYS.pages, pageKey, workflowKey]);
    const settings = Config.mergeSettings(
      Config.DEFAULT_SETTINGS,
      stored[Config.STORAGE_KEYS.global] || {},
      stored[pageKey] || stored[Config.STORAGE_KEYS.pages]?.[pageId] || {}
    );
    return Lifecycle.shouldProtectTab({
      enabled: settings.protectActiveWorkflowTabs,
      workflowStatus: stored[workflowKey]?.status
    });
  }

  async function inspect(tab, { allowInjection = true } = {}) {
    if (!canInspect(tab)) return { inspected: false, injected: false };
    const protect = await readProtection(tab);
    const desiredAutoDiscardable = !protect;
    if (tab.autoDiscardable !== desiredAutoDiscardable) {
      await tabsUpdate(tab.id, { autoDiscardable: desiredAutoDiscardable });
    }

    let health = await sendHealth(tab.id);
    let injected = false;

    if (!health?.ok && allowInjection) {
      const previous = lastInjectionAt.get(tab.id) || 0;
      if (Date.now() - previous >= INJECTION_COOLDOWN_MS) {
        lastInjectionAt.set(tab.id, Date.now());
        injected = await injectScripts(tab.id);
        if (injected) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          health = await sendHealth(tab.id);
        }
      }
    }

    return { inspected: true, injected, healthy: Boolean(health?.ok) };
  }

  async function sweep() {
    const tabs = await tabsQuery({ url: ["https://chatgpt.com/*", "https://*.chatgpt.com/*"] });
    tabs.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
    let injections = 0;
    for (const tab of tabs) {
      const result = await inspect(tab, { allowInjection: injections < MAX_INJECTIONS_PER_SWEEP });
      if (result.injected) injections += 1;
    }
    const liveIds = new Set(tabs.map((tab) => tab.id));
    for (const tabId of lastInjectionAt.keys()) if (!liveIds.has(tabId)) lastInjectionAt.delete(tabId);
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === ALARM_NAME) sweep().catch((error) => console.error(`Tab supervisor sweep failed: ${Shared.errorMessage(error)}`));
  });
  chrome.runtime.onStartup?.addListener(() => {
    ensureAlarm();
    sweep().catch((error) => console.error(`Tab supervisor startup sweep failed: ${Shared.errorMessage(error)}`));
  });
  chrome.runtime.onInstalled?.addListener(() => {
    ensureAlarm();
    sweep().catch((error) => console.error(`Tab supervisor install sweep failed: ${Shared.errorMessage(error)}`));
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== "complete") return;
    tabsGet(tabId).then((tab) => tab && inspect(tab)).catch((error) => console.error(`Tab supervisor updated-tab inspection failed: ${Shared.errorMessage(error)}`));
  });
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    tabsGet(tabId).then((tab) => tab && inspect(tab)).catch((error) => console.error(`Tab supervisor activated-tab inspection failed: ${Shared.errorMessage(error)}`));
  });
  chrome.tabs.onRemoved.addListener((tabId) => lastInjectionAt.delete(tabId));

  ensureAlarm();
})();
