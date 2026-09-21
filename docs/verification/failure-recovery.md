# Failure recovery and fail-closed honesty — verification lane V4

**Scope**: the surfaces the four most recent build lanes added, swept for every
`catch`, every `?? fallback` and every `|| []`.

- `artifacts/api-server/src/routes/telegraphVoice.ts`
- `artifacts/api-server/src/services/telegraph/voice.ts`
- `artifacts/api-server/src/lib/telegraphThreadWrite.ts` (the guard the voice route applies)
- `artifacts/api-server/src/lib/discoveryDismissed.ts` and its caller in `routes/discovery.ts`
- the layover additions in `artifacts/api-server/src/routes/airport.ts`
- the highlights / memories writers:
  `services/highlights/highlightControlWrites.ts`, `services/memory/memorySearchService.ts`

**Evidence**: `artifacts/api-server/src/test/verifyFailureRecovery.test.ts`
(25 assertions). Its header carries the red-first record verbatim — the failing
test names, the expected/actual values, and every mutation that was run,
watched red and reverted.

**The rule being enforced**, stated once: a swallowed read is a lie. A `catch {}`
or a `?? fallback` around a privacy, membership or kill-switch read turns "I
cannot tell" into a definite answer — "not blocked", "nothing dismissed", "no
stop engaged" — and the caller cannot tell the two apart.

---

## The question each site was asked

1. What does the **user** see when this fires?
2. Is that outcome **distinguishable from the success case**? If not, it is a defect.
3. Is a degraded read **reported** (`degraded_unavailable`, a `degraded` flag, a
   `failedSources` entry) or silently swallowed?

---

## Defects found and fixed

### 1. A missing service client made "Not interested" silently stop working

`lib/discoveryDismissed.ts#loadDismissedPlaceIds`

```ts
if (!sc || !userId) return { ids, degraded: false };   // before
```

The two conditions are different sentences and were answered as one.
`!userId` is genuinely complete — there is no viewer, so nobody dismissed
anything. `!sc` is the opposite: there *is* a viewer, they may well have
dismissals, and we cannot see them.

| Question | Answer before the fix |
| --- | --- |
| What does the user see? | A Discovery page containing places they explicitly rejected. |
| Distinguishable from success? | **No.** `failedSources` is empty and the response reports `coverage: "full"`. |
| Degradation reported? | **No** — reported as a complete read of an empty list. |

This is the exact failure the module's own header sets out to forbid: "the one
thing 'Not interested' plainly promises is the one thing it did not do." The
module reports honestly on an errored read and on a thrown one; it did not
report on the one input that skips the read entirely.

**Fixed.** `!userId` stays complete; `!sc` returns `degraded: true`, which
`dismissGatedPlaces` already folds into `failedSources: ["rank_events"]` and
which `discoveryPlaceSourcesCode` already names `dismissed_set_read_failed`.
No caller changed — the plumbing was already right, the reader was not.

Guarded by A1–A6 in the test file. A2 exists specifically so the fix cannot
degenerate into "always degraded", which would put `coverage: "partial"` on
every Discovery response and make the word mean nothing.

### 2. The `disable_messaging` kill switch disengaged when it could not be read

`lib/telegraphThreadWrite.ts#guardTelegraphThreadWrite`

```ts
const flagSc = getServiceClient();
if (flagSc && (await isKillSwitchEngaged(flagSc, "disable_messaging"))) { … }  // before
```

`isKillSwitchEngaged` is meticulous: an errored read engages the stop, a thrown
read engages the stop, and the file's own header explains at length why
false-on-error is the unsafe default for a stop. All of that care sits behind an
`&&` that discards the gate entirely when the service client is absent — which
is the same underlying fact, "the flags table could not be read", arriving
through a different door.

| Question | Answer before the fix |
| --- | --- |
| What does the user see? | `201 Created`. The message is written. |
| Distinguishable from success? | **It *is* success.** |
| Degradation reported? | **No.** Nothing is logged and nothing is returned. |

