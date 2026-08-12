# Phase 0 tagging privacy — actual state

**Report only. No code changed in producing this.** Established from the repo
and its history on `bughunt-20260805` at `0fc5fe3a2`, 2026-08-12.

## Verdict

**PARTIAL.** Five Phase 0 tagging items — **#1, #2, #3, #4, #8** — are fixed,
tested red-first, and present in the shipping tree. **#5, #6 and #7 have no
trace anywhere in the repo or its history.** Whether they exist, were folded
into the five, or were never written down cannot be determined from here.

The item list itself is **not a repo artifact**. It is cited by commit message
and by test-file section headers, and was never committed as a document. That
is the single biggest gap in the evidence: the denominator is unknown.

## What "Phase 0" means here — two unrelated things share the name

| Name | What it is | Relation to tagging |
|---|---|---|
| `PRIVACY_AUDIT.md` (2026-07-26) | "Phase 0 — audit only; no code changes." Findings `[C1]`–`[L6]`, covering routes, RLS, buckets, realtime, search, notifications, deep links, cache, analytics, admin | **Contains zero tagging content.** The string "tag" does not occur in the document. Tagging is also *not* in its explicit "Entities Not Separately Audited" table — so it is an unstated omission, not a declared exclusion |
| Phase 0 `#1`–`#8` (tagging) | A numbered tagging-privacy work list, cited only in commit bodies and test headers | This is the one the question is about |

These are different lists. Do not read the `PRIVACY_AUDIT.md` severity counts as
covering tagging; they do not.

## Evidence — item by item

Section headers in `artifacts/api-server/src/test/tagging.test.ts` are the
authoritative enumeration:

| Item | Subject | Fixed by | Verified present at |
|---|---|---|---|
| #1 | `POST /api/tags` unauthorized — anyone authenticated could attach unlimited tags to a stranger's post; the route used the service client so `tags_insert`'s `WITH CHECK (tagger_id = auth.uid())` did not backstop it | `2221db3f4` (2026-08-10) | `services/tagging/tagPolicy.ts:67` `assertMayTagSource`; test `tagging.test.ts:628`, `coreActions.test.ts:869` |
| #2 | Pending tags rendered to everyone — `enrichSpans` filtered `suppressed` but never `status`, so a tag awaiting approval was shown the moment it was written | `d2dc936a1` (2026-08-10) | `lib/enrichSpans.ts:186` `.eq('status','approved')`; test `tagging.test.ts:718` |
| #3 | `disable_tagging` failed **open** — read through `isFlagEnabled`, which returns false on error, so the emergency stop disengaged exactly when it was needed | `d2dc936a1` | `lib/featureFlags.ts:37` `isKillSwitchEngaged`; tests `tagging.test.ts:802`, `emergencyFlags.test.ts:213` (previously asserted fail-open, inverted) |
| #4 | PostgREST filter injection in `/api/tags/suggestions` | `2221db3f4` | test `tagging.test.ts:674`; `adminPhase12.test.ts:730` and `emergencyFlags.test.ts:259` both inverted from fail-open |
| #5 | — | **no trace** | — |
| #6 | — | **no trace** | — |
| #7 | — | **no trace** | — |
| #8 | `filterByContentVisibility` failed **open** on a missing post (`if (!post) return taggedIds` notified everyone) while the adjacent catch returned `[]` for the same uncertainty — two opposite defaults for one question | `d2dc936a1` | `services/tagging/TaggingService.ts:204`; test `tagging.test.ts:755` |

Adjacent and also fixed, from a different numbering (the "finding" series):

- **Finding 16** — the 20-tags/hour cap filtered on `tags.tagged_at`, a column
  never applied to the live schema. The query errored every time, the error was
  discarded, the count fell back to 0, and the cap never fired. Fixed in
  `e9fff646c` (2026-08-08): filters `created_at`, and fails **closed** on query
  error. `TaggingService.ts:246` carries the explanatory comment.

## Why the exposure was nil regardless

`docs/design/tagging-directions.md` §8a records a read-only production query
from 2026-08-08:

```sql
select count(*), count(distinct tagger_id), min(created_at), max(created_at) from tags;
→ total_tags: 0 | distinct_taggers: 0 | earliest: null | latest: null
```

**The `tags` table is empty. Zero rows, ever.** So every one of the items above
was **latent, not exploited** — the controls were broken, the exposure was nil.
§8b adds that `tags.status` has never held a value, so the approval path
(item #2's subject) is untested code rather than working infrastructure, and
there is no `CHECK` constraint on the column.

## What is genuinely untouched

- **Item #6 of `tagging-directions.md` §6** — "is co-presence public,
  followers-only, or opt-in per user? **Needs a privacy review before any
  build.**" That privacy review has not happened. It is a different question
  from Phase 0 #1–#8 (which are all enforcement bugs in the *existing* text-
  annotation tagging) and it gates Direction C.
- §8d of the same document is headed **"Decision-ready — not acted on"**, and
  its three items remain open.

## Chronology, for the record

| Date | Event |
|---|---|
| 2026-07-15 | `tags` (0043), suppression (0046), approval status (0064) all land — **before** Phase 0 |
| 2026-07-25 | `services/interactionPermissions.ts` last touched, by SEC-01 (a different workstream) |
| 2026-07-26 | `PRIVACY_AUDIT.md` — "Phase 0", no tagging content |
| 2026-08-08 | Finding 16 fixed; `tagging-directions.md` published; production evidence recorded (tags table empty) |
| 2026-08-10 | Phase 0 #1/#4 (`2221db3f4`), then #2/#3/#8 (`d2dc936a1`); `09532e79e` makes `assertMayTagSource` statically resolvable for `check:write-path-columns` |
| 2026-08-10 | `c89f09a77` converts the 11 other emergency stops `d2dc936a1` had listed-but-not-fixed |

## The one thing to fix about the process

The Phase 0 tagging list exists only in commit prose. Anyone asking "is Phase 0
done?" — as was asked today — has to reconstruct it from `git log` and test
headers, and still cannot answer for #5–#7. If that list still exists outside
the repo, committing it is a few minutes of work and closes the question
permanently.
