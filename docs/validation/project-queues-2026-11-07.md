# Existing project conversation queues — 2026-11-07

## Failure and change

The v1.4.37 screenshot shows an ordinary ChatGPT composer inside an existing project conversation at `/g/g-p-<project-and-slug>/c/<conversation>`. The registration and reply URL guards only accepted `/c/<id>` and `/dots/<id>`, so the panel rejected this page before creating a task. An additional ReplyReader canonical-route check would have prevented completion if only registration were broadened.

A shared, self-contained path parser now accepts existing `g-p-` project chat routes. Registration, live reply matching, read-only receipt recovery and semantic conversation-load failure detection use that parser. Full project paths are retained. Remote identities use `project:<full-project-token>:<conversation-id>` to isolate projects, plain chats and accounts. No database migration or credential/profile changes are required.

Project homepages, arbitrary `/g/project/...`, custom GPTs, shared/temporary conversations, foreign origins and encoded separators remain unsupported. A new ordinary-home conversation cannot silently bind to a project after sending. Project slugs are retained as part of the exact destination; renamed routes require explicitly selecting/registering the new destination. Agent handoff's default selection behavior is outside this queue fix.

## Evidence

- Before the fix, project registration and reply recovery tests reproduced the screenshot's rejection (two failing positive tests, one passing rejection-boundary test).
- Production build and TypeScript checks passed.
- Full core suite passed: 201 TypeScript cases plus the release-manifest test. The subsequent receipt recovery parameterization passed both plain and project destinations, asserting inspect-only recovery and zero fill/send operations.
- `project-queue-desktop.mjs` passed with the production Electron runtime: UI registration from a previously unregistered screenshot-shaped URL, two native FIFO sends, complete URL preservation, same trailing ID in different projects/plain routes/accounts, real process restart, preserved explicit pause, no replay of completed sends, and separate sibling/account delivery.
- `page-operation-desktop.mjs` passed, including project conversation-load failure detection and rejection of project home recovery.
- `conversation-queue-desktop.mjs` passed ordinary Chat keyboard/IME, editing, sorting, pause/resume, background FIFO and virtualized history regressions.
- `agent-target-desktop.mjs` passed the existing unsupported-route and friendly-error coverage.
- Independent read-only review found no blocking issue in routing, sandbox serialization or receipt/completion isolation.
- Full dependency audit reported zero vulnerabilities. Whitespace/diff checks passed.

All runtime checks used isolated temporary profiles and owned offline documents; no test messages were sent through the user's logged-in accounts. This records local source validation, not a published installer or live ChatGPT project compatibility guarantee.

## Windows-only v1.4.38 packaging

At the user's request the release is limited to Windows x64 and ARM64. Both NSIS installers were built locally with electron-builder. Both unpacked applications report v1.4.38, include production main/preload code matching the built files, and contain Electron and Go Agent executables with the expected PE machine architecture. ARM64 is a cross-build, not a native ARM hardware run.

The Windows-only manifest mode passed missing/empty/extra-artifact rejection tests while retaining the default full-platform gate. The isolated publishing directory contains exactly two architecture-specific exe files, two Windows update manifests and SHA256SUMS.txt with four entries. Full dependency audit remains zero, Go tests and the production build passed. No six-platform cloud release is claimed; other platforms retain v1.4.37.