The operator-visible consequence: the emergency stop is pulled, the server
cannot read the flags table, and messages keep being written — the switch
disengages precisely at the moment it is being reached for.

The asymmetry inside a single route made it plain: `POST /api/telegraph/voice/upload`
already refuses a null service client with `server_not_configured`. The upload
door failed closed; the send door beside it failed open.

**Fixed.** `messagingStopUnknownRefusal(flagSc)` is an exported predicate that
refuses with `degraded_unavailable` when the flag client is absent.
`guardTelegraphThreadWrite` consults it before the flag read, so all four
callers — `telegraphVoice.ts`, `telegraphKinds.ts`, `telegraphShare.ts`,
`telegraphCoordination.ts` — inherit it.

**Why `degraded_unavailable` and not `feature_disabled`.** "Messaging is
temporarily disabled" claims an operator engaged a stop. Nobody did; we could
not look. One is policy, the other is retryable, and collapsing sentences like
that is the whole subject of this lane.

**The cost, stated rather than buried.** A deployment with no
`SUPABASE_SERVICE_ROLE_KEY` now refuses every Telegraph typed / voice / share /
coordination write instead of serving them past an unreadable stop. That is a
misconfiguration and not a supported mode — voice upload was already refused
there — but it is a behaviour change and it is named here rather than left to be
discovered.

Guarded by B1–B6. B6 asserts a healthy thread still writes, so the fix cannot
quietly become a blanket refusal.

---

## Verified correct (proven by mutation, not by inspection)

Each was mutated, watched fail, and reverted. Counts and failing test names are
in the test file header.

| Site | Posture | How it was proven |
| --- | --- | --- |
| `lib/featureFlags.ts#isKillSwitchEngaged` | errored read → engaged; thrown read → engaged; **missing row → NOT engaged** | Both `return true` branches flipped to `false`: 6 tests red across two kill switches and two doors. The missing-row case is deliberate and is asserted (C3) — inverting it would turn every uncreated flag, including all of them on a fresh CI project, into an outage. |
| `lib/mediaPipeline.ts#guardUploadRequest` | `disable_media_uploads` read through `isKillSwitchEngaged`, not `isFlagEnabled` | Covered by the same mutation (D1, D2). D3 asserts the voice upload door calls the shared gate and reads no flag of its own — a second kill-switch read would be a second thing to remember to engage, and a private rate-limit bucket would let a client double its upload budget by alternating endpoints. |
| `lib/telegraphThreadWrite.ts` membership gate | errored read → `degraded_unavailable`, never `forbidden` | E1. "You are not a member" told to a member is a false statement about them, not a cautious one. |
| `lib/telegraphThreadWrite.ts` thread-meta gate | errored read → `degraded_unavailable`, never "assume not E2EE" | E2. `(meta)?.is_e2ee === true` is false for both "not encrypted" and "could not read"; binding `metaErr` is what keeps a plaintext envelope out of a thread whose promise is that we never hold one. |
| `lib/telegraphThreadWrite.ts` roster read | errored read → refuse, so the 1:1 block guard cannot be skipped | E4, **and it is a source assertion, which is weaker**. Deleting the `if (oErr)` block turns E4 red. The runtime case is unreachable through this route: injecting a failure on `message_thread_members` fails the membership read first, so the roster branch never runs with a healthy membership. Reaching it needs per-query failure injection the fake does not model. |
| `lib/blockGuard.ts#isBlockedBetween` | errored read → `true` (deny), with `block_enforcement_failures` and `blocked_direct_deliveries: unknown` counters | E3 drives it through the route. The counters are the part worth keeping: they are the rate at which block enforcement is running blind, invisible in any success metric. |
| `lib/discoveryDismissed.ts` error handling | errored read → degraded; thrown read → degraded | M3. Worth recording: mutating `if (error)` alone left A4 green, because a **second** guard, `if (!Array.isArray(data))`, catches the same case. Mutating both turned A4 red. |
| `routes/airport.ts#crewMemberCards` (layover) | unreadable `blocks` → **no cards at all** + `degraded: true, degradedReasons: ["blocks_unreadable"]`; unreadable `profiles` → `["member_cards_unreadable"]`; the outer `catch` reports rather than absorbs | Read, not asserted by a new test — `services/layover/__tests__/layoverCrewSurface.test.ts` already drives it. `memberCount` comes from the membership rows, so the count stays true even when the faces are withheld: a degraded crew reads as "we cannot show you who" rather than as a smaller crew. |
| `routes/airport.ts` crew load | `!mine.ok` → `degraded_unavailable`, never "you are in no crew" | Read. A traveller told they are in no crew walks away from people waiting for them. |
| `services/highlights/highlightControlWrites.ts` | every `catch` returns `fail("unavailable", …)`; a zero-row upsert returns `write_unconfirmed`, not success | Read. Exemplary: an unrecognised control row refuses the whole list rather than returning a partial one that looks complete, which would let someone conclude they had cleared something they had not. |
| `services/memory/memorySearchService.ts` | no `catch` at all; every failure is a typed `{ ok: false, detail, retryable }` | Read. |
| `services/telegraph/voice.ts` | pure; no reads, no `catch`. The `?? null` sites are optional-input defaults, not swallowed reads | Read. |

