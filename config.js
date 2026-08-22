((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YOLOConfig = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  const VERSION = "1.1.0";
  const HOUR_MS = 60 * 60 * 1000;
  const STORAGE_KEYS = Object.freeze({
    global: "yoloGlobal",
    pages: "yoloPageSettings",
    counters: "yoloCounters",
    lastAction: "yoloLastAction",
    runtime: "yoloRuntimeV1",
    queues: "yoloQueuesV1",
    projects: "yoloProjectsV1",
    templates: "yoloTemplatesV1",
    actionGuards: "yoloActionGuardsV1",
    portableRevision: "yoloPortableRevisionV1"
  });

  const DEEP_NUDGE_PROMPT = [
    "Review where you stopped and keep going deeper.",
    "Do not repeat the last answer.",
    "Critically inspect your assumptions, look for gaps or edge cases, and continue the work toward my original goal with concrete next steps."
  ].join(" ");

  const DEFAULT_TEMPLATES = Object.freeze([
    Object.freeze({
      id: "continue-deeper",
      name: "Continue deeper",
      text: DEEP_NUDGE_PROMPT,
      builtIn: true
    }),
    Object.freeze({
      id: "review-fix",
      name: "Review and fix",
      text: "Review the work completed so far from first principles. Find concrete defects, weak assumptions, missing edge cases, and unfinished parts. Fix what you can, validate the result, and continue toward the original goal without repeating prior commentary.",
      builtIn: true
    }),
    Object.freeze({
      id: "finish-task",
      name: "Finish the task",
      text: "Continue from the current state and finish the original task completely. Do not stop at a plan or partial result. Validate the final result and clearly surface any blocker that genuinely cannot be resolved.",
      builtIn: true
    }),
    Object.freeze({
      id: "progress-summary",
      name: "Progress summary",
      text: "Summarize the current state of the work: what is complete, what remains, the most important risks, and the exact next actions. Keep it concise and grounded in the actual work completed.",
      builtIn: true
    })
  ]);

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    profile: "balanced",

    queueAutoRunEnabled: true,
    queueIntervalMinSec: 20,
    queueIntervalMaxSec: 45,
    queueIdleSec: 5,
    queueLimitPerHour: 30,
    queueMaxRetries: 2,
    queueRetryBackoffSec: 30,
    queuePauseOnFailure: true,

    approvalsEnabled: false,
    approvalPolicy: "safe",
    approvalDelayMinSec: 2,
    approvalDelayMaxSec: 6,
    approvalCooldownSec: 12,
    approvalLimitPerHour: 12,

    errorRecoveryEnabled: true,
    errorRecoveryStrategy: "continue-first",
    errorDelayMinSec: 3,
    errorDelayMaxSec: 8,
    errorCooldownSec: 90,
    errorLimitPerHour: 6,

    deepNudgesEnabled: false,
    deepNudgeIdleSec: 120,
    deepNudgeCooldownSec: 300,
    deepNudgeLimitPerHour: 6,
    deepNudgePrompt: DEEP_NUDGE_PROMPT,

    autoRefreshEnabled: false,
    refreshIdleMin: 5,
    refreshIntervalMinMin: 10,
    refreshIntervalMaxMin: 20,
    refreshCooldownMin: 5,
    refreshLimitPerHour: 2,

    loadGraceSec: 10,
    scanIntervalSec: 3,
    protectActiveWorkflowTabs: true,
    maxActionsPerSession: 100,
    pauseOnComposerText: true
  });

  const PRESETS = Object.freeze({
    safe: Object.freeze({
      profile: "safe",
      queueAutoRunEnabled: true,
      queueIntervalMinSec: 45,
      queueIntervalMaxSec: 90,
      queueIdleSec: 10,
      queueLimitPerHour: 12,
      queueMaxRetries: 1,
      queuePauseOnFailure: true,
      approvalsEnabled: false,
      approvalPolicy: "safe",
      errorRecoveryEnabled: true,
      errorRecoveryStrategy: "continue-first",
      deepNudgesEnabled: false,
      autoRefreshEnabled: false,
      maxActionsPerSession: 50
    }),
    balanced: Object.freeze({
      profile: "balanced",
      queueAutoRunEnabled: true,
      queueIntervalMinSec: 20,
      queueIntervalMaxSec: 45,
      queueIdleSec: 5,
      queueLimitPerHour: 30,
      queueMaxRetries: 2,
      queuePauseOnFailure: true,
      approvalsEnabled: false,
      approvalPolicy: "safe",
      errorRecoveryEnabled: true,
      errorRecoveryStrategy: "continue-first",
      deepNudgesEnabled: false,
      autoRefreshEnabled: false,
      maxActionsPerSession: 100
    }),
    fast: Object.freeze({
      profile: "fast",
      queueAutoRunEnabled: true,
      queueIntervalMinSec: 8,
      queueIntervalMaxSec: 15,
      queueIdleSec: 3,
      queueLimitPerHour: 60,
      queueMaxRetries: 2,
      queuePauseOnFailure: true,
      approvalsEnabled: false,
      approvalPolicy: "safe",
      errorRecoveryEnabled: true,
      errorRecoveryStrategy: "continue-first",
      deepNudgesEnabled: true,
      deepNudgeIdleSec: 120,
      deepNudgeCooldownSec: 300,
      autoRefreshEnabled: false,
      maxActionsPerSession: 200
    })
  });

  const SCHEMA = Object.freeze({
    enabled: { type: "boolean" },
    profile: { type: "enum", values: ["safe", "balanced", "fast", "custom"] },

    queueAutoRunEnabled: { type: "boolean" },
    queueIntervalMinSec: { type: "number", min: 0, max: 86400, integer: false },
    queueIntervalMaxSec: { type: "number", min: 0, max: 86400, integer: false },
    queueIdleSec: { type: "number", min: 0, max: 3600, integer: false },
    queueLimitPerHour: { type: "number", min: 0, max: 1000, integer: true },
    queueMaxRetries: { type: "number", min: 0, max: 20, integer: true },
    queueRetryBackoffSec: { type: "number", min: 1, max: 86400, integer: false },
    queuePauseOnFailure: { type: "boolean" },

    approvalsEnabled: { type: "boolean" },
    approvalPolicy: { type: "enum", values: ["safe", "writes", "all"] },
    approvalDelayMinSec: { type: "number", min: 0, max: 120, integer: false },
    approvalDelayMaxSec: { type: "number", min: 0, max: 120, integer: false },
    approvalCooldownSec: { type: "number", min: 0, max: 3600, integer: false },
    approvalLimitPerHour: { type: "number", min: 0, max: 1000, integer: true },

    errorRecoveryEnabled: { type: "boolean" },
    errorRecoveryStrategy: { type: "enum", values: ["continue-first", "refresh-first", "continue-only", "refresh-only"] },
    errorDelayMinSec: { type: "number", min: 0, max: 300, integer: false },
    errorDelayMaxSec: { type: "number", min: 0, max: 300, integer: false },
    errorCooldownSec: { type: "number", min: 0, max: 7200, integer: false },
    errorLimitPerHour: { type: "number", min: 0, max: 1000, integer: true },

    deepNudgesEnabled: { type: "boolean" },
    deepNudgeIdleSec: { type: "number", min: 5, max: 86400, integer: false },
    deepNudgeCooldownSec: { type: "number", min: 5, max: 86400, integer: false },
    deepNudgeLimitPerHour: { type: "number", min: 0, max: 1000, integer: true },
    deepNudgePrompt: { type: "string", maxLength: 4000 },

    autoRefreshEnabled: { type: "boolean" },
    refreshIdleMin: { type: "number", min: 0, max: 1440, integer: false },
    refreshIntervalMinMin: { type: "number", min: 0.25, max: 1440, integer: false },
    refreshIntervalMaxMin: { type: "number", min: 0.25, max: 1440, integer: false },
    refreshCooldownMin: { type: "number", min: 0, max: 1440, integer: false },
    refreshLimitPerHour: { type: "number", min: 0, max: 1000, integer: true },

    loadGraceSec: { type: "number", min: 0, max: 600, integer: false },
    scanIntervalSec: { type: "number", min: 1, max: 60, integer: false },
    protectActiveWorkflowTabs: { type: "boolean" },
    maxActionsPerSession: { type: "number", min: 0, max: 10000, integer: true },
    pauseOnComposerText: { type: "boolean" }
  });

  const coerceBoolean = (value, fallback) => {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === 1 || value === "1") return true;
    if (value === "false" || value === 0 || value === "0") return false;
    return fallback;
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function normalizeField(key, value) {
    const rule = SCHEMA[key];
    const fallback = DEFAULT_SETTINGS[key];
    if (!rule) return fallback;

    if (rule.type === "boolean") return coerceBoolean(value, fallback);
    if (rule.type === "enum") return rule.values.includes(value) ? value : fallback;
    if (rule.type === "string") {
      const text = typeof value === "string" ? value.trim() : String(value ?? "").trim();
      if (!text) return fallback;
      return text.slice(0, rule.maxLength);
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    const bounded = clamp(parsed, rule.min, rule.max);
    return rule.integer ? Math.round(bounded) : Math.round(bounded * 100) / 100;
  }

  function migrateLegacySettings(input = {}) {
    const migrated = { ...input };
    const aliases = {
      approvals: "approvalsEnabled",
      errorContinue: "errorRecoveryEnabled",
      deepNudges: "deepNudgesEnabled",
      autoRefresh: "autoRefreshEnabled"
    };
    for (const [legacyKey, currentKey] of Object.entries(aliases)) {
      if (Object.prototype.hasOwnProperty.call(input, legacyKey) && !Object.prototype.hasOwnProperty.call(input, currentKey)) {
        migrated[currentKey] = input[legacyKey];
      }
    }
    return migrated;
  }

  function normalizeSettings(input = {}) {
    const migrated = migrateLegacySettings(input);
    const normalized = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      normalized[key] = normalizeField(key, migrated[key] ?? DEFAULT_SETTINGS[key]);
    }

    normalized.queueIntervalMaxSec = Math.max(normalized.queueIntervalMinSec, normalized.queueIntervalMaxSec);
    normalized.approvalDelayMaxSec = Math.max(normalized.approvalDelayMinSec, normalized.approvalDelayMaxSec);
    normalized.errorDelayMaxSec = Math.max(normalized.errorDelayMinSec, normalized.errorDelayMaxSec);
    normalized.refreshIntervalMaxMin = Math.max(normalized.refreshIntervalMinMin, normalized.refreshIntervalMaxMin);
    normalized.pauseOnComposerText = true;
    return normalized;
  }

  function mergeSettings(...sources) {
    return normalizeSettings(Object.assign({}, ...sources.filter(Boolean).map(migrateLegacySettings)));
  }

  function globalDefaultsFromSettings(settings) {
    const normalized = normalizeSettings(settings);
    const { enabled: _enabled, ...globalDefaults } = normalized;
    return globalDefaults;
  }

  function applyPreset(settings, presetName) {
    const preset = PRESETS[presetName];
    if (!preset) return normalizeSettings({ ...settings, profile: "custom" });
    return normalizeSettings({ ...settings, ...preset });
  }

  function pageSettingsKey(id) {
    return `yoloPage:${encodeURIComponent(String(id || ""))}`;
  }

  function lastActionKey(id) {
    return `yoloLastAction:${encodeURIComponent(String(id || ""))}`;
  }

  function workflowKey(id) {
    return `yoloWorkflow:${encodeURIComponent(String(id || ""))}`;
  }

  function pageId(url) {
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      parsed.search = "";
      const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
      return `${parsed.origin}${pathname}`;
    } catch {
      return String(url || "").split("#")[0].split("?")[0];
    }
  }

  function isSupportedUrl(url) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      const defaultPort = parsed.port === "" || parsed.port === "443";
      const allowedHost = host === "chatgpt.com" || host.endsWith(".chatgpt.com");
      const noUserInfo = parsed.username === "" && parsed.password === "";
      return parsed.protocol === "https:" && defaultPort && noUserInfo && allowedHost;
    } catch {
      return false;
    }
  }

  function isDurablePageId(value) {
    try {
      const canonical = pageId(value);
      if (canonical !== String(value || "") || !isSupportedUrl(canonical)) return false;
      const pathname = new URL(canonical).pathname.replace(/\/+$/, "");
      return /(?:^|\/)c\/[^/]+$/i.test(pathname);
    } catch {
      return false;
    }
  }

  function randomBetween(min, max, random = Math.random) {
    const low = Math.min(min, max);
    const high = Math.max(min, max);
    return low + random() * (high - low);
  }

  function pruneHistory(history, at = Date.now()) {
    const cutoff = at - HOUR_MS;
    return (Array.isArray(history) ? history : []).filter((timestamp) => Number.isFinite(timestamp) && timestamp > cutoff && timestamp <= at);
  }

  function limitStatus(history, perHourLimit, sessionActionCount, sessionLimit, at = Date.now()) {
    const recent = pruneHistory(history, at);
    if (sessionLimit > 0 && sessionActionCount >= sessionLimit) {
      return { allowed: false, reason: "Session action limit reached", code: "limit.session", recent, nextAllowedAt: null };
    }
    if (perHourLimit > 0 && recent.length >= perHourLimit) {
      return {
        allowed: false,
        reason: "Hourly action limit reached",
        code: "limit.hourly",
        recent,
        nextAllowedAt: recent[0] + HOUR_MS
      };
    }
    return { allowed: true, reason: "", code: "", recent, nextAllowedAt: null };
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "now";
    const seconds = Math.ceil(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.ceil(minutes / 60);
    return `${hours}h`;
  }

  function renderTemplate(text, context = {}) {
    const date = context.date || new Date();
    const values = {
      date: date.toLocaleDateString(),
      time: date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      platform: context.platform || "chat",
      conversation: context.conversation || "current conversation"
    };
    return String(text || "").replace(/\{\{\s*(date|time|platform|conversation)\s*\}\}/gi, (_match, key) => values[key.toLowerCase()]);
  }

  return Object.freeze({
    VERSION,
    HOUR_MS,
    STORAGE_KEYS,
    DEFAULT_SETTINGS,
    DEFAULT_TEMPLATES,
    PRESETS,
    SCHEMA,
    DEEP_NUDGE_PROMPT,
    migrateLegacySettings,
    normalizeSettings,
    mergeSettings,
    globalDefaultsFromSettings,
    applyPreset,
    pageSettingsKey,
    lastActionKey,
    workflowKey,
    pageId,
    isSupportedUrl,
    isDurablePageId,
    randomBetween,
    pruneHistory,
    limitStatus,
    formatDuration,
    renderTemplate
  });
});
