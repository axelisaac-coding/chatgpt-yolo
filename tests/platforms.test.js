const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Platforms = require("../platforms.js");

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "approval-cards.json"), "utf8"));

function createFixtureDocument(fixture) {
  const view = { getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }) };
  const ownerDocument = { defaultView: view };
  const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const attrs = (values = {}) => ({ getAttribute(name) { return values[name] || null; } });
  const card = {
    nodeType: 1,
    ownerDocument,
    textContent: fixture.text,
    parentElement: null,
    getBoundingClientRect: () => rect(0, 0, 500, 160),
    querySelectorAll(selector) { return selector === "button" ? [negative, positive] : []; }
  };
  const negative = {
    nodeType: 1,
    ownerDocument,
    parentElement: card,
    textContent: fixture.negative,
    disabled: false,
    isConnected: true,
    getBoundingClientRect: () => rect(20, 110, 90, 32),
    ...attrs()
  };
  const positive = {
    nodeType: 1,
    ownerDocument,
    parentElement: card,
    textContent: fixture.positive,
    disabled: false,
    isConnected: true,
    getBoundingClientRect: () => rect(130, 110, 100, 32),
    ...attrs()
  };
  return {
    querySelectorAll(selector) { return selector === "button" ? [negative, positive] : []; }
  };
}

function submitFixture({ withButton = false, withFormSubmit = false } = {}) {
  const view = { getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }) };
  const ownerDocument = { defaultView: view };
  let clicks = 0;
  let formSubmits = 0;
  const button = {
    nodeType: 1,
    ownerDocument,
    type: "button",
    disabled: false,
    textContent: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      if (name === "data-testid") return "send-button";
      return null;
    },
    getBoundingClientRect: () => ({ left: 20, right: 60, top: 20, bottom: 60, width: 40, height: 40 }),
    click() { clicks += 1; }
  };
  const form = {
    querySelectorAll(selector) { return selector === "button" && withButton ? [button] : []; },
    ...(withFormSubmit ? { requestSubmit() { formSubmits += 1; } } : {})
  };
  const composer = {
    nodeType: 1,
    ownerDocument,
    closest(selector) { return selector === "form" ? form : null; },
    getBoundingClientRect: () => ({ left: 0, right: 300, top: 0, bottom: 100, width: 300, height: 100 })
  };
  const documentLike = { querySelectorAll() { return []; } };
  return { composer, documentLike, clicks: () => clicks, formSubmits: () => formSubmits };
}

test("selects platform adapters only for supported hosts", () => {
  assert.equal(Platforms.adapterForLocation({ hostname: "chatgpt.com" }).id, "chatgpt");
  assert.equal(Platforms.adapterForLocation({ hostname: "www.grok.com" }), null);
  assert.equal(Platforms.adapterForLocation({ hostname: "example.com" }), null);
});

test("fixture-based approval detection respects every risk policy", () => {
  for (const fixture of fixtures) {
    const documentLike = createFixtureDocument(fixture);
    for (const policy of ["safe", "writes", "all"]) {
      const found = Platforms.findApprovalCards(Platforms.ADAPTERS.chatgpt, policy, documentLike);
      assert.equal(found.length, fixture.expected[policy], `${fixture.name} under ${policy}`);
    }
  }
});

test("generic safe labels cannot hide destructive or sensitive context", () => {
  assert.equal(Platforms.approvalVerbAllowed("Confirm", "safe", "Delete the GitHub branch"), false);
  assert.equal(Platforms.approvalVerbAllowed("Confirm", "writes", "Merge pull request"), false);
  assert.equal(Platforms.approvalVerbAllowed("Confirm", "all", "Delete the GitHub branch"), true);
  assert.equal(Platforms.approvalVerbAllowed("Allow", "safe", "GitHub requests permission to read a private repository"), false);
  assert.equal(Platforms.approvalVerbAllowed("Allow", "writes", "Run command in the workspace terminal"), false);
  assert.equal(Platforms.approvalVerbAllowed("Allow", "all", "Run command in the workspace terminal"), true);
});

