((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YOLOPlatforms = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  const NEGATIVE_RE = /\b(deny|decline|reject|cancel|stop|no|disallow|do not|don't|dismiss)\b/i;
  const DETAILS_RE = /\b(details?|learn more|view)\b/i;
  const SAFE_APPROVAL_RE = /\b(allow|approve|accept|continue|run|grant|authorize|confirm)\b/i;
  const READ_ONLY_CONTEXT_RE = /\b(read|view|inspect|list|search|fetch|get|retrieve|show)\b/i;
  const WRITE_APPROVAL_RE = /\b(create|update|edit|commit|push|open|apply|write|modify|change)\b/i;
  const DESTRUCTIVE_APPROVAL_RE = /\b(merge|delete|remove|close|force|overwrite|reset|revert|discard|drop|destroy)\b/i;
  const SENSITIVE_APPROVAL_RE = /\b(account access|connect account|sign in|credential|secret|token|oauth|scope|permission|grant access|repository access|private repository|private repo)\b/i;
  const EXECUTION_APPROVAL_RE = /\b(run command|execute|shell|terminal|bash|script|tool call)\b/i;
  const GITHUB_CONTEXT_RE = /\b(github|repository|pull request|issue|branch|commit|workflow|workspace|permission|tool call)\b/i;
  const PROVIDER_LIMIT_RE = /\b(rate limit|usage limit|message limit|too many requests|reached (?:the |your )?(?:usage |message |model )?limit|limit resets?|try again in \d|available again in \d|come back later|temporarily unavailable due to (?:high )?demand|capacity limit|429)\b/i;
  const CONVERSATION_EXHAUSTED_RE = /(?:\b(?:conversation|chat|thread)\b.{0,100}\b(?:maximum (?:length|size)|too long|length limit|context limit|reached (?:its|the) (?:maximum )?(?:length|limit)|is full)\b|\bmaximum (?:conversation|chat|thread) length\b|\bmaximum length\b.{0,60}\b(?:for|of) (?:this|the) (?:conversation|chat|thread)\b|\bcontext window\b.{0,80}\b(?:full|limit|maximum|exceeded)\b)/i;
  const NEW_CHAT_CONTINUATION_RE = /\b(?:start|open|continue(?: this)? in)\b.{0,60}\b(?:new chat|new conversation)\b/i;
  const HUMAN_REQUIRED_RE = /\b(confirm|approval|permission|authorize|sign in|log in|connect account|grant access|requires? (?:your )?(?:input|confirmation)|needs? (?:your )?(?:input|confirmation)|choose an option|select an option)\b/i;

  const ADAPTERS = Object.freeze({
    chatgpt: Object.freeze({
      id: "chatgpt",
      label: "ChatGPT",
      supportsApprovals: true,
      composerSelectors: [
        "#prompt-textarea",
        "textarea[data-testid='prompt-textarea']",
        "div[contenteditable='true'][data-testid='prompt-textarea']",
        "form textarea",
        "form div[contenteditable='true'][role='textbox']"
      ],
      newChatSelectors: [
        "a[data-testid='create-new-chat-button']",
        "button[data-testid='create-new-chat-button']",
        "a[aria-label*='New chat' i]",
        "button[aria-label*='New chat' i]",
        "a[title*='New chat' i]",
        "button[title*='New chat' i]"
      ],
      sendSelectors: [
        "button[data-testid='send-button']",
        "button[aria-label*='Send' i]",
        "button[title*='Send' i]"
      ],
      generationSelectors: [
        "button[data-testid='stop-button']",
        "button[aria-label*='Stop generating' i]",
        "button[title*='Stop generating' i]"
      ],
      errorSelectors: [
        "[role='alert']",
        "[data-testid*='error' i]"
      ],
      assistantSelectors: [
        "[data-message-author-role='assistant']",
        "article[data-testid^='conversation-turn'] [data-message-author-role='assistant']",
        "main article [data-message-author-role='assistant']"
      ],
      userSelectors: [
        "[data-message-author-role='user']",
        "article[data-testid^='conversation-turn'] [data-message-author-role='user']",
        "main article [data-message-author-role='user']"
      ]
    })
  });

  function adapterForLocation(locationLike = globalThis.location) {
    const host = String(locationLike?.hostname || "").toLowerCase();
    if (host === "chatgpt.com" || host.endsWith(".chatgpt.com")) return ADAPTERS.chatgpt;
    return null;
  }

  function visible(element) {
    if (!element || element.nodeType !== 1 || typeof element.getBoundingClientRect !== "function") return false;
    const rect = element.getBoundingClientRect();
    const view = element.ownerDocument?.defaultView || globalThis;
    const style = view.getComputedStyle?.(element);
    if (!style) return rect.width > 0 && rect.height > 0;
    return rect.width > 0
      && rect.height > 0
      && style.visibility !== "hidden"
      && style.display !== "none"
      && Number(style.opacity || 1) !== 0;
  }

  function normalizedText(element) {
    return String(element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function buttonText(button) {
    return String(button?.getAttribute?.("aria-label") || button?.getAttribute?.("title") || normalizedText(button)).trim().toLowerCase();
  }

  function isDisabled(element) {
    return Boolean(element?.disabled || element?.getAttribute?.("aria-disabled") === "true");
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements.filter(Boolean)));
  }

  function newChatSignal(element) {
    if (!element || !visible(element) || isDisabled(element)) return false;
    const label = String(element.getAttribute?.("aria-label") || element.getAttribute?.("title") || normalizedText(element)).trim();
    const testId = String(element.getAttribute?.("data-testid") || "");
    return /\bnew (?:chat|conversation)\b/i.test(label) || /create-new-chat/i.test(testId);
  }

  function findNewChatControl(adapter, documentLike = document) {
    if (!adapter) return null;
    const explicit = uniqueElements((adapter.newChatSelectors || []).flatMap((selector) => Array.from(documentLike.querySelectorAll(selector))));
    const candidates = explicit.length ? explicit : Array.from(documentLike.querySelectorAll("a, button"));
    return candidates.filter(newChatSignal).sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.top - br.top || ar.left - br.left;
    })[0] || null;
  }

  function openNewChat(adapter, documentLike = document) {
    const control = findNewChatControl(adapter, documentLike);
    if (!control) return false;
    control.click();
    return true;
  }

  function findComposer(adapter, documentLike = document) {
    if (!adapter) return null;
    const candidates = uniqueElements(adapter.composerSelectors.flatMap((selector) => Array.from(documentLike.querySelectorAll(selector))));
    return candidates
      .filter((element) => visible(element) && !isDisabled(element))
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0] || null;
  }

  function sendSignal(button, form) {
    if (!visible(button) || isDisabled(button)) return false;
    const text = buttonText(button);
    const testId = String(button.getAttribute?.("data-testid") || "");
    const signal = /\b(send|submit)\b/i.test(text) || /send|submit/i.test(testId) || (form && button.type === "submit");
    return signal && !NEGATIVE_RE.test(text);
  }

  function distanceBetween(element, target) {
    const rect = element.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const x = (rect.left + rect.right) / 2 - (targetRect.left + targetRect.right) / 2;
    const y = (rect.top + rect.bottom) / 2 - (targetRect.top + targetRect.bottom) / 2;
    return Math.hypot(x, y);
  }

  function findSendButton(adapter, composer, documentLike = document) {
    if (!adapter || !composer) return null;
    const form = composer.closest?.("form");
    const scoped = form ? Array.from(form.querySelectorAll("button")) : [];
    const scopedMatch = scoped.find((button) => sendSignal(button, form));
    if (scopedMatch) return scopedMatch;

    const explicit = uniqueElements(adapter.sendSelectors.flatMap((selector) => Array.from(documentLike.querySelectorAll(selector))));
    return explicit
      .filter((button) => sendSignal(button, form))
      .sort((a, b) => distanceBetween(a, composer) - distanceBetween(b, composer))[0] || null;
  }

  function isGenerating(adapter, documentLike = document) {
    if (!adapter) return false;
    const explicit = adapter.generationSelectors.flatMap((selector) => Array.from(documentLike.querySelectorAll(selector)));
    if (explicit.some((element) => visible(element) && !isDisabled(element))) return true;

    return Array.from(documentLike.querySelectorAll("button")).some((button) => {
      if (!visible(button) || isDisabled(button)) return false;
      return /\b(stop generating|interrupt response|cancel generation)\b/i.test(buttonText(button));
    });
  }

  function findErrorState(adapter, documentLike = document) {
    if (!adapter) return null;
    const explicit = adapter.errorSelectors.flatMap((selector) => Array.from(documentLike.querySelectorAll(selector)));
    const error = explicit.find((element) => visible(element) && /\b(error|went wrong|try again|retry|failed|network error)\b/i.test(normalizedText(element)));
    if (error) return error;

    return Array.from(documentLike.querySelectorAll("button")).find((button) => {
      if (!visible(button)) return false;
      const context = normalizedText(button.closest?.("[role='alert']") || button.parentElement || button);
      return /\bretry\b/i.test(buttonText(button)) && /\b(error|went wrong|try again|retry|failed)\b/i.test(context);
    }) || null;
  }

  function conversationLimitState(adapter, documentLike = document) {
    if (!adapter) return null;
    const selectors = [...adapter.errorSelectors, "[role=\"dialog\"]", "[role=\"alertdialog\"]", "[role=\"status\"]"];
    const candidates = uniqueElements(selectors.flatMap((selector) => Array.from(documentLike.querySelectorAll(selector))));
    for (const element of candidates) {
      if (!visible(element)) continue;
      const text = normalizedText(element);
      const exhaustion = CONVERSATION_EXHAUSTED_RE.test(text);
      const newChatContinuation = NEW_CHAT_CONTINUATION_RE.test(text)
        && /\b(?:conversation|chat|thread|context)\b.{0,100}\b(?:limit|long|length|full|maximum)\b/i.test(text);
      if (exhaustion || newChatContinuation) {
        return { status: "rollover_required", code: "supervisor.rollover_required.context_limit", reason: text.slice(0, 500) || "ChatGPT conversation context limit reached" };
      }
    }
    return null;
  }

  function providerLimitState(adapter, documentLike = document) {
    if (!adapter) return null;
    const selectors = [...adapter.errorSelectors, "[role=\"dialog\"]", "[role=\"alertdialog\"]", "[role=\"status\"]"];
    const candidates = uniqueElements(selectors.flatMap((selector) => Array.from(documentLike.querySelectorAll(selector))));
    for (const element of candidates) {
      if (!visible(element)) continue;
      const text = normalizedText(element);
      if (PROVIDER_LIMIT_RE.test(text)) {
        return { status: "rate_limited", code: "supervisor.rate_limited.provider", reason: text.slice(0, 500) || "Provider usage or rate limit reached" };
      }
    }
    return null;
  }

  function normalizedMultilineText(element) {
    return String(element?.innerText || element?.textContent || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[^\S\n]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function authoredMessageText(element) {
    if (!element) return "";
    if (typeof element.cloneNode !== "function") return normalizedMultilineText(element);
    const clone = element.cloneNode(true);
    for (const node of Array.from(clone.querySelectorAll?.("button, [role='button'], input, textarea, select") || [])) {
      node.remove?.();
    }
    return normalizedMultilineText(clone);
  }

  function latestMessageText(selectors, documentLike = document) {
    const candidates = uniqueElements((Array.isArray(selectors) ? selectors : [])
      .flatMap((selector) => Array.from(documentLike.querySelectorAll(selector))));
    return normalizedMultilineText(candidates.at(-1));
  }

  function latestAssistantText(adapter, documentLike = document) {
    return adapter ? latestMessageText(adapter.assistantSelectors, documentLike) : "";
  }

  function latestUserText(adapter, documentLike = document) {
    if (!adapter) return "";
    const candidates = uniqueElements((adapter.userSelectors || [])
      .flatMap((selector) => Array.from(documentLike.querySelectorAll(selector))));
    return authoredMessageText(candidates.at(-1));
  }

  function conversationGrowthSnapshot(adapter, documentLike = document) {
    if (!adapter) return { userMessages: 0, assistantMessages: 0, totalMessages: 0, visibleTextChars: 0 };
    const users = uniqueElements((adapter.userSelectors || []).flatMap((selector) => Array.from(documentLike.querySelectorAll(selector))));
    const assistants = uniqueElements((adapter.assistantSelectors || []).flatMap((selector) => Array.from(documentLike.querySelectorAll(selector))));
    const messages = uniqueElements([...users, ...assistants]);
    return {
      userMessages: users.length,
      assistantMessages: assistants.length,
      totalMessages: messages.length,
      visibleTextChars: messages.reduce((sum, element) => sum + normalizedMultilineText(element).length, 0)
    };
  }

  function isTextControl(element) {
    const tag = String(element?.tagName || "").toUpperCase();
    return tag === "TEXTAREA" || tag === "INPUT";
  }

  function composerText(composer) {
    if (!composer) return "";
    if (isTextControl(composer)) return composer.value || "";
    return normalizedText(composer);
  }

  function setNativeValue(input, value) {
    const view = input.ownerDocument?.defaultView || globalThis;
    const prototype = String(input.tagName || "").toUpperCase() === "TEXTAREA"
      ? view.HTMLTextAreaElement?.prototype
      : view.HTMLInputElement?.prototype;
    const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, "value")?.set : null;
    if (setter) setter.call(input, value);
    else input.value = value;
  }

  function setComposerValue(composer, value) {
    composer.focus();
    const ownerDocument = composer.ownerDocument || document;
    const view = ownerDocument.defaultView || globalThis;

    if (isTextControl(composer)) {
      setNativeValue(composer, value);
      composer.dispatchEvent(new view.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      composer.dispatchEvent(new view.Event("change", { bubbles: true }));
      return;
    }

    const selection = view.getSelection?.();
    const range = ownerDocument.createRange();
    range.selectNodeContents(composer);
    selection?.removeAllRanges();
    selection?.addRange(range);

    if (ownerDocument.execCommand) ownerDocument.execCommand("insertText", false, value);
    else composer.textContent = value;
    composer.dispatchEvent(new view.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  }

  function submitComposer(adapter, composer, documentLike = document) {
    const sendButton = findSendButton(adapter, composer, documentLike);
    if (sendButton) {
      sendButton.click();
      return true;
    }

    const form = composer.closest?.("form");
    if (typeof form?.requestSubmit === "function") {
      form.requestSubmit();
      return true;
    }

    return false;
  }

  function approvalRisk(text, contextText = "") {
    const button = String(text || "");
    const context = String(contextText || "");
    if (NEGATIVE_RE.test(button) || DETAILS_RE.test(button)) return "blocked";
    const riskText = `${button} ${context}`;
    if (DESTRUCTIVE_APPROVAL_RE.test(riskText)) return "destructive";
    if (SENSITIVE_APPROVAL_RE.test(riskText) || EXECUTION_APPROVAL_RE.test(riskText)) return "sensitive";
    if (WRITE_APPROVAL_RE.test(riskText)) return "write";
    if (SAFE_APPROVAL_RE.test(button) && READ_ONLY_CONTEXT_RE.test(context)) return "safe";
    return "unknown";
  }

  function comparableText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function userMessageSnapshot(adapter, documentLike = document, expectedText = "") {
    const expected = comparableText(expectedText);
    if (!adapter) return { count: 0, latestText: "", expectedText: expected, expectedCount: 0 };
    const candidates = uniqueElements(adapter.userSelectors
      .flatMap((selector) => Array.from(documentLike.querySelectorAll(selector))));
    const texts = candidates.map((element) => comparableText(authoredMessageText(element)));
    return {
      count: candidates.length,
      latestText: texts.at(-1) || "",
      expectedText: expected,
      expectedCount: expected ? texts.filter((text) => text === expected).length : 0
    };
  }

  function submissionObserved(adapter, options = {}, documentLike = document) {
    if (!adapter) return false;
    const expectedText = comparableText(options.expectedText);
    if (!expectedText) return false;
    const previous = options.previousSnapshot && typeof options.previousSnapshot === "object"
      ? options.previousSnapshot
      : { count: 0, latestText: comparableText(options.previousUserText) };
    const current = userMessageSnapshot(adapter, documentLike, expectedText);
    const expectedCountKnown = comparableText(previous.expectedText) === expectedText
      && Number.isFinite(Number(previous.expectedCount));
    if (expectedCountKnown && current.expectedCount > Math.max(0, Number(previous.expectedCount) || 0)) return true;
    const advanced = current.count > Math.max(0, Number(previous.count) || 0)
      || current.latestText !== comparableText(previous.latestText);
    return advanced && current.latestText === expectedText;
  }

  function approvalVerbAllowed(text, policy, contextText = "") {
    const risk = approvalRisk(text, contextText);
    if (risk === "safe") return true;
    if (risk === "write") return policy === "writes" || policy === "all";
    if (risk === "sensitive" || risk === "destructive") return policy === "all";
    return false;
  }

  function approvalSignature(card, button) {
    const text = normalizedText(card)
      .replace(/\b(details?|learn more|view)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 320);
    return `${buttonText(button)}::${text}`;
  }

  function findApprovalCards(adapter, policy = "safe", documentLike = document) {
    if (!adapter?.supportsApprovals) return [];
    const visibleButtons = Array.from(documentLike.querySelectorAll("button")).filter(visible);
    const cards = new Set();

    for (const button of visibleButtons) {
      let node = button.parentElement;
      for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.width > 1000 || rect.height > 720) continue;
        const text = normalizedText(node);
        if (!GITHUB_CONTEXT_RE.test(text)) continue;

        const localButtons = Array.from(node.querySelectorAll("button")).filter((candidate) => visible(candidate) && !isDisabled(candidate));
        const hasNegative = localButtons.some((candidate) => NEGATIVE_RE.test(buttonText(candidate)));
        const hasAllowed = localButtons.some((candidate) => approvalVerbAllowed(buttonText(candidate), policy, text));
        if (hasNegative && hasAllowed) {
          cards.add(node);
          break;
        }
      }
    }

    return Array.from(cards).map((card) => {
      const cardText = normalizedText(card);
      const buttons = Array.from(card.querySelectorAll("button")).filter((button) => visible(button) && !isDisabled(button));
      const candidates = [];

      for (const negative of buttons.filter((button) => NEGATIVE_RE.test(buttonText(button)))) {
        const negativeRect = negative.getBoundingClientRect();
        const rowCandidates = buttons
          .filter((button) => {
            if (button === negative || !approvalVerbAllowed(buttonText(button), policy, cardText)) return false;
            const rect = button.getBoundingClientRect();
            const sameRow = Math.abs(rect.top - negativeRect.top) <= 20 || Math.abs(rect.bottom - negativeRect.bottom) <= 20;
            return sameRow && rect.left > negativeRect.right;
          })
          .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
        if (rowCandidates[0]) candidates.push(rowCandidates[0]);
      }

      const approvalButton = candidates.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0] || null;
      return approvalButton ? {
        card,
        button: approvalButton,
        signature: approvalSignature(card, approvalButton),
        risk: approvalRisk(buttonText(approvalButton), cardText)
      } : null;
    }).filter(Boolean);
  }

  function humanRequiredState(adapter, settings = {}, documentLike = document) {
    if (!adapter) return null;
    const allApprovals = findApprovalCards(adapter, "all", documentLike);
    if (allApprovals.length) {
      const enabled = Boolean(settings.approvalsEnabled);
      const policy = String(settings.approvalPolicy || "safe");
      const allowed = enabled ? new Set(findApprovalCards(adapter, policy, documentLike).map((entry) => entry.signature)) : new Set();
      const blocked = allApprovals.find((entry) => !allowed.has(entry.signature));
      if (blocked) {
        return {
          status: "human_required",
          code: "supervisor.human_required.approval",
          reason: `${blocked.risk || "unknown"} approval requires user action`
        };
      }
    }

    const dialogs = uniqueElements(["[role=\"dialog\"]", "[role=\"alertdialog\"]"]
      .flatMap((selector) => Array.from(documentLike.querySelectorAll(selector))));
    for (const dialog of dialogs) {
      if (!visible(dialog)) continue;
      const text = normalizedText(dialog);
      if (!HUMAN_REQUIRED_RE.test(text)) continue;
      const buttons = Array.from(dialog.querySelectorAll?.("button") || []).filter((button) => visible(button) && !isDisabled(button));
      const hasNegative = buttons.some((button) => NEGATIVE_RE.test(buttonText(button)));
      const hasAffirmative = buttons.some((button) => SAFE_APPROVAL_RE.test(buttonText(button)) || /\b(sign in|log in|connect|verify|choose|select)\b/i.test(buttonText(button)));
      if (hasNegative && hasAffirmative) {
        return { status: "human_required", code: "supervisor.human_required.dialog", reason: text.slice(0, 500) || "ChatGPT requires user interaction" };
      }
    }
    return null;
  }

  function workflowStopState(adapter, settings = {}, documentLike = document) {
    return conversationLimitState(adapter, documentLike) || providerLimitState(adapter, documentLike) || humanRequiredState(adapter, settings, documentLike);
  }

  return Object.freeze({
    ADAPTERS,
    adapterForLocation,
    visible,
    normalizedText,
    buttonText,
    isDisabled,
    findComposer,
    findNewChatControl,
    openNewChat,
    findSendButton,
    isGenerating,
    findErrorState,
    conversationLimitState,
    providerLimitState,
    humanRequiredState,
    workflowStopState,
    latestAssistantText,
    latestUserText,
    conversationGrowthSnapshot,
    userMessageSnapshot,
    composerText,
    setComposerValue,
    submitComposer,
    submissionObserved,
    approvalRisk,
    approvalVerbAllowed,
    findApprovalCards,
    approvalSignature
  });
});
