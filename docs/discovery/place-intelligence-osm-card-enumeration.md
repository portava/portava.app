# Place Intelligence — what an OSM-only place card renders today, and what it could

**Enumeration only. Nothing is built here and nothing is committed to.**
2026-08-15, opening item 2 of the owner's sequence.

> **Scope, from the ruling:** Place Intelligence starts as a **VISIBLE PRODUCT
> UNIT**, not invisible corpus-building. Every improvement must help a user
> *now* and become ranking input later. **Ranker work stays on explicit hold.**

**Method: enumerated from the code, not estimated.** Every "populated / absent"
below was read out of the OSM→`DiscoveryPlace` mapping at
`routes/discovery.ts:452-478` and the card at
`components/discovery/PlaceCard.tsx`. *Enumerate populations, do not estimate
them* is a rail on this workstream; a guessed enumeration would be the wrong
kind of input to a cost decision.

---

## 1. What an OSM-only place actually carries today

The OSM path constructs a `DiscoveryPlace` with **exactly fifteen fields** and
nothing else. This is the complete list — there is no other OSM code path.

| Field | State on an OSM-only place | Source |
|---|---|---|
| `id` | ✅ always | `<type>/<osmId>` |
| `name` | ✅ always — **rows without a name are filtered out entirely** (`:453`) | `tags.name` |
| `category` | ✅ always | the requested Discovery tab, not the place |
| `type` | ⚠️ often | first of `tourism/amenity/leisure/natural/historic/railway/aeroway` |
| `description` | ❌ **rare** | `tags.description ?? tags.note` |
| `distanceKm` | ✅ when the place has coordinates | computed |
| `lat` / `lng` | ✅ almost always | OSM node/centre |
| `tags` | ⚠️ up to **3**, from a fixed list of 7 | `cuisine, tourism, amenity, leisure, natural, historic, sport` |
| `address` | ⚠️ partial | `addr:housenumber/street/city` only |
| `website` | ⚠️ sometimes | `tags.website ?? tags.url` |
| `phone` | ⚠️ sometimes | `tags.phone ?? contact:phone` |
| `openingHours` | ⚠️ sometimes | `tags.opening_hours`, raw string |
| `rating` | ❌ **almost never** | `tags.stars ?? tags.rating` — hotel stars, not opinion |
| `isOpenNow` | ⚠️ best-effort | regex over `opening_hours`; returns `null` when unparseable |

## 2. What the card expects and OSM never supplies

The card is built for a **richer** shape than the OSM path produces. These are
referenced by `PlaceCard.tsx` and are **`undefined` on every OSM-only place**:

| Field the card reads | Why it is absent |
|---|---|
| `headerImageUrl`, `headerImageSource` | set only from `discovery_places.image_url` — a DB-backed field |
| `imageSourceType`, `accuracyStatus` | the accuracy pipeline never ran for this place |
| `disclaimerRequired`, `disclaimerText` | ditto |
| `attribution` | set for FSQ-sourced places; deliberately absent for OSM |
| `savedCount`, `worthItCount`, `avgRating`, `reviewCount` | require users, and there are none yet |
| `neighborhood` | never populated from OSM tags |

**This is the actual gap, and it is a data gap rather than a rendering gap.** The
card already knows how to show provenance, confidence and disclaimers. **It has
nothing to show them about.**

## 3. Photos — the one field with a live runtime path

Unlike everything else, the card does **not** give up when `headerImageUrl` is
absent. `PlaceCard.tsx:59` calls `useFsqPhoto(name, lat, lng, undefined)`, which
runs the deferred fallback chain **Foursquare → Google Places (New) → category
artwork**.

**So OSM-only places do get real photos — at request time, per card, every
session, cached only server-side.** State as of 2026-08-15: Foursquare is
returning **HTTP 429** and **Google is carrying every card**.

Three consequences worth having in front of a cost decision:

1. **The photo is not part of the place record.** Nothing is stored, so nothing
   accumulates, nothing can be ranked on, and every viewer re-pays the lookup.
2. **It is a live dependency on two external providers** for a field the user
   sees first.
3. **It already works.** This is the one experiential-ish field where the product
   is not starting from zero.

