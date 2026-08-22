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
| 16 | Long run representative of ~15 hours | AUTOMATED PASS for state-machine endurance; AUTH LIVE REQUIRED | 1,000-cycle deterministic endurance passes. Real elapsed-time unattended ChatGPT operation remains a release blocker alongside unfinished cross-conversation rollover. |

## Public browser smoke evidence

Candidate runtime source: `9c71fcc`.

Candidate SHA-256: `25DD1485EAEF8B108CC6D2FE6029B03DFCB4328D08E335D1BA9106D453D056DB`.

Microsoft Edge 151.0.4129.93 loaded the unpacked candidate in a new isolated profile. The candidate's `background-wrapper.js` Manifest V3 service worker was active, the packaged onboarding page opened, and the current public `https://chatgpt.com/` page received the YOLO shadow-DOM host. The real current ChatGPT composer opened the extension slash palette with all 13 expected commands.

The public guest composer accepted one harmless direct smoke prompt (`Reply exactly: TEST-OK`) and ChatGPT returned `TEST-OK`, demonstrating the current page/composer/response DOM can be observed in this isolated profile. ChatGPT kept the guest conversation on transient `https://chatgpt.com/` rather than assigning a durable `/c/<conversation-id>` route. The extension `/status` command then ran without adding another user message and reported the transient conversation with Queue unavailable, which is the intended fail-closed boundary for non-durable automation.

The isolated profile was not authenticated. The direct guest prompt was not a YOLO durable-queue send. This smoke evidence therefore does not claim message delivery by the YOLO durable queue, saved-conversation workflow execution, authenticated recovery/verification, or long-duration autonomous continuation.

## Baseline environment exclusions

The normal broad local regression command excludes only two pre-existing environment-specific cases:

- `portability-integration.test.js`: Windows checkout line-ending assertion (CRLF/LF exact-text mismatch).
- ffprobe-dependent MP4 cases in `validate-asset-manifest.test.js`: `ffprobe` is not installed/on PATH.

These exclusions predate the Continuation Supervisor changes and are not counted as product regressions. Syntax, package-boundary, release/package, queue, workflow, Supervisor, UI, privacy, permissions, and endurance tests continue to run.

## Release gate

A formal release remains blocked until cross-conversation rollover is implemented and qualified, and an authenticated saved-conversation browser pass validates actual composer delivery and response observation on the current ChatGPT UI, including restart/recovery/verification/stop-state flows, followed by a long-duration run representative of the intended unattended workflow.

Do not convert **AUTH LIVE REQUIRED** rows to PASS from inference, public-page injection, or unit tests alone. If the live environment exposes a defect, reproduce it deterministically where practical, fix it, rerun the full gate, and repeat the live check before promotion.
## Conversation rollover development gate

Cross-conversation rollover is now implemented deterministically through Phase C, but formal release remains blocked on proactive rollover, multi-generation endurance, and authenticated live qualification. The runtime keeps permanent source-chat tombstones, opens ChatGPT New Chat through an explicit observed UI control, persists bootstrap intent before any transient-composer side effect, and binds only a real successor `/c/<id>` after exact receipt and bootstrap-marker verification.

| # | Rollover scenario | Current evidence | Notes |
| ---: | --- | --- | --- |
| R1 | Hard conversation/context limit is distinct from provider usage/message limits | AUTOMATED PASS | Adapter fixtures classify exhaustion as `rollover_required`; message/rate limits remain `rate_limited`. |
| R2 | Exhausted conversation is permanently ineligible for automated continuation | AUTOMATED PASS | Durable project lineage records `status: exhausted` and `doNotContinue: true`. |
| R3 | Refresh/restored-last-prompt loop cannot resend in exhausted source chat | AUTOMATED PASS | Fresh background VM rejects workflow/queue/action claims, late mark-submitting, restored queue adds, and workflow restart with `project.conversation_exhausted`. |
| R4 | Multiple Goals on one `/c/...` retain correct project ownership | AUTOMATED PASS | New Goals do not inherit completed/stopped projects; old tombstones remain enforceable even when a newer project shares the route. |
| R5 | Durable handoff and restart-safe rollover transaction | AUTOMATED PASS | Project schema v3 preserves rollover stages, CAS revision, a single-owner lease with expiry takeover, semantic handoff generation/verification, verified-handoff/checkpoint/machine-state fallback, and restart/race coverage. Hard exhaustion uses fallback without sending another source-chat prompt. |
| R6 | Automatic New Chat creation and verified successor `/c/...` binding | AUTOMATED PASS; AUTH LIVE REQUIRED | Explicit New Chat control detection, tab-bound lease continuity across source -> transient -> successor navigation, pre-click and pre-submit persistence, exact bootstrap receipt, token-bound response verification, durable lineage binding, and normal Goal-queue resumption are covered. No successor URL is fabricated. Current-site authenticated execution remains required. |
| R7 | Proactive rollover before hard exhaustion | REQUIRED - NOT YET IMPLEMENTED | Phase D; observable signals only, no invented context percentage. |
| R8 | Multi-generation project endurance A->B->C->D | REQUIRED - NOT YET IMPLEMENTED | Phase E. |
| R9 | Live current-ChatGPT cross-conversation rollover | AUTH LIVE REQUIRED | Phase F after deterministic transaction/binding coverage is complete. |

The source-chat tombstone is deliberately fail-closed and survives service-worker restart. It is stored outside the conversation DOM, so a reload that restores prior ChatGPT content cannot make the extension forget that the route is exhausted. No part of this mechanism bypasses ChatGPT/OpenAI account, subscription, model, usage, rate, access, or safety limits.