test("submission observation requires a new matching user message", () => {
  const messages = [{ textContent: "same prompt" }];
  const adapter = { userSelectors: ["user"] };
  const documentLike = { querySelectorAll(selector) { return selector === "user" ? messages : []; } };
  const previousSnapshot = Platforms.userMessageSnapshot(adapter, documentLike);

  assert.equal(Platforms.submissionObserved(adapter, { expectedText: "same prompt", previousSnapshot }, documentLike), false);
  messages.push({ textContent: "same prompt" });
  assert.equal(Platforms.submissionObserved(adapter, { expectedText: "same prompt", previousSnapshot }, documentLike), true);
  messages.push({ textContent: "different prompt" });
  assert.equal(Platforms.submissionObserved(adapter, { expectedText: "same prompt", previousSnapshot }, documentLike), false);
});

test("composer clearing or generation alone is not a delivery receipt", () => {
  const adapter = { userSelectors: ["user"] };
  const documentLike = { querySelectorAll() { return []; } };
  assert.equal(Platforms.submissionObserved(adapter, { expectedText: "queued prompt", previousSnapshot: { count: 0, latestText: "" } }, documentLike), false);
});

test("submits only through a real send button or form", () => {
  const adapter = Platforms.ADAPTERS.chatgpt;
  const buttonCase = submitFixture({ withButton: true, withFormSubmit: true });
  assert.equal(Platforms.submitComposer(adapter, buttonCase.composer, buttonCase.documentLike), true);
  assert.equal(buttonCase.clicks(), 1);
  assert.equal(buttonCase.formSubmits(), 0);

  const formCase = submitFixture({ withFormSubmit: true });
  assert.equal(Platforms.submitComposer(adapter, formCase.composer, formCase.documentLike), true);
  assert.equal(formCase.clicks(), 0);
  assert.equal(formCase.formSubmits(), 1);

  const unavailable = submitFixture();
  assert.equal(Platforms.submitComposer(adapter, unavailable.composer, unavailable.documentLike), false);
  assert.equal(unavailable.clicks(), 0);
  assert.equal(unavailable.formSubmits(), 0);
});

test("reads the latest ChatGPT assistant response for workflow markers", () => {
  const first = { textContent: "first response" };
  const second = { textContent: "latest response\n[YOLO:CONTINUE]" };
  const documentLike = {
    querySelectorAll(selector) {
      return selector === "assistant" ? [first, second] : [];
    }
  };
  const adapter = { assistantSelectors: ["assistant"] };
  assert.equal(Platforms.latestAssistantText(adapter, documentLike), "latest response\n[YOLO:CONTINUE]");
});

test("reads the latest ChatGPT user prompt for workflow ownership", () => {
  const first = { textContent: "manual prompt" };
  const second = { textContent: "workflow prompt" };
  const documentLike = {
    querySelectorAll(selector) {
      return selector === "user" ? [first, second] : [];
    }
  };
  assert.equal(Platforms.latestUserText({ userSelectors: ["user"] }, documentLike), "workflow prompt");
});

test("provider limit surfaces are classified without treating ordinary errors as rate limits", () => {
  const view = { getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }) };
  const ownerDocument = { defaultView: view };
  const surface = (text) => ({ nodeType: 1, ownerDocument, textContent: text, getBoundingClientRect: () => ({ width: 300, height: 80 }) });
  const adapter = { errorSelectors: ["error"], supportsApprovals: false };
  let element = surface("You've reached the usage limit. Try again in 25 minutes.");
  let doc = { querySelectorAll(selector) { return selector === "error" ? [element] : []; } };
  const limited = Platforms.providerLimitState(adapter, doc);
  assert.equal(limited.status, "rate_limited");
  assert.equal(limited.code, "supervisor.rate_limited.provider");

  element = surface("Something went wrong. Retry.");
  assert.equal(Platforms.providerLimitState(adapter, doc), null);
});

