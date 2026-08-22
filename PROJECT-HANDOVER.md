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

## Implementation checkpoint 003
Implemented the first Supervisor behavior increment in `commands.js`: Goal mode now uses `GOAL_MAX_ITERATIONS = 0` as the persisted sentinel for no arbitrary total-turn cap; Goal iteration normalization is no longer clamped to 50; the legacy 50-turn cap is enforced only for bounded Loop mode; Goal continuation prompts explicitly describe persistent continuation rather than a maximum turn count; command copy no longer calls Goal bounded. Existing stored Goal workflows normalize into the new persistent semantics.

Tests were updated so the legacy cap decision test is explicitly a Loop test, and a regression test proves Goal continues from iteration 50 to 51 while a 50-iteration Loop pauses at its cap. Targeted validation: `node --test tests/commands.test.js tests/ui.test.js` = 46/46 passed; `git diff --check` passed. Baseline environment failures (CRLF portability assertion and missing ffprobe) remain unrelated and are not silently treated as project regressions.

## Implementation checkpoint 004
Added workflow schema v2 and a nested Supervisor bookkeeping state without changing queue ownership/CAS behavior. Legacy v1 workflows normalize to v2 with safe defaults. The state now tracks repeated assistant response count, explicit no-progress observations, recovery attempts, last response/progress fingerprints, last progress/recovery timestamps, and recovery reason. Pure helpers normalize/observe this state and return deterministic circuit-breaker dispositions for repeated responses, no-progress evidence, and excessive recovery attempts. `decideWorkflowResponse` now persists exact-response repetition bookkeeping, but missing markers still pause as before; automatic recovery is intentionally not enabled yet.

Regression coverage was added for v1->v2 migration, safe normalization, progress/recovery counter reset rules, circuit-breaker thresholds, repeated-response persistence, and background storage of Supervisor state. Targeted commands/UI tests pass 50/50. Broad validation excluding only the two documented baseline environment-specific files passes 252/252; `npm run check` passes; `git diff --check` passes. The excluded baseline files remain `portability-integration.test.js` (Windows CRLF assertion) and `validate-asset-manifest.test.js` (ffprobe unavailable).

## Current exact next step
Wire the Supervisor circuit breakers into Goal response processing conservatively: repeated identical responses should enter an explicit stalled/paused state instead of continuing forever, while ordinary unique CONTINUE responses remain unaffected. Then add a dedicated recovery state/prompt path for stable missing-marker endings, with a strict bounded recovery-attempt policy and tests, before enabling any automatic recovery in the runtime.

## Progress estimate
~27% overall. Persistent uncapped Goal semantics and versioned Supervisor bookkeeping are implemented with broad non-environmental regression coverage; runtime stall enforcement, abnormal-ending recovery, completion verification, provider/human stop detection, dashboard/status UI, packaging, and endurance validation remain.
