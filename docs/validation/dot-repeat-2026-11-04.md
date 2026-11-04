# Dot repeated queue messages — 2026-11-04

## Behavior

The Dot queue composer offers ×1, ×5, ×10 and a custom positive integer. ×10 appends ten independent copies of the prompt to the selected conversation. Every copy retains its own ID, FIFO position, edit/remove controls and send receipt. Existing interval/completion policies continue to determine when each copy sends.

The one-request bound is 1000 copies; pending queue length remains unrestricted by this bound. The selected count and unsent text remain separate for each account/conversation while the application is open. Already queued copies persist across application restarts.

`tasks.repeat` is available through desktop IPC, authenticated HTTP RPC and the generic CLI `rpc` command. The batch, sequence counter, initial countdown and request-key record commit together. Repeating the same request key returns the original batch. A changed request or cleared member history cannot recreate messages.

## Verification

- `npm run build`: passed, including type checking.
- `npm audit --json`: zero vulnerabilities across all dependencies, including development and optional dependencies.
- `npm run test:agent`: passed.
- `npm test`: 195 TypeScript tests plus one release-manifest test passed; zero failures/skips.
- `node --import tsx --test tests/dot-repeat.test.ts tests/dot-interval.test.ts tests/conversation-queue.test.ts`: 36 passed.
- `WORKSPACE_TEST_CAPTURE_UI=1 node tests/dot-repeat-desktop.mjs`: passed against the production Electron build and an isolated offline Dot fixture.
- `node tests/conversation-queue-desktop.mjs`: passed existing keyboard/IME, pinned-target, drafts, edit/reorder, pause/resume, responsive layout and FIFO checks.

The six new core tests cover exact copy counts, distinct IDs, contiguous sequence numbers, independent edits, per-operation limits without a total queue cap, account/conversation isolation, concurrent duplicate requests, conflicting keys, disk-write rollback, a closed/reopened SQLite database, cleared-history protection and timed restart behavior.

The desktop fixture verifies ×10 creates exactly ten messages, custom ×3 works with Enter, invalid values preserve the draft without creating tasks, Chat has no repeat control, and switching Dot conversations/accounts retains each count independently. Three identical multiline prompts were submitted through the native editor/send controls, then a fourth after restarting Electron. All four had different acknowledged message IDs, exactly four Send clicks, and at least 60 seconds between submissions on the accelerated main-process clock. The remaining original tasks were preserved without a burst. Repeating a persisted batch request after restart did not append tasks.

An initial desktop run exposed that the queue panel remounts on tab changes. Keeping repeat selections in the panel reset them to one; moving the per-conversation map beside the existing draft map fixed this. The final desktop run passed the original same-conversation and cross-account return assertions.

Screenshot: local ignored artifact `release/dot-repeat-ui.png`. No production account, cookie, business conversation or installed client was changed. These are pre-release Windows results; the six-target release workflow additionally runs the complete desktop suite and packaging on Windows, macOS and Linux before publishing.
