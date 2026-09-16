# Roadmap

## Implemented in v0.2

- [x] Electron/React/TypeScript foundation and compiled main/preload/CLI
- [x] Locked dependencies and development/build/package commands
- [x] Isolated profiles, account creation/rename/switch/delete
- [x] SQLite metadata, active account/page/window restoration
- [x] Bounded task queue, results, cancellation, crash recovery
- [x] Authenticated HTTP API, validated IPC, JSON CLI
- [x] Generic CLI/HTTP integration for AnythingCLI and other tools
- [x] Browser navigate/snapshot/fill/click and draft/submit tasks
- [x] Core/API/CLI tests and offline Electron integration test
- [x] Three-platform CI/build/package configuration

## Release acceptance

- [ ] Live login and third-party OAuth on each target OS
- [ ] Live prompt automation against the current ChatGPT DOM
- [ ] Signed/notarized installers and production update channel

These require a real login/desktop environment or publisher credentials. Offline fixtures do not verify third-party service behavior.

## Future extensions in product requirements

MCP, plugin discovery/permissions, multiple AI providers, expanded browser adapters, and opt-in microphone/camera permissions UI.