test("approval surfaces outside configured automation policy require the human", () => {
  const destructive = fixtures.find((entry) => entry.name === "destructive delete");
  const doc = createFixtureDocument(destructive);
  assert.equal(Platforms.humanRequiredState(Platforms.ADAPTERS.chatgpt, { approvalsEnabled: false, approvalPolicy: "safe" }, doc).status, "human_required");
  assert.equal(Platforms.humanRequiredState(Platforms.ADAPTERS.chatgpt, { approvalsEnabled: true, approvalPolicy: "safe" }, doc).status, "human_required");
  assert.equal(Platforms.humanRequiredState(Platforms.ADAPTERS.chatgpt, { approvalsEnabled: true, approvalPolicy: "all" }, doc), null);
});


test("conversation context exhaustion is classified separately from provider limits", () => {
  const view = { getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }) };
  const ownerDocument = { defaultView: view };
  const surface = (text) => ({ nodeType: 1, ownerDocument, textContent: text, getBoundingClientRect: () => ({ width: 420, height: 90 }) });
  const adapter = { errorSelectors: ["error"], supportsApprovals: false };
  let element = surface("You've reached the maximum length for this conversation. Start a new chat to keep going.");
  let doc = { querySelectorAll(selector) { return selector === "error" ? [element] : []; } };
  const exhausted = Platforms.conversationLimitState(adapter, doc);
  assert.equal(exhausted.status, "rollover_required");
  assert.equal(exhausted.code, "supervisor.rollover_required.context_limit");
  assert.equal(Platforms.workflowStopState(adapter, {}, doc).status, "rollover_required");

  element = surface("You've reached your message limit. Try again in 25 minutes.");
  assert.equal(Platforms.conversationLimitState(adapter, doc), null);
  assert.equal(Platforms.workflowStopState(adapter, {}, doc).status, "rate_limited");
});

test("ordinary new-chat suggestions without exhaustion evidence do not trigger rollover", () => {
  const view = { getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }) };
  const ownerDocument = { defaultView: view };
  const element = {
    nodeType: 1,
    ownerDocument,
    textContent: "You can start a new chat whenever you want.",
    getBoundingClientRect: () => ({ width: 420, height: 90 })
  };
  const adapter = { errorSelectors: ["error"], supportsApprovals: false };
  const doc = { querySelectorAll(selector) { return selector === "error" ? [element] : []; } };
  assert.equal(Platforms.conversationLimitState(adapter, doc), null);
});

test("new-chat control detection clicks only an explicit visible ChatGPT control", () => {
  const view = { getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }) };
  const ownerDocument = { defaultView: view };
  let clicks = 0;
  const control = {
    nodeType: 1, ownerDocument, disabled: false, textContent: "New chat",
    getAttribute(name) { return name === "aria-label" ? "New chat" : null; },
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 120, height: 36, right: 130, bottom: 46 }),
    click() { clicks += 1; }
  };
  const doc = { querySelectorAll(selector) { return /New chat|create-new-chat/.test(selector) ? [control] : []; } };
  assert.equal(Platforms.findNewChatControl(Platforms.ADAPTERS.chatgpt, doc), control);
  assert.equal(Platforms.openNewChat(Platforms.ADAPTERS.chatgpt, doc), true);
  assert.equal(clicks, 1);
});

test("new-chat control detection ignores ordinary prose and unrelated navigation", () => {
  const doc = { querySelectorAll() { return []; } };
  assert.equal(Platforms.findNewChatControl(Platforms.ADAPTERS.chatgpt, doc), null);
  assert.equal(Platforms.openNewChat(Platforms.ADAPTERS.chatgpt, doc), false);
});

test("conversation growth snapshot reports only observable DOM message counts and text volume", () => {
  const users = [{ textContent: "one" }, { textContent: "two two" }];
  const assistants = [{ textContent: "three" }, { textContent: "four four four" }];
  const adapter = { userSelectors: ["user"], assistantSelectors: ["assistant"] };
  const doc = { querySelectorAll(selector) { return selector === "user" ? users : selector === "assistant" ? assistants : []; } };
  const snapshot = Platforms.conversationGrowthSnapshot(adapter, doc);
  assert.deepEqual(snapshot, {
    userMessages: 2,
    assistantMessages: 2,
    totalMessages: 4,
    visibleTextChars: "one".length + "two two".length + "three".length + "four four four".length
  });
});
