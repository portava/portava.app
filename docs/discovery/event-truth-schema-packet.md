# Event Truth — schema design packet

**Gate for step 2 of the superseding sequence. No migration may be written until
this packet answers BOTH acceptance tests explicitly.**

| | Test | Verdict on today's system |
|---|---|---|
| **1** | reconstruct a **six-month-old recommendation** (§0–§5) | **NO** — five independent grounds |
| **2** | enumerate and attribute **verified visits** on a historical trip (§6) | **NO** — four independent grounds. **Portava Discovery Contribution is not computable.** |

**Neither is close.** The design that would make both YES is below; the system
does not pass either today, and this packet exists to say that rather than to
build past it.

Evidence standard: file:line, as in `phase-minus-1-repository-proof.md`.

---

## The counterfactual

> Given a recommendation made **six months ago**, can we reconstruct
> **what the traveller saw**, **what viable alternatives existed**, **why each
> candidate was considered or removed**, **what context existed**, and **what the
> traveller eventually did**?

## The answer, on today's system: **NO.**

Not "partially", not "with effort". **No**, on five independent grounds, any one
of which is sufficient on its own.

| # | Sub-question | Today | Why |
|---|---|---|---|
| 0 | *(precondition)* six months of history | **NO** | Retention window is **90 days**. Six months is outside it **by policy**, not by accident. |
| 1 | what the traveller saw | **NO** | Authenticated serves only, and the record is **destroyed on success** — see §1. |
| 2 | what viable alternatives existed | **NO** | Nothing records a candidate that was **not** served. |
| 3 | why each candidate was considered or removed | **NO** | **No exclusion is recorded anywhere**, by any component. |
| 4 | what context existed | **PARTIAL** | Request shape yes; viewer state and config version **no**. |
| 5 | what the traveller eventually did | **NO** | Outcomes **overwrite** the impression and **overwrite each other**. |

**Stating this rather than building past it is the point of the gate.** What
follows is the design that would turn each **NO** into a **YES**, and the volume
argument that keeps it affordable.

---

## §1 — The finding that matters most: outcomes DESTROY impressions

This is not a gap. It is **active data loss**, and it is running in production
now.

`POST /api/rank-events/outcome` finds the most recent row with
`outcome = 'impression'` and **UPDATEs it in place**:

```
routes/rankEvents.ts:137    .eq("outcome", "impression")   // only upgrade from impression rows
routes/rankEvents.ts:158-160  .update({ outcome, outcome_at: … })
```

`rank_events` is therefore a **state machine, not an event log**. Three
consequences, in increasing severity:

**(a) The impression fact is erased.** After a tap, the row no longer says the
item was *served* — it says it was *tapped*. "It was shown" and "it was acted
on" are different facts about different moments, and the second overwrites the
first.

**(b) Every impression count is biased, in the worst possible direction.**
`reportDiscoveryServePoints.ts:121` filters `.eq("outcome", "impression")`. So
**the serve-point report systematically undercounts serves by exactly the ones
that converted.** The more successful a placement, the more invisible it
becomes. Any engagement rate computed this way has its numerator removed from
its denominator.

> This lands directly on the **deferred D5 empirical check**. That check reads
> serve-point shares from this exact query. It was already gated on reachability
> (Phase B) and on launch; it is **also** gated on this, and nobody knew.

**(c) The funnel between stages cannot be reconstructed.** A tap followed by a
save overwrites the tap. `impression → tap → save → attended` is the funnel the
whole ranking programme is meant to learn from, and **only the last stage
survives**. The intermediate transitions are gone, along with their timestamps.

There is a fourth, quieter one: a second impression of the same item cannot be
upgraded once an earlier row has converted, because the lookup filters on
`outcome = 'impression'` (`:137`) — so repeat exposures silently fail to attach
outcomes at all (`:152-154` returns `not_found`).

**None of this is fixable by adding columns to `rank_events`.** The table has a
client-input surface and mutable state — which is precisely why D7=A put shadow
data in its own append-only table. Event Truth needs the same treatment, and for
the same reason.

---

## §2 — What is recorded today, precisely

| Fact | Where | Class |
|---|---|---|
| an item was served, to an authenticated user | `rank_events` via `logImpression` / `logDiscoveryServe` | **until an outcome overwrites it** |
| which of the 9 serve points served it | `features.servePoint` (Stage 0) | live |
| ranking features for the item | `features` jsonb — **only on serve point 6**; `{}` elsewhere (`rankLog.ts:202`, `:425`) | partial |
| destination / category / cache level / engine mode | `features` context | live |
| the served **page** under shadow mode | `discovery_shadow_serves.legacy_ids` / `pde_ids` | append-only ✓ |
| **anything about a candidate that was not served** | — | **nothing** |
| **why a candidate was dropped** | — | **nothing** |
| **the viewer's state at the time** | — | **nothing** |
| **which weights/config produced the score** | — | **nothing** |

