# Seed vs live place shape — one fixed, three filed

**2026-08-15. Step 4 of the measurement-system rulings, ruled AHEAD of Tier 2.**

> **`seed-discovery-places.ts` and the live route must represent the same place
> shape, because otherwise QA produces both false regressions and false
> confidence.**

Two code paths turn the same OSM element into a place. When they disagree about
what a field means, **the same real place looks different depending on which
path produced it** — so a genuine defect and a mere path difference become
indistinguishable. That fails in both directions at once: a change looks broken
because QA compared across paths, or a change looks fine because QA happened to
check the path it did not affect.

**Four divergences were found. One is fixed here. Three are filed rather than
silently unified, because each would change what the live feed returns** — a
product change, not a consistency fix, and not something to slip in under a
consistency ruling.

---

## FIXED — `neighborhood`

**Neither chain was a superset of the other**, which is why this produced
disagreement in both directions rather than one path simply being poorer:

| tag | live route (before) | seeder (before) |
|---|---|---|
| `addr:neighbourhood` | ✅ | ❌ |
| `neighbourhood` | ✅ | ✅ |
| `addr:suburb` | ✅ | ✅ |
| `suburb` | ❌ | ✅ |

A place tagged only `addr:neighbourhood` had a neighbourhood live and none when
seeded. A place tagged only `suburb` had the reverse.

**Fix:** one exported function, `osmNeighborhood()` in `src/lib/osmPlaceShape.ts`,
called by both. Sharing the function rather than documenting the convention is
the point — **a convention can drift again; a single function cannot, because
there is only one of it.**

**The live route's existing precedence is kept unchanged**, deliberately against
a tidier alternative. Grouping the two `addr:*` keys ahead of the two bare keys
would arguably be more principled — a venue's own address components before
areas it merely sits in — but it would flip the answer for any place carrying
`neighbourhood` and `addr:suburb` together. **The ruling asks for one shape, not
a better one.** The seeder moved onto the live order; the feed is untouched.

A guard test pins that neither file carries a local key chain any more.

---

## FILED — three divergences that need a decision, not a refactor

Each of these is a real difference in what the two paths produce from identical
OSM input. **Unifying any of them changes the live Discovery feed's content**,
so they are recorded here for a ruling.

### 1. `name` — the seeder prefers the English name; live does not

| | |
|---|---|
| seeder | `tags["name:en"] ?? tags.name ?? tags.official_name` |
| live | `tags.name` only — and rows without it are **filtered out entirely** |

**This is the one with a real product consequence, and it is not symmetrical.**
A place tagged only `name:en` or only `official_name` is **seeded but never
served live** — the live path drops it before it can become a place at all. So
the live feed silently excludes a class of place the seeder considers valid.

For an English-language product, the seeder's chain looks better. But adopting
it means **the live feed starts returning places it currently omits**, which is
a change in what users see and should be ruled rather than assumed.

*Unmeasured:* how many places carry `name:en` or `official_name` without
`name`. The coverage instrument could answer this — it is a one-field addition
to `reportOsmTagCoverage.ts`, and the answer determines whether this matters at
all or is a rounding error.

### 2. `description` / `blurb` — different second fallback

| | |
|---|---|
| seeder | `tags.description ?? tags.inscription` |
| live | `tags.description ?? tags.note` |

`inscription` is the text carved on a monument; `note` is a mapper's remark to
other mappers. **Neither is obviously right, and they are not interchangeable:**
`inscription` is genuine user-facing content for a memorial, while `note` is
frequently internal chatter that no user should ever see.

The suspicion worth stating: **`note` may be the wrong fallback in the live path
entirely** — it risks surfacing mapper commentary as a place description. That
is a defect hypothesis, not a finding; it needs a sample of real `note` values
before anyone acts on it. Coverage measured `description` at 3.4% overall, so
the population is small either way.

### 3. `rating` — different source and different clamping

| | |
|---|---|
| seeder | `tags.stars`, clamped to 1–5 |
| live | `tags.stars ?? tags.rating`, rounded to 1 decimal, **unclamped** |

The live path accepts `tags.rating`, a free-form tag with no agreed scale, and
applies no bounds — so **a value outside 1–5 reaches the card**. The seeder
clamps and ignores `rating` entirely.

Note the enumeration's standing caveat: **`stars` is hotel classification, not
opinion.** Whatever is decided, this field is not a user rating and the two
paths currently disagree about even that much.

---

## What this does not do

Nothing here starts Tier 2, and nothing here changes the live feed. The three
filed items are **findings awaiting a ruling**, in the same spirit as the Paris
normalisation gap: recorded so the decision is explicit, rather than folded into
a consistency change where nobody would see it.
