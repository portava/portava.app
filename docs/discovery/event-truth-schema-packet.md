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
| 0 | *(precondition)* six months of history | **NO** | Retention window is **90 days**. Six months is outside it **by policy**, not by accident. **→ policy gap now closed: RULED 2026-08-15 (§7), decision evidence 12 months. The verdict stays NO because nothing implements it.** |
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
`reportDiscoveryServePoints.ts:121` filtered `.eq("outcome", "impression")`. So
**the serve-point report systematically undercounted serves by exactly the ones
that converted.** The more successful a placement, the more invisible it
became. Any engagement rate computed that way had its numerator removed from
its denominator.

> This lands directly on the **deferred D5 empirical check**. That check reads
> serve-point shares from this exact query. It was already gated on reachability
> (Phase B) and on launch; it is **also** gated on this, and nobody knew.

> #### ✅ (b) IS FIXED — PR #387, 2026-09-04. (a) AND (c) ARE NOT.
>
> The report no longer reads the corpus through `outcome` at all. It selects by
> **`event_type IS NULL`** — the documented ranked/impression corpus
> (`lib/rankLog.ts`, migration `0197`) — in `fetchDiscoveryServeRows`
> (`lib/discoveryServePointReport.ts:574#fetchDiscoveryServeRows`, predicate at `:589#event_type`), which keeps
> every serve whatever rung its outcome later reached and excludes the
> analytics-sentinel rows the outcome route inserts (`event_type` set,
> `outcome='analytics'`). A regression test proves a converted serve survives
> alongside an impressed one and that restoring the `outcome` filter turns red.
>
> **The bias was worse than "some serves are missing": it was differential.** The
> serve points that rank convert best, so the ranked share — the exact quantity
> the D5 check reads — was pushed down by precisely the serves that reached a
> ranker. **Any serve-point reading taken before `4cc19af82` is a floor, not a
> measurement**, and is not comparable with one taken after.
>
> **This changes nothing about §1's finding.** (a) the impression fact is still
> erased by the in-place UPDATE, and (c) the funnel between stages is still
> unreconstructable. What #387 fixed is an *instrument* that had been reading the
> mutable column; the mutability itself is untouched and is still what Event
> Truth exists to answer.

> #### The fourth, quieter loss is narrower than it was — PR #365, 2026-09-04
>
> The paragraph below says a repeat exposure "silently fails to attach outcomes"
> because the finder filtered on `outcome = 'impression'`. It no longer does: an
> outcome now upgrades any row on a strictly **lower funnel rung**
> (`routes/rankEvents.ts:111` `upgradableOutcomesFor`, applied at `:171`), so a
> tap→save chain lands as `save` instead of 404ing after the tap consumed the
> row. **The overwrite is still in place** — the tap is still destroyed by the
> save — so this narrows the loss and does not remove it.

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
| which of the **10** serve points served it | `features.servePoint` (Stage 0). *Corrected 2026-09-05: it was 9 when this was written; `COMMUNITY` (10) was added to `DiscoveryServePoint` afterwards* | live |
| ranking features for the item | `features` jsonb — **only where `logImpression` is handed scored candidates**: serve point 6 today, and cache-A serve points 1–3 under mode `pde`, which is off (`routes/discovery.ts:1705`, `:2021`). `{}` on every other serve point | partial |
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
| `viewer_context` jsonb | **snapshot** of what the ranker actually saw: interest tags, follow-count, whether coords were present. Not a pointer to today's values — the traveller's interests six months ago are not their interests now. **Split by sensitivity per §7**: precise coordinates are a **≤90-day** class and are redacted in place; the derived flags they produced are a **12-month** class and survive. |
| `context_redacted_at`, `redaction_policy_version` | §7. So that *redacted*, *never captured* and *present* stay three distinguishable states. |
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
| `features` jsonb | the per-feature contributions, which `ScoredCandidate.features` already computes and currently discards for 9 of the 10 serve points |
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
  historical score can be *interpreted* rather than merely read. **After 90 days
  this is the derived context, not the raw** (§7): the eligibility judgement
  survives, the precise coordinates do not, and the difference is recorded rather
  than silent.
- **What the traveller did** — `discovery_interactions`, append-only, every
  stage preserved with its own timestamp.

**Still NO, and these must be fixed alongside or the packet's promise is
hollow:**

