# Changelog

All notable changes are documented here.

## Unreleased

- Reaffirmed YOLO as a browser-only ChatGPT extension and documented the product boundary, non-goals, roadmap, and success measures.
- Rebuilt README information architecture with a clearer hook, primary actions, GitHub-to-ChatGPT setup guidance, and sponsorship presentation.
- Added launch visual assets, video storyboard, and distribution copy under `marketing/` and `docs/assets/`.
- Removed public-facing third-party coding-assistant wording from the manifest and onboarding to preserve the independent-project boundary.
- Added automated release verification for narrow permissions/hosts, local-only packaged files, no remote or dynamic code, and no CLI/agent/server/native-messaging surfaces.
- Stabilized CI, CodeQL, package artifacts, and tagged GitHub releases on maintained GitHub Actions versions with timeouts and concurrency controls.
- Improved public issue forms, pull-request review guidance, code ownership, contribution rules, README disclosures, and the manual release smoke checklist.

## 1.2.0 - Continuation Supervisor release candidate

- Added durable project identity and conversation lineage across automatic successor-chat rollover.
- Added hard-exhaustion tombstones that permanently prevent automatic work from resuming in a retired source conversation.
- Added proactive rollover from observable conversation growth, fresh semantic handoff generation/verification, bounded retry/cooldown, and safe hard-limit takeover.
- Added real New Chat UI migration with pre-click/pre-submit persistence, exact bootstrap receipt verification, token-bound successor verification, and fail-closed ambiguous delivery.
- Added deterministic A->B->C->D endurance coverage across service-worker restarts and duplicate-tab ownership races.
- Added a formal-release-only authenticated live qualification gate bound to the exact packaged runtime digest.
- Fixed tab-supervisor fallback reinjection so `shared.js` loads before `commands.js` on fresh/install recovery paths.
- Fixed full slash-command submission so recognized YOLO commands are intercepted at the composer form boundary instead of escaping as ordinary ChatGPT messages.
- Fixed false ChatGPT error recovery triggered by generic red-styled authored content; recovery now requires semantic error surfaces or real Retry controls.
- Hardened delivery receipts for multi-paragraph Goal prompts across later user messages, whitespace reflow, and collapsed-message UI chrome such as `Show more`.

## 1.1.0 - overnight reliability

- Added adaptive visible/hidden/generating tab scheduling for large multi-tab ChatGPT sessions.
- Added hydration and long-turn quiet-state guards before automation, response interpretation, or refresh.
- Added an alarm-driven tab supervisor with bounded packaged-script restoration and optional active-workflow discard protection.
- Added lifecycle recovery for page visibility, freeze/resume, extension updates, and same-route React rehydration.
- Reduced extension CPU and storage churn across long-running hidden conversations.

## 1.0.0 - release candidate

- Added a persistent, queue-backed slash-action palette with explicit workflow, prompt-shortcut, and YOLO-control categories.
- Added bounded `/goal` and `/loop` workflows with per-conversation state, CAS revisions, runner leases, exact delivery identity, response stabilization, and required terminal control markers.
- Replaced misleading `/compact`, `/queue`, and `/clear` actions with truthful `/handoff`, `/status`, and `/stop` semantics.
- Redesigned the popup and Advanced settings around a task-first, ChatGPT-native interface.
- Added searchable settings navigation, accessible queue actions, explicit template states, destructive confirmations, and reduced-motion behavior.
- Added first-run onboarding, MIT licensing, privacy/security/contribution policy, reproducible packaging, and release automation.
- Added safe settings/template backups and privacy-safe diagnostics; active automation state is deliberately excluded.
- Preserved local-only operation and ChatGPT-only host access.

## 0.7.0

- Added command workflows and reliability hardening.

## 0.6.0

- Replaced the original hard-coded extension with the persistent queue-first architecture.
