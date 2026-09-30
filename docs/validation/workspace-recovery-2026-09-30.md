# Empty account view after an unexpected exit — 2026-09-30

Version: 1.4.19.

## Evidence on the affected device

The existing database passed SQLite integrity checks. All three account records,
eight saved tabs, and 200 task records were readable. The browser profile
directories were present. No account records or browser profiles were recreated,
deleted, or replaced during this investigation.

The running instance had not refreshed its local API discovery file and its
backend was unavailable. A complete isolated Electron startup with a consistent
database copy restored all accounts and tabs. Restarting the installed client
using the original data directory restored the same accounts, tabs and tasks;
two tasks resumed execution. The earlier exit had no usable application error
log or matching Windows Application crash event, so its cause remains unknown.
This is evidence of a failed startup, not evidence that the accounts were lost.

## Changes

- The renderer distinguishes an unread state from an empty account list. It
  shows loading or a persistent read error, retries automatically, and does not
  offer empty-account onboarding until a successful state read.
- Failed reads preserve previously loaded account state. Status calls have a
  bounded timeout; retries run sequentially and stop when state is restored.
- A crashed local workspace renderer reloads without replacing account pages
  or changing persisted queues. Repeated crashes within one minute have a
  recovery budget to avoid a tight crash loop.
- Local lifecycle records identify startup stages, incomplete previous exits,
  deliberate shutdown, uncaught error codes/source locations, and child or
  workspace renderer termination. Logs are bounded and rotated; logging
  failures do not stop the client. Prompts, URLs, account IDs, cookies, tokens,
  and exception messages are excluded. Nothing is uploaded.

## Validation

- Typecheck and production build passed.
- 115 core tests and one release-manifest test passed.
- New diagnostics tests cover clean/incomplete exits, omission of exception
  messages and private paths, rotation and an unwritable log directory.
- New `workspace-recovery-desktop.mjs` uses an isolated Electron profile: three
  saved accounts, repeated status failures, automatic retry, forced renderer
  crash/reload, and preservation of tab IDs and a paused queued message.
- Existing queue restart desktop test passed: acknowledged busy generation
  resumes observation, and the following message sends exactly once.
- npm audit found zero vulnerabilities.

The isolated crash test verifies recovery behavior; it does not establish that
the user's earlier exit was a renderer crash. Raw databases, browsing profiles,
and diagnostic captures remain local and are not part of this change.

## Installed verification

Installed and launched 1.4.19 with the original profile. Startup reached `ready`
with the local API available. Compared account records and all eight tab IDs
against the pre-install snapshot: unchanged. The live database again passed
integrity checks, contained 200 task records, and two tasks resumed generation
observation. No new test conversations were sent to the user's accounts.

Installed `app.asar` matches the packaged artifact: SHA256
`1EEDBD6B66B02AE3A9A457CEF5A2804BF4A9E53E58EB1A25BE120681D0BD3857`.
