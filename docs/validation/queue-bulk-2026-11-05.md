# Queue clearing and repeated Dot groups — 2026-11-05

The conversation queue header can clear its own unstarted items after confirmation. Running tasks, send intents, unresolved review items and other conversations are preserved. Cancellation records and idempotency keys remain durable. Task waiters are notified only after the cancellation transaction commits.

Dot's optional line-splitting mode treats each non-empty trimmed line as a prompt. A custom repetition count repeats the entire ordered list, so four lines ×10 creates forty independent queue items in ten rounds. The UI previews the number of prompts and total entries. Enter inserts a line; Ctrl/Command+Enter enqueues. Ordinary mode preserves multiline prompts as one message. Mode and repetition selections are isolated by account/conversation during the app session. Each atomic submission is bounded to 1000 entries without imposing a total queue capacity.

## Validation

- Production build and TypeScript checks passed.
- `npm test` passed: 198 TypeScript tests and the release-manifest test.
- Final changes passed all 39 Dot repetition, interval and conversation queue core tests. New regressions cover arbitrary ordered groups, lost responses, restart/idempotency, validation, failed-write rollback, cross-account clearing boundaries, retained running/review tasks, and cancelled batch replay.
- A failed-clear regression first reproduced premature task-waiter cancellation. After deferring waiter notification until commit, the same assertion passed, along with successful-clear waiter delivery.
- Final production build passed `node tests/dot-repeat-desktop.mjs`: four custom lines ×10, blank-line filtering, ordinary multiline preservation, Enter/Ctrl+Enter behavior, per-conversation settings, clear confirmation/Escape, preservation of sibling queues, four actual native sends ordered A/B/A/B, distinct receipts, intervals, restart, and persisted batch-key replay.
- Final production build passed `node tests/conversation-queue-desktop.mjs`: ordinary Chat keyboard/IME, drafts, edit/reorder, pause/resume, responsive bounds, background FIFO and virtualized conversation history.
- `npm audit --json` reported zero vulnerabilities across all dependency categories.
- `git diff --check` passed.

Desktop checks used isolated temporary profiles and owned offline webpage fixtures with the production Electron runtime and native editor/send operations. No business messages were submitted to logged-in production accounts. This change was built locally; it has not been released.