---

## Not fixed — reported, with the reason

These are real and are outside this lane's named files. Each names the change it
wants.

### R1. An unreadable `blocks` table tells the sender they are blocked

`lib/telegraphThreadWrite.ts` → `isBlockedBetween` → `forbidden`,
`"You cannot message this user"`.

The refusal is correct — nothing is delivered — but the **message is a false
statement**. `isBlockedBetween` returns a boolean, so the guard cannot tell
"blocked" from "could not check", and it reports the first. The person is told a
fact about their relationship with someone that nobody established.

Wanted: `isBlockedBetween` becomes tri-state (`blocked | not_blocked | unknown`),
and `unknown` maps to `degraded_unavailable` at every call site. `isBlockedBetween`
is consumed across messaging, buddies and the layover crew surface, so this is a
change with a wide blast radius and needs its own lane. The counters it already
emits (`blocked_direct_deliveries: "unknown"`) mean the rate is measurable today.

### R2. A thrown `blocks` read becomes a 500, not a named refusal

`lib/blockGuard.ts#isBlockedBetween` binds `error` but has no `try/catch`. A
network-level throw propagates through `guardTelegraphThreadWrite` and
`asyncHandler` to a generic 500. Fail-closed, so not a leak — but the caller
gets an unnamed server error where every sibling failure on the same route is a
named `degraded_unavailable`, and the `block_enforcement_failures` counter is
never incremented for this path, so blind enforcement through the throw route is
**unmeasured**. Wanted: wrap the read, take the same branch as `error`.

### R3. `nameVisibilitySet` cannot say it failed, and the layover crew believes it

`lib/publicIdentity.ts#nameVisibilitySet` returns an empty `Set` both when nobody
opted into showing their real name and when `profile_privacy_settings` is
unreadable. The direction is privacy-safe — names are withheld — so this is not
a leak.

It is still a swallowed read with a visible consequence: `routes/airport.ts#crewMemberCards`
calls it *after* deciding its `degraded` flag, so a crew whose names were all
withheld by an outage is served with `degraded: false` and `degradedReasons: []`.
The envelope says the member cards are complete. Handles are shown, names are
not, and nothing says why. Compare `publishableUserIds` on the line above, which
*does* return a degraded signal and *is* folded in — the two reads are adjacent
and only one of them can speak.

Wanted: `nameVisibilitySet` returns `{ allowed, degraded }` like
`publishableUserIds` does, and `crewMemberCards` appends
`"name_visibility_unreadable"` to `degradedReasons`. `nameVisibilitySet` has many
callers, so this is a lane of its own.

### R4. The same `flagSc &&` fail-open still exists in `routes/messaging.ts`

