# Continuation Supervisor — Resume Here

Authoritative branch: `continuation-supervisor-development`
Persistent repo: `C:\Users\user\ChatGPT-Continuation-Supervisor\chatgpt-yolo`
Checkpoint directory: `C:\Users\user\ChatGPT-Continuation-Supervisor\checkpoints`

## Resume protocol
1. Fetch origin and inspect local/remote HEAD, status, and diff. Never reset newer work.
2. Read this file, then the newest section at the end of `PROJECT-HANDOVER.md`.
3. Continue the exact unfinished phase; do not redo settled architecture/audits.
4. Before stopping: validate, update these repo files, commit, push, and checkpoint verified work.

## Current authoritative state
Checkpoint 018 commit: `d23e05d` — conversation rollover foundation.
Current overall estimate: ~81% toward the actual cross-conversation goal.
Phase A is complete: project schema/lineage, workflow schema v4 `projectId`, separate context-limit detection, `rollover_required`, permanent exhausted-chat `doNotContinue` tombstones, and fail-closed no-send enforcement.
Validation at Phase A: 297/297 current non-environmental tests after documentation gate; 39 runtime files; syntax/boundary/package/no-bare-installs/diff-check clean.

## Exact next work
Phase B: durable handoff + restart-safe rollover transaction. Add project CAS/revision operations and a project-level rollover lease; persist transaction stages; add semantic handoff generation/verification; keep machine state separate; fall back to the latest verified persisted checkpoint/handoff if the source chat cannot generate a fresh one. Test duplicate-tab races and service-worker restart at every stage before Phase C New Chat creation.