Two structural exclusions worth naming:

- **`rank_events.user_id` is NOT NULL** (`0153_add_rank_events.sql`). Anonymous
  traffic **cannot be recorded at all**. On a pre-launch app about to onboard,
  the majority of early browsing is invisible by construction.
- **Filtering leaves no trace.** `applyFilters` drops items by `openNow`,
  `minRating` and age; `mergeAndDedup` drops DB places whose name collides with
  an OSM place. Both are pure array operations. **A place that was filtered out
  is indistinguishable from a place that never existed.**

---

## §3 — The design

Following the constraint: **do not duplicate every viable candidate on every
request.** The recommendation request becomes a **first-class object**, and
everything else references it.

```
discovery_candidate_sets   ── the WORLD, once per (cache key, TTL window)
        ▲
        │ set_id
        │
discovery_runs             ── the MOMENT, one row per recommendation request
        ▲
        │ run_id
        ├──────────────► discovery_candidate_evals   ── the JUDGEMENT, per candidate
        │                                               (bounded — see §4)
        └──────────────► discovery_exposures         ── the DELIVERY, what was served
                                 ▲
                                 │ exposure_id
                                 └── discovery_interactions  ── the RESPONSE, append-only
```

### `discovery_candidate_sets` — the world, stored once

The retrieved pool for a `(destination, category, radius)` key within one TTL
window is **identical across every user who hits it** — that is the whole
caches-in-series finding. So it is stored **once**, not once per request.

| column | note |
|---|---|
| `id` | stable set identity |
| `cache_key`, `retrieved_at`, `ttl_expires_at` | ties the set to the Cache A window it belongs to |
| `source`, `source_query` | Overpass / DB / Compass, and the exact query issued |
| `member_ids` jsonb | the candidate ids in retrieval order |
| `member_count`, `fingerprint` | fingerprint = hash of member_ids, so an unchanged refetch reuses the row |

**This is where the volume saving lives.** One row per city-category-window
instead of one per request.

### `discovery_runs` — the moment, first-class

One row per recommendation request, whether or not anything was ranked.

| column | note |
|---|---|
| `id`, `occurred_at` | stable id, immutable |
| `user_id` **NULLABLE** | so anonymous traffic is recorded. The single most important difference from `rank_events`. |
| `session_id`, `surface`, `serve_point`, `cache_level` | |
| `candidate_set_id` | → the world it drew from |
| `engine_mode`, `mode_reason`, `cohort_reason` | provenance, as `discovery_shadow_serves` already does |
| `ranker_version`, `weights_version` | **without this a six-month-old score cannot be interpreted**, only read |
| `context` jsonb | destination, category, radius, page, page_size, sort_by, filters *as applied* |
| `viewer_context` jsonb | **snapshot** of what the ranker actually saw: interest tags, follow-count, whether coords were present. Not a pointer to today's values — the traveller's interests six months ago are not their interests now. |
| `timings` jsonb | |

### `discovery_candidate_evals` — the judgement, and the exclusions

**This is the table that answers "why was it considered or removed", and no
existing table can.**

| column | note |
|---|---|
| `run_id`, `item_id` | |
| `stage` | `retrieved` → `eligible` → `filtered` → `ranked` → `served` — **the furthest stage reached** |
| `excluded_at_stage`, `exclusion_reason` | e.g. `filter:min_rating`, `filter:age_gate`, `dedup:name_collision`, `page:below_fold` |
| `score`, `rank_position` | |
| `features` jsonb | the per-feature contributions, which `ScoredCandidate.features` already computes and currently discards for 8 of 9 serve points |
| `viable` bool | **eligible and not excluded** — i.e. it *could* have been served |

### `discovery_exposures` — what was actually delivered

`run_id`, `item_id`, `position`, `page`, `exposed_at`. One row per item the user
actually received. **Append-only. Never updated.**

### `discovery_interactions` — the response, append-only

`exposure_id`, `kind` (`view` | `tap` | `save` | `share` | `join` | `attended`),
`occurred_at`, `strength`, `attribution`.

**One row per event. Nothing is ever overwritten.** A tap and a later save are
two rows, both with timestamps. This is the direct repair of §1, and it is why
Event Truth cannot be a widening of `rank_events`.

---

## §4 — The volume argument

Storing an eval row for all ~60 candidates on every request is the outcome the
constraint exists to prevent. Three bounds keep it affordable **without losing
the counterfactual**:

