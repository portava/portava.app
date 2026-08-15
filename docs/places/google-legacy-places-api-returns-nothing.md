# DEFECT — the legacy Google Places API returns nothing, with a working key

**Filed 2026-08-15. Open. Not Phase B's, and deliberately filed separately.**

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
