# Continuation Supervisor release evidence matrix

This file records what is actually proven for the Continuation Supervisor development fork. It intentionally distinguishes automated evidence, public-browser smoke evidence, and authenticated live-chat evidence.

Legend:

- **AUTOMATED PASS** — covered by deterministic unit/integration/endurance tests in this repository.
- **PUBLIC BROWSER PASS** — observed with the packaged candidate loaded in an isolated Chromium profile against the current public ChatGPT site.
- **AUTH LIVE REQUIRED** — cannot be honestly proven without an authenticated saved ChatGPT conversation.
- **ENV BASELINE** — unrelated pre-existing local-environment limitation.

## Required release matrix

| # | Scenario | Current evidence | Notes |
| ---: | --- | --- | --- |
| 1 | Normal response completion | AUTOMATED PASS | Workflow terminal markers, queue completion, and verified Goal completion are covered. |
| 2 | Repeated productive continuation | AUTOMATED PASS | 1,000 productive Goal continuations pass with periodic serialization/restart. |
| 3 | Tool/execution window ends without clean marker | AUTOMATED PASS; AUTH LIVE REQUIRED | Missing-marker Goal recovery is deterministic; a real long tool-window cutoff still needs authenticated live evidence. |
| 4 | Missing marker | AUTOMATED PASS | Goal recovers; bounded Loop pauses. Recovery attempts are bounded. |
| 5 | Malformed/multiple marker | AUTOMATED PASS | Both workflow kinds fail closed on malformed marker protocol. |
| 6 | Browser refresh / tab loss | AUTOMATED PASS; AUTH LIVE REQUIRED | Durable state normalization, service-worker reload, and expired runner-lease takeover by a new tab are tested; real refresh in a saved conversation remains a live smoke requirement. |
| 7 | Extension/service-worker restart | AUTOMATED PASS | Fresh background VM reloads the same persisted queue/workflow identity and Supervisor state. |
| 8 | Temporary network loss / ambiguous delivery | AUTOMATED PASS; AUTH LIVE REQUIRED | Ambiguous delivery becomes `queue.delivery_unknown` and pauses; real network loss still needs browser confirmation. |
| 9 | ChatGPT transient error surface | AUTOMATED PASS; AUTH LIVE REQUIRED | Existing error-recovery path remains distinct from provider-limit classification. |
| 10 | Confirmation / human-required state | AUTOMATED PASS | Approval-policy and generic confirmation-dialog classification are covered. |
| 11 | Repeated identical response/error behavior | AUTOMATED PASS | Exact repeated-response Goal breaker is tested; error cooldown/retry safeguards remain covered by existing runtime tests. |
| 12 | No-progress / stagnation loop | AUTOMATED PASS | Explicit NO_PROGRESS and reused progress evidence stall at the configured threshold. |
| 13 | Premature completion claim | AUTOMATED PASS | First Goal DONE starts independent evidence verification; incomplete verification returns to work. |
| 14 | Provider/rate/usage-limit pause | AUTOMATED PASS; AUTH LIVE REQUIRED | Provider-limit surfaces map to `rate_limited`; naturally occurring live provider UI still needs confirmation. No limit bypass is permitted. |
| 15 | Genuine completion | AUTOMATED PASS; AUTH LIVE REQUIRED | Only verified Goal DONE completes; final live flow still requires authenticated browser evidence. |
| 16 | Long run representative of ~15 hours | AUTOMATED PASS for state-machine endurance; AUTH LIVE REQUIRED | 1,000-cycle deterministic endurance passes. Real elapsed-time unattended ChatGPT operation remains a release blocker alongside authenticated current-site rollover qualification. |

## Public browser smoke evidence

Candidate runtime source: `9c71fcc`.

Candidate SHA-256: `25DD1485EAEF8B108CC6D2FE6029B03DFCB4328D08E335D1BA9106D453D056DB`.

Microsoft Edge 151.0.4129.93 loaded the unpacked candidate in a new isolated profile. The candidate's `background-wrapper.js` Manifest V3 service worker was active, the packaged onboarding page opened, and the current public `https://chatgpt.com/` page received the YOLO shadow-DOM host. The real current ChatGPT composer opened the extension slash palette with all 13 expected commands.

The public guest composer accepted one harmless direct smoke prompt (`Reply exactly: TEST-OK`) and ChatGPT returned `TEST-OK`, demonstrating the current page/composer/response DOM can be observed in this isolated profile. ChatGPT kept the guest conversation on transient `https://chatgpt.com/` rather than assigning a durable `/c/<conversation-id>` route. The extension `/status` command then ran without adding another user message and reported the transient conversation with Queue unavailable, which is the intended fail-closed boundary for non-durable automation.

The isolated profile was not authenticated. The direct guest prompt was not a YOLO durable-queue send. This smoke evidence therefore does not claim message delivery by the YOLO durable queue, saved-conversation workflow execution, authenticated recovery/verification, or long-duration autonomous continuation.