1. **Retention.** The window in force is **90 days**
   (`docs/ops/retention-policy.md`). A six-month counterfactual **fails on
   policy before it fails on schema.** → **RULED by the owner 2026-08-15; see
   §7.** The ruling is *not* a longer global window: decision evidence gets
   **12 months**, raw sensitive context gets **90 days or less**, and the durable
   record keeps **the judgement rather than the sensitive input that produced
   it**. It also **redefines what reproducibility means** once evidence expires.
   Still listed here because **nothing implements it** — the policy gap is
   closed, the schema gap is not.
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
                     (standard_version, derived_at, confidence, evidence_refs[],
                      evidence_class_counts)
```

**`evidence_class_counts` is required by the retention ruling (§7), not optional.**
Raw observations expire on a **shorter** schedule than the verifications derived
from them, so `evidence_refs[]` will dangle by design. The class counts are
denormalised **at derivation time** so the conclusion stays readable — *which
policy evaluated which evidence classes, and what it concluded* — after the
evidence itself is gone.

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

**And it survives retention** (§7): the answer is **read from the recorded
conclusion**, never recomputed from observations that may legitimately have
expired. Determinism here does not depend on the evidence still existing — which
is precisely why the conclusion had to be a versioned row rather than a mutable
column in the first place.

---

## §7 — Retention — **RULED by the owner, 2026-08-15**

This packet escalated retention rather than resolving it (§5.1). **The ruling has
been given, and it is folded in here.** It is **not a single TTL**, and reading it
as one would produce exactly the schema it forbids.

### The six-month acceptance test STAYS — and six months is not arbitrary

> Travel feedback is **delayed and episodic**, and the strongest downstream
> evidence often arrives **long after** the recommendation. A 90-day window would
> make the system **deliberately forget evidence before it has enough
> longitudinal behaviour to evaluate itself.**

So the counterfactual in §0 is unchanged and stays the bar.

**But this is NOT retain-everything-for-six-months.** The ruling splits the data
by what is *actually required*, and the split is the substance of it:

| Tier | Window |
|---|---|
| **DISCOVERY DECISION EVIDENCE** | **12 months** |
| **RAW SENSITIVE CONTEXT** | **shortest practical lifetime — preferably 90 days or less** |
| **DERIVED NON-SENSITIVE EVIDENCE** | **12 months, or longer where justified** |

### The governing principle

> ### PRESERVE THE DECISION EVIDENCE, NOT EVERY SENSITIVE INPUT THAT PRODUCED IT.

The owner's worked example, because it settles the schema question exactly:

> The durable record can say candidate X had `within_range = true`, `open = true`,
> `weather_appropriate = true`, `previously_visited = false`, and **survived
> eligibility under `candidate_policy_v3`**. It does **not** need the traveller's
> exact latitude and longitude forever.

The booleans **are** the decision evidence. The coordinates are a **sensitive
input** that produced them, and they are discardable the moment the evaluation is
recorded. `discovery_candidate_evals` (§3) already stores per-candidate judgement
and exclusion reasons; this ruling says that table — not the raw context — is what
survives.

**Standing prohibition, stated because it is the failure mode this most likely
degrades into:**

> **Precise location is NEVER retained merely because ranking analytics would
> benefit.** Analytic convenience is not a purpose. If a signal is wanted for
> ranking, it is derived, stored derived, and the raw input still expires on the
> raw-input schedule.

### The per-class retention table

**This is the required encoding — a per-class table, not one global TTL.** The
final column is the one that carries the ruling: it names the records that
legitimately **outlive their own inputs.**

| Data class | Purpose | Sensitivity | Retention | At expiry | Downstream that survives it |
|---|---|---|---|---|---|
| `discovery_runs.viewer_context` — **precise coords** | eligibility + distance scoring at request time | **HIGH** — precise personal location | **≤ 90 days** | **redact in place**: coordinate fields nulled, `context_redacted_at` + `redaction_policy_version` stamped. Row survives. | `discovery_candidate_evals` (the booleans it produced), `discovery_exposures` |
| `discovery_runs.viewer_context` — **derived flags** (interest tags present, follow-count bucket, coords_present) | interpret a historical score | LOW — derived, non-identifying | **12 months** | retained | — |
| `discovery_runs` — ids, `serve_point`, `cache_level`, `engine_mode`, `ranker_version`, `weights_version`, `context` | reconstruct **the moment** | LOW | **12 months** | retained | — |
| `discovery_runs.user_id` / `session_id` | enumerate a **historical trip** (§6 test) | MEDIUM — pseudonymous | **12 months** | retained; **not** extended past 12 without a fresh ruling | aggregate counts only |
| `discovery_candidate_sets` | the world that was available | LOW — place ids, not personal | **12 months or longer** | retained | — |
| `discovery_candidate_evals` — stage, `exclusion_reason`, `viable`, `score`, `rank_position`, policy version | **why a candidate was considered or removed** | LOW — **derived decision evidence** | **12 months** | retained | — |
| `discovery_exposures` | what the traveller saw | LOW | **12 months** | retained | `visit_attributions` |
| `discovery_interactions` | what the traveller did | MEDIUM | **12 months** | retained | `visit_attributions` |
| `visit_observations` — **raw GPS ping / dwell sample** | evidence for a verification | **HIGH** — precise personal location + time | **≤ 90 days** | **hard delete of the row** | **`visit_verifications`** — see below |
| `visit_observations` — `stamp_award`, `trip_membership`, `explicit_confirmation` | evidence for a verification | LOW–MEDIUM | **12 months** | retained | `visit_verifications` |
| `visit_verifications` — conclusion, `standard_version`, `derived_at`, `confidence`, **minimum provenance** | the durable verified-visit record | LOW — derived | **12 months or longer** | retained | `visit_attributions` |
| `visit_attributions` — `verification_id`, `exposure_id`, `basis`, `confidence`, `window` | Portava Discovery Contribution | LOW — derived | **12 months or longer** | retained | — |

### `visit_observations` must NOT inherit the lifetime of `visit_verification`

Stated explicitly because it is the exact inversion the naive design produces —
an observation kept alive because something derived from it is still needed:

> **A raw GPS observation must not inherit the lifetime of the resulting
> `visit_verification`.** The observation **expires**; the **versioned
> verification survives**, carrying the **minimum provenance** needed to establish
> **which policy evaluated which evidence classes, and what it concluded.**

**Minimum provenance** is therefore a defined set, and it is deliberately not
"the evidence":

| Kept | Not kept |
|---|---|
| `standard_version` — which policy evaluated it | the observation values |
| `evidence_class_counts` — e.g. `{proximity_ping: 4, dwell_sample: 1}` | coordinates, timestamps of each ping |
| `derived_at` — the date of evaluation | |
| conclusion + `confidence` | |
| `evidence_refs[]` — retained, and allowed to dangle **only** because the counts above are denormalised at derivation time | |

**Consequence for the design in §6, and it is a change:** `evidence_refs[]` alone
is **insufficient**. Once observations expire, refs point at nothing, and a
verification whose provenance is only refs becomes unreadable exactly when it is
most needed. **`evidence_class_counts` must be written at derivation time**, not
joined at read time.

### Expiry must be a RECORDED STATE, never an absence

This is where the governing invariant lands on retention, and it is not
decoration:

> **ABSENCE OF EVIDENCE MUST NEVER SILENTLY BECOME EVIDENCE OF ABSENCE.**

A coordinate field that expires to `NULL` is **indistinguishable from one that
was never captured**. An `evidence_refs[]` that dangles is indistinguishable from
a verification derived from nothing. Both are the same defect the invariant names:
**success is indistinguishable from not having worked.**

So, required:

- **`context_redacted_at` + `redaction_policy_version`** on any row whose fields
  are redacted in place. Redacted, never-captured and still-present are **three
  distinguishable states**, and every reader must be able to tell them apart.
- A dangling `evidence_ref` resolves to **`expired`**, never to `not_found`.
- Any report or query over an expired window must **refuse a verdict** rather than
  return a confident zero — the same rule already in force for empty windows.

**And the interaction that must not be missed:** `visit_attributions.exposure_id`
is `NULL`-load-bearing (§6). **Expiry must never manufacture that `NULL`.**
Attribution rows are derived, non-sensitive, and retained for 12 months or
longer precisely so that a `NULL` there keeps its single meaning. Two different
`NULL`s in one column would destroy the rule below.

### What reproducibility MEANS after source evidence expires

**This changes the definition, and it is the subtlest requirement in the ruling:**

> After source evidence legitimately expires, reproducibility means
> **REPRODUCING THE HISTORICAL DECISION, not rerunning the original
> computation.**

| Portava MUST be able to say | Portava MUST NOT claim |
|---|---|
| *"Verification policy **v2** evaluated evidence classes **A and B** on **date X** and produced **verified = true** at confidence **Y**."* | that it can **independently recompute** that conclusion once the sensitive evidence is gone |

The system must therefore be able to answer **"is this recomputable?"** — and
answer **no** when it is not:

- a derived `recomputable` property over `visit_verifications`, false once any
  referenced evidence class is past its window;
- **re-derivation refuses** on a verification whose inputs have expired. It does
  **not** recompute from the surviving subset and present the result as the same
  conclusion. Recomputing from partial evidence is the retention-shaped form of
  *a failure that returns a verdict*, which the roadmap already ranks as worse
  than one that refuses.

§6's determinism claim is unchanged and is now **more precisely true**: the same
trip at the same `standard_version` yields the same answer forever, because the
answer is **read from the recorded conclusion**, not recomputed from inputs that
may no longer exist.

### The nullable attribution rule — **preserved exactly**

Carried through this ruling **unchanged**, and reproduced here verbatim from §6
because the owner called it an unusually important modelling decision:

> **`NULL` and `basis = 'none'` are correct, expected answers.** A traveller who
> found a bar by walking past it produced a real verified visit that Portava did
> not source, and the system must be able to **say so** rather than reach for the
> nearest exposure. **"Without inferring missing evidence" means an unattributable
> visit stays unattributed** — Portava Discovery Contribution is a floor computed
> from what is recorded, never an estimate topped up by proximity in time.

**`NULL` does not mean *attribution unavailable, guess later*. It means NO
PORTAVA ATTRIBUTION HAS BEEN ESTABLISHED.** Contribution stays **conservative by
construction** — and retention does not weaken it, because attribution rows
outlive the sensitive inputs that would otherwise be reached for.

### What this ruling does NOT resolve

- **`docs/ops/retention-policy.md` still says 90 days**, and it governs
  `discovery_shadow_serves`. This ruling covers **Event Truth's classes**. The ops
  document must be amended when Event Truth is implemented, not before — writing a
  window for tables that do not exist is decoration.
- **No deletion or redaction job exists.** Consistent with the existing policy,
  expiry is a **scheduled decision taken by a person**, and there is deliberately
  no code path here that makes it automatic.

---

## §8 — Recommendation

**The counterfactual is answerable in principle and unanswerable today.** Build
Event Truth, in the first-class-object shape above, with these conditions:

| | |
|---|---|
| **Append-only by construction** | Same three mechanisms as `discovery_shadow_serves` — grants, RLS, triggers — and the same `audit:shadow-append-only`-style **exact privilege assertion**, because `2092` proved a migration comment is not a constraint |
| **`user_id` NULLABLE** | Anonymous traffic must be recordable. This is the single most important departure from `rank_events` |
| **Retention, per class** | **RULED — §7.** Not one TTL: decision evidence **12 months**, raw sensitive context **≤ 90 days**, derived non-sensitive **12 months+**. Sensitive inputs expire; the judgement they produced survives |
| **Expiry is a recorded state** | §7. Redacted, never-captured and present are three distinguishable states. A field that expires to a bare `NULL` violates the governing invariant |
| **Reproduce the DECISION, not the computation** | §7. Once inputs expire the system states what was concluded under which policy — and **refuses** to recompute rather than recomputing from a surviving subset |
| **Behaviour-preserving at introduction** | Writes land inert behind a flag, as Stage 0 did |
| **Observations immutable, verification versioned** | §6. A conclusion stored on the observation row cannot survive a change of standard |
| **Attribution may be NULL** | An unattributable visit stays unattributed. Contribution is a floor, never an estimate |
| **No production write by the agent** | Staged with before/after verification |

**Retention is RULED** — §7, folded in 2026-08-15. It was escalated by an earlier
revision of this packet; it is no longer open. The ruling did **not** simply
lengthen the window, and a reader who remembers only *"six months"* has the wrong
half of it: the six-month counterfactual **stays**, and it is satisfied by
retaining **decision evidence**, not by retaining every sensitive input for six
months.

**Still deferred:** what makes an event *strong* is a taste-model question that
step 5 defines; specifying it now would be guessing at a contract that does not
exist. `verified_visit` is **no longer** in this category — it is required for
v1, and §6 is its design.

**Both acceptance tests currently answer NO.** The packet passes as a *design*;
the *system* does not pass either test, and neither should be reported as
close.

**Nothing in this packet has been implemented. No migration has been written.**
