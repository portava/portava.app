# End-to-end flows — verification lane V3

**Scope.** Four complete user flows, traced client → HTTP route → service →
persistence and back, plus the seams where two build lanes met and nobody
checked. Written after the build phase, against
`claude/portava-continuation-uqta94` at `f224ae67e`.

**What a verdict means here.**

| verdict | means |
|---|---|
| VERIFIED | every leg is real code, a test drives the whole path, and the test was shown RED against a deliberately broken implementation. |
| VERIFIED (BOUNDED) | as above, except one named leg cannot be exercised in this tree. The bound is stated; it is not rounded up. |
| BROKEN | a defect with a file and a description of what the user sees. |
| NOT VERIFIABLE | the blocker, exactly. |

Nothing below is "correct because the builder said so". Each claim names the
test that fails when the behaviour is wrong, and each test file carries its own
mutation log with the pass/fail counts the mutants produced.

---

## The one fact that bounds every voice claim on this page

`2989_messages_audio_media_type.sql` is applied to **no database**. It is the
migration that widens `messages.media_type` to admit `audio`. Until it is
applied, the database's own CHECK refuses every voice row, and the send route
says so by name rather than failing opaquely.

Every voice test in this tree — the existing `telegraphVoice.test.ts` and the
new `verifyFlowVoiceEndToEnd.test.ts` — runs against an in-memory fake that
**does not enforce that CHECK**. So:

> Voice messages are built in the tree and live nowhere. The tests prove that
> the code paths agree with each other. They are not, and cannot be, evidence
> that a voice note can be sent on any deployment that exists today.

That is stated in both test file headers as well, so a reader of a green run
cannot mistake it.

---

## Flow 1 — Voice message: record → upload → send → thread read → drawer → play

**Verdict: VERIFIED (BOUNDED).**

Test: `artifacts/api-server/src/test/verifyFlowVoiceEndToEnd.test.ts`
(18 cases). Three real routers — `routes/telegraphVoice.ts`,
`routes/messaging.ts`, `routes/telegraphKinds.ts` — mounted on one express app
over one shared in-memory PostgREST-shaped store, so the row one router writes
is the row the next one reads.

Legs, and how each is exercised:

| leg | how |
|---|---|
| recorder → upload | The upload route's 201 body is stated as a constant and fed verbatim to the send route. Its advertised `maxDurationSeconds` / `maxWaveformPeaks` are driven at the ceiling and one past it. |
| send | `POST /threads/:id/voice`, real gates. |
| thread read | `GET /threads/:id/messages` — `mediaUrl`, `mediaType: "audio"`, `mediaDurationSeconds`, `msgType: "voice"` and the envelope's waveform all survive, for the recipient AND for the sender. A non-member gets 403 and the asset path appears nowhere in the raw body. |
| §6.4 drawer | `GET /threads/:id/drawer?tab=VOICE` indexes it under VOICE, counts it under VOICE, under **no other tab**, and object-aware search does not match it (there is no transcript, and indexing the URL would make a search for "m4a" return conversations). |
| client parse | `kindsApi.ts#parseKindEnvelope` transcribed and run against the real thread-read payload. |
| play | Not covered by this file. See the bound below. |

**The UI legs are real, and were checked by hand as well as by test.** The
chat surface is `travel-buddy-standalone/app/messages/[id].tsx`, not
`src/components/GroupChatScreen.tsx`. It mounts `ComposerPlusMenu`,
`VoiceRecorderSheet`, `TypedMessageRenderer` (which renders
`VoiceMessagePlayer`) and `ContentDrawerSheet`. `rendersTypedKind('voice')`
runs in `MessageBubble` **after** the `msgType === 'media'` branch, and voice
writes `msg_type: 'voice'`, so there is no shadowing. The private-bucket path
resolves: the stored `post-media/<uid>/voice/<ts>.m4a` reference goes through
`services/mediaUrl.ts#useHydratedMedia` → `POST /api/media/sign`, and
`lib/mediaAccess.ts` branch 3c authorises message media by **thread
membership**, matching on the bare-key spelling the voice row stores. A
recipient can therefore sign and play a sender's voice note.

**Bounds, stated rather than implied:**

1. Migration 2989 — see above.
2. The UPLOAD route is not driven over HTTP. Its policy (allowlist, byte
   sniff, size ceiling, location scrub) is covered by `telegraphVoice.test.ts`;
   its transport (bounded body reader, storage write) has no test anywhere.
