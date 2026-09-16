# Validation

## Local checks (2026-09-16)

- `npm run build`: TypeScript and main/preload/CLI/renderer bundles passed.
- `npm test`: 10 core/API/CLI tests pass; coverage includes persistence, rollback, validation, task ordering/cancellation/failure/recovery, confirmed deletion sequencing, HTTP auth/origin/host/size checks, token rotation and real CLI-to-HTTP calls.
- Linux unpacked application packaging passed using the installed Electron distribution: `npm exec electron-builder -- --dir --config.electronDist=node_modules/electron/dist`.
- This build container cannot launch a full Electron desktop. The separate desktop gate is configured for Linux/Xvfb CI.
- [Initial GitHub CI run](https://github.com/chenziyang110/ChatGPT-Web-Client/actions/runs/35055308476) failed before any steps ran: all four jobs have an empty step list and no assigned runner. Job logs are unavailable (404). The exposed result does not identify the root cause; desktop integration and macOS/Windows packaging are **not verified**. Check repository Actions availability/settings and rerun once runners can start.

## Desktop integration gate

`tests/desktop.mjs` uses real Electron with deterministic HTTPS fixtures. It checks actual UI account creation, two-account Cookie/LocalStorage isolation, no privileged remote bridge, sandbox/context isolation, draft and submitted prompts, profile/last-page restart persistence, account cleanup, API setting persistence and clean shutdown. Screenshots go to `test-results/` and CI artifacts. No live credentials or prompts are used.

## Manual acceptance

On a normal desktop, sign in to two real accounts, switch and restart, try downloads/new conversations, and submit a test prompt. Check each intended OAuth provider. Offline tests cannot establish login-provider restrictions, anti-bot challenges, or compatibility with a changed ChatGPT DOM. Production signing/notarization requires publisher credentials.