Three sites — `routes/messaging.ts:2612` (`disable_messaging` on the ordinary
send path), `:3149` and `:3153` (`disable_messaging` and `disable_media_uploads`
on the media send path) — carry the identical pattern fixed in defect 2. The
ordinary send path is the *highest-traffic* door in Telegraph, and it is the one
still able to write past a stop nobody can read.

Not fixed here: `routes/messaging.ts` is another lane's surface and a 3,000-line
file this lane has not otherwise touched. The fix is mechanical now that
`messagingStopUnknownRefusal` exists — import it, refuse on a truthy result —
and it should be one commit with its own test.

### R5. The thread bump after a voice send is logged and not reported

`routes/telegraphVoice.ts`: if `message_threads.last_message_at` fails to update,
the route logs a warning and returns `201` with the message. That is the right
call — the message **was** written and reporting a failure would invite a resend
— but the consequence is user-visible: the thread does not rise to the top of the
inbox and `lastMessageAt` is stale until the next send. Not a defect; named so it
is not rediscovered as one. `routes/messaging.ts` does the same thing on the same
column.

### R6. Untested by construction: migration 2989

The voice route refuses with `degraded_unavailable` and names migration 2989 when
`messages.media_type` rejects `'audio'`. That refusal is tested. Whether 2989 has
been **applied** cannot be tested from this tree, and it has not been. The gap is
already stated in `src/test/telegraphVoice.test.ts`'s header and is repeated here
because it is the largest remaining unknown on this surface.

---

## What was measured, and what was not

Measured:

- `pnpm run typecheck` — clean.
- `pnpm run typecheck:tests` — 863 diagnostics across 115 files, **at** baseline.
- `pnpm run check:doc-citations` — 0 failures in all five passes (one citation
  repointed; see below).
- `pnpm run check:citation-targets` — at the ceiling, 239 / 239.
- `pnpm run check:test-registration` — 1296 registered, 30 allowlisted, 1326 on disk.
- `src/test/verifyFailureRecovery.test.ts` — 25 / 25.
- `src/test/telegraphVoice.test.ts`, `telegraphKindsRoute`, `telegraphShare`,
  `telegraphCoordination`, `telegraphChat`, `telegraphAbuseControls`,
  `discoveryNegativeSignalWriter`, `discoveryCuratedSourceRefusal` — 326 / 326,
  confirming the two guard fixes break no existing caller.

**Not measured**: `pnpm run check:all` was not run end to end. Its individual
steps that bear on these files were run and are listed above; the remainder
(schema audits, live-column checks, production-drift) require Supabase
credentials this environment does not have and would exit 2 — **which is not a
pass, and is not claimed as one**.

### Two boundary touches, both pure line-number repoints

`docs/architecture/census-*.md` is outside this lane's ownership. Two citations
in `census-telegraph.md` moved because lines were added above their anchors, and
`check:doc-citations` named both. Each was repointed — **the number only, no
prose changed** — and both are flagged here so the lead can take them or revert
them:

| Line | Citation | Moved by |
| --- | --- | --- |
| `:1611` | `lib/telegraphThreadWrite.ts:80 → :80#guardTelegraphThreadWrite` | `messagingStopUnknownRefusal` added above it (defect 2) |
| `:3197` | `components/TelegraphInboxScreen.tsx:253 → :250#needsAction` | the accessibility sweep's labels on the unread badge and the mute glyph, both above that render |

`docs/BUILD-PHASE-CONTRACT.md` forbids reshaping code to keep a citation stable,
so placing the new predicate below its caller to preserve line 36 was not an
option, and neither was leaving the accessibility labels off.

### One ratchet left alone

`pnpm run check:citation-targets` now reports `✓ 238 < 239 — LOWER THE CEILING in
scripts/check-citation-targets.mjs to 238, or this gain is not kept.` It exits 0,
so it is a suggestion rather than a failure. The ceiling belongs to another lane's
ratchet and was not touched; the gain should be banked by whoever owns it.
