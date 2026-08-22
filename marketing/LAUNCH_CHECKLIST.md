# Launch checklist — YOLO for ChatGPT

This is the exact sequence for Kartik to publish the launch once the final PR is merged.

## Before merge

- [ ] Review the final PR diff.
- [ ] Confirm `npm run validate:core` passes on the PR head.
- [ ] Confirm `npm run validate:assets` passes on the PR head (if the marketing asset tree changed).
- [ ] Confirm the README install path points to the verified `v1.2.0` release archive with `gh attestation verify`.
- [ ] Confirm the GitHub-app section wording is acceptable.
- [ ] Confirm sponsor copy matches the live Whop page.

## Merge and live smoke test

- [ ] Merge the PR into `main` and record the merge commit SHA shown by GitHub (do not assume `origin/main` will stay at that SHA).
- [ ] Pull the recorded merge commit locally and run a full live smoke test from a source build:
  ```bash
  git fetch origin
  git checkout <recorded-merge-sha>
  npm run validate:core && npm run package
  ```
  - Load the `dist/yolo` extension unpacked at `chrome://extensions` (Developer mode → Load unpacked).
  - Open `https://chatgpt.com` and confirm the YOLO popup mounts.
  - Add prompts to the queue, reorder them, and send; confirm they execute in order.
  - Type in the composer and verify draft protection never overwrites user text.
  - Open the command palette (`/goal` or `/loop`) and confirm it invokes and bounds a workflow.
  - Run a `/loop` workflow, then pause, resume, and stop it; confirm each state transition.
  - Open the options page and verify settings persist across reload.
  - Confirm no errors in the background service-worker console or the ChatGPT page console.
  - Verify one ambiguous/fail-closed path: e.g., stop a workflow and confirm no further queue sends occur.
- [ ] If the smoke test fails, do **not** tag; open a follow-up issue and fix before release.

## Pre-tag release dry-run

- [ ] Trigger the `release.yml` workflow via `workflow_dispatch` on `main` at the reviewed merge commit and confirm the build, artifact upload, and attestation steps succeed. Because this is not a tag push, the publish job remains skipped.
- [ ] Download the `yolo-extension` artifact from the dry-run and unzip it:
  ```bash
  gh run download <run-id> -n yolo-extension -D /tmp/yolo-dry-run
  unzip /tmp/yolo-dry-run/yolo-v1.2.0.zip -d /tmp/yolo-dry-run/unpacked
  sha256sum /tmp/yolo-dry-run/yolo-v1.2.0.zip
  gh attestation verify /tmp/yolo-dry-run/yolo-v1.2.0.zip --repo axelisaac-coding/chatgpt-yolo
  ```
- [ ] Load `/tmp/yolo-dry-run/unpacked/yolo` as an unpacked extension and repeat the smoke test on the **release ZIP itself** before tagging.

## Tag and release

- [ ] Only after both smoke tests pass, tag the exact recorded merge commit SHA:
  ```bash
  git tag v1.2.0 <recorded-merge-sha>
  git push origin v1.2.0
  ```
- [ ] The `release.yml` workflow will build `yolo-v1.2.0.zip`, generate `SHA256SUMS`, create the GitHub release, and attest the artifact.
- [ ] Download the final `yolo-v1.2.0.zip` from the release and verify again:
  ```bash
  gh release download v1.2.0 --pattern '*.zip'
  sha256sum yolo-v1.2.0.zip
  gh attestation verify yolo-v1.2.0.zip --repo axelisaac-coding/chatgpt-yolo
  ```

## Repository metadata (manual or `gh repo edit`)

Run the commands in `marketing/REPO_METADATA.md`, or update via the GitHub web UI:

- [ ] Description: `Local-first Chrome extension for reliable queues and bounded workflows in long ChatGPT conversations. Open source, no telemetry.`
- [ ] Topics: `chatgpt`, `chatgpt-extension`, `chrome-extension`, `browser-extension`, `manifest-v3`, `javascript`, `productivity`, `workflow-automation`, `automation`, `local-first`, `privacy`, `open-source`, `developer-tools`
- [ ] Website/homepage: leave blank.
- [ ] Social preview: upload `docs/assets/social-preview.png` in Settings → General → Social preview.
- [ ] Sponsor button: confirm it renders from `.github/FUNDING.yml`.

## Launch assets

- [ ] Final 16:9 MP4 downloaded from the PR / release artifacts.
- [ ] Final 1:1 square MP4 downloaded.
- [ ] Poster / first frame (`docs/assets/demo-poster.webp`) available.
- [ ] Contact sheet (`marketing/renders/contact-sheet.png`) available.

## Publish

- [ ] Post the recommended launch post on X / LinkedIn / HN / Product Hunt (do not publish the launch post before the PR is merged and the release tag is pushed).
- [ ] Pin the first reply with the install/GitHub/sponsor guidance.
- [ ] Monitor the first hour for reproducible bug reports and respond with the bug-report issue template.

## Post-launch

- [ ] Watch issue volume and selector-regression reports.
- [ ] Keep the release archive and checksums linked from the README after the first release exists.
