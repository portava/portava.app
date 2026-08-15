# DEFECT — the legacy Google Places API returns nothing, with a working key

> # ⇒ AFTER THE NEXT REPUBLISH, RUN THIS FIRST
>
> ```bash
> curl -s 'https://portava.replit.app/api/places/google-autocomplete?input=Barcelona&type=city'
> ```
>
> **One call. Four outcomes. Four distinct readings. No ambiguity — which is
> precisely what did not exist before 2026-08-15, when every one of these
> returned the same empty list.**
>
> | Response | Reading | Next action |
> |---|---|---|
> | `places` populated, **no `reason`** | **The migration was the remedy.** | Close this filing. Delete the legacy helpers per the note in `googlePlacesReason.ts`. |
> | `reason: "google_places_new_service_disabled"` | **An enablement fault — now NAMED rather than silent.** | Owner enables Places API (New). The error carries an `activationUrl` in the logs. |
> | `reason: "google_places_new_*"` (anything else — key, referer, quota shaped) | **Migration was NECESSARY BUT NOT SUFFICIENT.** The fault follows the key, not the API. | This filing stays open; the real cause is here. |
> | still `{"places":[]}`, **no `reason` at all** | **The deploy did not carry these changes.** | Verify the build before concluding anything about Google. |
>
> **Until that value is read, this defect's cause is UNKNOWN and must be
> described that way — including to the owner.** The observability fix exists so
> that the answer is one call away instead of a guess.

**Filed 2026-08-15. Open. Not Phase B's, and deliberately filed separately.**

> ## STATUS — 2026-08-15, two changes landed, neither confirmed as the remedy
>
> | | |
> |---|---|
> | **Observability** | **LANDED.** Both routes now return a machine-readable `reason` on every failure path, and propagate Google's own status instead of discarding it. |
> | **Migration** | **LANDED.** Both routes moved from the legacy `maps.googleapis.com` Places API to **Places API (New)**, key in the `X-Goog-Api-Key` header. |
>
> ### Neither is confirmed to fix this, and the reason matters
>
> **Production still runs `a384e29fa`.** Neither change has been deployed, so
> **the exact cause of the legacy failure is still unknown.** The migration was
> chosen as the **best available move**, not as a confirmed resolution:
>
> - it targets an API **already enabled and demonstrably working** with this key,
>   so it depends on nothing from the project owner; and
> - the legacy API is being deprecated, so enabling it would buy a fix that has
>   to be redone.
>
> **The case where migration does NOT fix it:** if the underlying fault is
> **key-scoped or referer/IP-restricted** rather than API-enablement, it applies
> to Places API (New) as well, and the symptom will simply reappear on the new
> surface. That is not a remote possibility — it is one of the two live
> hypotheses, and nothing available before a deploy can distinguish them.
>
> ### ⇒ The one call that decides which story is true is at the top of this file.
Found while verifying the deploy for Phase B. It is **not** a Phase B blocker and
must not be folded into it: doing so would both delay Phase B and bury this.

> **Read the MEASURED / INFERRED split below before acting on any of it.** The
> measurements are reproducible right now. The cause is an inference — a strong
> one, but it has not been confirmed against the Google Cloud console, and this
> document does not pretend otherwise.

---

## Summary

Two api-server routes call the **legacy** Google Places API on
`maps.googleapis.com`. Both return empty results in production, with an API key
that is demonstrably working — the **Places API (New)** on
`places.googleapis.com` succeeds with the *same* key at the same moment.

Neither route can report this. Both collapse every failure to an empty success
shape, so the condition is invisible from the outside and from the client.

---

## MEASURED — reproducible against production, 2026-08-15 ~12:15–13:00Z

Live build `a384e29fa`, deployment build-id `58536e52-de91-4ce1-b1d9-1a91fc2e7813`,
verified clean (ROADMAP → *DEPLOY VERIFIED CLEAN*).

### 1. Legacy autocomplete returns nothing, for every input tried

```
GET /api/places/google-autocomplete?input=Barcelona&type=city
GET /api/places/google-autocomplete?input=Paris
GET /api/places/google-autocomplete?input=Tokyo&type=city
GET /api/places/google-autocomplete?input=London
```

All four: `{"places":[],"powered_by":"google"}` — HTTP 200. **4 of 4.**

### 2. Legacy place details returns nothing, for a valid real place_id

```
GET /api/places/google-details?place_id=ChIJk_s92NyipBIRUMnDG8Kq2Js
```

→ `{"details":null}` — HTTP 200. The place_id is real: it was returned by
Google's own Places API (New) minutes earlier, for Sagrada Família.

### 3. The key works — the NEW API succeeds with it at the same time

```
GET /api/places/photo?name=Sagrada%20Familia&lat=41.4036&lng=2.1744
```

→ a real `places.googleapis.com/v1/places/{id}/photos/{ref}/media` URL. **5 of 5**
distinct places returned photos; one media URL was followed end-to-end and
returned **HTTP 200, `image/jpeg`, 135,854 bytes**.

So `GOOGLE_MAPS_API_KEY` is present, valid, and authorised for at least one
Google Places product.

