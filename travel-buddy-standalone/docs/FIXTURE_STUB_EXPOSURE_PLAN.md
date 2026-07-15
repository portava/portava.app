# Travel Buddy — Fixture / Stub Exposure Plan

> **Prepared offline from static source.** No app run, no backend check. Each item
> lists what was observed in the client code and a recommended beta action. "Wire now"
> means real backend work is required and is **not** done yet — do not assume it exists.

## Why this matters for beta

A beta with **real users** is different from a demo. Fixture data that looks fine in a
walkthrough becomes a trust problem when a real user sees a trip that isn't theirs, a
stamp they didn't earn, or a "Safe Return" that does nothing in an emergency. The rule
for beta: **every surface is either backed by real data or honestly labeled. Nothing
fake is presented as real.**

Recommended actions, in order of preference:
- **WIRE NOW** — connect to a real service (only if the service/route already exists)
- **LABEL COMING SOON** — keep visible, mark clearly as not-yet-functional
- **HIDE FOR BETA** — remove from the UI until real
- **KEEP (test/admin-only)** — fine if not on a user path
- **DEFER** — revisit post-beta

---

## User-facing fixtures & stubs

### 1. `post/[id]` — Cebu fixture
**Observed:** `postById()` resolves from the cebu fixture, not a live posts service.
**Risk:** Real users opening a post see fabricated content / wrong post.
**Recommendation:** **WIRE NOW** *if* a real post-fetch service exists; otherwise
**HIDE** deep-linking to posts for beta and only surface posts that come from the real
feed. Do not ship fabricated post bodies to real users.

### 2. Post detail — comments stub
**Observed:** Comments section is a labeled shell with no real thread.
**Risk:** Low if labeled.
**Recommendation:** **LABEL COMING SOON** ("Comments coming soon"). Already a stub —
keep it honest, don't make it look interactive.

### 3. `trip/[id]` — `mockTripDetail` merge
**Observed:** Real trip fields are merged onto `mockTripDetail`; the screen is a hybrid.
**Risk:** **High.** Users see a mix of their real trip and mock content with no way to
tell which is which.
**Recommendation:** Split clearly. Render real fields from the real trip; for any
section still backed by mock, either **WIRE NOW** or **HIDE/LABEL**. Do not present a
half-real trip as the user's trip.

### 4. Trip detail — TripPlans (fixture)
**Observed:** Plans list is fixture data. (A separate real `TripPlanSection` may run
alongside — verify which is shown.)
**Recommendation:** **WIRE NOW** if `TripPlanSection` is the real one — show only that
and remove the fixture list. If no real source, **HIDE FOR BETA**.

### 5. Trip detail — TripCircle (fixture)
**Observed:** Crew/circle avatars are fixture.
**Recommendation:** **WIRE NOW** if a real trip-members service exists; else **HIDE**.
Showing fake crew members on a real trip is misleading.

### 6. Trip detail — TripStamps (fixture)
**Observed:** Stamps are fixture.
**Risk:** Stamps imply earned travel history. Faking them undermines the Passport
concept.
**Recommendation:** **HIDE FOR BETA** unless real stamp data exists. Better empty than
fabricated.

### 7. Trip detail — TripPosts (fixture)
**Observed:** Posts section is fixture.
**Recommendation:** **WIRE NOW** to the real feed filtered by trip, or **HIDE**.

### 8. Pulse / City Pulse — fixture mixing
**Observed:** Real `useGlobalFeed` blended with `pulseFeed` fixture items.
**Risk:** Real and fake items interleaved with no distinction.
**Recommendation:** **WIRE NOW** — filter the feed to real items for beta. If volume is
too thin without the fixtures, show an honest empty/low-content state rather than
padding with fakes.

### 9. Compass — seeded / fixture opening text
**Observed:** Compass opening message is a seeded fixture string.
**Risk:** Low — it's framing copy, and `postCompassAsk` is real.
**Recommendation:** **KEEP** for beta (acceptable as intro copy), or **WIRE NOW** to
generate from real context if cheap. Not blocking.

### 10. Safe Return — setup / Emergency Contacts (alert-only)
**Observed:** Flows show alerts; no real setup or contact persistence.
**Risk:** **Highest.** A safety feature that appears functional but isn't is a real
user-safety and liability issue.
**Recommendation:** **LABEL COMING SOON** unmistakably, or **HIDE FOR BETA**. Under no
circumstances ship Safe Return looking operational. If beta markets safety, this must be
either truly working or clearly absent.

### 11. Pulse card — Report / Hide / Bookmark (stubs)
**Observed:** "Coming soon" alerts.
**Recommendation:** **LABEL COMING SOON** (fine as-is) — but note **Report** is a
moderation primitive; if the beta has real user content, a working Report path is
strongly advisable before launch.

### 12. Edit Trip — disabled / coming soon
**Observed:** Disabled button, opacity 0.35, no handler.
**Recommendation:** **LABEL COMING SOON** or leave disabled. Non-blocking.

---

## Summary table

| Item | Risk | Recommended beta action |
|---|---|---|
| post/[id] cebu fixture | High | Wire now / else hide deep-link |
| Comments stub | Low | Label coming soon |
| trip/[id] mock merge | High | Split real vs mock; wire or hide |
| TripPlans fixture | Med | Wire (TripPlanSection) or hide |
| TripCircle fixture | Med | Wire or hide |
| TripStamps fixture | High | Hide unless real |
| TripPosts fixture | Med | Wire or hide |
| Pulse fixture mix | Med | Filter to real; honest empty state |
| Compass seed text | Low | Keep or wire |
| Safe Return alert-only | **Highest** | Label coming soon or hide — never fake |
| Pulse Report/Hide/Bookmark | Low–Med | Label; Report should work if UGC live |
| Edit Trip disabled | Low | Label / leave disabled |

## Guiding principle
**Empty and honest beats full and fake.** For every item above, the safe default if
real wiring isn't ready is to hide or clearly label — never to let fixture data pose as
the user's real content. This is especially non-negotiable for **Safe Return** and
**stamps**.
