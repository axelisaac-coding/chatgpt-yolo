# YOLO for ChatGPT - Continuation Supervisor v1.2.0 release candidate

This fork extends the MIT-licensed YOLO for ChatGPT Chromium extension with persistent, progress-aware supervision for long ChatGPT projects, including safe migration into successor conversations. It uses the ordinary ChatGPT browser UI and does not require the OpenAI API, a second hosted AI, or a local model.

## Candidate status

This is the `v1.2.0` release candidate from `axelisaac-coding/chatgpt-yolo`, branch `continuation-supervisor-development`. It is **not a formal release until authenticated live qualification passes for this exact packaged runtime digest**.

Upstream YOLO `v1.1.0` remains the clean baseline. Attribution and license notices are preserved in `LICENSE` and `NOTICE.md`.

YOLO does not bypass ChatGPT subscription, model, rate, usage, access, context, or safety limits. Provider-limit and human-required surfaces pause automation.

## Build and load

```bash
git clone https://github.com/axelisaac-coding/chatgpt-yolo.git
cd chatgpt-yolo
git switch continuation-supervisor-development
npm run check
npm run package
npm run live:digest
```

Load only `dist/yolo` from `chrome://extensions` with Developer mode enabled. Disable other unpacked YOLO copies first, then open or refresh a saved ChatGPT conversation with a durable `/c/<conversation-id>` URL.

## Supervisor behavior

- `/goal <objective>` runs a persistent objective while meaningful progress continues; `/loop [count]` remains explicitly bounded.
- Productive Goal turns record explicit progress evidence and use bounded recovery, stagnation detection, and completion verification.
- Hard conversation/context exhaustion is classified separately from provider/rate limits. The exhausted source becomes permanently `doNotContinue` and receives no further automatic prompt.
- Proactive rollover uses observable message/text growth and durable continuation count only; it never invents a context percentage.
- A proactive source generates and independently verifies a semantic handoff while still usable. Hard exhaustion can safely take over an unfinished proactive attempt.
- Successor creation uses ChatGPT's real **New Chat** control. YOLO never fabricates a `/c/...` route.
- Bootstrap intent is persisted before composer mutation. Successor binding requires the exact bootstrap user-message receipt on a different durable route plus a token-bound assistant verification marker.
- The old source is retired before normal Goal work resumes in the successor. Ambiguous delivery fails closed and is never automatically resent.
- Project identity and ordered conversation lineage survive service-worker restart and repeated A->B->C->D migration.

## Safety and reliability

YOLO keeps durable queue ownership, exact user-message delivery receipts, sender leases, cross-tab side-effect guards, optimistic revisions, draft protection, route identity checks, bounded retained state, and fail-closed ambiguous delivery. Approvals remain off by default, and queued automation never replaces existing composer text.

This extension automates a third-party web interface whose DOM can change without notice. Automated tests prove deterministic state-machine behavior but cannot substitute for current-site authenticated qualification.

## Release qualification

Prepare the final runtime with `npm run package`, then run `npm run live:digest`. Perform the authenticated cross-conversation test in `docs/CONTINUATION_SUPERVISOR_TESTING.md` and record the result in `docs/CONTINUATION_SUPERVISOR_LIVE_QUALIFICATION.json` using the supplied example as the schema guide.

`npm run validate:live` must pass against the exact packaged digest. Tagged GitHub releases enforce this gate automatically; normal development validation does not require a live receipt.

## Privacy

Settings, queues, templates, project lineage, and workflow state remain in `chrome.storage.local`. The extension has no hosted backend, telemetry, or remote code. Queued prompts are sent through the ordinary ChatGPT composer.

## License and attribution

This fork remains licensed under the MIT License and preserves the original YOLO copyright and notices. See `LICENSE` and `NOTICE.md`.
