# Validation

## Local checks (2026-09-16)

- `npm run build`: TypeScript and main/preload/CLI/renderer bundles passed.
- `npm test`: core/API/CLI tests pass; coverage includes persistence, rollback, validation, task ordering/cancellation/failure/recovery, confirmed deletion sequencing, HTTP auth/origin/host/size checks, token rotation and real CLI-to-HTTP calls.
- This build container cannot launch a full Electron desktop. The separate desktop gate is configured for Linux/Xvfb CI.

## Desktop integration gate

`tests/desktop.mjs` uses real Electron with deterministic HTTPS fixtures. It checks actual UI account creation, two-account Cookie/LocalStorage isolation, no privileged remote bridge, sandbox/context isolation, draft and submitted prompts, profile/last-page restart persistence, account cleanup, API setting persistence and clean shutdown. Screenshots go to `test-results/` and CI artifacts. No live credentials or prompts are used.

## Manual acceptance

On a normal desktop, sign in to two real accounts, switch and restart, try downloads/new conversations, and submit a test prompt. Check each intended OAuth provider. Offline tests cannot establish login-provider restrictions, anti-bot challenges, or compatibility with a changed ChatGPT DOM. Production signing/notarization requires publisher credentials.