3. Playback itself is covered by
   `travel-buddy-standalone/src/features/telegraph/__tests__/voice.component.test.tsx`
   (pre-existing), which injects a sound handle. No test in either tree plays
   real audio.

**Mutation evidence** (baseline 18/18; full log in the file):
dropping `mediaDurationSeconds` from the thread read → 15/1 while
`telegraphVoice.test.ts` stays 42/42 green, which is exactly the class of
defect a single-router suite cannot see; widening `drawerTabFor`'s MEDIA
branch to a bare `row.media_url` → 13/3 (voice notes land in the photo grid,
VOICE tab empties); writing `msg_type: "VOICE"` upper-case → 13/3; removing
the thread bump → 17/1; making `searchableTextOf` index a voice body → 15/1.

---

## Flow 2 — Discovery "Not interested": tap → `rank_events` → suppressed on every serve

**Verdict: VERIFIED.**

Test: `artifacts/api-server/src/test/verifyFlowDiscoveryDismissal.test.ts`
(13 cases). `routes/rankEvents.ts` and `routes/discovery.ts` mounted together
over one **mutable** store, so the dismissal the outcome route writes is the
row the suppression filter reads.

The write is **driven, not seeded**. Seeding a row with `outcome: 'dismiss'`
would test the reader alone and would stay green if the outcome route wrote the
wrong `item_id`, the wrong `surface`, or refused the dismissal outright.

What is pinned:

- the tap UPDATES the viewer's impression row in place, does not insert a
  second, and does not touch a place nobody dismissed;
- the `item_id` written is the prefixed Discovery spelling (`db/<slug>`),
  character for character, which is the seam between the serve log's
  `item.id` and the filter's `place.id`;
- a dismissal with no impression to attach to is a 404 and writes nothing —
  which is why `useRankOutcome#reportDismiss` is awaited and keeps the card;
- a dismiss is TERMINAL: a later `save` 404s rather than overwriting it;
- **all four serve paths** — cold, cache-A, Compass fresh rank, Compass
  cache-B hit — omit the place, each reached and RECOGNISED from the envelope
  rather than assumed;
- it STAYS away across repeated serves (no window, on purpose);
- controls: with no dismissal both places are served; another person's
  dismissal changes nothing; a dismissal on `pulse` does not suppress on
  `discovery`; an unreadable list serves the page and says
  `refusal.code: "dismissed_set_read_failed"`, `coverage: "partial"`.

**Mutation evidence** (baseline 13/13): normalising `item_id` in the outcome
handler (stripping `db/`) → 5/8 — eight of thirteen; removing
`dismissGatedPlaces` from each of the four serve paths separately → 10/3,
12/1, 12/1, 12/1; dropping `.eq("user_id")` → 12/1; dropping
`.eq("surface")` → 12/1; the unreadable read reporting `degraded: false`
→ 12/1.

---

## Flow 3 — Highlights/Memories: the §10/§11 control writer, set → listed → felt

**Verdict: VERIFIED (BOUNDED).**

Test: `artifacts/api-server/src/test/verifyFlowHighlightControls.test.ts`
(21 cases). `routes/highlights.ts` over a table-backed store.

Census §O.2 recorded that enforcement was live and the WRITER did not exist:
"both tables are deployed and EMPTY, and they will stay empty." The lane built
the writer. The question this file answers is not whether the writer writes —
`highlightControlWrites.test.ts` answers that — but whether a control a person
SETS changes what a person is SHOWN.

It does. `PUT /highlights/resurfacing-controls` → the row →
`GET /highlights/resurfacing-controls` lists it with the surfaces it acts on →
`GET /highlights/active` no longer serves the Highlight → `DELETE` brings it
back. The §10 half likewise: `PUT /highlights/:id/projection-policy` with
`COUNTRY` → the feed serves `location_country` and nulls the city and the
venue name, and the Highlight beside it is untouched.

Two things make this more than a round trip, and both are asserted:

1. **The writer's subject key and the reader's must agree.** `subjectTypeFor`
   (writer) and `feedSubjectScope` (reader) are separate functions over the
   same table. A `highlight`-scoped control looked up by owner id is stored,
   listed back as SET, and enforces nothing — the worst outcome available,
   because the person is told it worked. Both a highlight-scoped control
   (`DO_NOT_RESURFACE`) and a person-scoped one
   (`HIDE_PERSON_FROM_RESURFACING`) are driven end to end.
