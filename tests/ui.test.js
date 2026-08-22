const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Config = require("../config.js");

const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");

function ids(html) {
  return [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
}

test("popup and advanced page have unique element identifiers", () => {
  for (const name of ["popup.html", "options.html"]) {
    const values = ids(read(name));
    assert.equal(new Set(values).size, values.length, `${name} contains duplicate ids`);
  }
});

test("advanced page exposes every configurable setting while popup stays compact", () => {
  const options = read("options.html");
  for (const key of Object.keys(Config.DEFAULT_SETTINGS)) {
    assert.match(options, new RegExp(`data-setting=["']${key}["']`), `missing advanced control for ${key}`);
  }

  const popup = read("popup.html");
  assert.equal((popup.match(/<details\b/g) || []).length <= 1, true);
  assert.equal((popup.match(/data-setting=/g) || []).length, 0);
  assert.match(popup, /id="queueList"/);
  assert.match(popup, /id="templateSelect"/);
});

test("extension pages use external scripts only", () => {
  for (const name of ["popup.html", "options.html"]) {
    const html = read(name);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
    assert.doesNotMatch(html, /\son\w+\s*=/i);
  }
});


test("queue engine persists submission intent before touching the composer", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  const markIndex = source.indexOf('type: "YOLO_QUEUE_MARK_SUBMITTING"');
  const submitIndex = source.indexOf("const submitted = await writeAndSubmit(item.text, queuePageId)");
  assert.ok(markIndex >= 0);
  assert.ok(submitIndex > markIndex);
});

test("popup commits content and queue state atomically", () => {
  const source = read("popup.js");
  const queueGuard = source.indexOf("if (!queueResponse?.ok) return false;");
  const contentCommit = source.indexOf("contentState = nextContent;");
  const queueCommit = source.indexOf("queueState = queueResponse.state;");
  assert.ok(queueGuard >= 0 && contentCommit > queueGuard && queueCommit > contentCommit);
});

test("popup initialization and editing shortcuts fail closed", () => {
  const source = read("popup.js");
  const init = source.slice(source.indexOf("async function init()"), source.indexOf("els.enabled.addEventListener"));
  assert.match(init, /setBusy\(true\)/);
  assert.match(init, /includeTemplates: true, force: true/);
  assert.match(init, /setBusy\(false\)/);
  assert.match(source, /send: event\.shiftKey && !editingId/);
});

test("template rendering receives the current conversation", () => {
  const source = read("popup.js");
  assert.match(source, /conversation: contentState\?\.pageId/);
});

test("primary controls and dynamic option statuses are accessibly named", () => {
  assert.match(read("popup.html"), /id="enabled"[^>]*aria-label="Run automation for this conversation"/);
  const options = read("options.html");
  assert.match(options, /id="saveStatus"[^>]*role="status"/);
  assert.match(options, /id="templateStatus"[^>]*role="status"/);
});

test("queue failures forward explicit delivery ambiguity", () => {
  const source = read("content.js");
  assert.match(source, /deliveryAmbiguous: submissionAttempted/);
  assert.match(source, /submitted\.code, deliveryAmbiguous/);
  assert.match(source, /"queue\.exception", deliveryAmbiguous/);
});

test("ChatGPT content scripts include the composer-native command system", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const scripts = manifest.content_scripts[0].js;
  assert.ok(scripts.indexOf("commands.js") < scripts.indexOf("command-ui.js"));
  assert.ok(scripts.indexOf("command-ui.js") < scripts.indexOf("content.js"));
  assert.ok(scripts.indexOf("content.js") < scripts.indexOf("command-runtime.js"));
});

test("command palette supports slash and YOLO command shortcuts", () => {
  const source = read("command-ui.js");
  assert.match(source, /event\.key === "\/"/);
  assert.match(source, /event\.shiftKey && event\.key\.toLowerCase\(\) === "p"/);
  assert.match(source, /Commands\.parseInvocation/);
  assert.match(source, /ArrowDown/);
  assert.match(source, /ArrowUp/);
});

