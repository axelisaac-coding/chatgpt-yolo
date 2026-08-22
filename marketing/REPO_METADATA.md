# Repository metadata — YOLO for ChatGPT

## Final description

```
Local-first Chrome extension for reliable queues and bounded workflows in long ChatGPT conversations. Open source, no telemetry.
```

Length: 128 characters (GitHub limit is 350). Contains the required keywords: Chrome extension, queues, bounded workflows, ChatGPT, local-first, no telemetry.

## Final topics (13)

```
chatgpt
chatgpt-extension
chrome-extension
browser-extension
manifest-v3
javascript
productivity
workflow-automation
automation
local-first
privacy
open-source
developer-tools
```

## Website / homepage

Leave blank. The GitHub repository is the canonical destination.

## Social preview

Upload `docs/assets/social-preview.png` (1280 × 640 PNG, < 1 MB) at **Settings → General → Social preview**. Committing the file alone does not update GitHub's Open Graph image.

## Exact `gh` commands

If you have `repo` scope on `axelisaac-coding/chatgpt-yolo`:

```bash
# Description
gh repo edit axelisaac-coding/chatgpt-yolo \
  --description "Local-first Chrome extension for reliable queues and bounded workflows in long ChatGPT conversations. Open source, no telemetry."

# Topics
gh repo edit axelisaac-coding/chatgpt-yolo \
  --add-topic chatgpt \
  --add-topic chatgpt-extension \
  --add-topic chrome-extension \
  --add-topic browser-extension \
  --add-topic manifest-v3 \
  --add-topic javascript \
  --add-topic productivity \
  --add-topic workflow-automation \
  --add-topic automation \
  --add-topic local-first \
  --add-topic privacy \
  --add-topic open-source \
  --add-topic developer-tools

# Website (must remain blank)
gh repo edit axelisaac-coding/chatgpt-yolo --homepage ""
```

## Sponsor button

Confirm that `.github/FUNDING.yml` is present and that **Settings → Sponsorships → Sponsor button** is enabled. The button links to `https://whop.com/vex-app/support-for-oss/`. Do not change the funding destination.

## Release artifact

After pushing tag `v1.2.0`, the `release.yml` workflow builds `yolo-v1.2.0.zip`, generates a SHA-256 checksum, and produces a GitHub artifact attestation. Verify before announcing:

```bash
gh attestation verify yolo-v1.2.0.zip --repo axelisaac-coding/chatgpt-yolo
```

## Recommended repository settings to verify

- **Settings → General → Social preview**: upload `docs/assets/social-preview.png`.
- **Settings → Code security and analysis**:
  - Dependabot alerts: enabled.
  - Dependabot version updates: enabled (`.github/dependabot.yml` is pinned to `github-actions` only).
  - Secret scanning: enabled.
  - Private vulnerability reporting: enabled.
- **Settings → Branches → Branch protection for `main`**:
  - Require a pull request before merging.
  - Require status checks to pass before merging: `CI`, `CodeQL`, or any check from the pinned, full-SHA workflows.
  - Restrict who can push: owners + Devin bot or required reviewers.
- **Settings → Actions → General**:
  - Allow only select actions: restrict to GitHub-owned actions and full-SHA pinned third-party actions.
  - Require approval for all outside collaborators.

## What not to change

- Visibility, merge settings, branch protection, issue settings, discussions, Actions permissions, security settings, repository name, or default branch.