1. **The world is shared.** `discovery_candidate_sets` holds the 60 ids once per
   city-category-TTL window. Runs reference it. Retrieval is not re-stored.
2. **Evals are bounded to what the counterfactual needs**, which is *not* the
   whole tail:
   - **everything served** (it is what the traveller saw);
   - **everything excluded, with its reason** (it is why the alternatives were
     not there);
   - **the top-K unserved viable candidates** — the **near-misses**.

   *"What viable alternatives existed"* is answered by the candidates that could
   plausibly have been served, not by rank 58 of 60. K is a tuning knob; the
   deep tail is recoverable from the set membership anyway.
3. **`features` is stored on served and near-miss rows only.** Full feature
   vectors for excluded candidates buy little: their exclusion reason is the
   explanation.

**Deliberately rejected:** a JSON snapshot of the candidate pool per impression.
It duplicates the shared world once per user per request, is the largest thing
in the schema, and answers no question the three tables above cannot.

---

## §5 — What this makes reconstructible, and what it still will not

**YES, after Event Truth:**

- **What the traveller saw** — `discovery_exposures`, by position, including
  anonymous sessions, and never destroyed by a later interaction.
- **What viable alternatives existed** — `discovery_candidate_evals` where
  `viable = true` and `stage < served`.
- **Why each candidate was considered or removed** — `exclusion_reason`, per
  candidate, per run.
- **What context existed** — `discovery_runs.context` + `viewer_context`
  **snapshotted at the time**, plus `ranker_version` / `weights_version` so a
  historical score can be *interpreted* rather than merely read.
- **What the traveller did** — `discovery_interactions`, append-only, every
  stage preserved with its own timestamp.

**Still NO, and these must be fixed alongside or the packet's promise is
hollow:**

1. **Retention.** The window in force is **90 days**
   (`docs/ops/retention-policy.md`). A six-month counterfactual **fails on
   policy before it fails on schema.** Event Truth needs its own retention
   ruling, and that is an **owner decision**, not an engineering one. *Flagged,
   not assumed.*
2. **The past is unrecoverable.** No schema reconstructs what was never written.
   Everything before Event Truth ships stays unreconstructable — which, with 0
   places and no organic traffic, costs almost nothing **today** and rises every
   day the app is live. That is an argument for sequencing it early, and it is
   the strongest one in this packet.
3. **`rank_events` keeps destroying impressions until it is retired or fixed**,
   and its bias flows into the D5 deferred check (§1b). Event Truth existing
   alongside it does not stop that.

---

## §6 — `verified_visit` — required for v1; the packet does not pass without it

### The second hard acceptance test

> Given a **historical trip**, can the system **deterministically** enumerate
> verified visits, identify which were **Portava-sourced**, and reconstruct the
> **recommendation opportunity** responsible for each attributed visit —
> **without inferring missing evidence**?

### The answer, on today's system: **NO.** Portava Discovery Contribution is **not computable.**

Four independent failures. As with the first test, stating this is the point.

| Requirement | Today | Evidence |
|---|---|---|
| enumerate verified visits **for a place** | **NO** | No place-level visit record exists. `hidden_gem_visits` covers **hidden gems only** (`0043_hidden_gems.sql:155-165`) — not OSM places, not `db/` places, which is what Discovery serves. |
| **deterministically** | **NO** | The closest thing, `trust_level`, is a **mutable column on the observation row** (`:160`, default `'manual'`). Re-deriving under a new standard **overwrites history**, so the same trip yields different answers at different times. |
| identify **Portava-sourced** | **NO** | **Nothing links any visit, stamp or check-in to a recommendation.** Not a column, not a table, anywhere. |
| reconstruct the **opportunity** | **NO** | Requires runs and candidate evaluations — §1–§5 of this packet, none of which exist yet. |

### The four things that must not be collapsed, against what exists

| # | Concept | Today | Note |
|---|---|---|---|
| 1 | **CLAIMED visit** | `hidden_gem_visits` with `trust_level = 'manual'` — the schema default | exists, **gems only** |
| 2 | **EVIDENCE-SUPPORTED PRESENCE** | `distance_m`, `latitude`, `longitude`, `visited_at` on the *same row* | exists, **gems only**, and **not separable from the conclusion** |
| 3 | **STAMP** | `passport_stamps_gps`, unique on `(user_id, stamp_type, country, city)` (`0025_location_system.sql:22-32`) | exists — and is **city/country granularity**, so **a stamp is not a place visit and cannot be made into one** |
| 4 | **VERIFIED VISIT** | — | **does not exist** |

