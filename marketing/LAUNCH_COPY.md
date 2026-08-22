# Launch copy — YOLO for ChatGPT

## Recommended X launch post (≤ 280 characters)

ChatGPT is great at long tasks—until you have to keep nudging it. I built YOLO, a free open-source Chrome extension that adds a durable prompt queue and bounded workflows to ChatGPT. Queue the next steps and stay in control.

github.com/axelisaac-coding/chatgpt-yolo

## X reply thread

Reply 1 — Install from the release:

Install from the v1.2.0 release:
1. Download yolo-v1.2.0.zip from github.com/axelisaac-coding/chatgpt-yolo/releases/tag/v1.2.0
2. Optional: gh attestation verify yolo-v1.2.0.zip --repo axelisaac-coding/chatgpt-yolo
3. Unzip and load `yolo` at chrome://extensions (Developer mode).

Reply 2 — Or build from source:

Or build from source:
git clone https://github.com/axelisaac-coding/chatgpt-yolo.git
cd chatgpt-yolo
npm run validate:core && npm run package
Then load `dist/yolo` unpacked at chrome://extensions.

Reply 3 — Privacy and scope:

YOLO's settings, queues, templates, and workflow state stay in `chrome.storage.local`. YOLO has no hosted backend and no telemetry. It only manages your prompt queue and bounded `/goal` or `/loop` workflows inside ChatGPT.

Reply 4 — Sponsor and bug reports:

If YOLO saves you time, the repo has a Sponsor button—one-time $5, $10, or $20 helps fund maintenance. Bugs: open a GitHub issue with steps and your browser/OS version. github.com/axelisaac-coding/chatgpt-yolo/issues

## Shorter punchier alternative

Stop babysitting long ChatGPT tasks. YOLO queues the next steps and runs bounded workflows right inside the conversation. Open source, local-first, no telemetry.

## Technical / open-source alternative

YOLO is a local-first, MIT-licensed Chrome extension that adds a durable instruction queue and bounded `/goal` / `/loop` workflows to ChatGPT. YOLO's settings, queues, templates, and workflow state stay in `chrome.storage.local`; YOLO has no hosted backend, no telemetry, and no remote code. If you want deterministic control over long, iterative prompts, it is built for you.

## Hacker News title and submission text

Title: `Show HN: YOLO for ChatGPT – a local-first queue for long conversations`

Text: ChatGPT is great at long tasks until you keep returning to nudge it forward. YOLO is a local-first Chrome extension that adds a persistent prompt queue, `/goal` / `/loop` workflows, and visible Pause/Edit/Stop controls to ChatGPT. No backend, no telemetry, MIT licensed. Would love feedback from anyone running long iterative sessions.

## Product Hunt–style one-liner

YOLO for ChatGPT: a reliable prompt queue and bounded workflows for long ChatGPT conversations.

## LinkedIn version

Long ChatGPT tasks shouldn’t need you to keep coming back to say “continue.” I built YOLO, an open-source Chrome extension that adds a persistent instruction queue and bounded workflows to ChatGPT, so you can queue the next steps and stay in control. Local-first, no telemetry.

## Reddit version

I made a free, open-source Chrome extension called YOLO for ChatGPT. It lets you queue follow-up instructions and run bounded `/goal` or `/loop` workflows so you don’t have to babysit long ChatGPT sessions. YOLO's settings, queues, templates, and workflow state stay local in `chrome.storage.local`; YOLO has no hosted backend and no telemetry.

## Repository description

Local-first Chrome extension for reliable queues and bounded workflows in long ChatGPT conversations. Open source, no telemetry.

## Release description

YOLO for ChatGPT v1.2.0 — local-first Chrome extension for reliable instruction queues and bounded workflows in long ChatGPT conversations. Download `yolo-v1.2.0.zip`, unzip it, and load the `yolo` folder as an unpacked extension.

## Suggested repository pinned-profile description

YOLO for ChatGPT — queue the next steps and run bounded workflows in long ChatGPT conversations. Local-first, open source, no telemetry.

## Sponsor follow-up

If YOLO saves you time, there’s also a Sponsor button on the repo—one-time $5, $10, or $20 genuinely helps fund ongoing maintenance. Totally optional; the extension stays free and open source.

## Video alt text

Screen demo of the YOLO Chrome extension queuing next steps and running a bounded, four-iteration workflow inside a ChatGPT conversation, then pausing on user control.

## Image alt text

- `hero.webp`: YOLO for ChatGPT — a persistent instruction queue running alongside a long ChatGPT conversation.
- `social-preview.png`: YOLO for ChatGPT — queue the next steps. Local-first, open source, no telemetry.
- `screenshot-queue.webp`: Per-conversation queue with several ordered instructions and a live queue count.
- `screenshot-command-palette.webp`: YOLO command palette showing `/goal`, `/loop`, `/review`, and `/continue` in the ChatGPT composer.
- `screenshot-workflow.webp`: Bounded workflow showing objective, iteration state, and Pause, Edit, and Stop controls.
- `screenshot-github-workflow.webp`: ChatGPT with the GitHub app connected while YOLO manages the queued follow-up prompts.
- `screenshot-settings.webp`: Advanced settings showing profiles, approvals off by default, recovery, and local data controls.