test("recognized slash commands are intercepted at the composer submit boundary", () => {
  const source = read("command-ui.js");
  assert.ok(source.includes("function interceptComposerInvocation"));
  assert.ok(source.includes("if (!invocation) return false;"));
  assert.ok(source.includes('document.addEventListener("submit", submit, true);'));
  assert.ok(source.includes('document.removeEventListener("submit", submit, true);'));
  assert.ok(source.includes("event.target === form"));
});

test("command workflows reuse the reliable queue and fail closed", () => {
  const runtime = read("command-runtime.js");
  const commands = read("commands.js");
  assert.match(runtime, /type: "YOLO_QUEUE_ADD"/);
  assert.match(runtime, /runAction\("queue-next"\)/);
  assert.match(runtime, /Commands\.decideWorkflowResponse/);
  assert.match(runtime, /Platforms\.workflowStopState/);
  assert.match(runtime, /await markWorkflow\(stopState\.status, stopState\.reason, stopState\.code\)/);
  assert.match(commands, /response omitted the required terminal control marker/);
  assert.match(commands, /Reached the \$\{workflow\.maxIterations\}-iteration safety cap/);
});

test("content exposes only a narrow lifecycle-safe command API", () => {
  const source = read("content.js");
  assert.match(source, /const commandApi = Object\.freeze/);
  assert.match(source, /registerClient/);
  assert.match(source, /runAction: runManualAction/);
  assert.match(source, /state\.clients\.clear\(\)/);
});

test("command workflow runtime enforces ownership, CAS, and a single runner", () => {
  const runtime = read("command-runtime.js");
  assert.match(runtime, /expectedRevision: normalized\.revision/);
  assert.match(runtime, /YOLO_WORKFLOW_CLAIM/);
  assert.match(runtime, /Commands\.decideWorkflowResponse/);
  assert.match(runtime, /queue\.state\.completions\.some/);
  assert.doesNotMatch(runtime, /lastSentAt >= workflow\.lastPromptAt/);
});

