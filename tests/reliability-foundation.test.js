const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Config = require('../config.js');
const Queue = require('../queue.js');
const Platforms = require('../platforms.js');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('automation is restricted to durable saved ChatGPT conversations', () => {
  assert.equal(Config.isDurablePageId('https://chatgpt.com/c/abc123'), true);
  assert.equal(Config.isDurablePageId(Config.pageId('https://chatgpt.com/c/abc123?temporary-chat=true')), true);
  assert.equal(Config.isDurablePageId('https://chatgpt.com/'), false);
  assert.equal(Config.isDurablePageId('https://chatgpt.com/g/gpt-id'), false);
  assert.equal(Config.isDurablePageId('https://example.com/c/abc123'), false);
});

test('draft protection is invariant and approvals default off', () => {
  assert.equal(Config.DEFAULT_SETTINGS.approvalsEnabled, false);
  for (const preset of Object.values(Config.PRESETS)) assert.equal(preset.approvalsEnabled, false);
  assert.equal(Config.normalizeSettings({ pauseOnComposerText: false }).pauseOnComposerText, true);
});

test('automatic queue additions deduplicate within a sliding window', () => {
  const first = Queue.addItem(null, { text: 'Continue', dedupeKey: 'auto:recovery:x' }, { at: 1000, dedupeWindowMs: 5000 });
  const duplicatePending = Queue.addItem(first.state, { text: 'Continue', dedupeKey: 'auto:recovery:x' }, { at: 2000, dedupeWindowMs: 5000 });
  assert.equal(duplicatePending.deduplicated, true);
  assert.equal(duplicatePending.state.items.length, 1);
  const claim = Queue.claimNext(first.state, 'tab', { at: 2000 });
  const done = Queue.completeClaim(claim.state, claim.item.id, claim.item.claimToken, 2500);
  const duplicateCompleted = Queue.addItem(done.state, { text: 'Continue', dedupeKey: 'auto:recovery:x' }, { at: 4000, dedupeWindowMs: 5000 });
  assert.equal(duplicateCompleted.alreadyCompleted, true);
  const outsideWindow = Queue.addItem(done.state, { text: 'Continue', dedupeKey: 'auto:recovery:x' }, { at: 8000, dedupeWindowMs: 5000 });
  assert.equal(outsideWindow.ok, true);
  assert.equal(outsideWindow.deduplicated, undefined);
});

test('automatic action enqueue respects a paused queue', () => {
  const paused = Queue.setPaused(null, true, 1000).state;
  const rejected = Queue.addItem(paused, { text: 'Continue' }, { requireUnpaused: true, at: 1100 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'queue.paused');
});

test('sensitive approvals require the explicit all policy', () => {
  assert.equal(Platforms.approvalVerbAllowed('Authorize', 'safe', 'Connect account access'), false);
  assert.equal(Platforms.approvalVerbAllowed('Authorize', 'writes', 'Connect account access'), false);
  assert.equal(Platforms.approvalVerbAllowed('Authorize', 'all', 'Connect account access'), true);
});

test('submission receipt requires a new matching user message', () => {
  const messages = [{ textContent: 'same prompt' }];
  const adapter = { userSelectors: ['user'] };
  const doc = { querySelectorAll: () => messages };
  const before = Platforms.userMessageSnapshot(adapter, doc);
  assert.equal(Platforms.submissionObserved(adapter, { expectedText: 'same prompt', previousSnapshot: before }, doc), false);
  messages.push({ textContent: 'same prompt' });
  assert.equal(Platforms.submissionObserved(adapter, { expectedText: 'same prompt', previousSnapshot: before }, doc), true);
  messages.push({ textContent: 'different prompt' });
  assert.equal(Platforms.submissionObserved(adapter, { expectedText: 'same prompt', previousSnapshot: before }, doc), false);
});

test('all automated text submissions use the durable queue', () => {
  const content = read('content.js');
  const sendPrompt = content.slice(content.indexOf('async function sendPrompt'), content.indexOf('async function sendContinue'));
  assert.match(sendPrompt, /type: "YOLO_QUEUE_ADD"/);
  assert.doesNotMatch(sendPrompt, /writeAndSubmit/);
  assert.match(content, /previousSnapshot = Platforms\.userMessageSnapshot\(state\.platform, document, prompt\)/);
  assert.match(content, /YOLO_QUEUE_MARK_SUBMITTING/);
});

test('workflow chrome dispatches the truthful stop action', () => {
  const ui = read('command-ui.js');
  const runtime = read('command-runtime.js');
  assert.match(ui, /const clearButton = element\("button", "action", "Stop"\)/);
  assert.match(ui, /callbacks\.stop/);
  assert.match(runtime, /stop: \(\) => executeCommand\("stop"\)/);
  assert.doesNotMatch(runtime, /executeCommand\("clear"\)/);
});

test('package and background composition include the action coordinator', () => {
  assert.match(read('scripts/package.mjs'), /"coordinator\.js"/);
  assert.match(read('background.js'), /importScripts\("config\.js", "shared\.js", "coordinator\.js", "portable-store\.js", "queue\.js", "commands\.js", "projects\.js"\)/);
});

test('automatic dedupe identity is stable across cooldown boundaries', () => {
  const content = read('content.js');
  const start = content.indexOf('function actionDedupeKey');
  const end = content.indexOf('async function sendPrompt', start);
  const helper = content.slice(start, end);
  assert.match(helper, /Commands\.fingerprint/);
  assert.doesNotMatch(helper, /Math\.floor|bucketMs/);
});

test('runtime reset is scoped to the current conversation', () => {
  const background = read('background.js');
  assert.match(background, /Coordinator\.resetPrefix\(state, `\$\{pageId\}::`\)/);
  assert.doesNotMatch(background, /Coordinator\.reset\(state, actionKey \? guardKey : ""\)/);
});

test('runtime reset fails closed when guard storage cannot be reset', () => {
  const content = read('content.js');
  const start = content.indexOf('async function resetRuntime');
  const end = content.indexOf('function registerClient', start);
  const reset = content.slice(start, end);
  assert.match(reset, /const guardReset = await backgroundSendWithRetry/);
  assert.match(reset, /if \(!guardReset\?\.ok\) throw new Error/);
  assert.ok(reset.indexOf('guardReset') < reset.indexOf('state.runtime = ContentState.freshRuntime()'));
});

test('delivery confirmation uses a wall-clock deadline', () => {
  const content = read('content.js');
  assert.match(content, /confirmationDeadline = now\(\) \+ 15_000/);
  assert.doesNotMatch(content, /attempt < 50/);
});