## Baseline environment exclusions

Checkpoint 022 has no local regression exclusions. The Windows CRLF/LF exact-text assertion is newline-agnostic, and MP4 metadata tests inject ffprobe metadata while production validation still defaults to the real executable. The full local suite passes 381/381.

## Release gate

A formal release remains blocked on an authenticated saved-conversation browser pass of the exact v1.2.0 packaged runtime and the required live/endurance evidence. Deterministic cross-conversation rollover is implemented; automated evidence is not treated as equivalent to current-site authenticated execution.

Do not convert **AUTH LIVE REQUIRED** rows to PASS from inference, public-page injection, or unit tests alone. If the live environment exposes a defect, reproduce it deterministically where practical, fix it, rerun the full gate, and repeat the live check before promotion.
## Conversation rollover development gate

Cross-conversation rollover is implemented deterministically through proactive rollover and A->B->C->D endurance. Formal release remains blocked on authenticated live qualification of the exact packaged v1.2.0 runtime. The runtime keeps permanent source-chat tombstones, opens ChatGPT New Chat through an explicit observed UI control, persists bootstrap intent before any transient-composer side effect, and binds only a real successor `/c/<id>` after exact receipt and bootstrap-marker verification.

| # | Rollover scenario | Current evidence | Notes |
| ---: | --- | --- | --- |
| R1 | Hard conversation/context limit is distinct from provider usage/message limits | AUTOMATED PASS | Adapter fixtures classify exhaustion as `rollover_required`; message/rate limits remain `rate_limited`. |
| R2 | Exhausted conversation is permanently ineligible for automated continuation | AUTOMATED PASS | Durable project lineage records `status: exhausted` and `doNotContinue: true`. |
| R3 | Refresh/restored-last-prompt loop cannot resend in exhausted source chat | AUTOMATED PASS | Fresh background VM rejects workflow/queue/action claims, late mark-submitting, restored queue adds, and workflow restart with `project.conversation_exhausted`. |
| R4 | Multiple Goals on one `/c/...` retain correct project ownership | AUTOMATED PASS | New Goals do not inherit completed/stopped projects; old tombstones remain enforceable even when a newer project shares the route. |
| R5 | Durable handoff and restart-safe rollover transaction | AUTOMATED PASS | Project schema v4 preserves rollover stages, CAS revision, a single-owner lease with expiry takeover, semantic handoff generation/verification, verified-handoff/checkpoint/machine-state fallback, and restart/race coverage. Hard exhaustion uses fallback without sending another source-chat prompt. |
| R6 | Automatic New Chat creation and verified successor `/c/...` binding | AUTOMATED PASS; AUTH LIVE REQUIRED | Explicit New Chat control detection, tab-bound lease continuity across source -> transient -> successor navigation, pre-click and pre-submit persistence, exact bootstrap receipt, token-bound response verification, durable lineage binding, and normal Goal-queue resumption are covered. No successor URL is fabricated. Current-site authenticated execution remains required. |
| R7 | Proactive rollover before hard exhaustion | AUTOMATED PASS; AUTH LIVE REQUIRED | Observable message/text growth plus durable Goal continuation thresholds trigger only at productive Goal boundaries. Fresh handoff generation/verification is restart-safe, queue-deduplicated, tab-bound, bounded by cooldown/attempt limits, and hard exhaustion preempts further source prompting. No invented context percentage is used. |
| R8 | Multi-generation project endurance A->B->C->D | AUTOMATED PASS; AUTH LIVE REQUIRED | Deterministic endurance covers A proactive -> B hard-limit -> C proactive -> D with repeated service-worker restarts, stable project identity, ordered generations, successor links, inert retired sources, and active D. Current-site authenticated execution remains required. |
| R9 | Live current-ChatGPT cross-conversation rollover | AUTH LIVE REQUIRED | Checkpoint 022 is the exact v1.2.0 candidate for Phase F; no live PASS is claimed until the digest-bound receipt validates. |

The source-chat tombstone is deliberately fail-closed and survives service-worker restart. It is stored outside the conversation DOM, so a reload that restores prior ChatGPT content cannot make the extension forget that the route is exhausted. No part of this mechanism bypasses ChatGPT/OpenAI account, subscription, model, usage, rate, access, or safety limits.

## Authenticated live attempt 1 - blocker found and fixed

Checkpoint 022 was loaded in the user's authenticated Chrome profile on a real saved ChatGPT project conversation. Before rollover qualification could begin, Chrome reported `commands.js:53 Uncaught TypeError: Cannot read properties of undefined (reading 'makeId')`.

Root cause: `tab-supervisor.js` automatic fallback injection omitted `shared.js` before `commands.js`. The manifest, popup, and options injection orders were already correct. Runtime commit `625940f3ce07b435bc57c3495adb48c4492e1175` fixes the canonical supervisor order and adds a fresh-unhealthy-tab regression that captures the actual injection payload.

