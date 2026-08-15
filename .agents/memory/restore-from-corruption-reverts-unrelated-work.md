---
name: A "restore from corruption" commit can silently revert unrelated intentional changes
description: Why a file-corruption repair commit undid a real API migration on the same day, and how to check for this pattern before trusting "suspected cause" reports.
---

A commit titled as a corruption repair (e.g. "restore places.ts from corruption") can mean
"copy back an earlier known-good version of the whole file," which discards *any* intentional
change made between that earlier version and the corruption, not just the corruption itself.

Case observed: one commit migrated a route from a legacy Google API to the New Places API
(intentional, correct direction). A same-day "restore from corruption" commit on the same file
reverted it wholesale back to the legacy endpoint as a side effect — with no test asserting the
specific endpoint URL, so nothing caught it. The bug report that resulted ("autocomplete returns
empty with a working key") was blamed on the migration commit by name, but `git blame` on the
live line and `git log -S <old-string>` on the file showed the current code predates the
migration attempt entirely; the migration was real but never reached HEAD.

**Why:** a restore-from-corruption fix is usually reasoned about as "make the corruption go
away," not "diff against every intervening commit for real work to preserve." Nobody explicitly
decided to revert the migration; it was silent collateral of the restore.

**How to apply:** when a bug report names a specific commit as the cause, verify with
`git blame` on the exact failing line/hunk and `git log -S "<distinctive string>" --all -- <path>`
before accepting the attribution — don't just read that commit's diff in isolation. If a
"restore/repair from corruption" commit touches the same file soon after, check whether it
re-introduced older content that undid later intentional work.
