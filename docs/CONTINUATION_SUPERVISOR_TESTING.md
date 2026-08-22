# Continuation Supervisor browser-test protocol

This protocol validates the development fork against the current live ChatGPT interface before any formal release. It complements unit/regression tests; it does not replace them.

## Candidate preparation

1. Start from a clean `continuation-supervisor-development` checkout at the exact candidate commit.
2. Run the non-environmental regression suite, `npm run check`, `npm run verify:extension`, `npm run package -- --check` when applicable, the no-bare-installs policy, and `git diff --check`.
3. Run `npm run package` and hash the exact packaged candidate.
4. Load only the generated `dist/yolo` directory using Chromium Developer mode.
5. Record browser version, candidate commit, candidate SHA-256, test date/time, and whether another installed YOLO copy was disabled.

## Test prerequisites

- Use a saved ChatGPT conversation with a stable `/c/<conversation-id>` URL. Durable automation intentionally does not run on transient new-chat routes.
- Use a disposable test conversation/objective, not irreplaceable production work, until basic selector and delivery smoke tests pass.
- Keep approvals disabled for the first pass.
- Do not deliberately manufacture or circumvent provider usage/rate limits. Validate a naturally occurring limit only if one appears.
- Preserve screenshots/log notes for failures without copying secrets or unrelated conversation content.

## Basic live-interface smoke test

1. Confirm the popup opens and reports the expected conversation.
2. Confirm `/` in an empty composer opens the command palette.
3. Confirm `Ctrl/Cmd + Shift + P` opens the palette without corrupting composer text.
4. Queue a harmless message and verify one exact user-message receipt appears, with no duplicate send.
5. Put draft text in the composer and verify automation refuses to overwrite it.
6. Navigate to another conversation and verify route identity prevents cross-conversation delivery.## Persistent Goal progression

1. Start `/goal` with a harmless multi-step objective.
2. Verify the first prompt reaches ChatGPT exactly once.
3. Confirm productive Goal responses emit a progress marker followed by `[YOLO:CONTINUE]`.
4. Confirm the compact workflow chrome reports `continuation N`, not `iteration N/0`.
5. Open `/status` and verify phase, progress presence, circuit-breaker counters, queue, runner, generation, and reason are coherent.
6. Let several productive continuations run and confirm no arbitrary 50-turn cap is exposed by Goal state.

## Restart and ownership resilience

Repeat a productive Goal while introducing each condition separately:

- refresh the ChatGPT page;
- close and reopen the ChatGPT tab;
- allow the Manifest V3 service worker to become idle, then resume activity;
- restart the browser and reopen the same saved conversation;
- open the same conversation in two tabs and confirm only one workflow runner owns continuation at a time;
- manually send a different user prompt and confirm workflow ownership fails closed rather than hijacking the conversation.

After every restart, verify workflow status, objective, counters, phase, and queued/pending ownership are recovered from durable state rather than reconstructed from assumptions.

## Missing-marker and interrupted-turn recovery

Use a controlled test response that intentionally omits the terminal YOLO marker after producing visible work. After the conservative quiet window:

1. Confirm Goal enters recovery rather than ordinary continuation.
2. Confirm the recovery prompt explicitly instructs ChatGPT to inspect actual durable state and not assume the interrupted operation completed.
3. Confirm recovery uses the normal durable queue and produces one exact user-message receipt.
4. Confirm a valid later control marker resets consecutive recovery attempts.
5. In a disposable test, repeat missing-marker recovery until the configured recovery threshold and verify the Goal enters `stalled` rather than looping forever.## Stagnation and progress evidence

1. Produce the same assistant response repeatedly and verify repeated-response protection reaches `stalled` at the configured threshold.
2. Produce changing prose while reusing the same `[YOLO:PROGRESS:<checkpoint>]` evidence and verify the no-progress counter advances.
3. Emit `[YOLO:NO_PROGRESS]` repeatedly and verify the no-progress threshold stalls the Goal.
4. Emit a genuinely new progress evidence id and verify the no-progress sequence resets.
5. Confirm missing progress evidence is treated neutrally for backward compatibility rather than guessed as failure.

## Completion verification

1. Have ordinary Goal work report `[YOLO:DONE]` before the objective is actually complete.
2. Verify the workflow enters `verification` instead of `completed`.
3. Confirm the verification prompt asks ChatGPT to inspect durable project evidence, unresolved errors/TODOs, tests, artifacts, and the original objective.
4. Return `[YOLO:CONTINUE]` from verification and verify normal work resumes.
5. Repeat with a genuinely complete disposable objective; verify only verification `[YOLO:DONE]` produces `supervisor.completed.verified`.
6. Exercise malformed/missing verification responses and verify retries are bounded before `stalled`.

## External stop conditions

- If a real ChatGPT usage/rate/model limit naturally appears, verify the workflow becomes `rate_limited` and sends no continuation intended to bypass the limit.
- Present an approval or confirmation outside the configured automatic approval policy and verify `human_required`.
- After resolving the external condition manually, use Resume and verify the same durable workflow continues.
- Verify ordinary transient ChatGPT errors remain handled by the existing error-recovery path rather than being mislabeled as provider limits.

## Failure and network resilience

Test temporary network loss, a visible ChatGPT retry/error surface, a delivery acknowledgement interruption, and a route change during queued delivery. Verify ambiguous delivery fails closed and never causes duplicate submission. Record the exact stop reason and recovery behavior.## Long-duration endurance run

Use a real saved test conversation for a long project representative of the intended unattended workflow. The target is approximately 15 hours of elapsed project time, not a synthetic claim that the extension can exceed provider/account limits.

During the run, periodically record: continuation count, phase, last progress evidence presence, circuit-breaker counts, queue length/state, runner ownership, browser/tab restarts, recovery events, provider/human stops, and any manual intervention.

Success requires:

- no duplicate queued prompts;
- no cross-conversation delivery;
- no lost durable workflow after ordinary refresh/browser restart;
- no arbitrary total Goal-turn ceiling;
- recovery only after a genuinely stable abnormal ending;
- bounded stagnation/recovery/verification behavior;
- no automated bypass of provider or human-required stops;
- verified completion rather than premature completion;
- bounded retained state/history and acceptable browser responsiveness.

Any failure should be reproduced with the smallest deterministic fixture possible before changing production selectors or safety thresholds.

## Release gate

Do not promote the candidate to a formal release until the smoke matrix passes against the current ChatGPT UI and the long-duration run produces no unresolved reliability or safety defect. If a live-browser test cannot be executed in the available environment, record that as an external validation blocker rather than treating unit tests as equivalent evidence.