## 4. What it could render — grouped by what it would actually cost

### TIER 1 — CHEAP. Data we already fetch and throw away.

Overpass returns the **full tag set**; we keep 7 tags and discard the rest. No
new dependency, no new provider, no schema change — a mapping change.

| Addition | Source, already in the response |
|---|---|
| **Richer categorisation** | `cuisine` (all values, not the first), `brand`, `operator`, `historic:*` |
| **Accessibility** | `wheelchair`, `toilets:wheelchair` |
| **Experiential attributes** | `outdoor_seating`, `takeaway`, `delivery`, `internet_access`, `air_conditioning`, `smoking`, `dog`, `reservation` |
| **Family / group signals** | `kids_area`, `highchair`, `baby_feeding` |
| **Payment** | `payment:*` |
| **Better address** | `addr:postcode`, `addr:suburb`, `addr:neighbourhood` → the **`neighborhood`** field the card already reads |
| **Identity for enrichment** | `wikidata`, `wikipedia`, `image`, `website:menu` |
| **Structured hours** | parse `opening_hours` properly instead of a regex that returns `null` on anything complex |

> **`wikidata` and `image` are the two highest-leverage tags in this tier**, and
> both are currently discarded. `image` is sometimes a direct photo URL. `wikidata`
> is the join key to a free, licensed, structured description — which is Tier 2.

### TIER 2 — MEDIUM. One new free dependency, or work on data we now hold.

| Addition | What it needs |
|---|---|
| **Wikimedia/Wikidata enrichment** — description, canonical photo, licence | one new HTTP dependency; free, no key, rate-limited. **Requires Tier 1 first** (the `wikidata` tag is the join key) |
| **Provenance + confidence on every field** | no new data — populate `imageSourceType` / `accuracyStatus` / `attribution` for the OSM path so the card's existing UI has something true to say |
| **Persist the resolved photo** | write the FSQ/Google result to `discovery_places.image_url` so it stops being re-fetched per viewer and starts being a place *attribute* |
| **Graceful-fallback pass** | the card's empty states, audited against a place carrying only `id`, `name`, `category`, `lat`, `lng` — the genuine floor |

### TIER 3 — EXPENSIVE, or blocked on launch.

| Addition | Why it is expensive |
|---|---|
| **Opinion ratings, review counts, "worth it"** | needs **users**. 0 users today. Not buildable, only preparable. |
| **Model-generated experiential attributes** ("lively", "good for solo") | inference cost, a quality bar, and a provenance story so it is never mistaken for observed fact |
| **Paid provider enrichment** (Google Place Details fields, FSQ premium) | per-call cost, and the FSQ 429 shows what a quota ceiling does to a user-visible field |
| **Editorial/curated content** | human time per place; does not scale to a corpus |

## 5. What this suggests, without committing to it

**Tier 1 is where the ratio is.** It is a mapping change to one function, it
needs no new dependency or provider, and it directly produces *experiential
attributes*, *category and context*, and the *neighbourhood* field — three of
the five things the ruling names. **The data is already arriving in every
Overpass response and being dropped on the floor.**

**The one Tier 2 item that stands alone is provenance and confidence**, because
the card already renders it and currently gets nothing. It is the difference
between a card that is silent about where its content came from and one that is
honest about it — and it is the same invariant this workstream has been paying
for all day, at the level of a user-visible field.

**Two things worth deciding before anything is built:**

1. **Does persisting the resolved photo count as corpus-building or as product?**
   It is invisible on the day it ships and it is what stops every viewer
   re-paying two external providers. Reading the ruling strictly it is
   infrastructure; reading it by outcome it is what makes photos reliable.
   **The owner should rule rather than the implementer assuming.**
2. **Where does an OSM-only card sit against "genuinely useful"?** Tier 1 makes
   it *informative*. It does not make it *opinionated* — that is Tier 3 and it
   is gated on having users. **Worth agreeing which of the two "useful" means
   here before work starts**, because the answer changes what gets built and no
   amount of Tier 1 will produce Tier 3.

---

**Not proposed here:** any ranker work (on explicit hold), any schema migration,
and any change to the photo fallback chain, which works.
