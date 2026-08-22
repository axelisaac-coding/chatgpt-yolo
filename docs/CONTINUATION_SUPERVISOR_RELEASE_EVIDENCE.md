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
| 16 | Long run representative of ~15 hours | AUTOMATED PASS for state-machine endurance; AUTH LIVE REQUIRED | 1,000-cycle deterministic endurance passes. Real elapsed-time unattended ChatGPT operation remains the principal release blocker. |

## Public browser smoke evidence

Candidate runtime source: `fdf2114`.

Candidate SHA-256: `7CDB245ED5B78A3099EAFD370B3B1D873AE6A3FEE6B43CB5C34B071C03EE3F26`.

Microsoft Edge 151.0.4129.93 loaded the unpacked candidate in a new isolated profile. The candidate's `background-wrapper.js` Manifest V3 service worker was active, the packaged onboarding page opened, and the current public `https://chatgpt.com/` page received the YOLO command/workflow/status shadow-DOM host. All 13 expected commands were present. The packaged service-worker context reported Goal sentinel `0`, schema `3`, and Supervisor limits `2 / 3 / 3 / 2`.

The isolated profile was not authenticated and the public page had no ChatGPT composer. This smoke evidence therefore does not claim message delivery, saved-conversation workflow execution, or long-duration autonomous continuation.

## Baseline environment exclusions

The normal broad local regression command excludes only two pre-existing environment-specific cases:

- `portability-integration.test.js`: Windows checkout line-ending assertion (CRLF/LF exact-text mismatch).
- ffprobe-dependent MP4 cases in `validate-asset-manifest.test.js`: `ffprobe` is not installed/on PATH.

These exclusions predate the Continuation Supervisor changes and are not counted as product regressions. Syntax, package-boundary, release/package, queue, workflow, Supervisor, UI, privacy, permissions, and endurance tests continue to run.

## Release gate

A formal release remains blocked until an authenticated saved-conversation browser pass validates actual composer delivery and response observation on the current ChatGPT UI, including restart/recovery/verification/stop-state flows, followed by a long-duration run representative of the intended unattended workflow.

Do not convert **AUTH LIVE REQUIRED** rows to PASS from inference, public-page injection, or unit tests alone. If the live environment exposes a defect, reproduce it deterministically where practical, fix it, rerun the full gate, and repeat the live check before promotion.