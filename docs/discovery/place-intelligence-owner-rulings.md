# Place Intelligence — the owner's two rulings, and the tier boundary

**GOVERNING. 2026-08-15, from the owner.**

[`place-intelligence-osm-card-enumeration.md`](place-intelligence-osm-card-enumeration.md)
§5 raised exactly two questions and refused to answer them, on the grounds that
the implementer should not assume what the owner should rule. **Both are now
ruled.** This document records them so the next session does not re-litigate
either one, and so nobody has to reconstruct them from a chat transcript that
will not survive the next container restart.

---

## RULING 1 — Persisting the resolved photo is ENABLING INFRASTRUCTURE, not a new product feature

> **The product ALREADY resolves FSQ → Google → artwork. Persisting the winning
> result adds no behaviour — it removes repeated external-provider work from
> behaviour that is already approved.**

This settles enumeration question 1. The strict reading and the outcome reading
were both available; the ruling takes neither. It reclassifies the work: because
the resolution chain is already shipped and already approved, storing what it
returns is not a new capability being introduced under cover of a cache. It is
the removal of repeated work from a capability that exists.

**The distinguishing test, and it is worth stating because it is what makes this
narrow:** caching a *resolved product fact* is the objective. **Corpus-building
is not.** The same code, pointed at places no user is looking at, becomes the
thing the sequence ruling forbids.

### What is IN SCOPE

| | |
|---|---|
| Persist the **canonical resolved photo** for the place | one photo, the one that won the existing chain |
| Persist its **source metadata** | which provider resolved it, so the card's existing provenance UI has something true to say |
| **Reuse on subsequent reads** | this is the entire point — every viewer currently re-pays two external providers for a field the user sees first |
| **Refresh and invalidation, DEFINED EXPLICITLY** | see below — this is a ruling requirement, not an implementation detail to be deferred |

### Refresh and invalidation must be defined, not deferred

The ruling names this explicitly, so it is an exit criterion rather than a
follow-up. A stored photo URL that nothing can invalidate is a stale field with
no owner, and the failure mode is the workstream's own invariant in a new
costume: **a dead image URL renders as "this place has no photo", which is
indistinguishable from never having resolved one.** Absence of evidence becoming
evidence of absence, at the level of the field the user sees first.

Whatever design lands must state, in the PR that lands it: what causes a stored
photo to be re-resolved, what causes it to be discarded, and what a reader does
when the stored URL no longer works. **A design that cannot answer those three
does not ship**, because it converts a self-healing runtime lookup into a
permanently wrong stored value.

Two facts already in hand that constrain the answer:

- The Google leg returns a **`.../media?...&key=<API key>` URL**
  (`routes/places.ts`, the `/places/photo` handler). Persisting a URL with a
  credential in it, and its expiry behaviour, is a question the design must
  answer rather than inherit.
- Foursquare was returning **HTTP 429** on 2026-08-15 and Google was carrying
  every card. A cache populated during a provider outage stores the *fallback*,
  not the *best* result — so "never refresh" is not available as an answer.

### Explicit NON-GOALS — each requires a NEW ruling before anyone starts

Not "deprioritised". **Out of scope until separately ruled**, and the fact that
they are each a small increment on top of persistence is precisely why they are
listed by name:

- crawling photos
- bulk enrichment
- multiple candidates per place
- quality scoring
- cross-provider deduplication
- pre-populating cities

> Every one of these is corpus-building wearing the persistence work as a
> disguise. **Caching a resolved product fact is the objective; corpus-building
> is not.**

### Prior art the next session must not mistake for this

`87e245786` **reverted five local photo-cache commits** out of the deploy tree,
and `cd1f4e1bb` added LRU eviction and an hourly sweep to the in-process
Discovery photo/search/nearby caches. **Neither is this work.** Those are
**in-memory, per-process** caches that die with the container and are invisible
to any other reader. This ruling is about the photo becoming a **place
attribute** that survives the process. Do not treat the revert as precedent
against persistence — it was not a ruling on this question, which is why the
question was still open enough to need one.

---

## RULING 2 — "USEFUL" MEANS TIER 1 INFORMATIVE FOR THIS PHASE

This settles enumeration question 2. The enumeration observed that Tier 1 makes
a card *informative* and not *opinionated*, and asked which one "genuinely
useful" meant. **It means informative.**

### The test to hold work against

> **A place card becomes materially more useful EVEN WITH ZERO PORTAVA USERS
> CONTRIBUTING ANYTHING.**

This is a usable test rather than a slogan, and it is the reason the following
are legitimate for this phase: **outdoor seating, wheelchair access, internet
access, neighborhood, wikidata and image provenance, accuracy and confidence and
disclaimer info.** Every one improves **the factual object itself**, which is why
none of them needs a user to exist first.

It is also the test that fails everything in Tier 3, and it fails it for a
reason rather than by fiat: Tier 3 is *derived from Portava behaviour*, and with
zero users there is no behaviour to derive from.

### THE TIER BOUNDARY — recorded verbatim

> **TIER 1 is FACTUAL intelligence.**
>
> **TIER 2 is ENRICHED or DERIVED intelligence from external and accumulated
> place data.**
>
> **TIER 3 is EXPERIENTIAL or OPINIONATED intelligence derived from Portava
> behaviour — people-like-you, contextual recommendation, social proof, vibe,
> opinionated ranking.**

