# Continuation Supervisor — Living Handover

Updated: 2026-08-21
Branch: continuation-supervisor-development
Baseline commit: d018c6a
Upstream/fork: kartikkabadi/chatgpt-yolo -> axelisaac-coding/chatgpt-yolo

## Objective
Evolve the MIT-licensed YOLO for ChatGPT Chromium extension into a durable, progress-aware Continuation Supervisor for long ChatGPT browser projects. ChatGPT remains the intelligent worker; the extension deterministically keeps work moving across response/tool-execution endings without an OpenAI API, second AI, or local LLM. It must not bypass provider/account limits.

## Non-negotiable design
- Preserve upstream MIT notice and reliable delivery/lease/deduplication substrate.
- Preserve main as baseline; all work occurs on continuation-supervisor-development.
- No arbitrary total-turn ceiling for productive long-project Goal mode.
- Retain bounded safety controls and add progress/stagnation/recovery circuit breakers rather than naive infinite looping.
- Detect/handle normal CONTINUE, genuine completion, blockers, abrupt/missing-marker endings, repeated no-progress, provider limits, and human-required states conservatively.
- Important work must be checkpointed durably; recovery must inspect actual state rather than assume interrupted operations completed.

## Environment
Persistent working tree: C:\Users\user\ChatGPT-Continuation-Supervisor\chatgpt-yolo
Git for Windows: 2.55.0.windows.5
GitHub CLI authenticated as axelisaac-coding with repo scope/admin repository access.
Node: v24.19.0; npm: 11.17.0.
Development branch was created locally and pushed to origin successfully.

## Baseline validation
`npm run validate:core` reached the test suite and reported 269 tests: 266 passed, 3 failed.
Failures are baseline/environment related, before any project source modifications:
1. portability-integration.test.js newline mismatch: Windows CRLF vs expected LF in background-wrapper.js.
2-3. validate-asset-manifest MP4 tests: ffprobe is not installed/on PATH.
No Continuation Supervisor source changes existed when this baseline was recorded.
Git core.autocrlf was set false for this working tree and tree reset clean; upstream file itself is CRLF in this checkout/history path, so the baseline newline test remains a known Windows portability issue rather than silently changing source before baseline preservation.

## Confirmed upstream architecture
commands.js: MAX_ITERATIONS=50, DEFAULT_MAX_ITERATIONS=12; statuses idle/running/paused/completed/blocked; kinds goal/loop; markers CONTINUE/DONE/BLOCKED. Goal currently starts with maxIterations=50. normalizeWorkflow clamps iteration/maxIterations to 50. decideWorkflowResponse pauses at cap, pauses on missing/malformed markers, completes immediately on DONE, blocks on BLOCKED.
command-runtime.js owns workflow read/write/claim/release, atomic workflow prompt enqueue, response processing, queue delivery, polling, pause/resume/stop, and event recording.
Existing tests cover workflow ownership/CAS/single runner, atomic queue transitions, markers/caps, missing marker quiet window, delivery ambiguity, persistence, UI and safety behavior.
config.js also has independent action/session/hour safety limits. These must not be confused with the 50-turn workflow cap or indiscriminately removed.

## Target state model / behavior
Candidate semantics: CONTINUE, RECOVER, VERIFY, STALLED, HUMAN_REQUIRED, RATE_LIMITED, COMPLETE, FATAL. Not every semantic must be a literal model marker; supervisor-derived states should remain deterministic.
Missing clean terminal status after a stable response/tool ending should eventually enter conservative recovery rather than blindly assuming success. Recovery prompt must tell ChatGPT to inspect durable state/artifacts, find last verified completion and first uncertain operation, checkpoint, then resume.
Completion should eventually be verification-aware rather than trusting a premature DONE blindly.
Progress should be measured by evidence/fingerprints/checkpoints, not total turns. Repeated identical/no-progress/recovery cycles must trip bounded circuit breakers.

## Implementation order
1. Finish detailed runtime/test mapping.
2. Introduce a versioned supervisor/workflow schema compatible with existing stored workflows.
3. Separate long-running Goal semantics from bounded Loop semantics; remove arbitrary total cap from Goal without removing safety controls.
4. Add recovery/progress bookkeeping and tests.
5. Add conservative abnormal/missing-marker recovery.
6. Add completion verification and richer stop reasons/provider/human states.
7. Add dashboard/status/log controls after core engine reliability.
8. Package unpacked extension candidate and run real ChatGPT endurance/failure-mode tests.

## Required test matrix
Normal completion; repeated productive continuation; abrupt tool-window ending; missing/malformed marker; refresh; service-worker/extension restart; network loss; ChatGPT error; confirmation/human required; repeated identical error; no-progress loop; premature completion; provider/rate limit pause; genuine completion; long endurance run representative of ~15 hours.

## Current exact next step
Modify the workflow model in small test-driven increments. First change should preserve bounded `/loop` behavior while introducing uncapped long-project `/goal` semantics in a backward-compatible schema, with explicit tests proving Goal can continue past 50 while Loop still caps. Do not yet add automatic missing-marker recovery until the state migration and cap semantics are stable.

## Progress estimate
~10% overall. Repository/environment/branch/baseline and architecture mapping are established. Coding of new behavior is the next step.