`HiddenGemVerificationService.ts:83` is the nearest approach:
`const trustLevel = isSuspicious ? "pending_review" : "gps_verified"` — proximity
in, conclusion out. It is real evidence-based verification, and it is **(a)**
gems-only, **(b)** written into a mutable column, **(c)** unversioned.

**Collapsing these four destroys the metric.** A claimed visit counted as
verified inflates contribution; a stamp counted as a place visit attributes
city-level presence to whichever place happened to be recommended; and a
verified visit with no attribution basis is contribution invented from
proximity.

### DESIGN PROTECTION — `verified_visit` is NOT another UI action

**It is a CONCLUSION SUPPORTED BY EVIDENCE.** The evidence may be proximity,
dwell duration, stamp behaviour, trip membership, explicit confirmation, or
combinations of them. A button that sets `verified = true` is a **claim**, and
belongs in layer 1.

The structural consequence, and it is the subtlest requirement in this packet:

```
visit_observations   IMMUTABLE RAW FACTS — written once, never updated, never re-derived
        │            proximity_ping · dwell_sample · stamp_award · trip_membership
        │            · explicit_confirmation · checkin
        ▼
visit_verifications  VERSIONED DERIVATIONS over those observations
                     (standard_version, derived_at, confidence, evidence_refs[])
```

**When the verification standard changes, historical evidence is not rewritten.**
A new standard writes **new verification rows**; the old rows stay, and every
old conclusion remains reproducible **under the standard that produced it**.
That is the difference between *"this visit is verified"* — which silently means
*"under whatever rule we use today"* — and *"this visit was verified under
standard v3, from these five observations."*

Today's `trust_level` column is the first form. It cannot answer "was this
verified under the standard in force at the time", because the standard is not
recorded and the conclusion overwrites its predecessor.

### Attribution: `visit_attributions`

Links a **verification** to a `discovery_exposures.id`, and through it to the
run, the candidate set, and the candidate's evaluation — the full backward
trace: **recommendation → serve → ranking run → candidate opportunity.**

| column | note |
|---|---|
| `verification_id` | which conclusion is being attributed |
| `exposure_id` **NULLABLE** | → the served recommendation. **Nullable is load-bearing** |
| `basis` | `direct_tap` · `same_session_exposure` · `prior_exposure_window` · `none` |
| `confidence`, `window` | how far the link reaches, stated rather than assumed |

**`NULL` and `basis = 'none'` are correct, expected answers.** A traveller who
found a bar by walking past it produced a real verified visit that Portava did
not source, and the system must be able to **say so** rather than reach for the
nearest exposure. **"Without inferring missing evidence" means an unattributable
visit stays unattributed** — Portava Discovery Contribution is a floor computed
from what is recorded, never an estimate topped up by proximity in time.

### What makes it deterministic

Enumeration runs over `visit_verifications` **at a named `standard_version`**,
joined to attributions. Same trip + same standard version = **same answer,
forever** — because no input is mutable and no conclusion is recomputed in
place. That is the property today's schema cannot offer at any level of care.

---

## §7 — Recommendation

**The counterfactual is answerable in principle and unanswerable today.** Build
Event Truth, in the first-class-object shape above, with these conditions:

| | |
|---|---|
| **Append-only by construction** | Same three mechanisms as `discovery_shadow_serves` — grants, RLS, triggers — and the same `audit:shadow-append-only`-style **exact privilege assertion**, because `2092` proved a migration comment is not a constraint |
| **`user_id` NULLABLE** | Anonymous traffic must be recordable. This is the single most important departure from `rank_events` |
| **Retention ruling** | **Owner gate.** 90 days cannot answer a six-month question |
| **Behaviour-preserving at introduction** | Writes land inert behind a flag, as Stage 0 did |
| **Observations immutable, verification versioned** | §6. A conclusion stored on the observation row cannot survive a change of standard |
| **Attribution may be NULL** | An unattributable visit stays unattributed. Contribution is a floor, never an estimate |
| **No production write by the agent** | Staged with before/after verification |

**Retention is ESCALATED TO THE OWNER**, not resolved here. The six-month
counterfactual fails on the **90-day policy**, and whether discovery evidence
gets a longer window is an owner decision rather than a schema question.

**Still deferred:** what makes an event *strong* is a taste-model question that
step 5 defines; specifying it now would be guessing at a contract that does not
exist. `verified_visit` is **no longer** in this category — it is required for
v1, and §6 is its design.

**Both acceptance tests currently answer NO.** The packet passes as a *design*;
the *system* does not pass either test, and neither should be reported as
close.

**Nothing in this packet has been implemented. No migration has been written.**
