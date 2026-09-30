# Queue restart recovery — 2026-09-29

Version: 1.4.18. Scope: background conversation queues only; foreground answer matching remains strict.

## Findings and changes

- Persisted submission IDs were still being checked against the pre-send DOM history window. Reloading ChatGPT can mount older user messages that were absent when the receipt was created. Restored background submissions now use the persisted stable message ID directly, while still rejecting duplicate IDs and additional user turns in the tracker.
- Live recovery also exposed `CONVERSATION_CHANGED: additional user turn appeared`. An acknowledged background queue now handles lost turn correlation by observing the fixed conversation until generation stops. It does not resend the old prompt or attribute another turn's response to that task. Completion records `responseUnavailable` and `idle_after_reply_correlation_lost` when appropriate. Target URL, readiness, generation, draft and stability guards remain in force.
- A separate local database problem prevented startup. The pre-install backup already failed SQLite integrity checks (out-of-order task table rowids and inconsistent task indexes). The cause of that pre-existing corruption is not established.

## Data recovery on the affected device

The original database and journal sidecars were retained locally. Recovery was performed on a copy using the official SQLite CLI `.recover --ignore-freelist --no-rowids` method, followed by validation before replacement. See [SQLite recovery documentation](https://sqlite.org/recovery.html).

The readable task scan contained 190 rows representing 186 unique task IDs, including four duplicate versions. The latest timestamped version of each duplicate was retained. Every readable unique task was compared with the repaired database; metadata (18), conversations (108), account queues (44) and request keys (691) were unchanged. All values parsed as JSON. Recovery cannot prove the absence of previously lost or overwritten data; no such claim is made.

The repaired database passed `PRAGMA integrity_check`. The installed client then opened successfully with three accounts and eight restored tabs. Browser profiles were not reset. Raw data, messages and credentials were not added to the repository.

## Verification

- Full core suite: 112 passed, plus one release manifest test.
- After the lost-correlation adjustment: all 28 adapter and turn tracker tests passed.
- Desktop receipt recovery: blank post-send page recovery, preserved receipt, FIFO continuation, matching-draft reuse.
- New `queue-restart-desktop.mjs`: closes and relaunches the actual Electron process using an isolated fixture profile; restores an acknowledged busy reply with remounted history, waits without growing retry counts, then sends the next queued item exactly once.
- The same restart test with `--external-turn` adds a follow-up while the app is closed: busy generation is respected; the old task completes without claiming that answer; the next queued message sends once.
- Typecheck and build passed. Full npm audit: zero vulnerabilities.

The isolated desktop tests simulate website transitions; they are not evidence that every ChatGPT server failure has been reproduced. Live account recovery is checked separately through the running client's diagnostics.

## Final installed verification

Installed and launched the final 1.4.18 build normally (without debug flags). Installed `app.asar` matches the packaged artifact: SHA256 `8026436E529C878DF59F07F70ADD59445DD5A33855C6119FDFF62FD00DB3429E`.

Three previously retrying live tasks completed with `idle_after_reply_correlation_lost`; their following queue items obtained actual submission acknowledgements. Other inspected conversations were ready with a visible generation state, so their queues correctly continued observing. Long business replies were not interrupted or represented as completed. The live database passed integrity checks again after queue execution resumed.