**Tier 3 requires behavioural data. Smuggling it into Tier 1 would manufacture
intelligence or create a premature scoring system.** Those are the two failure
modes, and they are distinct: manufacturing intelligence produces a card that
asserts something nobody observed; a premature scoring system produces a ranking
over an empty corpus, which is the thing item 4 of the live sequence already put
on explicit hold.

> ### DO NOT BUILD TIER 3 MERELY BECAUSE TIER 1 IS FINISHED.
>
> Finishing Tier 1 is not an entry criterion for Tier 3. **Having behavioural
> data is.** A future session that finds Tier 1 complete and reads that as
> permission to start Tier 3 has misread this ruling; the gate is users, and it
> does not open by completing the tier below it.

Note that the tier boundary is drawn by **provenance of the intelligence**, not
by cost or effort. The enumeration's tiers were costed — cheap / medium /
expensive — and that costing remains accurate and useful, but it is a different
axis. **When the two disagree, provenance governs**, because provenance is what
this ruling is about. A cheap way to fake social proof is still Tier 3.

---

## IMPLEMENTATION ORDER — ruled, not chosen by the implementer

1. **The nearly-free OSM mapping win.** Stop discarding the useful Overpass tags
   — **`outdoor_seating`, `wheelchair`, `internet_access`, `addr:neighbourhood`,
   `wikidata`, `image`** — and populate the fields the card already understands.
   The data is already arriving in every Overpass response and being dropped on
   the floor; the card already knows how to render it.
2. **Persist the resolved photo metadata**, per Ruling 1, refresh and
   invalidation defined.
3. **MEASURE COVERAGE.**

> **Step 3 is PART OF THE UNIT, not a follow-up.** It does not get deferred to a
> later PR and it does not get satisfied by an estimate. This workstream's
> standing rail is **"enumerate populations, do not estimate them"** — "1 of 464
> rows" is a finding, "coverage seems good" is not. A mapping change that lands
> without a measurement of how many real places actually carry the tags has
> delivered an unknown, and the unknown looks exactly like a success.

Note for whoever measures: `.agents/memory/osm-only-photo-path-untested.md`
records that the five seeded DB cities (Cebu, Manila, Bali, Bangkok, Singapore)
carry baked-in `headerImageUrl` values and **never exercise the live photo
chain**. A coverage measurement taken only over seeded cities measures the seed,
not the world. Measure over OSM-only destinations.

---

## REPUBLISH IS INDEPENDENT

> **Republish must not wait on Place Intelligence. #66 through #81 ship alone,
> and Tier 1 starts from that published baseline.**

### The one verification, and its result

The ruling attached a single condition that could couple them: **confirm that
none of #66–#81 alters the supply path Tier 1 will modify** — the Overpass tag
mapping, or the photo resolution chain. That is the only condition, so it was
checked before anything else in this session.

**Result: NEGATIVE. Nothing in #66–#81 touches either supply path. They are
independent, and republish proceeds alone.**

Verified at `807846dd1` against the pre-#66 base `0e9a72aec` (*"Tell an EMPTY api
key apart from an ABSENT one"*, #64):

| Supply path | File | Result |
|---|---|---|
| **Overpass tag mapping** | `artifacts/api-server/src/routes/discovery.ts` | **Not in the changed-file set at all.** The `:452-478` OSM→`DiscoveryPlace` mapping Tier 1 will edit is untouched across all sixteen PRs. |
| **Photo chain, client** | `src/hooks/useFsqPhoto.ts`, `src/services/fsqPhotoLookup.ts`, `src/components/discovery/PlaceCard.tsx` | Untouched. |
| **Photo chain, server** | `routes/places.ts` — `/places/photo`, `/places/fsq-photo` | **Byte-identical** from the `/api/places/photo` banner to EOF, except four log-throttle constants (`GOOGLE_AUTOCOMPLETE_KEY_LOGGED`, `GOOGLE_AUTOCOMPLETE_ERROR_LOGGED`, `GOOGLE_DETAILS_ERROR_LOGGED`, `GOOGLE_DETAILS_KEY_LOGGED`) declared in that trailing block and read only by the autocomplete/details routes. |

**Where the code changes in #66–#81 actually landed:** #75, #76 and #78 changed
`routes/places.ts` only inside `runUniversalSearch`, `/places/google-autocomplete`
and `/places/google-details`. #80 deleted legacy helpers from
`lib/googlePlacesReason.ts`, which **the photo routes never call** — they depend
only on `classifyApiKey` / `apiKeyFailureReason` / `apiKeyFailureMessage`, and
that library is unchanged across the range. #67 touched the serve-point report,
#71 the dev proxy scripts, and the rest are documentation.

**One adjacency worth stating, because it is a merge hazard and not a
behavioural one:** Ruling 1's work will edit `routes/places.ts`, the same *file*
#75/#76/#78 changed — but not the same *routes*. Rebase before starting; there
is no contract to re-verify.

---

## What this document does not do

It does not start any work, and it does not re-open anything the enumeration
closed. **Ranker work remains on explicit hold** (live sequence item 4), no
schema migration is proposed here, and the photo fallback chain's *resolution
order* is not being changed — Ruling 1 stores what that chain already returns.