### 4. The split falls exactly on the API boundary

| Route | Host | API | Result |
|---|---|---|---|
| `/places/google-autocomplete` | `maps.googleapis.com` | Places **legacy** | **empty** |
| `/places/google-details` | `maps.googleapis.com` | Places **legacy** | **null** |
| `/places/photo` | `places.googleapis.com` | Places **(New)** | **works** |

Two independent legacy endpoints fail; the new API succeeds. Same key, same
process, same minutes.

### 5. User-visible impact is DEGRADATION, not an outage

`GlobalPlacePicker` composes several sources — `usePlaceSearch`,
`useGooglePlacesAutocomplete`, `useRecentPlaces`, `usePopularCities`.
`/api/places/search` works:

```
GET /api/places/search?q=Barcelona&type=city
→ {"places":[{"id":"nominatim-83784328","name":"Barcelona", ... "source":"nominatim"}]}
```

**So the picker still returns results.** What is lost is the entire
Google-sourced contribution, silently — plus lat/lng enrichment on selection of
a Google result, since `fetchGooglePlaceDetails` returns null.

**Do not describe this as "destination search is broken."** It is not. It is a
whole result source contributing nothing while appearing to be consulted.

---

## INFERRED — not confirmed, and flagged as such

### The likely cause

**The legacy Places API is not enabled on the Google Cloud project, while Places
API (New) is.** In Google Cloud these are *separate* APIs with separate
enablement; enabling one does not enable the other. Places API (New) enablement
had been blocked on billing activation and cleared shortly before these
measurements, which fits: whoever enabled it enabled the new one.

**Confidence: high** — it is the only hypothesis that explains all of
measurements 1–4 at once, and specifically why the boundary falls exactly on the
host name rather than on the key, the process, or the input.

**Not confirmed.** Confirming it means reading the API-enablement list in the
Google Cloud console, or reading the api-server logs for the `logger.warn` at
`places.ts:330` (`"Google Places Autocomplete non-OK"`), which carries Google's
own `status`. Neither was available to this session.

### What could NOT be determined

Google's actual status string — `REQUEST_DENIED`, `SERVICE_DISABLED`, an HTTP
non-OK, or a timeout. **Both routes discard it before it reaches any caller.**
See the design defect below; that is not a coincidence, it is the same fault.

---

## NOT the cause — correcting a plausible misattribution

**`cd1f4e1bb` is not responsible, and chasing it is a dead end.**

That commit (the reverted drift) moved `/places/google-autocomplete` **onto**
`places.googleapis.com/v1/places:autocomplete` with the key in the query string.
Three reasons it cannot be the cause:

1. **It was reverted** (`87e245786`) and is not in the live build. The live build
   is on the legacy endpoint — confirmed in the running build, not just in git.
2. It moved that route **toward** the API that currently *works*, not away from it.
3. Key-in-query-string is true of the **live legacy route as well**
   (`places.ts:318` builds `URLSearchParams({ input, key, language })`). It is
   unrelated to the empty result, though it is worth revisiting on its own terms.

The drift is a real problem for other reasons — it collapsed the photo
fallback chain to FSQ → FSQ — but not for this one.

### The git archaeology, checked — and a second wrong story corrected

A follow-up account held that `cd1f4e1bb` migrated autocomplete to the New API
and that `d713e58ee` (*"the places.ts repair"*, same day) restored the file to
an earlier version and **silently undid that migration** — leaving today's
legacy endpoint as the residue of an accidental revert.

**That is not what happened, and the history says so plainly.**