Post-fix evidence is automated only: 382/382 full tests, 52/52 focused live-defect tests, 39/39 package parity, runtime digest `BC4CB45B885A91E13A6843F36E00492B11E8C61A094204DCEDAB176A7495DF35`. **AUTH LIVE REQUIRED** remains unchanged until the corrected runtime is reloaded and the full saved-source -> successor flow is actually observed.

## Phase F live finding - checkpoint 024
Authenticated queue delivery on checkpoint 023 was observed once end-to-end with exact user/assistant token `YOLO-LIVE-QUEUE-OK`. The subsequent full `/goal ...` qualification command escaped as an ordinary ChatGPT message instead of starting the workflow, so Phase F remained failed/blocked rather than promoted.
Checkpoint 024 fixes the public command-submission boundary: recognized YOLO slash commands are intercepted on composer form `submit` in capture phase in addition to keydown. Full deterministic suite passes 383/383; focused command/runtime gate passes 91/91. Exact runtime digest: `83AF4B14DEBEDF560D38137A46E0073826E8888B85D0565D7FB863C9450230E1`.
This is automated remediation evidence only. R9 remains **AUTH LIVE REQUIRED** until the corrected runtime is reloaded and the complete rollover path is actually observed.
### Authenticated live evidence — checkpoint 024 Goal start
- Checkpoint 024 command interception was exercised on the real authenticated ChatGPT composer after extension Reload.
- `/goal <objective>` was intercepted and converted into the generated persistent Goal prompt; it did not fall through as the slash command itself.
- The generated Goal prompt is visible in the saved source conversation and the workflow is active.
- R6/R7/R8/R9 remain not fully qualified until the real proactive rollover and successor lifecycle complete.

## Live qualification update — checkpoint 025
- Live blocker 3 reproduced: workflow prompt delivery could be falsely classified unknown if a later user message became newest before receipt polling observed the expected prompt.
- Fix commit: `5cf422ac0c763c0067d08b374863db2c04bef871`; exact packaged runtime digest `5E8C8BBCBFCFA1A65B994BD54CCF3BB340331A1B9450B75D723FC94CF16D6C06`.
- Safety property preserved: receipt requires an increase in the exact expected prompt occurrence count, so an older identical message cannot satisfy a new submit.
- Validation: 385/385 full suite; 30/30 focused receipt tests; 39 packaged files; installed live folder exact parity.
- Authenticated observation after reload: blocked Goal resumed and emitted a new workflow-owned Goal prompt in the saved ChatGPT conversation.
- R9 remains `AUTH LIVE REQUIRED`; no successor-chat PASS is claimed yet.

### Authenticated live attempt - checkpoint 027 receipt canonicalization
This is blocker/fix evidence only, not an R9 live PASS.

Observed: authenticated one-line queue delivery had passed, but multi-paragraph Goal prompts were visibly delivered and then classified delivery-unknown. ChatGPT may re-render paragraph/newline topology differently from composer text. Checkpoint 027 changes receipt-only comparison to collapse whitespace topology while preserving exact non-whitespace character order. A changed YOLO control marker remains a mismatch, and older identical prompts are not reused.

Checkpoint 026 additionally removed generic red CSS classes from ChatGPT error detection after repeated false recovery activity was observed without a real Retry/error surface.

Current runtime commit: `6745cfd392d0e69d838be018172b6a4b0006e9cf`; runtime SHA-256: `638466DC127AA11A3A83442C4B1F6DBDAF7FD888AAE5521F982C91F528A539CB`; full suite 387/387; focused receipt gate 32/32; 39 packaged files. Live PASS remains pending post-reload authenticated rollover qualification.
### Authenticated live attempt - checkpoint 029 receipt success
- Candidate runtime: `4f50903156040c7d9726b8c1b9dfd595e1e33e84` / SHA-256 `673A6983D0309B30A7E3F57E6A865592C0CDD0E197BA96BBD964B00B9D726C65`.
- Checkpoint 028 diagnostics proved the rendered ChatGPT user subtree appended interactive `Show more` chrome to the authored Goal prompt.
- Checkpoint 029 excludes interactive descendants from user-message receipt extraction; focused regression 34/34 and full suite 389/389 passed.
- Authenticated browser observation: the multi-paragraph Goal prompt was acknowledged, workflow controls stayed active (`Pause/Edit/Stop`), and YOLO generated continuation 2 after the assistant emitted `[YOLO:CONTINUE]`.
- This advances live evidence for exact workflow prompt delivery and Goal self-continuation, but does not satisfy the full 13-field qualification receipt.
- R9 remains AUTH LIVE REQUIRED until real proactive rollover, successor bootstrap verification, lineage advance, no-duplicate evidence, and restart recovery are observed on the exact final runtime.
