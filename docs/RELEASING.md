# Releasing

## Automated development gate

1. Update `CHANGELOG.md` and ensure `config.js`, `manifest.json`, and `package.json` use the same version.
2. Run `npm run validate:core` on Node 20 or newer.
3. Confirm `npm run verify:extension` reports the narrow public-extension boundary.
4. Review the `manifest.json` diff explicitly. New hosts, permissions, optional permissions, remote code, or non-extension runtime surfaces require separate architecture/security review.
5. Run `npm run package` and inspect the exact files under `dist/yolo`.
6. Run `npm run live:digest` and record the canonical packaged-runtime digest used for authenticated qualification.

The package allowlist must never include tests, repository metadata, development scripts, local daemons, CLIs, agent integrations, native-messaging hosts, credentials, diagnostics dumps, or broad host permissions.

## Manual unpacked-extension smoke pass

Load only `dist/yolo` through `chrome://extensions` in a current Chromium browser. Disable other unpacked YOLO copies first. Verify:

- onboarding opens and does not enable automation by itself;
- popup queue add/edit/reorder/remove/pause/send-next behavior;
- a saved `/c/...` conversation owns a durable queue;
- a transient chat fails closed for ordinary durable automatic delivery;
- an existing composer draft is never replaced;
- `/goal` and `/loop` stop on malformed/missing terminal markers;
- pause/resume/stop/retry/runtime reset behave predictably;
- route changes and refreshes do not duplicate queued instructions;
- two tabs for one conversation do not perform the same side effect;
- settings/templates/backup/diagnostics/reset and accessible appearance remain usable;
- service-worker and browser restart recover durable state.

## Authenticated cross-conversation qualification

For `v1.2.0`, the single-conversation smoke pass is necessary but not sufficient. Run the exact Phase F procedure in `docs/CONTINUATION_SUPERVISOR_TESTING.md` against the packaged runtime whose digest was recorded above.

Create `docs/CONTINUATION_SUPERVISOR_LIVE_QUALIFICATION.json` from the supplied example only after every required observation is actually seen in the authenticated browser. Record the browser/version, tested runtime digest, candidate commit, UTC timestamp, and all required boolean results.

Then run:

```bash
npm run validate:live
```

This command repackages the extension, recomputes the canonical runtime digest, and rejects stale/incomplete evidence. Tagged GitHub releases run the same live-evidence verifier automatically. Ordinary development validation deliberately does not require the receipt.

## Publish

1. Commit the successful live receipt without changing packaged runtime files.
2. Re-run `npm run validate:core` and `npm run validate:live` from the exact release head.
3. Merge only the reviewed exact head after required checks pass.
4. Tag the verified commit as `v1.2.0` and push the tag.
5. Let the release workflow reproduce the package, enforce the live receipt, generate SHA-256 output, attest the archive, and create the GitHub Release.
6. Download the generated archive and verify its checksum and attestation before announcement.

```bash
gh attestation verify yolo-v1.2.0.zip --repo axelisaac-coding/chatgpt-yolo
```

Chrome Web Store distribution should follow a stable public beta, a current policy/terms review, complete store disclosures, and a repeatable selector-regression response process. GitHub releases remain the source-of-truth artifacts.
