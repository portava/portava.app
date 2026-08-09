# rank_events — signal gaps found while extending attribution

Found while looking for the next outcome to instrument after `rsvp`/`join`
(commits `5b7c7fa87`, `0e4fe0038`, `75c11d5db`). Two are open questions about
production, one is a schema decision. **None is fixed here** — each needs
either a production fact this repo cannot supply, or a decision.

Related: `docs/algorithm/signal-audit.md` §3a (attribution), and the schema
reconciliation, which established that live CHECK constraints have been found
**wider** than the migration files declare.

---

## 1. The server writes surface values the declared constraint rejects

Migration `0153_add_rank_events.sql:25`:

```sql
surface text NOT NULL CHECK (surface IN ('pulse','discovery','events'))
```

The server writes two values outside that set:

| Value | Written at | Path |
|---|---|---|
| `living_page` | `routes/rankEvents.ts:66` | direct service-client insert |
| `compass` | server-side insert | Compass path |

And the Living Page insert is deliberately fire-and-forget:

```ts
// Fire-and-forget: failures are non-fatal — a missed signal is better than
// a broken Living Page load.
const { error } = await sc.from("rank_events").insert({ … surface: "living_page" … });
if (error) { req.log.warn({ err: error, … }, "rank-events: direct insert failed (non-fatal)"); }
```

**Two possibilities, and the repo cannot tell you which:**

- The live constraint has been widened out-of-band, these rows land, all is
  well. Plausible — reconciliation found exactly this pattern elsewhere.
- The live constraint still matches the migration, in which case **every
  Living Page and Compass impression is rejected by Postgres**, the error is
  logged at `warn`, swallowed, and two entire surfaces are missing from the
  ranking corpus. Nothing fails. Nothing alerts.

The trade-off in that comment is correct in isolation — a dropped signal
really is better than a broken page load. The problem is that it makes total,
permanent signal loss look identical to normal operation.

**To resolve:** `src/scripts/checkRankEventsSurfaces.ts` (added alongside this
doc) reads the live constraint definitions, compares them against every value
the code writes, and reports observed row counts per surface. Read-only.

```
cd artifacts/api-server
node --env-file-if-exists=.env --import tsx/esm src/scripts/checkRankEventsSurfaces.ts
```

Exit 1 means at least one written value is rejected live. **The script will
not widen a constraint** — that is a production schema change and belongs to a
person.

Note it reports permitted-but-zero-rows separately from rejected. A surface
that is allowed and still has no rows is a different bug, and the two are easy
to conflate.

---

## 2. "Booked buddy" is top of the success hierarchy and emits nothing

The spec's ordering, strongest first:

> joined plan / attended / **booked buddy** → shared moment together → saved
> place/plan → Telegraph conversation → followed traveller → shared post →
> stamped → commented → profile/place opened → dwell time → raw impression

Booking is in the **top tier**. Today it emits no outcome at all:

- `app/(rent-a-buddy)/checkout.tsx:224` calls `createBooking(...)`
- no `fireRankOutcome` on that path
- `src/components/BuddyCard.tsx:76` `handleBook` navigates to checkout, also silent

**Why this was not simply wired.** The outcome enum has no value for it:

```
outcome  IN ('impression','tap','save','join','rsvp','attended')   + 'analytics' (0197)
surface  IN ('pulse','discovery','events')
```

Every honest option needs a decision:

| Option | Cost |
|---|---|
| Map booking → `join` | No schema change, but conflates "joined a meetup" with "booked a buddy" in the funnel. Nobody analysing it later could separate them — and the spec ranks them as distinct top-tier outcomes. |
| Add outcome `book` | Correct and unambiguous. Production CHECK constraint change. |
| Add surface `rent_a_buddy`, keep outcome `join` | Also unambiguous, arguably cleaner — the surface field is what already distinguishes contexts. Also a production CHECK constraint change. |

**Recommendation: the third.** `surface` is already the axis that separates
contexts, `join` genuinely describes the action, and it leaves the outcome
vocabulary stable. But it is a schema change either way, so it is a decision,
not an implementation detail.

If finding 1 shows the live surface constraint is already wider than declared,
this gets cheaper — `rent_a_buddy` might simply need adding to
`SURFACE_VALUES` in `routes/rankEvents.ts` and the client `Surface` type.
**Check before assuming**; that assumption is the one that produced finding 16.

---

## 3. Attribution coverage as it stands

| Surface | Session carried to outcome? | Notes |
|---|---|---|
| `ExploreTodaySection` → event | **yes** | `0e4fe0038` |
| `FitsCard` → event | **yes** | `75c11d5db` |
| `PulseFeedCard` → SaveButton | **yes** | pre-existing |
| `PulseLiveCarousel` / `LivePulseCard` → event | **no** | blocked: `/api/pulse/live` never calls `logImpression`, so there is no impression to attribute to. Server fix queued. |
| `MapCarousel` → event | **no** | no session in scope |
| Deep link / notification / search → event | **no**, by design | records unattributed rather than wrongly attributed |
| Buddy booking | **no** | finding 2 |

---

## Not verified here

- **The live constraints.** That is the entire point of finding 1 — it is
  unresolved until someone runs the script against production.
- **Whether `living_page` / `compass` rows exist.** Same script, same run.
- No typecheck or test run on the script: built against a clone with no
  `node_modules`. It follows the same Management API pattern as
  `checkMissingLiveColumns.ts`, but that is structural similarity, not proof.