| Commit | Time (UTC) | legacy endpoint | New-API endpoint |
|---|---|---|---|
| `11fffd9f4` | **2026-07-27** 19:03 | **1** | 0 |
| `9b9b120da` (#61) | 2026-08-15 09:39 | **1** | 0 |
| `d713e58ee` (#62) | 2026-08-15 09:48 | **1** | 0 |
| `cd1f4e1bb` (drift) | 2026-08-15 11:09 | 0 | **1** |
| `87e245786` (revert) | 2026-08-15 11:23 | **1** | 0 |
| `HEAD` | — | **1** | 0 |

Three findings, each of which kills the account:

1. **`d713e58ee` never touched these handlers.** Its diff against
   `routes/places.ts` contains **zero** added or removed lines matching
   `autocomplete` or `google-details`. It could not have undone a migration it
   did not touch.
2. **It predates the migration by 80 minutes.** `d713e58ee` is 09:48;
   `cd1f4e1bb` is 11:09. There was nothing there yet to undo.
3. **The New-API endpoint never existed before the drift.** Its count is 0 at
   every commit on this branch until `cd1f4e1bb`, where it appears for the first
   time. It survived roughly **14 minutes** before the deliberate revert.

**The true story is duller and more useful: nothing broke autocomplete.** The
legacy endpoint has been in place continuously **since 2026-07-27** and is still
there. There is no regression to find and no commit to blame — **the code has
always called the API that is now refusing it.** What changed is on Google's
side, or was never true, and the app is pre-launch with no organic traffic, so
nobody was in a position to notice either way.

> **Recorded because being wrong here is expensive in a specific direction.**
> Both incorrect accounts pointed at a commit, and a commit is a satisfying
> thing to point at — it implies a revert will fix it. Neither would have. An
> hour spent bisecting `places.ts` would have found nothing, because there is
> nothing there.
>
> The general form, and it is the fourth face again: **a defect with no
> regression is the one most likely to be mis-attributed**, because "what
> changed?" is the first question anyone asks and here the answer is "nothing in
> this repository."

### What DID remove the migration, and why the framing matters

**`87e245786` — a deliberate revert of five unreviewed local commits, with a
written rationale.** Not silent, not accidental, not collateral.

`cd1f4e1bb` had bundled a real API migration together with changes that **had
not passed CI**, including the one that collapsed the photo fallback chain from
Google→Foursquare to **Foursquare→Foursquare**. Reverting the bundle was the
correct call, and the reasons in that commit message still hold.

> **The silent-accident framing is backwards in the way that matters most.** It
> recasts an intentional decision as damage, and damage invites undoing. The
> commit a reader would "restore" is the one whose FSQ→FSQ collapse would take
> Discovery's photos out entirely the next time Foursquare returns 429 — **which
> it did, the same day.**
>
> **The correct response to a deliberately reverted commit is never to restore
> it blindly. It is to redo the good part cleanly** — on its own branch, through
> CI, with the failure made observable first. That is what #75 and #76 did, and
> it is the case study worth keeping.

**Also worth keeping from the discarded account:** a restore-from-corruption
commit quietly reverting an unrelated intentional change *is* a real hazard — it
just is not what happened here. Two commits on 2026-08-15 do describe themselves
as repairing corrupted or scrambled code in `places.ts` (`cf4d8a674`,
`3fe369046`). Neither touched the autocomplete endpoint.

Recorded as a memory note at
`.agents/memory/restore-from-corruption-reverts-unrelated-work.md`, which
previously carried the wrong version of this story.

---

## THE DESIGN DEFECT, which is the part worth fixing first

Both routes degrade to a shape indistinguishable from success:

| Route | Missing key | Non-OK HTTP | Non-OK status body | Genuinely no match |
|---|---|---|---|---|
| `google-autocomplete` | `{places: [], powered_by}` | *same* | *same* | *same* |
| `google-details` | `{details: null}` | *same* | *same* | *same* |

**Four distinct conditions, one wire shape.** A caller cannot tell *"there is no
such city"* from *"the API is switched off"*. `places.ts:289` documents this as
graceful degradation, and it is graceful — it is also **silent**, and that is why
an entire result source has been contributing nothing without anyone noticing.

This is the workstream's governing invariant, in the third of its three faces:

> **Absence of evidence must never silently become evidence of absence.**

The contrast is in the same file. `/places/photo` and `/places/fsq-photo` return
a machine-readable `reason` on **every** failure path (#61, #62, #64) — and that
is precisely why the Foursquare 429 and the Google enablement state were both
detectable at all. **The instrumented routes reported their own outage; the
uninstrumented ones did not.** Two routes in one file, one pattern away from each
other.

---

## Suggested fix, NOT applied

Deliberately not fixed here — filing and fixing in one motion is how a defect
report becomes an unreviewed change.

1. **Make the failure audible first.** Give both routes a `reason` on every
   failure path, mirroring `apiKeyFailureReason` / the `google_places_api_new_*`
   strings already in `places.ts`. Propagate Google's `status` rather than
   discarding it. **This is the fix that makes the rest diagnosable**, and it is
   worth landing even if the enablement question resolves tomorrow.
2. **Then decide the product question**, which is genuinely open: enable the
   legacy Places API on the project, **or** migrate both routes to Places API
   (New) — which is already enabled, already working, and already used by
   `/places/photo`. Google's own direction of travel favours the second.
3. Whichever is chosen, add a check that fails loudly when a result source
   returns zero rows for every input over a window. A source that is silently
   contributing nothing should not look like a source that is working.

---

## Reproduce

```bash
# Empty, every time — legacy autocomplete
curl -s 'https://portava.replit.app/api/places/google-autocomplete?input=Barcelona&type=city'

# Null — legacy details, with a real place_id
curl -s 'https://portava.replit.app/api/places/google-details?place_id=ChIJk_s92NyipBIRUMnDG8Kq2Js'

# Works — the NEW API, same key, same moment.
# NOTE: the response embeds the key in photoUrl. Do NOT paste the output anywhere.
curl -s 'https://portava.replit.app/api/places/photo?name=Sagrada%20Familia&lat=41.4036&lng=2.1744'

# Works — the internal source, which is why the picker still returns results
curl -s 'https://portava.replit.app/api/places/search?q=Barcelona&type=city'
```

> **The photo response contains the API key in `photoUrl`.** Redact before
> sharing any transcript of it: `sed -E 's/([?&]key=)[^&"]*/\1<REDACTED>/g'`.
> That the key travels in a URL the client receives is a separate concern from
> this defect and is not filed here.
