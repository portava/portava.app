# Portava Trips v4 — Requirement Census

| Field | Value |
| --- | --- |
| **Spec** | `docs/specs/Portava_Trips_Development_Architecture_Spec_v4.txt` |
| **`.docx` reconciliation** | Extracted `word/document.xml`, stripped tags, whitespace-normalised, diffed against the `.txt`. **The only differences are two XML entity escapes** (`&lt;` in §7.2's invariant, `&gt;` in §8.4's crew-transport row). The `.txt` is a faithful transcription; the "`.docx` is authority" clause never had to be exercised. |
| **Section count** | The brief said 25 sections. **25 top-level sections is correct** — and it is a serious undercount of the spec, which carries **80 numbered subsections** plus **Appendix A and Appendix B**: 107 numbered units. §4 alone (four subsections) is 28 requirements; §5 (three) is 26. A census scoped to "25 sections" would miss most of the document. |
| **Tree censused** | `claude/portava-continuation-uqta94`, HEAD `68ed59d9`. Backend paths relative to `artifacts/api-server/src/`, client paths to `travel-buddy-standalone/`, root migrations to `migrations/`. |
| **Database** | Not queried. Production storage facts come from the supplied ground truth and the committed snapshot `artifacts/api-server/baseline/20260907_production_tables.txt`. |
| **Method** | Requirement-level, four buckets, one bucket per requirement. Every BUILT verdict cites a `file:line` that was opened and read. |

---

## Headline

| Measure | Value |
| --- | --- |
| **Denominator (testable requirements)** | **453** |
| BUILT-AND-CORRECT | **PLACEHOLDER_C** |
| BUILT-BUT-WRONG | **PLACEHOLDER_W** |
| NOT-BUILT | **PLACEHOLDER_N** |
| CANNOT-VERIFY | **PLACEHOLDER_Q** |
| **CONSTRUCTED%** = (C+W)/453 | **PLACEHOLDER_CONS** |
| **CORRECT%** (raw) = C/453 | **PLACEHOLDER_CORR** |
| **CORRECT% (spec-attributable)** | **0 / 453 = 0.0 %** |
| CANNOT-VERIFY share | **PLACEHOLDER_QP** |

Read the third-from-last row first. **Not one artifact in this tree was built for this
specification, and I could not find one that has ever heard of it.**

```
grep -rliE "trips (development )?architecture spec|trip kernel|TripTodayProjection|Temporal Freedom" \
  --include=*.ts --include=*.tsx --include=*.sql --include=*.md . \
  --exclude-dir=node_modules --exclude-dir=docs/specs
→ docs/architecture/census-sensing.md   (a sibling census quoting a *different* spec)
```

```
grep -rli "trip_command\|TripCommand\|trip_events\|TripKernel\|aggregate_version\|expectedTripVersion\|sourceTripVersion" \
  artifacts/api-server/src travel-buddy-standalone/src migrations
→ (no matches)
```

The second grep is the whole story in one line. §4 is the Trip Kernel — commands, an event
envelope, an outbox. §19 requires every projection to carry `sourceTripVersion`. §22.4 makes
"projection `sourceTripVersion` may never exceed canonical aggregate version" a property
invariant. **The string `aggregate_version` does not occur anywhere in this repository.**
There is no version column on `trips`, no command type, no domain event, no outbox, no
snapshot, no replay.

**The trap this census had to avoid.** Production carries 26 `trip_*` and `route_*` tables
and they are all deployed. That looks like completeness and is not: **not one of the
seventeen tables §5.1 specifies exists.** Not `trip_stages`, `trip_legs`,
`trip_participants`, `trip_commitments`, `trip_plans`, `trip_plan_participants`,
`trip_goals`, `trip_decision_tasks`, `trip_risks`, `trip_presence`, `trip_proposals`,
`trip_events`, `trip_snapshots`, `trip_outcomes`. What is deployed is a different, older,
CRUD-shaped schema — `trips`, `trip_members`, `trip_plan_items`, `trip_destinations`,
`trip_notes`, `trip_checklists`, `trip_documents`, `trip_reservations` and so on — that
predates this document and answers a smaller question.

So the honest summary is: **Trips is a large, working, well-tested itinerary-and-crew
product, and this specification asks for a journey kernel that has not been started.** The
number below is not low because the code is bad. It is low because the code is a different
system.

---
