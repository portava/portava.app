# Two standing test destinations, and why one of them is the bad one

**2026-08-15. Step 5 of the measurement-system rulings.**

> **Change the default test city away from Cebu — but KEEP Cebu as an explicit
> low-coverage fixture. Do not solve Cebu by hiding it.**

---

## The problem this fixes

Cebu was the de facto default for manual Discovery checks. The complete coverage
matrix shows why that was actively misleading: **Cebu is the flattest
destination measured.**

| Cebu | |
|---|---|
| neighborhood | 0.9% |
| outdoor seating | 1.8% |
| wheelchair | 1.8% |
| internet access | 3.6% |
| wikidata | **0.0%** |
| image | **0.0%** |
| `activities` cell | **3 named places** |
| `places` cell | **2 named places** |

**Tier 1 shipped six new fields, and a check in Cebu would have shown almost
nothing** — reading as "the change did nothing" when the change was working
exactly as designed everywhere else.

Cebu is also one of the five seeded cities, which compounds it: seeded rows
carry baked-in `image_url` values, so `useFsqPhoto` returns early and **the live
photo chain never runs at all**. A photo check there is a false positive by
construction (`.agents/memory/osm-only-photo-path-untested.md`).

**But deleting Cebu from the fixture set would be solving the wrong problem.**
Its flatness is not a defect in Cebu, it is the condition most of the world is
in — and it is the only case that can answer one of the two questions worth
asking.

## The two fixtures

They are a **pair**. Each answers a question the other cannot.

### `high-coverage` → **Berlin**

**Question: does enrichment work when the source has data?**

Berlin is **the only measured city where all six Tier 1 fields are non-zero**,
which is precisely what makes it usable as a positive control:

| Berlin | |
|---|---|
| neighborhood | **32.4%** — the only city above 1% |
| outdoor seating | 32.2% |
| wheelchair | **47.0%** |
| internet access | 7.4% |
| wikidata | **21.5%** |
| image | **6.7%** |

**A field that renders nothing in Berlin is broken.** There is no "the data
isn't there" explanation available, which is exactly what a positive control is
for.

*Not Paris,* despite Paris being the app's own default destination and strong on
attributes: Paris returns **0.0% neighborhood**, so it cannot exercise that
field at all. Paris remains a perfectly good product default; it is not a
positive control.

### `low-coverage` → **Cebu**, kept deliberately

**Question: does the product degrade gracefully when the source has nothing?**

This is not a lesser question. **Most of the world looks like Cebu, not like
Berlin** — the matrix puts five of seven measured cities near zero on
neighbourhood and four of seven near zero on outdoor seating.

What Cebu is for:

- empty states that read as *"we don't have this"* rather than as a broken card
- **absence never rendering as a negative claim** — an untagged place must never
  say "no outdoor seating"
- the chip row collapsing cleanly to nothing rather than leaving a gap
- graceful behaviour when `activities` returns **3 places** and `places` returns
  **2**

## How to use them

**Check both, every time, for anything touching place enrichment or card
rendering.** One alone is a false signal in a predictable direction:

| Checked only in… | Failure mode |
|---|---|
| **Berlin** | everything looks rich; you never see what the majority of destinations render, and empty-state defects ship |
| **Cebu** | everything looks empty; a working feature reads as a no-op, and a genuinely broken one is indistinguishable from sparse data |

**For photo behaviour specifically, neither is sufficient** — both Cebu and
Bangkok are seeded and short-circuit the live chain. Use a **non-seeded**
destination (Paris, Berlin) and check `sourceSummary.seededDbCount` on the
`/api/discovery` response.

## Where this is encoded

In `src/scripts/reportOsmTagCoverage.ts`, as a `fixture` field on the exported
`DESTINATIONS` list, with the two fixtures listed first. A test asserts both
roles are present and that **Cebu specifically is still the low-coverage one**
— so the fixture cannot be quietly dropped the next time it makes a report look
bad. **That is the failure this ruling exists to prevent**, and prose alone
would not have prevented it.