2. **Undo has to work,** and `KEEP_PRIVATE_FOREVER` must refuse to clear
   without an explicit confirmation — a mis-tap must not be able to reverse the
   strongest control this product has.

Also pinned: `RETAIN_BUT_DO_NOT_PERSONALIZE` does **not** hide the Highlight
(census H92's `state='hidden'` collapse, refused in a new place); `HIDE_TRIP`
is reported on the wire as unenforceable on the feed rather than promised;
every control RETAINS the record; an unwritable control table refuses rather
than reporting a stored preference; an unreadable control set withholds the
feed rather than resurfacing something asked to be hidden.

**Bounds:** migration 2975 (`expires_at` nullable, so PERMANENT lifetimes can
exist) is unapplied and the store enforces no NOT NULL, so this file cannot
tell an applied 2975 from an unapplied one. 2720/2721 are applied to
production, but the store models neither their unique indexes nor their RLS,
so idempotency is observed through the service's upsert and not through a real
constraint.

**Mutation evidence** (baseline 21/21): dropping `applyResurfacingControls`
from the feed → 16/5; making `subjectTypeFor("DO_NOT_RESURFACE")` return
`"owner"` → 17/4; the unreadable arm returning `rows` → 20/1; bypassing the
`KEEP_PRIVATE_FOREVER` confirmation → 20/1; giving
`RETAIN_BUT_DO_NOT_PERSONALIZE` the `proactive_resurfacing` surface → 20/1;
dropping `applyLocationPrecision` → 19/2; removing `ownsHighlight`'s owner
comparison → 20/1.

---

## Flow 4 — Layover: observation submission and crew, submitted → persisted → read back

**Verdict: VERIFIED (BOUNDED).**

Test: `artifacts/api-server/src/test/verifyFlowLayoverObservationsCrew.test.ts`
(21 cases). `routes/airport.ts` over `test/helpers/fakeLayoverDb.ts`, which is
table-backed, so a write made by one request is read by the next through the
real handler chain — ownership gate, `airport_mode_enabled` flag and all.

Observations. The interesting assertions are not "it round-trips":

- **ONE report does not move the reading.** The corroboration floor holds, so
  a single stranger's queue report publishes `truth: null` — and `null` is an
  ANSWER ("no reading"), not a loading state and not a zero. The write
  succeeds, the reading stays null, and the WRITE's answer agrees with a
  subsequent READ. A positive control with two corroborating reports proves
  the floor is reachable, so the null is not a reconciler that never publishes.
- **The rate limit is a property of the corpus**, so it only works when the
  read and the write share a store. Three reports are accepted, the fourth is
  429 and is NOT written, and the refusal names the allowance.
- **The observer id is a pseudonym** and the traveller's user id appears
  nowhere in the stored row; the `layover_events` audit trail records the
  report without the handle beside its NOT NULL `user_id`, so the link
  migration 2860 keeps out of one table is not reconstructible from another.
- An unreadable corpus refuses the write (a write without the corpus is a write
  without the limit) and refuses the READ (an outage is not an airport nobody
  has reported on).
- A retry under the same idempotency key answers `duplicate: true`.

Crew. Formed → persisted with the owner's membership → read back;
`sharedReturnBy` is published, is `min(required_return_by)` over the WHOLE
crew, and names the binding member. A non-owner leaving removes only
themselves; the OWNER leaving disbands (documented, and the halfway state — the
owner out, the crew still advertised as open — is asserted against). An
unreadable membership table refuses rather than answering "you are in no crew".

**Client status:** `AirportConditionsCard` and `LayoverCrewSection` are both
mounted, in `travel-buddy-standalone/app/layover/[id].tsx`. The client's
`TravellerFactType` union matches the server's derived
`TRAVELLER_SUBMITTABLE_FACT_TYPES` today, and that agreement is now guarded —
see the seams section.

**Bounds:** no CHECK constraints and no unique indexes in the double, so
migration 2982's `submission_token` unique index cannot be DISCOVERED here (the
duplicate case stages the 23505 the way `fakeLayoverDb`'s header instructs). No
RLS, so 2860's "authenticated may SELECT and nothing else" is not observable.

**Mutation evidence** (baseline 21/21): screening the candidate ALONE instead
of against the stored corpus → 20/1 (the rate limit silently stops existing);
a failed corpus read treated as an empty corpus → 20/1; writing the real user
id as `observer_id` → 19/2; adding the observer handle to the
`layover_events` payload → 20/1; bypassing the submittable-fact-type guard →
20/1; `sharedReturnBy` taking the latest deadline → 20/1; the owner-leaves
branch not disbanding → 20/1.

---

## The seams

These are the finds — the places two lanes met.

### S1. `messages.reply_to_id`: two writers, two assumptions. **BROKEN (not fixed).**

`routes/messaging.ts` writes `reply_to_id` as a **separate fire-and-forget
UPDATE after the insert**, and its read path wraps the column in a try/catch
with the comment that "reply threading genuinely predates migration 0057 on
some deployments and an absent column is a legitimate state".

`routes/telegraphVoice.ts`, via `services/telegraph/voice.ts#voiceMessageRow`,
puts `reply_to_id` **in the INSERT**.

On a deployment where 0057 is absent, the ordinary path loses the reply LINK
and still delivers the message; the voice path loses the whole VOICE NOTE —
PostgREST rejects the insert with 42703, `isAudioMediaTypeRejection` correctly
declines it, and the caller gets a generic `db_error`.

Not fixed: both candidate fixes are behaviour changes inside the telegraph
lane's files during a verification phase. **Pinned instead**, in two cases in
`verifyFlowVoiceEndToEnd.test.ts`, so the divergence cannot move in either
direction while nobody is comparing the two writers, and so a 42703 can never
start being reported as "apply migration 2989" (which would send an operator to
the wrong migration entirely).

### S2. Cross-tree duplicated constants — now guarded. **VERIFIED.**

`travel-buddy-standalone` is not in `pnpm-workspace.yaml`. Every enumeration
both halves need is written out twice, by two lanes, with nothing but a comment
holding them together. `voicePolicy.ts` names two of them;
**there are at least ten**, and the other eight had no guard at all.

New test:
`travel-buddy-standalone/src/features/telegraph/__tests__/verifyFlowCrossTreeVocabulary.component.test.tsx`
(17 cases). It reads the server's source **as text** and parses the
declarations — the only technique available across this boundary — and each
extractor throws with the file and the symbol if the declaration is rewritten,
because a guard that silently stops guarding is worse than no guard.

Checked, and agreeing at this commit:

| constant | client | server |
|---|---|---|
| `VOICE_MAX_DURATION_SECONDS` (300) | `features/telegraph/voice/voicePolicy.ts` | `services/telegraph/voice.ts` |
| `WAVEFORM_MAX_PEAKS` (120) | same | same |
| `DRAWER_TABS` (7, in order) | `features/telegraph/kinds/kindsApi.ts` | `services/telegraph/messageKinds.ts` |
| `SENDABLE_KINDS` / `ENVELOPE_KINDS` | same | derived from `PAYLOADS` |
| `Surface` (4) | `hooks/useRankOutcome.ts` | `SURFACE_VALUES`, `routes/rankEvents.ts` |
| `Outcome` (6) + `NegativeOutcome` | same | `OUTCOME_VALUES` |
| `ResurfacingControl` (6) | `features/highlights/privacyControlsApi.ts` | `services/highlights/highlightResurfacing.ts` |
| `SuppressibleSurface` (4) | same | same |
| `LocationPrecisionRung`, `PersonVisibilityRung` (in order) | same | `services/highlights/highlightProjectionPolicy.ts` |
| `TravellerFactType` (3) | `services/layover.ts` | derived from `AIRPORT_FACT_TYPES` |

The ladders are compared **in order**, because §10's rungs coarsen left to
right: reversed, the privacy sheet renders a tightening as a loosening and the
person picks the opposite of what they meant. The mutation that reverses them
reddens.

Two of these are structurally fragile and worth naming:

- `SURFACE_VALUES` / `OUTCOME_VALUES` are module-private on the server (right —
  nothing else should read them) and are duplicated by a client type with no
  compile-time tie at all. A value added client-first 400s at the zod boundary
  and `fireRankOutcome`'s `.catch(() => {})` swallows it, so **every outcome on
  that surface is lost in silence**.
- `TravellerFactType` is the reverse risk: the server DERIVES its set by
  filtering `AIRPORT_FACT_TYPES` on the `TRAVELER_OBSERVATION` class, so a fact
  type added under that class becomes submittable with no edit anywhere — and
  the client's union would refuse to compile a call for it. The channel would
  exist and be unreachable.

### S3. `rendersTypedKind` vs the parseable kind set. **VERIFIED.**

`parseKindEnvelope` returns a payload for every `ENVELOPE_KIND`; the dispatcher
in `app/messages/[id].tsx` asks `rendersTypedKind` FIRST. A kind the parser
understands and the renderer does not falls through to the plain text bubble
and renders the raw JSON envelope at the reader. Now asserted in both
directions, including that the renderer does NOT claim `portava_object` (which
has its own branch, after, carrying the revocation handling).

### S4. Inbox previews vs the kind set. **VERIFIED.**

Same class, one screen up: with no entry in `TYPED_KIND_LABELS`, the last line
of a conversation is `{"kind":"VOICE","envelopeVersion":"1",...`. Every
envelope kind now has a label or (for SAFETY) a subtype-keyed one, and the
assertion checks the label contains no `{` — which is what separates "no label"
from "the label IS the envelope".

### S5. `PUT /highlights/resurfacing-controls` omits `retainsRecord`. **Low severity, not fixed.**

The GET returns each control with `suppresses` AND `retainsRecord`. The PUT
returns `suppresses` only. The client's `StoredControl`
(`features/highlights/privacyControlsApi.ts`) declares `retainsRecord: boolean`
as required and `setResurfacingControl` is typed `PrivacyResult<StoredControl>`
— so the PUT's body does not satisfy the type the client claims for it.

Latent today: `HighlightPrivacySheet` re-reads after every toggle rather than
patching local state, deliberately and with a comment saying why. It becomes
real the moment any caller trusts the PUT's body. Reported rather than fixed;
the one-word fix is in `routes/highlights.ts` (the telegraph/hm lane's file).

### S6. `drawerTabFor`'s MEDIA branch is one word away from swallowing VOICE.

Not a defect — a hazard worth a test, and it now has one. The branch tests
`media_url && media_type` FIRST and a voice note has both; it escapes only
because the branch names `image` and `video` explicitly. Widening it to "has
media_url" reads like a simplification and would put every voice note in the
photo grid and empty the VOICE tab. The mutation reddens three cases.

### S7. `lib/mediaAccess.ts` branch 3c does not check `deleted_at`.

Observed, pre-existing, **not new to this build phase**, and out of scope to
fix here. `routes/messaging.ts` nulls the four media fields on a deleted
message (census T79), but `authorizeMediaAccess`'s message-media branch matches
`messages.media_url` without excluding deleted rows, so a thread member who
already holds the bare key can still have it signed after the message is
deleted. This is equally true of photos and predates voice. Recorded here
because voice is the newest asset type to inherit it.

---

## Small observations, recorded rather than filed

- The §6.4 drawer's VOICE rows render `item.title ?? item.msgType`, and
  `searchableTextOf` correctly returns `null` for a voice note, so a VOICE row
  in the drawer reads as the word "voice". Honest, and ugly.
- `routes/telegraphVoice.ts` writes `media_thumbnail_url: null` for voice, but
  the drawer's `previewUrl` prefers the thumbnail over the URL. If a future
  change ever set a thumbnail on a voice row it would advertise an audio file
  as a preview image. No surface renders `previewUrl` for the VOICE tab today,
  so there is nothing to assert; a surviving mutant recorded it.
- The recorder uploads with `Audio.RecordingOptionsPresets.HIGH_QUALITY` and no
  client-side size check. At the preset's bitrate a 300-second recording is
  comfortably under `VOICE_SIZE_LIMIT` (8 MB), so this is fine today — but the
  ceiling is enforced only on the server, and the failure mode is losing the
  recording after the traveller has spoken.
- `travel-buddy-standalone`'s `test:component` script passes
  `--testPathPattern`, which the installed jest rejects in favour of
  `--testPathPatterns`. Environment-dependent; named so the next person does
  not rediscover it.

---

## Checks run

From `artifacts/api-server`: `typecheck`, `check:doc-citations`,
`check:citation-targets`, `check:test-registration` — all exit 0. The four new
test files are appended to the `test` script's explicit file list.

From `travel-buddy-standalone`: `typecheck` exit 0; `test` (node:test)
6263/6263; `check:orphan-tests` and `check:test-mocks` clean; the new component
test run directly under jest, 17/17.

`check:all` was **not** run to completion in this environment and no exit code
is claimed for it. Nothing on this page rests on it.