test("command palette preserves failed direct commands and exposes feedback", () => {
  const source = read("command-ui.js");
  assert.match(source, /role", "status"/);
  assert.match(source, /originalComposerText/);
  assert.match(source, /Commands\.requiresArgs\(entry\.name\)/);
  assert.match(source, /\["paused", "stalled", "rate_limited", "human_required", "blocked"\]\.includes\(currentWorkflow\.status\)/);
});

test("command UI handles blocked resume, IME, and shortcut scope safely", () => {
  const source = read("command-ui.js");
  assert.match(source, /destroyed \|\| event\.isComposing/);
  assert.match(source, /composerTarget && event\.key\.toLowerCase\(\) === "k"/);
  assert.match(source, /\["paused", "stalled", "rate_limited", "human_required", "blocked"\]\.includes\(currentWorkflow\.status\) \? callbacks\.resume\(\) : callbacks\.pause\(\)/);
  assert.match(source, /workflowActionInFlight/);
});

test("runtime uses pure workflow decisions, recovery prompts, and the completion ring", () => {
  const runtime = read("command-runtime.js");
  assert.match(runtime, /Commands\.decideWorkflowResponse/);
  assert.match(runtime, /decision\.action === "verify"/);
  assert.match(runtime, /Commands\.workflowPrompt\(state\.workflow, "verification"\)/);
  assert.match(runtime, /decision\.action === "recover"/);
  assert.match(runtime, /Commands\.workflowPrompt\(state\.workflow, "recovery"\)/);
  assert.match(runtime, /queue\.state\.completions\.some/);
});

test("workflow prompt creation is atomic and responses must settle", () => {
  const runtime = read("command-runtime.js");
  assert.match(runtime, /YOLO_WORKFLOW_QUEUE_ADD/);
  assert.match(runtime, /Lifecycle\.responseStableMs\(outcome\)/);
  assert.match(runtime, /responseCandidateFingerprint/);
  assert.doesNotMatch(runtime, /type: "YOLO_QUEUE_ADD"[\s\S]{0,900}Workflow changed before its prompt could be committed/);
});

test("fallback injection restores the full command content-script stack", () => {
  const expected = '["config.js", "lifecycle.js", "platforms.js", "shared.js", "commands.js", "command-ui.js", "content-state.js", "content.js", "command-runtime.js"]';
  assert.match(read("popup.js"), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(read("options.js"), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(read("tab-supervisor.js"), /"config\.js",\s*"lifecycle\.js",\s*"platforms\.js",\s*"shared\.js",\s*"commands\.js",\s*"command-ui\.js",\s*"content-state\.js",\s*"content\.js",\s*"command-runtime\.js"/);
});

test("palette filter text is not leaked into optional command arguments", () => {
  const source = read("command-ui.js");
  assert.match(source, /run\(entry, argumentCommand \? search\.value : ""\)/);
});

test("command palette exposes active keyboard selection and restores every workflow action", () => {
  const source = read("command-ui.js");
  assert.match(source, /aria-activedescendant/);
  assert.match(source, /role", "combobox"/);
  assert.match(source, /yolo-command-option-\$\{entry\.name\}/);
  assert.match(source, /clearButton\.disabled = workflowActionInFlight/);
});

test("pause and clear preserve prompts that are already sending", () => {
  const runtime = read("command-runtime.js");
  const guards = runtime.match(/state\.workflow\.pendingItemId && !cancelled\.removed/g) || [];
  assert.equal(guards.length, 2);
});

test("workflow response baseline is captured only before prompt delivery", () => {
  const runtime = read("command-runtime.js");
  const captures = runtime.match(/next\.baselineFingerprint = latestAssistantFingerprint\(\)/g) || [];
  assert.equal(captures.length, 1);
  const capture = runtime.indexOf("next.baselineFingerprint = latestAssistantFingerprint()");
  const enqueue = runtime.indexOf('type: "YOLO_WORKFLOW_QUEUE_ADD"');
  assert.ok(capture >= 0 && capture < enqueue);
});

test("premium popup keeps one dominant action and progressive disclosure", () => {
  const popup = read("popup.html");
  assert.equal((popup.match(/class="primary-button"/g) || []).length, 1);
  assert.match(popup, /class="brand-lockup"/);
  assert.match(popup, /class="compose-panel"/);
  assert.match(popup, /class="queue-panel"/);
  assert.match(popup, /class="activity-panel"/);
  assert.match(popup, /id="advanced"[^>]*aria-label="Open Advanced settings"/);
});

test("advanced settings has searchable persistent section navigation", () => {
  const options = read("options.html");
  const links = [...options.matchAll(/data-section-link="([^"]+)"/g)].map((match) => match[1]);
  const sections = [...options.matchAll(/id="([^"]+)"[^>]*data-settings-section/g)].map((match) => match[1]);
  assert.deepEqual(links, ["overview", "queue", "approvals", "recovery", "nudges", "refresh", "safety", "templates", "data"]);
  assert.deepEqual(sections, links);
  assert.match(options, /id="settingsSearch"[^>]*type="search"/);
  assert.match(options, /id="searchEmpty"/);
  assert.match(options, /class="workspace-header"/);
  assert.match(options, /<script src="options-ui\.js"><\/script>/);
});

test("premium visual systems include focus, reduced motion, and responsive layouts", () => {
  const themeCss = read("theme.css");
  const optionsCss = read("options.css");
  // Shared tokens, base resets, focus, and reduced motion live in theme.css.
  assert.match(themeCss, /:focus-visible/);
  assert.match(themeCss, /prefers-reduced-motion/);
  assert.match(themeCss, /--surface:/);
  // Each surface loads theme.css before its page-specific stylesheet.
  for (const name of ["popup.html", "options.html", "onboarding.html"]) {
    const html = read(name);
    const themePos = html.search(/href="theme\.css"/);
    const pageCss = name === "popup.html" ? /href="styles\.css"/ : name === "options.html" ? /href="options\.css"/ : /href="onboarding\.css"/;
    const pagePos = html.search(pageCss);
    assert.ok(themePos !== -1, `${name} must link theme.css`);
    assert.ok(pagePos > themePos, `${name} must load theme.css before its page stylesheet`);
  }
  assert.match(optionsCss, /@media \(max-width: 680px\)/);
  assert.match(optionsCss, /position: sticky/);
});

test("settings controller provides filtering, active navigation, and save-state mapping", () => {
  const source = read("options-ui.js");
  assert.match(source, /sectionMatches/);
  assert.match(source, /aria-current/);
  assert.match(source, /IntersectionObserver/);
  assert.match(source, /MutationObserver/);
  assert.match(source, /saveStateFor/);
});

test("queue item controls are explicitly named and respect reorder boundaries", () => {
  const source = read("popup.js");
  assert.match(source, /button\.setAttribute\("aria-label", title\)/);
  assert.match(source, /moveUp\.disabled = hasWorkflowItem \|\| managed \|\| index === 0/);
  assert.match(source, /moveDown\.disabled = hasWorkflowItem \|\| managed \|\| index === items\.length - 1/);
  assert.match(source, /li\.draggable = !hasWorkflowItem/);
});

test("settings navigation preserves scope and respects reduced motion", () => {
  const source = read("options-ui.js");
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /win\.location\?\.search/);
  assert.match(source, /behavior: reducedMotion \? "auto" : "smooth"/);
});

test("template feedback and empty state remain explicit", () => {
  const source = read("options.js");
  const css = read("options.css");
  assert.match(source, /templateStatus\.dataset\.level/);
  assert.match(source, /className = "template-empty"/);
  assert.match(css, /#templateStatus\[data-level="error"\]/);
  assert.match(css, /\.template-list \.template-empty/);
});

test("settings navigation stays available during template operations", () => {
  const source = read("options.js");
  assert.match(source, /button:not\(\[data-section-link\]\):not\(#clearSearch\)/);
});

test("destructive settings actions require confirmation and always report outcomes", () => {
  const source = read("options.js");
  assert.match(source, /Delete this template\? This cannot be undone/);
  assert.match(source, /Replace all templates with the built-in defaults/);
  assert.match(source, /Restore every automation setting to its default value/);
  assert.match(source, /Template deleted\./);
  assert.match(source, /Could not restore default templates/);
});

test("slash actions expose only viable product semantics", () => {
  const commands = read("commands.js");
  const runtime = read("command-runtime.js");
  const readme = read("README.md");
  assert.doesNotMatch(commands, /name: "compact"|name: "queue"|name: "clear"/);
  assert.match(commands, /name: "handoff"[\s\S]*kind: "prompt"/);
  assert.match(commands, /name: "stop"[\s\S]*kind: "control"/);
  assert.match(runtime, /\["plan", "review", "fix", "handoff", "continue"\]/);
  assert.doesNotMatch(runtime, /name === "queue"|name === "clear"|"compact"/);
  assert.match(readme, /not native ChatGPT commands/i);
  assert.match(readme, /does \*\*not\*\* compact or alter ChatGPT context/i);
});

test("workflow observability exposes phase, cycle, progress, and circuit breakers", () => {
  const runtime = read("command-runtime.js");
  const ui = read("command-ui.js");
  assert.match(runtime, /Phase:.*Commands.workflowPhase/);
  assert.match(runtime, /Cycle:.*Commands.workflowIterationLabel/);
  assert.match(runtime, /Progress evidence/);
  assert.match(runtime, /No progress/);
  assert.match(runtime, /Repeated response/);
  assert.match(runtime, /Recovery/);
  assert.match(runtime, /Verification/);
  assert.match(ui, /Commands\.workflowPhase\(currentWorkflow\)/);
  assert.match(ui, /Commands\.workflowIterationLabel\(currentWorkflow\)/);
  assert.equal(ui.includes('iteration ${currentWorkflow.iteration}/${currentWorkflow.maxIterations}'), false);
});


test("Supervisor status surfaces project and rollover state while rollover-required chats stay non-resumable", () => {
  const runtime = read("command-runtime.js");
  const ui = read("command-ui.js");
  assert.match(runtime, /const project = await readProject\(state\.rolloverProjectId \|\| workflow\.projectId\)/);
  assert.match(runtime, /"Rollover stage": project\?\.rollover\?\.stage/);
  assert.match(runtime, /"Bootstrap state": project\?\.rollover\?\.bootstrapState/);
  assert.match(runtime, /"Handoff source": project\?\.rollover\?\.handoffSource/);
  assert.doesNotMatch(ui, /\["paused", "stalled", "rate_limited", "human_required", "rollover_required", "blocked"\]\.includes\(currentWorkflow\.status\)/);
});
