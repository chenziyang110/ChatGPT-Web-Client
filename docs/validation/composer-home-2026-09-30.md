# ChatGPT chat / Work homepage queue — 2026-09-30

Version: 1.4.20.

## Live page findings

The current ChatGPT chat homepage uses a visible rich-text editor marked with
`data-composer-markdown`, `contenteditable="true"` and `role="textbox"` inside
`form[data-composer-placement]`. Chat also retained `data-chatgpt-composer` on
the inspected account. The Work homepage did not retain that attribute and used
the accessible label “使用 ChatGPT Work”. Neither editor had `#prompt-textarea`.
Empty composers expose a voice button; after filling, the scoped submit button
has `type="submit"` and the accessible label “发送”. These observations came
from authenticated ChatGPT pages, not the offline test fixtures.

The adapter now recognizes the marked editor in either composer form and keeps
submit / stop controls scoped to that form. It does not depend on generated CSS
classes, translated placeholders, or unrelated editable fields.

## Queue readiness

The queue panel previously attempted to bind its target only once. If opened
after document load but before composer hydration, it remained disabled even
after the editor appeared. Failed checks now retry sequentially every two
seconds, clear the transient message on success, and stop on unmount, navigation
or an account / tab change. A stale response cannot bind the next selected page.
Model query parameters on normal homepages are supported; temporary chats remain
excluded because they do not supply a persistent conversation target.

## Validation

- Production build / typecheck, 115 core tests, one release-manifest test and
  Go Agent tests passed. npm audit reported zero vulnerabilities.
- The new desktop regression reproduces the initial missing-editor failure,
  then exposes the editor and verifies automatic recovery, Enter / Ctrl+Enter
  FIFO submission, a single conversation binding, account-switch cancellation,
  independent drafts, model query parameters and the temporary-chat guard.
- Page-operation coverage checks the Work form with an unrelated decoy editor,
  ensuring the intended composer alone is filled and submitted.
- The modern desktop queue scenarios passed for both Chat and Work markup,
  including delayed controls, ignored-click recovery, fill retry, terminal
  errors / interrupted replies, virtualized history and independent accounts.
- On the installed Windows client, two new short Chat prompts and two new short
  Work prompts completed in sequence. All four returned the requested test
  marker, were submitted once and needed zero retries.
- After returning to the original Windows launch context, two previously
  pending test prompts also completed automatically. The first retained its
  retry history from before the adapter fix; the second completed without retry.

Short real conversations verify the current composer and send / completion
path. They do not establish exhaustive coverage of every future webpage change,
long-running Work task or server error. Raw DOM captures, database snapshots,
account IDs, conversation URLs and browser profiles remain local.

## Windows data directory investigation

A process launched from a Windows-packaged host can inherit AppData filesystem
redirection. On this device, the same logical Roaming path resolved to the
host's `LocalCache/Roaming` copy for a Codex-launched process and to the ordinary
Roaming directory for a process launched outside that context. A read-only probe
started by Windows Task Scheduler confirmed distinct physical file identities
and distinct account / tab records, with both databases passing integrity checks.

Both datasets were backed up independently. Neither account records nor browser
credentials were merged, recreated, deleted or replaced. The installed 1.4.20
client was relaunched outside the packaged host's redirection context and read
the original three account IDs and nine saved tabs. Eight tab IDs matched the
earlier snapshot; the user had changed the open tab set between snapshots.

The installed archive also reported 1.4.20 from the normal launch context.
Temporary diagnostic scheduled tasks were removed after use. The original
desktop shortcut remains the normal launch entry point. A logical `userData`
path alone is insufficient to prove that two processes read the same database.

Reference: [Microsoft's packaged desktop app filesystem behavior](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes).
