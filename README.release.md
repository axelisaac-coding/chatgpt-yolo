# YOLO for ChatGPT — Continuation Supervisor development candidate

This development fork extends the MIT-licensed YOLO for ChatGPT Chromium extension with persistent, progress-aware Goal supervision for long ChatGPT projects. It uses the normal ChatGPT browser composer and does not require the OpenAI API, a second hosted AI, or a local model.

## Candidate status

This is a browser-test candidate from `axelisaac-coding/chatgpt-yolo`, branch `continuation-supervisor-development`. It is not yet a formal release. Upstream YOLO `v1.1.0` remains the clean baseline and does not contain the Continuation Supervisor changes.

Do not represent this candidate as bypassing ChatGPT subscription, model, rate, usage, access, or safety limits. Provider-limit surfaces pause the workflow.

## Build and load

```bash
git clone https://github.com/axelisaac-coding/chatgpt-yolo.git
cd chatgpt-yolo
git switch continuation-supervisor-development
npm run check
npm run package
```

Load `dist/yolo` from `chrome://extensions` with Developer mode enabled, then open or refresh a saved ChatGPT conversation with a stable `/c/<conversation-id>` URL.

## Supervisor behavior

- `/goal <objective>` runs a persistent objective with no arbitrary total-turn ceiling while meaningful progress continues.
- `/loop [count] <objective>` remains explicitly bounded and hard-capped at 50 iterations.
- Goal continuation responses use `[YOLO:PROGRESS:<checkpoint>]` or `[YOLO:NO_PROGRESS]` so stagnation is measured from explicit evidence rather than guessed from prose.- Repeated identical responses, repeated no-progress evidence, and repeated recovery failures trip bounded circuit breakers and enter a resumable `stalled` state.
- A stable Goal response that ends without its terminal marker enters bounded recovery after a conservative quiet window; recovery tells ChatGPT to inspect durable state and not assume an interrupted operation succeeded.
- The first Goal `[YOLO:DONE]` starts completion verification. Only an evidence-based verification `[YOLO:DONE]` completes the Goal.
- Explicit provider usage/rate limits become `rate_limited`; approvals, sign-in, permissions, and confirmation surfaces outside configured automation policy become `human_required`.
- `/status` exposes phase, continuation/iteration count, progress presence, circuit-breaker counters, reason, queue, runner, generation, profile, session actions, and last action.

## Safety and reliability

YOLO keeps the upstream durable queue, exact user-message delivery receipts, sender leases, cross-tab side-effect guards, optimistic workflow revisions, draft protection, route identity checks, fail-closed ambiguous delivery, and bounded retained storage/history.

Approvals remain off by default. A queued workflow never replaces text already present in the ChatGPT composer.

This extension automates a third-party web interface whose DOM can change without notice. Automated tests cannot prove current live ChatGPT selector compatibility, so this candidate requires a manual unpacked-extension smoke pass and long-duration browser testing before release.

## Privacy

Settings, queues, templates, and workflow state are stored in `chrome.storage.local`. The extension has no hosted backend, telemetry, or remote code. Queued prompts are sent through the ordinary ChatGPT composer.

## License and attribution

This fork remains licensed under the MIT License and preserves the original YOLO copyright and notices. See `LICENSE` and `NOTICE.md`.